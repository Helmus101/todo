import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FaceTrackingState {
  status: "idle" | "loading" | "ready" | "error";
  faceDetected: boolean;
  concentration: number;     // 0–100 smoothed score
  gazeX: number;             // -1 (left) … 1 (right)
  gazeStatus: string;        // "On screen" | "Looking left" | "Looking right" | "Up" | "Down" | "No face"
  blinkCount: number;        // total blinks since camera started
  blinkRate: number;         // blinks per minute (rolling)
  headYaw: number;           // degrees — turning left/right
  headPitch: number;         // degrees — nodding up/down
  headRoll: number;          // degrees — tilting sideways
  movement: number;          // 0–100 rolling movement intensity
  movementStatus: string;    // "Still" | "Slight" | "Active" | "Restless"
  landmarks: Array<{ x: number; y: number; z: number }> | null;
}

const IDLE: FaceTrackingState = {
  status: "idle",
  faceDetected: false,
  concentration: 0,
  gazeX: 0,
  gazeStatus: "No face",
  blinkCount: 0,
  blinkRate: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  movement: 0,
  movementStatus: "—",
  landmarks: null,
};

// ── Blendshape helper ────────────────────────────────────────────────────────
// MediaPipe returns blendshapes as a flat array of {categoryName, score}. We look
// up the ones we care about by name each frame.
function blendMap(cats: Array<{ categoryName: string; score: number }>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of cats) m[c.categoryName] = c.score;
  return m;
}

// ── Euler extraction from MediaPipe's 4×4 transformation matrix ───────────────
// The matrix is column-major (OpenGL convention). We decompose the rotation part
// into yaw / pitch / roll (degrees). Approximate values are fine — we only need
// them for relative movement tracking and concentration heuristics.
function matrixToEuler(m: Float32Array | number[]): { yaw: number; pitch: number; roll: number } {
  // Clamp to avoid NaN from asin(>1)
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[2])));
  const yaw = Math.atan2(m[1], m[0]);
  const roll = Math.atan2(m[6], m[10]);
  return {
    yaw: (yaw * 180) / Math.PI,
    pitch: (pitch * 180) / Math.PI,
    roll: (roll * 180) / Math.PI,
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────
// Lazily loads MediaPipe Tasks Vision (WASM from CDN), creates a FaceLandmarker
// configured for blendshapes + facial transformation matrix, then runs per-frame
// detection on the provided <video> element via requestAnimationFrame.
//
// All processing is 100% local — nothing is recorded, uploaded, or stored.
export function useFaceTracking(
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
): FaceTrackingState {
  const [state, setState] = useState<FaceTrackingState>(IDLE);

  const landmarkerRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const lastFlushRef = useRef(0);

  // Rolling state kept in refs (updated every frame, flushed to React ~10 fps)
  const blinkWasClosedRef = useRef(false);
  const blinkCountRef = useRef(0);
  const blinkHistoryRef = useRef<number[]>([]); // timestamps of blinks for rate calc
  const concRef = useRef(100);
  const moveEMARef = useRef(0);
  const lastPoseRef = useRef<{ yaw: number; pitch: number; roll: number } | null>(null);
  const lastFaceCenterRef = useRef<{ x: number; y: number } | null>(null);

  // ── Load MediaPipe when enabled ──────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: "loading" }));

    (async () => {
      try {
        const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
        );
        const landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          numFaces: 1,
          runningMode: "VIDEO",
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setState((s) => ({ ...s, status: "ready" }));
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: "error" }));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [enabled]);

  // ── Detection + drawing loop ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || state.status !== "ready") return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video) return;

    const drawLandmarks = (lms: Array<{ x: number; y: number; z: number }> | null) => {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = (canvas.width = video.videoWidth || canvas.clientWidth);
      const h = (canvas.height = video.videoHeight || canvas.clientHeight);
      ctx.clearRect(0, 0, w, h);
      if (!lms || !lms.length) return;
      // Draw a light mesh of dots — subtle, Apple-style
      ctx.fillStyle = "rgba(100, 200, 255, 0.55)";
      for (const p of lms) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      // Highlight eyes (landmark clusters around indices 33, 133, 159, 145, 362, 263, 386, 374)
      const eyeIdx = [33, 133, 159, 145, 362, 263, 386, 374];
      ctx.fillStyle = "rgba(0, 255, 180, 0.85)";
      for (const idx of eyeIdx) {
        const p = lms[idx];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const landmarker = landmarkerRef.current;
      if (!landmarker || !video || video.readyState < 2) return;

      const now = performance.now();
      // Cap detection at ~30 fps to spare the GPU
      if (now - lastTsRef.current < 33) return;
      lastTsRef.current = now;

      let results: any;
      try {
        results = landmarker.detectForVideo(video, now);
      } catch {
        return; // transient — next frame will retry
      }

      const lms = results.faceLandmarks?.[0] as Array<{ x: number; y: number; z: number }> | undefined;
      const blendshapes = results.faceBlendshapes?.categories as Array<{ categoryName: string; score: number }> | undefined;
      const matrix = results.facialTransformationMatrixes?.[0]?.data as Float32Array | undefined;

      const faceDetected = !!lms && lms.length > 0;

      // ── Draw overlay every frame (smooth) ──
      drawLandmarks(faceDetected ? lms! : null);

      // ── Compute metrics ──
      let gazeX = 0;
      let headYaw = 0, headPitch = 0, headRoll = 0;
      let isBlinking = false;

      if (faceDetected && blendshapes) {
        const bm = blendMap(blendshapes);
        // Horizontal gaze: average of both eyes
        // Right eye: lookOut = right, lookIn = left
        // Left eye:  lookIn  = right, lookOut = left
        const rightEyeGaze = (bm["eyeLookOutRight"] || 0) - (bm["eyeLookInRight"] || 0);
        const leftEyeGaze = (bm["eyeLookInLeft"] || 0) - (bm["eyeLookOutLeft"] || 0);
        gazeX = (rightEyeGaze + leftEyeGaze) / 2;

        // Blink detection (either eye closed past 0.5 threshold)
        const blinkL = bm["eyeBlinkLeft"] || 0;
        const blinkR = bm["eyeBlinkRight"] || 0;
        isBlinking = blinkL > 0.5 || blinkR > 0.5;

        // Head pose from transformation matrix
        if (matrix) {
          const e = matrixToEuler(matrix);
          headYaw = e.yaw;
          headPitch = e.pitch;
          headRoll = e.roll;
        }
      }

      // ── Blink counting (rising-edge) ──
      if (isBlinking && !blinkWasClosedRef.current) {
        blinkCountRef.current += 1;
        blinkHistoryRef.current.push(now);
      }
      blinkWasClosedRef.current = isBlinking;

      // Keep only blinks from the last 60 s for rate calc
      const cutoff = now - 60_000;
      blinkHistoryRef.current = blinkHistoryRef.current.filter((t) => t > cutoff);
      const blinkRate = blinkHistoryRef.current.length; // blinks in last 60s = blinks/min

      // ── Movement (delta of head pose + face center) ──
      let frameMove = 0;
      if (faceDetected) {
        const pose = { yaw: headYaw, pitch: headPitch, roll: headRoll };
        if (lastPoseRef.current) {
          const dy = Math.abs(pose.yaw - lastPoseRef.current.yaw);
          const dp = Math.abs(pose.pitch - lastPoseRef.current.pitch);
          const dr = Math.abs(pose.roll - lastPoseRef.current.roll);
          frameMove = (dy + dp + dr) / 3;
        }
        lastPoseRef.current = pose;

        // Also track face center displacement (catches translational movement)
        const cx = lms!.reduce((s, p) => s + p.x, 0) / lms!.length;
        const cy = lms!.reduce((s, p) => s + p.y, 0) / lms!.length;
        if (lastFaceCenterRef.current) {
          const dx = Math.abs(cx - lastFaceCenterRef.current.x) * 1000;
          const dy2 = Math.abs(cy - lastFaceCenterRef.current.y) * 1000;
          frameMove = Math.max(frameMove, (dx + dy2) / 2);
        }
        lastFaceCenterRef.current = { x: cx, y: cy };
      } else {
        lastPoseRef.current = null;
        lastFaceCenterRef.current = null;
      }

      // EMA of movement (0–100 scale; ~3° per frame is "very active")
      const moveScaled = Math.min(100, frameMove * 12);
      moveEMARef.current = moveEMARef.current * 0.85 + moveScaled * 0.15;

      // ── Concentration score ──
      let target = 100;
      if (!faceDetected) {
        target = 0;
      } else {
        // Looking away (gaze or yaw)
        const lookingAway = Math.abs(gazeX) > 0.35 || Math.abs(headYaw) > 28;
        if (lookingAway) target -= 35;
        // High movement
        if (moveEMARef.current > 25) target -= 25;
        else if (moveEMARef.current > 12) target -= 12;
        // Excessive blink rate (> 25/min is above average resting rate)
        if (blinkRate > 25) target -= 10;
        // Head pitched down too far (looking at phone / away from screen)
        if (headPitch < -20) target -= 15;
      }
      // Smooth toward target (slow decay, fast recovery)
      concRef.current = concRef.current * 0.9 + target * 0.1;
      concRef.current = Math.max(0, Math.min(100, concRef.current));

      // ── Gaze status string ──
      let gazeStatus = "No face";
      if (faceDetected) {
        if (Math.abs(gazeX) > 0.35) gazeStatus = gazeX > 0 ? "Looking right" : "Looking left";
        else if (headPitch < -20) gazeStatus = "Looking down";
        else if (headPitch > 15) gazeStatus = "Looking up";
        else if (Math.abs(headYaw) > 28) gazeStatus = headYaw > 0 ? "Turned right" : "Turned left";
        else gazeStatus = "On screen";
      }

      // ── Movement status string ──
      const mv = moveEMARef.current;
      const movementStatus = !faceDetected ? "—" : mv < 6 ? "Still" : mv < 15 ? "Slight" : mv < 30 ? "Active" : "Restless";

      // ── Flush to React state ~10 fps (enough for a smooth gauge) ──
      if (now - lastFlushRef.current > 100) {
        lastFlushRef.current = now;
        setState({
          status: "ready",
          faceDetected,
          concentration: Math.round(concRef.current),
          gazeX,
          gazeStatus,
          blinkCount: blinkCountRef.current,
          blinkRate,
          headYaw: Math.round(headYaw),
          headPitch: Math.round(headPitch),
          headRoll: Math.round(headRoll),
          movement: Math.round(moveEMARef.current),
          movementStatus,
          landmarks: faceDetected ? lms! : null,
        });
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state.status]);

  return state;
}
