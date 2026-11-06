/**
 * What FaceVisa puts on Arkiv: seven entity types (listing, request, licence, receipt, revocation, and each
 * creator's and brand's running stats), each a named schema in this app's namespace, and the only
 * functions that turn backend records into entity values. Public state only: no photos, ad files, brief text,
 * World ID subjects or evidence, emails or keys. People appear as their account addresses (custodial keys from the
 * keystore), briefs as their sha256.
 *
 * Every entity carries `app` (ARKIV_SCHEMA_PREFIX), `type` and `ref` (the outbox item that created it, so a retry can
 * find it by owner and ref instead of creating it twice). Only the columns queries filter on are indexed.
 */
import { addr, bool, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema";
import type { Hex } from "viem";
import { CATEGORIES, type Category, type CreatorRules, type Kind } from "../facevisa/rules.js";

export type EntityKind = "listing" | "request" | "licence" | "receipt" | "revocation" | "creator_stats" | "brand_stats";
/**
 * How the person who approved signed in: "dev" (the local dev sign-in, or DevConsent), "demo" (the public demo),
 * "world-id" (World ID sign-in, only with WORLDID_SIGNIN=1), or "standin" (older entities: the dev sign-in's old label).
 */
export type Identity = "world-id" | "standin" | "demo" | "dev" | "google";
export type RequestStatus = "pending" | "approved" | "rejected" | "denied" | "cancelled" | "failed";

/** One indexed boolean per category a creator can refuse ("Food & drink" → banned_food_drink). */
export const bannedAttr = (c: Category) => `banned_${c.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;

export function arkivSchemas(prefix: string) {
  const ns = { app: str().indexed(), type: str().indexed(), ref: str().indexed() };
  return {
    listing: defineSchema(`${prefix}.listing`, {
      ...ns,
      status: str().indexed(), // listed | unlisted
      price: u64().indexed(), // per image, micro-USDC; a video is 3×
      max_days: u64().indexed(),
      banned_fashion: bool().indexed(),
      banned_beauty: bool().indexed(),
      banned_food_drink: bool().indexed(),
      banned_alcohol: bool().indexed(),
      banned_gambling: bool().indexed(),
      banned_finance_crypto: bool().indexed(),
      banned_tech: bool().indexed(),
      banned_travel: bool().indexed(),
      banned_fitness: bool().indexed(),
      banned_other: bool().indexed(),
      display_name: str().indexed(),
      has_capture: bool().indexed(),
      identity: str().indexed(),
      // Proof of Presence: "production" (World ID), "sandbox"/"staging" (World ID's test environments, labelled), or
      // "none" (an unverified demo creator). Absent on listings written before it existed.
      presence: str().indexed().optional(),
      // Which World ID credential: "selfie" (Proof of Presence) or "proof_of_human" (the Orb). Absent without one.
      credential: str().indexed().optional(),
    }),
    request: defineSchema(`${prefix}.request`, {
      ...ns,
      brand: addr().indexed(),
      creator: addr().indexed(),
      kind: str().indexed(),
      brief_hash: str(),
      price: u64().indexed(),
      status: str().indexed(),
      output_hash: str().indexed().optional(),
    }),
    licence: defineSchema(`${prefix}.licence`, {
      ...ns,
      output_hash: str().indexed(),
      brand: addr().indexed(),
      creator: addr().indexed(),
      usage: str().indexed(),
      kind: str(),
      duration_days: u64(),
      price: u64(),
      approved_at: u64(), // unix seconds
      request_key: key().optional(),
      licence_id: str(),
      identity: str().indexed(),
      status: str().indexed(), // active | revoked
    }),
    receipt: defineSchema(`${prefix}.receipt`, {
      ...ns,
      file_hash: str().indexed(),
      licence_key: key().indexed(),
      // So a receipt alone answers: whose licence (its owner must be this key) and until when (after the licence
      // entity has expired and gone).
      creator: addr().indexed(),
      licence_expires_at: u64(), // unix seconds
      licence_id: str(),
      provider: str(),
      model: str(),
      job_id: str().optional(),
      payment_ref: str(),
      // Labelled like identity: "dev" is a test payment (DevPayment), no money moved.
      payment_rail: str().optional(),
      // The wallet that paid (Whitechain: the brand workspace's own wallet), so a verifier can check the payer on chain.
      payer: addr().optional(),
      // What made the ad (0g, vertex, 0g+vertex for a video's still and clip, or test), indexed so it can be queried.
      generator: str().indexed().optional(),
      // The creator's World ID check when the ad was released: production | sandbox | none, and which credential.
      world_id: str().indexed().optional(),
      world_id_credential: str().optional(),
      // The ad file on Swarm: its reference (a content address, 64 hex digits). When swarm_encrypted is true it's the
      // address of ciphertext, whose key is sealed to the brand and the creator and never on Arkiv.
      swarm_ref: str().optional(),
      swarm_encrypted: bool().optional(),
      // The face gate on the released file: passed | not-run, and the score in thousandths (0.570 → 570).
      face_check: str().optional(),
      face_score: u64().optional(),
    }),
    // The creator's own record that they revoked a licence: read-only, the longest lifetime, so "Revoked on <date>"
    // outlives the licence entity (which Arkiv deletes at the licence's end).
    revocation: defineSchema(`${prefix}.revocation`, {
      ...ns,
      licence_key: key().indexed(),
      file_hash: str().indexed(),
      creator: addr().indexed(),
      revoked_at: u64(), // unix seconds
      licence_id: str(),
    }),
    // A creator's running numbers, owned by the creator's own key: patched on every listing, licence and payment
    // change, renewed while they're active. Numbers, addresses and times only. Counters are indexed so anyone can
    // query, e.g. "creators with more than 5 approved ads": ads_approved > u64(5).
    creator_stats: defineSchema(`${prefix}.creator_stats`, {
      ...ns,
      creator: addr().indexed(),
      ads_approved: u64().indexed(), // every licence ever approved and released (active, revoked or ended)
      active_licences: u64().indexed(),
      revoked: u64().indexed(),
      earned_usdt: u64().indexed(), // USDT's smallest units (6 decimals), settled on Whitechain
      brands: u64().indexed(), // distinct brands that licensed this face
      first_listed: u64().optional(), // unix seconds
      last_active: u64().indexed(), // unix seconds: the latest listing, licence or revocation
    }),
    // A brand's running numbers, owned by the brand's account key.
    brand_stats: defineSchema(`${prefix}.brand_stats`, {
      ...ns,
      brand: addr().indexed(),
      ads_licensed: u64().indexed(),
      active_licences: u64().indexed(),
      spent_usdt: u64().indexed(), // USDT's smallest units, settled on Whitechain
      creators: u64().indexed(), // distinct creators licensed
      last_active: u64().indexed(), // unix seconds
    }),
  };
}
export type ArkivSchemas = ReturnType<typeof arkivSchemas>;

/** Plain values as the outbox stores and diffs them (JSON-safe), before they're typed for the SDK. */
export type Plain = Record<string, string | number | boolean>;

/** A str column holds at most 128 bytes: cut on a character boundary. */
export function fit(s: string, bytes = 128): string {
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

const ns = (prefix: string, type: EntityKind, ref: string) => ({ app: prefix, type, ref });

export function listingValues(prefix: string, ref: string, l: { listed: boolean; rules: CreatorRules; displayName: string; hasCapture: boolean; identity: Identity; presence?: string; credential?: string | null }): Plain {
  return {
    ...ns(prefix, "listing", ref),
    status: l.listed ? "listed" : "unlisted",
    price: l.rules.minPrice,
    max_days: l.rules.maxDays,
    ...Object.fromEntries(CATEGORIES.map((c) => [bannedAttr(c), l.rules.bannedCategories.includes(c)])),
    display_name: fit(l.displayName.trim() || "Creator"),
    has_capture: l.hasCapture,
    identity: l.identity,
    ...(l.presence ? { presence: l.presence } : {}),
    ...(l.credential ? { credential: l.credential } : {}),
  };
}

export function requestValues(prefix: string, ref: string, r: { brand: Hex; creator: Hex; kind: Kind; briefHash: string; price: number; status: RequestStatus; outputHash: string | null }): Plain {
  return {
    ...ns(prefix, "request", ref),
    brand: r.brand,
    creator: r.creator,
    kind: r.kind,
    brief_hash: r.briefHash,
    price: r.price,
    status: r.status,
    ...(r.outputHash ? { output_hash: r.outputHash.toLowerCase() } : {}),
  };
}

export function licenceValues(
  prefix: string,
  ref: string,
  l: { outputHash: string; brand: Hex; creator: Hex; usage: Category; kind: Kind; durationDays: number; price: number; approvedAt: number; requestKey: Hex | null; licenceId: string; identity: Identity; status: "active" | "revoked" },
): Plain {
  return {
    ...ns(prefix, "licence", ref),
    output_hash: l.outputHash.toLowerCase(),
    brand: l.brand,
    creator: l.creator,
    usage: l.usage,
    kind: l.kind,
    duration_days: l.durationDays,
    price: l.price,
    approved_at: Math.floor(l.approvedAt / 1000),
    ...(l.requestKey ? { request_key: l.requestKey } : {}),
    licence_id: l.licenceId,
    identity: l.identity,
    status: l.status,
  };
}

export function receiptValues(
  prefix: string,
  ref: string,
  r: { fileHash: string; licenceKey: Hex; creator: Hex; licenceExpiresAt: number; licenceId: string; provider: string; model: string; jobId: string | null; paymentRef: string; paymentRail?: string | null; payer?: string | null; generator?: string | null; worldId?: string | null; worldIdCredential?: string | null; swarmRef?: string | null; swarmEncrypted?: boolean | null; faceCheck?: string | null; faceScore?: number | null },
): Plain {
  return {
    ...ns(prefix, "receipt", ref),
    file_hash: r.fileHash.toLowerCase(),
    licence_key: r.licenceKey,
    creator: r.creator,
    licence_expires_at: Math.floor(r.licenceExpiresAt / 1000),
    licence_id: r.licenceId,
    provider: fit(r.provider),
    model: fit(r.model),
    ...(r.jobId ? { job_id: fit(r.jobId) } : {}),
    payment_ref: fit(r.paymentRef),
    ...(r.paymentRail ? { payment_rail: fit(r.paymentRail) } : {}),
    ...(r.payer && /^0x[0-9a-fA-F]{40}$/.test(r.payer) ? { payer: r.payer.toLowerCase() as Hex } : {}),
    ...(r.generator ? { generator: fit(r.generator, 32) } : {}),
    ...(r.worldId ? { world_id: fit(r.worldId, 32) } : {}),
    ...(r.worldIdCredential ? { world_id_credential: fit(r.worldIdCredential, 32) } : {}),
    // Only a plain 64-hex reference: a longer (Swarm-encrypted) one carries its key and is never published.
    ...(r.swarmRef && /^[0-9a-f]{64}$/.test(r.swarmRef) ? { swarm_ref: r.swarmRef, swarm_encrypted: !!r.swarmEncrypted } : {}),
    ...(r.faceCheck ? { face_check: r.faceCheck } : {}),
    ...(typeof r.faceScore === "number" ? { face_score: Math.round(Math.max(0, r.faceScore) * 1000) } : {}),
  };
}

export function revocationValues(prefix: string, ref: string, r: { licenceKey: Hex; fileHash: string; creator: Hex; revokedAt: number; licenceId: string }): Plain {
  return { ...ns(prefix, "revocation", ref), licence_key: r.licenceKey, file_hash: r.fileHash.toLowerCase(), creator: r.creator, revoked_at: Math.floor(r.revokedAt / 1000), licence_id: r.licenceId };
}

/** A creator's or brand's stats, as the data layer counts them (times in ms). */
export interface CreatorStats { adsApproved: number; activeLicences: number; revoked: number; earnedUsdt: number; brands: number; firstListed: number | null; lastActive: number }
export interface BrandStats { adsLicensed: number; activeLicences: number; spentUsdt: number; creators: number; lastActive: number }

const secs = (ms: number) => Math.floor(ms / 1000);

export function creatorStatsValues(prefix: string, ref: string, creator: Hex, st: CreatorStats): Plain {
  return {
    ...ns(prefix, "creator_stats", ref),
    creator,
    ads_approved: st.adsApproved,
    active_licences: st.activeLicences,
    revoked: st.revoked,
    earned_usdt: st.earnedUsdt,
    brands: st.brands,
    ...(st.firstListed ? { first_listed: secs(st.firstListed) } : {}),
    last_active: secs(st.lastActive),
  };
}

export function brandStatsValues(prefix: string, ref: string, brand: Hex, st: BrandStats): Plain {
  return {
    ...ns(prefix, "brand_stats", ref),
    brand,
    ads_licensed: st.adsLicensed,
    active_licences: st.activeLicences,
    spent_usdt: st.spentUsdt,
    creators: st.creators,
    last_active: secs(st.lastActive),
  };
}

/** Every u64 column, across entity types (typed for writes here, and for query values in chain.ts). */
export const U64_KEYS = new Set(["price", "max_days", "duration_days", "approved_at", "licence_expires_at", "revoked_at", "face_score", "ads_approved", "active_licences", "revoked", "earned_usdt", "brands", "first_listed", "last_active", "ads_licensed", "spent_usdt", "creators"]);

/** Plain values typed for the SDK: addresses, keys and integers by column type; strings and booleans as they are. */
export function typed(v: Plain): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (["brand", "creator", "payer"].includes(k)) out[k] = addr(x as Hex);
    else if (["request_key", "licence_key"].includes(k)) out[k] = key(x as Hex);
    else if (U64_KEYS.has(k)) out[k] = u64(x as number);
    else out[k] = x;
  }
  return out;
}

/** What a patch must send to turn `before` into `after`: the columns that changed, and those to remove. */
export function changed(before: Plain, after: Plain): { set: Plain; unset: string[] } {
  return { set: Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v)), unset: Object.keys(before).filter((k) => !(k in after)) };
}
