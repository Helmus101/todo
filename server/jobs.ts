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

const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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
  const next = await tasks.generate(list, profile, extras, email);
  // Server-side auto-run: queue execution for the new ready tasks RIGHT IN THE SWEEP (top by score,
  // bounded) — the browser no longer decides what runs; it only displays state and kicks the drain.
  const found = next.filter((t) => !before.has(t.id) && !isHandled(t.status));
  const toRun = found.filter((t) => canonStatus(t.status) === "ready").sort((a, b) => b.score - a.score).slice(0, 3);
  for (const t of toRun) t.status = "queued";
  await commitUser(email, profile, next);
  for (const t of found) void store.recordEvent(email, "found", { taskId: t.id, jobId: job.id, message: `Found from ${t.source}` });
  for (const t of toRun) { await store.enqueueJob(email, "execute_task", t.id); void store.recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" }); }
  return `swept: ${found.length} new task${found.length === 1 ? "" : "s"}, ${toRun.length} queued`;
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
    await commitUser(email, profile, list);
    const done = updated?.steps?.length ? `${updated.steps.filter((s) => !s.done).length} step(s) need you` : "fully handled";
    await store.recordEvent(email, "run_succeeded", { taskId, jobId: job.id, message: updated?.synthesis?.slice(0, 200) || done });
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
  for (const email of emails) {
    try {
      const { profile, list } = await loadUser(email);
      if (profile.paused) continue;
      // Sweep if the newest sweep job is older than the window (queued/running ones dedupe via idempotency).
      const last = await store.getLatestJob(email, "sweep");
      const lastAt = Date.parse(last?.finished_at || last?.created_at || "") || 0;
      const active = last && (last.status === "queued" || last.status === "running");
      if (!active && Date.now() - lastAt > SWEEP_WINDOW_MS) { await store.enqueueJob(email, "sweep"); enqueued++; }
      // Execute ready tasks the browser never got to (offline auto-run), bounded per user per tick.
      // ONLY plain ready+never-attempted: failed_retryable retries through its own job's attempts;
      // failed_terminal waits for the user's explicit Retry — cron never loops on a broken task.
      const ready = list.filter((t) => canonStatus(t.status) === "ready" && !t.autoRan).slice(0, 2);
      for (const t of ready) { await store.enqueueJob(email, "execute_task", t.id); enqueued++; }
    } catch (e: any) { console.warn(`[jobs] cron skip ${email}:`, e?.message || e); }
  }
  const { processed, failed } = await drain(5);
  return { users: emails.length, enqueued, processed, failed };
}
