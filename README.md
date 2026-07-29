# Otto — Know what deserves your attention today

Otto reads your Gmail, Calendar, and Drive, ranks what genuinely matters, and prepares the work — drafting replies, prepping docs, gathering context. You're left with a short checklist of only the things that need you. It **never sends, deletes, or changes anything irreversibly without your explicit confirmation.**

Otto is a **companion, not a do-it-all** — it's built to keep a student moving without ever doing the graded work for them. It executes the logistics (research, scheduling, compiling reference material, drafting routine messages) and structures the rest into small, concrete steps so a big task never feels like a wall of dread. Any document it creates is a study aid — a checklist, an outline, a compiled list of resources — never a finished essay or a solved problem set; the parts that are the actual learning always stay a step for the student to do themselves.

> Self-hostable and open source (MIT). Bring your own API keys and run it in a few minutes.

## Features

- **Reads your world, builds your list** — inbox, calendar, and Drive become a ranked, deduplicated to-do list (Eisenhower-ordered).
- **Proactive, not just reactive** — sweeps every connected source on a schedule and forces at least one useful task a day, so the list stays alive even on a quiet inbox.
- **Does the reversible prep work for you** — drafts, Google Docs/Sheets/Slides, research/synthesis — all reviewable, nothing sent.
- **You confirm the rest** — anything irreversible (send, invite, delete, pay) is surfaced as a one-tap approval, never auto-done.
- **Learns who you are** — remembers your people, projects, and preferences so its work sounds like you.
- **Runs with the browser closed** — a durable job queue drains on a schedule, so tasks generate and execute in the background.
- **Multi-account** — connect several Gmail/Calendar/Drive/GitHub accounts; reads and drafts land against the right one.
- **Cost-capped** — a configurable monthly AI spend cap per account.
- **Homework & test deadlines (Pronote)** — optional, unofficial integration for French schools: tracks homework due dates and upcoming tests (from the timetable's "test" flag) with enough lead time to actually plan around them, not just a last-minute ping. Currently hidden from Settings while launch is scoped to Google only — the backend support is live, re-enabling it is a one-line flip.

## Tech stack

- **Backend:** Node + Express (TypeScript), a durable Supabase-backed job queue
- **Frontend:** Vite + React (TypeScript)
- **Integrations:** [Composio](https://composio.dev) for Gmail, Calendar, and Drive/Docs/Sheets/Slides at launch. The Composio wiring also covers GitHub, Slack, Notion, Linear, and others — supported in the backend (multi-account included) but hidden from Settings for now; re-enabling one is a UI-only change (`client/App.tsx`'s `Integrations` component).
- **AI:** [DeepSeek](https://deepseek.com) via the OpenAI-compatible API
- **Storage:** [Supabase](https://supabase.com) (Postgres) — optional but recommended

## Quick start

```bash
git clone <your-fork-url> otto && cd otto
cp .env.example .env
#   → set DEEPSEEK_API_KEY, COMPOSIO_API_KEY (https://composio.dev), and SESSION_SECRET
npm install
npm run dev          # opens http://localhost:5273
```

That's enough to run locally. Add Supabase (below) to persist across restarts.

## Environment variables

**Required**

| Var | Purpose |
|-----|---------|
| `DEEPSEEK_API_KEY` | The AI agent (task generation + execution) |
| `COMPOSIO_API_KEY` | App integrations — get it at https://composio.dev |
| `SESSION_SECRET` | Signs the session cookie (`openssl rand -hex 32`) |
| `PUBLIC_URL` | Your origin (`http://localhost:5273` dev, your HTTPS URL in prod) |

**Optional**

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Cloud persistence (recommended; **required in production**) |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Anon-key fallback for local dev only |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts secrets stored in the DB ourselves (currently the Pronote login token) with AES-256-GCM before they're written — defense-in-depth on top of RLS. Any value works (`openssl rand -hex 32`); **required in production**, same fail-closed pattern as `SUPABASE_SERVICE_KEY`. |
| `MONTHLY_AI_BUDGET_USD` | Per-account monthly AI spend cap (default `3`) |
| `CRON_SECRET` | Protects `/api/cron/drain` (required on Vercel) |
| `DEEPSEEK_MODEL` | Default `deepseek-v4-flash` (or `deepseek-v4-pro` for heavier reasoning) |
| `PORT` | Default `8788` |

See [`.env.example`](.env.example) for the annotated list.

## Cloud persistence (recommended)

Your profile, tasks, and connections are keyed by account email so they survive restarts and follow you.

1. Run [`supabase.sql`](supabase.sql) in the Supabase SQL editor (creates the tables; ships **RLS-locked, deny-by-default**).
2. Set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. **The server refuses to boot in production without the service key** — it bypasses RLS and must stay server-side only.
3. For a throwaway local project you may instead use the anon key + uncomment the clearly-marked DEV-ONLY policies in `supabase.sql`.

## Deploy

```bash
npm run build        # → dist/
npm start            # production: Express serves dist/ + the API on $PORT
```

Runs on any Node host (Render, Railway, Fly, a VM, or Docker — a `Dockerfile` is included) and on Vercel (`vercel.json` wires the API function, static hosting, cron, and security headers). Set the required env, point `PUBLIC_URL` at your HTTPS domain, and see the **Production checklist** below.

### Production checklist

- Required env set (boot fails without them): `SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`, `CREDENTIAL_ENCRYPTION_KEY` (once Supabase is configured).
- `supabase.sql` run; `SUPABASE_SERVICE_KEY` set; anon/service keys never shipped to the client.
- `CRON_SECRET` set (Vercel Cron drains the job queue).
- Security is wired: CSP + security headers, auth rate-limiting, bcrypt passwords, `httpOnly`/`secure` cookies, no secrets in the client bundle, RLS deny-by-default, AES-256-GCM on the one credential we store ourselves (Pronote token), plus Postgres/Supabase's own default encryption-at-rest on every table.
- `/privacy` and `/terms` are published in-app — **required for Google OAuth verification.**
- **Google OAuth:** Gmail/Calendar/Drive are sensitive/restricted scopes. Submit the OAuth consent screen with your privacy-policy URL + homepage; until verified, Google caps the app at 100 users and shows an "unverified app" screen.

## What it does / doesn't

- ✅ Auto-runs reversible prep: drafts (never sent), Docs/Sheets/Slides, research/synthesis.
- 🔒 Never irreversible without you: sending mail, calendar invites, payments, deletes → surfaced as a checklist.
- 🎓 Never does the graded/learning work itself: no written essays, no solved problem sets, no answered exam questions — documents it creates are guides (checklists, outlines, compiled resources), and the actual exercise always stays a step for the student.
- 🧠 Mines your mail/calendar for the facts; only acts that *require you* show up.
- 🗂️ Data is stored per account, encrypted at rest (Postgres/Supabase by default, plus app-level AES-256-GCM on the one credential we store ourselves); nothing is shared, sold, or used to train models.

## Optional: Otto Tabs Chrome extension

Steps that mean "open a page" can open tabs unattended, grouped into one "Otto" tab group. The unpacked extension lives in [`extension/`](extension/): `chrome://extensions` → Developer mode → Load unpacked → select the folder.

## Project layout

```
client/     React app (Vite)
server/     Express API, job queue, AI agent, integrations
shared/     Types + pure helpers shared by client & server
extension/  Otto Tabs Chrome extension (MV3)
tests/      Pure-function test suite (npm test)
supabase.sql  Postgres schema + RLS
```

## Development

```bash
npm run dev         # server + client with hot reload
npm test            # pure-function tests (no network/AI)
npm run typecheck   # tsc --noEmit
npm run build       # production client build
```

## Contributing

Issues and PRs welcome. Please run `npm run typecheck && npm test && npm run build` before opening a PR, and keep changes consistent with the existing style.

## License

[MIT](LICENSE) © Willem Tjong. Otto is an independent project and is not affiliated with or endorsed by Google, Composio, DeepSeek, or Supabase.
