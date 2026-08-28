// Shared task model — imported by both the Express backend and the React client.

export type Quadrant = "do" | "schedule" | "delegate" | "later";

// The task lifecycle. Newer, more precise states + the two legacy aliases still readable from old data:
//   ready            → discovered/added, not yet queued for execution
//   queued           → an execution job exists; a worker will pick it up
//   executing        → a worker is acting right now              (legacy alias: "running")
//   needs_review     → Otto did the work; you review/send/confirm (legacy alias: "executed")
//   failed_retryable → last run failed; will retry automatically
//   failed_terminal  → retries exhausted; needs your explicit Retry
//   done             → you confirmed it handled
//   dismissed        → you dropped it (similar tasks won't come back)
export type TaskStatus =
  | "ready" | "queued" | "executing" | "needs_review"
  | "failed_retryable" | "failed_terminal" | "done" | "dismissed"
  | "running" | "executed"; // legacy aliases (old saved data) — treated as executing / needs_review

/** Collapse legacy aliases so ALL comparisons happen on the new lifecycle. */
export const canonStatus = (s: TaskStatus): TaskStatus => (s === "running" ? "executing" : s === "executed" ? "needs_review" : s);
/** Is the task in a state where Otto's work is finished or the user closed it? */
export const isHandled = (s: TaskStatus): boolean => s === "done" || s === "dismissed";
/** Is an execution currently owned by the job system (don't enqueue another)? */
export const isInFlight = (s: TaskStatus): boolean => { const c = canonStatus(s); return c === "queued" || c === "executing"; };

export interface TaskLink {
  label: string;
  url: string;
}

/** A lightweight model of WHO THE USER IS — built up over time, used to ground + personalize tasks. */
export interface Profile {
  name?: string;          // what to call the user (asked at onboarding / learned from their mail)
  about: string;          // a short paragraph: role, how they work, what matters
  preferences: string[];  // e.g. "concise emails", "no meetings before 10am"
  people: string[];       // key people + relationship ("Sarah — my manager")
  projects: string[];     // ongoing projects / goals
  // Per-course/class behavioral patterns — the "gets smarter every semester" memory: a professor's grading
  // quirks or communication style, how far ahead of a deadline the student ACTUALLY starts (not what they
  // say), which subtask types they stall on. Kept as its own bucket (not lumped into `projects`) so a
  // course's facts don't scroll off the list behind unrelated ongoing projects, and so the UI/prompts can
  // treat "this is about a specific class" as a distinct, groupable kind of fact.
  courses: string[];
  unlimited?: boolean;    // account has no monthly AI spend cap (set by visiting /unlimited) — overMonthlyBudget/
                          // overInteractiveBudget always read false for it, regardless of monthCostUsd
  // Stamped at signup once the required "I'm 15+, or a parent set this up for me" checkbox is checked
  // (server/index.ts's /api/auth/signup rejects signup without it) — a real audit trail for the RGPD
  // Art.8 parental-consent requirement, not just a UI gate that leaves no record.
  ageConsentAt?: string;
  paused?: boolean;       // "pause all AI usage" — blocks generation and task runs server-side
  pausedAt?: string;      // ISO stamp of the last toggle, so cross-device merge keeps the most RECENT choice
  lastSweepAt?: string;   // ISO stamp of the last SUCCESSFUL generation sweep — durable "did we check today"
                          // marker (survives restarts; source of truth for the once-per-local-day guarantee)
  lastForcedAt?: string;  // ISO stamp of the last time the sweep FORCED a "daily minimum" task (when it would
                          // otherwise have surfaced nothing) — so we guarantee at most one forced task per local day
  genPerDay?: number;     // how many times/day Otto scans for new tasks (1–4; default 1). Sets the sweep cadence.
  // Structured preferences for autonomous behavior
  responseStyle?: "concise" | "detailed" | "casual" | "formal"; // how AI should draft responses
  autoApprove?: string[]; // categories of actions AI can do without approval (e.g., ["schedule_meetings_under_30min", "archive_newsletters"])
  highPriorityPeople?: string[]; // people whose messages get higher priority
  autoArchivePatterns?: string[]; // email patterns to auto-archive (e.g., ["newsletter", "promotions"])
  timezone?: string;      // the user's IANA timezone (auto-captured from the browser) — source of truth for
                          // all "local day" boundaries (sweep cadence, daily-minimum). Falls back to UTC.
  /** ISO stamp of the last change to ANY of genPerDay/timezone/responseStyle/autoApprove/
   *  highPriorityPeople/autoArchivePatterns/track (all set through the single POST /api/profile/preference
   *  route) — same reason as pausedAt/languageSetAt: without a stamp, mergeProfileStates's cross-device
   *  merge had no way to tell "this side actually changed the setting" from "this side just has an old
   *  session lying around," so a plain `p2 ?? p1` picked whichever device happened to commit ANYTHING
   *  (even an unrelated task click) most recently — silently reverting a real settings change made on
   *  another device/tab the moment the stale session did something else. */
  preferencesUpdatedAt?: string;
  // Cumulative AI token usage across sweeps + task runs (for the Settings "usage" view). Cumulative counters
  // are monotonic (merged by MAX across devices); the month* counters roll over each calendar month and back
  // the monthly spend cap. Approximate — for visibility + a cost ceiling, not exact billing.
  usage?: { in: number; out: number; runs: number; since: string; monthKey?: string; monthIn?: number; monthOut?: number;
    /** Month-to-date spend in USD, accumulated PER CALL at the true price (cache-hit vs miss input priced
     *  separately, ×2 during DeepSeek peak hours) — NOT re-derived from token totals, which can't recover
     *  either factor. This is the number the cap enforces and Settings shows. Pre-upgrade rows lack it and
     *  fall back to the flat-rate token estimate. */
    monthCost?: number };
  // Which connected account to use for a multi-account app (Gmail, Calendar, Docs, Sheets, Slides, Drive)
  // when a task ISN'T tied to a specific discovered item (a manual task, a brand-new doc) — keyed by the
  // app's catalog key ("gmail", "googlecalendar", …) → Composio connectedAccountId. Defaults to whichever
  // account was connected first when unset. Tasks discovered FROM a specific account (a real email thread,
  // a real calendar event) always route back to THAT account regardless of this setting — this only
  // resolves the otherwise-ambiguous "which inbox does this new draft/doc belong to" case.
  primaryAccounts?: Record<string, string>;
  // Otto Lycée defaults to French; a student can switch the whole app (UI + AI-generated content) to
  // English in Settings. Undefined/anything else is treated as "fr".
  language?: "fr" | "en";
  // Which model provider THIS account's AI calls go through. Undefined/"deepseek" (default) keeps existing
  // behavior unchanged. "mistral" routes EVERY AI call for this account to Mistral instead — deliberately
  // no automatic fallback to DeepSeek if Mistral errors/is unconfigured (see aiClient in server/claude.ts):
  // the account explicitly chose Mistral, so a silent cross-provider fallback would be surprising and
  // would defeat the point of picking one (e.g. wanting all activity to show up on the Mistral account/bill).
  aiProvider?: "deepseek" | "mistral";
  languageSetAt?: string; // ISO stamp of the last language toggle — see pausedAt above, same reason:
                          // `normalizeProfile` always defaults `language` to "fr" (never leaves it
                          // undefined), so a plain `??` merge could never tell "never set" apart from
                          // "explicitly fr" and always kept the LOCAL session's copy, silently reverting
                          // another device's language switch on the next commit from this one.
  // Grades — lets Otto know which subject is actually slipping, not just what's due soonest, so a low
  // grade gets more lead time/attention than the deadline alone would suggest. Two sources coexist:
  // "pronote" entries are the school's own current subject average (Pronote's read API doesn't expose
  // individual grades, only the running average) — one per subject, overwritten on every sync, since it's
  // always "the average as of now", not a historical data point. "manual" entries are individual grades
  // the student logs by hand (any scale, e.g. /7 for IB) — these ACCUMULATE, never overwritten, so a
  // subject's grade history and its own average are both visible, not just the latest number.
  grades?: { id: string; subject: string; grade: number; scale: number; updatedAt: string; source?: "pronote" | "manual" }[];
  // Manually-logged exams/deadlines — the Pronote-less equivalent of PronoteTestItem (server/pronote.ts),
  // same {subject, deadline} shape so it merges trivially with Pronote's own list wherever tests are
  // consumed (ExamCountdown, computeWorkload). Most IB/international schools don't use Pronote at all — self
  // reporting a small `PronoteTestItem`, `subject`, and `deadline` is the same low-friction pattern as the
  // `grades` self-report above, not a new mechanism.
  manualExams?: { id: string; subject: string; deadline: string }[];
  // Which track this student is on — drives AI vocabulary (isBigIbProject/trackLine in claude.ts) and
  // unlocks the milestone/big-project breakdown for IB (EE/IA/TOK/CAS). Set from Settings.
  track?: "ib" | "bac" | "other";
  /** The student's actual school year/grade — e.g. "Terminale", "Grade 10", "DP1", "Year 12". Free text,
   *  not an enum: year-level names aren't standardized across the systems Otto supports, and forcing one
   *  system's labels onto another would be wrong for half the audience. This is what lets Otto tell a
   *  Seconde-level "quadratics" question apart from a Terminale one — see trackLine in server/claude.ts,
   *  which is the one place this actually gets used to calibrate content difficulty. Set at onboarding,
   *  editable in Settings; NOT a source of truth for scoring/priority (same boundary as `track` itself). */
  yearLevel?: string;
  /** VARK learning style, student-selectable in Settings. PRESENTATION ONLY — this must NEVER influence
   *  difficulty, depth, or what gets taught (the evidence for matching TEACHING to a "learning style" is
   *  weak; the evidence for retrieval practice + spacing, which Otto already does regardless of this field,
   *  is strong). It may only select the FORM an explanation takes — e.g. diagram-first vs. a worked example
   *  vs. reading-first — never the substance or the level. No consumer reads this yet (groundwork). */
  learningStyle?: "visual" | "auditory" | "reading" | "kinesthetic" | "mixed";
  /** Consecutive-days-with-at-least-one-completed-task counter, for a streak/progress view. `lastDayIso`
   *  is the last LOCAL day (student's own timezone) a task was completed — the day boundary a future
   *  updater must compare against to decide "still going" vs. "reset to 1". No writer populates this yet
   *  (groundwork); merge is monotonic (tasks.ts's mergeProfileStates) the same way `usage` is. */
  streak?: { current: number; longest: number; lastDayIso?: string };
}
// Shared client+server id generator (used for grade entries) — Web Crypto's randomUUID is available in
// both a modern browser and Node, so this needs no server-only import to stay isomorphic.
function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export function emptyProfile(): Profile { return { about: "", preferences: [], people: [], projects: [], courses: [] }; }
export function normalizeProfile(p: any): Profile {
  const arr = (v: any): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  return {
    name: typeof p?.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : undefined,
    about: typeof p?.about === "string" ? p.about : "",
    // Dedupe each list so reworded facts about the SAME person/project don't pile up (self-heals on every load).
    preferences: dedupeFacts(arr(p?.preferences)),
    people: dedupeFacts(arr(p?.people)),
    projects: dedupeFacts(arr(p?.projects)),
    courses: dedupeFacts(arr(p?.courses)),
    unlimited: !!p?.unlimited,
    paused: !!p?.paused,
    pausedAt: typeof p?.pausedAt === "string" ? p.pausedAt : undefined,
    lastSweepAt: typeof p?.lastSweepAt === "string" ? p.lastSweepAt : undefined,
    lastForcedAt: typeof p?.lastForcedAt === "string" ? p.lastForcedAt : undefined,
    genPerDay: Number.isFinite(Number(p?.genPerDay)) ? Math.min(4, Math.max(1, Math.round(Number(p.genPerDay)))) : undefined,
    timezone: typeof p?.timezone === "string" && isValidTz(p.timezone) ? p.timezone : undefined,
    // Structured preferences
    responseStyle: ["concise", "detailed", "casual", "formal"].includes(p?.responseStyle) ? p.responseStyle : undefined,
    autoApprove: Array.isArray(p?.autoApprove) ? p.autoApprove.map(String) : undefined,
    highPriorityPeople: Array.isArray(p?.highPriorityPeople) ? p.highPriorityPeople.map(String) : undefined,
    autoArchivePatterns: Array.isArray(p?.autoArchivePatterns) ? p.autoArchivePatterns.map(String) : undefined,
    usage: p?.usage && typeof p.usage === "object" ? {
      in: Number(p.usage.in) || 0, out: Number(p.usage.out) || 0, runs: Number(p.usage.runs) || 0,
      since: typeof p.usage.since === "string" ? p.usage.since : new Date().toISOString(),
      monthKey: typeof p.usage.monthKey === "string" ? p.usage.monthKey : undefined,
      monthIn: Number(p.usage.monthIn) || 0, monthOut: Number(p.usage.monthOut) || 0,
      monthCost: Number(p.usage.monthCost) || 0,
    } : undefined,
    primaryAccounts: p?.primaryAccounts && typeof p.primaryAccounts === "object"
      ? Object.fromEntries(Object.entries(p.primaryAccounts).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined,
    language: p?.language === "en" ? "en" : "fr",
    aiProvider: p?.aiProvider === "mistral" ? "mistral" : undefined,
    languageSetAt: typeof p?.languageSetAt === "string" ? p.languageSetAt : undefined,
    preferencesUpdatedAt: typeof p?.preferencesUpdatedAt === "string" ? p.preferencesUpdatedAt : undefined,
    grades: Array.isArray(p?.grades)
      ? p.grades.map((g: any) => ({
          id: typeof g?.id === "string" && g.id ? g.id : newId(),
          subject: String(g?.subject || "").trim().slice(0, 60),
          grade: Number(g?.grade) || 0,
          scale: Number(g?.scale) > 0 ? Number(g.scale) : 20,
          updatedAt: typeof g?.updatedAt === "string" ? g.updatedAt : new Date().toISOString(),
          source: g?.source === "pronote" ? "pronote" as const : "manual" as const,
        })).filter((g: { subject: string }) => g.subject).slice(0, 200)
      : undefined,
    manualExams: Array.isArray(p?.manualExams)
      ? p.manualExams.map((e: any) => ({
          id: typeof e?.id === "string" && e.id ? e.id : newId(),
          subject: String(e?.subject || "").trim().slice(0, 60),
          deadline: typeof e?.deadline === "string" ? e.deadline : "",
        })).filter((e: { subject: string; deadline: string }) => e.subject && e.deadline).slice(0, 100)
      : undefined,
    track: ["ib", "bac", "other"].includes(p?.track) ? p.track : undefined,
    yearLevel: typeof p?.yearLevel === "string" ? p.yearLevel.trim().slice(0, 40) || undefined : undefined,
    learningStyle: ["visual", "auditory", "reading", "kinesthetic", "mixed"].includes(p?.learningStyle) ? p.learningStyle : undefined,
    streak: p?.streak && typeof p.streak === "object" ? {
      current: Math.max(0, Number(p.streak.current) || 0),
      longest: Math.max(0, Number(p.streak.longest) || 0),
      lastDayIso: typeof p.streak.lastDayIso === "string" ? p.streak.lastDayIso : undefined,
    } : undefined,
  };
}

/** Below this % of the scale, a grade counts as "weak" — the single threshold both the grades UI
 *  (grade-bar-fill.low) and the workload effort heuristic (server/workload.ts) key off of, so a
 *  subject reads as needing attention consistently everywhere instead of two silently-drifting numbers. */
export function isLowGrade(grade: number, scale: number): boolean {
  return scale > 0 && (grade / scale) * 100 < 45;
}

/** Group a flat grade list into per-subject averages, each normalized to /20 (so a subject graded /7,
 *  like an IB IA, sits on the same footing as one graded /20 when compared or rolled into an overall
 *  average) — plus the individual entries, newest first, so the UI can show both "your Maths average"
 *  and every grade that went into it. Shared by the client (Settings) and anywhere server-side wants to
 *  reason about "which subject is struggling" without duplicating the grouping logic. */
export interface SubjectGrades { subject: string; avg20: number; entries: NonNullable<Profile["grades"]>; }
export function gradesBySubject(grades: NonNullable<Profile["grades"]> | undefined): SubjectGrades[] {
  const map = new Map<string, NonNullable<Profile["grades"]>>();
  for (const g of grades || []) {
    const key = g.subject.toLowerCase();
    (map.get(key) || map.set(key, []).get(key)!).push(g);
  }
  return [...map.values()].map((entries) => {
    const sorted = [...entries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const avg20 = entries.reduce((sum, g) => sum + (g.grade / g.scale) * 20, 0) / entries.length;
    return { subject: sorted[0].subject, avg20, entries: sorted };
  }).sort((a, b) => a.avg20 - b.avg20); // weakest subject first — same "needs attention" ordering as the grades list
}

/** Is this a resolvable IANA timezone? (Intl throws on an unknown zone.) */
export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** The user's timezone for all "local day" math — their captured zone, else UTC. */
export function tzOf(profile?: Profile | null): string {
  return profile?.timezone || "UTC";
}

/** DeepSeek's peak-pricing windows (UTC): 01:00-04:00 and 06:00-10:00 — every billing item costs 2x during
 *  these hours. Background work that isn't blocking a user (an unattended sweep, an offline auto-run) should
 *  prefer to run outside them; anything the user is actively waiting on must still run immediately regardless
 *  of price — only the deferrable, autonomous paths consult this. */
export function isPeakHourUtc(now: Date = new Date()): boolean {
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** The current calendar month key ("YYYY-MM") in a given timezone — the monthly cap's rollover boundary. */
export function monthKeyOf(tz?: string, now: Date = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit" }).format(now); }
  catch { return now.toISOString().slice(0, 7); }
}

/** The current LOCAL calendar day ("YYYY-MM-DD") in a given timezone — the streak's own day boundary,
 *  same en-CA trick as monthKeyOf (that locale's date format is already YYYY-MM-DD). */
export function dayKeyOf(tz?: string, now: Date = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return now.toISOString().slice(0, 10); }
}

/** Advance the streak on a completed task, at most once per local day (calling it twice the same day must
 *  not double-count). Consecutive local days → +1; a gap of 2+ days → reset to 1; same day → no-op. */
export function bumpStreak(profile: Profile, tz?: string, now: Date = new Date()): void {
  const today = dayKeyOf(tz, now);
  const s = profile.streak || { current: 0, longest: 0 };
  if (s.lastDayIso === today) { profile.streak = s; return; }
  const yesterday = dayKeyOf(tz, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const current = s.lastDayIso === yesterday ? s.current + 1 : 1;
  profile.streak = { current, longest: Math.max(s.longest, current), lastDayIso: today };
}

// DeepSeek pricing in USD per 1M tokens. Cache-HIT input is dramatically cheaper than a miss, and we resend
// a large system prompt every round, so hit rates are high — pricing all input at the miss rate (the old
// behaviour) over-charged the meter. Output ≈4× a miss. Single source of truth so the Settings display and
// the server-side cap always agree with the invoice.
export const USD_PER_1M_IN = 0.27;        // cache-MISS input
export const USD_PER_1M_CACHED_IN = 0.07; // cache-HIT input (~¼ the miss price)
export const USD_PER_1M_OUT = 1.10;
/** Flat-rate estimate from token totals — used only for display of PRE-upgrade data that lacks a per-call
 *  cost. New spend is metered by callCostUsd (cache- and peak-aware) at the point of each call. */
export function usageCostUsd(inTok: number, outTok: number): number {
  return (Number(inTok) || 0) / 1e6 * USD_PER_1M_IN + (Number(outTok) || 0) / 1e6 * USD_PER_1M_OUT;
}
/** The TRUE cost of one AI call: cache-hit input priced separately from miss, and the whole call ×2 during
 *  DeepSeek's peak window (per isPeakHourUtc). `inTok` is the FULL prompt-token count; `cachedIn` is the
 *  cache-hit portion of it (the rest is charged at the miss rate). This is what the cap must count. */
export function callCostUsd(inTok: number, outTok: number, cachedIn = 0, at: Date = new Date()): number {
  const total = Math.max(0, Number(inTok) || 0), cached = Math.min(total, Math.max(0, Number(cachedIn) || 0));
  const miss = total - cached;
  const base = miss / 1e6 * USD_PER_1M_IN + cached / 1e6 * USD_PER_1M_CACHED_IN + (Number(outTok) || 0) / 1e6 * USD_PER_1M_OUT;
  return base * (isPeakHourUtc(at) ? 2 : 1);
}
/** Month-to-date AI spend (USD) for this account, honoring the calendar-month rollover. */
export function monthCostUsd(profile?: Profile | null, tz?: string, now: Date = new Date()): number {
  const u = profile?.usage;
  if (!u) return 0;
  // A stale monthKey means the stored month* counters belong to a past month — treat this month as $0.
  if (u.monthKey && u.monthKey !== monthKeyOf(tz ?? tzOf(profile), now)) return 0;
  // Prefer the per-call metered cost (cache- and peak-aware); fall back to the flat token estimate only for
  // pre-upgrade rows that never accumulated it.
  return typeof u.monthCost === "number" ? u.monthCost : usageCostUsd(u.monthIn || 0, u.monthOut || 0);
}
/** The monthly AI budget (USD). Override with MONTHLY_AI_BUDGET_USD (server-side); default $3. */
export function monthlyBudgetUsd(): number {
  const raw = typeof process !== "undefined" ? Number(process.env?.MONTHLY_AI_BUDGET_USD) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}
/** Has this account crossed its monthly AI budget? Gates BACKGROUND generation + execution when true. */
export function overMonthlyBudget(profile?: Profile | null, now: Date = new Date()): boolean {
  if (profile?.unlimited) return false;
  return monthCostUsd(profile, tzOf(profile), now) >= monthlyBudgetUsd();
}
/** A small reserve above the cap kept for INTERACTIVE, user-present actions — the Approve & Run click, a
 *  manual run, a revision. The whole point of the product is that a human is the last step, so the last step
 *  must not be the thing the cap kills; it can spill slightly past the cap to let the user finish. Background
 *  work (sweeps, offline auto-run) still stops hard at the cap via overMonthlyBudget. */
export const INTERACTIVE_RESERVE = 1.1;
export function overInteractiveBudget(profile?: Profile | null, now: Date = new Date()): boolean {
  if (profile?.unlimited) return false;
  return monthCostUsd(profile, tzOf(profile), now) >= monthlyBudgetUsd() * INTERACTIVE_RESERVE;
}
/** When the budget resets — the 1st of next month in the user's timezone, as an ISO date ("YYYY-MM-DD"). */
export function budgetRenewsOn(profile?: Profile | null, now: Date = new Date()): string {
  const [y, m] = monthKeyOf(tzOf(profile), now).split("-").map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Add one AI call's token cost to a profile's usage counters (mutates in place) — cumulative for the
 *  Settings view, plus month-to-date (with calendar-month rollover) for the spend cap. Best-effort. */
export function addUsage(profile: Profile, tokens?: { in?: number; out?: number; cachedIn?: number } | null): void {
  const tin = Number(tokens?.in) || 0, tout = Number(tokens?.out) || 0, cached = Number(tokens?.cachedIn) || 0;
  if (!tin && !tout) return;
  const u = profile.usage || { in: 0, out: 0, runs: 0, since: new Date().toISOString() };
  const mk = monthKeyOf(tzOf(profile));
  const sameMonth = u.monthKey === mk;
  // Meter the TRUE cost of this call now — cache breakdown and peak multiplier can't be recovered later.
  const cost = callCostUsd(tin, tout, cached);
  profile.usage = {
    in: u.in + tin, out: u.out + tout, runs: u.runs + 1, since: u.since,
    monthKey: mk,
    monthIn: (sameMonth ? (u.monthIn || 0) : 0) + tin,
    monthOut: (sameMonth ? (u.monthOut || 0) : 0) + tout,
    monthCost: (sameMonth ? (u.monthCost || 0) : 0) + cost,
  };
}

const FACT_STOP = new Set(["the","and","for","with","from","that","this","they","their","them","she","her","his","him","who","handles","handled","leads","are","was","were","has","have","will","its","willem","also","both"]);
const emailsIn = (s: string): string[] => s.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
const normFact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function factTokens(s: string): Set<string> {
  const words = normFact(s).split(" ").filter((w) => w.length > 2 && !FACT_STOP.has(w));
  return new Set([...emailsIn(s), ...words]);
}
/** Are two profile facts about the SAME entity? Shared email, OR an identical long opening, OR heavy
 *  distinctive-token overlap — so "Emilie … onboarding and convention" and a reworded copy collapse,
 *  while genuinely different facts (road-trip itinerary vs university visits) stay separate. */
export function sameFact(a: string, b: string): boolean {
  const ea = emailsIn(a), eb = emailsIn(b);
  if (ea.length && eb.length && ea.some((e) => eb.includes(e))) return true;
  const pa = normFact(a).slice(0, 42), pb = normFact(b).slice(0, 42);
  if (pa.length >= 24 && pa === pb) return true;
  const A = factTokens(a), B = factTokens(b);
  if (A.size < 3 || B.size < 3) return normFact(a) === normFact(b);
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return jaccard >= 0.5 || (inter >= 6 && containment >= 0.6);
}
/** Collapse same-entity facts, keeping the richer (longer) wording; caps the list so it can't grow forever. */
export function dedupeFacts(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const fact = String(raw || "").trim();
    if (!fact) continue;
    const i = out.findIndex((x) => sameFact(x, fact));
    if (i === -1) out.push(fact);
    else if (fact.length > out[i].length) out[i] = fact; // same entity → keep the more detailed version
  }
  return out.slice(0, 40);
}

// Parse a task's free-text `when` ("today", "by Fri", "June 30", "2026-07-24") into a sortable epoch —
// soonest first. Unparseable / empty → +Infinity (sorts last). Deliberately simple: only needs relative
// ORDER, and the model already emits real dates from the source item (never invented). Shared so the
// server ordering and the client list sort identically.
const RANK_MONTHS: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
export function deadlineEpoch(when: string | undefined, now: Date = new Date()): number {
  const s = String(when || "").trim().toLowerCase();
  if (!s) return Infinity;
  if (/\btoday\b|\btonight\b|\bnow\b/.test(s)) return now.getTime();
  if (/\btomorrow\b/.test(s)) return now.getTime() + 864e5;
  // A string with an explicit 4-digit year is unambiguous → trust Date.parse ("2026-07-24", "June 30 2026").
  if (/\b20\d{2}\b/.test(s)) { const iso = Date.parse(s); if (!isNaN(iso)) return iso; }
  // Month + day WITHOUT a year → current year (or next if already well past). Must run BEFORE a bare
  // Date.parse — Node parses "july 30" to year 2001, which would sort a summer deadline into the past.
  const md = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/);
  if (md && RANK_MONTHS[md[1]] !== undefined) {
    const d = new Date(now.getFullYear(), RANK_MONTHS[md[1]], Number(md[2]));
    if (d.getTime() < now.getTime() - 180 * 864e5) d.setFullYear(now.getFullYear() + 1); // next occurrence
    return d.getTime();
  }
  return Infinity;
}

/**
 * Rank a task list by the Eisenhower matrix with meaningful tie-breaks, so order within a priority level
 * isn't arbitrary. Precedence: (1) Eisenhower `score` (do > schedule > delegate > later — the dominant
 * term), (2) soonest real deadline, (3) a high-priority person is involved, (4) freshest. Pure and
 * deterministic — used by BOTH the server ordering and the client list, so the sort is identical
 * everywhere. It reorders; it changes NO layout.
 */
export function sortWithinQuadrant<T extends { score: number; when?: string; source?: string; why?: string; title?: string; updatedAt?: string; createdAt?: string }>(
  list: T[], highPriorityPeople: string[] = [], now: Date = new Date(),
): T[] {
  const vipTokens = highPriorityPeople.flatMap((v) => {
    const email = v.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const name = v.split(/[—\-(,]/)[0].trim().toLowerCase();
    return [email, name.length >= 3 ? name : undefined].filter((x): x is string => !!x);
  });
  const isVip = (t: T) => { const hay = `${t.why || ""} ${t.title || ""} ${t.source || ""}`.toLowerCase(); return vipTokens.some((tok) => hay.includes(tok)); };
  const fresh = (t: T) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  return [...list].sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;          // Eisenhower quadrant + weight
    const da = deadlineEpoch(a.when, now), db = deadlineEpoch(b.when, now);
    if (da !== db) return da - db;                                             // soonest deadline first
    const va = isVip(a) ? 1 : 0, vb = isVip(b) ? 1 : 0;
    if (va !== vb) return vb - va;                                             // high-priority person first
    return fresh(b) - fresh(a);                                                // freshest first
  });
}

/**
 * One step in "what's left" for a task. The agent classifies each: `automatable` means Weave can do it
 * itself (draft/doc/research/open a page); otherwise it's an act only you can take. `dependsOn` is the
 * index of a step that must be done first (so a dependent step waits, then can auto-run). `url` marks an
 * "open this page" step. `done`/`result` track completion.
 */
export interface TaskStep {
  text: string;
  automatable: boolean;
  dependsOn?: number;   // index of a prerequisite step
  url?: string;         // if doing it means opening a page
  done?: boolean;
  doneAt?: string;      // ISO timestamp of when this step was completed — shown so progress is never "forgotten"
  result?: string;      // short note of what auto-doing it produced
  /** Set by the server when the action was blocked by the permission gate (doc edit / calendar create).
   *  The client shows an "Approve & Run" prompt; the user's click routes through runStep which bypasses the gate. */
  needsPermission?: boolean;
  /** Set ONLY by the server's checklist backstop (a deterministic "go look at what was made" nudge, not
   *  something the model asked for) — excluded from the "does this run still need the user" check in
   *  runStep, so a focused step-run that merely produced an artifact isn't kept perpetually unfinished. */
  synthetic?: boolean;
  /** The ONE piece of info the agent needs from the user to automate this step (a choice, a date, a name).
   *  The client shows it inline with `options` as tappable answers + a free-text input; answering runs the step. */
  question?: string;
  options?: string[];   // 2-4 likely answers, best inference first (tap-to-answer MCQ)
  /** ISO date (YYYY-MM-DD) this step should land by — set only for a big IB project broken into milestones
   *  (Extended Essay, TOK, CAS, an IA, a group project), never for an ordinary short task. Lets the sweep
   *  detect a slipped milestone and re-plan the remaining ones deterministically (see `replanMilestones`). */
  targetDate?: string;
  /** A step can be broken down further on request ("Détailler cette étape") — e.g. a milestone like
   *  "Write the introduction" expands into its own small checklist. Persisted on the step itself (not
   *  ephemeral chat output), so it survives reloads and reads as part of the task's real plan, not
   *  advice that scrolled away. Generated once per step; the student ticks them off independently of the
   *  parent step (the parent still needs its own "C'est fait" — sub-steps are a working aid, not a gate). */
  /** `automatable`: a pure lookup/research sub-action (hours, prices, a schedule, a fact) that needs no
   *  login and isn't the student's own graded/learning work — Otto can just run it (see runSubstep in
   *  server/claude.ts) and fill `result` in, same "Otto did this part" affordance a parent step's own
   *  `automatable` flag already has. Unset/false sub-actions stay manual, ticked by the student. */
  substeps?: { text: string; done: boolean; url?: string; automatable?: boolean; result?: string }[];
  /** Realistic minutes this step should take (1-240), when Otto estimated one. Advisory only — never a
   *  timer or a deadline, just lets the UI answer "what can I fit in 15 minutes right now". Clamped in
   *  server/claude.ts's sanitizeStepExtras. */
  minutes?: number;
}

/** A reviewed message/invite the agent prepared (a Gmail draft / a composed Slack message / a calendar event
 *  whose invites aren't sent yet) that the USER can fire with one click. The agent NEVER sends; the user
 *  confirms + clicks — and the recipients are always shown first — and the server executes the send. */
export interface Sendable {
  app: "gmail" | "gcal";
  label: string;        // e.g. "Send reply to Sarah", "Send invites"
  to?: string;          // recipient email — shown before the user confirms
  subject?: string;     // gmail: the drafted subject (for in-app review)
  body?: string;        // gmail: the drafted body (for in-app review)
  draftId?: string;     // gmail: the draft_id to send
  attendees?: string[]; // gcal: the people the invite will email — ALWAYS shown before sending
  eventId?: string;     // gcal: the event to patch (send_updates=all) so attendees get invited
  summary?: string;     // gcal: the event title (for in-app review)
  when?: string;        // gcal: human-readable date/time of the event (for in-app review)
  sent?: boolean;       // fired already (can't double-send)
}

export interface WebTask {
  id: string;
  title: string;
  why: string;
  /** Client-generated idempotency key for a manually-added task — the client passes it (its own local
   *  stub id) on POST /api/tasks so a retried/duplicated request (a double-click, a proxy retry after a
   *  dropped response — see api.ts's `req()`) can be recognized as "already added" instead of creating a
   *  second task. Never shown in the UI, never set for any other source. */
  clientId?: string;
  when?: string;       // concise timeline / deadline, e.g. "today", "by Fri 5pm", "this week"
  /** True when `when` was NOT stated/implied by the source (the AI left it '') and was instead assigned
   *  deterministically from the task's own urgency/importance (see estimateWhen in server/tasks.ts) so
   *  ranking/escalation has a real date to work against instead of drifting forever at whatever score it
   *  started with. Lets the UI show it as "~around Fri" rather than claiming a firm date that doesn't exist. */
  whenApprox?: boolean;
  source: string;      // "gmail" | "calendar" | "manual", or a connected-app slug (notion, …)
  /** Reversible tasks auto-run; irreversible (e.g. sending) waits for your confirm. */
  risk: "low" | "high";
  urgency: number;     // 0..1 time pressure
  importance: number;  // 0..1 stakes
  quadrant: Quadrant;
  score: number;       // ranking
  status: TaskStatus;

  // Filled once it runs:
  context?: string;        // one-paragraph grounded background
  synthesis?: string;      // what the agent actually did (one-line summary)
  did?: string[];          // concrete past-tense bullets of the actions performed this run
  links?: TaskLink[];      // docs/drafts it produced
  steps?: TaskStep[];      // what's left, as classified bullets (automatable / needs-you / dependent)
  sendables?: Sendable[];  // drafted email / composed Slack message the user can send in one click

  evidence?: TaskLink[];   // the real source(s) this came from (the email thread / calendar event)
  autoRan?: boolean;       // guard so a reversible task auto-runs at most once
  /** Stable identity of the underlying thing (e.g. "gmail:<threadId>", "calendar:<eventId>"). Dedupes
   *  the SAME email/event across refreshes even when the model rephrases the title. */
  anchorKey?: string;
  /** Multi-Gmail: the Composio connected-account id this task's source came from, so execution acts on the
   *  right inbox (drafts the reply in the account that received the mail). Undefined for single-account users. */
  sourceAccountId?: string;
  /** VERBATIM text of the source item — for Pronote, the teacher's own assignment description ("Exercices
   *  12 à 15 p.87 — mécanique du point"). This is the SUBJECT MATTER of the task, not background: the run,
   *  the research planner and the tutor chat all quote it so the artifacts they produce are about the real
   *  exercise instead of being written from the title alone.
   *
   *  NEVER model-authored — it is copied straight off the SourceItem, exactly like `anchorKey`. The
   *  agent-sweep fallback path (parseGenerated) has no source item and deliberately leaves this undefined
   *  rather than letting the model invent an "énoncé". Never overwritten by a run (unlike `context`). */
  sourceDetail?: string;
  /** The real subject as Pronote names it ("Physique-Chimie") — drives per-subject artifact shaping. */
  sourceSubject?: string;
  /** The source item's own due date (ISO) — Pronote's, not the model's reading of it. */
  sourceDue?: string;
  createdAt: string;
  /** Bumped on every mutation (status change, step tick, run result) — breaks cross-device merge ties so a
   *  STALE copy can never overwrite a newer one. */
  updatedAt?: string;
  /** Why the last run failed (shown on failed_* cards with the Retry button). */
  lastError?: string;
  /** A manual task added while AI was paused/unavailable — raw text, not yet refined. The card offers a
   *  "Refine" action to clean it up once AI is back. */
  unrefined?: boolean;
  /** Artifacts Otto created for THIS task across runs (doc/draft/event ids). A rerun/revision may UPDATE
   *  these (permission carve-out: Otto edits what Otto made) instead of creating duplicates. */
  artifacts?: { kind: "doc" | "sheet" | "slides" | "draft" | "event"; id: string; url?: string; label?: string }[];
  /** Cost of the most recent run (input/output tokens) — shown in the timeline for cost visibility. */
  lastRunTokens?: { in: number; out: number };
  /** Per-task coaching thread — a student can ask Otto about THIS specific task (stuck on a step, wants
   *  it broken down further, needs encouragement) and get a reply grounded in the task's own context/steps,
   *  without re-explaining the situation every time. Capped (see CHAT_CAP in tasks.ts) so a long-running
   *  task's thread can't grow unbounded in storage. */
  chat?: {
    role: "user" | "assistant"; text: string; at: string;
    /** Artifacts the TUTOR created during this assistant turn — rendered as chips inline in the thread.
     *  Ids point into task.notes/flashcards/quizzes, which is where the content actually lives (one
     *  storage, two entry points: the thread and "Ce qu'Otto a préparé"). A chip whose id has since been
     *  evicted by ARTIFACT_CAP renders as nothing rather than crashing — see the client lookup. */
    artifacts?: { kind: "note" | "deck" | "quiz"; id: string; title: string }[];
    /** Which step (by index at send-time) a USER message was about — set by the "Aide" button on a step.
     *  `stepText` is the step's own wording at that moment, stored alongside because steps are regenerated
     *  on every rerun: a bare index could later point at a different step, or none. */
    stepIndex?: number;
    stepText?: string;
    /** Set on an assistant turn where the "won't do your graded work" guardrail actually tripped this
     *  turn (see CHAT_DOES_WORK in server/claude.ts) — lets the client tag the exact bubble where the
     *  boundary held, instead of that only being visible in the per-task Activity log. */
    guardrail?: boolean;
  }[];
  /** In-app fiches/checklists/reference notes Otto prepared for THIS task — no external account, no
   *  approval needed (nothing leaves the app). This is the DEFAULT artifact for a study guide: rendered
   *  as a button on the card that opens the content in a popup, instead of a Google Doc. */
  notes?: TaskNote[];
  /** In-app flashcard decks Otto prepared for THIS task — for vocab/definitions/concept review, where
   *  drilling front→back beats a written guide. Same no-account/no-approval model as notes. */
  flashcards?: TaskFlashcards[];
  /** In-app multiple-choice quizzes — for CHECKING UNDERSTANDING before a contrôle (flashcards drill raw
   *  recall; a quiz surfaces which part of a chapter isn't solid). Same no-account/no-approval model. */
  quizzes?: TaskQuiz[];
  /** Human-readable log of what Otto actually did on this task — a tool call, an artifact created, or a
   *  guardrail refusing to do the student's graded work. Exists so a parent/teacher can verify "never does
   *  the work" is enforced in practice, not just claimed — see the audit panel on the task card. Capped
   *  (AUDIT_CAP in tasks.ts) so it can't grow unbounded on a long-lived task. */
  audit?: { at: string; kind: "tool" | "artifact" | "guardrail"; label: string }[];
  /** The smallest possible first move on this task — the anti-procrastination hook ("open the doc and
   *  write one bad sentence", 2 minutes). Deliberately a TOP-LEVEL field, not steps[0]: inserting a
   *  synthetic zeroth step would shift every other step's index and silently corrupt any TaskStep.dependsOn
   *  already pointing at them on an existing task. */
  firstAction?: { text: string; minutes?: number };
}

export interface TaskNote {
  id: string;
  title: string;
  /** Markdown — rendered lightly client-side (headings, bold, bullets), never sent anywhere external. */
  body: string;
  createdAt: string;
}

// Leitner spacing schedule for flashcard review (box 1 = review again tomorrow, box 5 = review again in
// 16 days) — simple, proven, and enough to make retrieval practice compound over time instead of a deck
// being a one-shot artifact. Shared by client (optimistic update) and server (source of truth).
export const LEITNER_INTERVAL_DAYS = [1, 2, 4, 8, 16];
export function nextLeitnerReview(prevBox: number | undefined, correct: boolean, now: Date = new Date()): { box: number; dueAt: string } {
  const box = correct ? Math.min(5, (prevBox || 0) + 1) : 1;
  const days = LEITNER_INTERVAL_DAYS[box - 1];
  return { box, dueAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

export interface TaskFlashcards {
  id: string;
  title: string;
  cards: {
    front: string; back: string;
    /** Per-card drill history. `box` (1-5, Leitner) is now the ACTUAL spacing schedule FlashcardDeck writes
     *  on every review (see reviewCard in client/ui.tsx) — a correct review advances the box (and pushes
     *  `dueAt` further out per LEITNER_INTERVAL_DAYS), a miss resets to box 1. `ease`/`dueAt` were already
     *  here as SM-2 groundwork before any reviewer surfaced them; `dueAt` is now genuinely used (by `box`'s
     *  schedule, not a separate SM-2 ease calculation — `ease` stays unused groundwork for a future, more
     *  precise scheduler). `seen`/`correct` remain the raw "how am I doing on this deck" counts. */
    review?: { seen: number; correct: number; lastAt?: string; dueAt?: string; ease?: number; box?: number };
  }[];
  createdAt: string;
  lastReviewedAt?: string;
}

/** A drillable multiple-choice quiz attached to a task. Deliberately NOT the same thing as a flashcard
 *  deck: a deck drills recall (front → back), a quiz checks whether the student can DISCRIMINATE between
 *  plausible answers, which is what actually reveals a shaky notion before a contrôle. */
export interface TaskQuiz {
  id: string;
  title: string;
  questions: {
    q: string;
    /** 2-4 options. Exactly one is correct; the rest must be plausible — an obviously-silly distractor
     *  teaches nothing and turns the quiz into a reading exercise. */
    options: string[];
    /** Index into `options`. Validated server-side; a question whose correct option didn't survive
     *  sanitisation is dropped rather than silently re-pointed at the wrong answer. */
    correct: number;
    /** One line on WHY the right answer is right, shown after answering. This is what makes a quiz teach
     *  rather than just score — without it a wrong answer leaves the student no better off. */
    why?: string;
  }[];
  createdAt: string;
  /** Attempt history — cap 20, newest last. Groundwork for retention features (spaced re-quizzing, a
   *  "you missed this before" callout); nothing reads this yet. */
  attempts?: { at: string; score: number; total: number; wrong?: number[] }[];
}

export interface ConnectionStatus {
  loggedIn: boolean;          // signed into an email account
  user?: string;              // the account email
  name?: string;              // what to call the user (from their profile) — personalizes the UI
  googleConnected: boolean;   // Gmail is connected (via Composio) — the minimum to generate tasks
  pronoteConnected: boolean;  // Pronote is connected — the OTHER minimum (Otto Lycée works on Pronote alone)
  pronoteNeedsReconnect?: boolean; // the stored token is dead (expired/revoked) — reads silently return
    // empty otherwise, so this is the only signal that "connected" doesn't mean "actually working"
  aiReady: boolean;           // DEEPSEEK_API_KEY present
  googleConfigured: boolean;  // Composio configured (COMPOSIO_API_KEY) — powers Google + every integration
  cloud: boolean;             // Supabase configured → accounts + state persist
  paused: boolean;            // "pause all AI usage" toggle — client skips auto-run/generate while true
  highPriorityPeople?: string[]; // used ONLY to break ranking ties (VIP's task sorts first) — no UI of its own
  genPerDay?: number;         // how many times/day Otto scans for new tasks (1–4) — drives the client sweep cadence
  timezone?: string;          // the account's captured IANA timezone (client compares to detect a change)
  overBudget?: boolean;       // month-to-date AI spend has crossed the cap — gen/exec paused until it resets
  unlimited?: boolean;        // account has no monthly AI spend cap (set via the /unlimited page)
  language?: "fr" | "en";     // the account's UI + AI-content language (Settings toggle) — defaults "fr"
  streak?: { current: number; longest: number; lastDayIso?: string }; // see Profile.streak — bumped on task confirm
}

export interface RunResult {
  ok: boolean;
  message?: string;
  task?: WebTask;
}
