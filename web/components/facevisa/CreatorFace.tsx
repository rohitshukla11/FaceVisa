"use client";

/**
 * A listed creator's face: the first frame of their live capture, served to signed-in accounts only (never on Arkiv).
 * Without one (signed out, not listed, no capture), their initial.
 */
import { useState } from "react";

export function CreatorFace({ face, name, size = 64, rounded = "rounded-[18px]", className = "" }: { face?: string | null; name: string; size?: number | "fill"; rounded?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = size === "fill" ? { width: "100%", height: "100%" } : { width: size, height: size };
  if (!face || failed) {
    const fontSize = size === "fill" ? 56 : Math.max(16, Math.round(size * 0.38));
    return (
      <span aria-hidden="true" className={`flex shrink-0 items-center justify-center bg-ink font-display font-extrabold text-lime ${rounded} ${className}`} style={{ ...box, fontSize }}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={face} alt={`${name}'s face (their live capture)`} loading="lazy" onError={() => setFailed(true)} className={`shrink-0 bg-paper object-cover ${rounded} ${className}`} style={box} />
  );
}
