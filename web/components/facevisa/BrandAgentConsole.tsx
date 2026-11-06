"use client";

/**
 * The brand's workspace. The brand sets a brief, usage, duration, a budget and criteria; its agent shortlists creators
 * (with their faces and one line of why for each), sends requests and makes each ad, which stays unreleased until the
 * creator approves that exact ad in FaceVisa; then the agent pays and releases it on its own.
 * "Agents negotiate. Only the human consents to their face being used."
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { btnClass, ErrorCard, Page, StatusPill } from "@/components/ds";
import { Field, inputClass } from "@/components/ui";
import type { Me } from "@/lib/api";
import { getJson, postJson, STATUS, when, type AgentEvent, type BrandRequest, type DataSource, type Kind, type LicenceView, type Meta, type ShortlistEntry } from "@/lib/facevisa";
import { ItemSource, SourceLabel } from "./SourceLabel";
import { CreatorStatsRow } from "./CreatorStatsRow";
import { MediaTile } from "./ReceiptTile";
import { PaymentLine } from "./PaymentLine";
import { SlowStep } from "./SlowStep";
import { PresenceCard } from "./PresenceCard";
import { CreatorFace } from "./CreatorFace";
import { useAuth } from "@/components/site/Auth";
import { acceptedLabel, PresenceBadge } from "./PresenceBadge";

type Activity = { events: AgentEvent[]; requests: BrandRequest[]; licences: LicenceView[]; spentToday: string };

const EVENT_PILL: Record<string, "licensed" | "revoked" | "waiting" | "expired" | "neutral" | "lime"> = {
  requested: "neutral",
  generating: "neutral",
  generated: "neutral",
  waiting: "waiting",
  verified: "waiting",
  approved: "licensed",
  rejected: "waiting",
  "spend-check": "waiting",
  "spend-approved": "licensed",
  signed: "neutral",
  funded: "neutral",
  paying: "waiting",
  paid: "lime",
  released: "licensed",
  blocked: "revoked",
  denied: "revoked",
  expired: "expired",
  cancelled: "expired",
  failed: "revoked",
  shortlisted: "neutral",
};

/** The public demo's seeded creators: nobody can sign in as them. */
const SEEDED = "Seeded demo creator: requests to them won't be answered.";
const OPEN = ["generating", "review", "verified", "approved", "spend_review", "spend_verified", "paying"];
const WITH_CREATOR = ["review", "verified"];

// Surfaces and text (light only), as on the creator's dashboard.
const SURFACE = "rounded-[22px] bg-white text-ink ring-1 ring-black/[0.04]";
const MUTED = "text-grey";
const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold";

export function BrandAgentConsole({ me }: { me: Me }) {
  const { refreshMe } = useAuth();
  // With IDKit on, a brand acts only after its World ID check (one per account, shared with the creator profile).
  const brandNeedsCheck = !!me.presence?.required && !me.presence.verified;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [brief, setBrief] = useState("A runner at sunrise on a mountain trail, wearing our new trail shoes");
  const [category, setCategory] = useState("Fitness");
  const [kind, setKind] = useState<Kind>("image");
  const [durationDays, setDurationDays] = useState(30);
  const [maxPrice, setMaxPrice] = useState("0.20");
  const [budget, setBudget] = useState("0.50");
  const [shortlist, setShortlist] = useState<{ entries: ShortlistEntry[]; budget: string; problems: string[]; source?: DataSource } | null>(null);
  // Each shortlist's requests carry an idempotency key: a double-click sends the same request once.
  const [shortlistKey, setShortlistKey] = useState("");
  // What happened to each request sent from this shortlist, shown on its card: the request's id, or why it was refused.
  const [sent, setSent] = useState<Record<string, { id: string } | { error: string }>>({});
  const [devExpire, setDevExpire] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The 3 s refresh's own trouble (e.g. the server restarting): shown while it lasts, gone when it answers again.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setActivity(await getJson<Activity>("/api/facevisa/agent/activity"));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void getJson<Meta>("/api/facevisa").then(setMeta, () => undefined);
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => setDevExpire(!!meta?.devTools), [meta]);

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await f();
      await load();
    } catch (e) {
      const r = (e as { reasons?: string[] }).reasons;
      setError(r?.length ? r.join("; ") : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const ask = { brief, category, kind, durationDays };
  // Send one request from the shortlist; its outcome shows on that creator's card (and the request below).
  const sendRequest = async (creator: string) => {
    setBusy(`req-${creator}`);
    setError(null);
    try {
      const r = await postJson<{ request?: { id: string } }>("/api/facevisa/agent/request", { ...ask, creator, requestKey: `${shortlistKey}:${creator}` });
      setSent((m) => ({ ...m, [creator]: { id: r.request?.id ?? "" } }));
      await load();
    } catch (e) {
      const reasons = (e as { reasons?: string[] }).reasons;
      setSent((m) => ({ ...m, [creator]: { error: reasons?.length ? reasons.join("; ") : (e as Error).message } }));
    } finally {
      setBusy(null);
    }
  };
  const name = me.account?.name ?? "Brand";
  const requests = activity?.requests ?? [];
  const licences = activity?.licences ?? [];
  const pay = meta?.payments;

  return (
    <div className="min-h-[70vh]">
      <Page>
        {error && <ErrorCard>{error}</ErrorCard>}
        {loadError && <ErrorCard>{loadError}{activity ? " What's below may be out of date; it refreshes when the server answers." : ""}</ErrorCard>}

        {/* ------------------------------------------------ header: who, how they pay, the limits */}
        <section className={`${SURFACE} flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6`} aria-label="Your brand workspace">
          <span aria-hidden="true" className="flex h-28 w-28 shrink-0 items-center justify-center self-center rounded-[26px] bg-ink font-display text-[48px] font-extrabold text-lime ring-4 ring-lime sm:self-start">
            {(name.trim()[0] ?? "B").toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className={`text-[12px] font-semibold uppercase tracking-[0.08em] ${MUTED}`}>Brand workspace</span>
              <h1 className="m-0 font-display text-[clamp(26px,4vw,36px)] font-extrabold leading-[1.05] tracking-[-0.01em]">{name}</h1>
              <p className={`m-0 text-[14px] ${MUTED}`}>Your agent shortlists, asks and makes the ad. Each creator approves the finished ad in FaceVisa before it is paid for and released.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {me.presence?.required && me.presence.verified && <PresenceBadge presence={me.presence.environment ?? "production"} credential={me.presence.credential} />}
              {pay?.rail === "whitechain" && (
                <a href={pay.explorer && pay.settlement ? `${pay.explorer}/address/${pay.settlement}` : undefined} target="_blank" rel="noreferrer" className={`${CHIP} bg-violet-soft text-wait no-underline hover:underline`} title="You sign once; FaceVisa pays the gas; the settlement contract records each payment on chain">
                  Pays in USDT on Whitechain ↗
                </a>
              )}
              {meta?.hedera?.x402 && (
                <a href={meta.hedera.audit?.url ?? undefined} target="_blank" rel="noreferrer" className={`${CHIP} bg-violet-soft text-wait no-underline hover:underline`} title="Your agent pays in USDC on Hedera testnet over x402; its audit log (IDs and accounts only) is on Hedera">
                  Pays in USDC on Hedera{meta.hedera.audit?.url ? " ↗" : ""}
                </a>
              )}
              {meta?.spendLimit && (
                <span className={`${CHIP} bg-sky text-ink`} title="Above it, the agent pauses until you approve that exact amount in FaceVisa">
                  Spends alone up to {meta.spendLimit} per ad
                </span>
              )}
              <Link href="/creators" className={`${CHIP} bg-black/5 text-ink no-underline hover:underline`}>
                See every creator →
              </Link>
            </div>
          </div>
        </section>

        {brandNeedsCheck && (
          <section className={`${SURFACE} flex flex-col gap-3 p-5`} aria-label="Your World ID check">
            <h2 className="m-0 text-[18px] font-bold">Your World ID check</h2>
            <p className={`m-0 text-[14px] ${MUTED}`}>Brands are verified with World ID too. Your agent shortlists and asks once you&apos;ve completed it.</p>
            <PresenceCard me={me} onChange={refreshMe} />
          </section>
        )}
        {meta?.consent === "dev" && <div className="rounded-[20px] bg-wait-bg p-[18px] text-[14px] text-wait">DevConsent is on (local development, no sign-in configured): requests are approved at once, with no creator check.</div>}

        {/* ------------------------------------------------ stats */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Your numbers">
          <Stat label="Spent today" value={activity?.spentToday ?? "—"} note={pay?.rail === "whitechain" ? "USDT on Whitechain" : undefined} accent />
          <Stat label="Open requests" value={requests.filter((r) => OPEN.includes(r.status)).length} />
          <Stat label="With creators" value={requests.filter((r) => WITH_CREATOR.includes(r.status)).length} note="waiting for approval" />
          <Stat label="Released ads" value={licences.length} />
          <Stat label="Revoked" value={licences.filter((l) => l.status === "revoked").length} />
        </section>

        {/* ------------------------------------------------ the brief */}
        <section className="flex flex-col gap-4 rounded-[22px] bg-lime p-5 text-ink sm:p-6" aria-label="Brief your agent">
          <div className="flex flex-col gap-0.5">
            <h2 className="m-0 text-[20px] font-bold">Brief your agent</h2>
            <p className="m-0 text-[14px] text-ink/70">What the ad shows, where it&apos;s used, for how long, and what you&apos;ll pay.{meta?.presence ? ` It shortlists only creators with ${acceptedLabel(meta.presence.environment)}.` : ""}</p>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run("shortlist", async () => {
                setShortlist(null);
                setSent({});
                setShortlist(await postJson<{ entries: ShortlistEntry[]; budget: string; problems: string[]; source?: DataSource }>("/api/facevisa/agent/shortlist", { ...ask, maxPrice, budget }));
                setShortlistKey(crypto.randomUUID());
              });
            }}
          >
            <Field label="What the ad shows">
              <textarea className={`${inputClass} min-h-20 py-3`} maxLength={600} value={brief} onChange={(e) => setBrief(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Field label="Category">
                <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                  {(meta?.categories ?? [category]).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Media">
                <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="image">Image</option>
                  <option value="video">Video (8 s)</option>
                </select>
              </Field>
              <Field label="Days of use">
                <input className={inputClass} type="number" min={1} max={meta?.maxDays ?? 180} value={durationDays} onChange={(e) => setDurationDays(Number(e.target.value))} />
              </Field>
              <Field label="Max per render ($)">
                <input className={inputClass} inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.trim())} />
              </Field>
              <Field label="Budget ($)">
                <input className={inputClass} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.trim())} />
              </Field>
            </div>
            <button type="submit" disabled={!!busy || brandNeedsCheck} className={btnClass("ink", "self-start")}>
              {busy === "shortlist" ? "Shortlisting…" : "Shortlist creators"}
            </button>
          </form>
        </section>

        {/* ------------------------------------------------ the shortlist, with faces */}
        {shortlist && (
          <section className="flex flex-col gap-3" aria-label="The agent's shortlist">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="m-0 text-[20px] font-bold">The agent&apos;s shortlist</h2>
              <span className={`text-[13px] ${MUTED}`}>budget left: {shortlist.budget}</span>
            </div>
            <SourceLabel s={shortlist.source} />
            {shortlist.entries.length ? (
              <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {shortlist.entries.map((e) => (
                  <li key={e.creator} className={`${SURFACE} flex flex-col overflow-hidden ${e.pick ? "" : "opacity-80"}`}>
                    <div className="relative aspect-[4/3] w-full bg-paper">
                      <CreatorFace face={e.face} name={e.name} size="fill" rounded="rounded-none" className="absolute inset-0" />
                      <span className={`absolute left-3 top-3 ${CHIP} ${e.pick ? "bg-lime text-ink" : "bg-white/90 text-ink"}`}>{e.pick ? "Pick" : "Skip"}</span>
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <b className="text-[16px] leading-snug">{e.name}</b>
                        <span className="tnum shrink-0 text-[15px] font-bold">{e.price}</span>
                      </div>
                      <span className={`text-[12px] ${MUTED}`}>for one {kind}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {e.presence !== undefined && <PresenceBadge presence={e.presence} credential={e.credential} />}
                        {e.youtube && <StatusPill kind="licensed" title={`"${e.youtube.title}": the channel belongs to the Google account that granted access`}>Verified YouTube channel</StatusPill>}
                        {e.youtube?.faceMatch && <StatusPill kind="licensed" title="2+ of the channel's images match the creator's live capture">Face matches channel</StatusPill>}
                      </div>
                      <CreatorStatsRow stats={e.stats} arkiv={e.statsArkiv} usagePage={e.usagePage} />
                      <span className={`text-[13px] ${e.pick ? "text-ok" : MUTED}`}>{e.reason}</span>
                      {e.seeded && <span className="text-[12px] text-wait">{SEEDED}</span>}
                      <ItemSource source={e.source} url={e.url} why={e.why} />
                      {e.pick && (() => {
                        const out = sent[e.creator];
                        if (out && "id" in out) {
                          const r = requests.find((x) => x.id === out.id);
                          return (
                            <div role="status" className="mt-auto flex flex-col gap-1.5 rounded-[14px] bg-ok-bg p-3 text-[13px]">
                              <span className="flex flex-wrap items-center gap-2">
                                <b className="text-ok">Request sent</b>
                                {r && <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill>}
                              </span>
                              <span className={MUTED}>{!r || r.status === "generating" ? "The agent is making the ad; it stays private until the creator approves it." : ["review", "verified"].includes(r.status) ? "The ad is ready and waiting for the creator's approval." : r.reason ?? STATUS[r.status].label}</span>
                              <a href="#requests" className="font-semibold text-ink underline">See it in Requests ↓</a>
                            </div>
                          );
                        }
                        return (
                          <div className="mt-auto flex flex-col gap-2">
                            {out && "error" in out && <span role="alert" className="rounded-[12px] bg-bad-bg px-3 py-2 text-[13px] text-bad">Not sent: {out.error}</span>}
                            <button type="button" disabled={!!busy} onClick={() => void sendRequest(e.creator)} className={btnClass("lime", "min-h-10 self-start")}>
                              {busy === `req-${e.creator}` ? (meta?.payments?.rail === "whitechain" ? "Sending (topping up USDT if needed)…" : "Sending…") : out ? "Try again" : "Send request"}
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={`${SURFACE} p-5 text-[14px] ${MUTED}`}>No listed creators yet.</div>
            )}
          </section>
        )}

        <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-[18px]">
            {/* ------------------------------------------------ requests */}
            <section id="requests" className={`${SURFACE} flex scroll-mt-4 flex-col gap-3 p-5`} aria-label="Requests">
              <h2 className="m-0 text-[20px] font-bold">Requests</h2>
              {!activity ? (
                <p className={`m-0 text-[14px] ${MUTED}`}>{loadError ? "Your requests show here once the server answers." : "Loading your requests…"}</p>
              ) : requests.length ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {requests.map((r) => (
                    <li key={r.id} className="flex gap-3 rounded-[16px] bg-paper p-3">
                      <CreatorFace face={r.face} name={r.creator} size={56} rounded="rounded-[14px]" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <b className="text-[15px]">
                            {r.self ? "Your own creator profile" : r.creator} · one {r.kind} at {r.price}, {r.durationDays} days
                          </b>
                          <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill>
                        </div>
                        <span className={`text-[13px] ${MUTED}`}>
                          “{r.brief}” · {r.category}
                          {r.output ? ` · ${r.output.provider === "test" ? "TEST RENDER" : r.output.model}, face check ${r.output.faceCheck === "passed" ? "passed" : "not run"}${r.generation > 1 ? ", second version" : ""}` : ""}
                          {["review", "verified", "spend_review", "spend_verified", "approved"].includes(r.status) ? ` · until ${when(r.expiresAt)}` : r.reason ? ` · ${r.reason}` : ""}
                        </span>
                        <SlowStep status={r.status} kind={r.kind} since={r.stepAt} ai={meta?.ai} rail={meta?.payments?.rail} />
                        {r.consent && <span className="text-[13px] text-ok">Approved by the creator in FaceVisa, {when(r.consent.approvedAt)}{r.consent.method === "demo" ? " (a demo identity)" : r.consent.method === "google" ? " (signed in with Google)" : r.consent.method === "dev" ? " (local dev sign-in)" : ""}</span>}
                        {r.spend?.approvedAt && <span className="text-[13px] text-ok">Spend approved by the brand, {when(r.spend.approvedAt)}</span>}
                        {r.seededCreator && ["generating", "review", "verified"].includes(r.status) && <span className="text-[13px] text-wait">{SEEDED}</span>}
                        {(r.status === "spend_review" || r.status === "spend_verified") && (
                          <Link href={`/spend/${r.id}`} className={btnClass("lime", "min-h-9 self-start")}>
                            Approve the spend of {r.price} (over your limit)
                          </Link>
                        )}
                        {r.status === "approved" && r.lastStep?.kind === "blocked" && <span className="text-[13px] text-wait">Not paid yet: {r.lastStep.summary.replace(/^not paid: /, "")}</span>}
                        {r.status === "approved" && (
                          <button type="button" disabled={!!busy} className={btnClass("lime", "min-h-9 self-start")} onClick={() => void run(`release-${r.id}`, () => postJson("/api/facevisa/agent/release", { id: r.id }))}>
                            {busy === `release-${r.id}` ? "Paying…" : `Pay ${r.price} and release`}
                          </button>
                        )}
                        {["failed", "expired", "cancelled"].includes(r.status) && r.creatorId && !r.seededCreator && (
                          <button
                            type="button"
                            disabled={!!busy}
                            className={btnClass("lime", "min-h-9 self-start")}
                            onClick={() => void run(`again-${r.id}`, () => postJson("/api/facevisa/agent/request", { brief: r.brief, category: r.category, kind: r.kind, durationDays: r.durationDays, creator: r.creatorId, requestKey: `again:${r.id}` }))}
                          >
                            {busy === `again-${r.id}` ? "Asking again…" : `Ask again (same terms, ${r.price})`}
                          </button>
                        )}
                        {["generating", "review", "verified", "approved", "spend_review", "spend_verified"].includes(r.status) && (
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className={btnClass("ghost", "min-h-8 px-0")} onClick={() => void run(`cancel-${r.id}`, () => postJson("/api/facevisa/agent/cancel", { id: r.id }))}>
                              Cancel request
                            </button>
                            {devExpire && r.status !== "generating" && (
                              <button type="button" className={btnClass("ghost", "min-h-8 px-0")} onClick={() => void run(`expire-${r.id}`, () => postJson("/api/dev/expire-request", { id: r.id }))}>
                                Dev: expire now
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col items-start gap-2 rounded-[16px] bg-paper p-4">
                  <b className="text-[15px]">No requests yet</b>
                  <span className={`text-[14px] ${MUTED}`}>Brief your agent and send a request; it waits for the creator&apos;s own approval.</span>
                </div>
              )}
            </section>

            {/* ------------------------------------------------ released ads */}
            <section className="flex flex-col gap-3" aria-label="Released ads">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h2 className="m-0 text-[20px] font-bold">Released ads</h2>
                {activity && <span className={`text-[13px] ${MUTED}`}>spent today {activity.spentToday}</span>}
              </div>
              {licences.length ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {licences.map((l) => (
                    <article key={l.id} className={`${SURFACE} flex flex-col gap-2 overflow-hidden p-3`}>
                      {l.receipt && <MediaTile file={l.receipt.file} mime={l.receipt.mime} verifyHash={l.receipt.hash} swarm={l.receipt.swarm} caption={`${l.receipt.provider === "test" ? "TEST RENDER" : l.receipt.model} · paid ${l.price}`} />}
                      <div className="flex items-center justify-between gap-2">
                        <b className="text-[14px]">{l.creator}</b>
                        <StatusPill kind={l.status === "active" ? "licensed" : "revoked"}>{l.status === "active" ? `Until ${when(l.expiresAt)}` : "Revoked by the creator"}</StatusPill>
                      </div>
                      <span className={`text-[13px] ${MUTED}`}>{l.category}</span>
                      {l.receipt?.payment && (
                        <span className={`text-[12px] ${MUTED}`}>
                          Paid {l.price}: <PaymentLine p={l.receipt.payment} />
                        </span>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className={`${SURFACE} p-5 text-[14px] ${MUTED}`}>An ad is released only after its creator approves that exact ad in FaceVisa; then the agent pays on its own.</div>
              )}
            </section>
          </div>

          {/* ------------------------------------------------ the agent's log */}
          <section className="flex flex-col gap-3 rounded-[22px] bg-ink p-5 text-white" aria-label="Agent activity">
            <h2 className="m-0 text-[20px] font-bold">Agent activity</h2>
            {activity?.events.length ? (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {activity.events.map((e) => (
                  <li key={e.id} className="flex flex-col gap-0.5 border-b border-white/10 pb-2 text-[13px] last:border-0">
                    <span className="flex items-center gap-2">
                      <StatusPill kind={EVENT_PILL[e.kind] ?? "neutral"}>{e.kind}</StatusPill>
                      <span className="text-[#B9BCC4]">{new Date(e.at).toLocaleTimeString()}</span>
                    </span>
                    <span className="text-white [overflow-wrap:anywhere]">{e.summary}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-[14px] text-[#B9BCC4]">The agent&apos;s steps show here: requested → generated → waiting → approved → paid → released, or blocked with the reason.</p>
            )}
          </section>
        </div>
      </Page>
    </div>
  );
}

function Stat({ label, value, note, accent = false }: { label: string; value: ReactNode; note?: ReactNode; accent?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-[20px] px-4 py-4 ${accent ? "col-span-2 bg-ink text-white md:col-span-1" : SURFACE}`}>
      <span className={`text-[12px] font-semibold uppercase tracking-[0.06em] ${accent ? "text-grey-dark" : MUTED}`}>{label}</span>
      <span className="tnum font-display text-[30px] font-extrabold leading-none">{value}</span>
      {note && <span className={`text-[12px] ${accent ? "text-grey-dark" : MUTED}`}>{note}</span>}
    </div>
  );
}
