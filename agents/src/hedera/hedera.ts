/**
 * Hedera (B4), testnet only: the operator and each FaceVisa account's Hedera account.
 *
 * - The operator is Rohit's Hedera Portal testnet account (HEDERA_OPERATOR_ID). Its key is read from a file readable
 *   only by its owner (HEDERA_OPERATOR_KEY_FILE, default .secrets/hedera-operator-key), never from env or output. It
 *   pays for account creation and token associations.
 * - Each FaceVisa account's Hedera account is created on first need from the account's existing custodial secp256k1
 *   key (the same key as its Arkiv key), as a complete account: the ECDSA key plus its EVM alias, never a hollow
 *   alias. It gets unlimited automatic token associations, and testnet USDC is associated explicitly, since both the
 *   payer and the payee must be associated before an x402 settlement. The account ID is stored with the account.
 * - Idempotent: before creating, the key's EVM alias is looked up on the mirror node, so a run interrupted after the
 *   create adopts that account instead of making a second one.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey, Status, TokenAssociateTransaction, TokenId, TopicCreateTransaction, TopicId, TopicMessageSubmitTransaction, TransferTransaction } from "@hiero-ledger/sdk";
import type { Accounts } from "../app/accounts.js";
import type { Keystore } from "../app/keystore.js";

/** Circle's USDC on Hedera testnet (6 decimals). */
export const USDC_TESTNET = "0.0.429274";

export interface HederaConfig {
  network: "testnet";
  operatorId: string;
  operatorKeyHex: string;
  mirrorUrl: string;
  usdc: string;
}

/** A transaction ID as the SDK writes it (0.0.x@seconds.nanos) in the mirror node's form (0.0.x-seconds-nanos). */
export const mirrorTxId = (id: string) => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
/** When a transaction ID's validity starts (ms): its payer chose it at signing. */
export const validStartMs = (id: string) => Number(id.split("@")[1]?.split(".")[0] ?? NaN) * 1000;

export const hashscan = {
  account: (id: string) => `https://hashscan.io/testnet/account/${id}`,
  transaction: (id: string) => `https://hashscan.io/testnet/transaction/${id}`,
  topic: (id: string) => `https://hashscan.io/testnet/topic/${id}`,
};

/** Settings, or undefined while HEDERA_OPERATOR_ID isn't set. Testnet only. */
export function hederaConfigFromEnv(root: string, env = process.env): HederaConfig | undefined {
  const operatorId = env.HEDERA_OPERATOR_ID;
  if (!operatorId) return undefined;
  if (!/^0\.0\.\d+$/.test(operatorId)) throw new Error("HEDERA_OPERATOR_ID: an account ID such as 0.0.1234");
  if ((env.HEDERA_NETWORK || "testnet") !== "testnet") throw new Error("HEDERA_NETWORK: only testnet for now");
  const file = env.HEDERA_OPERATOR_KEY_FILE || ".secrets/hedera-operator-key";
  const path = isAbsolute(file) ? file : resolve(root, file);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error("HEDERA_OPERATOR_KEY_FILE: no such file");
  if (st.mode & 0o077) throw new Error("HEDERA_OPERATOR_KEY_FILE: readable by others (chmod 600 it)");
  const key = readFileSync(path, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("HEDERA_OPERATOR_KEY_FILE: not a 32-byte hex ECDSA key");
  return { network: "testnet", operatorId, operatorKeyHex: key.replace(/^0x/, ""), mirrorUrl: (env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, ""), usdc: env.HEDERA_USDC_TOKEN || USDC_TESTNET };
}

export const TESTNET_MIRROR = "https://testnet.mirrornode.hedera.com";

export interface PaymentCheck {
  state: "confirmed" | "mismatch" | "not-found" | "unreachable";
  txId: string;
  hashscan: string;
  result?: string;
  consensusAt?: number;
  checks: { ok: boolean; text: string }[];
  error?: string;
}

/**
 * A payment as Hedera's mirror node records it: the transaction succeeded and moved exactly `units` of USDC from
 * `payer` to `payee`. What Verify shows; the direct verifier does the same from the browser. Never throws.
 */
export async function checkPayment(p: { txId: string; payer: string | null; payee: string | null; units: number }, o: { mirrorUrl?: string; usdc?: string; fetch?: typeof fetch } = {}): Promise<PaymentCheck> {
  const usdc = o.usdc ?? USDC_TESTNET;
  const out: PaymentCheck = { state: "not-found", txId: p.txId, hashscan: hashscan.transaction(p.txId), checks: [] };
  try {
    const r = await (o.fetch ?? fetch)(`${(o.mirrorUrl ?? TESTNET_MIRROR).replace(/\/$/, "")}/api/v1/transactions/${mirrorTxId(p.txId)}`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return out;
    if (!r.ok) throw new Error(`the mirror node answered HTTP ${r.status}`);
    const tx = ((await r.json()) as { transactions?: { result: string; consensus_timestamp: string; token_transfers?: { token_id: string; account: string; amount: number }[] }[] }).transactions?.[0];
    if (!tx) return out;
    const moved = (tx.token_transfers ?? []).filter((x) => x.token_id === usdc);
    const of = (acct: string | null) => moved.filter((x) => x.account === acct).reduce((n, x) => n + Number(x.amount), 0);
    out.result = tx.result;
    out.consensusAt = Math.round(Number(tx.consensus_timestamp) * 1000);
    out.checks.push({ ok: tx.result === "SUCCESS", text: `the transaction succeeded on Hedera (${tx.result})` });
    out.checks.push({ ok: !!p.payee && of(p.payee) === p.units, text: `the creator's account ${p.payee ?? "(none)"} received ${of(p.payee) / 1e6} USDC (the price: ${p.units / 1e6})` });
    out.checks.push({ ok: !!p.payer && of(p.payer) === -p.units, text: `the brand's account ${p.payer ?? "(none)"} paid it` });
    out.state = out.checks.every((c) => c.ok) ? "confirmed" : "mismatch";
    return out;
  } catch (e) {
    return { ...out, state: "unreachable", error: (e as Error).message.split("\n")[0] };
  }
}

export class Hedera {
  constructor(
    readonly config: HederaConfig,
    /** mayCreate: whether one more new Hedera account may be made now (the public demo's daily cap). */
    private readonly o: { accounts: Accounts; keystore: Keystore; fetch?: typeof fetch; mayCreate?: () => boolean },
  ) {}

  /** A client with the operator as payer. Close it after use. */
  operatorClient(): Client {
    return Client.forTestnet().setOperator(AccountId.fromString(this.config.operatorId), PrivateKey.fromStringECDSA(this.config.operatorKeyHex));
  }

  async mirror<T>(path: string): Promise<T | undefined> {
    const r = await (this.o.fetch ?? fetch)(`${this.config.mirrorUrl}/api/v1${path}`, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`mirror node: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  /** The operator's account, from the mirror node: key type and HBAR balance. */
  async operator() {
    const a = await this.mirror<{ account: string; key?: { _type: string }; balance: { balance: number } }>(`/accounts/${this.config.operatorId}`);
    if (!a) throw new Error(`the operator ${this.config.operatorId} isn't on testnet`);
    return { accountId: a.account, keyType: a.key?._type ?? "unknown", hbar: a.balance.balance / 1e8 };
  }

  /** A transaction's result on the mirror node (e.g. SUCCESS), or undefined while it isn't there. */
  async transaction(id: string): Promise<{ result: string; consensusAt: string } | undefined> {
    const r = await this.mirror<{ transactions: { result: string; consensus_timestamp: string }[] }>(`/transactions/${mirrorTxId(id)}`);
    const t = r?.transactions[0];
    return t && { result: t.result, consensusAt: t.consensus_timestamp };
  }

  /** The account's Hedera account ID: the stored one, else created now (accountFor). */
  async ensureAccount(uid: string): Promise<string> {
    return this.o.accounts.hederaAccount(uid) ?? (await this.accountFor(uid)).accountId;
  }

  /**
   * An account's USDC, in its smallest units (6 decimals), or null when it isn't associated with USDC. Throws when the
   * mirror node doesn't know the account (yet).
   */
  async usdcUnits(accountId: string): Promise<bigint | null> {
    const r = await this.mirror<{ tokens: { token_id: string; balance: number }[] }>(`/accounts/${accountId}/tokens?token.id=${this.config.usdc}`);
    if (!r) throw new Error(`${accountId} isn't on the mirror node`);
    const t = r?.tokens.find((x) => x.token_id === this.config.usdc);
    return t ? BigInt(t.balance) : null;
  }

  /** Sends USDC from the operator to an account (a brand's top-up), signed with the operator's key. Its transaction ID. */
  async sendUsdc(to: string, units: bigint): Promise<string> {
    if (units <= 0n) throw new Error("the amount must be positive");
    const client = this.operatorClient();
    try {
      const usdc = TokenId.fromString(this.config.usdc);
      const tx = new TransferTransaction().addTokenTransfer(usdc, AccountId.fromString(this.config.operatorId), -units).addTokenTransfer(usdc, AccountId.fromString(to), units).setTransactionMemo("FaceVisa: brand top-up (testnet)");
      const res = await tx.execute(client);
      const receipt = await res.getReceipt(client);
      if (receipt.status !== Status.Success) throw new Error(`transfer: ${receipt.status.toString()}`);
      return res.transactionId.toString();
    } finally {
      client.close();
    }
  }

  /**
   * USDC back from one of this database's accounts to the operator's reserve (e.g. unused demo funds). The account
   * signs with its custodial key; the operator pays the fee, so the account needs no HBAR.
   */
  async reclaimUsdc(uid: string, units: bigint): Promise<string> {
    if (units <= 0n) throw new Error("the amount must be positive");
    const { accounts, keystore } = this.o;
    const from = accounts.hederaAccount(uid);
    if (!from) throw new Error(`${uid} has no Hedera account`);
    const client = this.operatorClient();
    try {
      const usdc = TokenId.fromString(this.config.usdc);
      return await keystore.withPrivateKey(`account:${uid}`, async (hex) => {
        const key = PrivateKey.fromStringECDSA(hex.slice(2));
        const tx = await new TransferTransaction().addTokenTransfer(usdc, AccountId.fromString(from), -units).addTokenTransfer(usdc, AccountId.fromString(this.config.operatorId), units).setTransactionMemo("FaceVisa: back to the operator's reserve (testnet)").freezeWith(client).sign(key);
        const res = await tx.execute(client);
        const receipt = await res.getReceipt(client);
        if (receipt.status !== Status.Success) throw new Error(`transfer: ${receipt.status.toString()}`);
        return res.transactionId.toString();
      });
    } finally {
      client.close();
    }
  }

  /**
   * The operator associated with USDC: it holds the reserve brands are topped up from, and Circle's faucet mints only
   * to an associated account. True when this call associated it.
   */
  async associateOperator(): Promise<boolean> {
    if (await this.hasToken(this.config.operatorId)) return false;
    const client = this.operatorClient();
    try {
      const tx = new TokenAssociateTransaction().setAccountId(AccountId.fromString(this.config.operatorId)).setTokenIds([TokenId.fromString(this.config.usdc)]);
      const receipt = await (await tx.execute(client)).getReceipt(client);
      if (receipt.status !== Status.Success) throw new Error(`operator USDC association: ${receipt.status.toString()}`);
      return true;
    } finally {
      client.close();
    }
  }

  /** A new HCS topic, the operator its admin and only submitter. Its topic ID. */
  async createTopic(memo: string): Promise<string> {
    const client = this.operatorClient();
    try {
      const key = PrivateKey.fromStringECDSA(this.config.operatorKeyHex).publicKey;
      const res = await new TopicCreateTransaction().setTopicMemo(memo).setAdminKey(key).setSubmitKey(key).execute(client);
      const receipt = await res.getReceipt(client);
      if (receipt.status !== Status.Success || !receipt.topicId) throw new Error(`topic create: ${receipt.status.toString()}`);
      return receipt.topicId.toString();
    } finally {
      client.close();
    }
  }

  /** One message on a topic, paid and signed by the operator: its transaction ID and sequence number. */
  async submitMessage(topicId: string, message: string): Promise<{ txId: string; seq: number }> {
    const client = this.operatorClient();
    try {
      const res = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(topicId)).setMessage(message).execute(client);
      const receipt = await res.getReceipt(client);
      if (receipt.status !== Status.Success) throw new Error(`topic message: ${receipt.status.toString()}`);
      return { txId: res.transactionId.toString(), seq: Number(receipt.topicSequenceNumber ?? 0) };
    } finally {
      client.close();
    }
  }

  async hasToken(accountId: string): Promise<boolean> {
    const r = await this.mirror<{ tokens: { token_id: string }[] }>(`/accounts/${accountId}/tokens?token.id=${this.config.usdc}`);
    return !!r?.tokens.some((t) => t.token_id === this.config.usdc);
  }

  /**
   * The account's Hedera account, created on first need: complete (ECDSA key + its EVM alias), unlimited automatic
   * token associations, USDC associated. Returns its ID and what this call did.
   */
  async accountFor(uid: string): Promise<{ accountId: string; evmAddress: string; created: boolean; adopted: boolean; associated: boolean }> {
    const { accounts, keystore } = this.o;
    const name = `account:${uid}`;
    const evmAddress = keystore.accountKey(uid).address.toLowerCase();
    let accountId = accounts.hederaAccount(uid);
    let created = false;
    let adopted = false;
    const client = this.operatorClient();
    try {
      if (!accountId) {
        // Already created (an interrupted run)? The key's EVM alias resolves to it on the mirror node.
        const existing = await this.mirror<{ account: string; key?: { _type: string } }>(`/accounts/${evmAddress}`);
        if (existing?.account) {
          if (existing.key?._type !== "ECDSA_SECP256K1") throw new Error(`${evmAddress} resolves to ${existing.account}, which has no ECDSA key (a hollow alias?)`);
          accountId = existing.account;
          adopted = true;
        } else {
          if (this.o.mayCreate && !this.o.mayCreate()) throw new Error("the demo's new Hedera accounts for today are used up; try again tomorrow");
          const receipt = await keystore.withPrivateKey(name, async (hex) => {
            const key = PrivateKey.fromStringECDSA(hex.slice(2));
            // The alias needs the alias key's signature: we hold it (custodial), so the account signs its own creation.
            const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(key.publicKey).setMaxAutomaticTokenAssociations(-1).setInitialBalance(new Hbar(0)).freezeWith(client).sign(key);
            return (await tx.execute(client)).getReceipt(client);
          });
          if (receipt.status !== Status.Success || !receipt.accountId) throw new Error(`account create: ${receipt.status.toString()}`);
          accountId = receipt.accountId.toString();
          created = true;
        }
        accounts.setHederaAccount(uid, accountId);
      }
      // USDC: associated explicitly (the operator pays; the account signs). Already associated is fine.
      let associated = false;
      if (created || !(await this.hasToken(accountId))) {
        const status = await keystore.withPrivateKey(name, async (hex) => {
          const key = PrivateKey.fromStringECDSA(hex.slice(2));
          const tx = await new TokenAssociateTransaction().setAccountId(AccountId.fromString(accountId!)).setTokenIds([TokenId.fromString(this.config.usdc)]).freezeWith(client).sign(key);
          try {
            return (await (await tx.execute(client)).getReceipt(client)).status;
          } catch (e) {
            if (/TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT/.test(String((e as Error).message))) return Status.TokenAlreadyAssociatedToAccount;
            throw e;
          }
        });
        if (status !== Status.Success && status !== Status.TokenAlreadyAssociatedToAccount) throw new Error(`USDC association: ${status.toString()}`);
        associated = status === Status.Success;
      }
      return { accountId, evmAddress, created, adopted, associated };
    } finally {
      client.close();
    }
  }
}
