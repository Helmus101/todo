import type { WebTask, ConnectionStatus, Profile, StudySession, StudyProfile } from "../shared/types.ts";
import { normalizeProfile } from "../shared/types.ts";

export interface IntegrationItem { key: string; name: string; blurb: string; category: string; logo: string; connected: boolean; accounts?: ConnectedAccount[]; }
export interface ConnectedAccount { id: string; email?: string; toolkit: string; status: string; }
export interface IntegrationsResp { ready: boolean; items: IntegrationItem[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
async function req(url: string, init?: RequestInit, retries = 6): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, init);
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
// Auth posts surface the server's error message instead of throwing, so the form can show it.
const authPost = (url: string, body: unknown): Promise<{ ok: boolean; error?: string }> =>
  req(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }));

export const api = {
  status: (): Promise<ConnectionStatus> => req("/api/status").then(j),
  signup: (email: string, password: string, consent: boolean) => authPost("/api/auth/signup", { email, password, consent }),
  login: (email: string, password: string) => authPost("/api/auth/login", { email, password }),
  integrations: (): Promise<IntegrationsResp> => req("/api/integrations").then(j),
  integrationAccounts: (app: string): Promise<{ accounts: ConnectedAccount[] }> => req(`/api/integrations/${app}/accounts`).then(j),
  disconnectIntegration: (app: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect`),
  disconnectAccount: (app: string, accountId: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect/${accountId}`),
  // Pronote — no OAuth, so this is a credential form rather than a redirect (see server/pronote.ts).
  pronoteStatus: (): Promise<{ connected: boolean; username?: string }> => req("/api/integrations/pronote/status").then(j),
  connectPronote: (url: string, username: string, password: string, kind?: number): Promise<{ ok: boolean; error?: string }> =>
    post("/api/integrations/pronote/connect", { url, username, password, kind }).catch((e) => ({ ok: false, error: e?.message || "Couldn't connect." })),
  disconnectPronote: (): Promise<{ ok: boolean }> => post("/api/integrations/pronote/disconnect"),
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
  reviewsDue: (): Promise<{ due: { taskId: string; taskTitle: string; deckId: string; deckTitle: string; cardIndex: number; front: string }[] }> => req("/api/reviews/due").then(j),
  // Study log: daily "what I learned today" → auto flashcards (see server/index.ts's /api/studylog/*).
  // Saving empty text clears that day's entry+deck; non-empty text (re)generates the deck server-side.
  studyLogDay: (date: string, text: string): Promise<WebTask[]> => post("/api/studylog/day", { date, text }),
  studyLogWeek: (start: string): Promise<{ monday: string; days: (WebTask | null)[]; summary: WebTask | null }> =>
    req(`/api/studylog/week?start=${encodeURIComponent(start)}`).then(j),
  studyLogWeekSummary: (weekStart: string): Promise<WebTask[]> => post("/api/studylog/week-summary", { weekStart }),
  studyFreeSession: (): Promise<WebTask[]> => post("/api/study/free", {}),
  addExam: (subject: string, deadline: string): Promise<Profile> => post("/api/profile/exam", { subject, deadline }).then(normalizeProfile),
  deleteExam: (id: string): Promise<Profile> => req(`/api/profile/exam/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j).then(normalizeProfile),
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
  // 25s: an execute_step run through the queue can involve a real tool call (open a page, search, draft
  // something) — long enough to let a normal one finish, short enough that a stuck click surfaces an
  // error instead of sitting there looking broken.
  runStep: (id: string, index: number, answer?: string): Promise<WebTask> => postTimed(`/api/tasks/${id}/step/${index}/run`, 25000, answer ? { answer } : undefined),
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
  setPaused: (paused: boolean): Promise<Profile> => post("/api/settings/pause", { paused }).then(normalizeProfile),
  goUnlimited: (): Promise<Profile> => post("/api/settings/unlimited").then(normalizeProfile),
  smokeTest: (): Promise<{ app: string; step: string; ok: boolean; detail?: string }[]> => post("/api/settings/smoke"),
  cronStatus: (): Promise<{ lastSweepAt: string | null; lastSweepDay: string | null; today: string; sweptToday: boolean; queued: number; cronConfigured: boolean }> => req("/api/cron/status").then(j),
  usage: (): Promise<{ in: number; out: number; total: number; runs: number; since: string | null; monthCostUsd: number; budgetUsd: number; over: boolean; renewsOn: string }> => req("/api/usage").then(j),
  taskEvents: (id: string): Promise<{ kind: string; message?: string; at: string }[]> => req(`/api/tasks/${id}/events`).then(j),
  // stepIndex: set by the per-step "Aide" button (see F) — the server validates the range itself.
  // Returns the WHOLE updated task, not just `chat` — a tutor turn can now create notes/decks/quizzes,
  // and the chat entries reference them by id, so the client needs task.notes/flashcards/quizzes too.
  chat: (id: string, message: string, stepIndex?: number): Promise<{ chat: WebTask["chat"]; task: WebTask }> => post(`/api/tasks/${id}/chat`, { message, stepIndex }),
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
