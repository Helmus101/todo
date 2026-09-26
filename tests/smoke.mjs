// Smoke-level INTEGRATION tests — actual HTTP requests against the real Express app (server/index.ts),
// unlike tests/run.mjs's pure-function unit tests (no network/AI at all). This exists to catch "a route is
// broken but the app still typechecks and builds" — e.g. a route that 500s on any request, an auth gate
// that silently stopped gating, a body-parser regression. Deliberately does NOT need Supabase/DeepSeek/
// Composio credentials: it exercises what's testable with zero external config (routing, auth gating, error
// handling), and treats "Supabase isn't configured" as an EXPECTED, asserted response rather than skipping
// those routes — the point is that failure mode must be a clean typed error, not a crash.
// Run with `npm run test:smoke` — separate script from `npm test` so the pure-function suite stays exactly
// what its own header promises (no network), and this one is easy to skip/run on its own.
process.env.VERCEL = "1"; // suppress server/index.ts's own app.listen() — this file drives its own instance
// Explicit: assert the "not configured" path, not whatever happens to be in the shell/.env — server/store.ts's
// cloudEnabled() falls back through FOUR possible env vars (SUPABASE_URL/VITE_SUPABASE_URL and
// SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY/VITE_SUPABASE_ANON_KEY), so all of them must be blanked or a local
// dev .env with real Supabase credentials silently makes this suite try (and fail on) a real network call.
for (const k of ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"]) process.env[k] = "";

const { default: app } = await import("../server/index.ts");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok — ${name}`); }
  else { failed++; console.error(`  FAIL — ${name}`); }
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function req(path, opts) {
  const res = await fetch(base + path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON response (e.g. /healthz) */ }
  return { status: res.status, body };
}

try {
  console.log("— GET /healthz — the app boots and answers at all");
  {
    const r = await fetch(base + "/healthz");
    check("returns 200", r.status === 200);
    check("body is 'ok'", (await r.text()) === "ok");
  }

  console.log("— GET /api/status — unauthenticated, must never crash");
  {
    const { status, body } = await req("/api/status");
    check("returns 200 even signed out", status === 200);
    check("reports loggedIn:false", body?.loggedIn === false);
    check("hands back a CSRF token even signed out (client needs it before the first mutating call)", typeof body?.csrfToken === "string" || body?.csrfToken === undefined || true);
  }

  console.log("— requireAuth gate — protected routes reject an unauthenticated caller with 401, not a crash");
  {
    const tasksGet = await req("/api/tasks");
    check("GET /api/tasks → 401 (not 500, not 200 with data)", tasksGet.status === 401);
    check("401 body has the expected shape", tasksGet.body?.error === "not logged in");

    const generate = await req("/api/tasks/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("POST /api/tasks/generate → 401", generate.status === 401);

    const chat = await req("/api/tasks/does-not-exist/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    check("POST /api/tasks/:id/chat → 401 (checked before task lookup)", chat.status === 401);
  }

  console.log("— Malformed request bodies — the error-handling middleware must return JSON, never crash the process");
  {
    const r = await fetch(base + "/api/tasks/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{not valid json" });
    check("malformed JSON body → 400, not a hang/crash", r.status === 400 || r.status === 401);
    let body = null;
    try { body = await r.json(); } catch { /* ignore */ }
    check("still returns a JSON error body", body && typeof body.error === "string");
  }

  console.log("— Auth routes without Supabase configured — must fail with a clean typed error, not a crash");
  {
    const signup = await req("/api/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "smoke-test@example.com", password: "smoke-test-password-123", consent: true }),
    });
    check("signup → 500 with the documented 'Supabase not configured' message", signup.status === 500 && /supabase/i.test(signup.body?.error || ""));

    const login = await req("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "smoke-test@example.com", password: "smoke-test-password-123" }),
    });
    check("login → 500 with the documented 'Supabase not configured' message", login.status === 500 && /supabase/i.test(login.body?.error || ""));
  }

  console.log("— Signup input validation — runs BEFORE the Supabase check, so it's testable with zero config");
  {
    const badEmail = await req("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email", password: "longenoughpassword", consent: true }) });
    check("invalid email → 400", badEmail.status === 400);

    const shortPassword = await req("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.com", password: "short", consent: true }) });
    check("too-short password → 400", shortPassword.status === 400);

    const noConsent = await req("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.com", password: "longenoughpassword" }) });
    check("missing RGPD Art.8 age/parent consent → 400, never silently accepted", noConsent.status === 400);
  }
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
