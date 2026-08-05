import { useEffect, useState, useCallback, useRef, useContext, createContext, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { WebTask, ConnectionStatus, Profile, TaskStep, TaskFlashcards } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, isLowGrade, isPeakHourUtc, sortWithinQuadrant } from "../shared/types.ts";
import { api, type IntegrationItem, type ConnectedAccount } from "./api.ts";

// App-wide UI language (default French; toggled in Settings, sourced from the account's ConnectionStatus/
// Profile). `L(fr, en)` picks the right string for whichever language is active — used everywhere instead of
// hardcoding French so switching the toggle changes the WHOLE interface, not just AI-generated content.
const LangContext = createContext<"fr" | "en">("fr");
function useLang(): (fr: string, en: string) => string {
  const lang = useContext(LangContext);
  return (fr: string, en: string) => (lang === "en" ? en : fr);
}

/** "just now" / "2h ago" / "Jul 3" — compact, human moment for when a step was completed. */
const relTime = (iso: string): string => {
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
function statusChip(t: WebTask, retrying?: boolean, en?: boolean): { label: string; tone: "muted" | "busy" | "attention" | "bad" | "good" } | null {
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

// Translate a sweep job's skip/failure line into user terms — an honest reason, never a fake all-clear.
function sweepSkipMessage(note: string, en?: boolean): string {
  if (/nothing connected/i.test(note)) return en
    ? "No apps are connected for this account — connect Gmail in Settings so Otto has something to read."
    : "Aucune app n'est connectée sur ce compte — connecte ton Pronote/Gmail dans les Réglages pour qu'Otto ait de quoi lire.";
  if (/budget reached/i.test(note)) return en
    ? "Otto's reached its monthly AI budget — it resets on the 1st."
    : "Otto a atteint son plafond mensuel d'IA — ça se renouvelle le 1er.";
  if (/paused/i.test(note)) return en
    ? "AI is paused — resume it in Settings to sweep for new tasks."
    : "L'IA est en pause — réactive-la dans les Réglages pour chercher de nouvelles tâches.";
  return en ? `Sweep didn't finish: ${note.replace(/^(skipped:|sweep \w+:?)\s*/i, "")}` : `Vérification incomplète : ${note.replace(/^(skipped:|sweep \w+:?)\s*/i, "")}`;
}

// Short source label for the collapsed card's source badge — same apps as linkKind, just for task.source.
const SOURCE_BADGE: Record<string, string> = {
  gmail: "Gmail", calendar: "Calendar", googlecalendar: "Calendar", manual: "You",
  slack: "Slack", github: "GitHub", notion: "Notion", linear: "Linear", todoist: "Todoist",
  googledrive: "Drive", pronote: "Pronote",
};
const SOURCE_BADGE_EN: Record<string, string> = { ...SOURCE_BADGE, manual: "You" };
const SOURCE_BADGE_FR: Record<string, string> = { ...SOURCE_BADGE, manual: "Toi" };
function sourceBadge(s: string, en?: boolean): string {
  const map = en ? SOURCE_BADGE_EN : SOURCE_BADGE_FR;
  return map[s] || (s ? s[0].toUpperCase() + s.slice(1) : (en ? "Task" : "Tâche"));
}
// Quadrant already encodes urgency+importance (see eisenhower()) — reuse it as a plain-English priority
// badge instead of asking the user to parse "do/schedule/delegate/later".
function priorityBadge(q?: string, en?: boolean): string {
  return q === "do" ? (en ? "Urgent" : "Urgent") : q === "schedule" ? (en ? "Medium" : "Moyen") : (en ? "Low" : "Faible");
}

// One short context line under the title. The STATUS is carried by the chip on the right — the subtitle
// never repeats it. So: the "why" for a fresh task, the error for a failed one, nothing when the chip says it.
function subtitle(t: WebTask): string {
  const c = canonStatus(t.status);
  if (c === "failed_retryable" || c === "failed_terminal") return t.lastError || "";
  if (c === "ready") return t.why;
  return "";
}
// A "YYYY-MM-DD" (or ISO) date → "Aug 1". Used for the AI-budget renewal date.
function fmtDay(iso: string): string {
  const d = new Date(/T/.test(iso) ? iso : `${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Format a task's deadline: a raw ISO date/datetime → "Jul 27"; already-human text ("late July", "today") as-is.
function fmtWhen(when: string): string {
  const s = String(when || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); if (!isNaN(d.getTime())) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  return s;
}

// Open a URL in a new tab. Prefers the Otto Chrome extension (web/extension/) — it sets a DOM flag and
// relays postMessage to chrome.tabs.create, so tabs can open UNATTENDED during auto-do. Without it, falls
// back to window.open (works on a user click).
// Temporary: Otto still generates, ranks, and breaks tasks into steps, but does not auto-run or offer
// one-click execution of them — the card shows the plan as a checklist for the user to work through
// themselves. Flip back to true to restore auto-do/Approve & Run/Send. Nothing execution-related is deleted.
const EXECUTION_ENABLED = false;
const TAB_GROUP = "Otto"; // all tabs Otto opens go into this one named group
const extPresent = () => document.documentElement.getAttribute("data-weave-ext") === "1";
// Open one or many tabs. With the extension, they go into a NAMED tab group (per task); without it,
// window.open (no grouping possible from a plain page).
function openTab(url: string, group?: string) {
  if (extPresent()) window.postMessage({ type: "weave-open-tab", url, group }, window.location.origin);
  else window.open(url, "_blank", "noopener");
}
function openTabs(urls: string[], group?: string) {
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

/** Render context/synthesis as a clean bullet list (one bullet per line; leading -/•/* stripped). Full
 *  text always shown — never truncated. Falls back to a single line if there's just one. */
// Otto is instructed to write inline markdown links ([label](url)) into "did"/"steps" text when it names a
// specific resource — render those as real clickable buttons instead of leaving the raw "[text](url)" syntax
// visible. Anything not matching the pattern passes through as plain text.
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
function withInlineLinks(text: string): ReactNode {
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

/** Light markdown → JSX for an in-app note (CREATE_NOTE's body): headings, **bold**, and bullet/numbered
 *  lists. Never sent anywhere — this only ever renders inside the popup, so a small hand-rolled pass is
 *  enough (no need for a full markdown library just for this). */
function renderNoteBody(md: string): ReactNode {
  const boldify = (s: string): ReactNode => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p));
  };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  const flushList = () => {
    if (list) { blocks.push(<ul key={blocks.length} className="note-list">{list.map((t, i) => <li key={i}>{boldify(t)}</li>)}</ul>); list = null; }
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flushList(); return; }
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) { flushList(); const Tag = h[1].length === 1 ? "h3" : h[1].length === 2 ? "h4" : "h5"; blocks.push(<Tag key={i}>{boldify(h[2])}</Tag>); return; }
    const li = /^[-*]\s+(.*)|^\d+[.)]\s+(.*)/.exec(line);
    if (li) { (list ||= []).push(li[1] ?? li[2]); return; }
    flushList();
    blocks.push(<p key={i}>{boldify(line)}</p>);
  });
  flushList();
  return blocks;
}

/** Drillable flashcard viewer (CREATE_FLASHCARDS): space/click flips the card, → marks it right and
 *  advances, ← marks it wrong and advances. Ends on a score summary with a restart. Keyboard-first so a
 *  student can drill an entire deck without touching the mouse. */
function FlashcardDeck({ deck }: { deck: TaskFlashcards }) {
  const L = useLang();
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [right, setRight] = useState<number[]>([]);
  const [wrong, setWrong] = useState<number[]>([]);
  const done = i >= deck.cards.length;
  const card = !done ? deck.cards[i] : null;
  const mark = (ok: boolean) => {
    if (!card) return;
    (ok ? setRight : setWrong)((prev) => [...prev, i]);
    setFlipped(false);
    setI((v) => v + 1);
  };
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
            <div className="deck-face-text">{card!.front}</div>
          </div>
          <div className="deck-card-face deck-card-back">
            <span className="deck-face-label">{L("Réponse", "Back")}</span>
            <div className="deck-face-text">{card!.back}</div>
          </div>
        </div>
      </div>
      <p className="deck-hint">{L("Espace pour retourner · ← faux · → correct", "Space to flip · ← wrong · → correct")}</p>
      <div className="deck-acts">
        <button className="btn ghost deck-btn-wrong" onClick={() => mark(false)}>← {L("Faux", "Wrong")}</button>
        <button className="btn ghost" onClick={() => setFlipped((v) => !v)}>{L("Retourner", "Flip")}</button>
        <button className="btn primary deck-btn-right" onClick={() => mark(true)}>{L("Correct", "Correct")} →</button>
      </div>
    </div>
  );
}

/** The Otto mark — a ring cut by the consent line. The LEFT half is solid (work Otto already did, done); the
 *  RIGHT half is an open stroke (work still waiting on you); the vertical cobalt line between them is the
 *  threshold — on this side Otto acted, on that side it stopped and left the decision to you. The ring
 *  inherits currentColor (ink, inverts in dark mode); the line is always cobalt. */
function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M24 4 A20 20 0 0 0 24 44 Z" fill="currentColor" />
      <path d="M24 6 A18 18 0 0 1 24 42" stroke="currentColor" strokeWidth="4" fill="none" />
      <rect x="23" y="0" width="2" height="48" fill="#2F4DE0" />
    </svg>
  );
}

/** Strip leading/trailing slashes → the bare route ("" = dashboard, "settings", "login", "task/<id>"). */
const routeOf = (pathname: string) => pathname.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Tiny dependency-free History-API router (clean paths like /login, /settings, /task/<id> — no hash).
 * Both the Vite dev server and the Express prod server fall back to index.html for any path, so a deep
 * link or refresh resolves. A delegated click handler routes internal <a href="/..."> links in-app
 * (no full reload) — but lets REAL server routes (/auth/*, /api/*) and new-tab/download links through.
 */
function usePathRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(routeOf(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener("popstate", on);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement)?.closest?.("a");
      const href = a?.getAttribute("href");
      if (!a || !href || !href.startsWith("/") || href.startsWith("//") || a.target === "_blank" || a.hasAttribute("download")) return;
      if (href.startsWith("/auth") || href.startsWith("/api") || href.startsWith("/integrations")) return; // real server routes — let the browser navigate
      e.preventDefault();
      navigate(routeOf(href));
    };
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", on); document.removeEventListener("click", onClick); };
  }, []);
  return [route, navigate];
}

// Remember the signed-in state across reloads so a returning user lands straight on their dashboard
// (no login flash). It's reconciled with the server on load — the cookie session is the real source.
const CACHED_STATUS: ConnectionStatus | null = (() => {
  try { return JSON.parse(localStorage.getItem("weave-status") || "null"); } catch { return null; }
})();

const GREETING = (lang?: "fr" | "en") => {
  const h = new Date().getHours();
  if (lang === "en") return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
};
/** A friendly first name from the account email's local part ("tjong.willem@…" → "Tjong"). Personalizes the UI. */
const firstName = (user?: string) => {
  const local = (user || "").split("@")[0].split(/[._+-]+/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
};

/** Navigate the path router. "" → "/" (dashboard); otherwise "/<route>" (e.g. "task/<id>", "settings").
 *  pushState doesn't fire popstate, so we dispatch one to notify the router hook. */
const navigate = (r: string) => {
  window.history.pushState({}, "", r ? `/${r}` : "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
};

// Last-known task list — hydrates the dashboard INSTANTLY on open (server truth replaces it right after).
const CACHED_TASKS: WebTask[] = (() => {
  try { const t = JSON.parse(localStorage.getItem("otto-tasks") || "[]"); return Array.isArray(t) ? t : []; } catch { return []; }
})();

// "New" indicator: task ids the user has already OPENED at least once, so a fresh card gets a small dot
// until they look at it, then never again — permanent per-id memory (not a session flag), purely local
// (no server field needed for something this cosmetic). Capped so a long-lived account's set can't grow
// forever; oldest entries fall off first since new ids are always appended at the end.
const SEEN_KEY = "otto-seen-tasks";
const SEEN_CAP = 500;
const loadSeenTasks = (): Set<string> => {
  try { const a = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
};
const saveSeenTasks = (s: Set<string>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-SEEN_CAP))); } catch { /* ignore */ }
};

export function App() {
  const [status, setStatus] = useState<ConnectionStatus | null>(CACHED_STATUS);
  const [route] = usePathRoute();
  const [tasks, setTasks] = useState<WebTask[]>(CACHED_TASKS);
  const [loaded, setLoaded] = useState(false);   // server truth arrived (cached list may be stale until then)
  const [scanning, setScanning] = useState(false); // the daily background sweep is running
  const [busy, setBusy] = useState(false);
  // A single transient notification (the ↻ Refresh summary, a "nothing found", an action error). Rendered
  // as a toast at the top of the dashboard so feedback is visible WHETHER OR NOT the list already has cards —
  // the old `note` only showed on an empty list, so a Refresh over a non-empty list looked like it did nothing.
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState<"info" | "error">("info");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((msg: string, kind: "info" | "error" = "info") => {
    setNote(msg); setNoteKind(kind);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    // Errors linger longer (the user needs time to read + act); info auto-clears.
    if (msg) noteTimer.current = setTimeout(() => setNote(""), kind === "error" ? 12_000 : 7_000);
  }, []);
  const dismissNote = useCallback(() => { if (noteTimer.current) clearTimeout(noteTimer.current); setNote(""); }, []);
  const [onboard, setOnboard] = useState(() => { try { return localStorage.getItem("otto-onboard") === "1"; } catch { return false; } });
  const [loadError, setLoadError] = useState(false); // backend unreachable after retries → show a retry screen
  const [reloadKey, setReloadKey] = useState(0);      // bump to re-attempt the status fetch
  const [seenTasks, setSeenTasks] = useState<Set<string>>(() => loadSeenTasks());
  // Defense in depth against cached-tasks leaking across accounts on a shared/reused browser: signOut()
  // clears the cache on an explicit sign-out, but a session can also end by just expiring (cookie cleared,
  // server-side timeout) without that ever running. The moment the REAL status confirms who's actually
  // logged in, if it doesn't match whichever account's status/tasks were cached, drop the stale cache
  // immediately rather than let it linger on screen until the tasks fetch happens to replace it.
  useEffect(() => {
    if (!status?.user) return;
    if (CACHED_STATUS?.user && CACHED_STATUS.user !== status.user) {
      setTasks([]);
      try { ["otto-tasks", "otto-seen-tasks", "otto-lastgen"].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
      setSeenTasks(new Set());
    }
  }, [status?.user]);
  // AI budget (from the CLOUD-authoritative /api/usage) — drives the "budget reached" banner + renewal date,
  // so it reflects usage racked up by background jobs, not just this session.
  const [budget, setBudget] = useState<{ over: boolean; renewsOn: string } | null>(null);
  const loadBudget = useCallback(async () => { try { const u = await api.usage(); setBudget({ over: u.over, renewsOn: u.renewsOn }); } catch { /* keep last */ } }, []);
  // First-run onboarding is the ONE place Otto is explained — set on signup, cleared when the flow finishes.
  const startOnboard = () => { try { localStorage.setItem("otto-onboard", "1"); } catch { /* ignore */ } setOnboard(true); };
  const finishOnboard = () => { try { localStorage.removeItem("otto-onboard"); } catch { /* ignore */ } setOnboard(false); };
  const [showCompleted, setShowCompleted] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  // Briefly highlights the row a just-confirmed task lands on in "Completed" — gives finishing something a
  // visible destination instead of the card just vanishing from the active list with nothing to show for it.
  const [justDoneId, setJustDoneId] = useState<string | null>(null);
  const flagJustDone = useCallback((id: string) => {
    setJustDoneId(id);
    setTimeout(() => setJustDoneId((cur) => (cur === id ? null : cur)), 1500);
  }, []);
  // The staggered card entrance runs ONCE on first paint; later list updates (a step ticked, a background
  // sweep folding in) must not replay the whole cascade — that's what made loads feel janky.
  const [settled, setSettled] = useState(false);
  const generatedOnce = useRef(false);

  const loadStatus = useCallback(async () => { try { setStatus(await api.status()); } catch { /* keep last */ } }, []);

  // Persist the signed-in state so a returning user skips the login flash (reconciled on next load).
  useEffect(() => {
    try { status ? localStorage.setItem("weave-status", JSON.stringify(status)) : localStorage.removeItem("weave-status"); } catch { /* ignore */ }
  }, [status]);

  // Persist tasks so the NEXT open paints the dashboard instantly (capped — enough for first paint).
  useEffect(() => {
    try { localStorage.setItem("otto-tasks", JSON.stringify(tasks.slice(0, 60))); } catch { /* ignore */ }
  }, [tasks]);

  // Retry status until the backend is reachable (tsx dev-server boot race) — don't get stuck on the spinner.
  // After the retries are exhausted, surface a real "can't reach the server" screen instead of a forever-spinner.
  useEffect(() => {
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try { const s = await api.status(); if (!stop) { setStatus(s); setLoadError(false); } }
      catch { if (!stop) { if (tries++ < 30) setTimeout(tick, 1000); else setLoadError(true); } }
    };
    void tick();
    return () => { stop = true; };
  }, [reloadKey]);

  const connected = !!status?.googleConnected || !!status?.pronoteConnected;

  // Let the first card cascade finish, then mark the list settled so re-renders don't replay it.
  useEffect(() => {
    if (!connected) return;
    const id = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(id);
  }, [connected]);

  // Un-stick tasks whose auto-run died mid-flight (marked autoRan but produced nothing) so they retry.
  // Server truth passes through as-is — the job layer owns execution state now; the client just displays it.
  const retryFlags = (list: WebTask[]) => list;

  // Never let a background refresh (sync/sweep/manual-scan) resurrect a card the user already finished or
  // dismissed LOCALLY — a request dispatched before that click can resolve AFTER it (slow network, a sweep
  // that takes longer than the click round-trip) and would otherwise stomp the local decision back to
  // "still active" until the next refresh quietly re-fixes it. Same guard the kick() loop below already
  // applies to its own updates; this makes it consistent across every path that replaces the task list.
  const keepLocalHandled = (prev: WebTask[], incoming: WebTask[]): WebTask[] => {
    // Defensive: on a 401 (session expired mid-session) the API layer resolves with the error BODY instead
    // of throwing (see api.ts's j() — 401 is deliberately swallowed so status() can read `loggedIn:false`
    // without a try/catch), so a task-array endpoint can resolve to a plain {error} object here at runtime
    // despite its TS return type. Without this guard that crashed the whole app (incoming.map is not a
    // function) — which, from the outside, looked exactly like "my task got deleted" when the error
    // boundary reset the tree. Treat anything non-array as "no update," never crash the app over it.
    if (!Array.isArray(incoming)) return prev;
    const incomingIds = new Set(incoming.map((t) => t.id));
    const merged = incoming.map((u) => {
      const cur = prev.find((p) => p.id === u.id);
      return cur && isHandled(cur.status) && !isHandled(u.status) ? cur : u;
    });
    // A LOCAL task missing from `incoming` used to just vanish — but incoming isn't necessarily "the whole
    // truth as of now," it can be a slightly-stale fetch that raced a task added moments ago (dispatched
    // before the add, resolved after — the same class of race as the dismiss/confirm case above, just for
    // creation instead of status). Bounded to the last 2 minutes so a task that's ACTUALLY gone (a rare far
    // future prune of very old handled records) doesn't get resurrected forever by this fallback.
    // IMPORTANT: Only preserve MANUALLY added tasks (source === "manual") — backend-generated tasks
    // that are missing from the response should NOT be resurrected, as this causes the bug where tasks
    // generated in the backend don't appear in the frontend.
    const RECENT_MS = 2 * 60_000;
    const now = Date.now();
    const recentlyMissing = prev.filter((p) => 
      !incomingIds.has(p.id) && 
      p.source === "manual" && 
      now - (Date.parse(p.createdAt || "") || 0) < RECENT_MS
    );
    return [...recentlyMissing, ...merged];
  };

  // Pull the server's task list (cheap GET; also reconciles cross-device state server-side). Always resolves
  // `loaded` — even on an empty/failed fetch — so the loading screen can never hang half-forever (the
  // 15-min tick + focus re-sync retry a transient miss).
  const syncTasks = useCallback(async () => {
    const t = await api.tasks().catch(() => null);
    if (t) setTasks((prev) => keepLocalHandled(prev, retryFlags(t)));
    setLoaded(true);
  }, []);

  // Continuous monitoring: run a background sweep when the last SUCCESSFUL one is older than the watch
  // interval (the server gates too — a too-soon call is a fast no-op). The marker is only set on SUCCESS,
  // so a failed/timed-out sweep retries on the next trigger instead of silently losing its slot. Each
  // sweep is a cheap read-only DELTA ("what's new since the list was built"), which is what makes
  // watching all day affordable.
  // Cadence from the user's setting: 1–4 scans/day (default 1). 1/day → 24h between sweeps, 4/day → 6h.
  const genPerDay = Math.min(4, Math.max(1, status?.genPerDay || 1));
  const SWEEP_EVERY_MS = Math.floor(24 * 60 * 60_000 / genPerDay);
  const sweeping = useRef(false);
  const sweepIfDue = useCallback(async () => {
    if (!connected || status?.paused || status?.overBudget || sweeping.current) return;
    let last = 0;
    try { last = Number(localStorage.getItem("otto-lastgen") || 0); } catch { /* sweep anyway */ }
    if (Date.now() - last < SWEEP_EVERY_MS) return;
    // Cost-aware: DeepSeek prices peak UTC hours (01:00-04:00, 06:00-10:00) at 2x. If today's once-a-day
    // minimum is already covered (this is an EXTRA cadence sweep from a >1x/day setting), it's fine to
    // hold off for an off-peak window — the 15-min/focus retry picks it up. Never delay the ONE sweep
    // that guarantees daily coverage: a fresh day (or no prior sweep) always runs immediately.
    const sameLocalDayAsLast = last > 0 && new Date(last).toDateString() === new Date().toDateString();
    if (isPeakHourUtc() && sameLocalDayAsLast && genPerDay > 1) return;
    sweeping.current = true;
    setScanning(true);
    try {
      const { tasks: fresh, note: serverNote } = await api.generate();
      setTasks((prev) => keepLocalHandled(prev, retryFlags(fresh))); setLoaded(true);
      // A skipped sweep must say WHY (e.g. "nothing connected") — never look like a quiet all-clear.
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, status?.language === "en"), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
      try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ }
    } catch { /* marker stays unset — next focus/interval tick retries */ }
    finally { sweeping.current = false; setScanning(false); }
  }, [connected, status?.paused, SWEEP_EVERY_MS]);

  // Once Google is connected: load tasks + budget, trigger the daily sweep (silent, in background).
  useEffect(() => {
    if (!connected) return;
    void (async () => { await syncTasks(); void loadBudget(); void sweepIfDue(); })();
  }, [connected, status?.aiReady, syncTasks, sweepIfDue, loadBudget]);

  // Returning to the tab re-syncs the list (tasks finished elsewhere appear WITHOUT a manual reload) and
  // sweeps again if the watch interval has passed — so Otto keeps watching throughout the day, and the
  // list is never stuck waiting for a tab-switch to show up.
  useEffect(() => {
    if (!connected) return;
    const on = () => { if (!document.hidden) { void syncTasks(); void loadBudget(); void sweepIfDue(); } };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    // A backend-generated task (from cron, another device, or a queued-but-not-auto-run item) is only ever
    // shown by a task re-fetch. The old 15-min tick meant such a task could sit INVISIBLE on an open, idle
    // tab for up to 15 minutes ("it generated but doesn't show"). Poll the cheap /api/tasks GET every 45s so
    // new tasks surface quickly; the heavier sweep it also triggers stays gated by the user's cadence
    // (sweepIfDue is a fast no-op until due), so this doesn't sweep more often.
    const syncTick = setInterval(() => { if (!document.hidden) { void syncTasks(); } }, 45_000);
    const fullTick = setInterval(on, 5 * 60_000); // periodic budget refresh + cadence-gated sweep check
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); clearInterval(syncTick); clearInterval(fullTick); };
  }, [connected, syncTasks, sweepIfDue, loadBudget]);

  // THE SERVER OWNS EXECUTION. The browser no longer decides what runs — sweeps queue execution jobs
  // server-side, cron drains them offline. While anything is queued/executing, the OPEN client "kicks"
  // the drain (one bounded job per kick) so online users see work complete within seconds instead of at
  // the next cron tick, and folds each kick's fresh task state straight into the list.
  const kicking = useRef(false);
  // Task ids with a genuinely active (queued/running) job — the only honest basis for "retrying…".
  const [retryingIds, setRetryingIds] = useState<string[]>([]);
  // Kicks continue through failed_retryable too — the failed attempt's job is REQUEUED server-side, so
  // "Failed — will retry" actually retries within seconds while the tab is open (not at the next cron).
  const hasActiveWork = (list: WebTask[]) => list.some((t) => isInFlight(t.status) || canonStatus(t.status) === "failed_retryable");
  useEffect(() => {
    if (!connected || !loaded || status?.paused) return;
    if (!hasActiveWork(tasks)) return;
    const tick = async () => {
      if (kicking.current) return;
      kicking.current = true;
      try {
        const out = await api.kick();
        setRetryingIds(Array.isArray(out.activeTaskIds) ? out.activeTaskIds : []);
        if (Array.isArray(out.tasks) && out.tasks.length) {
          setTasks((prev) => keepLocalHandled(prev, out.tasks));
        }
      } catch { /* next tick retries */ }
      finally { kicking.current = false; }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, [connected, loaded, status?.paused, hasActiveWork(tasks)]);

  // Manual ↻ Refresh: an on-demand FORCED sweep (bypasses the daily floor). The automatic daily sweep is
  // sweepIfDue above — once per day, retried on focus/interval until it succeeds, never more.

  const generate = async () => {
    setBusy(true); dismissNote();
    try {
      const before = new Set(tasks.map((t) => t.id));
      const { tasks: t, note: serverNote } = await api.generate(true);
      setTasks((prev) => keepLocalHandled(prev, t)); setLoaded(true);
      // A manual Refresh counts as a sweep — reset the watch interval so the background one doesn't repeat it.
      try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ }
      // Run summary — honest, specific feedback on what the sweep did (the trust-building layer).
      // A SKIPPED sweep says why (nothing connected / paused) instead of masquerading as "no new tasks".
      const fresh = t.filter((x) => !before.has(x.id) && !isHandled(x.status));
      const queuedN = fresh.filter((x) => isInFlight(x.status)).length;
      const needsYou = t.filter((x) => canonStatus(x.status) === "needs_review" && (x.steps?.some((s) => !s.done && !s.automatable) || x.sendables?.some((s) => !s.sent))).length;
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, status?.language === "en"), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
      else if (!t.length) notify("Nothing found — nothing actionable in your recent inbox + calendar right now.");
      else if (!fresh.length) notify(`Swept your apps — no new tasks${needsYou ? `; ${needsYou} still need${needsYou === 1 ? "s" : ""} you` : "; everything actionable is already on your list"}.`);
      else notify(`Found ${fresh.length} new task${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} queued to run` : ""}${needsYou ? `, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}.`);
      void loadBudget();
    }
    catch (e: any) { notify(en ? `Couldn't refresh: ${e?.message || "something went wrong — try again."}` : `Actualisation impossible : ${e?.message || "une erreur est survenue — réessaie."}`, "error"); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    await api.logout();
    // Clear every local cache keyed to THIS account — without this, the next sign-in on the same browser
    // (a different person, or the same person after clearing cookies) would hydrate instantly from the
    // PREVIOUS account's cached tasks/status (see CACHED_TASKS/CACHED_STATUS above) before the real fetch
    // replaces them — visible, if briefly, as someone else's to-do list. None of these are needed once
    // signed out; the next session starts genuinely fresh.
    try { ["otto-tasks", "weave-status", "otto-seen-tasks", "otto-lastgen", "otto-onboard"].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    setTasks([]); setLoaded(false); generatedOnce.current = false; navigate(""); void loadStatus();
  };

  // Signed in, the dashboard lives at /tasks. Redirect the bare "/" there (landing only shows signed-OUT).
  useEffect(() => { if (status?.loggedIn && route === "") navigate("tasks"); }, [status?.loggedIn, route]);

  // Auto-capture the browser's timezone once it differs from what's stored — so all "local day" math on the
  // server (sweep cadence, daily-minimum) is correct without ever asking the user. Fires only on a real change.
  const tzSynced = useRef(false);
  useEffect(() => {
    if (!status?.loggedIn || tzSynced.current) return;
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();
    if (tz && tz !== status.timezone) { tzSynced.current = true; void api.setProfilePreference("timezone", tz).then(loadStatus).catch(() => { tzSynced.current = false; }); }
  }, [status?.loggedIn, status?.timezone, loadStatus]);

  const openId = route.startsWith("task/") ? route.slice(5) : null; // the deep-linked task, if any
  // Mark a task "seen" the moment its route opens — this is the ONE place every path into the task
  // modal funnels through (four different onToggle call sites below all navigate here), so hooking it
  // here instead of each call site can't miss one. MUST stay above every early return below (Rules of
  // Hooks) — a version of this that lived after the login/legal-page returns crashed React (#310,
  // "hooks order changed") on any route that skipped it, e.g. straight to /login.
  useEffect(() => {
    if (!openId || seenTasks.has(openId)) return;
    setSeenTasks((prev) => { const next = new Set(prev); next.add(openId); saveSeenTasks(next); return next; });
  }, [openId]);

  // Legal pages are PUBLIC — reachable logged-out or in, and even before status loads.
  if (route === "privacy") return <LegalPage kind="privacy" />;
  if (route === "terms") return <LegalPage kind="terms" />;

  if (!status) {
    if (loadError) return (
      <div className="screen crash">
        <div className="crash-card">
          <h1>Can't reach Otto</h1>
          <p>The server isn't responding. Check your connection and try again.</p>
          <button className="btn primary big" onClick={() => { setLoadError(false); setReloadKey((k) => k + 1); }}>Try again</button>
        </div>
      </div>
    );
    return <div className="screen"><div className="brand boot"><Logo size={26} /> Otto</div><div className="spinner" /></div>;
  }
  if (!status.loggedIn) {
    return route === "login" || route === "signup"
      ? <LoginPage status={status} onDone={async (isNew) => { if (isNew) startOnboard(); await loadStatus(); navigate("tasks"); }} initialMode={route === "signup" ? "signup" : "login"} />
      : <Landing />;
  }

  // Eisenhower ranking with deadline/VIP/freshness tie-breaks — same bands/cards, just a better order.
  const live = sortWithinQuadrant(tasks.filter((t) => t.status !== "done" && t.status !== "dismissed"), status?.highPriorityPeople || []);
  const completed = tasks.filter((t) => t.status === "done").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const working = tasks.filter((t) => isInFlight(t.status)).length;
  const handled = completed.length;
  const unseenCount = live.filter((t) => !seenTasks.has(t.id)).length;
  const en = status?.language === "en";

  return (
    <LangContext.Provider value={status?.language === "en" ? "en" : "fr"}>
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={20} /> Otto</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} href="/tasks">{status?.language === "en" ? "Tasks" : "Tâches"}{unseenCount > 0 ? <span className="tab-badge">{unseenCount}</span> : null}</a>
          <a className={`tab ${route === "settings" ? "active" : ""}`} href="/settings">{status?.language === "en" ? "Settings" : "Réglages"}</a>
        </nav>
        <div className="spacer" />
        {(route === "" || route === "tasks" || route.startsWith("task/")) && (status.googleConnected || status.pronoteConnected) && <button className="btn ghost" disabled={busy} onClick={() => void generate()}>{busy ? (status?.language === "en" ? "Searching…" : "Recherche…") : (status?.language === "en" ? "Refresh" : "Actualiser")}</button>}
      </header>

      {onboard && <Onboarding onStatus={loadStatus} onDone={finishOnboard} />}

      {route === "settings" ? (
        <SettingsPage status={status} onSignOut={signOut} onChanged={loadStatus} />
      ) : !status.googleConnected && !status.pronoteConnected ? (
        <main className="list-wrap"><ConnectCard status={status} /></main>
      ) : (
        <main className="list-wrap" key="dash">
          <div className="dash-head">
            <h1 className="list-head">{GREETING(status?.language)}{(status.name || firstName(status.user)) ? <>, <span className="accent-num">{status.name || firstName(status.user)}</span></> : null}.</h1>
            <div className="list-status">
              <span><b>{live.length}</b> {en ? "active" : "en cours"}</span>
              {working ? <span> · <b>{working}</b> {en ? "processing" : "en cours de traitement"}</span> : null}
              {handled ? <span> · <b>{handled}</b> {en ? "done" : "terminées"}</span> : null}
              {scanning && <span className="scan-note"><span className="scan-dot" /> {en ? "checking…" : "vérification en cours…"}</span>}
            </div>
          </div>
          {status.pronoteConnected && <ExamCountdown lang={status.language} />}
          <WeekLoad lang={status.language} onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))} />
          {note && (
            <div className={`toast ${noteKind}`} role="status" aria-live="polite">
              <span className="toast-msg">{note}</span>
              <button className="toast-x" aria-label={en ? "Close" : "Fermer"} onClick={dismissNote}>✕</button>
            </div>
          )}
          {status.paused && (
            <div className="intro paused-banner">
              <div className="intro-body">
                <div className="intro-title">{en ? "Otto is paused" : "Otto est en pause"}</div>
                <p>{en ? "Turn it back on in Settings to continue." : "Réactive-le dans les Réglages pour continuer."}</p>
              </div>
              <button className="btn xs ghost" onClick={() => navigate("settings")}>{en ? "Settings" : "Réglages"}</button>
            </div>
          )}
          {!status.paused && (budget?.over ?? status.overBudget) && (
            <div className="intro paused-banner">
              <div className="intro-body">
                <div className="intro-title">{en ? "Monthly cap reached" : "Plafond mensuel atteint"}</div>
                <p>{en
                  ? `Otto has paused new work — it renews ${budget?.renewsOn ? fmtDay(budget.renewsOn) : "on the 1st"}. Your tasks stay as they are.`
                  : `Otto a mis en pause le nouveau travail — ça se renouvelle ${budget?.renewsOn ? fmtDay(budget.renewsOn) : "le 1er"}. Tes tâches restent en place.`}</p>
              </div>
              <button className="btn xs ghost" onClick={() => navigate("settings")}>{en ? "Settings" : "Réglages"}</button>
            </div>
          )}
          <AddTask onAdded={setTasks} />
          {/* If a deep link points at a task that's already handled (not in the live list), surface it so the URL still resolves. */}
          {(() => {
            // A deep-linked task (even a completed one) opens in the modal below, so the live list is just
            // the live tasks — no need to inject the opened id here anymore.
            const shown = live;
            // Until the first server response, an empty list means "still loading", not "all clear" —
            // show the skeleton instead of flashing the empty state.
            if (shown.length === 0 && (busy || !loaded)) return <TaskSkeleton />;
            if (shown.length === 0) {
              const who = status.name || firstName(status.user);
              // First run (nothing ever completed) reads differently from a genuinely cleared list.
              // (The refresh summary / "nothing found" now shows in the toast above, visible with or
              // without cards — so the empty state always shows its own contextual message here.)
              if (handled === 0) return (
                <div className="empty-state">
                  <div className="empty-mark"><Logo size={28} /></div>
                  <h3>{en ? `Otto is watching your Pronote${who ? `, ${who}` : ""}` : `Otto surveille ton Pronote${who ? `, ${who}` : ""}`}</h3>
                  <p>{en ? "It reads your homework and tests. New tasks arrive automatically — or check right now." : "Il lit tes devoirs et contrôles. De nouvelles tâches arrivent automatiquement — ou lance une vérification maintenant."}</p>
                  <button className="btn primary" disabled={busy} onClick={() => void generate()}>{busy ? (en ? "Searching…" : "Recherche…") : (en ? "Check now" : "Vérifier maintenant")}</button>
                </div>
              );
              return (
                <div className="empty-state">
                  <div className="empty-mark done"><span className="empty-check">✓</span></div>
                  <h3>{en ? `All caught up${who ? `, ${who}` : ""}` : `Tout est à jour${who ? `, ${who}` : ""}`}</h3>
                  <p>{en ? "Nothing waiting for you right now. Otto keeps watching your Pronote." : "Rien ne t'attend pour l'instant. Otto continue de surveiller ton Pronote."}</p>
                </div>
              );
            }
            // Grouped by focus to eliminate overwhelm: Top 3 as "Focus Today", followed by "Later" and "Can wait".
            const focusToday = shown.slice(0, 3);
            const laterToday = shown.slice(3, 6);
            const canWait = shown.slice(6);

            return (
              <div className={`list-focus-wrap ${settled ? "settled" : ""}`}>
                <div className="focus-group">
                  <div className="focus-group-head">
                    <span className="focus-title">{en ? "Today" : "Aujourd'hui"}</span>
                    <span className="focus-badge">Top {focusToday.length}</span>
                  </div>
                  <div className="list">
                    {focusToday.map((t) => (
                      <Card
                        key={t.id}
                        task={t}
                        retrying={retryingIds.includes(t.id)}
                        isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                        open={false}
                        onToggle={() => navigate(`task/${t.id}`)}
                        onChange={setTasks}
                        onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                        onConfirmed={flagJustDone}
                        onNotify={notify}
                      />
                    ))}
                  </div>
                </div>

                {laterToday.length > 0 && (
                  <div className="focus-group">
                    <div className="focus-group-head">
                      <span className="focus-title">{en ? "Later" : "Plus tard"}</span>
                    </div>
                    <div className="list">
                      {laterToday.map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          retrying={retryingIds.includes(t.id)}
                          isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                          open={false}
                          onToggle={() => navigate(`task/${t.id}`)}
                          onChange={setTasks}
                          onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                          onConfirmed={flagJustDone}
                          onNotify={notify}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {canWait.length > 0 && (
                  <div className="focus-group">
                    {!showAllTasks ? (
                      <button className="btn xs ghost show-more-btn" onClick={() => setShowAllTasks(true)}>
                        {en ? `See ${canWait.length} more task${canWait.length > 1 ? "s" : ""} for later…` : `Voir ${canWait.length} tâche${canWait.length > 1 ? "s" : ""} de plus pour plus tard…`}
                      </button>
                    ) : (
                      <>
                        <div className="focus-group-head">
                          <span className="focus-title">{en ? "Can wait" : "Peut attendre"}</span>
                        </div>
                        <div className="list">
                          {canWait.map((t) => (
                            <Card
                              key={t.id}
                              task={t}
                              retrying={retryingIds.includes(t.id)}
                              isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                              open={false}
                              onToggle={() => navigate(`task/${t.id}`)}
                              onChange={setTasks}
                              onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                              onConfirmed={flagJustDone}
                              onNotify={notify}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          {completed.length > 0 && (
            <div className="completed-section">
              <h3 className="completed-head">{en ? "Completed" : "Terminées"}</h3>
              {/* Minimalist done-list: checked rows like a to-do app, not full cards. Click to expand details. */}
              <div className="done-list">{(showCompleted ? completed : completed.slice(0, 8)).map((t) => (
                <div key={t.id} className={`done-row ${t.id === justDoneId ? "just-done" : ""}`} onClick={() => navigate(`task/${t.id}`)} title={t.synthesis || t.why}>
                  <span className="done-check">✓</span>
                  <span className="done-title">{t.title}</span>
                  <span className="done-when">{relTime(t.updatedAt || t.createdAt)}</span>
                </div>
              ))}</div>
              {completed.length > 8 && !showCompleted && (
                <button className="btn xs ghost" onClick={() => setShowCompleted(true)}>{en ? `Show all ${completed.length}` : `Tout afficher (${completed.length})`}</button>
              )}
            </div>
          )}
          {/* Task detail opens as a modal over the list — click a row (live or completed) to open it. */}
          {(() => {
            const openTask = openId ? tasks.find((t) => t.id === openId) : null;
            if (!openTask) return null;
            return (
              <TaskModal onClose={() => navigate("")}>
                <Card
                  task={openTask}
                  open
                  inModal
                  retrying={retryingIds.includes(openTask.id)}
                  onToggle={() => navigate("")}
                  onChange={setTasks}
                  onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                  onConfirmed={(id) => { flagJustDone(id); navigate(""); }}
                  onNotify={notify}
                />
              </TaskModal>
            );
          })()}
        </main>
      )}
    </div>
    </LangContext.Provider>
  );
}

/** Modal shell for the task detail — backdrop-click, ✕, and Esc all close; locks body scroll while open. */
function TaskModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") doClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [doClose]);
  return (
    <div className={`task-modal-overlay ${closing ? "closing" : ""}`} onClick={doClose} role="dialog" aria-modal="true">
      <div className={`task-modal ${closing ? "closing" : ""}`} onClick={(e) => e.stopPropagation()}>
        <button className="task-modal-x" onClick={doClose} aria-label="Close">✕</button>
        {children}
      </div>
    </div>
  );
}

/** A horizontal strip of upcoming Pronote tests with a day-countdown — separate from the task list so
 *  crunch weeks are visible at a glance, not buried inside individual task cards. Reads straight from
 *  Pronote (not the task pipeline) so it shows the raw subject+date list. */
function ExamCountdown({ lang }: { lang?: "fr" | "en" }) {
  const en = lang === "en";
  const [tests, setTests] = useState<{ subject: string; deadline: string }[] | null>(null);
  useEffect(() => { void api.pronoteTests().then((r) => setTests(r.tests)).catch(() => setTests([])); }, []);
  if (!tests?.length) return null;
  const sorted = [...tests].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)).slice(0, 8);
  const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  return (
    <div className="exam-strip-wrap">
      <div className="exam-strip-label">{en ? "Upcoming tests" : "Contrôles à venir"}</div>
      <div className="exam-strip">
        {sorted.map((t, i) => {
          const d = daysLeft(t.deadline);
          const soon = d <= 3;
          const when = new Date(t.deadline).toLocaleDateString(en ? "en-US" : "fr-FR", { weekday: "short", day: "numeric", month: "short" });
          return (
            <div key={i} className={`exam-chip ${soon ? "soon" : ""}`}>
              <span className="exam-days">{d <= 0 ? (en ? "Today" : "Aujourd'hui") : `J-${d}`}</span>
              <span className="exam-subject">{t.subject}</span>
              <span className="exam-when">{when}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type WorkloadDay = { date: string; items: { kind: "homework" | "test" | "task"; subject?: string; title: string; effort: number; taskId?: string; movable?: boolean }[]; totalEffort: number };

/** Deterministic "this week" strip — no AI call, just real Pronote homework/tests + open tasks bucketed
 *  by day. Answers the 4 workload gaps in one glance: what's on each day, how heavy it actually is (bar
 *  height, relative to the week — never presented as minutes), which day is a pile-up (accent chip, same
 *  visual language as ExamCountdown's "soon"), and — once expanded — a way to nudge a movable task off an
 *  overloaded day onto the lightest one, without any AI round-trip. */
function WeekLoad({ lang, onTask }: { lang?: "fr" | "en"; onTask: (t: WebTask) => void }) {
  const en = lang === "en";
  const [days, setDays] = useState<WorkloadDay[] | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const load = useCallback(() => { void api.workload().then((r) => setDays(r.days)).catch(() => setDays([])); }, []);
  useEffect(() => { load(); }, [load]);
  if (!days || days.every((d) => d.items.length === 0)) return null;

  const max = Math.max(1, ...days.map((d) => d.totalEffort));
  // Baselined against days that actually have something due (not the whole week) — see server/workload.ts's
  // isPileUp for why a whole-week median would sit at ~0 and never trigger.
  const busy = [...days.map((d) => d.totalEffort)].filter((e) => e > 0).sort((a, b) => a - b);
  const busyMedian = busy[Math.floor(busy.length / 2)];
  const pileUp = (d: WorkloadDay) => d.totalEffort > 0 && (busy.length < 2 ? d.totalEffort >= 3 : d.totalEffort >= busyMedian * 1.6);
  const lightestOther = (excludeDate: string) => {
    const others = days.filter((d) => d.date !== excludeDate);
    if (!others.length) return undefined;
    return others.reduce((a, b) => (b.totalEffort < a.totalEffort ? b : a)).date;
  };
  const dow = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(en ? "en-US" : "fr-FR", { weekday: "short" });
  const dm = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(en ? "en-US" : "fr-FR", { day: "numeric", month: "short" });
  const todayKey = days[0]?.date;

  const moveTask = async (taskId: string, fromDate: string) => {
    const to = lightestOther(fromDate);
    if (!to) return;
    setMoving(taskId);
    try {
      const list = await api.rescheduleTask(taskId, to);
      const updated = list.find((t) => t.id === taskId);
      if (updated) onTask(updated);
      load();
    } catch { /* non-blocking — the widget just won't reflect the move */ }
    setMoving(null);
  };

  return (
    <div className="week-load-wrap">
      <div className="exam-strip-label">{en ? "This week" : "Cette semaine"}</div>
      <div className="week-load-strip">
        {days.map((d) => {
          const isToday = d.date === todayKey;
          const heavy = pileUp(d);
          const open = openDay === d.date;
          return (
            <button
              type="button"
              key={d.date}
              className={`week-day ${heavy ? "heavy" : ""} ${isToday ? "is-today" : ""} ${open ? "open" : ""}`}
              onClick={() => setOpenDay(open ? null : d.date)}
            >
              <span className="week-day-dow">{isToday ? (en ? "Today" : "Aujourd'hui") : dow(d.date)}</span>
              <span className="week-day-bar-track"><span className="week-day-bar" style={{ height: `${Math.max(6, (d.totalEffort / max) * 100)}%` }} /></span>
              <span className="week-day-count">{d.items.length || ""}</span>
            </button>
          );
        })}
      </div>
      {openDay && (() => {
        const d = days.find((x) => x.date === openDay);
        if (!d) return null;
        return (
          <div className="week-day-detail">
            <div className="week-day-detail-head">{dow(d.date)} {dm(d.date)}{pileUp(d) ? <span className="chip chip-attention">{en ? "Heavy day" : "Journée chargée"}</span> : null}</div>
            {d.items.length === 0 ? (
              <p className="muted small">{en ? "Nothing due." : "Rien de prévu."}</p>
            ) : (
              <ul className="week-day-items">
                {[...d.items].sort((a, b) => b.effort - a.effort).map((it, i) => (
                  <li key={i} className="week-day-item">
                    <span className={`week-item-dot week-item-${it.kind}`} />
                    <span className="week-item-title">{it.subject ? <b>{it.subject}: </b> : null}{it.title}</span>
                    {it.movable && it.taskId && (
                      <button type="button" className="btn xs ghost" disabled={moving === it.taskId} onClick={() => void moveTask(it.taskId!, d.date)}>
                        {moving === it.taskId ? "…" : (en ? "Move to lighter day" : "Déplacer sur un jour plus léger")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}
    </div>
  );
}

/** Thorough loading screen while Otto loads/scans — a spinner, a status line, and shimmer rows so the
 *  whole list arrives at once (never a half-populated flash). */
function TaskSkeleton() {
  const widths = ["66%", "52%", "71%", "58%", "63%"];
  return (
    <div className="loading-screen" aria-busy="true" aria-live="polite">
      <div className="loading-head">
        <span className="spinner sm" />
        <span className="loading-msg">Loading your tasks…</span>
      </div>
      <div className="list" aria-hidden="true">
        {widths.map((w, i) => (
          <div key={i} className="card skel">
            <div className="card-main">
              <span className="skel-box skel-pill" />
              <div className="card-text">
                <div className="skel-box skel-line" style={{ width: w }} />
                <div className="skel-box skel-line sm" style={{ width: "34%" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A connect-Gmail call to action — shown on the dashboard until Gmail is linked (via Composio, in Settings). */
function ConnectCard({ status }: { status: ConnectionStatus }) {
  const who = status.name || firstName(status.user);
  const en = status.language === "en";
  return (
    <div className="connect-card">
      <div className="connect-mark"><Logo size={30} /></div>
      <h2>{who ? (en ? `Welcome, ${who}` : `Bienvenue, ${who}`) : (en ? "Welcome to Otto" : "Bienvenue sur Otto")}</h2>
      <p>{en
        ? "Connect your Pronote and Otto gets to work — it turns your homework and tests into a clear plan for today. It never does the exercise for you, and never checks anything off in Pronote without you."
        : "Connecte ton Pronote et Otto se met au travail — il transforme tes devoirs et contrôles en un plan clair pour aujourd'hui. Il ne fait jamais l'exercice à ta place, et ne coche jamais rien dans Pronote sans toi."}</p>
      {!status.aiReady && <div className="warn">{en ? "The server has no DEEPSEEK_API_KEY — task generation is disabled." : "Le serveur n'a pas de DEEPSEEK_API_KEY — la génération de tâches est désactivée."}</div>}
      <a className="btn primary big" href="/settings">{en ? "Connect my Pronote" : "Connecter mon Pronote"}</a>
      <p className="fineprint">{en ? "Disconnect Pronote, or pause Otto, any time in Settings. " : "Déconnecte Pronote, ou mets Otto en pause, à tout moment dans les Réglages. "}<a href="/privacy">{en ? "What Otto reads and why →" : "Ce qu'Otto lit et pourquoi →"}</a></p>
    </div>
  );
}

/** Working-hours + calendar-auto-block controls — shared between Settings and Onboarding so the same
 *  question/UI isn't built twice. Renders bare rows (no wrapping section) so it drops into either
 *  container's own `.set-list`/step markup. `onChanged` receives the fresh profile after each save. */
function PreferencesFields({ profile, onChanged }: { profile: Profile | null; onChanged?: (p: Profile) => void }) {
  const [start, setStart] = useState(profile?.workingHours?.start || "16:00");
  const [end, setEnd] = useState(profile?.workingHours?.end || "19:00");
  const [autoBlock, setAutoBlock] = useState(!!profile?.calendarAutoBlock);
  useEffect(() => {
    setStart(profile?.workingHours?.start || "16:00");
    setEnd(profile?.workingHours?.end || "19:00");
    setAutoBlock(!!profile?.calendarAutoBlock);
  }, [profile?.workingHours?.start, profile?.workingHours?.end, profile?.calendarAutoBlock]);
  const saveHours = async (s: string, e: string) => {
    setStart(s); setEnd(e);
    const timezone = profile?.workingHours?.timezone || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } })();
    onChanged?.(await api.setProfilePreference("workingHours", { start: s, end: e, timezone }));
  };
  const saveAutoBlock = async (v: boolean) => {
    setAutoBlock(v);
    onChanged?.(await api.setProfilePreference("calendarAutoBlock", v));
  };
  const [lang, setLang] = useState<"fr" | "en">(profile?.language === "en" ? "en" : "fr");
  useEffect(() => { setLang(profile?.language === "en" ? "en" : "fr"); }, [profile?.language]);
  const saveLang = async (v: "fr" | "en") => {
    setLang(v);
    onChanged?.(await api.setProfilePreference("language", v));
  };
  return (
    <>
      <div className="set-row">
        <span className="set-text"><b>{lang === "en" ? "Language" : "Langue"}</b><span className="settings-hint">{lang === "en" ? "Switches the interface and everything Otto writes." : "Change l'interface et tout ce qu'Otto écrit."}</span></span>
        <div className="lang-toggle">
          <button type="button" className={`btn xs ${lang === "fr" ? "" : "ghost"}`} onClick={() => void saveLang("fr")}>Français</button>
          <button type="button" className={`btn xs ${lang === "en" ? "" : "ghost"}`} onClick={() => void saveLang("en")}>English</button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-text"><b>{lang === "en" ? "When you work/study" : "Quand tu bosses/révises"}</b><span className="settings-hint">{lang === "en" ? "Otto only proposes study slots inside this window." : "Otto ne propose des créneaux de révision que dans cette plage."}</span></span>
        <div className="pref-hours">
          <input type="time" className="addinput sm" value={start} onChange={(e) => void saveHours(e.target.value, end)} />
          <span>–</span>
          <input type="time" className="addinput sm" value={end} onChange={(e) => void saveHours(start, e.target.value)} />
        </div>
      </div>
      <label className="set-row">
        <span className="set-text"><b>{lang === "en" ? "Block study time on Calendar" : "Bloquer du temps de révision sur Calendar"}</b><span className="settings-hint">{lang === "en" ? "Otto can add a study slot to your Google Calendar to help you plan — never to do the work for you." : "Otto peut créer un créneau de révision dans ton Google Calendar pour t'aider à t'organiser — jamais pour faire le travail à ta place."}</span></span>
        <span className="switch"><input type="checkbox" checked={autoBlock} onChange={(e) => void saveAutoBlock(e.target.checked)} /><span className="switch-track" /></span>
      </label>
    </>
  );
}

/** Self-reported per-subject grades (Pronote's read API doesn't expose grades) — feeds profileBlock() so
 *  Otto weighs a weak subject more heavily than the deadline alone would suggest. Simple add/edit/remove
 *  list, same pattern as ProfileEditor's fact lists. */
function GradesEditor({ profile, onChanged, pronoteConnected }: { profile: Profile | null; onChanged?: (p: Profile) => void; pronoteConnected?: boolean }) {
  const L = useLang();
  const [subject, setSubject] = useState("");
  const [grade, setGrade] = useState("");
  const grades = profile?.grades || [];
  const add = async () => {
    const s = subject.trim();
    const g = Number(grade);
    if (!s || !Number.isFinite(g)) return;
    onChanged?.(await api.setGrade(s, g));
    setSubject(""); setGrade("");
  };
  // No manual "sync" button — Pronote grades pull in automatically (on connect, and again with every
  // daily sweep; see applyPronoteGrades in server/pronote.ts). A passive status line, not a button the
  // student has to remember to press, matches how the rest of Otto works (things just happen for you).
  return (
    <div className="grades-editor">
      {pronoteConnected && grades.length > 0 && (
        <p className="settings-hint grades-sync-note">{L("Synchronisées automatiquement depuis Pronote", "Synced automatically from Pronote")}</p>
      )}
      {grades.length > 0 && (
        <ul className="grade-list">
          {[...grades].sort((a, b) => a.grade / a.scale - b.grade / b.scale).map((g) => {
            const pct = Math.max(0, Math.min(100, (g.grade / g.scale) * 100));
            const tone = isLowGrade(g.grade, g.scale) ? "low" : "";
            return (
              <li key={g.subject} className="grade-row">
                <div className="grade-row-top">
                  <span className="grade-subject">{g.subject}</span>
                  <span className="grade-value">{g.grade}/{g.scale}</span>
                  <button className="x" title={L("Supprimer", "Remove")} onClick={async () => onChanged?.(await api.deleteGrade(g.subject))}>×</button>
                </div>
                <div className="grade-bar"><div className={`grade-bar-fill ${tone}`} style={{ width: `${pct}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="addrow grade-addrow">
        <input className="addinput sm" placeholder={L("Matière (ex : Maths)", "Subject (e.g. Math)")} value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <input className="addinput sm grade-num" type="number" min={0} max={20} placeholder={L("Note /20", "Grade /20")} value={grade} onChange={(e) => setGrade(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <button className="btn" disabled={!subject.trim() || grade === ""} onClick={() => void add()}>{L("Ajouter", "Add")}</button>
      </div>
    </div>
  );
}

/** The landing page (shown logged out at route /) — sharp, crisp positioning as a trusted decision engine. */
/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
function SettingsPage({ status, onSignOut, onChanged }: { status: ConnectionStatus; onSignOut: () => void; onChanged: () => void }) {
  const L = useLang();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string } | null>(null);
  const [showKnows, setShowKnows] = useState(false);
  // Optimistic toggles/selects — flip instantly, reconcile with the server after (no round-trip lag).
  const [paused, setPausedLocal] = useState(status.paused);
  const [genPerDay, setGenPerDay] = useState(Math.min(4, Math.max(1, status.genPerDay || 1)));
  const [dailyBriefingEnabled, setDailyBriefingEnabledLocal] = useState(profile?.dailyBriefingEnabled ?? false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { setGenPerDay(Math.min(4, Math.max(1, status.genPerDay || 1))); }, [status.genPerDay]);
  useEffect(() => { void api.profile().then((p) => { setProfile(p); setDailyBriefingEnabledLocal(p?.dailyBriefingEnabled ?? false); }); void api.usage().then(setUsage).catch(() => {}); }, []);
  const changeGen = (n: number) => { setGenPerDay(n); void api.setProfilePreference("genPerDay", n).then(() => onChanged()); };
  // Month-to-date AI spend vs. the cap — both computed server-side (EUR, approximate; for visibility + the cap).
  const fmtEur = (n: number) => n <= 0 ? "0€" : n < 0.01 ? "< 0,01€" : `${n.toFixed(2).replace(".", ",")}€`;

  return (
    <main className="settings-page">
      <h1 className="settings-title">{L("Réglages", "Settings")}</h1>

      <section className="settings-sec">
        <h3>{L("Compte", "Account")}</h3>
        <div className="modal-row"><span className="lbl">{status.user}{status.cloud ? L(" · synchronisé", " · synced") : ""}</span><button className="btn xs" onClick={() => void onSignOut()}>{L("Se déconnecter", "Sign out")}</button></div>
        {/* French parents care about RGPD more than the AI-spend number itself — show both, but privacy first. */}
        <div className="modal-row"><span className="lbl">{L("Confidentialité", "Privacy")}</span><span className="val">{L("Identifiants Pronote chiffrés (AES-256-GCM), données hébergées en France/UE (Supabase EU), jamais revendues.", "Pronote credentials encrypted (AES-256-GCM), data hosted in France/EU (Supabase EU), never resold.")}</span></div>
        {usage && <div className="modal-row"><span className="lbl">{L("Utilisation IA ce mois-ci", "AI usage this month")}</span><span className="val" title={L(`${usage.runs} exécutions au total`, `${usage.runs} runs total`)}>≈ {fmtEur(usage.monthCostUsd)} {L("sur", "of")} {fmtEur(usage.budgetUsd)}{usage.over ? L(" · plafond atteint", " · cap reached") : ""} · {L("renouvellement", "renews")} {fmtDay(usage.renewsOn)}</span></div>}
        <div className="modal-row"><span className="lbl">{L("Mentions légales", "Legal")}</span><span className="val"><a href="/privacy">{L("Confidentialité", "Privacy")}</a> · <a href="/terms">{L("CGU", "Terms")}</a></span></div>
        {/* GDPR self-serve: download everything stored (Art. 20, portability) and permanently delete it
            (Art. 17, erasure) — no "email us and wait" step for either. */}
        <div className="modal-row">
          <span className="lbl">{L("Tes données", "Your data")}</span>
          <span className="val"><a href={api.exportDataUrl()} download>{L("Télécharger mes données", "Download my data")}</a></span>
        </div>
        <div className="modal-row">
          <span className="lbl">{L("Supprimer le compte", "Delete account")}</span>
          <button
            className="btn xs"
            disabled={deletingAccount}
            onClick={async () => {
              if (!window.confirm(L("Supprimer définitivement ton compte Otto et tout ce qui y est associé — tâches, profil, connexions ? C'est irréversible.", "Permanently delete your Otto account and everything tied to it — tasks, profile, connections? This can't be undone."))) return;
              setDeletingAccount(true);
              try { await api.deleteAccount(); window.location.href = "/"; }
              catch { setDeletingAccount(false); }
            }}
          >{deletingAccount ? L("Suppression…", "Deleting…") : L("Tout supprimer", "Delete everything")}</button>
        </div>
      </section>

      <section className="settings-sec">
        <h3>{L("Sources", "Sources")}</h3>
        {/* Otto Lycée v1: France high-school only, scoped to Pronote + Gmail/Calendar/Drive (GOOGLE_LYCEE_APPS)
            — the rest of Composio (GitHub/Slack/Notion/Linear/…) stays hidden entirely, not just
            de-prioritized. Google is kept (explicit ask) since teachers/clubs still email lycéens directly,
            deadlines land on Calendar, and teachers drop PDFs in Drive — every OTHER extra OAuth step is
            still a dropout, so this isn't reopening the whole Composio grid. */}
        <p className="settings-hint">{L("Otto lit ton Pronote (et ton Gmail/Calendar/Drive si tu les connectes) et prépare le travail — il ", "Otto reads your Pronote (and Gmail/Calendar/Drive if you connect them) and preps the work — it ")}<b>{L("n'envoie et ne rend jamais rien à ta place", "never sends or hands anything in for you")}</b>.</p>
        <PronoteTile />
        <GoogleTiles onChanged={onChanged} />
      </section>

      <section className="settings-sec">
        <h3>{L("Préférences", "Preferences")}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{L("Mettre Otto en pause", "Pause Otto")}</b><span className="settings-hint">{L("Arrête toute l'IA. Tes tâches restent en place.", "Stops all AI activity. Your tasks stay as they are.")}</span></span>
            <span className="switch"><input type="checkbox" checked={paused} onChange={(e) => { const v = e.target.checked; setPausedLocal(v); void api.setPaused(v).then(() => onChanged()); }} /><span className="switch-track" /></span>
          </label>
          <div className="set-row">
            <span className="set-text"><b>{L("Vérifier Pronote", "Check Pronote")}</b><span className="settings-hint">{L("À quelle fréquence Otto regarde ton Pronote chaque jour.", "How often Otto checks your Pronote each day.")}</span></span>
            <div className="seg" role="group" aria-label={L("Vérifications par jour", "Checks per day")}>
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={`seg-btn ${genPerDay === n ? "on" : ""}`} onClick={() => changeGen(n)}>{n}×</button>
              ))}
            </div>
          </div>
          <label className="set-row">
            <span className="set-text"><b>{L("Bilan quotidien", "Daily briefing")}</b><span className="settings-hint">{L("Reçois un email chaque matin avec tes 3 priorités du jour.", "Get an email each morning with your top 3 priorities.")}</span></span>
            <span className="switch"><input type="checkbox" checked={dailyBriefingEnabled} onChange={(e) => { const v = e.target.checked; setDailyBriefingEnabledLocal(v); void api.setDailyBriefing(v).then(() => onChanged()); }} /><span className="switch-track" /></span>
          </label>
          <PreferencesFields profile={profile} onChanged={setProfile} />
        </div>
      </section>

      <section className="settings-sec">
        <h3>{L("Tes notes", "Your grades")}</h3>
        <p className="settings-hint">{L("Aide Otto à voir quelle matière a vraiment besoin d'attention, pas juste ce qui est dû bientôt.", "Helps Otto see which subject actually needs attention, not just what's due soonest.")}</p>
        <GradesEditor profile={profile} onChanged={setProfile} pronoteConnected={status.pronoteConnected} />
      </section>

      <section className="settings-sec">
        <button className="sec-toggle" onClick={() => setShowKnows((v) => !v)}>
          <h3>{L("Ce qu'Otto sait sur toi", "What Otto knows about you")}</h3>
          <span className={`caret ${showKnows ? "open" : ""}`}>›</span>
        </button>
        {showKnows && <><p className="settings-hint">{L("Otto remplit ça au fil du temps. Tu peux tout modifier.", "Otto fills this in over time. You can edit anything.")}</p><ProfileEditor /></>}
      </section>
    </main>
  );
}


/** Pronote (French school portal) — no OAuth exists for it, so this is a credential form instead of a
 *  redirect link. The password is sent once to connect and never stored (see server/pronote.ts); only a
 *  rotating token comes back. Reads homework due dates into the to-do list — nothing is ever written back. */
function PronoteTile({ onChanged }: { onChanged?: () => void } = {}) {
  const L = useLang();
  const [status, setStatus] = useState<{ connected: boolean; username?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<"student" | "parent">("student");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => { try { setStatus(await api.pronoteStatus()); } catch { setStatus({ connected: false }); } }, []);
  useEffect(() => { void load(); }, [load]);

  const connect = async () => {
    if (!url.trim() || !username.trim() || !password) { setErr(L("Renseigne l'URL, l'identifiant et le mot de passe.", "Fill in the URL, username, and password.")); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.connectPronote(url.trim(), username.trim(), password, kind === "parent" ? 7 : 6);
      if (!r.ok) { setErr(r.error || L("Connexion impossible.", "Couldn't connect.")); return; }
      setPassword(""); setOpen(false);
      await load(); onChanged?.();
    } finally { setBusy(false); }
  };
  const disconnect = async () => { setBusy(true); try { await api.disconnectPronote(); await load(); onChanged?.(); } finally { setBusy(false); } };

  if (!status) return null;
  return (
    <div className="int-group">
      <div className="int-grid">
        <div className={`int-tile ${status.connected ? "on" : ""}`}>
          {/* Index Éducation's official PRONOTE logo, via Wikimedia Commons (CC BY-SA 4.0, credited to
              Index Éducation) — self-hosted at public/logos/pronote.png, see public/logos/ATTRIBUTION.md. */}
          <span className="int-logo pronote-logo"><img src="/logos/pronote.png" alt="" loading="lazy" /></span>
          <div className="int-info">
            <div className="int-name">Pronote{status.connected && <span className="int-dot" title={L("Connecté", "Connected")} />}</div>
            <div className="int-blurb">{L(
              "Devoirs et contrôles à venir. Lecture seule — Otto ne coche jamais rien dans Pronote à ta place. Connexion non-officielle (Index Éducation n'a pas d'API publique) — ton mot de passe sert une seule fois puis n'est jamais conservé ; un jeton chiffré le remplace ensuite.",
              "Upcoming homework and tests. Read-only — Otto never checks anything off in Pronote for you. Unofficial connection (Index Éducation has no public API) — your password is used once and never stored; an encrypted token replaces it afterwards."
            )}</div>
          </div>
          {status.connected
            ? <button className="btn xs" disabled={busy} onClick={() => void disconnect()}>{busy ? "…" : L("Déconnecter", "Disconnect")}</button>
            : <button className="btn xs" disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? L("Annuler", "Cancel") : L("Connecter", "Connect")}</button>}
        </div>
      </div>
      {status.connected && <div className="int-accounts"><div className="int-acct"><span className="int-acct-email">{status.username}</span></div></div>}
      {open && !status.connected && (
        <div className="pronote-form">
          <input className="addinput sm" placeholder={L("URL Pronote de ton établissement (ex : https://0000000a.index-education.net/pronote/eleve.html)", "Your school's Pronote URL (e.g. https://0000000a.index-education.net/pronote/eleve.html)")}
            value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          <div className="pronote-form-row">
            <input className="addinput sm" placeholder={L("Identifiant", "Username")} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            <input className="addinput sm" type="password" placeholder={L("Mot de passe", "Password")} value={password}
              onChange={(e) => setPassword(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }} />
          </div>
          <div className="pronote-form-row">
            <div className="seg" role="group" aria-label={L("Type de compte", "Account type")}>
              <button type="button" className={`seg-btn ${kind === "student" ? "on" : ""}`} onClick={() => setKind("student")}>{L("Élève", "Student")}</button>
              <button type="button" className={`seg-btn ${kind === "parent" ? "on" : ""}`} onClick={() => setKind("parent")}>{L("Parent", "Parent")}</button>
            </div>
            <button className="btn primary xs" disabled={busy} onClick={() => void connect()}>{busy ? L("Connexion…", "Connecting…") : L("Connecter", "Connect")}</button>
          </div>
          {err && <div className="autherr">{err}</div>}
        </div>
      )}
    </div>
  );
}

/** Connected accounts for one Google app — one row per account with its address + an individual
 *  Disconnect. Google apps support multiple accounts (perso + a parent's, e.g.). */
function GoogleAppAccounts({ appKey, onChanged }: { appKey: string; onChanged?: () => void }) {
  const L = useLang();
  const [accts, setAccts] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setAccts((await api.integrationAccounts(appKey)).accounts); } catch { setAccts([]); } }, [appKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const on = () => { if (!document.hidden) void load(); }; window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [load]);
  const disc = async (id: string) => { setBusy(id); try { await api.disconnectAccount(appKey, id); await load(); onChanged?.(); } finally { setBusy(""); } };
  if (!accts?.length) return null;
  return (
    <div className="int-accounts">
      {accts.map((a, i) => (
        <div key={a.id} className="int-acct">
          <span className="int-acct-email">{a.email || (accts.length > 1 ? L(`Compte ${i + 1}`, `Account ${i + 1}`) : L("Connecté", "Connected"))}</span>
          <div className="int-acct-actions">
            <button className="btn xs ghost" disabled={busy === a.id} onClick={() => void disc(a.id)}>{busy === a.id ? "…" : L("Déconnecter", "Disconnect")}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Otto Lycée v1 keeps Gmail, Calendar, and Drive — kept alongside Pronote (explicit ask) so teacher/club
// emails, calendar deadlines, and PDFs teachers drop in Drive can still surface as tasks even when Pronote
// itself doesn't have them. Everything else in Composio (GitHub/Slack/Notion/Linear/…) stays hidden.
const GOOGLE_LYCEE_APPS = ["gmail", "googlecalendar", "googledrive"];
const GOOGLE_APP_BLURBS: Record<string, string> = {
  gmail: "Emails de profs, clubs, associations — Otto ne fait qu'y répondre en brouillon, jamais d'envoi automatique.",
  googlecalendar: "Événements et échéances à venir, pour préparer ce qui arrive.",
  googledrive: "Documents partagés par tes profs — pour enrichir les fiches de révision.",
};
const GOOGLE_APP_BLURBS_EN: Record<string, string> = {
  gmail: "Emails from teachers, clubs, associations — Otto only replies as a draft, never sends automatically.",
  googlecalendar: "Upcoming events and deadlines, to prep for what's coming.",
  googledrive: "Documents your teachers shared — to enrich revision guides.",
};

/** Google apps grid, scoped to just Gmail/Calendar/Drive for lycée v1 (see GOOGLE_LYCEE_APPS). */
function GoogleTiles({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<IntegrationItem[] | null | undefined>(undefined); // undefined = loading, null = unavailable
  const load = useCallback(async () => {
    try { const r = await api.integrations(); setItems(r.items.filter((i) => GOOGLE_LYCEE_APPS.includes(i.key))); }
    catch { setItems(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = setTimeout(() => void load(), 1200); return () => clearTimeout(id); }, [load]);
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const L = useLang();
  if (items === undefined) return null;
  if (items === null || !items.length) return <div className="warn">{L("Google n'est pas configuré sur le serveur (COMPOSIO_API_KEY).", "Google isn't configured on the server (COMPOSIO_API_KEY).")}</div>;
  return (
    <div className="int-group">
      {items.map((item) => (
        <div key={item.key} className="int-tile-block">
          <div className="int-grid">
            <div className={`int-tile ${item.connected ? "on" : ""}`}>
              <img className="int-logo" src={item.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              <div className="int-info">
                <div className="int-name">{item.name}{item.connected && <span className="int-dot" title={L("Connecté", "Connected")} />}</div>
                <div className="int-blurb">{L(GOOGLE_APP_BLURBS[item.key] || item.blurb, GOOGLE_APP_BLURBS_EN[item.key] || item.blurb)}</div>
              </div>
              <a className="btn xs" href={`/integrations/${item.key}/connect`} target="_blank" rel="noreferrer">{item.connected ? L("Ajouter un compte ↗", "Add an account ↗") : L("Connecter ↗", "Connect ↗")}</a>
            </div>
          </div>
          {/* The connected account(s) for THIS app, right below its own tile — not lumped together
              after the whole grid, so it's unambiguous which app each account belongs to. */}
          {item.connected && <GoogleAppAccounts appKey={item.key} onChanged={() => { void load(); onChanged?.(); }} />}
        </div>
      ))}
    </div>
  );
}

/** First-run ONBOARDING for a brand-new account — the ONE place Otto is explained. A guided 4-step overlay:
 *  welcome + name → how it works → connect first apps → done. Each connect opens in a new tab; we re-check
 *  on focus so a tile flips to ✓ when the user comes back. Shown once after sign-up; finishing (or "Skip")
 *  clears the otto-onboard flag. */
const OB_STEPS = 6;
/** Otto Lycée v1: onboarding is now just name → what Otto does → connect Pronote (the ONE data source) →
 *  done. The old 3-app OAuth picker (Gmail/Calendar/Drive) is gone — every extra sign-in step is a
 *  dropout for a lycéen without a work Google account, and Pronote's connect flow (URL + identifiants,
 *  handled by PronoteTile) isn't OAuth at all, so it doesn't fit that step's "opens in a new tab" pattern. */
function Onboarding({ onStatus, onDone }: { onStatus: () => void; onDone: () => void }) {
  const L = useLang();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [pronoteConnected, setPronoteConnected] = useState(false);
  const [track, setTrack] = useState<"ib" | "bac" | "other" | undefined>(undefined);
  const saveTrack = async (t: "ib" | "bac" | "other") => {
    setTrack(t);
    try { await api.setProfilePreference("track", t); } catch { /* non-blocking */ }
    setStep(2);
  };
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { /* non-blocking */ } }
    setStep(1);
  };
  const checkPronote = useCallback(async () => { try { const s = await api.pronoteStatus(); setPronoteConnected(s.connected); onStatus(); } catch { /* keep last */ } }, [onStatus]);
  useEffect(() => { void checkPronote(); }, [checkPronote]);

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <button className="onboard-skip" onClick={onDone} aria-label={L("Passer", "Skip")}>{L("Passer", "Skip")}</button>
        <div className="onboard-top">
          <div className="onboard-brand"><Logo size={20} /> <span>Otto</span></div>
          <div className="onboard-progress" aria-hidden="true">
            {Array.from({ length: OB_STEPS }).map((_, d) => <span key={d} className={d <= step ? "on" : ""} />)}
          </div>
        </div>

        {step === 0 && (
          <div className="onboard-step">
            <h2>{L("Bienvenue sur Otto", "Welcome to Otto")}</h2>
            <p className="onboard-lead">{L("Otto lit ton Pronote, transforme tes devoirs et contrôles en un plan clair pour aujourd'hui, et t'aide à démarrer — sans jamais faire le travail à ta place.", "Otto reads your Pronote, turns your homework and tests into a clear plan for today, and helps you get started — never doing the work for you.")}</p>
            <label className="field onboard-name"><span>{L("Comment veux-tu qu'Otto t'appelle ?", "What should Otto call you?")}</span>
              <input className="addinput" placeholder={L("Ton prénom", "Your first name")} value={name} maxLength={60} autoFocus
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
            </label>
            <div className="onboard-actions"><button className="btn primary big" onClick={() => void saveName()}>{L("Commencer", "Get started")}</button></div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-step">
            <h2>{L("Comment Otto t'aide", "How Otto helps")}</h2>
            <p className="onboard-lead">{L("Chaque jour, Otto regarde ton Pronote et transforme tout en 3 choses simples pour aujourd'hui.", "Every day, Otto checks your Pronote and turns everything into 3 simple things for today.")}</p>
            <div className="ob-states">
              <div className="ob-state"><span className="ob-dot done" /><div><b>{L("Fait pour toi", "Done for you")}</b><span>{L("Fiches de révision, checklists, brouillons — jamais l'exercice lui-même.", "Study guides, checklists, drafts — never the exercise itself.")}</span></div></div>
              <div className="ob-state"><span className="ob-dot need" /><div><b>{L("À toi de jouer", "Your turn")}</b><span>{L("Le devoir ou le contrôle, avec un plan pas à pas.", "The assignment or test, with a step-by-step plan.")}</span></div></div>
              <div className="ob-state"><span className="ob-dot check" /><div><b>{L("Terminé", "Done")}</b><span>{L("Coché, plus besoin d'y penser.", "Checked off, no need to think about it again.")}</span></div></div>
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(0)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(2)}>{L("Suivant", "Next")}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-step">
            <h2>{L("Tu es en quelle filière ?", "What track are you on?")}</h2>
            <p className="onboard-lead">{L("Ça aide Otto à mieux comprendre ton emploi du temps — rien de bloquant, modifiable plus tard.", "This helps Otto understand your workload better — nothing is locked in, changeable later.")}</p>
            <div className="ob-states">
              <button type="button" className="ob-state ob-state-btn" onClick={() => void saveTrack("ib")}>
                <span className={`ob-dot ${track === "ib" ? "done" : "need"}`} />
                <div><b>{L("Bac international (IB)", "IB Diploma")}</b><span>{L("6 matières, CAS/EE/TOK.", "6 subjects, CAS/EE/TOK.")}</span></div>
              </button>
              <button type="button" className="ob-state ob-state-btn" onClick={() => void saveTrack("bac")}>
                <span className={`ob-dot ${track === "bac" ? "done" : "need"}`} />
                <div><b>{L("Bac général français", "French national bac")}</b><span>{L("Spécialités, contrôle continu.", "Specialités, continuous assessment.")}</span></div>
              </button>
              <button type="button" className="ob-state ob-state-btn" onClick={() => void saveTrack("other")}>
                <span className={`ob-dot ${track === "other" ? "done" : "need"}`} />
                <div><b>{L("Autre / pas sûr", "Other / not sure")}</b><span>{L("Pas grave, Otto s'adapte.", "That's fine, Otto adapts.")}</span></div>
              </button>
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(1)}>{L("Retour", "Back")}</button>
              <button className="btn ghost" onClick={() => setStep(3)}>{L("Passer", "Skip")}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step">
            <h2>{L("Connecte ton Pronote", "Connect your Pronote")}</h2>
            <p className="onboard-lead">{L("C'est la seule chose qu'Otto lit pour préparer ton plan. Tes identifiants sont chiffrés (AES-256-GCM) et jamais revendus.", "This is the one thing Otto reads to prep your plan. Your credentials are encrypted (AES-256-GCM) and never resold.")}</p>
            <div className="onboard-apps">
              <PronoteTile onChanged={() => void checkPronote()} />
            </div>
            <p className="muted small">{L("Tu peux te connecter plus tard depuis les Réglages.", "You can connect later from Settings.")}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(2)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(4)}>{pronoteConnected ? L("Continuer — connecté ✓", "Continue — connected ✓") : L("Plus tard", "Later")}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboard-step">
            <h2>{L("Tes préférences", "Your preferences")}</h2>
            <p className="onboard-lead">{L("Ça aide Otto à proposer des créneaux de révision au bon moment — modifiable à tout moment dans les Réglages.", "This helps Otto propose study slots at the right time — changeable any time in Settings.")}</p>
            <div className="set-list onboard-prefs">
              <PreferencesFields profile={null} />
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(3)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(5)}>{L("Suivant", "Next")}</button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="onboard-step onboard-done">
            <div className="onboard-done-mark"><Logo size={30} /></div>
            <h2>{L("C'est prêt", "You're all set")}{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}</h2>
            <p className="onboard-lead">{pronoteConnected ? L("Otto se met au travail. Ton plan du jour arrive.", "Otto is getting to work. Your plan for today is on its way.") : L("Connecte ton Pronote quand tu veux depuis les Réglages, et Otto se met au travail.", "Connect your Pronote any time from Settings, and Otto gets to work.")}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>{L("Voir mes tâches", "See my tasks")}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
function LoginPage({ status, onDone, initialMode }: { status: ConnectionStatus; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" }) {
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !pw) return;
    setBusy(true); setErr("");
    try {
      const r = mode === "signup" ? await api.signup(email.trim(), pw) : await api.login(email.trim(), pw);
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || "Something went wrong.");
    } catch {
      setErr("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <header className="landing-nav"><a className="brand" href="/"><Logo size={20} /> Otto</a></header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="login-sub">{mode === "signup" ? "Two fields and you're in — connect Google next." : "Log in to pick up where Otto left off."}</p>
          {!status.cloud && <div className="warn">Accounts need Supabase configured on the server.</div>}
          <label className="field"><span>Email</span>
            <input className="addinput" type="email" autoComplete="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>Password</span>
            <input className="addinput" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="At least 6 characters" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          {err && <div className="autherr">{err}</div>}
          <button className="btn primary big" disabled={busy || !email.trim() || !pw} onClick={() => void submit()}>{busy ? "…" : mode === "signup" ? "Create account" : "Log in"}</button>
          <button className="btn ghost" onClick={() => { setMode((m) => (m === "signup" ? "login" : "signup")); setErr(""); }}>
            {mode === "signup" ? "Have an account? Log in" : "New here? Create an account"}
          </button>
          <a className="login-back" href="/">← Back to home</a>
          <div className="login-legal">By continuing you agree to our <a href="/terms">Terms</a> & <a href="/privacy">Privacy Policy</a>.</div>
        </div>
      </main>
    </div>
  );
}

/** A real, clickable 3-step demo on the landing page — not a video (nothing to record/host), a static
 *  mock built from the SAME card/chip/step classes the real app uses, so the shape you see here is the
 *  shape you'll actually get, just with canned data instead of your real inbox. Purely local state —
 *  no network calls, safe for a signed-out visitor. */
function Walkthrough() {
  const STAGES = [
    { n: "01", label: "Lit ton Pronote" },
    { n: "02", label: "Prépare le travail" },
    { n: "03", label: "Tu fais le reste" },
  ] as const;
  const [stage, setStage] = useState(0);
  const [done, setDone] = useState(false);
  const go = (i: number) => { setStage(i); if (i !== 2) setDone(false); };

  return (
    <div className="walkthrough">
      <div className="walk-tabs" role="tablist">
        {STAGES.map((s, i) => (
          <button key={i} type="button" role="tab" aria-selected={stage === i}
            className={`walk-tab ${stage === i ? "active" : ""}`} onClick={() => go(i)}>
            <span className="walk-tab-n">{s.n}</span> {s.label}
          </button>
        ))}
      </div>

      <div className="walk-panel">
        {stage === 0 && (
          <div className="walk-scan">
            <div className="walk-row"><span className="chip chip-muted">Maths</span><span className="walk-row-text">Contrôle vendredi — chapitre sur les suites</span><span className="walk-check">✓ lu</span></div>
            <div className="walk-row"><span className="chip chip-muted">Physique</span><span className="walk-row-text">DM à rendre lundi — mécanique</span><span className="walk-check">✓ lu</span></div>
            <div className="walk-row"><span className="chip chip-muted">Philo</span><span className="walk-row-text">Dissertation sur la conscience — rendu dans 10 jours</span><span className="walk-check">✓ lu</span></div>
            <p className="walk-caption">Otto lit ton Pronote et ne garde que ce qui compte vraiment pour aujourd'hui — le reste attend son tour.</p>
          </div>
        )}
        {stage === 1 && (
          <div className="walk-card">
            <div className="card-title">Réviser le contrôle de Maths de vendredi</div>
            <div className="card-badges"><span className="chip chip-muted">Pronote</span><span className="chip chip-bad">Urgent</span></div>
            <h4 className="walk-h">Contexte <span className="chip chip-muted context-source">Pronote</span></h4>
            <p className="context-text">Contrôle vendredi sur les suites numériques (chapitre 4). Ton dernier contrôle sur ce chapitre datait d'il y a 3 semaines.</p>
            <h4 className="walk-h">Ce qu'Otto a préparé</h4>
            <ul className="bullets"><li>Fiche de révision : définitions, formules, 3 méthodes types</li></ul>
            <p className="walk-caption">La fiche est prête à consulter — à toi de réviser avec.</p>
          </div>
        )}
        {stage === 2 && (
          <div className="walk-card">
            <p className="walk-draft-body">1. Relire le cours p.42 (10 min)<br/>2. Faire l'exercice 3 (15 min)<br/>3. Vérifier la correction (5 min)</p>
            {!done ? (
              <button className="btn primary send-btn" onClick={() => setDone(true)}>Marquer comme fait</button>
            ) : (
              <button className="btn primary send-btn sent" disabled>Fait ✓</button>
            )}
            <p className="walk-caption">{done ? "C'est toi qui coches, jamais Otto." : "Otto te guide étape par étape — c'est toi qui fais le travail."}</p>
          </div>
        )}
      </div>

      <div className="walk-nav">
        <button className="btn ghost" disabled={stage === 0} onClick={() => go(stage - 1)}>← Retour</button>
        <button className="btn ghost" disabled={stage === STAGES.length - 1} onClick={() => go(stage + 1)}>Suivant →</button>
      </div>
    </div>
  );
}

/** Marketing landing (signed out, route /). CTAs route to the dedicated login / sign-up page. */
function Landing() {
  const DRAFT = "1. Relire le cours p.42 (10 min) 2. Faire l'exercice 3 (15 min) 3. Vérifier la correction (5 min)";
  const [typed, setTyped] = useState("");
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Scroll-reveal: each .reveal element animates in the first time it enters the viewport.
  useEffect(() => {
    if (reduced) { document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [reduced]);

  // Live typewriter in the hero demo — types the draft out, then holds. (Full text immediately if reduced-motion.)
  useEffect(() => {
    if (reduced) { setTyped(DRAFT); return; }
    let i = 0; const start = setTimeout(function tick() {
      i++; setTyped(DRAFT.slice(0, i));
      if (i < DRAFT.length) setTimeout(tick, 26 + (DRAFT[i] === " " ? 40 : 0));
    }, 900);
    return () => clearTimeout(start);
  }, [reduced]);

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="brand"><Logo size={22} /> Otto</span>
        <nav className="landing-navlinks">
          <a className="btn ghost" href="/login">Se connecter</a>
          <a className="btn primary" href="/signup">Commencer</a>
        </nav>
      </header>

      <main className="hero">
        <h1 className="hero-title hero-in" style={{ ["--d" as any]: "0.05s" }}>Ton Pronote, transformé en plan du jour.</h1>
        <p className="hero-sub hero-in" style={{ ["--d" as any]: "0.15s" }}>Dimanche 19h, 11 devoirs et 2 contrôles sur Pronote — panique. Otto lit ton Pronote et transforme tout ça en 3 tâches claires pour aujourd'hui, avec un temps estimé et un point de départ. Jamais l'exercice à ta place.</p>
        <div className="hero-cta hero-in" style={{ ["--d" as any]: "0.25s" }}>
          <a className="btn primary big" href="/signup">Connecter mon Pronote</a>
          <a className="btn ghost" href="/login">Se connecter</a>
        </div>
        <div className="fineprint hero-in" style={{ ["--d" as any]: "0.32s" }}>Otto ne fait jamais tes devoirs à ta place — il t'aide à t'y mettre.</div>
        {/* One product visual: a Pronote-wall-of-devoirs → 3-card plan, not a Gmail draft. */}
        <div className="hero-demo hero-in" style={{ ["--d" as any]: "0.42s" }} aria-hidden="true">
          <div className="hero-demo-label"><span className="live-dot" /> Exemple — ton plan du jour</div>
          <div className="demo-window">
            <div className="demo-titlebar"><span /><span /><span /></div>
            <div className="demo-body">
              <p className="demo-line"><b>Maths</b> — Contrôle vendredi <span className="demo-badge">⏱ 35 min</span></p>
              <p className="demo-line gap">{typed}<span className="demo-caret" /></p>
              <p className="demo-line"><b>Physique</b> — DM à rendre lundi</p>
              <p className="demo-line"><b>Philo</b> — Fiche de révision prête</p>
            </div>
          </div>
        </div>
      </main>

      <section className="landing-sec">
        <h2 className="reveal">Ce qu'Otto prépare pour toi</h2>
        <div className="outcomes">
          <div className="outcome reveal" style={{ ["--d" as any]: "0.0s" }}><span className="outcome-mark">✓</span><div><h3>Fiche de révision</h3><p>Plan, définitions, formules — à partir de l'énoncé et de tes documents Drive.</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.1s" }}><span className="outcome-mark">✓</span><div><h3>Checklist étape par étape</h3><p>"1. Relire le cours p.42 (10 min) 2. Faire l'exercice 3 (15 min) 3. Vérifier la correction (5 min)."</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.2s" }}><span className="outcome-mark">✓</span><div><h3>Jamais l'exercice fait à ta place</h3><p>Pas de dissertation rédigée, pas d'exercice corrigé, pas de réponse de contrôle. Otto te guide, jamais ne fait le travail noté.</p></div></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">Comment ça marche</h2>
        <p className="lead reveal">Connecte ton Pronote une fois. Otto surveille tes devoirs et contrôles, et prépare le travail avant que tu paniques. Clique pour voir les étapes.</p>
        <Walkthrough />
      </section>

      <section className="landing-sec">
        <h2 className="reveal">Pensé pour être fiable</h2>
        <div className="features">
          <div className="feature reveal" style={{ ["--d" as any]: "0.0s" }}><div><h3>Jamais ton travail à ta place</h3><p>Otto prépare fiches, checklists et brouillons — jamais l'essai, l'exercice ou la réponse au contrôle.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.1s" }}><div><h3>Identifiants chiffrés, données en France/UE</h3><p>Ton mot de passe Pronote sert une seule fois puis n'est jamais conservé (AES-256-GCM). Hébergement Supabase EU. Jamais revendu.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.2s" }}><div><h3>Plafond de coût visible</h3><p>Coût de l'IA plafonné et affiché dans les Réglages — pas de surprise.</p></div></div>
        </div>
      </section>

      <section className="cta-band reveal">
        <h2>Arrête de paniquer devant Pronote.</h2>
        <p>Connecte ton Pronote et laisse Otto préparer le travail — à toi de faire le reste. Gratuit pour commencer, prêt en moins d'une minute.</p>
        <a className="btn big cta-band-btn" href="/signup">Connecter mon Pronote</a>
        <div className="cta-fine">Sans carte bancaire · Otto ne fait jamais tes devoirs à ta place</div>
      </section>

      <div className="landing-foot">
        <div>Chaque dimanche soir, Otto a déjà lu Pronote pour toi.</div>
        <nav className="foot-links"><a href="/privacy">Confidentialité</a><a href="/terms">CGU</a><span className="foot-mit">MIT — open source</span></nav>
      </div>
    </div>
  );
}

// ── Legal pages (public) ──────────────────────────────────────────────────────
// An accurate privacy policy is required for Google's OAuth verification (Gmail/Calendar/Drive are
// sensitive/restricted scopes) and is basic legal table-stakes for publishing.
const LEGAL_ENTITY = "Willem Tjong";
const LEGAL_EMAIL = "tjong.willem@gmail.com";
const LEGAL_JURISDICTION = "France";
const LEGAL_UPDATED = "July 30, 2026";

function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  return (
    <div className="landing legal-page">
      <header className="landing-nav">
        <a className="brand" href="/"><Logo size={22} /> Otto</a>
        <nav className="landing-navlinks">
          <a className="btn ghost" href="/privacy">Privacy</a>
          <a className="btn ghost" href="/terms">Terms</a>
        </nav>
      </header>
      <main className="legal">
        {kind === "privacy" ? <PrivacyBody /> : <TermsBody />}
        <p className="legal-meta">Last updated: {LEGAL_UPDATED} · Operated by {LEGAL_ENTITY} · Contact: {LEGAL_EMAIL}</p>
        <a className="legal-back" href="/">← Back to Otto</a>
      </main>
    </div>
  );
}

function PrivacyBody() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Otto ("we", "us") is a to-do assistant that reads the apps you connect and prepares work for you. This policy explains what we access, why, and your choices. Otto is operated by {LEGAL_ENTITY}.</p>

      <h2>What we access</h2>
      <p>Only the apps you explicitly connect, and only to do the work you asked for:</p>
      <ul>
        <li><b>Gmail</b> — to read recent threads and prepare draft replies. Otto creates drafts; it never sends, deletes, or modifies mail on its own.</li>
        <li><b>Google Calendar</b> — to read events and prepare drafts of new events for your review.</li>
        <li><b>Google Drive / Docs / Sheets / Slides</b> — to read relevant files and create documents it makes for you. Otto only ever edits a document it created itself — it never modifies a file that's already yours.</li>
        <li><b>Pronote</b> (optional, unofficial — no official Pronote API exists) — read-only, to see homework due dates. Otto never writes anything back to Pronote.</li>
        <li><b>Other integrations you connect</b> — accessed only for the tasks they relate to.</li>
      </ul>
      <p>Otto performs <b>reversible</b> work autonomously (drafts, documents, research). Anything irreversible — sending an email, posting, inviting, deleting, or paying — is <b>never</b> done without your explicit confirmation. It also never edits a document, sheet, or slide deck that it didn't create — only your own files, never Otto's.</p>

      <h2>What we store</h2>
      <ul>
        <li>Your account email and a securely hashed password (we never store your password in plain text).</li>
        <li>The tasks Otto generates and a profile of facts it learns to do better work (people, projects, preferences) — you can view and delete these any time in Settings.</li>
        <li>Approximate AI-usage counts for showing your monthly usage.</li>
      </ul>
      <p>We do not sell your data, use it for advertising, or use your content to train foundation models.</p>

      <h2>Service providers</h2>
      <p>Otto shares data with the processors needed to run the service, under their terms:</p>
      <ul>
        <li><b>Composio</b> — brokers the OAuth connections to your apps and executes read/write actions on your behalf.</li>
        <li><b>DeepSeek</b> — the AI model that reads context and drafts the work. Relevant content is sent to generate each task/draft.</li>
        <li><b>Supabase</b> — stores your account, tasks, and profile.</li>
        <li>Hosting/infrastructure providers that run the app.</li>
      </ul>

      <h2>Retention & deletion</h2>
      <p>Your data is kept only while your account is active — nothing is kept "just in case" after that. You're in control, with no email-and-wait required: clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time (revokes Otto's access immediately), download everything stored about you via Settings → "Download my data", or permanently delete your account and everything with it via Settings → "Delete everything" — instant, self-serve, and irreversible.</p>

      <h2>Security</h2>
      <p>Google and other OAuth-based connections mean we never see your app passwords. Pronote is the one exception — it has no OAuth, so its username/password pass through our server once to connect; the password itself is never stored or logged, only a rotating token Pronote issues in its place. Data is transmitted over HTTPS and access is scoped to your account. No system is perfectly secure, but we take reasonable measures to protect your information.</p>

      <h2>Google API disclosure</h2>
      <p>Otto's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

      <h2>Your rights (GDPR)</h2>
      <p>If you're in the EU/EEA, GDPR gives you the right to access, correct, export (portability), or delete (erasure) your data, and to object to or restrict how it's processed. The first three are self-serve in Settings, right now, with no request needed; for anything else, or if you're elsewhere and want the same, contact {LEGAL_EMAIL} and we'll handle it directly. Our legal basis for processing is performing the service you asked for (contract) plus our legitimate interest in making Otto work well for you.</p>

      <h2>International transfers</h2>
      <p>Your data is processed by providers based outside {LEGAL_JURISDICTION} (including the US and elsewhere) — Composio, DeepSeek, Supabase, and our hosting provider. We only use providers that commit contractually to protecting your data (e.g. standard contractual clauses where applicable) to the standard GDPR requires.</p>

      <h2>Age</h2>
      <p>Otto is built with students in mind, but opening an account requires being old enough to consent to data processing on your own (15 in {LEGAL_JURISDICTION}); younger than that, a parent or guardian should set it up and stay involved.</p>

      <h2>Changes & contact</h2>
      <p>We'll update this policy as the service evolves and note the date above. Questions or anything not covered here: {LEGAL_EMAIL}.</p>
    </>
  );
}

function TermsBody() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p>By using Otto, operated by {LEGAL_ENTITY}, you agree to these terms.</p>

      <h2>The service</h2>
      <p>Otto reads the apps you connect and prepares work — drafts, documents, and organized tasks. It performs reversible actions autonomously and asks for your confirmation before anything irreversible (sending, posting, inviting, deleting, paying). You are responsible for reviewing anything Otto prepares before you act on it.</p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Keep your account credentials secure and provide accurate information.</li>
        <li>Only connect accounts you are authorized to use.</li>
        <li>Use Otto lawfully and not to send spam, harass, or violate others' rights or the connected apps' terms.</li>
      </ul>

      <h2>AI-generated content — review everything</h2>
      <p>Otto uses AI, which can be inaccurate, incomplete, or wrong. Every draft, document, and suggestion is a starting point that <b>you must review and verify</b> before sending, saving, or relying on it. You are solely responsible for anything you choose to send, publish, or act upon. Otto only prepares reversible work and asks for your confirmation before anything irreversible; the decision — and its consequences — are yours.</p>

      <h2>No warranty</h2>
      <p>The service is provided "as is" and "as available", without warranties of any kind, whether express, implied, or statutory — including any implied warranties of merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not warrant that Otto will be uninterrupted, error-free, secure, or that its output will be correct or suitable for any purpose. You use it at your own risk.</p>

      <h2>Limitation of liability</h2>
      <p>To the fullest extent permitted by applicable law, {LEGAL_ENTITY} and anyone involved in providing Otto shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, nor for any loss of data, profits, revenue, goodwill, missed communications, mistaken sends, or business interruption, arising out of or relating to your use of (or inability to use) Otto or anything it prepares or does — even if advised of the possibility. To the fullest extent permitted by law, our total aggregate liability for all claims relating to the service will not exceed the greater of the amount you paid us in the 12 months before the claim, or €50. Nothing in these terms excludes liability that cannot be excluded under applicable law.</p>

      <h2>Your data & your responsibility</h2>
      <p>You are responsible for the accounts and content you connect and for ensuring you have the right to do so. You act as the controller of the personal data in your connected accounts; Otto processes it only to provide the service, as described in the Privacy Policy. You agree to indemnify and hold {LEGAL_ENTITY} harmless from any claims, losses, or expenses arising from your use of Otto, your content, or your breach of these terms or of any third party's rights or terms.</p>

      <h2>Availability & changes</h2>
      <p>Otto is an independent tool and is not endorsed by or affiliated with Google, or any other integrated provider. We may change, suspend, limit (including via a monthly AI budget), or discontinue any part of the service at any time without liability.</p>

      <h2>Termination</h2>
      <p>You may stop using Otto and delete your account at any time. We may suspend or terminate accounts that violate these terms or that create risk or legal exposure.</p>

      <h2>Governing law & contact</h2>
      <p>These terms are governed by the laws of {LEGAL_JURISDICTION}, without regard to conflict-of-laws rules, and the courts of {LEGAL_JURISDICTION} have jurisdiction, except where mandatory local consumer law provides otherwise. If any provision is held unenforceable, the rest remains in effect. Questions: {LEGAL_EMAIL}.</p>
    </>
  );
}


/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Otto fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const L = useLang();
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => { void api.profile().then(setP).catch(() => setP(null)); }, []);
  if (!p) return <p className="muted small">{L("Chargement…", "Loading…")}</p>;
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length + p.courses.length;
  const lists = [
    { key: "preference" as const, label: L("Préférences", "Preferences"), items: p.preferences },
    { key: "person" as const, label: L("Personnes", "People"), items: p.people },
    { key: "project" as const, label: L("Projets", "Projects"), items: p.projects },
    { key: "course" as const, label: L("Cours", "Courses"), items: p.courses },
  ];
  return (
    <div className="memory-body">
      <NameRow name={p.name || ""} onSave={async (v) => setP(await api.setProfile("name", v))} />
      <AboutRow about={p.about} onSave={async (v) => setP(await api.setProfile("about", v))} />
      {lists.map((l) => (
        <div className="prof-group" key={l.key}>
          <div className="prof-label">{l.label}</div>
          <ul className="memory-list">
            {l.items.map((it, i) => (
              <li key={i}><span>{it}</span><button className="x" title={L("Supprimer", "Remove")} onClick={async () => setP(await api.delProfile(l.key, i))}>×</button></li>
            ))}
          </ul>
          <AddRow placeholder={L(`Ajouter : ${l.label.toLowerCase().replace(/s$/, "")}…`, `Add a ${l.label.toLowerCase().replace(/s$/, "")}…`)} onAdd={async (v) => setP(await api.setProfile(l.key, v))} />
        </div>
      ))}
      {count === 0
        ? <div className="muted small">{L("Vide pour l'instant — Otto le remplit au fil du travail, ou ajoute ton nom, une description, tes préférences, personnes et projets ici.", "Empty for now — Otto fills this in as it works, or add your name, about, preferences, people and projects here.")}</div>
        : <div className="forget-row">
            <button
              className="btn xs forget"
              onClick={async () => { if (window.confirm(L("Oublier tout ce qu'Otto a appris sur toi ? Ça efface ta description, préférences, personnes et projets, sans retour en arrière possible.", "Forget everything Otto has learned about you? This clears your About, preferences, people and projects, and can't be undone."))) setP(await api.clearProfile()); }}
            >{L("Tout oublier", "Forget everything")}</button>
            <span className="muted small">{L("Efface la mémoire d'Otto — il repart de zéro et te réapprend au fil du travail.", "Wipes Otto's memory — it starts from zero and learns you again as it works.")}</span>
          </div>}
    </div>
  );
}

function NameRow({ name, onSave }: { name: string; onSave: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState(name);
  useEffect(() => { setText(name); }, [name]);
  return (
    <div className="prof-group">
      <div className="prof-label">{L("Nom", "Name")}</div>
      <div className="addrow">
        <input className="addinput sm" placeholder={L("Comment Otto doit-il t'appeler ?", "What should Otto call you?")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === name.trim()} onClick={() => void onSave(text.trim())}>{L("Enregistrer", "Save")}</button>
      </div>
    </div>
  );
}

function AboutRow({ about, onSave }: { about: string; onSave: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState(about);
  useEffect(() => { setText(about); }, [about]);
  return (
    <div className="prof-group">
      <div className="prof-label">{L("À propos de toi", "About you")}</div>
      <div className="addrow">
        <input className="addinput sm" placeholder={L("Une ligne : qui tu es / comment tu travailles", "One line: who you are / how you work")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === about.trim()} onClick={() => void onSave(text.trim())}>{L("Enregistrer", "Save")}</button>
      </div>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => Promise<void> }) {
  const L = useLang();
  const [text, setText] = useState("");
  const go = async () => { const v = text.trim(); if (!v) return; await onAdd(v); setText(""); };
  return (
    <div className="addrow">
      <input className="addinput sm" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="btn" disabled={!text.trim()} onClick={() => void go()}>{L("Ajouter", "Add")}</button>
    </div>
  );
}

function AddTask({ onAdded }: { onAdded: Dispatch<SetStateAction<WebTask[]>> }) {
  const L = useLang();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Optional explicit date — the "personal commitment" capture path (a job shift, a club meeting, an
  // appointment): a real date attached right here beats waiting on the AI to maybe infer one from vague
  // phrasing, and it's the lowest-friction way to get something that isn't from a connected app onto the
  // same list as everything else. Collapsed by default so it never adds weight to the common case of just
  // typing a quick task.
  const [showWhen, setShowWhen] = useState(false);
  const [when, setWhen] = useState("");
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setText("");
    const whenToSend = when;
    setShowWhen(false); setWhen("");
    // Show it in the list RIGHT AWAY instead of waiting on the round-trip — which includes a blocking AI
    // refinement call server-side and can take a couple seconds. A real "Add" should feel instant, like
    // any to-do list. The server's actual response (refined title, possibly auto-queued) replaces this
    // stub the moment it lands; a failure rolls the stub back and returns your text so nothing is lost.
    const stubId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stub: WebTask = {
      id: stubId, title: v, why: L("Ajouté par toi", "Added by you"), when: whenToSend || undefined, source: "manual", risk: "low",
      urgency: 0.5, importance: 0.5, quadrant: "do", score: 1,
      status: "ready", createdAt: new Date().toISOString(), unrefined: true,
    };
    onAdded((prev) => [stub, ...prev]);
    try {
      const fresh = await api.add(v, whenToSend || undefined);
      // Defensive: a 401 (session expired) resolves instead of throwing (see api.ts's j()), returning the
      // error BODY where an array was expected. Setting `tasks` state to that non-array object crashed the
      // whole app on the next render — which, from the outside, looked exactly like the new task vanishing.
      if (!Array.isArray(fresh)) throw new Error("not logged in");
      onAdded(fresh);
    } catch { onAdded((prev) => prev.filter((t) => t.id !== stubId)); setText(v); setWhen(whenToSend); }
    finally { setBusy(false); }
  };
  return (
    <div className="add-task-row">
      <span className="add-plus" aria-hidden="true">+</span>
      <input
        className="add-task-input"
        placeholder={L("Ajouter un devoir, une révision, un rendez-vous…", "Add homework, revision, an appointment…")}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      {showWhen ? (
        <input
          className="addinput sm add-task-when"
          type="date"
          value={when}
          disabled={busy}
          onChange={(e) => setWhen(e.target.value)}
          title={L("Date d'échéance", "When this is due")}
        />
      ) : (
        <button type="button" className="btn xs ghost add-when-toggle" disabled={busy} onClick={() => setShowWhen(true)}>{L("+ date", "+ date")}</button>
      )}
      {text.trim() && <button className="btn xs primary" disabled={busy} onClick={() => void submit()}>{busy ? L("Ajout…", "Adding…") : L("Ajouter", "Add")}</button>}
    </div>
  );
}

function Card({ task, open, onToggle, onChange, onTask, retrying, onConfirmed, onNotify, inModal, isNew }: { task: WebTask; open: boolean; onToggle: () => void; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void; retrying?: boolean; onConfirmed?: (id: string) => void; onNotify?: (msg: string, kind?: "info" | "error") => void; inModal?: boolean; isNew?: boolean }) {
  const L = useLang();
  const cardEn = useContext(LangContext) === "en";
  const [running, setRunning] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<number, string>>({}); // what the user typed for a manual step
  const [sending, setSending] = useState<number | null>(null); // which sendable is being sent
  const [viewDraft, setViewDraft] = useState<number | null>(null); // which sendable's draft is expanded for review
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null); // which sendable is awaiting send confirmation
  const [changeIdx, setChangeIdx] = useState<number | null>(null);   // which sendable's "what to change" box is open
  const [changeText, setChangeText] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  // Manual edits to a draft's own text — separate from changeText (that's a PROMPT for Otto to rewrite it;
  // this is the user directly typing the replacement). Keyed by sendable index; only the open one is edited.
  const [draftEdits, setDraftEdits] = useState<Record<number, { subject?: string; body?: string }>>({});
  const [savingDraft, setSavingDraft] = useState<number | null>(null);
  const saveDraftEdit = async (i: number) => {
    const edit = draftEdits[i];
    if (!edit || savingDraft != null) return;
    // The textarea is generically bound to "body" client-side; Slack has no subject and stores its
    // message under "text" server-side — map to whichever field this sendable's app actually uses.
    const patch = task.sendables?.[i]?.app === "slack" ? { text: edit.body } : { subject: edit.subject, body: edit.body };
    setSavingDraft(i);
    try { onTask(await api.editDraft(task.id, i, patch)); setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; }); }
    catch { /* edit stays pending — the box keeps the user's text so nothing is lost */ }
    finally { setSavingDraft(null); }
  };
  // Context + audit trail live in ONE collapsible section: both answer the same underlying question
  // ("why am I seeing this / what actually happened"), so splitting them into two separately-toggled
  // blocks just made the card longer for no benefit. Collapsed by default; history is fetched on first
  // expand rather than always-on, since it's for the moment someone asks, not every render.
  const [contextOpen, setContextOpen] = useState(false);
  const [history, setHistory] = useState<{ kind: string; message?: string; at: string }[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const toggleContext = async () => {
    if (contextOpen) { setContextOpen(false); return; }
    setContextOpen(true);
    if (history) return;
    setHistoryLoading(true);
    try { setHistory(await api.taskEvents(task.id)); }
    catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  };
  // Per-task coaching chat — a thread scoped to THIS task so the student can ask for help without
  // re-explaining their situation. Starts from whatever's already saved on the task (persists across opens).
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: "nearest" }); }, [task.chat?.length, chatSending]);
  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || chatSending) return;
    setChatInput(""); setChatSending(true); setChatError(null);
    try { const { chat } = await api.chat(task.id, message); onTask({ ...task, chat }); }
    catch (e: any) { setChatError(e?.message || L("Envoi impossible — réessaie.", "Couldn't send that — try again.")); setChatInput(message); }
    finally { setChatSending(false); }
  };
  const [leaving, setLeaving] = useState(false);
  const [leaveKind, setLeaveKind] = useState<"confirm" | "dismiss">("dismiss");
  const act = async (fn: () => Promise<WebTask[]>) => { onChange(await fn()); };
  // Confirm ("Looks good") gets a distinct green check-pulse (a small reward for finishing something);
  // Dismiss keeps the plain slide-away — different actions, so they shouldn't look identical. Both play
  // WHILE the API call runs, then remove the card, so it never blinks out or lingers waiting on the network.
  const leave = async (fn: () => Promise<WebTask[]>, kind: "confirm" | "dismiss" = "dismiss") => {
    if (leaving) return;
    setLeaveKind(kind);
    setLeaving(true);
    // Must match (or slightly exceed) the CSS animation durations (cardConfirm 0.55s / cardOut 0.32s in
    // styles.css) — the row is removed from state the instant this resolves, so if the timers were shorter
    // than the animation, React would unmount mid-collapse and cut it off abruptly (the exact jank this is
    // meant to avoid). Confirm holds a beat longer so the check-pulse reads before it slides away.
    const holdMs = kind === "confirm" ? 550 : 320;
    const [list] = await Promise.all([fn(), new Promise((r) => setTimeout(r, holdMs))]);
    if (kind === "confirm") onConfirmed?.(task.id); // flags the row it lands on in "Completed" for a beat, so
    // finishing something has a visible destination instead of just vanishing from the list.
    onChange(list);
  };
  // Mark a manual step done, recording what the user decided (so dependent auto-steps can use it).
  const markStepDone = (i: number) => act(() => api.stepDone(task.id, i, true, (decided[i] || "").trim() || undefined));
  const run = async (reset?: boolean) => {
    setRunning(true);
    try { onTask(await api.run(task.id, reset)); }
    // A run rejection (paused / over-budget / rate-limited / still-running-elsewhere / a server error) never
    // touched the task before, so it failed silently. Surface it — the card also reflects any failed state.
    catch (e: any) { onNotify?.(e?.message || L("Impossible de lancer cette tâche — réessaie.", "Couldn't run this task — try again."), "error"); }
    finally { setRunning(false); }
  };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    // A failed send used to be swallowed entirely — the button just reset and the user had no idea whether
    // their email/message went out. For an irreversible action that's the worst possible silence: surface it.
    try { onTask(await api.sendDraft(task.id, i)); }
    catch (e: any) { onNotify?.(e?.message || L("Envoi impossible — rien n'a été envoyé. Réessaie.", "Couldn't send — nothing was sent. Try again."), "error"); }
    finally { setSending(null); }
  };
  // The user declined and said what to change → re-run the task with that note so Otto revises the draft.
  const doRevise = async () => {
    const note = changeText.trim();
    if (!note || revising) return;
    setRevising(true); setReviseError(null);
    // The re-draft replaces the sendables list, so clear any open draft preview (its index may now be stale).
    try { onTask(await api.revise(task.id, note)); setChangeIdx(null); setChangeText(""); setViewDraft(null); }
    // Was previously swallowed silently ("surfaced via task state" — it wasn't: a paused/over-budget/
    // rate-limited/still-running-elsewhere rejection never touches the task at all, so nothing ever showed).
    // Note is deliberately KEPT in the box on failure so a rejected revision isn't lost — just retry it.
    catch (e: any) { setReviseError(e?.message || L("Révision impossible — réessaie.", "Couldn't revise — try again.")); }
    finally { setRevising(false); }
  };

  const steps = task.steps || [];
  const blocked = (s: TaskStep) => s.dependsOn != null && !steps[s.dependsOn]?.done;
  // "Open example.com ↗" instead of a bare "Open ↗" — the user sees WHERE each step goes before clicking.
  const urlHost = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
  // Name WHAT a link is, not just where it points — "Doc" beats "docs.google.com" on the card. Kept short —
  // this is a button label, not a description, so it should read at a glance next to "Open ↗".
  const linkKind = (u?: string): string => {
    const s = u || "";
    if (/docs\.google\.com\/document/.test(s)) return "Doc";
    if (/docs\.google\.com\/spreadsheets/.test(s)) return "Sheet";
    if (/docs\.google\.com\/presentation/.test(s)) return "Slides";
    if (/docs\.google\.com\/forms|forms\.gle/.test(s)) return "Form";
    if (/mail\.google\.com/.test(s)) return /#drafts/.test(s) ? "Draft" : "Email";
    if (/calendar\.google\.com/.test(s)) return "Event";
    if (/drive\.google\.com/.test(s)) return "File";
    if (/maps\.google\.com|google\.com\/maps/.test(s)) return "Directions";
    if (/^tel:/.test(s)) return "Call";
    if (/github\.com\/[^/]+\/[^/]+\/pull/.test(s)) return "PR";
    if (/github\.com\/[^/]+\/[^/]+\/issues/.test(s)) return "Issue";
    if (/[a-z0-9-]+\.slack\.com/.test(s)) return "Slack";
    if (/notion\.so/.test(s)) return "Notion";
    return urlHost(s);
  };
  // Open ALL of a task's remaining page-steps at once, into one tab group named after the task.
  const openAllPages = async () => {
    const idxs = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.url && !s.done && !blocked(s)).map(({ i }) => i).slice(0, 3);
    if (!idxs.length) return;
    openTabs(idxs.map((i) => steps[i].url!), TAB_GROUP);
    let res: WebTask[] | null = null;
    for (const i of idxs) if (steps[i].automatable) res = await api.stepDone(task.id, i, true, "Opened ↗");
    if (res) onChange(res);
  };
  const openableCount = steps.filter((s) => s.url && !s.done && !blocked(s)).length;

  const cStatus = canonStatus(task.status);

  // Auto-open documents Otto created (Doc/Sheet/Slides) once the task is done — capped per task + per
  // session, once per URL EVER (persisted), so the same doc never reopens. Works without the extension too:
  // window.open outside a click may be popup-blocked in some browsers, but when allowed the doc just appears
  // — best-effort beats waiting for a click. Off if the user toggled it in Settings.
  useEffect(() => {
    if (cStatus !== "needs_review" || !autoOpenDocsOn()) return;
    const room = SESSION_DOC_CAP - sessionDocsOpened;
    if (room <= 0) return;
    // Only docs we've NEVER auto-opened (persisted across reloads) — so the same tabs never reopen.
    const docs = (task.links || []).map((l) => l.url).filter((u) => DOC_RE.test(u) && !openedDocs.has(u));
    const toOpen = docs.slice(0, Math.min(room, PER_TASK_DOC_CAP));
    if (!toOpen.length) return;
    markDocsOpened(toOpen);
    sessionDocsOpened += toOpen.length;
    openTabs(toOpen, TAB_GROUP);
  }, [task.status, task.links]);

  // Bring a deep-linked card into view when it opens (e.g. landing on #/task/<id> directly).
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [open]);

  // State classes drive the visual language: pulsing node while thinking, soft amber glow when a step
  // is waiting on the user, dormant/desaturated once handled — readable at a glance, without reading.
  const isDone = isHandled(task.status);
  const needsYou = !isDone && cStatus === "needs_review" &&
    (task.steps || []).some((s) => !s.done && (!s.automatable || s.needsPermission || !!s.question));
  const chip = !isDone ? statusChip(task, retrying, cardEn) : null;
  return (
    <div ref={cardRef} className={`card ${open ? "open" : ""} ${isInFlight(task.status) ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${leaving && leaveKind === "confirm" ? "confirming" : task.status === "dismissed" || leaving ? "dismissed" : ""}`}>
      <div className="card-main" onClick={inModal ? undefined : onToggle} style={inModal ? { cursor: "default" } : undefined}>
        {/* Direct check-off, like a normal to-do list — no need to open the task first. Still one deliberate
            click (not automatic): it fires the same confirm as "Looks good" inside the detail view. */}
        {!isDone ? (
          <button type="button" className={`card-check ${leaving && leaveKind === "confirm" ? "checked" : ""}`}
            title={L("Marquer comme fait", "Mark as done")} aria-label={L("Marquer la tâche comme faite", "Mark the task as done")} disabled={leaving}
            onClick={(e) => { e.stopPropagation(); void leave(() => api.confirm(task.id), "confirm"); }}>
            {leaving && leaveKind === "confirm" ? "✓" : ""}
          </button>
        ) : null}
        <div className="card-text">
          <div className="card-title">{isNew ? <span className="new-dot" title={L("Nouveau — pas encore ouvert", "New — not yet opened")} /> : null}{task.title}</div>
          {/* ONE secondary line, not three: a concrete next action is more useful to scan than the generic
              "why" once one exists, so it takes priority — "why" only shows as a fallback before there's a
              next step to point at. The deadline (if any) always stays, since that's a different kind of
              information (timing, not description). Source badge dropped here entirely — it's one tap away
              in the Context section, redundant to repeat on every single row. */}
          {(() => {
            const w = task.when ? fmtWhen(task.when) : "";
            // Days-to-deadline, not urgency score, drives the visual — same anti-procrastination curve as
            // the server's applyDeadlineUrgency, so a card LOOKS as urgent as it's actually ranked.
            const daysLeft = task.when ? (Date.parse(task.when) - Date.now()) / 86_400_000 : NaN;
            const soon = !isDone && !isNaN(daysLeft) && daysLeft <= 3;
            const next = !isDone ? (task.steps || []).find((s) => !s.done) : undefined;
            const secondary = next ? L(`Suivant : ${next.text}`, `Next: ${next.text}`) : subtitle(task);
            return (w || secondary) ? <div className="card-sub">{w && <span className={`when ${soon ? "when-soon" : ""}`}>{w}</span>}{secondary}</div> : null;
          })()}
          <div className="card-badges">
            <span className={`chip chip-${task.quadrant === "do" ? "bad" : task.quadrant === "schedule" ? "attention" : "muted"}`}>{priorityBadge(task.quadrant, cardEn)}</span>
          </div>
        </div>
        {/* No button — refinement is fully automatic (immediately if AI's available, else the next background
            sweep cleans it up and queues it to run, no action needed). This just shows it's in that state. */}
        {!isDone && task.unrefined ? <span className="chip chip-muted" title={L("Ajouté pendant que l'IA était coupée — Otto va nettoyer et lancer ça automatiquement", "Added while AI was off — Otto will clean this up and run it automatically")}>{L("Nettoyage…", "Cleaning up…")}</span> : null}
        {chip ? <span className={`chip chip-${chip.tone}`}>{chip.label}</span> : null}
        {cStatus === "executing" ? <span className="card-spin" title={L("En cours…", "Working…")} /> : null}
        {/* Quick dismiss — remove a task in one click without opening it. Hover-revealed so the row stays clean.
            Hidden once the row is already leaving (dismissing or confirming) — a second click has nothing to do. */}
        {!isDone && !leaving && <button className="card-x" title={L("Ignorer", "Dismiss")} aria-label={L("Ignorer la tâche", "Dismiss task")} onClick={(e) => { e.stopPropagation(); void leave(() => api.dismiss(task.id)); }}>×</button>}
        <span className="caret">›</span>
      </div>
      {leaving && leaveKind === "confirm" ? <span className="confirm-check" aria-hidden="true">✓</span> : null}

      {open && (
        <div className="detail">
          {/* The agent drafted it — review it right here, then fire it (with a confirm). The only time
              anything sends. FIRST on the card: your next action is the first thing you see. */}
          {task.sendables?.length ? (
          <section>
            {(
              <div className="sendables">
                {task.sendables.map((s, i) => {
                  // Who this goes to — ALWAYS shown before the user sends (a calendar invite lists every attendee).
                  const recipients = s.app === "gcal" ? (s.attendees || []).join(", ") : (s.to || s.channel || "");
                  const noun = s.app === "gcal" ? L("l'invitation calendrier", "the calendar invite") : s.app === "slack" ? L("le message Slack", "the Slack message") : L("l'email", "the email");
                  const sendIcon = "";
                  return (
                  <div key={i} className="sendable">
                    {/* The recipient is on the face of the card, not hidden behind a click — you see who before you send. */}
                    {recipients ? (
                      <div className="sendable-to">
                        <span className="sendable-to-label">{s.app === "gcal" ? L("Invités", "Invites") : L("À", "To")}</span>
                        <span className="sendable-to-who">{recipients}</span>
                      </div>
                    ) : null}
                    <div className="sendable-row">
                      {/* Only ONE panel open at a time (draft view, or the send confirm) — stacking both was
                          the "messy" part: opening one now always closes the other. */}
                      <button className="btn xs ghost" onClick={() => { setConfirmIdx(null); setViewDraft((v) => (v === i ? null : i)); if (viewDraft !== i) { setChangeIdx(null); setChangeText(""); } }}>{viewDraft === i ? L("Masquer les détails", "Hide details") : s.app === "gcal" ? L("Voir l'événement", "View event") : L("Voir le brouillon", "View draft")}</button>
                      {s.sent
                        ? <button className="btn primary send-btn sent" disabled>{L("Envoyé", "Sent")}</button>
                        : sending === i
                          ? <button className="btn primary send-btn" disabled>{L("Envoi…", "Sending…")}</button>
                          : <button className="btn primary send-btn" onClick={() => { setViewDraft(null); setChangeIdx(null); setConfirmIdx(confirmIdx === i ? null : i); }}>{`${sendIcon} ${s.label}`}</button>}
                    </div>
                    {/* Confirm step — the recipient is spelled out in full before anything sends. */}
                    {confirmIdx === i && !s.sent && sending !== i ? (
                      <div className="confirm">
                        <div className="confirm-q">{L("Envoyer", "Send")} {noun} {L("à", "to")} <b>{recipients || L("le destinataire", "the recipient")}</b> ?</div>
                        <div className="confirm-acts">
                          <button className="btn primary xs" onClick={() => void doSend(i)}>{L("Oui, envoyer", "Yes, send")}</button>
                          <button className="btn xs" onClick={() => { setConfirmIdx(null); setViewDraft(i); setChangeText(""); setChangeIdx(i); }}>{L("Non — changer quelque chose", "No — change something")}</button>
                          <button className="btn xs ghost" onClick={() => setConfirmIdx(null)}>{L("Annuler", "Cancel")}</button>
                        </div>
                      </div>
                    ) : null}
                    {/* ONE panel for everything about the draft's content — view it, edit it directly, or ask
                        Otto to rewrite it with a prompt. No separate stacked boxes for each. */}
                    {viewDraft === i ? (
                      <div className="draft">
                        {s.app === "gcal" ? (
                          <>
                            {s.summary ? <div className="draft-row"><span className="draft-label">{L("Événement", "Event")}</span><span>{s.summary}</span></div> : null}
                            {s.when ? <div className="draft-row"><span className="draft-label">{L("Quand", "When")}</span><span>{s.when}</span></div> : null}
                            {recipients ? <div className="draft-row"><span className="draft-label">{L("Invités", "Invites")}</span><span>{recipients}</span></div> : null}
                          </>
                        ) : s.sent ? (
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to || s.channel}</span></div> : null}
                            {s.subject ? <div className="draft-row"><span className="draft-label">{L("Objet", "Subject")}</span><span>{s.subject}</span></div> : null}
                            <pre className="draft-body">{s.body || s.text || L("Envoyé.", "Sent.")}</pre>
                          </>
                        ) : (
                          // Unsent: editable directly — type right in the box. "Ask Otto to rewrite it"
                          // below opens an inline prompt IN this same panel instead of a separate box.
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">{L("À", "To")}</span><span>{s.to || s.channel}</span></div> : null}
                            {s.app === "gmail" ? (
                              <input className="addinput sm draft-subject" placeholder={L("Objet", "Subject")} disabled={revising}
                                value={draftEdits[i]?.subject ?? s.subject ?? ""}
                                onChange={(e) => setDraftEdits((d) => ({ ...d, [i]: { ...d[i], subject: e.target.value } }))} />
                            ) : null}
                            {/* Auto-grows to fit the WHOLE text (up to a cap) instead of a small fixed
                                box that clips a real email and forces scrolling inside a scrollbox.
                                Disabled while Otto is rewriting — a manual edit landing mid-rewrite would
                                just get silently overwritten the moment the AI pass finishes. */}
                            <textarea className="draft-body-edit" rows={12} disabled={revising}
                              ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 600)}px`; } }}
                              value={draftEdits[i]?.body ?? s.body ?? s.text ?? ""}
                              onChange={(e) => { setDraftEdits((d) => ({ ...d, [i]: { ...d[i], body: e.target.value } })); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 600)}px`; }} />
                            {draftEdits[i] && !revising ? (
                              <div className="draft-edit-acts">
                                <button className="btn primary xs" disabled={savingDraft === i} onClick={() => void saveDraftEdit(i)}>{savingDraft === i ? L("Enregistrement…", "Saving…") : L("Enregistrer les modifications", "Save changes")}</button>
                                <button className="btn xs ghost" disabled={savingDraft === i} onClick={() => setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; })}>{L("Annuler", "Discard")}</button>
                              </div>
                            ) : null}
                            {changeIdx === i ? (
                              <div className="rewrite-row">
                                <input className="addinput sm" autoFocus disabled={revising}
                                  placeholder={L("Dis à Otto quoi changer — ex : ajoute mes horaires de vol, raccourcis, corrige la date", "Tell Otto what to change — e.g. add my flight times, make it shorter, fix the date")}
                                  value={changeText} onChange={(e) => setChangeText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") void doRevise(); }} />
                                {!revising && <button className="btn primary xs" disabled={!changeText.trim()} onClick={() => void doRevise()}>{L("Réviser", "Revise")}</button>}
                                <button className="btn xs ghost" disabled={revising} onClick={() => { setChangeIdx(null); setChangeText(""); setReviseError(null); }}>{L("Annuler", "Cancel")}</button>
                                {reviseError ? <div className="rewrite-error">{reviseError}</div> : null}
                              </div>
                            ) : !revising ? (
                              <button className="btn xs ghost rewrite-toggle" onClick={() => { setChangeText(""); setReviseError(null); setChangeIdx(i); }}>{L("Demander à Otto de le réécrire →", "Ask Otto to rewrite it →")}</button>
                            ) : null}
                            {revising && changeIdx === i ? <div className="rewrite-progress" title={L("Otto réécrit le brouillon…", "Otto is rewriting the draft…")} /> : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            )}
          </section>
          ) : null}
          {/* Transparency, collapsed by default: WHERE this came from, WHAT Otto actually found (source
              badge + inline links — real Gmail/Calendar/Drive/web URLs, never a bare unverifiable claim),
              AND the full decision trail, in one place so "why am I seeing this" always has a real answer. */}
          <section className="context-sec">
            <h4 className="context-toggle" onClick={() => void toggleContext()}>
              <span className={`caret ${contextOpen ? "open" : ""}`}>›</span> {L("Contexte", "Context")}
              {task.source ? <span className="chip chip-muted context-source">{sourceBadge(task.source, cardEn)}</span> : null}
            </h4>
            {contextOpen ? (
              <div className="context-body">
                {task.context?.trim() ? <p className="context-text">{withInlineLinks(task.context)}</p> : null}
                {historyLoading ? (
                  <p className="muted small">{L("Chargement de l'historique…", "Loading history…")}</p>
                ) : history?.length ? (
                  <ul className="history-list">
                    {history.map((e, i) => (
                      <li key={i}><span className="history-when">{relTime(e.at)}</span> {e.message || e.kind}</li>
                    ))}
                  </ul>
                ) : !task.context?.trim() ? <p className="muted small">{L("Rien d'enregistré pour l'instant.", "Nothing recorded yet.")}</p> : null}
              </div>
            ) : null}
          </section>
          {steps.length > 0 && (
          <section>
            <h4>{L("Ce qu'il reste à faire", "What's left")}{openableCount >= 2 && <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>{L(`Tout ouvrir (${openableCount}) ↗`, `Open all (${openableCount}) ↗`)}</button>}</h4>
              <ul className="steps">
                {steps.map((s, i) => {
                  const blk = blocked(s);
                  const gatesAnother = steps.some((o, j) => j !== i && o.dependsOn === i); // does a later step wait on this one?
                  return (
                    <li key={i} className={`step ${s.done ? "done" : ""} ${blk ? "blocked" : ""}`}>
                      {/* The mark IS the control for a needs-you step: click ○ to tick it done (no separate button). */}
                      <button
                        type="button"
                        className={`step-mark ${!s.done && !blk ? "tickable" : ""}`}
                        title={s.done ? L(`Fait${s.doneAt ? " " + relTime(s.doneAt) : ""} — cliquer pour annuler`, `Done${s.doneAt ? " " + relTime(s.doneAt) : ""} — click to undo`) : blk ? L("En attente d'une étape précédente", "Waiting on an earlier step") : L("Cliquer pour marquer comme fait", "Click to mark done")}
                        disabled={blk}
                        onClick={() => { if (blk) return; s.done ? void act(() => api.stepDone(task.id, i, false)) : void markStepDone(i); }}
                      >
                        {s.done ? "✓" : ""}
                      </button>
                      <div className="step-body">
                        <span className="step-text">{withInlineLinks(s.text)}</span>
                        {s.done && s.doneAt ? <span className="step-when">{L(`fait ${relTime(s.doneAt)}`, `done ${relTime(s.doneAt)}`)}</span> : null}
                        {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                        {!s.done && blk ? <span className="step-dep">{L(`attend l'étape ${(s.dependsOn ?? 0) + 1}`, `waits for step ${(s.dependsOn ?? 0) + 1}`)}</span> : null}
                        {/* "What did you decide?" only when this step GATES a later one — then it feeds that next step. */}
                        {gatesAnother && !s.done && !blk && !s.automatable ? (
                          <input
                            className="step-input"
                            placeholder={L("Qu'as-tu décidé ? (utilisé pour l'étape suivante)", "What did you decide? (used for the next step)")}
                            value={decided[i] || ""}
                            onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") void markStepDone(i); }}
                          />
                        ) : null}
                      </div>
                      <div className="step-act">
                        {/* A URL step keeps its "Open ↗" link ALWAYS — even after Otto opened it — so the page
                            stays reachable from the task. */}
                        {s.url ? <button className="btn xs ghost" title={s.url} onClick={() => openTab(s.url!, TAB_GROUP)}>{L(`Ouvrir ${linkKind(s.url) || "le lien"} ↗`, `Open ${linkKind(s.url) || "link"} ↗`)}</button> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
          </section>
          )}
          {/* "What Otto did" shows real output — a resource doc/sheet it created, or other concrete actions.
              Plan-only mode's one allowed write is creating a new resource doc, so this is genuine, not a stub. */}
          {(task.did?.length || task.links?.length || task.notes?.length || task.flashcards?.length) ? (
            <section>
              <h4>{L("Ce qu'Otto a préparé", "What Otto prepared")}</h4>
              {task.did?.length ? <ul className="bullets">{task.did.map((d, i) => <li key={i}>{withInlineLinks(d)}</li>)}</ul> : null}
              {/* In-app notes (CREATE_NOTE) and flashcard decks (CREATE_FLASHCARDS) — no external tab, open
                  right here in a popup. Shown as their own row of buttons, ahead of any external links. */}
              {(task.notes?.length || task.flashcards?.length) ? (
                <div className="note-chips">
                  {task.notes?.map((n) => (
                    <button key={n.id} type="button" className="btn xs ghost note-chip" onClick={(e) => { e.stopPropagation(); setOpenNote(n.id); }}>📄 {n.title}</button>
                  ))}
                  {task.flashcards?.map((f) => (
                    <button key={f.id} type="button" className="btn xs ghost note-chip" onClick={(e) => { e.stopPropagation(); setOpenDeck(f.id); }}>🗂 {f.title} ({f.cards.length})</button>
                  ))}
                </div>
              ) : null}
              {task.links?.length ? (
                <ul className="links artifacts">{task.links.slice(0, 3).map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer" title={l.url}>{(l.label && l.label !== "Open" ? l.label : linkKind(l.url)) || L("Ouvrir le lien", "Open link")} ↗</a></li>)}</ul>
              ) : null}
            </section>
          ) : null}
          {openNote ? (() => {
            const n = task.notes?.find((x) => x.id === openNote);
            if (!n) return null;
            return (
              <TaskModal onClose={() => setOpenNote(null)}>
                <div className="note-popup">
                  <h3 className="note-popup-title">{n.title}</h3>
                  <div className="note-popup-body">{renderNoteBody(n.body)}</div>
                </div>
              </TaskModal>
            );
          })() : null}
          {openDeck ? (() => {
            const f = task.flashcards?.find((x) => x.id === openDeck);
            if (!f) return null;
            return (
              <TaskModal onClose={() => setOpenDeck(null)}>
                <FlashcardDeck deck={f} />
              </TaskModal>
            );
          })() : null}
          {inModal && !isDone ? (
            // Supportive, task-scoped chat: talking through THIS task specifically ("I'm stuck on step 2",
            // "can you break this down more?") without having to re-explain what it is — Otto already has
            // the full context above. Never shown for a finished/dismissed task — nothing left to coach.
            <section className="task-chat">
              <h4>{L("Demander à Otto", "Ask Otto")}</h4>
              <div className="chat-thread">
                {!task.chat?.length ? (
                  <p className="muted small">{L("Bloqué, dépassé, ou juste besoin d'un plan pour t'y mettre ? Demande ci-dessous.", "Stuck, overwhelmed, or just need a plan to get started? Ask below.")}</p>
                ) : task.chat.map((m, i) => (
                  <div key={i} className={`chat-msg chat-${m.role}`}>{m.text}</div>
                ))}
                {chatSending ? <div className="chat-msg chat-assistant chat-typing">…</div> : null}
                <div ref={chatEndRef} />
              </div>
              {chatError ? (
                <div className="rewrite-error">
                  {chatError}
                  {/* sendChat() restores chatInput to the failed message on error, so retrying is just
                      calling it again — no need to re-type anything. */}
                  <button type="button" className="btn xs ghost" onClick={() => void sendChat()} disabled={chatSending}>{L("Réessayer", "Retry")}</button>
                </div>
              ) : null}
              <div className="chat-row">
                <input
                  className="chat-input" placeholder={L("ex : je n'arrive pas à démarrer…", "e.g. I can't get started…")}
                  value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                  disabled={chatSending}
                />
                <button className="btn primary xs" disabled={chatSending || !chatInput.trim()} onClick={() => void sendChat()}>{L("Envoyer", "Send")}</button>
              </div>
            </section>
          ) : null}
          <div className="actions">
            {isDone ? (
              // A finished task is CLOSED, not just another item with the usual buttons — "Run now" here
              // read as an invitation to re-do already-done work (drafting a duplicate, re-creating a doc),
              // and "Dismiss" doesn't mean anything for something that already happened. Just say when.
              <span className="done-footer">{task.status === "dismissed" ? L("Ignorée", "Dismissed") : L("Terminée", "Done")}{task.updatedAt ? ` ${relTime(task.updatedAt)}` : ""}</span>
            ) : cStatus === "needs_review" ? (
              <>
                <button className="btn primary" title={L("C'est bon — marquer comme fait", "Looks good — mark as done")} onClick={() => void leave(() => api.confirm(task.id), "confirm")}>{L("C'est bon", "Looks good")}</button>
                <div className="actions-rest">
                  {/* Not failed, but the student might want Otto to take another pass anyway (regenerate the
                      fiche/checklist) without either confirming it done or dismissing it entirely. A plain
                      re-run of an already-executed task is a no-op (see server's resetTask comment) — this
                      wipes it back to just title/why first, so Otto genuinely starts over. */}
                  <button className="btn xs ghost" title={L("Reprendre cette tâche depuis le début", "Start this task over from scratch")} disabled={running} onClick={() => void run(true)}>{running ? L("En cours…", "Working…") : L("Réexécuter", "Re-run")}</button>
                  <button className="btn xs ghost" title={L("Retirer cette tâche", "Remove this task")} onClick={() => void leave(() => api.dismiss(task.id))}>{L("Ignorer", "Dismiss")}</button>
                </div>
              </>
            ) : (
              <>
                {cStatus === "failed_retryable" && retrying ? (
                  <button className="btn primary" disabled>{L("Nouvel essai…", "Retrying…")}</button>
                ) : cStatus === "failed_terminal" || cStatus === "failed_retryable" ? (
                  <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? L("En cours…", "Working…") : L("Réessayer", "Retry")}</button>
                ) : isInFlight(task.status) ? (
                  <button className="btn primary" disabled>{cStatus === "queued" ? L("En attente…", "Queued…") : L("En cours…", "Working…")}</button>
                ) : (
                  <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? L("En cours…", "Working…") : L("Lancer", "Start")}</button>
                )}
                <div className="actions-rest">
                  <button className="btn xs ghost" title={L("Retirer cette tâche", "Remove this task")} onClick={() => void leave(() => api.dismiss(task.id))}>{L("Ignorer", "Dismiss")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
