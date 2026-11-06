"use client";

/**
 * A listed creator's dashboard. Their face (signed-in brands see it on the listing, never on Arkiv), status chips (listed, the World ID check, the
 * listing on Arkiv, where brands pay them on chain), what they've earned, the ads waiting for their approval (nothing is released
 * until they approve the actual ad, in FaceVisa), every ad made with their face, their rules, and the public page that
 * shows where their face is used, read straight from Arkiv.
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { btnClass, ErrorCard, Initial, Page, StatusPill } from "@/components/ds";
import { CaptureStep } from "@/components/dashboard/Onboarding";
import { useAuth } from "@/components/site/Auth";
import { post, type Me } from "@/lib/api";
import { getJson, postJson, STATUS, usd, when, type ArkivSync, type CreatorRequest, type DataSource, type InboxItem, type LicenceView, type Meta } from "@/lib/facevisa";
import { ArkivLine } from "./ArkivLine";
import { ItemSource, SourceLabel } from "./SourceLabel";
import { PresenceBadge } from "./PresenceBadge";
import { PresenceCard } from "./PresenceCard";
import { RulesForm } from "./RulesForm";
import { MediaTile, SwarmLink } from "./ReceiptTile";
import { YouTubeCard } from "./YouTubeCard";

const OPEN = ["generating", "review", "verified"];

// Surfaces and text (light only).
const SURFACE = "rounded-[22px] bg-white text-ink ring-1 ring-black/[0.04]";
const MUTED = "text-grey";
const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold";
const OUTLINE = "inline-flex min-h-9 items-center justify-center rounded-full border border-ink/15 px-4 text-[14px] font-semibold text-ink no-underline transition-colors hover:border-ink";

/** "$0.15" → 150000 micro-USD (the views carry prices as text). */
const micro = (price: string) => Math.round(Number(price.replace(/[^0-9.]/g, "")) * 1e6);

export function CreatorHome({ me, onChange }: { me: Me; onChange: () => Promise<unknown> }) {
  const { demo } = useAuth();
  const c = me.creator;
  const listing = c?.listing ?? null;
  const [requests, setRequests] = useState<CreatorRequest[] | null>(null);
  const [inbox, setInbox] = useState<{ items: InboxItem[]; source: DataSource } | null>(null);
  const [licences, setLicences] = useState<LicenceView[] | null>(null);
  const [listingSync, setListingSync] = useState<ArkivSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [recapture, setRecapture] = useState(false);
  const [editRules, setEditRules] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => void getJson<Meta>("/api/facevisa").then(setMeta, () => undefined), []);
  // The public page listing every licence of this face, read from Arkiv alone (the direct verifier's sibling).
  const facePage = c?.arkivAddress && meta?.arkiv.namespace ? `/verifier/creator.html?creator=${c.arkivAddress}&ns=${encodeURIComponent(meta.arkiv.namespace)}` : null;
  const load = useCallback(async () => {
    try {
      const [r, l, s] = await Promise.all([
        getJson<{ requests: CreatorRequest[]; inbox: { items: InboxItem[]; source: DataSource } }>("/api/facevisa/creator/requests"),
        getJson<{ licences: LicenceView[] }>("/api/facevisa/creator/licences"),
        getJson<{ arkiv: ArkivSync }>("/api/facevisa/creator/listing"),
      ]);
      setRequests(r.requests);
      setInbox(r.inbox);
      setLicences(l.licences);
      setListingSync(s.arkiv);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const open = (requests ?? []).filter((r) => OPEN.includes(r.status));
  // Requests waiting for review: as the inbox read them (from Arkiv where confirmed there).
  const inboxed = new Map((inbox?.items ?? []).map((i) => [i.id, i]));
  const past = (requests ?? []).filter((r) => !OPEN.includes(r.status));
  const all = licences ?? [];
  const paid = all.filter((l) => l.receipt);
  // Earned: real testnet stablecoins on chain only (USDT on Whitechain, or USDC on Hedera); test payments (DevPayment,
  // no money moved) are counted apart.
  const onChainPaid = paid.filter((l) => l.receipt?.paymentRail === "whitechain" || l.receipt?.paymentRail?.startsWith("hedera"));
  const isOnChain = onChainPaid.length > 0;
  const asset = onChainPaid.some((l) => l.receipt?.paymentRail === "whitechain") ? "USDT" : "USDC";
  const earned = (isOnChain ? onChainPaid : paid).reduce((n, l) => n + micro(l.price), 0);
  const testPaid = paid.length - onChainPaid.length;
  const payout = c?.payout ?? (c?.hedera ? { network: "Hedera", ...c.hedera } : null);
  // Where the earnings were paid: USDT on Whitechain (the payout address), or USDC on Hedera (the Hedera account).
  const earnedOn = asset === "USDT" ? payout : c?.hedera ? { network: "Hedera", ...c.hedera } : payout?.network === "Hedera" ? payout : null;
  const brands = new Set(all.map((l) => l.brand)).size;
  const revoked = all.filter((l) => l.status === "revoked").length;
  // The public demo's 48-hour rule for its public accounts (Google, demo identities).
  const retention = demo && (me.account?.signIn === "google" || me.account?.signIn === "demo") ? demo.retentionHours : null;
  const presence = c?.presence;

  const toBrand = async () => {
    setSwitching(true);
    try {
      await post("/api/me/role", { role: "brand" });
      await onChange();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="min-h-[70vh]">
      <Page>
        {error && <ErrorCard>{error}</ErrorCard>}

        {/* ------------------------------------------------ header: face, name, status */}
        <section className={`${SURFACE} flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6`} aria-label="Your creator profile">
          <div className="flex shrink-0 flex-col items-center gap-2 sm:items-start">
            <Face photo={c?.photo ?? null} name={me.account?.name ?? "You"} />
            <button type="button" onClick={() => setRecapture((v) => !v)} className={`${OUTLINE} min-h-8 px-3 text-[13px]`}>
              {recapture ? "Close" : "Re-capture"}
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className={`text-[12px] font-semibold uppercase tracking-[0.08em] ${MUTED}`}>Creator profile</span>
              <h1 className="m-0 font-display text-[clamp(26px,4vw,36px)] font-extrabold leading-[1.05] tracking-[-0.01em]">{me.account?.name ?? "Creator"}</h1>
              <p className={`m-0 text-[14px] ${MUTED}`}>Brands&apos; agents ask and make the ad; nothing is released until you approve the finished ad here.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {listing ? <span className={`${CHIP} bg-lime text-ink`}>● Listed</span> : <span className={`${CHIP} bg-black/5 text-ink`}>Draft</span>}
              {presence?.required && presence.verified && <PresenceBadge presence={presence.environment ?? "production"} credential={presence.credential} />}
              {listingSync && listingSync.state === "synced" ? (
                <a href={listingSync.url} target="_blank" rel="noreferrer" className={`${CHIP} bg-sky text-ink no-underline hover:underline`} title={c?.arkivListing ? `On Arkiv until ${when(c.arkivListing.expiresAt)}; renewed automatically while you stay listed` : "Your listing entity on Arkiv"}>
                  Listed on Arkiv ↗
                </a>
              ) : listingSync && listingSync.state !== "off" ? (
                <span className={`${CHIP} bg-black/5 text-ink`}>Arkiv: {listingSync.state}</span>
              ) : null}
              {payout && (
                <a href={payout.url} target="_blank" rel="noreferrer" className={`${CHIP} bg-violet-soft text-wait no-underline hover:underline`} title={`Your ${payout.network} ${payout.network === "Whitechain" ? "address" : "account"}: brands pay you here (testnet ${payout.network === "Whitechain" ? "USDT" : "USDC"})`}>
                  {payout.network} {/^0x[0-9a-fA-F]{40}$/.test(payout.account) ? `${payout.account.slice(0, 6)}…${payout.account.slice(-4)}` : payout.account} ↗
                </a>
              )}
            </div>
            {retention && <p className={`m-0 text-[12px] ${MUTED}`}>Public demo: your capture and the ads made of you are deleted {retention} hours after they were made. Their hashes stay on Arkiv.</p>}
          </div>
        </section>
        {recapture && (
          <section className={`${SURFACE} flex flex-col gap-3 p-5`} aria-label="Re-capture">
            <h2 className="m-0 text-[18px] font-bold">Re-capture your face</h2>
            <div className="rounded-[16px] bg-white p-1 text-ink">
              <CaptureStep
                me={me}
                onSaved={async () => {
                  await onChange();
                  setRecapture(false);
                }}
              />
            </div>
          </section>
        )}

        {presence?.required && !presence.verified && (
          <section className={`${SURFACE} flex flex-col gap-3 p-5`} aria-label="Your World ID check">
            <h2 className="m-0 text-[18px] font-bold">Your World ID check</h2>
            <p className={`m-0 text-[14px] ${MUTED}`}>Brands&apos; agents shortlist only creators with a World ID check. Complete it and your listing (here and on Arkiv) carries its badge.</p>
            <PresenceCard me={me} onChange={onChange} />
          </section>
        )}

        {/* ------------------------------------------------ stats */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Your numbers">
          <Stat
            label={isOnChain ? `Earned (${asset})` : "Earned"}
            value={usd(earned)}
            note={
              earnedOn && isOnChain ? (
                <a href={earnedOn.url} target="_blank" rel="noreferrer" className="underline">
                  On {earnedOn.network === "Whitechain" ? "the Whitechain explorer" : "HashScan"} ↗{testPaid ? ` · plus ${testPaid} test payment${testPaid === 1 ? "" : "s"}` : ""}
                </a>
              ) : paid.length ? (
                "test payments"
              ) : (
                "nothing yet"
              )
            }
            accent
          />
          <Stat label="Ads approved" value={all.length} />
          <Stat label="Waiting for you" value={open.length} />
          <Stat label="Revoked" value={revoked} />
          <Stat label="Brands" value={brands} note="licensed your face" />
        </section>

        {/* ------------------------------------------------ waiting */}
        <section className="flex flex-col gap-3 rounded-[22px] bg-lime p-5 text-ink sm:p-6" aria-label="Ads waiting for you">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-[20px] font-bold">Ads waiting for you{open.length ? ` (${open.length})` : ""}</h2>
            {inbox && inbox.items.length > 0 && <SourceLabel s={inbox.source} />}
          </div>
          {requests === null ? (
            <p className="m-0 text-[14px]">Loading…</p>
          ) : open.length ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {open.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-white px-4 py-3">
                  <span className="flex min-w-0 flex-col">
                    <b className="text-[15px]">
                      {r.self ? "You (your brand workspace)" : r.brand} {r.status === "generating" ? "· the agent is making the ad" : `asks to release ${r.kind === "video" ? "a video" : "an image"} of you`}
                    </b>
                    <span className="text-[13px] text-grey">{r.status === "generating" ? (r.generation > 1 ? "A new version, after your rejection" : "Ready to review soon") : `Review by ${when(inboxed.get(r.id)?.reviewBy ?? r.expiresAt)}`}</span>
                    {inboxed.has(r.id) && <ItemSource source={inboxed.get(r.id)!.source} url={inboxed.get(r.id)!.url} why={inboxed.get(r.id)!.why} />}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill>
                    {r.status !== "generating" && (
                      <Link href={`/requests/${r.id}`} className={btnClass("ink", "min-h-9")}>
                        {r.status === "verified" ? "Decide" : "Review"}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-[16px] bg-white/70 p-4">
              <p className="m-0 text-[15px]">
                <b>No requests yet.</b> Try it yourself: switch to Brand, request an ad of yourself, then come back here to approve it.
              </p>
              <button type="button" disabled={switching} onClick={() => void toBrand()} className={btnClass("ink", "min-h-9")}>
                {switching ? "Switching…" : "Switch to Brand"}
              </button>
            </div>
          )}
        </section>

        {/* ------------------------------------------------ the gallery */}
        <section className="flex flex-col gap-3" aria-label="Ads made with your face">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-[20px] font-bold text-ink">Ads made with your face</h2>
            {all.length > 0 && <span className={`text-[13px] ${MUTED}`}>{all.length} licensed · {revoked} revoked</span>}
          </div>
          {licences === null ? (
            <div className={`${SURFACE} h-40 animate-pulse motion-reduce:animate-none`} />
          ) : all.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {all.map((l) => (
                <AdCard key={l.id} l={l} onRevoked={load} />
              ))}
            </div>
          ) : (
            <div className={`${SURFACE} flex flex-col gap-1 p-5`}>
              <b className="text-[15px]">Nothing released yet</b>
              <span className={`text-[14px] ${MUTED}`}>When you approve an ad and the brand pays, the licence and the ad show here.</span>
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* ------------------------------------------------ rules */}
          {listing && (
            <section className={`${SURFACE} flex flex-col gap-4 p-5 sm:p-6`} aria-label="Your rules">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="m-0 text-[20px] font-bold">Your rules</h2>
                <button type="button" onClick={() => setEditRules((v) => !v)} className={OUTLINE}>
                  {editRules ? "Close" : "Edit"}
                </button>
              </div>
              {editRules ? (
                <div className="rounded-[16px] bg-white p-1 text-ink">
                  <RulesForm
                    listing={listing}
                    onSaved={async () => {
                      await onChange();
                      setEditRules(false);
                    }}
                  />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Rule label="Per image" value={usd(listing.rules.minPrice)} />
                    <Rule label="Per video" value={usd(listing.rules.minPrice * (meta?.videoMultiplier ?? 3))} />
                    <Rule label="Longest licence" value={`${listing.rules.maxDays} days`} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className={`text-[13px] ${MUTED}`}>You refuse</span>
                    <div className="flex flex-wrap gap-1.5">
                      {listing.rules.bannedCategories.length ? (
                        listing.rules.bannedCategories.map((b) => (
                          <span key={b} className={`${CHIP} bg-bad-bg text-bad`}>
                            {b}
                          </span>
                        ))
                      ) : (
                        <span className={`text-[13px] ${MUTED}`}>No categories (beyond the ones refused for everyone)</span>
                      )}
                    </div>
                    <span className={`text-[12px] ${MUTED}`}>Political, adult, minors, impersonation and deception are refused for everyone.</span>
                  </div>
                </>
              )}
            </section>
          )}

          {/* ------------------------------------------------ the public page */}
          {facePage && <PublicPage href={facePage} />}
        </div>

        {past.length > 0 && (
          <details className={`${SURFACE} group px-5 py-4`}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold">
              Earlier requests ({past.length})
              <span aria-hidden="true" className="transition-transform group-open:rotate-180">▾</span>
            </summary>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-3">
              {past.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-[14px]">
                  <Link href={`/requests/${r.id}`} className="text-ink">
                    {r.brand}: {r.kind}, {when(r.createdAt)}
                  </Link>
                  <StatusPill kind={STATUS[r.status].pill}>{STATUS[r.status].label}</StatusPill>
                </li>
              ))}
            </ul>
          </details>
        )}

        <YouTubeCard me={me} onChange={onChange} />
      </Page>
    </div>
  );
}

/** The creator's own capture (its front frame), fetched with their session: it has no public URL. */
function Face({ photo, name }: { photo: string | null; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return;
    let url: string | undefined;
    void (async () => {
      const res = await fetch(photo, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      url = URL.createObjectURL(await res.blob());
      setSrc(url);
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo]);
  return (
    <div className="relative h-28 w-28 overflow-hidden rounded-[26px] bg-paper ring-4 ring-lime" title="Your live capture: signed-in brands see it on your listing; never on Arkiv">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="Your live capture" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center">
          <Initial name={name} size={64} />
        </span>
      )}
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

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[16px] bg-paper px-3 py-3">
      <span className={`text-[12px] ${MUTED}`}>{label}</span>
      <span className="tnum text-[18px] font-bold">{value}</span>
    </div>
  );
}

/** One ad made with the creator's face: the file, who licensed it, for how much and how long, and its controls. */
function AdCard({ l, onRevoked }: { l: LicenceView; onRevoked: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = l.receipt;
  return (
    <article className={`${SURFACE} flex min-w-0 flex-col overflow-hidden`}>
      {r ? (
        <div className="bg-paper">
          <MediaTile file={r.file} mime={r.mime} />
        </div>
      ) : (
        <div className={`flex h-40 items-center justify-center bg-paper text-[13px] ${MUTED}`}>No file</div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <b className="truncate text-[16px]">{l.brand}</b>
          <StatusPill kind={l.status === "active" ? "licensed" : "revoked"}>{l.status === "active" ? `Until ${when(l.expiresAt)}` : "Revoked"}</StatusPill>
        </div>
        <span className={`text-[13px] ${MUTED}`}>
          {l.kind} for {l.category} · {l.durationDays} days · “{l.brief}”
        </span>
        <dl className="m-0 grid grid-cols-3 gap-2 text-[13px]">
          <Fact label="Paid" value={l.price} />
          <Fact label="Face" value={r?.faceScore != null ? r.faceScore.toFixed(2) : r?.faceCheck === "passed" ? "passed" : "not run"} />
          <Fact label="Model" value={r ? (r.provider === "test" ? "test" : r.model.replace(/^.*\//, "")) : "—"} />
        </dl>
        <ArkivLine label="Licence" s={l.arkiv?.licence} />
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {r && (
            <Link href={`/verify?hash=${r.hash}`} className={OUTLINE}>
              Verify
            </Link>
          )}
          {(r?.payment?.explorer ?? r?.payment?.hashscan) && (
            <a href={r!.payment!.explorer ?? r!.payment!.hashscan} target="_blank" rel="noreferrer" className={OUTLINE}>
              Payment ↗
            </a>
          )}
          {r?.swarm?.state === "uploaded" && <SwarmLink s={r.swarm} className={OUTLINE} />}
          {l.status === "active" && (
            <button
              type="button"
              disabled={busy}
              className="inline-flex min-h-9 items-center justify-center rounded-full border border-bad/40 px-4 text-[14px] font-semibold text-bad transition-colors hover:bg-bad-bg disabled:opacity-60"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await postJson("/api/facevisa/creator/revoke", { licenceId: l.id });
                  await onRevoked();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Revoking…" : "Revoke"}
            </button>
          )}
        </div>
        {error && <ErrorCard>{error}</ErrorCard>}
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className={`text-[11px] uppercase tracking-[0.06em] ${MUTED}`}>{label}</dt>
      <dd className="m-0 truncate font-semibold">{value}</dd>
    </div>
  );
}

/** The public page: every licence of this face, read straight from Arkiv by the visitor's browser. */
function PublicPage({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  const [absolute, setAbsolute] = useState(href);
  useEffect(() => setAbsolute(new URL(href, window.location.origin).toString()), [href]);
  return (
    <section className="flex flex-col gap-3 rounded-[22px] bg-ink p-5 text-white ring-1 ring-white/10 sm:p-6" aria-label="Your public page">
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-lime">Your public page</span>
      <h2 className="m-0 text-[20px] font-bold leading-snug">Anyone can check where your face is used, read straight from Arkiv, without trusting FaceVisa.</h2>
      <code className="block truncate rounded-[12px] bg-white/5 px-3 py-2 text-[12px] text-grey-dark">{absolute}</code>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnClass("lime", "min-h-9")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(absolute);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center justify-center rounded-full border border-white/25 px-4 text-[14px] font-semibold text-white no-underline hover:border-white">
          Open ↗
        </a>
      </div>
    </section>
  );
}
