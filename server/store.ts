import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import session from "express-session";
import type { Credentials } from "google-auth-library";
import type { WebTask, Profile } from "../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../shared/types.ts";

/** A persisted Google connection for an account (incl. the refresh token, so it stays connected). */
export interface StoredGoogle { tokens: Credentials; email?: string; }

// Cloud persistence, keyed by the user's Google email — so memory + tasks survive restarts and follow
// the ACCOUNT, not the browser cookie. Reuses the repo's existing Supabase project. Prefers a service
// key (bypasses RLS) if provided; otherwise the anon key + the permissive policy in web/supabase.sql.
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const TABLE = "weave_web_state";

const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
// Secrets (refresh tokens, password hashes) live in these tables. With the ANON key + the permissive dev RLS
// policy they're readable by anyone holding that key — fine locally, NOT for production. So: FAIL CLOSED in
// production (don't boot with a secret-exposing config), and warn loudly in dev. Fix is SUPABASE_SERVICE_KEY
// (bypasses RLS) + restricting RLS to the service role.
if (client && !process.env.SUPABASE_SERVICE_KEY) {
  const msg = "Supabase is configured with the ANON key — refresh tokens + password hashes would be readable by anyone holding it.";
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[store] ${msg} Set SUPABASE_SERVICE_KEY (and restrict RLS to the service role) before deploying.`);
  }
  console.warn(`[store] SECURITY: ${msg} Fine locally; set SUPABASE_SERVICE_KEY before you deploy.`);
}

export const cloudEnabled = (): boolean => !!client;
const USERS = "weave_web_users";
const SESSIONS = "weave_web_sessions";

/**
 * A persistent express-session store backed by Supabase, so logins AND working state (tasks/profile)
 * survive server restarts + deploys — not just the cloud account row, but the live session. Without this,
 * the default in-memory store is wiped on every restart, forcing re-login and making changes look "lost".
 * Returns undefined when cloud is unconfigured (express-session then falls back to its MemoryStore).
 */
export async function makeSessionStore(): Promise<session.Store | undefined> {
  if (!client) return undefined;
  const c = client;
  // Probe the table first — if it doesn't exist yet (user hasn't run the latest supabase.sql), fall back to
  // the default in-memory store so login still works, with a clear warning. Never break auth on a missing table.
  const { error: probe } = await c.from(SESSIONS).select("sid").limit(1);
  if (probe) { console.warn(`[store] persistent sessions OFF — run web/supabase.sql to create '${SESSIONS}' (${probe.message}). Using in-memory sessions (lost on restart).`); return undefined; }
  const ttlMs = (sess: any) => (sess?.cookie?.maxAge ?? 30 * 24 * 3600 * 1000);
  const expiry = (sess: any) => new Date(Date.now() + ttlMs(sess)).toISOString();
  class SupabaseStore extends session.Store {
    get(sid: string, cb: (err: any, sess?: any) => void) {
      c.from(SESSIONS).select("sess,expire").eq("sid", sid).maybeSingle().then(
        ({ data, error }) => {
          if (error) return cb(error);
          if (!data) return cb(null, null);
          if (data.expire && new Date(data.expire).getTime() < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
          cb(null, data.sess);
        },
        (e) => cb(e),
      );
    }
    set(sid: string, sess: any, cb?: (err?: any) => void) {
      c.from(SESSIONS).upsert({ sid, sess, expire: expiry(sess) }, { onConflict: "sid" }).then(
        ({ error }) => cb?.(error || undefined),
        (e) => cb?.(e),
      );
    }
    destroy(sid: string, cb?: (err?: any) => void) {
      c.from(SESSIONS).delete().eq("sid", sid).then(({ error }) => cb?.(error || undefined), (e) => cb?.(e));
    }
    touch(sid: string, sess: any, cb?: (err?: any) => void) {
      c.from(SESSIONS).update({ expire: expiry(sess) }).eq("sid", sid).then(() => cb?.(), () => cb?.());
    }
  }
  return new SupabaseStore();
}

/** Look up an account by email → its bcrypt hash (or null if no such user / cloud off). */
export async function getUser(email: string): Promise<{ email: string; pass_hash: string } | null> {
  if (!client) return null;
  try {
    const { data } = await client.from(USERS).select("email,pass_hash").eq("email", email).maybeSingle();
    return data ? { email: data.email, pass_hash: data.pass_hash } : null;
  } catch (e) { console.warn("[store] getUser threw:", (e as any)?.message || e); return null; }
}

/** Create an account. Returns false if it already exists or the write fails. */
export async function createUser(email: string, passHash: string): Promise<boolean> {
  if (!client) return false;
  try {
    const { error } = await client.from(USERS).insert({ email, pass_hash: passHash });
    if (error) { console.warn("[store] createUser failed:", error.message); return false; }
    return true;
  } catch (e) { console.warn("[store] createUser threw:", (e as any)?.message || e); return false; }
}

export interface AccountState { profile: Profile; tasks: WebTask[]; google?: StoredGoogle; }

/** Load an account's saved profile + tasks + Google connection. Empty if cloud off or row missing. */
export async function loadState(email?: string): Promise<AccountState> {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  try {
    const { data, error } = await client.from(TABLE).select("profile,tasks,google").eq("email", email).maybeSingle();
    if (error) { console.warn("[store] load failed:", error.message); return { profile: emptyProfile(), tasks: [] }; }
    const google = data?.google && (data.google as any).tokens ? (data.google as StoredGoogle) : undefined;
    return { profile: normalizeProfile(data?.profile), tasks: Array.isArray(data?.tasks) ? data!.tasks : [], google };
  } catch (e) { console.warn("[store] load threw:", (e as any)?.message || e); return { profile: emptyProfile(), tasks: [] }; }
}

/** Persist an account's profile + tasks + Google connection (best-effort; never throws into the request path). */
export async function saveState(email: string | undefined, state: AccountState): Promise<void> {
  if (!client || !email) return;
  try {
    const { error } = await client.from(TABLE).upsert(
      { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], google: state.google ?? null, updated_at: new Date().toISOString() },
      { onConflict: "email" }
    );
    if (error) console.warn("[store] save failed:", error.message);
  } catch (e) { console.warn("[store] save threw:", (e as any)?.message || e); }
}
