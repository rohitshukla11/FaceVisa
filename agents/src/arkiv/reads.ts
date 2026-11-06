/**
 * What users see from Arkiv: the brand agent's shortlist (listings), the creator's inbox (pending requests) and
 * public Verify (a receipt and its licence). Each read changes the screen: picks and skips come from the listing query
 * and its columns, the inbox and its review deadlines from the request query, Verify's verdict from the licence entity.
 *
 * Only entities this app's keys own count: a receipt must be owned by the platform receipt key, and a licence,
 * listing or request by a FaceVisa account key that matches its creator (or brand) column. Anyone can write into a
 * namespace; ownership is what makes an entity ours.
 *
 * The backend stays the authority. A record whose write is still pending, or every record while Arkiv can't be
 * reached, comes from the backend instead, labelled "from FaceVisa, not yet confirmed on Arkiv".
 */
import type { Hex } from "viem";
import type { Keystore } from "../app/keystore.js";
import type { FaceVisaData, Listing, PendingAction } from "../facevisa/data.js";
import { CATEGORIES, VIDEO_MULTIPLIER, type Category, type CreatorRules, type Kind } from "../facevisa/rules.js";
import { scrub, type ArkivClient, type Cond, type Found } from "./chain.js";
import type { ArkivSync } from "./outbox.js";
import { bannedAttr, type EntityKind } from "./schema.js";

/** Where a screen's data came from, as its label says it. */
export type Source = { from: "arkiv"; namespace: string; entities: number; fallback: number; note?: string } | { from: "facevisa"; why: string };

export const NOT_CONFIRMED = "from FaceVisa, not yet confirmed on Arkiv";

// ---------------------------------------------------------------- the queries (pure, so tests can check them)

const ns = (prefix: string, type: EntityKind): Cond[] => [
  { col: "app", op: "eq", value: prefix },
  { col: "type", op: "eq", value: type },
];

/** Every listed creator, and the ones whose own columns fit the brief: not refusing its category, long enough, cheap enough. */
export function shortlistQueries(prefix: string, b: { category: Category; kind: Kind; durationDays: number; maxPrice: number }) {
  const all: Cond[] = [...ns(prefix, "listing"), { col: "status", op: "eq", value: "listed" }];
  const perImage = Math.floor(b.maxPrice / (b.kind === "video" ? VIDEO_MULTIPLIER : 1));
  const fits: Cond[] = [...all, { col: bannedAttr(b.category), op: "eq", value: false }, { col: "max_days", op: "gte", value: b.durationDays }, { col: "price", op: "lte", value: perImage }];
  return { all, fits };
}

/** A creator's pending requests. */
export const inboxQuery = (prefix: string, creator: Hex): Cond[] => [...ns(prefix, "request"), { col: "creator", op: "eq", value: creator }, { col: "status", op: "eq", value: "pending" }];

/** The receipt for a file (to be read with the platform receipt key as owner). */
export const receiptQuery = (prefix: string, fileHash: string): Cond[] => [...ns(prefix, "receipt"), { col: "file_hash", op: "eq", value: fileHash.toLowerCase() }];

/** The creator's revocation record for a licence (to be read with the creator the receipt names as owner). */
export const revocationQuery = (prefix: string, licenceKey: Hex): Cond[] => [...ns(prefix, "revocation"), { col: "licence_key", op: "eq", value: licenceKey }];

export const byKey = (prefix: string, type: EntityKind, key: Hex): Cond[] => [...ns(prefix, type), { col: "$key", op: "eq", value: key }];

/** A listing's rules as its entity states them. */
export const rulesOf = (v: Found["values"]): CreatorRules => ({ bannedCategories: CATEGORIES.filter((c) => v[bannedAttr(c)] === true), minPrice: Number(v.price), maxDays: Number(v.max_days) });

// ---------------------------------------------------------------- the reads

export interface SourcedListing extends Listing {
  source: "arkiv" | "facevisa";
  /** Arkiv only: whether the entity was in the query of listings that fit the brief. */
  fits?: boolean;
  entityKey?: Hex;
  url?: string;
  /** FaceVisa only: why it isn't from Arkiv. */
  why?: string;
}

export interface InboxItem {
  id: string;
  source: "arkiv" | "facevisa";
  /** Arkiv: when the request entity expires (its review window ends); FaceVisa: the backend's deadline. */
  reviewBy: number;
  entityKey?: Hex;
  url?: string;
  why?: string;
}

export interface EntityView {
  key: Hex;
  url: string;
  owner: Hex;
  /** The owner is the key it must be (the receipt key; the creator's account key). */
  ownerOk: boolean;
}

export interface VerifyOnArkiv {
  reachable: boolean;
  error?: string;
  /** The receipt names the licence's creator and end (receipts written before 4 Nov don't: those fields are absent). */
  receipt?: EntityView & { creator?: Hex; licenceEndsAt?: number; paymentRail?: string; paymentRef?: string; faceCheck?: string; faceScore?: number };
  /** The creator's display name, from their own listing entity (owner = the creator); absent if it's gone. */
  creatorName?: string;
  /** The licence entity has expired and is gone; the receipt records when it ended. */
  licenceEndedAt?: number;
  /** The creator's revocation record, owned by the creator the receipt names: "Revoked on <date>", even after the
   * licence entity has expired. */
  revocation?: EntityView & { revokedAt: number };
  licence?: EntityView & { status: string; expiresAt: number; identity: string; licenceId: string; usage: string; kind: string; durationDays: number; price: number; creator: Hex; brand: Hex; approvedAt: number };
  /** From the entities alone: what anyone reading Arkiv would conclude. */
  verdict?: "Licensed" | "Revoked" | "Expired";
  /** Something an owner or file check found wrong: the entities then don't count. */
  problems: string[];
  note?: string;
}

export class ArkivReads {
  constructor(
    private readonly o: { client: ArkivClient; sync: ArkivSync; keystore: Keystore; data: FaceVisaData; prefix: string; timeoutMs?: number; now?: () => number },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Reads give up after a few seconds: a screen never hangs on Arkiv. */
  private q(kind: EntityKind, conds: Cond[], opts?: { owner?: Hex }) {
    return Promise.race([this.o.client.query(kind, conds, opts), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Arkiv didn't answer in time")), this.o.timeoutMs ?? 6_000).unref())]);
  }

  /** The FaceVisa account an address is the custodial key of, if any. */
  uidOf(address: string): string | undefined {
    const e = this.o.keystore.entries().find((k) => k.name.startsWith("account:") && k.address.toLowerCase() === address.toLowerCase());
    return e?.name.slice("account:".length);
  }

  private url(key: string) {
    return this.o.sync.entityUrl(key);
  }

  /** Why a record isn't read from Arkiv right now (its write is pending or failed, or it was never written). */
  private why(kind: EntityKind, subject: string): string {
    const s = this.o.sync.status(kind, subject);
    return s.state === "pending" ? "its Arkiv write is pending" : s.state === "failed" ? "its Arkiv write failed" : "not on Arkiv";
  }

  /** The listings for the brand agent's shortlist, from Arkiv where they're confirmed there. */
  async shortlistListings(b: { category: Category; kind: Kind; durationDays: number; maxPrice: number }): Promise<{ listings: SourcedListing[]; source: Source; queries: { all: Cond[]; fits: Cond[] } }> {
    const backend = this.o.data.listings();
    const queries = shortlistQueries(this.o.prefix, b);
    let all: Found[], fits: Found[];
    try {
      [all, fits] = await Promise.all([this.q("listing", queries.all), this.q("listing", queries.fits)]);
    } catch (e) {
      return { listings: backend.map((l) => ({ ...l, source: "facevisa", why: "Arkiv unreachable" })), source: { from: "facevisa", why: `Arkiv unreachable (${scrub(e)})` }, queries };
    }
    const fitting = new Set(fits.map((f) => f.key.toLowerCase()));
    let fromArkiv = 0;
    const listings = backend.map((l): SourcedListing => {
      const mine = this.o.keystore.address(`account:${l.uid}`)?.toLowerCase();
      // The creator's own entity, and only when nothing about it is still on its way to Arkiv.
      const e = mine ? all.find((f) => f.owner.toLowerCase() === mine) : undefined;
      if (!e || this.o.sync.status("listing", l.uid).state !== "synced") return { ...l, source: "facevisa", why: this.why("listing", l.uid) };
      fromArkiv++;
      return { ...l, name: String(e.values.display_name ?? l.name), rules: rulesOf(e.values), source: "arkiv", fits: fitting.has(e.key.toLowerCase()), entityKey: e.key, url: this.url(e.key) };
    });
    const strangers = all.filter((f) => !this.uidOf(f.owner)).length;
    return { listings, source: { from: "arkiv", namespace: this.o.prefix, entities: fromArkiv, fallback: backend.length - fromArkiv, ...(strangers ? { note: `${strangers} listing entities not owned by a FaceVisa account were ignored` } : {}) }, queries };
  }

  /** The creator's requests waiting for review: from Arkiv's pending requests for their address. */
  async inbox(uid: string, open: PendingAction[]): Promise<{ items: InboxItem[]; source: Source }> {
    const waiting = open.filter((a) => a.status === "review" || a.status === "verified");
    const address = this.o.keystore.address(`account:${uid}`);
    let found: Found[] = [];
    if (address) {
      try {
        found = await this.q("request", inboxQuery(this.o.prefix, address));
      } catch (e) {
        return { items: waiting.map((a) => ({ id: a.id, source: "facevisa", reviewBy: a.expiresAt, why: "Arkiv unreachable" })), source: { from: "facevisa", why: `Arkiv unreachable (${scrub(e)})` } };
      }
    }
    let fromArkiv = 0;
    const items = waiting.map((a): InboxItem => {
      // A request entity counts when its owner is the brand's key it names, and it's the one this request wrote.
      const e = found.find((f) => this.o.sync.subjectOf("request", f.key) === a.id && f.owner.toLowerCase() === String(f.values.brand).toLowerCase() && this.uidOf(f.owner) === a.brand);
      if (!e || this.o.sync.status("request", a.id).state !== "synced") return { id: a.id, source: "facevisa", reviewBy: a.expiresAt, why: this.why("request", a.id) };
      fromArkiv++;
      return { id: a.id, source: "arkiv", reviewBy: e.expiresAt, entityKey: e.key, url: this.url(e.key) };
    });
    return { items, source: { from: "arkiv", namespace: this.o.prefix, entities: fromArkiv, fallback: items.length - fromArkiv } };
  }

  /** Verify from Arkiv alone: the receipt owned by the platform receipt key, then its licence owned by the creator's key. */
  async verify(fileHash: string): Promise<VerifyOnArkiv> {
    const receiptKey = this.o.keystore.platformKey("receipt").address;
    const problems: string[] = [];
    try {
      const [r] = await this.q("receipt", receiptQuery(this.o.prefix, fileHash), { owner: receiptKey });
      if (!r) return { reachable: true, problems: [], note: "no receipt for this file on Arkiv from the FaceVisa receipt key" };
      const creator = typeof r.values.creator === "string" ? (r.values.creator as Hex) : undefined;
      const licenceEndsAt = typeof r.values.licence_expires_at === "number" ? r.values.licence_expires_at * 1000 : undefined;
      const receipt = {
        key: r.key,
        url: this.url(r.key),
        owner: r.owner,
        ownerOk: r.owner.toLowerCase() === receiptKey.toLowerCase(),
        ...(creator ? { creator } : {}),
        ...(licenceEndsAt ? { licenceEndsAt } : {}),
        ...(typeof r.values.payment_rail === "string" ? { paymentRail: r.values.payment_rail } : {}),
        ...(typeof r.values.payment_ref === "string" ? { paymentRef: r.values.payment_ref } : {}),
        ...(typeof r.values.face_check === "string" ? { faceCheck: r.values.face_check } : {}),
        ...(typeof r.values.face_score === "number" ? { faceScore: r.values.face_score / 1000 } : {}),
      };
      if (!receipt.ownerOk) problems.push("the receipt isn't owned by the FaceVisa receipt key");
      // The creator's display name, from their own listing (owner = the creator the receipt names); none if it's gone.
      const named = creator ? (await this.q("listing", [...ns(this.o.prefix, "listing")], { owner: creator }))[0] : undefined;
      const creatorName = named && typeof named.values.display_name === "string" ? named.values.display_name : undefined;
      // The creator's revocation record first: it outlives the licence entity. Only the creator's key counts.
      const [rv] = await this.q("revocation", revocationQuery(this.o.prefix, r.values.licence_key as Hex), creator ? { owner: creator } : {});
      const revocation = rv && (creator || (rv.owner.toLowerCase() === String(rv.values.creator).toLowerCase() && this.uidOf(rv.owner))) ? { key: rv.key, url: this.url(rv.key), owner: rv.owner, ownerOk: true, revokedAt: Number(rv.values.revoked_at) * 1000 } : undefined;
      const [l] = await this.q("licence", byKey(this.o.prefix, "licence", r.values.licence_key as Hex));
      if (!l && revocation) return { reachable: true, receipt, revocation, ...(creatorName ? { creatorName } : {}), ...(problems.length ? {} : { verdict: "Revoked" as const }), problems, note: "the licence was revoked; its entity has since expired on Arkiv, and the creator's revocation record remains" };
      if (!l) {
        // Gone from queries: Arkiv deletes an entity when it expires. The receipt says when the licence ended.
        if (licenceEndsAt !== undefined && licenceEndsAt > this.now()) return { reachable: true, receipt, ...(creatorName ? { creatorName } : {}), problems: [...problems, "the licence entity is missing before the end its receipt records"] };
        return { reachable: true, receipt, ...(creatorName ? { creatorName } : {}), ...(problems.length ? {} : { verdict: "Expired" as const }), ...(licenceEndsAt !== undefined ? { licenceEndedAt: licenceEndsAt } : {}), problems, note: licenceEndsAt !== undefined ? "the licence has ended: its entity expired on Arkiv, and the receipt records its end" : "its licence entity has ended on Arkiv (an entity is deleted when it expires)" };
      }
      // The licence must be the creator's own entity: owned by the creator the receipt names (older receipts: the
      // licence's own creator column, a FaceVisa account key).
      const ownerOk = creator
        ? l.owner.toLowerCase() === creator.toLowerCase() && String(l.values.creator).toLowerCase() === creator.toLowerCase()
        : l.owner.toLowerCase() === String(l.values.creator).toLowerCase() && !!this.uidOf(l.owner);
      if (!ownerOk) problems.push("the licence isn't owned by the creator the receipt names");
      if (String(l.values.output_hash).toLowerCase() !== fileHash.toLowerCase()) problems.push("the licence is for a different file");
      const licence = {
        key: l.key,
        url: this.url(l.key),
        owner: l.owner,
        ownerOk,
        status: String(l.values.status),
        expiresAt: l.expiresAt,
        identity: String(l.values.identity),
        licenceId: String(l.values.licence_id),
        usage: String(l.values.usage),
        kind: String(l.values.kind),
        durationDays: Number(l.values.duration_days),
        price: Number(l.values.price),
        creator: l.values.creator as Hex,
        brand: l.values.brand as Hex,
        approvedAt: Number(l.values.approved_at) * 1000,
      };
      const verdict = problems.length ? undefined : revocation || licence.status === "revoked" ? "Revoked" : licence.expiresAt <= this.now() ? "Expired" : "Licensed";
      return { reachable: true, receipt, licence, ...(creatorName ? { creatorName } : {}), ...(revocation ? { revocation } : {}), ...(verdict ? { verdict } : {}), problems };
    } catch (e) {
      return { reachable: false, error: scrub(e), problems: [] };
    }
  }
}
