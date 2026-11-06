/**
 * Health and preflight: each integration's state, with clear warnings on what would stop a demo (low balances, an
 * unreachable network, a stuck outbox). `GET /api/health` (local development only) and the startup preflight both
 * use it. Every check has its own timeout and reports its own error: one slow network never hides the others.
 * Nothing secret is returned: key files are "present" or not, addresses and balances only.
 */
import { formatEther } from "viem";
import { mediaChoices } from "../ai/media.js";
import { assertVertexAllowed, vertexStatus } from "../ai/vertex.js";
import { zeroGConfigFromEnv } from "../ai/zerog.js";
import { X402_NETWORK } from "../hedera/x402.js";
import type { Runtime } from "./runtime.js";

export type Level = "ok" | "warn" | "error" | "off";
export interface Check {
  level: Level;
  summary: string;
  detail?: Record<string, unknown>;
}
export interface Health {
  at: string;
  mode: string;
  ok: boolean;
  warnings: string[];
  checks: Record<"identity" | "arkiv" | "hedera" | "zerog" | "vertex" | "caps", Check>;
}

/** Below these, a demo is at risk. */
export const THRESHOLDS = { funderTglm: 0.5, operatorHbar: 20, brandUsdc: 1 };

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms / 1000} s`)), ms).unref())]);
const fail = (e: unknown): Check => ({ level: "error", summary: (e as Error).message.split("\n")[0]!.slice(0, 200) });

async function identity(rt: Runtime): Promise<Check> {
  const consent = rt.core.consent?.name ?? "none";
  if (rt.standin) return { level: "warn", summary: `dev sign-in (test identities, local development only); approvals: ${consent}`, detail: { mode: "dev", consent } };
  if (rt.demo && rt.google) return { level: "ok", summary: `PUBLIC DEMO: Google sign-in (demo identities retired; the demo's limits, top-ups and retention apply); approvals: ${consent}`, detail: { mode: "google", consent } };
  if (rt.demo) return { level: "warn", summary: `PUBLIC DEMO: demo identities (test, labelled "demo")${rt.worldId ? `, and World ID sign-in (${rt.worldId.issuer}, WORLDID_SIGNIN=1)` : ""}; approvals: ${consent}`, detail: { mode: "demo", worldId: rt.worldId?.issuer ?? null, consent } };
  if (rt.worldId) return { level: "ok", summary: `World ID sign-in (${rt.worldId.issuer}, WORLDID_SIGNIN=1); approvals: ${consent}`, detail: { mode: "world-id", issuer: rt.worldId.issuer, consent } };
  return { level: "error", summary: "no sign-in configured (the dev sign-in, the public demo, or WORLDID_SIGNIN=1)", detail: { mode: "none", consent } };
}

async function arkiv(rt: Runtime): Promise<Check> {
  if (!rt.arkiv || !rt.keystore) return { level: "off", summary: "Arkiv is off (ARKIV_ENABLED)" };
  const sync = rt.arkiv;
  const funder = rt.keystore.platformKey("funder").address;
  const outbox = sync.counts();
  try {
    const [chainId, bal] = await within(10_000, Promise.all([sync.client.chainId(), sync.client.balance(funder)]));
    const tglm = Number(formatEther(bal));
    const stuck = (outbox.failed ?? 0) + (outbox.uncertain ?? 0);
    const level: Level = tglm < THRESHOLDS.funderTglm || stuck ? "warn" : "ok";
    return {
      level,
      summary: `chain ${chainId}, namespace ${sync.prefix}; funder ${tglm.toFixed(3)} tGLM${tglm < THRESHOLDS.funderTglm ? ` (LOW: under ${THRESHOLDS.funderTglm})` : ""}; outbox ${outbox.pending ?? 0} pending${stuck ? `, ${stuck} failed or uncertain` : ""}`,
      detail: { chainId, namespace: sync.prefix, funder, funderTglm: tglm, outbox },
    };
  } catch (e) {
    return { ...fail(e), summary: `Arkiv unreachable: ${fail(e).summary} (writes wait in the outbox: ${outbox.pending ?? 0} pending)`, detail: { namespace: sync.prefix, funder, outbox } };
  }
}

/** Swarm: the Bee node ready, the postage batch usable, and how long it has left (a warning under 2 days). */
async function swarm(rt: Runtime): Promise<Check> {
  if (!rt.swarm) return { level: "off", summary: "Swarm is off (SWARM_BEE_URL, SWARM_BATCH_ID): released ads aren't uploaded" };
  const h = await within(15_000, rt.swarm.health());
  if (h.error || !h.batch) return { level: "warn", summary: `Swarm: ${h.error ?? "no batch"}` };
  const days = h.batch.ttlSeconds / 86_400;
  const what = `node ${h.ready ? "ready" : "NOT READY"}; batch ${rt.swarm.d.config.batchId.slice(0, 8)}… ${h.batch.usable ? "usable" : "NOT USABLE"}, ${days.toFixed(1)} days left${h.batch.depth ? `, depth ${h.batch.depth}` : ""}`;
  return { level: h.ready && h.batch.usable && days >= 2 ? "ok" : "warn", summary: what };
}

/** Whitechain payments: the relayer's gas (a warning when low), the operator's balances, the settlement contract. */
async function whitechain(rt: Runtime): Promise<Check> {
  if (!rt.whitechain) return { level: "off", summary: rt.payments === "hedera" ? "Whitechain is off (PAYMENTS=hedera)" : "Whitechain payments are off (WHITECHAIN_SETTLEMENT): payments are DevPayment, no money moves" };
  const s = await within(20_000, rt.whitechain.status());
  const warn: string[] = [];
  if (s.relayer.low) warn.push(`the relayer ${s.relayer.address} has ${Number(s.relayer.wbt).toFixed(4)} WBT (LOW: top it up from the faucet)`);
  if (!s.relayer.matchesContract) warn.push("the contract's relayer isn't this server's relayer key");
  if (s.contract.paused) warn.push("the settlement contract is PAUSED");
  if (s.operator && Number(s.operator.usdt) < 1) warn.push(`the operator ${s.operator.address} has ${s.operator.usdt} USDT (LOW: demo top-ups need it)`);
  return { level: warn.length ? "warn" : "ok", summary: warn.length ? warn.join("; ") : `settlement ${s.contract.address} (caps ${s.contract.maxPerPayment}/payment, ${s.contract.maxPerDay}/day); relayer ${Number(s.relayer.wbt).toFixed(4)} WBT${s.operator ? `; operator ${s.operator.usdt} USDT, ${Number(s.operator.wbt).toFixed(4)} WBT` : ""}`, detail: s };
}

async function hedera(rt: Runtime): Promise<Check> {
  if (!rt.hedera || !rt.x402) return { level: "off", summary: rt.payments === "whitechain" ? "Hedera x402 is off (payments are on Whitechain; PAYMENTS=hedera to use it)" : "Hedera x402 is off (PAYMENTS=hedera): payments are DevPayment, no money moves" };
  const h = rt.hedera;
  const warn: string[] = [];
  const detail: Record<string, unknown> = { network: X402_NETWORK, usdc: h.config.usdc };
  try {
    const supported = await within(10_000, rt.x402.d.facilitator.getSupported());
    const kind = supported.kinds.find((k) => k.network === X402_NETWORK && k.scheme === "exact");
    detail.facilitator = kind ? { reachable: true, feePayer: kind.extra?.feePayer ?? null } : { reachable: true, supportsHederaTestnet: false };
    if (!kind) warn.push("the facilitator doesn't list hedera:testnet");
  } catch (e) {
    detail.facilitator = { reachable: false, error: fail(e).summary };
    warn.push(`facilitator unreachable (${fail(e).summary})`);
  }
  try {
    const op = await within(10_000, h.operator());
    detail.operator = { account: op.accountId, hbar: op.hbar };
    if (op.hbar < THRESHOLDS.operatorHbar) warn.push(`operator ${op.accountId} has ${op.hbar.toFixed(2)} HBAR (LOW: under ${THRESHOLDS.operatorHbar})`);
  } catch (e) {
    warn.push(`operator: ${fail(e).summary}`);
  }
  // Every brand that has a Hedera account: its USDC (what the agent pays with).
  const brands = rt.accounts.db.prepare("select uid, name, hedera_account_id as acct from accounts where role = 'brand' and hedera_account_id is not null").all() as { uid: string; name: string; acct: string }[];
  const balances: Record<string, unknown>[] = [];
  for (const b of brands) {
    try {
      const units = await within(8_000, h.usdcUnits(b.acct));
      const usdc = units === null ? null : Number(units) / 1e6;
      balances.push({ name: b.name, account: b.acct, usdc });
      if (usdc === null) warn.push(`${b.name} ${b.acct} isn't associated with USDC`);
      else if (usdc < THRESHOLDS.brandUsdc) warn.push(`${b.name} ${b.acct} has ${usdc.toFixed(2)} USDC (LOW: under ${THRESHOLDS.brandUsdc})`);
    } catch (e) {
      balances.push({ name: b.name, account: b.acct, error: fail(e).summary });
    }
  }
  detail.brands = balances;
  detail.audit = rt.audit?.status() ?? null;
  const facilitatorDown = (detail.facilitator as { reachable?: boolean } | undefined)?.reachable === false;
  return { level: facilitatorDown ? "error" : warn.length ? "warn" : "ok", summary: warn.length ? warn.join("; ") : `facilitator up, operator funded, ${balances.length} brand${balances.length === 1 ? "" : "s"} funded`, detail };
}

async function zerog(rt: Runtime): Promise<Check> {
  const m = (() => {
    try {
      return mediaChoices();
    } catch (e) {
      return { image: "?", video: "?", error: (e as Error).message };
    }
  })();
  const uses = m.image === "0g" || m.video === "0g";
  let config;
  try {
    config = zeroGConfigFromEnv(rt.root);
  } catch (e) {
    return { level: "error", summary: `0G key file: ${fail(e).summary}`, detail: { media: m } };
  }
  const detail: Record<string, unknown> = { media: { image: m.image, video: m.video }, keyPresent: !!config };
  if (!uses) return { level: config ? "ok" : "off", summary: `not used (images ${m.image}, video ${m.video}); key ${config ? "present" : "absent"}`, detail };
  if (!config) return { level: "error", summary: "0G is selected but the key file is missing (.secrets/zerog-api-key)", detail };
  // The balance needs a read-only management key (mk-, account:read); optional.
  const mgmt = zeroGConfigFromEnv(rt.root, { ...process.env, ZEROG_API_KEY_FILE: process.env.ZEROG_MGMT_KEY_FILE || ".secrets/zerog-mgmt-key" }, "mk-");
  if (!mgmt) return { level: "ok", summary: `key present; images ${m.image}, video ${m.video}; balance not shown (no read-only mk- key in .secrets/zerog-mgmt-key)`, detail };
  try {
    const r = await within(10_000, fetch(`${mgmt.baseUrl}/account/balance`, { headers: { authorization: `Bearer ${mgmt.apiKey}` } }));
    const b = (await r.json()) as { total_balance?: string; credit_balance?: string; deposit_balance?: string };
    detail.balance = r.ok ? b : { error: `HTTP ${r.status}` };
    return { level: r.ok ? "ok" : "warn", summary: r.ok ? `key present; balance ${b.total_balance ?? "?"} (credit ${b.credit_balance ?? "?"}, deposit ${b.deposit_balance ?? "?"})` : `balance unreadable (HTTP ${r.status})`, detail };
  } catch (e) {
    return { level: "warn", summary: `balance unreadable: ${fail(e).summary}`, detail };
  }
}

async function vertex(): Promise<Check> {
  try {
    assertVertexAllowed();
  } catch (e) {
    return fail(e);
  }
  const s = vertexStatus();
  return s.on ? { level: "ok", summary: `on, project ${s.project} (guard passed: not another submission's project)`, detail: { project: s.project } } : { level: "off", summary: s.reason };
}

function caps(rt: Runtime): Check {
  const c = rt.core.aiCaps;
  const brands = rt.accounts.db.prepare("select uid, name from accounts where role = 'brand'").all() as { uid: string; name: string }[];
  const site = brands.length ? rt.core.data.aiCallsToday(brands[0]!.uid).site : { image: 0, video: 0 };
  const per = brands.map((b) => ({ name: b.name, ...rt.core.data.aiCallsToday(b.uid).brand }));
  const full = site.image >= c.site.image || site.video >= c.site.video;
  return {
    level: full ? "warn" : "ok",
    summary: `billed today (UTC): site ${site.image}/${c.site.image} images, ${site.video}/${c.site.video} videos${full ? " (a site cap is reached)" : ""}; billed now: ${rt.core.ai.billed ? rt.core.ai.name : "no (test renders)"}`,
    detail: { caps: c, site, brands: per, provider: rt.core.ai.name },
  };
}

export async function health(rt: Runtime): Promise<Health> {
  const [id, ark, wc, hed, zg, vx, sw] = await Promise.all([identity(rt), arkiv(rt).catch(fail), whitechain(rt).catch(fail), hedera(rt).catch(fail), zerog(rt).catch(fail), vertex(), swarm(rt).catch(fail)]);
  const checks = { identity: id, arkiv: ark, swarm: sw, whitechain: wc, hedera: hed, zerog: zg, vertex: vx, caps: caps(rt) };
  const warnings = Object.entries(checks).filter(([, c]) => c.level === "warn" || c.level === "error").map(([k, c]) => `${k}: ${c.summary}`);
  return { at: new Date().toISOString(), mode: rt.mode, ok: !Object.values(checks).some((c) => c.level === "error"), warnings, checks };
}

/** The startup preflight: one line per integration, warnings marked. Never throws. */
export async function preflight(rt: Runtime, log: (s: string) => void = console.log) {
  try {
    const h = await health(rt);
    const mark: Record<Level, string> = { ok: "ok  ", warn: "WARN", error: "FAIL", off: "off " };
    log(`[preflight] ${h.ok ? "ready" : "NOT READY"}${h.warnings.length ? `, ${h.warnings.length} warning${h.warnings.length === 1 ? "" : "s"}` : ""}`);
    for (const [k, c] of Object.entries(h.checks)) log(`[preflight] ${mark[c.level]} ${k.padEnd(8)} ${c.summary}`);
  } catch (e) {
    log(`[preflight] failed: ${(e as Error).message.split("\n")[0]}`);
  }
}
