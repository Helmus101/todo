# Weave Web — the to-do list that does itself

A standalone web app (separate from the Weave desktop app, lives under `web/`). Connect Google →
it reads your Gmail + Calendar, generates your real to-dos, and **auto-runs the reversible work**
(drafts, briefs/docs, research) the moment a task appears — leaving you only a short checklist of
the acts only you can do. It never sends or changes anything irreversibly without you.

- **Backend:** Node + Express (its own stack — not Weave's Electron/sql.js).
- **Frontend:** Vite + React.
- **Reuses** your existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ANTHROPIC_API_KEY`.

## 1. Google Cloud setup (one-time)

A web app needs a **Web application** OAuth client (a Desktop client won't accept a web redirect):

1. [Google Cloud Console](https://console.cloud.google.com/) → your project → **APIs & Services**.
2. **Enable APIs**: Gmail API, Google Calendar API, Google Docs API, Google Drive API.
3. **OAuth consent screen**: keep it in **Testing** and add your own Google account under **Test users**
   (in Testing mode these sensitive scopes need **no Google verification**).
4. **Credentials → Create credentials → OAuth client ID → Web application**. Add **Authorized redirect URIs**:
   - Local: `http://localhost:5173/auth/google/callback`
   - Deployed: `https://YOUR-DOMAIN/auth/google/callback`
5. Copy the client ID + secret into `.env` below. (If your existing Weave client is the *Web* type, you can
   reuse it — just add the two redirect URIs above to it.)

## 2. Configure

```bash
cd web
cp .env.example .env
# paste your GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY (same as Weave's root .env),
# set SESSION_SECRET to a long random string, and set PUBLIC_URL.
npm install
```

## 3. Run locally

```bash
npm run dev      # Vite on :5173 (proxying API to the Express server on :8787)
# open http://localhost:5173  → Connect Google
```

`PUBLIC_URL` should be `http://localhost:5173` for local dev (matches the redirect URI above).

## 4. Deploy (single Node service)

Build the client and run the server, which serves it:

```bash
npm run build    # → dist/
npm start        # production: Express serves dist/ + the API on $PORT
```

Deploy to any long-running Node host (Render / Railway / Fly / a VM). Set the env vars there, set
`PUBLIC_URL=https://your-domain`, add `https://your-domain/auth/google/callback` to the Google client's
redirect URIs, and you're live. A `Dockerfile` is included.

> **Note (v1):** sessions + the generated task list are kept in server memory, so a redeploy/restart
> means re-connecting Google. For an always-persistent multi-instance deploy, swap the default session
> store + the in-session task list for a real store (Redis/Postgres) — the code is structured for it.

## What it does / doesn't

- **Auto-runs reversible prep:** drafts (never sent), Google Docs, research/synthesis.
- **Never irreversible without you:** sending email, calendar invites, payments → surface as a checklist.
- **Asks nothing:** it mines your mail/calendar for the facts; only acts that *require you* show up.
