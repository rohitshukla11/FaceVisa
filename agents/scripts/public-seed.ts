// The public demo's data (deploy/remote.sh seed runs this on the VM, against the live site, with demo identities):
//   - Rohit Shukla: his own live capture (his consent: the public demo during the hackathon), $0.05 per image;
//   - Asha (synthetic demo creator): an AI-generated face of a person who doesn't exist, $0.08 per image;
//   - Acme Running Co (demo brand), whose agent asks for three real 0G images (~$0.08) and one video (a 0G still and
//     a Veo clip, ~$0.27): Rohit's image, approved and paid on Hedera; Asha's image, denied; Asha's image, paid then
//     revoked; Asha's video at $0.24, over the $0.10 step-up, approved by Asha and then by Acme in FaceVisa, paid.
//   The video's still is Acme's 4th image of the day: run with the brand image cap raised to 4 for the seed only.
// All three are demo identities (labelled "demo" everywhere), and kept by the 48-hour rule. Prints
// every link. Needs the site live (DNS and HTTPS): demo sign-in goes through the public address.
import "../src/env.js"; // first: settings and their fallbacks (src/env.ts)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../src/app/accounts.js";
import { Demo, demoConfigFromEnv } from "../src/app/demo.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = process.env.PUBLIC_URL;
if (!base?.startsWith("https://")) throw new Error("PUBLIC_URL must be the live https address");
process.env.FACEVISA_URL = base;
const { Browser, log } = await import("./lib/clickthrough.js");

const captureDir = process.env.SEED_CAPTURE_DIR;
if (!captureDir) throw new Error("SEED_CAPTURE_DIR: Rohit's three capture frames");
const frames = readdirSync(captureDir).filter((f) => f.endsWith(".jpg")).sort().map((f) => join(captureDir, f));
const asha = fileURLToPath(new URL("../assets/synthetic-demo-creator.jpg", import.meta.url));

const meta = await (await fetch(`${base}/api/facevisa`)).json();
if (!meta.publicDemo || meta.arkiv?.namespace !== "facevisa-public") throw new Error("not the public demo (FACEVISA_PUBLIC_DEMO=1, facevisa-public)");

const rohit = new Browser("Rohit");
await rohit.signInDemo("Rohit Shukla", "creator");
await rohit.captureFrames(frames);
await rohit.list({ minPrice: "0.05", maxDays: 30, bannedCategories: ["Alcohol", "Gambling"] });
log("Rohit Shukla: listed with his own capture, $0.05 per image");

const ashaB = new Browser("Asha");
await ashaB.signInDemo("Asha (synthetic demo creator)", "creator");
await ashaB.capture(asha);
await ashaB.list({ minPrice: "0.08", maxDays: 30, bannedCategories: ["Alcohol", "Gambling", "Finance & crypto"] });
log("Asha (synthetic demo creator): listed, $0.08 per image");

const acme = new Browser("Acme");
await acme.signInDemo("Acme Running Co (demo brand)", "brand");
const ask = async (creator: string, brief: string) => (await acme.json("POST", "/api/facevisa/agent/request", { creator, brief, category: "Fitness", kind: "image", durationDays: 7 })).request.id as string;

// 1. Rohit's ad: approved by him in FaceVisa, paid in USDC on Hedera testnet, released.
const r1 = await ask(rohit.uid, "A runner at sunrise on a mountain trail, in our new trail shoes");
await acme.requestStatus(r1, ["review"], 240_000);
await rohit.decide(r1, "approve");
const done1 = await acme.requestStatus(r1, ["released"], 240_000);
log(`Rohit's ad released: licence ${done1.licenceId}, file ${done1.output.hash}`);

// 2. Asha's ad, denied: nothing released, nothing paid.
const r2 = await ask(ashaB.uid, "Stretching after a run by the sea, in our new trail shoes");
await acme.requestStatus(r2, ["review"], 240_000);
await ashaB.decide(r2, "deny");
log("Asha's first ad: denied");

// 3. Asha's ad, paid, then revoked by her.
const r3 = await ask(ashaB.uid, "A cool-down walk at dusk on the beach, in our new trail shoes");
await acme.requestStatus(r3, ["review"], 240_000);
await ashaB.decide(r3, "approve");
const done3 = await acme.requestStatus(r3, ["released"], 240_000);
await ashaB.json("POST", "/api/facevisa/creator/revoke", { licenceId: done3.licenceId });
log(`Asha's second ad: released, then revoked (licence ${done3.licenceId})`);

// 4. Asha's video: over the brand's step-up limit, so Acme approves the spend in FaceVisa after Asha.
const r4 = (await acme.json("POST", "/api/facevisa/agent/request", { creator: ashaB.uid, brief: "Stretching on the beach at sunrise, in our new trail shoes", category: "Fitness", kind: "video", durationDays: 7 })).request.id as string;
await acme.requestStatus(r4, ["review"], 600_000);
await ashaB.decide(r4, "approve");
if ((await acme.requestStatus(r4, ["spend_review", "released"], 240_000)).status === "spend_review") {
  await acme.approveSpend(r4);
  log("Asha's video: over the $0.10 step-up; the brand approved the spend in FaceVisa");
}
const done4 = await acme.requestStatus(r4, ["released"], 240_000);
log(`Asha's video released: licence ${done4.licenceId}, file ${done4.output.hash}`);

// Seeded people are kept by the 48-hour rule (judges' own captures and ads are not).
const accounts = new Accounts(`${root}accounts/${process.env.FACEVISA_MODE || "testnet"}/accounts.sqlite`);
const demo = new Demo(accounts.db, demoConfigFromEnv(), "seed");
for (const [b, why] of [[rohit, "seeded: Rohit Shukla (his consent, the hackathon's public demo)"], [ashaB, "seeded: Asha (synthetic)"], [acme, "seeded: the demo brand"]] as const) demo.keep(b.uid, why);

const report = {
  site: base,
  creators: { rohit: rohit.uid, asha: ashaB.uid },
  approved: { request: r1, licence: done1.licenceId, file: done1.output.hash, verify: `${base}/verify?hash=${done1.output.hash}`, direct: `${base}/verifier/index.html?hash=${done1.output.hash}&ns=facevisa-public` },
  denied: { request: r2 },
  revoked: { request: r3, licence: done3.licenceId, file: done3.output.hash },
  stepUpVideo: { request: r4, licence: done4.licenceId, file: done4.output.hash, verify: `${base}/verify?hash=${done4.output.hash}` },
};
console.log(JSON.stringify(report, null, 2));
