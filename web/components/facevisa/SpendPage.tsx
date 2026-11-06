"use client";

/**
 * A spend over the brand workspace's limit: the brand's agent is paused until the brand approves this exact amount in
 * FaceVisa ("spend approved by the brand"). Deny or let it expire, and nothing is spent or released.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard, NoticePage, StatusPill } from "@/components/ds";
import { SignInChoice, useAuth } from "@/components/site/Auth";
import { getJson, postJson, STATUS, when, type BrandRequest, type Meta } from "@/lib/facevisa";
import { SlowStep } from "./SlowStep";

type View = { request: BrandRequest };

export function SpendPage({ id }: { id: string }) {
  const { user } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The refresh's own trouble, kept apart from an action's error so a refresh never hides one.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    try {
      setView(await getJson<View>(`/api/approvals/spend?id=${encodeURIComponent(id)}`));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void getJson<Meta>("/api/facevisa").then(setMeta, () => undefined);
  }, []);
  useEffect(() => {
    if (user) void load();
  }, [user, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (user === undefined) return <AppPage title="Spend">{null}</AppPage>;
  if (!user)
    return (
      <NoticePage title="Sign in to approve this spend" action={<span className="flex flex-wrap gap-2"><SignInChoice className={btnClass("lime")} demoClassName={btnClass("outline")} /></span>}>
        Only the brand workspace can approve it.
      </NoticePage>
    );
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const r = view?.request;
  const open = r && (r.status === "spend_review" || r.status === "spend_verified") && r.expiresAt > now;
  // The approval names the amount this page shows: the server refuses it if the price changed meanwhile.
  const decide = (decision: "approve" | "deny") =>
    run(decision, async () => {
      await postJson("/api/approvals/spend/decide", { id, decision, amount: r?.price.replace(/^\$/, "") });
      setNotice({ ok: true, text: decision === "approve" ? "Spend approved by you in FaceVisa: the agent pays and releases the ad." : "Denied: nothing spent, nothing released." });
      await load();
    });

  return (
    <AppPage title="Approve a spend" description={meta?.spendLimit ? `Your agent pauses above ${meta.spendLimit} per request until you approve the spend here.` : undefined} actions={<Link href="/dashboard" className={btnClass("outline")}>Back to your agent</Link>}>
      {notice && <div role="status" className={`rounded-[20px] p-[18px] text-[14px] ${notice.ok ? "bg-ok-bg text-ok" : "bg-wait-bg text-wait"}`}>{notice.text}</div>}
      {error && <ErrorCard>{error}</ErrorCard>}
      {loadError && <ErrorCard>{loadError}</ErrorCard>}
      {!r && !loadError && <p className="m-0 text-[14px] text-grey">Loading the request…</p>}
      {r && (
        <Card tone={open ? "lime" : "white"} title={<span className="flex flex-wrap items-center gap-2">Spend {r.price} on an ad of {r.self ? "your own creator profile" : r.creator} <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill></span>}>
          <p className="m-0 text-[14px]">
            “{r.brief}” · {r.category} · {r.durationDays} days. {r.consent ? `The creator approved the finished ${r.kind} in FaceVisa, ${when(r.consent.approvedAt)}.` : ""} The ad is released only after you approve and the agent pays.
          </p>
          <SlowStep status={r.status} kind={r.kind} since={r.stepAt} ai={meta?.ai} rail={meta?.payments?.rail} />
          {open && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!!busy} onClick={() => void decide("approve")} className={btnClass("ink")}>
                  {busy === "approve" ? "Approving…" : `Approve spending ${r.price}`}
                </button>
                <button type="button" disabled={!!busy} onClick={() => void decide("deny")} className={btnClass("danger")}>
                  Deny
                </button>
              </div>
              <p className="m-0 text-[13px]">Your approval is bound to exactly {r.price}, once. Deny, or let it expire, and nothing is spent or released.</p>
            </div>
          )}
          {r.reason && !open && <p className="m-0 text-[13px] text-grey">{r.reason}</p>}
        </Card>
      )}
    </AppPage>
  );
}
