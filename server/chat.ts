import Anthropic from "@anthropic-ai/sdk";
import type { Profile } from "../shared/types.ts";

/**
 * Backend chat: runs on the Claude API and can SEARCH THE WEB. Primary path uses Claude's hosted web_search
 * server tool (Anthropic runs the search). If that's unavailable (web search not enabled on the key, or an
 * API error), it FALLS BACK to DuckDuckGo — a custom web_search tool we execute ourselves. Either way the
 * chat is grounded in WHO THE USER IS (their profile/preferences) and their current to-dos.
 */

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

export interface ChatTurn { role: "user" | "assistant"; content: string; }
export interface ChatSource { title: string; url: string; }
export interface ChatResult { reply: string; sources: ChatSource[]; via: "claude+web" | "claude+duckduckgo"; }

function clientOrThrow(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY.");
  return new Anthropic({ apiKey });
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
  `to personalize answers and connect things to their world. Be direct and genuinely useful; no filler.\n` +
  contextBlock(profile, tasksSummary);

const dropMd = (s: string) => s.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();

const toApi = (messages: ChatTurn[]): Anthropic.MessageParam[] =>
  messages.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content }));

/** Primary: Claude with the hosted web_search server tool (Anthropic runs the search). */
async function claudeHosted(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  const client = clientOrThrow();
  const sources: ChatSource[] = [];
  const convo = toApi(messages);
  // Server tools can pause (pause_turn) if they hit the internal iteration cap — re-send to continue.
  for (let i = 0; i < 4; i++) {
    const res: any = await client.messages.create({
      model: MODEL, max_tokens: 2200, system: SYSTEM(profile, tasksSummary),
      tools: [{ type: "web_search_20250305", name: "web_search" } as any],
      messages: convo,
    } as any);
    for (const b of res.content || []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r?.url) sources.push({ title: String(r.title || r.url).slice(0, 120), url: String(r.url) });
      }
    }
    if (res.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: res.content }); continue; }
    const reply = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    return { reply: dropMd(reply) || "(no answer)", sources: dedupe(sources), via: "claude+web" };
  }
  throw new Error("web search did not converge");
}

/** Fallback: Claude with a CUSTOM web_search tool we execute via DuckDuckGo. */
async function claudeDuckDuckGo(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  const client = clientOrThrow();
  const sources: ChatSource[] = [];
  const convo = toApi(messages);
  const tool: Anthropic.Tool = {
    name: "web_search",
    description: "Search the web (DuckDuckGo) for current/factual info. Returns top results with title, url, snippet. Use when the answer depends on recent or external facts.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] },
  };
  for (let i = 0; i < 5; i++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 2200, system: SYSTEM(profile, tasksSummary), tools: [tool], messages: convo });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      const reply = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
      return { reply: dropMd(reply) || "(no answer)", sources: dedupe(sources), via: "claude+duckduckgo" };
    }
    convo.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let content = "[]";
      if (tu.name === "web_search") {
        const hits = await duckDuckGo(String((tu.input as any)?.query || "")).catch(() => []);
        for (const h of hits) sources.push({ title: h.title, url: h.url });
        content = JSON.stringify(hits.slice(0, 6));
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    convo.push({ role: "user", content: results });
  }
  return { reply: "I searched but couldn't pull it together — try rephrasing.", sources: dedupe(sources), via: "claude+duckduckgo" };
}

export async function chat(messages: ChatTurn[], profile?: Profile, tasksSummary?: string): Promise<ChatResult> {
  try {
    return await claudeHosted(messages, profile, tasksSummary);
  } catch (e: any) {
    console.warn("[chat] hosted web_search failed, falling back to DuckDuckGo:", e?.message || e);
    return await claudeDuckDuckGo(messages, profile, tasksSummary);
  }
}

/** Web search for the task agents (generate/run) to pull in external context — PRIMARY is Claude's hosted
 *  web_search (Anthropic runs the search), FALLBACK is DuckDuckGo. Always returns sources as {title,url,snippet};
 *  returns [] only on total failure so a flaky search never breaks task planning/execution. */
export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!query.trim()) return [];
  try {
    const hosted = await webSearchClaude(query);
    if (hosted.length) return hosted;
  } catch (e: any) {
    console.warn("[web] hosted web_search failed, falling back to DuckDuckGo:", e?.message || e);
  }
  return duckDuckGo(query).catch(() => []);
}

/** Run Claude's hosted web_search and have it hand back the top results as JSON {title,url,snippet}. */
async function webSearchClaude(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const client = clientOrThrow();
  const found = new Map<string, { title: string; url: string; snippet: string }>(); // raw search sources (url→title), a backstop
  const convo: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Search the web for: ${query}\n\nThen reply with ONLY a JSON array (no prose, no code fence) of the up-to-6 most relevant results, each {"title","url","snippet"} where "snippet" is a one-sentence summary of that page. If nothing relevant, reply [].`,
  }];
  // The hosted tool can pause_turn at its internal cap — re-send to continue.
  for (let i = 0; i < 4; i++) {
    const res: any = await client.messages.create({
      model: MODEL, max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" } as any],
      messages: convo,
    } as any);
    for (const b of res.content || []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r?.url && !found.has(String(r.url))) found.set(String(r.url), { title: String(r.title || r.url).slice(0, 160), url: String(r.url), snippet: "" });
      }
    }
    if (res.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: res.content }); continue; }
    const text = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const parsed = parseResultArray(text);
    if (parsed.length) return parsed.slice(0, 6);
    if (found.size) return [...found.values()].slice(0, 6); // model gave no JSON but we have the raw sources
    return [];
  }
  return [...found.values()].slice(0, 6);
}

function parseResultArray(text: string): { title: string; url: string; snippet: string }[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x: any) => ({ title: String(x?.title || x?.url || "").slice(0, 160), url: String(x?.url || "").trim(), snippet: String(x?.snippet || "").slice(0, 300) }))
      .filter((x) => /^https?:\/\//i.test(x.url));
  } catch { return []; }
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
