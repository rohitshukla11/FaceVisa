/**
 * Two small OpenID providers for sign-in, run by this backend (no World ID: World ID appears only as the IDKit check
 * before a creator lists):
 *
 * - "Dev sign-in" (flavour "standin"), for LOCAL DEVELOPMENT ONLY (FACEVISA_LOCAL_DEV=1 and WORLDID_STANDIN=1; never
 *   with NODE_ENV=production or on mainnet): pick a named person and click through, including cancel and an expired
 *   attempt. Its own issuer (`<backend>/api/dev/worldid`, a path kept from before so existing local accounts still sign
 *   in); identity "dev" everywhere.
 * - The public demo's identities (flavour "demo", FACEVISA_PUBLIC_DEMO=1, `<backend>/api/demo/id`): each sign-in is a
 *   new person with a random subject (no names, no list of people, so nobody can sign in as someone else), and new
 *   people are rate limited per IP. Identity "demo" everywhere.
 *
 * Our OIDC client (worldid.ts) talks to them as to any issuer: discovery, the authorization request, the code exchange
 * (client_secret_basic, PKCE S256, single-use codes), an RS256 ID token checked against its JWKS.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { exportJWK, SignJWT } from "jose";
import type { Runtime } from "./runtime.js";
import { WorldId } from "./worldid.js";

export const STANDIN_PATH = "/api/dev/worldid";
export const DEMO_PATH = "/api/demo/id";

type Scenario = "ok" | "cancel" | "expired";
const SCENARIOS: Record<Scenario, string> = {
  ok: "Sign in as this person",
  cancel: "Cancel (access_denied)",
  expired: "Expired attempt (took too long)",
};

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  sub: string;
  authTime: number;
  amr: string[];
  expiresAt: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A dev sign-in subject from a name: the same name is the same person (opaque). */
export const standinSub = (name: string) => `standin_${createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 24)}`;

export class StandIn {
  readonly issuer: string;
  readonly clientId: string;
  readonly path: string;
  readonly demo: boolean;
  private readonly secret = randomBytes(24).toString("base64url");
  private readonly key: KeyObject;
  private readonly kid = randomUUID();
  private readonly codes = new Map<string, Code>();
  readonly client: WorldId;

  /**
   * internalBase: how the backend reaches itself (http://127.0.0.1:PORT); publicBase: what the browser uses.
   * flavour "demo": the public demo's provider. newPerson(ip): whether this IP may create another demo person now.
   */
  constructor(private readonly o: { internalBase: string; publicBase: string; flavour?: "standin" | "demo"; newPerson?: (ip: string) => boolean }) {
    this.demo = o.flavour === "demo";
    this.path = this.demo ? DEMO_PATH : STANDIN_PATH;
    this.clientId = this.demo ? "facevisa-public-demo" : "facevisa-local-standin";
    this.issuer = `${o.internalBase}${this.path}`;
    this.key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    this.client = new WorldId({ issuer: this.issuer, clientId: this.clientId, clientSecret: this.secret });
  }

  private discovery() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.o.publicBase}${this.path}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks.json`,
      response_types_supported: ["code"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      claims_parameter_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** Handles a stand-in route; false when the path isn't one. Callers check local development first. */
  async handle(rt: Runtime, req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: string, ip = ""): Promise<boolean> {
    if (!path.startsWith(`${this.path}/`)) return false;
    const sub = path.slice(this.path.length);
    const json = (status: number, b: unknown) => (res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(b)), true);
    if (req.method === "GET" && sub === "/.well-known/openid-configuration") return json(200, this.discovery());
    if (req.method === "GET" && sub === "/jwks.json") return json(200, { keys: [{ ...(await exportJWK(createPublicKey(this.key))), kid: this.kid, alg: "RS256", use: "sig" }] });
    if (req.method === "GET" && sub === "/authorize") return this.demo ? this.demoPage(rt, res, url.searchParams) : this.page(rt, res, url.searchParams);
    if (req.method === "POST" && sub === "/authorize") return this.demo ? this.demoChoose(rt, res, new URLSearchParams(raw), ip) : this.choose(rt, res, new URLSearchParams(raw));
    if (req.method === "POST" && sub === "/token") return this.token(req, res, new URLSearchParams(raw));
    return json(404, { error: "not found" });
  }

  /** The request must be ours: our client, our callbacks, code flow, PKCE S256, a state and a nonce. */
  private problem(p: URLSearchParams, allowed: string[]): string | undefined {
    if (p.get("client_id") !== this.clientId) return "unknown client_id";
    if (!allowed.includes(p.get("redirect_uri") ?? "")) return "redirect_uri isn't registered for this client";
    if (p.get("response_type") !== "code") return "response_type must be code";
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return "PKCE S256 is required";
    if (!p.get("state") || !p.get("nonce")) return "state and nonce are required";
    return undefined;
  }

  private allowedRedirects() {
    const base = this.o.publicBase;
    return [process.env.WORLDID_SIGNIN_REDIRECT_URI || `${base}/api/auth/callback`, `${base}/api/auth/callback`];
  }

  /** A provider page: no scripts (its own CSP), forms posting back to this provider only. */
  private html(res: ServerResponse, status: number, body: string, title: string): true {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#111;background:#fafafa}
.warn{background:#fff3cd;border:1px solid #e0c36a;border-radius:10px;padding:10px 14px}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px;margin:16px 0}
button{display:block;width:100%;text-align:left;font:inherit;padding:10px 14px;margin:8px 0;border-radius:10px;border:1px solid #bbb;background:#fff;cursor:pointer}
button.primary{background:#111;color:#fff;border-color:#111}button.bad{border-color:#c66}
input{font:inherit;padding:8px 10px;border:1px solid #bbb;border-radius:8px;width:100%;box-sizing:border-box}
code{background:#eee;padding:1px 5px;border-radius:5px}small{color:#666}</style></head><body>${body}</body></html>`);
    return true;
  }

  private page(rt: Runtime, res: ServerResponse, p: URLSearchParams): true {
    const html = (status: number, body: string) => this.html(res, status, body, "Dev sign-in");
    const problem = this.problem(p, this.allowedRedirects());
    if (problem) return html(400, `<h1>Dev sign-in</h1><p class="warn">Refused: ${esc(problem)}.</p>`);
    const hidden = [...p.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    const button = (scenario: Scenario, label: string, cls = "", extra = "") => `<form method="post" action="${this.path}/authorize">${hidden}<input type="hidden" name="scenario" value="${scenario}">${extra}<button class="${cls}">${esc(label)}</button></form>`;
    const head = `<h1>Dev sign-in</h1><p class="warn"><b>Local development only</b> (<code>WORLDID_STANDIN=1</code>): a local test sign-in. Everything it does is labelled "dev".</p>`;
    const known = rt.accounts.accountsByIssuer(this.issuer).filter((a) => a.name);
    const people = known.map((a) => button("ok", `Sign in as ${a.name}${a.role ? ` (${a.role})` : ""}`, "", `<input type="hidden" name="identity_sub" value="${esc(a.sub)}">`)).join("");
    return html(
      200,
      `${head}<div class="card"><h2>Sign in</h2>${people || "<p><small>No dev people yet.</small></p>"}
<form method="post" action="${this.path}/authorize">${hidden}<input type="hidden" name="scenario" value="ok"><p><label>A new person (the same name is the same person next time)<br><input name="identity_name" required maxlength="40" placeholder="e.g. Maya, or Acme"></label></p><button class="primary">Sign in as this new person</button></form>
${button("cancel", SCENARIOS.cancel, "bad")}${button("expired", SCENARIOS.expired, "bad")}</div>`,
    );
  }

  private choose(rt: Runtime, res: ServerResponse, p: URLSearchParams): true {
    const redirect = (to: string) => (res.writeHead(303, { location: to, "cache-control": "no-store" }), res.end(), true as const);
    const problem = this.problem(p, this.allowedRedirects());
    if (problem) return (res.writeHead(400, { "content-type": "text/plain" }), res.end(`Refused: ${problem}`), true);
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("state", p.get("state")!);
    back.searchParams.set("iss", this.issuer);
    const scenario = (p.get("scenario") ?? "ok") as Scenario;
    if (scenario === "cancel") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user cancelled at the dev sign-in");
      return redirect(back.toString());
    }
    if (scenario === "expired") rt.accounts.expireAttempt(p.get("state")!);
    const named = p.get("identity_name")?.trim();
    if (named !== undefined && (named.length < 1 || named.length > 40 || /[\p{Cc}\p{Cf}]/u.test(named))) return (res.writeHead(400, { "content-type": "text/plain" }), res.end("Refused: a name is 1 to 40 visible characters"), true);
    const sub = p.get("identity_sub") || (named ? standinSub(named) : standinSub("anonymous"));
    back.searchParams.set("code", this.code(p, sub, Math.floor(Date.now() / 1000), ["dev"]));
    return redirect(back.toString());
  }

  /** A single-use authorization code for this request and subject, valid 5 minutes. */
  private code(p: URLSearchParams, sub: string, authTime: number, amr: string[]): string {
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { clientId: this.clientId, redirectUri: p.get("redirect_uri")!, challenge: p.get("code_challenge")!, nonce: p.get("nonce")!, sub, authTime, amr, expiresAt: Date.now() + 5 * 60_000 });
    return code;
  }

  /** The public demo's sign-in page: a new demo person each time. */
  private demoPage(_rt: Runtime, res: ServerResponse, p: URLSearchParams): true {
    const html = (status: number, body: string) => this.html(res, status, body, "FaceVisa demo identity");
    const problem = this.problem(p, this.allowedRedirects());
    if (problem) return html(400, `<h1>FaceVisa demo identity</h1><p class="warn">Refused: ${esc(problem)}.</p>`);
    const hidden = [...p.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    const button = (choice: string, label: string, cls = "") => `<form method="post" action="${this.path}/authorize">${hidden}<input type="hidden" name="choice" value="${choice}"><button class="${cls}">${esc(label)}</button></form>`;
    const head = `<h1>FaceVisa demo identity</h1><p class="warn"><b>Demo mode: a test identity.</b> It lets you try FaceVisa without an account. Everything it does is labelled "demo", on the site and on Arkiv. Payments are on testnet.</p>`;
    return html(200, `${head}<div class="card"><h2>Sign in</h2><p>Each time you continue here you're a new demo person. You choose a display name on the next page.</p>${button("ok", "Continue as a new demo person", "primary")}${button("cancel", "Cancel", "bad")}</div>`);
  }

  /** The demo's answer: a new random person (rate limited per IP), or a cancel. */
  private demoChoose(_rt: Runtime, res: ServerResponse, p: URLSearchParams, ip: string): true {
    const redirect = (to: string) => (res.writeHead(303, { location: to, "cache-control": "no-store" }), res.end(), true as const);
    const refuse = (why: string) => (res.writeHead(400, { "content-type": "text/plain" }), res.end(`Refused: ${why}`), true as const);
    const problem = this.problem(p, this.allowedRedirects());
    if (problem) return refuse(problem);
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("state", p.get("state")!);
    back.searchParams.set("iss", this.issuer);
    if (p.get("choice") === "cancel") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "Cancelled at the FaceVisa demo identity");
      return redirect(back.toString());
    }
    // Always a new random person: never a subject typed into the form or asked for by anyone.
    if (this.o.newPerson && !this.o.newPerson(ip)) return refuse("this network has made its demo people for today; try again tomorrow");
    back.searchParams.set("code", this.code(p, `demo_${randomBytes(16).toString("hex")}`, Math.floor(Date.now() / 1000), ["demo"]));
    return redirect(back.toString());
  }

  private async token(req: IncomingMessage, res: ServerResponse, f: URLSearchParams): Promise<true> {
    const json = (status: number, b: unknown) => (res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(b)), true as const);
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.secret)}`).toString("base64")}`;
    if (req.headers.authorization !== basic) return json(401, { error: "invalid_client" });
    const c = this.codes.get(f.get("code") ?? "");
    this.codes.delete(f.get("code") ?? ""); // single use
    if (!c || c.expiresAt < Date.now() || f.get("grant_type") !== "authorization_code" || f.get("redirect_uri") !== c.redirectUri) return json(400, { error: "invalid_grant" });
    if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: c.nonce, auth_time: c.authTime, amr: c.amr, acr: this.demo ? "demo" : "standin", azp: this.clientId })
      .setProtectedHeader({ alg: "RS256", kid: this.kid, typ: "JWT" })
      .setIssuer(this.issuer)
      .setSubject(c.sub)
      .setAudience(this.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(this.key);
    return json(200, { access_token: randomBytes(16).toString("base64url"), token_type: "Bearer", expires_in: 300, id_token: idToken });
  }
}
