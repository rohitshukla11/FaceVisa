/**
 * HTTP routes for FaceVisa's own flow (facevisa/): creator listings and rules, the brand agent (shortlist, request,
 * activity, release), the creator's requests and licences, the in-app approvals (the creator approves the exact
 * finished ad, the brand approves a spend over its limit), files, and Verify. Every route reads the caller from our
 * session (server.ts); nothing from the browser is proof. One account has a creator profile and a brand workspace:
 * routes act only on the caller's own. World ID appears only as the IDKit check before a creator lists.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Account } from "./accounts.js";
import type { Runtime } from "./runtime.js";
import { RequestRefused, type BrandBrief } from "../facevisa/brandAgent.js";
import type { Licence, PendingAction } from "../facevisa/data.js";
import { PipelineError } from "../facevisa/pipeline.js";
import { CATEGORIES, checkAsk, isCategory, MAX_DAYS_LIMIT, parseUsd, platformProblems, pricePerRender, rulesProblem, usd, VIDEO_MULTIPLIER, type Kind } from "../facevisa/rules.js";
import { ApprovalError } from "./approval.js";
import { csrfOk } from "./session.js";
import { localDevAllowed } from "./devmode.js";
import { DEMO_PATH, STANDIN_PATH } from "./standin.js";
import { PresenceError } from "./presence.js";
import { clientIp } from "./guard.js";
import { isDemoIssuer } from "./demo.js";
import { isGoogleIssuer } from "./google.js";
import type { EntityKind } from "../arkiv/schema.js";
import type { SyncStatus } from "../arkiv/outbox.js";
import type { Source } from "../arkiv/reads.js";
import { checkPayment, hashscan } from "../hedera/hedera.js";
import { X402_NETWORK, X402_RAIL } from "../hedera/x402.js";
import { checkWhitechainPayment, explorerAddress, explorerTx, WHITECHAIN_CHAIN_ID, WHITECHAIN_RAIL } from "../whitechain/whitechain.js";

export interface Ctx {
  rt: Runtime;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  me: Account | undefined;
  body: Record<string, unknown>;
}

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const isKind = (v: unknown): v is Kind => v === "image" || v === "video";
/**
 * How the signed-in person was identified (by their account's issuer), for labels and Arkiv's `identity`: "dev" (the
 * local dev sign-in, or DevConsent), "demo" (the public demo's test identities), or "world-id" (World ID sign-in, only
 * with WORLDID_SIGNIN=1). Approvals themselves are always in-app ("approved by the creator in FaceVisa").
 */
export const consentMethod = (iss: string): "dev" | "demo" | "google" | "world-id" => (iss === "dev-consent" || iss.endsWith(STANDIN_PATH) ? "dev" : iss.endsWith(DEMO_PATH) ? "demo" : isGoogleIssuer(iss) ? "google" : "world-id");
const name = (rt: Runtime, uid: string) => rt.accounts.account(uid)?.name || "unknown";
/** The provider of one kind of media: the composed provider's part for it ("0g", "vertex" or "test"). */
const mediaName = (rt: Runtime, kind: "image" | "video") => {
  const n = rt.core.ai.name.split("+");
  return n.length === 2 ? n[kind === "image" ? 0 : 1]! : rt.core.ai.name;
};
const ARKIV_OFF: Source = { from: "facevisa", why: "Arkiv is off on this server" };
/** A record's mirror on Arkiv, for the UI: synced (with the entity), pending, failed, or off. */
export const arkivStatus = (rt: Runtime, kind: EntityKind, subject: string): SyncStatus => rt.arkiv?.status(kind, subject) ?? { state: "off" };
/**
 * A creator's numbers as their creator_stats entity on Arkiv carries them (the same count: since this namespace began),
 * the entity's sync state and link, and their public "where is my face used" page (the direct verifier, by address).
 */
export function creatorStatsView(rt: Runtime, uid: string) {
  const s = rt.core.data.creatorStats(uid, Date.now(), rt.arkiv?.since ?? 0);
  const address = rt.keystore?.address(`account:${uid}`) ?? null;
  return {
    stats: s ? { adsApproved: s.adsApproved, activeLicences: s.activeLicences, revoked: s.revoked, earned: usd(s.earnedUsdt), brands: s.brands } : null,
    statsArkiv: arkivStatus(rt, "creator_stats", uid),
    usagePage: address && rt.arkiv ? `/verifier/creator.html?creator=${address.toLowerCase()}&ns=${encodeURIComponent(rt.arkiv.prefix)}` : null,
  };
}

/** A listed creator's face URL (signed-in accounts only), or null without a capture. */
const faceUrl = (rt: Runtime, uid: string) => (rt.accounts.creator(uid)?.photoFile ? `/api/facevisa/creators/${uid}/face` : null);
/**
 * A released ad's file on Swarm, for the pages that show the ad: its gateway link, and whether it's encrypted (only its
 * brand and creator open it, in FaceVisa); "pending" while it uploads. null when Swarm is off or the ad predates it.
 */
export function swarmView(rt: Runtime, hash: string) {
  const s = rt.swarm?.status(hash);
  if (!s) return null;
  return s.state === "uploaded" ? { state: s.state, ref: s.ref, url: s.url, encrypted: s.encrypted } : { state: s.state };
}
const outputFile = (a: PendingAction) => `/api/facevisa/outputs/${a.id}/file`;
const outputView = (a: PendingAction) =>
  a.output && { hash: a.output.hash, mime: a.output.mime, provider: a.output.provider, model: a.output.model, requestId: a.output.requestId, faceCheck: a.output.faceCheck, faceScore: a.output.faceScore, createdAt: a.output.createdAt };

/** A request as its creator sees it: who asks, the terms, and the finished ad itself (only they see it before release). */
/** When the request's current step began (its latest agent event), so a page can show how long a slow step has run. */
const stepAt = (rt: Runtime, a: PendingAction) => rt.core.data.events(a.brand, 500).find((e) => e.actionId === a.id)?.at ?? a.createdAt;

export function requestForCreator(rt: Runtime, a: PendingAction) {
  const revealed = !!a.output;
  return {
    id: a.id,
    brand: name(rt, a.brand),
    self: a.brand === a.creator,
    kind: a.kind,
    status: a.status,
    generation: a.generation,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    stepAt: stepAt(rt, a),
    decidedAt: a.creatorCheck.decidedAt,
    reason: a.reason,
    licenceId: a.licenceId,
    arkiv: arkivStatus(rt, "request", a.id),
    request: { brief: a.brief, category: a.category, durationDays: a.durationDays, price: usd(a.price) },
    output: revealed ? { ...outputView(a), file: outputFile(a), swarm: a.status === "released" ? swarmView(rt, a.output!.hash) : null } : null,
  };
}

/** A request as its brand sees it: all of what it asked, and the ad's file only once released. */
export function requestForBrand(rt: Runtime, a: PendingAction) {
  return {
    id: a.id,
    creator: name(rt, a.creator),
    // So the brand can ask again with the same terms (a failed or expired request).
    creatorId: a.creator,
    self: a.brand === a.creator,
    kind: a.kind,
    category: a.category,
    brief: a.brief,
    durationDays: a.durationDays,
    price: usd(a.price),
    status: a.status,
    generation: a.generation,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    reason: a.reason,
    licenceId: a.licenceId,
    output: a.output ? { ...outputView(a), file: a.status === "released" ? `/api/receipts/${a.output.hash}/file` : null, swarm: a.status === "released" ? swarmView(rt, a.output.hash) : null } : null,
    // "approved by the creator in FaceVisa", with how the creator signed in (dev, demo).
    consent: a.creatorCheck.decidedAt && a.creatorCheck.evidence ? { method: consentMethod(a.creatorCheck.evidence.iss), approvedAt: a.creatorCheck.decidedAt } : null,
    // "spend approved by the brand": null until it's needed.
    spend: a.spendCheck ? { approvedAt: a.spendCheck.decidedAt } : null,
    arkiv: arkivStatus(rt, "request", a.id),
    stepAt: stepAt(rt, a),
    // The public demo: a seeded creator never answers (nobody can sign in as them).
    ...(rt.demoState?.seeded(a.creator) ? { seededCreator: true } : {}),
    // The creator's face, for the brand's own requests (the route serves it only while they're listed).
    face: faceUrl(rt, a.creator),
    // The agent's latest step on this request, e.g. why a payment was refused.
    lastStep: rt.core.data.events(a.brand, 500).find((e) => e.actionId === a.id) ?? null,
  };
}

/**
 * The payment behind a receipt: its rail and reference, and who paid whom, in what, with an explorer link: Whitechain
 * (USDT, the settlement transaction on Whitechain's explorer) or Hedera x402 (USDC, HashScan).
 */
export function paymentView(rt: Runtime, paymentId: string, ref: string, amount: number) {
  const p = rt.core.data.payment(paymentId);
  const hedera = p?.rail === X402_RAIL;
  const wc = p?.rail === WHITECHAIN_RAIL ? rt.whitechain?.d.config : undefined;
  if (p && wc)
    return { rail: p.rail, ref, amount: usd(amount), network: `eip155:${WHITECHAIN_CHAIN_ID}`, asset: wc.usdt, payer: p.payer, payee: p.payee, explorer: explorerTx(wc, ref), hashscan: explorerTx(wc, ref), payerUrl: p.payer && explorerAddress(wc, p.payer), payeeUrl: p.payee && explorerAddress(wc, p.payee) };
  return {
    rail: p?.rail ?? null,
    ref,
    amount: usd(amount),
    ...(hedera ? { network: X402_NETWORK, asset: rt.hedera?.config.usdc ?? null, payer: p.payer, payee: p.payee, hashscan: hashscan.transaction(ref), payerUrl: p.payer && hashscan.account(p.payer), payeeUrl: p.payee && hashscan.account(p.payee) } : {}),
  };
}

function licenceView(rt: Runtime, l: Licence) {
  const r = rt.core.data.receipt(l.outputHash);
  return {
    id: l.id,
    brand: name(rt, l.brand),
    creator: name(rt, l.creator),
    kind: l.kind,
    category: l.category,
    brief: l.brief,
    price: usd(l.price),
    durationDays: l.durationDays,
    status: l.status,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    receipt: r && { hash: r.hash, mime: r.mime, provider: r.provider, model: r.model, faceCheck: r.faceCheck, faceScore: r.faceScore, paymentRef: r.paymentRef, paymentRail: rt.core.data.payment(r.paymentId)?.rail ?? null, payment: paymentView(rt, r.paymentId, r.paymentRef, l.price), releasedAt: r.releasedAt, file: `/api/receipts/${r.hash}/file`, swarm: swarmView(rt, r.hash) },
    arkiv: { licence: arkivStatus(rt, "licence", l.id), receipt: arkivStatus(rt, "receipt", l.outputHash.toLowerCase()), ...(l.status === "revoked" ? { revocation: arkivStatus(rt, "revocation", l.id) } : {}) },
  };
}

/**
 * The account's World ID check (IDKit), for the web: whether it's needed, and whether they have it. With IDKit on, it's
 * required of every account, creator and brand alike (Rohit, 6 Nov): one check per account covers both workspaces.
 */
export function presenceView(rt: Runtime, uid: string) {
  if (!rt.presence) return { required: false, verified: false };
  const s = rt.presence.status(uid);
  return { required: true, maxSybilScore: rt.presence.config.maxSybilScore, ...s, environment: s.environment ?? rt.presence.config.environment };
}

/** With IDKit on, a brand acts (shortlists, requests ads) only after its World ID check. */
const brandUnverified = (rt: Runtime, uid: string) => !!rt.presence && !rt.presence.status(uid).verified;
const BRAND_CHECK = { error: "complete the World ID check first: brands are verified with World ID too", code: "presence_required" };

/** What the web needs to draw the forms: categories, limits, the consent mode, the spend limit. */
export function facevisaMeta(rt: Runtime) {
  return {
    categories: CATEGORIES,
    videoMultiplier: VIDEO_MULTIPLIER,
    maxDays: MAX_DAYS_LIMIT,
    consent: rt.core.consent?.name ?? null,
    ai: rt.core.ai.name,
    reviewTtlMinutes: Math.round(rt.core.requestTtlMs / 60_000),
    spendLimit: rt.core.agent.d.spendLimit === undefined ? null : usd(rt.core.agent.d.spendLimit),
    // Daily caps on billed model calls (UTC), enforced while generation is billed (Vertex).
    // Who makes each kind of media (ai/media.ts), and whether each is billed (counts against the caps).
    aiMedia: { image: mediaName(rt, "image"), video: mediaName(rt, "video") },
    aiCaps: { billed: !!rt.core.ai.billed, ...rt.core.aiCaps },
    youtube: !!rt.youtube,
    arkiv: rt.arkiv ? { on: true, namespace: rt.arkiv.prefix } : { on: false },
    // Hedera: pay to release over x402, and the brand agent's audit log on an HCS topic.
    hedera: rt.x402 ? { x402: true, audit: rt.audit?.status() ?? null } : { x402: false },
    // How releases are paid, and where the public can check it.
    swarm: rt.swarm ? { gateway: rt.swarm.d.config.gateway, storedUntil: rt.swarm.storedUntil } : null,
    payments: rt.whitechain
      ? { rail: "whitechain", network: "Whitechain Sepolia", chainId: WHITECHAIN_CHAIN_ID, asset: "USDT", usdt: rt.whitechain.d.config.usdt, settlement: rt.whitechain.d.config.settlement, explorer: rt.whitechain.d.config.explorer, rpcUrl: rt.whitechain.d.config.rpcUrl }
      : rt.x402
        ? { rail: "hedera", network: "Hedera testnet", asset: "USDC" }
        : { rail: "dev", network: null, asset: null },
    // Local development only: the dev sign-in is on, so the web may show its dev-only shortcuts.
    devTools: !!rt.standin && localDevAllowed(rt.mode),
    // Proof of Presence: its environment (production, or a labelled test environment), when it's on.
    presence: rt.presence ? { environment: rt.presence.config.environment } : null,
    // The public demo: demo identities (a banner on every page), and its limits.
    publicDemo: rt.demo ? { retentionHours: 48, perVisitor: rt.demoState?.config.perIp ?? null } : null,
    // World ID sign-in: only with WORLDID_SIGNIN=1 (off by default). Locally, the dev sign-in.
    worldIdSignIn: !!rt.worldId && !rt.standin,
    devSignIn: !!rt.standin,
    // Sign in with Google (GOOGLE_SIGNIN=1); on the public demo it replaces the demo identities.
    googleSignIn: !!rt.google,
    demoSignIn: !!rt.demo && !rt.google,
  };
}

const sendFile = (res: ServerResponse, f: { bytes: Buffer; mime: string }) => {
  res.writeHead(200, { "content-type": f.mime, "cache-control": "private, no-store", "content-length": f.bytes.length });
  res.end(f.bytes);
  return true;
};

/** Handles the route if it is one of ours; returns false otherwise. */
export async function facevisaRoutes(c: Ctx): Promise<boolean> {
  const { rt, res, path, me, body } = c;
  const send = (status: number, b: unknown) => (sendJson(res, status, b), true);
  const get = c.req.method === "GET";
  const post = c.req.method === "POST";
  const core = rt.core;

  if (get && path === "/api/facevisa") return send(200, facevisaMeta(rt));

  // ---------------------------------------------------------------- Creators: who is listed (faces to signed-in accounts)
  if (get && path === "/api/facevisa/creators") {
    return send(200, {
      signedIn: !!me,
      creators: core.data.listings().map((l) => {
        const p = rt.presence?.status(l.uid);
        return {
          uid: l.uid,
          name: l.name,
          self: me?.uid === l.uid,
          listedAt: l.listedAt,
          image: usd(pricePerRender(l.rules, "image")),
          video: usd(pricePerRender(l.rules, "video")),
          maxDays: l.rules.maxDays,
          refuses: l.rules.bannedCategories,
          // With IDKit on: the proof's environment, or null without one.
          ...(rt.presence ? { presence: p?.verified ? (p.environment ?? rt.presence.config.environment) : null, credential: p?.verified ? p.credential : null } : {}),
          ...(rt.demoState?.seeded(l.uid) ? { seeded: true } : {}),
          arkiv: arkivStatus(rt, "listing", l.uid),
          // Their running numbers, as their creator_stats entity on Arkiv holds them (counted since this namespace
          // began), with that entity and their public "where is my face used" page.
          ...(rt.arkiv ? creatorStatsView(rt, l.uid) : {}),
          face: me ? faceUrl(rt, l.uid) : null,
        };
      }),
    });
  }
  // A listed creator's face (their capture's first frame), to signed-in accounts only; never on Arkiv.
  const faceOf = get ? /^\/api\/facevisa\/creators\/([A-Za-z0-9_-]{1,80})\/face$/.exec(path) : null;
  if (faceOf) {
    if (!me) return send(401, { error: "sign in to see creators' faces" });
    const row = core.data.listing(faceOf[1]!) ? rt.accounts.creator(faceOf[1]!) : undefined;
    const photo = row && rt.onboarding.photo(row);
    if (!photo) return send(404, { error: "no face for this creator" });
    return sendFile(res, photo);
  }

  // ---------------------------------------------------------------- Verify (public): a released ad by file hash
  if (get && path === "/api/facevisa/verify") {
    const hash = c.url.searchParams.get("hash") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return send(400, { error: "hash must be a 0x-prefixed sha256" });
    const r = core.data.receipt(hash);
    // Arkiv first: the receipt from the platform receipt key, its licence from the creator's key.
    const onArkiv = rt.arkivReads ? await rt.arkivReads.verify(hash) : null;
    const sync = r ? { licence: arkivStatus(rt, "licence", r.licenceId), receipt: arkivStatus(rt, "receipt", r.hash.toLowerCase()) } : null;
    const confirmed = !!onArkiv?.verdict && (!sync || (sync.licence.state === "synced" && sync.receipt.state === "synced"));
    const source: Source = !onArkiv
      ? ARKIV_OFF
      : !onArkiv.reachable
        ? { from: "facevisa", why: `Arkiv unreachable (${onArkiv.error})` }
        : confirmed
          ? { from: "arkiv", namespace: rt.arkiv!.prefix, entities: onArkiv.licence ? 2 : 1, fallback: 0, ...(onArkiv.note ? { note: onArkiv.note } : {}) }
          : { from: "facevisa", why: onArkiv.problems[0] ?? (sync && (sync.licence.state !== "synced" || sync.receipt.state !== "synced") ? ([sync.licence.state, sync.receipt.state].includes("pending") ? "its Arkiv write is pending" : "it isn't on Arkiv") : (onArkiv.note ?? "not on Arkiv")) };
    if (!r) {
      // Not in this backend, but on Arkiv from FaceVisa's own keys (an earlier database): the entities alone answer.
      const al = onArkiv?.licence;
      if (confirmed && al) {
        const who = (a: string) => (rt.arkivReads!.uidOf(a) && rt.accounts.account(rt.arkivReads!.uidOf(a)!)?.name) || a;
        return send(200, { verdict: onArkiv!.verdict, source, arkiv: onArkiv, licence: { id: al.licenceId, kind: al.kind, category: al.usage, durationDays: al.durationDays, price: usd(al.price), status: al.status, createdAt: al.approvedAt, expiresAt: al.expiresAt, brand: who(al.brand), creator: who(al.creator) }, consent: null });
      }
      // The licence entity has expired and is gone; the creator's revocation record says when they revoked it.
      if (confirmed && onArkiv?.revocation && onArkiv.verdict === "Revoked") return send(200, { verdict: "Revoked", reason: "the creator revoked this licence (their revocation record is on Arkiv)", source, arkiv: onArkiv, namespace: rt.arkiv?.prefix ?? null, fileHash: hash.toLowerCase() });
      // The licence entity has expired and is gone; the receipt, still on Arkiv, says when it ended.
      if (confirmed && onArkiv?.licenceEndedAt !== undefined) return send(200, { verdict: "Expired", reason: "the licence has ended (its end is recorded on the receipt)", source, arkiv: onArkiv, namespace: rt.arkiv?.prefix ?? null, fileHash: hash.toLowerCase() });
      return send(200, { verdict: "Unknown", reason: "no receipt for these exact bytes (edited, re-encoded, never approved or never released)", source, arkiv: onArkiv, namespace: rt.arkiv?.prefix ?? null, fileHash: hash.toLowerCase() });
    }
    const l = core.data.licence(r.licenceId)!;
    const a = core.data.action(l.actionId)!;
    const fromFaceVisa = l.status === "revoked" ? "Revoked" : l.expiresAt <= Date.now() ? "Expired" : "Licensed";
    const verdict = confirmed ? onArkiv!.verdict! : fromFaceVisa;
    const ev = a.creatorCheck.evidence;
    return send(200, {
      verdict,
      source,
      licence: { id: l.id, kind: l.kind, category: l.category, durationDays: l.durationDays, price: usd(l.price), status: l.status, createdAt: l.createdAt, expiresAt: l.expiresAt, brand: name(rt, l.brand), creator: name(rt, l.creator) },
      render: { kind: l.kind, mime: r.mime, size: r.size, createdAt: r.createdAt, releasedAt: r.releasedAt, prompt: r.prompt, promptSha256: r.promptSha256 },
      provenance: { provider: r.provider, model: r.model, requestId: r.requestId, verified: r.verified },
      faceCheck: { result: r.faceCheck, score: r.faceScore },
      // The payment checked where it settled: Whitechain (LicensePaid for this file, to this creator, this amount) or
      // Hedera's mirror node (brand → the creator named on the receipt, the licence's price).
      payment: {
        ...paymentView(rt, r.paymentId, r.paymentRef, l.price),
        ...(core.data.payment(r.paymentId)?.rail === WHITECHAIN_RAIL && rt.whitechain
          ? { check: await checkWhitechainPayment({ txHash: r.paymentRef, fileHash: r.hash, creator: core.data.payment(r.paymentId)!.payee, units: l.price }, { ...rt.whitechain.d.config, ...(rt.whitechain.d.client ? { client: rt.whitechain.client } : {}) }) }
          : {}),
        ...(core.data.payment(r.paymentId)?.rail === X402_RAIL
          ? { check: await checkPayment({ txId: r.paymentRef, payer: rt.accounts.hederaAccount(l.brand), payee: rt.accounts.hederaAccount(l.creator), units: l.price }, { ...(rt.hedera ? { mirrorUrl: rt.hedera.config.mirrorUrl, usdc: rt.hedera.config.usdc } : {}), ...(rt.mirrorFetch ? { fetch: rt.mirrorFetch } : {}) }) }
          : {}),
      },
      // "Approved by the creator in FaceVisa, <time>": bound to this file's hash; method = how they signed in.
      consent: ev ? { method: consentMethod(ev.iss), approvedAt: a.creatorCheck.decidedAt, boundTo: ev.outputHash === r.hash ? "this file" : "another file", requestId: a.id } : null,
      spend: a.spendCheck?.evidence ? { approvedAt: a.spendCheck.decidedAt } : null,
      arkiv: onArkiv,
      sync,
      // The file on Swarm: a public gateway link for a showcase ad; an encrypted one only its brand and creator open.
      swarm: swarmView(rt, r.hash),
      namespace: rt.arkiv?.prefix ?? null, fileHash: hash.toLowerCase(),
    });
  }

  // ---------------------------------------------------------------- pay to release (Hedera x402): the brand agent's endpoint
  const x402 = /^\/api\/x402\/ads\/(req_[0-9a-f]{16})$/.exec(path);
  if (get && x402) {
    if (!rt.x402) return send(404, { error: "x402 payments aren't on on this server (PAYMENTS=hedera)" });
    await rt.x402.handle(c.req, res, x402[1]!);
    return true;
  }

  // ---------------------------------------------------------------- files
  // A file the public demo deleted 48 hours after it was made (its hash stays on the receipt and on Arkiv).
  const gone = (rt: Runtime, hash: string) => (rt.demoState?.deletedAt(hash) !== undefined ? send(410, { error: "deleted 48 hours after it was made (the public demo's rule); its hash stays on the receipt and on Arkiv" }) : send(404, { error: "the file is gone" }));
  const receiptFile = /^\/api\/receipts\/(0x[0-9a-fA-F]{64})\/file$/.exec(path);
  if (get && receiptFile) {
    if (!me) return send(401, { error: "sign in first" });
    const r = core.data.receipt(receiptFile[1]!);
    const l = r && core.data.licence(r.licenceId);
    if (!r || !l) return send(404, { error: "no such render" });
    if (l.brand !== me.uid && l.creator !== me.uid) return send(403, { error: "not your render" });
    const f = rt.store.read(r.hash as `0x${string}`);
    if (f) return sendFile(res, f);
    // The local copy is gone (the public demo's 48 hours): read it back from Swarm, decrypted with the viewer's key.
    const fromSwarm = rt.swarm ? await rt.swarm.open(r.hash, me.uid).catch(() => undefined) : undefined;
    return fromSwarm ? sendFile(res, { bytes: Buffer.from(fromSwarm.bytes), mime: fromSwarm.mime }) : gone(rt, r.hash);
  }
  // The unreleased ad: only its creator (to review it), or its brand once released.
  const output = /^\/api\/facevisa\/outputs\/(req_[0-9a-f]{16})\/file$/.exec(path);
  if (get && output) {
    if (!me) return send(401, { error: "sign in first" });
    const a = core.data.action(output[1]!);
    if (!a || !a.output) return send(404, { error: "no such ad" });
    const creatorMay = a.creator === me.uid;
    const brandMay = a.brand === me.uid && a.status === "released";
    if (!creatorMay && !brandMay) return send(403, { error: "the ad isn't released" });
    const f = rt.store.read(a.output.hash as `0x${string}`);
    return f ? sendFile(res, f) : gone(rt, a.output.hash);
  }

  // ---------------------------------------------------------------- in-app approvals (the creator's ad, the brand's spend)
  if (path.startsWith("/api/approvals/")) {
    if (!me) return send(401, { error: "sign in first" });
    const ap = rt.approvals;
    const actionId = get ? (c.url.searchParams.get("id") ?? "") : String(body.id ?? "");
    try {
      if (get && (path === "/api/approvals/request" || path === "/api/approvals/spend")) {
        ap.d.agent.sweep();
        const a = core.data.action(actionId);
        const creatorView = path === "/api/approvals/request";
        // The creator's review page opened by the request's brand: the brand's side of it, never the creator's controls.
        if (a && creatorView && a.creator !== me.uid && a.brand === me.uid) return send(200, { asBrand: requestForBrand(rt, a) });
        if (!a || (creatorView ? a.creator : a.brand) !== me.uid) return send(404, { error: "no such request" });
        return send(200, { request: creatorView ? requestForCreator(rt, a) : requestForBrand(rt, a) });
      }
      if (post && !csrfOk(c.req)) return send(403, { error: "missing or wrong CSRF token: reload the page" });
      if (post && path === "/api/approvals/decide") {
        const d = body.decision;
        if (d !== "approve" && d !== "reject" && d !== "deny") return send(400, { error: "decision is approve, reject or deny" });
        return send(200, { request: requestForCreator(rt, ap.decide(me.uid, actionId, d, typeof body.outputHash === "string" ? body.outputHash : undefined)) });
      }
      if (post && path === "/api/approvals/spend/decide") {
        const d = body.decision;
        if (d !== "approve" && d !== "deny") return send(400, { error: "decision is approve or deny" });
        return send(200, { request: requestForBrand(rt, ap.decideSpend(me.uid, actionId, d, typeof body.amount === "string" ? body.amount : undefined)) });
      }
    } catch (e) {
      if (e instanceof ApprovalError) return send(e.status, { error: e.message });
      throw e;
    }
    return false;
  }

  // ---------------------------------------------------------------- the caller's creator profile
  if (path.startsWith("/api/facevisa/creator/")) {
    if (!me) return send(401, { error: "sign in first" });
    if (!me.name) return send(409, { error: "set up your account first" });
    core.agent.sweep();
    if (get && path === "/api/facevisa/creator/listing") return send(200, { listing: core.data.listing(me.uid) ?? null, arkiv: arkivStatus(rt, "listing", me.uid), schedule: rt.arkiv?.listingSchedule(me.uid) ?? null });
    // YouTube channel linking (optional): a standalone Google OAuth flow run by this server, then dropped.
    if (post && path === "/api/facevisa/creator/youtube/start") {
      if (!rt.youtube) return send(503, { error: "YouTube linking isn't configured on this server" });
      if (!csrfOk(c.req)) return send(403, { error: "missing or wrong CSRF token: reload the page" });
      rt.onboarding.start(me.uid, me.name);
      return send(200, { url: rt.youtube.start(me.uid) });
    }
    if (post && path === "/api/facevisa/creator/youtube/unlink") {
      if (!rt.youtube) return send(503, { error: "YouTube linking isn't configured on this server" });
      if (!csrfOk(c.req)) return send(403, { error: "missing or wrong CSRF token: reload the page" });
      rt.youtube.unlink(me.uid);
      return send(200, { ok: true });
    }
    // Proof of Presence (B6): World ID's Selfie Check through IDKit, signed and verified here; required to list.
    if (path.startsWith("/api/facevisa/creator/presence")) {
      const pr = rt.presence;
      if (get && path === "/api/facevisa/creator/presence") return send(200, presenceView(rt, me.uid));
      if (!pr) return send(503, { error: "Proof of Presence isn't configured on this server" });
      if (post && !csrfOk(c.req)) return send(403, { error: "missing or wrong CSRF token: reload the page" });
      try {
        if (post && path === "/api/facevisa/creator/presence/start") return send(200, pr.start(me.uid));
        if (post && path === "/api/facevisa/creator/presence/verify") {
          const presence = await pr.verify(me.uid, body.result);
          // Already listed (a demo creator verifying later): the listing's label on Arkiv follows.
          const l = core.data.listing(me.uid);
          if (presence.verified && l) core.data.setListing(me.uid, l.rules);
          return send(200, { presence });
        }
        if (post && path === "/api/facevisa/creator/presence/cancel") {
          pr.cancel(me.uid, String(body.nonce ?? ""), String(body.code ?? "cancelled"));
          return send(200, { ok: true });
        }
      } catch (e) {
        if (e instanceof PresenceError) return send(e.status, { error: e.message, code: e.code });
        throw e;
      }
      return false;
    }
    if (post && path === "/api/facevisa/creator/listing") {
      const row = rt.accounts.creator(me.uid);
      if (!row?.photoFile || !row.consentAt) return send(409, { error: "add your photo (with consent) first" });
      // The World ID check is required to list (and held-for-review or rejected ones can't).
      const pop = rt.presence?.status(me.uid).state;
      if (pop === "review") return send(403, { error: "your Proof of Presence is held for review: you can list once it's cleared", code: "presence_review" });
      if (pop === "rejected") return send(403, { error: "your Proof of Presence wasn't cleared in review, so this World ID can't list", code: "presence_rejected" });
      if (rt.presence && pop !== "verified") return send(403, { error: "complete the World ID check first (Proof of Presence, or Proof of Human)", code: "presence_required" });
      const rules = { bannedCategories: (Array.isArray(body.bannedCategories) ? body.bannedCategories : []) as never[], minPrice: parseUsd(body.minPrice), maxDays: Number(body.maxDays) };
      const problem = rulesProblem(rules);
      if (problem) return send(400, { error: problem });
      return send(200, { listing: core.data.setListing(me.uid, rules), arkiv: arkivStatus(rt, "listing", me.uid) });
    }
    if (post && path === "/api/facevisa/creator/unlist") {
      core.data.unlist(me.uid);
      return send(200, { listing: null });
    }
    if (get && path === "/api/facevisa/creator/requests") {
      const all = core.data.actions({ creator: me.uid });
      // The inbox: requests waiting for review, read from Arkiv's pending requests for this creator's address.
      const inbox = rt.arkivReads
        ? await rt.arkivReads.inbox(me.uid, all)
        : { items: all.filter((a) => a.status === "review" || a.status === "verified").map((a) => ({ id: a.id, source: "facevisa" as const, reviewBy: a.expiresAt, why: "Arkiv is off" })), source: ARKIV_OFF };
      return send(200, { requests: all.map((a) => requestForCreator(rt, a)), inbox });
    }
    if (get && path === "/api/facevisa/creator/licences") return send(200, { licences: core.data.licences({ creator: me.uid }).map((l) => licenceView(rt, l)) });
    if (post && path === "/api/facevisa/creator/revoke") {
      const l = core.data.licence(String(body.licenceId ?? ""));
      if (!l || l.creator !== me.uid) return send(404, { error: "no such licence" });
      if (!core.data.revoke(l.id)) return send(409, { error: "already revoked" });
      core.data.log({ brand: l.brand, actionId: l.actionId, licenceId: l.id, kind: "blocked", summary: `${name(rt, l.creator)} revoked licence ${l.id}: Verify now says Revoked` });
      return send(200, { licence: licenceView(rt, core.data.licence(l.id)!) });
    }
    return false;
  }

  // ---------------------------------------------------------------- the caller's brand workspace (the agent)
  if (path.startsWith("/api/facevisa/agent/")) {
    if (!me) return send(401, { error: "sign in first" });
    if (!me.name) return send(409, { error: "set up your account first" });
    core.agent.sweep();
    if (get && path === "/api/facevisa/agent/activity") {
      return send(200, {
        events: core.data.events(me.uid),
        requests: core.data.actions({ brand: me.uid }).map((a) => requestForBrand(rt, a)),
        licences: core.data.licences({ brand: me.uid }).map((l) => licenceView(rt, l)),
        spentToday: usd(core.data.spentToday(me.uid)),
        aiCallsToday: core.data.aiCallsToday(me.uid),
      });
    }
    if (post && path === "/api/facevisa/agent/shortlist") {
      if (brandUnverified(rt, me.uid)) return send(403, BRAND_CHECK);
      const b: BrandBrief = { brief: String(body.brief ?? "").trim(), category: body.category as never, kind: body.kind as never, durationDays: Number(body.durationDays), maxPrice: parseUsd(body.maxPrice), budget: parseUsd(body.budget) };
      if (!isCategory(b.category) || !isKind(b.kind) || !Number.isInteger(b.durationDays) || b.durationDays < 1 || !(b.maxPrice > 0) || !(b.budget > 0)) return send(400, { error: "give a brief, a category, image or video, a duration, a maximum price and a budget" });
      // Listings from Arkiv (the creators' own entities), falling back to the backend where they aren't confirmed there.
      const sourced = rt.arkivReads && !platformProblems(b.brief).length ? await rt.arkivReads!.shortlistListings(b) : undefined;
      const out = core.agent.shortlist(me.uid, b, sourced?.listings);
      return send(out.problems.length ? 422 : 200, { ...(out.problems.length ? { error: out.problems.join("; ") } : {}), problems: out.problems, budget: usd(out.budget), entries: out.entries.map((e) => ({ ...e, price: usd(e.price), face: faceUrl(rt, e.creator), ...(rt.arkiv ? creatorStatsView(rt, e.creator) : {}), ...(rt.demoState?.seeded(e.creator) ? { seeded: true } : {}) })), source: sourced?.source ?? ARKIV_OFF, ...(sourced ? { query: sourced.queries.fits } : {}) });
    }
    if (post && path === "/api/facevisa/agent/request") {
      if (brandUnverified(rt, me.uid)) return send(403, BRAND_CHECK);
      if (!core.consent) return send(503, { error: "approvals aren't set up on this server" });
      const ask = { brief: String(body.brief ?? "").trim(), category: body.category as never, kind: body.kind as never, durationDays: Number(body.durationDays) };
      if (!isCategory(ask.category) || !isKind(ask.kind)) return send(400, { error: "give a category and image or video" });
      // Images and videos are capped per brand workspace and across the site (the pipeline's daily caps), not per network.
      // Paying over x402: a brand without the USDC for this ad is told before anything is made. Only for an ask the
      // creator's rules allow: a refused ask gets its real reason (from the agent, below), never a payment one.
      const listing = core.data.listing(String(body.creator ?? ""));
      const allowed = listing && !checkAsk(listing.rules, ask).length;
      const payer = rt.payer ?? rt.whitechain;
      const short = allowed && payer ? await payer.shortfall(me.uid, pricePerRender(listing.rules, ask.kind)) : undefined;
      if (short) {
        core.data.log({ brand: me.uid, actionId: null, licenceId: null, kind: "blocked", summary: `request to ${listing!.name} not sent: ${short}` });
        return send(402, { error: short, reasons: [short] });
      }
      try {
        const key = typeof body.requestKey === "string" && body.requestKey.length <= 100 ? body.requestKey : undefined;
        const made = core.agent.request(me.uid, String(body.creator ?? ""), ask, key);
        return send(200, { request: requestForBrand(rt, made) });
      } catch (e) {
        if (e instanceof RequestRefused) return send(e.status, { error: e.message, reasons: e.reasons });
        throw e;
      }
    }
    if (post && path === "/api/facevisa/agent/cancel") {
      return core.agent.cancel(me.uid, String(body.id ?? "")) ? send(200, { ok: true }) : send(409, { error: "this request can't be cancelled" });
    }
    if (post && path === "/api/facevisa/agent/release") {
      try {
        const lic = await core.agent.release(String(body.id ?? ""), me.uid);
        return send(200, { licence: licenceView(rt, lic) });
      } catch (e) {
        if (e instanceof PipelineError) return send(e.status, { error: e.message });
        throw e;
      }
    }
    return false;
  }
  return false;
}
