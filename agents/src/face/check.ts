/**
 * Face checks on a generated image (the gate on every output; copied from Rohit's earlier face project, lib/server/facecheck.ts
 * @93993bc, see CHANGES.md):
 *   YuNet: which faces are in the image, and is the best one fully inside the frame (box, headroom and
 *   all five landmarks)? → AuraFace: how closely does it match the creator's reference frames (best
 *   cosine similarity over the references)?
 * Runs locally on this server; the decoded pixels and the embedding are zeroed after use.
 */
import { analyseFaces, cosine, type Face } from "./match.js";

/**
 * Generated images match their source less closely than live photos do, so this check has its own
 * threshold. Calibrated 2026-10-17 in facevisa-ai (small sample): a Gemini still of a demo creator
 * scored 0.57 against the creator's references and video frames made from it 0.43–0.55; a real
 * person against invented faces scored at most 0.24 (facematch.ts). 0.35 sits between the two.
 * Recalibrate for this app's providers (Vertex, 0G) on real data before relying on it.
 */
export const consentThreshold = () => Number(process.env.CONSENT_FACE_MATCH_THRESHOLD ?? 0.35);

/** A face is fully visible when its box, with a little headroom, and its landmarks are inside the image. */
export function fullyVisible(f: Pick<Face, "box" | "landmarks">, W: number, H: number): boolean {
  const [x, y, w, h] = f.box;
  const inBox = x >= 0 && y - h * 0.1 >= 0 && x + w <= W && y + h <= H;
  const inMarks = f.landmarks.every(([lx, ly]) => lx >= 0 && ly >= 0 && lx <= W && ly <= H);
  return inBox && inMarks;
}

/** Best cosine similarity of one embedding against the creator's reference embeddings, or null without any. */
export function bestSimilarity(embedding: Float32Array | null, refs: Float32Array[]): number | null {
  if (!embedding || !refs.length) return null;
  return Math.max(...refs.map((r) => cosine(r, embedding)));
}

export type ImageFaceCheck = {
  width: number;
  height: number;
  /** Faces YuNet found, best first, as fractions of the image, each with its match to the creator (the first 8). */
  faces: { x: number; y: number; w: number; h: number; score: number; similarity?: number | null; fullyVisible?: boolean }[];
  /** The best face is fully inside the image. */
  fullyVisible: boolean;
  /** The best face's similarity to the creator (null when there is no face or no reference). */
  similarity: number | null;
  threshold: number;
  matches: boolean;
};

/** Faces in a generated image, and whether the best one is the creator. `refs` are the creator's reference embeddings. */
export async function checkImageFaces(bytes: Uint8Array, refs: Float32Array[]): Promise<ImageFaceCheck> {
  const a = await analyseFaces(bytes, { embedAll: true });
  try {
    const best = a.faces[0];
    const similarity = bestSimilarity(a.embedding, refs);
    const threshold = consentThreshold();
    return {
      width: a.width,
      height: a.height,
      faces: a.faces.map((f, i) => ({
        x: f.box[0] / a.width,
        y: f.box[1] / a.height,
        w: f.box[2] / a.width,
        h: f.box[3] / a.height,
        score: f.score,
        similarity: i < a.embeddings.length ? bestSimilarity(a.embeddings[i]!, refs) : null,
        fullyVisible: fullyVisible(f, a.width, a.height),
      })),
      fullyVisible: !!best && fullyVisible(best, a.width, a.height),
      similarity,
      threshold,
      matches: similarity !== null && similarity >= threshold,
    };
  } finally {
    a.embedding?.fill(0);
    a.embeddings.forEach((e) => e.fill(0));
  }
}
