"use client";

/**
 * Top right of every page: the ways to sign in, or the signed-in account (its role, a link to set it
 * up) and Sign out. After a sign-in that didn't complete, says why (the callback's ?signin=…).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { btnClass, pillClass } from "@/components/ds";
import { post } from "@/lib/api";
import { SignInChoice, useAuth } from "./Auth";

/** What /api/auth/callback reports when there's no session. Nothing here comes from the provider's response text. */
export const SIGNIN_NOTICES: Record<string, string> = {
  cancelled: "Sign-in cancelled. Nothing was shared; you can try again.",
  failed: "Sign-in didn't complete. Please try again.",
  invalid: "That sign-in couldn't be verified or was already used. Please sign in again.",
  expired: "That sign-in took too long and expired. Please sign in again.",
  unavailable: "That sign-in isn't available on this server.",
  limit: "This network has made its new accounts for today. Try again tomorrow, or sign in with an account you already have.",
};

export function SignIn({ light = false }: { light?: boolean }) {
  const { user, me, signIn, signOut, refreshMe } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [notice, setNotice] = useState<string | null>(null);

  // Show the callback's outcome once, then drop it from the address bar.
  useEffect(() => {
    const u = new URL(window.location.href);
    const why = u.searchParams.get("signin");
    if (!why) return;
    setNotice(SIGNIN_NOTICES[why] ?? SIGNIN_NOTICES.failed!);
    u.searchParams.delete("signin");
    window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
  }, []);

  if (user === undefined) return null;

  if (!user)
    return (
      <span className="flex items-center gap-2">
        {notice && (
          <span role="alert" className={`max-w-[18rem] text-[13px] ${light ? "text-bad" : "text-coral"}`}>
            {notice}
          </span>
        )}
        <SignInChoice className={light ? pillClass("ink", "px-5 text-[14px]") : btnClass("lime", "min-h-10")} demoClassName={light ? pillClass("ink", "px-5 text-[14px] opacity-90") : btnClass("white", "min-h-10")} />
      </span>
    );

  const role = me?.account?.role;
  // Each workspace lives on the dashboard: switching from another page (a request, a spend) goes there.
  const switchTo = async (to: "creator" | "brand") => {
    await post("/api/me/role", { role: to });
    await refreshMe();
    if (path !== "/dashboard") router.push("/dashboard");
  };
  const text = light ? "text-ink" : "text-white";
  const name = user.name || "Your account";
  return (
    <span className="flex items-center gap-3">
      <Link href="/dashboard" className={`flex items-center gap-2 no-underline ${text}`} title="Signed in">
        <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-lime text-[14px] font-bold text-ink">
          {name.slice(0, 1)}
        </span>
        <span className="flex flex-col leading-tight">
          <span className="max-w-[10rem] truncate text-[14px] font-semibold">{name}</span>
          <span className={`text-[12px] ${light ? "text-grey" : "text-grey-dark"}`}>{role === "brand" ? "Brand workspace" : role === "creator" ? (me?.creator?.listing ? "Creator profile" : "Creator: finish setup") : "Set up your account"}</span>
        </span>
      </Link>
      {role && (
        <span role="group" aria-label="Workspace" className={`hidden items-center rounded-full p-0.5 text-[13px] sm:flex ${light ? "bg-paper" : "bg-white/10"}`}>
          {(["creator", "brand"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={role === r}
              onClick={() => void switchTo(r)}
              className={`rounded-full px-3 py-1 font-semibold ${role === r ? "bg-lime text-ink" : light ? "text-grey" : "text-grey-dark hover:text-white"}`}
            >
              {r === "creator" ? "Creator" : "Brand"}
            </button>
          ))}
        </span>
      )}
      <button type="button" className={light ? pillClass("outline-dark", "min-h-9 px-4 text-[13px]") : btnClass("ghost", "min-h-9 text-grey-dark hover:text-white")} onClick={() => void signOut()}>
        Sign out
      </button>
    </span>
  );
}
