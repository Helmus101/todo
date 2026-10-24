import { LanguagePicker } from "../LanguagePicker.tsx";
import { FeedbackForm } from "./FeedbackForm.tsx";
import { StudyStatsSection } from "./StudyStats.tsx";
import { AdminTools } from "./AdminTools.tsx";
import { useEffect, useState, useCallback, useRef } from "react";
import type { WebTask, ConnectionStatus, Profile } from "../../shared/types.ts";
import { api, type IntegrationItem, type ConnectedAccount } from "../api.ts";
import { useLang, useNotify, ErrorNote } from "../ui.tsx";
import { clearAllLocalAccountData, LEGAL_EMAIL } from "../appShared.tsx";

/** Scroll-reveal: any element with className "reveal" inside this component fades/rises into place the
 *  first time it enters the viewport (CSS does the actual animation — see `.reveal`/`.reveal.in` in
 *  styles.css). Originally inline in the marketing Landing page; pulled out so the same premium-feel
 *  entrance can be reused across the real app (Settings, the dashboard's own sections) without copying the
 *  IntersectionObserver wiring. Respects prefers-reduced-motion (reveals everything immediately, no motion). */
function useReveal(deps: readonly unknown[] = []) {
  useEffect(() => {
    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// A "YYYY-MM-DD" (or ISO) date → "Aug 1". Optional `L(fr, en)` (same
// one every caller already has from useLang()) picks the locale — a French account no longer falls back to
// whatever locale the BROWSER happens to be set to, which isn't necessarily the same language at all.

function fmtDay(iso: string, L?: (fr: string, en: string) => string): string {
  const d = new Date(/T/.test(iso) ? iso : `${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Survives a PronoteTile remount (e.g. navigating away from Settings and back) — see its own comment on
// `optimistic` for why plain component state wasn't enough. sessionStorage (not localStorage): this is a
// per-tab "trust my own recent action over a possibly-lagging read" signal, not something that should
// follow the account to a different tab/device where no such action just happened.
const PRONOTE_OPTIMISTIC_KEY = "otto-pronote-optimistic";

const PRONOTE_OPTIMISTIC_MAX_AGE_MS = 2 * 60_000;

function readPronoteOptimistic(): boolean | null {
  try {
    const raw = sessionStorage.getItem(PRONOTE_OPTIMISTIC_KEY);
    if (!raw) return null;
    const { value, at } = JSON.parse(raw);
    if (typeof at !== "number" || Date.now() - at > PRONOTE_OPTIMISTIC_MAX_AGE_MS) { sessionStorage.removeItem(PRONOTE_OPTIMISTIC_KEY); return null; }
    return typeof value === "boolean" ? value : null;
  } catch { return null; }
}

function writePronoteOptimistic(value: boolean | null): void {
  try {
    if (value === null) sessionStorage.removeItem(PRONOTE_OPTIMISTIC_KEY);
    else sessionStorage.setItem(PRONOTE_OPTIMISTIC_KEY, JSON.stringify({ value, at: Date.now() }));
  } catch { /* private browsing / storage full — falls back to the plain in-memory default */ }
}

/** Language toggle — shared between Settings and Onboarding so the same question/UI isn't built twice.
 *  Renders bare rows (no wrapping section) so it drops into either container's own `.set-list`/step
 *  markup. `onChanged` receives the fresh profile after each save. */
function PreferencesFields({ profile, onChanged }: { profile: Profile | null; onChanged?: (p: Profile) => void }) {
  const L = useLang();
  const notify = useNotify();
  // Track: onboarding's copy has always claimed this is "changeable any time in Settings" — it wasn't
  // actually wired up here, so that claim was false for anyone past onboarding. Same optimistic-save
  // pattern as language above.
  const [track, setTrackState] = useState<"ib" | "ap" | "bac" | "other" | undefined>(profile?.track);
  useEffect(() => { setTrackState(profile?.track); }, [profile?.track]);
  const saveTrack = async (v: "ib" | "ap" | "bac" | "other") => {
    const prev = track;
    setTrackState(v);
    try { onChanged?.(await api.setProfilePreference("track", v)); }
    catch (e: any) { setTrackState(prev); notify(e?.message || "That didn't save — give it another try.", "error"); }
  };
  // Hint density — a DIFFERENT axis from learningStyle (VARK, presentation-only): this is how much the
  // tutor walks through vs. just nudges when the student is stuck. Never changes whether the direct
  // answer is given (that's unconditionally never, server-side) — only how much scaffolding leads there.
  // A 3-position slider/bar, not two separate toggle buttons — "hints" (0) ↔ "balanced" (1, default) ↔
  // "steps" (2). "balanced" is an explicit value (not just unset) so the slider always has a definite
  // position to render, including for a brand-new account that's never touched this preference.
  const HINT_DENSITY_POSITIONS: ("hints" | "balanced" | "steps")[] = ["hints", "balanced", "steps"];
  const [hintDensity, setHintDensityState] = useState<"steps" | "hints" | "balanced" | undefined>(profile?.hintDensity);
  useEffect(() => { setHintDensityState(profile?.hintDensity); }, [profile?.hintDensity]);
  const saveHintDensity = async (v: "steps" | "hints" | "balanced") => {
    const prev = hintDensity;
    setHintDensityState(v);
    try { onChanged?.(await api.setProfilePreference("hintDensity", v)); }
    catch (e: any) { setHintDensityState(prev); notify(e?.message || "That didn't save — give it another try.", "error"); }
  };
  // Year/grade level — free text (see Profile.yearLevel's doc comment for why not a dropdown). Local draft
  // state so typing doesn't round-trip on every keystroke; saved on blur/Enter like other free-text fields.
  const [yearLevel, setYearLevelState] = useState(profile?.yearLevel || "");
  useEffect(() => { setYearLevelState(profile?.yearLevel || ""); }, [profile?.yearLevel]);
  const saveYearLevel = async () => {
    const v = yearLevel.trim();
    if (v === (profile?.yearLevel || "")) return;
    try { onChanged?.(await api.setProfilePreference("yearLevel", v)); }
    catch (e: any) { notify(e?.message || "That didn't save — give it another try.", "error"); }
  };
  return (
    <>
      <div className="set-row">
        <span className="set-text"><b>{"Are you in the IB Diploma?"}</b><span className="settings-hint">{"Yes: Otto teaches to the IB, with your papers, command terms, mark schemes and each subject's syllabus. No: it stays a general tutor and ignores all IB specifics. The IB material follows one school's 2026 to 2028 course outlines and covers Maths, Physics, Chemistry, Biology, Economics, History, Geography, Computer Science, TOK, English A and Languages; other courses get the general IB knowledge only. Put your exact courses and levels (for example Maths AA HL) under Courses in \u201CWhat Otto knows about you\u201D."}</span></span>
        <div className="lang-toggle">
          <button type="button" className={`btn xs ${track === "ib" ? "" : "ghost"}`} aria-pressed={track === "ib"} onClick={() => void saveTrack("ib")}>{"Yes"}</button>
          <button type="button" className={`btn xs ${track && track !== "ib" ? "" : "ghost"}`} aria-pressed={!!track && track !== "ib"} onClick={() => void saveTrack(track && track !== "ib" ? track : "other")}>{"No"}</button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-text"><b>{"Your track"}</b><span className="settings-hint">{"Your programme, so exam practice matches it."}</span></span>
        <div className="lang-toggle">
          <button type="button" className={`btn xs ${track === "bac" ? "" : "ghost"}`} aria-pressed={track === "bac"} onClick={() => void saveTrack("bac")}>{"Bac"}</button>
          <button type="button" className={`btn xs ${track === "ib" ? "" : "ghost"}`} aria-pressed={track === "ib"} onClick={() => void saveTrack("ib")}>IB</button>
          <button type="button" className={`btn xs ${track === "ap" ? "" : "ghost"}`} aria-pressed={track === "ap"} onClick={() => void saveTrack("ap")}>AP</button>
          <button type="button" className={`btn xs ${track === "other" ? "" : "ghost"}`} aria-pressed={track === "other"} onClick={() => void saveTrack("other")}>{"Other"}</button>
        </div>
      </div>
      <label className="set-row">
        <span className="set-text"><b>{"Your year/grade"}</b><span className="settings-hint">{"Otto pitches every question at your level."}</span></span>
        <input className="addinput" style={{ maxWidth: 160 }} maxLength={40}
          placeholder={track === "ib" ? "e.g. DP1" : track === "ap" ? "e.g. Junior year" : track === "other" ? "e.g. Grade 7" : "e.g. Terminale"}
          value={yearLevel} onChange={(e) => setYearLevelState(e.target.value)}
          onBlur={() => void saveYearLevel()} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
    </>
  );
}

/** The landing page (shown logged out at route /) — sharp, crisp positioning as a trusted decision engine. */
/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
/** Settings → "How Otto teaches you": what the tutor's learned policy (a small neural net trained with reinforcement
 *  learning on how you react to each teaching move) currently favours for you, with a reset. */
const MOVE_LABEL: Record<string, [string, string]> = {
  probe: ["te poser une question ouverte", "asking you an open question"],
  "smaller-step": ["découper en plus petites étapes", "breaking it into smaller steps"],
  "worked-parallel": ["montrer un exemple parallèle", "showing a parallel worked example"],
  visual: ["dessiner un schéma", "drawing a picture"],
  analogy: ["utiliser une analogie", "using an analogy"],
  "reflect-back": ["reformuler ce que tu dis", "saying back what you said"],
  "direct-hint": ["te donner un indice précis", "giving one concrete hint"],
};

const PACE_LABEL: Record<string, [string, string]> = { slow: ["en allant doucement", "going slowly"], steady: ["à rythme normal", "at a steady pace"], stretch: ["en poussant plus loin", "stretching you"] };

function TutorPolicyRow() {
  const L = useLang();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.tutorPolicy>> | null>(null);
  const load = useCallback(() => { void api.tutorPolicy().then(setInfo).catch(() => setInfo(null)); }, []);
  useEffect(load, [load]);
  const say = (m?: { move: string; pace: string }) => m ? `${L(...(MOVE_LABEL[m.move] || ["", ""]))}, ${L(...(PACE_LABEL[m.pace] || ["", ""]))}` : "";
  return (
    <div className="modal-row">
      <span className="lbl">{"How Otto teaches you"}</span>
      <span className="val">
        {info?.learning && info.updates >= 8
          ? <>{`Otto learns from how you react (${info.updates} replies so far). When you're flowing: ${say(info.flow)}. When you're stuck: ${say(info.stuck)}. `}</>
          : "Otto is starting to learn what works for you — a few sessions and it will adapt. "}
        <button type="button" className="btn xs ghost" onClick={() => { if (window.confirm("Reset what Otto has learned about how you learn?")) void api.resetTutorPolicy().then(load); }}>{"Reset"}</button>
      </span>
    </div>
  );
}

export function SettingsPage({ status, tasks, onSignOut, onChanged, onTasksChanged, onStatusUpdate, onReplayOnboarding }: { status: ConnectionStatus; tasks: WebTask[]; onSignOut: () => void; onChanged: () => void; onTasksChanged: (tasks: WebTask[]) => void; onStatusUpdate?: () => void; onReplayOnboarding?: (mode: "tutor" | "full") => void }) {
  const L = useLang();
  const notify = useNotify();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [showKnows, setShowKnows] = useState(false);
  const [showStudentModel, setShowStudentModel] = useState(false);
  const [patterns, setPatterns] = useState<{
    predictedEngagement: { weekday: number; hour: number; confidence: number } | null; weakSubjects: string[];
    subjectMastery: { subject: string; correctRate: number; attempts: number; trend?: "up" | "down" | "flat" }[];
    subjectFocus: { subject: string; peak: { hour: number; confidence: number } }[];
    bandits: Record<string, { armId: string; confidence: number } | null>;
    studyMetrics: { totalSessions: number; totalStudySeconds: number; totalBreakSeconds: number; avgIdleRatio: number | null; earlyExitRate: number | null; pomodoroCyclesCompleted: number; windowDays: number; avgFocusScore: number | null; avgGazeOnScreenPct: number | null; focusSessionCount: number } | null;
  } | null>(null);
  useEffect(() => { void api.patternsSummary().then(setPatterns).catch(() => {}); }, []);
  
  // Optimistic toggles/selects — flip instantly, reconcile with the server after (no round-trip lag).
  const [paused, setPausedLocal] = useState(status.paused);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [importingData, setImportingData] = useState(false);
  const [importProgress, setImportProgress] = useState<[number, number] | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  // Splits `tasks` into byte-budgeted batches and uploads them as SEPARATE import requests — each one
  // still goes through POST /api/account/import's existing MERGE logic (mergeTaskLists/mergeProfileStates,
  // server/index.ts), so sending the same account's data in 5 pieces instead of 1 produces the exact same
  // end state; the route has no idea it's being fed incrementally. Originally added suspecting a Vercel
  // platform body-size cap — the REAL cause of the reported 413 (on a file as small as 1.8MB) turned out to
  // be a global `express.json({limit:"1mb"})` in server/index.ts running before this route's own 20mb
  // parser ever got a chance to (now fixed — that route is excluded from the global one). Kept anyway as a
  // defensive measure for a genuinely huge export (tutor sessions are cloud-persisted again now, so a
  // long-lived, chat-heavy account's export can still grow large) — just no longer the primary fix.
  const MAX_IMPORT_BATCH_BYTES = 3_500_000;
  function splitImportBatches(profile: unknown, allTasks: unknown[]): unknown[][] {
    const encoder = new TextEncoder();
    const baseSize = encoder.encode(JSON.stringify({ profile, tasks: [] })).length;
    const batches: unknown[][] = [];
    let current: unknown[] = [];
    let currentSize = baseSize;
    for (const t of allTasks) {
      const taskSize = encoder.encode(JSON.stringify(t)).length;
      if (current.length && currentSize + taskSize > MAX_IMPORT_BATCH_BYTES) {
        batches.push(current);
        current = [];
        currentSize = baseSize;
      }
      current.push(t);
      currentSize += taskSize;
      // One single task bigger than the whole budget (a genuinely huge chat/board history on one task) —
      // still send it alone rather than looping forever trying to split further; the server's own caps
      // (CHAT_CAP/BOARD_MERGE_CAP/ARTIFACT_CAP) bound how big one task can realistically get regardless.
    }
    if (current.length) batches.push(current);
    return batches.length ? batches : [[]]; // profile-only import (no tasks at all) still gets one request
  }
  const onImportFile = async (file: File) => {
    setImportingData(true);
    setImportProgress(null);
    try {
      const text = await file.text();
      let parsed: any;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("That file isn't a valid Otto export."); }
      // jobs/events ride along in a full export for GDPR Art.15 completeness, but POST /api/account/import
      // only ever reads `profile`/`tasks` (see that route's own body) — pure dead weight here, dropped
      // before even computing batches below.
      const allTasks: unknown[] = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const batches = splitImportBatches(parsed.profile, allTasks);
      let result: { ok: boolean; tasksAfter: number; errorLogAfter: number } | undefined;
      for (let i = 0; i < batches.length; i++) {
        if (batches.length > 1) setImportProgress([i + 1, batches.length]);
        result = await api.importData({ profile: parsed.profile, tasks: batches[i] });
      }
      notify(`Imported — ${result!.tasksAfter} tasks, ${result!.errorLogAfter} error-log entries in total now.`);
      loadProfile();
      onChanged();
    } catch (e: any) {
      notify(e?.message || "Couldn't import that file — try again.", "error");
    } finally {
      setImportingData(false);
      setImportProgress(null);
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };
  const [profileError, setProfileError] = useState(false);
  const [showSources, setShowSources] = useState(true);
  const [fullBusy, setFullBusy] = useState(false);
  // The switch moves the instant it's tapped (optimistic); the slim bar shows the save + refresh in flight; a failure puts it back.
  const [fullOptimistic, setFullOptimistic] = useState<boolean | null>(null);
  const [trainOptimistic, setTrainOptimistic] = useState<boolean | null>(null);
  const loadProfile = () => { setProfileError(false); void api.profile().then(setProfile).catch(() => setProfileError(true)); };
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { loadProfile(); }, []);
  useReveal();

  return (
    <main className="settings-page">
      {/* The prototype's Settings head: "Set the bar for Otto." + "Your account, your connections, your standards." */}
      <h1 className="list-head">{"Your settings."}</h1>
      {profileError ? (
        <ErrorNote onRetry={loadProfile}>{"Some profile info couldn't load."}</ErrorNote>
      ) : null}

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.03s" }}>
        <h3>{"Account"}</h3>
        <div className="acct-card">
          <span className="acct-avatar" aria-hidden="true">{(status.user || "?").charAt(0).toUpperCase()}</span>
          <div className="acct-id">
            <span className="acct-email">{status.user}</span>
            <span className={`acct-sync ${status.cloud ? "on" : ""}`}>
              <span className="acct-sync-dot" aria-hidden="true" />
              {status.cloud ? "Synced" : "Not synced"}
            </span>
          </div>
          <button className="btn xs ghost" onClick={() => void onSignOut()}>{"Sign out"}</button>
        </div>
        <details className="settings-more">
          <summary>{"Your data and privacy"}</summary>
        <div className="modal-row"><span className="lbl">{"Legal"}</span><span className="val"><a href="/privacy">{"Privacy"}</a> · <a href="/terms">{"Terms"}</a></span></div>
        <div className="modal-row">
          <span className="lbl">{"Your data"}</span>
          <span className="val"><a href={api.exportDataUrl()} download>{"Download my data"}</a></span>
        </div>
        {/* Reported live: "i don't see import place" — the handler/state (onImportFile, importFileRef,
            importingData) were fully built but nothing in this render ever used them, so the whole feature
            was invisible. Same pattern as the export row above: a plain link-styled trigger for the actual
            hidden file input, which does the real work. Typically used right after importing a GET
            /api/account/export file from a DIFFERENT account/project (see server/index.ts's own comment on
            that route) — e.g. moving to a freshly created Supabase project. */}
        <div className="modal-row">
          <span className="lbl">{"Import data"}</span>
          <span className="val">
            <input ref={importFileRef} type="file" accept="application/json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); }} />
            <button type="button" className="btn xs ghost" disabled={importingData} onClick={() => importFileRef.current?.click()}>
              {importingData
                ? (importProgress ? `Importing… (${importProgress[0]}/${importProgress[1]})` : "Importing…")
                : "Import an Otto export"}
            </button>
          </span>
        </div>
        <div className="danger-zone">
          <div className="modal-row">
            <span className="lbl">{"Delete account"}<span className="settings-hint m-0">{"Tasks, profile, connections — can't be undone."}</span></span>
            {confirmingDelete ? (
              <span className="delete-confirm">
                <input type="password" autoComplete="current-password" className="input" placeholder="Your password" aria-label="Your password, to confirm deleting the account" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
                <button
                  className="btn xs danger"
                  disabled={deletingAccount || !deletePassword}
                  onClick={async () => {
                    setDeletingAccount(true);
                    try { await api.deleteAccount(deletePassword); clearAllLocalAccountData(status.user || null); window.location.href = "/"; }
                    catch (e: any) { setDeletingAccount(false); notify(e?.message || "Couldn't delete the account — try again.", "error"); }
                  }}
                >{deletingAccount ? "Deleting…" : "Delete everything"}</button>
                <button className="btn xs ghost" disabled={deletingAccount} onClick={() => { setConfirmingDelete(false); setDeletePassword(""); }}>{"Cancel"}</button>
              </span>
            ) : (
              <button className="btn xs danger" onClick={() => setConfirmingDelete(true)}>{"Delete account…"}</button>
            )}
          </div>
        </div>
        </details>
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.07s" }}>
        <button className="sec-toggle" aria-expanded={showSources} onClick={() => setShowSources((v) => !v)}>
          <h3>{status.fullApp ? "Sources" : "School"}</h3>
          <span className={`caret ${showSources ? "open" : ""}`} aria-hidden="true">›</span>
        </button>
        {showSources ? <div className="settings-reveal">
        <p className="settings-hint">{status.fullApp ? "Otto reads these sources and preps the work — " : "Connect Pronote so Otto knows what you are studying: your homework (cahier de texte) and the lesson content your teachers publish. "}<b>{"It never sends or hands anything in for you"}</b>.</p>
        <PronoteTile status={status} onStatusUpdate={onStatusUpdate} />
        {status.fullApp ? <GoogleTiles onChanged={onChanged} restricted={profile?.track !== "ib" && profile?.track !== "ap" && profile?.track !== "other"} /> : null}
        </div> : null}
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.09s" }}>
        <h3>{"About you"}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{"Language"}</b><span className="settings-hint">{"The whole app, and Otto's voice and board, use this language."}</span></span>
            <LanguagePicker />
          </label>
          {status.fullApp ? <label className="set-row">
            <span className="set-text"><b>{"Pause Otto"}</b><span className="settings-hint">{"Stops the AI task work: sweeps, task preparation and auto-runs. The tutor keeps working, and your tasks stay as they are."}</span></span>
            <span className="switch"><input type="checkbox" checked={paused} onChange={(e) => {
              const v = e.target.checked;
              setPausedLocal(v);
              void api.setPaused(v).then(() => onChanged()).catch((err: any) => {
                setPausedLocal(!v);
                notify(err?.message || "That setting didn't save — give it another try.", "error");
              });
            }} /><span className="switch-track" /></span>
          </label> : null}
          <PreferencesFields profile={profile} onChanged={(p) => { setProfile(p); onChanged(); }} />
        </div>
      </section>

      {status.weekly ? (
        <section className="settings-sec reveal">
          <h3>{"AI allowance this week"}</h3>
          <div className="set-list">
            <div className="set-row">
              <span className="set-text"><b>{`$${status.weekly.usd.toFixed(2)} of $${status.weekly.limit.toFixed(2)}`}</b><span className="settings-hint">{"Resets every Monday. Voice, board and everything else count."}</span></span>
              {status.weekly.over && !status.weekly.requested ? <button type="button" className="btn xs primary" onClick={() => { void api.requestMoreUsage().then(() => onStatusUpdate?.()).catch((e: any) => notify(e?.message || "Couldn't send the request — try again.", "error")); }}>{"Request more"}</button> : status.weekly.requested ? <span className="settings-hint">{"Requested"}</span> : null}
            </div>
            <div className="concept-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round((status.weekly.usd / status.weekly.limit) * 100))}%` }} /></div>
          </div>
        </section>
      ) : null}

      <StudyStatsSection userId={status.user || null} />

      <ConceptsPanel profile={profile} />

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.13s" }}>
        <button className="sec-toggle" aria-expanded={showKnows} onClick={() => setShowKnows((v) => !v)}>
          <h3>{"What Otto knows about you"}</h3>
          <span className={`caret ${showKnows ? "open" : ""}`} aria-hidden="true">›</span>
        </button>
        {showKnows && <div className="settings-reveal"><p className="settings-hint">{"Otto fills this in over time, and the tutor adds to it when a session ends. The tutor reads it to teach you better. You can edit anything."}</p><ProfileEditor /></div>}
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.18s" }}>
        <button className="sec-toggle" aria-expanded={showStudentModel} onClick={() => setShowStudentModel((v) => !v)}>
          <h3>{"How Otto sees you"}</h3>
          <span className={`caret ${showStudentModel ? "open" : ""}`} aria-hidden="true">›</span>
        </button>
        {showStudentModel && (
          <div className="settings-reveal">
            <p className="settings-hint">{"Updated at most once a day, and after your tutor sessions. The tutor uses it as background. Never shared, never used to grade you."}</p>
            {profile?.studentModel?.summary ? (
              <>
                <p className="student-model-text">{profile.studentModel.summary}</p>
                <p className="settings-hint">{`Updated ${fmtDay(profile.studentModel.updatedAt, L)}`}</p>
                <button type="button" className="btn xs ghost" onClick={async () => {
                  try { setProfile(await api.resetStudentModel()); }
                  catch (e: any) { notify(e?.message || "Couldn't reset — try again.", "error"); }
                }}>{"Reset"}</button>
              </>
            ) : <p className="settings-hint">{"Not enough activity yet."}</p>}
          </div>
        )}
      </section>

      <section className="settings-sec reveal">
        <h3>{"Where your data goes"}</h3>
        <p className="settings-hint">{"Your tutoring sessions, boards and drawings are saved only in this browser, unless you switch on Help improve Otto below. Your account keeps a small profile and the learning notes above. What leaves your device:"}</p>
        <ul className="settings-hint" style={{ paddingLeft: 18, margin: "4px 0 8px" }}>
          <li>{"Your voice goes from the browser straight to Google (Gemini Live), or to OpenAI (Realtime) as a backup, which send back a transcript."}</li>
          <li>{"To show your words on screen as you speak, Chrome's built-in speech recognition also listens during a call. Chrome sends that audio to Google; Otto never stores it."}</li>
          <li>{"What you type, and the lines Otto writes on the board, are handled by Google first. If Google is unavailable, DeepSeek answers instead, and DeepSeek processes data outside the EU."}</li>
          <li>{"Task preparation and interface translation use DeepSeek. Drawings and photos go to the voice provider and, when you ask Otto to look, to Google's image reading."}</li>
          <li>{"Your Pronote login is stored encrypted and deleted when you disconnect. Otto only reads from Pronote."}</li>
        </ul>
        <p className="settings-hint">{"Those providers keep data under their own terms, which Otto does not control. Deleting your account erases your profile, learning notes and connections from Otto; it cannot erase what a provider holds. To have the tutor restricted to Google only, or for anything about your data, write to "}<a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>{". Full details: "}<a href="/privacy">{"privacy policy"}</a>{" and "}<a href="/terms">{"terms"}</a>{"."}</p>
      </section>

      {status.isAdmin ? <AdminTools /> : null}

      {status.isAdmin && onReplayOnboarding ? (
        <section className="settings-sec reveal">
          <h3>{"Test onboarding"}</h3>
          <p className="settings-hint">{"Replay the first-run flow to see what a new person sees. There are two: a short one for tutor-only accounts (name and language, grade, Pronote) and the complete one for full mode (adds your track, subjects and Google apps). Your answers are saved as you go."}</p>
          <div className="admin-actions">
            <button type="button" className="btn xs" onClick={() => onReplayOnboarding("tutor")}>{"Test tutor-only onboarding"}</button>
            <button type="button" className="btn xs" onClick={() => onReplayOnboarding("full")}>{"Test full-mode onboarding"}</button>
          </div>
        </section>
      ) : null}

      <section className="settings-sec reveal">
        <h3>{"Feedback"}</h3>
        <FeedbackForm />
      </section>

      <section className="settings-sec reveal">
        <h3>{"Help improve Otto"}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{"Keep my tutor sessions to improve Otto"}</b><span className="settings-hint">{"Off by default. If you turn it on, the transcript and board of each finished tutor session are kept, tied to a scrambled ID instead of your email, and used only to improve Otto. Turn it off and everything kept is deleted."}</span></span>
            <span className="switch"><input type="checkbox" checked={trainOptimistic ?? !!status.trainingShare} onChange={(e) => {
              const on = e.target.checked;
              setTrainOptimistic(on);
              void api.setTrainingShare(on)
                .then(() => { try { const s = JSON.parse(localStorage.getItem("weave-status") || "null"); if (s) localStorage.setItem("weave-status", JSON.stringify({ ...s, trainingShare: on })); } catch { /* ignore */ } onStatusUpdate?.(); })
                .catch((err: any) => notify(err?.message || "That didn't save — give it another try.", "error"))
                .finally(() => setTrainOptimistic(null));
            }} /><span className="switch-track" /></span>
          </label>
        </div>
      </section>

      <section className="settings-sec reveal">
        <h3>{"Full mode"}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{"Show the whole app"}</b><span className="settings-hint">{"Off: just the tutor. On: Today, Journal, Coursework, Mistakes and every connection."}</span></span>
            <span className="switch"><input type="checkbox" checked={fullOptimistic ?? !!status.fullApp} disabled={fullBusy} aria-busy={fullBusy} onChange={(e) => {
              const on = e.target.checked;
              setFullOptimistic(on);
              setFullBusy(true);
              void api.setFullApp(on)
                .then(() => { onStatusUpdate?.(); onChanged(); })
                .catch((err: any) => { setFullOptimistic(null); notify(err?.message || "That didn't save — give it another try.", "error"); })
                .finally(() => { setFullBusy(false); setFullOptimistic(null); });
            }} /><span className="switch-track" /></span>
          </label>
          {fullBusy ? (
            <div className="otto-progress" role="progressbar" aria-label={fullOptimistic ? "Switching to the whole app" : "Switching to the tutor only"} aria-busy="true"><span /></div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

/** Pronote (French school portal) — no OAuth exists for it, so this is a credential form instead of a
 *  redirect link. The password is stored encrypted to re-login when the token dies (see server/pronote.ts); only a
 *  rotating token comes back. Reads homework due dates into the to-do list — nothing is ever written back. */

export function PronoteTile({ status: mainStatus, onStatusUpdate, onChanged }: { status?: ConnectionStatus | null; onStatusUpdate?: () => void; onChanged?: () => void } = {}) {
  const L = useLang();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<"student" | "parent">("student");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pronoteUsername, setPronoteUsername] = useState<string | undefined>();

  // The server's /api/status read is now always a fresh, uncached Supabase read (see server/pronote.ts —
  // the in-memory per-instance cache that used to sit in front of it was removed after it kept serving
  // stale readings from whichever OTHER warm Vercel instance happened to have cached one). Even so, a
  // status fetch that fires IMMEDIATELY after the connect/disconnect write can still race Supabase's own
  // connection-pooled read-after-write consistency and briefly see the pre-write value — reported live as
  // "connect succeeds, but navigate away and back to Settings and it shows Connect again": this tile used
  // to keep its optimistic override in plain component state, which React destroys the instant it unmounts
  // (leaving Settings for any other page), so that one lagging background read after a navigation had
  // nothing left to override it. Persisting the override in sessionStorage instead survives the remount —
  // capped at 2 minutes so a genuinely wrong override (e.g. the connect actually failed downstream) can't
  // get stuck forever, but comfortably outlives a page navigation or two.
  const [optimistic, setOptimisticState] = useState<boolean | null>(() => readPronoteOptimistic());
  const setOptimistic = useCallback((v: boolean | null) => { writePronoteOptimistic(v); setOptimisticState(v); }, []);
  useEffect(() => {
    if (optimistic !== null && mainStatus?.pronoteConnected === optimistic) setOptimistic(null);
  }, [mainStatus?.pronoteConnected, optimistic, setOptimistic]);
  const effectivelyConnected = optimistic ?? mainStatus?.pronoteConnected;

  // Load pronote username when connected — skipped while `optimistic` already set it locally (see connect()
  // below), so this effect doesn't clear it back to undefined for the few seconds mainStatus lags behind.
  useEffect(() => {
    if (optimistic !== null) return;
    if (mainStatus?.pronoteConnected) {
      api.pronoteStatus().then(s => setPronoteUsername(s.username)).catch(() => {});
    } else {
      setPronoteUsername(undefined);
    }
  }, [mainStatus?.pronoteConnected, optimistic]);

  const status = effectivelyConnected ? { connected: true, username: pronoteUsername } : { connected: false };

  const connect = async () => {
    const trimmedUrl = url.trim();
    const trimmedUsername = username.trim();
    if (!trimmedUrl || !trimmedUsername || !password) { setErr("Fill in the URL, username, and password."); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.connectPronote(trimmedUrl, trimmedUsername, password, kind === "parent" ? 7 : 6);
      if (!r.ok) { setErr(r.error || "Couldn't connect."); return; }
      setPassword(""); setOpen(false);
      setPronoteUsername(trimmedUsername);
      setOptimistic(true);
      onStatusUpdate?.();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message || "Couldn't connect.");
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectPronote();
      setOptimistic(false);
      onStatusUpdate?.();
      onChanged?.();
    }
    catch (e: any) { notify(e?.message || "Couldn't disconnect — try again.", "error"); }
    finally { setBusy(false); }
  };

  // A blank gap while `status` loads reads as "this section is stuck/slow" — a lightweight skeleton in the
  // exact shape of the real tile makes the wait feel instant instead of leaving Sources looking empty.
  if (!mainStatus) return <div className="int-group"><div className="int-grid"><div className="int-tile int-tile-skel" /></div></div>;
  return (
    <div className="int-group">
      <div className="int-grid">
        <div className={`int-tile ${status.connected ? "on" : ""}`}>
          {/* Index Éducation's official PRONOTE logo, via Wikimedia Commons (CC BY-SA 4.0, credited to
              Index Éducation) — self-hosted at public/logos/pronote.png, see public/logos/ATTRIBUTION.md. */}
          <span className="int-logo pronote-logo"><img src="/logos/pronote.png" alt="" loading="lazy" /></span>
          <div className="int-info">
            <div className="int-name">Pronote{status.connected && <span className="int-dot" title={"Connected"} />}</div>
            <div className="int-blurb">{"Upcoming homework and tests. Otto reads these sources and preps the work — it never sends or hands anything in for you. Unofficial connection (Index Éducation has no public API) — your password is stored encrypted (AES-256), used only to reconnect you automatically when Pronote expires the session, and deleted the moment you disconnect Pronote."}</div>
          </div>
          {status.connected
            ? <button className="btn xs" disabled={busy} onClick={() => void disconnect()}>{busy ? "…" : "Disconnect"}</button>
            : <button className="btn xs" disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "Connect"}</button>}
        </div>
      </div>
      {status.connected && <div className="int-accounts"><div className="int-acct"><span className="int-acct-email">{status.username}</span></div></div>}
      {open && !status.connected && (
        <div className="pronote-form">
          <input className="addinput sm" placeholder={"Your school's Pronote URL (e.g. https://0000000a.index-education.net/pronote/eleve.html)"} aria-label={"Your school's Pronote URL (e.g. https://0000000a.index-education.net/pronote/eleve.html)"}
            value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          <div className="pronote-form-row">
            <input className="addinput sm" placeholder={"Username"} aria-label={"Username"} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            <input className="addinput sm" type="password" placeholder={"Password"} aria-label={"Password"} value={password}
              onChange={(e) => setPassword(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }} />
          </div>
          <div className="pronote-form-row">
            <div className="seg" role="group" aria-label={"Account type"}>
              <button type="button" className={`seg-btn ${kind === "student" ? "on" : ""}`} aria-pressed={kind === "student"} onClick={() => setKind("student")}>{"Student"}</button>
              <button type="button" className={`seg-btn ${kind === "parent" ? "on" : ""}`} aria-pressed={kind === "parent"} onClick={() => setKind("parent")}>{"Parent"}</button>
            </div>
            <button className="btn primary xs" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
          </div>
          {err && <div className="autherr">{err}</div>}
        </div>
      )}
    </div>
  );
}

/** Connected accounts for one Google app — one row per account with its address + an individual
 *  Disconnect. Google apps support multiple accounts (perso + a parent's, e.g.). */
function GoogleAppAccounts({ appKey, onChanged }: { appKey: string; onChanged?: () => void }) {
  const L = useLang();
  const notify = useNotify();
  const [accts, setAccts] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setAccts((await api.integrationAccounts(appKey)).accounts); } catch { setAccts([]); } }, [appKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const on = () => { if (!document.hidden) void load(); }; window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [load]);
  const disc = async (id: string) => {
    setBusy(id);
    try { await api.disconnectAccount(appKey, id); await load(); onChanged?.(); }
    catch (e: any) { notify(e?.message || "Couldn't disconnect — try again.", "error"); }
    finally { setBusy(""); }
  };
  if (!accts?.length) return null;
  return (
    <div className="int-accounts">
      {accts.map((a, i) => (
        <div key={a.id} className="int-acct">
          <span className="int-acct-email">{a.email || (accts.length > 1 ? `Account ${i + 1}` : "Connected")}</span>
          <div className="int-acct-actions">
            <button className="btn xs ghost" disabled={busy === a.id} onClick={() => void disc(a.id)}>{busy === a.id ? "…" : "Disconnect"}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Otto Lycée v1 keeps Gmail, Calendar, and Drive — kept alongside Pronote (explicit ask) so teacher/club
// emails, calendar deadlines, and PDFs teachers drop in Drive can still surface as tasks even when Pronote
// itself doesn't have them. Everything else in Composio (GitHub/Slack/Linear/…) stays hidden.
const GOOGLE_LYCEE_APPS = ["gmail", "googlecalendar", "googledrive"];

// For IB/Other tracks: the FULL Composio catalog (GitHub/Slack/Linear/Todoist/…) turned out to be more
// than actually wanted — the curated set is Google Workspace (all of it, not just the 3-app Lycée subset —
// Docs/Sheets/Slides matter for building study materials) plus Notion, alongside Pronote which is its own
// separate tile. Not the whole catalog.
const GOOGLE_EXPANDED_APPS = ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets", "googleslides"];

const GOOGLE_APP_BLURBS: Record<string, string> = {
  gmail: "Emails de profs, clubs, associations — Otto ne fait qu'y répondre en brouillon, jamais d'envoi automatique.",
  googlecalendar: "Événements et échéances à venir, pour préparer ce qui arrive.",
  googledrive: "Documents partagés par tes profs — pour enrichir les fiches de révision.",
};

const GOOGLE_APP_BLURBS_EN: Record<string, string> = {
  gmail: "Emails from teachers, clubs, associations — Otto only replies as a draft, never sends automatically.",
  googlecalendar: "Upcoming events and deadlines, to prep for what's coming.",
  googledrive: "Documents your teachers shared — to enrich revision guides.",
};

/** Integrations grid. `restricted` (default true) scopes it to just Gmail/Calendar/Drive (GOOGLE_LYCEE_APPS,
 *  the French-Bac default); false shows the curated IB/Other set — Google Workspace + Notion
 *  (GOOGLE_EXPANDED_APPS), not the entire Composio catalog. */
export function GoogleTiles({ onChanged, restricted = true }: { onChanged?: () => void; restricted?: boolean }) {
  const [items, setItems] = useState<IntegrationItem[] | null | undefined>(undefined); // undefined = loading, null = unavailable
  const load = useCallback(async () => {
    const allow = restricted ? GOOGLE_LYCEE_APPS : GOOGLE_EXPANDED_APPS;
    try { const r = await api.integrations(); setItems(r.items.filter((i) => allow.includes(i.key))); }
    catch { setItems(null); }
  }, [restricted]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = setTimeout(() => void load(), 1200); return () => clearTimeout(id); }, [load]);
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const L = useLang();
  // Same reasoning as PronoteTile's skeleton — an empty gap while `items` loads reads as stuck, not loading.
  if (items === undefined) return <div className="int-group"><div className="int-grid"><div className="int-tile int-tile-skel" /><div className="int-tile int-tile-skel" /></div></div>;
  if (items === null || !items.length) return <div className="warn">{"Google isn't set up on this server yet."}</div>;
  return (
    <div className="int-group">
      {items.map((item) => (
        <div key={item.key} className="int-tile-block">
          <div className="int-grid">
            <div className={`int-tile ${item.connected ? "on" : ""}`}>
              <img className="int-logo" src={item.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              <div className="int-info">
                <div className="int-name">{item.name}{item.connected && <span className="int-dot" title={"Connected"} />}</div>
                <div className="int-blurb">{GOOGLE_APP_BLURBS_EN[item.key] || item.blurb}</div>
              </div>
              <a className="btn xs" href={`/integrations/${item.key}/connect`} target="_blank" rel="noreferrer">{item.connected ? "Add an account ↗" : "Connect ↗"}</a>
            </div>
          </div>
          {/* The connected account(s) for THIS app, right below its own tile — not lumped together
              after the whole grid, so it's unambiguous which app each account belongs to. */}
          {item.connected && <GoogleAppAccounts appKey={item.key} onChanged={() => { void load(); onChanged?.(); }} />}
        </div>
      ))}
    </div>
  );
}

/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Otto fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const L = useLang();
  const notify = useNotify();
  const [p, setP] = useState<Profile | null>(null);
  // A load failure used to be indistinguishable from "still loading" — `catch(() => setP(null))` left this
  // stuck on "Chargement…" forever with no way to tell the user anything went wrong or let them retry.
  const [loadError, setLoadError] = useState(false);
  const load = () => { setLoadError(false); void api.profile().then(setP).catch(() => setLoadError(true)); };
  useEffect(load, []);
  if (loadError) return <ErrorNote onRetry={load}>{"Couldn't load your profile."}</ErrorNote>;
  if (!p) return <p className="muted small">{"Loading…"}</p>;
  const saveErr = () => "That didn't save — give it another try.";
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length + p.courses.length;
  const lists = [
    { key: "preference" as const, label: "Preferences", items: p.preferences },
    { key: "person" as const, label: "People", items: p.people },
    { key: "project" as const, label: "Projects", items: p.projects },
    { key: "course" as const, label: "Courses", items: p.courses },
  ];
  return (
    <div className="memory-body">
      <NameRow name={p.name || ""} onSave={async (v) => { try { setP(await api.setProfile("name", v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
      <AboutRow about={p.about} onSave={async (v) => { try { setP(await api.setProfile("about", v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
      {lists.map((l) => (
        <div className="prof-group" key={l.key}>
          <div className="prof-label">{l.label}</div>
          <ul className="memory-list">
            {l.items.map((it, i) => (
              <li key={i}><span>{it}</span><button className="x" title={"Remove"} aria-label={"Remove"} onClick={async () => { try { setP(await api.delProfile(l.key, i)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }}>×</button></li>
            ))}
          </ul>
          <AddRow placeholder={`Add a ${l.label.toLowerCase().replace(/s$/, "")}…`} onAdd={async (v) => { try { setP(await api.setProfile(l.key, v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
        </div>
      ))}
      {count === 0
        ? <div className="muted small">{"Empty for now — Otto fills this in as it works, or add your name, about, preferences, people and projects here."}</div>
        : <div className="forget-row">
            <button
              className="btn xs forget"
              onClick={async () => {
                if (!window.confirm("Forget everything Otto has learned about you? This clears your About, preferences, people and projects, and can't be undone.")) return;
                try { setP(await api.clearProfile()); } catch (e: any) { notify(e?.message || saveErr(), "error"); }
              }}
            >{"Forget everything"}</button>
            <span className="muted small">{"Wipes Otto's memory — it starts from zero and learns you again as it works."}</span>
          </div>}
    </div>
  );
}

function NameRow({ name, onSave }: { name: string; onSave: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState(name);
  useEffect(() => { setText(name); }, [name]);
  return (
    <div className="prof-group">
      <div className="prof-label">{"Name"}</div>
      <div className="addrow">
        <input className="addinput sm" placeholder={"What should Otto call you?"} aria-label={"What should Otto call you?"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === name.trim()} onClick={() => void onSave(text.trim())}>{"Save"}</button>
      </div>
    </div>
  );
}

function AboutRow({ about, onSave }: { about: string; onSave: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState(about);
  useEffect(() => { setText(about); }, [about]);
  return (
    <div className="prof-group">
      <div className="prof-label">{"About you"}</div>
      <div className="addrow">
        <input className="addinput sm" placeholder={"One line: who you are / how you work"} aria-label={"One line: who you are / how you work"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === about.trim()} onClick={() => void onSave(text.trim())}>{"Save"}</button>
      </div>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState("");
  // onAdd already notifies on failure (see ProfileEditor) and never rejects — but guard anyway so a future
  // caller that DOES reject can't clear the user's typed text or leave an unhandled rejection here.
  const go = async () => { const v = text.trim(); if (!v) return; try { await onAdd(v); setText(""); } catch { /* text stays — onAdd already surfaced the error */ } };
  return (
    <div className="addrow">
      <input className="addinput sm" placeholder={placeholder} aria-label={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="btn" disabled={!text.trim()} onClick={() => void go()}>{"Add"}</button>
    </div>
  );
}


/** What the tutor has seen of the student, concept by concept: how solid it is, what keeps going wrong, when to revisit. Built from their sessions. */
function ConceptsPanel({ profile }: { profile: Profile | null }) {
  const [open, setOpen] = useState(true);
  const concepts = Object.values(profile?.conceptModel?.concepts || {}).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const bySubject = new Map<string, typeof concepts>();
  for (const c of concepts) bySubject.set(c.subject || "Other", [...(bySubject.get(c.subject || "Other") || []), c]);
  const level = (p: number) => (p >= 0.75 ? "Solid" : p >= 0.45 ? "Getting there" : "Needs work");
  // The honest denominators behind the bars: how often it was done ALONE versus after a hint or an explanation, and how
  // often a method held up in a new context. A finished session is not the same as learning, so this is shown plainly.
  const tot = concepts.reduce((a, c) => ({ attempts: a.attempts + (c.attempts || 0), unaided: a.unaided + (c.unaided || 0), tAtt: a.tAtt + (c.transferAttempts || 0), tWin: a.tWin + (c.transferWins || 0), rec: a.rec + (c.recalls || 0), recWin: a.recWin + (c.recallWins || 0) }), { attempts: 0, unaided: 0, tAtt: 0, tWin: 0, rec: 0, recWin: 0 });
  const when = (iso?: string) => { const d = Date.parse(iso || ""); if (!d) return ""; const days = Math.round((d - Date.now()) / 86_400_000); return days <= 0 ? "review now" : days === 1 ? "review tomorrow" : `review in ${days} days`; };
  return (
    <section className="settings-sec reveal">
      <button className="sec-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <h3>{"What you're working on"}</h3>
        <span className={`caret ${open ? "open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open ? (
        <div className="settings-reveal">
          {!concepts.length ? <p className="settings-hint">{"Nothing tracked yet. Talk to Otto and the ideas you work on show up here, with how solid each one is."}</p> : (
            <>
              <p className="settings-hint">{"Built from your sessions, only on your account. Otto uses it to pick what to ask next."}</p>
              {tot.attempts >= 3 ? (
                <p className="settings-hint"><b>{`Solved on your own: ${tot.unaided} of ${tot.attempts} attempts (${Math.round((100 * tot.unaided) / tot.attempts)}%).`}</b>{tot.tAtt ? ` Held up in a new context: ${tot.tWin} of ${tot.tAtt}.` : ""}{tot.rec ? ` Remembered when asked again later: ${tot.recWin} of ${tot.rec}.` : ""}{" These are the numbers that matter, not how many sessions you finished."}</p>
              ) : null}
              <details className="settings-hint">
                <summary>{"How this is worked out"}</summary>
                <p>{"Every time you work on an idea, Otto records how it went: on your own, after a hint, after an explanation, a mistake, a misunderstanding, remembering it later, or using it in a new context. Doing it alone counts for much more than doing it after a hint or an explanation, and using it in a new context counts most. A mistake pulls the score down, so one lucky answer or one guided session can't make an idea \u201Csolid\u201D."}</p>
                <p>{"Once an idea looks reasonably known, Otto sets a quick check for when you are likely to start forgetting it; it is cleared when you recall it or solve it alone again. This is a simple estimate, not an exam result, and it can be wrong. If an entry looks wrong to you, reset what Otto knows about you below."}</p>
              </details>
              {[...bySubject.entries()].map(([subject, list]) => (
                <div key={subject} className="concept-group">
                  <div className="concept-subject">{subject}</div>
                  {list.slice(0, 12).map((c) => {
                    const p = Math.max(0, Math.min(1, c.kt?.p ?? c.mastery ?? 0));
                    const live = (c.misconceptions || []).filter((m) => !m.retiredAt).slice(-1)[0];
                    return (
                      <div key={c.key} className="concept-row">
                        <div className="concept-top"><b>{c.label}</b><span className="concept-level">{level(p)}</span></div>
                        <div className="concept-bar" aria-hidden="true"><span style={{ width: `${Math.round(p * 100)}%` }} /></div>
                        <div className="concept-meta">
                          {live ? <span>{`Watch out: ${live.text}`}</span> : null}
                          {c.nextReview && p >= 0.45 ? <span>{when(c.nextReview)}</span> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
