import "./env.ts"; // load web/.env + the repo-root .env (COMPOSIO_API_KEY etc.) — MUST be first
import { initSentry, reportError } from "./sentry.ts";
initSentry(); // before anything else can throw — no-op if SENTRY_DSN isn't set
import express from "express";
import type { RequestHandler } from "express";
import compression from "compression";
import session from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import type { WebTask, ConnectionStatus, Profile, StudySession, StudyProfile } from "../shared/types.ts";
import { emptyProfile, dedupeFacts, canonStatus, isHandled, isInFlight, isValidTz, monthCostUsd, monthlyBudgetUsd, overMonthlyBudget, overInteractiveBudget, budgetRenewsOn, tzOf, addUsage, nextLeitnerReview, practiceAnswerMatches } from "../shared/types.ts";
import { computeWorkload } from "./workload.ts";
import { aiReady, refineManualTask, chatAboutTask, expandStep, runSubstep, studyHelp, generateDailyStudyCards, generateDailyPracticeProblem, generateWeeklyStudyDeck, generateMonthlyStudyDeck } from "./claude.ts";
import { loadState, saveState, cloudEnabled, getUser, createUser, mirrorAuthUser, deleteAccount, makeSessionStore, getJob, getLatestJob, eventsForTask, exportJobsAndEvents, recordEvent, countActiveJobs, activeJobTaskIds, enqueueJob, checkRateLimit } from "./store.ts";
import * as tasks from "./tasks.ts";
import * as jobs from "./jobs.ts";
import * as integrations from "./integrations.ts";
import * as pronoteSvc from "./pronote.ts";

declare module "express-session" {
  interface SessionData {
    user?: string;        // the authenticated ACCOUNT email (everything keys off this; = Composio user_id)
    tasks?: WebTask[];
    profile?: Profile;
    integrations?: Record<string, string>; // app key → Composio connectionId hint (status is live from Composio)
    lastGenDay?: string;  // "YYYY-MM-DD" of the last full generate sweep — the once-a-day floor (survives serverless cold starts)
    lastGenTime?: string; // ISO timestamp of the last generation (for continuous monitoring)
    studySessions?: StudySession[]; // study session history
    studyProfile?: StudyProfile; // adaptive study profile
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
// Vercel's Node serverless functions do NOT auto-gzip responses (confirmed live: /api/status came back
// with no content-encoding header even with Accept-Encoding: gzip sent) — unlike the static asset CDN,
// which does compress. Every JSON API response in this app was going out uncompressed, and several of the
// heaviest, most frequent ones (res.json(req.session.tasks) — the WHOLE task list, including every task's
// full chat history/steps/notes/decks — fire on nearly every click: reviewing one flashcard, answering one
// quiz question, ticking one step). This is the single highest-leverage fix for response egress: gzip
// typically cuts JSON payloads 70-85%, with zero behavior change for callers.
app.use(compression());
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
  // Study Mode's in-app dictionary artifact fetches these directly from the browser (client/study/artifacts/
  // DictionaryArtifact.tsx) — a strict 'self' here silently blocked every lookup with "Failed to fetch"
  // (CSP violations don't reach the app's own try/catch as an HTTP error; the browser just refuses the fetch).
  "connect-src 'self' https://freedictionaryapi.com",
  // Study Mode embeds several things in iframes: a Spotify playlist/album/track widget (client/study/
  // spotify.ts, no OAuth needed), a Google Doc, a YouTube video, and — critically — the student's own
  // uploaded PDFs, which load from a same-page blob: URL (StudySetup's upload flow). Once frame-src is set
  // AT ALL it replaces the default-src 'self' fallback entirely rather than adding to it — setting it to
  // just the Spotify origin (as this first did) silently broke every other embed, including the student's
  // own files, with Chrome's generic "This content is blocked" — so 'self' and blob: must be listed here
  // explicitly, not assumed to still apply.
  "frame-src 'self' blob: https://open.spotify.com https://docs.google.com https://www.youtube-nocookie.com https://www.desmos.com https://*.padlet.com https://*.padlet.org",
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
// PROD already fails closed above if SESSION_SECRET is unset (see the boot check). This fallback only
// ever runs in a misconfigured non-PROD deployment — it must NOT be a fixed string: the old default
// ("dev-insecure-secret-change-me") is sitting in every public clone of this repo, so any deployment
// that forgot to set NODE_ENV=production would sign session cookies with a secret the whole internet
// already knows. A random-per-boot secret means sessions won't survive a restart in that misconfigured
// case — correct behavior for a deployment that was never meant to run this way, not a regression.
const FALLBACK_SESSION_SECRET = randomBytes(32).toString("hex");
app.use(session({
  store: await makeSessionStore(), // Supabase-backed when cloud is configured → sessions survive restarts/deploys
  secret: process.env.SESSION_SECRET || FALLBACK_SESSION_SECRET,
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
  // Only the session-store write is awaited: it's what a same-device follow-up request depends on
  // (sessions are cloud-backed too — makeSessionStore() — so this is the account's cross-request
  // truth, and it's a single round trip). The cross-device cloud sync below (read this account's cloud
  // row, merge, write it back) used to run — and be retried up to 3x on a blip — IN LINE before the
  // response, turning every confirm/dismiss/step-done tap into 2 sequential Supabase round trips
  // minimum. Every one of this function's ~20 call sites responds with the LOCAL req.session state
  // (never the merged result) immediately after commit() resolves, so nothing depends on the merge
  // finishing first — detach it as best-effort background work instead, matching saveState's own "never
  // throws into the request path" contract and the `void recordEvent(...)` fire-and-forget pattern
  // already used right after several of these call sites.
  await saveSession(req);
  if (!req.session.user) return;
  const email = req.session.user;
  const localTasks = req.session.tasks || [];
  const localProfile = req.session.profile || emptyProfile();
  void (async () => {
    try {
      const current = await loadState(email);
      const mergedTasks = mergeTasks(current.tasks || [], localTasks);
      const mergedProfile = mergeProfiles(current.profile || emptyProfile(), localProfile);
      await saveState(email, { profile: mergedProfile, tasks: mergedTasks });
    } catch {
      await saveState(email, { profile: localProfile, tasks: localTasks }).catch(() => {});
    }
  })();
};

// Simple synchronous task-mutating routes (confirm/reject/dismiss/step-done) used to just `find()` in
// `req.session.tasks` and silently no-op — `res.json(unchanged list)` — if the session was momentarily
// stale, indistinguishable from success to the client. Same reload-and-retry shape `runViaJob` already
// uses for the job-queue routes: only reload from the cloud on a genuine miss (the common case never pays
// the extra round-trip), and only 404 if the task still isn't found after that.
async function findTaskOrReload(req: express.Request, id: string): Promise<WebTask | undefined> {
  let task = (req.session.tasks || []).find((t) => t.id === id);
  if (task || !req.session.user) return task;
  try {
    const cloud = await loadState(req.session.user);
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    await saveSession(req);
  } catch { /* fall through to the final lookup — a failed reload just means we still 404 below */ }
  return (req.session.tasks || []).find((t) => t.id === id);
}

// Express 4 does NOT auto-catch a rejected promise from an async route handler — a route that forgets
// its own try/catch (verified: ~12 routes did, below) lets that rejection fall through to the process-
// level `unhandledRejection` listener at the bottom of this file, which only logs. The ORIGINAL request
// never gets a response at all — it hangs until the client's own timeout, instead of the clean 500 the
// catch-all error middleware (also at the bottom of this file) is already built to return. This routes
// exactly those otherwise-unguarded rejections into that EXISTING middleware via `next(err)`, rather
// than adding a second one — every route that already has its own try/catch is unaffected either way.
const ah = (fn: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.user) { res.status(401).json({ error: "not logged in" }); return; }
  next();
};

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
const rateLimit = (max: number, windowMs: number): RequestHandler => async (req, res, next) => {
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
// The agent's toolset for this account's connected apps (Composio). Empty if Composio's unset/nothing linked.
const toolsFor = (req: express.Request) => integrations.getAgentTools(req.session.user!, { primaryAccounts: req.session.profile?.primaryAccounts }).catch(() => undefined);

// ── Email account auth ─────────────────────────────────────────────────────────
const normEmail = (s: unknown) => String(s || "").trim().toLowerCase();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

app.post("/api/auth/signup", rateLimit(6, 60 * 60_000), ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!validEmail(email) || password.length < 8 || password.length > 200) { res.status(400).json({ error: "Enter a valid email and a password between 8 and 200 characters." }); return; }
  // The Privacy Policy states under-15s need a parent to set the account up (RGPD Art.8) — this was
  // previously enforced by text alone. Not real age verification, but a required, recorded affirmative
  // signal beats none.
  if (req.body?.consent !== true) { res.status(400).json({ error: "Please confirm you're 15 or older, or that a parent set this account up for you." }); return; }
  if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." }); return; }
  if (await getUser(email)) { res.status(409).json({ error: "An account with that email already exists — log in instead." }); return; }
  if (!(await createUser(email, bcrypt.hashSync(password, 10)))) { res.status(500).json({ error: "Couldn't create the account." }); return; }
  void mirrorAuthUser(email, password); // best-effort — shows the account in Supabase's own Auth tab too
  // Regenerate the session id on every privilege change (login/signup) — never write the authenticated
  // user onto a pre-existing session id. Without this, a session id fixed on a victim's browser BEFORE
  // they sign up (e.g. planted via an unrelated XSS/subdomain trick) would become a live authenticated
  // session the moment they complete signup — classic session fixation.
  req.session.regenerate((err) => {
    if (err) { res.status(500).json({ error: "Couldn't create the account — try again." }); return; }
    req.session.user = email;
    // Must explicitly reset these, exactly like /api/auth/login does — if this browser's session cookie
    // already had another account's tasks/profile in it (e.g. someone created a new account without signing
    // out of the previous one first), leaving them untouched here leaked the OLD account's tasks into the
    // BRAND NEW one on the very next request (the safety-net middleware above only fills these in when
    // they're `undefined`, which they aren't in that case) — they'd even get merged into and saved onto the
    // new account's cloud row. A fresh signup always starts from empty state.
    req.session.profile = { ...emptyProfile(), ageConsentAt: new Date().toISOString() };
    req.session.tasks = [];
    void recordEvent(email, "signup", {});
    saveSession(req).then(() => res.json({ ok: true }));
  });
}));

app.post("/api/auth/login", rateLimit(10, 15 * 60_000), ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  // Without this, getUser() always returns null when Supabase isn't configured (e.g. local dev with no
  // .env set up) and login falls straight through to "Wrong email or password" — sending you down the
  // wrong path (retyping/resetting a password that was never the actual problem). Same check signup has.
  if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase) — sign-in can't work until that's set." }); return; }
  const u = await getUser(email);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
    void recordEvent(email, "login_failed", {}); // never the password — email only, for brute-force visibility
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }
  // Regenerate the session id on login — see the signup handler's comment on why (session fixation).
  req.session.regenerate(async (err) => {
    if (err) { res.status(500).json({ error: "Couldn't log you in — try again." }); return; }
    req.session.user = email;
    // Bring back this account's saved profile + tasks. (App connections live in Composio, keyed by this
    // same account email, so they're already linked — nothing to restore here.)
    const restored = await loadState(email);
    req.session.profile = restored.profile;
    req.session.tasks = restored.tasks;
    void recordEvent(email, "login", {});
    await saveSession(req);
    res.json({ ok: true });
  });
}));

app.post("/api/auth/logout", (req, res) => {
  const email = req.session.user;
  req.session.destroy(() => {
    // Belt-and-suspenders on top of destroy(): if some OTHER request already in flight on this same
    // cookie (a background sweep/kick tick — see client/App.tsx's signedOutRef) still calls
    // req.session.save() after this destroy() runs, it can silently re-insert the session row under the
    // same id, and the browser's still-held cookie would then resolve to a "logged in" session again —
    // exactly the "auto logs in after sign out" report. Clearing the cookie here doesn't stop that other
    // request's write, but it does mean any tab that DIDN'T just receive a resurrected Set-Cookie no
    // longer presents the old id at all, closing off the most common path back in.
    res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: PROD });
    if (email) void recordEvent(email, "logout", {});
    res.json({ ok: true });
  });
});

// GDPR right-to-erasure, self-serve: permanently deletes every row this account owns (see
// store.deleteAccount) and destroys the session. Irreversible — the client confirms before calling this.
app.post("/api/account/delete", requireAuth, rateLimit(5, 60_000), async (req, res) => {
  const email = req.session.user!;
  // NOT recordEvent(): deleteAccount() below purges this account's OWN rows from the events table as
  // part of the erasure, so a "deleted" event written there would erase itself in the same request —
  // the one event that most needs to survive would leave zero trace. console.warn instead: platform log
  // retention (Vercel/Railway/etc.) is a separate system from the app's own DB, so this line survives
  // the account row being gone, which is the actual point of a deletion audit trail.
  console.warn(`[audit] account_deleted: ${email}`);
  try {
    const result = await deleteAccount(email);
    // Only destroy the session on a confirmed result — destroying it on a thrown error (below) would make
    // an account that's still fully intact server-side look deleted client-side, with no way back in to
    // retry. deleteAccount isn't necessarily transactional, so a caught error here doesn't guarantee
    // nothing was removed — it just means the request no longer hangs silently, which is the actual bug
    // being fixed (Express 4 never responds to an unhandled rejection in a route handler).
    req.session.destroy(() => res.json(result));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Couldn't delete the account — try again." });
  }
});

// GDPR right to data portability, self-serve: everything Otto has stored for this account, as one JSON file.
app.get("/api/account/export", requireAuth, rateLimit(5, 60_000), async (req, res) => {
  const email = req.session.user!;
  void recordEvent(email, "account_exported", {});
  try {
    const state = cloudEnabled() ? await loadState(email) : { profile: req.session.profile, tasks: req.session.tasks, google: undefined, pronote: undefined };
    // Was profile+tasks only — deleteAccount also wipes job records and the audit/event trail, so an
    // export used to return strictly LESS than what's actually stored (and later erased), incomplete
    // relative to a GDPR Art.15 access request.
    const { jobs, events } = cloudEnabled() ? await exportJobsAndEvents(email) : { jobs: [], events: [] };
    // Connection METADATA only, never the live credential — state.google.tokens/state.pronote.token are
    // active OAuth/session secrets (a password-equivalent for Pronote specifically); handing those back
    // in a downloadable JSON file would be a real account-takeover risk, not a compliance win. Access
    // still covers what matters for Art.15: which accounts are connected and their non-secret identity.
    const connections = {
      google: state.google ? { connected: true, email: state.google.email } : null,
      pronote: state.pronote ? { connected: true, url: state.pronote.url, username: state.pronote.username } : null,
    };
    res.setHeader("Content-Disposition", `attachment; filename="otto-data-${email}.json"`);
    res.json({ email, exportedAt: new Date().toISOString(), profile: state.profile, tasks: state.tasks, connections, jobs, events });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Couldn't export your data — try again." });
  }
});

// Google now connects through Composio (Gmail / Calendar / Docs / Slides / Drive / Sheets) like every other
// app — see the integration routes below. (The old direct-OAuth /auth/google flow has been retired.)

// ── Integrations (Composio: Google, Slack, GitHub, Notion, Linear, …) ───────────
// List the catalog + which the account has connected (status is queried LIVE from Composio per account).
app.get("/api/integrations", requireAuth, ah(async (req, res) => {
  const ready = integrations.integrationsReady();
  const apps = integrations.CATALOG.map((c) => c.key);
  const statuses = ready ? await integrations.getAllConnectionStatuses(req.session.user!, apps, req.session.integrations || {}) : {};
  res.json({
    ready,
    items: integrations.CATALOG.map((c) => ({ key: c.key, name: c.name, blurb: c.blurb, category: c.category, logo: integrations.logoFor(c.toolkit), connected: !!(statuses as any)[c.key] })),
  });
}));

// Get connected accounts for a specific app (supports multiple accounts)
app.get("/api/integrations/:app/accounts", requireAuth, ah(async (req, res) => {
  const app2 = String(req.params.app);
  if (!integrations.CATALOG.some((c) => c.key === app2)) { res.status(404).json({ error: "Unknown integration." }); return; }
  const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2, true) : [];
  res.json({ accounts });
}));

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

// ── Pronote — parallel to the Composio-routed integrations above: no OAuth exists, so this is a plain
// credential form instead of a redirect. READ-ONLY (homework); never wired into the agent's toolset.
app.get("/api/integrations/pronote/status", requireAuth, ah(async (req, res) => {
  res.json(await pronoteSvc.pronoteConnected(req.session.user!));
}));
app.post("/api/integrations/pronote/connect", requireAuth, rateLimit(8, 15 * 60_000), async (req, res) => {
  const { url, username, password, kind } = req.body || {};
  if (typeof url !== "string" || typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "URL, username and password are required." }); return;
  }
  try {
    const result = await pronoteSvc.connectPronote(req.session.user!, { url, username, password, kind: Number(kind) || undefined });
    if (result.ok) pronoteSvc.invalidatePronoteStatus(req.session.user!); // else /api/status's cache keeps reporting "not connected" for up to 60s
    // Pull grades right away on a fresh connect — otherwise a student wouldn't see any until the next daily
    // sweep or a manual "Sync from Pronote" click, and "I just connected Pronote" is exactly the moment
    // grades should already be there. Best-effort: never fails the connect itself.
    if (result.ok) {
      try {
        const p = (req.session.profile ||= emptyProfile());
        pronoteSvc.applyPronoteGrades(p, await pronoteSvc.pronoteGrades(req.session.user!));
        await commit(req);
      } catch { /* best-effort */ }
    }
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't connect to Pronote — try again." }); }
});
// Upcoming tests for the dashboard's exam countdown strip — a plain read, separate from the task pipeline
// (a test already has/will have a task, but the countdown needs the raw subject+date list to lay out as a
// timeline rather than dig it back out of task titles).
app.get("/api/pronote/tests", requireAuth, async (req, res) => {
  const manual = (req.session.profile?.manualExams || []).map((e) => ({ subject: e.subject, deadline: e.deadline }));
  try {
    const conn = await pronoteSvc.pronoteConnected(req.session.user!);
    if (!conn.connected) { res.json({ tests: manual }); return; }
    const tests = await pronoteSvc.pronoteTests(req.session.user!);
    res.json({ tests: [...tests.map((t) => ({ subject: t.subject, deadline: t.deadline })), ...manual] });
  } catch { res.json({ tests: manual }); }
});
app.post("/api/integrations/pronote/disconnect", requireAuth, async (req, res) => {
  try {
    await pronoteSvc.disconnectPronote(req.session.user!);
    pronoteSvc.invalidatePronoteStatus(req.session.user!);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't disconnect Pronote — try again." }); }
});
// Read-only: the raw Pronote grade averages, for anything that just wants to display them.
app.get("/api/pronote/grades", requireAuth, async (req, res) => {
  try {
    const conn = await pronoteSvc.pronoteConnected(req.session.user!);
    if (!conn.connected) { res.json({ grades: [] }); return; }
    res.json({ grades: await pronoteSvc.pronoteGrades(req.session.user!) });
  } catch { res.json({ grades: [] }); }
});
// Deterministic "this week" workload view — no AI call, just real Pronote homework/tests + open tasks
// bucketed by day with a relative effort heuristic (see server/workload.ts). Cheap enough to recompute
// on every request rather than cache/store.
app.get("/api/workload", requireAuth, async (req, res) => {
  const email = req.session.user!;
  let homework: Awaited<ReturnType<typeof pronoteSvc.pronoteHomework>> = [];
  let tests: Awaited<ReturnType<typeof pronoteSvc.pronoteTests>> = [];
  try {
    if ((await pronoteSvc.pronoteConnected(email)).connected) {
      [homework, tests] = await Promise.all([pronoteSvc.pronoteHomework(email), pronoteSvc.pronoteTests(email)]);
    }
  } catch { /* best-effort — an empty Pronote picture still lets open tasks show */ }
  // Manually-logged exams (server/pronote.ts's PronoteTestItem shape: {id, subject, deadline}) merge in
  // alongside Pronote's own — so a non-Pronote student's workload view isn't just empty.
  const allTests = [...tests, ...(req.session.profile?.manualExams || [])];
  const tasks = (req.session.tasks || []).filter((t) => !isHandled(t.status));
  const { days } = computeWorkload({ homework, tests: allTests, tasks, grades: req.session.profile?.grades, timezone: tzOf(req.session.profile) });
  res.json({ days });
});

app.post("/api/integrations/:app/disconnect", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  try {
    const result = integrations.integrationsReady() ? await integrations.disconnect(app2, req.session.user!) : { ok: true };
    if (req.session.integrations) delete req.session.integrations[app2];
    integrations.invalidateTools(req.session.user!);
    await saveSession(req);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't disconnect — try again." }); }
});

// Disconnect a specific account by ID (for multi-account support)
app.post("/api/integrations/:app/disconnect/:accountId", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  const accountId = String(req.params.accountId);
  try {
    // Verify the account belongs to this user and app before disconnecting
    const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2) : [];
    const account = accounts.find((a) => a.id === accountId);
    if (!account) { res.status(404).json({ error: "Account not found." }); return; }
    const result = await integrations.disconnectAccount(accountId);
    integrations.invalidateTools(req.session.user!);
    await saveSession(req);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't disconnect — try again." }); return; }
});

// ── Status ──────────────────────────────────────────────────────────────────
// googleConnected now means "Gmail is connected via Composio" (the minimum to generate tasks). Cached
// briefly so polling this hot endpoint doesn't hammer Composio.
app.get("/api/status", ah(async (req, res) => {
  // Both checks are independent reads — running them sequentially (the old code awaited one, then the
  // other) doubled this endpoint's latency for no reason. It's polled on every app open/focus/tab-switch
  // (see client/App.tsx's status refresh), so that add-up was a real, constant source of felt latency.
  const [googleConnected, pronoteStatus] = await Promise.all([
    req.session.user && integrations.integrationsReady()
      ? integrations.connectionStatusesCached(req.session.user, ["gmail"]).then((s) => !!s["gmail"]).catch(() => false)
      : Promise.resolve(false),
    // Otto Lycée: Pronote is now a first-class data source on its own, not just a Google add-on — a lycéen
    // with ONLY Pronote connected (no Gmail) must still see their dashboard, not get stuck on ConnectCard.
    req.session.user
      ? pronoteSvc.pronoteConnectedCached(req.session.user).catch((): { connected: boolean; username?: string; needsReconnect?: boolean } => ({ connected: false }))
      : Promise.resolve<{ connected: boolean; username?: string; needsReconnect?: boolean }>({ connected: false }),
  ]);
  const s: ConnectionStatus = {
    loggedIn: !!req.session.user,
    user: req.session.user,
    name: req.session.profile?.name,
    googleConnected,
    pronoteConnected: pronoteStatus.connected,
    ...(pronoteStatus.needsReconnect ? { pronoteNeedsReconnect: true } : {}),
    aiReady: aiReady(),
    googleConfigured: integrations.integrationsReady(), // Composio is what powers Google + every integration now
    cloud: cloudEnabled(),
    paused: !!req.session.profile?.paused,
    highPriorityPeople: req.session.profile?.highPriorityPeople,
    genPerDay: req.session.profile?.genPerDay,
    timezone: req.session.profile?.timezone,
    overBudget: overMonthlyBudget(req.session.profile),
    unlimited: !!req.session.profile?.unlimited,
    language: req.session.profile?.language === "en" ? "en" : "fr",
    voiceChat: !!req.session.profile?.voiceChat,
  };
  res.json(s);
}));

// "Pause all AI usage" — the ONE toggle that stops generation and task runs. Enforced server-side
// (isPaused, used below) so it holds even if a stale client tab tries to call one of those routes anyway.
const isPaused = (req: express.Request): boolean => !!req.session.profile?.paused;
// Monthly AI spend cap — the honest 402 an interactive route returns when the account is over budget.
const overBudget = (req: express.Request): boolean => overMonthlyBudget(req.session.profile);
// A user-present action (Approve & Run, manual run, revise) is allowed a small reserve above the cap so the
// human's own last step isn't the thing the budget kills — background work still stops hard at the cap.
const overInteractive = (req: express.Request): boolean => overInteractiveBudget(req.session.profile);
const BUDGET_MSG = "Otto's reached its monthly AI budget (including the interactive reserve) — it resets on the 1st. Raise MONTHLY_AI_BUDGET_USD to lift it.";
// Visiting /unlimited (client-side route, see App.tsx) removes this account's monthly AI spend cap.
app.post("/api/settings/unlimited", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    p.unlimited = true;
    void recordEvent(req.session.user!, "settings_changed", { message: "unlimited enabled" });
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save — try again." }); }
});

app.post("/api/settings/pause", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    p.paused = req.body?.paused === true;
    p.pausedAt = new Date().toISOString();
    void recordEvent(req.session.user!, "settings_changed", { message: p.paused ? "AI paused" : "AI resumed" });
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save — try again." }); }
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
      // The client only needs the merged LIST — persisting the reconciled session is bookkeeping that
      // can happen after the response goes out (saveSession never rejects, so this is safe to fire-and-forget).
      void saveSession(req);
    }
  } catch { /* best-effort — fall back to the session copy */ }
  if (req.session.tasks) tasks.applyDeadlineUrgency(req.session.tasks);
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
    // Pronote is read outside the Composio toolset entirely (server/discover.ts calls it directly), so a
    // Pronote-only lycéen with no Gmail connected must still be able to sweep — gating on Composio tools
    // alone used to hard-block them here even though the deterministic pipeline already supports this.
    const pronoteOn = (await pronoteSvc.pronoteConnected(user)).connected;
    if (!extras?.tools?.length && !pronoteOn) { res.status(400).json({ error: "Connecte ton Pronote dans les Réglages pour qu'Otto ait quelque chose à lire." }); return; }
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

app.post("/api/tasks", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) { res.status(400).json({ error: "title required" }); return; }
  // Idempotency key — the client sends its own local stub id. Without this, a retried request (the client's
  // own retry-on-dropped-response logic in api.ts's `req()`, or a plain double-click before the button
  // disabled) created a SECOND task for the same submission — reported live as "manual tasks are sometimes
  // generated twice". A replay of an already-applied clientId is a no-op: return the current list as-is,
  // no refine call, no enqueue, no duplicate.
  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.slice(0, 80) : undefined;
  if (clientId && (req.session.tasks || []).some((t) => t.clientId === clientId)) { res.json(req.session.tasks || []); return; }
  // Optional explicit date (personal commitments — a job shift, a club meeting, an appointment) from a
  // native <input type="date">: only accept a real calendar date, never arbitrary free text here (that's
  // what the title/AI-refinement path is for) — a bad value silently becomes "no date" rather than a 500.
  const explicitWhen = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.when || "")) ? String(req.body.when) : undefined;
  // Refine the raw note into a crisp, specific task title UP FRONT (one quick call) so the card reads well
  // immediately — "send email to mmachi excusing that the ai service wasnt working in weave" becomes
  // "Email Mmachi apologizing for the Weave AI outage". This was previously left to the execution run as a
  // side effect, but that isn't reliable (the run can defer, fail, or not return a title), so a vague raw
  // title stuck around on the card. The execution run can still further sharpen it. When AI is
  // unavailable/paused/over budget, it goes in unrefined and the background sweep's auto-refine cleans it up.
  const ready = aiReady() && !isPaused(req) && !overBudget(req);
  const refined = ready ? await refineManualTask(title, req.session.profile).catch(() => null) : null;
  if (refined) addUsage(req.session.profile ||= emptyProfile(), refined.tokens, "manual_refine");
  try {
    req.session.tasks = tasks.addManual(req.session.tasks || [], title, refined, !ready, explicitWhen, clientId);
    const added = req.session.tasks[0];
    if (ready) added.status = "queued";
    // Persist the task to the cloud BEFORE enqueuing its execution job. The job runner reads task state from
    // the cloud (jobs.ts loadUser); enqueuing first opened a race where a concurrent drainer (another tab's
    // kick, or a cron tick) could claim the job before the commit landed and get "task not found" — which
    // marks the job succeeded and strands the task at "queued". Commit-then-enqueue closes that window —
    // but ONLY if the cloud write is actually awaited: commit()'s own cloud sync is deliberately
    // backgrounded (fire-and-forget, see its comment) for the OTHER ~20 call sites that don't immediately
    // hand off to the job runner. Awaiting the session save alone left this route with the exact race the
    // comment above claims is closed — the drain would read stale cloud state, miss the brand-new task, and
    // strand it at "queued" forever (reported live: "when i create task it just keep on queued with no
    // progress"). So this route needs its own awaited cloud write, not the shared backgrounded one.
    await saveSession(req);
    if (req.session.user) {
      const email = req.session.user;
      try {
        const current = await loadState(email);
        const mergedTasks = mergeTasks(current.tasks || [], req.session.tasks || []);
        const mergedProfile = mergeProfiles(current.profile || emptyProfile(), req.session.profile || emptyProfile());
        await saveState(email, { profile: mergedProfile, tasks: mergedTasks });
      } catch { /* best-effort — enqueueAndDrain below still has its own commitUser merge-on-write */ }
    }
    if (ready) {
      // enqueueAndDrain("execute_task") is the SINGLE planning pass: runTask() reads every connected integration
      // (Gmail/Calendar/Drive/Slack/GitHub/Notion) + web_search and fills in task.context/task.steps. Plan-only
      // mode (EXECUTION_ENABLED=false in claude.ts) already withholds every write tool, so this only gathers
      // knowledge and produces a plan — it never sends/creates/deletes anything.
      // Draining inline (not just enqueueJob) matters here: without it the task sat at "queued" until the
      // next cron tick or manual Kick — on Vercel Hobby cron that's once a day — which is exactly the "stuck
      // on Queued with no progress" bug reported live from a fresh manual task.
      try { await jobs.enqueueAndDrain(req.session.user!, "execute_task", added.id); } catch { /* client kick / cron will still pick it up */ }
    }
    res.json(req.session.tasks);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Couldn't add that task — try again." });
  }
});

// Refine an UNREFINED manual task (one added while AI was paused/unavailable) now that AI is back.
app.post("/api/tasks/:id/refine", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to refine." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  try {
    const refined = await refineManualTask(t.title, req.session.profile);
    if (refined) addUsage(req.session.profile ||= emptyProfile(), refined.tokens, "manual_refine");
    tasks.applyRefinement(req.session.tasks || [], t.id, refined);
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't refine that task — try again." }); }
});

// Per-task coaching chat — grounded in that one task's own context/steps, so a student stuck on it can
// talk it through with Otto without re-explaining the situation. Rate-limited + budget-gated like every
// other interactive AI call; capped history (CHAT_CAP) keeps a long-running task's thread bounded.
const CHAT_CAP = 60;
app.post("/api/tasks/:id/chat", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const message = String(req.body?.message || "").trim().slice(0, 2000);
  if (!message) { res.status(400).json({ error: "Say something first." }); return; }
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  // The "Aide" button on a step (see F) sends its own index — validate the range server-side, never trust
  // it blindly (steps get regenerated on every rerun, so a stale index from an old page load could point
  // anywhere or nowhere).
  const stepIndexRaw = req.body?.stepIndex;
  const stepIndex = Number.isInteger(stepIndexRaw) && stepIndexRaw >= 0 && stepIndexRaw < (t.steps?.length || 0) ? stepIndexRaw : undefined;
  // Study Mode materials (client-extracted PDF text, see client/study/pdfText.ts) — optional, capped here
  // too (defense in depth; chatAboutTask's materialsBlock caps again) since this is client-controlled input.
  const materialsRaw = Array.isArray(req.body?.materials) ? req.body.materials : [];
  const materials = materialsRaw
    .filter((m: any) => m && typeof m.label === "string" && typeof m.text === "string" && m.text.trim())
    .slice(0, 8)
    .map((m: any) => ({ label: String(m.label).trim().slice(0, 120), text: String(m.text).trim().slice(0, 6000) }));
  const history = t.chat || [];
  try {
    let academic: { homework: Awaited<ReturnType<typeof pronoteSvc.pronoteHomework>>; tests: Awaited<ReturnType<typeof pronoteSvc.pronoteTests>> } | undefined;
    try {
      if ((await pronoteSvc.pronoteConnected(req.session.user!)).connected) {
        const [homework, tests] = await Promise.all([pronoteSvc.pronoteHomework(req.session.user!), pronoteSvc.pronoteTests(req.session.user!)]);
        if (homework.length || tests.length) academic = { homework, tests };
      }
    } catch { /* best-effort */ }
    // Ensure a profile object exists BEFORE the call (not after, as it used to be here) — chatAboutTask can
    // now mutate it in place via the "remember" tool, so it needs a real object to write into for that to
    // ever take effect, not just for the token-usage bump that used to be the only reason this existed.
    const profile = req.session.profile ||= emptyProfile();
    // Read-only connected-account access (e.g. "did my teacher already reply?") — integrations.readOnly()
    // strips every write action at both the schema and call level before chatAboutTask ever sees it, so
    // this can never send/draft/delete anything, unlike runTask's own (separately scoped) tool access.
    // Best-effort: toolsFor already swallows its own errors into `undefined`, so a Composio hiccup here
    // just means chat runs without account access this turn, not a broken chat.
    const rawExtras = await toolsFor(req);
    const extras = rawExtras ? integrations.readOnly(rawExtras) : undefined;
    const out = await chatAboutTask(
      { title: t.title, why: t.why, context: t.context, steps: t.steps, sourceDetail: t.sourceDetail, sourceSubject: t.sourceSubject, sourceDue: t.sourceDue, flashcards: t.flashcards, quizzes: t.quizzes },
      history.map((h) => ({ role: h.role, text: h.text })),
      message,
      profile,
      academic,
      { stepIndex, materials, extras },
    );
    addUsage(profile, out.tokens, "chat"); // untracked before — a tool-calling turn can now cost like a small run
    const now = new Date().toISOString();
    // Accumulate this turn's artifacts onto the task exactly like a run does (same ARTIFACT_CAP), and
    // reference them from the assistant's own message so the thread can render an inline chip — the
    // content lives once (task.notes/flashcards/quizzes); the chat entry only points at it by id.
    const artifacts = [
      ...out.notes.map((n) => ({ kind: "note" as const, id: n.id, title: n.title })),
      ...out.flashcards.map((f) => ({ kind: "deck" as const, id: f.id, title: f.title })),
      ...out.quizzes.map((q) => ({ kind: "quiz" as const, id: q.id, title: q.title })),
    ];
    if (out.notes.length) t.notes = [...(t.notes || []), ...out.notes].slice(-tasks.ARTIFACT_CAP);
    if (out.flashcards.length) t.flashcards = [...(t.flashcards || []), ...out.flashcards].slice(-tasks.ARTIFACT_CAP);
    if (out.quizzes.length) t.quizzes = [...(t.quizzes || []), ...out.quizzes].slice(-tasks.ARTIFACT_CAP);
    if (out.audit.length) t.audit = [...(t.audit || []), ...out.audit].slice(-tasks.AUDIT_CAP);
    t.chat = [
      ...history,
      { role: "user" as const, text: message, at: now, ...(stepIndex != null ? { stepIndex, stepText: t.steps![stepIndex].text.slice(0, 80) } : {}) },
      { role: "assistant" as const, text: out.reply, at: now, ...(artifacts.length ? { artifacts } : {}), ...(out.guardrailTripped ? { guardrail: true } : {}) },
    ].slice(-CHAT_CAP);
    t.updatedAt = now;
    await commit(req);
    res.json({ chat: t.chat, task: t });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "chat failed" });
  }
});

// A tiny nudge-me sidebar next to a flashcard/quiz question — NOT the per-task chat above: no task lookup
// beyond auth (the card content comes straight from the client, since it's already showing it), no
// artifacts, no persisted history. Rate-limited higher than the main chat since a student can burn through
// several hints per card while drilling a deck.
app.post("/api/tasks/:id/study-help", requireAuth, rateLimit(40, 60_000), ah(async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const message = String(req.body?.message || "").trim().slice(0, 1000);
  if (!message) { res.status(400).json({ error: "Say something first." }); return; }
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
    .map((h: any) => ({ role: h.role as "user" | "assistant", text: String(h.text).slice(0, 1000) }))
    .slice(-8);
  const kind = req.body?.card?.kind;
  let card: Parameters<typeof studyHelp>[0];
  if (kind === "flashcard") {
    const front = String(req.body?.card?.front || "").slice(0, 500);
    const back = String(req.body?.card?.back || "").slice(0, 500);
    if (!front || !back) { res.status(400).json({ error: "Missing card." }); return; }
    card = { kind: "flashcard", front, back };
  } else if (kind === "quiz") {
    const question = String(req.body?.card?.question || "").slice(0, 500);
    const options = Array.isArray(req.body?.card?.options) ? req.body.card.options.map((o: any) => String(o).slice(0, 300)).slice(0, 10) : [];
    const correct = Number(req.body?.card?.correct);
    if (!question || !options.length || !Number.isInteger(correct) || correct < 0 || correct >= options.length) { res.status(400).json({ error: "Missing question." }); return; }
    card = { kind: "quiz", question, options, correct };
  } else { res.status(400).json({ error: "Missing card." }); return; }
  const out = await studyHelp(card, history, message, req.session.profile);
  addUsage(req.session.profile ||= emptyProfile(), out.tokens, "chat");
  await commit(req);
  res.json({ reply: out.reply });
}));

// Execution flows through the durable job queue: enqueue + drain inline (synchronous response for the
// client), with job idempotency as the cross-instance lock — one ACTIVE job per task, held in the DB.
// A second call while one is in flight gets a 409 (the client treats that as "the other run wins").
const runViaJob = async (req: express.Request, res: express.Response, type: "execute_task" | "revise" | "execute_step", input?: any) => {
  const user = req.session.user!;
  const id = String(req.params.id);
  try {
    const job = await jobs.enqueueAndDrain(user, type, id, input);
    // enqueueJob is idempotent PER TASK, not per job type — if a job of a DIFFERENT kind is already active
    // for this task (e.g. an auto-queued execute_task still running when the user asks to revise), it
    // returns THAT job as-is, silently discarding the new input (the revise note never gets applied).
    // That used to look exactly like "revise does nothing" — no error, no effect. Say so honestly instead.
    if (job.type !== type) {
      res.status(409).json({ error: "Otto is still working on this task — try again in a moment." });
      return;
    }
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
    // A job the processor SKIPPED (paused / over budget — see processExecuteStep/processExecuteTask) still
    // reports "succeeded" with a "skipped: ..." note, since it's not a failure the retry logic should act
    // on. But silently returning the unchanged task here looked EXACTLY like "I clicked and nothing
    // happened" — the route-level isPaused/overInteractive checks above only catch a stale SESSION profile;
    // the job re-checks against a freshly loaded CLOUD profile and can disagree (another device just paused
    // it, or budget ticked over between the click and the drain). Surface it as the same honest error.
    const skipNote = typeof job.output?.note === "string" && job.output.note.startsWith("skipped:") ? job.output.note : null;
    if (skipNote) { res.status(403).json({ error: skipNote.includes("budget") ? BUDGET_MSG : "AI is paused — resume it in Settings to run this." }); return; }
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
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  // Hard reset ("Réexécuter depuis le début"): the actual wipe happens INSIDE processExecuteTask (jobs.ts),
  // on the same load→mutate→commit cycle as the run itself — doing it here first and committing separately
  // got silently undone by commit()'s cross-device merge (see jobs.ts's comment on this). Just pass the
  // flag through the job input.
  await runViaJob(req, res, "execute_task", { manual: true, ...(req.body?.reset === true ? { reset: true } : {}) });
});

// Revise: the user declined to send and said what to change → re-run the task with that instruction so Otto
// updates the draft (and re-offers it as a sendable) before they send.
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) { res.status(400).json({ error: "note required" }); return; }
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to revise tasks." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  await runViaJob(req, res, "revise", { note });
});

// These return the FULL task list (client filters out done/dismissed for display) — so the dashboard's
// "handled" count + the deep-link "already handled" fallback keep working after a confirm/dismiss.
app.post("/api/tasks/:id/confirm", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  const id = String(req.params.id);
  try {
    const task = await findTaskOrReload(req, id);
    if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
    task.status = "done";
    task.updatedAt = new Date().toISOString();
    await commit(req);
    void recordEvent(req.session.user!, "confirmed", { taskId: id, message: "You marked it done" });
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't confirm that task — try again." }); }
});
app.post("/api/tasks/:id/reject", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  const id = String(req.params.id);
  try {
    const task = await findTaskOrReload(req, id);
    if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
    tasks.reject(req.session.tasks || [], id);
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't reject that task — try again." }); }
});
app.post("/api/tasks/:id/dismiss", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  const id = String(req.params.id);
  try {
    const task = await findTaskOrReload(req, id);
    if (!task) { res.status(404).json({ error: "Task not found — it may have already been handled elsewhere." }); return; }
    task.status = "dismissed";
    task.updatedAt = new Date().toISOString();
    await commit(req);
    void recordEvent(req.session.user!, "dismissed", { taskId: id, message: "You dismissed it — similar tasks won't come back" });
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't dismiss that task — try again." }); }
});
// Auto-do ONE automatable step (focused agent run over the connected apps) — through the job queue, same
// as full runs, so it's durably locked and audited. Enqueue-and-return, NOT enqueue-and-drain: a step run
// can involve a real tool call (draft an email, search, create a doc) that routinely takes well past what
// a click should block on — especially answering an inline question, where the answer itself is already
// captured as the job's input (see tasks.runStep's `answer` handling) the moment it's queued. The open
// tab's kick loop (client/App.tsx) drains queued/executing work within seconds; cron covers it offline.
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to run steps." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : undefined;
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (!task || !task.steps?.[index]) { res.status(404).json({ error: "Step not found — it may have already changed elsewhere." }); return; }
  try {
    const job = await enqueueJob(req.session.user!, "execute_step", id, { index, ...(answer ? { answer } : {}) });
    if (job.type !== "execute_step") { res.status(409).json({ error: "Otto is still working on this task — try again in a moment." }); return; }
    if (!isInFlight(task.status)) task.status = "queued";
    task.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(task);
  } catch (e: any) { res.status(500).json({ error: e?.message || "run failed" }); }
});
// Mark a step done/undone (a manual step the user did, or after the client opened a URL step).
app.post("/api/tasks/:id/step/:index/done", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  try {
    const id = String(req.params.id);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) { res.status(400).json({ error: "Invalid step index." }); return; }
    const done = req.body?.done !== false;
    const result = typeof req.body?.result === "string" ? req.body.result : undefined;
    const task = await findTaskOrReload(req, id);
    const step = task?.steps?.[index];
    if (!task || !step) { res.status(404).json({ error: "Step not found — it may have already changed elsewhere." }); return; }
    step.done = done;
    step.doneAt = done ? new Date().toISOString() : undefined;
    if (result !== undefined) step.result = result;
    task.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't update the step — try again." }); }
});
// Record one flashcard review — advances/resets its Leitner box and schedules the next `dueAt` (see
// nextLeitnerReview in shared/types.ts). Deterministic, no AI call. This is what turns flashcard decks from
// a one-shot artifact into genuine spaced repetition — see also GET /api/reviews/due below.
app.post("/api/tasks/:id/flashcard/:deckId/:cardIndex/review", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
  const id = String(req.params.id);
  const deckId = String(req.params.deckId);
  const cardIndex = Number(req.params.cardIndex);
  const correct = req.body?.correct !== false;
  const task = await findTaskOrReload(req, id);
  const deck = task?.flashcards?.find((d) => d.id === deckId);
  const card = deck?.cards?.[cardIndex];
  if (!task || !card) { res.status(404).json({ error: "Card not found — it may have already changed elsewhere." }); return; }
  const prev = card.review;
  const { box, dueAt } = nextLeitnerReview(prev?.box, correct);
  card.review = { seen: (prev?.seen || 0) + 1, correct: (prev?.correct || 0) + (correct ? 1 : 0), lastAt: new Date().toISOString(), dueAt, box };
  deck!.lastReviewedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  await commit(req);
  res.json(req.session.tasks || []);
}));
// Record one quiz attempt (a full pass through the quiz, not per-question) — mirrors the flashcard review
// route above: deterministic, no AI call, just persists the score so it survives closing the popup. Capped
// at 20 attempts, newest last (TaskQuiz.attempts was already reserved for this — see shared/types.ts).
const QUIZ_ATTEMPT_CAP = 20;
app.post("/api/tasks/:id/quiz/:quizId/attempt", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
  const id = String(req.params.id);
  const quizId = String(req.params.quizId);
  const total = Number(req.body?.total);
  const score = Number(req.body?.score);
  const wrong = Array.isArray(req.body?.wrong) ? req.body.wrong.filter((n: any) => Number.isInteger(n)).slice(0, 50) : undefined;
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(score) || score < 0 || score > total) { res.status(400).json({ error: "Invalid score." }); return; }
  const task = await findTaskOrReload(req, id);
  const quiz = task?.quizzes?.find((q) => q.id === quizId);
  if (!task || !quiz) { res.status(404).json({ error: "Quiz not found — it may have already changed elsewhere." }); return; }
  quiz.attempts = [...(quiz.attempts || []), { at: new Date().toISOString(), score, total, ...(wrong?.length ? { wrong } : {}) }].slice(-QUIZ_ATTEMPT_CAP);
  task.updatedAt = new Date().toISOString();
  await commit(req);
  res.json(req.session.tasks || []);
}));
// Check a typed answer against a daily practice problem (see DailyPracticeProblem/practiceAnswerMatches in
// shared/types.ts) — deterministic, no AI call, same "instant, no round-trip surprise" posture as the
// flashcard/quiz recording routes above. The comparison itself (loose but not fuzzy — formatting-tolerant,
// not answer-tolerant) lives in shared/types.ts so client and server can never disagree about what counts
// as correct.
app.post("/api/tasks/:id/practice-problem/attempt", requireAuth, rateLimit(200, 60_000), ah(async (req, res) => {
  const id = String(req.params.id);
  const answer = String(req.body?.answer || "").trim().slice(0, 200);
  if (!answer) { res.status(400).json({ error: "Type an answer first." }); return; }
  const task = await findTaskOrReload(req, id);
  const problem = task?.practiceProblem;
  if (!task || !problem) { res.status(404).json({ error: "Practice problem not found — it may have already changed elsewhere." }); return; }
  const correct = practiceAnswerMatches(answer, problem.answer);
  problem.attempt = { answer, correct, at: new Date().toISOString() };
  task.updatedAt = new Date().toISOString();
  await commit(req);
  res.json(req.session.tasks || []);
}));
// Cards due for review RIGHT NOW, across every task — not scoped to one deck's own view, since spaced
// repetition only actually compounds if the student can see everything due at a glance instead of having
// to reopen each task to check. Cheap enough to compute on every request (no AI, just a filter/sort).
app.get("/api/reviews/due", requireAuth, ah(async (req, res) => {
  const now = Date.now();
  const due: { taskId: string; taskTitle: string; deckId: string; deckTitle: string; cardIndex: number; front: string }[] = [];
  for (const t of req.session.tasks || []) {
    if (isHandled(t.status)) continue;
    for (const deck of t.flashcards || []) {
      deck.cards.forEach((c, i) => {
        // Never-reviewed cards aren't "due" — they're simply unreviewed; a fresh deck showing up in the
        // due list before the student has even seen it once would be confusing, not helpful.
        if (c.review?.dueAt && Date.parse(c.review.dueAt) <= now) due.push({ taskId: t.id, taskTitle: t.title, deckId: deck.id, deckTitle: deck.title, cardIndex: i, front: c.front });
      });
    }
  }
  res.json({ due: due.slice(0, 60) });
}));

// ── Study log: daily "what I learned today" → auto flashcards, + a week-end summary deck ──────────────
// Each entry is modeled as a WebTask with source:"studylog" — reuses the existing flashcard-deck type,
// the FlashcardDeck review UI, and (crucially) the Leitner spaced-repetition schedule + the cross-task
// /api/reviews/due view above, entirely for free. These tasks are excluded from the normal dashboard
// client-side (see App.tsx) — they're not to-dos. A real anchorKey (date-keyed) is essential here: without
// one, dedupeTasks' anchorless title-similarity fallback (see server/tasks.ts) could merge two DIFFERENT
// days' entries just for having similar-sounding titles — the anchor is what tells it these are distinct
// real-world items, the same guarantee a real Gmail/Calendar anchor gives an ordinary task.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Monday (YYYY-MM-DD) of the week containing `dateStr` — a simple, year-boundary-safe week key (avoids
// ISO week-numbering edge cases entirely) rather than a formal "2026-W35" string.
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}
function weekdayDates(monday: string): string[] {
  const d = new Date(`${monday}T00:00:00Z`);
  return Array.from({ length: 5 }, (_, i) => new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}
app.post("/api/studylog/day", requireAuth, rateLimit(20, 60_000), ah(async (req, res) => {
  const date = String(req.body?.date || "");
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!DATE_RE.test(date)) { res.status(400).json({ error: "Invalid date." }); return; }
  const list = req.session.tasks || [];
  const anchorKey = `studylog:${date}`;
  let t = list.find((x) => x.source === "studylog" && x.logDate === date);
  if (!text) {
    // Clearing an entry — keep the (now-empty) task shell rather than deleting, so re-typing later just
    // upserts the same anchor again instead of minting a fresh id.
    if (t) { t.logText = ""; t.flashcards = []; t.quizzes = []; t.practiceProblem = undefined; t.updatedAt = new Date().toISOString(); await commit(req); }
    res.json(req.session.tasks || []);
    return;
  }
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate flashcards." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const now = new Date().toISOString();
  if (!t) {
    const e = tasks.eisenhower(0, 0);
    t = {
      // `why` MUST embed the actual date — see the CRITICAL note at dedupeTasks/sameTask in server/tasks.ts:
      // a literal identical "Daily study log" for every single day meant sameTask()'s `source === source &&
      // nearDup(why, why)` fallback matched EVERY pair of studylog day tasks (different anchors, but that
      // fallback is only skipped for handled/manual tasks — a live "needs_review" day task hits it every
      // time). dedupeTasks runs inside mergeTaskLists, which fires on every commit()'s background cloud
      // sync — so this was silently collapsing DIFFERENT days' entries into one on essentially every save,
      // which is what made a day's flashcards look like they'd never been saved at all after a reload.
      id: randomUUID(), title: date, why: `Daily study log — ${date}`, source: "studylog", risk: "low",
      // status "needs_review" (never "done"/"dismissed"): GET /api/reviews/due (above) explicitly SKIPS
      // handled tasks (`if (isHandled(t.status)) continue`) — "done" would silently hide these decks from
      // the exact cross-task due-for-review view this feature was built to reuse. Not "ready" either: the
      // cron catch-all (tasksToEnqueue in jobs.ts) auto-enqueues plain "ready" tasks through the normal AI
      // agent run pipeline, which makes no sense for a studylog entry.
      urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
      createdAt: now, anchorKey, logDate: date,
    };
    list.push(t);
    req.session.tasks = list;
  }
  // Re-generate on a real edit, not on every save — the save button is a deliberate click (not per-
  // keystroke autosave), so re-running generation whenever the text actually CHANGED is the right call:
  // that's the only way editing a day's entry after its deck already exists can ever do anything. Only skip
  // regeneration when the text is genuinely UNCHANGED (a duplicate/no-op save) — that's the case that used
  // to be conflated with "already has a deck", which made editing a logged day's entry silently do nothing
  // ("saved" the identical deck, never picked up what was actually typed). A prior FAILED attempt
  // (flashcards still empty after a real try) also always retries, same as before.
  const textChanged = t.logText !== text;
  t.logText = text;
  if (t.flashcards?.length && !textChanged) {
    t.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(req.session.tasks || []);
    return;
  }
  try {
    const result = await generateDailyStudyCards(text, req.session.profile);
    if (result) addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
    t.flashcards = result ? [result.deck] : [];
    // No quiz from the daily call any more (see generateDailyStudyCards's own comment) — leave t.quizzes
    // untouched rather than clobbering it either way.
    t.title = result?.deck.title || date;
    // Separate, best-effort, math/physics/science-only call (see generateDailyPracticeProblem's own
    // comment on why this is never bundled into the deck call above) — a failure here never blocks the
    // flashcards the student is actually waiting on; it just means no practice problem for today.
    try {
      const pp = await generateDailyPracticeProblem(text, req.session.profile);
      if (pp) { addUsage(req.session.profile ||= emptyProfile(), pp.tokens, "studylog"); t.practiceProblem = pp.problem; }
      else t.practiceProblem = undefined;
    } catch { /* best-effort — flashcards above already succeeded regardless */ }
    t.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't make flashcards from that — try again." }); }
}));
app.get("/api/studylog/week", requireAuth, ah(async (req, res) => {
  const start = String(req.query.start || "");
  if (!DATE_RE.test(start)) { res.status(400).json({ error: "Invalid date." }); return; }
  const monday = mondayOf(start);
  const dates = weekdayDates(monday);
  const list = req.session.tasks || [];
  const days = dates.map((d) => list.find((x) => x.source === "studylog" && x.logDate === d) || null);
  const summary = list.find((x) => x.source === "studylog" && x.logDate === `week:${monday}`) || null;
  res.json({ monday, days, summary });
}));
app.post("/api/studylog/week-summary", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate the summary." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const weekStart = String(req.body?.weekStart || "");
  if (!DATE_RE.test(weekStart)) { res.status(400).json({ error: "Invalid date." }); return; }
  const monday = mondayOf(weekStart);
  const dates = weekdayDates(monday);
  const list = req.session.tasks || [];
  const dayTasks = dates.map((d) => list.find((x) => x.source === "studylog" && x.logDate === d)).filter((x): x is WebTask => !!x?.logText?.trim());
  if (!dayTasks.length) { res.status(400).json({ error: "No entries logged this week yet." }); return; }
  const boxBreakdown = tasks.leitnerBoxBreakdown(dayTasks);
  try {
    const result = await generateWeeklyStudyDeck(dayTasks.map((dt) => ({ date: dt.logDate!, logText: dt.logText! })), boxBreakdown, req.session.profile);
    if (!result) { res.status(500).json({ error: "Couldn't build the week summary — try again." }); return; }
    addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
    const deck = result.deck;
    const anchorKey = `studylog:week:${monday}`;
    const logDate = `week:${monday}`;
    let t = list.find((x) => x.source === "studylog" && x.logDate === logDate);
    const now = new Date().toISOString();
    if (!t) {
      const e = tasks.eisenhower(0, 0);
      t = {
        // `why` embeds the week so it can't collide with another week's summary via sameTask's nearDup(why)
        // fallback — see the CRITICAL note on the daily task above; the same bug applied here identically.
        id: randomUUID(), title: deck.title, why: `Weekly study summary — week of ${monday}`, source: "studylog", risk: "low",
        // status "needs_review" (never "done"/"dismissed"): GET /api/reviews/due (above) explicitly SKIPS
      // handled tasks (`if (isHandled(t.status)) continue`) — "done" would silently hide these decks from
      // the exact cross-task due-for-review view this feature was built to reuse. Not "ready" either: the
      // cron catch-all (tasksToEnqueue in jobs.ts) auto-enqueues plain "ready" tasks through the normal AI
      // agent run pipeline, which makes no sense for a studylog entry.
      urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
        createdAt: now, anchorKey, logDate,
      };
      list.push(t);
      req.session.tasks = list;
    }
    t.title = deck.title;
    t.flashcards = [deck];
    t.quizzes = result.quiz ? [result.quiz] : [];
    t.updatedAt = now;
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't build the week summary — try again." }); }
}));

// YYYY-MM of the month containing `dateStr` — used to group weekly decks (keyed by their Monday) into a
// month-end summary without any formal calendar-month task list of its own.
function monthOf(dateStr: string): string { return dateStr.slice(0, 7); }
app.get("/api/studylog/month", requireAuth, ah(async (req, res) => {
  const start = String(req.query.start || "");
  if (!DATE_RE.test(start)) { res.status(400).json({ error: "Invalid date." }); return; }
  const month = monthOf(start);
  const list = req.session.tasks || [];
  const weeks = list.filter((x) => x.source === "studylog" && x.logDate?.startsWith("week:") && monthOf(x.logDate.slice(5)) === month)
    .sort((a, b) => a.logDate!.localeCompare(b.logDate!));
  const summary = list.find((x) => x.source === "studylog" && x.logDate === `month:${month}`) || null;
  res.json({ month, weeks, summary });
}));
app.post("/api/studylog/month-summary", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate the summary." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
  const monthStart = String(req.body?.monthStart || "");
  if (!DATE_RE.test(monthStart)) { res.status(400).json({ error: "Invalid date." }); return; }
  const month = monthOf(monthStart);
  const list = req.session.tasks || [];
  const weekTasks = list.filter((x) => x.source === "studylog" && x.logDate?.startsWith("week:") && monthOf(x.logDate.slice(5)) === month && x.flashcards?.length);
  if (!weekTasks.length) { res.status(400).json({ error: "No weekly summaries yet this month." }); return; }
  const boxBreakdown = tasks.leitnerBoxBreakdown(weekTasks);
  try {
    const result = await generateMonthlyStudyDeck(
      weekTasks.map((wt) => ({ label: wt.logDate!.slice(5), cards: (wt.flashcards![0]?.cards || []).map((c) => ({ front: c.front, back: c.back })) })),
      boxBreakdown, req.session.profile,
    );
    if (!result) { res.status(500).json({ error: "Couldn't build the month summary — try again." }); return; }
    addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
    const deck = result.deck;
    const anchorKey = `studylog:month:${month}`;
    const logDate = `month:${month}`;
    let t = list.find((x) => x.source === "studylog" && x.logDate === logDate);
    const now = new Date().toISOString();
    if (!t) {
      const e = tasks.eisenhower(0, 0);
      t = {
        // `why` embeds the month, same fix and same reason as the daily/weekly tasks above.
        id: randomUUID(), title: deck.title, why: `Monthly study summary — ${month}`, source: "studylog", risk: "low",
        urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
        createdAt: now, anchorKey, logDate,
      };
      list.push(t);
      req.session.tasks = list;
    }
    t.title = deck.title;
    t.flashcards = [deck];
    t.quizzes = result.quiz ? [result.quiz] : [];
    t.updatedAt = now;
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't build the month summary — try again." }); }
}));

// A "just let me start studying" entry point — the full StudyMode workspace (StudyMode.tsx) is built
// around a WebTask (chat/notes/artifacts all key off task.id server-side), so a session not tied to any
// real to-do still needs a lightweight placeholder task to attach to. Client only calls this once, when
// "Enter study mode" is actually clicked on the /study landing page (see StandaloneStudyEntry in App.tsx) —
// never on every render — so this call IS the session boundary. A FRESH task is minted every time rather
// than resuming the last one: any previous unhandled freestudy task is dismissed here, taking its chat
// (task.chat lives on the task itself) with it, so one free session's conversation never bleeds into the
// next. (StudyMode's own client-side environment/artifacts, in IndexedDB keyed by the old task's id, are
// simply orphaned — same as any other completed task's leftover StudyDB entry, nothing new to clean up.)
// No AI call, no refine pass, no quadrant weight — this is intentionally NOT a real to-do, just a peg for
// StudyMode's own persistence for the DURATION of one session.
app.post("/api/study/free", requireAuth, rateLimit(20, 60_000), ah(async (req, res) => {
  const list = req.session.tasks || [];
  const now = new Date().toISOString();
  for (const old of list) {
    if (old.source === "freestudy" && !isHandled(old.status)) { old.status = "dismissed"; old.updatedAt = now; }
  }
  const en = req.session.profile?.language === "en";
  const e = tasks.eisenhower(0, 0);
  const id = randomUUID();
  const t: WebTask = {
    id, title: en ? "Free study session" : "Séance de révision libre",
    why: en ? "Started on demand, not tied to a task." : "Lancée à la demande, sans tâche associée.",
    source: "freestudy", risk: "low",
    urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
    createdAt: now, anchorKey: `freestudy:${id}`,
  };
  list.push(t);
  req.session.tasks = list;
  await commit(req);
  res.json(req.session.tasks || []);
}));

// Break ONE step down into its own small checklist ("Détailler cette étape") — on demand, not automatic.
// Costs one AI call, so it's gated the same as any other interactive AI action (paused/budget).
app.post("/api/tasks/:id/step/:index/expand", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to use this." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't set up on this server yet." }); return; }
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (!task || !step) { res.status(404).json({ error: "not found" }); return; }
  try {
    const substeps = await expandStep({ title: task.title, why: task.why }, { text: step.text }, req.session.profile, task.links);
    if (substeps.length) {
      step.substeps = substeps;
      task.updatedAt = new Date().toISOString();
      await commit(req);
    }
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't break this step down — try again." }); }
});
// Tick/untick one sub-step — independent of the parent step's own "done" (see the Profile.grades-style
// comment on TaskStep.substeps: a working checklist, not a completion gate).
app.post("/api/tasks/:id/step/:index/substep/:subIndex/done", requireAuth, rateLimit(120, 60_000), async (req, res) => {
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const subIndex = Number(req.params.subIndex);
  const done = req.body?.done !== false;
  const task = (req.session.tasks || []).find((t) => t.id === id);
  const sub = task?.steps?.[index]?.substeps?.[subIndex];
  // Was a silent no-op on a bad id/index — still 200'd with the unchanged list, indistinguishable from
  // success. Every sibling route (confirm/dismiss/step-done) already 404s on a missing target; this one
  // was missed.
  if (!task || !sub) { res.status(404).json({ error: "Sub-step not found — it may have already changed elsewhere." }); return; }
  try {
    sub.done = done;
    task.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save this sub-step — try again." }); }
});
// Let Otto just answer an automatable sub-action (see expandStep's `automatable` classification) instead
// of the student having to look it up themselves — a read-only web search + synthesis, no permissioned
// tools needed, so it runs inline here rather than through the job queue.
app.post("/api/tasks/:id/step/:index/substep/:subIndex/run", requireAuth, rateLimit(20, 60_000), async (req, res) => {
  if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to use this." }); return; }
  if (overInteractive(req)) { res.status(402).json({ error: BUDGET_MSG }); return; }
  if (!aiReady()) { res.status(503).json({ error: "AI isn't set up on this server yet." }); return; }
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const subIndex = Number(req.params.subIndex);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  const step = task?.steps?.[index];
  const sub = step?.substeps?.[subIndex];
  if (!task || !step || !sub) { res.status(404).json({ error: "Sub-step not found — it may have already changed elsewhere." }); return; }
  if (!sub.automatable) { res.status(400).json({ error: "This one isn't something Otto can do for you." }); return; }
  try {
    sub.result = await runSubstep({ title: task.title, why: task.why }, { text: step.text }, { text: sub.text }, req.session.profile);
    sub.done = true;
    task.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Otto n'a pas réussi à répondre." }); }
});
// "Move to a lighter day" from the workload widget — a manual, reversible nudge (never AI-driven): the
// student picks the day, Otto just relabels the task's own `when` and re-scores it, same deadline-urgency
// math every other task already goes through (tasks.applyDeadlineUrgency). Only meant for tasks with a
// soft/inferred `when` — a task with a real Pronote-sourced deadline isn't something to reschedule here.
app.post("/api/tasks/:id/reschedule", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  const id = String(req.params.id);
  const when = String(req.body?.when || "").trim();
  if (!when || Number.isNaN(Date.parse(when))) { res.status(400).json({ error: "a valid date is required" }); return; }
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (!task) { res.status(404).json({ error: "not found" }); return; }
  // The workload widget only ever offers this for a LIVE task (computeWorkload skips handled ones entirely)
  // — but re-check server-side rather than trusting the client: a done/dismissed task has nothing left to
  // move, and silently re-dating one would make it look active again.
  if (isHandled(task.status)) { res.status(409).json({ error: "This task is already done or dismissed — nothing to move." }); return; }
  // This route only exists for the workload widget's "move to a lighter day" nudge — which only ever
  // offers it for a task with NO stated deadline (see movable in server/workload.ts). Re-check here too:
  // a task that already states a real deadline must never have it silently overwritten by a "which day is
  // lighter" heuristic, whether the client is right or not.
  if (task.when?.trim()) { res.status(409).json({ error: "This task already has a deadline — it can't be moved." }); return; }
  try {
    task.when = when;
    task.updatedAt = new Date().toISOString();
    tasks.applyDeadlineUrgency([task]);
    await commit(req);
    res.json(req.session.tasks || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't move that task — try again." }); }
});

// One-click send: fire a reviewed Gmail draft / composed Slack message — USER-confirmed, the ONLY send path.
// The one route in the app with a real, irreversible EXTERNAL side effect per call (an actual email/message
// leaves the student's real account) — rate-limited so a compromised session or a buggy client retry loop
// can't spam-send, unlike this session's other task-mutation routes which are just local state.
app.post("/api/tasks/:id/send/:index", requireAuth, rateLimit(10, 60_000), async (req, res) => {
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  const s = t?.sendables?.[Number(req.params.index)];
  if (!t || !s) { res.status(404).json({ error: "not found" }); return; }
  try {
    if (!s.sent) {
      const r = await integrations.sendSendable(req.session.user!, s, req.session.profile?.primaryAccounts);
      if (!r.ok) { res.status(500).json({ error: r.error || "send failed" }); return; }
      s.sent = true;
      t.updatedAt = new Date().toISOString();
      await commit(req);
      void recordEvent(req.session.user!, "sent", { taskId: t.id, message: `${s.label}${s.to ? ` → ${s.to}` : ""}` });
    }
    res.json(t);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't send — try again." }); }
});
// Manual edit of an unsent draft — the user typing directly into the draft box, not an AI rewrite (that's
// /revise). For Gmail this pushes the edit to the REAL draft (GMAIL_SEND_DRAFT sends whatever's live in
// Gmail, not our local copy); Slack has no server-side draft, so the local text IS what gets posted.
app.post("/api/tasks/:id/sendable/:index/edit", requireAuth, rateLimit(30, 60_000), async (req, res) => {
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  const s = t?.sendables?.[Number(req.params.index)];
  if (!t || !s) { res.status(404).json({ error: "not found" }); return; }
  if (s.sent) { res.status(400).json({ error: "already sent" }); return; }
  const subject = typeof req.body?.subject === "string" ? req.body.subject.slice(0, 300) : undefined;
  const body = typeof req.body?.body === "string" ? req.body.body.slice(0, 20_000) : undefined;
  try {
    if (s.app === "gmail" && s.draftId) {
      const r = await integrations.updateGmailDraft(req.session.user!, s.draftId, { subject, body, to: s.to });
      if (!r.ok) { res.status(500).json({ error: r.error || "couldn't save your edit to the draft" }); return; }
      if (subject !== undefined) s.subject = subject;
      if (body !== undefined) s.body = body;
    } else { res.status(400).json({ error: "this draft can't be edited here" }); return; }
    t.updatedAt = new Date().toISOString();
    await commit(req);
    res.json(t);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save your edit — try again." }); }
});

// ── Jobs + timeline (the durable execution layer's public surface) ────────────
app.get("/api/jobs/:id", requireAuth, ah(async (req, res) => {
  const job = await getJob(String(req.params.id), req.session.user!);
  if (!job) { res.status(404).json({ error: "not found" }); return; }
  res.json({ id: job.id, type: job.type, status: job.status, taskId: job.task_id, attempts: job.attempt_count, error: job.last_error, createdAt: job.created_at, finishedAt: job.finished_at });
}));
app.get("/api/tasks/:id/events", requireAuth, ah(async (req, res) => {
  res.json(await eventsForTask(req.session.user!, String(req.params.id)));
}));
// Client-driven drain "kick": while any of the user's jobs are queued (e.g. execution queued by a sweep),
// the OPEN client kicks one job at a time so online users see work happen within seconds, not at the next
// cron tick. Each kick is one bounded function invocation — serverless-friendly.
app.post("/api/jobs/kick", requireAuth, rateLimit(60, 60_000), async (req, res) => {
  try {
    // MUST scope to this account — an unscoped drain() claims the GLOBAL oldest queued job across every
    // user (claimJob's `userEmail` param is exactly how the cron avoids one heavy account starving everyone
    // else; leaving it off here inverts that into "everyone's kick can starve their OWN job"). With more than
    // one active account, a user's own newly-queued task could sit behind other accounts' jobs indefinitely,
    // even with the tab open and kicking every 4s — this was reported live as "task constantly queued,
    // never executed" for a task that only ran ~20 minutes later, once its OWN turn came up in the global
    // queue instead of the very next kick.
    const out = await jobs.drain(1, undefined, req.session.user!);
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

// Background drain — called by Vercel Cron (Authorization: Bearer $CRON_SECRET) once a day (vercel.json;
// Vercel's Hobby plan only permits daily cron — Pro allows tighter schedules if that's ever worth the
// upgrade). This is what makes Otto work with every browser closed: sweeps due accounts, executes ready
// tasks, retries failed jobs, all through the same durable queue the interactive routes use. Since a day
// is a long gap, the INTERACTIVE routes are the real safety net the rest of the time — enqueueAndDrain
// (jobs.ts) retries a claim on every manual refresh/action even when a job is stuck at "running" with an
// expired lock (a worker killed mid-run by the platform's execution-time limit), not just when "queued".
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
    const tz = tzOf(profile);
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
      // Month-to-date spend BY WHAT SPENT IT (sweep/autorun/chat/manual_refine) — added so "what's actually
      // costing money" is an answerable question instead of one opaque total (see addUsage's own comment).
      byCategory: u?.monthByCategory || {},
    });
  } catch (e: any) { res.status(500).json({ error: e?.message || "usage failed" }); }
});

// ── Profile (who the user is) — available once logged in ───────────────────────
const listKey = (c: string) => (c === "preference" ? "preferences" : c === "person" ? "people" : c === "project" ? "projects" : c === "course" ? "courses" : "");
app.get("/api/profile", requireAuth, (req, res) => { res.json(req.session.profile || emptyProfile()); });
app.post("/api/profile", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    const category = String(req.body?.category || "");
    const value = String(req.body?.value || "").trim();
    if (category === "name") { p.name = value.slice(0, 60) || undefined; }
    else if (category === "about") { p.about = value.slice(0, 400); }
    else {
      const k = listKey(category);
      if (!k) { res.status(400).json({ error: `Unknown profile category "${category}".` }); return; }
      if (value && !(p as any)[k].some((x: string) => x.toLowerCase() === value.toLowerCase())) (p as any)[k].push(value.slice(0, 160));
    }
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save — try again." }); }
});
app.post("/api/profile/preference", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    const key = String(req.body?.key || "");
    const value = req.body?.value;
    // Every branch below except primaryAccount (a per-app map, merged by union — see mergeProfileStates)
    // stamps preferencesUpdatedAt: without it, a stale session on another device/tab committing ANYTHING
    // unrelated could silently overwrite a setting just changed here — see preferencesUpdatedAt's doc
    // comment in shared/types.ts for the full "settings aren't the same everywhere" failure mode this fixes.
    if (key === "responseStyle" && ["concise", "detailed", "casual", "formal"].includes(value)) {
      p.responseStyle = value; p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "autoApprove" && Array.isArray(value)) {
      p.autoApprove = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "genPerDay") {
      p.genPerDay = Math.min(4, Math.max(1, Math.round(Number(value) || 1))); p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "timezone" && typeof value === "string" && isValidTz(value)) {
      p.timezone = value; p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "highPriorityPeople" && Array.isArray(value)) {
      p.highPriorityPeople = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "autoArchivePatterns" && Array.isArray(value)) {
      p.autoArchivePatterns = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "primaryAccount" && value && typeof value === "object" && typeof value.app === "string" && typeof value.accountId === "string"
      // Defense-in-depth: value.app is attacker-controlled and becomes an object key below. Not currently
      // exploitable (accountId is constrained to a string, and assigning a string through the __proto__
      // setter is a documented no-op), but an explicit denylist means it can never become exploitable if
      // that value-type constraint ever loosens.
      && !["__proto__", "constructor", "prototype"].includes(value.app)) {
      // Which connected account a multi-account app (Gmail, Calendar, Docs…) defaults to when a task isn't
      // tied to a specific one (a manual task, a brand-new doc) — see integrations.getAgentTools. No stamp
      // needed: mergeProfileStates unions this per-app map instead of picking one side wholesale.
      (p.primaryAccounts ||= {})[value.app] = value.accountId;
    } else if (key === "language" && (value === "fr" || value === "en")) {
      p.language = value;
      p.languageSetAt = new Date().toISOString();
    } else if (key === "track" && ["ib", "bac", "other"].includes(value)) {
      p.track = value; p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "yearLevel" && typeof value === "string" && value.trim()) {
      p.yearLevel = value.trim().slice(0, 40); p.preferencesUpdatedAt = new Date().toISOString();
    } else if (key === "voiceChat" && typeof value === "boolean") {
      p.voiceChat = value; p.preferencesUpdatedAt = new Date().toISOString();
    } else {
      // Every recognized key/value combo is handled above — anything else used to fall through to a
      // silent no-op 200 (profile committed unchanged, client reads back success). A typo'd key or an
      // out-of-range value should say so, not look like it saved.
      res.status(400).json({ error: `Unrecognized preference "${key}" or invalid value.` });
      return;
    }
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save — try again." }); }
});
// Per-subject grades — self-reported (Pronote's read API doesn't expose grades), so Otto can weigh which
// subject actually needs attention, not just what's due soonest. Upsert by subject name (case-insensitive).
// A manually-logged grade always APPENDS a new entry — never overwrites a same-subject one. Unlike the
// Pronote sync (which writes "the current average as of now", one row per subject), a hand-entered grade
// is a specific test/assignment score the student is choosing to keep a record of, so history matters.
app.post("/api/profile/grade", requireAuth, ah(async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const subject = String(req.body?.subject || "").trim().slice(0, 60);
  const grade = Number(req.body?.grade);
  const scale = Number(req.body?.scale) > 0 ? Number(req.body.scale) : 20;
  if (!subject || !Number.isFinite(grade)) { res.status(400).json({ error: "subject and grade are required" }); return; }
  const list = (p.grades ||= []);
  list.push({ id: randomUUID(), subject, grade: Math.max(0, Math.min(scale, grade)), scale, updatedAt: new Date().toISOString(), source: "manual" });
  await commit(req);
  res.json(p);
}));
// Delete ONE grade entry by id (the normal path from the UI's per-row × ). Falls back to matching by
// subject for anything still lacking an id (a pre-history-model entry that never got normalized) or for
// a bulk "remove this whole subject" — same param, whichever matches.
app.delete("/api/profile/grade/:key", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    const key = decodeURIComponent(String(req.params.key || ""));
    const list = p.grades || [];
    p.grades = list.some((g) => g.id === key) ? list.filter((g) => g.id !== key) : list.filter((g) => g.subject.toLowerCase() !== key.toLowerCase());
    // commit()'s cross-device merge unions this list with whatever's still in the cloud copy — a plain
    // remove-then-commit would have the deleted grade resurface (the cloud copy doesn't know it was removed,
    // same tombstone-less limitation as the preference/people/project lists). Persist the deletion to cloud
    // directly FIRST, so by the time commit() reloads "current" for the merge, it already reflects the delete.
    if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't delete that grade — try again." }); }
});
// Manually-logged exams/deadlines — the Pronote-less equivalent of Pronote's test list (server/pronote.ts),
// for a student whose school doesn't use it at all (most IB/international schools). Merged into the SAME
// data ExamCountdown/computeWorkload already consume — see GET /api/pronote/tests and /api/workload below —
// so a manual-entry student gets the identical exam-countdown/workload experience a Pronote student does.
app.post("/api/profile/exam", requireAuth, ah(async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const subject = String(req.body?.subject || "").trim().slice(0, 60);
  const deadline = String(req.body?.deadline || "");
  if (!subject || !/^\d{4}-\d{2}-\d{2}/.test(deadline)) { res.status(400).json({ error: "subject and a real deadline are required" }); return; }
  const list = (p.manualExams ||= []);
  list.push({ id: randomUUID(), subject, deadline });
  await commit(req);
  res.json(p);
}));
app.delete("/api/profile/exam/:id", requireAuth, async (req, res) => {
  try {
    const p = (req.session.profile ||= emptyProfile());
    const id = decodeURIComponent(String(req.params.id || ""));
    p.manualExams = (p.manualExams || []).filter((e) => e.id !== id);
    // Same tombstone-less-merge reasoning as the grade delete above — persist the delete to cloud FIRST.
    if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't remove that exam — try again." }); }
});
// Wipe everything Otto has learned (restart from zero memory). The agent rebuilds it over time via `remember`.
app.delete("/api/profile", requireAuth, async (req, res) => {
  try {
    req.session.profile = emptyProfile();
    await commit(req);
    res.json(req.session.profile);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't reset your profile — try again." }); }
});
app.delete("/api/profile/:category/:index", requireAuth, async (req, res) => {
  const p = (req.session.profile ||= emptyProfile());
  const k = listKey(String(req.params.category));
  const i = Number(String(req.params.index));
  // Was a silent no-op on a bad category/out-of-range index — still 200'd with the unchanged profile,
  // indistinguishable from success (same anti-pattern already fixed on the task routes).
  if (!k || !Array.isArray((p as any)[k]) || !(i >= 0 && i < (p as any)[k].length)) {
    res.status(404).json({ error: "Nothing to delete there — it may have already changed elsewhere." }); return;
  }
  try {
    (p as any)[k].splice(i, 1);
    await commit(req);
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't delete that — try again." }); }
});

// ── Study Mode ─────────────────────────────────────────────────────────────
// Get study session history
app.get("/api/study/sessions", requireAuth, async (req, res) => {
  try {
    if (req.session.user && cloudEnabled()) {
      const cloud = await loadState(req.session.user);
      req.session.studySessions = cloud.studySessions || [];
    }
    res.json(req.session.studySessions || []);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't load study sessions." }); }
});

// Create/save a study session
app.post("/api/study/session", requireAuth, async (req, res) => {
  try {
    const sessionData = req.body as Partial<StudySession>;
    if (!sessionData.taskId || !sessionData.userId) {
      res.status(400).json({ error: "taskId and userId are required" });
      return;
    }
    
    const sessions = (req.session.studySessions ||= []);
    const existingIndex = sessions.findIndex((s) => s.id === sessionData.id);
    
    const session: StudySession = {
      id: sessionData.id || randomUUID(),
      taskId: sessionData.taskId,
      userId: sessionData.userId,
      startTime: sessionData.startTime || new Date().toISOString(),
      endTime: sessionData.endTime,
      plannedDuration: sessionData.plannedDuration || 45,
      actualDuration: sessionData.actualDuration,
      state: sessionData.state || "idle",
      reflection: sessionData.reflection,
      interruptionCount: sessionData.interruptionCount || 0,
      notes: sessionData.notes,
      completedSteps: sessionData.completedSteps,
      createdAt: sessionData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    if (existingIndex >= 0) {
      sessions[existingIndex] = session;
    } else {
      sessions.push(session);
    }
    
    // Keep only last 100 sessions
    if (sessions.length > 100) {
      req.session.studySessions = sessions.slice(-100);
    }
    
    await commit(req);
    res.json(session);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save study session." }); }
});

// Get study profile
app.get("/api/study/profile", requireAuth, async (req, res) => {
  try {
    if (req.session.user && cloudEnabled()) {
      const cloud = await loadState(req.session.user);
      req.session.studyProfile = cloud.studyProfile;
    }
    res.json(req.session.studyProfile || { userId: req.session.user, updatedAt: new Date().toISOString() });
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't load study profile." }); }
});

// Update study profile
app.post("/api/study/profile", requireAuth, async (req, res) => {
  try {
    const profileData = req.body as Partial<StudyProfile>;
    const current = req.session.studyProfile || { userId: req.session.user, updatedAt: new Date().toISOString() };
    
    const updated: StudyProfile = {
      userId: current.userId || req.session.user || "",
      preferredSessionLength: profileData.preferredSessionLength,
      preferredBreakLength: profileData.preferredBreakLength,
      prefersPomodoro: profileData.prefersPomodoro,
      uninterruptedSessions: profileData.uninterruptedSessions,
      preferredStartTimes: profileData.preferredStartTimes,
      theme: profileData.theme,
      timerStyle: profileData.timerStyle,
      showTimer: profileData.showTimer,
      showSidebar: profileData.showSidebar,
      animationLevel: profileData.animationLevel,
      audioType: profileData.audioType,
      audioBySubject: profileData.audioBySubject,
      volume: profileData.volume,
      notesPosition: profileData.notesPosition,
      materialsPosition: profileData.materialsPosition,
      aiVisibility: profileData.aiVisibility,
      focusLevel: profileData.focusLevel,
      sessionHistory: profileData.sessionHistory,
      updatedAt: new Date().toISOString(),
    };
    
    req.session.studyProfile = updated;
    await commit(req);
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e?.message || "Couldn't save study profile." }); }
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
  if (status >= 500) { console.error("[weave-web] request error:", err?.message || err); reportError("route-catchall", err); }
  if (res.headersSent) return;
  res.status(status).json({ error: status === 413 ? "Request body too large." : status === 400 ? "Malformed request body." : "Internal error." });
}) as express.ErrorRequestHandler);

// A single failing run must NEVER take down the server. An unhandled rejection/exception from a
// concurrent AI run (DeepSeek, googleapis, a tool reject) would otherwise crash the whole
// process — killing every in-flight /run with "socket hang up" so tasks never finish (no steps).
// Log and keep serving; the affected request already has its own try/catch and 500s on its own.
process.on("unhandledRejection", (reason) => { console.error("[weave-web] unhandledRejection:", reason); reportError("unhandledRejection", reason); });
process.on("uncaughtException", (err) => { console.error("[weave-web] uncaughtException:", err); reportError("uncaughtException", err); });

// On Vercel the app is exported and invoked per-request by the serverless wrapper (api/index.ts) —
// there is no long-lived listener. Everywhere else (local, Docker, Railway/Render/Fly) we listen.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[weave-web] listening on :${PORT} (${PROD ? "production" : "dev"})`));
}

export default app;
