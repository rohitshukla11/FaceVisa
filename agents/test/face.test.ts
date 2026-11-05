import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/**
 * The real local face matcher (face/, copied from likeness-meta) on real images, when its models are in .models/
 * (`pnpm face:models`); skipped otherwise. The rest of the suite runs without the models.
 */
const models = fileURLToPath(new URL("../../.models", import.meta.url));
const have = (() => {
  try {
    return readFileSync(`${models}/auraface_glintr100.onnx`).length > 0 && readFileSync(`${models}/face_detection_yunet_2023mar.onnx`).length > 0;
  } catch {
    return false;
  }
})();
// No stranger's face (4 Nov): the synthetic demo creator (a person who doesn't exist), a face-free card, and, for the
// "someone else" checks, a second synthetic face if it has been made (agents/assets/synthetic-other.jpg).
const asset = (f: string) => fileURLToPath(new URL(`../assets/${f}`, import.meta.url));
const img = (f: string) => new Uint8Array(readFileSync(f.endsWith(".png") ? fileURLToPath(new URL(`../../web/public/landing/${f}`, import.meta.url)) : asset(f)));
const FACE = "synthetic-demo-creator.jpg";
const OTHER = "synthetic-other.jpg";
const haveOther = existsSync(asset(OTHER));

describe.skipIf(!have)("the local face gate (YuNet + AuraFace) on real images", () => {
  const saved = process.env.FACE_MODELS_DIR;
  beforeAll(() => {
    process.env.FACE_MODELS_DIR = models;
  });
  afterAll(() => {
    process.env.FACE_MODELS_DIR = saved;
  });

  it("finds faces, and none in a picture without one", async () => {
    const { facesIn } = await import("../src/face/match.js");
    expect((await facesIn(img(FACE))).count).toBe(1);
    expect((await facesIn(img("card-lime.png"))).count).toBe(0);
  }, 60_000);

  it("the gate passes the creator's own face and refuses a picture without one", async () => {
    const { localFaceCheck } = await import("../src/likeness/face.js");
    const check = localFaceCheck();
    const refs = [{ bytes: img(FACE), mime: "image/jpeg" }];
    const same = await check.check(refs, { bytes: img(FACE), mime: "image/jpeg" });
    expect(same).toMatchObject({ ran: true, match: true });
    const none = await check.check(refs, { bytes: img("card-lime.png"), mime: "image/png" });
    expect(none).toMatchObject({ ran: true, match: false, score: null });
  }, 60_000);

  it.skipIf(!haveOther)("the gate refuses someone else's face (needs a second synthetic face)", async () => {
    const { localFaceCheck } = await import("../src/likeness/face.js");
    const other = await localFaceCheck().check([{ bytes: img(FACE), mime: "image/jpeg" }], { bytes: img(OTHER), mime: "image/jpeg" });
    expect(other).toMatchObject({ ran: true, match: false });
    expect(other.score!).toBeLessThan(0.35);
  }, 60_000);

  it("a live capture of one person passes", async () => {
    const { verifyCapture } = await import("../src/likeness/face.js");
    await expect(verifyCapture([img(FACE), img(FACE), img(FACE)])).resolves.toBeUndefined();
  }, 60_000);

  it.skipIf(!haveOther)("a live capture must show the same person in every frame (needs a second synthetic face)", async () => {
    const { verifyCapture } = await import("../src/likeness/face.js");
    await expect(verifyCapture([img(FACE), img(OTHER), img(FACE)])).rejects.toThrow(/same person/);
  }, 60_000);
});
