import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import session from "express-session";
import type { Credentials } from "google-auth-library";
import type { WebTask, Profile } from "../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../shared/types.ts";

/** A persisted Google connection for an account (incl. the refresh token, so it stays connected). */
export interface StoredGoogle { tokens: Credentials; email?: string; }

// Cloud persistence, keyed by the user's Google email — so memory + tasks survive restarts and follow
// the ACCOUNT, not the browser cookie. Reuses the repo's existing Supabase project. Prefers a service
// key (bypasses RLS) if provided; otherwise the anon key + the permissive policy in web/supabase.sql.
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const TABLE = "weave_web_state";

const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
// Secrets (refresh tokens, password hashes) live in these tables. With the ANON key + the permissive dev RLS
// policy they're readable by anyone holding that key — fine locally, NOT for production. So: FAIL CLOSED in
// production (don't boot with a secret-exposing config), and warn loudly in dev. Fix is SUPABASE_SERVICE_KEY
// (bypasses RLS) + restricting RLS to the service role.
if (client && !process.env.SUPABASE_SERVICE_KEY) {
  const msg = "Supabase is configured with the ANON key — refresh tokens + password hashes would be readable by anyone holding it.";
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[store] ${msg} Set SUPABASE_SERVICE_KEY (and restrict RLS to the service role) before deploying.`);
  }
  console.warn(`[store] SECURITY: ${msg} Fine locally; set SUPABASE_SERVICE_KEY before you deploy.`);
}

export const cloudEnabled = (): boolean => !!client;
const USERS = "weave_web_users";
const SESSIONS = "weave_web_sessions";

/**
 * A persistent express-session store backed by Supabase, so logins AND working state (tasks/profile)
 * survive server restarts + deploys — not just the cloud account row, but the live session. Without this,
 * the default in-memory store is wiped on every restart, forcing re-login and making changes look "lost".
 * Returns undefined when cloud is unconfigured (express-session then falls back to its MemoryStore).
 */
export async function makeSessionStore(): Promise<session.Store | undefined> {
  if (!client) return undefined;
  const c = client;
  // Probe the table first — if it doesn't exist yet (user hasn't run the latest supabase.sql), fall back to
  // the default in-memory store so login still works, with a clear warning. Never break auth on a missing table.
  const { error: probe } = await c.from(SESSIONS).select("sid").limit(1);
  if (probe) { console.warn(`[store] persistent sessions OFF — run web/supabase.sql to create '${SESSIONS}' (${probe.message}). Using in-memory sessions (lost on restart).`); return undefined; }
  const ttlMs = (sess: any) => (sess?.cookie?.maxAge ?? 30 * 24 * 3600 * 1000);
  const expiry = (sess: any) => new Date(Date.now() + ttlMs(sess)).toISOString();
  class SupabaseStore extends session.Store {
    get(sid: string, cb: (err: any, sess?: any) => void) {
      c.from(SESSIONS).select("sess,expire").eq("sid", sid).maybeSingle().then(
        ({ data, error }) => {
          if (error) return cb(error);
          if (!data) return cb(null, null);
          if (data.expire && new Date(data.expire).getTime() < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
          cb(null, data.sess);
        },
        (e) => cb(e),
      );
    }
    set(sid: string, sess: any, cb?: (err?: any) => void) {
      c.from(SESSIONS).upsert({ sid, sess, expire: expiry(sess) }, { onConflict: "sid" }).then(
        ({ error }) => cb?.(error || undefined),
        (e) => cb?.(e),
      );
    }
    destroy(sid: string, cb?: (err?: any) => void) {
      c.from(SESSIONS).delete().eq("sid", sid).then(({ error }) => cb?.(error || undefined), (e) => cb?.(e));
    }
    touch(sid: string, sess: any, cb?: (err?: any) => void) {
      c.from(SESSIONS).update({ expire: expiry(sess) }).eq("sid", sid).then(() => cb?.(), () => cb?.());
    }
  }
  return new SupabaseStore();
}

/** Look up an account by email → its bcrypt hash (or null if no such user / cloud off). */
export async function getUser(email: string): Promise<{ email: string; pass_hash: string } | null> {
  if (!client) return null;
  try {
    const { data } = await client.from(USERS).select("email,pass_hash").eq("email", email).maybeSingle();
    return data ? { email: data.email, pass_hash: data.pass_hash } : null;
  } catch (e) { console.warn("[store] getUser threw:", (e as any)?.message || e); return null; }
}

/** Create an account. Returns false if it already exists or the write fails. */
export async function createUser(email: string, passHash: string): Promise<boolean> {
  if (!client) return false;
  try {
    const { error } = await client.from(USERS).insert({ email, pass_hash: passHash });
    if (error) { console.warn("[store] createUser failed:", error.message); return false; }
    return true;
  } catch (e) { console.warn("[store] createUser threw:", (e as any)?.message || e); return false; }
}

export interface AccountState { profile: Profile; tasks: WebTask[]; google?: StoredGoogle; }

// A transient network drop (undici "terminated"/"fetch failed", a reset socket) is NOT the same as "no
// data" — but Supabase surfaces it both as a thrown error AND, sometimes, as a returned {error}. Treating
// it as empty state is data-lossy: an account's tasks briefly vanish, and a merge-on-save (commitUser)
// can drop cloud-only tasks. So we detect transience and RETRY with backoff before ever giving up.
const isTransient = (msg: string): boolean =>
  /terminated|fetch failed|socket hang up|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|timeout|503|502|429/i.test(msg);
async function withRetry<T>(label: string, op: () => Promise<{ data: T; error: { message?: string } | null }>, tries = 3): Promise<{ data: T | null; error: { message?: string } | null }> {
  let lastErr: { message?: string } | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const { data, error } = await op();
      if (!error) return { data, error: null };
      lastErr = error;
      if (!isTransient(error.message || "")) return { data: null, error }; // real error (RLS, constraint) → don't retry
    } catch (e: any) {
      lastErr = { message: e?.message || String(e) };
      if (!isTransient(lastErr.message || "")) throw e; // programmer/unknown error → surface it
    }
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); // 250ms, 500ms
  }
  console.warn(`[store] ${label} exhausted retries:`, lastErr?.message);
  return { data: null, error: lastErr };
}

/** Load an account's saved profile + tasks + Google connection. Empty if cloud off or row missing.
 *  Transient network failures are retried (see withRetry) so a blip never collapses state to empty. */
export async function loadState(email?: string): Promise<AccountState> {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  const { data, error } = await withRetry("load", async () =>
    client!.from(TABLE).select("profile,tasks,google").eq("email", email).maybeSingle());
  if (error) { console.warn("[store] load failed:", error.message); return { profile: emptyProfile(), tasks: [] }; }
  const d = data as any;
  const google = d?.google && d.google.tokens ? (d.google as StoredGoogle) : undefined;
  return { profile: normalizeProfile(d?.profile), tasks: Array.isArray(d?.tasks) ? d.tasks : [], google };
}

/** Persist an account's profile + tasks + Google connection (best-effort; never throws into the request
 *  path). Transient network failures are retried so a blip doesn't silently drop a write. */
export async function saveState(email: string | undefined, state: AccountState): Promise<void> {
  if (!client || !email) return;
  const { error } = await withRetry("save", async () =>
    client!.from(TABLE).upsert(
      { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], google: state.google ?? null, updated_at: new Date().toISOString() },
      { onConflict: "email" }
    ).then((r) => ({ data: null, error: r.error })));
  if (error) console.warn("[store] save failed:", error.message);
}

/** Every account email with saved state — the cron sweeper iterates these to work while users are offline. */
export async function listAccountEmails(limit = 200): Promise<string[]> {
  if (!client) return [];
  try {
    const { data, error } = await client.from(TABLE).select("email").order("updated_at", { ascending: false }).limit(limit);
    if (error) { console.warn("[store] listAccountEmails failed:", error.message); return []; }
    return (data || []).map((r: any) => String(r.email)).filter(Boolean);
  } catch { return []; }
}

// ── Durable job queue ─────────────────────────────────────────────────────────
// The DB row IS the lock: claiming is a conditional UPDATE keyed on the current status, so exactly one
// serverless instance wins even when several drain at once. When the jobs table is unreachable (dev with
// only the anon key + locked-down RLS, or no Supabase at all), an in-memory queue keeps a single dev
// process fully working — same interface, no durability.

export type JobType = "sweep" | "execute_task" | "execute_step" | "revise" | "end_of_day_report";
export type JobStatus = "queued" | "running" | "succeeded" | "failed_retryable" | "failed_terminal" | "cancelled";
export interface Job {
  id: string;
  user_email: string;
  task_id?: string | null;
  type: JobType;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  locked_until?: string | null;
  input?: any;
  output?: any;
  last_error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

const JOBS = "weave_web_jobs";
const EVENTS = "weave_web_job_events";
const LOCK_MS = 5 * 60_000; // a claim expires after 5min — a crashed worker's job becomes claimable again

// In-memory fallback (dev without a reachable jobs table).
const memJobs: Job[] = [];
let jobsTableOk: boolean | null = null; // probed once per process
async function jobsDb(): Promise<SupabaseClient | null> {
  if (!client) return null;
  if (jobsTableOk === null) {
    const { error } = await client.from(JOBS).select("id").limit(1);
    jobsTableOk = !error;
    if (error) console.warn(`[store] jobs table unreachable (${error.message}) — using in-memory queue (fine for one dev process; run supabase.sql + SUPABASE_SERVICE_KEY for durability).`);
  }
  return jobsTableOk ? client : null;
}
// RLS lets the anon key SELECT (zero rows) but rejects INSERT/UPDATE, so the read probe above passes
// and the first write is where a locked-down table actually reveals itself — demote to memory there.
function demoteIfRls(error: { code?: string; message?: string } | null): boolean {
  if (!error || !(error.code === "42501" || /row-level security/i.test(error.message || ""))) return false;
  jobsTableOk = false;
  console.warn(`[store] jobs table not writable (${error.message}) — using in-memory queue (fine for one dev process; set SUPABASE_SERVICE_KEY for durability).`);
  return true;
}

/** Enqueue a job. Idempotent: if an ACTIVE (queued/running) job already exists for the same key, returns it
 *  instead of creating a duplicate — this is what makes double-clicks/two tabs/cron overlap safe. */
export async function enqueueJob(userEmail: string, type: JobType, taskId?: string, input?: any): Promise<Job> {
  // Execution job types share ONE key per task — a revise while a run is in flight (or two step runs at
  // once) would double-burn the agent and race writes, exactly what the old per-task lock prevented.
  const key = type === "sweep" ? `${userEmail}:sweep` : `${userEmail}:task:${taskId}`;
  const db = await jobsDb();
  if (db) {
    const { data: existing } = await db.from(JOBS).select("*").eq("idempotency_key", key).in("status", ["queued", "running"]).limit(1);
    if (existing?.length) return existing[0] as Job;
    const { data, error } = await db.from(JOBS).insert({ user_email: userEmail, task_id: taskId ?? null, type, idempotency_key: key, input: input ?? null }).select().single();
    if (!error && data) return data as Job;
    // Unique-index race (another instance inserted first) → fetch the winner.
    const { data: winner } = await db.from(JOBS).select("*").eq("idempotency_key", key).in("status", ["queued", "running"]).limit(1);
    if (winner?.length) return winner[0] as Job;
    if (!demoteIfRls(error)) throw new Error(`enqueue failed: ${error?.message || "unknown"}`);
    // fall through to the in-memory queue below
  }
  const active = memJobs.find((j) => j.idempotency_key === key && (j.status === "queued" || j.status === "running"));
  if (active) return active;
  const job: Job = { id: crypto.randomUUID(), user_email: userEmail, task_id: taskId ?? null, type, status: "queued", attempt_count: 0, max_attempts: 3, idempotency_key: key, input, created_at: new Date().toISOString() };
  memJobs.push(job);
  if (memJobs.length > 500) memJobs.splice(0, memJobs.length - 500);
  return job;
}

/** Atomically claim ONE runnable job: oldest queued, or a running job whose lock expired (crashed worker).
 *  Exactly-one-winner via a conditional UPDATE on the previous status. Returns null when nothing to do. */
export async function claimJob(workerId: string): Promise<Job | null> {
  const db = await jobsDb();
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  if (db) {
    // Two passes: fresh queued jobs first, then expired-lock running jobs (retry of a crashed claim).
    for (const pass of ["queued", "expired"] as const) {
      const q = db.from(JOBS).select("id,status,attempt_count,max_attempts").order("created_at", { ascending: true }).limit(5);
      const { data: candidates } = pass === "queued"
        ? await q.eq("status", "queued")
        : await q.eq("status", "running").lt("locked_until", now.toISOString());
      for (const c of candidates || []) {
        if (c.attempt_count >= c.max_attempts) { // exhausted — close it out instead of spinning forever
          await db.from(JOBS).update({ status: "failed_terminal", finished_at: now.toISOString(), last_error: "max attempts exceeded" }).eq("id", c.id).eq("status", c.status);
          continue;
        }
        const { data: won } = await db.from(JOBS)
          .update({ status: "running", locked_by: workerId, locked_until: lockUntil, started_at: now.toISOString(), attempt_count: c.attempt_count + 1 })
          .eq("id", c.id).eq("status", c.status).eq("attempt_count", c.attempt_count) // CAS: only the instance that saw this exact state wins
          .select();
        if (won?.length) return won[0] as Job;
      }
    }
    return null;
  }
  const job = memJobs.find((j) => j.status === "queued" || (j.status === "running" && j.locked_until && j.locked_until < now.toISOString()));
  if (!job) return null;
  if (job.attempt_count >= job.max_attempts) { job.status = "failed_terminal"; job.last_error = "max attempts exceeded"; return claimJob(workerId); }
  job.status = "running"; job.locked_until = lockUntil; job.started_at = now.toISOString(); job.attempt_count++;
  return job;
}

/** Mark a claimed job finished — success, retryable failure (goes back to queued-like claimable state), or terminal. */
export async function finishJob(id: string, outcome: "succeeded" | "failed", error?: string, output?: any): Promise<void> {
  const db = await jobsDb();
  const now = new Date().toISOString();
  if (db) {
    if (outcome === "succeeded") {
      await db.from(JOBS).update({ status: "succeeded", finished_at: now, output: output ?? null, locked_until: null }).eq("id", id);
    } else {
      const { data } = await db.from(JOBS).select("attempt_count,max_attempts").eq("id", id).maybeSingle();
      const terminal = (data?.attempt_count ?? 1) >= (data?.max_attempts ?? 3);
      await db.from(JOBS).update({
        status: terminal ? "failed_terminal" : "queued", // retryable → back to queued for the next drain
        ...(terminal ? { finished_at: now } : {}), last_error: String(error || "").slice(0, 500), locked_until: null,
      }).eq("id", id);
    }
    return;
  }
  const job = memJobs.find((j) => j.id === id);
  if (!job) return;
  if (outcome === "succeeded") { job.status = "succeeded"; job.finished_at = now; job.output = output; }
  else {
    const terminal = job.attempt_count >= job.max_attempts;
    job.status = terminal ? "failed_terminal" : "queued";
    job.last_error = String(error || "").slice(0, 500);
    if (terminal) job.finished_at = now;
  }
  job.locked_until = null;
}

/** Newest job of a type for a user — the cron uses this to decide whether a sweep is due. */
export async function getLatestJob(userEmail: string, type: JobType): Promise<Job | null> {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("*").eq("user_email", userEmail).eq("type", type).order("created_at", { ascending: false }).limit(1);
    return (data?.[0] as Job) || null;
  }
  const mine = memJobs.filter((j) => j.user_email === userEmail && j.type === type);
  return mine[mine.length - 1] || null;
}

/** Count a user's ACTIVE (queued/running) jobs — the client polls this to know when to stop kicking. */
export async function countActiveJobs(userEmail: string): Promise<number> {
  const db = await jobsDb();
  if (db) {
    const { count } = await db.from(JOBS).select("id", { count: "exact", head: true }).eq("user_email", userEmail).in("status", ["queued", "running"]);
    return count || 0;
  }
  return memJobs.filter((j) => j.user_email === userEmail && (j.status === "queued" || j.status === "running")).length;
}

/** Task ids that have a genuinely ACTIVE (queued/running) job — the honest source for "retrying
 *  automatically" in the UI: no active job means the only path forward is the user's Retry click. */
export async function activeJobTaskIds(userEmail: string): Promise<string[]> {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("task_id").eq("user_email", userEmail).in("status", ["queued", "running"]).not("task_id", "is", null).limit(100);
    return [...new Set((data || []).map((r: any) => String(r.task_id)).filter(Boolean))];
  }
  return [...new Set(memJobs.filter((j) => j.user_email === userEmail && (j.status === "queued" || j.status === "running") && j.task_id).map((j) => String(j.task_id)))];
}

export async function getJob(id: string, userEmail: string): Promise<Job | null> {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("*").eq("id", id).eq("user_email", userEmail).maybeSingle();
    return (data as Job) || null;
  }
  return memJobs.find((j) => j.id === id && j.user_email === userEmail) || null;
}

// ── Task timeline events ──────────────────────────────────────────────────────
export interface JobEvent { kind: string; message?: string; at: string; task_id?: string | null; }
const memEvents: (JobEvent & { user_email: string; job_id?: string })[] = [];

/** Append a timeline event (best-effort — never throws into the execution path). */
export async function recordEvent(userEmail: string, kind: string, opts: { taskId?: string; jobId?: string; message?: string } = {}): Promise<void> {
  const db = await jobsDb();
  const row = { user_email: userEmail, task_id: opts.taskId ?? null, job_id: opts.jobId ?? null, kind, message: opts.message ? String(opts.message).slice(0, 300) : null };
  if (db) {
    try {
      const { error } = await db.from(EVENTS).insert(row);
      if (!error) return;
      demoteIfRls(error); // fall through to memory either way — best-effort
    } catch { return; }
  }
  memEvents.push({ ...row, at: new Date().toISOString() } as any);
  if (memEvents.length > 1000) memEvents.splice(0, memEvents.length - 1000);
}

/** A task's timeline, newest first — powers the card's Activity section. */
export async function eventsForTask(userEmail: string, taskId: string, limit = 20): Promise<JobEvent[]> {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(EVENTS).select("kind,message,at,task_id").eq("user_email", userEmail).eq("task_id", taskId).order("at", { ascending: false }).limit(limit);
    return (data as JobEvent[]) || [];
  }
  return memEvents.filter((e) => e.user_email === userEmail && e.task_id === taskId).slice(-limit).reverse();
}
