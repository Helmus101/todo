
import { clearLocalDecks } from "./localDecks.ts";
import { clearStudyDB } from "./study/StudyDB.ts";
import { clearLocalQuizzes } from "./localQuizzes.ts";
import { clearLocalChatBoard } from "./localChatBoard.ts";


/** Union two copies of a task's chat thread by (role, at, text) — the client-side twin of server/tasks.ts's
 *  own unionChat, used everywhere a background sync's copy of a task needs merging against the locally-held
 *  Study Mode thread. Deliberately KEY-based, not a positional "incoming[i] must equal local[i]" prefix
 *  check (an earlier version of this used that and was fragile: the moment any single message's shape
 *  differed cosmetically between the optimistic local echo and a round-tripped server copy — an artifacts
 *  chip attached after the round trip, whitespace normalized server-side — the ENTIRE incoming thread was
 *  discarded, which is what "chat sometimes auto-deletes stuff" actually was: a background sync's fresher
 *  copy with a genuinely NEW message from another tab/device losing outright to a local copy that only
 *  LOOKED different by one cosmetic field on one older message). Exported for the same testability reason as
 *  shouldKeepLocal above. */
export function unionChatEntries<T extends { role: string; text: string; at: string }>(local: T[], incoming: T[]): T[] {
  if (!local.length) return incoming;
  const key = (c: T) => `${c.role}|${c.at}|${c.text}`;
  const seen = new Set(incoming.map(key));
  return [...incoming, ...local.filter((c) => !seen.has(key(c)))]
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

/** The Otto mark: a plain ink ring. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="14" stroke="currentColor" strokeWidth="6" fill="none" />
    </svg>
  );
}

/** Shared by sign-out AND account deletion — both end an identity on this browser and must leave NO trace
 *  of it behind for whoever's on this account next (another account signing up/in on the same device, or
 *  this same browser after a delete). Account deletion used to skip this entirely: it only called the
 *  server-side erasure and navigated to "/", leaving every one of these caches sitting in localStorage
 *  completely untouched — a fresh signup right after, on the same browser, would start by briefly showing
 *  the JUST-DELETED account's cached tasks/status (CACHED_TASKS/CACHED_STATUS above read these exact keys
 *  at module-load time) until the real fetch overwrote them. The per-account stores (decks/quizzes/chat-
 *  board) are already namespaced by userId and so can't leak into a DIFFERENT account's reads even when
 *  left behind, but clearing them too is the honest behavior for "delete my account" — local traces should
 *  go, not just the server row. Module-level (not inside App()) so SettingsPage's own delete-account
 *  handler can call it too, without threading it through as a prop. */
const OWNER_KEY = "otto-owner";
/** Which account the data in this browser belongs to. If a DIFFERENT account signs in (the last one never signed out
 *  cleanly: an expired session, a cleared cookie, another tab), the previous owner's local data is wiped first, so
 *  nothing one account stored here can show up under another. Same account: nothing happens. */
export function enforceAccountOwner(user: string): void {
  try {
    const prev = localStorage.getItem(OWNER_KEY);
    if (prev && prev !== user) clearAllLocalAccountData(prev);
    localStorage.setItem(OWNER_KEY, user);
  } catch { /* storage unavailable: nothing to protect */ }
}

export function clearAllLocalAccountData(userId: string | null): void {
  // Keys that are NOT namespaced by account. Every one is removed whenever an account ends on this browser (a leftover
  // "skip connect" or last subject from account A would otherwise apply to account B).
  try { ["otto-tasks", "weave-status", "otto-seen-tasks", "otto-lastgen", "otto-onboard", "otto-onboard-step", "otto-onboard-track", "otto-tours-seen",
    "otto-skip-connect", "otto-last-subject", "otto-density-arm", "otto-autoopen-docs", "otto-error-log", "otto-local-practice", "otto.tutor.endedSessions", "otto-opened-docs", OWNER_KEY].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  void clearStudyDB(); // Study Mode's IndexedDB is not per-account either
  clearLocalDecks(userId);
  clearLocalQuizzes(userId);
  clearLocalChatBoard(userId);
  // Journal week/month caches and per-deck review progress are keyed `<prefix><userId>:<date-or-id>` (see
  // their definitions below) — date/deck-id isn't known here, so sweep every localStorage key for this
  // user's namespace rather than needing a list of dates/deck ids.
  try {
    const ns = [`${STUDYLOG_CACHE_PREFIX}${userId || "anon"}:`, `${STUDYLOG_MONTH_CACHE_PREFIX}${userId || "anon"}:`, `otto-deck:${userId || "anon"}:`, `otto-quiz:${userId || "anon"}:`, `otto-tutor-ink:${userId || "anon"}:`];
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && ns.some((p) => k.startsWith(p))) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/** A friendly first name from the account email's local part ("tjong.willem@…" → "Tjong"). Personalizes the UI. */
export const firstName = (user?: string) => {
  const local = (user || "").split("@")[0].split(/[._+-]+/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
};

/** Navigate the path router. "" → "/" (dashboard); otherwise "/<route>" (e.g. "task/<id>", "settings").
 *  pushState doesn't fire popstate, so we dispatch one to notify the router hook.
 *
 *  Every route swap (Tasks ↔ Journal ↔ Study ↔ Settings) is a hard ternary re-render in App() — the DOM for
 *  the old section unmounts and the new one mounts in the same tick, with no transition of any kind. That's
 *  the "ui isn't really smooth" complaint: the content area visibly snaps/flashes on every sidebar click,
 *  unlike the spring-driven overlays (TaskModal, Study Mode drawers) already using `motion`. Restructuring
 *  every branch of that ternary into an AnimatePresence-friendly shape is a much bigger, riskier change for
 *  what's a purely cosmetic cross-fade — the native View Transitions API gets the same "old fades out, new
 *  fades in" result with zero JSX changes, by snapshotting the DOM immediately before/after the mutation
 *  React already performs. `prefers-reduced-motion` is respected by simply not opting in below (falling back
 *  to the instant swap) rather than fighting the API's own reduced-motion handling. */
export const navigate = (r: string) => {
  const go = () => {
    window.history.pushState({}, "", r ? `/${r}` : "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const vtDocument = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void>; updateCallbackDone: Promise<void> } };
  if (reduceMotion || typeof vtDocument.startViewTransition !== "function") { go(); return; }
  // Both of a transition's settlement promises can reject benignly when a newer transition starts first
  // (expected on fast double-clicks / rapid sidebar navigation — the transition still runs/cross-fades
  // correctly; only the promise is rejected): `finished` on some skip paths, and `ready` with the exact
  // "Transition was skipped. New ViewTransition started" AbortError reported live from production. With
  // no handler attached either surfaces as an "Unhandled promise rejection" in the console/Sentry.
  // updateCallbackDone is deliberately NOT silenced — go() has no async work, so a rejection there would
  // be a real bug worth surfacing.
  const vt = vtDocument.startViewTransition(go);
  vt.finished.catch(() => {});
  vt.ready.catch(() => {});
};

/** The Journal tab (route /log): Monday-Friday, a free-text "what did I learn today" box per day, auto-
 *  generating flashcards on save (server/index.ts's /api/studylog/day → generateDailyStudyCards). End of
 *  week, an on-demand summary deck weighted toward whatever got marked wrong that week (generateWeeklyStudyDeck).
 *  Both decks reuse the exact same FlashcardDeck review UI + Leitner spaced-repetition schedule as any other
 *  task's deck — reviewing a card here shows up in the normal cross-task "due for review" view for free. */
// Local cache for a week's studylog data (days + week summary), keyed by that week's Monday — this is
// what makes a day's flashcards/quiz "always accessible": the page paints from whatever's in
// localStorage INSTANTLY on mount/week-change (no loading flash, works even the moment before the network
// request resolves), then a background fetch reconciles with the server as the source of truth. Not a
// replacement for server persistence (Leitner review state still lives server-side) — purely a fast local
// mirror of what was last seen, same spirit as FlashcardDeck/QuizPlayer's own localStorage progress saves.
// Keyed by userId + calendar date — NOT just the date. A date-only key is GLOBAL/shared across every
// account that's ever signed into this browser during the same ISO week, so a different account signing
// in right after would see account A's cached journal flashcards/quiz on mount (useState's initializer
// reads this synchronously, before any network fetch resolves) — reported live as "flashcards saved in a
// different account even though it was never associated with that account." Same scoping pattern as
// localDecks.ts/localChatBoard.ts, which already fixed this exact bug class for their own caches.
export const STUDYLOG_CACHE_PREFIX = "otto-studylog-week:";

// Same local-mirror pattern as the week cache, for the month summary (deck + companion quiz) — this was
// the one piece of the Journal that DIDN'T get a local copy, so its flashcards/quiz only ever showed up
// after a fresh network round-trip instead of being "always accessible" like the daily/weekly ones.
export const STUDYLOG_MONTH_CACHE_PREFIX = "otto-studylog-month:";

// ── Legal pages (public) ──────────────────────────────────────────────────────
// An accurate privacy policy is required for Google's OAuth verification (Gmail/Calendar/Drive are
// sensitive/restricted scopes) and is basic legal table-stakes for publishing.
export const LEGAL_ENTITY = "Willem Tjong";

export const LEGAL_EMAIL = "tjong.willem@gmail.com";
