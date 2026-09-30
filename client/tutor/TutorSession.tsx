import { useCallback, useEffect, useRef, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { hydrateLocalThreads, appendLocalChat, appendLocalBoard, appendLocalProblems } from "../localChatBoard.ts";
import { useLang, TaskModal } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { BoardArtifact } from "../study/artifacts/BoardArtifact.tsx";
import { TutorDesmos } from "./TutorDesmos.tsx";
import { buildSessionSummary, saveTutorSession, getTutorSessions, type TutorSessionSummary } from "./tutorSessions.ts";

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
export function TutorSession({ userId }: { userId: string | null }) {
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
  // The landing screen asks WHAT to study before starting — the subject is stamped onto the session
  // (sourceSubject, visible to the tutor prompt) and carried into history as the session's label.
  const COMMON_SUBJECTS = [
    "Math", "Physics", "Chemistry", "Biology", "History",
    "English", "French", "Spanish", "Geography", "Economics",
    "Philosophy", "Computer Science", "Art", "Music", "Other",
  ];
  const [selectedSubject, setSelectedSubject] = useState("");
  const [startingSession, setStartingSession] = useState(false);
  // What the mount peek found: a freestudy session still in progress (or null).
  const [pendingActiveSession, setPendingActiveSession] = useState<WebTask | null>(null);
  // True until the FIRST peek resolves — distinguishes "haven't checked yet" from "checked, nothing
  // active", so the landing doesn't render a confident "no session" state for a beat before the real
  // answer arrives (reported: detection doesn't feel instant / looks like it "doesn't recognize" a
  // session that's actually there, right up until the fetch resolves a moment later).
  const [checkingSession, setCheckingSession] = useState(true);
  // Voice is MANUAL here — the mic toggle in the chat panel is the student's choice, never forced on by
  // starting a session (reported: "voice should not be auto on"). The board-pane pill, barge-in and the
  // voice-primary layout below all still activate the moment the student turns voice on themselves.
  // Live voice-loop state, reported up by AskOttoPanel — rendered as a pill on the BOARD pane header, not
  // the chat: with voice on, the student's eyes are on the board, so "am I being heard?" has to
  // be answerable where they're actually looking.
  const [voiceState, setVoiceState] = useState({ listening: false, speaking: false, voiceModeOn: false, interim: "" });
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
    }).catch(() => setLoadError(true))
      .finally(() => setCheckingSession(false));
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

  // Re-check for active session when subject changes
  useEffect(() => {
    if (selectedSubject) {
      setCheckingSession(true);
      peekForActiveSession();
    }
  }, [selectedSubject]); // eslint-disable-line react-hooks/exhaustive-deps

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
      boardEntries: board.map((b) => b.text.trim()).filter(Boolean),
      // The FULL board (kind labels, diagrams, equations — everything BoardArtifact needs), saved as-is so
      // "Voir le tableau" reopens it exactly as it looked when the session ended.
      board: task.board || [],
      chat,
      summary,
      subject: task.sourceSubject,
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
        try { api.dismiss(task.id); } catch { /* best-effort */ }
        setTask(null);
        setSessionStart(null);
        setPendingActiveSession(null);
        setShowHistory(true);
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

  const send = useCallback(async (override?: string, voiceMode?: boolean) => {
    const message = (override ?? input).trim();
    if (!message || sending || !task) return;
    setInput(""); setSending(true); setError(null); setPendingMsg(message);
    try {
      const response = await api.chat(task.id, message, task.chat || [], task.board || [], task.problems || [], undefined, undefined, voiceMode, undefined, true);
      const { task: updated, chatDelta, board, problems } = response;
      const chat = appendLocalChat(task.id, chatDelta, userId);
      const newBoard = appendLocalBoard(task.id, board, userId);
      const newProblems = appendLocalProblems(task.id, problems, userId);
      // Only update relevant fields, preserve context/steps/links from before
      setTask({
        ...task,
        ...updated,
        chat,
        board: newBoard,
        problems: newProblems,
        // Don't overwrite context/steps/links with irrelevant data
        context: task.context || "",
        steps: task.steps || [],
        links: task.links || [],
      });
    } catch (e: any) {
      // If the error response contains board or problems, apply them before showing error
      const errorData = e?.response?.data || e?.data;
      if (errorData?.board || errorData?.problems) {
        const chat = appendLocalChat(task.id, errorData.chatDelta || [], userId);
        const newBoard = appendLocalBoard(task.id, errorData.board || [], userId);
        const newProblems = appendLocalProblems(task.id, errorData.problems || [], userId);
        setTask({
          ...task,
          ...errorData.task,
          chat,
          board: newBoard,
          problems: newProblems,
          // Preserve context/steps/links
          context: task.context || "",
          steps: task.steps || [],
          links: task.links || [],
        });
      }
      // Only show error if no content was returned
      if (!errorData?.board?.length && !errorData?.problems?.length) {
        setError(e?.message || L("Otto n'a pas pu répondre — réessaie.", "Otto couldn't reply — try again."));
        setInput(message);
      }
    } finally {
      setSending(false); setPendingMsg(null);
    }
  }, [input, sending, task, userId, L]);

  const endSession = useCallback(async () => {
    if (!task || !sessionStart) return;
    setEndingSession(true);
    try {
      saveAndClose(task, sessionStart);
      // Dismiss the freestudy task so the next start creates a fresh one.
      try { await api.dismiss(task.id); } catch { /* best-effort */ }
      setTask(null);
      setSessionStart(null);
      // The ended session must not come back as a "Reprendre" offer on the landing below.
      setPendingActiveSession(null);
      setShowHistory(true);
    } finally {
      setEndingSession(false);
    }
  }, [task, sessionStart, saveAndClose]);

  // Resume (explicit): the only way an existing session reopens — the student clicks "Reprendre" on the
  // landing. Opening /tutor by itself never puts them back into a session; the landing always comes
  // first, and what happens next is their choice.
  const resumeActiveSession = useCallback(() => {
    if (!pendingActiveSession) return;
    // Load chat, board, problems from localStorage
    let chat = pendingActiveSession.chat || [];
    let board = pendingActiveSession.board || [];
    let problems = pendingActiveSession.problems || [];
    try {
      const localChat = localStorage.getItem(`otto-chat-${pendingActiveSession.id}-${userId}`);
      const localBoard = localStorage.getItem(`otto-board-${pendingActiveSession.id}-${userId}`);
      const localProblems = localStorage.getItem(`otto-problems-${pendingActiveSession.id}-${userId}`);
      if (localChat) chat = JSON.parse(localChat);
      if (localBoard) board = JSON.parse(localBoard);
      if (localProblems) problems = JSON.parse(localProblems);
    } catch { /* ignore */ }
    // Only load relevant fields from the task, ignore irrelevant ones
    setTask({
      ...pendingActiveSession,
      chat,
      board,
      problems,
      // Clear irrelevant context from previous sessions
      context: "",
      steps: [],
      links: [],
      flashcards: [],
      quizzes: [],
      artifacts: [],
    });
    setSessionStart(new Date().toISOString());
  }, [pendingActiveSession, userId]);

  const startNewSession = useCallback(async () => {
    if (!selectedSubject || startingSession) return;
    setError(null);
    setStartingSession(true);
    try {
      // Dismiss any existing session before creating a new one
      if (pendingActiveSession) {
        saveAndClose(pendingActiveSession, sessionStart || pendingActiveSession.createdAt);
        try { await api.dismiss(pendingActiveSession.id); } catch { /* best-effort */ }
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
        // Clear ALL localStorage for the new task ID to ensure truly fresh session
        try {
          localStorage.removeItem(`otto-chat-${t.id}-${userId}`);
          localStorage.removeItem(`otto-board-${t.id}-${userId}`);
          localStorage.removeItem(`otto-problems-${t.id}-${userId}`);
        } catch { /* ignore */ }
        // Set task with completely empty arrays - no old content
        setTask({
          ...t,
          chat: [],
          board: [],
          problems: [],
          // Clear any residual fields
          context: "",
          steps: [],
          links: [],
          flashcards: [],
          quizzes: [],
          artifacts: [],
        });
        setSessionStart(new Date().toISOString());
      }
      setPendingActiveSession(null);
    } catch {
      setError(L("Impossible de démarrer la séance", "Couldn't start the session"));
    } finally {
      setStartingSession(false);
    }
  }, [selectedSubject, startingSession, pendingActiveSession, sessionStart, saveAndClose, userId, L]);

  if (loadError) {
    return (
      <main className="list-wrap"><div className="empty-state">
        <h3>{L("Impossible de démarrer la séance", "Couldn't start the session")}</h3>
        <button className="btn primary" onClick={() => { mountFetchStartedRef.current = false; peekForActiveSession(); }}>{L("Réessayer", "Try again")}</button>
      </div></main>
    );
  }

  // No active session — the landing screen: start button + past sessions.
  if (!task) {
    return (
      <main className="list-wrap tutor-landing">
        <div className="tutor-landing-inner">
          <div className="tutor-hero-kicker">{L("Le tutorat qui te rend autonome", "Tutoring that makes you independent")}</div>
          <h2>{L("Apprendre en réfléchissant", "Learn by thinking")}</h2>
          <p className="tutor-landing-sub">{L("Otto ne fait pas le travail à ta place. Il t'aide à essayer, à expliquer ton raisonnement et à transférer ce que tu apprends.", "Otto won't do the work for you. He helps you try, explain your reasoning, and transfer what you learn.")}</p>

          {/* While the mount peek is still in flight, say so rather than silently looking like there's
              nothing to resume — avoids the "doesn't recognize an active session" impression that's really
              just the fetch not having landed yet. */}
          {checkingSession && (
            <div className="tutor-active-session-card tutor-active-session-checking" aria-live="polite">
              <p className="tutor-active-session-text">{L("Vérification d'une séance en cours…", "Checking for a session in progress…")}</p>
            </div>
          )}

          {/* If there's an active session, show resume option */}
          {!checkingSession && pendingActiveSession && (
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

          {/* Always show subject selector so you can create a new session even when one is active */}
          <div className="tutor-subject-select">
            <label htmlFor="tutor-subject-select">{L("Sur quelle matière veux-tu travailler ?", "Which subject do you want to work on?")}</label>
            <select
              id="tutor-subject-select"
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              className="btn ghost"
            >
              <option value="">{L("Choisir une matière", "Choose a subject")}</option>
              {COMMON_SUBJECTS.map((subj) => (
                <option key={subj} value={subj}>{subj}</option>
              ))}
            </select>
          </div>

          {/* Start appears only once a subject is picked */}
          {selectedSubject && (
            <button
              className="btn primary tutor-start-btn"
              onClick={() => void startNewSession()}
              disabled={startingSession || checkingSession}
            >
              {startingSession
                ? L("Démarrage…", "Starting…")
                : checkingSession
                  ? L("Vérification…", "Checking…")
                  : L("Commencer une séance de ", "Start a ") + selectedSubject + L("", " session")}
            </button>
          )}

          {pastSessions.length > 0 && (
            <div className="tutor-past-sessions">
              <button className="tutor-history-toggle" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? "▼ " : "▶ "}{L("Séances précédentes", "Past sessions")} ({pastSessions.length})
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
                          <span className="tutor-history-message-count">{s.messageCount} {L("messages", "messages")}</span>
                        </div>
                        <div className="tutor-history-topic">
                          {s.subject && <span className="tutor-history-subject-pill">{s.subject}</span>}
                          <span>{s.summary.split(" — ")[0]}</span>
                        </div>
                        {/* Board at a glance — the first few things Otto actually wrote that session, as the
                            compact scannable record (the full reopenable board is one click below). Capped at
                            3 lines so a long session's history item stays a preview, not a transcript. */}
                        {!!s.boardEntries?.length && (
                          <div className="tutor-history-takeaways">
                            <div className="tutor-history-section-label">{L("Le tableau en bref", "Board at a glance")}</div>
                            <ul className="tutor-history-board">
                              {s.boardEntries.filter(Boolean).slice(0, 3).map((line, bi) => (
                                <li key={bi}>{line.length > 140 ? `${line.slice(0, 140)}…` : line}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                      {/* Full board (diagrams/equations, not just the flattened text preview above) — only
                          present for a session ended after this was added; an older saved session has no
                          `board` field to reopen. */}
                      <div className="tutor-history-actions">
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
                  <div className="tutor-chat-text">{msg.text}</div>
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
  // Voice-primary layout: while voice mode is on the board pane widens and takes the accent highlight —
  // the student is talking, not typing, and per the gesture/dual-coding research their eyes belong on the
  // visual surface (figures, formulas, structure), not on a chat transcript they can't see while speaking.
  return (
    <main className={`tutor-session${voiceState.voiceModeOn ? " voice-primary" : ""}`}>
      <section className="tutor-chat" aria-label={L("Discuter avec Otto", "Ask Otto")}>
        <div className="tutor-pane-title">
          <span>{L("Demande à Otto", "Ask Otto")}</span>
          <button className="btn ghost tutor-end-btn" disabled={endingSession} onClick={() => void endSession()}>
            {endingSession ? L("Fin…", "Ending…") : L("Terminer la séance", "End session")}
          </button>
        </div>
        {fresh && (
          <div className="tutor-start">
            <p>{L("Salut ! Je suis Otto, ton tuteur. On travaille ensemble sur ce que tu veux apprendre ?", "Hi! I'm Otto, your tutor. Ready to work on whatever you'd like to learn?")}</p>
          </div>
        )}
        <div className="tutor-chat-body">
          <AskOttoPanel
            task={task} currentStep={undefined} input={input} setInput={setInput} sending={sending}
            error={error} pendingMsg={pendingMsg} onSend={(o, v) => void send(o, v)}
            onOpenNote={noop} onOpenDeck={noop} onOpenQuiz={noop}
            emptyText="" placeholder={L("Écris ici…", "Type here…")}
            bargeIn onVoiceStateChange={handleVoiceState}
          />
        </div>
      </section>
      <section className="tutor-board" aria-label={L("Tableau", "Board")}>
        <div className="tutor-pane-title">
          <span>{L("Le tableau", "Board")}</span>
        </div>
        {/* Voice state lives on the BOARD pane: in voice-first mode this is the pane the student is
            actually looking at. A real orb, not a small pill — voice is meant to be the primary way of
            using the tutor, so "are you hearing me / is Otto talking" gets legible, ambient feedback
            instead of a status dot easy to miss while eyes are on a figure. */}
        {voiceState.voiceModeOn ? (
          <div className="tutor-voice-orb-bar">
            <div className={`tutor-voice-orb${voiceState.speaking ? " speaking" : voiceState.listening ? " listening" : ""}`} aria-hidden="true">
              <span className="tutor-voice-orb-ring" />
              <span className="tutor-voice-orb-ring ring-2" />
              <span className="tutor-voice-orb-core" />
            </div>
            <span className="tutor-voice-orb-label" role="status">
              {voiceState.speaking
                ? L("Otto parle…", "Otto is speaking…")
                : voiceState.listening
                  ? L("Je t'écoute…", "Listening…")
                  : L("Voix activée", "Voice on")}
            </span>
            {voiceState.listening && voiceState.interim ? <span className="tutor-voice-interim">{voiceState.interim}</span> : null}
          </div>
        ) : null}
        {/* The tutor's Desmos place — the tools the student can USE mid-lesson (graphing, scientific,
            geometry, four-function), embedded above the board so the figure tool sits with the lesson's
            visuals. Student-opened only, like every other manual surface in the tutor. */}
        <TutorDesmos />
        <div className="tutor-board-body"><BoardArtifact task={task} writing={sending} /></div>
      </section>
    </main>
  );
}
