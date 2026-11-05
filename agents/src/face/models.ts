/**
 * The local face matcher's weights (face/match.ts): where they live, and, when FACE_MODELS_FETCH=1, fetching them on
 * first use, checked against the same sha256 pins as scripts/face-models.sh before anything loads them.
 * Copied from likeness-meta (lib/server/facemodels.ts @93993bc); see CHANGES.md.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** The weights, pinned by sha256: the same files and hashes as scripts/face-models.sh. */
const MODELS = [
  {
    file: "face_detection_yunet_2023mar.onnx",
    url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  },
  {
    file: "auraface_glintr100.onnx",
    url: "https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx",
    sha256: "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60",
  },
] as const;

/** Where the weights live: FACE_MODELS_DIR, else .models at the repo root (git-ignored; `pnpm face:models`). */
export function modelsDir(): string {
  return process.env.FACE_MODELS_DIR ? path.resolve(process.env.FACE_MODELS_DIR) : fileURLToPath(new URL("../../../.models", import.meta.url));
}

/** Fetch missing weights on first use only when FACE_MODELS_FETCH=1. */
export function modelsFetchable(): boolean {
  return process.env.FACE_MODELS_FETCH === "1";
}

export function modelsPresent(): boolean {
  return MODELS.every((m) => existsSync(path.join(modelsDir(), m.file)));
}

async function download(m: (typeof MODELS)[number], dir: string) {
  const out = path.join(dir, m.file);
  if (existsSync(out)) return;
  const r = await fetch(m.url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`model download failed (${r.status}) for ${m.file}`);
  const hash = createHash("sha256");
  const part = `${out}.${process.pid}.part`;
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(r.body as never), tap, createWriteStream(part));
    const got = hash.digest("hex");
    if (got !== m.sha256) throw new Error(`sha256 mismatch for ${m.file}: ${got}`);
    await rename(part, out);
  } finally {
    await rm(part, { force: true });
  }
}

const fetching = { p: null as Promise<void> | null };

/** Make sure the weights are on disk, fetching them once per instance if allowed. */
export async function ensureModels(): Promise<string> {
  const dir = modelsDir();
  if (modelsPresent() || !modelsFetchable()) return dir;
  fetching.p ??= (async () => {
    await mkdir(dir, { recursive: true });
    for (const m of MODELS) await download(m, dir);
  })().finally(() => {
    fetching.p = null;
  });
  await fetching.p;
  return dir;
}
