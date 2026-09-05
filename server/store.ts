import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import session from "express-session";
import type { Credentials } from "google-auth-library";
import type { WebTask, Profile, StudySession, StudyProfile } from "../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../shared/types.ts";
import { encryptSecret, decryptSecret } from "./crypto.ts";
import { reportError } from "./sentry.ts";
import type { BanditState } from "./bandit.ts";

/** A persisted Google connection for an account (incl. the refresh token, so it stays connected). */
export interface StoredGoogle { tokens: Credentials; email?: string; }

/** A persisted Pronote (French school portal) connection. `token` is a rotating credential the pawnote
 *  library issues in place of the password after the first login — NOT the password itself, which is used
 *  once to connect and never stored (see server/pronote.ts). Protected by RLS + the service-role-only
 *  write path (supabase.sql) AND, transparently in loadState/saveState below, app-level AES-256-GCM
 *  encryption (server/crypto.ts) — this interface always holds the LIVE plaintext token in memory, only
 *  the DB row is encrypted. */
export interface StoredPronote { url: string; username: string; kind: number; token: string; deviceUUID: string; navigatorIdentifier?: string;
  /** PRONOTE_MOCK only: when the mock account was connected — the fixed anchor mock homework/test deadlines
   *  are computed from, so they're real fixed dates that actually pass (and stop being returned) as time
   *  goes on, instead of always being "N days from right now" on every fetch. */
  mockConnectedAt?: string;
  /** Set when a session attempt fails with a genuinely dead token (SessionExpiredError/BadCredentialsError,
   *  not a transient network/portal blip) — without this, a dead token looks IDENTICAL to "no homework
   *  today" forever: pronoteConnected() only checks that a row exists, so the student sees an empty task
   *  list with no signal to reconnect. Cleared on the next successful session (see runPronoteSessionOnce)
   *  and on a fresh connectPronote(). */
  needsReconnect?: boolean;
}

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
  // express-session's middleware calls store.get() on EVERY authenticated request to hydrate req.session —
  // each one was a fresh `select("sess,expire")` pulling the ENTIRE session blob (profile + all tasks,
  // notes, flashcards, quizzes, chat history, audit trail — see shared/types.ts) straight from Supabase.
  // That's the single biggest egress driver in this app: a page load alone fires several API calls close
  // together (status, tasks, reviews/due, ...), each separately re-fetching the identical blob, and the
  // client's own 45s poll (client/App.tsx) repeats that every cycle for every open tab. A short in-memory
  // cache (per warm process — helps a long-running server fully, and helps a serverless deployment for
  // requests landing on the same warm instance within the window) collapses that burst into one real read.
  // 4s: long enough to absorb a page load's request burst and back-to-back polls firing close together,
  // short enough that a genuinely stale read (another tab/device just wrote) self-heals almost immediately
  // even without the explicit invalidation below.
  const GET_CACHE_TTL_MS = 4000;
  // Bounded so this can't grow forever on a long-running server (a serverless deployment recycles the
  // process anyway) — every distinct sid that's ever hit get()/set() would otherwise sit in memory until
  // process restart, and a session blob can be sizeable (see comment above). A Map preserves insertion
  // order, so deleting from the front evicts the OLDEST entries first — a crude but correct LRU-ish bound
  // given entries are re-inserted (moved conceptually to "recently used") via delete+set in `touch()` below.
  const GET_CACHE_MAX = 500;
  const getCache = new Map<string, { at: number; sess: any }>();
  const cacheSet = (sid: string, sess: any) => {
    getCache.delete(sid); // re-insert to the end so this counts as "most recently used" for eviction below
    getCache.set(sid, { at: Date.now(), sess });
    while (getCache.size > GET_CACHE_MAX) { const oldest = getCache.keys().next().value; if (oldest === undefined) break; getCache.delete(oldest); }
  };
  class SupabaseStore extends session.Store {
    get(sid: string, cb: (err: any, sess?: any) => void) {
      const cached = getCache.get(sid);
      if (cached && Date.now() - cached.at < GET_CACHE_TTL_MS) { cb(null, cached.sess); return; }
      c.from(SESSIONS).select("sess,expire").eq("sid", sid).maybeSingle().then(
        ({ data, error }) => {
          if (error) { reportError("session-store-get", error); return cb(error); }
          if (!data) return cb(null, null);
          if (data.expire && new Date(data.expire).getTime() < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
          cacheSet(sid, data.sess);
          cb(null, data.sess);
        },
        (e) => cb(e),
      );
    }
    set(sid: string, sess: any, cb?: (err?: any) => void) {
      // Cache the just-written value immediately (not just invalidate) — the very next get() in the same
      // burst (extremely common: a route calls commit() then the response handler re-reads) would otherwise
      // do a real round-trip anyway, right after we already had the answer in hand.
      cacheSet(sid, sess);
      c.from(SESSIONS).upsert({ sid, sess, expire: expiry(sess) }, { onConflict: "sid" }).then(
        ({ error }) => { if (error) reportError("session-store-set", error); cb?.(error || undefined); },
        (e) => { reportError("session-store-set", e); cb?.(e); },
      );
    }
    destroy(sid: string, cb?: (err?: any) => void) {
      getCache.delete(sid);
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

/**
 * Mirror the signup into Supabase's own Auth users table (Authentication tab in the dashboard), so accounts
 * are visible there too — not just in `weave_web_users`. Otto's actual login still runs on its own bcrypt
 * table above (that's what sessions are keyed off), so this is a best-effort side-write: the admin API
 * needs the service-role key, and any failure here (key missing, email already mirrored, Auth not enabled)
 * must never block or roll back the real signup.
 */
export async function mirrorAuthUser(email: string, password: string): Promise<void> {
  if (!client || !process.env.SUPABASE_SERVICE_KEY) return;
  try {
    const { error } = await client.auth.admin.createUser({ email, password, email_confirm: true });
    if (error && !/already been registered|already exists/i.test(error.message)) {
      console.warn("[store] mirrorAuthUser failed:", error.message);
    }
  } catch (e) { console.warn("[store] mirrorAuthUser threw:", (e as any)?.message || e); }
}

/** Remove the mirrored Supabase Auth user on account deletion, so erasure covers the Auth table too. */
export async function deleteAuthUser(email: string): Promise<void> {
  if (!client || !process.env.SUPABASE_SERVICE_KEY) return;
  try {
    const { data, error } = await client.auth.admin.listUsers();
    if (error) { console.warn("[store] deleteAuthUser lookup failed:", error.message); return; }
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) await client.auth.admin.deleteUser(match.id);
  } catch (e) { console.warn("[store] deleteAuthUser threw:", (e as any)?.message || e); }
}

export interface AccountState { profile: Profile; tasks: WebTask[]; google?: StoredGoogle; pronote?: StoredPronote; studySessions?: StudySession[]; studyProfile?: StudyProfile; }

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

// loadState() is called from ~15 places across index.ts/pronote.ts/jobs.ts — commit()'s own background
// cross-device merge, findTaskOrReload's cloud-miss fallback, the login/session-bootstrap path, the sweep
// job, etc. Each was previously an uncached `select(...)` returning the account's full profile+tasks blob
// (the same egress driver as the session store, see makeSessionStore's cache above) — a single request
// that touches a couple of these call sites (routine before this cache existed) paid for that blob's full
// weight multiple times over. Same pattern, same reasoning: short TTL, invalidate-on-write, bounded size.
const STATE_CACHE_TTL_MS = 4000;
const STATE_CACHE_MAX = 500;
const stateCache = new Map<string, { at: number; state: AccountState }>();
function cacheSetState(email: string, state: AccountState) {
  stateCache.delete(email);
  stateCache.set(email, { at: Date.now(), state });
  while (stateCache.size > STATE_CACHE_MAX) { const oldest = stateCache.keys().next().value; if (oldest === undefined) break; stateCache.delete(oldest); }
}

/** Load an account's saved profile + tasks + Google connection. Empty if cloud off or row missing.
 *  Transient network failures are retried (see withRetry) so a blip never collapses state to empty. */
export async function loadState(email?: string): Promise<AccountState> {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  const cached = stateCache.get(email);
  if (cached && Date.now() - cached.at < STATE_CACHE_TTL_MS) return cached.state;
  const { data, error } = await withRetry("load", async () =>
    client!.from(TABLE).select("profile,tasks,google,pronote").eq("email", email).maybeSingle());
  if (error) { console.warn("[store] load failed:", error.message); reportError("load-state", error, { email }); return { profile: emptyProfile(), tasks: [] }; }
  const d = data as any;
  const google = d?.google && d.google.tokens ? (d.google as StoredGoogle) : undefined;
  const pronote = d?.pronote && d.pronote.token
    ? { ...(d.pronote as StoredPronote), token: decryptSecret(d.pronote.token) }
    : undefined;
  const result = { profile: normalizeProfile(d?.profile), tasks: Array.isArray(d?.tasks) ? d.tasks : [], google, pronote };
  cacheSetState(email, result);
  return result;
}

/** Persist an account's profile + tasks + Google/Pronote connection (best-effort; never throws into the
 *  request path). Transient network failures are retried so a blip doesn't silently drop a write. */
export async function saveState(email: string | undefined, state: AccountState): Promise<void> {
  if (!client || !email) return;
  const row: Record<string, unknown> = { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], updated_at: new Date().toISOString() };
  // Only touch google/pronote when the CALLER explicitly manages that connection. Most callers (commit()
  // on every confirm/dismiss/run/revise) only ever deal with profile+tasks and never pass these — including
  // them unconditionally as `?? null` would silently NULL OUT a live connection on the very next unrelated
  // save. Omitting the key from the upsert payload leaves the existing column value alone.
  if ("google" in state) row.google = state.google ?? null;
  if ("pronote" in state) {
    row.pronote = state.pronote ? { ...state.pronote, token: encryptSecret(state.pronote.token) } : null;
  }
  // Invalidate rather than try to update-in-place: `state` here often omits google/pronote entirely (see
  // comment above), so overwriting the cached entry with it would wrongly blank out fields this save never
  // touched. A plain delete costs one extra real read on the next loadState() for this email — cheap and
  // safe compared to reconstructing the merged shape by hand.
  stateCache.delete(email);
  const { error } = await withRetry("save", async () =>
    client!.from(TABLE).upsert(row, { onConflict: "email" }).then((r) => ({ data: null, error: r.error })));
  if (error) { console.warn("[store] save failed:", error.message); reportError("save-state", error, { email }); }
}

// ── Personalization bandit (see server/bandit.ts for the pure Thompson-Sampling math) ──────────────────
// Two tables: `weave_web_bandit` holds the CURRENT posterior per (email, decision_key) — small, overwritten
// in place; `weave_web_session_outcomes` is an append-only log of every (arm, context, reward) tuple, kept
// for auditability and so the reward formula's weights can be revisited later without re-collecting data.
// Same posture as the rest of this file: best-effort, in-memory fallback, NEVER throws into the request
// path — a bandit hiccup must not be able to block starting or ending a study session.
const BANDIT = "weave_web_bandit";
const OUTCOMES = "weave_web_session_outcomes";
const memBandit = new Map<string, BanditState>(); // key: `${email}:${decisionKey}`
export interface SessionOutcome { userEmail: string; decisionKey: string; arm: string; context: string; reward: number; at: string; }
const memOutcomes: SessionOutcome[] = [];

export async function loadBanditState(email: string, decisionKey: string): Promise<BanditState> {
  const memKey = `${email}:${decisionKey}`;
  if (!client) return memBandit.get(memKey) || {};
  try {
    const { data, error } = await client.from(BANDIT).select("state").eq("email", email).eq("decision_key", decisionKey).maybeSingle();
    if (error) throw error;
    return (data as any)?.state || {};
  } catch { return memBandit.get(memKey) || {}; }
}

export async function saveBanditState(email: string, decisionKey: string, state: BanditState): Promise<void> {
  const memKey = `${email}:${decisionKey}`;
  memBandit.set(memKey, state); // set locally regardless — a durable-write failure shouldn't lose it for THIS process's lifetime
  if (!client) return;
  try {
    const { error } = await client.from(BANDIT).upsert(
      { email, decision_key: decisionKey, state, updated_at: new Date().toISOString() },
      { onConflict: "email,decision_key" },
    );
    if (error) throw error;
  } catch (e: any) { console.warn("[store] saveBanditState failed (kept in-memory only):", e?.message || e); }
}

/** Append one (context, arm, reward) tuple — best-effort, in-memory-capped fallback so a missing table
 *  (before supabase.sql has been run) degrades to "not durable" rather than breaking session end. */
export async function recordSessionOutcome(o: SessionOutcome): Promise<void> {
  if (client) {
    try {
      const { error } = await client.from(OUTCOMES).insert({ email: o.userEmail, decision_key: o.decisionKey, arm: o.arm, context: o.context, reward: o.reward, at: o.at });
      if (!error) return;
    } catch { /* fall through to memory */ }
  }
  memOutcomes.push(o);
  if (memOutcomes.length > 1000) memOutcomes.splice(0, memOutcomes.length - 1000);
}

/** General-purpose metric point, reusing the SAME table as bandit outcomes above (it's already the right
 *  shape: a labeled decision/metric name, a bucket, freeform context, and a number) rather than adding a
 *  new table per new signal — deliberately kept flexible so a new metric is "call this with a name", not a
 *  schema change. `name` is the metric ("task_lateness_hours", "flashcard_struggle", "study_exit_early", ...
 *  — an open string, not a fixed enum, so new call sites can invent one without touching this file), `bucket`
 *  is a coarse label for that metric (e.g. the task's source, or "n/a"), `value` is whatever number the
 *  metric represents (hours late, seconds elapsed, correct-rate — the caller documents its own unit),
 *  `context` is a short freeform string for anything else worth keeping (a card's front, a task id).
 *  Best-effort, same posture as recordSessionOutcome — a metrics hiccup must never affect the real feature. */
export async function recordMetric(email: string, name: string, value: number, bucket = "n/a", context = ""): Promise<void> {
  return recordSessionOutcome({ userEmail: email, decisionKey: `metric:${name}`, arm: bucket, context, reward: value, at: new Date().toISOString() });
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

const RATELIMITS = "weave_web_ratelimits";
// Cached across calls, not re-probed every time — a missing table (migration not yet run) shouldn't mean a
// failed `select` on literally every rate-limited request forever; one probe per boot is enough, mirroring
// makeSessionStore's own probe-then-remember pattern above.
let ratelimitsTableOk: boolean | null = null;

/** Cross-instance rate-limit check backed by Supabase — see `weave_web_ratelimits` in supabase.sql. Returns
 *  `null` (not `{allowed:false}`) when the table is unreachable, so the caller can fall back to its
 *  in-memory limiter rather than either failing open (no limit at all) or failing closed (locking everyone
 *  out because a migration hasn't run yet). Read-then-write, not a single atomic op — under real concurrent
 *  requests to the SAME key this can let a couple extra through right at the boundary, which is fine for
 *  abuse mitigation (not a hard security limit); an RPC/stored-procedure version would close that gap at
 *  the cost of a schema migration most deployments of this app don't need. */
export async function checkRateLimit(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number } | null> {
  if (!client || ratelimitsTableOk === false) return null;
  const now = Date.now();
  try {
    const { data, error } = await client.from(RATELIMITS).select("hits").eq("key", key).maybeSingle();
    if (error) { if (ratelimitsTableOk === null) { ratelimitsTableOk = false; console.warn(`[store] rate-limit table unreachable (${error.message}) — falling back to per-process limiting.`); } return null; }
    ratelimitsTableOk = true;
    const prior: number[] = Array.isArray((data as any)?.hits) ? (data as any).hits : [];
    const hits = prior.filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return { allowed: false, retryAfterMs: windowMs - (now - hits[0]) };
    }
    hits.push(now);
    // Cap the stored array itself (not just the window filter above) so a key that's ALWAYS at/near the
    // cap never accumulates more than `max` entries in the jsonb column — bounded storage, not just
    // bounded logical count.
    void client.from(RATELIMITS).upsert({ key, hits: hits.slice(-max), updated_at: new Date().toISOString() }, { onConflict: "key" })
      .then(({ error: e2 }) => { if (e2) reportError("ratelimit-write", e2, { key }); });
    return { allowed: true, retryAfterMs: 0 };
  } catch (e) {
    reportError("ratelimit-check", e, { key });
    return null;
  }
}

/** GDPR right-to-erasure (Art. 17), self-serve: permanently deletes EVERY row this account owns, across
 *  every table — account/login, profile+tasks, connections (Google/Pronote), sessions, and the job queue +
 *  its audit trail. Best-effort across tables (one table's failure shouldn't block the others — a partial
 *  deletion is still much better than none), but any failure is reported so the caller can tell the user to
 *  retry/contact support rather than silently claiming success. Irreversible; the caller must confirm first. */
export async function deleteAccount(email: string): Promise<{ ok: boolean; errors: string[] }> {
  if (!client || !email) return { ok: false, errors: ["cloud storage not configured"] };
  const errors: string[] = [];
  const tables: [string, string][] = [
    [TABLE, "email"], [USERS, "email"], [JOBS, "user_email"], [EVENTS, "user_email"],
  ];
  for (const [table, col] of tables) {
    try {
      const { error } = await client.from(table).delete().eq(col, email);
      if (error) errors.push(`${table}: ${error.message}`);
    } catch (e: any) { errors.push(`${table}: ${e?.message || e}`); }
  }
  // Sessions aren't keyed by email (sid is the primary key, email lives inside the serialized `sess` jsonb) —
  // best-effort text match rather than a full table scan/parse; a stray orphaned session row here is inert
  // (it can't authenticate as anyone once weave_web_users no longer has this email) but worth attempting.
  try { await client.from(SESSIONS).delete().ilike("sess", `%${email}%`); } catch { /* best-effort, non-fatal */ }
  await deleteAuthUser(email); // remove the mirrored Supabase Auth row too — best-effort, never blocks erasure
  return { ok: errors.length === 0, errors };
}

// ── Durable job queue ─────────────────────────────────────────────────────────
// The DB row IS the lock: claiming is a conditional UPDATE keyed on the current status, so exactly one
// serverless instance wins even when several drain at once. When the jobs table is unreachable (dev with
// only the anon key + locked-down RLS, or no Supabase at all), an in-memory queue keeps a single dev
// process fully working — same interface, no durability.

export type JobType = "sweep" | "execute_task" | "execute_step" | "revise";
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
  locked_by?: string | null;
  input?: any;
  output?: any;
  last_error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

const JOBS = "weave_web_jobs";
const EVENTS = "weave_web_job_events";
// A claim's lease. This MUST exceed the longest realistic single-job wall time, or a still-running job's
// lock expires and a second worker claims + RE-RUNS it — duplicate drafts/docs, double spend, the worst
// possible bug for a "never behind your back" product. A task run is up to 8 rounds × (90s request × 3
// retries) plus Composio latency, which can pass 12 min. So the lease is generous AND a heartbeat
// (renewLock, called from the drain while a job runs) extends it in-flight, so only a genuinely dead
// worker ever loses its lock.
const LOCK_MS = 15 * 60_000;
const HEARTBEAT_MS = 4 * 60_000; // re-extend the lease this often while a job runs
// Exponential backoff before a retried (non-terminal) job becomes claimable again — 2s, 4s, 8s, capped at
// 30s. `attemptCount` is the count AFTER the failed attempt (i.e. how many tries have happened so far).
const retryBackoffUntil = (attemptCount: number): string => new Date(Date.now() + Math.min(2 ** attemptCount * 1000, 30_000)).toISOString();

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
 *  Exactly-one-winner via a conditional UPDATE on the previous status. Returns null when nothing to do.
 *  `userEmail` scopes the claim to ONE account — the cron uses this for per-user round-robin so a single
 *  heavy account can't monopolise a global-oldest-first drain and starve everyone else. */
export async function claimJob(workerId: string, userEmail?: string): Promise<Job | null> {
  const db = await jobsDb();
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  if (db) {
    // Two passes: fresh queued jobs first, then expired-lock running jobs (retry of a crashed claim).
    for (const pass of ["queued", "expired"] as const) {
      let q = db.from(JOBS).select("id,status,attempt_count,max_attempts,locked_until").order("created_at", { ascending: true }).limit(5);
      if (userEmail) q = q.eq("user_email", userEmail);
      const { data: candidates } = pass === "queued"
        ? await q.eq("status", "queued")
        : await q.eq("status", "running").lt("locked_until", now.toISOString());
      for (const c of candidates || []) {
        // A retried job stamps `locked_until` with a short BACKOFF window before going back to "queued"
        // (see finishJob) — skip it here until that window passes, so a systemic outage doesn't burn
        // through max_attempts in a rapid back-to-back burst.
        if (pass === "queued" && c.locked_until && c.locked_until > now.toISOString()) continue;
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
  const job = memJobs.find((j) => (!userEmail || j.user_email === userEmail) && (j.status === "queued" || (j.status === "running" && j.locked_until && j.locked_until < now.toISOString())));
  if (!job) return null;
  if (job.attempt_count >= job.max_attempts) { job.status = "failed_terminal"; job.last_error = "max attempts exceeded"; return claimJob(workerId, userEmail); }
  job.status = "running"; job.locked_until = lockUntil; job.locked_by = workerId; job.started_at = now.toISOString(); job.attempt_count++;
  return job;
}

/** Heartbeat: extend a running job's lease while its worker is still alive, so a long (but healthy) run
 *  never has its lock expire out from under it and get re-claimed by a second worker. Guarded on
 *  locked_by = this worker + status running, so it can't revive a job that already finished or was stolen.
 *  Returns false when the row is no longer ours (finished, or lease already lost) — the caller can stop. */
export async function renewLock(id: string, workerId: string): Promise<boolean> {
  const until = new Date(Date.now() + LOCK_MS).toISOString();
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).update({ locked_until: until })
      .eq("id", id).eq("locked_by", workerId).eq("status", "running").select("id");
    return !!(data && data.length);
  }
  const job = memJobs.find((j) => j.id === id);
  if (!job || job.status !== "running" || job.locked_by !== workerId) return false;
  job.locked_until = until;
  return true;
}
export const heartbeatIntervalMs = HEARTBEAT_MS;

/** Mark a claimed job finished — success, retryable failure (goes back to queued-like claimable state), or
 *  terminal. `workerId` MUST match the worker `claimJob` gave this job to (like `renewLock` already
 *  requires) — without that check, a worker whose lease expired mid-run (a Supabase blip spanning one
 *  heartbeat cycle) while a SECOND worker legitimately reclaimed the same job would still get to overwrite
 *  whatever the second worker's run produced, with no detection — real duplicate side effects (a second
 *  draft, double AI spend) going unnoticed. A no-op update (0 rows) means another worker already finished
 *  it; that's not an error, just nothing left for this call to do. */
export async function finishJob(id: string, workerId: string, outcome: "succeeded" | "failed", error?: string, output?: any): Promise<void> {
  const db = await jobsDb();
  const now = new Date().toISOString();
  if (db) {
    if (outcome === "succeeded") {
      await db.from(JOBS).update({ status: "succeeded", finished_at: now, output: output ?? null, locked_until: null }).eq("id", id).eq("locked_by", workerId).eq("status", "running");
    } else {
      const { data } = await db.from(JOBS).select("attempt_count,max_attempts").eq("id", id).maybeSingle();
      const terminal = (data?.attempt_count ?? 1) >= (data?.max_attempts ?? 3);
      await db.from(JOBS).update({
        status: terminal ? "failed_terminal" : "queued", // retryable → back to queued for the next drain
        ...(terminal ? { finished_at: now } : {}), last_error: String(error || "").slice(0, 500),
        // Backoff, not an immediate re-claim — during a systemic outage (e.g. the AI provider down),
        // requeuing with no delay let a job burn through all its attempts in one rapid back-to-back
        // burst instead of spacing them out. claimJob's "queued" pass now respects this window.
        locked_until: terminal ? null : retryBackoffUntil(data?.attempt_count ?? 1),
      }).eq("id", id).eq("locked_by", workerId).eq("status", "running");
    }
    return;
  }
  const job = memJobs.find((j) => j.id === id && j.locked_by === workerId && j.status === "running");
  if (!job) return; // already finished by someone else, or never ours
  if (outcome === "succeeded") { job.status = "succeeded"; job.finished_at = now; job.output = output; }
  else {
    const terminal = job.attempt_count >= job.max_attempts;
    job.status = terminal ? "failed_terminal" : "queued";
    job.last_error = String(error || "").slice(0, 500);
    job.locked_until = terminal ? null : retryBackoffUntil(job.attempt_count);
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

/** Every job + audit-event record for a user — for GET /api/account/export. Without this, an export
 *  returned strictly LESS than what deleteAccount actually wipes (it clears these same tables), so a
 *  GDPR Art.15 access request came back incomplete relative to what's really stored and later erased. */
export async function exportJobsAndEvents(userEmail: string): Promise<{ jobs: Job[]; events: JobEvent[] }> {
  const db = await jobsDb();
  if (db) {
    const [{ data: jobs }, { data: events }] = await Promise.all([
      db.from(JOBS).select("*").eq("user_email", userEmail).order("created_at", { ascending: false }).limit(1000),
      db.from(EVENTS).select("kind,message,at,task_id,job_id").eq("user_email", userEmail).order("at", { ascending: false }).limit(1000),
    ]);
    return { jobs: (jobs as Job[]) || [], events: (events as JobEvent[]) || [] };
  }
  return {
    jobs: memJobs.filter((j) => j.user_email === userEmail),
    events: memEvents.filter((e) => e.user_email === userEmail),
  };
}
