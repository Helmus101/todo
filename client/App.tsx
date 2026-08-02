import { Fragment, useEffect, useState, useCallback, useRef, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { WebTask, ConnectionStatus, Profile, TaskStep } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, isPeakHourUtc, sortWithinQuadrant } from "../shared/types.ts";
import { api, type IntegrationItem, type ConnectedAccount } from "./api.ts";

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
function statusChip(t: WebTask, retrying?: boolean): { label: string; tone: "muted" | "busy" | "attention" | "bad" | "good" } | null {
  const c = canonStatus(t.status);
  if (c === "queued") return { label: "Queued", tone: "muted" };
  if (c === "executing") return { label: "Working", tone: "busy" };
  // "Retrying" is only claimed when a REAL queued/running job exists for this task (activeTaskIds from
  // the kick response) — otherwise the honest state is "Failed" with a Retry button.
  if (c === "failed_retryable") return retrying ? { label: "Failed — retrying…", tone: "busy" } : { label: "Failed", tone: "bad" };
  if (c === "failed_terminal") return { label: "Failed", tone: "bad" };
  if (c === "needs_review") {
    if (t.steps?.some((s) => !s.done && s.question)) return { label: "Needs your answer", tone: "attention" };
    if (t.steps?.some((s) => !s.done && s.needsPermission)) return { label: "Needs approval", tone: "attention" };
    if (t.sendables?.some((s) => !s.sent)) return { label: "Draft ready", tone: "attention" };
    const n = (t.steps || []).filter((s) => !s.done && !s.automatable).length;
    return n ? { label: `${n} need${n > 1 ? "" : "s"} you`, tone: "attention" } : { label: "Done for you", tone: "good" };
  }
  return null;
}

// Translate a sweep job's skip/failure line into user terms — an honest reason, never a fake all-clear.
function sweepSkipMessage(note: string): string {
  if (/nothing connected/i.test(note)) return "No apps are connected for this account — connect Gmail in Settings so Otto has something to read.";
  if (/budget reached/i.test(note)) return "Otto's reached its monthly AI budget — it resets on the 1st.";
  if (/paused/i.test(note)) return "AI is paused — resume it in Settings to sweep for new tasks.";
  return `Sweep didn't finish: ${note.replace(/^(skipped:|sweep \w+:?)\s*/i, "")}`;
}

// Short source label for the collapsed card's source badge — same apps as linkKind, just for task.source.
const SOURCE_BADGE: Record<string, string> = {
  gmail: "Gmail", calendar: "Calendar", googlecalendar: "Calendar", manual: "You",
  slack: "Slack", github: "GitHub", notion: "Notion", linear: "Linear", todoist: "Todoist",
  googledrive: "Drive", pronote: "Pronote",
};
function sourceBadge(s: string): string { return SOURCE_BADGE[s] || (s ? s[0].toUpperCase() + s.slice(1) : "Task"); }
// Quadrant already encodes urgency+importance (see eisenhower()) — reuse it as a plain-English priority
// badge instead of asking the user to parse "do/schedule/delegate/later".
function priorityBadge(q?: string): string { return q === "do" ? "High" : q === "schedule" ? "Medium" : "Low"; }

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
// Chrome Web Store listing URL — set this once the extension is published to flip the primary install
// button from the self-hosted zip to a one-click "Add to Chrome". Empty until then.
const CHROME_STORE_URL = "";

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

const GREETING = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
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
  const [extOn, setExtOn] = useState(extPresent()); // is the Otto Tabs extension present? (it sets data-weave-ext)
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

  // The content script sets data-weave-ext at document_start; re-check shortly after mount in case of timing.
  useEffect(() => { const id = setTimeout(() => setExtOn(extPresent()), 600); return () => clearTimeout(id); }, []);

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

  const connected = !!status?.googleConnected;

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
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
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
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
      else if (!t.length) notify("Nothing found — nothing actionable in your recent inbox + calendar right now.");
      else if (!fresh.length) notify(`Swept your apps — no new tasks${needsYou ? `; ${needsYou} still need${needsYou === 1 ? "s" : ""} you` : "; everything actionable is already on your list"}.`);
      else notify(`Found ${fresh.length} new task${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} queued to run` : ""}${needsYou ? `, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}.`);
      void loadBudget();
    }
    catch (e: any) { notify(`Couldn't refresh: ${e?.message || "something went wrong — try again."}`, "error"); }
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={20} /> Otto</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} href="/tasks">Tasks{unseenCount > 0 ? <span className="tab-badge">{unseenCount}</span> : null}</a>
          <a className={`tab ${route === "settings" ? "active" : ""}`} href="/settings">Settings</a>
        </nav>
        <div className="spacer" />
        {(route === "" || route === "tasks" || route.startsWith("task/")) && status.googleConnected && <button className="btn ghost" disabled={busy} onClick={() => void generate()}>{busy ? "Finding…" : "Refresh"}</button>}
      </header>

      {onboard && <Onboarding onStatus={loadStatus} onDone={finishOnboard} />}

      {route === "settings" ? (
        <SettingsPage status={status} onSignOut={signOut} onChanged={loadStatus} extOn={extOn} />
      ) : !status.googleConnected ? (
        <main className="list-wrap"><ConnectCard status={status} /></main>
      ) : (
        <main className="list-wrap" key="dash">
          <div className="dash-head">
            <h1 className="list-head">{GREETING()}{(status.name || firstName(status.user)) ? <>, <span>{status.name || firstName(status.user)}</span></> : null}.</h1>
            <div className="list-status">
              <span><b>{live.length}</b> active</span>
              {working ? <span> · <b>{working}</b> running</span> : null}
              {handled ? <span> · <b>{handled}</b> completed</span> : null}
              {scanning && <span className="scan-note"><span className="scan-dot" /> checking for new tasks…</span>}
            </div>
          </div>
          {note && (
            <div className={`toast ${noteKind}`} role="status" aria-live="polite">
              <span className="toast-msg">{note}</span>
              <button className="toast-x" aria-label="Dismiss" onClick={dismissNote}>✕</button>
            </div>
          )}
          {status.paused && (
            <div className="intro paused-banner">
              <div className="intro-body">
                <div className="intro-title">AI is paused</div>
                <p>Resume in Settings to continue.</p>
              </div>
              <button className="btn xs ghost" onClick={() => navigate("settings")}>Settings</button>
            </div>
          )}
          {!status.paused && (budget?.over ?? status.overBudget) && (
            <div className="intro paused-banner">
              <div className="intro-body">
                <div className="intro-title">Monthly AI budget reached</div>
                <p>Otto's paused new work — it renews {budget?.renewsOn ? fmtDay(budget.renewsOn) : "on the 1st"}. Your to-dos stay put.</p>
              </div>
              <button className="btn xs ghost" onClick={() => navigate("settings")}>Settings</button>
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
                  <h3>Otto is on watch{who ? `, ${who}` : ""}</h3>
                  <p>It's reading your inbox, calendar and Drive. New tasks land here automatically — or scan right now.</p>
                  <button className="btn primary" disabled={busy} onClick={() => void generate()}>{busy ? "Scanning…" : "Scan now"}</button>
                </div>
              );
              return (
                <div className="empty-state">
                  <div className="empty-mark done"><span className="empty-check">✓</span></div>
                  <h3>You're all clear{who ? `, ${who}` : ""}</h3>
                  <p>Nothing needs you right now. Otto keeps watching and will surface anything new.</p>
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
                    <span className="focus-title">Focus Today</span>
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
                      <span className="focus-title">Later Today</span>
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
                        Show {canWait.length} more tasks for later…
                      </button>
                    ) : (
                      <>
                        <div className="focus-group-head">
                          <span className="focus-title">Can Wait</span>
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
              <h3 className="completed-head">Completed</h3>
              {/* Minimalist done-list: checked rows like a to-do app, not full cards. Click to expand details. */}
              <div className="done-list">{(showCompleted ? completed : completed.slice(0, 8)).map((t) => (
                <div key={t.id} className={`done-row ${t.id === justDoneId ? "just-done" : ""}`} onClick={() => navigate(`task/${t.id}`)} title={t.synthesis || t.why}>
                  <span className="done-check">✓</span>
                  <span className="done-title">{t.title}</span>
                  <span className="done-when">{relTime(t.updatedAt || t.createdAt)}</span>
                </div>
              ))}</div>
              {completed.length > 8 && !showCompleted && (
                <button className="btn xs ghost" onClick={() => setShowCompleted(true)}>Show all {completed.length}</button>
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
  );
}

/** Modal shell for the task detail — backdrop-click, ✕, and Esc all close; locks body scroll while open. */
function TaskModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="task-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <button className="task-modal-x" onClick={onClose} aria-label="Close">✕</button>
        {children}
      </div>
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
  return (
    <div className="connect-card">
      <div className="connect-mark"><Logo size={30} /></div>
      <h2>{who ? `Welcome, ${who}` : "Welcome to Otto"}</h2>
      <p>Connect Gmail and Otto gets to work — reading your inbox and calendar to draft replies and prep docs. It only ever <b>reads</b> until you approve; nothing sends, posts, or deletes without your click.</p>
      {!status.googleConfigured && <div className="warn">Integrations aren't configured on the server (COMPOSIO_API_KEY).</div>}
      {!status.aiReady && <div className="warn">Server is missing DEEPSEEK_API_KEY — task generation is disabled.</div>}
      <a className="btn primary big" href="/settings">Connect Gmail</a>
      <p className="fineprint">Disconnect any app, or pause Otto entirely, at any time in Settings. <a href="/privacy">What Otto reads &amp; why →</a></p>
    </div>
  );
}

/** The landing page (shown logged out at route /) — sharp, crisp positioning as a trusted decision engine. */
/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
function SettingsPage({ status, onSignOut, onChanged, extOn }: { status: ConnectionStatus; onSignOut: () => void; onChanged: () => void; extOn: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string } | null>(null);
  const [showKnows, setShowKnows] = useState(false);
  // Simplicity: only the two settings almost everyone touches (pause, scan frequency) show by default —
  // daily briefing and the Tabs extension are real but secondary, and having 4 toggles visible at once
  // made this page read as more to configure than it actually is. One click away, not gone.
  const [showMore, setShowMore] = useState(false);
  // Optimistic toggles/selects — flip instantly, reconcile with the server after (no round-trip lag).
  const [paused, setPausedLocal] = useState(status.paused);
  const [genPerDay, setGenPerDay] = useState(Math.min(4, Math.max(1, status.genPerDay || 1)));
  const [autoOpen, setAutoOpen] = useState(autoOpenDocsOn());
  const [dailyBriefingEnabled, setDailyBriefingEnabledLocal] = useState(profile?.dailyBriefingEnabled ?? false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { setGenPerDay(Math.min(4, Math.max(1, status.genPerDay || 1))); }, [status.genPerDay]);
  useEffect(() => { void api.profile().then((p) => { setProfile(p); setDailyBriefingEnabledLocal(p?.dailyBriefingEnabled ?? false); }); void api.usage().then(setUsage).catch(() => {}); }, []);
  const changeGen = (n: number) => { setGenPerDay(n); void api.setProfilePreference("genPerDay", n).then(() => onChanged()); };
  const toggleAutoOpen = (v: boolean) => { setAutoOpen(v); try { localStorage.setItem("otto-autoopen-docs", v ? "1" : "0"); } catch { /* ignore */ } };
  // Month-to-date AI spend vs. the cap — both computed server-side (USD, approximate; for visibility + the cap).
  const fmtUsd = (n: number) => n <= 0 ? "$0" : n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`;

  return (
    <main className="settings-page">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-sec">
        <h3>Account</h3>
        <div className="modal-row"><span className="lbl">{status.user}{status.cloud ? " · synced" : ""}</span><button className="btn xs" onClick={() => void onSignOut()}>Sign out</button></div>
        {usage && <div className="modal-row"><span className="lbl">AI usage this month</span><span className="val" title={`${usage.runs} runs total`}>≈ {fmtUsd(usage.monthCostUsd)} of {fmtUsd(usage.budgetUsd)}{usage.over ? " · reached" : ""} · renews {fmtDay(usage.renewsOn)}</span></div>}
        <div className="modal-row"><span className="lbl">Legal</span><span className="val"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></span></div>
        {/* GDPR self-serve: download everything stored (Art. 20, portability) and permanently delete it
            (Art. 17, erasure) — no "email us and wait" step for either. */}
        <div className="modal-row">
          <span className="lbl">Your data</span>
          <span className="val"><a href={api.exportDataUrl()} download>Download my data</a></span>
        </div>
        <div className="modal-row">
          <span className="lbl">Delete account</span>
          <button
            className="btn xs"
            disabled={deletingAccount}
            onClick={async () => {
              if (!window.confirm("Permanently delete your Otto account and everything stored with it — tasks, profile, connections? This cannot be undone.")) return;
              setDeletingAccount(true);
              try { await api.deleteAccount(); window.location.href = "/"; }
              catch { setDeletingAccount(false); }
            }}
          >{deletingAccount ? "Deleting…" : "Delete everything"}</button>
        </div>
      </section>

      <section className="settings-sec">
        <h3>Apps</h3>
        <p className="settings-hint">Otto reads your apps and does reversible work — it <b>never sends, posts, or deletes</b> on its own, and only ever edits a document it created itself, never one of yours.</p>
        <Integrations onChanged={onChanged} primaryAccounts={profile?.primaryAccounts} onProfile={setProfile} />
        {/* TEMPORARY: launch is scoped to Google + Pronote — everything else (Slack, GitHub, Notion, …) stays hidden for now. */}
        <p className="settings-hint">Other integrations are temporarily hidden for launch.</p>
        <PronoteTile />
      </section>

      <section className="settings-sec">
        <h3>Preferences</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>Pause Otto</b><span className="settings-hint">Stops all AI. Your to-dos stay put.</span></span>
            <span className="switch"><input type="checkbox" checked={paused} onChange={(e) => { const v = e.target.checked; setPausedLocal(v); void api.setPaused(v).then(() => onChanged()); }} /><span className="switch-track" /></span>
          </label>
          <div className="set-row">
            <span className="set-text"><b>Scan for new tasks</b><span className="settings-hint">How often Otto checks your apps each day.</span></span>
            <div className="seg" role="group" aria-label="Scans per day">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={`seg-btn ${genPerDay === n ? "on" : ""}`} onClick={() => changeGen(n)}>{n}×</button>
              ))}
            </div>
          </div>
          {showMore ? (
            <>
              <label className="set-row">
                <span className="set-text"><b>Daily briefing</b><span className="settings-hint">Get an email every morning with your top 3 priorities and upcoming risks.</span></span>
                <span className="switch"><input type="checkbox" checked={dailyBriefingEnabled} onChange={(e) => { const v = e.target.checked; setDailyBriefingEnabledLocal(v); void api.setDailyBriefing(v).then(() => onChanged()); }} /><span className="switch-track" /></span>
              </label>
              <label className="set-row">
                <span className="set-text"><b>Connect to Otto Tabs</b><span className="settings-hint">Lets Otto open pages for you automatically — drafts, docs, links — grouped into one tab group. Needs the free Tabs extension.</span></span>
                <span className="switch"><input type="checkbox" checked={autoOpen} onChange={(e) => toggleAutoOpen(e.target.checked)} /><span className="switch-track" /></span>
              </label>
              {autoOpen && (
                extOn
                  ? <div className="ext-panel ok"><span className="ext-chip">✓ Tabs extension connected</span><span className="settings-hint">Otto will open pages into an “Otto” tab group as it works.</span></div>
                  : <div className="ext-panel">
                      <p className="settings-hint">Add the free Tabs extension so Otto can open pages for you. Two ways:</p>
                      {CHROME_STORE_URL && <a className="btn xs primary ext-primary" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">Add to Chrome ↗</a>}
                      <div className="ext-how">
                        <div className="ext-how-title">{CHROME_STORE_URL ? "Or install it manually" : "Install it in under a minute"}</div>
                        <ol className="ext-steps">
                          <li><a href="/otto-tabs-extension.zip" download>Download the extension</a> and unzip it.</li>
                          <li>Open <code>chrome://extensions</code> and turn on <b>Developer mode</b> (top-right).</li>
                          <li>Click <b>Load unpacked</b> and pick the unzipped folder.</li>
                        </ol>
                      </div>
                    </div>
              )}
            </>
          ) : (
            <button type="button" className="btn xs ghost more-settings-btn" onClick={() => setShowMore(true)}>More settings…</button>
          )}
        </div>
      </section>

      <section className="settings-sec">
        <button className="sec-toggle" onClick={() => setShowKnows((v) => !v)}>
          <h3>What Otto knows about you</h3>
          <span className={`caret ${showKnows ? "open" : ""}`}>›</span>
        </button>
        {showKnows && <><p className="settings-hint">Otto fills this in as it works. Edit anything.</p><ProfileEditor /></>}
      </section>
    </main>
  );
}


// Google apps allow connecting multiple accounts (personal + work).
const MULTI_ACCOUNT_APPS = ["gmail", "googlecalendar", "googledocs", "googleslides", "googledrive", "googlesheets"];

/** Connected accounts for a multi-account app — one row per account with its address + an individual Disconnect. */
function AppAccounts({ app, onChanged, primary, onProfile }: { app: string; onChanged?: () => void; primary?: string; onProfile?: (p: Profile) => void }) {
  const [accts, setAccts] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setAccts((await api.integrationAccounts(app)).accounts); } catch { setAccts([]); } }, [app]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const on = () => { if (!document.hidden) void load(); }; window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [load]);
  const disc = async (id: string) => { setBusy(id); try { await api.disconnectAccount(app, id); await load(); onChanged?.(); } finally { setBusy(""); } };
  const makePrimary = async (id: string) => {
    setBusy(id);
    try { onProfile?.(await api.setProfilePreference("primaryAccount", { app, accountId: id })); }
    finally { setBusy(""); }
  };
  if (!accts?.length) return null;
  // Un-set (or stale — e.g. that account was disconnected) primary defaults to whichever connected first.
  const primaryId = (primary && accts.some((a) => a.id === primary)) ? primary : accts[0]?.id;
  return (
    <div className="int-accounts">
      {accts.map((a, i) => (
        <div key={a.id} className="int-acct">
          <span className="int-acct-email">{a.email || (accts.length > 1 ? `Account ${i + 1}` : "Connected")}</span>
          <div className="int-acct-actions">
            {accts.length > 1 && (
              a.id === primaryId
                ? <span className="chip chip-muted" title="New drafts/docs not tied to a specific account use this one">Primary</span>
                : <button className="btn xs ghost" disabled={busy === a.id} title="Use this account for new drafts/docs not tied to a specific one" onClick={() => void makePrimary(a.id)}>{busy === a.id ? "…" : "Make primary"}</button>
            )}
            <button className="btn xs ghost" disabled={busy === a.id} onClick={() => void disc(a.id)}>{busy === a.id ? "…" : "Disconnect"}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Integrations grid (Composio): one tile per app, grouped by category. Connect = OAuth; Disconnect = revoke. */
function Integrations({ onChanged, primaryAccounts, onProfile }: { onChanged?: () => void; primaryAccounts?: Record<string, string>; onProfile?: (p: Profile) => void }) {
  const [items, setItems] = useState<IntegrationItem[] | null>(null);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState("");
  // TEMPORARY: only Google integrations are shown while Pronote is the other active integration effort —
  // flip this back to `r.items` once the rest are ready to be re-offered.
  const load = useCallback(async () => {
    try { const r = await api.integrations(); setItems(r.items.filter((i) => i.category === "Google")); setReady(r.ready); onChanged?.(); }
    catch { setItems([]); }
  }, [onChanged]);
  useEffect(() => { void load(); }, [load]);
  // Returning from an OAuth redirect → refresh once shortly after mount so a just-connected app flips to ✓.
  useEffect(() => { const id = setTimeout(() => void load(), 1200); return () => clearTimeout(id); }, [load]);
  // Connect opens OAuth in a NEW TAB — so when the user comes back to this tab, re-check what's now connected.
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const disconnect = async (key: string) => {
    if (busy) return;
    setBusy(key);
    try { await api.disconnectIntegration(key); await load(); } finally { setBusy(""); }
  };

  if (items === null) return (
    <div className="int-grid" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="int-tile">
          <span className="skel-box int-logo" />
          <div className="int-info"><span className="skel-box skel-line" style={{ width: ["42%", "56%", "48%"][i] }} /><span className="skel-box skel-line sm" style={{ width: "70%" }} /></div>
        </div>
      ))}
    </div>
  );
  if (!ready) return <div className="warn">Integrations need <b>COMPOSIO_API_KEY</b> set on the server (it's in Otto's root <code>.env</code>). Restart the server after adding it.</div>;

  const cats = [...new Set(items.map((i) => i.category))];
  const count = items.filter((i) => i.connected).length;
  return (
    <div className="integrations">
      {count > 0 && <div className="muted small int-count">{count} connected.</div>}
      {cats.map((cat) => (
        <div key={cat} className="int-group">
          <div className="int-cat">{cat}</div>
          <div className="int-grid">
            {items.filter((i) => i.category === cat).map((i) => (
              <Fragment key={i.key}>
                <div className={`int-tile ${i.connected ? "on" : ""}`}>
                  <img className="int-logo" src={i.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  <div className="int-info">
                    <div className="int-name">{i.name}{i.connected && <span className="int-dot" title="Connected" />}</div>
                    <div className="int-blurb">{i.blurb}</div>
                  </div>
                  {/* Not connected → Connect. Connected Google apps → Add account (multi). Connected single
                      apps → no button here; the account row below carries its identity + Disconnect. */}
                  {!i.connected ? (
                    <a className="btn xs" href={`/integrations/${i.key}/connect`} target="_blank" rel="noreferrer">Connect ↗</a>
                  ) : MULTI_ACCOUNT_APPS.includes(i.key) ? (
                    <a className="btn xs" href={`/integrations/${i.key}/connect`} target="_blank" rel="noreferrer">Add account ↗</a>
                  ) : null}
                </div>
                {i.connected && <AppAccounts app={i.key} onChanged={load} primary={primaryAccounts?.[i.key]} onProfile={onProfile} />}
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Pronote (French school portal) — no OAuth exists for it, so this is a credential form instead of a
 *  redirect link. The password is sent once to connect and never stored (see server/pronote.ts); only a
 *  rotating token comes back. Reads homework due dates into the to-do list — nothing is ever written back. */
function PronoteTile() {
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
    if (!url.trim() || !username.trim() || !password) { setErr("URL, username and password are required."); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.connectPronote(url.trim(), username.trim(), password, kind === "parent" ? 7 : 6);
      if (!r.ok) { setErr(r.error || "Couldn't connect."); return; }
      setPassword(""); setOpen(false);
      await load();
    } finally { setBusy(false); }
  };
  const disconnect = async () => { setBusy(true); try { await api.disconnectPronote(); await load(); } finally { setBusy(false); } };

  if (!status) return null;
  return (
    <div className="int-group">
      <div className="int-cat">School</div>
      <div className="int-grid">
        <div className={`int-tile ${status.connected ? "on" : ""}`}>
          {/* Index Éducation's official PRONOTE logo, via Wikimedia Commons (CC BY-SA 4.0, credited to
              Index Éducation) — self-hosted at public/logos/pronote.png, see public/logos/ATTRIBUTION.md. */}
          <span className="int-logo pronote-logo"><img src="/logos/pronote.png" alt="" loading="lazy" /></span>
          <div className="int-info">
            <div className="int-name">Pronote{status.connected && <span className="int-dot" title="Connected" />}</div>
            <div className="int-blurb">Homework &amp; test due dates. Read-only — Otto never marks anything done in Pronote. Unofficial, reverse-engineered connection (Index Éducation has no official student API or OAuth for this) — your password is used once to connect and never stored; an encrypted rotating token stands in for it after that.</div>
          </div>
          {status.connected
            ? <button className="btn xs" disabled={busy} onClick={() => void disconnect()}>{busy ? "…" : "Disconnect"}</button>
            : <button className="btn xs" disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "Connect"}</button>}
        </div>
      </div>
      {status.connected && <div className="int-accounts"><div className="int-acct"><span className="int-acct-email">{status.username}</span></div></div>}
      {open && !status.connected && (
        <div className="pronote-form">
          <input className="addinput sm" placeholder="Pronote URL (from your school, e.g. https://0000000a.index-education.net/pronote/eleve.html)"
            value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          <div className="pronote-form-row">
            <input className="addinput sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            <input className="addinput sm" type="password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }} />
          </div>
          <div className="pronote-form-row">
            <div className="seg" role="group" aria-label="Account type">
              <button type="button" className={`seg-btn ${kind === "student" ? "on" : ""}`} onClick={() => setKind("student")}>Student</button>
              <button type="button" className={`seg-btn ${kind === "parent" ? "on" : ""}`} onClick={() => setKind("parent")}>Parent</button>
            </div>
            <button className="btn primary xs" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
          </div>
          {err && <div className="autherr">{err}</div>}
        </div>
      )}
    </div>
  );
}

/** First-run ONBOARDING for a brand-new account — the ONE place Otto is explained. A guided 4-step overlay:
 *  welcome + name → how it works → connect first apps → done. Each connect opens in a new tab; we re-check
 *  on focus so a tile flips to ✓ when the user comes back. Shown once after sign-up; finishing (or "Skip")
 *  clears the otto-onboard flag. */
const OB_STEPS = 4;
function Onboarding({ onStatus, onDone }: { onStatus: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [items, setItems] = useState<IntegrationItem[] | null>(null);
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { /* non-blocking */ } }
    setStep(1);
  };
  const load = useCallback(async () => { try { const r = await api.integrations(); setItems(r.items); onStatus(); } catch { setItems([]); } }, [onStatus]);
  useEffect(() => { void load(); }, [load]);
  // Connect opens OAuth in a new tab → refresh connection state when the user returns to this tab.
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const ESSENTIALS = ["gmail", "googlecalendar", "googledrive"];
  const essentials = (items || [])
    .filter((i) => ESSENTIALS.includes(i.key))
    .sort((a, b) => ESSENTIALS.indexOf(a.key) - ESSENTIALS.indexOf(b.key));
  const connectedCount = essentials.filter((i) => i.connected).length;

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <button className="onboard-skip" onClick={onDone} aria-label="Skip onboarding">Skip</button>
        <div className="onboard-top">
          <div className="onboard-brand"><Logo size={20} /> <span>Otto</span></div>
          <div className="onboard-progress" aria-hidden="true">
            {Array.from({ length: OB_STEPS }).map((_, d) => <span key={d} className={d <= step ? "on" : ""} />)}
          </div>
        </div>

        {step === 0 && (
          <div className="onboard-step">
            <h2>Welcome to Otto</h2>
            <p className="onboard-lead">Know what deserves your attention today. Otto reads your apps, ranks what matters, and prepares the work — you stay in control.</p>
            <label className="field onboard-name"><span>What should Otto call you?</span>
              <input className="addinput" placeholder="Your name" value={name} maxLength={60} autoFocus
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
            </label>
            <div className="onboard-actions"><button className="btn primary big" onClick={() => void saveName()}>Get started</button></div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-step">
            <h2>How Otto works</h2>
            <p className="onboard-lead">Every day, Otto reads your inbox, calendar and Drive — then sorts everything into three simple states.</p>
            <div className="ob-states">
              <div className="ob-state"><span className="ob-dot done" /><div><b>Done for you</b><span>Drafts and docs, ready to review.</span></div></div>
              <div className="ob-state"><span className="ob-dot need" /><div><b>Needs you</b><span>A decision, a send, or a payment — you confirm.</span></div></div>
              <div className="ob-state"><span className="ob-dot check" /><div><b>Completed</b><span>Checked off and out of your way.</span></div></div>
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn primary big" onClick={() => setStep(2)}>Next</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-step">
            <h2>Connect your apps</h2>
            <p className="onboard-lead">This is what Otto reads to get ahead of your day. Each opens in a new tab — sign in, then come back.</p>
            {items === null ? <div className="muted small">Loading…</div> : (
              <div className="onboard-apps">
                {essentials.map((i) => (
                  <div key={i.key} className={`onboard-app ${i.connected ? "on" : ""}`}>
                    <img className="int-logo" src={i.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                    <div className="onboard-app-name">{i.name}</div>
                    {i.connected
                      ? <span className="onboard-app-ok">✓ Connected</span>
                      : <a className="btn xs" href={`/integrations/${i.key}/connect`} target="_blank" rel="noreferrer">Connect ↗</a>}
                  </div>
                ))}
              </div>
            )}
            <p className="muted small">You can add more apps any time in Settings.</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary big" onClick={() => setStep(3)}>{connectedCount ? `Continue — ${connectedCount} connected` : "Skip for now"}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step onboard-done">
            <div className="onboard-done-mark"><Logo size={30} /></div>
            <h2>You're all set{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}</h2>
            <p className="onboard-lead">{connectedCount ? "Otto's already getting to work. Anything that needs you will show up as a task." : "Connect an app any time from Settings, and Otto gets to work."}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>Go to my tasks</button></div>
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
    { n: "01", label: "Reads your world" },
    { n: "02", label: "Prepares the work" },
    { n: "03", label: "You confirm" },
  ] as const;
  const [stage, setStage] = useState(0);
  const [sent, setSent] = useState(false);
  const go = (i: number) => { setStage(i); if (i !== 2) setSent(false); };

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
            <div className="walk-row"><span className="chip chip-muted">Gmail</span><span className="walk-row-text">Alex — "Can we finalize the Q3 proposal numbers this week?"</span><span className="walk-check">✓ read</span></div>
            <div className="walk-row"><span className="chip chip-muted">Calendar</span><span className="walk-row-text">Design review — tomorrow, 2:00 PM</span><span className="walk-check">✓ read</span></div>
            <div className="walk-row"><span className="chip chip-muted">Drive</span><span className="walk-row-text">"Q3 Proposal — Draft v3" shared with you 2h ago</span><span className="walk-check">✓ read</span></div>
            <p className="walk-caption">Otto reads what's connected and pulls out the handful of things that genuinely need you — everything else never reaches your list.</p>
          </div>
        )}
        {stage === 1 && (
          <div className="walk-card">
            <div className="card-title">Reply to Alex about the Q3 proposal</div>
            <div className="card-badges"><span className="chip chip-muted">Gmail</span><span className="chip chip-bad">High</span></div>
            <h4 className="walk-h">Context <span className="chip chip-muted context-source">Gmail</span></h4>
            <p className="context-text">Alex asked to finalize the Q3 numbers this week. The shared "Q3 Proposal — Draft v3" doc already has the updated figures from your last edit.</p>
            <h4 className="walk-h">What Otto did</h4>
            <ul className="bullets"><li>Drafted a reply referencing the updated numbers in Draft v3</li></ul>
            <p className="walk-caption">The draft is ready to review — nothing has been sent.</p>
          </div>
        )}
        {stage === 2 && (
          <div className="walk-card">
            <div className="sendable-to"><span className="sendable-to-label">To</span><span className="sendable-to-who">alex@company.com</span></div>
            <p className="walk-draft-body">"Hi Alex — sounds good, thursday works. I'll bring the updated numbers from Draft v3 and we can walk through the deltas together."</p>
            {!sent ? (
              <button className="btn primary send-btn" onClick={() => setSent(true)}>Send</button>
            ) : (
              <button className="btn primary send-btn sent" disabled>Sent ✓</button>
            )}
            <p className="walk-caption">{sent ? "Only your click sends it — Otto never does." : "Review it, tweak it if you want, then send it yourself."}</p>
          </div>
        )}
      </div>

      <div className="walk-nav">
        <button className="btn ghost" disabled={stage === 0} onClick={() => go(stage - 1)}>← Back</button>
        <button className="btn ghost" disabled={stage === STAGES.length - 1} onClick={() => go(stage + 1)}>Next →</button>
      </div>
    </div>
  );
}

/** Marketing landing (signed out, route /). CTAs route to the dedicated login / sign-up page. */
function Landing() {
  const DRAFT = "sounds good — thursday works. i'll bring the updated numbers and we can walk through the deltas together";
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
          <a className="btn ghost" href="/login">Log in</a>
          <a className="btn primary" href="/signup">Get started</a>
        </nav>
      </header>

      <main className="hero">
        <h1 className="hero-title hero-in" style={{ ["--d" as any]: "0.05s" }}>Know what deserves your attention today.</h1>
        <p className="hero-sub hero-in" style={{ ["--d" as any]: "0.15s" }}>Stop deciding what to do next. Otto reads your Gmail, Calendar, and Drive to rank what genuinely matters, prepare the work, and leave you in total control.</p>
        <div className="hero-cta hero-in" style={{ ["--d" as any]: "0.25s" }}>
          <a className="btn primary big" href="/signup">Get started — it's free</a>
          <a className="btn ghost" href="/login">Log in</a>
        </div>
        <div className="fineprint hero-in" style={{ ["--d" as any]: "0.32s" }}>Only ever drafts &amp; docs — Otto never sends anything without you.</div>
        {/* One product visual: the live drafting demo, nothing else. */}
        <div className="hero-demo hero-in" style={{ ["--d" as any]: "0.42s" }} aria-hidden="true">
          <div className="hero-demo-label"><span className="live-dot" /> Live — drafting in your voice</div>
          <div className="demo-window">
            <div className="demo-titlebar"><span /><span /><span /></div>
            <div className="demo-body">
              <p className="demo-line"><b>To:</b> sarah@acme.com</p>
              <p className="demo-line"><b>Subject:</b> Re: Q3 budget review</p>
              <p className="demo-line gap">hi sarah,</p>
              <p className="demo-line">{typed}<span className="demo-caret" /></p>
            </div>
          </div>
        </div>
      </main>

      <section className="landing-sec">
        <h2 className="reveal">What you get back</h2>
        <div className="outcomes">
          <div className="outcome reveal" style={{ ["--d" as any]: "0.0s" }}><span className="outcome-mark">✓</span><div><h3>Your inbox, triaged</h3><p>Otto reads every thread and surfaces only the handful that genuinely need you — the rest never reaches your list.</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.1s" }}><span className="outcome-mark">✓</span><div><h3>Replies drafted in your voice</h3><p>It learns how you write from your sent mail, then drafts the response — matched to the thread, ready to send.</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.2s" }}><span className="outcome-mark">✓</span><div><h3>Nothing sent without you</h3><p>Every draft waits for your OK. Otto never sends, posts, invites, or pays on its own — you're always the last step.</p></div></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">How it works</h2>
        <p className="lead reveal">Connect once. From then on Otto watches the things that actually need you — and quietly gets ahead of them. Click through the steps below.</p>
        <Walkthrough />
      </section>

      <section className="landing-sec">
        <h2 className="reveal">Built to be trusted</h2>
        <div className="features">
          <div className="feature reveal" style={{ ["--d" as any]: "0.0s" }}><div><h3>Drafts, never sends</h3><p>Every email is a draft you review. Nothing leaves your account without your explicit OK.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.1s" }}><div><h3>Read the code that reads your mail</h3><p>Otto is open source (MIT). The rule that it never sends, posts or deletes on its own is enforced in code you can read — not just a promise.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.2s" }}><div><h3>Your account, your data</h3><p>Saved privately to your account. Bring your own keys or self-host if you'd rather — nothing is shared, sold, or used to train models.</p></div></div>
        </div>
      </section>

      <section className="cta-band reveal">
        <h2>Stop managing your to-do list.</h2>
        <p>Connect Gmail and let Otto clear what it can — you just confirm the rest. Free to start, ready in a minute.</p>
        <a className="btn big cta-band-btn" href="/signup">Get started — it's free</a>
        <div className="cta-fine">No credit card · Otto never sends without you</div>
      </section>

      <div className="landing-foot">
        <div>Every day you decide what matters. Otto already did that.</div>
        <nav className="foot-links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
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
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => { void api.profile().then(setP).catch(() => setP(null)); }, []);
  if (!p) return <p className="muted small">Loading…</p>;
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length + p.courses.length;
  const lists = [
    { key: "preference" as const, label: "Preferences", items: p.preferences },
    { key: "person" as const, label: "People", items: p.people },
    { key: "project" as const, label: "Projects", items: p.projects },
    { key: "course" as const, label: "Courses", items: p.courses },
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
              <li key={i}><span>{it}</span><button className="x" title="Remove" onClick={async () => setP(await api.delProfile(l.key, i))}>×</button></li>
            ))}
          </ul>
          <AddRow placeholder={`Add a ${l.label.toLowerCase().replace(/s$/, "")}…`} onAdd={async (v) => setP(await api.setProfile(l.key, v))} />
        </div>
      ))}
      {count === 0
        ? <div className="muted small">Empty for now — Otto fills this in as it works, or add your name, about, preferences, people and projects here.</div>
        : <div className="forget-row">
            <button
              className="btn xs forget"
              onClick={async () => { if (window.confirm("Forget everything Otto has learned about you? This clears your About, preferences, people and projects, and can't be undone.")) setP(await api.clearProfile()); }}
            >Forget everything</button>
            <span className="muted small">Wipes Otto's memory — it starts from zero and learns you again as it works.</span>
          </div>}
    </div>
  );
}

function NameRow({ name, onSave }: { name: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(name);
  useEffect(() => { setText(name); }, [name]);
  return (
    <div className="prof-group">
      <div className="prof-label">Name</div>
      <div className="addrow">
        <input className="addinput sm" placeholder="What should Otto call you?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === name.trim()} onClick={() => void onSave(text.trim())}>Save</button>
      </div>
    </div>
  );
}

function AboutRow({ about, onSave }: { about: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(about);
  useEffect(() => { setText(about); }, [about]);
  return (
    <div className="prof-group">
      <div className="prof-label">About you</div>
      <div className="addrow">
        <input className="addinput sm" placeholder="One line: who you are / how you work" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === about.trim()} onClick={() => void onSave(text.trim())}>Save</button>
      </div>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const go = async () => { const v = text.trim(); if (!v) return; await onAdd(v); setText(""); };
  return (
    <div className="addrow">
      <input className="addinput sm" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="btn" disabled={!text.trim()} onClick={() => void go()}>Add</button>
    </div>
  );
}

function AddTask({ onAdded }: { onAdded: Dispatch<SetStateAction<WebTask[]>> }) {
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
      id: stubId, title: v, why: "Added by you", when: whenToSend || undefined, source: "manual", risk: "low",
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
        placeholder="Add a task, a shift, an appointment…"
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
          title="When this is due"
        />
      ) : (
        <button type="button" className="btn xs ghost add-when-toggle" disabled={busy} onClick={() => setShowWhen(true)}>+ date</button>
      )}
      {text.trim() && <button className="btn xs primary" disabled={busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add"}</button>}
    </div>
  );
}

function Card({ task, open, onToggle, onChange, onTask, retrying, onConfirmed, onNotify, inModal, isNew }: { task: WebTask; open: boolean; onToggle: () => void; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void; retrying?: boolean; onConfirmed?: (id: string) => void; onNotify?: (msg: string, kind?: "info" | "error") => void; inModal?: boolean; isNew?: boolean }) {
  const [running, setRunning] = useState(false);
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
    catch (e: any) { setChatError(e?.message || "Couldn't send that — try again."); setChatInput(message); }
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
  const run = async () => {
    setRunning(true);
    try { onTask(await api.run(task.id)); }
    // A run rejection (paused / over-budget / rate-limited / still-running-elsewhere / a server error) never
    // touched the task before, so it failed silently. Surface it — the card also reflects any failed state.
    catch (e: any) { onNotify?.(e?.message || "Couldn't run this task — try again.", "error"); }
    finally { setRunning(false); }
  };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    // A failed send used to be swallowed entirely — the button just reset and the user had no idea whether
    // their email/message went out. For an irreversible action that's the worst possible silence: surface it.
    try { onTask(await api.sendDraft(task.id, i)); }
    catch (e: any) { onNotify?.(e?.message || "Couldn't send — nothing was sent. Try again.", "error"); }
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
    catch (e: any) { setReviseError(e?.message || "Couldn't revise — try again."); }
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
  const chip = !isDone ? statusChip(task, retrying) : null;
  return (
    <div ref={cardRef} className={`card ${open ? "open" : ""} ${isInFlight(task.status) ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${leaving && leaveKind === "confirm" ? "confirming" : task.status === "dismissed" || leaving ? "dismissed" : ""}`}>
      <div className="card-main" onClick={inModal ? undefined : onToggle} style={inModal ? { cursor: "default" } : undefined}>
        {/* Direct check-off, like a normal to-do list — no need to open the task first. Still one deliberate
            click (not automatic): it fires the same confirm as "Looks good" inside the detail view. */}
        {!isDone ? (
          <button type="button" className={`card-check ${leaving && leaveKind === "confirm" ? "checked" : ""}`}
            title="Mark done" aria-label="Mark task done" disabled={leaving}
            onClick={(e) => { e.stopPropagation(); void leave(() => api.confirm(task.id), "confirm"); }}>
            {leaving && leaveKind === "confirm" ? "✓" : ""}
          </button>
        ) : null}
        <div className="card-text">
          <div className="card-title">{isNew ? <span className="new-dot" title="New — not yet opened" /> : null}{task.title}</div>
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
            const secondary = next ? `Next: ${next.text}` : subtitle(task);
            return (w || secondary) ? <div className="card-sub">{w && <span className={`when ${soon ? "when-soon" : ""}`}>{w}</span>}{secondary}</div> : null;
          })()}
          <div className="card-badges">
            <span className={`chip chip-${task.quadrant === "do" ? "bad" : task.quadrant === "schedule" ? "attention" : "muted"}`}>{priorityBadge(task.quadrant)}</span>
          </div>
        </div>
        {/* No button — refinement is fully automatic (immediately if AI's available, else the next background
            sweep cleans it up and queues it to run, no action needed). This just shows it's in that state. */}
        {!isDone && task.unrefined ? <span className="chip chip-muted" title="Added while AI was off — Otto will clean this up and run it automatically">Cleaning up…</span> : null}
        {chip ? <span className={`chip chip-${chip.tone}`}>{chip.label}</span> : null}
        {cStatus === "executing" ? <span className="card-spin" title="Working…" /> : null}
        {/* Quick dismiss — remove a task in one click without opening it. Hover-revealed so the row stays clean.
            Hidden once the row is already leaving (dismissing or confirming) — a second click has nothing to do. */}
        {!isDone && !leaving && <button className="card-x" title="Dismiss" aria-label="Dismiss task" onClick={(e) => { e.stopPropagation(); void leave(() => api.dismiss(task.id)); }}>×</button>}
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
                  const noun = s.app === "gcal" ? "calendar invite" : s.app === "slack" ? "Slack message" : "email";
                  const sendIcon = "";
                  return (
                  <div key={i} className="sendable">
                    {/* The recipient is on the face of the card, not hidden behind a click — you see who before you send. */}
                    {recipients ? (
                      <div className="sendable-to">
                        <span className="sendable-to-label">{s.app === "gcal" ? "Invites" : "To"}</span>
                        <span className="sendable-to-who">{recipients}</span>
                      </div>
                    ) : null}
                    <div className="sendable-row">
                      {/* Only ONE panel open at a time (draft view, or the send confirm) — stacking both was
                          the "messy" part: opening one now always closes the other. */}
                      <button className="btn xs ghost" onClick={() => { setConfirmIdx(null); setViewDraft((v) => (v === i ? null : i)); if (viewDraft !== i) { setChangeIdx(null); setChangeText(""); } }}>{viewDraft === i ? "Hide details" : s.app === "gcal" ? "View event" : "View draft"}</button>
                      {s.sent
                        ? <button className="btn primary send-btn sent" disabled>Sent</button>
                        : sending === i
                          ? <button className="btn primary send-btn" disabled>Sending…</button>
                          : <button className="btn primary send-btn" onClick={() => { setViewDraft(null); setChangeIdx(null); setConfirmIdx(confirmIdx === i ? null : i); }}>{`${sendIcon} ${s.label}`}</button>}
                    </div>
                    {/* Confirm step — the recipient is spelled out in full before anything sends. */}
                    {confirmIdx === i && !s.sent && sending !== i ? (
                      <div className="confirm">
                        <div className="confirm-q">Send this {noun} to <b>{recipients || "the recipient"}</b>?</div>
                        <div className="confirm-acts">
                          <button className="btn primary xs" onClick={() => void doSend(i)}>Yes, send</button>
                          <button className="btn xs" onClick={() => { setConfirmIdx(null); setViewDraft(i); setChangeText(""); setChangeIdx(i); }}>No — change something</button>
                          <button className="btn xs ghost" onClick={() => setConfirmIdx(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                    {/* ONE panel for everything about the draft's content — view it, edit it directly, or ask
                        Otto to rewrite it with a prompt. No separate stacked boxes for each. */}
                    {viewDraft === i ? (
                      <div className="draft">
                        {s.app === "gcal" ? (
                          <>
                            {s.summary ? <div className="draft-row"><span className="draft-label">Event</span><span>{s.summary}</span></div> : null}
                            {s.when ? <div className="draft-row"><span className="draft-label">When</span><span>{s.when}</span></div> : null}
                            {recipients ? <div className="draft-row"><span className="draft-label">Invites</span><span>{recipients}</span></div> : null}
                          </>
                        ) : s.sent ? (
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">To</span><span>{s.to || s.channel}</span></div> : null}
                            {s.subject ? <div className="draft-row"><span className="draft-label">Subject</span><span>{s.subject}</span></div> : null}
                            <pre className="draft-body">{s.body || s.text || "Sent."}</pre>
                          </>
                        ) : (
                          // Unsent: editable directly — type right in the box. "Ask Otto to rewrite it"
                          // below opens an inline prompt IN this same panel instead of a separate box.
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">To</span><span>{s.to || s.channel}</span></div> : null}
                            {s.app === "gmail" ? (
                              <input className="addinput sm draft-subject" placeholder="Subject" disabled={revising}
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
                                <button className="btn primary xs" disabled={savingDraft === i} onClick={() => void saveDraftEdit(i)}>{savingDraft === i ? "Saving…" : "Save changes"}</button>
                                <button className="btn xs ghost" disabled={savingDraft === i} onClick={() => setDraftEdits((d) => { const { [i]: _, ...rest } = d; return rest; })}>Discard</button>
                              </div>
                            ) : null}
                            {changeIdx === i ? (
                              <div className="rewrite-row">
                                <input className="addinput sm" autoFocus disabled={revising}
                                  placeholder="Tell Otto what to change — e.g. add my flight times, make it shorter, fix the date"
                                  value={changeText} onChange={(e) => setChangeText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") void doRevise(); }} />
                                {!revising && <button className="btn primary xs" disabled={!changeText.trim()} onClick={() => void doRevise()}>Revise</button>}
                                <button className="btn xs ghost" disabled={revising} onClick={() => { setChangeIdx(null); setChangeText(""); setReviseError(null); }}>Cancel</button>
                                {reviseError ? <div className="rewrite-error">{reviseError}</div> : null}
                              </div>
                            ) : !revising ? (
                              <button className="btn xs ghost rewrite-toggle" onClick={() => { setChangeText(""); setReviseError(null); setChangeIdx(i); }}>Ask Otto to rewrite it →</button>
                            ) : null}
                            {revising && changeIdx === i ? <div className="rewrite-progress" title="Otto is rewriting the draft…" /> : null}
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
              <span className={`caret ${contextOpen ? "open" : ""}`}>›</span> Context
              {task.source ? <span className="chip chip-muted context-source">{sourceBadge(task.source)}</span> : null}
            </h4>
            {contextOpen ? (
              <div className="context-body">
                {task.context?.trim() ? <p className="context-text">{withInlineLinks(task.context)}</p> : null}
                {historyLoading ? (
                  <p className="muted small">Loading history…</p>
                ) : history?.length ? (
                  <ul className="history-list">
                    {history.map((e, i) => (
                      <li key={i}><span className="history-when">{relTime(e.at)}</span> {e.message || e.kind}</li>
                    ))}
                  </ul>
                ) : !task.context?.trim() ? <p className="muted small">Nothing recorded yet.</p> : null}
              </div>
            ) : null}
          </section>
          {steps.length > 0 && (
          <section>
            <h4>What's left{openableCount >= 2 && <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>Open all {openableCount} ↗</button>}</h4>
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
                        title={s.done ? `Done${s.doneAt ? " " + relTime(s.doneAt) : ""} — click to undo` : blk ? "Waiting on an earlier step" : "Click to mark done"}
                        disabled={blk}
                        onClick={() => { if (blk) return; s.done ? void act(() => api.stepDone(task.id, i, false)) : void markStepDone(i); }}
                      >
                        {s.done ? "✓" : ""}
                      </button>
                      <div className="step-body">
                        <span className="step-text">{withInlineLinks(s.text)}</span>
                        {s.done && s.doneAt ? <span className="step-when">done {relTime(s.doneAt)}</span> : null}
                        {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                        {!s.done && blk ? <span className="step-dep">waits for step {(s.dependsOn ?? 0) + 1}</span> : null}
                        {/* "What did you decide?" only when this step GATES a later one — then it feeds that next step. */}
                        {gatesAnother && !s.done && !blk && !s.automatable ? (
                          <input
                            className="step-input"
                            placeholder="What did you decide? (feeds the next step)"
                            value={decided[i] || ""}
                            onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") void markStepDone(i); }}
                          />
                        ) : null}
                      </div>
                      <div className="step-act">
                        {/* A URL step keeps its "Open ↗" link ALWAYS — even after Otto opened it — so the page
                            stays reachable from the task. */}
                        {s.url ? <button className="btn xs ghost" title={s.url} onClick={() => openTab(s.url!, TAB_GROUP)}>Open {linkKind(s.url) || "link"} ↗</button> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
          </section>
          )}
          {/* "What Otto did" shows real output — a resource doc/sheet it created, or other concrete actions.
              Plan-only mode's one allowed write is creating a new resource doc, so this is genuine, not a stub. */}
          {(task.did?.length || task.links?.length) ? (
            <section>
              <h4>What Otto did</h4>
              {task.did?.length ? <ul className="bullets">{task.did.map((d, i) => <li key={i}>{withInlineLinks(d)}</li>)}</ul> : null}
              {task.links?.length ? (
                <ul className="links artifacts">{task.links.slice(0, 3).map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer" title={l.url}>{(l.label && l.label !== "Open" ? l.label : linkKind(l.url)) || "Open link"} ↗</a></li>)}</ul>
              ) : null}
            </section>
          ) : null}
          {inModal && !isDone ? (
            // Supportive, task-scoped chat: talking through THIS task specifically ("I'm stuck on step 2",
            // "can you break this down more?") without having to re-explain what it is — Otto already has
            // the full context above. Never shown for a finished/dismissed task — nothing left to coach.
            <section className="task-chat">
              <h4>Ask Otto about this</h4>
              <div className="chat-thread">
                {!task.chat?.length ? (
                  <p className="muted small">Stuck, overwhelmed, or just want a plan for tackling this? Ask below.</p>
                ) : task.chat.map((m, i) => (
                  <div key={i} className={`chat-msg chat-${m.role}`}>{m.text}</div>
                ))}
                {chatSending ? <div className="chat-msg chat-assistant chat-typing">…</div> : null}
                <div ref={chatEndRef} />
              </div>
              {chatError ? <div className="rewrite-error">{chatError}</div> : null}
              <div className="chat-row">
                <input
                  className="chat-input" placeholder="e.g. I'm stuck getting started on this…"
                  value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                  disabled={chatSending}
                />
                <button className="btn primary xs" disabled={chatSending || !chatInput.trim()} onClick={() => void sendChat()}>Send</button>
              </div>
            </section>
          ) : null}
          <div className="actions">
            {isDone ? (
              // A finished task is CLOSED, not just another item with the usual buttons — "Run now" here
              // read as an invitation to re-do already-done work (drafting a duplicate, re-creating a doc),
              // and "Dismiss" doesn't mean anything for something that already happened. Just say when.
              <span className="done-footer">{task.status === "dismissed" ? "Dismissed" : "Completed"}{task.updatedAt ? ` ${relTime(task.updatedAt)}` : ""}</span>
            ) : cStatus === "needs_review" ? (
              <>
                <button className="btn primary" title="Looks good — mark this handled" onClick={() => void leave(() => api.confirm(task.id), "confirm")}>Looks good</button>
                <div className="actions-rest">
                  <button className="btn xs ghost" title="Remove this task" onClick={() => void leave(() => api.dismiss(task.id))}>Dismiss</button>
                </div>
              </>
            ) : (
              <>
                {cStatus === "failed_retryable" && retrying ? (
                  <button className="btn primary" disabled>Retrying…</button>
                ) : cStatus === "failed_terminal" || cStatus === "failed_retryable" ? (
                  <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? "Working…" : "Retry"}</button>
                ) : isInFlight(task.status) ? (
                  <button className="btn primary" disabled>{cStatus === "queued" ? "Queued…" : "Working…"}</button>
                ) : (
                  <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? "Working…" : "Run now"}</button>
                )}
                <div className="actions-rest">
                  <button className="btn xs ghost" title="Remove this task" onClick={() => void leave(() => api.dismiss(task.id))}>Dismiss</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
