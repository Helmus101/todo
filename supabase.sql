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

-- NOTE: the `google` column + `weave_web_users.pass_hash` are SECRETS. With the anon key + the permissive
-- policy below they're readable by anyone holding the (semi-public) anon key — fine for personal use, but
-- for a real/shared deploy run the server with SUPABASE_SERVICE_KEY (bypasses RLS) and drop these policies.

-- Email/password accounts. Profile + tasks above are keyed by this account's email.
create table if not exists weave_web_users (
  email text primary key,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
alter table weave_web_users enable row level security;
drop policy if exists "weave_web_users server access" on weave_web_users;
create policy "weave_web_users server access" on weave_web_users
  for all using (true) with check (true);

-- The Express server is the trust boundary (it only reads/writes the OAuth-verified user's row).
-- With a SUPABASE_SERVICE_KEY, skip the policy (the service key bypasses RLS). With the anon key
-- (default here), enable RLS + this permissive policy so the server can read/write.
alter table weave_web_state enable row level security;

drop policy if exists "weave_web_state server access" on weave_web_state;
create policy "weave_web_state server access" on weave_web_state
  for all using (true) with check (true);

-- Persistent sessions — so logins + working state survive server restarts/deploys (not just the
-- account row). One row per session id. Expired rows are cleaned lazily on read.
create table if not exists weave_web_sessions (
  sid text primary key,
  sess jsonb not null,
  expire timestamptz not null
);
alter table weave_web_sessions enable row level security;
drop policy if exists "weave_web_sessions server access" on weave_web_sessions;
create policy "weave_web_sessions server access" on weave_web_sessions
  for all using (true) with check (true);
