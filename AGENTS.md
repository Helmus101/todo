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

- **Kick loop** (`/api/jobs/kick`): fires `drain()` in the background and returns immediately — the client's 4s poll loop is never blocked by a long AI call. `claimJob` is atomic, so the next kick finds the job already claimed and returns instantly.
- **`enqueueAndDrain`** (jobs.ts): accepts `drainInline` param. Task creation and `runViaJob` pass `false` → the HTTP response returns immediately with the task in "queued" status, and the kick loop processes the job within seconds. No timeout/limit on the work itself.
- **Chat** (`/api/tasks/:id/chat`): when the AI fails but `chatAboutTask` provides a fallback reply, the route returns 200 with the reply and saves artifacts — chat always returns a response, never a hard 500.

## Local dev

```bash
cp .env.example .env  # fill DEEPSEEK_API_KEY, COMPOSIO_API_KEY, SESSION_SECRET
npm install
npm run dev           # http://localhost:5273
```
