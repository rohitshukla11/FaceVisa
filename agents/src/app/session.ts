/**
 * This app's own session after a validated World ID sign-in: a random id stored server-side (so logout ends
 * it), sent as a cookie signed with SESSION_SECRET: HttpOnly, Secure, SameSite=Lax. No World ID token is kept.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Account, Accounts } from "./accounts.js";
import { randomToken } from "./worldid.js";

export const SESSION_COOKIE = "facevisa_session";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 characters");
  return s;
}
const mac = (id: string) => createHmac("sha256", secret()).update(id).digest("base64url");

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The session id from a correctly signed cookie, or undefined. */
function sessionId(req: IncomingMessage): string | undefined {
  const v = cookies(req)[SESSION_COOKIE];
  if (!v) return undefined;
  const [id, sig] = v.split(".");
  if (!id || !sig) return undefined;
  const want = Buffer.from(mac(id));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : undefined;
}

export function sessionAccount(accounts: Accounts, req: IncomingMessage): Account | undefined {
  const id = sessionId(req);
  return id ? accounts.sessionAccount(id) : undefined;
}

const cookie = (value: string, maxAge: number) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** A new server-side session for an account, as its signed cookie value. */
export function newSession(accounts: Accounts, uid: string): string {
  const id = randomToken(32);
  accounts.createSession(id, uid, SESSION_TTL_MS);
  return `${id}.${mac(id)}`;
}

export function startSession(accounts: Accounts, res: ServerResponse, uid: string) {
  res.setHeader("set-cookie", cookie(newSession(accounts, uid), Math.floor(SESSION_TTL_MS / 1000)));
}

export function endSession(accounts: Accounts, req: IncomingMessage, res: ServerResponse) {
  const id = sessionId(req);
  if (id) accounts.endSession(id);
  res.setHeader("set-cookie", cookie("", 0));
}

/**
 * A CSRF token for the signed-in session: an HMAC of its id, so it needs no storage and dies with the session.
 * The browser gets it from /api/me and sends it back as the x-csrf-token header on the checkpoint and decision
 * endpoints (on top of SameSite=Lax and the Origin check).
 */
export function csrfToken(req: IncomingMessage): string | undefined {
  const id = sessionId(req);
  return id ? createHmac("sha256", secret()).update(`csrf:${id}`).digest("base64url") : undefined;
}

export function csrfOk(req: IncomingMessage): boolean {
  const want = csrfToken(req);
  const got = req.headers["x-csrf-token"];
  if (!want || typeof got !== "string" || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/**
 * State-changing requests from a browser must come from this site: SameSite=Lax already keeps the session
 * cookie off cross-site POSTs, and a present Origin header must match PUBLIC_URL's origin.
 */
export function sameOrigin(req: IncomingMessage, publicUrl: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients and same-origin navigations; the cookie rules still apply
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
