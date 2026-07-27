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
import { emptyProfile, canonStatus, isHandled, isInFlight, tzOf, overMonthlyBudget, overInteractiveBudget, isPeakHourUtc } from "../shared/types.ts";
import * as store from "./store.ts";
import * as tasks from "./tasks.ts";
import * as integrations from "./integrations.ts";
import * as claude from "./claude.ts";

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

/** Minimum spacing between sweeps, from the user's chosen cadence (genPerDay 1–4). 1/day → 24h, 4/day → 6h.
 *  This is what stops Otto sweeping "quite often": the 45-min heartbeat is gone. */
export function genIntervalMs(profile: Profile): number {
  const perDay = Math.min(4, Math.max(1, Math.round(Number(profile.genPerDay) || 1)));
  return Math.floor(86_400_000 / perDay);
}

/** Is another sweep allowed yet under the user's cadence? Due when the daily floor hasn't been met OR the
 *  cadence interval since the last SUCCESSFUL sweep has elapsed. */
export function sweepDue(profile: Profile, now: Date = new Date()): boolean {
  if (sweepDueForDay(profile.lastSweepAt, profile, now)) return true;
  const last = Date.parse(profile.lastSweepAt || "") || 0;
  return now.getTime() - last >= genIntervalMs(profile);
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
  if (!extras?.tools?.length) return "skipped: nothing connected";
  const before = new Set(list.map((t) => t.id));
  const factsBefore = new Set([...profile.preferences, ...profile.people, ...profile.projects]);
  // Auto-refine raw manual task names (added while AI was off) — no button needed; the next sweep cleans
  // them up. Bounded per sweep; a failed refine just stays raw for the next one. ALSO auto-queues it for
  // execution right here: without this, a manual task added while paused/over-budget would sit refined-
  // but-idle until the separate "ready tasks the browser never got to" catch-all in cronTick ran — which
  // on Vercel's Hobby plan is once a day. No button, no next-day wait — refine and run in the same pass.
  for (const t of list.filter((x) => x.unrefined && !isHandled(x.status)).slice(0, 3)) {
    try {
      const refined = await claude.refineManualTask(t.title, profile);
      if (refined) {
        tasks.applyRefinement(list, t.id, refined);
        void store.recordEvent(email, "refined", { taskId: t.id, message: `Refined to "${t.title}"` });
        if (canonStatus(t.status) === "ready" && !t.autoRan) {
          t.status = "queued";
          await store.enqueueJob(email, "execute_task", t.id);
          void store.recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" });
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
  const toRun = found.filter((t) => canonStatus(t.status) === "ready").sort((a, b) => b.score - a.score).slice(0, 3);
  for (const t of toRun) t.status = "queued";
  profile.lastSweepAt = new Date().toISOString(); // durable "checked today" marker — survives restarts
  await commitUser(email, profile, next);
  for (const t of found) void store.recordEvent(email, "found", { taskId: t.id, jobId: job.id, message: `Found from ${t.source}` });
  for (const t of toRun) { await store.enqueueJob(email, "execute_task", t.id); void store.recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" }); }
  return `swept: ${found.length} new task${found.length === 1 ? "" : "s"}, ${toRun.length} queued${learned.length ? `, learned ${learned.length} fact${learned.length === 1 ? "" : "s"}` : ""}`;
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
    const updated = await tasks.runById(list, taskId, profile, extras, job.input?.note ? String(job.input.note) : undefined);
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
    await commitUser(email, profile, list);
    // Auto-run any FOLLOW-UP tasks the run spun off (distinct new obligations it discovered) — queue each so
    // Otto plans + works it just like a freshly-generated task. Bounded; they run on the next drain/kick.
    const spawned = list.filter((x) => !idsBefore.has(x.id) && canonStatus(x.status) === "ready").slice(0, 2);
    for (const s of spawned) {
      await store.enqueueJob(email, "execute_task", s.id);
      void store.recordEvent(email, "found", { taskId: s.id, jobId: job.id, message: `Follow-up from "${t.title.slice(0, 60)}"` });
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
  if (profile.paused) return "skipped: AI paused";
  // Approve & Run is always user-present → interactive reserve, matching the route that enqueued it.
  if (overInteractiveBudget(profile)) return "skipped: monthly AI budget reached";
  if (!Number.isInteger(index)) return "skipped: bad step index";
  await store.recordEvent(email, "step_started", { taskId, jobId: job.id, message: `Running step ${index + 1}` });
  // The user explicitly clicked Approve & Run — the permissioned toolset is correct here. Same multi-account
  // routing as a full task run: the task's own source account when it has one, else the resolved primary.
  const t = list.find((x) => x.id === taskId);
  const permTools = await integrations.getAgentToolsWithPermission(email, {
    ...(t?.sourceAccountId ? { accountApp: t.source, accountId: t.sourceAccountId } : {}),
    primaryAccounts: profile.primaryAccounts,
  }).catch(() => undefined);
  const updated = await tasks.runStep(list, taskId, index, profile, permTools, job.input?.answer ? String(job.input.answer) : undefined);
  if (updated && (updated.links?.length || updated.sendables?.length)) {
    const droppedArtifacts = await integrations.verifyTaskArtifacts(email, updated).catch(() => []);
    for (const d of droppedArtifacts) void store.recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
  }
  await commitUser(email, profile, list);
  await store.recordEvent(email, "step_done", { taskId, jobId: job.id, message: updated?.steps?.[index]?.text?.slice(0, 200) });
  return "step executed";
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
      await store.finishJob(job.id, "succeeded", undefined, { note });
      processed++;
    } catch (e: any) {
      console.error(`[jobs] ${job.type} failed for ${job.user_email}${job.task_id ? ` task ${job.task_id}` : ""}:`, e?.message || e);
      await store.finishJob(job.id, "failed", e?.message || String(e));
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
  if (job.status === "queued") {
    // Make the queued state VISIBLE before work starts (execution types only — sweeps aren't a task).
    if (taskId && type !== "sweep") await markTaskStatus(email, taskId, "queued").catch(() => {});
    await drain(2);
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

      // (1) SWEEP FIRST — cadence-driven, from the user's genPerDay (1–4/day; default once daily). Uses the
      // persisted lastSweepAt marker (survives restarts) so it's spaced by the chosen interval, not a fixed
      // 45-min heartbeat. An already queued/running sweep dedupes via idempotency.
      const last = await store.getLatestJob(email, "sweep");
      const sweepActive = last && (last.status === "queued" || last.status === "running");
      if (!sweepActive && sweepDue(profile, now)) {
        // Cost-aware scheduling: DeepSeek's peak window is 2x price. When this sweep is due only because
        // of the >1x/day cadence interval (the once-a-day FLOOR hasn't been crossed), it's safe to hold
        // off during peak hours — the cadence check fires again soon, likely once we're off-peak, and
        // today's coverage isn't at risk. The once-a-day guarantee itself (sweepDueForDay) is NEVER
        // deferred — missing that would break "at least one sweep a day".
        const dayFloorDue = sweepDueForDay(profile.lastSweepAt, profile, now);
        if (isPeakHourUtc(now) && !dayFloorDue) {
          // skip this tick — cheaper to wait for an off-peak opportunity within the same day
        } else {
          await store.enqueueJob(email, "sweep"); enqueued++;
        }
      }

      // (2) EXECUTE ready tasks the browser never got to (offline auto-run), bounded per user per tick.
      // ONLY plain ready+never-attempted: failed_retryable retries through its own job's attempts;
      // failed_terminal waits for the user's explicit Retry — cron never loops on a broken task.
      // ALSO recover ORPHANED queued tasks — ones set to "queued" whose execution job was consumed without
      // running them (a pause/over-budget skip, or a task-not-found race between enqueue and the state
      // commit). Nothing else re-queues a non-"ready" task, so without this they'd sit "working" forever.
      // enqueueJob is idempotent per task, so a queued task that still HAS a live job is a no-op here.
      const activeIds = await store.activeJobTaskIds(email);
      for (const t of tasksToEnqueue(list, activeIds)) { await store.enqueueJob(email, "execute_task", t.id); enqueued++; }
    } catch (e: any) { console.warn(`[jobs] cron skip ${email}:`, e?.message || e); }
  }
  // Drain FAIRLY: round-robin a small per-user quota so one heavy account can't monopolise the batch and
  // starve the tail (global-oldest-first did exactly that). Each pass gives every user up to 2 jobs; repeat
  // passes until the function's time ceiling is near or a whole pass does nothing. Bounded by the 300s cap.
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
