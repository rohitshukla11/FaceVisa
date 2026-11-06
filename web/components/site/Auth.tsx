"use client";

/**
 * The signed-in account, shared by every page. Sign-in runs entirely in our backend (/api/auth/login → the provider →
 * /api/auth/callback): the browser only follows redirects and carries our HttpOnly session cookie, so no token or
 * secret ever reaches this code. /api/me says who is signed in. The ways in, as the backend says (/api/facevisa):
 * Sign in with Google (GOOGLE_SIGNIN=1; on the public demo it replaces the demo identities), the local dev sign-in
 * (local development only), and World ID sign-in only when the backend has WORLDID_SIGNIN=1 (off by default: World ID
 * appears only as the IDKit check before a creator lists).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "@/lib/api";

type Account = NonNullable<Me["account"]>;
/** The public demo, when the backend runs it: its limits. */
export type DemoMode = { retentionHours: number } | null;
/** The ways to sign in on this server. */
type Ways = { worldId: boolean; dev: boolean; google: boolean; demo: boolean };
type AuthValue = {
  /** undefined while /api/me loads; null when nobody is signed in. */
  user: Account | null | undefined;
  me: Me | null;
  refreshMe: () => Promise<Me | null>;
  /** The server's sign-in (the dev sign-in, or World ID when it's on), or ("demo") the public demo's identities. */
  signIn: (via?: "demo" | "google") => void;
  signOut: () => Promise<void>;
  /** undefined while it loads; null when this isn't the public demo. */
  demo: DemoMode | undefined;
  ways: Ways;
};

const Ctx = createContext<AuthValue>({ user: null, me: null, refreshMe: async () => null, signIn: () => {}, signOut: async () => {}, demo: null, ways: { worldId: false, dev: false, google: false, demo: false } });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const refreshMe = useCallback(async () => {
    const m = await api<Me>("/api/me").catch(() => null);
    setMe(m?.account ? m : null);
    return m?.account ? m : null;
  }, []);
  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);
  const [demo, setDemo] = useState<DemoMode | undefined>(undefined);
  const [ways, setWays] = useState<Ways>({ worldId: false, dev: false, google: false, demo: false });
  useEffect(() => {
    void api<{ publicDemo?: { retentionHours: number } | null; worldIdSignIn?: boolean; devSignIn?: boolean; googleSignIn?: boolean; demoSignIn?: boolean }>("/api/facevisa").then(
      (m) => {
        setDemo(m.publicDemo ? { retentionHours: m.publicDemo.retentionHours } : null);
        setWays({ worldId: !!m.worldIdSignIn, dev: !!m.devSignIn, google: !!m.googleSignIn, demo: !!m.demoSignIn });
      },
      () => setDemo(null),
    );
  }, []);

  // A full-page navigation: our backend starts the attempt and redirects to the provider.
  const signIn = useCallback((via?: "demo" | "google") => {
    const here = `${window.location.pathname}${window.location.search}`.replace(/[?&]signin=[^&]*/, "");
    window.location.assign(`/api/auth/login?${via ? `via=${via}&` : ""}return=${encodeURIComponent(here.startsWith("/dashboard") || here === "/" ? "/dashboard" : here)}`);
  }, []);
  const signOut = useCallback(async () => {
    await api("/api/auth/logout", {}).catch(() => undefined);
    setMe(null);
  }, []);

  const user = me === undefined ? undefined : (me?.account ?? null);
  return <Ctx.Provider value={{ user, me: me ?? null, refreshMe, signIn, signOut, demo, ways }}>{children}</Ctx.Provider>;
}

/** The ways in: the public demo's identities, the local dev sign-in, and World ID sign-in only when the server has it on. */
export function SignInChoice({ className, demoClassName }: { className: string; demoClassName?: string }) {
  const { ways, signIn } = useAuth();
  return (
    <>
      {ways.google && (
        <button type="button" className={className} onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      )}
      {ways.demo && (
        <button type="button" className={className} onClick={() => signIn("demo")} title="A test identity">
          Try the demo (test identity)
        </button>
      )}
      {ways.dev && (
        <button type="button" className={ways.google || ways.demo ? (demoClassName ?? className) : className} onClick={() => signIn()} title="Local development only">
          Dev sign-in
        </button>
      )}
      {ways.worldId && (
        <button type="button" className={ways.google || ways.demo || ways.dev ? (demoClassName ?? className) : className} onClick={() => signIn()}>
          Sign in with World ID
        </button>
      )}
    </>
  );
}

export const useAuth = () => useContext(Ctx);
