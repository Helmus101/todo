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
  name?: string;          // what to call the user (asked at onboarding / learned from their mail)
  about: string;          // a short paragraph: role, how they work, what matters
  preferences: string[];  // e.g. "concise emails", "no meetings before 10am"
  people: string[];       // key people + relationship ("Sarah — my manager")
  projects: string[];     // ongoing projects / goals
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
function sameFact(a: string, b: string): boolean {
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
  synthesis?: string;      // what the agent actually did
  links?: TaskLink[];      // docs/drafts it produced
  steps?: TaskStep[];      // what's left, as classified bullets (automatable / needs-you / dependent)
  sendables?: Sendable[];  // drafted email / composed Slack message the user can send in one click

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
  name?: string;              // what to call the user (from their profile) — personalizes the UI
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
