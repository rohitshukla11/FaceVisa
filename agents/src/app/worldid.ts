/**
 * World ID sign-in (OpenID Connect, https://auth.world.org/docs/guides/oidc). This backend is the confidential
 * client: the authorization code flow with PKCE S256, a fresh state and nonce per attempt (kept server-side,
 * single use), the code exchanged with client_secret_basic or private_key_jwt (a signed client assertion
 * instead of a shared secret; both are in the sandbox's token_endpoint_auth_methods_supported), and the ID
 * token validated here (RS256 against the
 * issuer's JWKS, iss, aud, azp, exp, iat, nonce). Endpoints and keys come from the issuer's discovery document.
 * Nothing from the browser counts as proof: only an ID token this backend obtained and validated.
 *
 * The guide: "Treat an authorization error as a failure, never as success"; "Each code can be used once and
 * expires after five minutes"; "Never log request bodies, Authorization headers, or callback query strings."
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateJwkThumbprint, createRemoteJWKSet, exportJWK, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/** The validated ID token's claims this app uses. */
export interface WorldIdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  authTime: number | undefined;
  acr: string | undefined;
  amr: string[];
  nonce: string;
  /** The person's name, when the provider sends it (Google, with the "profile" scope). */
  name?: string;
}

/** The private_key_jwt key and the kid it was registered under (its RFC 7638 thumbprint). */
export interface ClientSigningKey {
  key: KeyObject;
  kid: string;
}

export interface WorldIdConfig {
  issuer: string;
  clientId: string;
  /** client_secret_basic. Exactly one of clientSecret and signingKey. */
  clientSecret?: string;
  /** private_key_jwt. */
  signingKey?: ClientSigningKey;
  fetch?: typeof fetch;
  /** Tests inject their own keys; otherwise the discovery document's jwks_uri. */
  keys?: JWTVerifyGetKey;
  /** Unix seconds. */
  now?: () => number;
  /** The scopes asked for (default "openid"). */
  scope?: string;
}

/** Why a sign-in or checkpoint didn't produce a validated identity. Safe to show; carries no token or secret. */
export class WorldIdError extends Error {
  constructor(
    readonly reason: "cancelled" | "error" | "unknown_state" | "expired_state" | "wrong_issuer" | "exchange_failed" | "invalid_token",
    message: string,
  ) {
    super(message);
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** PKCE: a 43-character verifier and its S256 challenge (RFC 7636). */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const CLOCK_SKEW = 60; // seconds of tolerance for iat in the future

export class WorldId {
  private discovered?: Promise<Discovery>;
  private keys?: JWTVerifyGetKey;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly c: WorldIdConfig) {
    if (!c.clientSecret === !c.signingKey) throw new Error("World ID: set exactly one of a client secret (client_secret_basic) and a signing key (private_key_jwt)");
    this.fetchFn = c.fetch ?? fetch;
    this.keys = c.keys;
  }

  get issuer() {
    return this.c.issuer;
  }

  get authMethod(): "client_secret_basic" | "private_key_jwt" {
    return this.c.signingKey ? "private_key_jwt" : "client_secret_basic";
  }

  /** The discovery document, fetched once; its issuer must be exactly the configured one. */
  discovery(): Promise<Discovery> {
    return (this.discovered ??= (async () => {
      const res = await this.fetchFn(`${this.c.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`World ID discovery failed: HTTP ${res.status}`);
      const d = (await res.json()) as Discovery;
      if (d.issuer !== this.c.issuer) throw new Error(`World ID discovery names issuer ${d.issuer}, not ${this.c.issuer}`);
      for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) if (!d[k]) throw new Error(`World ID discovery has no ${k}`);
      if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes("S256")) throw new Error("World ID discovery doesn't offer PKCE S256");
      return d;
    })().catch((e) => {
      this.discovered = undefined; // try again next time
      throw e;
    }));
  }

  /** The issuer's signing keys: cached by jose, refetched when a token names an unknown kid. */
  private async signingKeys(): Promise<JWTVerifyGetKey> {
    return (this.keys ??= createRemoteJWKSet(new URL((await this.discovery()).jwks_uri)));
  }

  /**
   * The authorization request. maxAge 0 forces a fresh authentication (Agent Pass checkpoint); claims asks
   * for a specific subject ("A requested claims.id_token.sub value must match the authenticating account").
   */
  async authorizeUrl(o: { redirectUri: string; state: string; nonce: string; codeChallenge: string; maxAge?: number; sub?: string }): Promise<string> {
    const d = await this.discovery();
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: this.c.clientId,
      redirect_uri: o.redirectUri,
      scope: this.c.scope ?? "openid",
      state: o.state,
      nonce: o.nonce,
      code_challenge: o.codeChallenge,
      code_challenge_method: "S256",
      ...(o.maxAge !== undefined ? { max_age: String(o.maxAge) } : {}),
      ...(o.sub ? { claims: JSON.stringify({ id_token: { sub: { value: o.sub } } }) } : {}),
    }).toString();
    return u.toString();
  }

  /**
   * The code exchange. client_secret_basic: the form-encoded client ID and secret in the Authorization header
   * ("remove the secret from the body and send Basic authentication instead"). private_key_jwt: a client
   * assertion signed with our key (iss = sub = the client ID, aud = the token endpoint, a fresh jti, 2 minutes).
   */
  async exchange(o: { code: string; redirectUri: string; codeVerifier: string }): Promise<string> {
    const d = await this.discovery();
    const form = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.codeVerifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.c.signingKey) {
      form.set("client_id", this.c.clientId);
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", await this.clientAssertion(d.token_endpoint));
    } else {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.c.clientId)}:${encodeURIComponent(this.c.clientSecret!)}`).toString("base64")}`;
    }
    let res: Response;
    try {
      res = await this.fetchFn(d.token_endpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WorldIdError("exchange_failed", "World ID didn't answer the code exchange; sign in again");
    }
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    // invalid_grant and other errors: a failure; never replay the code ("Start a new authentication attempt").
    if (!res.ok || !body.id_token) throw new WorldIdError("exchange_failed", `World ID refused the code exchange${body.error ? ` (${body.error})` : ""}; sign in again`);
    return body.id_token;
  }

  private clientAssertion(tokenEndpoint: string): Promise<string> {
    const { key, kid } = this.c.signingKey!;
    const now = this.c.now?.() ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
      .setIssuer(this.c.clientId)
      .setSubject(this.c.clientId)
      .setAudience(tokenEndpoint)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(key);
  }

  /** Validates an ID token: RS256 with the issuer's keys, iss, aud, azp, exp, iat, and the attempt's nonce. */
  async validate(idToken: string, expectedNonce: string): Promise<WorldIdClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, await this.signingKeys(), {
        issuer: this.c.issuer,
        audience: this.c.clientId,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        ...(this.c.now ? { currentDate: new Date(this.c.now() * 1000) } : {}),
      }));
    } catch (e) {
      throw new WorldIdError("invalid_token", `the World ID token isn't valid (${(e as { code?: string }).code ?? "invalid"})`);
    }
    const p = payload as JWTPayload & { nonce?: unknown; azp?: unknown; auth_time?: unknown; acr?: unknown; amr?: unknown };
    const now = this.c.now?.() ?? Math.floor(Date.now() / 1000);
    if (typeof p.nonce !== "string" || p.nonce !== expectedNonce) throw new WorldIdError("invalid_token", "the World ID token's nonce doesn't match this sign-in attempt");
    if (p.azp !== undefined && p.azp !== this.c.clientId) throw new WorldIdError("invalid_token", "the World ID token was issued to another client");
    if (Array.isArray(p.aud) && p.aud.length > 1 && p.azp === undefined) throw new WorldIdError("invalid_token", "the World ID token has several audiences and no azp");
    if ((p.iat ?? 0) > now + CLOCK_SKEW) throw new WorldIdError("invalid_token", "the World ID token was issued in the future");
    if (typeof p.sub !== "string" || !p.sub) throw new WorldIdError("invalid_token", "the World ID token has no subject");
    return {
      iss: p.iss!,
      sub: p.sub,
      aud: p.aud!,
      iat: p.iat!,
      exp: p.exp!,
      authTime: typeof p.auth_time === "number" ? p.auth_time : undefined,
      acr: typeof p.acr === "string" ? p.acr : undefined,
      amr: Array.isArray(p.amr) ? p.amr.filter((x): x is string => typeof x === "string") : [],
      nonce: p.nonce,
      ...(typeof (p as { name?: unknown }).name === "string" ? { name: (p as { name: string }).name } : {}),
    };
  }
}

/** An RSA private key (PEM) for private_key_jwt, with its RFC 7638 thumbprint as the kid. */
export async function clientSigningKey(pem: string | Buffer): Promise<ClientSigningKey> {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("World ID: the private_key_jwt key must be RSA (RS256)");
  return { key, kid: await calculateJwkThumbprint(await exportJWK(createPublicKey(key)), "sha256") };
}

/**
 * World ID from the environment, or undefined when it isn't configured (sign-in is then unavailable).
 * WORLDID_PRIVATE_KEY_FILE (a PEM path) selects private_key_jwt; otherwise WORLDID_CLIENT_SECRET, client_secret_basic.
 */
export async function worldIdFromEnv(): Promise<WorldId | undefined> {
  const issuer = process.env.WORLDID_ISSUER;
  const clientId = process.env.WORLDID_CLIENT_ID;
  const keyFile = process.env.WORLDID_PRIVATE_KEY_FILE;
  const clientSecret = process.env.WORLDID_CLIENT_SECRET;
  if (!issuer || !clientId || (!keyFile && !clientSecret)) return undefined;
  if (keyFile) return new WorldId({ issuer, clientId, signingKey: await clientSigningKey(readFileSync(keyFile)) });
  return new WorldId({ issuer, clientId, clientSecret });
}
