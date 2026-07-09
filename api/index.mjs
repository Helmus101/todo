// server/env.ts
import dotenv from "dotenv";
dotenv.config();

// server/index.ts
import express from "express";
import session2 from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// shared/types.ts
function emptyProfile() {
  return { about: "", preferences: [], people: [], projects: [] };
}
function normalizeProfile(p) {
  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  return {
    name: typeof p?.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : void 0,
    about: typeof p?.about === "string" ? p.about : "",
    // Dedupe each list so reworded facts about the SAME person/project don't pile up (self-heals on every load).
    preferences: dedupeFacts(arr(p?.preferences)),
    people: dedupeFacts(arr(p?.people)),
    projects: dedupeFacts(arr(p?.projects))
  };
}
var FACT_STOP = /* @__PURE__ */ new Set(["the", "and", "for", "with", "from", "that", "this", "they", "their", "them", "she", "her", "his", "him", "who", "handles", "handled", "leads", "are", "was", "were", "has", "have", "will", "its", "willem", "also", "both"]);
var emailsIn = (s) => s.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
var normFact = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function factTokens(s) {
  const words = normFact(s).split(" ").filter((w) => w.length > 2 && !FACT_STOP.has(w));
  return /* @__PURE__ */ new Set([...emailsIn(s), ...words]);
}
function sameFact(a, b) {
  const ea = emailsIn(a), eb = emailsIn(b);
  if (ea.length && eb.length && ea.some((e) => eb.includes(e))) return true;
  const pa = normFact(a).slice(0, 42), pb = normFact(b).slice(0, 42);
  if (pa.length >= 24 && pa === pb) return true;
  const A = factTokens(a), B = factTokens(b);
  if (A.size < 3 || B.size < 3) return normFact(a) === normFact(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return jaccard >= 0.5 || inter >= 6 && containment >= 0.6;
}
function dedupeFacts(list) {
  const out = [];
  for (const raw of list) {
    const fact = String(raw || "").trim();
    if (!fact) continue;
    const i = out.findIndex((x) => sameFact(x, fact));
    if (i === -1) out.push(fact);
    else if (fact.length > out[i].length) out[i] = fact;
  }
  return out.slice(0, 40);
}

// server/claude.ts
import OpenAI2 from "openai";

// server/chat.ts
import OpenAI from "openai";
var MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
var ACTUAL_MODEL = MODEL === "deepseek-reasoner" ? "deepseek-chat" : MODEL;
async function retryRequest(fn, retries = 3, delayMs = 1e3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
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
var REMEMBER_TOOL = {
  type: "function",
  function: {
    name: "remember",
    description: "Save a durable fact about WHO THIS PERSON IS for future tasks and chats \u2014 a preference, a key person/relationship, an ongoing project, their name, or a one-line about. Save NEW facts and CORRECTED versions of outdated profile lines (a corrected fact replaces the old one). Be selective; not for one-off chat details.",
    parameters: { type: "object", properties: {
      category: { type: "string", enum: ["name", "about", "preference", "person", "project"] },
      fact: { type: "string", description: "one short sentence" }
    }, required: ["category", "fact"] }
  }
};
function collectRemember(input, out) {
  const fact = String(input?.fact || "").trim().slice(0, 200);
  const category = ["name", "about", "preference", "person", "project"].includes(input?.category) ? input.category : "preference";
  if (fact && out.length < 6) {
    out.push({ category, fact });
    return "saved";
  }
  return "skipped";
}
function clientOrThrow() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY.");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}
function contextBlock(profile, tasksSummary) {
  const parts = [];
  if (profile?.about) parts.push(`About them: ${profile.about}`);
  if (profile?.preferences?.length) parts.push(`Preferences: ${profile.preferences.join("; ")}`);
  if (profile?.people?.length) parts.push(`Key people: ${profile.people.join("; ")}`);
  if (profile?.projects?.length) parts.push(`Ongoing projects: ${profile.projects.join("; ")}`);
  let out = parts.length ? `
WHO YOU'RE TALKING TO (use to personalize; match their style):
${parts.map((x) => `- ${x}`).join("\n")}
` : "";
  if (tasksSummary?.trim()) out += `
THEIR CURRENT TO-DOS:
${tasksSummary.trim()}
`;
  return out;
}
var SYSTEM = (profile, tasksSummary) => `You are Otto's assistant \u2014 a sharp, concise, friendly chat assistant. You can SEARCH THE WEB for current or factual information; do so whenever the answer depends on recent events, current facts, prices, or anything you're not sure of, and CITE your sources. You know who the user is and what's on their plate (below) \u2014 use it to personalize answers and connect things to their world. When they mention a durable fact about themselves (a preference, a key person, a project, their name) or correct something in their profile, call "remember" to save it \u2014 silently, don't announce it. Be direct and genuinely useful; no filler.
` + contextBlock(profile, tasksSummary);
var dropMd = (s) => s.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();
var toApi = (messages) => messages.filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content }));
async function deepseekChat(messages, profile, tasksSummary) {
  const client2 = clientOrThrow();
  const sources = [];
  const profileUpdates = [];
  const convo = toApi(messages);
  const tool = {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current or background facts you cannot get from the chat history.",
      parameters: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] }
    }
  };
  for (let i = 0; i < 5; i++) {
    const res = await retryRequest(() => client2.chat.completions.create({
      model: ACTUAL_MODEL,
      max_tokens: 2200,
      messages: [{ role: "system", content: SYSTEM(profile, tasksSummary) }, ...convo],
      tools: [tool, REMEMBER_TOOL]
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
  return { reply: "I searched but couldn't pull it together \u2014 try rephrasing.", sources: dedupe(sources), via: "deepseek+duckduckgo", profileUpdates };
}
async function chat(messages, profile, tasksSummary) {
  try {
    return await deepseekChat(messages, profile, tasksSummary);
  } catch (e) {
    console.warn("[chat] deepseek chat failed, falling back to DuckDuckGo:", e?.message || e);
    return await deepseekDuckDuckGo(messages, profile, tasksSummary);
  }
}
async function webSearch(query) {
  if (!query.trim()) return [];
  return duckDuckGo(query).catch(() => []);
}
async function deepseekDuckDuckGo(messages, profile, tasksSummary) {
  const client2 = clientOrThrow();
  const sources = [];
  const profileUpdates = [];
  const convo = toApi(messages);
  const tool = {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web (DuckDuckGo) for current/factual info.",
      parameters: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] }
    }
  };
  for (let i = 0; i < 5; i++) {
    const res = await retryRequest(() => client2.chat.completions.create({
      model: ACTUAL_MODEL,
      max_tokens: 2200,
      messages: [{ role: "system", content: SYSTEM(profile, tasksSummary) }, ...convo],
      tools: [tool, REMEMBER_TOOL]
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
  return { reply: "I searched but couldn't pull it together \u2014 try rephrasing.", sources: dedupe(sources), via: "deepseek+duckduckgo", profileUpdates };
}
function dedupe(s) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const x of s) {
    if (x.url && !seen.has(x.url)) {
      seen.add(x.url);
      out.push(x);
    }
  }
  return out.slice(0, 8);
}
async function duckDuckGo(query) {
  if (!query.trim()) return [];
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const out = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let m;
  while (m = snipRe.exec(html)) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < 8) {
    const url2 = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (url2 && title) out.push({ title, url: url2, snippet: snippets[i] || "" });
    i++;
  }
  return out;
}
var stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function decodeDdgUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

// server/claude.ts
function profileBlock(p) {
  if (!p) return "";
  const recent = (l) => (l || []).slice(-12);
  const parts = [];
  if (p.name) parts.push(`Their name: ${p.name}`);
  if (p.about) parts.push(`About them: ${p.about}`);
  if (recent(p.preferences).length) parts.push(`Preferences: ${recent(p.preferences).join("; ")}`);
  if (recent(p.people).length) parts.push(`Key people: ${recent(p.people).join("; ")}`);
  if (recent(p.projects).length) parts.push(`Ongoing projects: ${recent(p.projects).join("; ")}`);
  return parts.length ? `
WHO THIS PERSON IS \u2014 their stated preferences are INSTRUCTIONS to follow (what to include, skip, prioritize, and how to phrase/do things), not background:
${parts.map((x) => `- ${x}`).join("\n")}
` : "";
}
function nowBlock() {
  const d = /* @__PURE__ */ new Date();
  const date = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
  }
  return `CURRENT DATE & TIME: ${date}, ${time}${tz ? ` (${tz})` : ""}. Reason about "today", "tomorrow", deadlines, scheduling and date conflicts relative to THIS. If you need a date/fact you're unsure of (a public deadline, a format, current info), use web_search rather than guess.
`;
}
function deadlineBlock(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = raw.match(/\b(before|by|until|due)\b\s*[:\-]?\s*([^\n]+)/i);
  if (!match) return "";
  const snippet = match[0];
  const yearMatch = snippet.match(/\b(20\d{2})\b/);
  const monthDayMatch = snippet.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const year = yearMatch ? Number(yearMatch[1]) : (/* @__PURE__ */ new Date()).getFullYear();
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mo = months[monthDayMatch[1].slice(0, 3).toLowerCase()];
    const dy = Number(monthDayMatch[2]);
    if (mo !== void 0) {
      const deadline = new Date(year, mo, dy);
      if (deadline < /* @__PURE__ */ new Date()) return "";
    }
  }
  return `EXPLICIT DEADLINE PHRASE FROM THE TASK: "${snippet}". Treat that deadline/date as exact and preserve it unless the source data clearly contradicts it.
`;
}
var DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
function aiReady() {
  return !!process.env.DEEPSEEK_API_KEY;
}
function deepseekClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY in web/.env.");
  return new OpenAI2({
    apiKey,
    baseURL: "https://api.deepseek.com"
  });
}
async function retryRequest2(fn, retries = 3, delayMs = 1e3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
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
function firstJson(raw) {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
var TRIM_KEEP = 6;
var TRIM_TO = 500;
function trimOldToolResults(messages) {
  if (messages.length <= TRIM_KEEP) return messages;
  const cut = messages.length - TRIM_KEEP;
  return messages.map((m, i) => i < cut && m.role === "tool" && typeof m.content === "string" && m.content.length > TRIM_TO ? { ...m, content: m.content.slice(0, TRIM_TO) + "\n\u2026[older result truncated]" } : m);
}
function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const repaired = firstJson(text);
    return repaired && typeof repaired === "object" ? repaired : {};
  }
}
var GEN_SYSTEM = `You are a sharp chief-of-staff turning someone's live world into their real, COMPLETE to-do list. Use EVERY tool available \u2014 across ALL their connected apps, not just email \u2014 to READ what genuinely needs them right now, then call submit_tasks. Sweep each connected source for actionable items, e.g.:
- Gmail: threads awaiting a reply or asking something (skip newsletters/promos/receipts/no-reply).
- Calendar: meetings in the next ~48h to prepare for or respond to.
- Slack / Discord: DMs & mentions awaiting your reply.
- GitHub / Linear / Jira: issues & PRs assigned to you, review requests, things blocking others.
- Notion / Todoist / Asana / Trello / ClickUp: tasks assigned or due soon.
- Any other connected app: whatever is genuinely waiting on this person.
- COMMITMENTS THEY MADE: also check their recently SENT mail/messages (e.g. Gmail search "in:sent newer_than:7d") for promises THEY made to others \u2014 "I'll send you X", "I'll get back to you by Friday", "let me check and follow up" \u2014 and create a task to FULFILL each one that looks unfulfilled (no later reply/attachment in the thread). Title it as the commitment ("Send Sarah the budget deck"), set "when" from the promised deadline, and anchor it to the sent thread ('gmail:<threadId>'). A broken promise is worse than a missed email.
Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a sender is, a public deadline).
GMAIL \u2014 SEARCH IT SEVERAL WAYS, not one generic fetch: (1) recent inbox needing action ("in:inbox newer_than:7d -category:promotions -category:social"), (2) unread ("is:unread in:inbox"), (3) their SENT mail for open loops ("in:sent newer_than:10d") \u2014 read what THEY promised and check whether they delivered, and (4) threads where someone asked them something and the last message is NOT theirs (they owe a reply).
USE THEIR PROFILE AS SEARCH LEADS: pick the 2-3 most active projects/people listed below and run ONE targeted search each (the name in Gmail or the relevant app) to find loose ends \u2014 an unanswered thread, an upcoming deadline, a doc waiting on them. What did they say they'd do but haven't?
PREFERENCES ARE BINDING, not decoration \u2014 the "Preferences" lines in their profile MUST shape the list:
- FILTER: if a preference says they don't care about something (a topic, a sender, a kind of work), do NOT create tasks for it, even if it looks actionable.
- RANK: raise importance for tasks matching what they've said matters (their priorities, projects, people); lower it for what they've deprioritized. Two equal emails \u2260 two equal tasks if a preference separates them.
- SHAPE: phrase titles/whys in line with how they work (e.g. "batch admin on Fridays" \u2192 set "when" accordingly; "prefers calls over email" \u2192 the task suggests a call). When a preference influenced a task, reflect it in "why".
NEVER resurface a to-do the user already finished or DISMISSED \u2014 if an "ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ONE TASK PER UNDERLYING ITEM: never submit two wordings of the same to-do \u2014 one thread/event/commitment = ONE task, with its stable anchorKey. If two findings point at the same obligation, merge them into one task.
READ ONLY here \u2014 do NOT create, modify, draft, or send anything during generation. BUDGET: you have roughly 7-8 tool calls TOTAL \u2014 batch your Gmail searches into ONE round (issue them as parallel calls), give each other app ONE targeted read, never re-read the same source, and submit as soon as you have the picture. Thorough \u2260 exhaustive.`;
var SUBMIT_TASKS_TOOL = {
  name: "submit_tasks",
  description: "Submit the full actionable to-do list you found.",
  input_schema: { type: "object", properties: {
    tasks: { type: "array", description: "one per actionable thread/event", items: { type: "object", properties: {
      title: { type: "string", description: "short imperative, <= 9 words" },
      why: { type: "string", description: "one grounded clause naming the concrete trigger" },
      when: { type: "string", description: "concise timeline/deadline grounded in the data (e.g. 'today', 'by Fri 5pm') or '' " },
      source: { type: "string", description: "the connected app this is from, as a lowercase slug: gmail, calendar, slack, github, notion, linear, todoist, \u2026" },
      risk: { type: "string", enum: ["low", "high"], description: "'high' if completing it means sending/inviting (irreversible)" },
      urgency: { type: "number", description: "0..1 time pressure" },
      importance: { type: "number", description: "0..1 stakes" },
      anchorKey: { type: "string", description: "ALWAYS set this \u2014 the item's STABLE id EXACTLY as the tool returned it, prefixed by app: 'gmail:<threadId>', 'calendar:<eventId>', etc. Use the SAME value every run so the task is never duplicated." },
      link: { type: "string", description: "a URL to open the source item, if you have one" }
    }, required: ["title", "why", "source", "urgency", "importance"] } },
    profileUpdates: { type: "array", description: "0-4 durable facts about WHO THIS PERSON IS that you discovered while sweeping (their role, a key relationship, an ongoing project, a work preference) \u2014 including a CORRECTED/updated version of a profile line above that's now outdated. Not task content; only lasting identity facts.", items: { type: "object", properties: {
      category: { type: "string", enum: ["name", "about", "preference", "person", "project"] },
      fact: { type: "string", description: "one short sentence" }
    }, required: ["category", "fact"] } }
  }, required: ["tasks"] }
};
function parseProfileUpdates(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((u) => ({
    category: ["name", "about", "preference", "person", "project"].includes(u?.category) ? u.category : "preference",
    fact: String(u?.fact || "").trim().slice(0, 200)
  })).filter((u) => u.fact).slice(0, 4);
}
var WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the web for current or background facts you can't get from the connected apps \u2014 a person/company, a deadline or figure, how to do something, a reference link. Returns top results (title, url, snippet).",
  input_schema: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] }
};
async function runWebSearch(input) {
  const q = String(input?.query || "").trim();
  if (!q) return "[]";
  return JSON.stringify((await webSearch(q)).slice(0, 6));
}
var SELF_BRIEF_TOOL = {
  name: "send_self_brief",
  description: "Email a brief TO THE USER'S OWN INBOX (the server addresses it to them \u2014 you cannot pick a recipient). Use when something upcoming needs prep they should see WITHOUT opening this app: a meeting/event in the next ~48h (send who/when/where or link, agenda, 2-4 prep points, doc links) or day-of logistics. Plain text, tight, scannable. NEVER a way to message anyone else; at most one per task.",
  input_schema: { type: "object", properties: {
    subject: { type: "string", description: "short subject, e.g. 'Brief: Q3 review with Sarah \u2014 Thu 2pm'" },
    body: { type: "string", description: "the brief \u2014 plain text, short lines/bullets, all specifics included" }
  }, required: ["subject", "body"] }
};
function parseGenerated(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => t && typeof t.title === "string" && t.title.trim().length >= 4 && String(t.why || "").trim()).map((t) => ({
    title: String(t.title).slice(0, 90),
    why: String(t.why || "").slice(0, 400),
    when: t.when ? String(t.when).slice(0, 40) : void 0,
    source: typeof t.source === "string" && t.source.trim() ? t.source.trim().toLowerCase().slice(0, 24) : "gmail",
    risk: t.risk === "high" ? "high" : "low",
    urgency: clamp01(t.urgency ?? 0.5),
    importance: clamp01(t.importance ?? 0.6),
    anchorKey: t.anchorKey ? String(t.anchorKey).trim().slice(0, 120) : void 0,
    link: t.link && /^https?:\/\//i.test(String(t.link)) ? String(t.link) : void 0
  })).slice(0, 30);
}
async function generateTasks(profile, extras, handled) {
  const empty = { tasks: [], profileUpdates: [] };
  if (!extras?.tools?.length) return empty;
  const tools = [...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.` : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length ? `
ALREADY HANDLED \u2014 I already finished or dismissed these; do NOT create a task for any of them again, even if its source email/event is still around:
` + handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `
` : "";
  const messages = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + handledBlock + `
${connectedLine}
Sweep across all of them for everything genuinely awaiting me \u2014 including what I promised others and haven't done yet (check my sent mail), and loose ends on my projects/people above \u2014 then call submit_tasks with my full actionable to-do list. Respect my stated preferences above when choosing, ranking, and phrasing tasks.`
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  const MAX = 9;
  let tokIn = 0, tokOut = 0, rounds = 0;
  try {
    for (let i = 0; i < MAX; i++) {
      const client2 = deepseekClient();
      const lastRoundHint = i === MAX - 1 ? "You must call submit_tasks now with the full actionable list. Do not answer with prose." : "";
      const base = trimOldToolResults(messages);
      const apiMessages = lastRoundHint ? [...base, { role: "user", content: lastRoundHint }] : base;
      const res = await retryRequest2(() => client2.chat.completions.create({
        model: actualModel,
        max_tokens: 4e3,
        messages: [
          { role: "system", content: GEN_SYSTEM },
          ...apiMessages
        ],
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      }));
      rounds++;
      tokIn += res.usage?.prompt_tokens || 0;
      tokOut += res.usage?.completion_tokens || 0;
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
      let submitted = null;
      for (const tu of toolUses) {
        const input = parseToolArgs(tu.function?.arguments);
        const toolName = tu.function?.name;
        let content = "ok";
        try {
          if (toolName === "submit_tasks") {
            submitted = { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
            content = "submitted";
          } else if (toolName === "web_search") {
            content = await runWebSearch(input);
          } else {
            const r = await extras.call(toolName, input || {});
            content = r ?? `Unknown tool: ${toolName}`;
          }
        } catch (e) {
          content = "ERROR: " + (e?.message || e);
        }
        messages.push({ role: "tool", tool_call_id: tu.id || `tool_${Date.now()}`, content: String(content).slice(0, 4e3) });
      }
      if (submitted) {
        if (!submitted.tasks.length) console.warn("[claude] generateTasks submitted 0 tasks");
        return submitted;
      }
    }
    try {
      const client2 = deepseekClient();
      const res = await retryRequest2(() => client2.chat.completions.create({
        model: actualModel,
        max_tokens: 4e3,
        messages: [
          { role: "system", content: GEN_SYSTEM },
          ...trimOldToolResults(messages),
          { role: "user", content: "STOP researching. Call submit_tasks NOW with every actionable task you found so far." }
        ],
        tools: [{ type: "function", function: { name: SUBMIT_TASKS_TOOL.name, description: SUBMIT_TASKS_TOOL.description, parameters: SUBMIT_TASKS_TOOL.input_schema } }],
        tool_choice: { type: "function", function: { name: "submit_tasks" } }
      }));
      rounds++;
      tokIn += res.usage?.prompt_tokens || 0;
      tokOut += res.usage?.completion_tokens || 0;
      const tu = res.choices[0]?.message?.tool_calls?.[0];
      if (tu) {
        const input = parseToolArgs(tu.function?.arguments);
        return { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
      }
    } catch (e) {
      console.warn("[claude] forced submit failed:", e?.message || e);
    }
    return empty;
  } finally {
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [ai] generateTasks: ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}
async function refineManualTask(text, profile) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const client2 = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
    const res = await retryRequest2(() => client2.chat.completions.create({
      model,
      max_tokens: 500,
      messages: [
        { role: "system", content: "You turn a person's rough to-do note into one crisp, actionable task. Preserve their intent and any specifics they gave; do NOT invent names, dates, or facts they didn't state. Output STRICT JSON only." },
        { role: "user", content: profileBlock(profile) + `
Rough note: "${raw.slice(0, 300)}"

Return JSON: {"title": short imperative <= 9 words, "why": one concise clause capturing the intent, "when": a deadline for COMPLETING THIS TASK (e.g. "today", "by Fri") \u2014 ONLY if the note explicitly says when the TASK itself must be done (e.g. "by tomorrow", "before June 30"). If the note only mentions dates as background context (e.g. a trip date, event date, year mentioned in passing) leave this "", "urgency": 0..1 time pressure, "importance": 0..1 stakes}. JSON only.` }
      ]
    }));
    const textContent = res.choices[0]?.message?.content || "";
    const out = firstJson(textContent);
    if (!out || typeof out.title !== "string" || !out.title.trim()) return null;
    return {
      title: String(out.title).slice(0, 90),
      why: String(out.why || "").slice(0, 300) || "Added by you.",
      when: out.when ? String(out.when).slice(0, 40) : void 0,
      urgency: clamp01(out.urgency ?? 0.6),
      importance: clamp01(out.importance ?? 0.7)
    };
  } catch {
    return null;
  }
}
var RUN_SYSTEM = `You execute ONE task for the user, end to end, using the tools available \u2014 their CONNECTED apps via Composio (Gmail, Google Calendar, Docs, Slides, Drive, Sheets, and any others: Slack, GitHub, Notion, Linear, Todoist, \u2026). USE them to gather the real facts AND to DO the reversible work: draft a reply, create a doc/deck/sheet, add a task or calendar event, update an issue. Use WHATEVER connected apps the task touches (Slack, Notion, Linear, Sheets, GitHub, \u2026), not just email, and do as MUCH as your tools allow. Do NOT ask the user for anything you could find or do yourself. Be rigorously honest and grounded; never invent specifics.
You can also use web_search for any external fact or context you need (a person, company, deadline, how-to, or a reference link) \u2014 look it up rather than guess.
GOOGLE SHEETS \u2014 YOU MUST ACTUALLY WRITE: if the task involves updating a spreadsheet (e.g. filling in restaurant names, meal ideas, trip data, any cells), you MUST call the Sheets write tools (GOOGLESHEETS_BATCH_UPDATE_VALUES, GOOGLESHEETS_UPDATE_VALUES, GOOGLESHEETS_APPEND_VALUES, etc.) to ACTUALLY write the data into the cells \u2014 do NOT just produce a plan or list in synthesis. Read the sheet first to find the exact cells/ranges that need filling, then call the write tool with real content. Sheet cell writes are FULLY PERMITTED and reversible \u2014 you do NOT need user approval to write cells. Do it now.
GATHER CONTEXT AGGRESSIVELY \u2014 BEFORE you act, search EVERYWHERE for relevant information:
- Search Gmail for related threads (e.g., hotel bookings, flight confirmations, restaurant reservations, addresses, phone numbers)
- Search Calendar for related events (e.g., travel dates, meeting times, deadlines)
- Search Drive for related documents (e.g., itineraries, proposals, notes, spreadsheets with details)
- Check the user's profile memory for known preferences, people, and projects
- Use web_search for external details (addresses, directions, company info)
Example: if the task is "prep to go somewhere from hotel", search Gmail for the hotel booking confirmation to get the hotel name, address, checkout time; search Calendar for departure details; search Drive for any itinerary. NEVER leave placeholders like "[hotel name]" or "[address]" \u2014 find the real details.
HARD LIMIT \u2014 you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not even available to you). For email you ONLY ever leave a DRAFT; for Slack you only COMPOSE the message. You never send/post \u2014 instead OFFER the send as a one-click button via "sendables" (see submit), which the user reviews and fires. Never say you "sent", "emailed", "posted", or "messaged" \u2014 say you DRAFTED/PREPARED it. Never claim an action you didn't take.
THE ONE SEND EXCEPTION \u2014 send_self_brief goes ONLY to the user's own inbox (the server addresses it; you cannot pick a recipient). When the task involves something UPCOMING they must walk into prepared \u2014 a meeting or event in the next ~48h, travel/day-of logistics \u2014 ALSO send them a tight brief (who/when/where or link, agenda, 2-4 prep points, doc links) so it's waiting in their inbox. Mention it in "synthesis" ("\u2026and emailed you a brief"). At most one per task; never for anything that isn't time-sensitive prep.
CALENDAR INVITES: create/update the event freely \u2014 but it lands on the user's calendar SILENTLY, with NO emails to anyone (you cannot notify attendees yourself). If the event SHOULD invite people, do NOT email them; instead add a "sendables" entry {app:"gcal", label, eventId, attendees:[their emails], summary, when} so the user gets a one-click "Send invites" button that SHOWS exactly who will be invited before they confirm. You never send the invite; the user's click does, with the recipient list in plain view.
VOICE \u2014 SOUND LIKE THE USER, NOT AN AI. For a REPLY, the THREAD is the source of truth: FIRST reread the ENTIRE thread you're replying to and mirror ITS conventions \u2014 the register the user (and the other side) already use there, the greeting/sign-off used IN THAT THREAD (often none mid-thread), its typical message length, its formality. Your draft must read as the natural NEXT message of that exact thread. Only when the thread has no messages from the user (or it's a fresh email) fall back to their broader style: READ 2-3 of their OWN sent emails (search "in:sent", ideally to the same recipient) and copy their ACTUAL writing mechanics:
- CAPITALIZATION: if they write in lowercase ("hey, sounds good"), you write in lowercase. If they use proper caps, so do you.
- SENTENCE LENGTH & TOTAL LENGTH: if their emails are 2 short lines, yours are 2 short lines \u2014 never longer than they'd write.
- THEIR WORDS: reuse their habitual greeting ("hey"/"hi"/none), sign-off ("thanks!"/"best"/just their name), filler words, contractions, and punctuation habits (do they use exclamation marks? ellipses? no periods at line ends?).
- FORMALITY: match the register they use with THIS recipient specifically, if you can see prior thread messages.
AVOID AI tells \u2014 no "I hope this email finds you well", "I wanted to reach out", "Please don't hesitate", "Thank you for your understanding", em-dash-heavy corporate phrasing, or stiff over-formality. Nudge a touch more polished only for someone senior or unknown. If you pick up a durable detail of their style (e.g. "writes lowercase, signs off 'cheers'"), "remember" it as a preference so future drafts skip the lookup.
BE SPECIFIC \u2014 INCLUDE THE CONCRETE DETAILS: a draft must contain the real specifics the recipient needs, never vague placeholders. If it's about travel, include the actual FLIGHT TIMES / dates / flight numbers / arrival + departure; if about a meeting, the exact date, time + timezone; if about a place, the address. Pull these from their calendar, the itinerary (Drive/Sheets), the thread, or web_search \u2014 look them up, don't leave "[time]" or omit them. A draft missing the key time/date/number is not finished.
ACT \u2014 DON'T JUST PLAN (most important rule): if something can be done with your tools, DO IT THIS RUN \u2014 call the tool, draft the reply, create the doc, add the event. NEVER return a step that DESCRIBES an action you could take yourself; take it now and report it in "synthesis". The ONLY things that belong in "steps" are ones that genuinely need the USER \u2014 judged by the "OTTO vs YOU" test below. If a tool errors, try another way or say what blocked you \u2014 do not silently downgrade a doable action to a step. A run that hands back a to-do list of things you could have done yourself is a FAILURE.
TWO EXCEPTIONS to "do it yourself": (a) OPENING A PAGE \u2014 you have no browser, so for any task to open / read / skim / review / look at a specific doc, file, or page, FIND its real URL (search Drive, Docs, or the web) and return it as a STEP with "url" set and automatable=true \u2014 the app opens it in the user's browser for them. Never write "open the doc" without the URL, and never claim you opened or read it yourself. (b) NO DUPLICATES \u2014 never create a second copy of something that already exists; if changing an existing event/doc/task would need an update tool you don't have (you only have "create"), do NOT create a near-duplicate \u2014 leave it as a step. A duplicate is worse than no change.
GOOGLE DOCS \u2014 USE SPARINGLY: only create a Google Doc when the task's real deliverable IS a document the user wants (a brief, proposal, notes, agenda, plan). To reply to an email or message, leave an email DRAFT / a composed message \u2014 NEVER write the reply into a Doc. Do NOT create a Doc to "summarize", log, jot, or as a byproduct, and never default to one when unsure (prefer doing nothing doc-wise). NEVER create a DUPLICATE Doc/Sheet/Slides \u2014 this is critical. BEFORE creating one, ALWAYS first (a) reuse any artifact listed under "ALREADY CREATED FOR THIS TASK" above \u2014 open it by its URL and UPDATE it; and (b) search Drive by title (GOOGLEDRIVE_FIND_FILE / search) for an existing doc with the same or similar name and UPDATE that instead. Only create a new doc if NONE exists. Re-running this task must NEVER produce a second copy (the user has seen "5 road-trip packing lists" \u2014 do not repeat that). If you genuinely can't update, leave a step rather than make a near-duplicate. An unwanted or duplicate Doc is worse than none.
When done, call "submit" with "context" + "synthesis" (what you did) and a "steps" list of what is LEFT.
PERMISSION_REQUIRED: If you call a tool (like updating a doc or creating a calendar event) and it returns "PERMISSION_REQUIRED", you CANNOT do it yourself this run. Instead, add it to your "steps" list with automatable=true AND needsPermission=true so the user can explicitly approve it with one click.
WRITE GOOD STEPS \u2014 each step is ONE concrete action: imperative verb + the specific thing, concise (\u2264 ~12 words), no hedging or explanation. Good: "Send the draft reply to Sarah", "Pick the offsite date", "Approve & publish the brief". Bad: vague ("follow up"), bundled ("check email and update the doc and tell the team"), or narrated. Order them; set "dependsOn" to an earlier step's index when one must happen first.
OTTO vs YOU \u2014 classify EVERY step by ONE test: can you do it with your tools or by finding information?
\u2022 YES \u2192 it's OTTO's (automatable=true): reading/searching anything, drafting, creating/updating a doc/sheet/ event/task, ENTERING or filling in data, commenting, research, opening a page. Do it NOW if unblocked; only LIST it (with "dependsOn") when it waits on a user step. Lack a value? FIND it (inbox/Drive/the source), then do it.
\u2022 NO \u2192 it's the USER's (automatable=false), and ONLY for one of: (1) a judgment/decision/approval only they can make; (2) a credential/login/access you don't have; (3) a payment or moving money; (4) a real-world / physical action. Reviewing-then-SENDING a message is NOT a step \u2014 offer it as a one-click send (sendables).
When UNSURE, it's OTTO's \u2014 attempt it. "Tedious", "specific", "numeric", or "I'd have to look it up" are NEVER reasons to hand a step to the user. When a user step unblocks one of yours, say so \u2014 "Pick the date \u2014 I'll then book it".
PREP EVERY USER STEP TO THE MAX (universal rule): a user step must arrive READY-TO-DO, never bare. Attach a "url" that lands them ONE click from done whenever such a link exists or can be constructed \u2014 driving/transit \u2192 a Google Maps directions link (https://www.google.com/maps/dir/?api=1&origin=<from>&destination=<to>), a call \u2192 tel:<number>, a payment/booking/return/check-in \u2192 the exact page for it, a form \u2192 the form itself. Fold the key facts they'd otherwise look up (address, confirmation #, time, phone, amount) into the step text or "context". If no link applies, the step text itself must carry everything needed.
ASK ONLY WHEN TRULY STUCK: if a step is automatable EXCEPT for one detail you could not find or infer (a choice between real options, a preference, a date only they know), keep automatable=true and set "question" \u2014 ONE short, specific question \u2014 plus "options": 2-4 LIKELY answers with your best inference FIRST (they tap one and you run). Search EVERYTHING first (inbox, Drive, calendar, their profile, the web); a question you could have answered yourself is a failure. Prep everything around it so their answer is the only missing piece. Never ask more than 2 questions per task.
BRIEF, DON'T JUST DEFER: even when the final action is the USER's (a decision, or a booking/login/payment you can't do), do ALL the research around it FIRST \u2014 find the real options + facts, put each as a "links" entry they can open, and give a short recommendation in "synthesis". Their part should be just the final pick or click \u2014 NEVER "go figure it out". E.g. "book a Boston restaurant" \u2192 research a few fitting spots, link each (Resy/the restaurant site), recommend one with a one-line why; the step is just "Pick one & book".
ALWAYS SURFACE WHAT YOU MADE: whenever you create or draft something (a Gmail draft, a Google Doc/Sheet/Slides deck, a calendar event, a task, an issue/PR or comment), put a LINK to it in submit's "links" so the user can open and review it. Build the URL from the id the tool returned \u2014 Doc: https://docs.google.com/document/d/<id>/edit, Sheet: https://docs.google.com/spreadsheets/d/<id>/edit, Slides: https://docs.google.com/presentation/d/<id>/edit, Gmail draft: https://mail.google.com/mail/u/0/#drafts, calendar event: the htmlLink it returned. If a result already includes a URL / webViewLink, use that. Never invent a link \u2014 only include one you actually got back.
ONE-CLICK SEND (the ONLY way anything goes out \u2014 always with the recipient shown): for every email you DRAFTED, add a "sendables" entry {app:"gmail", label, to (the recipient, ALWAYS set it), subject, body, draftId} \u2014 include the EXACT subject + body you wrote (so the user can review the draft IN THE APP) plus the draft_id the create-draft tool returned. For every Slack message you COMPOSED, add {app:"slack", label, channel, text} \u2014 do NOT post it. For a calendar event that should invite people, add {app:"gcal", label, eventId, attendees:[the invitees' emails], summary, when} \u2014 do NOT notify them. Each gives the user a Send button that names the recipient(s) first; you still never send. Don't ALSO add a "send it" step \u2014 the button is the send.
Use "remember" for a durable fact about WHO THIS PERSON IS (a preference, a key person, an ongoing project, or a one-line "about") \u2014 save NEW facts AND corrected versions of profile lines that turned out outdated or wrong (a corrected fact REPLACES the old one). Be selective.
QUALITY BAR \u2014 self-check BEFORE calling submit, fix anything that fails: (1) every draft/doc contains the REAL specifics (dates, times, numbers, names, addresses) \u2014 zero placeholders; (2) drafts match the user's actual voice per the VOICE rules \u2014 reread one sent email if unsure; (3) each sendable's subject/body is EXACTLY what you wrote into the created draft (same draftId); (4) every link came from a tool result \u2014 never constructed from guesswork. A polished half is worth more than a sloppy whole.
Call "submit" ONLY after you've actually done the reversible work \u2014 not before. Be BRIEF: "synthesis" is ONE sentence; "context" is 1-2 short bullets. Don't narrate problems or steps you skipped \u2014 just the result.`;
var RUN_TOOLS = [
  { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'name' (what to call them \u2014 save it the moment you learn their name, e.g. from their email signature or how others address them; fact = just the name), 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), or 'about' (a one-line summary of them).", input_schema: { type: "object", properties: { category: { type: "string", enum: ["name", "about", "preference", "person", "project"] }, fact: { type: "string" } }, required: ["category", "fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    context: { type: "string", description: "what this is about \u2014 1-2 SHORT bullets, each a line beginning with '- '. Brief; the user only sees this if they expand it." },
    synthesis: { type: "string", description: "what you accomplished \u2014 ONE short plain sentence (\u2264 ~25 words), past tense, e.g. 'Drafted a reply to Sarah and opened the budget doc.' NO caveats, NO explaining what you couldn't do or why \u2014 anything the user must handle goes in 'steps', not here." },
    steps: {
      type: "array",
      description: "What's LEFT to finish, ordered, each ONE concrete action. Include (1) human-only steps (automatable=false) and (2) steps you can do but that are BLOCKED on a human step (automatable=true + dependsOn). NEVER list work you already did, or a doable + unblocked action (do that now). Often empty.",
      items: { type: "object", properties: {
        text: { type: "string", description: "ONE concrete action \u2014 imperative verb + the specific thing, \u2264 ~12 words, no hedging. e.g. 'Send the draft to Sarah', 'Pick the offsite date', 'Approve & publish the brief'." },
        automatable: { type: "boolean", description: "true = OTTO can do it with its tools or by finding info (read/search, draft, create/update a doc/sheet/event/task, ENTER/FILL data, comment, research, open a page) \u2014 do it NOW unless it waits on a user step (then set dependsOn). false = needs the USER, ONLY for: a judgment/decision/approval, a credential you lack, a payment, or a physical act. NOT for being specific/numeric/tedious; sending a message is a one-click send, not a step." },
        needsPermission: { type: "boolean", description: "true = ONLY if the tool returned PERMISSION_REQUIRED. The action is automatable but needs user approval first. Requires automatable=true." },
        dependsOn: { type: "number", description: "index of an earlier step that must finish first \u2014 use it for an automatable step that waits on a user step; omit if none" },
        url: { type: "string", description: "a link that puts the user ONE click from doing this step \u2014 directions (Google Maps dir link), a tel: number, the exact booking/payment/return page, a form. Include one whenever it exists or can be constructed; not just for 'open a page' steps." },
        question: { type: "string", description: "ONLY if this automatable step is missing ONE detail you could not find or infer anywhere (a choice, a preference, a date only the user knows): one short, direct question. Search everything first \u2014 a question you could have answered yourself is a failure." },
        options: { type: "array", items: { type: "string" }, description: "2-4 likely answers to 'question', your best inference FIRST (the user taps one and you run). Short \u2014 a few words each. Omit for free-form answers." }
      }, required: ["text", "automatable"] }
    },
    links: {
      type: "array",
      description: "links to anything you CREATED or DRAFTED this run (Gmail draft, Google Doc/Sheet/Slides, calendar event, issue/PR, task), so the user can open it. Build each URL from the id the tool returned; omit if you made nothing.",
      items: { type: "object", properties: {
        label: { type: "string", description: "what it is, e.g. 'Draft reply to Sarah', 'Project brief doc'" },
        url: { type: "string", description: "an https URL that opens it" }
      }, required: ["label", "url"] }
    },
    sendables: {
      type: "array",
      description: "ONE-CLICK sends to offer the user for anything you DRAFTED/COMPOSED (you never send; the user clicks, and the recipient is always shown first). Gmail draft \u2192 {app:'gmail', label, to:<recipient, ALWAYS set>, subject, body (the EXACT subject + body you drafted, so the user can review it in-app), draftId:<the draft_id the create-draft tool returned>}. Slack message you composed (do NOT post it) \u2192 {app:'slack', label, channel:<id or #name>, text:<message>}. Calendar event that should invite people (you created it silently, no notifications) \u2192 {app:'gcal', label, eventId:<the event id the create tool returned>, attendees:[invitee emails], summary:<event title>, when:<date/time>}. Omit if you composed nothing to send.",
      items: { type: "object", properties: {
        app: { type: "string", enum: ["gmail", "slack", "gcal"] },
        label: { type: "string", description: "short, e.g. 'Send reply to Sarah', 'Send invites'" },
        to: { type: "string", description: "recipient email or channel \u2014 shown to the user before they send" },
        subject: { type: "string", description: "gmail: the drafted subject (for in-app review)" },
        body: { type: "string", description: "gmail: the drafted body as plain text (for in-app review)" },
        draftId: { type: "string", description: "gmail: the draft_id to send" },
        channel: { type: "string", description: "slack: channel id or #name" },
        text: { type: "string", description: "slack: the message text to post" },
        attendees: { type: "array", items: { type: "string" }, description: "gcal: the invitee emails the invite will notify (shown before sending)" },
        eventId: { type: "string", description: "gcal: the id of the event you created (to patch with send_updates so attendees get invited)" },
        summary: { type: "string", description: "gcal: the event title (for in-app review)" },
        when: { type: "string", description: "gcal: the event date/time (for in-app review)" }
      }, required: ["app", "label"] }
    }
  }, required: ["context", "synthesis", "steps"] } }
];
async function runTask(task, profile, focus, extras) {
  const profileUpdates = [];
  const tools = [...RUN_TOOLS, WEB_SEARCH_TOOL, ...extras?.selfBrief ? [SELF_BRIEF_TOOL] : [], ...extras?.tools?.length ? extras.tools : []];
  const connectedLine = extras?.connected?.length ? `
Connected apps you can use (read + reversible writes; never send/post/delete): ${extras.connected.join(", ")}.
` : `
No apps are connected yet \u2014 if you can't proceed without one, say so in the synthesis and put "Connect the app in Settings" as a step.
`;
  const manualHint = task.source === "manual" ? `
The USER added this to-do themselves. Treat the title as their intent: use your tools (search their Gmail/Drive, etc.) and what you know about them to find the real, specific context behind it BEFORE acting.` : "";
  const priorArtifacts = (task.links || []).filter((l) => l?.url);
  const artifactsBlock = priorArtifacts.length ? `
ALREADY CREATED FOR THIS TASK (you made these on a prior run \u2014 OPEN and UPDATE the existing one, do NOT create a new copy):
${priorArtifacts.map((l) => `- ${l.label}: ${l.url}`).join("\n")}
` : "";
  const head = nowBlock() + `TASK: ${task.title}
WHY: ${task.why}
` + profileBlock(profile) + artifactsBlock + connectedLine;
  const deadlineHint = deadlineBlock(`${task.title}
${task.why}`);
  const messages = [{
    role: "user",
    content: focus ? head + deadlineHint + `
Do ONLY this one step now: "${focus}". Actually DO it with your tools (draft/create/update) \u2014 don't describe it, DO it \u2014 then submit: synthesis = what you did; steps = [] unless something still genuinely needs the user.` : head + deadlineHint + manualHint + `
Gather what you need, then ACTUALLY DO the reversible work now with your tools (draft/create/update) \u2014 don't just plan it. Only once you've done everything you can, call submit; list as steps only what truly needs the user.`
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  const MAX = 14;
  let tokIn = 0, tokOut = 0, rounds = 0;
  try {
    for (let i = 0; i < MAX; i++) {
      if (i === 6 && !focus) {
        messages.push({ role: "user", content: "REMINDER: You have now gathered significant context. If this task involves writing to a spreadsheet or document, START WRITING NOW \u2014 call the write tool (e.g. GOOGLESHEETS_BATCH_UPDATE_VALUES or GOOGLESHEETS_APPEND_VALUES) with the real data. Do not keep reading without writing. Complete the work and call submit when done." });
      }
      const client2 = deepseekClient();
      const lastRoundHint = i === MAX - 1 ? "You must call submit now with the final result. Do not answer with prose." : "";
      const base = trimOldToolResults(messages);
      const apiMessages = lastRoundHint ? [...base, { role: "user", content: lastRoundHint }] : base;
      const res = await retryRequest2(() => client2.chat.completions.create({
        model: actualModel,
        max_tokens: 2500,
        messages: [
          { role: "system", content: RUN_SYSTEM },
          ...apiMessages
        ],
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      }));
      rounds++;
      tokIn += res.usage?.prompt_tokens || 0;
      tokOut += res.usage?.completion_tokens || 0;
      const toolUses = res.choices[0]?.message?.tool_calls || [];
      if (!toolUses.length) {
        const textContent = res.choices[0]?.message?.content || "";
        const out = firstJson(textContent);
        if (out) return finalize(out, textContent, profileUpdates);
        if (i < MAX - 1) {
          if (textContent) messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: "You still have not used any tools. Read the connected apps and do the work now. Do not answer with prose until you have actually acted." });
          continue;
        }
        return finalize(out, textContent, profileUpdates);
      }
      messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
      let submitted = null;
      for (const tu of toolUses) {
        const input = parseToolArgs(tu.function?.arguments);
        let content = "ok";
        try {
          const toolName = tu.function?.name;
          if (toolName === "remember") {
            const fact = String(input.fact || "").trim();
            const cat = ["name", "about", "preference", "person", "project"].includes(input.category) ? input.category : "preference";
            if (fact) profileUpdates.push({ category: cat, fact });
            content = "saved";
          } else if (toolName === "submit") {
            submitted = finalize(input, "", profileUpdates);
            content = "submitted";
          } else if (toolName === "web_search") {
            content = await runWebSearch(input);
          } else if (toolName === "send_self_brief") {
            content = extras?.selfBrief ? await extras.selfBrief(String(input?.subject || ""), String(input?.body || "")) : "ERROR: not available";
          } else {
            const r = extras ? await extras.call(toolName, input || {}) : null;
            content = r ?? `Unknown tool: ${toolName}`;
          }
        } catch (e) {
          content = "ERROR: " + (e?.message || e);
        }
        messages.push({ role: "tool", tool_call_id: tu.id || `tool_${Date.now()}`, content: String(content).slice(0, 4e3) });
      }
      if (submitted) return submitted;
    }
    try {
      const client2 = deepseekClient();
      const transcript = messages.map((m) => {
        const role = String(m?.role || "assistant");
        const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
        return `${role.toUpperCase()}: ${content}`;
      }).join("\n\n").slice(-24e3);
      const rescue = await client2.chat.completions.create({
        model: actualModel,
        max_tokens: 1400,
        messages: [
          {
            role: "system",
            content: "You must output STRICT JSON only: {context:string,synthesis:string,steps:array,links:array,sendables:array}. Use the transcript to produce the best possible final result. Keep synthesis to one short sentence."
          },
          { role: "user", content: transcript }
        ]
      });
      const text = rescue.choices[0]?.message?.content || "";
      const out = firstJson(text);
      if (out) return finalize(out, text, profileUpdates);
    } catch {
    }
    throw new Error("The run didn't produce a result \u2014 it will retry.");
  } finally {
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [ai] runTask "${task.title.slice(0, 50)}": ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}
function finalize(out, fallbackText, profileUpdates) {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps = rawSteps.map((s, idx) => ({
    text: String(s?.text || "").trim(),
    automatable: !!s?.automatable,
    needsPermission: !!s?.needsPermission,
    // Valid only if it points at a REAL other step — a bad index (9 in a 3-step list, or itself)
    // would permanently block the step client-side.
    dependsOn: Number.isInteger(s?.dependsOn) && s.dependsOn >= 0 && s.dependsOn < rawSteps.length && s.dependsOn !== idx ? s.dependsOn : void 0,
    url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : void 0,
    question: s?.question ? String(s.question).trim().slice(0, 200) : void 0,
    options: Array.isArray(s?.options) ? s.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4) : void 0
  })).filter((s) => s.text).slice(0, 10);
  const links = (Array.isArray(out?.links) ? out.links : []).map((l) => ({ label: String(l?.label || "Open").slice(0, 80), url: String(l?.url || "").trim() })).filter((l) => /^https?:\/\//i.test(l.url)).slice(0, 3);
  const sendables = (Array.isArray(out?.sendables) ? out.sendables : []).map((s) => ({
    app: s?.app === "slack" ? "slack" : s?.app === "gcal" ? "gcal" : "gmail",
    label: String(s?.label || (s?.app === "slack" ? "Send message" : s?.app === "gcal" ? "Send invites" : "Send email")).slice(0, 80),
    to: s?.to ? String(s.to).slice(0, 160) : void 0,
    subject: s?.subject ? String(s.subject).slice(0, 300) : void 0,
    body: s?.body ? String(s.body).slice(0, 6e3) : void 0,
    draftId: s?.draftId ? String(s.draftId).slice(0, 200) : void 0,
    channel: s?.channel ? String(s.channel).slice(0, 120) : void 0,
    text: s?.text ? String(s.text).slice(0, 4e3) : void 0,
    attendees: Array.isArray(s?.attendees) ? s.attendees.map((a) => String(a).slice(0, 160)).filter(Boolean).slice(0, 50) : void 0,
    eventId: s?.eventId ? String(s.eventId).slice(0, 200) : void 0,
    summary: s?.summary ? String(s.summary).slice(0, 300) : void 0,
    when: s?.when ? String(s.when).slice(0, 120) : void 0
  })).filter((s) => s.app === "gmail" && !!s.draftId || s.app === "slack" && !!s.channel && !!s.text || s.app === "gcal" && !!s.eventId && !!s.attendees?.length).slice(0, 6);
  const brief = (s, lines, chars) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join("\n").slice(0, chars);
  const synthesis = brief(String(out?.synthesis || fallbackText || ""), 3, 550);
  if (!synthesis && !steps.length && !links.length && !sendables.length) {
    throw new Error("The run produced no output \u2014 it will retry.");
  }
  return {
    context: brief(String(out?.context || ""), 3, 600),
    synthesis: synthesis || "Done.",
    steps,
    links,
    sendables,
    profileUpdates
  };
}
function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// server/store.ts
import { createClient } from "@supabase/supabase-js";
import session from "express-session";
var url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
var key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
var TABLE = "weave_web_state";
var client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
if (client && !process.env.SUPABASE_SERVICE_KEY) {
  const msg = "Supabase is configured with the ANON key \u2014 refresh tokens + password hashes would be readable by anyone holding it.";
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[store] ${msg} Set SUPABASE_SERVICE_KEY (and restrict RLS to the service role) before deploying.`);
  }
  console.warn(`[store] SECURITY: ${msg} Fine locally; set SUPABASE_SERVICE_KEY before you deploy.`);
}
var cloudEnabled = () => !!client;
var USERS = "weave_web_users";
var SESSIONS = "weave_web_sessions";
async function makeSessionStore() {
  if (!client) return void 0;
  const c = client;
  const { error: probe } = await c.from(SESSIONS).select("sid").limit(1);
  if (probe) {
    console.warn(`[store] persistent sessions OFF \u2014 run web/supabase.sql to create '${SESSIONS}' (${probe.message}). Using in-memory sessions (lost on restart).`);
    return void 0;
  }
  const ttlMs = (sess) => sess?.cookie?.maxAge ?? 30 * 24 * 3600 * 1e3;
  const expiry = (sess) => new Date(Date.now() + ttlMs(sess)).toISOString();
  class SupabaseStore extends session.Store {
    get(sid, cb) {
      c.from(SESSIONS).select("sess,expire").eq("sid", sid).maybeSingle().then(
        ({ data, error }) => {
          if (error) return cb(error);
          if (!data) return cb(null, null);
          if (data.expire && new Date(data.expire).getTime() < Date.now()) {
            this.destroy(sid, () => {
            });
            return cb(null, null);
          }
          cb(null, data.sess);
        },
        (e) => cb(e)
      );
    }
    set(sid, sess, cb) {
      c.from(SESSIONS).upsert({ sid, sess, expire: expiry(sess) }, { onConflict: "sid" }).then(
        ({ error }) => cb?.(error || void 0),
        (e) => cb?.(e)
      );
    }
    destroy(sid, cb) {
      c.from(SESSIONS).delete().eq("sid", sid).then(({ error }) => cb?.(error || void 0), (e) => cb?.(e));
    }
    touch(sid, sess, cb) {
      c.from(SESSIONS).update({ expire: expiry(sess) }).eq("sid", sid).then(() => cb?.(), () => cb?.());
    }
  }
  return new SupabaseStore();
}
async function getUser(email) {
  if (!client) return null;
  try {
    const { data } = await client.from(USERS).select("email,pass_hash").eq("email", email).maybeSingle();
    return data ? { email: data.email, pass_hash: data.pass_hash } : null;
  } catch (e) {
    console.warn("[store] getUser threw:", e?.message || e);
    return null;
  }
}
async function createUser(email, passHash) {
  if (!client) return false;
  try {
    const { error } = await client.from(USERS).insert({ email, pass_hash: passHash });
    if (error) {
      console.warn("[store] createUser failed:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[store] createUser threw:", e?.message || e);
    return false;
  }
}
async function loadState(email) {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  try {
    const { data, error } = await client.from(TABLE).select("profile,tasks,google").eq("email", email).maybeSingle();
    if (error) {
      console.warn("[store] load failed:", error.message);
      return { profile: emptyProfile(), tasks: [] };
    }
    const google = data?.google && data.google.tokens ? data.google : void 0;
    return { profile: normalizeProfile(data?.profile), tasks: Array.isArray(data?.tasks) ? data.tasks : [], google };
  } catch (e) {
    console.warn("[store] load threw:", e?.message || e);
    return { profile: emptyProfile(), tasks: [] };
  }
}
async function saveState(email, state) {
  if (!client || !email) return;
  try {
    const { error } = await client.from(TABLE).upsert(
      { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], google: state.google ?? null, updated_at: (/* @__PURE__ */ new Date()).toISOString() },
      { onConflict: "email" }
    );
    if (error) console.warn("[store] save failed:", error.message);
  } catch (e) {
    console.warn("[store] save threw:", e?.message || e);
  }
}

// server/tasks.ts
import { randomUUID } from "node:crypto";
function applyProfileUpdate(profile, u) {
  const f = u.fact.trim();
  if (!f) return;
  if (u.category === "name") {
    profile.name = f.slice(0, 60);
    return;
  }
  if (u.category === "about") {
    profile.about = f.slice(0, 400);
    return;
  }
  const key2 = u.category === "preference" ? "preferences" : u.category === "person" ? "people" : "projects";
  const fact = f.slice(0, 160);
  const rest = profile[key2].filter((x) => !sameFact(x, fact));
  profile[key2] = dedupeFacts([...rest, fact]);
}
var URGENT_AT = 0.5;
var IMPORTANT_AT = 0.5;
function eisenhower(urgency, importance) {
  const urgent = urgency >= URGENT_AT, important = importance >= IMPORTANT_AT;
  const quadrant = important ? urgent ? "do" : "schedule" : urgent ? "delegate" : "later";
  const rank = important ? urgent ? 3 : 2 : urgent ? 1 : 0;
  return { quadrant, score: rank + (0.6 * importance + 0.4 * urgency) * 0.99 };
}
function normTitle(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
var GENERIC_WORDS = /* @__PURE__ */ new Set([
  "use",
  "get",
  "got",
  "make",
  "made",
  "add",
  "set",
  "ask",
  "the",
  "for",
  "your",
  "you",
  "and",
  "with",
  "from",
  "before",
  "after",
  "this",
  "that",
  "need",
  "needs",
  "send",
  "reply",
  "pay",
  "book",
  "buy",
  "read",
  "sort",
  "plan",
  "prep",
  "review",
  "check",
  "email",
  "mail",
  "call",
  "off",
  "out",
  "new",
  "via",
  "per",
  "due",
  "day",
  "days",
  "week",
  "soon",
  "now",
  "all",
  "any",
  "into",
  "onto",
  "about",
  "then",
  "complete",
  "finish",
  "update"
]);
function distinctiveTokens(s) {
  const words = normTitle(s).split(" ").filter((w) => w.length > 2);
  const distinctive = words.filter((w) => !GENERIC_WORDS.has(w));
  return new Set(distinctive.length ? distinctive : words);
}
function nearDup(a, b) {
  const A = distinctiveTokens(a), B = distinctiveTokens(b);
  if (!A.size || !B.size) return false;
  const matches = (w, set) => {
    if (set.has(w)) return true;
    for (const x of set) if (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))) return true;
    return false;
  };
  let inter = 0;
  for (const w of A) if (matches(w, B)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return jaccard >= 0.55 || inter >= 3 && containment >= 0.75 || inter >= 2 && containment >= 0.9;
}
function pruneHandled(list, keep) {
  const active = list.filter((t) => t.status !== "done" && t.status !== "dismissed");
  const handled = list.filter((t) => t.status === "done" || t.status === "dismissed").sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, keep);
  return [...active, ...handled];
}
async function generate(existing, profile, extras) {
  const handled = existing.filter((t) => t.status === "done" || t.status === "dismissed").map((t) => ({
    title: t.title,
    why: t.why,
    source: t.source,
    when: t.when,
    anchorKey: t.anchorKey,
    link: t.evidence?.find((e) => e.url)?.url
  }));
  const gen = await generateTasks(profile, extras, handled);
  for (const u of gen.profileUpdates) applyProfileUpdate(profile, u);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const linkOf = (t) => (t.evidence || []).map((e) => e.url).find(Boolean) || "";
  const rankStatus = (t) => t.status === "done" || t.status === "dismissed" ? 4 : t.status === "executed" ? 3 : t.status === "running" ? 2 : 1;
  const betterOf = (a, b) => rankStatus(b) > rankStatus(a) ? b : a;
  const kept = [];
  const sameTask = (a, b) => nearDup(a.title, b.title) || a.source === b.source && nearDup(a.why, b.why);
  const absorb = (t) => {
    const ak = normKey(t.anchorKey), link = linkOf(t);
    const i = kept.findIndex((k) => !!ak && normKey(k.anchorKey) === ak || !!link && linkOf(k) === link || sameTask(k, t));
    if (i >= 0) {
      kept[i] = betterOf(kept[i], t);
      return;
    }
    kept.push(t);
  };
  for (const t of existing) absorb(t);
  for (const g of gen.tasks) {
    const e = eisenhower(g.urgency, g.importance);
    const evidence = g.link ? [{ label: g.source === "calendar" ? "Open event" : g.source === "gmail" ? "Open in Gmail" : "Open source", url: g.link }] : void 0;
    absorb({
      id: randomUUID(),
      title: g.title,
      why: g.why,
      when: g.when,
      source: g.source,
      risk: g.risk,
      urgency: g.urgency,
      importance: g.importance,
      quadrant: e.quadrant,
      score: e.score,
      status: "ready",
      createdAt: now,
      anchorKey: g.anchorKey,
      evidence
    });
  }
  const deduped = [];
  for (const t of kept) {
    const i = deduped.findIndex((k) => !!t.anchorKey && !!k.anchorKey && normKey(t.anchorKey) === normKey(k.anchorKey) || !!linkOf(t) && linkOf(t) === linkOf(k) || sameTask(t, k));
    if (i >= 0) deduped[i] = betterOf(deduped[i], t);
    else deduped.push(t);
  }
  return pruneHandled(deduped.sort((a, b) => b.score - a.score), 120);
}
function addManual(list, title, refined) {
  const urgency = refined ? refined.urgency : 0.6;
  const importance = refined ? refined.importance : 0.75;
  const e = eisenhower(urgency, importance);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  list.unshift({
    id: randomUUID(),
    title: (refined?.title || title).trim().slice(0, 120),
    why: refined?.why || "Added by you.",
    when: refined?.when,
    source: "manual",
    risk: "low",
    urgency,
    importance,
    quadrant: e.quadrant,
    score: e.score,
    status: "ready",
    createdAt: now
  });
  return list;
}
async function runById(list, id, profile, extras, revision) {
  const task = list.find((t) => t.id === id);
  if (!task) return void 0;
  if (task.status === "running") return task;
  task.status = "running";
  task.autoRan = true;
  const focus = revision?.trim() ? `The user reviewed your previous draft/output for this task and wants this CHANGE before they send it: "${revision.trim()}". Redo the task incorporating it \u2014 UPDATE the existing draft/doc (don't create a new copy) and re-offer it as a sendable.` : void 0;
  try {
    const out = await runTask({ title: task.title, why: task.why, source: task.source, links: task.links }, profile, focus, extras);
    for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
    task.context = out.context;
    task.synthesis = out.synthesis;
    const prior = (task.steps || []).filter((s) => s.done);
    task.steps = (out.steps || []).map((s) => {
      const old = prior.find((o) => nearDup(o.text, s.text));
      return old ? { ...s, done: true, doneAt: old.doneAt, result: s.result || old.result } : s;
    });
    task.links = out.links?.length ? out.links : void 0;
    task.sendables = out.sendables?.length ? out.sendables : void 0;
    task.status = "executed";
    return task;
  } catch (e) {
    task.status = "ready";
    throw e;
  }
}
function reject(list, id) {
  const t = list.find((x) => x.id === id);
  if (t) {
    t.status = "ready";
    t.synthesis = void 0;
    t.steps = void 0;
    t.links = void 0;
    t.autoRan = false;
  }
}
async function runStep(list, id, index, profile, extras, answer) {
  const task = list.find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (!task || !step) return task;
  const decisions = (task.steps || []).filter((s, idx) => idx !== index && s.done && s.result).map((s) => `- "${s.text}" \u2192 ${s.result}`).join("\n");
  const qa = answer?.trim() ? step.question ? `
The user answered your question ("${step.question}"): "${answer.trim()}". That is the missing detail \u2014 use it and complete the step now; do not ask again.` : `
Info from the user for this step: "${answer.trim()}". Use it.` : "";
  const focus = (decisions ? `${step.text}

What the user has already decided/done:
${decisions}` : step.text) + qa;
  const out = await runTask({ title: task.title, why: task.why, source: task.source, links: task.links }, profile, focus, extras);
  for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
  step.result = out.synthesis.slice(0, 1200);
  if ((out.steps || []).some((s) => !s.automatable)) {
    step.automatable = false;
    step.done = false;
  } else {
    step.done = true;
    step.doneAt = (/* @__PURE__ */ new Date()).toISOString();
    step.question = void 0;
    step.options = void 0;
  }
  if (out.links?.length) {
    const seen = new Set((task.links || []).map((l) => l.url));
    task.links = [...task.links || [], ...out.links.filter((l) => !seen.has(l.url))].slice(0, 3);
  }
  if (out.sendables?.length) {
    const key2 = (s) => s.draftId || s.eventId || `${s.channel}:${s.text}`;
    const seen = new Set((task.sendables || []).map(key2));
    task.sendables = [...task.sendables || [], ...out.sendables.filter((s) => !seen.has(key2(s)))].slice(0, 8);
  }
  return task;
}

// server/integrations.ts
import { Composio } from "@composio/core";
var CATALOG = [
  // Google — connected through Composio (read + write), one tile per service.
  { key: "gmail", name: "Gmail", toolkit: "GMAIL", category: "Google", blurb: "Read mail; draft replies. (sending stays your call)" },
  { key: "googlecalendar", name: "Google Calendar", toolkit: "GOOGLECALENDAR", category: "Google", blurb: "Upcoming events & scheduling." },
  { key: "googledocs", name: "Google Docs", toolkit: "GOOGLEDOCS", category: "Google", blurb: "Read & create documents." },
  { key: "googleslides", name: "Google Slides", toolkit: "GOOGLESLIDES", category: "Google", blurb: "Read & build decks." },
  { key: "googledrive", name: "Google Drive", toolkit: "GOOGLEDRIVE", category: "Google", blurb: "Search & read your files." },
  { key: "googlesheets", name: "Google Sheets", toolkit: "GOOGLESHEETS", category: "Google", blurb: "Read & edit spreadsheets." },
  // Communication
  { key: "slack", name: "Slack", toolkit: "SLACK", category: "Communication", blurb: "Read channels & DMs; draft messages." },
  { key: "discord", name: "Discord", toolkit: "DISCORD", category: "Communication", blurb: "Read servers & channels." },
  { key: "linkedin", name: "LinkedIn", toolkit: "LINKEDIN", category: "Communication", blurb: "Read your feed; draft posts." },
  // Code & projects
  { key: "github", name: "GitHub", toolkit: "GITHUB", category: "Code & projects", blurb: "Issues, PRs, notifications." },
  { key: "linear", name: "Linear", toolkit: "LINEAR", category: "Code & projects", blurb: "Issues, projects, cycles." },
  { key: "jira", name: "Jira", toolkit: "JIRA", category: "Code & projects", blurb: "Issues & sprints." },
  // Tasks
  { key: "todoist", name: "Todoist", toolkit: "TODOIST", category: "Tasks", blurb: "Tasks & projects." },
  { key: "asana", name: "Asana", toolkit: "ASANA", category: "Tasks", blurb: "Tasks & projects." },
  { key: "trello", name: "Trello", toolkit: "TRELLO", category: "Tasks", blurb: "Boards & cards." },
  { key: "clickup", name: "ClickUp", toolkit: "CLICKUP", category: "Tasks", blurb: "Tasks, docs & goals." },
  // Knowledge & notes
  { key: "notion", name: "Notion", toolkit: "NOTION", category: "Knowledge", blurb: "Pages & databases." },
  // Scheduling, CRM & data
  { key: "calendly", name: "Calendly", toolkit: "CALENDLY", category: "Scheduling & CRM", blurb: "Scheduled events & invitees." },
  { key: "hubspot", name: "HubSpot", toolkit: "HUBSPOT", category: "Scheduling & CRM", blurb: "Contacts, deals & notes." },
  { key: "airtable", name: "Airtable", toolkit: "AIRTABLE", category: "Scheduling & CRM", blurb: "Bases & records." }
];
var TOOLKIT_OF = (app2) => CATALOG.find((c) => c.key === app2.toLowerCase())?.toolkit ?? app2.toUpperCase();
var norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var logoFor = (toolkit) => `https://logos.composio.dev/api/${String(toolkit).toLowerCase()}`;
function integrationsReady() {
  return !!process.env.COMPOSIO_API_KEY;
}
function isGatedAction(rawName) {
  const n = rawName.toUpperCase();
  if (/DRAFT/.test(n) && !/(SEND|DELETE|TRASH)/.test(n)) return false;
  return /(SEND|REPLY|FORWARD|PUBLISH|UNSUBSCRIBE|TWEET|DELETE|REMOVE|TRASH|ARCHIVE|CREATE_POST|CREATE_TWEET|CREATE_MESSAGE|SCHEDULE_MESSAGE|CREATE_DM|_POST_|_POST$|SHARE|INVITE)/.test(n);
}
function isWriteGatedAction(rawName) {
  const n = rawName.toUpperCase();
  if (/^GOOGLEDOCS_/.test(n) && /(UPDATE|MODIFY|PATCH|REPLACE|APPEND|INSERT|DELETE_CONTENT|BATCH)/.test(n)) return true;
  if (/^GOOGLESHEETS_/.test(n) && /(DELETE_ROW|DELETE_SHEET|DELETE_COLUMN)/.test(n)) return true;
  if (/^GOOGLESLIDES_/.test(n) && /(UPDATE|MODIFY|PATCH|REPLACE|BATCH)/.test(n)) return true;
  if (/^GOOGLECALENDAR_/.test(n) && /(CREATE|INSERT|UPDATE|PATCH|QUICK_ADD)/.test(n)) return true;
  if (/^GMAIL_/.test(n) && /(SEND|REPLY|FORWARD)/.test(n)) return true;
  return false;
}
var _client = null;
function sdk() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not configured");
  return _client ||= new Composio({ apiKey });
}
var isActive = (i) => ["ACTIVE", "CONNECTED", "ENABLED"].includes(String(i?.status ?? i?.connectionStatus ?? i?.state ?? "").toUpperCase());
var acctToolkit = (i) => norm(i?.toolkit?.slug ?? i?.toolkit?.name ?? i?.toolkit ?? i?.appName ?? i?.app?.name ?? i?.app ?? i?.appUniqueId ?? i?.toolkitSlug ?? "");
var acctId = (i) => String(i?.id ?? i?.connectedAccountId ?? i?.nanoId ?? "");
var authConfigInFlight = /* @__PURE__ */ new Map();
async function resolveAuthConfigId(toolkit) {
  const key2 = toolkit.toUpperCase();
  const pending = authConfigInFlight.get(key2);
  if (pending) return pending;
  const p = (async () => {
    const s = sdk();
    const list = await s.authConfigs.list({ toolkit: key2 });
    const configs = (list?.items ?? (Array.isArray(list) ? list : [])).filter((c) => norm(c?.toolkit?.slug ?? c?.toolkit?.name ?? c?.toolkit ?? "") === norm(toolkit));
    if (configs.length) {
      const id2 = String(configs[0].id ?? configs[0].authConfigId ?? "").trim();
      if (id2 && id2 !== "undefined") return id2;
    }
    const created = await s.authConfigs.create(key2, { type: "use_composio_managed_auth" });
    const id = String(created?.id ?? created?.authConfigId ?? "").trim();
    if (!id || id === "undefined") throw new Error(`Could not create auth config for ${toolkit}.`);
    return id;
  })();
  authConfigInFlight.set(key2, p);
  try {
    return await p;
  } finally {
    authConfigInFlight.delete(key2);
  }
}
async function initiateConnection(app2, userId, callbackUrl) {
  const authConfigId = await resolveAuthConfigId(TOOLKIT_OF(app2));
  await disconnect(app2, userId).catch(() => {
  });
  const req = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl });
  const redirectUrl = String(req?.redirectUrl ?? req?.redirectUri ?? "").trim();
  const connectionId = String(req?.id ?? req?.connectedAccountId ?? "").trim();
  if (!redirectUrl) throw new Error(`Composio returned no redirect URL for ${app2}.`);
  return { redirectUrl, connectionId };
}
async function getAllConnectionStatuses(userId, apps, connIdByApp = {}) {
  try {
    const list = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 });
    const items = (list?.items ?? (Array.isArray(list) ? list : [])).filter(isActive);
    const toolkits = new Set(items.map(acctToolkit));
    const ids = new Set(items.map(acctId));
    const out = {};
    for (const app2 of apps) out[app2] = toolkits.has(norm(TOOLKIT_OF(app2))) || !!connIdByApp[app2] && ids.has(connIdByApp[app2]);
    return out;
  } catch (e) {
    console.warn("[integrations] getAllConnectionStatuses error:", e?.message ?? e);
    return Object.fromEntries(apps.map((a) => [a, false]));
  }
}
async function getConnectedAccounts(userId, app2) {
  try {
    const list = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 });
    const items = (list?.items ?? (Array.isArray(list) ? list : [])).filter(isActive);
    const targetToolkit = norm(TOOLKIT_OF(app2));
    return items.filter((i) => acctToolkit(i) === targetToolkit).map((i) => ({
      id: acctId(i),
      email: i?.email || i?.accountEmail || i?.metadata?.email,
      toolkit: acctToolkit(i),
      status: i?.status || i?.connectionStatus || i?.state || "ACTIVE"
    })).filter((a) => a.id);
  } catch (e) {
    console.warn("[integrations] getConnectedAccounts error:", e?.message ?? e);
    return [];
  }
}
async function disconnect(app2, userId) {
  try {
    const list = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 });
    const items = list?.items ?? (Array.isArray(list) ? list : []);
    const accounts = items.filter((i) => isActive(i) && acctToolkit(i) === norm(TOOLKIT_OF(app2)));
    for (const account of accounts) {
      const id = acctId(account);
      if (id) await sdk().connectedAccounts.delete(id);
    }
    return { ok: true };
  } catch (e) {
    console.error(`[integrations] disconnect(${app2}) failed:`, e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
async function disconnectAccount(accountId) {
  try {
    if (!accountId) return { ok: false, error: "account id required" };
    await sdk().connectedAccounts.delete(accountId);
    return { ok: true };
  } catch (e) {
    console.error(`[integrations] disconnectAccount(${accountId}) failed:`, e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
async function listConnectedToolkits(userId) {
  try {
    const list = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 });
    const items = list?.items ?? (Array.isArray(list) ? list : []);
    const slugs = /* @__PURE__ */ new Set();
    for (const i of items) {
      if (!isActive(i)) continue;
      const slug = String(i?.toolkit?.slug ?? i?.toolkit?.name ?? i?.toolkit ?? i?.appName ?? i?.app?.name ?? i?.app ?? "").toLowerCase().trim();
      if (slug) slugs.add(slug);
    }
    return [...slugs];
  } catch (e) {
    console.warn("[integrations] listConnectedToolkits failed:", e?.message ?? e);
    return [];
  }
}
async function execute(action, userId, args) {
  const result = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true });
  return JSON.stringify(result ?? {}, null, 2).slice(0, 4e3);
}
async function sendSendable(userId, s) {
  if (!integrationsReady() || !userId) return { ok: false, error: "Integrations not configured." };
  let action = "", args = {};
  if (s.app === "gmail" && s.draftId) {
    action = "GMAIL_SEND_DRAFT";
    args = { draft_id: s.draftId };
  } else if (s.app === "slack" && s.channel) {
    action = "SLACK_CHAT_POST_MESSAGE";
    args = { channel: s.channel, ...s.text ? { text: s.text } : {} };
  } else if (s.app === "gcal" && s.eventId && s.attendees?.length) {
    action = "GOOGLECALENDAR_PATCH_EVENT";
    args = { event_id: s.eventId, attendees: s.attendees, send_updates: "all" };
  } else return { ok: false, error: "Nothing to send." };
  try {
    const r = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true });
    if (r && (r.successful === false || r.error)) return { ok: false, error: String(r.error || "Send failed.") };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
var EMPTY = { tools: [], call: async () => null, connected: [] };
async function sendSelfBrief(userId, subject, body) {
  if (!integrationsReady() || !userId) return "ERROR: integrations not configured";
  const subj = String(subject || "").trim().slice(0, 200);
  const text = String(body || "").trim().slice(0, 8e3);
  if (!subj || !text) return "ERROR: subject and body are required";
  let to = userId;
  try {
    to = (await getConnectedAccounts(userId, "gmail"))[0]?.email || userId;
  } catch {
  }
  if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(to)) return "ERROR: no usable own-address to send to";
  try {
    const r = await sdk().tools.execute("GMAIL_SEND_EMAIL", {
      userId,
      arguments: { recipient_email: to, subject: subj, body: text },
      dangerouslySkipVersionCheck: true
    });
    if (r && (r.successful === false || r.error)) return `ERROR: ${String(r.error || "send failed")}`;
    return `Sent the brief to ${to} (the user's own inbox).`;
  } catch (e) {
    return `ERROR: ${e?.message ?? e}`;
  }
}
var cache = /* @__PURE__ */ new Map();
var CACHE_MS = 12e4;
var sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
function relevance(n) {
  let s = 0;
  if (/(EVENT|MESSAGE|EMAIL|THREAD|DRAFT|FILE|DOCUMENT|FOLDER|SHEET|SPREADSHEET|ROW|CELL|SLIDE|PRESENTATION|ISSUE|PULL|COMMENT|TASK|REPO|CONTACT|PEOPLE|FREE.?SLOT|FREEBUSY)/.test(n)) s += 3;
  if (/(FIND|SEARCH|LIST|GET|FETCH|READ|CREATE|UPDATE|PATCH|ADD|INSERT|MODIFY|APPEND|MOVE|COPY)/.test(n)) s += 2;
  if (/(ACL|CHANNEL|WATCH|STOP|QUOTA|SETTING|COLOR|DUPLICATE|PERMISSION|SCOPE|SUBSCRIPTION|WEBHOOK|CALENDAR_LIST|CALENDARS_|CREATE_CALENDAR)/.test(n)) s -= 4;
  return s;
}
var isRead = (n) => /(GET|LIST|FIND|SEARCH|FETCH|READ|DOWNLOAD|EXPORT|FREE_BUSY|INSTANCES)/.test(n) && !/(CREATE|UPDATE|INSERT|APPEND|ADD|PATCH|MODIFY|DELETE|REMOVE|WRITE|REPLACE|COPY|MOVE|BATCH_UPDATE|BATCH_MODIFY|SET_)/.test(n);
async function getAgentTools(userId) {
  if (!integrationsReady() || !userId) return EMPTY;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const connected = await listConnectedToolkits(userId);
  if (!connected.length) {
    const data2 = { ...EMPTY, connected };
    cache.set(userId, { at: Date.now(), data: data2 });
    return data2;
  }
  const tools = [];
  const map = /* @__PURE__ */ new Map();
  const MAX = 200;
  const perToolkit = Math.min(20, Math.max(8, Math.floor(MAX / connected.length)));
  const PRIORITY = ["gmail", "googlecalendar", "googledocs", "googledrive", "googlesheets", "googleslides", "slack", "notion", "linear", "todoist"];
  const rank = (a) => {
    const i = PRIORITY.indexOf(a);
    return i === -1 ? PRIORITY.length : i;
  };
  const ordered = [...connected].sort((a, b) => rank(a) - rank(b));
  for (const app2 of ordered) {
    if (tools.length >= MAX) break;
    let raw = [];
    try {
      raw = await sdk().tools.get(userId, { toolkits: [app2.toUpperCase()], limit: 300 });
    } catch {
      raw = [];
    }
    const ranked = (Array.isArray(raw) ? raw : []).map((t) => ({ t, rawName: String((t?.function ?? t)?.name ?? t?.name ?? t?.slug ?? "").trim() })).filter((x) => x.rawName && !isGatedAction(x.rawName)).sort((a, b) => relevance(b.rawName) - relevance(a.rawName));
    const reads = ranked.filter((x) => isRead(x.rawName));
    const writes = ranked.filter((x) => !isRead(x.rawName));
    const readQuota = Math.ceil(perToolkit * 0.6);
    const chosen = [...reads.slice(0, readQuota), ...writes.slice(0, perToolkit - Math.min(readQuota, reads.length))];
    for (const x of ranked) {
      if (chosen.length >= perToolkit) break;
      if (!chosen.includes(x)) chosen.push(x);
    }
    let added = 0;
    for (const { t, rawName } of chosen) {
      if (tools.length >= MAX || added >= perToolkit) break;
      const name = sanitize(rawName);
      if (map.has(name)) continue;
      map.set(name, rawName);
      const fn = t?.function ?? t;
      const params = fn?.parameters ?? t?.parameters ?? t?.input_parameters ?? t?.inputSchema ?? {};
      const input_schema = params && typeof params === "object" ? { type: "object", properties: params.properties ?? {}, ...Array.isArray(params.required) ? { required: params.required } : {} } : { type: "object", properties: {} };
      tools.push({ name, description: `[${app2}] ${String(fn?.description ?? rawName).slice(0, 600)}`, input_schema });
      added++;
    }
  }
  const call = async (name, args) => {
    const action = map.get(name);
    if (!action) return null;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete \u2014 leave it as a step for the user instead.`;
    if (isWriteGatedAction(action)) {
      return `PERMISSION_REQUIRED: "${action}" requires explicit user approval before it can run. Add it as an automatable step in submit() so the user can approve it with one click.`;
    }
    if (/^GOOGLECALENDAR_/.test(action) && args && ("attendees" in args || "send_updates" in args)) {
      args = { ...args, send_updates: "none" };
    }
    try {
      return await execute(action, userId, args || {});
    } catch (e) {
      return `Tool error (${action}): ${e?.message ?? e}`;
    }
  };
  const data = {
    tools,
    call,
    connected,
    // Only offered when Gmail is connected — that's both the send channel and the recipient source.
    selfBrief: connected.includes("gmail") ? (subject, body) => sendSelfBrief(userId, subject, body) : void 0
  };
  cache.set(userId, { at: Date.now(), data });
  return data;
}
var statusCache = /* @__PURE__ */ new Map();
async function connectionStatusesCached(userId, apps) {
  if (!integrationsReady() || !userId) return Object.fromEntries(apps.map((a) => [a, false]));
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < 3e4) return hit.data;
  const data = await getAllConnectionStatuses(userId, apps);
  statusCache.set(userId, { at: Date.now(), data });
  return data;
}
function invalidateTools(userId) {
  cache.delete(userId);
  statusCache.delete(userId);
}
async function getAgentToolsWithPermission(userId) {
  const base = await getAgentTools(userId);
  if (!base.tools.length) return base;
  const permCall = async (name, args) => {
    const action = name;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete.`;
    if (/^GOOGLECALENDAR_/.test(action) && args && ("attendees" in args || "send_updates" in args)) {
      args = { ...args, send_updates: "none" };
    }
    try {
      return await execute(action, userId, args || {});
    } catch (e) {
      return `Tool error (${action}): ${e?.message ?? e}`;
    }
  };
  return { tools: base.tools, call: permCall, connected: base.connected, selfBrief: base.selfBrief };
}

// server/index.ts
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = Number(process.env.PORT || 8788);
var PROD = process.env.NODE_ENV === "production";
if (PROD) {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set in production \u2014 it signs the session cookie that gates account access.");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY must be set in production \u2014 required for AI task generation and execution.");
  }
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY must be set in production \u2014 required for app integrations.");
  }
  if (!process.env.PUBLIC_URL) {
    throw new Error("PUBLIC_URL must be set in production \u2014 required for OAuth callbacks.");
  }
}
var app = express();
app.set("trust proxy", 1);
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(session2({
  store: await makeSessionStore(),
  // Supabase-backed when cloud is configured → sessions survive restarts/deploys
  secret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 30 * 24 * 3600 * 1e3 }
}));
app.use(async (req, _res, next) => {
  try {
    if (req.session.user && (req.session.tasks === void 0 || req.session.profile === void 0)) {
      const st = await loadState(req.session.user);
      if (req.session.tasks === void 0) req.session.tasks = st.tasks;
      if (req.session.profile === void 0) req.session.profile = st.profile;
    }
  } catch {
  }
  next();
});
var saveSession = (req) => new Promise((r) => req.session.save((err) => {
  if (err) console.warn("[session] save failed:", err?.message || err);
  r();
}));
var mergeTasks = (existing, incoming) => {
  const map = /* @__PURE__ */ new Map();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) {
    const ext = map.get(t.id);
    if (!ext) {
      map.set(t.id, t);
    } else {
      const rank = (s) => s === "done" || s === "dismissed" ? 4 : s === "executed" ? 3 : s === "running" ? 2 : 1;
      if (rank(t.status) >= rank(ext.status)) {
        map.set(t.id, { ...ext, ...t });
      }
    }
  }
  return Array.from(map.values());
};
var mergeProfiles = (p1, p2) => {
  return {
    name: p2.name || p1.name,
    about: p2.about || p1.about,
    preferences: dedupeFacts([...p1.preferences || [], ...p2.preferences || []]),
    people: dedupeFacts([...p1.people || [], ...p2.people || []]),
    projects: dedupeFacts([...p1.projects || [], ...p2.projects || []])
  };
};
var commit = async (req) => {
  await saveSession(req);
  if (req.session.user) {
    try {
      const current = await loadState(req.session.user);
      const mergedTasks = mergeTasks(current.tasks || [], req.session.tasks || []);
      const mergedProfile = mergeProfiles(current.profile || emptyProfile(), req.session.profile || emptyProfile());
      req.session.tasks = mergedTasks;
      req.session.profile = mergedProfile;
      await saveState(req.session.user, { profile: mergedProfile, tasks: mergedTasks });
    } catch {
      await saveState(req.session.user, {
        profile: req.session.profile || emptyProfile(),
        tasks: req.session.tasks || []
      });
    }
  }
};
var requireAuth = (req, res, next) => {
  if (!req.session.user) {
    res.status(401).json({ error: "not logged in" });
    return;
  }
  next();
};
var rlHits = /* @__PURE__ */ new Map();
var rateLimit = (max, windowMs) => (req, res, next) => {
  const key2 = `${req.session.user || req.ip}:${req.path}`;
  const now = Date.now();
  const hits = (rlHits.get(key2) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retry = Math.ceil((windowMs - (now - hits[0])) / 1e3);
    res.set("Retry-After", String(retry)).status(429).json({ error: `Too many requests \u2014 give it ${retry}s.` });
    return;
  }
  hits.push(now);
  rlHits.set(key2, hits);
  if (rlHits.size > 5e3) {
    for (const [k, v] of rlHits) if (!v.some((t) => now - t < windowMs)) rlHits.delete(k);
  }
  next();
};
var toolsFor = (req) => getAgentTools(req.session.user).catch(() => void 0);
var normEmail = (s) => String(s || "").trim().toLowerCase();
var validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
app.post("/api/auth/signup", async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!validEmail(email) || password.length < 6) {
    res.status(400).json({ error: "Enter a valid email and a password of at least 6 characters." });
    return;
  }
  if (!cloudEnabled()) {
    res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." });
    return;
  }
  if (await getUser(email)) {
    res.status(409).json({ error: "An account with that email already exists \u2014 log in instead." });
    return;
  }
  if (!await createUser(email, bcrypt.hashSync(password, 10))) {
    res.status(500).json({ error: "Couldn't create the account." });
    return;
  }
  req.session.user = email;
  await saveSession(req);
  res.json({ ok: true });
});
app.post("/api/auth/login", async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const u = await getUser(email);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }
  req.session.user = email;
  const restored = await loadState(email);
  req.session.profile = restored.profile;
  req.session.tasks = restored.tasks;
  await saveSession(req);
  res.json({ ok: true });
});
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/integrations", requireAuth, async (req, res) => {
  const ready = integrationsReady();
  const apps = CATALOG.map((c) => c.key);
  const statuses = ready ? await getAllConnectionStatuses(req.session.user, apps, req.session.integrations || {}) : {};
  res.json({
    ready,
    items: CATALOG.map((c) => ({ key: c.key, name: c.name, blurb: c.blurb, category: c.category, logo: logoFor(c.toolkit), connected: !!statuses[c.key] }))
  });
});
app.get("/api/integrations/:app/accounts", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  if (!CATALOG.some((c) => c.key === app2)) {
    res.status(404).json({ error: "Unknown integration." });
    return;
  }
  const accounts = integrationsReady() ? await getConnectedAccounts(req.session.user, app2) : [];
  res.json({ accounts });
});
app.get("/integrations/:app/connect", requireAuth, async (req, res) => {
  try {
    if (!integrationsReady()) {
      res.status(500).send("Integrations aren't configured on the server (COMPOSIO_API_KEY).");
      return;
    }
    const app2 = String(req.params.app);
    if (!CATALOG.some((c) => c.key === app2)) {
      res.status(404).send("Unknown integration.");
      return;
    }
    const callbackUrl = `${process.env.PUBLIC_URL || `http://localhost:5273`}/integrations/callback`;
    const { redirectUrl, connectionId } = await initiateConnection(app2, req.session.user, callbackUrl);
    (req.session.integrations ||= {})[app2] = connectionId;
    invalidateTools(req.session.user);
    req.session.save(() => res.redirect(redirectUrl));
  } catch (e) {
    res.status(500).send("Couldn't start the connection: " + (e?.message || e));
  }
});
app.get("/integrations/callback", (_req, res) => res.redirect("/settings"));
app.post("/api/integrations/:app/disconnect", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  const result = integrationsReady() ? await disconnect(app2, req.session.user) : { ok: true };
  if (req.session.integrations) delete req.session.integrations[app2];
  invalidateTools(req.session.user);
  await saveSession(req);
  res.json(result);
});
app.post("/api/integrations/:app/disconnect/:accountId", requireAuth, async (req, res) => {
  const app2 = String(req.params.app);
  const accountId = String(req.params.accountId);
  const accounts = integrationsReady() ? await getConnectedAccounts(req.session.user, app2) : [];
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const result = await disconnectAccount(accountId);
  invalidateTools(req.session.user);
  await saveSession(req);
  res.json(result);
});
app.get("/api/status", async (req, res) => {
  let googleConnected = false;
  if (req.session.user && integrationsReady()) {
    try {
      googleConnected = !!(await connectionStatusesCached(req.session.user, ["gmail"]))["gmail"];
    } catch {
    }
  }
  const s = {
    loggedIn: !!req.session.user,
    user: req.session.user,
    name: req.session.profile?.name,
    googleConnected,
    aiReady: aiReady(),
    googleConfigured: integrationsReady(),
    // Composio is what powers Google + every integration now
    cloud: cloudEnabled()
  };
  res.json(s);
});
app.get("/api/tasks", requireAuth, (req, res) => {
  res.json(req.session.tasks || []);
});
var lastGenDate = /* @__PURE__ */ new Map();
var genInflight = /* @__PURE__ */ new Map();
var today = () => (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
app.post("/api/tasks/generate", requireAuth, rateLimit(10, 6e4), async (req, res) => {
  try {
    const todayStr = today();
    const force = req.body?.force === true;
    const lastGen = lastGenDate.get(req.session.user) || req.session.lastGenDay;
    if (!force && lastGen === todayStr && (req.session.tasks || []).length) {
      res.json(req.session.tasks);
      return;
    }
    const extras = await toolsFor(req);
    if (!extras?.tools?.length) {
      res.status(400).json({ error: "Connect an app (Gmail, Calendar, Slack, etc.) in Settings so Otto has something to read." });
      return;
    }
    const user = req.session.user;
    let sweep = genInflight.get(user);
    if (!sweep) {
      sweep = (async () => {
        req.session.tasks = await generate(req.session.tasks || [], req.session.profile ||= emptyProfile(), extras);
        lastGenDate.set(user, todayStr);
        req.session.lastGenDay = todayStr;
        await commit(req);
      })().finally(() => genInflight.delete(user));
      genInflight.set(user, sweep);
    }
    await sweep;
    res.json(req.session.tasks);
  } catch (e) {
    console.error("[tasks] generate error:", e);
    res.status(500).json({ error: e?.message || "generate failed" });
  }
});
app.post("/api/tasks", requireAuth, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const refined = aiReady() ? await refineManualTask(title, req.session.profile) : null;
  req.session.tasks = addManual(req.session.tasks || [], title, refined);
  await commit(req);
  res.json(req.session.tasks);
});
var runningTasks = /* @__PURE__ */ new Set();
var withTaskLock = async (id, res, fn) => {
  if (runningTasks.has(id)) {
    res.status(409).json({ error: "already running" });
    return;
  }
  runningTasks.add(id);
  try {
    await fn();
  } finally {
    runningTasks.delete(id);
  }
};
app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 6e4), async (req, res) => {
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const t = await runById(req.session.tasks || [], String(req.params.id), req.session.profile ||= emptyProfile(), await toolsFor(req));
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e) {
      console.error("[tasks] run error for task", req.params.id, ":", e);
      res.status(500).json({ error: e?.message || "run failed" });
    }
  });
});
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 6e4), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) {
    res.status(400).json({ error: "note required" });
    return;
  }
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const t = await runById(req.session.tasks || [], String(req.params.id), req.session.profile ||= emptyProfile(), await toolsFor(req), note);
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e) {
      console.error("[tasks] revise error for task", req.params.id, ":", e);
      res.status(500).json({ error: e?.message || "revise failed" });
    }
  });
});
app.post("/api/tasks/:id/confirm", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "done";
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/reject", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    reject(req.session.tasks || [], id);
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/dismiss", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "dismissed";
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 6e4), async (req, res) => {
  await withTaskLock(String(req.params.id), res, async () => {
    try {
      const permTools = await getAgentToolsWithPermission(req.session.user).catch(() => void 0);
      const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : void 0;
      const t = await runStep(req.session.tasks || [], String(req.params.id), Number(req.params.index), req.session.profile ||= emptyProfile(), permTools, answer);
      await commit(req);
      res.json(t || { error: "not found" });
    } catch (e) {
      console.error("[tasks] step run error for task", req.params.id, "step", req.params.index, ":", e);
      res.status(500).json({ error: e?.message || "step run failed" });
    }
  });
});
app.post("/api/tasks/:id/step/:index/done", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const done = req.body?.done !== false;
  const result = typeof req.body?.result === "string" ? req.body.result : void 0;
  const task = (req.session.tasks || []).find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (step) {
    step.done = done;
    step.doneAt = done ? (/* @__PURE__ */ new Date()).toISOString() : void 0;
    if (result !== void 0) step.result = result;
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/send/:index", requireAuth, async (req, res) => {
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  const s = t?.sendables?.[Number(req.params.index)];
  if (!t || !s) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!s.sent) {
    const r = await sendSendable(req.session.user, s);
    if (!r.ok) {
      res.status(500).json({ error: r.error || "send failed" });
      return;
    }
    s.sent = true;
    await commit(req);
  }
  res.json(t);
});
app.post("/api/chat", requireAuth, rateLimit(20, 6e4), async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string").slice(-20) : [];
    if (!messages.length) {
      res.status(400).json({ error: "messages required" });
      return;
    }
    const live = (req.session.tasks || []).filter((t) => t.status !== "done" && t.status !== "dismissed").slice(0, 25);
    const tasksSummary = live.map((t) => `- ${t.title}${t.when ? ` (${t.when})` : ""}`).join("\n");
    const out = await chat(messages, req.session.profile, tasksSummary);
    if (out.profileUpdates?.length) {
      const profile = req.session.profile ||= emptyProfile();
      for (const u of out.profileUpdates) applyProfileUpdate(profile, u);
      await commit(req);
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || "chat failed" });
  }
});
var listKey = (c) => c === "preference" ? "preferences" : c === "person" ? "people" : c === "project" ? "projects" : "";
app.get("/api/profile", requireAuth, (req, res) => {
  res.json(req.session.profile || emptyProfile());
});
app.post("/api/profile", requireAuth, async (req, res) => {
  const p = req.session.profile ||= emptyProfile();
  const category = String(req.body?.category || "");
  const value = String(req.body?.value || "").trim();
  if (category === "name") {
    p.name = value.slice(0, 60) || void 0;
  } else if (category === "about") {
    p.about = value.slice(0, 400);
  } else {
    const k = listKey(category);
    if (k && value && !p[k].some((x) => x.toLowerCase() === value.toLowerCase())) p[k].push(value.slice(0, 160));
  }
  await commit(req);
  res.json(p);
});
app.delete("/api/profile", requireAuth, async (req, res) => {
  req.session.profile = emptyProfile();
  await commit(req);
  res.json(req.session.profile);
});
app.delete("/api/profile/:category/:index", requireAuth, async (req, res) => {
  const p = req.session.profile ||= emptyProfile();
  const k = listKey(String(req.params.category));
  const i = Number(String(req.params.index));
  if (k && Array.isArray(p[k]) && i >= 0 && i < p[k].length) {
    p[k].splice(i, 1);
    await commit(req);
  }
  res.json(p);
});
if (PROD && !process.env.VERCEL) {
  const dist = path.resolve(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => {
    if (path.extname(req.path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(dist, "index.html"));
  });
}
process.on("unhandledRejection", (reason) => console.error("[weave-web] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[weave-web] uncaughtException:", err));
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[weave-web] listening on :${PORT} (${PROD ? "production" : "dev"})`));
}
var index_default = app;
export {
  index_default as default
};
