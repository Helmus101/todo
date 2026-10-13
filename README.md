# Otto

An AI study assistant for students. Otto turns everything you have to do into a short, ranked list,
prepares the reversible work (revision notes, step checklists, flashcards, email drafts), and tutors you
Socratically: it asks questions instead of handing over answers. It never sends anything without your tap and
never does graded work for you.

Otto works on its own: add tasks by hand and use the tutor, journal and study desk. Connecting apps lets it
find the work for you:

- **Google** (Gmail, Calendar, Drive) and **Notion** through Composio
- **School portals**: Pronote today; Blackbaud is in progress
- Curriculum-aware tutoring for national programmes, IB and AP; the interface is in English and French

Open source (MIT), self-hostable.

## What's in the app

| Page | What it does |
|---|---|
| `/` Landing, `/login`, `/signup`, `/reset-password` | Public pages. Email + password accounts (Supabase Auth). |
| `/tasks` | Today's tasks, ranked. Each task opens with its steps, prepared notes/flashcards/quizzes, links and an "Ask Otto" chat. Read-only on phones. |
| `/tutor` | Full-screen Socratic tutor with a live board (typeset maths, diagrams, graphs, checkable exercises) and voice. |
| `/study/<task>` | Study Mode desk: Otto chat + board, notes, materials, timer, tools (calculator, Desmos, dictionary, citations). Desktop and iPad. |
| `/log` | Learning journal → automatic flashcards with spaced repetition (Leitner boxes). |
| `/errorlog` | Mistake log, grouped by subject. |
| `/settings` | Connections, preferences, pause Otto, **AI usage (this month's cost)**, data export, account deletion. |
| `/admin` | Usage metrics. Only for accounts listed in `ADMIN_EMAILS`. |
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
                        Landing, Legal, Admin, StudyEntry, Dashboard widgets
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

**AI providers:** DeepSeek for generation and task execution; Gemini for the tutor chat (DeepSeek fallback)
and for reading whiteboard photos. Exa for web search (DuckDuckGo/Wikipedia fallback).

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
| `GEMINI_API_KEY` | Tutor uses DeepSeek only; "send whiteboard photo to Otto" is hidden |
| `ADMIN_EMAILS` | Nobody can open `/admin` (comma-separated emails) |
| `EXA_API_KEY` | Web search falls back to DuckDuckGo/Wikipedia |
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | Errors in background jobs are only visible in the function logs |

Optional: `DEEPSEEK_MODEL`, `AI_PROVIDER`/`NVIDIA_API_KEY` (alternative provider), `BLACKBAUD_*` (Blackbaud
is mock-only for now), `PORT`. See [`.env.example`](.env.example) for the annotated list.

There is **no AI spending cap**: each account's month-to-date cost is shown in Settings, and the per-route
rate limits are the only throttle.

## Deploy (Vercel)

1. Run [`supabase.sql`](supabase.sql) in the Supabase SQL editor. It is idempotent — re-run it after every
   update (it adds the reset-token table, the sessions `user_email` column and the user-lookup function).
2. Set the environment variables above in the Vercel project.
3. Deploy. `vercel.json` builds the client and bundles the API (`scripts/build-vercel.sh`), sets security
   headers, and schedules the cron (`/api/cron/drain`, once a day on the Hobby plan).

Other Node hosts work too: `npm run build && npm start` (a `Dockerfile` is included).

### Production checklist

- Required variables set; `supabase.sql` run on the production database.
- `CRON_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `RESEND_API_KEY`, `ADMIN_EMAILS` and `SENTRY_DSN` set.
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
