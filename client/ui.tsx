/**
 * Shared presentation primitives — formatting helpers, the language context, the in-app artifact viewers
 * (FlashcardDeck / QuizPlayer) and TaskModal.
 *
 * Extracted from App.tsx so App.tsx and TaskCard.tsx can BOTH import them without an import cycle
 * (App.tsx imports TaskCard.tsx, so anything TaskCard needs from App has to live in a third module).
 * Everything here is moved verbatim — no behaviour changes belong in this file's history.
 */
import { useEffect, useState, useCallback, useRef, useContext, createContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WebTask, TaskFlashcards, TaskQuiz } from "../shared/types.ts";
import { canonStatus } from "../shared/types.ts";
import { api } from "./api.ts";

// App-wide UI language (default French; toggled in Settings, sourced from the account's ConnectionStatus/
// Profile). `L(fr, en)` picks the right string for whichever language is active — used everywhere instead of
// hardcoding French so switching the toggle changes the WHOLE interface, not just AI-generated content.
export const LangContext = createContext<"fr" | "en">("fr");
export function useLang(): (fr: string, en: string) => string {
  const lang = useContext(LangContext);
  return (fr: string, en: string) => (lang === "en" ? en : fr);
}

// App-wide error/info toast. Was previously threaded as an `onNotify` prop through ~6 components on the
// dashboard path only — Settings and its children had NO way to reach it at all, so a failed save there
// (language toggle, grade edit, profile edit, pause switch, disconnect...) failed with zero visible feedback.
// One context reachable from anywhere beats prop-drilling through ~15 components across three unrelated
// subtrees. Default is a no-op so anything rendered OUTSIDE the provider (the pre-login Landing/LoginPage,
// UnlimitedPage which early-returns above it) still works without throwing.
export type Notify = (msg: string, kind?: "info" | "error") => void;
export const NotifyContext = createContext<Notify>(() => {});
export function useNotify(): Notify { return useContext(NotifyContext); }

/** Today as a bare "YYYY-MM-DD" — for comparing against a milestone's targetDate (same bare-string
 *  convention as server/workload.ts's BARE_DATE check, so this never drifts across a timezone). */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** "Sep 12" — a milestone target date (YYYY-MM-DD), formatted for display. */
export const fmtDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** "just now" / "2h ago" / "Jul 3" — compact, human moment for when a step was completed. */
export const relTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// Explicit card status: what state is this task ACTUALLY in, in user terms. Derived from the canonical
// lifecycle + the task's contents (a sendable → "Draft ready"; an open question → "Needs your answer").
export function statusChip(t: WebTask, retrying?: boolean, en?: boolean): { label: string; tone: "muted" | "busy" | "attention" | "bad" | "good" } | null {
  const c = canonStatus(t.status);
  if (c === "queued") return { label: en ? "Queued" : "En attente", tone: "muted" };
  if (c === "executing") return { label: en ? "Working" : "En cours", tone: "busy" };
  // "Retrying" is only claimed when a REAL queued/running job exists for this task (activeTaskIds from
  // the kick response) — otherwise the honest state is "Failed" with a Retry button.
  if (c === "failed_retryable") return retrying ? { label: en ? "Failed — retrying…" : "Échec — nouvel essai…", tone: "busy" } : { label: en ? "Failed" : "Échec", tone: "bad" };
  if (c === "failed_terminal") return { label: en ? "Failed" : "Échec", tone: "bad" };
  if (c === "needs_review") {
    if (t.steps?.some((s) => !s.done && s.question)) return { label: en ? "Needs your answer" : "Réponse nécessaire", tone: "attention" };
    if (t.steps?.some((s) => !s.done && s.needsPermission)) return { label: en ? "Needs approval" : "Approbation nécessaire", tone: "attention" };
    if (t.sendables?.some((s) => !s.sent)) return { label: en ? "Draft ready" : "Brouillon prêt", tone: "attention" };
    const n = (t.steps || []).filter((s) => !s.done && !s.automatable).length;
    return n
      ? { label: en ? `${n} need${n > 1 ? "" : "s"} you` : `${n} étape${n > 1 ? "s" : ""} restante${n > 1 ? "s" : ""}`, tone: "attention" }
      : { label: en ? "Done for you" : "Préparé pour toi", tone: "good" };
  }
  return null;
}

// Short source label for the collapsed card's source badge — same apps as linkKind, just for task.source.
const SOURCE_BADGE: Record<string, string> = {
  gmail: "Gmail", calendar: "Calendar", googlecalendar: "Calendar", manual: "You",
  notion: "Notion", googledrive: "Drive", pronote: "Pronote",
};
const SOURCE_BADGE_EN: Record<string, string> = { ...SOURCE_BADGE, manual: "You" };
const SOURCE_BADGE_FR: Record<string, string> = { ...SOURCE_BADGE, manual: "Toi" };
export function sourceBadge(s: string, en?: boolean): string {
  const map = en ? SOURCE_BADGE_EN : SOURCE_BADGE_FR;
  return map[s] || (s ? s[0].toUpperCase() + s.slice(1) : (en ? "Task" : "Tâche"));
}
// Quadrant already encodes urgency+importance (see eisenhower()) — reuse it as a plain-English priority
// badge instead of asking the user to parse "do/schedule/delegate/later".
export function priorityBadge(q?: string, en?: boolean): string {
  return q === "do" ? (en ? "Urgent" : "Urgent") : q === "schedule" ? (en ? "Medium" : "Moyen") : (en ? "Low" : "Faible");
}

// One short context line under the title. The STATUS is carried by the chip on the right — the subtitle
// never repeats it. So: the "why" for a fresh task, the error for a failed one, nothing when the chip says it.
export function subtitle(t: WebTask): string {
  const c = canonStatus(t.status);
  if (c === "failed_retryable" || c === "failed_terminal") return t.lastError || "";
  if (c === "ready") return t.why;
  return "";
}

// Format a task's deadline: a raw ISO date/datetime → "Jul 27"; already-human text ("late July", "today") as-is.
export function fmtWhen(when: string): string {
  const s = String(when || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); if (!isNaN(d.getTime())) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  return s;
}

// Open a URL in a new tab. Prefers the Otto Chrome extension (web/extension/) — it sets a DOM flag and
// relays postMessage to chrome.tabs.create, so tabs can open UNATTENDED during auto-do. Without it, falls
// back to window.open (works on a user click).
export const TAB_GROUP = "Otto"; // all tabs Otto opens go into this one named group
const extPresent = () => document.documentElement.getAttribute("data-weave-ext") === "1";
// Open one or many tabs. With the extension, they go into a NAMED tab group (per task); without it,
// window.open (no grouping possible from a plain page).
export function openTab(url: string, group?: string) {
  if (extPresent()) window.postMessage({ type: "weave-open-tab", url, group }, window.location.origin);
  else window.open(url, "_blank", "noopener");
}
export function openTabs(urls: string[], group?: string) {
  if (!urls.length) return;
  if (extPresent()) window.postMessage({ type: "weave-open-tabs", urls, group }, window.location.origin);
  else urls.forEach((u) => window.open(u, "_blank", "noopener"));
}

// Auto-open created documents (Doc/Sheet/Slides) when a task finishes — handy, but capped so you're never
// flooded with tabs, only via the extension (a plain window.open would be popup-blocked without a click),
// and EACH doc opens at most ONCE EVER. The opened-URL set is PERSISTED (localStorage) so reopening the app
// never re-opens the same tabs again. Toggle in Settings (default ON).
const DOC_RE = /docs\.google\.com\/(document|spreadsheets|presentation)/i;
const OPENED_KEY = "otto-opened-docs";
const openedDocs: Set<string> = (() => { try { return new Set<string>(JSON.parse(localStorage.getItem(OPENED_KEY) || "[]")); } catch { return new Set(); } })();
const markDocsOpened = (urls: string[]) => {
  urls.forEach((u) => openedDocs.add(u));
  try { localStorage.setItem(OPENED_KEY, JSON.stringify([...openedDocs].slice(-300))); } catch { /* ignore */ }
};
let sessionDocsOpened = 0;               // burst control: cap how many open within one session load
const SESSION_DOC_CAP = 4;               // ceiling on auto-opened docs per session load
const PER_TASK_DOC_CAP = 2;              // and per task
// Auto-opening created docs is OFF by default — it needs the Tabs extension, so it's opt-in ("1" = on).
const autoOpenDocsOn = () => { try { return localStorage.getItem("otto-autoopen-docs") === "1"; } catch { return false; } };

/** Auto-open the docs a finished task created, respecting every cap. Encapsulated here (rather than inlined
 *  in the card, where it used to live) because `sessionDocsOpened` is module-level mutable state and an
 *  imported binding is read-only — the counter has to be owned by the same module that increments it. */
export function autoOpenTaskDocs(links?: { url: string }[]): void {
  if (!autoOpenDocsOn()) return;
  const room = SESSION_DOC_CAP - sessionDocsOpened;
  if (room <= 0) return;
  // Only docs we've NEVER auto-opened (persisted across reloads) — so the same tabs never reopen.
  const docs = (links || []).map((l) => l.url).filter((u) => DOC_RE.test(u) && !openedDocs.has(u));
  const toOpen = docs.slice(0, Math.min(room, PER_TASK_DOC_CAP));
  if (!toOpen.length) return;
  markDocsOpened(toOpen);
  sessionDocsOpened += toOpen.length;
  openTabs(toOpen, TAB_GROUP);
}

// Otto is instructed to write inline markdown links ([label](url)) into "did"/"steps" text when it names a
// specific resource — render those as real clickable buttons instead of leaving the raw "[text](url)" syntax
// visible. Anything not matching the pattern passes through as plain text.
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
export function withInlineLinks(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null;
  MD_LINK.lastIndex = 0;
  while ((m = MD_LINK.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<a key={m.index} href={m[2]} target="_blank" rel="noreferrer" className="inline-link">{m[1]} ↗</a>);
    last = m.index + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// DeepSeek regularly answers math questions in raw LaTeX (`\(a^2+b^2\)`, `\frac{1}{2}`) even though nothing
// asks it to — reported live: a chat reply showing literal backslashes/braces instead of real math. Pulling
// in a LaTeX renderer (KaTeX etc.) for what's still plain chat prose is more machinery than this needs;
// instead rewrite the common subset to plain Unicode math so it just reads correctly, no library, no
// clickable/interactive output — this is a pure text→text pass, same string type in and out.
const SUPERSCRIPT: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUBSCRIPT: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
// A char with no Unicode counterpart (most letters) falls back to `^x`/`_x` rather than silently dropping
// it — losing the exponent entirely would be worse than an unconverted caret.
const scriptify = (s: string, map: Record<string, string>, marker: string): string =>
  [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${marker}${s.length > 1 ? `(${s})` : s}`;
const LATEX_SYMBOLS: [RegExp, string][] = [
  [/\\times/g, "×"], [/\\cdot/g, "·"], [/\\div/g, "÷"], [/\\pm/g, "±"], [/\\mp/g, "∓"],
  [/\\leq?/g, "≤"], [/\\geq?/g, "≥"], [/\\neq/g, "≠"], [/\\approx/g, "≈"], [/\\equiv/g, "≡"],
  [/\\(right|left)?arrow/g, "→"], [/\\Rightarrow/g, "⇒"], [/\\infty/g, "∞"],
  [/\\pi/g, "π"], [/\\theta/g, "θ"], [/\\alpha/g, "α"], [/\\beta/g, "β"], [/\\gamma/g, "γ"], [/\\Gamma/g, "Γ"],
  [/\\[Dd]elta/g, "Δ"], [/\\lambda/g, "λ"], [/\\mu/g, "μ"], [/\\sigma/g, "σ"], [/\\phi/g, "φ"], [/\\omega/g, "ω"],
  [/\\sum/g, "Σ"], [/\\prod/g, "Π"], [/\\int/g, "∫"], [/\\forall/g, "∀"], [/\\exists/g, "∃"],
  [/\\in/g, "∈"], [/\\notin/g, "∉"], [/\\subset/g, "⊂"], [/\\cup/g, "∪"], [/\\cap/g, "∩"], [/\\emptyset/g, "∅"],
  // Geometry — perpendicular/parallel/angle marks are exactly the notation a "is my method right?" hint
  // reply needs (congruent triangles, parallel lines, right angles) and had no coverage at all before.
  [/\\nparallel/g, "∦"], [/\\parallel/g, "∥"], [/\\perp/g, "⊥"], [/\\angle/g, "∠"], [/\\measuredangle/g, "∡"],
  [/\\cong/g, "≅"], [/\\sim(?!eq)/g, "∼"], [/\\simeq/g, "≃"], [/\\triangle/g, "△"], [/\\degree/g, "°"],
  [/\\(left|right|,|!|;|:|quad|qquad)/g, ""],
];
function formatMath(text: string): string {
  if (!text.includes("\\") && !text.includes("$")) return text; // fast path — the overwhelming majority of turns have no math at all
  let s = text
    // Strip the delimiter wrappers — \( \) \[ \] $ $ $$ $$ — the content inside is what actually gets
    // converted; the delimiters themselves are LaTeX plumbing a reader has no use for.
    .replace(/\\\[|\\\]|\\\(|\\\)/g, "")
    .replace(/\$\$?/g, "")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, "C($1,$2)")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    // \overline{AB} — segment notation (e.g. "prove AB ≅ CD"). No LaTeX renderer, so approximate the bar
    // with a combining overline (U+0305) on each character rather than dropping the segment marker entirely.
    .replace(/\\overline\{([^{}]*)\}/g, (_, g) => [...g].map((c: string) => `${c}̅`).join(""));
  for (const [re, rep] of LATEX_SYMBOLS) s = s.replace(re, rep);
  // ^{...}/_{...} (braced, so multi-char) then ^x/_x (single char) — braced form must run first or the
  // single-char pattern would fire on just the `{`.
  s = s.replace(/\^\{([^{}]*)\}/g, (_, g) => scriptify(g, SUPERSCRIPT, "^"));
  s = s.replace(/_\{([^{}]*)\}/g, (_, g) => scriptify(g, SUBSCRIPT, "_"));
  s = s.replace(/\^(\S)/g, (_, g) => scriptify(g, SUPERSCRIPT, "^"));
  s = s.replace(/_(\S)/g, (_, g) => scriptify(g, SUBSCRIPT, "_"));
  return s.replace(/[{}]/g, "").replace(/ {2,}/g, " ").trim();
}

/** Light markdown → JSX for an in-app note (CREATE_NOTE's body): headings, **bold**, and bullet/numbered
 *  lists. Never sent anywhere — this only ever renders inside the popup, so a small hand-rolled pass is
 *  enough (no need for a full markdown library just for this). */
/** `**bold**` → <b>. Module-scope (not a closure inside renderNoteBody) so renderChatText can reuse it. */
function boldify(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p));
}

// A GFM-style pipe row: "| a | b | c |" (leading/trailing pipes optional). Splits on unescaped `|`.
const splitRow = (line: string): string[] =>
  line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
// The separator row under a table header: "|---|:---:|---|" — dashes (+ optional colons), nothing else.
const isTableSep = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line);

export function renderNoteBody(md: string): ReactNode {
  const lines = formatMath(md).replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  const flushList = () => {
    if (list) { blocks.push(<ul key={blocks.length} className="note-list">{list.map((t, i) => <li key={i}>{boldify(t)}</li>)}</ul>); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushList(); continue; }
    // A table: this line and the next both look like pipe rows, and the next is specifically the
    // dashes separator. Otto's own note-writing tool has no table syntax granted (fiches are meant to be
    // scannable prose/lists), but a student can still paste one in, or the model can slip into GFM habits
    // it picked up elsewhere — render it properly instead of dumping raw "| a | b |" text.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      flushList();
      const header = splitRow(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j].trim().includes("|") && !isTableSep(lines[j].trim())) {
        rows.push(splitRow(lines[j].trim()));
        j++;
      }
      blocks.push(
        <div key={i} className="note-table-wrap">
          <table className="note-table">
            <thead><tr>{header.map((c, ci) => <th key={ci}>{boldify(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{boldify(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      i = j - 1;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) { flushList(); const Tag = h[1].length === 1 ? "h3" : h[1].length === 2 ? "h4" : "h5"; blocks.push(<Tag key={i}>{boldify(h[2])}</Tag>); continue; }
    const li = /^[-*]\s+(.*)|^\d+[.)]\s+(.*)/.exec(line);
    if (li) { (list ||= []).push(li[1] ?? li[2]); continue; }
    flushList();
    blocks.push(<p key={i}>{boldify(line)}</p>);
  }
  flushList();
  return blocks;
}

/** `*italic*` → <i>, single-asterisk only (run AFTER boldify has already consumed every `**...**` pair, so
 *  a leftover lone `*` can only ever be genuine emphasis, never half of a bold marker). Observed live: the
 *  tutor uses *word* for emphasis on its own even though the prompt only grants **bold** — better to
 *  render it than show a student raw asterisks. */
function italicize(s: string): ReactNode {
  const parts = s.split(/(\*[^*]+\*)/g);
  return parts.map((p, i) => (p.length > 2 && p.startsWith("*") && p.endsWith("*") ? <i key={i}>{p.slice(1, -1)}</i> : p));
}

/** [text](url) + **bold** + *italic*, composed — links first (so a bolded/italicized link isn't mangled),
 *  then bold, then italic on what's left. Shared by renderChatText below; withInlineLinks alone only
 *  handles links, and renderNoteBody's boldify alone doesn't grant italic (deliberately — a fiche's body
 *  is written by a tool call with its own schema, not free-form chat prose). */
function withInlineLinksAndBold(text: string): ReactNode {
  const linked = withInlineLinks(text);
  const parts = Array.isArray(linked) ? linked : [linked];
  return parts.map((p, i) => {
    if (typeof p !== "string") return p; // already a rendered <a> from withInlineLinks
    const bolded = boldify(p) as ReactNode[]; // boldify always returns an array (parts.map)
    return <span key={i}>{bolded.map((seg, j) => (typeof seg === "string" ? <span key={j}>{italicize(seg)}</span> : seg))}</span>;
  });
}

/** Light markdown for an ASSISTANT chat reply: **bold**, [links](url), and a short dash list — deliberately
 *  NOT the full renderNoteBody treatment (no headings; the tutor prompt explicitly bans them, chat is a
 *  conversation, not a document). User messages are never run through this — a student pasting `**` from
 *  their own notes shouldn't get it silently eaten. */
export function renderChatText(text: string): ReactNode {
  const lines = formatMath(text).replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  const flushList = () => {
    if (list) { blocks.push(<ul key={blocks.length} className="note-list">{list.map((t, i) => <li key={i}>{withInlineLinksAndBold(t)}</li>)}</ul>); list = null; }
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flushList(); return; }
    // A stray "#" heading is rendered as a plain bold line, not promoted to an <h3> — chat stays flat.
    const h = /^#{1,3}\s+(.*)/.exec(line);
    if (h) { flushList(); blocks.push(<p key={i}><b>{withInlineLinksAndBold(h[1])}</b></p>); return; }
    const li = /^[-*]\s+(.*)/.exec(line);
    if (li) { (list ||= []).push(li[1]); return; }
    flushList();
    blocks.push(<p key={i}>{withInlineLinksAndBold(line)}</p>);
  });
  flushList();
  return blocks;
}

type StudyHelpCard =
  | { kind: "flashcard"; front: string; back: string }
  | { kind: "quiz"; question: string; options: string[]; correct: number };

/** "Need a hint?" sidebar shown next to the flashcard/quiz currently on screen — a short, scoped chat with
 *  Otto that guides toward the answer without ever stating it (see studyHelp on the server, which enforces
 *  that rule). Deliberately per-card, stateless, and local-only: the thread resets the moment the card
 *  underneath changes, so a hint about card 3 can never leak into card 4. `taskId` is optional only
 *  because TypeScript can't see that every real caller always has one; renders nothing without it. */
function StudyHelpPanel({ taskId, card }: { taskId?: string; card: StudyHelpCard }) {
  const L = useLang();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const cardKey = card.kind === "flashcard" ? card.front : card.question;
  useEffect(() => { setHistory([]); setInput(""); setOpen(false); }, [cardKey]);
  const send = () => {
    const message = input.trim();
    if (!message || busy || !taskId) return;
    setInput("");
    setBusy(true);
    const prior = history;
    setHistory((h) => [...h, { role: "user", text: message }]);
    api.studyHelp(taskId, card, prior, message)
      .then((r) => setHistory((h) => [...h, { role: "assistant", text: r.reply }]))
      .catch((e: any) => setHistory((h) => [...h, { role: "assistant", text: e?.message || L("Erreur — réessaie.", "Error — try again.") }]))
      .finally(() => setBusy(false));
  };
  if (!taskId) return null;
  return (
    <div className="study-help">
      <button type="button" className="btn xs ghost study-help-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? L("Fermer l'aide", "Close hint") : L("💡 Un indice ?", "💡 Need a hint?")}
      </button>
      {open && (
        <div className="study-help-panel">
          <div className="study-help-log">
            {history.length === 0 && (
              <p className="study-help-empty">
                {L("Otto peut t'aider à réfléchir — il ne te donnera jamais la réponse.", "Otto can help you think it through — he'll never just give you the answer.")}
              </p>
            )}
            {history.map((h, i) => <p key={i} className={`study-help-msg ${h.role}`}>{h.text}</p>)}
            {busy && <p className="study-help-msg assistant study-help-thinking">…</p>}
          </div>
          <div className="study-help-input">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder={L("Demande un indice…", "Ask for a hint…")}
              disabled={busy}
            />
            <button type="button" className="btn xs primary" onClick={send} disabled={busy || !input.trim()}>{L("Envoyer", "Send")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Drillable flashcard viewer (CREATE_FLASHCARDS): space/click flips the card, → marks it right and
 *  advances, ← marks it wrong and advances. Ends on a score summary with a restart. Keyboard-first so a
 *  student can drill an entire deck without touching the mouse. */
export function FlashcardDeck({ deck, onReview, taskId }: { deck: TaskFlashcards; onReview?: (cardIndex: number, correct: boolean) => void; taskId?: string }) {
  const L = useLang();
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [right, setRight] = useState<number[]>([]);
  const [wrong, setWrong] = useState<number[]>([]);
  const done = i >= deck.cards.length;
  const card = !done ? deck.cards[i] : null;
  const mark = (ok: boolean) => {
    if (!card) return;
    // Dedupe by index, not just append: going back to a card (see `back` below) and re-marking it must
    // REPLACE its earlier verdict, never leave both a stale "wrong" and a fresh "right" counted for the
    // same card at once — that would silently inflate the final score screen.
    (ok ? setRight : setWrong)((prev) => [...prev.filter((x) => x !== i), i]);
    (ok ? setWrong : setRight)((prev) => prev.filter((x) => x !== i));
    // Fire-and-forget — the deck's own local right/wrong state (for the score screen) doesn't wait on the
    // network either, so this shouldn't make marking a card feel any less instant.
    onReview?.(i, ok);
    setFlipped(false);
    setI((v) => v + 1);
  };
  // Revisit a card marked in error, or just double-check it — matches the score screen's own "you can
  // always restart" spirit, but for one card instead of the whole deck. Never removes its recorded
  // verdict on its own; re-marking it (see `mark` above) is what actually changes the score.
  const back = () => { if (i === 0) return; setFlipped(false); setI((v) => v - 1); };
  const restart = () => { setI(0); setFlipped(false); setRight([]); setWrong([]); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); setFlipped((v) => !v); }
      else if (e.key === "ArrowRight") { e.preventDefault(); mark(true); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); mark(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, i, flipped]);
  if (done) {
    const pct = deck.cards.length ? Math.round((right.length / deck.cards.length) * 100) : 0;
    return (
      <div className="deck-popup deck-done">
        <h3 className="note-popup-title">{deck.title}</h3>
        <div className={`deck-score-ring ${pct >= 70 ? "good" : ""}`}>
          <span className="deck-score-pct">{pct}%</span>
        </div>
        <p className="deck-score">{L(`${right.length} / ${deck.cards.length} correctes`, `${right.length} / ${deck.cards.length} correct`)}</p>
        <div className="deck-acts">
          <button className="btn primary" onClick={restart}>{L("Recommencer", "Restart")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="deck-popup">
      <h3 className="note-popup-title">{deck.title}</h3>
      <div className="deck-progress-bar"><div className="deck-progress-fill" style={{ width: `${(i / deck.cards.length) * 100}%` }} /></div>
      <div className="deck-progress">{i + 1} / {deck.cards.length}</div>
      <div className={`deck-card-3d ${flipped ? "flipped" : ""}`} onClick={() => setFlipped((v) => !v)}>
        <div className="deck-card-inner">
          <div className="deck-card-face deck-card-front">
            <span className="deck-face-label">{L("Question", "Front")}</span>
            <div className="deck-face-text">{formatMath(card!.front)}</div>
          </div>
          <div className="deck-card-face deck-card-back">
            <span className="deck-face-label">{L("Réponse", "Back")}</span>
            <div className="deck-face-text">{formatMath(card!.back)}</div>
          </div>
        </div>
      </div>
      <p className="deck-hint">{L("Pense à ta réponse, puis retourne · ← faux · → correct", "Think of your answer, then flip · ← wrong · → correct")}</p>
      <div className="deck-acts">
        <button className="btn ghost deck-btn-wrong" onClick={() => mark(false)}>← {L("Faux", "Wrong")}</button>
        <button className="btn ghost" onClick={() => setFlipped((v) => !v)}>{L("Retourner", "Flip")}</button>
        <button className="btn primary deck-btn-right" onClick={() => mark(true)}>{L("Correct", "Correct")} →</button>
      </div>
      {i > 0 ? (
        <button type="button" className="btn xs ghost deck-btn-back" onClick={back}>{L("‹ Carte précédente", "‹ Previous card")}</button>
      ) : null}
      <StudyHelpPanel taskId={taskId} card={{ kind: "flashcard", front: card!.front, back: card!.back }} />
    </div>
  );
}

/** An MCQ quiz player — answer, get immediate right/wrong + a one-line explanation, then advance; a score
 *  screen at the end reuses FlashcardDeck's exact done-state markup (.deck-done/.deck-score-ring) so scoring
 *  reads identically across artifact types. Deliberately its own component (not a FlashcardDeck variant):
 *  the interaction — lock on pick, reveal the right answer, explain why — has nothing in common with a flip. */
export function QuizPlayer({ quiz, taskId }: { quiz: TaskQuiz; taskId?: string }) {
  const L = useLang();
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [right, setRight] = useState<number[]>([]);
  // Indices the student got wrong, in order — drives "review my mistakes" without re-deriving anything.
  const [wrongIdx, setWrongIdx] = useState<number[]>([]);
  const [order, setOrder] = useState<number[] | null>(null); // null = full quiz, in original order
  const seq = order ?? quiz.questions.map((_, idx) => idx);
  const done = i >= seq.length;
  const qIdx = seq[i];
  const q = !done ? quiz.questions[qIdx] : null;
  const pick = (optIdx: number) => {
    if (picked !== null || !q) return;
    setPicked(optIdx);
    // Dedupe by question index, same reasoning as FlashcardDeck's `mark`: going back to a question (see
    // `back` below) and re-answering it must REPLACE its earlier verdict, never leave a stale AND a fresh
    // one both counted for the same question at once.
    (optIdx === q.correct ? setRight : setWrongIdx)((prev) => [...prev.filter((x) => x !== qIdx), qIdx]);
    (optIdx === q.correct ? setWrongIdx : setRight)((prev) => prev.filter((x) => x !== qIdx));
  };
  const next = () => { setPicked(null); setI((v) => v + 1); };
  // Revisit an earlier question — to double-check the explanation or retry one gotten wrong. Always lands
  // unanswered (never replays the old picked-state) so re-picking through `pick` above works cleanly.
  const back = () => { if (i === 0) return; setPicked(null); setI((v) => v - 1); };
  const restart = (reviewOnly?: boolean) => {
    setOrder(reviewOnly && wrongIdx.length ? [...wrongIdx] : null);
    setI(0); setPicked(null); setRight([]); setWrongIdx([]);
  };
  // Picking an answer saves it and moves on by itself — no extra click needed. Still pauses long enough to
  // actually see the right/wrong highlight and read the one-line "why" before advancing; the "Next" button
  // and 1-4/Enter shortcuts stay as a manual override for anyone who wants to move faster or slower.
  useEffect(() => {
    if (picked === null) return;
    const id = setTimeout(next, 1600);
    return () => clearTimeout(id);
  }, [picked]);
  // Persist the score the moment the pass finishes — best-effort (a failed write just means this one
  // attempt isn't referenceable later, not a broken quiz) and fires again on every restart-then-finish,
  // same as flashcards' onReview firing on every card.
  useEffect(() => {
    if (!done || !taskId) return;
    void api.recordQuizAttempt(taskId, quiz.id, right.length, seq.length, wrongIdx).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  // Only the "advance past a picked answer" shortcut remains — no number-key shortcut to PICK an answer:
  // that let a student cycle 1/2/3/4 blind without reading the options, defeating the point of a
  // discrimination check (see the tool's own doc comment above CREATE_QUIZ_TOOL).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done || !q) return;
      if (picked !== null && (e.key === "Enter" || e.key === "ArrowRight")) { e.preventDefault(); next(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, q, picked]);
  if (done) {
    const total = seq.length;
    const pct = total ? Math.round((right.length / total) * 100) : 0;
    return (
      <div className="deck-popup deck-done">
        <h3 className="note-popup-title">{quiz.title}</h3>
        <div className={`deck-score-ring ${pct >= 70 ? "good" : ""}`}>
          <span className="deck-score-pct">{pct}%</span>
        </div>
        <p className="deck-score">{L(`${right.length} / ${total} correctes`, `${right.length} / ${total} correct`)}</p>
        <div className="deck-acts">
          {wrongIdx.length > 0 && <button className="btn ghost" onClick={() => restart(true)}>{L(`Revoir mes ${wrongIdx.length} erreurs`, `Review my ${wrongIdx.length} mistake${wrongIdx.length > 1 ? "s" : ""}`)}</button>}
          <button className="btn primary" onClick={() => restart(false)}>{L("Recommencer", "Restart")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="deck-popup quiz-popup">
      <h3 className="note-popup-title">{quiz.title}</h3>
      <div className="deck-progress-bar"><div className="deck-progress-fill" style={{ width: `${(i / seq.length) * 100}%` }} /></div>
      <div className="deck-progress">{i + 1} / {seq.length}</div>
      <div className="quiz-q">{formatMath(q!.q)}</div>
      <div className="quiz-opts">
        {q!.options.map((opt, oi) => {
          const state = picked === null ? "" : oi === q!.correct ? "correct" : oi === picked ? "wrong" : "";
          return (
            <button key={oi} type="button" className={`quiz-opt ${state}`} disabled={picked !== null} onClick={() => pick(oi)}>
              <span className="quiz-opt-text">{formatMath(opt)}</span>
              {/* Was border/background-only (deliberately not red/green — see the one-accent rule) but with
                  no text/icon and no aria-live announcement, a screen-reader student got zero signal about
                  which answer was right after picking. */}
              {state === "correct" && <span className="quiz-opt-mark" aria-hidden="true">✓ {L("Correct", "Correct")}</span>}
              {state === "wrong" && <span className="quiz-opt-mark" aria-hidden="true">✗ {L("Incorrect", "Incorrect")}</span>}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <>
          <p className="sr-only" role="status" aria-live="polite">
            {picked === q!.correct ? L("Correct.", "Correct.") : L(`Incorrect. La bonne réponse était : ${q!.options[q!.correct]}.`, `Incorrect. The correct answer was: ${q!.options[q!.correct]}.`)}
          </p>
          {q!.why && <p className="quiz-why">{formatMath(q!.why)}</p>}
          <div className="deck-acts">
            <button className="btn primary" onClick={next}>{L("Suivant", "Next")} →</button>
          </div>
        </>
      )}
      {picked === null && <p className="deck-hint">{L("Clique sur une réponse", "Click an answer")}</p>}
      {i > 0 ? (
        <button type="button" className="btn xs ghost deck-btn-back" onClick={back}>{L("‹ Question précédente", "‹ Previous question")}</button>
      ) : null}
      <StudyHelpPanel taskId={taskId} card={{ kind: "quiz", question: q!.q, options: q!.options, correct: q!.correct }} />
    </div>
  );
}

// A stack of every currently-open TaskModal's close function, most-recent last. Each instance used to
// attach its OWN document-level Escape listener with no coordination, so a nested modal (an artifact popup
// opened from inside the task view) and its parent both fired on the same keypress — one Escape closed
// both at once. Only the TOP of the stack responds; closing it pops back to whichever modal was underneath.
const modalStack: (() => void)[] = [];

export function TaskModal({ onClose, children, nested, title }: { onClose: () => void; children: ReactNode; nested?: boolean; title?: string }) {
  // Closing used to unmount instantly (a hard cut, no exit motion) while opening got a full pop-in —
  // asymmetric and the one modal-close moment in the app that read as unpolished. Mirror the entrance:
  // play a quick close animation, THEN unmount (matches the CSS durations below exactly).
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const doClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setTimeout(onClose, 160);
  }, [onClose]);

  const panelRef = useRef<HTMLDivElement>(null);

  // `doClose` depends on `onClose`, which callers overwhelmingly pass as an inline arrow
  // (`onClose={() => navigate("")}`) — a fresh function identity on EVERY parent re-render (any poll tick,
  // any setTasks). That used to sit directly in this effect's dependency array, so the entire mount-time
  // setup below (focus trap, initial focus, body scroll lock) re-ran on every single parent re-render
  // while the modal was open — including the `(first || panelRef.current)?.focus()` call, which yanked
  // focus away from wherever the user actually was (mid-keystroke in the chat input) back to the modal's
  // first focusable element. Observed live as "I type and it jumps out of the input." Route through a ref
  // instead so the effect depends on nothing but `nested` and only ever runs on genuine mount/unmount,
  // while Escape/the modal stack still always call the CURRENT onClose (never a stale closure).
  const doCloseRef = useRef(doClose);
  useEffect(() => { doCloseRef.current = doClose; }, [doClose]);

  useEffect(() => {
    const stableClose = () => doCloseRef.current();
    modalStack.push(stableClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalStack[modalStack.length - 1] !== stableClose) return; // only the topmost modal responds
      stableClose();
    };
    document.addEventListener("keydown", onKey);
    // `overflow: hidden` alone does NOT stop background scroll on iOS Safari (a long-standing WebKit quirk)
    // — the list behind the modal kept scrolling under your thumb while you scrolled inside it, which reads
    // as badly broken on a phone. Pinning the body at its current scroll position actually blocks it there;
    // restore both the styles and the scroll offset on close so the list isn't left jumped to the top.
    // Only the OUTERMOST modal should touch body scroll — a nested popup opening on top of the task view
    // must not re-pin (and then, on its own close, prematurely un-pin) what the parent already locked.
    let restoreBody: (() => void) | undefined;
    if (!nested) {
      const scrollY = window.scrollY;
      const body = document.body.style;
      const prev = { overflow: body.overflow, position: body.position, top: body.top, width: body.width };
      body.overflow = "hidden";
      body.position = "fixed";
      body.top = `-${scrollY}px`;
      body.width = "100%";
      restoreBody = () => {
        body.overflow = prev.overflow; body.position = prev.position; body.top = prev.top; body.width = prev.width;
        window.scrollTo(0, scrollY);
      };
    }
    // Focus trap + initial focus: move focus INTO the dialog (its first focusable element) so a keyboard
    // or screen-reader user actually lands inside it, and keep Tab/Shift+Tab from ever leaving it. Restore
    // focus to whatever opened the modal when it closes — without this, focus silently falls back to
    // <body> and a screen reader user loses their place entirely.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [],
    ).filter((el) => el.offsetParent !== null); // skip anything hidden (a closed disclosure, etc.)
    const first = focusables()[0];
    (first || panelRef.current)?.focus();
    const onTrapTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = focusables();
      if (!els.length) return;
      const firstEl = els[0], lastEl = els[els.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onTrapTab);
    return () => {
      modalStack.splice(modalStack.indexOf(stableClose), 1);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onTrapTab);
      restoreBody?.();
      previouslyFocused?.focus?.();
    };
  }, [nested]);

  const L = useLang();
  return createPortal(
    <div className={`task-modal-overlay ${nested ? "nested" : ""} ${closing ? "closing" : ""}`} onClick={doClose} role="presentation">
      {/* aria-label rather than aria-labelledby: the dialog's title lives inside `children` (a note/deck/
          quiz's own <h3>, or TaskFocus's <h2>) in whatever markup that component chooses, so there's no
          reliable element to point an id at from here — the caller passes the same text as a plain string
          instead. Falls back to a generic name so the dialog is never announced completely unlabelled. */}
      <div ref={panelRef} className={`task-modal ${nested ? "nested" : ""} ${closing ? "closing" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title || L("Détails", "Details")} tabIndex={-1}>
        <button className={`task-modal-x ${nested ? "nested" : ""}`} onClick={doClose} aria-label={L("Fermer", "Close")}>✕</button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
