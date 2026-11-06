"use client";

/**
 * One line on where a record stands on Arkiv: its entity (with the explorer link) once mirrored, or "sync pending" /
 * "sync failed". Nothing when Arkiv is off, or when the record isn't meant to be on Arkiv.
 */
import type { ArkivSync } from "@/lib/likeness";

export function ArkivLine({ label, s }: { label: string; s: ArkivSync | undefined }) {
  if (!s || s.state === "off" || s.state === "none") return null;
  const short = (k: string) => `${k.slice(0, 10)}…${k.slice(-6)}`;
  return (
    <p className="m-0 text-[12px] text-grey">
      {s.state === "synced" ? (
        <>
          {label} on Arkiv:{" "}
          <a href={s.url} target="_blank" rel="noreferrer" className="font-mono underline">
            {short(s.entityKey)}
          </a>
        </>
      ) : s.state === "pending" ? (
        <>
          {label}: Arkiv sync pending{s.note ? ` (${s.note})` : ""}, usually under a minute; retried on its own until it lands
        </>
      ) : (
        <span className="text-[#B4332E]">
          {label}: Arkiv sync failed ({s.error})
        </span>
      )}
    </p>
  );
}
