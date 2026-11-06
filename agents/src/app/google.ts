/**
 * Sign in with Google (OpenID Connect), with GOOGLE_SIGNIN=1: the same OIDC client as the other providers (worldid.ts:
 * discovery, authorization code with PKCE S256, client_secret_basic, an RS256 ID token checked against Google's JWKS,
 * iss, aud, azp, exp, iat and the nonce). Scopes "openid profile": the person's Google name becomes their display
 * name on first sign-in (they can change it while setting up); no email is asked for, and the profile picture isn't
 * used. Its client: GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET (a Google OAuth web
 * client with <site>/api/auth/callback among its redirect URIs). Kept apart from YouTube linking's GOOGLE_OAUTH_* so
 * sign-in never turns YouTube linking (a sensitive scope) on; GOOGLE_OAUTH_* is the fallback when both are one client.
 *
 * Accounts are keyed on (iss, sub) like every other provider, labelled "google" (Verify, Arkiv's identity). On the public
 * demo, Google accounts get the demo's protections: per-person limits, testnet USDC top-ups, 48-hour retention.
 */
import type { JWTVerifyGetKey } from "jose";
import { WorldId } from "./worldid.js";

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const isGoogleIssuer = (iss: string | undefined) => iss === GOOGLE_ISSUER;

/** Tests pass a fake Google: its fetch (discovery, token) and its keys. */
export function googleFromEnv(env = process.env, test?: { fetch: typeof fetch; keys: JWTVerifyGetKey }): WorldId | undefined {
  if (env.GOOGLE_SIGNIN !== "1") return undefined;
  const clientId = env.GOOGLE_SIGNIN_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_SIGNIN_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_SIGNIN=1 needs GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET (a Google OAuth web client)");
  return new WorldId({ issuer: GOOGLE_ISSUER, clientId, clientSecret, scope: "openid profile", ...(test ?? {}) });
}

/**
 * A display name from a provider's name claim: trimmed, spaces collapsed, no control or invisible formatting
 * characters (it's public on a creator's listing), at most 60 characters; undefined when under 2.
 */
export function displayNameFrom(name: string | undefined): string | undefined {
  const n = (name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return n.length >= 2 ? n : undefined;
}
