"use client";

/**
 * A new account gives a display name and picks where to start. Creators then make a live camera capture
 * (blink and turn; no uploads) they consent to, and set their rules (price, longest licence, refused categories).
 * Linking a YouTube channel is optional and never required to list.
 */
import { useCallback, useEffect, useState } from "react";
import { btnClass, Card, ErrorCard, StatusPill } from "@/components/ds";
import { YouTubeCard } from "@/components/facevisa/YouTubeCard";
import { Field, inputClass } from "@/components/ui";
import { api, type Me, type Role } from "@/lib/api";
import { RulesForm } from "@/components/facevisa/RulesForm";
import { LivenessCapture, type Capture } from "@/components/facevisa/LivenessCapture";
import { PresenceCard } from "@/components/facevisa/PresenceCard";
import { useAuth } from "@/components/site/Auth";

export function ChooseRole({ onDone, initialName = "" }: { onDone: () => Promise<unknown>; initialName?: string }) {
  const [busy, setBusy] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pre-filled with the name from Google sign-in, when there is one; editable until set-up is done.
  const [name, setName] = useState(initialName);
  const nameOk = name.trim().length >= 2 && name.trim().length <= 60;
  const choose = async (role: Role) => {
    setBusy(role);
    setError(null);
    try {
      await api("/api/me/role", { role, name: name.trim() });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {/* Only when the account has no name yet (the dev sign-in, or a Google account without one): Google's name is used as it is. */}
      {!initialName && (
        <Field label="Display name" hint="Shown to the other side, as a creator and as a brand. 2–60 characters.">
          <input className={inputClass} value={name} maxLength={60} autoComplete="nickname" onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Shoes, or Maya Rao" />
        </Field>
      )}
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
        <Card title="Start in the brand workspace">
          <p className="m-0 text-[14px] text-grey">Brief your agent: it shortlists creators and asks; each creator approves the finished ad before it&apos;s paid for and released.</p>
          <button type="button" disabled={busy !== null || !nameOk} onClick={() => void choose("brand")} className={btnClass("ink", "self-start")}>
            {busy === "brand" ? "Setting up…" : "Start as a brand"}
          </button>
        </Card>
        <Card tone="lime" title="Start with your creator profile">
          <p className="m-0 text-[14px]">Put your own face on FaceVisa: set your price and refused categories; nothing is released without your approval.</p>
          <button type="button" disabled={busy !== null || !nameOk} onClick={() => void choose("creator")} className={btnClass("ink", "self-start")}>
            {busy === "creator" ? "Setting up…" : "Start as a creator"}
          </button>
        </Card>
      </div>
      {error && <ErrorCard>{error}</ErrorCard>}
    </>
  );
}

export function CreatorOnboarding({ me, onChange }: { me: Me; onChange: () => Promise<unknown> }) {
  const c = me.creator;
  if (!c) return null;
  const listed = !!c.listing;
  const p = c.presence;
  const pop = p?.required ? (p.state ?? (p.verified ? "verified" : "none")) : "verified";
  return (
    <div className="flex flex-col gap-[14px]">
      {/* Until it's listed the profile is a draft: brands' agents can't find it. A cancel in World ID leaves it so. */}
      <p role="status" className="m-0 flex flex-wrap items-center gap-2 text-[14px]">
        <StatusPill kind={pop === "review" ? "waiting" : "neutral"}>{pop === "review" ? "Draft · under review" : "Draft"}</StatusPill>
        {pop === "review" ? "Your profile isn't listed yet: your World ID check is held for review." : "Your profile isn't listed yet: brands' agents can't find it until you finish the steps below."}
      </p>

      <Step n={1} title="Your live capture" done={!!c.photo && !!c.consentAt}>
        <CaptureStep me={me} onSaved={onChange} />
      </Step>

      {c.presence?.required && (
        <Step n={2} title="Your World ID check" done={c.presence.verified}>
          <PresenceCard me={me} onChange={onChange} />
        </Step>
      )}

      <Step n={c.presence?.required ? 3 : 2} title="Your rules, then list yourself" done={listed}>
        {!(c.photo && c.consentAt) ? (
          <p className="m-0 text-[13px] text-grey">Save your live capture (with consent) first.</p>
        ) : pop === "review" ? (
          <p className="m-0 text-[13px] text-grey">You can list once your World ID check is cleared in review.</p>
        ) : pop === "rejected" ? (
          <p className="m-0 text-[13px] text-grey">This World ID can&apos;t list: its check wasn&apos;t cleared in review.</p>
        ) : c.presence?.required && !c.presence.verified ? (
          <p className="m-0 text-[13px] text-grey">Complete the World ID check first.</p>
        ) : (
          <RulesForm listing={c.listing} onSaved={onChange} />
        )}
      </Step>

      <YouTubeCard me={me} onChange={onChange} />
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <h2 className="m-0 flex items-center gap-3 text-[17px] font-bold">
        <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[14px] ${done ? "bg-lime text-ink" : "bg-ink text-lime"}`}>{done ? "✓" : n}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function CaptureStep({ me, onSaved }: { me: Me; onSaved: () => Promise<unknown> }) {
  const c = me.creator!;
  const { demo } = useAuth();
  // The public demo's 48-hour rule applies to its public accounts (Google, demo identities): said next to the consent.
  const demoRetention = demo && (me.account?.signIn === "demo" || me.account?.signIn === "google") ? demo.retentionHours : null;
  const [consent, setConsent] = useState(false);
  const [capturing, setCapturing] = useState(!c.photo);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The saved front frame, shown to its owner (with the session cookie; it has no public URL).
  useEffect(() => {
    if (!c.photo || capturing) return;
    let url: string | undefined;
    void (async () => {
      const res = await fetch(c.photo!, { cache: "no-store" });
      if (res.ok) setPreview((url = URL.createObjectURL(await res.blob())));
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [c.photo, capturing]);
  const onDone = useCallback((cap: Capture) => setCapture(cap), []);

  async function save() {
    if (!capture) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/creator/capture", { frames: capture.frames, liveness: capture.liveness, consent });
      setCapturing(false);
      setCapture(null);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!capturing)
    return (
      <div className="flex flex-wrap items-center gap-4">
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Your live capture (front frame)" className="h-28 w-40 -scale-x-100 rounded-[14px] object-cover" />
        )}
        <span className="flex flex-col gap-1 text-[14px]">
          <b>Live capture saved</b>
          <span className="text-grey">Three frames from your camera, with the blink-and-turn check. Every ad of you is matched against them.</span>
          <button type="button" className={btnClass("outline", "self-start")} onClick={() => setCapturing(true)}>
            Capture again
          </button>
        </span>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[14px] text-grey">
        Camera only, no uploads: look at the camera, blink, then turn slightly each way. The frames are kept on this server and brands never see them; the
        image model gets them as the reference for each ad. Every ad made of you is checked against them, and nothing is released without your approval.
      </p>
      <LivenessCapture onDone={onDone} />
      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I consent to brands&apos; agents making ads of me from this capture, each one released only after I approve it.</span>
      </label>
      {demoRetention !== null && (
        <p role="note" className="m-0 rounded-[12px] bg-paper p-3 text-[13px]">
          Your photo is sent to 0G (ByteDance Seedream) or Google Vertex to generate ads, and deleted from FaceVisa after {demoRetention} hours. The ads made of you are deleted after {demoRetention} hours too. Arkiv, the public record, only ever holds hashes (of your ads, licences and receipts), never your photo or an ad.
        </p>
      )}
      <button type="button" disabled={busy || !capture || !consent} onClick={() => void save()} className={btnClass("ink", "self-start")}>
        {busy ? "Saving…" : "Save my live capture"}
      </button>
      {error && <ErrorCard>{error}</ErrorCard>}
    </div>
  );
}
