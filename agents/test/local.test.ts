import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startRuntime } from "../src/app/runtime.js";
import { newSession } from "../src/app/session.js";

describe("local mode keeps its database across restarts (accounts/local/accounts.sqlite)", () => {
  const root = `${mkdtempSync(join(tmpdir(), "likeness-local-"))}/`;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("accounts, roles, sessions, creator profiles and listings survive a restart", async () => {
    const first = await startRuntime({ mode: "local", root, publicUrl: "https://localhost:3000" });
    const uid = first.accounts.signIn("https://sandbox.auth.world.org", "sub-persist").uid;
    first.accounts.setRole(uid, "creator");
    first.accounts.setName(uid, "Persisted");
    const session = newSession(first.accounts, uid).split(".")[0]!;
    first.onboarding.start(uid, "Persisted");
    first.core.data.setListing(uid, { bannedCategories: ["Alcohol"], minPrice: 50_000, maxDays: 30 });
    first.stop();

    const second = await startRuntime({ mode: "local", root, publicUrl: "https://localhost:3000" });
    try {
      expect(second.accounts.account(uid)).toMatchObject({ name: "Persisted", role: "creator" });
      expect(second.accounts.sessionAccount(session)?.uid).toBe(uid);
      expect(second.accounts.creator(uid)).toMatchObject({ name: "Persisted" });
      expect(second.core.data.listing(uid)?.rules).toEqual({ bannedCategories: ["Alcohol"], minPrice: 50_000, maxDays: 30 });
    } finally {
      second.stop();
    }
  });
});
