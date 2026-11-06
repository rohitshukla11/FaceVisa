/**
 * A creator's numbers (ads approved, active licences, earned, brands), as their creator_stats entity on Arkiv holds
 * them, with that entity and their public "where is my face used" page. For the Creators page and the shortlist.
 */
import type { ArkivSync, CreatorStats } from "@/lib/facevisa";

export function CreatorStatsRow({ stats, arkiv, usagePage }: { stats?: CreatorStats | null; arkiv?: ArkivSync; usagePage?: string | null }) {
  if (!stats) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <dl className="m-0 grid grid-cols-4 gap-2 text-[13px]">
        <Tile label="Ads" value={String(stats.adsApproved)} />
        <Tile label="Active" value={String(stats.activeLicences)} />
        <Tile label="Earned" value={stats.earned} />
        <Tile label={stats.brands === 1 ? "Brand" : "Brands"} value={String(stats.brands)} />
      </dl>
      <span className="text-[12px] text-grey">
        {arkiv?.state === "synced" && arkiv.url ? (
          <a href={arkiv.url} target="_blank" rel="noreferrer" className="underline">
            Stats on Arkiv ↗
          </a>
        ) : arkiv?.state === "pending" ? (
          "Stats: updating on Arkiv…"
        ) : (
          "Stats"
        )}
        {usagePage && (
          <>
            {" · "}
            <a href={usagePage} target="_blank" rel="noreferrer" className="underline">
              Where their face is used ↗
            </a>
          </>
        )}
      </span>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[14px] bg-paper px-3 py-2">
      <dt className="text-[12px] text-grey">{label}</dt>
      <dd className="tnum m-0 truncate text-[15px] font-bold">{value}</dd>
    </div>
  );
}
