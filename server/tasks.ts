import { randomUUID } from "node:crypto";
import type { WebTask, Quadrant, TaskLink, Profile } from "../shared/types.ts";
import { generateTasks, runTask as aiRun, type ProfileUpdate, type RefinedTask } from "./claude.ts";
import type { AgentTools } from "./integrations.ts";

/** Fold a learned fact into the person-profile (append to the right list, deduped; 'about' replaces). */
export function applyProfileUpdate(profile: Profile, u: ProfileUpdate): void {
  const f = u.fact.trim();
  if (!f) return;
  if (u.category === "about") { profile.about = f.slice(0, 400); return; }
  const key = u.category === "preference" ? "preferences" : u.category === "person" ? "people" : "projects";
  const list = profile[key];
  if (!list.some((x) => x.toLowerCase() === f.toLowerCase())) list.push(f.slice(0, 160));
}

const URGENT_AT = 0.5, IMPORTANT_AT = 0.5;

/** Eisenhower: two axes → quadrant + a ranking score (Do > Schedule > Delegate > Later). */
export function eisenhower(urgency: number, importance: number): { quadrant: Quadrant; score: number } {
  const urgent = urgency >= URGENT_AT, important = importance >= IMPORTANT_AT;
  const quadrant: Quadrant = important ? (urgent ? "do" : "schedule") : (urgent ? "delegate" : "later");
  const rank = important ? (urgent ? 3 : 2) : (urgent ? 1 : 0);
  return { quadrant, score: rank + (0.6 * importance + 0.4 * urgency) * 0.99 };
}

/** Normalize a title for fuzzy comparison: lowercase, drop punctuation, collapse whitespace. */
function normTitle(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
/** Two titles are "the same task" if their word sets overlap heavily (catches model rephrasings). */
function nearDup(a: string, b: string): boolean {
  const wa = new Set(normTitle(a).split(" ").filter((w) => w.length > 2));
  const wb = new Set(normTitle(b).split(" ").filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return false;
  let inter = 0; for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.7; // Jaccard
}

/**
 * Regenerate from the user's connected apps (the agent reads Gmail + Calendar via Composio), preserving
 * manual tasks and anything already run. Dedupe is ANCHOR-based (the agent returns a stable anchorKey like
 * "gmail:<threadId>"), so the same email/meeting never resurfaces just because the model reworded the title
 * — with a near-duplicate-title fallback for tasks that aren't tied to one item.
 */
export async function generate(existing: WebTask[], profile: Profile, extras?: AgentTools): Promise<WebTask[]> {
  const gen = await generateTasks(profile, extras);
  const now = new Date().toISOString();

  const keyOf = (t: { source: string; title: string; anchorKey?: string }) => t.anchorKey || `${t.source}:${normTitle(t.title)}`;

  // Keep EVERY existing task in the dedupe map — INCLUDING done & dismissed — so a thread/event we've
  // already handled or dropped never comes back as a "new" task on a later refresh. (The client hides
  // done/dismissed from the live list; they persist only to block regeneration.)
  const kept = new Map<string, WebTask>();
  for (const t of existing) kept.set(keyOf(t), t);

  for (const g of gen) {
    const key = g.anchorKey || `${g.source}:${normTitle(g.title)}`;
    if (kept.has(key)) continue;                                              // same anchor already tracked
    if ([...kept.values()].some((e) => nearDup(e.title, g.title))) continue;  // reworded duplicate of an existing task
    const e = eisenhower(g.urgency, g.importance);
    const evidence: TaskLink[] | undefined = g.link ? [{ label: g.source === "calendar" ? "Open event" : "Open in Gmail", url: g.link }] : undefined;
    kept.set(key, {
      id: randomUUID(), title: g.title, why: g.why, when: g.when, source: g.source, risk: g.risk,
      urgency: g.urgency, importance: g.importance, quadrant: e.quadrant, score: e.score,
      status: "ready", createdAt: now, anchorKey: g.anchorKey, evidence,
    });
  }
  return [...kept.values()].sort((a, b) => b.score - a.score);
}

/** Add a task the user typed; AI-refined when possible (else raw), classified through the same matrix. */
export function addManual(list: WebTask[], title: string, refined?: RefinedTask | null): WebTask[] {
  const urgency = refined ? refined.urgency : 0.6;
  const importance = refined ? refined.importance : 0.75;
  const e = eisenhower(urgency, importance);
  const now = new Date().toISOString();
  list.unshift({
    id: randomUUID(),
    title: (refined?.title || title).trim().slice(0, 120),
    why: refined?.why || "Added by you.",
    when: refined?.when,
    source: "manual", risk: "low", urgency, importance, quadrant: e.quadrant, score: e.score,
    status: "ready", createdAt: now,
  });
  return list;
}

/** Tasks that should auto-run (reversible prep) — ready and not yet auto-run. */
export function pendingAutoRun(list: WebTask[]): WebTask[] {
  return list.filter((t) => t.status === "ready" && !t.autoRan).sort((a, b) => b.score - a.score);
}

/**
 * Run a task: the agent gathers facts and does the reversible work itself through the user's connected apps
 * (drafts a reply, creates a doc/deck/sheet, adds a task/event, updates an issue — never an irreversible
 * send/delete), then the task shows its context, a synthesis of what it did, and a checklist of what's left.
 */
export async function runById(list: WebTask[], id: string, profile: Profile, extras?: AgentTools): Promise<WebTask | undefined> {
  const task = list.find((t) => t.id === id);
  if (!task) return undefined;
  task.status = "running";
  task.autoRan = true; // set before the await so concurrent auto-runs skip it (pendingAutoRun checks !autoRan)
  try {
    const out = await aiRun({ title: task.title, why: task.why, source: task.source }, profile, undefined, extras);
    // Fold anything the agent learned about the user into the profile.
    for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
    task.context = out.context;
    task.synthesis = out.synthesis;
    task.steps = out.steps;
    task.status = "executed";
    return task;
  } catch (e) {
    // Failure (Claude/Composio error) → never leave it stuck on "running". Back to ready so the user can
    // retry manually; keep autoRan=true so it doesn't auto-retry in a loop on a persistent fault.
    task.status = "ready";
    throw e;
  }
}

export function setStatus(list: WebTask[], id: string, status: WebTask["status"]): void {
  const t = list.find((x) => x.id === id);
  if (t) t.status = status;
}

/** Reject what the agent did → re-surface so it can be run again. */
export function reject(list: WebTask[], id: string): void {
  const t = list.find((x) => x.id === id);
  if (t) { t.status = "ready"; t.synthesis = undefined; t.steps = undefined; t.links = undefined; t.autoRan = false; }
}

/** Mark a step done/undone (a manual step the user did, or after auto-do). */
export function setStepDone(list: WebTask[], id: string, index: number, done: boolean, result?: string): void {
  const t = list.find((x) => x.id === id);
  const step = t?.steps?.[index];
  if (!step) return;
  step.done = done;
  if (result !== undefined) step.result = result;
}

/**
 * Auto-do ONE automatable step: a focused agent run scoped to that step. The agent does the reversible work
 * itself via the connected apps and marks the step done with a short result. (URL-open steps are handled on
 * the client; this is for draft/doc/research/create/update steps.)
 */
export async function runStep(list: WebTask[], id: string, index: number, profile: Profile, extras?: AgentTools): Promise<WebTask | undefined> {
  const task = list.find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (!task || !step) return task;
  // Feed in what the user already decided/did on other steps, so this (often dependent) step uses it.
  const decisions = (task.steps || [])
    .filter((s, idx) => idx !== index && s.done && s.result)
    .map((s) => `- "${s.text}" → ${s.result}`)
    .join("\n");
  const focus = decisions ? `${step.text}\n\nWhat the user has already decided/done:\n${decisions}` : step.text;
  const out = await aiRun({ title: task.title, why: task.why }, profile, focus, extras);
  for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
  step.done = true;
  step.result = out.synthesis.slice(0, 1200);
  return task;
}
