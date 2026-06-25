// Shared task model — imported by both the Express backend and the React client.

export type Quadrant = "do" | "schedule" | "delegate" | "later";

// ready      → generated, not yet run
// running    → auto/manual execution in flight
// executed   → ran; shows what was done + a checklist; awaits your Confirm
// done        → you confirmed it
// dismissed  → you dropped it
export type TaskStatus = "ready" | "running" | "executed" | "done" | "dismissed";

export interface TaskLink {
  label: string;
  url: string;
}

/** A lightweight model of WHO THE USER IS — built up over time, used to ground + personalize tasks. */
export interface Profile {
  about: string;          // a short paragraph: role, how they work, what matters
  preferences: string[];  // e.g. "concise emails", "no meetings before 10am"
  people: string[];       // key people + relationship ("Sarah — my manager")
  projects: string[];     // ongoing projects / goals
}
export function emptyProfile(): Profile { return { about: "", preferences: [], people: [], projects: [] }; }
export function normalizeProfile(p: any): Profile {
  const arr = (v: any): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  return { about: typeof p?.about === "string" ? p.about : "", preferences: arr(p?.preferences), people: arr(p?.people), projects: arr(p?.projects) };
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
  result?: string;      // short note of what auto-doing it produced
}

export interface WebTask {
  id: string;
  title: string;
  why: string;
  when?: string;       // concise timeline / deadline, e.g. "today", "by Fri 5pm", "this week"
  source: "gmail" | "calendar" | "manual";
  /** Reversible tasks auto-run; irreversible (e.g. sending) waits for your confirm. */
  risk: "low" | "high";
  urgency: number;     // 0..1 time pressure
  importance: number;  // 0..1 stakes
  quadrant: Quadrant;
  score: number;       // ranking
  status: TaskStatus;

  // Filled once it runs:
  context?: string;        // one-paragraph grounded background
  synthesis?: string;      // what the agent actually did
  links?: TaskLink[];      // docs/drafts it produced
  draftId?: string;        // a prepared Gmail draft ready to SEND on the user's explicit confirmation
  draft?: { to?: string; subject: string; body: string }; // the drafted email, shown in-app for review/edit
  sent?: boolean;          // the draft was sent (after the user confirmed)
  steps?: TaskStep[];      // what's left, as classified bullets (automatable / needs-you / dependent)

  evidence?: TaskLink[];   // the real source(s) this came from (the email thread / calendar event)
  autoRan?: boolean;       // guard so a reversible task auto-runs at most once
  /** Stable identity of the underlying thing (e.g. "gmail:<threadId>", "calendar:<eventId>"). Dedupes
   *  the SAME email/event across refreshes even when the model rephrases the title. */
  anchorKey?: string;
  createdAt: string;
}

export interface ConnectionStatus {
  loggedIn: boolean;          // signed into an email account
  user?: string;              // the account email
  googleConnected: boolean;   // Gmail is connected (via Composio) — the minimum to generate tasks
  aiReady: boolean;           // ANTHROPIC_API_KEY present
  googleConfigured: boolean;  // Composio configured (COMPOSIO_API_KEY) — powers Google + every integration
  cloud: boolean;             // Supabase configured → accounts + state persist
}

export interface RunResult {
  ok: boolean;
  message?: string;
  task?: WebTask;
}
