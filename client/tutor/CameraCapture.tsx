import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

type Phase = "asking" | "ready" | "denied" | "missing" | "failed";

/** Show Otto your work: asks the browser for the camera (only when the student taps the button), shows a live preview, and hands one photo to
 *  onCapture as a File (it then goes through the same path as a shared photo: read, described, and shown to the voice). The stream is always
 *  stopped when the dialog closes. */
export function CameraCapture(p: { onCapture: (file: File) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("asking");

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setPhase("missing"); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
        setPhase("ready");
      } catch (e: any) {
        if (!alive) return;
        const name = String(e?.name || "");
        setPhase(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "missing" : "failed");
      }
    })();
    return () => { alive = false; streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  }, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return;
      p.onCapture(new File([blob], `my-work-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.jpg`, { type: "image/jpeg" }));
      p.onClose();
    }, "image/jpeg", 0.85);
  };

  const message = phase === "denied" ? "Camera access is blocked. Allow the camera for this site in your browser's address bar (the camera icon or the lock), then tap Try again."
    : phase === "missing" ? "No camera was found on this device. You can still share a photo with the paperclip."
    : phase === "failed" ? "The camera couldn't start. Close other apps that use it and try again."
    : "";

  return (
    <div className="camera-overlay" role="dialog" aria-modal="true" aria-label="Show Otto your work">
      <div className="camera-card">
        <button type="button" className="live-icon-btn camera-close" onClick={p.onClose} aria-label="Close the camera" title="Close"><X size={18} aria-hidden="true" /></button>
        <h3>{"Show Otto your work"}</h3>
        {phase === "asking" ? <p className="muted small">{"Your browser will ask to use the camera. Say yes to take a photo of your page."}</p> : null}
        <video ref={videoRef} className="camera-video" playsInline muted hidden={phase !== "ready"} />
        {message ? <p className="muted small" role="alert">{message}</p> : null}
        <div className="camera-actions">
          {phase === "ready" ? <button type="button" className="btn primary big" onClick={snap}><Camera size={18} aria-hidden="true" /> {"Take photo"}</button> : null}
          {phase === "denied" || phase === "failed" ? <button type="button" className="btn big" onClick={() => { p.onClose(); window.setTimeout(() => window.dispatchEvent(new CustomEvent("otto-open-camera")), 50); }}>{"Try again"}</button> : null}
          <button type="button" className="btn ghost" onClick={p.onClose}>{"Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
