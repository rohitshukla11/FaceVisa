/**
 * Local face detection and 1:1 matching: are the live capture's frames one person, and is the creator's face in a
 * generated ad? Runs on this server, in memory. Copied from Rohit's earlier face project (lib/server/facematch.ts @93993bc); see
 * CHANGES.md.
 *
 *   detect (YuNet, OpenCV Zoo, MIT weights) → 5 landmarks → similarity transform to the standard
 *   112×112 ArcFace template (as OpenCV FaceRecognizerSF::alignCrop) → embed (AuraFace v1
 *   glintr100, fal, Apache-2.0 weights) → cosine similarity of L2-normalised 512-d embeddings.
 *
 * Runtime: onnxruntime-node (MIT), CPU. Models: `pnpm face:models` in agents/ (sha256-pinned, in .models/ at the
 * repo root). With FACE_MODELS_FETCH=1 they are fetched from the same pinned URLs on first use and checked against
 * the same sha256 before loading.
 * Licence caveats, stated plainly: YuNet's weights are MIT but it was trained on WIDER FACE
 * (CC BY-NC-ND images); AuraFace's training set is described by fal as commercially usable but not
 * named.
 */
import path from "node:path";
import sharp from "sharp";
import { ensureModels } from "./models.js";

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

const DET_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
// 112×112 ArcFace template, in YuNet's landmark order: right eye, left eye, nose tip, right and left
// mouth corners (subject's right is image left). opencv modules/objdetect/src/face_recognize.cpp.
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
] as const;

export class FaceMatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const models = { ort: null as Ort | null, det: null as Session | null, rec: null as Session | null };

/** Load the face models now (server start), so the first render doesn't wait for them. */
export async function warmFaceModels(): Promise<void> {
  await load();
}

async function load() {
  if (models.det && models.rec && models.ort) return models as { ort: Ort; det: Session; rec: Session };
  let dir: string;
  try {
    dir = await ensureModels();
  } catch (e) {
    throw new FaceMatchError(503, `local face matcher models missing: ${(e as Error).message}`);
  }
  const ort = await import("onnxruntime-node");
  try {
    models.det = await ort.InferenceSession.create(path.join(dir, "face_detection_yunet_2023mar.onnx"), { logSeverityLevel: 3 });
    models.rec = await ort.InferenceSession.create(path.join(dir, "auraface_glintr100.onnx"), { logSeverityLevel: 3 });
  } catch {
    throw new FaceMatchError(503, "local face matcher models missing: run `pnpm face:models` in agents/");
  }
  models.ort = ort;
  return models as { ort: Ort; det: Session; rec: Session };
}

type Image = { data: Uint8Array; width: number; height: number }; // RGB, upright
export type Face = { score: number; box: [number, number, number, number]; landmarks: [number, number][] };

async function decode(bytes: Uint8Array): Promise<Image> {
  const { data, info } = await sharp(bytes).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** YuNet on a 640×640 letterbox (resize to fit, pad bottom/right), BGR 0–255 as OpenCV feeds it. */
export async function detectFaces(img: Image, minScore = 0.8): Promise<Face[]> {
  const { ort, det } = await load();
  const scale = Math.min(DET_SIZE / img.width, DET_SIZE / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const resized = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h).raw().toBuffer();
  const input = new Float32Array(3 * DET_SIZE * DET_SIZE);
  const plane = DET_SIZE * DET_SIZE;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = y * DET_SIZE + x;
      input[d] = resized[s + 2]!; // B
      input[plane + d] = resized[s + 1]!; // G
      input[2 * plane + d] = resized[s]!; // R
    }
  const out = await det.run({ input: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]) });

  const faces: Face[] = [];
  for (const stride of STRIDES) {
    const cols = DET_SIZE / stride;
    const cls = out[`cls_${stride}`]!.data as Float32Array;
    const obj = out[`obj_${stride}`]!.data as Float32Array;
    const bbox = out[`bbox_${stride}`]!.data as Float32Array;
    const kps = out[`kps_${stride}`]!.data as Float32Array;
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(Math.min(Math.max(cls[idx]!, 0), 1) * Math.min(Math.max(obj[idx]!, 0), 1));
      if (score < minScore) continue;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const cx = (c + bbox[idx * 4]!) * stride;
      const cy = (r + bbox[idx * 4 + 1]!) * stride;
      const bw = Math.exp(bbox[idx * 4 + 2]!) * stride;
      const bh = Math.exp(bbox[idx * 4 + 3]!) * stride;
      const landmarks: [number, number][] = [];
      for (let n = 0; n < 5; n++) landmarks.push([((kps[idx * 10 + 2 * n]! + c) * stride) / scale, ((kps[idx * 10 + 2 * n + 1]! + r) * stride) / scale]);
      faces.push({ score, box: [(cx - bw / 2) / scale, (cy - bh / 2) / scale, bw / scale, bh / scale], landmarks });
    }
  }
  return nms(faces, 0.3);
}

function iou(a: Face["box"], b: Face["box"]) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

function nms(faces: Face[], threshold: number): Face[] {
  const keep: Face[] = [];
  for (const f of faces.sort((a, b) => b.score - a.score)) if (keep.every((k) => iou(k.box, f.box) <= threshold)) keep.push(f);
  return keep;
}

/** Least-squares similarity transform (Umeyama, no reflection) mapping src points onto dst. */
export function similarity(src: readonly (readonly number[])[], dst: readonly (readonly number[])[]) {
  const n = src.length;
  const mean = (p: readonly (readonly number[])[]) => [p.reduce((s, q) => s + q[0]!, 0) / n, p.reduce((s, q) => s + q[1]!, 0) / n] as const;
  const [sx, sy] = mean(src);
  const [dx, dy] = mean(dst);
  let a = 0;
  let b = 0;
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i]![0]! - sx;
    const ys = src[i]![1]! - sy;
    const xd = dst[i]![0]! - dx;
    const yd = dst[i]![1]! - dy;
    a += xs * xd + ys * yd;
    b += xs * yd - ys * xd;
    varS += xs * xs + ys * ys;
  }
  // dst ≈ [[p, -q], [q, p]] · src + t
  const p = a / varS;
  const q = b / varS;
  return { p, q, tx: dx - (p * sx - q * sy), ty: dy - (q * sx + p * sy) };
}

/** Warp the face to 112×112 with bilinear sampling, as AuraFace input: RGB, (x − 127.5) / 127.5, CHW. */
function alignedInput(img: Image, landmarks: [number, number][]): Float32Array {
  const { p, q, tx, ty } = similarity(landmarks, TEMPLATE);
  const det = p * p + q * q;
  const out = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let y = 0; y < 112; y++)
    for (let x = 0; x < 112; x++) {
      // inverse map: src = M⁻¹ (dst − t)
      const u = x - tx;
      const v = y - ty;
      const sx = (p * u + q * v) / det;
      const sy = (-q * u + p * v) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const px = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height ? 0 : img.data[(yy * img.width + xx) * 3 + ch]!);
        const val = px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
        out[ch * plane + y * 112 + x] = (val - 127.5) / 127.5;
      }
    }
  return out;
}

async function embed(img: Image, face: Face): Promise<Float32Array> {
  const { ort, rec } = await load();
  const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", alignedInput(img, face.landmarks), [1, 3, 112, 112]) });
  const v = out[rec.outputNames[0]!]!.data as Float32Array;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Add a dark border: detectors miss faces that fill the whole frame (a liveness capture can be a tight crop). */
async function padded(img: Image): Promise<Image> {
  const m = Math.round(Math.max(img.width, img.height) * 0.4);
  const { data, info } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .extend({ top: m, bottom: m, left: m, right: m, background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  img.data.fill(0);
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

async function onlyFace(bytes: Uint8Array, label: string): Promise<{ img: Image; face: Face }> {
  let img = await decode(bytes);
  let faces = await detectFaces(img);
  if (faces.length === 0) {
    img = await padded(img);
    faces = await detectFaces(img);
  }
  if (faces.length === 0) throw new FaceMatchError(422, `no face found in ${label}`);
  // Captures must show exactly one face.
  if (faces.length > 1 && faces[1]!.score > 0.9) throw new FaceMatchError(422, `${label} shows more than one face`);
  return { img, face: faces[0]! };
}

/** Cosine similarity (−1…1) between the faces in two images. Buffers are zeroed after use. */
export async function compareFaces(a: Uint8Array, b: Uint8Array): Promise<number> {
  const A = await onlyFace(a, "the photo");
  const B = await onlyFace(b, "the liveness selfie");
  try {
    const [ea, eb] = await Promise.all([embed(A.img, A.face), embed(B.img, B.face)]);
    return ea.reduce((s, x, i) => s + x * eb[i]!, 0);
  } finally {
    A.img.data.fill(0);
    B.img.data.fill(0);
  }
}

/**
 * Same person at or above this cosine similarity. Calibrated 2026-10-10 on a small set: one person's
 * three real photos scored 0.62–0.74 against each other; that person against six invented (Gemini)
 * faces scored at most 0.24; the invented faces against each other at most 0.54. 0.55 sits above every
 * impostor pair seen. Small sample: recalibrate on real data before relying on it.
 */
export const localThreshold = () => Number(process.env.LOCAL_FACE_MATCH_THRESHOLD ?? 0.55);

/** The faces YuNet finds in an image (decoded upright), best first. Used to check a channel avatar is a photo of a face. */
export async function facesIn(bytes: Uint8Array): Promise<{ count: number; best: number }> {
  let img = await decode(bytes);
  let faces = await detectFaces(img);
  if (faces.length === 0) {
    img = await padded(img);
    faces = await detectFaces(img);
  }
  img.data.fill(0);
  return { count: faces.length, best: faces[0]?.score ?? 0 };
}

/**
 * Faces in one image, in its own pixel coordinates (best first), and optionally the best face's
 * embedding. No padding retry: a face cut by the frame edge should count as cut. Used for
 * label placement and the consent gate's face check. The decoded pixels are zeroed after use.
 */
/** With `embedAll`, every face found (at most 8) is embedded, best first; `embedding` is always the best face's. */
export async function analyseFaces(
  bytes: Uint8Array,
  opts: { embed?: boolean; embedAll?: boolean; minScore?: number } = {},
): Promise<{ width: number; height: number; faces: Face[]; embedding: Float32Array | null; embeddings: Float32Array[] }> {
  const img = await decode(bytes);
  try {
    const faces = await detectFaces(img, opts.minScore ?? 0.8);
    const embeddings: Float32Array[] = [];
    if (opts.embedAll) for (const f of faces.slice(0, 8)) embeddings.push(await embed(img, f));
    const embedding = embeddings[0] ?? (opts.embed && faces[0] ? await embed(img, faces[0]) : null);
    return { width: img.width, height: img.height, faces, embedding, embeddings };
  } finally {
    img.data.fill(0);
  }
}

/** Embeddings of a creator's reference frames (tight liveness crops, so padded like the match). */
export async function referenceEmbeddings(frames: Uint8Array[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const f of frames) {
    const { img, face } = await onlyFace(f, "a reference frame").catch(() => ({ img: null, face: null }));
    if (!img || !face) continue;
    try {
      out.push(await embed(img, face));
    } finally {
      img.data.fill(0);
    }
  }
  return out;
}

export const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
