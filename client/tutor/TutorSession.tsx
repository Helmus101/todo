import { useCallback, useEffect, useRef, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { hydrateLocalThreads, appendLocalChat, appendLocalBoard, appendLocalProblems } from "../localChatBoard.ts";
import { useLang, TaskModal } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { BoardArtifact } from "../study/artifacts/BoardArtifact.tsx";
import { buildSessionSummary, saveTutorSession, getTutorSessions, type TutorSessionSummary } from "./tutorSessions.ts";

/** Tutor Session (route /tutor) — the Primer-style one-to-one lesson: a chat with Otto on one side and
 *  Otto's board on the other. It reuses the free-study task as a private anchor for the thread (chat, board
 *  and problems persist locally, keyed by task id — see localChatBoard.ts), and talks to the SAME chat
 *  endpoint as everywhere else, with `primer: true` so the server swaps in the Primer persona.
 *
 *  Sessions: each session is backed by its own freestudy task. Mounting this component RESUMES an active
 *  freestudy session if one exists (a read-only peek at GET /api/tasks) — but it NEVER CREATES one just
 *  because the page was opened: no active session shows the landing screen, and only the explicit Start
 *  button calls /api/study/free to mint one. A session only earns a place in history when it actually has
 *  substance: at least one real user message or something written on the board (a session where Otto never
 *  said a word and the board stayed empty gets dismissed silently, not memorialized). Ending a session
 *  generates a short summary from the board + chat (see tutorSessions.ts), saves it locally, and dismisses
 *  the task so the next start creates a fresh one. Past session summaries are shown in a collapsible strip. */
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
  // One-tap hands-free voice: starting a session IS the tap — the mic turns on with the session, and the
  // student never touches the mic again. AskOttoPanel applies it exactly once per mount and never re-fights
  // a deliberate toggle-off (see its autoVoiceAppliedRef): a student who turned voice off mid-session keeps
  // it off for the rest of THAT session, and every new start offers voice again.
  const [wantVoice, setWantVoice] = useState(false);
  // Live voice-loop state, reported up by AskOttoPanel — rendered as a pill on the BOARD pane header, not
  // the chat: in a voice-first session the student's eyes are on the board, so "am I being heard?" has to
  // be answerable where they're actually looking.
  const [voiceState, setVoiceState] = useState({ listening: false, speaking: false, voiceModeOn: false, interim: "" });
  const handleVoiceState = useCallback((s: { listening: boolean; speaking: boolean; voiceModeOn: boolean; interim: string }) => setVoiceState(s), []);
  // StrictMode guard for the mount peek below (a double-invoke would just be a wasted duplicate GET, but
  // the guard also keeps the read strictly once-per-mount). Runs once per component lifetime.
  const mountFetchStartedRef = useRef(false);

  // Passive mount load — READ-ONLY peek: resume an active freestudy session if one exists, otherwise stay
  // on the landing screen. Deliberately does NOT call /api/study/free here: that route mints a session
  // when none is active, which made simply OPENING the tutor page start one (reported as "session should
  // not auto start"). Creating a session is only ever the Start button's job.
  const peekForActiveSession = useCallback(() => {
    setLoadError(false);
    api.tasks().then((list) => {
      const t = Array.isArray(list)
        ? list.find((x) => x.source === "freestudy" && x.status !== "dismissed" && x.status !== "done")
        : undefined;
      if (t) {
        setTask(hydrateLocalThreads([t], userId)[0]);
        setSessionStart(new Date().toISOString());
      }
      // No active session → stay on the landing screen; Start is what creates one.
    }).catch(() => setLoadError(true));
  }, [userId]);

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
      setTask({ ...task, ...updated, chat, board: newBoard, problems: newProblems });
    } catch (e: any) {
      setError(e?.message || L("Otto n'a pas pu répondre — réessaie.", "Otto couldn't reply — try again."));
      setInput(message);
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
      setShowHistory(true);
    } finally {
      setEndingSession(false);
    }
  }, [task, sessionStart, saveAndClose]);

  const startNewSession = useCallback(async () => {
    setError(null);
    setWantVoice(true); // starting the session is the one tap that enables hands-free voice
    try {
      // The EXPLICIT create path — the only caller of /api/study/free in this component. Resume-first on
      // the server, so in the rare window where a session appeared between the mount peek and this click
      // it resumes that one instead of discarding it; otherwise it mints the fresh session the student
      // asked for.
      const list = await api.studyFreeSession();
      const t = Array.isArray(list) ? list.find((x) => x.source === "freestudy") : undefined;
      if (t) {
        setTask(hydrateLocalThreads([t], userId)[0]);
        setSessionStart(new Date().toISOString());
      }
    } catch {
      setError(L("Impossible de démarrer la séance", "Couldn't start the session"));
    }
  }, [userId, L]);

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

          <button className="btn primary tutor-start-btn" onClick={startNewSession}>
            {L("Commencer une séance", "Start a session")}
          </button>

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
          <TaskModal onClose={() => setOpenBoardSession(null)} title={L("Le tableau", "Board")}>
            <BoardArtifact task={{ board: openBoardSession.board } as unknown as WebTask} />
          </TaskModal>
        )}
        {openChatSession && (
          <TaskModal onClose={() => setOpenChatSession(null)} title={L("Le chat", "Chat")}>
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
            startInVoiceMode={wantVoice} bargeIn onVoiceStateChange={handleVoiceState}
          />
        </div>
      </section>
      <section className="tutor-board" aria-label={L("Tableau", "Board")}>
        <div className="tutor-pane-title">
          <span>{L("Le tableau", "Board")}</span>
          {/* Voice state lives on the BOARD pane: in voice-first mode this is the pane the student is
              actually looking at, so Listening…/Speaking…/Voice on must be visible here (a pill in the
              chat pane alone would sit unread next to an input nobody is typing in). */}
          {voiceState.voiceModeOn ? (
            <span className={`tutor-voice-pill${voiceState.speaking ? " speaking" : voiceState.listening ? " listening" : ""}`} role="status">
              {voiceState.speaking
                ? L("Otto parle…", "Otto is speaking…")
                : voiceState.listening
                  ? L("Je t'écoute…", "Listening…")
                  : L("Voix activée", "Voice on")}
              {voiceState.listening && voiceState.interim ? <span className="tutor-voice-interim">{voiceState.interim}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="tutor-board-body"><BoardArtifact task={task} /></div>
      </section>
    </main>
  );
}
