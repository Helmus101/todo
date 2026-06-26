// Verify the agent can actually USE each connected integration: (1) the loaded tools cover the app's
// stated job (read + write), and (2) a real READ executes (auth works). Read-only smoke tests; prints
// only OK/length or an error — never personal content.
import "../server/env.ts";
import { getAgentTools } from "../server/integrations.ts";

const EMAIL = process.argv[2] || "tjong.willem@gmail.com";

// Per-toolkit: what a working integration must have, and a safe read to actually execute.
const CHECKS: Record<string, { read: RegExp; write?: RegExp; smoke?: RegExp; args?: any }> = {
  gmail:          { read: /FETCH_EMAILS|LIST_MESSAGES|SEARCH/, write: /DRAFT/,                 smoke: /LIST_MESSAGES|FETCH_EMAILS/, args: { max_results: 1, maxResults: 1 } },
  googlecalendar: { read: /FIND_EVENT|EVENTS_LIST|EVENTS_GET/, write: /CREATE_EVENT/,           smoke: /EVENTS_LIST_ALL_CALENDARS|FIND_EVENT/, args: { max_results: 1, maxResults: 1, timeMin: "2026-06-01T00:00:00Z" } },
  googledrive:    { read: /FIND|LIST|SEARCH|GET/,              write: /CREATE|UPLOAD|COPY/,      smoke: /LIST|FIND|SEARCH/, args: { max_results: 1, page_size: 1 } },
  googledocs:     { read: /GET_DOCUMENT|GET_DOC/,              write: /CREATE_DOC|CREATE_DOCUMENT/ },
  googleslides:   { read: /GET_PRESENTATION|GET/,             write: /CREATE_PRESENTATION|CREATE/ },
  googlesheets:   { read: /GET|BATCH_GET|VALUES/,             write: /UPDATE|APPEND|BATCH_UPDATE|WRITE/ },
  github:         { read: /LIST|GET|SEARCH/,                  write: /CREATE_AN_ISSUE|CREATE_ISSUE|UPDATE|COMMENT/, smoke: /GET_THE_AUTHENTICATED_USER|LIST_REPOSITORIES_FOR_THE_AUTHENTICATED|LIST_NOTIFICATIONS/, args: { per_page: 1 } },
};

(async () => {
  console.log(`Verifying tools for ${EMAIL}…\n`);
  const t = await getAgentTools(EMAIL);
  const byKit = new Map<string, string[]>();
  for (const x of t.tools) { const k = (x.name.match(/^([A-Z]+)/)?.[1] || "?").toLowerCase(); (byKit.get(k) || byKit.set(k, []).get(k)!).push(x.name); }

  console.log("Connected toolkits:", t.connected.join(", "), `(${t.tools.length} tools total)\n`);

  for (const app of t.connected) {
    const norm = app.replace(/[^a-z]/g, "");
    const names = byKit.get(norm) || byKit.get(app) || [];
    const chk = CHECKS[app];
    console.log(`── ${app.toUpperCase()} (${names.length} tools) ──`);
    if (!chk) { console.log("  (no capability spec)\n"); continue; }
    const hasRead = names.some((n) => chk.read.test(n));
    const hasWrite = chk.write ? names.some((n) => chk.write!.test(n)) : true;
    console.log(`  read capability:  ${hasRead ? "✓" : "✗ MISSING"}`);
    console.log(`  write capability: ${chk.write ? (hasWrite ? "✓" : "✗ MISSING") : "n/a"}`);
    console.log(`  tools: ${names.join(", ")}`);
    // Execute a real read where we have a safe one.
    if (chk.smoke) {
      const toolName = names.find((n) => chk.smoke!.test(n));
      if (toolName) {
        try {
          const r = String(await t.call(toolName, chk.args || {}));
          const authFail = /unauthor|forbidden|invalid_grant|expired|no connected account|not connected|authentication/i.test(r.slice(0, 300));
          const paramErr = /missing|required|invalid request|"?400"?|param/i.test(r.slice(0, 300));
          console.log(`  EXECUTE ${toolName}: ${authFail ? `✗ AUTH FAIL — ${r.slice(0, 120)}` : paramErr ? "✓ executes (auth OK; just needs args)" : `✓ OK (${r.length} chars of real data)`}`);
        } catch (e: any) { console.log(`  EXECUTE ${toolName}: ✗ ${e?.message || e}`); }
      } else console.log(`  (no smoke-read tool loaded matching ${chk.smoke})`);
    }
    console.log("");
  }
})().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack || e); process.exit(1); });
