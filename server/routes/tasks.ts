
import "../env.ts";
import { reportError } from "../sentry.ts";
import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { gapTarget, verifyStepAgainstGap } from "../../shared/mathEquiv.ts";
import { normalizeTable, normalizeSource } from "../../shared/boardTable.ts";
import { gradeGapAnswer, gradeExerciseAnswer, verifyPolynomialDivision } from "../../shared/exerciseVerification.ts";
import { repairSpokenMath, spokenContextFrom } from "../../shared/spokenMath.ts";
import { sealOutgoing, unsealKey } from "../tutorTurn/keySeal.ts";
import { checkProblemAnswer } from "../tutorTurn/problemCheck.ts";
import { nextTeachingState, learningPrefsFrom, mergePrefs, evidenceKindFor, reachedSolutionSteps, resolveGapKey, rehydrateProblemKey } from "../tutor.ts";
import { solveProblem, focusKeyOf, isNewProblem } from "../solver.ts";
import { studentProblemStatement } from "../tutorAdapt.ts";
import { recordConceptEvidence, normalizeStudentModel, emptyStudentModel } from "../studentModel.ts";
import { detectSubject, computedGapKey, solvedGapKey } from "../tutor.ts";
import { runTutorTurn } from "../tutorTurn/engine.ts";
import { logAssistance, settleRetest, buildRecap, dueRetests, sessionMemoryNote } from "../tutorTurn/ledger.ts";
import { selectJournal } from "../journal.ts";
import type { TutorOpenerMemory } from "../claude.ts";
import type { WebTask, Profile, BoardEntry, TaskObjective, TaskProblem } from "../../shared/types.ts";
import { emptyProfile, isHandled, tzOf, addUsage, nextLeitnerReview, practiceAnswerMatches, deadlineEpoch, bumpActivityHour, learnedProductiveHourForSubject } from "../../shared/types.ts";
import { computeWorkload } from "../workload.ts";
import { schoolRecordLine } from "../schoolRecord.ts";
import { applyRememberFact, synthesizeStudentModel, aiReady, classifyProviderError, refineManualTask, chatAboutTask, expandStep, runSubstep, studyHelp, evaluateCheckpoint, needsAdaptiveReplan, computeTaskOutcome, interactiveSceneDocument, INTERACTIVE_SCENE_CSP } from "../claude.ts";
import { loadState, saveState, cloudEnabled, getJob, getLatestJob, eventsForTask, recordEvent, countActiveJobs, activeJobTaskIds, loadBanditState, saveBanditState, recordSessionOutcome, recordMetric, getStudyMetricsSummary, pruneOldData } from "../store.ts";
import { contextKey as banditContextKey, chooseArm, updatePosterior, computeLatencyReward, leadingArm, POMODORO_ARMS, FLASHCARD_ARMS, AUDIO_ARMS, DENSITY_ARMS, ORDERING_ARMS, CHAT_STYLE_ARMS, GRANULARITY_ARMS } from "../bandit.ts";
import { predictNextEngagement, predictWeakSubjects, aggregateSubjectSignals, subjectFrequency, orderingBoost, weakSubjectBoost, twoMinuteRuleBoost, stallNudgeLine } from "../patterns.ts";
import * as tasks from "../tasks.ts";
import * as jobs from "../jobs.ts";
import * as integrations from "../integrations.ts";
import * as pronoteSvc from "../pronote.ts";
import { M, PROD, ah, commit, dailyTurnCap, isPaused, mergeProfiles, mergeTasks, oneTurnAtATime, outgoingTasks, rateLimit, requireAuth, saveSession, scheduler, tasksPayload, toolsFor } from "../http.ts";

/** Response-only slimming of the task list (never persisted): a finished/dismissed tutor session keeps its
 *  whole chat + board + events in the account row, but the client keeps its own session history locally and
 *  never reads them from the list — shipping them on every response was the biggest avoidable payload. */
/** The `spoken` field of a chat request (a message that came from speech recognition): only well-formed
 *  string alternatives survive, capped, so a malformed body can't smuggle anything else into the prompt. */
function spokenFromBody(raw: unknown): { alternatives: string[] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const alts = Array.isArray((raw as any).alternatives) ? (raw as any).alternatives : [];
  return { alternatives: alts.filter((a: unknown): a is string => typeof a === "string").map((a: string) => a.slice(0, 300)).slice(0, 3) };
}

// Simple synchronous task-mutating routes (confirm/reject/dismiss/step-done) used to just `find()` in
// `req.session.tasks` and silently no-op — `res.json(unchanged list)` — if the session was momentarily
// stale, indistinguishable from success to the client. Same reload-and-retry shape `runViaJob` already
// uses for the job-queue routes: only reload from the cloud on a genuine miss (the common case never pays
// the extra round-trip), and only 404 if the task still isn't found after that.
async function findTaskOrReload(req: express.Request, id: string): Promise<WebTask | undefined> {
  let task = (req.session.tasks || []).find((t) => t.id === id);
  if (task || !req.session.user) return task;
  try {
    // bypassCache: this only runs when the task is MISSING from the session — i.e. it was almost certainly
    // just written by another instance (a job that spawned a follow-up task, another tab). A cached read is
    // the one thing guaranteed not to help here, and the miss is what makes the extra round-trip worth it.
    const cloud = await loadState(req.session.user, { bypassCache: true });
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    await saveSession(req);
  } catch { /* fall through to the final lookup — a failed reload just means we still 404 below */ }
  return (req.session.tasks || []).find((t) => t.id === id);
}

// Write-once "the student actually acted on this" stamp (see shared/types.ts's own doc comment) — called
// from confirm/step-done/step-run, the three places a student genuinely starts engaging with a task. Also
// where the granularity bandit (server/bandit.ts) gets its reward: shownAt->firstActionAt IS the
// procrastination-latency signal the plan called for, and this is the only place both timestamps are known
// at once. Best-effort — a bandit hiccup must never block marking a step/task done.
function stampFirstAction(task: WebTask, email?: string, profile?: Profile): void {
  // "When am I actually working" signal (shared/types.ts's activityHours/learnedProductiveHour) — bumped on
  // every genuine action this function is called for (confirm/step-run/step-done), not gated by the
  // write-once firstActionAt check below, since a rich hourly histogram needs every engagement, not just
  // the first one per task.
  if (profile) bumpActivityHour(profile, new Date(), task.sourceSubject);
  if (task.firstActionAt) return;
  task.firstActionAt = new Date().toISOString();
  if (email && task.shownAt) {
    const latencySeconds = (new Date(task.firstActionAt).getTime() - new Date(task.shownAt).getTime()) / 1000;
    void recordMetric(email, "task_time_to_first_action_seconds", latencySeconds, task.source || "n/a");
  }
  if (email && task.shownAt && task.granularityArmId) {
    const latencySeconds = (new Date(task.firstActionAt).getTime() - new Date(task.shownAt).getTime()) / 1000;
    const armId = task.granularityArmId;
    void (async () => {
      try {
        const key = banditContextKey(new Date(), profile);
        const reward = computeLatencyReward(Math.max(0, latencySeconds));
        const state = await loadBanditState(email, "granularity");
        await saveBanditState(email, "granularity", updatePosterior(state, key, armId, reward));
        void recordSessionOutcome({ userEmail: email, decisionKey: "granularity", arm: armId, context: key, reward, at: new Date().toISOString() });
      } catch { /* best-effort */ }
    })();
  }
  // Ordering bandit's reward — the SAME procrastination-latency signal, scored back to whichever ordering
  // arm was in effect the first time this task was shown (see ORDERING_ARMS in bandit.ts + orderingArmId's
  // own comment). A task the ordering strategy surfaced well should get acted on sooner.
  if (email && task.shownAt && task.orderingArmId) {
    const latencySeconds = (new Date(task.firstActionAt).getTime() - new Date(task.shownAt).getTime()) / 1000;
    const armId = task.orderingArmId;
    void (async () => {
      try {
        const key = banditContextKey(new Date(), profile);
        const reward = computeLatencyReward(Math.max(0, latencySeconds));
        const state = await loadBanditState(email, "ordering");
        await saveBanditState(email, "ordering", updatePosterior(state, key, armId, reward));
        void recordSessionOutcome({ userEmail: email, decisionKey: "ordering", arm: armId, context: key, reward, at: new Date().toISOString() });
      } catch { /* best-effort */ }
    })();
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
// Reconcile with the cloud copy on every load, so a task finished on ANOTHER device/tab never shows
// undone here (and never gets pointlessly re-run by this device's auto-run).
/** O(n) "did the merge actually change anything" check — the same cheap id/updatedAt/status signature
 *  mergeTaskLists' fast path uses to skip its O(n²) dedupe. Deliberately NOT a reference check: the fast
 *  path returns the FIRST argument (the cloud copy) when the lists are identical, which is a different
 *  object than the session's copy even when not a single field differs. */
const sameTasksSignature = (a: WebTask[], b: WebTask[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((t) => [t.id, t]));
  for (const t of a) {
    const o = byId.get(t.id);
    if (!o || t.updatedAt !== o.updatedAt || t.status !== o.status) return false;
  }
  return true;
};

// Sweeps run through the DURABLE JOB QUEUE (jobs.ts): this route enqueues + drains inline so the
// interactive path stays synchronous for the client, while the exact same queue is drained by
// /api/cron/drain when the browser is closed. Idempotency (one active sweep job per user) replaces
// the old in-memory inflight map — it holds across serverless instances.
const CONTINUOUS_MONITOR_INTERVAL_MS = 30 * 60 * 1000;

// Per-task coaching chat — grounded in that one task's own context/steps, so a student stuck on it can
// talk it through with Otto without re-explaining the situation. Rate-limited + budget-gated like every
// other interactive AI call; capped history (CHAT_CAP) keeps a long-running task's thread bounded.
// Was 60 — cost pass: this is how much RAW chat history gets resent to the model on EVERY single round of
// EVERY turn, so it's the direct lever on a long session's growing per-call token cost (confirmed live: a
// session's own tokens.in grows turn over turn as this history accumulates). Durable tutoring state (the
// formulas/insights/diagrams actually worth remembering) already lives on the BOARD and in SET_OBJECTIVES,
// which aren't capped this tightly — old raw chat phrasing beyond the last ~15 exchanges is mostly surface
// narration the board has already distilled, not load-bearing context. Halved rather than cut further: still
// comfortably covers "what did we just say two messages ago" continuity, which IS still needed turn to turn.
const CHAT_CAP = 60;

/** The browser's record of recent tutor sessions (sessionMemoryForPrompt), sanitized: it only ever becomes
 *  background text in the prompt, so only short strings survive. */
function memoryFromBody(raw: unknown): TutorOpenerMemory[] {
  if (!Array.isArray(raw)) return [];
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : undefined);
  const strs = (x: unknown) => (Array.isArray(x) ? x.map((y) => str(y, 200)).filter((y): y is string => !!y).slice(0, 6) : []);
  return raw.slice(0, 3).filter((m) => m && typeof m === "object").map((m: any) => ({ when: str(m.when, 40), subject: str(m.subject, 60), lines: strs(m.lines), asked: strs(m.asked), done: strs(m.done) }));
}

/** One tutor turn: what the student said → server/tutor.ts → the board, problems and reply, persisted on the
 *  session's task. The step verdict (code-checked against the open gap) and the problems' answer keys come
 *  from the SERVER's own copy of the board, never from the request. */
async function tutorTurn(
  req: express.Request, res: express.Response, t: WebTask,
  c: { message: string; history: { role: "user" | "assistant"; text: string }[]; currentBoard: BoardEntry[]; currentObjectives: TaskObjective[]; recentJournal: { date: string; text: string; subjects?: string[] }[]; journalMeta?: { total: number; subjects: Record<string, number> }; profile: Profile },
): Promise<void> {
  const { message, history, currentBoard, currentObjectives, profile } = c;
  const turnStart = new Date().toISOString(); // the student's verified step is stamped here, so it sits ABOVE Otto's new lines
  // The session opens with one open question — no subject picker — so the subject is read from what they say.
  if (!t.sourceSubject) {
    const subject = detectSubject([message, ...history.filter((h) => h.role === "user").map((h) => h.text)].join("\n"));
    if (subject) { t.sourceSubject = subject; t.title = `${subject} session`; }
  }
  // Problems on the board WITH their answer keys (the client only sends question/options/solved).
  const sent = Array.isArray(req.body?.problems) ? req.body.problems : [];
  const problems: TaskProblem[] = sent
    .filter((p: any) => p && typeof p.question === "string" && p.question.trim())
    .slice(-12)
    .map((p: any) => {
      // Answer keys for the exercises in play: the server's own stored copy when it still has one, else the
      // key the browser sent back (see rehydrateProblemKey — tutor problems are local-only now). Without this
      // the leak guard couldn't tell whether a reply gave an answer away, and a mis-graded answer box had
      // nothing to be checked against.
      const known = (t.problems || []).find((x) => x.question === p.question);
      // A sealed key token (the browser never holds the key itself) is opened here for the engine; plain keys from an older stored board still work.
      const opened = typeof p.keyToken === "string" ? unsealKey(p.keyToken, String(req.session.user), String(p.id || "")) : null;
      return rehydrateProblemKey(opened ? { ...p, answer: opened.answer, value: opened.value, correct: opened.correct, rubric: opened.rubric, why: opened.why } : p, known);
    });
  const spoken = spokenFromBody(req.body?.spoken);
  const out = await runTutorTurn({
    message, history, board: currentBoard, problems, objectives: currentObjectives, lang: "en",
    voiceMode: req.body?.voiceMode === true, canvasMode: req.body?.canvasMode === true, spoken,
    context: { profile, subject: t.sourceSubject, journal: c.recentJournal, journalMeta: c.journalMeta, schoolRecord: schoolRecordLine(req.session.tasks, profile, t.sourceSubject), memory: memoryFromBody(req.body?.memory) },
  });
  addUsage(profile, out.tokens, "chat");
  bumpActivityHour(profile, new Date(), t.sourceSubject);
  profile.lastTutorActivityAt = new Date().toISOString();
  void recordMetric(req.session.user!, "chat_message_sent", 1);
  if (out.error || !out.reply.trim()) {
    void recordMetric(req.session.user!, "chat_error", 1);
    const kind = String(out.errorKind || "other");
    if (out.error && kind !== "other") {
      // The model provider is down, out of credit, rate-limited or too slow: that is "try again shortly" (503 + Retry-After), not a bug (500).
      void recordMetric(req.session.user!, `chat_provider_${kind}`, 1);
      if (kind === "balance" || kind === "auth") reportError("tutor-provider", new Error(`tutor provider ${kind}`), { kind });
      const wait = kind === "rate" ? 20 : 30;
      res.setHeader("Retry-After", String(wait));
      res.status(503).json({ error: "Otto is briefly unavailable — your message is kept, so try again in a minute (or keep working on the board meanwhile).", code: "tutor_unavailable", retryAfter: wait });
      return;
    }
    res.status(500).json({ error: "Otto couldn't reply just now — try again in a moment." });
    return;
  }
  if (out.guardrailTripped) void recordMetric(req.session.user!, "chat_guardrail_tripped", 1, "freestudy");
  const now = new Date().toISOString();
  const newChat = [
    { role: "user" as const, text: message, at: now },
    { role: "assistant" as const, text: out.reply, at: now, ...(out.problems.length ? { artifacts: out.problems.map((p) => ({ kind: "problem" as const, id: p.id, title: p.question.slice(0, 60) })) } : {}), ...(out.guardrailTripped ? { guardrail: true } : {}) },
  ];
  // Direct request: Tutor session content stays LOCAL, not in the cloud account row — this function only
  // ever runs for primer (Tutor) turns (see its one call site above), so nothing here needs a conditional.
  // The server is stateless for chat/board/problems/objectives: `history`/`currentBoard`/`currentObjectives`
  // above already came FROM the request body (this browser's own client/localChatBoard.ts copy), and the
  // response below hands back only this turn's delta for the client to append locally — t.chat/t.board/
  // t.problems/t.objectives are never written here, and are explicitly cleared if an older account still
  // has them from before this reversal, so nothing lingers in Supabase after the next Tutor turn touches it.
  t.chat = undefined; t.board = undefined; t.problems = undefined; t.objectives = undefined;
  t.updatedAt = now;
  await commit(req);
  // ANSWER KEYS NEVER LEAVE THE SERVER IN THE CLEAR: exercises and answer boxes go to the browser with a sealed token, not their key.
  const sealedOut = sealOutgoing(out.board, out.problems, String(req.session.user));
  res.json({
    reply: out.reply, speech: out.turn?.speech, chatDelta: newChat, board: sealedOut.board, problems: sealedOut.problems, objectives: out.objectives, guardrailTripped: out.guardrailTripped, solvedInChat: out.solvedInChat,
    // A gap they answered right in CHAT is closed on the board too, so its answer box doesn't sit there asking again.
    gapsClosed: [],
    task: { id: t.id, title: t.title, status: t.status, source: t.source, sourceSubject: t.sourceSubject, updatedAt: t.updatedAt, createdAt: t.createdAt },
  });
}

// Execution flows through the durable job queue: enqueue + drain inline (synchronous response for the
// client), with job idempotency as the cross-instance lock — one ACTIVE job per task, held in the DB.
// A second call while one is in flight gets a 409 (the client treats that as "the other run wins").
const runViaJob = async (req: express.Request, res: express.Response, type: "execute_task" | "revise" | "execute_step", input?: any) => {
  const user = req.session.user!;
  const id = String(req.params.id);
  try {
    // drainInline (default true, no override here): this handles every DELIBERATE interactive click — Run
    // now, Revise, Run this step — which must actually DO the work and hand back the real result, not just
    // enqueue and hope the separate background kick loop (client's 4s poll, see App.tsx) picks it up in
    // time. A prior "false" override here left a manual click silently doing nothing but flip the task to
    // "queued" — reported live as "Run now doesn't work". Inline drains take ONE job (jobs.ts),
    // and a run killed by the 300 s function limit is retried once its 6-minute job lock expires.
    const job = await jobs.enqueueAndDrain(user, type, id, input);
    // enqueueJob is idempotent PER TASK, not per job type — if a job of a DIFFERENT kind is already active
    // for this task (e.g. an auto-queued execute_task still running when the user asks to revise), it
    // returns THAT job as-is, silently discarding the new input (the revise note never gets applied).
    // That used to look exactly like "revise does nothing" — no error, no effect. Say so honestly instead.
    if (job.type !== type) {
      res.status(409).json({ error: "Otto is still working on this task — try again in a moment." });
      return;
    }
    // ALWAYS fold the cloud copy in and answer with the task's REAL state — a requeued-after-failure or
    // another-worker-owns-it job is not an error; the task's own status (queued/executing/failed_retryable)
    // tells the truth on the card and the client's kick loop keeps it moving.
    // bypassCache for the same reason as the sweep's fold-in above: the run committed its steps/results on
    // whichever instance drained it, so a cached read here answers with the task's PRE-run state — the run
    // looks like it did nothing. This is the execute-side twin of the "0 new tasks" generate bug.
    const cloud = await loadState(user, { bypassCache: true });
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
    await saveSession(req);
    const t = (req.session.tasks || []).find((x) => x.id === id);
    if (!t) { res.status(404).json({ error: "Not found." }); return; }
    // Only a TERMINAL job failure is an error response — the user needs the message + Retry.
    if (job.status === "failed_terminal") { res.status(500).json({ error: job.last_error || t.lastError || "run failed" }); return; }
    // The job re-checks "paused" against the fresh cloud profile (another device may have paused it) and
    // reports a "skipped: AI paused" success — surface that instead of silently returning an unchanged task.
    const skipNote = typeof job.output?.note === "string" && job.output.note.startsWith("skipped:") ? job.output.note : null;
    if (skipNote?.includes("paused")) { res.status(403).json({ error: "AI is paused — resume it in Settings to run this." }); return; }
    res.json(t);
  } catch (e: any) {
    console.error(`[tasks] ${type} error for task`, id, ":", e);
    // Shared by run/revise/step-run (and every other job-type action routed through this) — responds
    // directly instead of calling next(err), so it bypasses the global route-catchall's Sentry reporting.
    // Needs its own call here to cover this whole action surface.
    reportError("tasks-job-action", e, { type, taskId: id });
    console.error(e);
    res.status(500).json({ error: "run failed" });
  }
};

// Record one quiz attempt (a full pass through the quiz, not per-question) — mirrors the flashcard review
// route above: deterministic, no AI call, just persists the score so it survives closing the popup. Capped
// at 20 attempts, newest last (TaskQuiz.attempts was already reserved for this — see shared/types.ts).
const QUIZ_ATTEMPT_CAP = 20;

export function registerTaskRoutes(app: express.Express): void {
  // Deterministic "this week" workload view — no AI call, just real Pronote homework/tests + open tasks
  // bucketed by day with a relative effort heuristic (see server/workload.ts). Cheap enough to recompute
  // on every request rather than cache/store.
  app.get("/api/workload", requireAuth, async (req, res) => {
    const email = req.session.user!;
    let homework: Awaited<ReturnType<typeof pronoteSvc.pronoteHomework>> = [];
    let tests: Awaited<ReturnType<typeof pronoteSvc.pronoteTests>> = [];
    try {
      if ((await pronoteSvc.pronoteConnected(email)).connected) {
        [homework, tests] = await Promise.all([pronoteSvc.pronoteHomework(email), pronoteSvc.pronoteTests(email)]);
      }
    } catch { /* best-effort — an empty Pronote picture still lets open tasks show */ }
    // Manually-logged exams (server/pronote.ts's PronoteTestItem shape: {id, subject, deadline}) merge in
    // alongside Pronote's own — so a non-Pronote student's workload view isn't just empty.
    const allTests = [...tests, ...(req.session.profile?.manualExams || [])];
    const tasks = (req.session.tasks || []).filter((t) => !isHandled(t.status));
    const { days } = computeWorkload({ homework, tests: allTests, tasks, grades: req.session.profile?.grades, timezone: tzOf(req.session.profile) });
    res.json({ days });
  });

  app.get("/api/tasks", requireAuth, async (req, res) => {
    // Set when this poll actually changed something (a cloud reconciliation, or a first-exposure
    // shownAt/orderingArmId stamp) — the gate for persisting the session at the bottom. Unchanged polls
    // skip the Supabase write entirely.
    let tasksChanged = false;
    // Per-poll ordering boosts, held per task id and applied to the OUTGOING copies only (see withNudge
    // below) — never written back onto req.session.tasks.
    const boosts = new Map<string, number>();
    try {
      if (req.session.user && cloudEnabled()) {
        const sessionTasks = req.session.tasks || [];
        // Validated read (version check ≈ 120 B; the full row only when it changed) so tasks another process just added — the daily
        // sweep — appear on the very next load instead of waiting out the cache.
        const cloud = await loadState(req.session.user, { bypassCache: true });
        const merged = mergeTasks(cloud.tasks || [], sessionTasks);
        // Reconcile the session copy only when the cloud copy actually differs. The overwhelmingly common
        // poll lands with both copies identical, and upserting the FULL session blob (profile + every task
        // + chat history) to Supabase on every /api/tasks tick was a real per-poll CPU + egress cost for a
        // write that carried zero new data. Skipping is safe: every durable change already lives in the
        // cloud row — the session copy is a cache that re-derives the same union on the next real merge.
        if (!sameTasksSignature(merged, sessionTasks)) {
          req.session.tasks = merged;
          tasksChanged = true;
        }
      }
    } catch { /* best-effort — fall back to the session copy */ }
    if (req.session.tasks) {
      tasks.applyDeadlineUrgency(req.session.tasks);
      // Procrastination-latency signal (see shared/types.ts's own doc comment + server/bandit.ts) — stamped
      // the first time a live task is actually returned to the client, i.e. genuinely about to be shown.
      // Write-once: never overwritten once set, so this stays "time of first exposure".
      const now = new Date().toISOString();
      // Sixth bandit target: dashboard ordering (see ORDERING_ARMS in bandit.ts) — a small score nudge layered
      // on top of the existing Eisenhower sort, never replacing it. Best-effort: a bandit hiccup must never
      // block the task list itself.
      try {
        const live = req.session.tasks.filter((t) => !isHandled(t.status));
        const orderingKey = banditContextKey(new Date(), req.session.profile);
        // Cache the drawn arm per context key instead of re-sampling on every poll — Thompson Sampling is a
        // genuinely random draw by design (see chooseArm's own doc comment), so calling it fresh on every
        // /api/tasks request (fired on nearly every click, per the gzip comment above) was reshuffling
        // near-tied tasks' order at random, reported live as "the order of tasks keeps randomly changing."
        // Only re-draws when the bucket itself changes (e.g. morning → afternoon — see contextKey).
        let orderingArm = req.session.orderingArmCache?.key === orderingKey ? req.session.orderingArmCache.armId : undefined;
        // Beta-gated (see Profile.betaFeatures' own doc comment) — "urgency-first" is this app's own
        // baseline ranking philosophy (urgent + important first, per the dashboard's own framing), so it's
        // the correct default, not an arbitrary pick, when personalization is off.
        if (!orderingArm && !req.session.profile?.betaFeatures) {
          orderingArm = "urgency-first";
        } else if (!orderingArm) {
          const orderingState = await loadBanditState(req.session.user!, "ordering");
          orderingArm = chooseArm(ORDERING_ARMS, orderingState, orderingKey).arm.id;
          req.session.orderingArmCache = { key: orderingKey, armId: orderingArm };
        }
        const subjectFreq = subjectFrequency(live);
        // Weak-subject nudge (patterns.ts's weakSubjectBoost) — same "what did you get wrong lately" signal
        // already shown in Settings' "Otto has noticed" panel, but until now never actually fed back into
        // anything: it was computed, displayed, and never touched the dashboard it was describing. Always-on
        // (unlike orderingBoost's arms, which are a bandit EXPERIMENT), since struggling with a subject is a
        // real, unconditional reason to see that subject's tasks a little sooner, not something to A/B test.
        const subjectSignals = aggregateSubjectSignals(req.session.tasks);
        const weakSubjects = predictWeakSubjects(subjectSignals);
        // Use each task's OWN recorded arm once it has one (stamped write-once below, at first exposure) —
        // never the arm freshly picked/cached for THIS request — so a task's boost (and therefore its
        // position relative to its neighbors) never shifts just because the account is now in a different
        // ordering-bandit bucket than when it first appeared. Only a task that hasn't been shown yet uses
        // the current session's arm.
        // Boosts are computed per request and applied RESPONSE-ONLY below. They used to be added straight
        // into t.score here — which re-ran on EVERY poll, so a live task's persisted score grew by up to
        // +0.3 per tick: the ETag on this route never matched (every poll shipped the full body), every
        // poll also wrote the inflated scores back to Supabase, and the drift eventually reshuffled
        // near-tied tasks ("the order keeps randomly changing"). The same deterministic boost applied once
        // per request produces the identical intended ordering — without compounding.
        for (const t of live) boosts.set(t.id, orderingBoost(t, t.orderingArmId || orderingArm, subjectFreq) + weakSubjectBoost(t, weakSubjects, subjectSignals) + twoMinuteRuleBoost(t));
        for (const t of req.session.tasks) { if (!t.shownAt && !isHandled(t.status)) { t.shownAt = now; t.orderingArmId = orderingArm; tasksChanged = true; } }
      } catch {
        for (const t of req.session.tasks) { if (!t.shownAt && !isHandled(t.status)) { t.shownAt = now; tasksChanged = true; } }
      }
    }
    // Deferred session persist — only when THIS poll actually changed something (see tasksChanged above;
    // saveSession never rejects, so this stays safe to fire-and-forget).
    if (tasksChanged) void saveSession(req);
    // Spark-vs-facilitator nudge (patterns.ts's stallNudgeLine) — computed fresh on every request, never
    // stored: it depends on "how many days since shown", which changes on its own even with nothing else
    // touched. Attached only to the OUTGOING copy, never written back onto req.session.tasks, so it can never
    // leak into cloud storage or a cross-device merge.
    const withNudge = outgoingTasks(req.session.tasks).map((t) => {
      if (isHandled(t.status)) return t;
      // Apply this request's ordering boost to the OUTGOING copy only (see the boosts map above) — the
      // persisted score stays the clean Eisenhower base, so the boost can't compound poll over poll.
      const boost = boosts.get(t.id) || 0;
      return { ...t, ...(boost ? { score: (t.score || 0) + boost } : {}), nudgeLine: stallNudgeLine(t, req.session.profile) || undefined };
    });
    // ETag: poll loops hit this on every tick — a hash-gated 304 means 0 bytes egress on the
    // overwhelming-majority of polls where nothing actually changed since the last fetch. (Only true now
    // that the ordering boosts are response-only — while they mutated persisted scores on every poll, the
    // body changed every tick and every poll paid the full payload.)
    const tasksJson = JSON.stringify(tasksPayload(req, req.session.tasks, withNudge));
    const etag = `"${createHash("sha1").update(tasksJson).digest("hex").slice(0, 16)}"`;
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    res.type("json").send(tasksJson);
  });

  // Pattern recognition (server/patterns.ts) — predicts the student's next likely move from data already on
  // the account: when they're likely to engage next, and which subject's flashcards/quizzes show a genuine
  // struggle pattern. Read-only, synchronous (no metrics-log query — reads the same task data the student's
  // own decks already show), so this is cheap enough to compute on every call, no caching needed.
  app.get("/api/patterns/summary", requireAuth, ah(async (req, res) => {
    const profile = req.session.profile;
    const signals = aggregateSubjectSignals(req.session.tasks || []);
    const weakSubjects = predictWeakSubjects(signals);
    // Full transparency pass, per direct instruction ("make all info learned transparent through settings") —
    // every bandit's CURRENT belief (leadingArm: the highest-posterior-mean arm, deterministic, not a
    // Thompson-Sampling draw — see its own doc comment for why this must not be the same function that makes
    // the actual decision) alongside the existing pattern predictions, in ONE request. Best-effort per bandit:
    // one bandit's storage hiccup must never blank out the others' — this is a read-only summary, nothing here
    // can be allowed to look worse than "that one line is just missing".
    const email = req.session.user!;
    const key = banditContextKey(new Date(), profile);
    const bandits: Record<string, { armId: string; confidence: number } | null> = {};
    for (const [decisionKey, arms] of Object.entries({
      pomodoro: POMODORO_ARMS, flashcards: FLASHCARD_ARMS, granularity: GRANULARITY_ARMS,
      audio: AUDIO_ARMS, density: DENSITY_ARMS, ordering: ORDERING_ARMS, chatstyle: CHAT_STYLE_ARMS,
    })) {
      try {
        const state = await loadBanditState(email, decisionKey);
        const leading = leadingArm(arms as { id: string }[], state, key);
        bandits[decisionKey] = leading ? { armId: leading.arm.id, confidence: leading.confidence } : null;
      } catch { bandits[decisionKey] = null; }
    }
    // Study/concentration metrics — same "real, already-computed, best-effort" posture as the bandits above;
    // a storage hiccup here must never blank out the rest of this summary.
    let studyMetrics = null;
    try { studyMetrics = await getStudyMetricsSummary(email); } catch { /* best-effort */ }
    // Per-subject mastery (correct-rate + trend, already computed above for weakSubjects) — surfaced directly
    // rather than only as the derived weak-subject list, so "What Otto knows about you" can show the full
    // picture ("Physics 82%, trending up") not just a binary weak/not-weak flag. Sorted weakest-first, same as
    // predictWeakSubjects's own ordering, so the most actionable subject reads first.
    const subjectMastery = signals
      .filter((s) => s.attempts >= 3)
      .sort((a, b) => a.correctRate - b.correctRate)
      .map((s) => ({ subject: s.subject, correctRate: s.correctRate, attempts: s.attempts, trend: s.trend }));
    // Per-subject focus-time reads (shared/types.ts's learnedProductiveHourForSubject) — only surfaced once
    // there's real evidence for that subject, same cold-start gating as the global "most active around" line.
    const subjectFocus = signals
      .map((s) => ({ subject: s.subject, peak: learnedProductiveHourForSubject(profile, s.subject) }))
      .filter((s): s is { subject: string; peak: { hour: number; confidence: number } } => !!s.peak && s.peak.confidence >= 0.3);
    res.json({
      predictedEngagement: predictNextEngagement(profile),
      weakSubjects,
      subjectMastery,
      subjectFocus,
      bandits,
      studyMetrics,
    });
  }));

   // min gap between background sweeps
  app.post("/api/tasks/generate", requireAuth, rateLimit(10, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to sweep for new tasks." }); return; }
    try {
      const user = req.session.user!;
      const force = req.body?.force === true; // the manual Refresh button — always run a REAL sweep
      const lastGenTime = Date.parse(req.session.lastGenTime || "") || 0;
      if (!force && Date.now() - lastGenTime < CONTINUOUS_MONITOR_INTERVAL_MS && (req.session.tasks || []).length) {
        res.json({ tasks: req.session.tasks, note: "" }); return; // watched recently — serve the current list
      }
      const extras = await toolsFor(req);
      // Pronote is read outside the Composio toolset entirely (server/discover.ts calls it directly), so a
      // Pronote-only lycéen with no Gmail connected must still be able to sweep — gating on Composio tools
      // alone used to hard-block them here even though the deterministic pipeline already supports this.
    const pronoteOn = (await pronoteSvc.pronoteConnected(user)).connected;
    if (!extras?.tools?.length && !pronoteOn) {
      res.status(400).json({ error: "Connect Gmail, Google Calendar, or Pronote in Settings so Otto has something to read." });
      return;
    }
      const job = await jobs.enqueueAndDrain(user, "sweep");
      if (job.status === "succeeded") req.session.lastGenTime = new Date().toISOString();
      // The job committed to the CLOUD copy — fold it into this session so the response reflects it.
      // bypassCache is REQUIRED here, not an optimization: the sweep may well have run its commit on a
      // different serverless instance than the one serving this request, so a cached read can return state
      // that predates the job's own write — i.e. the tasks it just generated are simply missing, and the
      // student sees "0 new tasks" from a sweep that actually found several. Same reasoning (and the same
      // fix) as the post-job reads further down this file that already pass it.
      const cloud = await loadState(user, { bypassCache: true });
      req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
      await saveSession(req);
      // The sweep's own result line ("swept: 3 new tasks, 2 queued" / "skipped: nothing connected") — the
      // client shows THIS instead of guessing, so a skipped sweep can never masquerade as "no new tasks".
      const note = job.status === "succeeded" ? String(job.output?.note || "") : `sweep ${job.status}: ${job.last_error || "still running"}`;
      res.json({ tasks: req.session.tasks, note });
    } catch (e: any) {
      console.error("[tasks] generate error:", e);
      // Responds directly instead of calling next(err) — bypasses the global route-catchall (below) that
      // would otherwise report this to Sentry, so it needs its own call here.
      reportError("tasks-generate", e);
      console.error(e);
      res.status(500).json({ error: "generate failed" });
    }
  });

  app.post("/api/tasks", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    const title = String(req.body?.title || "").trim();
    if (!title) { res.status(400).json({ error: "title required" }); return; }
    // Idempotency key — the client sends its own local stub id. Without this, a retried request (the client's
    // own retry-on-dropped-response logic in api.ts's `req()`, or a plain double-click before the button
    // disabled) created a SECOND task for the same submission — reported live as "manual tasks are sometimes
    // generated twice". A replay of an already-applied clientId is a no-op: return the current list as-is,
    // no refine call, no enqueue, no duplicate.
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.slice(0, 80) : undefined;
    if (clientId && (req.session.tasks || []).some((t) => t.clientId === clientId)) { res.json(tasksPayload(req, req.session.tasks)); return; }
    // Optional explicit date (personal commitments — a job shift, a club meeting, an appointment) from a
    // native <input type="date">: only accept a real calendar date, never arbitrary free text here (that's
    // what the title/AI-refinement path is for) — a bad value silently becomes "no date" rather than a 500.
    const explicitWhen = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.when || "")) ? String(req.body.when) : undefined;
    // Refine the raw note into a crisp, specific task title UP FRONT (one quick call) so the card reads well
    // immediately — "send email to mmachi excusing that the ai service wasnt working in weave" becomes
    // "Email Mmachi apologizing for the Weave AI outage". This was previously left to the execution run as a
    // side effect, but that isn't reliable (the run can defer, fail, or not return a title), so a vague raw
    // title stuck around on the card. The execution run can still further sharpen it. When AI is
    // unavailable/paused/over budget, it goes in unrefined and the background sweep's auto-refine cleans it up.
    const ready = aiReady() && !isPaused(req);
    const refined = ready ? await refineManualTask(title, req.session.profile, schoolRecordLine(req.session.tasks, req.session.profile)).catch(() => null) : null;
    if (refined) addUsage(req.session.profile ||= emptyProfile(), refined.tokens, "manual_refine");
    try {
      req.session.tasks = tasks.addManual(req.session.tasks || [], title, refined, !ready, explicitWhen, clientId);
      const added = req.session.tasks[0];
      if (ready) added.status = "queued";
      if (req.session.user) { void recordMetric(req.session.user, "task_manual_added", 1); void recordMetric(req.session.user, "task_created", 1, "manual"); }
      // Persist the task to the cloud BEFORE enqueuing its execution job. The job runner reads task state from
      // the cloud (jobs.ts loadUser); enqueuing first opened a race where a concurrent drainer (another tab's
      // kick, or a cron tick) could claim the job before the commit landed and get "task not found" — which
      // marks the job succeeded and strands the task at "queued". Commit-then-enqueue closes that window —
      // but ONLY if the cloud write is actually awaited: commit()'s own cloud sync is deliberately
      // backgrounded (fire-and-forget, see its comment) for the OTHER ~20 call sites that don't immediately
      // hand off to the job runner. Awaiting the session save alone left this route with the exact race the
      // comment above claims is closed — the drain would read stale cloud state, miss the brand-new task, and
      // strand it at "queued" forever (reported live: "when i create task it just keep on queued with no
      // progress"). So this route needs its own awaited cloud write, not the shared backgrounded one.
      await saveSession(req);
      if (req.session.user) {
        const email = req.session.user;
        try {
          const current = await loadState(email);
          const mergedTasks = mergeTasks(current.tasks || [], req.session.tasks || []);
          const mergedProfile = mergeProfiles(current.profile || emptyProfile(), req.session.profile || emptyProfile());
          await saveState(email, { profile: mergedProfile, tasks: mergedTasks });
        } catch { /* best-effort — enqueueAndDrain below still has its own commitUser merge-on-write */ }
      }
      if (ready) {
        // enqueueAndDrain("execute_task") is the SINGLE planning pass: runTask() reads every connected integration
        // (Gmail/Calendar/Drive/Slack/GitHub/Notion) + web_search and fills in task.context/task.steps. Plan-only
        // mode (EXECUTION_ENABLED=false in claude.ts) already withholds every write tool, so this only gathers
        // knowledge and produces a plan — it never sends/creates/deletes anything.
        // Draining inline (not just enqueueJob) matters here: without it the task sat at "queued" until the
        // next cron tick or manual Kick — on Vercel Hobby cron that's once a day — which is exactly the "stuck
        // on Queued with no progress" bug reported live from a fresh manual task.
        try { await jobs.enqueueAndDrain(req.session.user!, "execute_task", added.id, undefined, false); } catch { /* client kick / cron will still pick it up */ }
      }
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't add that task — try again." });
    }
  });

  // ONE interactive board scene (CREATE_INTERACTIVE), served as its own HTML document for an iframe to
  // navigate to. Why a route instead of the iframe's own `srcdoc`: a srcdoc frame INHERITS the embedding
  // page's CSP, and this app's policy has no 'unsafe-inline' in script-src — so every scene's script (the
  // model's and our blank-guard alike) was silently blocked and the frame rendered empty. A real same-origin
  // navigation gets its own, much tighter policy from the headers below instead (INTERACTIVE_SCENE_CSP).
  // X-Frame-Options must also be relaxed from the global DENY, or our own same-origin iframe can't load it.
  // NOTE: vercel.json's headers rule re-applies the app CSP + X-Frame-Options: DENY at the EDGE to every path
  // it matches, which would undo both of those in production — its `source` regex therefore excludes
  // `api/interactive/` explicitly. Keep that exclusion in sync with this route's path (JSON can't hold a
  // comment saying so, which is why it's said here).
  // The frame itself still carries sandbox="allow-scripts" with NO allow-same-origin (BoardArtifact.tsx), so
  // the scene runs in an opaque origin regardless of what this document is allowed to do.
  // Grade a student's answer to a board gap ("b = ?") by CODE, not by the model: the gap's expectedAnswer is read
  // from the server's own copy of the board and compared by numeric equivalence (shared/mathEquiv.ts), so
  // "h/tan(25°)", "\\frac{h}{\\tan 25^\\circ}" and "h cot 25°" are all right. "unknown" (an answer the checker
  // can't parse) is never reported as wrong — the tutor reads it in chat instead. The key never leaves here.
  app.post("/api/tasks/:id/board/:entryId/check", requireAuth, rateLimit(120, 60_000), ah(async (req, res) => {
    const t = await findTaskOrReload(req, String(req.params.id));
    const entry = (t?.board || []).find((e) => e.id === String(req.params.entryId));
    // The tutor's board is LOCAL-ONLY now (client/localChatBoard.ts) — the server no longer keeps a copy of the
    // gap it is being asked to grade, so the line (and the key written with it) ride up with the answer. The
    // line is still what decides the key wherever it can be solved (see resolveGapKey), so a stored copy being
    // absent changes where the key comes from, never how trustworthy the grade is. A task that no longer exists
    // is no longer a 404 either: nothing here needs it.
    const sentText = typeof req.body?.text === "string" ? req.body.text.slice(0, 600) : "";
    // The key arrives SEALED (opened here, bound to this student and this entry); a plain key from an older stored board still works.
    const sentKey = unsealKey(req.body?.keyToken, String(req.session.user), String(req.params.entryId))?.expectedAnswer ?? (typeof req.body?.expectedAnswer === "string" ? req.body.expectedAnswer.slice(0, 200) : undefined);
    const line = entry?.text ?? sentText;
    if (entry && entry.kind !== "gap") { res.status(404).json({ error: "Not found." }); return; }
    if (!line.trim()) { res.status(404).json({ error: "Not found." }); return; }
    const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 300) : "";
    if (!answer.trim()) { res.status(400).json({ error: "Write an answer first." }); return; }
    const target = gapTarget(line);
    // A closed calculation's key is recomputed here, so a gap written with a guessed key still grades right.
    const recomputed = computedGapKey(line) ?? solvedGapKey(line);
    const storedKey = entry?.expectedAnswer ?? sentKey;
    const key = resolveGapKey(line, entry?.expectedAnswer, sentKey) ?? storedKey;
    if (!key) { res.status(404).json({ error: "Not found." }); return; }
    // Spec §19.4: the stored key and the key recomputed by code must AGREE. When they don't, the key — not the
    // student — is what's broken, so the item enters a system-error state instead of grading them wrong
    // (reported live: a correct equilibrium price P = 8 was "checked wrong" against a model-written key).
    const graded = gradeGapAnswer(storedKey, recomputed, target, answer);
    let verdict: "correct" | "incorrect" | "unknown" | "system_error" = graded.verdict;
    if (verdict === "unknown") verdict = verifyPolynomialDivision(line, answer) ?? verdict;
    if (verdict === "unknown" && practiceAnswerMatches(answer, key)) verdict = "correct";
    if (graded.keyConflict) void recordMetric(req.session.user!, "gap_key_conflict", 1);
    // `display` is the VERIFIED value the board line is completed with — never the text they typed.
    res.json({ verdict, verification: graded.verification, keyConflict: graded.keyConflict, ...(verdict === "correct" ? { display: String(key).slice(0, 80) } : {}) });
  }));

  // Grade one answer to a tutor exercise: the key is sealed in the token (never in the browser), so the server decides and returns only what the student has earned.
  app.post("/api/tasks/:id/problem/check", requireAuth, rateLimit(120, 60_000), ah(async (req, res) => {
    const r = checkProblemAnswer(String(req.session.user), req.body, false);
    res.status(r.status).json(r.json);
  }));

  app.get("/api/interactive/:taskId/:entryId", requireAuth, rateLimit(120, 60_000), (req, res) => {
    const t = (req.session.tasks || []).find((x) => x.id === String(req.params.taskId));
    const entry = (t?.board || []).find((e) => e.id === String(req.params.entryId));
    if (!t || !entry || entry.kind !== "interactive" || !entry.html) { res.status(404).type("text/plain").send("Not found"); return; }
    res.setHeader("Content-Security-Policy", INTERACTIVE_SCENE_CSP);
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "no-store");
    res.type("text/html; charset=utf-8").send(interactiveSceneDocument(entry.html));
  });

  // Refine an UNREFINED manual task (one added while AI was paused/unavailable) now that AI is back.
  app.post("/api/tasks/:id/refine", requireAuth, rateLimit(10, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to refine." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
    if (!t) { res.status(404).json({ error: "Not found." }); return; }
    try {
      const refined = await refineManualTask(t.title, req.session.profile, schoolRecordLine(req.session.tasks, req.session.profile, t.sourceSubject));
      if (refined) addUsage(req.session.profile ||= emptyProfile(), refined.tokens, "manual_refine");
      tasks.applyRefinement(req.session.tasks || [], t.id, refined);
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't refine that task — try again." }); }
  });

  // Regenerate steps for an existing task using the new architecture
  app.post("/api/tasks/:id/regenerate", requireAuth, rateLimit(5, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to regenerate." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
    if (!t) { res.status(404).json({ error: "Not found." }); return; }
    try {
      const { writeStepsFromContext } = await import("../claude.ts");
      const profile = req.session.profile || emptyProfile();
      
      // Regenerate steps using the new architecture
      const stepsResult = await writeStepsFromContext(
        {
          title: t.title,
          why: t.why,
          source: t.source,
          sourceSubject: t.sourceSubject,
          sourceDetail: t.sourceDetail,
          sourceDue: t.sourceDue,
          taskType: t.taskType,
          goal: t.goal,
          infoRequirement: t.infoRequirement,
          unknowns: t.unknowns,
        },
        t.context || "",
        t.links || [],
        t.steps || [], // fallback to current steps
        [], // no sibling tasks for regeneration
        [], // no did array for regeneration
        profile,
        false, // not a big project for regeneration
      );
      
      // Update the task with new steps
      const taskIndex = (req.session.tasks || []).findIndex((x) => x.id === t.id);
      if (taskIndex >= 0) {
        req.session.tasks![taskIndex].steps = stepsResult.steps;
        req.session.tasks![taskIndex].updatedAt = new Date().toISOString();
        await commit(req);
      }
      
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) {
      console.error("[tasks] regenerate error:", e);
      console.error(e);
      res.status(500).json({ error: "Couldn't regenerate steps — try again." });
    }
  });

  // Cleanup artifact creation steps from all existing tasks (migration for old tasks)
  app.post("/api/tasks/cleanup-artifact-steps", requireAuth, rateLimit(2, 60_000), async (req, res) => {
    const { cleanupArtifactCreationSteps } = await import("../claude.ts");
    try {
      let totalCleaned = 0;
      for (const task of req.session.tasks || []) {
        if (task.steps && task.steps.length) {
          const before = task.steps.length;
          task.steps = cleanupArtifactCreationSteps(task.steps);
          const after = task.steps.length;
          totalCleaned += (before - after);
        }
      }
      if (totalCleaned > 0) {
        await commit(req);
      }
      res.json({ cleaned: totalCleaned, tasks: req.session.tasks || [] });
    } catch (e: any) {
      console.error("[tasks] cleanup error:", e);
      console.error(e);
      res.status(500).json({ error: "Couldn't cleanup steps — try again." });
    }
  });

  // END OF A SITTING: the recap, built by code from the turn records and the board the client sends (the board lives in
  // the browser). Every line traces to a record; nothing here asks the model what the student "mastered".
  app.post("/api/tasks/:id/tutor/close", requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const t = await findTaskOrReload(req, String(req.params.id));
    if (!t) { res.status(404).json({ error: "Not found." }); return; }
    const profile = req.session.profile ||= emptyProfile();
    const board = Array.isArray(req.body?.board) ? (req.body.board as BoardEntry[]).slice(-200) : [];
    const objectives = Array.isArray(req.body?.objectives) ? (req.body.objectives as TaskObjective[]).slice(0, 12) : t.objectives;
    const recap = buildRecap({ log: t.tutorState?.log || [], board, objectives, lang: "en" });
    const due = dueRetests(profile.assistance, new Date()).map((a) => a.skill).slice(0, 5);
    res.json({ recap, retestsDue: due });
    // AFTER the answer (the student has already left): the tutor adds to what Otto knows about them. Only labels from the
    // code-built recap go into the profile (objectives, misconceptions) — never the conversation, which stays on the device.
    try {
      const note = sessionMemoryNote(t.sourceSubject, recap);
      if (note) {
        applyRememberFact(profile, "session", note);
        profile.lastTutorActivityAt = new Date().toISOString();
        // "How Otto sees you" is refreshed at most once a day, in every mode (tutor-only accounts have no daily sweep to do it).
        if (jobs.shouldRefreshStudentModel(profile)) {
          const synth = await synthesizeStudentModel(profile, req.session.tasks || []);
          if (synth) { profile.studentModel = { summary: synth.summary, updatedAt: new Date().toISOString(), basedOnActivityAt: profile.lastTutorActivityAt }; addUsage(profile, synth.tokens, "student_model"); }
        }
        await commit(req);
      }
    } catch (e: any) { console.warn("[tutor/close] memory update failed:", String(e?.message || e)); }
  });

  app.post("/api/tasks/:id/chat", requireAuth, rateLimit(10, 60_000), dailyTurnCap(), oneTurnAtATime, async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    if (!message) { res.status(400).json({ error: "Say something first." }); return; }
    let t = await findTaskOrReload(req, String(req.params.id));
    if (!t) {
      // Last resort for a LIVE tutor session whose task never reached this instance or the cloud row (the
      // cross-instance race above): rebuild it from what the client sent rather than 404 every message —
      // the board, chat and problems ride along with every turn anyway, so nothing is lost.
      const rebuilt = tasks.recoverTutorTask(String(req.params.id), req.body, req.session.tasks || [], req.session.profile?.language === "en");
      if (rebuilt) {
        console.warn("[chat] rebuilt missing freestudy task", rebuilt.id);
        req.session.tasks = [...(req.session.tasks || []), rebuilt];
        t = rebuilt;
      }
    }
    if (!t) { res.status(404).json({ error: "Not found." }); return; }
    

    
    // The "Aide" button on a step (see F) sends its own index — validate the range server-side, never trust
    // it blindly (steps get regenerated on every rerun, so a stale index from an old page load could point
    // anywhere or nowhere).
    const stepIndexRaw = req.body?.stepIndex;
    const stepIndex = Number.isInteger(stepIndexRaw) && stepIndexRaw >= 0 && stepIndexRaw < (t.steps?.length || 0) ? stepIndexRaw : undefined;
    // Study Mode materials (client-extracted PDF text, see client/study/pdfText.ts) — optional, capped here
    // too (defense in depth; chatAboutTask's materialsBlock caps again) since this is client-controlled input.
    const materialsRaw = Array.isArray(req.body?.materials) ? req.body.materials : [];
    const materials = materialsRaw
      .filter((m: any) => m && typeof m.label === "string" && typeof m.text === "string" && m.text.trim())
      .slice(0, 8)
      .map((m: any) => ({ label: String(m.label).trim().slice(0, 120), text: String(m.text).trim().slice(0, 6000) }));
    // Chat history is now CLIENT-OWNED, not read from the task (t.chat is never written server-side anymore
    // — see this route's own end-of-handler comment). The browser sends its own local thread with every
    // message, same shape/pattern /api/tasks/:id/study-help already used for its (always-local) hint chat.
    const historyRaw = Array.isArray(req.body?.history) ? req.body.history : [];
    const history: { role: "user" | "assistant"; text: string }[] = historyRaw
      .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map((h: any) => ({ role: h.role as "user" | "assistant", text: String(h.text).slice(0, 4000) }));
    // How the session BEGAN (the problem/equation as the student first stated it) is pinned verbatim for the tutor
    // even once the thread outgrows the window — otherwise a long session forgets what it was about.
    const opening = history.length > 24 ? history.slice(0, 3).map((h) => ({ role: h.role, text: h.text.slice(0, 700) })) : [];
    history.splice(0, Math.max(0, history.length - CHAT_CAP));
    // Same client-owned pattern for what's CURRENTLY on the board — without this the model can write to the
    // board but has no idea what's already there (reported live: it referenced "that triangle" and had no
    // answer when the student said they couldn't see what it meant — it had never been told).
    const currentBoardRaw = Array.isArray(req.body?.board) ? req.body.board : [];
    const currentBoard = currentBoardRaw
      .filter((b: any) => b && typeof b.text === "string" && b.text.trim() && b.archived !== true)
      .slice(-60)
      .map((b: any) => ({ id: typeof b.id === "string" ? b.id.slice(0, 64) : "", at: "", text: String(b.text).slice(0, 600), ...(Number.isInteger(b.n) && b.n > 0 && b.n < 10000 ? { n: b.n } : {}), ...(typeof b.targetId === "string" ? { targetId: b.targetId.slice(0, 64) } : {}), ...(typeof b.kind === "string" ? { kind: b.kind } : {}), ...(Array.isArray(b.diagram) ? { diagram: b.diagram.slice(0, 40).filter((o: any) => o && typeof o.op === "string") } : {}), ...(b.kind === "table" && b.table ? (() => { const r = normalizeTable(b.table); return "table" in r ? { table: r.table } : {}; })() : {}), ...(b.kind === "source" && b.source ? (() => { const r = normalizeSource(b.source); return "source" in r ? { source: r.source } : {}; })() : {}), ...(b.kind === "outline" && Array.isArray(b.outline) ? { outline: b.outline.slice(0, 6).map((s: any) => ({ heading: String(s?.heading || "").slice(0, 120), bullets: (Array.isArray(s?.bullets) ? s.bullets : []).map((x: any) => String(x).slice(0, 200)).slice(0, 8) })) } : {}),
        // Ownership/status/concept — dropped here before (only text/kind/diagram/outline survived the
        // client round-trip), which silently defeated boardSurfaceBlock's "STUDENT'S WORK"/"marked WRONG"
        // tags and tagStudentAnswer's own target-finding downstream: both need these to actually be present.
        ...(b.owner === "student" || b.owner === "otto" ? { owner: b.owner } : {}),
        ...(b.status === "correct" || b.status === "incorrect" ? { status: b.status } : {}),
        ...(typeof b.concept === "string" && b.concept.trim() ? { concept: b.concept.trim().slice(0, 80) } : {}),
        // The gap's "what to do next" chip (BoardArtifact) — dropped here with owner/status before, which
        // silently reverted every gap to the generic "Your turn to finish" after one round trip.
        ...(typeof b.gapAction === "string" && b.gapAction.trim() ? { gapAction: b.gapAction.trim().slice(0, 60) } : {}),
        // A gap's answer key: recomputed from the line by code first, then the server's own stored copy, then
        // the key the browser sent with the line (see resolveGapKey — the tutor board is local-only now, so
        // the request body is the ONLY source for a session this server never stored a board for). Without a
        // key the open-gap leak guard and the step verdict below would only ever see gaps written this turn.
        ...(b.kind === "gap" && typeof b.id === "string" ? (() => { const stored = (t.board || []).find((e) => e.id === b.id); const sealed = unsealKey(b.keyToken, String(req.session.user), b.id)?.expectedAnswer; const k = resolveGapKey(String(b.text), stored?.expectedAnswer, sealed ?? (typeof b.expectedAnswer === "string" ? b.expectedAnswer : undefined)); return k ? { expectedAnswer: k } : {}; })() : {}) }));
    const currentProblemsRaw = Array.isArray(req.body?.problems) ? req.body.problems : [];
    const currentProblems = currentProblemsRaw
      .filter((p: any) => p && typeof p.question === "string" && p.question.trim())
      .slice(-12)
      .map((p: any) => ({ id: "", createdAt: "", solved: p.solved === true, question: String(p.question).slice(0, 600), ...(Array.isArray(p.options) ? { options: p.options.map((o: any) => String(o).slice(0, 300)).slice(0, 6) } : {}) }));
    const currentObjectivesRaw = Array.isArray(req.body?.objectives) ? req.body.objectives : [];
    const currentObjectives: { id: string; label: string; done: boolean }[] = currentObjectivesRaw
      .filter((o: any) => o && typeof o.label === "string" && o.label.trim())
      .slice(-6)
      .map((o: any) => ({ id: "", label: String(o.label).slice(0, 160), done: Boolean(o.done) }));
    try {
      let academic: { homework: Awaited<ReturnType<typeof pronoteSvc.pronoteHomework>>; tests: Awaited<ReturnType<typeof pronoteSvc.pronoteTests>> } | undefined;
      // The tutor stage never uses Pronote homework or connected-app tools, so those network round-trips (sequential, each
      // easily 1-3s) are skipped for Primer turns — pure latency.
      try {
        if (req.body?.primer !== true && (await pronoteSvc.pronoteConnected(req.session.user!)).connected) {
          const [homework, tests] = await Promise.all([pronoteSvc.pronoteHomework(req.session.user!), pronoteSvc.pronoteTests(req.session.user!)]);
          if (homework.length || tests.length) academic = { homework, tests };
        }
      } catch { /* best-effort */ }
      // Ensure a profile object exists BEFORE the call (not after, as it used to be here) — chatAboutTask can
      // now mutate it in place via the "remember" tool, so it needs a real object to write into for that to
      // ever take effect, not just for the token-usage bump that used to be the only reason this existed.
      const profile = req.session.profile ||= emptyProfile();
      // Read-only connected-account access (e.g. "did my teacher already reply?") — integrations.readOnly()
      // strips every write action at both the schema and call level before chatAboutTask ever sees it, so
      // this can never send/draft/delete anything, unlike runTask's own (separately scoped) tool access.
      // Best-effort: toolsFor already swallows its own errors into `undefined`, so a Composio hiccup here
      // just means chat runs without account access this turn, not a broken chat.
      const rawExtras = req.body?.primer === true ? undefined : await toolsFor(req);
      const extras = rawExtras ? integrations.readOnly(rawExtras) : undefined;
      // Seventh bandit target (CHAT_STYLE_ARMS) — chosen once per turn, best-effort (a bandit hiccup must
      // never block the chat reply itself).
      let chatStyleArm: string | undefined;
      // Beta-gated (see Profile.betaFeatures' own doc comment) — leaves chatStyleArm undefined, same as a
      // live failure, so the reply below proceeds with the default (concise) style.
      if (profile?.betaFeatures) {
        try {
          const styleKey = banditContextKey(new Date(), profile);
          const styleState = await loadBanditState(req.session.user!, "chatstyle");
          chatStyleArm = chooseArm(CHAT_STYLE_ARMS, styleState, styleKey).arm.id;
        } catch { /* best-effort — the reply below still proceeds with the default (concise) style */ }
      }
      // "It grows with them" — the Primer quality of a tutor that's actually watched this student over time,
      // not a stateless one-off. Only the POSITIVE direction is surfaced mid-conversation (a real, earned
      // "you've been improving at this") — a declining trend is a Settings-level signal (weak-subject
      // surfacing already handles that), not something to raise unprompted inside an encouraging tutoring
      // chat. Best-effort, reuses the SAME aggregation the weak-subject prediction already computes.
      let growthTrend: "up" | undefined;
      let subjectSignal: { correctRate: number; attempts: number; trend?: "up" | "down" | "flat" } | undefined;
      try {
        if (t.sourceSubject) {
          const signal = aggregateSubjectSignals(req.session.tasks || []).find((s) => s.subject === t.sourceSubject);
          if (signal?.trend === "up") growthTrend = "up";
          if (signal) subjectSignal = { correctRate: signal.correctRate, attempts: signal.attempts, trend: signal.trend };
        }
      } catch { /* best-effort */ }
      // Recent "what I learned today" journal entries — same list the Journal tab reads/writes (studylog
      // tasks), not a separate store, so nothing new to keep in sync. Real daily entries only (a `week:`/
      // `month:` logDate is a rolled-up summary task, not something the student wrote themselves this chat
      // should quote back). Newest first, capped generously since recentJournalLine itself narrows further.
      // Labelled by subject and ranked by relevance to the current subject + what they just said (server/journal.ts).
      const journalCtx = selectJournal(req.session.tasks || [], { subject: t.sourceSubject, query: `${message} ${t.title || ""}`, known: req.session.profile?.subjects });
      const recentJournal = journalCtx.entries;
      const journalMeta = { total: journalCtx.total, subjects: journalCtx.subjects };
      // THE TUTOR (/tutor stage): its own small engine — server/tutor.ts. Nothing below this block runs for it.
      if (req.body?.primer === true) {
        await tutorTurn(req, res, t, { message, history, currentBoard, currentObjectives, recentJournal, journalMeta, profile });
        return;
      }
      const out = await chatAboutTask(
        { title: t.title, why: t.why, context: t.context, steps: t.steps, source: t.source, sourceDetail: t.sourceDetail, sourceSubject: t.sourceSubject, sourceDue: t.sourceDue, flashcards: t.flashcards, quizzes: t.quizzes },
        history.map((h) => ({ role: h.role, text: h.text })),
        message,
        profile,
        academic,
        { schoolRecord: schoolRecordLine(req.session.tasks, req.session.profile, t.sourceSubject), stepIndex, materials, extras, styleArm: chatStyleArm, growthTrend, subjectSignal, voiceMode: req.body?.voiceMode === true, canvasMode: req.body?.canvasMode === true, recentJournal, journalMeta, currentBoard, currentProblems, currentObjectives, opening, notNeeded: tasks.notNeededFronts(req.session.tasks || [], t.sourceSubject) },
      );
      addUsage(profile, out.tokens, "chat"); // untracked before — a tool-calling turn can now cost like a small run
      bumpActivityHour(profile, new Date(), t.sourceSubject);
      profile.lastTutorActivityAt = new Date().toISOString(); // drives shouldRefreshStudentModel's "real activity" gate
      void recordMetric(req.session.user!, "chat_message_sent", 1);
      void recordMetric(req.session.user!, "chat_message_length_chars", message.length);
      // A genuine failure (DeepSeek error / empty completion) used to get silently saved into the thread as
      // the generic "I'm here — what part of this is giving you trouble?" line — indistinguishable from Otto
      // actually being unhelpful. Surface it as a real error instead: nothing gets written to the chat
      // history (the student's own message stays unanswered, not answered-with-a-lie), and the client shows
      // an actual "couldn't reply" state with a retry, not an in-character bubble. 500, not 502 — this app
      // decided the reply failed (an empty/errored AI completion), nothing upstream/gateway-level actually
      // broke; 502 was misleading in the browser console (read as an infra crash) for what's really an
      // in-app soft failure — reported live as confusing "Bad Gateway" errors that had nothing to do with
      // any gateway.
      // When the AI itself failed (empty completion, DeepSeek error), chatAboutTask's finish("") already
      // sets a graceful fallback reply in out.reply.  Returning a hard 500 here used to throw that reply
      // AND any artifacts the turn managed to create away, leaving the student with a broken "couldn't
      // reply" error and no chat bubble at all.  Instead: if we have a fallback reply, treat it as a
      // successful turn so the reply and artifacts are saved and the student always gets a response.
      if (out.error && !out.reply?.trim()) { void recordMetric(req.session.user!, "chat_error", 1); res.status(500).json({ error: "Otto couldn't reply just now — try again in a moment." }); return; }
      if (out.error) void recordMetric(req.session.user!, "chat_fallback_reply", 1);
      if (out.guardrailTripped) void recordMetric(req.session.user!, "chat_guardrail_tripped", 1, t.source || "n/a");
      // Score the chat-style arm: the only IMMEDIATELY observable outcome of one turn is whether the guardrail
      // held (a genuinely unhelpful/off-boundary reply) — a richer "did they send a follow-up" reward would
      // need waiting on a future request, which this best-effort, fire-and-forget scoring deliberately avoids.
      if (chatStyleArm) {
        void (async () => {
          try {
            const key = banditContextKey(new Date(), profile);
            const reward = out.guardrailTripped ? 0 : 1;
            const state = await loadBanditState(req.session.user!, "chatstyle");
            await saveBanditState(req.session.user!, "chatstyle", updatePosterior(state, key, chatStyleArm!, reward));
            void recordSessionOutcome({ userEmail: req.session.user!, decisionKey: "chatstyle", arm: chatStyleArm!, context: key, reward, at: new Date().toISOString() });
          } catch { /* best-effort */ }
        })();
      }
      for (const n of out.notes) void recordMetric(req.session.user!, "chat_artifact_created", 1, "note");
      for (const f of out.flashcards) void recordMetric(req.session.user!, "chat_artifact_created", 1, "deck");
      for (const q of out.quizzes) void recordMetric(req.session.user!, "chat_artifact_created", 1, "quiz");
      for (const p of out.problems) void recordMetric(req.session.user!, "chat_artifact_created", 1, "problem");
      for (const b of out.board) void recordMetric(req.session.user!, "chat_artifact_created", 1, "board");
      if (stepIndex != null) void recordMetric(req.session.user!, "chat_help_requested_on_step", 1);
      const now = new Date().toISOString();
      // Accumulate this turn's artifacts onto the task exactly like a run does (same ARTIFACT_CAP), and
      // reference them from the assistant's own message so the thread can render an inline chip — the
      // content lives once (task.notes/flashcards/quizzes); the chat entry only points at it by id.
      const artifacts = [
        ...out.notes.map((n) => ({ kind: "note" as const, id: n.id, title: n.title })),
        ...out.flashcards.map((f) => ({ kind: "deck" as const, id: f.id, title: f.title })),
        ...out.quizzes.map((q) => ({ kind: "quiz" as const, id: q.id, title: q.title })),
        ...out.problems.map((p) => ({ kind: "problem" as const, id: p.id, title: p.question.slice(0, 60) })),
      ];
      if (out.notes.length) t.notes = [...(t.notes || []), ...out.notes].slice(-tasks.ARTIFACT_CAP);
      if (out.flashcards.length) t.flashcards = [...(t.flashcards || []), ...out.flashcards].slice(-tasks.ARTIFACT_CAP);
      if (out.quizzes.length) t.quizzes = [...(t.quizzes || []), ...out.quizzes].slice(-tasks.ARTIFACT_CAP);
      if (out.audit.length) t.audit = [...(t.audit || []), ...out.audit].slice(-tasks.AUDIT_CAP);
      const newChat = [
        { role: "user" as const, text: message, at: now, ...(stepIndex != null ? { stepIndex, stepText: t.steps![stepIndex].text.slice(0, 80) } : {}) },
        { role: "assistant" as const, text: out.reply, at: now,
          ...(artifacts.length ? { artifacts } : {}),
          ...(t.evidence?.length ? { sources: t.evidence.slice(0, 8).map((source) => ({ label: source.label, url: source.url })) } : {}),
          ...(out.guardrailTripped ? { guardrail: true } : {}) },
      ];
      // Only NON-TUTOR chat persists: everything below sits after the primer branch above, which returns
      // out of tutorTurn — the tutor's own chat/board/problems/objectives are LOCAL-ONLY
      // (client/localChatBoard.ts; tutorTurn clears them on the task and commits, and mergeTaskLists now
      // honours that clear instead of unioning the account row's legacy copy back in). The regular "Ask
      // Otto" task chat keeps surviving in the cloud exactly as before. Same CAP/merge conventions the rest
      // of this route already uses (ARTIFACT_CAP for problems, CHAT_CAP/BOARD_MERGE_CAP mirroring tasks.ts's
      // own cross-device merge caps so a single-device append here never exceeds what a later multi-device
      // MERGE would also cap it to).
      if (newChat.length) t.chat = [...(t.chat || []), ...newChat].slice(-CHAT_CAP);
      if (out.board.length) t.board = [...(t.board || []), ...out.board].slice(-tasks.BOARD_MERGE_CAP);
      if (out.problems.length) t.problems = [...(t.problems || []), ...out.problems].slice(-tasks.ARTIFACT_CAP);
      t.updatedAt = now;
      await commit(req);
      // The tutor screen merges by id from `board`/`problems`/`chatDelta` and keeps its own chat — so it doesn't need the WHOLE task (its full
      // chat + board history) shipped back every turn. That echo grew with the session and was the biggest per-turn payload.
      const { solution: _hiddenSolution, tutorState: _hiddenState, ...leanTask } = t;
      res.json({ reply: out.reply, chatDelta: newChat, board: out.board, problems: out.problems, objectives: out.objectives, guardrailTripped: out.guardrailTripped, task: leanTask });
    } catch (e: any) {
      // (status/kind only: the whole error object can carry the provider's echo of the prompt)
      const kind = classifyProviderError(e);
      console.error(`[chat] failed: ${kind}${e?.status ? ` ${e.status}` : ""} ${String(e?.message || "").slice(0, 120)}`);
      reportError("tutor-chat", e instanceof Error ? e : new Error(String(e)), { kind });
      if (kind !== "other") { res.setHeader("Retry-After", "30"); res.status(503).json({ error: "Otto is briefly unavailable — your message is kept, so try again in a minute (or keep working on the board meanwhile).", code: "tutor_unavailable", retryAfter: 30 }); return; }
      res.status(500).json({ error: "chat failed" });
    }
  });

  // A tiny nudge-me sidebar next to a flashcard/quiz question — NOT the per-task chat above: no task lookup
  // beyond auth (the card content comes straight from the client, since it's already showing it), no
  // artifacts, no persisted history. Rate-limited higher than the main chat since a student can burn through
  // several hints per card while drilling a deck.
  app.post("/api/tasks/:id/study-help", requireAuth, rateLimit(40, 60_000), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const message = String(req.body?.message || "").trim().slice(0, 1000);
    if (!message) { res.status(400).json({ error: "Say something first." }); return; }
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
      .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map((h: any) => ({ role: h.role as "user" | "assistant", text: String(h.text).slice(0, 1000) }))
      .slice(-8);
    const kind = req.body?.card?.kind;
    let card: Parameters<typeof studyHelp>[0];
    if (kind === "flashcard") {
      const front = String(req.body?.card?.front || "").slice(0, 500);
      const back = String(req.body?.card?.back || "").slice(0, 500);
      if (!front || !back) { res.status(400).json({ error: "Missing card." }); return; }
      card = { kind: "flashcard", front, back };
    } else if (kind === "quiz") {
      const question = String(req.body?.card?.question || "").slice(0, 500);
      const options = Array.isArray(req.body?.card?.options) ? req.body.card.options.map((o: any) => String(o).slice(0, 300)).slice(0, 10) : [];
      const correct = Number(req.body?.card?.correct);
      if (!question || !options.length || !Number.isInteger(correct) || correct < 0 || correct >= options.length) { res.status(400).json({ error: "Missing question." }); return; }
      card = { kind: "quiz", question, options, correct };
    } else { res.status(400).json({ error: "Missing card." }); return; }
    const out = await studyHelp(card, history, message, req.session.profile);
    addUsage(req.session.profile ||= emptyProfile(), out.tokens, "chat");
    await commit(req);
    // Same fix as the main task chat route above — a real failure must surface as an error, not as the
    // generic "I'm here" line rendered like a normal hint.
    if (out.error) { void recordMetric(req.session.user!, "chat_error", 1); res.status(500).json({ error: "Otto couldn't reply just now — try again in a moment." }); return; }
    res.json({ reply: out.reply });
  }));

  // The client requests runs; the SERVER executes them (via the queue) — same queue the cron drains offline.
  // `manual: true` marks a deliberate user click, which is allowed to retry a terminally-failed task.
  app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run tasks." }); return; }
    // Hard reset ("Réexécuter depuis le début"): the actual wipe happens INSIDE processExecuteTask (jobs.ts),
    // on the same load→mutate→commit cycle as the run itself — doing it here first and committing separately
    // got silently undone by commit()'s cross-device merge (see jobs.ts's comment on this). Just pass the
    // flag through the job input.
    await runViaJob(req, res, "execute_task", { manual: true, ...(req.body?.reset === true ? { reset: true } : {}) });
  });

  // Revise: the user declined to send and said what to change → re-run the task with that instruction so Otto
  // updates the draft (and re-offers it as a sendable) before they send.
  app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    const note = String(req.body?.note || "").trim();
    if (!note) { res.status(400).json({ error: "note required" }); return; }
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to revise tasks." }); return; }
    if (req.session.user) void recordMetric(req.session.user, "task_revision_requested", 1);
    await runViaJob(req, res, "revise", { note });
  });

  // These return the FULL task list (client filters out done/dismissed for display) — so the dashboard's
  // "handled" count + the deep-link "already handled" fallback keep working after a confirm/dismiss.
  app.post("/api/tasks/:id/confirm", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    const id = String(req.params.id);
    try {
      const task = await findTaskOrReload(req, id);
      if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
      stampFirstAction(task, req.session.user, req.session.profile);
      task.status = "done";
      task.updatedAt = new Date().toISOString();
      // Reported live: "it completes, then comes back" — confirm was on commit()'s default fire-and-forget
      // write-behind path (debounced 6-25s), which that function's own comment already names as the exact
      // failure mode for a serverless deploy: the instance can freeze/tear down the instant this response
      // goes out, before the scheduled cloud write ever actually runs, so a later request (same tab, a
      // different warm Vercel instance) reads the OLD cloud status back. Finishing a task is rare and
      // high-value per write, same reasoning this function already applies to a journal save or flashcard
      // review — worth the slightly slower response to actually guarantee it lands.
      await commit(req, { awaitCloud: true });
      void recordEvent(req.session.user!, "confirmed", { taskId: id, message: "You marked it done" });
      // Lateness relative to deadline — one of the metrics the personalization ask named directly. sourceDue
      // (Pronote's own ISO date, when present) is more precise than `when`'s free-text estimate; deadlineEpoch
      // already exists for exactly this "resolve a deadline to a comparable time" job (used for task sorting).
      // Skipped for tasks with no deadline at all rather than recording a meaningless 0.
      const deadlineMs = task.sourceDue ? Date.parse(task.sourceDue) : deadlineEpoch(task.when);
      if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
        const latenessHours = (Date.now() - deadlineMs) / 3_600_000;
        void recordMetric(req.session.user!, "task_lateness_hours", latenessHours, task.source || "n/a");
      }
      void recordMetric(req.session.user!, "task_completed", 1, task.source || "n/a");
      if (task.shownAt) void recordMetric(req.session.user!, "task_time_to_completion_seconds", (Date.now() - Date.parse(task.shownAt)) / 1000, task.source || "n/a");
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { reportError("tasks-confirm", e, { taskId: id }); console.error(e);
      res.status(500).json({ error: "Couldn't confirm that task — try again." }); }
  });

  app.post("/api/tasks/:id/reject", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    const id = String(req.params.id);
    try {
      const task = await findTaskOrReload(req, id);
      if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
      tasks.reject(req.session.tasks || [], id);
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { reportError("tasks-reject", e, { taskId: id }); console.error(e);
      res.status(500).json({ error: "Couldn't reject that task — try again." }); }
  });

  app.post("/api/tasks/:id/dismiss", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    const id = String(req.params.id);
    try {
      const task = await findTaskOrReload(req, id);
      if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
      task.status = "dismissed";
      task.updatedAt = new Date().toISOString();
      // Same reasoning as /confirm just above: rare, permanent, high-value-per-write — worth guaranteeing
      // the cloud write actually lands rather than risking it on commit()'s default debounced write-behind.
      await commit(req, { awaitCloud: true });
      void recordEvent(req.session.user!, "dismissed", { taskId: id, message: "You dismissed it — similar tasks won't come back" });
      void recordMetric(req.session.user!, "task_dismissed", 1, task.source || "n/a");
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { reportError("tasks-dismiss", e, { taskId: id }); console.error(e);
      res.status(500).json({ error: "Couldn't dismiss that task — try again." }); }
  });

  // Auto-do ONE automatable step (focused agent run over the connected apps) — through the job queue, same
  // as full runs, so it's durably locked and audited. Enqueue-and-return, NOT enqueue-and-drain: a step run
  // can involve a real tool call (draft an email, search, create a doc) that routinely takes well past what
  // a click should block on — especially answering an inline question, where the answer itself is already
  // captured as the job's input (see tasks.runStep's `answer` handling) the moment it's queued. The open
  // tab's kick loop (client/App.tsx) drains queued/executing work within seconds; cron covers it offline.
  app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run steps." }); return; }
    const id = String(req.params.id);
    const index = Number(req.params.index);
    const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : undefined;
    const task = (req.session.tasks || []).find((t) => t.id === id);
    if (!task || !task.steps?.[index]) { res.status(404).json({ error: "Step not found — it may have already changed elsewhere." }); return; }
    stampFirstAction(task, req.session.user, req.session.profile);
    // Routed through runViaJob (same helper /run and /revise already use) instead of a bare enqueueJob —
    // this used to only ENQUEUE and return immediately, relying entirely on the client's 4s "kick loop" (or,
    // worse, a stuck "running" job from an earlier attempt whose lock had expired) to ever actually process
    // it. Observed live: tapping an answer on a step's inline question ("Which version should Eric receive?")
    // looked like it did nothing — the click succeeded, the optimistic "Otto's on it…" text appeared, and then
    // nothing happened for a long time (or ever, if the kick loop's tab had since closed). runViaJob drains
    // the job INLINE (bounded, within this request's own timeout budget) and reclaims an expired stale lock
    // the same way /run and /revise already do, plus reports an honest 409/error instead of silently
    // discarding the answer when a different job type is already active on this task.
    await runViaJob(req, res, "execute_step", { index, ...(answer ? { answer } : {}) });
  });

  // Mark a step done/undone (a manual step the user did, or after the client opened a URL step).
  app.post("/api/tasks/:id/step/:index/done", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    try {
      const id = String(req.params.id);
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) { res.status(400).json({ error: "Invalid step index." }); return; }
      const done = req.body?.done !== false;
      const result = typeof req.body?.result === "string" ? req.body.result : undefined;
      const task = await findTaskOrReload(req, id);
      const step = task?.steps?.[index];
      if (!task || !step) { res.status(404).json({ error: "Step not found — it may have already changed elsewhere." }); return; }
      if (done) stampFirstAction(task, req.session.user, req.session.profile);
      step.done = done;
      step.doneAt = done ? new Date().toISOString() : undefined;
      if (result !== undefined) step.result = result;
      // Stage 13: Checkpoint evaluation — did this step actually achieve its "doneWhen" goal?
      if (done && step.doneWhen) {
        const checkpointPassed = evaluateCheckpoint(step, result);
        if (checkpointPassed !== undefined) step.checkpointPassed = checkpointPassed;
      }
      task.updatedAt = new Date().toISOString();
      if (done && req.session.user) void recordMetric(req.session.user, "task_step_completed", 1, task.source || "n/a");
      // Stage 14: Adaptive replanning — if 2+ checkpoints fail, flag for re-planning
      if (done && task.steps && needsAdaptiveReplan(task.steps) && req.session.user) {
        void recordEvent(req.session.user, "checkpoint_failures_detected", { taskId: id, message: "Multiple step checkpoints failed — consider re-planning this task" });
      }
      // Stage 17: Outcome persistence — compute and store what worked/didn't for this task
      const outcome = computeTaskOutcome(task);
      if (outcome.checkpointsFailed > 0 && req.session.user) {
        const failureList = Object.keys(outcome.failurePatterns).join(", ");
        void recordEvent(req.session.user, "task_outcome_computed", { taskId: id, message: `${outcome.checkpointsPassed}/${outcome.checkpointsTotal} checkpoints passed; struggled with: ${failureList}` });
      }
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { reportError("tasks-step-done", e); console.error(e);
      res.status(500).json({ error: "Couldn't update the step — try again." }); }
  });

  // Record one flashcard review — advances/resets its Leitner box and schedules the next `dueAt` (see
  // nextLeitnerReview in shared/types.ts). Deterministic, no AI call. This is what turns flashcard decks from
  // a one-shot artifact into genuine spaced repetition — see also GET /api/reviews/due below.
  app.post("/api/tasks/:id/flashcard/:deckId/:cardIndex/review", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
    const id = String(req.params.id);
    const deckId = String(req.params.deckId);
    const cardIndex = Number(req.params.cardIndex);
    const correct = req.body?.correct !== false;
    const task = await findTaskOrReload(req, id);
    const deck = task?.flashcards?.find((d) => d.id === deckId);
    const card = deck?.cards?.[cardIndex];
    if (!task || !card) { res.status(404).json({ error: "Card not found — it may have already changed elsewhere." }); return; }
    const prev = card.review;
    const { box, dueAt } = nextLeitnerReview(prev?.box, correct);
    card.review = { seen: (prev?.seen || 0) + 1, correct: (prev?.correct || 0) + (correct ? 1 : 0), lastAt: new Date().toISOString(), dueAt, box };
    deck!.lastReviewedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    if (req.session.profile) { bumpActivityHour(req.session.profile, new Date(), task.sourceSubject); req.session.profile.lastTutorActivityAt = new Date().toISOString(); }
    void recordMetric(req.session.user!, "flashcard_review", correct ? 1 : 0, task.source || "n/a");
    await commit(req);
    // "How often you go back and redo flashcards" signal — a card seen several times with a low correct-rate
    // is exactly the "you might need to study this material more" case from the personalization ask. 3+ seen
    // avoids flagging normal early misses; the correct-rate itself is the metric value (bucketed by the
    // card's own front so it's identifiable later without storing the whole card text as structured data).
    const seen = card.review.seen, ok = card.review.correct;
    if (seen >= 3) void recordMetric(req.session.user!, "flashcard_struggle", ok / seen, task.source || "n/a", card.front.slice(0, 120));
    res.json(tasksPayload(req, req.session.tasks));
  }));

  // "Not something I need to learn" — distinct from marking a card WRONG. A wrong card is a real gap and stays
  // in the spaced-repetition rotation; a not-needed card is Otto misjudging the student's syllabus/level, so it
  // leaves scoring, due-review lists and every weak-card signal, and is fed back into future deck generation
  // as content to avoid (notNeededFronts → notNeededLine). Reversible: {notNeeded:false} restores it.
  app.post("/api/tasks/:id/flashcard/:deckId/:cardIndex/not-needed", requireAuth, rateLimit(120, 60_000), ah(async (req, res) => {
    const task = await findTaskOrReload(req, String(req.params.id));
    const card = task?.flashcards?.find((d) => d.id === String(req.params.deckId))?.cards?.[Number(req.params.cardIndex)];
    if (!task || !card) { res.status(404).json({ error: "Card not found — it may have already changed elsewhere." }); return; }
    const notNeeded = req.body?.notNeeded !== false;
    if (notNeeded) card.notNeeded = true; else delete card.notNeeded;
    task.updatedAt = new Date().toISOString();
    void recordMetric(req.session.user!, "flashcard_not_needed", notNeeded ? 1 : 0, task.sourceSubject || task.source || "n/a", card.front.slice(0, 120));
    await commit(req);
    res.json(tasksPayload(req, req.session.tasks));
  }));

  app.post("/api/tasks/:id/quiz/:quizId/attempt", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
    const id = String(req.params.id);
    const quizId = String(req.params.quizId);
    const total = Number(req.body?.total);
    const score = Number(req.body?.score);
    const wrong = Array.isArray(req.body?.wrong) ? req.body.wrong.filter((n: any) => Number.isInteger(n)).slice(0, 50) : undefined;
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(score) || score < 0 || score > total) { res.status(400).json({ error: "Invalid score." }); return; }
    const task = await findTaskOrReload(req, id);
    const quiz = task?.quizzes?.find((q) => q.id === quizId);
    if (!task || !quiz) { res.status(404).json({ error: "Quiz not found — it may have already changed elsewhere." }); return; }
    quiz.attempts = [...(quiz.attempts || []), { at: new Date().toISOString(), score, total, ...(wrong?.length ? { wrong } : {}) }].slice(-QUIZ_ATTEMPT_CAP);
    task.updatedAt = new Date().toISOString();
    // Every other activity site (flashcard review, chat, journal save) feeds bumpActivityHour — a quiz attempt
    // is exactly the same kind of "the student is actively working right now" signal, but was missing here,
    // leaving a real gap in the "when is this student actually active" pattern (predictNextEngagement).
    if (req.session.profile) { bumpActivityHour(req.session.profile, new Date(), task.sourceSubject); req.session.profile.lastTutorActivityAt = new Date().toISOString(); }
    void recordMetric(req.session.user!, "quiz_attempt_score_ratio", score / total, task.source || "n/a");
    await commit(req);
    res.json(tasksPayload(req, req.session.tasks));
  }));

  // A student's OWN note, written by hand right after a quiz/flashcard mistake — "what I got wrong and what
  // to remember" — not an AI-generated fiche. Deterministic, no AI call: this is exactly the kind of thing
  // that shouldn't cost anything or take a round-trip to write. Lands in the same task.notes the AI's own
  // CREATE_NOTE tool writes to, so it shows up as a normal chip in "What Otto prepared" — one place to find
  // everything worth reviewing later, not a separate, siloed "mistakes" screen.
  app.post("/api/tasks/:id/notes", requireAuth, rateLimit(60, 60_000), ah(async (req, res) => {
    const id = String(req.params.id);
    const title = String(req.body?.title || "").trim().slice(0, 90) || "Note";
    const body = String(req.body?.body || "").trim().slice(0, 4000);
    if (!body) { res.status(400).json({ error: "Write something first." }); return; }
    const task = await findTaskOrReload(req, id);
    if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
    const note = { id: randomUUID(), title, body, createdAt: new Date().toISOString() };
    task.notes = [...(task.notes || []), note].slice(-tasks.ARTIFACT_CAP);
    task.updatedAt = new Date().toISOString();
    void recordMetric(req.session.user!, "chat_artifact_created", 1, "manual_note");
    await commit(req);
    res.json(tasksPayload(req, req.session.tasks));
  }));

  // Check a typed answer against a daily practice problem (see DailyPracticeProblem/practiceAnswerMatches in
  // shared/types.ts) — deterministic, no AI call, same "instant, no round-trip surprise" posture as the
  // flashcard/quiz recording routes above. The comparison itself (loose but not fuzzy — formatting-tolerant,
  // not answer-tolerant) lives in shared/types.ts so client and server can never disagree about what counts
  // as correct.
  app.post("/api/tasks/:id/practice-problem/attempt", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
    const id = String(req.params.id);
    const answer = String(req.body?.answer || "").trim().slice(0, 200);
    if (!answer) { res.status(400).json({ error: "Type an answer first." }); return; }
    const task = await findTaskOrReload(req, id);
    const problem = task?.practiceProblem;
    if (!task || !problem) { res.status(404).json({ error: "Practice problem not found — it may have already changed elsewhere." }); return; }
    // The stored key is only used to grade once the independently computed value agrees with it (spec §19): a
    // key that disagrees routes the attempt to a system-error state, which is never recorded as a mistake.
    const grade = gradeExerciseAnswer({ question: problem.problem, answer: problem.answer, check: problem.check, value: problem.value }, answer);
    const correct = grade.status === "correct";
    problem.attempt = { answer, correct, at: new Date().toISOString(), ...(grade.status === "system_error" ? { systemError: true } : {}) };
    task.updatedAt = new Date().toISOString();
    if (req.session.profile) { bumpActivityHour(req.session.profile, new Date(), task.sourceSubject); req.session.profile.lastTutorActivityAt = new Date().toISOString(); }
    void recordMetric(req.session.user!, "practice_problem_attempted", 1);
    // Nothing is counted for or against the student when the item itself is broken — only a trustworthy
    // verdict moves the skill estimate (spec §19/§20.2).
    if (grade.status !== "system_error") void recordMetric(req.session.user!, "practice_problem_correct", correct ? 1 : 0);
    else void recordMetric(req.session.user!, "practice_problem_key_conflict", 1);
    await commit(req);
    res.json(tasksPayload(req, req.session.tasks));
  }));

  // Break ONE step down into its own small checklist ("Détailler cette étape") — on demand, not automatic.
  // Costs one AI call, so it's gated the same as any other interactive AI action (paused/budget).
  app.post("/api/tasks/:id/step/:index/expand", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to use this." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't set up on this server yet." }); return; }
    const id = String(req.params.id);
    const index = Number(req.params.index);
    const task = (req.session.tasks || []).find((t) => t.id === id);
    const step = task?.steps?.[index];
    if (!task || !step) { res.status(404).json({ error: "Not found." }); return; }
    try {
      const substeps = await expandStep({ title: task.title, why: task.why, goal: task.goal, context: task.context, sourceDetail: task.sourceDetail, sourceSubject: task.sourceSubject, steps: task.steps }, { text: step.text }, req.session.profile, task.links);
      if (substeps.length) {
        step.substeps = substeps;
        task.updatedAt = new Date().toISOString();
        // awaitCloud, NOT the default fire-and-forget: this costs a paid AI call and is rate-limited to
        // 20/min — exactly the low-frequency/high-value profile commit() documents for awaiting the cloud
        // write. The detached default made the substeps serverless-fragile: the response carried them
        // (session copy), but on Vercel the background cloud write could freeze mid-flight and never land —
        // then the cron drain (cloud-only, no session) rebuilt the task WITHOUT the substeps and committed
        // it with a NEWER updatedAt, legitimately overwriting the client seconds later. Reported live as
        // "breaking down a task shows the substeps for two seconds and then they hide".
        await commit(req);
      }
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't break this step down — try again." }); }
  });

  // Tick/untick one sub-step — independent of the parent step's own "done" (see the Profile.grades-style
  // comment on TaskStep.substeps: a working checklist, not a completion gate).
  app.post("/api/tasks/:id/step/:index/substep/:subIndex/done", requireAuth, rateLimit(120, 60_000), async (req, res) => {
    const id = String(req.params.id);
    const index = Number(req.params.index);
    const subIndex = Number(req.params.subIndex);
    const done = req.body?.done !== false;
    const task = (req.session.tasks || []).find((t) => t.id === id);
    const sub = task?.steps?.[index]?.substeps?.[subIndex];
    // Was a silent no-op on a bad id/index — still 200'd with the unchanged list, indistinguishable from
    // success. Every sibling route (confirm/dismiss/step-done) already 404s on a missing target; this one
    // was missed.
    if (!task || !sub) { res.status(404).json({ error: "Sub-step not found — it may have already changed elsewhere." }); return; }
    try {      sub.done = done;
        task.updatedAt = new Date().toISOString();
        // awaitCloud — same substeps-vanish reasoning as the expand route above: a sub-step tick lost to a
        // frozen background write would resurrect as UNdone on the next cloud-only rebuild.
        await commit(req);
        res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save this sub-step — try again." }); }
  });

  // Let Otto just answer an automatable sub-action (see expandStep's `automatable` classification) instead
  // of the student having to look it up themselves — a read-only web search + synthesis, no permissioned
  // tools needed, so it runs inline here rather than through the job queue.
  app.post("/api/tasks/:id/step/:index/substep/:subIndex/run", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to use this." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't set up on this server yet." }); return; }
    const id = String(req.params.id);
    const index = Number(req.params.index);
    const subIndex = Number(req.params.subIndex);
    const task = (req.session.tasks || []).find((t) => t.id === id);
    const step = task?.steps?.[index];
    const sub = step?.substeps?.[subIndex];
    if (!task || !step || !sub) { res.status(404).json({ error: "Sub-step not found — it may have already changed elsewhere." }); return; }
    if (!sub.automatable) { res.status(400).json({ error: "This one isn't something Otto can do for you." }); return; }
    try {
      sub.result = await runSubstep({ title: task.title, why: task.why }, { text: step.text }, { text: sub.text }, req.session.profile);
      sub.done = true;
      task.updatedAt = new Date().toISOString();
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Otto couldn't come up with a reply." }); }
  });

  // "Move to a lighter day" from the workload widget — a manual, reversible nudge (never AI-driven): the
  // student picks the day, Otto just relabels the task's own `when` and re-scores it, same deadline-urgency
  // math every other task already goes through (tasks.applyDeadlineUrgency). Only meant for tasks with a
  // soft/inferred `when` — a task with a real Pronote-sourced deadline isn't something to reschedule here.
  app.post("/api/tasks/:id/reschedule", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    const id = String(req.params.id);
    const when = String(req.body?.when || "").trim();
    if (!when || Number.isNaN(Date.parse(when))) { res.status(400).json({ error: "a valid date is required" }); return; }
    const task = (req.session.tasks || []).find((t) => t.id === id);
    if (!task) { res.status(404).json({ error: "Not found." }); return; }
    // The workload widget only ever offers this for a LIVE task (computeWorkload skips handled ones entirely)
    // — but re-check server-side rather than trusting the client: a done/dismissed task has nothing left to
    // move, and silently re-dating one would make it look active again.
    if (isHandled(task.status)) { res.status(409).json({ error: "This task is already done or dismissed — nothing to move." }); return; }
    // This route only exists for the workload widget's "move to a lighter day" nudge — which only ever
    // offers it for a task with NO stated deadline (see movable in server/workload.ts). Re-check here too:
    // a task that already states a real deadline must never have it silently overwritten by a "which day is
    // lighter" heuristic, whether the client is right or not.
    if (task.when?.trim()) { res.status(409).json({ error: "This task already has a deadline — it can't be moved." }); return; }
    try {
      task.when = when;
      task.updatedAt = new Date().toISOString();
      tasks.applyDeadlineUrgency([task]);
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't move that task — try again." }); }
  });

  // Change (or clear) any live task's deadline — manual tasks and tasks Otto found alike. A student knows their own
  // calendar better than a guess does: the new date replaces `when` (and `sourceDue`, which ranking prefers when
  // present), is treated as firm (not approximate), and urgency is re-derived. "" clears it back to an estimate.
  app.post("/api/tasks/:id/deadline", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    const id = String(req.params.id);
    const raw = String(req.body?.when ?? "").trim();
    if (raw && !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(raw)) { res.status(400).json({ error: "a valid date is required" }); return; }
    if (raw && Number.isNaN(Date.parse(raw))) { res.status(400).json({ error: "a valid date is required" }); return; }
    const task = (req.session.tasks || []).find((t) => t.id === id);
    if (!task) { res.status(404).json({ error: "Not found." }); return; }
    if (isHandled(task.status)) { res.status(409).json({ error: "This task is already done or dismissed." }); return; }
    try {
      if (raw) {
        task.when = raw; task.whenApprox = false;
        if (task.sourceDue) task.sourceDue = raw;
      } else {
        delete (task as any).sourceDue;
        task.when = tasks.estimateWhen(task.quadrant); task.whenApprox = true;
      }
      task.updatedAt = new Date().toISOString();
      tasks.applyDeadlineUrgency([task]);
      await commit(req);
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't change the deadline — try again." }); }
  });

  // One-click send: fire a reviewed Gmail draft / composed Slack message — USER-confirmed, the ONLY send path.
  // The one route in the app with a real, irreversible EXTERNAL side effect per call (an actual email/message
  // leaves the student's real account) — rate-limited so a compromised session or a buggy client retry loop
  // can't spam-send, unlike this session's other task-mutation routes which are just local state.
  app.post("/api/tasks/:id/send/:index", requireAuth, rateLimit(10, 60_000), async (req, res) => {
    const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
    const s = t?.sendables?.[Number(req.params.index)];
    if (!t || !s) { res.status(404).json({ error: "Not found." }); return; }
    try {
      if (!s.sent) {
        const r = await integrations.sendSendable(req.session.user!, s, req.session.profile?.primaryAccounts);
        if (!r.ok) { res.status(500).json({ error: r.error || "send failed" }); return; }
        s.sent = true;
        t.updatedAt = new Date().toISOString();
        await commit(req);
        void recordEvent(req.session.user!, "sent", { taskId: t.id, message: `${s.label}${s.to ? ` → ${s.to}` : ""}` });
      }
      res.json(t);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't send — try again." }); }
  });

  // Manual edit of an unsent draft — the user typing directly into the draft box, not an AI rewrite (that's
  // /revise). For Gmail this pushes the edit to the REAL draft (GMAIL_SEND_DRAFT sends whatever's live in
  // Gmail, not our local copy); Slack has no server-side draft, so the local text IS what gets posted.
  app.post("/api/tasks/:id/sendable/:index/edit", requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
    const s = t?.sendables?.[Number(req.params.index)];
    if (!t || !s) { res.status(404).json({ error: "Not found." }); return; }
    if (s.sent) { res.status(400).json({ error: "already sent" }); return; }
    const subject = typeof req.body?.subject === "string" ? req.body.subject.slice(0, 300) : undefined;
    const body = typeof req.body?.body === "string" ? req.body.body.slice(0, 20_000) : undefined;
    try {
      if (s.app === "gmail" && s.draftId) {
        const r = await integrations.updateGmailDraft(req.session.user!, s.draftId, { subject, body, to: s.to });
        if (!r.ok) { res.status(500).json({ error: r.error || "couldn't save your edit to the draft" }); return; }
        if (subject !== undefined) s.subject = subject;
        if (body !== undefined) s.body = body;
      } else { res.status(400).json({ error: "this draft can't be edited here" }); return; }
      t.updatedAt = new Date().toISOString();
      await commit(req);
      res.json(t);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save your edit — try again." }); }
  });

  // ── Jobs + timeline (the durable execution layer's public surface) ────────────
  app.get("/api/jobs/:id", requireAuth, ah(async (req, res) => {
    const job = await getJob(String(req.params.id), req.session.user!);
    if (!job) { res.status(404).json({ error: "Not found." }); return; }
    res.json({ id: job.id, type: job.type, status: job.status, taskId: job.task_id, attempts: job.attempt_count, error: job.last_error, createdAt: job.created_at, finishedAt: job.finished_at });
  }));

  app.get("/api/tasks/:id/events", requireAuth, ah(async (req, res) => {
    res.json(await eventsForTask(req.session.user!, String(req.params.id)));
  }));

  // Client-driven drain "kick": while any of the user's jobs are queued (e.g. execution queued by a sweep),
  // the OPEN client kicks one job at a time so online users see work happen within seconds, not at the next
  // cron tick. Each kick is one bounded function invocation — serverless-friendly.
  // Flush this account's write-behind snapshot NOW — the client calls it (keepalive) when the tab is hidden/closed, so the
  // last few seconds of work never wait on the quiet-period timer.
  app.post("/api/sync/flush", requireAuth, async (req, res) => {
    try { if (req.session.user) await scheduler.flush(req.session.user); } catch { /* the scheduler retries */ }
    res.json({ ok: true });
  });

  app.post("/api/jobs/kick", requireAuth, rateLimit(60, 60_000), async (req, res) => {
    try {
      // MUST scope to this account — an unscoped drain() claims the GLOBAL oldest queued job across every
      // user (claimJob's `userEmail` param is exactly how the cron avoids one heavy account starving everyone
      // else; leaving it off here inverts that into "everyone's kick can starve their OWN job"). With more than
      // one active account, a user's own newly-queued task could sit behind other accounts' jobs indefinitely,
      // even with the tab open and kicking every 4s ��� this was reported live as "task constantly queued,
      // never executed" for a task that only ran ~20 minutes later, once its OWN turn came up in the global
      // queue instead of the very next kick.
      //
      // NON-BLOCKING: a kick used to `await jobs.drain(...)` — which blocks for the ENTIRE duration of one
      // job's AI call (potentially minutes).  While that single HTTP request hung, the client's 4-second
      // kick loop was frozen (kicking.current = true), so no further kicks could fire and the dashboard
      // went stale for the whole run.  Worse, a long-enough hang hit the proxy/browser timeout and surfaced
      // as ERR_CONNECTION_RESET — the exact "takes forever" / "kick failed" reports.  Fire the drain in
      // the background instead and return the current state immediately.  claimJob is atomic, so the next
      // kick (4s later) finds the job already claimed/running and returns instantly; when the job finishes,
      // the following kick picks up the updated cloud state and the client sees the result.
      const email = req.session.user!;
      // Repair the rare but user-visible partial commit where the task says queued while its job insert was
      // lost or consumed before the task reached cloud storage. Do this before draining so this same kick can
      // claim the repaired job; enqueueJob is idempotent, so concurrent tabs are safe.
      await jobs.recoverOrphanedQueuedTasks(email, 3).catch((e: any) => console.warn("[kick] orphan recovery failed:", e?.message || e));
      // AWAITED, deliberately — a prior "non-blocking" version fired this with `void` and returned immediately,
      // reasoning that draining could take minutes and shouldn't freeze the client's 4s poll loop. That traded
      // one bug for a WORSE one on Vercel serverless: the function invocation can freeze/be torn down the
      // instant the HTTP response is sent, with no `waitUntil` anywhere in this codebase to keep it alive —
      // so a job could get CLAIMED (status "running", a job lock — see store.ts's LOCK_MS) and then simply
      // never finish, because the code that was supposed to run it got killed the moment `res.json` below
      // fired. No later kick could reclaim it until that 15min lock expired. Reported live as a manually-
      // created task stuck at "Queued" / "Otto is getting this ready…" indefinitely — the exact shape this
      // produces. A kick drains at most one job; a job killed by the 300 s function limit is
      // retried once its 6-minute lock expires. `kicking.current` client-side already serializes kicks, so this doesn't double up.
      const out = await jobs.drain(1, undefined, email).catch((e: any) => { console.error("[kick] drain failed:", e?.message || e); return { processed: 0, failed: 0 }; });
      // READ-ONLY with respect to the session store: build the response from a fresh cloud-merged view, but
      // do NOT call saveSession() here. This route fires every 4s for the entire duration any job is active —
      // persisting its own merge back to the store raced a slower concurrent write (e.g. a journal save's
      // multi-second AI generation, committed at the END of that request) and could OVERWRITE the store with
      // a snapshot that predates it: kick reads session+cloud (neither yet has the journal edit) → the journal
      // request finishes and writes its own edit to the store → a LATER kick, already mid-flight from before
      // that write, still finishes and persists ITS OWN (stale, pre-edit) merge — landing after the journal's
      // write and silently erasing it. Reported live as "journal entries/flashcards not saving to cloud" and,
      // separately, as slower task generation (an extra write on top of the extra read on every 4s tick). The
      // response body below only needs the MERGED VIEW for THIS reply — never persisting it removes the race
      // entirely, since every actual mutation (journal save, step-done, job execution, ...) still durably
      // commits through its own route exactly as before; kick just stops being a second, uncoordinated writer.
      let responseTasks = req.session.tasks || [];
      if (cloudEnabled()) {
        try {
          // bypassCache: this route exists specifically to surface a job's completion within seconds of it
          // happening — loadState's normal 3min per-instance cache would silently defeat that promise on a
          // cold/stale warm instance, leaving the dashboard stuck on "queued" for up to 3min even though the
          // job finished immediately. Bounded cost: only paid while a real job is actively in flight (see the
          // comment above this block), not on every idle poll.
          const cloud = await loadState(email, { bypassCache: true });
          responseTasks = mergeTasks(cloud.tasks || [], responseTasks);
        } catch { /* best-effort — fall back to whatever the session already has */ }
      }
      const [active, activeTaskIds] = await Promise.all([countActiveJobs(email), activeJobTaskIds(email)]);
      // Trim the heaviest fields before this ships over the wire: this route fires every 10s for the entire
      // duration any job is in flight, and chat/board/problems/objectives (full conversation history, canvas
      // strokes, practice-problem state) can dwarf the rest of a task object. The client's keepLocalHandled
      // merge (client/App.tsx) already falls back to localStorage for these exact fields whenever they're
      // missing on an incoming task (see hydrateLocalThreads) — so omitting them here is a free win, not a
      // behavior change. Confirmed via code audit that nothing downstream of api.kick() reads them.
      const lightTasks = responseTasks.map((t: any) => {
        const { chat, board, problems, objectives, solution, tutorState, ...rest } = t;
        return rest;
      });
      const body = { active, activeTaskIds, tasks: lightTasks };
      // ETag: this is a 10s poll loop for the entire lifetime of any active job — a hash-gated 304 means 0
      // bytes egress on the common case where nothing changed between kicks (same pattern as /api/status
      // and /api/tasks above).
      const bodyJson = JSON.stringify(body);
      const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
      res.setHeader("ETag", etag);
      if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
      res.type("json").send(bodyJson);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "kick failed" }); }
  });

  // Background drain — called by Vercel Cron (Authorization: Bearer $CRON_SECRET) once a day (vercel.json;
  // Vercel's Hobby plan only permits daily cron — Pro allows tighter schedules if that's ever worth the
  // upgrade). This is what makes Otto work with every browser closed: sweeps due accounts, executes ready
  // tasks, retries failed jobs, all through the same durable queue the interactive routes use. Since a day
  // is a long gap, the INTERACTIVE routes are the real safety net the rest of the time — enqueueAndDrain
  // (jobs.ts) retries a claim on every manual refresh/action even when a job is stuck at "running" with an
  // expired lock (a worker killed mid-run by the platform's execution-time limit), not just when "queued".
  app.get("/api/cron/drain", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const auth = String(req.headers.authorization || "");
    if (secret && auth !== `Bearer ${secret}`) { res.status(401).json({ error: "unauthorized" }); return; }
    if (!secret && PROD) { res.status(503).json({ error: "CRON_SECRET not configured" }); return; }
    try {
      const out = await jobs.cronTick();
      // Retention rides the daily tick: cheap indexed deletes, and a failure never fails the drain.
      const pruned = await pruneOldData().catch(() => undefined);
      console.log(`${new Date().toISOString()} [cron] drain: ${JSON.stringify(out)}${pruned ? ` prune: ${JSON.stringify(pruned)}` : ""}`);
      res.json(out);
    } catch (e: any) {
      console.error("[cron] drain failed:", e);
      // The ONE unattended background entry point — per-account failures inside cronTick() already report
      // (jobs.ts's "cron-tick-skip"), but cronTick() ITSELF throwing (the whole drain never even starting)
      // was previously invisible outside Vercel's own logs.
      reportError("cron-drain", e);
      console.error(e);
      res.status(500).json({ error: "drain failed" });
    }
  });

  // Generation health for the signed-in user — makes a missing/failing daily cron DIAGNOSABLE (via API,
  // no UI). Answers "did Otto actually check my apps today, and is anything stuck?".
  app.get("/api/cron/status", requireAuth, async (req, res) => {
    const user = req.session.user!;
    try {
      const [state, lastSweepJob, activeJobs] = await Promise.all([
        loadState(user), getLatestJob(user, "sweep"), countActiveJobs(user),
      ]);
      const profile = state.profile || emptyProfile();
      const tz = tzOf(profile);
      res.json({
        lastSweepAt: profile.lastSweepAt || null,
        lastSweepDay: profile.lastSweepAt ? jobs.localDay(profile.lastSweepAt, tz) : null,
        today: jobs.localDay(new Date(), tz),
        sweptToday: !jobs.sweepDueForDay(profile.lastSweepAt, profile),
        lastSweepJob: lastSweepJob ? { status: lastSweepJob.status, at: lastSweepJob.finished_at || lastSweepJob.created_at, error: lastSweepJob.last_error || null } : null,
        queued: activeJobs,
        cronConfigured: !!process.env.CRON_SECRET,
      });
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "status failed" }); }
  });
}
