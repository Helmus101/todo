import Anthropic from "@anthropic-ai/sdk";
import type { Credentials } from "google-auth-library";
import type { Context } from "./google.ts";
import { searchGmail, readEmail, searchDrive, readDoc } from "./google.ts";

function memoryBlock(memory: string[]): string {
  return memory?.length ? `\nWHAT YOU KNOW ABOUT THE USER (memory):\n${memory.map((m) => `- ${m}`).join("\n")}\n` : "";
}

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

export function aiReady(): boolean { return !!process.env.ANTHROPIC_API_KEY; }

function clientOrThrow(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in web/.env.");
  return new Anthropic({ apiKey });
}

async function ask(system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await clientOrThrow().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
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
  source: "gmail" | "calendar" | "manual";
  risk: "low" | "high";
  urgency: number;
  importance: number;
  evidenceUrl?: string;
}

const GEN_SYSTEM =
  `You are a sharp chief-of-staff turning someone's live inbox and calendar into a SHORT list of the ` +
  `highest-signal to-dos. Quality over quantity — only things that genuinely need attention soon. ` +
  `Ground every task in the provided data; never invent people, dates, or facts. Skip newsletters, ` +
  `promos, automated and no-reply mail. Return STRICT JSON only.`;

export async function generateTasks(ctx: Context, memory: string[] = []): Promise<GeneratedTask[]> {
  const inbox = ctx.inbox.map((m, i) => `[E${i}] from ${m.from} | "${m.subject}" | ${m.date} | ${m.lastInbound ? "awaiting your reply" : "you replied last"} | ${m.snippet}`).join("\n") || "(inbox empty)";
  const events = ctx.events.map((e, i) => `[C${i}] "${e.summary}" at ${e.start} | attendees: ${e.attendees.join(", ") || "none"}`).join("\n") || "(no upcoming events)";
  const user =
    `Today is ${new Date().toISOString()}. The user is ${ctx.email || "(unknown)"}.\n` +
    memoryBlock(memory) +
    `\nINBOX (recent threads):\n${inbox}\n\nUPCOMING EVENTS (next 48h):\n${events}\n\n` +
    `Return a JSON array (max 8) of the to-dos that matter. Each item:\n` +
    `{"title": short imperative <= 9 words, "why": one grounded clause, "source": "gmail"|"calendar", ` +
    `"risk": "high" if completing it means sending/inviting (irreversible) else "low", ` +
    `"urgency": 0..1 (time pressure), "importance": 0..1 (stakes)}.\n` +
    `If nothing clears the bar, return []. No prose, JSON only.`;
  const raw = await ask(GEN_SYSTEM, user, 1800);
  const parsed = firstJson<GeneratedTask[]>(raw);
  const arr = Array.isArray(parsed) ? parsed : []; // model may return an object/garbage — never crash
  return arr
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .map((t) => ({
      title: String(t.title).slice(0, 90),
      why: String(t.why || "").slice(0, 200),
      source: t.source === "calendar" ? "calendar" : "gmail",
      risk: t.risk === "high" ? "high" : "low",
      urgency: clamp01(t.urgency ?? 0.5),
      importance: clamp01(t.importance ?? 0.6),
    }));
}

export interface RunOutput {
  context: string;
  synthesis: string;
  residual: string[];
  prepared?: { type: "draft"; to?: string; subject: string; body: string } | { type: "doc"; title: string; body: string };
  remembered: string[];
}

const RUN_SYSTEM =
  `You execute ONE task for the user. You can actively LOOK THROUGH their world with tools: search_gmail ` +
  `(all mail), read_email, search_drive (their whole Drive), read_doc. USE them to gather the real facts — ` +
  `do NOT ask the user for information you could find. Be rigorously honest and grounded; never invent ` +
  `specifics. Lean toward DOING the reversible preparation. When done, call "submit" with: a one-paragraph ` +
  `context, a synthesis of what you actually did, and a "residual" list of acts ONLY the user can do (a ` +
  `decision, hitting send, a payment, something physical) — empty if none. In submit you may prepare ONE ` +
  `reversible artifact: a Gmail DRAFT (never sent) or a Google DOC. Never claim an action you didn't take. ` +
  `Use "remember" for a genuinely durable fact about the user worth keeping for next time.`;

const RUN_TOOLS: Anthropic.Tool[] = [
  { name: "search_gmail", description: "Search ALL the user's Gmail with a Gmail query (e.g. 'from:sarah invoice', 'newer_than:14d budget').", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "read_email", description: "Read the full body of one email by id (ids come from search_gmail).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "search_drive", description: "Search the user's Google Drive (docs + files) by name/content.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "read_doc", description: "Read the text of a Drive file/Doc by id (ids come from search_drive).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "remember", description: "Save a durable fact about the user worth keeping for future tasks (a preference, a key person, an ongoing project).", input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    context: { type: "string", description: "one grounded paragraph on what this is about" },
    synthesis: { type: "string", description: "what you actually DID this run" },
    residual: { type: "array", items: { type: "string" }, description: "acts only the user can do; [] if none" },
    prepared: { type: "object", description: "optional reversible artifact: {type:'draft',to?,subject,body} or {type:'doc',title,body}" },
  }, required: ["context", "synthesis", "residual"] } },
];

/**
 * Run a task as a bounded tool-using agent: it searches Gmail + Drive + Docs for the real facts, prepares
 * one reversible artifact (draft/doc), and submits a context + synthesis + residual. Returns any durable
 * facts it chose to remember.
 */
export async function runTask(task: { title: string; why: string }, ctx: Context, tokens: Credentials, memory: string[] = []): Promise<RunOutput> {
  const client = clientOrThrow();
  const remembered: string[] = [];
  const inbox = ctx.inbox.map((m) => `${m.from} | "${m.subject}" | ${m.snippet}`).join("\n");
  const events = ctx.events.map((e) => `"${e.summary}" @ ${e.start}`).join("; ");
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content:
      `TASK: ${task.title}\nWHY: ${task.why}\n` + memoryBlock(memory) +
      `\nA snapshot to start from (search for more as needed):\nInbox:\n${inbox || "(none)"}\nUpcoming: ${events || "(none)"}\nUser: ${ctx.email || "unknown"}\n\n` +
      `Look through whatever you need, then call submit.`,
  }];

  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 2200, system: RUN_SYSTEM, tools: RUN_TOOLS, messages });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const out = firstJson<RunOutput>(text);
      return finalize(out, text, remembered);
    }
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let submitted: RunOutput | null = null;
    for (const tu of toolUses) {
      const input = tu.input as any;
      let content = "ok";
      try {
        if (tu.name === "search_gmail") content = JSON.stringify(await searchGmail(tokens, String(input.query || ""), 8));
        else if (tu.name === "read_email") content = JSON.stringify(await readEmail(tokens, String(input.id)));
        else if (tu.name === "search_drive") content = JSON.stringify(await searchDrive(tokens, String(input.query || ""), 10));
        else if (tu.name === "read_doc") content = JSON.stringify(await readDoc(tokens, String(input.id)));
        else if (tu.name === "remember") { const f = String(input.fact || "").trim(); if (f) remembered.push(f); content = "saved"; }
        else if (tu.name === "submit") { submitted = finalize(input as RunOutput, "", remembered); content = "submitted"; }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    if (submitted) return submitted;
    messages.push({ role: "user", content: results });
  }
  return { context: "", synthesis: "I gathered context but ran out of steps before finishing — try Run again.", residual: [], remembered };
}

function finalize(out: Partial<RunOutput> | null, fallbackText: string, remembered: string[]): RunOutput {
  return {
    context: String(out?.context || "").slice(0, 700),
    synthesis: String(out?.synthesis || fallbackText || "Done.").slice(0, 900),
    residual: Array.isArray(out?.residual) ? out!.residual!.map((r) => String(r).trim()).filter(Boolean).slice(0, 6) : [],
    prepared: out?.prepared,
    remembered,
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
