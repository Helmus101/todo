import { useCallback, useEffect, useRef, useState } from "react";
import { useFaceTracking, type FaceTrackingState } from "./useFaceTracking.ts";

export interface FocusCamera {
  enabled: boolean;
  error: string | null;
  tracking: FaceTrackingState;
  /** The live MediaStream, for a widget to attach to its own <video> for preview — a MediaStream can back
   *  multiple <video> elements at once, so the widget doesn't need the actual tracked element (see below). */
  stream: MediaStream | null;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
}

export interface UseFocusCameraOptions {
  taskId?: string;
  taskTitle?: string;
  subject?: string;
  onMetricsUpdate?: (metrics: FaceTrackingState) => void;
  onBreakSuggestion?: (message: string) => void;
}

/** Owns the camera's getUserMedia stream and the on-device face-tracking ML pipeline for the whole Study
 *  Mode session — instantiated ONCE in StudyMode.tsx, not inside the "Camera" artifact widget itself.
 *
 *  Previously this lived entirely inside CameraArtifact.tsx: the stream and the tracking <video>/<canvas>
 *  were owned by that widget's own component state, so closing the Camera panel (just one of many
 *  draggable artifact widgets on the canvas, freely opened/closed like the calculator or sticky notes)
 *  unmounted it — which ran its cleanup effect and called stream.getTracks().forEach(t => t.stop()),
 *  killing the camera and the whole focus-tracking feature. A student would have had to keep that one
 *  widget permanently open and visible on screen for the entire session for focus tracking to mean
 *  anything, which defeats the point of a background focus signal.
 *
 *  Fix: the actual tracked <video>/<canvas> pair is created here with document.createElement — NEVER
 *  inserted into any component's JSX tree — so it isn't tied to any widget's mount lifecycle at all. It
 *  keeps decoding and feeding the ML model for as long as the session considers the camera "on",
 *  independent of whether the Camera widget panel is currently open. The widget just becomes a live
 *  *view* into this shared state: it attaches its own on-screen <video> to `stream` (MediaStream supports
 *  multiple consumers) purely for the student's own preview, and can be closed/reopened freely without
 *  affecting tracking underneath.
 */
export function useFocusCamera({
  taskId, taskTitle, subject, onMetricsUpdate, onBreakSuggestion,
}: UseFocusCameraOptions = {}): FocusCamera {
  // Detached — created lazily, once, on first startCamera() — never rendered by any component.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const tracking = useFaceTracking(videoRef, canvasRef, enabled);

  // ── Session tracking + break suggestions ─────────────────────────────────────────────────────────────
  // Moved here from CameraArtifact.tsx (see the module doc comment) so this keeps accumulating and can
  // still save a session summary / surface a break suggestion even while the Camera widget is closed —
  // previously both silently stopped the moment the widget unmounted.
  const sessionStartTimeRef = useRef<number | null>(null);
  const metricsHistoryRef = useRef<FaceTrackingState[]>([]);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBreakSuggestionRef = useRef<number>(0);
  const lastConcentrationRef = useRef<number>(100);

  const saveSession = useCallback(async () => {
    const metrics = metricsHistoryRef.current;
    if (metrics.length < 10) return; // need at least 10 data points
    const startTime = sessionStartTimeRef.current;
    if (!startTime) return;
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 60000); // minutes

    const avgConcentration = metrics.reduce((sum, m) => sum + m.concentration, 0) / metrics.length;
    const avgMovement = metrics.reduce((sum, m) => sum + m.movement, 0) / metrics.length;
    const avgBlinkRate = metrics.reduce((sum, m) => sum + m.blinkRate, 0) / metrics.length;
    const gazeOnScreenPct = metrics.filter((m) => m.gazeStatus === "On screen").length / metrics.length * 100;
    const avgHeadYaw = metrics.reduce((sum, m) => sum + m.headYaw, 0) / metrics.length;
    const avgHeadPitch = metrics.reduce((sum, m) => sum + m.headPitch, 0) / metrics.length;
    const avgHeadRoll = metrics.reduce((sum, m) => sum + m.headRoll, 0) / metrics.length;
    const variance = metrics.reduce((sum, m) => sum + Math.pow(m.concentration - avgConcentration, 2), 0) / metrics.length;
    const concentrationVariance = Math.sqrt(variance);

    let focusStability: "stable" | "unstable" | "highly_variable";
    if (concentrationVariance < 15) focusStability = "stable";
    else if (concentrationVariance < 30) focusStability = "unstable";
    else focusStability = "highly_variable";

    let quality: "excellent" | "good" | "fair" | "poor";
    if (avgConcentration >= 80 && gazeOnScreenPct >= 90) quality = "excellent";
    else if (avgConcentration >= 65 && gazeOnScreenPct >= 75) quality = "good";
    else if (avgConcentration >= 50 && gazeOnScreenPct >= 60) quality = "fair";
    else quality = "poor";

    const session = {
      id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36),
      taskId, taskTitle, subject,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration,
      avgConcentration: Math.round(avgConcentration),
      avgMovement: Math.round(avgMovement),
      avgBlinkRate: Math.round(avgBlinkRate),
      gazeOnScreenPct: Math.round(gazeOnScreenPct),
      avgHeadYaw: Math.round(avgHeadYaw),
      avgHeadPitch: Math.round(avgHeadPitch),
      avgHeadRoll: Math.round(avgHeadRoll),
      concentrationVariance: Math.round(concentrationVariance),
      focusStability,
      taskCompleted: false,
      quality,
    };

    try {
      await fetch("/api/focus/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
    } catch (err) {
      console.error("Failed to save focus session:", err);
    }

    sessionStartTimeRef.current = null;
    metricsHistoryRef.current = [];
  }, [taskId, taskTitle, subject]);

  useEffect(() => {
    if (!enabled || tracking.status !== "ready") return;
    onMetricsUpdate?.(tracking);

    if (!sessionStartTimeRef.current) sessionStartTimeRef.current = Date.now();
    metricsHistoryRef.current.push({ ...tracking });

    const now = Date.now();
    const concentration = tracking.concentration;
    const lastConc = lastConcentrationRef.current;

    if (concentration < 40 && lastConc < 40) {
      const lowFocusDuration = now - lastBreakSuggestionRef.current;
      if (lowFocusDuration > 120_000 && onBreakSuggestion) {
        onBreakSuggestion("Focus has been low for a while — consider taking a 5-minute break to refresh");
        lastBreakSuggestionRef.current = now;
      }
    }
    if (lastConc - concentration > 20 && onBreakSuggestion) {
      const timeSinceLastSuggestion = now - lastBreakSuggestionRef.current;
      if (timeSinceLastSuggestion > 180_000) {
        onBreakSuggestion("Focus dropped sharply — a short break might help");
        lastBreakSuggestionRef.current = now;
      }
    }
    lastConcentrationRef.current = concentration;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => { void saveSession(); }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tracking, onMetricsUpdate, onBreakSuggestion, saveSession]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not supported in this browser.");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = s;
      if (!videoRef.current) videoRef.current = document.createElement("video");
      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const video = videoRef.current;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = s;
      await video.play();
      setStream(s);
      setEnabled(true);
    } catch {
      setError("Camera access was not granted. Nothing was recorded or uploaded.");
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStream(null);
      setEnabled(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (sessionStartTimeRef.current && metricsHistoryRef.current.length >= 10) void saveSession();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setStream(null);
    setEnabled(false);
  }, [saveSession]);

  // Only stop the camera when the whole Study Mode session unmounts (StudyMode.tsx owns this hook's call
  // site) — NOT on any per-widget unmount, since there is no per-widget unmount here anymore.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  return { enabled, error, tracking, stream, startCamera, stopCamera };
}
