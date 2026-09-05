/**
 * Session-free job runner — the heart of "works with the browser closed".
 *
 * All real work (sweeps, task runs, step runs, revisions) flows through the durable queue in store.ts:
 * a route enqueues + drains inline (so the interactive path stays fast), and GET /api/cron/drain does the
 * same on a schedule for users who are offline. Each processor operates directly on the CLOUD state
 * (loadState → mutate → merge-with-fresh → saveState), never on an HTTP session, so a cron tick on a cold
 * serverless instance can execute a task end to end. The DB job row is the lock and the retry ledger.
 */
import type { WebTask, Profile, TaskStatus } from "../shared/types.ts";
import { emptyProfile, canonStatus, isHandled, isInFlight, tzOf, overMonthlyBudget, overInteractiveBudget, addUsage } from "../shared/types.ts";
import * as store from "./store.ts";
import * as tasks from "./tasks.ts";
import * as integrations from "./integrations.ts";
import * as claude from "./claude.ts";
import { pronoteConnected, pronoteGrades, pronoteHomework, pronoteTests, applyPronoteGrades } from "./pronote.ts";
import type { AcademicContext } from "./claude.ts";
import { replanMilestones } from "./milestones.ts";
import { computeWorkload } from "./workload.ts";
import { contextKey as banditContextKey, chooseArm, GRANULARITY_ARMS } from "./bandit.ts";
import { reportError } from "./sentry.ts";

/** Live Pronote homework/exams for a task's own run/chat context — best-effort, never blocks execution. */
async function loadAcademicContext(email: string): Promise<AcademicContext | undefined> {
  try {
    if (!(await pronoteConnected(email)).connected) return undefined;
    const [homework, tests] = await Promise.all([pronoteHomework(email), pronoteTests(email)]);
    return (homework.length || tests.length) ? { homework, tests } : undefined;
  } catch { return undefined; }
}

const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** The calendar day (YYYY-MM-DD) an instant falls on IN a given IANA timezone — no library, via Intl.
 *  Falls back to the UTC day if the timezone is invalid/unknown. */
export function localDay(iso: string | number | Date, timezone?: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    // en-CA formats as YYYY-MM-DD, so this is the local calendar day in `timezone`.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

/** Has NO successful sweep landed in the user's CURRENT local day yet? Drives the once-per-day guarantee,
 *  independent of how many times cron/kick runs. `now` is injectable for tests. */
export function sweepDueForDay(lastSweepAt: string | undefined, profile: Profile, now: Date = new Date()): boolean {
  if (!lastSweepAt) return true;
  const tz = tzOf(profile);
  return localDay(lastSweepAt, tz) !== localDay(now, tz);
}

// Automatic generation is now ONE fixed time a day, not a multi-times-a-day cadence — was previously
// genPerDay (1-4×/day, spaced by genIntervalMs). Manual generation (the Refresh button, POST
// /api/tasks/generate with force:true) is a completely separate code path and is untouched by this — this
// only gates the unattended cron/background sweep.
const SWEEP_HOUR = 16; // 4pm local time (per-account timezone) — see localHour below (defined further down,
// shared with the quiet-hours email-timing logic — same Intl-based local-hour math, no need for a second copy)

/** Is the automatic sweep due? Due once per local calendar day, and only from SWEEP_HOUR (16:00) onward —
 *  never before, even if nothing has run yet today. A sweep that already landed today (any hour) is not
 *  due again until tomorrow, regardless of how many times cron/kick fires. */
export function sweepDue(profile: Profile, now: Date = new Date()): boolean {
  if (!sweepDueForDay(profile.lastSweepAt, profile, now)) return false;
  return localHour(tzOf(profile), now) >= SWEEP_HOUR;
}

/** Which tasks the cron catch-all should enqueue for execution (bounded, cron's offline auto-run):
 *   - plain READY + never-attempted (the normal offline auto-run — failed_* retry via their own job,
 *     failed_terminal waits for the user's Retry, so cron never loops on a broken task); PLUS
 *   - ORPHANED queued tasks — set to "queued" but with no live job (their job was consumed by a
 *     pause/over-budget skip or a task-not-found race), which nothing else would ever re-queue.
 *  enqueueJob is idempotent per task, so a queued task that still has a live job is filtered out here.
 *  Pure + exported for the stuck-queued regression test. */
export function tasksToEnqueue(list: WebTask[], activeTaskIds: string[], limit = 3): WebTask[] {
  const active = new Set(activeTaskIds);
  const ready = list.filter((t) => canonStatus(t.status) === "ready" && !t.autoRan);
  const orphaned = list.filter((t) => canonStatus(t.status) === "queued" && !active.has(t.id));
  return [...ready, ...orphaned].slice(0, limit);
}

/** Load the account's durable state (the job runner's ONLY source of truth — no sessions here). */
async function loadUser(email: string): Promise<{ profile: Profile; list: WebTask[] }> {
  const st = await store.loadState(email);
  return { profile: st.profile || emptyProfile(), list: st.tasks || [] };
}

/** Persist after a job: merge against a FRESH cloud read (another instance/session may have committed
 *  meanwhile), so a job can never clobber concurrent progress. Same semantics as the session commit. */
async function commitUser(email: string, profile: Profile, list: WebTask[]): Promise<void> {
  const current = await store.loadState(email);
  const mergedTasks = tasks.mergeTaskLists(current.tasks || [], list);
  const mergedProfile = tasks.mergeProfileStates(current.profile || emptyProfile(), profile);
  await store.saveState(email, { profile: mergedProfile, tasks: mergedTasks, google: current.google, pronote: current.pronote });
}

async function processSweep(job: store.Job): Promise<string> {
  const email = job.user_email;
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  if (overMonthlyBudget(profile)) return "skipped: monthly AI budget reached";
  const extras = await integrations.getAgentTools(email, { primaryAccounts: profile.primaryAccounts });
  // Pronote is read directly by discoverSourceItems (server/discover.ts), entirely outside the Composio
  // toolset — a Pronote-only lycéen (no Gmail) has an empty `extras.tools` but genuinely has something for
  // Otto to read. Gating on Composio tools alone used to skip the sweep for them with "nothing connected"
  // even though tasks.generate() below would have found their Pronote homework just fine.
  if (!extras?.tools?.length && !(await pronoteConnected(email)).connected) return "skipped: nothing connected";
  const before = new Set(list.map((t) => t.id));
  const factsBefore = new Set([...profile.preferences, ...profile.people, ...profile.projects]);
  // Auto-refine raw manual task names (added while AI was off) — no button needed; the next sweep cleans
  // them up. Bounded per sweep; a failed refine just stays raw for the next one. ALSO auto-queues it for
  // execution right here: without this, a manual task added while paused/over-budget would sit refined-
  // but-idle until the separate "ready tasks the browser never got to" catch-all in cronTick ran — which
  // on Vercel's Hobby plan is once a day. No button, no next-day wait — refine and run in the same pass.
  // Real ceiling on today's auto-run spend (see tasks.autoRunBudgetLeft's own doc comment) — shared across
  // BOTH auto-run sites below (manual-task refine-and-run, and the discovered-tasks top-by-score run), so
  // one sweep can't quietly run more than the daily cap on its own. This is now the ONLY place tasks get
  // auto-run without a click — the kick loop no longer catches up ready tasks mid-day (reverted: AI spend
  // should only happen at this once-daily 4pm sweep, in chat, or in Journal/Study Mode, not continuously
  // through the day just because a tab is open).
  let autoRunBudget = tasks.autoRunBudgetLeft(profile, new Date());
  let autoRunSpent = 0;
  for (const t of list.filter((x) => x.unrefined && !isHandled(x.status)).slice(0, 3)) {
    try {
      const refined = await claude.refineManualTask(t.title, profile);
      if (refined) {
        // This call's cost was previously untracked entirely — refineManualTask returned no token info and
        // nothing here called addUsage, so a real DeepSeek spend on every unrefined manual task never
        // counted toward profile.usage OR the monthly budget cap at all.
        addUsage(profile, refined.tokens, "manual_refine");
        tasks.applyRefinement(list, t.id, refined);
        void store.recordEvent(email, "refined", { taskId: t.id, message: `Refined to "${t.title}"` });
        if (canonStatus(t.status) === "ready" && !t.autoRan && autoRunBudget - autoRunSpent > 0) {
          t.status = "queued";
          await store.enqueueJob(email, "execute_task", t.id);
          void store.recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" });
          autoRunSpent++;
        }
      }
    } catch { /* stays unrefined */ }
  }
  const next = await tasks.generate(list, profile, extras, email);
  // Memory transparency: anything the sweep just learned goes on the record — the user can see it in the
  // timeline and delete it in Settings → "What Otto knows about you".
  const learned = [...profile.preferences, ...profile.people, ...profile.projects].filter((f) => !factsBefore.has(f));
  for (const f of learned) void store.recordEvent(email, "learned", { jobId: job.id, message: f.slice(0, 200) });
  // Server-side auto-run: queue execution for the new ready tasks RIGHT IN THE SWEEP (top by score,
  // bounded) — the browser no longer decides what runs; it only displays state and kicks the drain.
  const found = next.filter((t) => !before.has(t.id) && !isHandled(t.status));
  const toRun = found.filter((t) => canonStatus(t.status) === "ready").sort((a, b) => b.score - a.score).slice(0, Math.max(0, autoRunBudget - autoRunSpent));
  for (const t of toRun) t.status = "queued";
  autoRunSpent += toRun.length;
  tasks.recordAutoRuns(profile, autoRunSpent, new Date());
  profile.lastSweepAt = new Date().toISOString(); // durable "checked today" marker — survives restarts
  // Pull fresh grade averages alongside the daily sweep — best-effort, same "Pronote is the source of truth
  // for what it reports" merge as the manual Settings sync, just automatic so a student never has to think
  // about it. A failure here (Pronote down, no grades yet) never blocks the sweep itself.
  try {
    if ((await pronoteConnected(email)).connected) applyPronoteGrades(profile, await pronoteGrades(email));
  } catch { /* best-effort */ }
  // A big IB project's milestone steps (targetDate set — see isBigIbProject/writeStepsFromContext in
  // claude.ts) get re-dated here if one slipped, so a missed research-question deadline doesn't just sit
  // stale — the remaining milestones shift out to stay realistic. Deterministic, no AI call (replanMilestones).
  for (const t of next) {
    if (isHandled(t.status) || !t.steps?.some((s) => s.targetDate)) continue;
    const { steps, changed } = replanMilestones(t.steps);
    if (changed) t.steps = steps;
  }
  await commitUser(email, profile, next);
  for (const t of found) void store.recordEvent(email, "found", { taskId: t.id, jobId: job.id, message: `Found from ${t.source}` });
  for (const t of toRun) { await store.enqueueJob(email, "execute_task", t.id); void store.recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" }); }

  // Every fresh task from this sweep gets an email — best-effort, non-blocking: a failed/skipped send
  // (no Gmail connected, Composio hiccup) never fails the sweep itself, same posture the old daily
  // briefing had. Sent via the same system-email path (sendSystemEmail), not the agent's gated toolset.
  if (found.length) void notifyNewTasks(email, found, profile, next).catch(() => {});

  return `swept: ${found.length} new task${found.length === 1 ? "" : "s"}, ${toRun.length} queued${learned.length ? `, learned ${learned.length} fact${learned.length === 1 ? "" : "s"}` : ""}`;
}

// Task titles/why come from the model or the student's own typed input and land straight in an HTML
// email body (notifyNewTasks below) — unescaped, a title like `<img src=x onerror=...>` would execute in
// the recipient's mail client. Exported so tests/run.mjs can pin this without a network-calling send.
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

// Local hour (0-23) in a given IANA timezone — used only to keep the task-alert email out of the
// student's sleep hours; `isPeakHourUtc` elsewhere is about DeepSeek pricing, not this.
function localHour(tz: string, now: Date = new Date()): number {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(now).replace(/\D/g, "")) % 24; }
  catch { return now.getUTCHours(); }
}
const QUIET_HOURS_START = 22, QUIET_HOURS_END = 7; // 22:00–07:00 local — no email, task still lands in-app

/** New-task email alert — one email per sweep that found something, listing every fresh task with its
 *  "why" so the subject line alone tells the student something real happened, not just "check the app". */
async function notifyNewTasks(email: string, found: WebTask[], profile: Profile, list: WebTask[]): Promise<void> {
  if (!(await integrations.connectionStatusesCached(email, ["gmail"]))["gmail"]) return; // no Gmail, nothing to send through
  // A student who opens the app at midnight (or has generation cadence turned up) could otherwise get
  // "you have new homework" pinged in the middle of the night — the task itself still shows up in-app
  // immediately; only the EMAIL nudge waits. Skipped, not queued — the next sweep that finds something
  // (or the student just opening the app) covers it, so nothing is silently lost.
  const h = localHour(tzOf(profile));
  if (h >= QUIET_HOURS_START || h < QUIET_HOURS_END) {
    void store.recordEvent(email, "task_alert_sent", { message: `Skipped: quiet hours (${h}:00 local)` });
    return;
  }
  const appUrl = process.env.PUBLIC_URL || "https://hiotto.vercel.app";
  // Pile-up detection (server/workload.ts) was PULL-only — real, but the student had to open the app's
  // "This week" popup to see a heavy day coming. This reuses the ALREADY-throttled once-daily new-task
  // email (rather than a second notification channel) to also mention the heaviest upcoming day, when it's
  // genuinely a pile-up — best-effort, never blocks the email if Pronote is unreachable.
  // System-sent notification emails (this one included) are Otto's OWN voice, not a drafted reply mirroring
  // a thread — so unlike a drafted email (which correctly mirrors the recipient's/thread's language), THIS
  // one must follow the account's own language setting, same as every other user-facing string in the app.
  const en = profile.language === "en";
  let pileUpLine = "";
  try {
    const [homework, tests] = (await pronoteConnected(email)).connected
      ? await Promise.all([pronoteHomework(email), pronoteTests(email)])
      : [[], []];
    const allTests = [...tests, ...(profile.manualExams || [])];
    const { days } = computeWorkload({ homework, tests: allTests, tasks: list.filter((t) => !isHandled(t.status)), grades: profile.grades, timezone: tzOf(profile) });
    const busy = days.map((d) => d.totalEffort).filter((e) => e > 0).sort((a, b) => a - b);
    const median = busy[Math.floor(busy.length / 2)] || 0;
    // Same "pileUp" heuristic as WeekLoad's client-side one (client/App.tsx) — kept in sync deliberately,
    // not re-derived independently, so "heavy" means the same thing whether the student sees it in-app or
    // in this email.
    const heavy = days.find((d, i) => i > 0 && d.totalEffort > 0 && (busy.length < 2 ? d.totalEffort >= 3 : d.totalEffort >= median * 1.6));
    if (heavy) {
      const dow = new Date(`${heavy.date}T00:00:00`).toLocaleDateString(en ? "en-US" : "fr-FR", { weekday: "long" });
      pileUpLine = en
        ? `<p>${dow} is looking busy — ${heavy.items.length} thing${heavy.items.length > 1 ? "s" : ""} planned.</p>`
        : `<p>${dow} s'annonce chargé — ${heavy.items.length} chose${heavy.items.length > 1 ? "s" : ""} prévue${heavy.items.length > 1 ? "s" : ""}.</p>`;
    }
  } catch { /* best-effort — never blocks the new-task email */ }
  const subject = en
    ? (found.length === 1 ? `Otto — new task: ${found[0].title}` : `Otto — ${found.length} new tasks`)
    : (found.length === 1 ? `Otto — nouvelle tâche : ${found[0].title}` : `Otto — ${found.length} nouvelles tâches`);
  const items = found.slice(0, 10).map((t) => `<li><b>${escapeHtml(t.title)}</b>${t.why ? ` — ${escapeHtml(t.why)}` : ""}</li>`).join("");
  // Second person, like Otto's actually telling you — not a system log announcing what it "found."
  const intro = en
    ? `<p>Hey — ${found.length === 1 ? "you've got a new one" : `you've got ${found.length} new ones`}:</p>`
    : `<p>Salut — ${found.length === 1 ? "tu as une nouvelle tâche" : `tu as ${found.length} nouvelles tâches`} :</p>`;
  const openLine = en ? `<p><a href="${appUrl}/tasks">Take a look →</a></p>` : `<p><a href="${appUrl}/tasks">Jette un œil →</a></p>`;
  const body = `${intro}<ul>${items}</ul>${pileUpLine}${openLine}`;
  const result = await integrations.sendSystemEmail(email, { to: email, subject, body, primaryAccounts: profile.primaryAccounts });
  void store.recordEvent(email, "task_alert_sent", { message: result.ok ? `Emailed ${found.length} new task${found.length === 1 ? "" : "s"}` : `Skipped: ${result.error || "send failed"}` });
}

/** Set ONE task's status in the durable copy (used for the queued transition so the UI can show it). */
export async function markTaskStatus(email: string, taskId: string, status: TaskStatus): Promise<void> {
  const { profile, list } = await loadUser(email);
  const t = list.find((x) => x.id === taskId);
  if (!t || isHandled(t.status)) return;
  t.status = status;
  t.updatedAt = new Date().toISOString();
  await commitUser(email, profile, list);
}

async function processExecuteTask(job: store.Job): Promise<string> {
  const email = job.user_email;
  const taskId = String(job.task_id || "");
  const { profile, list } = await loadUser(email);
  // A manual run / revision is user-present, so it gets the interactive reserve (cap ×1.1); a background
  // auto-run stops hard at the cap. Either way the check must MATCH the interactive route that enqueued it,
  // or a run the route allowed would be silently skipped here.
  const interactive = !!(job.input?.manual || job.input?.note);
  const budgetBlocked = interactive ? overInteractiveBudget(profile) : overMonthlyBudget(profile);
  // Pause / over-budget: this job is consumed (marked succeeded) by the drain, so DON'T leave the task
  // stranded at "queued" — a queued task has no way back into the runnable set (cron's catch-all only
  // re-enqueues "ready"), so it would look like it's "working" forever. Revert it to "ready" and commit,
  // so the honest state shows AND the next sweep / cron ready-path picks it up once the block clears.
  if (profile.paused || budgetBlocked) {
    const t = list.find((x) => x.id === taskId);
    if (t && isInFlight(t.status)) { t.status = "ready"; t.updatedAt = new Date().toISOString(); await commitUser(email, profile, list); }
    return profile.paused ? "skipped: AI paused" : "skipped: monthly AI budget reached";
  }
  const t = list.find((x) => x.id === taskId);
  if (!t) return "skipped: task not found";
  // Hard reset ("Réexécuter depuis le début"): must happen HERE, inside the same load→mutate→commit cycle
  // as the run itself — not in the interactive route before enqueueing. A pre-enqueue reset went through
  // commit()'s generic cross-device merge, which treats a "ready" status as LESS progressed than the
  // "needs_review" it's overwriting and silently restores the OLD cloud copy (rankStatus in tasks.ts) —
  // so the reset never actually stuck, and the run below immediately hit the "already executed" skip.
  // Doing it on this freshly-loaded, about-to-be-committed copy sidesteps that merge entirely.
  if (job.input?.reset === true && !isHandled(t.status)) tasks.resetTask(list, taskId);
  const c = canonStatus(t.status);
  if (isHandled(t.status)) return "skipped: already handled";
  if (c === "needs_review" && !job.input?.note) return "skipped: already executed"; // idempotency — a retry never re-burns a finished run
  if (c === "failed_terminal" && !job.input?.manual) return "skipped: failed terminally — waiting for the user's Retry";
  await store.recordEvent(email, "run_started", { taskId, jobId: job.id, message: job.input?.note ? "Revising per your note" : "Reading context and doing the reversible work" });
  // Multi-Gmail: run against the SAME Gmail account the task came from (drafts land in the right inbox).
  // Any OTHER multi-account toolkit this run touches with no source-tied account (e.g. creating a fresh
  // Doc on an unrelated manual task) falls back to the user's designated primary account for it.
  const extras = await integrations.getAgentTools(email, {
    ...(t.sourceAccountId ? { accountApp: t.source, accountId: t.sourceAccountId } : {}),
    primaryAccounts: profile.primaryAccounts,
  });
  t.autoRan = true; // whether this attempt succeeds or not, don't loop on it automatically
  const idsBefore = new Set(list.map((x) => x.id)); // to detect follow-up tasks the run spins off
  try {
    const academic = await loadAcademicContext(email);
    // Third bandit target (see server/bandit.ts) — best-effort, never blocks the run itself: a fresh task
    // gets its step granularity biased by whichever arm this student's procrastination-latency history
    // currently favors (see stampFirstAction in index.ts for where the outcome gets scored back).
    let granularityArm: string | undefined;
    try {
      const banditState = await store.loadBanditState(email, "granularity");
      granularityArm = chooseArm(GRANULARITY_ARMS, banditState, banditContextKey(new Date(), profile)).arm.id;
    } catch { /* best-effort — the run proceeds with standard granularity */ }
    const updated = await tasks.runById(list, taskId, profile, extras, job.input?.note ? String(job.input.note) : undefined, academic, granularityArm);
    // Live artifact verification: read every claimed draft/event/doc back from the real account before the
    // user sees it — anything the API confirms missing is pruned and logged to the task's timeline.
    if (updated && (updated.links?.length || updated.sendables?.length)) {
      const droppedArtifacts = await integrations.verifyTaskArtifacts(email, updated).catch(() => []);
      for (const d of droppedArtifacts) void store.recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
      if (droppedArtifacts.length) void store.recordEvent(email, "verified", { taskId, jobId: job.id, message: "Remaining artifacts verified against the live account" });
      else void store.recordEvent(email, "verified", { taskId, jobId: job.id, message: "Artifacts verified against the live account" });
    }
    // Verification may have PRUNED the sendable a "Drafted a reply…" claim pointed at (the draft didn't
    // actually exist in the account) — so re-reconcile the narrative against what survived, or the card would
    // claim a draft with no Send button. Mutates synthesis/did/steps in place on the task.
    if (updated) {
      const before = { did: updated.did?.length || 0, syn: updated.synthesis };
      claude.reconcileArtifactClaims(updated);
      if (before.did !== (updated.did?.length || 0) || before.syn !== updated.synthesis) {
        void store.recordEvent(email, "reconciled", { taskId, jobId: job.id, message: "Dropped a draft claim with no surviving draft to send" });
      }
    }
    // Auto-prepare substeps the same way leftover automatable STEPS already auto-run below — a step that
    // survived into the checklist because it genuinely needs the student can still have a pure-lookup
    // sub-action buried inside it (an opening hour, a schedule, a definition). Without this, that lookup
    // sits behind two clicks ("Détailler cette étape" then "Laisser Otto répondre") the student has to make
    // themselves before ever seeing the benefit. Same functions the manual buttons call
    // (server/index.ts's /step/:index/expand and /substep/:subIndex/run routes), same bounded-to-2 idiom as
    // the two blocks below, so this can't spiral into an unbounded chain of AI calls on a bad run.
    // ONLY for steps that actually look complicated (tasks.needsAutoBreakdown) — this used to fire for
    // EVERY eligible step unconditionally, so an already-simple one-action step ("Confirm attendance") got
    // a bolted-on checklist just as often as a genuinely bundled one ("Review the billing change..."),
    // burying the plan in sub-lists nobody asked for. The manual "Détailler cette étape" button is
    // unaffected by this gate — a user who explicitly asks for a breakdown always gets one.
    if (updated?.steps?.length) {
      const expandable = updated.steps
        .filter((s) => !s.done && !s.synthetic && !s.automatable && !s.substeps?.length && tasks.needsAutoBreakdown(s.text))
        .slice(0, 2);
      let substepRunsLeft = 2;
      for (const s of expandable) {
        try {
          const substeps = await claude.expandStep({ title: updated.title, why: updated.why }, { text: s.text }, profile, updated.links);
          if (!substeps.length) continue;
          s.substeps = substeps;
          for (const sub of s.substeps) {
            if (substepRunsLeft <= 0) break;
            if (!sub.automatable || sub.done) continue;
            try {
              sub.result = await claude.runSubstep({ title: updated.title, why: updated.why }, { text: s.text }, { text: sub.text }, profile);
              substepRunsLeft--;
            } catch { /* best-effort — the manual "Laisser Otto répondre" button stays available either way */ }
          }
        } catch { /* best-effort — expandStep already swallows its own errors, this catches anything else */ }
      }
    }
    await commitUser(email, profile, list);
    // Auto-run any FOLLOW-UP tasks the run spun off (distinct new obligations it discovered) — queue each so
    // Otto plans + works it just like a freshly-generated task. Bounded; they run on the next drain/kick.
    const spawned = list.filter((x) => !idsBefore.has(x.id) && canonStatus(x.status) === "ready").slice(0, 2);
    for (const s of spawned) {
      await store.enqueueJob(email, "execute_task", s.id);
      void store.recordEvent(email, "found", { taskId: s.id, jobId: job.id, message: `Follow-up from "${t.title.slice(0, 60)}"` });
    }
    // finalize's own "finish, don't hand back" guard (server/claude.ts) rejects an unblocked automatable
    // step up to twice, but gives up after that and lets it survive into steps[] anyway rather than loop
    // forever — a "draft an email" that Otto could clearly just do, sitting there needing a manual "Auto-do"
    // click. Close that gap here instead of leaving it on the user: queue it up the same way a follow-up
    // task gets queued, bounded to 2 so a badly-behaved run can't spin up an unbounded chain of jobs.
    if (updated?.steps?.length) {
      const autoSteps = updated.steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.automatable && !s.done && !s.synthetic && s.dependsOn === undefined && !s.needsPermission && !s.question)
        .slice(0, 2);
      for (const { i } of autoSteps) {
        await store.enqueueJob(email, "execute_step", taskId, { index: i });
        void store.recordEvent(email, "queued", { taskId, jobId: job.id, message: `Auto-running step ${i + 1} — Otto can do this itself` });
      }
    }
    const done = updated?.steps?.length ? `${updated.steps.filter((s) => !s.done).length} step(s) need you` : "fully handled";
    const cost = updated?.lastRunTokens ? ` (${Math.round(updated.lastRunTokens.in / 1000)}k tokens)` : "";
    await store.recordEvent(email, "run_succeeded", { taskId, jobId: job.id, message: (updated?.synthesis?.slice(0, 200) || done) + cost });
    return updated?.synthesis || "executed";
  } catch (e: any) {
    // PERSIST the failure — the old in-memory-only autoRan meant a crashed offline run left the task
    // "ready" in the cloud and cron would enqueue it forever. runById already stamped failed_retryable +
    // lastError on the list copy; upgrade to terminal when this was the job's final attempt, then COMMIT.
    if (t && !isHandled(t.status)) {
      if (job.attempt_count >= job.max_attempts) t.status = "failed_terminal";
      t.autoRan = true;
      t.updatedAt = new Date().toISOString();
    }
    await commitUser(email, profile, list);
    throw e;
  }
}

async function processExecuteStep(job: store.Job): Promise<string> {
  const email = job.user_email;
  const taskId = String(job.task_id || "");
  const index = Number(job.input?.index);
  const { profile, list } = await loadUser(email);
  // The interactive route (POST .../step/:index/run) stamps the TASK "queued" so the client's kick loop
  // knows to keep polling while this step runs in the background — unlike execute_task, nothing else ever
  // moves it off "queued" once the step itself is done, so it'd read as permanently "in progress" for a
  // one-step run. Settle it back to a resting state on every exit path below, mirroring the
  // paused/budget-block revert processExecuteTask already does for the whole-task case.
  const restStatus = () => {
    const t = list.find((x) => x.id === taskId);
    if (t && isInFlight(t.status)) { t.status = "ready"; t.updatedAt = new Date().toISOString(); }
  };
  if (profile.paused) { restStatus(); await commitUser(email, profile, list); return "skipped: AI paused"; }
  // Approve & Run is always user-present → interactive reserve, matching the route that enqueued it.
  if (overInteractiveBudget(profile)) { restStatus(); await commitUser(email, profile, list); return "skipped: monthly AI budget reached"; }
  if (!Number.isInteger(index)) { restStatus(); await commitUser(email, profile, list); return "skipped: bad step index"; }
  await store.recordEvent(email, "step_started", { taskId, jobId: job.id, message: `Running step ${index + 1}` });
  // The user explicitly clicked Approve & Run — the permissioned toolset is correct here. Same multi-account
  // routing as a full task run: the task's own source account when it has one, else the resolved primary.
  const t = list.find((x) => x.id === taskId);
  let permTools;
  try {
    permTools = await integrations.getAgentToolsWithPermission(email, {
      ...(t?.sourceAccountId ? { accountApp: t.source, accountId: t.sourceAccountId } : {}),
      primaryAccounts: profile.primaryAccounts,
    });
  } catch (e) {
    console.error(`[jobs] getAgentToolsWithPermission failed for step ${index} on task ${taskId}:`, e);
    // Fall back to regular tools if permissioned tools fail - this allows the step to still run
    // even if the permission check fails, though it may hit the write gate again
    permTools = await integrations.getAgentTools(email, {
      ...(t?.sourceAccountId ? { accountApp: t.source, accountId: t.sourceAccountId } : {}),
      primaryAccounts: profile.primaryAccounts,
    }).catch((e2) => { console.error(`[jobs] fallback getAgentTools ALSO failed for step ${index} on task ${taskId}:`, e2); return undefined; });
  }
  const academic = await loadAcademicContext(email);
  // Unlike processExecuteTask (which reverts the task's status and stamps lastError on failure), this had
  // NO try/catch at all — a thrown AI/tool error left the task stuck at "queued" forever with no error
  // surfaced, until cron's once-a-day orphan recovery silently reran it as a full execute_task instead of
  // retrying the specific step. Mirror processExecuteTask's pattern here too.
  try {
    // Both tool loads failed above — don't let the step proceed and fail confusingly deep inside runStep
    // (which would stamp a generic AI/tool error onto lastError with no hint the real cause was "couldn't
    // reach your connected accounts"). Throw a specific message now, INSIDE this try, so the catch below
    // stamps it onto task.lastError and reverts status exactly like any other step failure.
    if (!permTools) throw new Error("Couldn't connect to your accounts — try again in a moment.");
    const updated = await tasks.runStep(list, taskId, index, profile, permTools, job.input?.answer ? String(job.input.answer) : undefined, academic);
    if (updated && (updated.links?.length || updated.sendables?.length)) {
      const droppedArtifacts = await integrations.verifyTaskArtifacts(email, updated).catch(() => []);
      for (const d of droppedArtifacts) void store.recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
    }
    restStatus();
    await commitUser(email, profile, list);
    await store.recordEvent(email, "step_done", { taskId, jobId: job.id, message: updated?.steps?.[index]?.text?.slice(0, 200) });
    return "step executed";
  } catch (e: any) {
    restStatus();
    if (t && !isHandled(t.status)) t.lastError = String(e?.message || e).slice(0, 300);
    await commitUser(email, profile, list);
    void store.recordEvent(email, "step_failed", { taskId, jobId: job.id, message: String(e?.message || e).slice(0, 200) });
    throw e;
  }
}

/** Run ONE claimed job to completion. Throwing marks it failed (retryable until max_attempts). */
export async function processJob(job: store.Job): Promise<string> {
  switch (job.type) {
    case "sweep": return processSweep(job);
    case "execute_task": return processExecuteTask(job);
    case "revise": return processExecuteTask(job); // same processor; input.note carries the revision
    case "execute_step": return processExecuteStep(job);
    default: return `skipped: unknown type ${job.type}`;
  }
}

/** Claim + process up to `limit` jobs, stopping when the time budget is spent (serverless functions have
 *  hard ceilings — persist progress per job, never hold work hostage to the batch). */
export async function drain(limit = 3, budgetMs = 240_000, userEmail?: string): Promise<{ processed: number; failed: number }> {
  const t0 = Date.now();
  let processed = 0, failed = 0;
  for (let i = 0; i < limit; i++) {
    if (Date.now() - t0 > budgetMs) break;
    const job = await store.claimJob(workerId, userEmail);
    if (!job) break;
    // Heartbeat: keep extending THIS job's lease while it runs, so a long-but-healthy run never has its
    // lock expire and get re-claimed + re-executed by a second worker (the duplicate-draft P0). Stops the
    // moment renewLock reports the row is no longer ours (finished / stolen).
    const beat = setInterval(() => { void store.renewLock(job.id, workerId).then((ok) => { if (!ok) clearInterval(beat); }); }, store.heartbeatIntervalMs);
    try {
      const note = await processJob(job);
      await store.finishJob(job.id, workerId, "succeeded", undefined, { note });
      processed++;
    } catch (e: any) {
      console.error(`[jobs] ${job.type} failed for ${job.user_email}${job.task_id ? ` task ${job.task_id}` : ""}:`, e?.message || e);
      reportError("job-failed", e, { jobType: job.type, email: job.user_email, taskId: job.task_id });
      await store.finishJob(job.id, workerId, "failed", e?.message || String(e));
      if (job.task_id) void store.recordEvent(job.user_email, "run_failed", { taskId: job.task_id, jobId: job.id, message: String(e?.message || e).slice(0, 200) });
      failed++;
    } finally {
      clearInterval(beat);
    }
  }
  return { processed, failed };
}

/** Enqueue a job and drain inline — the interactive path: the request that asked for work sees it done
 *  (or already-in-flight) before responding, while the SAME queue gives cron the offline path. */
export async function enqueueAndDrain(email: string, type: store.JobType, taskId?: string, input?: any): Promise<store.Job> {
  const job = await store.enqueueJob(email, type, taskId, input);
  // Also attempt a drain when the job comes back "running", not just "queued" — a job left running by a
  // worker that got killed mid-request (serverless execution-time limit cutting off a long sweep/run
  // before it called finishJob) sits at "running" with a lock that only claimJob's "expired lock" pass can
  // reclaim. Without this, the interactive route would report that stale "running" status back forever
  // (observed live: "sweep didn't finish, still running" never clearing) — cron is the only other path
  // that ever retries a claim, and it may run just once a day. drain()'s claimJob only actually picks up a
  // job whose locked_until has passed, so this is a safe no-op when another worker is genuinely still on it.
  if (job.status === "queued" || job.status === "running") {
    // Make the queued state VISIBLE before work starts (execution types only — sweeps aren't a task).
    if (taskId && type !== "sweep" && job.status === "queued") await markTaskStatus(email, taskId, "queued").catch(() => {});
    // Scoped to THIS account — an unscoped drain() claims the global oldest queued job across every user
    // (see the /api/jobs/kick fix for the same bug), which would make an interactive "run this now" request
    // process a stranger's job instead of the one it just enqueued.
    await drain(2, undefined, email);
  }
  return (await store.getJob(job.id, email)) || job;
}

/** Cron entry: give every recently-active account its background turn — enqueue a sweep if none has
 *  succeeded within the watch window, enqueue execution for ready tasks, then drain a bounded batch. */
export async function cronTick(): Promise<{ users: number; enqueued: number; processed: number; failed: number }> {
  const emails = await store.listAccountEmails(500);
  let enqueued = 0;
  const now = new Date();

  for (const email of emails) {
    try {
      const { profile, list } = await loadUser(email);
      if (profile.paused) continue;
      if (overMonthlyBudget(profile)) continue; // over the monthly AI budget — no new work until it resets

      // (1) SWEEP FIRST — once a day, fixed at SWEEP_HOUR (16:00) local time, not a multi-times-a-day
      // cadence (see sweepDue's own doc comment). Uses the persisted lastSweepAt marker (survives
      // restarts). An already queued/running sweep dedupes via idempotency. No peak-hour cost deferral
      // here anymore — that only ever made sense for the old >1×/day cadence (defer the EXTRA sweeps, never
      // the once-a-day floor); with just one sweep a day, sweepDue() being true already IS the floor, so
      // there's nothing left to defer without breaking "at least one sweep a day".
      const last = await store.getLatestJob(email, "sweep");
      const sweepActive = last && (last.status === "queued" || last.status === "running");
      if (!sweepActive && sweepDue(profile, now)) {
        await store.enqueueJob(email, "sweep"); enqueued++;
      }

      // (2) EXECUTE ready tasks the browser never got to (offline auto-run), bounded per user per tick.
      // ONLY plain ready+never-attempted: failed_retryable retries through its own job's attempts;
      // failed_terminal waits for the user's explicit Retry — cron never loops on a broken task.
      // ALSO recover ORPHANED queued tasks — ones set to "queued" whose execution job was consumed without
      // running them (a pause/over-budget skip, or a task-not-found race between enqueue and the state
      // commit). Nothing else re-queues a non-"ready" task, so without this they'd sit "working" forever.
      // enqueueJob is idempotent per task, so a queued task that still HAS a live job is a no-op here.
      //
      // CRITICAL: this used to enqueue up to 3 brand-new "ready" executions with NO connection to
      // AUTO_RUN_DAILY_CAP (tasks.autoRunBudgetLeft) — the cap that's supposed to be the one hard ceiling
      // on unattended, no-click AI spend per day. The sweep (processSweep, above) already spends against
      // that same cap for ITS OWN auto-run picks; this catch-all ran completely independently, so a day
      // with several backlog "ready" tasks could silently full-execute the sweep's 3 PLUS this step's 3
      // more — 6 real agent runs (each its own multi-round tool-calling loop) with nothing the student
      // clicked and nothing that showed up as a single obvious "why did this cost so much" line anywhere.
      // Recovering a genuinely ORPHANED task (one whose execution was already committed to and paid for
      // once) is NOT new discretionary spend, so only the brand-new "ready" picks are capped here.
      const activeIds = await store.activeJobTaskIds(email);
      const candidates = tasksToEnqueue(list, activeIds);
      const orphaned = candidates.filter((t) => canonStatus(t.status) === "queued");
      let readyBudget = tasks.autoRunBudgetLeft(profile, now);
      const readyPicks = candidates.filter((t) => canonStatus(t.status) === "ready").slice(0, readyBudget);
      const toEnqueueNow = [...orphaned, ...readyPicks];
      for (const t of toEnqueueNow) { await store.enqueueJob(email, "execute_task", t.id); enqueued++; }
      if (readyPicks.length) {
        tasks.recordAutoRuns(profile, readyPicks.length, now);
        await commitUser(email, profile, list);
      }
    } catch (e: any) { console.warn(`[jobs] cron skip ${email}:`, e?.message || e); reportError("cron-tick-skip", e, { email }); }
  }
  // Vercel Hobby caps cron at once/day (Pro allows finer schedules) — so THIS tick is the only guaranteed
  // background turn for most deployments, which makes fairness within it matter more, not less. Drain
  // FAIRLY: round-robin a small per-user quota so one heavy account can't monopolise the batch and starve
  // the tail (global-oldest-first did exactly that). Each pass gives every user up to 2 jobs; repeat passes
  // until the function's time ceiling is near or a whole pass does nothing. Bounded by the 300s cap.
  const t0 = Date.now(), budgetMs = 260_000;
  let processed = 0, failed = 0;
  for (let pass = 0; pass < 6 && Date.now() - t0 < budgetMs; pass++) {
    let didWork = false;
    for (const email of emails) {
      if (Date.now() - t0 >= budgetMs) break;
      const r = await drain(2, budgetMs - (Date.now() - t0), email);
      processed += r.processed; failed += r.failed;
      if (r.processed || r.failed) didWork = true;
    }
    if (!didWork) break; // nothing left anywhere this pass → stop
  }
  return { users: emails.length, enqueued, processed, failed };
}
