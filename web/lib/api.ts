/**
 * The agents backend (agents/src/app/server.ts), proxied by next.config.ts: the signed-in account and small fetch
 * helpers. Every call runs in the browser and carries our HttpOnly session cookie after sign-in; every POST
 * also carries the session's CSRF token. FaceVisa's own flow has its types and helpers in lib/facevisa.ts.
 */

export type Role = "brand" | "creator";

export type Me = {
  // How the account signed in: the local dev sign-in, the public demo, or World ID (only with WORLDID_SIGNIN=1). The
  // browser never sees the OIDC subject.
  account: { uid: string; name: string; role: Role | null; signIn?: "dev" | "demo" | "google" | "world-id" } | null;
  /** The account's World ID check (IDKit): required of creators and brands alike when the server has it. */
  presence?: NonNullable<NonNullable<Me["creator"]>["presence"]>;
  creator?: {
    name: string;
    youtube: {
      channelId: string;
      title: string | null;
      thumbnail: string | null;
      subscribers: number | null;
      topics: string[];
      verifiedAt: number | null;
      /** The channel's picture and recent thumbnails against the live capture; null until checked. */
      faceMatch: { checkedAt: number; images: number; withFace: number; matches: number; best: number | null; badge: boolean } | null;
    } | null;
    photo: string | null;
    consentAt: number | null;
    /** Listed for brands, with the creator's rules. */
    /** Proof of Presence (World ID Selfie Check through IDKit): required to list when the server has it configured. */
    /** The listing's entity on Arkiv: when it expires, and from when it's renewed while the creator stays listed. */
    arkivListing?: { expiresAt: number; renewsFrom: number } | null;
    /** The address that owns their entities on Arkiv, when Arkiv is on: for the public "where is my face used" page. */
    arkivAddress?: string | null;
    /** Their Hedera account (where brands pay them) and its HashScan page, with x402 payments on. */
    hedera?: { account: string; url: string } | null;
    /** Where brands pay them: their Whitechain address (or Hedera account) and its explorer page. */
    payout?: { network: string; account: string; url: string } | null;
    /** state: none; verified (may list); review (a high risk signal, held for a person to clear); rejected. */
    /** optional: the public demo's two paths (Proof of Presence in its labelled environment, or unverified). */
    presence?: { required: boolean; optional?: boolean; credential?: "selfie" | "proof_of_human" | null; skipped?: "demo"; state?: "none" | "verified" | "review" | "rejected"; verified: boolean; verifiedAt?: number | null; sybilScore?: number | null; maxSybilScore?: number; environment?: string | null };
    listing: import("./facevisa").Listing | null;
  } | null;
  /** This session's CSRF token, sent back as x-csrf-token on every POST. */
  csrf?: string;
};

/**
 * The session's CSRF token (from /api/me), asked for once per page and again when the server refuses it (a new
 * session after signing in or out). Every signed-in POST sends it as x-csrf-token.
 */
let csrf: Promise<string | undefined> | null = null;
export const csrfToken = (fresh = false) => {
  if (fresh || !csrf) csrf = fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).then((m: Me) => m.csrf, () => undefined);
  return csrf;
};

/** A POST to our API with the session's CSRF token, retried once with a fresh token if the server refuses the old one. */
export async function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  const go = async (token: string | undefined) =>
    fetch(path, { cache: "no-store", ...init, method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-csrf-token": token } : {}) }, body: JSON.stringify(body) });
  const res = await go(await csrfToken());
  if (res.status !== 403) return res;
  const again = await res.clone().json().catch(() => ({}));
  return /CSRF/.test((again as { error?: string }).error ?? "") ? go(await csrfToken(true)) : res;
}

/** What a page says when the backend can't be reached (or the proxy answers for it without our JSON). */
export const SERVER_DOWN = "The FaceVisa server isn't answering right now (it may be restarting). Try again in a moment.";

/** Our API, same origin: the HttpOnly session cookie goes along by itself, and POSTs carry the CSRF token. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = body === undefined ? await fetch(path, { cache: "no-store" }) : await post(path, body);
  } catch {
    throw new Error(SERVER_DOWN);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || (res.status >= 500 ? SERVER_DOWN : `HTTP ${res.status}`));
  return data as T;
}

export async function sha256Hex(file: Blob) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return `0x${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
