"use client";
/**
 * Live face capture with a liveness check, entirely in the browser: MediaPipe Face Landmarker (VIDEO
 * mode) tracks one face; the person blinks, then turns slightly one way and the other. A frame is
 * grabbed straight from the camera at each pose: front, slight left, slight right. No file uploads.
 * What this shows: a live, moving face at capture time. It is not a certified presentation-attack test.
 * Copied from likeness-meta (components/creator/LivenessCapture.tsx @93993bc); see CHANGES.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pillClass } from "@/components/ds";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export type Capture = { frames: string[]; liveness: { blinks: number; turnedLeft: boolean; turnedRight: boolean } };
type Step = "loading" | "center" | "blink" | "turn1" | "turn2" | "done" | "error";

const PROMPT: Record<Step, string> = {
  loading: "Starting the camera…",
  center: "Look straight at the camera, with only your face in view.",
  blink: "Blink once.",
  turn1: "Turn your head slightly to one side.",
  turn2: "Now turn slightly to the other side.",
  done: "Done. Three frames captured.",
  error: "",
};

/** Where the nose sits between the cheeks: about 0.5 facing the camera, lower or higher when turned. */
function yawRatio(lm: { x: number }[]) {
  const l = lm[234].x, r = lm[454].x, n = lm[1].x;
  return (n - l) / (r - l);
}

/**
 * MediaPipe's WASM prints its own INFO lines through console.error ("INFO: Created TensorFlow Lite XNNPACK delegate
 * for CPU."), which Next's dev overlay counts as errors. Those lines go to console.info; anything else is untouched.
 */
let mediaPipeQuiet = false;
function quietMediaPipeInfo() {
  if (mediaPipeQuiet) return;
  mediaPipeQuiet = true;
  const error = console.error.bind(console);
  console.error = (...args: unknown[]) => (typeof args[0] === "string" && args[0].startsWith("INFO: ") ? console.info(...args) : error(...args));
}

export function LivenessCapture({ onDone }: { onDone: (c: Capture) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const state = useRef({ step: "loading" as Step, frames: [] as string[], blinks: 0, eyesClosed: false, firstSide: 0, steady: 0 });

  const grab = useCallback(() => {
    const v = video.current!;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  }, []);

  useEffect(() => {
    quietMediaPipeInfo();
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    let landmarker: { detectForVideo: (v: HTMLVideoElement, t: number) => { faceLandmarks: { x: number; y: number }[][]; faceBlendshapes?: { categories: { categoryName: string; score: number }[] }[] }; close: () => void } | undefined;
    const go = (s: Step) => {
      state.current.step = s;
      setStep(s);
    };
    (async () => {
      try {
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        landmarker = (await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,
        })) as unknown as typeof landmarker;
        // Unmounted while loading (React runs effects twice in development): close what this run opened.
        if (stopped) return void landmarker?.close();
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return void landmarker?.close();
        }
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        go("center");
        const tick = () => {
          if (stopped) return;
          const s = state.current;
          if (v.readyState >= 2 && s.step !== "done") {
            const res = landmarker!.detectForVideo(v, performance.now());
            const faces = res.faceLandmarks.length;
            if (faces !== 1) setHint(faces === 0 ? "No face found: move into the frame, in even light." : "More than one face: only you should be in view.");
            else {
              setHint(null);
              const lm = res.faceLandmarks[0];
              const cats = res.faceBlendshapes?.[0]?.categories ?? [];
              const blink = Math.max(cats.find((c) => c.categoryName === "eyeBlinkLeft")?.score ?? 0, cats.find((c) => c.categoryName === "eyeBlinkRight")?.score ?? 0);
              const r = yawRatio(lm);
              const frontal = r > 0.42 && r < 0.58;
              if (s.step === "center") {
                s.steady = frontal && blink < 0.3 ? s.steady + 1 : 0;
                if (s.steady > 12) go("blink");
              } else if (s.step === "blink") {
                if (blink > 0.55) s.eyesClosed = true;
                else if (s.eyesClosed && blink < 0.2 && frontal) {
                  s.eyesClosed = false;
                  s.blinks += 1;
                  s.frames[0] = grab(); // front frame, eyes open after the blink
                  go("turn1");
                }
              } else if (s.step === "turn1" && (r < 0.36 || r > 0.64) && blink < 0.4) {
                s.firstSide = r < 0.5 ? -1 : 1;
                s.frames[s.firstSide < 0 ? 1 : 2] = grab();
                go("turn2");
              } else if (s.step === "turn2" && ((s.firstSide < 0 && r > 0.64) || (s.firstSide > 0 && r < 0.36)) && blink < 0.4) {
                s.frames[s.firstSide < 0 ? 2 : 1] = grab();
                go("done");
                setThumbs([...s.frames]);
                onDone({ frames: [...s.frames], liveness: { blinks: s.blinks, turnedLeft: true, turnedRight: true } });
              }
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const m = (e as Error).message ?? String(e);
        setError(/denied|NotAllowed/i.test(m) ? "Camera access was blocked. Allow the camera for this site, then try again." : `The camera or face tracker couldn't start: ${m}`);
        go("error");
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      landmarker?.close();
    };
  }, [grab, onDone]);

  const progress = ["center", "blink", "turn1", "turn2", "done"].indexOf(step);
  return (
    <div className="flex flex-col gap-3">
      {step !== "done" && (
        <div className="relative overflow-hidden rounded-[20px] bg-ink">
          <video ref={video} playsInline muted aria-label="Camera preview" className="aspect-video w-full -scale-x-100 object-cover" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[72%] aspect-[3/4] rounded-[50%] border-[3px] border-white/70" />
          </div>
        </div>
      )}
      {step === "error" ? (
        <p role="alert" className="m-0 text-[15px] text-bad">
          {error}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="m-0 text-[17px] font-semibold">
          {PROMPT[step]}
          {hint && step !== "done" && <span className="mt-1 block text-[14px] font-normal text-wait">{hint}</span>}
        </p>
      )}
      {step !== "done" && step !== "error" && step !== "loading" && (
        <ol className="m-0 flex list-none gap-2 p-0" aria-label="Liveness steps">
          {["Look", "Blink", "Turn", "Turn back"].map((l, i) => (
            <li key={l} className={`rounded-full px-3 py-1 text-[13px] font-semibold ${i < progress ? "bg-lime text-ink" : i === progress ? "bg-ink text-white" : "bg-paper text-grey"}`}>
              {l}
            </li>
          ))}
        </ol>
      )}
      {thumbs.length === 3 && (
        <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0" aria-label="Captured frames">
          {thumbs.map((t, i) => (
            <li key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t} alt={["Front", "Slight left", "Slight right"][i]} className="aspect-video w-full -scale-x-100 rounded-[12px] object-cover" />
            </li>
          ))}
        </ul>
      )}
      {step === "error" && (
        <button type="button" onClick={() => location.reload()} className={pillClass("ink", "self-start")}>
          Try again
        </button>
      )}
    </div>
  );
}
