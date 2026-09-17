# Base44 Dev Environment — Otto Lycée

## What this is

`docker-compose.base44.yml` runs this repo in development mode with live reload:

- **Single service** (`node:24-slim`): runs `npm ci && npm run dev`
- `npm run dev` uses `concurrently` to start BOTH processes in one container:
  - **Backend**: `tsx watch server/index.ts` (Express, port 8788, hot restart on server file change)
  - **Frontend**: `wait-on tcp:127.0.0.1:8788 && vite` (Vite 6, port 5273, HMR)
- Vite proxies `/api`, `/auth`, `/integrations` to Express on 8788
- **Host port 3000 maps to Vite's 5273** — the preview entry point

## Key setup decisions (non-obvious)

1. **`vite.config.ts` has `server.host: true`** (added for Base44) so the dev server binds 0.0.0.0 — without it the preview proxy can't reach Vite inside the container.
2. **Vite allowed hosts**: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is passed bare in the compose `environment:` — Vite >= 6.1 appends it to its allowedHosts.
3. **No env vars are required to boot in dev mode** — the server's fail-closed checks (`SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`) only run with `NODE_ENV=production`. The app boots and renders its landing/login UI without any credentials.
4. **What doesn't work without credentials** (all gracefully degraded):
   - No `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` → `cloudEnabled()` is false; login/signup return 500 ("Account storage isn't configured"); session store falls back to in-memory
   - No `DEEPSEEK_API_KEY` → `aiReady()` false; all AI generation routes refuse
   - No `COMPOSIO_API_KEY` → `integrationsReady()` false; Gmail/Calendar/Drive connect flows refuse
   - No `CREDENTIAL_ENCRYPTION_KEY` → Pronote connect refuses (deliberate fail-closed)
5. **`predev` runs `scripts/zip-extension.sh`** which packages the Chrome extension into `public/otto-tabs-extension.zip`. It gracefully skips when `zip` isn't installed (as in `node:24-slim`) — harmless.
6. **`/healthz` on the Express backend (8788) is NOT proxied by Vite** — only `/api`, `/auth`, `/integrations` are. The compose healthcheck fetches Vite's root (5273) instead.
7. **Repo runs everything from one `package.json`** at the root — client code in `client/`, server in `server/`, shared types in `shared/`. `index.html` at root is Vite's entry.

## How to verify

- `curl -s localhost:3000/api/status` → JSON with `loggedIn: false, cloud: false, aiReady: false` (values reflect which credentials are set)
- Landing page renders French marketing copy + login form at `localhost:3000/`

## Env precedence

`.env.base44-defaults` (repo, placeholders FIRST) → `/run/base44/app.env` (platform secrets, LAST — always wins). `PUBLIC_URL` is set via compose `environment:` from `BASE44_PUBLIC_HOST_SUFFIX` (never hardcode the host value).

## Local dev (outside Base44)

```bash
cp .env.example .env  # fill DEEPSEEK_API_KEY, COMPOSIO_API_KEY, SESSION_SECRET
npm install
npm run dev           # http://localhost:5273
```
