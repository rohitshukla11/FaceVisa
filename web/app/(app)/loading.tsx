import { Page, Skeleton } from "@/components/ds";

/** Shown while a server page reads the chain. Shapes only; no numbers until they are real. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <Page>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-[18px] desk:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </Page>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
