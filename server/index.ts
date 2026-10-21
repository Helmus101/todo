
import "./env.ts";
import { initSentry, reportError } from "./sentry.ts";
import express from "express";
import compression from "compression";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { aiReady, visionReady } from "./claude.ts";
import { loadState, cloudEnabled, makeSessionStore } from "./store.ts";
import * as integrations from "./integrations.ts";
import * as pronoteSvc from "./pronote.ts";
import { PROD, ah, commit, isAdmin, scheduler, weeklyCap } from "./http.ts";
import { weeklyUsage } from "../shared/types.ts";
import { shouldAutoPause } from "./autoPause.ts";

/** Accounts that always see the whole app (the others get the tutor only, until they open /full). Comma-separated in FULL_APP_EMAILS. */
const FULL_APP_EMAILS = (process.env.FULL_APP_EMAILS || "phillipe@gafsi.net").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerIntegrationRoutes } from "./routes/integrations.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { registerProfileRoutes } from "./routes/profile.ts";
import { registerFeedbackRoutes } from "./routes/feedback.ts";
import { registerTutorRoutes } from "./routes/tutor.ts";
import { registerStudyRoutes } from "./routes/study.ts";

initSentry();

declare module "express-session" {
  interface SessionData {
    user?: string;        // the authenticated ACCOUNT email (everything keys off this; = Composio user_id)
    tasks?: WebTask[];
    profile?: Profile;
    integrations?: Record<string, string>; // app key → Composio connectionId hint (status is live from Composio)
    lastGenDay?: string;  // "YYYY-MM-DD" of the last full generate sweep — the once-a-day floor (survives serverless cold starts)
    lastGenTime?: string; // ISO timestamp of the last generation (for continuous monitoring)
    csrfToken?: string; // synchronizer-token CSRF defense — see requireAuth's own comment
    // Sticky per-session cache for the dashboard-ordering bandit arm (see ORDERING_ARMS in bandit.ts and
    // /api/tasks' own comment on the fix this backs) — Thompson Sampling draws a genuinely random sample
    // EVERY call by design, so without this the arm (and therefore the score nudge applied to every live
    // task) was being re-rolled on every single dashboard poll, visibly reshuffling near-tied tasks at
    // random. Cached per `key` (bandit.ts's contextKey — time-of-day/weekend/track bucket) so the arm stays
    // fixed for as long as that bucket does, only re-drawn when it actually changes (e.g. morning → afternoon).
    orderingArmCache?: { key: string; armId: string };
    blackbaudOAuthState?: string; // CSRF nonce for the Blackbaud OAuth authorization-code flow — see server/blackbaud.ts
    primerSessionStarts?: Record<string, number>; // Per-subject session start timestamps
    primerLastActivities?: Record<string, number>; // Per-subject last activity timestamps
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8788;

// Fail closed: required environment variables in production
if (PROD) {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set in production — it signs the session cookie that gates account access.");
  }
  // AI_PROVIDER=nvidia routes every AI call through NVIDIA's NIM endpoint instead (see claude.ts's own
  // AI_PROVIDER comment) — require whichever key that active choice actually needs, not always DeepSeek's,
  // so a deployment that's fully switched to NVIDIA (no DEEPSEEK_API_KEY set at all) doesn't fail to boot.
  const usingNvidia = (process.env.AI_PROVIDER || "").toLowerCase() === "nvidia";
  if (usingNvidia ? !process.env.NVIDIA_API_KEY : !process.env.DEEPSEEK_API_KEY) {
    throw new Error(usingNvidia
      ? "NVIDIA_API_KEY must be set in production when AI_PROVIDER=nvidia — required for AI task generation and execution."
      : "DEEPSEEK_API_KEY must be set in production — required for AI task generation and execution.");
  }
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY must be set in production — required for app integrations.");
  }
  if (!process.env.PUBLIC_URL) {
    throw new Error("PUBLIC_URL must be set in production — required for OAuth callbacks.");
  }
  // Serverless instances share nothing in memory: without the cloud store, sessions, CSRF tokens and rate limits would differ per instance
  // (students logged out at random, limits that don't hold). A single long-lived process may run without it.
  if (process.env.VERCEL && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in production on Vercel — sessions, CSRF and rate limits need the shared store.");
  }
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by"); // don't advertise the framework
// Vercel's Node serverless functions do NOT auto-gzip responses (confirmed live: /api/status came back
// with no content-encoding header even with Accept-Encoding: gzip sent) — unlike the static asset CDN,
// which does compress. Every JSON API response in this app was going out uncompressed, and several of the
// heaviest, most frequent ones (res.json(req.session.tasks) — the WHOLE task list, including every task's
// full chat history/steps/notes/decks — fire on nearly every click: reviewing one flashcard, answering one
// quiz question, ticking one step). This is the single highest-leverage fix for response egress: gzip
// typically cuts JSON payloads 70-85%, with zero behavior change for callers.
app.use(compression({ level: 4 })); // level 4: ~same size as the default 6 for JSON at noticeably less CPU
// Liveness probe for the host platform — no auth, no session, no DB; just "the process is up".
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
// Content-Security-Policy: scripts are self-only (the self-heal script is externalized, not inline);
// styles allow 'unsafe-inline' for React style={{}} attributes; images allow the Composio logo CDN + data:.
// On Vercel the static HTML is served by Vercel's layer (see vercel.json headers) — this covers the Express
// (Docker/self-host) path and every API response.
const CSP = [
  "default-src 'self'",
  // https://cdn.jsdelivr.net: MediaPipe's tasks-vision wasm loader (client-side face/presence tracking for
  // Study Mode's opt-in focus check) — connect-src below already allowed jsdelivr for the wasm binary fetch,
  // but the loader's own <script> tag was still being blocked since script-src didn't independently list it.
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "script-src-elem 'self' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  // https://fonts.googleapis.com: client/styles.css and client/lab.css both @import Inter/
  // Baskervville/Handlee/Newsreader from Google Fonts. The imported .woff2 files live on
  // fonts.gstatic.com (font-src below already allowed it), but the STYLESHEET fetch itself is governed
  // by style-src — missing here while vercel.json's copy of this CSP already listed it, so on the
  // self-hosted/Docker path (where THIS header is the one actually served) every page silently fell
  // back to a system font. Same class of drift as the font-src/connect-src fixes above.
  // Fonts are bundled (client/main.tsx): no request to Google Fonts, so no external stylesheet host is allowed.
  "style-src 'self' 'unsafe-inline'",
  // blob:: a student's uploaded image material (ImageArtifact.tsx) renders straight from a same-page
  // blob: URL (StudySetup's/StudyMode's upload flow, same origin as the PDF blob: already allowed under
  // frame-src below) — without this, EVERY uploaded image silently failed to render (CSP blocks it before
  // it ever reaches the app's own error handling, so it just looked like "this image doesn't work").
  "img-src 'self' data: blob: https://logos.composio.dev",
  // Study Mode's in-app dictionary artifact fetches these directly from the browser (client/study/artifacts/
  // DictionaryArtifact.tsx) — a strict 'self' here silently blocked every lookup with "Failed to fetch"
  // (CSP violations don't reach the app's own try/catch as an HTTP error; the browser just refuses the fetch).
  // https://*.ingest.*.sentry.io: client-side Sentry (main.tsx) reports errors straight from the browser —
  // this was missing here while vercel.json's copy of this CSP (the one actually served on Vercel) already
  // had it, so client error reporting was silently CSP-blocked on the self-hosted/Docker path only.
  "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com https://freedictionaryapi.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io https://cdn.jsdelivr.net https://storage.googleapis.com",
  // Study Mode embeds several things in iframes: a Spotify playlist/album/track widget (client/study/
  // spotify.ts, no OAuth needed), a Google Doc, a YouTube video, and — critically — the student's own
  // uploaded PDFs, which load from a same-page blob: URL (StudySetup's upload flow). Once frame-src is set
  // AT ALL it replaces the default-src 'self' fallback entirely rather than adding to it — setting it to
  // just the Spotify origin (as this first did) silently broke every other embed, including the student's
  // own files, with Chrome's generic "This content is blocked" — so 'self' and blob: must be listed here
  // explicitly, not assumed to still apply.
  // https://drive.google.com: a Drive FILE preview (e.g. a PDF/image uploaded to Drive rather than a
  // native Doc/Sheet/Slide) — DocumentArtifact.tsx converts a normal .../view share link to .../preview,
  // but the CSP still has to list the origin itself or the frame never even attempts to load.
  // Broadened to any https: origin (was a fixed allowlist: Spotify/Docs/Drive/YouTube/Desmos/Padlet
  // only) — DocumentArtifact.tsx now deliberately attempts to embed ANY http(s) URL a student pastes as a
  // study material, and the allowlist was silently defeating that: CSP blocks the iframe before it even
  // loads, no console error a student would notice, on every host not in the list (confirmed live: a
  // core-econ.org textbook page that sends no X-Frame-Options was STILL blocked by this CSP, not by the
  // page's own headers). The actual security backstop for arbitrary embedded content is the iframe's own
  // sandbox attribute (DocumentArtifact.tsx: allow-scripts + allow-forms + allow-popups, deliberately WITHOUT
  // allow-same-origin — a malicious page runs in an opaque origin, can't read/write Otto's cookies or DOM,
  // can't top-navigate the outer page) — CSP's job here is letting the browser attempt the load at all, not
  // re-doing the isolation the sandbox already provides. 'self'/blob: kept for the student's own uploaded
  // PDFs/images (same-page blob: URLs) and same-origin needs.
  "frame-src 'self' blob: https:",
  // data: — PDF.js (pdfjs-dist) embeds subsetted fonts as data: URIs when rendering PDFs in Study Mode;
  // without this, every rendered PDF page silently drops its text glyphs (CSP blocks the data: font before
  // it ever loads, no console error a student would notice — just "the PDF text looks wrong").
  // https://fonts.gstatic.com: Inter loads from Google Fonts' CSS (@import in client/styles.css) — the CSS
  // itself comes from fonts.googleapis.com (style-src) but the .woff2 files live on fonts.gstatic.com.
  // Missing here while vercel.json's copy of this CSP already had it: on the self-hosted/Docker path
  // (where THIS header is the one actually served) every page silently rendered in a fallback font.
  "font-src 'self' data:",
  // 'self' blob: data: — tutor speech (server/index.ts's /api/tts, Gemini TTS) reaches the client as a same-page
  // blob: URL handed to an <audio> element (useSpeechSynthesis.ts). Once ANY media-src is set it replaces
  // the default-src fallback entirely (same iframe-like override trap as frame-src above), so without this
  // directive every voice reply was blocked before a single byte decoded — no console error a student
  // would notice, just "the tutor doesn't talk" (the <audio> element's onerror path already blamed exactly
  // this line's absence). data: kept for any data:-URI audio the browser fallback may synthesize.
  "media-src 'self' blob: data:",
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
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
// Skips this tight global default for the handful of routes that declare their OWN larger limit further
// down (account import, whiteboard vision) — reported live as a 413 on a real 1.8MB account export despite
// that route's own `express.json({ limit: "20mb" })`. Root cause: Express runs body-parser middleware in
// REGISTRATION order, and a middleware that reads the request body can only do so once — this global
// parser ran FIRST on every request regardless of path, so for those two routes it was already rejecting
// (and consuming) the body before their own, later, bigger-limit parser ever got a chance to run. The
// larger per-route limit was dead code the whole time, not a real override. Keeping the global default
// tight (1mb is plenty for every other route — profile edits, chat messages, preferences) is deliberate:
// only the specific routes that genuinely need more get it, not every endpoint by default.
const LARGE_BODY_ROUTES = new Set(["/api/account/import", "/api/tutor/read-whiteboard", "/api/tutor/read-photo"]);
app.use((req, res, next) => {
  if (LARGE_BODY_ROUTES.has(req.path)) return next();
  express.json({ limit: "1mb" })(req, res, next);
});
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
// A recycled instance must not take the last few seconds of someone's work with it.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void scheduler.flushAll().finally(() => process.exit(0)); });
process.once("beforeExit", () => { void scheduler.flushAll(); });
registerAuthRoutes(app);
registerIntegrationRoutes(app);
registerTaskRoutes(app);

// ── Status ──────────────────────────────────────────────────────────────────
// googleConnected now means "Gmail is connected via Composio" (the minimum to generate tasks). Cached
// briefly so polling this hot endpoint doesn't hammer Composio.
app.get("/api/status", ah(async (req, res) => {
  // A week with open tasks and nothing checked off: AI pauses itself, and the next time they open the app they are asked to resume it.
  if (req.session.user && shouldAutoPause(req.session.tasks, req.session.profile)) {
    const p = req.session.profile!;
    p.paused = true; p.pausedAt = new Date().toISOString(); p.autoPausedAt = p.pausedAt;
    try { await commit(req); } catch { /* retried on the next status */ }
  }
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
      ? pronoteSvc.pronoteConnected(req.session.user).catch((): { connected: boolean; username?: string; needsReconnect?: boolean } => ({ connected: false }))
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
    visionReady: visionReady(),
    googleConfigured: integrations.integrationsReady(), // Composio is what powers Google + every integration now
    cloud: cloudEnabled(),
    paused: !!req.session.profile?.paused,
    weekly: req.session.user ? (() => { const w = weeklyUsage(req.session.profile, weeklyCap()); return { usd: Math.round(w.usd * 100) / 100, cap: w.cap, limit: w.limit, extra: w.extra, over: w.over && !isAdmin(req), requested: w.requested }; })() : undefined,
    autoPaused: !!req.session.profile?.paused && !!req.session.profile?.autoPausedAt,
    writeBehind: !process.env.VERCEL, // on Vercel every commit flushes immediately, so a tab-hide flush call is a wasted invocation
    highPriorityPeople: req.session.profile?.highPriorityPeople,
    genPerDay: req.session.profile?.genPerDay,
    timezone: req.session.profile?.timezone,
    language: "en",
    customTheme: req.session.profile?.customTheme,
    betaFeatures: !!req.session.profile?.betaFeatures,
    isAdmin: isAdmin(req),
    // THE TUTOR IS THE APP: every account lands on it and sees nothing else, except the owner account(s) and any account that opened /full once.
    fullApp: typeof req.session.profile?.fullAccess === "boolean" ? req.session.profile.fullAccess : FULL_APP_EMAILS.includes(String(req.session.user || "").toLowerCase()),
    home: (typeof req.session.profile?.fullAccess === "boolean" ? req.session.profile.fullAccess : FULL_APP_EMAILS.includes(String(req.session.user || "").toLowerCase())) ? "tasks" : "tutor",
    // "Onboarded" = finished/skipped the basic flow, OR an account that clearly predates it (has a name, a track or
    // tasks) — those are never put through name/track questions they've long answered. Page guides still run.
    onboarded: !!req.session.profile?.onboardedAt || !!req.session.profile?.name || !!req.session.profile?.track || (req.session.tasks || []).length > 0,
    toursSeen: req.session.profile?.toursSeen,
  };
  // Hand the CSRF synchronizer token to the client here — this is the ONE place it's ever transmitted (see
  // requireAuth's own comment). Generated lazily so an already-logged-in session picks one up on its next
  // status poll without needing to log out/in. Never exposed when logged out — nothing to protect yet.
  if (req.session.user) {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(24).toString("hex");
    s.csrfToken = req.session.csrfToken;
  }
  // ETag: hash the JSON payload so repeated polls within the same session cost 0 bytes when nothing changed.
  // The CSRF token is session-specific and already in the payload, so the hash is also user-specific.
  const statusJson = JSON.stringify(s);
  const etag = `"${createHash("sha1").update(statusJson).digest("hex").slice(0, 16)}"`;
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
  res.type("json").send(statusJson);
}));
registerProfileRoutes(app);
registerFeedbackRoutes(app);
registerTutorRoutes(app);
registerStudyRoutes(app);

// ── Static (production) ─────────────────────────────────────────────────────
// On Vercel the built client is served by Vercel's static layer (see vercel.json), not Express.
if (PROD && !process.env.VERCEL) {
  const dist = path.resolve(__dirname, "../dist");
  // Hashed build assets never change, so they cache for a year; everything else (index.html, the public pages) revalidates.
  app.use(express.static(dist, { setHeaders: (res, file) => { res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache"); } }));
  // The public pages have their own prerendered HTML (own title / canonical / content) — see scripts/prerender-landing.tsx.
  for (const page of ["research", "privacy", "terms"]) app.get(`/${page}`, (_req, res) => { res.sendFile(path.join(dist, `${page}.html`)); });
  app.get("/blog", (_req, res) => { res.sendFile(path.join(dist, "blog.html")); });
  app.get("/blog/:slug", (req, res) => {
    const slug = String(req.params.slug || "");
    if (!/^[a-z0-9-]+$/.test(slug)) { res.status(404).end(); return; }
    res.sendFile(path.join(dist, "blog", `${slug}.html`), (err) => { if (err) res.status(404).sendFile(path.join(dist, "index.html")); });
  });
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
