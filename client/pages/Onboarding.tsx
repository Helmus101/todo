import { LanguagePicker } from "../LanguagePicker.tsx";
import { useEffect, useState, useCallback } from "react";
import type { ConnectionStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useLang, useNotify } from "../ui.tsx";
import { COMMON_SUBJECTS } from "../../shared/coursework.ts";
import { Logo } from "../appShared.tsx";
import { GoogleTiles, PronoteTile } from "./Settings.tsx";

/** First-run ONBOARDING for a brand-new account — the ONE place Otto is explained. A guided 5-step overlay:
 *  welcome + name ��� how it works → connect Pronote → preferences → done. Pronote's connect opens in a new
 *  tab; we re-check on focus so the tile flips to ✓ when the user comes back. Shown once after sign-up;
 *  finishing (or "Skip") clears the otto-onboard flag. */
// 6 screens, steps 0-5 (name, track, tour step 3, tour step 4, "where to find things", done). Was 5 while
// step 5 (the personalized "you're all set" done screen, with the student's name + Pronote-aware copy)
// existed in the JSX below but nothing ever advanced to it — step 4's button called onDone directly, so
// that screen was dead code: unreachable, and the progress dots undercounted by one. Fixed by actually
// advancing through it instead of deleting it; it's a better finish than exiting straight from step 4.
const OB_STEPS = 5;

/** Otto Lycée v2: onboarding is SIX short steps — name → track+language → what Otto does → connect
 *  everything (Pronote + Google on ONE step) → one-screen feature tour with a direct start action → a final
 *  personalized "you're all set" closing screen. v1 ran 12 screens, most of
 *  them full-page essays about one feature each (Study Mode, tutor, flashcards, automation); every extra
 *  screen is dropout for a lycéen who just wants to see the app. The per-feature detail those screens
 *  carried lives in each feature's own first-time hint instead (FirstTimeHint, client/ui.tsx), shown when
 *  the student actually reaches the feature. The old 3-app OAuth picker (Gmail/Calendar/Drive) is gone —
 *  Pronote's connect flow (URL + identifiants, handled by PronoteTile) isn't OAuth at all. */
export function Onboarding({ status, onStatus, onDone, mode = "full" }: { status?: ConnectionStatus | null; onStatus: () => void; onDone: () => void; mode?: "tutor" | "full" }) {
  const L = useLang();
  // Two flows. "tutor" (tutor-only accounts): name + language, grade, Pronote, done: no track, no subject list, no Google.
  // "full" (whole app): the complete flow below.
  const tutorMode = mode === "tutor";
  const stepOrder = tutorMode ? [0, 2, 3, 4] : [0, 1, 2, 3, 5, 4]; // 5 = "everything in Otto", full mode only
  // Every profile write below is deliberately non-blocking (a failed save shouldn't trap the student on
  // this screen — see saveTrack's own comment, and the copy already tells them everything here is
  // "changeable any time in Settings"), but non-blocking used to also mean SILENT: the catch blocks were
  // empty, so a failed save looked identical to a successful one from the student's side — they'd move on
  // thinking Otto knew their name/track when it didn't. A brief toast (the same NotifyContext every other
  // save failure in the app already uses) doesn't change the non-blocking design, it just makes "this
  // didn't save" an honest, visible fact instead of a silent one.
  const notify = useNotify();
  // Reload mid-onboarding used to always restart at step 0 — `onboard` itself survives a reload
  // (localStorage["otto-onboard"]), but `step` was plain useState with no persistence, so a student who
  // got to step 5 and refreshed (or the tab got killed/restored) landed back on "what's your name" with
  // no memory of getting that far. Name/track/language ALREADY saved server-side by that point get
  // silently redone, which is at least harmless — but re-walking steps you already finished is exactly
  // the opposite of "seamless." Persisted the same way `onboard` itself is.
  const [step, setStepState] = useState(() => {
    try { return Math.min(OB_STEPS - 1, Math.max(0, Number(localStorage.getItem("otto-onboard-step")) || 0)); }
    catch { return 0; }
  });
  const setStep = (s: number) => {
    setStepState(s);
    try { localStorage.setItem("otto-onboard-step", String(s)); } catch { /* best-effort */ }
  };
  const [name, setName] = useState("");
  const [pronoteConnected, setPronoteConnected] = useState(false);
  // Which curriculum/track the student is on — drives both AI vocabulary (trackLine() in server/claude.ts,
  // already good) and, from here on, whether Pronote gets framed as THE data source or as one option among
  // several. Previously never asked anywhere, so every account silently defaulted to unset/"bac"-shaped
  // assumptions regardless of what the student actually needed.
  // Persisted the same way `step` is (localStorage) — plain useState reverted to null on every reload, so a
  // student who picked "ib" on step 1 and refreshed mid-onboarding (their track already saved server-side
  // by then) would see step 3's pronoteIsPrimary computed from a null track again, i.e. the wrong (primary)
  // Pronote copy for an IB student.
  const [track, setTrackState] = useState<"ib" | "ap" | "bac" | "other" | null>(() => {
    try { return (localStorage.getItem("otto-onboard-track") as "ib" | "ap" | "bac" | "other" | null) || null; }
    catch { return null; }
  });
  const setTrack = (t: "ib" | "ap" | "bac" | "other" | null) => {
    setTrackState(t);
    try { if (t) localStorage.setItem("otto-onboard-track", t); else localStorage.removeItem("otto-onboard-track"); } catch { /* best-effort */ }
  };
  // Year level is no longer asked in onboarding: it was one more field on day one for optional context,
  // and the track pick already calibrates the AI vocabulary. It remains fully settable in Settings
  // (PreferencesFields.saveYearLevel), which is the right home for an optional detail.
  // Year + subjects: the last things the basic flow collects (the page guides cover everything else).
  const [year, setYear] = useState("");
  const [subs, setSubs] = useState<string[]>([]);
  // Any grade is allowed: the chips are shortcuts, "Other" opens a free-text box (also used for a saved grade that is not a chip).
  const YEAR_CHIPS = ["Seconde", "Première", "Terminale", "IB DP1", "IB DP2", "Grade 9", "Grade 10", "Grade 11", "Grade 12"];
  const [yearOther, setYearOther] = useState(false);
  const showYearBox = yearOther || (!!year && !YEAR_CHIPS.includes(year));
  // Prefill from what the account already has — matters for "Test onboarding" replays, where re-asking
  // for what's already known (and showing empty fields) would look broken.
  useEffect(() => {
    let alive = true;
    void api.profile().then((p) => {
      if (!alive) return;
      if (p.name) setName((n) => n || p.name!);
      if (p.track) setTrack(p.track);
      if (p.yearLevel) setYear(p.yearLevel);
      if (p.subjects?.length) setSubs(p.subjects);
    }).catch(() => { /* a blank form is fine */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveYearSubjects = async () => {
    try {
      if (year.trim()) await api.setProfilePreference("yearLevel", year.trim());
      if (!tutorMode) await api.setSubjects(subs);
    } catch { notify("Year/subjects didn't save — you can set them later in Settings.", "error"); }
    setStep(3);
  };
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { notify("Name didn't save — you can set it later in Settings.", "error"); } }
    setStep(tutorMode ? 2 : 1);
  };
  const saveTrack = async (t: "ib" | "ap" | "bac" | "other") => {
    setTrack(t);
    try { await api.setProfilePreference("track", t); await onStatus(); } catch { notify("Track didn't save — you can set it later in Settings.", "error"); }
    // Used to jump straight to step 2 here — but the year-level field below lives on this SAME step, so
    // auto-advancing the instant a track button is clicked never gave the student a chance to see or fill
    // it in. Stay put; "Continue" (added alongside the field) is what actually moves on now.
  };
  const checkPronote = useCallback(async () => { try { const s = await api.pronoteStatus(); setPronoteConnected(s.connected); onStatus(); } catch { /* keep last */ } }, [onStatus]);
  useEffect(() => { void checkPronote(); }, [checkPronote]);
  // Pronote is a French national-education-system tool — real and worth asking about for "bac"/unset, but
  // actively misleading to lead with for an IB/other-track student whose school very likely doesn't use it
  // at all (Google Classroom, Managebac, Toddle, or just email/calendar are far more common internationally).
  // Previously hardcoded `false` regardless of the track picked in step 1 — every student, including "bac"
  // ones who'd just chosen Pronote as their real primary source, saw the non-primary "if you have one"
  // copy. Derive it from the actual selection: primary unless the student is explicitly on IB or AP (unset
  // track still defaults to primary, same as the "bac"/unset framing the comment above already describes).
  // AP is a US College Board program — like IB, essentially never on Pronote (a French national tool).
  const pronoteIsPrimary = track !== "ib" && track !== "ap";

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <button className="onboard-skip" onClick={onDone} aria-label={"Skip"}>{"Skip"}</button>
        <div className="onboard-top">
          <div className="onboard-brand"><Logo size={20} /> <span>Otto</span> <LanguagePicker compact /></div>
          <div className="onboard-progress" role="progressbar" aria-valuemin={1} aria-valuemax={stepOrder.length} aria-valuenow={stepOrder.indexOf(step) + 1} aria-label={`Step ${stepOrder.indexOf(step) + 1} of ${stepOrder.length}`}>
            {stepOrder.map((_, d) => <span key={d} aria-hidden="true" className={d <= stepOrder.indexOf(step) ? "on" : ""} />)}
          </div>
        </div>

        {step === 0 && (
          <div className="onboard-step">
            <h2>{"Welcome to Otto"}</h2>
            <p className="onboard-lead">{"Otto turns homework, tests, and emails into a clear plan — without doing the work for you. Connect a source or add tasks yourself."}</p>
            <label className="field onboard-name"><span>{"What should Otto call you?"}</span>
              <input className="addinput" placeholder={"Your first name (optional)"} value={name} maxLength={60} autoFocus
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
            </label>
            <label className="field onboard-name"><span>{"Language"}</span>
              <LanguagePicker />
            </label>
            <p className="muted small">{"You can change these later in Settings."}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={() => void saveName()}>{"Get started"}</button></div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-step">
            <h2>{"Your track"}</h2>
            <p className="onboard-lead">{"Changes the vocabulary Otto uses."}</p>
            <div className="onboard-apps">
              <button type="button" className={`btn xs ob-track-btn ${track === "bac" ? "" : "ghost"}`} onClick={() => void saveTrack("bac")}>{"French Bac (lycée)"}</button>
              <button type="button" className={`btn xs ob-track-btn ${track === "ib" ? "" : "ghost"}`} onClick={() => void saveTrack("ib")}>IB</button>
              <button type="button" className={`btn xs ob-track-btn ${track === "ap" ? "" : "ghost"}`} onClick={() => void saveTrack("ap")}>AP</button>
              <button type="button" className={`btn xs ob-track-btn ${track === "other" ? "" : "ghost"}`} onClick={() => void saveTrack("other")}>{"Other (middle school, etc.)"}</button>
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(0)}>{"Back"}</button>
              <button className="btn primary" onClick={() => setStep(2)}>{"Continue"}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-step">
            <h2>{tutorMode ? "Your grade" : "Your classes"}</h2>
            <p className="onboard-lead">{tutorMode ? "Otto pitches his questions at your level." : "Otto pitches his level to you and files your coursework by subject."}</p>
            {!tutorMode && <p className="onboard-lead mt-3">{"Your year"}</p>}
            <div className="onboard-chips">
              {YEAR_CHIPS.map((y) => (
                <button key={y} type="button" className={`btn xs ${year === y ? "" : "ghost"}`} onClick={() => { setYear(y); setYearOther(false); }} aria-pressed={year === y}>{y}</button>
              ))}
              <button type="button" className={`btn xs ${showYearBox ? "" : "ghost"}`} onClick={() => { setYearOther(true); if (YEAR_CHIPS.includes(year)) setYear(""); }} aria-pressed={showYearBox}>{"Other"}</button>
            </div>
            {showYearBox && (
              <label className="field onboard-name mt-3"><span>{"Your grade or level"}</span>
                <input className="addinput" placeholder={"e.g. Year 8, 6ème, first-year university"} value={year} maxLength={40} autoFocus
                  onChange={(e) => setYear(e.target.value)} />
              </label>
            )}
            {!tutorMode && <p className="onboard-lead mt-4">{"Your subjects"}</p>}
            {!tutorMode && <div className="onboard-chips">
              {COMMON_SUBJECTS.filter((x) => x !== "Other").map((x) => (
                <button key={x} type="button" className={`btn xs ${subs.includes(x) ? "" : "ghost"}`} onClick={() => setSubs((cur) => (cur.includes(x) ? cur.filter((c) => c !== x) : [...cur, x]))} aria-pressed={subs.includes(x)}>{x}</button>
              ))}
            </div>}
            <p className="muted small">{"Optional — change it any time in Settings."}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(tutorMode ? 0 : 1)}>{"Back"}</button>
              <button className="btn primary" onClick={() => void saveYearSubjects()}>{"Continue"}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step">
            {/* Pronote is a French national-education-system tool — only worth leading with for a Bac/unset
                track. An IB/other-track student's school very likely doesn't use it at all, so this step
                reframes as optional/parallel rather than "the one thing Otto reads" for them. Pronote and
                Google live on ONE step now — two separate connect screens was two more taps for zero
                extra understanding, and both are skippable anyway. */}
            <h2>{tutorMode ? "Connect Pronote" : "Connect your sources"}</h2>
            <p className="onboard-lead">{tutorMode
              ? "Optional. If your school uses Pronote, Otto can see your homework and tests and start from what you're studying. Your credentials are encrypted."
              : pronoteIsPrimary
              ? "Pronote alone gets Otto going. Gmail and Calendar are optional — Otto spots homework and deadlines in them. Your credentials are encrypted, never resold."
              : "Most IB schools don't use Pronote — connect it only if your school has it. Otherwise Gmail/Calendar, or add your homework by hand."}</p>
            <div className="onboard-apps">
              <PronoteTile status={status} onChanged={() => void checkPronote()} />
              {!tutorMode && <GoogleTiles restricted={true} onChanged={() => void onStatus()} />}
            </div>
            <p className="muted small">{"You can connect any of these later from Settings."}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(2)}>{"Back"}</button>
              <button className="btn primary big" onClick={() => setStep(tutorMode ? 4 : 5)}>{pronoteConnected ? "Continue — connected ✓" : "Later"}</button>
            </div>
          </div>
        )}

        {/* One screen, one line per feature — the old flow spent FOUR separate screens (Study Mode,
            tutor, flashcards/quiz/notes, daily automation) on this same content. Those screens were the
            flow's whole length problem: everything a student actually needs on day one fits in one line
            each here, and the per-feature detail lives where it belongs — in the feature's own
            first-time hint (FirstTimeHint, client/ui.tsx), shown when the student actually reaches it. */}
        {step === 5 && (
          <div className="onboard-step">
            <h2>{"Everything in Otto"}</h2>
            <p className="onboard-lead">{"Six places, one plan. Each one explains itself the first time you open it."}</p>
            <ul className="onboard-everything">
              {([
                ["Today", "Your plan: homework, tests and emails from your sources, ordered by what matters most, each with steps."],
                ["Tutor", "Talk it through out loud on a shared whiteboard. Otto asks instead of telling, and explains when you're stuck."],
                ["Journal", "One line a day about what you learned. Otto turns it into flashcards and spaced reviews."],
                ["Coursework", "Add worksheets and chapters by subject. Otto reads them and uses them in chats and tasks."],
                ["Mistakes", "Log precise mistakes. Otto quizzes you where you slip so you don't repeat them."],
                ["Settings", "Your sources, level, subjects and language, and everything Otto knows about you."],
              ] as const).map(([name, what]) => (
                <li key={name}><b>{name}</b><span>{what}</span></li>
              ))}
            </ul>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(3)}>{"Back"}</button>
              <button className="btn primary big" onClick={() => setStep(4)}>{"Continue"}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboard-step onboard-done">
            <div className="onboard-done-mark"><Logo size={30} /></div>
            <h2>{"You're all set"}{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}</h2>
            <p className="onboard-lead">{tutorMode
              ? "Pick a subject, press Start talking, and Otto asks the first question. Press the button again whenever you want to stop."
              : pronoteConnected
              ? "Otto is getting to work. Your plan for today is on its way."
              // Nothing connected yet — offer the whole picker (Pronote, Gmail, Calendar, Drive) rather
              // than naming Pronote as if it were required, and remind them manual tasks work too.
              : "Connect an app (Pronote, Gmail, Calendar) or add your exams from Settings, and Otto gets to work."}</p>
            {!tutorMode && <p className="muted small">{"The first time you open a page, Otto shows you how it works — step by step, on the real buttons."}</p>}
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>{tutorMode ? "Start talking" : "See my tasks"}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
