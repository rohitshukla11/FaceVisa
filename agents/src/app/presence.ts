/**
 * Proof of Presence (B6): before a creator lists, World ID's Selfie Check through IDKit 4, for a one-time action:
 * `list-likeness` for the final demo only (each person can complete an action once, so testing must never use it),
 * `list-likeness-dev` in development (the default), `presence-test` for a first enrolment from a test session. It shows the person behind the listing is present (liveness and face similarity in the World ID
 * app) and, through the action's nullifier, that one World ID lists at most one FaceVisa profile. It's also the way
 * a World ID with no Orb gets a credential at all ("No Orb, passport or other prerequisite credential is required").
 *
 * Two credentials answer the request (IDKit's `any()`): Selfie Check (Proof of Presence, issuer schema 11), the
 * minimum this moment needs, or Proof of Human (the Orb, issuer schema 1), a stronger credential some creators already
 * hold. Both prove a unique human for the action through the nullifier; only Selfie Check carries a `sybil_score`, so
 * only it can be held for review. Rohit's call, 5 Nov: World's sandbox lists Selfie Check as "Coming soon", and
 * production World App offered only the Orb.
 *
 * Everything that matters happens here, on the server:
 * - The request is signed with the app's RP signing key (`signRequest`, IDKit's server package). The key is read from
 *   a file and never leaves this module. Each signed request is an attempt: its nonce is single-use, for one account,
 *   and lives 5 minutes.
 * - The result from the browser is untrusted. It must answer that attempt (nonce, action, the pinned environment),
 *   carry a Selfie Check response (issuer schema 11) bound to this account (signal hash), and then pass World's own
 *   check at developer.world.org/api/v4/verify/{rp_id}, sent with the environment pinned.
 * - Only after that: the nullifier must be new for the action (one row per (action, nullifier)), and the
 *   `sybil_score` (0–10) is read. World calls it "a risk signal, not a uniqueness verdict, and should be considered
 *   alongside other evidence", so a score above PRESENCE_MAX_SYBIL_SCORE is never a refusal: the proof is stored
 *   **held for review** (the creator can't list, and is told it's under review) until someone clears or rejects it
 *   (`pnpm presence:review`). Refusing would also lock the person out for good: the action is once per person, and
 *   World has already counted this one.
 * - A cancel, a timeout or any failure records the attempt's outcome and changes nothing else.
 * - Every step is logged as `[presence] …` for the debrief: times, what came back, World's answer in full (with any
 *   nullifier redacted; only the fact that one was stored is logged), the score and the environment.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { signRequest } from "@worldcoin/idkit-server";
import { keccak256, stringToBytes } from "viem";

export type IdkitEnvironment = "production" | "staging" | "sandbox";

export interface PresenceConfig {
  appId: `app_${string}`;
  rpId: `rp_${string}`;
  signingKeyHex: string;
  action: string;
  environment: IdkitEnvironment;
  /** Accept a sybil_score up to this (0–10). World's illustrative bands: under 2 low, 2–4 medium, 4–6 high, 6+ very high. */
  maxSybilScore: number;
  verifyBase: string;
}

/** none: no proof yet; verified: may list; review: held for review (a high risk signal); rejected: not cleared. */
export type PresenceState = "none" | "verified" | "review" | "rejected";

/** The credential behind a proof: Selfie Check (Proof of Presence) or Proof of Human (the Orb). */
export type PresenceCredential = "selfie" | "proof_of_human";

export interface PresenceStatus {
  state: PresenceState;
  verified: boolean;
  verifiedAt: number | null;
  /** Selfie Check only (Proof of Human carries none). */
  sybilScore: number | null;
  environment: IdkitEnvironment | null;
  credential: PresenceCredential | null;
}

export class PresenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What IDKit hands the browser after a Selfie Check (the parts we read; the rest goes to World unchanged). */
interface IdkitResult {
  protocol_version?: unknown;
  nonce?: unknown;
  action?: unknown;
  environment?: unknown;
  responses?: { identifier?: unknown; issuer_schema_id?: unknown; nullifier?: unknown; signal_hash?: unknown; sybil_score?: unknown }[];
  integrity_bundle?: unknown;
}

const ATTEMPT_TTL_S = 300;

/**
 * The credentials a request asks for. Production and staging: Selfie Check or Proof of Human (IDKit's any()). Sandbox:
 * Proof of Human only. World's sandbox lists Selfie Check as "Coming soon", and its app stalls silently on any request
 * that includes it (5 Nov 2026, INTEGRATION_DEBRIEF.md); a Proof of Human request completes.
 */
export const requestedCredentials = (environment: IdkitEnvironment): PresenceCredential[] => (environment === "sandbox" ? ["proof_of_human"] : ["selfie", "proof_of_human"]);

/** IDKit's hashSignal: keccak-256 of the UTF-8 signal, shifted right 8 bits into the field (as in @worldcoin/idkit-core). */
export const hashSignal = (signal: string) => `0x${(BigInt(keccak256(stringToBytes(signal))) >> 8n).toString(16).padStart(64, "0")}`;
/** The signal binds a proof to one FaceVisa account: a proof made for someone else's request can't list this one. */
export const presenceSignal = (uid: string) => `facevisa:${uid}`;

/** Settings from the environment, or undefined when IDKit isn't configured (then listing doesn't require it). */
export function presenceConfigFromEnv(root: string, localDev: boolean, env = process.env): PresenceConfig | undefined {
  const set = [env.WORLD_APP_ID, env.WORLD_RP_ID, env.WORLD_RP_SIGNING_KEY_FILE].filter(Boolean).length;
  if (set === 0) return undefined;
  if (set < 3) throw new Error("Proof of Presence needs all of WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY_FILE");
  if (!/^app_[0-9a-zA-Z_]+$/.test(env.WORLD_APP_ID!)) throw new Error("WORLD_APP_ID: app_… from the Developer Portal");
  if (!/^rp_[0-9a-zA-Z_]+$/.test(env.WORLD_RP_ID!)) throw new Error("WORLD_RP_ID: rp_… from the Developer Portal");
  const environment = (env.WORLD_IDKIT_ENVIRONMENT || "production") as IdkitEnvironment;
  if (!["production", "staging", "sandbox"].includes(environment)) throw new Error("WORLD_IDKIT_ENVIRONMENT: production, staging or sandbox");
  // Staging and sandbox accept test proofs: local development only, or the public demo with sandbox (every proof
  // labelled sandbox; the runtime also pins it to the public demo's own namespace).
  const publicSandbox = environment === "sandbox" && env.FACEVISA_PUBLIC_DEMO === "1";
  if (environment !== "production" && !localDev && !publicSandbox) throw new Error(`WORLD_IDKIT_ENVIRONMENT=${environment} accepts test proofs: only with FACEVISA_LOCAL_DEV=1 (or sandbox on the public demo, FACEVISA_PUBLIC_DEMO=1)`);
  const max = env.PRESENCE_MAX_SYBIL_SCORE === undefined || env.PRESENCE_MAX_SYBIL_SCORE === "" ? 3 : Number(env.PRESENCE_MAX_SYBIL_SCORE);
  if (!Number.isFinite(max) || max < 0 || max > 10) throw new Error("PRESENCE_MAX_SYBIL_SCORE: 0 to 10");
  return { appId: env.WORLD_APP_ID as `app_${string}`, rpId: env.WORLD_RP_ID as `rp_${string}`, signingKeyHex: readSigningKey(env.WORLD_RP_SIGNING_KEY_FILE!, root), action: env.WORLD_IDKIT_ACTION || "list-likeness-dev", environment, maxSybilScore: max, verifyBase: "https://developer.world.org" };
}

/** The RP signing key from its file: 32 bytes of hex (0x optional), readable only by its owner. */
function readSigningKey(file: string, root: string): string {
  const path = isAbsolute(file) ? file : resolve(root, file);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error("WORLD_RP_SIGNING_KEY_FILE: no such file");
  if (st.mode & 0o077) throw new Error("WORLD_RP_SIGNING_KEY_FILE: readable by others (chmod 600 it)");
  const key = readFileSync(path, "utf8").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("WORLD_RP_SIGNING_KEY_FILE: not a 32-byte hex key");
  return key;
}

const SCHEMA = `
create table if not exists presence_attempts (
  nonce text primary key, uid text not null, action text not null, created_at integer not null, expires_at integer not null,
  status text not null, outcome text, decided_at integer
);
create table if not exists presence_proofs (
  uid text primary key, action text not null, nullifier text not null, sybil_score integer, environment text not null,
  verified_at integer not null, expires_at_min integer, status text not null default 'verified', reviewed_at integer,
  credential text not null default 'selfie',
  unique (action, nullifier)
);
`;

/** For logs: any nullifier in World's answer is replaced (the debrief needs that one was stored, never its value). */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /nullifier/i.test(k) ? "[redacted]" : redact(x)]));
  return v;
}

export class Presence {
  constructor(
    private readonly db: DatabaseSync,
    readonly config: PresenceConfig,
    private readonly o: { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void } = {},
  ) {
    db.exec(SCHEMA);
    // Databases from before "held for review": every stored proof then was a verified one.
    const cols = (db.prepare("pragma table_info(presence_proofs)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("status")) db.exec("alter table presence_proofs add column status text not null default 'verified'");
    if (!cols.includes("reviewed_at")) db.exec("alter table presence_proofs add column reviewed_at integer");
    // Databases from before Proof of Human: sybil_score was required (Selfie Check only). Rebuilt, every row kept.
    const score = (db.prepare("pragma table_info(presence_proofs)").all() as { name: string; notnull: number }[]).find((c) => c.name === "sybil_score");
    if (score?.notnull) {
      db.exec(`begin;
        create table presence_proofs_v2 (
          uid text primary key, action text not null, nullifier text not null, sybil_score integer, environment text not null,
          verified_at integer not null, expires_at_min integer, status text not null default 'verified', reviewed_at integer,
          credential text not null default 'selfie', unique (action, nullifier));
        insert into presence_proofs_v2 (uid, action, nullifier, sybil_score, environment, verified_at, expires_at_min, status, reviewed_at)
          select uid, action, nullifier, sybil_score, environment, verified_at, expires_at_min, status, reviewed_at from presence_proofs;
        drop table presence_proofs;
        alter table presence_proofs_v2 rename to presence_proofs;
        commit;`);
    }
  }

  private log(line: string) {
    (this.o.log ?? ((l: string) => console.log(l)))(`[presence] ${line}`);
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  status(uid: string): PresenceStatus {
    // Only a proof from this server's environment counts: a sandbox or staging proof never passes for production.
    const r = this.db.prepare("select * from presence_proofs where uid = ? and action = ? and environment = ?").get(uid, this.config.action, this.config.environment) as Record<string, unknown> | undefined;
    if (!r) return { state: "none", verified: false, verifiedAt: null, sybilScore: null, environment: null, credential: null };
    const state = r.status as PresenceState;
    return { state, verified: state === "verified", verifiedAt: Number(r.verified_at), sybilScore: r.sybil_score === null ? null : Number(r.sybil_score), environment: r.environment as IdkitEnvironment, credential: r.credential as PresenceCredential };
  }

  /** Proofs held for review (a risk signal above the limit), oldest first. */
  heldForReview(): { uid: string; sybilScore: number; environment: string; verifiedAt: number }[] {
    return (this.db.prepare("select uid, sybil_score, environment, verified_at from presence_proofs where action = ? and status = 'review' order by verified_at").all(this.config.action) as Record<string, unknown>[]).map((r) => ({ uid: String(r.uid), sybilScore: Number(r.sybil_score), environment: String(r.environment), verifiedAt: Number(r.verified_at) }));
  }

  /** A person's decision on a held proof: cleared (the creator may list) or rejected (they can't, with this World ID). */
  review(uid: string, decision: "clear" | "reject"): PresenceStatus {
    const changed = this.db.prepare("update presence_proofs set status = ?, reviewed_at = ? where uid = ? and action = ? and status = 'review'").run(decision === "clear" ? "verified" : "rejected", this.now(), uid, this.config.action).changes;
    if (Number(changed) !== 1) throw new PresenceError(409, "not_held", "no Proof of Presence held for review for this account");
    this.log(`review: ${uid} ${decision === "clear" ? "cleared (may list)" : "rejected"}`);
    return this.status(uid);
  }

  /** A signed request for this account: what the browser needs to open IDKit. The nonce is this attempt. */
  start(uid: string) {
    // One proof per account, ever: an account with a proof from another environment (or action) never mixes them.
    const other = this.db.prepare("select environment, action from presence_proofs where uid = ? and (environment != ? or action != ?)").get(uid, this.config.environment, this.config.action) as { environment: string; action: string } | undefined;
    if (other) throw new PresenceError(409, "other_environment", `this account already has a Proof of Presence from ${other.environment === "production" ? "production" : `World ID's ${other.environment} (a test identity)`} for ${other.action}: use another account`);
    const st = this.status(uid).state;
    if (st === "verified") throw new PresenceError(409, "already_verified", "you already completed the World ID check");
    if (st === "review") throw new PresenceError(409, "held_for_review", "your Proof of Presence is held for review");
    if (st === "rejected") throw new PresenceError(409, "review_rejected", "your Proof of Presence wasn't cleared in review");
    const sig = signRequest({ signingKeyHex: this.config.signingKeyHex, action: this.config.action, ttl: ATTEMPT_TTL_S });
    this.db.prepare("insert into presence_attempts (nonce, uid, action, created_at, expires_at, status) values (?, ?, ?, ?, ?, 'open')").run(sig.nonce, uid, this.config.action, sig.createdAt * 1000, sig.expiresAt * 1000);
    this.log(`start: ${uid}, action ${this.config.action}, environment ${this.config.environment}${this.config.environment === "production" ? "" : " (TEST proofs: World ID " + this.config.environment + ")"}, app ${this.config.appId}, rp ${this.config.rpId}; attempt ${sig.nonce.slice(0, 10)}… signed, valid ${ATTEMPT_TTL_S} s; asks for ${requestedCredentials(this.config.environment).join(" or ")}`);
    return {
      app_id: this.config.appId,
      action: this.config.action,
      environment: this.config.environment,
      credentials: requestedCredentials(this.config.environment),
      signal: presenceSignal(uid),
      rp_context: { rp_id: this.config.rpId, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
    };
  }

  /** The person cancelled, IDKit timed out, or the World ID app reported an error: recorded, nothing else changes. */
  cancel(uid: string, nonce: string, code: string) {
    const outcome = /^[a-z_0-9]{1,40}$/.test(code) ? code : "unknown";
    const a = this.db.prepare("select created_at from presence_attempts where nonce = ? and uid = ? and status = 'open'").get(nonce, uid) as { created_at: number } | undefined;
    this.log(`ended in the World ID app: ${uid}, attempt ${nonce.slice(0, 10)}…, IDKit code ${outcome}${a ? `, ${((this.now() - Number(a.created_at)) / 1000).toFixed(1)} s after the request was signed` : " (no open attempt)"}; nothing changed`);
    this.db.prepare("update presence_attempts set status = ?, outcome = ?, decided_at = ? where nonce = ? and uid = ? and status = 'open'").run(["cancelled", "user_rejected", "closed"].includes(outcome) ? "cancelled" : "failed", outcome, this.now(), nonce, uid);
  }

  private fail(nonce: string, status: number, code: string, message: string): never {
    this.log(`refused: attempt ${nonce.slice(0, 10)}…, ${status} ${code}: ${message}`);
    this.db.prepare("update presence_attempts set status = 'failed', outcome = ?, decided_at = ? where nonce = ?").run(code, this.now(), nonce);
    throw new PresenceError(status, code, message);
  }

  /** Checks an IDKit result for this account, has World verify it, then applies our own rules. Single use. */
  async verify(uid: string, result: unknown): Promise<PresenceStatus> {
    const r = (result ?? {}) as IdkitResult;
    const nonce = typeof r.nonce === "string" ? r.nonce : "";
    // The attempt: this account's, still open, not expired. Claimed now, so a result can't be verified twice.
    const attempt = this.db.prepare("select * from presence_attempts where nonce = ? and uid = ?").get(nonce, uid) as Record<string, unknown> | undefined;
    if (!attempt) throw new PresenceError(404, "unknown_attempt", "this check wasn't started here: start again");
    if (Number(this.db.prepare("update presence_attempts set status = 'verifying' where nonce = ? and status = 'open'").run(nonce).changes) !== 1) throw new PresenceError(409, "attempt_used", "this check was already used: start again");
    if (Number(attempt.expires_at) <= this.now()) this.fail(nonce, 410, "expired", "that check took too long: start again");
    if (r.protocol_version !== "4.0") this.fail(nonce, 422, "wrong_protocol", "a World ID 4.0 proof is required");
    if (r.action !== this.config.action || r.action !== attempt.action) this.fail(nonce, 422, "wrong_action", "the proof is for another action");
    // Pinned: staging and sandbox accept test proofs.
    if (r.environment !== this.config.environment) this.fail(nonce, 422, "wrong_environment", `the proof is from ${String(r.environment)}, not ${this.config.environment}`);
    // Selfie Check (issuer schema 11) or Proof of Human (issuer schema 1); Selfie Check first when both came back.
    const items = r.responses ?? [];
    const selfie = items.find((x) => x?.identifier === "selfie" && x.issuer_schema_id === 11) ?? items.find((x) => x?.identifier === "proof_of_human" && x.issuer_schema_id === 1);
    if (!selfie) this.fail(nonce, 422, "not_selfie_check", "the proof is neither Proof of Presence (Selfie Check) nor Proof of Human");
    const credential: PresenceCredential = selfie.identifier === "selfie" ? "selfie" : "proof_of_human";
    if (!isFieldValue(selfie.signal_hash) || BigInt(selfie.signal_hash) !== BigInt(hashSignal(presenceSignal(uid)))) this.fail(nonce, 422, "wrong_signal", "the proof wasn't made for this account");
    // The integrity bundle is "Required with version 2 when any response item is a Selfie Check credential".
    if (credential === "selfie" && !r.integrity_bundle) this.fail(nonce, 422, "no_integrity_bundle", "the proof has no World ID app integrity bundle");
    const ib = (r.integrity_bundle ?? {}) as { version?: unknown; signature_format?: unknown };
    this.log(
      `result: ${uid}, attempt ${nonce.slice(0, 10)}…, ${((this.now() - Number(attempt.created_at)) / 1000).toFixed(1)} s after the request was signed; protocol ${String(r.protocol_version)}, environment ${String(r.environment)}, action ${String(r.action)}; ` +
        `responses ${JSON.stringify((r.responses ?? []).map((x) => ({ identifier: x?.identifier, issuer_schema_id: x?.issuer_schema_id, sybil_score: x?.sybil_score, nullifier: x?.nullifier ? "present" : "missing" })))}; credential used: ${credential}; integrity bundle ${r.integrity_bundle ? `v${String(ib.version)} ${String(ib.signature_format)}` : "none"}`,
    );

    // World's check: the proof, the integrity bundle (which covers the sybil_score), the RP signature and nonce.
    let ok = false;
    let detail = "World ID couldn't verify the proof";
    let worldSaysUsed = "";
    const url = `${this.config.verifyBase}/api/v4/verify/${this.config.rpId}`;
    const t0 = Date.now();
    try {
      const res = await (this.o.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...r, environment: this.config.environment }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body: { success?: unknown; environment?: unknown; code?: unknown; detail?: unknown } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: logged as text below
      }
      // World's answer in full for the debrief, with any nullifier redacted.
      this.log(`World verify: POST ${url} → HTTP ${res.status} in ${Date.now() - t0} ms: ${text.startsWith("{") || text.startsWith("[") ? JSON.stringify(redact(body)) : text.slice(0, 2000)}`);
      ok = res.ok && body.success === true && (body.environment === undefined || body.environment === this.config.environment);
      if (!ok) detail = `World ID refused the proof${typeof body.code === "string" ? ` (${body.code.slice(0, 60)})` : ""}`;
      // World's own once-per-person check: the same answer as our nullifier rule.
      if (!ok && typeof body.code === "string" && /max_verifications|already_verified|nullifier/i.test(body.code)) worldSaysUsed = body.code;
    } catch (e) {
      this.log(`World verify: POST ${url} failed after ${Date.now() - t0} ms: ${(e as Error).name}: ${(e as Error).message}`);
      detail = "World ID's verify service couldn't be reached: try again";
    }
    if (worldSaysUsed) this.fail(nonce, 409, "nullifier_used", `this World ID already completed the check for this action (World: ${worldSaysUsed.slice(0, 60)})`);
    if (!ok) this.fail(nonce, 422, "verification_failed", detail);

    // Only now is the score trustworthy (World checked it against the integrity bundle). Selfie Check only: Proof of
    // Human carries no score (the Orb's uniqueness is the check).
    const score = credential === "selfie" ? selfie.sybil_score : null;
    if (credential === "selfie" && (typeof score !== "number" || !Number.isInteger(score) || score < 0)) this.fail(nonce, 422, "no_sybil_score", "the proof carries no risk score");
    if (!isFieldValue(selfie.nullifier)) this.fail(nonce, 422, "no_nullifier", "the proof has no nullifier");
    const nullifier = BigInt(selfie.nullifier).toString();
    const expiresAtMin = typeof (selfie as { expires_at_min?: unknown }).expires_at_min === "number" ? (selfie as { expires_at_min: number }).expires_at_min : null;
    // A risk signal, not a verdict: above the limit, held for review rather than refused.
    const held = typeof score === "number" && score > this.config.maxSybilScore;
    try {
      this.db.prepare("insert into presence_proofs (uid, action, nullifier, sybil_score, environment, verified_at, expires_at_min, status, credential) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(uid, this.config.action, nullifier, score as number | null, this.config.environment, this.now(), expiresAtMin, held ? "review" : "verified", credential);
    } catch (e) {
      if (!/UNIQUE constraint failed/.test(String((e as Error).message))) throw e;
      // One World ID, one FaceVisa listing: the same nullifier for this action can't verify a second account.
      this.fail(nonce, 409, "nullifier_used", "this World ID already completed the check for another FaceVisa account");
    }
    this.db.prepare("update presence_attempts set status = ?, outcome = ?, decided_at = ? where nonce = ?").run(held ? "held" : "verified", held ? "held_for_review" : "verified", this.now(), nonce);
    this.log(`${held ? "HELD FOR REVIEW" : "verified"}: ${uid}, credential ${credential}, ${score === null ? "no sybil_score (Proof of Human)" : `sybil_score ${score} (limit ${this.config.maxSybilScore})`}, environment ${this.config.environment}, action ${this.config.action}; nullifier stored (unique for the action; value not logged)${expiresAtMin ? `, credential valid until ${new Date(expiresAtMin * 1000).toISOString()}` : ""}`);
    return this.status(uid);
  }
}

/** A field element as IDKit sends it: decimal or 0x-hex digits. */
const isFieldValue = (v: unknown): v is string => typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v);
