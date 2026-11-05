/**
 * Shared design-system components. Tokens live in app/globals.css; these compose them.
 * Server-safe unless noted (Reveal and the motion hooks are client components, in ./motion).
 */
import Link from "next/link";
import type { ReactNode } from "react";

// ---------------------------------------------------------------- silhouettes (no real faces)

export const SILHOUETTES = [
  { tint: "#E3E6EC", sil: "#7D838F" },
  { tint: "#F4C9D6", sil: "#C27A92" },
  { tint: "#F6D9A8", sil: "#C08A3E" },
  { tint: "#DCE8D2", sil: "#6F8E5A" },
] as const;

/** A stable silhouette palette per address, so a creator always gets the same neutral illustration. */
export function silhouetteFor(seed: string) {
  let h = 0;
  for (const c of seed.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SILHOUETTES[h % SILHOUETTES.length];
}

export function Silhouette({ fill, width = "78%", height = "92%" }: { fill: string; width?: string | number; height?: string | number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 140" width={width} height={height}>
      <circle cx="60" cy="52" r="26" fill={fill} />
      <path d="M14 140c4-34 22-52 46-52s42 18 46 52z" fill={fill} />
    </svg>
  );
}

export function Avatar({ seed, size = 52, ring }: { seed: string; size?: number; ring?: string }) {
  const s = silhouetteFor(seed);
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-end justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, background: s.tint, border: ring ? `3px solid ${ring}` : undefined }}
    >
      <Silhouette fill={s.sil} width={size * 0.88} height={size} />
    </span>
  );
}

export function Initial({ name, size = 52, dark = true }: { name: string; size?: number; dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full text-lg font-bold ${dark ? "bg-ink text-lime" : "bg-[#E3E6EC] text-grey"}`}
      style={{ width: size, height: size }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------- buttons and links (44px+ targets)

type Kind = "lime" | "ink" | "outline" | "outline-dark" | "coral" | "danger" | "ghost" | "white";
const kinds: Record<Kind, string> = {
  lime: "bg-lime text-ink hover:bg-lime-deep",
  ink: "bg-ink text-white hover:bg-[#2b2d33]",
  outline: "border border-field bg-white text-ink hover:border-grey",
  "outline-dark": "border-2 border-ink bg-transparent text-ink hover:bg-ink/5",
  coral: "bg-red text-ink hover:brightness-95",
  danger: "border border-[#E8B4B4] bg-white text-bad hover:bg-bad-bg",
  ghost: "text-grey hover:text-ink",
  white: "bg-white text-ink hover:bg-paper",
};

export function pillClass(kind: Kind = "lime", extra = "") {
  return `inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${kinds[kind]} ${extra}`;
}

export function PillButton({
  kind = "lime",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind }) {
  return <button type="button" {...rest} className={pillClass(kind, className)} />;
}

export function PillLink({ kind = "lime", className = "", href, children, ...rest }: { kind?: Kind; className?: string; href: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href} {...rest} className={pillClass(kind, className)}>
      {children}
    </Link>
  );
}

/** Compact app buttons: 44 px tall, 12 px corners. (pillClass is the landing page's rounder style.) */
export function btnClass(kind: Kind = "lime", extra = "") {
  return `inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[12px] px-4 text-[14px] font-semibold no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${kinds[kind]} ${extra}`;
}

// ---------------------------------------------------------------- pills and chips

export type PillKind = "licensed" | "revoked" | "waiting" | "expired" | "neutral" | "lime";
const pills: Record<PillKind, string> = {
  licensed: "bg-ok-bg text-ok",
  revoked: "bg-bad-bg text-bad",
  waiting: "bg-wait-bg text-wait",
  expired: "bg-[#ECEEE8] text-grey",
  neutral: "bg-[#ECEEE8] text-grey",
  lime: "bg-ink text-lime",
};

export function StatusPill({ kind, children, title }: { kind: PillKind; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${pills[kind]}`}>
      {children}
    </span>
  );
}

export function TagChip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full bg-paper px-2.5 py-1 text-[12px] font-medium text-ink">{children}</span>;
}

// ---------------------------------------------------------------- page structure

/**
 * The content area of an app page: off-white ground under the dark nav, up to 1320 px wide, 32 px side
 * padding (16 px on phones). `narrow` is the 720 px column used by the onboarding flows.
 */
export function Page({ children, narrow, className = "" }: { children: ReactNode; narrow?: boolean; className?: string }) {
  return <div className={`mx-auto flex w-full flex-col gap-[18px] px-4 pb-12 pt-6 sm:px-8 ${narrow ? "max-w-[784px]" : "max-w-[1320px]"} ${className}`}>{children}</div>;
}

/** Title (28 px), one line of description, and the page's main actions on the right. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
        <h1 className="m-0 text-[28px] font-bold leading-tight tracking-[-0.01em]">{title}</h1>
        {description && <p className="m-0 text-[14px] text-grey">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A plain app page: compact header, then content. */
export function AppPage({ title, description, actions, narrow, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; narrow?: boolean; children: ReactNode }) {
  return (
    <Page narrow={narrow}>
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </Page>
  );
}

/** A whole page that only says one thing: not found, an error, signed out. */
export function NoticePage({ title, children, action, description }: { title: string; children?: ReactNode; action?: ReactNode; description?: ReactNode }) {
  return (
    <AppPage title={title} description={description}>
      <Card>
        {children && <div className="max-w-2xl text-[15px] text-grey">{children}</div>}
        <div className="flex flex-wrap gap-2">
          {action ?? (
            <Link href="/market" className={btnClass("ink", "self-start")}>
              Browse creators
            </Link>
          )}
        </div>
      </Card>
    </AppPage>
  );
}

// ---------------------------------------------------------------- cards

type CardTone = "white" | "ink" | "lime" | "violet" | "coral" | "grey" | "lavender";
const tones: Record<CardTone, string> = {
  white: "bg-white text-ink",
  ink: "on-dark bg-ink text-white",
  lime: "bg-lime text-ink",
  violet: "bg-violet-deep text-white",
  coral: "bg-coral text-ink",
  grey: "bg-[#D9DCE2] text-ink",
  lavender: "bg-lavender text-ink",
};

/**
 * The one card: 20 px corners, 18–20 px padding. White by default; lime for the single most important
 * thing on a page, violet for at most one card, ink for secondary emphasis (terms, checklists).
 */
export function Card({
  title,
  action,
  children,
  tone = "white",
  className = "",
  id,
  as: As = "section",
  label,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  tone?: CardTone;
  className?: string;
  id?: string;
  as?: "section" | "div" | "article";
  label?: string;
}) {
  return (
    <As id={id} aria-label={label} className={`flex min-w-0 scroll-mt-6 flex-col gap-3 rounded-[20px] p-[18px] sm:px-5 ${tones[tone]} ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="m-0 text-[18px] font-bold leading-tight">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </As>
  );
}

export function StatCard({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[18px] bg-white px-[18px] py-4">
      <span className="text-[13px] text-grey">{label}</span>
      <span className="tnum text-[26px] font-bold leading-tight">{value}</span>
      {note && <span className="text-[12px] text-grey">{note}</span>}
    </div>
  );
}

/** Loading shapes in the card style. No numbers until they are real. */
export function Skeleton({ className = "h-24" }: { className?: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-[20px] bg-white motion-reduce:animate-none ${className}`} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[20px] bg-white p-[18px] sm:px-5">
      <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
      {children && <div className="text-[14px] text-grey">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/** An error, in plain words, with one way forward. */
export function ErrorCard({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[20px] bg-bad-bg p-[18px] text-[14px] text-bad sm:px-5">
      <span className="min-w-0 flex-[1_1_260px]">{children}</span>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- misc

export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-[20px] bg-white px-5 py-3 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold">
        {summary}
        <span aria-hidden="true" className="transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="mb-2 mt-3 space-y-4 text-[14px]">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- creator faces and brand chips

/** A creator's public photo (watermarked, 512 px) as a round avatar, or the neutral silhouette. */
export function CreatorFace({ seed, photo, size = 52, ring, label }: { seed: string; photo?: string | null; size?: number; ring?: string; label?: string }) {
  if (!photo) return <Avatar seed={seed} size={size} ring={ring} />;
  return (
    <span
      className="block shrink-0 overflow-hidden rounded-full bg-[#E3E6EC]"
      style={{ width: size, height: size, border: ring ? `3px solid ${ring}` : undefined }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo} alt="" width={size} height={size} className="h-full w-full object-cover object-top" />
    </span>
  );
}

/** Marks a public photo that is an AI-generated Likeness sample, not a photo. */
export function AiTag({ className = "" }: { className?: string }) {
  return (
    <span
      title="This public image is AI-generated by Likeness from the creator's own verified photos. It is not a photo."
      className={`inline-flex items-center rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-lime ${className}`}
    >
      AI-generated
    </span>
  );
}

/** A licensee as creators see it: logo, name and the server-computed badge. */
export function BrandChip({ brand, fallback }: { brand?: { name: string; logo: string | null; badge: "verified-domain" | "unverified" } | null; fallback?: string }) {
  if (!brand)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="font-semibold">{fallback ?? "Brand"}</span>
        <StatusPill kind="neutral" title="This brand has not completed a Likeness brand profile">No brand profile</StatusPill>
      </span>
    );
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      {brand.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logo} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-md bg-white object-contain" />
      ) : (
        <Initial name={brand.name} size={24} />
      )}
      <span className="font-semibold">{brand.name}</span>
      {brand.badge === "verified-domain" ? (
        <StatusPill kind="licensed" title="The brand proved a work email at its website's domain">Verified domain</StatusPill>
      ) : (
        <StatusPill kind="waiting" title="The brand has not proved a work email at its website's domain">Unverified brand</StatusPill>
      )}
    </span>
  );
}
