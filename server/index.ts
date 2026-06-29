import "./env.ts"; // load web/.env + the repo-root .env (COMPOSIO_API_KEY etc.) — MUST be first
import express from "express";
import type { RequestHandler } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { emptyProfile } from "../shared/types.ts";
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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set in production — required for AI task generation and execution.");
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
// Persist the session AND this ACCOUNT's durable state (profile + tasks) to the cloud, keyed by the
// account email — so it follows the account across devices and survives restarts. (Integration
// connections live in Composio, keyed by the same account email, so there's nothing extra to store.)
const commit = async (req: express.Request) => {
  await saveSession(req);
  await saveState(req.session.user, {
    profile: req.session.profile || emptyProfile(),
    tasks: req.session.tasks || [],
  });
};

const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.user) { res.status(401).json({ error: "not logged in" }); return; }
  next();
};

// Per-account rate limiter (in-memory sliding window) for the expensive Opus/Composio endpoints, so a runaway
// client loop or a leaked session can't run up the Anthropic bill. Keyed by account email (falls back to IP).
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
  };
  res.json(s);
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get("/api/tasks", requireAuth, (req, res) => { res.json(req.session.tasks || []); });

app.post("/api/tasks/generate", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  try {
    const extras = await toolsFor(req);
    if (!extras?.tools?.length) { res.status(400).json({ error: "Connect an app (Gmail, Calendar, Slack, etc.) in Settings so Otto has something to read." }); return; }
    req.session.tasks = await tasks.generate(req.session.tasks || [], (req.session.profile ||= emptyProfile()), extras);
    await commit(req);
    res.json(req.session.tasks);
  } catch (e: any) {
    console.error("[tasks] generate error:", e);
    res.status(500).json({ error: e?.message || "generate failed" });
  }
});

app.post("/api/tasks", requireAuth, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) { res.status(400).json({ error: "title required" }); return; }
  // AI-refine the user's rough note into a crisp task (falls back to the raw text if refinement fails).
  const refined = aiReady() ? await refineManualTask(title, req.session.profile) : null;
  req.session.tasks = tasks.addManual(req.session.tasks || [], title, refined);
  await commit(req);
  res.json(req.session.tasks);
});

// The client drives runs (calls this for each ready task) — synchronous, returns the executed task.
app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  try {
    const t = await tasks.runById(req.session.tasks || [], String(req.params.id), (req.session.profile ||= emptyProfile()), await toolsFor(req));
    await commit(req);
    res.json(t || { error: "not found" });
  } catch (e: any) {
    console.error("[tasks] run error for task", req.params.id, ":", e);
    res.status(500).json({ error: e?.message || "run failed" });
  }
});

// Revise: the user declined to send and said what to change → re-run the task with that instruction so Otto
// updates the draft (and re-offers it as a sendable) before they send.
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) { res.status(400).json({ error: "note required" }); return; }
  try {
    const t = await tasks.runById(req.session.tasks || [], String(req.params.id), (req.session.profile ||= emptyProfile()), await toolsFor(req), note);
    await commit(req);
    res.json(t || { error: "not found" });
  } catch (e: any) {
    console.error("[tasks] revise error for task", req.params.id, ":", e);
    res.status(500).json({ error: e?.message || "revise failed" });
  }
});

// These return the FULL task list (client filters out done/dismissed for display) — so the dashboard's
// "handled" count + the deep-link "already handled" fallback keep working after a confirm/dismiss.
app.post("/api/tasks/:id/confirm", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "done";
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
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
// Auto-do ONE automatable step (focused agent run over the connected apps).
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  try {
    const permTools = await integrations.getAgentToolsWithPermission(req.session.user!).catch(() => undefined);
    const t = await tasks.runStep(req.session.tasks || [], String(req.params.id), Number(req.params.index), (req.session.profile ||= emptyProfile()), permTools);
    await commit(req);
    res.json(t || { error: "not found" });
  } catch (e: any) {
    console.error("[tasks] step run error for task", req.params.id, "step", req.params.index, ":", e);
    res.status(500).json({ error: e?.message || "step run failed" });
  }
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
    if (result !== undefined) step.result = result;
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
    await commit(req);
  }
  res.json(t);
});

// ── Chat (Claude + web search, grounded in the user's profile + to-dos) ─────────
app.post("/api/chat", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  try {
    const messages: ChatTurn[] = Array.isArray(req.body?.messages)
      ? req.body.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string").slice(-20)
      : [];
    if (!messages.length) { res.status(400).json({ error: "messages required" }); return; }
    // Give the chat the user's live to-dos as context (titles + timeline only — concise).
    const live = (req.session.tasks || []).filter((t) => t.status !== "done" && t.status !== "dismissed").slice(0, 25);
    const tasksSummary = live.map((t) => `- ${t.title}${t.when ? ` (${t.when})` : ""}`).join("\n");
    const out = await chat(messages, req.session.profile, tasksSummary);
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
if (PROD) {
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
// concurrent Claude run (Anthropic SDK, googleapis, a tool reject) would otherwise crash the whole
// process — killing every in-flight /run with "socket hang up" so tasks never finish (no steps).
// Log and keep serving; the affected request already has its own try/catch and 500s on its own.
process.on("unhandledRejection", (reason) => console.error("[weave-web] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[weave-web] uncaughtException:", err));

app.listen(PORT, () => console.log(`[weave-web] listening on :${PORT} (${PROD ? "production" : "dev"})`));
