/**
 * The brand's agent: the one real agent in Likeness. "Agents negotiate. Only the human consents to their face being
 * used."
 *
 * The brand sets a brief, usage (category), duration, a maximum price and a budget. The agent shortlists listed
 * creators with a one-line reason for every pick and skip, and sends requests. A request that fits the creator's
 * rules is generated straight away, but NOT released: the creator reviews the finished ad with a fresh World ID
 * check and approves or rejects it (a rejection regenerates once). Only an approved ad is paid for and released.
 * Every step goes to the brand's Agent activity log; budget limits are enforced here and in the pipeline.
 */
import { createHash } from "node:crypto";
import type { Licence, LikenessData, Listing, PendingAction } from "./data.js";
import { PipelineError, type ConsentCheckpoint, type Pipeline } from "./pipeline.js";
import { checkAsk, platformProblems, pricePerRender, usd, type Category, type Kind, type LicenceAsk } from "./rules.js";

export interface BrandBrief {
  brief: string;
  category: Category;
  kind: Kind;
  durationDays: number;
  /** The most the brand pays for this ad, micro-USD. */
  maxPrice: number;
  /** This campaign's total, micro-USD (also capped by what's left of the brand's daily budget). */
  budget: number;
}

export interface ShortlistEntry {
  creator: string;
  name: string;
  pick: boolean;
  price: number;
  reason: string;
  youtube?: CreatorInfo;
  /** Where the creator's listing came from: their entity on Arkiv, or the backend (not yet confirmed on Arkiv). */
  source?: "arkiv" | "likeness";
  entityKey?: string;
  url?: string;
  why?: string;
  /** With Proof of Presence on: how the creator was verified ("production", "sandbox"), or null (unverified). */
  presence?: string | null;
  /** Which World ID credential: "selfie" (Proof of Presence) or "proof_of_human" (the Orb). */
  credential?: string;
}

/** A listing with where it was read from (arkiv/reads.ts); `fits` is whether Arkiv's query of fitting listings had it. */
export type ShortlistListing = Listing & { source?: "arkiv" | "likeness"; fits?: boolean; entityKey?: string; url?: string; why?: string };

/** What the agent may know about a creator beyond their rules: a verified YouTube channel, if linked. */
export interface CreatorInfo {
  title: string;
  subscribers: number | null;
  topics: string[];
  faceMatch: boolean;
}

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
/** A brief's category fits a channel topic when they share a word ("Fitness" ~ "Physical fitness"). */
const topicFits = (category: string, topics: string[]) => {
  const words = category.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  return topics.some((t) => words.some((w) => t.toLowerCase().includes(w)));
};

/** The request as the brand made it: a different brief, usage, kind, duration or price is a different request. */
export function briefHash(a: { brief: string; category: Category; kind: Kind; price: number; durationDays: number }) {
  return createHash("sha256").update(JSON.stringify([a.brief, a.category, a.kind, a.price, a.durationDays])).digest("hex");
}

export interface BrandAgentDeps {
  data: LikenessData;
  pipeline: Pipeline;
  /** Set after construction (the consent checkpoint calls back into the agent). */
  consent?: ConsentCheckpoint;
  /** Above this price (micro-USD) the brand's own human approves the spend first (task 4); undefined = never. */
  spendLimit?: number;
  licenceDays: number;
  dailyBudget: number;
  /** Generate, pay and release on the agent's own (off in tests that drive each step). */
  autoRun: boolean;
  /**
   * With Proof of Presence on (set by the runtime): the environment a creator's proof came from, or null when they
   * have none. The shortlist then picks only verified creators unless the brand includes unverified ones.
   */
  presenceOf?(uid: string): { environment: string; credential: string } | null;
  /** A creator's verified YouTube channel, if they linked one (set by the runtime). */
  creatorInfo?(uid: string): CreatorInfo | undefined;
  /** Why this brand can't start a billed generation of this kind today (a daily cap), or undefined. */
  aiRoom?(brand: string, kind: Kind): string | undefined;
  creatorName(uid: string): string;
  /**
   * Pays for an approved ad and releases it: the brand agent's x402 client (hedera/payer.ts) when Hedera payments are
   * on; otherwise the pipeline's own rail (DevPayment).
   */
  pay?(actionId: string, brand: string): Promise<Licence>;
}

export class RequestRefused extends Error {
  constructor(
    readonly status: number,
    readonly reasons: string[],
  ) {
    super(reasons.join("; "));
  }
}

export class BrandAgent {
  private readonly recent = new Map<string, { id: string; at: number }>();
  constructor(readonly d: BrandAgentDeps) {}

  private remaining(brand: string) {
    return Math.max(0, this.d.dailyBudget - this.d.data.spentToday(brand));
  }

  /**
   * Every listed creator, picked or skipped, each with one line of why. With `listings` from Arkiv, a creator whose
   * entity wasn't in Arkiv's query of fitting listings is skipped, the reason read from the entity's own columns.
   */
  shortlist(brand: string, b: BrandBrief, listings: ShortlistListing[] = this.d.data.listings()): { problems: string[]; budget: number; entries: ShortlistEntry[] } {
    const problems = platformProblems(b.brief);
    const budget = Math.min(b.budget, this.remaining(brand));
    const entries = listings.map((l): ShortlistEntry => {
      const price = pricePerRender(l.rules, b.kind);
      const pop = this.d.presenceOf ? this.d.presenceOf(l.uid) : undefined;
      const presence = pop === undefined ? undefined : pop ? pop.environment : null;
      const base = { creator: l.uid, name: l.uid === brand ? `${l.name} (you)` : l.name, price, ...(l.source ? { source: l.source } : {}), ...(l.entityKey ? { entityKey: l.entityKey, url: l.url } : {}), ...(l.why ? { why: l.why } : {}), ...(presence !== undefined ? { presence } : {}), ...(pop ? { credential: pop.credential } : {}) };
      // Only creators with a World ID check are picked.
      if (presence === null) return { ...base, pick: false, reason: "skip: no World ID check" };
      if (l.rules.bannedCategories.includes(b.category)) return { ...base, pick: false, reason: `skip: doesn't allow ${b.category}` };
      if (b.durationDays > l.rules.maxDays) return { ...base, pick: false, reason: `skip: licenses ${l.rules.maxDays} days at most, you asked for ${b.durationDays}` };
      if (price > b.maxPrice) return { ...base, pick: false, reason: `skip: ${usd(price)} per ${b.kind} is over your maximum of ${usd(b.maxPrice)}` };
      if (l.fits === false) return { ...base, pick: false, reason: "skip: not among the listings Arkiv returned for this brief" };
      if (price > budget) return { ...base, pick: false, reason: `skip: ${usd(price)} is over the budget left (${usd(budget)})` };
      const yt = this.d.creatorInfo?.(l.uid);
      const channel = yt
        ? `; verified YouTube channel "${yt.title}"${yt.subscribers !== null ? ` (${compact(yt.subscribers)} subscribers)` : ""}${topicFits(b.category, yt.topics) ? `, topic fits ${b.category}` : ""}${yt.faceMatch ? ", face matches channel" : ""}`
        : "";
      return { ...base, pick: true, reason: `pick: allows ${b.category} for ${b.durationDays} days, ${usd(price)} fits the budget${channel}`, ...(yt ? { youtube: yt } : {}) };
    });
    // Picks first; among picks, a channel whose topic fits, then a face-matched channel, then reach, then price.
    const rank = (e: ShortlistEntry) => (e.youtube ? (topicFits(b.category, e.youtube.topics) ? 2 : 0) + (e.youtube.faceMatch ? 1 : 0) : -1);
    entries.sort((x, y) => Number(y.pick) - Number(x.pick) || rank(y) - rank(x) || (y.youtube?.subscribers ?? 0) - (x.youtube?.subscribers ?? 0) || x.price - y.price);
    if (!problems.length) this.d.data.log({ brand, actionId: null, licenceId: null, kind: "shortlisted", summary: `shortlist for "${b.brief.slice(0, 60)}": ${entries.filter((e) => e.pick).length} of ${entries.length} creators fit` });
    return { problems, budget, entries };
  }

  /**
   * A request to one creator: it must fit their rules and the budget. Then the agent generates the ad (not released)
   * for the creator to review.
   */
  request(brand: string, creator: string, ask: LicenceAsk, key?: string): PendingAction {
    // The same click sent twice (a double-click, a retry): its idempotency key returns the request it made, not a
    // second one (a second generation could be billed). Kept in memory for 10 minutes.
    const k = key && `${brand}:${key}`;
    const seen = k ? this.recent.get(k) : undefined;
    if (seen && seen.at > Date.now() - 10 * 60_000) {
      const a = this.d.data.action(seen.id);
      if (a) return a;
    }
    const listing = this.d.data.listing(creator);
    if (!listing) throw new RequestRefused(404, ["this creator isn't listed"]);
    // A request to your own creator profile is allowed, and still waits for the full fresh World ID check.
    const reasons = checkAsk(listing.rules, ask);
    const price = pricePerRender(listing.rules, ask.kind);
    const left = this.remaining(brand);
    if (price > left) reasons.push(`${usd(price)} is over the brand's budget left today (${usd(left)})`);
    const capped = this.d.aiRoom?.(brand, ask.kind);
    if (capped) reasons.push(capped);
    if (reasons.length) {
      this.d.data.log({ brand, actionId: null, licenceId: null, kind: "blocked", summary: `request to ${listing.name} not sent: ${reasons.join("; ")}` });
      throw new RequestRefused(422, reasons);
    }
    const hash = briefHash({ ...ask, price });
    const now = Date.now();
    const a = this.d.data.createAction({ brand, creator, kind: ask.kind, category: ask.category, brief: ask.brief, briefHash: hash, price, durationDays: ask.durationDays, createdAt: now, expiresAt: now + 24 * 3600_000 });
    this.d.data.log({ brand, actionId: a.id, licenceId: null, kind: "requested", summary: `asked ${listing.name} for one ${ask.kind} (${ask.category}, ${ask.durationDays} days) at ${usd(price)}` });
    if (k) {
      this.recent.set(k, { id: a.id, at: now });
      for (const [x, v] of this.recent) if (v.at < now - 10 * 60_000) this.recent.delete(x);
    }
    if (this.d.autoRun) void this.generate(a.id).catch(() => undefined);
    return this.d.data.action(a.id)!;
  }

  /** Generates the ad, then hands it to the creator's consent checkpoint and waits. */
  async generate(actionId: string) {
    const a = await this.d.pipeline.generate(actionId);
    this.d.data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "waiting", summary: `waiting for ${this.d.creatorName(a.creator)} to review and approve the finished ${a.kind} in Likeness (until ${new Date(a.expiresAt).toISOString().slice(11, 16)} UTC)` });
    this.d.consent!.opened(a);
    return this.d.data.action(a.id)!;
  }

  /** The creator rejected the first ad: regenerate once, and the creator reviews the new one. */
  onRejected(actionId: string) {
    const a = this.d.data.action(actionId);
    if (!a) return;
    this.d.data.log({ brand: a.brand, actionId, licenceId: null, kind: "rejected", summary: `${this.d.creatorName(a.creator)} rejected the ${a.kind}; generating a new one (the only regeneration)` });
    if (this.d.autoRun) void this.generate(actionId).catch(() => undefined);
  }

  /** Whether this price needs the brand's own fresh approval first. */
  needsSpendApproval(price: number) {
    return this.d.spendLimit !== undefined && price > this.d.spendLimit;
  }

  /** The creator approved this exact ad: pay and release it on our own (or wait for the brand's spend approval). */
  onApproved(actionId: string) {
    const a = this.d.data.action(actionId);
    if (!a) return;
    this.d.data.log({ brand: a.brand, actionId, licenceId: null, kind: "approved", summary: `${this.d.creatorName(a.creator)} approved this exact ${a.kind}${a.creatorCheck.evidence?.iss === "dev-consent" ? " (DevConsent: local development, approved at once)" : " in Likeness"}` });
    if (a.status === "spend_review") {
      this.d.data.log({ brand: a.brand, actionId, licenceId: null, kind: "spend-check", summary: `${usd(a.price)} is over this workspace's limit of ${usd(this.d.spendLimit!)}: paused until the brand approves the spend in Likeness` });
      return;
    }
    if (this.d.autoRun) this.autoRelease(actionId, a.brand);
  }

  /** The brand's human approved the spend: pay and release. */
  onSpendApproved(actionId: string) {
    const a = this.d.data.action(actionId);
    if (!a) return;
    this.d.data.log({ brand: a.brand, actionId, licenceId: null, kind: "spend-approved", summary: `spend approved by the brand: ${usd(a.price)}` });
    if (this.d.autoRun) this.autoRelease(actionId, a.brand);
  }

  /** Pays for an approved ad and releases it (see `pay`). */
  release(actionId: string, brand: string): Promise<Licence> {
    return this.d.pay ? this.d.pay(actionId, brand) : this.d.pipeline.release(actionId, brand);
  }

  /** After a restart: approved ads the agent hadn't paid for yet are paid now (with autoRun). */
  resume() {
    if (!this.d.autoRun) return;
    for (const a of this.d.data.actions({ status: "approved" })) if (a.expiresAt > Date.now()) this.autoRelease(a.id, a.brand);
  }

  /**
   * The agent paying on its own: a failure is always in the activity log (with its reason), never silent. Nothing is
   * ever paid twice, so "Pay and release" can always try again.
   */
  private autoRelease(actionId: string, brand: string) {
    void this.release(actionId, brand).catch((e: unknown) => {
      if (e instanceof PipelineError && e.logged) return;
      this.d.data.log({ brand, actionId, licenceId: null, kind: "blocked", summary: `paying didn't complete: ${(e as Error).message.split("\n")[0]}; nothing is paid twice, so Pay and release can try again` });
    });
  }

  /** The brand cancels a request it no longer wants (only before it is paid). */
  cancel(brand: string, actionId: string): boolean {
    const a = this.d.data.action(actionId);
    if (!a || a.brand !== brand) return false;
    const ok = this.d.data.transition(actionId, ["generating", "review", "verified", "approved", "spend_review", "spend_verified"], "cancelled", { reason: "cancelled by the brand" });
    if (ok) this.d.data.log({ brand, actionId, licenceId: null, kind: "cancelled", summary: "request cancelled by the brand: nothing released, nothing charged" });
    return ok;
  }

  /** A checkpoint attempt failed (wrong person, invalid token, …): the request keeps waiting until it expires. */
  blocked(a: PendingAction, reason: string, who = this.d.creatorName(a.creator)) {
    this.d.data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "blocked", summary: `checkpoint failed: ${reason}; still waiting for ${who}` });
  }

  /** Ends the wait on requests past their expiry. */
  sweep() {
    for (const a of this.d.data.expireDue()) {
      this.d.data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "expired", summary: `the request expired before it was approved and paid: nothing released, nothing charged` });
    }
  }
}
