"use client";

/** How FaceVisa works, in order: where the agent negotiates and where only a human can say yes. */
import { AppPage, Card } from "@/components/ds";

const FLOW = [
  ["Sign in", "One account has both a creator profile and a brand workspace. Our backend runs the whole OpenID Connect exchange and validates the token; the browser only carries our session cookie."],
  ["Creators prove they're real, then set rules", "Before a creator is listed: a World ID check through IDKit (a real person, once per World ID), and a live capture with liveness. Then a price per ad, the longest licence they allow, and the categories they refuse. Political, adult, minors, impersonation and deception are refused for everyone. There is no creator agent."],
  ["The brand's agent shortlists", "From a brief, usage, duration, maximum price and budget, the agent shortlists every listed creator with one line of why for each pick and skip."],
  ["It makes the ad, unreleased", "A request that fits the creator's rules is generated straight away (with a face check against the creator's photo), and kept private. Nothing is paid or released yet."],
  ["The creator approves the finished ad", "Signed in, only the creator sees the actual ad and approves, rejects (one new version) or denies it in FaceVisa. The approval is bound to the file's sha256, the brand, usage, duration and price, once."],
  ["Big spends need the brand's approval", "Above the workspace's limit per request, the agent pauses until the brand approves that exact amount in FaceVisa. Below it, the agent spends on its own within the daily budget."],
  ["Paid, then released", "Only an approved ad is paid for and released, once: one licence, one receipt. Deny, cancel or let it expire, and nothing is released or charged."],
  ["Anyone can verify", "Verify takes any file (hashed in your browser) and answers Licensed, Revoked, Expired or Unknown, with the creator's approval of that exact file, what made the file and the payment."],
];

export default function HowPage() {
  return (
    <AppPage title="How it works" description="Agents negotiate. Only the human consents to their face being used.">
      <ol className="m-0 grid list-none grid-cols-1 gap-[14px] p-0 sm:grid-cols-2 lg:grid-cols-4">
        {FLOW.map(([t, b], i) => (
          <li key={t} className="flex flex-col gap-2 rounded-[20px] bg-white p-[18px]">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-lime">{i + 1}</span>
            <h2 className="m-0 text-[17px] font-bold">{t}</h2>
            <p className="m-0 text-[14px] text-grey">{b}</p>
          </li>
        ))}
      </ol>
      <Card tone="ink" title="Where each check runs">
        <p className="m-0 text-[14px] text-grey-dark">
          Every check runs in our backend: the sign-in token (signature, issuer, audience, nonce), the IDKit proof (verified with World), who may
          approve each request, the approval binding at release, the budget and the spend limit. Nothing the browser says is treated as proof.
        </p>
      </Card>
    </AppPage>
  );
}
