"use client";

/**
 * Proof of Presence before listing: World ID's Selfie Check (liveness and face similarity in the World ID app; no Orb
 * needed). One World ID lists one FaceVisa profile. The server signs the request and verifies the result; a cancel or
 * a failure changes nothing.
 */
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { btnClass, ErrorCard } from "@/components/ds";
import type { Me } from "@/lib/api";
import { postJson, when } from "@/lib/facevisa";
import type { PresenceRequest } from "./PresenceWidget";

const PresenceWidget = dynamic(() => import("./PresenceWidget"), { ssr: false });

/** One World ID, one listing: the World ID app or our server says this person already used the once-only action. */
const ALREADY = "This World ID has already completed the World ID check for FaceVisa: it's already listed under another account. One World ID lists one profile. Sign in with that account instead.";
/** Our server's refusals after the World ID app finished, in words. */
const SERVER: Record<string, string> = {
  nullifier_used: ALREADY,
  verification_failed: "World ID couldn't verify that proof. Nothing changed: try again.",
  expired: "That check took too long. Nothing changed: start again.",
  wrong_signal: "That proof was made for another account. Nothing changed.",
};

/** What each IDKit outcome means for the creator, in words. */
const OUTCOME: Record<string, string> = {
  user_rejected: "You cancelled in the World ID app. Nothing changed.",
  cancelled: "You closed the check. Nothing changed.",
  closed: "You closed the check. Nothing changed.",
  timeout: "That took too long. Start again.",
  credential_unavailable: "Your World ID app doesn't have the credential this check asks for yet. Complete what it asks for, then try again.",
  feature_unavailable: "Your World ID app can't do this check yet. Update it, then try again.",
  world_id_4_not_available: "Your World ID app needs an update for World ID 4.0.",
  max_verifications_reached: ALREADY,
  nullifier_replayed: ALREADY,
  connection_failed: "Couldn't reach your World ID app. Try again.",
  user_presence_failed: "The presence check in the World ID app didn't pass. Try again.",
};

export function PresenceCard({ me, onChange }: { me: Me; onChange: () => Promise<unknown> }) {
  // The account's check: one per account, for its creator profile and its brand workspace alike.
  const p = me.presence ?? me.creator?.presence;
  const [request, setRequest] = useState<PresenceRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // What the server said about the proof (verified, or held for review), for the message once IDKit closes.
  const outcome = useRef<"verified" | "review" | null>(null);
  if (!p?.required) return null;
  // Sandbox and staging proofs are test identities: never presented as World ID verification.
  const test = p.environment && p.environment !== "production" ? p.environment : null;
  if (p.verified)
    return (
      <p className="m-0 text-[14px]">
        ✓ {p.credential === "proof_of_human" ? "Proof of Human (the Orb)" : "Proof of Presence"} {test ? <b className="text-wait">from World ID&apos;s {test} (a test identity, not production verification)</b> : "with World ID"}
        {p.verifiedAt ? `, ${when(p.verifiedAt)}` : ""}
        {p.sybilScore !== null && p.sybilScore !== undefined ? ` (risk signal ${p.sybilScore} of 10)` : ""}.
      </p>
    );
  // A risk signal above the limit isn't a refusal: World calls it "a risk signal, not a uniqueness verdict".
  if (p.state === "review")
    return (
      <div role="status" className="rounded-[16px] bg-wait-bg p-4 text-[14px] text-wait">
        <b>Under review.</b> Your Proof of Presence went through{p.verifiedAt ? ` (${when(p.verifiedAt)})` : ""}, and World ID gave it a risk signal of {p.sybilScore} of 10, above this site&apos;s limit of {p.maxSybilScore}. That&apos;s not a refusal: a person at FaceVisa reviews it, and you can list once it&apos;s cleared. Nothing else is needed from you.
      </div>
    );
  if (p.state === "rejected")
    return <ErrorCard>Your Proof of Presence wasn&apos;t cleared in review, so this World ID can&apos;t list a profile on FaceVisa.</ErrorCard>;

  const start = async () => {
    outcome.current = null;
    setBusy(true);
    setNotice(null);
    try {
      setRequest(await postJson<PresenceRequest>("/api/facevisa/creator/presence/start", {}));
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {test && (
        <p role="note" className="m-0 rounded-[12px] bg-wait-bg p-3 text-[13px] text-wait">
          <b>Test identities only.</b> This server uses World ID&apos;s {test}
          {test === "sandbox" ? ": scan with the sandbox World ID app (TestFlight), not the regular one." : ": paste the link into the World ID Simulator."}{" "}
          {`Your badge says "World ID ${test}" everywhere, and a ${test} proof never counts as production World ID.`}
        </p>
      )}
      <p className="m-0 text-[14px] text-grey">
        {test === "sandbox" ? (
          <>
            Show you&apos;re a real person with World ID (once per account: it covers your creator profile and your brand workspace). <b>In World ID&apos;s sandbox you share Proof of Human</b> from the sandbox app: its selfie check (Proof of Presence) isn&apos;t available there yet. On the real site the selfie check comes first (no Orb needed).
          </>
        ) : (
          <>Before you list, show you&apos;re a real person who is present: a short selfie check in the World ID app (no Orb needed). Already verified with the Orb? That works too.</>
        )} Scan the code with your phone. One World ID lists one FaceVisa profile; your selfie stays in the World ID app.
      </p>
      <button type="button" disabled={busy || !!request} onClick={() => void start()} className={btnClass("ink", "self-start")}>
        {busy ? "Preparing…" : request ? "Waiting for the World ID app…" : test === "sandbox" ? "Share Proof of Human with World ID (sandbox)" : "Prove you're present with World ID"}
      </button>
      {notice && (notice.ok ? <p className="m-0 text-[14px] text-ok">{notice.text}</p> : <ErrorCard>{notice.text}</ErrorCard>)}
      {request && (
        <PresenceWidget
          request={request}
          onOpenChange={(open) => {
            if (open) return;
            // Closed without a result (the widget's ×): recorded as an end, like a cancel in the World ID app.
            if (!outcome.current) void postJson("/api/facevisa/creator/presence/cancel", { nonce: request.rp_context.nonce, code: "closed" }).catch(() => undefined);
            setRequest(null);
          }}
          verify={async (result) => {
            // The server checks it against the request it signed and asks World. A refusal is shown here in our
            // words (IDKit shows only a generic failure), then rethrown so IDKit ends.
            try {
              const r = await postJson<{ presence: { state: "verified" | "review" } }>("/api/facevisa/creator/presence/verify", { result });
              outcome.current = r.presence.state;
            } catch (e) {
              const code = (e as { code?: string }).code;
              setNotice({ ok: false, text: (code && SERVER[code]) || (e as Error).message });
              void onChange();
              throw e;
            }
          }}
          onSuccess={() => {
            setRequest(null);
            setNotice(outcome.current === "review" ? { ok: false, text: "Your Proof of Presence went through and is held for review (a high risk signal). You can list once a person clears it." } : { ok: true, text: "World ID check done. You can list yourself now." });
            void onChange();
          }}
          onError={(code) => {
            void postJson("/api/facevisa/creator/presence/cancel", { nonce: request.rp_context.nonce, code }).catch(() => undefined);
            setRequest(null);
            setNotice({ ok: false, text: OUTCOME[code] ?? `The check didn't complete (${code}). Nothing changed.` });
          }}
        />
      )}
    </div>
  );
}
