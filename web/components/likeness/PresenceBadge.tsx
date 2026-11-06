/**
 * How a creator was verified, as a badge: the World ID credential (Proof of Presence, a Selfie Check; or Proof of
 * Human, the Orb) and its environment (World ID, or World ID's sandbox, always labelled), or an unverified demo
 * creator (the public demo's listing without World ID). Nothing when Proof of Presence is off.
 */
import { StatusPill } from "@/components/ds";

const CREDENTIAL: Record<string, string> = { selfie: "Proof of Presence", proof_of_human: "Proof of Human" };
export const presenceLabel = (environment: string, credential?: string | null) => `${(credential && CREDENTIAL[credential]) || "Proof of Presence"} (World ID${environment === "production" ? "" : ` ${environment}`})`;
/** The checks a listing accepts, in words: "Proof of Presence or Proof of Human (World ID sandbox)". */
export const acceptedLabel = (environment: string) => `Proof of Presence or Proof of Human (World ID${environment === "production" ? "" : ` ${environment}`})`;
export const UNVERIFIED = "No World ID check";

export function PresenceBadge({ presence, credential }: { presence: string | null | undefined; credential?: string | null }) {
  if (presence === undefined) return null;
  if (presence === null || presence === "none")
    return (
      <StatusPill kind="neutral" title="Listed before the World ID check was required: brands' agents skip them">
        {UNVERIFIED}
      </StatusPill>
    );
  const what = credential === "proof_of_human" ? "Proof of Human (the Orb): a unique human, once per World ID" : "A Selfie Check: a real person, present, once per World ID";
  return (
    <StatusPill kind="licensed" title={presence === "production" ? what : `${what}, in World ID's ${presence} (a test identity, never production verification)`}>
      {presenceLabel(presence, credential)}
    </StatusPill>
  );
}
