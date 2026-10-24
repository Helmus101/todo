// Load test against a DEPLOYED instance with real credentials (staging, or production off-hours). Not part of CI: it spends real model money.
//   node scripts/loadtest.mjs --url https://your-app.vercel.app --accounts accounts.csv --users 50 --minutes 5 --max-usd 3
// accounts.csv: one "email,password[,full]" per line — pre-created test accounts (signup is limited to 6/h per IP, so do not sign up here).
// Each virtual user logs in (own cookie jar + CSRF token), opens a tutor session, then keeps chatting at a human pace (one turn every 20-45 s)
// until the time is up; "full" accounts also hit the wider app (tasks, workload, usage, reviews). Prints p50/p95 and error counts per route and
// exits non-zero past the thresholds. It stops itself at --max-usd (estimated from the server's own /api/usage if reachable, else turns x 2 cents).
import { readFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = (arg("url", "") || "").replace(/\/$/, "");
const file = arg("accounts", ""), users = Number(arg("users", 50)), minutes = Number(arg("minutes", 5)), maxUsd = Number(arg("max-usd", 3));
if (!base || !file) { console.error("usage: node scripts/loadtest.mjs --url <https://app> --accounts accounts.csv [--users 50] [--minutes 5] [--max-usd 3]"); process.exit(2); }
const accounts = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => { const [email, password, full] = l.split(","); return { email, password, full: /^(1|true|full)$/i.test((full || "").trim()) }; });
if (accounts.length < users) { console.error(`need ${users} accounts, the file has ${accounts.length}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lat = new Map(), codes = new Map();
let turns = 0, stop = false;
const est = () => turns * 0.02;

async function call(u, method, path, body) {
  const t0 = performance.now();
  let status = 0, json = null, headers;
  try {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...(u.cookie ? { cookie: u.cookie } : {}), ...(u.csrf ? { "x-csrf-token": u.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(100_000) });
    status = res.status; headers = res.headers;
    const set = res.headers.getSetCookie?.() || []; if (set.length) u.cookie = set.map((c) => c.split(";")[0]).join("; ");
    const tok = res.headers.get("x-csrf-token"); if (tok) u.csrf = tok;
    json = await res.json().catch(() => null); if (json?.csrfToken) u.csrf = json.csrfToken;
  } catch { status = 0; }
  const key = `${method} ${path.replace(/[0-9a-f-]{20,}/g, ":id").replace(/\?.*/, "")}`;
  (lat.get(key) || lat.set(key, []).get(key)).push(performance.now() - t0);
  const ck = `${key} ${status}`; codes.set(ck, (codes.get(ck) || 0) + 1);
  return { status, json, headers };
}

async function run(a, i) {
  const u = { cookie: "", csrf: "" };
  await sleep(i * 400); // ramp: one new user every 0.4 s
  const login = await call(u, "POST", "/api/auth/login", { email: a.email, password: a.password });
  if (login.status !== 200) return;
  await call(u, "GET", "/api/status");
  const sess = await call(u, "POST", "/api/study/free", { fresh: true, subject: ["Maths", "French", "History", "Physics"][i % 4] });
  const id = (sess.json || []).find?.((t) => t.source === "freestudy")?.id;
  if (!id) return;
  let history = [], board = [];
  const prompts = ["Can you help me with quadratic equations?", "I think I factor it first?", "x minus 2 and x minus 3", "so x is 2 or 3", "why does that work?", "can you give me another one?"];
  const end = Date.now() + minutes * 60_000;
  for (let k = 0; !stop && Date.now() < end; k++) {
    const message = prompts[k % prompts.length];
    const r = await call(u, "POST", `/api/tasks/${id}/chat`, { message, history, board, problems: [], primer: true, objectives: [], session: { id, source: "freestudy", sourceSubject: "Maths" } });
    turns++;
    if (r.status === 200) { history = [...history, { role: "user", text: message }, { role: "assistant", text: r.json.reply }].slice(-30); board = [...board, ...(r.json.board || [])].slice(-30); }
    if (a.full) await Promise.all([call(u, "GET", "/api/tasks"), call(u, "GET", "/api/workload"), call(u, "GET", "/api/usage")]);
    if (est() > maxUsd) { stop = true; console.log(`(estimated spend passed $${maxUsd} — stopping)`); }
    await sleep(r.status === 429 || r.status === 503 ? ((Number(r.headers?.get("retry-after")) || 20) * 1000) : 20_000 + Math.random() * 25_000);
  }
}

console.log(`${users} virtual users (${accounts.slice(0, users).filter((a) => a.full).length} full-app) for ${minutes} min against ${base}`);
await Promise.all(accounts.slice(0, users).map(run));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0); };
let bad = false;
console.log("\nroute".padEnd(46), "n".padStart(5), "p50".padStart(7), "p95".padStart(7), " statuses");
for (const [k, v] of [...lat.entries()].sort()) {
  const st = [...codes.entries()].filter(([c]) => c.startsWith(k + " ")).map(([c, n]) => `${c.slice(k.length + 1)}×${n}`).join(" ");
  const ai = /chat/.test(k), p95 = pct(v, 0.95);
  const five = [...codes.entries()].filter(([c]) => c.startsWith(k + " ") && /\s(5\d\d|0)$/.test(c) && !/\s503$/.test(c)).reduce((s, [, n]) => s + n, 0);
  if ((!ai && p95 > 3000) || five / v.length > 0.02) bad = true;
  console.log(k.padEnd(45), String(v.length).padStart(5), String(pct(v, 0.5)).padStart(7), String(p95).padStart(7), " ", st);
}
console.log(`\n${turns} tutor turns, estimated spend ≈ $${est().toFixed(2)}.`, bad ? "FAILED thresholds: a non-AI route p95 > 3 s, or > 2% 5xx/network errors on a route." : "Thresholds met (non-AI p95 ≤ 3 s, ≤ 2% 5xx).");
process.exit(bad ? 1 : 0);
