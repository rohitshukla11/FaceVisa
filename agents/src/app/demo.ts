/**
 * The public demo (LIKENESS_PUBLIC_DEMO=1): the deployed server, for judges who can't sign in with World ID yet. Demo
 * identities come from a second issuer (standin.ts, flavour "demo") next to real World ID, in their own Arkiv
 * namespace (likeness-eth-public), labelled "demo" everywhere. This module holds what the demo adds on top:
 *
 * - Daily limits per visitor (new demo people, images, videos), keyed by an HMAC of the IP that changes every day, so
 *   no IP address is stored. They live in the database: a restart doesn't reset them.
 * - Testnet USDC for demo brands: the operator tops a brand up when it can't cover an approved ad (at least 0.30 USDC,
 *   at most 1 USDC per brand in all, 5 USDC a day across the site), and a daily cap on new Hedera accounts.
 * - Retention: a demo creator's capture and the ads made of them are deleted 48 hours after they were made (Arkiv only
 *   ever held hashes). Seeded demo creators are kept.
 */
import { isGoogleIssuer } from "./google.js";
import { createHmac } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Accounts } from "./accounts.js";
import { DEMO_PATH } from "./standin.js";
import type { RenderStore } from "./store.js";
import type { LikenessData } from "../likeness/data.js";

export const publicDemoWanted = (env = process.env) => env.LIKENESS_PUBLIC_DEMO === "1";
export const DEMO_RETENTION_MS = 48 * 3600 * 1000;

/**
 * What's limited per network (IP) per UTC day: new accounts only. Images and videos are limited per account (the brand
 * workspace caps) and across the site (the site caps), not per network: judges share the venue's Wi-Fi (Rohit, 5 Nov).
 */
export type DemoKind = "identity";

export interface DemoConfig {
  /** Per visitor (IP) per UTC day. */
  perIp: Record<DemoKind, number>;
  /** New Hedera accounts across the site per UTC day (each one costs the operator testnet HBAR). */
  hederaAccountsPerDay: number;
  /** A top-up: at least this much (USDC's smallest units). */
  topUpUnits: bigint;
  /** At most this much in top-ups per brand, in all. */
  topUpPerBrand: bigint;
  /** At most this much in top-ups across the site per UTC day. */
  topUpPerDay: bigint;
}

const int = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
export function demoConfigFromEnv(env = process.env): DemoConfig {
  return {
    perIp: { identity: int(env.LIKENESS_DEMO_IP_IDENTITIES, 3) },
    hederaAccountsPerDay: int(env.LIKENESS_DEMO_HEDERA_ACCOUNTS, 30),
    topUpUnits: 300_000n,
    topUpPerBrand: 1_000_000n,
    topUpPerDay: 5_000_000n,
  };
}

/** A demo identity: signed in through the public demo's issuer. */
export const isDemoIssuer = (iss: string | undefined) => !!iss && iss.endsWith(DEMO_PATH);
/** A public account on the public demo: a demo identity, or a Google sign-in (both get the demo's protections). */
export const isPublicAccount = (iss: string | undefined) => isDemoIssuer(iss) || isGoogleIssuer(iss);

const SCHEMA = `
create table if not exists demo_usage (day text not null, key text not null, kind text not null, n integer not null, primary key (day, key, kind));
create table if not exists demo_topups (at integer not null, day text not null, brand text not null, account text not null, units integer not null, tx text not null);
create table if not exists demo_keep (uid text primary key, why text not null);
create table if not exists demo_deleted (at integer not null, what text not null, ref text not null);
`;

export class Demo {
  constructor(
    private readonly db: DatabaseSync,
    readonly config: DemoConfig,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  private day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** The visitor's key for today: an HMAC of the IP and the day (never the IP itself). */
  private visitor(ip: string) {
    return createHmac("sha256", this.secret).update(`${this.day()}\n${ip}`).digest("base64url").slice(0, 32);
  }

  /** One more of `kind` for this key today, if under `limit`: atomic, so two tabs can't both take the last one. */
  private take(key: string, kind: string, limit: number): boolean {
    if (limit <= 0) return false;
    const r = this.db.prepare("insert into demo_usage (day, key, kind, n) values (?, ?, ?, 1) on conflict (day, key, kind) do update set n = n + 1 where n < ?").run(this.day(), key, kind, limit);
    return Number(r.changes) === 1;
  }

  private used(key: string, kind: string): number {
    return Number((this.db.prepare("select n from demo_usage where day = ? and key = ? and kind = ?").get(this.day(), key, kind) as { n: number } | undefined)?.n ?? 0);
  }

  /** Whether this visitor may have one more `kind` today (doesn't count it). */
  allows(ip: string, kind: DemoKind): boolean {
    return this.used(this.visitor(ip), kind) < this.config.perIp[kind];
  }

  /** Counts one more `kind` for this visitor today; false when the day's limit is reached. */
  takeFor(ip: string, kind: DemoKind): boolean {
    return this.take(this.visitor(ip), kind, this.config.perIp[kind]);
  }

  /** One more new Hedera account today across the site; false when the day's cap is reached. */
  takeHederaAccount(): boolean {
    return this.take("site", "hedera-account", this.config.hederaAccountsPerDay);
  }

  /** How much to top a demo brand up by now, or why it can't be: within the per-brand and the day's limits. */
  topUpFor(brand: string, have: bigint, price: bigint): { units: bigint } | { refused: string } {
    const need = price - have;
    if (need <= 0n) return { units: 0n };
    const units = need > this.config.topUpUnits ? need : this.config.topUpUnits;
    const brandSoFar = BigInt((this.db.prepare("select coalesce(sum(units), 0) as n from demo_topups where brand = ?").get(brand) as { n: number }).n);
    if (brandSoFar + units > this.config.topUpPerBrand) return { refused: `this demo brand has had its ${usdc(this.config.topUpPerBrand)} of testnet USDC` };
    const today = BigInt((this.db.prepare("select coalesce(sum(units), 0) as n from demo_topups where day = ?").get(this.day()) as { n: number }).n);
    if (today + units > this.config.topUpPerDay) return { refused: `the demo's testnet USDC for today (${usdc(this.config.topUpPerDay)}) is used up; try again tomorrow` };
    return { units };
  }

  recordTopUp(brand: string, account: string, units: bigint, tx: string) {
    this.db.prepare("insert into demo_topups (at, day, brand, account, units, tx) values (?, ?, ?, ?, ?, ?)").run(this.now(), this.day(), brand, account, Number(units), tx);
  }

  /** A seeded demo account: never cleaned up. */
  keep(uid: string, why: string) {
    this.db.prepare("insert into demo_keep (uid, why) values (?, ?) on conflict (uid) do update set why = excluded.why").run(uid, why);
  }

  private kept(uid: string) {
    return !!this.db.prepare("select 1 from demo_keep where uid = ?").get(uid);
  }

  /** A seeded demo account (public-seed.ts): nobody can sign in as it, so requests to a seeded creator go unanswered. */
  seeded(uid: string): boolean {
    return this.kept(uid);
  }

  /** When a render was deleted by the retention rule, if it was. */
  deletedAt(hash: string): number | undefined {
    const r = this.db.prepare("select at from demo_deleted where what = 'ad' and ref = ?").get(hash.toLowerCase()) as { at: number } | undefined;
    return r ? Number(r.at) : undefined;
  }

  /**
   * The 48-hour rule: a demo creator's capture (photos on disk, cleared on the profile, and unlisted) and every ad made
   * of a demo creator, 48 hours after each was made. Seeded creators are kept. Returns what it deleted.
   */
  cleanup(o: { accounts: Accounts; data: LikenessData; store: RenderStore; photosDir: string; log?: (line: string) => void }): { captures: number; ads: number } {
    const cutoff = this.now() - DEMO_RETENTION_MS;
    const log = o.log ?? ((l: string) => console.log(l));
    const demoCreator = (uid: string) => isPublicAccount(o.accounts.account(uid)?.iss) && !this.kept(uid);
    let captures = 0;
    const rows = this.db.prepare("select uid, photo_file, capture_files, consent_at from creator_profiles where consent_at is not null and consent_at < ? and (photo_file is not null or capture_files is not null)").all(cutoff) as { uid: string; photo_file: string | null; capture_files: string | null; consent_at: number }[];
    for (const r of rows) {
      if (!demoCreator(r.uid)) continue;
      const files = [r.photo_file, ...(r.capture_files ? (JSON.parse(r.capture_files) as string[]) : [])].filter((f): f is string => !!f);
      for (const f of new Set(files)) {
        const p = join(o.photosDir, f);
        if (existsSync(p)) rmSync(p);
      }
      o.accounts.updateCreator(r.uid, { photoFile: null, photoMime: null, photoSha256: null, captureFiles: null, liveness: null, consentAt: null });
      if (o.data.listingRecord(r.uid)?.listed) o.data.unlist(r.uid);
      this.db.prepare("insert into demo_deleted (at, what, ref) values (?, 'capture', ?)").run(this.now(), r.uid);
      captures++;
    }
    let ads = 0;
    for (const r of this.db.prepare("select creator, output from pending_actions where output is not null").all() as { creator: string; output: string }[]) {
      const out = JSON.parse(r.output) as { hash: string; createdAt: number };
      if (out.createdAt >= cutoff || !demoCreator(r.creator) || this.deletedAt(out.hash) !== undefined) continue;
      o.store.remove(out.hash as `0x${string}`);
      this.db.prepare("insert into demo_deleted (at, what, ref) values (?, 'ad', ?)").run(this.now(), out.hash.toLowerCase());
      ads++;
    }
    log(`[demo] retention: deleted ${captures} demo creator capture${captures === 1 ? "" : "s"} and ${ads} ad${ads === 1 ? "" : "s"} made over 48 hours ago (Arkiv holds only their hashes)`);
    return { captures, ads };
  }
}

const usdc = (units: bigint) => `${(Number(units) / 1e6).toFixed(2)} USDC`;
