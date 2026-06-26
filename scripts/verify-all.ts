// Verify EVERY catalog integration would yield usable tools when connected: fetch each toolkit's actions
// from Composio and report read / (non-gated) write coverage. Catches bad toolkit slugs too. Read-only.
import "../server/env.ts";
import { Composio } from "@composio/core";
import { CATALOG } from "../server/integrations.ts";

// Mirror the heuristics in integrations.ts so this reflects what the agent actually gets.
const isGated = (n: string) => { const u = n.toUpperCase(); if (/DRAFT/.test(u) && !/(SEND|DELETE|TRASH)/.test(u)) return false; return /(SEND|REPLY|FORWARD|PUBLISH|UNSUBSCRIBE|TWEET|DELETE|REMOVE|TRASH|ARCHIVE|CREATE_POST|CREATE_TWEET|_POST_|_POST$|SHARE|INVITE)/.test(u); };
const isRead = (n: string) => /(GET|LIST|FIND|SEARCH|FETCH|READ|DOWNLOAD|EXPORT|FREE_BUSY|INSTANCES)/.test(n) && !/(CREATE|UPDATE|INSERT|APPEND|ADD|PATCH|MODIFY|DELETE|REMOVE|WRITE|REPLACE|COPY|MOVE|BATCH_UPDATE|BATCH_MODIFY|SET_)/.test(n);

const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
const uid = process.argv[2] || "tjong.willem@gmail.com";

(async () => {
  console.log("toolkit            slug             total  read  write(nongated)  verdict");
  for (const it of CATALOG) {
    let raw: any[] = [];
    try { raw = await c.tools.get(uid, { toolkits: [it.toolkit], limit: 300 } as any) as any[]; }
    catch (e: any) { console.log(`${it.key.padEnd(18)} ${it.toolkit.padEnd(16)} ✗ tools.get ERROR: ${String(e?.message || e).slice(0, 60)}`); continue; }
    const names = (raw || []).map((t: any) => String((t?.function ?? t)?.name ?? t?.name ?? t?.slug ?? "")).filter(Boolean);
    const reads = names.filter(isRead);
    const writes = names.filter((n) => !isRead(n) && !isGated(n));
    const verdict = names.length === 0 ? "✗ NO ACTIONS" : reads.length === 0 ? "⚠ no reads" : writes.length === 0 ? "ok (read-only; writes gated)" : "✓ read+write";
    console.log(`${it.key.padEnd(18)} ${it.toolkit.padEnd(16)} ${String(names.length).padStart(4)}  ${String(reads.length).padStart(4)}  ${String(writes.length).padStart(14)}   ${verdict}`);
  }
})().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack || e); process.exit(1); });
