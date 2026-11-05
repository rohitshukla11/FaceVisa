import { afterEach, describe, expect, it } from "vitest";
import { assertVertexAllowed, vertexProject, vertexStatus } from "../src/ai/vertex.js";
import { startRuntime } from "../src/app/runtime.js";

const KEYS = ["LIKENESS_AI", "VERTEX_PROJECT", "LIKENESS_GCLOUD_CONFIG"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const set = (env: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
};

describe("Vertex safety: never in likeness-hsk; no project, no real generation", () => {
  afterEach(() => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });

  it("without VERTEX_PROJECT real generation is off, even with LIKENESS_AI=vertex", () => {
    set({ LIKENESS_AI: "vertex" });
    expect(vertexStatus()).toEqual({ on: false, reason: "VERTEX_PROJECT isn't set" });
    expect(() => vertexProject()).toThrow(/off: VERTEX_PROJECT isn't set/);
    set({});
    expect(vertexStatus()).toMatchObject({ on: false });
  });

  it("this app's own project turns it on", () => {
    set({ LIKENESS_AI: "vertex", VERTEX_PROJECT: "likeness-eth" });
    expect(vertexStatus()).toEqual({ on: true, project: "likeness-eth" });
    expect(vertexProject()).toBe("likeness-eth");
  });

  it("likeness-hsk is refused as the project or the gcloud configuration, even with generation off", () => {
    set({ VERTEX_PROJECT: "likeness-hsk" });
    expect(() => assertVertexAllowed()).toThrow(/never calls Vertex there/);
    set({ LIKENESS_AI: "vertex", VERTEX_PROJECT: "likeness-hsk" });
    expect(() => vertexProject()).toThrow(/never calls Vertex there/);
    set({ LIKENESS_GCLOUD_CONFIG: "likeness-hsk" });
    expect(() => assertVertexAllowed()).toThrow(/another project/);
  });

  it("the account's default project and the gcloud configuration pointing at it are refused too", () => {
    set({ VERTEX_PROJECT: "bionic-carving-140911" });
    expect(() => assertVertexAllowed()).toThrow(/never calls Vertex there/);
    set({ LIKENESS_GCLOUD_CONFIG: "default" });
    expect(() => assertVertexAllowed()).toThrow(/another project/);
  });

  it("the app refuses to start with VERTEX_PROJECT=likeness-hsk (before anything else runs)", async () => {
    set({ VERTEX_PROJECT: "likeness-hsk" });
    await expect(startRuntime({ mode: "local", root: "/nonexistent/", publicUrl: "https://localhost:3000" })).rejects.toThrow(/never calls Vertex there/);
  });
});
