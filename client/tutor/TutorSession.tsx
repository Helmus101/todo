import { useCallback, useEffect, useRef, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { setLocalObjectives, getLocalThread } from "../localChatBoard.ts";
import { useLang, TaskModal, formatMath } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { BoardArtifact, MathText } from "../study/artifacts/BoardArtifact.tsx";
import { TutorDesmos } from "./TutorDesmos.tsx";
import { TutorCanvas, type TutorCanvasHandle } from "./TutorCanvas.tsx";
import { PageTour } from "../PageTour.tsx";
import { TOURS } from "../tours.ts";
import { COMMON_SUBJECTS } from "../../shared/coursework.ts";
import { buildSessionSummary, saveTutorSession, getTutorSessions, type TutorSessionSummary } from "./tutorSessions.ts";

// A dismiss that silently fails (a network blip, a momentary 429) used to just be swallowed — the session
// then never actually ends server-side and comes back as a "Reprendre?" ghost on every future visit
// (reported live). One retry after a short pause turns a transient blip into a real dismiss without making
// ending a session feel slow; a genuine, repeated failure still degrades gracefully (the ghost-cleanup in
// peekForActiveSession above is the backstop for whatever still slips through).
async function dismissWithRetry(taskId: string): Promise<void> {
  try { await api.dismiss(taskId); return; } catch { /* fall through to one retry */ }
  await new Promise((r) => setTimeout(r, 800));
  try { await api.dismiss(taskId); } catch { /* best-effort — ghost-cleanup covers the rest */ }
}

/** Tutor Session (route /tutor) — the Primer-style one-to-one lesson: a chat with Otto on one side and
 *  Otto's board on the other. It reuses the free-study task as a private anchor for the thread (chat, board
 *  and problems persist locally, keyed by task id — see localChatBoard.ts), and talks to the SAME chat
 *  endpoint as everywhere else, with `primer: true` so the server swaps in the Primer persona.
 *
 *  Sessions: each session is backed by its own freestudy task. OPENING this page never starts or reopens
 *  one (reported: "tutor shouldn't auto open session") — the landing screen always shows first. A
 *  detect-only peek at GET /api/tasks merely NOTICES whether a session is still in progress, so the
 *  landing can offer an explicit "Reprendre" button next to Start; a student's click is the only thing
 *  that opens a session. Start asks for a SUBJECT (always — the subject stamps the session and gives the
 *  tutor its context) and creates a BLANK session (fresh:true — never a resume of an old thread, a new
 *  lesson starts clean); with a session already in progress, "Nouvelle séance" supersedes the old one
 *  (saved to history if it had substance, then dismissed). A
 *  session only earns a place in history when it actually has substance: at least one real user message or
 *  something written on the board (a session where Otto never said a word and the board stayed empty gets
 *  dismissed silently, not memorialized). Ending a session generates a short summary from the board + chat
 *  (see tutorSessions.ts), saves it locally, and dismisses the task so the next start creates a fresh one.
 *  Past session summaries are shown in a collapsible strip. */
export function TutorSession({ userId, onExit, visionReady, sessionId }: { userId: string | null; onExit: () => void; visionReady: boolean; sessionId?: string }) {
  const L = useLang();
  const [task, setTask] = useState<WebTask | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const [sessionStart, setSessionStart] = useState<string | null>(null);
  const [pastSessions, setPastSessions] = useState<TutorSessionSummary[]>([]);
  const [endingSession, setEndingSession] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openBoardSession, setOpenBoardSession] = useState<TutorSessionSummary | null>(null);
  const [openChatSession, setOpenChatSession] = useState<TutorSessionSummary | null>(null);
  // The stage hides the transcript on purpose, but it is always one tap away: this drawer.
  const [chatDrawer, setChatDrawer] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [openPast, setOpenPast] = useState<Record<string, boolean>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (chatDrawer) chatEndRef.current?.scrollIntoView({ block: "end" }); }, [chatDrawer, chatExpanded, task?.chat?.length]);
  // The landing screen asks WHAT to study before starting — the subject is stamped onto the session
  // (sourceSubject, visible to the tutor prompt) and carried into history as the session's label.
  // The student's own subjects (set in onboarding) come first; the shared common list follows.
  const [mySubjects, setMySubjects] = useState<string[]>([]);
  useEffect(() => { void api.profile().then((p) => setMySubjects(p.subjects || [])).catch(() => { /* the common list is enough */ }); }, []);
  const subjectOptions = [...new Set<string>([...mySubjects, ...COMMON_SUBJECTS])];
  const [selectedSubject, setSelectedSubject] = useState("");
  const [startingSession, setStartingSession] = useState(false);
  // What the mount peek found: a freestudy session still in progress (or null).
  const [pendingActiveSession, setPendingActiveSession] = useState<WebTask | null>(null);
  // Voice is MANUAL here — the mic toggle in the chat panel is the student's choice, never forced on by
  // starting a session (reported: "voice should not be auto on"). The board-pane pill, barge-in and the
  // voice-primary layout below all still activate the moment the student turns voice on themselves.
  // Live voice-loop state, reported up by AskOttoPanel — rendered as a pill on the BOARD pane header, not
  // the chat: with voice on, the student's eyes are on the board, so "am I being heard?" has to
  // be answerable where they're actually looking.
  const [voiceState, setVoiceState] = useState({ listening: false, speaking: false, voiceModeOn: false, interim: "" });
  // Desmos replaces the board pane entirely while open (see the board pane's render below) — lifted up here
  // (was local to TutorDesmos) so this component can branch between <BoardArtifact> and <TutorDesmos>.
  const [desmosOpen, setDesmosOpen] = useState(false);
  // Once Desmos has been opened at all this session, it stays mounted (hidden, not removed) from then on —
  // see the board pane's render below for why: an iframe that's removed and re-added reloads from scratch.
  const desmosEverOpenedRef = useRef(false);
  if (desmosOpen) desmosEverOpenedRef.current = true;
  const openDesmos = useCallback(() => setDesmosOpen(true), []);
  const handleVoiceState = useCallback((s: { listening: boolean; speaking: boolean; voiceModeOn: boolean; interim: string }) => setVoiceState(s), []);
  // StrictMode guard for the mount peek below (a double-invoke would just be a wasted duplicate GET, but
  // the guard also keeps the read strictly once-per-mount). Runs once per component lifetime.
  const mountFetchStartedRef = useRef(false);

  // Passive mount load — DETECT-ONLY peek at GET /api/tasks: notice whether a freestudy session is still
  // in progress, so the landing can offer an explicit "Reprendre" — but NEVER open it (no setTask) and
  // NEVER create one. Opening /tutor always lands on the landing screen; what happens next is the
  // student's click (reported: "tutor shouldn't auto open session"). Deliberately does NOT call
  // /api/study/free here: that route both resumes AND mints sessions, neither of which a passive load
  // has any business doing.
  const peekForActiveSession = useCallback(() => {
    setLoadError(false);
    api.tasks().then((list) => {
      const t = Array.isArray(list)
        ? list.find((x) => x.source === "freestudy" && x.status !== "dismissed" && x.status !== "done")
        : undefined;
      setPendingActiveSession(t || null);
    }).catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    if (mountFetchStartedRef.current) return;
    mountFetchStartedRef.current = true;
    peekForActiveSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh past sessions on mount and whenever a session ends below.
  useEffect(() => {
    setPastSessions(getTutorSessions(userId));
  }, [userId]);

  // If a sessionId is provided via route, load that session from history
  useEffect(() => {
    if (sessionId && userId) {
      const sessions = getTutorSessions(userId);
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        // Load the session in review mode - show board and chat
        setOpenBoardSession(session);
        setOpenChatSession(session);
        setShowHistory(true);
      }
    }
  }, [sessionId, userId]);

  const saveAndClose = useCallback((task: WebTask, startedAt: string) => {
    const chat = task.chat || [];
    const board = task.board || [];
    const userMsgCount = chat.filter((m) => m.role === "user").length;
    // Substance gate: a session with no real user messages and nothing on the board was never actually
    // used (opened and closed, or auto-ended before Otto's first reply landed). Saving it would bury the
    // useful history under empty shells — dismiss silently instead.
    if (userMsgCount === 0 && board.length === 0) return;
    const summary = buildSessionSummary(board, chat);
    const sessionSummary: TutorSessionSummary = {
      id: task.id,
      taskId: task.id,
      startTime: startedAt,
      endTime: new Date().toISOString(),
      messageCount: userMsgCount,
      boardEntries: board.map((b) => String(b?.text ?? "").trim()).filter(Boolean),
      // The FULL board (kind labels, diagrams, equations — everything BoardArtifact needs), saved as-is so
      // "Voir le tableau" reopens it exactly as it looked when the session ended.
      board: task.board || [],
      chat,
      summary,
      subject: task.sourceSubject,
      objectivesCompleted: task.objectives?.length ? task.objectives.filter((o) => o.done).length : undefined,
      objectivesTotal: task.objectives?.length || undefined,
    };
    saveTutorSession(sessionSummary, userId);
    setPastSessions(getTutorSessions(userId));
  }, [userId]);

  // Auto-end after 30 minutes of no interaction — only once the conversation is actually underway (the
  // chat has at least one message), never while the student is still on the opening screen deciding what
  // to ask. Ending here runs the SAME substance gate as a manual end: an unused session is dismissed
  // silently, never saved to history.
  const INACTIVITY_MS = 30 * 60 * 1000;
  useEffect(() => {
    if (!sessionStart || !task || (task.chat?.length || 0) === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        saveAndClose(task, sessionStart);
        // NOT `try { api.dismiss(...) } catch {}` — dismiss is async, so a plain try/catch around the call
        // (no await) never actually catches a rejection; it silently becomes an unhandled promise rejection
        // instead, meaning a failed dismiss here was never retried, ever — a real contributor to the "ghost
        // session that never goes away" bug (see peekForActiveSession's ghost-cleanup and dismissWithRetry).
        void dismissWithRetry(task.id);
        setTask(null);
        setSessionStart(null);
        setPendingActiveSession(null);
        setShowHistory(true);
        setDesmosOpen(false);
        desmosEverOpenedRef.current = false;
      }, INACTIVITY_MS);
    };
    const activityEvents = ["mousedown", "keydown", "scroll", "touchstart"] as const;
    activityEvents.forEach((event) => window.addEventListener(event, reset));
    reset();
    return () => {
      clearTimeout(timer);
      activityEvents.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [sessionStart, task, saveAndClose]);

  const canvasRef = useRef<TutorCanvasHandle>(null);
  // True from the moment a batch carrying a CORRECT exercise result is sent until the student's next own message.
  const [exerciseDone, setExerciseDone] = useState(false);
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const send = useCallback(async (override?: string, voiceMode?: boolean) => {
    let message = (override ?? input).trim();
    if (!message || sending || !task) return;
    const isAutoResult = /^\[(?:Exercise|Exercice)\]/.test(message);
    if (!isAutoResult) setExerciseDone(false);
    else if (/\b(marked right|juste)\b/.test(message)) setExerciseDone(true);
    setInput(""); setSending(true); setError(null); setPendingMsg(message);
    try {
      // Anything new on the whiteboard rides along with the message — draw, then just say "is this right?"
      // like you would to a person leaning over your page; no separate "send drawing" step needed.
      const seen = await canvasRef.current?.readUnseenInk();
      if (seen) message += "\n\n" + L(`[Ce que j'ai écrit/dessiné sur le tableau : ${seen}]`, `[What I wrote/drew on the board: ${seen}]`);
      // canvasMode: true — the Tutor UI has no way to OPEN a note/flashcard-deck/quiz artifact (onOpenNote/
      // onOpenDeck/onOpenQuiz are all no-ops below, since this screen is chat+board, not the task list's
      // artifact viewer). Without this flag the full tool set was still offered server-side, so the model
      // could (and did — reported live) create a whole flashcard deck here: a chip that does nothing when
      // tapped, AND a much heavier generation that's far more likely to exhaust the reply's token budget and
      // come back as a hard "Otto couldn't reply" with no message at all. canvasMode restricts the tutor to
      // CREATE_PROBLEM (individual, inline, answerable right on the board) instead — the only artifact this
      // screen actually knows how to show.
      const response = await api.chat(task.id, message, task.chat || [], task.board || [], task.problems || [], undefined, undefined, voiceMode, true, true, task.objectives || []);
      const { task: updated, objectives } = response;
      // objectives is only ever the FULL replacement list (SET_OBJECTIVES' own contract), or undefined
      // when Otto didn't touch it this turn — never overwrite the existing list with an empty one.
      const newObjectives = objectives?.length ? setLocalObjectives(task.id, objectives, userId) : (task.objectives || []);
      // chat/board/problems are cloud-persisted again now (server/index.ts's chat route) — `updated`
      // already carries the full, authoritative arrays, no local-storage write needed.
      // Only update relevant fields, preserve context/steps/links from before
      setTask({
        ...task,
        ...updated,
        objectives: newObjectives,
        // Don't overwrite context/steps/links with irrelevant data
        context: task.context || "",
        steps: task.steps || [],
        links: task.links || [],
      });
    } catch (e: any) {
      // If the error response contains board or problems, apply them before showing error
      const errorData = e?.response?.data || e?.data;
      if (errorData?.board || errorData?.problems) {
        setTask({
          ...task,
          ...errorData.task,
          // Preserve context/steps/links
          context: task.context || "",
          steps: task.steps || [],
          links: task.links || [],
        });
      }
      // Only show error if no content was returned
      if (!errorData?.board?.length && !errorData?.problems?.length) {
        // A raw browser network error (e.g. the device slept mid-request — Chrome's "Failed to fetch"/
        // ERR_NETWORK_IO_SUSPENDED, or a dropped connection — ERR_CONNECTION_RESET) isn't something a
        // student should ever have to read verbatim; `e.message` for those is generic browser text, not a
        // real server error. Only show the server's OWN message (it always sets `.status`, see api.ts's
        // `j()`); anything without one is a network-layer failure, so use the friendly fallback instead.
        setError(e?.status != null ? e.message : L("Otto n'a pas pu répondre — réessaie.", "Otto couldn't reply — try again."));
        setInput(message);
      }
    } finally {
      setSending(false); setPendingMsg(null);
    }
  }, [input, sending, task, userId, L]);

  // Each answer to a board exercise goes to Otto as a short automatic message so he reacts like a person
  // (the board only marks right/wrong). They must never INTERRUPT: sent the instant a reply landed, a second
  // reply would replace the one the student is still reading or hearing. So they wait until no reply is in
  // flight, Otto has stopped speaking and things have been quiet for a moment, then go out as ONE batched
  // message (several quick answers = one reaction, not a stack of replies).
  const resultsRef = useRef<string[]>([]);
  const [resultTick, setResultTick] = useState(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const onProblemResult = useCallback((r: { given: string; correct: boolean; attempt: number }) => {
    resultsRef.current.push(L(
      `[Exercice] J'ai répondu « ${r.given.slice(0, 120)} » — ${r.correct ? "juste" : "faux"} (essai n°${r.attempt}).`,
      `[Exercise] I answered "${r.given.slice(0, 120)}" — marked ${r.correct ? "right" : "wrong"} (try #${r.attempt}).`));
    setResultTick((n) => n + 1);
  }, [L]);
  useEffect(() => {
    if (!task || !resultsRef.current.length) return;
    if (sending || voiceState.speaking) return; // re-evaluated when either settles
    const t = setTimeout(() => {
      if (!resultsRef.current.length) return;
      void sendRef.current(resultsRef.current.splice(0).join("\n"));
    }, 3000);
    return () => clearTimeout(t);
  }, [resultTick, sending, voiceState.speaking, task?.id]);

  const endSession = useCallback(async () => {
    if (!task || endingSession) return;
    setEndingSession(true);
    try {
      // Ending must ALWAYS end: a failure while saving the history summary (storage full, an odd board entry)
      // or while dismissing the task server-side must never leave the student stuck on a button that does
      // nothing. Every step is best-effort; the screen is left no matter what.
      try { saveAndClose(task, sessionStart || task.createdAt || new Date().toISOString()); } catch (e) { console.warn("[tutor] couldn't save the session summary:", e); }
      // Dismiss the freestudy task so the next start creates a fresh one.
      try { await dismissWithRetry(task.id); } catch { /* ghost-cleanup in peekForActiveSession covers it */ }
    } finally {
      setTask(null);
      setSessionStart(null);
      // The ended session must not come back as a "Reprendre" offer on the landing below.
      setPendingActiveSession(null);
      setShowHistory(true);
      setDesmosOpen(false);
      desmosEverOpenedRef.current = false;
      setEndingSession(false);
    }
  }, [task, sessionStart, endingSession, saveAndClose]);

  // Resume (explicit): the only way an existing session reopens — the student clicks "Reprendre" on the
  // landing. Opening /tutor by itself never puts them back into a session; the landing always comes
  // first, and what happens next is their choice.
  const resumeActiveSession = useCallback(() => {
    if (!pendingActiveSession) return;
    // chat/board/problems are cloud-persisted again now, so the task object itself is authoritative —
    // localStorage (getLocalThread) is only consulted as a fallback for whichever field is still empty in
    // the cloud copy (a session from the local-only era that never made it to the server).
    const local = getLocalThread(pendingActiveSession.id, userId);
    const chat = pendingActiveSession.chat?.length ? pendingActiveSession.chat : local.chat;
    const board = pendingActiveSession.board?.length ? pendingActiveSession.board : local.board;
    const problems = pendingActiveSession.problems?.length ? pendingActiveSession.problems : local.problems;
    const objectives = pendingActiveSession.objectives?.length ? pendingActiveSession.objectives : local.objectives;
    // Only load relevant fields from the task, ignore irrelevant ones
    setTask({
      ...pendingActiveSession,
      chat,
      board,
      problems,
      objectives,
      // Clear irrelevant context from previous sessions
      context: "",
      steps: [],
      links: [],
      flashcards: [],
      quizzes: [],
      artifacts: [],
    });
    setSessionStart(new Date().toISOString());
    setDesmosOpen(false);
    desmosEverOpenedRef.current = false;
  }, [pendingActiveSession, userId]);

  const startNewSession = useCallback(async () => {
    if (!selectedSubject || startingSession) return;
    setError(null);
    setStartingSession(true);
    try {
      // Dismiss any existing session before creating a new one
      if (pendingActiveSession) {
        saveAndClose(pendingActiveSession, sessionStart || pendingActiveSession.createdAt);
        await dismissWithRetry(pendingActiveSession.id);
        setPendingActiveSession(null);
      }
      // Create a fresh session for the selected subject. The server APPENDS the new task to the end of
      // the list and returns the whole list — so the new task is always the LAST freestudy entry, not
      // necessarily the first. Older sessions (ended, dismissed, kept only for history) commonly share
      // the same subject label ("Math" comes up again and again), so a plain .find() from the front could
      // grab a stale, already-ended session instead of the one just created — the source of "a supposedly
      // empty new session shows old content." Search from the end, and require it not be dismissed/done.
      const list = await api.studyFreeSession(true, selectedSubject);
      const t = Array.isArray(list)
        ? [...list].reverse().find((x) => x.source === "freestudy" && x.sourceSubject === selectedSubject && x.status !== "dismissed" && x.status !== "done")
        : undefined;
      if (t) {
        // No local-storage cleanup needed here: `t.id` is a fresh randomUUID minted by /api/study/free —
        // it has never existed before, so localChatBoard.ts's combined map has no entry for it to clear.
        // (This used to call localStorage.removeItem on guessed per-task keys that module has never
        // written in the first place — dead code, removed.)
        setTask({
          ...t,
          chat: [],
          board: [],
          problems: [],
          objectives: [],
          // Clear any residual fields
          context: "",
          steps: [],
          links: [],
          flashcards: [],
          quizzes: [],
          artifacts: [],
        });
        setSessionStart(new Date().toISOString());
        setDesmosOpen(false);
        desmosEverOpenedRef.current = false;
      }
      setPendingActiveSession(null);
    } catch {
      setError(L("Impossible de démarrer la séance", "Couldn't start the session"));
    } finally {
      setStartingSession(false);
    }
  }, [selectedSubject, startingSession, pendingActiveSession, sessionStart, saveAndClose, userId, L]);

  // The Tutor route hides the app's top nav entirely (it's a focused, full-screen surface) — this is the
  // ONE way back to Tasks that replaces it, present on the landing and error screens (the active session
  // uses the breadcrumb bar's "All sessions" link instead).
  const backButton = (
    <button type="button" className="tutor-back-btn" onClick={onExit} aria-label={L("Retour aux tâches", "Back to tasks")}>
      ← {L("Toutes les séances", "All sessions")}
    </button>
  );

  if (loadError) {
    return (
      <main className="list-wrap">{backButton}<div className="empty-state">
        <h3>{L("Impossible de démarrer la séance", "Couldn't start the session")}</h3>
        <button className="btn primary" onClick={() => { mountFetchStartedRef.current = false; peekForActiveSession(); }}>{L("Réessayer", "Try again")}</button>
      </div></main>
    );
  }

  // No active session — the landing screen: start button + past sessions.
  if (!task) {
    return (
      <main className="list-wrap tutor-landing">
        {backButton}
        <PageTour id="tutor-landing" steps={TOURS["tutor-landing"]} />
        <div className="tutor-landing-inner">
          {/* The prototype's cream-circle face — two dots, no mouth. The one illustration the whole
              design system allows, reused on the landing and the session screens. */}
          <div className="tutor-face" aria-hidden><span className="tutor-face-eye" /><span className="tutor-face-eye" /></div>
          <h2 className="tutor-landing-title">{L("Salut, moi c'est Otto.", "Hi, I'm Otto.")}</h2>
          <p className="tutor-landing-sub">{L("Qu'est-ce que tu veux comprendre aujourd'hui ?", "What would you like to understand today?")}</p>

          {/* If there's an active session, show resume option */}
          {pendingActiveSession && (
            <div className="tutor-active-session-card">
              <div className="tutor-active-session-header">
                <span className="tutor-active-session-badge">{L("En cours", "In progress")}</span>
                <span className="tutor-active-session-subject">{pendingActiveSession.sourceSubject || ""}</span>
              </div>
              <p className="tutor-active-session-text">
                {L("Tu as une séance en cours. Veux-tu la reprendre ?", "You have a session in progress. Resume it?")}
              </p>
              <div className="tutor-active-session-actions">
                <button className="btn primary tutor-resume-btn" onClick={resumeActiveSession}>
                  {L("Reprendre", "Resume")}
                </button>
              </div>
            </div>
          )}

          {/* Always show subject selector so you can create a new session even when one is active —
              rendered as the prototype's single wide pill: subject select left, orange "Start a session"
              button right, no separate label above. The gate stays (the button is disabled until a
              subject is picked) but the affordance is always visible. */}
          <div className="tutor-start-row">
            <select
              id="tutor-subject-select"
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              className="tutor-start-select"
              aria-label={L("Matière", "Subject")}
            >
              <option value="">{L("Choisir une matière", "Choose a subject")}</option>
              {subjectOptions.map((subj) => (
                <option key={subj} value={subj}>{subj}</option>
              ))}
            </select>
            <button
              className="btn primary tutor-start-btn"
              onClick={() => void startNewSession()}
              disabled={startingSession || !selectedSubject}
            >
              {startingSession
                ? L("Démarrage…", "Starting…")
                : L("Commencer une séance", "Start a session")}
            </button>
          </div>

          {pastSessions.length > 0 && (
            <div className="tutor-past-sessions">
              <button className="tutor-history-toggle" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? "▼ " : "▶ "}{L("Nos séances passées", "Our past sessions")} ({pastSessions.length})
              </button>
              {showHistory && (
                <ul className="tutor-history-list">
                  {pastSessions.map((s) => (
                    <li key={s.id} className="tutor-history-item">
                      <div className="tutor-history-date">
                        {new Date(s.endTime).toLocaleDateString(L("fr-FR", "en-US"), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {s.subject && <span className="tutor-history-subject"> · {s.subject}</span>}
                      </div>
                      <div className="tutor-history-summary">
                        <div className="tutor-history-summary-heading">
                          <span>{L("Ce qu'on a travaillé", "What we worked on")}</span>
                          <span className="tutor-history-message-count">
                            {s.messageCount} {L("messages", "messages")}
                            {/* Undefined (no objectives were ever set this session) vs. "0/3" are different
                                facts — only render when objectivesTotal is actually a number. */}
                            {typeof s.objectivesTotal === "number" && (
                              <> · {s.objectivesCompleted ?? 0}/{s.objectivesTotal} {L("objectifs", "objectives")}</>
                            )}
                          </span>
                        </div>
                        <div className="tutor-history-topic">
                          {s.subject && <span className="tutor-history-subject-pill">{s.subject}</span>}
                          <span>{formatMath(s.summary.split(" — ")[0])}</span>
                        </div>
                        {/* Board at a glance — the first few things Otto actually wrote that session, as the
                            compact scannable record (the full reopenable board is one click below). Capped at
                            3 lines so a long session's history item stays a preview, not a transcript. */}
                        {!!s.boardEntries?.length && (
                          <div className="tutor-history-takeaways">
                            <div className="tutor-history-section-label">{L("Le tableau en bref", "Board at a glance")}</div>
                            <ul className="tutor-history-board">
                              {s.boardEntries.filter(Boolean).slice(0, 3).map((line, bi) => {
                                const formattedLine = formatMath(line);
                                const displayLine = formattedLine.length > 140 ? `${formattedLine.slice(0, 140)}…` : formattedLine;
                                return <li key={bi}>{displayLine}</li>;
                              })}
                            </ul>
                          </div>
                        )}
                      </div>
                      {/* Full board (diagrams/equations, not just the flattened text preview above) — only
                          present for a session ended after this was added; an older saved session has no
                          `board` field to reopen. */}
                      <div className="tutor-history-actions">
                        <a href={`/tutor/session/${s.id}`} className="btn ghost xs tutor-history-view-board">
                          {L("Voir la séance", "View session")}
                        </a>
                        {!!s.board?.length && (
                          <button type="button" className="btn ghost xs tutor-history-view-board" onClick={() => setOpenBoardSession(s)}>
                            {L("Voir le tableau", "View board")}
                          </button>
                        )}
                        {!!s.chat?.length && (
                          <button type="button" className="btn ghost xs tutor-history-view-chat" onClick={() => setOpenChatSession(s)}>
                            {L("Voir le chat", "View chat")}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {openBoardSession && (
          <TaskModal onClose={() => setOpenBoardSession(null)} title={L("Le tableau", "Board") + (openBoardSession.subject ? ` · ${openBoardSession.subject}` : "")}>
            <BoardArtifact task={{ board: openBoardSession.board } as unknown as WebTask} />
          </TaskModal>
        )}
        {openChatSession && (
          <TaskModal onClose={() => setOpenChatSession(null)} title={L("Le chat", "Chat") + (openChatSession.subject ? ` · ${openChatSession.subject}` : "")}>
            <div className="tutor-chat-history">
              {openChatSession.chat?.map((msg, i) => (
                <div key={i} className={`tutor-chat-message ${msg.role}`}>
                  <div className="tutor-chat-role">{msg.role === "user" ? L("Toi", "You") : L("Otto", "Otto")}</div>
                  <div className="tutor-chat-text"><MathText text={msg.text} /></div>
                </div>
              ))}
            </div>
          </TaskModal>
        )}
      </main>
    );
  }

  const noop = () => {};
  const fresh = !task.chat?.length && !pendingMsg;
  const objDone = task.objectives?.filter((o) => o.done).length ?? 0;
  // Zero-friction start (blank-page friction is what makes students abandon AI tutors): Otto "speaks first"
  // instantly, no model call. If this subject has a past session, the opener is a retrieval question about
  // it — recalling beats re-reading — otherwise a plain, specific invitation. One-tap starters follow.
  const lastSame = pastSessions.find((s) => s.subject && s.subject === task.sourceSubject && s.summary && s.summary !== "Session completed");
  const lastTopic = lastSame?.summary.split(" — ")[0].split("\n")[0].slice(0, 90);
  const subj = task.sourceSubject;
  const openerText = lastTopic
    ? L(`Salut ! La dernière fois on a bossé : « ${lastTopic} ». Qu'est-ce que tu en retiens ? Ou dis-moi sur quoi tu bloques aujourd'hui.`, `Hey! Last time we worked on: "${lastTopic}". What do you still remember? Or tell me what's tripping you up today.`)
    : subj
      ? L(`Salut ! Sur quoi tu bloques en ${subj} ? Écris, dessine ou parle — je t'écoute.`, `Hey! What's tripping you up in ${subj}? Type, draw or just talk — I'm listening.`)
      : L("Salut ! Sur quoi tu bloques ? Écris, dessine ou parle.", "Hey! What are you stuck on? Type, draw or just talk.");
  const starters = [
    { label: L("Je bloque sur un exercice", "I'm stuck on a problem"), text: L("Je bloque sur un exercice.", "I'm stuck on a problem.") },
    { label: L("Explique-moi un cours", "Teach me a topic"), text: L("J'aimerais comprendre un chapitre.", "I'd like to understand a topic.") },
    { label: L("Interroge-moi", "Quiz me"), text: L("Interroge-moi pour voir ce que je sais.", "Quiz me to see what I know.") },
  ];
  // Right after the student has completed an exercise: offer the next move as one-tap choices (Otto also asks
  // what they'd like to do — see the persona's EXERCISE RESULTS rule) instead of leaving them at a bare "solved".
  const justFinishedExercise = exerciseDone;
  const nextChips = [
    { label: L("➡ Un autre", "➡ Another one"), text: L("J'en veux un autre comme celui-là.", "Another one like it, please.") },
    { label: L("⬆ Plus dur", "⬆ Harder"), text: L("Donne-m'en un plus difficile.", "Give me a harder one.") },
    { label: L("🔁 Revoir l'idée", "🔁 Go over the idea"), text: L("Reprenons l'idée derrière cet exercice.", "Let's go back over the idea behind that one.") },
    { label: L("💬 Autre chose", "💬 Something else"), text: L("Je voudrais faire autre chose.", "I'd like to do something else.") },
  ];
  const followUps = [
    { label: L("💡 Un indice", "💡 Hint"), text: L("Tu peux me donner un petit indice ?", "Can I have a small hint?") },
    { label: L("🤔 Je suis perdu", "🤔 I'm lost"), text: L("Je suis perdu — on peut y aller plus doucement ?", "I'm lost — can we go smaller?") },
    { label: L("➡ Un autre", "➡ Another one"), text: L("Compris ! Donne-m'en un autre à essayer.", "Got it! Give me another to try.") },
  ];
  // Gauth-style stage: ONE big canvas (Otto's lesson board with the student's ink over it) and Otto himself
  // as just an avatar docked at the bottom — no transcript. The student talks (or types) to the avatar and
  // sees only Otto's latest answer; everything worth keeping lands on the board instead of scrolling away
  // in a chat log. The full conversation is still saved with the session for the history view.
  return (
    <main className={`tutor-stage${voiceState.voiceModeOn ? " voice-on" : ""}`}>
      <PageTour id="tutor-session" steps={TOURS["tutor-session"]} />
      {/* Same breadcrumb chrome as the rest of the Tutor ("All sessions / Subject … End session"). */}
      <header className="ts-bar tutor-crumbbar">
        <button type="button" className="tutor-crumb-link" onClick={onExit}>{L("Toutes les séances", "All sessions")}</button>
        {task.sourceSubject ? <span className="tutor-crumb-subject">{task.sourceSubject}</span> : null}
        {!!task.objectives?.length && (
          <span className="ts-chip" title={task.objectives.map((o) => `${o.done ? "✓" : "○"} ${o.label}`).join("\n")}>
            ◎ {objDone}/{task.objectives.length}{typeof task.mastery === "number" ? ` · ${Math.round(task.mastery * 100)}%` : ""}
          </span>
        )}
        <button type="button" className="btn ghost tutor-chat-btn" data-tour="ts-chat" onClick={() => setChatDrawer(true)} aria-label={L("Ouvrir le chat", "Open chat")}>
          💬 {L("Chat", "Chat")}
        </button>
        <button className="btn ghost tutor-end-btn" disabled={endingSession} onClick={() => void endSession()}>
          {endingSession ? L("Fin…", "Ending…") : L("Terminer la séance", "End session")}
        </button>
      </header>
      <section className="ts-canvas" aria-label={L("Tableau", "Board")}>
        <div className="tutor-board-body ts-board-body" ref={setSurfaceEl} style={{ display: desmosOpen ? "none" : undefined }}>
          <BoardArtifact task={task} writing={sending} onProblemResult={onProblemResult} />
        </div>
        {/* Desmos stays mounted once opened (an iframe that's removed reloads blank, losing the student's graph). */}
        {desmosOpen || desmosEverOpenedRef.current ? (
          <div style={{ display: desmosOpen ? "contents" : "none" }}>
            <TutorDesmos onClose={() => setDesmosOpen(false)} />
          </div>
        ) : null}
        <TutorCanvas
          ref={canvasRef}
          visionReady={visionReady}
          hidden={desmosOpen}
          surface={surfaceEl}
          onDesmos={() => setDesmosOpen((o) => !o)}
          onSend={(description, note) => void send((note ? note + "\n\n" : "") + L(`Voici ce que j'ai dessiné : ${description}`, `Here's what I drew: ${description}`))}
        />
      </section>
      <div className="ts-dock">
        <AskOttoPanel
          variant="dock"
          task={task} currentStep={undefined} input={input} setInput={setInput} sending={sending}
          error={error} pendingMsg={pendingMsg} onSend={(o, v) => void send(o, v)}
          onOpenNote={noop} onOpenDeck={noop} onOpenQuiz={noop}
          emptyText={openerText}
          quickReplies={fresh ? starters : justFinishedExercise ? nextChips : followUps}
          placeholder={L("Parle ou écris à Otto…", "Talk or type to Otto…")}
          onVoiceStateChange={handleVoiceState}
        />
      </div>
      {chatDrawer && (
        <TaskModal wide onClose={() => { setChatDrawer(false); setChatExpanded(false); }} title={L("Chat avec Otto", "Chat with Otto")}>
          <div className={`tutor-chat-drawer${chatExpanded ? " expanded" : ""}`}>
            <div className="tutor-chat-toolbar">
              <span>{task.chat?.length || 0} {L("messages", "messages")}</span>
              <button type="button" className="btn ghost xs" onClick={() => setChatExpanded((v) => !v)}>{chatExpanded ? L("Réduire", "Collapse") : L("Agrandir", "Expand")}</button>
            </div>
            <div className="tutor-chat-history">
              {!task.chat?.length && <p className="tutor-chat-empty">{L("Rien encore — dis bonjour à Otto.", "Nothing yet — say hi to Otto.")}</p>}
              {task.chat?.map((msg, i) => (
                <div key={i} className={`tutor-chat-message ${msg.role}`}>
                  <div className="tutor-chat-role">{msg.role === "user" ? L("Toi", "You") : "Otto"}</div>
                  <div className="tutor-chat-text"><MathText text={msg.text} /></div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {pastSessions.some((ps) => ps.chat?.length) && (
              <details className="tutor-chat-past">
                <summary>{L("Séances passées", "Past sessions")} ({pastSessions.filter((ps) => ps.chat?.length).length})</summary>
                {pastSessions.filter((ps) => ps.chat?.length).map((ps) => (
                  <details key={ps.id} className="tutor-chat-past-item" onToggle={(e) => setOpenPast((o) => ({ ...o, [ps.id]: (e.currentTarget as HTMLDetailsElement).open }))}>
                    <summary>
                      {new Date(ps.startTime || ps.endTime).toLocaleDateString()}{ps.subject ? ` · ${ps.subject}` : ""} — {(ps.summary || "").replace(/[*`#>_\-]+/g, " ").replace(/\s+/g, " ").trim().split(" — ")[0].slice(0, 70) || `${ps.messageCount} ${L("messages", "messages")}`}
                    </summary>
                    {openPast[ps.id] && (
                      <div className="tutor-chat-history">
                        {ps.chat!.map((msg, i) => (
                          <div key={i} className={`tutor-chat-message ${msg.role}`}>
                            <div className="tutor-chat-role">{msg.role === "user" ? L("Toi", "You") : "Otto"}</div>
                            <div className="tutor-chat-text"><MathText text={msg.text} /></div>
                          </div>
                        ))}
                      </div>
                    )}
                  </details>
                ))}
              </details>
            )}
          </div>
        </TaskModal>
      )}
    </main>
  );
}
