import { AppShell } from "@/components/site/AppState";

/** Every app page: the dark nav bar, then compact content on the off-white ground. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppShell>
        <main id="main" className="flex-1 text-ink">
          {children}
        </main>
      </AppShell>
    </div>
  );
}
