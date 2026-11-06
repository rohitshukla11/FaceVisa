/**
 * A creator profile for a World ID account: a LIVE camera capture (three frames: front, slight left, slight right,
 * taken in the browser with a blink-and-turn liveness check; no file uploads), stored only with the creator's explicit
 * consent, JPEG metadata stripped; the front frame is what the model is given, all three are what the face gate
 * compares against. Optionally, a verified YouTube channel (app/youtube.ts; never required to list). No wallet, no chain: the creator's
 * rules and every licence live in the FaceVisa data layer (facevisa/data.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Accounts, CreatorRow } from "./accounts.js";

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;

export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function photoType(b: Buffer): { mime: string; ext: string } | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return undefined;
}

/** Drops a JPEG's APP1 (EXIF/XMP, which can hold GPS and the camera) and comment segments. */
export function stripJpegMetadata(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = b.readUInt16BE(i + 2);
    if (marker !== 0xe1 && marker !== 0xfe) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}

export class Onboarding {
  constructor(private readonly c: { accounts: Accounts; photosDir: string }) {
    mkdirSync(c.photosDir, { recursive: true });
  }

  /** The account's creator profile, made on first use. */
  start(uid: string, name: string): CreatorRow {
    return this.c.accounts.creator(uid) ?? this.c.accounts.createCreator(uid, name);
  }

  /**
   * The live capture: exactly three JPEG frames from the camera, with consent. `verify` (the local face matcher, when
   * its models are present) checks they show one person; the browser's liveness flags are recorded, not trusted.
   */
  async saveCapture(uid: string, frames: Buffer[], liveness: { blinks: number; turnedLeft: boolean; turnedRight: boolean }, consent: boolean, verify?: (frames: Uint8Array[]) => Promise<void>) {
    if (!consent) throw new OnboardingError(400, "tick the consent box to use your live capture");
    if (frames.length !== 3) throw new OnboardingError(400, "the capture needs three frames: front, slight left, slight right");
    if (!(liveness.blinks >= 1 && liveness.turnedLeft && liveness.turnedRight)) throw new OnboardingError(400, "the liveness steps weren't completed: blink, then turn each way");
    const clean = frames.map((f) => {
      if (f.length > PHOTO_MAX_BYTES) throw new OnboardingError(413, "a frame is larger than 3 MB");
      if (photoType(f)?.mime !== "image/jpeg") throw new OnboardingError(415, "the frames must come from the camera (JPEG)");
      return stripJpegMetadata(f);
    });
    if (verify) {
      try {
        await verify(clean);
      } catch (e) {
        throw new OnboardingError(422, (e as Error).message);
      }
    }
    const files = clean.map((_, i) => `${uid}-capture-${i}.jpg`);
    clean.forEach((f, i) => writeFileSync(join(this.c.photosDir, files[i]!), f));
    const sha = `0x${createHash("sha256").update(clean[0]!).digest("hex")}`;
    return this.c.accounts.updateCreator(uid, {
      photoFile: files[0]!,
      photoMime: "image/jpeg",
      photoSha256: sha,
      captureFiles: JSON.stringify(files),
      liveness: JSON.stringify({ ...liveness, at: Date.now() }),
      consentAt: Date.now(),
    });
  }

  /** Every frame of the creator's live capture (front first). */
  captureFrames(row: CreatorRow): { bytes: Buffer; mime: string }[] {
    const files = row.captureFiles ? (JSON.parse(row.captureFiles) as string[]) : row.photoFile ? [row.photoFile] : [];
    return files.map((f) => join(this.c.photosDir, f)).filter((p) => existsSync(p)).map((p) => ({ bytes: readFileSync(p), mime: "image/jpeg" }));
  }

  photo(row: CreatorRow): { bytes: Buffer; mime: string } | undefined {
    if (!row.photoFile || !row.photoMime) return undefined;
    const p = join(this.c.photosDir, row.photoFile);
    return existsSync(p) ? { bytes: readFileSync(p), mime: row.photoMime } : undefined;
  }
}
