# Otto

A voice tutor with a shared whiteboard. You talk, Otto asks. It never hands you the answer: it asks the
question that gets you there, explains anything when you are stuck, writes the working on paper as you go
(typeset maths, graphs, diagrams, multiple choice) and remembers what you studied before. It is pitched at your
level and programme (SAT, AP, IB, Bac, school tests), and it knows your Pronote homework, lesson content,
journal and coursework.

By default an account sees only the tutor, Settings and (optionally) a Pronote connection. **Full mode**
(Settings → Full mode, or open `/full` once) adds the rest of the app: ranked daily tasks, journal and flashcards,
coursework, mistake log and Google/Notion connections.

- **Voice:** Gemini Live (WebSocket), falling back to OpenAI Realtime (WebRTC). Typing always works.
- **Languages:** the app and the tutor work in 10 languages: English, 中文, हिन्दी, Español, Français, العربية,
  Português, Русский, Deutsch, 日本語 (picker in Settings and on the landing page; interface text is
  translated once on the server and cached in the browser; Arabic is right-to-left).
- **Private by default:** tutor sessions, boards and drawings are kept in the browser, not on the server.
- **Phones:** the tutor, tasks and flashcards work on a phone.
- It never sends anything without your tap and never does graded work for you.

Open source (MIT), self-hostable.

## What's in the app

| Page | What it does |
|---|---|
| `/` Landing, `/login`, `/signup`, `/reset-password` | Public pages. Email + password accounts (Supabase Auth). |
| `/tasks` | Full mode. Today's tasks, ranked. Each task opens with its steps, prepared notes/flashcards/quizzes, links and an "Ask Otto" chat. |
| `/tutor` | The product. Full-screen voice tutor: hands-free talk, a paper board (typeset maths, diagrams, graphs, multiple choice), share a PDF or photo with the paperclip, past sessions and drawings kept locally. |
| `/study/<task>` | Study Mode desk: Otto chat + board, notes, materials, timer, tools (calculator, Desmos, dictionary, citations). Desktop and iPad. |
| `/log` | Full mode (flashcards only on phones). Learning journal → automatic flashcards with spaced repetition (Leitner boxes). |
| `/errorlog` | Mistake log, grouped by subject. |
| `/settings` | Language, level, Pronote (and Google/Notion in full mode), pause Otto and AI usage (full mode), the full-mode switch, data export, account deletion. |
| `/full` | Opens full mode for the signed-in account. |
| `/privacy`, `/terms`, `/research` | Legal and methodology pages. |

**Otto does on its own (reversible):** revision notes, step checklists, research, email drafts.
**Otto never does without your tap:** sending email, calendar invites, deleting anything.
**Otto refuses:** writing graded work, giving answers to exercises or tests (enforced in `server/claude.ts`).

## Architecture

```
client/                 React + Vite app
  App.tsx               Shell: routing, task sync, the Today dashboard
  appShared.tsx         Helpers several pages use (navigate, Logo, account cleanup)
  pages/                One file per page: Settings, Journal, MistakeLog, Flashcards, Onboarding, Login,
                        Landing, Legal, StudyEntry, Dashboard widgets
  TaskCard.tsx          Task row, task detail and task chat
  ui.tsx                Shared components (Spinner, ErrorNote, flashcards, quizzes, …)
  study/, tutor/        Study Mode desk and the full-screen tutor
  styles.css            Design tokens (the ONE :root block) + base styles; tally/lab/minimal.css layer on top
server/                 Express API (one serverless function on Vercel)
  index.ts              App setup, security headers, sessions, route registration
  http.ts               Shared middleware: requireAuth, CSRF, rateLimit, commit (account sync), i18n errors
  routes/               auth, tasks, integrations, profile, study, tutor
  claude.ts             Facade for the AI layer in ai/:
  ai/                   client (providers), context (prompt blocks), generate, run (task execution),
                        steps (cleanup guards), tools, board, chat + chatPrompt + chatRounds (tutor turn),
                        studyContent, voice, coursework, scheduling
  jobs.ts               Durable job queue (sweeps, task runs) + cron tick
  store.ts              Supabase persistence: accounts, sessions, jobs, reset tokens
  pronote.ts            Pronote client (unofficial, via pawnote)
  integrations.ts       Google / Notion via Composio, with a deny-by-default action gate
shared/                 Types and pure functions used by both sides
scripts/                Build + maintenance (split-module.mjs / extract-local.mjs: AST-based refactor tools)
tests/                  run.mjs (pure functions + source checks), smoke.mjs (HTTP), tutor simulations
supabase.sql            Schema, RLS, migrations (idempotent — safe to re-run)
api/index.mjs           Generated server bundle for Vercel (rebuilt on every deploy; keep it committed)
```

**AI providers:** Gemini Live then OpenAI Realtime for the tutor's voice (the server only mints short-lived tokens);
DeepSeek for the board writer, typed turns, translations and task execution; Gemini for reading photos.
Exa for web search (DuckDuckGo/Wikipedia fallback).

## Run locally

```bash
cp .env.example .env     # fill in at least DEEPSEEK_API_KEY, COMPOSIO_API_KEY, SESSION_SECRET
npm install
npm run dev              # http://localhost:5273 (API on :8788, proxied)
```

Without Supabase, accounts can't be created (login/signup return "account storage isn't configured").
For a throwaway local Supabase project, see the DEV-ONLY block at the bottom of `supabase.sql`.

## Environment variables

**Required in production** (the server refuses to start without them):

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs the session cookie. `openssl rand -hex 32` |
| `DEEPSEEK_API_KEY` | AI generation and task execution |
| `COMPOSIO_API_KEY` | Gmail / Calendar / Drive connections |
| `PUBLIC_URL` | Your HTTPS origin (used in emails and OAuth redirects) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Accounts and all persistence. The service key bypasses RLS — server only. |

**Needed for a feature to work:**

| Variable | Without it |
|---|---|
| `CRON_SECRET` | `/api/cron/drain` returns 503, so no background sweeps when the browser is closed |
| `CREDENTIAL_ENCRYPTION_KEY` | Password-based school portals (Pronote) refuse to connect — credentials are never stored unencrypted. `openssl rand -hex 32` |
| `RESEND_API_KEY` | Password-reset emails are not sent (`MAIL_FROM` sets the sender) |
| `GEMINI_API_KEY` | Live voice (first choice) and reading photos |
| `OPENAI_API_KEY` | Live voice fallback (OpenAI Realtime) when Gemini fails |
| `FULL_APP_EMAILS` | Accounts that start in full mode (comma-separated; everyone else starts tutor-only) |
| `TUTOR_DAILY_LIVE`, `TUTOR_DAILY_LIVE_BOARD` | Per-account daily caps for voice sessions (default 20) and board writes (default 400) |
| `EXA_API_KEY` | Web search falls back to DuckDuckGo/Wikipedia |
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | Errors in background jobs are only visible in the function logs |

Optional: `DEEPSEEK_MODEL`, `AI_PROVIDER`/`NVIDIA_API_KEY` (alternative provider), `BLACKBAUD_*` (Blackbaud
is mock-only for now), `PORT`. See [`.env.example`](.env.example) for the annotated list.

There is **no AI spending cap**: each full-mode account's month-to-date cost is shown in Settings, and the per-route
rate limits and daily voice caps are the throttle. An account with open tasks and nothing checked off for 7 days has its
AI paused automatically; the next time it opens the app it is asked to restart it.

## Deploy (Vercel)

1. Run [`supabase.sql`](supabase.sql) in the Supabase SQL editor. It is idempotent — re-run it after every
   update (it adds the reset-token table, the sessions `user_email` column and the user-lookup function).
2. Set the environment variables above in the Vercel project.
3. Deploy. `vercel.json` builds the client and bundles the API (`scripts/build-vercel.sh`), sets security
   headers, and schedules the cron (`/api/cron/drain`, once a day on the Hobby plan).

Other Node hosts work too: `npm run build && npm start` (a `Dockerfile` is included).

### Production checklist

- Required variables set; `supabase.sql` run on the production database.
- `CRON_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `RESEND_API_KEY`, `GEMINI_API_KEY` and `SENTRY_DSN` set.
- `/privacy` and `/terms` reachable (required for Google OAuth verification). Gmail/Calendar/Drive are
  sensitive scopes: until Google verifies the app it is capped at 100 users and shows an "unverified app" screen.

## Security and data

- Every per-user route requires a session; all data is keyed by the session's account email, never by a
  request parameter. CSRF tokens on every mutating request; CSP, HSTS and `frame-ancestors 'none'`.
- Supabase RLS is on with no public policies; only the server's service key can read or write.
- Password reset tokens are single-use, expire after 30 minutes and are stored hashed. A reset, and account
  deletion, sign the account out on every device.
- Portals without OAuth (currently Pronote): the username, password and session token are stored
  **encrypted (AES-256-GCM)** so Otto can log back in when the token expires. They're deleted on disconnect or account deletion.
- Data export (`/api/account/export`, never includes tokens or passwords) and instant account deletion in Settings.

Details: [`SECURITY.md`](SECURITY.md) (reporting, threat model) and [`DATA_PROTECTION.md`](DATA_PROTECTION.md)
(what is stored, what is sent to the LLM).

## Serverless notes

Vercel runs many short-lived instances, each with its own memory:

- Anything that must be shared lives in Supabase (sessions, jobs, rate limits, reset tokens). Per-instance
  caches are short (sessions: 60 s).
- A function dies at 300 s. `drain()` starts no new job after 120 s; a job killed mid-run is retried once its
  6-minute lock expires. Account saves use `waitUntil` so they finish after the response.

Known limitations: the school-portal per-account lock and the tutor's turn-to-turn adaptation state are per
instance; outbound URL checks don't pin DNS (rebinding).

## Development

```bash
npm run dev          # server + client, hot reload
npm run typecheck    # tsc --noEmit
npm test             # tests/run.mjs — no network, no AI
npm run test:smoke   # HTTP smoke test against the Express app
npm run build        # production client build
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, smoke tests, build and `npm audit` on every push and PR.

## License

[MIT](LICENSE) © Willem Tjong. Independent project, not affiliated with Index Éducation (Pronote), Google,
Composio, DeepSeek or Supabase.
