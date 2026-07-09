import OpenAI from "openai";
import type { Profile } from "../shared/types.ts";

/**
 * Backend chat: runs on DeepSeek and can SEARCH THE WEB via a local DuckDuckGo-backed tool.
 * The assistant is grounded in WHO THE USER IS (their profile/preferences) and their current to-dos.
 */

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const ACTUAL_MODEL = MODEL === "deepseek-reasoner" ? "deepseek-chat" : MODEL;

async function retryRequest<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const isNetworkError = e?.code === "ENOTFOUND" || e?.message?.includes("fetch failed") || e?.message?.includes("socket hang up") || e?.status === 502 || e?.status === 503 || e?.status === 504 || e?.status === 429;
      if (!isNetworkError || i === retries - 1) throw e;
      console.warn(`[ai-chat] request failed (${e?.message || e}), retrying in ${delayMs}ms... (attempt ${i + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  throw lastErr;
}

export interface ChatTurn { role: "user" | "assistant"; content: string; }
export interface ChatSource { title: string; url: string; }
/** Structurally identical to claude.ts's ProfileUpdate (defined here too because claude.ts imports this module). */
export interface ChatProfileUpdate { category: "name" | "about" | "preference" | "person" | "project"; fact: string; }
export interface ChatResult { reply: string; sources: ChatSource[]; via: "deepseek+web" | "deepseek+duckduckgo"; profileUpdates: ChatProfileUpdate[]; }

/** The same "remember" tool the task agents have — chat is often where users volunteer who they are
 *  ("my cofounder is Alex", "I hate morning meetings"), so it must learn too. */
const REMEMBER_TOOL = {
  type: "function" as const,
  function: {
    name: "remember",
    description: "Save a durable fact about WHO THIS PERSON IS for future tasks and chats — a preference, a key person/relationship, an ongoing project, their name, or a one-line about. Save NEW facts and CORRECTED versions of outdated profile lines (a corrected fact replaces the old one). Be selective; not for one-off chat details.",
    parameters: { type: "object", properties: {
      category: { type: "string", enum: ["name", "about", "preference", "person", "project"] },
      fact: { type: "string", description: "one short sentence" },
    }, required: ["category", "fact"] },
  },
};
function collectRemember(input: any, out: ChatProfileUpdate[]): string {
  const fact = String(input?.fact || "").trim().slice(0, 200);
  const category = ["name", "about", "preference", "person", "project"].includes(input?.category) ? input.category : "preference";
  if (fact && out.length < 6) { out.push({ category, fact }); return "saved"; }
  return "skipped";
}

function clientOrThrow(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY.");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}

/** Render the person-profile + live to-dos so the chat is personalized and grounded. */
function contextBlock(profile?: Profile, tasksSummary?: string): string {
  const parts: string[] = [];
  if (profile?.about) parts.push(`About them: ${profile.about}`);
  if (profile?.preferences?.length) parts.push(`Preferences: ${profile.preferences.join("; ")}`);
  if (profile?.people?.length) parts.push(`Key people: ${profile.people.join("; ")}`);
  if (profile?.projects?.length) parts.push(`Ongoing projects: ${profile.projects.join("; ")}`);
  let out = parts.length ? `\nWHO YOU'RE TALKING TO (use to personalize; match their style):\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
  if (tasksSummary?.trim()) out += `\nTHEIR CURRENT TO-DOS:\n${tasksSummary.trim()}\n`;
  return out;
}

const SYSTEM = (profile?: Profile, tasksSummary?: string) =>
  `You are Otto's assistant — a sharp, concise, friendly chat assistant. You can SEARCH THE WEB for current ` +
  `or factual information; do so whenever the answer depends on recent events, current facts, prices, or anything ` +
  `you're not sure of, and CITE your sources. You know who the user is and what's on their plate (below) — use it ` +
  `to personalize answers and connect things to their world. When they mention a durable fact about themselves ` +
  `(a preference, a key person, a project, their name) or correct something in their profile, call "remember" to ` +
  `save it — silently, don't announce it. Be direct and genuinely useful; no filler.\n` +
  contextBlock(profile, tasksSummary);

const dropMd = (s: string) => s.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();

const toApi = (messages: ChatTurn[]) =>
  messages.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content }));

/** DeepSeek with a custom web_search tool that we execute locally. */
async function deepseekChat(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  const client = clientOrThrow();
  const sources: ChatSource[] = [];
  const profileUpdates: ChatProfileUpdate[] = [];
  const convo: any[] = toApi(messages);
  const tool = {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for current or background facts you cannot get from the chat history.",
      parameters: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] },
    },
  };
  for (let i = 0; i < 5; i++) {
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: ACTUAL_MODEL,
      max_tokens: 2200,
      messages: [{ role: "system", content: SYSTEM(profile, tasksSummary) }, ...convo],
      tools: [tool, REMEMBER_TOOL],
    }));
    const msg = res.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls || [];
    if (!toolCalls.length) {
      const reply = String(msg?.content || "").trim();
      return { reply: dropMd(reply) || "(no answer)", sources: dedupe(sources), via: "deepseek+web", profileUpdates };
    }
    convo.push({ role: "assistant", content: msg?.content || "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      const args = JSON.parse(String(call.function?.arguments || "{}") || "{}");
      if (call.function?.name === "remember") {
        convo.push({ role: "tool", tool_call_id: call.id, content: collectRemember(args, profileUpdates) });
        continue;
      }
      const hits = await duckDuckGo(String(args?.query || "")).catch(() => []);
      for (const h of hits) sources.push({ title: h.title, url: h.url });
      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(hits.slice(0, 6)) });
    }
  }
  return { reply: "I searched but couldn't pull it together — try rephrasing.", sources: dedupe(sources), via: "deepseek+duckduckgo", profileUpdates };
}

export async function chat(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  try {
    return await deepseekChat(messages, profile, tasksSummary);
  } catch (e: any) {
    console.warn("[chat] deepseek chat failed, falling back to DuckDuckGo:", e?.message || e);
    return await deepseekDuckDuckGo(messages, profile, tasksSummary);
  }
}

/** Web search for the task agents (generate/run) to pull in external context. */
export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!query.trim()) return [];
  return duckDuckGo(query).catch(() => []);
}

/** DeepSeek chat with a local DuckDuckGo tool, used as a fallback path too. */
async function deepseekDuckDuckGo(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  const client = clientOrThrow();
  const sources: ChatSource[] = [];
  const profileUpdates: ChatProfileUpdate[] = [];
  const convo: any[] = toApi(messages);
  const tool = {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web (DuckDuckGo) for current/factual info.",
      parameters: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] },
    },
  };
  for (let i = 0; i < 5; i++) {
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: ACTUAL_MODEL,
      max_tokens: 2200,
      messages: [{ role: "system", content: SYSTEM(profile, tasksSummary) }, ...convo],
      tools: [tool, REMEMBER_TOOL],
    }));
    const msg = res.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls || [];
    if (!toolCalls.length) {
      const reply = String(msg?.content || "").trim();
      return { reply: dropMd(reply) || "(no answer)", sources: dedupe(sources), via: "deepseek+duckduckgo", profileUpdates };
    }
    convo.push({ role: "assistant", content: msg?.content || "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      const args = JSON.parse(String(call.function?.arguments || "{}") || "{}");
      if (call.function?.name === "remember") {
        convo.push({ role: "tool", tool_call_id: call.id, content: collectRemember(args, profileUpdates) });
        continue;
      }
      const hits = await duckDuckGo(String(args?.query || "")).catch(() => []);
      for (const h of hits) sources.push({ title: h.title, url: h.url });
      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(hits.slice(0, 6)) });
    }
  }
  return { reply: "I searched but couldn't pull it together — try rephrasing.", sources: dedupe(sources), via: "deepseek+duckduckgo", profileUpdates };
}

function dedupe(s: ChatSource[]): ChatSource[] {
  const seen = new Set<string>(); const out: ChatSource[] = [];
  for (const x of s) { if (x.url && !seen.has(x.url)) { seen.add(x.url); out.push(x); } }
  return out.slice(0, 8);
}

/** Best-effort DuckDuckGo HTML search → [{title,url,snippet}]. No API key needed. */
async function duckDuckGo(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!query.trim()) return [];
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const out: { title: string; url: string; snippet: string }[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snipRe.exec(html))) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < 8) {
    const url = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (url && title) out.push({ title, url, snippet: snippets[i] || "" });
    i++;
  }
  return out;
}

const stripTags = (s: string) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();
function decodeDdgUrl(href: string): string {
  // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded real url>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}
