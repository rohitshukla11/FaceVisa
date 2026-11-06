/**
 * Pay to release (B4): an approved ad is delivered only through an x402-protected endpoint, paid in USDC on Hedera
 * testnet, 100% to the creator.
 *
 *   GET /api/x402/ads/:requestId
 *   - Unpaid, no PAYMENT-SIGNATURE: 402 with PAYMENT-REQUIRED: scheme exact, hedera:testnet, USDC 0.0.429274,
 *     amount = the approved price (micro-USD = USDC's 6 decimals), payTo = the creator's Hedera account, the
 *     facilitator's feePayer in `extra`.
 *   - With PAYMENT-SIGNATURE, through the pipeline's release gate (the creator's approval of this exact ad, the brand's
 *     spend approval when needed, the daily budget):
 *     1. the facilitator verifies it;
 *     2. the payer must be the brand's own account;
 *     3. the facilitator settles it;
 *     4. then the licence and receipt are written and the file is served with PAYMENT-RESPONSE.
 *     Nothing is served before settlement succeeds.
 *   - Already paid: a payment signed by the brand's key (checked here, never submitted) gets the file again, with the
 *     original settlement. A paid ad is never charged twice.
 *   - A settlement whose outcome is unknown (a facilitator timeout) keeps the request in "paying". The transaction ID
 *     is known from the signed bytes, so the mirror node decides: SUCCESS releases, any other result or its validity
 *     window passing unseen voids it. The same check runs at startup for payments a restart left open.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { hederaAccountIdsEqual, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { Keystore } from "../app/keystore.js";
import type { RenderStore } from "../app/store.js";
import type { FaceVisaData, Payment, PendingAction } from "../facevisa/data.js";
import { PaymentPending, PipelineError, type PaymentRail, type Pipeline } from "../facevisa/pipeline.js";
import { usd } from "../facevisa/rules.js";
import { validStartMs, type Hedera } from "./hedera.js";

export const X402_RAIL = "hedera-x402 (testnet)";
export const X402_NETWORK = "hedera:testnet";
export const X402_PATH = "/api/x402/ads/";
/** Settlement failures the facilitator reports before submitting anything (its verify step). */
const PRE_SUBMIT = /^(invalid_|unsupported_scheme$|network_mismatch$|accepted_payment_requirements_mismatch$|verification_failed$)/;
/** How long a signed payment may wait (the SDK's default transaction validity is 120 s). */
const MAX_TIMEOUT_S = 120;
/** Hedera's longest transaction validity (180 s), plus time for the mirror node to catch up. */
const VALIDITY_MS = 180_000 + 60_000;

export interface X402Deps {
  data: FaceVisaData;
  pipeline: Pipeline;
  store: RenderStore;
  hedera: Hedera;
  keystore: Keystore;
  facilitator: FacilitatorClient;
  publicUrl: string;
  /** How often a pending payment is looked up on the mirror node (tests make it fast). */
  pollMs?: number;
}

/** The brand's own signed transfer, as found in a payment: its transaction ID and who it moves USDC from. */
export function inspectPayment(payload: PaymentPayload, usdc: string) {
  const b64 = String((payload.payload as { transaction?: unknown }).transaction ?? "");
  const t = inspectHederaTransaction(b64);
  const transfers = t.tokenTransfers[usdc] ?? [];
  const debited = transfers.filter((x) => BigInt(x.amount) < 0n).map((x) => x.accountId);
  return { b64, transactionId: t.transactionId, payer: debited.length === 1 ? debited[0]! : null, transfers };
}

export class X402Ads {
  private readonly server: x402ResourceServer;
  private ready: Promise<void> | undefined;
  /** Payments being looked up on the mirror node: one lookup per payment, its outcome shared. */
  private readonly watching = new Map<string, Promise<"released" | "voided">>();

  constructor(readonly d: X402Deps) {
    const usdc = d.hedera.config.usdc;
    this.server = new x402ResourceServer(d.facilitator).register(X402_NETWORK, new ExactHederaScheme({ defaultAssets: { [X402_NETWORK]: { asset: usdc, decimals: 6 } } }));
  }

  /** The facilitator's supported kinds (its feePayer), fetched once; a failure is retried on the next request. */
  private init() {
    this.ready ??= this.server.initialize().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  /** What paying for this ad means: the approved price in USDC, to the creator's Hedera account. */
  async requirements(a: PendingAction): Promise<PaymentRequirements> {
    await this.init();
    const payTo = await this.d.hedera.ensureAccount(a.creator);
    const [r] = await this.server.buildPaymentRequirements({ scheme: "exact", network: X402_NETWORK, payTo, price: { asset: this.d.hedera.config.usdc, amount: String(a.price) }, maxTimeoutSeconds: MAX_TIMEOUT_S });
    if (!r) throw new Error("the facilitator doesn't support hedera:testnet");
    return r;
  }

  async handle(req: IncomingMessage, res: ServerResponse, actionId: string): Promise<void> {
    const { data } = this.d;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const a = data.action(actionId);
    if (!a || !a.output) return json(404, { error: "no such ad" });
    const header = req.headers["payment-signature"];
    let payload: PaymentPayload | undefined;
    if (typeof header === "string" && header) {
      try {
        payload = decodePaymentSignatureHeader(header);
      } catch {
        return json(400, { error: "PAYMENT-SIGNATURE isn't a payment" });
      }
    }
    if (a.status === "paying") return json(409, { error: "this ad is being paid for; ask again shortly" }, { "retry-after": "5" });
    const resource = { url: `${this.d.publicUrl}${X402_PATH}${a.id}`, description: `one licensed ${a.kind} (${a.category}, ${a.durationDays} days), approved by its creator`, mimeType: a.output.mime };
    const paymentRequired = async (requirements: PaymentRequirements, error?: string) => {
      const body = await this.server.createPaymentRequiredResponse([requirements], resource, error);
      return json(402, body, { "payment-required": encodePaymentRequiredHeader(body) });
    };

    if (a.status === "released") {
      const paid = data.payments({ actionId: a.id }).find((p) => p.status === "settled");
      const requirements = await this.requirements(a);
      if (!paid || paid.rail !== X402_RAIL) return json(409, { error: "this ad was released without an x402 payment; fetch it from its receipt" });
      if (!payload) return paymentRequired(requirements, `already paid (${paid.ref}): a payment signed by the brand's account gets the file again, and is never submitted`);
      const who = await this.brandSigned(a, payload);
      if (!who.ok) return paymentRequired(requirements, who.reason);
      return this.serve(res, a, { success: true, transaction: paid.ref!, network: X402_NETWORK, payer: paid.payer ?? undefined });
    }

    try {
      this.d.pipeline.gate(a.id, a.brand);
    } catch (e) {
      if (e instanceof PipelineError) return json(e.status, { error: e.message });
      throw e;
    }
    const requirements = await this.requirements(a);
    if (!payload) return paymentRequired(requirements);
    const accepted = this.server.findMatchingRequirements([requirements], payload);
    if (!accepted) return paymentRequired(requirements, "the payment doesn't match what this ad costs (amount, asset, network or recipient)");
    const brandAccount = await this.d.hedera.ensureAccount(a.brand);
    const rail = new X402Settlement({ server: this.server, data, payload, requirements: accepted, brandAccount, usdc: this.d.hedera.config.usdc });
    try {
      await this.d.pipeline.release(a.id, a.brand, rail);
    } catch (e) {
      if (e instanceof PaymentPending) {
        void this.reconcile(e.payment).catch((err) => console.error(`[x402] reconcile ${e.payment.id}: ${(err as Error).message.split("\n")[0]}`));
        return json(503, { error: `${e.message}; ask again shortly` }, { "retry-after": "10" });
      }
      if (e instanceof PipelineError) return e.status === 402 ? paymentRequired(requirements, e.message) : json(e.status, { error: e.message });
      throw e;
    }
    return this.serve(res, a, rail.settled!);
  }

  private serve(res: ServerResponse, a: PendingAction, settled: SettleResponse): void {
    const f = this.d.store.read(a.output!.hash as `0x${string}`);
    if (!f) {
      res.writeHead(410, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "paid, but the file is gone" }));
      return;
    }
    const lic = this.d.data.action(a.id)?.licenceId ?? "";
    res.writeHead(200, { "content-type": f.mime, "content-length": f.bytes.length, "cache-control": "private, no-store", "payment-response": encodePaymentResponseHeader(settled), "x-facevisa-licence": lic, "x-facevisa-file-hash": a.output!.hash });
    res.end(f.bytes);
  }

  /** For a paid ad: the payment is the brand's own transfer for this ad, signed with the brand's key. */
  private async brandSigned(a: PendingAction, payload: PaymentPayload): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const brandAccount = await this.d.hedera.ensureAccount(a.brand);
      const p = inspectPayment(payload, this.d.hedera.config.usdc);
      if (!p.payer || !hederaAccountIdsEqual(p.payer, brandAccount)) return { ok: false, reason: "only the brand that paid gets the file again" };
      const tx = Transaction.fromBytes(Buffer.from(p.b64, "base64"));
      const signed = this.d.keystore.withPrivateKey(`account:${a.brand}`, (hex) => PrivateKey.fromStringECDSA(hex.slice(2)).publicKey.verifyTransaction(tx));
      return signed ? { ok: true } : { ok: false, reason: "the payment isn't signed by the brand's key" };
    } catch {
      return { ok: false, reason: "the payment couldn't be read" };
    }
  }

  /**
   * A payment sent with an unknown outcome: the mirror node decides. SUCCESS releases the ad; another result, or
   * the transaction's validity window passing without it, voids the payment (nothing was charged).
   */
  reconcile(payment: Payment): Promise<"released" | "voided"> {
    let w = this.watching.get(payment.id);
    if (!w) {
      w = this.watch(payment).finally(() => this.watching.delete(payment.id));
      this.watching.set(payment.id, w);
    }
    return w;
  }

  private async watch(payment: Payment): Promise<"released" | "voided"> {
    const id = payment.ref;
    if (!id) {
      this.d.pipeline.abandon(payment.actionId, payment, "no transaction was recorded for it");
      return "voided";
    }
    const deadline = validStartMs(id) + VALIDITY_MS;
    for (;;) {
      const t = await this.d.hedera.transaction(id).catch(() => undefined);
      if (t?.result === "SUCCESS") {
        this.d.data.settlePayment(payment.id, id);
        const a = this.d.data.action(payment.actionId);
        if (a?.status === "paying") this.d.pipeline.finish(a.id, { ...payment, status: "settled" }, id, X402_RAIL);
        return "released";
      }
      if (t) {
        this.d.pipeline.abandon(payment.actionId, payment, `Hedera says ${t.result}`);
        return "voided";
      }
      if (Date.now() > deadline) {
        this.d.pipeline.abandon(payment.actionId, payment, "its transaction never reached Hedera within its validity window");
        return "voided";
      }
      await new Promise((r) => setTimeout(r, this.d.pollMs ?? 5_000));
    }
  }

}

/** One x402 payment through the pipeline's release: verify (and the payer check), then settle. */
class X402Settlement implements PaymentRail {
  readonly name = X402_RAIL;
  settled: SettleResponse | undefined;

  constructor(private readonly x: { server: x402ResourceServer; data: FaceVisaData; payload: PaymentPayload; requirements: PaymentRequirements; brandAccount: string; usdc: string }) {}

  async authorize(p: { action: PendingAction; amount: number }): Promise<Payment> {
    const { server, payload, requirements, brandAccount } = this.x;
    const v = await server.verifyPayment(payload, requirements);
    if (!v.isValid) throw new PipelineError(402, `the payment didn't verify (${v.invalidReason ?? "invalid"}${v.invalidMessage ? `: ${v.invalidMessage}` : ""})`);
    const signed = inspectPayment(payload, this.x.usdc);
    const payer = v.payer || signed.payer || "";
    if (!hederaAccountIdsEqual(payer, brandAccount)) throw new PipelineError(402, `the payment is from ${payer || "an unknown account"}, not the brand's account ${brandAccount}`);
    // The transaction ID is fixed by the signed bytes: it is what the mirror node is asked if settlement goes quiet.
    return this.x.data.authorizePayment({ actionId: p.action.id, brand: p.action.brand, amount: p.amount, rail: this.name, ref: signed.transactionId, payer: brandAccount, payee: requirements.payTo });
  }

  async settle(p: Payment): Promise<string> {
    let r: SettleResponse;
    try {
      r = await this.x.server.settlePayment(this.x.payload, this.x.requirements);
    } catch (e) {
      throw new PaymentPending(p, `the facilitator didn't answer the settlement of ${usd(p.amount)} (${p.ref}; ${(e as Error).message.split("\n")[0]})`);
    }
    const why = `${r.errorReason ?? "unknown"}${r.errorMessage ? `: ${r.errorMessage}` : ""}`;
    // Refused before anything was submitted: nothing can have moved. Any other failure (e.g. transaction_failed) may
    // have reached Hedera, so the mirror node decides before the ad can be paid for again.
    if (!r.success && PRE_SUBMIT.test(r.errorReason ?? "")) throw new PipelineError(402, `settlement refused (${why})`);
    if (!r.success) throw new PaymentPending(p, `the settlement of ${usd(p.amount)} failed at the facilitator (${why}; ${p.ref})`);
    this.settled = r;
    this.x.data.settlePayment(p.id, r.transaction);
    return r.transaction;
  }

  async void(p: Payment) {
    this.x.data.voidPayment(p.id);
  }
}

export const sha256Hex = (b: Uint8Array) => `0x${createHash("sha256").update(b).digest("hex")}`;
