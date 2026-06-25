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
  { key: "twitter",    name: "X / Twitter", toolkit: "TWITTER",      category: "Communication",   blurb: "Read mentions; draft posts." },
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
  { key: "perplexity", name: "Perplexity",  toolkit: "PERPLEXITYAI", category: "Knowledge",       blurb: "Live web research." },
  // Scheduling, CRM & data
  { key: "calendly",   name: "Calendly",    toolkit: "CALENDLY",     category: "Scheduling & CRM", blurb: "Scheduled events & invitees." },
  { key: "hubspot",    name: "HubSpot",     toolkit: "HUBSPOT",      category: "Scheduling & CRM", blurb: "Contacts, deals & notes." },
  { key: "airtable",   name: "Airtable",    toolkit: "AIRTABLE",     category: "Scheduling & CRM", blurb: "Bases & records." },
];

const TOOLKIT_OF = (app: string) => CATALOG.find((c) => c.key === app.toLowerCase())?.toolkit ?? app.toUpperCase();
const norm = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function integrationsReady(): boolean { return !!process.env.COMPOSIO_API_KEY; }

/**
 * Is this action one the agent must NEVER run unattended — an irreversible OUTBOUND send or a DESTRUCTIVE
 * op? Those are kept out of the toolset; the agent leaves them as steps for the user. Reversible writes
 * (create draft/doc/task/event, update, comment) are allowed. A draft is explicitly NOT gated (safe).
 */
function isGatedAction(rawName: string): boolean {
  const n = rawName.toUpperCase();
  if (/DRAFT/.test(n) && !/(SEND|DELETE|TRASH)/.test(n)) return false; // creating/updating a draft is safe
  return /(SEND|REPLY|FORWARD|PUBLISH|UNSUBSCRIBE|TWEET|DELETE|REMOVE|TRASH|ARCHIVE|CREATE_POST|CREATE_TWEET|_POST_|_POST$|SHARE|INVITE)/.test(n);
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

/** Resolve (or lazily create) the managed-OAuth auth config for a toolkit. */
async function resolveAuthConfigId(toolkit: string): Promise<string> {
  const s = sdk();
  const list: any = await s.authConfigs.list({ toolkit });
  const configs: any[] = list?.items ?? (Array.isArray(list) ? list : []);
  if (configs.length) {
    const id = String(configs[0].id ?? configs[0].authConfigId ?? "").trim();
    if (id && id !== "undefined") return id;
  }
  const created: any = await s.authConfigs.create(toolkit, { type: "use_composio_managed_auth" } as any);
  const id = String(created?.id ?? created?.authConfigId ?? "").trim();
  if (!id || id === "undefined") throw new Error(`Could not create auth config for ${toolkit}.`);
  return id;
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
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId] } as any);
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
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId] } as any);
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
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId] } as any);
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

export interface AgentTools { tools: Anthropic.Tool[]; call: (name: string, args: Record<string, unknown>) => Promise<string | null>; connected: string[]; }
const EMPTY: AgentTools = { tools: [], call: async () => null, connected: [] };

// Building the tool list is N Composio calls; cache per account for a short window so we don't pay it on
// every single task run. (Server process memory — Date.now() is fine here, this isn't a workflow script.)
const cache = new Map<string, { at: number; data: AgentTools }>();
const CACHE_MS = 120_000;
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

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
  const MAX = 64; // keep the prompt sane across many toolkits
  for (const app of connected) {
    if (tools.length >= MAX) break;
    let raw: any[] = [];
    try { raw = await sdk().tools.get(userId, { toolkits: [app.toUpperCase()] } as any) as any[]; } catch { raw = []; }
    for (const t of (Array.isArray(raw) ? raw : [])) {
      if (tools.length >= MAX) break;
      const fn = (t as any)?.function ?? t;
      const rawName = String(fn?.name ?? (t as any)?.name ?? (t as any)?.slug ?? "").trim();
      if (!rawName || isGatedAction(rawName)) continue; // no irreversible sends/deletes for the agent
      const name = sanitize(rawName);
      if (map.has(name)) continue;
      map.set(name, rawName);
      const params = fn?.parameters ?? (t as any)?.parameters ?? (t as any)?.input_parameters ?? (t as any)?.inputSchema ?? {};
      const input_schema = (params && typeof params === "object")
        ? { type: "object" as const, properties: params.properties ?? {}, ...(Array.isArray(params.required) ? { required: params.required } : {}) }
        : { type: "object" as const, properties: {} };
      tools.push({ name, description: `[${app}] ${String(fn?.description ?? rawName).slice(0, 600)}`, input_schema });
    }
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    const action = map.get(name);
    if (!action) return null;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete — leave it as a step for the user instead.`;
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
