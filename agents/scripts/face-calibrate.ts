// pnpm face:calibrate [-- --db=local,local-demo-x402-20261104,…] [--photos <dir>] [--generated <dir>]: the face gate's score distribution
// on real data, to set CONSENT_FACE_MATCH_THRESHOLD. Reads local databases (accounts/<folder>/accounts.sqlite, default
// accounts/local) read-only, with the backend stopped or running, and the face models in .models/. Every database's
// ads are pooled, each file once (by its sha256). Prints numbers only: no images, no names beyond display names.
//
//   genuine-model      each ad made by a model (image, or a video's opening frame) vs its own creator's capture
//   genuine-test       each TEST RENDER vs its creator's capture: it pastes the capture itself, so it's reported but
//                      never used for the proposal
//   genuine-photos     other photos of the same person (--photos <dir>/<display name>/*.jpg|png) vs their capture
//                      (--generated <dir>, the same layout: model-made images outside the app, counted as model)
//   impostor-*         the same, against every OTHER face's capture
//
// Creators are grouped into faces first: several test creators share one synthetic photo, and an ad compared with
// another creator of the same face is neither genuine nor impostor evidence. Each other face counts once.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../src/ai/generate.js";
import { analyseFaces, cosine, referenceEmbeddings } from "../src/face/match.js";
import { modelsPresent } from "../src/face/models.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dbs = (process.argv.find((a) => a.startsWith("--db="))?.slice(5) || "local").split(",").filter(Boolean);
const arg = (k: string) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const extra = arg("--photos");
const generated = arg("--generated");

if (!modelsPresent()) throw new Error("the face models aren't in .models/: run `pnpm face:models` first");
type Creator = { uid: string; name: string; refs: Float32Array[] };
type Ad = { creator: string; mime: string; provider: string; model: string };
const creators: Creator[] = [];
// Each ad once, by its file's sha256 (database copies share renders/ and often the same ads).
const ads = new Map<string, Ad>();
for (const folder of dbs) {
  const dbFile = `${root}accounts/${folder}/accounts.sqlite`;
  if (!existsSync(dbFile)) throw new Error(`no database at accounts/${folder}`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  // A creator's uid is the same in every copy (same issuer, same subject): the first capture found is theirs.
  for (const r of db.prepare("select uid, name, capture_files from creator_profiles where capture_files is not null").all() as { uid: string; name: string; capture_files: string }[]) {
    if (creators.some((c) => c.uid === r.uid)) continue;
    const frames = (JSON.parse(r.capture_files) as string[]).map((f) => join(`${root}accounts/${folder}/photos`, f)).filter(existsSync).map((p) => new Uint8Array(readFileSync(p)));
    const refs = await referenceEmbeddings(frames);
    if (refs.length) creators.push({ uid: r.uid, name: r.name, refs });
  }
  for (const r of db.prepare("select creator, output from pending_actions where output is not null").all() as { creator: string; output: string }[]) {
    const o = JSON.parse(r.output) as { hash: string; mime: string; provider?: string; model?: string };
    if (!ads.has(o.hash.toLowerCase())) ads.set(o.hash.toLowerCase(), { creator: r.creator, mime: o.mime, provider: o.provider ?? "unknown", model: o.model ?? "unknown" });
  }
  db.close();
}
if (!creators.length) throw new Error("no creator has a live capture yet");

const best = (e: Float32Array, refs: Float32Array[]) => Math.max(...refs.map((r) => cosine(r, e)));
// Faces: creators whose captures match each other (the same photo scores ~1.0; different people stay far below 0.8).
type Face = { names: string[]; uids: Set<string>; refs: Float32Array[] };
const faces: Face[] = [];
for (const c of creators) {
  const f = faces.find((x) => Math.max(...c.refs.map((r) => best(r, x.refs))) > 0.8);
  if (f) (f.names.push(c.name), f.uids.add(c.uid));
  else faces.push({ names: [c.name], uids: new Set([c.uid]), refs: c.refs });
}
const faceOf = (uid: string) => faces.find((f) => f.uids.has(uid))!;
/** The best face's embedding in an image (a video: its frame at 1 s), or null when there's no face. */
async function embedding(bytes: Uint8Array, mime: string): Promise<Float32Array | null> {
  let img = bytes;
  if (mime.startsWith("video/")) {
    const dir = mkdtempSync(join(tmpdir(), "likeness-cal-"));
    try {
      writeFileSync(join(dir, "in.mp4"), bytes);
      execFileSync(ffmpegPath(), ["-y", "-ss", "1", "-i", join(dir, "in.mp4"), "-frames:v", "1", join(dir, "f.jpg")], { stdio: "ignore" });
      img = new Uint8Array(readFileSync(join(dir, "f.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return (await analyseFaces(img, { embed: true })).embedding;
}

const scores: Record<string, number[]> = { "genuine-model": [], "genuine-test": [], "genuine-photos": [], "impostor-model": [], "impostor-test": [], "impostor-photos": [] };
let noFace = 0;
const add = (kind: "model" | "test" | "photos", owner: string, e: Float32Array) => {
  for (const f of faces) scores[`${f.uids.has(owner) ? "genuine" : "impostor"}-${kind}`]!.push(best(e, f.refs));
};
// Each model-made ad, one line: who, which model, its score against its own creator and the best other creator.
const perAd: string[] = [];

// Every ad the agent made (released or not) has its file in renders/ under its sha256.
let missing = 0;
for (const [hash, ad] of ads) {
  const file = `${root}renders/${hash}.bin`;
  if (!existsSync(file)) {
    missing++;
    continue;
  }
  const owner = creators.find((c) => c.uid === ad.creator);
  if (!owner) continue; // its creator's capture is in none of these databases
  const e = await embedding(new Uint8Array(readFileSync(file)), ad.mime);
  if (!e) {
    noFace++;
    continue;
  }
  const kind = ad.provider === "test" ? "test" : "model";
  add(kind, ad.creator, e);
  if (kind === "model") {
    const others = faces.filter((f) => !f.uids.has(ad.creator)).map((f) => best(e, f.refs));
    perAd.push(`  ${best(e, faceOf(ad.creator).refs).toFixed(3)}  best other ${others.length ? Math.max(...others).toFixed(3) : "  -  "}  ${ad.mime.startsWith("video/") ? "video" : "image"}  ${ad.model} (${ad.provider})  ${owner.name}`);
  }
}
// Other photos of the same people (--photos), and model-made images outside the app (--generated), by display name.
for (const [dir, kind] of [[extra, "photos"], [generated, "model"]] as const) {
  if (!dir) continue;
  for (const person of readdirSync(dir).filter((p) => statSync(join(dir, p)).isDirectory())) {
    const c = creators.find((x) => x.name.toLowerCase() === person.toLowerCase());
    if (!c) {
      console.log(`(skipped ${person}/: no creator with that display name has a capture)`);
      continue;
    }
    for (const f of readdirSync(join(dir, person)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
      const e = await embedding(new Uint8Array(readFileSync(join(dir, person, f))), "image/*");
      if (!e) {
        noFace++;
        continue;
      }
      add(kind, c.uid, e);
      if (kind === "model") {
        const others = faces.filter((x) => !x.uids.has(c.uid)).map((x) => best(e, x.refs));
        perAd.push(`  ${best(e, faceOf(c.uid).refs).toFixed(3)}  best other ${others.length ? Math.max(...others).toFixed(3) : "  -  "}  image  ${f} (--generated)  ${c.name}`);
      }
    }
  }
}

const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))]!;
console.log(`databases: ${dbs.join(", ")}; creators with a capture: ${creators.length}; faces: ${faces.length}; ads: ${ads.size} (${missing} files missing); no face found: ${noFace}`);
for (const [i, f] of faces.entries()) console.log(`  face ${i + 1}: ${f.names.join(", ")}`);
if (perAd.length) console.log(`model-made ads (own creator, best other creator, kind, model, creator):\n${perAd.sort().join("\n")}`);
console.log("class                 n     min    p10    median p90    max");
for (const [k, v] of Object.entries(scores)) {
  const xs = [...v].sort((a, b) => a - b);
  console.log(xs.length ? `${k.padEnd(20)} ${String(xs.length).padStart(3)}  ${[xs[0]!, q(xs, 0.1), q(xs, 0.5), q(xs, 0.9), xs.at(-1)!].map((x) => x.toFixed(3)).join("  ")}` : `${k.padEnd(20)}   0`);
}
// Test renders paste the capture itself: never part of the proposal.
const genuine = [...scores["genuine-model"]!, ...scores["genuine-photos"]!];
const impostor = [...scores["impostor-model"]!, ...scores["impostor-photos"]!];
if (genuine.length && impostor.length) {
  const lo = Math.min(...genuine);
  const hi = Math.max(...impostor);
  console.log(
    lo > hi
      ? `separable: every impostor ≤ ${hi.toFixed(3)} < every genuine ≥ ${lo.toFixed(3)}; proposed CONSENT_FACE_MATCH_THRESHOLD=${((lo + hi) / 2).toFixed(2)} (the midpoint)`
      : `overlap: impostors reach ${hi.toFixed(3)}, genuine go down to ${lo.toFixed(3)}; no threshold separates them on this data`,
  );
} else console.log("need both genuine and impostor scores for a proposal (at least two creators with captures)");
