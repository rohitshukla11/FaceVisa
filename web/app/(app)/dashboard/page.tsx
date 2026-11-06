"use client";

/**
 * The one dashboard, by who is signed in: a new account picks a name and Brand or Creator; a brand gets
 * its agent (brief, shortlist, requests, licences, activity); a creator gets onboarding until listed, then their
 * requests, licences and rules.
 */
import { AppPage, Card } from "@/components/ds";
import { ChooseRole, CreatorOnboarding } from "@/components/dashboard/Onboarding";
import { BrandAgentConsole } from "@/components/likeness/BrandAgentConsole";
import { CreatorHome } from "@/components/likeness/CreatorHome";
import { useAuth } from "@/components/site/Auth";
import { SignIn } from "@/components/site/SignIn";

export default function DashboardPage() {
  const { user, me, refreshMe, demo } = useAuth();
  const role = me?.account?.role;

  if (user === undefined || (user && !me)) return <AppPage title="Dashboard">{null}</AppPage>;

  if (!user) {
    return (
      <AppPage title="Dashboard" description="Sign in to license a creator as a brand, or to put your own face on Likeness.">
        <Card>
          <p className="m-0 text-[14px] text-grey">Sign in to license a creator as a brand, or to put your own face on Likeness as a creator. One account has both. Creators complete a World ID check before they&apos;re listed.</p>
          {demo && <p className="m-0 text-[14px] text-grey">This is the public demo: payments are testnet USDC, and your capture and the ads made of you are deleted after {demo.retentionHours} hours.</p>}
          <div>
            <SignIn light />
          </div>
        </Card>
      </AppPage>
    );
  }

  if (!role)
    return (
      <AppPage title="Dashboard">
        <ChooseRole onDone={refreshMe} initialName={me?.account?.name ?? ""} />
      </AppPage>
    );

  if (role === "brand") return <BrandAgentConsole me={me!} />;

  if (!me?.creator?.listing)
    return (
      <AppPage title="Become a creator" description={`${me!.account!.name} · ${me!.account!.signIn === "dev" ? "signed in with the local dev sign-in (a test identity)" : me!.account!.signIn === "google" ? "signed in with Google" : me!.account!.signIn === "demo" ? "a demo identity (a test identity)" : "signed in"}`}>
        <CreatorOnboarding me={me!} onChange={refreshMe} />
      </AppPage>
    );

  return <CreatorHome me={me} onChange={refreshMe} />;
}
