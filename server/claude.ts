import OpenAI from "openai";
import type { Profile, TaskStep, TaskLink, Sendable } from "../shared/types.ts";
import type { AgentTools } from "./integrations.ts";
import { webSearch } from "./chat.ts";

/** Render the person-profile for prompts so generation + execution are personalized + grounded. */
function profileBlock(p?: Profile): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.name) parts.push(`Their name: ${p.name}`);
  if (p.about) parts.push(`About them: ${p.about}`);
  if (p.preferences?.length) parts.push(`Preferences: ${p.preferences.join("; ")}`);
  if (p.people?.length) parts.push(`Key people: ${p.people.join("; ")}`);
  if (p.projects?.length) parts.push(`Ongoing projects: ${p.projects.join("; ")}`);
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

async function retryRequest<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const isNetworkError = e?.code === "ENOTFOUND" || e?.message?.includes("fetch failed") || e?.message?.includes("socket hang up") || e?.status === 502 || e?.status === 503 || e?.status === 504 || e?.status === 429;
      if (!isNetworkError || i === retries - 1) throw e;
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
const TRIM_KEEP = 8, TRIM_TO = 700;
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
  `You are a sharp chief-of-staff turning someone's live world into their real, COMPLETE to-do list. Use EVERY ` +
  `tool available — across ALL their connected apps, not just email — to READ what genuinely needs them right ` +
  `now, then call submit_tasks. Sweep each connected source for actionable items, e.g.:\n` +
  `- Gmail: threads awaiting a reply or asking something (skip newsletters/promos/receipts/no-reply).\n` +
  `- Calendar: meetings in the next ~48h to prepare for or respond to.\n` +
  `- Slack / Discord: DMs & mentions awaiting your reply.\n` +
  `- GitHub / Linear / Jira: issues & PRs assigned to you, review requests, things blocking others.\n` +
  `- Notion / Todoist / Asana / Trello / ClickUp: tasks assigned or due soon.\n` +
  `- Any other connected app: whatever is genuinely waiting on this person.\n` +
  `- COMMITMENTS THEY MADE: also check their recently SENT mail/messages (e.g. Gmail search "in:sent newer_than:7d") ` +
  `for promises THEY made to others — "I'll send you X", "I'll get back to you by Friday", "let me check and ` +
  `follow up" — and create a task to FULFILL each one that looks unfulfilled (no later reply/attachment in the ` +
  `thread). Title it as the commitment ("Send Sarah the budget deck"), set "when" from the promised deadline, ` +
  `and anchor it to the sent thread ('gmail:<threadId>'). A broken promise is worse than a missed email.\n` +
  `Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable ` +
  `noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; ` +
  `never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a ` +
  `sender is, a public deadline).\n` +
  `GMAIL — SEARCH IT SEVERAL WAYS, not one generic fetch: (1) recent inbox needing action ` +
  `("in:inbox newer_than:7d -category:promotions -category:social"), (2) unread ("is:unread in:inbox"), ` +
  `(3) their SENT mail for open loops ("in:sent newer_than:10d") — read what THEY promised and check whether ` +
  `they delivered, and (4) threads where someone asked them something and the last message is NOT theirs ` +
  `(they owe a reply).\n` +
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
  `NEVER resurface a to-do the user already finished or DISMISSED — if an ` +
  `"ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ` +
  `READ ONLY here — do NOT create, modify, draft, or send anything during ` +
  `generation. BUDGET: you have roughly 10-12 tool calls TOTAL — batch your Gmail searches into one round ` +
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
  }, required: ["tasks"] },
};

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

function parseGenerated(arr: any): GeneratedTask[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
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
    .slice(0, 50);
}

/**
 * Generate the to-do list as a tool-using agent over the user's CONNECTED apps (Composio Gmail + Calendar):
 * it reads the recent inbox + upcoming events itself, then submits tasks. Returns [] if nothing is connected
 * to read (the client then prompts the user to connect Gmail/Calendar in Settings).
 */
export async function generateTasks(profile?: Profile, extras?: AgentTools, handled?: { title: string; anchorKey?: string }[]): Promise<GeneratedTask[]> {
  if (!extras?.tools?.length) return []; // nothing connected to read
  const tools = [...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length
    ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.`
    : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length
    ? `\nALREADY HANDLED — I already finished or dismissed these; do NOT create a task for any of them again, even if its source email/event is still around:\n` +
      handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  const messages: any[] = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + handledBlock +
      `\n${connectedLine}\nSweep across all of them for everything genuinely awaiting me — including what I ` +
      `promised others and haven't done yet (check my sent mail), and loose ends on my projects/people above — ` +
      `then call submit_tasks with my full actionable to-do list. Respect my stated preferences above when ` +
      `choosing, ranking, and phrasing tasks.`,
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  // Each round re-sends the whole growing transcript (tools + history) — rounds are the real cost driver.
  // The prompt tells the agent to BATCH searches as parallel calls in one round, so 12 rounds is plenty.
  const MAX = 12;
  let tokIn = 0, tokOut = 0, rounds = 0;
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
      return [];
    }
    messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
    let submitted: GeneratedTask[] | null = null;
    for (const tu of toolUses) {
      const input = parseToolArgs((tu as any).function?.arguments);
      const toolName = (tu as any).function?.name;
      let content = "ok";
      try {
        if (toolName === "submit_tasks") { submitted = parseGenerated(input?.tasks); content = "submitted"; }
        else if (toolName === "web_search") { content = await runWebSearch(input); }
        else { const r = await extras.call(toolName, input || {}); content = r ?? `Unknown tool: ${toolName}`; }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 6000) });
    }
    if (submitted) { if (!submitted.length) console.warn("[claude] generateTasks submitted 0 tasks"); return submitted; }
  }
  return [];
  } finally {
    console.log(`[ai] generateTasks: ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
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
      messages: [
        { role: "system", content: "You turn a person's rough to-do note into one crisp, actionable task. Preserve their intent and any specifics they gave; do NOT invent names, dates, or facts they didn't state. Output STRICT JSON only." },
        { role: "user", content: profileBlock(profile) +
          `\nRough note: "${raw.slice(0, 300)}"\n\nReturn JSON: {"title": short imperative <= 9 words, ` +
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
  steps: TaskStep[];
  links: TaskLink[];          // the artifacts it made this run (draft / doc / sheet / event / issue), so the user can open them
  sendables: Sendable[];      // drafted email / composed Slack message the user can fire with one click
  profileUpdates: ProfileUpdate[];
}

const RUN_SYSTEM =
  `You execute ONE task for the user, end to end, using the tools available — their CONNECTED apps via ` +
  `Composio (Gmail, Google Calendar, Docs, Slides, Drive, Sheets, and any others: Slack, GitHub, Notion, ` +
  `Linear, Todoist, …). USE them to gather the real facts AND to DO the reversible work: draft a reply, ` +
  `create a doc/deck/sheet, add a task or calendar event, update an issue. Use WHATEVER connected apps the task ` +
  `touches (Slack, Notion, Linear, Sheets, GitHub, …), not just email, and do as MUCH as your tools allow. Do ` +
  `NOT ask the user for anything you could find or do yourself. Be rigorously honest and grounded; never invent specifics.\n` +
  `You can also use web_search for any external fact or context you need (a person, company, deadline, how-to, ` +
  `or a reference link) — look it up rather than guess.\n` +
  `GOOGLE SHEETS — YOU MUST ACTUALLY WRITE: if the task involves updating a spreadsheet (e.g. filling in ` +
  `restaurant names, meal ideas, trip data, any cells), you MUST call the Sheets write tools ` +
  `(GOOGLESHEETS_BATCH_UPDATE_VALUES, GOOGLESHEETS_UPDATE_VALUES, GOOGLESHEETS_APPEND_VALUES, etc.) to ACTUALLY ` +
  `write the data into the cells — do NOT just produce a plan or list in synthesis. Read the sheet first to ` +
  `find the exact cells/ranges that need filling, then call the write tool with real content. Sheet cell writes ` +
  `are FULLY PERMITTED and reversible — you do NOT need user approval to write cells. Do it now.\n` +
  `GATHER CONTEXT AGGRESSIVELY — BEFORE you act, search EVERYWHERE for relevant information:\n` +
  `- Search Gmail for related threads (e.g., hotel bookings, flight confirmations, restaurant reservations, addresses, phone numbers)\n` +
  `- Search Calendar for related events (e.g., travel dates, meeting times, deadlines)\n` +
  `- Search Drive for related documents (e.g., itineraries, proposals, notes, spreadsheets with details)\n` +
  `- Check the user's profile memory for known preferences, people, and projects\n` +
  `- Use web_search for external details (addresses, directions, company info)\n` +
  `Example: if the task is "prep to go somewhere from hotel", search Gmail for the hotel booking confirmation to get the hotel name, address, checkout time; search Calendar for departure details; search Drive for any itinerary. NEVER leave placeholders like "[hotel name]" or "[address]" — find the real details.\n` +
  `HARD LIMIT — you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: ` +
  `no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not ` +
  `even available to you). For email you ONLY ever leave a DRAFT; for Slack you only COMPOSE the message. You ` +
  `never send/post — instead OFFER the send as a one-click button via "sendables" (see submit), which the user ` +
  `reviews and fires. Never say you "sent", "emailed", "posted", or "messaged" — say you DRAFTED/PREPARED it. ` +
  `Never claim an action you didn't take.\n` +
  `CALENDAR INVITES: create/update the event freely — but it lands on the user's calendar SILENTLY, with NO ` +
  `emails to anyone (you cannot notify attendees yourself). If the event SHOULD invite people, do NOT email them; ` +
  `instead add a "sendables" entry {app:"gcal", label, eventId, attendees:[their emails], summary, when} so the ` +
  `user gets a one-click "Send invites" button that SHOWS exactly who will be invited before they confirm. You ` +
  `never send the invite; the user's click does, with the recipient list in plain view.\n` +
  `VOICE — SOUND LIKE THE USER, NOT AN AI: before drafting ANY email or message, READ 2-3 of their OWN sent ` +
  `emails (search "in:sent", ideally to the same recipient or thread) and copy their ACTUAL writing mechanics:\n` +
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
  `(a choice between real options, a preference, a date only they know), keep automatable=true and set ` +
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
  `or a one-line "about"). Be selective. Call "submit" ONLY after you've actually done the reversible work — ` +
  `not before. Be BRIEF: "synthesis" is ONE sentence; "context" is 1-2 short bullets. Don't narrate problems or ` +
  `steps you skipped — just the result.`;

const RUN_TOOLS = [
  { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'name' (what to call them — save it the moment you learn their name, e.g. from their email signature or how others address them; fact = just the name), 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), or 'about' (a one-line summary of them).", input_schema: { type: "object", properties: { category: { type: "string", enum: ["name", "about", "preference", "person", "project"] }, fact: { type: "string" } }, required: ["category", "fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    context: { type: "string", description: "what this is about — 1-2 SHORT bullets, each a line beginning with '- '. Brief; the user only sees this if they expand it." },
    synthesis: { type: "string", description: "what you accomplished — ONE short plain sentence (≤ ~25 words), past tense, e.g. 'Drafted a reply to Sarah and opened the budget doc.' NO caveats, NO explaining what you couldn't do or why — anything the user must handle goes in 'steps', not here." },
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
        label: { type: "string", description: "what it is, e.g. 'Draft reply to Sarah', 'Project brief doc'" },
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
export async function runTask(task: { title: string; why: string; source?: string; links?: TaskLink[] }, profile?: Profile, focus?: string, extras?: AgentTools): Promise<RunOutput> {
  const profileUpdates: ProfileUpdate[] = [];
  const tools = [...RUN_TOOLS, WEB_SEARCH_TOOL, ...(extras?.tools?.length ? extras.tools : [])];
  const connectedLine = extras?.connected?.length
    ? `\nConnected apps you can use (read + reversible writes; never send/post/delete): ${extras.connected.join(", ")}.\n`
    : `\nNo apps are connected yet — if you can't proceed without one, say so in the synthesis and put "Connect the app in Settings" as a step.\n`;
  const manualHint = task.source === "manual"
    ? `\nThe USER added this to-do themselves. Treat the title as their intent: use your tools (search their Gmail/Drive, etc.) and what you know about them to find the real, specific context behind it BEFORE acting.`
    : "";
  // Artifacts this task already produced on a previous run — the agent MUST reuse + UPDATE these, never make
  // a fresh copy (this is what stops "5 road-trip packing lists"). A deterministic anti-duplication signal.
  const priorArtifacts = (task.links || []).filter((l) => l?.url);
  const artifactsBlock = priorArtifacts.length
    ? `\nALREADY CREATED FOR THIS TASK (you made these on a prior run — OPEN and UPDATE the existing one, do NOT create a new copy):\n${priorArtifacts.map((l) => `- ${l.label}: ${l.url}`).join("\n")}\n`
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
  const MAX = 24; // enough turns for multi-city/multi-step tasks (read sheet → search each city → write rows)
  let tokIn = 0, tokOut = 0, rounds = 0;
  try {
  for (let i = 0; i < MAX; i++) {
    // Mid-loop nudge: if the agent has used many turns without calling submit, remind it to
    // actually WRITE the data (not just keep reading) and move toward finishing.
    if (i === 10 && !focus) {
      messages.push({ role: "user", content: "REMINDER: You have now gathered significant context. If this task involves writing to a spreadsheet or document, START WRITING NOW — call the write tool (e.g. GOOGLESHEETS_BATCH_UPDATE_VALUES or GOOGLESHEETS_APPEND_VALUES) with the real data. Do not keep reading without writing. Complete the work and call submit when done." });
    }
    const client = deepseekClient();
    const lastRoundHint = i === MAX - 1 ? "You must call submit now with the final result. Do not answer with prose." : "";
    const base = trimOldToolResults(messages);
    const apiMessages = lastRoundHint ? [...base, { role: "user" as const, content: lastRoundHint }] : base;
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: 4000,
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
      if (out) return finalize(out, textContent, profileUpdates);
      if (i < MAX - 1) {
        if (textContent) messages.push({ role: "assistant", content: textContent });
        messages.push({ role: "user", content: "You still have not used any tools. Read the connected apps and do the work now. Do not answer with prose until you have actually acted." });
        continue;
      }
      return finalize(out, textContent, profileUpdates);
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
        else if (toolName === "submit") { submitted = finalize(input as RunOutput, "", profileUpdates); content = "submitted"; }
        else if (toolName === "web_search") { content = await runWebSearch(input); }
        else {
          // A connected-integration tool (Gmail/Calendar/Slack/GitHub/…). Returns null if it isn't one.
          const r = extras ? await extras.call(toolName, input || {}) : null;
          content = r ?? `Unknown tool: ${toolName}`;
        }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 6000) });
    }
    if (submitted) return submitted;
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
            "You must output STRICT JSON only: {context:string,synthesis:string,steps:array,links:array,sendables:array}. " +
            "Use the transcript to produce the best possible final result. Keep synthesis to one short sentence.",
        },
        { role: "user", content: transcript },
      ],
    });
    const text = rescue.choices[0]?.message?.content || "";
    const out = firstJson<RunOutput>(text);
    if (out) return finalize(out, text, profileUpdates);
  } catch {
    // fall through to a safe non-error output
  }
  return {
    context: "- Couldn't finalize this run automatically.",
    synthesis: "Prepared what I could, but this task still needs another run.",
    steps: [{ text: "Run this task again", automatable: true }],
    links: [],
    sendables: [],
    profileUpdates,
  };
  } finally {
    console.log(`[ai] runTask "${task.title.slice(0, 50)}": ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}

function finalize(out: any, fallbackText: string, profileUpdates: ProfileUpdate[]): RunOutput {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps: TaskStep[] = rawSteps
    .map((s: any) => ({
      text: String(s?.text || "").trim(),
      automatable: !!s?.automatable,
      needsPermission: !!s?.needsPermission,
      dependsOn: Number.isInteger(s?.dependsOn) ? s.dependsOn : undefined,
      url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : undefined,
      question: s?.question ? String(s.question).trim().slice(0, 200) : undefined,
      options: Array.isArray(s?.options) ? s.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 4) : undefined,
    }))
    .filter((s: TaskStep) => s.text)
    .slice(0, 10);
  const links: TaskLink[] = (Array.isArray(out?.links) ? out.links : [])
    .map((l: any) => ({ label: String(l?.label || "Open").slice(0, 80), url: String(l?.url || "").trim() }))
    .filter((l: TaskLink) => /^https?:\/\//i.test(l.url))
    .slice(0, 6);
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
    .filter((s: Sendable) => (s.app === "gmail" && !!s.draftId) || (s.app === "slack" && !!s.channel && !!s.text) || (s.app === "gcal" && !!s.eventId && !!s.attendees?.length))
    .slice(0, 6);
  // Brevity backstop: a few lines + a hard char cap, so even a verbose run can't produce a wall of text.
  const brief = (s: string, lines: number, chars: number) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join("\n").slice(0, chars);
  return {
    context: brief(String(out?.context || ""), 3, 600),
    synthesis: brief(String(out?.synthesis || fallbackText || "Done."), 3, 550),
    steps,
    links,
    sendables,
    profileUpdates,
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
