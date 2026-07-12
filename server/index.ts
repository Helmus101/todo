import "./env.ts"; // load web/.env + the repo-root .env (COMPOSIO_API_KEY etc.) — MUST be first
import express from "express";
import type { RequestHandler } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { emptyProfile, dedupeFacts } from "../shared/types.ts";
import { aiReady, refineManualTask } from "./claude.ts";
import { loadState, saveState, cloudEnabled, getUser, createUser, makeSessionStore } from "./store.ts";
import * as tasks from "./tasks.ts";
import * as integrations from "./integrations.ts";
import { chat, type ChatTurn } from "./chat.ts";

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
// Security headers
app.use((req, res, next) => {
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
// Cross-device/tab merge. The more-PROGRESSED copy of a task wins (done can never regress to executed/ready);
// equal progress → the most recently UPDATED copy wins (so a stale session can't overwrite fresh work, which
// used to wipe step ticks). Step done-state is unioned across both copies: ticked anywhere = ticked.
const mergeTasks = (existing: WebTask[], incoming: WebTask[]): WebTask[] => {
  const rank = (s: WebTask["status"]) => (s === "done" || s === "dismissed") ? 4 : s === "executed" ? 3 : s === "running" ? 2 : 1;
  const when = (t: WebTask) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  const map = new Map<string, WebTask>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) {
    const ext = map.get(t.id);
    if (!ext) { map.set(t.id, t); continue; }
    const winner = rank(t.status) > rank(ext.status) ? t
      : rank(t.status) < rank(ext.status) ? ext
      : when(t) >= when(ext) ? t : ext;
    const loser = winner === t ? ext : t;
    const steps = winner.steps?.map((s) => {
      if (s.done) return s;
      const other = loser.steps?.find((o) => o.text === s.text);
      return other?.done ? { ...s, done: true, doneAt: other.doneAt, result: s.result ?? other.result } : s;
    });
    map.set(t.id, steps ? { ...winner, steps } : winner);
  }
  // The id-union above can still leave TWO entries for the same real-world item: two sessions/tabs each
  // mint a fresh random id when they independently discover the same Gmail thread/event. dedupeTasks
  // collapses those by anchor/link/near-title, same as a single generate() sweep already does.
  return tasks.dedupeTasks(Array.from(map.values()));
};

// Entity-level dedupe (not raw Set union): reworded copies of the same fact from different sessions/devices
// must collapse, or the cloud profile grows forever — and it's injected into EVERY agent prompt.
const mergeProfiles = (p1: Profile, p2: Profile): Profile => {
  // paused is a boolean toggle, not a fact list — `||` would wrongly let a stale `true` from one side
  // override a deliberate `false` from the other. Take whichever side was toggled MOST RECENTLY instead.
  const pausedAt = (p: Profile) => Date.parse(p.pausedAt || "") || 0;
  const pausedSide = pausedAt(p2) >= pausedAt(p1) ? p2 : p1;
  return {
    name: p2.name || p1.name,
    about: p2.about || p1.about,
    preferences: dedupeFacts([...(p1.preferences || []), ...(p2.preferences || [])]),
    people: dedupeFacts([...(p1.people || []), ...(p2.people || [])]),
    projects: dedupeFacts([...(p1.projects || []), ...(p2.projects || [])]),
    paused: pausedSide.paused,
    pausedAt: pausedSide.pausedAt,
  };
};

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

app.post("/api/auth/signup", async (req, res) => {
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

app.post("/api/auth/login", async (req, res) => {
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
  const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2) : [];
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
  };
  res.json(s);
});

// "Pause all AI usage" — the ONE toggle that stops generation, task runs, and chat. Enforced server-side
// (isPaused, used below) so it holds even if a stale client tab tries to call one of those routes anyway.
const isPaused = (req: express.Request): boolean => !!req.session.profile?.paused;
app.post("/api/settings/pause", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  p.paused = req.body?.paused === true;
  p.pausedAt = new Date().toISOString();
  await commit(req);
  res.json(p);
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

// Daily auto-generate: the dashboard silently POSTs here on load; this floor makes it a no-op unless it's
// the first call of the calendar day (per account). So generation is AUTOMATIC (no button) yet runs the
// expensive multi-tool agent at most once a day.
const lastGenDate = new Map<string, string>(); // user → "YYYY-MM-DD" (fast path; session is the durable copy)
const genInflight = new Map<string, Promise<void>>(); // user → running sweep, so two tabs never double-run the agent
const today = () => new Date().toISOString().split("T")[0];
const CONTINUOUS_MONITOR_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between continuous checks
const shouldRefreshContinuous = (lastGenTime?: string): boolean => {
  if (!lastGenTime) return true;
  const elapsed = Date.now() - new Date(lastGenTime).getTime();
  return elapsed > CONTINUOUS_MONITOR_INTERVAL_MS;
};
app.post("/api/tasks/generate", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to sweep for new tasks." }); return; }
  try {
    const todayStr = today();
    const force = req.body?.force === true; // the manual Refresh button — always run a REAL sweep
    const lastGen = lastGenDate.get(req.session.user!) || req.session.lastGenDay;
    const lastGenTime = req.session.lastGenTime;
    // Continuous monitoring: if enough time has passed (30min), refresh even if same day
    const continuousRefresh = !force && shouldRefreshContinuous(lastGenTime);
    if (!force && !continuousRefresh && lastGen === todayStr && (req.session.tasks || []).length) { res.json(req.session.tasks); return; }
    const extras = await toolsFor(req);
    if (!extras?.tools?.length) { res.status(400).json({ error: "Connect an app (Gmail, Calendar, Slack, etc.) in Settings so Otto has something to read." }); return; }
    // Mark the day done ONLY after generation succeeds — a failed/timed-out run must not burn the
    // whole day's one attempt (that left users with no new tasks until tomorrow).
    const user = req.session.user!;
    let sweep = genInflight.get(user);
    if (!sweep) {
      sweep = (async () => {
        req.session.tasks = await tasks.generate(req.session.tasks || [], (req.session.profile ||= emptyProfile()), extras);
        lastGenDate.set(user, todayStr);
        req.session.lastGenDay = todayStr;
        req.session.lastGenTime = new Date().toISOString();
        await commit(req);
      })().finally(() => genInflight.delete(user));
      genInflight.set(user, sweep);
    }
    await sweep;
    res.json(req.session.tasks);
  } catch (e: any) {
    console.error("[tasks] generate error:", e);
    res.status(500).json({ error: e?.message || "generate failed" });
  }
});

app.post("/api/tasks", requireAuth, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) { res.status(400).json({ error: "title required" }); return; }
  // AI-refine the user's rough note into a crisp task (falls back to the raw text if refinement fails,
  // or if AI usage is paused — the task still gets added, just unrefined).
  const refined = aiReady() && !isPaused(req) ? await refineManualTask(title, req.session.profile) : null;
  req.session.tasks = tasks.addManual(req.session.tasks || [], title, refined);
  await commit(req);
  res.json(req.session.tasks);
});

// Per-task run lock: a second run/revise/step call for the SAME task while one is in flight would burn a
// full duplicate agent run (real credits) and race its writes. In-memory is fine — concurrent requests in
// one process are the case that matters; cross-instance overlap is already softened by runById's status guard.
const runningTasks = new Set<string>();
const withTaskLock = async (id: string, res: express.Response, fn: () => Promise<void>): Promise<void> => {
  if (runningTasks.has(id)) { res.status(409).json({ error: "already running" }); return; }
  runningTasks.add(id);
  try { await fn(); } finally { runningTasks.delete(id); }
};

// The client drives runs (calls this for each ready task) — synchronous, returns the executed task.
app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run tasks." }); return; }
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const t = await tasks.runById(req.session.tasks || [], String(req.params.id), (req.session.profile ||= emptyProfile()), await toolsFor(req));
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e: any) {
      console.error("[tasks] run error for task", req.params.id, ":", e);
      res.status(500).json({ error: e?.message || "run failed" });
    }
  });
});

// Revise: the user declined to send and said what to change → re-run the task with that instruction so Otto
// updates the draft (and re-offers it as a sendable) before they send.
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) { res.status(400).json({ error: "note required" }); return; }
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to revise tasks." }); return; }
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const t = await tasks.runById(req.session.tasks || [], String(req.params.id), (req.session.profile ||= emptyProfile()), await toolsFor(req), note);
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e: any) {
      console.error("[tasks] revise error for task", req.params.id, ":", e);
      res.status(500).json({ error: e?.message || "revise failed" });
    }
  });
});

// These return the FULL task list (client filters out done/dismissed for display) — so the dashboard's
// "handled" count + the deep-link "already handled" fallback keep working after a confirm/dismiss.
app.post("/api/tasks/:id/confirm", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "done";
    task.updatedAt = new Date().toISOString();
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/reject", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    tasks.reject(req.session.tasks || [], id);
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
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
// Auto-do ONE automatable step (focused agent run over the connected apps).
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run steps." }); return; }
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const permTools = await integrations.getAgentToolsWithPermission(req.session.user!).catch(() => undefined);
      const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : undefined;
      const t = await tasks.runStep(req.session.tasks || [], String(req.params.id), Number(req.params.index), (req.session.profile ||= emptyProfile()), permTools, answer);
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e: any) {
      console.error("[tasks] step run error for task", req.params.id, "step", req.params.index, ":", e);
      res.status(500).json({ error: e?.message || "step run failed" });
    }
  });
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
    await commit(req);
  }
  res.json(t);
});

// ── Chat (DeepSeek + web search, grounded in the user's profile + to-dos) ─────────
app.post("/api/chat", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
  try {
    const messages: ChatTurn[] = Array.isArray(req.body?.messages)
      ? req.body.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string").slice(-20)
      : [];
    if (!messages.length) { res.status(400).json({ error: "messages required" }); return; }
    // Give the chat the user's live to-dos as context (titles + timeline only — concise).
    const live = (req.session.tasks || []).filter((t) => t.status !== "done" && t.status !== "dismissed").slice(0, 25);
    const tasksSummary = live.map((t) => `- ${t.title}${t.when ? ` (${t.when})` : ""}`).join("\n");
    const out = await chat(messages, req.session.profile, tasksSummary);
    // Chat is where users volunteer who they are — persist anything the assistant chose to remember.
    if (out.profileUpdates?.length) {
      const profile = (req.session.profile ||= emptyProfile());
      for (const u of out.profileUpdates) tasks.applyProfileUpdate(profile, u);
      await commit(req);
    }
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e?.message || "chat failed" }); }
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
