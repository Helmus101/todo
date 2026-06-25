import Anthropic from "@anthropic-ai/sdk";
import type { Profile, TaskStep } from "../shared/types.ts";
import type { AgentTools } from "./integrations.ts";

/** Render the person-profile for prompts so generation + execution are personalized + grounded. */
function profileBlock(p?: Profile): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.about) parts.push(`About them: ${p.about}`);
  if (p.preferences?.length) parts.push(`Preferences: ${p.preferences.join("; ")}`);
  if (p.people?.length) parts.push(`Key people: ${p.people.join("; ")}`);
  if (p.projects?.length) parts.push(`Ongoing projects: ${p.projects.join("; ")}`);
  return parts.length ? `\nWHO THIS PERSON IS (use to judge what matters + match their style):\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
}

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

export function aiReady(): boolean { return !!process.env.ANTHROPIC_API_KEY; }

function clientOrThrow(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in web/.env.");
  return new Anthropic({ apiKey });
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

export interface GeneratedTask {
  title: string;
  why: string;
  when?: string;
  source: "gmail" | "calendar" | "manual";
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
  `never invent people, dates, or facts. READ ONLY here — do NOT create, modify, draft, or send anything during ` +
  `generation. Be efficient: a few targeted reads PER connected app, then submit.`;

const SUBMIT_TASKS_TOOL: Anthropic.Tool = {
  name: "submit_tasks",
  description: "Submit the full actionable to-do list you found.",
  input_schema: { type: "object", properties: {
    tasks: { type: "array", description: "one per actionable thread/event", items: { type: "object", properties: {
      title: { type: "string", description: "short imperative, <= 9 words" },
      why: { type: "string", description: "one grounded clause naming the concrete trigger" },
      when: { type: "string", description: "concise timeline/deadline grounded in the data (e.g. 'today', 'by Fri 5pm') or '' " },
      source: { type: "string", enum: ["gmail", "calendar"] },
      risk: { type: "string", enum: ["low", "high"], description: "'high' if completing it means sending/inviting (irreversible)" },
      urgency: { type: "number", description: "0..1 time pressure" },
      importance: { type: "number", description: "0..1 stakes" },
      anchorKey: { type: "string", description: "stable id of the item, e.g. 'gmail:<threadId>' or 'calendar:<eventId>'" },
      link: { type: "string", description: "a URL to open the source item, if you have one" },
    }, required: ["title", "why", "source", "urgency", "importance"] } },
  }, required: ["tasks"] },
};

function parseGenerated(arr: any): GeneratedTask[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .map((t): GeneratedTask => ({
      title: String(t.title).slice(0, 90),
      why: String(t.why || "").slice(0, 400),
      when: t.when ? String(t.when).slice(0, 40) : undefined,
      source: t.source === "calendar" ? "calendar" : "gmail",
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
export async function generateTasks(profile?: Profile, extras?: AgentTools): Promise<GeneratedTask[]> {
  if (!extras?.tools?.length) return []; // nothing connected to read
  const client = clientOrThrow();
  const tools: Anthropic.Tool[] = [...extras.tools, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length
    ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.`
    : `Use whatever tools you have to read what needs me.`;
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Today is ${new Date().toISOString()}.\n` + profileBlock(profile) +
      `\n${connectedLine}\nSweep across all of them for everything genuinely awaiting me, then call submit_tasks ` +
      `with my full actionable to-do list. Be efficient: a few targeted reads per app, then submit.`,
  }];
  const MAX = 7;
  for (let i = 0; i < MAX; i++) {
    const forceSubmit = i === MAX - 1;
    const res = await client.messages.create({
      model: MODEL, max_tokens: 4000, system: GEN_SYSTEM, tools, messages,
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

export interface ProfileUpdate { category: "about" | "preference" | "person" | "project"; fact: string; }
export interface RunOutput {
  context: string;
  synthesis: string;
  steps: TaskStep[];
  profileUpdates: ProfileUpdate[];
}

const RUN_SYSTEM =
  `You execute ONE task for the user, end to end, using the tools available — their CONNECTED apps via ` +
  `Composio (Gmail, Google Calendar, Docs, Slides, Drive, Sheets, and any others: Slack, GitHub, Notion, ` +
  `Linear, Todoist, …). USE them to gather the real facts AND to DO the reversible work: draft a reply, ` +
  `create a doc/deck/sheet, add a task or calendar event, update an issue. Do NOT ask the user for anything ` +
  `you could find or do yourself. Be rigorously honest and grounded; never invent specifics.\n` +
  `HARD LIMIT — you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: ` +
  `no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not ` +
  `even available to you). For email you ONLY ever leave a DRAFT; actually SENDING it is ALWAYS a step for the ` +
  `USER. Never say you "sent", "emailed", "posted", or "messaged" — say you DRAFTED/PREPARED it. Never claim an ` +
  `action you didn't take.\n` +
  `STRONGLY PREFER DOING OVER DEFERRING: if a step is something your tools can do, DO IT THIS RUN — do not ` +
  `hand it back to the user. Chain the work: gather facts, then draft/create/update right away. Only leave a ` +
  `step UNDONE if it is genuinely blocked on the user (needs their decision, a credential you lack, or a ` +
  `prerequisite they must do first).\n` +
  `When done, call "submit" with: a "context" and a "synthesis" of what you actually did, BOTH as SHORT BULLET ` +
  `POINTS (each a terse line beginning with "- ", never a wall of prose), and a "steps" breakdown of what is ` +
  `LEFT (ordered). Classify "automatable" GENEROUSLY: true if ANY of your tools could do it — draft, create a ` +
  `doc/deck/sheet, add a task/event, update or comment on an issue, research, or open a page. Set false ONLY ` +
  `for things that truly need a human: a judgment call or approval, a credential/login you don't have, a ` +
  `payment, a physical-world action, or hitting SEND/POST/PUBLISH/DELETE on something irreversible. When in ` +
  `doubt, mark it automatable — Weave will attempt it and fall back to the user if it can't. Set "dependsOn" to ` +
  `an earlier step's index if it must happen first; add "url" if the step is opening a specific page.\n` +
  `Use "remember" for a durable fact about WHO THIS PERSON IS (a preference, a key person, an ongoing project, ` +
  `or a one-line "about"). Be selective. WORK EFFICIENTLY: a few targeted tool calls, then submit.`;

const RUN_TOOLS: Anthropic.Tool[] = [
  { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), or 'about' (a one-line summary of them).", input_schema: { type: "object", properties: { category: { type: "string", enum: ["about", "preference", "person", "project"] }, fact: { type: "string" } }, required: ["category", "fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    context: { type: "string", description: "what this is about — 2-4 CONCISE bullet points, each a short phrase on its own line beginning with '- '. NOT a paragraph." },
    synthesis: { type: "string", description: "what you actually DID this run — a few CONCISE bullet points, each on its own line beginning with '- '. NOT a paragraph." },
    steps: {
      type: "array",
      description: "what's LEFT, ordered. Classify each step.",
      items: { type: "object", properties: {
        text: { type: "string", description: "the step, short and concrete" },
        automatable: { type: "boolean", description: "true if WEAVE can do it (draft/doc/research/create/update/open a page); false if it needs the user" },
        dependsOn: { type: "number", description: "index of an earlier step that must be done first; omit if none" },
        url: { type: "string", description: "a page to open, if the step is to visit/open one" },
      }, required: ["text", "automatable"] },
    },
  }, required: ["context", "synthesis", "steps"] } },
];

/**
 * Run a task as a bounded tool-using agent over the user's CONNECTED apps (Composio): it gathers facts and
 * does the reversible work (drafts, docs, tasks, updates) itself, then submits a context + synthesis + the
 * steps that are LEFT. Irreversible sends/deletes are never available to it. Also returns durable profile facts.
 */
export async function runTask(task: { title: string; why: string; source?: string }, profile?: Profile, focus?: string, extras?: AgentTools): Promise<RunOutput> {
  const client = clientOrThrow();
  const profileUpdates: ProfileUpdate[] = [];
  const tools = extras?.tools?.length ? [...RUN_TOOLS, ...extras.tools] : RUN_TOOLS;
  const connectedLine = extras?.connected?.length
    ? `\nConnected apps you can use (read + reversible writes; never send/post/delete): ${extras.connected.join(", ")}.\n`
    : `\nNo apps are connected yet — if you can't proceed without one, say so in the synthesis and put "Connect the app in Settings" as a step.\n`;
  const manualHint = task.source === "manual"
    ? `\nThe USER added this to-do themselves. Treat the title as their intent: use your tools (search their Gmail/Drive, etc.) and what you know about them to find the real, specific context behind it BEFORE acting.`
    : "";
  const head = `TASK: ${task.title}\nWHY: ${task.why}\n` + profileBlock(profile) + connectedLine;
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: focus
      // Focused single-step run (the user hit "Auto-do" on one automatable step).
      ? head + `\nDo ONLY this one step now: "${focus}". Use your tools, do the reversible work, then submit — synthesis = what you did for this step; steps = [] unless something still genuinely needs the user.`
      : head + manualHint + `\nBe efficient: gather what you need, do the reversible work, then call submit with your best grounded result.`,
  }];

  const MAX = 8;
  for (let i = 0; i < MAX; i++) {
    // On the final round, FORCE a submit so it always returns a real result instead of "ran out of steps".
    const forceSubmit = i === MAX - 1;
    const res = await client.messages.create({
      model: MODEL, max_tokens: 4000, system: RUN_SYSTEM, tools, messages,
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
          const cat = ["about", "preference", "person", "project"].includes(input.category) ? input.category : "preference";
          if (fact) profileUpdates.push({ category: cat, fact });
          content = "saved";
        }
        else if (tu.name === "submit") { submitted = finalize(input as RunOutput, "", profileUpdates); content = "submitted"; }
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
  return { context: "", synthesis: "- Gathered context but ran out of steps before finishing — try Run again.", steps: [], profileUpdates };
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
  return {
    context: String(out?.context || "").slice(0, 8000),
    synthesis: String(out?.synthesis || fallbackText || "Done.").slice(0, 8000),
    steps,
    profileUpdates,
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
