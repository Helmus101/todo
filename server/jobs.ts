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
import { emptyProfile, canonStatus, isHandled } from "../shared/types.ts";
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
  const tz = profile.workingHours?.timezone;
  return localDay(lastSweepAt, tz) !== localDay(now, tz);
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
  await store.saveState(email, { profile: mergedProfile, tasks: mergedTasks, google: current.google });
}

async function processSweep(job: store.Job): Promise<string> {
  const email = job.user_email;
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  const extras = await integrations.getAgentTools(email);
  if (!extras?.tools?.length) return "skipped: nothing connected";
  const before = new Set(list.map((t) => t.id));
  const factsBefore = new Set([...profile.preferences, ...profile.people, ...profile.projects]);
  // Auto-refine raw manual task names (added while AI was off) — no button needed; the next sweep cleans
  // them up. Bounded per sweep; a failed refine just stays raw for the next one.
  for (const t of list.filter((x) => x.unrefined && !isHandled(x.status)).slice(0, 3)) {
    try {
      const refined = await claude.refineManualTask(t.title, profile);
      if (refined) { tasks.applyRefinement(list, t.id, refined); void store.recordEvent(email, "refined", { taskId: t.id, message: `Refined to "${t.title}"` }); }
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
  if (profile.paused) return "skipped: AI paused";
  const t = list.find((x) => x.id === taskId);
  if (!t) return "skipped: task not found";
  const c = canonStatus(t.status);
  if (isHandled(t.status)) return "skipped: already handled";
  if (c === "needs_review" && !job.input?.note) return "skipped: already executed"; // idempotency — a retry never re-burns a finished run
  if (c === "failed_terminal" && !job.input?.manual) return "skipped: failed terminally — waiting for the user's Retry";
  await store.recordEvent(email, "run_started", { taskId, jobId: job.id, message: job.input?.note ? "Revising per your note" : "Reading context and doing the reversible work" });
  const extras = await integrations.getAgentTools(email);
  t.autoRan = true; // whether this attempt succeeds or not, don't loop on it automatically
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
    await commitUser(email, profile, list);
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
  if (!Number.isInteger(index)) return "skipped: bad step index";
  await store.recordEvent(email, "step_started", { taskId, jobId: job.id, message: `Running step ${index + 1}` });
  // The user explicitly clicked Approve & Run — the permissioned toolset is correct here.
  const permTools = await integrations.getAgentToolsWithPermission(email).catch(() => undefined);
  const updated = await tasks.runStep(list, taskId, index, profile, permTools, job.input?.answer ? String(job.input.answer) : undefined);
  if (updated && (updated.links?.length || updated.sendables?.length)) {
    const droppedArtifacts = await integrations.verifyTaskArtifacts(email, updated).catch(() => []);
    for (const d of droppedArtifacts) void store.recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
  }
  await commitUser(email, profile, list);
  await store.recordEvent(email, "step_done", { taskId, jobId: job.id, message: updated?.steps?.[index]?.text?.slice(0, 200) });
  return "step executed";
}

async function processEndOfDayReport(job: store.Job): Promise<string> {
  const email = job.user_email;
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  const extras = await integrations.getAgentTools(email);
  if (!extras?.selfBrief) return "skipped: Gmail not connected for report";
  
  // Generate the report
  const completed = list.filter((t) => canonStatus(t.status) === "done").slice(-10);
  const active = list.filter((t) => !isHandled(t.status)).slice(0, 15);
  const highPriority = active.filter((t) => t.importance >= 0.7).slice(0, 5);
  
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  
  let body = `End of day report — ${today}\n\n`;
  
  if (completed.length) {
    body += `✓ Completed today (${completed.length}):\n`;
    for (const t of completed) {
      body += `  • ${t.title}\n`;
    }
    body += "\n";
  }
  
  if (active.length) {
    body += `📋 Still active (${active.length}):\n`;
    for (const t of active.slice(0, 8)) {
      const urgency = t.urgency >= 0.7 ? "🔴" : t.urgency >= 0.4 ? "🟡" : "🟢";
      body += `  ${urgency} ${t.title}${t.when ? ` (${t.when})` : ""}\n`;
    }
    body += "\n";
  }
  
  if (highPriority.length) {
    body += `⚡ High priority:\n`;
    for (const t of highPriority) {
      body += `  • ${t.title}${t.when ? ` — ${t.when}` : ""}\n`;
    }
    body += "\n";
  }
  
  body += `— Otto\n\n`;
  body += `Open your dashboard to see the full list and take action.`;
  
  const subject = `Otto daily report — ${completed.length} done, ${active.length} active`;
  
  try {
    const result = await extras.selfBrief(subject, body);
    await store.recordEvent(email, "report_sent", { jobId: job.id, message: "End of day report emailed" });
    return `report sent: ${result}`;
  } catch (e: any) {
    await store.recordEvent(email, "report_failed", { jobId: job.id, message: String(e?.message || e).slice(0, 200) });
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
    case "end_of_day_report": return processEndOfDayReport(job);
    default: return `skipped: unknown type ${job.type}`;
  }
}

/** Claim + process up to `limit` jobs, stopping when the time budget is spent (serverless functions have
 *  hard ceilings — persist progress per job, never hold work hostage to the batch). */
export async function drain(limit = 3, budgetMs = 240_000): Promise<{ processed: number; failed: number }> {
  const t0 = Date.now();
  let processed = 0, failed = 0;
  for (let i = 0; i < limit; i++) {
    if (Date.now() - t0 > budgetMs) break;
    const job = await store.claimJob(workerId);
    if (!job) break;
    try {
      const note = await processJob(job);
      await store.finishJob(job.id, "succeeded", undefined, { note });
      processed++;
    } catch (e: any) {
      console.error(`[jobs] ${job.type} failed for ${job.user_email}${job.task_id ? ` task ${job.task_id}` : ""}:`, e?.message || e);
      await store.finishJob(job.id, "failed", e?.message || String(e));
      if (job.task_id) void store.recordEvent(job.user_email, "run_failed", { taskId: job.task_id, jobId: job.id, message: String(e?.message || e).slice(0, 200) });
      failed++;
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
  const SWEEP_WINDOW_MS = 45 * 60_000;
  const emails = await store.listAccountEmails(50);
  let enqueued = 0;
  const now = new Date();
  const currentHour = now.getHours();
  
  for (const email of emails) {
    try {
      const { profile, list } = await loadUser(email);
      if (profile.paused) continue;

      // (1) SWEEP FIRST — the durable once-per-local-day guarantee. Uses the persisted lastSweepAt marker
      // (survives restarts), NOT a rolling window: if no successful sweep has landed in the user's current
      // local day, enqueue one. An already queued/running sweep dedupes via idempotency. The 45-min window
      // is kept ONLY for the interactive kick path (/api/tasks/generate), not this daily guarantee.
      const last = await store.getLatestJob(email, "sweep");
      const sweepActive = last && (last.status === "queued" || last.status === "running");
      const windowElapsed = (Date.now() - (Date.parse(last?.finished_at || last?.created_at || "") || 0)) > SWEEP_WINDOW_MS;
      if (!sweepActive && (sweepDueForDay(profile.lastSweepAt, profile, now) || windowElapsed)) {
        await store.enqueueJob(email, "sweep"); enqueued++;
      }

      // (2) EXECUTE ready tasks the browser never got to (offline auto-run), bounded per user per tick.
      // ONLY plain ready+never-attempted: failed_retryable retries through its own job's attempts;
      // failed_terminal waits for the user's explicit Retry — cron never loops on a broken task.
      const ready = list.filter((t) => canonStatus(t.status) === "ready" && !t.autoRan).slice(0, 2);
      for (const t of ready) { await store.enqueueJob(email, "execute_task", t.id); enqueued++; }

      // (3) END-OF-DAY REPORT — LAST, and only when nothing is still pending for this user, so the report
      // reflects a finished day's work (the sweep + its executions) rather than racing ahead of them.
      if (profile.workingHours) {
        const [endHour] = profile.workingHours.end.split(":").map(Number);
        const reportWindowEnd = (endHour + 1) % 24;
        const inReportWindow = currentHour === endHour || (reportWindowEnd < endHour && (currentHour >= endHour || currentHour < reportWindowEnd));
        if (inReportWindow) {
          const lastReport = await store.getLatestJob(email, "end_of_day_report");
          const lastReportAt = Date.parse(lastReport?.finished_at || lastReport?.created_at || "") || 0;
          const reportToday = lastReportAt && new Date(lastReportAt).toDateString() === now.toDateString();
          const stillWorking = await store.countActiveJobs(email); // sweep/execute jobs queued above
          if (!reportToday && stillWorking === 0) { await store.enqueueJob(email, "end_of_day_report"); enqueued++; }
        }
      }
    } catch (e: any) { console.warn(`[jobs] cron skip ${email}:`, e?.message || e); }
  }
  // Hobby-plan cron fires once daily, so this tick is the only guaranteed background turn:
  // drain a bigger batch within the function's 300s ceiling.
  const { processed, failed } = await drain(10, 270_000);
  return { users: emails.length, enqueued, processed, failed };
}
