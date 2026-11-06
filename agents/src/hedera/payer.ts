/**
 * The brand agent's wallet (B4): a real x402 client over HTTP, even locally. For an ad its creator approved:
 *   1. GET the ad's x402 endpoint and read the 402;
 *   2. check the spending controls (below), before anything is signed;
 *   3. sign a USDC transfer with the brand's custodial key (the facilitator pays the fee);
 *   4. GET again with PAYMENT-SIGNATURE, and receive the file, whose sha256 must be the approved ad's.
 * No human approves individual payments. Above BRAND_STEPUP_USDC, the brand's own human approves the spend first,
 * in FaceVisa (an in-app approval by the brand, app/approval.ts).
 *
 * Spending controls, all before signing:
 * - the 402 must ask for exactly what was approved: scheme exact, hedera:testnet, USDC, the approved price, to the
 *   creator's own Hedera account (the x402 client's policy and per-payment cap enforce it again);
 * - the brand's daily budget (FACEVISA_BRAND_DAILY_BUDGET), counting what is already authorized or settled today;
 * - the step-up: over the limit, the brand's human must have approved this spend.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createClientHederaSigner, hederaAccountIdsEqual, type ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Keystore } from "../app/keystore.js";
import type { Licence, FaceVisaData, PendingAction } from "../facevisa/data.js";
import { PipelineError } from "../facevisa/pipeline.js";
import { usd } from "../facevisa/rules.js";
import type { Hedera } from "./hedera.js";
import { sha256Hex, X402_NETWORK, X402_PATH } from "./x402.js";

export interface PayerDeps {
  data: FaceVisaData;
  keystore: Keystore;
  hedera: Hedera;
  /** Where the backend answers (the agent calls its own x402 endpoint over HTTP). */
  baseUrl: string;
  dailyBudget: number;
  spendLimit?: number | undefined;
  creatorName(uid: string): string;
  fetch?: typeof fetch;
  /**
   * The public demo: tops a brand up when it can't cover an approved ad. true when it did (or needn't), a reason when
   * it can't, undefined when this brand isn't a demo brand.
   */
  topUp?: (brand: string, account: string, have: bigint, price: bigint) => Promise<true | string | undefined>;
}

/** Signs with the brand's key, lent by the keystore for the one signature and never kept. */
function keystoreSigner(keystore: Keystore, uid: string, accountId: string): ClientHederaSigner {
  return {
    accountId,
    createPartiallySignedTransferTransaction: (requirements) =>
      keystore.withPrivateKey(`account:${uid}`, (hex) => createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(hex.slice(2)), { network: X402_NETWORK }).createPartiallySignedTransferTransaction(requirements)),
  };
}

export class X402Payer {
  constructor(readonly d: PayerDeps) {}

  /** The spending controls: why this 402 must not be paid, or undefined. */
  refusal(a: PendingAction, required: PaymentRequired, payTo: string | null): string | undefined {
    const { data } = this.d;
    const released = a.status === "released";
    if (!released && a.status !== "approved") return `the request is ${a.status.replace("_", " ")}, not approved`;
    if (!payTo) return "the creator's Hedera account isn't known";
    if (!this.matching(a, required.accepts, payTo).length) {
      const asked = required.accepts.map((r) => `${r.amount} of ${r.asset} on ${r.network} to ${r.payTo}`).join(", ") || "nothing";
      return `the 402 asks for ${asked}; the creator approved ${usd(a.price)} (${a.price} USDC units) to ${payTo}`;
    }
    // Re-delivery of a paid ad moves no money: the signature only proves it's the brand.
    if (released) return undefined;
    const spent = data.spentToday(a.brand);
    if (spent + a.price > this.d.dailyBudget) return `the daily budget: ${usd(spent)} of ${usd(this.d.dailyBudget)} spent; ${usd(a.price)} more would exceed it`;
    if (this.d.spendLimit !== undefined && a.price > this.d.spendLimit && !a.spendCheck?.decidedAt) return `${usd(a.price)} is over the step-up limit of ${usd(this.d.spendLimit)} and the brand's human hasn't approved this spend`;
    return undefined;
  }

  private matching(a: PendingAction, accepts: readonly PaymentRequirements[], payTo: string) {
    return accepts.filter((r) => r.scheme === "exact" && r.network === X402_NETWORK && r.asset === this.d.hedera.config.usdc && r.amount === String(a.price) && hederaAccountIdsEqual(r.payTo, payTo));
  }

  /**
   * Why this brand can't pay `price` now: its USDC on the mirror node, from its Hedera account (made on first need).
   * Undefined when it can, or when the mirror node can't be asked (the payment's own checks still apply).
   */
  async shortfall(brand: string, price: number): Promise<string | undefined> {
    const account = await this.d.hedera.ensureAccount(brand);
    let units = await this.d.hedera.usdcUnits(account).catch(() => undefined);
    if (units === undefined) return undefined;
    // A brand-new account (the public demo's): associated with USDC on Hedera in ensureAccount, but the mirror node
    // shows it a few seconds later. With a top-up on hand, count it as holding nothing yet rather than unassociated.
    if (units === null && this.d.topUp) units = 0n;
    const fund = "fund it (Circle's faucet, Hedera Testnet, or pnpm hedera:fund-brand), then ask again";
    if (units === null) return `your Hedera account ${account} isn't associated with USDC: run pnpm hedera:accounts, then ${fund}`;
    if (units < BigInt(price)) {
      const topped = this.d.topUp ? await this.d.topUp(brand, account, units, BigInt(price)) : undefined;
      if (topped === true) return undefined;
      if (typeof topped === "string") return `your Hedera account ${account} holds ${(Number(units) / 1e6).toFixed(2)} USDC and this ad costs ${usd(price)}: ${topped}`;
      return `your Hedera account ${account} holds ${(Number(units) / 1e6).toFixed(2)} USDC and this ad costs ${usd(price)}: ${fund}`;
    }
    return undefined;
  }

  /** Pays for an approved ad over x402 and returns its licence. */
  async pay(actionId: string, brand: string): Promise<Licence> {
    const { data, hedera } = this.d;
    const f = this.d.fetch ?? fetch;
    const a = data.action(actionId);
    if (!a || a.brand !== brand || !a.output) throw new PipelineError(404, "no such request");
    const block = (status: number, why: string): never => {
      data.log({ brand, actionId: a.id, licenceId: null, kind: "blocked", summary: `not paid: ${why}` });
      const e = new PipelineError(status, why);
      e.logged = true;
      throw e;
    };
    const url = `${this.d.baseUrl}${X402_PATH}${a.id}`;
    const first = await f(url, { headers: { accept: "application/json" } });
    if (first.status !== 402) {
      const body = (await first.json().catch(() => ({}))) as { error?: string };
      throw new PipelineError(first.status, body.error ?? `the ad's endpoint answered ${first.status}, not 402`);
    }
    const http0 = new x402HTTPClient(new x402Client());
    const required = http0.getPaymentRequiredResponse((h) => first.headers.get(h), await first.json().catch(() => undefined));
    const payTo = await hedera.ensureAccount(a.creator).catch(() => null);
    const now = data.action(a.id)!;
    const refused = this.refusal(now, required, payTo) ?? (now.status === "approved" ? await this.shortfall(brand, now.price) : undefined);
    if (refused) block(402, refused);
    const payer = await hedera.ensureAccount(brand);
    const client = new x402Client()
      .register(X402_NETWORK, new ExactHederaScheme(keystoreSigner(this.d.keystore, brand, payer)))
      .registerPolicy((_v, reqs) => this.matching(now, reqs, payTo!))
      .setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: X402_NETWORK, asset: hedera.config.usdc, maxAmountPerPayment: String(now.price) }] });
    const http = new x402HTTPClient(client);
    const payload = await http.createPaymentPayload(required);
    if (now.status === "approved") data.log({ brand, actionId: a.id, licenceId: null, kind: "signed", summary: `signed an x402 payment of ${usd(now.price)} in USDC from ${payer} to ${this.d.creatorName(now.creator)}'s Hedera account ${payTo} (testnet; the facilitator pays the fee)` });
    const paid = await f(url, { headers: { accept: "application/json", ...http.encodePaymentSignatureHeader(payload) } });
    if (!paid.ok) {
      let why = `the ad's endpoint answered ${paid.status}`;
      const body = (await paid.json().catch(() => ({}))) as { error?: string };
      if (body.error) why = body.error;
      const e = new PipelineError(paid.status, why);
      // The endpoint's pipeline has logged a refused or failed payment (402, 502) and a pending one (503).
      e.logged = [402, 502, 503].includes(paid.status);
      throw e;
    }
    const bytes = new Uint8Array(await paid.arrayBuffer());
    const settled = http.getPaymentSettleResponse((h) => paid.headers.get(h));
    if (sha256Hex(bytes) !== now.output!.hash.toLowerCase()) block(502, `the file received for ${settled.transaction} isn't the approved ad (its sha256 differs)`);
    const lic = data.licence(data.action(a.id)!.licenceId ?? "");
    if (!lic) throw new PipelineError(500, `paid (${settled.transaction}) but no licence is recorded`);
    return lic;
  }
}
