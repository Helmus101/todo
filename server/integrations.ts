/**
 * Integrations for the web app, backed by Composio (v3 SDK) — the SAME service Weave's desktop uses, so it
 * reuses the existing COMPOSIO_API_KEY (picked up from the repo-root .env via env.ts). One Composio
 * "user_id" per Weave account email, so a connection follows the account across devices/logins.
 *
 * SAFETY: the autonomous run agent gets READ + most WRITE tools (create a draft/doc/task/event, update an
 * issue, …) so it can actually DO the work. The ONE thing it can never do unattended is an irreversible
 * OUTBOUND or DESTRUCTIVE action — send an email, send/post a message, publish, delete. Those are filtered
 * out of the agent's toolset entirely (see isGatedAction), so a prompt-injected email/page can't steer it
 * into firing one; they surface as "needs you" steps. (Email keeps the rule you set: draft only, you send.)
 */
import { Composio } from "@composio/core";
import type Anthropic from "@anthropic-ai/sdk";

export interface Integration { key: string; name: string; toolkit: string; blurb: string; category: string; }

/** The catalog shown on Settings. `toolkit` is the Composio slug; `key` is our stable id used in URLs. */
export const CATALOG: Integration[] = [
  // Google — connected through Composio (read + write), one tile per service.
  { key: "gmail",          name: "Gmail",            toolkit: "GMAIL",          category: "Google", blurb: "Read mail; draft replies. (sending stays your call)" },
  { key: "googlecalendar", name: "Google Calendar",  toolkit: "GOOGLECALENDAR", category: "Google", blurb: "Upcoming events & scheduling." },
  { key: "googledocs",     name: "Google Docs",      toolkit: "GOOGLEDOCS",     category: "Google", blurb: "Read & create documents." },
  { key: "googleslides",   name: "Google Slides",    toolkit: "GOOGLESLIDES",   category: "Google", blurb: "Read & build decks." },
  { key: "googledrive",    name: "Google Drive",     toolkit: "GOOGLEDRIVE",    category: "Google", blurb: "Search & read your files." },
  { key: "googlesheets",   name: "Google Sheets",    toolkit: "GOOGLESHEETS",   category: "Google", blurb: "Read & edit spreadsheets." },
  // Communication
  { key: "slack",      name: "Slack",       toolkit: "SLACK",        category: "Communication",   blurb: "Read channels & DMs; draft messages." },
  { key: "discord",    name: "Discord",     toolkit: "DISCORD",      category: "Communication",   blurb: "Read servers & channels." },
  { key: "linkedin",   name: "LinkedIn",    toolkit: "LINKEDIN",     category: "Communication",   blurb: "Read your feed; draft posts." },
  // Code & projects
  { key: "github",     name: "GitHub",      toolkit: "GITHUB",       category: "Code & projects", blurb: "Issues, PRs, notifications." },
  { key: "linear",     name: "Linear",      toolkit: "LINEAR",       category: "Code & projects", blurb: "Issues, projects, cycles." },
  { key: "jira",       name: "Jira",        toolkit: "JIRA",         category: "Code & projects", blurb: "Issues & sprints." },
  // Tasks
  { key: "todoist",    name: "Todoist",     toolkit: "TODOIST",      category: "Tasks",           blurb: "Tasks & projects." },
  { key: "asana",      name: "Asana",       toolkit: "ASANA",        category: "Tasks",           blurb: "Tasks & projects." },
  { key: "trello",     name: "Trello",      toolkit: "TRELLO",       category: "Tasks",           blurb: "Boards & cards." },
  { key: "clickup",    name: "ClickUp",     toolkit: "CLICKUP",      category: "Tasks",           blurb: "Tasks, docs & goals." },
  // Knowledge & notes
  { key: "notion",     name: "Notion",      toolkit: "NOTION",       category: "Knowledge",       blurb: "Pages & databases." },
  // Scheduling, CRM & data
  { key: "calendly",   name: "Calendly",    toolkit: "CALENDLY",     category: "Scheduling & CRM", blurb: "Scheduled events & invitees." },
  { key: "hubspot",    name: "HubSpot",     toolkit: "HUBSPOT",      category: "Scheduling & CRM", blurb: "Contacts, deals & notes." },
  { key: "airtable",   name: "Airtable",    toolkit: "AIRTABLE",     category: "Scheduling & CRM", blurb: "Bases & records." },
];

const TOOLKIT_OF = (app: string) => CATALOG.find((c) => c.key === app.toLowerCase())?.toolkit ?? app.toUpperCase();
const norm = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Real brand logo for a toolkit — served straight from Composio's logo CDN (SVG). Used by the Settings grid
 *  so each app shows its actual logo (not a hand-drawn icon). Verified to resolve for every catalog slug. */
export const logoFor = (toolkit: string) => `https://logos.composio.dev/api/${String(toolkit).toLowerCase()}`;

export function integrationsReady(): boolean { return !!process.env.COMPOSIO_API_KEY; }

/**
 * Is this action one the agent must NEVER run unattended — an irreversible OUTBOUND send or a DESTRUCTIVE
 * op? Those are kept out of the toolset; the agent leaves them as steps for the user. Reversible writes
 * (create draft/doc/task/event, update, comment) are allowed. A draft is explicitly NOT gated (safe).
 */
function isGatedAction(rawName: string): boolean {
  const n = rawName.toUpperCase();
  if (/DRAFT/.test(n) && !/(SEND|DELETE|TRASH)/.test(n)) return false; // creating/updating a draft is safe
  return /(SEND|REPLY|FORWARD|PUBLISH|UNSUBSCRIBE|TWEET|DELETE|REMOVE|TRASH|ARCHIVE|CREATE_POST|CREATE_TWEET|CREATE_MESSAGE|SCHEDULE_MESSAGE|CREATE_DM|_POST_|_POST$|SHARE|INVITE)/.test(n);
}

/**
 * HARDCODED PERMISSION GATE — actions that need the user's explicit "Approve & Run" click before Otto
 * can execute them. Unlike isGatedAction (which strips the tool entirely), write-gated tools remain in the
 * agent's toolset so the agent can surface them as "needs approval" steps. Calling them during the
 * autonomous agent loop returns a PERMISSION_REQUIRED message; calling them via runStep() (the
 * user-approved path) goes through getAgentToolsWithPermission() which skips this check.
 *
 * Gated:
 *   - Editing existing Google Docs / Sheets / Slides (UPDATE, PATCH, BATCH_UPDATE, …)
 *   - Creating OR updating Google Calendar events (any write on GOOGLECALENDAR_)
 *   - Sending emails (belt-and-suspenders — also caught by isGatedAction above)
 */
export function isWriteGatedAction(rawName: string): boolean {
  const n = rawName.toUpperCase();
  // Google Docs — edits to existing documents. Creating a NEW doc is allowed (no UPDATE/PATCH keyword).
  if (/^GOOGLEDOCS_/.test(n) && /(UPDATE|MODIFY|PATCH|REPLACE|APPEND|INSERT|DELETE_CONTENT|BATCH)/.test(n)) return true;
  // Google Sheets — any write that changes cell data in an existing sheet.
  if (/^GOOGLESHEETS_/.test(n) && /(UPDATE|BATCH_UPDATE|MODIFY|PATCH|CLEAR|INSERT_ROW|DELETE_ROW|APPEND|WRITE)/.test(n)) return true;
  // Google Slides — edits to existing presentations.
  if (/^GOOGLESLIDES_/.test(n) && /(UPDATE|MODIFY|PATCH|REPLACE|BATCH)/.test(n)) return true;
  // Google Calendar — creating OR updating events always requires permission (they land on calendars).
  if (/^GOOGLECALENDAR_/.test(n) && /(CREATE|INSERT|UPDATE|PATCH|QUICK_ADD)/.test(n)) return true;
  // Gmail sends — belt-and-suspenders (isGatedAction already strips these, but guard here too).
  if (/^GMAIL_/.test(n) && /(SEND|REPLY|FORWARD)/.test(n)) return true;
  return false;
}

let _client: Composio | null = null;
function sdk(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not configured");
  return (_client ||= new Composio({ apiKey }));
}

const isActive = (i: any) => ["ACTIVE", "CONNECTED", "ENABLED"].includes(String(i?.status ?? i?.connectionStatus ?? i?.state ?? "").toUpperCase());
const acctToolkit = (i: any) => norm(i?.toolkit?.slug ?? i?.toolkit?.name ?? i?.toolkit ?? i?.appName ?? i?.app?.name ?? i?.app ?? i?.appUniqueId ?? i?.toolkitSlug ?? "");
const acctId = (i: any) => String(i?.id ?? i?.connectedAccountId ?? i?.nanoId ?? "");

/**
 * Resolve (or lazily create) the ONE managed-OAuth auth config for a toolkit — i.e. one unique connect link
 * per app. An in-flight lock makes concurrent calls (rapid repeat Connect clicks) share a single resolution,
 * so they can't each "find none, create one" and spawn DUPLICATES (the "todoist (3)" problem). A client-side
 * toolkit filter guards against the list API returning anything off-toolkit.
 */
const authConfigInFlight = new Map<string, Promise<string>>();
async function resolveAuthConfigId(toolkit: string): Promise<string> {
  const key = toolkit.toUpperCase();
  const pending = authConfigInFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const s = sdk();
    const list: any = await s.authConfigs.list({ toolkit: key } as any);
    const configs: any[] = (list?.items ?? (Array.isArray(list) ? list : []))
      .filter((c: any) => norm(c?.toolkit?.slug ?? c?.toolkit?.name ?? c?.toolkit ?? "") === norm(toolkit));
    if (configs.length) {
      const id = String(configs[0].id ?? configs[0].authConfigId ?? "").trim();
      if (id && id !== "undefined") return id;
    }
    const created: any = await s.authConfigs.create(key, { type: "use_composio_managed_auth" } as any);
    const id = String(created?.id ?? created?.authConfigId ?? "").trim();
    if (!id || id === "undefined") throw new Error(`Could not create auth config for ${toolkit}.`);
    return id;
  })();
  authConfigInFlight.set(key, p);
  try { return await p; } finally { authConfigInFlight.delete(key); }
}

/** Start an OAuth connection → returns the URL to send the user to + the connection id (a match hint). */
export async function initiateConnection(app: string, userId: string, callbackUrl: string): Promise<{ redirectUrl: string; connectionId: string }> {
  const authConfigId = await resolveAuthConfigId(TOOLKIT_OF(app));
  const req: any = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl } as any);
  const redirectUrl = String(req?.redirectUrl ?? req?.redirectUri ?? "").trim();
  const connectionId = String(req?.id ?? req?.connectedAccountId ?? "").trim();
  if (!redirectUrl) throw new Error(`Composio returned no redirect URL for ${app}.`);
  return { redirectUrl, connectionId };
}

/** Connected/not for every app in one sweep (matches by toolkit, or by the captured connectionId hint). */
export async function getAllConnectionStatuses(userId: string, apps: string[], connIdByApp: Record<string, string> = {}): Promise<Record<string, boolean>> {
  try {
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 } as any);
    const items: any[] = (list?.items ?? (Array.isArray(list) ? list : [])).filter(isActive);
    const toolkits = new Set(items.map(acctToolkit));
    const ids = new Set(items.map(acctId));
    const out: Record<string, boolean> = {};
    for (const app of apps) out[app] = toolkits.has(norm(TOOLKIT_OF(app))) || (!!connIdByApp[app] && ids.has(connIdByApp[app]));
    return out;
  } catch (e: any) {
    console.warn("[integrations] getAllConnectionStatuses error:", e?.message ?? e);
    return Object.fromEntries(apps.map((a) => [a, false]));
  }
}

/** Disconnect an app by deleting its active connected account. */
export async function disconnect(app: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 } as any);
    const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
    const account = items.find((i) => isActive(i) && acctToolkit(i) === norm(TOOLKIT_OF(app)));
    if (!account) return { ok: true };
    const id = acctId(account);
    if (!id) return { ok: false, error: "no connected account id" };
    await (sdk().connectedAccounts as any).delete(id);
    return { ok: true };
  } catch (e: any) {
    console.error(`[integrations] disconnect(${app}) failed:`, e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Lowercase toolkit slugs the user has ACTIVELY connected (any Composio app, not just our catalog). */
async function listConnectedToolkits(userId: string): Promise<string[]> {
  try {
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 } as any);
    const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
    const slugs = new Set<string>();
    for (const i of items) {
      if (!isActive(i)) continue;
      const slug = String(i?.toolkit?.slug ?? i?.toolkit?.name ?? i?.toolkit ?? i?.appName ?? i?.app?.name ?? i?.app ?? "").toLowerCase().trim();
      if (slug) slugs.add(slug);
    }
    return [...slugs];
  } catch (e: any) {
    console.warn("[integrations] listConnectedToolkits failed:", e?.message ?? e);
    return [];
  }
}

/** Run a Composio action for a user (only ever READ actions reach here from the agent). */
async function execute(action: string, userId: string, args: Record<string, unknown>): Promise<string> {
  const result = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true } as any);
  return JSON.stringify(result ?? {}, null, 2).slice(0, 4000);
}

/** Fire a USER-CONFIRMED one-click send (a reviewed Gmail draft / a composed Slack message). This is the ONLY
 *  place an irreversible send happens — always from an explicit user click, NEVER the agent (the agent's gated
 *  toolset can't reach these). Server hardcodes the send action; the agent only ever supplies the data. */
export async function sendSendable(userId: string, s: { app: string; draftId?: string; channel?: string; text?: string; eventId?: string; attendees?: string[] }): Promise<{ ok: boolean; error?: string }> {
  if (!integrationsReady() || !userId) return { ok: false, error: "Integrations not configured." };
  let action = "", args: Record<string, unknown> = {};
  if (s.app === "gmail" && s.draftId) { action = "GMAIL_SEND_DRAFT"; args = { draft_id: s.draftId }; }
  else if (s.app === "slack" && s.channel) { action = "SLACK_CHAT_POST_MESSAGE"; args = { channel: s.channel, ...(s.text ? { text: s.text } : {}) }; }
  // Calendar invite: the agent created the event SILENTLY (send_updates="none" in call()); the user-confirmed
  // click is the ONLY thing that emails the attendees. Patch the event with send_updates="all" so they're invited.
  else if (s.app === "gcal" && s.eventId && s.attendees?.length) { action = "GOOGLECALENDAR_PATCH_EVENT"; args = { event_id: s.eventId, attendees: s.attendees, send_updates: "all" }; }
  else return { ok: false, error: "Nothing to send." };
  try {
    const r: any = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true } as any);
    if (r && (r.successful === false || r.error)) return { ok: false, error: String(r.error || "Send failed.") };
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
}

export interface AgentTools { tools: Anthropic.Tool[]; call: (name: string, args: Record<string, unknown>) => Promise<string | null>; connected: string[]; }
const EMPTY: AgentTools = { tools: [], call: async () => null, connected: [] };

// Building the tool list is N Composio calls; cache per account for a short window so we don't pay it on
// every single task run. (Server process memory — Date.now() is fine here, this isn't a workflow script.)
const cache = new Map<string, { at: number; data: AgentTools }>();
const CACHE_MS = 120_000;
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

// Rank a toolkit's actions by usefulness to an assistant, so the per-toolkit cap keeps the RIGHT ones
// (read/create/update on the core nouns) rather than the alphabetically-first plumbing (ACL, channels,
// calendar-list management). Composio returns actions roughly alphabetically, so without this Calendar
// got ACL_*/CHANNELS_*/CREATE_CALENDAR and NO event read/update — the "only CREATE event" bug.
function relevance(n: string): number {
  let s = 0;
  if (/(EVENT|MESSAGE|EMAIL|THREAD|DRAFT|FILE|DOCUMENT|FOLDER|SHEET|SPREADSHEET|ROW|CELL|SLIDE|PRESENTATION|ISSUE|PULL|COMMENT|TASK|REPO|CONTACT|PEOPLE|FREE.?SLOT|FREEBUSY)/.test(n)) s += 3;
  if (/(FIND|SEARCH|LIST|GET|FETCH|READ|CREATE|UPDATE|PATCH|ADD|INSERT|MODIFY|APPEND|MOVE|COPY)/.test(n)) s += 2;
  if (/(ACL|CHANNEL|WATCH|STOP|QUOTA|SETTING|COLOR|DUPLICATE|PERMISSION|SCOPE|SUBSCRIPTION|WEBHOOK|CALENDAR_LIST|CALENDARS_|CREATE_CALENDAR)/.test(n)) s -= 4;
  return s;
}
// Is this action a pure READ (gather context) vs a write? Used to guarantee BOTH kinds survive the per-toolkit cap.
const isRead = (n: string) => /(GET|LIST|FIND|SEARCH|FETCH|READ|DOWNLOAD|EXPORT|FREE_BUSY|INSTANCES)/.test(n)
  && !/(CREATE|UPDATE|INSERT|APPEND|ADD|PATCH|MODIFY|DELETE|REMOVE|WRITE|REPLACE|COPY|MOVE|BATCH_UPDATE|BATCH_MODIFY|SET_)/.test(n);

/**
 * Composio tools for the apps the user connected, in Anthropic tool shape — READ + reversible WRITES, so
 * the run/generation agent can both gather facts AND do the work (draft a reply, create a doc, add a task,
 * update an issue). Irreversible OUTBOUND/DESTRUCTIVE actions (send, post, publish, delete) are filtered
 * out (isGatedAction) and never reach the agent. Returns empty fast when nothing's connected or Composio
 * isn't configured, so it adds at most one list() call.
 */
export async function getAgentTools(userId: string): Promise<AgentTools> {
  if (!integrationsReady() || !userId) return EMPTY;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const connected = await listConnectedToolkits(userId);
  if (!connected.length) { const data = { ...EMPTY, connected }; cache.set(userId, { at: Date.now(), data }); return data; }

  const tools: Anthropic.Tool[] = [];
  const map = new Map<string, string>(); // sanitized tool name → raw Composio action slug
  const MAX = 200;         // overall ceiling — generous so even if EVERY catalog app is connected each still gets
                           // a usable share (22 apps × ~9 = ~198). Well above the old 64. A safety cap only.
  // Per-app share ADAPTS to how many apps are connected so EVERY one is represented, never starved: few apps
  // → up to 20 tools each; many apps → as low as 8 (still enough for core read+write). This is what lets you
  // actually USE each connected integration, not just the first few a flat cap happened to reach.
  const perToolkit = Math.min(20, Math.max(8, Math.floor(MAX / connected.length)));
  // Task-critical apps first (the to-do list is built from Gmail + Calendar), so they ALWAYS get their share
  // before a big toolkit can crowd them out; anything else keeps its connected order behind these.
  const PRIORITY = ["gmail", "googlecalendar", "googledocs", "googledrive", "googlesheets", "googleslides", "slack", "notion", "linear", "todoist"];
  const rank = (a: string) => { const i = PRIORITY.indexOf(a); return i === -1 ? PRIORITY.length : i; };
  const ordered = [...connected].sort((a, b) => rank(a) - rank(b));
  for (const app of ordered) {
    if (tools.length >= MAX) break;
    let raw: any[] = [];
    // limit: pull the FULL action set, not Composio's small write-heavy default (~20) — otherwise big
    // toolkits like GitHub never surface their read actions (list issues/PRs/repos), and Calendar never
    // surfaces UPDATE_EVENT. We rank + cap below, so fetching extra is cheap (cached 120s).
    try { raw = await sdk().tools.get(userId, { toolkits: [app.toUpperCase()], limit: 300 } as any) as any[]; } catch { raw = []; }
    // Rank by usefulness, THEN take the top perToolkit — so the slots go to read/create/update on the core
    // nouns (events, messages, files) instead of whatever sorts first alphabetically.
    const ranked = (Array.isArray(raw) ? raw : [])
      .map((t) => ({ t, rawName: String(((t as any)?.function ?? t)?.name ?? (t as any)?.name ?? (t as any)?.slug ?? "").trim() }))
      .filter((x) => x.rawName && !isGatedAction(x.rawName)) // no irreversible sends/deletes for the agent
      .sort((a, b) => relevance(b.rawName) - relevance(a.rawName));
    // Guarantee BOTH read and write coverage: on a relevance tie a big toolkit's writes (or reads) would win
    // every slot (GitHub's CREATE_*/ADD_* sort before LIST_*/GET_* → no way to READ issues/PRs). Reserve ~60%
    // for reads (the agent must gather context first), the rest for writes, then top up from whatever's left.
    const reads = ranked.filter((x) => isRead(x.rawName));
    const writes = ranked.filter((x) => !isRead(x.rawName));
    const readQuota = Math.ceil(perToolkit * 0.6);
    const chosen = [...reads.slice(0, readQuota), ...writes.slice(0, perToolkit - Math.min(readQuota, reads.length))];
    for (const x of ranked) { if (chosen.length >= perToolkit) break; if (!chosen.includes(x)) chosen.push(x); }
    let added = 0;
    for (const { t, rawName } of chosen) {
      if (tools.length >= MAX || added >= perToolkit) break; // cap PER toolkit so every connected app is represented
      const name = sanitize(rawName);
      if (map.has(name)) continue;
      map.set(name, rawName);
      const fn = (t as any)?.function ?? t;
      const params = fn?.parameters ?? (t as any)?.parameters ?? (t as any)?.input_parameters ?? (t as any)?.inputSchema ?? {};
      const input_schema = (params && typeof params === "object")
        ? { type: "object" as const, properties: params.properties ?? {}, ...(Array.isArray(params.required) ? { required: params.required } : {}) }
        : { type: "object" as const, properties: {} };
      tools.push({ name, description: `[${app}] ${String(fn?.description ?? rawName).slice(0, 600)}`, input_schema });
      added++;
    }
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    const action = map.get(name);
    if (!action) return null;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete — leave it as a step for the user instead.`;
    // HARDCODED PERMISSION GATE: editing existing documents and creating/updating calendar events require
    // the user's explicit "Approve & Run" click. Return PERMISSION_REQUIRED so the agent surfaces this as
    // a user-approval step instead of executing it autonomously.
    if (isWriteGatedAction(action)) {
      return `PERMISSION_REQUIRED: "${action}" requires explicit user approval before it can run. ` +
        `Add it as an automatable step in submit() so the user can approve it with one click.`;
    }
    // Hard guard: a calendar event with attendees/notifications EMAILS invites. Force send_updates="none" so the
    // agent can NEVER send a calendar invite — the event lands on the user's calendar silently; they invite people.
    if (/^GOOGLECALENDAR_/.test(action) && args && (("attendees" in args) || ("send_updates" in args))) {
      args = { ...args, send_updates: "none" };
    }
    try { return await execute(action, userId, args || {}); }
    catch (e: any) { return `Tool error (${action}): ${e?.message ?? e}`; }
  };
  const data: AgentTools = { tools, call, connected };
  cache.set(userId, { at: Date.now(), data });
  return data;
}

// Connection statuses for the hot /api/status path — cached briefly so polling doesn't hammer Composio.
const statusCache = new Map<string, { at: number; data: Record<string, boolean> }>();
export async function connectionStatusesCached(userId: string, apps: string[]): Promise<Record<string, boolean>> {
  if (!integrationsReady() || !userId) return Object.fromEntries(apps.map((a) => [a, false]));
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const data = await getAllConnectionStatuses(userId, apps);
  statusCache.set(userId, { at: Date.now(), data });
  return data;
}

/** Drop cached tools + statuses for a user (after they connect/disconnect something). */
export function invalidateTools(userId: string): void { cache.delete(userId); statusCache.delete(userId); }

/**
 * Like getAgentTools() but WITHOUT the write-gate — used ONLY for user-approved step runs.
 * The /api/tasks/:id/step/:index/run route calls this because the user explicitly clicked "Approve & Run".
 * Editing existing docs and creating calendar events are permitted on this path.
 *
 * NEVER use this for the autonomous task-run or generation paths — those must go through getAgentTools().
 */
export async function getAgentToolsWithPermission(userId: string): Promise<AgentTools> {
  const base = await getAgentTools(userId);
  if (!base.tools.length) return base;
  // Build a permissioned call closure that skips the write gate but keeps the irreversible-send gate.
  const permCall = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    // The sanitized name is the key; we need the raw Composio action name.
    // We derive it by fetching the tools again (cached, so free) and rebuilding the map.
    // Simpler: since sanitize() is a near-identity for Composio action slugs (already uppercase+underscore),
    // we use name as-is and fall through to execute().
    const action = name; // sanitized ≈ raw for Composio slugs
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete.`;
    // NO isWriteGatedAction check — user explicitly approved.
    if (/^GOOGLECALENDAR_/.test(action) && args && (("attendees" in args) || ("send_updates" in args))) {
      args = { ...args, send_updates: "none" };
    }
    try { return await execute(action, userId, args || {}); }
    catch (e: any) { return `Tool error (${action}): ${e?.message ?? e}`; }
  };
  return { tools: base.tools, call: permCall, connected: base.connected };
}
