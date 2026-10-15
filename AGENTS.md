# Dev Environment — Otto Lycée

## What this is

- **Backend**: `tsx watch server/index.ts` (Express, port 8788, hot restart on server file change)
- **Frontend**: Vite 6 dev server (port 5273, HMR)
- `npm run dev` uses `concurrently` to start both processes together
- Vite proxies `/api`, `/auth`, `/integrations` to Express on 8788

## Key setup notes

1. **No env vars are required to boot in dev mode** — the server's fail-closed checks (`SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`) only run with `NODE_ENV=production`. The app boots and renders its landing/login UI without any credentials.
2. **What doesn't work without credentials** (all gracefully degraded):
   - No `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` → `cloudEnabled()` is false; login/signup return 500 ("Account storage isn't configured"); session store falls back to in-memory
   - No `DEEPSEEK_API_KEY` → `aiReady()` false; all AI generation routes refuse
   - No `COMPOSIO_API_KEY` → `integrationsReady()` false; Gmail/Calendar/Drive connect flows refuse
   - No `CREDENTIAL_ENCRYPTION_KEY` → Pronote connect refuses (deliberate fail-closed)
3. **`predev` runs `scripts/zip-extension.sh`** which packages the Chrome extension into `public/otto-tabs-extension.zip`. It gracefully skips when `zip` isn't installed — harmless.
4. **`/healthz` on the Express backend (8788) is NOT proxied by Vite** — only `/api`, `/auth`, `/integrations` are.
5. **Repo runs everything from one `package.json`** at the root — client code in `client/`, server in `server/`, shared types in `shared/`. `index.html` at root is Vite's entry.

## How to verify

- `curl -s localhost:5273/api/status` → JSON with `loggedIn: false, cloud: false, aiReady: false` (values reflect which credentials are set)
- Landing page renders French marketing copy + login form at `localhost:5273/`

## Task execution architecture (non-blocking)

- **Kick loop** (`/api/jobs/kick`): awaits `drain(1)` for the caller's own jobs only. On Vercel, work detached from a request can be frozen, so it must run inside the request. `claimJob` is atomic, so a concurrent kick finds the job already claimed and returns.
- **`enqueueAndDrain`** (jobs.ts): manual actions (`runViaJob`: run, revise, run step) and the sweep drain ONE job inline (`drainInline = true`). Task creation and post-sweep auto-runs pass `false` and leave the work to the kick loop.
- **Time limits**: Vercel functions die at 300 s. `drain()` won't start a new job after 120 s, the cron tick stops enqueueing at 100 s and starting jobs at 150 s, and a job killed mid-run is retried once its 6-minute lock (`LOCK_MS`, kept fresh by a heartbeat while alive) expires.
- **Background saves**: on Vercel, `commit()` writes the account row immediately and holds the function open with `waitUntil`; locally it debounces (syncScheduler.ts).
- **Chat** (`/api/tasks/:id/chat`): when the AI fails but `chatAboutTask` provides a fallback reply, the route returns 200 with the reply and saves artifacts — chat always returns a response, never a hard 500.

## Local dev

```bash
cp .env.example .env  # fill DEEPSEEK_API_KEY, COMPOSIO_API_KEY, SESSION_SECRET
npm install
npm run dev           # http://localhost:5273
```

## Tutor architecture (server/tutorTurn/)

- `POST /api/tasks/:id/chat` with `primer:true` runs **one structured model call** per turn (`engine.ts`): the model returns JSON (`shared/tutorTurn.ts`): what it heard, a diagnosis, one **move** from a fixed set, a support level, the speech as sentences, and board ops that each carry a `cue` (the sentence they belong to).
- **Code owns the rules**: `policy.ts` caps the support level (rises at most +1 a turn; explaining unlocks when they're lost, ask why, or are stuck twice), `verify.ts` runs ~10 structural checks (answer leaks, pointers at missing lines, question count, length budget, arithmetic, repeats), then at most one repair call, then `degradeTurn` removes only the offending bits. There are no canned replies.
- `apply.ts` turns the ops into board entries (topic, step, gap, mark, draw, problem, plan); `ledger.ts` keeps the assistance ledger (help at support ≥ 4 is retested next sitting) and builds the recap (`POST /api/tasks/:id/tutor/close`). Tool-call text is stripped in `normalizeTurn`.
- Tests: `tests/tutor-turn-sim.mjs` (scripted fake model, real engine) and `tests/tutor-ledger-sim.mjs`.
- Known gaps: answer keys still travel with the board to the browser; Study Mode chat (`server/ai/chat*.ts`) still uses the older tutorBrain/sessionState modules.
- Voice: the mic is closed while Otto thinks or speaks (the Web Speech API can't tell his voice from the student's); the student interrupts with the "Interrupt" button, which reopens the mic at once. `echoGuard` only drops text when the mic was open during speech.
- Session craft (`guide.ts`, `exercises.ts`): opens with a plan, makes a right answer solid, questions are pitched at the Settings level and built from the board (harder while they succeed), every exercise is checked against all earlier ones (this session + on-device memory) and the question kind is varied; a reply that says nothing specific is repaired. Drawings: `describeWhiteboard` (server/ai/voice.ts) gets what they're working on and returns TEXT / DRAWING / LOOKS LIKE.
- JSON + LaTeX: models write LaTeX with single backslashes inside their JSON, which corrupts `\t…` (tab) and breaks `\s…`; `fixJsonBackslashes` (shared/tutorTurn.ts) repairs it before parsing and the prompt shows doubled backslashes; `repairLatex` also heals boards saved with the corruption. The verifier rejects objects nobody mentioned (`inventedObjects`), and the engine states THE PROBLEM RIGHT NOW and drops a saved solution for a different problem.
