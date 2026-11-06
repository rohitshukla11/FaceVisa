/**
 * Payments on Whitechain Sepolia (chain 1874), in Whitechain's USDT (TetherTokenV2: EIP-3009), gasless for the brand.
 *
 * After the creator approves the exact ad (and the brand any spend over its limit), the release step pays:
 *   1. the brand's custodial key (the keystore's `account:<uid>`, the same EVM key as on Arkiv) signs an EIP-3009
 *      ReceiveWithAuthorization: from the brand, to FaceVisaSettlement, the price, valid one hour, with the nonce
 *      `nonceFor(licenceId, fileHash, creator, amount)` (bound to this licence of this file, this creator, this amount);
 *   2. the relayer (a platform key holding WBT only) signs `settle(payment, signature)`; its hash is recorded on the
 *      payment BEFORE it's broadcast, so a restart finds it and never pays twice;
 *   3. FaceVisaSettlement pulls the USDT from the brand, forwards it to the creator and emits LicensePaid; the
 *      transaction hash is the receipt's payment reference (Verify, the direct verifier and Arkiv point at it).
 * The brand never holds WBT, signs a transaction or sees a chain.
 *
 * What stops the relayer being drained: it relays only approved ads (the pipeline's gate), per payment and per day
 * caps here AND in the contract, a gas-price ceiling, the contract accepts calls from the relayer only, and the relayer
 * holds gas only (never USDT). Its WBT balance is a health warning below WHITECHAIN_RELAYER_LOW_WBT.
 *
 * Settings: WHITECHAIN_SETTLEMENT (required), WHITECHAIN_RPC_URL, WHITECHAIN_USDT, WHITECHAIN_EXPLORER,
 * WHITECHAIN_RELAYER_KEY_FILE, WHITECHAIN_OPERATOR_KEY_FILE (the public demo's top-ups), WHITECHAIN_MAX_PER_PAYMENT_USDT
 * (1.00), WHITECHAIN_MAX_PER_DAY_USDT (20.00), WHITECHAIN_MAX_GAS_GWEI (50), WHITECHAIN_RELAYER_LOW_WBT (0.05).
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseGwei,
  stringToBytes,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Accounts } from "../app/accounts.js";
import type { Keystore } from "../app/keystore.js";
import { licenceIdFor, type FaceVisaData, type Payment, type PendingAction } from "../facevisa/data.js";
import { PaymentPending, PipelineError, type PaymentRail } from "../facevisa/pipeline.js";

export const WHITECHAIN_RAIL = "whitechain";
export const WHITECHAIN_CHAIN_ID = 1874;
export const WHITECHAIN_USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as const;
/** Tether's EIP-712 domain on Whitechain (from its DOMAIN_SEPARATOR: name "Tether USD", version "1"). */
export const USDT_DOMAIN = { name: "Tether USD", version: "1" } as const;

export const settlementAbi = parseAbi([
  "struct Payment { string licenceId; bytes32 fileHash; address brand; address creator; uint256 amount; uint256 validAfter; uint256 validBefore; }",
  "function settle(Payment p, bytes signature)",
  "function nonceFor(string licenceId, bytes32 fileHash, address creator, uint256 amount) pure returns (bytes32)",
  "function paused() view returns (bool)",
  "function relayer() view returns (address)",
  "function maxPerPayment() view returns (uint256)",
  "function maxPerDay() view returns (uint256)",
  "event LicensePaid(bytes32 indexed fileHash, string licenceId, address indexed creator, address indexed brand, uint256 amount)",
]);
const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export const whitechainChain = (rpcUrl: string) =>
  defineChain({ id: WHITECHAIN_CHAIN_ID, name: "Whitechain Sepolia", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

export interface WhitechainConfig {
  rpcUrl: string;
  explorer: string;
  usdt: Hex;
  settlement: Hex;
  relayerKey: Hex;
  operatorKey?: Hex;
  /** USDT's smallest units (6 decimals: the same as our micro-USD). */
  maxPerPayment: bigint;
  maxPerDay: bigint;
  maxGasPrice: bigint;
  relayerLowWei: bigint;
}

/** A 32-byte hex key from a file readable only by its owner (like the other platform keys). */
function readKey(file: string, root: string): Hex {
  const path = isAbsolute(file) ? file : resolve(root, file);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`Whitechain: no key file at ${file}`);
  if (st.mode & 0o077) throw new Error(`Whitechain: ${file} is readable by others (chmod 600 it)`);
  const k = readFileSync(path, "utf8").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error(`Whitechain: ${file} isn't a 32-byte hex key`);
  return `0x${k}`;
}

const usdtUnits = (v: string | undefined, d: string) => BigInt(Math.round(Number(v || d) * 1e6));

export function whitechainConfigFromEnv(root: string, env = process.env): WhitechainConfig | undefined {
  if (!env.WHITECHAIN_SETTLEMENT) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.WHITECHAIN_SETTLEMENT)) throw new Error("WHITECHAIN_SETTLEMENT: the FaceVisaSettlement contract's address");
  const operatorFile = env.WHITECHAIN_OPERATOR_KEY_FILE || ".secrets/whitechain-operator-key";
  let operatorKey: Hex | undefined;
  try {
    operatorKey = readKey(operatorFile, root);
  } catch {
    operatorKey = undefined; // optional: only the public demo's top-ups need it
  }
  return {
    rpcUrl: env.WHITECHAIN_RPC_URL || "https://rpc.testnet.whitechain.io",
    explorer: (env.WHITECHAIN_EXPLORER || "https://explorer.testnet.whitechain.io").replace(/\/$/, ""),
    usdt: (env.WHITECHAIN_USDT || WHITECHAIN_USDT) as Hex,
    settlement: env.WHITECHAIN_SETTLEMENT as Hex,
    relayerKey: readKey(env.WHITECHAIN_RELAYER_KEY_FILE || ".secrets/whitechain-relayer-key", root),
    ...(operatorKey ? { operatorKey } : {}),
    maxPerPayment: usdtUnits(env.WHITECHAIN_MAX_PER_PAYMENT_USDT, "1.00"),
    maxPerDay: usdtUnits(env.WHITECHAIN_MAX_PER_DAY_USDT, "20.00"),
    maxGasPrice: parseGwei(env.WHITECHAIN_MAX_GAS_GWEI || "50"),
    relayerLowWei: BigInt(Math.round(Number(env.WHITECHAIN_RELAYER_LOW_WBT || "0.05") * 1e18)),
  };
}

export const explorerTx = (c: Pick<WhitechainConfig, "explorer">, hash: string) => `${c.explorer}/tx/${hash}`;
export const explorerAddress = (c: Pick<WhitechainConfig, "explorer">, address: string) => `${c.explorer}/address/${address}`;

/** The nonce the contract recomputes: the authorization can only pay this licence, file, creator and amount. */
export const nonceFor = (licenceId: string, fileHash: Hex, creator: Hex, amount: bigint) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(stringToBytes(licenceId)), fileHash, creator, amount]));

/** What the chain client must do (viem's PublicClient in production; a fake in tests). */
export type WhitechainClient = Pick<PublicClient, "getBalance" | "readContract" | "getTransactionCount" | "estimateGas" | "getGasPrice" | "sendRawTransaction" | "waitForTransactionReceipt" | "getTransactionReceipt" | "simulateContract">;

export interface WhitechainDeps {
  data: FaceVisaData;
  accounts: Accounts;
  keystore: Keystore;
  config: WhitechainConfig;
  client?: WhitechainClient;
  /** The public demo: top a brand up with USDT from the operator (within the demo's caps); a refusal reason, or true. */
  topUp?: (brand: string, address: Hex, have: bigint, price: bigint) => Promise<true | string | undefined>;
  /** How long to wait for the settlement's receipt before it's "pending" (default 90 s). */
  receiptMs?: number;
  /** A settlement sent but not confirmed in time: the runtime keeps watching it (reconcile) without a restart. */
  onPending?: (p: Payment) => void;
  /** How often reconcile asks the chain again (default 15 s). */
  pollMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** A PaymentRail for the pipeline's release step. */
export class WhitechainRail implements PaymentRail {
  readonly name = WHITECHAIN_RAIL;
  readonly client: WhitechainClient;
  readonly relayer: PrivateKeyAccount;
  readonly operator: PrivateKeyAccount | undefined;
  /** One relayer transaction is signed and broadcast at a time (its nonce). */
  private queue: Promise<unknown> = Promise.resolve();
  /** What each authorized payment will settle: the brand's signed authorization and the call. */
  private readonly prepared = new Map<string, { call: Hex; validBefore: bigint }>();

  constructor(readonly d: WhitechainDeps) {
    this.client = d.client ?? (createPublicClient({ chain: whitechainChain(d.config.rpcUrl), transport: http(d.config.rpcUrl, { timeout: 60_000, retryCount: 2 }) }) as unknown as WhitechainClient);
    this.relayer = privateKeyToAccount(d.config.relayerKey);
    this.operator = d.config.operatorKey ? privateKeyToAccount(d.config.operatorKey) : undefined;
  }

  private log(line: string) {
    (this.d.log ?? ((l: string) => console.log(l)))(`[whitechain] ${line}`);
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** An account's address on Whitechain, where its creator profile is paid: its custodial key (created on first need). */
  address(uid: string): Hex {
    return this.d.keystore.accountKey(uid).address;
  }

  /** The wallet an account's brand workspace pays from (its own key, so a brand can license its own creator profile). */
  payerAddress(uid: string): Hex {
    return this.d.keystore.brandWalletKey(uid).address;
  }

  usdtBalance(address: Hex): Promise<bigint> {
    return this.client.readContract({ address: this.d.config.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>;
  }

  /** USDT settled through this rail today (UTC): the off-chain daily cap (the contract has its own). */
  private settledToday() {
    return BigInt(this.d.data.railTotalToday(WHITECHAIN_RAIL));
  }

  /** Before anything is made: what stops this brand paying this price (or undefined). Tops a demo brand up. */
  async shortfall(brand: string, price: number): Promise<string | undefined> {
    const units = BigInt(price);
    if (units > this.d.config.maxPerPayment) return `$${formatUnits(units, 6)} is over the per-payment cap of ${formatUnits(this.d.config.maxPerPayment, 6)} USDT`;
    const address = this.payerAddress(brand);
    const have = await this.usdtBalance(address).catch(() => undefined);
    if (have === undefined) return undefined; // the chain didn't answer: the release step checks again
    if (have >= units) return undefined;
    const t = await this.d.topUp?.(brand, address, have, units);
    if (t === true) return undefined;
    return typeof t === "string" ? t : `your brand wallet ${address} on Whitechain holds ${formatUnits(have, 6)} USDT and this ad costs $${formatUnits(units, 6)}`;
  }

  async authorize(p: { action: PendingAction; amount: number }): Promise<Payment> {
    const a = p.action;
    const c = this.d.config;
    if (!a.output) throw new PipelineError(409, "there's no finished ad to pay for");
    const amount = BigInt(p.amount);
    if (amount <= 0n) throw new PipelineError(402, "nothing to pay");
    if (amount > c.maxPerPayment) throw new PipelineError(402, `$${formatUnits(amount, 6)} is over the per-payment cap of ${formatUnits(c.maxPerPayment, 6)} USDT`);
    if (this.settledToday() + amount > c.maxPerDay) throw new PipelineError(429, `the day's settlement cap of ${formatUnits(c.maxPerDay, 6)} USDT is reached (UTC)`);
    const brand = this.payerAddress(a.brand);
    const creator = this.address(a.creator);
    // The brand needs the USDT (a demo brand is topped up); the relayer needs gas; the gas price must be sane.
    const short = await this.shortfall(a.brand, p.amount);
    if (short) throw new PipelineError(402, short);
    const [gas, gasPrice] = await Promise.all([this.client.getBalance({ address: this.relayer.address }), this.client.getGasPrice()]);
    if (gasPrice > c.maxGasPrice) throw new PipelineError(503, `Whitechain's gas price (${formatUnits(gasPrice, 9)} gwei) is over the relayer's ceiling: try again later`);
    if (gas < 2_000_000n * gasPrice) throw new PipelineError(503, "the payment relayer is out of gas (WBT): the operator tops it up; nothing was charged");

    const licenceId = licenceIdFor(a.id);
    const fileHash = a.output.hash.toLowerCase() as Hex;
    const validBefore = BigInt(Math.floor(this.now() / 1000) + 3600);
    const nonce = nonceFor(licenceId, fileHash, creator, amount);
    const signature = await this.d.keystore.account(`wallet:brand-${a.brand}`).signTypedData({
      domain: { ...USDT_DOMAIN, chainId: WHITECHAIN_CHAIN_ID, verifyingContract: c.usdt },
      types: { ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "ReceiveWithAuthorization",
      message: { from: brand, to: c.settlement, value: amount, validAfter: 0n, validBefore, nonce },
    });
    const call = encodeFunctionData({ abi: settlementAbi, functionName: "settle", args: [{ licenceId, fileHash, brand, creator, amount, validAfter: 0n, validBefore }, signature] });
    // A dry run: the contract's own checks (caps, pause, once per licence) and Tether's (signature, balance) answer now.
    try {
      await this.client.estimateGas({ account: this.relayer.address, to: c.settlement, data: call });
    } catch (e) {
      throw new PipelineError(402, `the settlement would fail: ${((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]}`);
    }
    const payment = this.d.data.authorizePayment({ actionId: a.id, brand: a.brand, amount: p.amount, rail: WHITECHAIN_RAIL, payer: brand, payee: creator });
    this.prepared.set(payment.id, { call, validBefore });
    return payment;
  }

  /** Signs the relayer's transaction, records its hash, broadcasts it, and waits for LicensePaid. */
  async settle(p: Payment): Promise<string> {
    const prep = this.prepared.get(p.id);
    if (!prep) throw new PipelineError(409, "this payment wasn't prepared here (a restart?): pay again");
    const hash = await this.enqueue(async () => {
      const [nonce, gasPrice] = await Promise.all([this.client.getTransactionCount({ address: this.relayer.address, blockTag: "pending" }), this.client.getGasPrice()]);
      const gas = (await this.client.estimateGas({ account: this.relayer.address, to: this.d.config.settlement, data: prep.call })) * 13n / 10n;
      const raw = await this.relayer.signTransaction({ chainId: WHITECHAIN_CHAIN_ID, type: "legacy", to: this.d.config.settlement, data: prep.call, nonce, gas, gasPrice });
      const txHash = keccak256(raw);
      // Recorded before it's sent: a restart now finds it on the chain (or not) and never pays twice.
      this.d.data.setPaymentRef(p.id, txHash);
      await this.client.sendRawTransaction({ serializedTransaction: raw });
      this.log(`settle sent: ${p.id} (${formatUnits(BigInt(p.amount), 6)} USDT) ${explorerTx(this.d.config, txHash)}`);
      return txHash;
    });
    this.prepared.delete(p.id);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: this.d.receiptMs ?? 90_000 });
    } catch {
      const pending = { ...p, ref: hash };
      this.d.onPending?.(pending);
      throw new PaymentPending(pending, `the USDT payment was sent on Whitechain (${hash}) and isn't confirmed yet`);
    }
    if (receipt.status !== "success") throw new PipelineError(502, `the settlement transaction reverted on Whitechain (${explorerTx(this.d.config, hash)}); nothing was charged`);
    if (!this.licensePaid(receipt.logs)) throw new PipelineError(502, `the settlement transaction has no LicensePaid event (${hash})`);
    this.d.data.settlePayment(p.id, hash);
    return hash;
  }

  async void(p: Payment) {
    this.prepared.delete(p.id);
    this.d.data.voidPayment(p.id);
  }

  private licensePaid(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]) {
    for (const l of logs) {
      if (l.address.toLowerCase() !== this.d.config.settlement.toLowerCase()) continue;
      try {
        const e = decodeEventLog({ abi: settlementAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "LicensePaid") return e.args;
      } catch {
        // another event
      }
    }
    return undefined;
  }

  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A payment sent but not confirmed (slow chain, or after a restart): the chain decides. Mined and successful: released (never paid
   * again). Reverted, or never mined once the authorization has expired (an hour after it was signed): abandoned, so
   * the ad can be paid for again. Otherwise it's checked again in 15 s.
   */
  async reconcile(p: Payment, done: { finish: (p: Payment, ref: string) => void; abandon: (p: Payment, why: string) => void }): Promise<void> {
    const hash = p.ref as Hex;
    for (;;) {
      // Settled or voided meanwhile (another watcher, or a restart's): nothing more to do.
      if (this.d.data.payment(p.id)?.status !== "authorized") return;
      const r = await this.client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (r?.status === "success" && this.licensePaid(r.logs)) {
        this.d.data.settlePayment(p.id, hash);
        return done.finish(p, hash);
      }
      if (r && r.status !== "success") return done.abandon(p, `the settlement reverted on Whitechain (${hash})`);
      if (this.now() > p.createdAt + 3600_000 + 120_000) return done.abandon(p, "the settlement was never mined and its authorization has expired");
      await new Promise((res) => setTimeout(res, this.d.pollMs ?? 15_000));
    }
  }

  /** The public demo: send `units` USDT from the operator to a brand; the transaction hash. */
  async sendUsdt(to: Hex, units: bigint): Promise<Hex> {
    if (!this.operator) throw new Error("the Whitechain operator key isn't configured (WHITECHAIN_OPERATOR_KEY_FILE)");
    const operator = this.operator;
    return this.enqueueOperator(async () => {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
      const [nonce, gasPrice] = await Promise.all([this.client.getTransactionCount({ address: operator.address, blockTag: "pending" }), this.client.getGasPrice()]);
      const gas = (await this.client.estimateGas({ account: operator.address, to: this.d.config.usdt, data })) * 13n / 10n;
      const raw = await operator.signTransaction({ chainId: WHITECHAIN_CHAIN_ID, type: "legacy", to: this.d.config.usdt, data, nonce, gas, gasPrice });
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
      const r = await this.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (r.status !== "success") throw new Error(`the top-up reverted (${hash})`);
      return hash;
    });
  }

  private operatorQueue: Promise<unknown> = Promise.resolve();
  private enqueueOperator<T>(f: () => Promise<T>): Promise<T> {
    const run = this.operatorQueue.then(f, f);
    this.operatorQueue = run.catch(() => undefined);
    return run;
  }

  /** For the health check: the relayer's gas, the operator's balances, the contract's state. */
  async status() {
    const c = this.d.config;
    const [relayerWei, paused, onChainRelayer, perPayment, perDay] = await Promise.all([
      this.client.getBalance({ address: this.relayer.address }),
      this.client.readContract({ address: c.settlement, abi: settlementAbi, functionName: "paused" }) as Promise<boolean>,
      this.client.readContract({ address: c.settlement, abi: settlementAbi, functionName: "relayer" }) as Promise<Hex>,
      this.client.readContract({ address: c.settlement, abi: settlementAbi, functionName: "maxPerPayment" }) as Promise<bigint>,
      this.client.readContract({ address: c.settlement, abi: settlementAbi, functionName: "maxPerDay" }) as Promise<bigint>,
    ]);
    const operator = this.operator ? { address: this.operator.address, wbt: formatEther(await this.client.getBalance({ address: this.operator.address })), usdt: formatUnits(await this.usdtBalance(this.operator.address), 6) } : null;
    return { relayer: { address: this.relayer.address, wbt: formatEther(relayerWei), low: relayerWei < c.relayerLowWei, matchesContract: onChainRelayer.toLowerCase() === this.relayer.address.toLowerCase() }, operator, contract: { address: c.settlement, paused, maxPerPayment: formatUnits(perPayment, 6), maxPerDay: formatUnits(perDay, 6) } };
  }
}

/**
 * A payment as Whitechain records it: the transaction succeeded and LicensePaid paid `creator` `units` USDT for
 * `fileHash` through our settlement contract. What Verify shows (the direct verifier does the same from the browser).
 * Never throws. Same shape as Hedera's check, so the pages read either.
 */
export async function checkWhitechainPayment(
  p: { txHash: string; fileHash: string; creator: string | null; units: number },
  o: { rpcUrl: string; settlement: Hex; usdt: Hex; explorer: string; client?: Pick<PublicClient, "getTransactionReceipt"> },
) {
  const out = { state: "not-found" as "confirmed" | "mismatch" | "not-found" | "unreachable", txId: p.txHash, hashscan: explorerTx(o, p.txHash), explorer: explorerTx(o, p.txHash), checks: [] as { ok: boolean; text: string }[], error: undefined as string | undefined };
  const client = o.client ?? createPublicClient({ chain: whitechainChain(o.rpcUrl), transport: http(o.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  let r;
  try {
    r = await client.getTransactionReceipt({ hash: p.txHash as Hex });
  } catch (e) {
    const msg = (e as Error).message;
    if (/could not be found|not found/i.test(msg)) return out;
    return { ...out, state: "unreachable" as const, error: msg.split("\n")[0]!.slice(0, 120) };
  }
  let paid: { fileHash: Hex; licenceId: string; creator: Hex; brand: Hex; amount: bigint } | undefined;
  let moved = false;
  for (const l of r.logs) {
    try {
      if (l.address.toLowerCase() === o.settlement.toLowerCase()) {
        const e = decodeEventLog({ abi: settlementAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "LicensePaid") paid = e.args as typeof paid;
      }
      if (l.address.toLowerCase() === o.usdt.toLowerCase()) {
        const e = decodeEventLog({ abi: transferEvent, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.args.to.toLowerCase() === (p.creator ?? "").toLowerCase() && e.args.value === BigInt(p.units)) moved = true;
      }
    } catch {
      // another event
    }
  }
  const checks = [
    { ok: r.status === "success", text: r.status === "success" ? "the transaction succeeded" : "the transaction reverted" },
    { ok: !!paid, text: paid ? "LicensePaid was emitted by FaceVisa's settlement contract" : "no LicensePaid from the settlement contract" },
    { ok: !!paid && paid.fileHash.toLowerCase() === p.fileHash.toLowerCase(), text: "for this exact file" },
    { ok: !!paid && !!p.creator && paid.creator.toLowerCase() === p.creator.toLowerCase(), text: "to the creator on the receipt" },
    { ok: !!paid && paid.amount === BigInt(p.units) && moved, text: `${formatUnits(BigInt(p.units), 6)} USDT moved to the creator` },
  ];
  return { ...out, state: checks.every((c) => c.ok) ? ("confirmed" as const) : ("mismatch" as const), checks };
}
