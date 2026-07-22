-- Run once in the Supabase SQL editor (same project Weave uses). One row per Google account holds that
-- account's PROFILE (who they are: about + preferences + people + projects) and task list, so the web
-- app persists across restarts and follows the account. Re-running is safe (idempotent).

create table if not exists weave_web_state (
  email text primary key,
  profile jsonb not null default '{}'::jsonb,
  tasks   jsonb not null default '[]'::jsonb,
  google  jsonb,                                   -- persisted Google connection (incl. refresh token)
  updated_at timestamptz not null default now()
);

-- If you created this table from an earlier version, add the newer columns:
alter table weave_web_state add column if not exists profile jsonb not null default '{}'::jsonb;
alter table weave_web_state add column if not exists google jsonb;

-- SECURE BY DEFAULT: `weave_web_users.pass_hash` and the `google`/`profile` columns are SECRETS. This file
-- enables RLS with NO public policy, so the anon key can read/write NOTHING. Production runs the server with
-- SUPABASE_SERVICE_KEY, which bypasses RLS — that's the only credential that should ever touch these tables.
-- (For local dev with ONLY the anon key, uncomment the DEV-ONLY block at the very bottom of this file.)

-- Email/password accounts. Profile + tasks above are keyed by this account's email.
create table if not exists weave_web_users (
  email text primary key,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
alter table weave_web_users enable row level security;
-- Remove any permissive policy an older run of this file created.
drop policy if exists "weave_web_users server access" on weave_web_users;

-- The Express server is the trust boundary (it only reads/writes the OAuth-verified user's row), and it
-- connects with the service role — so no public policy is needed or wanted here.
alter table weave_web_state enable row level security;
drop policy if exists "weave_web_state server access" on weave_web_state;

-- Persistent sessions — so logins + working state survive server restarts/deploys (not just the
-- account row). One row per session id. Expired rows are cleaned lazily on read.
create table if not exists weave_web_sessions (
  sid text primary key,
  sess jsonb not null,
  expire timestamptz not null
);
alter table weave_web_sessions enable row level security;
drop policy if exists "weave_web_sessions server access" on weave_web_sessions;

-- ── Durable job queue ─────────────────────────────────────────────────────────
-- Server-side execution (sweeps + task runs) is queued here and drained by GET /api/cron/drain
-- (Vercel Cron) or inline by the request that enqueued it. DB rows ARE the lock: claiming is a
-- conditional UPDATE, so it's safe across serverless instances — no in-memory state required.
create table if not exists weave_web_jobs (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  task_id text,
  type text not null,                       -- sweep | execute_task | execute_step | revise
  status text not null default 'queued',    -- queued | running | succeeded | failed_retryable | failed_terminal | cancelled
  attempt_count int not null default 0,
  max_attempts int not null default 3,
  idempotency_key text not null,            -- e.g. "email:execute_task:taskId" — one ACTIVE job per key
  locked_by text,
  locked_until timestamptz,
  input jsonb,
  output jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- One ACTIVE job per idempotency key (a finished job doesn't block re-running the same task later).
create unique index if not exists weave_web_jobs_active_key
  on weave_web_jobs (idempotency_key) where status in ('queued', 'running');
create index if not exists weave_web_jobs_claim on weave_web_jobs (status, created_at);
create index if not exists weave_web_jobs_user on weave_web_jobs (user_email, created_at desc);

-- Per-task timeline: everything that happened, when, by which job — the audit trail the UI shows.
create table if not exists weave_web_job_events (
  id bigint generated always as identity primary key,
  user_email text not null,
  task_id text,
  job_id uuid,
  kind text not null,                        -- queued | run_started | run_succeeded | run_failed | sweep_done | sent | confirmed | dismissed | …
  message text,
  at timestamptz not null default now()
);
create index if not exists weave_web_job_events_task on weave_web_job_events (user_email, task_id, at desc);

-- LOCKED DOWN: no permissive policies on the job tables — production runs with SUPABASE_SERVICE_KEY
-- (bypasses RLS). Dev with only the anon key can't reach them; the server detects that and falls back
-- to its in-memory queue (fine for a single dev process).
alter table weave_web_jobs enable row level security;
alter table weave_web_job_events enable row level security;

-- ── DEV ONLY — local setups running with the ANON key (no service key) ────────────────────────
-- DO NOT run this in production. These permissive policies let the semi-public anon key read/write the
-- secret tables (password hashes, OAuth tokens) — acceptable only on a throwaway local project. In
-- production the server uses SUPABASE_SERVICE_KEY (bypasses RLS) and boots refuse without it, so leave
-- this commented out. Uncomment ONLY for anon-key local development:
--   create policy "weave_web_users server access"    on weave_web_users    for all using (true) with check (true);
--   create policy "weave_web_state server access"    on weave_web_state    for all using (true) with check (true);
--   create policy "weave_web_sessions server access" on weave_web_sessions for all using (true) with check (true);
--   create policy "weave_web_jobs server access"       on weave_web_jobs       for all using (true) with check (true);
--   create policy "weave_web_job_events server access" on weave_web_job_events for all using (true) with check (true);
