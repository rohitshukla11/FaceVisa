/**
 * FaceVisa's own flow (the agents backend's /api/facevisa and /api/approvals routes): types and fetch helpers.
 * Every call carries our HttpOnly session cookie; every POST also sends the session's CSRF token (from /api/me) as
 * x-csrf-token.
 */
import { post, SERVER_DOWN } from "./api";

export type Kind = "image" | "video";
export type ActionStatus = "generating" | "review" | "verified" | "approved" | "spend_review" | "spend_verified" | "paying" | "released" | "denied" | "expired" | "cancelled" | "failed";

/** A record's mirror on Arkiv (the backend's outbox): synced with its entity, pending, failed, or off. */
export type ArkivSync =
  | { state: "off" }
  | { state: "synced"; entityKey: string; url: string; txHash: string }
  | { state: "pending"; entityKey?: string; url?: string; note?: string }
  | { state: "failed"; error: string; entityKey?: string; url?: string }
  | { state: "none"; note?: string };

/** Where a screen's data came from: read from Arkiv, or the backend (not yet confirmed on Arkiv, and why). */
export type DataSource = { from: "arkiv"; namespace: string; entities: number; fallback: number; note?: string } | { from: "facevisa"; why: string };

/** A request in the creator's inbox: from its entity on Arkiv (with Arkiv's review deadline) or from the backend. */
export interface InboxItem {
  id: string;
  source: "arkiv" | "facevisa";
  reviewBy: number;
  entityKey?: string;
  url?: string;
  why?: string;
}

/** What Verify read from Arkiv: the receipt (the receipt key's) and its licence (the creator's key's). */
export interface VerifyOnArkiv {
  reachable: boolean;
  error?: string;
  receipt?: { key: string; url: string; owner: string; ownerOk: boolean; creator?: string; licenceEndsAt?: number };
  licence?: { key: string; url: string; owner: string; ownerOk: boolean; status: string; expiresAt: number; identity: string; licenceId: string };
  /** The licence entity has expired and is gone; the receipt records when it ended. */
  licenceEndedAt?: number;
  /** The creator's display name, from their own listing entity on Arkiv. */
  creatorName?: string;
  /** The creator's revocation record (outlives the licence entity). */
  revocation?: { key: string; url: string; owner: string; revokedAt: number };
  verdict?: "Licensed" | "Revoked" | "Expired";
  problems: string[];
  note?: string;
}

export interface Meta {
  categories: string[];
  videoMultiplier: number;
  maxDays: number;
  consent: "dev" | "in-app" | null;
  ai: string;
  reviewTtlMinutes: number;
  spendLimit: string | null;
  devTools: boolean;
  /** The public demo (demo identities), when the backend runs it. */
  publicDemo?: { retentionHours: number; perVisitor: { identity: number } | null } | null;
  /** World ID sign-in: only with WORLDID_SIGNIN=1 (off by default). */
  worldIdSignIn?: boolean;
  /** The local dev sign-in (local development only). */
  devSignIn?: boolean;
  /** Sign in with Google (GOOGLE_SIGNIN=1). */
  googleSignIn?: boolean;
  /** The public demo's demo identities (only while Google sign-in is off). */
  demoSignIn?: boolean;
  /** Proof of Presence on this server, and its environment (sandbox on the public demo: labelled everywhere). */
  presence?: { environment: string } | null;
  /** YouTube channel linking is configured on this server. */
  youtube: boolean;
  arkiv: { on: boolean; namespace?: string | null };
  /** Pay to release over x402 on Hedera testnet, and the brand agent's audit log on an HCS topic. */
  hedera?: { x402: boolean; audit?: { topic: string | null; url: string | null; sent: number; pending: number } | null };
  /** Released ads on Swarm: the public gateway, and until when the batch keeps them (ms). */
  swarm?: { gateway: string; storedUntil: number | null } | null;
  /** How brands pay creators on this server: USDT on Whitechain (the default), USDC on Hedera, or null for test payments. */
  payments?: { rail: "whitechain" | "hedera"; network: string; asset: string; chainId?: number; usdt?: string; settlement?: string; explorer?: string; rpcUrl?: string } | null;
}

export interface Listing {
  uid: string;
  name: string;
  rules: { bannedCategories: string[]; minPrice: number; maxDays: number };
  listedAt: number;
}

export interface OutputView {
  hash: string;
  mime: string;
  provider: string;
  model: string;
  requestId: string | null;
  faceCheck: "passed" | "not-run";
  faceScore: number | null;
  createdAt: number;
  file: string | null;
  /** Once released: the file on Swarm. */
  swarm?: SwarmView | null;
}

/**
 * A released ad's file on Swarm: a public gateway link (a showcase ad, as it is), or encrypted (only its brand and
 * creator open it, in FaceVisa). "pending" while it uploads.
 */
export type SwarmView = { state: "uploaded"; ref: string; url: string; encrypted: boolean } | { state: "pending" | "failed" };

/** A request as its creator sees it: the brief, the terms and the finished ad (only they see it before release). */
export interface CreatorRequest {
  id: string;
  brand: string;
  self: boolean;
  kind: Kind;
  status: ActionStatus;
  generation: number;
  createdAt: number;
  expiresAt: number;
  /** When the current step began (the agent's latest event on it). */
  stepAt: number;
  decidedAt: number | null;
  reason: string | null;
  licenceId: string | null;
  arkiv?: ArkivSync;
  request: { brief: string; category: string; durationDays: number; price: string } | null;
  output: OutputView | null;
}

export interface BrandRequest {
  id: string;
  creator: string;
  self: boolean;
  /** The creator's face, while they're listed (signed-in accounts). */
  face?: string | null;
  /** The creator's account id: to ask again with the same terms. */
  creatorId?: string;
  kind: Kind;
  category: string;
  brief: string;
  durationDays: number;
  price: string;
  status: ActionStatus;
  generation: number;
  createdAt: number;
  expiresAt: number;
  /** When the current step began (the agent's latest event on it). */
  stepAt: number;
  reason: string | null;
  licenceId: string | null;
  output: OutputView | null;
  /** "approved by the creator in FaceVisa"; method: how they signed in (dev, demo). */
  consent: { method: Identity; approvedAt: number } | null;
  /** "spend approved by the brand": null when not needed. */
  spend: { approvedAt: number | null } | null;
  arkiv?: ArkivSync;
  /** The public demo: the creator is seeded, so this request won't be answered. */
  seededCreator?: boolean;
  /** The agent's latest step on this request (e.g. why a payment was refused). */
  lastStep?: { kind: string; summary: string; at: number } | null;
}

/**
 * How an ad was paid for. rail "dev": DevPayment, a test payment (no money moved). rail "whitechain": USDT on Whitechain
 * testnet through FaceVisa's settlement contract; `ref` is the transaction hash. rail "hedera-x402 (testnet)": USDC over
 * x402 on Hedera testnet; `ref` is the Hedera transaction ID.
 */
export interface PaymentView {
  rail: string | null;
  ref: string;
  amount: string;
  network?: string;
  asset?: string | null;
  payer?: string | null;
  payee?: string | null;
  hashscan?: string;
  /** The transaction on the chain's explorer (Whitechain's Blockscout, or HashScan). */
  explorer?: string;
  payerUrl?: string | null;
  payeeUrl?: string | null;
  /** Verify only: the payment as the chain records it (Whitechain's RPC, or Hedera's mirror node). */
  check?: { state: "confirmed" | "mismatch" | "not-found" | "unreachable"; result?: string; consensusAt?: number; checks: { ok: boolean; text: string }[]; error?: string };
}

export interface ReceiptView {
  hash: string;
  mime: string;
  provider: string;
  model: string;
  faceCheck: "passed" | "not-run";
  /** The face gate's cosine similarity to the creator's capture (null when it didn't run). */
  faceScore?: number | null;
  paymentRef: string;
  /** "dev" is DevPayment: a test payment, no money moved. */
  paymentRail: string | null;
  payment?: PaymentView;
  releasedAt: number;
  file: string;
  swarm?: SwarmView | null;
}

export interface LicenceView {
  id: string;
  brand: string;
  creator: string;
  kind: Kind;
  category: string;
  brief: string;
  price: string;
  durationDays: number;
  status: "active" | "revoked";
  createdAt: number;
  expiresAt: number;
  receipt: ReceiptView | null;
  arkiv?: { licence: ArkivSync; receipt: ArkivSync };
}

export interface AgentEvent {
  id: number;
  actionId: string | null;
  licenceId: string | null;
  kind: string;
  summary: string;
  at: number;
}

/** How the person who approved signed in: the local dev sign-in, the public demo, or World ID (WORLDID_SIGNIN=1). */
export type Identity = "dev" | "demo" | "google" | "world-id";

export interface ShortlistEntry {
  creator: string;
  name: string;
  pick: boolean;
  price: string;
  reason: string;
  /** The creator's linked channel (picks only): what the agent used to rank them. */
  youtube?: { title: string; subscribers: number | null; topics: string[]; faceMatch: boolean };
  source?: "arkiv" | "facevisa";
  url?: string;
  why?: string;
  /** The public demo: a seeded creator, whom nobody can sign in as (requests to them go unanswered). */
  seeded?: boolean;
  /** With Proof of Presence on: its environment ("production", "sandbox"), or null for an unverified demo creator. */
  presence?: string | null;
  /** Which World ID credential: "selfie" (Proof of Presence) or "proof_of_human" (the Orb). */
  credential?: string;
  /** The creator's face (their capture's first frame), for signed-in accounts; null without one. */
  face?: string | null;
  stats?: CreatorStats | null;
  statsArkiv?: ArkivSync;
  usagePage?: string | null;
}

/** A creator's numbers, as their creator_stats entity on Arkiv holds them. */
export interface CreatorStats {
  adsApproved: number;
  activeLicences: number;
  revoked: number;
  earned: string;
  brands: number;
}

/** A listed creator, for the Creators page. */
export interface CreatorCard {
  uid: string;
  name: string;
  self: boolean;
  listedAt: number;
  image: string;
  video: string;
  maxDays: number;
  refuses: string[];
  presence?: string | null;
  credential?: string | null;
  seeded?: boolean;
  arkiv: ArkivSync;
  /** Signed-in accounts only. */
  face: string | null;
  /** Their numbers as their creator_stats entity on Arkiv holds them, that entity, and their public usage page. */
  stats?: CreatorStats | null;
  statsArkiv?: ArkivSync;
  usagePage?: string | null;
}

export interface FaceVisaVerify {
  verdict: "Licensed" | "Revoked" | "Expired" | "Unknown";
  reason?: string;
  licence?: { id: string; kind: Kind; category: string; durationDays: number; price: string; status: string; createdAt: number; expiresAt: number; brand: string; creator: string };
  render?: { kind: Kind; mime: string; size: number; createdAt: number; releasedAt: number; prompt: string; promptSha256: string };
  provenance?: { provider: string; model: string; requestId: string | null; verified: boolean | null };
  faceCheck?: { result: "passed" | "not-run"; score: number | null };
  payment?: PaymentView;
  consent?: { method: Identity; approvedAt: number | null; boundTo: string; requestId: string } | null;
  spend?: { approvedAt: number | null } | null;
  source?: DataSource;
  arkiv?: VerifyOnArkiv | null;
  sync?: { licence: ArkivSync; receipt: ArkivSync } | null;
  /** This server's Arkiv namespace (for the direct verifier link). */
  namespace?: string | null;
  fileHash?: string;
  swarm?: SwarmView | null;
}

async function send<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = body === undefined ? await fetch(path, { cache: "no-store" }) : await post(path, body);
  } catch {
    throw Object.assign(new Error(SERVER_DOWN), { status: 0 });
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; reasons?: string[]; code?: string };
  // No JSON error from a 5xx: the proxy answering for a backend that's down.
  if (!res.ok) throw Object.assign(new Error(data.error || (res.status >= 500 ? SERVER_DOWN : `HTTP ${res.status}`)), { status: res.status, reasons: data.reasons, code: data.code });
  return data as T;
}

export const getJson = <T>(path: string) => send<T>(path);
/** A POST with the session's CSRF token (lib/api.ts asks /api/me for it once). */
export const postJson = <T>(path: string, body: unknown) => send<T>(path, body);

export const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro % 10_000 === 0 ? 2 : 4)}`;
export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type Pill = "licensed" | "revoked" | "waiting" | "expired" | "neutral" | "lime";
/** How a status reads to people, and its pill. */
export const STATUS: Record<ActionStatus, { label: string; pill: Pill }> = {
  generating: { label: "Making the ad", pill: "neutral" },
  review: { label: "Waiting for the creator's review", pill: "waiting" },
  verified: { label: "Creator verified, reviewing", pill: "waiting" },
  approved: { label: "Approved by the creator", pill: "licensed" },
  spend_review: { label: "Waiting for the brand's spend approval", pill: "waiting" },
  spend_verified: { label: "Brand verified, deciding the spend", pill: "waiting" },
  paying: { label: "Paying", pill: "lime" },
  released: { label: "Released · licensed", pill: "licensed" },
  denied: { label: "Denied", pill: "revoked" },
  expired: { label: "Expired", pill: "expired" },
  cancelled: { label: "Cancelled", pill: "expired" },
  failed: { label: "Failed", pill: "revoked" },
};

/** The YouTube linking callback's outcome (?youtube=…), in words. */
export const YOUTUBE: Record<string, { ok: boolean; text: string }> = {
  linked: { ok: true, text: "Channel linked. Checking its face match now." },
  cancelled: { ok: false, text: "You cancelled at Google, so nothing was linked." },
  taken: { ok: false, text: "That channel is already linked to another FaceVisa account." },
  "no-channel": { ok: false, text: "That Google account has no YouTube channel. Pick the account that owns your channel." },
  failed: { ok: false, text: "Linking didn't complete, so nothing changed. Try again." },
};

