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
/** Tool shape in the (Anthropic-style) format the agent loop converts for the OpenAI-compatible API. */
export interface AgentTool { name: string; description?: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] }; }

export interface Integration { key: string; name: string; toolkit: string; blurb: string; category: string; }

/** Details of a connected account for a specific app/toolkit. */
export interface ConnectedAccount {
  id: string;           // Composio connected account ID
  email?: string;       // Account email (if available from Composio)
  toolkit: string;      // e.g. "GMAIL"
  status: string;       // e.g. "ACTIVE", "CONNECTED"
}

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
// Apps that support connecting MULTIPLE accounts (personal + work). All Google services — the user often
// has two Google accounts. Others stay single-account (connecting again replaces the old connection).
export const MULTI_APPS = new Set(["gmail", "googlecalendar", "googledocs", "googleslides", "googledrive", "googlesheets"]);
// A task's `source` (gmail/calendar/drive) → the Composio toolkit prefix, so execution routes that toolkit's
// actions to the SAME account the task came from.
const SOURCE_TOOLKIT: Record<string, string> = { gmail: "GMAIL", calendar: "GOOGLECALENDAR", drive: "GOOGLEDRIVE" };

/** Real brand logo for a toolkit — served straight from Composio's logo CDN (SVG). Used by the Settings grid
 *  so each app shows its actual logo (not a hand-drawn icon). Verified to resolve for every catalog slug. */
export const logoFor = (toolkit: string) => `https://logos.composio.dev/api/${String(toolkit).toLowerCase()}`;

export function integrationsReady(): boolean { return !!process.env.COMPOSIO_API_KEY; }

// ── Action policy registry ────────────────────────────────────────────────────
// EXPLICIT per-action permissions for the core (Google-first) toolkits — the source of truth the code
// enforces before every tool call. Three modes:
//   auto     — the agent may run it unattended (reads, drafts, Otto-owned artifacts)
//   approve  — stays in the toolset but returns PERMISSION_REQUIRED unless the user clicked Approve & Run
//   never    — irreversible/outbound/destructive: stripped from the toolset entirely
// Actions NOT listed here fall back to the regex classifiers below (isGatedAction/isWriteGatedAction),
// so a new/unknown Composio action is still risk-classified rather than silently allowed.
export type ActionMode = "auto" | "approve" | "never";
export const ACTION_POLICIES: Record<string, ActionMode> = {
  // Gmail — read + draft are auto; anything that leaves the account or destroys mail is never.
  GMAIL_FETCH_EMAILS: "auto", GMAIL_FETCH_MESSAGE_BY_THREAD_ID: "auto", GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: "auto",
  GMAIL_LIST_THREADS: "auto", GMAIL_GET_ATTACHMENT: "auto", GMAIL_LIST_DRAFTS: "auto", GMAIL_GET_PROFILE: "auto",
  GMAIL_CREATE_EMAIL_DRAFT: "auto", GMAIL_UPDATE_EMAIL_DRAFT: "auto",
  GMAIL_SEND_EMAIL: "never", GMAIL_SEND_DRAFT: "never", GMAIL_REPLY_TO_THREAD: "never", GMAIL_FORWARD_MESSAGE: "never",
  GMAIL_DELETE_MESSAGE: "never", GMAIL_DELETE_DRAFT: "never", GMAIL_TRASH_MESSAGE: "never", GMAIL_ARCHIVE_MESSAGE: "never",
  // Calendar — reads auto; ANY event write needs approval (it lands on calendars); invites never.
  GOOGLECALENDAR_EVENTS_LIST: "auto", GOOGLECALENDAR_FIND_EVENT: "auto", GOOGLECALENDAR_GET_EVENT: "auto",
  GOOGLECALENDAR_FIND_FREE_SLOTS: "auto", GOOGLECALENDAR_GET_CALENDAR: "auto", GOOGLECALENDAR_FREE_BUSY_QUERY: "auto",
  GOOGLECALENDAR_CREATE_EVENT: "approve", GOOGLECALENDAR_UPDATE_EVENT: "approve", GOOGLECALENDAR_PATCH_EVENT: "approve", GOOGLECALENDAR_QUICK_ADD: "approve",
  GOOGLECALENDAR_DELETE_EVENT: "never",
  // Drive/Docs — search/read/create-new auto; editing EXISTING docs needs approval; delete/share never.
  GOOGLEDRIVE_FIND_FILE: "auto", GOOGLEDRIVE_DOWNLOAD_FILE: "auto", GOOGLEDRIVE_EXPORT_FILE: "auto", GOOGLEDRIVE_LIST_FILES: "auto",
  GOOGLEDOCS_GET_DOCUMENT_BY_ID: "auto", GOOGLEDOCS_CREATE_DOCUMENT: "auto", GOOGLEDOCS_SEARCH_DOCUMENTS: "auto",
  GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT: "approve", GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN: "approve",
  GOOGLEDRIVE_DELETE_FILE: "never", GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE: "never",
  // Sheets — reads + cell writes auto (reversible); structural deletes never.
  GOOGLESHEETS_BATCH_GET: "auto", GOOGLESHEETS_GET_SPREADSHEET_INFO: "auto", GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW: "auto",
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: "auto", GOOGLESHEETS_BATCH_UPDATE: "auto", GOOGLESHEETS_UPDATE_VALUES: "auto", GOOGLESHEETS_APPEND_VALUES: "auto",
  GOOGLESHEETS_DELETE_SHEET: "never", GOOGLESHEETS_DELETE_DIMENSION: "never",
  // GitHub — the two discovery reads (assigned issues, review-requested PRs). Other GitHub actions fall
  // through to the regex classifiers.
  GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER: "auto", GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS: "auto",
  // Slack — read + compose only; posting is the user's click.
  SLACK_FETCH_CONVERSATION_HISTORY: "auto", SLACK_LIST_ALL_CHANNELS: "auto", SLACK_SEARCH_MESSAGES: "auto", SLACK_FIND_USERS: "auto",
  SLACK_CHAT_POST_MESSAGE: "never", SLACK_SEND_MESSAGE: "never", SLACK_CHAT_DELETE: "never",
};

/**
 * Is this action one the agent must NEVER run unattended — an irreversible OUTBOUND send or a DESTRUCTIVE
 * op? Policy registry first (explicit, code-enforced), regex classifier as the fallback for actions the
 * registry doesn't list. A draft is explicitly NOT gated (safe).
 */
function isGatedAction(rawName: string): boolean {
  const n = rawName.toUpperCase();
  const policy = ACTION_POLICIES[n];
  if (policy) return policy === "never";
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
  // Policy registry first — explicit beats inferred.
  const policy = ACTION_POLICIES[n];
  if (policy) return policy === "approve";
  // Google Docs — edits to existing documents. Creating a NEW doc is allowed (no UPDATE/PATCH keyword).
  if (/^GOOGLEDOCS_/.test(n) && /(UPDATE|MODIFY|PATCH|REPLACE|APPEND|INSERT|DELETE_CONTENT|BATCH)/.test(n)) return true;
  // Google Sheets — cell writes are REVERSIBLE (cells can be cleared/rewritten), so the agent may update
  // sheets autonomously. Only structural deletes (delete entire rows/sheets) still require approval.
  if (/^GOOGLESHEETS_/.test(n) && /(DELETE_ROW|DELETE_SHEET|DELETE_COLUMN)/.test(n)) return true;
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
      // Reuse the existing config as-is. NEVER delete/recreate it — deleting an auth config wipes every
      // connected account under it (that's what made "add a 2nd account" disconnect the 1st). Multi-account
      // is enabled per-connection via the allowMultiple option on connectedAccounts.link(), not here.
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

/** Start an OAuth connection → returns the URL to send the user to + the connection id (a match hint).
 *  ONE account per app: any existing connection for this toolkit is removed first, so connecting again
 *  REPLACES it (also required — without allowMultiple, Composio errors if an active account exists). */
export async function initiateConnection(app: string, userId: string, callbackUrl: string): Promise<{ redirectUrl: string; connectionId: string }> {
  const authConfigId = await resolveAuthConfigId(TOOLKIT_OF(app));
  // Google apps support MULTIPLE accounts: don't remove the existing one, and pass allowMultiple so Composio
  // doesn't reject the link when an active account already exists. Every other app stays single — connecting
  // again replaces the old connection.
  const multi = MULTI_APPS.has(app);
  if (!multi) await disconnect(app, userId).catch(() => {});
  const req: any = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl, ...(multi ? { allowMultiple: true } : {}) } as any);
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

/** Get all connected accounts for a specific app (returns multiple accounts if connected). Pass
 *  resolveEmails=true (UI only — it's N extra calls) to fill in each Gmail account's real address via
 *  GMAIL_GET_PROFILE when Composio's list doesn't include it, so the user sees which inbox is which. */
export async function getConnectedAccounts(userId: string, app: string, resolveEmails = false): Promise<ConnectedAccount[]> {
  try {
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 } as any);
    const items: any[] = (list?.items ?? (Array.isArray(list) ? list : [])).filter(isActive);
    const targetToolkit = norm(TOOLKIT_OF(app));
    const accounts = items
      .filter((i) => acctToolkit(i) === targetToolkit)
      .map((i) => ({
        id: acctId(i),
        email: i?.email || i?.accountEmail || i?.metadata?.email || i?.data?.email,
        toolkit: acctToolkit(i),
        status: i?.status || i?.connectionStatus || i?.state || "ACTIVE",
      }))
      .filter((a) => a.id); // only return accounts with valid IDs
    if (resolveEmails && app === "gmail") {
      await Promise.all(accounts.filter((a) => !a.email).map(async (a) => {
        try {
          const prof: any = await readAction(userId, "GMAIL_GET_PROFILE", {}, a.id);
          a.email = prof?.emailAddress || prof?.email || prof?.response_data?.emailAddress || a.email;
        } catch (e: any) { console.warn("[integrations] gmail email resolve failed:", e?.message ?? e); }
      }));
    }
    return accounts;
  } catch (e: any) {
    console.warn("[integrations] getConnectedAccounts error:", e?.message ?? e);
    return [];
  }
}

/** Disconnect an app by deleting its active connected account. */
export async function disconnect(app: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const list: any = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 } as any);
    const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
    const accounts = items.filter((i) => isActive(i) && acctToolkit(i) === norm(TOOLKIT_OF(app)));
    for (const account of accounts) {
      const id = acctId(account);
      if (id) await (sdk().connectedAccounts as any).delete(id);
    }
    return { ok: true };
  } catch (e: any) {
    console.error(`[integrations] disconnect(${app}) failed:`, e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Disconnect a specific account by its Composio ID (for multi-account support). */
export async function disconnectAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!accountId) return { ok: false, error: "account id required" };
    await (sdk().connectedAccounts as any).delete(accountId);
    return { ok: true };
  } catch (e: any) {
    console.error(`[integrations] disconnectAccount(${accountId}) failed:`, e?.message);
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

/** Run a Composio action for a user. `connectedAccountId` disambiguates WHICH connected account to use —
 *  required for Gmail once the user has more than one (otherwise Composio can't tell which inbox). */
async function execute(action: string, userId: string, args: Record<string, unknown>, connectedAccountId?: string): Promise<string> {
  const result = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true, ...(connectedAccountId ? { connectedAccountId } : {}) } as any);
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

export interface AgentTools {
  tools: AgentTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<string | null>;
  connected: string[];
  /** Send a brief TO THE USER'S OWN INBOX — the recipient is resolved server-side (never model-supplied),
   *  so this is the one send the agent may make autonomously without breaking the "never sends" guarantee. */
  selfBrief?: (subject: string, body: string) => Promise<string>;
  /** A view whose call() may run write-gated actions targeting these artifact ids — the "Otto may edit
   *  what Otto made" carve-out for reruns/revisions. Everything else stays gated. */
  withAllowedArtifacts?: (ids: string[]) => AgentTools;
}
const EMPTY: AgentTools = { tools: [], call: async () => null, connected: [] };

/** Email the user THEMSELVES (e.g. an event brief). The recipient is the connected Gmail account's own
 *  address (fallback: the account email they log in with) — hardcoded here, never chosen by the model. */
export async function sendSelfBrief(userId: string, subject: string, body: string): Promise<string> {
  if (!integrationsReady() || !userId) return "ERROR: integrations not configured";
  const subj = String(subject || "").trim().slice(0, 200);
  const text = String(body || "").trim().slice(0, 8000);
  if (!subj || !text) return "ERROR: subject and body are required";
  let to = userId;
  try { to = (await getConnectedAccounts(userId, "gmail"))[0]?.email || userId; } catch { /* fall back to account email */ }
  if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(to)) return "ERROR: no usable own-address to send to";
  try {
    const r: any = await sdk().tools.execute("GMAIL_SEND_EMAIL", {
      userId,
      arguments: { recipient_email: to, subject: subj, body: text },
      dangerouslySkipVersionCheck: true,
    } as any);
    if (r && (r.successful === false || r.error)) return `ERROR: ${String(r.error || "send failed")}`;
    return `Sent the brief to ${to} (the user's own inbox).`;
  } catch (e: any) { return `ERROR: ${e?.message ?? e}`; }
}

// Building the tool list is N Composio calls; cache per account for a short window so we don't pay it on
// every single task run. (Server process memory — Date.now() is fine here, this isn't a workflow script.)
const cache = new Map<string, { at: number; data: AgentTools }>();
const CACHE_MS = 120_000;
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/** Composio's raw parameter schemas are ENORMOUS — long prop descriptions, examples, defaults, titles,
 *  deeply nested object trees. Every tool's schema is resent on EVERY round of every agent call, and at
 *  ~110 tools the raw schemas alone were ~80k tokens per round (the "664k tokens for one task" logs).
 *  Slim each schema to what the model needs to CALL the tool: required params + a few optionals, each
 *  reduced to {type, short description, enum/items}. Nested objects flatten to type + description —
 *  Composio tolerates loosely-shaped args, and the run agent can retry off the error message if needed. */
function slimSchema(params: any): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  const props = (params && typeof params === "object" && params.properties && typeof params.properties === "object") ? params.properties : {};
  const required: string[] = Array.isArray(params?.required) ? params.required.filter((k: any) => typeof k === "string" && props[k]) : [];
  const keys = Object.keys(props);
  const keep = [...required, ...keys.filter((k) => !required.includes(k))].slice(0, 10);
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    const p = props[k] ?? {};
    const slim: Record<string, unknown> = { type: p.type || "string" };
    if (p.description) slim.description = String(p.description).slice(0, 120);
    if (Array.isArray(p.enum)) slim.enum = p.enum.slice(0, 12);
    if (p.type === "array") slim.items = { type: p.items?.type || "string" };
    out[k] = slim;
  }
  return { type: "object", properties: out, ...(required.length ? { required } : {}) };
}

// Rank a toolkit's actions by usefulness to an assistant, so the per-toolkit cap keeps the RIGHT ones
// (read/create/update on the core nouns) rather than the alphabetically-first plumbing (ACL, channels,
// calendar-list management). Composio returns actions roughly alphabetically, so without this Calendar
// got ACL_*/CHANNELS_*/CREATE_CALENDAR and NO event read/update — the "only CREATE event" bug.
function relevance(n: string): number {
  let s = 0;
  if (/(EVENT|MESSAGE|EMAIL|THREAD|DRAFT|FILE|DOCUMENT|FOLDER|SHEET|SPREADSHEET|ROW|CELL|SLIDE|PRESENTATION|ISSUE|PULL|COMMENT|TASK|REPO|CONTACT|PEOPLE|FREE.?SLOT|FREEBUSY)/.test(n)) s += 3;
  if (/(FIND|SEARCH|LIST|GET|FETCH|READ|CREATE|UPDATE|PATCH|ADD|INSERT|MODIFY|APPEND|MOVE|COPY)/.test(n)) s += 2;
  if (/(ACL|CHANNEL|WATCH|STOP|QUOTA|SETTING|COLOR|DUPLICATE|PERMISSION|SCOPE|SUBSCRIPTION|WEBHOOK|CALENDAR_LIST|CALENDARS_|CREATE_CALENDAR)/.test(n)) s -= 4;
  // UPDATE beats secondary CREATE/COPY/EXPORT variants on relevance ties — without this, the per-toolkit
  // write quota (tight: ~4 slots) filled with COPY_DOCUMENT/EXPORT_DOCUMENT_AS_PDF/CREATE_DOCUMENT2 and
  // silently dropped the ONLY tool that can edit an existing record (observed live: a revision task had
  // no update tool in its toolset at all, so it could never do anything but read or make a duplicate).
  if (/UPDATE/.test(n)) s += 1; // NOT \bUPDATE — "_" counts as a word char in regex, so \b never matched after GOOGLEDOCS_UPDATE_…
  if (/MARKDOWN/.test(n)) s += 1; // markdown-text tools need no structural/index inspection first — easiest to use correctly
  return s;
}

// Some toolkits ship several near-duplicate actions for the SAME verb+noun (Composio's GOOGLEDOCS has
// CREATE_DOCUMENT / CREATE_DOCUMENT2 / CREATE_DOCUMENT_MARKDOWN, and four different UPDATE_DOCUMENT_*
// variants) — left alone, relevance ties let ONE verb family (e.g. all the UPDATE_DOCUMENT_* forms) eat
// the entire per-toolkit write quota, silently crowding CREATE out (or vice versa). Collapse to the
// best-scored action per (verb, noun) family BEFORE capping, so create and update both survive.
const CANON_VERBS = ["CREATE", "UPDATE", "DELETE", "INSERT", "GET", "LIST", "FIND", "SEARCH"];
function actionFamily(rawName: string): string {
  const parts = rawName.split("_");
  const verbIdx = parts.findIndex((p) => CANON_VERBS.includes(p));
  if (verbIdx === -1) return rawName;
  const noun = (parts[verbIdx + 1] || "").replace(/\d+$/, ""); // strip a trailing digit (…_DOCUMENT2 → …_DOCUMENT)
  return `${parts[verbIdx]}:${noun}`;
}
function dedupeFamilies<T extends { rawName: string }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const x of items) {
    const key = actionFamily(x.rawName);
    const cur = best.get(key);
    if (!cur || relevance(x.rawName) > relevance(cur.rawName)) best.set(key, x);
  }
  return [...best.values()];
}
// Is this action a pure READ (gather context) vs a write? Used to guarantee BOTH kinds survive the per-toolkit cap.
const isRead = (n: string) => /(GET|LIST|FIND|SEARCH|FETCH|READ|DOWNLOAD|EXPORT|FREE_BUSY|INSTANCES)/.test(n)
  && !/(CREATE|UPDATE|INSERT|APPEND|ADD|PATCH|MODIFY|DELETE|REMOVE|WRITE|REPLACE|COPY|MOVE|BATCH_UPDATE|BATCH_MODIFY|SET_)/.test(n);

/** A READ-ONLY view of an AgentTools set, for the generation sweep: it only ever reads, so shipping write
 *  schemas to it every round is pure token waste — and this makes "READ ONLY" structural, not prompt-enforced.
 *  (Sanitized tool names keep the Composio verb words, so isRead matches them directly.) No selfBrief either:
 *  the sweep must not send anything. */
export function readOnly(t: AgentTools): AgentTools {
  return { tools: t.tools.filter((x) => isRead(x.name)), call: t.call, connected: t.connected };
}

/**
 * Task-scoped toolset: every tool schema is resent on EVERY round, so shipping all ~78 tools to a task
 * that touches one app is the single biggest token cost (observed ~230k in/run) AND a focus problem
 * (more tools → more read-drift). Keep the always-useful core plus only the toolkits the task's text
 * actually implicates; fall back to the full set when scoping would leave too little.
 */
const TOOLKIT_HINTS: [RegExp, string][] = [
  [/\b(meet|meeting|call|schedule|calendar|invite|event|appointment|book)\w*/i, "googlecalendar"],
  [/\b(sheet|spreadsheet|cells?|rows?|columns?|track|budget|expense|tabular)\w*/i, "googlesheets"],
  [/\b(deck|slides?|presentation|pitch)\w*/i, "googleslides"],
  [/\b(repo|pull request|\bpr\b|issue|github|merge|commit)\w*/i, "github"],
  [/\b(notion|wiki|knowledge base)\w*/i, "notion"],
  [/\b(slack|channel|dm)\b/i, "slack"],
  [/\b(linear|ticket)\b/i, "linear"],
  [/\b(todoist)\b/i, "todoist"],
];
const CORE_TOOLKITS = ["gmail", "googledocs", "googledrive"]; // read the world, make docs, find files — every task
export function scopeTools(t: AgentTools, task: { title: string; why?: string; source?: string }): AgentTools {
  if (t.tools.length <= 30) return t; // already small — nothing to win
  const text = `${task.title} ${task.why || ""}`;
  const keep = new Set<string>(CORE_TOOLKITS);
  if (task.source === "calendar") keep.add("googlecalendar");
  if (task.source && task.source !== "manual" && task.source !== "web") keep.add(task.source);
  for (const [re, kit] of TOOLKIT_HINTS) if (re.test(text)) keep.add(kit);
  const scoped = t.tools.filter((x) => {
    const m = /^\[(\w+)\]/.exec(x.description || "");
    return !m || keep.has(m[1].toLowerCase());
  });
  // Floor: a mis-scoped run is worse than an expensive one — if scoping stripped too much, keep everything.
  if (scoped.length < 15) return t;
  return { ...t, tools: scoped };
}

/** Execute ONE explicitly-named READ action directly (the deterministic discovery pipeline) — refuses
 *  anything that isn't a pure read, so this path can never write, send, or delete regardless of caller. */
export async function readAction(userId: string, action: string, args: Record<string, unknown>, connectedAccountId?: string): Promise<any> {
  if (!integrationsReady() || !userId) throw new Error("integrations not configured");
  const policy = ACTION_POLICIES[action.toUpperCase()];
  if (policy !== "auto" || !isRead(action.toUpperCase())) throw new Error(`not an allowed read action: ${action}`);
  const r: any = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true, ...(connectedAccountId ? { connectedAccountId } : {}) } as any);
  if (r && r.successful === false) throw new Error(String(r.error || `read failed: ${action}`));
  return r?.data ?? r;
}

// ── Integration smoke test ────────────────────────────────────────────────────
// Live create → verify → clean-up per connected app, run ONLY on the user's explicit click in Settings.
// This is the "does every action name, payload, and OAuth scope actually work against the real account"
// check that unit tests can't provide. It executes directly (its own hardcoded steps, not the agent), so
// the agent policy registry doesn't apply — the user's click IS the approval, and every artifact it
// creates is labeled and removed at the end.
export interface SmokeResult { app: string; step: string; ok: boolean; detail?: string }

async function execDirect(userId: string, action: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true } as any);
  if (r && r.successful === false) throw new Error(String(r.error || `${action} failed`));
  return r?.data ?? r;
}
const firstId = (d: any, ...paths: string[]): string => {
  for (const p of paths) {
    let v: any = d;
    for (const k of p.split(".")) v = v?.[k];
    if (v) return String(v);
  }
  return "";
};

export async function runSmokeTest(userId: string): Promise<SmokeResult[]> {
  if (!integrationsReady() || !userId) return [{ app: "composio", step: "configured", ok: false, detail: "Composio not configured" }];
  const { connected } = await getAgentTools(userId);
  const results: SmokeResult[] = [];
  const step = async (app: string, name: string, fn: () => Promise<string>): Promise<boolean> => {
    try { results.push({ app, step: name, ok: true, detail: await fn() }); return true; }
    catch (e: any) { results.push({ app, step: name, ok: false, detail: String(e?.message || e).slice(0, 250) }); return false; }
  };
  const MARK = "Otto integration check — safe to delete";

  if (connected.includes("gmail")) {
    let self = "";
    await step("gmail", "read profile", async () => {
      const d = await execDirect(userId, "GMAIL_GET_PROFILE", {});
      self = firstId(d, "emailAddress", "email_address", "response_data.emailAddress");
      return self || "ok";
    });
    let draftId = "";
    const created = await step("gmail", "create draft", async () => {
      const d = await execDirect(userId, "GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: self || userId, subject: MARK, body: "Created by Otto's integration check. It verifies drafting works, then deletes this draft." });
      draftId = firstId(d, "id", "draft.id", "response_data.id", "response_data.draft.id");
      return draftId ? `draft ${draftId}` : "created (no id returned)";
    });
    if (created && draftId) {
      await step("gmail", "verify draft live", async () => {
        const d = await execDirect(userId, "GMAIL_LIST_DRAFTS", { max_results: 25 });
        if (!JSON.stringify(d ?? "").includes(draftId)) throw new Error("created draft not found in the live drafts list");
        return "found in drafts";
      });
      await step("gmail", "clean up draft", async () => { await execDirect(userId, "GMAIL_DELETE_DRAFT", { draft_id: draftId }); return "deleted"; });
    }
  }

  if (connected.includes("googlecalendar")) {
    await step("calendar", "read events", async () => { await execDirect(userId, "GOOGLECALENDAR_EVENTS_LIST", { calendar_id: "primary", max_results: 5 }); return "listed"; });
    let eventId = "";
    const created = await step("calendar", "create test event", async () => {
      const d = await execDirect(userId, "GOOGLECALENDAR_QUICK_ADD", { calendar_id: "primary", text: `${MARK} tomorrow 4am` });
      eventId = firstId(d, "id", "event.id", "response_data.id", "event_data.id");
      return eventId ? `event ${eventId}` : "created (no id returned)";
    });
    if (created && eventId) {
      await step("calendar", "verify event live", async () => { await execDirect(userId, "GOOGLECALENDAR_GET_EVENT", { calendar_id: "primary", event_id: eventId }); return "found"; });
      await step("calendar", "clean up event", async () => { await execDirect(userId, "GOOGLECALENDAR_DELETE_EVENT", { calendar_id: "primary", event_id: eventId }); return "deleted"; });
    }
  }

  if (connected.includes("googledrive")) {
    await step("drive", "list files", async () => { await execDirect(userId, "GOOGLEDRIVE_LIST_FILES", { page_size: 5 }); return "listed"; });
  }

  if (connected.includes("googledocs")) {
    let docId = "";
    const created = await step("docs", "create test doc", async () => {
      const d = await execDirect(userId, "GOOGLEDOCS_CREATE_DOCUMENT", { title: MARK, text: "Created by Otto's integration check." });
      docId = firstId(d, "documentId", "document_id", "response_data.documentId", "id");
      return docId ? `doc ${docId}` : "created (no id returned)";
    });
    if (created && docId) {
      await step("docs", "verify doc live", async () => { await execDirect(userId, "GOOGLEDOCS_GET_DOCUMENT_BY_ID", { id: docId }); return "found"; });
      if (connected.includes("googledrive")) await step("docs", "clean up doc", async () => { await execDirect(userId, "GOOGLEDRIVE_DELETE_FILE", { file_id: docId }); return "deleted"; });
    }
  }

  if (connected.includes("googlesheets")) {
    let sheetId = "";
    const created = await step("sheets", "create test sheet", async () => {
      const d = await execDirect(userId, "GOOGLESHEETS_CREATE_GOOGLE_SHEET1", { title: MARK });
      sheetId = firstId(d, "spreadsheetId", "spreadsheet_id", "response_data.spreadsheetId");
      return sheetId ? `sheet ${sheetId}` : "created (no id returned)";
    });
    if (created && sheetId) {
      await step("sheets", "write cell", async () => { await execDirect(userId, "GOOGLESHEETS_UPDATE_VALUES", { spreadsheet_id: sheetId, range: "A1", values: [["otto-check"]], value_input_option: "RAW" }); return "wrote A1"; });
      await step("sheets", "read cell back", async () => {
        const d = await execDirect(userId, "GOOGLESHEETS_BATCH_GET", { spreadsheet_id: sheetId, ranges: ["A1"] });
        if (!JSON.stringify(d ?? "").includes("otto-check")) throw new Error("written value not found on read-back");
        return "verified round-trip";
      });
      if (connected.includes("googledrive")) await step("sheets", "clean up sheet", async () => { await execDirect(userId, "GOOGLEDRIVE_DELETE_FILE", { file_id: sheetId }); return "deleted"; });
    }
  }

  if (!results.length) results.push({ app: "none", step: "connected apps", ok: false, detail: "Nothing connected to check — connect Gmail/Calendar/Drive first." });
  return results;
}

// ── Live artifact verification ────────────────────────────────────────────────
// After a run claims it created something, read it back through the read-only path and prove it exists.
// Drop ONLY on an explicit not-found from a successful API round-trip — a transient error (network, quota)
// keeps the artifact, so verification can never destroy a valid result it merely failed to check.
const NOT_FOUND = /(not.?found|404|does ?n.t exist|invalid.*(id|value)|deleted|no such)/i;

/** true = confirmed live, false = confirmed missing, null = couldn't verify (keep). */
async function probeArtifact(userId: string, action: string, args: Record<string, unknown>, expectRef?: string): Promise<boolean | null> {
  try {
    const data = await readAction(userId, action, args);
    if (!expectRef) return true; // a direct GET succeeding is the proof
    return JSON.stringify(data ?? "").includes(expectRef); // list-style probe: the ref must appear in the payload
  } catch (e: any) {
    return NOT_FOUND.test(String(e?.message || "")) ? false : null;
  }
}

export const DOC_LINK = /docs\.google\.com\/(document|spreadsheets|presentation)\/(?:d\/)?([-\w]{25,})/i;

/**
 * Verify a finished run's claimed artifacts against the LIVE account: Gmail draft ids via the drafts list,
 * calendar events via a direct GET, Google Docs/Sheets links via a direct GET on the document id.
 * Prunes anything confirmed missing IN PLACE and returns human-readable notes about what was dropped.
 */
export async function verifyTaskArtifacts(
  userId: string,
  t: { links?: { label: string; url: string }[]; sendables?: { app: string; label: string; draftId?: string; eventId?: string }[] },
): Promise<string[]> {
  if (!integrationsReady() || !userId) return [];
  const dropped: string[] = [];
  // Gmail drafts: one list call covers every gmail sendable on the task.
  const gmailSendables = (t.sendables || []).filter((s) => s.app === "gmail" && s.draftId);
  let draftsPayload: string | null = null;
  if (gmailSendables.length) {
    try { draftsPayload = JSON.stringify(await readAction(userId, "GMAIL_LIST_DRAFTS", { max_results: 50 }) ?? ""); }
    catch { draftsPayload = null; } // couldn't list → verify nothing, keep everything
  }
  const keptSendables: NonNullable<typeof t.sendables> = [];
  for (const s of t.sendables || []) {
    let ok: boolean | null = null;
    if (s.app === "gmail" && s.draftId && draftsPayload !== null) ok = draftsPayload.includes(s.draftId);
    else if (s.app === "gcal" && s.eventId) ok = await probeArtifact(userId, "GOOGLECALENDAR_GET_EVENT", { event_id: s.eventId });
    if (ok === false) dropped.push(`"${s.label}" — the ${s.app === "gcal" ? "calendar event" : "draft"} it points at doesn't exist`);
    else keptSendables.push(s);
  }
  const keptLinks: NonNullable<typeof t.links> = [];
  for (const l of t.links || []) {
    const m = DOC_LINK.exec(l.url);
    let ok: boolean | null = null;
    if (m && m[1] === "document") ok = await probeArtifact(userId, "GOOGLEDOCS_GET_DOCUMENT_BY_ID", { id: m[2] });
    else if (m && m[1] === "spreadsheets") ok = await probeArtifact(userId, "GOOGLESHEETS_GET_SPREADSHEET_INFO", { spreadsheet_id: m[2] });
    if (ok === false) dropped.push(`"${l.label}" — the linked document doesn't exist`);
    else keptLinks.push(l);
  }
  if (t.sendables) t.sendables = keptSendables as any;
  if (t.links) t.links = keptLinks as any;
  if (dropped.length) console.warn(`[integrations] artifact verification dropped ${dropped.length}: ${dropped.join("; ")}`);
  return dropped;
}

/**
 * Composio tools for the apps the user connected, in Anthropic tool shape — READ + reversible WRITES, so
 * the run/generation agent can both gather facts AND do the work (draft a reply, create a doc, add a task,
 * update an issue). Irreversible OUTBOUND/DESTRUCTIVE actions (send, post, publish, delete) are filtered
 * out (isGatedAction) and never reach the agent. Returns empty fast when nothing's connected or Composio
 * isn't configured, so it adds at most one list() call.
 */
export async function getAgentTools(userId: string, opts?: { gmailAccountId?: string }): Promise<AgentTools> {
  if (!integrationsReady() || !userId) return EMPTY;
  const gmailAccountId = opts?.gmailAccountId;
  const cacheKey = gmailAccountId ? `${userId}::gmail:${gmailAccountId}` : userId;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const connected = await listConnectedToolkits(userId);
  if (!connected.length) { const data = { ...EMPTY, connected }; cache.set(userId, { at: Date.now(), data }); return data; }

  const tools: AgentTool[] = [];
  const map = new Map<string, string>(); // sanitized tool name → raw Composio action slug
  // Every tool schema here is resent on EVERY round of every agent call — the single biggest fixed cost
  // multiplier in the whole system (schemas × rounds). Kept lean: still enough slots per app for real
  // read+write coverage (guaranteed by the 60/40 split below), just not the old alphabet-soup ceiling.
  const MAX = 90;
  const perToolkit = Math.min(10, Math.max(6, Math.floor(MAX / connected.length)));
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
    const writes = dedupeFamilies(ranked.filter((x) => !isRead(x.rawName))).sort((a, b) => relevance(b.rawName) - relevance(a.rawName));
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
      // Kept SHORT — this text is resent every round for every tool; the (self-describing Composio) name
      // plus a one-line gist is enough to pick the right action, the slim input_schema explains the params.
      tools.push({ name, description: `[${app}] ${String(fn?.description ?? rawName).slice(0, 140)}`, input_schema: slimSchema(params) });
      added++;
    }
  }
  const makeCall = (allowIds?: Set<string>) => async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    const action = map.get(name);
    if (!action) return null;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete — leave it as a step for the user instead.`;
    // HARDCODED PERMISSION GATE: editing existing documents and creating/updating calendar events require
    // the user's explicit "Approve & Run" click — EXCEPT artifacts OTTO ITSELF created for this task
    // (allowIds): Otto may edit what Otto made, never the user's own documents.
    if (isWriteGatedAction(action)) {
      const argStr = JSON.stringify(args || {});
      const targetsOwnArtifact = !!allowIds && [...allowIds].some((id) => id.length >= 8 && argStr.includes(id));
      if (!targetsOwnArtifact) {
        return `PERMISSION_REQUIRED: "${action}" requires explicit user approval before it can run. ` +
          `Add it as an automatable step in submit() so the user can approve it with one click.`;
      }
    }
    // Hard guard: a calendar event with attendees/notifications EMAILS invites. Force send_updates="none" so the
    // agent can NEVER send a calendar invite — the event lands on the user's calendar silently; they invite people.
    if (/^GOOGLECALENDAR_/.test(action) && args && (("attendees" in args) || ("send_updates" in args))) {
      args = { ...args, send_updates: "none" };
    }
    // Route Gmail actions to the SPECIFIC connected account this run belongs to (when the user has more
    // than one). Other toolkits are single-account, so they don't need it.
    try { return await execute(action, userId, args || {}, /^GMAIL_/.test(action) ? gmailAccountId : undefined); }
    catch (e: any) { return `Tool error (${action}): ${e?.message ?? e}`; }
  };
  const data: AgentTools = {
    tools, call: makeCall(), connected,
    // Only offered when Gmail is connected — that's both the send channel and the recipient source.
    selfBrief: connected.includes("gmail") ? (subject, body) => sendSelfBrief(userId, subject, body) : undefined,
  };
  data.withAllowedArtifacts = (ids: string[]) => ({ ...data, call: makeCall(new Set(ids.filter(Boolean))), withAllowedArtifacts: data.withAllowedArtifacts });
  cache.set(cacheKey, { at: Date.now(), data });
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
  return { tools: base.tools, call: permCall, connected: base.connected, selfBrief: base.selfBrief };
}
