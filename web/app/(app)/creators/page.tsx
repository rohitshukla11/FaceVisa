"use client";

/**
 * Every listed creator: their face (to signed-in accounts), price per image and video, the longest licence they allow,
 * the categories they refuse, their World ID check and their listing on Arkiv. Brands ask for ads from their workspace.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { btnClass, ErrorCard, Page, StatusPill } from "@/components/ds";
import { CreatorFace } from "@/components/facevisa/CreatorFace";
import { PresenceBadge } from "@/components/facevisa/PresenceBadge";
import { useAuth } from "@/components/site/Auth";
import { SignIn } from "@/components/site/SignIn";
import { post } from "@/lib/api";
import { getJson, type CreatorCard } from "@/lib/facevisa";

const SURFACE = "rounded-[22px] bg-white text-ink ring-1 ring-black/[0.04]";
const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold";

export default function CreatorsPage() {
  const { user, me, refreshMe } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<{ creators: CreatorCard[]; signedIn: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  useEffect(() => {
    getJson<{ creators: CreatorCard[]; signedIn: boolean }>("/api/facevisa/creators").then(setData, (e) => setError((e as Error).message));
  }, [user]);

  // Ask for an ad: the brand workspace (one account has both; switch to it if needed).
  const toBrand = async () => {
    setGoing(true);
    try {
      if (me?.account?.role !== "brand") {
        await post("/api/me/role", { role: "brand" });
        await refreshMe();
      }
      router.push("/dashboard");
    } finally {
      setGoing(false);
    }
  };
  const creators = data?.creators ?? [];
  const checked = creators.filter((c) => c.presence).length;

  return (
    <div className="min-h-[70vh]">
      <Page>
        <section className={`${SURFACE} flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6`} aria-label="Creators">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-grey">Listed on FaceVisa</span>
            <h1 className="m-0 font-display text-[clamp(26px,4vw,36px)] font-extrabold leading-[1.05] tracking-[-0.01em]">Creators</h1>
            <p className="m-0 max-w-[640px] text-[14px] text-grey">
              People who license their face for AI ads, on their own terms: a price, the longest licence, and the categories they refuse. Nothing is released until they approve the finished ad.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`${CHIP} bg-lime text-ink`}>{creators.length} listed</span>
            {creators.some((c) => c.presence !== undefined) && <span className={`${CHIP} bg-sky text-ink`}>{checked} with a World ID check</span>}
          </div>
        </section>

        {error && <ErrorCard>{error}</ErrorCard>}
        {data && !data.signedIn && (
          <section className={`${SURFACE} flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between`} aria-label="Sign in">
            <span className="text-[14px] text-grey">Sign in to see creators&apos; faces and ask for an ad.</span>
            <SignIn light />
          </section>
        )}

        {!data && !error ? (
          <p className="m-0 text-[14px] text-grey">Loading creators…</p>
        ) : creators.length ? (
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {creators.map((c) => (
              <li key={c.uid} className={`${SURFACE} flex flex-col overflow-hidden`}>
                <div className="relative aspect-[4/3] w-full bg-paper">
                  <CreatorFace face={c.face} name={c.name} size="fill" rounded="rounded-none" className="absolute inset-0" />
                  {c.self && <span className={`absolute left-3 top-3 ${CHIP} bg-lime text-ink`}>You</span>}
                </div>
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div className="flex flex-col gap-1.5">
                    <b className="text-[17px] leading-snug">{c.name}</b>
                    <div className="flex flex-wrap gap-1.5">
                      {c.presence !== undefined && <PresenceBadge presence={c.presence ?? null} credential={c.credential ?? undefined} />}
                      {c.arkiv.state === "synced" && c.arkiv.url ? (
                        <a href={c.arkiv.url} target="_blank" rel="noreferrer" className={`${CHIP} bg-sky text-ink no-underline hover:underline`}>
                          On Arkiv ↗
                        </a>
                      ) : null}
                      {c.seeded && <StatusPill kind="neutral" title="Nobody can sign in as a seeded demo creator, so requests to them go unanswered">Demo creator</StatusPill>}
                    </div>
                  </div>
                  <dl className="m-0 grid grid-cols-3 gap-2 text-[13px]">
                    <Fact label="Image" value={c.image} />
                    <Fact label="Video" value={c.video} />
                    <Fact label="Up to" value={`${c.maxDays} days`} />
                  </dl>
                  <span className="text-[13px] text-grey">{c.refuses.length ? `Refuses: ${c.refuses.join(", ")}` : "Refuses nothing beyond the platform's rules"}</span>
                  <span className="text-[12px] text-grey">Listed {new Date(c.listedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}</span>
                  {data?.signedIn && !c.self && !c.seeded && (
                    <button type="button" disabled={going} onClick={() => void toBrand()} className={btnClass("lime", "mt-auto min-h-10 self-start")}>
                      {going ? "Opening…" : "Ask for an ad"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <section className={`${SURFACE} flex flex-col items-start gap-2 p-5`}>
            <b className="text-[15px]">No creators listed yet</b>
            <span className="text-[14px] text-grey">
              Be the first: <Link href="/dashboard" className="underline">set up your creator profile</Link>.
            </span>
          </section>
        )}
      </Page>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[14px] bg-paper px-3 py-2">
      <dt className="text-[12px] text-grey">{label}</dt>
      <dd className="tnum m-0 truncate text-[15px] font-bold">{value}</dd>
    </div>
  );
}
