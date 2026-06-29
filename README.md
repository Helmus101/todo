# Weave Web — the to-do list that does itself

A standalone web app that reads your Gmail, Calendar, and connected apps (Slack, GitHub, Notion, etc.), generates your real to-dos, and **auto-runs the reversible work** (drafts, briefs/docs, research) the moment a task appears — leaving you only a short checklist of the acts only you can do. It never sends or changes anything irreversibly without you.

- **Backend:** Node + Express
- **Frontend:** Vite + React
- **Integrations:** Composio (Gmail, Calendar, Slack, GitHub, Notion, Linear, Todoist, and more)
- **AI:** Anthropic Claude for task generation and execution

## Quick Start

```bash
cd web
cp .env.example .env
# Set ANTHROPIC_API_KEY and COMPOSIO_API_KEY (get from https://composio.dev)
# Set SESSION_SECRET to a long random string
npm install
npm run dev      # Open http://localhost:5273
```

## Required Environment Variables

- `ANTHROPIC_API_KEY` - For Claude AI (task generation + execution)
- `COMPOSIO_API_KEY` - For app integrations (get from https://composio.dev)
- `SESSION_SECRET` - Long random string for session signing
- `PUBLIC_URL` - Your app's URL (http://localhost:5273 locally, https://your-domain in production)

## Optional Environment Variables

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` - For cloud persistence (tasks/profile survive restarts)
- `SUPABASE_SERVICE_KEY` - More secure than anon key (bypasses RLS)
- `CLAUDE_MODEL` - Default: claude-opus-4-8
- `PORT` - Default: 8788

## Cloud Persistence (Recommended)

Your profile, tasks, and app connections are saved to Supabase keyed by your account email, so they survive restarts/redeploys and follow your account.

**Setup:**
1. Run `web/supabase.sql` in the Supabase SQL editor to create the tables
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`
3. For production, set `SUPABASE_SERVICE_KEY` instead (more secure)

## Deploy

```bash
npm run build    # → dist/
npm start        # Production: Express serves dist/ + API on $PORT
```

Deploy to any Node host (Render, Railway, Fly, VM). Set env vars, set `PUBLIC_URL=https://your-domain`.

A `Dockerfile` is included for containerized deployments.

## What it does / doesn't

- **Auto-runs reversible prep:** drafts (never sent), Google Docs, research/synthesis
- **Never irreversible without you:** sending email, calendar invites, payments → surface as a checklist
- **Asks nothing:** it mines your mail/calendar for the facts; only acts that *require you* show up
- **Multi-account support:** Connect multiple Gmail accounts and other apps
- **Privacy-first:** All data stored per account; nothing shared

## Opening tabs (optional Chrome extension)

Steps that mean "open a page" open a tab. With the extension in `web/extension/`, pages open unattended and are collected into a named tab group.

Load it: `chrome://extensions` → Developer mode → Load unpacked → select `web/extension/`
