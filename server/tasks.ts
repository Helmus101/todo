import { randomUUID } from "node:crypto";
import type { WebTask, Quadrant, TaskLink, Profile, Sendable } from "../shared/types.ts";
import { dedupeFacts, sameFact } from "../shared/types.ts";
import { generateTasks, runTask as aiRun, type ProfileUpdate, type RefinedTask } from "./claude.ts";
import type { AgentTools } from "./integrations.ts";

/** Fold a learned fact into the person-profile. 'name'/'about' replace. List facts REPLACE an existing
 *  same-entity fact (newest wording wins — so a correction actually takes effect; dedupeFacts alone keeps
 *  the LONGER wording, which lets stale facts survive), else append; then dedupe + cap. */
export function applyProfileUpdate(profile: Profile, u: ProfileUpdate): void {
  const f = u.fact.trim();
  if (!f) return;
  if (u.category === "name") { profile.name = f.slice(0, 60); return; }
  if (u.category === "about") { profile.about = f.slice(0, 400); return; }
  const key = u.category === "preference" ? "preferences" : u.category === "person" ? "people" : "projects";
  const fact = f.slice(0, 160);
  // Drop EVERY stored wording of this entity (old lists may hold several), then add the newest.
  const rest = profile[key].filter((x) => !sameFact(x, fact));
  profile[key] = dedupeFacts([...rest, fact]);
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
/** Generic action verbs / fillers that DON'T distinguish one to-do from another — ignored when comparing
 *  titles, so two tasks are judged "the same" by their DISTINCTIVE words (amounts, brands, names, dates). */
const GENERIC_WORDS = new Set([
  "use", "get", "got", "make", "made", "add", "set", "ask", "the", "for", "your", "you", "and", "with", "from",
  "before", "after", "this", "that", "need", "needs", "send", "reply", "pay", "book", "buy", "read", "sort",
  "plan", "prep", "review", "check", "email", "mail", "call", "off", "out", "new", "via", "per", "due", "day",
  "days", "week", "soon", "now", "all", "any", "into", "onto", "about", "then", "complete", "finish", "update",
]);
function distinctiveTokens(s: string): Set<string> {
  const words = normTitle(s).split(" ").filter((w) => w.length > 2);
  const distinctive = words.filter((w) => !GENERIC_WORDS.has(w));
  return new Set(distinctive.length ? distinctive : words); // if a title is ALL generic, fall back to every word
}
/** Two titles are "the same task" if their DISTINCTIVE word-sets overlap heavily, OR one is largely a subset
 *  of the other with enough shared keywords. Catches the model's rewordings — e.g. "Use $100 Resy credit
 *  before Jun 30 in Boston" / "Use $100 Amex Resy dining credit in Boston" / "Use Amex Resy $100 dining credit
 *  before Jun 30" all collapse — while keeping genuinely different tasks (e.g. "Book flights to NYC" vs "Book
 *  hotel in NYC", where the key noun differs) apart. */
function nearDup(a: string, b: string): boolean {
  const A = distinctiveTokens(a), B = distinctiveTokens(b);
  if (!A.size || !B.size) return false;
  // Stem-ish matching: "sun"/"sunday", "jul"/"july", "reply"/"replying" count as the same word — catches
  // the model re-abbreviating dates/verbs, the most common "same task, slightly different wording" case.
  const matches = (w: string, set: Set<string>) => {
    if (set.has(w)) return true;
    for (const x of set) if (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))) return true;
    return false;
  };
  let inter = 0; for (const w of A) if (matches(w, B)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return jaccard >= 0.55 || (inter >= 3 && containment >= 0.75) || (inter >= 2 && containment >= 0.9);
}

/** Keep at most `keep` done/dismissed records (most recent) — enough to still block regeneration of handled
 *  items, but bounded so the saved task list (and every cloud write) doesn't grow forever. Active tasks stay. */
function pruneHandled(list: WebTask[], keep: number): WebTask[] {
  const active = list.filter((t) => t.status !== "done" && t.status !== "dismissed");
  const handled = list.filter((t) => t.status === "done" || t.status === "dismissed")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, keep);
  return [...active, ...handled];
}

// Collapse formatting drift in an anchor ("gmail:18fAb", "GMAIL_18fab" → same) so the SAME thread/event
// can't slip back in just because the model rephrased its id.
const normKey = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const linkOf = (t: { evidence?: TaskLink[] }) => (t.evidence || []).map((e) => e.url).find(Boolean) || "";
// When two candidates are the SAME to-do, keep the more-progressed one: a finished/in-flight task must never
// be dropped for a fresh duplicate, and a handled (done/dismissed) one suppresses a new copy → no resurfacing.
const rankStatus = (t: WebTask) => (t.status === "done" || t.status === "dismissed") ? 4 : t.status === "executed" ? 3 : t.status === "running" ? 2 : 1;
const betterOf = (a: WebTask, b: WebTask) => rankStatus(b) > rankStatus(a) ? b : a; // ties keep `a` (added first)
// Titles must near-match, or (same source AND same trigger). The old cross-field checks (title vs why)
// were loose enough to swallow genuinely NEW tasks into old done ones — "Refresh finds nothing".
const sameTask = (a: WebTask, b: WebTask): boolean =>
  nearDup(a.title, b.title) || (a.source === b.source && nearDup(a.why, b.why));

/**
 * Collapse duplicate to-dos in ANY task list by THREE signals: a normalized anchor (the thread/event id),
 * the source LINK (stable even when the model's anchor drifts), and a near-duplicate title (catches
 * reworded, anchorless tasks). Used by generate() (new sweep vs existing) AND by the cross-device cloud
 * merge — two sessions can each mint a FRESH random id for the same real-world item (e.g. two tabs both
 * sweeping the same Gmail thread at once), so an id-only union isn't enough to keep it from duplicating.
 */
export function dedupeTasks(list: WebTask[]): WebTask[] {
  const kept: WebTask[] = [];
  for (const t of list) {
    const ak = normKey(t.anchorKey), link = linkOf(t);
    const i = kept.findIndex((k) =>
      (!!ak && normKey(k.anchorKey) === ak) ||
      (!!link && linkOf(k) === link) ||
      sameTask(k, t));
    if (i >= 0) kept[i] = betterOf(kept[i], t);
    else kept.push(t);
  }
  return kept;
}

/**
 * Regenerate from the user's connected apps (the agent reads Gmail + Calendar via Composio), preserving
 * manual tasks and anything already run. Dedupe is ANCHOR-based (the agent returns a stable anchorKey like
 * "gmail:<threadId>"), so the same email/meeting never resurfaces just because the model reworded the title
 * — with a near-duplicate-title fallback for tasks that aren't tied to one item.
 */
export async function generate(existing: WebTask[], profile: Profile, extras?: AgentTools): Promise<WebTask[]> {
  // Tell the generator what's already finished/dismissed so it never resurfaces a handled to-do.
  const handled = existing
    .filter((t) => t.status === "done" || t.status === "dismissed")
    .map((t) => ({
      title: t.title,
      why: t.why,
      source: t.source,
      when: t.when,
      anchorKey: t.anchorKey,
      link: t.evidence?.find((e) => e.url)?.url,
    }));
  const gen = await generateTasks(profile, extras, handled);
  // The sweep reads the user's whole world — fold anything it learned about WHO THEY ARE into the
  // profile, so preferences/people/projects keep updating continuously (not only during task runs).
  for (const u of gen.profileUpdates) applyProfileUpdate(profile, u);
  const now = new Date().toISOString();

  const candidates: WebTask[] = [...existing];
  for (const g of gen.tasks) {
    const e = eisenhower(g.urgency, g.importance);
    const evidence: TaskLink[] | undefined = g.link ? [{ label: g.source === "calendar" ? "Open event" : g.source === "gmail" ? "Open in Gmail" : "Open source", url: g.link }] : undefined;
    candidates.push({
      id: randomUUID(), title: g.title, why: g.why, when: g.when, source: g.source, risk: g.risk,
      urgency: g.urgency, importance: g.importance, quadrant: e.quadrant, score: e.score,
      status: "ready", createdAt: now, anchorKey: g.anchorKey, evidence,
    });
  }
  return pruneHandled(dedupeTasks(candidates).sort((a, b) => b.score - a.score), 120);
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

/**
 * Run a task: the agent gathers facts and does the reversible work itself through the user's connected apps
 * (drafts a reply, creates a doc/deck/sheet, adds a task/event, updates an issue — never an irreversible
 * send/delete), then the task shows its context, a synthesis of what it did, and a checklist of what's left.
 */
export async function runById(list: WebTask[], id: string, profile: Profile, extras?: AgentTools, revision?: string): Promise<WebTask | undefined> {
  const task = list.find((t) => t.id === id);
  if (!task) return undefined;
  if (task.status === "running") return task; // already in flight (second tab/device) — never double-run
  task.status = "running";
  task.autoRan = true; // set before the await so concurrent auto-runs skip it (pendingAutoRun checks !autoRan)
  // A user revision: they reviewed a draft and asked for a change before sending → re-run with that instruction.
  const focus = revision?.trim()
    ? `The user reviewed your previous draft/output for this task and wants this CHANGE before they send it: "${revision.trim()}". Redo the task incorporating it — UPDATE the existing draft/doc (don't create a new copy) and re-offer it as a sendable.`
    : undefined;
  try {
    const out = await aiRun({ title: task.title, why: task.why, source: task.source, links: task.links }, profile, focus, extras);
    // Fold anything the agent learned about the user into the profile.
    for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
    task.context = out.context;
    task.synthesis = out.synthesis;
    // A re-run (Redo / revision) must NOT forget which steps the user already completed: carry each
    // prior step's done/doneAt/result onto the matching new step (matched by near-duplicate text).
    const prior = (task.steps || []).filter((s) => s.done);
    task.steps = (out.steps || []).map((s) => {
      const old = prior.find((o) => nearDup(o.text, s.text));
      return old ? { ...s, done: true, doneAt: old.doneAt, result: s.result || old.result } : s;
    });
    task.links = out.links?.length ? out.links : undefined; // links to the draft/doc/event it made, so the user can open it
    task.sendables = out.sendables?.length ? out.sendables : undefined; // drafts the user can send in one click
    task.status = "executed";
    task.updatedAt = new Date().toISOString();
    return task;
  } catch (e) {
    // Failure (Claude/Composio error) → never leave it stuck on "running". Back to ready so the user can
    // retry manually; keep autoRan=true so it doesn't auto-retry in a loop on a persistent fault.
    task.status = "ready";
    task.updatedAt = new Date().toISOString();
    throw e;
  }
}

/** Reject what the agent did → re-surface so it can be run again. */
export function reject(list: WebTask[], id: string): void {
  const t = list.find((x) => x.id === id);
  if (t) { t.status = "ready"; t.synthesis = undefined; t.steps = undefined; t.links = undefined; t.autoRan = false; t.updatedAt = new Date().toISOString(); }
}

/** Mark a step done/undone (a manual step the user did, or after auto-do). */
export function setStepDone(list: WebTask[], id: string, index: number, done: boolean, result?: string): void {
  const t = list.find((x) => x.id === id);
  const step = t?.steps?.[index];
  if (!step) return;
  step.done = done;
  step.doneAt = done ? new Date().toISOString() : undefined;
  if (result !== undefined) step.result = result;
  t!.updatedAt = new Date().toISOString();
}

/**
 * Auto-do ONE automatable step: a focused agent run scoped to that step. The agent does the reversible work
 * itself via the connected apps and marks the step done with a short result. (URL-open steps are handled on
 * the client; this is for draft/doc/research/create/update steps.)
 */
export async function runStep(list: WebTask[], id: string, index: number, profile: Profile, extras?: AgentTools, answer?: string): Promise<WebTask | undefined> {
  const task = list.find((t) => t.id === id);
  const step = task?.steps?.[index];
  if (!task || !step) return task;
  // Feed in what the user already decided/did on other steps, so this (often dependent) step uses it.
  const decisions = (task.steps || [])
    .filter((s, idx) => idx !== index && s.done && s.result)
    .map((s) => `- "${s.text}" → ${s.result}`)
    .join("\n");
  // The user answered this step's inline question — that answer IS the missing piece; use it and do the step.
  const qa = answer?.trim()
    ? step.question
      ? `\nThe user answered your question ("${step.question}"): "${answer.trim()}". That is the missing detail — use it and complete the step now; do not ask again.`
      : `\nInfo from the user for this step: "${answer.trim()}". Use it.`
    : "";
  const focus = (decisions ? `${step.text}\n\nWhat the user has already decided/done:\n${decisions}` : step.text) + qa;
  const out = await aiRun({ title: task.title, why: task.why, source: task.source, links: task.links }, profile, focus, extras);
  for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
  step.result = out.synthesis.slice(0, 1200);
  // If the focused run still needs the user (it returned a needs-you step), it couldn't finish — flip this step
  // to needs-you so it shows honestly (not a false ✓) and won't auto-retry; otherwise mark it done.
  if ((out.steps || []).some((s) => !s.automatable)) { step.automatable = false; step.done = false; }
  else { step.done = true; step.doneAt = new Date().toISOString(); step.question = undefined; step.options = undefined; } // answered + done → no stale question
  // Surface anything this step produced (a draft/doc/…) alongside the task's other artifacts, deduped by URL.
  if (out.links?.length) {
    const seen = new Set((task.links || []).map((l) => l.url));
    task.links = [...(task.links || []), ...out.links.filter((l) => !seen.has(l.url))].slice(0, 3);
  }
  if (out.sendables?.length) {
    const key = (s: Sendable) => s.draftId || s.eventId || `${s.channel}:${s.text}`;
    const seen = new Set((task.sendables || []).map(key));
    task.sendables = [...(task.sendables || []), ...out.sendables.filter((s) => !seen.has(key(s)))].slice(0, 8);
  }
  task.updatedAt = new Date().toISOString();
  return task;
}
