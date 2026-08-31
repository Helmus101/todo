import { useEffect, useState, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { WebTask, ConnectionStatus, Profile, TaskFlashcards } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, isLowGrade, isPeakHourUtc, sortWithinQuadrant, gradesBySubject } from "../shared/types.ts";
import { api, type IntegrationItem, type ConnectedAccount } from "./api.ts";
import { LangContext, useLang, todayIso, fmtDate, relTime, TaskModal, NotifyContext, useNotify, FlashcardDeck } from "./ui.tsx";
import { TaskCardRow, TaskFocus, TaskHero } from "./TaskCard.tsx";
import { StudyMode } from "./study/StudyMode.tsx";
import { 
  LayoutDashboard,
  BookOpen,
  GraduationCap,
  Settings as SettingsIcon,
  Menu,
  X
} from "lucide-react";

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




// How long a local optimistic mutation (confirm/dismiss/step-done/substep) outranks an incoming background
// fetch for the same task — see `keepLocalHandled`/`patchTask` in App(). Long enough to cover a slow
// confirm's own round-trip (including api.ts's retry backoff), short enough that a truly stale local copy
// still gets corrected quickly if something goes wrong.
const MUTATION_GRACE_MS = 8000;
/** Pure comparison used by `keepLocalHandled`: should an incoming task be replaced by what we already have
 *  locally? Exported/pulled out of the closure specifically so it's unit-testable without a live component —
 *  see tests/run.mjs. `mutatedAt` is this task's last local-optimistic-mutation timestamp (undefined if
 *  never locally mutated this session); `now`/`graceMs` are explicit params rather than reading Date.now()
 *  internally, for the same testability reason. */
export function shouldKeepLocal(cur: WebTask | undefined, incoming: WebTask, mutatedAt: number | undefined, now: number, graceMs = MUTATION_GRACE_MS): boolean {
  if (!cur) return false;
  // Already-established guard: never let a background fetch un-handle a task the user already finished/
  // dismissed locally.
  if (isHandled(cur.status) && !isHandled(incoming.status)) return true;
  // New: within the grace window, an incoming copy that isn't itself newer than our local mutation is
  // presumed to be a stale fetch that raced it — keep the local copy. An incoming copy WITH a newer
  // `updatedAt` (e.g. the mutation's own successful response, or a genuinely later change from another
  // device) always wins, so this can't hold onto stale state past what's actually true.
  if (mutatedAt != null && now - mutatedAt < graceMs) {
    const incomingUpdated = incoming.updatedAt ? Date.parse(incoming.updatedAt) : 0;
    if (!incomingUpdated || incomingUpdated < mutatedAt) return true;
  }
  return false;
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

// Today, full form for the dashboard's top-of-page date line — "dimanche 23 août" / "Sunday, August 23".
function todayLong(lang?: string): string {
  return new Date().toLocaleDateString(lang === "en" ? "en-US" : "fr-FR", { weekday: "long", month: "long", day: "numeric" });
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
  // The landing page and login/signup screen render BEFORE any account exists, so they have no
  // status.language to read (the server always answers "fr" for a signed-out session) — every L()/useLang()
  // call in them silently fell back to LangContext's hardcoded "fr" default, regardless of the visitor's
  // browser language, making the whole pre-account experience French-only even in English-language markets.
  // This is a local, persisted choice for that pre-account window only; it's carried into the account's own
  // language preference once the visitor actually signs up (see onDone below).
  const [preLoginLang, setPreLoginLang] = useState<"fr" | "en">(() => {
    try {
      const saved = localStorage.getItem("otto-landing-lang");
      if (saved === "fr" || saved === "en") return saved;
    } catch { /* ignore */ }
    return typeof navigator !== "undefined" && /^en/i.test(navigator.language) ? "en" : "fr";
  });
  const setLandingLang = useCallback((v: "fr" | "en") => {
    setPreLoginLang(v);
    try { localStorage.setItem("otto-landing-lang", v); } catch { /* ignore */ }
  }, []);
  // Guards every periodic/background request (sweep, sync, kick) from firing once sign-out has been
  // clicked. Without this, the 4s "kick" interval (drains an in-flight job) or the 45s sync tick could
  // still be mid-flight — or fire again before React tears down their effects — right as the user signs
  // out; that request's own server-side session write (commit()) can resurrect the just-destroyed session
  // under the same cookie, which is what showed up as "auto logs in again after I signed out". Checked at
  // the top of every tick before it does anything, and before acting on a response that lands late; reset
  // the moment a fresh sign-in actually succeeds.
  const signedOutRef = useRef(false);
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
  // Study Mode state
  const [studyModeTask, setStudyModeTask] = useState<WebTask | null>(null);
  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  // Every optimistic single-task patch (confirm/dismiss/step-done/substep — see TaskCard.tsx's `onTask`
  // usage) stamps itself here, so `keepLocalHandled` below can tell "a background fetch that was already
  // in flight before this mutation" from "a fetch that reflects it" — without this, a `syncTasks`/
  // `sweepIfDue`/`kick` response that started before a confirm and resolves after it can silently
  // overwrite the just-confirmed task back to its old status, purely on network timing.
  const localMutations = useRef(new Map<string, number>());
  const patchTask = useCallback((u: WebTask) => {
    localMutations.current.set(u.id, Date.now());
    setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)));
  }, []);

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
    const now = Date.now();
    // Prune opportunistically so this Map can't grow unbounded over a long session — every entry is either
    // reconciled well within the grace window or genuinely stale and safe to forget.
    for (const [id, t] of localMutations.current) if (now - t > MUTATION_GRACE_MS) localMutations.current.delete(id);
    const incomingIds = new Set(incoming.map((t) => t.id));
    const merged = incoming.map((u) => {
      const cur = prev.find((p) => p.id === u.id);
      return shouldKeepLocal(cur, u, localMutations.current.get(u.id), now) ? cur! : u;
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
    if (signedOutRef.current) return;
    const t = await api.tasks().catch(() => null);
    if (signedOutRef.current) return; // signed out while the request was in flight — drop the stale response
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
    if (signedOutRef.current || !connected || status?.paused || status?.overBudget || sweeping.current) return;
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
    const on = () => { if (!document.hidden && !signedOutRef.current) { void syncTasks(); void loadStatus(); void loadBudget(); void sweepIfDue(); } };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    // A backend-generated task (from cron, another device, or a queued-but-not-auto-run item) is only ever
    // shown by a task re-fetch. The old 15-min tick meant such a task could sit INVISIBLE on an open, idle
    // tab for up to 15 minutes ("it generated but doesn't show"). Poll the cheap /api/tasks GET every 45s so
    // new tasks surface quickly; the heavier sweep it also triggers stays gated by the user's cadence
    // (sweepIfDue is a fast no-op until due), so this doesn't sweep more often. Also re-pull /api/status on
    // the same tick — account-level fields (language, in particular) can change in another tab/device, and
    // without this an already-open session would show a stale language until reload.
    const syncTick = setInterval(() => { if (!document.hidden && !signedOutRef.current) { void syncTasks(); void loadStatus(); } }, 45_000);
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
      if (kicking.current || signedOutRef.current) return;
      kicking.current = true;
      try {
        const out = await api.kick();
        if (signedOutRef.current) return; // signed out mid-flight — don't act on a stale/resurrecting response
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
    // Set BEFORE the async logout call (not after) — every background interval/tick checks this, so a
    // kick/sync/sweep that would otherwise fire in the gap while `api.logout()` is still in flight is
    // stopped at the source instead of racing the server-side session destroy (see signedOutRef above).
    signedOutRef.current = true;
    // Was unguarded — offline, api.logout() throws and skips everything below, leaving local state (and
    // the localStorage cache) intact on what's supposed to be a shared/school-computer-safe sign-out.
    // The local cleanup matters MORE than the server call succeeding, so it happens regardless.
    try { await api.logout(); } catch { /* the local cleanup below is what actually matters here */ }
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

  // Legal pages are PUBLIC — reachable logged-out or in, and even before status loads. Rendered before
  // the LangContext.Provider further down mounts, so they get their own — otherwise useLang() inside them
  // silently defaults to French regardless of the account's actual language (or the signed-out visitor's
  // browser), which is exactly how these ended up 100% English-hardcoded with no L() calls at all.
  if (route === "privacy") return <LegalPage kind="privacy" lang={status?.loggedIn ? status.language : preLoginLang} />;
  if (route === "terms") return <LegalPage kind="terms" lang={status?.loggedIn ? status.language : preLoginLang} />;

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
    // Carry the visitor's pre-account language choice into their new account — otherwise every signup
    // silently reset to French the moment status.language (server-driven, defaults "fr") took over.
    const onNewAccount = async () => {
      try { await api.setProfilePreference("language", preLoginLang); } catch { /* best-effort */ }
    };
    return (
      <LangContext.Provider value={preLoginLang}>
        {route === "login" || route === "signup"
          ? <LoginPage status={status} lang={preLoginLang} onLangChange={setLandingLang} onDone={async (isNew) => { signedOutRef.current = false; if (isNew) { await onNewAccount(); startOnboard(); } await loadStatus(); navigate("tasks"); }} initialMode={route === "signup" ? "signup" : "login"} />
          : route === "unlimited"
          ? <LoginPage status={status} lang={preLoginLang} onLangChange={setLandingLang} onDone={async () => { signedOutRef.current = false; await loadStatus(); navigate("unlimited"); }} initialMode="login" />
          : <Landing lang={preLoginLang} onLangChange={setLandingLang} />}
      </LangContext.Provider>
    );
  }
  if (route === "unlimited") return <UnlimitedPage status={status} onDone={loadStatus} />;

  if (route.startsWith("study/")) {
    const taskId = route.split("/")[1];
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      return (
        <LangContext.Provider value={status?.language === "en" ? "en" : "fr"}>
          <NotifyContext.Provider value={notify}>
            <StudyMode
              task={task}
              onExit={() => navigate("tasks")}
              onTaskUpdate={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
              userId={status?.user}
              language={status?.language === "en" ? "en" : "fr"}
              voiceChat={!!status?.voiceChat}
            />
          </NotifyContext.Provider>
        </LangContext.Provider>
      );
    }
  }

  // Eisenhower ranking with deadline/VIP/freshness tie-breaks — same bands/cards, just a better order.
  // studylog entries (the Journal tab) are WebTasks under the hood (reusing the flashcard/spaced-repetition
  // machinery — see server/index.ts's /api/studylog/*) but they're not to-dos, so they never appear in the
  // normal Tasks dashboard — same exclusion in both `live` and `completed` below.
  const live = sortWithinQuadrant(tasks.filter((t) => t.status !== "done" && t.status !== "dismissed" && t.source !== "studylog" && t.source !== "freestudy"), status?.highPriorityPeople || []);
  const completed = tasks.filter((t) => t.status === "done" && t.source !== "studylog" && t.source !== "freestudy").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const working = tasks.filter((t) => isInFlight(t.status)).length;
  const handled = completed.length;
  const en = status?.language === "en";
  // Split ONCE, outside the render tree, so "Today" and "Later/Can wait" can land in different grid
  // areas (dash-today vs dash-more) instead of one inline block — the whole point of the two-zone
  // dashboard is that Today is never sitting behind anything else, including the rail widgets on mobile.
  const focusToday = live.slice(0, 3);
  // The spotlight is the actual #1-ranked task (sortWithinQuadrant's own ordering — Eisenhower quadrant,
  // then soonest deadline, then VIP, then freshest), full stop. This USED to skip over the true top task
  // in favor of the highest-ranked task that was already clickable (needs_review/failed), reasoning that
  // a queued/executing task's [Continue] button would be a dead end — but it isn't: opening it shows
  // TaskFocus's own legitimate "Otto prépare ça…" waiting state, not a blank screen. That override meant
  // "your next priority" could silently jump to a LESS urgent task just because it happened to be ready
  // sooner — the opposite of what the top spot is supposed to mean.
  const heroTask = focusToday[0];
  const restToday = focusToday.slice(1);
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
    <NotifyContext.Provider value={notify}>
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Logo size={20} /> Otto
        </div>
        <nav className="sidebar-nav">
          <a 
            className={`sidebar-item ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} 
            href="/tasks"
            onClick={() => setSidebarOpen(false)}
          >
            <LayoutDashboard />
            {status?.language === "en" ? "Tasks" : "Tâches"}
            {live.length > 0 && <span className="sidebar-badge">{live.length}</span>}
          </a>
          <a 
            className={`sidebar-item ${route === "log" ? "active" : ""}`} 
            href="/log"
            onClick={() => setSidebarOpen(false)}
          >
            <BookOpen />
            {status?.language === "en" ? "Journal" : "Journal"}
          </a>
          <a
            className={`sidebar-item ${route === "study" ? "active" : ""}`}
            href="/study"
            onClick={() => setSidebarOpen(false)}
          >
            <GraduationCap />
            {status?.language === "en" ? "Study" : "Réviser"}
          </a>
          <a
            className={`sidebar-item ${route === "settings" ? "active" : ""}`}
            href="/settings"
            onClick={() => setSidebarOpen(false)}
          >
            <SettingsIcon />
            {status?.language === "en" ? "Settings" : "Réglages"}
          </a>
        </nav>
      </aside>

      {/* Mobile sidebar toggle */}
      <button 
        className="sidebar-toggle" 
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? <X /> : <Menu />}
      </button>

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header className="topbar">
          <div className="spacer" />
          {(route === "" || route === "tasks" || route.startsWith("task/")) && (status.googleConnected || status.pronoteConnected) && <button className="btn ghost" disabled={busy} onClick={() => void generate()}>{busy ? (status?.language === "en" ? "Searching…" : "Recherche…") : (status?.language === "en" ? "Refresh" : "Actualiser")}</button>}
        </header>

      {/* Hoisted out of the dashboard-only branch below (where it used to live, inside the `route ===
          "settings" ? ... : (...)` ternary's else-arm) so it renders on EVERY route, not just /tasks —
          without this, every failed action in Settings (language toggle, grade edit, profile save, pause
          switch, disconnect...) had literally nowhere to show its error: the toast DOM node didn't exist
          on that route at all, regardless of whether `notify` was even called. */}
      {note && (
        <div className={`toast ${noteKind}`} role="status" aria-live="polite">
          <span className="toast-msg">{note}</span>
          <button className="toast-x" aria-label={status?.language === "en" ? "Close" : "Fermer"} onClick={dismissNote}>✕</button>
        </div>
      )}

      {onboard && <Onboarding onStatus={loadStatus} onDone={finishOnboard} />}

      {route === "settings" ? (
        <SettingsPage status={status} tasks={tasks} onSignOut={signOut} onChanged={loadStatus} onTasksChanged={setTasks} />
      ) : route === "log" ? (
        <StudyLogPage lang={status?.language} />
      ) : route === "study" ? (
        <StandaloneStudyEntry tasks={tasks} setTasks={setTasks} status={status} notify={notify} navigate={navigate} />
      ) : !status.googleConnected && !status.pronoteConnected ? (
        <main className="list-wrap"><ConnectCard status={status} /></main>
      ) : (
        <main className="list-wrap" key="dash">
          <div className="dash-head">
            <p className="dash-date">{todayLong(status?.language)}</p>
            <h1 className="list-head">{GREETING(status?.language)}{(status.name || firstName(status.user)) ? <>, <span className="accent-num">{status.name || firstName(status.user)}</span></> : null}.</h1>
            {/* One plain sentence instead of the old "3 active · 1 processing · 5 done" mono readout —
                that read like debug output, not like something written for a stressed 17-year-old. A second
                sentence names what's actually next (the hero task) rather than just a count, so the line
                reads as a real summary of where things stand, not just a tally. */}
            <p className="dash-line">
              {live.length === 0
                ? (doneToday > 0
                    ? (en ? "That's everything for today." : "C'est tout pour aujourd'hui.")
                    : (en ? "Nothing waiting on you right now." : "Rien ne t'attend pour l'instant."))
                : (en
                    ? `${live.length} thing${live.length > 1 ? "s" : ""} left today${doneToday > 0 ? ` — ${doneToday} already done` : ""}.`
                    : `${live.length} chose${live.length > 1 ? "s" : ""} à faire aujourd'hui${doneToday > 0 ? ` — ${doneToday} déjà faite${doneToday > 1 ? "s" : ""}` : ""}.`)}
              {live.length > 0 && heroTask ? (
                <span className="dash-next">
                  {en ? ` Next up: ${heroTask.title}.` : ` Ensuite : ${heroTask.title}.`}
                </span>
              ) : null}
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
          {/* Two-zone dashboard: Today (dash-today, now led by the TaskHero spotlight) is the main event —
              it comes FIRST on both mobile and desktop (via CSS `order`/`grid-row`, not DOM position, so
              the JSX below doesn't need to move), ahead of add-task and the rail widgets. On desktop
              (≥1024px) dash-grid places dash-rail beside dash-today+dash-more instead, sticky, so the
              workload/exam widgets stay ambient context, never blocking the hero. */}
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
                    <p>{en ? "It reads your homework and tests. Tasks arrive automatically." : "Il lit tes devoirs et contrôles. Les tâches arrivent automatiquement."}</p>
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
                  {/* The dashboard's one headline moment — no "Today"/"Top N" label needed above it, the
                      greeting already says "this is today" and the hero itself says what matters most.
                      Everything else today still shows, just quieter, underneath. */}
                  <TaskHero key={heroTask.id} task={heroTask} onOpen={() => navigate(`task/${heroTask.id}`)} />
                  {restToday.length > 0 && (
                    <div className="focus-group dash-also-today">
                      <div className="focus-group-head">
                        <span className="focus-title">{en ? "Also today" : "Aussi aujourd'hui"}</span>
                      </div>
                      <div className="list">
                        {restToday.map((t, i) => (
                          <TaskCardRow
                            key={t.id}
                            task={t}
                            index={i}
                            retrying={retryingIds.includes(t.id)}
                            isNew={!seenTasks.has(t.id) && !isHandled(t.status) && !isInFlight(t.status)}
                            onOpen={() => navigate(`task/${t.id}`)}
                            onChange={setTasks}
                            onTask={patchTask}
                            onConfirmed={flagJustDone}
                            onEnterStudyMode={() => navigate(`study/${t.id}`)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <WeekRailFab lang={status.language} pronoteConnected={!!status.pronoteConnected} onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))} />

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
                            isNew={!seenTasks.has(t.id) && !isHandled(t.status) && !isInFlight(t.status)}
                            onOpen={() => navigate(`task/${t.id}`)}
                            onChange={setTasks}
                            onTask={patchTask}
                            onConfirmed={flagJustDone}
                            onEnterStudyMode={() => navigate(`study/${t.id}`)}
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
                                isNew={!seenTasks.has(t.id) && !isHandled(t.status) && !isInFlight(t.status)}
                                onOpen={() => navigate(`task/${t.id}`)}
                                onChange={setTasks}
                                onTask={patchTask}
                                onConfirmed={flagJustDone}
                                onEnterStudyMode={() => navigate(`study/${t.id}`)}
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
                  onTask={patchTask}
                  onConfirmed={flagJustDone}
                  onLeft={() => navigate("")}
                  onEnterStudyMode={() => navigate(`study/${openTask.id}`)}
                />
              </TaskModal>
            );
          })()}
        </main>
      )}
      </div>
    </div>
    </NotifyContext.Provider>
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
  // A failed fetch used to render identically to "genuinely no tests" (both `setTests([])`) — the widget
  // just silently vanished either way, which reads as "nothing coming up" when it might actually mean the
  // load broke. Track the two cases separately so a real failure says so instead of going quiet.
  const [error, setError] = useState(false);
  useEffect(() => { void api.pronoteTests().then((r) => setTests(r.tests)).catch(() => { setTests([]); setError(true); }); }, []);
  if (error) return <div className="exam-strip-wrap"><p className="rewrite-error small">{en ? "Couldn't load upcoming tests." : "Impossible de charger les contrôles à venir."}</p></div>;
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

/** Always-on-screen entry point for the exam/week ambient context. Used to render inline in the task
 *  list (splitting it in two), then as a full-screen modal (too heavy for what's basically a glance-and-
 *  close panel) — this is a small floating button, fixed to the same spot at every scroll position, that
 *  opens a compact anchored popover instead of taking over the whole screen. */
function WeekRailFab({ lang, pronoteConnected, onTask }: { lang?: "fr" | "en"; pronoteConnected: boolean; onTask: (t: WebTask) => void }) {
  const en = lang === "en";
  const [open, setOpen] = useState(false);

  return (
    <div className="week-fab-wrap">
      <button type="button" className="week-fab" onClick={() => setOpen(true)}>
        <span>{en ? "This week" : "Cette semaine"}</span>
      </button>
      {/* A hand-rolled outside-click/Escape popover here turned out unreliable (reported as "loads but
          doesn't open") — TaskModal is the SAME popup mechanism already proven to open/close correctly
          everywhere else in the app (task detail, settings), so reuse it instead of a second bespoke
          implementation. `nested` keeps it from re-locking body scroll if it's ever opened from inside
          another modal. */}
      {open && (
        <TaskModal onClose={() => setOpen(false)} title={en ? "This week" : "Cette semaine"}>
          <div className="week-fab-popover-body">
            {/* Temporarily hidden — rarely has anything to show outside a detected big IB project
                (Extended Essay/TOK/CAS/IA), so it was mostly just empty space on the rail. */}
            <DueReviews lang={lang} />
            {pronoteConnected && <ExamCountdown lang={lang} />}
            <WeekLoad lang={lang} onTask={onTask} />
          </div>
        </TaskModal>
      )}
    </div>
  );
}

/** Cards due for spaced-repetition review, across EVERY task — the one genuinely new cross-task view the
 *  spaced-repetition work needed (see nextLeitnerReview in shared/types.ts): a deck's own player only ever
 *  shows what's due for THAT task's deck, but the whole point of spacing is seeing everything due at a
 *  glance without reopening every task to check. Links into the task itself (where the deck opens from) —
 *  no separate deep-link into a specific deck yet, that's a reasonable follow-on, not required for this to
 *  already be useful. */
function DueReviews({ lang }: { lang?: "fr" | "en" }) {
  const en = lang === "en";
  const [due, setDue] = useState<{ taskId: string; taskTitle: string; deckTitle: string }[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { void api.reviewsDue().then((r) => setDue(r.due)).catch(() => { setDue([]); setError(true); }); }, []);
  if (error) return <p className="rewrite-error small">{en ? "Couldn't load reviews due." : "Impossible de charger les révisions dues."}</p>;
  if (!due?.length) return null;
  // Group by task — several due cards from the same deck shouldn't repeat the task title once each.
  const byTask = new Map<string, { taskTitle: string; deckTitle: string; count: number }>();
  for (const d of due) {
    const cur = byTask.get(d.taskId);
    if (cur) cur.count++; else byTask.set(d.taskId, { taskTitle: d.taskTitle, deckTitle: d.deckTitle, count: 1 });
  }
  return (
    <div className="due-reviews">
      <div className="exam-strip-label">{en ? "Due for review" : "À réviser"}</div>
      <div className="exam-strip">
        {[...byTask.entries()].map(([taskId, t]) => (
          <a key={taskId} className="exam-chip due-review-chip" href={`/task/${taskId}`}>
            <span className="exam-days">{t.count}</span>
            <span className="exam-subject">{t.deckTitle}</span>
          </a>
        ))}
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
  const notify = useNotify();
  const [days, setDays] = useState<WorkloadDay[] | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  // Which item's day-picker is open — was a single "move to the lightest day" auto-pick; now the student
  // chooses WHICH later day, since "lighter" and "when I actually want to do it" aren't always the same
  // day (a lighter Thursday doesn't help if there's a match Thursday evening).
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  // A failed load also fell into `setDays([])`, same as a genuinely empty week — "Nothing due this week"
  // is reassuring when it's actually a load failure, exactly the misleading case this pass targets.
  const [error, setError] = useState(false);
  const load = useCallback(() => { setError(false); void api.workload().then((r) => setDays(r.days)).catch(() => { setDays([]); setError(true); }); }, []);
  useEffect(() => { load(); }, [load]);
  // This used to return null and rely on the OLD dash-rail card collapsing itself via `.dash-rail:empty` —
  // now it renders standalone inside the "This week" popover (WeekRailFab), so a silent null here just
  // reads as "the popup doesn't work": you click the button and nothing shows up, loading or genuinely
  // empty look identical (blank). Say which one it actually is instead.
  if (!days) return <p className="muted small">{en ? "Loading…" : "Chargement…"}</p>;
  if (error) return <p className="rewrite-error small">{en ? "Couldn't load this week." : "Impossible de charger la semaine."} <button type="button" className="btn xs ghost" onClick={load}>{en ? "Retry" : "Réessayer"}</button></p>;
  if (days.every((d) => d.items.length === 0)) return <p className="muted small">{en ? "Nothing due this week." : "Rien de prévu cette semaine."}</p>;

  const max = Math.max(1, ...days.map((d) => d.totalEffort));
  // Baselined against days that actually have something due (not the whole week) — see server/workload.ts's
  // isPileUp for why a whole-week median would sit at ~0 and never trigger.
  const busy = [...days.map((d) => d.totalEffort)].filter((e) => e > 0).sort((a, b) => a - b);
  const busyMedian = busy[Math.floor(busy.length / 2)];
  const pileUp = (d: WorkloadDay) => d.totalEffort > 0 && (busy.length < 2 ? d.totalEffort >= 3 : d.totalEffort >= busyMedian * 1.6);
  const lightestOtherDate = (excludeDate: string) => {
    const others = days.filter((d) => d.date !== excludeDate);
    if (!others.length) return undefined;
    return others.reduce((a, b) => (b.totalEffort < a.totalEffort ? b : a)).date;
  };
  const dow = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(en ? "en-US" : "fr-FR", { weekday: "short" });
  const dm = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(en ? "en-US" : "fr-FR", { day: "numeric", month: "short" });
  const todayKey = days[0]?.date;

  const moveTask = async (taskId: string, to: string) => {
    const prevDays = days;
    setPickingFor(null);
    setMoving(taskId);
    const from = days.find((d) => d.items.some((it) => it.taskId === taskId));
    const item = from?.items.find((it) => it.taskId === taskId);
    if (from && item) {
      setDays(days.map((d) => {
        if (d.date === from.date) return { ...d, items: d.items.filter((it) => it.taskId !== taskId), totalEffort: d.totalEffort - item.effort };
        if (d.date === to) return { ...d, items: [...d.items, item], totalEffort: d.totalEffort + item.effort };
        return d;
      }));
    }
    try {
      const list = await api.rescheduleTask(taskId, to);
      const updated = list.find((t) => t.id === taskId);
      if (updated) onTask(updated);
      load();
    } catch (e: any) {
      setDays(prevDays);
      notify(e?.message || (en ? "Couldn't move that task — try again." : "Impossible de déplacer cette tâche — réessaie."), "error");
    }
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
                      pickingFor === it.taskId ? (
                        <div className="week-day-picker">
                          {days.filter((x) => x.date !== d.date).map((x) => (
                            <button key={x.date} type="button" className="btn xs ghost" disabled={moving === it.taskId} onClick={() => void moveTask(it.taskId!, x.date)}>
                              {dow(x.date)}{x.date === lightestOtherDate(d.date) ? " ✦" : ""}
                            </button>
                          ))}
                          <button type="button" className="x" title={en ? "Cancel" : "Annuler"} aria-label={en ? "Cancel" : "Annuler"} onClick={() => setPickingFor(null)}>×</button>
                        </div>
                      ) : (
                        <button type="button" className="btn xs ghost" disabled={moving === it.taskId} onClick={() => setPickingFor(it.taskId!)}>
                          {moving === it.taskId ? "…" : (en ? "Move to another day" : "Déplacer à un autre jour")}
                        </button>
                      )
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
  const L = useLang();
  const notify = useNotify();
  const [lang, setLang] = useState<"fr" | "en">(profile?.language === "en" ? "en" : "fr");
  useEffect(() => { setLang(profile?.language === "en" ? "en" : "fr"); }, [profile?.language]);
  const saveLang = async (v: "fr" | "en") => {
    const prev = lang;
    setLang(v); // optimistic — revert below on failure
    try { onChanged?.(await api.setProfilePreference("language", v)); }
    catch (e: any) {
      setLang(prev);
      notify(e?.message || L("Impossible d'enregistrer la langue.", "Couldn't save the language."), "error");
    }
  };
  // Track: onboarding's copy has always claimed this is "changeable any time in Settings" — it wasn't
  // actually wired up here, so that claim was false for anyone past onboarding. Same optimistic-save
  // pattern as language above.
  const [track, setTrackState] = useState<"ib" | "bac" | "other" | undefined>(profile?.track);
  useEffect(() => { setTrackState(profile?.track); }, [profile?.track]);
  const saveTrack = async (v: "ib" | "bac" | "other") => {
    const prev = track;
    setTrackState(v);
    try { onChanged?.(await api.setProfilePreference("track", v)); }
    catch (e: any) { setTrackState(prev); notify(e?.message || L("Impossible d'enregistrer.", "Couldn't save."), "error"); }
  };
  // Year/grade level — free text (see Profile.yearLevel's doc comment for why not a dropdown). Local draft
  // state so typing doesn't round-trip on every keystroke; saved on blur/Enter like other free-text fields.
  const [yearLevel, setYearLevelState] = useState(profile?.yearLevel || "");
  useEffect(() => { setYearLevelState(profile?.yearLevel || ""); }, [profile?.yearLevel]);
  const saveYearLevel = async () => {
    const v = yearLevel.trim();
    if (v === (profile?.yearLevel || "")) return;
    try { onChanged?.(await api.setProfilePreference("yearLevel", v)); }
    catch (e: any) { notify(e?.message || L("Impossible d'enregistrer.", "Couldn't save."), "error"); }
  };
  // Voice input/read-aloud in Study Mode's Ask Otto chat — off by default, opt-in like every other
  // capability toggle in this app. Browser-native (Web Speech API), so there's no per-request cost to
  // gate against — see Profile.voiceChat's doc comment for why this is the free option that actually works
  // on this app's serverless deployment.
  const [voiceChat, setVoiceChatState] = useState(!!profile?.voiceChat);
  useEffect(() => { setVoiceChatState(!!profile?.voiceChat); }, [profile?.voiceChat]);
  const saveVoiceChat = async (v: boolean) => {
    setVoiceChatState(v);
    try { onChanged?.(await api.setProfilePreference("voiceChat", v)); }
    catch (e: any) { setVoiceChatState(!v); notify(e?.message || L("Impossible d'enregistrer.", "Couldn't save."), "error"); }
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
      <div className="set-row">
        <span className="set-text"><b>{L("Ton parcours", "Your track")}</b><span className="settings-hint">{L("Vocabulaire et intégrations proposées.", "Vocabulary and integrations offered.")}</span></span>
        <div className="lang-toggle">
          <button type="button" className={`btn xs ${track === "bac" ? "" : "ghost"}`} aria-pressed={track === "bac"} onClick={() => void saveTrack("bac")}>{L("Bac", "Bac")}</button>
          <button type="button" className={`btn xs ${track === "ib" ? "" : "ghost"}`} aria-pressed={track === "ib"} onClick={() => void saveTrack("ib")}>IB</button>
          <button type="button" className={`btn xs ${track === "other" ? "" : "ghost"}`} aria-pressed={track === "other"} onClick={() => void saveTrack("other")}>{L("Autre", "Other")}</button>
        </div>
      </div>
      <label className="set-row">
        <span className="set-text"><b>{L("Ta classe / ton année", "Your year/grade")}</b><span className="settings-hint">{L("Aide Otto à caler la difficulté des fiches et exercices sur ton niveau exact.", "Helps Otto match revision sheets and exercises to your exact level.")}</span></span>
        <input className="addinput" style={{ maxWidth: 160 }} maxLength={40}
          placeholder={track === "ib" ? L("ex. DP1", "e.g. DP1") : L("ex. Terminale", "e.g. Terminale")}
          value={yearLevel} onChange={(e) => setYearLevelState(e.target.value)}
          onBlur={() => void saveYearLevel()} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="set-row">
        <span className="set-text"><b>{L("Chat vocal avec Otto", "Voice chat with Otto")}</b><span className="settings-hint">{L("Parle au lieu d'écrire dans le chat d'étude, et fais lire les réponses à voix haute. 100% gratuit — utilise la synthèse vocale de ton navigateur, pas d'API payante.", "Speak instead of typing in the study chat, and have replies read aloud. 100% free — uses your browser's own speech engine, not a paid API.")}</span></span>
        <span className="switch"><input type="checkbox" checked={voiceChat} onChange={(e) => void saveVoiceChat(e.target.checked)} /><span className="switch-track" /></span>
      </label>
    </>
  );
}

/** Self-reported per-subject grades (Pronote's read API doesn't expose grades) — feeds profileBlock() so
 *  Otto weighs a weak subject more heavily than the deadline alone would suggest. Simple add/edit/remove
 *  list, same pattern as ProfileEditor's fact lists. */
function GradesEditor({ profile, onChanged, pronoteConnected, onTasksChanged }: { profile: Profile | null; onChanged?: (p: Profile) => void; pronoteConnected?: boolean; onTasksChanged: (tasks: WebTask[]) => void }) {
  const L = useLang();
  const notify = useNotify();
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
    try {
      onChanged?.(await api.setGrade(s, g, sc));
      setSubject(""); setGrade("");
    } catch (e: any) { notify(e?.message || L("Impossible d'ajouter la note.", "Couldn't add the grade."), "error"); }
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
  // level App component) — onTasksChanged threads a setter down for exactly this. The original version
  // just awaited api.add() and flashed a small "Ajoutée ✓" with no try/catch, so a failed call (session
  // hiccup, AI refinement erroring) threw silently and the button visually did nothing ("the button
  // doesn't work"). A later fix added error handling and navigated to Tasks on success, but never actually
  // applied api.add()'s own response to the app's task state — the dashboard's `tasks` state only refreshes
  // on its own poll (up to 45s) or a route change it's watching, neither of which "navigate to Tasks"
  // triggers, so the new task still didn't visibly appear right away even though it WAS created. Applying
  // the response here directly closes that gap.
  const addTask = async (subj: string) => {
    setAddTaskError(null);
    setAddedTaskFor(subj);
    try {
      onTasksChanged(await api.add(L(`Réviser ${subj}`, `Review ${subj}`)));
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
                  <ul className="grade-entries grade-row-body">
                    {s.entries.map((g) => (
                      <li key={g.id} className="grade-entry">
                        <span className="grade-entry-value">{g.grade}/{g.scale}</span>
                        <span className="grade-entry-meta">{g.source === "pronote" ? L("Pronote", "Pronote") : new Date(g.updatedAt).toLocaleDateString()}</span>
                        {g.source !== "pronote" ? <button className="x" title={L("Supprimer", "Remove")} onClick={async () => {
                          try { onChanged?.(await api.deleteGrade(g.id)); }
                          catch (e: any) { notify(e?.message || L("Impossible de supprimer la note.", "Couldn't remove the grade."), "error"); }
                        }}>×</button> : null}
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

/** Manually-logged exams/deadlines — the Pronote-less equivalent of Pronote's test sync, for a student
 *  whose school doesn't use it (most IB/international schools). Same add/remove pattern as GradesEditor
 *  right above it; feeds ExamCountdown/WeekLoad via GET /api/pronote/tests and /api/workload merging
 *  manualExams in server-side, so this is the ENTIRE client-side surface needed — no other component
 *  needs to know these two data sources exist. */
function ExamsEditor({ profile, onChanged }: { profile: Profile | null; onChanged?: (p: Profile) => void }) {
  const L = useLang();
  const notify = useNotify();
  const [subject, setSubject] = useState("");
  const [deadline, setDeadline] = useState("");
  const exams = [...(profile?.manualExams || [])].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const add = async () => {
    const s = subject.trim();
    if (!s || !deadline) return;
    try { onChanged?.(await api.addExam(s, deadline)); setSubject(""); setDeadline(""); }
    catch (e: any) { notify(e?.message || L("Impossible d'ajouter cet examen.", "Couldn't add that exam."), "error"); }
  };
  return (
    <div className="grades-editor">
      <p className="settings-hint">{L("Pas de Pronote ? Ajoute tes examens ici — ils comptent comme les autres.", "No Pronote? Add exams here — they count just like the rest.")}</p>
      {exams.length > 0 && (
        <ul className="grade-list">
          {exams.map((e) => (
            <li key={e.id} className="grade-row">
              <div className="grade-row-top">
                <span className="grade-subject">{e.subject}</span>
                <span className="grade-value">{new Date(`${e.deadline}T00:00:00`).toLocaleDateString(L("fr-FR", "en-US"), { day: "numeric", month: "short", year: "numeric" })}</span>
                <button className="x" title={L("Supprimer", "Remove")} onClick={async () => {
                  try { onChanged?.(await api.deleteExam(e.id)); }
                  catch (err: any) { notify(err?.message || L("Impossible de supprimer cet examen.", "Couldn't remove that exam."), "error"); }
                }}>×</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="addrow grade-addrow">
        <input className="addinput sm" placeholder={L("Matière (ex : Maths HL)", "Subject (e.g. Math HL)")} value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") void add(); }} />
        <input className="addinput sm" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") void add(); }} />
        <button className="btn" disabled={!subject.trim() || !deadline} onClick={() => void add()}>{L("Ajouter", "Add")}</button>
      </div>
    </div>
  );
}

// Monday (YYYY-MM-DD) of the week containing `dateStr` — mirrors mondayOf in server/index.ts exactly
// (same simple, year-boundary-safe scheme, not a formal ISO week number).
const mondayOf = (dateStr: string): string => {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
};
const addDays = (dateStr: string, n: number): string => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Standalone "Study" mode (route /study, no task id) — the exact same full StudyMode workspace a task's
 *  own "Study Mode" button opens, just not anchored to a real to-do. StudyMode.tsx persists everything
 *  (chat, notes, artifacts) keyed off task.id server-side, so a session with no task still needs a
 *  lightweight placeholder to attach to — POST /api/study/free finds-or-creates one (source:"freestudy",
 *  excluded from the normal dashboard, see the `live`/`completed` filters above), so returning to /study
 *  later resumes the same workspace instead of starting over. */
function StandaloneStudyEntry({ tasks, setTasks, status, notify, navigate }: {
  tasks: WebTask[]; setTasks: Dispatch<SetStateAction<WebTask[]>>; status: ConnectionStatus; notify: (msg: string, kind?: "error" | "info") => void; navigate: (r: string) => void;
}) {
  const en = status?.language === "en";
  const [taskId, setTaskId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = () => {
    setStarting(true);
    void api.studyFreeSession().then((list) => {
      setTasks(list);
      const t = list.find((x) => x.source === "freestudy" && !isHandled(x.status));
      if (t) setTaskId(t.id);
      else notify(en ? "Couldn't start a study session — try again." : "Impossible de démarrer une session — réessaie.", "error");
    }).catch((e: any) => notify(e?.message || (en ? "Couldn't start a study session — try again." : "Impossible de démarrer une session — réessaie."), "error"))
      .finally(() => setStarting(false));
  };
  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  if (!task) {
    return (
      <main className="list-wrap">
        <div className="empty-state">
          <div className="empty-mark"><GraduationCap /></div>
          <h3>{en ? "Study whenever you want" : "Révise quand tu veux"}</h3>
          <p>{en ? "Not tied to a task — a free workspace with notes, materials, and Otto's help." : "Sans tâche associée — un espace libre avec notes, ressources, et l'aide d'Otto."}</p>
          <button className="btn primary" disabled={starting} onClick={start}>{starting ? (en ? "Starting…" : "Démarrage…") : (en ? "Enter study mode" : "Entrer en mode étude")}</button>
        </div>
      </main>
    );
  }
  return (
    <StudyMode
      task={task}
      onExit={() => navigate("tasks")}
      onTaskUpdate={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
      userId={status?.user}
      language={en ? "en" : "fr"}
      voiceChat={!!status?.voiceChat}
    />
  );
}

/** The Journal tab (route /log): Monday-Friday, a free-text "what did I learn today" box per day, auto-
 *  generating flashcards on save (server/index.ts's /api/studylog/day → generateDailyStudyCards). End of
 *  week, an on-demand summary deck weighted toward whatever got marked wrong that week (generateWeeklyStudyDeck).
 *  Both decks reuse the exact same FlashcardDeck review UI + Leitner spaced-repetition schedule as any other
 *  task's deck — reviewing a card here shows up in the normal cross-task "due for review" view for free. */
function StudyLogPage({ lang }: { lang?: "fr" | "en" }) {
  const L = useLang();
  const notify = useNotify();
  const en = lang === "en";
  const [monday, setMonday] = useState(() => mondayOf(todayIso()));
  const [days, setDays] = useState<(WebTask | null)[]>([null, null, null, null, null]);
  const [summary, setSummary] = useState<WebTask | null>(null);
  const [loaded, setLoaded] = useState(false);
  const todayIdx = (() => { const d = new Date(`${todayIso()}T00:00:00`).getDay(); return d >= 1 && d <= 5 ? d - 1 : 0; })();
  const [selected, setSelected] = useState(mondayOf(todayIso()) === monday ? todayIdx : 0);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [openDeckFor, setOpenDeckFor] = useState<"day" | "summary" | null>(null);

  const load = useCallback((m: string) => {
    setLoaded(false);
    void api.studyLogWeek(m).then((r) => { setDays(r.days); setSummary(r.summary); setLoaded(true); })
      .catch(() => { setLoaded(true); notify(en ? "Couldn't load this week." : "Impossible de charger la semaine.", "error"); });
  }, [en, notify]);
  useEffect(() => { load(monday); }, [monday, load]);
  useEffect(() => { setText(days[selected]?.logText || ""); }, [selected, days]);

  const dates = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  const dayLabels = en ? ["Mon", "Tue", "Wed", "Thu", "Fri"] : ["Lun", "Mar", "Mer", "Jeu", "Ven"];

  const save = async () => {
    setSaving(true);
    try {
      const list = await api.studyLogDay(dates[selected], text);
      const fresh = list.find((t) => t.logDate === dates[selected]) || null;
      setDays((prev) => prev.map((d, i) => (i === selected ? fresh : d)));
    } catch (e: any) { notify(e?.message || (en ? "Couldn't save — try again." : "Enregistrement impossible — réessaie."), "error"); }
    finally { setSaving(false); }
  };
  const genSummary = async () => {
    setGenBusy(true);
    try {
      const list = await api.studyLogWeekSummary(monday);
      setSummary(list.find((t) => t.logDate === `week:${monday}`) || null);
    } catch (e: any) { notify(e?.message || (en ? "Couldn't build the week summary — try again." : "Impossible de créer le résumé — réessaie."), "error"); }
    finally { setGenBusy(false); }
  };

  const dayTask = days[selected];
  const dayDeck = dayTask?.flashcards?.[0];
  const summaryDeck = summary?.flashcards?.[0];
  const anyEntryThisWeek = days.some((d) => d?.logText?.trim());
  const onDayReview = dayTask && dayDeck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(dayTask.id, dayDeck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === dayTask.id);
      if (fresh) setDays((prev) => prev.map((d) => (d?.id === dayTask.id ? fresh : d)));
    }).catch(() => {});
  } : undefined;
  const onSummaryReview = summary && summaryDeck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(summary.id, summaryDeck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === summary.id);
      if (fresh) setSummary(fresh);
    }).catch(() => {});
  } : undefined;

  return (
    <main className="list-wrap studylog-page">
      <h1 className="list-head">{L("Journal d'apprentissage", "Study journal")}</h1>
      <p className="dash-line">{L("Note ce que tu as appris aujourd'hui — Otto en fait des cartes de révision.", "Note what you learned today — Otto turns it into flashcards.")}</p>

      <div className="studylog-weeknav">
        <button type="button" className="btn xs ghost" onClick={() => setMonday(addDays(monday, -7))}>{"← " + L("Semaine préc.", "Prev week")}</button>
        <span className="studylog-weeklabel">{fmtDate(monday)} – {fmtDate(addDays(monday, 4))}</span>
        <button type="button" className="btn xs ghost" onClick={() => setMonday(addDays(monday, 7))}>{L("Semaine suiv.", "Next week") + " →"}</button>
      </div>

      <div className="studylog-days">
        {dayLabels.map((label, i) => (
          <button key={i} type="button" className={`studylog-day-btn ${selected === i ? "active" : ""} ${days[i]?.logText ? "has-entry" : ""}`} onClick={() => setSelected(i)}>
            <span>{label}</span><span className="studylog-day-date">{fmtDate(dates[i])}</span>
          </button>
        ))}
      </div>

      {!loaded ? <p className="muted small">{L("Chargement…", "Loading…")}</p> : (
        <>
          <textarea className="studylog-textarea" rows={8}
            placeholder={L("Aujourd'hui, j'ai appris…", "Today I learned…")}
            value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
          <div className="studylog-actions">
            <button type="button" className="btn primary" disabled={saving || !text.trim()} onClick={() => void save()}>
              {saving ? L("Enregistrement…", "Saving…") : L("Enregistrer et créer les cartes", "Save & make flashcards")}
            </button>
            {dayDeck ? <button type="button" className="btn ghost" onClick={() => setOpenDeckFor("day")}>{L("Voir les cartes", "View flashcards")} ({dayDeck.cards.length})</button> : null}
          </div>

          <div className="studylog-summary-sec">
            <h3>{L("Résumé de la semaine", "Week summary")}</h3>
            {summaryDeck ? (
              <button type="button" className="btn ghost" onClick={() => setOpenDeckFor("summary")}>{L("Voir le résumé", "View summary")} ({summaryDeck.cards.length})</button>
            ) : (
              <button type="button" className="btn ghost" disabled={genBusy || !anyEntryThisWeek} onClick={() => void genSummary()}>
                {genBusy ? L("Création…", "Building…") : L("Créer le résumé de la semaine", "Generate week summary")}
              </button>
            )}
            {!anyEntryThisWeek ? <p className="settings-hint">{L("Ajoute au moins une entrée cette semaine d'abord.", "Add at least one entry this week first.")}</p> : null}
          </div>
        </>
      )}

      {openDeckFor === "day" && dayDeck ? (
        <TaskModal onClose={() => setOpenDeckFor(null)} title={dayDeck.title}><FlashcardDeck deck={dayDeck} onReview={onDayReview} taskId={dayTask?.id} /></TaskModal>
      ) : null}
      {openDeckFor === "summary" && summaryDeck ? (
        <TaskModal onClose={() => setOpenDeckFor(null)} title={summaryDeck.title}><FlashcardDeck deck={summaryDeck} onReview={onSummaryReview} taskId={summary?.id} /></TaskModal>
      ) : null}
    </main>
  );
}

/** The landing page (shown logged out at route /) — sharp, crisp positioning as a trusted decision engine. */
/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
function SettingsPage({ status, tasks, onSignOut, onChanged, onTasksChanged }: { status: ConnectionStatus; tasks: WebTask[]; onSignOut: () => void; onChanged: () => void; onTasksChanged: (tasks: WebTask[]) => void }) {
  const L = useLang();
  const notify = useNotify();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string } | null>(null);
  const [showKnows, setShowKnows] = useState(false);
  const [showTrustLog, setShowTrustLog] = useState(false);
  // Optimistic toggles/selects — flip instantly, reconcile with the server after (no round-trip lag).
  const [paused, setPausedLocal] = useState(status.paused);
  const [deletingAccount, setDeletingAccount] = useState(false);
  // A failed profile load used to leave `profile` at null forever with no signal — every `profile?.x` below
  // just silently reads as "empty account" (0 grades, restricted integrations by default) instead of "this
  // didn't load." Track it explicitly so Settings can say so instead of quietly looking like a fresh account.
  const [profileError, setProfileError] = useState(false);
  const loadProfile = () => { setProfileError(false); void api.profile().then(setProfile).catch(() => setProfileError(true)); };
  useEffect(() => { setPausedLocal(status.paused); }, [status.paused]);
  useEffect(() => { loadProfile(); void api.usage().then(setUsage).catch(() => {}); }, []);
  // Month-to-date AI spend vs. the cap — both computed server-side (EUR, approximate; for visibility + the cap).
  // Was hardcoded to "€" + French comma formatting for every account regardless of language — the
  // underlying spend is tracked in USD server-side (see monthCostUsd/monthlyBudgetUsd in shared/types.ts),
  // so a non-French user saw a currency symbol and decimal style that were both simply wrong for them.
  // Not full multi-currency conversion (no real per-country signal exists yet) — just "not literally
  // incorrect for every non-French user": USD in English, EUR in French, both properly locale-formatted.
  const fmtEur = (n: number) => {
    const en = status.language === "en";
    const currency = en ? "USD" : "EUR";
    const nf = new Intl.NumberFormat(en ? "en-US" : "fr-FR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n <= 0) return nf.format(0);
    if (n < 0.01) return `< ${nf.format(0.01)}`;
    return nf.format(n);
  };
  useReveal(); // fades each settings section in on first paint (see `.reveal` in styles.css)

  return (
    <main className="settings-page">
      <h1 className="settings-title">{L("Réglages", "Settings")}</h1>
      {profileError ? (
        <p className="rewrite-error">{L("Certaines infos du profil n'ont pas pu être chargées.", "Some profile info couldn't load.")} <button type="button" className="btn xs ghost" onClick={loadProfile}>{L("Réessayer", "Retry")}</button></p>
      ) : null}

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.03s" }}>
        <h3>{L("Compte", "Account")}</h3>
        <div className="modal-row"><span className="lbl">{status.user}{status.cloud ? L(" · synchronisé", " · synced") : ""}</span><button className="btn xs" onClick={() => void onSignOut()}>{L("Se déconnecter", "Sign out")}</button></div>
        {/* French parents care about RGPD more than the AI-spend number itself — show both, but privacy first.
            NEVER claim EU-only data residency here — the AI calls (server/claude.ts) go to DeepSeek, which has
            no confirmed EU residency and no DPA (see DATA_PROTECTION.md). Only state what's actually true. */}
        <div className="modal-row"><span className="lbl">{L("Confidentialité", "Privacy")}</span><span className="val">{L("Ton mot de passe Pronote est chiffré et jamais revendu. ", "Your Pronote password is encrypted and never resold. ")}<a href="/privacy">{L("Détails sur le traitement de tes données →", "Details on how your data is handled →")}</a></span></div>
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
              if (!window.confirm(L("Supprimer ton compte Otto (tâches, profil, connexions) ? Irréversible.", "Delete your Otto account (tasks, profile, connections)? This can't be undone."))) return;
              setDeletingAccount(true);
              try { await api.deleteAccount(); window.location.href = "/"; }
              catch (e: any) { setDeletingAccount(false); notify(e?.message || L("Impossible de supprimer le compte — réessaie.", "Couldn't delete the account — try again."), "error"); }
            }}
          >{deletingAccount ? L("Suppression…", "Deleting…") : L("Tout supprimer", "Delete everything")}</button>
        </div>
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.06s" }}>
        <h3>{L("Sources", "Sources")}</h3>
        {/* Otto Lycée v1 originally scoped this to just Pronote + Gmail/Calendar/Drive for EVERY account —
            correct for a French Bac student, but it silently hid the rest of Composio's catalog
            (Slack/Notion/GitHub/Linear/…) from every account regardless of track, including IB/international
            students who often lean on those tools for school coordination more than a French lycéen does.
            Now gated by track: the narrow Lycée-only grid stays the default for "bac"/unset (unchanged for
            existing French users), full catalog opens up for "ib"/"other" (see GoogleTiles' `restricted`). */}
        <p className="settings-hint">{L("Otto lit ton Pronote (et ton Gmail/Calendar/Drive si tu les connectes) et prépare le travail — il ", "Otto reads your Pronote (and Gmail/Calendar/Drive if you connect them) and preps the work — it ")}<b>{L("n'envoie et ne rend jamais rien à ta place", "never sends or hands anything in for you")}</b>.</p>
        <PronoteTile />
        <GoogleTiles onChanged={onChanged} restricted={profile?.track !== "ib" && profile?.track !== "other"} />
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.09s" }}>
        <h3>{L("Préférences", "Preferences")}</h3>
        <div className="set-list">
          <label className="set-row">
            <span className="set-text"><b>{L("Mettre Otto en pause", "Pause Otto")}</b><span className="settings-hint">{L("Arrête toute l'IA. Tes tâches restent en place.", "Stops all AI activity. Your tasks stay as they are.")}</span></span>
            <span className="switch"><input type="checkbox" checked={paused} onChange={(e) => {
              const v = e.target.checked;
              setPausedLocal(v); // optimistic — revert below on failure
              void api.setPaused(v).then(() => onChanged()).catch((err: any) => {
                setPausedLocal(!v);
                notify(err?.message || L("Impossible d'enregistrer ce réglage.", "Couldn't save this setting."), "error");
              });
            }} /><span className="switch-track" /></span>
          </label>
          <PreferencesFields profile={profile} onChanged={(p) => { setProfile(p); onChanged(); }} />
        </div>
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.12s" }}>
        <h3>{L("Tes notes", "Your grades")}</h3>
        <p className="settings-hint">{L("Aide Otto à repérer les matières qui traînent, pas juste ce qui est dû bientôt.", "Helps Otto spot subjects falling behind, not just what's due soonest.")}</p>
        <GradesEditor profile={profile} onChanged={setProfile} pronoteConnected={status.pronoteConnected} onTasksChanged={onTasksChanged} />
      </section>

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.13s" }}>
        <h3>{L("Tes examens", "Your exams")}</h3>
        <ExamsEditor profile={profile} onChanged={setProfile} />
      </section>

      {(() => {
        // Not a claimed number — counted straight from each task's own audit trail (kind: "guardrail"),
        // the same record a parent/teacher can open and verify per task. Only shown once it's actually
        // happened at least once: a brand-new account showing "0" would read as a hollow promise, not
        // evidence. The expandable list below is the account-wide version of TaskCard.tsx's per-task
        // "Activity log" — same data, same classes (.audit-log/.audit-list), just pooled across every task
        // so "never does the work" is something a parent/teacher can actually verify in one place instead
        // of having to open each task individually.
        const allAudit = tasks.flatMap((t) => (t.audit || []).map((a) => ({ ...a, taskTitle: t.title })));
        const guardrailCount = allAudit.filter((a) => a.kind === "guardrail").length;
        return guardrailCount > 0 ? (
          <section className="settings-sec reveal" style={{ ["--d" as any]: "0.14s" }}>
            <p className="settings-hint guardrail-stat">
              <span aria-hidden="true">✦</span> {L(
                `Otto a refusé de faire ton travail à ta place ${guardrailCount} fois — et a fait un guide à la place.`,
                `Otto has declined to do your graded work ${guardrailCount} times — and made a guide instead.`,
              )}
            </p>
            <button type="button" className="btn xs ghost audit-toggle" aria-expanded={showTrustLog} onClick={() => setShowTrustLog((v) => !v)}>
              {L("Journal complet", "Full activity log")} ({allAudit.length})
            </button>
            {showTrustLog ? (
              <ul className="audit-list">
                {allAudit.slice().reverse().slice(0, 200).map((e, i) => (
                  <li key={i} className={`audit-${e.kind}`}>
                    <span className="audit-icon" aria-hidden="true">{e.kind === "guardrail" ? "✦" : e.kind === "artifact" ? "✓" : "•"}</span>
                    <span className="audit-label">{e.label}<span className="settings-hint" style={{ display: "block" }}>{e.taskTitle}</span></span>
                    <span className="audit-at">{new Date(e.at).toLocaleString(status.language === "en" ? "en-GB" : "fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null;
      })()}

      <section className="settings-sec reveal" style={{ ["--d" as any]: "0.15s" }}>
        <button className="sec-toggle" aria-expanded={showKnows} onClick={() => setShowKnows((v) => !v)}>
          <h3>{L("Ce qu'Otto sait sur toi", "What Otto knows about you")}</h3>
          <span className={`caret ${showKnows ? "open" : ""}`} aria-hidden="true">›</span>
        </button>
        {showKnows && <div className="settings-reveal"><p className="settings-hint">{L("Otto remplit ça au fil du temps. Tu peux tout modifier.", "Otto fills this in over time. You can edit anything.")}</p><ProfileEditor /></div>}
      </section>
    </main>
  );
}


/** Pronote (French school portal) — no OAuth exists for it, so this is a credential form instead of a
 *  redirect link. The password is sent once to connect and never stored (see server/pronote.ts); only a
 *  rotating token comes back. Reads homework due dates into the to-do list — nothing is ever written back. */
function PronoteTile({ onChanged }: { onChanged?: () => void } = {}) {
  const L = useLang();
  const notify = useNotify();
  const [status, setStatus] = useState<{ connected: boolean; username?: string; needsReconnect?: boolean } | null>(null);
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
  const disconnect = async () => {
    setBusy(true);
    try { await api.disconnectPronote(); await load(); onChanged?.(); }
    catch (e: any) { notify(e?.message || L("Déconnexion impossible — réessaie.", "Couldn't disconnect — try again."), "error"); }
    finally { setBusy(false); }
  };

  if (!status) return null;
  return (
    <div className="int-group">
      <div className="int-grid">
        <div className={`int-tile ${status.connected ? "on" : ""}`}>
          {/* Index Éducation's official PRONOTE logo, via Wikimedia Commons (CC BY-SA 4.0, credited to
              Index Éducation) — self-hosted at public/logos/pronote.png, see public/logos/ATTRIBUTION.md. */}
          <span className="int-logo pronote-logo"><img src="/logos/pronote.png" alt="" loading="lazy" /></span>
          <div className="int-info">
            <div className="int-name">Pronote{status.connected && !status.needsReconnect && <span className="int-dot" title={L("Connecté", "Connected")} />}</div>
            {status.needsReconnect ? (
              <div className="int-blurb warn">{L(
                "Ta session Pronote a expiré — reconnecte-toi pour qu'Otto continue à voir tes devoirs et contrôles.",
                "Your Pronote session expired — reconnect so Otto can keep seeing your homework and tests."
              )}</div>
            ) : (
              <div className="int-blurb">{L(
                "Devoirs et contrôles à venir. Lecture seule — Otto ne coche jamais rien dans Pronote à ta place. Connexion non-officielle (Index Éducation n'a pas d'API publique) — ton mot de passe sert une seule fois puis n'est jamais conservé ; un jeton chiffré le remplace ensuite.",
                "Upcoming homework and tests. Read-only — Otto never checks anything off in Pronote for you. Unofficial connection (Index Éducation has no public API) — your password is used once and never stored; an encrypted token replaces it afterwards."
              )}</div>
            )}
          </div>
          {status.connected && !status.needsReconnect
            ? <button className="btn xs" disabled={busy} onClick={() => void disconnect()}>{busy ? "…" : L("Déconnecter", "Disconnect")}</button>
            : <button className="btn xs" disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? L("Annuler", "Cancel") : status.needsReconnect ? L("Se reconnecter", "Reconnect") : L("Connecter", "Connect")}</button>}
        </div>
      </div>
      {status.connected && !status.needsReconnect && <div className="int-accounts"><div className="int-acct"><span className="int-acct-email">{status.username}</span></div></div>}
      {open && (!status.connected || status.needsReconnect) && (
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
  const notify = useNotify();
  const [accts, setAccts] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setAccts((await api.integrationAccounts(appKey)).accounts); } catch { setAccts([]); } }, [appKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const on = () => { if (!document.hidden) void load(); }; window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [load]);
  const disc = async (id: string) => {
    setBusy(id);
    try { await api.disconnectAccount(appKey, id); await load(); onChanged?.(); }
    catch (e: any) { notify(e?.message || L("Déconnexion impossible — réessaie.", "Couldn't disconnect — try again."), "error"); }
    finally { setBusy(""); }
  };
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
// itself doesn't have them. Everything else in Composio (GitHub/Slack/Linear/…) stays hidden.
const GOOGLE_LYCEE_APPS = ["gmail", "googlecalendar", "googledrive"];
// For IB/Other tracks: the FULL Composio catalog (GitHub/Slack/Linear/Todoist/…) turned out to be more
// than actually wanted — the curated set is Google Workspace (all of it, not just the 3-app Lycée subset —
// Docs/Sheets/Slides matter for building study materials) plus Notion, alongside Pronote which is its own
// separate tile. Not the whole catalog.
const GOOGLE_EXPANDED_APPS = ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets", "googleslides", "notion"];
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

/** Integrations grid. `restricted` (default true) scopes it to just Gmail/Calendar/Drive (GOOGLE_LYCEE_APPS,
 *  the French-Bac default); false shows the curated IB/Other set — Google Workspace + Notion
 *  (GOOGLE_EXPANDED_APPS), not the entire Composio catalog. */
function GoogleTiles({ onChanged, restricted = true }: { onChanged?: () => void; restricted?: boolean }) {
  const [items, setItems] = useState<IntegrationItem[] | null | undefined>(undefined); // undefined = loading, null = unavailable
  const load = useCallback(async () => {
    const allow = restricted ? GOOGLE_LYCEE_APPS : GOOGLE_EXPANDED_APPS;
    try { const r = await api.integrations(); setItems(r.items.filter((i) => allow.includes(i.key))); }
    catch { setItems(null); }
  }, [restricted]);
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
  // Which curriculum/track the student is on — drives both AI vocabulary (trackLine() in server/claude.ts,
  // already good) and, from here on, whether Pronote gets framed as THE data source or as one option among
  // several. Previously never asked anywhere, so every account silently defaulted to unset/"bac"-shaped
  // assumptions regardless of what the student actually needed.
  const [track, setTrack] = useState<"ib" | "bac" | "other" | null>(null);
  // Free text, not a dropdown — see Profile.yearLevel's doc comment: year/grade naming isn't standardized
  // across the Bac/IB/"other" tracks this asks about, and forcing one system's labels onto another would
  // just be wrong for whichever track didn't match. Saved on blur (no separate "confirm" step) since it's
  // optional context, not a gate — skipping it just means Otto calibrates content less precisely.
  const [yearLevel, setYearLevelState] = useState("");
  const saveYearLevel = async () => {
    const v = yearLevel.trim();
    if (v) { try { await api.setProfilePreference("yearLevel", v); await onStatus(); } catch { /* non-blocking */ } }
  };
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { /* non-blocking */ } }
    setStep(1);
  };
  const saveTrack = async (t: "ib" | "bac" | "other") => {
    setTrack(t);
    try { await api.setProfilePreference("track", t); await onStatus(); } catch { /* non-blocking */ }
    // Used to jump straight to step 2 here — but the year-level field below lives on this SAME step, so
    // auto-advancing the instant a track button is clicked never gave the student a chance to see or fill
    // it in. Stay put; "Continue" (added alongside the field) is what actually moves on now.
  };
  const checkPronote = useCallback(async () => { try { const s = await api.pronoteStatus(); setPronoteConnected(s.connected); onStatus(); } catch { /* keep last */ } }, [onStatus]);
  useEffect(() => { void checkPronote(); }, [checkPronote]);
  // Pronote is a French national-education-system tool — real and worth asking about for "bac"/unset, but
  // actively misleading to lead with for an IB/other-track student whose school very likely doesn't use it
  // at all (Google Classroom, Managebac, Toddle, or just email/calendar are far more common internationally).
  const pronoteIsPrimary = track !== "ib" && track !== "other";

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
            <h2>{L("Ton parcours", "Your track")}</h2>
            <p className="onboard-lead">{L("Ça change le vocabulaire qu'Otto utilise et, à l'étape suivante, comment il trouve ton travail — modifiable à tout moment dans les Réglages.", "This changes the vocabulary Otto uses and, on the next step, how it finds your work — changeable any time in Settings.")}</p>
            <div className="onboard-apps">
              <button type="button" className={`btn xs ob-track-btn ${track === "bac" ? "" : "ghost"}`} onClick={() => void saveTrack("bac")}>{L("Bac français (lycée)", "French Bac (lycée)")}</button>
              <button type="button" className={`btn xs ob-track-btn ${track === "ib" ? "" : "ghost"}`} onClick={() => void saveTrack("ib")}>{L("IB", "IB")}</button>
              <button type="button" className={`btn xs ob-track-btn ${track === "other" ? "" : "ghost"}`} onClick={() => void saveTrack("other")}>{L("Autre", "Other")}</button>
            </div>
            {/* Same topic name can mean a different depth at a different year ("quadratics" in Seconde vs.
                Terminale) — without this, Otto has to guess the level and either bores or loses the student. */}
            <label className="field onboard-name">
              <span>{L("Ta classe / ton année (facultatif)", "Your year/grade (optional)")}</span>
              <input className="addinput" maxLength={40}
                placeholder={track === "ib" ? L("ex. DP1, Year 12", "e.g. DP1, Year 12") : track === "other" ? L("ex. Grade 10, Year 11", "e.g. Grade 10, Year 11") : L("ex. Terminale, Première", "e.g. Terminale, Première")}
                value={yearLevel} onChange={(e) => setYearLevelState(e.target.value)}
                onBlur={() => void saveYearLevel()} onKeyDown={(e) => { if (e.key === "Enter") void saveYearLevel(); }} />
            </label>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(0)}>{L("Retour", "Back")}</button>
              {track
                ? <button className="btn primary" onClick={() => { void saveYearLevel(); setStep(2); }}>{L("Continuer", "Continue")}</button>
                : <button className="btn ghost" onClick={() => { void saveYearLevel(); setStep(2); }}>{L("Passer", "Skip")}</button>}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-step">
            <h2>{L("Comment Otto t'aide", "How Otto helps")}</h2>
            <p className="onboard-lead">{pronoteIsPrimary
              ? L("Chaque jour, Otto regarde ton Pronote et transforme tout en 3 choses simples pour aujourd'hui.", "Every day, Otto checks your Pronote and turns everything into 3 simple things for today.")
              : L("Chaque jour, Otto regarde ton Gmail/Calendar (et tes échéances si tu les ajoutes toi-même) et transforme tout en 3 choses simples pour aujourd'hui.", "Every day, Otto checks your Gmail/Calendar (and any deadlines you log yourself) and turns everything into 3 simple things for today.")}</p>
            <div className="ob-states">
              <div className="ob-state"><span className="ob-dot done" /><div><b>{L("Fait pour toi", "Done for you")}</b><span>{L("Fiches de révision, checklists, brouillons — jamais l'exercice lui-même.", "Study guides, checklists, drafts — never the exercise itself.")}</span></div></div>
              <div className="ob-state"><span className="ob-dot need" /><div><b>{L("À toi de jouer", "Your turn")}</b><span>{L("Le devoir ou le contrôle, avec un plan pas à pas.", "The assignment or test, with a step-by-step plan.")}</span></div></div>
              <div className="ob-state"><span className="ob-dot check" /><div><b>{L("Terminé", "Done")}</b><span>{L("Coché, plus besoin d'y penser.", "Checked off, no need to think about it again.")}</span></div></div>
            </div>
            <div className="onboard-actions onboard-actions-split">
              <button className="btn ghost" onClick={() => setStep(1)}>{L("Retour", "Back")}</button>
              <button className="btn primary big" onClick={() => setStep(3)}>{L("Suivant", "Next")}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-step">
            {/* Pronote is a French national-education-system tool — only worth leading with for a Bac/unset
                track. An IB/other-track student's school very likely doesn't use it at all, so this step
                reframes as optional/parallel rather than "the one thing Otto reads" for them. */}
            <h2>{pronoteIsPrimary ? L("Connecte ton Pronote", "Connect your Pronote") : L("Connecte ton Pronote (si tu en as un)", "Connect your Pronote (if you have one)")}</h2>
            <p className="onboard-lead">{pronoteIsPrimary
              ? L("C'est la seule chose qu'Otto lit pour préparer ton plan. Tes identifiants sont chiffrés et jamais revendus.", "This is the one thing Otto reads to prep your plan. Your credentials are encrypted and never resold.")
              : L("La plupart des écoles IB n'utilisent pas Pronote — pas de souci. Connecte-le seulement si ton école le propose ; sinon, connecte Gmail/Calendar depuis les Réglages, ou ajoute tes examens/échéances toi-même.", "Most IB schools don't use Pronote — that's fine. Only connect it if your school offers it; otherwise, connect Gmail/Calendar from Settings, or log your own exams/deadlines by hand.")}</p>
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
            <h2>{L("Ta langue", "Your language")}</h2>
            <p className="onboard-lead">{L("Change l'interface et tout ce qu'Otto écrit — modifiable à tout moment dans les Réglages.", "Switches the interface and everything Otto writes — changeable any time in Settings.")}</p>
            <div className="set-list onboard-prefs">
              {/* onChanged MUST call onStatus — PreferencesFields.saveLang persists server-side, but
                  status.language (which drives the whole app's LangContext) only updates when something
                  calls loadStatus. Without this, a new signup's language pick in onboarding silently never
                  applied to the actual UI — the dashboard kept rendering in the account default. */}
              <PreferencesFields profile={null} onChanged={() => void onStatus()} />
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
            <p className="onboard-lead">{pronoteConnected
              ? L("Otto se met au travail. Ton plan du jour arrive.", "Otto is getting to work. Your plan for today is on its way.")
              : pronoteIsPrimary
              ? L("Connecte ton Pronote quand tu veux depuis les Réglages, et Otto se met au travail.", "Connect your Pronote any time from Settings, and Otto gets to work.")
              : L("Connecte Gmail/Calendar ou ajoute tes examens depuis les Réglages, et Otto se met au travail.", "Connect Gmail/Calendar or add your exams from Settings, and Otto gets to work.")}</p>
            <p className="muted small">{L("Otto regarde automatiquement, tous les jours — pas besoin de lui demander. Pour connecter d'autres comptes ou ajuster quoi que ce soit, retrouve tout dans les Réglages.", "Otto always looks automatically, every day — no need to ask. To connect more accounts or adjust anything, it's all in Settings.")}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>{L("Voir mes tâches", "See my tasks")}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
function LoginPage({ status, lang, onLangChange, onDone, initialMode }: { status: ConnectionStatus; lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !pw || (mode === "signup" && !consent)) return;
    setBusy(true); setErr("");
    try {
      const r = mode === "signup" ? await api.signup(email.trim(), pw, consent) : await api.login(email.trim(), pw);
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || L("Une erreur est survenue.", "Something went wrong."));
    } catch {
      setErr(L("Impossible de contacter le serveur. Vérifie ta connexion et réessaie.", "Couldn't reach the server. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <header className="landing-nav">
        <a className="brand" href="/"><Logo size={20} /> Otto</a>
        <button type="button" className="lang-toggle" onClick={() => onLangChange(en ? "fr" : "en")}>{en ? "FR" : "EN"}</button>
      </header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === "signup" ? L("Crée ton compte", "Create your account") : L("Content de te revoir", "Welcome back")}</h1>
          <p className="login-sub">{mode === "signup" ? L("Deux champs et c'est parti — tu connectes Pronote ensuite.", "Two fields and you're in — connect Pronote next.") : L("Connecte-toi pour reprendre où tu en étais.", "Log in to pick up where Otto left off.")}</p>
          {/* "Supabase"/an env-var name means nothing to a student — say what's actually broken instead. */}
          {!status.cloud && <div className="warn">{L("Les comptes ne sont pas encore activés sur ce serveur.", "Accounts aren't set up on this server yet.")}</div>}
          <label className="field"><span>{L("Email", "Email")}</span>
            <input className="addinput" type="email" autoComplete="email" placeholder={L("toi@email.com", "you@email.com")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>{L("Mot de passe", "Password")}</span>
            <input className="addinput" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={L("6 caractères minimum", "At least 6 characters")} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          {/* RGPD Art.8: under-15s need a parent to set the account up (see Privacy Policy) — a required,
              recorded checkbox instead of the previous text-only claim with no actual signal captured. */}
          {mode === "signup" && (
            <label className="field-check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{L("J'ai 15 ans ou plus, ou un parent a créé ce compte pour moi.", "I'm 15 or older, or a parent set this account up for me.")}</span>
            </label>
          )}
          {err && <div className="autherr">{err}</div>}
          <button className="btn primary big" disabled={busy || !email.trim() || !pw || (mode === "signup" && !consent)} onClick={() => void submit()}>{busy ? "…" : mode === "signup" ? L("Créer le compte", "Create account") : L("Se connecter", "Log in")}</button>
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
function Walkthrough({ lang }: { lang: "fr" | "en" }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
  const STAGES = [
    { n: "01", label: L("Lit ton Pronote", "Reads your Pronote") },
    { n: "02", label: L("Prépare le travail", "Preps the work") },
    { n: "03", label: L("Tu fais le reste", "You do the rest") },
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
            <div className="walk-row"><span className="chip chip-muted">{L("Maths", "Math")}</span><span className="walk-row-text">{L("Contrôle vendredi — chapitre sur les suites", "Test Friday — chapter on sequences")}</span><span className="walk-check">✓ {L("lu", "read")}</span></div>
            <div className="walk-row"><span className="chip chip-muted">{L("Physique", "Physics")}</span><span className="walk-row-text">{L("DM à rendre lundi — mécanique", "Homework due Monday — mechanics")}</span><span className="walk-check">✓ {L("lu", "read")}</span></div>
            <div className="walk-row"><span className="chip chip-muted">{L("Philo", "Philosophy")}</span><span className="walk-row-text">{L("Dissertation sur la conscience — rendu dans 10 jours", "Essay on consciousness — due in 10 days")}</span><span className="walk-check">✓ {L("lu", "read")}</span></div>
            <p className="walk-caption">{L("Otto lit ton Pronote et ne garde que ce qui compte vraiment pour aujourd'hui — le reste attend son tour.", "Otto reads your Pronote and keeps only what actually matters for today — the rest waits its turn.")}</p>
          </div>
        )}
        {stage === 1 && (
          <div className="walk-card">
            <div className="card-title">{L("Réviser le contrôle de Maths de vendredi", "Revise for Friday's Math test")}</div>
            <div className="card-badges"><span className="chip chip-muted">Pronote</span><span className="chip chip-bad">{L("Urgent", "Urgent")}</span></div>
            <h4 className="walk-h">{L("Contexte", "Context")} <span className="chip chip-muted context-source">Pronote</span></h4>
            <p className="context-text">{L("Contrôle vendredi sur les suites numériques (chapitre 4). Ton dernier contrôle sur ce chapitre datait d'il y a 3 semaines.", "Test Friday on number sequences (chapter 4). Your last test on this chapter was 3 weeks ago.")}</p>
            <h4 className="walk-h">{L("Ce qu'Otto a préparé", "What Otto prepped")}</h4>
            <ul className="bullets"><li>{L("Fiche de révision : définitions, formules, 3 méthodes types", "Revision sheet: definitions, formulas, 3 standard methods")}</li></ul>
            <p className="walk-caption">{L("La fiche est prête à consulter — à toi de réviser avec.", "The sheet is ready to read — it's on you to revise with it.")}</p>
          </div>
        )}
        {stage === 2 && (
          <div className="walk-card">
            <p className="walk-draft-body">{L("1. Relire le cours p.42 (10 min)", "1. Reread the notes p.42 (10 min)")}<br/>{L("2. Faire l'exercice 3 (15 min)", "2. Do exercise 3 (15 min)")}<br/>{L("3. Vérifier la correction (5 min)", "3. Check the correction (5 min)")}</p>
            {!done ? (
              <button className="btn primary send-btn" onClick={() => setDone(true)}>{L("Marquer comme fait", "Mark as done")}</button>
            ) : (
              <button className="btn primary send-btn sent" disabled>{L("Fait ✓", "Done ✓")}</button>
            )}
            <p className="walk-caption">{done ? L("C'est toi qui coches, jamais Otto.", "You're the one checking it off — never Otto.") : L("Otto te guide étape par étape — c'est toi qui fais le travail.", "Otto guides you step by step — you're the one doing the work.")}</p>
          </div>
        )}
      </div>

      <div className="walk-nav">
        <button className="btn ghost" disabled={stage === 0} onClick={() => go(stage - 1)}>{L("← Retour", "← Back")}</button>
        <button className="btn ghost" disabled={stage === STAGES.length - 1} onClick={() => go(stage + 1)}>{L("Suivant →", "Next →")}</button>
      </div>
    </div>
  );
}

/** Marketing landing (signed out, route /). CTAs route to the dedicated login / sign-up page. */
function Landing({ lang, onLangChange }: { lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
  const DRAFT = L(
    "1. Relire le cours p.42 (10 min) 2. Faire l'exercice 3 (15 min) 3. Vérifier la correction (5 min)",
    "1. Reread the notes p.42 (10 min) 2. Do exercise 3 (15 min) 3. Check the correction (5 min)",
  );
  const [typed, setTyped] = useState("");
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useReveal();

  // Live typewriter in the hero demo — types the draft out, then holds. (Full text immediately if reduced-motion.)
  useEffect(() => {
    setTyped("");
    if (reduced) { setTyped(DRAFT); return; }
    let i = 0; const start = setTimeout(function tick() {
      i++; setTyped(DRAFT.slice(0, i));
      if (i < DRAFT.length) setTimeout(tick, 26 + (DRAFT[i] === " " ? 40 : 0));
    }, 900);
    return () => clearTimeout(start);
  }, [reduced, DRAFT]);

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="brand"><Logo size={22} /> Otto</span>
        <nav className="landing-navlinks">
          <button type="button" className="lang-toggle" onClick={() => onLangChange(en ? "fr" : "en")}>{en ? "FR" : "EN"}</button>
          <a className="btn ghost" href="/login">{L("Se connecter", "Log in")}</a>
          <a className="btn primary" href="/signup">{L("Commencer", "Get started")}</a>
        </nav>
      </header>

      <main className="hero">
        {/* French copy stays Pronote-first — genuinely correct for the French Bac audience it targets, who
            overwhelmingly DO have one. English copy leads with the universal pain point instead and names
            Pronote as ONE path among several (Gmail/Calendar, or logging exams by hand) — most IB/
            international schools don't use Pronote at all, and English is this app's reach into that
            audience; the old English copy was a literal translation of the French, just as Pronote-only. */}
        <h1 className="hero-title hero-in" style={{ ["--d" as any]: "0.05s" }}>{L("Le prolongement de Pronote qui te guide — jamais qui fait à ta place.", "The study companion that guides you — never does it for you.")}</h1>
        <p className="hero-sub hero-in" style={{ ["--d" as any]: "0.15s" }}>{L(
          "Dimanche 19h, 11 devoirs et 2 contrôles sur Pronote — panique. Otto se branche sur ton Pronote et transforme le mur de devoirs en 3 tâches claires pour aujourd'hui, avec un temps estimé et un point de départ pour chacune. Il t'accompagne pas à pas ; l'exercice, la dissertation, la réponse au contrôle restent toujours les tiens.",
          "Sunday, 7pm — a wall of homework and two tests coming up, and you're panicking. Otto reads your Pronote if your school uses it (or your Gmail/Calendar, or exams you log yourself) and turns it into 3 clear tasks for today, each with an estimated time and a starting point. It walks you through it step by step; the exercise, the essay, the test answer are always yours to do.",
        )}</p>
        <div className="hero-cta hero-in" style={{ ["--d" as any]: "0.25s" }}>
          <a className="btn primary big" href="/signup">{L("Connecter mon Pronote", "Get started free")}</a>
          <a className="btn ghost" href="/login">{L("Se connecter", "Log in")}</a>
        </div>
        <div className="fineprint hero-in" style={{ ["--d" as any]: "0.32s" }}>{L("Un guide, pas un exécutant — Otto ne fait jamais tes devoirs à ta place.", "A guide, not a doer — Otto never does your homework for you.")}</div>
        {/* Concrete, verifiable facts — not marketing adjectives — so the trust claim carries actual weight
            at a glance: each of these is an enforced product behavior, not copy (see server/claude.ts's
            DOES_STUDENT_WORK guardrail, server/crypto.ts's AES-256-GCM at rest, the onboarding track question,
            and the visible monthly AI cap in Settings). */}
        <ul className="hero-trust hero-in" style={{ ["--d" as any]: "0.38s" }}>
          <li><span aria-hidden="true">—</span> {L("Identifiants chiffrés, jamais revendus", "Credentials encrypted, never resold")}</li>
          <li><span aria-hidden="true">—</span> {L("Pensé pour le Bac et l'IB", "Built for both the Bac and the IB")}</li>
          <li><span aria-hidden="true">—</span> {L("Coût de l'IA plafonné et visible", "AI cost capped and visible")}</li>
          <li><span aria-hidden="true">—</span> {L("Ne fait jamais le travail noté", "Never does the graded work")}</li>
        </ul>
        {/* One product visual: a Pronote-wall-of-devoirs → 3-card plan, not a Gmail draft. */}
        <div className="hero-demo hero-in" style={{ ["--d" as any]: "0.42s" }} aria-hidden="true">
          <div className="hero-demo-label"><span className="live-dot" /> {L("Exemple — ton plan du jour", "Example — your plan for today")}</div>
          <div className="demo-window">
            <div className="demo-titlebar"><span /><span /><span /></div>
            <div className="demo-body">
              <p className="demo-line"><b>{L("Maths", "Math")}</b> — {L("Contrôle vendredi", "Test on Friday")} <span className="demo-badge">35 {L("min", "min")}</span></p>
              <p className="demo-line gap">{typed}<span className="demo-caret" /></p>
              <p className="demo-line"><b>{L("Physique", "Physics")}</b> — {L("DM à rendre lundi", "Homework due Monday")}</p>
              <p className="demo-line"><b>{L("Philo", "Philosophy")}</b> — {L("Fiche de révision prête", "Revision sheet ready")}</p>
            </div>
          </div>
        </div>
      </main>

      {/* Full-bleed showcase grid, mirroring a common "product proof" pattern — three concrete mini-previews
          instead of a screenshot dump. Each card is a REAL small render of the actual feature (same
          .demo-window language as the hero), never a stock photo or a fabricated screenshot. */}
      <section className="showcase-sec">
        <h2 className="reveal">{L("Otto en action", "Otto in action")}</h2>
        <div className="showcase-grid">
          <a className="showcase-card reveal" style={{ ["--d" as any]: "0.0s" }} href="/signup" aria-label={L("Créer un compte — Cette semaine", "Create an account — This week")}>
            <div className="showcase-preview">
              <div className="showcase-week">
                {[3, 6, 2, 8, 4, 1, 0].map((v, i) => <span key={i} className="showcase-bar" style={{ height: `${8 + v * 9}px` }} />)}
              </div>
              <div className="showcase-week-labels"><span>{L("L", "M")}</span><span>{L("M", "T")}</span><span>{L("M", "W")}</span><span className="peak">{L("J", "T")}</span><span>{L("V", "F")}</span><span>{L("S", "S")}</span><span>{L("D", "S")}</span></div>
            </div>
            <h3>{L("Vue de la semaine", "This week, at a glance")}</h3>
            <p>{L("Repère le jour surchargé avant qu'il n'arrive.", "Spot the heavy day before it hits.")}</p>
            <span className="showcase-arrow" aria-hidden="true">→</span>
          </a>
          <a className="showcase-card reveal" style={{ ["--d" as any]: "0.1s" }} href="/signup" aria-label={L("Créer un compte — Cartes de révision", "Create an account — Flashcards")}>
            <div className="showcase-preview showcase-card-flip">
              <div className="showcase-flashcard"><span>{L("Dérivée de sin(x) ?", "Derivative of sin(x)?")}</span></div>
              <div className="showcase-boxes">{[1, 2, 3, 4, 5].map((b) => <span key={b} className={`showcase-box ${b <= 2 ? "on" : ""}`}>{b}</span>)}</div>
            </div>
            <h3>{L("Répétition espacée", "Spaced repetition")}</h3>
            <p>{L("Les cartes reviennent pile quand tu commences à oublier.", "Cards resurface right as you start to forget.")}</p>
            <span className="showcase-arrow" aria-hidden="true">→</span>
          </a>
          <a className="showcase-card reveal" style={{ ["--d" as any]: "0.2s" }} href="/signup" aria-label={L("Créer un compte — Brouillons", "Create an account — Drafts")}>
            <div className="showcase-preview">
              <div className="showcase-draft">
                <div className="showcase-draft-line long" />
                <div className="showcase-draft-line" />
                <div className="showcase-draft-line short" />
                <span className="showcase-draft-btn">{L("Envoyer ↗", "Send ↗")}</span>
              </div>
            </div>
            <h3>{L("Brouillons prêts à relire", "Drafts ready to review")}</h3>
            <p>{L("Otto prépare le message — un clic pour l'envoyer, jamais automatique.", "Otto prepares the message — one click to send, never automatic.")}</p>
            <span className="showcase-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">{L("Ce qu'Otto prépare pour toi", "What Otto preps for you")}</h2>
        <div className="outcomes">
          <div className="outcome reveal" style={{ ["--d" as any]: "0.0s" }}><span className="outcome-mark">✓</span><div><h3>{L("Fiche de révision", "Revision sheet")}</h3><p>{L("Plan, définitions, formules — à partir de l'énoncé et de tes documents Drive.", "Outline, definitions, formulas — built from the assignment and your Drive documents.")}</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.1s" }}><span className="outcome-mark">✓</span><div><h3>{L("Checklist étape par étape", "Step-by-step checklist")}</h3><p>{L("\"1. Relire le cours p.42 (10 min) 2. Faire l'exercice 3 (15 min) 3. Vérifier la correction (5 min).\"", "\"1. Reread the notes p.42 (10 min) 2. Do exercise 3 (15 min) 3. Check the correction (5 min).\"")}</p></div></div>
          <div className="outcome reveal" style={{ ["--d" as any]: "0.2s" }}><span className="outcome-mark">✓</span><div><h3>{L("Jamais l'exercice fait à ta place", "Never the exercise done for you")}</h3><p>{L("Pas de dissertation rédigée, pas d'exercice corrigé, pas de réponse de contrôle. Otto te guide, jamais ne fait le travail noté.", "No essay written for you, no exercise solved for you, no test answer. Otto guides you — it never does the graded work.")}</p></div></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">{L("Comment ça marche", "How it works")}</h2>
        <p className="lead reveal">{L("Connecte ton Pronote une fois — Otto vit à côté, pas à la place. Il surveille tes devoirs et contrôles et prépare le terrain avant que tu paniques ; le travail noté reste le tien. Clique pour voir les étapes.", "Connect your Pronote once — Otto lives alongside you, not instead of you. It watches your homework and tests and preps the ground before you panic; the graded work stays yours. Click to see the steps.")}</p>
        <Walkthrough lang={lang} />
      </section>

      <section className="landing-sec">
        <h2 className="reveal">{L("Un guide, pas un exécutant", "A guide, not a doer")}</h2>
        <div className="features">
          <div className="feature reveal" style={{ ["--d" as any]: "0.0s" }}><div><h3>{L("Jamais ton travail à ta place", "Never your work done for you")}</h3><p>{L("Otto prépare fiches, checklists et brouillons — jamais l'essai, l'exercice ou la réponse au contrôle. La compréhension reste la tienne, pas celle d'une IA.", "Otto preps sheets, checklists and drafts — never the essay, the exercise, or the test answer. Understanding stays yours, not an AI's.")}</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.1s" }}><div><h3>{L("Identifiants chiffrés, jamais revendus", "Credentials encrypted, never resold")}</h3><p>{L("Ton mot de passe Pronote sert une seule fois puis n'est jamais conservé. Données jamais revendues — ", "Your Pronote password is used once and never stored. Data is never resold — ")}<a href="/privacy">{L("détail du traitement dans notre politique de confidentialité", "details in our privacy policy")}</a>.</p></div></div>
          <div className="feature reveal" style={{ ["--d" as any]: "0.2s" }}><div><h3>{L("Plafond de coût visible", "Visible cost cap")}</h3><p>{L("Coût de l'IA plafonné et affiché dans les Réglages — pas de surprise.", "AI cost is capped and shown in Settings — no surprises.")}</p></div></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">{L("Pourquoi pas juste ChatGPT ?", "Why not just ChatGPT?")}</h2>
        <p className="lead reveal">{L("Un chatbot généraliste répond à une question ponctuelle. Otto suit tes devoirs et contrôles dans la durée — et refuse structurellement de faire le travail noté, pas juste par une consigne qu'on peut contourner.", "A general-purpose chatbot answers one question at a time. Otto follows your actual homework and tests over the term — and structurally refuses to do the graded work, not just by a prompt instruction you could talk it out of.")}</p>
        <div className="compare-wrap reveal">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">{L("", "")}</th>
                <th scope="col">{L("Seul·e", "On your own")}</th>
                <th scope="col">{L("Chatbot IA générique", "A generic AI chatbot")}</th>
                <th scope="col" className="compare-otto">Otto</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{L("Lit tes devoirs/contrôles automatiquement", "Reads your homework/tests automatically")}</th>
                <td>—</td><td>—</td><td className="compare-yes">✓</td>
              </tr>
              <tr>
                <th scope="row">{L("Transforme le mur de devoirs en plan du jour", "Turns the wall of homework into today's plan")}</th>
                <td>—</td><td>—</td><td className="compare-yes">✓</td>
              </tr>
              <tr>
                <th scope="row">{L("Se souvient de tes cours et profs au fil du trimestre", "Remembers your courses and teachers over the term")}</th>
                <td>—</td><td>—</td><td className="compare-yes">✓</td>
              </tr>
              <tr>
                <th scope="row">{L("Cartes de révision à répétition espacée programmée", "Flashcards on a real scheduled spaced-repetition")}</th>
                <td>—</td><td>—</td><td className="compare-yes">✓</td>
              </tr>
              <tr>
                <th scope="row">{L("Refuse structurellement de faire le travail noté", "Structurally refuses to do the graded work")}</th>
                <td className="compare-yes">✓</td><td>{L("dépend de toi", "up to you")}</td><td className="compare-yes">✓</td>
              </tr>
              <tr>
                <th scope="row">{L("Coût visible et plafonné", "Cost visible and capped")}</th>
                <td>—</td><td>{L("selon l'abonnement", "depends on the plan")}</td><td className="compare-yes">✓</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="landing-sec">
        <h2 className="reveal">{L("Questions fréquentes", "Frequently asked questions")}</h2>
        <div className="faq-list reveal">
          <details className="faq-item">
            <summary>{L("Est-ce qu'Otto fait mes devoirs à ma place ?", "Does Otto do my homework for me?")}</summary>
            <p>{L("Non — c'est refusé structurellement, pas juste \"déconseillé\". Otto détecte une demande de travail noté (rédaction d'une dissertation, exercice résolu, réponse de contrôle) et la redirige vers une fiche, une checklist ou une méthode à la place.", "No — this is structurally refused, not just discouraged. Otto detects a request for graded work (a written essay, a solved exercise, a test answer) and redirects it into a revision sheet, checklist, or method instead.")}</p>
          </details>
          <details className="faq-item">
            <summary>{L("Je suis en filière IB, pas Bac — Otto marche pour moi ?", "I'm in the IB, not the French Bac — does Otto work for me?")}</summary>
            <p>{L("Oui. À l'inscription, tu choisis ta filière (Bac ou IB) et Otto adapte son vocabulaire (HL/SL, CAS, TOK, Extended Essay) et n'exige pas de compte Pronote — Gmail/Calendar ou des contrôles ajoutés à la main suffisent.", "Yes. At sign-up you choose your track (Bac or IB) and Otto adapts its vocabulary (HL/SL, CAS, TOK, Extended Essay) and doesn't require a Pronote account — Gmail/Calendar, or exams you log by hand, work just as well.")}</p>
          </details>
          <details className="faq-item">
            <summary>{L("Combien ça coûte ?", "What does it cost?")}</summary>
            <p>{L("Gratuit pour commencer, sans carte bancaire. L'usage de l'IA a un plafond mensuel visible dans les Réglages — pas de facture surprise.", "Free to start, no credit card required. AI usage has a monthly cap that's visible in Settings — no surprise bill.")}</p>
          </details>
          <details className="faq-item">
            <summary>{L("Mes identifiants Pronote sont-ils en sécurité ?", "Is my Pronote login safe?")}</summary>
            <p>{L("Ton mot de passe sert une seule fois pour la connexion initiale et n'est jamais conservé en clair — le jeton qui le remplace est chiffré (AES-256-GCM) et jamais revendu. ", "Your password is used once for the initial connection and never stored in plain text — the token that replaces it is encrypted (AES-256-GCM) and never resold. ")}<a href="/privacy">{L("Détails dans la politique de confidentialité →", "Details in the privacy policy →")}</a></p>
          </details>
          <details className="faq-item">
            <summary>{L("Je n'utilise pas Pronote — je peux quand même l'utiliser ?", "I don't use Pronote — can I still use it?")}</summary>
            <p>{L("Oui. Connecte Gmail/Calendar, ou ajoute tes contrôles et devoirs à la main dans les Réglages — Otto construit ton plan à partir de ce qui est disponible.", "Yes. Connect Gmail/Calendar, or add your exams and homework by hand in Settings — Otto builds your plan from whatever's available.")}</p>
          </details>
        </div>
      </section>

      <section className="cta-band reveal">
        <h2>{L("Arrête de paniquer devant Pronote.", "Stop panicking over your homework.")}</h2>
        <p>{L("Connecte ton Pronote et laisse Otto préparer le travail — à toi de faire le reste. Gratuit pour commencer, prêt en moins d'une minute.", "Connect Pronote, Gmail/Calendar, or log your exams by hand, and let Otto prep the work — the rest is yours to do. Free to start, ready in under a minute.")}</p>
        <a className="btn big cta-band-btn" href="/signup">{L("Connecter mon Pronote", "Get started free")}</a>
        <div className="cta-fine">{L("Sans carte bancaire · Otto ne fait jamais tes devoirs à ta place", "No credit card · Otto never does your homework for you")}</div>
      </section>

      <footer className="landing-foot-rich">
        <div className="foot-top">
          <div className="foot-brand">
            <span className="brand"><Logo size={20} /> Otto</span>
            <p>{L("Chaque dimanche soir, Otto a déjà lu Pronote pour toi.", "Every Sunday night, Otto has already read your homework for you.")}</p>
          </div>
          <nav className="foot-group" aria-label={L("Produit", "Product")}>
            <h4>{L("Produit", "Product")}</h4>
            <a href="/signup">{L("Créer un compte", "Create account")}</a>
            <a href="/login">{L("Se connecter", "Log in")}</a>
          </nav>
          <nav className="foot-group" aria-label={L("Légal", "Legal")}>
            <h4>{L("Légal", "Legal")}</h4>
            <a href="/privacy">{L("Confidentialité", "Privacy")}</a>
            <a href="/terms">{L("CGU", "Terms")}</a>
          </nav>
        </div>
        <div className="foot-bottom">
          <span className="foot-mit">{L("MIT — open source", "MIT — open source")}</span>
          <button type="button" className="lang-toggle" onClick={() => onLangChange(en ? "fr" : "en")}>{en ? "FR" : "EN"}</button>
        </div>
      </footer>
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

function UnlimitedPage({ status, onDone }: { status: ConnectionStatus; onDone: () => Promise<void> }) {
  const en = status.language === "en";
  const [busy, setBusy] = useState(false);
  const already = !!status.unlimited;
  const claim = async () => {
    setBusy(true);
    try { await api.goUnlimited(); await onDone(); } finally { setBusy(false); }
  };
  return (
    <div className="landing legal-page">
      <header className="landing-nav">
        <a className="brand" href="/"><Logo size={22} /> Otto</a>
      </header>
      <main className="legal unlimited-page">
        <h1>{en ? "Unlimited credits" : "Crédits illimités"}</h1>
        {already ? (
          <>
            <p>{en ? "Your account already has no monthly AI budget cap." : "Ton compte n'a déjà plus de plafond d'utilisation IA mensuel."}</p>
            <a className="btn primary big" href="/tasks">{en ? "Back to tasks" : "Retour aux tâches"}</a>
          </>
        ) : (
          <>
            <p>{en ? "Remove the monthly AI spend cap on this account." : "Retire le plafond mensuel de dépense IA de ce compte."}</p>
            <button className="btn primary big" disabled={busy} onClick={() => void claim()}>
              {busy ? (en ? "Applying…" : "Application…") : (en ? "Get unlimited credits" : "Obtenir des crédits illimités")}
            </button>
          </>
        )}
        <a className="legal-back" href="/">← {en ? "Back to Otto" : "Retour à Otto"}</a>
      </main>
    </div>
  );
}

function LegalPage({ kind, lang }: { kind: "privacy" | "terms"; lang?: string }) {
  return (
    <LangContext.Provider value={lang === "en" ? "en" : "fr"}>
      <LegalPageBody kind={kind} />
    </LangContext.Provider>
  );
}
function LegalPageBody({ kind }: { kind: "privacy" | "terms" }) {
  const L = useLang();
  return (
    <div className="landing legal-page">
      <header className="landing-nav">
        <a className="brand" href="/"><Logo size={22} /> Otto</a>
        <nav className="landing-navlinks">
          <a className="btn ghost" href="/privacy">{L("Confidentialité", "Privacy")}</a>
          <a className="btn ghost" href="/terms">{L("Conditions", "Terms")}</a>
        </nav>
      </header>
      <main className="legal">
        {kind === "privacy" ? <PrivacyBody /> : <TermsBody />}
        <p className="legal-meta">{L(`Dernière mise à jour : ${LEGAL_UPDATED} · Géré par ${LEGAL_ENTITY} · Contact : ${LEGAL_EMAIL}`, `Last updated: ${LEGAL_UPDATED} · Operated by ${LEGAL_ENTITY} · Contact: ${LEGAL_EMAIL}`)}</p>
        <a className="legal-back" href="/">{L("← Retour à Otto", "← Back to Otto")}</a>
      </main>
    </div>
  );
}

function PrivacyBody() {
  const L = useLang();
  return (
    <>
      <h1>{L("Politique de confidentialité", "Privacy Policy")}</h1>
      <p>{L(`Otto (« nous ») est un assistant de tâches qui lit les applications que tu connectes et prépare le travail pour toi. Cette politique explique ce à quoi nous accédons, pourquoi, et tes choix. Otto est géré par ${LEGAL_ENTITY}.`, `Otto ("we", "us") is a to-do assistant that reads the apps you connect and prepares work for you. This policy explains what we access, why, and your choices. Otto is operated by ${LEGAL_ENTITY}.`)}</p>

      <h2>{L("Ce à quoi nous accédons", "What we access")}</h2>
      <p>{L("Uniquement les applications que tu connectes explicitement, et uniquement pour faire le travail demandé :", "Only the apps you explicitly connect, and only to do the work you asked for:")}</p>
      <ul>
        <li><b>Gmail</b> — {L("pour lire les fils récents et préparer des brouillons de réponse. Otto crée des brouillons ; il n'envoie, ne supprime, ni ne modifie jamais un mail de lui-même.", "to read recent threads and prepare draft replies. Otto creates drafts; it never sends, deletes, or modifies mail on its own.")}</li>
        <li><b>Google Calendar</b> — {L("pour lire les événements et préparer des brouillons de nouveaux événements pour ta relecture.", "to read events and prepare drafts of new events for your review.")}</li>
        <li><b>Google Drive / Docs / Sheets / Slides</b> — {L("pour lire les fichiers pertinents et créer des documents qu'il fait pour toi. Otto ne modifie jamais que les documents qu'il a lui-même créés — jamais un fichier qui est déjà le tien.", "to read relevant files and create documents it makes for you. Otto only ever edits a document it created itself — it never modifies a file that's already yours.")}</li>
        <li><b>Pronote</b> ({L("optionnel, non officiel — aucune API Pronote officielle n'existe", "optional, unofficial — no official Pronote API exists")}) — {L("lecture seule, pour voir les dates de rendu des devoirs. Otto n'écrit jamais rien sur Pronote.", "read-only, to see homework due dates. Otto never writes anything back to Pronote.")}</li>
        <li>{L("Autres intégrations que tu connectes", "Other integrations you connect")} — {L("accédées uniquement pour les tâches auxquelles elles se rapportent.", "accessed only for the tasks they relate to.")}</li>
      </ul>
      <p>{L("Otto effectue de manière autonome le travail ", "Otto performs autonomously the work that is ")}<b>{L("réversible", "reversible")}</b>{L(" (brouillons, documents, recherche). Tout ce qui est irréversible — envoyer un mail, publier, inviter, supprimer, ou payer — n'est ", " (drafts, documents, research). Anything irreversible — sending an email, posting, inviting, deleting, or paying — is ")}<b>{L("jamais", "never")}</b>{L(" fait sans ta confirmation explicite. Il ne modifie jamais non plus un document, une feuille ou une présentation qu'il n'a pas créé — seulement tes propres fichiers, jamais ceux d'Otto.", " done without your explicit confirmation. It also never edits a document, sheet, or slide deck that it didn't create — only your own files, never Otto's.")}</p>

      <h2>{L("Ce que nous stockons", "What we store")}</h2>
      <ul>
        <li>{L("Ton email de compte et un mot de passe haché de manière sécurisée (nous ne stockons jamais ton mot de passe en clair).", "Your account email and a securely hashed password (we never store your password in plain text).")}</li>
        <li>{L("Les tâches qu'Otto génère et un profil de faits qu'il apprend pour mieux travailler (personnes, projets, préférences) — tu peux les consulter et les supprimer à tout moment dans les Réglages.", "The tasks Otto generates and a profile of facts it learns to do better work (people, projects, preferences) — you can view and delete these any time in Settings.")}</li>
        <li>{L("Un décompte approximatif de l'usage IA pour afficher ton utilisation mensuelle.", "Approximate AI-usage counts for showing your monthly usage.")}</li>
      </ul>
      <p>{L("Nous ne vendons pas tes données, ne les utilisons pas pour de la publicité, et n'utilisons pas ton contenu pour entraîner des modèles de fondation.", "We do not sell your data, use it for advertising, or use your content to train foundation models.")}</p>

      <h2>{L("Prestataires de service", "Service providers")}</h2>
      <p>{L("Otto partage des données avec les prestataires nécessaires au fonctionnement du service, selon leurs conditions :", "Otto shares data with the processors needed to run the service, under their terms:")}</p>
      <ul>
        <li><b>Composio</b> — {L("gère les connexions OAuth vers tes applications et exécute les actions de lecture/écriture en ton nom.", "brokers the OAuth connections to your apps and executes read/write actions on your behalf.")}</li>
        <li><b>DeepSeek</b> — {L("le modèle IA qui lit le contexte et rédige le travail. Le contenu pertinent est envoyé pour générer chaque tâche/brouillon.", "the AI model that reads context and drafts the work. Relevant content is sent to generate each task/draft.")}</li>
        <li><b>Supabase</b> — {L("stocke ton compte, tes tâches et ton profil.", "stores your account, tasks, and profile.")}</li>
        <li>{L("Prestataires d'hébergement/infrastructure qui font tourner l'application.", "Hosting/infrastructure providers that run the app.")}</li>
      </ul>

      <h2>{L("Conservation et suppression", "Retention & deletion")}</h2>
      <p>{L(`Tes données sont conservées tant que ton compte existe — nous ne les supprimons pas automatiquement en cas d'inactivité, c'est à toi de le faire quand tu le souhaites. Tu gardes le contrôle, sans email ni attente nécessaire : efface tout ce qu'Otto a appris via Réglages → « Tout oublier », déconnecte n'importe quelle application à tout moment (révoque immédiatement l'accès d'Otto), télécharge tout ce qui est stocké sur toi via Réglages → « Télécharger mes données », ou supprime définitivement ton compte et tout ce qu'il contient via Réglages → « Tout supprimer » — instantané, en libre-service, et irréversible.`, `Your data is kept for as long as your account exists — we don't automatically delete it after a period of inactivity; deleting it when you're done is up to you. You're in control, with no email-and-wait required: clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time (revokes Otto's access immediately), download everything stored about you via Settings → "Download my data", or permanently delete your account and everything with it via Settings → "Delete everything" — instant, self-serve, and irreversible.`)}</p>

      <h2>{L("Sécurité", "Security")}</h2>
      <p>{L("Google et les autres connexions via OAuth signifient que nous ne voyons jamais tes mots de passe d'application. Pronote est la seule exception — il n'a pas d'OAuth, donc son identifiant/mot de passe transitent une seule fois par notre serveur pour se connecter ; le mot de passe lui-même n'est jamais stocké ni journalisé, seulement un jeton rotatif que Pronote émet à sa place. Les données sont transmises via HTTPS et l'accès est limité à ton compte. Aucun système n'est parfaitement sûr, mais nous prenons des mesures raisonnables pour protéger tes informations.", "Google and other OAuth-based connections mean we never see your app passwords. Pronote is the one exception — it has no OAuth, so its username/password pass through our server once to connect; the password itself is never stored or logged, only a rotating token Pronote issues in its place. Data is transmitted over HTTPS and access is scoped to your account. No system is perfectly secure, but we take reasonable measures to protect your information.")}</p>

      <h2>{L("Déclaration API Google", "Google API disclosure")}</h2>
      <p>{L("L'utilisation par Otto des informations reçues des API Google respecte la ", "Otto's use of information received from Google APIs adheres to the ")}<a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">{L("politique d'utilisation des données utilisateur des services API Google", "Google API Services User Data Policy")}</a>{L(", y compris les exigences de Limited Use.", ", including the Limited Use requirements.")}</p>

      <h2>{L("Tes droits (RGPD)", "Your rights (GDPR)")}</h2>
      <p>{L(`Si tu es dans l'UE/EEE, le RGPD te donne le droit d'accéder à, de corriger, d'exporter (portabilité), ou de supprimer (effacement) tes données, et de t'opposer à ou de restreindre leur traitement. Les trois premiers sont en libre-service dans les Réglages, dès maintenant, sans demande nécessaire ; pour tout le reste, ou si tu es ailleurs et souhaites la même chose, contacte ${LEGAL_EMAIL} et nous nous en occuperons directement. Notre base légale de traitement est l'exécution du service que tu as demandé (contrat) plus notre intérêt légitime à faire bien fonctionner Otto pour toi.`, `If you're in the EU/EEA, GDPR gives you the right to access, correct, export (portability), or delete (erasure) your data, and to object to or restrict how it's processed. The first three are self-serve in Settings, right now, with no request needed; for anything else, or if you're elsewhere and want the same, contact ${LEGAL_EMAIL} and we'll handle it directly. Our legal basis for processing is performing the service you asked for (contract) plus our legitimate interest in making Otto work well for you.`)}</p>

      <h2>{L("Transferts internationaux", "International transfers")}</h2>
      <p>{L(`Tes données sont traitées par des prestataires situés hors de ${LEGAL_JURISDICTION} (y compris aux États-Unis et ailleurs) — Composio, DeepSeek, Supabase, et notre hébergeur. Nous n'utilisons que des prestataires qui s'engagent contractuellement à protéger tes données (par ex. des clauses contractuelles types le cas échéant) au niveau exigé par le RGPD.`, `Your data is processed by providers based outside ${LEGAL_JURISDICTION} (including the US and elsewhere) — Composio, DeepSeek, Supabase, and our hosting provider. We only use providers that commit contractually to protecting your data (e.g. standard contractual clauses where applicable) to the standard GDPR requires.`)}</p>

      <h2>{L("Âge", "Age")}</h2>
      <p>{L(`Otto est pensé pour les élèves, mais ouvrir un compte nécessite d'avoir l'âge légal pour consentir soi-même au traitement de ses données (15 ans en ${LEGAL_JURISDICTION}) ; en dessous, un parent ou tuteur doit le créer et rester impliqué.`, `Otto is built with students in mind, but opening an account requires being old enough to consent to data processing on your own (15 in ${LEGAL_JURISDICTION}); younger than that, a parent or guardian should set it up and stay involved.`)}</p>

      <h2>{L("Modifications et contact", "Changes & contact")}</h2>
      <p>{L(`Nous mettrons à jour cette politique au fil de l'évolution du service et noterons la date ci-dessus. Questions ou tout ce qui n'est pas couvert ici : ${LEGAL_EMAIL}.`, `We'll update this policy as the service evolves and note the date above. Questions or anything not covered here: ${LEGAL_EMAIL}.`)}</p>
    </>
  );
}

function TermsBody() {
  const L = useLang();
  return (
    <>
      <h1>{L("Conditions d'utilisation", "Terms of Service")}</h1>
      <p>{L(`En utilisant Otto, géré par ${LEGAL_ENTITY}, tu acceptes ces conditions.`, `By using Otto, operated by ${LEGAL_ENTITY}, you agree to these terms.`)}</p>

      <h2>{L("Le service", "The service")}</h2>
      <p>{L("Otto lit les applications que tu connectes et prépare le travail — brouillons, documents, et tâches organisées. Il effectue les actions réversibles de manière autonome et demande ta confirmation avant tout ce qui est irréversible (envoyer, publier, inviter, supprimer, payer). Tu es responsable de la relecture de tout ce qu'Otto prépare avant d'agir dessus.", "Otto reads the apps you connect and prepares work — drafts, documents, and organized tasks. It performs reversible actions autonomously and asks for your confirmation before anything irreversible (sending, posting, inviting, deleting, paying). You are responsible for reviewing anything Otto prepares before you act on it.")}</p>

      <h2>{L("Tes responsabilités", "Your responsibilities")}</h2>
      <ul>
        <li>{L("Garde tes identifiants de compte en sécurité et fournis des informations exactes.", "Keep your account credentials secure and provide accurate information.")}</li>
        <li>{L("Ne connecte que des comptes que tu es autorisé à utiliser.", "Only connect accounts you are authorized to use.")}</li>
        <li>{L("Utilise Otto de manière licite et non pour envoyer du spam, harceler, ou violer les droits d'autrui ou les conditions des applications connectées.", "Use Otto lawfully and not to send spam, harass, or violate others' rights or the connected apps' terms.")}</li>
      </ul>

      <h2>{L("Contenu généré par IA — tout relire", "AI-generated content — review everything")}</h2>
      <p>{L("Otto utilise l'IA, qui peut être inexacte, incomplète, ou erronée. Chaque brouillon, document, et suggestion est un point de départ que ", "Otto uses AI, which can be inaccurate, incomplete, or wrong. Every draft, document, and suggestion is a starting point that ")}<b>{L("tu dois relire et vérifier", "you must review and verify")}</b>{L(" avant de l'envoyer, l'enregistrer, ou t'y fier. Tu es seul responsable de tout ce que tu choisis d'envoyer, publier, ou sur quoi tu agis. Otto ne prépare que du travail réversible et demande ta confirmation avant tout ce qui est irréversible ; la décision — et ses conséquences — t'appartiennent.", " before sending, saving, or relying on it. You are solely responsible for anything you choose to send, publish, or act upon. Otto only prepares reversible work and asks for your confirmation before anything irreversible; the decision — and its consequences — are yours.")}</p>

      <h2>{L("Aucune garantie", "No warranty")}</h2>
      <p>{L("Le service est fourni « tel quel » et « selon disponibilité », sans garantie d'aucune sorte, expresse, implicite, ou légale — y compris toute garantie implicite de qualité marchande, d'adéquation à un usage particulier, d'exactitude, ou de non-contrefaçon. Nous ne garantissons pas qu'Otto sera ininterrompu, sans erreur, sécurisé, ou que ses résultats seront corrects ou adaptés à un usage quelconque. Tu l'utilises à tes propres risques.", "The service is provided \"as is\" and \"as available\", without warranties of any kind, whether express, implied, or statutory — including any implied warranties of merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not warrant that Otto will be uninterrupted, error-free, secure, or that its output will be correct or suitable for any purpose. You use it at your own risk.")}</p>

      <h2>{L("Limitation de responsabilité", "Limitation of liability")}</h2>
      <p>{L(`Dans toute la mesure permise par la loi applicable, ${LEGAL_ENTITY} et toute personne impliquée dans la fourniture d'Otto ne sauraient être tenus responsables de dommages indirects, accessoires, spéciaux, consécutifs, exemplaires, ou punitifs, ni d'aucune perte de données, de profits, de revenus, de clientèle, de communications manquées, d'envois erronés, ou d'interruption d'activité, découlant de ou liés à ton utilisation (ou incapacité d'utiliser) Otto ou de tout ce qu'il prépare ou fait — même si informé de cette possibilité. Dans toute la mesure permise par la loi, notre responsabilité totale cumulée pour toutes les réclamations liées au service n'excédera pas le plus élevé entre le montant que tu nous as payé au cours des 12 mois précédant la réclamation, ou 50 €. Rien dans ces conditions n'exclut une responsabilité qui ne peut être exclue en vertu de la loi applicable.`, `To the fullest extent permitted by applicable law, ${LEGAL_ENTITY} and anyone involved in providing Otto shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, nor for any loss of data, profits, revenue, goodwill, missed communications, mistaken sends, or business interruption, arising out of or relating to your use of (or inability to use) Otto or anything it prepares or does — even if advised of the possibility. To the fullest extent permitted by law, our total aggregate liability for all claims relating to the service will not exceed the greater of the amount you paid us in the 12 months before the claim, or €50. Nothing in these terms excludes liability that cannot be excluded under applicable law.`)}</p>

      <h2>{L("Tes données et ta responsabilité", "Your data & your responsibility")}</h2>
      <p>{L(`Tu es responsable des comptes et du contenu que tu connectes et de t'assurer que tu as le droit de le faire. Tu agis en tant que responsable de traitement des données personnelles dans tes comptes connectés ; Otto ne les traite que pour fournir le service, comme décrit dans la Politique de confidentialité. Tu acceptes d'indemniser et de dégager ${LEGAL_ENTITY} de toute réclamation, perte, ou dépense découlant de ton utilisation d'Otto, de ton contenu, ou de ta violation de ces conditions ou des droits ou conditions d'un tiers.`, `You are responsible for the accounts and content you connect and for ensuring you have the right to do so. You act as the controller of the personal data in your connected accounts; Otto processes it only to provide the service, as described in the Privacy Policy. You agree to indemnify and hold ${LEGAL_ENTITY} harmless from any claims, losses, or expenses arising from your use of Otto, your content, or your breach of these terms or of any third party's rights or terms.`)}</p>

      <h2>{L("Disponibilité et modifications", "Availability & changes")}</h2>
      <p>{L("Otto est un outil indépendant et n'est ni approuvé par ni affilié à Google, ou tout autre prestataire intégré. Nous pouvons modifier, suspendre, limiter (y compris via un budget IA mensuel), ou interrompre toute partie du service à tout moment sans responsabilité.", "Otto is an independent tool and is not endorsed by or affiliated with Google, or any other integrated provider. We may change, suspend, limit (including via a monthly AI budget), or discontinue any part of the service at any time without liability.")}</p>

      <h2>{L("Résiliation", "Termination")}</h2>
      <p>{L("Tu peux arrêter d'utiliser Otto et supprimer ton compte à tout moment. Nous pouvons suspendre ou résilier les comptes qui violent ces conditions ou qui créent un risque ou une exposition légale.", "You may stop using Otto and delete your account at any time. We may suspend or terminate accounts that violate these terms or that create risk or legal exposure.")}</p>

      <h2>{L("Droit applicable et contact", "Governing law & contact")}</h2>
      <p>{L(`Ces conditions sont régies par les lois de ${LEGAL_JURISDICTION}, sans égard aux règles de conflit de lois, et les tribunaux de ${LEGAL_JURISDICTION} sont compétents, sauf disposition contraire d'une loi locale impérative sur la consommation. Si une disposition est jugée inapplicable, le reste demeure en vigueur. Questions : ${LEGAL_EMAIL}.`, `These terms are governed by the laws of ${LEGAL_JURISDICTION}, without regard to conflict-of-laws rules, and the courts of ${LEGAL_JURISDICTION} have jurisdiction, except where mandatory local consumer law provides otherwise. If any provision is held unenforceable, the rest remains in effect. Questions: ${LEGAL_EMAIL}.`)}</p>
    </>
  );
}


/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Otto fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const L = useLang();
  const notify = useNotify();
  const [p, setP] = useState<Profile | null>(null);
  // A load failure used to be indistinguishable from "still loading" — `catch(() => setP(null))` left this
  // stuck on "Chargement…" forever with no way to tell the user anything went wrong or let them retry.
  const [loadError, setLoadError] = useState(false);
  const load = () => { setLoadError(false); void api.profile().then(setP).catch(() => setLoadError(true)); };
  useEffect(load, []);
  if (loadError) return <p className="rewrite-error">{L("Impossible de charger ton profil.", "Couldn't load your profile.")} <button type="button" className="btn xs ghost" onClick={load}>{L("Réessayer", "Retry")}</button></p>;
  if (!p) return <p className="muted small">{L("Chargement…", "Loading…")}</p>;
  const saveErr = () => L("Enregistrement impossible — réessaie.", "Couldn't save — try again.");
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length + p.courses.length;
  const lists = [
    { key: "preference" as const, label: L("Préférences", "Preferences"), items: p.preferences },
    { key: "person" as const, label: L("Personnes", "People"), items: p.people },
    { key: "project" as const, label: L("Projets", "Projects"), items: p.projects },
    { key: "course" as const, label: L("Cours", "Courses"), items: p.courses },
  ];
  return (
    <div className="memory-body">
      <NameRow name={p.name || ""} onSave={async (v) => { try { setP(await api.setProfile("name", v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
      <AboutRow about={p.about} onSave={async (v) => { try { setP(await api.setProfile("about", v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
      {lists.map((l) => (
        <div className="prof-group" key={l.key}>
          <div className="prof-label">{l.label}</div>
          <ul className="memory-list">
            {l.items.map((it, i) => (
              <li key={i}><span>{it}</span><button className="x" title={L("Supprimer", "Remove")} aria-label={L("Supprimer", "Remove")} onClick={async () => { try { setP(await api.delProfile(l.key, i)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }}>×</button></li>
            ))}
          </ul>
          <AddRow placeholder={L(`Ajouter : ${l.label.toLowerCase().replace(/s$/, "")}…`, `Add a ${l.label.toLowerCase().replace(/s$/, "")}…`)} onAdd={async (v) => { try { setP(await api.setProfile(l.key, v)); } catch (e: any) { notify(e?.message || saveErr(), "error"); } }} />
        </div>
      ))}
      {count === 0
        ? <div className="muted small">{L("Vide pour l'instant — Otto le remplit au fil du travail, ou ajoute ton nom, une description, tes préférences, personnes et projets ici.", "Empty for now — Otto fills this in as it works, or add your name, about, preferences, people and projects here.")}</div>
        : <div className="forget-row">
            <button
              className="btn xs forget"
              onClick={async () => {
                if (!window.confirm(L("Oublier tout ce qu'Otto a appris sur toi ? Ça efface ta description, préférences, personnes et projets, sans retour en arrière possible.", "Forget everything Otto has learned about you? This clears your About, preferences, people and projects, and can't be undone."))) return;
                try { setP(await api.clearProfile()); } catch (e: any) { notify(e?.message || saveErr(), "error"); }
              }}
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
  // onAdd already notifies on failure (see ProfileEditor) and never rejects — but guard anyway so a future
  // caller that DOES reject can't clear the user's typed text or leave an unhandled rejection here.
  const go = async () => { const v = text.trim(); if (!v) return; try { await onAdd(v); setText(""); } catch { /* text stays — onAdd already surfaced the error */ } };
  return (
    <div className="addrow">
      <input className="addinput sm" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="btn" disabled={!text.trim()} onClick={() => void go()}>{L("Ajouter", "Add")}</button>
    </div>
  );
}

function AddTask({ onAdded }: { onAdded: Dispatch<SetStateAction<WebTask[]>> }) {
  const L = useLang();
  const notify = useNotify();
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
      const fresh = await api.add(v, whenToSend || undefined, stubId);
      // Defensive: a 401 (session expired) resolves instead of throwing (see api.ts's j()), returning the
      // error BODY where an array was expected. Setting `tasks` state to that non-array object crashed the
      // whole app on the next render — which, from the outside, looked exactly like the new task vanishing.
      if (!Array.isArray(fresh)) throw new Error(L("On dirait que tu as été déconnecté — recharge la page.", "Looks like you got logged out — reload the page."));
      onAdded(fresh);
    } catch (e: any) {
      onAdded((prev) => prev.filter((t) => t.id !== stubId));
      setText(v); setWhen(whenToSend);
      notify(e?.message || L("Impossible d'ajouter cette tâche — réessaie.", "Couldn't add this task — try again."), "error");
    }
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
