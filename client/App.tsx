import { useEffect, useState, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, isLowGrade, isPeakHourUtc, sortWithinQuadrant, gradesBySubject } from "../shared/types.ts";
import { api, type IntegrationItem, type ConnectedAccount } from "./api.ts";
import { LangContext, useLang, todayIso, fmtDate, relTime, TaskModal } from "./ui.tsx";
import { TaskCardRow, TaskFocus } from "./TaskCard.tsx";

/** Scroll-reveal: any element with className "reveal" inside this component fades/rises into place the
 *  first time it enters the viewport (CSS does the actual animation — see `.reveal`/`.reveal.in` in
 *  styles.css). Originally inline in the marketing Landing page; pulled out so the same premium-feel
 *  entrance can be reused across the real app (Settings, the dashboard's own sections) without copying the
 *  IntersectionObserver wiring. Respects prefers-reduced-motion (reveals everything immediately, no motion). */
function useReveal(deps: readonly unknown[] = []) {
  useEffect(() => {
    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
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

// A "YYYY-MM-DD" (or ISO) date → "Aug 1". Used for the AI-budget renewal date.
function fmtDay(iso: string): string {
  const d = new Date(/T/.test(iso) ? iso : `${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Open a URL in a new tab. Prefers the Otto Chrome extension (web/extension/) — it sets a DOM flag and
// relays postMessage to chrome.tabs.create, so tabs can open UNATTENDED during auto-do. Without it, falls
// back to window.open (works on a user click).
// Temporary: Otto still generates, ranks, and breaks tasks into steps, but does not auto-run or offer
// one-click execution of them — the card shows the plan as a checklist for the user to work through
// themselves. Flip back to true to restore auto-do/Approve & Run/Send. Nothing execution-related is deleted.
const EXECUTION_ENABLED = false;



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
  // index.html hardcodes lang="fr" (the app's actual default), but the EN toggle never followed it — an
  // English-mode user got French pronunciation applied to English text by every screen reader. This is the
  // one place the whole app's active language is decided (the LangContext.Provider value below), so it's
  // the right place to keep the document attribute in sync with it.
  useEffect(() => { document.documentElement.lang = status?.language === "en" ? "en" : "fr"; }, [status?.language]);
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
      // "sweep running: ..." means a sweep is genuinely still mid-flight (another tab, cron, or this
      // account's one-active-sweep idempotency lock) — NOT a failure. Surfacing it as "Sweep didn't finish"
      // read as broken when nothing actually is; the honest thing is to say nothing and let it keep going —
      // its result lands on the next sync/kick same as always. Also skip the lastgen stamp so THIS device
      // retries again shortly instead of believing today's sweep already happened.
      if (/^sweep running:/.test(serverNote)) return;
      // A skipped sweep must say WHY (e.g. "nothing connected") — never look like a quiet all-clear.
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, status?.language === "en"), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
      try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ }
    } catch { /* marker stays unset — next focus/interval tick retries */ }
    finally { sweeping.current = false; setScanning(false); }
  }, [connected, status?.paused, SWEEP_EVERY_MS]);

  // Once Google is connected: load tasks + budget, trigger the daily sweep (silent, in background).
  // These three are INDEPENDENT requests — `await syncTasks()` before starting the other two used to
  // serialize budget/sweep behind the task-list fetch for no reason, adding its full round-trip to time-
  // to-first-paint of unrelated UI (the budget banner, the sweep indicator). Fire all three at once.
  useEffect(() => {
    if (!connected) return;
    void syncTasks(); void loadBudget(); void sweepIfDue();
  }, [connected, status?.aiReady, syncTasks, sweepIfDue, loadBudget]);

  // Returning to the tab re-syncs the list (tasks finished elsewhere appear WITHOUT a manual reload) and
  // sweeps again if the watch interval has passed — so Otto keeps watching throughout the day, and the
  // list is never stuck waiting for a tab-switch to show up.
  useEffect(() => {
    if (!connected) return;
    const on = () => { if (!document.hidden) { void syncTasks(); void loadStatus(); void loadBudget(); void sweepIfDue(); } };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    // A backend-generated task (from cron, another device, or a queued-but-not-auto-run item) is only ever
    // shown by a task re-fetch. The old 15-min tick meant such a task could sit INVISIBLE on an open, idle
    // tab for up to 15 minutes ("it generated but doesn't show"). Poll the cheap /api/tasks GET every 45s so
    // new tasks surface quickly; the heavier sweep it also triggers stays gated by the user's cadence
    // (sweepIfDue is a fast no-op until due), so this doesn't sweep more often. Also re-pull /api/status on
    // the same tick — account-level fields (language, in particular) can change in another tab/device, and
    // without this an already-open session would show a stale language until reload.
    const syncTick = setInterval(() => { if (!document.hidden) { void syncTasks(); void loadStatus(); } }, 45_000);
    const fullTick = setInterval(on, 5 * 60_000); // periodic budget refresh + cadence-gated sweep check
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); clearInterval(syncTick); clearInterval(fullTick); };
  }, [connected, syncTasks, sweepIfDue, loadBudget, loadStatus]);

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
      const stillRunning = /^sweep running:/.test(serverNote); // a concurrent sweep is already mid-flight — not a failure
      // A manual Refresh counts as a sweep — reset the watch interval so the background one doesn't repeat it.
      // Skip that when a sweep is still running: THIS click didn't actually get a result, so let the watch
      // interval try again soon instead of believing a sweep already completed.
      if (!stillRunning) { try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ } }
      // Run summary — honest, specific feedback on what the sweep did (the trust-building layer).
      // A SKIPPED sweep says why (nothing connected / paused) instead of masquerading as "no new tasks".
      const fresh = t.filter((x) => !before.has(x.id) && !isHandled(x.status));
      const queuedN = fresh.filter((x) => isInFlight(x.status)).length;
      const needsYou = t.filter((x) => canonStatus(x.status) === "needs_review" && (x.steps?.some((s) => !s.done && !s.automatable) || x.sendables?.some((s) => !s.sent))).length;
      // "Still running" isn't broken — a sweep is genuinely mid-flight elsewhere (another tab, cron). Say so
      // gently rather than "Sweep didn't finish", which reads as an error when nothing's actually wrong.
      const sweepEn = status?.language === "en";
      if (stillRunning) notify(sweepEn ? "Still checking — hang on a moment." : "Vérification en cours — patiente un instant.");
      else if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, sweepEn), /budget|paused|connected/i.test(serverNote) ? "error" : "info");
      else if (!t.length) notify(sweepEn ? "Nothing to do right now — nothing new in Pronote." : "Rien à faire pour l'instant — rien de nouveau sur Pronote.");
      else if (!fresh.length) notify(sweepEn
        ? `Checked — no new tasks${needsYou ? `; ${needsYou} still need${needsYou === 1 ? "s" : ""} you` : "; everything's already on your list"}.`
        : `Vérifié — rien de nouveau${needsYou ? ` ; ${needsYou} tâche${needsYou === 1 ? "" : "s"} ${needsYou === 1 ? "attend" : "attendent"} encore toi` : " ; tout est déjà sur ta liste"}.`);
      else notify(sweepEn
        ? `Found ${fresh.length} new task${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} getting ready` : ""}${needsYou ? `, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}.`
        : `${fresh.length} nouvelle${fresh.length === 1 ? "" : "s"} tâche${fresh.length === 1 ? "" : "s"} trouvée${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} en préparation` : ""}${needsYou ? `, ${needsYou} ${needsYou === 1 ? "a besoin" : "ont besoin"} de toi` : ""}.`);
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
    if (loadError) {
      // This is the ONE screen that can render before status (and so LangContext) has ever loaded — a
      // student on a bad connection would see it hardcoded in English on a French-default app. Fall back
      // to whatever's cached from a previous session; French if there's truly nothing to go on.
      const crashEn = CACHED_STATUS?.language === "en";
      return (
        <div className="screen crash">
          <div className="crash-card">
            <h1>{crashEn ? "Can't reach Otto" : "Impossible de contacter Otto"}</h1>
            <p>{crashEn ? "The server isn't responding. Check your connection and try again." : "Le serveur ne répond pas. Vérifie ta connexion et réessaie."}</p>
            <button className="btn primary big" onClick={() => { setLoadError(false); setReloadKey((k) => k + 1); }}>{crashEn ? "Try again" : "Réessayer"}</button>
          </div>
        </div>
      );
    }
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
  // Only count tasks that actually have something to look at — a queued/executing task has no content
  // yet (opening it just shows a spinner), so it shouldn't inflate the "new" badge with nothing to review.
  const unseenCount = live.filter((t) => !seenTasks.has(t.id) && !isInFlight(t.status)).length;
  const en = status?.language === "en";
  // Split ONCE, outside the render tree, so "Today" and "Later/Can wait" can land in different grid
  // areas (dash-today vs dash-more) instead of one inline block — the whole point of the two-zone
  // dashboard is that Today is never sitting behind anything else, including the rail widgets on mobile.
  const focusToday = live.slice(0, 3);
  const laterToday = live.slice(3, 6);
  const canWait = live.slice(6);
  // Today's real momentum — the ALL-TIME done count only ever grows, so a bar based on it would sit near
  // full forever and mean nothing. What a student actually wants to see is "how much of TODAY is left".
  const doneToday = completed.filter((t) => (t.updatedAt || t.createdAt || "").slice(0, 10) === todayIso()).length;
  const todayTotal = doneToday + live.length;
  // Any big-project milestone already past its date — the highest-urgency thing on the whole dashboard,
  // so it gets said in the header sentence rather than only living in the rail widget.
  const overdueCount = live.reduce((n, t) => n + (t.steps || []).filter((s) => !s.done && s.targetDate && s.targetDate < todayIso()).length, 0);

  return (
    <LangContext.Provider value={status?.language === "en" ? "en" : "fr"}>
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={20} /> Otto</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} aria-current={(route === "" || route === "tasks" || route.startsWith("task/")) ? "page" : undefined} href="/tasks">{status?.language === "en" ? "Tasks" : "Tâches"}{unseenCount > 0 ? <span className="tab-badge">{unseenCount}</span> : null}</a>
          <a className={`tab ${route === "settings" ? "active" : ""}`} aria-current={route === "settings" ? "page" : undefined} href="/settings">{status?.language === "en" ? "Settings" : "Réglages"}</a>
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
            {/* One plain sentence instead of the old "3 active · 1 processing · 5 done" mono readout —
                that read like debug output, not like something written for a stressed 17-year-old. */}
            <p className="dash-line">
              {live.length === 0
                ? (doneToday > 0
                    ? (en ? "That's everything for today." : "C'est tout pour aujourd'hui.")
                    : (en ? "Nothing waiting on you right now." : "Rien ne t'attend pour l'instant."))
                : (en
                    ? `${live.length} thing${live.length > 1 ? "s" : ""} left today${doneToday > 0 ? ` — ${doneToday} already done` : ""}.`
                    : `${live.length} chose${live.length > 1 ? "s" : ""} à faire aujourd'hui${doneToday > 0 ? ` — ${doneToday} déjà faite${doneToday > 1 ? "s" : ""}` : ""}.`)}
              {/* One status signal at a time, in priority order — overdue outranks in-progress work,
                  which outranks a routine scan — instead of stacking every pill that happens to apply. */}
              {overdueCount > 0 ? (
                <span className="dash-late">
                  {en ? `${overdueCount} milestone${overdueCount > 1 ? "s" : ""} overdue` : `${overdueCount} jalon${overdueCount > 1 ? "s" : ""} en retard`}
                </span>
              ) : working > 0 ? (
                <span className="dash-working">{en ? `Otto is working on ${working}` : `Otto en prépare ${working}`}</span>
              ) : scanning ? (
                <span className="scan-note"><span className="scan-dot" /> {en ? "checking…" : "vérification…"}</span>
              ) : null}
            </p>
            {/* Today's progress, not all-time — see doneToday. Hidden when there's nothing to measure. */}
            {todayTotal > 0 && (
              <div className="dash-progress" role="img" aria-label={en ? `${doneToday} of ${todayTotal} done today` : `${doneToday} sur ${todayTotal} faites aujourd'hui`}>
                <div className="dash-progress-fill" style={{ width: `${Math.round((doneToday / todayTotal) * 100)}%` }} />
              </div>
            )}
          </div>
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
          {/* Two-zone dashboard: Today (dash-today) is the main event — on mobile it comes right after
              Add task, ahead of the rail widgets, DOM order alone gives the right mobile stacking. On
              desktop (≥1024px) dash-grid places dash-rail beside dash-today+dash-more instead, sticky,
              so the workload/exam/milestone widgets stay ambient context, never blocking the task list. */}
          <div className="dash-grid">
            <div className="dash-addtask"><AddTask onAdded={setTasks} /></div>

            <div className="dash-today">
              {/* Until the first server response, an empty list means "still loading", not "all clear" —
                  show the skeleton instead of flashing the empty state. */}
              {live.length === 0 && (busy || !loaded) ? <TaskSkeleton /> : live.length === 0 ? (() => {
                const who = status.name || firstName(status.user);
                // First run (nothing ever completed) reads differently from a genuinely cleared list.
                return handled === 0 ? (
                  <div className="empty-state">
                    <div className="empty-mark"><Logo size={28} /></div>
                    <h3>{en ? `Otto is watching your Pronote${who ? `, ${who}` : ""}` : `Otto surveille ton Pronote${who ? `, ${who}` : ""}`}</h3>
                    <p>{en ? "It reads your homework and tests. New tasks arrive automatically — or check right now." : "Il lit tes devoirs et contrôles. De nouvelles tâches arrivent automatiquement — ou lance une vérification maintenant."}</p>
                    <button className="btn primary" disabled={busy} onClick={() => void generate()}>{busy ? (en ? "Searching…" : "Recherche…") : (en ? "Check now" : "Vérifier maintenant")}</button>
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-mark done"><span className="empty-check">✓</span></div>
                    <h3>{en ? `All caught up${who ? `, ${who}` : ""}` : `Tout est à jour${who ? `, ${who}` : ""}`}</h3>
                    <p>{en ? "Nothing waiting for you right now. Otto keeps watching your Pronote." : "Rien ne t'attend pour l'instant. Otto continue de surveiller ton Pronote."}</p>
                  </div>
                );
              })() : (
                <div className={`list-focus-wrap ${settled ? "settled" : ""}`}>
                  <div className="focus-group">
                    <div className="focus-group-head">
                      <span className="focus-title">{en ? "Today" : "Aujourd'hui"}</span>
                      <span className="focus-badge">Top {focusToday.length}</span>
                    </div>
                    <div className="list">
                      {focusToday.map((t, i) => (
                        <TaskCardRow
                          key={t.id}
                          task={t}
                          index={i}
                          retrying={retryingIds.includes(t.id)}
                          isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                          onOpen={() => navigate(`task/${t.id}`)}
                          onChange={setTasks}
                          onConfirmed={flagJustDone}
                          onNotify={notify}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="dash-rail">
              {/* Temporarily hidden — rarely has anything to show outside a detected big IB project
                  (Extended Essay/TOK/CAS/IA), so it was mostly just empty space on the rail. */}
              {false && <Milestones tasks={live} />}
              {status.pronoteConnected && <ExamCountdown lang={status.language} />}
              <WeekLoad lang={status.language} onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))} />
            </div>

            <div className="dash-more">
              {live.length > 0 && (laterToday.length > 0 || canWait.length > 0) && (
                <div className={`list-focus-wrap ${settled ? "settled" : ""}`}>
                  {laterToday.length > 0 && (
                    <div className="focus-group">
                      <div className="focus-group-head">
                        <span className="focus-title">{en ? "Later" : "Plus tard"}</span>
                      </div>
                      <div className="list">
                        {laterToday.map((t, i) => (
                          <TaskCardRow
                            key={t.id}
                            task={t}
                            index={i}
                            retrying={retryingIds.includes(t.id)}
                            isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                            onOpen={() => navigate(`task/${t.id}`)}
                            onChange={setTasks}
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
                            {canWait.map((t, i) => (
                              <TaskCardRow
                                key={t.id}
                                task={t}
                                index={i}
                                retrying={retryingIds.includes(t.id)}
                                isNew={!seenTasks.has(t.id) && !isHandled(t.status)}
                                onOpen={() => navigate(`task/${t.id}`)}
                                onChange={setTasks}
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
              )}
              {completed.length > 0 && (
                <div className="completed-section">
                  <h3 className="completed-head">{en ? "Completed" : "Terminées"}</h3>
                  {/* Minimalist done-list: checked rows like a to-do app, not full cards. Click to expand details. */}
                  <div className="done-list">{(showCompleted ? completed : completed.slice(0, 8)).map((t) => (
                    // A real <button>: reopening a finished task was mouse-only, and this row is the ONLY
                    // way back into one.
                    <button type="button" key={t.id} className={`done-row ${t.id === justDoneId ? "just-done" : ""}`} onClick={() => navigate(`task/${t.id}`)} title={t.synthesis || t.why}>
                      <span className="done-check" aria-hidden="true">✓</span>
                      <span className="done-title">{t.title}</span>
                      <span className="done-when">{relTime(t.updatedAt || t.createdAt)}</span>
                    </button>
                  ))}</div>
                  {completed.length > 8 && !showCompleted && (
                    <button className="btn xs ghost" onClick={() => setShowCompleted(true)}>{en ? `Show all ${completed.length}` : `Tout afficher (${completed.length})`}</button>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Task detail opens as a modal over the list — click a row (live or completed) to open it. */}
          {(() => {
            const openTask = openId ? tasks.find((t) => t.id === openId) : null;
            // Dismissing (or confirming) a task server-side marks it "dismissed"/handled but keeps it IN
            // the list (dismiss doesn't delete — see server/index.ts), so `openTask` stays truthy after
            // onChange updates the list. Closing used to rely entirely on useTaskLeave's onLeft callback
            // firing navigate("") — if that timing ever slipped, the modal would keep showing a task
            // that's already gone. Belt and suspenders: once the task is handled, close regardless.
            if (!openTask || isHandled(openTask.status)) return null;
            return (
              <TaskModal onClose={() => navigate("")} title={openTask.title}>
                <TaskFocus
                  task={openTask}
                  retrying={retryingIds.includes(openTask.id)}
                  onChange={setTasks}
                  onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                  onConfirmed={flagJustDone}
                  onLeft={() => navigate("")}
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

/** Modal shell for the task detail — backdrop-click, ✕, and Esc all close; locks body scroll while open.
 *  `nested`: this is a popup opened FROM WITHIN an already-open TaskModal (a brief/flashcard deck opened
 *  from the task detail) — it renders as a smaller centered card over the primary modal instead of also
 *  going full-bleed, and always via a PORTAL to `document.body`. The portal isn't cosmetic: the primary
 *  modal's own open/close animation (`modalPop`/`modalOut`) animates `transform`, and per the CSS spec any
 *  animated `transform` makes that element the containing block for `position: fixed` descendants — so
 *  without a portal, a nested modal's `inset: 0` was resolving against the OUTER modal's box, not the real
 *  viewport (it rendered pinned to the top of the outer card instead of centered on screen). Portaling both
 *  modals to `<body>` sidesteps that entirely, for every popup, not just nested ones. */

/** The IB "big project" milestone breakdown (Extended Essay/TOK/CAS/IA — see isBigIbProject in
 *  server/claude.ts) surfaced at DASHBOARD level, not just as a badge buried inside one task's step
 *  list. Entirely client-derived from tasks already in state — no fetch, no server endpoint — so it's
 *  a silent no-op for a BFI/other-track student (their tasks simply never have `targetDate` steps). */
function Milestones({ tasks }: { tasks: WebTask[] }) {
  const L = useLang();
  const [showAll, setShowAll] = useState(false);
  const all = tasks
    .flatMap((t) => (t.steps || [])
      .filter((s) => !s.done && s.targetDate)
      .map((s) => ({ taskId: t.id, taskTitle: t.title, text: s.text, targetDate: s.targetDate! })))
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const items = showAll ? all : all.slice(0, 3);
  useReveal([items.length]);
  if (!all.length) return null;
  return (
    <div className="milestone-wrap reveal">
      <div className="exam-strip-label">{L("Prochains jalons", "Upcoming milestones")}</div>
      <div className="milestone-list">
        {items.map((it, i) => {
          const late = it.targetDate < todayIso();
          return (
            <div key={i} className={`milestone-chip ${late ? "late" : ""}`}>
              <span className="milestone-date">{late ? L("en retard", "overdue") : fmtDate(it.targetDate)}</span>
              <span className="milestone-text">{it.text}</span>
              <span className="milestone-task">{it.taskTitle}</span>
            </div>
          );
        })}
        {!showAll && all.length > 3 && (
          <button type="button" className="btn xs ghost milestone-more" onClick={() => setShowAll(true)}>
            {L(`+${all.length - 3} de plus`, `+${all.length - 3} more`)}
          </button>
        )}
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
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { void api.pronoteTests().then((r) => setTests(r.tests)).catch(() => setTests([])); }, []);
  if (!tests?.length) return null;
  const all = [...tests].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  const sorted = showAll ? all : all.slice(0, 4);
  const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  return (
    // No .reveal fade here — this used to pop in as its own late "second wave" after the rest of the
    // dashboard had already settled; it now just appears with its panel, no separate animation.
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
        {!showAll && all.length > 4 && (
          <button type="button" className="btn xs ghost exam-more" onClick={() => setShowAll(true)}>
            {en ? `+${all.length - 4} more` : `+${all.length - 4} de plus`}
          </button>
        )}
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
  const L = useLang();
  const widths = ["66%", "52%", "71%", "58%", "63%"];
  return (
    <div className="loading-screen" aria-busy="true" aria-live="polite">
      <div className="loading-head">
        <span className="spinner sm" />
        <span className="loading-msg">{L("Chargement de tes tâches…", "Loading your tasks…")}</span>
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
      {/* A raw env-var name means nothing to a student — say what's actually broken instead. */}
      {!status.aiReady && <div className="warn">{en ? "Otto's AI isn't set up on this server yet — task generation is off for now." : "L'IA d'Otto n'est pas encore configurée sur ce serveur — la génération de tâches est désactivée pour l'instant."}</div>}
      <a className="btn primary big" href="/settings">{en ? "Connect my Pronote" : "Connecter mon Pronote"}</a>
      <p className="fineprint">{en ? "Disconnect Pronote, or pause Otto, any time in Settings. " : "Déconnecte Pronote, ou mets Otto en pause, à tout moment dans les Réglages. "}<a href="/privacy">{en ? "What Otto reads and why →" : "Ce qu'Otto lit et pourquoi →"}</a></p>
    </div>
  );
}

/** Language toggle — shared between Settings and Onboarding so the same question/UI isn't built twice.
 *  Renders bare rows (no wrapping section) so it drops into either container's own `.set-list`/step
 *  markup. `onChanged` receives the fresh profile after each save. */
function PreferencesFields({ profile, onChanged }: { profile: Profile | null; onChanged?: (p: Profile) => void }) {
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
          <button type="button" className={`btn xs ${lang === "fr" ? "" : "ghost"}`} aria-pressed={lang === "fr"} onClick={() => void saveLang("fr")}>Français</button>
          <button type="button" className={`btn xs ${lang === "en" ? "" : "ghost"}`} aria-pressed={lang === "en"} onClick={() => void saveLang("en")}>English</button>
        </div>
      </div>
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
  const [scale, setScale] = useState("20");
  const [openSubject, setOpenSubject] = useState<string | null>(null);
  const [addedTaskFor, setAddedTaskFor] = useState<string | null>(null);
  const grades = profile?.grades || [];
  const add = async () => {
    const s = subject.trim();
    const g = Number(grade);
    const sc = Number(scale) > 0 ? Number(scale) : 20;
    if (!s || !Number.isFinite(g)) return;
    onChanged?.(await api.setGrade(s, g, sc));
    setSubject(""); setGrade("");
  };
  // No manual "sync" button — Pronote grades pull in automatically (on connect, and again with every
  // daily sweep; see applyPronoteGrades in server/pronote.ts). A passive status line, not a button the
  // student has to remember to press, matches how the rest of Otto works (things just happen for you).
  const bySubject = gradesBySubject(grades); // weakest subject first — see shared/types.ts
  // Overall average — average of PER-SUBJECT averages (each already normalized to /20), not a raw mean
  // of every entry: a subject with 5 logged grades shouldn't outweigh one with a single Pronote average
  // just because it has more rows.
  const overallAvg20 = bySubject.length ? bySubject.reduce((sum, s) => sum + s.avg20, 0) / bySubject.length : null;
  const [addTaskError, setAddTaskError] = useState<{ subject: string; message: string } | null>(null);
  // Fires from Settings, which has no access to the dashboard's task-list state (that lives in the top-
  // level App component). The original version just awaited api.add() and flashed a small "Ajoutée ✓" —
  // with no try/catch, a failed call (session hiccup, AI refinement erroring) threw silently and the
  // button visually did nothing, which is exactly what got reported as "the button doesn't work". Now:
  // errors surface inline, and success navigates straight to the Tasks page so the new task is actually
  // visible immediately instead of trusting the student to notice a checkmark and go look for it later.
  const addTask = async (subj: string) => {
    setAddTaskError(null);
    setAddedTaskFor(subj);
    try {
      await api.add(L(`Réviser ${subj}`, `Review ${subj}`));
      navigate("tasks");
    } catch (e: any) {
      setAddedTaskFor(null);
      setAddTaskError({ subject: subj, message: e?.message || L("Échec de l'ajout — réessaie.", "Couldn't add it — try again.") });
    }
  };
  return (
    <div className="grades-editor">
      {pronoteConnected && grades.length > 0 && (
        <p className="settings-hint grades-sync-note">{L("Synchronisées automatiquement depuis Pronote", "Synced automatically from Pronote")}</p>
      )}
      {overallAvg20 !== null && (
        <div className={`grade-average ${isLowGrade(overallAvg20, 20) ? "low" : ""}`}>
          <span className="grade-average-label">{L("Moyenne générale", "Overall average")}</span>
          <span className="grade-average-value">{overallAvg20.toFixed(1)}/20</span>
        </div>
      )}
      {bySubject.length > 0 && (
        <ul className="grade-list">
          {bySubject.map((s) => {
            const pct = Math.max(0, Math.min(100, (s.avg20 / 20) * 100));
            const low = isLowGrade(s.avg20, 20);
            const open = openSubject === s.subject;
            return (
              <li key={s.subject} className="grade-row">
                <button type="button" className="grade-row-top grade-row-toggle" aria-expanded={open} onClick={() => setOpenSubject(open ? null : s.subject)}>
                  <span className="grade-subject">{s.subject}</span>
                  <span className="grade-value">{s.avg20.toFixed(1)}/20{s.entries.length > 1 ? <span className="grade-count"> · {L(`${s.entries.length} notes`, `${s.entries.length} grades`)}</span> : null}</span>
                  <span className={`caret ${open ? "open" : ""}`} aria-hidden="true">›</span>
                </button>
                <div className="grade-bar"><div className={`grade-bar-fill ${low ? "low" : ""}`} style={{ width: `${pct}%` }} /></div>
                {low ? (
                  <div className="grade-nudge">
                    <span>{addTaskError?.subject === s.subject ? addTaskError.message : L("En difficulté dans cette matière — un peu plus de révision pourrait aider.", "Struggling in this subject — a bit more review time could help.")}</span>
                    <button type="button" className="btn xs ghost" disabled={addedTaskFor === s.subject} onClick={() => void addTask(s.subject)}>{addedTaskFor === s.subject ? L("Ajout…", "Adding…") : L("Ajouter une révision", "Add a study task")}</button>
                  </div>
                ) : null}
                {open ? (
                  <ul className="grade-entries">
                    {s.entries.map((g) => (
                      <li key={g.id} className="grade-entry">
                        <span className="grade-entry-value">{g.grade}/{g.scale}</span>
                        <span className="grade-entry-meta">{g.source === "pronote" ? L("Pronote", "Pronote") : new Date(g.updatedAt).toLocaleDateString()}</span>
                        {g.source !== "pronote" ? <button className="x" title={L("Supprimer", "Remove")} onClick={async () => onChanged?.(await api.deleteGrade(g.id))}>×</button> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="addrow grade-addrow">
        <input className="addinput sm" placeholder={L("Matière (ex : Maths)", "Subject (e.g. Math)")} value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <input className="addinput sm grade-num" type="number" min={0} placeholder={L("Note", "Grade")} value={grade} onChange={(e) => setGrade(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <span className="grade-scale-sep">/</span>
        <input className="addinput sm grade-scale" type="number" min={1} placeholder="20" value={scale} onChange={(e) => setScale(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
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
  const [deletingAccount, setDeletingAccount] = useState(false);
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { void api.profile().then(setProfile); void api.usage().then(setUsage).catch(() => {}); }, []);
  // Month-to-date AI spend vs. the cap — both computed server-side (EUR, approximate; for visibility + the cap).
  const fmtEur = (n: number) => n <= 0 ? "0€" : n < 0.01 ? "< 0,01€" : `${n.toFixed(2).replace(".", ",")}€`;
  useReveal(); // fades each settings section in on first paint (see `.reveal` in styles.css)

  return (
    <main className="settings-page">
      <h1 className="settings-title">{L("Réglages", "Settings")}</h1>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.03s" }}>
        <h3>{L("Compte", "Account")}</h3>
        <div className="modal-row"><span className="lbl">{status.user}{status.cloud ? L(" · synchronisé", " · synced") : ""}</span><button className="btn xs" onClick={() => void onSignOut()}>{L("Se déconnecter", "Sign out")}</button></div>
        {/* French parents care about RGPD more than the AI-spend number itself — show both, but privacy first. */}
        <div className="modal-row"><span className="lbl">{L("Confidentialité", "Privacy")}</span><span className="val">{L("Ton mot de passe Pronote est chiffré, tes données restent hébergées en France/UE, jamais revendues.", "Your Pronote password is encrypted, your data stays hosted in France/EU, never resold.")}</span></div>
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
          {/* Vermilion is reserved for exactly this — an irreversible action — everywhere else in the app;
              this was the one destructive button styled as a plain .btn xs, indistinguishable from "Save". */}
          <button
            className="btn xs danger"
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

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.06s" }}>
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

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.09s" }}>
        <h3>{L("Préférences", "Preferences")}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{L("Mettre Otto en pause", "Pause Otto")}</b><span className="settings-hint">{L("Arrête toute l'IA. Tes tâches restent en place.", "Stops all AI activity. Your tasks stay as they are.")}</span></span>
            <span className="switch"><input type="checkbox" checked={paused} onChange={(e) => { const v = e.target.checked; setPausedLocal(v); void api.setPaused(v).then(() => onChanged()); }} /><span className="switch-track" /></span>
          </label>
          <PreferencesFields profile={profile} onChanged={(p) => { setProfile(p); onChanged(); }} />
        </div>
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.12s" }}>
        <h3>{L("Tes notes", "Your grades")}</h3>
        <p className="settings-hint">{L("Aide Otto à voir quelle matière a vraiment besoin d'attention, pas juste ce qui est dû bientôt.", "Helps Otto see which subject actually needs attention, not just what's due soonest.")}</p>
        <GradesEditor profile={profile} onChanged={setProfile} pronoteConnected={status.pronoteConnected} />
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.15s" }}>
        <button className="sec-toggle" aria-expanded={showKnows} onClick={() => setShowKnows((v) => !v)}>
          <h3>{L("Ce qu'Otto sait sur toi", "What Otto knows about you")}</h3>
          <span className={`caret ${showKnows ? "open" : ""}`} aria-hidden="true">›</span>
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
              <button type="button" className={`seg-btn ${kind === "student" ? "on" : ""}`} aria-pressed={kind === "student"} onClick={() => setKind("student")}>{L("Élève", "Student")}</button>
              <button type="button" className={`seg-btn ${kind === "parent" ? "on" : ""}`} aria-pressed={kind === "parent"} onClick={() => setKind("parent")}>{L("Parent", "Parent")}</button>
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
  if (items === null || !items.length) return <div className="warn">{L("Google n'est pas encore activé sur ce serveur.", "Google isn't set up on this server yet.")}</div>;
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

/** First-run ONBOARDING for a brand-new account — the ONE place Otto is explained. A guided 5-step overlay:
 *  welcome + name → how it works → connect Pronote → preferences → done. Pronote's connect opens in a new
 *  tab; we re-check on focus so the tile flips to ✓ when the user comes back. Shown once after sign-up;
 *  finishing (or "Skip") clears the otto-onboard flag. */
const OB_STEPS = 5;
/** Otto Lycée v1: onboarding is now just name → what Otto does → connect Pronote (the ONE data source) →
 *  done. The old 3-app OAuth picker (Gmail/Calendar/Drive) is gone — every extra sign-in step is a
 *  dropout for a lycéen without a work Google account, and Pronote's connect flow (URL + identifiants,
 *  handled by PronoteTile) isn't OAuth at all, so it doesn't fit that step's "opens in a new tab" pattern. */
function Onboarding({ onStatus, onDone }: { onStatus: () => void; onDone: () => void }) {
  const L = useLang();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [pronoteConnected, setPronoteConnected] = useState(false);
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
            <h2>{L("Connecte ton Pronote", "Connect your Pronote")}</h2>
            <p className="onboard-lead">{L("C'est la seule chose qu'Otto lit pour préparer ton plan. Tes identifiants sont chiffrés et jamais revendus.", "This is the one thing Otto reads to prep your plan. Your credentials are encrypted and never resold.")}</p>
            <div className="onboard-apps">
              <PronoteTile onChanged={() => void checkPronote()} />
            </div>
            <p className="muted small">{L("Tu peux te connecter plus tard depuis les Réglages.", "You can connect later from Settings.")}</p>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(1)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(3)}>{pronoteConnected ? L("Continuer — connecté ✓", "Continue — connected ✓") : L("Plus tard", "Later")}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step">
            <h2>{L("Ta langue", "Your language")}</h2>
            <p className="onboard-lead">{L("Change l'interface et tout ce qu'Otto écrit — modifiable à tout moment dans les Réglages.", "Switches the interface and everything Otto writes — changeable any time in Settings.")}</p>
            <div className="set-list onboard-prefs">
              <PreferencesFields profile={null} />
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(2)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(4)}>{L("Suivant", "Next")}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboard-step onboard-done">
            <div className="onboard-done-mark"><Logo size={30} /></div>
            <h2>{L("C'est prêt", "You're all set")}{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}</h2>
            <p className="onboard-lead">{pronoteConnected ? L("Otto se met au travail. Ton plan du jour arrive.", "Otto is getting to work. Your plan for today is on its way.") : L("Connecte ton Pronote quand tu veux depuis les Réglages, et Otto se met au travail.", "Connect your Pronote any time from Settings, and Otto gets to work.")}</p>
            <p className="muted small">{L("Otto regarde automatiquement, tous les jours — pas besoin de lui demander. Pour connecter d'autres comptes ou ajuster quoi que ce soit, retrouve tout dans les Réglages.", "Otto always looks automatically, every day — no need to ask. To connect more accounts or adjust anything, it's all in Settings.")}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>{L("Voir mes tâches", "See my tasks")}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
function LoginPage({ status, onDone, initialMode }: { status: ConnectionStatus; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" }) {
  const en = status.language === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
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
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || L("Une erreur est survenue.", "Something went wrong."));
    } catch {
      setErr(L("Impossible de contacter le serveur. Vérifie ta connexion et réessaie.", "Couldn't reach the server. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <header className="landing-nav"><a className="brand" href="/"><Logo size={20} /> Otto</a></header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === "signup" ? L("Crée ton compte", "Create your account") : L("Content de te revoir", "Welcome back")}</h1>
          <p className="login-sub">{mode === "signup" ? L("Deux champs et c'est parti — tu connectes Pronote ensuite.", "Two fields and you're in — connect Pronote next.") : L("Connecte-toi pour reprendre où tu en étais.", "Log in to pick up where Otto left off.")}</p>
          {/* "Supabase"/an env-var name means nothing to a student — say what's actually broken instead. */}
          {!status.cloud && <div className="warn">{L("Les comptes ne sont pas encore activés sur ce serveur.", "Accounts aren't set up on this server yet.")}</div>}
          <label className="field"><span>{L("Email", "Email")}</span>
            <input className="addinput" type="email" autoComplete="email" placeholder="toi@email.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>{L("Mot de passe", "Password")}</span>
            <input className="addinput" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={L("6 caractères minimum", "At least 6 characters")} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          {err && <div className="autherr">{err}</div>}
          <button className="btn primary big" disabled={busy || !email.trim() || !pw} onClick={() => void submit()}>{busy ? "…" : mode === "signup" ? L("Créer le compte", "Create account") : L("Se connecter", "Log in")}</button>
          <button className="btn ghost" onClick={() => { setMode((m) => (m === "signup" ? "login" : "signup")); setErr(""); }}>
            {mode === "signup" ? L("Déjà un compte ? Se connecter", "Have an account? Log in") : L("Nouveau ici ? Créer un compte", "New here? Create an account")}
          </button>
          <a className="login-back" href="/">{L("← Retour à l'accueil", "← Back to home")}</a>
          <div className="login-legal">{L("En continuant, tu acceptes nos ", "By continuing you agree to our ")}<a href="/terms">{L("conditions", "Terms")}</a> {L("et notre", "&")} <a href="/privacy">{L("politique de confidentialité", "Privacy Policy")}</a>.</div>
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

  useReveal();

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
        <h1 className="hero-title hero-in" style={{ ["--d" as any]: "0.05s" }}>Le prolongement de Pronote qui te guide — jamais qui fait à ta place.</h1>
        <p className="hero-sub hero-in" style={{ ["--d" as any]: "0.15s" }}>Dimanche 19h, 11 devoirs et 2 contrôles sur Pronote — panique. Otto se branche sur ton Pronote et transforme le mur de devoirs en 3 tâches claires pour aujourd'hui, avec un temps estimé et un point de départ pour chacune. Il t'accompagne pas à pas ; l'exercice, la dissertation, la réponse au contrôle restent toujours les tiens.</p>
        <div className="hero-cta hero-in" style={{ ["--d" as any]: "0.25s" }}>
          <a className="btn primary big" href="/signup">Connecter mon Pronote</a>
          <a className="btn ghost" href="/login">Se connecter</a>
        </div>
        <div className="fineprint hero-in" style={{ ["--d" as any]: "0.32s" }}>Un guide, pas un exécutant — Otto ne fait jamais tes devoirs à ta place.</div>
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
        <p className="lead reveal">Connecte ton Pronote une fois — Otto vit à côté, pas à la place. Il surveille tes devoirs et contrôles et prépare le terrain avant que tu paniques ; le travail noté reste le tien. Clique pour voir les étapes.</p>
        <Walkthrough />
      </section>

      <section className="landing-sec">
        <h2 className="reveal">Un guide, pas un exécutant</h2>
        <div className="features">
          <div className="feature reveal" style={{ ["--d" as any]: "0.0s" }}><div><h3>Jamais ton travail à ta place</h3><p>Otto prépare fiches, checklists et brouillons — jamais l'essai, l'exercice ou la réponse au contrôle. La compréhension reste la tienne, pas celle d'une IA.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.1s" }}><div><h3>Identifiants chiffrés, données en France/UE</h3><p>Ton mot de passe Pronote sert une seule fois puis n'est jamais conservé. Données hébergées en France/UE. Jamais revendu.</p></div></div>
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

