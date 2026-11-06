/**
 * The Arkiv outbox: SQLite stays the authority, and Arkiv mirrors its public state after each commit.
 *
 * Each change to a listing, request, licence or receipt queues one item, "bring this record's entity up to date",
 * at most one waiting item per record. A single worker handles one item at a time. It works out what the entity
 * should hold now, compares that with what it last wrote (kept in arkiv_entities), and sends only the difference:
 * a create, a patch of the columns that changed, an extension, or nothing at all. Writing the same thing twice is
 * impossible by construction, and a burst of changes becomes one write.
 *
 * An item's life: pending → sending → done; or → pending again with backoff, if nothing was broadcast; or →
 * uncertain once a signed transaction's hash was stored, which is only ever reconciled from that hash (its
 * receipt, or the entity found by owner and `ref`), never re-sent. Repeated failures before broadcast, or a
 * reverted receipt, end in failed. Failures never block the product flow; the UI and the logs show them.
 *
 * Account keys get a capped top-up from the funder before their first write ("fund" items, same rules).
 *
 * Each creator's and brand's running stats are records too (creator_stats, brand_stats): queued with every change
 * to their listings, licences and payments, and re-planned by the hourly sweep (licences end by the clock), so they
 * are patched only when a number changed and their lifetime is renewed while they're in use.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ExpirationTime, type Expiry } from "@arkiv-network/sdk";
import { formatEther, parseEther, type Hex } from "viem";
import type { Accounts } from "../app/accounts.js";
import type { Keystore } from "../app/keystore.js";
import type { DataChange, FaceVisaData, PendingAction } from "../facevisa/data.js";
import { MAX_DAYS_LIMIT } from "../facevisa/rules.js";
import { scrub, type ArkivClient, type ArkivConfig, type Ops } from "./chain.js";
import { arkivSchemas, brandStatsValues, changed, creatorStatsValues, licenceValues, listingValues, receiptValues, requestValues, revocationValues, typed, type ArkivSchemas, type EntityKind, type Identity, type Plain, type RequestStatus } from "./schema.js";

type ItemKind = EntityKind | "fund";
type ItemStatus = "pending" | "sending" | "uncertain" | "done" | "failed";

interface Item {
  seq: number;
  ref: string;
  kind: ItemKind;
  subject: string;
  status: ItemStatus;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  signer: string | null;
  intent: Intent | null;
  nonce: number | null;
  txHash: Hex | null;
  sentAt: number | null;
  createdAt: number;
}

/** What a send was meant to do, stored before signing: how to record it once it's confirmed. */
type Intent =
  | { op: "create" | "update" | "delete"; owner: Hex; ref: string; values: Plain; expiresAt: number; entityKey?: Hex }
  | { op: "transfer"; to: Hex; value: string };

export interface Entity {
  kind: EntityKind;
  subject: string;
  entityKey: Hex;
  owner: Hex;
  ref: string;
  values: Plain;
  /** When it expires on Arkiv (ms; from the lifetime we asked for). */
  expiresAt: number;
  txHash: Hex;
}

/** What the UI says about a record's mirror on Arkiv. */
export type SyncStatus =
  | { state: "off" }
  | { state: "synced"; entityKey: Hex; url: string; txHash: string }
  | { state: "pending"; entityKey?: Hex; url?: string; note?: string }
  | { state: "failed"; error: string; entityKey?: Hex; url?: string }
  | { state: "none"; note?: string };

/** A plan for one item: send, skip (nothing to write), wait (a dependency or funding), or fail. */
type Plan =
  | { do: "send"; signer: string; ops: Ops; intent: Intent }
  | { do: "transfer"; to: Hex; value: bigint }
  | { do: "skip"; note: string }
  | { do: "wait"; note: string; ms?: number }
  | { do: "fail"; error: string };

const DAY = 86_400_000;
/** A listing lives 30 days and is extended while its creator stays listed, once it has less than half of that left. */
const LISTING_MS = 30 * DAY;
/** A creator's or brand's stats entity lives 30 days, renewed while it's in use. */
const STATS_MS = 30 * DAY;
/** How long a receipt waits for its file's Swarm upload before it's written without a reference. */
const SWARM_WAIT_MS = 15 * 60_000;
/** An entity can't outlive this (7,884,000 blocks of 2 s), so a licence's expiry is clamped to it. */
const MAX_LIFETIME_MS = 7_884_000 * 2_000;
const MAX_ATTEMPTS = 8;
/** An account key with less than this gets a top-up before it writes (5 writes at 1,000,000 gas and 1 gwei). */
const MIN_BALANCE = parseEther("0.005");
const TOPUPS_PER_ADDRESS_PER_DAY = 2;
const TOPUPS_PER_DAY = 20;

const SCHEMA = `
create table if not exists arkiv_outbox (
  seq integer primary key autoincrement, ref text not null unique, kind text not null, subject text not null,
  status text not null, attempts integer not null default 0, next_at integer not null, last_error text, signer text,
  intent text, nonce integer, tx_hash text, sent_at integer, created_at integer not null, updated_at integer not null
);
create index if not exists arkiv_outbox_subject on arkiv_outbox (kind, subject, seq);
create index if not exists arkiv_outbox_due on arkiv_outbox (status, next_at);
create table if not exists arkiv_entities (
  kind text not null, subject text not null, entity_key text not null, owner text not null, ref text not null,
  vals text not null, expires_at integer not null, tx_hash text not null, updated_at integer not null,
  primary key (kind, subject)
);
`;

/** An open item that no earlier open item of the same record holds up. */
const OPEN_AND_FIRST = `o.status in ('pending', 'uncertain') and not exists (select 1 from arkiv_outbox p where p.kind = o.kind and p.subject = o.subject and p.seq < o.seq and p.status in ('pending', 'sending', 'uncertain'))`;

type Row = Record<string, unknown>;
const itemRow = (r: Row): Item => ({
  seq: Number(r.seq),
  ref: r.ref as string,
  kind: r.kind as ItemKind,
  subject: r.subject as string,
  status: r.status as ItemStatus,
  attempts: Number(r.attempts),
  nextAt: Number(r.next_at),
  lastError: (r.last_error as string | null) ?? null,
  signer: (r.signer as string | null) ?? null,
  intent: r.intent ? (JSON.parse(r.intent as string) as Intent) : null,
  nonce: r.nonce == null ? null : Number(r.nonce),
  txHash: (r.tx_hash as Hex | null) ?? null,
  sentAt: r.sent_at == null ? null : Number(r.sent_at),
  createdAt: Number(r.created_at),
});
const backoff = (attempts: number) => Math.min(5_000 * 2 ** Math.max(attempts - 1, 0), 10 * 60_000);

/** A request's status as Arkiv shows it; null for expired (an expired entity can't be patched, so it's never written). */
export function requestStatus(a: PendingAction): RequestStatus | null {
  switch (a.status) {
    case "generating":
      return a.generation > 1 ? "rejected" : "pending";
    case "review":
    case "verified":
      return "pending";
    case "approved":
    case "spend_review":
    case "spend_verified":
    case "paying":
    case "released":
      return "approved";
    case "denied":
    case "cancelled":
    case "failed":
      return a.status;
    case "expired":
      return null;
  }
}

export interface ArkivSyncOptions {
  db: DatabaseSync;
  data: FaceVisaData;
  accounts: Accounts;
  keystore: Keystore;
  client: ArkivClient;
  config: Pick<ArkivConfig, "prefix" | "explorerUrl" | "topup">;
  /** How an issuer's check is labelled (the same as Verify). */
  identityOf: (iss: string) => Identity;
  /** The real namespace (v1): nothing made with a test identity (the stand-in, DevConsent) is ever written. */
  realOnly?: boolean;
  /** A creator's Proof of Presence for the listing's label ("production", "sandbox", "none"); unset: no label. */
  presenceOf?: (uid: string) => string;
  /** The credential behind it ("selfie", "proof_of_human"), or null. */
  credentialOf?: (uid: string) => string | null;
  /** The ad's Swarm upload, when Swarm is on: the receipt waits for it (up to SWARM_WAIT_MS) and carries its reference. */
  swarmOf?: (hash: string) => { state: "pending" } | { state: "uploaded"; ref: string; encrypted: boolean } | { state: "failed"; error: string } | undefined;
  /** Creator and brand stats entities (default on); tests of the other entities turn them off to count writes. */
  stats?: boolean;
  /** How long a listing entity lives (default 30 days); it's renewed once under half is left. Minutes in dev only. */
  listingLifetimeMs?: number;
  /** Start the worker (default true; tests step it with `drain`). */
  autoRun?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class ArkivSync {
  readonly schemas: ArkivSchemas;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly o: ArkivSyncOptions) {
    this.schemas = arkivSchemas(o.config.prefix);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[arkiv] ${l}`));
    o.db.exec(SCHEMA);
    o.keystore.platformKey("funder");
    o.keystore.platformKey("receipt");
    // After a restart: a send that never stored its hash was never broadcast; one that did is reconciled.
    o.db.prepare("update arkiv_outbox set status = case when tx_hash is null then 'pending' else 'uncertain' end, next_at = ? where status = 'sending'").run(this.now());
    o.data.onChange = (c) => this.changed(c);
    if (o.autoRun ?? true) this.schedule(0);
  }

  // ---------------------------------------------------------------- queueing

  /** A committed change: queue its record (and, for a release, nothing else is needed: each record queues itself). */
  changed(c: DataChange) {
    if (c.kind === "listing") {
      this.enqueue("listing", c.uid);
      if (this.stats) this.enqueue("creator_stats", c.uid);
    } else if (c.kind === "request") this.enqueue("request", c.id);
    else if (c.kind === "licence") {
      this.enqueue("licence", c.id);
      const l = this.o.data.licence(c.id);
      // A revocation also gets its own record, owned by the creator, which outlives the licence entity.
      if (l?.status === "revoked") this.enqueue("revocation", c.id);
      if (l && this.stats) (this.enqueue("creator_stats", l.creator), this.enqueue("brand_stats", l.brand));
    } else {
      this.enqueue("receipt", c.hash);
      // A receipt means a settled payment: both sides' totals move.
      const l = this.o.data.receipt(c.hash) && this.o.data.licence(this.o.data.receipt(c.hash)!.licenceId);
      if (l && this.stats) (this.enqueue("creator_stats", l.creator), this.enqueue("brand_stats", l.brand));
    }
  }

  private get stats() {
    return this.o.stats ?? true;
  }

  /** At most one waiting item per record: a later change just makes it due now. */
  enqueue(kind: ItemKind, subject: string, at = this.now()) {
    const waiting = this.o.db.prepare("select seq from arkiv_outbox where kind = ? and subject = ? and status = 'pending'").get(kind, subject) as Row | undefined;
    if (waiting) this.o.db.prepare("update arkiv_outbox set next_at = min(next_at, ?), updated_at = ? where seq = ?").run(at, this.now(), Number(waiting.seq));
    else this.o.db.prepare("insert into arkiv_outbox (ref, kind, subject, status, next_at, created_at, updated_at) values (?, ?, ?, 'pending', ?, ?, ?)").run(`ark_${randomBytes(8).toString("hex")}`, kind, subject, at, this.now(), this.now());
    if (this.o.autoRun ?? true) this.schedule(0);
  }

  /**
   * Queues every record that isn't on Arkiv yet (after Arkiv is switched on, or a new namespace), and every listed
   * creator's listing that needs extending. Safe to run any time: a record already in sync writes nothing.
   */
  private get listingMs() {
    return this.o.listingLifetimeMs ?? LISTING_MS;
  }

  /** A listing's entity: when it expires on Arkiv and from when the sweep renews it (while the creator stays listed). */
  listingSchedule(uid: string): { expiresAt: number; renewsFrom: number } | undefined {
    const e = this.entity("listing", uid);
    return e && { expiresAt: e.expiresAt, renewsFrom: e.expiresAt - this.listingMs / 2 };
  }

  backfill() {
    const q = (sql: string) => (this.o.db.prepare(sql).all() as Row[]).map((r) => String(r.id));
    const missing = (kind: EntityKind, ids: string[]) => ids.filter((id) => !this.entity(kind, id) && !this.o.db.prepare("select 1 from arkiv_outbox where kind = ? and subject = ? and status in ('pending', 'sending', 'uncertain', 'failed')").get(kind, id));
    let n = 0;
    for (const id of missing("listing", q("select uid as id from listings where listed = 1"))) (this.enqueue("listing", id), n++);
    // Every licence still in its term (revoked ones too: Verify must say so), its receipt, and requests with an ad
    // whose review window is still open.
    const live = this.now() + 60_000;
    for (const id of missing("licence", q(`select id from licence_records where expires_at > ${live}`))) (this.enqueue("licence", id), n++);
    for (const id of missing("receipt", q(`select r.hash as id from render_receipts r join licence_records l on l.id = r.licence_id where l.expires_at > ${live}`))) (this.enqueue("receipt", id), n++);
    for (const id of missing("request", q(`select id from pending_actions where output is not null and status != 'expired' and expires_at > ${live}`))) (this.enqueue("request", id), n++);
    // Every revoked licence whose entity made it to Arkiv gets its revocation record (even after the licence ended).
    for (const id of missing("revocation", q("select l.id from licence_records l join arkiv_entities e on e.kind = 'licence' and e.subject = l.id where l.status = 'revoked'"))) (this.enqueue("revocation", id), n++);
    const renew = (this.o.db.prepare("select e.subject from arkiv_entities e join listings l on l.uid = e.subject where e.kind = 'listing' and l.listed = 1 and e.expires_at < ?").all(this.now() + this.listingMs / 2) as Row[]).map((r) => String(r.subject));
    for (const uid of renew) (this.enqueue("listing", uid), n++);
    // Stats: every subject is re-planned (active licences fall as licences end); only a changed number is written.
    const { creators, brands } = this.stats ? this.o.data.statsSubjects(this.now(), this.since) : { creators: [], brands: [] };
    // Plus every stats entity still alive: its numbers decay as licences end, and it's deleted once nothing is left.
    const alive = (kind: string) => (this.o.db.prepare("select subject from arkiv_entities where kind = ? and expires_at > ?").all(kind, this.now()) as Row[]).map((r) => String(r.subject));
    for (const uid of new Set([...creators, ...(this.stats ? alive("creator_stats") : [])])) if (!this.isOpen("creator_stats", uid)) (this.enqueue("creator_stats", uid), n++);
    for (const uid of new Set([...brands, ...(this.stats ? alive("brand_stats") : [])])) if (!this.isOpen("brand_stats", uid)) (this.enqueue("brand_stats", uid), n++);
    return n;
  }

  /** This app's namespace on Arkiv (ARKIV_SCHEMA_PREFIX). */
  get prefix() {
    return this.o.config.prefix;
  }

  /** The Arkiv client, for health checks (chain, balances). */
  get client() {
    return this.o.client;
  }

  // ---------------------------------------------------------------- what the UI and Verify read

  entity(kind: EntityKind, subject: string): Entity | undefined {
    const r = this.o.db.prepare("select * from arkiv_entities where kind = ? and subject = ?").get(kind, subject) as Row | undefined;
    return r && { kind, subject, entityKey: r.entity_key as Hex, owner: r.owner as Hex, ref: r.ref as string, values: JSON.parse(r.vals as string) as Plain, expiresAt: Number(r.expires_at), txHash: r.tx_hash as Hex };
  }

  /** The record an entity key mirrors, if this app wrote it. */
  subjectOf(kind: EntityKind, entityKey: string): string | undefined {
    return (this.o.db.prepare("select subject from arkiv_entities where kind = ? and lower(entity_key) = lower(?)").get(kind, entityKey) as Row | undefined)?.subject as string | undefined;
  }

  entityUrl = (key: string) => `${this.o.config.explorerUrl}/entity/${key}`;

  status(kind: EntityKind, subject: string): SyncStatus {
    const e = this.entity(kind, subject);
    const at = e ? { entityKey: e.entityKey, url: this.entityUrl(e.entityKey) } : {};
    // The open item that holds this record up (the earliest), else the latest one.
    const last = (this.o.db.prepare("select * from arkiv_outbox where kind = ? and subject = ? and status in ('pending', 'sending', 'uncertain') order by seq limit 1").get(kind, subject) ??
      this.o.db.prepare("select * from arkiv_outbox where kind = ? and subject = ? order by seq desc limit 1").get(kind, subject)) as Row | undefined;
    const item = last && itemRow(last);
    if (item?.status === "failed") return { state: "failed", error: item.lastError ?? "failed", ...at };
    if (item && item.status !== "done") return { state: "pending", ...at, ...(item.status === "uncertain" ? { note: item.lastError ?? "sent; waiting for the receipt" } : item.lastError ? { note: item.lastError } : {}) };
    if (e) return { state: "synced", entityKey: e.entityKey, url: this.entityUrl(e.entityKey), txHash: e.txHash };
    return { state: "none", ...(item?.lastError ? { note: item.lastError } : {}) };
  }

  /** Items not yet done, by state (for logs and the startup line). */
  counts() {
    return Object.fromEntries((this.o.db.prepare("select status, count(*) as n from arkiv_outbox where status != 'done' group by status").all() as Row[]).map((r) => [r.status as string, Number(r.n)]));
  }

  // ---------------------------------------------------------------- the worker

  private schedule(ms: number) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().then((next) => next !== undefined && this.schedule(Math.max(next - this.now(), 250)));
    }, ms);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Handles every due item, one at a time; returns when the next one is due (or undefined if none is queued). */
  async drain(max = 50): Promise<number | undefined> {
    if (this.running) return this.now() + 1_000;
    this.running = true;
    try {
      for (let i = 0; i < max && !this.stopped; i++) {
        const item = this.due();
        if (!item) break;
        await this.handle(item);
      }
      const next = this.o.db.prepare(`select min(next_at) as t from arkiv_outbox o where ${OPEN_AND_FIRST}`).get() as Row;
      return next.t == null ? undefined : Number(next.t);
    } finally {
      this.running = false;
    }
  }

  /** The next due item whose record has no earlier item still open (so a record's writes go in order). */
  private due(): Item | undefined {
    const r = this.o.db
      .prepare(
        `select * from arkiv_outbox o where ${OPEN_AND_FIRST} and next_at <= ?
         order by case status when 'uncertain' then 0 else 1 end, seq limit 1`,
      )
      .get(this.now()) as Row | undefined;
    return r && itemRow(r);
  }

  private update(seq: number, f: Partial<{ status: ItemStatus; attempts: number; next_at: number; last_error: string | null; signer: string | null; intent: string | null; nonce: number | null; tx_hash: string | null; sent_at: number | null }>) {
    const cols = Object.keys(f);
    this.o.db.prepare(`update arkiv_outbox set ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? where seq = ?`).run(...(Object.values(f) as (string | number | null)[]), this.now(), seq);
  }

  private item(seq: number) {
    return itemRow(this.o.db.prepare("select * from arkiv_outbox where seq = ?").get(seq) as Row);
  }

  private async handle(item: Item) {
    try {
      if (item.status === "uncertain") return await this.reconcile(item);
      const plan = await this.plan(item);
      if (plan.do === "skip") return this.update(item.seq, { status: "done", last_error: plan.note });
      if (plan.do === "wait") return this.update(item.seq, { next_at: this.now() + (plan.ms ?? 10_000), last_error: plan.note });
      if (plan.do === "fail") return this.fail(item, plan.error);
      await this.send(item, plan);
    } catch (e) {
      // Anything before a hash was stored broadcast nothing: back off and try again.
      const now = this.item(item.seq);
      if (now.status === "sending" || now.status === "pending") this.retry(now, scrub(e));
      else if (now.status === "uncertain") this.update(item.seq, { next_at: this.now() + 15_000, last_error: scrub(e) });
    }
  }

  private retry(item: Item, error: string) {
    const attempts = item.attempts + (item.status === "sending" ? 0 : 1);
    if (attempts >= MAX_ATTEMPTS) return this.fail(item, error);
    this.update(item.seq, { status: "pending", attempts, next_at: this.now() + backoff(attempts), last_error: error, signer: null, intent: null, nonce: null });
    this.log(`${item.kind} ${item.subject}: not sent (${error}); retry ${attempts}/${MAX_ATTEMPTS - 1}`);
  }

  private fail(item: Item, error: string) {
    this.update(item.seq, { status: "failed", last_error: error });
    this.log(`${item.kind} ${item.subject}: sync failed: ${error}`);
  }

  // ---------------------------------------------------------------- sending

  private async send(item: Item, plan: Extract<Plan, { do: "send" | "transfer" }>) {
    const signerName = plan.do === "send" ? plan.signer : "platform:funder";
    const signer = this.o.keystore.account(signerName);
    if (plan.do === "send" && plan.intent.op === "create") {
      // Before every create (a retry above all): if this ref already made the entity, adopt it, never create twice.
      const found = await this.o.client.findByRef(item.kind as EntityKind, plan.intent.owner, plan.intent.ref);
      if (found) return this.confirm(item, { ...plan.intent, entityKey: found }, "0x" as Hex, "found by ref");
    }
    // Funding: an account key low on tGLM waits for a top-up from the funder (queued once).
    if (signerName.startsWith("account:") || signerName === "platform:receipt") {
      const bal = await this.o.client.balance(signer.address);
      if (bal < MIN_BALANCE) return this.update(item.seq, { next_at: this.now() + 5_000, last_error: this.topUp(signer.address) });
    }
    const intent = plan.do === "send" ? plan.intent : { op: "transfer" as const, to: plan.to, value: plan.value.toString() };
    // The intent is durable before the wallet call; the hash is stored by onSigned before broadcast.
    this.update(item.seq, { status: "sending", attempts: item.attempts + 1, signer: signerName, intent: JSON.stringify(intent), nonce: null, tx_hash: null, sent_at: null });
    const hooks = { onSigned: (hash: Hex, nonce: number) => this.update(item.seq, { tx_hash: hash, nonce, sent_at: this.now() }) };
    let result: { txHash: Hex; createdKeys?: Hex[] };
    try {
      result = plan.do === "send" ? await this.o.client.execute(signer, plan.ops, hooks) : await this.o.client.transfer(signer, plan.to, plan.value, hooks);
    } catch (e) {
      const now = this.item(item.seq);
      if (now.txHash) {
        this.update(item.seq, { status: "uncertain", next_at: this.now() + 10_000, last_error: null });
        this.log(`${item.kind} ${item.subject}: sent as ${now.txHash}, outcome unknown (${scrub(e)}); reconciling, not re-sending`);
        return;
      }
      throw e;
    }
    if (intent.op === "create") intent.entityKey = result.createdKeys?.[0];
    this.confirm(item, intent, result.txHash);
  }

  /** A confirmed write: record what the entity now holds, and close the item. */
  private confirm(item: Item, intent: Intent, txHash: Hex, how = "") {
    if (intent.op !== "transfer") {
      const prev = this.entity(item.kind as EntityKind, item.subject);
      const entityKey = intent.entityKey ?? prev?.entityKey;
      if (!entityKey) throw new Error("no entity key after a confirmed write");
      const tx = txHash === "0x" ? (prev?.txHash ?? "0x") : txHash;
      if (intent.op === "delete") {
        this.o.db.prepare("delete from arkiv_entities where kind = ? and subject = ?").run(item.kind, item.subject);
        this.log(`${item.kind} ${item.subject}: deleted ${entityKey}${txHash !== "0x" ? ` in ${txHash}` : ""}`);
        this.update(item.seq, { status: "done", last_error: null, ...(txHash !== "0x" ? { tx_hash: txHash } : {}) });
        return;
      }
      this.o.db
        .prepare(
          `insert into arkiv_entities (kind, subject, entity_key, owner, ref, vals, expires_at, tx_hash, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(kind, subject) do update set entity_key = excluded.entity_key, owner = excluded.owner, ref = excluded.ref, vals = excluded.vals, expires_at = excluded.expires_at, tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
        )
        .run(item.kind, item.subject, entityKey, intent.owner, intent.ref, JSON.stringify(intent.values), intent.expiresAt, tx, this.now());
      this.log(`${item.kind} ${item.subject}: ${intent.op === "create" ? "created" : "updated"} ${entityKey}${txHash !== "0x" ? ` in ${txHash}` : ""}${how ? ` (${how})` : ""}`);
    } else this.log(`funded ${intent.to} with ${formatEther(BigInt(intent.value))} tGLM in ${txHash}`);
    this.update(item.seq, { status: "done", last_error: null, ...(txHash !== "0x" ? { tx_hash: txHash } : {}) });
  }

  /** A send whose outcome is unknown: settle it from its hash. Never signs anything. */
  private async reconcile(item: Item) {
    if (!item.txHash || !item.intent) return this.update(item.seq, { status: "pending", next_at: this.now() });
    const status = await this.o.client.receipt(item.txHash);
    if (status === "success") {
      const intent = item.intent;
      if (intent.op === "create") {
        const key = await this.o.client.findByRef(item.kind as EntityKind, intent.owner, intent.ref);
        if (!key) return this.update(item.seq, { status: "done", last_error: "created, but no longer found on Arkiv (expired?)" });
        intent.entityKey = key;
      }
      return this.confirm(item, intent, item.txHash, "reconciled");
    }
    if (status === "reverted") return this.fail(item, `transaction ${item.txHash} reverted on chain`);
    // No receipt yet. Either way the item stays open, so this record is never written again (fail closed); a
    // receipt that turns up later still settles it.
    const signer = item.signer && this.o.keystore.address(item.signer);
    const taken = !!signer && item.nonce !== null && (await this.o.client.nonce(signer)) > item.nonce;
    const age = this.now() - (item.sentAt ?? item.createdAt);
    const stuck = taken ? `nonce ${item.nonce} is used but ${item.txHash} has no receipt: check it by hand` : age > 30 * 60_000 ? `sent as ${item.txHash} but not mined after 30 minutes: check it by hand` : null;
    if (stuck && stuck !== item.lastError) this.log(`${item.kind} ${item.subject}: ${stuck}`);
    this.update(item.seq, { next_at: this.now() + (stuck ? 3_600_000 : 15_000), last_error: stuck });
  }

  /** Queues one top-up for an account key, within the caps; returns what the item now waits for. */
  private topUp(address: Hex): string {
    const open = this.o.db.prepare("select 1 from arkiv_outbox where kind = 'fund' and subject = ? and status in ('pending', 'sending', 'uncertain')").get(address);
    if (open) return "waiting for a top-up from the funder";
    const since = this.now() - DAY;
    const mine = Number((this.o.db.prepare("select count(*) as n from arkiv_outbox where kind = 'fund' and subject = ? and status = 'done' and updated_at > ?").get(address, since) as Row).n);
    const all = Number((this.o.db.prepare("select count(*) as n from arkiv_outbox where kind = 'fund' and status = 'done' and updated_at > ?").get(since) as Row).n);
    if (mine >= TOPUPS_PER_ADDRESS_PER_DAY || all >= TOPUPS_PER_DAY) return "the funder's daily top-up cap is reached";
    this.enqueue("fund", address);
    return "waiting for a top-up from the funder";
  }

  // ---------------------------------------------------------------- planning: what each record's entity should hold

  private async plan(item: Item): Promise<Plan> {
    switch (item.kind) {
      case "fund":
        return { do: "transfer", to: item.subject as Hex, value: this.o.config.topup };
      case "listing":
        return this.planListing(item);
      case "request":
        return this.planRequest(item);
      case "licence":
        return this.planLicence(item);
      case "receipt":
        return this.planReceipt(item);
      case "revocation":
        return this.planRevocation(item);
      case "creator_stats":
        return this.planCreatorStats(item);
      case "brand_stats":
        return this.planBrandStats(item);
    }
  }

  /** A creator's stats entity, owned by their key: created on their first listing or licence, patched as numbers move. */
  private planCreatorStats(item: Item): Plan {
    const uid = item.subject;
    const account = this.o.accounts.account(uid);
    const st = account && this.o.data.creatorStats(uid, this.now(), this.since);
    if (!account || !st) return this.dropStats("creator_stats", item, uid);
    if (this.testIdentity(account.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    const owner = this.address(uid);
    return this.upsert("creator_stats", item, `account:${uid}`, owner, (ref) => creatorStatsValues(this.o.config.prefix, ref, owner, st), this.statsExpiry("creator_stats", uid));
  }

  /** A brand's stats entity, owned by its account key. */
  private planBrandStats(item: Item): Plan {
    const uid = item.subject;
    const account = this.o.accounts.account(uid);
    const st = account && this.o.data.brandStats(uid, this.now(), this.since);
    if (!account || !st) return this.dropStats("brand_stats", item, uid);
    if (this.testIdentity(account.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    const owner = this.address(uid);
    return this.upsert("brand_stats", item, `account:${uid}`, owner, (ref) => brandStatsValues(this.o.config.prefix, ref, owner, st), this.statsExpiry("brand_stats", uid));
  }

  /** No stats any more (unlisted, no licence in this namespace): its entity, if any, is deleted by its owner. */
  private dropStats(kind: "creator_stats" | "brand_stats", item: Item, uid: string): Plan {
    const e = this.entity(kind, uid);
    if (!e || e.expiresAt <= this.now()) return { do: "skip", note: "no stats" };
    return { do: "send", signer: `account:${uid}`, ops: { deletes: [{ entityKey: e.entityKey }] }, intent: { op: "delete", owner: e.owner, ref: e.ref, values: e.values, expiresAt: e.expiresAt, entityKey: e.entityKey } };
  }

  /**
   * Stats count what happened in this namespace: licences and payments since the database was bound to it (the
   * meta key arkiv_namespace_since, ms; 0 when it was bound before the key existed).
   */
  get since() {
    const r = this.o.db.prepare("select value from meta where key = 'arkiv_namespace_since'").get() as { value: string } | undefined;
    return r ? Number(r.value) : 0;
  }

  /** Stats live 30 days, extended once less than half of that is left (by the next change or the hourly sweep). */
  private statsExpiry(kind: "creator_stats" | "brand_stats", uid: string) {
    const e = this.entity(kind, uid);
    return { create: this.now() + STATS_MS, extendTo: e && e.expiresAt - this.now() < STATS_MS / 2 ? this.now() + STATS_MS : undefined };
  }

  private address(uid: string) {
    return this.o.keystore.accountKey(uid).address;
  }

  /** Create when there's no live entity; otherwise patch what changed and extend when asked. */
  private upsert(kind: EntityKind, item: Item, signer: string, owner: Hex, values: (ref: string) => Plain, expiry: { create: number; extendTo?: number | undefined; lifetime?: Expiry }, flags?: { readonly: boolean }): Plan {
    const now = this.now();
    const e = this.entity(kind, item.subject);
    const schema = this.schemas[kind];
    if (!e || e.expiresAt <= now || e.owner.toLowerCase() !== owner.toLowerCase()) {
      if (e && e.expiresAt > now) return { do: "skip", note: "owned by another address now: not changed" };
      if (expiry.create <= now + 60_000) return { do: "skip", note: "ends too soon to put on Arkiv" };
      const v = values(item.ref);
      return { do: "send", signer, ops: { creates: [{ schema, values: typed(v) as never, expiration: expiry.lifetime ?? ExpirationTime.atDate(new Date(expiry.create)), ...(flags ? { flags } : {}) }] }, intent: { op: "create", owner, ref: item.ref, values: v, expiresAt: expiry.create } };
    }
    if (flags?.readonly) return { do: "skip", note: "already on Arkiv (read-only)" };
    const v = values(e.ref);
    const diff = changed(e.values, v);
    const extend = expiry.extendTo !== undefined && expiry.extendTo > e.expiresAt + 60_000 ? expiry.extendTo : undefined;
    if (!Object.keys(diff.set).length && !diff.unset.length && !extend) return { do: "skip", note: "already in sync" };
    const ops: Ops = {};
    if (Object.keys(diff.set).length || diff.unset.length) ops.patches = [{ schema, entityKey: e.entityKey, ...(Object.keys(diff.set).length ? { set: typed(diff.set) as never } : {}), ...(diff.unset.length ? { unset: diff.unset as never } : {}) }];
    if (extend) ops.extensions = [{ entityKey: e.entityKey, expiration: ExpirationTime.atDate(new Date(extend)) }];
    return { do: "send", signer, ops, intent: { op: "update", owner, ref: e.ref, values: v, expiresAt: extend ?? e.expiresAt, entityKey: e.entityKey } };
  }

  /** In the demo namespace, a record that involves a test identity is never written. */
  private testIdentity(...isses: (string | undefined)[]) {
    return !!this.o.realOnly && isses.some((iss) => !iss || this.o.identityOf(iss) !== "world-id");
  }

  private planListing(item: Item): Plan {
    const uid = item.subject;
    const l = this.o.data.listingRecord(uid);
    const account = this.o.accounts.account(uid);
    if (!l || !account) return { do: "skip", note: "no listing" };
    if (this.testIdentity(account.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    const e = this.entity("listing", uid);
    if (!l.listed && (!e || e.expiresAt <= this.now())) return { do: "skip", note: "not listed" };
    const values = (ref: string) =>
      listingValues(this.o.config.prefix, ref, { listed: l.listed, rules: l.rules, displayName: account.name, hasCapture: !!this.o.accounts.creator(uid)?.consentAt, identity: this.o.identityOf(account.iss), ...(this.o.presenceOf ? { presence: this.o.presenceOf(uid) } : {}), ...(this.o.credentialOf ? { credential: this.o.credentialOf(uid) } : {}) });
    const renew = l.listed && e && e.expiresAt - this.now() < this.listingMs / 2 ? this.now() + this.listingMs : undefined;
    return this.upsert("listing", item, `account:${uid}`, this.address(uid), values, { create: this.now() + this.listingMs, extendTo: renew });
  }

  private planRequest(item: Item): Plan {
    const a = this.o.data.action(item.subject);
    if (!a) return { do: "skip", note: "no request" };
    const status = requestStatus(a);
    if (!status) return { do: "skip", note: "expired: left to expire on Arkiv" };
    if (this.testIdentity(this.o.accounts.account(a.brand)?.iss, this.o.accounts.account(a.creator)?.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    // On Arkiv once there's an ad to review, living as long as the review window: an expired request just ends.
    // On Arkiv once there's an ad to review, in whatever state it's in by the time it's written (a quick denial
    // included); a request still generating its first version waits for the next change.
    if (!this.entity("request", a.id) && !a.output) return { do: "skip", note: "not on Arkiv until there's an ad to review" };
    const values = (ref: string) =>
      requestValues(this.o.config.prefix, ref, { brand: this.address(a.brand), creator: this.address(a.creator), kind: a.kind, briefHash: a.briefHash, price: a.price, status, outputHash: a.output?.hash ?? null });
    return this.upsert("request", item, `account:${a.brand}`, this.address(a.brand), values, { create: a.expiresAt, extendTo: a.expiresAt });
  }

  private isOpen(kind: EntityKind, subject: string) {
    return !!this.o.db.prepare("select 1 from arkiv_outbox where kind = ? and subject = ? and status in ('pending', 'sending', 'uncertain')").get(kind, subject);
  }

  private open(kind: EntityKind, subject: string) {
    return this.o.db.prepare("select status from arkiv_outbox where kind = ? and subject = ? order by seq desc limit 1").get(kind, subject) as { status: ItemStatus } | undefined;
  }

  private planLicence(item: Item): Plan {
    const l = this.o.data.licence(item.subject);
    const a = l && this.o.data.action(l.actionId);
    if (!l || !a) return { do: "skip", note: "no licence" };
    if (this.testIdentity(a.creatorCheck.evidence?.iss, this.o.accounts.account(l.creator)?.iss, this.o.accounts.account(l.brand)?.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    // The request's entity key, when it's on Arkiv (wait while its write is still on its way).
    const req = this.open("request", l.actionId);
    if (req && ["pending", "sending", "uncertain"].includes(req.status)) return { do: "wait", note: "waiting for the request's entity" };
    const requestKey = this.entity("request", l.actionId)?.entityKey ?? null;
    const evidence = a.creatorCheck.evidence;
    const values = (ref: string) =>
      licenceValues(this.o.config.prefix, ref, {
        outputHash: l.outputHash,
        brand: this.address(l.brand),
        creator: this.address(l.creator),
        usage: l.category,
        kind: l.kind,
        durationDays: l.durationDays,
        price: l.price,
        approvedAt: a.creatorCheck.decidedAt ?? l.createdAt,
        requestKey,
        licenceId: l.id,
        identity: this.o.identityOf(evidence?.iss ?? "dev-consent"),
        status: l.status,
      });
    // Arkiv ends the licence: at its end, or at the longest lifetime (licences are at most MAX_DAYS_LIMIT days).
    const end = Math.min(l.expiresAt, this.now() + Math.min(MAX_LIFETIME_MS - DAY, (MAX_DAYS_LIMIT + 1) * DAY));
    return this.upsert("licence", item, `account:${l.creator}`, this.address(l.creator), values, { create: end });
  }

  /** The creator's revocation record: read-only, the longest lifetime, pointing at the licence entity. */
  private planRevocation(item: Item): Plan {
    const l = this.o.data.licence(item.subject);
    if (!l || l.status !== "revoked") return { do: "skip", note: "not revoked" };
    const revokedAt = l.revokedAt;
    if (revokedAt === null) return { do: "skip", note: "the revocation time isn't known: no record rather than a wrong date" };
    const a = this.o.data.action(l.actionId);
    if (this.testIdentity(a?.creatorCheck.evidence?.iss, this.o.accounts.account(l.creator)?.iss, this.o.accounts.account(l.brand)?.iss)) return { do: "skip", note: "a test identity: never written to the demo namespace" };
    const lic = this.entity("licence", l.id);
    if (!lic) {
      const state = this.open("licence", l.id)?.status;
      if (state === "pending" || state === "sending" || state === "uncertain") return { do: "wait", note: "waiting for the licence's entity" };
      return { do: "skip", note: "its licence isn't on Arkiv" };
    }
    const values = (ref: string) =>
      revocationValues(this.o.config.prefix, ref, { licenceKey: lic.entityKey, fileHash: l.outputHash, creator: lic.owner, revokedAt, licenceId: l.id });
    return this.upsert("revocation", item, `account:${l.creator}`, this.address(l.creator), values, { create: this.now() + MAX_LIFETIME_MS, lifetime: ExpirationTime.max() }, { readonly: true });
  }

  private planReceipt(item: Item): Plan {
    const r = this.o.data.receipt(item.subject);
    if (!r) return { do: "skip", note: "no receipt" };
    const lic = this.entity("licence", r.licenceId);
    if (!lic) {
      const state = this.open("licence", r.licenceId)?.status;
      if (state === "failed") return { do: "fail", error: "its licence never reached Arkiv" };
      // Its licence was settled without an entity (skipped): no receipt either.
      if (state === "done") return { do: "skip", note: "its licence isn't on Arkiv" };
      if (!state) this.enqueue("licence", r.licenceId);
      return { do: "wait", note: "waiting for the licence's entity" };
    }
    const receiptKey = this.o.keystore.platformKey("receipt").address;
    const licence = this.o.data.licence(r.licenceId);
    const payment = licence ? this.o.data.payments({ actionId: licence.actionId }).find((p) => p.id === r.paymentId) : undefined;
    const rail = payment?.rail ?? null;
    const creatorUid = licence?.creator;
    // Swarm: the receipt is read-only, so it waits (a while) for the file's reference rather than going without.
    const sw = this.o.swarmOf?.(item.subject);
    if (sw?.state === "pending" && this.now() - r.releasedAt < SWARM_WAIT_MS && !this.entity("receipt", item.subject)) return { do: "wait", note: "waiting for the file's Swarm upload", ms: 10_000 };
    const values = (ref: string) =>
      receiptValues(this.o.config.prefix, ref, {
        fileHash: item.subject,
        licenceKey: lic.entityKey,
        creator: lic.owner,
        licenceExpiresAt: lic.expiresAt,
        licenceId: r.licenceId,
        provider: r.provider,
        model: r.model,
        jobId: r.requestId,
        paymentRef: r.paymentRef,
        paymentRail: rail,
        payer: payment?.payer ?? null,
        // What made it, and the creator's World ID check at release (production | sandbox | none).
        generator: r.provider,
        swarmRef: sw?.state === "uploaded" ? sw.ref : null,
        swarmEncrypted: sw?.state === "uploaded" ? sw.encrypted : null,
        worldId: creatorUid && this.o.presenceOf ? this.o.presenceOf(creatorUid) : null,
        worldIdCredential: creatorUid && this.o.credentialOf ? this.o.credentialOf(creatorUid) : null,
        faceCheck: r.faceCheck,
        faceScore: r.faceScore,
      });
    // The longest lifetime there is (~182.5 days): longer than any licence it backs (at most 180), and read-only.
    return this.upsert("receipt", item, "platform:receipt", receiptKey, values, { create: this.now() + MAX_LIFETIME_MS, lifetime: ExpirationTime.max() }, { readonly: true });
  }
}
