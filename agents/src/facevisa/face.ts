/**
 * The face gate on every output, with the local matcher (face/: YuNet + AuraFace on onnxruntime-node, models in
 * .models/): the ad (a video's opening still) must show the creator, matched against their live-capture frames
 * (CONSENT_FACE_MATCH_THRESHOLD, default 0.35), with the face fully in the frame. Without the models the gate can't
 * run, and receipts say "not-run".
 */
import { createHash } from "node:crypto";
import { checkImageFaces } from "../face/check.js";
import { analyseFaces, compareFaces, cosine, localThreshold, referenceEmbeddings } from "../face/match.js";
import { modelsPresent } from "../face/models.js";
import type { FaceCheck, Photo } from "./pipeline.js";

export const faceModelsPresent = modelsPresent;

/** The local face check: references are the creator's capture frames (their embeddings cached per set). */
export function localFaceCheck(): FaceCheck {
  const cache = new Map<string, Float32Array[]>();
  return {
    name: "local",
    async check(references: Photo[], output: Photo) {
      const key = createHash("sha256").update(Buffer.concat(references.map((r) => Buffer.from(r.bytes)))).digest("hex");
      let refs = cache.get(key);
      if (!refs) {
        refs = await referenceEmbeddings(references.map((r) => r.bytes));
        if (cache.size > 200) cache.clear();
        cache.set(key, refs);
      }
      if (!refs.length) return { ran: true, match: false, score: null };
      const r = await checkImageFaces(output.bytes, refs);
      return { ran: true, match: r.matches && r.fullyVisible, score: r.similarity };
    },
  };
}

/**
 * A live capture is the creator's reference: each frame shows exactly one face, and the side frames are the same
 * person as the front one (LOCAL_FACE_MATCH_THRESHOLD, default 0.55). Throws with a reason a person understands.
 */
export async function verifyCapture(frames: Uint8Array[]): Promise<void> {
  const [front, ...sides] = frames;
  for (const side of sides) {
    const score = await compareFaces(front!, side);
    if (score < localThreshold()) throw new Error(`the frames don't show the same person (${score.toFixed(2)}): capture again, alone in the frame`);
  }
}

/**
 * The channel face match: for each public channel image, the best similarity of any face in it to the creator's capture
 * frames, or null when the image has no face (a logo, a graphic). Embeddings are zeroed after use.
 */
export async function channelScores(references: Photo[], images: Uint8Array[]): Promise<(number | null)[]> {
  const refs = await referenceEmbeddings(references.map((r) => r.bytes));
  if (!refs.length) return images.map(() => null);
  const out: (number | null)[] = [];
  for (const img of images) {
    try {
      const a = await analyseFaces(img, { embedAll: true });
      out.push(a.embeddings.length ? Math.max(...a.embeddings.map((e) => Math.max(...refs.map((r) => cosine(r, e))))) : null);
      a.embeddings.forEach((e) => e.fill(0));
    } catch {
      out.push(null); // undecodable: not counted as a face
    }
  }
  refs.forEach((r) => r.fill(0));
  return out;
}
