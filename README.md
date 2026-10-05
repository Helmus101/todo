# Otto Lycée — Your Pronote becomes 3 things to do today.

**Otto reads Pronote, Gmail, Calendar and Drive, and leaves you only what needs you. It prepares the work, never instead of you. It sends nothing without your OK. It never does your homework.**

> Designed for French high school (Seconde / Première / Terminale). Open source (MIT). Self-hostable. Cost-capped.

## Features Overview

Otto is a task management and study assistant that integrates with your school and productivity tools to help you stay organized and focused.

### Core Integrations

Otto connects to 4 services only:

1. **Pronote** — Homework, tests (flagged "test" in the schedule), dates. Non-official connection (Index Éducation has no public API); your password is used once then never stored — an encrypted token (AES-256-GCM) replaces it.
2. **Gmail** — Teacher emails, invitations, Classroom links. Otto only replies in draft, never auto-sends.
3. **Google Calendar** — Tests, free slots for revision.
4. **Google Drive** — Class materials, study guides, corrections shared by teachers — to enrich your revision notes.

Notion is supported server-side but intentionally hidden from the interface for now — each additional connection is friction for a high schooler without professional Gmail. No other integrations (GitHub, Slack, Linear, etc.) are supported: the surface is intentionally limited to Google Workspace, Notion, and Pronote.

## Pages and Navigation

### Public Pages (No Login Required)

#### Landing Page (`/`)
- **Purpose**: Introduction to Otto
- **Features**: 
  - Explains what Otto does
  - Language toggle (French/English)
  - Call-to-action to sign up or log in
  - Marketing copy about the problem (overwhelmed by homework) and solution

#### Login/Signup (`/login`, `/signup`)
- **Purpose**: Account authentication
- **Features**:
  - Email/password login
  - Email signup with name and preferred language
  - Password reset option (`/reset-password`)
  - Remembers language preference across signup

#### Unlimited Page (`/unlimited`)
- **Purpose**: Information about premium/unlimited features
- **Features**: 
  - Describes the unlimited plan
  - Upgrade option

#### Legal Pages
- **Privacy Policy (`/privacy`)** — GDPR-compliant privacy policy
- **Terms of Service (`/terms`)** — Terms and conditions
- **Research Page (`/research`)** — Information about Otto's research methodology

### Authenticated Pages (Login Required)

#### Tasks Dashboard (`/tasks` or `/`)
The main dashboard showing your tasks sorted by priority (Eisenhower matrix: urgent/important → do, schedule, delegate, can wait).

**Features**:
- **Task List**: All active tasks sorted by quadrant (Today's top 3, Later, Can wait)
- **Task Cards**: Each task shows:
  - Title and deadline
  - Subject (e.g., Mathematics, History)
  - Quadrant label (Do now, This week, Later, Can wait)
  - Status chip (Working, Queued, Failed, etc.)
  - Study Mode button (desktop only)
  - Checkmark to mark done
  - Dismiss button (x)
- **Progress Bar**: Shows today's completion progress
- **Status Indicators**: 
  - Overdue milestones count
  - "Otto is working on X" indicator
  - Scanning indicator
- **Refresh Button**: Manual trigger to scan Pronote/Gmail/Calendar/Drive
- **Completed Section**: List of completed tasks (expandable)
- **Task Modal**: Click any task to see:
  - Full task details
  - Steps checklist (with individual checkmarks)
  - "Do this now" hero section (current step)
  - Prepared artifacts (notes, flashcards, quizzes)
  - Links (materials)
  - Board (tutor's session document)
  - "Ask Otto" chat button
  - Dismiss button

**Mobile Behavior**: Tasks are read-only on mobile — you can view the plan, steps, artifacts, links, and board, but cannot mark steps done or interact with the AI.

#### Journal / Flashcards (`/log`)
A learning journal with spaced repetition flashcard review.

**Features**:
- **Weekly View**: Monday-Friday with a free-text entry box for each day ("What did I learn today?")
- **Automatic Card Generation**: When you save a journal entry, Otto automatically generates flashcards from it
- **Weekly Summary**: At week's end, generates a weighted deck focused on what you struggled with most
- **Review Interface**: 
  - Leitner box system (box 1, 2, 3) for spaced repetition
  - Swipe to mark cards as correct/incorrect
  - Visual progress indicators
- **Language Matching**: Flashcards match the language of the journal entry (French → French cards, English → English cards, mixed → mixed)
- **Milestone Tracking**: Shows "milestones" (concepts you've mastered) from your journal

**Mobile Label**: Shown as "Flashcards" on mobile, "Journal" on desktop.

#### Study Mode (`/study/<task-id>`)
A full-screen focused workspace for studying a specific task.

**Features**:
- **Session Setup**: Choose session duration (25min, 45min, 60min, 90min, custom), Pomodoro timer, focus goals
- **Main Workspace**:
  - **Materials Drawer**: PDFs, links, notes, flashcards, quizzes prepared by Otto
  - **Free Notes**: Simple text editor for your own notes
  - **Scratchpad**: Free-form drawing/sketching area
  - **Sticky Notes**: Yellow post-it style notes
  - **Board**: Otto's session document (focus of the day, definitions, formulas, your insights, reasoning summaries)
  - **Ask Otto Panel**: Socratic tutoring chat — Otto asks questions, adapts when an approach doesn't work, never gives direct answers
- **Tools Drawer** (on-demand):
  - Calculator
  - Desmos graphing calculator
  - Bilingual dictionary (French-English)
  - Whiteboard
  - Citation generator (APA/MLA/Chicago)
- **Focus Tracking**: Time spent on task vs. distractions
- **Break Screen**: Appears when session ends with session summary
- **Local-First**: All session data saved locally (IndexedDB) per task, not synced to cloud
- **Custom Background**: Personal wallpaper option

**Desktop Only**: Not available on mobile (desktop and iPad only).

#### Tutor (`/tutor`)
A full-screen AI tutor interface for interactive learning sessions.

**Features**:
- **Socratic Chat**: Otto asks questions, guides you through problems, never gives direct answers
- **Real-time Voice**: Voice input/output for conversational learning
- **Whiteboard**: Interactive drawing surface for visual explanations
- **Desmos Integration**: Graphing calculator for math/physics
- **Adaptive**: Otto adapts approach when something isn't working
- **Guardrails**: Same protections as task chat — never does graded work for you

**Desktop Only**: Full-screen, hides sidebar navigation.

#### Error Log (`/errorlog`)
Track your mistakes for targeted review.

**Features**:
- **Mistake Entry**: Log questions you got wrong, what you answered, and the fix
- **Subject Categorization**: Mistakes organized by subject
- **Trend Tracking**: See if you're improving or declining in each subject
- **Review Mode**: Focus on your recurring mistakes

**Desktop Only**: Hidden on mobile.

#### Settings (`/settings`)
Account and application configuration.

**Features**:
- **Profile**:
  - Name (what Otto calls you)
  - Email
  - Language (French/English)
  - Grades per subject (affects task difficulty)
  - Focus stats (peak focus hour)
- **Integrations**:
  - Connect/disconnect Pronote
  - Connect/disconnect Google (Gmail, Calendar, Drive)
  - Notion (hidden, server-side only)
- **Study Preferences**:
  - Enable/disable Study Mode
- **Account**:
  - Export all data (tasks, jobs, connections — never tokens/passwords)
  - Delete account (instant, permanent, clears all local data)
- **Pause/Unpause**: Stop or resume Otto's AI work
- **Budget**: View monthly AI spend (capped per account)

#### Admin (`/admin`)
Admin dashboard for system administration.

**Features**:
- User management
- System metrics
- Usage statistics

**Admin Only**: Only visible for admin users.

## Special Features

### Task Modal (Overlay)
When you click a task from the dashboard, it opens in a modal overlay:

**Desktop (TaskFocus)**:
- Hero section with current step and action button
- Steps checklist with individual completion
- Prepared artifacts (notes, flashcards, quizzes) with chip-style buttons
- Links section
- Board (tutor's session document)
- "Ask Otto" chat button
- Dismiss/confirm buttons

**Mobile (TaskReadOnly)**:
- Read-only view of task details
- Plan/steps display
- Artifacts (notes, flashcards, quizzes, links)
- Board display
- "Read-only on phone" message

### Study Mode Artifacts
Each artifact type has its own interactive viewer:

- **Notes**: Scrollable text notes
- **Flashcards**: Spaced repetition deck with flip cards, Leitner system
- **Quiz**: Multiple-choice quiz with immediate feedback and scoring
- **Board**: Tutor's session document with entries (focus, definitions, formulas, insights, problems)
- **Calculator**: Basic calculator
- **Desmos**: Graphing calculator for math
- **Dictionary**: Bilingual lookup
- **Whiteboard**: Drawing canvas
- **Citation Generator**: APA/MLA/Chicago citation builder
- **Document**: PDF viewer
- **Video**: Video player
- **Image**: Image viewer
- **Sticky Notes**: Post-it style notes
- **Scratchpad**: Free-form drawing

## What Otto Does / Doesn't Do

**✅ Otto DOES (reversible work):**
- Revision note (plan, definitions, formulas) from Pronote + Drive
- Checklist broken into 10-15 min steps
- Targeted source/video list
- Email draft to teacher (NEVER sent without your tap)

**🔒 Otto NEVER does without you:**
- Send an email, invite to a Calendar event, delete a file → one approval tap required, every time.

**🎓 Otto REFUSES to do:**
- Written dissertation, corrected exercise, test answer. The document created is a guide; the exercise remains a step for YOU to do. This is enforced in code (not just a promise in this README) — see `DOES_STUDENT_WORK` in `server/claude.ts`.

## Tech Stack

- **Backend**: Node + Express (TypeScript), durable job queue Supabase (Postgres)
- **Frontend**: Vite + React (TypeScript)
- **AI**: [DeepSeek](https://deepseek.com) via OpenAI-compatible API
- **Integrations**: [Composio](https://composio.dev) for Gmail/Calendar/Drive; custom Pronote module (`pawnote`, non-official) with AES-256-GCM encrypted token
- **Storage**: [Supabase](https://supabase.com) (Postgres, ideally hosted in EU) — recommended, GDPR-friendly

## Quick Start

```bash
git clone <your-fork> otto && cd otto
cp .env.example .env
#   → fill in DEEPSEEK_API_KEY, COMPOSIO_API_KEY (https://composio.dev), and SESSION_SECRET
npm install
npm run dev          # opens http://localhost:5273
```

That's enough to run locally. Add Supabase (see below) for it to survive a restart.

## Environment Variables

**Required**

| Variable | Purpose |
|-----|---------|
| `DEEPSEEK_API_KEY` | The AI agent (generation + task execution) |
| `COMPOSIO_API_KEY` | Gmail/Calendar/Drive — get from https://composio.dev |
| `SESSION_SECRET` | Signs the session cookie (`openssl rand -hex 32`) |
| `PUBLIC_URL` | Your origin (`http://localhost:5273` in dev, your HTTPS URL in prod) |

**Recommended / Pronote-specific**

| Variable | Purpose |
|-----|---------|
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Cloud persistence (recommended; **required in production**) |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts the Pronote token (AES-256-GCM) before storage. **Without it, Pronote connection refuses to start** (`openssl rand -hex 32`) — other features continue to work without it. |
| `MONTHLY_AI_BUDGET_USD` | Monthly AI spend cap per account (default `3`) |
| `CRON_SECRET` | Protects `/api/cron/drain` (required on Vercel) |
| `DEEPSEEK_MODEL` | Default `deepseek-v4-flash` (or `deepseek-v4-pro` for more reasoning) |
| `PORT` | Default `8788` |
| `PLAID_CLIENT_ID` + `PLAID_SECRET` | **Disabled for now** — see Finance note below. These keys are still read server-side but nothing in the UI leads there anymore. |
| `PLAID_MOCK` | Same — no effect while Finance remains disabled in-product. |

See [`.env.example`](.env.example) for the full annotated list.

> **Finance (Plaid) — disabled for now.** Otto has a complete pipeline for detecting recurring charges/suspicious transactions via bank linking (Plaid), but it's removed from the UI: Plaid remains forced to sandbox server-side (no business approval, no EU bank coverage confirmed), so unusable for a real production account. The code isn't deleted — just disabled by a flag (`FINANCE_ENABLED` in `server/discover.ts`) — until it's ready to ship for real.

## Cloud Persistence (Recommended)

Your profile, tasks, and connections are indexed by account email, to survive restarts and follow you everywhere.

1. Run [`supabase.sql`](supabase.sql) in the Supabase SQL editor (creates tables; **RLS locked by default**).
2. Fill in `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. **The server refuses to start in production without the service key** — it bypasses RLS and must stay server-side only.
3. For a throwaway local Supabase project, you can use the anon key + uncomment the DEV-ONLY policies clearly marked in `supabase.sql`.

## Deploy

```bash
npm run build        # → dist/
npm start            # production: Express serves dist/ + API on $PORT
```

Works on any Node host (Render, Railway, Fly, a VM, or Docker — a `Dockerfile` is provided) and on Vercel (`vercel.json` branches the API function, static hosting, cron, and security headers). Fill in the required variables, point `PUBLIC_URL` to your HTTPS domain, and see the **production checklist** below.

### Production Checklist

- Required variables filled in (startup fails without): `SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`.
- `CREDENTIAL_ENCRYPTION_KEY` filled in if you want Pronote to work — otherwise Pronote connection politely refuses rather than storing in clear.
- `supabase.sql` executed; `SUPABASE_SERVICE_KEY` filled in; anon/service keys never sent to client.
- `CRON_SECRET` filled in (Vercel Cron drains the queue — once per day on Hobby plan, more often on Pro).
- **`SENTRY_DSN` (+ `VITE_SENTRY_DSN` client-side) filled in.** Documented as optional in `.env.example`, they shouldn't be in practice: without them, a sweep/job that fails silently (the job queue swallows the error to never block the pipeline) surfaces NOWHERE — no log consulted, no alert. This is the exact scenario that breaks "proactive" without anyone noticing. Free up to a reasonable volume on [sentry.io](https://sentry.io) or self-hostable.
- Security in place: CSP + security headers, rate-limiting on auth, bcrypt passwords, `httpOnly`/`secure` cookies, no secrets in client bundle, RLS locked by default, AES-256-GCM on the one identifier we store ourselves (Pronote token), plus default encryption-at-rest of Postgres/Supabase on every table.
- `/privacy` and `/terms` published in the app — **required for Google OAuth verification.**
- **Google OAuth**: Gmail/Calendar/Drive are sensitive scopes. Submit the OAuth consent screen with your privacy policy URL + your homepage; until verified, Google caps the app to 100 users and shows an "unverified app" screen.

## What It Does / Doesn't Do

- ✅ Automatically prepares reversible work: drafts (never sent), revision notes, checklists, research/synthesis.
- 🔒 Never irreversible without you: send an email, invite to an event, delete → always one approval tap.
- 🎓 Never does graded work for you: no written dissertation, no corrected exercise, no test answer — the documents created are guides, and the exercise remains a step for you.
- 🧠 Screens Pronote/Gmail/Calendar/Drive for facts; only what *actually needs you* surfaces.
- 🗂️ Data stored by account, encrypted at rest (Postgres/Supabase by default, plus AES-256-GCM app-level on the one identifier we store ourselves); nothing is shared, claimed, or used to train models. The conversation with Otto and the Study Mode Board remain local on the device (`localStorage`, never synced) — they don't follow from device to device, by choice.
- 📤 Built-in GDPR: explicit consent on signup, one-click full data export (`/api/account/export` — tasks, jobs, connections, never tokens/passwords), and instant permanent account deletion from Settings.

## Project Structure

```
client/          React app (Vite)
client/study/    Study Mode — full-screen workspace, tools, artifacts (local-first, IndexedDB)
server/          Express API, job queue, AI agent, integrations
shared/          Types + pure functions shared client & server
tests/           Pure function test suite (npm test)
supabase.sql     Postgres schema + RLS
```

## Development

```bash
npm run dev         # server + client with hot reload
npm test            # pure function tests (no network/AI)
npm run typecheck   # tsc --noEmit
npm run build       # production client build
```

## Contributing

Issues and PRs welcome. Run `npm run typecheck && npm test && npm run build` before opening a PR, and keep style consistent with the existing codebase.

## License

[MIT](LICENSE) © Willem Tjong. Independent project, not affiliated with or approved by Pronote/Index Éducation, Google, Composio, DeepSeek, or Supabase.
