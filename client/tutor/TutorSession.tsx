import { useCallback, useEffect, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { hydrateLocalThreads, appendLocalChat, appendLocalBoard, appendLocalProblems, getLocalThread } from "../localChatBoard.ts";
import { useLang, TaskModal } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { BoardArtifact } from "../study/artifacts/BoardArtifact.tsx";
import { buildSessionSummary, saveTutorSession, getTutorSessions, type TutorSessionSummary } from "./tutorSessions.ts";

/** Tutor Session (route /tutor) — the Primer-style one-to-one lesson: a chat with Otto on one side and
 *  Otto's board on the other. It reuses the free-study task as a private anchor for the thread (chat, board
 *  and problems persist locally, keyed by task id — see localChatBoard.ts), and talks to the SAME chat
 *  endpoint as everywhere else, with `primer: true` so the server swaps in the Primer persona.
 *
 *  Sessions: each session is backed by its own freestudy task. Ending a session generates a short summary
 *  from the board + chat (see tutorSessions.ts), saves it locally, and dismisses the task so the next
 *  "Start" creates a fresh one. Past session summaries are shown in a collapsible strip and fed into the
 *  opening message so Otto can reference what was previously worked on. */
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
  const [selectedSubject, setSelectedSubject] = useState<string>("");

  const COMMON_SUBJECTS = [
    "Math", "Physics", "Chemistry", "Biology", "History",
    "English", "French", "Spanish", "Geography", "Economics",
    "Philosophy", "Computer Science", "Art", "Music", "Other"
  ];

  useEffect(() => {
    setPastSessions(getTutorSessions(userId));
  }, [userId]);

  const loadTask = useCallback(async (fresh = false) => {
    setLoadError(false);
    try {
      const list = await api.studyFreeSession(fresh, selectedSubject || undefined);
      // Find active session for the selected subject, or any if no subject selected
      const t = Array.isArray(list) ? list.find((x) => 
        x.source === "freestudy" && 
        x.status !== "dismissed" && 
        x.status !== "done" &&
        (selectedSubject ? x.sourceSubject === selectedSubject : true)
      ) : undefined;
      if (t) {
        setTask(hydrateLocalThreads([t], userId)[0]);
        setSessionStart(new Date().toISOString());
      } else {
        setTask(null);
        setSessionStart(null);
      }
    } catch {
      setLoadError(true);
    }
  }, [userId, selectedSubject]);

  // Auto-resume if there's an existing session for the selected subject
  useEffect(() => {
    if (selectedSubject) {
      api.studyFreeSession(false, selectedSubject).then((list) => {
        const existing = Array.isArray(list) ? list.find((x) => 
          x.source === "freestudy" && 
          x.status !== "dismissed" && 
          x.status !== "done" &&
          x.sourceSubject === selectedSubject
        ) : undefined;
        // Auto-resume if there's an existing session
        if (existing && !task) {
          setTask(hydrateLocalThreads([existing], userId)[0]);
          setSessionStart(new Date().toISOString());
        }
      }).catch(() => {});
    }
  }, [selectedSubject, task, userId]); // Re-check when task changes (session ended/started)

  // Auto-end session after 1 hour
  useEffect(() => {
    if (!sessionStart || !task) return;

    const timer = setInterval(() => {
      const elapsed = Date.now() - new Date(sessionStart).getTime();
      if (elapsed >= 60 * 60 * 1000) { // 1 hour
        // Directly dismiss and clear state without calling endSession to avoid circular dependency
        try { api.dismiss(task.id); } catch { /* best-effort */ }
        setTask(null);
        setSessionStart(null);
        setShowHistory(true);
      }
    }, 60 * 1000); // Check every minute

    return () => clearInterval(timer);
  }, [sessionStart, task]);

  const send = useCallback(async (override?: string, voiceMode?: boolean) => {
    const message = (override ?? input).trim();
    if (!message || sending || !task) return;
    setInput(""); setSending(true); setError(null); setPendingMsg(message);
    try {
      const { task: updated, chatDelta, board, problems } = await api.chat(task.id, message, task.chat || [], task.board || [], task.problems || [], undefined, undefined, voiceMode, undefined, true);
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
      const thread = getLocalThread(task.id, userId);
      const summary = buildSessionSummary(task.board || [], task.chat || []);
      const sessionSummary: TutorSessionSummary = {
        id: task.id,
        taskId: task.id,
        startTime: sessionStart,
        endTime: new Date().toISOString(),
        messageCount: (task.chat || []).filter((m) => m.role === "user").length,
        boardEntries: (task.board || []).map((b) => b.text.trim()).filter(Boolean),
        board: task.board || [],
        summary,
        subject: task.sourceSubject,
      };
      saveTutorSession(sessionSummary, userId);
      setPastSessions(getTutorSessions(userId));
      // Dismiss the freestudy task so the next "Start" creates a fresh one.
      try { await api.dismiss(task.id); } catch { /* best-effort */ }
      setTask(null);
      setSessionStart(null);
      setShowHistory(true);
    } finally {
      setEndingSession(false);
    }
  }, [task, sessionStart, userId]);

  const startNewSession = useCallback(async () => {
    // Always create a fresh session - never auto-resume
    setHasExistingSession(false); // Clear immediately to prevent race condition
    try {
      const list = await api.studyFreeSession(true, selectedSubject || undefined);
      const t = Array.isArray(list) ? list.find((x) => x.source === "freestudy") : undefined;
      if (t) {
        setTask(hydrateLocalThreads([t], userId)[0]);
        setSessionStart(new Date().toISOString());
      }
    } catch (e) {
      setError(L("Impossible de démarrer la séance", "Couldn't start the session"));
    }
  }, [selectedSubject, userId, L]);

  if (loadError) {
    return (
      <main className="list-wrap"><div className="empty-state">
        <h3>{L("Impossible de démarrer la séance", "Couldn't start the session")}</h3>
        <button className="btn primary" onClick={loadTask}>{L("Réessayer", "Try again")}</button>
      </div></main>
    );
  }

  // No active session — show start button + past sessions
  if (!task) {
    return (
      <main className="list-wrap tutor-landing">
        <div className="tutor-landing-inner">
          <div className="tutor-hero-kicker">{L("Le tutorat qui te rend autonome", "Tutoring that makes you independent")}</div>
          <h2>{L("Apprendre en réfléchissant", "Learn by thinking")}</h2>
          <p className="tutor-landing-sub">{L("Otto ne fait pas le travail à ta place. Il t'aide à essayer, à expliquer ton raisonnement et à transférer ce que tu apprends.", "Otto won't do the work for you. He helps you try, explain your reasoning, and transfer what you learn.")}</p>
          
          <div className="tutor-subject-select">
            <label htmlFor="subject-select">{L("Sur quoi veux-tu réfléchir ?", "What would you like to think about?")}</label>
            <select
              id="subject-select"
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
          
          {/* Show session or start button based on state */}
          {selectedSubject && (
            task ? (
              <div className="tutor-active-session-note">
                {L("Séance en cours", "Session in progress")}
              </div>
            ) : (
              <button className="btn primary tutor-start-btn" onClick={startNewSession}>
                {L("Commencer une séance", "Start a session")}
              </button>
            )
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
                      </div>
                      {/* Full board (diagrams/equations, not just the flattened text preview above) — only
                          present for a session ended after this was added; an older saved session has no
                          `board` field to reopen. */}
                      {!!s.board?.length && (
                        <button type="button" className="btn ghost xs tutor-history-view-board" onClick={() => setOpenBoardSession(s)}>
                          {L("Voir le tableau", "View board")}
                        </button>
                      )}
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
      </main>
    );
  }

  const noop = () => {};
  const fresh = !task.chat?.length && !pendingMsg;
  return (
    <main className="tutor-session">
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
            startInVoiceMode={false}
          />
        </div>
      </section>
      <section className="tutor-board" aria-label={L("Tableau", "Board")}>
        <div className="tutor-pane-title">{L("Le tableau", "Board")}</div>
        <div className="tutor-board-body"><BoardArtifact task={task} /></div>
      </section>
    </main>
  );
}
