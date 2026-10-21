import { useEffect, useState, useCallback, useRef } from "react";
import type { WebTask, ConnectionStatus } from "../shared/types.ts";
import { canonStatus, isHandled, isInFlight, sortWithinQuadrant } from "../shared/types.ts";
import { api } from "./api.ts";
import { saveDeckLocally } from "./localDecks.ts";
import { saveQuizLocally } from "./localQuizzes.ts";
import { hydrateLocalThreads } from "./localChatBoard.ts";
import { pushError } from "./errorLog.ts";
import { useIsPhone } from "./useIsPhone.ts";
import { LangContext, useLang, todayIso, relTime, TaskModal, NotifyContext, PageInfoHint, Spinner } from "./ui.tsx";
import { t } from "./i18n.ts";
import { TaskCardRow, TaskFocus, TaskReadOnly } from "./TaskCard.tsx";
import { StudyMode } from "./study/StudyMode.tsx";
import { TutorSession } from "./tutor/TutorSession.tsx";
import { Coursework } from "./CourseworkPage.tsx";
import { ExercisesPage } from "./ExercisesPage.tsx";
import { TourProvider, PageTour } from "./PageTour.tsx";
import { TOURS } from "./tours.ts";
import { LEGAL_EMAIL, LEGAL_ENTITY, Logo, clearAllLocalAccountData, firstName, navigate, unionChatEntries } from "./appShared.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Onboarding } from "./pages/Onboarding.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { StudyLogPage } from "./pages/Journal.tsx";
import { StandaloneStudyEntry } from "./pages/StudyEntry.tsx";
import { AdminPage } from "./pages/Admin.tsx";
import { MistakeLogPage } from "./pages/MistakeLog.tsx";
import { AddTask, ConnectCard, TaskSkeleton } from "./pages/Dashboard.tsx";
import { PrivacyBody, ResearchPageBody, TermsBody } from "./pages/Legal.tsx";
import { PAGE_META, ORIGIN } from "../shared/seo.ts";
import { BlogIndexPage, BlogPostPage } from "./pages/Blog.tsx";

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
  if (/nothing connected/i.test(note)) return "No apps are connected for this account — connect one in Settings (Pronote, Gmail…) so Otto has something to read, or add tasks yourself.";
  if (/paused/i.test(note)) return "AI is paused — resume it in Settings to sweep for new tasks.";
  return `Sweep didn't finish: ${note.replace(/^(skipped:|sweep \w+:?)\s*/i, "")}`;
}

// Today, full form for the dashboard's top-of-page date line — "dimanche 23 août" / "Sunday, August 23".
function todayLong(lang?: string): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** Study Mode's in-app entry points — the sidebar "Réviser"/"Study" item and the per-task Study Mode
 *  buttons — are OFF by design: the /study URL is its ONE entry point (product call: "bring it back,
 *  but not as a tab — only accessible by going to the /study page"). Nothing is deleted and the route
 *  is fully alive either way: /study renders StandaloneStudyEntry (the complete StudyMode workspace,
 *  no task anchor). Flip to true to restore the tab + buttons — and update run.mjs's pins, which pin
 *  this flag false as the intended state. */
const STUDY_MODE_ENABLED = false;

/** Strip leading/trailing slashes → the bare route ("" = dashboard, "settings", "login", "task/<id>"). */
const HOME_TITLE = "Otto — the voice tutor that never gives you the answer";
const PUBLIC_ROUTES = new Set(["", "research", "privacy", "terms", "blog"]);
const isPublicRoute = (r: string) => PUBLIC_ROUTES.has(r) || (r.startsWith("blog/") && !!PAGE_META[r]);
/** Title, canonical and robots for the current route. Public pages are indexable; everything behind login (and any
 *  path the app doesn't know) is `noindex` so search engines never index app screens or soft-404s. */
function applyPageMeta(route: string): void {
  try {
    const meta = PAGE_META[route];
    document.title = meta ? meta.title : route === "" ? HOME_TITLE : document.title;
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = ORIGIN + (meta ? meta.path : "/");
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!isPublicRoute(route)) {
      if (!robots) { robots = document.createElement("meta"); robots.name = "robots"; document.head.appendChild(robots); }
      robots.content = "noindex, nofollow";
    } else robots?.remove();
  } catch { /* meta is best-effort */ }
}
const routeOf = (pathname: string) => pathname.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Tiny dependency-free History-API router (clean paths like /login, /settings, /task/<id> — no hash).
 * Both the Vite dev server and the Express prod server fall back to index.html for any path, so a deep
 * link or refresh resolves. A delegated click handler routes internal <a href="/..."> links in-app
 * (no full reload) — but lets REAL server routes (/auth/*, /api/*) and new-tab/download links through.
 */
function usePathRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => {
    const r = routeOf(window.location.pathname);
    if (r === "" && CACHED_STATUS?.loggedIn) return "tasks";
    return r;
  });
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

// Last-known task list — hydrates the dashboard INSTANTLY on open (server truth replaces it right after).
const CACHED_TASKS: WebTask[] = (() => {
  try { const t = JSON.parse(localStorage.getItem("otto-tasks") || "[]"); return Array.isArray(t) ? t : []; } catch { return []; }
})();

// Start the task fetch NOW (parallel with /api/status) when the last visit was signed in, instead of waiting for status
// to resolve first — the first sync consumes it, so the list refreshes one round-trip sooner.
let EARLY_TASKS: Promise<WebTask[] | null> | null = CACHED_STATUS?.loggedIn ? api.tasks().catch(() => null) : null;

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
  useEffect(() => { document.documentElement.lang = "en"; }, [status?.language]);
  // Fired once per app load (not per status refresh) — only once we actually know an account is signed in.
  useEffect(() => { if (status?.loggedIn) void api.recordMetric("app_session_started", 1); }, [status?.loggedIn]);
  // Fifth bandit target (see DENSITY_ARMS, server/bandit.ts) — fetched ONCE per app load, applied as
  // [data-density] on <html> (client/styles.css's variant tokens). Deliberately not re-fetched or re-applied
  // mid-session: an auto-changing layout under someone while they're using the app would be the opposite of
  // "calm", so this is a one-time-per-load pick, same posture as Pomodoro/audio being decided once at
  // Study Mode's Start rather than continuously. Signed-out visitors (status null) get no density call at
  // all — the landing page has no profile to suggest anything from yet.
  useEffect(() => {
    if (!status) return;
    void api.densitySuggestion().then((d) => {
      if (d.density !== "cozy") document.documentElement.setAttribute("data-density", d.density);
      else document.documentElement.removeAttribute("data-density");
      // Cached so StudyMode.tsx can report which arm was actually showing when a session ends, without
      // needing its own round-trip or prop-drilling this all the way down — a cheap, non-critical read.
      try { localStorage.setItem("otto-density-arm", d.manual ? "" : d.density); } catch { /* ignore */ }
    }).catch(() => {});
  }, [!!status]);
  // Momentum callout — "you've kept up with math four days running" — surfaced on the dashboard itself,
  // not buried in Settings' quiet "what Otto's learned" panel (the ONLY place subjectMastery's trend was
  // rendered before this). A genuine, already-computed "up" trend is real rapport-building at the app level
  // (same reasoning as chatAboutTask's growthLine in server/claude.ts, just surfaced here instead of only
  // mid-conversation) — fetched once per load, same one-shot posture as the density suggestion above; a
  // trend can't meaningfully change within a single session, so no need to re-poll.
  const [momentumSubject, setMomentumSubject] = useState<string | null>(null);
  useEffect(() => {
    if (!status?.loggedIn) return;
    void api.patternsSummary().then((p) => {
      const up = p.subjectMastery.find((s) => s.trend === "up");
      setMomentumSubject(up ? up.subject : null);
    }).catch(() => {});
  }, [status?.loggedIn]);
  // AI-personalized theme (opt-in, see Settings) — applied as inline custom-property overrides on <html>,
  // never a stylesheet swap. Re-applies whenever status refreshes so a change made in one tab/device shows
  // up here too, and clears cleanly (removeProperty) when customTheme is unset — e.g. after Reset.
  useEffect(() => {
    const root = document.documentElement;
    const keys = ["--bg", "--surface", "--bg-2", "--line", "--radius", "--radius-sm", "--radius-xs"] as const;
    for (const k of keys) {
      const v = status?.customTheme?.[k];
      if (v) root.style.setProperty(k, v); else root.style.removeProperty(k);
    }
  }, [status?.customTheme]);
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
    return "en";
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
  // Keep the authenticated shell stable during a transient status response. A focus refresh can briefly
  // receive a 401/expired-looking response while the session cookie is being refreshed; replacing the
  // authenticated status immediately unmounts StudyMode and looks like a random exit. Explicit sign-out
  // still wins because it sets signedOutRef before calling the server.
  const lastAuthenticatedStatusRef = useRef<ConnectionStatus | null>(CACHED_STATUS?.loggedIn ? CACHED_STATUS : null);
  const [route] = usePathRoute();
  // Keep the tab title, canonical and robots meta right when the page changes without a reload (the static HTML
  // already carries them for a direct load): public pages get their own, app screens and unknown paths are noindex.
  useEffect(() => { applyPageMeta(route); }, [route]);
  // Phone-sized screens keep the focused tutor available alongside the task list, journal, and settings.
  // Dense workspaces remain restricted, but tutor is intentionally designed as a single-column, touch-first
  // surface and must be reachable from a phone without being redirected back to Today.
  const isPhone = useIsPhone();
  const PHONE_ALLOWED_ROUTES = ["", "tasks", "log", "settings", "tutor", "exercises", "full"];
  const phoneRouteAllowed = (r: string) => PHONE_ALLOWED_ROUTES.includes(r) || r.startsWith("task/") || r.startsWith("tutor/session/");
  useEffect(() => {
    if (isPhone && status?.loggedIn && !phoneRouteAllowed(route)) navigate("tasks");
  }, [isPhone, status?.loggedIn, route]);
  // Explicit escape hatch off ConnectCard's connect-wall (see its own comment + the gating condition
  // further down) — a student with nothing connected can choose to use Otto with manually-added tasks and
  // tutoring only, instead of being hard-blocked behind "connect Pronote first." Per-device, not per-
  // account: deliberately not synced to the profile, since connecting later should still work seamlessly
  // and this is just a local "stop showing me that wall" preference, not a real account setting.
  const [skippedConnect, setSkippedConnect] = useState(() => {
    try { return localStorage.getItem("otto-skip-connect") === "1"; } catch { return false; }
  });
  const [tasks, setTasks] = useState<WebTask[]>(CACHED_TASKS);
  // THE actual cross-account leak (not a read bug — a WRITE bug): tracks whether `status.user` just changed
  // on the render that's about to commit, computed SYNCHRONOUSLY during render (not inside an effect) so
  // it's already correct by the time any effect below runs. Why this can't just be a second useEffect: when
  // an account switch happens without signOut() having cleared `tasks` first (session merely expired, or a
  // delete-account/new-signup in close succession), React can land BOTH "status.user changed" and "tasks is
  // still the OLD account's array" in the SAME render — a `[tasks, status?.user]`-keyed effect fires with
  // userId already pointing at the NEW account but `tasks` still holding the OLD account's decks, and
  // (reported live, confirmed by tracing it) the save-effect below wrote the OLD account's flashcard decks
  // straight into the NEW account's local storage key. Reordering effects or adding a `loaded` check doesn't
  // fix this: a sibling effect's setState call can't retroactively un-stale a closure that's already
  // executing in the same flush. Computing this flag inline during render, before any effect runs, is what
  // makes it reliable — see the save-effect's own guard just below.
  const prevUserRef = useRef(status?.user ?? null);
  const userJustChanged = prevUserRef.current !== (status?.user ?? null);
  prevUserRef.current = status?.user ?? null;
  // Every flashcard deck Otto has ever generated gets mirrored to this browser's localStorage (see
  // client/localDecks.ts) — a real DB write already happens server-side, but this is a local backup so a
  // deck survives (viewable, if not reviewable-with-progress-sync) even through a sync hiccup or briefly
  // being offline. Cheap: saveDeckLocally no-ops on content that's already saved, and this only runs when
  // the task list actually changes.
  useEffect(() => {
    // Skip the one render where the account identity just changed — `tasks` here may still be a stale
    // array left over from the PREVIOUS account (see userJustChanged's own comment above). The very next
    // render (once `tasks` has actually been cleared/refetched for the new account) runs this normally.
    if (userJustChanged) return;
    const userId = status?.user || null;
    for (const t of tasks) {
      const logDate = t.source === "studylog" && t.logDate && !t.logDate.includes(":") ? t.logDate : undefined;
      for (const deck of t.flashcards || []) saveDeckLocally(t.id, t.title, deck, logDate, userId);
      for (const quiz of t.quizzes || []) saveQuizLocally(t.id, t.title, quiz, logDate, userId);
    }
  }, [tasks, status?.user, userJustChanged]);
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
    // Every error-kind toast app-wide flows through this ONE function (NotifyContext) — the single choke
    // point to also keep a persistent, visible record (Settings' "Error log") instead of a toast that
    // vanishes in 12s and is gone forever, which was the actual complaint: "sometimes it shows this, this
    // doesn't make sense" with no way to go back and see what happened or report it precisely.
    if (msg && kind === "error") pushError(msg);
  }, []);
  const dismissNote = useCallback(() => { if (noteTimer.current) clearTimeout(noteTimer.current); setNote(""); }, []);
  // Onboarding is hidden for now (the code stays): nobody is walked through it, new accounts go straight to the tutor.
  const ONBOARDING_ENABLED = false;
  const [onboard, setOnboard] = useState(() => { if (!ONBOARDING_ENABLED) return false; try { return localStorage.getItem("otto-onboard") === "1"; } catch { return false; } });
  // Page guides already shown (client/PageTour.tsx): cached locally for instant paint, merged with the account's
  // server-side list so a guide never repeats on another device.
  const [toursSeen, setToursSeen] = useState<Set<string>>(() => { try { return new Set<string>(JSON.parse(localStorage.getItem("otto-tours-seen") || "[]")); } catch { return new Set<string>(); } });
  const markTourSeen = useCallback((id: string) => {
    setToursSeen((prev) => {
      if (prev.has(id)) return prev;
      const n = new Set(prev); n.add(id);
      try { localStorage.setItem("otto-tours-seen", JSON.stringify([...n])); } catch { /* best-effort */ }
      return n;
    });
    void api.markTourSeen(id).catch(() => { /* best-effort — the local flag already stops a repeat on this device */ });
  }, []);
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
  useEffect(() => {
    const server = status?.toursSeen;
    if (server?.length) setToursSeen((prev) => { const n = new Set([...prev, ...server]); return n.size === prev.size ? prev : n; });
  }, [status?.toursSeen]);
  // First-run onboarding is the ONE place Otto is explained — set on signup, cleared when the flow finishes.
  const startOnboard = () => { if (!ONBOARDING_ENABLED) return; try { localStorage.setItem("otto-onboard", "1"); } catch { /* ignore */ } setOnboard(true); };
  const finishOnboard = () => {
    try { localStorage.removeItem("otto-onboard"); localStorage.removeItem("otto-onboard-step"); localStorage.removeItem("otto-onboard-track"); } catch { /* ignore */ }
    setOnboard(false);
    // Finished OR skipped: remember it on the account so the basic flow doesn't come back on another device.
    void api.markOnboarded().then(() => loadStatusRef.current()).catch(() => { /* best-effort */ });
  };
  // "Test onboarding" (Settings): forget the basic flow and every page guide, then replay from the top.
  const replayOnboarding = async () => {
    try { await api.resetOnboarding(); } catch { /* still replay locally */ }
    try { localStorage.removeItem("otto-tours-seen"); localStorage.removeItem("otto-onboard-step"); } catch { /* ignore */ }
    setToursSeen(new Set());
    onboardTriggered.current = true;
    navigate("tasks");
    startOnboard();
  };
  const loadStatusRef = useRef<() => void>(() => {});
  const onboardTriggered = useRef(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  // Study Mode state
  const [studyModeTask, setStudyModeTask] = useState<WebTask | null>(null);
  // Briefly highlights the row a just-confirmed task lands in "Completed" — gives finishing something a
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

  const applyStatus = useCallback((next: ConnectionStatus) => {
    if (next.loggedIn) {
      lastAuthenticatedStatusRef.current = next;
      setStatus(next);
      return;
    }
    // Do not tear down an active authenticated shell for one transient unauthenticated response.
    // signOut() sets signedOutRef first, so intentional logout is unaffected.
    if (!signedOutRef.current && lastAuthenticatedStatusRef.current?.loggedIn) return;
    setStatus(next);
  }, []);
  const loadStatus = useCallback(async () => { try { applyStatus(await api.status()); } catch { /* keep last */ } }, [applyStatus]);
  loadStatusRef.current = () => { void loadStatus(); };
  // First open of a brand-new account that never saw (or finished) the basic flow — e.g. signed up in another
  // tab, or closed it before finishing. Accounts that clearly predate it are marked onboarded server-side.
  useEffect(() => {
    if (!status?.loggedIn || status.onboarded !== false || onboardTriggered.current) return;
    onboardTriggered.current = true;
    startOnboard();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, status?.onboarded]);

  // Persist the signed-in state so a returning user skips the login flash (reconciled on next load).
  useEffect(() => {
    try { status ? localStorage.setItem("weave-status", JSON.stringify(status)) : localStorage.removeItem("weave-status"); } catch { /* ignore */ }
  }, [status]);

  // Persist tasks so the NEXT open paints the dashboard instantly (capped — enough for first paint).
  useEffect(() => {
    try { localStorage.setItem("otto-tasks", JSON.stringify(tasks.slice(0, 60))); } catch { /* ignore */ }
  }, [tasks]);

  const [initialStatusChecked, setInitialStatusChecked] = useState(false);
  // Retry status until the backend is reachable (tsx dev-server boot race) — don't get stuck on the spinner.
  // After the retries are exhausted, surface a real "can't reach the server" screen instead of a forever-spinner.
  useEffect(() => {
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try { const s = await api.status(); if (!stop) { applyStatus(s); setInitialStatusChecked(true); setLoadError(false); } }
      catch { if (!stop) { if (tries++ < 30) setTimeout(tick, 1000); else { setInitialStatusChecked(true); setLoadError(true); } } }
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
    // A tutor session's chat/board/problems/objectives live in THIS browser (server/index.ts's tutor turn
    // writes none of them), so this overlay is what makes them survive a reload — local storage wins, and the
    // server's copy only fills a field local storage has nothing for (a pre-local-switch conversation). It is
    // the one choke point every "fresh list from the server" path (initial load, polling, sync) runs through.
    incoming = hydrateLocalThreads(incoming, status?.user || null);
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
    const early = EARLY_TASKS; EARLY_TASKS = null;
    const t = await (early ?? api.tasks().catch(() => null));
    if (signedOutRef.current) return; // signed out while the request was in flight — drop the stale response
    if (t) setTasks((prev) => keepLocalHandled(prev, retryFlags(t)));
    setLoaded(true);
  }, []);

  // Continuous monitoring: run a background sweep when the last SUCCESSFUL one is older than the watch
  // interval (the server gates too — a too-soon call is a fast no-op). The marker is only set on SUCCESS,
  // so a failed/timed-out sweep retries on the next trigger instead of silently losing its slot. Each
  // sweep is a cheap read-only DELTA ("what's new since the list was built"), which is what makes
  // watching all day affordable.
  // Once a day, fixed at 16:00 (4pm) local time — not a multi-times-a-day cadence (was: genPerDay 1-4x/day,
  // spaced by SWEEP_EVERY_MS). Mirrors server/jobs.ts's sweepDue exactly: never due before 4pm even if
  // nothing's run yet today; due once from 4pm onward, not due again until tomorrow. Manual "Refresh" is a
  // completely separate call (api.generate(true)) and is untouched by this.
  const SWEEP_HOUR = 16;
  const sweeping = useRef(false);
  const sweepIfDue = useCallback(async () => {
    if (signedOutRef.current || !connected || status?.paused || sweeping.current) return;
    if (new Date().getHours() < SWEEP_HOUR) return;
    let last = 0;
    try { last = Number(localStorage.getItem("otto-lastgen") || 0); } catch { /* sweep anyway */ }
    const sameLocalDayAsLast = last > 0 && new Date(last).toDateString() === new Date().toDateString();
    if (sameLocalDayAsLast) return;
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
      if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, status?.language === "en"), /paused|connected/i.test(serverNote) ? "error" : "info");
      try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ }
    } catch { /* marker stays unset — next focus/interval tick retries */ }
    finally { sweeping.current = false; setScanning(false); }
  }, [connected, status?.paused]);

  // Once Google is connected: load tasks and trigger the daily sweep (silent, in background), in parallel.
  useEffect(() => {
    // A student who skipped connecting Google/Pronote (skippedConnect, see the ConnectCard gate below)
    // stays permanently `!connected` by design — Otto still works for them via manually-added tasks and
    // tutoring. But `loaded` (which controls the dashboard's loading skeleton) was ONLY ever flipped true
    // inside syncTasks/sweepIfDue/generate, all of which this effect is the sole auto-trigger for — so a
    // skip-connect student with zero manually-added tasks never fired any of them, and the "Pulling up your
    // day…" skeleton (TaskSkeleton, gated on `live.length === 0 && (busy || !loaded)`) spun forever with no
    // request ever in flight to resolve it. Reported live as "stuck on pulling up your day with no tasks."
    // There's nothing to sync from the server for a never-connected account, so just flip loaded directly.
    if (!connected) { setLoaded(true); return; }
    void syncTasks(); void sweepIfDue();
  }, [connected, status?.aiReady, syncTasks, sweepIfDue]);

  // Returning to the tab re-syncs the list (tasks finished elsewhere appear WITHOUT a manual reload) and
  // sweeps again if the watch interval has passed — so Otto keeps watching throughout the day, and the
  // list is never stuck waiting for a tab-switch to show up.
  // Touch Pronote's session the MOMENT the app confirms it's connected — not just on the next focus/
  // visibility event or the 15-min heartbeat tick below. Without this, opening the app after a long break
  // (overnight, a weekend) waited up to 15 minutes before the first refresh attempt, during exactly the
  // window where a stale token is most likely to have gone idle long enough to die. Separate from the main
  // heartbeat effect below so it fires once per connect, not on every tick. touchPronoteSession itself
  // (server/pronote.ts) is what actually rate-gates the real work (2h), so this is always a cheap call.
  useEffect(() => {
    if (connected && status?.pronoteConnected) void api.pronoteTouch();
  }, [connected, status?.pronoteConnected]);
  const lastFocusSyncRef = useRef(0);
  useEffect(() => {
    if (!connected) return;
    // Used to also re-sync tasks/status/budget/sweep on every tab focus/visibilitychange event (4 requests
    // each time) — removed per direct instruction: that's real, avoidable egress for something a manual
    // reload already covers, and this app doesn't promise live cross-tab sync on every alt-tab. Only the
    // Pronote keepalive stays wired to this heartbeat — it's not about re-fetching Otto's own state, it's
    // about not leaving a connected student's Pronote token idle long enough to die before the next real
    // fetch or the once-daily cron would otherwise discover it's dead (see touchPronoteSession's own
    // comment in server/pronote.ts). server/pronote.ts gates the real work to at most once per few hours,
    // so calling this every tick here costs nothing beyond one cheap, mostly-no-op request.
    const on = () => {
      if (document.hidden || signedOutRef.current) return;
      const now = Date.now();
      if (now - lastFocusSyncRef.current < 120_000) return;
      lastFocusSyncRef.current = now;
      if (status?.pronoteConnected) void api.pronoteTouch();
    };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    // A backend-generated task (from cron, another device, or a queued-but-not-auto-run item) is only ever
    // shown by a task re-fetch. The old 15-min tick meant such a task could sit INVISIBLE on an open, idle
    // tab for up to 15 minutes ("it generated but doesn't show"). Poll the cheap /api/tasks GET every 90s so
    // new tasks surface quickly; the heavier sweep it also triggers stays gated by the user's cadence
    // (sweepIfDue is a fast no-op until due), so this doesn't sweep more often. Also re-pull /api/status on
    // the same tick — account-level fields (language, in particular) can change in another tab/device, and
    // without this an already-open session would show a stale language until reload.
    // Was 45s, then 90s, then 3min. Raised again to 5min after a real Supabase egress-cap outage — every
    // tick re-hydrates the Supabase-backed session (the FULL profile+tasks blob, see store.ts's
    // SupabaseStore.get) on the server, so this interval is a direct multiplier on Supabase egress across
    // every open tab/device, confirmed live as the account's single biggest egress driver. On Vercel the
    // server-side read cache (store.ts, now 3min) only helps when a request happens to land on the SAME warm
    // serverless instance — fewer polls is the one lever that reduces total request volume regardless of
    // that, so this and the cache TTL bump are complementary, not redundant. 5 min still surfaces a new task
    // well within a normal session.
    // Tab hidden or closing: ask the server to write its pending (write-behind) snapshot now. keepalive lets the request outlive the page.
    const flushOnHide = () => { if (document.visibilityState === "hidden" && !signedOutRef.current) void api.flushSync(); };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flushOnHide);
    const syncTick = setInterval(() => { if (!document.hidden && !signedOutRef.current) { void syncTasks(); void loadStatus(); } }, 20 * 60_000);
    const fullTick = setInterval(on, 30 * 60_000); // periodic Pronote keepalive heartbeat — was also a budget/sweep refresh before that got removed above
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); document.removeEventListener("visibilitychange", flushOnHide); window.removeEventListener("pagehide", flushOnHide); clearInterval(syncTick); clearInterval(fullTick); };
  }, [connected, syncTasks, loadStatus, status?.pronoteConnected]);

  // THE SERVER OWNS EXECUTION. The browser no longer decides what runs — sweeps queue execution jobs
  // server-side, cron drains them offline. While anything is queued/executing, the OPEN client "kicks"
  // the drain (one bounded job per kick) so online users see work complete within seconds instead of at
  // the next cron tick, and folds each kick's fresh task state straight into the list.
  const kicking = useRef(false);
  // Task ids with a genuinely active (queued/running) job — the only honest basis for "retrying…".
  const [retryingIds, setRetryingIds] = useState<string[]>([]);
  // Kicks continue through failed_retryable too — the failed attempt's job is REQUEUED server-side, so
  // "Failed — will retry" actually retries within seconds while the tab is open (not at the next cron).
  // Deliberately NOT true for a plain "ready" task that's never been attempted — that used to also count as
  // "active work" so a merely-ready task would get auto-enqueued and run the moment the tab was open, any
  // time of day. Reverted: AI spend should only happen at the once-daily 4pm sweep (which still auto-runs
  // its own top-N by score — see processSweep/autoRunBudgetLeft in server/jobs.ts,tasks.ts), in chat, or in
  // Journal/Study Mode — not continuously throughout the day just because a tab is sitting open. A ready
  // task with no button now simply waits for the next 4pm cycle instead of being caught up mid-day.
  const hasActiveWork = (list: WebTask[]) => list.some((t) => isInFlight(t.status) || canonStatus(t.status) === "failed_retryable");
  useEffect(() => {
    if (!connected || !loaded || status?.paused) return;
    if (!hasActiveWork(tasks)) return;
    const tick = async () => {
      // Backgrounded tabs don't need live updates within seconds — this loop runs while ANY job is in
      // flight, uncached server-side (bypassCache: true, see /api/jobs/kick), so an unguarded background
      // tab was a real, continuous Supabase egress + CPU cost for however long a job stayed
      // queued/retrying, with no one watching. Confirmed as the dominant egress driver in a live audit.
      if (kicking.current || signedOutRef.current || document.hidden) return;
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
    // Was 10s — halved the request RATE (not just the per-request cost) per direct instruction to cut
    // egress further. 20s still surfaces a finished/failed task well within one "is it done yet" glance — just fewer identical
    // "still running" round-trips.
    const id = setInterval(tick, 20000);
    // Catch up immediately when the tab regains focus, instead of waiting up to 10s for the next tick —
    // the guard above means a backgrounded tab may have missed several ticks entirely.
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
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
      if (stillRunning) notify("Still checking — hang on a moment.");
      else if (/^(skipped:|sweep )/.test(serverNote)) notify(sweepSkipMessage(serverNote, sweepEn), /paused|connected/i.test(serverNote) ? "error" : "info");
      // Name whatever source is actually connected instead of assuming Pronote — a Google-only (or manual)
      // student was being told about a school portal they never linked.
      else if (!t.length) notify(`You're all set — nothing new from ${status?.pronoteConnected ? "Pronote" : status?.googleConnected ? "your inbox" : "your sources"} yet.`);
      else if (!fresh.length) notify(`Checked — no new tasks${needsYou ? `; ${needsYou} still need${needsYou === 1 ? "s" : ""} you` : "; everything's already on your list"}.`);
      else notify(`Found ${fresh.length} new task${fresh.length === 1 ? "" : "s"}${queuedN ? `, ${queuedN} getting ready` : ""}${needsYou ? `, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}.`);
    }
    catch (e: any) {
      // A long sweep that outran the client timeout is NOT a failure — it's still running server-side and
      // will commit its tasks. Saying "couldn't refresh" there is actively wrong (the student retries,
      // which just spends more AI on a sweep already in flight). Say it's still working and pick the
      // results up on our own, so the tasks appear without them having to do anything.
      if (e?.sweepStillRunning) {
        notify("Still checking — this one's taking a while. New tasks will appear here on their own.");
        window.setTimeout(() => { void syncTasks(); }, 20_000);
        window.setTimeout(() => { void syncTasks(); }, 60_000);
        return;
      }
      notify(`Couldn't refresh: ${e?.message || "something went wrong — try again."}`, "error");
    }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    signedOutRef.current = true;
    lastAuthenticatedStatusRef.current = null;
    setStatus(null);
    try { await api.logout(); } catch { /* ignore */ }
    clearAllLocalAccountData(status?.user || null);
    setTasks([]); setLoaded(false); generatedOnce.current = false; navigate(""); void loadStatus();
  };

  // Signed in, the dashboard lives at /tasks. Redirect the bare "/" there (landing only shows signed-OUT).
  useEffect(() => { if (status?.loggedIn && route === "") navigate(status.home === "tasks" ? "tasks" : "tutor"); }, [status?.loggedIn, status?.home, route]);
  // THE TUTOR IS THE APP: an account that isn't the owner and hasn't opened /full only ever sees the tutor (and /full, the legal pages).
  const fullApp = !!status?.fullApp;
  const [fullError, setFullError] = useState<string | null>(null);
  const [fullTry, setFullTry] = useState(0);
  useEffect(() => {
    if (!status?.loggedIn || fullApp) return;
    const ok = route === "tutor" || route.startsWith("tutor/session/") || route === "settings" || route === "full" || (route === "admin" && !!status?.isAdmin) || route === "privacy" || route === "terms" || route === "research" || route === "blog" || route.startsWith("blog/");
    if (!ok) navigate("tutor");
  }, [status?.loggedIn, fullApp, route]);
  // /full: unlock everything for this account, then show Today.
  useEffect(() => {
    if (route !== "full" || !status?.loggedIn) return;
    let cancelled = false;
    setFullError(null);
    (async () => {
      try {
        if (!fullApp) await api.enableFullApp();
        await loadStatus();
        if (!cancelled) navigate("tasks");
      } catch (e: any) { if (!cancelled) setFullError(String(e?.message || "Couldn't open everything.")); }
    })();
    return () => { cancelled = true; };
  }, [route, status?.loggedIn, fullTry]);

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

  // Keep a stable reference to the task being studied so background syncs (syncTasks every 5min, or on
  // tab focus) don't remove it from the `tasks` array and unmount StudyMode mid-session — the root cause
  // of "study mode randomly exits." Updates studyModeTask when the task is found in tasks (so step
  // changes propagate), but NEVER clears it when the task is missing (preserving the study session).
  useEffect(() => {
    if (!route.startsWith("study/")) return;
    const taskId = route.split("/")[1];
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    // Never let this overwrite or replace the live study thread with a stale background response. A
    // refresh can return the same number of messages but an older conversation (or omit a just-sent
    // optimistic turn), so comparing lengths alone is not sufficient.
    // UNION by (role, at, text) — the same key-based approach server-side's unionChat (tasks.ts) already
    // uses for exactly this — rather than a positional "incoming[i] must equal local[i]" prefix check: that
    // was fragile precisely because "sometimes" (not always) a background sync's copy of a message can carry
    // a slightly different shape than the optimistic local echo (an artifacts chip attached after a round
    // trip, whitespace normalized server-side, etc.) — the MOMENT any single position failed to match
    // exactly, the entire incoming thread was discarded outright instead of just that one already-duplicate
    // entry, which is what "chat sometimes auto-deletes stuff" actually was: not messages vanishing, but a
    // background sync's fresher copy (with a genuinely NEW message from another tab/device) losing entirely
    // to a local copy that just LOOKED different by one cosmetic field on one older message.
    setStudyModeTask((prev) => {
      if (prev?.id !== task.id) return task;
      const localChat = prev.chat || [];
      if (!localChat.length) return task;
      const merged = unionChatEntries(localChat, task.chat || []);
      return { ...task, chat: merged };
    });
  }, [route, tasks]);

  // Legal pages are PUBLIC — reachable logged-out or in, and even before status loads. Rendered before
  // the LangContext.Provider further down mounts, so they get their own — otherwise useLang() inside them
  // silently defaults to French regardless of the account's actual language (or the signed-out visitor's
  // browser), which is exactly how these ended up 100% English-hardcoded with no L() calls at all.
  if (route === "privacy") return <LegalPage kind="privacy" lang={status?.loggedIn ? status.language : preLoginLang} />;
  if (route === "terms") return <LegalPage kind="terms" lang={status?.loggedIn ? status.language : preLoginLang} />;
  if (route === "research") return <ResearchPage lang={status?.loggedIn ? status.language : preLoginLang} />;
  if (route === "blog") return <LangContext.Provider value="en"><BlogIndexPage /></LangContext.Provider>;
  if (route.startsWith("blog/")) return <LangContext.Provider value="en"><BlogPostPage slug={route.slice(5)} /></LangContext.Provider>;

  if (!status || !initialStatusChecked) {
    if (loadError) {
      // This is the ONE screen that can render before status (and so LangContext) has ever loaded — a
      // student on a bad connection would see it hardcoded in English on a French-default app. Fall back
      // to whatever's cached from a previous session; French if there's truly nothing to go on.
      const crashEn = CACHED_STATUS?.language === "en";
      return (
        <div className="screen crash">
          <div className="crash-card">
            <h1>{"Can't reach Otto"}</h1>
            <p>{"The server isn't responding. Check your connection and try again."}</p>
            <button className="btn primary big" onClick={() => { setLoadError(false); setReloadKey((k) => k + 1); }}>{"Try again"}</button>
          </div>
        </div>
      );
    }
    return <div className="screen"><div className="brand boot"><Logo size={26} /> Otto</div><Spinner /></div>;
  }
  if (!status.loggedIn) {
    // Carry the visitor's pre-account language choice into their new account — otherwise every signup
    // silently reset to French the moment status.language (server-driven, defaults "fr") took over.
    const onNewAccount = async () => {
      try { await api.setProfilePreference("language", preLoginLang); } catch { /* best-effort */ }
    };
    return (
      <LangContext.Provider value={preLoginLang}>
        {route === "login" || route === "signup" || route === "reset-password"
          ? <LoginPage status={status} lang={preLoginLang} onLangChange={setLandingLang} onDone={async (isNew) => {
              signedOutRef.current = false;
              // Defensive, same reasoning as clearAllLocalAccountData's own comment: a brand-new account
              // has no business trusting ANY pre-existing local cache on this browser (a previous account
              // that was deleted/signed-out-of incompletely, e.g. the session merely expired rather than
              // an explicit sign-out). loadStatus()/the tasks fetch right after overwrite the in-memory
              // state regardless, so this mainly protects the NEXT reload (closing and reopening the tab)
              // from starting on stale data again.
              if (isNew) { clearAllLocalAccountData(null); await onNewAccount(); startOnboard(); }
              await loadStatus(); navigate("");
            }} initialMode={route === "signup" ? "signup" : route === "reset-password" ? "reset" : "login"} />
          : route === "" || route === "/"
          ? <Landing lang={preLoginLang} onLangChange={setLandingLang} />
          : <LoginPage status={status} lang={preLoginLang} onLangChange={setLandingLang} onDone={async () => { signedOutRef.current = false; await loadStatus(); navigate(route); }} initialMode="login" />}
      </LangContext.Provider>
    );
  }

  if (route.startsWith("study/")) {
    const taskId = route.split("/")[1];
    // Use the stable studyModeTask (survives background syncs) if it matches, otherwise look up from tasks.
    const task = studyModeTask?.id === taskId ? studyModeTask : tasks.find(t => t.id === taskId);
    if (task) {
      return (
        <LangContext.Provider value="en">
          <NotifyContext.Provider value={notify}>
            <StudyMode
              task={task}
              onExit={() => { setStudyModeTask(null); navigate("tasks"); }}
              onTaskUpdate={(u) => {
                // Register like patchTask does (see keepLocalHandled) — a chat turn is a local mutation too,
                // so a background syncTasks racing this update doesn't get treated as unconditionally newer.
                localMutations.current.set(u.id, Date.now());
                setTasks((prev) => prev.some((x) => x.id === u.id)
                  ? prev.map((x) => {
                      if (x.id !== u.id) return x;
                      const existingChat = x.chat || [];
                      if (!existingChat.length) return u;
                      return { ...u, chat: unionChatEntries(existingChat, u.chat || []) };
                    })
                  : [...prev, u]);
                setStudyModeTask((prev) => {
                  if (prev?.id !== u.id) return u;
                  const existingChat = prev.chat || [];
                  if (!existingChat.length) return u;
                  return { ...u, chat: unionChatEntries(existingChat, u.chat || []) };
                });
              }}
              userId={status?.user}
              language="en"
              betaFeatures={!!status?.betaFeatures}
            />
          </NotifyContext.Provider>
        </LangContext.Provider>
      );
    }
    // The task isn't in the current `tasks` list yet — either the dashboard's own load is still in flight
    // (this used to silently fall through to the normal dashboard, which read as "the button did nothing")
    // or the id is genuinely stale (task deleted/merged elsewhere). Show a spinner while `loaded` is still
    // false; only report a real error once loading has actually finished and the task truly isn't there.
    const enNow = status?.language === "en";
    return loaded
      ? (
        <main className="list-wrap">
          <div className="empty-state">
            <h3>{"Couldn't find that task"}</h3>
            <p>{"It may have been removed or merged — go back and try again."}</p>
            <button className="btn primary" onClick={() => navigate("tasks")}>{"Back to tasks"}</button>
          </div>
        </main>
      )
      : <div className="screen"><div className="brand boot"><Logo size={26} /> Otto</div><Spinner /></div>;
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
  // Translator for the (growing) slice of dashboard strings migrated to client/i18n.ts's catalog — named
  // `T` (not `t`) because this same function has dozens of `.filter((t) => …)`/`.map((t) => …)` callbacks
  // over tasks that shadow the module-level `t` import.
  // Deliberately NOT useT() (which reads LangContext): App() is the component that RENDERS
  // <LangContext.Provider value={status?.language...}> below — a component's own hook calls never see the
  // value it provides to its own JSX subtree, only what an ANCESTOR already provided. Since nothing wraps
  // App() itself, useT() here always read LangContext's hardcoded "fr" default regardless of the account's
  // actual language, while GREETING/todayLong (which read status?.language directly, same as `en` above)
  // got it right — reported live as the dashboard mixing English chrome with French sentences ("Good
  // afternoon, Willem." next to "Ensuite : ...") for an English-language account. Deriving the same way
  // GREETING/todayLong already do keeps every dashboard string in this function on one real source.
  const T = (key: string, vars?: Record<string, string | number>) => t(key, "en", vars);
  // Show first 3 tasks, rest behind "show more"
  const focusToday = live.slice(0, 3);
  // Today's real momentum — the ALL-TIME done count only ever grows, so a bar based on it would sit near
  // full forever and mean nothing. What a student actually wants to see is "how much of TODAY is left".
  const doneToday = completed.filter((t) => (t.updatedAt || t.createdAt || "").slice(0, 10) === todayIso()).length;
  const todayTotal = doneToday + live.length;
  // Any big-project milestone already past its date — the highest-urgency thing on the whole dashboard,
  // so it gets said in the header sentence rather than only living in the rail widget.
  const overdueCount = live.reduce((n, t) => n + (t.steps || []).filter((s) => !s.done && s.targetDate && s.targetDate < todayIso()).length, 0);

  return (
    <LangContext.Provider value="en">
    <NotifyContext.Provider value={notify}>
    <TourProvider seen={toursSeen} markSeen={markTourSeen} suppressed={onboard}>
    <div className="app">
      {/* Top nav — the prototype's single shell: lowercase "otto" wordmark left, plain text links right
          (Today/Tutor/Journal/Mistakes/Settings), active link in the orange. Replaces the old sidebar +
          page-title topbar entirely. Shown on EVERY route including Tutor — it used to be hidden there as
          a "focused, full-screen surface" (report-live ask: keep the nav). TutorSession still carries its
          own breadcrumb row ("All sessions / Mathematics … End session") below this header, and the stage
          subtracts --topnav-h from the viewport so it still fits exactly. */}
      <header className="topnav">
        <a className="topnav-brand" href={fullApp && status?.home === "tasks" ? "/tasks" : "/tutor"}>otto</a>
        {!fullApp ? (
          <nav className="topnav-links">
            <a className={`topnav-link ${route === "tutor" || route.startsWith("tutor/session/") ? "active" : ""}`} href="/tutor">{"Tutor"}</a>
            <a className={`topnav-link ${route === "settings" ? "active" : ""}`} href="/settings">{"Settings"}</a>
            {!isPhone && !!status?.isAdmin && <a className={`topnav-link ${route === "admin" ? "active" : ""}`} href="/admin">{"Usage"}</a>}
            <button type="button" className="topnav-link" onClick={() => void signOut()}>{"Sign out"}</button>
          </nav>
        ) : (
        <nav className="topnav-links">
          <a
            className={`topnav-link ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`}
            href="/tasks"
          >
            {"Today"}
          </a>
          <a
            className={`topnav-link ${route === "tutor" || route.startsWith("tutor/session/") ? "active" : ""}`}
            href="/tutor"
          >
            {"Tutor"}
          </a>
          <a
            className={`topnav-link ${route === "log" ? "active" : ""}`}
            href="/log"
          >
            {isPhone ? "Flashcards" : "Journal"}
          </a>
          {!isPhone && <a
            className={`topnav-link ${route === "coursework" ? "active" : ""}`}
            href="/coursework"
          >
            {"Coursework"}
          </a>}
          {/* Hick's law: four primary destinations stay in view; the rest sit one tap away under "More" so the bar offers fewer
              choices at once. The "More" label itself lights up when one of its pages is open. */}
          <details className="topnav-more" key={route}>
            <summary className={`topnav-link ${["errorlog", "settings"].includes(route) ? "active" : ""}`}>{"More"}</summary>
            <div className="topnav-more-menu">
              {!isPhone && <a className={`topnav-link ${route === "errorlog" ? "active" : ""}`} href="/errorlog">{"Mistakes"}</a>}
              <a className={`topnav-link ${route === "settings" ? "active" : ""}`} href="/settings">{"Settings"}</a>
              {!isPhone && !!status?.isAdmin && <a className={`topnav-link ${route === "admin" ? "active" : ""}`} href="/admin">{"Usage"}</a>}
            </div>
          </details>
        </nav>
        )}
      </header>

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'visible' }}>

      {/* Hoisted out of the dashboard-only branch below (where it used to live, inside the `route ===
          "settings" ? ... : (...)` ternary's else-arm) so it renders on EVERY route, not just /tasks —
          without this, every failed action in Settings (language toggle, grade edit, profile save, pause
          switch, disconnect...) had literally nowhere to show its error: the toast DOM node didn't exist
          on that route at all, regardless of whether `notify` was even called. */}
      {note && (
        <div className={`toast ${noteKind}`} role="status" aria-live="polite">
          <span className="toast-msg">{note}</span>
          <button className="toast-x" aria-label={"Close"} onClick={dismissNote}>✕</button>
        </div>
      )}

      {status?.loggedIn && status.autoPaused ? (
        <div className="autopause-banner" role="alert">
          <div>
            <b>{"AI is paused."}</b>
            <span>{" You haven't checked off a task in over a week, so Otto stopped using AI. Ready to get going again?"}</span>
          </div>
          <button type="button" className="btn primary" onClick={() => { void api.setPaused(false).then(() => loadStatus()).catch((e: any) => notify(e?.message || "Couldn't resume — try again.", "error")); }}>{"Restart AI"}</button>
        </div>
      ) : null}
      {status?.loggedIn && status.weekly?.over ? (
        <div className="autopause-banner" role="alert">
          <div>
            <b>{"This week's AI allowance is used up."}</b>
            <span>{` You've used $${status.weekly.usd.toFixed(2)} of $${status.weekly.limit.toFixed(2)}. It resets on Monday, or you can ask for more.`}</span>
          </div>
          {status.weekly.requested
            ? <span className="settings-hint">{"Requested. You'll get it as soon as it's approved."}</span>
            : <button type="button" className="btn primary" onClick={() => { void api.requestMoreUsage().then(() => loadStatus()).catch((e: any) => notify(e?.message || "Couldn't send the request — try again.", "error")); }}>{"Request more usage"}</button>}
        </div>
      ) : null}
      {onboard && <Onboarding status={status} onStatus={loadStatus} onDone={finishOnboard} />}
      {/* First visit to a page: an interactive guide pointing at the real controls (client/PageTour.tsx). */}
      {(() => {
        const id = route === "" || route === "tasks" ? "tasks" : route === "log" ? "journal" : route === "errorlog" ? "mistakes" : route === "coursework" ? "coursework" : route === "settings" ? "settings" : null;
        if (!id || isPhone) return null;
        return <PageTour key={id} id={id} steps={TOURS[id]} ready={!onboard} />;
      })()}

      {route === "full" ? (
        fullError ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }} role="alert">
            <p>{`Couldn't open everything: ${fullError}`}</p>
            <p style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button type="button" className="btn primary" onClick={() => setFullTry((n) => n + 1)}>{"Try again"}</button>
              <button type="button" className="btn ghost" onClick={() => navigate("tutor")}>{"Back to the tutor"}</button>
            </p>
          </div>
        ) : (
          <div style={{ padding: "48px 24px", textAlign: "center", maxWidth: 360, margin: "0 auto" }} role="status">
            <p className="muted" style={{ marginBottom: 12 }}>{"Opening everything…"}</p>
            <div className="otto-progress" role="progressbar" aria-label="Opening the whole app" aria-busy="true"><span /></div>
          </div>
        )
      ) : route === "settings" ? (
        <SettingsPage status={status} tasks={tasks} onSignOut={signOut} onChanged={loadStatus} onTasksChanged={setTasks} onStatusUpdate={loadStatus} onReplayOnboarding={replayOnboarding} />
      ) : route === "log" ? (
        <StudyLogPage lang={status?.language} tasks={tasks} status={status} phoneOnly={isPhone} />
      ) : route === "tutor" ? (
        <TutorSession userId={status?.user || null} onExit={() => navigate("tasks")} visionReady={!!status?.visionReady} />
      ) : route.startsWith("tutor/session/") ? (
        // split index [2]: routeOf strips the leading slash, so "tutor/session/<id>" is ["tutor","session","<id>"].
        // It used to read [3] — ALWAYS undefined — so every deep link/refresh/history anchor loaded as if no
        // session id had been passed and the full-page review (TutorSession, .../board|.../chat) never opened.
        <TutorSession userId={status?.user || null} onExit={() => navigate("tasks")} visionReady={!!status?.visionReady} sessionId={route.split("/")[2]} reviewView={route.split("/")[3]} />
      ) : route === "study" ? (
        <StandaloneStudyEntry tasks={tasks} setTasks={setTasks} status={status} notify={notify} navigate={navigate} />
      ) : route === "coursework" ? (
        <Coursework onTasksChanged={() => { void api.tasks().then(setTasks).catch(() => {}); }} />
      ) : route === "admin" && !!status?.isAdmin ? (
        <AdminPage />
      ) : route === "errorlog" ? (
        <MistakeLogPage lang={status?.language} />
      ) : route === "exercises" ? (
        <ExercisesPage />
      ) : !status.googleConnected && !status.pronoteConnected && !skippedConnect ? (
        <main className="list-wrap"><ConnectCard status={status} onSkip={() => {
          setSkippedConnect(true);
          try { localStorage.setItem("otto-skip-connect", "1"); } catch { /* best-effort */ }
        }} /></main>
      ) : (
        <main className="list-wrap" key="dash">
          <div className="dash-head">
            {/* The prototype's page title: "Your day, under control." — one calm sentence, no name,
                no greeting-by-clock. Under it ONE gray line joins the date to the "Three priorities…"
                reassurance with a middle dot ("Monday, 5 October · Three priorities. Everything else
                can wait.") instead of a separate uppercase date label above the title. */}
            {/* Warm, plain, human: a greeting by first name, then the date — no tagline, no progress widgets. */}
            <h1 className="list-head">{(status?.name || "").trim().split(/\s+/)[0] ? (`Hi ${(status?.name || "").trim().split(/\s+/)[0]}.`) : todayLong(status?.language)}</h1>
            {(status?.name || "").trim() ? <p className="page-sub mt-2">{todayLong(status?.language)}</p> : null}
            {/* One plain sentence instead of the old "3 active · 1 processing · 5 done" mono readout —
                that read like debug output, not like something written for a stressed 17-year-old. A second
                sentence names what's actually next (the hero task) rather than just a count, so the line
                reads as a real summary of where things stand, not just a tally. */}
            <p className="dash-line">
              {live.length === 0
                ? (doneToday > 0 ? T("dashboard.doneForToday") : T("dashboard.allCaughtUp"))
                : ((live.length > 3 ? T("dashboard.focusThree", { rest: live.length - 3 }) : T("dashboard.thingsLeft", { count: live.length, plural: live.length > 1 ? "s" : "" })) +
                   (doneToday > 0 ? T("dashboard.alreadyDone", { count: doneToday, plural: doneToday > 1 ? "s" : "" }) : "") + ".")}
              {/* One status signal at a time, in priority order — overdue outranks in-progress work,
                  which outranks a routine scan — instead of stacking every pill that happens to apply. */}
              {overdueCount > 0 ? (
                <span className="dash-late">
                  {`${overdueCount} milestone${overdueCount > 1 ? "s" : ""} overdue`}
                </span>
              ) : working > 0 ? (
                <span className="dash-working">{`Otto is working on ${working}`}</span>
              ) : scanning ? (
                <span className="scan-note"><span className="scan-dot" /> {"checking…"}</span>
              ) : null}
            </p>
          </div>
          {/* Onboarding's sidebar tour explains what the Tasks tab IS, but never what "Do now"/"This
              week"/"Later" actually mean or how a task lands in one — the one piece of real complexity
              on this page nothing else explains (the landing page's marketing copy covers this for
              prospects, but a logged-in student never sees that page again). Dismiss-once, not a
              permanent fixture — see PageInfoHint's own comment. */}
          <PageInfoHint pageKey="dashboard" text={"Sorted by real priority, not just deadline: \"Do now\" is urgent AND important, \"This week\" and \"Later\" are what can wait — urgency climbs on its own as a deadline nears."} />
          {status.paused && (
            <div className="intro paused-banner">
              <div className="intro-body">
                <div className="intro-title">{"Otto is paused"}</div>
                <p>{"Turn it back on in Settings whenever you're ready — nothing's been lost."}</p>
              </div>
              <button className="btn xs ghost" onClick={() => navigate("settings")}>{"Settings"}</button>
            </div>
          )}
          {/* Two-zone dashboard: Today (dash-today) is the main event — it comes FIRST on both mobile
              and desktop (via CSS `order`/`grid-row`, not DOM position, so the JSX below doesn't need to
              move), ahead of add-task and the rail widgets. On desktop (≥1024px) dash-grid places dash-rail
              beside dash-today+dash-more instead, sticky, so the workload/exam widgets stay ambient context. */}
          <div className="dash-grid">
            {/* Adding a task is an action, so it's off on a phone (read-only there — see
                PHONE_ALLOWED_ROUTES above). */}
            <div className="dash-addtask"><AddTask onAdded={setTasks} /></div>

            <div className="dash-today">
              {/* Until the first server response, an empty list means "still loading", not "all clear" —
                  show the skeleton instead of flashing the empty state. */}
              {live.length === 0 && (busy || !loaded) ? <TaskSkeleton /> : live.length === 0 ? (() => {
                const who = status.name || firstName(status.user);
                // Pronote is ONE way to feed Otto, not its premise. Name whichever source is actually
                // linked, and for a student who skipped connecting anything, say what to do instead of
                // claiming Otto is watching a school portal nobody ever connected (that copy read as a
                // bug — and "Check now" there did nothing but return a "nothing connected" skip).
                const watching = status.pronoteConnected
                  ? ("your Pronote")
                  : status.googleConnected
                    ? ("your inbox")
                    : null;
                // First run (nothing ever completed) reads differently from a genuinely cleared list.
                return handled === 0 ? (
                  connected ? (
                    <div className="empty-state">
                      <h3>{`I'm watching ${watching}${who ? `, ${who}` : ""}`}</h3>
                      <p>{"Homework and tests land here the second I spot them. Until then — this quiet is yours, not empty time."}</p>
                      <button className="btn primary" disabled={busy} onClick={() => void generate()}>{busy ? ("Looking…") : ("Look again")}</button>
                    </div>
                  ) : (
                    <div className="empty-state">
                      <h3>{`Nothing on your list${who ? `, ${who}` : ""} — suspicious`}</h3>
                      <p>{"Add what you've been putting off — you already know what it is. Or connect an app in Settings and I'll find the deadlines before you do."}</p>
                      <a className="btn ghost" href="/settings">{"Connect an app"}</a>
                    </div>
                  )
                ) : (
                  <div className="empty-state">
                    <h3>{`Clear${who ? `, ${who}` : ""}`}</h3>
                    <p>{connected
                      ? (`Nothing outstanding. I'm still watching ${watching} — so go get ahead on something that's actually hard.`)
                      : ("Nothing outstanding. Pick the hardest thing on your plate and get ahead of it — that's the whole game.")}</p>
                  </div>
                );
              })() : (
                <div className={`list-focus-wrap ${settled ? "settled" : ""}`}>
                  {/* All tasks shown as equal-sized cards, no spotlight */}
                  {focusToday.length > 0 && (
                    <div className="list">
                      {focusToday.map((t, i) => (
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
                          onEnterStudyMode={STUDY_MODE_ENABLED && !isPhone ? () => { setStudyModeTask(t); navigate(`study/${t.id}`); } : undefined}
                          readOnly={false}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

            <div className="dash-more">
              {live.length > 3 && (
                <div className={`list-focus-wrap ${settled ? "settled" : ""}`}>
                  <div className="focus-group">
                    {!showAllTasks ? (
                      <button className="btn xs ghost show-more-btn" onClick={() => setShowAllTasks(true)}>
                        {`${live.length - 3} more waiting`}
                      </button>
                    ) : (
                      <div className="later-groups">
                        {[
                          { key: "week", label: "This week", items: live.slice(3).filter((t) => t.quadrant === "do" || t.quadrant === "schedule") },
                          { key: "later", label: "Later", items: live.slice(3).filter((t) => t.quadrant !== "do" && t.quadrant !== "schedule") },
                        ].filter((g) => g.items.length).map((g) => (
                          <section key={g.key} className="later-group">
                            <h3 className="later-group-head">{g.label}</h3>
                            <div className="list compact">
                              {g.items.map((t, i) => (
                          <TaskCardRow
                                  key={t.id}
                                  task={t}
                                  index={3 + i}
                                  retrying={retryingIds.includes(t.id)}
                                  isNew={!seenTasks.has(t.id) && !isHandled(t.status) && !isInFlight(t.status)}
                                  onOpen={() => navigate(`task/${t.id}`)}
                                  onChange={setTasks}
                                  onTask={patchTask}
                                  onConfirmed={flagJustDone}
                                  onEnterStudyMode={STUDY_MODE_ENABLED && !isPhone ? () => { setStudyModeTask(t); navigate(`study/${t.id}`); } : undefined}
                                  readOnly={false}
                                />
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {completed.length > 0 && (
                <div className="completed-section">
                  <h3 className="completed-head">{"Completed"}</h3>
                  {/* Minimalist done-list: checked rows like a to-do app, not full cards. Click to expand details. */}
                  <div className="done-list">{(showCompleted ? completed : completed.slice(0, 8)).map((t) => (
                    // A real <button>: reopening a finished task was mouse-only, and this row is the ONLY
                    // way back into one.
                    <button type="button" key={t.id} className={`done-row ${t.id === justDoneId ? "just-done" : ""}`} onClick={() => navigate(`task/${t.id}`)} title={t.synthesis || t.why}>
                      <span className="done-check" aria-hidden="true">✓</span>
                      <span className="done-title">{t.title}</span>
                      <span className="done-when">{relTime(t.updatedAt || t.createdAt, (fr, enS) => enS)}</span>
                    </button>
                  ))}</div>
                  {completed.length > 8 && !showCompleted && (
                    <button className="btn xs ghost" onClick={() => setShowCompleted(true)}>{`Show all ${completed.length}`}</button>
                  )}
                </div>
              )}
            </div>
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
                {/* Phone: a task is READ-ONLY (see PHONE_ALLOWED_ROUTES above) — TaskReadOnly shows the
                    same task and the plan Otto wrote, with no chat and nothing to act on, instead of
                    TaskFocus's full working surface. */}
                {isPhone ? (
                  <TaskReadOnly task={openTask} onTask={patchTask} userId={status?.user || null} />
                ) : (
                  <TaskFocus
                    task={openTask}
                    retrying={retryingIds.includes(openTask.id)}
                    onChange={setTasks}
                    onTask={patchTask}
                    onConfirmed={flagJustDone}
                    onLeft={() => navigate("")}
                    onEnterStudyMode={STUDY_MODE_ENABLED ? () => { setStudyModeTask(openTask); navigate(`study/${openTask.id}`); } : undefined}
                    userId={status?.user || null}
                  />
                )}
              </TaskModal>
            );
          })()}
        </main>
      )}
      </div>
    </div>
    </TourProvider>
    </NotifyContext.Provider>
    </LangContext.Provider>
  );
}
const LEGAL_UPDATED = "July 30, 2026";

function LegalPage({ kind, lang }: { kind: "privacy" | "terms"; lang?: string }) {
  return (
    <LangContext.Provider value="en">
      <LegalPageBody kind={kind} />
    </LangContext.Provider>
  );
}
function LegalPageBody({ kind }: { kind: "privacy" | "terms" }) {
  const L = useLang();
  return (
    <div className="landing legal-page">
      <header className="landing-nav glass-nav">
        <a className="brand" href="/"><Logo size={22} /> Otto</a>
        <nav className="landing-navlinks">
          <a className="btn ghost" href="/privacy">{"Privacy"}</a>
          <a className="btn ghost" href="/terms">{"Terms"}</a>
        </nav>
      </header>
      <main className="legal">
        {kind === "privacy" ? <PrivacyBody /> : <TermsBody />}
        <p className="legal-meta">{`Last updated: ${LEGAL_UPDATED} · Operated by ${LEGAL_ENTITY} · Contact: ${LEGAL_EMAIL}`}</p>
        <a className="legal-back" href="/">{"← Back to Otto"}</a>
      </main>
      <footer className="legal-foot">
        <span className="foot-mit">© 2026 Otto</span>
      </footer>
    </div>
  );
}

/** /research — the philosophy page, linked from the landing nav's "Our approach". The landing's compact
 *  "Research" list stays a 4-line citation on purpose; this page is the mission statement plus the four
 *  methods, one short user-facing paragraph each — deliberately NO file/function names here (reported:
 *  naming internals reads like the page is talking to a computer, not to a student). Same wrapper pattern
 *  as the legal pages (own LangContext, reachable logged-out) since it's public. */
function ResearchPage({ lang }: { lang?: string }) {
  return (
    <LangContext.Provider value="en">
      <ResearchPageBody />
    </LangContext.Provider>
  );
}
