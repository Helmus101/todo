/**
 * The task surface, in two pieces:
 *   - `TaskCardRow`  — the collapsed row in the dashboard list. Title, one sub-line, at most one chip.
 *   - `TaskFocus`    — what opens in the modal. Answers ONE question: what do I do right now?
 *
 * `TaskFocus` is built as hero + quiet accordion rather than the old six-stacked-sections detail view: the
 * current step is the only thing competing for attention, and everything else (all steps, artifacts,
 * context) collapses to a counted one-line row. The shape deliberately echoes FlashcardDeck/QuizPlayer in
 * ui.tsx — progress bar, one big thing, one primary button — because that's a pattern the student has
 * already met inside this app, so there's nothing new to learn.
 */
import { useEffect, useState, useRef, useContext, type ReactNode, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { WebTask, TaskStep } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight } from "../shared/types.ts";
import { api } from "./api.ts";
import {
  LangContext, useLang, todayIso, fmtDate, relTime, statusChip, sourceBadge, subtitle,
  fmtWhen, TAB_GROUP, openTab, openTabs, autoOpenTaskDocs,
  withInlineLinks, renderNoteBody, renderChatText, FlashcardDeck, QuizPlayer, TaskModal,
} from "./ui.tsx";

/**
 * The leave animation + API call for finishing or dismissing a task. Extracted so the collapsed row and the
 * open task view can share ONE implementation — the CSS animations key off the exact class strings this
 * drives (`confirming`/`dismissed`/`checked`), so two copies would drift.
 *
 * Call order is load-bearing and must not be reordered: onConfirmed (flag the destination row) → onChange
 * (remove from the list) → onLeft (close the modal). onLeft last because it may unmount this component.
 */
function useTaskLeave(
  taskId: string,
  { onChange, onConfirmed, onLeft }: { onChange: (t: WebTask[]) => void; onConfirmed?: (id: string) => void; onLeft?: (id: string) => void },
) {
  const [leaving, setLeaving] = useState(false);
  const [leaveKind, setLeaveKind] = useState<"confirm" | "dismiss">("dismiss");
  // Confirm ("Looks good") gets a distinct green check-pulse (a small reward for finishing something);
  // Dismiss keeps the plain slide-away — different actions, so they shouldn't look identical. Both play
  // WHILE the API call runs, then remove the card, so it never blinks out or lingers waiting on the network.
  const leave = async (fn: () => Promise<WebTask[]>, kind: "confirm" | "dismiss" = "dismiss") => {
    if (leaving) return;
    setLeaveKind(kind);
    setLeaving(true);
    // Must match (or slightly exceed) the CSS animation durations (cardConfirm 0.55s / cardOut 0.32s in
    // styles.css) — the row is removed from state the instant this resolves, so if the timers were shorter
    // than the animation, React would unmount mid-collapse and cut it off abruptly (the exact jank this is
    // meant to avoid). Confirm holds a beat longer so the check-pulse reads before it slides away.
    const holdMs = kind === "confirm" ? 550 : 320;
    const [list] = await Promise.all([fn(), new Promise((r) => setTimeout(r, holdMs))]);
    if (kind === "confirm") onConfirmed?.(taskId); // flags the row it lands on in "Completed" for a beat, so
    // finishing something has a visible destination instead of just vanishing from the list.
    onChange(list);
    onLeft?.(taskId); // when open in the task modal, both finishing AND dismissing should close the
    // popup and drop you back on the list — there's nothing left to look at either way.
  };
  return { leaving, leaveKind, leave };
}

// "Open example.com ↗" instead of a bare "Open ↗" — the user sees WHERE each step goes before clicking.
const urlHost = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
// Name WHAT a link is, not just where it points — "Doc" beats "docs.google.com" on the card. Kept short —
// this is a button label, not a description, so it should read at a glance next to "Open ↗".
function linkKind(u?: string): string {
  const s = u || "";
  if (/docs\.google\.com\/document/.test(s)) return "Doc";
  if (/docs\.google\.com\/spreadsheets/.test(s)) return "Sheet";
  if (/docs\.google\.com\/presentation/.test(s)) return "Slides";
  if (/docs\.google\.com\/forms|forms\.gle/.test(s)) return "Form";
  if (/mail\.google\.com/.test(s)) return /#drafts/.test(s) ? "Draft" : "Email";
  if (/calendar\.google\.com/.test(s)) return "Event";
  if (/drive\.google\.com/.test(s)) return "File";
  if (/maps\.google\.com|google\.com\/maps/.test(s)) return "Directions";
  if (/^tel:/.test(s)) return "Call";
  if (/github\.com\/[^/]+\/[^/]+\/pull/.test(s)) return "PR";
  if (/github\.com\/[^/]+\/[^/]+\/issues/.test(s)) return "Issue";
  if (/[a-z0-9-]+\.slack\.com/.test(s)) return "Slack";
  if (/notion\.so/.test(s)) return "Notion";
  return urlHost(s);
}

const stepBlocked = (steps: TaskStep[], s: TaskStep) => s.dependsOn != null && !steps[s.dependsOn]?.done;

/** A labelled, counted, collapsed section. The count is what makes "closed" safe — the student can see
 *  THAT five steps exist without opening anything, so nothing feels hidden. */
function Disclosure({ label, count, open, onToggle, children }: { label: string; count?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={`disclosure ${open ? "open" : ""}`}>
      <button type="button" className="disclosure-head" aria-expanded={open} onClick={onToggle}>
        <span className="caret" aria-hidden="true">›</span>
        <span className="disclosure-label">{label}</span>
        {count != null ? <span className="disclosure-count">{count}</span> : null}
      </button>
      {open ? <div className="disclosure-body">{children}</div> : null}
    </div>
  );
}

/* ─────────────────────────────── collapsed row ─────────────────────────────── */

export function TaskCardRow({ task, onChange, retrying, onConfirmed, isNew, index, onOpen, onNotify }: {
  task: WebTask; onChange: (t: WebTask[]) => void; retrying?: boolean; onConfirmed?: (id: string) => void;
  isNew?: boolean; index?: number; onOpen: () => void; onNotify?: (msg: string, kind?: "info" | "error") => void;
}) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const { leaving, leaveKind, leave } = useTaskLeave(task.id, { onChange, onConfirmed });
  const cStatus = canonStatus(task.status);
  const isDone = isHandled(task.status);

  // Auto-open documents Otto created (Doc/Sheet/Slides) once the task is done — capped per task + per
  // session, once per URL EVER (persisted), so the same doc never reopens. Stays on the ROW (not the focus
  // view) because that's where it fires today: it must not become "only when you open the task".
  useEffect(() => {
    if (cStatus !== "needs_review") return;
    autoOpenTaskDocs(task.links);
  }, [task.status, task.links]);

  const needsYou = !isDone && cStatus === "needs_review" &&
    (task.steps || []).some((s) => !s.done && (!s.automatable || s.needsPermission || !!s.question));
  // Only an ACTIONABLE chip earns a place on the row. "En attente"/"Queued" (tone muted) is ambient state
  // the student can't act on, and it used to sit alongside a priority chip and a cleanup chip — three chips
  // on one line. Priority is dropped entirely: the list is already ordered by it, and `.when-soon` + the
  // card's own left border carry urgency without a word.
  const chip = !isDone ? statusChip(task, retrying, cardEn) : null;
  const showChip = chip && chip.tone !== "muted" ? chip : null;

  const w = task.when ? fmtWhen(task.when) : "";
  // Days-to-deadline, not urgency score, drives the visual — same anti-procrastination curve as
  // the server's applyDeadlineUrgency, so a card LOOKS as urgent as it's actually ranked.
  const daysLeft = task.when ? (Date.parse(task.when) - Date.now()) / 86_400_000 : NaN;
  const soon = !isDone && !isNaN(daysLeft) && daysLeft <= 3;
  const next = !isDone ? (task.steps || []).find((s) => !s.done) : undefined;
  const secondary = next ? L(`Suivant : ${next.text}`, `Next: ${next.text}`) : subtitle(task);

  return (
    <div style={index !== undefined ? { ["--i" as any]: index } : undefined} className={`card ${isInFlight(task.status) ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${leaving && leaveKind === "confirm" ? "confirming" : task.status === "dismissed" || leaving ? "dismissed" : ""}`}>
      {/* Opening the task was a `div onClick` — completely unreachable by keyboard, and the app has no other
          way in. A stretched overlay button fixes that without restructuring the row's flex layout: it
          covers the whole card underneath the real controls (which sit above it via z-index), so a click
          anywhere still opens, Tab reaches it, and the focus ring outlines the entire card. Its accessible
          name is the task title, since the visible title isn't inside it. */}
      {/* TEMP DIAGNOSTIC — remove once the live "tasks won't open on mobile" bug is confirmed fixed. Fires
          an unmissable toast the instant this is tapped, BEFORE navigating, so a phone with no devtools
          access can still tell us definitively: toast-but-no-popup means the tap IS reaching this handler
          and the bug is in rendering the modal; no-toast-at-all means the tap never reaches this handler
          at all (an interaction/CSS problem, not a routing one). */}
      <button type="button" className="card-open" onClick={() => { onNotify?.("tap ok →" + task.title.slice(0, 24)); onOpen(); }} aria-label={L(`Ouvrir : ${task.title}`, `Open: ${task.title}`)} />
      <div className="card-main">
        {/* Direct check-off, like a normal to-do list — no need to open the task first. Still one deliberate
            click (not automatic): it fires the same confirm as "Looks good" inside the detail view. */}
        {!isDone ? (
          <button type="button" className={`card-check ${leaving && leaveKind === "confirm" ? "checked" : ""}`}
            title={L("Marquer comme fait", "Mark as done")} aria-label={L(`Marquer « ${task.title} » comme faite`, `Mark "${task.title}" as done`)} disabled={leaving}
            onClick={() => void leave(() => api.confirm(task.id), "confirm")}>
            <span aria-hidden="true">{leaving && leaveKind === "confirm" ? "✓" : ""}</span>
          </button>
        ) : null}
        <div className="card-text">
          <div className="card-title">{isNew ? <span className="new-dot" title={L("Nouveau — pas encore ouvert", "New — not yet opened")} /> : null}{task.title}</div>
          {(w || secondary) ? <div className="card-sub">{w && <span className={`when ${soon ? "when-soon" : ""}`}>{w}</span>}{secondary}</div> : null}
        </div>
        {showChip ? <span className={`chip chip-${showChip.tone}`}>{showChip.label}</span> : null}
        {cStatus === "executing" ? <span className="card-spin" title={L("En cours…", "Working…")} /> : null}
        {/* Quick dismiss — remove a task in one click without opening it. Hover-revealed so the row stays clean.
            Hidden once the row is already leaving (dismissing or confirming) — a second click has nothing to do. */}
        {!isDone && !leaving && <button className="card-x" title={L("Ignorer", "Dismiss")} aria-label={L(`Ignorer « ${task.title} »`, `Dismiss "${task.title}"`)} onClick={() => void leave(() => api.dismiss(task.id))}>×</button>}
        <span className="caret" aria-hidden="true">›</span>
      </div>
      {leaving && leaveKind === "confirm" ? <span className="confirm-check" aria-hidden="true">✓</span> : null}
    </div>
  );
}

/* ─────────────────────────────── the focused task view ─────────────────────────────── */

export function TaskFocus({ task, onChange, onTask, retrying, onConfirmed, onLeft, onNotify }: {
  task: WebTask; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void; retrying?: boolean;
  onConfirmed?: (id: string) => void; onLeft?: (id: string) => void; onNotify?: (msg: string, kind?: "info" | "error") => void;
}) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const [running, setRunning] = useState(false);
  // One panel open at a time, so the page never grows past about a screen and a half.
  const [openPanel, setOpenPanel] = useState<"steps" | "prepared" | "context" | null>(null);
  const togglePanel = (p: "steps" | "prepared" | "context") => setOpenPanel((v) => (v === p ? null : p));
  // Lifted: both the chat's artifact chips and the "Ce qu'Otto a préparé" panel open these popups.
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [openQuiz, setOpenQuiz] = useState<string | null>(null);
  // Lifted: the hero edits the CURRENT step's decision box, the step list edits any step's.
  const [decided, setDecided] = useState<Record<number, string>>({});

  const { leaving, leaveKind, leave } = useTaskLeave(task.id, { onChange, onConfirmed, onLeft });
  const act = async (fn: () => Promise<WebTask[]>) => { onChange(await fn()); };
  const markStepDone = (i: number) => act(() => api.stepDone(task.id, i, true, (decided[i] || "").trim() || undefined));

  // ── chat state lives here so "Je bloque" (hero) and "Aide" (step list) can both seed the thread ──
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // The message currently in flight. Without this the student's own message VANISHED the moment they hit
  // send (the input clears immediately, but the thread only updates once the server responds).
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const [chatSlow, setChatSlow] = useState(false);
  const [chatVerySlow, setChatVerySlow] = useState(false);
  // Set by "Je bloque"/"Aide" — the NEXT message sent is tagged as being about this step (server validates
  // the range). Cleared once that message actually sends, so a follow-up isn't silently re-tagged.
  const [chatStep, setChatStep] = useState<number | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: "nearest" }); }, [task.chat?.length, chatSending]);
  // Two stages, not one: a plain reply is usually back well under 6s, but a turn that looks something up
  // or makes a deck/quiz is 2-3 sequential model calls and routinely runs 15-20s+ — a single "still
  // thinking…" left sitting for that long starts reading as broken.
  useEffect(() => {
    if (!chatSending) { setChatSlow(false); setChatVerySlow(false); return; }
    const id1 = setTimeout(() => setChatSlow(true), 6000);
    const id2 = setTimeout(() => setChatVerySlow(true), 15000);
    return () => { clearTimeout(id1); clearTimeout(id2); };
  }, [chatSending]);
  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || chatSending) return;
    const stepIndex = chatStep; // captured before clearing
    setChatInput(""); setChatSending(true); setChatError(null); setPendingMsg(message); setChatStep(null);
    // Merge the WHOLE returned task, not just `chat` — a tutor turn can create notes/decks/quizzes, and the
    // assistant's chat entry references them by id (task.notes/flashcards/quizzes).
    try { const { task: updated } = await api.chat(task.id, message, stepIndex ?? undefined); onTask({ ...task, ...updated }); }
    catch (e: any) { setChatError(e?.message || L("Envoi impossible — réessaie.", "Couldn't send that — try again.")); setChatInput(message); }
    finally { setChatSending(false); setPendingMsg(null); }
  };
  // Seed the ONE task-level chat thread with which step this is about, then let the student add their own
  // words before sending. Prefilled + focused, NOT auto-sent — they almost always want to add "je bloque
  // sur la partie b", and auto-sending would burn a paid call on text they didn't write themselves.
  const askAboutStep = (i: number, text: string) => {
    setChatStep(i);
    setChatInput(L(`Aide-moi avec : ${text}`, `Help me with: ${text}`));
    chatInputRef.current?.focus();
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  };

  const run = async (reset?: boolean) => {
    setRunning(true);
    try { onTask(await api.run(task.id, reset)); }
    // A run rejection (paused / over-budget / rate-limited / still-running-elsewhere / a server error) never
    // touched the task before, so it failed silently. Surface it — the card also reflects any failed state.
    catch (e: any) { onNotify?.(e?.message || L("Impossible de lancer cette tâche — réessaie.", "Couldn't run this task — try again."), "error"); }
    finally { setRunning(false); }
  };

  const steps = task.steps || [];
  const doneCount = steps.filter((s) => s.done).length;
  const currentIdx = steps.findIndex((s) => !s.done && !stepBlocked(steps, s));
  const cStatus = canonStatus(task.status);
  const isDone = isHandled(task.status);
  const artifactCount = (task.notes?.length || 0) + (task.flashcards?.length || 0) + (task.quizzes?.length || 0);
  const preparedCount = artifactCount + (task.links?.length || 0) + (task.did?.length || 0);
  const chip = !isDone ? statusChip(task, retrying, cardEn) : null;

  return (
    <div className={`task-focus ${leaving && leaveKind === "confirm" ? "confirming" : leaving ? "dismissed" : ""}`}>
      {/* (A) header — title and deadline only. Everything else that used to crowd this line moved into the
          hero (in-flight state) or was dropped (priority chip). */}
      <div className="tf-head">
        <h2 className="tf-title">{task.title}</h2>
        <div className="tf-meta">
          {task.when ? <span className={`when ${(Date.parse(task.when) - Date.now()) / 86_400_000 <= 3 ? "when-soon" : ""}`}>{fmtWhen(task.when)}</span> : null}
          {chip ? <span className={`chip chip-${chip.tone}`}>{chip.label}</span> : null}
        </div>
      </div>

      {/* (B) progress — the deck's own bar, so "one at a time" reads the same as it does in a quiz. */}
      {steps.length > 0 && !isDone ? (
        <>
          <div className="deck-progress-bar"><div className="deck-progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <div className="deck-progress">{L(`Étape ${Math.min(doneCount + 1, steps.length)} sur ${steps.length}`, `Step ${Math.min(doneCount + 1, steps.length)} of ${steps.length}`)}</div>
        </>
      ) : null}

      {/* (C) the hero — the single thing to do right now. */}
      <StepHero
        task={task} steps={steps} currentIdx={currentIdx} isDone={isDone} cStatus={cStatus}
        retrying={retrying} running={running} decided={decided} setDecided={setDecided}
        onStepDone={markStepDone} onAsk={askAboutStep} onRun={run}
        onConfirm={() => void leave(() => api.confirm(task.id), "confirm")}
        onTask={onTask} onNotify={onNotify}
      />

      {/* (D) everything else — closed, counted, one open at a time. */}
      <div className="tf-panels">
        {steps.length > 0 ? (
          <Disclosure label={L("Toutes les étapes", "All steps")} count={`${doneCount}/${steps.length}`}
            open={openPanel === "steps"} onToggle={() => togglePanel("steps")}>
            <StepList task={task} steps={steps} decided={decided} setDecided={setDecided}
              onStepDone={markStepDone} onUndo={(i) => void act(() => api.stepDone(task.id, i, false))}
              onAsk={askAboutStep} onChange={onChange} />
          </Disclosure>
        ) : null}
        {preparedCount > 0 ? (
          <Disclosure label={L("Ce qu'Otto a préparé", "What Otto prepared")} count={preparedCount}
            open={openPanel === "prepared"} onToggle={() => togglePanel("prepared")}>
            <PreparedPanel task={task} onOpenNote={setOpenNote} onOpenDeck={setOpenDeck} onOpenQuiz={setOpenQuiz} />
          </Disclosure>
        ) : null}
        <Disclosure label={L("Contexte", "Context")} count={task.source ? sourceBadge(task.source, cardEn) : undefined}
          open={openPanel === "context"} onToggle={() => togglePanel("context")}>
          <ContextPanel task={task} />
        </Disclosure>
      </div>

      {/* (E) the tutor — never behind a disclosure; it's the core feature and it has to be one glance away. */}
      {!isDone ? (
        <TaskChat
          task={task} input={chatInput} setInput={setChatInput} sending={chatSending} error={chatError}
          pendingMsg={pendingMsg} slow={chatSlow} verySlow={chatVerySlow} onSend={sendChat}
          inputRef={chatInputRef} endRef={chatEndRef}
          onOpenNote={setOpenNote} onOpenDeck={setOpenDeck} onOpenQuiz={setOpenQuiz}
        />
      ) : null}

      {/* (F) the quiet exit. "C'est bon" lives in the hero's done state, not down here. */}
      <div className="tf-foot">
        {isDone ? (
          <span className="done-footer">{task.status === "dismissed" ? L("Ignorée", "Dismissed") : L("Terminée", "Done")}{task.updatedAt ? ` ${relTime(task.updatedAt)}` : ""}</span>
        ) : (
          <button className="btn xs ghost" title={L("Retirer cette tâche", "Remove this task")} onClick={() => void leave(() => api.dismiss(task.id))}>{L("Ignorer", "Dismiss")}</button>
        )}
      </div>

      <ArtifactPopups task={task} openNote={openNote} openDeck={openDeck} openQuiz={openQuiz}
        setOpenNote={setOpenNote} setOpenDeck={setOpenDeck} setOpenQuiz={setOpenQuiz} />
    </div>
  );
}

/* ─────────────────────────────── the hero ─────────────────────────────── */

/** Exactly one shape, by precedence. Ticking the current step advances it in place — that's what makes
 *  "one thing at a time" self-evident without a word of instruction. */
function StepHero({ task, steps, currentIdx, isDone, cStatus, retrying, running, decided, setDecided, onStepDone, onAsk, onRun, onConfirm, onTask, onNotify }: {
  task: WebTask; steps: TaskStep[]; currentIdx: number; isDone: boolean; cStatus: string;
  retrying?: boolean; running: boolean;
  decided: Record<number, string>; setDecided: Dispatch<SetStateAction<Record<number, string>>>;
  onStepDone: (i: number) => void; onAsk: (i: number, text: string) => void; onRun: (reset?: boolean) => void;
  onConfirm: () => void; onTask: (t: WebTask) => void; onNotify?: (msg: string, kind?: "info" | "error") => void;
}) {
  const L = useLang();
  const pendingSendable = (task.sendables || []).findIndex((s) => !s.sent);

  if (isDone) {
    return (
      <div className="step-hero hero-done">
        <p className="hero-line">{task.status === "dismissed" ? L("Tâche ignorée.", "Task dismissed.") : L("Tâche terminée.", "Task finished.")}</p>
      </div>
    );
  }
  // Otto is working — nothing for the student to do but wait. Absorbs the old "Nettoyage…" row chip.
  if (isInFlight(task.status) || task.unrefined) {
    return (
      <div className="step-hero hero-waiting">
        <span className="card-spin" aria-hidden="true" />
        <p className="hero-line">{task.unrefined
          ? L("Otto met cette tâche au propre — rien à faire, ça arrive tout seul.", "Otto is tidying this task up — nothing to do, it happens on its own.")
          : L("Otto prépare ça…", "Otto is getting this ready…")}</p>
      </div>
    );
  }
  if (cStatus === "failed_retryable" || cStatus === "failed_terminal") {
    return (
      <div className="step-hero hero-failed">
        <p className="hero-line">{task.lastError || L("Otto n'a pas réussi à préparer cette tâche.", "Otto couldn't get this ready.")}</p>
        <div className="hero-acts">
          {retrying
            ? <button className="btn primary" disabled>{L("Nouvel essai…", "Retrying…")}</button>
            : <button className="btn primary" disabled={running} onClick={() => onRun()}>{running ? L("En cours…", "Working…") : L("Réessayer", "Retry")}</button>}
        </div>
      </div>
    );
  }
  // A draft waiting to be sent is the next action, ahead of any step. The step count stays visible in the
  // accordion below so nothing feels lost.
  if (pendingSendable >= 0) {
    return (
      <div className="step-hero hero-sendable">
        <SendableReview task={task} onTask={onTask} onNotify={onNotify} />
      </div>
    );
  }
  // Every step ticked — echo the deck's done screen so finishing reads the same everywhere.
  if (steps.length > 0 && currentIdx < 0) {
    return (
      <div className="step-hero hero-complete">
        <div className="deck-score-ring good"><span className="deck-score-pct" aria-hidden="true">✓</span></div>
        <p className="hero-line">{L("Tout est fait.", "Everything's done.")}</p>
        <div className="hero-acts">
          <button className="btn primary" onClick={onConfirm}>{L("C'est bon", "Looks good")}</button>
        </div>
      </div>
    );
  }
  if (steps.length === 0) {
    return (
      <div className="step-hero hero-empty">
        <p className="hero-line">{subtitle(task) || task.why}</p>
        <div className="hero-acts">
          <button className="btn primary" disabled={running} onClick={() => onRun()}>{running ? L("En cours…", "Working…") : L("Lancer", "Start")}</button>
        </div>
      </div>
    );
  }

  const s = steps[currentIdx];
  const gatesAnother = steps.some((o, j) => j !== currentIdx && o.dependsOn === currentIdx);
  return (
    <div className="step-hero">
      <span className="hero-kicker">{L("À faire maintenant", "Do this now")}</span>
      <p className="hero-step">{withInlineLinks(s.text)}</p>
      {s.targetDate ? <span className="step-target">{L(`d'ici le ${fmtDate(s.targetDate)}`, `by ${fmtDate(s.targetDate)}`)}</span> : null}
      {s.result ? <span className="step-result note">{s.result}</span> : null}
      {/* "What did you decide?" only when this step GATES a later one — then it feeds that next step. */}
      {gatesAnother && !s.automatable ? (
        <input
          className="step-input"
          placeholder={L("Qu'as-tu décidé ? (utilisé pour l'étape suivante)", "What did you decide? (used for the next step)")}
          value={decided[currentIdx] || ""}
          onChange={(e) => setDecided((d) => ({ ...d, [currentIdx]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") onStepDone(currentIdx); }}
        />
      ) : null}
      <div className="hero-acts">
        {s.url ? <button className="btn primary" title={s.url} onClick={() => openTab(s.url!, TAB_GROUP)}>{L(`Ouvrir ${linkKind(s.url) || "le lien"} ↗`, `Open ${linkKind(s.url) || "link"} ↗`)}</button> : null}
        <button className={`btn ${s.url ? "" : "primary"}`} onClick={() => onStepDone(currentIdx)}>{L("C'est fait", "Done")}</button>
        {/* The whole discoverability mechanism for the tutor, attached to the moment it's needed. */}
        <button className="btn ghost hero-stuck" onClick={() => onAsk(currentIdx, s.text)}>{L("Je bloque", "I'm stuck")}</button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── panels ─────────────────────────────── */

function StepList({ task, steps, decided, setDecided, onStepDone, onUndo, onAsk, onChange }: {
  task: WebTask; steps: TaskStep[];
  decided: Record<number, string>; setDecided: Dispatch<SetStateAction<Record<number, string>>>;
  onStepDone: (i: number) => void; onUndo: (i: number) => void; onAsk: (i: number, text: string) => void;
  onChange: (t: WebTask[]) => void;
}) {
  const L = useLang();
  const openableCount = steps.filter((s) => s.url && !s.done && !stepBlocked(steps, s)).length;
  // Open ALL of a task's remaining page-steps at once, into one tab group named after the task.
  const openAllPages = async () => {
    const idxs = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.url && !s.done && !stepBlocked(steps, s)).map(({ i }) => i).slice(0, 3);
    if (!idxs.length) return;
    openTabs(idxs.map((i) => steps[i].url!), TAB_GROUP);
    let res: WebTask[] | null = null;
    for (const i of idxs) if (steps[i].automatable) res = await api.stepDone(task.id, i, true, L("Ouvert ↗", "Opened ↗"));
    if (res) onChange(res);
  };
  return (
    <>
      {openableCount >= 2 ? (
        <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>{L(`Tout ouvrir (${openableCount}) ↗`, `Open all (${openableCount}) ↗`)}</button>
      ) : null}
      {/* A big IB project (Extended Essay/TOK/CAS/IA — see isBigIbProject in server/claude.ts) gets a
          milestone stepper: each segment is one milestone, so progress through a months-long project reads
          at a glance. Omitted entirely for an ordinary task (no step has targetDate outside a big project). */}
      {steps.some((s) => s.targetDate) && (
        <div className="milestone-bar" role="list">
          {steps.filter((s) => s.targetDate).map((s, i, arr) => {
            const doneIdx = arr.reduce((n, x) => n + (x.done ? 1 : 0), 0);
            const late = !s.done && s.targetDate! < todayIso();
            const state = s.done ? "done" : late ? "late" : i === doneIdx ? "current" : "upcoming";
            return (
              <div key={i} role="listitem" className={`milestone-segment ${state}`} title={`${s.text}${s.targetDate ? ` — ${L("d'ici le", "by")} ${fmtDate(s.targetDate)}${late ? ` (${L("en retard", "overdue")})` : ""}` : ""}`}>
                <span className="milestone-segment-bar" />
                <span className="milestone-segment-label">{s.text}</span>
              </div>
            );
          })}
        </div>
      )}
      <ul className="steps">
        {steps.map((s, i) => {
          const blk = stepBlocked(steps, s);
          const gatesAnother = steps.some((o, j) => j !== i && o.dependsOn === i);
          const markLabel = s.done
            ? L(`Marquer « ${s.text} » comme pas encore faite`, `Mark "${s.text}" as not done`)
            : L(`Marquer « ${s.text} » comme faite`, `Mark "${s.text}" as done`);
          return (
            <li key={i} className={`step ${s.done ? "done" : ""} ${blk ? "blocked" : ""}`}>
              {/* The mark IS the control for a needs-you step: click ○ to tick it done (no separate button).
                  It renders no text when unticked, so it needs a real accessible name — a bare title
                  attribute left it announced as an unlabelled button. */}
              <button
                type="button"
                className={`step-mark ${!s.done && !blk ? "tickable" : ""}`}
                aria-label={blk ? L("En attente d'une étape précédente", "Waiting on an earlier step") : markLabel}
                aria-pressed={s.done}
                title={s.done ? L(`Fait${s.doneAt ? " " + relTime(s.doneAt) : ""} — cliquer pour annuler`, `Done${s.doneAt ? " " + relTime(s.doneAt) : ""} — click to undo`) : blk ? L("En attente d'une étape précédente", "Waiting on an earlier step") : L("Cliquer pour marquer comme fait", "Click to mark done")}
                disabled={blk}
                onClick={() => { if (blk) return; s.done ? onUndo(i) : onStepDone(i); }}
              >
                <span aria-hidden="true">{s.done ? "✓" : ""}</span>
              </button>
              <div className="step-body">
                <span className="step-text">{withInlineLinks(s.text)}</span>
                {s.done && s.doneAt ? <span className="step-when">{L(`fait ${relTime(s.doneAt)}`, `done ${relTime(s.doneAt)}`)}</span> : null}
                {!s.done && s.targetDate ? <span className="step-target">{L(`d'ici le ${fmtDate(s.targetDate)}`, `by ${fmtDate(s.targetDate)}`)}</span> : null}
                {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                {!s.done && blk ? <span className="step-dep">{L(`attend l'étape ${(s.dependsOn ?? 0) + 1}`, `waits for step ${(s.dependsOn ?? 0) + 1}`)}</span> : null}
                {gatesAnother && !s.done && !blk && !s.automatable ? (
                  <input
                    className="step-input"
                    placeholder={L("Qu'as-tu décidé ? (utilisé pour l'étape suivante)", "What did you decide? (used for the next step)")}
                    value={decided[i] || ""}
                    onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") onStepDone(i); }}
                  />
                ) : null}
              </div>
              <div className="step-act">
                {/* A URL step keeps its "Open ↗" link ALWAYS — even after Otto opened it. */}
                {s.url ? <button className="btn xs ghost" title={s.url} onClick={() => openTab(s.url!, TAB_GROUP)}>{L(`Ouvrir ${linkKind(s.url) || "le lien"} ↗`, `Open ${linkKind(s.url) || "link"} ↗`)}</button> : null}
                {!s.done ? <button className="btn xs ghost" onClick={() => onAsk(i, s.text)}>{L("Aide", "Help")}</button> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PreparedPanel({ task, onOpenNote, onOpenDeck, onOpenQuiz }: {
  task: WebTask; onOpenNote: (id: string) => void; onOpenDeck: (id: string) => void; onOpenQuiz: (id: string) => void;
}) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const [showAudit, setShowAudit] = useState(false);
  return (
    <>
      {task.did?.length ? <ul className="bullets">{task.did.map((d, i) => <li key={i}>{withInlineLinks(d)}</li>)}</ul> : null}
      {/* In-app notes, flashcard decks and quizzes — no external tab, they open right here in a popup. */}
      {(task.notes?.length || task.flashcards?.length || task.quizzes?.length) ? (
        <div className="note-chips">
          {task.notes?.map((n) => (
            <button key={n.id} type="button" className="btn xs ghost note-chip" onClick={() => onOpenNote(n.id)}><span aria-hidden="true">📄</span> {n.title}</button>
          ))}
          {task.flashcards?.map((f) => (
            <button key={f.id} type="button" className="btn xs ghost note-chip" onClick={() => onOpenDeck(f.id)}><span aria-hidden="true">🗂</span> {L(`${f.title}, ${f.cards.length} cartes`, `${f.title}, ${f.cards.length} cards`)}</button>
          ))}
          {task.quizzes?.map((qz) => (
            <button key={qz.id} type="button" className="btn xs ghost note-chip" onClick={() => onOpenQuiz(qz.id)}><span aria-hidden="true">❓</span> {L(`${qz.title}, ${qz.questions.length} questions`, `${qz.title}, ${qz.questions.length} questions`)}</button>
          ))}
        </div>
      ) : null}
      {task.links?.length ? (
        <ul className="links artifacts">{task.links.slice(0, 3).map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer" title={l.url}>{(l.label && l.label !== "Open" ? l.label : linkKind(l.url)) || L("Ouvrir le lien", "Open link")} ↗</a></li>)}</ul>
      ) : null}
      {/* Audit trail: what Otto actually called/created/blocked on this task, in plain language — so a
          parent or teacher can verify "never does the work" is enforced, not just claimed. */}
      {task.audit?.length ? (
        <div className="audit-log">
          <button type="button" className="btn xs ghost audit-toggle" aria-expanded={showAudit} onClick={() => setShowAudit((v) => !v)}>
            <span aria-hidden="true">🔍</span> {L("Journal d'activité", "Activity log")} ({task.audit.length})
          </button>
          {showAudit ? (
            <ul className="audit-list">
              {task.audit.slice().reverse().map((e, i) => (
                <li key={i} className={`audit-${e.kind}`}>
                  <span className="audit-icon" aria-hidden="true">{e.kind === "guardrail" ? "🛡" : e.kind === "artifact" ? "✅" : "🔎"}</span>
                  <span className="audit-label">{e.label}</span>
                  <span className="audit-at">{new Date(e.at).toLocaleString(cardEn ? "en-GB" : "fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** WHERE this came from and WHAT Otto actually found, plus the decision trail. History is fetched on first
 *  expand rather than always-on — it's for the moment someone asks, not every render. */
function ContextPanel({ task }: { task: WebTask }) {
  const L = useLang();
  const [history, setHistory] = useState<{ kind: string; message?: string; at: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.taskEvents(task.id)
      .then((h) => { if (alive) setHistory(h); })
      .catch(() => { if (alive) setHistory([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [task.id]);
  return (
    <div className="context-body">
      {task.context?.trim() ? <p className="context-text">{withInlineLinks(task.context)}</p> : null}
      {loading ? (
        <p className="muted small">{L("Chargement de l'historique…", "Loading history…")}</p>
      ) : history?.length ? (
        <ul className="history-list">
          {history.map((e, i) => (
            <li key={i}><span className="history-when">{relTime(e.at)}</span> {e.message || e.kind}</li>
          ))}
        </ul>
      ) : !task.context?.trim() ? <p className="muted small">{L("Rien d'enregistré pour l'instant.", "Nothing recorded yet.")}</p> : null}
    </div>
  );
}

/* ─────────────────────────────── the tutor ─────────────────────────────── */

function TaskChat({ task, input, setInput, sending, error, pendingMsg, slow, verySlow, onSend, inputRef, endRef, onOpenNote, onOpenDeck, onOpenQuiz }: {
  task: WebTask; input: string; setInput: (v: string) => void; sending: boolean; error: string | null;
  pendingMsg: string | null; slow: boolean; verySlow: boolean; onSend: () => void;
  inputRef: MutableRefObject<HTMLInputElement | null>; endRef: MutableRefObject<HTMLDivElement | null>;
  onOpenNote: (id: string) => void; onOpenDeck: (id: string) => void; onOpenQuiz: (id: string) => void;
}) {
  const L = useLang();
  return (
    <section className="task-chat">
      <h3>{L("Demander à Otto", "Ask Otto")}</h3>
      {/* role="log" so a screen reader announces replies as they arrive — the thread updates without any
          navigation, so without this a blind student would never know an answer had come back. */}
      <div className="chat-thread" role="log" aria-live="polite" aria-label={L("Conversation avec Otto", "Conversation with Otto")}>
        {!task.chat?.length && !pendingMsg ? (
          <p className="muted small">{L("Explique-lui ce qui te bloque et il t'aidera à comprendre — pas à te donner la réponse. Montre-lui ton essai, dis-lui quelle étape te perd, ou demande-lui de réexpliquer autrement.", "Tell it what's blocking you and it'll help you understand — not hand you the answer. Show it your attempt, say which step loses you, or ask it to explain a different way.")}</p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            {/* Who said it, for anyone not seeing the bubble alignment/colour. */}
            <span className="sr-only">{m.role === "user" ? L("Toi :", "You:") : L("Otto :", "Otto:")}</span>
            {/* Which step this USER message was about — stepText, not a live lookup by index: steps are
                regenerated on every rerun, so a bare index could point at the wrong step by now. */}
            {m.role === "user" && m.stepText ? <span className="chat-step-tag">{L("Étape", "Step")} {(m.stepIndex ?? 0) + 1} · {m.stepText}</span> : null}
            {/* Assistant replies get light markdown; a student's own message stays literal — pasting "**"
                from their notes shouldn't get eaten. */}
            {m.role === "assistant" ? renderChatText(m.text) : m.text}
            {m.artifacts?.length ? (
              <div className="chat-artifact-chips">
                {m.artifacts.map((a) => {
                  const exists = a.kind === "note" ? task.notes?.some((n) => n.id === a.id)
                    : a.kind === "deck" ? task.flashcards?.some((f) => f.id === a.id)
                    : task.quizzes?.some((q) => q.id === a.id);
                  if (!exists) return null; // evicted by ARTIFACT_CAP — render nothing rather than crash
                  const icon = a.kind === "note" ? "📄" : a.kind === "deck" ? "🗂" : "❓";
                  const open = a.kind === "note" ? onOpenNote : a.kind === "deck" ? onOpenDeck : onOpenQuiz;
                  return <button key={a.id} type="button" className="btn xs ghost note-chip" onClick={() => open(a.id)}><span aria-hidden="true">{icon}</span> {a.title}</button>;
                })}
              </div>
            ) : null}
          </div>
        ))}
        {/* Echo the in-flight message immediately so the thread reads like a real conversation while
            waiting, instead of swallowing what they just typed. */}
        {pendingMsg ? <div className="chat-msg chat-user chat-pending">{pendingMsg}</div> : null}
        {sending ? (
          <div className="chat-msg chat-assistant chat-typing" role="status" aria-label={L("Otto réfléchit", "Otto is thinking")}>
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {verySlow ? <span className="typing-slow">{L("il prépare peut-être quelque chose…", "might be putting something together…")}</span>
              : slow ? <span className="typing-slow">{L("il réfléchit encore…", "still thinking…")}</span> : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {error ? (
        <div className="rewrite-error">
          {error}
          {/* onSend restores the input to the failed message on error, so retrying is just calling it again. */}
          <button type="button" className="btn xs ghost" onClick={onSend} disabled={sending}>{L("Réessayer", "Retry")}</button>
        </div>
      ) : null}
      <div className="chat-row">
        <input
          ref={inputRef}
          className="chat-input" aria-label={L("Ton message pour Otto", "Your message to Otto")}
          placeholder={L("ex : je bloque à la question 3…", "e.g. I'm stuck on question 3…")}
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          disabled={sending}
        />
        <button className="btn" disabled={sending || !input.trim()} onClick={onSend}>{L("Envoyer", "Send")}</button>
      </div>
    </section>
  );
}

/* ─────────────────────────────── sendables ─────────────────────────────── */

/** The draft-review flow — view, edit in place, ask Otto to rewrite, then a spelled-out confirm before
 *  anything actually sends. Moved wholesale from the old detail view; the interaction is unchanged. */
function SendableReview({ task, onTask, onNotify }: {
  task: WebTask; onTask: (t: WebTask) => void; onNotify?: (msg: string, kind?: "info" | "error") => void;
}) {
  const L = useLang();
  const [sending, setSending] = useState<number | null>(null);
  const [viewDraft, setViewDraft] = useState<number | null>(null);
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const [changeIdx, setChangeIdx] = useState<number | null>(null);
  const [changeText, setChangeText] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  // Manual edits to a draft's own text — separate from changeText (that's a PROMPT for Otto to rewrite it;
  // this is the user directly typing the replacement). Keyed by sendable index.
  const [draftEdits, setDraftEdits] = useState<Record<number, { subject?: string; body?: string }>>({});
  const [savingDraft, setSavingDraft] = useState<number | null>(null);
  const saveDraftEdit = async (i: number) => {
    const edit = draftEdits[i];
    if (!edit || savingDraft != null) return;
    // The textarea is generically bound to "body" client-side; Slack has no subject and stores its
    // message under "text" server-side — map to whichever field this sendable's app actually uses.
    const patch = task.sendables?.[i]?.app === "slack" ? { text: edit.body } : { subject: edit.subject, body: edit.body };
    setSavingDraft(i);
    try { onTask(await api.editDraft(task.id, i, patch)); setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; }); }
    catch { /* edit stays pending — the box keeps the user's text so nothing is lost */ }
    finally { setSavingDraft(null); }
  };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    // A failed send used to be swallowed entirely — for an irreversible action that's the worst possible
    // silence, so surface it.
    try { onTask(await api.sendDraft(task.id, i)); }
    catch (e: any) { onNotify?.(e?.message || L("Envoi impossible — rien n'a été envoyé. Réessaie.", "Couldn't send — nothing was sent. Try again."), "error"); }
    finally { setSending(null); }
  };
  // The user declined and said what to change → re-run the task with that note so Otto revises the draft.
  const doRevise = async () => {
    const note = changeText.trim();
    if (!note || revising) return;
    setRevising(true); setReviseError(null);
    // The re-draft replaces the sendables list, so clear any open draft preview (its index may now be stale).
    try { onTask(await api.revise(task.id, note)); setChangeIdx(null); setChangeText(""); setViewDraft(null); }
    // Note is deliberately KEPT in the box on failure so a rejected revision isn't lost — just retry it.
    catch (e: any) { setReviseError(e?.message || L("Révision impossible — réessaie.", "Couldn't revise — try again.")); }
    finally { setRevising(false); }
  };
  if (!task.sendables?.length) return null;
  return (
    <div className="sendables">
      {task.sendables.map((s, i) => {
        // Who this goes to — ALWAYS shown before the user sends (a calendar invite lists every attendee).
        const recipients = s.app === "gcal" ? (s.attendees || []).join(", ") : (s.to || s.channel || "");
        const noun = s.app === "gcal" ? L("l'invitation calendrier", "the calendar invite") : s.app === "slack" ? L("le message Slack", "the Slack message") : L("l'email", "the email");
        return (
          <div key={i} className="sendable">
            {recipients ? (
              <div className="sendable-to">
                <span className="sendable-to-label">{s.app === "gcal" ? L("Invités", "Invites") : L("À", "To")}</span>
                <span className="sendable-to-who">{recipients}</span>
              </div>
            ) : null}
            <div className="sendable-row">
              {/* Only ONE panel open at a time (draft view, or the send confirm) — opening one closes the other. */}
              <button className="btn xs ghost" aria-expanded={viewDraft === i} onClick={() => { setConfirmIdx(null); setViewDraft((v) => (v === i ? null : i)); if (viewDraft !== i) { setChangeIdx(null); setChangeText(""); } }}>{viewDraft === i ? L("Masquer les détails", "Hide details") : s.app === "gcal" ? L("Voir l'événement", "View event") : L("Voir le brouillon", "View draft")}</button>
              {/* Not yet blue: clicking this only OPENS the confirm below, it doesn't send anything — the
                  real "irreversible" signal belongs on "Oui, envoyer" alone. */}
              {s.sent
                ? <button className="btn send-btn sent" disabled>{L("Envoyé", "Sent")}</button>
                : sending === i
                  ? <button className="btn send-btn" disabled>{L("Envoi…", "Sending…")}</button>
                  : <button className="btn send-btn" onClick={() => { setViewDraft(null); setChangeIdx(null); setConfirmIdx(confirmIdx === i ? null : i); }}>{s.label}</button>}
            </div>
            {/* Confirm step — the recipient is spelled out in full before anything sends. */}
            {confirmIdx === i && !s.sent && sending !== i ? (
              <div className="confirm">
                <div className="confirm-q">{L("Envoyer", "Send")} {noun} {L("à", "to")} <b>{recipients || L("le destinataire", "the recipient")}</b> ?</div>
                <div className="confirm-acts">
                  <button className="btn primary xs" onClick={() => void doSend(i)}>{L("Oui, envoyer", "Yes, send")}</button>
                  <button className="btn xs" onClick={() => { setConfirmIdx(null); setViewDraft(i); setChangeText(""); setChangeIdx(i); }}>{L("Non — changer quelque chose", "No — change something")}</button>
                  <button className="btn xs ghost" onClick={() => setConfirmIdx(null)}>{L("Annuler", "Cancel")}</button>
                </div>
              </div>
            ) : null}
            {/* ONE panel for everything about the draft's content — view it, edit it, or ask Otto to rewrite. */}
            {viewDraft === i ? (
              <div className="draft">
                {s.app === "gcal" ? (
                  <>
                    {s.summary ? <div className="draft-row"><span className="draft-label">{L("Événement", "Event")}</span><span>{s.summary}</span></div> : null}
                    {s.when ? <div className="draft-row"><span className="draft-label">{L("Quand", "When")}</span><span>{s.when}</span></div> : null}
                    {recipients ? <div className="draft-row"><span className="draft-label">{L("Invités", "Invites")}</span><span>{recipients}</span></div> : null}
                  </>
                ) : s.sent ? (
                  <>
                    {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to || s.channel}</span></div> : null}
                    {s.subject ? <div className="draft-row"><span className="draft-label">{L("Objet", "Subject")}</span><span>{s.subject}</span></div> : null}
                    <pre className="draft-body">{s.body || s.text || L("Envoyé.", "Sent.")}</pre>
                  </>
                ) : (
                  <>
                    {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to || s.channel}</span></div> : null}
                    {s.app === "gmail" ? (
                      <input className="addinput sm draft-subject" placeholder={L("Objet", "Subject")} aria-label={L("Objet", "Subject")} disabled={revising}
                        value={draftEdits[i]?.subject ?? s.subject ?? ""}
                        onChange={(e) => setDraftEdits((d) => ({ ...d, [i]: { ...d[i], subject: e.target.value } }))} />
                    ) : null}
                    {/* Auto-grows to fit the WHOLE text (up to a cap) instead of a small fixed box that clips
                        a real email. Disabled while Otto is rewriting — a manual edit landing mid-rewrite
                        would just get silently overwritten. */}
                    <textarea className="draft-body-edit" rows={12} disabled={revising} aria-label={L("Contenu du brouillon", "Draft content")}
                      ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 600)}px`; } }}
                      value={draftEdits[i]?.body ?? s.body ?? s.text ?? ""}
                      onChange={(e) => { setDraftEdits((d) => ({ ...d, [i]: { ...d[i], body: e.target.value } })); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 600)}px`; }} />
                    {draftEdits[i] && !revising ? (
                      <div className="draft-edit-acts">
                        <button className="btn xs" disabled={savingDraft === i} onClick={() => void saveDraftEdit(i)}>{savingDraft === i ? L("Enregistrement…", "Saving…") : L("Enregistrer les modifications", "Save changes")}</button>
                        <button className="btn xs ghost" disabled={savingDraft === i} onClick={() => setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; })}>{L("Annuler", "Discard")}</button>
                      </div>
                    ) : null}
                    {changeIdx === i ? (
                      <div className="rewrite-row">
                        <input className="addinput sm" autoFocus disabled={revising}
                          aria-label={L("Ce qu'il faut changer", "What to change")}
                          placeholder={L("Dis à Otto quoi changer — ex : ajoute mes horaires de vol, raccourcis, corrige la date", "Tell Otto what to change — e.g. add my flight times, make it shorter, fix the date")}
                          value={changeText} onChange={(e) => setChangeText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void doRevise(); }} />
                        {!revising && <button className="btn xs" disabled={!changeText.trim()} onClick={() => void doRevise()}>{L("Réviser", "Revise")}</button>}
                        <button className="btn xs ghost" disabled={revising} onClick={() => { setChangeIdx(null); setChangeText(""); setReviseError(null); }}>{L("Annuler", "Cancel")}</button>
                        {reviseError ? <div className="rewrite-error">{reviseError}</div> : null}
                      </div>
                    ) : !revising ? (
                      <button className="btn xs ghost rewrite-toggle" onClick={() => { setChangeText(""); setReviseError(null); setChangeIdx(i); }}>{L("Demander à Otto de le réécrire →", "Ask Otto to rewrite it →")}</button>
                    ) : null}
                    {revising && changeIdx === i ? <div className="rewrite-progress" title={L("Otto réécrit le brouillon…", "Otto is rewriting the draft…")} /> : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── artifact popups ─────────────────────────────── */

/** The note/deck/quiz viewers, mounted once for the whole focus view (both the chat chips and the
 *  "prepared" panel open them). A chip can reference an id ARTIFACT_CAP has since evicted — that renders
 *  as nothing rather than crashing. */
function ArtifactPopups({ task, openNote, openDeck, openQuiz, setOpenNote, setOpenDeck, setOpenQuiz }: {
  task: WebTask; openNote: string | null; openDeck: string | null; openQuiz: string | null;
  setOpenNote: (v: null) => void; setOpenDeck: (v: null) => void; setOpenQuiz: (v: null) => void;
}) {
  const note = openNote ? task.notes?.find((x) => x.id === openNote) : null;
  const deck = openDeck ? task.flashcards?.find((x) => x.id === openDeck) : null;
  const quiz = openQuiz ? task.quizzes?.find((x) => x.id === openQuiz) : null;
  return (
    <>
      {note ? (
        <TaskModal onClose={() => setOpenNote(null)} nested title={note.title}>
          <div className="note-popup">
            <h3 className="note-popup-title">{note.title}</h3>
            <div className="note-popup-body">{renderNoteBody(note.body)}</div>
          </div>
        </TaskModal>
      ) : null}
      {deck ? <TaskModal onClose={() => setOpenDeck(null)} nested title={deck.title}><FlashcardDeck deck={deck} /></TaskModal> : null}
      {quiz ? <TaskModal onClose={() => setOpenQuiz(null)} nested title={quiz.title}><QuizPlayer quiz={quiz} /></TaskModal> : null}
    </>
  );
}
