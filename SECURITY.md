# Security Policy

Otto reads people's inbox, calendar, and Drive, so security reports are taken seriously and triaged quickly.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, email **tjong.willem@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one), and
- any suggested remediation.

You'll get an acknowledgement within **72 hours**, and a fix or mitigation plan for confirmed issues as fast as is practical. Please give a reasonable window to remediate before any public disclosure.

## Scope

Most relevant to Otto's threat model:

- **The permission layer** — the guarantee that the agent can never run an irreversible *outbound* or *destructive* action unattended. The enforcement lives in [`server/integrations.ts`](server/integrations.ts) (`isGatedAction` / `isWriteGatedAction`, backed by the `ACTION_POLICIES` registry and a deny-by-default fallback). A way to make the agent send, post, delete, or pay without an explicit user click is the highest-severity class of bug.
- **Prompt injection** — content in a read email/event/doc steering the agent into a gated action or exfiltrating data.
- **Auth / session** — anything that lets one account read or act on another's data.
- **Secret exposure** — refresh tokens, password hashes, or API keys reachable by a non-service principal. Note the server **refuses to boot in production without `SUPABASE_SERVICE_KEY`** and ships RLS deny-by-default (see [`supabase.sql`](supabase.sql)).

## Handling secrets when you self-host

- Keep `SUPABASE_SERVICE_KEY` server-side only; it bypasses RLS.
- Set a strong `SESSION_SECRET` (`openssl rand -hex 32`) and `CRON_SECRET` in production.
- Never commit a real `.env`. Bring your own `DEEPSEEK_API_KEY` and `COMPOSIO_API_KEY`.
