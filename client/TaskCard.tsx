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
  LangContext, useLang, todayIso, fmtDate, relTime, statusChip, subtitle,
  fmtWhen, TAB_GROUP, openTab, openTabs, autoOpenTaskDocs,
  withInlineLinks, stripStrayMarkdown, renderNoteBody, renderChatText, FlashcardDeck, QuizPlayer, TaskModal, useNotify,
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
  { onChange, onTask, onConfirmed, onLeft }: {
    onChange: (t: WebTask[]) => void; onTask?: (t: WebTask) => void; onConfirmed?: (id: string) => void; onLeft?: (id: string) => void;
  },
) {
  const L = useLang();
  const notify = useNotify();
  const [leaving, setLeaving] = useState(false);
  const [leaveKind, setLeaveKind] = useState<"confirm" | "dismiss">("dismiss");
  // Confirm ("Looks good") gets a distinct green check-pulse (a small reward for finishing something);
  // Dismiss keeps the plain slide-away — different actions, so they shouldn't look identical. Both play
  // WHILE the API call runs, then remove the card, so it never blinks out or lingers waiting on the network.
  //
  // `task`, if passed, is optimistically flipped to its post-action status via `onTask` BEFORE the network
  // call even starts — the "N left today" line, the Completed section, etc. used to only update once the
  // round-trip resolved, which (compounded by api.ts's up-to-6-retry backoff on a flaky connection) is
  // what made a single tap feel like it "took a while" even though the row's own animation had already
  // started. On failure, this rolls back to the exact original `task` — the sole visibility switch for
  // the row itself stays `leaving` (local state, below), never list membership, so an optimistic status
  // flip can never cut the exit animation off mid-collapse.
  const leave = async (fn: () => Promise<WebTask[]>, kind: "confirm" | "dismiss" = "dismiss", task?: WebTask) => {
    if (leaving) return;
    setLeaveKind(kind);
    setLeaving(true);
    if (task) onTask?.({ ...task, status: kind === "confirm" ? "done" : "dismissed", updatedAt: new Date().toISOString() });
    // Must match (or slightly exceed) the CSS animation durations (cardConfirm 0.55s / cardOut 0.32s in
    // styles.css) — the row is removed from state the instant this resolves, so if the timers were shorter
    // than the animation, React would unmount mid-collapse and cut it off abruptly (the exact jank this is
    // meant to avoid). Confirm holds a beat longer so the check-pulse reads before it slides away.
    const holdMs = kind === "confirm" ? 550 : 320;
    let list: WebTask[];
    try {
      [list] = await Promise.all([fn(), new Promise((r) => setTimeout(r, holdMs))]);
      // api.ts's j() RESOLVES (doesn't throw) on a 401 — an expired session lands here as `{error: "..."}`,
      // not a WebTask[]. Without this guard that object would flow straight into onChange and corrupt the
      // task list state. Treat it the same as a thrown failure.
      if (!Array.isArray(list)) throw new Error((list as any)?.error || L("On dirait que tu as été déconnecté — recharge la page.", "Looks like you got logged out — reload the page."));
    } catch (e: any) {
      // A failed confirm/dismiss used to leave the button/animation stuck forever with no feedback and no
      // way to retry — this is the actual live-reported "Looks good doesn't close the task" bug. Reset the
      // leave state so the button works again, and say what happened instead of failing silently.
      setLeaving(false);
      if (task) onTask?.(task); // roll back the optimistic flip to the real prior state
      notify(e?.message || L("Un imprévu est survenu — réessaie.", "Something went wrong on our end — try again."), "error");
      return;
    }
    if (kind === "confirm") onConfirmed?.(taskId); // flags the row it lands on in "Completed" for a beat, so
    // finishing something has a visible destination instead of just vanishing from the list.
    onChange(list);
    onLeft?.(taskId); // when open in the task modal, both finishing AND dismissing should close the
    // popup and drop you back on the list — there's nothing left to look at either way.
  };
  return { leaving, leaveKind, leave };
}

/** Every task shows SOME date, never a blank — a task without an explicit deadline (no firm `when`, e.g.
 *  a "someday" item or one the AI classifier couldn't pin to a date) used to render with no date context
 *  at all, which read as incomplete/broken next to every other card that has one. Falls back to a relative
 *  "Added <when>" from `createdAt`, which every task has unconditionally. */
const taskDateLabel = (t: WebTask, L: (fr: string, en: string) => string): string =>
  t.when ? (t.whenApprox ? `~${fmtWhen(t.when)}` : fmtWhen(t.when)) : t.createdAt ? L(`Ajoutée ${relTime(t.createdAt)}`, `Added ${relTime(t.createdAt)}`) : "";

// "Open example.com ↗" instead of a bare "Open ↗" — the user sees WHERE each step goes before clicking.
const urlHost = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
// Name WHAT a link is, not just where it points — "Doc" beats "docs.google.com" on the card. Kept short —
// this is a button label, not a description, so it should read at a glance next to "Open ↗".
// `L` defaults to identity (English) for any caller that hasn't been updated — but every in-app call site
// now passes the real L() so a French student doesn't see a bare English noun ("Ouvrir Doc ↗") spliced
// into an otherwise-translated sentence, which is what happened before this had no L param at all.
function linkKind(u?: string, L: (fr: string, en: string) => string = (_fr, en) => en): string {
  const s = u || "";
  if (/docs\.google\.com\/document/.test(s)) return L("Document", "Doc");
  if (/docs\.google\.com\/spreadsheets/.test(s)) return L("Feuille", "Sheet");
  if (/docs\.google\.com\/presentation/.test(s)) return L("Diapositives", "Slides");
  if (/docs\.google\.com\/forms|forms\.gle/.test(s)) return L("Formulaire", "Form");
  if (/mail\.google\.com/.test(s)) return /#drafts/.test(s) ? L("Brouillon", "Draft") : L("Email", "Email");
  if (/calendar\.google\.com/.test(s)) return L("Événement", "Event");
  if (/drive\.google\.com/.test(s)) return L("Fichier", "File");
  if (/maps\.google\.com|google\.com\/maps/.test(s)) return L("Itinéraire", "Directions");
  if (/^tel:/.test(s)) return L("Appel", "Call");
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

export function TaskCardRow({ task, onChange, onTask, retrying, onConfirmed, isNew, index, onOpen, onEnterStudyMode }: {
  task: WebTask; onChange: (t: WebTask[]) => void; onTask?: (t: WebTask) => void; retrying?: boolean; onConfirmed?: (id: string) => void;
  isNew?: boolean; index?: number; onOpen: () => void; onEnterStudyMode?: () => void;
}) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const { leaving, leaveKind, leave } = useTaskLeave(task.id, { onChange, onTask, onConfirmed });
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
  // Only a chip that means "needs you" earns a place on the row — muted (queued) and good ("done for
  // you", not actionable) both used to render a chip too, which meant a row could carry a colored pill
  // even when there was nothing to act on. Reserving the chip for attention/bad/busy keeps it a genuine
  // signal instead of one more piece of always-on decoration. Priority itself is dropped entirely: the
  // list is already ordered by it, and `.when-soon` + the card's own left border carry urgency without
  // a word.
  const chip = !isDone ? statusChip(task, retrying, cardEn) : null;
  // "executing" is the one busy-tone case that ALSO shows the spinner (`.card-spin` below) — a "Working"
  // chip next to a spinner would restate the same fact twice (rule 14, remove redundant UI). A
  // failed-and-retrying task is "busy" too but has no spinner, so it still needs its chip to say so.
  const showChip = chip && chip.tone !== "muted" && chip.tone !== "good" && cStatus !== "executing" ? chip : null;
  // A quiet, always-visible sign — no need to open the task — that the "won't do your graded work"
  // boundary was actually tested on this one, not just claimed somewhere in a README.
  const guardrailHeld = task.audit?.some((a) => a.kind === "guardrail");

  const w = taskDateLabel(task, L);
  // Days-to-deadline, not urgency score, drives the visual — same anti-procrastination curve as
  // the server's applyDeadlineUrgency, so a card LOOKS as urgent as it's actually ranked.
  const daysLeft = task.when ? (Date.parse(task.when) - Date.now()) / 86_400_000 : NaN;
  const soon = !isDone && !isNaN(daysLeft) && daysLeft <= 3;
  const next = !isDone ? (task.steps || []).find((s) => !s.done) : undefined;
  const secondary = next ? L(`Suivant : ${next.text}`, `Next: ${next.text}`) : subtitle(task);

  return (
    <div className={`card ${isInFlight(task.status) ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${leaving && leaveKind === "confirm" ? "confirming" : task.status === "dismissed" || leaving ? "dismissed" : ""}`}>
      {/* Opening the task was a `div onClick` — unreachable by keyboard, and on live mobile testing, taps
          on an invisible full-cover overlay button (the previous fix here) silently failed to register at
          all despite being correct by every CSS spec/stacking rule — never fully explained, but reliably
          reproducible. Removed that pattern entirely rather than keep chasing it: .card-main is now the
          real button itself (real visible content, not an invisible layer), which is the standard,
          maximally-compatible pattern every list-based mobile app uses. .card-check/.card-x moved to true
          siblings, since a <button> can't contain another <button>. */}
      {!isDone ? (
        <button type="button" className={`card-check ${leaving && leaveKind === "confirm" ? "checked" : ""}`}
          title={L("Marquer comme fait", "Mark as done")} aria-label={L(`Marquer « ${task.title} » comme faite`, `Mark "${task.title}" as done`)} disabled={leaving}
          onClick={() => void leave(() => api.confirm(task.id), "confirm", task)}>
          <span aria-hidden="true">{leaving && leaveKind === "confirm" ? "✓" : ""}</span>
        </button>
      ) : null}
      {/* Study Mode button - only for active tasks with steps */}
      {!isDone && (task.steps || []).length > 0 && onEnterStudyMode && (
        <button type="button" className="card-study" title={L("Mode étude", "Study Mode")} aria-label={L(`Mode étude pour : ${task.title}`, `Study Mode for: ${task.title}`)} disabled={leaving} onClick={(e) => { e.stopPropagation(); onEnterStudyMode(); }}>
          Study
        </button>
      )}
      <button type="button" className="card-main" onClick={onOpen} aria-label={L(`Ouvrir : ${task.title}`, `Open: ${task.title}`)}>
        <span className="card-text">
          <span className="card-title">{isNew ? <span className="new-dot" title={L("Nouveau", "New")} /> : null}{stripStrayMarkdown(task.title)}</span>
          {(task.sourceSubject || w || secondary) ? (
            <span className="card-sub">
              {task.sourceSubject ? <span className="card-subject">{task.sourceSubject}</span> : null}
              {w && <span className={`when ${soon ? "when-soon" : ""}`}>{w}</span>}
              {secondary}
            </span>
          ) : null}
        </span>
        {showChip ? <span className={`chip chip-${showChip.tone}`}>{showChip.label}</span> : null}
        {guardrailHeld ? <span className="row-guardrail" title={L("Otto a refusé de faire cette tâche à ta place ici — voir le journal d'activité", "Otto declined to do this one for you here — see the activity log")} aria-hidden="true">✦</span> : null}
        {cStatus === "executing" ? <span className="card-spin" title={L("En cours…", "Working…")} /> : null}
        <span className="caret" aria-hidden="true">›</span>
      </button>
      {/* Quick dismiss — remove a task in one click without opening it. Hover-revealed so the row stays clean.
          Hidden once the row is already leaving (dismissing or confirming) — a second click has nothing to do. */}
      {!isDone && !leaving && <button className="card-x" title={L("Ignorer", "Dismiss")} aria-label={L(`Ignorer « ${task.title} »`, `Dismiss "${task.title}"`)} onClick={() => void leave(() => api.dismiss(task.id), "dismiss", task)}>×</button>}
      {leaving && leaveKind === "confirm" ? <span className="confirm-check" aria-hidden="true">✓</span> : null}
    </div>
  );
}

/* ─────────────────────────────── the dashboard spotlight ───────────────────────────────
 * The single most important task, given the manifesto's own room: a kicker, a large title, one line of
 * supporting context, and ONE primary action. No card border/shadow — its size and position on the page
 * are what say "look here first," not a box. Everything else today's list has (chips, spinner, dismiss)
 * stays on the quiet `TaskCardRow`s underneath; duplicating that chrome here would just be more noise
 * around the one thing meant to stand out. */
export function TaskHero({ task, onOpen }: { task: WebTask; onOpen: () => void }) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const chip = statusChip(task, false, cardEn);
  const showChip = chip && chip.tone === "attention" ? chip : null;
  const w = taskDateLabel(task, L);

  return (
    <div className="dash-hero">
      <div className="dash-hero-kicker">{L("Ta priorité", "Your next priority")}</div>
      <h2 className="dash-hero-title">{stripStrayMarkdown(task.title)}</h2>
      {task.why ? <p className="dash-hero-why">{stripStrayMarkdown(task.why)}</p> : null}
      {(task.sourceSubject || w || showChip) ? (
        <div className="dash-hero-meta">
          {task.sourceSubject ? <span className="card-subject">{task.sourceSubject}</span> : null}
          {w ? <span className="when">{w}</span> : null}
          {showChip ? <span className={`chip chip-${showChip.tone}`}>{showChip.label}</span> : null}
        </div>
      ) : null}
      <button type="button" className="btn primary big dash-hero-cta" onClick={onOpen}>
        {L("Continuer", "Continue")}
      </button>
    </div>
  );
}

/* ─────────────────────────────── the focused task view ─────────────────────────────── */

export function TaskFocus({ task, onChange, onTask, retrying, onConfirmed, onLeft }: {
  task: WebTask; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void; retrying?: boolean;
  onConfirmed?: (id: string) => void; onLeft?: (id: string) => void;
}) {
  const L = useLang();
  const notify = useNotify();
  const cardEn = useContext(LangContext) === "en";
  const [running, setRunning] = useState(false);
  // One panel open at a time, so the page never grows past about a screen and a half.
  const [openPanel, setOpenPanel] = useState<"steps" | "prepared" | null>(null);
  const togglePanel = (p: "steps" | "prepared") => setOpenPanel((v) => (v === p ? null : p));
  // Lifted: both the chat's artifact chips and the "Ce qu'Otto a préparé" panel open these popups.
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [openQuiz, setOpenQuiz] = useState<string | null>(null);
  // Lifted: the hero edits the CURRENT step's decision box, the step list edits any step's.
  const [decided, setDecided] = useState<Record<number, string>>({});

  const { leaving, leaveKind, leave } = useTaskLeave(task.id, { onChange, onConfirmed, onLeft });
  // Optimistic: this endpoint is a pure data flip server-side (no automation, no AI call — see
  // server/index.ts's /step/:index/done route), so there's no reason the checkmark should wait on the
  // round trip. Flip it locally first, reconcile with the server's response, revert on failure.
  const setStepDoneLocal = (i: number, done: boolean, result?: string) => {
    const steps = (task.steps || []).map((s, si) => si !== i ? s : { ...s, done, doneAt: done ? new Date().toISOString() : undefined, result: result ?? s.result });
    // MUST be onTask (merge-by-id), never onChange([...]) — onChange is wired straight to setTasks in
    // App.tsx, so passing a one-element array there doesn't "update this task," it REPLACES THE ENTIRE
    // DASHBOARD LIST with just this one task until the next background sync happens to overwrite it.
    // This was a real, live bug (five call sites in this file had it) — the likely cause of "completing
    // a task sometimes doesn't work / the list looks broken for a bit."
    onTask({ ...task, steps });
  };
  // Always read the CURRENT task/decided at the moment a queued step-completion actually runs, never the
  // stale closure from whenever the tap happened — see the comment on `stepQueueRef` below for why.
  const taskRef = useRef(task); taskRef.current = task;
  const decidedRef = useRef(decided); decidedRef.current = decided;
  // Tapping through several steps quickly (the normal way to finish a task, and the live-reported "Looks
  // good takes you back to a previous step" bug on mobile, worse there from higher/less consistent
  // latency) fired one `api.stepDone` request per tap with NO ordering guarantee. Each response REPLACES
  // the whole task list (server/index.ts's /step/:index/done returns the full session snapshot) — if two
  // requests are in flight and the one for an EARLIER step resolves AFTER the one for a LATER step, its
  // stale snapshot (computed before the later step's write had committed server-side) overwrites the
  // newer progress, and the task appears to jump back to an earlier unfinished step. Queuing so only one
  // request is ever in flight at a time — reading fresh state via the refs above when each queued call
  // actually runs — fixes this at the root instead of racing.
  const stepQueueRef = useRef<Promise<void>>(Promise.resolve());
  const markStepDone = (i: number) => {
    stepQueueRef.current = stepQueueRef.current.then(async () => {
      const currentTask = taskRef.current;
      const result = (decidedRef.current[i] || "").trim() || undefined;
      setStepDoneLocal(i, true, result);
      try {
        const list = await api.stepDone(currentTask.id, i, true, result);
        if (!Array.isArray(list)) throw new Error((list as any)?.error || L("On dirait que tu as été déconnecté — recharge la page.", "Looks like you got logged out — reload the page."));
        onChange(list);
      } catch (e: any) {
        onTask(currentTask); // revert the optimistic tick — onTask merges by id, onChange([...]) would nuke the whole list
        notify(e?.message || L("Impossible de marquer cette étape comme faite.", "Couldn't mark this step as done."), "error");
      }
    });
  };
  // Same ordering guarantee as markStepDone above, and for the same reason: this ALSO mutates task.steps
  // via its own independent server call, so un-ticking one step while marking another done (or answering a
  // question) in the same second could still let whichever response landed second silently overwrite the
  // other's just-applied change — the exact symptom the queue exists to prevent, just via a call site that
  // wasn't routed through it.
  const undoStep = (i: number) => {
    stepQueueRef.current = stepQueueRef.current.then(async () => {
      const currentTask = taskRef.current;
      setStepDoneLocal(i, false);
      try {
        const list = await api.stepDone(currentTask.id, i, false);
        if (!Array.isArray(list)) throw new Error((list as any)?.error || L("On dirait que tu as été déconnecté — recharge la page.", "Looks like you got logged out — reload the page."));
        onChange(list);
      } catch (e: any) {
        onTask(currentTask); // revert the optimistic un-tick — onTask merges by id, onChange([...]) would nuke the whole list
        notify(e?.message || L("Impossible d'annuler cette étape.", "Couldn't undo this step."), "error");
      }
    });
  };
  // A step with `question`/`options` is automatable but blocked on ONE piece of info Otto couldn't find or
  // infer (see the "submit" tool schema's `question` field in server/claude.ts) — answering it should
  // actually RUN the step with that answer (api.runStep), not just mark it done like the plain "what did
  // you decide" input does for a non-automatable gating step. This was previously wired server-side with
  // no client UI at all: the question/options were computed and stored but never rendered or answerable.
  const [answering, setAnswering] = useState<number | null>(null);
  // The route enqueues and returns right away rather than waiting for the actual run (see server/index.ts's
  // /step/:index/run) — the answer is already captured as the queued job's input the moment this resolves,
  // so there's nothing left to wait on here. Clear the question/options optimistically so the student isn't
  // staring at a stale prompt while it works in the background; the open tab's kick loop (client/App.tsx)
  // picks the actual run up within seconds and folds the real result in once it's done.
  // Routed through the same stepQueueRef chain as markStepDone/undoStep — onTask(updated) below replaces
  // the task's ENTIRE steps array with a server snapshot, so answering a question while ticking/un-ticking
  // a different step in the same second could otherwise let whichever response landed second silently
  // overwrite the other's already-applied change (the same ordering bug the queue exists to prevent).
  const answerStep = (i: number, answer: string) => {
    if (!answer.trim()) return;
    stepQueueRef.current = stepQueueRef.current.then(async () => {
      setAnswering(i);
      const currentTask = taskRef.current;
      const optimisticSteps = (currentTask.steps || []).map((s, si) => si !== i ? s
        : { ...s, question: undefined, options: undefined, result: L(`Tu as répondu : ${answer.trim()} — Otto s'en occupe…`, `You answered: ${answer.trim()} — Otto's on it…`) });
      onTask({ ...currentTask, steps: optimisticSteps });
      try {
        const updated = await api.runStep(currentTask.id, i, answer.trim());
        onTask(updated);
      } catch (e: any) {
        onTask(currentTask); // revert — restores the real question so the student can retry
        notify(e?.message || L("Échec de la réponse — réessaie.", "Couldn't send that answer — try again."), "error");
      } finally { setAnswering((cur) => (cur === i ? null : cur)); }
    });
  };

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
    catch (e: any) { notify(e?.message || L("Impossible de lancer cette tâche — réessaie.", "Couldn't run this task — try again."), "error"); }
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
        <h2 className="tf-title">{stripStrayMarkdown(task.title)}</h2>
        {/* A title alone can be opaque when it references something not named IN the title itself
            ("the 5 places", "the program") — the antecedent lives in `why`, which used to be shown only
            inside the collapsed Contexte panel. Surface it here unconditionally so the student never has
            to go hunting for what a vague-sounding task is actually about. */}
        {task.why ? <p className="tf-why">{stripStrayMarkdown(task.why)}</p> : null}
        <div className="tf-meta">
          {task.sourceSubject ? <span className="card-subject">{task.sourceSubject}</span> : null}
          {taskDateLabel(task, L) ? <span className={`when ${task.when && (Date.parse(task.when) - Date.now()) / 86_400_000 <= 3 ? "when-soon" : ""}`}>{taskDateLabel(task, L)}</span> : null}
          {chip ? <span className={`chip chip-${chip.tone}`}>{chip.label}</span> : null}
          {task.audit?.some((a) => a.kind === "guardrail") ? <span className="row-guardrail" title={L("Otto a refusé de faire cette tâche à ta place ici — voir le journal d'activité", "Otto declined to do this one for you here — see the activity log")} aria-hidden="true">✦</span> : null}
        </div>
      </div>

      {/* (B) progress — the deck's own bar, so "one at a time" reads the same as it does in a quiz. Just
          the bar, no "Step X of Y" caption — the exact count reappears a few lines down on the "All
          steps" disclosure header, so spelling it out here too was the same number stated twice. */}
      {steps.length > 0 && !isDone ? (
        <div className="deck-progress-bar"><div className="deck-progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      ) : null}

      {/* (C) the hero — the single thing to do right now. */}
      <StepHero
        task={task} steps={steps} currentIdx={currentIdx} isDone={isDone} cStatus={cStatus}
        retrying={retrying} running={running} decided={decided} setDecided={setDecided}
        onStepDone={markStepDone} onRun={run} onAnswer={answerStep} answering={answering}
        onConfirm={() => void leave(() => api.confirm(task.id), "confirm", task)}
        onTask={onTask}
      />

      {/* The anti-procrastination hook: the smallest possible first move, small enough it's hard to say
          no to (see FIRST ACTION in server/claude.ts) — a stuck student needs permission to start, not
          another item on the plan, so this sits BELOW the hero (which is the real current step) rather
          than competing with it for the "one thing to do" spot. */}
      {task.firstAction && !isDone ? (
        <p className="first-action">
          <span className="first-action-label">{L("Pour démarrer", "To get started")}</span>
          {task.firstAction.text}
          {task.firstAction.minutes ? <span className="first-action-minutes">~{task.firstAction.minutes} {L("min", "min")}</span> : null}
        </p>
      ) : null}

      {/* (D) everything else — closed, counted, one open at a time. */}
      <div className="tf-panels">
        {steps.length > 0 ? (
          <Disclosure label={L("Toutes les étapes", "All steps")} count={`${doneCount}/${steps.length}`}
            open={openPanel === "steps"} onToggle={() => togglePanel("steps")}>
            <StepList task={task} steps={steps} decided={decided} setDecided={setDecided}
              onStepDone={markStepDone} onUndo={undoStep}
              onAsk={askAboutStep} onChange={onChange} onTask={onTask} onAnswer={answerStep} answering={answering} />
          </Disclosure>
        ) : null}
        {preparedCount > 0 ? (
          <Disclosure label={L("Ce qu'Otto a préparé", "What Otto prepared")} count={preparedCount}
            open={openPanel === "prepared"} onToggle={() => togglePanel("prepared")}>
            <PreparedPanel task={task} onOpenNote={setOpenNote} onOpenDeck={setOpenDeck} onOpenQuiz={setOpenQuiz} />
          </Disclosure>
        ) : null}
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
          <button className="btn xs ghost" title={L("Retirer cette tâche", "Remove this task")} onClick={() => void leave(() => api.dismiss(task.id), "dismiss", task)}>{L("Ignorer", "Dismiss")}</button>
        )}
      </div>

      <ArtifactPopups task={task} onTask={onTask} openNote={openNote} openDeck={openDeck} openQuiz={openQuiz}
        setOpenNote={setOpenNote} setOpenDeck={setOpenDeck} setOpenQuiz={setOpenQuiz} />
    </div>
  );
}

/* ─────────────────────────────── the hero ─────────────────────────────── */

/** Exactly one shape, by precedence. Ticking the current step advances it in place — that's what makes
 *  "one thing at a time" self-evident without a word of instruction. */
/** A step's `minutes` estimate used to just sit there as a static "~15 min" label — real raw material
 *  (a model-provided time estimate) for a focus timer that never actually existed anywhere in the app.
 *  Plain countdown, started on tap; at zero it becomes a gentle "still going?" nudge, never a forced
 *  cutoff or a notification — this is a focus AID, not a hard limit. Client-side only (a local interval),
 *  since a timer has no reason to survive a reload; resets automatically per-step via the `key` the caller
 *  passes (StepHero remounts it on `currentIdx`). */
function SessionTimer({ minutes }: { minutes: number }) {
  const L = useLang();
  const [secsLeft, setSecsLeft] = useState<number | null>(null); // null = not started yet
  useEffect(() => {
    if (secsLeft === null) return;
    const id = setInterval(() => setSecsLeft((s) => (s === null ? s : s - 1)), 1000);
    return () => clearInterval(id);
  }, [secsLeft === null]);
  const fmt = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
  if (secsLeft === null) {
    return (
      <button type="button" className="step-minutes step-timer-start" onClick={() => setSecsLeft(minutes * 60)}>
        ~{minutes} {L("min", "min")} · {L("Démarrer", "Start timer")}
      </button>
    );
  }
  const over = secsLeft <= 0;
  return (
    <span className={`step-minutes step-timer ${over ? "over" : ""}`}>
      {over ? L(`Temps écoulé — ${fmt(secsLeft)} de plus, tu continues ?`, `Time's up — still going? +${fmt(secsLeft)}`) : fmt(secsLeft)}
    </span>
  );
}

function StepHero({ task, steps, currentIdx, isDone, cStatus, retrying, running, decided, setDecided, onStepDone, onRun, onAnswer, answering, onConfirm, onTask }: {
  task: WebTask; steps: TaskStep[]; currentIdx: number; isDone: boolean; cStatus: string;
  retrying?: boolean; running: boolean;
  decided: Record<number, string>; setDecided: Dispatch<SetStateAction<Record<number, string>>>;
  onStepDone: (i: number) => void; onRun: (reset?: boolean) => void;
  onAnswer: (i: number, answer: string) => void; answering: number | null;
  onConfirm: () => void; onTask: (t: WebTask) => void;
}) {
  const L = useLang();
  const notify = useNotify();
  const pendingSendable = (task.sendables || []).findIndex((s) => !s.sent);
  // For a step with a link that needs a real follow-up (not auto-marked done on open): the button reads
  // "Open ↗" until clicked, then flips in place to "Done" — one button, two phases, instead of showing
  // both actions side by side.
  const [openedIdx, setOpenedIdx] = useState<number | null>(null);
  // An unrefined task otherwise waits on the next background sweep to pick it up (bounded to 3/sweep, once
  // or a few times a day) — with NO client-driven retry, a failed/slow refine looked permanently stuck with
  // no way out but waiting. Surface a manual retry after a few seconds instead of leaving it an inert spinner.
  const [showRetry, setShowRetry] = useState(false);
  const [retryingRefine, setRetryingRefine] = useState(false);
  useEffect(() => {
    if (!task.unrefined) { setShowRetry(false); return; }
    setShowRetry(false);
    const id = setTimeout(() => setShowRetry(true), 8000);
    return () => clearTimeout(id);
  }, [task.unrefined, task.id]);
  const retryRefine = async () => {
    setRetryingRefine(true);
    try {
      const list = await api.refine(task.id);
      const fresh = list.find((t) => t.id === task.id);
      if (fresh) { onTask(fresh); if (!fresh.unrefined) onRun(); }
    } catch (e: any) { notify(e?.message || L("Échec de la relance.", "Retry failed."), "error"); }
    finally { setRetryingRefine(false); }
  };

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
          ? L("Otto prépare ça tout seul.", "Otto's handling this on its own.")
          : L("Otto prépare ça…", "Otto is getting this ready…")}</p>
        {task.unrefined && showRetry ? (
          <div className="hero-acts">
            <button className="btn ghost" disabled={retryingRefine} onClick={() => void retryRefine()}>
              {retryingRefine ? L("Relance…", "Retrying…") : L("Ça prend du temps — réessayer maintenant", "Taking a while — retry now")}
            </button>
          </div>
        ) : null}
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
        <SendableReview task={task} onTask={onTask} />
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
        <p className="hero-line">{stripStrayMarkdown(subtitle(task) || task.why || "")}</p>
        <div className="hero-acts">
          <button className="btn primary" disabled={running} onClick={() => onRun()}>{running ? L("En cours…", "Working…") : L("Lancer", "Start")}</button>
          {/* Without this, a task Otto hasn't planned yet (or never needed a plan — already handled
              elsewhere, a duplicate, a quick manual note) had no way to be marked done except "Lancer"
              first. Secondary/ghost so it never competes with Start as the obvious next action. */}
          <button className="btn ghost" disabled={running} onClick={onConfirm}>{L("C'est bon", "Looks good")}</button>
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
      {s.minutes ? <SessionTimer key={currentIdx} minutes={s.minutes} /> : null}
      {s.result ? <span className="step-result note">{s.result}</span> : null}
      {/* A step Otto can DO but is missing ONE piece of info for (server sets `question`, optionally
          `options` — see the "submit" tool schema in server/claude.ts) — this used to be computed and
          stored with no UI at all, so the step just sat there with a generic input and no indication of
          what was actually needed. The question IS the label now, tap-to-answer when there are likely
          answers, free text always available as a fallback. Answering RUNS the step (api.runStep), since
          it's automatable — different from the plain "what did you decide" box below. */}
      {s.question ? (
        <div className="step-question">
          <p className="step-question-text">{withInlineLinks(s.question)}</p>
          {s.options?.length ? (
            <div className="step-question-opts">
              {s.options.map((opt, oi) => (
                <button key={oi} type="button" className="btn xs" disabled={answering === currentIdx} onClick={() => onAnswer(currentIdx, opt)}>{opt}</button>
              ))}
              {answering === currentIdx ? <span className="card-spin" aria-hidden="true" /> : null}
            </div>
          ) : null}
          <input
            className="step-input"
            placeholder={s.options?.length ? L("Ou écris ta propre réponse…", "Or type your own answer…") : L("Écris ta réponse…", "Type your answer…")}
            value={decided[currentIdx] || ""}
            disabled={answering === currentIdx}
            onChange={(e) => setDecided((d) => ({ ...d, [currentIdx]: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") onAnswer(currentIdx, decided[currentIdx] || ""); }}
          />
        </div>
      ) : gatesAnother && !s.automatable ? (
        <>
        {/* "What did you decide?" only when this step GATES a later one — then it feeds that next step. A
            persistent label (not just a placeholder, which vanishes once typing starts) so it stays clear
            this is required to move on, not optional extra info. */}
        <label className="step-input-label" htmlFor="step-input-hero">{L("Optionnel — note ce que tu as décidé :", "Optional — note what you decided:")}</label>
        <input
          id="step-input-hero"
          className="step-input"
          placeholder={L("ex : j'ai choisi le sujet X…", "e.g. I picked topic X…")}
          value={decided[currentIdx] || ""}
          onChange={(e) => setDecided((d) => ({ ...d, [currentIdx]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") onStepDone(currentIdx); }}
        />
        </>
      ) : null}
      {/* One button, not three: a step with a link opens it (and — if nothing further is needed from the
          user — marks itself done in the same click); otherwise it flips to "Done" once opened. A step
          with no link is just "Done". "I'm stuck" is dropped here — the tutor chat right below is always
          one glance away, so a dedicated help button on every step was one more thing competing for
          attention for a path that already exists. */}
      {/* A step with a question answers THROUGH that box above (which runs the step) — a separate "C'est
          fait" here would let it be marked done without ever actually answering, so it's dropped. */}
      {!s.question ? (
        <div className="hero-acts">
          {s.url && !(openedIdx === currentIdx) ? (
            <button
              className="btn primary"
              title={s.url}
              onClick={() => {
                openTab(s.url!, TAB_GROUP);
                if (s.automatable) onStepDone(currentIdx);
                else setOpenedIdx(currentIdx);
              }}
            >
              {L(`Ouvrir ${linkKind(s.url, L) || "le lien"} ↗`, `Open ${linkKind(s.url, L) || "link"} ↗`)}
            </button>
          ) : (
            <button className="btn primary" onClick={() => onStepDone(currentIdx)}>{L("C'est fait", "Done")}</button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── panels ─────────────────────────────── */

function StepList({ task, steps, decided, setDecided, onStepDone, onUndo, onAsk, onChange, onTask, onAnswer, answering }: {
  task: WebTask; steps: TaskStep[];
  decided: Record<number, string>; setDecided: Dispatch<SetStateAction<Record<number, string>>>;
  onStepDone: (i: number) => void; onUndo: (i: number) => void; onAsk: (i: number, text: string) => void;
  onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void;
  onAnswer: (i: number, answer: string) => void; answering: number | null;
}) {
  const L = useLang();
  const notify = useNotify();
  const [expanding, setExpanding] = useState<number | null>(null);
  const expandStep = async (i: number) => {
    setExpanding(i);
    try { onChange(await api.expandStep(task.id, i)); }
    catch (e: any) { notify(e?.message || L("Impossible de détailler cette étape.", "Couldn't break this step down."), "error"); }
    finally { setExpanding((cur) => (cur === i ? null : cur)); }
  };
  // "Do it" on an automatable sub-action (a pure lookup — see expandStep's classification): Otto answers
  // it directly instead of the student having to go find it. Keyed "i-subIndex" since two different steps
  // can both have a sub-action running at once.
  const [runningSub, setRunningSub] = useState<string | null>(null);
  const runSubstep = async (i: number, subIndex: number) => {
    const key = `${i}-${subIndex}`;
    setRunningSub(key);
    try { onChange(await api.runSubstep(task.id, i, subIndex)); }
    catch (e: any) { notify(e?.message || L("Otto n'a pas réussi à répondre.", "Otto couldn't get an answer."), "error"); }
    finally { setRunningSub((cur) => (cur === key ? null : cur)); }
  };
  // Optimistic: flip the checkbox instantly (this is the highest-frequency, lowest-latency-tolerance
  // interaction on the card) instead of waiting on the round trip, then reconcile with the server's
  // response — or revert if the call fails, so the UI never lies about what's actually persisted.
  const toggleSubstep = async (i: number, subIndex: number, done: boolean) => {
    const optimistic = steps.map((s, si) => si !== i || !s.substeps ? s
      : { ...s, substeps: s.substeps.map((sub, ssi) => ssi === subIndex ? { ...sub, done } : sub) });
    // onTask merges by id — onChange([...]) here would replace the ENTIRE task list with this one task
    // (onChange is wired straight to App.tsx's setTasks, which takes it as a literal new array, not a patch).
    onTask({ ...task, steps: optimistic });
    try { onChange(await api.substepDone(task.id, i, subIndex, done)); }
    catch (e: any) {
      onTask(task); // revert the optimistic flip
      notify(e?.message || L("Impossible d'enregistrer cette sous-étape.", "Couldn't save this sub-step."), "error");
    }
  };
  const openableCount = steps.filter((s) => s.url && !s.done && !stepBlocked(steps, s)).length;
  // Open ALL of a task's remaining page-steps at once, into one tab group named after the task.
  const openAllPages = async () => {
    const idxs = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.url && !s.done && !stepBlocked(steps, s)).map(({ i }) => i).slice(0, 3);
    if (!idxs.length) return;
    openTabs(idxs.map((i) => steps[i].url!), TAB_GROUP);
    let res: WebTask[] | null = null;
    try {
      for (const i of idxs) if (steps[i].automatable) res = await api.stepDone(task.id, i, true, L("Ouvert ↗", "Opened ↗"));
      if (res) onChange(res);
    } catch (e: any) {
      // The tabs already opened (that part can't fail) — only the "mark done" half failed, so say so
      // without implying the tabs themselves didn't open.
      notify(e?.message || L("Les onglets se sont ouverts, mais l'état n'a pas pu être enregistré.", "The tabs opened, but the state couldn't be saved."), "error");
    }
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
                {!s.done && s.minutes ? <span className="step-minutes">~{s.minutes} {L("min", "min")}</span> : null}
                {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                {!s.done && blk ? <span className="step-dep">{L(`Débloque à l'étape ${(s.dependsOn ?? 0) + 1}`, `Unlocks at step ${(s.dependsOn ?? 0) + 1}`)}</span> : null}
                {s.question && !s.done && !blk ? (
                  <div className="step-question">
                    <p className="step-question-text">{withInlineLinks(s.question)}</p>
                    {s.options?.length ? (
                      <div className="step-question-opts">
                        {s.options.map((opt, oi) => (
                          <button key={oi} type="button" className="btn xs" disabled={answering === i} onClick={() => onAnswer(i, opt)}>{opt}</button>
                        ))}
                      </div>
                    ) : null}
                    <input
                      className="step-input"
                      placeholder={s.options?.length ? L("Ou écris ta propre réponse…", "Or type your own answer…") : L("Écris ta réponse…", "Type your answer…")}
                      value={decided[i] || ""}
                      disabled={answering === i}
                      onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") onAnswer(i, decided[i] || ""); }}
                    />
                  </div>
                ) : gatesAnother && !s.done && !blk && !s.automatable ? (
                  <>
                  <label className="sr-only" htmlFor={`step-input-${i}`}>{L("Réponds ici pour continuer :", "Answer here to continue:")}</label>
                  <input
                    id={`step-input-${i}`}
                    className="step-input"
                    placeholder={L("Ta réponse…", "Your answer…")}
                    value={decided[i] || ""}
                    onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") onStepDone(i); }}
                  />
                  </>
                ) : null}
                {/* On-demand sub-checklist — a step can need its own breakdown ("Write the introduction"
                    inside an essay) without forcing every step through it. Persisted on the step, not
                    ephemeral chat output, so it's there next time the task is opened. */}
                {s.substeps?.length ? (
                  <ul className="substeps">
                    {s.substeps.map((sub, si) => {
                      const subKey = `${i}-${si}`;
                      const subRunning = runningSub === subKey;
                      return (
                      <li key={si} className={`substep ${sub.done ? "done" : ""}`}>
                        <button type="button" className="substep-mark" aria-pressed={sub.done}
                          aria-label={sub.done ? L(`Marquer « ${sub.text} » comme pas encore faite`, `Mark "${sub.text}" as not done`) : L(`Marquer « ${sub.text} » comme faite`, `Mark "${sub.text}" as done`)}
                          onClick={() => void toggleSubstep(i, si, !sub.done)}>
                          <span aria-hidden="true">{sub.done ? "✓" : ""}</span>
                        </button>
                        <span className="substep-text">{sub.text}</span>
                        {sub.result ? <span className="step-result note substep-result">{sub.result}</span> : null}
                        {/* Same "land one click from done" affordance as a parent step's own url — a
                            sub-action can point at a real resource Otto already found (see expandStep). */}
                        {sub.url ? <button type="button" className="btn xs ghost substep-link" title={sub.url} onClick={() => openTab(sub.url!, TAB_GROUP)}>{L(`Ouvrir ${linkKind(sub.url, L) || "le lien"} ↗`, `Open ${linkKind(sub.url, L) || "link"} ↗`)}</button> : null}
                        {/* A pure lookup Otto can just answer (see expandStep's `automatable` classification)
                            instead of the student going to find it themselves. */}
                        {sub.automatable && !sub.done ? (
                          <button type="button" className="btn xs ghost substep-run" disabled={subRunning} onClick={() => void runSubstep(i, si)}>
                            {subRunning ? <span className="spinner xs" aria-hidden="true" /> : null}
                            {subRunning ? L("Otto cherche…", "Otto's looking…") : L("Laisser Otto répondre", "Let Otto answer")}
                          </button>
                        ) : null}
                      </li>
                      );
                    })}
                  </ul>
                ) : !s.done && !blk ? (
                  // Available on any step, not just big-project milestones — a step that reads simple to
                  // Otto can still feel like too much in the moment, so the option to split it further is
                  // always one tap away instead of being reserved for a detected big project.
                  <button type="button" className="btn xs ghost substep-expand" disabled={expanding === i} onClick={() => void expandStep(i)}>
                    {expanding === i ? <span className="spinner xs" aria-hidden="true" /> : null}
                    {expanding === i ? L("Découpage…", "Breaking down…") : L("Détailler cette étape", "Break this step down")}
                  </button>
                ) : null}
              </div>
              <div className="step-act">
                {/* A URL step keeps its "Open ↗" link ALWAYS — even after Otto opened it. */}
                {s.url ? <button className="btn xs ghost" title={s.url} onClick={() => openTab(s.url!, TAB_GROUP)}>{L(`Ouvrir ${linkKind(s.url, L) || "le lien"} ↗`, `Open ${linkKind(s.url, L) || "link"} ↗`)}</button> : null}
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
  const artifactCount = (task.notes?.length || 0) + (task.flashcards?.length || 0) + (task.quizzes?.length || 0);
  return (
    <>
      {task.did?.length ? (
        <>
          {artifactCount > 0 ? <span className="prepared-label">{L("Fait", "Done")}</span> : null}
          <ul className="bullets">{task.did.map((d, i) => <li key={i}>{withInlineLinks(d)}</li>)}</ul>
        </>
      ) : null}
      {/* In-app notes, flashcard decks and quizzes — no external tab, they open right here in a popup.
          Row-card layout (icon badge + title + meta) rather than an inline pill: these are real artifacts
          worth a proper tap target, not tags, and stacking them makes it obvious there are several. The
          "Made for you" label used to only show when `did` ALSO had bullets, so a run that created an
          artifact but wrote no matching `did` bullet (an in-house tool call the model didn't narrate) left
          the chips floating with no heading at all — unclear these were things Otto just made. Show the
          label off artifactCount alone so the chips are never unlabeled. */}
      {artifactCount > 0 ? (
        <>
          <span className="prepared-label">{L("Créé pour toi", "Made for you")}</span>
          <div className="note-chips prepared-chips">
            {task.notes?.map((n) => (
              <button key={n.id} type="button" className="note-chip" onClick={() => onOpenNote(n.id)}>
        <span className="note-chip-icon" aria-hidden="true">▤</span>
                <span className="note-chip-text"><span className="note-chip-title">{n.title}</span><span className="note-chip-meta">{L("Fiche", "Note")}</span></span>
              </button>
            ))}
            {task.flashcards?.map((f) => (
              <button key={f.id} type="button" className="note-chip" onClick={() => onOpenDeck(f.id)}>
                <span className="note-chip-icon" aria-hidden="true">❏</span>
                <span className="note-chip-text"><span className="note-chip-title">{f.title}</span><span className="note-chip-meta">{L(`${f.cards.length} cartes`, `${f.cards.length} cards`)}</span></span>
              </button>
            ))}
            {task.quizzes?.map((qz) => (
              <button key={qz.id} type="button" className="note-chip" onClick={() => onOpenQuiz(qz.id)}>
                <span className="note-chip-icon" aria-hidden="true">?</span>
                <span className="note-chip-text"><span className="note-chip-title">{qz.title}</span><span className="note-chip-meta">{L(`${qz.questions.length} questions`, `${qz.questions.length} questions`)}</span></span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {task.links?.length ? (
        <ul className="links artifacts">{task.links.slice(0, 3).map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer" title={l.url}>{(l.label && l.label !== "Open" ? l.label : linkKind(l.url, L)) || L("Ouvrir le lien", "Open link")} ↗</a></li>)}</ul>
      ) : null}
      {/* Audit trail: what Otto actually called/created/blocked on this task, in plain language — so a
          parent or teacher can verify "never does the work" is enforced, not just claimed. */}
      {task.audit?.length ? (
        <div className="audit-log">
          <button type="button" className="btn xs ghost audit-toggle" aria-expanded={showAudit} onClick={() => setShowAudit((v) => !v)}>
            {L("Journal d'activité", "Activity log")} ({task.audit.length})
          </button>
          {showAudit ? (
            <ul className="audit-list">
              {task.audit.slice().reverse().map((e, i) => (
                <li key={i} className={`audit-${e.kind}`}>
                  <span className="audit-icon" aria-hidden="true">{e.kind === "guardrail" ? "✦" : e.kind === "artifact" ? "✓" : "•"}</span>
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
          <p className="muted small">{L("Dis-lui ce qui bloque. Il explique, il ne donne pas la réponse.", "Say what's blocking you. It'll explain — not hand you the answer.")}</p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            {/* Who said it — was sr-only (screen readers already get this from the region's own role="log"
                context); a bare bubble with no visible label made a longer reply read as an undifferentiated
                blob of text rather than a structured message. */}
            <span className={`chat-sender chat-sender-${m.role}`}>{m.role === "user" ? L("Toi", "You") : "Otto"}</span>
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
                  const icon = a.kind === "note" ? "▤" : a.kind === "deck" ? "❏" : "?";
                  const open = a.kind === "note" ? onOpenNote : a.kind === "deck" ? onOpenDeck : onOpenQuiz;
                  return <button key={a.id} type="button" className="btn xs ghost note-chip" onClick={() => open(a.id)}><span aria-hidden="true">{icon}</span> {a.title}</button>;
                })}
              </div>
            ) : null}
            {/* The exact moment the "won't do your graded work" boundary held, right where it happened —
                not just a line buried in the Activity log. */}
            {m.role === "assistant" && m.guardrail ? (
              <span className="chat-guardrail-tag"><span aria-hidden="true">✦</span> {L("Otto guide, ne fait pas à ta place", "Otto guides, doesn't do it for you")}</span>
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
        <button className="chat-send" aria-label={L("Envoyer", "Send")} disabled={sending || !input.trim()} onClick={onSend}>
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </section>
  );
}

/* ─────────────────────────────── sendables ─────────────────────────────── */

/** The draft-review flow — view, edit in place, ask Otto to rewrite, then a spelled-out confirm before
 *  anything actually sends. Moved wholesale from the old detail view; the interaction is unchanged. */
function SendableReview({ task, onTask }: {
  task: WebTask; onTask: (t: WebTask) => void;
}) {
  const L = useLang();
  const notify = useNotify();
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
    const patch = { subject: edit.subject, body: edit.body };
    setSavingDraft(i);
    try { onTask(await api.editDraft(task.id, i, patch)); setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; }); }
    catch (e: any) {
      // Edit stays pending — the box keeps the user's text so nothing is lost — but say so instead of
      // letting the spinner just stop with no explanation.
      notify(e?.message || L("Enregistrement impossible — réessaie.", "Couldn't save — try again."), "error");
    }
    finally { setSavingDraft(null); }
  };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    // A failed send used to be swallowed entirely — for an irreversible action that's the worst possible
    // silence, so surface it.
    try { onTask(await api.sendDraft(task.id, i)); }
    catch (e: any) { notify(e?.message || L("Envoi impossible — rien n'a été envoyé. Réessaie.", "Couldn't send — nothing was sent. Try again."), "error"); }
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
        const recipients = s.app === "gcal" ? (s.attendees || []).join(", ") : (s.to || "");
        const noun = s.app === "gcal" ? L("l'invitation calendrier", "the calendar invite") : L("l'email", "the email");
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
                  <button className="btn xs" onClick={() => { setConfirmIdx(null); setViewDraft(i); setChangeText(""); setChangeIdx(i); }}>{L("Changer quelque chose", "Change something")}</button>
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
                    {s.to ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to}</span></div> : null}
                    {s.subject ? <div className="draft-row"><span className="draft-label">{L("Objet", "Subject")}</span><span>{s.subject}</span></div> : null}
                    <pre className="draft-body">{s.body || L("Envoyé.", "Sent.")}</pre>
                  </>
                ) : (
                  <>
                    {s.to ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to}</span></div> : null}
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
                      value={draftEdits[i]?.body ?? s.body ?? ""}
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
function ArtifactPopups({ task, onTask, openNote, openDeck, openQuiz, setOpenNote, setOpenDeck, setOpenQuiz }: {
  task: WebTask; onTask: (t: WebTask) => void; openNote: string | null; openDeck: string | null; openQuiz: string | null;
  setOpenNote: (v: null) => void; setOpenDeck: (v: null) => void; setOpenQuiz: (v: null) => void;
}) {
  const note = openNote ? task.notes?.find((x) => x.id === openNote) : null;
  const deck = openDeck ? task.flashcards?.find((x) => x.id === openDeck) : null;
  const quiz = openQuiz ? task.quizzes?.find((x) => x.id === openQuiz) : null;
  // Best-effort: a failed review write shouldn't interrupt the deck (the local right/wrong score still
  // works fine) — the card just doesn't get spaced-repetition-scheduled that one time, no user-facing error.
  const onReview = deck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(task.id, deck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === task.id);
      if (fresh) onTask(fresh);
    }).catch(() => {});
  } : undefined;
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
      {deck ? <TaskModal onClose={() => setOpenDeck(null)} nested title={deck.title}><FlashcardDeck deck={deck} onReview={onReview} taskId={task.id} /></TaskModal> : null}
      {quiz ? <TaskModal onClose={() => setOpenQuiz(null)} nested title={quiz.title}><QuizPlayer quiz={quiz} taskId={task.id} /></TaskModal> : null}
    </>
  );
}
