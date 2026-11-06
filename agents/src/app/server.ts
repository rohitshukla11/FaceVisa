// The FaceVisa API: sign-in, creator profiles, and FaceVisa's own flow (the brand agent, the creator's in-app approval
// of the finished ad, the brand's spend approval, release, Verify). The web (Next.js) proxies /api here.
//
//   pnpm app      the backend on 127.0.0.1:8788 (reads ../.env.local); FACEVISA_MODE=local by default
//
// Sign-in (OIDC, worldid.ts, session.ts): locally the dev sign-in (a stand-in provider), on the public demo its demo
// identities, and World ID only with WORLDID_SIGNIN=1 (off by default: World ID appears only as the IDKit check before a
// creator lists). Local-development switches (the dev sign-in, "expire now") exist only with FACEVISA_LOCAL_DEV=1, never
// with NODE_ENV=production or on mainnet.

import "../env.js"; // first: settings and their fallbacks (src/env.ts)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { assertVertexAllowed, vertexStatus } from "../ai/vertex.js";
import { mediaLabel } from "../ai/media.js";
import { scrub } from "../arkiv/chain.js";
import type { Account } from "./accounts.js";
import { localDevAllowed } from "./devmode.js";
import { clientIp, guardFromEnv, type Guard } from "./guard.js";
import { consentMethod, facevisaRoutes, presenceView, sendJson } from "./facevisaRoutes.js";
import { health, preflight } from "./health.js";
import { OnboardingError } from "./onboarding.js";
import { faceModelsPresent, verifyCapture } from "../facevisa/face.js";
import { startRuntime, type Mode, type Runtime } from "./runtime.js";
import { csrfOk, csrfToken, endSession, sameOrigin, sessionAccount, startSession } from "./session.js";
import { DEMO_PATH, STANDIN_PATH, StandIn } from "./standin.js";
import { displayNameFrom } from "./google.js";
import { publicDemoWanted } from "./demo.js";
import { parseFace, parseTopics } from "./youtube.js";
import { pkce, randomToken, WorldIdError } from "./worldid.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mode = (process.env.FACEVISA_MODE || "local") as Mode;
const port = Number(process.env.PORT || 8788);
export const localDev = () => localDevAllowed(mode);
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${port}`;
const signinRedirect = () => process.env.WORLDID_SIGNIN_REDIRECT_URI || `${publicUrl}/api/auth/callback`;
// The sign-in callback, at its path and at the registered redirect URI's path.
const isCallback = (path: string) => ["/api/auth/callback", new URL(signinRedirect()).pathname].includes(path);
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const safeReturn = (v: string | null) => (v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : "/dashboard");
const redirect = (res: ServerResponse, location: string) => {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
};
const publicGuard = guardFromEnv();
const json = sendJson;
const parse = (raw: string) => {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * The request body, up to `limit` bytes (a creator's live capture arrives as three base64 JPEG frames). Past the
 * limit it's discarded, so the caller gets a clear 413 rather than a dropped connection; past 4× it's cut off.
 */
function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    if (Number(req.headers["content-length"]) > 4 * limit) return (reject(new Error("request body too large")), req.destroy());
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * limit) req.destroy();
      else if (size <= limit) chunks.push(c);
    });
    req.on("end", () => (size > limit ? reject(new Error("request body too large")) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** The signed-in account as the browser sees it: never the OIDC subject itself. */
function meView(rt: Runtime, me: Account) {
  const c = rt.accounts.creator(me.uid);
  return {
    // signIn: how this account signed in: "dev" (the local dev sign-in), "demo" (the public demo), or "world-id"
    // (only with WORLDID_SIGNIN=1).
    account: { uid: me.uid, name: me.name, role: me.role, signIn: consentMethod(me.iss) },
    // The account's World ID check: required of creators and brands alike when IDKit is on.
    presence: presenceView(rt, me.uid),
    creator: c
      ? {
          name: c.name,
          youtube: c.youtubeChannelId
            ? { channelId: c.youtubeChannelId, title: c.youtubeTitle, thumbnail: c.youtubeThumbnail, subscribers: c.youtubeSubscribers, topics: parseTopics(c), verifiedAt: c.youtubeVerifiedAt, faceMatch: parseFace(c) }
            : null,
          photo: c.photoFile ? "/api/me/creator/photo" : null,
          capture: c.captureFiles ? { frames: (JSON.parse(c.captureFiles) as string[]).length, liveness: c.liveness ? JSON.parse(c.liveness) : null } : null,
          consentAt: c.consentAt,
          presence: presenceView(rt, me.uid),
          // The listing's entity on Arkiv: when it expires, and from when the sweep renews it while listed.
          arkivListing: rt.arkiv?.listingSchedule(me.uid) ?? null,
          // The address that owns their entities on Arkiv (their listing, licences, revocations), with Arkiv on: the
          // public "where is my face used" page looks it up. Only an address; the key stays in the keystore.
          arkivAddress: rt.arkiv ? (rt.keystore?.address(`account:${me.uid}`) ?? null) : null,
          // Their Hedera account (where brands pay them), with x402 on: an account ID only, and its HashScan page.
          hedera: ((id) => (id ? { account: id, url: `https://hashscan.io/testnet/account/${id}` } : null))(rt.x402 ? rt.accounts.hederaAccount(me.uid) : null),
          // Where brands pay them: their Whitechain address (their custodial key) on the explorer, or their Hedera account.
          payout: rt.whitechain
            ? ((a) => ({ network: "Whitechain", account: a, url: `${rt.whitechain!.d.config.explorer}/address/${a}` }))(rt.whitechain.address(me.uid))
            : ((id) => (id ? { network: "Hedera", account: id, url: `https://hashscan.io/testnet/account/${id}` } : null))(rt.x402 ? rt.accounts.hederaAccount(me.uid) : null),
          listing: rt.core.data.listing(me.uid) ?? null,
        }
      : null,
  };
}

/** /api/likeness/… (legacy) is an alias of /api/facevisa/…. */
export const canonicalPath = (p: string) => p.replace(/^\/api\/likeness(?=\/|$)/, "/api/facevisa");

export async function handle(rt: Runtime, req: IncomingMessage, res: ServerResponse, guard: Guard | undefined = publicGuard) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = canonicalPath(url.pathname);
  const ip = guard ? clientIp(req) : "";
  if (guard && !guard.reads.allow(ip)) return json(res, 429, { error: "too many requests from this address; try again in a minute" });
  if (guard && req.method === "POST" && !guard.actions.allow(ip)) return json(res, 429, { error: "too many actions from this address; try again in a minute" });
  let raw = "";
  try {
    raw = req.method === "POST" ? await readBody(req, path === "/api/me/creator/capture" ? 12 << 20 : undefined) : "";
  } catch {
    return json(res, 413, { error: "request body too large" });
  }
  // Our own session, started only after this backend exchanged a code and validated the ID token.
  let me: Account | undefined = sessionAccount(rt.accounts, req);
  if (req.method === "POST" && !sameOrigin(req, rt.publicUrl)) return json(res, 403, { error: "cross-site request refused" });
  // Every signed-in POST carries the session's CSRF token (on top of SameSite=Lax and the Origin check). The stand-in's
  // own form posts are its sign-in page, not the app's.
  if (req.method === "POST" && me && !path.startsWith(`${STANDIN_PATH}/`) && !path.startsWith(`${DEMO_PATH}/`) && !csrfOk(req)) return json(res, 403, { error: "missing or wrong CSRF token: reload the page" });

  // ---------------------------------------------------------------- health (local development only): each integration's state
  // Up or down, for an uptime check: nothing else.
  if (req.method === "GET" && path === "/api/status") return json(res, 200, { ok: true });
  if (req.method === "GET" && path === "/api/health") {
    // Local development, or on a server from the machine itself (a direct request, never one forwarded by Caddy or the web).
    const onTheMachine = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-host"];
    if (!localDev() && !onTheMachine) return json(res, 404, { error: "not found" });
    return json(res, 200, await health(rt));
  }

  // ---------------------------------------------------------------- the public demo's identity provider (FACEVISA_PUBLIC_DEMO=1)
  if (path.startsWith(`${DEMO_PATH}/`)) {
    if (!rt.demo) return json(res, 404, { error: "not found" });
    // With Google sign-in on, the demo identities are retired: no new demo sign-ins (seeded accounts stay as they are).
    if (rt.google && path === `${DEMO_PATH}/authorize`) return redirect(res, "/?signin=unavailable");
    if (await rt.demo.handle(rt, req, res, path, url, raw, clientIp(req))) return;
    return json(res, 404, { error: "not found" });
  }

  // ---------------------------------------------------------------- local development: the dev sign-in (a stand-in provider)
  if (path.startsWith(`${STANDIN_PATH}/`) || path.startsWith("/api/dev/")) {
    if (!rt.standin || !localDev()) return json(res, 404, { error: "not found" });
    if (await rt.standin.handle(rt, req, res, path, url, raw)) return;
    // Click through the "expired" path without waiting: the request's brand or creator ends its wait now.
    if (req.method === "POST" && path === "/api/dev/expire-request") {
      const a = rt.core.data.action(String(parse(raw).id ?? ""));
      if (!me || !a || (a.brand !== me.uid && a.creator !== me.uid)) return json(res, 404, { error: "no such request" });
      rt.core.data.setExpiry(a.id, Date.now());
      rt.core.agent.sweep();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  }

  // ---------------------------------------------------------------- sign-in (OIDC)
  if (req.method === "GET" && path === "/api/auth/login") {
    // ?via=google: Google. ?via=demo: the public demo's test identities (only while Google sign-in is off). Otherwise
    // the dev sign-in locally (or World ID with WORLDID_SIGNIN=1).
    const via = url.searchParams.get("via");
    const issuer = via === "google" ? rt.google : via === "demo" ? (rt.google ? undefined : rt.demo?.client) : rt.worldId;
    if (!issuer) return redirect(res, "/?signin=unavailable");
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkce();
    rt.accounts.createAttempt({ state, purpose: "signin", nonce, verifier, ttlMs: ATTEMPT_TTL_MS, redirectUri: signinRedirect(), returnTo: safeReturn(url.searchParams.get("return")), issuer: issuer.issuer });
    return redirect(res, await issuer.authorizeUrl({ redirectUri: signinRedirect(), state, nonce, codeChallenge: challenge }));
  }
  if (req.method === "GET" && isCallback(path)) {
    // Any failure means no session. Nothing from this query string is logged.
    const fail = (why: string) => redirect(res, `/?signin=${why}`);
    if (!rt.worldId && !rt.demo && !rt.google) return fail("unavailable");
    const taken = rt.accounts.takeAttempt(url.searchParams.get("state") ?? "");
    if (!taken.ok) return fail(taken.reason === "expired" ? "expired" : "invalid");
    // Only a sign-in attempt completes here (a YouTube linking state has its own callback).
    if (taken.attempt.purpose !== "signin") return fail("invalid");
    const err = url.searchParams.get("error");
    if (err) return fail(err === "access_denied" ? "cancelled" : "failed");
    // The provider this attempt went to (stored with it; Google doesn't always send iss back). A returned iss
    // (RFC 9207) must match it before the code is redeemed.
    const providers = [rt.worldId, rt.demo?.client, rt.google].filter((c): c is NonNullable<typeof c> => !!c);
    const iss = url.searchParams.get("iss");
    const issuer = taken.attempt.issuer ? providers.find((c) => c.issuer === taken.attempt.issuer) : providers.find((c) => (iss === null ? c === rt.worldId : c.issuer === iss));
    if (!issuer || (iss !== null && iss !== issuer.issuer)) return fail("failed");
    const code = url.searchParams.get("code");
    if (!code) return fail("failed");
    try {
      const idToken = await issuer.exchange({ code, redirectUri: taken.attempt.redirectUri ?? signinRedirect(), codeVerifier: taken.attempt.verifier });
      const claims = await issuer.validate(idToken, taken.attempt.nonce);
      // The public demo: new Google accounts per network per day are limited, like the demo identities were.
      if (rt.demoState && issuer === rt.google && !rt.accounts.accountBySubject(claims.iss, claims.sub) && !rt.demoState.takeFor(clientIp(req), "identity")) return fail("limit");
      let account = rt.accounts.signIn(claims.iss, claims.sub);
      // Google: the person's Google name as their display name, on first sign-in (they can change it while setting up).
      const googleName = issuer === rt.google ? displayNameFrom(claims.name) : undefined;
      if (googleName && !account.name) account = rt.accounts.setName(account.uid, googleName);
      startSession(rt.accounts, res, account.uid);
      return redirect(res, taken.attempt.returnTo ?? "/dashboard");
    } catch (e) {
      return fail(e instanceof WorldIdError && e.reason === "invalid_token" ? "invalid" : "failed");
    }
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    endSession(rt.accounts, req, res);
    return json(res, 200, { ok: true });
  }
  // ---------------------------------------------------------------- YouTube channel linking: Google's callback
  if (req.method === "GET" && rt.youtube && path === canonicalPath(new URL(rt.youtube.c.redirectUri()).pathname)) {
    const taken = rt.accounts.takeAttempt(url.searchParams.get("state") ?? "");
    if (!taken.ok || taken.attempt.purpose !== "youtube") return redirect(res, "/dashboard?youtube=failed");
    let outcome: string;
    try {
      outcome = await rt.youtube.callback(taken.attempt, url.searchParams);
    } catch {
      outcome = "failed";
    }
    return redirect(res, `/dashboard?youtube=${outcome}`);
  }

  // ---------------------------------------------------------------- FaceVisa: listings, the brand agent, consent, release
  if (await facevisaRoutes({ rt, req, res, url, path, me, body: req.method === "POST" ? parse(raw) : {} })) return;

  // ---------------------------------------------------------------- the signed-in account
  if (path === "/api/me" || path.startsWith("/api/me/")) {
    if (!me) return json(res, req.method === "GET" && path === "/api/me" ? 200 : 401, req.method === "GET" && path === "/api/me" ? { account: null } : { error: "sign in first" });
    if (req.method === "GET" && path === "/api/me") return json(res, 200, { ...meView(rt, me), csrf: csrfToken(req) });
    if (req.method === "GET" && path === "/api/me/creator/photo") {
      const row = rt.accounts.creator(me.uid);
      const photo = row && rt.onboarding.photo(row);
      if (!photo) return json(res, 404, { error: "no photo" });
      res.writeHead(200, { "content-type": photo.mime, "cache-control": "private, no-store" });
      return res.end(photo.bytes);
    }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    const body = parse(raw);
    try {
      if (path === "/api/me/role") {
        const role = body.role;
        if (role !== "brand" && role !== "creator") return json(res, 400, { error: "role is brand or creator" });
        // One account, both workspaces: the first time sets the display name; afterwards it switches views.
        const name = String(body.name ?? "").trim();
        // The name is set once, while setting up (the first role): given then, or already there from Google sign-in.
        const naming = !me.role && (!me.name || name !== "");
        if (naming && (name.length < 2 || name.length > 60)) return json(res, 400, { error: "give a display name (2 to 60 characters)" });
        // It's public (the creator's Arkiv listing): no control characters or invisible formatting (e.g. a right-to-left override).
        if (naming && /[\p{Cc}\p{Cf}]/u.test(name)) return json(res, 400, { error: "the display name has invisible or control characters" });
        if (naming) me = rt.accounts.setName(me.uid, name);
        me = rt.accounts.setRole(me.uid, role);
        if (role === "creator") rt.onboarding.start(me.uid, me.name);
        return json(res, 200, meView(rt, me));
      }
      if (path === "/api/me/creator/capture") {
        if (!me.name) return json(res, 409, { error: "set up your account first" });
        rt.onboarding.start(me.uid, me.name);
        const frames = (Array.isArray(body.frames) ? body.frames : []).map((f) => Buffer.from(String(f).replace(/^data:image\/jpeg;base64,/, ""), "base64"));
        const l = (body.liveness ?? {}) as { blinks?: unknown; turnedLeft?: unknown; turnedRight?: unknown };
        const liveness = { blinks: Number(l.blinks) || 0, turnedLeft: l.turnedLeft === true, turnedRight: l.turnedRight === true };
        await rt.onboarding.saveCapture(me.uid, frames, liveness, body.consent === true, faceModelsPresent() ? verifyCapture : undefined);
        // A new capture: the channel face match runs again against it.
        if (rt.youtube && rt.accounts.creator(me.uid)?.youtubeChannelId) void rt.youtube.faceMatch(me.uid).catch(() => undefined);
        return json(res, 200, meView(rt, me));
      }
    } catch (e) {
      if (e instanceof OnboardingError) return json(res, e.status, { error: e.message });
      throw e;
    }
    return json(res, 404, { error: "not found" });
  }
  return json(res, 404, { error: "not found" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertVertexAllowed();
  const ai = vertexStatus();
  const standinWanted = process.env.WORLDID_STANDIN === "1";
  const demoWanted = publicDemoWanted();
  if (standinWanted && !localDev()) throw new Error("WORLDID_STANDIN=1 (the dev sign-in) needs FACEVISA_LOCAL_DEV=1, and never runs with NODE_ENV=production or on mainnet");
  const worldIdSignIn = process.env.WORLDID_SIGNIN === "1";
  if ((worldIdSignIn || standinWanted || demoWanted || process.env.GOOGLE_SIGNIN === "1") && (process.env.SESSION_SECRET ?? "").length < 32) throw new Error("sign-in needs SESSION_SECRET (at least 32 characters)");
  // The dev sign-in replaces World ID sign-in while it is on.
  const standin = standinWanted ? new StandIn({ internalBase: `http://127.0.0.1:${port}`, publicBase: publicUrl }) : undefined;
  if (!standin && worldIdSignIn && process.env.WORLDID_CLIENT_ID && !process.env.WORLDID_PRIVATE_KEY_FILE && !process.env.WORLDID_CLIENT_SECRET) throw new Error("World ID sign-in (WORLDID_SIGNIN=1) needs WORLDID_CLIENT_SECRET or WORLDID_PRIVATE_KEY_FILE");
  // The public demo's test identities: new people per visitor are limited per day (demo.ts).
  let started: Runtime | undefined;
  const demo = demoWanted ? new StandIn({ internalBase: `http://127.0.0.1:${port}`, publicBase: publicUrl, flavour: "demo", newPerson: (ip) => started?.demoState?.takeFor(ip, "identity") ?? false }) : undefined;
  const rt = await startRuntime({ mode, root, publicUrl, ...(standin ? { standin } : {}), ...(demo ? { demo } : {}) });
  started = rt;
  if (rt.worldId && !standin && !signinRedirect().startsWith("https://")) console.warn(`World ID: the callback ${signinRedirect()} isn't HTTPS; World ID accepts HTTPS callbacks only`);
  const server = createServer((req, res) => {
    handle(rt, req, res).catch((e) => {
      console.error(`[app] ${req.method} ${req.url?.split("?")[0]}: ${scrub(e)}`);
      json(res, 500, { error: scrub(e).replace(/^Error: /, "") });
    });
  });
  server.listen(port, "127.0.0.1", () => {
    const worldId = rt.standin ? `DEV SIGN-IN (local development only) at ${publicUrl}${STANDIN_PATH}${rt.google ? "; Google sign-in (GOOGLE_SIGNIN=1)" : ""}` : `${rt.worldId ? `World ID ${rt.worldId.issuer} (WORLDID_SIGNIN=1, ${rt.worldId.authMethod}, callback ${signinRedirect()})` : "no World ID sign-in"}${rt.demo && !rt.google ? `; PUBLIC DEMO identities (test, labelled) at ${publicUrl}${DEMO_PATH}` : ""}${rt.google ? "; Google sign-in (GOOGLE_SIGNIN=1)" : ""}`;
    const spend = rt.core.agent.d.spendLimit === undefined ? "off" : `over $${(rt.core.agent.d.spendLimit / 1e6).toFixed(2)}`;
    void preflight(rt);
    console.log(`FaceVisa app (${mode}, sign-in: ${worldId}, approvals: ${rt.core.consent?.name ?? "none"}, brand spend check: ${spend}, AI: ${rt.core.ai.name === "test" ? `off: renders are TEST RENDERs` : `${mediaLabel({ image: rt.core.ai.name.split("+")[0]!, video: rt.core.ai.name.split("+").at(-1)! })}${ai.on ? ` (Vertex in ${ai.project})` : ""}, caps per day: brand ${rt.core.aiCaps.brand.image} images / ${rt.core.aiCaps.brand.video} videos, site ${rt.core.aiCaps.site.image} / ${rt.core.aiCaps.site.video}`}${publicGuard ? ", public: rate limits" : ""}) on ${publicUrl}`);
  });
  const stop = () => {
    server.close();
    rt.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
