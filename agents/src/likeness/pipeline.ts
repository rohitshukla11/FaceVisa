/**
 * The render pipeline, every step behind an interface so later work swaps implementations, not the flow:
 *
 *   request → generate [AI provider] → face check (one regeneration) → stored, NOT released
 *     → [consent: the creator reviews that exact output with a fresh World ID check, approves or rejects (one
 *        regeneration)] → [spend: the brand's own fresh check when the price is over its limit]
 *     → [payment authorize → settle] → release (licence + receipt)
 *
 * - Consent is per finished ad: the approval is bound to the output's file hash plus brand, usage, duration and price
 *   (approvalHashOf). release() refuses with 403 unless that exact approval stands, before anything is charged.
 * - Payment: a PaymentRail. DevPayment records only (local tests and older data); Hedera x402 (hedera/x402.ts) is
 *   the real one, where the brand agent pays the creator in USDC to release the ad.
 * - AI provider: generateImage(reference, prompt) and generateVideo(fromImage, prompt), each with provenance
 *   {provider, model, requestId, verified?}. Vertex, or a marked TEST RENDER with no model call.
 * - Face check: the output (a video's opening still) must match the creator's reference; one regeneration on a failed
 *   check, then the request fails with nothing released or charged. Until the face-match code lands (A2) the check is
 *   "not-run", and receipts say so.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { ffmpegPath, geminiImage, labelImage, labelVideo, motionPrompt, stillPrompt, VIDEO_SECONDS } from "../ai/generate.js";
import { imageToVideo, models } from "../ai/vertex.js";
import type { RenderStore } from "../app/store.js";
import type { AiCaps, LikenessData, Licence, Output, Payment, PendingAction } from "./data.js";
import { usd, type Kind } from "./rules.js";

export type Photo = { bytes: Uint8Array; mime: string };

export class PipelineError extends Error {
  /** Already in the brand's activity log (so a caller doesn't log it twice). */
  logged = false;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The approval binding: the exact output (file hash) for this brand, usage, duration and price. */
export function approvalHashOf(a: Pick<PendingAction, "output" | "brand" | "category" | "durationDays" | "price" | "kind" | "briefHash">): string {
  return createHash("sha256").update(JSON.stringify([a.output?.hash ?? null, a.brand, a.category, a.durationDays, a.price, a.kind, a.briefHash])).digest("hex");
}

// ---------------------------------------------------------------- consent

/** How a finished ad gets the creator's consent. Only the creator's own fresh decision ever approves it. */
export interface ConsentCheckpoint {
  readonly name: "dev" | "in-app";
  /** Called when a finished ad is ready for the creator's review; the agent then waits. */
  opened(action: PendingAction): void;
}

/**
 * Local development without World ID: the finished ad is approved as soon as it is ready, with evidence that says
 * so. Tests only now: the app always uses in-app approvals (app/approval.ts).
 */
export class DevConsent implements ConsentCheckpoint {
  readonly name = "dev" as const;
  constructor(
    private readonly data: LikenessData,
    private readonly onApproved: (actionId: string) => void,
  ) {}
  opened(a: PendingAction) {
    const now = Date.now();
    const state = `dev-${randomUUID()}`;
    this.data.setAttempt(a.id, "creator", state, now);
    this.data.setVerified(a.id, "creator", state, { iss: "dev-consent", sub: "dev", authTime: Math.floor(now / 1000), amr: ["dev"], acr: null, attemptId: state, verifiedAt: now, outputHash: a.output!.hash });
    this.data.approve(a.id, approvalHashOf(a), false);
    this.onApproved(a.id);
  }
}

// ---------------------------------------------------------------- payment

export interface PaymentRail {
  readonly name: string;
  /** Records the payment as authorized; throws (a PipelineError for a refusal) when it can't be. */
  authorize(p: { action: PendingAction; amount: number }): Promise<Payment>;
  /** Settles it and returns its reference; throws PaymentPending when it was sent but its outcome isn't known. */
  settle(p: Payment): Promise<string>;
  void(p: Payment): Promise<void>;
}

/**
 * A payment that was sent but whose outcome isn't known (a facilitator timeout). It is neither voided nor retried:
 * the request stays in "paying" until the rail finds out (then finish() or abandon()), so it is never paid twice.
 */
export class PaymentPending extends Error {
  constructor(
    readonly payment: Payment,
    message: string,
  ) {
    super(message);
  }
}

/** Records the authorization and settlement in our database; no money moves. Hedera x402 replaces it. */
export class DevPayment implements PaymentRail {
  readonly name = "dev";
  constructor(private readonly data: LikenessData) {}
  async authorize(p: { action: PendingAction; amount: number }) {
    return this.data.authorizePayment({ actionId: p.action.id, brand: p.action.brand, amount: p.amount, rail: this.name });
  }
  async settle(p: Payment) {
    const ref = `dev-${randomUUID()}`;
    this.data.settlePayment(p.id, ref);
    return ref;
  }
  async void(p: Payment) {
    this.data.voidPayment(p.id);
  }
}

// ---------------------------------------------------------------- AI provider

export interface Provenance {
  provider: string;
  model: string;
  requestId: string | null;
  /** The provider's own verification of the run (e.g. a TEE attestation); absent when it has none. */
  verified?: boolean;
}
export interface AiOutput {
  bytes: Uint8Array;
  mime: string;
  provenance: Provenance;
}

export interface AiProvider {
  readonly name: string;
  /** Each call is billed (Vertex, 0G): it counts against the daily caps. Test renders aren't. */
  readonly billed?: boolean;
  /** Per kind, when images and videos come from different providers (ai/media.ts); else `billed`. */
  billedFor?(kind: "image" | "video"): boolean;
  /** An image of the person in `reference`; `aspect` 16:9 for a video's opening still. */
  generateImage(reference: Photo, prompt: string, aspect?: "1:1" | "16:9"): Promise<AiOutput>;
  /** A short clip whose first frame is `fromImage`. */
  generateVideo(fromImage: Photo, prompt: string, onProgress?: (step: string) => void): Promise<AiOutput>;
}

/** Vertex AI: Gemini image from the creator's reference photo; Veo 3.1 Lite from the still. Paid calls. */
export function vertexProvider(): AiProvider {
  return {
    name: "vertex",
    billed: true,
    async generateImage(reference, prompt, aspect = "1:1") {
      const out = await geminiImage(prompt, reference, aspect === "16:9" ? "video" : "image");
      return { bytes: out.bytes, mime: "image/png", provenance: { provider: "vertex", model: out.model, requestId: out.requestId } };
    },
    async generateVideo(fromImage, prompt, onProgress) {
      onProgress?.("generating the video (Veo, about 1 to 3 minutes)");
      const jpeg = new Uint8Array(await sharp(fromImage.bytes).jpeg({ quality: 92 }).toBuffer());
      const mp4 = await imageToVideo({ image: jpeg, mime: "image/jpeg", prompt, seconds: VIDEO_SECONDS, aspectRatio: "16:9" });
      return { bytes: mp4, mime: "video/mp4", provenance: { provider: "vertex", model: models.video(), requestId: null } };
    },
  };
}

const run = promisify(execFile);
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** No model call: the creator's reference under a TEST RENDER watermark, and a 2 s clip of it for video. */
export function testProvider(): AiProvider {
  return {
    name: "test",
    async generateImage(reference, prompt, aspect = "1:1") {
      const [w, h] = aspect === "16:9" ? [1280, 720] : [1024, 1024];
      const photo = await sharp(reference.bytes).resize(w, h, { fit: "cover" }).jpeg().toBuffer();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g fill="#fff" fill-opacity="0.25" font-family="sans-serif" font-weight="700" font-size="54" text-anchor="middle">${[0.2, 0.45, 0.7].map((f) => `<text x="${w / 2}" y="${Math.round(h * f)}" transform="rotate(-20 ${w / 2} ${Math.round(h * f)})">TEST RENDER · NO AI</text>`).join("")}</g><rect x="0" y="0" width="${w}" height="56" fill="#111" fill-opacity="0.8"/><text x="24" y="38" fill="#DCF37B" font-size="26" font-family="sans-serif">${esc(prompt.split("\n").find((l) => l.startsWith("Brief:")) ?? "TEST RENDER").slice(0, 90)}</text><text x="${w - 24}" y="${h - 20}" fill="#fff" font-size="18" font-family="sans-serif" text-anchor="end">${new Date().toISOString()}</text></svg>`;
      const bytes = await sharp(photo).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
      return { bytes: new Uint8Array(bytes), mime: "image/jpeg", provenance: { provider: "test", model: "test-render (no AI)", requestId: null } };
    },
    async generateVideo(fromImage) {
      const dir = mkdtempSync(join(tmpdir(), "likeness-test-video-"));
      try {
        writeFileSync(join(dir, "still.jpg"), await sharp(fromImage.bytes).resize(1280, 720, { fit: "cover" }).jpeg().toBuffer());
        await run(ffmpegPath(), ["-y", "-loop", "1", "-i", join(dir, "still.jpg"), "-t", "2", "-r", "12", "-vf", "format=yuv420p", "-c:v", "libx264", "-movflags", "+faststart", join(dir, "out.mp4")], { timeout: 60_000 });
        return { bytes: new Uint8Array(readFileSync(join(dir, "out.mp4"))), mime: "video/mp4", provenance: { provider: "test", model: "test-render (no AI)", requestId: null } };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------- face check

export interface FaceCheck {
  readonly name: string;
  /** Does `output` show the person in `references` (their live-capture frames)? ran=false when no check is available. */
  check(references: Photo[], output: Photo): Promise<{ ran: boolean; match: boolean; score: number | null }>;
}

/** Until the face-match code lands (A2): no check runs, and every receipt says "not-run". */
export const noFaceCheck: FaceCheck = { name: "none", check: async () => ({ ran: false, match: true, score: null }) };

// ---------------------------------------------------------------- the pipeline

/** The exact prompts, from the template (prompt drafting is template-only). */
export const promptsFor = (kind: Kind, brief: string) => ({ still: stillPrompt(brief, kind), motion: kind === "video" ? motionPrompt(brief) : undefined });

export interface PipelineDeps {
  data: LikenessData;
  payment: PaymentRail;
  ai: AiProvider;
  face: FaceCheck;
  store: RenderStore;
  /** The creator's consented reference photo (the front frame of their live capture): what the model is given. */
  reference(creatorUid: string): Photo | undefined;
  /** All of the creator's live-capture frames: what the face check compares against. */
  references(creatorUid: string): Photo[];
  /** A brand's daily budget, micro-USD (enforced here, server-side, before every authorization). */
  dailyBudget: number;
  /** How long the creator has to review a finished ad. */
  reviewTtlMs: number;
  /** Daily caps on billed model calls, per brand and across the site. */
  aiCaps: AiCaps;
  /** Development only (likeness-eth-dev): every licence lasts this long instead of its days, to watch expiry live. */
  licenceMs?: number | undefined;
}

export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  /**
   * Generates the ad for a request in "generating": the output is stored and face-checked, NOT released. Then the
   * request waits for the creator's review. A second failed face check fails the request; nothing is charged.
   */
  async generate(actionId: string, onProgress?: (step: string) => void): Promise<PendingAction> {
    const { data } = this.d;
    const a = data.action(actionId);
    if (!a || a.status !== "generating") throw new PipelineError(409, "this request isn't waiting for generation");
    const reference = this.d.reference(a.creator);
    const fail = (reason: string) => {
      data.transition(a.id, ["generating"], "failed", { reason });
      data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "failed", summary: `${reason}: nothing released, nothing charged` });
      return new PipelineError(422, reason);
    };
    if (!reference) throw fail("the creator has no consented reference photo");
    data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "generating", summary: `generating ${a.generation === 1 ? "the" : "a new"} ${a.kind} (${this.d.ai.name}); it stays private until the creator approves it` });
    let out: Awaited<ReturnType<Pipeline["generateChecked"]>>;
    try {
      out = await this.generateChecked(a.brand, a.kind, reference, this.d.references(a.creator), promptsFor(a.kind, a.brief), onProgress);
    } catch (e) {
      throw fail(e instanceof PipelineError ? e.message : `generation failed: ${(e as Error).message.split("\n")[0]}`);
    }
    const hash = `0x${createHash("sha256").update(out.bytes).digest("hex")}` as `0x${string}`;
    this.d.store.save(hash, out.bytes, { mime: out.mime, licenceId: a.id, renderIndex: a.generation });
    const prompts = promptsFor(a.kind, a.brief);
    const prompt = a.kind === "video" ? `Opening frame:\n${prompts.still}\n\nMotion:\n${prompts.motion}` : prompts.still;
    const output: Output = {
      hash,
      mime: out.mime,
      size: out.bytes.length,
      provider: out.provenance.provider,
      model: out.provenance.model,
      requestId: out.provenance.requestId,
      verified: out.provenance.verified ?? null,
      prompt,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      faceCheck: out.face.ran ? "passed" : "not-run",
      faceScore: out.face.score,
      createdAt: Date.now(),
    };
    if (!data.setOutput(a.id, output, Date.now() + this.d.reviewTtlMs)) throw new PipelineError(409, "the request changed while generating");
    data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "generated", summary: `the ${a.kind} is ready (${output.provider}, ${output.model}; face check ${output.faceCheck === "passed" ? "passed" : "not run"}), not released` });
    return data.action(a.id)!;
  }

  /**
   * The release gate, before anything is charged: the brand's request, approved by the creator for exactly this
   * output, brand, usage, duration and price (and by the brand's human when the spend needed it).
   */
  gate(actionId: string, brand: string): PendingAction {
    const a = this.d.data.action(actionId);
    if (!a || a.brand !== brand) throw new PipelineError(404, "no such request");
    if (a.status !== "approved" || !a.output || !a.approvalHash || a.approvalHash !== approvalHashOf(a) || !a.creatorCheck.decidedAt) {
      throw new PipelineError(403, "no creator approval for this exact ad: nothing was charged or released");
    }
    if (a.spendCheck && !a.spendCheck.decidedAt) throw new PipelineError(403, "the brand's own approval of this spend is missing: nothing was charged or released");
    if (a.expiresAt <= Date.now()) throw new PipelineError(403, "this request expired");
    return a;
  }

  /** Pays and releases an approved ad: one licence and one receipt, once. `rail` defaults to the pipeline's own. */
  async release(actionId: string, brand: string, rail: PaymentRail = this.d.payment): Promise<Licence> {
    const { data } = this.d;
    // Already released (a double-click, a second tab): its licence, nothing charged again.
    const was = data.action(actionId);
    if (was?.brand === brand && was.status === "released" && was.licenceId) return data.licence(was.licenceId)!;
    const a = this.gate(actionId, brand);
    // One file, one licence: bytes already licensed through another request are never paid for again.
    if (a.output && data.receipt(a.output.hash)) {
      data.transition(a.id, ["approved"], "failed", { reason: "this exact file is already licensed through another request" });
      data.log({ brand, actionId: a.id, licenceId: null, kind: "failed", summary: "not released: this exact file is already licensed through another request; nothing was charged" });
      throw new PipelineError(409, "this exact file is already licensed through another request: nothing was charged");
    }
    if (!data.transition(a.id, ["approved"], "paying")) throw new PipelineError(409, "this ad is already being paid for");
    const spent = data.spentToday(brand);
    if (spent + a.price > this.d.dailyBudget) {
      data.transition(a.id, ["paying"], "approved");
      const msg = `the brand's daily budget: ${usd(spent)} of ${usd(this.d.dailyBudget)} spent; ${usd(a.price)} more would exceed it`;
      data.log({ brand, actionId: a.id, licenceId: null, kind: "blocked", summary: `${msg}; not released` });
      throw new PipelineError(402, msg);
    }
    let payment: Payment | undefined;
    let paymentRef: string;
    try {
      payment = await rail.authorize({ action: a, amount: a.price });
      paymentRef = await rail.settle(payment);
    } catch (e) {
      if (e instanceof PaymentPending) {
        data.log({ brand, actionId: a.id, licenceId: null, kind: "paying", summary: `${e.message}: nothing is released or paid again until its outcome is known` });
        throw e;
      }
      if (payment) await rail.void(payment);
      data.transition(a.id, ["paying"], "approved");
      const err = e instanceof PipelineError ? e : new PipelineError(502, `payment failed: ${(e as Error).message.split("\n")[0]}`);
      data.log({ brand, actionId: a.id, licenceId: null, kind: "blocked", summary: `payment ${e instanceof PipelineError ? "refused" : "failed"} (${rail.name}): ${err.message}; nothing charged, not released` });
      err.logged = true;
      throw err;
    }
    return this.finish(a.id, payment, paymentRef, rail.name);
  }

  /** A settled payment: the licence and the receipt (once). */
  finish(actionId: string, payment: Payment, paymentRef: string, railName: string): Licence {
    const { data } = this.d;
    const a = data.action(actionId)!;
    data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "paid", summary: `paid ${usd(a.price)} (${railName}, ${paymentRef})` });
    const lic = data.release(a.id, { licenceDays: a.durationDays, licenceMs: this.d.licenceMs, payment, paymentRef });
    if (!lic) throw new PipelineError(409, "this ad was already released");
    data.log({ brand: a.brand, actionId: a.id, licenceId: lic.id, kind: "released", summary: `released: licence ${lic.id} for ${a.durationDays} days (${a.category})` });
    return lic;
  }

  /**
   * After a restart: requests the last run left mid-generation or mid-payment, settled without doubt.
   * - generating: failed (a model call may have been billed; it's never repeated by itself), with the reason.
   * - paying, with a settled payment: finished (the licence and receipt), never paid again.
   * - paying, with a payment sent but not confirmed (one with a reference, on a rail that can look it up): handed to
   *   `reconcile` (Hedera: the mirror node decides).
   * - paying, with a payment never sent (or none at all): voided, and the request is approved again.
   */
  recover(o: { reconcile?: (p: Payment) => boolean } = {}) {
    const { data } = this.d;
    const out = { failed: 0, released: 0, watching: 0, reverted: 0 };
    for (const a of data.actions({ status: "generating" })) {
      const reason = "generation was interrupted by a restart: nothing released, nothing charged; ask again";
      if (data.transition(a.id, ["generating"], "failed", { reason })) {
        data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "failed", summary: reason });
        out.failed++;
      }
    }
    for (const a of data.actions({ status: "paying" })) {
      const payments = data.payments({ actionId: a.id });
      const settled = payments.find((p) => p.status === "settled");
      if (settled) {
        this.finish(a.id, settled, settled.ref!, settled.rail);
        out.released++;
        continue;
      }
      const open = payments.find((p) => p.status === "authorized");
      if (open?.ref && o.reconcile?.(open)) {
        out.watching++;
        continue;
      }
      if (open) data.voidPayment(open.id);
      if (data.transition(a.id, ["paying"], "approved")) {
        data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "blocked", summary: "the payment was interrupted by a restart before anything was charged; the ad can be paid for again" });
        out.reverted++;
      }
    }
    return out;
  }

  /** A pending payment that turned out not to have happened: voided, and the request is approved again. */
  abandon(actionId: string, payment: Payment, reason: string) {
    const { data } = this.d;
    data.voidPayment(payment.id);
    const a = data.action(actionId);
    if (a && data.transition(a.id, ["paying"], "approved")) data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "blocked", summary: `the payment didn't happen (${reason}): nothing charged; the ad can be paid for again` });
  }

  /** Generates, checks the face (a video's opening still), regenerates once, and labels the file. */
  /** Reserves a billed model call within the daily caps (no-op for unbilled providers); refuses when a cap is reached. */
  private reserve(brand: string, kind: "image" | "video") {
    if (!(this.d.ai.billedFor ? this.d.ai.billedFor(kind) : this.d.ai.billed)) return;
    const refused = this.d.data.reserveAiCall(brand, kind, this.d.aiCaps);
    if (refused) throw new PipelineError(429, refused);
  }

  private async generateChecked(brand: string, kind: Kind, reference: Photo, references: Photo[], prompts: { still: string; motion?: string }, onProgress?: (step: string) => void) {
    const { ai, face } = this.d;
    let still: AiOutput | undefined;
    let result: Awaited<ReturnType<FaceCheck["check"]>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      onProgress?.(attempt ? "the face didn't match: regenerating once" : kind === "video" ? "generating the opening frame" : "generating the image");
      this.reserve(brand, "image");
      still = await ai.generateImage(reference, prompts.still, kind === "video" ? "16:9" : "1:1");
      result = await face.check(references.length ? references : [reference], { bytes: still.bytes, mime: still.mime });
      if (!result.ran || result.match) break;
      if (attempt === 1) throw new PipelineError(422, "the face didn't match the creator twice");
    }
    if (kind === "image") return { bytes: await labelImage(still!.bytes), mime: "image/jpeg", provenance: still!.provenance, face: result! };
    this.reserve(brand, "video");
    const video = await ai.generateVideo({ bytes: still!.bytes, mime: still!.mime }, prompts.motion!, onProgress);
    onProgress?.("adding the AI label");
    // The still's request id is the traceable one when the video call returns none (Veo returns the file inline).
    // From two providers (e.g. a 0G still animated on Vertex), both are named.
    const same = video.provenance.provider === still!.provenance.provider;
    const provenance = {
      ...video.provenance,
      provider: same ? video.provenance.provider : `${still!.provenance.provider}+${video.provenance.provider}`,
      model: `${still!.provenance.model} + ${video.provenance.model}`,
      requestId: video.provenance.requestId ?? still!.provenance.requestId,
      // Verified only if every part was.
      ...(same || video.provenance.verified === undefined ? {} : { verified: !!(video.provenance.verified && still!.provenance.verified) }),
    };
    return { bytes: await labelVideo(video.bytes), mime: "video/mp4", provenance, face: result! };
  }
}
