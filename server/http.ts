
import "./env.ts";
import { reportError } from "./sentry.ts";
import { waitUntil } from "@vercel/functions";
import express from "express";
import type { RequestHandler } from "express";
import { randomBytes, createHash } from "node:crypto";
import type { WebTask, Profile } from "../shared/types.ts";
import { emptyProfile, isHandled } from "../shared/types.ts";
import { buildTasksPayload } from "./taskDelta.ts";
import { makeSyncScheduler } from "./syncScheduler.ts";
import { loadState, saveState, checkRateLimit, peekSessionCsrfToken } from "./store.ts";
import * as tasks from "./tasks.ts";
import * as integrations from "./integrations.ts";


// The `> 0` guard matters: `Number("0") || 8788` is 0 (a non-empty string is truthy, so the || never
// fires) and `listen(0)` binds a random ephemeral port — observed live under a sandbox shell exporting
// PORT=0, where the server "started" fine but nothing could ever reach it (the dev client's wait-on
// timed out, the preview proxy had no target). A 0/NaN/negative PORT is always a misconfiguration here,
// never intentional — this app has no caller that wants an OS-assigned port.
export const PROD = process.env.NODE_ENV === "production";

// Admin dashboard access: comma-separated emails in ADMIN_EMAILS. Unset = nobody is admin.
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

export const isAdmin = (req: express.Request): boolean => ADMIN_EMAILS.has((req.session.user || "").toLowerCase());

export function outgoingTasks(list: WebTask[] | undefined): WebTask[] {
  return (list || []).map((t0) => {
    // The tutor's hidden worked solution and teaching state never reach the browser.
    const { solution: _sol, tutorState: _ts, ...t } = t0 as WebTask;
    if (t.source !== "freestudy" || !isHandled(t.status)) return t;
    const { chat, board, boardEvents, problems, artifacts, ...rest } = t as any;
    return rest as WebTask;
  });
}

// ── Delta task lists ─────────────────────────────────────────────────────────────────────────────────────────────
// Every route that returns "the task list" used to ship ALL of it, every time (hundreds of KB raw per response, the biggest
// egress driver). The client now sends `x-have`: "<first 8 of task id><6-char content hash>,…" for the tasks it already holds;
// we answer with ONLY the tasks whose hash changed plus the id ORDER ({__delta, order, changed}). Hashes ignore the two
// response-only overlays (score boost, nudgeLine) so alternating routes don't thrash. No `x-have` (first load, many tasks,
// another account) → the full list, each task tagged with its hash so the NEXT request can be a delta.
export function tasksPayload(req: express.Request, list: WebTask[] | undefined, outgoing: WebTask[] = outgoingTasks(list)): any {
  return buildTasksPayload(outgoing, req.headers["x-have"]);
}

export const saveSession = (req: express.Request) => new Promise<void>((r) => req.session.save((err) => { if (err) console.warn("[session] save failed:", (err as any)?.message || err); r(); }));

// Cross-device/tab merges live in tasks.ts so the session-free job runner shares the EXACT same
// semantics (progressed copy wins, step ticks union, entity dedupe, structured settings preserved).
export const mergeTasks = tasks.mergeTaskLists;

export const mergeProfiles = tasks.mergeProfileStates;

// Dirty-flag cache: tracks the last hash of tasks+profile per session ID to skip redundant cloud syncs
// when nothing has changed (e.g. read-only polling in the kick loop). Keyed by session ID to survive
// session recreation on the same server process (though on serverless, this is per-invocation only).
const sessionDirtyCache = new Map<string, string>();

// Persist the session AND this ACCOUNT's durable state (profile + tasks) to the cloud, keyed by the
// account email — so it follows the account across devices and survives restarts. (Integration
// connections live in Composio, keyed by the same account email, so there's nothing extra to store.)
// Merge this instance's view into the account row and write it. `throwOnError` is for the awaited journal-save path, which also
// bypasses the read cache (the one place a stale base could lose a concurrent write); background flushes use the cached read.
/** What of a task may reach the cloud account row: a tutor (freestudy) session's worked solution carries the
 *  problem's statement and every step, which is session CONTENT — it stays in this server session and the
 *  browser, never the account row. Everything else is untouched. */
const forCloud = (t: WebTask): WebTask => (t.source === "freestudy" && t.solution ? { ...t, solution: undefined } : t);

async function writeAccount(email: string, localTasks: WebTask[], localProfile: Profile, o: { throwOnError?: boolean; bypassCache?: boolean } = {}): Promise<void> {
  const throwOnError = !!o.throwOnError;
  try {
    // ALWAYS a validated read (a ~60-byte version check; the full row only when it changed): this merge is followed by a WRITE of the
    // merged row, and merging into a stale cached copy silently overwrote tasks another process had just added (the daily sweep's
    // "2 new tasks" email arrived but the tasks were gone from the list).
    const current = await loadState(email, { bypassCache: true });
    const mergedTasks = mergeTasks(current.tasks || [], localTasks);
    const mergedProfile = mergeProfiles(current.profile || emptyProfile(), localProfile);
    await saveState(email, { profile: mergedProfile, tasks: mergedTasks.map(forCloud) }, { throwOnError });
  } catch (e) {
    reportError("commit-sync-cloud-merge", e);
    // Fallback write on merge failure — same throwOnError contract, so an awaiting caller still finds out if this ALSO fails.
    await saveState(email, { profile: localProfile, tasks: localTasks.map(forCloud) }, { throwOnError });
  }
}

export const scheduler = makeSyncScheduler<WebTask[]>(
  async (email, snap) => { await writeAccount(email, snap.tasks, snap.profile as Profile, { throwOnError: true }); },
  { debounceMs: 6000, maxWaitMs: 25000 },
);

export const commit = async (req: express.Request, opts?: { awaitCloud?: boolean }) => {
  // Saves the session, then syncs the account row to the cloud. `awaitCloud` waits for that cloud write before
  // responding (journal saves, flashcard reviews); otherwise it runs in the background (see the branches below).
  if (req.session.tasks) req.session.tasks = tasks.trimOldStudylogArtifacts(req.session.tasks);
  await saveSession(req);
  if (!req.session.user) return;
  const email = req.session.user;
  const localTasks = req.session.tasks || [];
  const localProfile = req.session.profile || emptyProfile();
  
  // Dirty-flag check: skip cloud sync if nothing changed (unless awaitCloud is true, which means this
  // is a high-value write like a journal save or flashcard review that must always persist).
  const currentHash = createHash("sha1").update(JSON.stringify(localTasks) + JSON.stringify(localProfile)).digest("hex");
  const sessionId = req.sessionID;
  const lastHash = sessionDirtyCache.get(sessionId);
  const isDirty = lastHash !== currentHash;
  
  if (opts?.awaitCloud) {
    // High-value write (a journal save): written NOW, with a fresh read of the account row, and it supersedes anything pending.
    scheduler.cancel(email);
    await writeAccount(email, localTasks, localProfile, { throwOnError: true, bypassCache: true });
    sessionDirtyCache.set(sessionId, currentHash);
  } else if (isDirty) {
    if (process.env.VERCEL) {
      // Serverless: a timer set after the response may never fire (the instance freezes). Write now and let
      // waitUntil keep the function alive until it lands, without delaying the response.
      waitUntil(scheduler.flush(email, { tasks: localTasks, profile: localProfile }));
    } else {
      // Long-running server: write-behind — a burst of step ticks / reviews / chat turns is one write (syncScheduler.ts).
      scheduler.schedule(email, { tasks: localTasks, profile: localProfile });
    }
    sessionDirtyCache.set(sessionId, currentHash);
  }
};

// Express 4 does NOT auto-catch a rejected promise from an async route handler — a route that forgets
// its own try/catch (verified: ~12 routes did, below) lets that rejection fall through to the process-
// level `unhandledRejection` listener at the bottom of this file, which only logs. The ORIGINAL request
// never gets a response at all — it hangs until the client's own timeout, instead of the clean 500 the
// catch-all error middleware (also at the bottom of this file) is already built to return. This routes
// exactly those otherwise-unguarded rejections into that EXISTING middleware via `next(err)`, rather
// than adding a second one — every route that already has its own try/catch is unaffected either way.
export const ah = (fn: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

// CSRF protection for every authenticated, state-changing request. Security-audit finding: the app had NO
// CSRF defense beyond the session cookie's `sameSite: "lax"` attribute — real, but not equivalent to a real
// per-request token (lax blocks cross-site simple-form POSTs in modern browsers, but is not designed as the
// sole CSRF defense and offers no protection against any GET-based state change or a browser/proxy that
// weakens lax enforcement). This is a standard "synchronizer token" pattern: a random token lives in
// `req.session.csrfToken` (server-side only, tied to the session), and is handed to the CLIENT once via
// `/api/status`'s own JSON response — a cross-origin attacker page cannot read that response body (no
// permissive CORS is set anywhere in this app), so it can never learn the token to forge a request with it.
// The legitimate same-origin client reads it once and attaches it as the `x-csrf-token` header on every
// mutating request (see client/api.ts's `req()`); this middleware verifies the header matches the session's
// token before any authenticated GET-mutating-as-a-side-effect-free-read route proceeds.
const CSRF_HEADER = "x-csrf-token";

export const requireAuth: RequestHandler = (req, res, next) => {
  void requireAuthAsync(req, res, next);
};

async function requireAuthAsync(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  if (!req.session.user) { res.status(401).json({ error: "not logged in" }); return; }
  // A session that (per THIS request's read) has no token yet cannot fairly be checked against a header —
  // the client can't possibly have a token that didn't exist. Mint one, skip the check for this ONE
  // request, and move on; the real check applies to every request after. This is the ONLY case where a
  // mutating request proceeds without a verified token, and it's not attacker-controllable (a session's
  // apparent lack of a token is either a genuine first-touch or the staleness race described below, never
  // something a forged cross-site request can induce).
  const hadToken = !!req.session.csrfToken;
  if (!hadToken) req.session.csrfToken = randomBytes(24).toString("hex");
  // In dev mode the CSRF self-heal (peekSessionCsrfToken) can't bypass the in-memory session store's
  // staleness — tsx watch restarts wipe all sessions, and without Supabase there's nothing to peek. The
  // sameSite=lax cookie still provides basic CSRF defense in dev, so skip the token check entirely
  // outside production rather than 403-ing every routine background call (pronote/touch, /api/metrics).
  if (PROD && hadToken && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const header = req.headers[CSRF_HEADER];
    if (header !== req.session.csrfToken) {
      // Cross-instance staleness self-heal: makeSessionStore's own GET_CACHE_TTL_MS (server/store.ts, 3min
      // per-warm-instance) means the copy of the session THIS lambda instance is holding can lag behind a
      // token another instance minted/refreshed moments ago — reported live as persistent 403s on routine
      // background calls (pronote/touch, /api/metrics) that never resolved no matter how many times the
      // client retried, because a retry could just as easily land on another equally-stale instance. Before
      // rejecting, check the CURRENT value directly in Supabase (bypassing every instance's cache) — if the
      // client's header actually matches that, this instance's copy was simply behind, not the client.
      const fresh = await peekSessionCsrfToken(req.sessionID);
      if (fresh && fresh === header) { req.session.csrfToken = fresh; }
      else {
        // Echo the TRUE current token (from the bypass-cache Supabase read above), not this instance's own
        // stale `req.session.csrfToken` — the client's own retry-once logic (client/api.ts's `req()`) reads
        // exactly this header and retries ONE time with whatever it finds there. Echoing the stale value
        // guaranteed that single retry would just resend a token already known to be wrong, so it always
        // failed too — the request only ever recovered by chance, if it happened to land on a DIFFERENT,
        // already-caught-up instance on some LATER unrelated call. Echoing `fresh` here (when we actually
        // have it) lets the very next retry succeed immediately instead of depending on luck. Reported live
        // as a persistent, never-resolving 403 on routine background calls (pronote/touch, /api/metrics).
        res.setHeader(CSRF_HEADER, fresh || req.session.csrfToken || "");
        res.status(403).json({ error: "Session expired or invalid — refresh the page and try again." });
        return;
      }
    }
  }
  // Echo the CURRENT (possibly just-reconciled) token back on every authenticated response — lets the
  // client opportunistically stay in sync even when nothing failed, not just recover after an error.
  res.setHeader(CSRF_HEADER, req.session.csrfToken!);
  next();
}

// Per-account rate limiter for the expensive AI/Composio endpoints (and login/signup), so a runaway client
// loop, a leaked session, or a brute-force attempt can't run up the bill or bypass auth throttling. Keyed
// by account email (falls back to IP). Primary check is Supabase-backed (checkRateLimit, server/store.ts)
// so the cap is real across every serverless instance, not just per-process — an in-memory Map's counts
// don't survive across instances, so on Vercel the old version's real-world cap was effectively
// max × instance-count. Falls back to the in-memory Map below when Supabase is unreachable (table not
// migrated yet, or a transient outage) — a rate limiter failing must never mean the app fails, just that
// it temporarily degrades to the weaker per-process guarantee it always had before this existed.
const rlHits = new Map<string, number[]>();

const inMemoryRateLimit = (key: string, max: number, windowMs: number): { allowed: boolean; retryAfterMs: number } => {
  const now = Date.now();
  const hits = (rlHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return { allowed: false, retryAfterMs: windowMs - (now - hits[0]) };
  hits.push(now);
  rlHits.set(key, hits);
  if (rlHits.size > 5000) for (const [k, v] of rlHits) if (!v.some((t) => now - t < windowMs)) rlHits.delete(k); // bound memory
  return { allowed: true, retryAfterMs: 0 };
};

export const rateLimit = (max: number, windowMs: number): RequestHandler => async (req, res, next) => {
  // MUST key on the route's TEMPLATE (req.route.path, e.g. "/api/tasks/:id/run"), never req.path (the
  // resolved URL with the actual id/index baked in) — keying on req.path gave every distinct task/step id
  // its own independent counter, so cycling ids fully bypassed every per-task cap in this file (verified:
  // /run, /refine, /send/:index, /confirm, /dismiss, /step/:index/* all parameterized). req.route is set
  // by the time this runs since rateLimit is itself one of the matched route's own handlers.
  const key = `${req.session.user || req.ip}:${req.baseUrl}${req.route?.path || req.path}`;
  const cloud = await checkRateLimit(key, max, windowMs);
  const result = cloud ?? inMemoryRateLimit(key, max, windowMs);
  if (!result.allowed) {
    const retry = Math.ceil(result.retryAfterMs / 1000);
    res.set("Retry-After", String(retry)).status(429).json({ error: `Too many requests — give it ${retry}s.` });
    return;
  }
  next();
};

/** A per-account DAILY cap on tutor turns (one turn can cost 5-20 model calls, and the per-minute limit alone allows ~600 a day).
 *  Only `primer` (tutor) requests count. Shared across serverless instances through the rate-limit table; falls back to per-process. */
export const TUTOR_DAILY_TURNS = Number(process.env.TUTOR_DAILY_TURNS) || 150;
export const dailyTurnCap = (max = TUTOR_DAILY_TURNS): RequestHandler => async (req, res, next) => {
  if (req.body?.primer !== true) { next(); return; }
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.session.user || req.ip}:cap:tutor:${day}`;
  const windowMs = 86_400_000;
  const cloud = await checkRateLimit(key, max, windowMs);
  const result = cloud ?? inMemoryRateLimit(key, max, windowMs);
  if (!result.allowed) {
    const untilMidnight = Math.max(60, Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000));
    res.set("Retry-After", String(untilMidnight)).status(429).json({ error: `You've reached today's limit of messages with Otto (${max}). Come back tomorrow!`, code: "daily_cap" });
    return;
  }
  next();
};

/** One tutor turn at a time per account and task: a double click, two tabs or a voice flush must not run (and bill) the same turn twice.
 *  Per instance, with a TTL so a crashed request can never lock a student out. */
const turnsInFlight = new Map<string, number>();
export const oneTurnAtATime: RequestHandler = (req, res, next) => {
  if (req.body?.primer !== true) { next(); return; }
  const key = `${req.session.user || req.ip}:${String(req.params?.id || "")}`;
  const now = Date.now();
  const started = turnsInFlight.get(key);
  if (started && now - started < 110_000) {
    res.status(409).json({ error: "Otto is still answering your previous message — one moment.", code: "turn_in_flight" });
    return;
  }
  turnsInFlight.set(key, now);
  let released = false;
  const release = () => { if (!released) { released = true; if (turnsInFlight.get(key) === now) turnsInFlight.delete(key); } };
  res.on("finish", release); res.on("close", release);
  if (turnsInFlight.size > 2000) for (const [k, t] of turnsInFlight) if (now - t > 110_000) turnsInFlight.delete(k);
  next();
};

// The agent's toolset for this account's connected apps (Composio). Empty if Composio's unset/nothing linked.
export const toolsFor = (req: express.Request) => integrations.getAgentTools(req.session.user!, { primaryAccounts: req.session.profile?.primaryAccounts }).catch(() => undefined);

// Language for a SERVER-GENERATED error string — `profile.language` once a session has one; before that
// (signup/login/reset, where no profile exists yet) fall back to a `lang` the client sends explicitly (same
// pattern already used by /api/auth/forgot-password), then to French (the app's own default for an
// unrecognized/absent signal — see Profile.language's own comment in shared/types.ts). This was the actual
// root cause of French users seeing raw English error toasts: client/api.ts's error handling always prefers
// a server-sent `error` message over its own bilingual fallback (by design — a specific validation reason
// should win over a generic one), so a hardcoded-English server string reached the toast verbatim regardless
// of the account's language. `M` is the fix at the source: build the string in the right language before it
// ever leaves the server.
export function reqLang(req: express.Request): "fr" | "en" {
  void req;
  return "en"; // the app is English-only
}

export function M(req: express.Request, fr: string, en: string): string { return en; }

// "Pause all AI usage" — the ONE toggle that stops generation and task runs. Enforced server-side
// (isPaused, used below) so it holds even if a stale client tab tries to call one of those routes anyway.
export const isPaused = (req: express.Request): boolean => !!req.session.profile?.paused;
