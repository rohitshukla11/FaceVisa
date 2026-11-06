"use client";

/**
 * Verify's answer for a render made through FaceVisa's own flow: Licensed / Revoked / Expired, the creator's
 * consent ("Approved by the creator in FaceVisa, <time>"), what made the file (provider, model,
 * request id), the face check and the payment.
 */
import { IconCheck, IconCross, IconQuestion } from "@/components/ds/icons";
import { when, type FaceVisaVerify } from "@/lib/facevisa";
import { ArkivLine } from "./ArkivLine";
import { PaymentLine, onChain, paymentLabel } from "./PaymentLine";
import { SourceLabel } from "./SourceLabel";

const LOOK = {
  Licensed: { bg: "bg-lime", stroke: "#DCF37B", stamp: "Licensed", icon: IconCheck, line: "Made under a licence still in force, approved by the creator for this exact request." },
  Revoked: { bg: "bg-coral", stroke: "#F7A4A1", stamp: "Licensed when made, since revoked", icon: IconCross, line: "The creator approved it, then revoked the licence: don't use it in new placements." },
  Expired: { bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Expired", icon: IconQuestion, line: "Licensed when it was made. The licence period has ended." },
  Unknown: { bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Unknown", icon: IconQuestion, line: "No receipt for these exact bytes." },
} as const;

export function FaceVisaVerdict({ v }: { v: FaceVisaVerify }) {
  const look = LOOK[v.verdict];
  const Icon = look.icon;
  const consent = v.consent;
  return (
    <>
      <section aria-label="Result" aria-live="polite" className={`flex items-center gap-4 rounded-[20px] px-5 py-[18px] ${look.bg}`}>
        <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-ink">
          <Icon size={24} stroke={look.stroke} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[26px] font-bold leading-tight">{look.stamp}</span>
          <span className="text-[14px]">{look.line}</span>
        </div>
      </section>

      <SourceLabel s={v.source} />
      {v.arkiv?.revocation && (
        <p className="m-0 text-[15px] font-semibold">
          Revoked on {when(v.arkiv.revocation.revokedAt)} by the creator:{" "}
          <a className="underline" href={v.arkiv.revocation.url} target="_blank" rel="noreferrer">
            their revocation record
          </a>
          , owned by their key, stays on Arkiv after the licence ends.
        </p>
      )}
      {v.arkiv?.licenceEndedAt !== undefined && <p className="m-0 text-[15px] font-semibold">Licence expired on {when(v.arkiv.licenceEndedAt)}: its entity has expired on Arkiv, and the receipt records the end.</p>}
      {v.namespace && (
        <p className="m-0 text-[13px] text-grey">
          Check it without us:{" "}
          <a className="underline" href={`/verifier/index.html?ns=${encodeURIComponent(v.namespace)}${v.fileHash ? `&hash=${v.fileHash}` : ""}`} target="_blank" rel="noreferrer">
            the direct verifier
          </a>{" "}
          asks Arkiv from your browser, with no FaceVisa server involved.
        </p>
      )}

      {consent && (
        <section aria-label="Consent" className="rounded-[18px] bg-ink px-[18px] py-4 text-[15px] text-white">
          <p className="m-0 font-semibold">
            Approved by the creator in FaceVisa{consent.approvedAt ? `, ${when(consent.approvedAt)}` : ""}, for {consent.boundTo === "this file" ? "this exact file" : "a different file"}.
          </p>
          {consent.method !== "world-id" && (
            <p className="m-0 mt-1 text-[13px] text-[#B9BCC4]">{consent.method === "demo" ? "Signed in with a demo identity (the public demo: a test identity)." : consent.method === "google" ? "Signed in with Google." : "Signed in with the local dev sign-in (local development: a test identity)."}</p>
          )}
          <p className="m-0 mt-1 text-[13px] text-[#B9BCC4]">
            The creator saw this finished ad and approved it, bound to its sha256, the brand, usage, duration and price: the brand&apos;s agent asked, and only the creator could say yes.
            {v.spend?.approvedAt ? ` Spend approved by the brand, ${when(v.spend.approvedAt)}.` : ""} Request {consent.requestId}.
          </p>
        </section>
      )}

      {v.licence && (
        <section aria-label="Licence" className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
          <Box label="Creator" value={v.licence.creator} />
          <Box label="Licensed to" value={v.licence.brand} />
          <Box label={`Licence ${v.licence.status}`} value={`${v.licence.category}, ${v.licence.durationDays} days`} note={`until ${when(v.licence.expiresAt)} · ${v.licence.price}`} />
        </section>
      )}
      {v.arkiv && (v.arkiv.receipt || v.arkiv.licence) && (
        <section aria-label="On Arkiv" className="flex flex-col gap-1 rounded-[18px] bg-white px-[18px] py-4 text-[14px]">
          <p className="m-0 font-semibold">On Arkiv: anyone can check this without asking FaceVisa</p>
          {v.arkiv.receipt && (
            <p className="m-0 break-all text-[13px]">
              Receipt{" "}
              <a href={v.arkiv.receipt.url} target="_blank" rel="noreferrer" className="font-mono underline">
                {v.arkiv.receipt.key}
              </a>{" "}
              {v.arkiv.receipt.ownerOk ? "· owned by the FaceVisa receipt key ✓" : "· NOT owned by the FaceVisa receipt key"}
            </p>
          )}
          {v.arkiv.licence && (
            <p className="m-0 break-all text-[13px]">
              Licence{" "}
              <a href={v.arkiv.licence.url} target="_blank" rel="noreferrer" className="font-mono underline">
                {v.arkiv.licence.key}
              </a>{" "}
              {v.arkiv.licence.ownerOk ? `· owned by the creator's key${v.arkiv.creatorName ? ` (${v.arkiv.creatorName}, from their listing on Arkiv)` : ""} ✓` : "· NOT owned by the creator's key"} · {v.arkiv.licence.status} · ends {when(v.arkiv.licence.expiresAt)} ·{" "}
              {v.arkiv.licence.identity === "demo" ? "approved by the creator in FaceVisa (a demo identity)" : v.arkiv.licence.identity === "google" ? "approved by the creator in FaceVisa (signed in with Google)" : v.arkiv.licence.identity === "world-id" ? "approved by the creator in FaceVisa" : "approved by the creator in FaceVisa (local dev sign-in, a test identity)"}
            </p>
          )}
          {v.arkiv.problems.map((p) => (
            <p key={p} className="m-0 text-[13px] text-[#B4332E]">
              {p}
            </p>
          ))}
          {v.arkiv.note && <p className="m-0 text-[13px] text-grey">{v.arkiv.note}</p>}
        </section>
      )}
      {v.sync && (v.sync.licence.state === "pending" || v.sync.licence.state === "failed" || v.sync.receipt.state === "pending" || v.sync.receipt.state === "failed") && (
        <div className="flex flex-col gap-0.5">
          <ArkivLine label="Licence" s={v.sync.licence} />
          <ArkivLine label="Receipt" s={v.sync.receipt} />
        </div>
      )}

      {v.render && v.provenance && (
        <section aria-label="What was generated" className="rounded-[18px] bg-white px-[18px] py-4 text-[14px]">
          <p className="m-0 font-semibold">
            {v.provenance.provider === "test" ? "A TEST RENDER (no AI model)" : `${v.render.kind === "video" ? "A video" : "An image"} by ${v.provenance.model} (${v.provenance.provider})`}
            {v.provenance.provider.split("+").includes("0g")
              ? // 0G: "verified" only on the Router's tee_verified: true; otherwise the request is on 0G's record.
                v.provenance.verified === true
                ? `, TEE-verified on 0G (tee_verified), request ${v.provenance.requestId}`
                : `, 0G request record ${v.provenance.requestId ?? ""}${v.provenance.verified === false ? " (0G's TEE check did not verify)" : ""}`
              : `${v.provenance.requestId ? `, request ${v.provenance.requestId}` : ""}${v.provenance.verified === true ? ", verified by the provider" : ""}`}
          </p>
          <p className="m-0 mt-1 text-[13px] text-grey">
            Face check: {v.faceCheck?.result === "passed" ? `passed${v.faceCheck.score != null ? ` (${v.faceCheck.score.toFixed(2)})` : ""}` : "not run (the face-match step isn't on yet)"} · Paid {v.payment?.amount}:{" "}
            {onChain(v.payment?.rail) ? <PaymentLine p={v.payment} /> : <>{paymentLabel(v.payment)} · {v.payment?.ref}</>}
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-[13px] text-grey">The exact prompt</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[10px] bg-paper p-2 font-sans text-[13px]">{v.render.prompt}</pre>
          </details>
          <p className="m-0 mt-1 break-all font-mono text-[12px] text-grey">prompt sha256 {v.render.promptSha256}</p>
        </section>
      )}
    </>
  );
}

function Box({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[18px] bg-white p-4">
      <span className="text-[13px] text-grey">{label}</span>
      <span className="truncate text-[16px] font-semibold">{value}</span>
      {note && <span className="text-[12px] text-grey">{note}</span>}
    </div>
  );
}
