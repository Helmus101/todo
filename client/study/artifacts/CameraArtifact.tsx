import { useEffect, useRef, useState } from "react";
import { Camera, Eye, Activity, Move, EyeOff, Loader2, X } from "lucide-react";
import { useFaceTracking } from "../useFaceTracking.ts";

export function CameraArtifact() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tracking = useFaceTracking(videoRef, canvasRef, enabled);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setEnabled(false);
  };

  const startCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
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
            <video ref={videoRef} muted playsInline aria-label="Live camera preview" />
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
                <span>ML model failed to load — preview only</span>
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
