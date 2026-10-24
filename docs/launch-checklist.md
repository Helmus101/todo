# Launch checklist (50+ testers at once)

Run top to bottom on **staging first**, then once on production off-hours. Everything marked 🤖 is automated in CI or by a script; the rest is you.

## 1. Gates (🤖 every PR: typecheck, `npm test`, `npm run test:smoke`, `npm run test:load`, build, audit)
- [ ] Green CI on the commit you deploy.
- [ ] `npm run test:load` locally once: 60 virtual users (30 tutor-only, 30 full-app) on the real server code with an in-memory database and a faked model.

## 2. Environment (Vercel → Settings → Environment Variables, then **redeploy**)
- [ ] Required, or the server refuses to boot in production: `SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service key, not anon).
- [ ] Voice: `GEMINI_API_KEY`. Research: `EXA_API_KEY`. Password reset mail: `RESEND_API_KEY`. Pronote: `CREDENTIAL_ENCRYPTION_KEY`. Errors: Sentry DSN.
- [ ] Supabase: `supabase.sql` has been run **including** `weave_web_sessions` and `weave_web_ratelimits` (production now refuses to boot without them, instead of silently using per-instance memory) and the `otto_rate_limit` function.
- [ ] Not set anywhere in production: `TEST_FAKE_SUPABASE`.
- [ ] Caps you chose on purpose: `TUTOR_DAILY_TURNS` (default 80 per user per day), `WEEKLY_AI_CAP_USD` (default $5 per user), `TUTOR_DAILY_LIVE` (voice sessions, default 20). `TUTOR_MAX_CONCURRENT` (simultaneous model calls per instance, default 24).
- [ ] Spend alerts on the DeepSeek, Gemini and Exa dashboards. A tutor turn is usually 1 model call, up to ~4 with the board nudge and working check.

## 3. Load test on a real deployment (`scripts/loadtest.mjs`)
1. Create 50 test accounts in Supabase (any password), put them in `accounts.csv` (`email,password[,full]`; mark ~half `full`).
2. Raise the caps for the run only (`TUTOR_DAILY_TURNS=400`, `WEEKLY_AI_CAP_USD=20`) or the test will hit them on purpose.
3. `node scripts/loadtest.mjs --url https://<staging> --accounts accounts.csv --users 50 --minutes 5 --max-usd 3`
4. Pass = exit 0: non-AI routes p95 ≤ 3 s, ≤ 2% 5xx. Read the per-route table: look for 429s on `/chat` (provider or per-user limit), 409s, and any `0` (network/timeouts).
5. Check afterwards: Sentry quiet, Supabase CPU/egress not near plan limits, model dashboards under budget.

## 4. By hand (30 min, two browsers, one phone)
- [ ] Sign up a brand-new account → onboarding → first tutor session → the board fills as Otto talks → close the session → recap → come back next day.
- [ ] Tutor-only account sees only Tutor/Settings; flip to the full app via `/full` and check Tasks, Study, Journal, Mistakes, Coursework, Exercises load.
- [ ] Niche opener ("International Economics Olympiad open questions"): Otto says he looked it up and a sources note lands on the board.
- [ ] Voice (Gemini Live): start, talk, interrupt, board updates; unplug Wi-Fi mid-session and check the typing fallback works.
- [ ] Two tabs on one account: send a message in each at the same time; one is told to wait, nothing is lost.
- [ ] Break something on purpose: wrong `DEEPSEEK_API_KEY` on staging → the tutor shows "briefly unavailable — your message is kept" and recovers when fixed.
- [ ] Phone width: no horizontal scroll on landing, login, tutor, settings.

## 5. Know the limits
- State is per account and merged on write; concurrent writes are retried with a compare-and-set (3 tries, then last writer wins on the freshest merge).
- Caches, the Gemini circuit breaker and the model-call limiter are **per serverless instance**, not global. Provider rate limits are shared by every user.
- Vercel rejects request bodies over ~4.5 MB, so the 8 MB whiteboard-photo and 20 MB import limits are not reachable there.
