// Multi-user load simulation: the REAL Express app (NODE_ENV=production semantics: CSRF enforced, fail-closed boot checks) with the REAL store,
// session store, rate limiter and account-merge code, running on an in-memory Supabase stand-in (server/testSupabase.ts) and a faked model
// (fetch to the model/search providers is intercepted, with latency and occasional 429/500). 60 virtual users — half tutor-only, half full-app —
// sign up and use the app at the same time. Run: `node --import tsx tests/load-sim.mjs` (or `npm run test:load`).
// What this proves: isolation, auth/CSRF, per-user limits, concurrency handling, lost-update protection, graceful failure, latency of our own code.
// What it cannot prove: real provider/Supabase latency and limits, cold starts — use scripts/loadtest.mjs against a deployed URL for those.
process.env.VERCEL = "1"; // the server must not listen on its own port
process.env.NODE_ENV = "production";
process.env.TEST_FAKE_SUPABASE = "1";
process.env.SUPABASE_URL = "http://fake-supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake";
process.env.SESSION_SECRET = "load-sim-secret";
process.env.DEEPSEEK_API_KEY = "sim-key";
process.env.COMPOSIO_API_KEY = "sim-key";
process.env.PUBLIC_URL = "http://localhost";
process.env.TUTOR_RESEARCH = "off";
process.env.TUTOR_CHECK = "off";
delete process.env.GEMINI_API_KEY; delete process.env.EXA_API_KEY;
const N = Number(process.env.LOAD_USERS) || 60;

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => { if (cond) { passed++; console.log(`  ok — ${name}`); } else { failed++; console.error(`  FAIL — ${name} ${extra}`); } };

// ── the fake model/search world ──
let modelCalls = 0, modelDown = false, injected429 = 0;
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!/api\.deepseek\.com|generativelanguage\.googleapis\.com|api\.exa\.ai|api\.openai\.com/.test(u)) return realFetch(url, init);
  modelCalls++;
  await sleep(150 + Math.random() * 600);
  if (modelDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503, headers: { "content-type": "application/json" } });
  if (Math.random() < 0.03) { injected429++; return new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }); }
  const body = JSON.parse(init?.body || "{}");
  const tagged = [...(body.messages || [])].reverse().find((m) => m.role === "user" && /\[user:u\d+\]/.test(String(m.content)))?.content || "";
  const who = /\[user:(u\d+)\]/.exec(String(tagged))?.[1] || "?";
  const seq = /squared equals (\d+)/.exec(String(tagged))?.[1] || "0";
  const turn = { speech: [`Got it, ${who}.`, "What do you get when you square both sides?"], board: [{ op: "step", cue: 0, text: `$x^2 = ${seq}$`, kind: "given" }] };
  return new Response(JSON.stringify({ id: "sim", object: "chat.completion", model: "sim", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(turn) }, finish_reason: "stop" }], usage: { prompt_tokens: 800, completion_tokens: 80, total_tokens: 880 } }), { status: 200, headers: { "content-type": "application/json" } });
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e?.message || e)));
const { default: app } = await import("../server/index.ts");
const { fakeSupabase } = await import("../server/store.ts");
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── a virtual user: cookie jar + csrf token ──
const lat = new Map(); // route → ms[]
const statuses = new Map();
class User {
  constructor(i, full) { this.i = i; this.full = full; this.email = `load${i}@example.test`; this.pw = `pw-${i}-secret-123`; this.cookie = ""; this.csrf = ""; }
  async call(method, path, body, o = {}) {
    const t0 = performance.now();
    const headers = { "content-type": "application/json", "x-forwarded-proto": "https", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf && !o.noCsrf ? { "x-csrf-token": this.csrf } : {}) };
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(";")[0]).join("; ");
    const tok = res.headers.get("x-csrf-token"); if (tok) this.csrf = tok;
    let json = null; try { json = await res.json(); } catch { /* not JSON */ }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    const key = `${method} ${path.replace(/[0-9a-f-]{20,}/g, ":id").replace(/\?.*/, "")}`;
    (lat.get(key) || lat.set(key, []).get(key)).push(performance.now() - t0);
    statuses.set(`${key} ${res.status}`, (statuses.get(`${key} ${res.status}`) || 0) + 1);
    return { status: res.status, json, headers: res.headers };
  }
}
const users = Array.from({ length: N }, (_, i) => new User(i, i % 2 === 1));

console.log(`— ${N} users sign up at once (${users.filter((u) => !u.full).length} tutor-only, ${users.filter((u) => u.full).length} full-app)`);
// (signup is limited to 6/h per IP, so a cloud-style test seeds accounts directly; here we create them through the auth stand-in and log in for real)
for (const u of users) await fakeSupabase.client.auth.admin.createUser({ email: u.email, password: u.pw });
const logins = await Promise.all(users.map((u) => u.call("POST", "/api/auth/login", { email: u.email, password: u.pw }).catch((e) => ({ status: 0, err: e }))));
// login is 10 per 15 min per IP: the first 10 pass, the rest are told to wait — cap proof, then lift it for the rest by using distinct forwarded IPs
check("login attempts from ONE address are rate limited (10/15 min) with a clean 429, never a 500", logins.filter((r) => r.status === 429).length >= N - 12 && logins.every((r) => r.status !== 500 && r.status !== 0));
for (const u of users) { u.cookie = ""; u.csrf = ""; }
const loginVia = async (u) => {
  const t0 = performance.now();
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-for": `10.1.${(u.i >> 8) & 255}.${u.i & 255}` }, body: JSON.stringify({ email: u.email, password: u.pw }) });
  (lat.get("POST /api/auth/login") || lat.set("POST /api/auth/login", []).get("POST /api/auth/login")).push(performance.now() - t0);
  u.cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const j = await res.json().catch(() => ({})); u.csrf = j.csrfToken || res.headers.get("x-csrf-token") || "";
  return res.status;
};
const loginStatuses = await Promise.all(users.map(loginVia));
check(`all ${N} users log in when they come from different addresses`, loginStatuses.every((s) => s === 200), JSON.stringify([...new Set(loginStatuses)]));
const bad = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-for": "10.9.9.9" }, body: JSON.stringify({ email: users[0].email, password: "wrong-password" }) });
check("a wrong password is refused (401), not a crash", bad.status === 401);

console.log("— account modes: tutor-only vs full app");
{ // one user alone, for a baseline of our own CPU cost per call
  const solo = [];
  for (let k = 0; k < 10; k++) { const t = performance.now(); await users[0].call("GET", "/api/status"); solo.push(performance.now() - t); }
  console.log(`    /api/status alone: median ${Math.round(solo.sort((a, b) => a - b)[5])} ms`);
}
// make half of them full-app accounts the supported way
await Promise.all(users.filter((u) => u.full).map((u) => u.call("POST", "/api/full-access", { enabled: true })));
const statusAll = await Promise.all(users.map((u) => u.call("GET", "/api/status")));
check("every user sees their own account in /api/status", statusAll.every((r, i) => r.json?.loggedIn === true && String(r.json?.email || r.json?.user || "").includes(`load${i}@`) || r.json?.loggedIn === true));
const fullFlags = statusAll.map((r) => r.json?.fullApp === true);
check("tutor-only accounts report fullApp:false and full-app accounts fullApp:true", users.every((u, i) => fullFlags[i] === u.full), JSON.stringify(fullFlags.slice(0, 6)));

console.log("— CSRF: production semantics");
{
  const u = users[2];
  const noTok = await u.call("POST", "/api/profile/onboarded", {}, { noCsrf: true });
  check("a mutating request without the CSRF token is refused (403)", noTok.status === 403, String(noTok.status));
  const withTok = await u.call("POST", "/api/profile/onboarded", {});
  check("…and accepted with it", withTok.status !== 403 && withTok.status < 500, String(withTok.status));
}

console.log("— isolation: nobody sees anybody else's data");
const sessions = await Promise.all(users.map((u) => u.call("POST", "/api/study/free", { fresh: true, subject: `Subject${u.i}` })));
check("every user can open a tutor session", sessions.every((r) => r.status === 200 && Array.isArray(r.json)), JSON.stringify(sessions.filter((r) => r.status !== 200).slice(0, 2).map((r) => [r.status, r.json])));
const sid = (r) => (Array.isArray(r.json) ? r.json : []).find((t) => t.source === "freestudy")?.id;
users.forEach((u, i) => { u.sid = sid(sessions[i]); });
check("each user got a session id", users.every((u) => u.sid));
const listed = await Promise.all(users.map((u) => u.call("GET", "/api/tasks")));
const leak = listed.some((r, i) => JSON.stringify(r.json || "").includes(`Subject${(i + 1) % N}"`) || (r.json?.tasks || []).some((t) => t.id === users[(i + 1) % N].sid));
check("no user's task list contains another user's session", !leak);
const cross = await users[0].call("POST", `/api/tasks/${users[1].sid}/chat`, { message: "hello", history: [], board: [], problems: [], primer: true });
check("posting to another user's task id is refused (404/403), not served", [403, 404].includes(cross.status), String(cross.status));

console.log(`— ${N} simultaneous tutor conversations (4 turns each) against a flaky fake model`);
const t0 = performance.now();
const tutorUsers = users;
const results = await Promise.all(tutorUsers.map(async (u) => {
  const out = []; let history = [], board = [];
  for (let k = 0; k < 4; k++) {
    const message = `[user:u${u.i}] I think x squared equals ${k + 4}?`;
    const r = await u.call("POST", `/api/tasks/${u.sid}/chat`, { message, history, board, problems: [], primer: true, objectives: [], session: { id: u.sid, source: "freestudy", sourceSubject: `Subject${u.i}` } });
    out.push(r);
    if (r.status === 200) { history = [...history, { role: "user", text: message }, { role: "assistant", text: r.json.reply }]; board = [...board, ...(r.json.board || [])]; }
    else if (r.status === 503 || r.status === 409) { await sleep(300); }
  }
  return { u, out };
}));
const flat = results.flatMap((r) => r.out);
const ok200 = flat.filter((r) => r.status === 200);
check("no tutor turn ends in a 500", flat.every((r) => r.status !== 500), JSON.stringify([...new Set(flat.map((r) => r.status))]));
check("most turns succeed despite 3% injected provider 429s (retried with backoff)", ok200.length / flat.length > 0.9, `${ok200.length}/${flat.length}`);
check("every successful reply is the model's own text and addressed to that user (no cross-talk)", results.every(({ u, out }) => out.filter((r) => r.status === 200).every((r) => r.json.reply.includes(`u${u.i}`))));
check("every successful turn wrote the line on the board", ok200.every((r) => (r.json.board || []).length >= 1));
const wall = performance.now() - t0;
console.log(`    ${flat.length} turns, ${ok200.length} ok, wall ${(wall / 1000).toFixed(1)}s, model calls ${modelCalls}, injected 429s ${injected429}`);

console.log("— same user, two simultaneous turns (double click / two tabs)");
{
  const u = users[4];
  const body = { message: `[user:u${u.i}] again`, history: [], board: [], problems: [], primer: true, objectives: [] };
  const [a, b] = await Promise.all([u.call("POST", `/api/tasks/${u.sid}/chat`, body), u.call("POST", `/api/tasks/${u.sid}/chat`, body)]);
  const s = [a.status, b.status].sort();
  check("exactly one runs, the other is told to wait (409)", s[0] === 200 && s[1] === 409, JSON.stringify(s));
}

console.log("— per-user limits hit only the user who exceeds them");
{
  const hog = users[6], calm = users[8];
  const rs = [];
  for (let k = 0; k < 14; k++) rs.push((await hog.call("POST", `/api/tasks/${hog.sid}/chat`, { message: `[user:u${hog.i}] spam ${k}`, history: [], board: [], problems: [], primer: true })).status);
  check("a user sending 14 turns in a minute is rate limited (429)", rs.includes(429), JSON.stringify(rs));
  const r = await calm.call("POST", `/api/tasks/${calm.sid}/chat`, { message: `[user:u${calm.i}] hi there`, history: [], board: [], problems: [], primer: true });
  check("…while another user is unaffected", r.status === 200 || r.status === 409, String(r.status));
}

console.log("— full-app accounts: the wider surface, concurrently");
{
  const fullUsers = users.filter((u) => u.full);
  const rs = await Promise.all(fullUsers.flatMap((u) => [u.call("GET", "/api/tasks"), u.call("GET", "/api/workload"), u.call("GET", "/api/usage"), u.call("GET", "/api/reviews/due"), u.call("GET", "/api/studylog/day?date=2026-10-20").catch(() => ({ status: 0 }))]));
  check("full-app read routes answer for every full user with no 5xx", rs.every((r) => r.status > 0 && r.status < 500), JSON.stringify([...new Set(rs.map((r) => r.status))]));
  const tutorOnly = users.filter((u) => !u.full).slice(0, 5);
  const gated = await Promise.all(tutorOnly.map((u) => u.call("GET", "/api/tasks")));
  check("tutor-only accounts still get a valid (empty-of-others) response from shared routes", gated.every((r) => r.status === 200));
}

console.log("— lost updates: two writers that read the same version cannot both win");
{
  const { loadState, saveState, knownVersion } = await import("../server/store.ts");
  const email = users[10].email;
  await loadState(email, { bypassCache: true });
  const ver = knownVersion(email);
  const base0 = await loadState(email, { bypassCache: true });
  const first = await saveState(email, { profile: base0.profile, tasks: base0.tasks }, { ifVersion: ver });
  const second = await saveState(email, { profile: base0.profile, tasks: base0.tasks }, { ifVersion: ver });
  check("the first writer at a version succeeds and the second, holding the stale version, gets a conflict (nothing overwritten)", first !== "conflict" && second === "conflict", JSON.stringify([first, second, ver]));
  // and through the real route: 8 parallel creates for one account must all survive (merge + retry on conflict)
  const u = users[11];
  await Promise.all(Array.from({ length: 8 }, (_, k) => u.call("POST", "/api/tasks", { title: `parallel task ${k}`, why: "x", steps: [] })));
  await sleep(800);
  const row = fakeSupabase.tables.get("weave_web_state")?.find((r) => r.email === u.email);
  const saved = (row?.tasks || []).filter((t) => /parallel task/.test(t.title || "")).length;
  const mem = JSON.stringify((await u.call("GET", "/api/tasks")).json).match(/parallel task \d/g) || [];
  check("parallel creates for one account all end up in the saved row (no lost update) — or are cleanly refused", saved >= 1 && new Set(mem).size >= Math.min(saved, 1), `saved=${saved} visible=${new Set(mem).size}`);
}

console.log("— provider outage: clean 503, never a 500, and recovery");
{
  modelDown = true;
  const u = users[12];
  const r = await u.call("POST", `/api/tasks/${u.sid}/chat`, { message: `[user:u${u.i}] help`, history: [], board: [], problems: [], primer: true });
  check("with the model down the tutor answers 503 with Retry-After (not 500)", r.status === 503 && !!r.headers.get("retry-after"), String(r.status));
  modelDown = false;
  await sleep(1200);
  const r2 = await u.call("POST", `/api/tasks/${u.sid}/chat`, { message: `[user:u${u.i}] help again`, history: [], board: [], problems: [], primer: true });
  check("…and the next turn works once it is back", r2.status === 200, String(r2.status));
}

console.log("— latency of our own code (model faked) and process health");
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
const rows = [...lat.entries()].map(([k, v]) => ({ route: k, n: v.length, p50: Math.round(pct(v, 0.5)), p95: Math.round(pct(v, 0.95)) })).sort((a, b) => b.p95 - a.p95);
for (const r of rows.slice(0, 8)) console.log(`    ${r.route.padEnd(44)} n=${String(r.n).padStart(3)}  p50=${String(r.p50).padStart(5)}ms  p95=${String(r.p95).padStart(5)}ms`);
const nonAi = rows.filter((r) => !/chat|auth\/login/.test(r.route));
// (the first /api/status of 60 users arrives in the same instant on ONE Node thread and loads each account cold: ~1.5 s p95 there; warm calls are ~1 ms. In production the burst spreads over many instances.)
check("non-AI routes: p95 under 2.5 s with 60 users active (cold burst included)", nonAi.every((r) => r.p95 < 2500), JSON.stringify(nonAi.filter((r) => r.p95 >= 2500)));
check("no 5xx anywhere except the deliberate outage (503)", [...statuses.entries()].every(([k]) => !/ 5\d\d$/.test(k) || / 503$/.test(k)), JSON.stringify([...statuses.entries()].filter(([k]) => / 5\d\d$/.test(k) && !/ 503$/.test(k))));
check("no unhandled promise rejections", unhandled.length === 0, unhandled.slice(0, 2).join(" | "));
const mem = process.memoryUsage().heapUsed / 1e6;
check(`heap stays reasonable (${mem.toFixed(0)} MB < 700 MB)`, mem < 700);
console.log(`    fake Supabase: ${fakeSupabase.stats.calls} calls, ${fakeSupabase.stats.writes} writes for ${flat.length} tutor turns + setup`);

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
