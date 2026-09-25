import { useState, useRef, useCallback } from "react";
import { useSmClose, SmSurface, SmBackdrop, useLang } from "../ui.tsx";
import { hasExtension } from "./extensionBridge.ts";

// How long the End button must be held before it actually fires. Only meaningfully enforced (as a real
// "commit to this" gesture, not just a stylistic delay) when the extension is installed and sites are
// genuinely blocked — see EndSessionModal's own comment on why it stays consistent either way.
const LONG_PRESS_MS = 1500;

interface EndSessionModalProps {
  completedSteps: number;
  totalSteps: number;
  elapsed: number;
  formatTime: (s: number) => string;
  onContinue: () => void;
  onEnd: (review: { finished?: string; confusing?: string; nextStep?: string }) => void;
}

// A ~60-second close-out, not a form: three short optional prompts ("what did I finish", "what confused
// me", "what's the next smallest step") — the same reflection loop as the per-step SubtaskSubmit, just
// once per session instead of once per step. Ending is still one click away (all fields optional) — this
// is a nudge toward reflection, not exit friction for its own sake.
//
// EXCEPT the End button itself: it now requires a LONG PRESS (hold LONG_PRESS_MS), not a click. This is
// the deliberate "commit to actually stopping" gesture the extension's site-blocking feature (see
// extensionBridge.ts) is built around — a stray/accidental click must never be enough to unblock everything
// mid-session, only a genuine hold. Kept as a hold-to-confirm REGARDLESS of whether the extension is
// installed (hasExtension()) — consistent behavior either way is better than the button's whole interaction
// model silently changing depending on an install the student may not even know exists.
export function EndSessionModal({ completedSteps, totalSteps, elapsed, formatTime, onContinue, onEnd }: EndSessionModalProps) {
  const L = useLang();
  const [finished, setFinished] = useState("");
  const [confusing, setConfusing] = useState("");
  const [nextStep, setNextStep] = useState("");
  // "Continue studying" dismisses back into the session (this modal's real "close") — animate it.
  // "End session" navigates away to a different screen entirely, where this exit motion would never be
  // seen, so it stays immediate rather than adding a pointless delay before the real transition starts.
  const { closing, doClose: doContinue } = useSmClose(onContinue, 200);

  const [holdProgress, setHoldProgress] = useState(0); // 0..1, drives the fill animation
  const [holding, setHolding] = useState(false);
  const holdStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const doEnd = useCallback(() => {
    onEnd({
      finished: finished.trim() || undefined,
      confusing: confusing.trim() || undefined,
      nextStep: nextStep.trim() || undefined,
    });
  }, [onEnd, finished, confusing, nextStep]);

  const tick = useCallback(() => {
    const elapsedMs = Date.now() - holdStartRef.current;
    const p = Math.min(1, elapsedMs / LONG_PRESS_MS);
    setHoldProgress(p);
    if (p >= 1) {
      if (!firedRef.current) { firedRef.current = true; doEnd(); }
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [doEnd]);

  const startHold = useCallback(() => {
    firedRef.current = false;
    holdStartRef.current = Date.now();
    setHolding(true);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const cancelHold = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setHolding(false);
    setHoldProgress(0);
  }, []);

  return (
    <SmBackdrop closing={closing} className="sm-modal-backdrop">
      <SmSurface variant="modal" closing={closing} className="sm-modal">
        <h2>{L("Terminer la session de révision ?", "End study session?")}</h2>
        <p className="sm-modal-sub">{L("Ton bureau sera sauvegardé exactement comme il est.", "Your environment will be saved exactly as it is.")}</p>

        <div className="sm-modal-stats">
          <div className="sm-modal-stat">
            <span className="sm-modal-stat-value">{formatTime(elapsed)}</span>
            <span className="sm-modal-stat-label">{L("Temps de travail", "Time studied")}</span>
          </div>
          {totalSteps > 0 && (
            <div className="sm-modal-stat">
              <span className="sm-modal-stat-value">{completedSteps} / {totalSteps}</span>
              <span className="sm-modal-stat-label">{L("Étapes terminées", "Steps completed")}</span>
            </div>
          )}
        </div>

        <div className="sm-modal-review">
          <label>
            {L("Qu'as-tu terminé ?", "What did you finish?")}
            <input value={finished} onChange={(e) => setFinished(e.target.value)} placeholder={L("Facultatif", "Optional")} />
          </label>
          <label>
            {L("Qu'est-ce qui t'a bloqué ?", "What confused you?")}
            <input value={confusing} onChange={(e) => setConfusing(e.target.value)} placeholder={L("Facultatif", "Optional")} />
          </label>
          <label>
            {L("Quelle est la prochaine petite étape ?", "What's the next smallest step?")}
            <input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder={L("Facultatif", "Optional")} />
          </label>
        </div>

        <div className="sm-modal-actions">
          <button className="sm-btn sm-btn-ghost" onClick={doContinue}>{L("Continuer à travailler", "Continue studying")}</button>
          <button
            type="button"
            className={`sm-btn sm-btn-danger sm-btn-hold ${holding ? "sm-btn-holding" : ""}`}
            style={{ ["--hold-progress" as any]: holdProgress }}
            onPointerDown={startHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
          >
            <span className="sm-btn-hold-fill" aria-hidden="true" />
            <span className="sm-btn-hold-label">
              {holding
                ? (hasExtension() ? L("Continue d'appuyer pour débloquer et terminer…", "Keep holding to unblock & end…") : L("Continue d'appuyer pour terminer…", "Keep holding to end…"))
                : L("Maintenir pour terminer", "Hold to end session")}
            </span>
          </button>
        </div>
        {hasExtension() && (
          <p className="sm-modal-hold-hint">{L("Les autres sites restent bloqués tant que ce bouton n'est pas maintenu.", "Other sites stay blocked until you hold this button to end.")}</p>
        )}
      </SmSurface>
    </SmBackdrop>
  );
}
