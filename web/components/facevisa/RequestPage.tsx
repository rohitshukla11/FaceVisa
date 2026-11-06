"use client";

/**
 * One request, as its creator sees it. "Agents negotiate. Only the human consents to their face being used." The
 * brand's agent has already made the ad; nothing is released. The signed-in creator sees the ad and its terms and
 * decides in FaceVisa: Approve this exact ad (bound to its file hash, the brand, usage, duration and price), Reject
 * (one new version) or Deny. The approval names the file the page showed: if the ad changed, it's refused.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard, NoticePage, StatusPill } from "@/components/ds";
import { SignInChoice, useAuth } from "@/components/site/Auth";
import { getJson, postJson, STATUS, when, type BrandRequest, type CreatorRequest, type Meta } from "@/lib/facevisa";
import { ArkivLine } from "./ArkivLine";
import { MediaTile } from "./ReceiptTile";
import { SlowStep } from "./SlowStep";

/** The creator's view; or, opened by the request's brand, the brand's side of it (never the creator's controls). */
type View = { request?: CreatorRequest; asBrand?: BrandRequest };

export function RequestPage({ id }: { id: string }) {
  const { user, me, signOut } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The 4 s refresh's own trouble, kept apart from an action's error so a refresh never hides one.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setView(await getJson<View>(`/api/approvals/request?id=${encodeURIComponent(id)}`));
      setLoadError(null);
    } catch (e) {
      // Another person signed in in this tab: drop what the previous one saw.
      if ((e as Error).message === "no such request") setView(null);
      setLoadError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void getJson<Meta>("/api/facevisa").then(setMeta, () => undefined);
  }, []);
  useEffect(() => {
    if (!user) return;
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [user, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (user === undefined) return <AppPage title="Request">{null}</AppPage>;
  if (!user)
    return (
      <NoticePage title="Sign in to see this request" action={<span className="flex flex-wrap gap-2"><SignInChoice className={btnClass("lime")} demoClassName={btnClass("outline")} /></span>}>
        Only the creator it was sent to can open it.
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
  // The decision names the file this page shows: the server refuses it if the ad changed meanwhile.
  const decide = (decision: "approve" | "reject" | "deny") =>
    run(decision, async () => {
      await postJson("/api/approvals/decide", { id, decision, outputHash: r?.output?.hash });
      setNotice(
        decision === "approve"
          ? { ok: true, text: "Approved by you in FaceVisa: this exact ad, for this brand, usage, duration and price. The brand's agent pays you, then it is released." }
          : decision === "reject"
            ? { ok: true, text: r?.generation === 1 ? "Rejected. The agent is making one new version for you to review." : "Rejected again: the request has ended. Nothing released, nothing charged." }
            : { ok: true, text: "Denied. Nothing released, nothing charged." },
      );
      await load();
    });

  const r = view?.request;
  const b = view?.asBrand;
  // Not this person's request (a request opens only for its creator and the brand that asked); usually a different
  // person signed in in this tab. Who it belongs to isn't shown.
  if (!view && loadError === "no such request")
    return (
      <NoticePage
        title="This request isn't yours"
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard" className={btnClass("lime")}>Your requests</Link>
            <button type="button" className={btnClass("outline")} onClick={() => void signOut()}>Sign out</button>
          </div>
        }
      >
        You&apos;re signed in as <b>{me?.account?.name ?? "someone else"}</b>. A request opens only for the creator it was sent to and the brand that asked for it. If you switched people in this tab, sign in as one of them; your own requests are on your dashboard.
      </NoticePage>
    );
  if (b)
    return (
      <AppPage title="Your request" description={`${b.creator} · ${b.kind} · ${STATUS[b.status].label}`} actions={<Link href="/dashboard" className={btnClass("outline")}>Brand workspace</Link>}>
        {error && <ErrorCard>{error}</ErrorCard>}
        {loadError && <ErrorCard>{loadError}</ErrorCard>}
        <Card title={<span className="flex flex-wrap items-center gap-2">You asked {b.creator} for one {b.kind} at {b.price} <StatusPill kind={STATUS[b.status].pill}>{STATUS[b.status].label}</StatusPill></span>}>
          <p className="m-0 text-[14px]">
            This page is where {b.creator} reviews the ad. You&apos;re signed in as the brand that asked, so you see your side of it: “{b.brief}” · {b.category}, {b.durationDays} days.
          </p>
          <SlowStep status={b.status} kind={b.kind} since={b.stepAt} ai={meta?.ai} rail={meta?.payments?.rail} />
          {b.lastStep && (
            <p className={`m-0 text-[14px] ${b.lastStep.kind === "blocked" ? "text-wait" : "text-grey"}`}>
              Latest step ({when(b.lastStep.at)}): {b.lastStep.summary}
            </p>
          )}
          {b.status === "approved" && (
            <button type="button" disabled={!!busy} className={btnClass("lime", "self-start")} onClick={() => void run("release", async () => { await postJson("/api/facevisa/agent/release", { id }); await load(); })}>
              {busy === "release" ? "Paying…" : `Pay ${b.price} and release`}
            </button>
          )}
          {b.status === "released" && <Link href="/dashboard" className={btnClass("lime", "self-start")}>See the released ad</Link>}
        </Card>
      </AppPage>
    );
  const open = r && (r.status === "review" || r.status === "verified") && r.expiresAt > now;

  return (
    <AppPage title="Review an ad of you" description={r ? `${r.self ? "Your own brand workspace" : r.brand} · ${r.kind} · ${open ? `review by ${when(r.expiresAt)}` : STATUS[r.status].label}` : undefined} actions={<Link href="/dashboard" className={btnClass("outline")}>All requests</Link>}>
      {notice && <div role="status" className={`rounded-[20px] p-[18px] text-[14px] ${notice.ok ? "bg-ok-bg text-ok" : "bg-wait-bg text-wait"}`}>{notice.text}</div>}
      {error && <ErrorCard>{error}</ErrorCard>}
      {loadError && <ErrorCard>{loadError}</ErrorCard>}
      {!r ? !loadError && <p className="m-0 text-[14px] text-grey">Loading the request…</p> : (
        <>
          <Card tone={open && r.output ? "lime" : "white"} title={<span className="flex flex-wrap items-center gap-2">{r.self ? "Your brand workspace" : `${r.brand}'s agent`} made an ad of you <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill></span>}>
            <ArkivLine label="This request" s={r.arkiv} />
            {r.status === "generating" && (
              <>
                <p className="m-0 text-[14px]">The agent is making {r.generation > 1 ? "a new version, after your rejection" : "the ad"}. It shows here for your review when it&apos;s ready.</p>
                <SlowStep status={r.status} kind={r.kind} since={r.stepAt} ai={meta?.ai} rail={meta?.payments?.rail} />
              </>
            )}
            {r.status === "paying" && <SlowStep status={r.status} kind={r.kind} since={r.stepAt} ai={meta?.ai} rail={meta?.payments?.rail} />}
            {r.request && r.output ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                {r.output.file && <MediaTile file={r.output.file} mime={r.output.mime} swarm={r.output.swarm} large caption={`${r.output.provider === "test" ? "TEST RENDER (no AI)" : r.output.model} · face check ${r.output.faceCheck === "passed" ? "passed" : "not run"}${r.generation > 1 ? " · second version" : ""}`} />}
                <dl className="m-0 grid h-fit grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
                  <dt className="text-grey">Brief</dt>
                  <dd className="m-0 font-semibold">“{r.request.brief}”</dd>
                  <dt className="text-grey">Usage</dt>
                  <dd className="m-0">{r.request.category}</dd>
                  <dt className="text-grey">Duration</dt>
                  <dd className="m-0">{r.request.durationDays} days</dd>
                  <dt className="text-grey">You are paid</dt>
                  <dd className="m-0">{r.request.price}</dd>
                  {r.decidedAt && (
                    <>
                      <dt className="text-grey">You decided</dt>
                      <dd className="m-0">in FaceVisa, {when(r.decidedAt)}</dd>
                    </>
                  )}
                </dl>
              </div>
            ) : null}

            {open && r.output && (
              <div className="flex flex-col gap-2">
                <>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={!!busy} onClick={() => void decide("approve")} className={btnClass("ink")}>
                        {busy === "approve" ? "Approving…" : "Approve this exact ad"}
                      </button>
                      <button type="button" disabled={!!busy} onClick={() => void decide("reject")} className={btnClass("outline")}>
                        {r.generation === 1 ? "Reject (one new version)" : "Reject (ends the request)"}
                      </button>
                      <button type="button" disabled={!!busy} onClick={() => void decide("deny")} className={btnClass("danger")}>
                        Deny
                      </button>
                    </div>
                    <p className="m-0 text-[13px]">
                      Only you can approve this. Approving binds your consent to this file (its sha256), this brand, usage, duration and price, once; any change needs your approval again. Nothing is released or paid until you approve.
                    </p>
                </>
              </div>
            )}
            {r.reason && !open && r.status !== "generating" && <p className="m-0 text-[13px] text-grey">{r.reason}</p>}
          </Card>
          {meta?.devTools && open && (
            <Card title="Local development">
              <p className="m-0 text-[13px] text-grey">The dev sign-in is on. To click through the expired path without waiting {meta.reviewTtlMinutes} minutes:</p>
              <button
                type="button"
                className={btnClass("outline", "self-start")}
                onClick={() =>
                  void run("expire", async () => {
                    await postJson("/api/dev/expire-request", { id });
                    await load();
                  })
                }
              >
                Expire this request now
              </button>
            </Card>
          )}
        </>
      )}
    </AppPage>
  );
}
