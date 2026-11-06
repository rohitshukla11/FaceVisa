import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IN_APP } from "../src/app/approval.js";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { handle } from "../src/app/server.js";
import { StandIn, standinSub } from "../src/app/standin.js";
import type { AiProvider } from "../src/likeness/pipeline.js";
import { csrfFor } from "./csrf.js";

const jpeg = (r: number) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 120, b: 60 } } }).jpeg().toBuffer();
const ZERO = `0x${"0".repeat(64)}`;

/**
 * In-app approvals: the signed-in creator approves the exact finished ad in Likeness (bound to its file hash, the
 * brand, usage, duration and price); above BRAND_STEPUP_USDC the brand approves that exact spend. Once only; deny,
 * expiry and a missing approval release nothing and charge nothing. Labels say "in Likeness", never World ID. Sign-in
 * is the local dev sign-in.
 */
describe("in-app approvals: the creator's ad, the brand's spend", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-approval-"))}/`;
  const people: Record<string, { cookie: string; uid: string }> = {};
  let n = 0;
  const ai: AiProvider = {
    name: "fake",
    generateImage: async () => (n++, { bytes: new Uint8Array(await jpeg((n * 41) % 250)), mime: "image/jpeg", provenance: { provider: "fake", model: "fake-image", requestId: `r${n}` } }),
    generateVideo: async () => {
      throw new Error("no video here");
    },
  };
  const follow = async (location: string) => {
    const r = await fetch(location, { redirect: "manual" });
    return { location: r.headers.get("location") ?? "", setCookie: r.headers.get("set-cookie") };
  };
  const call = async (who: string | null, path: string, body?: unknown, opts: { csrf?: string | null } = {}) => {
    const p = who ? people[who]! : undefined;
    const headers: Record<string, string> = { "content-type": "application/json", ...(p ? { cookie: p.cookie } : {}) };
    const csrf = opts.csrf === undefined ? csrfFor(p?.cookie) : opts.csrf;
    if (csrf) headers["x-csrf-token"] = csrf;
    const r = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  /** Signs in through the dev sign-in page as a named person. */
  const signIn = async (who: string, role: "creator" | "brand") => {
    const login = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
    const u = new URL(login.headers.get("location")!);
    const page = await (await fetch(u)).text();
    expect(page).toContain("Dev sign-in");
    expect(page).not.toMatch(/World ID/);
    const form = new URLSearchParams(u.searchParams);
    form.set("scenario", "ok");
    form.set("identity_name", who);
    const r = await fetch(`${base}/api/dev/worldid/authorize`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    const back = await follow(r.headers.get("location")!);
    people[who] = { cookie: back.setCookie!.split(";")[0]!, uid: "" };
    await call(who, "/api/me/role", { role, name: who });
    people[who]!.uid = (await call(who, "/api/me")).body.account.uid;
  };
  const action = (id: string) => rt.core.data.action(id)!;
  const ask = async (creator: string, over: Record<string, unknown> = {}) => {
    const r = await call("Acme", "/api/likeness/agent/request", { creator: people[creator]!.uid, brief: `a cyclist on a coastal road, ${++n}`, category: "Fitness", kind: "image", durationDays: 7, ...over });
    expect(r.status).toBe(200);
    const id = r.body.request.id as string;
    await rt.core.agent.generate(id);
    return id;
  };
  /** What the creator's page shows, then their decision on that exact ad. */
  const shown = async (who: string, id: string) => (await call(who, `/api/approvals/request?id=${id}`)).body.request;
  const decide = async (who: string, id: string, decision: "approve" | "reject" | "deny") => call(who, "/api/approvals/decide", { id, decision, outputHash: (await shown(who, id)).output?.hash });
  const events = async (id: string) => ((await call("Acme", "/api/likeness/agent/activity")).body.events as { actionId: string; kind: string; summary: string }[]).filter((e) => e.actionId === id).reverse();
  const spent = (id: string) => rt.core.data.payments({ actionId: id }).filter((p) => p.status !== "voided").length;

  beforeAll(async () => {
    process.env.LIKENESS_LOCAL_DEV = "1";
    process.env.LIKENESS_BRAND_DAILY_BUDGET = "50";
    process.env.BRAND_STEPUP_USDC = "0.10";
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res, undefined));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.WORLDID_SIGNIN_REDIRECT_URI = `${base}/api/auth/callback`;
    rt = await startRuntime({ mode: "local", root, publicUrl: base, standin: new StandIn({ internalBase: base, publicBase: base }), aiProvider: ai, autoRun: false });
    for (const [who, role] of [["Maya", "creator"], ["Noor", "creator"], ["Acme", "brand"], ["Zed", "brand"]] as const) await signIn(who, role);
    for (const [who, price] of [["Maya", "0.05"], ["Noor", "0.20"]] as const) {
      await call(who, "/api/me/creator/capture", { frames: Array(3).fill((await jpeg(220)).toString("base64")), liveness: { blinks: 1, turnedLeft: true, turnedRight: true }, consent: true });
      expect((await call(who, "/api/likeness/creator/listing", { minPrice: price, maxDays: 30, bannedCategories: [] })).status).toBe(200);
    }
  }, 120_000);
  afterAll(() => {
    for (const k of ["LIKENESS_LOCAL_DEV", "LIKENESS_BRAND_DAILY_BUDGET", "BRAND_STEPUP_USDC", "WORLDID_SIGNIN_REDIRECT_URI"]) delete process.env[k];
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("consent is in-app; sign-in was the dev sign-in (identity dev), and World ID sign-in is off", async () => {
    expect(rt.core.consent?.name).toBe("in-app");
    expect((await call("Maya", "/api/me")).body.account).toMatchObject({ name: "Maya", signIn: "dev" });
    expect((await call(null, "/api/likeness")).body).toMatchObject({ worldIdSignIn: false, devSignIn: true, consent: "in-app" });
  });

  it("the ad is made but NOT released: the creator sees it and its terms; the brand can't download it; a stranger sees nothing", async () => {
    const id = await ask("Maya");
    const r = await shown("Maya", id);
    expect(r).toMatchObject({ status: "review", request: { category: "Fitness", durationDays: 7, price: "$0.05" }, output: { hash: action(id).output!.hash } });
    expect((await fetch(`${base}${r.output.file}`, { headers: { cookie: people.Maya!.cookie } })).status).toBe(200);
    expect((await fetch(`${base}${r.output.file}`, { headers: { cookie: people.Acme!.cookie } })).status).toBe(403);
    expect((await call("Zed", `/api/approvals/request?id=${id}`)).status).toBe(404);
    expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
  });

  it("approve: bound to the exact file shown, once; paid, released; Verify says approved in Likeness for this file", async () => {
    const id = await ask("Maya");
    expect((await call("Maya", "/api/approvals/decide", { id, decision: "approve", outputHash: ZERO })).body.error).toMatch(/the ad changed since you opened it/);
    expect((await call("Maya", "/api/approvals/decide", { id, decision: "approve" })).status).toBe(409);
    expect((await decide("Maya", id, "approve")).status).toBe(200);
    expect(action(id)).toMatchObject({ status: "approved", spendCheck: null, creatorCheck: { decidedAt: expect.any(Number), evidence: { acr: IN_APP, sub: standinSub("Maya"), outputHash: action(id).output!.hash } } });
    expect((await decide("Maya", id, "approve")).status).toBe(409); // once only
    expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(200);
    const v = await call(null, `/api/likeness/verify?hash=${action(id).output!.hash}`);
    expect(v.body).toMatchObject({ verdict: "Licensed", consent: { method: "dev", boundTo: "this file", approvedAt: expect.any(Number) }, spend: null });
    const log = (await events(id)).map((e) => e.summary).join("\n");
    expect(log).toMatch(/waiting for Maya to review and approve the finished image in Likeness/);
    expect(log).toMatch(/Maya approved this exact image in Likeness/);
    expect(log).not.toMatch(/World ID|Agent Pass|fresh check/);
  });

  it("reject: one new version, and the old file can't be approved; a second rejection ends it, nothing charged", async () => {
    const id = await ask("Maya");
    const first = action(id).output!.hash;
    expect((await decide("Maya", id, "reject")).body.request.status).toBe("generating");
    await rt.core.agent.generate(id);
    expect(action(id)).toMatchObject({ status: "review", generation: 2 });
    expect((await call("Maya", "/api/approvals/decide", { id, decision: "approve", outputHash: first })).status).toBe(409);
    expect((await decide("Maya", id, "reject")).body.request.status).toBe("denied");
    expect(spent(id)).toBe(0);
  });

  it("deny: no licence, nothing charged, and the log says so", async () => {
    const id = await ask("Maya");
    expect((await call("Maya", "/api/approvals/decide", { id, decision: "deny" })).body.request.status).toBe("denied");
    expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
    expect(spent(id)).toBe(0);
    expect((await events(id)).at(-1)!.summary).toMatch(/the creator denied the request in Likeness: nothing released, nothing charged/);
  });

  it("expiry: the request ends; an approval is refused; nothing released", async () => {
    const id = await ask("Maya");
    expect((await call("Maya", "/api/dev/expire-request", { id })).status).toBe(200);
    expect(action(id).status).toBe("expired");
    expect((await decide("Maya", id, "approve")).status).toBe(409);
    expect(spent(id)).toBe(0);
  });

  it("ownership and CSRF: only the request's creator decides, with the session's token", async () => {
    const id = await ask("Maya");
    const hash = action(id).output!.hash;
    expect((await call("Noor", "/api/approvals/decide", { id, decision: "approve", outputHash: hash })).status).toBe(404);
    expect((await call("Acme", "/api/approvals/decide", { id, decision: "approve", outputHash: hash })).status).toBe(404);
    expect((await call("Maya", "/api/approvals/decide", { id, decision: "approve", outputHash: hash }, { csrf: null })).status).toBe(403);
    expect((await call(null, "/api/approvals/decide", { id, decision: "approve", outputHash: hash })).status).toBe(401);
    expect(action(id).status).toBe("review");
  });

  it("your own ad from your own brand workspace still waits for your approval as the creator", async () => {
    // Acme lists itself as a creator too: one account, both workspaces.
    await call("Acme", "/api/me/role", { role: "creator" });
    await call("Acme", "/api/me/creator/capture", { frames: Array(3).fill((await jpeg(90)).toString("base64")), liveness: { blinks: 1, turnedLeft: true, turnedRight: true }, consent: true });
    expect((await call("Acme", "/api/likeness/creator/listing", { minPrice: "0.05", maxDays: 30, bannedCategories: [] })).status).toBe(200);
    await call("Acme", "/api/me/role", { role: "brand" });
    const id = await ask("Acme");
    expect(action(id).status).toBe("review");
    expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
    expect((await decide("Acme", id, "approve")).status).toBe(200);
  });

  describe("the brand's spend over BRAND_STEPUP_USDC", () => {
    it("below the limit the agent spends on its own: $0.05 ≤ $0.10, no spend approval", async () => {
      expect((await call("Acme", "/api/likeness")).body.spendLimit).toBe("$0.10");
      const id = await ask("Maya");
      await decide("Maya", id, "approve");
      expect(action(id)).toMatchObject({ status: "approved", spendCheck: null });
    });

    it("above it: paused, nothing paid; the brand approves that exact amount in Likeness → paid → released", async () => {
      const id = await ask("Noor");
      await decide("Noor", id, "approve");
      expect(action(id).status).toBe("spend_review");
      expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
      expect(spent(id)).toBe(0);
      const view = (await call("Acme", `/api/approvals/spend?id=${id}`)).body.request;
      expect(view).toMatchObject({ price: "$0.20", status: "spend_review" });
      expect((await call("Acme", "/api/approvals/spend/decide", { id, decision: "approve", amount: "0.05" })).body.error).toMatch(/the amount changed/);
      expect((await call("Acme", "/api/approvals/spend/decide", { id, decision: "approve", amount: view.price.slice(1) })).status).toBe(200);
      expect(action(id)).toMatchObject({ status: "approved", spendCheck: { decidedAt: expect.any(Number), evidence: { acr: IN_APP, sub: standinSub("Acme"), amount: 200_000 } } });
      expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(200);
      const v = await call(null, `/api/likeness/verify?hash=${action(id).output!.hash}`);
      expect(v.body).toMatchObject({ verdict: "Licensed", consent: { method: "dev" }, spend: { approvedAt: expect.any(Number) } });
      const e = await events(id);
      expect(e.map((x) => x.kind)).toEqual(["requested", "generating", "generated", "waiting", "approved", "spend-check", "spend-approved", "paid", "released"]);
      expect(e.find((x) => x.kind === "spend-check")!.summary).toMatch(/\$0.20 is over this workspace's limit of \$0.10: paused until the brand approves the spend in Likeness/);
      expect(e.find((x) => x.kind === "spend-approved")!.summary).toBe("spend approved by the brand: $0.20");
    });

    it("deny, and expiry: nothing spent, nothing released", async () => {
      const id = await ask("Noor");
      await decide("Noor", id, "approve");
      expect((await call("Acme", "/api/approvals/spend/decide", { id, decision: "deny" })).body.request.status).toBe("denied");
      expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
      const late = await ask("Noor");
      await decide("Noor", late, "approve");
      expect((await call("Acme", "/api/dev/expire-request", { id: late })).status).toBe(200);
      expect((await call("Acme", "/api/approvals/spend/decide", { id: late, decision: "approve", amount: "0.20" })).status).toBe(409);
      expect(spent(id) + spent(late)).toBe(0);
    });

    it("only the brand decides its spend, with the CSRF token; a changed price after approval is refused at release", async () => {
      const id = await ask("Noor");
      await decide("Noor", id, "approve");
      expect((await call("Noor", "/api/approvals/spend/decide", { id, decision: "approve", amount: "0.20" })).status).toBe(404);
      expect((await call("Zed", "/api/approvals/spend/decide", { id, decision: "approve", amount: "0.20" })).status).toBe(404);
      expect((await call("Acme", "/api/approvals/spend/decide", { id, decision: "approve", amount: "0.20" }, { csrf: null })).status).toBe(403);
      expect(action(id).status).toBe("spend_review");
      // Approved, then the price is tampered with: the creator's approval no longer matches, so release refuses.
      expect((await call("Acme", "/api/approvals/spend/decide", { id, decision: "approve", amount: "0.20" })).status).toBe(200);
      rt.accounts.db.prepare("update pending_actions set price = 900000 where id = ?").run(id);
      expect((await call("Acme", "/api/likeness/agent/release", { id })).status).toBe(403);
      expect(spent(id)).toBe(0);
    });
  });
});
