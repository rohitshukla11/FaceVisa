/**
 * Released ads on Swarm (ethswarm.org), through FaceVisa's own Bee node, with one postage batch.
 *
 * Every released ad is uploaded once, after its release, and its Swarm reference goes on the ad's Arkiv receipt
 * (`swarm_ref`), so the receipt points at the file itself:
 *   - a showcase creator's ads (SWARM_SHOWCASE_CREATORS: consented, the founder's own) go up as they are, so anyone
 *     can open them through a public gateway and check their sha256 against the receipt;
 *   - every other ad is encrypted first (AES-256-GCM, a fresh key per file). What goes to Swarm is ciphertext, and its
 *     reference is a plain content address of that ciphertext: publishing it reveals nothing. The file's key is sealed
 *     to the brand's and the creator's account keys (ECDH on secp256k1) and kept in our database, never on Arkiv.
 *     (Swarm's own encrypted references carry their key inside them, which is why we don't put those on Arkiv.)
 *
 * When the public demo has deleted its local copy (48 hours), the brand and the creator still open the ad: it's read
 * back from Swarm and decrypted with their own key.
 *
 * Settings: SWARM_BEE_URL (the Bee API, e.g. http://127.0.0.1:1633), SWARM_BATCH_ID (a usable postage batch of that
 * node), SWARM_GATEWAY (public reads, default https://api.gateway.ethswarm.org), SWARM_SHOWCASE_CREATORS (account ids
 * whose ads are uploaded unencrypted, comma-separated).
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { Keystore } from "../app/keystore.js";

export interface SwarmConfig {
  beeUrl: string;
  batchId: string;
  gateway: string;
  showcase: Set<string>;
}

export function swarmConfigFromEnv(env = process.env): SwarmConfig | undefined {
  if (!env.SWARM_BEE_URL || !env.SWARM_BATCH_ID) return undefined;
  if (!/^https?:\/\/[^/?#]+\/?$/.test(env.SWARM_BEE_URL)) throw new Error("SWARM_BEE_URL: the Bee API's origin, e.g. http://127.0.0.1:1633");
  if (!/^(0x)?[0-9a-f]{64}$/i.test(env.SWARM_BATCH_ID)) throw new Error("SWARM_BATCH_ID: a postage batch id (64 hex digits)");
  const gateway = (env.SWARM_GATEWAY || "https://api.gateway.ethswarm.org").replace(/\/$/, "");
  return {
    beeUrl: env.SWARM_BEE_URL.replace(/\/$/, ""),
    batchId: env.SWARM_BATCH_ID.replace(/^0x/, "").toLowerCase(),
    gateway,
    showcase: new Set((env.SWARM_SHOWCASE_CREATORS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  };
}

/** A file key sealed to one account key: an ephemeral ECDH key, and the file key under AES-256-GCM. */
interface Sealed {
  eph: string;
  iv: string;
  ct: string;
  tag: string;
}

export type SwarmState = { state: "pending" } | { state: "uploaded"; ref: string; encrypted: boolean; url: string } | { state: "failed"; error: string };

const SCHEMA = `
create table if not exists swarm_files (
  hash text primary key, status text not null, ref text, encrypted integer, sealed text, mime text, batch_id text,
  attempts integer not null default 0, next_at integer not null, last_error text, created_at integer not null, uploaded_at integer
);
`;
const MAX_ATTEMPTS = 6;

const unhex = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");

/** Seals `fileKey` to an uncompressed secp256k1 public key (0x04…). */
export function seal(fileKey: Buffer, publicKey: Hex): Sealed {
  const eph = createECDH("secp256k1");
  eph.generateKeys();
  const k = createHash("sha256").update(eph.computeSecret(unhex(publicKey))).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(fileKey), c.final()]);
  return { eph: eph.getPublicKey("hex"), iv: iv.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

/** Opens a sealed file key with the matching private key. */
export function unseal(s: Sealed, privateKey: Hex): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(unhex(privateKey));
  const k = createHash("sha256").update(ecdh.computeSecret(unhex(s.eph))).digest();
  const d = createDecipheriv("aes-256-gcm", k, unhex(s.iv));
  d.setAuthTag(unhex(s.tag));
  return Buffer.concat([d.update(unhex(s.ct)), d.final()]);
}

/** The file as uploaded when it's private: iv (12) || ciphertext || tag (16). */
export function encryptFile(bytes: Uint8Array): { blob: Buffer; key: Buffer } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  return { blob: Buffer.concat([iv, ct, c.getAuthTag()]), key };
}

export function decryptFile(blob: Uint8Array, key: Buffer): Buffer {
  const b = Buffer.from(blob);
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" };

export interface SwarmDeps {
  db: DatabaseSync;
  keystore: Keystore;
  config: SwarmConfig;
  /** The released file's bytes, while the server still has them. */
  file: (hash: string) => { bytes: Uint8Array; mime: string } | undefined;
  /** Who the file belongs to: its brand and creator (account ids). */
  parties: (hash: string) => { brand: string; creator: string } | undefined;
  /** Told when an upload is done, so the Arkiv receipt can carry its reference. */
  onUploaded?: (hash: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  autoRun?: boolean;
}

export class Swarm {
  /** When the batch (and so every file stamped with it) expires, ms: refreshed from the node, said in the consent text. */
  storedUntil: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(readonly d: SwarmDeps) {
    d.db.exec(SCHEMA);
    if (d.autoRun ?? true) this.schedule(0);
  }

  private get fetch() {
    return this.d.fetch ?? fetch;
  }
  private now() {
    return (this.d.now ?? Date.now)();
  }
  private log(line: string) {
    (this.d.log ?? ((l) => console.log(`[swarm] ${l}`)))(line);
  }

  /** A public link to a reference, through the gateway: what a judge or viewer opens. */
  url(ref: string) {
    return `${this.d.config.gateway}/bzz/${ref}/`;
  }

  /** Queue a released file for upload (once). */
  enqueue(hash: string) {
    const h = hash.toLowerCase();
    this.d.db.prepare("insert into swarm_files (hash, status, next_at, created_at) values (?, 'pending', ?, ?) on conflict(hash) do nothing").run(h, this.now(), this.now());
    if (this.d.autoRun ?? true) this.schedule(0);
  }

  status(hash: string): SwarmState | undefined {
    const r = this.d.db.prepare("select * from swarm_files where hash = ?").get(hash.toLowerCase()) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    if (r.status === "uploaded") return { state: "uploaded", ref: String(r.ref), encrypted: Number(r.encrypted) === 1, url: this.url(String(r.ref)) };
    if (r.status === "failed") return { state: "failed", error: String(r.last_error ?? "failed") };
    return { state: "pending" };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), ms);
    this.timer.unref?.();
  }

  /** Uploads every due file, one at a time; returns when the next is due (or undefined). */
  async drain(): Promise<number | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      for (;;) {
        const r = this.d.db.prepare("select hash, attempts from swarm_files where status = 'pending' and next_at <= ? order by created_at limit 1").get(this.now()) as { hash: string; attempts: number } | undefined;
        if (!r) break;
        await this.uploadOne(r.hash, Number(r.attempts));
      }
      const next = this.d.db.prepare("select min(next_at) as n from swarm_files where status = 'pending'").get() as { n: number | null };
      if (next.n !== null && (this.d.autoRun ?? true)) this.schedule(Math.max(1_000, next.n - this.now()));
      return next.n ?? undefined;
    } finally {
      this.running = false;
    }
  }

  private async uploadOne(hash: string, attempts: number) {
    const set = (cols: Record<string, unknown>) =>
      this.d.db.prepare(`update swarm_files set ${Object.keys(cols).map((k) => `${k} = ?`).join(", ")} where hash = ?`).run(...(Object.values(cols) as never[]), hash);
    const f = this.d.file(hash);
    const who = this.d.parties(hash);
    if (!f || !who) return set({ status: "failed", last_error: "the released file isn't on this server any more" });
    const showcase = this.d.config.showcase.has(who.creator);
    let body: Buffer;
    let mime: string;
    let sealed: string | null = null;
    if (showcase) {
      body = Buffer.from(f.bytes);
      mime = f.mime;
    } else {
      const { blob, key } = encryptFile(f.bytes);
      const pub = (uid: string) => {
        this.d.keystore.accountKey(uid);
        return this.d.keystore.account(`account:${uid}`).publicKey;
      };
      sealed = JSON.stringify({ brand: seal(key, pub(who.brand)), creator: seal(key, pub(who.creator)), mime: f.mime });
      key.fill(0);
      body = blob;
      mime = "application/octet-stream";
    }
    const name = showcase ? `ad.${EXT[mime] ?? "bin"}` : "ad.enc";
    try {
      const res = await this.fetch(`${this.d.config.beeUrl}/bzz?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": mime, "swarm-postage-batch-id": this.d.config.batchId, "swarm-deferred-upload": "false", "swarm-pin": "true" },
        body: new Uint8Array(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Bee answered HTTP ${res.status}: ${text.slice(0, 160)}`);
      const ref = String((JSON.parse(text) as { reference?: string }).reference ?? "");
      // A plain reference is 64 hex digits; a 128-digit one would carry Swarm's own key, which must never be published.
      if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`unexpected reference from Bee: ${ref.slice(0, 20)}…`);
      set({ status: "uploaded", ref, encrypted: showcase ? 0 : 1, sealed, mime: f.mime, batch_id: this.d.config.batchId, uploaded_at: this.now(), last_error: null, attempts: attempts + 1 });
      this.log(`${hash}: uploaded ${showcase ? "as it is (showcase)" : "encrypted"}, ${(body.length / 1024).toFixed(0)} KB → ${ref} ${showcase ? this.url(ref) : ""}`.trim());
      this.d.onUploaded?.(hash);
    } catch (e) {
      const error = (e as Error).message.split("\n")[0]!.slice(0, 200);
      if (attempts + 1 >= MAX_ATTEMPTS) {
        set({ status: "failed", attempts: attempts + 1, last_error: error });
        this.log(`${hash}: upload failed for good (${error})`);
        this.d.onUploaded?.(hash);
      } else {
        set({ attempts: attempts + 1, last_error: error, next_at: this.now() + 15_000 * 2 ** attempts });
        this.log(`${hash}: upload failed (${error}); retry ${attempts + 1}/${MAX_ATTEMPTS - 1}`);
      }
    }
  }

  /**
   * The file read back from Swarm, for its brand or its creator: decrypted with that person's own key when it was
   * uploaded encrypted. Undefined when it isn't on Swarm (or can't be read now).
   */
  async open(hash: string, uid: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
    const r = this.d.db.prepare("select * from swarm_files where hash = ? and status = 'uploaded'").get(hash.toLowerCase()) as Record<string, unknown> | undefined;
    const who = this.d.parties(hash);
    if (!r || !who) return undefined;
    const role = who.brand === uid ? "brand" : who.creator === uid ? "creator" : null;
    if (!role) return undefined;
    const res = await this.fetch(`${this.d.config.beeUrl}/bzz/${String(r.ref)}/`).catch(() => undefined);
    if (!res?.ok) return undefined;
    const blob = new Uint8Array(await res.arrayBuffer());
    if (Number(r.encrypted) !== 1) return { bytes: blob, mime: String(r.mime) };
    const sealed = JSON.parse(String(r.sealed)) as { brand: Sealed; creator: Sealed; mime: string };
    const key = this.d.keystore.withPrivateKey(`account:${uid}`, (pk) => unseal(sealed[role], pk));
    try {
      return { bytes: decryptFile(blob, key), mime: sealed.mime };
    } finally {
      key.fill(0);
    }
  }

  /** Reads the batch's time left from the node (at start and hourly): the date the consent text gives. */
  async refresh() {
    const h = await this.health();
    if (h.batch && h.batch.ttlSeconds > 0) this.storedUntil = this.now() + h.batch.ttlSeconds * 1000;
    return h;
  }

  /** The node and the batch, for the health check: ready, the batch usable, and how long it has left. */
  async health(): Promise<{ ready: boolean; batch?: { usable: boolean; ttlSeconds: number; utilization?: number; depth?: number }; error?: string }> {
    try {
      const ready = (await this.fetch(`${this.d.config.beeUrl}/readiness`)).ok;
      const b = await this.fetch(`${this.d.config.beeUrl}/stamps/${this.d.config.batchId}`);
      if (!b.ok) return { ready, error: `batch not found on this node (HTTP ${b.status})` };
      const j = (await b.json()) as { usable?: boolean; batchTTL?: number; utilization?: number; depth?: number };
      return { ready, batch: { usable: !!j.usable, ttlSeconds: Number(j.batchTTL ?? 0), utilization: j.utilization, depth: j.depth } };
    } catch (e) {
      return { ready: false, error: (e as Error).message.split("\n")[0] };
    }
  }
}
