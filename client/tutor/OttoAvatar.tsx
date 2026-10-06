export type OttoMood = "idle" | "thinking" | "speaking" | "listening";

/** Otto's face — the app's cream circle with two dots (the shared .tutor-face illustration) — as the whole
 *  tutor presence in the Tutor stage. State is carried by the ring around it, not by text: blinking when
 *  idle, an orbiting arc while thinking, soft ripples while speaking, an accent ring while the mic is open.
 *  All motion is CSS-only and disabled under prefers-reduced-motion. */
export function OttoAvatar({ mood = "idle", size = 64 }: { mood?: OttoMood; size?: number }) {
  return (
    <span className={`otto-avatar otto-${mood}`} style={{ width: size, height: size }} role="img" aria-label={`Otto — ${mood}`}>
      <span className="otto-ripple" aria-hidden />
      <span className="otto-ripple r2" aria-hidden />
      <span className="tutor-face otto-face" style={{ width: size, height: size, gap: size * 0.17 }} aria-hidden>
        <span className="tutor-face-eye" style={{ width: size * 0.1, height: size * 0.13 }} />
        <span className="tutor-face-eye" style={{ width: size * 0.1, height: size * 0.13 }} />
      </span>
      <span className="otto-dots" aria-hidden />
    </span>
  );
}
