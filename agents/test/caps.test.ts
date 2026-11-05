import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { handle } from "../src/app/server.js";
import { newSession, SESSION_COOKIE } from "../src/app/session.js";
import { testProvider, type AiProvider } from "../src/likeness/pipeline.js";
import { csrfHeaders } from "./csrf.js";

const jpeg = (r: number) => sharp({ create: { width: 48, height: 48, channels: 3, background: { r, g: 40, b: 90 } } }).jpeg().toBuffer();

/**
 * The daily caps on billed model calls (what actually limits Vertex spend; the budget alert only notifies): per brand
 * workspace and across the site, per UTC day. Every image call (a video's still and each regeneration too) and every
 * video call counts; a capped request is refused before generation, and nothing is charged.
 */
describe("daily caps on billed model calls", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-caps-"))}/`;
  const sessions: Record<string, string> = {};
  const uids: Record<string, string> = {};
  const billed = { image: 0, video: 0 };
  const ai: AiProvider = {
    name: "fake-billed",
    billed: true,
    generateImage: async (ref, prompt, aspect) => (billed.image++, testProvider().generateImage(ref, prompt, aspect)),
    generateVideo: async (from, prompt) => (billed.video++, testProvider().generateVideo(from, prompt)),
  };
  const call = async (who: string, path: string, body?: unknown) => {
    const cookie = `${SESSION_COOKIE}=${sessions[who]}`;
    const headers = { "content-type": "application/json", cookie, ...csrfHeaders(cookie) };
    const r = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ask = (who: string, kind: "image" | "video") => call(who, "/api/likeness/agent/request", { creator: uids.maya, brief: "a runner at dawn", category: "Fitness", kind, durationDays: 7 });

  beforeAll(async () => {
    Object.assign(process.env, { LIKENESS_LOCAL_DEV: "1", LIKENESS_BRAND_DAILY_BUDGET: "50", LIKENESS_BRAND_IMAGES: "2", LIKENESS_BRAND_VIDEOS: "1", LIKENESS_SITE_IMAGES: "3", LIKENESS_SITE_VIDEOS: "1" });
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res, undefined));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    rt = await startRuntime({ mode: "local", root, publicUrl: base, aiProvider: ai, autoRun: false });
    for (const who of ["maya", "acme", "other"]) {
      uids[who] = rt.accounts.signIn("https://sandbox.auth.world.org", `sub-${who}`).uid;
      sessions[who] = newSession(rt.accounts, uids[who]!);
      await call(who, "/api/me/role", { role: who === "maya" ? "creator" : "brand", name: who });
    }
    await call("maya", "/api/me/creator/capture", { frames: Array(3).fill((await jpeg(180)).toString("base64")), liveness: { blinks: 1, turnedLeft: true, turnedRight: true }, consent: true });
    await call("maya", "/api/likeness/creator/listing", { minPrice: "0.05", maxDays: 30, bannedCategories: [] });
  }, 120_000);
  afterAll(() => {
    for (const k of ["LIKENESS_LOCAL_DEV", "LIKENESS_BRAND_DAILY_BUDGET", "LIKENESS_BRAND_IMAGES", "LIKENESS_BRAND_VIDEOS", "LIKENESS_SITE_IMAGES", "LIKENESS_SITE_VIDEOS"]) delete process.env[k];
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("the caps are on and visible", async () => {
    expect((await call("acme", "/api/likeness")).body.aiCaps).toEqual({ billed: true, brand: { image: 2, video: 1 }, site: { image: 3, video: 1 } });
  });

  it("per brand: two image calls, then requests are refused before anything is generated or charged", async () => {
    for (let i = 0; i < 2; i++) await rt.core.agent.generate((await ask("acme", "image")).body.request.id);
    expect(billed.image).toBe(2);
    const r = await ask("acme", "image");
    expect([r.status, r.body.reasons]).toEqual([422, ["this brand workspace's daily cap on AI image calls is reached (2 today, UTC)"]]);
    expect(billed.image).toBe(2);
    expect((await call("acme", "/api/likeness/agent/activity")).body.aiCallsToday.brand).toEqual({ image: 2, video: 0 });
  }, 60_000);

  it("across the site: another brand gets the third image call, then the site cap refuses everyone", async () => {
    await rt.core.agent.generate((await ask("other", "image")).body.request.id);
    expect(billed.image).toBe(3);
    expect((await ask("other", "image")).body.reasons).toEqual(["the site's daily cap on AI image calls is reached (3 today, UTC)"]);
  }, 60_000);

  it("the cap is enforced at the call too: a request made earlier fails at generation, with nothing generated or charged", async () => {
    rt.accounts.db.prepare("delete from ai_calls").run();
    const id = (await ask("other", "image")).body.request.id; // allowed now
    rt.accounts.db.prepare("insert into ai_calls (day, brand, kind, n) values (?, 'someone', 'image', 3)").run(new Date().toISOString().slice(0, 10));
    const before = billed.image;
    await expect(rt.core.agent.generate(id)).rejects.toMatchObject({ status: 422 });
    expect(rt.core.data.action(id)).toMatchObject({ status: "failed", reason: expect.stringMatching(/site's daily cap on AI image calls/) });
    expect(billed.image).toBe(before);
    expect(rt.core.data.payments({ actionId: id })).toHaveLength(0);
  }, 60_000);

  it("a video needs an image call (its opening still) and a video call; the video cap refuses the next", async () => {
    rt.accounts.db.prepare("delete from ai_calls").run();
    await rt.core.agent.generate((await ask("acme", "video")).body.request.id);
    expect(billed).toMatchObject({ video: 1 });
    expect((await ask("other", "video")).body.reasons).toEqual(["the site's daily cap on AI video calls is reached (1 today, UTC)"]);
  }, 120_000);
});
