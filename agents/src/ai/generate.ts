/**
 * AI ads of a licensed creator (Vertex AI, this app's own project), as in Rohit's earlier
 * project: Gemini image generation with the creator's consented photo as the subject reference; for
 * video, a still made that way becomes the first frame of a Veo 3.1 Lite clip (8 s, 720p, silent).
 * Every output carries a visible "AI-generated · licensed via FaceVisa" label, burned into the pixels
 * (sharp for images, ffmpeg for video), so the receipt's sha256 covers the labelled file.
 */
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import { checkBrief, type BriefCheck } from "./filter.js";
import { generateContent, imageToVideo, models } from "./vertex.js";

export type AdKind = "image" | "video";
export type Photo = { bytes: Uint8Array; mime: string };
export const VIDEO_SECONDS = 8;

/**
 * prompt / motion: the exact text sent to the image model and to Veo (the brand may have edited the
 * template); without them, the template is built from the brief.
 */
export interface AdGenerator {
  check(text: string): Promise<BriefCheck>;
  image(input: { brief: string; prompt?: string; photo: Photo }): Promise<{ bytes: Uint8Array; mime: string; model: string }>;
  video(input: { brief: string; prompt?: string; motion?: string; photo: Photo; onProgress?: (step: string) => void }): Promise<{ bytes: Uint8Array; mime: string; model: string }>;
}

const LABEL = fileURLToPath(new URL("../../assets/ai-label.png", import.meta.url));

/** The brief, then the rules that keep the creator faithful and the frame clean. */
export function stillPrompt(brief: string, purpose: "image" | "video"): string {
  return [
    "The image shows one real, consenting adult who has licensed their face for this advertising image.",
    "Generate a new photorealistic image of exactly this person, keeping their face, identity and appearance faithful to the reference photo.",
    "Their face is clearly visible, unobstructed and well lit; one person only.",
    purpose === "video"
      ? "Compose it as the opening frame of a short video ad: landscape 16:9, the person in the centre third with room to move, already in the middle of the brief's action (for example mid-stride if they are running), not posing for the camera."
      : "Square advertising photo, the person as the clear subject.",
    "Do not add any text, logos, captions or watermarks.",
    // The wardrobe rule (both providers): image models copy the reference photo's clothes and accessories.
    "Clothing: as the brief describes; if it names none, plain, simple clothing with no logos, text, prints or brand marks. Never copy the clothing from the reference photo.",
    "Accessories: none from the reference photo (no earbuds, headphones, hats, bags, badges or jewellery from it) unless the brief asks for them.",
    "Pose and expression: doing what the brief describes, caught mid-movement when it has an action (for example mid-stride when running), otherwise natural and suited to the brief (for example relaxed and smiling in a café); never the reference photo's straight-on pose or neutral expression.",
    `Brief: ${brief}`,
  ].join("\n");
}

/** The prompts the brand sees, pre-filled, before paying for one render: exactly what is sent. */
export function promptsFor(kind: AdKind, brief: string): { prompt: string; motion?: string } {
  return kind === "video" ? { prompt: stillPrompt(brief, "video"), motion: motionPrompt(brief) } : { prompt: stillPrompt(brief, "image") };
}

/** The render record's prompt: one text (and so one sha256) for both of a video's model calls. */
export function fullPrompt(kind: AdKind, p: { prompt: string; motion?: string }): string {
  return kind === "video" ? `Opening frame (image model):\n${p.prompt}\n\nMotion (Veo):\n${p.motion ?? ""}` : p.prompt;
}

export function motionPrompt(brief: string): string {
  return [
    `Action: ${brief.trim()}`,
    "The person performs the action in the brief continuously for the whole clip, with natural full-body movement (for example, if they are running, they keep running along the path at a steady pace); they never stop to stand or pose.",
    "The camera moves with them (a smooth tracking or follow shot) so they stay in frame. One continuous shot, no cuts.",
    "Keep exactly the person, product and setting of the first frame; their face stays visible and recognisable throughout.",
    "Photorealistic advertising footage. No text, captions, logos or watermarks.",
  ].join("\n");
}

export async function geminiImage(text: string, photo: Photo, purpose: "image" | "video") {
  const model = models.image();
  const res = await generateContent(model, {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: photo.mime, data: Buffer.from(photo.bytes).toString("base64") } }, { text }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: purpose === "video" ? "16:9" : "1:1", imageSize: "1K" } },
  });
  if (res.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${res.promptFeedback.blockReason}`);
  const c = res.candidates?.[0];
  const img = c?.content?.parts?.find((p) => p.inlineData?.data && !p.thought)?.inlineData;
  if (!img) throw new Error(`Gemini returned no image (${c?.finishReason ?? "no reason"}${c?.finishMessage ? `: ${c.finishMessage}` : ""})`);
  return { bytes: new Uint8Array(Buffer.from(img.data, "base64")), model, requestId: res.responseId ?? null };
}

/** The label, 42% of the width, bottom-left inside a 3% margin; the result is a JPEG. */
export async function labelImage(bytes: Uint8Array): Promise<Uint8Array> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const label = await sharp(LABEL).resize({ width: Math.round(W * 0.42) }).png().toBuffer();
  const lh = (await sharp(label).metadata()).height ?? 50;
  const m = Math.round(W * 0.03);
  return new Uint8Array(await sharp(bytes).composite([{ input: label, left: m, top: H - lh - m }]).jpeg({ quality: 90 }).toBuffer());
}

const run = promisify(execFile);
export function ffmpegPath() {
  const p = ffmpegInstaller.path;
  try {
    accessSync(p, constants.X_OK);
  } catch {
    chmodSync(p, 0o755); // the package's install step, skipped by pnpm, only marks it executable
  }
  return p;
}

/** The same label on every frame of the video (H.264, silent, fast start). */
export async function labelVideo(mp4: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "facevisa-video-"));
  try {
    writeFileSync(join(dir, "in.mp4"), mp4);
    await run(
      ffmpegPath(),
      [
        "-y", "-i", join(dir, "in.mp4"), "-i", LABEL,
        "-filter_complex", "[1:v][0:v]scale2ref=w=main_w*0.42:h=ow/mdar[lbl][base];[base][lbl]overlay=x=main_w*0.03:y=main_h-overlay_h-main_h*0.04",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
        join(dir, "out.mp4"),
      ],
      { timeout: 180_000, maxBuffer: 16 << 20 },
    );
    return new Uint8Array(readFileSync(join(dir, "out.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A frame one second in, as a JPEG: the video's poster in galleries. */
export async function videoPoster(mp4: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "facevisa-poster-"));
  try {
    writeFileSync(join(dir, "in.mp4"), mp4);
    await run(ffmpegPath(), ["-y", "-ss", "1", "-i", join(dir, "in.mp4"), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", join(dir, "poster.jpg")], { timeout: 60_000 });
    return new Uint8Array(readFileSync(join(dir, "poster.jpg")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function vertexGenerator(): AdGenerator {
  return {
    check: (text) => checkBrief(text),
    image: async ({ brief, prompt, photo }) => {
      const out = await geminiImage(prompt ?? stillPrompt(brief, "image"), photo, "image");
      return { bytes: await labelImage(out.bytes), mime: "image/jpeg", model: out.model };
    },
    video: async ({ brief, prompt, motion, photo, onProgress }) => {
      onProgress?.("generating the opening frame");
      const still = await geminiImage(prompt ?? stillPrompt(brief, "video"), photo, "video");
      const jpeg = new Uint8Array(await sharp(still.bytes).jpeg({ quality: 92 }).toBuffer());
      onProgress?.("generating the video (Veo, about 1 to 3 minutes)");
      const mp4 = await imageToVideo({ image: jpeg, mime: "image/jpeg", prompt: motion ?? motionPrompt(brief), seconds: VIDEO_SECONDS, aspectRatio: "16:9" });
      onProgress?.("adding the AI label");
      return { bytes: await labelVideo(mp4), mime: "video/mp4", model: `${still.model} + ${models.video()}` };
    },
  };
}
