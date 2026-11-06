"use client";

/**
 * How an ad was paid for, in a line: a test payment (DevPayment, no money moved), USDT on Whitechain testnet through
 * FaceVisa's settlement contract, or USDC on Hedera testnet over x402: the transaction on the explorer, who paid whom,
 * and (on Verify) what the chain says.
 */
import type { PaymentView } from "@/lib/facevisa";

const HEDERA = "hedera-x402 (testnet)";
const WHITECHAIN = "whitechain";

export const onChain = (rail: string | null | undefined) => rail === WHITECHAIN || rail === HEDERA;

export function paymentLabel(p: Pick<PaymentView, "rail" | "ref"> | undefined) {
  if (!p) return "payment";
  if (p.rail === "dev" || (!p.rail && p.ref.startsWith("dev-"))) return "test payment (no money moved)";
  if (p.rail === WHITECHAIN) return "USDT on Whitechain testnet";
  if (p.rail === HEDERA) return "USDC on Hedera testnet, over x402";
  return p.rail ?? "payment";
}

const short = (id: string) => (/^0x[0-9a-fA-F]{40,}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

export function PaymentLine({ p }: { p: PaymentView | undefined }) {
  if (!p) return null;
  if (!onChain(p.rail)) return <>{paymentLabel(p)}</>;
  const wc = p.rail === WHITECHAIN;
  const source = wc ? "Whitechain" : "Hedera's mirror node";
  const acct = (id: string | null | undefined, url: string | null | undefined) =>
    id && url ? (
      <a href={url} target="_blank" rel="noreferrer" className="font-mono underline" title={id}>
        {short(id)}
      </a>
    ) : (
      <span className="font-mono">{id ? short(id) : "unknown"}</span>
    );
  return (
    <>
      {paymentLabel(p)}:{" "}
      <a href={p.explorer ?? p.hashscan} target="_blank" rel="noreferrer" className="font-mono underline" title={p.ref}>
        {short(p.ref)}
      </a>{" "}
      (from {acct(p.payer, p.payerUrl)} to {acct(p.payee, p.payeeUrl)})
      {p.check && (
        <>
          {" · "}
          {p.check.state === "confirmed" ? (
            <b>{wc ? "LicensePaid confirmed on Whitechain" : "confirmed by Hedera's mirror node"}</b>
          ) : p.check.state === "mismatch" ? (
            <b className="text-[#B4332E]">
              {source} doesn&apos;t match ({p.check.checks.filter((c) => !c.ok).map((c) => c.text).join("; ")})
            </b>
          ) : p.check.state === "not-found" ? (
            `not on ${source} yet (it usually shows within seconds; this refreshes)`
          ) : (
            `${source} couldn't be reached (${p.check.error ?? "error"}); see ${wc ? "the explorer" : "HashScan"}`
          )}
        </>
      )}
    </>
  );
}
