import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Webcam-based focus tracker for Study Mode.
 *
 * Captures periodic frames from the webcam and computes a set of attention metrics:
 *  - gazeOnScreen: is a face detected and roughly facing the camera?
 *  - movementActive: frame-difference ratio (higher = more fidgeting)
 *  - blinks: estimated blinks per minute
 *  - headPose: { yaw, pitch, roll } in degrees (approximate)
 *  - focusScore: composite 0-100 from a weighted formula of the above
 *
 * Uses the experimental Shape Detection API (FaceDetector) where available; falls back
 * to frame-differencing-only heuristics otherwise. All processing is client-side — no
 * video is ever sent to a server.
 */

export interface FocusMetrics {
  gazeOnScreen: boolean;
  movementActive: number;   // 0-1, higher = more movement
  blinksPerMin: number;
  headPose: { yaw: number; pitch: number; roll: number };
  focusScore: number;       // 0-100
}

export interface FocusTrackerHandle {
  metrics: FocusMetrics;
  start: () => Promise<void>;
  stop: () => void;
  getAverageFocus: () => number;
}

interface FocusTrackerProps {
  enabled: boolean;
  onMetrics?: (m: FocusMetrics) => void;
  onSessionEnd?: (avgFocus: number, metrics: FocusMetrics) => void;
}

const SAMPLE_INTERVAL_MS = 2000;  // analyze a frame every 2s
const BLINK_WINDOW_MS = 60_000;   // 1-min rolling window for blink rate
const SCORE_DECAY = 0.85;         // exponential smoothing for focus score

// ── Focus score formula ────────────────────────────────────────────────────
// Weighted sum of normalized sub-scores. Weights sum to 1.0.
const W = { gaze: 0.35, stillness: 0.25, blink: 0.20, pose: 0.20 };
const OPTIMAL_BLINKS_PER_MIN = 18;

function computeScore(m: Omit<FocusMetrics, "focusScore">): number {
  // Gaze: face present and looking forward → 100, absent → 0
  const gazeScore = m.gazeOnScreen ? 100 : 0;
  // Stillness: less movement = higher score (movementActive is 0-1)
  const stillnessScore = Math.max(0, 100 - m.movementActive * 200);
  // Blink: optimal around OPTIMAL_BLINKS_PER_MIN, degrades on either side
  const blinkDelta = Math.abs(m.blinksPerMin - OPTIMAL_BLINKS_PER_MIN);
  const blinkScore = Math.max(0, 100 - blinkDelta * 4);
  // Head pose: penalize large rotations
  const poseMag = Math.abs(m.headPose.yaw) + Math.abs(m.headPose.pitch) + Math.abs(m.headPose.roll);
  const poseScore = Math.max(0, 100 - poseMag * 1.5);
  return Math.round(
    gazeScore * W.gaze + stillnessScore * W.stillness + blinkScore * W.blink + poseScore * W.pose
  );
}

export function FocusTracker({ enabled, onMetrics, onSessionEnd }: FocusTrackerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const faceDetectorRef = useRef<any>(null);
  const blinkTimestampsRef = useRef<number[]>([]);
  const smoothedScoreRef = useRef<number>(50);
  const focusSamplesRef = useRef<number[]>([]);
  const lastBlinkEyeOpennessRef = useRef<number>(1);
  const metricsRef = useRef<FocusMetrics>({
    gazeOnScreen: false,
    movementActive: 0,
    blinksPerMin: 0,
    headPose: { yaw: 0, pitch: 0, roll: 0 },
    focusScore: 50,
  });

  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | "unsupported">("prompt");
  const [liveScore, setLiveScore] = useState<number | null>(null);

  // ── Initialize FaceDetector if available ────────────────────────────────
  useEffect(() => {
    if ("FaceDetector" in window) {
      try { faceDetectorRef.current = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); }
      catch { faceDetectorRef.current = null; }
    }
    return () => { stopCamera(); };
  }, []);

  const stopCamera = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    prevFrameRef.current = null;
  }, []);

  const analyzeFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const w = 160, h = 120; // downsample for speed
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h).data;

    // ── Movement: frame difference ──────────────────────────────────────
    let movementActive = 0;
    if (prevFrameRef.current) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 4) {
        diff += Math.abs(frame[i] - prevFrameRef.current[i]);
      }
      const avgDiff = diff / (frame.length / 4);
      movementActive = Math.min(1, avgDiff / 30);
    }
    prevFrameRef.current = new Uint8ClampedArray(frame);

    // ── Face/gaze/pose via FaceDetector ─────────────────────────────────
    let gazeOnScreen = false;
    let headPose = { yaw: 0, pitch: 0, roll: 0 };
    let eyeOpenness = 1; // 1 = fully open, 0 = closed

    if (faceDetectorRef.current) {
      try {
        const faces = await faceDetectorRef.current.detect(video);
        if (faces.length > 0) {
          const f = faces[0];
          gazeOnScreen = true;
          // Estimate head pose from face bounding box position
          const bx = f.boundingBox.x + f.boundingBox.width / 2;
          const by = f.boundingBox.y + f.boundingBox.height / 2;
          const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
          // Offset from center → approximate yaw/pitch
          headPose.yaw = Math.round(((bx / vw) - 0.5) * 60);
          headPose.pitch = Math.round(((by / vh) - 0.5) * 50);
          // Roll from landmarks if available
          if (f.landmarks?.length >= 2) {
            const lm = f.landmarks;
            const leftEye = lm.find((l: any) => l.type === "eye") || lm[0];
            const rightEye = lm.find((l: any, i: number) => l.type === "eye" && i > 0) || lm[1];
            if (leftEye && rightEye) {
              const dy = rightEye.y - leftEye.y;
              const dx = rightEye.x - leftEye.x;
              headPose.roll = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
              // Eye openness for blink detection
              const eyeDist = Math.hypot(dx, dy);
              const faceWidth = f.boundingBox.width;
              eyeOpenness = Math.min(1, eyeDist / (faceWidth * 0.4));
            }
          }
          // If head is turned too far, gaze is likely off-screen
          if (Math.abs(headPose.yaw) > 35 || Math.abs(headPose.pitch) > 30) gazeOnScreen = false;
        }
      } catch { /* FaceDetector can throw on some frames */ }
    } else {
      // Fallback: crude presence detection via brightness variance (a face produces more variance than an empty wall)
      let sum = 0, sumSq = 0;
      for (let i = 0; i < frame.length; i += 4) { sum += frame[i]; sumSq += frame[i] * frame[i]; }
      const n = frame.length / 4;
      const variance = sumSq / n - (sum / n) ** 2;
      gazeOnScreen = variance > 200;
    }

    // ── Blink detection (via eye openness drop) ──────────────────────────
    const now = Date.now();
    if (faceDetectorRef.current && eyeOpenness < 0.4 && lastBlinkEyeOpennessRef.current >= 0.4) {
      blinkTimestampsRef.current.push(now);
    }
    lastBlinkEyeOpennessRef.current = eyeOpenness;
    // Prune old blink timestamps
    blinkTimestampsRef.current = blinkTimestampsRef.current.filter((t) => now - t < BLINK_WINDOW_MS);
    const blinksPerMin = blinkTimestampsRef.current.length;

    // ── Compute composite focus score ───────────────────────────────────
    const raw = computeScore({ gazeOnScreen, movementActive, blinksPerMin, headPose });
    smoothedScoreRef.current = Math.round(smoothedScoreRef.current * SCORE_DECAY + raw * (1 - SCORE_DECAY));
    focusSamplesRef.current.push(smoothedScoreRef.current);

    const metrics: FocusMetrics = {
      gazeOnScreen, movementActive, blinksPerMin, headPose,
      focusScore: smoothedScoreRef.current,
    };
    metricsRef.current = metrics;
    setLiveScore(smoothedScoreRef.current);
    onMetrics?.(metrics);
  }, [onMetrics]);

  const start = useCallback(async () => {
    if (streamRef.current) return; // already running
    if (!navigator.mediaDevices?.getUserMedia) { setPermission("unsupported"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setPermission("granted");
      smoothedScoreRef.current = 50;
      focusSamplesRef.current = [];
      blinkTimestampsRef.current = [];
      intervalRef.current = setInterval(analyzeFrame, SAMPLE_INTERVAL_MS);
    } catch (e: any) {
      setPermission(e?.name === "NotAllowedError" ? "denied" : "unsupported");
    }
  }, [analyzeFrame]);

  const stop = useCallback(() => {
    stopCamera();
    const avg = focusSamplesRef.current.length
      ? Math.round(focusSamplesRef.current.reduce((a, b) => a + b, 0) / focusSamplesRef.current.length)
      : 0;
    onSessionEnd?.(avg, metricsRef.current);
  }, [stopCamera, onSessionEnd]);

  // Start/stop based on `enabled`
  useEffect(() => {
    if (enabled) void start();
    else stop();
  }, [enabled, start, stop]);

  // Clean up on unmount
  useEffect(() => () => { stopCamera(); }, [stopCamera]);

  if (permission === "denied" || permission === "unsupported") return null;

  return (
    <div className="focus-tracker-widget" style={{
      display: "flex", alignItems: "center", gap: "8px", padding: "4px 10px",
      borderRadius: "20px", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)",
      fontSize: "12px", color: "#e0e0e0", pointerEvents: "none",
    }}>
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {liveScore !== null && (
        <>
          <span style={{ fontSize: "16px" }}>
            {liveScore >= 70 ? "🎯" : liveScore >= 40 ? "◐" : "○"}
          </span>
          <span>{liveScore}</span>
          <span style={{ opacity: 0.6, fontSize: "10px" }}>focus</span>
        </>
      )}
    </div>
  );
}
