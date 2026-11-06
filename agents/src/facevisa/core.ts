/**
 * FaceVisa's own flow, assembled: the data layer, the brand agent, the render pipeline and the consent
 * checkpoint. Settings (all optional):
 *   AGENT_PASS_REQUEST_TTL_MIN   how long a finished ad waits for the creator's review (default 10)
 *   FACEVISA_LICENCE_DAYS        how long a licence lasts once approved (default 30)
 *   FACEVISA_BRAND_DAILY_BUDGET  what one brand may spend per UTC day, USD (default 1.00)
 *   FACEVISA_BRAND_IMAGES / _VIDEOS  billed model calls per brand workspace per UTC day (default 3 / 1)
 *   FACEVISA_SITE_IMAGES / _VIDEOS   billed model calls across the site per UTC day (default 10 / 2)
 *   FACE_MODELS_DIR              the local face matcher's models (`pnpm face:models`); present = the face gate runs
 *   BRAND_STEPUP_USDC            above this price per request (USD), the agent pauses until the brand's own human
 *                                approves the spend with a fresh World ID check (unset = never)
 *   FACEVISA_AI_IMAGE / FACEVISA_AI_VIDEO = vertex | 0g | empty   who makes images (and a video's still) and videos;
 *                                         empty = a marked TEST RENDER, no model call; unset = the legacy FACEVISA_AI
 *                                         (ai/media.ts; ai/vertex.ts refuses another submission's project)
 */
import type { Accounts } from "../app/accounts.js";
import type { Onboarding } from "../app/onboarding.js";
import type { RenderStore } from "../app/store.js";
import { BrandAgent } from "./brandAgent.js";
import { SqliteFaceVisaData, type AiCaps, type FaceVisaData } from "./data.js";
import { DevConsent, DevPayment, noFaceCheck, Pipeline, type AiProvider, type ConsentCheckpoint, type FaceCheck, type PaymentRail } from "./pipeline.js";
import { parseUsd } from "./rules.js";
import { providersFromEnv } from "../ai/media.js";
import { faceModelsPresent, localFaceCheck } from "./face.js";

export interface CoreOptions {
  aiProvider?: AiProvider;
  faceCheck?: FaceCheck;
  payment?: PaymentRail;
  /** Generate, pay and release on the agent's own (default true; tests drive each step). */
  autoRun?: boolean;
  /** Development only: licences last this long (ms) instead of their days (ARKIV_DEV_LICENCE_MINUTES). */
  licenceMs?: number;
}

export interface Core {
  data: FaceVisaData;
  /** Daily caps on billed model calls (enforced only for a billed provider such as Vertex). */
  aiCaps: AiCaps;
  agent: BrandAgent;
  pipeline: Pipeline;
  consent: ConsentCheckpoint | undefined;
  ai: AiProvider;
  requestTtlMs: number;
  /** Installs the consent checkpoint (DevConsent or the Agent Pass); without one, requests are refused. */
  useConsent(c: ConsentCheckpoint): void;
  stop(): void;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function createCore(o: { accounts: Accounts; onboarding: Onboarding; store: RenderStore; root?: string } & CoreOptions): Core {
  const data = new SqliteFaceVisaData(o.accounts.db);
  const media = o.aiProvider ? undefined : providersFromEnv(o.root ?? process.cwd());
  const ai = o.aiProvider ?? media!.ai;
  const budget = parseUsd(process.env.FACEVISA_BRAND_DAILY_BUDGET || "1.00");
  const dailyBudget = Number.isFinite(budget) && budget > 0 ? budget : 1_000_000;
  const int = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const aiCaps = {
    brand: { image: int(process.env.FACEVISA_BRAND_IMAGES, 3), video: int(process.env.FACEVISA_BRAND_VIDEOS, 1) },
    site: { image: int(process.env.FACEVISA_SITE_IMAGES, 10), video: int(process.env.FACEVISA_SITE_VIDEOS, 2) },
  };
  const pipeline = new Pipeline({
    data,
    payment: o.payment ?? new DevPayment(data),
    ai,
    face: o.faceCheck ?? (faceModelsPresent() ? localFaceCheck() : noFaceCheck),
    store: o.store,
    reference: (uid) => {
      const row = o.accounts.creator(uid);
      return row?.consentAt ? o.onboarding.photo(row) : undefined;
    },
    references: (uid) => {
      const row = o.accounts.creator(uid);
      return row?.consentAt ? o.onboarding.captureFrames(row) : [];
    },
    dailyBudget,
    reviewTtlMs: num(process.env.AGENT_PASS_REQUEST_TTL_MIN, 10) * 60_000,
    aiCaps,
    licenceMs: o.licenceMs,
  });
  const requestTtlMs = num(process.env.AGENT_PASS_REQUEST_TTL_MIN, 10) * 60_000;
  const stepup = parseUsd(process.env.BRAND_STEPUP_USDC ?? "");
  const agent = new BrandAgent({
    data,
    pipeline,
    spendLimit: Number.isFinite(stepup) ? stepup : undefined,
    licenceDays: num(process.env.FACEVISA_LICENCE_DAYS, 30),
    dailyBudget,
    autoRun: o.autoRun ?? true,
    // A video needs an image call (its opening still) and a video call.
    aiRoom: (brand, kind) => {
      const used = data.aiCallsToday(brand);
      for (const k of kind === "video" ? (["image", "video"] as const) : (["image"] as const)) {
        if (!(ai.billedFor ? ai.billedFor(k) : ai.billed)) continue;
        // A video's opening still is an image call: say so, or a video refused for images reads as a mistake.
        const why = kind === "video" && k === "image" ? "; a video's opening still is an image call" : "";
        if (used.brand[k] >= aiCaps.brand[k]) return `this brand workspace's daily cap on AI ${k} calls is reached (${aiCaps.brand[k]} today, UTC)${why}`;
        if (used.site[k] >= aiCaps.site[k]) return `the site's daily cap on AI ${k} calls is reached (${aiCaps.site[k]} today, UTC)${why}`;
      }
      return undefined;
    },
    creatorName: (uid) => o.accounts.account(uid)?.name || "the creator",
  });
  const timer = setInterval(() => agent.sweep(), 15_000);
  timer.unref();
  const core: Core = {
    data,
    aiCaps,
    agent,
    pipeline,
    consent: undefined,
    ai,
    requestTtlMs,
    useConsent(c) {
      core.consent = c;
      agent.d.consent = c;
    },
    stop: () => clearInterval(timer),
  };
  return core;
}

/** DevConsent for a core: approves at once, with evidence saying no World ID was involved (local development). */
export const devConsent = (core: Core) => new DevConsent(core.data, (id) => core.agent.onApproved(id));
