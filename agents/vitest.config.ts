import { defineConfig } from "vitest/config";

export default defineConfig({
  // A throwaway session secret for tests only (deployments set their own SESSION_SECRET), and no face models, so the
  // suite never depends on them; test/face.test.ts uses the real ones from .models/ when they're there.
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, env: { SESSION_SECRET: "test-only-session-secret-0123456789abcdef", FACE_MODELS_DIR: "/nonexistent-face-models" } },
});
