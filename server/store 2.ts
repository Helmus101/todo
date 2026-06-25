import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebTask, Profile } from "../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../shared/types.ts";

// Cloud persistence, keyed by the user's Google email — so memory + tasks survive restarts and follow
// the ACCOUNT, not the browser cookie. Reuses the repo's existing Supabase project. Prefers a service
// key (bypasses RLS) if provided; otherwise the anon key + the permissive policy in web/supabase.sql.
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const TABLE = "weave_web_state";

const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

export const cloudEnabled = (): boolean => !!client;

export interface AccountState { profile: Profile; tasks: WebTask[]; }

/** Load an account's saved profile + tasks. Returns empty state if cloud is off or the row is missing. */
export async function loadState(email?: string): Promise<AccountState> {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  try {
    const { data, error } = await client.from(TABLE).select("profile,tasks").eq("email", email).maybeSingle();
    if (error) { console.warn("[store] load failed:", error.message); return { profile: emptyProfile(), tasks: [] }; }
    return { profile: normalizeProfile(data?.profile), tasks: Array.isArray(data?.tasks) ? data!.tasks : [] };
  } catch (e) { console.warn("[store] load threw:", (e as any)?.message || e); return { profile: emptyProfile(), tasks: [] }; }
}

/** Persist an account's profile + tasks (best-effort; never throws into the request path). */
export async function saveState(email: string | undefined, state: AccountState): Promise<void> {
  if (!client || !email) return;
  try {
    const { error } = await client.from(TABLE).upsert(
      { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], updated_at: new Date().toISOString() },
      { onConflict: "email" }
    );
    if (error) console.warn("[store] save failed:", error.message);
  } catch (e) { console.warn("[store] save threw:", (e as any)?.message || e); }
}
