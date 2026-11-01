import { LanguagePicker } from "../LanguagePicker.tsx";
import { useEffect, useState } from "react";
import type { ConnectionStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useNotify } from "../ui.tsx";
import { IbSubjectPicker } from "./IbSubjectPicker.tsx";
import type { IbSubject } from "../../shared/ibSubjectList.ts";
import { Logo } from "../appShared.tsx";

/** First-run ONBOARDING: four short screens. Are you in the IB (yes or no) → your first name → DP1 or DP2 → your subjects with
 *  levels. A student who says no skips the year and subjects and gets the tutor on their own curriculum. Everything else
 *  (Pronote, Google, the page guides) is introduced where it is used, not here. Every save is non-blocking and says so with a
 *  toast when it fails; the step survives a reload. Finishing (or "Skip") clears the otto-onboard flag. */
const OB_STEPS = 4;
const YEAR_CHIPS = ["IB DP1", "IB DP2"];

export function Onboarding({ onStatus, onDone }: { status?: ConnectionStatus | null; onStatus: () => void; onDone: () => void; mode?: "tutor" | "full" }) {
  const notify = useNotify();
  // step 0 in the IB? · 1 name · 2 DP1 or DP2 · 3 subjects
  const [step, setStepState] = useState(() => {
    try { return Math.min(OB_STEPS - 1, Math.max(0, Number(localStorage.getItem("otto-onboard-step")) || 0)); } catch { return 0; }
  });
  const setStep = (s: number) => { setStepState(s); try { localStorage.setItem("otto-onboard-step", String(s)); } catch { /* best-effort */ } };
  const [inIb, setInIb] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [ibSubs, setIbSubs] = useState<IbSubject[]>([]);
  // Prefill from what the account already has, so a "Test onboarding" replay is not blank.
  useEffect(() => {
    let alive = true;
    void api.profile().then((p) => {
      if (!alive) return;
      if (p.name) setName((n) => n || p.name!);
      if (p.yearLevel) setYear(p.yearLevel);
      if (p.ibSubjects?.length) setIbSubs(p.ibSubjects);
    }).catch(() => { /* a blank form is fine */ });
    return () => { alive = false; };
  }, []);

  const answerIb = async (yes: boolean) => {
    setInIb(yes);
    if (!yes) { try { await api.setProfilePreference("track", "other"); await onStatus(); } catch { /* Settings has the same switch */ } }
    setStep(1);
  };
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { notify("Name didn't save. You can set it later in Settings.", "error"); } }
    if (inIb === false) onDone(); else setStep(2);
  };
  const saveSubjects = async () => {
    try {
      const dp = /DP\s?([12])/i.exec(year);
      await api.setIbSubjects(ibSubs, dp ? (`DP${dp[1]}` as "DP1" | "DP2") : undefined);
      await onStatus();
    } catch { notify("Your subjects didn't save. You can set them later in Settings.", "error"); }
    onDone();
  };
  const at = Math.min(step, OB_STEPS - 1);

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <button className="onboard-skip" onClick={onDone} aria-label={"Skip"}>{"Skip"}</button>
        <div className="onboard-top">
          <div className="onboard-brand"><Logo size={20} /> <span>Otto</span> <LanguagePicker compact /></div>
          <div className="onboard-progress" role="progressbar" aria-valuemin={1} aria-valuemax={OB_STEPS} aria-valuenow={at + 1} aria-label={`Step ${at + 1} of ${OB_STEPS}`}>
            {Array.from({ length: OB_STEPS }, (_, d) => <span key={d} aria-hidden="true" className={d <= at ? "on" : ""} />)}
          </div>
        </div>

        {step === 0 && (
          <div className="onboard-step">
            <h2>{"Welcome to Otto"}</h2>
            <p className="onboard-lead">{"The voice tutor built for the IB Diploma. It asks instead of telling, teaches to your papers and mark schemes, and never does the work for you."}</p>
            <p className="onboard-lead mt-3">{"Are you in the IB?"}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn primary big" onClick={() => void answerIb(true)}>{"Yes"}</button>
              <button className="btn ghost big" onClick={() => void answerIb(false)}>{"No"}</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-step">
            <h2>{"What should Otto call you?"}</h2>
            <label className="field onboard-name"><span>{"First name"}</span>
              <input className="addinput" placeholder={"Your first name (optional)"} value={name} maxLength={60} autoFocus
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
            </label>
            <label className="field onboard-name"><span>{"Language"}</span><LanguagePicker /></label>
            <p className="muted small">{"You can change these later in Settings."}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(0)}>{"Back"}</button>
              <button className="btn primary big" onClick={() => void saveName()}>{inIb === false ? "Start" : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-step">
            <h2>{"Which year are you in?"}</h2>
            <div className="onboard-chips">
              {YEAR_CHIPS.map((y) => (
                <button key={y} type="button" className={`btn ${year === y ? "" : "ghost"}`} onClick={() => setYear(y)} aria-pressed={year === y}>{y}</button>
              ))}
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(1)}>{"Back"}</button>
              <button className="btn primary big" disabled={!year} onClick={() => setStep(3)}>{"Continue"}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step">
            <h2>{"Your IB subjects"}</h2>
            <p className="onboard-lead">{"Pick your subjects and levels so every question, mark scheme and command term fits your courses."}</p>
            <IbSubjectPicker value={ibSubs} onChange={setIbSubs} />
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(2)}>{"Back"}</button>
              <button className="btn primary big" onClick={() => void saveSubjects()}>{"Start"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
