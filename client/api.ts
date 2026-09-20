import type { WebTask, ConnectionStatus, Profile, StudySession, StudyProfile } from "../shared/types.ts";
import { normalizeProfile } from "../shared/types.ts";

export interface IntegrationItem { key: string; name: string; blurb: string; category: string; logo: string; connected: boolean; accounts?: ConnectedAccount[]; }
export interface ConnectedAccount { id: string; email?: string; toolkit: string; status: string; }
export interface IntegrationsResp { ready: boolean; items: IntegrationItem[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// CSRF synchronizer token (see server/index.ts's requireAuth for the full defense-in-depth reasoning) —
// handed to us once via /api/status's own JSON body (a cross-origin attacker page can't read that response,
// no permissive CORS is set anywhere on this API), cached here, and attached to every mutating request
// below. `api.status()` is the one place that ever sets this.
let csrfToken: string | null = null;
// In-flight/completed priming fetch, shared across every caller that needs a token before csrfToken is set.
// Exists because App.tsx's `status` STATE is restored synchronously from localStorage on mount (see its own
// CACHED_STATUS) — so `status?.loggedIn`/`connected` can read true, and effects gated on them can fire a
// mutating call, on the VERY FIRST RENDER, well before the real network /api/status round-trip (the only
// thing that ever actually sets `csrfToken`, which is in-memory only and never itself persisted) resolves.
// That mutating request used to just go out with no header at all — `requireAuth` server-side then sees a
// session that already HAS a token (persisted, unlike this module-level variable) but a request with NONE,
// a mismatch no retry can fix (the retry-once logic below only helps when the SERVER's echoed token differs
// from what was ALREADY sent — there's nothing to compare against here). Reported live as a persistent 403
// on early calls (recordMetric, generate) that fire from a mount-time effect. Fixed by making every mutating
// request WAIT for a real token first if it doesn't have one yet, priming from the shared in-flight fetch
// instead of either duplicating it per-caller or racing it.
let primingFetch: Promise<void> | null = null;
async function primeCsrfToken(): Promise<void> {
  if (csrfToken) return;
  if (!primingFetch) {
    primingFetch = fetch("/api/status")
      .then((r) => r.json())
      .then((s: any) => { if (s?.csrfToken) csrfToken = s.csrfToken; })
      .catch(() => { /* best-effort — the caller proceeds with whatever it has, same as before this fix */ })
      .finally(() => { primingFetch = null; }); // let a LATER genuine miss (e.g. after logout/login) re-prime
  }
  await primingFetch;
}

// Best-effort read of the account's chosen language, straight from what App.tsx already persists on every
// status load — this module has no React context to read LangContext from. Several server error strings
// (paused/budget gates — server/index.ts) are hardcoded English regardless of the account's language, so
// without this a French-language session could hit a "Lancer" click and see a raw English toast, jarring
// and easy to misread as "the button didn't do anything" rather than an explained, actionable state.
function currentLang(): "fr" | "en" {
  try {
    const raw = localStorage.getItem("weave-status");
    if (raw && JSON.parse(raw)?.language === "en") return "en";
  } catch { /* ignore */ }
  return "fr";
}
function translateServerError(msg: string): string {
  const en = currentLang() === "en";
  if (/AI is paused|otto is paused/i.test(msg)) return en
    ? "Otto is paused — resume it in Settings to continue."
    : "Otto est en pause — réactive-le dans les Réglages pour continuer.";
  if (/monthly AI budget/i.test(msg)) return en
    ? "Otto's reached its monthly AI budget — it resets on the 1st."
    : "Otto a atteint son plafond mensuel d'IA — ça se renouvelle le 1er.";
  return msg;
}

/**
 * fetch() that survives a brief backend outage — e.g. the `tsx watch` dev server restarting on a file
 * change drops port 8788 for ~2s, during which the Vite proxy answers with ECONNREFUSED. We retry through
 * that window so the user never sees a "proxy error" / failed request; the call just lands once the server
 * is back. Two transient cases are retried:
 *   1. fetch REJECTS (connection refused → no response reached us). The request never hit the server, so
 *      retrying is safe even for mutations (run/generate/send) — nothing executed.
 *   2. fetch RESOLVES with a 5xx whose body is NOT JSON — that's the proxy's own error page, not a real
 *      server response. A genuine server error returns JSON {error} (content-type json) and is NOT retried.
 */
async function req(url: string, init?: RequestInit, retries = 6, isCsrfRetry = false): Promise<Response> {
  // Attach the CSRF token to every mutating request — GET/HEAD are read-only and exempt server-side too
  // (see requireAuth), so no point adding the header there. `csrfToken` is null before the first successful
  // /api/status call resolves — WAIT for that (via primeCsrfToken, see its own comment) rather than firing a
  // mutating request with no header at all: a mount-time effect gated on locally-cached (not yet server-
  // confirmed) "logged in" state can otherwise fire before that first status round-trip ever completes.
  const method = (init?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !csrfToken && !isCsrfRetry) await primeCsrfToken();
  if (method !== "GET" && method !== "HEAD" && csrfToken) {
    init = { ...init, headers: { ...(init?.headers || {}), "x-csrf-token": csrfToken } };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, init);
      // requireAuth (server/index.ts) echoes the session's CURRENT csrf token on every authenticated
      // response, success or not — pick it up opportunistically so this tab self-heals if the session
      // store ever holds a different token than what we last saw (see that middleware's own comment for
      // the exact race: two near-simultaneous requests right after login can each mint a token before the
      // other's write lands). Keeps this tab in sync without waiting for the NEXT /api/status poll.
      const freshToken = r.headers.get("x-csrf-token");
      if (freshToken) csrfToken = freshToken;
      // A CSRF mismatch can still arrive without a usable replacement header when the request lands on a
      // freshly-created serverless instance. Re-read /api/status once to obtain the session's authoritative
      // token, then replay only the original request. This is deliberately limited to the server's CSRF error
      // (not AI-paused/budget 403s), so real product gates are never hidden or retried indefinitely.
      if (r.status === 403 && !isCsrfRetry) {
        const errorText = String((await r.clone().json().catch(() => ({})))?.error || "");
        if (/session expired or invalid/i.test(errorText)) {
          try {
            const statusResponse = await fetch("/api/status");
            const status = await statusResponse.json().catch(() => ({}));
            if (status?.csrfToken && status.csrfToken !== (init?.headers as any)?.["x-csrf-token"]) {
              const recoveredToken = String(status.csrfToken);
              csrfToken = recoveredToken;
              return req(url, { ...init, headers: { ...(init?.headers || {}), "x-csrf-token": recoveredToken } }, retries, true);
            }
          } catch { /* preserve the original 403 for the caller */ }
        }
      }
      // The normal path remains a one-shot retry when the server can echo the current token directly.
      if (r.status === 403 && !isCsrfRetry && freshToken && freshToken !== (init?.headers as any)?.["x-csrf-token"]) {
        return req(url, { ...init, headers: { ...(init?.headers || {}), "x-csrf-token": freshToken } }, retries, true);
      }
      if (r.status >= 500 && attempt < retries) {
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("application/json")) { await sleep(500 + attempt * 250); continue; } // proxy error page → retry
      }
      return r;
    } catch (e: any) {
      // A caller-supplied AbortSignal timing out (see `timeoutMs` below) is a deliberate "stop waiting,"
      // not a dropped connection — retrying it would just silently re-run the same wait 6 more times,
      // turning one timeout into six and making a hung click look hung for even longer.
      if (e?.name === "AbortError") throw e;
      if (attempt < retries) { await sleep(500 + attempt * 250); continue; } // connection refused → server restarting
      throw e;
    }
  }
}

/** post() with a hard client-side timeout — for interactive actions (answering a step, running one step)
 *  where the button click needs to resolve into SOMETHING within a bounded time, success or a clear error,
 *  rather than waiting indefinitely on a slow AI/tool call and reading as "the click didn't do anything." */
const postTimed = (url: string, timeoutMs: number, body?: unknown) =>
  req(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).then(j).catch((e: any) => {
    if (e?.name === "AbortError") throw new Error("Otto met du temps à répondre — réessaie dans un instant.");
    throw e;
  });

const j = async (r: Response) => {
  if (!r.ok && r.status !== 401) {
    const raw = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
    const err: any = new Error(translateServerError(raw));
    err.status = r.status; // callers need this to tell "already running elsewhere" (409) from a real failure
    throw err;
  }
  return r.json();
};
const post = (url: string, body?: unknown) =>
  req(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).then(j);
// Auth posts surface the server's error message instead of throwing, so the form can show it. Login/signup
// hand back a fresh CSRF token directly in this response (rather than only via the next /api/status poll)
// so the very first authenticated mutating call right after signup (e.g. onboarding's language-preference
// save) already has a valid token — capture it here, the one place both routes' responses are read.
const authPost = (url: string, body: unknown): Promise<{ ok: boolean; error?: string; csrfToken?: string }> =>
  req(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }))
    .then((res) => { if (res.csrfToken) csrfToken = res.csrfToken; return res; });

export const api = {
  status: (): Promise<ConnectionStatus> => req("/api/status").then(j).then((s: ConnectionStatus) => { if (s.csrfToken) csrfToken = s.csrfToken; return s; }),
  signup: (email: string, password: string, consent: boolean) => authPost("/api/auth/signup", { email, password, consent }),
  login: (email: string, password: string) => authPost("/api/auth/login", { email, password }),
  // Always resolves {ok:true} on a validly-formatted email — the server never reveals whether an account
  // actually exists (see server/index.ts's own comment on why), so the client can't and shouldn't try to
  // distinguish "sent" from "no such account" either.
  forgotPassword: (email: string, lang: "fr" | "en"): Promise<{ ok: boolean; error?: string }> =>
    post("/api/auth/forgot-password", { email, lang }),
  resetPassword: (token: string, password: string) => authPost("/api/auth/reset-password", { token, password }),
  integrations: (): Promise<IntegrationsResp> => req("/api/integrations").then(j),
  integrationAccounts: (app: string): Promise<{ accounts: ConnectedAccount[] }> => req(`/api/integrations/${app}/accounts`).then(j),
  disconnectIntegration: (app: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect`),
  disconnectAccount: (app: string, accountId: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect/${accountId}`),
  // Pronote — no OAuth, so this is a credential form rather than a redirect (see server/pronote.ts).
  pronoteStatus: (): Promise<{ connected: boolean; username?: string }> => req("/api/integrations/pronote/status").then(j),
  connectPronote: (url: string, username: string, password: string, kind?: number): Promise<{ ok: boolean; error?: string }> =>
    post("/api/integrations/pronote/connect", { url, username, password, kind }).catch((e) => ({ ok: false, error: e?.message || "Couldn't connect." })),
  disconnectPronote: (): Promise<{ ok: boolean }> => post("/api/integrations/pronote/disconnect"),
  // Opportunistic keepalive — called on the app's normal heartbeat when Pronote is connected (see
  // server/pronote.ts's touchPronoteSession for why: the daily cron alone leaves the token idle too long).
  // Fire-and-forget from every caller's point of view; the server itself is what rate-gates the real work.
  pronoteTouch: (): Promise<{ ok: boolean }> => req("/api/pronote/touch").then(j).catch(() => ({ ok: false })),
  // /finance (Plaid) — sandbox-only for now, see server/plaid.ts's own comment.
  plaidStatus: (): Promise<{ connected: boolean; institutionName?: string; configured: boolean }> => req("/api/integrations/plaid/status").then(j),
  plaidLinkToken: (): Promise<{ linkToken: string }> => post("/api/integrations/plaid/link-token"),
  plaidExchange: (publicToken: string): Promise<{ ok: boolean }> => post("/api/integrations/plaid/exchange", { publicToken }),
  plaidConnectMock: (): Promise<{ ok: boolean }> => post("/api/integrations/plaid/connect-mock"),
  plaidDisconnect: (): Promise<{ ok: boolean }> => post("/api/integrations/plaid/disconnect"),
  financeSnapshot: (): Promise<{ accounts: { id: string; name: string; type: string; balance: number | null }[]; transactions: { id: string; name: string; amount: number; date: string; pending: boolean }[] }> =>
    req("/api/finance/snapshot").then(j),
  pronoteTests: (): Promise<{ tests: { subject: string; deadline: string }[] }> => req("/api/pronote/tests").then(j),
  workload: (): Promise<{ days: { date: string; items: { kind: "homework" | "test" | "task"; subject?: string; title: string; effort: number; taskId?: string; movable?: boolean }[]; totalEffort: number }[] }> =>
    req("/api/workload").then(j),
  rescheduleTask: (id: string, when: string): Promise<WebTask[]> => post(`/api/tasks/${id}/reschedule`, { when }),
  setGrade: (subject: string, grade: number, scale?: number): Promise<Profile> => post("/api/profile/grade", { subject, grade, scale }).then(normalizeProfile),
  deleteGrade: (subject: string): Promise<Profile> => req(`/api/profile/grade/${encodeURIComponent(subject)}`, { method: "DELETE" }).then(j).then(normalizeProfile),
  reviewFlashcard: (taskId: string, deckId: string, cardIndex: number, correct: boolean): Promise<WebTask[]> => post(`/api/tasks/${taskId}/flashcard/${deckId}/${cardIndex}/review`, { correct }),
  // One call per completed quiz pass (not per question) — persists the score so it survives closing the
  // popup and so the tutor chat can reference it later (see chatAboutTask's artifactsBlock).
  recordQuizAttempt: (taskId: string, quizId: string, score: number, total: number, wrong?: number[]): Promise<WebTask[]> =>
    post(`/api/tasks/${taskId}/quiz/${quizId}/attempt`, { score, total, wrong }),
  submitPracticeAnswer: (taskId: string, answer: string): Promise<WebTask[]> => post(`/api/tasks/${taskId}/practice-problem/attempt`, { answer }),
  // A student's own hand-written note — "what I got wrong, what to remember" — no AI call, lands in the
  // same task.notes the AI's own fiches use so it shows up as a normal chip in "What Otto prepared".
  addNote: (taskId: string, title: string, body: string): Promise<WebTask[]> => post(`/api/tasks/${taskId}/notes`, { title, body }),
  reviewsDue: (): Promise<{ due: { taskId: string; taskTitle: string; deckId: string; deckTitle: string; cardIndex: number; front: string }[] }> => req("/api/reviews/due").then(j),
  // Study log: daily "what I learned today" → auto flashcards (see server/index.ts's /api/studylog/*).
  // Saving empty text clears that day's entry+deck; non-empty text (re)generates the deck server-side.
  studyLogDay: (date: string, text: string): Promise<WebTask[]> => post("/api/studylog/day", { date, text }),
  studyLogWeek: (start: string): Promise<{ monday: string; days: (WebTask | null)[]; summary: WebTask | null }> =>
    req(`/api/studylog/week?start=${encodeURIComponent(start)}`).then(j),
  studyLogWeekSummary: (weekStart: string): Promise<WebTask[]> => post("/api/studylog/week-summary", { weekStart }),
  studyLogMonth: (start: string): Promise<{ month: string; weeks: WebTask[]; summary: WebTask | null }> =>
    req(`/api/studylog/month?start=${encodeURIComponent(start)}`).then(j),
  studyLogMonthSummary: (monthStart: string): Promise<WebTask[]> => post("/api/studylog/month-summary", { monthStart }),
  studyFreeSession: (): Promise<WebTask[]> => post("/api/study/free", {}),
  // Server-side text extraction for a document material's URL (a Google Doc, a Padlet board, a generic
  // webpage) — so Ask Otto can reference what's actually IN it, same as it already can for uploaded PDFs
  // (client-side, pdfText.ts). Best-effort: "" is a normal, valid result (a login-walled page, a non-text
  // response), never surfaced as an error to the student — the material is already usable without this,
  // it's a pure enhancement.
  studyExtractText: (url: string): Promise<{ text: string }> => post("/api/study/extract-text", { url }).catch(() => ({ text: "" })),
  // Personalization bandit (see server/bandit.ts) — v1 target: Pomodoro length. Both best-effort from the
  // caller's side too: a failure here should never block starting or ending a study session.
  pomodoroSuggestion: (): Promise<{ enabled: boolean; workMinutes: number; breakMinutes: number; coldStart: boolean }> =>
    req("/api/study/pomodoro-suggestion").then(j),
  // Fourth bandit target: desk ambience — see AUDIO_ARMS in server/bandit.ts.
  audioSuggestion: (): Promise<{ audioType: "silence" | "brown" | "pink" | "white"; coldStart: boolean }> =>
    req("/api/study/audio-suggestion").then(j),
  // Fifth bandit target: overall UI density — see DENSITY_ARMS in server/bandit.ts. `manual` is true once
  // the student has picked one explicitly in Settings (profile.uiDensity) — this then just confirms that
  // choice rather than suggesting anything.
  densitySuggestion: (): Promise<{ density: "cozy" | "compact" | "spacious"; manual: boolean; coldStart?: boolean }> =>
    req("/api/ui/density-suggestion").then(j),
  // AI-personalized theme (server/claude.ts's generateThemeTokens) — explicitly opt-in, a Settings button
  // click, never automatic. See that function's own doc comment for the validation/safety story.
  personalizeTheme: (): Promise<{ customTheme: Record<string, string> }> => post("/api/ui/theme-personalize", {}),
  resetTheme: (): Promise<{ ok: boolean }> => post("/api/ui/theme-reset", {}),
  // Pattern recognition (server/patterns.ts) — read-only prediction from the student's own activity/study
  // data, never a new decision surface of its own; see Settings' quiet "Otto has noticed" line.
  patternsSummary: (): Promise<{
    predictedEngagement: { weekday: number; hour: number; confidence: number } | null;
    weakSubjects: string[];
    subjectMastery: { subject: string; correctRate: number; attempts: number; trend?: "up" | "down" | "flat" }[];
    subjectFocus: { subject: string; peak: { hour: number; confidence: number } }[];
    bandits: Record<string, { armId: string; confidence: number } | null>;
    studyMetrics: { totalSessions: number; totalStudySeconds: number; totalBreakSeconds: number; avgIdleRatio: number | null; earlyExitRate: number | null; pomodoroCyclesCompleted: number; windowDays: number; avgFocusScore: number | null; avgGazeOnScreenPct: number | null; focusSessionCount: number } | null;
  }> =>
    req("/api/patterns/summary").then(j),
  // Focus tracking API methods
  saveFocusSession: (session: any): Promise<{ success: boolean; stats: any }> => post("/api/focus/session", session),
  getFocusStats: (): Promise<{ stats: any }> => req("/api/focus/stats").then(j),
  getFocusSessions: (limit?: number): Promise<{ sessions: any[] }> => req(`/api/focus/sessions${limit ? `?limit=${limit}` : ""}`).then(j),
  getScheduleSuggestion: (subject?: string, difficulty?: string): Promise<{ suggestion: string | null }> => 
    req(`/api/focus/schedule-suggestion${subject ? `?subject=${encodeURIComponent(subject)}` : ""}${difficulty ? `&difficulty=${encodeURIComponent(difficulty)}` : ""}`).then(j),
  getArtifactRecommendation: (subject: string): Promise<{ recommendation: "flashcards" | "quiz" | "note" | "mixed" | null }> => 
    req(`/api/focus/artifact-recommendation?subject=${encodeURIComponent(subject)}`).then(j),
  submitSessionOutcome: (armId: string, completedPlanned: boolean, idleRatio: number, netBoxDelta: number | undefined, audioArmId: string | undefined, densityArmId: string | undefined, focusMetrics?: {
    avgConcentration?: number; gazeOnScreenPct?: number; avgBlinkRate?: number; restlessPct?: number; headPoseStability?: number;
  }): Promise<{ ok: boolean }> =>
    post("/api/study/session-outcome", { armId, completedPlanned, idleRatio, netBoxDelta, audioArmId, densityArmId, ...focusMetrics }),
  // Flexible, open-ended metric logging (server/store.ts's recordMetric) — `name` is any short label the
  // caller invents; nothing here needs a new endpoint or schema change to add a new signal later.
  recordMetric: (name: string, value: number, bucket?: string, context?: string): Promise<{ ok: boolean }> =>
    post("/api/metrics", { name, value, bucket, context }).catch(() => ({ ok: false })),
  addExam: (subject: string, deadline: string): Promise<Profile> => post("/api/profile/exam", { subject, deadline }).then(normalizeProfile),
  deleteExam: (id: string): Promise<Profile> => req(`/api/profile/exam/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j).then(normalizeProfile),
  addErrorLogEntry: (subject: string, question: string, mistake: string, fix: string): Promise<Profile> =>
    post("/api/profile/errorlog", { subject, question, mistake, fix }).then(normalizeProfile),
  deleteErrorLogEntry: (id: string): Promise<Profile> => req(`/api/profile/errorlog/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j).then(normalizeProfile),
  resetStudentModel: (): Promise<Profile> => req("/api/profile/student-model", { method: "DELETE" }).then(j).then(normalizeProfile),
  tasks: (): Promise<WebTask[]> => req("/api/tasks").then(j),
  // Returns the fresh list + the sweep's own result line ("swept: 3 new tasks…" / "skipped: nothing
  // connected") so the UI reports what actually happened rather than inferring it.
  generate: async (force = false): Promise<{ tasks: WebTask[]; note: string }> => {
    const out: any = await post("/api/tasks/generate", force ? { force: true } : undefined);
    return Array.isArray(out) ? { tasks: out, note: "" } : { tasks: out?.tasks || [], note: String(out?.note || "") };
  },
  // `clientId` — an idempotency key (see server/index.ts): pass the caller's own local stub id so a
  // retried/double-fired request is recognized as a replay instead of creating a second task.
  add: (title: string, when?: string, clientId?: string): Promise<WebTask[]> => post("/api/tasks", { title, ...(when ? { when } : {}), ...(clientId ? { clientId } : {}) }),
  refine: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/refine`),
  run: (id: string, reset?: boolean): Promise<WebTask> => post(`/api/tasks/${id}/run`, reset ? { reset: true } : undefined),
  revise: (id: string, note: string): Promise<WebTask> => post(`/api/tasks/${id}/revise`, { note }),
  confirm: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/confirm`),
  reject: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/reject`),
  dismiss: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/dismiss`),
  // 100s: an execute_step run now drains INLINE through runViaJob (server/index.ts) — a deliberate click
  // actually does the work and waits for the real result, rather than just enqueueing and hoping the
  // background kick loop picks it up. runTask itself is bounded to ~90s by its own time-budget circuit
  // breaker (see claude.ts's checkTimeBudget); this must stay safely ABOVE that so a legitimately-slower-
  // but-still-bounded run doesn't get aborted client-side right as the server is about to finish it (the
  // old 25s value predates that circuit breaker and would now abort even a normal, in-budget run).
  runStep: (id: string, index: number, answer?: string): Promise<WebTask> => postTimed(`/api/tasks/${id}/step/${index}/run`, 100_000, answer ? { answer } : undefined),
  stepDone: (id: string, index: number, done = true, result?: string): Promise<WebTask[]> => post(`/api/tasks/${id}/step/${index}/done`, { done, result }),
  expandStep: (id: string, index: number): Promise<WebTask[]> => post(`/api/tasks/${id}/step/${index}/expand`),
  substepDone: (id: string, index: number, subIndex: number, done = true): Promise<WebTask[]> => post(`/api/tasks/${id}/step/${index}/substep/${subIndex}/done`, { done }),
  // 25s, same reasoning as runStep: a real web search + synthesis, bounded so a stuck click surfaces an
  // error instead of sitting there looking broken.
  runSubstep: (id: string, index: number, subIndex: number): Promise<WebTask[]> => postTimed(`/api/tasks/${id}/step/${index}/substep/${subIndex}/run`, 25000),
  sendDraft: (id: string, index: number): Promise<WebTask> => post(`/api/tasks/${id}/send/${index}`),
  editDraft: (id: string, index: number, patch: { subject?: string; body?: string; text?: string }): Promise<WebTask> => post(`/api/tasks/${id}/sendable/${index}/edit`, patch),
  // Profile responses are normalized to a valid shape. Used to swallow EVERY failure (network drop, a real
  // 500, a malformed body) into a silent `emptyProfile()` — so a genuine load failure looked identical to
  // "you just have no profile facts yet," and a caller like ProfileEditor's "Chargement…" state could sit
  // there resolved-but-empty forever with no way to tell the user anything went wrong. Now it only rethrows;
  // callers show a real "couldn't load" state and offer retry (see ProfileEditor/SettingsPage in App.tsx).
  profile: (): Promise<Profile> => req("/api/profile").then(j).then(normalizeProfile),
  setProfile: (category: string, value: string): Promise<Profile> => post("/api/profile", { category, value }).then(normalizeProfile),
  setProfilePreference: (key: string, value: any): Promise<Profile> => post("/api/profile/preference", { key, value }).then(normalizeProfile),
  delProfile: (category: string, index: number): Promise<Profile> => req(`/api/profile/${category}/${index}`, { method: "DELETE" }).then(j).then(normalizeProfile),
  clearProfile: (): Promise<Profile> => req("/api/profile", { method: "DELETE" }).then(j).then(normalizeProfile),
  logout: (): Promise<{ ok: boolean }> => post("/api/auth/logout"),
  // GDPR self-serve: erasure (Art. 17) and portability (Art. 20) — no "email us and wait" step needed.
  deleteAccount: (): Promise<{ ok: boolean; errors: string[] }> => post("/api/account/delete"),
  exportDataUrl: (): string => "/api/account/export",
  // Other half of portability: takes the parsed JSON from a file produced by exportDataUrl() (any account,
  // typically a different one) and merges it into the currently signed-in account.
  importData: (data: unknown): Promise<{ ok: boolean; tasksAfter: number; errorLogAfter: number }> => post("/api/account/import", data),
  setPaused: (paused: boolean): Promise<Profile> => post("/api/settings/pause", { paused }).then(normalizeProfile),
  goUnlimited: (): Promise<Profile> => post("/api/settings/unlimited").then(normalizeProfile),
  smokeTest: (): Promise<{ app: string; step: string; ok: boolean; detail?: string }[]> => post("/api/settings/smoke"),
  cronStatus: (): Promise<{ lastSweepAt: string | null; lastSweepDay: string | null; today: string; sweptToday: boolean; queued: number; cronConfigured: boolean }> => req("/api/cron/status").then(j),
  usage: (): Promise<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string; byCategory: Partial<Record<"sweep" | "autorun" | "chat" | "manual_refine" | "other", number>> }> => req("/api/usage").then(j),
  taskEvents: (id: string): Promise<{ kind: string; message?: string; at: string }[]> => req(`/api/tasks/${id}/events`).then(j),
  // stepIndex: set by the per-step "Aide" button (see F) — the server validates the range itself.
  // Returns the WHOLE updated task, not just `chat` — a tutor turn can now create notes/decks/quizzes,
  // and the chat entries reference them by id, so the client needs task.notes/flashcards/quizzes too.
  chat: (id: string, message: string, stepIndex?: number, materials?: { label: string; text: string }[], voiceMode?: boolean): Promise<{ chat: WebTask["chat"]; task: WebTask }> => post(`/api/tasks/${id}/chat`, { message, stepIndex, materials, voiceMode }),
  // The flashcard/quiz "ask for a hint" sidebar — stateless server-side, so the client passes its own
  // short local history each turn. No client-side timeout (matches `chat`): the server's own 2-minute
  // deadline is the real backstop, and a hint arriving late still beats a hard-cut error mid-drill.
  studyHelp: (
    taskId: string,
    card: { kind: "flashcard"; front: string; back: string } | { kind: "quiz"; question: string; options: string[]; correct: number },
    history: { role: "user" | "assistant"; text: string }[],
    message: string,
  ): Promise<{ reply: string }> => post(`/api/tasks/${taskId}/study-help`, { card, history, message }),
  // Drain one queued job server-side and return the fresh task list + how many jobs remain active.
  kick: (): Promise<{ processed: number; failed: number; active: number; activeTaskIds?: string[]; tasks: WebTask[] }> => post("/api/jobs/kick"),
  // Study Mode API
  studySessions: (): Promise<StudySession[]> => req("/api/study/sessions").then(j),
  saveStudySession: (session: Partial<StudySession>): Promise<StudySession> => post("/api/study/session", session),
  studyProfile: (): Promise<StudyProfile> => req("/api/study/profile").then(j),
  saveStudyProfile: (profile: Partial<StudyProfile>): Promise<StudyProfile> => post("/api/study/profile", profile),
};
