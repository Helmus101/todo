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
var canonStatus = (s) => s === "running" ? "executing" : s === "executed" ? "needs_review" : s;
var isHandled = (s) => s === "done" || s === "dismissed";
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
    projects: dedupeFacts(arr(p?.projects)),
    paused: !!p?.paused,
    pausedAt: typeof p?.pausedAt === "string" ? p.pausedAt : void 0,
    lastSweepAt: typeof p?.lastSweepAt === "string" ? p.lastSweepAt : void 0,
    lastForcedAt: typeof p?.lastForcedAt === "string" ? p.lastForcedAt : void 0,
    // Structured preferences
    workingHours: p?.workingHours && typeof p.workingHours === "object" ? {
      start: String(p.workingHours.start || "09:00"),
      end: String(p.workingHours.end || "18:00"),
      timezone: String(p.workingHours.timezone || "UTC")
    } : void 0,
    responseStyle: ["concise", "detailed", "casual", "formal"].includes(p?.responseStyle) ? p.responseStyle : void 0,
    autoApprove: Array.isArray(p?.autoApprove) ? p.autoApprove.map(String) : void 0,
    highPriorityPeople: Array.isArray(p?.highPriorityPeople) ? p.highPriorityPeople.map(String) : void 0,
    autoArchivePatterns: Array.isArray(p?.autoArchivePatterns) ? p.autoArchivePatterns.map(String) : void 0,
    // Trust/confidence system
    confidence: p?.confidence && typeof p.confidence === "object" ? p.confidence : void 0,
    confidenceHistory: Array.isArray(p?.confidenceHistory) ? p.confidenceHistory.slice(-100) : void 0,
    usage: p?.usage && typeof p.usage === "object" ? {
      in: Number(p.usage.in) || 0,
      out: Number(p.usage.out) || 0,
      runs: Number(p.usage.runs) || 0,
      since: typeof p.usage.since === "string" ? p.usage.since : (/* @__PURE__ */ new Date()).toISOString()
    } : void 0
  };
}
function addUsage(profile, tokens) {
  const tin = Number(tokens?.in) || 0, tout = Number(tokens?.out) || 0;
  if (!tin && !tout) return;
  const u = profile.usage || { in: 0, out: 0, runs: 0, since: (/* @__PURE__ */ new Date()).toISOString() };
  profile.usage = { in: u.in + tin, out: u.out + tout, runs: u.runs + 1, since: u.since };
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
var RANK_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function deadlineEpoch(when, now = /* @__PURE__ */ new Date()) {
  const s = String(when || "").trim().toLowerCase();
  if (!s) return Infinity;
  if (/\btoday\b|\btonight\b|\bnow\b/.test(s)) return now.getTime();
  if (/\btomorrow\b/.test(s)) return now.getTime() + 864e5;
  if (/\b20\d{2}\b/.test(s)) {
    const iso = Date.parse(s);
    if (!isNaN(iso)) return iso;
  }
  const md = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/);
  if (md && RANK_MONTHS[md[1]] !== void 0) {
    const d = new Date(now.getFullYear(), RANK_MONTHS[md[1]], Number(md[2]));
    if (d.getTime() < now.getTime() - 180 * 864e5) d.setFullYear(now.getFullYear() + 1);
    return d.getTime();
  }
  return Infinity;
}
function sortWithinQuadrant(list, highPriorityPeople = [], now = /* @__PURE__ */ new Date()) {
  const vipTokens = highPriorityPeople.flatMap((v) => {
    const email = v.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const name = v.split(/[—\-(,]/)[0].trim().toLowerCase();
    return [email, name.length >= 3 ? name : void 0].filter((x) => !!x);
  });
  const isVip = (t) => {
    const hay = `${t.why || ""} ${t.title || ""} ${t.source || ""}`.toLowerCase();
    return vipTokens.some((tok) => hay.includes(tok));
  };
  const fresh = (t) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  return [...list].sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
    const da = deadlineEpoch(a.when, now), db = deadlineEpoch(b.when, now);
    if (da !== db) return da - db;
    const va = isVip(a) ? 1 : 0, vb = isVip(b) ? 1 : 0;
    if (va !== vb) return vb - va;
    return fresh(b) - fresh(a);
  });
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
      const code = String(e?.code || e?.cause?.code || "");
      const msg = `${e?.message || ""} ${e?.cause?.message || ""}`;
      const isNetworkError = ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || /fetch failed|socket hang up|terminated|aborted|premature close|network|other side closed/i.test(msg) || [429, 500, 502, 503, 504].includes(Number(e?.status));
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
  if (p.workingHours) parts.push(`Working hours: ${p.workingHours.start}-${p.workingHours.end} (${p.workingHours.timezone})`);
  if (p.responseStyle) parts.push(`Response style: ${p.responseStyle}`);
  if (p.autoApprove?.length) parts.push(`Prefers automated handling of: ${p.autoApprove.join(", ")} (preference only \u2014 the permission system still decides; gated actions still need approval)`);
  if (p.highPriorityPeople?.length) parts.push(`High-priority people: ${p.highPriorityPeople.join(", ")}`);
  if (p.autoArchivePatterns?.length) parts.push(`Considers noise (never surface as tasks): ${p.autoArchivePatterns.join(", ")}`);
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
function isTransient(e) {
  const code = String(e?.code || e?.cause?.code || "");
  if (["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
  const msg = `${e?.message || ""} ${e?.cause?.message || ""}`;
  if (/fetch failed|socket hang up|terminated|aborted|premature close|network|other side closed/i.test(msg)) return true;
  return [429, 500, 502, 503, 504].includes(Number(e?.status));
}
async function retryRequest2(fn, retries = 3, delayMs = 1e3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === retries - 1) throw e;
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
var TRIM_KEEP = 4;
var TRIM_TO = 250;
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
var GEN_SYSTEM = `You are an autonomous operations assistant \u2014 a sharp chief-of-staff turning someone's live world into their real, COMPLETE to-do list. Your job is to FIND, PRIORITIZE, and EXECUTE work \u2014 not just record it. Use EVERY tool available \u2014 across ALL their connected apps, not just email \u2014 to READ what genuinely needs them right now, then call submit_tasks. Sweep each connected source AGGRESSIVELY for actionable items, e.g.:
- Gmail: threads awaiting a reply or asking something (skip newsletters/promos/receipts/no-reply).
NEWSLETTERS & PROMOTIONAL EMAIL \u2014 HARD EXCLUSION: NEVER create a task to reply to, respond to, or otherwise engage with a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender \u2014 a Gmail "promotions"/"social" category, an unsubscribe footer, or a sender containing "noreply"/"no-reply"/"newsletter"/"marketing"/"updates@"/"news@" are all signals of this. This holds even if the email asks a question, has a "reply" call-to-action, or looks personalized \u2014 it's still mass mail. Skip it entirely; do not surface it as a to-do of any kind.
- Calendar: meetings in the next ~48h to prepare for or respond to, conflicts to resolve.
- Slack / Discord: DMs & mentions awaiting your reply.
- GitHub / Linear / Jira: issues & PRs assigned to you, review requests, things blocking others.
- Notion / Todoist / Asana / Trello / ClickUp: tasks assigned or due soon.
- CRM (HubSpot, Salesforce): deals needing follow-up, tasks due, opportunities at risk.
- Any other connected app: whatever is genuinely waiting on this person.
- COMMITMENTS THEY MADE: also check their recently SENT mail/messages (e.g. Gmail search "in:sent newer_than:7d") for promises THEY made to others \u2014 "I'll send you X", "I'll get back to you by Friday", "let me check and follow up" \u2014 and create a task to FULFILL each one that looks unfulfilled (no later reply/attachment in the thread). Title it as the commitment ("Send Sarah the budget deck"), set "when" from the promised deadline, and anchor it to the sent thread ('gmail:<threadId>'). A broken promise is worse than a missed email.
- CONTEXT GATHERING: For every actionable item, GATHER FULL CONTEXT \u2014 search related threads, check calendar for conflicts, find relevant docs, pull in CRM data. A task without context is half-baked.
Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a sender is, a public deadline).
GMAIL \u2014 SEARCH IT SEVERAL WAYS, not one generic fetch: (1) recent inbox needing action ("in:inbox newer_than:7d -category:promotions -category:social"), (2) unread ("is:unread in:inbox"), (3) their SENT mail for open loops ("in:sent newer_than:10d") \u2014 read what THEY promised and check whether they delivered, (4) threads where someone asked them something and the last message is NOT theirs (they owe a reply), (5) search for key people/projects from their profile to find loose ends.
USE THEIR PROFILE AS SEARCH LEADS: pick the 2-3 most active projects/people listed below and run ONE targeted search each (the name in Gmail or the relevant app) to find loose ends \u2014 an unanswered thread, an upcoming deadline, a doc waiting on them. What did they say they'd do but haven't?
PREFERENCES ARE BINDING, not decoration \u2014 the "Preferences" lines in their profile MUST shape the list:
- FILTER: if a preference says they don't care about something (a topic, a sender, a kind of work), do NOT create tasks for it, even if it looks actionable.
- RANK: raise importance for tasks matching what they've said matters (their priorities, projects, people); lower it for what they've deprioritized. Two equal emails \u2260 two equal tasks if a preference separates them.
- SHAPE: phrase titles/whys in line with how they work (e.g. "batch admin on Fridays" \u2192 set "when" accordingly; "prefers calls over email" \u2192 the task suggests a call). When a preference influenced a task, reflect it in "why".
- WORKING HOURS: if they have working hours set, consider whether tasks can be done within those hours.
- RESPONSE STYLE: if they prefer concise/detailed/casual/formal, this should influence how you phrase tasks.
- AUTO-APPROVE: if they've approved certain categories (e.g., "schedule_meetings_under_30min"), mark those as low risk.
- HIGH PRIORITY PEOPLE: if someone is in their high-priority list, their requests get higher urgency.
- AUTO-ARCHIVE: if they've set patterns to auto-archive (e.g., newsletters), filter those out.
NEVER resurface a to-do the user already finished or DISMISSED \u2014 if an "ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ONE TASK PER UNDERLYING ITEM: never submit two wordings of the same to-do \u2014 one thread/event/commitment = ONE task, with its stable anchorKey. If two findings point at the same obligation, merge them into one task.
QUALITY OVER QUANTITY \u2014 surface the handful (\u2264 ~12) of items that genuinely matter; skip marginal "maybes". A short list the user trusts beats a complete list they ignore.
READ ONLY here \u2014 do NOT create, modify, draft, or send anything during generation. BUDGET: you have roughly 6-8 tool calls TOTAL \u2014 batch your Gmail searches into ONE round (issue them as parallel calls), give each other app ONE targeted read, never re-read the same source, and submit as soon as you have the picture. Thorough \u2260 exhaustive.`;
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
var ANCHORED_SOURCES = /* @__PURE__ */ new Set(["gmail", "calendar", "googlecalendar", "slack"]);
function parseGenerated(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => t && typeof t.title === "string" && t.title.trim().length >= 4 && String(t.why || "").trim()).filter((t) => !ANCHORED_SOURCES.has(String(t.source || "").trim().toLowerCase()) || !!String(t.anchorKey || "").trim() || /^https?:\/\//i.test(String(t.link || ""))).map((t) => ({
    title: String(t.title).slice(0, 90),
    why: String(t.why || "").slice(0, 400),
    when: t.when ? String(t.when).slice(0, 40) : void 0,
    source: typeof t.source === "string" && t.source.trim() ? t.source.trim().toLowerCase().slice(0, 24) : "gmail",
    risk: t.risk === "high" ? "high" : "low",
    urgency: clamp01(t.urgency ?? 0.5),
    importance: clamp01(t.importance ?? 0.6),
    anchorKey: t.anchorKey ? String(t.anchorKey).trim().slice(0, 120) : void 0,
    link: t.link && /^https?:\/\//i.test(String(t.link)) ? String(t.link) : void 0
  })).slice(0, 20);
}
async function generateTasks(profile, extras, handled, active) {
  const empty = { tasks: [], profileUpdates: [] };
  if (!extras?.tools?.length) return empty;
  const tools = [...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.` : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length ? `
ALREADY HANDLED \u2014 I already finished or dismissed these; do NOT create a task for any of them again, even if its source email/event is still around. A dismissal is a PREFERENCE SIGNAL: I looked at that task and said no \u2014 so also skip anything SIMILAR to a dismissed item (same thread, same kind of ask, same sender's request reworded):
` + handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `
` : "";
  const activeBlock = active?.length ? `
ALREADY ON THEIR LIST (active) \u2014 do NOT re-report these; submit ONLY items that are on NEITHER this list nor the handled list. If nothing new is waiting, submit an empty list \u2014 that is a GOOD answer:
` + active.slice(0, 30).map((a) => `- ${a.title}${a.anchorKey ? ` [${a.anchorKey}]` : ""}`).join("\n") + `
` : "";
  const messages = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + activeBlock + handledBlock + `
${connectedLine}
Sweep across all of them for everything genuinely awaiting me that is NOT already covered above \u2014 including what I promised others and haven't done yet (check my sent mail), and loose ends on my projects/people above \u2014 then call submit_tasks with the NEW actionable items. Respect my stated preferences above when choosing, ranking, and phrasing tasks.`
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  const MAX = 6;
  let tokIn = 0, tokOut = 0, rounds = 0;
  let didRead = false;
  let lazyRejected = false;
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
            const parsed = { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
            if (!parsed.tasks.length && !didRead && !lazyRejected) {
              lazyRejected = true;
              content = "Rejected: you submitted before sweeping. Read the connected apps first (batch your searches), then resubmit \u2014 an empty list is only acceptable AFTER you have actually looked.";
            } else {
              submitted = parsed;
              content = "submitted";
            }
          } else if (toolName === "web_search") {
            didRead = true;
            content = await runWebSearch(input);
          } else {
            didRead = true;
            const r = await extras.call(toolName, input || {});
            content = r ?? `Unknown tool: ${toolName}`;
          }
        } catch (e) {
          content = "ERROR: " + (e?.message || e);
        }
        messages.push({ role: "tool", tool_call_id: tu.id || `tool_${Date.now()}`, content: String(content).slice(0, 2e3) });
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
async function classifyCandidates(items, profile, activeTitles) {
  if (!items.length) return { tasks: [], profileUpdates: [] };
  const list = items.slice(0, 30).map((it, i) => `#${i} [${it.sourceApp}${it.labels.includes("sent") ? "/SENT-BY-USER" : ""}${it.labels.includes("shared") ? "/SHARED-WITH-USER" : ""}${it.labels.includes("assigned") ? "/ASSIGNED-TO-USER" : ""}${it.labels.includes("review-requested") ? "/REVIEW-REQUESTED" : ""}] from:"${it.sender || "?"}" when:"${it.timestamp || "?"}" title:"${it.title}" body:"${it.snippet}"`).join("\n");
  const activeBlock = activeTitles?.length ? `
ALREADY ON THEIR LIST (skip anything covering these):
${activeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}
` : "";
  const sys = `You classify a person's inbox/calendar/drive items into their to-do list. For each candidate decide if it GENUINELY needs them to act. Inbox items: does someone await their reply / ask something of them? SENT-BY-USER items are commitments THEY made ("I'll send you X") \u2014 create a task to FULFILL unfulfilled ones. Events: only if prep or a response is genuinely needed (within ~48h, or with real stakes). SHARED-WITH-USER files: only if someone is clearly waiting on their review/input. GitHub ASSIGNED-TO-USER issues and REVIEW-REQUESTED PRs are actionable while open. Skip FYIs, receipts, automated mail, and anything already on their list. USE THEIR PROFILE: items from their HIGH-PRIORITY people or touching their stated projects rank HIGHER (importance \u2265 0.7); things their preferences deprioritize rank lower or get skipped. Quality over quantity \u2014 the handful that matter. ALWAYS include: a direct question or request from a real person awaiting their reply; a SENT-BY-USER commitment ("I'll send/do/call\u2026") with no later fulfilment visible; an event in the next 48h that plainly needs prep. When such an item exists, an empty tasks list is WRONG.
CONSOLIDATE \u2014 one real-world obligation = ONE task. If several candidates concern the SAME thing (a calendar event AND the email thread that set it up; several copies of one outreach the user sent), emit a SINGLE task and pick the candidate the user must ACT on to anchor it (prefer the email/thread they need to handle; else the event). NEVER emit two tasks for one meeting, thread, or commitment. Each task's title must name a DISTINCT obligation \u2014 if two of your tasks would start with the same verb+object, merge them.
SCORING: an item you judge actionable is, by definition, NOT trivial \u2014 score a genuine reply/commitment at importance \u2265 0.5, and higher (\u2265 0.7) for high-priority people or stated projects. urgency reflects the deadline: \u2265 0.7 within ~48h, ~0.5 this week, lower if open-ended. Never score an actionable item you're returning below 0.4 on BOTH axes \u2014 if it's that trivial, omit it instead.
TITLES MUST BE SPECIFIC \u2014 name the actual person/company AND the actual subject, so the task is clear without opening anything. GOOD: "Reply to Chloe at BOND about the demo", "Send media-coverage docs to Paris Model Congress", "Confirm attendance to Guillaume's Aug call". BAD (too vague \u2014 never do this): "Follow up on sent email", "Reply to email", "Respond to message", "Handle request". If you can't name the person or subject from the candidate, you don't understand it well enough to include it \u2014 omit it.
Answer with STRICT JSON only: {"tasks":[{"i":<candidate #>,"title":"specific imperative naming who+what, \u226411 words","why":"one clause naming the concrete trigger","when":"the REAL deadline stated in or directly implied by the item \u2014 NEVER an invented one; '' if none","urgency":0..1,"importance":0..1,"risk":"low"|"high"}],"profileUpdates":[{"category":"preference"|"person"|"project"|"name"|"about","fact":"one short sentence"}]} \u2014 profileUpdates: 0-3 DURABLE facts about who this person is that these items reveal (a key relationship, an ongoing project) \u2014 only lasting identity facts, not task content. Empty arrays are fine.`;
  const client2 = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  let tokIn = 0, tokOut = 0, calls = 0;
  const ask = async (extra) => {
    calls++;
    const res = await retryRequest2(() => client2.chat.completions.create({
      model: actualModel,
      max_tokens: 1800,
      // Determinism guards: JSON mode + near-zero temperature. Without them the same candidate list
      // sometimes classified to ZERO tasks (the "swept — no new tasks over a full inbox" bug).
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: nowBlock() + profileBlock(profile) + activeBlock + `
CANDIDATES:
${list}` + (extra ? `

${extra}` : "") }
      ]
    }));
    tokIn += res.usage?.prompt_tokens || 0;
    tokOut += res.usage?.completion_tokens || 0;
    return firstJson(String(res.choices?.[0]?.message?.content || ""));
  };
  const parse = (out) => {
    const arr = Array.isArray(out) ? out : Array.isArray(out?.tasks) ? out.tasks : [];
    return arr.map((r) => ({ ...r, i: Number(r?.i) })).filter((r) => Number.isInteger(r.i) && r.i >= 0 && r.i < items.length && String(r?.title || "").trim().length >= 4 && String(r?.why || "").trim()).map((r) => {
      const it = items[r.i];
      return {
        title: String(r.title).slice(0, 90),
        why: String(r.why).slice(0, 400),
        when: r.when ? String(r.when).slice(0, 40) : void 0,
        source: it.sourceApp === "calendar" ? "calendar" : it.sourceApp === "drive" ? "drive" : it.sourceApp === "github" ? "github" : "gmail",
        risk: r.risk === "high" ? "high" : "low",
        urgency: clamp01(r.urgency ?? 0.5),
        importance: clamp01(r.importance ?? 0.6),
        anchorKey: it.anchorKey,
        // from the SOURCE — never the model
        link: it.url,
        accountId: it.accountId
      };
    }).slice(0, 12);
  };
  try {
    let out = await ask();
    let tasks = parse(out);
    const strongIdx = items.map((it, i) => ({ it, i })).filter(({ it }) => it.labels.includes("sent") || it.labels.includes("assigned") || it.labels.includes("review-requested")).map(({ i }) => i);
    for (let attempt = 0; !tasks.length && items.length >= 6 && attempt < 2; attempt++) {
      const nudge = strongIdx.length ? `You returned no tasks. Look SPECIFICALLY at candidates #${strongIdx.join(", #")} \u2014 each is either a commitment YOU (the user) made that has no later fulfilment visible, or a GitHub item explicitly assigned to/requesting review from them. For EACH one individually, decide: does it still need action? Return a task for every one that does. Only return an empty list if NONE of them do.` : `You returned no tasks from ${items.length} candidates. Re-examine them: direct questions from real people and the user's own SENT commitments are almost always actionable. Return an empty tasks list ONLY if truly nothing needs them.`;
      const retry = await ask(nudge);
      const retried = parse(retry);
      if (retried.length) {
        out = retry;
        tasks = retried;
        break;
      }
    }
    return { tasks, profileUpdates: parseProfileUpdates(out?.profileUpdates), tokens: { in: tokIn, out: tokOut } };
  } finally {
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [ai] classifyCandidates: ${items.length} in \u2192 ${calls} call${calls === 1 ? "" : "s"}, ${tokIn} in / ${tokOut} out tokens`);
  }
}
async function pickOneTask(items, profile, activeTitles) {
  if (!items.length) return null;
  const list = items.slice(0, 30).map((it, i) => `#${i} [${it.sourceApp}${it.labels.includes("sent") ? "/SENT-BY-USER" : ""}] from:"${it.sender || "?"}" when:"${it.timestamp || "?"}" title:"${it.title}" body:"${it.snippet}"`).join("\n");
  const activeBlock = activeTitles?.length ? `
Already on their list (pick something DIFFERENT):
${activeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}
` : "";
  const sys = `Pick the SINGLE most useful thing this person could do TODAY from the candidates below \u2014 you must return EXACTLY ONE task. This is a "one useful thing a day" nudge, so it's fine if it's small, but it must be a real action they'd value: an upcoming event to prep for, a birthday to acknowledge, a reply someone is waiting on, a commitment they made to fulfil, or clear progress on a stated project. NEVER pick a newsletter, promo, receipt, or automated mail. Prefer the most time-sensitive or personal item. Use their profile to choose well.
The title MUST be specific \u2014 name the actual person/company AND subject ("Wish Sonya a happy birthday", "Reply to Chloe at BOND about the demo"), NEVER vague ("Follow up on email", "Handle message").
Answer with STRICT JSON only: {"i":<candidate #>,"title":"specific imperative naming who+what, \u226411 words","why":"one clause naming the concrete trigger","when":"the REAL deadline if any, else ''","urgency":0..1,"importance":0..1,"risk":"low"|"high"}`;
  const client2 = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-reasoner" ? "deepseek-chat" : DEEPSEEK_MODEL;
  try {
    const res = await retryRequest2(() => client2.chat.completions.create({
      model: actualModel,
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: nowBlock() + profileBlock(profile) + activeBlock + `
CANDIDATES:
${list}` }
      ]
    }));
    const tokens = { in: res.usage?.prompt_tokens || 0, out: res.usage?.completion_tokens || 0 };
    const r = firstJson(String(res.choices?.[0]?.message?.content || ""));
    const idx = Number(r?.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length || String(r?.title || "").trim().length < 4) return null;
    const it = items[idx];
    const task = {
      title: String(r.title).slice(0, 90),
      why: String(r.why || "Worth doing today.").slice(0, 400),
      when: r.when ? String(r.when).slice(0, 40) : void 0,
      source: it.sourceApp === "calendar" ? "calendar" : it.sourceApp === "drive" ? "drive" : it.sourceApp === "github" ? "github" : "gmail",
      risk: r.risk === "high" ? "high" : "low",
      urgency: clamp01(r.urgency ?? 0.4),
      importance: clamp01(r.importance ?? 0.5),
      anchorKey: it.anchorKey,
      link: it.url,
      accountId: it.accountId
    };
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [ai] pickOneTask: "${task.title}" (${tokens.in} in / ${tokens.out} out)`);
    return { task, tokens };
  } catch {
    return null;
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
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You turn a person's rough to-do note into ONE crisp, actionable task title. Make it a specific imperative that names the concrete object/person from THEIR note \u2014 'email sarah' \u2192 'Reply to Sarah about the proposal', 'trip' \u2192 'Prepare Boston trip itinerary', 'call dentist' \u2192 'Call the dentist to book a cleaning'. NEVER invent names, dates, companies, or facts they didn't state \u2014 only sharpen what's there (if the note is just 'trip' with no destination, use 'Plan the trip', not a made-up city). Infer priority from the wording (urgent words, deadlines) and the person's profile only. Output STRICT JSON only." },
        { role: "user", content: profileBlock(profile) + `
Rough note: "${raw.slice(0, 300)}"

Return JSON: {"title": short imperative <= 9 words that names the specific object/person, "why": one concise clause capturing the intent, "when": a deadline for COMPLETING THIS TASK (e.g. "today", "by Fri") \u2014 ONLY if the note explicitly says when the TASK itself must be done (e.g. "by tomorrow", "before June 30"). If the note only mentions dates as background context (e.g. a trip date, event date, year mentioned in passing) leave this "", "urgency": 0..1 time pressure, "importance": 0..1 stakes}. JSON only.` }
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
WORK IN THREE PHASES: (1) PLAN silently \u2014 from the task and the context you gather, decide which tools you'll use and what artifacts (draft/doc/event/cells) you'll produce; never show this plan to the user. (2) DO \u2014 execute the reversible work through the tools. (3) REPORT via submit \u2014 BE BRIEF, the user wants to scan not read: "synthesis" = ONE short past-tense line of what you DID, "did" = at most 3 short bullets of concrete actions you produced (with names; omit this if nothing meaningful was produced \u2014 never pad it), "links" = EVERY artifact you produced, "steps" = only what genuinely still needs the user, each a SHORT one-liner (never a paragraph), the essential few not an exhaustive checklist. Leave steps empty when a sendable covers the remaining action or nothing is left.
PREP EVEN WHEN BLOCKED \u2014 if you can't fully DELIVER because one piece is missing (a recipient/contact, a login, an approval, a file), still PRODUCE what you can: write the actual message/greeting/content text. BUT NEVER invent the missing piece to force completion \u2014 if you do NOT have the person's REAL email/contact, do NOT create a draft addressed to a guessed or placeholder address (never name@example.com, never a made-up address). Instead put the ready-to-send TEXT into the step's own text so the user can paste it, and leave "Find <the real contact>" as the blocking step. Prepping means producing real CONTENT, never fabricating a missing fact. A blocked task still hands the user something PREPPED \u2014 never just a report that a lookup came up empty.
"did" IS A LIST OF WINS, NOT A SEARCH LOG \u2014 each "did" bullet is something you PRODUCED or PREPPED. NEVER list dead-end attempts ("searched Gmail \u2014 no results", "checked Contacts \u2014 none", "couldn't find X"): they are noise to the user. If a lookup found nothing, either prep around it or put the missing piece in steps \u2014 do not report the failed search as an action.
You can also use web_search for any external fact or context you need (a person, company, deadline, how-to, or a reference link) \u2014 look it up rather than guess.
PICK THE RIGHT ARTIFACT TYPE: a task that says "spreadsheet", "sheet", "tracker", or asks for rows/columns of structured data belongs in GOOGLE SHEETS, not a Doc \u2014 even though a Doc can hold a table, a sheet is what the user asked for and is what they can filter/sort/total. Only use a Doc for prose/lists/plans.
GOOGLE SHEETS \u2014 YOU MUST ACTUALLY WRITE: if the task involves updating a spreadsheet (e.g. filling in restaurant names, meal ideas, trip data, any cells), you MUST call the Sheets write tools (GOOGLESHEETS_BATCH_UPDATE_VALUES, GOOGLESHEETS_UPDATE_VALUES, GOOGLESHEETS_APPEND_VALUES, etc.) to ACTUALLY write the data into the cells \u2014 do NOT just produce a plan or list in synthesis. Read the sheet first to find the exact cells/ranges that need filling, then call the write tool with real content. Sheet cell writes are FULLY PERMITTED and reversible \u2014 you do NOT need user approval to write cells. Do it now.
GATHER WHAT THE TASK NEEDS \u2014 TARGETED, NOT EXHAUSTIVE: typically 1-3 reads (the Gmail thread behind the task, the relevant Calendar event or Drive doc, a web_search for external facts). NEVER leave placeholders like "[hotel name]" \u2014 find the real detail with ONE targeted search. But your round budget is TIGHT and reading is not the work: DO NOT survey the user's whole world before acting.
CREATE EARLY \u2014 if the task produces an artifact (a doc, sheet, deck, draft reply, event, research summary), CREATE it within your FIRST THREE tool calls, then refine/fill it with what you learn. For research tasks: web_search for the facts, then CREATE A GOOGLE DOC with the findings \u2014 a research task without a produced artifact is NOT done. An imperfect created artifact beats a perfect plan every time.
AUTO-EXECUTION \u2014 If the user has auto-approved certain actions (e.g., "schedule_meetings_under_30min"), you can execute those WITHOUT adding them to sendables for approval. Check their profile for autoApprove patterns. For example, if they've approved scheduling meetings under 30min, you can create the calendar event directly without asking. Otherwise, follow the normal approval flow.
HARD LIMIT \u2014 you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not even available to you). For email you ONLY ever leave a DRAFT; for Slack you only COMPOSE the message. You never send/post \u2014 instead OFFER the send as a one-click button via "sendables" (see submit), which the user reviews and fires. Never say you "sent", "emailed", "posted", or "messaged" \u2014 say you DRAFTED/PREPARED it. Never claim an action you didn't take.
NEWSLETTERS & PROMOTIONAL EMAIL \u2014 NEVER DRAFT A REPLY: before drafting any email reply, check whether the thread is a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender (unsubscribe footer, sender contains "noreply"/"no-reply"/"newsletter"/"marketing"/"updates@"/"news@", a Gmail promotions/ social label). If so, do NOT draft a reply or add a sendable for it, even if it appears to ask something \u2014 note in "synthesis" that it's mass mail and needs no reply, and stop there.
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
ASK ONLY WHEN TRULY STUCK: if a step is automatable EXCEPT for one detail you could not find or infer (a choice between real options, a preference, a date only the user knows), keep automatable=true and set "question" \u2014 ONE short, specific question \u2014 plus "options": 2-4 LIKELY answers with your best inference FIRST (they tap one and you run). Search EVERYTHING first (inbox, Drive, calendar, their profile, the web); a question you could have answered yourself is a failure. Prep everything around it so their answer is the only missing piece. Never ask more than 2 questions per task.
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
    did: { type: "array", items: { type: "string" }, description: `2-6 bullets, ONE per concrete action you ACTUALLY performed with tools this run, past tense with the specific names/artifacts, e.g. 'Drafted a reply to Sarah confirming Thursday', 'Created "Q3 budget" doc with the summary table', 'Filled 12 cells in the trip sheet'. NEVER plans, reads-only, or things you didn't do.` },
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
        label: { type: "string", description: "what it IS in the user's terms, e.g. 'Draft reply to Sarah', 'Q3 budget doc' \u2014 never a bare hostname, URL, or 'Open'" },
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
  const hasArtifactIds = !!task.artifacts?.length;
  const priorArtifactIds = new Set((task.artifacts || []).map((a) => a.id));
  const priorArtifacts = hasArtifactIds ? task.artifacts.map((a) => ({ label: a.label || a.kind, url: a.url, extra: `${a.kind} id ${a.id}` })) : (task.links || []).filter((l) => l?.url);
  const artifactsBlock = priorArtifacts.length ? `
ALREADY CREATED FOR THIS TASK (you made these on a prior run \u2014 OPEN and UPDATE the existing one; updates to THESE ids are permitted without approval. Do NOT create a new copy). For a Google Doc, prefer the MARKDOWN update tool (whole-document markdown text) over the raw index-based batch-update API \u2014 it needs no structural inspection, so update it directly instead of reading the doc's internal structure first:
${priorArtifacts.map((l) => `- ${l.label}${l.extra ? ` (${l.extra})` : ""}${l.url ? `: ${l.url}` : ""}`).join("\n")}
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
  const MAX = 8;
  let tokIn = 0, tokOut = 0, rounds = 0;
  const WRITE_NAME = /(CREATE|UPDATE|APPEND|PATCH|MODIFY|BATCH|DRAFT|INSERT|WRITE|REPLACE|QUICK_ADD|MOVE|COPY|ADD_)/i;
  let wroteAny = false;
  let finishBacks = 0;
  let lastGmailDraft;
  const withTokens = (o) => {
    let sendables = o.sendables;
    if (lastGmailDraft?.draftId && lastGmailDraft.to && !sendables.some((s) => s.app === "gmail")) {
      sendables = [...sendables, {
        app: "gmail",
        label: "Send reply",
        to: lastGmailDraft.to,
        subject: lastGmailDraft.subject,
        body: lastGmailDraft.body,
        draftId: lastGmailDraft.draftId
      }].slice(0, 6);
    }
    const did = o.did.length || !wroteAny || !o.synthesis || o.synthesis === "Done." ? o.did : [o.synthesis];
    return { ...o, did, sendables, tokens: { in: tokIn, out: tokOut } };
  };
  try {
    for (let i = 0; i < MAX; i++) {
      if (i >= 5 && !wroteAny && !focus && !hasArtifactIds) break;
      if (i >= (priorArtifacts.length ? 1 : 2) && !wroteAny && !focus) {
        const nudge = priorArtifacts.length ? `ENFORCEMENT (round ${i + 1}/${MAX}): you have written NOTHING yet. Your NEXT tool call MUST update the EXISTING artifact listed above under "ALREADY CREATED FOR THIS TASK" (its id is listed \u2014 use an UPDATE/PATCH/APPEND tool with that id) with the requested change. Do NOT create a new one. Do NOT make another read call.` : `ENFORCEMENT (round ${i + 1}/${MAX}): you have CREATED NOTHING yet \u2014 only reads. Your NEXT tool call MUST be a create/write tool (GOOGLEDOCS_CREATE_DOCUMENT, GMAIL_CREATE_EMAIL_DRAFT, GOOGLESHEETS_UPDATE_VALUES, \u2026) that produces the task's artifact with the content you already have. Do NOT make another read call. If the task truly requires no artifact, call submit now.`;
        messages.push({ role: "user", content: nudge });
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
        if (out) return withTokens(finalize(out, textContent, profileUpdates));
        if (i < MAX - 1) {
          if (textContent) messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: "You still have not used any tools. Read the connected apps and do the work now. Do not answer with prose until you have actually acted." });
          continue;
        }
        break;
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
            const draft = finalize(input, "", profileUpdates);
            const fabricatedRevision = hasArtifactIds && !wroteAny;
            const leftUndone = draft.steps.find((s) => s.automatable && !s.synthetic && s.dependsOn === void 0 && !s.question && !s.needsPermission);
            const claimsArtifact = /\b(drafted|created|updated|filled|composed|wrote|added a|built)\b/i.test(`${draft.synthesis} ${(draft.did || []).join(" ")}`);
            const hasArtifact = draft.links.length > 0 || draft.sendables.length > 0 || wroteAny;
            if (fabricatedRevision) {
              content = "REJECTED: you're revising an artifact that already exists, but you have not made any update/write tool call this run. Call the update tool on the id listed under 'ALREADY CREATED FOR THIS TASK' now \u2014 THEN submit. Do not resubmit the same claim without writing first.";
            } else if (leftUndone && finishBacks < 2) {
              finishBacks++;
              content = `REJECTED: "${leftUndone.text}" is something YOU can do with your tools \u2014 do it NOW, don't leave it for the user. steps[] must contain ONLY what genuinely needs the user (an approval, a decision, an answer only they have, or a login/payment/physical action). Act, then submit.`;
            } else if (claimsArtifact && !hasArtifact && finishBacks < 2) {
              finishBacks++;
              content = "REJECTED: your report claims you drafted/created/updated something, but no artifact (draft, doc, sheet, event) was actually produced and no write succeeded this run. Either DO it now with the real tool, or report honestly what you found without claiming work you didn't do.";
            } else {
              if (!wroteAny) draft.did = draft.did.filter((d) => !/\b(drafted|created|updated|filled|composed|wrote|added a|built)\b/i.test(d));
              submitted = draft;
              content = "submitted";
            }
          } else if (toolName === "web_search") {
            content = await runWebSearch(input);
          } else if (toolName === "send_self_brief") {
            content = extras?.selfBrief ? await extras.selfBrief(String(input?.subject || ""), String(input?.body || "")) : "ERROR: not available";
          } else if (hasArtifactIds && /CREATE/i.test(toolName) && !/CREATE.*(SUB.?ISSUE|COMMENT|LABEL|BRANCH)/i.test(toolName)) {
            content = "BLOCKED: this task already has an artifact (see 'ALREADY CREATED FOR THIS TASK') \u2014 creating a new one would duplicate it. Use the UPDATE tool on the EXISTING id instead.";
          } else {
            const r = extras ? await extras.call(toolName, input || {}) : null;
            content = r ?? `Unknown tool: ${toolName}`;
            const isRealWrite = r !== null && WRITE_NAME.test(String(toolName)) && !/^ERROR|PERMISSION_REQUIRED/i.test(String(r));
            const argStr = JSON.stringify(input || {});
            const targetsExisting = [...priorArtifactIds].some((id) => id.length >= 8 && argStr.includes(id));
            if (isRealWrite && (!hasArtifactIds || targetsExisting)) wroteAny = true;
            if (isRealWrite && /GMAIL_(CREATE|UPDATE)_EMAIL_DRAFT/i.test(toolName)) {
              const idMatch = /"(?:draft_?id|id)"\s*:\s*"([\w-]{6,})"/i.exec(String(r));
              if (idMatch) lastGmailDraft = { to: String(input?.recipient_email || input?.to || "").trim() || void 0, subject: input?.subject ? String(input.subject) : void 0, body: input?.body ? String(input.body) : void 0, draftId: idMatch[1] };
            }
          }
        } catch (e) {
          content = "ERROR: " + (e?.message || e);
        }
        messages.push({ role: "tool", tool_call_id: tu.id || `tool_${Date.now()}`, content: String(content).slice(0, 2e3) });
      }
      if (submitted) return withTokens(submitted);
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
        response_format: { type: "json_object" },
        // FORCE parseable JSON — without this the rescue sometimes
        // returned prose, so finalize threw and the run fell to the defeatist fallback. JSON mode makes the
        // rescue reliably usable, so a run that gathered ANY context produces a real result.
        messages: [
          {
            role: "system",
            content: "You must output STRICT JSON only: {context:string,synthesis:string,did:array,steps:array,links:array,sendables:array}. did = one short past-tense bullet per action ACTUALLY performed with tools (empty if none). Report ONLY what the transcript shows was ACTUALLY DONE with tools. synthesis = one short past-tense sentence of performed actions ('Created X', 'Drafted Y'); if nothing was created or written, say plainly what was found and put ALL remaining work in steps (each {text, automatable}) \u2014 do NOT describe the user or summarize their life. links = ONLY artifacts CREATED this run (URLs from create-tool results in the transcript, each with a label saying what it IS); NEVER list pre-existing files that were merely read. Fabricating a result is worse than admitting the run fell short."
          },
          { role: "user", content: transcript }
        ]
      });
      const text = rescue.choices[0]?.message?.content || "";
      const out = firstJson(text);
      if (out) return withTokens(finalize(out, text, profileUpdates));
    } catch {
    }
    const sourceUrl = (task.links || []).find((l) => l?.url)?.url;
    return withTokens(finalize({
      synthesis: "This one needs your call \u2014 take it from here.",
      did: [],
      steps: [{ text: `Open and handle: ${task.title.slice(0, 70)}`, automatable: false, ...sourceUrl ? { url: sourceUrl } : {} }],
      links: [],
      sendables: []
    }, "", profileUpdates));
  } finally {
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [ai] runTask "${task.title.slice(0, 50)}": ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}
function finalize(out, fallbackText, profileUpdates) {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps = rawSteps.map((s, idx) => ({
    text: String(s?.text || "").trim().slice(0, 180),
    // keep steps to a scannable one-liner, not a paragraph
    automatable: !!s?.automatable,
    needsPermission: !!s?.needsPermission,
    // Valid only if it points at a REAL other step — a bad index (9 in a 3-step list, or itself)
    // would permanently block the step client-side.
    dependsOn: Number.isInteger(s?.dependsOn) && s.dependsOn >= 0 && s.dependsOn < rawSteps.length && s.dependsOn !== idx ? s.dependsOn : void 0,
    url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : void 0,
    question: s?.question ? String(s.question).trim().slice(0, 200) : void 0,
    options: Array.isArray(s?.options) ? s.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4) : void 0
  })).filter((s) => s.text).slice(0, 6);
  const kindLabel = (url2) => /docs\.google\.com\/document/i.test(url2) ? "the Google Doc Otto created" : /docs\.google\.com\/spreadsheets/i.test(url2) ? "the Google Sheet Otto created" : /docs\.google\.com\/presentation/i.test(url2) ? "the slides Otto created" : /mail\.google\.com/i.test(url2) ? "the email thread" : /calendar\.google\.com/i.test(url2) ? "the calendar event" : "the linked page";
  const isJunkLabel = (s) => !s || /^(open|link|url|click here|view|here|document|doc)$/i.test(s.trim()) || /^https?:\/\//i.test(s.trim());
  const links = (Array.isArray(out?.links) ? out.links : []).map((l) => {
    const url2 = String(l?.url || "").trim();
    const raw = String(l?.label || "").slice(0, 80);
    return { label: isJunkLabel(raw) ? kindLabel(url2) : raw, url: url2 };
  }).filter((l) => /^https?:\/\//i.test(l.url)).filter((l) => !/docs\.google\.com/i.test(l.url) || /\/(document|spreadsheets|presentation)\/(d\/)?[-\w]{25,}/i.test(l.url)).slice(0, 3);
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
  })).filter((s) => s.app === "gmail" && !!s.draftId && !!s.to && !!(s.subject || s.body) || s.app === "slack" && !!s.channel && !!s.text || s.app === "gcal" && !!s.eventId && !!s.attendees?.length && !!(s.summary || s.when)).filter((s) => !/@example\.(?:com|org|net)\b|@(?:test|placeholder|domain|email)\.\w+|\bplaceholder\b/i.test(`${s.to || ""} ${(s.attendees || []).join(" ")}`)).slice(0, 6);
  const brief = (s, lines, chars) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join("\n").slice(0, chars);
  let synthesis = brief(String(out?.synthesis || ""), 2, 260);
  const PLANNING = /\b(let me|i'?ll (?:first|now|then|use|create|draft|check)|i will (?:first|now|then)|now i(?:'?ll)? |first,? i(?:'?ll)? |seems like|my plan is|i need to|i should)\b/i;
  if (PLANNING.test(synthesis)) synthesis = "";
  const DEAD_END = /\bno (results?|matches?|contacts?|entries|records|response|reply|emails?|luck|info(?:rmation)?)\b|\bnothing (?:found|available|to)\b|\bcouldn'?t\b|\bcould not\b|\bunable to\b|\bnot? found\b|\bno .{0,20}\bfound\b|\bfailed to\b|\bwithout success\b/i;
  const PLACEHOLDER = /@example\.(?:com|org|net)\b|@(?:test|placeholder|domain|email)\.\w+|\[[^\]]*\b(?:email|address|name|phone|contact)\b[^\]]*\]|\bplaceholder\b/i;
  const INVESTIGATIVE = /^(searched|search|checked|check|looked|look|scrolled|scroll|browsed|scanned|scan|examined|inspected|explored|queried|tried to|attempted|reviewed|read|opened|combed|dug|hunted)\b/i;
  const did = (Array.isArray(out?.did) ? out.did : []).map((d) => String(d || "").trim().replace(/^\s*[-•*]\s*/, "")).filter((d) => d.length >= 6 && !PLANNING.test(d) && !DEAD_END.test(d) && !PLACEHOLDER.test(d) && !INVESTIGATIVE.test(d)).map((d) => d.slice(0, 130)).slice(0, 4);
  if (synthesis && !did.length && !links.length && !sendables.length && (DEAD_END.test(synthesis) || INVESTIGATIVE.test(synthesis))) synthesis = "";
  void fallbackText;
  if (!synthesis && !steps.length && !links.length && !sendables.length) {
    throw new Error("The run produced no output \u2014 it will retry.");
  }
  const DOABLE = /^(create|draft|write|update|add|fill|schedule|search|compile|prepare|generate|make)\b/i;
  const JUDGMENT = /\b(choose|decide|pick|confirm|approve|review|prefer|want|which|verify|check with|sign|pay)\b/i;
  for (const s of steps) {
    if (!s.automatable && DOABLE.test(s.text) && !JUDGMENT.test(s.text) && !s.question) s.automatable = true;
  }
  const stale = (txt) => did.some((d) => {
    const a = new Set(txt.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const b = new Set(d.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const inter = [...a].filter((w) => b.has(w)).length;
    return a.size > 2 && inter / a.size >= 0.7;
  });
  const cleanedSteps = steps.filter((s) => !stale(s.text));
  steps.length = 0;
  steps.push(...cleanedSteps);
  if (!steps.length && !sendables.length && links.length) {
    for (const l of links.slice(0, 2)) steps.push({ text: `Review ${l.label}`.slice(0, 80), automatable: false, url: l.url, synthetic: true });
  }
  return {
    context: brief(String(out?.context || ""), 2, 380),
    // Fallback only when there's genuinely nothing to say: "Done." if the run left no open steps, else a
    // neutral placeholder (never "Done." on a task that still needs the user — that would misread as finished).
    synthesis: synthesis || (steps.some((s) => !s.done) ? "" : "Done."),
    did,
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
var isTransient2 = (msg) => /terminated|fetch failed|socket hang up|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|timeout|503|502|429/i.test(msg);
async function withRetry(label, op, tries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const { data, error } = await op();
      if (!error) return { data, error: null };
      lastErr = error;
      if (!isTransient2(error.message || "")) return { data: null, error };
    } catch (e) {
      lastErr = { message: e?.message || String(e) };
      if (!isTransient2(lastErr.message || "")) throw e;
    }
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  console.warn(`[store] ${label} exhausted retries:`, lastErr?.message);
  return { data: null, error: lastErr };
}
async function loadState(email) {
  if (!client || !email) return { profile: emptyProfile(), tasks: [] };
  const { data, error } = await withRetry("load", async () => client.from(TABLE).select("profile,tasks,google").eq("email", email).maybeSingle());
  if (error) {
    console.warn("[store] load failed:", error.message);
    return { profile: emptyProfile(), tasks: [] };
  }
  const d = data;
  const google = d?.google && d.google.tokens ? d.google : void 0;
  return { profile: normalizeProfile(d?.profile), tasks: Array.isArray(d?.tasks) ? d.tasks : [], google };
}
async function saveState(email, state) {
  if (!client || !email) return;
  const { error } = await withRetry("save", async () => client.from(TABLE).upsert(
    { email, profile: state.profile || emptyProfile(), tasks: state.tasks || [], google: state.google ?? null, updated_at: (/* @__PURE__ */ new Date()).toISOString() },
    { onConflict: "email" }
  ).then((r) => ({ data: null, error: r.error })));
  if (error) console.warn("[store] save failed:", error.message);
}
async function listAccountEmails(limit = 200) {
  if (!client) return [];
  try {
    const { data, error } = await client.from(TABLE).select("email").order("updated_at", { ascending: false }).limit(limit);
    if (error) {
      console.warn("[store] listAccountEmails failed:", error.message);
      return [];
    }
    return (data || []).map((r) => String(r.email)).filter(Boolean);
  } catch {
    return [];
  }
}
var JOBS = "weave_web_jobs";
var EVENTS = "weave_web_job_events";
var LOCK_MS = 5 * 6e4;
var memJobs = [];
var jobsTableOk = null;
async function jobsDb() {
  if (!client) return null;
  if (jobsTableOk === null) {
    const { error } = await client.from(JOBS).select("id").limit(1);
    jobsTableOk = !error;
    if (error) console.warn(`[store] jobs table unreachable (${error.message}) \u2014 using in-memory queue (fine for one dev process; run supabase.sql + SUPABASE_SERVICE_KEY for durability).`);
  }
  return jobsTableOk ? client : null;
}
function demoteIfRls(error) {
  if (!error || !(error.code === "42501" || /row-level security/i.test(error.message || ""))) return false;
  jobsTableOk = false;
  console.warn(`[store] jobs table not writable (${error.message}) \u2014 using in-memory queue (fine for one dev process; set SUPABASE_SERVICE_KEY for durability).`);
  return true;
}
async function enqueueJob(userEmail, type, taskId, input) {
  const key2 = type === "sweep" ? `${userEmail}:sweep` : `${userEmail}:task:${taskId}`;
  const db = await jobsDb();
  if (db) {
    const { data: existing } = await db.from(JOBS).select("*").eq("idempotency_key", key2).in("status", ["queued", "running"]).limit(1);
    if (existing?.length) return existing[0];
    const { data, error } = await db.from(JOBS).insert({ user_email: userEmail, task_id: taskId ?? null, type, idempotency_key: key2, input: input ?? null }).select().single();
    if (!error && data) return data;
    const { data: winner } = await db.from(JOBS).select("*").eq("idempotency_key", key2).in("status", ["queued", "running"]).limit(1);
    if (winner?.length) return winner[0];
    if (!demoteIfRls(error)) throw new Error(`enqueue failed: ${error?.message || "unknown"}`);
  }
  const active = memJobs.find((j) => j.idempotency_key === key2 && (j.status === "queued" || j.status === "running"));
  if (active) return active;
  const job = { id: crypto.randomUUID(), user_email: userEmail, task_id: taskId ?? null, type, status: "queued", attempt_count: 0, max_attempts: 3, idempotency_key: key2, input, created_at: (/* @__PURE__ */ new Date()).toISOString() };
  memJobs.push(job);
  if (memJobs.length > 500) memJobs.splice(0, memJobs.length - 500);
  return job;
}
async function claimJob(workerId2) {
  const db = await jobsDb();
  const now = /* @__PURE__ */ new Date();
  const lockUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  if (db) {
    for (const pass of ["queued", "expired"]) {
      const q = db.from(JOBS).select("id,status,attempt_count,max_attempts").order("created_at", { ascending: true }).limit(5);
      const { data: candidates } = pass === "queued" ? await q.eq("status", "queued") : await q.eq("status", "running").lt("locked_until", now.toISOString());
      for (const c of candidates || []) {
        if (c.attempt_count >= c.max_attempts) {
          await db.from(JOBS).update({ status: "failed_terminal", finished_at: now.toISOString(), last_error: "max attempts exceeded" }).eq("id", c.id).eq("status", c.status);
          continue;
        }
        const { data: won } = await db.from(JOBS).update({ status: "running", locked_by: workerId2, locked_until: lockUntil, started_at: now.toISOString(), attempt_count: c.attempt_count + 1 }).eq("id", c.id).eq("status", c.status).eq("attempt_count", c.attempt_count).select();
        if (won?.length) return won[0];
      }
    }
    return null;
  }
  const job = memJobs.find((j) => j.status === "queued" || j.status === "running" && j.locked_until && j.locked_until < now.toISOString());
  if (!job) return null;
  if (job.attempt_count >= job.max_attempts) {
    job.status = "failed_terminal";
    job.last_error = "max attempts exceeded";
    return claimJob(workerId2);
  }
  job.status = "running";
  job.locked_until = lockUntil;
  job.started_at = now.toISOString();
  job.attempt_count++;
  return job;
}
async function finishJob(id, outcome, error, output) {
  const db = await jobsDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (db) {
    if (outcome === "succeeded") {
      await db.from(JOBS).update({ status: "succeeded", finished_at: now, output: output ?? null, locked_until: null }).eq("id", id);
    } else {
      const { data } = await db.from(JOBS).select("attempt_count,max_attempts").eq("id", id).maybeSingle();
      const terminal = (data?.attempt_count ?? 1) >= (data?.max_attempts ?? 3);
      await db.from(JOBS).update({
        status: terminal ? "failed_terminal" : "queued",
        // retryable → back to queued for the next drain
        ...terminal ? { finished_at: now } : {},
        last_error: String(error || "").slice(0, 500),
        locked_until: null
      }).eq("id", id);
    }
    return;
  }
  const job = memJobs.find((j) => j.id === id);
  if (!job) return;
  if (outcome === "succeeded") {
    job.status = "succeeded";
    job.finished_at = now;
    job.output = output;
  } else {
    const terminal = job.attempt_count >= job.max_attempts;
    job.status = terminal ? "failed_terminal" : "queued";
    job.last_error = String(error || "").slice(0, 500);
    if (terminal) job.finished_at = now;
  }
  job.locked_until = null;
}
async function getLatestJob(userEmail, type) {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("*").eq("user_email", userEmail).eq("type", type).order("created_at", { ascending: false }).limit(1);
    return data?.[0] || null;
  }
  const mine = memJobs.filter((j) => j.user_email === userEmail && j.type === type);
  return mine[mine.length - 1] || null;
}
async function countActiveJobs(userEmail) {
  const db = await jobsDb();
  if (db) {
    const { count } = await db.from(JOBS).select("id", { count: "exact", head: true }).eq("user_email", userEmail).in("status", ["queued", "running"]);
    return count || 0;
  }
  return memJobs.filter((j) => j.user_email === userEmail && (j.status === "queued" || j.status === "running")).length;
}
async function activeJobTaskIds(userEmail) {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("task_id").eq("user_email", userEmail).in("status", ["queued", "running"]).not("task_id", "is", null).limit(100);
    return [...new Set((data || []).map((r) => String(r.task_id)).filter(Boolean))];
  }
  return [...new Set(memJobs.filter((j) => j.user_email === userEmail && (j.status === "queued" || j.status === "running") && j.task_id).map((j) => String(j.task_id)))];
}
async function getJob(id, userEmail) {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(JOBS).select("*").eq("id", id).eq("user_email", userEmail).maybeSingle();
    return data || null;
  }
  return memJobs.find((j) => j.id === id && j.user_email === userEmail) || null;
}
var memEvents = [];
async function recordEvent(userEmail, kind, opts = {}) {
  const db = await jobsDb();
  const row = { user_email: userEmail, task_id: opts.taskId ?? null, job_id: opts.jobId ?? null, kind, message: opts.message ? String(opts.message).slice(0, 300) : null };
  if (db) {
    try {
      const { error } = await db.from(EVENTS).insert(row);
      if (!error) return;
      demoteIfRls(error);
    } catch {
      return;
    }
  }
  memEvents.push({ ...row, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (memEvents.length > 1e3) memEvents.splice(0, memEvents.length - 1e3);
}
async function eventsForTask(userEmail, taskId, limit = 20) {
  const db = await jobsDb();
  if (db) {
    const { data } = await db.from(EVENTS).select("kind,message,at,task_id").eq("user_email", userEmail).eq("task_id", taskId).order("at", { ascending: false }).limit(limit);
    return data || [];
  }
  return memEvents.filter((e) => e.user_email === userEmail && e.task_id === taskId).slice(-limit).reverse();
}

// server/tasks.ts
import { randomUUID } from "node:crypto";

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
var ACTION_POLICIES = {
  // Gmail — read + draft are auto; anything that leaves the account or destroys mail is never.
  GMAIL_FETCH_EMAILS: "auto",
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: "auto",
  GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: "auto",
  GMAIL_LIST_THREADS: "auto",
  GMAIL_GET_ATTACHMENT: "auto",
  GMAIL_LIST_DRAFTS: "auto",
  GMAIL_GET_PROFILE: "auto",
  GMAIL_CREATE_EMAIL_DRAFT: "auto",
  GMAIL_UPDATE_EMAIL_DRAFT: "auto",
  GMAIL_SEND_EMAIL: "never",
  GMAIL_SEND_DRAFT: "never",
  GMAIL_REPLY_TO_THREAD: "never",
  GMAIL_FORWARD_MESSAGE: "never",
  GMAIL_DELETE_MESSAGE: "never",
  GMAIL_DELETE_DRAFT: "never",
  GMAIL_TRASH_MESSAGE: "never",
  GMAIL_ARCHIVE_MESSAGE: "never",
  // Calendar — reads auto; ANY event write needs approval (it lands on calendars); invites never.
  GOOGLECALENDAR_EVENTS_LIST: "auto",
  GOOGLECALENDAR_FIND_EVENT: "auto",
  GOOGLECALENDAR_GET_EVENT: "auto",
  GOOGLECALENDAR_FIND_FREE_SLOTS: "auto",
  GOOGLECALENDAR_GET_CALENDAR: "auto",
  GOOGLECALENDAR_FREE_BUSY_QUERY: "auto",
  GOOGLECALENDAR_CREATE_EVENT: "approve",
  GOOGLECALENDAR_UPDATE_EVENT: "approve",
  GOOGLECALENDAR_PATCH_EVENT: "approve",
  GOOGLECALENDAR_QUICK_ADD: "approve",
  GOOGLECALENDAR_DELETE_EVENT: "never",
  // Drive/Docs — search/read/create-new auto; editing EXISTING docs needs approval; delete/share never.
  GOOGLEDRIVE_FIND_FILE: "auto",
  GOOGLEDRIVE_DOWNLOAD_FILE: "auto",
  GOOGLEDRIVE_EXPORT_FILE: "auto",
  GOOGLEDRIVE_LIST_FILES: "auto",
  GOOGLEDOCS_GET_DOCUMENT_BY_ID: "auto",
  GOOGLEDOCS_CREATE_DOCUMENT: "auto",
  GOOGLEDOCS_SEARCH_DOCUMENTS: "auto",
  GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT: "approve",
  GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN: "approve",
  GOOGLEDRIVE_DELETE_FILE: "never",
  GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE: "never",
  // Sheets — reads + cell writes auto (reversible); structural deletes never.
  GOOGLESHEETS_BATCH_GET: "auto",
  GOOGLESHEETS_GET_SPREADSHEET_INFO: "auto",
  GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW: "auto",
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: "auto",
  GOOGLESHEETS_BATCH_UPDATE: "auto",
  GOOGLESHEETS_UPDATE_VALUES: "auto",
  GOOGLESHEETS_APPEND_VALUES: "auto",
  GOOGLESHEETS_DELETE_SHEET: "never",
  GOOGLESHEETS_DELETE_DIMENSION: "never",
  // GitHub — the two discovery reads (assigned issues, review-requested PRs). Other GitHub actions fall
  // through to the regex classifiers.
  GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER: "auto",
  GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS: "auto",
  // Slack — read + compose only; posting is the user's click.
  SLACK_FETCH_CONVERSATION_HISTORY: "auto",
  SLACK_LIST_ALL_CHANNELS: "auto",
  SLACK_SEARCH_MESSAGES: "auto",
  SLACK_FIND_USERS: "auto",
  SLACK_CHAT_POST_MESSAGE: "never",
  SLACK_SEND_MESSAGE: "never",
  SLACK_CHAT_DELETE: "never"
};
function isGatedAction(rawName) {
  const n = rawName.toUpperCase();
  const policy = ACTION_POLICIES[n];
  if (policy) return policy === "never";
  if (/DRAFT/.test(n) && !/(SEND|DELETE|TRASH)/.test(n)) return false;
  return /(SEND|REPLY|FORWARD|PUBLISH|UNSUBSCRIBE|TWEET|DELETE|REMOVE|TRASH|ARCHIVE|CREATE_POST|CREATE_TWEET|CREATE_MESSAGE|SCHEDULE_MESSAGE|CREATE_DM|_POST_|_POST$|SHARE|INVITE)/.test(n);
}
function isWriteGatedAction(rawName) {
  const n = rawName.toUpperCase();
  const policy = ACTION_POLICIES[n];
  if (policy) return policy === "approve";
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
  const multi = app2 === "gmail";
  if (!multi) await disconnect(app2, userId).catch(() => {
  });
  const req = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl, ...multi ? { allowMultiple: true } : {} });
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
async function getConnectedAccounts(userId, app2, resolveEmails = false) {
  try {
    const list = await sdk().connectedAccounts.list({ userIds: [userId], limit: 200 });
    const items = (list?.items ?? (Array.isArray(list) ? list : [])).filter(isActive);
    const targetToolkit = norm(TOOLKIT_OF(app2));
    const accounts = items.filter((i) => acctToolkit(i) === targetToolkit).map((i) => ({
      id: acctId(i),
      email: i?.email || i?.accountEmail || i?.metadata?.email || i?.data?.email,
      toolkit: acctToolkit(i),
      status: i?.status || i?.connectionStatus || i?.state || "ACTIVE"
    })).filter((a) => a.id);
    if (resolveEmails && app2 === "gmail") {
      await Promise.all(accounts.filter((a) => !a.email).map(async (a) => {
        try {
          const prof = await readAction(userId, "GMAIL_GET_PROFILE", {}, a.id);
          a.email = prof?.emailAddress || prof?.email || prof?.response_data?.emailAddress || a.email;
        } catch (e) {
          console.warn("[integrations] gmail email resolve failed:", e?.message ?? e);
        }
      }));
    }
    return accounts;
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
async function execute(action, userId, args, connectedAccountId) {
  const result = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true, ...connectedAccountId ? { connectedAccountId } : {} });
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
function slimSchema(params) {
  const props = params && typeof params === "object" && params.properties && typeof params.properties === "object" ? params.properties : {};
  const required = Array.isArray(params?.required) ? params.required.filter((k) => typeof k === "string" && props[k]) : [];
  const keys = Object.keys(props);
  const keep = [...required, ...keys.filter((k) => !required.includes(k))].slice(0, 10);
  const out = {};
  for (const k of keep) {
    const p = props[k] ?? {};
    const slim = { type: p.type || "string" };
    if (p.description) slim.description = String(p.description).slice(0, 120);
    if (Array.isArray(p.enum)) slim.enum = p.enum.slice(0, 12);
    if (p.type === "array") slim.items = { type: p.items?.type || "string" };
    out[k] = slim;
  }
  return { type: "object", properties: out, ...required.length ? { required } : {} };
}
function relevance(n) {
  let s = 0;
  if (/(EVENT|MESSAGE|EMAIL|THREAD|DRAFT|FILE|DOCUMENT|FOLDER|SHEET|SPREADSHEET|ROW|CELL|SLIDE|PRESENTATION|ISSUE|PULL|COMMENT|TASK|REPO|CONTACT|PEOPLE|FREE.?SLOT|FREEBUSY)/.test(n)) s += 3;
  if (/(FIND|SEARCH|LIST|GET|FETCH|READ|CREATE|UPDATE|PATCH|ADD|INSERT|MODIFY|APPEND|MOVE|COPY)/.test(n)) s += 2;
  if (/(ACL|CHANNEL|WATCH|STOP|QUOTA|SETTING|COLOR|DUPLICATE|PERMISSION|SCOPE|SUBSCRIPTION|WEBHOOK|CALENDAR_LIST|CALENDARS_|CREATE_CALENDAR)/.test(n)) s -= 4;
  if (/UPDATE/.test(n)) s += 1;
  if (/MARKDOWN/.test(n)) s += 1;
  return s;
}
var CANON_VERBS = ["CREATE", "UPDATE", "DELETE", "INSERT", "GET", "LIST", "FIND", "SEARCH"];
function actionFamily(rawName) {
  const parts = rawName.split("_");
  const verbIdx = parts.findIndex((p) => CANON_VERBS.includes(p));
  if (verbIdx === -1) return rawName;
  const noun = (parts[verbIdx + 1] || "").replace(/\d+$/, "");
  return `${parts[verbIdx]}:${noun}`;
}
function dedupeFamilies(items) {
  const best = /* @__PURE__ */ new Map();
  for (const x of items) {
    const key2 = actionFamily(x.rawName);
    const cur = best.get(key2);
    if (!cur || relevance(x.rawName) > relevance(cur.rawName)) best.set(key2, x);
  }
  return [...best.values()];
}
var isRead = (n) => /(GET|LIST|FIND|SEARCH|FETCH|READ|DOWNLOAD|EXPORT|FREE_BUSY|INSTANCES)/.test(n) && !/(CREATE|UPDATE|INSERT|APPEND|ADD|PATCH|MODIFY|DELETE|REMOVE|WRITE|REPLACE|COPY|MOVE|BATCH_UPDATE|BATCH_MODIFY|SET_)/.test(n);
function readOnly(t) {
  return { tools: t.tools.filter((x) => isRead(x.name)), call: t.call, connected: t.connected };
}
var TOOLKIT_HINTS = [
  [/\b(meet|meeting|call|schedule|calendar|invite|event|appointment|book)\w*/i, "googlecalendar"],
  [/\b(sheet|spreadsheet|cells?|rows?|columns?|track|budget|expense|tabular)\w*/i, "googlesheets"],
  [/\b(deck|slides?|presentation|pitch)\w*/i, "googleslides"],
  [/\b(repo|pull request|\bpr\b|issue|github|merge|commit)\w*/i, "github"],
  [/\b(notion|wiki|knowledge base)\w*/i, "notion"],
  [/\b(slack|channel|dm)\b/i, "slack"],
  [/\b(linear|ticket)\b/i, "linear"],
  [/\b(todoist)\b/i, "todoist"]
];
var CORE_TOOLKITS = ["gmail", "googledocs", "googledrive"];
function scopeTools(t, task) {
  if (t.tools.length <= 30) return t;
  const text = `${task.title} ${task.why || ""}`;
  const keep = new Set(CORE_TOOLKITS);
  if (task.source === "calendar") keep.add("googlecalendar");
  if (task.source && task.source !== "manual" && task.source !== "web") keep.add(task.source);
  for (const [re, kit] of TOOLKIT_HINTS) if (re.test(text)) keep.add(kit);
  const scoped = t.tools.filter((x) => {
    const m = /^\[(\w+)\]/.exec(x.description || "");
    return !m || keep.has(m[1].toLowerCase());
  });
  if (scoped.length < 15) return t;
  return { ...t, tools: scoped };
}
async function readAction(userId, action, args, connectedAccountId) {
  if (!integrationsReady() || !userId) throw new Error("integrations not configured");
  const policy = ACTION_POLICIES[action.toUpperCase()];
  if (policy !== "auto" || !isRead(action.toUpperCase())) throw new Error(`not an allowed read action: ${action}`);
  const r = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true, ...connectedAccountId ? { connectedAccountId } : {} });
  if (r && r.successful === false) throw new Error(String(r.error || `read failed: ${action}`));
  return r?.data ?? r;
}
async function execDirect(userId, action, args) {
  const r = await sdk().tools.execute(action, { userId, arguments: args, dangerouslySkipVersionCheck: true });
  if (r && r.successful === false) throw new Error(String(r.error || `${action} failed`));
  return r?.data ?? r;
}
var firstId = (d, ...paths) => {
  for (const p of paths) {
    let v = d;
    for (const k of p.split(".")) v = v?.[k];
    if (v) return String(v);
  }
  return "";
};
async function runSmokeTest(userId) {
  if (!integrationsReady() || !userId) return [{ app: "composio", step: "configured", ok: false, detail: "Composio not configured" }];
  const { connected } = await getAgentTools(userId);
  const results = [];
  const step = async (app2, name, fn) => {
    try {
      results.push({ app: app2, step: name, ok: true, detail: await fn() });
      return true;
    } catch (e) {
      results.push({ app: app2, step: name, ok: false, detail: String(e?.message || e).slice(0, 250) });
      return false;
    }
  };
  const MARK = "Otto integration check \u2014 safe to delete";
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
      await step("gmail", "clean up draft", async () => {
        await execDirect(userId, "GMAIL_DELETE_DRAFT", { draft_id: draftId });
        return "deleted";
      });
    }
  }
  if (connected.includes("googlecalendar")) {
    await step("calendar", "read events", async () => {
      await execDirect(userId, "GOOGLECALENDAR_EVENTS_LIST", { calendar_id: "primary", max_results: 5 });
      return "listed";
    });
    let eventId = "";
    const created = await step("calendar", "create test event", async () => {
      const d = await execDirect(userId, "GOOGLECALENDAR_QUICK_ADD", { calendar_id: "primary", text: `${MARK} tomorrow 4am` });
      eventId = firstId(d, "id", "event.id", "response_data.id", "event_data.id");
      return eventId ? `event ${eventId}` : "created (no id returned)";
    });
    if (created && eventId) {
      await step("calendar", "verify event live", async () => {
        await execDirect(userId, "GOOGLECALENDAR_GET_EVENT", { calendar_id: "primary", event_id: eventId });
        return "found";
      });
      await step("calendar", "clean up event", async () => {
        await execDirect(userId, "GOOGLECALENDAR_DELETE_EVENT", { calendar_id: "primary", event_id: eventId });
        return "deleted";
      });
    }
  }
  if (connected.includes("googledrive")) {
    await step("drive", "list files", async () => {
      await execDirect(userId, "GOOGLEDRIVE_LIST_FILES", { page_size: 5 });
      return "listed";
    });
  }
  if (connected.includes("googledocs")) {
    let docId = "";
    const created = await step("docs", "create test doc", async () => {
      const d = await execDirect(userId, "GOOGLEDOCS_CREATE_DOCUMENT", { title: MARK, text: "Created by Otto's integration check." });
      docId = firstId(d, "documentId", "document_id", "response_data.documentId", "id");
      return docId ? `doc ${docId}` : "created (no id returned)";
    });
    if (created && docId) {
      await step("docs", "verify doc live", async () => {
        await execDirect(userId, "GOOGLEDOCS_GET_DOCUMENT_BY_ID", { id: docId });
        return "found";
      });
      if (connected.includes("googledrive")) await step("docs", "clean up doc", async () => {
        await execDirect(userId, "GOOGLEDRIVE_DELETE_FILE", { file_id: docId });
        return "deleted";
      });
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
      await step("sheets", "write cell", async () => {
        await execDirect(userId, "GOOGLESHEETS_UPDATE_VALUES", { spreadsheet_id: sheetId, range: "A1", values: [["otto-check"]], value_input_option: "RAW" });
        return "wrote A1";
      });
      await step("sheets", "read cell back", async () => {
        const d = await execDirect(userId, "GOOGLESHEETS_BATCH_GET", { spreadsheet_id: sheetId, ranges: ["A1"] });
        if (!JSON.stringify(d ?? "").includes("otto-check")) throw new Error("written value not found on read-back");
        return "verified round-trip";
      });
      if (connected.includes("googledrive")) await step("sheets", "clean up sheet", async () => {
        await execDirect(userId, "GOOGLEDRIVE_DELETE_FILE", { file_id: sheetId });
        return "deleted";
      });
    }
  }
  if (!results.length) results.push({ app: "none", step: "connected apps", ok: false, detail: "Nothing connected to check \u2014 connect Gmail/Calendar/Drive first." });
  return results;
}
var NOT_FOUND = /(not.?found|404|does ?n.t exist|invalid.*(id|value)|deleted|no such)/i;
async function probeArtifact(userId, action, args, expectRef) {
  try {
    const data = await readAction(userId, action, args);
    if (!expectRef) return true;
    return JSON.stringify(data ?? "").includes(expectRef);
  } catch (e) {
    return NOT_FOUND.test(String(e?.message || "")) ? false : null;
  }
}
var DOC_LINK = /docs\.google\.com\/(document|spreadsheets|presentation)\/(?:d\/)?([-\w]{25,})/i;
async function verifyTaskArtifacts(userId, t) {
  if (!integrationsReady() || !userId) return [];
  const dropped = [];
  const gmailSendables = (t.sendables || []).filter((s) => s.app === "gmail" && s.draftId);
  let draftsPayload = null;
  if (gmailSendables.length) {
    try {
      draftsPayload = JSON.stringify(await readAction(userId, "GMAIL_LIST_DRAFTS", { max_results: 50 }) ?? "");
    } catch {
      draftsPayload = null;
    }
  }
  const keptSendables = [];
  for (const s of t.sendables || []) {
    let ok = null;
    if (s.app === "gmail" && s.draftId && draftsPayload !== null) ok = draftsPayload.includes(s.draftId);
    else if (s.app === "gcal" && s.eventId) ok = await probeArtifact(userId, "GOOGLECALENDAR_GET_EVENT", { event_id: s.eventId });
    if (ok === false) dropped.push(`"${s.label}" \u2014 the ${s.app === "gcal" ? "calendar event" : "draft"} it points at doesn't exist`);
    else keptSendables.push(s);
  }
  const keptLinks = [];
  for (const l of t.links || []) {
    const m = DOC_LINK.exec(l.url);
    let ok = null;
    if (m && m[1] === "document") ok = await probeArtifact(userId, "GOOGLEDOCS_GET_DOCUMENT_BY_ID", { id: m[2] });
    else if (m && m[1] === "spreadsheets") ok = await probeArtifact(userId, "GOOGLESHEETS_GET_SPREADSHEET_INFO", { spreadsheet_id: m[2] });
    if (ok === false) dropped.push(`"${l.label}" \u2014 the linked document doesn't exist`);
    else keptLinks.push(l);
  }
  if (t.sendables) t.sendables = keptSendables;
  if (t.links) t.links = keptLinks;
  if (dropped.length) console.warn(`[integrations] artifact verification dropped ${dropped.length}: ${dropped.join("; ")}`);
  return dropped;
}
async function getAgentTools(userId, opts) {
  if (!integrationsReady() || !userId) return EMPTY;
  const gmailAccountId = opts?.gmailAccountId;
  const cacheKey = gmailAccountId ? `${userId}::gmail:${gmailAccountId}` : userId;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const connected = await listConnectedToolkits(userId);
  if (!connected.length) {
    const data2 = { ...EMPTY, connected };
    cache.set(userId, { at: Date.now(), data: data2 });
    return data2;
  }
  const tools = [];
  const map = /* @__PURE__ */ new Map();
  const MAX = 90;
  const perToolkit = Math.min(10, Math.max(6, Math.floor(MAX / connected.length)));
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
    const writes = dedupeFamilies(ranked.filter((x) => !isRead(x.rawName))).sort((a, b) => relevance(b.rawName) - relevance(a.rawName));
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
      tools.push({ name, description: `[${app2}] ${String(fn?.description ?? rawName).slice(0, 140)}`, input_schema: slimSchema(params) });
      added++;
    }
  }
  const makeCall = (allowIds) => async (name, args) => {
    const action = map.get(name);
    if (!action) return null;
    if (isGatedAction(action)) return `Blocked: "${action}" is an irreversible send/delete \u2014 leave it as a step for the user instead.`;
    if (isWriteGatedAction(action)) {
      const argStr = JSON.stringify(args || {});
      const targetsOwnArtifact = !!allowIds && [...allowIds].some((id) => id.length >= 8 && argStr.includes(id));
      if (!targetsOwnArtifact) {
        return `PERMISSION_REQUIRED: "${action}" requires explicit user approval before it can run. Add it as an automatable step in submit() so the user can approve it with one click.`;
      }
    }
    if (/^GOOGLECALENDAR_/.test(action) && args && ("attendees" in args || "send_updates" in args)) {
      args = { ...args, send_updates: "none" };
    }
    try {
      return await execute(action, userId, args || {}, /^GMAIL_/.test(action) ? gmailAccountId : void 0);
    } catch (e) {
      return `Tool error (${action}): ${e?.message ?? e}`;
    }
  };
  const data = {
    tools,
    call: makeCall(),
    connected,
    // Only offered when Gmail is connected — that's both the send channel and the recipient source.
    selfBrief: connected.includes("gmail") ? (subject, body) => sendSelfBrief(userId, subject, body) : void 0
  };
  data.withAllowedArtifacts = (ids) => ({ ...data, call: makeCall(new Set(ids.filter(Boolean))), withAllowedArtifacts: data.withAllowedArtifacts });
  cache.set(cacheKey, { at: Date.now(), data });
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

// server/discover.ts
var NOISE_SENDER = /no-?reply|donotreply|newsletter|marketing|notifications?@|updates?@|news@|mailer@|bounce|billing@|receipts?@|noreply/i;
var NOISE_SUBJECT = /unsubscribe|newsletter|weekly digest|daily digest|% off|sale ends|flash sale|your receipt|order confirmation|payment received|has shipped|delivery update|verify your email|security alert/i;
function isNoise(it) {
  if (it.labels.includes("sent")) return false;
  return NOISE_SENDER.test(it.sender || "") || NOISE_SUBJECT.test(it.title || "");
}
var normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function gmailToItems(data, label, account) {
  const msgs = data?.messages || data?.data?.messages || data?.response_data?.messages || (Array.isArray(data) ? data : []);
  return (msgs || []).slice(0, 25).map((m) => {
    const threadId = String(m?.threadId ?? m?.thread_id ?? m?.id ?? "").trim();
    if (!threadId) return null;
    return {
      sourceApp: "gmail",
      externalId: threadId,
      anchorKey: `gmail:${threadId}`,
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      title: String(m?.subject ?? m?.messageSubject ?? "(no subject)").slice(0, 140),
      snippet: String(m?.preview?.body ?? m?.snippet ?? m?.messageText ?? m?.preview ?? "").replace(/\s+/g, " ").slice(0, 400),
      sender: String(m?.sender ?? m?.from ?? m?.fromAddress ?? "").slice(0, 120),
      timestamp: String(m?.messageTimestamp ?? m?.internalDate ?? m?.date ?? ""),
      labels: [label],
      accountId: account?.id,
      accountEmail: account?.email
    };
  }).filter((x) => !!x);
}
function calendarToItems(data, now = Date.now()) {
  const evs = data?.items || data?.events || data?.data?.items || (Array.isArray(data) ? data : []);
  return (evs || []).slice(0, 25).map((e) => {
    const id = String(e?.id ?? e?.eventId ?? "").trim();
    if (!id) return null;
    const start = e?.start?.dateTime || e?.start?.date || e?.start || "";
    const startMs = Date.parse(String(start)) || 0;
    if (startMs && startMs < now - 60 * 6e4) return null;
    return {
      sourceApp: "calendar",
      externalId: id,
      anchorKey: `calendar:${id}`,
      url: e?.htmlLink || void 0,
      title: String(e?.summary ?? "(untitled event)").slice(0, 140),
      snippet: `${start}${e?.location ? ` @ ${e.location}` : ""}${e?.description ? ` \u2014 ${String(e.description).replace(/\s+/g, " ").slice(0, 140)}` : ""}`,
      sender: String(e?.organizer?.email ?? "").slice(0, 120),
      timestamp: String(start),
      labels: ["event"]
    };
  }).filter((x) => !!x);
}
function driveToItems(data) {
  const files = data?.files || data?.items || data?.data?.files || (Array.isArray(data) ? data : []);
  return (files || []).slice(0, 15).map((f) => {
    const id = String(f?.id ?? f?.fileId ?? "").trim();
    if (!id) return null;
    const modifiedBy = String(f?.lastModifyingUser?.emailAddress ?? f?.lastModifyingUser?.displayName ?? "");
    return {
      sourceApp: "drive",
      externalId: id,
      anchorKey: `drive:${id}`,
      url: f?.webViewLink || void 0,
      title: String(f?.name ?? f?.title ?? "(untitled file)").slice(0, 140),
      snippet: `${f?.mimeType ? String(f.mimeType).replace("application/vnd.google-apps.", "") : "file"}${modifiedBy ? ` \u2014 last modified by ${modifiedBy}` : ""}${f?.sharedWithMeTime ? ` \u2014 shared with you ${f.sharedWithMeTime}` : ""}`,
      sender: modifiedBy.slice(0, 120),
      timestamp: String(f?.modifiedTime ?? f?.sharedWithMeTime ?? ""),
      labels: [f?.sharedWithMeTime ? "shared" : "modified"]
    };
  }).filter((x) => !!x);
}
function githubToItems(data, label) {
  const rows = data?.issues || data?.items || (Array.isArray(data) ? data : []);
  return (rows || []).slice(0, 15).map((r) => {
    const url2 = String(r?.html_url ?? r?.htmlUrl ?? "").trim();
    const num = r?.number;
    const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(url2)?.[1] || "";
    if (!url2 || !Number.isInteger(num)) return null;
    return {
      sourceApp: "github",
      externalId: `${repo}#${num}`,
      anchorKey: `github:${repo}#${num}`,
      url: url2,
      title: String(r?.title ?? "(untitled)").slice(0, 140),
      snippet: `${r?.pull_request || /\/pull\//.test(url2) ? "PR" : "issue"} in ${repo}${r?.user?.login ? ` \u2014 opened by ${r.user.login}` : ""}`,
      sender: String(r?.user?.login ?? "").slice(0, 120),
      timestamp: String(r?.updated_at ?? r?.created_at ?? ""),
      labels: [label]
    };
  }).filter((x) => !!x);
}
async function discoverSourceItems(userEmail) {
  const items = [];
  let attempted = false;
  const grab = async (fn) => {
    try {
      const got = await fn();
      attempted = true;
      items.push(...got);
    } catch {
    }
  };
  let gmailAccounts = [{}];
  try {
    const accs = await getConnectedAccounts(userEmail, "gmail");
    if (accs.length > 1) gmailAccounts = accs.map((a) => ({ id: a.id, email: a.email }));
  } catch {
  }
  const gmailGrabs = gmailAccounts.flatMap((acc) => [
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:inbox newer_than:7d -category:promotions -category:social",
      max_results: 20
    }, acc.id), "inbox", acc)),
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:sent newer_than:10d",
      max_results: 15
    }, acc.id), "sent", acc))
  ]);
  await Promise.all([
    ...gmailGrabs,
    grab(async () => {
      const now = /* @__PURE__ */ new Date();
      const week = new Date(now.getTime() + 7 * 24 * 3600 * 1e3);
      return calendarToItems(await readAction(userEmail, "GOOGLECALENDAR_EVENTS_LIST", {
        timeMin: now.toISOString(),
        timeMax: week.toISOString(),
        maxResults: 20,
        singleEvents: true,
        orderBy: "startTime"
      }));
    }),
    // Drive: recent files OTHERS shared/touched — docs waiting on the user that never arrive by email.
    grab(async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1e3).toISOString().split(".")[0];
      const files = driveToItems(await readAction(userEmail, "GOOGLEDRIVE_LIST_FILES", {
        q: `(sharedWithMe = true or modifiedTime > '${since}') and trashed = false`,
        orderBy: "modifiedTime desc",
        pageSize: 15,
        fields: "files(id,name,mimeType,webViewLink,modifiedTime,sharedWithMeTime,lastModifyingUser)"
      }));
      return files.filter((f) => f.labels.includes("shared") || f.sender && !f.sender.toLowerCase().includes(userEmail.split("@")[0].toLowerCase()));
    }),
    // GitHub (if connected): things waiting on the user — open issues assigned to them, PRs where their
    // review was requested. Both fail silently for accounts without GitHub.
    grab(async () => githubToItems(await readAction(userEmail, "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", {
      filter: "assigned",
      state: "open",
      per_page: 10
    }), "assigned")),
    grab(async () => githubToItems(await readAction(userEmail, "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", {
      q: "is:open is:pr review-requested:@me",
      per_page: 10
    }), "review-requested"))
  ]);
  return { items: dedupeByThread(items), attempted };
}
function dedupeByThread(items) {
  const byAnchor = /* @__PURE__ */ new Map();
  const ts = (it) => Date.parse(it.timestamp || "") || Number(it.timestamp) || 0;
  for (const it of items) {
    const k = normKey(it.anchorKey);
    const cur = byAnchor.get(k);
    if (!cur) {
      byAnchor.set(k, it);
      continue;
    }
    const inbox = cur.labels.includes("inbox") ? cur : it.labels.includes("inbox") ? it : null;
    const sent = cur.labels.includes("sent") ? cur : it.labels.includes("sent") ? it : null;
    if (inbox && sent) byAnchor.set(k, ts(sent) >= ts(inbox) ? sent : inbox);
  }
  return [...byAnchor.values()];
}
function filterCandidates(items, knownAnchors) {
  const known = new Set(knownAnchors.map(normKey).filter(Boolean));
  return items.filter((it) => !isNoise(it) && !known.has(normKey(it.anchorKey)));
}

// server/tasks.ts
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
var MIN_HISTORY = 5;
var DECAY_DAYS = 30;
function updateConfidence(profile, actionCategory, approved) {
  if (!profile.confidence) profile.confidence = {};
  if (!profile.confidenceHistory) profile.confidenceHistory = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  profile.confidenceHistory.push({ action: actionCategory, approved, at: now });
  if (profile.confidenceHistory.length > 100) {
    profile.confidenceHistory = profile.confidenceHistory.slice(-100);
  }
  const recent = profile.confidenceHistory.filter((h) => h.action === actionCategory);
  if (recent.length < MIN_HISTORY) {
    const current = profile.confidence[actionCategory] || 0.5;
    profile.confidence[actionCategory] = approved ? Math.min(1, current + 0.05) : Math.max(0, current - 0.1);
    return;
  }
  let weightedSum = 0;
  let totalWeight = 0;
  const nowMs = Date.now();
  for (const h of recent) {
    const ageMs = nowMs - new Date(h.at).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1e3);
    const weight = Math.max(0.1, 1 - ageDays / DECAY_DAYS);
    weightedSum += (h.approved ? 1 : 0) * weight;
    totalWeight += weight;
  }
  const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  profile.confidence[actionCategory] = confidence;
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
var tokenMatches = (w, set) => {
  if (set.has(w)) return true;
  for (const x of set) if (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))) return true;
  return false;
};
function tokenOverlap(a, b) {
  const A = distinctiveTokens(a), B = distinctiveTokens(b);
  if (!A.size || !B.size) return { jaccard: 0, containment: 0, inter: 0 };
  let inter = 0;
  for (const w of A) if (tokenMatches(w, B)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), containment: inter / Math.min(A.size, B.size), inter };
}
function nearDup(a, b) {
  const { jaccard, containment, inter } = tokenOverlap(a, b);
  return jaccard >= 0.55 || inter >= 3 && containment >= 0.75 || inter >= 2 && containment >= 0.9;
}
function looseDup(a, b) {
  const { jaccard, containment, inter } = tokenOverlap(a, b);
  return jaccard >= 0.4 || inter >= 2 && containment >= 0.6;
}
function pruneHandled(list, keep) {
  const active = list.filter((t) => t.status !== "done" && t.status !== "dismissed");
  const handled = list.filter((t) => t.status === "done" || t.status === "dismissed").sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, keep);
  return [...active, ...handled];
}
var normKey2 = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
var linkOf = (t) => (t.evidence || []).map((e) => e.url).find(Boolean) || "";
var rankStatus = (t) => {
  const c = canonStatus(t.status);
  return c === "done" || c === "dismissed" ? 6 : c === "needs_review" ? 5 : c === "failed_terminal" ? 4 : c === "failed_retryable" ? 3 : c === "executing" ? 2.5 : c === "queued" ? 2 : 1;
};
var betterOf = (a, b) => rankStatus(b) > rankStatus(a) ? b : a;
var sameTask = (a, b) => nearDup(a.title, b.title) || a.source === b.source && nearDup(a.why, b.why);
function dedupeTasks(list) {
  const kept = [];
  for (const t of list) {
    const ak = normKey2(t.anchorKey), link = linkOf(t);
    const i = kept.findIndex((k) => {
      const kak = normKey2(k.anchorKey);
      if (!!ak && kak === ak) return true;
      if (!!link && linkOf(k) === link) return true;
      if (!!ak && !!kak && kak !== ak && (k.status === "done" || k.status === "dismissed")) return false;
      return sameTask(k, t);
    });
    if (i >= 0) kept[i] = betterOf(kept[i], t);
    else kept.push(t);
  }
  return kept;
}
function mergeTaskLists(existing, incoming) {
  const rank = (s) => rankStatus({ status: s });
  const when = (t) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  const map = /* @__PURE__ */ new Map();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) {
    const ext = map.get(t.id);
    if (!ext) {
      map.set(t.id, t);
      continue;
    }
    const winner = rank(t.status) > rank(ext.status) ? t : rank(t.status) < rank(ext.status) ? ext : when(t) >= when(ext) ? t : ext;
    const loser = winner === t ? ext : t;
    const steps = winner.steps?.map((s) => {
      if (s.done) return s;
      const other = loser.steps?.find((o) => o.text === s.text);
      return other?.done ? { ...s, done: true, doneAt: other.doneAt, result: s.result ?? other.result } : s;
    });
    map.set(t.id, steps ? { ...winner, steps } : winner);
  }
  return dedupeTasks(Array.from(map.values()));
}
function mergeProfileStates(p1, p2) {
  const pausedAt = (p) => Date.parse(p.pausedAt || "") || 0;
  const pausedSide = pausedAt(p2) >= pausedAt(p1) ? p2 : p1;
  return {
    name: p2.name || p1.name,
    about: p2.about || p1.about,
    preferences: dedupeFacts([...p1.preferences || [], ...p2.preferences || []]),
    people: dedupeFacts([...p1.people || [], ...p2.people || []]),
    projects: dedupeFacts([...p1.projects || [], ...p2.projects || []]),
    paused: pausedSide.paused,
    pausedAt: pausedSide.pausedAt,
    // Keep the MOST RECENT sweep marker across devices/instances (a stale copy must never reset it).
    lastSweepAt: (Date.parse(p2.lastSweepAt || "") || 0) >= (Date.parse(p1.lastSweepAt || "") || 0) ? p2.lastSweepAt ?? p1.lastSweepAt : p1.lastSweepAt ?? p2.lastSweepAt,
    lastForcedAt: (Date.parse(p2.lastForcedAt || "") || 0) >= (Date.parse(p1.lastForcedAt || "") || 0) ? p2.lastForcedAt ?? p1.lastForcedAt : p1.lastForcedAt ?? p2.lastForcedAt,
    // Structured settings: explicit ?? picks (a plain {...p2} spread would clobber p1's values with
    // p2's explicit `undefined` keys from normalizeProfile — the bug that silently dropped workingHours).
    workingHours: p2.workingHours ?? p1.workingHours,
    responseStyle: p2.responseStyle ?? p1.responseStyle,
    autoApprove: p2.autoApprove ?? p1.autoApprove,
    highPriorityPeople: p2.highPriorityPeople ?? p1.highPriorityPeople,
    autoArchivePatterns: p2.autoArchivePatterns ?? p1.autoArchivePatterns,
    // Usage counters are monotonic — take the MAX of each field so a stale copy can't reset the total
    // (a concurrent increment on another instance may under-count by one delta; fine for a display metric).
    usage: p1.usage || p2.usage ? {
      in: Math.max(p1.usage?.in || 0, p2.usage?.in || 0),
      out: Math.max(p1.usage?.out || 0, p2.usage?.out || 0),
      runs: Math.max(p1.usage?.runs || 0, p2.usage?.runs || 0),
      since: [p1.usage?.since, p2.usage?.since].filter(Boolean).sort()[0] || (/* @__PURE__ */ new Date()).toISOString()
    } : void 0
  };
}
var MAX_NEW_PER_SWEEP = 8;
function applyQualityBar(genTasks, items, vips = []) {
  const byAnchor = new Map(items.map((i) => [normKey2(i.anchorKey), i]));
  const vipTokens = vips.flatMap((v) => {
    const email = v.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const name = v.split(/[—\-(,]/)[0].trim().toLowerCase();
    return [email, name.length >= 3 ? name : void 0].filter((x) => !!x);
  });
  const isVip = (sender) => !!sender && vipTokens.some((tok) => sender.toLowerCase().includes(tok));
  return genTasks.filter((g) => {
    const it = byAnchor.get(normKey2(g.anchorKey));
    if (it?.labels?.includes("sent") && g.when) return true;
    if (isVip(it?.sender)) return true;
    return g.importance >= 0.35 || g.urgency >= 0.35;
  });
}
function localDayOf(iso, timezone) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
function forcedDueToday(profile, now = /* @__PURE__ */ new Date()) {
  if (!profile.lastForcedAt) return true;
  const tz = profile.workingHours?.timezone;
  return localDayOf(profile.lastForcedAt, tz) !== localDayOf(now.toISOString(), tz);
}
async function generate(existing, profile, extras, userEmail) {
  const handled = existing.filter((t) => t.status === "done" || t.status === "dismissed").map((t) => ({
    title: t.title,
    why: t.why,
    source: t.source,
    when: t.when,
    anchorKey: t.anchorKey,
    link: t.evidence?.find((e) => e.url)?.url
  }));
  const active = existing.filter((t) => t.status !== "done" && t.status !== "dismissed").map((t) => ({ title: t.title, anchorKey: t.anchorKey }));
  if (userEmail) {
    try {
      const { items, attempted } = await discoverSourceItems(userEmail);
      if (attempted) {
        const knownAnchors = existing.map((t) => t.anchorKey);
        const candidates = filterCandidates(items, knownAnchors);
        const classified = candidates.length ? await classifyCandidates(candidates, profile, active.map((a) => a.title)) : { tasks: [], profileUpdates: [] };
        addUsage(profile, classified.tokens);
        for (const u of classified.profileUpdates) applyProfileUpdate(profile, u);
        const kept = applyQualityBar(classified.tasks, candidates, profile.highPriorityPeople || []);
        const folded = foldGenerated(existing, kept, profile.highPriorityPeople || []);
        const newCards = folded.filter((t) => t.status === "ready" && !existing.some((e) => e.id === t.id)).length;
        console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [tasks] sweep pipeline: ${items.length} items \u2192 ${candidates.length} candidates \u2192 ${classified.tasks.length} classified \u2192 ${kept.length} passed bar \u2192 ${newCards} new card${newCards === 1 ? "" : "s"}`);
        if (newCards === 0 && candidates.length && forcedDueToday(profile)) {
          const one = await pickOneTask(candidates, profile, active.map((a) => a.title));
          if (one) {
            addUsage(profile, one.tokens);
            profile.lastForcedAt = (/* @__PURE__ */ new Date()).toISOString();
            const withForced = foldGenerated(existing, [...kept, one.task], profile.highPriorityPeople || []);
            const forcedNew = withForced.filter((t) => t.status === "ready" && !existing.some((e) => e.id === t.id)).length;
            console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [tasks] daily-minimum: forced "${one.task.title}" (${forcedNew} new after fold)`);
            return withForced;
          }
        }
        return folded;
      }
    } catch (e) {
      console.warn("[tasks] discovery pipeline failed, falling back to agent sweep:", e?.message || e);
    }
  }
  const gen = await generateTasks(profile, extras ? readOnly(extras) : void 0, handled, active);
  addUsage(profile, gen.tokens);
  for (const u of gen.profileUpdates) applyProfileUpdate(profile, u);
  return foldGenerated(existing, gen.tasks, profile.highPriorityPeople || []);
}
function foldGenerated(existing, genTasks, highPriorityPeople = []) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const dismissed = existing.filter((t) => t.status === "dismissed");
  const resemblesDismissed = (g) => dismissed.some((d) => !!g.anchorKey && !!d.anchorKey && normKey2(g.anchorKey) === normKey2(d.anchorKey) || !!g.link && linkOf(d) === g.link || looseDup(g.title, d.title) || looseDup(g.title, d.why) || looseDup(g.why, d.title) || g.source === d.source && looseDup(g.why, d.why));
  genTasks = genTasks.filter((g) => !resemblesDismissed(g));
  const candidates = [...existing];
  const freshIds = /* @__PURE__ */ new Set();
  for (const g of genTasks) {
    const e = eisenhower(g.urgency, g.importance);
    const evidence = g.link ? [{ label: g.source === "calendar" ? "Open event" : g.source === "gmail" ? "Open in Gmail" : g.source === "github" ? "Open on GitHub" : "Open source", url: g.link }] : void 0;
    const id = randomUUID();
    freshIds.add(id);
    candidates.push({
      id,
      title: g.title,
      why: g.why,
      when: g.when,
      source: g.source,
      risk: g.risk,
      sourceAccountId: g.accountId,
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
  const deduped = dedupeTasks(candidates);
  const keepNew = new Set(
    deduped.filter((t) => freshIds.has(t.id)).sort((a, b) => b.score - a.score).slice(0, MAX_NEW_PER_SWEEP).map((t) => t.id)
  );
  const calmed = deduped.filter((t) => !freshIds.has(t.id) || keepNew.has(t.id));
  return pruneHandled(sortWithinQuadrant(calmed, highPriorityPeople), 120);
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
    createdAt: now,
    ...refined ? {} : { unrefined: true }
    // AI paused/unavailable — raw text in, offer Refine later
  });
  return list;
}
function applyRefinement(list, id, refined) {
  const t = list.find((x) => x.id === id);
  if (!t || !refined) return t;
  t.title = refined.title.trim().slice(0, 120) || t.title;
  t.why = refined.why || t.why;
  t.when = refined.when ?? t.when;
  t.urgency = refined.urgency;
  t.importance = refined.importance;
  const e = eisenhower(t.urgency, t.importance);
  t.quadrant = e.quadrant;
  t.score = e.score;
  delete t.unrefined;
  t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return t;
}
function extractArtifacts(out) {
  const found = [];
  for (const l of out.links || []) {
    const m = DOC_LINK.exec(l.url);
    if (m) found.push({ kind: m[1] === "spreadsheets" ? "sheet" : m[1] === "presentation" ? "slides" : "doc", id: m[2], url: l.url, label: l.label });
  }
  for (const s of out.sendables || []) {
    if (s.app === "gmail" && s.draftId) found.push({ kind: "draft", id: s.draftId, label: s.label });
    if (s.app === "gcal" && s.eventId) found.push({ kind: "event", id: s.eventId, label: s.label });
  }
  return found;
}
function unionArtifacts(prior, fresh) {
  const map = /* @__PURE__ */ new Map();
  for (const a of [...prior || [], ...fresh]) if (a?.id) map.set(a.id, { ...map.get(a.id), ...a });
  const all = [...map.values()].slice(-12);
  return all.length ? all : void 0;
}
async function runById(list, id, profile, extras, revision) {
  const task = list.find((t) => t.id === id);
  if (!task) return void 0;
  if (canonStatus(task.status) === "executing") return task;
  task.status = "executing";
  task.autoRan = true;
  const focus = revision?.trim() ? `The user reviewed your previous draft/output for this task and wants this CHANGE before they send it: "${revision.trim()}". Redo the task incorporating it \u2014 UPDATE the existing draft/doc (don't create a new copy) and re-offer it as a sendable.` : void 0;
  try {
    const priorArtifactIds = (task.artifacts || []).map((a) => a.id);
    const withArtifacts = extras?.withAllowedArtifacts && priorArtifactIds.length ? extras.withAllowedArtifacts(priorArtifactIds) : extras;
    const scoped = withArtifacts ? scopeTools(withArtifacts, task) : void 0;
    if (extras && scoped) console.log(`[tasks] run "${task.title.slice(0, 40)}": ${scoped.tools.length}/${extras.tools.length} tools after scoping`);
    const out = await runTask({ title: task.title, why: task.why, source: task.source, links: task.links, artifacts: task.artifacts }, profile, focus, scoped);
    for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
    task.context = out.context;
    task.synthesis = out.synthesis;
    task.did = out.did?.length ? out.did : void 0;
    const prior = (task.steps || []).filter((s) => s.done);
    task.steps = (out.steps || []).map((s) => {
      const old = prior.find((o) => nearDup(o.text, s.text));
      return old ? { ...s, done: true, doneAt: old.doneAt, result: s.result || old.result } : s;
    });
    task.links = out.links?.length ? out.links : void 0;
    task.sendables = out.sendables?.length ? out.sendables : void 0;
    task.artifacts = unionArtifacts(task.artifacts, extractArtifacts(out));
    task.lastRunTokens = out.tokens;
    addUsage(profile, out.tokens);
    task.status = "needs_review";
    task.lastError = void 0;
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    return task;
  } catch (e) {
    task.status = "failed_retryable";
    task.lastError = String(e?.message || e).slice(0, 300);
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
  addUsage(profile, out.tokens);
  for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
  step.result = out.synthesis.slice(0, 1200);
  if ((out.steps || []).some((s) => !s.automatable && !s.synthetic)) {
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
  task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return task;
}

// server/jobs.ts
var workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
function localDay(iso, timezone) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
function sweepDueForDay(lastSweepAt, profile, now = /* @__PURE__ */ new Date()) {
  if (!lastSweepAt) return true;
  const tz = profile.workingHours?.timezone;
  return localDay(lastSweepAt, tz) !== localDay(now, tz);
}
async function loadUser(email) {
  const st = await loadState(email);
  return { profile: st.profile || emptyProfile(), list: st.tasks || [] };
}
async function commitUser(email, profile, list) {
  const current = await loadState(email);
  const mergedTasks = mergeTaskLists(current.tasks || [], list);
  const mergedProfile = mergeProfileStates(current.profile || emptyProfile(), profile);
  await saveState(email, { profile: mergedProfile, tasks: mergedTasks, google: current.google });
}
async function processSweep(job) {
  const email = job.user_email;
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  const extras = await getAgentTools(email);
  if (!extras?.tools?.length) return "skipped: nothing connected";
  const before = new Set(list.map((t) => t.id));
  const factsBefore = /* @__PURE__ */ new Set([...profile.preferences, ...profile.people, ...profile.projects]);
  for (const t of list.filter((x) => x.unrefined && !isHandled(x.status)).slice(0, 3)) {
    try {
      const refined = await refineManualTask(t.title, profile);
      if (refined) {
        applyRefinement(list, t.id, refined);
        void recordEvent(email, "refined", { taskId: t.id, message: `Refined to "${t.title}"` });
      }
    } catch {
    }
  }
  const next = await generate(list, profile, extras, email);
  const learned = [...profile.preferences, ...profile.people, ...profile.projects].filter((f) => !factsBefore.has(f));
  for (const f of learned) void recordEvent(email, "learned", { jobId: job.id, message: f.slice(0, 200) });
  const found = next.filter((t) => !before.has(t.id) && !isHandled(t.status));
  const toRun = found.filter((t) => canonStatus(t.status) === "ready").sort((a, b) => b.score - a.score).slice(0, 3);
  for (const t of toRun) t.status = "queued";
  profile.lastSweepAt = (/* @__PURE__ */ new Date()).toISOString();
  await commitUser(email, profile, next);
  for (const t of found) void recordEvent(email, "found", { taskId: t.id, jobId: job.id, message: `Found from ${t.source}` });
  for (const t of toRun) {
    await enqueueJob(email, "execute_task", t.id);
    void recordEvent(email, "queued", { taskId: t.id, message: "Queued for execution" });
  }
  return `swept: ${found.length} new task${found.length === 1 ? "" : "s"}, ${toRun.length} queued${learned.length ? `, learned ${learned.length} fact${learned.length === 1 ? "" : "s"}` : ""}`;
}
async function markTaskStatus(email, taskId, status) {
  const { profile, list } = await loadUser(email);
  const t = list.find((x) => x.id === taskId);
  if (!t || isHandled(t.status)) return;
  t.status = status;
  t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await commitUser(email, profile, list);
}
async function processExecuteTask(job) {
  const email = job.user_email;
  const taskId = String(job.task_id || "");
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  const t = list.find((x) => x.id === taskId);
  if (!t) return "skipped: task not found";
  const c = canonStatus(t.status);
  if (isHandled(t.status)) return "skipped: already handled";
  if (c === "needs_review" && !job.input?.note) return "skipped: already executed";
  if (c === "failed_terminal" && !job.input?.manual) return "skipped: failed terminally \u2014 waiting for the user's Retry";
  await recordEvent(email, "run_started", { taskId, jobId: job.id, message: job.input?.note ? "Revising per your note" : "Reading context and doing the reversible work" });
  const extras = await getAgentTools(email, t.sourceAccountId ? { gmailAccountId: t.sourceAccountId } : void 0);
  t.autoRan = true;
  try {
    const updated = await runById(list, taskId, profile, extras, job.input?.note ? String(job.input.note) : void 0);
    if (updated && (updated.links?.length || updated.sendables?.length)) {
      const droppedArtifacts = await verifyTaskArtifacts(email, updated).catch(() => []);
      for (const d of droppedArtifacts) void recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
      if (droppedArtifacts.length) void recordEvent(email, "verified", { taskId, jobId: job.id, message: "Remaining artifacts verified against the live account" });
      else void recordEvent(email, "verified", { taskId, jobId: job.id, message: "Artifacts verified against the live account" });
    }
    await commitUser(email, profile, list);
    const done = updated?.steps?.length ? `${updated.steps.filter((s) => !s.done).length} step(s) need you` : "fully handled";
    const cost = updated?.lastRunTokens ? ` (${Math.round(updated.lastRunTokens.in / 1e3)}k tokens)` : "";
    await recordEvent(email, "run_succeeded", { taskId, jobId: job.id, message: (updated?.synthesis?.slice(0, 200) || done) + cost });
    return updated?.synthesis || "executed";
  } catch (e) {
    if (t && !isHandled(t.status)) {
      if (job.attempt_count >= job.max_attempts) t.status = "failed_terminal";
      t.autoRan = true;
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    await commitUser(email, profile, list);
    throw e;
  }
}
async function processExecuteStep(job) {
  const email = job.user_email;
  const taskId = String(job.task_id || "");
  const index = Number(job.input?.index);
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  if (!Number.isInteger(index)) return "skipped: bad step index";
  await recordEvent(email, "step_started", { taskId, jobId: job.id, message: `Running step ${index + 1}` });
  const permTools = await getAgentToolsWithPermission(email).catch(() => void 0);
  const updated = await runStep(list, taskId, index, profile, permTools, job.input?.answer ? String(job.input.answer) : void 0);
  if (updated && (updated.links?.length || updated.sendables?.length)) {
    const droppedArtifacts = await verifyTaskArtifacts(email, updated).catch(() => []);
    for (const d of droppedArtifacts) void recordEvent(email, "artifact_dropped", { taskId, jobId: job.id, message: d.slice(0, 200) });
  }
  await commitUser(email, profile, list);
  await recordEvent(email, "step_done", { taskId, jobId: job.id, message: updated?.steps?.[index]?.text?.slice(0, 200) });
  return "step executed";
}
async function processEndOfDayReport(job) {
  const email = job.user_email;
  const { profile, list } = await loadUser(email);
  if (profile.paused) return "skipped: AI paused";
  const extras = await getAgentTools(email);
  if (!extras?.selfBrief) return "skipped: Gmail not connected for report";
  const completed = list.filter((t) => canonStatus(t.status) === "done").slice(-10);
  const active = list.filter((t) => !isHandled(t.status)).slice(0, 15);
  const highPriority = active.filter((t) => t.importance >= 0.7).slice(0, 5);
  const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  let body = `End of day report \u2014 ${today}

`;
  if (completed.length) {
    body += `\u2713 Completed today (${completed.length}):
`;
    for (const t of completed) {
      body += `  \u2022 ${t.title}
`;
    }
    body += "\n";
  }
  if (active.length) {
    body += `\u{1F4CB} Still active (${active.length}):
`;
    for (const t of active.slice(0, 8)) {
      const urgency = t.urgency >= 0.7 ? "\u{1F534}" : t.urgency >= 0.4 ? "\u{1F7E1}" : "\u{1F7E2}";
      body += `  ${urgency} ${t.title}${t.when ? ` (${t.when})` : ""}
`;
    }
    body += "\n";
  }
  if (highPriority.length) {
    body += `\u26A1 High priority:
`;
    for (const t of highPriority) {
      body += `  \u2022 ${t.title}${t.when ? ` \u2014 ${t.when}` : ""}
`;
    }
    body += "\n";
  }
  body += `\u2014 Otto

`;
  body += `Open your dashboard to see the full list and take action.`;
  const subject = `Otto daily report \u2014 ${completed.length} done, ${active.length} active`;
  try {
    const result = await extras.selfBrief(subject, body);
    await recordEvent(email, "report_sent", { jobId: job.id, message: "End of day report emailed" });
    return `report sent: ${result}`;
  } catch (e) {
    await recordEvent(email, "report_failed", { jobId: job.id, message: String(e?.message || e).slice(0, 200) });
    throw e;
  }
}
async function processJob(job) {
  switch (job.type) {
    case "sweep":
      return processSweep(job);
    case "execute_task":
      return processExecuteTask(job);
    case "revise":
      return processExecuteTask(job);
    // same processor; input.note carries the revision
    case "execute_step":
      return processExecuteStep(job);
    case "end_of_day_report":
      return processEndOfDayReport(job);
    default:
      return `skipped: unknown type ${job.type}`;
  }
}
async function drain(limit = 3, budgetMs = 24e4) {
  const t0 = Date.now();
  let processed = 0, failed = 0;
  for (let i = 0; i < limit; i++) {
    if (Date.now() - t0 > budgetMs) break;
    const job = await claimJob(workerId);
    if (!job) break;
    try {
      const note = await processJob(job);
      await finishJob(job.id, "succeeded", void 0, { note });
      processed++;
    } catch (e) {
      console.error(`[jobs] ${job.type} failed for ${job.user_email}${job.task_id ? ` task ${job.task_id}` : ""}:`, e?.message || e);
      await finishJob(job.id, "failed", e?.message || String(e));
      if (job.task_id) void recordEvent(job.user_email, "run_failed", { taskId: job.task_id, jobId: job.id, message: String(e?.message || e).slice(0, 200) });
      failed++;
    }
  }
  return { processed, failed };
}
async function enqueueAndDrain(email, type, taskId, input) {
  const job = await enqueueJob(email, type, taskId, input);
  if (job.status === "queued") {
    if (taskId && type !== "sweep") await markTaskStatus(email, taskId, "queued").catch(() => {
    });
    await drain(2);
  }
  return await getJob(job.id, email) || job;
}
async function cronTick() {
  const SWEEP_WINDOW_MS = 45 * 6e4;
  const emails = await listAccountEmails(50);
  let enqueued = 0;
  const now = /* @__PURE__ */ new Date();
  const currentHour = now.getHours();
  for (const email of emails) {
    try {
      const { profile, list } = await loadUser(email);
      if (profile.paused) continue;
      const last = await getLatestJob(email, "sweep");
      const sweepActive = last && (last.status === "queued" || last.status === "running");
      const windowElapsed = Date.now() - (Date.parse(last?.finished_at || last?.created_at || "") || 0) > SWEEP_WINDOW_MS;
      if (!sweepActive && (sweepDueForDay(profile.lastSweepAt, profile, now) || windowElapsed)) {
        await enqueueJob(email, "sweep");
        enqueued++;
      }
      const ready = list.filter((t) => canonStatus(t.status) === "ready" && !t.autoRan).slice(0, 2);
      for (const t of ready) {
        await enqueueJob(email, "execute_task", t.id);
        enqueued++;
      }
      if (profile.workingHours) {
        const [endHour] = profile.workingHours.end.split(":").map(Number);
        const reportWindowEnd = (endHour + 1) % 24;
        const inReportWindow = currentHour === endHour || reportWindowEnd < endHour && (currentHour >= endHour || currentHour < reportWindowEnd);
        if (inReportWindow) {
          const lastReport = await getLatestJob(email, "end_of_day_report");
          const lastReportAt = Date.parse(lastReport?.finished_at || lastReport?.created_at || "") || 0;
          const reportToday = lastReportAt && new Date(lastReportAt).toDateString() === now.toDateString();
          const stillWorking = await countActiveJobs(email);
          if (!reportToday && stillWorking === 0) {
            await enqueueJob(email, "end_of_day_report");
            enqueued++;
          }
        }
      }
    } catch (e) {
      console.warn(`[jobs] cron skip ${email}:`, e?.message || e);
    }
  }
  const { processed, failed } = await drain(10, 27e4);
  return { users: emails.length, enqueued, processed, failed };
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
var mergeTasks = mergeTaskLists;
var mergeProfiles = mergeProfileStates;
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
  const accounts = integrationsReady() ? await getConnectedAccounts(req.session.user, app2, true) : [];
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
    cloud: cloudEnabled(),
    paused: !!req.session.profile?.paused,
    highPriorityPeople: req.session.profile?.highPriorityPeople
  };
  res.json(s);
});
var isPaused = (req) => !!req.session.profile?.paused;
app.post("/api/settings/pause", requireAuth, async (req, res) => {
  const p = req.session.profile ||= emptyProfile();
  p.paused = req.body?.paused === true;
  p.pausedAt = (/* @__PURE__ */ new Date()).toISOString();
  await commit(req);
  res.json(p);
});
app.post("/api/settings/smoke", requireAuth, rateLimit(3, 6e4), async (req, res) => {
  try {
    const results = await runSmokeTest(req.session.user);
    void recordEvent(req.session.user, "smoke_test", { message: `${results.filter((r) => r.ok).length}/${results.length} checks passed` });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e?.message || "integration check failed" });
  }
});
app.get("/api/tasks", requireAuth, async (req, res) => {
  try {
    if (req.session.user && cloudEnabled()) {
      const cloud = await loadState(req.session.user);
      req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      await saveSession(req);
    }
  } catch {
  }
  res.json(req.session.tasks || []);
});
var CONTINUOUS_MONITOR_INTERVAL_MS = 30 * 60 * 1e3;
app.post("/api/tasks/generate", requireAuth, rateLimit(10, 6e4), async (req, res) => {
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to sweep for new tasks." });
    return;
  }
  try {
    const user = req.session.user;
    const force = req.body?.force === true;
    const lastGenTime = Date.parse(req.session.lastGenTime || "") || 0;
    if (!force && Date.now() - lastGenTime < CONTINUOUS_MONITOR_INTERVAL_MS && (req.session.tasks || []).length) {
      res.json({ tasks: req.session.tasks, note: "" });
      return;
    }
    const extras = await toolsFor(req);
    if (!extras?.tools?.length) {
      res.status(400).json({ error: "Connect an app (Gmail, Calendar, Slack, etc.) in Settings so Otto has something to read." });
      return;
    }
    const job = await enqueueAndDrain(user, "sweep");
    if (job.status === "succeeded") req.session.lastGenTime = (/* @__PURE__ */ new Date()).toISOString();
    const cloud = await loadState(user);
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
    await saveSession(req);
    const note = job.status === "succeeded" ? String(job.output?.note || "") : `sweep ${job.status}: ${job.last_error || "still running"}`;
    res.json({ tasks: req.session.tasks, note });
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
  const refined = aiReady() && !isPaused(req) ? await refineManualTask(title, req.session.profile) : null;
  req.session.tasks = addManual(req.session.tasks || [], title, refined);
  const added = req.session.tasks[0];
  if (added && aiReady() && !isPaused(req) && !added.unrefined && canonStatus(added.status) === "ready") {
    added.status = "queued";
    try {
      await enqueueJob(req.session.user, "execute_task", added.id);
    } catch {
    }
  }
  await commit(req);
  res.json(req.session.tasks);
});
app.post("/api/tasks/:id/refine", requireAuth, rateLimit(10, 6e4), async (req, res) => {
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to refine." });
    return;
  }
  if (!aiReady()) {
    res.status(503).json({ error: "AI isn't configured." });
    return;
  }
  const t = (req.session.tasks || []).find((x) => x.id === String(req.params.id));
  if (!t) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const refined = await refineManualTask(t.title, req.session.profile);
  applyRefinement(req.session.tasks || [], t.id, refined);
  await commit(req);
  res.json(req.session.tasks || []);
});
var runViaJob = async (req, res, type, input) => {
  const user = req.session.user;
  const id = String(req.params.id);
  try {
    const job = await enqueueAndDrain(user, type, id, input);
    const cloud = await loadState(user);
    req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
    req.session.profile = mergeProfiles(cloud.profile || emptyProfile(), req.session.profile || emptyProfile());
    await saveSession(req);
    const t = (req.session.tasks || []).find((x) => x.id === id);
    if (!t) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (job.status === "failed_terminal") {
      res.status(500).json({ error: job.last_error || t.lastError || "run failed" });
      return;
    }
    res.json(t);
  } catch (e) {
    console.error(`[tasks] ${type} error for task`, id, ":", e);
    res.status(500).json({ error: e?.message || "run failed" });
  }
};
app.post("/api/tasks/:id/run", requireAuth, rateLimit(40, 6e4), async (req, res) => {
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to run tasks." });
    return;
  }
  await runViaJob(req, res, "execute_task", { manual: true });
});
app.post("/api/tasks/:id/revise", requireAuth, rateLimit(20, 6e4), async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) {
    res.status(400).json({ error: "note required" });
    return;
  }
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to revise tasks." });
    return;
  }
  await runViaJob(req, res, "revise", { note });
});
app.post("/api/tasks/:id/confirm", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "done";
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, true);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user, "confirmed", { taskId: id, message: "You marked it done" });
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/reject", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    reject(req.session.tasks || [], id);
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, false);
    req.session.profile = profile;
    await commit(req);
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/dismiss", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const task = (req.session.tasks || []).find((t) => t.id === id);
  if (task) {
    task.status = "dismissed";
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, task.source, false);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user, "dismissed", { taskId: id, message: "You dismissed it \u2014 similar tasks won't come back" });
  }
  res.json(req.session.tasks || []);
});
app.post("/api/tasks/:id/step/:index/run", requireAuth, rateLimit(40, 6e4), async (req, res) => {
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to run steps." });
    return;
  }
  const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 500) : void 0;
  await runViaJob(req, res, "execute_step", { index: Number(req.params.index), ...answer ? { answer } : {} });
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
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const profile = req.session.profile || emptyProfile();
    updateConfidence(profile, s.app, true);
    req.session.profile = profile;
    await commit(req);
    void recordEvent(req.session.user, "sent", { taskId: t.id, message: `${s.label}${s.to ? ` \u2192 ${s.to}` : ""}` });
  }
  res.json(t);
});
app.get("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await getJob(String(req.params.id), req.session.user);
  if (!job) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ id: job.id, type: job.type, status: job.status, taskId: job.task_id, attempts: job.attempt_count, error: job.last_error, createdAt: job.created_at, finishedAt: job.finished_at });
});
app.get("/api/tasks/:id/events", requireAuth, async (req, res) => {
  res.json(await eventsForTask(req.session.user, String(req.params.id)));
});
app.post("/api/jobs/kick", requireAuth, rateLimit(60, 6e4), async (req, res) => {
  try {
    const out = await drain(1);
    const [active, activeTaskIds] = await Promise.all([countActiveJobs(req.session.user), activeJobTaskIds(req.session.user)]);
    if (out.processed || out.failed) {
      const cloud = await loadState(req.session.user);
      req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      await saveSession(req);
    }
    res.json({ ...out, active, activeTaskIds, tasks: req.session.tasks || [] });
  } catch (e) {
    res.status(500).json({ error: e?.message || "kick failed" });
  }
});
app.get("/api/cron/drain", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || "");
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!secret && PROD) {
    res.status(503).json({ error: "CRON_SECRET not configured" });
    return;
  }
  try {
    const out = await cronTick();
    console.log(`${(/* @__PURE__ */ new Date()).toISOString()} [cron] drain: ${JSON.stringify(out)}`);
    res.json(out);
  } catch (e) {
    console.error("[cron] drain failed:", e);
    res.status(500).json({ error: e?.message || "drain failed" });
  }
});
app.get("/api/cron/status", requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const [state, lastSweepJob, activeJobs] = await Promise.all([
      loadState(user),
      getLatestJob(user, "sweep"),
      countActiveJobs(user)
    ]);
    const profile = state.profile || emptyProfile();
    const tz = profile.workingHours?.timezone;
    res.json({
      lastSweepAt: profile.lastSweepAt || null,
      lastSweepDay: profile.lastSweepAt ? localDay(profile.lastSweepAt, tz) : null,
      today: localDay(/* @__PURE__ */ new Date(), tz),
      sweptToday: !sweepDueForDay(profile.lastSweepAt, profile),
      lastSweepJob: lastSweepJob ? { status: lastSweepJob.status, at: lastSweepJob.finished_at || lastSweepJob.created_at, error: lastSweepJob.last_error || null } : null,
      queued: activeJobs,
      cronConfigured: !!process.env.CRON_SECRET
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "status failed" });
  }
});
app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const state = await loadState(req.session.user);
    const u = state.profile?.usage;
    res.json(u ? { in: u.in, out: u.out, total: u.in + u.out, runs: u.runs, since: u.since } : { in: 0, out: 0, total: 0, runs: 0, since: null });
  } catch (e) {
    res.status(500).json({ error: e?.message || "usage failed" });
  }
});
app.post("/api/chat", requireAuth, rateLimit(20, 6e4), async (req, res) => {
  if (isPaused(req)) {
    res.status(403).json({ error: "AI is paused \u2014 resume it in Settings to chat." });
    return;
  }
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
app.post("/api/profile/preference", requireAuth, async (req, res) => {
  const p = req.session.profile ||= emptyProfile();
  const key2 = String(req.body?.key || "");
  const value = req.body?.value;
  if (key2 === "workingHours" && typeof value === "object") {
    p.workingHours = {
      start: String(value.start || "09:00"),
      end: String(value.end || "18:00"),
      timezone: String(value.timezone || "UTC")
    };
  } else if (key2 === "responseStyle" && ["concise", "detailed", "casual", "formal"].includes(value)) {
    p.responseStyle = value;
  } else if (key2 === "autoApprove" && Array.isArray(value)) {
    p.autoApprove = value.map(String);
  } else if (key2 === "highPriorityPeople" && Array.isArray(value)) {
    p.highPriorityPeople = value.map(String);
  } else if (key2 === "autoArchivePatterns" && Array.isArray(value)) {
    p.autoArchivePatterns = value.map(String);
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
app.use(((err, _req, res, _next) => {
  const status = err?.status || err?.statusCode || (err?.type === "entity.too.large" ? 413 : err?.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[weave-web] request error:", err?.message || err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 413 ? "Request body too large." : status === 400 ? "Malformed request body." : "Internal error." });
}));
process.on("unhandledRejection", (reason) => console.error("[weave-web] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[weave-web] uncaughtException:", err));
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[weave-web] listening on :${PORT} (${PROD ? "production" : "dev"})`));
}
var index_default = app;
export {
  index_default as default
};
