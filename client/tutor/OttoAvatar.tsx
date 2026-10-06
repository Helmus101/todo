export type OttoMood = "idle" | "thinking" | "speaking" | "listening";

/** Otto as a face-less friendly mark — the whole tutor presence in the Tutor stage. State is carried by the
 *  ring (not by text): breathing when idle, orbiting dots while thinking, soft ripples while speaking, an
 *  accent ring while the mic is open. All motion is CSS-only and disabled under prefers-reduced-motion. */
export function OttoAvatar({ mood = "idle", size = 64 }: { mood?: OttoMood; size?: number }) {
  return (
    <span className={`otto-avatar otto-${mood}`} style={{ width: size, height: size }} role="img" aria-label={`Otto — ${mood}`}>
      <span className="otto-ripple" aria-hidden />
      <span className="otto-ripple r2" aria-hidden />
      <svg className="otto-mark" width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
        <circle cx="24" cy="24" r="22" className="otto-disc" />
        <circle cx="24" cy="24" r="14" stroke="currentColor" strokeWidth="3.4" fill="none" />
        <path d="M17 25 L22 30 L31.5 18.5" stroke="var(--brand-mark)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <span className="otto-dots" aria-hidden><i /><i /><i /></span>
    </span>
  );
}
