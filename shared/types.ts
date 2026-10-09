// Shared task model — imported by both the Express backend and the React client.
import { normalizeCoursework, type CourseworkDoc } from "./coursework.ts";
// The adaptive-agent layer's shapes (the persistent student model, the concept graph, the app-owned session
// state, the board event stream and the action space). They live in their own shared module so the client can
// type the transparency panel without importing any server code — see shared/agentTypes.ts.
import type { StudentModelShape, ConceptGraphShape, TutorSessionStateShape, TutorDecisionShape, BoardEventShape } from "./agentTypes.ts";
import { SESSION_CAP } from "./agentTypes.ts";

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
  sessions: string[];     // short end-of-tutoring-session recaps ("Physique — worked SUVAT for projectile
                          // motion, landed it; still shaky on vector decomposition") — distinct from
                          // `courses` (a standing pattern that holds for the whole term) in that each entry
                          // is a snapshot of ONE session, so the newest ones are what should actually
                          // surface, not deduped against older ones the way a restated preference would be.

  // === Primer-specific fields (Phase 1 foundation) ===
  // Developmental position - per-domain level, not a single "grade"
  domainLevels?: Record<string, { level: string; phase: string; updatedAt: string }>; // reading, math, reasoning, etc.
  // Age band for policy selection (if different from birth year calculation)
  ageBand?: "A" | "B" | "C" | "D" | "E" | "F";
  // Birth year (not full DOB to minimize PII)
  birthYear?: number;
  // Home languages (for dual-language support)
  homeLanguages?: string[];
  // Thinking-skills profile - per thinking-move frequency and quality
  thinkingStats?: Record<string, { nUsed: number; qualityAvg: number; lastUsed: string }>;
  // Calibration accuracy (confidence vs correctness)
  calibration?: Record<string, { bucket: string; n: number; accuracy: number }>;
  // Policy profile ID currently in effect
  policyProfileId?: string;
  // Guardrails & permissions
  primerSettings?: {
    blockedTopics?: string[];
    sessionCapMinutes?: number;
    dailyCapMinutes?: number;
    quietHours?: { start: string; end: string };
    parentViewLevel?: "full" | "summary" | "none";
  };
  // Dependence metrics (anti-dependence system from Primer §6.9)
  dependenceMetrics?: Record<string, {
    week: string;
    helpRatio: number;  // hint requests / attempts
    answerSeekRate: number;  // "just tell me" requests
    unaidedRate: number;  // success without hints
    fadeIndex: number;  // are hint levels trending down?
  }>;
  // The WEEKLY SERIES the same-named snapshot above was always meant to be derived from — see
  // server/hintLadder.ts. The snapshot alone (one week, overwritten in place) could never answer the
  // question the anti-dependence rules actually ask ("are hint levels TRENDING down?"), which is why
  // server/dependenceMetrics.ts's array-based functions had no caller: there was nothing to feed them.
  // Capped at 52 entries per domain (a year of weeks) in normalizeProfile, newest last.
  dependenceHistory?: Record<string, DependenceMetric[]>;
  // The persistent, per-CONCEPT student model (server/studentModel.ts) — what Otto believes about how this
  // student learns, with the evidence behind each belief. One object so it's validated, capped and reset as
  // a unit. Fully visible in the transparency panel (spec §30) and resettable from Settings.
  conceptModel?: StudentModelShape;
  // The concept/prerequisite graph (server/conceptGraph.ts) — the curated spine plus the concepts discovered
  // in this student's own courses and uploaded documents. Persisted so discovery is paid for once.
  conceptGraph?: ConceptGraphShape;
  // Per-task tutor session state (server/sessionState.ts), newest last, capped — the app-owned record of
  // where a session had got to (objective, live concept, rung used, interventions issued, independence), so
  // a resumed session doesn't restart from nothing and the learning curve across sessions is readable.
  tutorSessions?: TutorSessionStateShape[];
  // The agent's own decision log (server/actionSpace.ts) — one entry per tutor turn: which action was chosen,
  // at what it was aimed, and why. NEVER shown to the student (spec §45 is explicit that this exists to make
  // the agent debuggable), so it is bounded aggressively and reset alongside the concept model.
  tutorDecisions?: TutorDecisionShape[];
  // Consent records (parental/guardian consent for under-13s)
  consentRecords?: {
    guardianId?: string;
    scope: string[];
    grantedAt: string;
    revokedAt?: string;
    method: "clickwrap" | "signature" | "other";
  }[];
  // Data retention settings
  dataRetentionDays?: number;
  // Per-course/class behavioral patterns — the "gets smarter every semester" memory: a professor's grading
  // quirks or communication style, how far ahead of a deadline the student ACTUALLY starts (not what they
  // say), which subtask types they stall on. Kept as its own bucket (not lumped into `projects`) so a
  // course's facts don't scroll off the list behind unrelated ongoing projects, and so the UI/prompts can
  // treat "this is about a specific class" as a distinct, groupable kind of fact.
  courses: string[];
  unlimited?: boolean;    // account has no monthly AI spend cap (set by visiting /unlimited) — overMonthlyBudget/
                          // overInteractiveBudget always read false for it, regardless of monthCostUsd
  // Opt-in gate for anything experimental: the 7 bandit-personalization suggestions (Pomodoro/audio/
  // density/chat-style/flashcard-verbosity/granularity/ordering), the Study Mode focus camera, and the
  // AI-personalized theme generator. Off (undefined) by default for every account — each gated feature
  // falls back to the exact same safe default it already uses today when its own live call fails, so
  // turning this off is never a new code path, just always taking the one that already exists.
  betaFeatures?: boolean;
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
  // ISO stamp of the last SUPPLEMENTARY sweep (tasks.ts's "SUPPLEMENTARY SWEEP" — the one OPEN-ENDED agentic
  // pass over non-Google toolkits, e.g. Notion). Unlike the deterministic Gmail/Calendar pipeline this is an
  // uncapped tool-calling loop, so it's throttled to once every few days (SUPPLEMENTARY_SWEEP_INTERVAL_DAYS
  // in tasks.ts) rather than every daily sweep — real AI spend, not worth re-running that often for a source
  // that changes slowly compared to email/calendar.
  lastSupplementarySweepAt?: string;
  // 24-length count of genuine engagement (task actions, chat, flashcard review, journal save, a study
  // session) by LOCAL hour-of-day — see bumpActivityHour/learnedProductiveHour below. This is the "when am I
  // actually working" signal the personalization ask wanted: not a fixed profile timezone bucket, a real
  // learned histogram from this student's own activity, used to autonomously time when Otto surfaces work
  // (see sweepDue in server/jobs.ts) instead of a one-size-fits-all fixed hour for every account.
  activityHours?: number[];
  // 168-length (7 weekdays × 24 hours, index = weekday*24+hour, weekday 0=Sunday matching Date#getDay) —
  // the finer-grained sibling of activityHours, feeding server/patterns.ts's predictNextEngagement ("most
  // likely to open Otto around Tuesday 18:00", not just "sometime in the evening"). Bumped alongside
  // activityHours by the same bumpActivityHour calls — no separate instrumentation needed.
  activityWeekdayHours?: number[];
  // ISO stamp of the last time bumpActivityHour halved both grids above for recency-weighting — habits
  // should be able to drift, not accumulate forever into a stale average. See bumpActivityHour's own
  // comment for why a periodic halving is used instead of per-event timestamps (the grids are running
  // counters, not a log; halving is the cheap approximation of "recent activity counts more").
  activityDecayedAt?: string;
  // Same idea as activityHours, but split per subject — the "when am I actually focused on THIS subject"
  // signal (e.g. Math HL in the evening, French in the morning), which the flat global histogram can't tell
  // apart when a student's subjects skew toward different times of day. Capped to the student's top ~6
  // most-active subjects (see SUBJECT_ACTIVITY_CAP in bumpActivityHour's own comment) so a profile with many
  // one-off subjects doesn't grow unbounded — the least-active tracked subject is evicted to make room for a
  // new one, same "recent/frequent wins" posture as the decay below. Same 24-length local-hour buckets and
  // halving policy as activityHours, decayed independently per subject (no shared activityDecayedAt, since
  // subjects start being tracked at different times).
  subjectActivityHours?: Record<string, { hours: number[]; decayedAt?: string }>;
  // Daily cap on AUTOMATIC task execution (sweep's own auto-run-top-3 AND the kick loop's catch-up, see
  // server/jobs.ts's autoRunBudgetLeft/recordAutoRuns) — a real per-day ceiling on passive AI spend that
  // happens with zero user interaction, distinct from the monthly $ budget (which is too coarse to catch
  // "why did €0.20 get spent today when I didn't touch the app" — by the time the monthly cap trips, a
  // whole month of unwatched daily spend has already happened). autoRunDay/autoRunCount reset together
  // whenever the local day changes; count is the number of tasks auto-enqueued so far THAT day.
  autoRunDay?: string;
  autoRunCount?: number;
  // Which flashcard decks have already counted against today's MAX_DUE_SETS_PER_DAY cap (see /api/reviews/due
  // in server/index.ts) — persisted (not just computed fresh per request) so that reviewing a card, which
  // moves its dueAt into the future and would otherwise make its deck stop looking "due", can't silently free
  // up a slot for a 4th deck on the same day. Reset (like autoRunDay/autoRunCount above) whenever the local
  // day changes.
  reviewSetsDay?: string;
  reviewSetDeckIds?: string[];
  // Stamped every write to reviewSetDeckIds — lets mergeProfileStates use latest-write-wins (like pausedAt/
  // lastSweepAt above) instead of unioning two devices' admitted sets. A single write is always ≤
  // MAX_DUE_SETS_PER_DAY by construction (the route only ever admits up to the cap); a same-day UNION of two
  // independent writes is not, and could blow the cap past 3 across devices. Latest-write-wins keeps the
  // invariant intact at the cost of possibly dropping a losing device's admissions from a genuinely
  // simultaneous race — an acceptable trade for a soft daily-dose cap, not a spend/security guard.
  reviewSetsUpdatedAt?: string;
  // No longer drives sweep cadence — automatic generation is now fixed at once/day, 16:00 local (see
  // server/jobs.ts's sweepDue) rather than this 1-4x/day setting. Field kept (not removed) since it's
  // still a harmless, settable preference with no UI exposing it either way — not worth a wider removal
  // for zero behavior change.
  genPerDay?: number;
  // Structured preferences for autonomous behavior
  responseStyle?: "concise" | "detailed" | "casual" | "formal"; // how AI should draft responses
  // Manual override for the UI density bandit (server/bandit.ts's DENSITY_ARMS) — set the moment the student
  // picks one explicitly in Settings, and ALWAYS wins over the bandit's own suggestion from then on (see
  // DENSITY_ARMS's own comment on why an auto-changing layout would be the opposite of "calm"). Undefined
  // means "still following the bandit's suggestion" — the normal, no-preference-yet state.
  uiDensity?: "cozy" | "compact" | "spacious";
  // AI-proposed personalized theme tokens (server/claude.ts's generateThemeTokens) — a small, strictly
  // validated set of CSS custom-property overrides (colors as hex, radii as bounded px), opt-in via a
  // Settings click. Re-validated again on every normalize (defense in depth: validateThemeTokens already
  // filters server-side before this is ever saved, but a value must survive BOTH checks to ever reach a
  // stylesheet). Unset = the default theme.
  customTheme?: Partial<Record<"--bg" | "--surface" | "--bg-2" | "--radius" | "--radius-sm" | "--radius-xs", string>>;
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
    monthCost?: number;
    /** Month-to-date spend broken down by WHAT spent it (see AddUsageCategory) — added because the total
     *  alone gives no way to answer "what's actually costing money" (a real question asked live: daily
     *  spend with zero user interaction, no way to tell sweep vs auto-run vs chat apart). Resets with the
     *  rest of the month* fields on a new month; pre-existing accounts simply have no entries here yet
     *  (never backfilled, same as monthCost's own "pre-upgrade rows lack it" note above). */
    monthByCategory?: Partial<Record<AddUsageCategory, number>> };
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
  // Documents uploaded per subject (shared/coursework.ts): a bounded summary + excerpt the tutor and chat can cite.
  coursework?: CourseworkDoc[];
  // When the student finished (or skipped) the first-run tour — server-side so it follows the account across devices.
  onboardedAt?: string;
  // Page guides already shown (ids like "tasks", "tutor-session") — server-side so a guide never repeats on another device.
  toursSeen?: string[];
  // The subjects this student takes (picked in onboarding): ordered first wherever a subject is chosen.
  subjects?: string[];
  // A student-maintained log of specific mistakes — "what question, what I got wrong, what to do about it
  // next time" — grouped by subject (see errorLogBySubject below). Distinct from journal flashcards
  // (client/App.tsx's StudyLogPage): a flashcard is "review this fact again"; an error-log entry is "here's
  // the exact gap in my reasoning and the fix", closer to an error journal used for exam prep. Accumulates
  // like grades/manualExams above — never overwritten, only appended to and individually deletable.
  errorLog?: { id: string; subject: string; question: string; mistake: string; fix: string; createdAt: string }[];
  // AI-synthesized running "mental model" of THIS student — how they think/reason, a recurring misconception
  // pattern, what's clicked for them before, a genuine interest worth an analogy, how they're growing over
  // time. REPLACED wholesale on every refresh (server/jobs.ts's processSweep), never appended — a tutor's
  // updated read of the kid, not a log. Refreshed at most once/day, ONLY inside the 4pm sweep (this app's
  // AI spend is deliberately confined to 3 windows: the sweep, chat, and journal/study mode — see
  // shouldRefreshStudentModel in server/tasks.ts) — one cheap synthesis call over data that already exists
  // (errorLog, weak flashcards, grades, growth trend), never a 4th AI-spend window. Fully visible + one-click
  // resettable in Settings (same transparency posture as errorLog/usage breakdown) — this is the most
  // surveillance-adjacent field in the app, so hiding it would be inconsistent with that precedent. NEVER
  // used for grading, a parent-facing view, or any priority/auto-archive decision — tutoring tone only.
  studentModel?: { summary: string; updatedAt: string; basedOnActivityAt?: string };
  // Durable, per-TOPIC progress markers — "mastered factoring quadratics", "can now conjugate the
  // subjonctif" — the granularity below `subject` that nothing else in the app tracks (grades/errorLog/
  // subjectActivityHours are all flat per-SUBJECT). Extracted alongside the existing journal→profile.courses
  // pipeline (extractJournalMemory, server/claude.ts) — same AI call, same "journal/study mode" spend
  // window (see studentModel's own comment on the 3 confined windows), no new cost. ACCUMULATES like
  // errorLog/grades (never overwritten) so the tutor can see real progression over the term, not just the
  // latest state. Read back into chat via milestoneLine (server/claude.ts) so Otto can build on what's
  // already landed instead of re-teaching it, and shown to the student directly (Journal tab) so the
  // "remembering" is visible, not just a black box.
  milestones?: { id: string; subject: string; topic: string; label: string; achievedAt: string }[];
  // Last time this student did something a tutor would call "real activity" — sent a chat message, saved a
  // journal entry, attempted a quiz/flashcard review. Distinct from activityHours (an hour-of-day histogram,
  // no absolute timestamp) — this is the single stamp shouldRefreshStudentModel compares against
  // studentModel.basedOnActivityAt to skip refreshing an inactive account for $0 cost.
  lastTutorActivityAt?: string;
  // Which program this student is on — drives AI vocabulary (trackLine in claude.ts) AND the default
  // question/assessment STYLE Otto generates (quizzes, practice problems, exam-prep questions): IB uses
  // command terms and mark-scheme-style rubrics, AP uses College Board MCQ/FRQ conventions — see
  // examStyleLine in claude.ts. "ap" added alongside "ib" (they're two distinct programs, not one "IB or
  // similar" bucket) by direct request. Set from Settings.
  track?: "ib" | "ap" | "bac" | "other";
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
  /** How much scaffolding the tutor gives when the student is stuck, student-selectable in Settings as a
   *  3-position slider/bar — a DIFFERENT axis from `learningStyle` above (that's presentation/FORM; this
   *  is PACING/how much the tutor walks through vs. just nudges). "steps" = walk through the reasoning
   *  step by step before handing it back for the next move; "hints" = a single pointed hint, then hand it
   *  straight back; "balanced" (the slider's middle/default position) = Otto's own judgment call per the
   *  hint ladder (server/claude.ts), same as before this preference existed — an explicit value, not just
   *  "unset," so the slider always has a definite position to render even for a brand-new account.
   *  Undefined behaves identically to "balanced" (hintDensityLine returns "" for both). NEITHER "steps"
   *  nor "hints" ever changes whether the tutor gives the direct answer — that's enforced unconditionally
   *  elsewhere (the HINT LADDER's "never release the final answer outright" rule) and is not configurable
   *  by this preference; it only adjusts HOW MUCH is shown on the way there. */
  hintDensity?: "steps" | "hints" | "balanced";
  /** Aggregated face tracking concentration and focus telemetry statistics over past study sessions. */
  focusStats?: {
    totalTrackedSessions: number;
    avgConcentration: number;
    avgGazeOnScreenPct: number;
    avgBlinkRate: number;
    restlessPct: number;
    subjectFocus?: Record<string, number>;
    hourlyFocus?: Record<number, number>; // 0-23, avg concentration per hour
    focusStability?: "stable" | "unstable" | "highly_variable";
    peakFocusHour?: number;
    weeklyTrend?: "improving" | "stable" | "declining";
    bestDay?: string; // "Monday", "Tuesday", etc.
    insights?: string[];
    recommendations?: string[];
  };
  /** Individual face tracking sessions for detailed analytics. */
  focusSessions?: FocusSession[];
}

/** A single face tracking session with aggregated metrics. */
export interface FocusSession {
  id: string;
  taskId?: string;
  taskTitle?: string;
  subject?: string;
  startTime: string; // ISO timestamp
  endTime: string; // ISO timestamp
  duration: number; // minutes
  
  // Aggregated metrics
  avgConcentration: number; // 0-100
  avgMovement: number; // 0-100
  avgBlinkRate: number; // blinks per minute
  gazeOnScreenPct: number; // percentage of time looking at screen
  avgHeadYaw: number; // degrees
  avgHeadPitch: number; // degrees
  avgHeadRoll: number; // degrees
  
  // Focus stability (how much it fluctuated)
  concentrationVariance: number;
  focusStability: "stable" | "unstable" | "highly_variable";
  
  // Task correlation
  taskCompleted: boolean;
  taskDifficulty?: "easy" | "medium" | "hard";
  
  // Session quality
  quality: "excellent" | "good" | "fair" | "poor";
}
// Shared client+server id generator (used for grade entries) — Web Crypto's randomUUID is available in
// both a modern browser and Node, so this needs no server-only import to stay isomorphic.
function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export function emptyProfile(): Profile { return { about: "", preferences: [], people: [], projects: [], courses: [], sessions: [] }; }

/** Self-heals an already-duplicated grade history on every normalize — a Pronote sync is meant to keep ONE
 *  live row per subject (see applyPronoteGrades, server/pronote.ts), but a bug there used to generate a
 *  fresh random id whenever a sync ran against a profile copy that didn't already contain the prior day's
 *  row, so two different ids for the same subject never collapsed and just kept accumulating — reported
 *  live as "Anglais · 40 grades" after roughly 40 days of daily syncs. That's fixed at the SOURCE now
 *  (deterministic id) and at MERGE time (mergeProfileStates, server/tasks.ts) — this is the third layer,
 *  cleaning up whatever's already stored so an already-affected account self-heals on its very next load
 *  rather than waiting on a fresh cross-device merge to happen to fix it. Keeps only the newest Pronote row
 *  per subject; manual entries are untouched (those are genuinely separate historical data points). */
function dedupePronoteGrades<T extends { id: string; subject: string; grade: number; scale: number; updatedAt: string; source?: "pronote" | "manual" }>(grades: T[]): T[] {
  const newestPronote = new Map<string, T>();
  const manual: T[] = [];
  for (const g of grades) {
    if (g.source !== "pronote") { manual.push(g); continue; }
    const key = g.subject.toLowerCase();
    const prev = newestPronote.get(key);
    if (!prev || Date.parse(g.updatedAt) >= Date.parse(prev.updatedAt)) newestPronote.set(key, g);
  }
  return [...manual, ...newestPronote.values()];
}
/** Same-topic milestones extracted from different journal entries over the term shouldn't pile up as
 *  separate rows (e.g. "grasped the chain rule" logged three different weeks in slightly different words) —
 *  key on subject+topic (case-insensitive), keep the OLDEST achievedAt (that's when it was actually first
 *  reached) but the newest label wording (closer to how the student described it most recently). */
type MilestoneEntry = { id: string; subject: string; topic: string; label: string; achievedAt: string };
function dedupeMilestones(list: MilestoneEntry[]): MilestoneEntry[] {
  const byKey = new Map<string, MilestoneEntry>();
  for (const m of list) {
    const key = `${m.subject.toLowerCase()}::${m.topic.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, m); continue; }
    byKey.set(key, { ...m, achievedAt: Date.parse(prev.achievedAt) <= Date.parse(m.achievedAt) ? prev.achievedAt : m.achievedAt });
  }
  return [...byKey.values()];
}
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
    // NOT deduped like the other fact lists — each entry is a snapshot of ONE session, not a restated
    // standing fact, so two genuinely different sessions that happen to read similarly (sameFact is fuzzy)
    // must not collapse into one. Capped here instead, newest last so a simple .slice(-N) keeps recency.
    sessions: arr(p?.sessions).slice(-30),
    unlimited: !!p?.unlimited,
    paused: !!p?.paused,
    pausedAt: typeof p?.pausedAt === "string" ? p.pausedAt : undefined,
    lastSweepAt: typeof p?.lastSweepAt === "string" ? p.lastSweepAt : undefined,
    lastForcedAt: typeof p?.lastForcedAt === "string" ? p.lastForcedAt : undefined,
    lastSupplementarySweepAt: typeof p?.lastSupplementarySweepAt === "string" ? p.lastSupplementarySweepAt : undefined,
    activityHours: Array.isArray(p?.activityHours) && p.activityHours.length === 24
      ? p.activityHours.map((n: unknown) => Math.max(0, Number(n) || 0))
      : undefined,
    activityWeekdayHours: Array.isArray(p?.activityWeekdayHours) && p.activityWeekdayHours.length === 168
      ? p.activityWeekdayHours.map((n: unknown) => Math.max(0, Number(n) || 0))
      : undefined,
    activityDecayedAt: typeof p?.activityDecayedAt === "string" ? p.activityDecayedAt : undefined,
    autoRunDay: typeof p?.autoRunDay === "string" ? p.autoRunDay : undefined,
    autoRunCount: Number.isFinite(Number(p?.autoRunCount)) ? Math.max(0, Math.round(Number(p.autoRunCount))) : undefined,
    reviewSetsDay: typeof p?.reviewSetsDay === "string" ? p.reviewSetsDay : undefined,
    // Clamped to MAX_DUE_SETS_PER_DAY — every real write already respects this (the route only ever admits
    // up to the cap), so this only ever bites a hand-edited/replayed /api/account/import file trying to
    // plant more admitted decks than the app itself would ever persist.
    reviewSetDeckIds: Array.isArray(p?.reviewSetDeckIds) ? arr(p.reviewSetDeckIds).slice(0, MAX_DUE_SETS_PER_DAY) : undefined,
    reviewSetsUpdatedAt: typeof p?.reviewSetsUpdatedAt === "string" ? p.reviewSetsUpdatedAt : undefined,
    genPerDay: Number.isFinite(Number(p?.genPerDay)) ? Math.min(4, Math.max(1, Math.round(Number(p.genPerDay)))) : undefined,
    timezone: typeof p?.timezone === "string" && isValidTz(p.timezone) ? p.timezone : undefined,
    // Structured preferences
    responseStyle: ["concise", "detailed", "casual", "formal"].includes(p?.responseStyle) ? p.responseStyle : undefined,
    uiDensity: ["cozy", "compact", "spacious"].includes(p?.uiDensity) ? p.uiDensity : undefined,
    customTheme: p?.customTheme ? (Object.keys(validateThemeTokens(p.customTheme)).length ? validateThemeTokens(p.customTheme) : undefined) : undefined,
    autoApprove: Array.isArray(p?.autoApprove) ? p.autoApprove.map(String) : undefined,
    highPriorityPeople: Array.isArray(p?.highPriorityPeople) ? p.highPriorityPeople.map(String) : undefined,
    autoArchivePatterns: Array.isArray(p?.autoArchivePatterns) ? p.autoArchivePatterns.map(String) : undefined,
    usage: p?.usage && typeof p.usage === "object" ? {
      in: Number(p.usage.in) || 0, out: Number(p.usage.out) || 0, runs: Number(p.usage.runs) || 0,
      since: typeof p.usage.since === "string" ? p.usage.since : new Date().toISOString(),
      monthKey: typeof p.usage.monthKey === "string" ? p.usage.monthKey : undefined,
      monthIn: Number(p.usage.monthIn) || 0, monthOut: Number(p.usage.monthOut) || 0,
      monthCost: Number(p.usage.monthCost) || 0,
      // Was missing entirely here — normalizeProfile runs on every load, so the per-category cost breakdown
      // (see addUsage below) was being silently wiped on every single load even though the total (monthCost)
      // survived right above it. That's why Settings could show "≈ $0.80 of $3.00" with an empty breakdown
      // underneath: the categorized data never made it past the very next normalize.
      monthByCategory: p.usage.monthByCategory && typeof p.usage.monthByCategory === "object"
        ? Object.fromEntries(Object.entries(p.usage.monthByCategory).filter(([, v]) => typeof v === "number" && Number.isFinite(v)))
        : undefined,
    } : undefined,
    primaryAccounts: p?.primaryAccounts && typeof p.primaryAccounts === "object"
      ? Object.fromEntries(Object.entries(p.primaryAccounts).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined,
    language: p?.language === "en" ? "en" : "fr",
    languageSetAt: typeof p?.languageSetAt === "string" ? p.languageSetAt : undefined,
    preferencesUpdatedAt: typeof p?.preferencesUpdatedAt === "string" ? p.preferencesUpdatedAt : undefined,
    grades: Array.isArray(p?.grades)
      ? dedupePronoteGrades(p.grades.map((g: any) => ({
          id: typeof g?.id === "string" && g.id ? g.id : newId(),
          subject: String(g?.subject || "").trim().slice(0, 60),
          grade: Number(g?.grade) || 0,
          scale: Number(g?.scale) > 0 ? Number(g.scale) : 20,
          updatedAt: typeof g?.updatedAt === "string" ? g.updatedAt : new Date().toISOString(),
          source: g?.source === "pronote" ? "pronote" as const : "manual" as const,
        })).filter((g: { subject: string }) => g.subject)).slice(0, 200)
      : undefined,
    manualExams: Array.isArray(p?.manualExams)
      ? p.manualExams.map((e: any) => ({
          id: typeof e?.id === "string" && e.id ? e.id : newId(),
          subject: String(e?.subject || "").trim().slice(0, 60),
          deadline: typeof e?.deadline === "string" ? e.deadline : "",
        })).filter((e: { subject: string; deadline: string }) => e.subject && e.deadline).slice(0, 100)
      : undefined,
    coursework: normalizeCoursework(p?.coursework),
    onboardedAt: typeof p?.onboardedAt === "string" ? p.onboardedAt : undefined,
    toursSeen: Array.isArray(p?.toursSeen) ? [...new Set<string>(p.toursSeen.map((t: any) => String(t).slice(0, 40)).filter(Boolean))].slice(0, 40) : undefined,
    subjects: Array.isArray(p?.subjects) ? [...new Set<string>(p.subjects.map((t: any) => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, 14) : undefined,
    errorLog: Array.isArray(p?.errorLog)
      ? p.errorLog.map((e: any) => ({
          id: typeof e?.id === "string" && e.id ? e.id : newId(),
          subject: String(e?.subject || "").trim().slice(0, 60),
          question: String(e?.question || "").trim().slice(0, 500),
          mistake: String(e?.mistake || "").trim().slice(0, 500),
          fix: String(e?.fix || "").trim().slice(0, 500),
          createdAt: typeof e?.createdAt === "string" ? e.createdAt : new Date().toISOString(),
        })).filter((e: { subject: string; question: string }) => e.subject && e.question).slice(0, 500)
      : undefined,
    studentModel: p?.studentModel && typeof p.studentModel === "object" && typeof p.studentModel.summary === "string" && p.studentModel.summary.trim()
      ? {
          summary: p.studentModel.summary.trim().slice(0, 2000), // ~150-300 words expected; hard ceiling is defense in depth
          updatedAt: typeof p.studentModel.updatedAt === "string" ? p.studentModel.updatedAt : new Date().toISOString(),
          basedOnActivityAt: typeof p.studentModel.basedOnActivityAt === "string" ? p.studentModel.basedOnActivityAt : undefined,
        }
      : undefined,
    milestones: Array.isArray(p?.milestones)
      ? dedupeMilestones(p.milestones.map((m: any) => ({
          id: typeof m?.id === "string" && m.id ? m.id : newId(),
          subject: String(m?.subject || "").trim().slice(0, 60),
          topic: String(m?.topic || "").trim().slice(0, 80),
          label: String(m?.label || "").trim().slice(0, 200),
          achievedAt: typeof m?.achievedAt === "string" ? m.achievedAt : new Date().toISOString(),
        })).filter((m: MilestoneEntry) => m.subject && m.topic && m.label)).slice(0, 300)
      : undefined,
    lastTutorActivityAt: typeof p?.lastTutorActivityAt === "string" ? p.lastTutorActivityAt : undefined,
    track: ["ib", "ap", "bac", "other"].includes(p?.track) ? p.track : undefined,
    yearLevel: typeof p?.yearLevel === "string" ? p.yearLevel.trim().slice(0, 40) || undefined : undefined,
    learningStyle: ["visual", "auditory", "reading", "kinesthetic", "mixed"].includes(p?.learningStyle) ? p.learningStyle : undefined,
    hintDensity: ["steps", "hints", "balanced"].includes(p?.hintDensity) ? p.hintDensity : undefined,
    focusStats: p?.focusStats && typeof p.focusStats === "object" ? {
      totalTrackedSessions: Number(p.focusStats.totalTrackedSessions) || 0,
      avgConcentration: Math.min(100, Math.max(0, Number(p.focusStats.avgConcentration) || 0)),
      avgGazeOnScreenPct: Math.min(100, Math.max(0, Number(p.focusStats.avgGazeOnScreenPct) || 0)),
      avgBlinkRate: Math.max(0, Number(p.focusStats.avgBlinkRate) || 0),
      restlessPct: Math.min(100, Math.max(0, Number(p.focusStats.restlessPct) || 0)),
      subjectFocus: p.focusStats.subjectFocus && typeof p.focusStats.subjectFocus === "object"
        ? (Object.fromEntries(Object.entries(p.focusStats.subjectFocus).filter(([, v]) => typeof v === "number")) as Record<string, number>)
        : undefined,
    } : undefined,
    // The adaptive-agent fields (agentTypes.ts) were being silently DROPPED on every normalize cycle —
    // this function builds a brand-new object from an explicit whitelist, so anything not listed here
    // vanishes the next time a profile round-trips through loadState (server/store.ts calls
    // normalizeProfile on every load). That's exactly how server/sessionState.ts/server/actionSpace.ts's
    // writes would have been quietly undone. Deep validation of conceptModel/conceptGraph belongs to their
    // own server-side normalizers (normalizeStudentModel/normalizeConceptGraph) — this file can't import
    // those (shared/types.ts is also the client bundle), so this is a shallow, defensive pass-through:
    // keep it only if it's a plausibly-shaped object, let the server-side normalizers do the real work
    // once those are wired up (not yet, for these two — see the plan's "explicitly deferred" section).
    conceptModel: p?.conceptModel && typeof p.conceptModel === "object" && p.conceptModel.concepts && typeof p.conceptModel.concepts === "object" ? p.conceptModel : undefined,
    conceptGraph: p?.conceptGraph && typeof p.conceptGraph === "object" && p.conceptGraph.nodes && typeof p.conceptGraph.nodes === "object" ? p.conceptGraph : undefined,
    // Validated more concretely — these two are actively read/written every Tutor turn as of this change.
    tutorSessions: Array.isArray(p?.tutorSessions)
      ? p.tutorSessions.filter((s: any) => s && typeof s.taskId === "string" && typeof s.updatedAt === "string").slice(-SESSION_CAP)
      : undefined,
    tutorDecisions: Array.isArray(p?.tutorDecisions)
      ? p.tutorDecisions.filter((d: any) => d && typeof d.at === "string" && typeof d.action === "string" && typeof d.why === "string").slice(-40)
      : undefined,
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

/** Group the error log by subject, newest entry first within each subject, subjects with the MOST entries
 *  first (that's the subject the mistakes are piling up in — the one to actually review before an exam). */
export interface SubjectErrorLog { subject: string; entries: NonNullable<Profile["errorLog"]>; }
export function errorLogBySubject(log: NonNullable<Profile["errorLog"]> | undefined): SubjectErrorLog[] {
  const map = new Map<string, NonNullable<Profile["errorLog"]>>();
  for (const e of log || []) {
    const key = e.subject.toLowerCase();
    (map.get(key) || map.set(key, []).get(key)!).push(e);
  }
  return [...map.values()].map((entries) => ({
    subject: entries[0].subject,
    entries: [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  })).sort((a, b) => b.entries.length - a.entries.length);
}

/** Group milestones by subject, most-recently-achieved topic first within each subject, subject with the
 *  most milestones first — same "most-progress-first" ordering as errorLogBySubject's "most-mistakes-first"
 *  (mirrors it, but the opposite signal: this is what's GOING well). */
export interface SubjectMilestones { subject: string; entries: NonNullable<Profile["milestones"]>; }
export function milestonesBySubject(list: NonNullable<Profile["milestones"]> | undefined): SubjectMilestones[] {
  const map = new Map<string, NonNullable<Profile["milestones"]>>();
  for (const m of list || []) {
    const key = m.subject.toLowerCase();
    (map.get(key) || map.set(key, []).get(key)!).push(m);
  }
  return [...map.values()].map((entries) => ({
    subject: entries[0].subject,
    entries: [...entries].sort((a, b) => Date.parse(b.achievedAt) - Date.parse(a.achievedAt)),
  })).sort((a, b) => b.entries.length - a.entries.length);
}
// Tunable weights for subjectMastery below — a product-judgment placeholder, not a derived constant.
// Named/exported so they're trivially adjustable later without hunting through the formula itself.
export const MASTERY_LEITNER_WEIGHT = 0.6;
export const MASTERY_MILESTONE_WEIGHT = 0.4;
// Milestones older than this contribute ~nothing to the recency score (linear decay to 0) — an
// achievement from months ago says little about CURRENT mastery, unlike a flashcard's Leitner box
// (which already encodes recency via spaced-repetition scheduling).
const MASTERY_MILESTONE_DECAY_DAYS = 90;
// How many "fresh" (near-zero-decay) milestones it takes to max out the milestone half of the score —
// a single recent "got it" shouldn't alone read as full subject mastery.
const MASTERY_MILESTONES_FOR_FULL_SCORE = 3;
/** Direct request: "clear progress metrics" per subject, based purely on tutor-session activity — NOT
 *  grades (explicitly excluded: grades are Pronote/manual-sourced and lag real activity, unrelated to
 *  what the tutor has actually seen the student do). Combines two EXISTING signals, no new tracked
 *  state: (1) the Leitner "known" ratio across that subject's flashcards (shared/types.ts's own
 *  nextLeitnerReview box field, already written on every card review) and (2) a recency-weighted count
 *  of that subject's milestones (milestonesBySubject above — qualitative "what's clicked" log).
 *  Returns null (never a fabricated 0%) when NEITHER signal has any data for this subject — a subject
 *  never touched via Otto's tutor/flashcards shouldn't claim "0% mastery", that's just "no data yet".
 *  Gracefully degrades to whichever single signal IS available when only one exists, renormalizing the
 *  weight instead of silently treating the missing one as 0. */
export function subjectMastery(tasks: WebTask[], milestones: Profile["milestones"] | undefined, subject: string, now: Date = new Date()): number | null {
  const subjectKey = subject.toLowerCase();
  let totalCards = 0;
  let knownCards = 0;
  for (const t of tasks) {
    if ((t.sourceSubject || "").toLowerCase() !== subjectKey) continue;
    for (const deck of t.flashcards || []) {
      for (const card of deck?.cards || []) {
        if (card.notNeeded) continue; // excluded from every other "still shaky"/scoring signal too
        totalCards++;
        if (card.review?.box === 2) knownCards++;
      }
    }
  }
  const leitnerRatio = totalCards > 0 ? knownCards / totalCards : null;

  const subjectEntries = (milestones || []).filter((m) => String(m?.subject || "").toLowerCase() === subjectKey);
  let milestoneWeight = 0;
  for (const m of subjectEntries) {
    const daysAgo = (now.getTime() - Date.parse(m.achievedAt)) / 86_400_000;
    milestoneWeight += Math.max(0, 1 - daysAgo / MASTERY_MILESTONE_DECAY_DAYS);
  }
  const milestoneScore = subjectEntries.length > 0 ? Math.min(1, milestoneWeight / MASTERY_MILESTONES_FOR_FULL_SCORE) : null;

  if (leitnerRatio === null && milestoneScore === null) return null;
  if (leitnerRatio === null) return milestoneScore;
  if (milestoneScore === null) return leitnerRatio;
  return MASTERY_LEITNER_WEIGHT * leitnerRatio + MASTERY_MILESTONE_WEIGHT * milestoneScore;
}

/** Is this a resolvable IANA timezone? (Intl throws on an unknown zone.) */
export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** The user's timezone for all "local day" math — their captured zone, else UTC. */
export function tzOf(profile?: Profile | null): string {
  return profile?.timezone || "UTC";
}

/** The LOCAL hour (0-23) `now` falls in, in the given timezone — no library, matches the Intl-based local-
 *  day math elsewhere in this file (localDay in server/jobs.ts uses the same approach). */
function localHourOf(tz: string, now: Date): number {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)) % 24; }
  catch { return now.getUTCHours(); }
}
/** The LOCAL weekday (0=Sunday..6=Saturday, matching Date#getDay) `now` falls in, in the given timezone. */
function localWeekdayOf(tz: string, now: Date): number {
  try {
    const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
  } catch { return now.getUTCDay(); }
}
const ACTIVITY_DECAY_INTERVAL_MS = 30 * 86_400_000;

/** Record one genuine engagement (a task action, a chat message, a flashcard review, a journal save, a
 *  study session) against the student's own local hour-of-day (and weekday×hour cell — see
 *  activityWeekdayHours). Mutates in place, same posture as addUsage — called from wherever real engagement
 *  already happens, never a new tracked event of its own. Pure/no I/O by design (like everything else in
 *  this file); persistence is just "this profile gets saved" like any other profile field. Periodically
 *  halves both grids (see ACTIVITY_DECAY_INTERVAL_MS) so old habits fade rather than accumulating forever —
 *  the cheap approximation of recency-weighting for a running counter that has no per-event timestamps. */
export function bumpActivityHour(profile: Profile, now: Date = new Date(), subject?: string): void {
  let hours = profile.activityHours?.length === 24 ? [...profile.activityHours] : new Array(24).fill(0);
  let grid = profile.activityWeekdayHours?.length === 168 ? [...profile.activityWeekdayHours] : new Array(168).fill(0);
  const lastDecay = Date.parse(profile.activityDecayedAt || "") || 0;
  if (lastDecay && now.getTime() - lastDecay >= ACTIVITY_DECAY_INTERVAL_MS) {
    hours = hours.map((n) => n / 2);
    grid = grid.map((n) => n / 2);
    profile.activityDecayedAt = now.toISOString();
  } else if (!lastDecay) {
    profile.activityDecayedAt = now.toISOString();
  }
  const tz = tzOf(profile);
  const h = localHourOf(tz, now);
  const wd = localWeekdayOf(tz, now);
  hours[h] = (hours[h] || 0) + 1;
  grid[wd * 24 + h] = (grid[wd * 24 + h] || 0) + 1;
  profile.activityHours = hours;
  profile.activityWeekdayHours = grid;
  if (subject) bumpSubjectActivityHour(profile, subject, now, h);
}

/** Cap on how many subjects get their own tracked activity histogram (see Profile.subjectActivityHours's own
 *  comment for why this exists) — small enough to bound profile size, big enough to cover a real course load. */
const SUBJECT_ACTIVITY_CAP = 6;
function bumpSubjectActivityHour(profile: Profile, subject: string, now: Date, hour: number): void {
  const map = { ...(profile.subjectActivityHours || {}) };
  let entry = map[subject];
  if (!entry) {
    if (Object.keys(map).length >= SUBJECT_ACTIVITY_CAP) {
      // Evict the least-active tracked subject to make room — "recent/frequent wins", same posture as decay.
      let weakest: string | null = null, weakestTotal = Infinity;
      for (const [subj, e] of Object.entries(map)) {
        const total = e.hours.reduce((s, n) => s + (n || 0), 0);
        if (total < weakestTotal) { weakest = subj; weakestTotal = total; }
      }
      if (weakest) delete map[weakest];
    }
    entry = { hours: new Array(24).fill(0) };
  } else {
    entry = { hours: [...entry.hours], decayedAt: entry.decayedAt };
  }
  const lastDecay = Date.parse(entry.decayedAt || "") || 0;
  if (lastDecay && now.getTime() - lastDecay >= ACTIVITY_DECAY_INTERVAL_MS) {
    entry.hours = entry.hours.map((n) => n / 2);
    entry.decayedAt = now.toISOString();
  } else if (!lastDecay) {
    entry.decayedAt = now.toISOString();
  }
  entry.hours[hour] = (entry.hours[hour] || 0) + 1;
  map[subject] = entry;
  profile.subjectActivityHours = map;
}

/** Same cold-start-gated "most active hour" read as learnedProductiveHour, scoped to one subject's own
 *  histogram — null when that subject isn't tracked yet or doesn't have enough evidence. `minTotal` is lower
 *  than the global 20 since a single subject naturally accumulates slower than overall activity. */
export function learnedProductiveHourForSubject(profile: Profile | undefined, subject: string, minTotal = 12): { hour: number; confidence: number } | null {
  const hours = profile?.subjectActivityHours?.[subject]?.hours;
  if (!hours || hours.length !== 24) return null;
  const total = hours.reduce((s, n) => s + (n || 0), 0);
  if (total < minTotal) return null;
  let best = 0;
  for (let i = 1; i < 24; i++) if ((hours[i] || 0) > (hours[best] || 0)) best = i;
  const share = (hours[best] || 0) / total;
  const evidenceFactor = Math.min(1, total / 60);
  return { hour: best, confidence: Math.max(0, Math.min(1, share * evidenceFactor)) };
}

/** This student's own learned "most active" local hour, or null when there isn't enough history to trust
 *  yet (cold start must fall back to a fixed default, never a confident guess off a handful of data points).
 *  `minTotal` is deliberately small (20) — engagement events are frequent enough (every task click, every
 *  chat turn) that a real pattern shows up well before a month of use. */
export function learnedProductiveHour(profile: Profile | undefined, minTotal = 20): number | null {
  const hours = profile?.activityHours;
  if (!hours || hours.length !== 24) return null;
  const total = hours.reduce((s, n) => s + (n || 0), 0);
  if (total < minTotal) return null;
  let best = 0;
  for (let h = 1; h < 24; h++) if ((hours[h] || 0) > (hours[best] || 0)) best = h;
  return best;
}

/** DeepSeek's peak-pricing windows (UTC): 01:00-04:00 and 06:00-10:00 — every billing item costs 2x during
 *  these hours. Background work that isn't blocking a user (an unattended sweep, an offline auto-run) should
 *  prefer to run outside them; anything the user is actively waiting on must still run immediately regardless
 *  of price — only the deferrable, autonomous paths consult this.
 *  Effective 2026-08-23 00:00 Beijing time, DeepSeek made weekends (Sat/Sun, Beijing time) off-peak ALL DAY —
 *  the hourly windows below no longer apply on those two days. Beijing has no DST (fixed UTC+8), so this is
 *  a plain day-of-week check in that zone, not a UTC-hour range like the weekday windows. */
export function isPeakHourUtc(now: Date = new Date()): boolean {
  let beijingDay: number;
  try { beijingDay = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getDay(); }
  catch { beijingDay = now.getUTCDay(); }
  if (beijingDay === 0 || beijingDay === 6) return false; // Sunday/Saturday in Beijing — off-peak all day
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** The current calendar month key ("YYYY-MM") in a given timezone — the monthly cap's rollover boundary. */
export function monthKeyOf(tz?: string, now: Date = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit" }).format(now); }
  catch { return now.toISOString().slice(0, 7); }
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
/** The monthly AI budget (USD). Override with MONTHLY_AI_BUDGET_USD (server-side); default effectively unlimited. */
export function monthlyBudgetUsd(): number {
  const raw = typeof process !== "undefined" ? Number(process.env?.MONTHLY_AI_BUDGET_USD) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : 999999;
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
// What kind of AI call spent the money — lets Settings answer "what's actually costing money" instead of
// just a single opaque total. Deliberately a small, fixed set (not a free-text label) so it stays a real
// breakdown a person can scan, not a growing pile of one-off strings.
export type AddUsageCategory = "sweep" | "autorun" | "chat" | "manual_refine" | "studylog" | "student_model" | "other";

export function addUsage(profile: Profile, tokens?: { in?: number; out?: number; cachedIn?: number } | null, category: AddUsageCategory = "other"): void {
  const tin = Number(tokens?.in) || 0, tout = Number(tokens?.out) || 0, cached = Number(tokens?.cachedIn) || 0;
  if (!tin && !tout) return;
  const u = profile.usage || { in: 0, out: 0, runs: 0, since: new Date().toISOString() };
  const mk = monthKeyOf(tzOf(profile));
  const sameMonth = u.monthKey === mk;
  // Meter the TRUE cost of this call now — cache breakdown and peak multiplier can't be recovered later.
  const cost = callCostUsd(tin, tout, cached);
  const priorByCategory = sameMonth ? (u.monthByCategory || {}) : {};
  profile.usage = {
    in: u.in + tin, out: u.out + tout, runs: u.runs + 1, since: u.since,
    monthKey: mk,
    monthIn: (sameMonth ? (u.monthIn || 0) : 0) + tin,
    monthOut: (sameMonth ? (u.monthOut || 0) : 0) + tout,
    monthCost: (sameMonth ? (u.monthCost || 0) : 0) + cost,
    monthByCategory: { ...priorByCategory, [category]: (priorByCategory[category] || 0) + cost },
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
// Accent-stripped keys, so "février"/"fevrier" and "août"/"aout" both hit.
const RANK_MONTHS: Record<string, number> = {
  jan: 0, january: 0, janvier: 0, feb: 1, february: 1, fevrier: 1, fev: 1, mar: 2, march: 2, mars: 2,
  apr: 3, april: 3, avril: 3, avr: 3, may: 4, mai: 4, jun: 5, june: 5, juin: 5, jul: 6, july: 6, juillet: 6, juil: 6,
  aug: 7, august: 7, aout: 7, sep: 8, sept: 8, september: 8, septembre: 8, oct: 9, october: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10, dec: 11, december: 11, decembre: 11,
};
// No bare "mar" here — it's March in English, and "mar." for mardi is rare enough not to be worth the clash.
const RANK_WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, dimanche: 0, mon: 1, monday: 1, lundi: 1, tue: 2, tues: 2, tuesday: 2, mardi: 2,
  wed: 3, wednesday: 3, mercredi: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, jeudi: 4,
  fri: 5, friday: 5, vendredi: 5, sat: 6, saturday: 6, samedi: 6,
};
const MONTH_ALT = Object.keys(RANK_MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_ALT = Object.keys(RANK_WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th|er)?\\b(?:,?\\s+(20\\d{2}))?`);
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${MONTH_ALT})\\.?(?:\\s+(20\\d{2}))?\\b`);
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_ALT})\\b`);
const DAY_MS = 864e5;

/** Calendar date at noon UTC — the same convention extractDateFromText (server/tasks.ts) uses, so the date
 *  lands on the right calendar day in every realistic timezone instead of rolling back a day west of UTC. */
function noonUtc(y: number, m: number, d: number): number { return Date.UTC(y, m, d, 12, 0, 0); }

/** A year-less month/day → this year's occurrence, unless that's more than ~2 months gone (then it's next
 *  year's). A homework "due Sep 20" read on Sep 27 is genuinely OVERDUE and must stay this year; a "Jan 15"
 *  read in November is next January, not ten months overdue. */
function inferYear(m: number, d: number, now: Date): number {
  const t = noonUtc(now.getUTCFullYear(), m, d);
  return t < now.getTime() - 60 * DAY_MS ? noonUtc(now.getUTCFullYear() + 1, m, d) : t;
}

/** Parse a task's free-text `when` into a sortable epoch — soonest first; unparseable/empty → +Infinity.
 *  `when` is often the MODEL's own free text ("Oct 9", "9 octobre", "vendredi", "demain", "09/10"), and a
 *  bare Date.parse gets nearly all of those wrong in Node: every year-less date ("Oct 9", "9 octobre")
 *  parses as year 2001 — so the task read as 25 years overdue and pinned to max urgency — while weekday
 *  names and "tomorrow"/"demain" parse as NaN and got no deadline at all. French numeric "09/10" (9 Oct)
 *  was read US-style as Sep 10. This is the ONE parser every deadline consumer should go through. */
export function deadlineEpoch(when: string | undefined, now: Date = new Date()): number {
  const raw = String(when || "").trim();
  if (!raw) return Infinity;
  // Real ISO timestamps (Pronote's own dates, estimateWhen's output) are unambiguous — trust them as-is.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) { const iso = Date.parse(raw); return Number.isNaN(iso) ? Infinity : iso; }
  const s = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  if (/\bapres[- ]demain\b|\bday after tomorrow\b/.test(s)) return now.getTime() + 2 * DAY_MS;
  if (/\btomorrow\b|\bdemain\b/.test(s)) return now.getTime() + DAY_MS;
  if (/\btoday\b|\btonight\b|\bnow\b|\basap\b|\baujourd'?hui\b|\bce soir\b|\btout de suite\b/.test(s)) return now.getTime();
  const inDays = s.match(/\b(?:in|dans)\s+(\d{1,2})\s+(?:days?|jours?)\b/);
  if (inDays) return now.getTime() + Number(inDays[1]) * DAY_MS;
  if (/\bnext week\b|\bsemaine prochaine\b/.test(s)) return now.getTime() + 7 * DAY_MS;

  // Month + day, both orders, EN + FR, optional year: "Oct 9", "October 9th, 2026", "9 octobre", "le 9 oct."
  const md = s.match(MONTH_DAY_RE);
  const dm = md ? null : s.match(DAY_MONTH_RE);
  if (md || dm) {
    const month = RANK_MONTHS[(md ? md[1] : dm![2])];
    const day = Number(md ? md[2] : dm![1]);
    const year = md ? md[3] : dm![3];
    if (month !== undefined && day >= 1 && day <= 31) return year ? noonUtc(Number(year), month, day) : inferYear(month, day, now);
  }

  // Numeric dates, European day-first (this is a French-first app: "09/10" is 9 October). Only swapped to
  // month-first when the second number can't be a month (> 12), i.e. the string is unambiguously US-style.
  // Slash only — a dotted "10.30" is far more often a time than a date.
  const num = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) {
    let day = Number(num[1]), month = Number(num[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const y = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : undefined;
      return y ? noonUtc(y, month - 1, day) : inferYear(month - 1, day, now);
    }
  }

  // A weekday name → its NEXT occurrence (today if it IS that weekday, a week out if "next"/"prochain").
  const wd = s.match(WEEKDAY_RE);
  if (wd) {
    const target = RANK_WEEKDAYS[wd[1]];
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead === 0 && /\bnext\b|\bprochain/.test(s)) ahead = 7;
    return now.getTime() + ahead * DAY_MS;
  }

  if (/\b20\d{2}\b/.test(s)) { const p = Date.parse(raw); if (!Number.isNaN(p)) return p; }
  return Infinity;
}

/** Normalize a model-written `when` to an ISO timestamp at ingestion, so every downstream consumer (client
 *  date labels, workload, raw Date.parse callers) sees a real date instead of re-parsing free text. An
 *  already-ISO value is kept VERBATIM. Unparseable text ("soon", "avant les vacances") returns undefined —
 *  callers treat that as "no stated deadline" and fall through to their own estimate, rather than storing
 *  a string nothing downstream can read (which silently exempted the task from the urgency curve). */
export function normalizeWhen(when: string | undefined, now: Date = new Date()): string | undefined {
  const raw = String(when || "").trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && !Number.isNaN(Date.parse(raw))) return raw;
  const ms = deadlineEpoch(raw, now);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Rank a task list by the Eisenhower matrix with meaningful tie-breaks, so order within a priority level
 * isn't arbitrary. Precedence: (1) Eisenhower `score` (do > schedule > delegate > later — the dominant
 * term), (2) soonest real deadline, (3) a high-priority person is involved, (4) freshest. Pure and
 * deterministic — used by BOTH the server ordering and the client list, so the sort is identical
 * everywhere. It reorders; it changes NO layout.
 */
export function sortWithinQuadrant<T extends { score: number; when?: string; whenApprox?: boolean; sourceDue?: string; source?: string; why?: string; title?: string; updatedAt?: string; createdAt?: string }>(
  list: T[], highPriorityPeople: string[] = [], now: Date = new Date(),
): T[] {
  // A REAL deadline (not one estimateWhen invented) within the next week — Pronote's own ISO date first.
  const realDue = (t: T): number => {
    if (t.whenApprox) return Infinity;
    const ms = t.sourceDue && !Number.isNaN(Date.parse(t.sourceDue)) ? Date.parse(t.sourceDue) : deadlineEpoch(t.when, now);
    return ms - now.getTime() <= 7 * DAY_MS ? ms : Infinity;
  };
  const vipTokens = highPriorityPeople.flatMap((v) => {
    const email = v.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const name = v.split(/[—\-(,]/)[0].trim().toLowerCase();
    return [email, name.length >= 3 ? name : undefined].filter((x): x is string => !!x);
  });
  const isVip = (t: T) => { const hay = `${t.why || ""} ${t.title || ""} ${t.source || ""}`.toLowerCase(); return vipTokens.some((tok) => hay.includes(tok)); };
  const fresh = (t: T) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  return [...list].sort((a, b) => {
    // Same quadrant → a real deadline in the next week that's at least a day sooner wins over a slightly
    // higher importance/urgency blend. Before this, deadline was only an exact-score tie-break, which almost
    // never fires on a continuous score — so a task due tomorrow could sit below one due in 6 days just
    // because the model rated the latter a touch more important. Quadrant still dominates everything.
    if (Math.floor(a.score) === Math.floor(b.score)) {
      const ra = realDue(a), rb = realDue(b);
      if ((Number.isFinite(ra) || Number.isFinite(rb)) && Math.abs(ra - rb) >= DAY_MS) return ra - rb;
    }
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;          // Eisenhower quadrant + weight
    const da = deadlineEpoch(a.when, now), db = deadlineEpoch(b.when, now);
    if (da !== db) return da - db;                                             // soonest deadline first
    const va = isVip(a) ? 1 : 0, vb = isVip(b) ? 1 : 0;
    if (va !== vb) return vb - va;                                             // high-priority person first
    return fresh(b) - fresh(a);                                                // freshest first
  });
}

/**
 * Structured task classification — drives the pipeline and pedagogical step structure.
 */
export type TaskType =
  | "learn_understand" | "review" | "practice" | "homework_problem_set"
  | "write" | "research" | "create" | "prepare_assessment" | "project"
  | "administrative"
  | "analyze" | "decide" | "logistics" | "maintain" | "problem_solve";

/** Information requirement before researching. */
export type InfoRequirement = "none" | "useful" | "required";

/** A concrete output Otto should create or the user should finish. */
export interface TaskOutput {
  id: string;
  kind: "brief" | "note" | "evidence_table" | "email" | "presentation" | "outline" | "essay" | "budget" | "schedule" | "itinerary" | "comparison" | "code" | "design" | "checklist" | "file" | "other";
  title: string;
  required: boolean;
  owner: "otto" | "user" | "shared";
  status: "planned" | "created" | "needs_review" | "approved" | "blocked";
  artifactId?: string;
}

/** Durable reasoning state shared by planning, execution, chat, and checkpoints. */
export interface TaskContext {
  objective: string;
  definitionOfDone: string;
  requirements: { text: string; importance: "required" | "useful" | "optional" }[];
  constraints: string[];
  unknowns: string[];
  ottoCanDo: string[];
  userMustDo: string[];
  research: "none" | "internal" | "external" | "mixed";
  outputs: TaskOutput[];
  currentState: "parsed" | "researched" | "planned" | "executing" | "blocked" | "complete";
}

/**
 * One step in "what's left" for a task. The agent classifies each: `automatable` means Weave can do it
 * itself (draft/doc/research/open a page); otherwise it's an act only you can take. `dependsOn` is the
 * index of a step that must be done first (so a dependent step waits, then can auto-run). `url` marks an
 * "open this page" step. `done`/`result` track completion.
 */
/** An artifact Otto creates as part of task preparation — something Otto produces, not a user step. */
export interface TaskArtifact {
  title: string;
  type: "note" | "flashcards" | "quiz" | "outline" | "checklist" | "reference" | "draft" | "summary" | "evidence_bank" | "other";
  status: "created" | "needed" | "not_needed";
  description?: string;
  artifactId?: string; // Link to the actual artifact (note, flashcard deck, etc.)
}

/** A separate task discovered during research — unrelated to the current objective. */
export interface SeparateTask {
  title: string;
  reason: string;
  urgency?: number;
  importance?: number;
  when?: string;
}

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
   *  The client shows it inline with `options` as tappable answers + a free-text input; answering runs the step.
   *  NOTE: Currently disabled - backend never sets this field. */
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
  /** NOTE: doneWhen, difficulty, checkpoint, and checkpointPassed are kept for type compatibility with
   * existing persisted data, but the AI no longer generates them for individual steps. These fields belong
   * on the main task's Definition of Done (task.goal), not on subtasks. The UI should NOT display these on subtasks. */
  doneWhen?: string;
  checkpoint?: string;
  difficulty?: "easy" | "medium" | "hard";
  checkpointPassed?: boolean;
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

  /** Structured task type derived from parsing (e.g. "research", "write", "logistics") */
  taskType?: TaskType;
  /** Universal goal → requirements → work → outputs planning state. */
  taskContext?: TaskContext;
  /** Tangible outputs required for completion, including Otto-created artifacts. */
  outputs?: TaskOutput[];
  /** Measurable definition of done / learning goal for this task.
   *  e.g. "Be able to recognize the major figures de style, explain their effect, and identify them in an unfamiliar French text." */
  goal?: string;
  /** Information requirement before research */
  infoRequirement?: InfoRequirement;
  /** Known gaps or unknowns needing clarification */
  unknowns?: string[];

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
  /** Daily study-log entry text (source:"studylog" only) — what the student typed for that day/week. Not
   *  a to-do; these tasks are filtered out of the normal dashboard (see App.tsx) and only shown in the
   *  Journal tab. Capped ~4000 chars. */
  logText?: string;
  /** Which day (or week) a studylog task is for — "2026-08-30" for a daily entry, "week:2026-08-24" (that
   *  week's MONDAY, prefixed) for the week summary — a simple, year-boundary-safe week key rather than a
   *  formal ISO "2026-W35" string. The lookup key for find-or-create, instead of parsing anchorKey. */
  logDate?: string;
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
    artifacts?: { kind: "note" | "deck" | "quiz" | "problem"; id: string; title: string }[];
    /** Sources Otto used or was given for this assistant turn. */
    sources?: { label: string; url?: string; detail?: string }[];
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
  /** In-app standalone practice problems created by the tutor mid-conversation — a SINGLE problem
   *  (MCQ or free-response) rendered INLINE in the chat bubble itself (not a chip), so the student
   *  answers right there in the thread and Otto helps them through it. Distinct from quizzes (a set of
   *  MCQs opened on the canvas) and from the daily journal's `practiceProblem` (one free-response per
   *  day): these are conversational, one-off, and live in the chat thread. */
  problems?: TaskProblem[];
  /** The persistent tutor Board (see BoardEntry) — always accessible from Study Mode's tools drawer, not
   *  something the student has to be shown a specific artifact chip to find. Append-only from Otto's side
   *  (WRITE_TO_BOARD tool); grows over the life of the task, across sessions, same as `chat`. */
  board?: BoardEntry[];
  /** The board EVENT STREAM (server/boardEvents.ts) — what HAPPENED on the board (wrote/erased/rewrote/
   *  answered), diffed turn over turn, distinct from `board` itself (the current state). Capped
   *  (BOARD_EVENT_CAP, shared/agentTypes.ts) — a session-scale trajectory signal, not an archive. Read by
   *  chatAboutTask to build the "what just happened" prompt block (boardTrajectoryBlock) so a self-
   *  correction or an erase-and-retry is visible as reasoning, not silently lost the next turn. */
  boardEvents?: BoardEventShape[];
  /** This session's learning objectives (SET_OBJECTIVES tool) — a short checklist Otto lays out once a
   *  topic is chosen (3-6 items) and updates `done` on as the student demonstrates each one, instead of the
   *  single free-text `focus` board entry. Client-local, same as chat/board/problems: replaced wholesale on
   *  each SET_OBJECTIVES call (not append-only), so the list always reflects Otto's current read of progress
   *  rather than accumulating stale/superseded objectives across a long session. */
  objectives?: TaskObjective[];
  /** Subject mastery (see subjectMastery below), 0-1 or null for "no data yet" — never fabricated. Set
   *  server-side only on /api/study/free (session start/resume), not on the hot, frequently-polled
   *  /api/tasks or kick routes, so this doesn't add per-poll CPU cost to paths that were just trimmed
   *  for egress. Computed fresh each time a session starts; not itself persisted/durable state. */
  mastery?: number | null;
  /** ONE free-response practice problem for the day's math/physics/science themes (Study Journal daily
   *  entries only — see generateDailyStudyCards in server/claude.ts) — deliberately NOT multiple choice:
   *  the student types their own answer and it's checked against `answer` (see practiceAnswerMatches
   *  below), which is what actually exercises DOING the calculation instead of recognizing it among
   *  options. Singular (not an array) — one genuinely worthwhile problem beats a padded list. */
  practiceProblem?: DailyPracticeProblem;
  /** Feynman-technique gap-check on the day's own written entry (Study Journal only — see checkFeynmanGap
   *  in server/claude.ts): does the student's own explanation actually hold together in plain words, or does
   *  it go vague/circular somewhere? Set only when a real gap was found (most entries clear this and leave
   *  it unset — quiet by default, never "could be more detailed" nagging). Cleared on the entry's next save
   *  since a rewritten entry needs a fresh check, not yesterday's flagged spot lingering. */
  feynmanGap?: string;
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
  /** Computed fresh on every GET /api/tasks (see stallNudgeLine in server/patterns.ts) — NEVER persisted,
   *  NEVER set by a mutation handler. A "spark" reframe to show INSTEAD of `why` when this task is already
   *  a single easy action that's sat untouched for days (a motivation problem, not a clarity one). Absent
   *  means "no override" — the client falls back to `why` as always. */
  nudgeLine?: string;
  /** Procrastination-latency signal for the personalization/bandit work (see server/bandit.ts): `shownAt`
   *  is stamped the first time this task is returned to the client in a "live" (not done/dismissed) state
   *  (GET /api/tasks), `firstActionAt` the first time the student actually acts on it (confirm, tick a
   *  step, or run one). Both write-once — never overwritten once set, so this stays "time of the FIRST
   *  exposure/action", not the most recent one. Collection only for now: nothing reads these yet beyond
   *  future analysis/a future bandit target on nudging/ordering strategy. */
  shownAt?: string;
  firstActionAt?: string;
  /** Which step-granularity bandit arm (server/bandit.ts's GRANULARITY_ARMS) generated THIS task's steps —
   *  set at run time, scored against shownAt->firstActionAt latency the first time the student acts on it
   *  (see stampFirstAction in server/index.ts). Undefined for tasks predating this or run before any arm
   *  was chosen — simply never scored, not treated as a failure. */
  granularityArmId?: string;
  /** Which dashboard-ordering bandit arm (server/bandit.ts's ORDERING_ARMS) was in effect the first time
   *  this task was shown — stamped alongside `shownAt`, scored alongside `granularityArmId` at the same
   *  stampFirstAction call site (server/index.ts) using the same procrastination-latency reward. */
  orderingArmId?: string;
}

export interface TaskNote {
  id: string;
  title: string;
  /** Markdown — rendered lightly client-side (headings, bold, bullets), never sent anywhere external. */
  body: string;
  createdAt: string;
}

// Leitner spacing schedule for flashcard review — simplified to TWO boxes (was five): box 1 = "Learning"
// (review again tomorrow), box 2 = "Known" (review again in a week). A 5-box scale was more precise but
// meant nothing to a student glancing at a card ("what does box 3 even mean?") — two boxes map onto a
// plain-language label (LEITNER_BOX_LABEL below) that's actually legible in the UI. Shared by client
// (optimistic update) and server (source of truth).
export const LEITNER_INTERVAL_DAYS = [1, 7];
export const LEITNER_BOX_LABEL = ["Learning", "Known"] as const;
// Cap on distinct flashcard decks surfaced per day by GET /api/reviews/due (server/index.ts) — see
// Profile.reviewSetDeckIds's own comment. Single source of truth (imported by server/index.ts) so
// normalizeProfile below can clamp to the SAME number: without that, a hand-edited /api/account/import
// file could plant more admitted-deck ids than the route itself would ever write, letting an imported
// profile show more than the intended daily dose after merge.
export const MAX_DUE_SETS_PER_DAY = 3;
export function nextLeitnerReview(prevBox: number | undefined, correct: boolean, now: Date = new Date()): { box: number; dueAt: string } {
  const box = correct ? Math.min(2, (prevBox || 0) + 1) : 1;
  const days = LEITNER_INTERVAL_DAYS[box - 1];
  return { box, dueAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

export interface TaskFlashcards {
  id: string;
  title: string;
  cards: {
    front: string; back: string;
    /** Per-card drill history. `box` (1-2, Leitner — see LEITNER_BOX_LABEL above) is now the ACTUAL spacing schedule FlashcardDeck writes
     *  on every review (see reviewCard in client/ui.tsx) — a correct review advances the box (and pushes
     *  `dueAt` further out per LEITNER_INTERVAL_DAYS), a miss resets to box 1. `ease`/`dueAt` were already
     *  here as SM-2 groundwork before any reviewer surfaced them; `dueAt` is now genuinely used (by `box`'s
     *  schedule, not a separate SM-2 ease calculation — `ease` stays unused groundwork for a future, more
     *  precise scheduler). `seen`/`correct` remain the raw "how am I doing on this deck" counts. */
    review?: { seen: number; correct: number; lastAt?: string; dueAt?: string; ease?: number; box?: number };
    /** The student marked this card "not something I need to learn" (outside their course/level) — as
     *  opposed to "wrong" (something they DO need and don't know yet). Excluded from scoring, due-review
     *  lists and every "still shaky" signal, and fed back into future deck generation as content to avoid
     *  (see notNeededFronts in server/tasks.ts / notNeededLine in server/claude.ts). */
    notNeeded?: boolean;
  }[];
  createdAt: string;
  lastReviewedAt?: string;
  /** Which bandit arm (server/bandit.ts's FLASHCARD_ARMS — "concise"/"standard"/"thorough") biased this
   *  deck's generation prompt, so a later deck's generation can score THIS deck's review outcomes (Leitner
   *  box movement) against the arm that produced it. Undefined for decks predating this — those are simply
   *  never scored, not treated as a failure. */
  styleArmId?: string;
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

/** A single free-response practice problem (math/physics/science) — the student types an answer instead of
 *  picking one, which is the whole point: recognizing the right option among 3-4 plausible ones is a much
 *  weaker test than actually producing the number/expression yourself. `format` tells the student what
 *  shape/units/notation the answer should be in (e.g. "two decimal places, in m/s", "as a fraction in
 *  lowest terms") and what symbols they can type for anything not on a plain keyboard (e.g. "type ^ for an
 *  exponent, sqrt(x) for a square root, x_1 for a subscript") — set BY the generator, since it knows what
 *  the answer actually looks like and what a student would need to type it. */
export interface DailyPracticeProblem {
  id: string;
  problem: string;
  answer: string;
  /** Guidance on expected format/units/notation AND which plain-text symbols to use for anything not on a
   *  standard keyboard — shown to the student BEFORE they answer, not part of grading itself. */
  format?: string;
  createdAt: string;
  /** Set once the student checks their answer — persisted so re-opening the day shows the outcome instead
   *  of re-asking, same spirit as a flashcard's review state. */
  attempt?: { answer: string; correct: boolean; at: string };
}

/** A single standalone practice problem created by the tutor mid-conversation — rendered INLINE in the
 *  chat bubble (not a chip that opens elsewhere). Can be multiple-choice (the student picks an option
 *  and gets immediate feedback) or free-response (the student types an answer and it's checked). Either
 *  way, Otto stays in the thread to help them work through it — this is a conversational exercise, not a
 *  scored quiz. Distinct from `TaskQuiz` (a set of MCQs opened on the canvas) and from the daily journal's
 *  `DailyPracticeProblem` (one free-response per day). */
export interface TaskProblem {
  id: string;
  /** Client-only, sent with chat turns: the student has already answered this one correctly. */
  solved?: boolean;
  /** The question/prompt itself — one clear sentence or a short problem statement. */
  question: string;
  /** MCQ mode: 2-4 options. When present, the student picks one and gets immediate feedback.
   *  When absent, it's free-response (the student types an answer and it's checked against `answer`). */
  options?: string[];
  /** MCQ mode: 0-based index into `options` of the correct one. */
  correct?: number;
  /** Free-response mode: the expected answer (checked loosely — trimmed, case-insensitive). */
  answer?: string;
  /** One-line explanation of why the answer is right — shown after the student answers, same teaching
   *  role as a quiz question's `why`. */
  why?: string;
  /** An optional hint shown on demand (a button the student can click before answering). */
  hint?: string;
  /** Guidance on expected format/units/notation for free-response mode (e.g. "two decimal places, in m/s"). */
  format?: string;
  /** Where the question comes from when it was adapted from a registered source (IB Documents, Revision Village,
   *  AP Central…) — shown as a link under the question. Absent for generated questions. */
  source?: { name: string; url: string };
  createdAt: string;
}

/** One entry Otto has written onto the persistent tutor Board (WRITE_TO_BOARD tool, server/claude.ts) — a
 *  general-purpose writable surface, NOT scoped to practice problems the way TaskProblem is. Otto can post
 *  to it at any point in a conversation (in or out of canvas mode — see chatAboutTask's opts.canvasMode):
 *  a formula, an instruction ("start working through part a"), a running summary of the student's
 *  reasoning, or a plain note — whatever's worth writing down rather than only saying in chat. Entries are
 *  append-only and rendered as a running log (client/study/artifacts/BoardArtifact.tsx), oldest first. */
/** One drawable primitive in an Otto-authored diagram (DRAW_ON_BOARD tool). Coordinates are in a fixed
 *  0-800 x 0-600 space so the model never has to reason about the container's actual pixel size — the
 *  renderer scales the viewBox to fit. */
export type DiagramOp =
  | { op: "line"; x1: number; y1: number; x2: number; y2: number; arrow?: boolean; dashed?: boolean; color?: string }
  | { op: "rect"; x: number; y: number; w: number; h: number; fill?: boolean; color?: string }
  | { op: "circle"; cx: number; cy: number; r: number; fill?: boolean; dashed?: boolean; color?: string }
  | { op: "polyline"; points: { x: number; y: number }[]; dashed?: boolean; color?: string }
  /** Closed shape (outline, optionally lightly filled). */
  | { op: "polygon"; points: { x: number; y: number }[]; fill?: boolean; color?: string }
  /** Circular arc about (cx,cy) from screen-angle a0 to a1 in degrees (y points DOWN, so counter-clockwise on screen is a1 < a0); sweeps the way from a0 to a1, may exceed 180°. */
  | { op: "arc"; cx: number; cy: number; r: number; a0: number; a1: number; dashed?: boolean; color?: string }
  | { op: "label"; x: number; y: number; text: string; size?: "sm" | "md" | "lg"; anchor?: "start" | "middle" }
  | { op: "axes"; x: number; y: number; w: number; h: number; xLabel?: string; yLabel?: string }
  /** Real typeset math (KaTeX), not the plain-text approximation formatMath (client/ui.tsx) does for chat.
   *  `latex` is raw LaTeX with no surrounding $/\( \) delimiters — e.g. "\\frac{2}{x-1} + \\frac{3}{x+2}". */
  | { op: "equation"; x: number; y: number; latex: string };

/** A function graph the tutor puts on the board (GRAPH_ON_BOARD). Expressions are plain math in x and the
 *  slider parameters ("a*x^2 + b*x + c", "sin(k x)"), compiled by shared/mathExpr.ts — never eval'd. */
export interface GraphSpec {
  /** "function" (default): curves y = f(x). "bars": a labelled bar chart. "histogram": raw numbers binned.
   *  "surface": a rotatable 3D surface z = f(x, y). */
  kind?: "function" | "bars" | "histogram" | "surface";
  bars?: { label: string; value: number }[];
  data?: number[];
  bins?: number;
  /** surface only: z as an expression in x, y (and the slider params); the x/y window is xmin..xmax × ymin..ymax. */
  z?: string;
  fns: { expr: string; label?: string; color?: "blue" | "red" | "green" | "orange" | "purple" | "ink"; dashed?: boolean }[];
  /** Up to 3 sliders the student can drag; each is a single-letter name usable in every expression. */
  params?: { name: string; min: number; max: number; value: number; step?: number; label?: string }[];
  xmin: number; xmax: number;
  ymin?: number; ymax?: number;
  /** Marked points (a root, a vertex, a data point); with `connect` they are joined into a line (a data plot). */
  points?: { x: number; y: number; label?: string }[];
  connect?: boolean;
  xLabel?: string; yLabel?: string;
}

export interface BoardEntry {
  id: string;
  /** Plain text/markdown-lite (renderChatText already handles this) — not restricted to any one format,
   *  since a formula, an instruction, and a summary all need different shapes. When kind === "diagram" this
   *  is still a one-line caption (not the figure itself — see `diagram` below), so the entry reads sensibly
   *  even before the SVG renders or if the ops fail validation. Same for kind === "outline": a one-line
   *  caption/title, with the actual structure in `outline` below. */
  text: string;
  /** Loose styling hint only, not a hard schema — lets the UI render a formula differently from an
   *  instruction without forcing Otto into a rigid structure for what's meant to be a free-form board.
   *  "focus" opens a session's document (today's arc), "definition" records a key term the first time it
   *  comes up, "insight" credits the STUDENT's own aha by name — together with formula/summary these make
   *  the board read like a document being built entry by entry, not a pile of disconnected notes. "diagram"
   *  is a real drawn figure (see `diagram`) rather than text/ASCII. "outline" is a headed, bulleted section
   *  (see `outline`) — for essay-based/humanities content (history causes, source analysis, an essay plan)
   *  where a flat sentence or a spatial diagram both fit poorly; math/science still reach for
   *  formula/diagram first. */
  kind?: "note" | "instruction" | "given" | "result" | "formula" | "summary" | "focus" | "insight" | "definition" | "diagram" | "outline" | "interactive" | "graph" | "gap" | "annotation";
  /** Who authored this entry — "otto" (default for backward compat) or "student". Student-owned entries are
   *  never silently rewritten by Otto. Used to visually distinguish Otto's scaffolding from the student's
   *  own work on the board (see BoardArtifact.tsx). */
  owner?: "otto" | "student";
  /** Present only when kind === "gap" — the answer the student is expected to fill in. The board renders this
   *  as an interactive blank the student must complete (the completion effect: doing the last step yourself
   *  is where the learning happens). Otto must NEVER reveal this value in chat while the gap is open. */
  expectedAnswer?: string;
  /** Present only when kind === "gap" — the SPECIFIC next move that line is asking for (2-6 words, written by
   *  Otto: "expand the bracket"). Shown as the chip under the line ("Your turn: expand the bracket") so a gap
   *  names what to DO instead of a generic "finish this". Never carries the value itself. */
  gapAction?: string;
  /** How a STUDENT-authored entry turned out — set by the app (never by the model), the moment the student
   *  answers on the board (see server/boardEvents.ts's tagStudentAnswer). Purely presentational: it lets the
   *  page keep a wrong attempt visible and struck through instead of either silently deleting it or letting
   *  it read as correct, which is §12's "a wrong turn is part of the trajectory" made visible. Otto's own
   *  entries never carry this — it is a record of the student's work, not a grade of Otto's. */
  status?: "correct" | "incorrect";
  /** The concept this entry is about, when the writer knew it — the join between the board and the persistent
   *  student model (server/studentModel.ts). Optional and loose: a board entry is not required to be about a
   *  named concept, and an unnamed one simply carries no evidence. */
  concept?: string;
  /** kind === "annotation": the board entry this note points at (highlight / circle a mistake / point to it), and how. */
  targetId?: string;
  tone?: "error" | "hint" | "good" | "focus";
  /** Present only when kind === "diagram" — the figure's shapes, rendered as SVG (BoardArtifact.tsx). Capped
   *  at 15 ops server-side (makeDiagramEntry, server/claude.ts): enough for a labeled triangle or a small
   *  graph, not enough to build a full illustration op-by-op. */
  diagram?: DiagramOp[];
  /** Present only when kind === "graph" (GRAPH_ON_BOARD) — a live, slider-driven function plot. */
  graph?: GraphSpec;
  /** Present only when kind === "outline" — one or more headed sections, each a short list of bullet
   *  points. Built for a history/essay-style board (causes-of-an-event, a source's key points, an essay's
   *  section-by-section plan) the same way `diagram` is built for a geometric figure: structure the model
   *  hands over typed, instead of hoping a numbered list survives inside a flat `text` string. Capped
   *  server-side (makeOutlineEntry) at 6 sections x 8 bullets — enough for a real essay plan, not a whole
   *  textbook chapter in one entry. */
  outline?: { heading: string; bullets: string[] }[];
  /** Present only when kind === "interactive" — sanitized, self-contained HTML/JS (CREATE_INTERACTIVE
   *  tool), rendered in a sandboxed iframe (BoardArtifact.tsx) with NO allow-same-origin: it cannot read
   *  this app's DOM/cookies/storage or navigate the parent. See makeInteractiveEntry (server/claude.ts)
   *  for the server-side script-source allowlist and tag-stripping that runs before this ever reaches
   *  the client. */
  html?: string;
  at: string;
}

/** One item on a session's learning-objectives checklist (SET_OBJECTIVES tool) — see WebTask.objectives. */
export interface TaskObjective {
  id: string;
  label: string;
  done: boolean;
}

// ── AI-personalized theme token validation ──────────────────────────────────────────────────���──────────
// Pure, no I/O — shared between server/claude.ts (validates the model's raw output before ever saving it)
// and this file's own normalizeProfile (re-validates on every load, so a value can never reach a stylesheet
// without surviving the SAME check twice). See generateThemeTokens's own doc comment in server/claude.ts for
// why this exists and what it deliberately can't do (no selectors, no URLs, no script — colors and bounded
// pixel radii only).
export const THEME_COLOR_KEYS = ["--bg", "--surface", "--bg-2"] as const;
// Widened by DEGREE, not by KIND (per the "next level, still bounded" plan) — --line is the hairline border
// color used throughout the app; still a plain hex color, still independently re-validated, just a second
// color role alongside backgrounds. Deliberately NOT --accent (the one-accent brand rule stays absolute —
// see validateThemeTokens's own contrast logic; nothing here ever lets a proposal touch it) and NOT
// --line-soft (an rgba() value in :root, a different format that would need its own parser to validate
// safely — not worth the added surface for one more subtle divider color).
export const THEME_BORDER_KEYS = ["--line"] as const;
export const THEME_RADIUS_KEYS = ["--radius", "--radius-sm", "--radius-xs"] as const;
export type ThemeTokens = Partial<Record<typeof THEME_COLOR_KEYS[number] | typeof THEME_BORDER_KEYS[number] | typeof THEME_RADIUS_KEYS[number], string>>;

/** Relative luminance (WCAG) of a hex color, for a contrast check against the app's fixed ink color — the
 *  model can propose a new background, but never gets to also change the text color, so a background this
 *  dark/saturated would make body text unreadable; reject it instead of shipping a broken theme. */
function relLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relLuminance(hex1) + 0.05, l2 = relLuminance(hex2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}
const THEME_INK_FIXED = "#101317"; // matches :root's --ink in client/styles.css — never itself overridable
const THEME_HEX_RE = /^#[0-9a-f]{6}$/i;

// ── Primer-specific types (Phase 1 foundation) ─────────────────────────────────────────────────────

/** Dependence metrics for anti-dependence system (Primer §6.9) */
export interface DependenceMetric {
  week: string;  // ISO week identifier
  domain: string;  // e.g., "reading", "math"
  helpRatio: number;  // hint requests / attempts (rising is a warning)
  answerSeekRate: number;  // "just tell me" style requests
  unaidedRate: number;  // success rate on fresh problems without hints
  fadeIndex: number;  // are hint levels needed trending down per skill?
}

/** Thinking-move statistics (Primer §6.1) */
export interface ThinkingStat {
  move: string;  // e.g., "notice", "wonder", "predict", "explain"
  nUsed: number;
  qualityAvg: number;  // 0-2 scale
  lastUsed: string;  // ISO timestamp
}

/** Calibration accuracy for metacognition (Primer §6.6) */
export interface CalibrationMetric {
  domain: string;
  bucket: string;  // confidence bucket: "a_little", "pretty", "very"
  n: number;
  accuracy: number;  // proportion of times confidence matched actual correctness
}

/** Consent record for parental/guardian consent (Primer §10.3) */
export interface ConsentRecord {
  childId: string;
  guardianId?: string;
  scope: string[];  // what data/features consent covers
  grantedAt: string;
  revokedAt?: string;
  method: "clickwrap" | "signature" | "other";
}
export function validateThemeTokens(raw: unknown): ThemeTokens {
  const out: ThemeTokens = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of THEME_COLOR_KEYS) {
    const v = (raw as any)[k];
    if (typeof v === "string" && THEME_HEX_RE.test(v) && contrastRatio(v, THEME_INK_FIXED) >= 4.5) (out as any)[k] = v.toLowerCase();
  }
  for (const k of THEME_BORDER_KEYS) {
    // A border only needs to be visibly distinct from the page, not pass BODY-TEXT contrast — 1.4:1 against
    // the fixed ink is enough to reject something that'd disappear entirely (e.g. near-white on near-white),
    // without forcing a hairline divider to be as dark as real text.
    const v = (raw as any)[k];
    if (typeof v === "string" && THEME_HEX_RE.test(v) && contrastRatio(v, THEME_INK_FIXED) >= 1.4) (out as any)[k] = v.toLowerCase();
  }
  for (const k of THEME_RADIUS_KEYS) {
    const v = (raw as any)[k];
    const m = typeof v === "string" ? /^(\d{1,2})px$/.exec(v) : null;
    if (m && Number(m[1]) >= 0 && Number(m[1]) <= 32) (out as any)[k] = `${m[1]}px`;
  }
  return out;
}

// Loose equality for a typed free-response answer against the stored correct one — NOT exact string
// equality, which would fail on trivial, meaningless differences (extra spaces, "3.0" vs "3", "X=4" vs "4").
// Two paths: if both sides parse as a real number, compare numerically (small epsilon for float noise);
// otherwise compare normalized text (trim, collapse whitespace, case-insensitive, strip a leading "x=" /
// "y=" echo of the variable being solved for, drop a trailing unit-less "." ). Deliberately NOT fuzzy beyond
// this — a genuinely wrong answer must still register as wrong, this only forgives formatting noise.
// Parses a plain decimal OR a simple "a/b" fraction (whole numbers on each side, e.g. "7/2", "-3/4") to its
// numeric value — NaN if neither shape matches. makePracticeProblem's own prompt (server/claude.ts) tells
// the student they may answer "as a decimal (or as a fraction if you prefer, written like 7/2)", but plain
// Number() has no idea what to do with "/" and returns NaN for it, so a numerically exact fraction answer
// ("7/2" for a correct answer of 3.5, or vice versa) was marked wrong outright — the format instructions
// promised something the checker never actually implemented.
// Math keyboards, autocorrect, and copy-paste from tools like Desmos/Wolfram Alpha commonly produce a
// Unicode minus sign (−, U+2212) or a dash (–/—) instead of the plain ASCII hyphen-minus the regexes below
// require — Number() and every regex here return NaN/no-match on those, silently marking a numerically
// correct answer wrong. makePracticeProblem's own prompt (server/claude.ts) tells the student to "use a
// normal minus sign" as a workaround, but that's a warning, not a fix — normalize the common variants to
// ASCII '-' before any parsing below so a student typing a real minus sign is never marked wrong for it.
function normalizeMinus(s: string): string {
  return s.replace(/[−‐-―－]/g, "-");
}
// π support: makePracticeProblem/generateDailyPracticeProblem's own prompt (server/claude.ts) explicitly
// tells the student they may type the plain-text word "pi" for π — but neither Number() nor the plain
// fraction regex below has any notion of π, so EVERY pi-valued answer (any trig/radian problem, e.g.
// "5π/6") was silently marked wrong no matter how the student wrote it. Reported live. Handled as its own
// pattern, not folded into the a/b fraction regex above, since "5pi/6" is coefficient·π÷denominator — a
// different shape than a plain "a/b" fraction (the numerator here isn't itself a number). Covers the forms
// the AI's own prompt + a student's natural typing would actually produce: "pi", "-pi", "2pi", "5pi/6",
// "pi/4" — and the literal symbol "π" (normalized to the word "pi" first, so one code path handles both).
function parsePi(s: string): number {
  const t = s.replace(/π/g, "pi");
  const coefOf = (raw: string): number => (raw === "" ? 1 : raw === "-" ? -1 : Number(raw));
  const overDen = t.match(/^(-?\d*(?:\.\d+)?)\s*pi\s*\/\s*(-?\d+(?:\.\d+)?)$/i);
  if (overDen) {
    const coef = coefOf(overDen[1]), den = Number(overDen[2]);
    if (Number.isFinite(coef) && Number.isFinite(den) && den !== 0) return (coef * Math.PI) / den;
  }
  const bare = t.match(/^(-?\d*(?:\.\d+)?)\s*pi$/i);
  if (bare) {
    const coef = coefOf(bare[1]);
    if (Number.isFinite(coef)) return coef * Math.PI;
  }
  return NaN;
}
function parseNumericOrFraction(s: string): number {
  const cleaned = normalizeMinus(s).replace(/,/g, "");
  const direct = Number(cleaned);
  if (Number.isFinite(direct)) return direct;
  const pi = parsePi(cleaned);
  if (Number.isFinite(pi)) return pi;
  const frac = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = Number(frac[1]), den = Number(frac[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  }
  return NaN;
}
// A multi-step numeric problem (physics, chemistry, finance) routinely has more than one legitimate path
// to the final number — g = 9.8 vs 9.81, rounding an intermediate angle vs carrying full precision through
// to the last step — and those paths can disagree by a few percent even though both are "correct".
// Reported live, twice: first a student's correctly-derived 7.28 N (g=9.8, rounded intermediate angle) vs
// 7.43 N (exact, no intermediate rounding) were BOTH marked wrong against a stored `answer` that was just
// one specific path through the same calculation (back when this was a flat 1e-6 exact-match); then, after
// a first widening to 3%/0.05, a case where Otto's own chat reply called the student's answer correct while
// this same check still said "Not quite" — 3% still wasn't generous enough for every legitimate alternate
// path. Widened again (5%, 0.08 floor). A plain integer-looking answer ("4", a count, an MCQ-style exact
// value) stays tight — loosening those risks accepting a genuinely wrong value. The signal used to tell the
// two apart: whether the STORED answer itself was given with a decimal point. A decimal answer is a rounded
// result of a computation, so a reasonable alternate path landing within a few percent is almost always the
// same physical quantity; a bare integer is treated as exact.
function numbersMatch(given: number, correct: string | number): boolean {
  const correctNum = typeof correct === "number" ? correct : parseNumericOrFraction(correct);
  const looksDecimal = typeof correct === "string" && /\.\d/.test(correct);
  if (!looksDecimal) return Math.abs(given - correctNum) < 1e-6 * Math.max(1, Math.abs(correctNum));
  const relTol = Math.abs(correctNum) * 0.05; // covers g=9.8-vs-9.81/9.8-vs-10 and a couple of rounded steps
  const absFloor = 0.08; // last-digit rounding drift for small answers (7.42 vs 7.43, 1.94 vs 1.97)
  return Math.abs(given - correctNum) <= Math.max(relTol, absFloor);
}
export function practiceAnswerMatches(given: string, correct: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/^[a-z]\s*=\s*/, "").replace(/\.$/, "");
  const g = norm(given), c = norm(correct);
  if (!g) return false;
  if (g === c) return true;
  const gn = parseNumericOrFraction(g);
  if (Number.isFinite(gn) && Number.isFinite(parseNumericOrFraction(c))) return numbersMatch(gn, c);
  // Leading-number fallback: makePracticeProblem's own prompt (server/claude.ts) tells the STUDENT to
  // include a unit ("format" field says so explicitly) and stores the correct answer WITH one too ("84 m") —
  // but a student who types just the number ("84") has the numerically exact right answer, only missing
  // the unit string. The plain Number() parse above fails the moment either side has trailing unit text, so
  // without this a perfectly correct "84" was marked wrong against "84 m". Compares just the leading numeric
  // token on each side; only reachable when the whole-string parse above didn't already resolve it. Also
  // fraction-aware (e.g. "7/2 m") for the same reason as the whole-string parse above.
  const leadingNum = (s: string) => {
    const fracMatch = s.match(/^-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?/);
    if (fracMatch) return parseNumericOrFraction(fracMatch[0]);
    const m = s.match(/^-?\d+(?:[.,]\d+)?(?:e-?\d+)?/);
    return m ? Number(m[0].replace(",", ".")) : NaN;
  };
  const gln = leadingNum(g), cln = leadingNum(c);
  if (Number.isFinite(gln) && Number.isFinite(cln)) return numbersMatch(gln, c.match(/-?\d+\.\d+/)?.[0] ?? cln);
  return false;
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
  visionReady?: boolean;      // GEMINI_API_KEY present — gates the Tutor whiteboard's "send to Otto" button
  googleConfigured: boolean;  // Composio configured (COMPOSIO_API_KEY) — powers Google + every integration
  cloud: boolean;             // Supabase configured → accounts + state persist
  paused: boolean;            // "pause all AI usage" toggle — client skips auto-run/generate while true
  highPriorityPeople?: string[]; // used ONLY to break ranking ties (VIP's task sorts first) — no UI of its own
  genPerDay?: number;         // how many times/day Otto scans for new tasks (1–4) — drives the client sweep cadence
  timezone?: string;          // the account's captured IANA timezone (client compares to detect a change)
  customTheme?: ThemeTokens;  // AI-personalized theme override, if the student opted in (see validateThemeTokens)
  onboarded?: boolean;  // the basic onboarding has been finished/skipped (or the account clearly predates it)
  toursSeen?: string[]; // page guides already shown on this account (Profile.toursSeen)
  betaFeatures?: boolean;     // opt-in gate for bandit personalization / focus camera / AI theme — see Profile's own doc comment
  overBudget?: boolean;       // month-to-date AI spend has crossed the cap — gen/exec paused until it resets
  unlimited?: boolean;        // account has no monthly AI spend cap (set via the /unlimited page)
  language?: "fr" | "en";     // the account's UI + AI-content language (Settings toggle) — defaults "fr"
  csrfToken?: string;         // synchronizer-token CSRF defense (server/index.ts's requireAuth) — only present when loggedIn
}

// Study Mode types for the focused study environment feature

/** The current state of an active study session */
export type StudyModeState = "idle" | "active" | "paused" | "break" | "completed";

/** Timer display style preference */
export type TimerStyle = "minimal" | "progress" | "hidden";

/** Focus level for distraction control */
export type FocusLevel = "strict" | "balanced" | "open";

/** A single study session record */
export interface StudySession {
  id: string;
  taskId: string;
  userId: string;
  startTime: string;        // ISO timestamp when session started
  endTime?: string;         // ISO timestamp when session ended
  plannedDuration: number;  // planned duration in minutes
  actualDuration?: number;  // actual duration in minutes
  state: StudyModeState;
  reflection?: "good" | "okay" | "difficult"; // end-of-session reflection
  interruptionCount?: number; // how many times the user exited/interrupted
  notes?: string;           // session notes taken by user
  completedSteps?: string[]; // IDs of steps completed during session
  createdAt: string;
  updatedAt: string;
}

/** Adaptive study profile that learns from user behavior */
export interface StudyProfile {
  userId: string;
  // Session preferences (learned from behavior)
  preferredSessionLength?: number; // default session duration in minutes
  preferredBreakLength?: number;    // default break duration in minutes
  prefersPomodoro?: boolean;        // whether user likes pomodoro-style breaks
  uninterruptedSessions?: boolean; // whether user prefers long uninterrupted sessions
  preferredStartTimes?: number[];   // preferred start hours (0-23)
  
  // Visual preferences
  theme?: "light" | "dark" | "auto";
  timerStyle?: TimerStyle;
  showTimer?: boolean;
  showSidebar?: boolean;
  animationLevel?: "none" | "minimal" | "full";
  
  // Audio preferences
  audioType?: "silence" | "brown" | "rain" | "cafe" | "classical" | "lofi";
  audioBySubject?: Record<string, string>; // subject → audio type mapping
  volume?: number; // 0-100
  
  // Workspace preferences
  notesPosition?: "left" | "right" | "bottom";
  materialsPosition?: "left" | "right" | "bottom";
  aiVisibility?: "always" | "on_request" | "hidden";
  
  // Focus preferences
  focusLevel?: FocusLevel;
  
  // Learning data (for adaptive recommendations)
  sessionHistory?: {
    date: string;
    duration: number;
    completed: boolean;
    interruptionCount: number;
    reflection?: "good" | "okay" | "difficult";
  }[];
  
  updatedAt: string;
}

/** Material item for the study session materials drawer */
export interface StudyMaterial {
  id: string;
  label: string;
  url?: string;
  type: "doc" | "pdf" | "link" | "note" | "email" | "calendar";
  source?: string; // integration source (gmail, drive, etc.)
  relevance?: "high" | "medium" | "low";
}

/** Session note taken during study mode */
export type StudyNote = {
  id: string;
  content: string;
  timestamp: string;
};

export type StudyEnvironmentState = {
  task: string; // task ID
  layout: "writing" | "research" | "math" | "reading" | "standard";
  workspaceType: "browser" | "document" | "pdf" | "video" | "empty";
  openResources: StudyMaterial[];
  openTabs: Array<{ id: string; title: string; url: string; active: boolean }>;
  activeResource: string | null; // resource ID
  activeTab?: string | null; // active tab ID
  notes: string;
  audio: {
    type: string;
    volume: number;
    playing: boolean;
  };
  focusLevel: "strict" | "balanced" | "open";
  timer: {
    state: StudyModeState;
    remaining: number;
    plannedDuration: number;
  };
  aiVisibility: "hidden" | "available" | "always";
  browserPermissions: {
    allowedDomains: string[];
    restrictedDomains: string[];
  };
  userPreferences: {
    preferredLayout: string;
    preferredAudio: string;
    preferredFocusLevel: string;
    showTimer: boolean;
    showNotes: boolean;
  };
  panes?: Record<string, number>; // e.g. { browser: 70, notes: 30 }
  lastSaved: string;
};

export interface RunResult {
  ok: boolean;
  message?: string;
  task?: WebTask;
}
