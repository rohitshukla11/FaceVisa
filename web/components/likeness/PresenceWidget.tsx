"use client";

/**
 * IDKit for one signed Proof of Presence request (loaded in the browser only). The server signed the request and
 * verifies the result: this only hands the request to World ID and passes the result on.
 * - production and sandbox: IDKit's own widget, a QR code for the World ID app on a phone (sandbox: the sandbox app
 *   from TestFlight).
 * - staging: the request's link, to copy into the World ID Simulator (simulator.worldcoin.org: "Tap the IDKit QR code
 *   to copy its link, then paste it here"). IDKit 4's widget can't copy its link, so this uses its hook instead: one
 *   request either way.
 */
import { useEffect, useRef, useState } from "react";
import { any, CredentialRequest, IDKitRequestWidget, setDebug, useIDKitRequest, type IDKitDebugReport, type IDKitErrorCodes, type IDKitResult } from "@worldcoin/idkit";
import { btnClass } from "@/components/ds";

export interface PresenceRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  credentials?: ("selfie" | "proof_of_human")[];
  signal: string;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
}

/**
 * The credentials the server asked for: Selfie Check or Proof of Human (production), or Proof of Human alone (World's
 * sandbox, whose app stalls on any request that includes Selfie Check). The server checks which came back and labels it.
 */
const constraints = (signal: string, credentials: PresenceRequest["credentials"]) => {
  const asks = (credentials?.length ? credentials : (["selfie", "proof_of_human"] as const)).map((c) => CredentialRequest(c, { signal }));
  return asks.length === 1 ? asks[0]! : any(...asks);
};

type Props = { request: PresenceRequest; onOpenChange: (open: boolean) => void; verify: (result: IDKitResult) => Promise<void>; onSuccess: () => void; onError: (code: IDKitErrorCodes) => void };

export default function PresenceWidget(props: Props) {
  const { request, onOpenChange, verify, onSuccess, onError } = props;
  // Test environments only: IDKit's debug logging in the browser console (its bridge steps), for the debrief.
  const test = request.environment !== "production";
  useEffect(() => {
    if (test) setDebug(true);
  }, [test]);
  if (request.environment === "staging") return <SimulatorLink {...props} />;
  return (
    <IDKitRequestWidget
      open
      onOpenChange={onOpenChange}
      app_id={request.app_id}
      action={request.action}
      rp_context={request.rp_context}
      environment={request.environment}
      allow_legacy_proofs={false}
      constraints={constraints(request.signal, request.credentials)}
      handleVerify={verify}
      onSuccess={onSuccess}
      onError={(code: IDKitErrorCodes, report?: IDKitDebugReport) => {
        if (test) console.info("[IDKit debug report]", code, JSON.stringify(report ?? null));
        onError(code);
      }}
    />
  );
}

/** Staging: the request's link to paste into the World ID Simulator, with its state, until a result or an error. */
function SimulatorLink({ request, onOpenChange, verify, onSuccess, onError }: Props) {
  const r = useIDKitRequest({ app_id: request.app_id, action: request.action, rp_context: request.rp_context, environment: request.environment, allow_legacy_proofs: false, constraints: constraints(request.signal, request.credentials) });
  const [copied, setCopied] = useState(false);
  const handled = useRef(false);
  // Opened once: a second open() would start a second request.
  const started = useRef(false);
  const { open } = r;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open();
  }, [open]);
  useEffect(() => {
    if (handled.current) return;
    if (r.isSuccess && r.result) {
      handled.current = true;
      verify(r.result).then(onSuccess, () => onOpenChange(false));
    } else if (r.isError && r.errorCode) {
      handled.current = true;
      onError(r.errorCode);
    }
  }, [r.isSuccess, r.result, r.isError, r.errorCode, verify, onSuccess, onError, onOpenChange]);
  const copy = async () => {
    if (!r.connectorURI) return;
    try {
      await navigator.clipboard.writeText(r.connectorURI);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-field p-3 text-[14px]">
      <b>World ID staging: the Simulator</b>
      <span className="text-grey">Copy this link, then paste it at simulator.worldcoin.org. It&apos;s a test proof from the Simulator, not real verification.</span>
      <input readOnly className="w-full rounded-[10px] border border-field bg-paper px-2 py-1.5 font-mono text-[12px]" value={r.connectorURI ?? "Preparing the request…"} onFocus={(e) => e.currentTarget.select()} aria-label="The IDKit link" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnClass("ink", "min-h-9")} disabled={!r.connectorURI} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy the link"}
        </button>
        <a className={btnClass("outline", "min-h-9")} href="https://simulator.worldcoin.org/" target="_blank" rel="noreferrer">
          Open the Simulator
        </a>
        <button type="button" className={btnClass("ghost", "min-h-9")} onClick={() => (r.reset(), onError("cancelled" as IDKitErrorCodes))}>
          Cancel
        </button>
      </div>
      <span className="text-[13px] text-grey">{r.isAwaitingUserConfirmation ? "The Simulator has the request: confirm it there." : r.isAwaitingUserConnection ? "Waiting for the Simulator…" : r.isSuccess ? "Checking the proof…" : ""}</span>
    </div>
  );
}
