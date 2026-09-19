import { useEffect, useRef, useState } from "react";
import { Camera, Eye, Activity, Move, EyeOff, Loader2, X } from "lucide-react";
import type { FocusCamera } from "../useFocusCamera.ts";

interface CameraArtifactProps {
  camera: FocusCamera;
}

// Landmark-dot indices around the eyes — same set useFaceTracking.ts draws onto its own (detached, never
// visible) tracking canvas; duplicated here in miniature so this widget's own overlay canvas can render an
// independent copy from `tracking.landmarks` without needing the actual tracked <canvas> element, which
// stays owned by useFocusCamera and outlives this widget's own mount/unmount.
const EYE_LANDMARK_IDX = [33, 133, 159, 145, 362, 263, 386, 374];

/** Purely a *view* onto the shared FocusCamera (see useFocusCamera.ts) — this widget can be freely closed
 *  and reopened by the student without affecting the underlying camera stream or ML tracking, which live
 *  at the StudyMode session level and keep running regardless of whether this panel is on screen. */
export function CameraArtifact({ camera }: CameraArtifactProps) {
  const { enabled, error, tracking, stream, startCamera, stopCamera } = camera;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  // Attach the shared stream to THIS widget's own preview <video> — a MediaStream can back multiple video
  // elements simultaneously, so this is just a second, disposable consumer of the same camera feed.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled || !stream) {
      setVideoReady(false);
      return;
    }
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [enabled, stream]);

  // Draw this widget's own overlay from the shared tracking state (landmarks are plain normalized
  // coordinates, not tied to any particular canvas) — independent of useFaceTracking's own internal canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = (canvas.width = video.videoWidth || canvas.clientWidth);
    const h = (canvas.height = video.videoHeight || canvas.clientHeight);
    ctx.clearRect(0, 0, w, h);
    const lms = tracking.landmarks;
    if (!lms || !lms.length) return;
    ctx.fillStyle = "rgba(100, 200, 255, 0.55)";
    for (const p of lms) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(0, 255, 180, 0.85)";
    for (const idx of EYE_LANDMARK_IDX) {
      const p = lms[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [tracking.landmarks]);

  // ── Concentration ring colour ──
  const conc = tracking.concentration;
  const ringColor = conc >= 70 ? "#34c759" : conc >= 40 ? "#ff9f0a" : "#ff3b30";
  const ringBg = "rgba(255,255,255,0.12)";

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
            stays in this browser — never recorded, uploaded, or stored. Once on, it keeps working for the
            rest of the session even if you close this panel.
          </p>
          <button className="sm-btn sm-btn-primary" onClick={() => void startCamera()}>
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
            Live preview only · on-device ML · not recorded or uploaded · keeps tracking even if you close this panel
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
