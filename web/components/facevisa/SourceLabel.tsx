"use client";

/**
 * Where a screen's data came from, said plainly: read from Arkiv (with the namespace), or from FaceVisa's own backend
 * and not yet confirmed on Arkiv (with why). Also the per-item version for one listing or request.
 */
import type { DataSource } from "@/lib/facevisa";

export function SourceLabel({ s }: { s: DataSource | undefined }) {
  if (!s) return null;
  if (s.from === "arkiv")
    return (
      <p className="m-0 text-[12px] text-grey">
        <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-ok align-middle" />
        Read from Arkiv ({s.namespace}){s.fallback ? `; ${s.fallback} from FaceVisa, not yet confirmed on Arkiv` : ""}
        {s.note ? `. ${s.note}` : ""}
      </p>
    );
  return (
    <p className="m-0 text-[12px] text-wait">
      <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-wait align-middle" />
      From FaceVisa, not yet confirmed on Arkiv: {s.why}
    </p>
  );
}

/** One item's origin: its entity on Arkiv (linked), or "from FaceVisa, not yet confirmed on Arkiv". */
export function ItemSource({ source, url, why }: { source?: "arkiv" | "facevisa"; url?: string; why?: string }) {
  if (!source) return null;
  return source === "arkiv" ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-[12px] text-grey underline">
      on Arkiv
    </a>
  ) : (
    <span className="text-[12px] text-wait">from FaceVisa, not yet confirmed on Arkiv{why ? ` (${why})` : ""}</span>
  );
}
