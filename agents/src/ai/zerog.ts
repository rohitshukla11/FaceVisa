/**
 * 0G Compute Router (B3): images on `bytedance/seedream-5.0-flash` from the creator's reference photo, and video on
 * `bytedance/seedance-2.0` from the approved still (its first frame). Research and quotes: 0g/research.md.
 *
 * - The API key is read from a file readable only by its owner (ZEROG_API_KEY_FILE, default
 *   .secrets/zerog-api-key): never from env, never logged.
 * - Images: synchronous `POST /v1/images/generations` with the reference as a `data:` URL in `image`, base64 out.
 * - Video: `POST /v1/videos` (the still in `metadata.content` as the `first_frame`, audio off), poll
 *   `GET /v1/videos/{id}`, then download `GET /v1/videos/{id}/content`.
 * - Provenance: the Router's `x_0g_trace.request_id` (a video's job id). `verify_tee` is always asked for; a file is
 *   "verified" only when the Router answers `tee_verified: true`, otherwise it's a 0G request record.
 * - Seedance refuses an image that "may contain real person" (InputImageSensitiveContentDetected.PrivacyInformation,
 *   0g/friction.md): a ZeroGError with `refused`, never retried and never silently switched to another provider.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AiOutput, AiProvider, Photo } from "../facevisa/pipeline.js";

export const ZEROG_BASE_URL = "https://router-api.0g.ai/v1";
export const ZEROG_IMAGE_MODEL = "bytedance/seedream-5.0-flash";
export const ZEROG_VIDEO_MODEL = "bytedance/seedance-2.0";

export interface ZeroGConfig {
  baseUrl: string;
  apiKey: string;
  imageModel: string;
  videoModel: string;
  videoResolution: "480p" | "720p" | "1080p";
  /** Poll interval when the Router sends no Retry-After, and the whole video job's timeout. */
  pollMs: number;
  videoTimeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * Settings, or undefined while there's no key file. The key file must be readable by its owner only. `prefix`: `sk-`
 * (an API key, the default) or `mk-` (a read-only management key, for the health page's balance).
 */
export function zeroGConfigFromEnv(root: string, env = process.env, prefix: "sk-" | "mk-" = "sk-"): ZeroGConfig | undefined {
  const file = env.ZEROG_API_KEY_FILE || ".secrets/zerog-api-key";
  const path = isAbsolute(file) ? file : resolve(root, file);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) return undefined;
  if (st.mode & 0o077) throw new Error("ZEROG_API_KEY_FILE: readable by others (chmod 600 it)");
  const apiKey = readFileSync(path, "utf8").trim();
  if (!apiKey.startsWith(prefix) || !/^[a-z]{2}-[A-Za-z0-9-]{8,}$/.test(apiKey)) throw new Error(`${prefix === "sk-" ? "ZEROG_API_KEY_FILE" : "ZEROG_MGMT_KEY_FILE"}: not a 0G ${prefix === "sk-" ? "API" : "management"} key (${prefix}…)`);
  const res = env.ZEROG_VIDEO_RESOLUTION || "480p";
  if (res !== "480p" && res !== "720p" && res !== "1080p") throw new Error("ZEROG_VIDEO_RESOLUTION: 480p, 720p or 1080p");
  return { baseUrl: (env.ZEROG_BASE_URL || ZEROG_BASE_URL).replace(/\/$/, ""), apiKey, imageModel: env.ZEROG_IMAGE_MODEL || ZEROG_IMAGE_MODEL, videoModel: env.ZEROG_VIDEO_MODEL || ZEROG_VIDEO_MODEL, videoResolution: res, pollMs: 4_000, videoTimeoutMs: 10 * 60_000 };
}

/**
 * An error from the Router, with the vendor's own code when the Router wraps it (it sends the vendor's error as a
 * JSON string in `message`). `refused`: the vendor's content filter refused an input (e.g. a real person's face).
 */
export class ZeroGError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly vendorCode: string | null,
    readonly requestId: string | null,
    readonly refused: boolean,
  ) {
    super(message);
  }
}

export function zeroGError(status: number, text: string, requestId: string | null): ZeroGError {
  let code: string | null = null;
  let vendorCode: string | null = null;
  let message = text.slice(0, 500) || `HTTP ${status}`;
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string }; code?: string; message?: string; request_id?: string };
    requestId = body.request_id ?? requestId;
    code = body.error?.code ?? body.code ?? null;
    message = body.error?.message ?? body.message ?? message;
    // The vendor's error, wrapped as a JSON string.
    if (typeof body.message === "string" && body.message.trim().startsWith("{")) {
      const inner = JSON.parse(body.message) as { error?: { code?: string; message?: string } };
      vendorCode = inner.error?.code ?? null;
      message = inner.error?.message ?? message;
    }
  } catch {
    // Not JSON: the text itself is the message.
  }
  const refused = /SensitiveContent|PrivacyInformation/i.test(`${vendorCode ?? ""} ${code ?? ""}`);
  return new ZeroGError(status, message, code, vendorCode, requestId, refused);
}

const dataUrl = (p: Photo) => `data:${p.mime};base64,${Buffer.from(p.bytes).toString("base64")}`;
const mimeOf = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0x52 && b[1] === 0x49 ? "image/webp" : "application/octet-stream");
type Trace = { request_id?: string; tee_verified?: boolean | null };
/** `verified` only from the Router's own answer: true or false; absent when it didn't say. */
const teeOf = (t: Trace | undefined) => (typeof t?.tee_verified === "boolean" ? { verified: t.tee_verified } : {});

/**
 * One Router call. A 429, 502 or 503 means the request wasn't run (rate limit, provider error, no provider), so it's
 * tried once more after Retry-After (at most 10 s). A timeout is never retried: 0G bills submitted work even when the
 * caller gives up, so a retry could pay twice.
 */
async function call(c: ZeroGConfig, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 120_000) {
  for (let attempt = 0; ; attempt++) {
    const r = await (c.fetch ?? fetch)(`${c.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${c.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (attempt > 0 || ![429, 502, 503].includes(r.status)) return r;
    const wait = Number(r.headers.get("retry-after")) * 1000;
    await new Promise((res) => setTimeout(res, Math.min(wait > 0 ? wait : 2_000, 10_000)));
  }
}

/** One Seedream image of the person in `reference`; 1:1 for an image ad, 16:9 for a video's opening still. */
export async function zeroGImage(c: ZeroGConfig, reference: Photo, prompt: string, aspect: "1:1" | "16:9" = "1:1"): Promise<AiOutput> {
  const r = await call(c, "POST", "/images/generations", { model: c.imageModel, prompt, image: dataUrl(reference), size: aspect === "16:9" ? "1280x720" : "1024x1024", n: 1, response_format: "b64_json", verify_tee: true });
  const text = await r.text();
  const requestId = r.headers.get("x-request-id")?.split(",").pop()?.trim() ?? null;
  if (!r.ok) throw zeroGError(r.status, text, requestId);
  const body = JSON.parse(text) as { data?: { b64_json?: string }[]; x_0g_trace?: Trace };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new ZeroGError(502, "0G returned no image", null, null, body.x_0g_trace?.request_id ?? requestId, false);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return { bytes, mime: mimeOf(bytes), provenance: { provider: "0g", model: c.imageModel, requestId: body.x_0g_trace?.request_id ?? requestId, ...teeOf(body.x_0g_trace) } };
}

/** A clip from `still` (its first frame), audio off: submit, poll, download. */
export async function zeroGVideo(c: ZeroGConfig, still: Photo, prompt: string, seconds: number, onProgress?: (step: string) => void): Promise<AiOutput> {
  const s = Math.min(15, Math.max(4, Math.round(seconds)));
  const r = await call(c, "POST", "/videos", {
    model: c.videoModel,
    prompt,
    seconds: s,
    verify_tee: true,
    metadata: { resolution: c.videoResolution, ratio: "16:9", generate_audio: false, watermark: false, content: [{ type: "image_url", image_url: { url: dataUrl(still) }, role: "first_frame" }] },
  });
  const text = await r.text();
  if (!r.ok) throw zeroGError(r.status, text, r.headers.get("x-request-id")?.split(",").pop()?.trim() ?? null);
  const job = JSON.parse(text) as { id?: string; status?: string; x_0g_trace?: Trace };
  if (!job.id) throw new ZeroGError(502, "0G returned no video job id", null, null, job.x_0g_trace?.request_id ?? null, false);
  onProgress?.(`generating the video on 0G (job ${job.id})`);
  let trace = job.x_0g_trace;
  const end = Date.now() + c.videoTimeoutMs;
  for (;;) {
    const p = await call(c, "GET", `/videos/${encodeURIComponent(job.id)}`);
    const ptext = await p.text();
    if (!p.ok) throw zeroGError(p.status, ptext, job.id);
    const st = JSON.parse(ptext) as { status?: string; error?: { code?: string; message?: string } | null; x_0g_trace?: Trace };
    trace = st.x_0g_trace ?? trace;
    if (st.status === "completed" || st.status === "succeeded") break;
    if (st.status === "failed" || st.status === "cancelled" || st.status === "expired") {
      const vendorCode = st.error?.code ?? null;
      throw new ZeroGError(502, `the 0G video job ${st.status}: ${st.error?.message ?? "no reason given"}`, null, vendorCode, job.id, /SensitiveContent|PrivacyInformation/i.test(vendorCode ?? ""));
    }
    if (Date.now() > end) throw new ZeroGError(504, `the 0G video job ${job.id} didn't finish in ${Math.round(c.videoTimeoutMs / 60_000)} minutes`, null, null, job.id, false);
    const wait = Number(p.headers.get("retry-after")) * 1000;
    await new Promise((res) => setTimeout(res, wait > 0 ? Math.min(wait, 30_000) : c.pollMs));
  }
  const d = await call(c, "GET", `/videos/${encodeURIComponent(job.id)}/content`, undefined, 300_000);
  if (!d.ok) throw zeroGError(d.status, await d.text(), job.id);
  const bytes = new Uint8Array(await d.arrayBuffer());
  return { bytes, mime: "video/mp4", provenance: { provider: "0g", model: c.videoModel, requestId: job.id, ...teeOf(trace) } };
}

/** 0G as an AI provider: both kinds billed (per image; per video token). */
export function zeroGProvider(c: ZeroGConfig): AiProvider {
  return {
    name: "0g",
    billed: true,
    generateImage: (reference, prompt, aspect) => zeroGImage(c, reference, prompt, aspect),
    generateVideo: (fromImage, prompt, onProgress) => zeroGVideo(c, fromImage, prompt, 8, onProgress),
  };
}
