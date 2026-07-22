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
  paused?: boolean;       // "pause all AI usage" — blocks generation, task runs, and chat server-side
  pausedAt?: string;      // ISO stamp of the last toggle, so cross-device merge keeps the most RECENT choice
  lastSweepAt?: string;   // ISO stamp of the last SUCCESSFUL generation sweep — durable "did we check today"
                          // marker (survives restarts; source of truth for the once-per-local-day guarantee)
  lastForcedAt?: string;  // ISO stamp of the last time the sweep FORCED a "daily minimum" task (when it would
                          // otherwise have surfaced nothing) — so we guarantee at most one forced task per local day
  // Structured preferences for autonomous behavior
  workingHours?: { start: string; end: string; timezone: string }; // e.g. { start: "09:00", end: "18:00", timezone: "America/New_York" }
  responseStyle?: "concise" | "detailed" | "casual" | "formal"; // how AI should draft responses
  autoApprove?: string[]; // categories of actions AI can do without approval (e.g., ["schedule_meetings_under_30min", "archive_newsletters"])
  highPriorityPeople?: string[]; // people whose messages get higher priority
  autoArchivePatterns?: string[]; // email patterns to auto-archive (e.g., ["newsletter", "promotions"])
  // Trust/confidence system for gradual automation
  confidence?: Record<string, number>; // action category → confidence score (0-1), e.g., { "draft_email": 0.85, "create_calendar": 0.6 }
  confidenceHistory?: Array<{ action: string; approved: boolean; at: string }>; // track approval/rejection history
  // Cumulative AI token usage across sweeps + task runs (for the Settings "usage" view). Monotonic counters
  // (merged by MAX across devices), so the number only ever grows — approximate, for visibility not billing.
  usage?: { in: number; out: number; runs: number; since: string };
}
export function emptyProfile(): Profile { return { about: "", preferences: [], people: [], projects: [] }; }
export function normalizeProfile(p: any): Profile {
  const arr = (v: any): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  return {
    name: typeof p?.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : undefined,
    about: typeof p?.about === "string" ? p.about : "",
    // Dedupe each list so reworded facts about the SAME person/project don't pile up (self-heals on every load).
    preferences: dedupeFacts(arr(p?.preferences)),
    people: dedupeFacts(arr(p?.people)),
    projects: dedupeFacts(arr(p?.projects)),
    paused: !!p?.paused,
    pausedAt: typeof p?.pausedAt === "string" ? p.pausedAt : undefined,
    lastSweepAt: typeof p?.lastSweepAt === "string" ? p.lastSweepAt : undefined,
    lastForcedAt: typeof p?.lastForcedAt === "string" ? p.lastForcedAt : undefined,
    // Structured preferences
    workingHours: p?.workingHours && typeof p.workingHours === "object" ? {
      start: String(p.workingHours.start || "09:00"),
      end: String(p.workingHours.end || "18:00"),
      timezone: String(p.workingHours.timezone || "UTC"),
    } : undefined,
    responseStyle: ["concise", "detailed", "casual", "formal"].includes(p?.responseStyle) ? p.responseStyle : undefined,
    autoApprove: Array.isArray(p?.autoApprove) ? p.autoApprove.map(String) : undefined,
    highPriorityPeople: Array.isArray(p?.highPriorityPeople) ? p.highPriorityPeople.map(String) : undefined,
    autoArchivePatterns: Array.isArray(p?.autoArchivePatterns) ? p.autoArchivePatterns.map(String) : undefined,
    // Trust/confidence system
    confidence: p?.confidence && typeof p.confidence === "object" ? p.confidence : undefined,
    confidenceHistory: Array.isArray(p?.confidenceHistory) ? p.confidenceHistory.slice(-100) : undefined,
    usage: p?.usage && typeof p.usage === "object" ? {
      in: Number(p.usage.in) || 0, out: Number(p.usage.out) || 0, runs: Number(p.usage.runs) || 0,
      since: typeof p.usage.since === "string" ? p.usage.since : new Date().toISOString(),
    } : undefined,
  };
}
/** Add one AI call's token cost to a profile's cumulative usage counter (mutates in place). Best-effort,
 *  for the Settings visibility view — never throws, tolerates missing token data. */
export function addUsage(profile: Profile, tokens?: { in?: number; out?: number } | null): void {
  const tin = Number(tokens?.in) || 0, tout = Number(tokens?.out) || 0;
  if (!tin && !tout) return;
  const u = profile.usage || { in: 0, out: 0, runs: 0, since: new Date().toISOString() };
  profile.usage = { in: u.in + tin, out: u.out + tout, runs: u.runs + 1, since: u.since };
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
}

/** A reviewed message/invite the agent prepared (a Gmail draft / a composed Slack message / a calendar event
 *  whose invites aren't sent yet) that the USER can fire with one click. The agent NEVER sends; the user
 *  confirms + clicks — and the recipients are always shown first — and the server executes the send. */
export interface Sendable {
  app: "gmail" | "slack" | "gcal";
  label: string;        // e.g. "Send reply to Sarah", "Post to #team", "Send invites"
  to?: string;          // recipient (email) or channel — shown before the user confirms
  subject?: string;     // gmail: the drafted subject (for in-app review)
  body?: string;        // gmail: the drafted body (for in-app review)
  draftId?: string;     // gmail: the draft_id to send
  channel?: string;     // slack: channel id or #name
  text?: string;        // slack: the message text to post
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
  when?: string;       // concise timeline / deadline, e.g. "today", "by Fri 5pm", "this week"
  source: string;      // "gmail" | "calendar" | "manual", or a connected-app slug (slack, github, notion, …)
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
}

export interface ConnectionStatus {
  loggedIn: boolean;          // signed into an email account
  user?: string;              // the account email
  name?: string;              // what to call the user (from their profile) — personalizes the UI
  googleConnected: boolean;   // Gmail is connected (via Composio) — the minimum to generate tasks
  aiReady: boolean;           // ANTHROPIC_API_KEY present
  googleConfigured: boolean;  // Composio configured (COMPOSIO_API_KEY) — powers Google + every integration
  cloud: boolean;             // Supabase configured → accounts + state persist
  paused: boolean;            // "pause all AI usage" toggle — client skips auto-run/generate/chat while true
  highPriorityPeople?: string[]; // used ONLY to break ranking ties (VIP's task sorts first) — no UI of its own
}

export interface RunResult {
  ok: boolean;
  message?: string;
  task?: WebTask;
}
