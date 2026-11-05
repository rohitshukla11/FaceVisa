"use client";

/** Every app page: the dark header (destinations, sign-in, the workspace switch), then the page. */
import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="bg-ink text-white">
        <AppHeader />
      </div>
      {children}
    </>
  );
}
