"use client";

/**
 * The landing page (Main.dc.html): lime hero with dropping nav and headline, a rising portrait
 * and two endless ribbons; the "Built on" strip; the dark benefits block with counters;
 * the four-step accordion; the tilted, overlapping creator cards; the testimonial marquee (only with real quotes);
 * the CTA band. Motion is CSS plus an IntersectionObserver hook, and static under reduced motion.
 */
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { pillClass } from "@/components/ds";
import { IconArrowLeft, IconArrowRight, IconChevron } from "@/components/ds/icons";
import { useCountUp, useInView } from "@/components/ds/motion";
import { SignIn } from "@/components/site/SignIn";
import { BUILT_ON, MEASUREMENTS, TESTIMONIALS } from "@/lib/site-content";


const RIBBON_A = ["Advertising", "✳", "Social", "✳", "Editorial", "✳", "Entertainment", "✳", "Product", "✳"];
const RIBBON_B = ["Agents negotiate", "✳", "Only you approve your face", "✳", "A World ID check before listing", "✳", "Verify any file", "✳"];

export function Landing() {
  return (
    <main id="main" className="bg-ink font-sans text-ink">
      <Hero />
      <Stats />
      <HowItWorks />
      <Creators />
      <Quotes />
    </main>
  );
}

// ---------------------------------------------------------------- hero

function Ribbon({ words, dir, className, style }: { words: string[]; dir: "l" | "r"; className: string; style: React.CSSProperties }) {
  const all = [...words, ...words, ...words, ...words];
  return (
    <div aria-hidden="true" className={`absolute left-[calc(50%-50vw-80px)] right-[calc(50%-50vw-80px)] overflow-hidden py-2.5 sm:py-3 ${className}`} style={style}>
      <div className={`${dir === "l" ? "lk-track-l" : "lk-track-r"} whitespace-nowrap text-[clamp(14px,1.5vw,19px)] font-semibold`}>
        {all.map((w, i) => (
          <span key={i} className={w === "✳" ? "px-6 sm:px-9" : ""}>
            {w}
          </span>
        ))}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-[linear-gradient(160deg,#D4F06A_0%,#E4F7A0_38%,#F2FAD6_100%)]">
      <svg aria-hidden="true" viewBox="0 0 1440 900" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <g fill="none" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="34" strokeLinecap="round">
          <path d="M760 -40 C 940 120, 1180 160, 1500 120" />
          <path d="M820 120 C 1000 260, 1240 300, 1520 260" strokeOpacity="0.35" />
          <path d="M-60 560 C 200 470, 420 520, 600 640" strokeOpacity="0.3" />
        </g>
      </svg>

      <header className="lk-drop relative mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-7 gap-y-1 px-4 py-4 sm:px-8 sm:py-5">
        <Link href="/" className="font-display text-[18px] font-black tracking-[0.02em] text-ink no-underline sm:text-[20px]">
          FACEVISA
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full flex-wrap gap-x-4 text-[13px] font-medium sm:gap-x-7 sm:text-[14px] md:order-none md:w-auto md:flex-1">
          <a href="#how" className="py-3 text-ink no-underline hover:underline">
            How it works
          </a>
          <Link href="/creators" className="py-3 text-ink no-underline hover:underline">
            Creators
          </Link>
          <Link href="/how" className="py-3 text-ink no-underline hover:underline">
            For AI agents
          </Link>
          <Link href="/verify" className="py-3 text-ink no-underline hover:underline">
            Verify
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <SignIn light />
        </div>
      </header>

      <div className="relative mx-auto h-[330px] max-w-[1320px] px-4 sm:h-[600px] sm:px-8">
        <h1 className="lk-drop relative z-0 m-0 pt-3 text-center font-display text-[clamp(32px,9.6vw,146px)] font-black leading-[0.92] tracking-[-0.02em] text-ink">
          <span className="lk-texture">YOUR FACE</span>
          <br />
          YOUR TERMS
        </h1>
        <div
          aria-hidden="true"
          className="lk-rise absolute left-1/2 top-[58px] h-[230px] w-[164px] [mask-image:linear-gradient(to_bottom,#000_92%,transparent)] sm:top-[128px] sm:h-[412px] sm:w-[294px]"
          style={{ transform: "translateX(-50%)" }}
        >
          <Image src="/landing/hero-cutout.webp" alt="" fill priority sizes="(min-width: 640px) 300px, 170px" className="object-contain object-bottom" />
        </div>
        <Ribbon words={RIBBON_A} dir="l" className="top-[236px] z-10 bg-violet text-white sm:top-[476px]" style={{ transform: "rotate(4deg)" }} />
        <Ribbon words={RIBBON_B} dir="r" className="top-[266px] z-10 bg-[#4C5230] text-white sm:top-[514px]" style={{ transform: "rotate(-3deg)" }} />
      </div>

      <div className="relative mx-auto flex max-w-[1180px] flex-wrap items-center justify-center gap-x-[clamp(24px,4.4vw,64px)] gap-y-3 px-4 pb-8 pt-12 text-[clamp(15px,1.4vw,18px)] font-semibold text-[#5F636B] sm:px-8">
        <span className="text-[13px] font-medium text-[#5F636B]">Built on</span>
        {BUILT_ON.map((b) => (
          <span key={b}>{b}</span>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- dark benefits block

function Toggle() {
  return (
    <span aria-hidden="true" className="inline-flex h-[42px] w-[96px] items-center gap-1 rounded-full bg-[linear-gradient(90deg,#8B5CF6,#7CC4F0)] px-1">
      <span className="h-[34px] w-[34px] rounded-full bg-[#ECE6FD]" />
      <span className="h-[34px] w-[34px] rounded-full bg-[#CFE6F5]" />
    </span>
  );
}

function Stats() {
  const { ref, seen } = useInView<HTMLDivElement>();
  const ms = useCountUp(MEASUREMENTS.registerMs.value ?? 0, seen);
  const pct = useCountUp(MEASUREMENTS.rendersWithReceipt.value, seen);
  return (
    <section className="on-dark bg-ink text-white">
      <div ref={ref} className="mx-auto flex max-w-[1180px] flex-col gap-10 px-4 py-24 sm:px-8">
        <h2 className={`rv${seen ? " in" : ""} m-0 flex flex-wrap items-center gap-x-4 font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-[1.15] tracking-[-0.01em]`}>
          LICENSE REAL FACES,
          <br />
          WITH
          <span className={`pop${seen ? " in" : ""}`}>
            <Toggle />
          </span>
          CONSENT ATTACHED
        </h2>
        <div className="flex flex-wrap gap-5">
          <article className={`rv${seen ? " in" : ""} relative flex min-h-[340px] min-w-0 flex-[2_1_560px] flex-col gap-4 overflow-hidden rounded-[30px] bg-[linear-gradient(135deg,#E2D8FF_0%,#F3EFFF_60%,#FFFFFF_100%)] p-8 text-ink`} style={{ transitionDelay: ".1s" }}>
            <span aria-hidden="true" className="flex h-[42px] w-[72px] items-center gap-1 rounded-full border-2 border-ink px-1">
              <span className="h-8 w-8 rounded-full bg-ink" />
              <span className="h-8 w-8 rounded-full border-2 border-ink bg-lime" />
            </span>
            <div aria-hidden="true" className="absolute right-10 top-10 hidden h-[230px] w-[260px] sm:block">
              <span className="absolute left-5 top-2.5 h-[86px] w-[86px] overflow-hidden rounded-full border-4 border-white">
                <Image src="/landing/avatar-1.png" alt="" fill sizes="86px" className="scale-[1.06] object-cover" />
              </span>
              <span className="absolute left-[70px] top-24 h-1 w-[120px] origin-left rotate-[38deg] rounded bg-violet" />
              <span className="absolute bottom-0 right-2.5 h-24 w-24 overflow-hidden rounded-full border-4 border-white">
                <Image src="/landing/avatar-2.png" alt="" fill sizes="96px" className="scale-[1.06] object-cover" />
              </span>
            </div>
            <span className="mt-auto self-start rounded-full bg-violet-deep px-3.5 py-1.5 text-[13px] font-semibold text-white">For brands</span>
            <h3 className="m-0 font-display text-[clamp(20px,2.4vw,26px)] font-extrabold">AGENTS NEGOTIATE. HUMANS CONSENT.</h3>
            <p className="m-0 max-w-[460px] text-[15px] leading-relaxed text-[#3E4148]">
              A brand&apos;s agent finds creators within their rules and makes the ad. Nothing is released until the creator approves that exact ad
              in FaceVisa; big spends need the brand&apos;s own approval too.
            </p>
          </article>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
            {MEASUREMENTS.registerMs.value !== null && (
              <article className={`rv${seen ? " in" : ""} flex flex-1 flex-col gap-1.5 rounded-[30px] bg-lime bg-[url(/landing/card-lime.png)] bg-cover bg-center p-7 text-ink`} style={{ transitionDelay: ".25s" }} title={MEASUREMENTS.registerMs.source}>
                <span className="tnum font-display text-[clamp(40px,5vw,52px)] font-black leading-none">{ms} MS</span>
                <span className="font-display text-[17px] font-bold leading-snug">TO LIST A CREATOR</span>
                <span className="text-[13px] text-[#3E4148]">Measured end to end.</span>
              </article>
            )}
            <article className={`rv${seen ? " in" : ""} flex flex-1 flex-col gap-1.5 rounded-[30px] bg-ink-line p-7 text-white`} style={{ transitionDelay: ".4s" }} title={MEASUREMENTS.rendersWithReceipt.source}>
              <span className="tnum font-display text-[clamp(40px,5vw,52px)] font-black leading-none text-lime">{pct}%</span>
              <span className="font-display text-[17px] font-bold leading-snug">OF RENDERS CARRY A RECEIPT</span>
              <span className="text-[13px] text-grey-dark">By design: no recorded payment, no receipt, no file.</span>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- how it works

const STEPS = [
  { title: "SET YOUR RULES", body: "A World ID check first: a real person, once per World ID. Then your price per ad, the longest licence you allow and the categories you refuse. Political, adult, minors, impersonation and deception are refused for everyone." },
  { title: "AGENTS NEGOTIATE", body: "A brand's agent shortlists creators within their rules, with a reason for each pick, and makes the ad. It stays private: nothing is released yet." },
  { title: "YOU APPROVE THE AD", body: "You see the finished ad and approve it in FaceVisa, bound to that exact file, brand, use, duration and price. Or reject it, once, for a new version." },
  { title: "PAID, THEN RELEASED", body: "Only an approved ad is paid for and released, with a receipt anyone can verify. Revoke any time and Verify says so." },
];

function HowItWorks() {
  const [open, setOpen] = useState(0);
  const { ref, seen } = useInView<HTMLDivElement>();
  const c = (k: string) => `${k}${seen ? " in" : ""}`;
  return (
    <section id="how" className="scroll-mt-4 overflow-hidden bg-white">
      <div ref={ref} className="mx-auto flex max-w-[1180px] flex-col gap-12 px-4 py-24 sm:px-8">
        <h2 className="m-0 text-center font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-[1.2] tracking-[-0.01em]">
          <span className={`${c("from-l")} inline-block`}>FROM TERMS</span>{" "}
          <span aria-hidden="true" className={`${c("pop")} inline-flex h-12 w-24 items-center gap-1 rounded-full bg-ink px-[5px] align-middle`}>
            <span className="h-[38px] w-[38px] rounded-full bg-lime" />
            <span className="h-[38px] w-[38px] rounded-full border-2 border-lime" />
          </span>{" "}
          <span className={`${c("from-r")} inline-block`}>TO PAID RENDER</span>
          <br />
          <span className={`${c("rv")} inline-block`}>IN FOUR STEPS</span>
        </h2>
        <div className="flex flex-wrap items-start gap-10">
          <ol className="m-0 flex min-w-0 flex-[1_1_460px] list-none flex-col gap-3.5 p-0">
            {STEPS.map((s, i) => {
              const isOpen = open === i;
              return (
                <li key={s.title} className={`${c("rv")} rounded-[20px] bg-[#EAF2FB] px-[22px] py-5`} style={{ transitionDelay: `${0.15 + i * 0.12}s` }}>
                  <h3 className="m-0">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`step-${i}`}
                      onClick={() => setOpen(isOpen ? -1 : i)}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-3.5 border-0 bg-transparent p-0 text-left text-ink"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink font-sans font-semibold text-white">{i + 1}</span>
                      <span className="flex-1 font-display text-[16px] font-bold">{s.title}</span>
                      <IconChevron size={20} className={`transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`} />
                    </button>
                  </h3>
                  <div id={`step-${i}`} className={`acc-body${isOpen ? " open" : ""}`}>
                    <div className="overflow-hidden">
                      <p className="m-0 mt-3 pl-[50px] text-[15px] leading-relaxed text-[#3E4148]">{s.body}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className={`${c("rv")} flex min-w-0 flex-[1_1_440px] flex-col gap-[18px]`} style={{ transitionDelay: ".3s" }}>
            <p className="m-0 text-[16px] leading-relaxed text-[#3E4148]">
              Political, adult and deceptive uses are banned in the contract itself. You choose everything else, and you can pull a licence back in one
              click.
            </p>
            <div className="relative aspect-[5/4] overflow-hidden rounded-[28px] bg-[#25B6D2]">
              <Image src="/landing/portrait-cyan.png" alt="" fill sizes="(min-width: 1024px) 540px, 92vw" className="scale-[1.03] object-cover object-[50%_22%]" />
              <div
                className={`${c("from-l")} absolute left-[18px] top-1/2 -mt-[70px] flex flex-col gap-2.5 rounded-[18px] bg-white px-3.5 py-3 text-[13px] shadow-[0_12px_30px_rgba(18,19,22,0.15)]`}
                style={{ transitionDelay: ".7s" }}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full">
                    <Image src="/landing/avatar-3.png" alt="" fill sizes="28px" className="scale-[1.06] object-cover" />
                  </span>
                  <b className="font-semibold">Advertising licence</b>
                  <span className="flex items-center gap-1.5 text-grey">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
                    licensed
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full">
                    <Image src="/landing/avatar-4.png" alt="" fill sizes="28px" className="scale-[1.06] object-cover" />
                  </span>
                  <b className="font-semibold">Social request</b>
                  <span className="flex items-center gap-1.5 text-grey">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-violet" />
                    waiting
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full">
                    <Image src="/landing/avatar-5.png" alt="" fill sizes="28px" className="scale-[1.06] object-cover" />
                  </span>
                  <b className="font-semibold">Product licence</b>
                  <span className="flex items-center gap-1.5 text-grey">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-bad" />
                    revoked
                  </span>
                </span>
              </div>
            </div>
            <Link href="/how" className={pillClass("ink", "min-h-[54px]")}>
              See how consent works
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- creators

/**
 * Sample images only, never a real creator's face: each card is labelled Example and invites a creator.
 * Real creators are in the marketplace, with the photo they chose to publish there.
 */
const EXAMPLES = [
  { photo: "/landing/portrait-pink.png", frame: "/landing/card-violet.png" },
  { photo: "/landing/portrait-glasses.png", frame: "/landing/card-ribbons.png" },
  { photo: "/landing/portrait-curly.png", frame: "/landing/card-sky.png" },
];
const TILTS = ["-7deg", "-3deg", "6deg"];
/** Grid placement at sm and up: first card tall on the left, heading top right, the others below it. */
const PLACE = ["sm:col-start-1 sm:row-span-2 sm:row-start-1", "sm:col-start-2 sm:row-start-2 sm:-ml-6 sm:mt-6", "sm:col-start-3 sm:row-start-2 sm:-mt-4"];

function Creators() {
  const [shift, setShift] = useState(0);
  const { ref, seen } = useInView<HTMLDivElement>();
  const shown = [0, 1, 2].map((i) => EXAMPLES[(i + shift) % EXAMPLES.length]);
  return (
    <section className="relative overflow-hidden bg-sky">
      <svg aria-hidden="true" viewBox="0 0 1440 800" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <g fill="#E2F0F9">
          <path d="M-100 700 L 500 -100 L 620 -100 L 20 700 Z" />
          <path d="M600 900 L 1300 -100 L 1380 -100 L 680 900 Z" />
        </g>
      </svg>
      <div ref={ref} className="relative mx-auto grid max-w-[1120px] grid-cols-1 gap-8 px-4 pb-24 pt-20 sm:grid-cols-3 sm:gap-x-6 sm:gap-y-6 sm:px-8">
        <div className={`rv${seen ? " in" : ""} flex flex-wrap items-end gap-4 sm:col-span-2 sm:col-start-2 sm:row-start-1 sm:self-start sm:pl-6 sm:pt-8`}>
          <h2 className="m-0 font-display text-[clamp(26px,3.4vw,40px)] font-extrabold leading-[1.15]">
            MEET THE{" "}
            <span aria-hidden="true" className="relative inline-block h-10 w-10 overflow-hidden rounded-full align-middle">
              <Image src="/landing/avatar-7.png" alt="" fill sizes="40px" className="scale-[1.06] object-cover" />
            </span>
            <br />
            CREATORS
          </h2>
          <span className="flex gap-1 pb-1">
            <button
              type="button"
              aria-label="Previous card"
              onClick={() => setShift((s) => (s + EXAMPLES.length - 1) % EXAMPLES.length)}
              className="flex h-11 w-11 items-center justify-center rounded-full border-0 bg-transparent"
            >
              <IconArrowLeft size={22} />
            </button>
            <button
              type="button"
              aria-label="Next card"
              onClick={() => setShift((s) => (s + 1) % EXAMPLES.length)}
              className="flex h-11 w-11 items-center justify-center rounded-full border-0 bg-transparent"
            >
              <IconArrowRight size={22} />
            </button>
          </span>
        </div>
        {shown.map((ex, i) => {
          const transform = seen ? `rotate(${TILTS[i]})` : "translateX(160px) rotate(8deg)";
          return (
            <Link
              key={ex.photo}
              href="/creators"
              className={`card-in${seen ? " in" : ""} relative block self-start rounded-[28px] p-3 text-ink no-underline shadow-[0_18px_40px_rgba(18,19,22,0.12)] ${PLACE[i]}`}
              style={{ transform, transitionDelay: `${0.1 + i * 0.18}s`, backgroundImage: `url(${ex.frame})`, backgroundSize: "cover" }}
            >
              <span className="absolute left-5 top-5 z-10 rounded-full bg-white px-3 py-1.5 font-display text-[11px] font-bold">EXAMPLE</span>
              <div className="relative aspect-[4/5] overflow-hidden rounded-[20px]">
                <Image src={ex.photo} alt="" fill sizes="(min-width: 640px) 340px, 90vw" className="scale-[1.04] object-cover object-top" />
              </div>
              <div className="absolute bottom-6 left-6 right-6 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-3 py-2.5">
                <span className="flex min-w-0 flex-col">
                  <span className="font-display text-[14px] font-bold">YOUR FACE HERE</span>
                  <span className="text-[12px] text-grey">Your terms, paid per render</span>
                </span>
                <span className={pillClass("ink", "min-h-9 px-3 text-[12px]")}>See the creators</span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- testimonials and CTA

function Quotes() {
  const { ref, seen } = useInView<HTMLDivElement>();
  const c = (k: string) => `${k}${seen ? " in" : ""}`;
  const bgs = [
    ["#1F4D3A", "#FFFFFF"],
    ["#E3EFF9", "#121316"],
    ["#FBE3EC", "#121316"],
    ["#ECE6FD", "#121316"],
    ["#DCF37B", "#121316"],
  ];
  return (
    <section className="overflow-hidden bg-white">
      <div ref={ref} className="flex flex-col gap-11 py-24">
        {TESTIMONIALS.length > 0 && (
          <>
            <h2 className="m-0 px-4 text-center font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-[1.2] sm:px-8">
              <span className={`${c("from-l")} inline-block`}>HEAR IT</span>{" "}
              <span aria-hidden="true" className={`${c("pop")} inline-flex h-12 w-24 items-center gap-1 rounded-full bg-lime px-[5px] align-middle`}>
                <span className="h-[38px] w-[38px] rounded-full bg-ink" />
                <span className="h-[38px] w-[38px] rounded-full border-2 border-ink" />
              </span>{" "}
              <span className={`${c("from-r")} inline-block`}>FROM CREATORS</span>
            </h2>
            <div className="lk-marquee overflow-hidden" aria-label="Quotes, scrolling; hover or focus to pause" tabIndex={0}>
              <div className="lk-quotes">
                {[...TESTIMONIALS, ...TESTIMONIALS].map((q, i) => (
                  <blockquote
                    key={i}
                    aria-hidden={i >= TESTIMONIALS.length ? true : undefined}
                    className="m-0 box-border flex min-h-[240px] w-[290px] shrink-0 flex-col gap-[18px] rounded-3xl p-6"
                    style={{ background: bgs[i % bgs.length][0], color: bgs[i % bgs.length][1] }}
                  >
                    <p className="m-0 text-[15px] leading-relaxed">{q.quote}</p>
                    <footer className="mt-auto font-display text-[13px] font-bold">
                      {q.name}
                      <br />
                      <span className="font-sans font-normal opacity-80">{q.role}</span>
                    </footer>
                  </blockquote>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="px-4 sm:px-8">
          <div className={`${c("rv")} relative mx-auto flex max-w-[1116px] flex-wrap items-center justify-between gap-5 overflow-hidden rounded-[24px] bg-lime bg-[url(/landing/card-lime.png)] bg-cover bg-center px-[30px] py-[26px]`}>
            <h2 className="m-0 font-display text-[clamp(18px,2.2vw,24px)] font-extrabold leading-[1.25]">
              LICENSE YOUR FACE TO AI.
              <br />
              YOUR TERMS, PAID PER IMAGE.
            </h2>
            <span className="flex items-center gap-4">
              <span aria-hidden="true" className="hidden sm:flex">
                {[6, 8, 5].map((n, i) => (
                  <span key={n} className="relative h-11 w-11 overflow-hidden rounded-full border-[3px] border-white" style={{ marginLeft: i ? -12 : 0 }}>
                    <Image src={`/landing/avatar-${n}.png`} alt="" fill sizes="44px" className="scale-[1.06] object-cover" />
                  </span>
                ))}
              </span>
              <Link href="/creators" className={pillClass("outline-dark", "px-6 text-[14px]")}>
                License a face
              </Link>
              <Link href="/verify" className={pillClass("ink", "px-6 text-[14px]")}>
                Verify a file
              </Link>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
