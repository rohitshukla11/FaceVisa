import type { Metadata } from "next";
import { Poppins, Unbounded } from "next/font/google";
import { AuthProvider, DemoBanner } from "@/components/site/Auth";
import { SiteFooter } from "@/components/site/SiteFooter";
import "./globals.css";

const display = Unbounded({ subsets: ["latin"], weight: ["700", "800", "900"], variable: "--font-display-face", display: "swap" });
const body = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body-face", display: "swap" });

const TAGLINE = "License your face to AI. Only you approve each ad.";
const DESCRIPTION = `${TAGLINE} A brand's AI agent finds creators within their rules and makes the ad; the creator approves the finished ad before it is paid for and released.`;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: { default: `Likeness: ${TAGLINE}`, template: "%s · Likeness" },
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Likeness", title: `Likeness: ${TAGLINE}`, description: DESCRIPTION },
  twitter: { card: "summary", title: `Likeness: ${TAGLINE}`, description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen bg-ink font-sans text-ink">
        {/* For screen recordings on localhost: NEXT_PUBLIC_HIDE_DEV_OVERLAY=1 hides Next's dev overlay
            (its badge and issue toasts, including errors thrown by browser extensions). Dev only. */}
        {process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_HIDE_DEV_OVERLAY === "1" && <style>{"nextjs-portal{display:none!important}"}</style>}
        <a href="#main" className="sr-only z-50 rounded-full bg-lime px-5 py-3 font-semibold text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
          Skip to content
        </a>
        <AuthProvider>
          <DemoBanner />
          {children}
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
