import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import type { WebTask, ConnectionStatus, Profile, TaskStep } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, sortWithinQuadrant } from "../shared/types.ts";
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
function Bullets({ text }: { text: string }) {
  const items = (text || "").split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
  if (items.length <= 1) return <p>{items[0] || text}</p>;
  return <ul className="bullets">{items.map((b, i) => <li key={i}>{b}</li>)}</ul>;
}

/** The Otto mark — a to-do list (three dots + lines) with a check sweeping through the last item.
 *  Uses currentColor so it inherits the brand text colour (and inverts in dark mode). */
function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="3.7" cy="6" r="1.85" fill="currentColor" />
      <circle cx="3.7" cy="12" r="1.85" fill="currentColor" />
      <circle cx="3.7" cy="18" r="1.85" fill="currentColor" />
      <rect x="7.6" y="4.75" width="10.4" height="2.5" rx="1.25" fill="currentColor" />
      <rect x="7.6" y="10.75" width="11.6" height="2.5" rx="1.25" fill="currentColor" />
      <rect x="7.6" y="16.75" width="3.3" height="2.5" rx="1.25" fill="currentColor" />
      <path d="M10 16 L13.7 19.7 L21.6 10.2" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
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

export function App() {
  const [status, setStatus] = useState<ConnectionStatus | null>(CACHED_STATUS);
  const [route] = usePathRoute();
  const [tasks, setTasks] = useState<WebTask[]>(CACHED_TASKS);
  const [loaded, setLoaded] = useState(false);   // server truth arrived (cached list may be stale until then)
  const [scanning, setScanning] = useState(false); // the daily background sweep is running
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [extOn, setExtOn] = useState(extPresent()); // is the Otto Tabs extension present? (it sets data-weave-ext)
  const [onboard, setOnboard] = useState(() => { try { return localStorage.getItem("otto-onboard") === "1"; } catch { return false; } });
  const [loadError, setLoadError] = useState(false); // backend unreachable after retries → show a retry screen
  const [reloadKey, setReloadKey] = useState(0);      // bump to re-attempt the status fetch
  // AI budget (from the CLOUD-authoritative /api/usage) — drives the "budget reached" banner + renewal date,
  // so it reflects usage racked up by background jobs, not just this session.
  const [budget, setBudget] = useState<{ over: boolean; renewsOn: string } | null>(null);
  const loadBudget = useCallback(async () => { try { const u = await api.usage(); setBudget({ over: u.over, renewsOn: u.renewsOn }); } catch { /* keep last */ } }, []);
  // First-run onboarding is the ONE place Otto is explained — set on signup, cleared when the flow finishes.
  const startOnboard = () => { try { localStorage.setItem("otto-onboard", "1"); } catch { /* ignore */ } setOnboard(true); };
  const finishOnboard = () => { try { localStorage.removeItem("otto-onboard"); } catch { /* ignore */ } setOnboard(false); };
  const [showCompleted, setShowCompleted] = useState(false);
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

  // Pull the server's task list (cheap GET; also reconciles cross-device state server-side). Always resolves
  // `loaded` — even on an empty/failed fetch — so the loading screen can never hang half-forever (the
  // 15-min tick + focus re-sync retry a transient miss).
  const syncTasks = useCallback(async () => {
    const t = await api.tasks().catch(() => null);
    if (t) setTasks(retryFlags(t));
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
    try { if (Date.now() - Number(localStorage.getItem("otto-lastgen") || 0) < SWEEP_EVERY_MS) return; } catch { /* sweep anyway */ }
    sweeping.current = true;
    setScanning(true);
    try {
      const { tasks: fresh, note: serverNote } = await api.generate();
      setTasks(retryFlags(fresh)); setLoaded(true);
      // A skipped sweep must say WHY (e.g. "nothing connected") — never look like a quiet all-clear.
      if (/^(skipped:|sweep )/.test(serverNote)) setNote(sweepSkipMessage(serverNote));
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
    const tick = setInterval(on, 15 * 60_000); // long-lived tab: keep watching without any user action
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); clearInterval(tick); };
  }, [connected, syncTasks, sweepIfDue]);

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
          // Keep the user's local done/dismiss decisions — never resurrect a card they closed.
          setTasks((prev) => out.tasks.map((u) => {
            const cur = prev.find((p) => p.id === u.id);
            return cur && isHandled(cur.status) && !isHandled(u.status) ? cur : u;
          }));
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
    setBusy(true); setNote("");
    try {
      const before = new Set(tasks.map((t) => t.id));
      const { tasks: t, note: serverNote } = await api.generate(true);
      setTasks(t); setLoaded(true);
      // A manual Refresh counts as a sweep — reset the watch interval so the background one doesn't repeat it.
      try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ }
      // Run summary — honest, specific feedback on what the sweep did (the trust-building layer).
      // A SKIPPED sweep says why (nothing connected / paused) instead of masquerading as "no new tasks".
      const fresh = t.filter((x) => !before.has(x.id) && !isHandled(x.status));
      const queuedN = fresh.filter((x) => isInFlight(x.status)).length;
      const needsYou = t.filter((x) => canonStatus(x.status) === "needs_review" && (x.steps?.some((s) => !s.done && !s.automatable) || x.sendables?.some((s) => !s.sent))).length;
      if (/^(skipped:|sweep )/.test(serverNote)) setNote(sweepSkipMessage(serverNote));
      else if (!t.length) setNote("Nothing actionable in your recent inbox + calendar right now.");
      else if (!fresh.length) setNote(`Swept your apps — no new tasks${needsYou ? `; ${needsYou} still need${needsYou === 1 ? "s" : ""} you` : "; everything actionable is already on your list"}.`);
      else setNote(`Found ${fresh.length} new task${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} queued to run` : ""}${needsYou ? `, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}.`);
      void loadBudget();
    }
    catch (e: any) { setNote(`Couldn't generate tasks: ${e?.message || "error"}`); }
    finally { setBusy(false); }
  };
  const signOut = async () => { await api.logout(); setTasks([]); setLoaded(false); generatedOnce.current = false; navigate(""); void loadStatus(); };

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
  const openId = route.startsWith("task/") ? route.slice(5) : null; // the deep-linked task, if any

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={20} /> Otto</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} href="/tasks">Tasks</a>
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
            const shown = openId && !live.some((t) => t.id === openId)
              ? [...live, ...tasks.filter((t) => t.id === openId)]
              : live;
            // Until the first server response, an empty list means "still loading", not "all clear" —
            // show the skeleton instead of flashing the empty state.
            if (shown.length === 0 && (busy || !loaded)) return <TaskSkeleton />;
            if (shown.length === 0) {
              const who = status.name || firstName(status.user);
              // First run (nothing ever completed) reads differently from a genuinely cleared list.
              if (note) return <div className="empty">{note}</div>;
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
            // No priority bands — the list is simply ranked most-important first (sortWithinQuadrant). One
            // clean list, no section headers.
            return <div className={`list ${settled ? "settled" : ""}`}>{shown.map((t) => (
                  <Card
                    key={t.id}
                    task={t}
                    retrying={retryingIds.includes(t.id)}
                    open={t.id === openId}
                    onToggle={() => navigate(t.id === openId ? "" : `task/${t.id}`)}
                    onChange={setTasks}
                    onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                  />
                ))}</div>;
          })()}
          {completed.length > 0 && (
            <div className="completed-section">
              <h3 className="completed-head">Completed</h3>
              {/* Minimalist done-list: checked rows like a to-do app, not full cards. Click to expand details. */}
              <div className="done-list">{(showCompleted ? completed : completed.slice(0, 8)).map((t) => (
                <Fragment key={t.id}>
                  <div className="done-row" onClick={() => navigate(t.id === openId ? "" : `task/${t.id}`)} title={t.synthesis || t.why}>
                    <span className="done-check">✓</span>
                    <span className="done-title">{t.title}</span>
                    <span className="done-when">{relTime(t.updatedAt || t.createdAt)}</span>
                  </div>
                  {t.id === openId && (
                    <Card task={t} open onToggle={() => navigate("")} onChange={setTasks}
                      onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))} />
                  )}
                </Fragment>
              ))}</div>
              {completed.length > 8 && !showCompleted && (
                <button className="btn xs ghost" onClick={() => setShowCompleted(true)}>Show all {completed.length}</button>
              )}
            </div>
          )}
        </main>
      )}
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
      <p>Connect Gmail and Otto gets to work — reading your apps and drafting your to-dos. It never sends anything without you.</p>
      {!status.googleConfigured && <div className="warn">Integrations aren't configured on the server (COMPOSIO_API_KEY).</div>}
      {!status.aiReady && <div className="warn">Server is missing DEEPSEEK_API_KEY — task generation is disabled.</div>}
      <a className="btn primary big" href="/settings">Connect Gmail</a>
    </div>
  );
}

/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
function SettingsPage({ status, onSignOut, onChanged, extOn }: { status: ConnectionStatus; onSignOut: () => void; onChanged: () => void; extOn: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string } | null>(null);
  const [showKnows, setShowKnows] = useState(false);
  // Optimistic toggles/selects — flip instantly, reconcile with the server after (no round-trip lag).
  const [paused, setPausedLocal] = useState(status.paused);
  const [genPerDay, setGenPerDay] = useState(Math.min(4, Math.max(1, status.genPerDay || 1)));
  const [autoOpen, setAutoOpen] = useState(autoOpenDocsOn());
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { setGenPerDay(Math.min(4, Math.max(1, status.genPerDay || 1))); }, [status.genPerDay]);
  useEffect(() => { void api.profile().then(setProfile); void api.usage().then(setUsage).catch(() => {}); }, []);
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
      </section>

      <section className="settings-sec">
        <h3>Apps</h3>
        <p className="settings-hint">Otto reads your apps and does reversible work — it <b>never sends, posts, or deletes</b> on its own.</p>
        <Integrations onChanged={onChanged} />
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
function AppAccounts({ app, onChanged }: { app: string; onChanged?: () => void }) {
  const [accts, setAccts] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setAccts((await api.integrationAccounts(app)).accounts); } catch { setAccts([]); } }, [app]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const on = () => { if (!document.hidden) void load(); }; window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [load]);
  const disc = async (id: string) => { setBusy(id); try { await api.disconnectAccount(app, id); await load(); onChanged?.(); } finally { setBusy(""); } };
  if (!accts?.length) return null;
  return (
    <div className="int-accounts">
      {accts.map((a, i) => (
        <div key={a.id} className="int-acct">
          <span className="int-acct-email">{a.email || (accts.length > 1 ? `Account ${i + 1}` : "Connected")}</span>
          <button className="btn xs ghost" disabled={busy === a.id} onClick={() => void disc(a.id)}>{busy === a.id ? "…" : "Disconnect"}</button>
        </div>
      ))}
    </div>
  );
}

/** Integrations grid (Composio): one tile per app, grouped by category. Connect = OAuth; Disconnect = revoke. */
function Integrations({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<IntegrationItem[] | null>(null);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { const r = await api.integrations(); setItems(r.items); setReady(r.ready); onChanged?.(); }
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
                {i.connected && <AppAccounts app={i.key} onChanged={load} />}
              </Fragment>
            ))}
          </div>
        </div>
      ))}
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
            <p className="onboard-lead">The to-do list that does itself. Otto reads your apps, does the reversible work, and surfaces only what needs you.</p>
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
        <h1 className="hero-title hero-in" style={{ ["--d" as any]: "0.05s" }}>The to-do list that <em>does itself</em>.</h1>
        <p className="hero-sub hero-in" style={{ ["--d" as any]: "0.15s" }}>Otto reads your inbox, calendar and Drive — then gets ahead of the work. It drafts the replies, preps the docs, and clears your list before you have to ask.</p>
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

      {/* Second product visual — the actual list, already handled. Shows the three states in context. */}
      <section className="landing-sec">
        <h2 className="reveal">Open Otto. It's already done.</h2>
        <p className="lead reveal">No blank inbox to wade through. The replies are drafted, the docs are prepped — only the calls that need you are left.</p>
        <div className="landing-tasks reveal" style={{ ["--d" as any]: "0.08s" }} aria-hidden="true">
          <div className="lt-row"><span className="lt-dot need" /><div className="lt-text"><span className="lt-title">Reply to Sarah about the Q3 budget</span><span className="lt-sub">Draft ready in your voice</span></div><span className="lt-chip">Review</span></div>
          <div className="lt-row"><span className="lt-dot done" /><div className="lt-text"><span className="lt-title">Prep the vendor comparison doc</span><span className="lt-sub">Built from three email threads</span></div><span className="lt-chip">Done for you</span></div>
          <div className="lt-row"><span className="lt-dot need" /><div className="lt-text"><span className="lt-title">Approve the invoice from Northwind</span><span className="lt-sub">Needs your OK before it's paid</span></div><span className="lt-chip">Needs you</span></div>
          <div className="lt-row is-done"><span className="lt-dot check">✓</span><div className="lt-text"><span className="lt-title">Send the signed contract to legal</span></div><span className="lt-when">2h ago</span></div>
        </div>
      </section>

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
        <p className="lead reveal">Connect once. From then on Otto watches the things that actually need you — and quietly gets ahead of them.</p>
        <div className="how">
          <div className="how-step reveal" style={{ ["--d" as any]: "0.0s" }}><div className="n">01</div><h3>It reads your world</h3><p>Inbox, calendar and Drive — pulling out the few things that genuinely need a reply, a decision, or prep.</p></div>
          <div className="how-step reveal" style={{ ["--d" as any]: "0.1s" }}><div className="n">02</div><h3>It does the work</h3><p>Drafts the reply in your voice, builds the doc, gathers the context — then shows you exactly what it did.</p></div>
          <div className="how-step reveal" style={{ ["--d" as any]: "0.2s" }}><div className="n">03</div><h3>You just confirm</h3><p>Open a draft, tweak it, send. Anything only you can do is laid out as a short, tickable checklist.</p></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">Built to be trusted</h2>
        <div className="features">
          <div className="feature reveal" style={{ ["--d" as any]: "0.0s" }}><div><h3>Drafts, never sends</h3><p>Every email is a draft you review. Nothing leaves your account without your explicit OK.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.1s" }}><div><h3>Learns who you are</h3><p>It remembers your people, projects and preferences, so its work sounds like you — and sharpens over time.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.2s" }}><div><h3>Your account, your data</h3><p>Saved privately to your account. It reads your apps and creates drafts &amp; docs — nothing destructive.</p></div></div>
        </div>
      </section>

      <section className="cta-band reveal">
        <h2>Stop managing your to-do list.</h2>
        <p>Connect Gmail and let Otto clear what it can — you just confirm the rest. Free to start, ready in a minute.</p>
        <a className="btn big cta-band-btn" href="/signup">Get started — it's free</a>
        <div className="cta-fine">No credit card · Otto never sends without you</div>
      </section>

      <div className="landing-foot">
        <div>Otto — the to-do list that does itself.</div>
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
const LEGAL_UPDATED = "July 22, 2026";

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
        <li><b>Google Drive / Docs / Sheets / Slides</b> — to read relevant files and create or update documents it makes for you.</li>
        <li><b>Other integrations you connect</b> — accessed only for the tasks they relate to.</li>
      </ul>
      <p>Otto performs <b>reversible</b> work autonomously (drafts, documents, research). Anything irreversible — sending an email, posting, inviting, deleting, or paying — is <b>never</b> done without your explicit confirmation.</p>

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
      <p>Your data is kept while your account is active. You can clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time, or request full account deletion by contacting us at {LEGAL_EMAIL}. Disconnecting an app immediately revokes Otto's access to it.</p>

      <h2>Security</h2>
      <p>Connections use OAuth (we never see your app passwords). Data is transmitted over HTTPS and access is scoped to your account. No system is perfectly secure, but we take reasonable measures to protect your information.</p>

      <h2>Google API disclosure</h2>
      <p>Otto's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

      <h2>Your rights & contact</h2>
      <p>Depending on your jurisdiction ({LEGAL_JURISDICTION}), you may have rights to access, correct, or delete your data. To exercise them, contact {LEGAL_EMAIL}. We'll update this policy as the service evolves and note the date above.</p>
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

const SOURCE: Record<string, string> = {
  gmail: "Gmail", calendar: "Calendar", googlecalendar: "Calendar", manual: "You",
  slack: "Slack", discord: "Discord", twitter: "X", linkedin: "LinkedIn",
  github: "GitHub", linear: "Linear", jira: "Jira", notion: "Notion",
  todoist: "Todoist", asana: "Asana", trello: "Trello", clickup: "ClickUp",
  perplexity: "Perplexity", calendly: "Calendly", hubspot: "HubSpot", airtable: "Airtable",
  googledocs: "Docs", googledrive: "Drive", googlesheets: "Sheets", googleslides: "Slides",
};
/** A friendly label for a task's source app — known apps get an emoji/name, anything else is Title-cased. */
const sourceLabel = (s: string) => SOURCE[s] || (s ? s[0].toUpperCase() + s.slice(1) : "Task");

/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Otto fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => { void api.profile().then(setP).catch(() => setP(null)); }, []);
  if (!p) return <p className="muted small">Loading…</p>;
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length;
  const lists = [
    { key: "preference" as const, label: "Preferences", items: p.preferences },
    { key: "person" as const, label: "People", items: p.people },
    { key: "project" as const, label: "Projects", items: p.projects },
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

function AddTask({ onAdded }: { onAdded: (t: WebTask[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try { onAdded(await api.add(v)); setText(""); } finally { setBusy(false); }
  };
  return (
    <div className="add-task-row">
      <span className="add-plus" aria-hidden="true">+</span>
      <input
        className="add-task-input"
        placeholder="Add a task…"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      {text.trim() && <button className="btn xs primary" disabled={busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add"}</button>}
    </div>
  );
}

function Card({ task, open, onToggle, onChange, onTask, retrying }: { task: WebTask; open: boolean; onToggle: () => void; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void; retrying?: boolean }) {
  const [running, setRunning] = useState(false);
  const [stepBusy, setStepBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number[]>([]); // steps whose auto-do errored — don't auto-retry
  const [decided, setDecided] = useState<Record<number, string>>({}); // what the user typed for a manual step
  const [showContext, setShowContext] = useState(false); // Context is hidden by default — shown only on demand
  const [sending, setSending] = useState<number | null>(null); // which sendable is being sent
  const [viewDraft, setViewDraft] = useState<number | null>(null); // which sendable's draft is expanded for review
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null); // which sendable is awaiting send confirmation
  const [changeIdx, setChangeIdx] = useState<number | null>(null);   // which sendable's "what to change" box is open
  const [changeText, setChangeText] = useState("");
  const [revising, setRevising] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [refining, setRefining] = useState(false);
  const refine = async () => {
    setRefining(true);
    try { onChange(await api.refine(task.id)); } catch { /* stays unrefined; can retry */ }
    finally { setRefining(false); }
  };
  const act = async (fn: () => Promise<WebTask[]>) => { onChange(await fn()); };
  // Confirm ("Looks good") / Dismiss: play the quick exit animation WHILE the API call runs, then remove
  // the card — so it visibly slides away instead of blinking out (or lingering).
  const leave = async (fn: () => Promise<WebTask[]>) => {
    if (leaving) return;
    setLeaving(true);
    const [list] = await Promise.all([fn(), new Promise((r) => setTimeout(r, 280))]);
    onChange(list);
  };
  // Mark a manual step done, recording what the user decided (so dependent auto-steps can use it).
  const markStepDone = (i: number) => act(() => api.stepDone(task.id, i, true, (decided[i] || "").trim() || undefined));
  const run = async () => { setRunning(true); try { onTask(await api.run(task.id)); } finally { setRunning(false); } };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    try { onTask(await api.sendDraft(task.id, i)); } catch { /* retried by api */ } finally { setSending(null); }
  };
  // The user declined and said what to change → re-run the task with that note so Otto revises the draft.
  const doRevise = async () => {
    const note = changeText.trim();
    if (!note || revising) return;
    setRevising(true);
    // The re-draft replaces the sendables list, so clear any open draft preview (its index may now be stale).
    try { onTask(await api.revise(task.id, note)); setChangeIdx(null); setChangeText(""); setViewDraft(null); }
    catch { /* surfaced via task state */ } finally { setRevising(false); }
  };

  const steps = task.steps || [];
  const blocked = (s: TaskStep) => s.dependsOn != null && !steps[s.dependsOn]?.done;
  // "Open example.com ↗" instead of a bare "Open ↗" — the user sees WHERE each step goes before clicking.
  const urlHost = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
  // Name WHAT a link is, not just where it points — "Google Doc" beats "docs.google.com" on the card.
  const linkKind = (u?: string): string => {
    const s = u || "";
    if (/docs\.google\.com\/document/.test(s)) return "Google Doc";
    if (/docs\.google\.com\/spreadsheets/.test(s)) return "Google Sheet";
    if (/docs\.google\.com\/presentation/.test(s)) return "Google Slides";
    if (/docs\.google\.com\/forms|forms\.gle/.test(s)) return "Google Form";
    if (/mail\.google\.com/.test(s)) return /#drafts/.test(s) ? "Gmail draft" : "Gmail thread";
    if (/calendar\.google\.com/.test(s)) return "Calendar event";
    if (/drive\.google\.com/.test(s)) return "Drive file";
    if (/maps\.google\.com|google\.com\/maps/.test(s)) return "Directions";
    if (/^tel:/.test(s)) return "Call";
    if (/github\.com\/[^/]+\/[^/]+\/pull/.test(s)) return "Pull request";
    if (/github\.com\/[^/]+\/[^/]+\/issues/.test(s)) return "GitHub issue";
    if (/[a-z0-9-]+\.slack\.com/.test(s)) return "Slack";
    if (/notion\.so/.test(s)) return "Notion page";
    return urlHost(s);
  };
  // A step can auto-run if it's automatable, unblocked, not done, not already-failed, doesn't need permission,
  // and (not a tab-open OR the extension is here to open it unattended). Tab-opens without the extension wait for a click.
  const canAuto = (s: TaskStep, i: number) => s.automatable && !s.needsPermission && !s.question && !s.done && !blocked(s) && !failed.includes(i) && (!s.url || extPresent());

  const doStep = async (i: number, answer?: string) => {
    const s = steps[i];
    if (!s || stepBusy != null) return;
    setStepBusy(i);
    try {
      // A helper link on a USER step (directions, a booking page…) just opens — the user still has to
      // do the real-world part, so only automatable page-opens self-complete.
      if (s.url) { openTab(s.url, TAB_GROUP); if (s.automatable) onChange(await api.stepDone(task.id, i, true, "Opened ↗")); }
      else { onTask(await api.runStep(task.id, i, answer)); }
    } catch { setFailed((f) => (f.includes(i) ? f : [...f, i])); } // stop auto-retrying; user can click to retry
    finally { setStepBusy(null); }
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

  // Auto-do: silently run the next automatable, unblocked step (one at a time). Manual steps + tab-opens
  // (without the extension) wait for you; completing a manual prerequisite unblocks its dependents.
  useEffect(() => {
    if (cStatus !== "needs_review" || stepBusy != null) return;
    const i = steps.findIndex((s, idx) => canAuto(s, idx));
    if (i >= 0) void doStep(i);
  }, [task, stepBusy, failed]);

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
    <div ref={cardRef} className={`card ${open ? "open" : ""} ${isInFlight(task.status) ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${task.status === "dismissed" || leaving ? "dismissed" : ""}`}>
      <div className="card-main" onClick={onToggle}>
        <div className="card-text">
          <div className="card-title">{task.title}</div>
          {(() => { const sub = subtitle(task); const w = task.when ? fmtWhen(task.when) : ""; return (w || sub) ? <div className="card-sub">{w && <span className="when">{w}</span>}{sub}</div> : null; })()}
        </div>
        {!isDone && task.unrefined ? <span className="chip chip-muted" title="Added while AI was off — tap Refine to clean it up">Unrefined</span> : null}
        {chip ? <span className={`chip chip-${chip.tone}`}>{chip.label}</span> : null}
        {cStatus === "executing" ? <span className="card-spin" title="Working…" /> : null}
        {/* Quick dismiss — remove a task in one click without opening it. Hover-revealed so the row stays clean. */}
        {!isDone && <button className="card-x" title="Dismiss" aria-label="Dismiss task" onClick={(e) => { e.stopPropagation(); void leave(() => api.dismiss(task.id)); }}>×</button>}
        <span className="caret">›</span>
      </div>

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
                      <button className="btn xs ghost" onClick={() => setViewDraft((v) => (v === i ? null : i))}>{viewDraft === i ? "Hide details" : s.app === "gcal" ? "View event" : "View draft"}</button>
                      {s.sent
                        ? <button className="btn primary send-btn sent" disabled>Sent</button>
                        : sending === i
                          ? <button className="btn primary send-btn" disabled>Sending…</button>
                          : <button className="btn primary send-btn" onClick={() => { setChangeIdx(null); setConfirmIdx(confirmIdx === i ? null : i); }}>{`${sendIcon} ${s.label}`}</button>}
                    </div>
                    {/* Confirm step — the recipient is spelled out in full before anything sends. */}
                    {confirmIdx === i && !s.sent && sending !== i ? (
                      <div className="confirm">
                        <div className="confirm-q">Send this {noun} to <b>{recipients || "the recipient"}</b>?</div>
                        <div className="confirm-acts">
                          <button className="btn primary xs" onClick={() => void doSend(i)}>Yes, send</button>
                          <button className="btn xs" onClick={() => { setConfirmIdx(null); setChangeText(""); setChangeIdx(i); }}>No — change something</button>
                          <button className="btn xs ghost" onClick={() => setConfirmIdx(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                    {/* Declined → say what to change; Otto re-drafts (updates the existing draft) and re-offers it. */}
                    {changeIdx === i && !s.sent ? (
                      <div className="confirm">
                        <div className="confirm-q">What should change before sending?</div>
                        <div className="change-row">
                          <input className="addinput sm" autoFocus disabled={revising}
                            placeholder="e.g. add my flight times, make it shorter, fix the date"
                            value={changeText} onChange={(e) => setChangeText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") void doRevise(); }} />
                          <button className="btn primary xs" disabled={revising || !changeText.trim()} onClick={() => void doRevise()}>{revising ? "Revising…" : "Revise"}</button>
                          <button className="btn xs ghost" disabled={revising} onClick={() => { setChangeIdx(null); setChangeText(""); }}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                    {viewDraft === i ? (
                      <div className="draft">
                        {s.app === "gcal" ? (
                          <>
                            {s.summary ? <div className="draft-row"><span className="draft-label">Event</span><span>{s.summary}</span></div> : null}
                            {s.when ? <div className="draft-row"><span className="draft-label">When</span><span>{s.when}</span></div> : null}
                            {recipients ? <div className="draft-row"><span className="draft-label">Invites</span><span>{recipients}</span></div> : null}
                          </>
                        ) : (
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">To</span><span>{s.to || s.channel}</span></div> : null}
                            {s.subject ? <div className="draft-row"><span className="draft-label">Subject</span><span>{s.subject}</span></div> : null}
                            <pre className="draft-body">{s.body || s.text || "Draft is ready in Gmail — open it there to read the full text."}</pre>
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
          {steps.length > 0 && (
          <section>
            <h4>What's left{openableCount >= 2 && <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>Open all {openableCount} ↗</button>}</h4>
              <ul className="steps">
                {steps.map((s, i) => {
                  const blk = blocked(s);
                  const busyHere = stepBusy === i;
                  const gatesAnother = steps.some((o, j) => j !== i && o.dependsOn === i); // does a later step wait on this one?
                  return (
                    <li key={i} className={`step ${s.done ? "done" : ""} ${blk ? "blocked" : ""}`}>
                      {/* The mark IS the control for a needs-you step: click ○ to tick it done (no separate button). */}
                      <button
                        type="button"
                        className={`step-mark ${busyHere ? "busy" : ""} ${!s.done && !blk ? "tickable" : ""}`}
                        title={s.done ? `Done${s.doneAt ? " " + relTime(s.doneAt) : ""} — click to undo` : busyHere ? "Otto is doing this…" : blk ? "Waiting on an earlier step" : s.automatable ? (s.needsPermission ? "Needs your approval" : s.question ? "Otto needs one answer from you" : "Otto does this automatically — or click if you already did it") : "Click to mark done"}
                        disabled={busyHere || blk}
                        onClick={() => { if (blk || busyHere) return; s.done ? void act(() => api.stepDone(task.id, i, false)) : void markStepDone(i); }}
                      >
                        {s.done ? "✓" : ""}
                      </button>
                      <div className="step-body">
                        <span className="step-text">{s.text}</span>
                        {s.done && s.doneAt ? <span className="step-when">done {relTime(s.doneAt)}</span> : null}
                        {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                        {!s.done && blk ? <span className="step-dep">waits for step {(s.dependsOn ?? 0) + 1}</span> : null}
                        {/* Otto needs ONE detail to do this step itself — tap a likely answer or type one; answering runs it. */}
                        {s.question && !s.done && !blk && !busyHere ? (
                          <div className="step-q">
                            <span className="step-q-text">{s.question}</span>
                            {s.options?.length ? (
                              <div className="step-q-opts">
                                {s.options.map((o, k) => (
                                  <button key={k} className="btn xs opt" disabled={stepBusy != null} onClick={() => void doStep(i, o)}>{o}</button>
                                ))}
                              </div>
                            ) : null}
                            <div className="step-q-free">
                              <input
                                className="step-input"
                                placeholder={s.options?.length ? "Or type your own answer…" : "Type your answer — Otto takes it from there"}
                                value={decided[i] || ""}
                                disabled={stepBusy != null}
                                onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter" && (decided[i] || "").trim()) void doStep(i, decided[i].trim()); }}
                              />
                              <button className="btn xs primary" disabled={stepBusy != null || !(decided[i] || "").trim()} onClick={() => void doStep(i, decided[i].trim())}>Answer</button>
                            </div>
                          </div>
                        ) : null}
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
                            stays reachable from the task. Done/blocked: just reopen the tab; otherwise open + mark done. */}
                        {busyHere ? <span className="muted small">Working…</span>
                          : s.url ? <button className="btn xs ghost" title={s.url} onClick={() => (s.done || blk) ? openTab(s.url!, TAB_GROUP) : void doStep(i)}>Open {linkKind(s.url) || "link"} ↗</button>
                          : s.done || blk ? null
                          : s.automatable ? (s.needsPermission ? <button className="btn xs primary" onClick={() => void doStep(i)}>Approve & Run</button> : s.question ? null : <button className="btn xs ghost" onClick={() => void doStep(i)}>Auto-do</button>)
                          : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
          </section>
          )}
          {/* "What Otto did" shows ONLY meaningful output — actions it actually produced/prepped, or the
              artifacts it made. Dead-end attempts (failed searches) are filtered out server-side; when there's
              nothing meaningful to show, the section is hidden entirely (the story lives in "What's left"). */}
          {(task.did?.length || task.links?.length) ? (
            <section>
              <h4>What Otto did</h4>
              {task.did?.length ? <ul className="bullets">{task.did.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
              {task.links?.length ? (
                <ul className="links artifacts">{task.links.slice(0, 3).map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer" title={l.url}>{(l.label && l.label !== "Open" ? l.label : linkKind(l.url)) || "Open link"} ↗</a></li>)}</ul>
              ) : null}
            </section>
          ) : (cStatus === "queued" || cStatus === "executing") ? (
            <section><h4>What Otto did</h4><p className="muted">{cStatus === "queued" ? "Queued — starting shortly…" : "Working on it now…"}</p></section>
          ) : null}
          <button className="ctx-toggle" onClick={() => setShowContext((v) => !v)}>{showContext ? "Hide context" : "Show context"}</button>
          {showContext && (
            <section className="ctx">
              <div className="ctx-src">{sourceLabel(task.source)}</div>
              <Bullets text={task.context || task.why} />
              {task.evidence?.length ? (
                <ul className="links src-links">{task.evidence.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></li>)}</ul>
              ) : null}
            </section>
          )}
          <div className="actions">
            {cStatus === "needs_review" ? (
              <>
                <button className="btn primary" title="Looks good — mark this handled" onClick={() => void leave(() => api.confirm(task.id))}>Looks good</button>
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
                  {task.unrefined && !isInFlight(task.status) ? (
                    <button className="btn xs" title="Have Otto clean up this task's title and priority" disabled={refining} onClick={() => void refine()}>{refining ? "Refining…" : "Refine"}</button>
                  ) : null}
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
