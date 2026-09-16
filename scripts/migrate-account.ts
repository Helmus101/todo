// One-off migration: merge an account's data from a TEMPORARY Supabase project (used while the real
// project's egress quota was exhausted) back into the REAL/target project once you're done with the temp
// one. Merges rather than overwrites — the target project's existing tasks/profile (from before the
// outage) are kept, and the temp project's tasks accumulated during the outage are unioned in on top,
// using the EXACT SAME merge logic the app itself uses for cross-device sync (mergeTaskLists/
// mergeProfileStates, server/tasks.ts) so this can't silently diverge from how the app would have merged
// them itself. Never touches weave_web_users, google/pronote/plaid connections, or any other table — those
// belong to whichever project you're actually keeping, not the throwaway temp one.
//
// Usage:
//   SOURCE_SUPABASE_URL=... SOURCE_SUPABASE_SERVICE_KEY=... \
//   TARGET_SUPABASE_URL=... TARGET_SUPABASE_SERVICE_KEY=... \
//   npx tsx scripts/migrate-account.ts you@example.com
//
// Add --dry-run to print what WOULD be written without touching the target project.
import "../server/env.ts";
import { createClient } from "@supabase/supabase-js";
import { mergeTaskLists, mergeProfileStates } from "../server/tasks.ts";
import { emptyProfile, normalizeProfile, type WebTask, type Profile } from "../shared/types.ts";

const TABLE = "weave_web_state";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return v;
}

async function main() {
  const email = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!email || !email.includes("@")) {
    console.error("Usage: npx tsx scripts/migrate-account.ts you@example.com [--dry-run]");
    process.exit(1);
  }

  const sourceUrl = reqEnv("SOURCE_SUPABASE_URL");
  const sourceKey = reqEnv("SOURCE_SUPABASE_SERVICE_KEY");
  const targetUrl = reqEnv("TARGET_SUPABASE_URL");
  const targetKey = reqEnv("TARGET_SUPABASE_SERVICE_KEY");

  const source = createClient(sourceUrl, sourceKey, { auth: { persistSession: false } });
  const target = createClient(targetUrl, targetKey, { auth: { persistSession: false } });

  console.log(`Reading "${email}" from SOURCE (temp) project…`);
  const { data: srcRow, error: srcErr } = await source.from(TABLE).select("profile,tasks").eq("email", email).maybeSingle();
  if (srcErr) { console.error("Source read failed:", srcErr.message); process.exit(1); }
  if (!srcRow) { console.error(`No row found for "${email}" in the source (temp) project — nothing to migrate.`); process.exit(1); }
  const srcTasks: WebTask[] = Array.isArray(srcRow.tasks) ? srcRow.tasks : [];
  const srcProfile: Profile = normalizeProfile(srcRow.profile);
  console.log(`  found ${srcTasks.length} task(s) in the temp account.`);

  console.log(`Reading "${email}" from TARGET (real) project…`);
  const { data: tgtRow, error: tgtErr } = await target.from(TABLE).select("profile,tasks,google,pronote,plaid").eq("email", email).maybeSingle();
  if (tgtErr) { console.error("Target read failed:", tgtErr.message); process.exit(1); }
  const tgtTasks: WebTask[] = tgtRow && Array.isArray(tgtRow.tasks) ? tgtRow.tasks : [];
  const tgtProfile: Profile = tgtRow ? normalizeProfile(tgtRow.profile) : emptyProfile();
  console.log(`  found ${tgtTasks.length} existing task(s) in the target account.`);

  // Existing (target) first, incoming (temp/source) second — same calling convention as commit()'s own
  // cross-device merge in server/index.ts, so a task edited/completed in BOTH places during the outage
  // resolves exactly the way two real devices syncing would have resolved it (more-progressed status wins,
  // ties go to most-recently-updated, study artifacts/chat are unioned rather than one side clobbering
  // the other).
  const mergedTasks = mergeTaskLists(tgtTasks, srcTasks);
  const mergedProfile = mergeProfileStates(tgtProfile, srcProfile);
  console.log(`Merged result: ${mergedTasks.length} task(s) total (${tgtTasks.length} existing + ${srcTasks.length} from temp, deduplicated).`);

  if (dryRun) {
    console.log("\n--dry-run: not writing anything. Re-run without --dry-run to apply this to the target project.");
    return;
  }

  // google/pronote/plaid are DELIBERATELY omitted from this write — the target row already has whatever
  // connections it had before the outage (or none), and this migration has no business touching them. See
  // server/store.ts's saveState: omitting a key from the upsert payload leaves that column untouched.
  const row: Record<string, unknown> = { email, profile: mergedProfile, tasks: mergedTasks, updated_at: new Date().toISOString() };
  const { error: writeErr } = await target.from(TABLE).upsert(row, { onConflict: "email" });
  if (writeErr) { console.error("Write to target failed:", writeErr.message); process.exit(1); }
  console.log(`\nDone — "${email}" in the target project now has ${mergedTasks.length} task(s). Nothing in the source (temp) project was modified.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
