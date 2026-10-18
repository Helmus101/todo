import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Maximize2, Minimize2, MessageSquare } from "lucide-react";
import type { WebTask, TaskProblem, BoardEntry } from "../../shared/types.ts";
import { api } from "../api.ts";
import { setLocalObjectives, getLocalThread, setLocalChat, setLocalBoard, setLocalProblems } from "../localChatBoard.ts";
import { useLang, LangContext } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { autoMathLine } from "../../shared/mathText.ts";
import { buildSessionRecap } from "../../shared/sessionRecap.ts";
import { BoardArtifact, MathText } from "../study/artifacts/BoardArtifact.tsx";
import { TutorDesmos } from "./TutorDesmos.tsx";
import { enterFullscreen, exitFullscreen, inFullscreen } from "./fullscreen.ts";
import { asksToLook } from "../../shared/lookRequest.ts";
import { hideToolLeaks } from "../../shared/toolLeak.ts";
import { TutorCanvas, type TutorCanvasHandle } from "./TutorCanvas.tsx";
import { PageTour } from "../PageTour.tsx";
import { TOURS } from "../tours.ts";
import { COMMON_SUBJECTS } from "../../shared/coursework.ts";
import { buildSessionSummary, saveTutorSession, getTutorSessions, sessionCardTitle, sessionCardDesc, sessionTopic, relativeWhen, sessionMemoryForPrompt, type TutorSessionSummary } from "./tutorSessions.ts";

// A dismiss that silently fails (a network blip, a momentary 429) used to just be swallowed — the session
// then never actually ends server-side and comes back as a "Reprendre?" ghost on every future visit
// (reported live). One retry after a short pause turns a transient blip into a real dismiss without making
// ending a session feel slow; a genuine, repeated failure still degrades gracefully (the ghost-cleanup in
// peekForActiveSession above is the backstop for whatever still slips through).
const ENDED_KEY = "otto.tutor.endedSessions";
const endedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(ENDED_KEY) || "[]"); } catch { return []; } };
const markEnded = (id: string) => { try { localStorage.setItem(ENDED_KEY, JSON.stringify([...new Set([...endedIds(), id])].slice(-40))); } catch { /* storage unavailable */ } };
const unmarkEnded = (id: string) => { try { localStorage.setItem(ENDED_KEY, JSON.stringify(endedIds().filter((x) => x !== id))); } catch { /* storage unavailable */ } };
/** Ends a session for good: remembered locally FIRST (so it can never come back as a "Resume?" ghost even if the network drops), then
 *  dismissed server-side with retries. Returns whether the server confirmed. */
async function dismissWithRetry(taskId: string): Promise<boolean> {
  markEnded(taskId);
  for (const wait of [0, 800, 2000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { await api.dismiss(taskId); unmarkEnded(taskId); return true; } catch { /* retry */ }
  }
  return false; // stays in the ended list; the next landing visit finishes the dismissal
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
/** Union by id, keeping every existing item (never drops one), ordered by time. Pure. */
/** A gap answered right: the line is completed in place with their answer ("… = ?" → "… = −3") and marked done. */
export function fillGap<T extends { text: string; status?: string }>(b: T, given: string): T {
  const v = (String(given || "").split("=").pop() || "").trim();
  return { ...b, status: "correct", ...(v ? { text: b.text.replace(/=\s*\?/, `= ${v}`) } : {}) };
}

export function mergeBoardById<T extends { id: string; at?: string; createdAt?: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((x) => x.id));
  const fresh = incoming.filter((x) => x && !seen.has(x.id));
  if (!fresh.length) return existing;
  const when = (x: T) => Date.parse(x.at || x.createdAt || "") || Number.MAX_SAFE_INTEGER;
  return [...existing, ...fresh].map((x, i) => ({ x, i })).sort((a, b) => when(a.x) - when(b.x) || a.i - b.i).map((o) => o.x);
}

/** The "[Exercise] I answered "…" — marked right (try #1)." line the app sends to Otto, shown to the student as their
 *  own answer with the maths typeset ("My answer: $…$ — ✓ right") instead of the raw bracketed message. */
export function friendlyExerciseText(text: string, en: boolean): string {
  const m = /^\s*\[(?:Exercise|Exercice)\]\s*(?:I answered|J'ai répondu)\s*["«]\s*([\s\S]*?)\s*["»]\s*—\s*([^\n(]*)/i.exec(text);
  if (!m) return hideToolLeaks(text);
  const verdict = /NOT graded|non not/i.test(m[2]) ? (en ? "not graded (the key was off)" : "non noté (la clé était fausse)") : /PARTLY|en partie/i.test(m[2]) ? (en ? "partly right" : "en partie juste") : /\bright\b|juste/i.test(m[2]) && !/wrong|faux/i.test(m[2]) ? (en ? "✓ right" : "✓ juste") : (en ? "✗ not yet" : "✗ pas encore");
  return `${en ? "My answer" : "Ma réponse"} : ${autoMathLine(m[1])} — ${verdict}`;
}

export function TutorSession({ userId, onExit, visionReady, sessionId, reviewView }: { userId: string | null; onExit: () => void; visionReady: boolean; sessionId?: string; reviewView?: string }) {
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
  // The stage hides the transcript on purpose, but it is always one tap away: this drawer.
  const [chatDrawer, setChatDrawer] = useState(false);
  // End-of-session reflection (IB "reflective"): before a real session closes, one optional question.
  const [reflectOpen, setReflectOpen] = useState(false);
  const [reflectText, setReflectText] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (chatDrawer) chatEndRef.current?.scrollIntoView({ block: "end" }); }, [chatDrawer, task?.chat?.length]);
  // The landing screen asks WHAT to study before starting — the subject is stamped onto the session
  // (sourceSubject, visible to the tutor prompt) and carried into history as the session's label.
  // The student's own subjects (set in onboarding) come first; the shared common list follows.
  const [mySubjects, setMySubjects] = useState<string[]>([]);
  useEffect(() => { void api.profile().then((p) => setMySubjects(p.subjects || [])).catch(() => { /* the common list is enough */ }); }, []);
  const subjectOptions = [...new Set<string>([...mySubjects, ...COMMON_SUBJECTS])];
  const [selectedSubject, setSelectedSubject] = useState("");
  // Only used when the subject is "Other": the student names it here. Every other subject starts with one tap, no extra question.
  const OTHER = "__other__";
  const [topic, setTopic] = useState("");
  const chosenSubject = selectedSubject === OTHER ? topic.trim() : selectedSubject;
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
      const ended = new Set(endedIds());
      if (Array.isArray(list)) for (const x of list) if (ended.has(x.id) && x.status !== "dismissed" && x.status !== "done") void dismissWithRetry(x.id);
      const t = Array.isArray(list)
        ? list.find((x) => x.source === "freestudy" && x.status !== "dismissed" && x.status !== "done" && !ended.has(x.id))
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

  // ── Session ↔ URL routing ─────────────────────────────────────────────────────────────
  /** Client-side route change — the same pushState + synthetic popstate App.tsx's `navigate` performs,
   *  duplicated here (two lines) so this component never imports App.tsx, which already imports IT. */
  const goRoute = useCallback((r: string) => {
    window.history.pushState({}, "", `/${r}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // The address bar follows the LIVE session: opening or resuming a session moves to
  // /tutor/session/<taskId> — so a refresh re-enters it (the task is cloud-persisted, so
  // peekForActiveSession offers Reprendre, and once the session is saved the same URL reopens it in
  // review) — and when the session ends the address falls back to the session list instead of pointing
  // at a dead id. Fires only on an id TRANSITION: a route change elsewhere (e.g. ending the session)
  // must not yank the address back onto the session.
  const routedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (task) {
      routedTaskRef.current = task.id;
      if (path.startsWith("tutor") && path !== `tutor/session/${task.id}`) goRoute(`tutor/session/${task.id}`);
    } else if (routedTaskRef.current) {
      routedTaskRef.current = null;
      if (path.startsWith("tutor/session/")) goRoute("tutor");
    }
  }, [task, goRoute]);

  const saveAndClose = useCallback((task: WebTask, startedAt: string, reflection?: string) => {
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
      ...(reflection?.trim() ? { reflection: reflection.trim().slice(0, 500) } : {}),
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
  // (Hooks live up here, above every early return below — a hook after one crashes the page with React #310 the
  // moment `task` goes from loading to loaded.)
  // OTTO'S FIRST LINE IS THE PLAIN TEMPLATE BELOW — no model round-trip. Direct ask: the automatic opening
  // shouldn't be complicated, "just use a template like we worked on supply and demand". So: one grounded
  // line built locally from sessionTopic (what the last session actually worked on), rendered instantly,
  // nothing that can fail — no openerAskedFor, no realOpener, no api.tutorOpener call. (server/claude.ts's
  // tutorOpener and its route stay untouched for API compatibility; they are simply no longer called.)
  // Same source of truth the interface itself reads (see LangContext) — the opener's language must match
  // the UI the student is looking at, not a second guess at it.
  const openerLang: "fr" | "en" = useContext(LangContext);
  const [exerciseDone, setExerciseDone] = useState(false);
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const [sheetSignal, setSheetSignal] = useState({ n: 0, height: 0 });
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const on = () => setFs(inFullscreen());
    document.addEventListener("fullscreenchange", on); document.addEventListener("webkitfullscreenchange", on);
    return () => { document.removeEventListener("fullscreenchange", on); document.removeEventListener("webkitfullscreenchange", on); exitFullscreen(); };
  }, []);
  // The session's focus objectives (SET_OBJECTIVES), opened from the ◎ chip in the crumb bar. Declared here
  // with every other hook — the stage view has an early return ABOVE, and a hook after it is exactly the
  // React #310 crash this file already had once (see the commit that fixed a hooks-after-early-return bug).
  const [objectivesOpen, setObjectivesOpen] = useState(false);
  // The board makes room for Otto's dock at its REAL height: the dock floats over the board and grows with a long
  // reply or the open chat history, which hid the newest board lines (reported). Its height goes into --dock-h (the
  // board's bottom padding + scroll padding), and if the student was reading the end of the board when the dock
  // grew, the board scrolls so that end stays visible above it.
  const stageRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dock = dockRef.current, stage = stageRef.current;
    if (!dock || !stage || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(dock.getBoundingClientRect().height);
      if (h === last) return;
      const grew = h > last;
      last = h;
      stage.style.setProperty("--dock-h", `${h}px`);
      const body = surfaceEl;
      if (grew && body && body.scrollHeight - body.scrollTop - body.clientHeight < h + 160) {
        requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }));
      }
    });
    ro.observe(dock);
    return () => ro.disconnect();
  }, [task?.id, surfaceEl]);
  useEffect(() => {
    if (!objectivesOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setObjectivesOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [objectivesOpen]);
  // A real lock (not render-time state): a typed Enter, a voice flush and the batched exercise result can all arrive in the same tick.
  const inflightRef = useRef(false);
  const send = useCallback(async (override?: string, voiceMode?: boolean, spoken?: { alternatives: string[] }) => {
    let message = (override ?? input).trim();
    const original = message; // what they typed (no appended ink notes), restored on failure
    if (!message || sending || inflightRef.current || !task) return;
    inflightRef.current = true;
    const isAutoResult = /^\[(?:Exercise|Exercice)\]/.test(message);
    if (!isAutoResult) setExerciseDone(false);
    else if (/\b(marked right|juste)\b/.test(message) && !/en partie juste|PARTLY right/i.test(message)) setExerciseDone(true);
    // An automatic exercise result must not wipe what they are in the middle of typing.
    if (override === undefined) setInput("");
    setSending(true); setError(null); setPendingMsg(message);
    try {
      // Anything new on the whiteboard rides along with the message — draw, then just say "is this right?"
      // like you would to a person leaning over your page; no separate "send drawing" step needed.
      // No "show Otto" button: saying "look at my whiteboard" is enough — and that also re-reads ink Otto has already seen.
      // A drawing made on the blank page below the board: keep room for it so Otto's next lines land AFTER it.
      const sheetH = canvasRef.current?.freezeSheet() || 0;
      if (sheetH > 0) setSheetSignal((s0) => ({ n: s0.n + 1, height: sheetH }));
      const wantsLook = !isAutoResult && asksToLook(message);
      const seen = await canvasRef.current?.readUnseenInk(wantsLook);
      if (seen) message += "\n\n" + L(`[Ce que j'ai écrit/dessiné sur le tableau : ${seen}]`, `[What I wrote/drew on the board: ${seen}]`);
      else if (wantsLook && !canvasRef.current?.hasInk()) message += "\n\n" + L("[Mon tableau est vide pour l'instant — je n'ai encore rien dessiné.]", "[My whiteboard is empty right now — I haven't drawn anything yet.]");
      // canvasMode: true — the Tutor UI has no way to OPEN a note/flashcard-deck/quiz artifact (onOpenNote/
      // onOpenDeck/onOpenQuiz are all no-ops below, since this screen is chat+board, not the task list's
      // artifact viewer). Without this flag the full tool set was still offered server-side, so the model
      // could (and did — reported live) create a whole flashcard deck here: a chip that does nothing when
      // tapped, AND a much heavier generation that's far more likely to exhaust the reply's token budget and
      // come back as a hard "Otto couldn't reply" with no message at all. canvasMode restricts the tutor to
      // CREATE_PROBLEM (individual, inline, answerable right on the board) instead — the only artifact this
      // screen actually knows how to show.
      const response = await api.chat(task.id, message, task.chat || [], task.board || [], (task.problems || []).map((p) => ({ ...p, solved: p.solved === true || solvedRef.current.has(p.id) })), undefined, undefined, voiceMode, true, true, task.objectives || [], spoken, { id: task.id, source: task.source, sourceSubject: task.sourceSubject, createdAt: task.createdAt }, sessionMemoryForPrompt(pastSessions, task.sourceSubject, Date.now(), openerLang));
      const { task: updated, objectives, board, problems } = response as typeof response & { board?: typeof task.board; problems?: typeof task.problems };
      // objectives is only ever the FULL replacement list (SET_OBJECTIVES' own contract), or undefined
      // when Otto didn't touch it this turn — never overwrite the existing list with an empty one.
      const newObjectives = objectives?.length ? setLocalObjectives(task.id, objectives, userId) : (task.objectives || []);
      // Otto just set/updated the session's objectives this turn — surface them, don't leave them behind a
      // chip the student has to notice and click. Report-live: objectives were being set but the student
      // never actually saw them. Doesn't force it open on every later turn, only right when they change.
      if (objectives?.length) { setObjectivesOpen(true); window.setTimeout(() => setObjectivesOpen(false), 3500); }
      // Direct request: Tutor session content is LOCAL ONLY now, not cloud-persisted — the server is
      // stateless for this turn's chat/board/problems (`updated` no longer carries them at all; the
      // top-level `board`/`problems`/`chatDelta` are just THIS turn's delta). Merge them onto what's
      // already on screen exactly as before, then persist the merged result to this browser's own
      // storage (client/localChatBoard.ts) — that's the one copy of record now, there's no cloud copy to
      // fall back on. NEVER let a turn's delta replace what's already on screen outright: its own arrays
      // are capped and can lag behind this device, so taking it wholesale would wipe older board entries.
      // The board only grows: this turn's entries are added to what's on screen — never cleared, removed or overwritten.
      const closedRaw = (response as unknown as { gapsClosed?: unknown }).gapsClosed;
      const gapsClosed = new Map((Array.isArray(closedRaw) ? closedRaw : []).filter((x: any) => x && typeof x.id === "string").map((x: any) => [x.id as string, String(x.given || "")]));
      const newBoard = mergeBoardById(task.board || [], board || []).map((b) => (gapsClosed.has(b.id) ? fillGap(b, gapsClosed.get(b.id)!) : b));
      const solvedRaw = (response as unknown as { solvedInChat?: unknown }).solvedInChat;
      const solvedInChat: string[] = Array.isArray(solvedRaw) ? solvedRaw.filter((x): x is string => typeof x === "string") : [];
      for (const id of solvedInChat) solvedRef.current.add(id);
      const newProblems = mergeBoardById(task.problems || [], problems || []).map((p) => (solvedInChat.includes(p.id) ? { ...p, solved: true } : p));
      if ((task.board || []).length && JSON.stringify(task.board) !== JSON.stringify(newBoard)) {
        boardHistoryRef.current = [...boardHistoryRef.current, { taskId: task.id, board: task.board || [] }].slice(-20);
        setUndoCount(boardHistoryRef.current.length);
      }
      setLocalBoard(task.id, newBoard, userId);
      setLocalProblems(task.id, newProblems, userId);
      // The MERGED thread (what's on screen + this turn's delta), not just the delta: the local store is the
      // only copy now, and for a session this browser has no local history for yet (one resumed from the
      // cloud era) appending the delta alone would return the delta by itself — visibly cutting the
      // conversation down to the newest message the moment the student replies.
      const newChat = setLocalChat(task.id, [...(task.chat || []), ...(response.chatDelta || [])], userId);
      setTask({
        ...task,
        ...updated,
        board: newBoard,
        problems: newProblems,
        chat: newChat,
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
          board: mergeBoardById(task.board || [], errorData.task?.board || errorData.board || []),
          problems: mergeBoardById(task.problems || [], errorData.task?.problems || errorData.problems || []),
          chat: task.chat || [],
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
        setError(e?.status != null ? e.message : L("J'ai perdu le fil. Redis-le ?", "I lost the thread. Say that again?"));
        if (override === undefined) setInput(original); // never the app's own "[Exercice] …" text, never the appended ink note
      }
    } finally {
      inflightRef.current = false;
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
  // Problems the student has answered correctly — sent with every turn so the tutor never piles a new exercise on an unanswered one.
  const solvedRef = useRef<Set<string>>(new Set());
  // Spec §12 #10 / test 31: board edits stay recoverable — the board as it stood before each turn that changed it.
  const boardHistoryRef = useRef<{ taskId: string; board: NonNullable<WebTask["board"]> }[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const undoBoard = useCallback(() => {
    const prev = boardHistoryRef.current.pop();
    if (!prev || !task || prev.taskId !== task.id) { setUndoCount(boardHistoryRef.current.length); return; }
    setLocalBoard(task.id, prev.board, userId);
    setTask((t) => (t && t.id === prev.taskId ? { ...t, board: prev.board } : t));
    setUndoCount(boardHistoryRef.current.length);
  }, [task, userId]);
  const sendRef = useRef(send);
  sendRef.current = send;
  const onProblemResult = useCallback((r: { problem: TaskProblem; given: string; correct: boolean; attempt: number; systemError?: boolean; partial?: boolean }) => {
    if (r.correct) {
      solvedRef.current.add(r.problem.id);
      // Saved as solved right away, so a reload or "Reprendre" doesn't bring it back as open.
      setTask((cur) => { if (!cur) return cur; const problems = (cur.problems || []).map((p) => (p.id === r.problem.id ? { ...p, solved: true } : p)); setLocalProblems(cur.id, problems, userId); return { ...cur, problems }; });
    }
    // A system-error result (the item's stored key disagreed with the independently computed value, spec §19.1)
    // is reported AS that, not as a miss: Otto must never treat it as evidence against the student.
    resultsRef.current.push(L(
      `[Exercice] J'ai répondu « ${r.given.slice(0, 120)} » — ${r.systemError ? "non noté : la clé du problème contredit la valeur vérifiée par le calcul" : r.correct ? "juste" : r.partial ? "en partie juste (une idée clé manque)" : "faux"} (essai n°${r.attempt}).`,
      r.systemError
        ? `[Exercise] I answered "${r.given.slice(0, 120)}" — NOT graded: this problem's stored answer key contradicts the independently computed value (try #${r.attempt}).`
        : r.partial
          ? `[Exercise] I answered "${r.given.slice(0, 120)}" — PARTLY right: some of the key ideas, one still missing (try #${r.attempt}). Credit what's right, then ask for the missing piece.`
          : `[Exercise] I answered "${r.given.slice(0, 120)}" — marked ${r.correct ? "right" : "wrong"} (try #${r.attempt}).`));
    setResultTick((n) => n + 1);
  }, [L]);
  // A board gap answered in place: graded by the server, then reported to Otto like an exercise result (the
  // verdict rides along; Otto reacts to it like a person would, never reveals the key on a miss).
  const reportedGapsRef = useRef(new Set<string>());
  const onGapCheck = useCallback(async (entry: BoardEntry, given: string) => {
    if (!task) return "unknown" as const;
    // The board lives in this browser now, so the line (and the key written with it) ride along: the server
    // has no stored copy to look the gap up in for a tutor session. It still recomputes the key from the line
    // itself first, and only falls back to what it's sent.
    const { verdict, display } = await api.checkGap(task.id, entry.id, given, { text: entry.text, expectedAnswer: entry.expectedAnswer });
    // The line is completed with the VERIFIED value from the server, never with what they typed.
    if (verdict === "correct") setTask((cur) => { if (!cur) return cur; const board = (cur.board || []).map((b) => (b.id === entry.id ? fillGap(b, display || "") : b)); setLocalBoard(cur.id, board, userId); return { ...cur, board }; });
    const line = entry.text.replace(/\s+/g, " ").slice(0, 100);
    // The same answer to the same line is reported once (a second click, or the line re-rendered with different
    // spacing, used to send Otto the identical result twice — and get two identical replies back).
    const key = `${entry.text}|${given}`.replace(/\s+/g, "").toLowerCase();
    if (reportedGapsRef.current.has(key)) return verdict;
    reportedGapsRef.current.add(key);
    resultsRef.current.push(L(
      `[Exercice] Au tableau, pour « ${line} », j'ai écrit « ${given.slice(0, 120)} » — ${verdict === "correct" ? "vérifié juste" : verdict === "system_error" ? "non noté : la clé écrite pour cette ligne contredit la clé recalculée par le code" : verdict === "incorrect" ? "vérifié faux" : "non vérifiable automatiquement"}.`,
      verdict === "system_error"
        ? `[Exercise] On the board line "${line}" I wrote "${given.slice(0, 120)}" — NOT graded: the key stored for this line contradicts the key computed from the line itself. Say plainly that the app's key was wrong, not me, and continue.`
        : `[Exercise] On the board line "${line}" I wrote "${given.slice(0, 120)}" — ${verdict === "correct" ? "checked right" : verdict === "incorrect" ? "checked wrong" : "couldn't be auto-checked"}.`));
    setResultTick((n) => n + 1);
    return verdict;
  }, [task, L]);
  const onWidgetResult = useCallback((r: { type: string; caption: string; mistakes: number; total: number }) => {
    resultsRef.current.push(L(
      `[Activité] J'ai terminé « ${r.caption.slice(0, 80)} » (${r.type}) — ${r.mistakes === 0 ? "sans erreur" : `${r.mistakes} erreur${r.mistakes > 1 ? "s" : ""}`}.`,
      `[Activity] I finished "${r.caption.slice(0, 80)}" (${r.type}) — ${r.mistakes === 0 ? "no slips" : `${r.mistakes} slip${r.mistakes > 1 ? "s" : ""}`}.`));
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

  const endSession = useCallback(async (reflection?: string) => {
    if (!task || endingSession) return;
    setEndingSession(true);
    try {
      // Ending must ALWAYS end: a failure while saving the history summary (storage full, an odd board entry)
      // or while dismissing the task server-side must never leave the student stuck on a button that does
      // nothing. Every step is best-effort; the screen is left no matter what.
      try { saveAndClose(task, sessionStart || task.createdAt || new Date().toISOString(), reflection); } catch (e) { console.warn("[tutor] couldn't save the session summary:", e); }
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
    enterFullscreen(); // tutor mode is full screen (this click is the user gesture the browser requires)
    // This browser is the record of truth for the session's content: the server no longer writes chat/board/
    // problems/objectives at all, so `pendingActiveSession` (a list-route row, which carries none of them)
    // comes back EMPTY for a session that is already underway — reading it first is what makes "Reprendre"
    // open a blank thread. getLocalThread is the real copy; the task's own fields are the fallback, for a
    // conversation that predates the local switch and hasn't been carried into storage yet.
    const local = getLocalThread(pendingActiveSession.id, userId);
    const chat = local.chat.length ? local.chat : (pendingActiveSession.chat || []);
    const board = local.board.length ? local.board : (pendingActiveSession.board || []);
    const problems = local.problems.length ? local.problems : (pendingActiveSession.problems || []);
    const objectives = local.objectives.length ? local.objectives : (pendingActiveSession.objectives || []);
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
    if (!chosenSubject || startingSession) return;
    enterFullscreen(); // tutor mode is full screen (this click is the user gesture the browser requires)
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
      const list = await api.studyFreeSession(true, chosenSubject);
      const t = Array.isArray(list)
        ? [...list].reverse().find((x) => x.source === "freestudy" && x.status !== "dismissed" && x.status !== "done")
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
      setError(L("La séance n'a pas démarré. Relance.", "The session didn't start. Try again."));
    } finally {
      setStartingSession(false);
    }
  }, [chosenSubject, startingSession, pendingActiveSession, sessionStart, saveAndClose, userId, L]);


  // FULL-PAGE review of a past session (/tutor/session/<id>/board|chat) — one whole page with exactly two
  // choices: see the board or read the chat (report-live: "viewing session and board from past should show
  // in whole page and only have see board or chat, not session"). Derived from the route itself, no modal
  // state: the URL IS the view, so refresh, back/forward and shared links all land in the right place and
  // nothing stacks over the landing. (The URL-sync effect above never fires here: routedTaskRef is only
  // set once a LIVE task exists, so a review URL is never yanked back to /tutor.)
  // A LIVE session is never shown as a review: its own summary is auto-saved under the same id (= the task id) as soon as there is
  // something to keep, so without `!task` the first message flipped the live page into this read-only board/chat viewer.
  const reviewSession = !task && sessionId && userId ? getTutorSessions(userId).find((s) => s.id === sessionId) : undefined;
  if (reviewSession) {
    const view: "board" | "chat" = reviewView === "chat" ? "chat" : "board";
    const hasBoard = !!reviewSession.board?.length;
    const hasChat = !!reviewSession.chat?.length;
    const base = `/tutor/session/${reviewSession.id}`;
    const dateStr = new Date(reviewSession.endTime).toLocaleDateString(L("fr-FR", "en-US"), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return (
      <main className="list-wrap tutor-review">
        <a href="/tutor" className="tutor-back-btn">← {L("Toutes les séances", "All sessions")}</a>
        <div className="tutor-review-head">
          <span className="tutor-review-subject">{reviewSession.subject || L("Séance passée", "Past session")}</span>
          <span className="tutor-review-meta">{dateStr} · {reviewSession.messageCount} {L("messages", "messages")}</span>
        </div>
        <div className="tutor-review-tabs">
          {hasBoard && (
            <a className={`tutor-review-tab${view === "board" ? " on" : ""}`} href={`${base}/board`} aria-current={view === "board" ? "page" : undefined}>
              {L("Voir le tableau", "See the board")}
            </a>
          )}
          {hasChat && (
            <a className={`tutor-review-tab${view === "chat" ? " on" : ""}`} href={`${base}/chat`} aria-current={view === "chat" ? "page" : undefined}>
              {L("Voir le chat", "See the chat")}
            </a>
          )}
        </div>
        <div className="tutor-review-body">
          {!hasBoard && !hasChat ? (
            <p className="tutor-review-empty">{L("Rien à revoir ici — cette séance n'a ni tableau ni chat sauvegardés.", "Nothing to review — this session has no saved board or chat.")}</p>
          ) : view === "board" ? (
            hasBoard ? <BoardArtifact task={{ board: reviewSession.board } as unknown as WebTask} /> : <p className="tutor-review-empty">{L("Pas de tableau pour cette séance.", "No board for this session.")}</p>
          ) : hasChat ? (
            <div className="tutor-chat-history">
              {reviewSession.chat!.map((msg, i) => (
                <div key={i} className={`tutor-chat-message ${msg.role}`}>
                  <div className="tutor-chat-role">{msg.role === "user" ? L("Toi", "You") : L("Otto", "Otto")}</div>
                  <div className="tutor-chat-text"><MathText text={friendlyExerciseText(msg.text, L("fr", "en") === "en")} /></div>
                </div>
              ))}
            </div>
          ) : (
            <p className="tutor-review-empty">{L("Pas de chat pour cette séance.", "No chat for this session.")}</p>
          )}
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="list-wrap"><div className="empty-state">
        <h3>{L("La séance n'a pas démarré. Relance.", "The session didn't start. Try again.")}</h3>
        <button className="btn primary" onClick={() => { mountFetchStartedRef.current = false; peekForActiveSession(); }}>{L("Réessayer", "Try again")}</button>
      </div></main>
    );
  }


  // No active session — the landing screen: start button + past sessions.
  if (!task) {
    return (
      <main className="list-wrap tutor-landing">
        <PageTour id="tutor-landing" steps={TOURS["tutor-landing"]} />
        <div className="tutor-landing-inner">
          {/* The prototype's cream-circle face — two dots, no mouth. The one illustration the whole
              design system allows, reused on the landing and the session screens. */}
          <div className="tutor-face" aria-hidden><span className="tutor-face-eye" /><span className="tutor-face-eye" /></div>
          <h2 className="tutor-landing-title">{L("Je suis Otto, ton partenaire de réflexion.", "I'm Otto, your thinking partner.")}</h2>
          <p className="tutor-landing-sub">{L("Qu'est-ce qu'on aiguise aujourd'hui ? Je ne te donnerai pas les réponses — je te ferai les trouver.", "What are we sharpening today? I won't hand you answers — I'll make you find them.")}</p>

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
              onChange={(e) => { setSelectedSubject(e.target.value); setTopic(""); }}
              className="tutor-start-select"
              aria-label={L("Matière", "Subject")}
            >
              <option value="">{L("Choisir une matière", "Choose a subject")}</option>
              {subjectOptions.map((subj) => (
                <option key={subj} value={subj}>{subj}</option>
              ))}
              <option value={OTHER}>{L("Autre…", "Other…")}</option>
            </select>
            <button
              className="btn primary tutor-start-btn"
              onClick={() => void startNewSession()}
              disabled={startingSession || !chosenSubject}
            >
              {startingSession
                ? L("Démarrage…", "Starting…")
                : L("On s'y met", "Let's work")}
            </button>
          </div>

          {selectedSubject === OTHER && (
            <div className="tutor-topic">
              <input
                id="tutor-topic-input"
                className="tutor-topic-input"
                value={topic}
                maxLength={80}
                autoFocus
                aria-label={L("Quelle matière ?", "Which subject?")}
                placeholder={L("Quelle matière ? ex. Théorie de la connaissance, Latin…", "Which subject? e.g. Theory of Knowledge, Latin…")}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && topic.trim()) void startNewSession(); }}
              />
            </div>
          )}

          {/* Direct request: sessions are stored only in this browser now (client/localChatBoard.ts +
              tutorSessions.ts), so say so plainly — clearing site data is the one way to lose them. */}
          <p className="tutor-local-note" role="note">
            {L("Tes séances sont enregistrées uniquement dans ce navigateur, pas dans le cloud. Ne supprime pas les cookies ni les données de ce site (et évite la navigation privée), sinon elles seront effacées. Elles ne te suivent pas sur un autre appareil.",
              "Your sessions are saved only in this browser, not in the cloud. Don't clear cookies or this site's data (and avoid private browsing), or they'll be erased. They won't follow you to another device.")}
          </p>

          {pastSessions.length > 0 && (
            <div className="tutor-past-sessions">
              <button className="tutor-history-toggle" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}{L("Nos séances passées", "Our past sessions")} ({pastSessions.length})
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
                        {/* ONE title (the main thing) + ONE short description — report-live: the card used to
                            dump the summary AND the first three board lines, the same wall twice. Both
                            helpers live beside sessionTopic in tutorSessions.ts. */}
                        <div className="tutor-history-topic">
                          {s.subject && <span className="tutor-history-subject-pill">{s.subject}</span>}
                          {sessionCardTitle(s) && <span className="tutor-history-title"><MathText text={sessionCardTitle(s)} /></span>}
                        </div>
                        {sessionCardDesc(s) && <p className="tutor-history-desc"><MathText text={sessionCardDesc(s)} /></p>}
                      </div>
                      {/* TWO choices only, both FULL PAGES (/tutor/session/<id>/board|chat) — report-live:
                          "viewing session and board from past should show in whole page and only have see
                          board or chat, not session". No vague "View session" entry, no modals stacked over
                          the landing; an older saved session may have no `board` field to reopen. */}
                      <div className="tutor-history-actions">
                        {!!s.board?.length && (
                          <a href={`/tutor/session/${s.id}/board`} className="btn ghost xs tutor-history-view-board">
                            {L("Voir le tableau", "See the board")}
                          </a>
                        )}
                        {!!s.chat?.length && (
                          <a href={`/tutor/session/${s.id}/chat`} className="btn ghost xs tutor-history-view-chat">
                            {L("Voir le chat", "See the chat")}
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </main>
    );
  }

  const noop = () => {};
  const fresh = !task.chat?.length && !pendingMsg;
  const objDone = task.objectives?.filter((o) => o.done).length ?? 0;
  // Otto's opening line — one local template, no model call (see the opener note above). When this
  // subject has a past session it is a retrieval question about what was ACTUALLY worked on, named with the
  // topic sessionTopic picked out of that session's real board (never a board caption like "The equation to
  // work with", which is what used to get quoted back here and made the line read as a placeholder);
  // otherwise a plain, specific invitation. One-tap starters follow.
  const lastSame = pastSessions.find((s) => s.subject && s.subject === task.sourceSubject && sessionTopic(s));
  const lastTopic = lastSame ? sessionTopic(lastSame) : "";
  const lastWhen = lastSame ? relativeWhen(lastSame.endTime, Date.now(), openerLang) : "";
  const subj = task.sourceSubject;
  // ONE time reference only: the old template stacked a fixed lead on top of relativeWhen's stamp and read
  // as machine-stitched — reported live as 'Hey! Last time, earlier today, we worked on "…"'. Lead with the
  // stamp itself ("Earlier today we worked on…" / "Hier, on a bossé sur…"); "Last time" is only the
  // fallback when the stamp is unknown.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const leadFr = lastWhen ? `${cap(lastWhen)}, on` : "La dernière fois, on";
  const leadEn = lastWhen ? `${cap(lastWhen)} we` : "Last time we";
  const instantOpener = lastTopic
    ? L(`Salut ! ${leadFr} a bossé sur « ${lastTopic} ». Qu'est-ce que tu en retiens ?`,
        `Hey! ${leadEn} worked on "${lastTopic}". What do you still remember?`)
    : subj
      ? L(`Salut ! Montre-moi où tu en es en ${subj} : un énoncé, ou ce que tu as essayé.`, `Hey! Show me where you are in ${subj}: the problem, or what you've tried.`)
      : L("Salut ! Montre-moi où tu en es : un énoncé, ou ce que tu as essayé.", "Hey! Show me where you are: the problem, or what you've tried.");
  const openerText = instantOpener;
  const starters = [
    { label: L("Je bloque sur un exercice", "I'm stuck — push me"), text: L("Je bloque sur un exercice.", "I'm stuck on a problem.") },
    { label: L("Fais-moi comprendre un cours", "Make me understand a topic"), text: L("J'aimerais comprendre un chapitre.", "I'd like to understand a topic.") },
    { label: L("Interroge-moi", "Test me"), text: L("Interroge-moi pour voir ce que je sais.", "Quiz me to see what I know.") },
  ];
  // Right after the student has completed an exercise: offer the next move as one-tap choices (Otto also asks
  // what they'd like to do — see the persona's EXERCISE RESULTS rule) instead of leaving them at a bare "solved".
  const justFinishedExercise = exerciseDone;
  // Real lucide icons instead of emoji, same convention VoiceControls established: an emoji chip renders
  // differently (or not at all) per OS/browser and reads ambiguous at a glance (explicit request: no emoji
  // in the app). The icon is decorative — the label text carries the meaning.
  const ic = { size: 14, "aria-hidden": true } as const;
  // Hick's law: never more than three one-tap choices at a time (anything else, they can simply type).
  const nextChips = [
    { label: L("Un autre", "Another one"), text: L("J'en veux un autre comme celui-là.", "Another one like it, please.") },
    { label: L("Plus dur", "Harder"), text: L("Donne-m'en un plus difficile.", "Give me a harder one.") },
    { label: L("Revoir l'idée", "Go over the idea"), text: L("Reprenons l'idée derrière cet exercice.", "Let's go back over the idea behind that one.") },
  ];
  const followUps = [
    { label: L("Un indice", "Hint"), text: L("Tu peux me donner un petit indice ?", "Can I have a small hint?") },
    { label: L("Je suis perdu", "I'm lost"), text: L("Je suis perdu — on peut y aller plus doucement ?", "I'm lost — can we go smaller?") },
    { label: L("Un autre", "Another one"), text: L("Compris ! Donne-m'en un autre à essayer.", "Got it! Give me another to try.") },
  ];
  // Gauth-style stage: ONE big canvas (Otto's lesson board with the student's ink over it) and Otto himself
  // as just an avatar docked at the bottom — no transcript. The student talks (or types) to the avatar and
  // sees only Otto's latest answer; everything worth keeping lands on the board instead of scrolling away
  // in a chat log. The full conversation is still saved with the session for the history view.
  return (
    <main ref={stageRef} className={`tutor-stage${voiceState.voiceModeOn ? " voice-on" : ""}`}>
      <PageTour id="tutor-session" steps={TOURS["tutor-session"]} />
      {/* Same breadcrumb chrome as the rest of the Tutor, minus "All sessions" — report-live: an active
          session shouldn't offer a way back to the list, just the subject chip and End session. */}
      {/* ONE bar: subject, where we are in the plan (click for the checklist), full screen, end. Reported: two stacked
          bars plus a chip was too much chrome above the board. */}
      {(() => {
        const objs = task.objectives || [];
        const current = objs.find((o) => !o.done);
        return (
          <>
            <header className="ts-bar tutor-crumbbar">
              {task.sourceSubject ? <span className="tutor-crumb-subject">{task.sourceSubject}</span> : null}
              {objs.length ? (
                <button type="button" className="ts-objstrip-line ts-bar-plan" aria-expanded={objectivesOpen} aria-controls="ts-objectives" onClick={() => setObjectivesOpen((o) => !o)}
                  title={objectivesOpen ? L("Masquer le plan", "Hide the plan") : L("Voir le plan de la séance", "See this session's plan")}>
                  <span className="ts-objstrip-label">{current ? <MathText text={current.label} /> : L("Plan terminé", "Plan done")}</span>
                  <span className="ts-objstrip-dots" aria-label={`${objDone}/${objs.length}`}>
                    {objs.map((o, i) => <i key={o.id || i} className={o.done ? "done" : o === current ? "current" : undefined} />)}
                  </span>
                  {typeof task.mastery === "number" ? <span className="ts-bar-mastery">{Math.round(task.mastery * 100)}%</span> : null}
                </button>
              ) : null}
              <button type="button" className="tutor-fs-btn" onClick={() => (fs ? exitFullscreen() : enterFullscreen())} aria-pressed={fs} aria-label={fs ? L("Quitter le plein écran", "Exit full screen") : L("Plein écran", "Full screen")} title={fs ? L("Quitter le plein écran", "Exit full screen") : L("Plein écran", "Full screen")}>
                {fs ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
              </button>
              <button className="btn ghost tutor-end-btn" disabled={endingSession} onClick={() => { const real = (task.chat || []).filter((m) => m.role === "user").length >= 3; if (real) setReflectOpen(true); else void endSession(); }}>
                {endingSession ? L("Fin…", "Ending…") : L("Terminer", "End")}
              </button>
            </header>
            {objs.length && objectivesOpen ? (
              <ol className="ts-objstrip-list ts-plan-list" id="ts-objectives" aria-label={L("Plan de la séance", "Session plan")}>
                {objs.map((o, i) => (
                  <li key={o.id || `${i}:${o.label}`} className={o.done ? "done" : o === current ? "current" : undefined}>
                    <span className="ts-obj-mark" aria-hidden="true">{o.done ? "✓" : o === current ? "●" : "○"}</span>
                    <span className="ts-obj-label"><MathText text={o.label} /></span>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        );
      })()}
      <section className="ts-canvas" aria-label={L("Tableau", "Board")}>
        <div className="tutor-board-body ts-board-body" ref={setSurfaceEl} style={{ display: desmosOpen ? "none" : undefined }}>
          <BoardArtifact task={task} onUndo={undoCount > 0 ? undoBoard : undefined} writing={sending} onProblemResult={onProblemResult} onWidgetResult={onWidgetResult} sheetSignal={sheetSignal} onGapCheck={onGapCheck} />
        </div>
        {/* Desmos stays mounted once opened (an iframe that's removed reloads blank, losing the student's graph). */}
        {desmosOpen || desmosEverOpenedRef.current ? (
          <div style={{ display: desmosOpen ? "contents" : "none" }}>
            <TutorDesmos onClose={() => setDesmosOpen(false)} />
          </div>
        ) : null}
        <TutorCanvas
          ref={canvasRef}
          contextText={[...(task.problems || []).filter((p) => !p.solved).slice(-1).map((p) => p.question), ...(task.board || []).filter((b) => b.kind !== "annotation" && b.text).slice(-6).map((b) => b.text)].join(" | ").slice(0, 700)}
          visionReady={visionReady}
          hidden={desmosOpen}
          surface={surfaceEl}
          onDesmos={() => setDesmosOpen((o) => !o)}
        />
      </section>
      <div className="ts-dock" ref={dockRef}>
        {/* The dock IS the chat (the floating island) — this is just its expand/collapse control, not a
            separate "chat" entry point (report-live: it isn't a dedicated chat button, just an expand
            button on the island where the answers already show). No past-sessions section either:
            in-session shows the CURRENT transcript only. */}
        <button
          type="button"
          className="tutor-dock-chat-toggle"
          data-tour="ts-chat"
          aria-expanded={chatDrawer}
          aria-label={L("Historique de la conversation", "Conversation history")}
          title={chatDrawer ? L("Masquer l'historique", "Hide history") : L("Afficher l'historique", "Show history")}
          onClick={() => setChatDrawer((v) => !v)}
        >
          <MessageSquare size={13} aria-hidden="true" />
          <span className="tutor-dock-chat-toggle-label">{L("Historique", "History")}</span>
          {task.chat?.length ? <span className="tutor-dock-chat-toggle-count">{task.chat.length}</span> : null}
          <ChevronDown size={13} aria-hidden="true" className="tutor-dock-chat-toggle-chev" />
        </button>
        {chatDrawer && (
          <div className="tutor-dock-chat">
            <div className="tutor-dock-chat-head">
              <span>{task.chat?.length || 0} {L("messages", "messages")}</span>
              <button type="button" className="tutor-dock-chat-close" onClick={() => setChatDrawer(false)} aria-label={L("Réduire l'historique", "Collapse history")}><Minimize2 size={13} aria-hidden="true" />{L("Réduire", "Collapse")}</button>
            </div>
            <div className="tutor-chat-history">
              {!task.chat?.length && <p className="tutor-chat-empty">{L("Rien encore — dis bonjour à Otto.", "Nothing yet — say hi to Otto.")}</p>}
              {/* Otto's latest reply is already in the bubble right below — listing it here too showed it twice. */}
              {(task.chat || []).slice(0, task.chat?.length && task.chat[task.chat.length - 1].role === "assistant" ? -1 : undefined).map((msg, i) => (
                <div key={i} className={`tutor-chat-message ${msg.role}`}>
                  <div className="tutor-chat-role">{msg.role === "user" ? L("Toi", "You") : "Otto"}</div>
                  <div className="tutor-chat-text"><MathText text={friendlyExerciseText(msg.text, L("fr", "en") === "en")} /></div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>
        )}
        <AskOttoPanel
          variant="dock"
          task={task} currentStep={undefined} input={input} setInput={setInput} sending={sending}
          error={error} pendingMsg={pendingMsg} onSend={(o, v, _canvas, sp) => void send(o, v, sp)}
          onOpenNote={noop} onOpenDeck={noop} onOpenQuiz={noop}
          emptyText={openerText}
          quickReplies={fresh ? starters : justFinishedExercise ? nextChips : followUps}
          placeholder={L("Parle ou écris à Otto…", "Talk or type to Otto…")}
          onVoiceStateChange={handleVoiceState}
        />
      </div>
      {reflectOpen && (
        <div className="tutor-reflect-overlay" role="dialog" aria-modal="true" aria-label={L("Avant de partir", "Before you go")} onClick={() => setReflectOpen(false)}>
          <div className="tutor-reflect" onClick={(e) => e.stopPropagation()}>
            <h3>{L("Avant de partir", "Before you go")}</h3>
            {(() => {
              const en = L("fr", "en") === "en";
              const r = buildSessionRecap(task.board || [], task.problems || [], task.objectives || [], en);
              if (!r.showed.length && !r.developing.length && !r.strategies.length && !r.reviewQuestion) return null;
              return (
                <div className="tutor-recap">
                  {r.showed.length > 0 && <section><h4>{L("Tu as montré", "You showed")}</h4><ul>{r.showed.map((x, i) => <li key={i}><MathText text={x} /></li>)}</ul></section>}
                  {r.developing.length > 0 && <section><h4>{L("À retravailler", "Still developing")}</h4><ul>{r.developing.map((x, i) => <li key={i}><MathText text={x} /></li>)}</ul></section>}
                  {r.strategies.length > 0 && <section><h4>{L("Tes méthodes", "Your strategies")}</h4><ul>{r.strategies.map((x, i) => <li key={i}><MathText text={x} /></li>)}</ul></section>}
                  {r.reviewQuestion && <p className="tutor-recap-review"><MathText text={r.reviewQuestion} /></p>}
                </div>
              );
            })()}
            <p>{L("Qu'est-ce qui t'a fait « tilt » aujourd'hui, et qu'est-ce que tu ferais différemment la prochaine fois ?", "What's one thing that clicked today, and what would you do differently next time?")}</p>
            <textarea className="tutor-reflect-input" rows={4} autoFocus value={reflectText} onChange={(e) => setReflectText(e.target.value)} placeholder={L("Écris quelques mots… (facultatif)", "A few words… (optional)")} aria-label={L("Écris quelques mots… (facultatif)", "A few words… (optional)")} />
            <div className="tutor-reflect-actions">
              <button type="button" className="btn ghost" onClick={() => { setReflectOpen(false); void endSession(""); }}>{L("Passer", "Skip")}</button>
              <button type="button" className="btn primary" onClick={() => { setReflectOpen(false); void endSession(reflectText); }}>{L("Enregistrer et terminer", "Save & end")}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
