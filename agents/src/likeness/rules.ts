/**
 * Creator rules: the creator's side of every deal ("Agents negotiate. Only the human consents to their face being
 * used."). There is no creator agent: a request either fits the creator's rules and waits for the creator's own
 * decision, or it never reaches them. The platform's banned uses (filter.ts) apply on top, for everyone.
 *
 * Money is integer micro-USD (6 decimals, like USDC) so nothing is lost to floating point.
 */
import { ruleCheck } from "../ai/filter.js";

/** What an ad is for. A creator can refuse any of these; the platform's banned uses are refused for everyone. */
export const CATEGORIES = ["Fashion", "Beauty", "Food & drink", "Alcohol", "Gambling", "Finance & crypto", "Tech", "Travel", "Fitness", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Kind = "image" | "video";

/** A video costs this many times the creator's per-image price (an 8 s clip is more of their likeness). */
export const VIDEO_MULTIPLIER = 3;
/**
 * The longest licence a creator can allow, in days. 180 so that Arkiv itself ends every licence: an entity lives at
 * most 7,884,000 blocks (~182.5 days) from its create or extension.
 */
export const MAX_DAYS_LIMIT = 180;
export const MAX_PRICE_MICRO = 5_000_000; // $5.00 per render: a demo ceiling

export interface CreatorRules {
  /** Categories this creator refuses. */
  bannedCategories: Category[];
  /** Their price per image render, micro-USD; a video is VIDEO_MULTIPLIER times it. Nobody pays less. */
  minPrice: number;
  /** The longest licence they allow for one ad, in days. */
  maxDays: number;
}

export interface LicenceAsk {
  brief: string;
  category: Category;
  kind: Kind;
  /** How long the brand may use the ad, in days. */
  durationDays: number;
}

export const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro % 10_000 === 0 ? 2 : 4)}`;
export const parseUsd = (v: unknown): number => {
  const s = String(v ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(s)) return NaN;
  const [i, f = ""] = s.split(".");
  return Number(i) * 1e6 + Number(f.padEnd(6, "0"));
};

export const isCategory = (v: unknown): v is Category => CATEGORIES.includes(v as Category);

/** Validates rules a creator submits; returns the problem, or undefined. */
export function rulesProblem(r: { bannedCategories: unknown; minPrice: number; maxDays: number }): string | undefined {
  if (!Array.isArray(r.bannedCategories) || !r.bannedCategories.every(isCategory)) return "banned categories must come from the list";
  if (r.bannedCategories.length >= CATEGORIES.length) return "allow at least one category";
  if (!Number.isInteger(r.minPrice) || r.minPrice <= 0 || r.minPrice > MAX_PRICE_MICRO) return `the price must be above $0 and at most ${usd(MAX_PRICE_MICRO)} per render`;
  if (!Number.isInteger(r.maxDays) || r.maxDays < 1 || r.maxDays > MAX_DAYS_LIMIT) return `the longest licence is 1 to ${MAX_DAYS_LIMIT} days`;
  return undefined;
}

/** The price per render for this kind, under these rules. */
export const pricePerRender = (rules: CreatorRules, kind: Kind) => rules.minPrice * (kind === "video" ? VIDEO_MULTIPLIER : 1);

/** The platform's banned uses (political, adult, minors, impersonation, deception), for every brief. */
export function platformProblems(brief: string): string[] {
  const out: string[] = [];
  if (brief.trim().length < 3) out.push("the brief is empty");
  if (brief.length > 600) out.push("the brief is longer than 600 characters");
  out.push(...ruleCheck(brief).map((h) => `banned use: ${h}`));
  return out;
}

/**
 * Does this ask fit the creator's rules? Every reason it doesn't, in words a brand understands. An empty list
 * means the request may go to the creator, who still decides.
 */
export function checkAsk(rules: CreatorRules, ask: LicenceAsk): string[] {
  const out = platformProblems(ask.brief);
  if (rules.bannedCategories.includes(ask.category)) out.push(`the creator doesn't allow ${ask.category}`);
  if (!Number.isInteger(ask.durationDays) || ask.durationDays < 1) out.push("ask for at least one day");
  else if (ask.durationDays > rules.maxDays) out.push(`${ask.durationDays} days is longer than the creator allows (${rules.maxDays} days)`);
  // Listings saved before the 180-day cap may still allow more.
  else if (ask.durationDays > MAX_DAYS_LIMIT) out.push(`${ask.durationDays} days is longer than any licence can last (${MAX_DAYS_LIMIT} days)`);
  return out;
}
