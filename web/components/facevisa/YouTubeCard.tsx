"use client";

/**
 * The creator's YouTube channel: optional, never required to list. Linking runs a standalone Google sign-in for
 * read-only YouTube access in our backend; the token is used once there and never reaches this page. Two separate
 * badges: "Verified YouTube channel" (the channel belongs to the Google account that granted access) and "Face matches
 * channel" (2+ of the channel's picture and recent thumbnails match the live capture). The callback's outcome comes
 * back as ?youtube=….
 */
import { useEffect, useState } from "react";
import { btnClass, Card, ErrorCard, StatusPill } from "@/components/ds";
import type { Me } from "@/lib/api";
import { getJson, postJson, YOUTUBE, type Meta } from "@/lib/facevisa";

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function YouTubeCard({ me, onChange }: { me: Me; onChange: () => Promise<unknown> }) {
  const yt = me.creator?.youtube ?? null;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);

  useEffect(() => {
    const u = new URL(window.location.href);
    const outcome = u.searchParams.get("youtube");
    if (outcome) {
      setNotice(YOUTUBE[outcome] ?? YOUTUBE.failed!);
      u.searchParams.delete("youtube");
      window.history.replaceState(null, "", `${u.pathname}${u.search}`);
    }
    void getJson<Meta>("/api/facevisa").then((m) => setConfigured(m.youtube), () => setConfigured(false));
  }, []);
  // The face match runs in the background after linking: refresh until it has a result.
  useEffect(() => {
    if (!yt || yt.faceMatch || !me.creator?.photo) return;
    const t = setTimeout(() => void onChange(), 3000);
    return () => clearTimeout(t);
  }, [yt, me.creator?.photo, onChange]);

  if (!yt && !configured && !notice) return null;
  const run = async (what: "link" | "unlink", f: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const fm = yt?.faceMatch;

  return (
    <Card title="Your YouTube channel (optional)">
      {notice && <div role="status" className={`rounded-[14px] p-3 text-[14px] ${notice.ok ? "bg-ok-bg text-ok" : "bg-wait-bg text-wait"}`}>{notice.text}</div>}
      {error && <ErrorCard>{error}</ErrorCard>}
      {yt ? (
        <>
          <div className="flex items-center gap-3">
            {yt.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={yt.thumbnail} alt="" width={44} height={44} referrerPolicy="no-referrer" className="h-11 w-11 rounded-full" />
            )}
            <span className="flex min-w-0 flex-col gap-1">
              <b className="text-[15px]">{yt.title}</b>
              <span className="text-[13px] text-grey">
                {yt.subscribers !== null ? `${count(yt.subscribers)} subscribers` : "Subscriber count hidden"}
                {yt.topics.length ? ` · ${yt.topics.join(", ")}` : ""}
              </span>
              <span className="flex flex-wrap gap-1.5">
                <StatusPill kind="licensed" title="The channel belongs to the Google account that granted read-only access">Verified YouTube channel</StatusPill>
                {fm?.badge && <StatusPill kind="licensed" title={`${fm.matches} of ${fm.images} channel images match your live capture`}>Face matches channel</StatusPill>}
              </span>
            </span>
          </div>
          <p className="m-0 text-[13px] text-grey">
            {!me.creator?.photo
              ? "The face match runs once you've saved your live capture."
              : !fm
                ? "Checking your channel picture and recent thumbnails against your live capture…"
                : fm.badge
                  ? `${fm.matches} of ${fm.images} channel images match your live capture (best ${fm.best?.toFixed(2)}).`
                  : fm.withFace === 0
                    ? "No faces in your channel picture or recent thumbnails, so no face badge. That's fine: nothing is blocked."
                    : `${fm.matches} of ${fm.withFace} channel images with a face match your live capture; the badge needs 2. Nothing is blocked.`}
          </p>
          <button type="button" disabled={!!busy} className={btnClass("outline", "min-h-9 self-start")} onClick={() => void run("unlink", async () => (await postJson("/api/facevisa/creator/youtube/unlink", {}), await onChange(), setBusy(null)))}>
            {busy === "unlink" ? "Unlinking…" : "Unlink channel"}
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px]">
            Show brands which public creator you are. Google asks for read-only access to your YouTube account; we keep the channel&apos;s name, picture, subscriber count and
            topics, never the access. Not needed to list.
          </p>
          {configured && (
            <button
              type="button"
              disabled={!!busy}
              className={btnClass("ink", "self-start")}
              onClick={() =>
                void run("link", async () => {
                  const { url } = await postJson<{ url: string }>("/api/facevisa/creator/youtube/start", {});
                  window.location.assign(url);
                })
              }
            >
              {busy === "link" ? "Opening Google…" : "Link your YouTube channel"}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
