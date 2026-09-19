import { useEffect, useRef, useState } from "react";
import { Camera, Eye, Activity, Move, EyeOff, Loader2, X } from "lucide-react";
import { useFaceTracking, type FaceTrackingState } from "../useFaceTracking.ts";

interface CameraArtifactProps {
  onMetricsUpdate?: (metrics: FaceTrackingState) => void;
  onBreakSuggestion?: (message: string) => void;
  taskId?: string;
  taskTitle?: string;
  subject?: string;
}

export function CameraArtifact({ onMetricsUpdate, onBreakSuggestion, taskId, taskTitle, subject }: CameraArtifactProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);

  const tracking = useFaceTracking(videoRef, canvasRef, enabled);

  // Session tracking
  const sessionStartTimeRef = useRef<number | null>(null);
  const metricsHistoryRef = useRef<FaceTrackingState[]>([]);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastBreakSuggestionRef = useRef<number>(0);
  const lastConcentrationRef = useRef<number>(100);

  const saveSession = async () => {
    const metrics = metricsHistoryRef.current;
    if (metrics.length < 10) return; // Need at least 10 data points
    
    const startTime = sessionStartTimeRef.current;
    if (!startTime) return;
    
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 60000); // minutes
    
    // Calculate aggregated metrics
    const avgConcentration = metrics.reduce((sum, m) => sum + m.concentration, 0) / metrics.length;
    const avgMovement = metrics.reduce((sum, m) => sum + m.movement, 0) / metrics.length;
    const avgBlinkRate = metrics.reduce((sum, m) => sum + m.blinkRate, 0) / metrics.length;
    const gazeOnScreenPct = metrics.filter(m => m.gazeStatus === "On screen").length / metrics.length * 100;
    const avgHeadYaw = metrics.reduce((sum, m) => sum + m.headYaw, 0) / metrics.length;
    const avgHeadPitch = metrics.reduce((sum, m) => sum + m.headPitch, 0) / metrics.length;
    const avgHeadRoll = metrics.reduce((sum, m) => sum + m.headRoll, 0) / metrics.length;
    
    // Calculate concentration variance (stability)
    const variance = metrics.reduce((sum, m) => sum + Math.pow(m.concentration - avgConcentration, 2), 0) / metrics.length;
    const concentrationVariance = Math.sqrt(variance);
    
    // Determine focus stability
    let focusStability: "stable" | "unstable" | "highly_variable";
    if (concentrationVariance < 15) focusStability = "stable";
    else if (concentrationVariance < 30) focusStability = "unstable";
    else focusStability = "highly_variable";
    
    // Determine session quality
    let quality: "excellent" | "good" | "fair" | "poor";
    if (avgConcentration >= 80 && gazeOnScreenPct >= 90) quality = "excellent";
    else if (avgConcentration >= 65 && gazeOnScreenPct >= 75) quality = "good";
    else if (avgConcentration >= 50 && gazeOnScreenPct >= 60) quality = "fair";
    else quality = "poor";
    
    const session = {
      id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" 
        ? crypto.randomUUID() 
        : Math.random().toString(36).slice(2) + Date.now().toString(36),
      taskId,
      taskTitle,
      subject,
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
      taskCompleted: false, // TODO: Determine from task state
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
    
    // Reset for next session
    sessionStartTimeRef.current = null;
    metricsHistoryRef.current = [];
  };

  useEffect(() => {
    if (enabled && tracking.status === "ready" && onMetricsUpdate) {
      onMetricsUpdate(tracking);
      
      // Track metrics for session aggregation
      if (!sessionStartTimeRef.current) {
        sessionStartTimeRef.current = Date.now();
      }
      metricsHistoryRef.current.push({ ...tracking });
      
      // Detect focus decay for break suggestions
      const now = Date.now();
      const concentration = tracking.concentration;
      const lastConc = lastConcentrationRef.current;
      
      // If concentration has been below 40 for 2+ minutes, suggest a break
      if (concentration < 40 && lastConc < 40) {
        const lowFocusDuration = now - lastBreakSuggestionRef.current;
        if (lowFocusDuration > 120000 && onBreakSuggestion) { // 2 minutes
          onBreakSuggestion("Focus has been low for a while — consider taking a 5-minute break to refresh");
          lastBreakSuggestionRef.current = now;
        }
      }
      
      // If concentration dropped sharply (>20 points) in last 30 seconds
      if (lastConc - concentration > 20 && onBreakSuggestion) {
        const timeSinceLastSuggestion = now - lastBreakSuggestionRef.current;
        if (timeSinceLastSuggestion > 180000) { // 3 minutes between suggestions
          onBreakSuggestion("Focus dropped sharply — a short break might help");
          lastBreakSuggestionRef.current = now;
        }
      }
      
      lastConcentrationRef.current = concentration;
      
      // Debounce session save (save 1 second after metrics stop updating)
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        saveSession();
      }, 1000);
    }
  }, [enabled, tracking, onMetricsUpdate, onBreakSuggestion]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  const stopCamera = () => {
    // Save session when camera is stopped
    if (sessionStartTimeRef.current && metricsHistoryRef.current.length >= 10) {
      saveSession();
    }
    
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setVideoReady(false);
    setEnabled(false);
  };

  const attachStream = async () => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
      setVideoReady(true);
    } catch {
      setError("The camera preview could not be started. Check browser camera permission and try again.");
      stopCamera();
    }
  };

  // The video element only exists after consent changes the view from the
  // consent screen to the live screen. Attach the already-approved stream on
  // the next render instead of trying to mount it against a null ref.
  useEffect(() => {
    if (enabled) void attachStream();
  }, [enabled]);

  const startCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not supported in this browser.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      setVideoReady(false);
      setEnabled(true);
    } catch {
      setError("Camera access was not granted. Nothing was recorded or uploaded.");
      stopCamera();
    }
  };

  // ── Concentration ring colour ──
  const conc = tracking.concentration;
  const ringColor = conc >= 70 ? "#34c759" : conc >= 40 ? "#ff9f0a" : "#ff3b30";
  const ringBg = "rgba(255,255,255,0.12)";

  // SVG circle progress
  const R = 26;
  const C = 2 * Math.PI * R;
  const dash = (conc / 100) * C;

  return (
    <div className="sm-camera-artifact">
      {!enabled ? (
        <div className="sm-camera-consent">
          <div className="sm-camera-icon" aria-hidden="true">
            <Camera size={24} strokeWidth={1.5} />
          </div>
          <h3>Private focus camera</h3>
          <p>
            Optional. On-device ML tracks your face, eyes, and movement to estimate concentration. Video
            stays in this browser — never recorded, uploaded, or stored.
          </p>
          <button className="sm-btn sm-btn-primary" onClick={startCamera}>
            Allow camera
          </button>
          {error && (
            <p className="sm-camera-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="sm-camera-live">
          {/* Video + overlay */}
          <div className="sm-camera-stage">
            <video
              ref={videoRef}
              muted
              autoPlay
              playsInline
              onLoadedMetadata={() => setVideoReady(true)}
              aria-label="Live camera preview"
            />
            {!videoReady && (
              <div className="sm-camera-video-loading" role="status">
                <Loader2 size={18} className="sm-spin" />
                <span>Starting camera preview…</span>
              </div>
            )}
            <canvas ref={canvasRef} className="sm-camera-overlay" />
            {tracking.status === "loading" && (
              <div className="sm-camera-ml-loading">
                <Loader2 size={20} className="sm-spin" />
                <span>Loading ML model…</span>
              </div>
            )}
            {tracking.status === "error" && (
              <div className="sm-camera-ml-error">
                <EyeOff size={18} />
                <span>Concentration tracking unavailable — camera preview only</span>
                {process.env.NODE_ENV === "development" && tracking.errorMessage && (
                  <span className="sm-camera-ml-error-detail">{tracking.errorMessage}</span>
                )}
              </div>
            )}
            {/* Face detected badge */}
            {tracking.status === "ready" && (
              <div
                className={`sm-camera-badge ${tracking.faceDetected ? "is-on" : "is-off"}`}
              >
                <span className="sm-camera-badge-dot" />
                {tracking.faceDetected ? "Face tracked" : "No face"}
              </div>
            )}
          </div>

          {/* Metrics panel */}
          {tracking.status === "ready" && (
            <div className="sm-camera-metrics">
              {/* Concentration ring */}
              <div className="sm-metric-ring">
                <svg width="64" height="64" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r={R} fill="none" stroke={ringBg} strokeWidth="5" />
                  <circle
                    cx="32"
                    cy="32"
                    r={R}
                    fill="none"
                    stroke={ringColor}
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${C}`}
                    transform="rotate(-90 32 32)"
                    style={{ transition: "stroke-dasharray 0.3s ease, stroke 0.3s ease" }}
                  />
                </svg>
                <div className="sm-metric-ring-label">
                  <span className="sm-metric-ring-val">{conc}</span>
                  <span className="sm-metric-ring-unit">focus</span>
                </div>
              </div>

              {/* Metric chips */}
              <div className="sm-metric-chips">
                <div className="sm-metric-chip">
                  <Eye size={13} strokeWidth={2} />
                  <span className="sm-metric-chip-label">Gaze</span>
                  <span className="sm-metric-chip-val">{tracking.gazeStatus}</span>
                </div>
                <div className="sm-metric-chip">
                  <Move size={13} strokeWidth={2} />
                  <span className="sm-metric-chip-label">Movement</span>
                  <span className="sm-metric-chip-val">{tracking.movementStatus}</span>
                </div>
                <div className="sm-metric-chip">
                  <Activity size={13} strokeWidth={2} />
                  <span className="sm-metric-chip-label">Blinks</span>
                  <span className="sm-metric-chip-val">
                    {tracking.blinkCount} · {tracking.blinkRate}/min
                  </span>
                </div>
                <div className="sm-metric-chip sm-metric-chip-pose">
                  <span className="sm-metric-chip-label">Head pose</span>
                  <span className="sm-metric-chip-val">
                    Y {tracking.headYaw}° · P {tracking.headPitch}° · R {tracking.headRoll}°
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="sm-camera-live-note">
            Live preview only · on-device ML · not recorded or uploaded
          </div>
          <button className="sm-btn sm-btn-ghost" onClick={stopCamera}>
            <X size={14} /> Turn camera off
          </button>
        </div>
      )}
    </div>
  );
}

export default CameraArtifact;
