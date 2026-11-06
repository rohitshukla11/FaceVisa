"use client";

/**
 * Local development only: each integration's state (GET /api/health), with warnings on what would stop a demo. The
 * backend answers 404 outside local development.
 */
import { useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard, StatusPill } from "@/components/ds";
import { getJson } from "@/lib/likeness";

type Level = "ok" | "warn" | "error" | "off";
type Check = { level: Level; summary: string; detail?: Record<string, unknown> };
type Health = { at: string; mode: string; ok: boolean; warnings: string[]; checks: Record<string, Check> };

const PILL: Record<Level, "licensed" | "waiting" | "revoked" | "neutral"> = { ok: "licensed", warn: "waiting", error: "revoked", off: "neutral" };
const LABEL: Record<string, string> = { identity: "Identity", arkiv: "Arkiv", hedera: "Hedera x402", zerog: "0G", vertex: "Vertex AI", caps: "AI caps today" };

export default function HealthPage() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setH(await getJson<Health>("/api/health"));
    } catch (e) {
      setError((e as Error).message === "not found" ? "The health page is for local development only." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <AppPage
      title="Health"
      description={h ? `${h.ok ? "Ready" : "Not ready"} · ${h.mode} · checked ${new Date(h.at).toLocaleTimeString()}` : "Checking each integration…"}
      actions={
        <button type="button" className={btnClass("outline")} disabled={busy} onClick={() => void load()}>
          {busy ? "Checking…" : "Check again"}
        </button>
      }
    >
      {error && <ErrorCard>{error}</ErrorCard>}
      {h?.warnings.length ? (
        <div role="status" className="rounded-[20px] bg-wait-bg p-[18px] text-[14px] text-wait">
          <b>{h.warnings.length === 1 ? "1 warning" : `${h.warnings.length} warnings`}</b>
          <ul className="m-0 mt-1 pl-5">
            {h.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {h &&
        Object.entries(h.checks).map(([k, c]) => (
          <Card key={k} title={<span className="flex flex-wrap items-center gap-2">{LABEL[k] ?? k} <StatusPill kind={PILL[c.level]}>{c.level}</StatusPill></span>}>
            <p className="m-0 text-[14px]">{c.summary}</p>
            {c.detail && (
              <details>
                <summary className="cursor-pointer text-[13px] text-grey">Details</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[10px] bg-paper p-2 text-[12px]">{JSON.stringify(c.detail, null, 2)}</pre>
              </details>
            )}
          </Card>
        ))}
    </AppPage>
  );
}
