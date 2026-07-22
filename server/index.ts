import "./env.ts"; // load web/.env + the repo-root .env (COMPOSIO_API_KEY etc.) — MUST be first
import express from "express";
import type { RequestHandler } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { emptyProfile, dedupeFacts, canonStatus, isValidTz, monthCostUsd, monthlyBudgetUsd, overMonthlyBudget, budgetRenewsOn } from "../shared/types.ts";
import { aiReady, refineManualTask } from "./claude.ts";
import { loadState, saveState, cloudEnabled, getUser, createUser, makeSessionStore, getJob, getLatestJob, eventsForTask, recordEvent, countActiveJobs, activeJobTaskIds, enqueueJob } from "./store.ts";
import * as tasks from "./tasks.ts";
import * as jobs from "./jobs.ts";
import * as integrations from "./integrations.ts";
import { updateConfidence } from "./tasks.ts";

declare module "express-session" {
  interface SessionData {
    user?: string;        // the authenticated ACCOUNT email (everything keys off this; = Composio user_id)
    tasks?: WebTask[];
    profile?: Profile;
    integrations?: Record<string, string>; // app key → Composio connectionId hint (status is live from Composio)
    lastGenDay?: string;  // "YYYY-MM-DD" of the last full generate sweep — the once-a-day floor (survives serverless cold starts)
    lastGenTime?: string; // ISO timestamp of the last generation (for continuous monitoring)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const PROD = process.env.NODE_ENV === "production";

// Fail closed: required environment variables in production
if (PROD) {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set in production — it signs the session cookie that gates account access.");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY must be set in production — required for AI task generation and execution.");
  }
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY must be set in production — required for app integrations.");
  }
  if (!process.env.PUBLIC_URL) {
    throw new Error("PUBLIC_URL must be set in production — required for OAuth callbacks.");
  }
}

const app = express();
app.set("trust proxy", 1);
// Liveness probe for the host platform — no auth, no session, no DB; just "the process is up".
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
// Content-Security-Policy: scripts are self-only (the self-heal script is externalized, not inline);
// styles allow 'unsafe-inline' for React style={{}} attributes; images allow the Composio logo CDN + data:.
// On Vercel the static HTML is served by Vercel's layer (see vercel.json headers) — this covers the Express
// (Docker/self-host) path and every API response.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://logos.composio.dev",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");
// Security headers
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(session({
  store: await makeSessionStore(), // Supabase-backed when cloud is configured → sessions survive restarts/deploys
  secret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 30 * 24 * 3600 * 1000 },
}));

// Safety net: if a session knows the user but lost its working copy (e.g. an older session row, or a
// store hiccup), re-hydrate profile + tasks from the cloud account row so nothing ever looks "lost".
app.use(async (req, _res, next) => {
  try {
    if (req.session.user && (req.session.tasks === undefined || req.session.profile === undefined)) {
      const st = await loadState(req.session.user);
      if (req.session.tasks === undefined) req.session.tasks = st.tasks;
      if (req.session.profile === undefined) req.session.profile = st.profile;
    }
  } catch { /* best-effort */ }
  next();
});

const saveSession = (req: express.Request) => new Promise<void>((r) => req.session.save((err) => { if (err) console.warn("[session] save failed:", (err as any)?.message || err); r(); }));
// Cross-device/tab merges live in tasks.ts so the session-free job runner shares the EXACT same
// semantics (progressed copy wins, step ticks union, entity dedupe, structured settings preserved).
const mergeTasks = tasks.mergeTaskLists;
const mergeProfiles = tasks.mergeProfileStates;

// Persist the session AND this ACCOUNT's durable state (profile + tasks) to the cloud, keyed by the
// account email — so it follows the account across devices and survives restarts. (Integration
// connections live in Composio, keyed by the same account email, so there's nothing extra to store.)
const commit = async (req: express.Request) => {
  await saveSession(req);
  if (req.session.user) {
    try {
      const current = await loadState(req.session.user);
      const mergedTasks = mergeTasks(current.tasks || [], req.session.tasks || []);
      const mergedProfile = mergeProfiles(current.profile || emptyProfile(), req.session.profile || emptyProfile());
      req.session.tasks = mergedTasks;
      req.session.profile = mergedProfile;
      await saveState(req.session.user, { profile: mergedProfile, tasks: mergedTasks });
    } catch {
      await saveState(req.session.user, {
        profile: req.session.profile || emptyProfile(),
        tasks: req.session.tasks || [],
      });
    }
  }
};

const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.user) { res.status(401).json({ error: "not logged in" }); return; }
  next();
};

// Per-account rate limiter (in-memory sliding window) for the expensive AI/Composio endpoints, so a runaway
// client loop or a leaked session can't run up the bill. Keyed by account email (falls back to IP).
const rlHits = new Map<string, number[]>();
const rateLimit = (max: number, windowMs: number): RequestHandler => (req, res, next) => {
  const key = `${req.session.user || req.ip}:${req.path}`;
  const now = Date.now();
  const hits = (rlHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retry = Math.ceil((windowMs - (now - hits[0])) / 1000);
    res.set("Retry-After", String(retry)).status(429).json({ error: `Too many requests — give it ${retry}s.` });
    return;
  }
  hits.push(now);
  rlHits.set(key, hits);
  if (rlHits.size > 5000) for (const [k, v] of rlHits) if (!v.some((t) => now - t < windowMs)) rlHits.delete(k); // bound memory
  next();
};
// The agent's toolset for this account's connected apps (Composio). Empty if Composio's unset/nothing linked.
const toolsFor = (req: express.Request) => integrations.getAgentTools(req.session.user!).catch(() => undefined);

// ── Email account auth ─────────────────────────────────────────────────────────
const normEmail = (s: unknown) => String(s || "").trim().toLowerCase();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

app.post("/api/auth/signup", rateLimit(6, 60 * 60_000), async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!validEmail(email) || password.length < 6) { res.status(400).json({ error: "Enter a valid email and a password of at least 6 characters." }); return; }
  if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." }); return; }
  if (await getUser(email)) { res.status(409).json({ error: "An account with that email already exists — log in instead." }); return; }
  if (!(await createUser(email, bcrypt.hashSync(password, 10)))) { res.status(500).json({ error: "Couldn't create the account." }); return; }
  req.session.user = email;
  await saveSession(req);
  res.json({ ok: true });
});

app.post("/api/auth/login", rateLimit(10, 15 * 60_000), async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const u = await getUser(email);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) { res.status(401).json({ error: "Wrong email or password." }); return; }
  req.session.user = email;
  // Bring back this account's saved profile + tasks. (App connections live in Composio, keyed by this
  // same account email, so they're already linked — nothing to restore here.)
  const restored = await loadState(email);
  req.session.profile = restored.profile;
  req.session.tasks = restored.tasks;
  await saveSession(req);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// Google now connects through Composio (Gmail / Calendar / Docs / Slides / Drive / Sheets) like every other
// app — see the integration routes below. (The old direct-OAuth /auth/google flow has been retired.)

// ── Integrations (Composio: Google, Slack, GitHub, Notion, Linear, …) ───────────
// List the catalog + which the account has connected (status is queried LIVE from Composio per account).
app.get("/api/integrations", requireAuth, async (req, res) => {
  const ready = integrations.integrationsReady();
  const apps = integrations.CATALOG.map((c) => c.key);
  const statuses = ready ? await integrations.getAllConnectionStatuses(req.session.user!, apps, req.session.integrations || {}) : {};
  res.json({
    ready,
    items: integrations.CATALOG.map((c) => ({ key: c.key, name: c.name, blurb: c.blurb, category: c.category, logo: integrations.logoFor(c.toolkit), connected: !!(statuses as any)[c.key] })),
  });
});

// Get connected accounts for a specific app (supports multiple accounts)
app.get("/api/integrations/:app/accounts", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  if (!integrations.CATALOG.some((c) => c.key === app2)) { res.status(404).json({ error: "Unknown integration." }); return; }
  const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2, true) : [];
  res.json({ accounts });
});

// GET so a plain <a href> can carry the user through the OAuth redirect (like /auth/google).
app.get("/integrations/:app/connect", requireAuth, async (req, res) => {
  try {
    if (!integrations.integrationsReady()) { res.status(500).send("Integrations aren't configured on the server (COMPOSIO_API_KEY)."); return; }
    const app2 = String(req.params.app);
    if (!integrations.CATALOG.some((c) => c.key === app2)) { res.status(404).send("Unknown integration."); return; }
    const callbackUrl = `${process.env.PUBLIC_URL || `http://localhost:5273`}/integrations/callback`;
    const { redirectUrl, connectionId } = await integrations.initiateConnection(app2, req.session.user!, callbackUrl);
    (req.session.integrations ||= {})[app2] = connectionId;
    integrations.invalidateTools(req.session.user!);
    req.session.save(() => res.redirect(redirectUrl));
  } catch (e: any) { res.status(500).send("Couldn't start the connection: " + (e?.message || e)); }
});

// Composio sends the user back here after OAuth — bounce to Settings, where status re-checks live.
app.get("/integrations/callback", (_req, res) => res.redirect("/settings"));

app.post("/api/integrations/:app/disconnect", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  const result = integrations.integrationsReady() ? await integrations.disconnect(app2, req.session.user!) : { ok: true };
  if (req.session.integrations) delete req.session.integrations[app2];
  integrations.invalidateTools(req.session.user!);
  await saveSession(req);
  res.json(result);
});

// Disconnect a specific account by ID (for multi-account support)
app.post("/api/integrations/:app/disconnect/:accountId", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  const accountId = String(req.params.accountId);
  // Verify the account belongs to this user and app before disconnecting
  const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2) : [];
  const account = accounts.find((a) => a.id === accountId);
  if (!account) { res.status(404).json({ error: "Account not found." }); return; }
  const result = await integrations.disconnectAccount(accountId);
  integrations.invalidateTools(req.session.user!);
  await saveSession(req);
  res.json(result);
});

// ── Status ──────────────────────────────────────────────────────────────────
// googleConnected now means "Gmail is connected via Composio" (the minimum to generate tasks). Cached
// briefly so polling this hot endpoint doesn't hammer Composio.
app.get("/api/status", async (req, res) => {
  let googleConnected = false;
  if (req.session.user && integrations.integrationsReady()) {
    try { googleConnected = !!(await integrations.connectionStatusesCached(req.session.user, ["gmail"]))["gmail"]; } catch { /* treat as not connected */ }
  }
  const s: ConnectionStatus = {
    loggedIn: !!req.session.user,
    user: req.session.user,
    name: req.session.profile?.name,
    googleConnected,
    aiReady: aiReady(),
    googleConfigured: integrations.integrationsReady(), // Composio is what powers Google + every integration now
    cloud: cloudEnabled(),
    paused: !!req.session.profile?.paused,
    highPriorityPeople: req.session.profile?.highPriorityPeople,
    genPerDay: req.session.profile?.genPerDay,
    timezone: req.session.profile?.timezone,
    overBudget: overMonthlyBudget(req.session.profile),
  };
  res.json(s);
});

// "Pause all AI usage" — the ONE toggle that stops generation and task runs. Enforced server-side
// (isPaused, used below) so it holds even if a stale client tab tries to call one of those routes anyway.
const isPaused = (req: express.Request): boolean => !!req.session.profile?.paused;
// Monthly AI spend cap — the honest 402 an interactive route returns when the account is over budget.
const overBudget = (req: express.Request): boolean => overMonthlyBudget(req.session.profile);
const BUDGET_MSG = "Otto's reached its monthly AI budget — it resets on the 1st. Raise MONTHLY_AI_BUDGET_USD to lift it.";
app.post("/api/settings/pause", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  p.paused = req.body?.paused === true;
  p.pausedAt = new Date().toISOString();
  await commit(req);
  res.json(p);
});

// Live integration check — create → verify → clean up against the REAL connected account, on the user's
// explicit click. No AI involved (direct hardcoded steps), so it works even while AI is paused.
app.post("/api/settings/smoke", requireAuth, rateLimit(3, 60_000), async (req, res) => {
  try {
    const results = await integrations.runSmokeTest(req.session.user!);
    void recordEvent(req.session.user!, "smoke_test", { message: `${results.filter((r) => r.ok).length}/${results.length} checks passed` });
    res.json(results);
  } catch (e: any) { res.status(500).json({ error: e?.message || "integration check failed" }); }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
// Reconcile with the cloud copy on every load, so a task finished on ANOTHER device/tab never shows
// undone here (and never gets pointlessly re-run by this device's auto-run).
app.get("/api/tasks", requireAuth, async (req, res) => {
  try {
    if (req.session.user && cloudEnabled()) {
      const cloud = await loadState(req.session.user);
      req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      await saveSession(req);
    }
  } catch { /* best-effort — fall back to the session copy */ }
  res.json(req.session.tasks || []);
});

// Sweeps run through the DURABLE JOB QUEUE (jobs.ts): this route enqueues + drains inline so the
// interactive path stays synchronous for the client, while the exact same queue is drained by
// /api/cron/drain when the browser is closed. Idempotency (one active sweep job per user) replaces
// the old in-memory inflight map — it holds across serverless instances.
const CONTINUOUS_MONITOR_INTERVAL_MS = 30 * 60 * 1000; // min gap between background sweeps
app.post("/api/tasks/generate", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to sweep for new tasks." }); return; }
  if (overBudget(req)) { res.json({ tasks: req.session.tasks || [], note: "skipped: monthly AI budget reached" }); return; }
  try {
    const user = req.session.user!;
    const force = req.body?.force === true; // the manual Refresh button — always run a REAL sweep
    const lastGenTime = Date.parse(req.session.lastGenTime || "") || 0;
    if (!force && Date.now() - lastGenTime < CONTINUOUS_MONITOR_INTERVAL_MS && (req.session.tasks || []).length) {
      res.json({ tasks: req.session.tasks, note: "" }); return; // watched recently — serve the current list
    }
    const extras = await toolsFor(req);
    if (!extras?.tools?.length) { res.status(400).json({ error: "Connect an app (Gmail, Calendar, Slack, etc.) in Settings so Otto has something to read." }); return; }
    const job = await jobs.enqueueAndDrain(user, "sweep");
    if (job.status === "succeeded") req.session.lastGenTime = new Date().toISOString();
    // The job committed to the CLOUD copy — fold it into this session so the response reflects it.
    const cloud = await loadState(user);
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
    await saveSession(req);
    // The sweep's own result line ("swept: 3 new tasks, 2 queued" / "skipped: nothing connected") — the
    // client shows THIS instead of guessing, so a skipped sweep can never masquerade as "no new tasks".
    const note = job.status === "succeeded" ? String(job.output?.note || "") : `sweep ${job.status}: ${job.last_error || "still running"}`;
    res.json({ tasks: req.session.tasks, note });
  } catch (e: any) {
    console.error("[tasks] generate error:", e);
    res.status(500).json({ error: e?.message || "generate failed" });
  }
});

app.post("/api/tasks", requireAuth, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) { res.status(400).json({ error: "title required" }); return; }
  // AI-refine the user's rough note into a crisp task (falls back to the raw text if refinement fails,
  // or if AI usage is paused / over the monthly budget — the task still gets added, just unrefined).
  const refined = aiReady() && !isPaused(req) && !overBudget(req) ? await refineManualTask(title, req.session.profile) : null;
  req.session.tasks = tasks.addManual(req.session.tasks || [], title, refined);
  // AUTO-RUN: a manually-added task should just start working — no "Run" click needed. Queue it for
  // execution (unless AI is off/paused/over budget or it went in unrefined) and mark it queued so the
  // client's kick loop drains it. addManual unshifts, so the new task is at index 0.
  const added = req.session.tasks[0];
  if (added && aiReady() && !isPaused(req) && !overBudget(req) && !added.unrefined && canonStatus(added.status) === "ready") {
    added.status = "queued";
    try { await enqueueJob(req.session.user!, "execute_task", added.id); } catch { /* client kick / cron will still pick it up */ }
  }
  await commit(req);
  res.json(req.session.tasks);
});

// Refine an UNREFINED manual task (one added while AI was paused/unavailable) now that AI is back.
app.post("/api/tasks/:id/refine", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to refine." }); return; }
  if (overBudget(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  const refined = await refineManualTask(t.title, req.session.profile);
  tasks.applyRefinement(req.session.tasks || [], t.id, refined);
  await commit(req);
  res.json(req.session.tasks || []);
});

// Execution flows through the durable job queue: enqueue + drain inline (synchronous response for the
// client), with job idempotency as the cross-instance lock — one ACTIVE job per task, held in the DB.
// A second call while one is in flight gets a 409 (the client treats that as "the other run wins").
const runViaJob = async (req: express.Request, res: express.Response, type: "execute_task" | "revise" | "execute_step", input?: any) => {
  const user = req.session.user!;
  const id = String(req.params.id);
  try {
    const job = await jobs.enqueueAndDrain(user, type, id, input);
    // ALWAYS fold the cloud copy in and answer with the task's REAL state — a requeued-after-failure or
    // another-worker-owns-it job is not an error; the task's own status (queued/executing/failed_retryable)
    // tells the truth on the card and the client's kick loop keeps it moving.
    const cloud = await loadState(user);
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
    await saveSession(req);
    const t = (req.session.tasks || []).find((x) => x.id === id);
    if (!t) { res.status(404).json({ error: "not found" }); return; }
    // Only a TERMINAL job failure is an error response — the user needs the message + Retry.
    if (job.status === "failed_terminal") { res.status(500).json({ error: job.last_error || t.lastError || "run failed" }); return; }
    res.json(t);
  } catch (e: any) {
    console.error(`[tasks] ${type} error for task`, id, ":", e);
    res.status(500).json({ error: e?.message || "run failed" });
  }
};

// The client requests runs; the SERVER executes them (via the queue) — same queue the cron drains offline.
// `manual: true` marks a deliberate user click, which is allowed to retry a terminally-failed task.
app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run tasks." }); return; }
  if (overBudget(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  await runViaJob(req, res, "execute_task", { manual: true });
});

// Revise: the user declined to send and said what to change → re-run the task with that instruction so Otto
// updates the draft (and re-offers it as a sendable) before they send.
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) { res.status(400).json({ error: "note required" }); return; }
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to revise tasks." }); return; }
  if (overBudget(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  await runViaJob(req, res, "revise", { note });
});

// These return the FULL task list (client filters out done/dismissed for display) — so the dashboard's
// "handled" count + the deep-link "already handled" fallback keep working after a confirm/dismiss.
app.post("/api/tasks/:id/confirm", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "done";
    task.updatedAt = new Date().toISOString();
    // Track confidence: user approved the task's work
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, true);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user!, "confirmed", { taskId: id, message: "You marked it done" });
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/reject", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    tasks.reject(req.session.tasks || [], id);
    // Track confidence: user rejected the task's work
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, false);
    req.session.profile = profile;
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/dismiss", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "dismissed";
    task.updatedAt = new Date().toISOString();
    // Track confidence: user dismissed (rejected) this type of task
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, false);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user!, "dismissed", { taskId: id, message: "You dismissed it — similar tasks won't come back" });
  }
  res.json(req.session.tasks || []);
});
// Auto-do ONE automatable step (focused agent run over the connected apps) — through the job queue,
// same as full runs, so it's durably locked and audited.
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run steps." }); return; }
  if (overBudget(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : undefined;
  await runViaJob(req, res, "execute_step", { index: Number(req.params.index), ...(answer ? { answer } : {}) });
});
// Mark a step done/undone (a manual step the user did, or after the client opened a URL step).
app.post("/api/tasks/:id/step/:index/done", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const done = req.body?.done !== false;
  const result = typeof req.body?.result === "string" ? req.body.result : undefined;
  const task = (req.session.tasks || []).find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (step) {
    step.done = done;
    step.doneAt = done ? new Date().toISOString() : undefined;
    if (result !== undefined) step.result = result;
    task!.updatedAt = new Date().toISOString();
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
// One-click send: fire a reviewed Gmail draft / composed Slack message — USER-confirmed, the ONLY send path.
app.post("/api/tasks/:id/send/:index", requireAuth, async (req, res) => {
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  const s = t?.sendables?.[Number(req.params.index)];
  if (!t || !s) { res.status(404).json({ error: "not found" }); return; }
  if (!s.sent) {
    const r = await integrations.sendSendable(req.session.user!, s);
    if (!r.ok) { res.status(500).json({ error: r.error || "send failed" }); return; }
    s.sent = true;
    t!.updatedAt = new Date().toISOString();
    // Track confidence: user approved and sent the draft
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, s.app, true);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user!, "sent", { taskId: t!.id, message: `${s.label}${s.to ? ` → ${s.to}` : ""}` });
  }
  res.json(t);
});

// ── Jobs + timeline (the durable execution layer's public surface) ────────────
app.get("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await getJob(String(req.params.id), req.session.user!);
  if (!job) { res.status(404).json({ error: "not found" }); return; }
  res.json({ id: job.id, type: job.type, status: job.status, taskId: job.task_id, attempts: job.attempt_count, error: job.last_error, createdAt: job.created_at, finishedAt: job.finished_at });
});
app.get("/api/tasks/:id/events", requireAuth, async (req, res) => {
  res.json(await eventsForTask(req.session.user!, String(req.params.id)));
});
// Client-driven drain "kick": while any of the user's jobs are queued (e.g. execution queued by a sweep),
// the OPEN client kicks one job at a time so online users see work happen within seconds, not at the next
// cron tick. Each kick is one bounded function invocation — serverless-friendly.
app.post("/api/jobs/kick", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  try {
    const out = await jobs.drain(1);
    const [active, activeTaskIds] = await Promise.all([countActiveJobs(req.session.user!), activeJobTaskIds(req.session.user!)]);
    // Refresh this session's view of the cloud copy the job just wrote.
    if (out.processed || out.failed) {
      const cloud = await loadState(req.session.user!);
      req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      await saveSession(req);
    }
    res.json({ ...out, active, activeTaskIds, tasks: req.session.tasks || [] });
  } catch (e: any) { res.status(500).json({ error: e?.message || "kick failed" }); }
});

// Background drain — called by Vercel Cron (Authorization: Bearer $CRON_SECRET) every few minutes.
// This is what makes Otto work with every browser closed: sweeps due accounts, executes ready tasks,
// retries failed jobs, all through the same durable queue the interactive routes use.
app.get("/api/cron/drain", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || "");
  if (secret && auth !== `Bearer ${secret}`) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!secret && PROD) { res.status(503).json({ error: "CRON_SECRET not configured" }); return; }
  try {
    const out = await jobs.cronTick();
    console.log(`${new Date().toISOString()} [cron] drain: ${JSON.stringify(out)}`);
    res.json(out);
  } catch (e: any) {
    console.error("[cron] drain failed:", e);
    res.status(500).json({ error: e?.message || "drain failed" });
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
    const tz = profile.workingHours?.timezone;
    res.json({
      lastSweepAt: profile.lastSweepAt || null,
      lastSweepDay: profile.lastSweepAt ? jobs.localDay(profile.lastSweepAt, tz) : null,
      today: jobs.localDay(new Date(), tz),
      sweptToday: !jobs.sweepDueForDay(profile.lastSweepAt, profile),
      lastSweepJob: lastSweepJob ? { status: lastSweepJob.status, at: lastSweepJob.finished_at || lastSweepJob.created_at, error: lastSweepJob.last_error || null } : null,
      queued: activeJobs,
      cronConfigured: !!process.env.CRON_SECRET,
    });
  } catch (e: any) { res.status(500).json({ error: e?.message || "status failed" }); }
});

// AI token usage for the signed-in user — read from the CLOUD (not the session), so usage racked up by
// background job runs (sweeps/executions with the browser closed) is reflected, not just this tab's.
app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const state = await loadState(req.session.user!);
    const p = state.profile;
    const u = p?.usage;
    res.json({
      in: u?.in || 0, out: u?.out || 0, total: (u?.in || 0) + (u?.out || 0), runs: u?.runs || 0, since: u?.since || null,
      // Month-to-date spend against the cap (both USD) — what the Settings view + budget banner read.
      monthCostUsd: monthCostUsd(p), budgetUsd: monthlyBudgetUsd(), over: overMonthlyBudget(p), renewsOn: budgetRenewsOn(p),
    });
  } catch (e: any) { res.status(500).json({ error: e?.message || "usage failed" }); }
});

// ── Profile (who the user is) — available once logged in ───────────────────────
const listKey = (c: string) => (c === "preference" ? "preferences" : c === "person" ? "people" : c === "project" ? "projects" : "");
app.get("/api/profile", requireAuth, (req, res) => { res.json(req.session.profile || emptyProfile()); });
app.post("/api/profile", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const category = String(req.body?.category || "");
  const value = String(req.body?.value || "").trim();
  if (category === "name") { p.name = value.slice(0, 60) || undefined; }
  else if (category === "about") { p.about = value.slice(0, 400); }
  else { const k = listKey(category); if (k && value && !(p as any)[k].some((x: string) => x.toLowerCase() === value.toLowerCase())) (p as any)[k].push(value.slice(0, 160)); }
  await commit(req);
  res.json(p);
});
app.post("/api/profile/preference", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const key = String(req.body?.key || "");
  const value = req.body?.value;
  if (key === "workingHours" && typeof value === "object") {
    p.workingHours = {
      start: String(value.start || "09:00"),
      end: String(value.end || "18:00"),
      timezone: String(value.timezone || "UTC"),
    };
  } else if (key === "responseStyle" && ["concise", "detailed", "casual", "formal"].includes(value)) {
    p.responseStyle = value;
  } else if (key === "autoApprove" && Array.isArray(value)) {
    p.autoApprove = value.map(String);
  } else if (key === "genPerDay") {
    p.genPerDay = Math.min(4, Math.max(1, Math.round(Number(value) || 1)));
  } else if (key === "timezone" && typeof value === "string" && isValidTz(value)) {
    p.timezone = value;
  } else if (key === "highPriorityPeople" && Array.isArray(value)) {
    p.highPriorityPeople = value.map(String);
  } else if (key === "autoArchivePatterns" && Array.isArray(value)) {
    p.autoArchivePatterns = value.map(String);
  }
  await commit(req);
  res.json(p);
});
// Wipe everything Otto has learned (restart from zero memory). The agent rebuilds it over time via `remember`.
app.delete("/api/profile", requireAuth, async (req, res) => {
  req.session.profile = emptyProfile();
  await commit(req);
  res.json(req.session.profile);
});
app.delete("/api/profile/:category/:index", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const k = listKey(String(req.params.category));
  const i = Number(String(req.params.index));
  if (k && Array.isArray((p as any)[k]) && i >= 0 && i < (p as any)[k].length) { (p as any)[k].splice(i, 1); await commit(req); }
  res.json(p);
});

// ── Static (production) ─────────────────────────────────────────────────────
// On Vercel the built client is served by Vercel's static layer (see vercel.json), not Express.
if (PROD && !process.env.VERCEL) {
  const dist = path.resolve(__dirname, "../dist");
  app.use(express.static(dist));
  // SPA fallback for NAVIGATION routes only. A request that looks like an asset (has a file extension) but
  // didn't match a real file 404s instead of returning index.html — otherwise /favicon.ico (and any missing
  // asset) resolves to the HTML page, which browsers can't use as an icon (a cause of a stale/blank favicon).
  app.get("*", (req, res) => {
    if (path.extname(req.path)) { res.status(404).end(); return; }
    res.sendFile(path.join(dist, "index.html"));
  });
}

// Catch-all error handler — MUST be last. Body-parser rejects (malformed JSON, payload > 1mb limit) throw
// into Express's error channel, and without this the default handler returns an HTML page from a JSON API.
// Give every API consumer a consistent JSON error and a right-sized status; never leak a stack in prod.
app.use(((err, _req, res, _next) => {
  const status = err?.status || err?.statusCode || (err?.type === "entity.too.large" ? 413 : err?.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[weave-web] request error:", err?.message || err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 413 ? "Request body too large." : status === 400 ? "Malformed request body." : "Internal error." });
}) as express.ErrorRequestHandler);

// A single failing run must NEVER take down the server. An unhandled rejection/exception from a
// concurrent AI run (DeepSeek, googleapis, a tool reject) would otherwise crash the whole
// process — killing every in-flight /run with "socket hang up" so tasks never finish (no steps).
// Log and keep serving; the affected request already has its own try/catch and 500s on its own.
process.on("unhandledRejection", (reason) => console.error("[weave-web] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[weave-web] uncaughtException:", err));

// On Vercel the app is exported and invoked per-request by the serverless wrapper (api/index.ts) —
// there is no long-lived listener. Everywhere else (local, Docker, Railway/Render/Fly) we listen.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[weave-web] listening on :${PORT} (${PROD ? "production" : "dev"})`));
}

export default app;
