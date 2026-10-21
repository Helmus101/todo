// The app's language: one choice (kept in this browser) that translates the interface and makes the tutor speak and write it.
import { useEffect, useState } from "react";
import { LANGUAGES, isLangCode, type LangCode } from "../shared/languages.ts";

const KEY = "otto-lang";
const CACHE = "otto-i18n:";
const listeners = new Set<() => void>();

export function getLanguage(): LangCode {
  try {
    const v = localStorage.getItem(KEY);
    if (isLangCode(v)) return v;
  } catch { /* storage blocked */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2).toLowerCase();
  return isLangCode(nav) ? nav : "en";
}
export function setLanguage(code: LangCode): void {
  try { localStorage.setItem(KEY, code); } catch { /* storage blocked */ }
  // A clean reload into the new language: the whole app starts over in it (page and tutor), nothing half-translated.
  window.location.reload();
}
export function useLanguage(): [LangCode, (c: LangCode) => void] {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  return [getLanguage(), setLanguage];
}
function applyDocument(code: LangCode) {
  const l = LANGUAGES.find((x) => x.code === code);
  document.documentElement.lang = code;
  document.documentElement.dir = l?.dir || "ltr";
}

// ── Page translator ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixed interface text is translated in place: each text node / placeholder / label is looked up in this browser's
// cache and the missing ones are fetched once from /api/translate (interface strings only). Anything marked
// translate="no" (the board, the chat, what the student wrote) is left exactly as it is.
const originals = new WeakMap<Node, string>();
const attrOriginals = new WeakMap<Element, Record<string, string>>();
const ATTRS = ["placeholder", "aria-label", "title", "alt"];
let table: Record<string, string> = {};
let tableLang: LangCode | null = null;
let pending = new Set<string>();
let timer: number | undefined;
let observer: MutationObserver | null = null;

function loadTable(code: LangCode) {
  if (tableLang === code) return;
  tableLang = code;
  try { table = JSON.parse(localStorage.getItem(CACHE + code) || "{}"); } catch { table = {}; }
}
function saveTable(code: LangCode) { try { localStorage.setItem(CACHE + code, JSON.stringify(table)); } catch { /* full */ } }
const skip = (el: Element | null): boolean => !el || !!el.closest('[translate="no"], .sm-board-body, .live-caption, .tutor-dock-chat, script, style, code, pre, .katex, textarea, [contenteditable="true"], input:not([placeholder])');
const translatable = (t: string) => { const s = t.trim(); return s.length > 1 && s.length <= 240 && /\p{L}{2}/u.test(s) && !/@|https?:\/\//.test(s) && !/^[\d\s.,:;/%€$£+\-–—·•|()]+$/.test(s); };

function visit(code: LangCode, root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const els: Element[] = root.nodeType === 1 ? [root as Element] : [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) { els.push(n as Element); continue; }
    const el = n.parentElement;
    if (skip(el)) continue;
    const cur = n.nodeValue || "";
    let src = originals.get(n);
    // React wrote new English text over a translated node: that is the new source.
    if (src === undefined || (cur !== src && cur !== table[src.trim()] && !Object.values(table).includes(cur.trim()))) { src = cur; originals.set(n, src); }
    const key = src.trim();
    if (!translatable(key)) continue;
    if (code === "en") { if (n.nodeValue !== src) n.nodeValue = src; continue; }
    const tr = table[key];
    if (tr) { const out = src.replace(key, tr); if (n.nodeValue !== out) n.nodeValue = out; } else pending.add(key);
  }
  for (const el of els) {
    if (skip(el)) continue;
    for (const a of ATTRS) {
      const cur = el.getAttribute(a);
      if (!cur) continue;
      const saved = attrOriginals.get(el) || {};
      let src = saved[a];
      if (src === undefined || (cur !== src && cur !== table[src])) { src = cur; saved[a] = src; attrOriginals.set(el, saved); }
      if (!translatable(src)) continue;
      if (code === "en") { if (cur !== src) el.setAttribute(a, src); continue; }
      const tr = table[src.trim()];
      if (tr) { if (cur !== tr) el.setAttribute(a, tr); } else pending.add(src.trim());
    }
  }
}

async function flush(code: LangCode) {
  const batch = [...pending].slice(0, 80);
  if (!batch.length) return;
  batch.forEach((b) => pending.delete(b));
  try {
    const r = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: code, strings: batch }) });
    if (!r.ok) return;
    const j = await r.json();
    if (getLanguage() !== code) return;
    Object.assign(table, j.translations || {});
    saveTable(code);
    visit(code, document.body);
  } catch { /* stays English */ }
  if (pending.size) void flush(code); else settleSoon();
}

export function translatePage(): Promise<void> {
  const code = getLanguage();
  loadTable(code);
  pending = new Set();
  visit(code, document.body);
  if (code !== "en") window.setTimeout(() => void flush(code), 0);
  return Promise.resolve();
}

// Until the first translation has landed the page is held back (never longer than 2.5 s), so a reload into another language
// doesn't flash English.
function hold(on: boolean) { if (on) document.documentElement.setAttribute("data-i18n", "loading"); else document.documentElement.removeAttribute("data-i18n"); }
function settleSoon() {
  window.setTimeout(() => {
    const root = document.getElementById("root");
    if (!pending.size && root && root.textContent && root.textContent.trim().length > 20) hold(false);
  }, 60);
}

export function startTranslator(): void {
  applyDocument(getLanguage());
  if (getLanguage() !== "en") { hold(true); window.setTimeout(() => hold(false), 2500); }
  void translatePage();
  if (observer) return;
  observer = new MutationObserver((muts) => {
    const code = getLanguage();
    if (code === "en" && !tableLang) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      observer?.disconnect();
      loadTable(code);
      for (const m of muts) { if (m.type === "characterData") { if (m.target.parentElement) visit(code, m.target.parentElement); } else m.addedNodes.forEach((nd) => visit(code, nd)); }
      observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
      if (code !== "en" && pending.size) void flush(code); else settleSoon();
    }, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
