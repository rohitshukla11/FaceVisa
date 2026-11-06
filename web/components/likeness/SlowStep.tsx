"use client";

/**
 * A slow step in progress, in a line: what's happening, how long it has run, and how long it usually takes. Making an
 * ad (a test render is instant; a 0G or Gemini image takes seconds; a Veo video about a minute and a half) and paying
 * on Hedera (the facilitator settles the USDC transfer). Past three times the usual, it says what happens if it fails.
 */
import { useEffect, useState } from "react";
import type { ActionStatus, Kind } from "@/lib/likeness";

/** The usual time for a step, in seconds, and how to say it. `ai` is the server's provider name, image+video. */
function usual(status: ActionStatus, kind: Kind, ai: string, x402: boolean): { s: number; what: string } | null {
  if (status === "paying") return x402 ? { s: 15, what: "The brand's agent pays in USDC on Hedera testnet: the x402 facilitator settles the transfer, usually in 5 to 15 s" } : { s: 3, what: "Paying (a test payment: no money moves)" };
  if (status !== "generating") return null;
  const [image = "test", video = image] = ai.split("+");
  if (kind === "video") {
    if (video === "vertex") return { s: 90, what: "Making the video: its opening still, then an 8 s clip on Veo, which usually takes about a minute and a half" };
    if (video === "0g") return { s: 180, what: "Making the video on 0G (Seedance), which can take a few minutes" };
    return { s: 3, what: "Making a test render (no AI model): a second or two" };
  }
  if (image === "0g") return { s: 20, what: "Making the image on 0G (Seedream), usually about 15 s" };
  if (image === "vertex") return { s: 20, what: "Making the image on Vertex AI (Gemini), usually 10 to 20 s" };
  return { s: 3, what: "Making a test render (no AI model): a second or two" };
}

export function SlowStep({ status, kind, since, ai, x402 }: { status: ActionStatus; kind: Kind; since: number; ai: string | undefined; x402: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const step = usual(status, kind, ai ?? "test", x402);
  const ticking = !!step;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!step) return null;
  // No start time (an older server): what's happening, without a clock.
  const s = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : null;
  const late = s !== null && s > 3 * step.s + 10;
  return (
    <p role="status" className="m-0 flex flex-col gap-0.5 text-[13px]">
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        <span>
          {step.what}.
          {s !== null && (
            <>
              {" "}
              <b className="tabular-nums">
                {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
              </b>{" "}
              so far.
            </>
          )}
        </span>
      </span>
      {late && (
        <span className="text-wait">
          {status === "paying"
            ? "Taking longer than usual. Nothing is charged twice: the agent finishes on its own once Hedera confirms the transfer; if it didn't go through, the request goes back to approved with nothing charged."
            : "Taking longer than usual. If the model doesn't answer, the request fails with nothing released and nothing charged, and you can ask again."}
        </span>
      )}
    </p>
  );
}
