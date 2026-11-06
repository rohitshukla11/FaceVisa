/**
 * Talking to Rabdi (Arkiv's testnet): configuration, and the one client every Arkiv write and read goes through.
 *
 * Writes follow Arkiv's write-safety rules. Every signature uses a fresh nonce from `latest`, the current gas price
 * and gas = max(1,000,000 + 400,000 × (operations − 1), 2 × an unsigned estimate of the exact signed call), at most
 * half the latest block's gas limit. The transport sees each signed transaction before it is broadcast: it checks
 * the gas, then hands the hash to `onSigned` (the outbox stores it, synchronously) and only then forwards it. A send
 * that fails before that point was never broadcast; after it, the outcome is uncertain and is reconciled from the
 * hash, never re-sent.
 *
 * The access key goes in an X-API-KEY header, never in a URL, and errors are scrubbed before anyone logs them.
 */
import { createPublicClient, createWalletClient, type PublicArkivClient } from "@arkiv-network/sdk";
import type { CreateEntityParameters, ExtendEntityParameters, PatchEntityParameters } from "@arkiv-network/sdk";
import { and, eq, gte, lte } from "@arkiv-network/sdk/query";
import { addr, key, u64 } from "@arkiv-network/sdk/schema";
import { defineChain, formatEther, http, keccak256, parseEther, parseTransaction, TransactionReceiptNotFoundError, type Hex, type Transport } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { estimateGas, getGasPrice } from "viem/actions";
import { arkivSchemas, U64_KEYS, type ArkivSchemas, type EntityKind, type Plain } from "./schema.js";

export const RABDI_CHAIN_ID = 7794095;
/** Development and tests: anything goes, labelled by identity. Dev-only short lifetimes are allowed only here. */
export const DEV_NAMESPACE = "facevisa-dev";
/** Real data only: real World ID, Proof of Presence, a fresh database (see guardNamespace in runtime.ts). */
export const REAL_NAMESPACE = "facevisa-v1";
/** The deployed public demo (FACEVISA_PUBLIC_DEMO=1): demo identities, labelled; never the demo's or the real namespace. */
export const PUBLIC_NAMESPACE = "facevisa-public";
/** A top-up never exceeds this, whatever ARKIV_FUNDER_TOPUP says. */
const MAX_TOPUP = parseEther("1");
/** No single write may cost more than this (gas × gas price): a guard against a gas-price spike. */
export const MAX_FEE = parseEther("0.05");

export interface ArkivConfig {
  rpcUrl: string;
  chainId: number;
  accessKey: string;
  prefix: string;
  explorerUrl: string;
  /** What the funder sends an account key before its first write, wei. */
  topup: bigint;
}

/** Arkiv's settings, or undefined while ARKIV_ENABLED isn't 1. Throws on a setting that can't be right. */
export function arkivConfigFromEnv(env = process.env): ArkivConfig | undefined {
  if (env.ARKIV_ENABLED !== "1") return undefined;
  const chainId = Number(env.ARKIV_CHAIN_ID || RABDI_CHAIN_ID);
  if (chainId !== RABDI_CHAIN_ID) throw new Error(`ARKIV_CHAIN_ID: only Rabdi (${RABDI_CHAIN_ID}) is supported`);
  const prefix = env.ARKIV_SCHEMA_PREFIX || "facevisa-dev";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(prefix)) throw new Error("ARKIV_SCHEMA_PREFIX: lowercase letters, digits and dashes, at most 32");
  const rpcUrl = env.ARKIV_RPC_URL || "https://rpc.rabdi.db-chain.testnet.arkiv.network";
  if (!/^https:\/\/[^/?#]+\/?$/.test(rpcUrl)) throw new Error("ARKIV_RPC_URL: an https origin with no path (the access key goes in a header)");
  let topup: bigint;
  try {
    topup = parseEther(env.ARKIV_FUNDER_TOPUP || "0.05");
  } catch {
    throw new Error("ARKIV_FUNDER_TOPUP: an amount of tGLM, e.g. 0.05");
  }
  if (topup <= 0n || topup > MAX_TOPUP) throw new Error(`ARKIV_FUNDER_TOPUP: above 0 and at most ${formatEther(MAX_TOPUP)} tGLM`);
  return { rpcUrl: rpcUrl.replace(/\/$/, ""), chainId, accessKey: env.ARKIV_ACCESS_KEY ?? "", prefix, explorerUrl: (env.ARKIV_EXPLORER_URL || "https://rabdi.explorer.arkiv.network").replace(/\/$/, ""), topup };
}

/** An error as it may be logged or shown: one line, no URLs, no access key, no nested causes. */
export function scrub(e: unknown, accessKey = process.env.ARKIV_ACCESS_KEY ?? ""): string {
  const err = e as { name?: string; shortMessage?: string; message?: string };
  let s = `${err?.name ?? "Error"}: ${(err?.shortMessage ?? err?.message ?? String(e)).split("\n")[0]}`;
  if (accessKey) s = s.split(accessKey).join("[key]");
  return s.replace(/\b(?:https?|wss?):\/\/\S+/g, "[url]").replace(/\bark_\w+/g, "[key]").slice(0, 240);
}

/** One condition of a query, on an indexed column (or `$key`): what the shortlist, inbox and Verify filter on. */
export type Cond = { col: string; op: "eq" | "lte" | "gte"; value: string | number | boolean };
/** An entity as read from Arkiv: its key, owner, when it expires (ms, from the chain's block timing) and its columns. */
export interface Found {
  key: Hex;
  owner: Hex;
  expiresAt: number;
  values: Plain;
}

export type Ops = { creates?: CreateEntityParameters[]; patches?: PatchEntityParameters[]; extensions?: ExtendEntityParameters[]; deletes?: { entityKey: Hex }[] };

export interface SendHooks {
  /** Called with the signed transaction's hash and nonce before it is broadcast; if it throws, nothing is sent. */
  onSigned(hash: Hex, nonce: number): void;
}

/** What the outbox needs from Arkiv. The real one talks to Rabdi; tests pass a fake. */
export interface ArkivClient {
  chainId(): Promise<number>;
  balance(address: Hex): Promise<bigint>;
  /** The next nonce at `latest`. */
  nonce(address: Hex): Promise<number>;
  receipt(hash: Hex): Promise<"success" | "reverted" | undefined>;
  /** The entity of this type that `owner` created with `ref`, if it exists (and hasn't expired). */
  findByRef(kind: EntityKind, owner: Hex, ref: string): Promise<Hex | undefined>;
  /** Entities of this type (its named schema) matching every condition, at most `limit` (≤ 100), optionally by owner. */
  query(kind: EntityKind, conds: Cond[], opts?: { owner?: Hex; limit?: number }): Promise<Found[]>;
  execute(signer: PrivateKeyAccount, ops: Ops, hooks: SendHooks): Promise<{ txHash: Hex; createdKeys: Hex[] }>;
  transfer(signer: PrivateKeyAccount, to: Hex, value: bigint, hooks: SendHooks): Promise<{ txHash: Hex }>;
}

const U64_COLS = U64_KEYS;
const ADDR_COLS = new Set(["brand", "creator", "payer"]);
const KEY_COLS = new Set(["request_key", "licence_key"]);

/** Gas for a signature: the operation floor and twice the estimate, within half a block. */
export function gasFor(ops: number, estimate: bigint, blockGasLimit: bigint): bigint {
  const floor = 1_000_000n + 400_000n * BigInt(Math.max(ops, 1) - 1);
  const gas = estimate * 2n > floor ? estimate * 2n : floor;
  if (gas > blockGasLimit / 2n) throw new Error(`gas ${gas} is over half the block gas limit (${blockGasLimit})`);
  return gas;
}

export class RabdiClient implements ArkivClient {
  readonly schemas: ArkivSchemas;
  readonly pub: PublicArkivClient;
  private readonly chain;

  constructor(private readonly c: ArkivConfig) {
    this.schemas = arkivSchemas(c.prefix);
    this.chain = defineChain({ id: c.chainId, name: "Rabdi", nativeCurrency: { name: "Golem", symbol: "tGLM", decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } });
    this.pub = createPublicClient({ chain: this.chain, transport: this.transport() });
  }

  /** HTTP with the access key in a header; with a guard, every signed transaction passes it before broadcast. */
  private transport(guard?: (raw: Hex) => Promise<void>): Transport {
    const base = http(this.c.rpcUrl, { fetchOptions: { headers: this.c.accessKey ? { "X-API-KEY": this.c.accessKey } : {} }, retryCount: 1 });
    return (opts) => {
      const t = base(opts);
      return {
        ...t,
        request: (async (args: { method: string; params?: unknown }) => {
          if (args.method === "eth_sendTransaction") throw new Error("refused: only locally signed transactions");
          if (args.method === "eth_sendRawTransaction") {
            if (!guard) throw new Error("refused: a write without the send guard");
            await guard((args.params as [Hex])[0]);
          }
          return t.request(args as never);
        }) as typeof t.request,
      };
    };
  }

  async chainId() {
    return this.pub.getChainId();
  }

  async balance(address: Hex) {
    return this.pub.getBalance({ address });
  }

  async nonce(address: Hex) {
    return this.pub.getTransactionCount({ address, blockTag: "latest" });
  }

  async receipt(hash: Hex) {
    try {
      return (await this.pub.getTransactionReceipt({ hash })).status;
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return undefined;
      throw e;
    }
  }

  async query(kind: EntityKind, conds: Cond[], opts: { owner?: Hex; limit?: number } = {}): Promise<Found[]> {
    const ops = { eq, lte, gte };
    const value = (c: Cond) => (c.col === "$key" ? key(c.value as Hex) : U64_COLS.has(c.col) ? u64(c.value as number) : ADDR_COLS.has(c.col) ? addr(c.value as Hex) : KEY_COLS.has(c.col) ? key(c.value as Hex) : c.value);
    const where = conds.map((c) => ops[c.op](c.col as never, value(c) as never));
    let q = this.pub.select().from(this.schemas[kind]);
    if (where.length) q = q.where(and(...where) as never) as never;
    if (opts.owner) q = q.ownedBy(opts.owner);
    const [page, timing] = await Promise.all([q.limit(Math.min(opts.limit ?? 100, 100)).fetch(), this.pub.getBlockTiming()]);
    return page.entities.map((row) => {
      const r = row as unknown as Record<string, unknown>;
      const values: Plain = {};
      for (const col of Object.keys(this.schemas[kind].columns)) {
        const v = (r[col] as { value?: unknown } | undefined)?.value;
        if (v !== undefined) values[col] = typeof v === "bigint" ? Number(v) : (v as string | boolean);
      }
      const expiresAt = BigInt(r.$expiresAt as bigint);
      return { key: r.$key as Hex, owner: r.$owner as Hex, expiresAt: (timing.currentBlockTime + Number(expiresAt - timing.currentBlock) * timing.blockDuration) * 1000, values };
    });
  }

  async findByRef(kind: EntityKind, owner: Hex, ref: string) {
    const page = await this.pub.select({ $key: true }).from(this.schemas[kind]).where(eq("ref", ref)).ownedBy(owner).limit(1).fetch();
    return page.entities[0]?.$key as Hex | undefined;
  }

  /**
   * One signature, once. The first try signs with the operation floor; if the exact estimate needs more, the guard
   * refuses that signature before broadcast and the second try signs with 2 × the estimate.
   */
  private async signOnce<T>(signer: PrivateKeyAccount, ops: number, floor: (n: number) => bigint, send: (wallet: ReturnType<typeof createWalletClient>, tx: { nonce: number; gas: bigint; gasPrice: bigint }) => Promise<T>, hooks: SendHooks): Promise<T> {
    let gas = floor(ops);
    for (let attempt = 0; ; attempt++) {
      const [nonce, gasPrice, block] = await Promise.all([this.nonce(signer.address), getGasPrice(this.pub as never), this.pub.getBlock({ blockTag: "latest" })]);
      let needs: bigint | undefined;
      const guard = async (raw: Hex) => {
        const tx = parseTransaction(raw);
        if (tx.nonce !== nonce || tx.gas !== gas || tx.gasPrice !== gasPrice) throw new Error("refused: the signed transaction isn't the one prepared");
        const estimate = await estimateGas(this.pub as never, { account: signer.address, to: tx.to!, data: tx.data, value: tx.value });
        const want = ops === 0 ? (estimate * 2n > 21_000n ? estimate * 2n : 21_000n) : gasFor(ops, estimate, block.gasLimit);
        if (want > gas) {
          needs = want;
          throw new Error("refused: more gas needed");
        }
        if (gas * gasPrice > MAX_FEE) throw new Error(`refused: a fee of up to ${formatEther(gas * gasPrice)} tGLM is over the ${formatEther(MAX_FEE)} cap`);
        hooks.onSigned(keccak256(raw), nonce);
      };
      const wallet = createWalletClient({ chain: this.chain, transport: this.transport(guard), account: signer });
      try {
        return await send(wallet, { nonce, gas, gasPrice });
      } catch (e) {
        if (needs !== undefined && attempt === 0) {
          gas = needs;
          continue;
        }
        throw e;
      }
    }
  }

  async execute(signer: PrivateKeyAccount, ops: Ops, hooks: SendHooks) {
    const n = (ops.creates?.length ?? 0) + (ops.patches?.length ?? 0) + (ops.extensions?.length ?? 0) + (ops.deletes?.length ?? 0);
    if (n === 0) throw new Error("nothing to send");
    const r = await this.signOnce(signer, n, (k) => gasFor(k, 0n, 2n ** 62n), (wallet, tx) => wallet.executeBatch(ops as never, tx), hooks);
    return { txHash: r.txHash, createdKeys: r.createdEntities };
  }

  async transfer(signer: PrivateKeyAccount, to: Hex, value: bigint, hooks: SendHooks) {
    const txHash = await this.signOnce(signer, 0, () => 21_000n, async (wallet, tx) => {
      const hash = await wallet.sendTransaction({ account: signer, chain: this.chain, to, value, ...tx });
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`transfer ${hash} reverted`);
      return hash;
    }, hooks);
    return { txHash };
  }
}
