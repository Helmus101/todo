import OpenAI from "openai";
import type { Profile, TaskStep, TaskLink, Sendable } from "../shared/types.ts";
import type { AgentTools } from "./integrations.ts";
import { webSearch } from "./chat";

/** Render the person-profile for prompts so generation + execution are personalized + grounded. */
function profileBlock(p?: Profile): string {
  if (!p) return "";
  // Newest 12 facts per category go into the prompt (storage keeps up to 40): keeps every call lean —
  // this block ships with EVERY agent request, so its size is a direct cost multiplier.
  const recent = (l?: string[]) => (l || []).slice(-12);
  const parts: string[] = [];
  if (p.name) parts.push(`Their name: ${p.name}`);
  if (p.about) parts.push(`About them: ${p.about}`);
  if (recent(p.preferences).length) parts.push(`Preferences: ${recent(p.preferences).join("; ")}`);
  if (recent(p.people).length) parts.push(`Key people: ${recent(p.people).join("; ")}`);
  if (recent(p.projects).length) parts.push(`Ongoing projects: ${recent(p.projects).join("; ")}`);
  if (p.workingHours) parts.push(`Working hours: ${p.workingHours.start}-${p.workingHours.end} (${p.workingHours.timezone})`);
  if (p.responseStyle) parts.push(`Response style: ${p.responseStyle}`);
  // Auto-approve entries are the user's PREFERENCE, never permission: the code-enforced action policy
  // still gates every tool call — a policy-gated action stays gated no matter what this list says.
  if (p.autoApprove?.length) parts.push(`Prefers automated handling of: ${p.autoApprove.join(", ")} (preference only — the permission system still decides; gated actions still need approval)`);
  if (p.highPriorityPeople?.length) parts.push(`High-priority people: ${p.highPriorityPeople.join(", ")}`);
  if (p.autoArchivePatterns?.length) parts.push(`Considers noise (never surface as tasks): ${p.autoArchivePatterns.join(", ")}`);
  return parts.length ? `\nWHO THIS PERSON IS — their stated preferences are INSTRUCTIONS to follow (what to include, skip, prioritize, and how to phrase/do things), not background:\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
}

/** Current date + time, injected into every agent prompt so "today"/"tomorrow"/deadlines/scheduling are
 *  grounded. (Server runtime — new Date() is fine here; this is not a workflow script.) */
function nowBlock(): string {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* ignore */ }
  return `CURRENT DATE & TIME: ${date}, ${time}${tz ? ` (${tz})` : ""}. Reason about "today", "tomorrow", deadlines, scheduling and date conflicts relative to THIS. If you need a date/fact you're unsure of (a public deadline, a format, current info), use web_search rather than guess.\n`;
}

function deadlineBlock(text: string): string {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = raw.match(/\b(before|by|until|due)\b\s*[:\-]?\s*([^\n]+)/i);
  if (!match) return "";
  // Don't emit a deadline hint for a date that is clearly in the past — the agent would
  // think it missed the window, stall, or produce unhelpful "deadline passed" steps.
  const snippet = match[0];
  const yearMatch = snippet.match(/\b(20\d{2})\b/);
  const monthDayMatch = snippet.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
    const months: Record<string,number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const mo = months[monthDayMatch[1].slice(0,3).toLowerCase()];
    const dy = Number(monthDayMatch[2]);
    if (mo !== undefined) {
      const deadline = new Date(year, mo, dy);
      if (deadline < new Date()) return ""; // already past — suppress the misleading hint
    }
  }
  return `EXPLICIT DEADLINE PHRASE FROM THE TASK: "${snippet}". Treat that deadline/date as exact and preserve it unless the source data clearly contradicts it.\n`;
}

const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export function aiReady(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

function deepseekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY in web/.env.");
  return new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
  });
}

/** Is this a TRANSIENT failure worth retrying (connection dropped / gateway / rate limit)? Checks the
 *  error's own code, the undici CAUSE chain ("TypeError: terminated" wraps an ECONNRESET cause — the exact
 *  shape that was killing whole sweeps un-retried), the message, and the HTTP status. */
function isTransient(e: any): boolean {
  const code = String(e?.code || e?.cause?.code || "");
  if (["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
  const msg = `${e?.message || ""} ${e?.cause?.message || ""}`;
  if (/fetch failed|socket hang up|terminated|aborted|premature close|network|other side closed/i.test(msg)) return true;
  return [429, 500, 502, 503, 504].includes(Number(e?.status));
}

async function retryRequest<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (!isTransient(e) || i === retries - 1) throw e;
      console.warn(`[ai] request failed (${e?.message || e}), retrying in ${delayMs}ms... (attempt ${i + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  throw lastErr;
}

/** Tolerant: pull the first JSON value (object or array) out of a model reply. */
function firstJson<T>(raw: string): T | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)) as T; } catch { return null; } } }
  }
  return null;
}

/** Older tool results have served their purpose (the model already acted on them). Truncating them hard
 *  before each round stops the transcript growing quadratically over a long run — the biggest token sink.
 *  The most recent results stay full so current work is never degraded. */
const TRIM_KEEP = 4, TRIM_TO = 250;
function trimOldToolResults(messages: any[]): any[] {
  if (messages.length <= TRIM_KEEP) return messages;
  const cut = messages.length - TRIM_KEEP;
  return messages.map((m, i) =>
    i < cut && m.role === "tool" && typeof m.content === "string" && m.content.length > TRIM_TO
      ? { ...m, content: m.content.slice(0, TRIM_TO) + "\n…[older result truncated]" }
      : m);
}

function parseToolArgs(raw: any): any {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const repaired = firstJson<any>(text);
    return repaired && typeof repaired === "object" ? repaired : {};
  }
}

export interface GeneratedTask {
  title: string;
  why: string;
  when?: string;
  source: string;          // the app this is from: "gmail" | "calendar" | a connected-app slug (slack, github, …)
  risk: "low" | "high";
  urgency: number;
  importance: number;
  /** Stable id of the underlying item the agent based this on (e.g. "gmail:<threadId>",
   *  "calendar:<eventId>") — used for dedupe across refreshes. */
  anchorKey?: string;
  /** A URL to open the source item (the Gmail thread / the calendar event), if the agent has one. */
  link?: string;
}

const GEN_SYSTEM =
  `You are an autonomous operations assistant — a sharp chief-of-staff turning someone's live world into their ` +
  `real, COMPLETE to-do list. Your job is to FIND, PRIORITIZE, and EXECUTE work — not just record it. Use EVERY ` +
  `tool available — across ALL their connected apps, not just email — to READ what genuinely needs them right ` +
  `now, then call submit_tasks. Sweep each connected source AGGRESSIVELY for actionable items, e.g.:\n` +
  `- Gmail: threads awaiting a reply or asking something (skip newsletters/promos/receipts/no-reply).\n` +
  `NEWSLETTERS & PROMOTIONAL EMAIL — HARD EXCLUSION: NEVER create a task to reply to, respond to, or otherwise ` +
  `engage with a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender — a Gmail ` +
  `"promotions"/"social" category, an unsubscribe footer, or a sender containing "noreply"/"no-reply"/` +
  `"newsletter"/"marketing"/"updates@"/"news@" are all signals of this. This holds even if the email asks a ` +
  `question, has a "reply" call-to-action, or looks personalized — it's still mass mail. Skip it entirely; ` +
  `do not surface it as a to-do of any kind.\n` +
  `- Calendar: meetings in the next ~48h to prepare for or respond to, conflicts to resolve.\n` +
  `- Slack / Discord: DMs & mentions awaiting your reply.\n` +
  `- GitHub / Linear / Jira: issues & PRs assigned to you, review requests, things blocking others.\n` +
  `- Notion / Todoist / Asana / Trello / ClickUp: tasks assigned or due soon.\n` +
  `- CRM (HubSpot, Salesforce): deals needing follow-up, tasks due, opportunities at risk.\n` +
  `- Any other connected app: whatever is genuinely waiting on this person.\n` +
  `- COMMITMENTS THEY MADE: also check their recently SENT mail/messages (e.g. Gmail search "in:sent newer_than:7d") ` +
  `for promises THEY made to others — "I'll send you X", "I'll get back to you by Friday", "let me check and ` +
  `follow up" — and create a task to FULFILL each one that looks unfulfilled (no later reply/attachment in the ` +
  `thread). Title it as the commitment ("Send Sarah the budget deck"), set "when" from the promised deadline, ` +
  `and anchor it to the sent thread ('gmail:<threadId>'). A broken promise is worse than a missed email.\n` +
  `- CONTEXT GATHERING: For every actionable item, GATHER FULL CONTEXT — search related threads, check calendar ` +
  `for conflicts, find relevant docs, pull in CRM data. A task without context is half-baked.\n` +
  `Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable ` +
  `noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; ` +
  `never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a ` +
  `sender is, a public deadline).\n` +
  `GMAIL — SEARCH IT SEVERAL WAYS, not one generic fetch: (1) recent inbox needing action ` +
  `("in:inbox newer_than:7d -category:promotions -category:social"), (2) unread ("is:unread in:inbox"), ` +
  `(3) their SENT mail for open loops ("in:sent newer_than:10d") — read what THEY promised and check whether ` +
  `they delivered, (4) threads where someone asked them something and the last message is NOT theirs ` +
  `(they owe a reply), (5) search for key people/projects from their profile to find loose ends.\n` +
  `USE THEIR PROFILE AS SEARCH LEADS: pick the 2-3 most active projects/people listed below and run ONE ` +
  `targeted search each (the name in Gmail or the relevant app) to find loose ends — an unanswered thread, ` +
  `an upcoming deadline, a doc waiting on them. What did they say they'd do but haven't?\n` +
  `PREFERENCES ARE BINDING, not decoration — the "Preferences" lines in their profile MUST shape the list:\n` +
  `- FILTER: if a preference says they don't care about something (a topic, a sender, a kind of work), do NOT ` +
  `create tasks for it, even if it looks actionable.\n` +
  `- RANK: raise importance for tasks matching what they've said matters (their priorities, projects, people); ` +
  `lower it for what they've deprioritized. Two equal emails ≠ two equal tasks if a preference separates them.\n` +
  `- SHAPE: phrase titles/whys in line with how they work (e.g. "batch admin on Fridays" → set "when" accordingly; ` +
  `"prefers calls over email" → the task suggests a call). When a preference influenced a task, reflect it in "why".\n` +
  `- WORKING HOURS: if they have working hours set, consider whether tasks can be done within those hours.\n` +
  `- RESPONSE STYLE: if they prefer concise/detailed/casual/formal, this should influence how you phrase tasks.\n` +
  `- AUTO-APPROVE: if they've approved certain categories (e.g., "schedule_meetings_under_30min"), mark those as low risk.\n` +
  `- HIGH PRIORITY PEOPLE: if someone is in their high-priority list, their requests get higher urgency.\n` +
  `- AUTO-ARCHIVE: if they've set patterns to auto-archive (e.g., newsletters), filter those out.\n` +
  `NEVER resurface a to-do the user already finished or DISMISSED — if an ` +
  `"ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ` +
  `ONE TASK PER UNDERLYING ITEM: never submit two wordings of the same to-do — one thread/event/commitment = ` +
  `ONE task, with its stable anchorKey. If two findings point at the same obligation, merge them into one task.\n` +
  `QUALITY OVER QUANTITY — surface the handful (≤ ~12) of items that genuinely matter; skip marginal ` +
  `"maybes". A short list the user trusts beats a complete list they ignore.\n` +
  `READ ONLY here — do NOT create, modify, draft, or send anything during ` +
  `generation. BUDGET: you have roughly 6-8 tool calls TOTAL — batch your Gmail searches into ONE round ` +
  `(issue them as parallel calls), give each other app ONE targeted read, never re-read the same source, ` +
  `and submit as soon as you have the picture. Thorough ≠ exhaustive.`;

const SUBMIT_TASKS_TOOL = {
  name: "submit_tasks",
  description: "Submit the full actionable to-do list you found.",
  input_schema: { type: "object", properties: {
    tasks: { type: "array", description: "one per actionable thread/event", items: { type: "object", properties: {
      title: { type: "string", description: "short imperative, <= 9 words" },
      why: { type: "string", description: "one grounded clause naming the concrete trigger" },
      when: { type: "string", description: "concise timeline/deadline grounded in the data (e.g. 'today', 'by Fri 5pm') or '' " },
      source: { type: "string", description: "the connected app this is from, as a lowercase slug: gmail, calendar, slack, github, notion, linear, todoist, …" },
      risk: { type: "string", enum: ["low", "high"], description: "'high' if completing it means sending/inviting (irreversible)" },
      urgency: { type: "number", description: "0..1 time pressure" },
      importance: { type: "number", description: "0..1 stakes" },
      anchorKey: { type: "string", description: "ALWAYS set this — the item's STABLE id EXACTLY as the tool returned it, prefixed by app: 'gmail:<threadId>', 'calendar:<eventId>', etc. Use the SAME value every run so the task is never duplicated." },
      link: { type: "string", description: "a URL to open the source item, if you have one" },
    }, required: ["title", "why", "source", "urgency", "importance"] } },
    profileUpdates: { type: "array", description: "0-4 durable facts about WHO THIS PERSON IS that you discovered while sweeping (their role, a key relationship, an ongoing project, a work preference) — including a CORRECTED/updated version of a profile line above that's now outdated. Not task content; only lasting identity facts.", items: { type: "object", properties: {
      category: { type: "string", enum: ["name", "about", "preference", "person", "project"] },
      fact: { type: "string", description: "one short sentence" },
    }, required: ["category", "fact"] } },
  }, required: ["tasks"] },
};

/** Validate model-supplied profile updates (shared by generation submit + chat remember). */
export function parseProfileUpdates(arr: any): ProfileUpdate[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((u): ProfileUpdate => ({
      category: ["name", "about", "preference", "person", "project"].includes(u?.category) ? u.category : "preference",
      fact: String(u?.fact || "").trim().slice(0, 200),
    }))
    .filter((u) => u.fact)
    .slice(0, 4);
}

// Shared web-search tool for the task agents — gives generation + execution the same "look it up" power the
// chat has, so planning or doing a task can pull in external context (a person, a deadline, a how-to, a link).
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the web for current or background facts you can't get from the connected apps — a person/company, a deadline or figure, how to do something, a reference link. Returns top results (title, url, snippet).",
  input_schema: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] },
};
async function runWebSearch(input: any): Promise<string> {
  const q = String(input?.query || "").trim();
  if (!q) return "[]";
  return JSON.stringify((await webSearch(q)).slice(0, 6));
}

// The ONE autonomous send the run agent has: an email to the USER THEMSELVES. The server resolves the
// recipient (their own connected Gmail address) — the model supplies only subject + body, so it is
// structurally impossible to message anyone else through this.
const SELF_BRIEF_TOOL = {
  name: "send_self_brief",
  description: "Email a brief TO THE USER'S OWN INBOX (the server addresses it to them — you cannot pick a recipient). Use when something upcoming needs prep they should see WITHOUT opening this app: a meeting/event in the next ~48h (send who/when/where or link, agenda, 2-4 prep points, doc links) or day-of logistics. Plain text, tight, scannable. NEVER a way to message anyone else; at most one per task.",
  input_schema: { type: "object", properties: {
    subject: { type: "string", description: "short subject, e.g. 'Brief: Q3 review with Sarah — Thu 2pm'" },
    body: { type: "string", description: "the brief — plain text, short lines/bullets, all specifics included" },
  }, required: ["subject", "body"] },
};

// Sources where every item HAS a stable id/link the tools return — a task claiming to come from one of
// these without either is unverifiable (likely hallucinated or sloppily reported) and gets dropped.
const ANCHORED_SOURCES = new Set(["gmail", "calendar", "googlecalendar", "slack"]);

export function parseGenerated(arr: any): GeneratedTask[] {
  if (!Array.isArray(arr)) return [];
  return arr
    // Grounding gate: a task needs a real title AND a concrete trigger ("why") — junk without evidence is dropped.
    .filter((t) => t && typeof t.title === "string" && t.title.trim().length >= 4 && String(t.why || "").trim())
    // Grounding gate 2: an app-sourced task must POINT at its source item (anchorKey or link).
    .filter((t) => !ANCHORED_SOURCES.has(String(t.source || "").trim().toLowerCase()) ||
      !!String(t.anchorKey || "").trim() || /^https?:\/\//i.test(String(t.link || "")))
    .map((t): GeneratedTask => ({
      title: String(t.title).slice(0, 90),
      why: String(t.why || "").slice(0, 400),
      when: t.when ? String(t.when).slice(0, 40) : undefined,
      source: typeof t.source === "string" && t.source.trim() ? t.source.trim().toLowerCase().slice(0, 24) : "gmail",
      risk: t.risk === "high" ? "high" : "low",
      urgency: clamp01(t.urgency ?? 0.5),
      importance: clamp01(t.importance ?? 0.6),
      anchorKey: t.anchorKey ? String(t.anchorKey).trim().slice(0, 120) : undefined,
      link: t.link && /^https?:\/\//i.test(String(t.link)) ? String(t.link) : undefined,
    }))
    // 20 is generous for a DELTA sweep (the model is told what's already on the list) — anything beyond
    // this is the model rebuilding the world, not reporting what's new.
    .slice(0, 20);
}

/**
 * Generate the to-do list as a tool-using agent over the user's CONNECTED apps (Composio Gmail + Calendar):
 * it reads the recent inbox + upcoming events itself, then submits tasks. Returns [] if nothing is connected
 * to read (the client then prompts the user to connect Gmail/Calendar in Settings).
 */
export interface GenerationResult { tasks: GeneratedTask[]; profileUpdates: ProfileUpdate[]; }

export async function generateTasks(profile?: Profile, extras?: AgentTools, handled?: { title: string; anchorKey?: string }[], active?: { title: string; anchorKey?: string }[]): Promise<GenerationResult> {
  const empty: GenerationResult = { tasks: [], profileUpdates: [] };
  if (!extras?.tools?.length) return empty; // nothing connected to read
  const tools = [...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length
    ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.`
    : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length
    ? `\nALREADY HANDLED — I already finished or dismissed these; do NOT create a task for any of them again, ` +
      `even if its source email/event is still around. A dismissal is a PREFERENCE SIGNAL: I looked at that ` +
      `task and said no — so also skip anything SIMILAR to a dismissed item (same thread, same kind of ask, ` +
      `same sender's request reworded):\n` +
      handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  // The sweep is a DELTA: knowing what's already on the list is what keeps it from re-reporting (and
  // re-wording) the same items every day — the top source of both duplicates and wasted submit tokens.
  const activeBlock = active?.length
    ? `\nALREADY ON THEIR LIST (active) — do NOT re-report these; submit ONLY items that are on NEITHER this ` +
      `list nor the handled list. If nothing new is waiting, submit an empty list — that is a GOOD answer:\n` +
      active.slice(0, 30).map((a) => `- ${a.title}${a.anchorKey ? ` [${a.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  const messages: any[] = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + activeBlock + handledBlock +
      `\n${connectedLine}\nSweep across all of them for everything genuinely awaiting me that is NOT already ` +
      `covered above — including what I promised others and haven't done yet (check my sent mail), and loose ` +
      `ends on my projects/people above — then call submit_tasks with the NEW actionable items. Respect my ` +
      `stated preferences above when choosing, ranking, and phrasing tasks.`,
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  // Each round re-sends the whole growing transcript (tools + history) — rounds are the real cost driver.
  // The prompt tells the agent to BATCH searches as parallel calls in one round, so 6 is plenty; the forced
  // final round below is the safety net for a straggler.
  const MAX = 6;
  let tokIn = 0, tokOut = 0, rounds = 0;
  let didRead = false;        // has the model actually called ANY read tool yet?
  let lazyRejected = false;   // reject an unread empty submit only ONCE, then take whatever comes
  try {
  for (let i = 0; i < MAX; i++) {
    const client = deepseekClient();
    const lastRoundHint = i === MAX - 1 ? "You must call submit_tasks now with the full actionable list. Do not answer with prose." : "";
    const base = trimOldToolResults(messages);
    const apiMessages = lastRoundHint ? [...base, { role: "user" as const, content: lastRoundHint }] : base;
    const res = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: 4000,
      messages: [
        { role: "system", content: GEN_SYSTEM },
        ...apiMessages,
      ],
      tools: tools.map((t: any) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }));
    rounds++; tokIn += (res as any).usage?.prompt_tokens || 0; tokOut += (res as any).usage?.completion_tokens || 0;
    const toolUses = res.choices[0]?.message?.tool_calls || [];
    if (!toolUses.length) {
      const assistantText = res.choices[0]?.message?.content || "";
      if (i < MAX - 1) {
        if (assistantText) messages.push({ role: "assistant", content: assistantText });
        messages.push({ role: "user", content: "You have not used any tools yet. Inspect the connected apps first. Call at least one connected tool now and do not answer with prose." });
        continue;
      }
      return empty;
    }
    messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
    let submitted: GenerationResult | null = null;
    for (const tu of toolUses) {
      const input = parseToolArgs((tu as any).function?.arguments);
      const toolName = (tu as any).function?.name;
      let content = "ok";
      try {
        if (toolName === "submit_tasks") {
          const parsed: GenerationResult = { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
          // Lazy-submit guard: an EMPTY submit before reading anything isn't an answer, it's giving up.
          // Reject exactly once so the model goes and sweeps; a legit "nothing new" after real reads passes.
          if (!parsed.tasks.length && !didRead && !lazyRejected) {
            lazyRejected = true;
            content = "Rejected: you submitted before sweeping. Read the connected apps first (batch your searches), then resubmit — an empty list is only acceptable AFTER you have actually looked.";
          } else { submitted = parsed; content = "submitted"; }
        }
        else if (toolName === "web_search") { didRead = true; content = await runWebSearch(input); }
        else { didRead = true; const r = await extras.call(toolName, input || {}); content = r ?? `Unknown tool: ${toolName}`; }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      // Capped well below the old 4000 — a fresh result only needs enough to extract the fact/id you asked
      // for; anything you need beyond that, search again. This cap applies to every tool call, every round.
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 2000) });
    }
    if (submitted) { if (!submitted.tasks.length) console.warn("[claude] generateTasks submitted 0 tasks"); return submitted; }
  }
  // Round budget exhausted without a submit — a sweep that read everything but never reported is why
  // "Refresh finds nothing". Force ONE final call where the model MUST call submit_tasks with what it has.
  try {
    const client = deepseekClient();
    const res = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: 4000,
      messages: [
        { role: "system", content: GEN_SYSTEM },
        ...trimOldToolResults(messages),
        { role: "user", content: "STOP researching. Call submit_tasks NOW with every actionable task you found so far." },
      ],
      tools: [{ type: "function" as const, function: { name: SUBMIT_TASKS_TOOL.name, description: SUBMIT_TASKS_TOOL.description, parameters: SUBMIT_TASKS_TOOL.input_schema } }],
      tool_choice: { type: "function", function: { name: "submit_tasks" } },
    }));
    rounds++; tokIn += (res as any).usage?.prompt_tokens || 0; tokOut += (res as any).usage?.completion_tokens || 0;
    const tu = res.choices[0]?.message?.tool_calls?.[0];
    if (tu) {
      const input = parseToolArgs((tu as any).function?.arguments);
      return { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
    }
  } catch (e: any) { console.warn("[claude] forced submit failed:", e?.message || e); }
  return empty;
  } finally {
    console.log(`${new Date().toISOString()} [ai] generateTasks: ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}

/**
 * Stage-2 of the discovery pipeline: classify PRE-FILTERED, NORMALIZED source items in ONE model call
 * (no tools, no agent loop). The model only says WHICH items are actionable and how — every anchor, link,
 * and source on the resulting task is copied from the item itself, so references cannot be hallucinated.
 */
export async function classifyCandidates(
  items: { sourceApp: string; anchorKey: string; url?: string; title: string; snippet: string; sender?: string; timestamp?: string; labels: string[] }[],
  profile?: Profile,
  activeTitles?: string[],
): Promise<GenerationResult> {
  if (!items.length) return { tasks: [], profileUpdates: [] };
  const list = items.slice(0, 30).map((it, i) =>
    `#${i} [${it.sourceApp}${it.labels.includes("sent") ? "/SENT-BY-USER" : ""}${it.labels.includes("shared") ? "/SHARED-WITH-USER" : ""}${it.labels.includes("assigned") ? "/ASSIGNED-TO-USER" : ""}${it.labels.includes("review-requested") ? "/REVIEW-REQUESTED" : ""}] from:"${it.sender || "?"}" when:"${it.timestamp || "?"}" title:"${it.title}" body:"${it.snippet}"`).join("\n");
  const activeBlock = activeTitles?.length ? `\nALREADY ON THEIR LIST (skip anything covering these):\n${activeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n` : "";
  const sys =
    `You classify a person's inbox/calendar/drive items into their to-do list. For each candidate decide if it ` +
    `GENUINELY needs them to act. Inbox items: does someone await their reply / ask something of them? SENT-BY-USER ` +
    `items are commitments THEY made ("I'll send you X") — create a task to FULFILL unfulfilled ones. Events: only ` +
    `if prep or a response is genuinely needed (within ~48h, or with real stakes). SHARED-WITH-USER files: only if ` +
    `someone is clearly waiting on their review/input. GitHub ASSIGNED-TO-USER issues and REVIEW-REQUESTED PRs ` +
    `are actionable while open. Skip FYIs, receipts, automated mail, and anything already on ` +
    `their list. USE THEIR PROFILE: items from their HIGH-PRIORITY people or touching their stated projects rank ` +
    `HIGHER (importance ≥ 0.7); things their preferences deprioritize rank lower or get skipped. Quality over ` +
    `quantity — the handful that matter. ALWAYS include: a direct question or request from a real person awaiting ` +
    `their reply; a SENT-BY-USER commitment ("I'll send/do/call…") with no later fulfilment visible; an event in ` +
    `the next 48h that plainly needs prep. When such an item exists, an empty tasks list is WRONG.\n` +
    `CONSOLIDATE — one real-world obligation = ONE task. If several candidates concern the SAME thing (a ` +
    `calendar event AND the email thread that set it up; several copies of one outreach the user sent), emit a ` +
    `SINGLE task and pick the candidate the user must ACT on to anchor it (prefer the email/thread they need to ` +
    `handle; else the event). NEVER emit two tasks for one meeting, thread, or commitment. Each task's title must ` +
    `name a DISTINCT obligation — if two of your tasks would start with the same verb+object, merge them.\n` +
    `Answer with STRICT JSON only: {"tasks":[{"i":<candidate #>,"title":"short imperative ≤9 words",` +
    `"why":"one clause naming the concrete trigger","when":"the REAL deadline stated in or directly implied by the item — NEVER an invented one; '' if none","urgency":0..1,"importance":0..1,` +
    `"risk":"low"|"high"}],"profileUpdates":[{"category":"preference"|"person"|"project"|"name"|"about",` +
    `"fact":"one short sentence"}]} — profileUpdates: 0-3 DURABLE facts about who this person is that these ` +
    `items reveal (a key relationship, an ongoing project) — only lasting identity facts, not task content. ` +
    `Empty arrays are fine.`;
  const client = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  let tokIn = 0, tokOut = 0, calls = 0;
  const ask = async (extra?: string) => {
    calls++;
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: 1800,
      // Determinism guards: JSON mode + near-zero temperature. Without them the same candidate list
      // sometimes classified to ZERO tasks (the "swept — no new tasks over a full inbox" bug).
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: nowBlock() + profileBlock(profile) + activeBlock + `\nCANDIDATES:\n${list}` + (extra ? `\n\n${extra}` : "") },
      ],
    }));
    tokIn += res.usage?.prompt_tokens || 0; tokOut += res.usage?.completion_tokens || 0;
    return firstJson<any>(String(res.choices?.[0]?.message?.content || ""));
  };
  const parse = (out: any) => {
    const arr: any[] = Array.isArray(out) ? out : Array.isArray(out?.tasks) ? out.tasks : [];
    return arr
      .map((r) => ({ ...r, i: Number(r?.i) })) // tolerate "i":"3" strings
      .filter((r) => Number.isInteger(r.i) && r.i >= 0 && r.i < items.length && String(r?.title || "").trim().length >= 4 && String(r?.why || "").trim())
      .map((r): GeneratedTask => {
        const it = items[r.i];
        return {
          title: String(r.title).slice(0, 90),
          why: String(r.why).slice(0, 400),
          when: r.when ? String(r.when).slice(0, 40) : undefined,
          source: it.sourceApp === "calendar" ? "calendar" : it.sourceApp === "drive" ? "drive" : it.sourceApp === "github" ? "github" : "gmail",
          risk: r.risk === "high" ? "high" : "low",
          urgency: clamp01(r.urgency ?? 0.5),
          importance: clamp01(r.importance ?? 0.6),
          anchorKey: it.anchorKey,           // from the SOURCE — never the model
          link: it.url,
        };
      })
      .slice(0, 12);
  };
  try {
    let out = await ask();
    let tasks = parse(out);
    // Empty-result guard: this call is measurably non-deterministic even at low temperature — replaying
    // the IDENTICAL prompt against the SAME candidates returned empty in 2 of 3 tries in live testing. A
    // single retry with a generic "reconsider everything" nudge inherits the same failure mode (it did,
    // live). So: compute a DETERMINISTIC shortlist of "strong" candidates (the user's own unfulfilled
    // commitments, GitHub items explicitly assigned/requested of them) — items that are near-certainly
    // actionable — and if the model still comes back empty, retry TWICE, each time pointing directly at
    // those specific indices. A small, concrete judgment ("does #14 still need action?") is far more
    // reliable than a global "did I miss anything in 30 items?" — and costs nothing extra when the first
    // call already succeeded.
    const strongIdx = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.labels.includes("sent") || it.labels.includes("assigned") || it.labels.includes("review-requested"))
      .map(({ i }) => i);
    for (let attempt = 0; !tasks.length && items.length >= 6 && attempt < 2; attempt++) {
      const nudge = strongIdx.length
        ? `You returned no tasks. Look SPECIFICALLY at candidates #${strongIdx.join(", #")} — each is either a ` +
          `commitment YOU (the user) made that has no later fulfilment visible, or a GitHub item explicitly ` +
          `assigned to/requesting review from them. For EACH one individually, decide: does it still need ` +
          `action? Return a task for every one that does. Only return an empty list if NONE of them do.`
        : `You returned no tasks from ${items.length} candidates. Re-examine them: direct questions from real ` +
          `people and the user's own SENT commitments are almost always actionable. Return an empty tasks list ` +
          `ONLY if truly nothing needs them.`;
      const retry = await ask(nudge);
      const retried = parse(retry);
      if (retried.length) { out = retry; tasks = retried; break; }
    }
    return { tasks, profileUpdates: parseProfileUpdates(out?.profileUpdates) };
  } finally {
    console.log(`${new Date().toISOString()} [ai] classifyCandidates: ${items.length} in → ${calls} call${calls === 1 ? "" : "s"}, ${tokIn} in / ${tokOut} out tokens`);
  }
}

export interface RefinedTask { title: string; why: string; when?: string; urgency: number; importance: number; }

/**
 * Turn a user's rough to-do note into a crisp, actionable task (keeps their intent — never invents
 * specifics). One quick Claude call; returns null on any failure so the caller can fall back to the raw text.
 */
export async function refineManualTask(text: string, profile?: Profile): Promise<RefinedTask | null> {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          "You turn a person's rough to-do note into ONE crisp, actionable task title. Make it a specific " +
          "imperative that names the concrete object/person from THEIR note — 'email sarah' → 'Reply to Sarah " +
          "about the proposal', 'trip' → 'Prepare Boston trip itinerary', 'call dentist' → 'Call the dentist " +
          "to book a cleaning'. NEVER invent names, dates, companies, or facts they didn't state — only sharpen " +
          "what's there (if the note is just 'trip' with no destination, use 'Plan the trip', not a made-up city). " +
          "Infer priority from the wording (urgent words, deadlines) and the person's profile only. Output STRICT JSON only." },
        { role: "user", content: profileBlock(profile) +
          `\nRough note: "${raw.slice(0, 300)}"\n\nReturn JSON: {"title": short imperative <= 9 words that names the specific object/person, ` +
          `"why": one concise clause capturing the intent, ` +
          `"when": a deadline for COMPLETING THIS TASK (e.g. "today", "by Fri") — ONLY if the note explicitly says when the TASK itself must be done (e.g. "by tomorrow", "before June 30"). If the note only mentions dates as background context (e.g. a trip date, event date, year mentioned in passing) leave this "", ` +
          `"urgency": 0..1 time pressure, "importance": 0..1 stakes}. JSON only.` }
      ],
    }));
    const textContent = res.choices[0]?.message?.content || "";
    const out = firstJson<any>(textContent);
    if (!out || typeof out.title !== "string" || !out.title.trim()) return null;
    return {
      title: String(out.title).slice(0, 90),
      why: String(out.why || "").slice(0, 300) || "Added by you.",
      when: out.when ? String(out.when).slice(0, 40) : undefined,
      urgency: clamp01(out.urgency ?? 0.6),
      importance: clamp01(out.importance ?? 0.7),
    };
  } catch { return null; }
}

export interface ProfileUpdate { category: "name" | "about" | "preference" | "person" | "project"; fact: string; }
export interface RunOutput {
  context: string;
  synthesis: string;
  did: string[];              // concrete past-tense bullets — one per action actually performed
  steps: TaskStep[];
  links: TaskLink[];          // the artifacts it made this run (draft / doc / sheet / event / issue), so the user can open them
  sendables: Sendable[];      // drafted email / composed Slack message the user can fire with one click
  profileUpdates: ProfileUpdate[];
  tokens?: { in: number; out: number }; // cost telemetry — recorded on the task's timeline per run
}

const RUN_SYSTEM =
  `You execute ONE task for the user, end to end, using the tools available — their CONNECTED apps via ` +
  `Composio (Gmail, Google Calendar, Docs, Slides, Drive, Sheets, and any others: Slack, GitHub, Notion, ` +
  `Linear, Todoist, …). USE them to gather the real facts AND to DO the reversible work: draft a reply, ` +
  `create a doc/deck/sheet, add a task or calendar event, update an issue. Use WHATEVER connected apps the task ` +
  `touches (Slack, Notion, Linear, Sheets, GitHub, …), not just email, and do as MUCH as your tools allow. Do ` +
  `NOT ask the user for anything you could find or do yourself. Be rigorously honest and grounded; never invent specifics.\n` +
  `WORK IN THREE PHASES: (1) PLAN silently — from the task and the context you gather, decide which tools ` +
  `you'll use and what artifacts (draft/doc/event/cells) you'll produce; never show this plan to the user. ` +
  `(2) DO — execute the reversible work through the tools. (3) REPORT via submit — "synthesis" = one-line ` +
  `summary of what you DID (past tense), "did" = one bullet per concrete action you performed (with names), ` +
  `"links" = EVERY artifact you produced, "steps" = EVERYTHING that still needs ` +
  `the user, as a complete checklist. Leave steps empty ONLY when a sendable covers the remaining action or ` +
  `truly nothing is left.\n` +
  `You can also use web_search for any external fact or context you need (a person, company, deadline, how-to, ` +
  `or a reference link) — look it up rather than guess.\n` +
  `PICK THE RIGHT ARTIFACT TYPE: a task that says "spreadsheet", "sheet", "tracker", or asks for rows/columns ` +
  `of structured data belongs in GOOGLE SHEETS, not a Doc — even though a Doc can hold a table, a sheet is ` +
  `what the user asked for and is what they can filter/sort/total. Only use a Doc for prose/lists/plans.\n` +
  `GOOGLE SHEETS — YOU MUST ACTUALLY WRITE: if the task involves updating a spreadsheet (e.g. filling in ` +
  `restaurant names, meal ideas, trip data, any cells), you MUST call the Sheets write tools ` +
  `(GOOGLESHEETS_BATCH_UPDATE_VALUES, GOOGLESHEETS_UPDATE_VALUES, GOOGLESHEETS_APPEND_VALUES, etc.) to ACTUALLY ` +
  `write the data into the cells — do NOT just produce a plan or list in synthesis. Read the sheet first to ` +
  `find the exact cells/ranges that need filling, then call the write tool with real content. Sheet cell writes ` +
  `are FULLY PERMITTED and reversible — you do NOT need user approval to write cells. Do it now.\n` +
  `GATHER WHAT THE TASK NEEDS — TARGETED, NOT EXHAUSTIVE: typically 1-3 reads (the Gmail thread behind the ` +
  `task, the relevant Calendar event or Drive doc, a web_search for external facts). NEVER leave placeholders ` +
  `like "[hotel name]" — find the real detail with ONE targeted search. But your round budget is TIGHT and ` +
  `reading is not the work: DO NOT survey the user's whole world before acting.\n` +
  `CREATE EARLY — if the task produces an artifact (a doc, sheet, deck, draft reply, event, research summary), ` +
  `CREATE it within your FIRST THREE tool calls, then refine/fill it with what you learn. For research tasks: ` +
  `web_search for the facts, then CREATE A GOOGLE DOC with the findings — a research task without a produced ` +
  `artifact is NOT done. An imperfect created artifact beats a perfect plan every time.\n` +
  `AUTO-EXECUTION — If the user has auto-approved certain actions (e.g., "schedule_meetings_under_30min"), you can ` +
  `execute those WITHOUT adding them to sendables for approval. Check their profile for autoApprove patterns. ` +
  `For example, if they've approved scheduling meetings under 30min, you can create the calendar event directly ` +
  `without asking. Otherwise, follow the normal approval flow.\n` +
  `HARD LIMIT — you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: ` +
  `no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not ` +
  `even available to you). For email you ONLY ever leave a DRAFT; for Slack you only COMPOSE the message. You ` +
  `never send/post — instead OFFER the send as a one-click button via "sendables" (see submit), which the user ` +
  `reviews and fires. Never say you "sent", "emailed", "posted", or "messaged" — say you DRAFTED/PREPARED it. ` +
  `Never claim an action you didn't take.\n` +
  `NEWSLETTERS & PROMOTIONAL EMAIL — NEVER DRAFT A REPLY: before drafting any email reply, check whether the ` +
  `thread is a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender (unsubscribe ` +
  `footer, sender contains "noreply"/"no-reply"/"newsletter"/"marketing"/"updates@"/"news@", a Gmail promotions/ ` +
  `social label). If so, do NOT draft a reply or add a sendable for it, even if it appears to ask something — ` +
  `note in "synthesis" that it's mass mail and needs no reply, and stop there.\n` +
  `THE ONE SEND EXCEPTION — send_self_brief goes ONLY to the user's own inbox (the server addresses it; you ` +
  `cannot pick a recipient). When the task involves something UPCOMING they must walk into prepared — a meeting ` +
  `or event in the next ~48h, travel/day-of logistics — ALSO send them a tight brief (who/when/where or link, ` +
  `agenda, 2-4 prep points, doc links) so it's waiting in their inbox. Mention it in "synthesis" ("…and emailed ` +
  `you a brief"). At most one per task; never for anything that isn't time-sensitive prep.\n` +
  `CALENDAR INVITES: create/update the event freely — but it lands on the user's calendar SILENTLY, with NO ` +
  `emails to anyone (you cannot notify attendees yourself). If the event SHOULD invite people, do NOT email them; ` +
  `instead add a "sendables" entry {app:"gcal", label, eventId, attendees:[their emails], summary, when} so the ` +
  `user gets a one-click "Send invites" button that SHOWS exactly who will be invited before they confirm. You ` +
  `never send the invite; the user's click does, with the recipient list in plain view.\n` +
  `VOICE — SOUND LIKE THE USER, NOT AN AI. For a REPLY, the THREAD is the source of truth: FIRST reread the ` +
  `ENTIRE thread you're replying to and mirror ITS conventions — the register the user (and the other side) ` +
  `already use there, the greeting/sign-off used IN THAT THREAD (often none mid-thread), its typical message ` +
  `length, its formality. Your draft must read as the natural NEXT message of that exact thread. Only when the ` +
  `thread has no messages from the user (or it's a fresh email) fall back to their broader style: READ 2-3 of ` +
  `their OWN sent emails (search "in:sent", ideally to the same recipient) and copy their ACTUAL writing mechanics:\n` +
  `- CAPITALIZATION: if they write in lowercase ("hey, sounds good"), you write in lowercase. If they use proper caps, so do you.\n` +
  `- SENTENCE LENGTH & TOTAL LENGTH: if their emails are 2 short lines, yours are 2 short lines — never longer than they'd write.\n` +
  `- THEIR WORDS: reuse their habitual greeting ("hey"/"hi"/none), sign-off ("thanks!"/"best"/just their name), ` +
  `filler words, contractions, and punctuation habits (do they use exclamation marks? ellipses? no periods at line ends?).\n` +
  `- FORMALITY: match the register they use with THIS recipient specifically, if you can see prior thread messages.\n` +
  `AVOID AI tells — no "I hope this email finds you well", "I wanted to reach out", "Please don't hesitate", ` +
  `"Thank you for your understanding", em-dash-heavy corporate phrasing, or stiff over-formality. Nudge a touch ` +
  `more polished only for someone senior or unknown. If you pick up a durable detail of their style (e.g. ` +
  `"writes lowercase, signs off 'cheers'"), "remember" it as a preference so future drafts skip the lookup.\n` +
  `BE SPECIFIC — INCLUDE THE CONCRETE DETAILS: a draft must contain the real specifics the recipient needs, ` +
  `never vague placeholders. If it's about travel, include the actual FLIGHT TIMES / dates / flight numbers / ` +
  `arrival + departure; if about a meeting, the exact date, time + timezone; if about a place, the address. ` +
  `Pull these from their calendar, the itinerary (Drive/Sheets), the thread, or web_search — look them up, ` +
  `don't leave "[time]" or omit them. A draft missing the key time/date/number is not finished.\n` +
  `ACT — DON'T JUST PLAN (most important rule): if something can be done with your tools, DO IT THIS RUN — ` +
  `call the tool, draft the reply, create the doc, add the event. NEVER return a step that DESCRIBES an action ` +
  `you could take yourself; take it now and report it in "synthesis". The ONLY things that belong in "steps" ` +
  `are ones that genuinely need the USER — judged by the "OTTO vs YOU" test below. If a ` +
  `tool errors, try another way or say what blocked you — do not silently downgrade a doable action to a step. ` +
  `A run that hands back a to-do list of things you could have done yourself is a FAILURE.\n` +
  `TWO EXCEPTIONS to "do it yourself": (a) OPENING A PAGE — you have no browser, so for any task to open / read / ` +
  `skim / review / look at a specific doc, file, or page, FIND its real URL (search Drive, Docs, or the web) and ` +
  `return it as a STEP with "url" set and automatable=true — the app opens it in the user's browser for them. ` +
  `Never write "open the doc" without the URL, and never claim you opened or read it yourself. (b) NO DUPLICATES — ` +
  `never create a second copy of something that already exists; if changing an existing event/doc/task would need ` +
  `an update tool you don't have (you only have "create"), do NOT create a near-duplicate — leave it as a step. A ` +
  `duplicate is worse than no change.\n` +
  `GOOGLE DOCS — USE SPARINGLY: only create a Google Doc when the task's real deliverable IS a document the user ` +
  `wants (a brief, proposal, notes, agenda, plan). To reply to an email or message, leave an email DRAFT / a ` +
  `composed message — NEVER write the reply into a Doc. Do NOT create a Doc to "summarize", log, jot, or as a ` +
  `byproduct, and never default to one when unsure (prefer doing nothing doc-wise). NEVER create a DUPLICATE ` +
  `Doc/Sheet/Slides — this is critical. BEFORE creating one, ALWAYS first (a) reuse any artifact listed under ` +
  `"ALREADY CREATED FOR THIS TASK" above — open it by its URL and UPDATE it; and (b) search Drive by title ` +
  `(GOOGLEDRIVE_FIND_FILE / search) for an existing doc with the same or similar name and UPDATE that instead. ` +
  `Only create a new doc if NONE exists. Re-running this task must NEVER produce a second copy (the user has ` +
  `seen "5 road-trip packing lists" — do not repeat that). If you genuinely can't update, leave a step rather ` +
  `than make a near-duplicate. An unwanted or duplicate Doc is worse than none.\n` +
  `When done, call "submit" with "context" + "synthesis" (what you did) and a "steps" list of what is LEFT.\n` +
  `PERMISSION_REQUIRED: If you call a tool (like updating a doc or creating a calendar event) and it returns ` +
  `"PERMISSION_REQUIRED", you CANNOT do it yourself this run. Instead, add it to your "steps" list with ` +
  `automatable=true AND needsPermission=true so the user can explicitly approve it with one click.\n` +
  `WRITE GOOD STEPS — each step is ONE concrete action: imperative verb + the specific thing, concise (≤ ~12 ` +
  `words), no hedging or explanation. Good: "Send the draft reply to Sarah", "Pick the offsite date", "Approve ` +
  `& publish the brief". Bad: vague ("follow up"), bundled ("check email and update the doc and tell the team"), ` +
  `or narrated. Order them; set "dependsOn" to an earlier step's index when one must happen first.\n` +
  `OTTO vs YOU — classify EVERY step by ONE test: can you do it with your tools or by finding information?\n` +
  `• YES → it's OTTO's (automatable=true): reading/searching anything, drafting, creating/updating a doc/sheet/ ` +
  `event/task, ENTERING or filling in data, commenting, research, opening a page. Do it NOW if unblocked; only ` +
  `LIST it (with "dependsOn") when it waits on a user step. Lack a value? FIND it (inbox/Drive/the source), then do it.\n` +
  `• NO → it's the USER's (automatable=false), and ONLY for one of: (1) a judgment/decision/approval only they ` +
  `can make; (2) a credential/login/access you don't have; (3) a payment or moving money; (4) a real-world / ` +
  `physical action. Reviewing-then-SENDING a message is NOT a step — offer it as a one-click send (sendables).\n` +
  `When UNSURE, it's OTTO's — attempt it. "Tedious", "specific", "numeric", or "I'd have to look it up" are NEVER ` +
  `reasons to hand a step to the user. When a user step unblocks one of yours, say so — "Pick the date — I'll ` +
  `then book it".\n` +
  `PREP EVERY USER STEP TO THE MAX (universal rule): a user step must arrive READY-TO-DO, never bare. Attach a ` +
  `"url" that lands them ONE click from done whenever such a link exists or can be constructed — driving/transit → ` +
  `a Google Maps directions link (https://www.google.com/maps/dir/?api=1&origin=<from>&destination=<to>), a call → ` +
  `tel:<number>, a payment/booking/return/check-in → the exact page for it, a form → the form itself. Fold the key ` +
  `facts they'd otherwise look up (address, confirmation #, time, phone, amount) into the step text or "context". ` +
  `If no link applies, the step text itself must carry everything needed.\n` +
  `ASK ONLY WHEN TRULY STUCK: if a step is automatable EXCEPT for one detail you could not find or infer ` +
  `(a choice between real options, a preference, a date only the user knows), keep automatable=true and set ` +
  `"question" — ONE short, specific question — plus "options": 2-4 LIKELY answers with your best inference ` +
  `FIRST (they tap one and you run). Search EVERYTHING first (inbox, Drive, calendar, their profile, the web); ` +
  `a question you could have answered yourself is a failure. Prep everything around it so their answer is the ` +
  `only missing piece. Never ask more than 2 questions per task.\n` +
  `BRIEF, DON'T JUST DEFER: even when the final action is the USER's (a decision, or a booking/login/payment you ` +
  `can't do), do ALL the research around it FIRST — find the real options + facts, put each as a "links" entry ` +
  `they can open, and give a short recommendation in "synthesis". Their part should be just the final pick or ` +
  `click — NEVER "go figure it out". E.g. "book a Boston restaurant" → research a few fitting spots, link each ` +
  `(Resy/the restaurant site), recommend one with a one-line why; the step is just "Pick one & book".\n` +
  `ALWAYS SURFACE WHAT YOU MADE: whenever you create or draft something (a Gmail draft, a Google Doc/Sheet/Slides ` +
  `deck, a calendar event, a task, an issue/PR or comment), put a LINK to it in submit's "links" so the user can ` +
  `open and review it. Build the URL from the id the tool returned — Doc: https://docs.google.com/document/d/<id>/edit, ` +
  `Sheet: https://docs.google.com/spreadsheets/d/<id>/edit, Slides: https://docs.google.com/presentation/d/<id>/edit, ` +
  `Gmail draft: https://mail.google.com/mail/u/0/#drafts, calendar event: the htmlLink it returned. If a result ` +
  `already includes a URL / webViewLink, use that. Never invent a link — only include one you actually got back.\n` +
  `ONE-CLICK SEND (the ONLY way anything goes out — always with the recipient shown): for every email you ` +
  `DRAFTED, add a "sendables" entry {app:"gmail", label, to (the recipient, ALWAYS set it), subject, body, ` +
  `draftId} — include the EXACT subject + body you wrote (so the user can review the draft IN THE APP) plus the ` +
  `draft_id the create-draft tool returned. For every Slack message you COMPOSED, add {app:"slack", label, ` +
  `channel, text} — do NOT post it. For a calendar event that should invite people, add {app:"gcal", label, ` +
  `eventId, attendees:[the invitees' emails], summary, when} — do NOT notify them. Each gives the user a Send ` +
  `button that names the recipient(s) first; you still never send. Don't ALSO add a "send it" step — the button ` +
  `is the send.\n` +
  `Use "remember" for a durable fact about WHO THIS PERSON IS (a preference, a key person, an ongoing project, ` +
  `or a one-line "about") — save NEW facts AND corrected versions of profile lines that turned out outdated or ` +
  `wrong (a corrected fact REPLACES the old one). Be selective.\n` +
  `QUALITY BAR — self-check BEFORE calling submit, fix anything that fails: (1) every draft/doc contains the ` +
  `REAL specifics (dates, times, numbers, names, addresses) — zero placeholders; (2) drafts match the user's ` +
  `actual voice per the VOICE rules — reread one sent email if unsure; (3) each sendable's subject/body is ` +
  `EXACTLY what you wrote into the created draft (same draftId); (4) every link came from a tool result — ` +
  `never constructed from guesswork. A polished half is worth more than a sloppy whole.\n` +
  `Call "submit" ONLY after you've actually done the reversible work — ` +
  `not before. Be BRIEF: "synthesis" is ONE sentence; "context" is 1-2 short bullets. Don't narrate problems or ` +
  `steps you skipped — just the result.`;

const RUN_TOOLS = [
  { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'name' (what to call them — save it the moment you learn their name, e.g. from their email signature or how others address them; fact = just the name), 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), or 'about' (a one-line summary of them).", input_schema: { type: "object", properties: { category: { type: "string", enum: ["name", "about", "preference", "person", "project"] }, fact: { type: "string" } }, required: ["category", "fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    context: { type: "string", description: "what this is about — 1-2 SHORT bullets, each a line beginning with '- '. Brief; the user only sees this if they expand it." },
    synthesis: { type: "string", description: "what you accomplished — ONE short plain sentence (≤ ~25 words), past tense, e.g. 'Drafted a reply to Sarah and opened the budget doc.' NO caveats, NO explaining what you couldn't do or why — anything the user must handle goes in 'steps', not here." },
    did: { type: "array", items: { type: "string" }, description: "2-6 bullets, ONE per concrete action you ACTUALLY performed with tools this run, past tense with the specific names/artifacts, e.g. 'Drafted a reply to Sarah confirming Thursday', 'Created \"Q3 budget\" doc with the summary table', 'Filled 12 cells in the trip sheet'. NEVER plans, reads-only, or things you didn't do." },
    steps: {
      type: "array",
      description: "What's LEFT to finish, ordered, each ONE concrete action. Include (1) human-only steps (automatable=false) and (2) steps you can do but that are BLOCKED on a human step (automatable=true + dependsOn). NEVER list work you already did, or a doable + unblocked action (do that now). Often empty.",
      items: { type: "object", properties: {
        text: { type: "string", description: "ONE concrete action — imperative verb + the specific thing, ≤ ~12 words, no hedging. e.g. 'Send the draft to Sarah', 'Pick the offsite date', 'Approve & publish the brief'." },
        automatable: { type: "boolean", description: "true = OTTO can do it with its tools or by finding info (read/search, draft, create/update a doc/sheet/event/task, ENTER/FILL data, comment, research, open a page) — do it NOW unless it waits on a user step (then set dependsOn). false = needs the USER, ONLY for: a judgment/decision/approval, a credential you lack, a payment, or a physical act. NOT for being specific/numeric/tedious; sending a message is a one-click send, not a step." },
        needsPermission: { type: "boolean", description: "true = ONLY if the tool returned PERMISSION_REQUIRED. The action is automatable but needs user approval first. Requires automatable=true." },
        dependsOn: { type: "number", description: "index of an earlier step that must finish first — use it for an automatable step that waits on a user step; omit if none" },
        url: { type: "string", description: "a link that puts the user ONE click from doing this step — directions (Google Maps dir link), a tel: number, the exact booking/payment/return page, a form. Include one whenever it exists or can be constructed; not just for 'open a page' steps." },
        question: { type: "string", description: "ONLY if this automatable step is missing ONE detail you could not find or infer anywhere (a choice, a preference, a date only the user knows): one short, direct question. Search everything first — a question you could have answered yourself is a failure." },
        options: { type: "array", items: { type: "string" }, description: "2-4 likely answers to 'question', your best inference FIRST (the user taps one and you run). Short — a few words each. Omit for free-form answers." },
      }, required: ["text", "automatable"] },
    },
    links: {
      type: "array",
      description: "links to anything you CREATED or DRAFTED this run (Gmail draft, Google Doc/Sheet/Slides, calendar event, issue/PR, task), so the user can open it. Build each URL from the id the tool returned; omit if you made nothing.",
      items: { type: "object", properties: {
        label: { type: "string", description: "what it IS in the user's terms, e.g. 'Draft reply to Sarah', 'Q3 budget doc' — never a bare hostname, URL, or 'Open'" },
        url: { type: "string", description: "an https URL that opens it" },
      }, required: ["label", "url"] },
    },
    sendables: {
      type: "array",
      description: "ONE-CLICK sends to offer the user for anything you DRAFTED/COMPOSED (you never send; the user clicks, and the recipient is always shown first). Gmail draft → {app:'gmail', label, to:<recipient, ALWAYS set>, subject, body (the EXACT subject + body you drafted, so the user can review it in-app), draftId:<the draft_id the create-draft tool returned>}. Slack message you composed (do NOT post it) → {app:'slack', label, channel:<id or #name>, text:<message>}. Calendar event that should invite people (you created it silently, no notifications) → {app:'gcal', label, eventId:<the event id the create tool returned>, attendees:[invitee emails], summary:<event title>, when:<date/time>}. Omit if you composed nothing to send.",
      items: { type: "object", properties: {
        app: { type: "string", enum: ["gmail", "slack", "gcal"] },
        label: { type: "string", description: "short, e.g. 'Send reply to Sarah', 'Send invites'" },
        to: { type: "string", description: "recipient email or channel — shown to the user before they send" },
        subject: { type: "string", description: "gmail: the drafted subject (for in-app review)" },
        body: { type: "string", description: "gmail: the drafted body as plain text (for in-app review)" },
        draftId: { type: "string", description: "gmail: the draft_id to send" },
        channel: { type: "string", description: "slack: channel id or #name" },
        text: { type: "string", description: "slack: the message text to post" },
        attendees: { type: "array", items: { type: "string" }, description: "gcal: the invitee emails the invite will notify (shown before sending)" },
        eventId: { type: "string", description: "gcal: the id of the event you created (to patch with send_updates so attendees get invited)" },
        summary: { type: "string", description: "gcal: the event title (for in-app review)" },
        when: { type: "string", description: "gcal: the event date/time (for in-app review)" },
      }, required: ["app", "label"] },
    },
  }, required: ["context", "synthesis", "steps"] } },
];

/**
 * Run a task as a bounded tool-using agent over the user's CONNECTED apps (Composio): it gathers facts and
 * does the reversible work (drafts, docs, tasks, updates) itself, then submits a context + synthesis + the
 * steps that are LEFT. Irreversible sends/deletes are never available to it. Also returns durable profile facts.
 */
export async function runTask(task: { title: string; why: string; source?: string; links?: TaskLink[]; artifacts?: { kind: string; id: string; url?: string; label?: string }[] }, profile?: Profile, focus?: string, extras?: AgentTools): Promise<RunOutput> {
  const profileUpdates: ProfileUpdate[] = [];
  const tools = [...RUN_TOOLS, WEB_SEARCH_TOOL, ...(extras?.selfBrief ? [SELF_BRIEF_TOOL] : []), ...(extras?.tools?.length ? extras.tools : [])];
  const connectedLine = extras?.connected?.length
    ? `\nConnected apps you can use (read + reversible writes; never send/post/delete): ${extras.connected.join(", ")}.\n`
    : `\nNo apps are connected yet — if you can't proceed without one, say so in the synthesis and put "Connect the app in Settings" as a step.\n`;
  const manualHint = task.source === "manual"
    ? `\nThe USER added this to-do themselves. Treat the title as their intent: use your tools (search their Gmail/Drive, etc.) and what you know about them to find the real, specific context behind it BEFORE acting.`
    : "";
  // Artifacts this task already produced on a previous run — the agent MUST reuse + UPDATE these, never make
  // a fresh copy (this is what stops "5 road-trip packing lists"). A deterministic anti-duplication signal.
  const hasArtifactIds = !!task.artifacts?.length; // real ids to check writes against (vs. legacy links-only)
  const priorArtifactIds = new Set((task.artifacts || []).map((a) => a.id));
  const priorArtifacts: { label?: string; url?: string; extra?: string }[] = hasArtifactIds
    ? task.artifacts!.map((a) => ({ label: a.label || a.kind, url: a.url, extra: `${a.kind} id ${a.id}` }))
    : (task.links || []).filter((l) => l?.url);
  const artifactsBlock = priorArtifacts.length
    ? `\nALREADY CREATED FOR THIS TASK (you made these on a prior run — OPEN and UPDATE the existing one; ` +
      `updates to THESE ids are permitted without approval. Do NOT create a new copy). For a Google Doc, ` +
      `prefer the MARKDOWN update tool (whole-document markdown text) over the raw index-based batch-update ` +
      `API — it needs no structural inspection, so update it directly instead of reading the doc's internal ` +
      `structure first:\n` +
      `${priorArtifacts.map((l) => `- ${l.label}${l.extra ? ` (${l.extra})` : ""}${l.url ? `: ${l.url}` : ""}`).join("\n")}\n`
    : "";
  const head = nowBlock() + `TASK: ${task.title}\nWHY: ${task.why}\n` + profileBlock(profile) + artifactsBlock + connectedLine;
  const deadlineHint = deadlineBlock(`${task.title}\n${task.why}`);
  const messages: any[] = [{
    role: "user",
    content: focus
      // Focused single-step run (the user hit "Auto-do" on one automatable step).
      ? head + deadlineHint + `\nDo ONLY this one step now: "${focus}". Actually DO it with your tools (draft/create/update) — don't describe it, DO it — then submit: synthesis = what you did; steps = [] unless something still genuinely needs the user.`
      : head + deadlineHint + manualHint + `\nGather what you need, then ACTUALLY DO the reversible work now with your tools (draft/create/update) — don't just plan it. Only once you've done everything you can, call submit; list as steps only what truly needs the user.`,
  }];

  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  const MAX = 8; // tight round budget: transcripts grow quadratically, so rounds are the real cost driver
  let tokIn = 0, tokOut = 0, rounds = 0;
  // Has the agent performed ANY write/create yet? Drives the deterministic act-now enforcement below.
  const WRITE_NAME = /(CREATE|UPDATE|APPEND|PATCH|MODIFY|BATCH|DRAFT|INSERT|WRITE|REPLACE|QUICK_ADD|MOVE|COPY|ADD_)/i;
  let wroteAny = false;
  let finishBacks = 0; // times we've bounced a submit for leaving work undone / claiming a phantom artifact
  // Backstop for a drafted-but-unreported reply: the model sometimes drafts a real Gmail reply, says so in
  // synthesis, but forgets to populate the structured "sendables" entry — leaving no Send button for
  // something that genuinely exists. Track the last successful draft call so withTokens can patch it in.
  let lastGmailDraft: { to?: string; subject?: string; body?: string; draftId?: string } | undefined;
  const withTokens = (o: RunOutput): RunOutput => {
    let sendables = o.sendables;
    if (lastGmailDraft?.draftId && lastGmailDraft.to && !sendables.some((s) => s.app === "gmail")) {
      sendables = [...sendables, {
        app: "gmail" as const, label: "Send reply", to: lastGmailDraft.to,
        subject: lastGmailDraft.subject, body: lastGmailDraft.body, draftId: lastGmailDraft.draftId,
      }].slice(0, 6);
    }
    // "did" backstop: the model sometimes omits the structured did[] field even after genuinely writing
    // something (submit still requires synthesis, which then carries the same information) — fall back to
    // the one-line synthesis rather than showing an empty "What Otto did" section for real work.
    const did = o.did.length || !wroteAny || !o.synthesis || o.synthesis === "Done." ? o.did : [o.synthesis];
    return { ...o, did, sendables, tokens: { in: tokIn, out: tokOut } };
  };
  try {
  for (let i = 0; i < MAX; i++) {
    // Mid-loop nudge: if the agent has used many turns without calling submit, remind it to
    // actually WRITE the data (not just keep reading) and move toward finishing.
    // Write-aware enforcement: prompts alone don't stop read-forever drift (observed live: 8 rounds of
    // reads, zero artifacts, "create the doc" left as a step). Track whether ANY write/create tool has
    // actually run and escalate EVERY round from round 3 until one does.
    // Revisions start closer to done (the artifact + its id are already known) — enforce a round earlier.
    if (i >= (priorArtifacts.length ? 1 : 2) && !wroteAny && !focus) {
      // Artifact-aware: when this is a rerun/revision, the enforcement must point at UPDATING the existing
      // artifact, never suggest CREATE — naming a create tool here was observed live steering revisions
      // into making a SECOND copy instead of editing the one listed in "ALREADY CREATED FOR THIS TASK".
      const nudge = priorArtifacts.length
        ? `ENFORCEMENT (round ${i + 1}/${MAX}): you have written NOTHING yet. Your NEXT tool call MUST update ` +
          `the EXISTING artifact listed above under "ALREADY CREATED FOR THIS TASK" (its id is listed — use ` +
          `an UPDATE/PATCH/APPEND tool with that id) with the requested change. Do NOT create a new one. Do ` +
          `NOT make another read call.`
        : `ENFORCEMENT (round ${i + 1}/${MAX}): you have CREATED NOTHING yet — only reads. Your NEXT tool call MUST be a create/write tool (GOOGLEDOCS_CREATE_DOCUMENT, GMAIL_CREATE_EMAIL_DRAFT, GOOGLESHEETS_UPDATE_VALUES, …) that produces the task's artifact with the content you already have. Do NOT make another read call. If the task truly requires no artifact, call submit now.`;
      messages.push({ role: "user", content: nudge });
    }
    const client = deepseekClient();
    const lastRoundHint = i === MAX - 1 ? "You must call submit now with the final result. Do not answer with prose." : "";
    const base = trimOldToolResults(messages);
    const apiMessages = lastRoundHint ? [...base, { role: "user" as const, content: lastRoundHint }] : base;
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: 2500,
      messages: [
        { role: "system", content: RUN_SYSTEM },
        ...apiMessages,
      ],
      tools: tools.map((t: any) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }));
    rounds++; tokIn += res.usage?.prompt_tokens || 0; tokOut += res.usage?.completion_tokens || 0;
    const toolUses = res.choices[0]?.message?.tool_calls || [];
    if (!toolUses.length) {
      const textContent = res.choices[0]?.message?.content || "";
      const out = firstJson<RunOutput>(textContent);
      if (out) return withTokens(finalize(out, textContent, profileUpdates));
      if (i < MAX - 1) {
        if (textContent) messages.push({ role: "assistant", content: textContent });
        messages.push({ role: "user", content: "You still have not used any tools. Read the connected apps and do the work now. Do not answer with prose until you have actually acted." });
        continue;
      }
      return withTokens(finalize(out, textContent, profileUpdates));
    }
    messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
    let submitted: RunOutput | null = null;
    for (const tu of toolUses) {
      const input = parseToolArgs((tu as any).function?.arguments);
      let content = "ok";
      try {
        const toolName = (tu as any).function?.name;
        if (toolName === "remember") {
          const fact = String(input.fact || "").trim();
          const cat = ["name", "about", "preference", "person", "project"].includes(input.category) ? input.category : "preference";
          if (fact) profileUpdates.push({ category: cat, fact });
          content = "saved";
        }
        else if (toolName === "submit") {
          const draft = finalize(input as RunOutput, "", profileUpdates);
          // (a) A revision that never actually wrote anything is a FABRICATED success (observed live: agent
          //     spent its whole budget reading the doc, never called update, then claimed "Updated the doc").
          const fabricatedRevision = hasArtifactIds && !wroteAny;
          // (b) FINISH, DON'T HAND BACK: an unblocked automatable step Otto could do itself must not survive
          //     into steps[] — Otto acts. (synthetic backstop / permission-gated / dependent / question steps
          //     are legitimately left for the user.)
          const leftUndone = draft.steps.find((s) => s.automatable && !s.synthetic && s.dependsOn === undefined && !s.question && !s.needsPermission);
          // (c) PREPARED WITHOUT AN ARTIFACT: claims to have drafted/created/updated something but produced
          //     no link/sendable AND no write ever succeeded this run — the "it just prepares stuff" failure.
          const claimsArtifact = /\b(drafted|created|updated|filled|composed|wrote|added a|built)\b/i.test(`${draft.synthesis} ${(draft.did || []).join(" ")}`);
          const hasArtifact = draft.links.length > 0 || draft.sendables.length > 0 || wroteAny;
          if (fabricatedRevision) {
            content = "REJECTED: you're revising an artifact that already exists, but you have not made any " +
              "update/write tool call this run. Call the update tool on the id listed under 'ALREADY CREATED " +
              "FOR THIS TASK' now — THEN submit. Do not resubmit the same claim without writing first.";
          } else if (leftUndone && finishBacks < 2) {
            finishBacks++;
            content = `REJECTED: "${leftUndone.text}" is something YOU can do with your tools — do it NOW, don't ` +
              `leave it for the user. steps[] must contain ONLY what genuinely needs the user (an approval, a ` +
              `decision, an answer only they have, or a login/payment/physical action). Act, then submit.`;
          } else if (claimsArtifact && !hasArtifact && finishBacks < 2) {
            finishBacks++;
            content = "REJECTED: your report claims you drafted/created/updated something, but no artifact " +
              "(draft, doc, sheet, event) was actually produced and no write succeeded this run. Either DO it " +
              "now with the real tool, or report honestly what you found without claiming work you didn't do.";
          } else {
            // did[] must be backed by a real write: if nothing was written, drop bullets that claim creation.
            if (!wroteAny) draft.did = draft.did.filter((d) => !/\b(drafted|created|updated|filled|composed|wrote|added a|built)\b/i.test(d));
            submitted = draft; content = "submitted";
          }
        }
        else if (toolName === "web_search") { content = await runWebSearch(input); }
        else if (toolName === "send_self_brief") {
          content = extras?.selfBrief ? await extras.selfBrief(String(input?.subject || ""), String(input?.body || "")) : "ERROR: not available";
        }
        // A revision with existing artifacts blocks CREATE_* calls entirely — not just "discourages" them.
        // Observed live: after only counting ANY write as satisfying the "you must write" enforcement, the
        // agent found the update path hard and called CREATE again instead — same duplicate, different
        // gate. Block it before the tool runs, so a duplicate can't be created even by mistake.
        else if (hasArtifactIds && /CREATE/i.test(toolName) && !/CREATE.*(SUB.?ISSUE|COMMENT|LABEL|BRANCH)/i.test(toolName)) {
          content = "BLOCKED: this task already has an artifact (see 'ALREADY CREATED FOR THIS TASK') — creating a new one would duplicate it. Use the UPDATE tool on the EXISTING id instead.";
        }
        else {
          // A connected-integration tool (Gmail/Calendar/Slack/GitHub/…). Returns null if it isn't one.
          const r = extras ? await extras.call(toolName, input || {}) : null;
          content = r ?? `Unknown tool: ${toolName}`;
          // Count as satisfying "you must write" ONLY when it's a genuine update (references an existing
          // artifact id) OR there are no prior artifacts to conflict with (a create is legitimately new work).
          const isRealWrite = r !== null && WRITE_NAME.test(String(toolName)) && !/^ERROR|PERMISSION_REQUIRED/i.test(String(r));
          const argStr = JSON.stringify(input || {});
          const targetsExisting = [...priorArtifactIds].some((id) => id.length >= 8 && argStr.includes(id));
          if (isRealWrite && (!hasArtifactIds || targetsExisting)) wroteAny = true;
          if (isRealWrite && /GMAIL_(CREATE|UPDATE)_EMAIL_DRAFT/i.test(toolName)) {
            const idMatch = /"(?:draft_?id|id)"\s*:\s*"([\w-]{6,})"/i.exec(String(r));
            if (idMatch) lastGmailDraft = { to: String(input?.recipient_email || input?.to || "").trim() || undefined, subject: input?.subject ? String(input.subject) : undefined, body: input?.body ? String(input.body) : undefined, draftId: idMatch[1] };
          }
        }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      // Capped well below the old 4000 — a fresh result only needs enough to extract the fact/id you asked
      // for; anything you need beyond that, search again. This cap applies to every tool call, every round.
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 2000) });
    }
    if (submitted) return withTokens(submitted);
  }
  // Rescue path: if the model never called submit, ask it once (without tools) to produce a final JSON result.
  try {
    const client = deepseekClient();
    const transcript = messages.map((m) => {
      const role = String(m?.role || "assistant");
      const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return `${role.toUpperCase()}: ${content}`;
    }).join("\n\n").slice(-24000);
    const rescue: any = await client.chat.completions.create({
      model: actualModel,
      max_tokens: 1400,
      messages: [
        {
          role: "system",
          content:
            "You must output STRICT JSON only: {context:string,synthesis:string,did:array,steps:array,links:array,sendables:array}. " +
            "did = one short past-tense bullet per action ACTUALLY performed with tools (empty if none). " +
            "Report ONLY what the transcript shows was ACTUALLY DONE with tools. synthesis = one short past-tense " +
            "sentence of performed actions ('Created X', 'Drafted Y'); if nothing was created or written, say " +
            "plainly what was found and put ALL remaining work in steps (each {text, automatable}) — do NOT " +
            "describe the user or summarize their life. links = ONLY artifacts CREATED this run (URLs from " +
            "create-tool results in the transcript, each with a label saying what it IS); NEVER list pre-existing " +
            "files that were merely read. Fabricating a result is worse than admitting the run fell short.",
        },
        { role: "user", content: transcript },
      ],
    });
    const text = rescue.choices[0]?.message?.content || "";
    const out = firstJson<RunOutput>(text);
    if (out) return withTokens(finalize(out, text, profileUpdates));
  } catch {
    // fall through to the throw below
  }
  // No usable result even after the rescue pass. NEVER fake an "executed" state ("Prepared what I
  // could…" + a Run-again step) — throw so the task honestly returns to ready and retries.
  throw new Error("The run didn't produce a result — it will retry.");
  } finally {
    console.log(`${new Date().toISOString()} [ai] runTask "${task.title.slice(0, 50)}": ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}

export function finalize(out: any, fallbackText: string, profileUpdates: ProfileUpdate[]): RunOutput {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps: TaskStep[] = rawSteps
    .map((s: any, idx: number) => ({
      text: String(s?.text || "").trim(),
      automatable: !!s?.automatable,
      needsPermission: !!s?.needsPermission,
      // Valid only if it points at a REAL other step — a bad index (9 in a 3-step list, or itself)
      // would permanently block the step client-side.
      dependsOn: Number.isInteger(s?.dependsOn) && s.dependsOn >= 0 && s.dependsOn < rawSteps.length && s.dependsOn !== idx ? s.dependsOn : undefined,
      url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : undefined,
      question: s?.question ? String(s.question).trim().slice(0, 200) : undefined,
      options: Array.isArray(s?.options) ? s.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 4) : undefined,
    }))
    .filter((s: TaskStep) => s.text)
    .slice(0, 10);
  // Generic labels ("Open", "Link", a bare URL) tell the user nothing — name the artifact by its URL kind.
  const kindLabel = (url: string): string =>
    /docs\.google\.com\/document/i.test(url) ? "the Google Doc Otto created"
    : /docs\.google\.com\/spreadsheets/i.test(url) ? "the Google Sheet Otto created"
    : /docs\.google\.com\/presentation/i.test(url) ? "the slides Otto created"
    : /mail\.google\.com/i.test(url) ? "the email thread"
    : /calendar\.google\.com/i.test(url) ? "the calendar event"
    : "the linked page";
  const isJunkLabel = (s: string) => !s || /^(open|link|url|click here|view|here|document|doc)$/i.test(s.trim()) || /^https?:\/\//i.test(s.trim());
  const links: TaskLink[] = (Array.isArray(out?.links) ? out.links : [])
    .map((l: any) => {
      const url = String(l?.url || "").trim();
      const raw = String(l?.label || "").slice(0, 80);
      return { label: isJunkLabel(raw) ? kindLabel(url) : raw, url };
    })
    .filter((l: TaskLink) => /^https?:\/\//i.test(l.url))
    // Artifact verification: a Google Docs/Sheets/Slides link must carry a REAL document id (25+ chars of
    // id alphabet) — a made-up or truncated link would render a polished card pointing at a 404.
    .filter((l: TaskLink) => !/docs\.google\.com/i.test(l.url) || /\/(document|spreadsheets|presentation)\/(d\/)?[-\w]{25,}/i.test(l.url))
    .slice(0, 3); // max 3 open links per task — the essentials, not a link dump
  const sendables: Sendable[] = (Array.isArray(out?.sendables) ? out.sendables : [])
    .map((s: any): Sendable => ({
      app: s?.app === "slack" ? "slack" : s?.app === "gcal" ? "gcal" : "gmail",
      label: String(s?.label || (s?.app === "slack" ? "Send message" : s?.app === "gcal" ? "Send invites" : "Send email")).slice(0, 80),
      to: s?.to ? String(s.to).slice(0, 160) : undefined,
      subject: s?.subject ? String(s.subject).slice(0, 300) : undefined,
      body: s?.body ? String(s.body).slice(0, 6000) : undefined,
      draftId: s?.draftId ? String(s.draftId).slice(0, 200) : undefined,
      channel: s?.channel ? String(s.channel).slice(0, 120) : undefined,
      text: s?.text ? String(s.text).slice(0, 4000) : undefined,
      attendees: Array.isArray(s?.attendees) ? s.attendees.map((a: any) => String(a).slice(0, 160)).filter(Boolean).slice(0, 50) : undefined,
      eventId: s?.eventId ? String(s.eventId).slice(0, 200) : undefined,
      summary: s?.summary ? String(s.summary).slice(0, 300) : undefined,
      when: s?.when ? String(s.when).slice(0, 120) : undefined,
    }))
    // Artifact verification: a sendable must be COMPLETE enough to review — a Gmail send needs the draft
    // id AND a visible recipient AND reviewable content; a calendar invite needs its event + attendees +
    // what/when. A half-formed sendable is dropped (the draft still exists in Gmail; the user isn't shown
    // a Send button whose contents they can't see).
    .filter((s: Sendable) =>
      (s.app === "gmail" && !!s.draftId && !!s.to && !!(s.subject || s.body)) ||
      (s.app === "slack" && !!s.channel && !!s.text) ||
      (s.app === "gcal" && !!s.eventId && !!s.attendees?.length && !!(s.summary || s.when)))
    .slice(0, 6);
  // Brevity backstop: a few lines + a hard char cap, so even a verbose run can't produce a wall of text.
  const brief = (s: string, lines: number, chars: number) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join("\n").slice(0, chars);
  // Synthesis is ONLY the structured field the model submitted — NEVER its raw reply text. Falling back
  // to the transcript is how the user ended up reading the model's THINKING ("Seems like… Let me first…
  // Now I'll create…") on the card instead of a result. And planning-tense text is not a result even when
  // it arrives in the right field — a run that only says what it WOULD do gets the honest-failure retry.
  let synthesis = brief(String(out?.synthesis || ""), 3, 550);
  const PLANNING = /\b(let me|i'?ll (?:first|now|then|use|create|draft|check)|i will (?:first|now|then)|now i(?:'?ll)? |first,? i(?:'?ll)? |seems like|my plan is|i need to|i should)\b/i;
  if (PLANNING.test(synthesis)) synthesis = "";
  // "What Otto did" bullets: same hygiene as synthesis — past-tense actions only, planning prose dropped.
  const did: string[] = (Array.isArray(out?.did) ? out.did : [])
    .map((d: any) => String(d || "").trim().replace(/^\s*[-•*]\s*/, ""))
    .filter((d: string) => d.length >= 6 && !PLANNING.test(d))
    .map((d: string) => d.slice(0, 160))
    .slice(0, 6);
  void fallbackText; // kept in the signature for call-site compatibility; intentionally unused as content
  // A completely empty result (no report, no steps, no artifacts) is a FAILED run, not a quiet success —
  // throwing routes it to the honest-failure path (task returns to ready + client auto-retries).
  if (!synthesis && !steps.length && !links.length && !sendables.length) {
    throw new Error("The run produced no output — it will retry.");
  }
  // Otto-work leak check (observed live: "Create a new Google Doc…" listed as a USER step): a step that
  // starts with a doable verb and carries no judgment for the user gets flipped to automatable — Auto-do
  // then executes it instead of dumping Otto's own work on the user.
  const DOABLE = /^(create|draft|write|update|add|fill|schedule|search|compile|prepare|generate|make)\b/i;
  const JUDGMENT = /\b(choose|decide|pick|confirm|approve|review|prefer|want|which|verify|check with|sign|pay)\b/i;
  for (const s of steps) {
    if (!s.automatable && DOABLE.test(s.text) && !JUDGMENT.test(s.text) && !s.question) s.automatable = true;
  }
  // Never list DONE work as remaining: a step that near-duplicates a did-bullet is stale planning residue.
  const stale = (txt: string) => did.some((d) => {
    const a = new Set(txt.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const b = new Set(d.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const inter = [...a].filter((w) => b.has(w)).length;
    return a.size > 2 && inter / a.size >= 0.7;
  });
  const cleanedSteps = steps.filter((s) => !stale(s.text));
  steps.length = 0; steps.push(...cleanedSteps);
  // Checklist backstop: artifacts with NO steps and NO sendable leave the user without a "what's left"
  // list — the report the card promises. Deterministically add "Review <artifact>" so the checklist can
  // never be absent when something was produced. (Sendables don't need it: the send button IS the next action.)
  if (!steps.length && !sendables.length && links.length) {
    for (const l of links.slice(0, 2)) steps.push({ text: `Review ${l.label}`.slice(0, 80), automatable: false, url: l.url, synthetic: true });
  }
  return {
    context: brief(String(out?.context || ""), 3, 600),
    synthesis: synthesis || "Done.",
    did,
    steps,
    links,
    sendables,
    profileUpdates,
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
