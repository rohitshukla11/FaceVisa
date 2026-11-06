/**
 * The brand's brief is checked before any licence or payment, and again before generating. Two layers
 * (as in facevisa-ai, Rohit's earlier project): keyword rules for the five uses banned in the contract
 * (political, adult, minors, impersonation, deception), always; then a Gemini classifier on Vertex AI
 * with JSON output: banned uses, and whether the brief fits the licensed use. If the classifier can't
 * answer, the brief is refused (fail closed).
 */
import { generateContent, models } from "./vertex.js";

export type BriefCheck = { allowed: boolean; reasons: string[] };

const w = (words: string) => new RegExp(`\\b(?:${words})\\b`, "i");
export const RULES: { label: string; pattern: RegExp }[] = [
  { label: "Political", pattern: w("election|elections|vote for|voting for|ballot|candidate|campaign rally|political|politician|senator|congress(?:man|woman)?|parliament|prime minister|president(?:ial)?|democrat|republican|party manifesto|referendum|propaganda") },
  { label: "Adult", pattern: w("nude|nudity|naked|topless|nsfw|porn\\w*|sexual|sexy|erotic|explicit|lingerie|fetish|onlyfans|strip(?:per|tease)|undress\\w*") },
  { label: "Anything involving minors", pattern: w("child|children|kid|kids|minor|minors|underage|teen|teenage|teenager|schoolgirl|schoolboy|toddler|baby|infant|preteen|young girl|young boy|\\d{1,2}[- ]?year[- ]?old") },
  { label: "Impersonation", pattern: w("pretend(?:ing)? to be|posing as|impersonat\\w*|official statement from|on behalf of|endorsed by|signature of") },
  { label: "Deception", pattern: w("deepfake|fake news|hoax|scam|fraud\\w*|misinformation|disinformation|fake (?:testimonial|review|evidence|receipt|id|document)|crime scene|mugshot|arrest\\w*|confess\\w*|real footage") },
];

export function ruleCheck(brief: string): string[] {
  const hits: string[] = [];
  for (const r of RULES) {
    const m = r.pattern.exec(brief);
    if (m) hits.push(`${r.label}: "${m[0]}"`);
  }
  return hits;
}

const INSTRUCTION = `You screen briefs for an AI ad generator that renders a real, consenting adult's face under a licence.
Banned uses, never allowed under any licence:
- political: elections, candidates, parties, policy advocacy;
- adult: sexual or sexualised content, nudity;
- minors: anything involving minors or a childlike depiction;
- impersonation: presenting the person as someone else, or as endorsing or saying something they did not;
- deception: fake news, fake evidence, fake testimonials, depicting crimes or events as real.
The licence covers exactly one use category. Decide whether the brief fits it.
Return JSON matching the schema.`;

const SCHEMA = {
  type: "object",
  properties: {
    banned: { type: "array", items: { type: "string", enum: ["political", "adult", "minors", "impersonation", "deception"] } },
    fitsCategory: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["banned", "fitsCategory", "reason"],
};

export async function checkBrief(brief: string, category = "Advertising"): Promise<BriefCheck> {
  const reasons: string[] = [];
  if (brief.trim().length < 3) reasons.push("the brief is empty");
  if (brief.length > 600) reasons.push("the brief is longer than 600 characters");
  reasons.push(...ruleCheck(brief).map((h) => `banned use: ${h}`));
  if (reasons.length) return { allowed: false, reasons };
  try {
    const res = await generateContent(
      models.filter(),
      {
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: `Licence category: ${category}\nBrief: ${brief}` }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
      },
      30_000,
    );
    if (res.promptFeedback?.blockReason) return { allowed: false, reasons: [`blocked by Gemini safety: ${res.promptFeedback.blockReason}`] };
    const out = JSON.parse(res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "") as { banned?: unknown; fitsCategory?: unknown; reason?: unknown };
    if (!Array.isArray(out.banned) || typeof out.fitsCategory !== "boolean") throw new Error("unexpected answer");
    for (const b of out.banned) reasons.push(`banned use: ${String(b)} (${String(out.reason ?? "")})`);
    if (!out.fitsCategory) reasons.push(`outside the licensed use (${category}): ${String(out.reason ?? "")}`);
  } catch (e) {
    reasons.push(`the safety check couldn't run, so the brief is refused: ${(e as Error).message.slice(0, 160)}`);
  }
  return { allowed: reasons.length === 0, reasons };
}
