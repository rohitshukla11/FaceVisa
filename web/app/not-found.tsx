import type { Metadata } from "next";
import Link from "next/link";
import { btnClass, NoticePage } from "@/components/ds";
import { AppShell } from "@/components/site/AppState";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppShell>
      <main id="main" className="flex-1 text-ink">
        <NoticePage
          title="Nothing here"
          description="Page not found (404)"
          action={
            <>
              <Link href="/creators" className={btnClass("ink")}>
                Browse creators
              </Link>
              <Link href="/" className={btnClass("outline")}>
                Home
              </Link>
            </>
          }
        >
          That page does not exist. If you followed a link to a creator or a licence, check the address.
        </NoticePage>
      </main>
      </AppShell>
    </div>
  );
}
