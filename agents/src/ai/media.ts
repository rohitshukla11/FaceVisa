/**
 * Which provider makes each kind of media (B3):
 *   LIKENESS_AI_IMAGE = vertex | 0g      images, and a video's opening still
 *   LIKENESS_AI_VIDEO = vertex | 0g      the video, animated from that approved still (its first frame)
 *   empty                                TEST RENDERs (no model call)
 *   unset                                the legacy LIKENESS_AI: `vertex` puts both on Vertex, anything else tests
 * An explicit choice must be usable (Vertex needs VERTEX_PROJECT; 0G needs .secrets/zerog-api-key), or startup
 * fails; the legacy alias falls back to TEST RENDERs as before. Daily caps count per media type, whichever provider
 * is billed.
 *
 * LIKENESS_AI_VIDEO_FALLBACK=vertex (optional): when 0G refuses a video (e.g. Seedance's real-person filter), make it
 * on Vertex instead. Off by default: a refusal fails the request with "0G refused this video", never a silent switch.
 */
import { testProvider, vertexProvider, type AiProvider } from "../likeness/pipeline.js";
import { vertexStatus } from "./vertex.js";
import { ZeroGError, zeroGConfigFromEnv, zeroGProvider } from "./zerog.js";

export type MediaChoice = "vertex" | "0g" | "test";

export function mediaChoices(env = process.env): { image: MediaChoice; video: MediaChoice; explicit: { image: boolean; video: boolean } } {
  const legacy: MediaChoice = env.LIKENESS_AI === "vertex" ? "vertex" : "test";
  const pick = (name: "LIKENESS_AI_IMAGE" | "LIKENESS_AI_VIDEO"): MediaChoice => {
    const v = env[name];
    if (v === undefined) return legacy;
    if (v === "") return "test";
    if (v === "vertex" || v === "0g") return v;
    throw new Error(`${name}: vertex, 0g, or empty for TEST RENDERs`);
  };
  return { image: pick("LIKENESS_AI_IMAGE"), video: pick("LIKENESS_AI_VIDEO"), explicit: { image: env.LIKENESS_AI_IMAGE !== undefined, video: env.LIKENESS_AI_VIDEO !== undefined } };
}

/** How the two media are made, for the startup line and the web: e.g. "image 0g, video vertex". */
export const mediaLabel = (p: { image: string; video: string }) => (p.image === p.video ? p.image : `image ${p.image}, video ${p.video}`);

/**
 * One AiProvider from two: images (and a video's still) from one, videos from the other. `billedFor` says which
 * kinds count against the daily caps.
 */
export function composeProvider(image: AiProvider, video: AiProvider, o: { videoFallback?: AiProvider } = {}): AiProvider {
  if (image === video && !o.videoFallback) return { ...image, billedFor: () => !!image.billed };
  return {
    name: image.name === video.name ? image.name : `${image.name}+${video.name}`,
    billed: !!(image.billed || video.billed),
    billedFor: (kind) => !!(kind === "image" ? image.billed : video.billed),
    generateImage: (ref, prompt, aspect) => image.generateImage(ref, prompt, aspect),
    async generateVideo(from, prompt, onProgress) {
      try {
        return await video.generateVideo(from, prompt, onProgress);
      } catch (e) {
        if (!(e instanceof ZeroGError) || !e.refused) throw e;
        const why = `0G refused this video: ${e.message}${e.vendorCode ? ` (${e.vendorCode})` : ""}`;
        if (!o.videoFallback) throw new Error(why);
        onProgress?.(`${why}; making it on ${o.videoFallback.name} instead (LIKENESS_AI_VIDEO_FALLBACK)`);
        return o.videoFallback.generateVideo(from, prompt, onProgress);
      }
    },
  };
}

/** The configured providers (core.ts). Throws when an explicit choice can't run. */
export function providersFromEnv(root: string, env = process.env): { ai: AiProvider; image: MediaChoice; video: MediaChoice } {
  const m = mediaChoices(env);
  let zerog: ReturnType<typeof zeroGConfigFromEnv>;
  const make = (kind: "image" | "video"): AiProvider => {
    const choice = m[kind];
    const name = kind === "image" ? "LIKENESS_AI_IMAGE" : "LIKENESS_AI_VIDEO";
    if (choice === "vertex") {
      const s = vertexStatus();
      if (s.on) return vertexProvider();
      if (m.explicit[kind]) throw new Error(`${name}=vertex needs Vertex AI: ${s.reason}`);
      return testProvider();
    }
    if (choice === "0g") {
      zerog ??= zeroGConfigFromEnv(root, env);
      if (!zerog) throw new Error(`${name}=0g needs the 0G API key in .secrets/zerog-api-key (chmod 600)`);
      return zeroGProvider(zerog);
    }
    return testProvider();
  };
  const image = make("image");
  const video = m.image === m.video ? image : make("video");
  const fallback = env.LIKENESS_AI_VIDEO_FALLBACK;
  if (fallback && fallback !== "vertex") throw new Error("LIKENESS_AI_VIDEO_FALLBACK: vertex or empty");
  if (fallback && !vertexStatus().on) throw new Error("LIKENESS_AI_VIDEO_FALLBACK=vertex needs Vertex AI (VERTEX_PROJECT)");
  const resolved = { image: image.name === "test" ? "test" : m.image, video: video.name === "test" ? "test" : m.video } as const;
  return { ai: composeProvider(image, video, fallback && m.video === "0g" ? { videoFallback: vertexProvider() } : {}), ...resolved };
}
