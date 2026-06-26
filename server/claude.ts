import Anthropic from "@anthropic-ai/sdk";
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
  return parts.length ? `\nWHO THIS PERSON IS (use to judge what matters + match their style):\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
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

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

export function aiReady(): boolean { return !!process.env.ANTHROPIC_API_KEY; }

function clientOrThrow(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in web/.env.");
  return new Anthropic({ apiKey });
}

// Prompt caching: an ephemeral cache breakpoint on the last tool + the system prompt means the large, static
// prefix (the tool list alone is ~100+ defs) is billed ONCE per ~5-min window instead of re-sent on every agent
// round and every auto-run — a big input-token cut with zero behaviour change.
function cacheLastTool(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (!tools.length) return tools;
  return tools.map((t, i) => (i === tools.length - 1 ? ({ ...t, cache_control: { type: "ephemeral" } } as any) : t));
}
const sysCached = (text: string): any => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

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
  `Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable ` +
  `noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; ` +
  `never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a ` +
  `sender is, a public deadline). NEVER resurface a to-do the user already finished or DISMISSED — if an ` +
  `"ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ` +
  `READ ONLY here — do NOT create, modify, draft, or send anything during ` +
  `generation. Be efficient: a few targeted reads PER connected app, then submit.`;

const SUBMIT_TASKS_TOOL: Anthropic.Tool = {
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
const WEB_SEARCH_TOOL: Anthropic.Tool = {
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
  const client = clientOrThrow();
  const tools: Anthropic.Tool[] = cacheLastTool([...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL]);
  const connectedLine = extras.connected?.length
    ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.`
    : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length
    ? `\nALREADY HANDLED — I already finished or dismissed these; do NOT create a task for any of them again, even if its source email/event is still around:\n` +
      handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + handledBlock +
      `\n${connectedLine}\nSweep across all of them for everything genuinely awaiting me, then call submit_tasks ` +
      `with my full actionable to-do list. Be efficient: a few targeted reads per app, then submit.`,
  }];
  const MAX = 7;
  for (let i = 0; i < MAX; i++) {
    const forceSubmit = i === MAX - 1;
    const res = await client.messages.create({
      model: MODEL, max_tokens: 4000, system: sysCached(GEN_SYSTEM), tools, messages,
      ...(forceSubmit ? { tool_choice: { type: "tool" as const, name: "submit_tasks" } } : {}),
    });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) return [];
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let submitted: GeneratedTask[] | null = null;
    for (const tu of toolUses) {
      let content = "ok";
      try {
        if (tu.name === "submit_tasks") { submitted = parseGenerated((tu.input as any)?.tasks); content = "submitted"; }
        else if (tu.name === "web_search") { content = await runWebSearch(tu.input); }
        else { const r = await extras.call(tu.name, (tu.input as any) || {}); content = r ?? `Unknown tool: ${tu.name}`; }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(content).slice(0, 6000) });
    }
    if (submitted) { if (!submitted.length) console.warn("[claude] generateTasks submitted 0 tasks"); return submitted; }
    messages.push({ role: "user", content: results });
  }
  return [];
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
    const res = await clientOrThrow().messages.create({
      model: MODEL, max_tokens: 500,
      system: "You turn a person's rough to-do note into one crisp, actionable task. Preserve their intent and any specifics they gave; do NOT invent names, dates, or facts they didn't state. Output STRICT JSON only.",
      messages: [{
        role: "user",
        content: profileBlock(profile) +
          `\nRough note: "${raw.slice(0, 300)}"\n\nReturn JSON: {"title": short imperative <= 9 words, ` +
          `"why": one concise clause capturing the intent, "when": a concise deadline/timeline if implied (e.g. "today", "by Fri") else "", ` +
          `"urgency": 0..1 time pressure, "importance": 0..1 stakes}. JSON only.`,
      }],
    });
    const out = firstJson<any>(res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(""));
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
  `VOICE — SOUND LIKE THE USER, NOT AN AI: when you draft an email or message, write the way THEY actually write ` +
  `— default to fairly casual, warm, direct and brief (how a real person emails a colleague). Match them: skim a ` +
  `couple of their OWN recent sent emails (search "in:sent") or their earlier replies in the thread, and mirror ` +
  `their greeting + sign-off, sentence length, formality, and contractions. AVOID AI tells — no "I hope this ` +
  `email finds you well", "I wanted to reach out", "Please don't hesitate", "Thank you for your understanding", ` +
  `em-dash-heavy corporate phrasing, or stiff over-formality. Nudge a touch more polished only for someone senior ` +
  `or unknown. If you pick up a durable detail of their style, "remember" it as a preference.\n` +
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
  `then book it". Add "url" only for an open-a-page step.\n` +
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
  `channel, text} — do NOT post it. For a calendar event that needs to invite people, add {app:"gcal", label, ` +
  `eventId, attendees:[the invitees' emails], summary, when} — do NOT notify them. Each gives the user a Send ` +
  `button that names the recipient(s) first; you still never send. Don't ALSO add a "send it" step — the button ` +
  `is the send.\n` +
  `Use "remember" for a durable fact about WHO THIS PERSON IS (a preference, a key person, an ongoing project, ` +
  `or a one-line "about"). Be selective. Call "submit" ONLY after you've actually done the reversible work — ` +
  `not before. Be BRIEF: "synthesis" is ONE sentence; "context" is 1-2 short bullets. Don't narrate problems or ` +
  `steps you skipped — just the result.`;

const RUN_TOOLS: Anthropic.Tool[] = [
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
        dependsOn: { type: "number", description: "index of an earlier step that must finish first — use it for an automatable step that waits on a user step; omit if none" },
        url: { type: "string", description: "a page to open, if the step is to visit/open one" },
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
  const client = clientOrThrow();
  const profileUpdates: ProfileUpdate[] = [];
  const tools = cacheLastTool([...RUN_TOOLS, WEB_SEARCH_TOOL, ...(extras?.tools?.length ? extras.tools : [])]);
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
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: focus
      // Focused single-step run (the user hit "Auto-do" on one automatable step).
      ? head + `\nDo ONLY this one step now: "${focus}". Actually DO it with your tools (draft/create/update) — don't describe it, DO it — then submit: synthesis = what you did; steps = [] unless something still genuinely needs the user.`
      : head + manualHint + `\nGather what you need, then ACTUALLY DO the reversible work now with your tools (draft/create/update) — don't just plan it. Only once you've done everything you can, call submit; list as steps only what truly needs the user.`,
  }];

  const MAX = 8;
  for (let i = 0; i < MAX; i++) {
    // On the final round, FORCE a submit so it always returns a real result instead of "ran out of steps".
    const forceSubmit = i === MAX - 1;
    const res = await client.messages.create({
      model: MODEL, max_tokens: 4000, system: sysCached(RUN_SYSTEM), tools, messages,
      ...(forceSubmit ? { tool_choice: { type: "tool" as const, name: "submit" } } : {}),
    });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const out = firstJson<RunOutput>(text);
      return finalize(out, text, profileUpdates);
    }
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let submitted: RunOutput | null = null;
    for (const tu of toolUses) {
      const input = tu.input as any;
      let content = "ok";
      try {
        if (tu.name === "remember") {
          const fact = String(input.fact || "").trim();
          const cat = ["name", "about", "preference", "person", "project"].includes(input.category) ? input.category : "preference";
          if (fact) profileUpdates.push({ category: cat, fact });
          content = "saved";
        }
        else if (tu.name === "submit") { submitted = finalize(input as RunOutput, "", profileUpdates); content = "submitted"; }
        else if (tu.name === "web_search") { content = await runWebSearch(input); }
        else {
          // A connected-integration tool (Gmail/Calendar/Slack/GitHub/…). Returns null if it isn't one.
          const r = extras ? await extras.call(tu.name, input || {}) : null;
          content = r ?? `Unknown tool: ${tu.name}`;
        }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(content).slice(0, 6000) });
    }
    if (submitted) return submitted;
    messages.push({ role: "user", content: results });
  }
  return { context: "", synthesis: "- Gathered context but ran out of steps before finishing — try Run again.", steps: [], links: [], sendables: [], profileUpdates };
}

function finalize(out: any, fallbackText: string, profileUpdates: ProfileUpdate[]): RunOutput {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps: TaskStep[] = rawSteps
    .map((s: any) => ({
      text: String(s?.text || "").trim(),
      automatable: !!s?.automatable,
      dependsOn: Number.isInteger(s?.dependsOn) ? s.dependsOn : undefined,
      url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : undefined,
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
