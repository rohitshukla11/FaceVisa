/**
 * Accounts on this server (World ID sign-in, keyed on the ID token's (iss, sub)), their sessions and single-use World ID
 * attempts, and each account's creator profile (photo with consent, optional YouTube channel). One World ID is one
 * account with both a creator profile and a brand workspace. SQLite on disk; Likeness's own records (listings,
 * requests, licences) are in likeness/data.ts on the same connection.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "brand" | "creator";

export interface Account {
  uid: string;
  /** The World ID issuer and subject this account belongs to (sandbox and production never mix). */
  iss: string;
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  role: Role | null;
}

/** A creator profile: the consented photo and an optional verified YouTube channel. */
export interface CreatorRow {
  uid: string;
  name: string;
  youtubeChannelId: string | null;
  youtubeTitle: string | null;
  youtubeThumbnail: string | null;
  youtubeVerifiedAt: number | null;
  youtubeSubscribers: number | null;
  /** JSON: the channel's topic names (from YouTube's topicDetails). */
  youtubeTopics: string | null;
  /** JSON: public image URLs (the profile picture and up to 5 recent video thumbnails) for the face match. */
  youtubeImages: string | null;
  /** JSON: the channel face match against the live capture (counts, best score, badge). */
  youtubeFace: string | null;
  photoFile: string | null;
  photoMime: string | null;
  photoSha256: string | null;
  consentAt: number | null;
  /** The live capture's frames (front, slight left, slight right), file names; the front one is photoFile. */
  captureFiles: string | null;
  /** The browser's liveness result for that capture (JSON: blinks, turned left/right, when). */
  liveness: string | null;
  createdAt: number;
}

const SCHEMA = `
create table if not exists accounts (
  uid text primary key, iss text not null, sub text not null, email text not null, name text not null, picture text, role text,
  created_at integer not null, unique (iss, sub)
);
create table if not exists creator_profiles (
  uid text primary key references accounts(uid), name text not null,
  youtube_channel_id text unique, youtube_title text, youtube_thumbnail text, youtube_verified_at integer,
  youtube_subscribers integer, youtube_topics text, youtube_images text, youtube_face text,
  photo_file text, photo_mime text, photo_sha256 text, consent_at integer, capture_files text, liveness text,
  created_at integer not null
);
create table if not exists meta (key text primary key, value text not null);
create table if not exists oidc_attempts (
  state text primary key, purpose text not null, nonce text not null, verifier text not null, return_to text,
  action_id text, uid text, created_at integer not null, expires_at integer not null, used_at integer, redirect_uri text
);
create table if not exists sessions (id text primary key, uid text not null references accounts(uid), created_at integer not null, expires_at integer not null);
`;

const COLS: Record<keyof CreatorRow, string> = {
  uid: "uid",
  name: "name",
  youtubeChannelId: "youtube_channel_id",
  youtubeTitle: "youtube_title",
  youtubeThumbnail: "youtube_thumbnail",
  youtubeVerifiedAt: "youtube_verified_at",
  youtubeSubscribers: "youtube_subscribers",
  youtubeTopics: "youtube_topics",
  youtubeImages: "youtube_images",
  youtubeFace: "youtube_face",
  photoFile: "photo_file",
  photoMime: "photo_mime",
  photoSha256: "photo_sha256",
  consentAt: "consent_at",
  captureFiles: "capture_files",
  liveness: "liveness",
  createdAt: "created_at",
};

/** An account's id: an opaque hash of the World ID issuer and subject. */
export const accountUid = (iss: string, sub: string) => `wid_${createHash("sha256").update(`${iss}\n${sub}`).digest("hex").slice(0, 32)}`;

/** A World ID attempt taken (once) at the callback. */
export interface OidcAttempt {
  state: string;
  purpose: "signin" | "checkpoint" | "spend" | "youtube";
  nonce: string;
  verifier: string;
  returnTo: string | null;
  actionId: string | null;
  uid: string | null;
  createdAt: number;
  redirectUri: string | null;
  /** The provider this sign-in went to (null for attempts from before it was recorded). */
  issuer: string | null;
}

export class Accounts {
  /** Shared with the Likeness data layer (likeness/data.ts), so one transaction can span both. */
  readonly db: DatabaseSync;

  /** file: a path on disk, or ":memory:". */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
    // Databases made before a column existed get it (local databases persist across versions).
    const cols = (t: string) => new Set((this.db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols("oidc_attempts").has("redirect_uri")) this.db.exec("alter table oidc_attempts add column redirect_uri text");
    if (!cols("oidc_attempts").has("issuer")) this.db.exec("alter table oidc_attempts add column issuer text");
    // B4: the account's Hedera account (created from its custodial key), stored with the account.
    if (!cols("accounts").has("hedera_account_id")) this.db.exec("alter table accounts add column hedera_account_id text");
    const have = cols("creator_profiles");
    for (const [c, type] of [["capture_files", "text"], ["liveness", "text"], ["youtube_subscribers", "integer"], ["youtube_topics", "text"], ["youtube_images", "text"], ["youtube_face", "text"]]) {
      if (!have.has(c!)) this.db.exec(`alter table creator_profiles add column ${c} ${type}`);
    }
  }

  /**
   * The account for a validated World ID sign-in, created on first sign-in and keyed on (iss, sub): the guide's
   * "use (iss, sub) as the World ID account identifier". The uid is an opaque hash of both, never the raw sub.
   */
  signIn(iss: string, sub: string): Account {
    const uid = accountUid(iss, sub);
    this.db.prepare("insert into accounts (uid, iss, sub, email, name, picture, created_at) values (?, ?, ?, '', '', null, ?) on conflict(iss, sub) do nothing").run(uid, iss, sub, Date.now());
    return this.accountBySubject(iss, sub)!;
  }

  accountBySubject(iss: string, sub: string): Account | undefined {
    const r = this.db.prepare("select uid, iss, sub, email, name, picture, role from accounts where iss = ? and sub = ?").get(iss, sub) as Account | undefined;
    return r ? { ...r } : undefined;
  }

  /** Every account from one issuer (the local World ID stand-in lists its identities). */
  accountsByIssuer(iss: string): Account[] {
    return (this.db.prepare("select uid, iss, sub, email, name, picture, role from accounts where iss = ? order by created_at").all(iss) as unknown as Account[]).map((r) => ({ ...r }));
  }

  account(uid: string): Account | undefined {
    const r = this.db.prepare("select uid, iss, sub, email, name, picture, role from accounts where uid = ?").get(uid) as Account | undefined;
    return r ? { ...r } : undefined;
  }

  /** The account's Hedera account ID (e.g. 0.0.123), if one was created. */
  hederaAccount(uid: string): string | null {
    return ((this.db.prepare("select hedera_account_id from accounts where uid = ?").get(uid) as { hedera_account_id: string | null } | undefined)?.hedera_account_id) ?? null;
  }

  setHederaAccount(uid: string, accountId: string) {
    this.db.prepare("update accounts set hedera_account_id = ? where uid = ?").run(accountId, uid);
  }

  /** The display name a person gives once, when they first set up (World ID shares no name). */
  setName(uid: string, name: string): Account {
    this.db.prepare("update accounts set name = ? where uid = ?").run(name, uid);
    return this.account(uid)!;
  }

  // ---------------------------------------------------------------- sign-in attempts and sessions

  /** A World ID attempt: its state, nonce and PKCE verifier, kept server-side until used once or expired. */
  /**
   * redirectUri: the callback this attempt's authorization request named; the code exchange must repeat it. One
   * callback URL can serve sign-in and the Agent Pass checkpoint: the attempt bound to the state says which.
   */
  createAttempt(a: { state: string; purpose: "signin" | "checkpoint" | "spend" | "youtube"; nonce: string; verifier: string; ttlMs: number; redirectUri?: string; returnTo?: string; actionId?: string; uid?: string; issuer?: string; now?: number }) {
    const now = a.now ?? Date.now();
    if (a.purpose !== "signin" && a.actionId) {
      // Only the newest check of this kind for a request can complete: older, unused attempts for it end here.
      this.db.prepare("update oidc_attempts set used_at = ? where action_id = ? and purpose = ? and used_at is null").run(now, a.actionId, a.purpose);
    }
    this.db
      .prepare("insert into oidc_attempts (state, purpose, nonce, verifier, return_to, action_id, uid, created_at, expires_at, redirect_uri, issuer) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.state, a.purpose, a.nonce, a.verifier, a.returnTo ?? null, a.actionId ?? null, a.uid ?? null, now, now + a.ttlMs, a.redirectUri ?? null, a.issuer ?? null);
  }

  /** Local development only (the World ID stand-in's "expired attempt"): ages an unused attempt past its expiry. */
  expireAttempt(state: string) {
    this.db.prepare("update oidc_attempts set expires_at = ? where state = ? and used_at is null").run(Date.now() - 1, state);
  }

  /** An unused attempt, without taking it (the World ID stand-in shows what it is for). */
  peekAttempt(state: string): { purpose: "signin" | "checkpoint" | "spend" | "youtube"; actionId: string | null; uid: string | null } | undefined {
    const r = this.db.prepare("select purpose, action_id, uid from oidc_attempts where state = ? and used_at is null").get(state) as { purpose: "signin" | "checkpoint" | "spend" | "youtube"; action_id: string | null; uid: string | null } | undefined;
    return r && { purpose: r.purpose, actionId: r.action_id, uid: r.uid };
  }

  /**
   * Takes an attempt by its state, once: the row is marked used in the same statement, so a reused or
   * concurrent callback finds nothing. "unknown" covers both never-issued and already-used states.
   */
  takeAttempt(state: string):
    | { ok: true; attempt: OidcAttempt }
    | { ok: false; reason: "unknown" | "expired"; purpose?: "signin" | "checkpoint" | "spend" | "youtube"; actionId?: string | null } {
    const now = Date.now();
    const r = this.db
      .prepare("update oidc_attempts set used_at = ? where state = ? and used_at is null returning purpose, nonce, verifier, return_to, action_id, uid, created_at, expires_at, redirect_uri, issuer")
      .get(now, state) as { purpose: "signin" | "checkpoint" | "spend" | "youtube"; nonce: string; verifier: string; return_to: string | null; action_id: string | null; uid: string | null; created_at: number; expires_at: number; redirect_uri: string | null; issuer: string | null } | undefined;
    if (!r) return { ok: false, reason: "unknown" };
    if (r.expires_at < now) return { ok: false, reason: "expired", purpose: r.purpose, actionId: r.action_id };
    return { ok: true, attempt: { state, purpose: r.purpose, nonce: r.nonce, verifier: r.verifier, returnTo: r.return_to, actionId: r.action_id, uid: r.uid, createdAt: r.created_at, redirectUri: r.redirect_uri, issuer: r.issuer } };
  }

  createSession(id: string, uid: string, ttlMs: number) {
    const now = Date.now();
    this.db.prepare("delete from sessions where expires_at <= ?").run(now);
    this.db.prepare("insert into sessions (id, uid, created_at, expires_at) values (?, ?, ?, ?)").run(id, uid, now, now + ttlMs);
  }

  sessionAccount(id: string): Account | undefined {
    const r = this.db.prepare("select uid from sessions where id = ? and expires_at > ?").get(id, Date.now()) as { uid: string } | undefined;
    return r ? this.account(r.uid) : undefined;
  }

  endSession(id: string) {
    this.db.prepare("delete from sessions where id = ?").run(id);
  }

  /**
   * The workspace the account is looking at: one World ID is one account with both a creator profile and a brand
   * workspace, so this is a view the person switches, not a permission. Permissions follow ownership.
   */
  setRole(uid: string, role: Role): Account {
    const a = this.account(uid);
    if (!a) throw new Error("no such account");
    this.db.prepare("update accounts set role = ? where uid = ?").run(role, uid);
    return { ...a, role };
  }
  // ---------------------------------------------------------------- creator profiles

  private row(r: unknown): CreatorRow | undefined {
    if (!r) return undefined;
    const o = r as Record<string, unknown>;
    return Object.fromEntries(Object.entries(COLS).map(([k, c]) => [k, o[c] ?? null])) as unknown as CreatorRow;
  }

  creator(uid: string): CreatorRow | undefined {
    return this.row(this.db.prepare("select * from creator_profiles where uid = ?").get(uid));
  }

  createCreator(uid: string, name: string): CreatorRow {
    this.db.prepare("insert into creator_profiles (uid, name, created_at) values (?, ?, ?) on conflict(uid) do nothing").run(uid, name, Date.now());
    return this.creator(uid)!;
  }

  updateCreator(uid: string, patch: Partial<Omit<CreatorRow, "uid" | "createdAt">>): CreatorRow {
    const entries = Object.entries(patch).filter(([k]) => k in COLS && k !== "uid");
    if (entries.length) this.db.prepare(`update creator_profiles set ${entries.map(([k]) => `${COLS[k as keyof CreatorRow]} = ?`).join(", ")} where uid = ?`).run(...(entries.map(([, v]) => v ?? null) as (string | number | null)[]), uid);
    return this.creator(uid)!;
  }

  creatorByChannel(channelId: string): CreatorRow | undefined {
    return this.row(this.db.prepare("select * from creator_profiles where youtube_channel_id = ?").get(channelId));
  }
}
