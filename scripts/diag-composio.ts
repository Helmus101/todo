// Read-only Composio diagnostic — lists connected accounts and runs the app's OWN getAgentTools()
// against each real userId, so we can see exactly what the agent receives. No writes.
import "../server/env.ts";
import { Composio } from "@composio/core";
import { getAgentTools } from "../server/integrations.ts";

const key = process.env.COMPOSIO_API_KEY;
console.log("COMPOSIO_API_KEY present:", !!key, key ? `(…${key.slice(-4)})` : "");

const c = new Composio({ apiKey: key! });

const pick = (i: any) => ({
  userId: i?.userId ?? i?.user_id ?? i?.entityId ?? i?.entity_id ?? i?.entity?.id ?? "?",
  toolkit: i?.toolkit?.slug ?? i?.toolkit?.name ?? i?.toolkit ?? i?.appName ?? i?.app?.name ?? i?.app ?? i?.appUniqueId ?? i?.toolkitSlug ?? "?",
  status: i?.status ?? i?.connectionStatus ?? i?.state ?? "?",
  id: i?.id ?? i?.connectedAccountId ?? i?.nanoId ?? "?",
});

const main = async () => {
  let list: any;
  try { list = await c.connectedAccounts.list({} as any); }
  catch (e: any) { console.error("connectedAccounts.list FAILED:", e?.message || e); return; }
  const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
  console.log("\n=== CONNECTED ACCOUNTS:", items.length, "===");
  const userIds = new Set<string>();
  for (const i of items) {
    const p = pick(i);
    console.log(` • userId=${p.userId}  toolkit=${JSON.stringify(p.toolkit)}  status=${p.status}  id=${p.id}`);
    if (p.userId && p.userId !== "?") userIds.add(String(p.userId));
  }
  if (!items.length) { console.log("  (none — nothing is connected under this Composio project/key)"); }

  // Find the real userId field: dump keys + full JSON of the ACTIVE gmail account.
  const gmail = items.find((i) => /gmail/i.test(String(pick(i).toolkit)) && /ACTIVE/i.test(String(pick(i).status))) || items[0];
  if (gmail) {
    console.log("\n=== RAW keys of a connected account ===\n", Object.keys(gmail));
    console.log("\n=== FULL JSON (active gmail) ===\n", JSON.stringify(gmail, null, 2).slice(0, 2500));
  }

  // The app keys Composio by the Otto ACCOUNT email (session.user). Pull those from Supabase and test each —
  // this is the EXACT userId the running app passes to getAgentTools.
  const sbUrl = process.env.VITE_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const candidates = new Set<string>([...userIds]);
  if (sbUrl && sbKey) {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(sbUrl, sbKey);
      const { data, error } = await sb.from("weave_web_users").select("email");
      if (error) console.log("  (supabase users read error:", error.message, ")");
      console.log("\n=== Otto account emails (the userIds the app uses) ===\n ", (data || []).map((u: any) => u.email));
      for (const u of data || []) if (u?.email) candidates.add(String(u.email));
    } catch (e: any) { console.log("  (supabase lookup failed:", e?.message || e, ")"); }
  }

  for (const uid of candidates) {
    console.log(`\n=== userId ${JSON.stringify(uid)} ===`);
    try {
      const filtered: any = await c.connectedAccounts.list({ userIds: [uid] } as any);
      const fItems: any[] = filtered?.items ?? (Array.isArray(filtered) ? filtered : []);
      console.log(`  connectedAccounts.list({userIds:[${JSON.stringify(uid)}]}) → ${fItems.length} accounts`);
      const t = await getAgentTools(uid);
      console.log("  getAgentTools → connected:", t.connected, "| TOOL COUNT:", t.tools.length);
      if (t.tools.length) console.log("  sample:", t.tools.slice(0, 10).map((x) => x.name));
    } catch (e: any) { console.error("  FAILED:", e?.message || e); }
  }
};
main().then(() => process.exit(0)).catch((e) => { console.error("DIAG ERROR:", e?.stack || e); process.exit(1); });
