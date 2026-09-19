import { useEffect, useRef, useState } from "react";

export function CameraArtifact() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
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
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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

  return (
    <div className="sm-camera-artifact">
      {!enabled ? (
        <div className="sm-camera-consent">
          <div className="sm-camera-icon" aria-hidden="true">◉</div>
          <h3>Private focus camera</h3>
          <p>This is optional. Video stays in this browser, is never recorded, uploaded, or stored, and stops when you turn it off.</p>
          <button className="sm-btn sm-btn-primary" onClick={startCamera}>Allow camera</button>
          {error && <p className="sm-camera-error" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="sm-camera-live">
          <video ref={videoRef} muted playsInline aria-label="Live camera preview" />
          <div className="sm-camera-live-note">Live preview only · not recorded or uploaded</div>
          <button className="sm-btn sm-btn-ghost" onClick={stopCamera}>Turn camera off</button>
        </div>
      )}
    </div>
  );
}

export default CameraArtifact;
