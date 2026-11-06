"use client";

/**
 * Verify: anyone drops a file (hashed in the browser, never uploaded) or pastes its sha256, and sees Licensed, Revoked,
 * Expired or Unknown, with the creator's approval of that exact file (in FaceVisa), what made it and the payment.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, ErrorCard } from "@/components/ds";
import { IconQuestion, IconUpload } from "@/components/ds/icons";
import { inputClass } from "@/components/ui";
import { sha256Hex } from "@/lib/api";
import { FaceVisaVerdict } from "@/components/facevisa/FaceVisaVerdict";
import { getJson, type FaceVisaVerify } from "@/lib/facevisa";

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const params = useSearchParams();
  const [hash, setHash] = useState(params.get("hash") ?? "");
  const [checked, setChecked] = useState<string | null>(null);
  const [result, setResult] = useState<FaceVisaVerify | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ url: string; size: number; type: string } | null>(null);

  const byHash = useCallback(async (h: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setChecked(h.trim());
      setResult(await getJson<FaceVisaVerify>(`/api/facevisa/verify?hash=${h.trim()}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const h = params.get("hash");
    if (h) void byHash(h);
  }, [params, byHash]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setFile({ url: URL.createObjectURL(f), size: f.size, type: f.type || "file" });
    const h = await sha256Hex(f);
    setHash(h);
    await byHash(h);
  }

  return (
    <AppPage title="Verify a file" description="Did the person in this ad approve it? Anyone can check; no account needed.">
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
            className="flex min-h-16 cursor-pointer items-center gap-3 rounded-[16px] border-2 border-dashed border-[#B9BEC6] bg-white px-3.5 text-[14px] font-semibold focus-within:outline focus-within:outline-[3px] focus-within:outline-violet"
          >
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-lime text-ink">
              <IconUpload size={20} />
            </span>
            <span className="flex-1">{busy ? "Checking…" : "Drop a file or choose one"}</span>
            <input id="file" type="file" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) void byHash(hash);
            }}
            className="flex flex-wrap items-center gap-2 text-[14px]"
          >
            <label htmlFor="hash" className="text-grey">
              or check a sha256
            </label>
            <input id="hash" className={`${inputClass} min-w-0 flex-[1_1_220px] font-mono text-[13px]`} placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} />
            <button type="submit" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())} className={btnClass("ink")}>
              Look up
            </button>
          </form>
          <figure className="m-0 flex flex-col gap-2 rounded-[20px] bg-white p-3">
            {file?.type.startsWith("video/") ? (
              <video src={file.url} controls muted playsInline className="max-h-[560px] w-full rounded-[14px] bg-ink" />
            ) : file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.url} alt="The checked file" className="max-h-[560px] w-full rounded-[14px] bg-paper object-contain" />
            ) : (
              <div className="flex min-h-28 items-center justify-center rounded-[14px] bg-paper p-4 text-center text-[14px] text-grey">
                {result ? "Checked by hash only, no file" : "The file you check appears here. It is hashed in your browser; nothing is uploaded."}
              </div>
            )}
            {checked && <figcaption className="tnum break-all font-mono text-[12px] text-grey">sha256 {checked}</figcaption>}
          </figure>
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          {error && <ErrorCard>{error}</ErrorCard>}
          {result && result.verdict !== "Unknown" ? (
            <FaceVisaVerdict v={result} />
          ) : (
            <section aria-label="Result" aria-live="polite" className="flex items-center gap-4 rounded-[20px] bg-white px-5 py-[18px]">
              <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-ink">
                <IconQuestion size={24} stroke="#DCF37B" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[26px] font-bold leading-tight">{result ? "Unknown" : busy ? "Checking…" : "Ready when you are"}</span>
                <span className="text-[14px] text-grey">{result ? result.reason : busy ? "Reading the receipt and licence on Arkiv, and the payment on chain: usually a few seconds, sometimes up to 20." : "Every released ad has a receipt keyed by the file's sha256. Edited or re-encoded copies come back Unknown."}</span>
              </div>
            </section>
          )}
        </div>
      </div>
    </AppPage>
  );
}
