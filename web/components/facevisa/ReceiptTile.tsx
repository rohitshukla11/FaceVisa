"use client";

/**
 * An ad's file, loaded with the session cookie (nothing has a public URL): the creator's review copy before release,
 * or the released file for the brand and creator. A Verify link when it's released.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { SwarmView } from "@/lib/facevisa";

const ENCRYPTED_NOTE = "Swarm keeps this ad encrypted: only the brand and the creator open it, here in FaceVisa. The link serves the encrypted bytes.";

/** The ad's file on Swarm: a link to it on the public gateway (marked when encrypted), or "Uploading to Swarm…". */
export function SwarmLink({ s, className = "underline" }: { s?: SwarmView | null; className?: string }) {
  if (!s || s.state === "failed") return null;
  if (s.state !== "uploaded") return <span className="text-grey">Uploading to Swarm…</span>;
  return (
    <a href={s.url} target="_blank" rel="noreferrer" className={className} title={s.encrypted ? ENCRYPTED_NOTE : `The same file, on Swarm (reference ${s.ref})`}>
      {s.encrypted ? "On Swarm, encrypted ↗" : "On Swarm ↗"}
    </a>
  );
}

export function MediaTile({ file, mime, caption, verifyHash, swarm, large = false }: { file: string; mime: string; caption?: string; verifyHash?: string; swarm?: SwarmView | null; large?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  // Why there's no file (e.g. the public demo deleted it after 48 hours), instead of a placeholder forever.
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    let url: string | undefined;
    void (async () => {
      const res = await fetch(file, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setSrc((url = URL.createObjectURL(await res.blob())));
      else setMissing(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "The file couldn't be loaded.");
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  const box = large ? "max-h-[520px] w-full object-contain" : "aspect-square w-full object-cover";
  return (
    <figure className="m-0 flex flex-col gap-1">
      {src ? (
        mime.startsWith("video/") ? (
          <video src={src} controls muted playsInline className={`rounded-[12px] bg-ink ${box}`} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="The ad" className={`rounded-[12px] bg-paper ${box}`} />
        )
      ) : missing ? (
        <span className={`flex items-center justify-center rounded-[12px] bg-paper p-4 text-center text-[13px] text-grey ${large ? "h-64" : "aspect-square"} w-full`}>{missing}</span>
      ) : (
        <span className={`block animate-pulse rounded-[12px] bg-paper ${large ? "h-64" : "aspect-square"} w-full`} />
      )}
      {(caption || verifyHash || (swarm && swarm.state !== "failed")) && (
        <figcaption className="text-[12px] text-grey">
          {caption}
          {verifyHash && (
            <>
              {caption ? " · " : ""}
              <Link href={`/verify?hash=${verifyHash}`}>Verify</Link>
            </>
          )}
          {swarm && swarm.state !== "failed" && (
            <>
              {caption || verifyHash ? " · " : ""}
              <SwarmLink s={swarm} />
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}
