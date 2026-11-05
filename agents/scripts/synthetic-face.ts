// pnpm synthetic:face [other]: a photorealistic face of a person who doesn't exist, with one Gemini image call in this
// app's own Vertex project (billed: about $0.036 each; both approved by Rohit on 4 Nov):
//   - by default, the demo's synthetic creator: agents/assets/synthetic-demo-creator.jpg;
//   - with "other", a second, clearly different person for the face matcher's "someone else's face is refused"
//     tests: agents/assets/synthetic-other.jpg.
// Each image gets its provenance (.json). It refuses to run if the image already exists, so it never bills twice by
// accident. A consent-first demo uses no stranger's face: only Rohit's own capture and these.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertVertexAllowed, generateContent, models, vertexProject } from "../src/ai/vertex.js";

const dir = fileURLToPath(new URL("../assets/", import.meta.url));
const other = process.argv[2] === "other";
const name = other ? "synthetic-other" : "synthetic-demo-creator";
const out = `${dir}${name}.jpg`;
if (existsSync(out)) {
  console.error(`${out} exists already: nothing generated (delete it first to make a new one; each call is billed)`);
  process.exit(1);
}
assertVertexAllowed();
const who = other ? "a man in his late forties with short grey hair and a beard" : "a woman in her late twenties";
const prompt = [
  "A photorealistic head-and-shoulders portrait photograph of a fictional adult who does not exist (not a real or",
  `famous person): ${who}, friendly neutral expression, looking straight at the camera, plain`,
  "light grey background, soft even studio light. The whole head and hair inside the frame, with space above the",
  "head. No text, no watermark, no logo.",
].join(" ");
const model = models.image();
const res = await generateContent(model, {
  contents: [{ role: "user", parts: [{ text: prompt }] }],
  generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } },
});
const img = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data && !p.thought)?.inlineData;
if (!img) throw new Error(`no image (${res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? "no reason"})`);
const sharp = (await import("sharp")).default;
mkdirSync(dir, { recursive: true });
writeFileSync(out, await sharp(Buffer.from(img.data, "base64")).jpeg({ quality: 90 }).toBuffer());
const provenance = { what: `${other ? "a second synthetic person (face-matcher tests)" : "synthetic demo creator"}: an AI-generated face of a person who does not exist`, project: vertexProject(), model, requestId: res.responseId ?? null, prompt, createdAt: new Date().toISOString() };
writeFileSync(`${dir}${name}.json`, `${JSON.stringify(provenance, null, 1)}\n`);
console.log(`saved ${out}: ${model}, request ${provenance.requestId}`);
