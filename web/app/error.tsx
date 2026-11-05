"use client";

import { useEffect } from "react";
import { btnClass, NoticePage } from "@/components/ds";
import { AppShell } from "@/components/site/AppState";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppShell>
      <main id="main" className="flex-1 text-ink">
        <NoticePage
          title="Something went wrong"
          description="This page could not load."
          action={
            <button type="button" onClick={() => retry()} className={btnClass("ink")}>
              Try again
            </button>
          }
        >
          This page could not load. Nothing was signed or sent. If the chain's RPC is busy, trying again in a moment usually works.
          {error.digest && <span className="mt-2 block font-mono text-[13px]">Reference: {error.digest}</span>}
        </NoticePage>
      </main>
      </AppShell>
    </div>
  );
}
