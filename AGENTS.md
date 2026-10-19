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

- Deliberately simple: `POST /api/tasks/:id/chat` with `primer:true` makes **one model call** per turn (`engine.ts`). The system prompt (`prompt.ts`: Otto is a Socratic tutor who teaches on the board) carries the student's background, the board listing and the figure specs; the history and the new message follow. The model returns `{speech:[sentences], board:[ops]}` (`shared/tutorTurn.ts`).
- Board ops are `topic`, `step`, `mark`, `draw`; each has a `cue` (the sentence it belongs to). `apply.ts` turns them into board entries (figures drawn to scale by code; duplicates and marks on missing lines dropped).
- No verification, repair calls, support levels, goal interview, exercise generator or answer keys. Every word the student reads is the model's own; prose instead of JSON is spoken as it is; a provider failure is a 503 with Retry-After.
- Still around: `ledger.ts` (recap at `POST /api/tasks/:id/tutor/close`), `keySeal.ts` / `problemCheck.ts` (sealed keys for exercises from older boards).
- Tests: `tests/tutor-turn-sim.mjs` (scripted fake model, real engine).
- Voice: the mic is closed while Otto thinks or speaks; the student interrupts with the "Interrupt" button.

- AI cost meter (`shared/types.ts` `callCostUsd`): per-model rates (V4-Flash $0.14 miss / $0.0028 hit / $0.28 out per 1M, off-peak; peak ×2; weekends off-peak), cache hits priced separately (`usageOf` reads them; auto-runs now count them too), reasoning tokens billed as output, and calls Gemini served are not put on the DeepSeek meter. Rates can be corrected with `DEEPSEEK_PRICING` (JSON). The V4-Pro rates are the least certain.
- Speed (`engine.ts`, `routes/tasks.ts`): the exercise generator starts alongside the tutor's own call when they ask for one (checks about text the generator replaces are skipped), a solve for a new problem runs alongside the turn (`solutionPromise`, awaited just before verifying), a repair call only happens for a hard issue or two soft ones, the Gemini attempt times out at 7 s before falling back. Objectives the session never supports (an economics goal left in a physics session) are purged each turn (`cleanObjectives`) and the stored plan is replaced.
- Goals before the plan (`goals.ts`): with no plan yet the tutor asks ONE question at a time about what they want from the sitting (aim, when it's due / what's hardest, how long — grounded in level, courses and memory), at most 3 questions, reporting what it learns in `goals` (saved on the teaching state). A `plan` op before `goalsKnown` is `plan_too_early` (repair, then dropped); the plan is made at once when the first message already gives the aim plus one more fact, or they say "just start".
- Never claim what isn't there: a sentence that points at a curve/graph/figure while the board has none, or says "here is a new problem" when no exercise was placed, is stripped (or the reply rewritten); a reply that ignores a numeric answer (by the model's own `heard`) is repaired.
- Nothing left to follow up (`engine.ts`, `apply.ts`): a reply that only announces a task ("Let's examine a student's solution…", "Now let's check your intuition…") with no question, exercise or board line is completed by the app (the exercise generator runs, else one rewrite that ends on a question). A student step that is speech-recognition text ("about 56% is what I would say right yeah…") is cut to the value they gave (`valueOfSpeech`, "≈ 56%") or dropped, never written as-is.
- Exercise honesty (`problemGen.ts`, `verify.ts`): statements get real line breaks (`tidyQuestion`); an error-spotting exercise must name its mistake and a fresh temperature-0 call recomputes every line (`mistakeConfirmed`) — no confirmed error, no exercise; explanations that think aloud ("wait, let's re-verify") are rejected (`rambles`); a reply that says "that's right" over a widget mark of wrong (or the reverse) is a hard `verdict_mismatch` issue.
