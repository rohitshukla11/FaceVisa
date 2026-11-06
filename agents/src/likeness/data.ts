/**
 * The data-access layer for Likeness's own records: creator listings (rules), licence requests and their finished-ad
 * approvals (pending actions), licences, payments, render receipts and the brand agent's activity log. SQLite now
 * (the same database and connection as accounts, so one transaction covers both); the interface is what Arkiv
 * replaces later for the public parts. The backend stays the authority: nothing here trusts the browser.
 *
 * A request's life: generating → review (the finished ad, not released) → verified → approved (the creator approves
 * that exact output, brand, usage, duration and price, in Likeness: app/approval.ts records it and approves at once)
 * → [spend_review → spend_verified → approved: the brand approves the spend, when the price is over its limit] →
 * paying → released (licence + receipt). Or: denied, expired, cancelled, failed. A rejection regenerates once.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Category, CreatorRules, Kind } from "./rules.js";

export type ActionStatus = "generating" | "review" | "verified" | "approved" | "spend_review" | "spend_verified" | "paying" | "released" | "denied" | "expired" | "cancelled" | "failed";

/** The finished ad waiting for the creator: stored, never released before approval and payment. */
export interface Output {
  hash: string; // 0x sha256 of the labelled file
  mime: string;
  size: number;
  provider: string;
  model: string;
  requestId: string | null;
  verified: boolean | null;
  prompt: string;
  promptSha256: string;
  faceCheck: "passed" | "not-run";
  faceScore: number | null;
  createdAt: number;
}

/** What a validated ID token proved at a checkpoint. */
export interface Evidence {
  iss: string;
  sub: string;
  authTime: number;
  amr: string[];
  acr: string | null;
  attemptId: string;
  verifiedAt: number;
  /** The creator's check is bound to the output they review; the brand's to the spend it covers. */
  outputHash?: string;
  amount?: number;
}

/** One checkpoint's state: the current attempt, its evidence, and the decision. */
export interface Checkpoint {
  attemptState: string | null;
  attemptStartedAt: number | null;
  evidence: Evidence | null;
  decidedAt: number | null;
}

export interface PendingAction {
  id: string;
  brand: string;
  creator: string;
  kind: Kind;
  category: Category; // the usage
  brief: string;
  briefHash: string;
  price: number; // micro-USD for this ad
  durationDays: number;
  createdAt: number;
  expiresAt: number;
  status: ActionStatus;
  /** 1 for the first output, 2 after one rejection (the most there is). */
  generation: number;
  output: Output | null;
  /** The creator's consent to the finished ad. */
  creatorCheck: Checkpoint;
  /** sha256 over the output hash, brand, usage, duration and price the creator approved. */
  approvalHash: string | null;
  /** The brand's own spend approval (over its limit); null when not needed. */
  spendCheck: Checkpoint | null;
  licenceId: string | null;
  reason: string | null;
}

export interface Licence {
  id: string;
  actionId: string;
  brand: string;
  creator: string;
  kind: Kind;
  category: Category;
  brief: string;
  price: number;
  durationDays: number;
  outputHash: string;
  approvalHash: string;
  status: "active" | "revoked";
  createdAt: number;
  expiresAt: number;
  /** When the creator revoked it (null while active). */
  revokedAt: number | null;
}

export interface Receipt extends Output {
  licenceId: string;
  paymentId: string;
  paymentRef: string;
  releasedAt: number;
}

export interface Payment {
  id: string;
  actionId: string;
  brand: string;
  amount: number;
  rail: string;
  status: "authorized" | "settled" | "voided";
  /** The rail's reference: DevPayment's `dev-…`, or the Hedera transaction ID (known from the signed payment). */
  ref: string | null;
  /** Hedera x402: the brand's account that paid and the creator's account that was paid (null for DevPayment). */
  payer: string | null;
  payee: string | null;
  createdAt: number;
  settledAt: number | null;
}

export type AgentEventKind =
  | "shortlisted"
  | "requested"
  | "generating"
  | "generated"
  | "waiting"
  | "verified"
  | "approved"
  | "rejected"
  | "spend-check"
  | "spend-approved"
  | "signed"
  | "funded"
  | "paying"
  | "paid"
  | "released"
  | "blocked"
  | "expired"
  | "denied"
  | "cancelled"
  | "failed";

export interface AgentEvent {
  id: number;
  brand: string;
  actionId: string | null;
  licenceId: string | null;
  kind: AgentEventKind;
  summary: string;
  at: number;
}

export interface Listing {
  uid: string;
  name: string;
  rules: CreatorRules;
  listedAt: number;
}

export type Stage = "creator" | "spend";

/** Daily caps on billed model calls (UTC day): per brand workspace and across the site. */
export interface AiCaps {
  brand: Record<"image" | "video", number>;
  site: Record<"image" | "video", number>;
}

/** A committed change to a public record (what Arkiv mirrors). */
export type DataChange = { kind: "listing"; uid: string } | { kind: "request"; id: string } | { kind: "licence"; id: string } | { kind: "receipt"; hash: string };

/** What the brand agent, the pipeline and the Agent Pass checkpoints need. SQLite is the authority; Arkiv mirrors it. */
export interface LikenessData {
  /** Called after each committed change to a listing, request, licence or receipt; never breaks the change itself. */
  onChange?: ((c: DataChange) => void) | undefined;
  /** Told after each agent event is logged (the Hedera audit log); its failure never fails the event. */
  onEvent?: ((e: AgentEvent) => void) | undefined;
  /** A listing whether listed or not (Arkiv mirrors unlisting too). */
  listingRecord(uid: string): (Listing & { listed: boolean }) | undefined;

  setListing(uid: string, rules: CreatorRules): Listing;
  unlist(uid: string): void;
  listing(uid: string): Listing | undefined;
  listings(): Listing[];

  createAction(a: Pick<PendingAction, "brand" | "creator" | "kind" | "category" | "brief" | "briefHash" | "price" | "durationDays" | "createdAt" | "expiresAt">): PendingAction;
  action(id: string): PendingAction | undefined;
  actions(by: { brand?: string; creator?: string; status?: ActionStatus }): PendingAction[];
  /** Moves an action from one of `from` to `to`; false when it wasn't in one of them (someone got there first). */
  transition(id: string, from: ActionStatus[], to: ActionStatus, patch?: { reason?: string }): boolean;
  /** The finished ad is ready: generating → review, with a fresh review window; earlier checks no longer count. */
  setOutput(id: string, output: Output, reviewUntil: number): boolean;
  /** A rejection: review/verified → generating, the next generation, the old output and checks gone. */
  regenerate(id: string): boolean;
  /** Starts a checkpoint attempt for a stage (a new attempt replaces the old one). */
  setAttempt(id: string, stage: Stage, state: string, startedAt: number): boolean;
  /** A validated check for the stage's current attempt (the creator's bound to the current output). */
  setVerified(id: string, stage: Stage, attemptState: string, evidence: Evidence): boolean;
  /** The creator approves: verified → approved (or spend_review when the brand must approve the spend). */
  approve(id: string, approvalHash: string, needsSpend: boolean): boolean;
  /** The brand approves its spend: spend_verified → approved. */
  approveSpend(id: string): boolean;
  /** Local development and tests: moves an action's expiry. */
  setExpiry(id: string, at: number): void;
  /** Ends every waiting action past its expiry; returns them. Generation and payment in progress aren't cut short. */
  expireDue(now?: number): PendingAction[];
  /** The release, in one transaction: paying → released, the licence and the receipt. Once per action. */
  /** `licenceMs` overrides the licence's length (dev-only minutes; see ARKIV_DEV_LICENCE_MINUTES). */
  release(id: string, r: { licenceDays: number; licenceMs?: number | undefined; payment: Payment; paymentRef: string }): Licence | undefined;

  licence(id: string): Licence | undefined;
  licences(by: { brand?: string; creator?: string }): Licence[];
  revoke(licenceId: string): boolean;

  authorizePayment(p: { actionId: string; brand: string; amount: number; rail: string; ref?: string; payer?: string; payee?: string }): Payment;
  settlePayment(id: string, ref: string): void;
  voidPayment(id: string): void;
  payment(id: string): Payment | undefined;
  payments(by: { brand?: string; actionId?: string }): Payment[];
  /** Payments on a rail still authorized (not settled or voided): an outcome to find out, e.g. after a restart. */
  unsettled(rail: string): Payment[];
  /** Authorized or settled today (UTC) by this brand, micro-USD. */
  spentToday(brand: string): number;

  receipt(hash: string): Receipt | undefined;

  /**
   * Reserves one billed model call (an image call, or a video call) for a brand today (UTC), within the brand's and
   * the site's daily caps, atomically. Returns the reason when a cap is reached; nothing is reserved then.
   */
  reserveAiCall(brand: string, kind: "image" | "video", caps: AiCaps): string | undefined;
  /** Billed model calls today (UTC): the brand's, and the whole site's. */
  aiCallsToday(brand: string): { brand: Record<"image" | "video", number>; site: Record<"image" | "video", number> };

  log(e: Omit<AgentEvent, "id" | "at">): AgentEvent;
  events(brand: string, limit?: number): AgentEvent[];
}

/** Bumped when these tables change shape: older (pre-release) Likeness tables are dropped and made again. */
const SCHEMA_VERSION = "2";
const TABLES = ["listings", "pending_actions", "licence_records", "payments", "render_receipts", "agent_events"];

const SCHEMA = `
create table if not exists listings (
  uid text primary key references accounts(uid), banned_categories text not null, min_price integer not null,
  max_days integer not null, listed integer not null, listed_at integer not null
);
create table if not exists pending_actions (
  id text primary key, brand text not null references accounts(uid), creator text not null references accounts(uid),
  kind text not null, category text not null, brief text not null, brief_hash text not null, price integer not null,
  duration_days integer not null, created_at integer not null, expires_at integer not null, status text not null,
  generation integer not null default 1, output text, creator_check text not null, approval_hash text,
  spend_check text, licence_id text, reason text
);
create table if not exists licence_records (
  id text primary key, action_id text not null unique references pending_actions(id), brand text not null,
  creator text not null, kind text not null, category text not null, brief text not null, price integer not null,
  duration_days integer not null, output_hash text not null unique, approval_hash text not null, status text not null,
  created_at integer not null, expires_at integer not null
);
create table if not exists payments (
  id text primary key, action_id text not null, brand text not null, amount integer not null, rail text not null,
  status text not null, ref text, created_at integer not null, settled_at integer
);
create table if not exists render_receipts (
  hash text primary key, licence_id text not null unique, output text not null, payment_id text not null,
  payment_ref text not null, released_at integer not null
);
create table if not exists agent_events (
  id integer primary key autoincrement, brand text not null, action_id text, licence_id text, kind text not null,
  summary text not null, at integer not null
);
create table if not exists ai_calls (day text not null, brand text not null, kind text not null, n integer not null, primary key (day, brand, kind));
create index if not exists agent_events_brand on agent_events (brand, id);
create index if not exists pending_actions_creator on pending_actions (creator, created_at);
create index if not exists pending_actions_brand on pending_actions (brand, created_at);
`;

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const dayStart = (now = Date.now()) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
const EMPTY: Checkpoint = { attemptState: null, attemptStartedAt: null, evidence: null, decidedAt: null };
const WAITING: ActionStatus[] = ["review", "verified", "approved", "spend_review", "spend_verified"];

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T | null => (v ? (JSON.parse(v as string) as T) : null);

const actionRow = (r: Row | undefined): PendingAction | undefined =>
  r && {
    id: r.id as string,
    brand: r.brand as string,
    creator: r.creator as string,
    kind: r.kind as Kind,
    category: r.category as Category,
    brief: r.brief as string,
    briefHash: r.brief_hash as string,
    price: Number(r.price),
    durationDays: Number(r.duration_days),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    status: r.status as ActionStatus,
    generation: Number(r.generation),
    output: json<Output>(r.output),
    creatorCheck: json<Checkpoint>(r.creator_check) ?? EMPTY,
    approvalHash: (r.approval_hash as string | null) ?? null,
    spendCheck: json<Checkpoint>(r.spend_check),
    licenceId: (r.licence_id as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  };

const licenceRow = (r: Row | undefined): Licence | undefined =>
  r && {
    id: r.id as string,
    actionId: r.action_id as string,
    brand: r.brand as string,
    creator: r.creator as string,
    kind: r.kind as Kind,
    category: r.category as Category,
    brief: r.brief as string,
    price: Number(r.price),
    durationDays: Number(r.duration_days),
    outputHash: r.output_hash as string,
    approvalHash: r.approval_hash as string,
    status: r.status as Licence["status"],
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  };

const paymentRow = (r: Row): Payment => ({
  id: r.id as string,
  actionId: r.action_id as string,
  brand: r.brand as string,
  amount: Number(r.amount),
  rail: r.rail as string,
  status: r.status as Payment["status"],
  ref: (r.ref as string | null) ?? null,
  payer: (r.payer as string | null) ?? null,
  payee: (r.payee as string | null) ?? null,
  createdAt: Number(r.created_at),
  settledAt: r.settled_at == null ? null : Number(r.settled_at),
});

export class SqliteLikenessData implements LikenessData {
  onChange: ((c: DataChange) => void) | undefined;
  onEvent: ((e: AgentEvent) => void) | undefined;

  constructor(private readonly db: DatabaseSync) {
    const v = (db.prepare("select value from meta where key = 'likeness_schema'").get() as { value: string } | undefined)?.value;
    if (v !== SCHEMA_VERSION) {
      for (const t of TABLES) db.exec(`drop table if exists ${t}`);
      db.prepare("insert into meta (key, value) values ('likeness_schema', ?) on conflict(key) do update set value = excluded.value").run(SCHEMA_VERSION);
    }
    db.exec(SCHEMA);
    // Added 4 Nov (the Arkiv revocation record): kept as a column added in place, so existing records stay.
    if (!(db.prepare("pragma table_info(licence_records)").all() as Row[]).some((c) => c.name === "revoked_at")) db.exec("alter table licence_records add column revoked_at integer");
    // Licences revoked before that column: their time from the agent log's "revoked licence" entry, never a guess.
    // Added 4 Nov (Hedera x402): who paid whom, in place.
    const paymentCols = (db.prepare("pragma table_info(payments)").all() as Row[]).map((c) => c.name);
    for (const col of ["payer", "payee"]) if (!paymentCols.includes(col)) db.exec(`alter table payments add column ${col} text`);
    db.exec("update licence_records set revoked_at = (select max(e.at) from agent_events e where e.licence_id = licence_records.id and e.summary like '%revoked licence%') where status = 'revoked' and revoked_at is null");
  }

  /** Runs f in one IMMEDIATE transaction (a write lock from the start), rolled back on any error. */
  private tx<T>(f: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = f();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  private changed(sql: string, ...args: (string | number | null)[]) {
    return Number(this.db.prepare(sql).run(...args).changes) === 1;
  }

  /** Tells the listener (the Arkiv outbox) after a commit; its failure never fails the change. */
  private emit(c: DataChange, ok = true) {
    if (!ok || !this.onChange) return ok;
    try {
      this.onChange(c);
    } catch (e) {
      console.error(`[likeness] change listener failed: ${(e as Error).name}`);
    }
    return ok;
  }

  // ---------------------------------------------------------------- listings

  setListing(uid: string, rules: CreatorRules): Listing {
    this.db
      .prepare(
        `insert into listings (uid, banned_categories, min_price, max_days, listed, listed_at) values (?, ?, ?, ?, 1, ?)
         on conflict(uid) do update set banned_categories = excluded.banned_categories, min_price = excluded.min_price,
         max_days = excluded.max_days, listed = 1`,
      )
      .run(uid, JSON.stringify(rules.bannedCategories), rules.minPrice, rules.maxDays, Date.now());
    this.emit({ kind: "listing", uid });
    return this.listing(uid)!;
  }

  unlist(uid: string) {
    this.emit({ kind: "listing", uid }, Number(this.db.prepare("update listings set listed = 0 where uid = ? and listed = 1").run(uid).changes) === 1);
  }

  listingRecord(uid: string) {
    const r = this.db.prepare("select l.*, a.name from listings l join accounts a on a.uid = l.uid where l.uid = ?").get(uid) as Row | undefined;
    return r && { ...this.listingRow(r)!, listed: Number(r.listed) === 1 };
  }

  private listingRow(r: Row | undefined): Listing | undefined {
    return r && { uid: r.uid as string, name: r.name as string, rules: { bannedCategories: JSON.parse(r.banned_categories as string), minPrice: Number(r.min_price), maxDays: Number(r.max_days) }, listedAt: Number(r.listed_at) };
  }

  listing(uid: string) {
    return this.listingRow(this.db.prepare("select l.*, a.name from listings l join accounts a on a.uid = l.uid where l.uid = ? and l.listed = 1").get(uid) as Row | undefined);
  }

  listings() {
    return (this.db.prepare("select l.*, a.name from listings l join accounts a on a.uid = l.uid where l.listed = 1 order by l.listed_at").all() as Row[]).map((r) => this.listingRow(r)!);
  }

  // ---------------------------------------------------------------- actions

  createAction(a: Parameters<LikenessData["createAction"]>[0]): PendingAction {
    const id = newId("req");
    this.db
      .prepare(
        `insert into pending_actions (id, brand, creator, kind, category, brief, brief_hash, price, duration_days, created_at, expires_at, status, generation, creator_check)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', 1, ?)`,
      )
      .run(id, a.brand, a.creator, a.kind, a.category, a.brief, a.briefHash, a.price, a.durationDays, a.createdAt, a.expiresAt, JSON.stringify(EMPTY));
    this.emit({ kind: "request", id });
    return this.action(id)!;
  }

  action(id: string) {
    return actionRow(this.db.prepare("select * from pending_actions where id = ?").get(id) as Row | undefined);
  }

  actions(by: { brand?: string; creator?: string; status?: ActionStatus }) {
    const [col, v] = by.brand ? ["brand", by.brand] : by.creator ? ["creator", by.creator] : ["status", by.status!];
    return (this.db.prepare(`select * from pending_actions where ${col} = ? order by created_at desc`).all(v) as Row[]).map((r) => actionRow(r)!);
  }

  transition(id: string, from: ActionStatus[], to: ActionStatus, patch: { reason?: string } = {}) {
    return this.emit({ kind: "request", id }, this.changed(`update pending_actions set status = ?, reason = coalesce(?, reason) where id = ? and status in (${from.map(() => "?").join(", ")})`, to, patch.reason ?? null, id, ...from));
  }

  setOutput(id: string, output: Output, reviewUntil: number) {
    return this.emit({ kind: "request", id }, this.changed("update pending_actions set status = 'review', output = ?, expires_at = ?, creator_check = ?, reason = null where id = ? and status = 'generating'", JSON.stringify(output), reviewUntil, JSON.stringify(EMPTY), id));
  }

  regenerate(id: string) {
    return this.emit({ kind: "request", id }, this.changed("update pending_actions set status = 'generating', generation = generation + 1, output = null, creator_check = ? where id = ? and status in ('review', 'verified') and generation = 1", JSON.stringify(EMPTY), id));
  }

  setAttempt(id: string, stage: Stage, state: string, startedAt: number) {
    const a = this.action(id);
    if (!a) return false;
    const check = { ...(stage === "creator" ? a.creatorCheck : (a.spendCheck ?? EMPTY)), attemptState: state, attemptStartedAt: startedAt };
    return stage === "creator"
      ? this.changed("update pending_actions set creator_check = ? where id = ? and status in ('review', 'verified')", JSON.stringify(check), id)
      : this.changed("update pending_actions set spend_check = ? where id = ? and status in ('spend_review', 'spend_verified')", JSON.stringify(check), id);
  }

  setVerified(id: string, stage: Stage, attemptState: string, evidence: Evidence) {
    return this.tx(() => {
      const a = this.action(id);
      const check = a && (stage === "creator" ? a.creatorCheck : a.spendCheck);
      if (!a || !check || check.attemptState !== attemptState || a.expiresAt <= Date.now()) return false;
      if (stage === "creator") {
        if (!["review", "verified"].includes(a.status) || !a.output || evidence.outputHash !== a.output.hash) return false;
        return this.changed("update pending_actions set status = 'verified', creator_check = ? where id = ?", JSON.stringify({ ...check, evidence }), id);
      }
      if (!["spend_review", "spend_verified"].includes(a.status) || evidence.amount !== a.price) return false;
      return this.changed("update pending_actions set status = 'spend_verified', spend_check = ? where id = ?", JSON.stringify({ ...check, evidence }), id);
    });
  }

  approve(id: string, approvalHash: string, needsSpend: boolean) {
    return this.emit({ kind: "request", id }, this.tx(() => {
      const a = this.action(id);
      if (!a || a.status !== "verified") return false;
      return this.changed(
        "update pending_actions set status = ?, approval_hash = ?, creator_check = ?, spend_check = ? where id = ? and status = 'verified'",
        needsSpend ? "spend_review" : "approved",
        approvalHash,
        JSON.stringify({ ...a.creatorCheck, decidedAt: Date.now() }),
        needsSpend ? JSON.stringify(EMPTY) : null,
        id,
      );
    }));
  }

  approveSpend(id: string) {
    return this.tx(() => {
      const a = this.action(id);
      if (!a || a.status !== "spend_verified" || !a.spendCheck) return false;
      return this.changed("update pending_actions set status = 'approved', spend_check = ? where id = ? and status = 'spend_verified'", JSON.stringify({ ...a.spendCheck, decidedAt: Date.now() }), id);
    });
  }

  setExpiry(id: string, at: number) {
    this.db.prepare("update pending_actions set expires_at = ? where id = ?").run(at, id);
    this.emit({ kind: "request", id });
  }

  expireDue(now = Date.now()) {
    const expired = this.tx(() => {
      const due = (this.db.prepare(`select * from pending_actions where status in (${WAITING.map(() => "?").join(", ")}) and expires_at <= ?`).all(...WAITING, now) as Row[]).map((r) => actionRow(r)!);
      for (const a of due) this.db.prepare("update pending_actions set status = 'expired', reason = 'the request expired before it was approved and paid' where id = ?").run(a.id);
      return due.map((a) => ({ ...a, status: "expired" as const }));
    });
    for (const a of expired) this.emit({ kind: "request", id: a.id });
    return expired;
  }

  release(id: string, r: { licenceDays: number; licenceMs?: number | undefined; payment: Payment; paymentRef: string }) {
    let lic: Licence | undefined;
    try {
      lic = this.tx(() => {
        const a = this.action(id);
        if (!a || a.status !== "paying" || !a.output || !a.approvalHash) return undefined;
        const lid = newId("lic");
        const now = Date.now();
        this.db
          .prepare(
            `insert into licence_records (id, action_id, brand, creator, kind, category, brief, price, duration_days, output_hash, approval_hash, status, created_at, expires_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(lid, a.id, a.brand, a.creator, a.kind, a.category, a.brief, a.price, a.durationDays, a.output.hash, a.approvalHash, now, now + (r.licenceMs ?? a.durationDays * 86_400_000));
        this.db.prepare("insert into render_receipts (hash, licence_id, output, payment_id, payment_ref, released_at) values (?, ?, ?, ?, ?, ?)").run(a.output.hash.toLowerCase(), lid, JSON.stringify(a.output), r.payment.id, r.paymentRef, now);
        if (!this.changed("update pending_actions set status = 'released', licence_id = ? where id = ? and status = 'paying'", lid, a.id)) throw new Error("released concurrently");
        return this.licence(lid)!;
      });
    } catch (e) {
      // The unique action_id and output_hash are the last line: one approval, one licence, never two.
      if (/UNIQUE constraint failed/.test(String((e as Error).message))) return undefined;
      throw e;
    }
    if (lic) {
      this.emit({ kind: "request", id });
      this.emit({ kind: "licence", id: lic.id });
      this.emit({ kind: "receipt", hash: lic.outputHash.toLowerCase() });
    }
    return lic;
  }

  // ---------------------------------------------------------------- licences

  licence(id: string) {
    return licenceRow(this.db.prepare("select * from licence_records where id = ?").get(id) as Row | undefined);
  }

  licences(by: { brand?: string; creator?: string }) {
    const [col, v] = by.brand ? ["brand", by.brand] : ["creator", by.creator!];
    return (this.db.prepare(`select * from licence_records where ${col} = ? order by created_at desc`).all(v) as Row[]).map((r) => licenceRow(r)!);
  }

  revoke(licenceId: string) {
    return this.emit({ kind: "licence", id: licenceId }, this.changed("update licence_records set status = 'revoked', revoked_at = ? where id = ? and status = 'active'", Date.now(), licenceId));
  }

  // ---------------------------------------------------------------- payments

  authorizePayment(p: { actionId: string; brand: string; amount: number; rail: string; ref?: string; payer?: string; payee?: string }): Payment {
    const id = newId("pay");
    this.db.prepare("insert into payments (id, action_id, brand, amount, rail, status, ref, payer, payee, created_at) values (?, ?, ?, ?, ?, 'authorized', ?, ?, ?, ?)").run(id, p.actionId, p.brand, p.amount, p.rail, p.ref ?? null, p.payer ?? null, p.payee ?? null, Date.now());
    return this.payment(id)!;
  }

  payment(id: string) {
    const r = this.db.prepare("select * from payments where id = ?").get(id) as Row | undefined;
    return r && paymentRow(r);
  }

  unsettled(rail: string) {
    return (this.db.prepare("select * from payments where rail = ? and status = 'authorized' order by created_at").all(rail) as Row[]).map(paymentRow);
  }

  settlePayment(id: string, ref: string) {
    this.db.prepare("update payments set status = 'settled', ref = ?, settled_at = ? where id = ? and status = 'authorized'").run(ref, Date.now(), id);
  }

  voidPayment(id: string) {
    this.db.prepare("update payments set status = 'voided' where id = ? and status = 'authorized'").run(id);
  }

  payments(by: { brand?: string; actionId?: string }) {
    const [col, v] = by.brand ? ["brand", by.brand] : ["action_id", by.actionId!];
    return (this.db.prepare(`select * from payments where ${col} = ? order by created_at`).all(v) as Row[]).map(paymentRow);
  }

  spentToday(brand: string) {
    return Number((this.db.prepare("select coalesce(sum(amount), 0) as s from payments where brand = ? and status in ('authorized', 'settled') and created_at >= ?").get(brand, dayStart()) as Row).s);
  }

  // ---------------------------------------------------------------- receipts

  receipt(hash: string): Receipt | undefined {
    const r = this.db.prepare("select * from render_receipts where hash = ?").get(hash.toLowerCase()) as Row | undefined;
    return r && { ...(JSON.parse(r.output as string) as Output), licenceId: r.licence_id as string, paymentId: r.payment_id as string, paymentRef: r.payment_ref as string, releasedAt: Number(r.released_at) };
  }

  // ---------------------------------------------------------------- daily caps on billed model calls

  reserveAiCall(brand: string, kind: "image" | "video", caps: AiCaps) {
    const day = new Date().toISOString().slice(0, 10);
    return this.tx(() => {
      const mine = Number((this.db.prepare("select coalesce(sum(n), 0) as n from ai_calls where day = ? and brand = ? and kind = ?").get(day, brand, kind) as Row).n);
      const site = Number((this.db.prepare("select coalesce(sum(n), 0) as n from ai_calls where day = ? and kind = ?").get(day, kind) as Row).n);
      if (mine >= caps.brand[kind]) return `this brand workspace's daily cap on AI ${kind} calls is reached (${caps.brand[kind]} today, UTC)`;
      if (site >= caps.site[kind]) return `the site's daily cap on AI ${kind} calls is reached (${caps.site[kind]} today, UTC)`;
      this.db.prepare("insert into ai_calls (day, brand, kind, n) values (?, ?, ?, 1) on conflict(day, brand, kind) do update set n = n + 1").run(day, brand, kind);
      return undefined;
    });
  }

  aiCallsToday(brand: string) {
    const day = new Date().toISOString().slice(0, 10);
    const sum = (sql: string, ...a: string[]) => Number((this.db.prepare(sql).get(...a) as Row).n);
    const per = (k: string) => ({
      brand: sum("select coalesce(sum(n), 0) as n from ai_calls where day = ? and brand = ? and kind = ?", day, brand, k),
      site: sum("select coalesce(sum(n), 0) as n from ai_calls where day = ? and kind = ?", day, k),
    });
    const i = per("image");
    const v = per("video");
    return { brand: { image: i.brand, video: v.brand }, site: { image: i.site, video: v.site } };
  }

  // ---------------------------------------------------------------- the brand agent's activity log

  log(e: Omit<AgentEvent, "id" | "at">): AgentEvent {
    const at = Date.now();
    const r = this.db.prepare("insert into agent_events (brand, action_id, licence_id, kind, summary, at) values (?, ?, ?, ?, ?, ?)").run(e.brand, e.actionId, e.licenceId, e.kind, e.summary, at);
    const event = { ...e, id: Number(r.lastInsertRowid), at };
    try {
      this.onEvent?.(event);
    } catch (err) {
      console.error(`[likeness] event listener failed: ${(err as Error).name}`);
    }
    return event;
  }

  events(brand: string, limit = 200) {
    return (this.db.prepare("select * from agent_events where brand = ? order by id desc limit ?").all(brand, limit) as Row[]).map((r) => ({
      id: Number(r.id),
      brand: r.brand as string,
      actionId: (r.action_id as string | null) ?? null,
      licenceId: (r.licence_id as string | null) ?? null,
      kind: r.kind as AgentEventKind,
      summary: r.summary as string,
      at: Number(r.at),
    }));
  }
}
