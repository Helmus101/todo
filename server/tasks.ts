import { randomUUID } from "node:crypto";
import type { WebTask, Quadrant, TaskLink, Profile, Sendable } from "../shared/types.ts";
import { dedupeFacts, sameFact, canonStatus, sortWithinQuadrant, addUsage, isHandled } from "../shared/types.ts";
import { generateTasks, classifyCandidates, pickOneTask, runTask as aiRun, type ProfileUpdate, type RefinedTask } from "./claude.ts";
import { readOnly, scopeTools, DOC_LINK, type AgentTools } from "./integrations.ts";
import { discoverSourceItems, filterCandidates } from "./discover.ts";

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

// ── Trust/confidence system for gradual automation ─────────────────────────────
const CONFIDENCE_THRESHOLD = 0.75; // Auto-approve when confidence reaches this level
const MIN_HISTORY = 5; // Need at least this many decisions before trusting
const DECAY_DAYS = 30; // History older than this gets less weight

/** Update confidence score based on user approval/rejection of an action category. */
export function updateConfidence(profile: Profile, actionCategory: string, approved: boolean): void {
  if (!profile.confidence) profile.confidence = {};
  if (!profile.confidenceHistory) profile.confidenceHistory = [];
  
  const now = new Date().toISOString();
  profile.confidenceHistory.push({ action: actionCategory, approved, at: now });
  
  // Keep only recent history (last 100 entries)
  if (profile.confidenceHistory.length > 100) {
    profile.confidenceHistory = profile.confidenceHistory.slice(-100);
  }
  
  // Calculate confidence from recent history
  const recent = profile.confidenceHistory.filter(h => h.action === actionCategory);
  if (recent.length < MIN_HISTORY) {
    // Not enough data yet, start at 0.5 and move slowly
    const current = profile.confidence[actionCategory] || 0.5;
    profile.confidence[actionCategory] = approved 
      ? Math.min(1, current + 0.05) 
      : Math.max(0, current - 0.1);
    return;
  }
  
  // Weight recent decisions more heavily
  let weightedSum = 0;
  let totalWeight = 0;
  const nowMs = Date.now();
  
  for (const h of recent) {
    const ageMs = nowMs - new Date(h.at).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const weight = Math.max(0.1, 1 - (ageDays / DECAY_DAYS)); // Decay over time
    weightedSum += (h.approved ? 1 : 0) * weight;
    totalWeight += weight;
  }
  
  const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  profile.confidence[actionCategory] = confidence;
}

/** Check if an action should be auto-approved based on confidence score. */
export function shouldAutoApprove(profile: Profile, actionCategory: string): boolean {
  const confidence = profile.confidence?.[actionCategory];
  if (confidence === undefined) return false;
  
  const history = profile.confidenceHistory?.filter(h => h.action === actionCategory) || [];
  if (history.length < MIN_HISTORY) return false;
  
  return confidence >= CONFIDENCE_THRESHOLD;
}

/** Get confidence score for an action category (0-1). */
export function getConfidence(profile: Profile, actionCategory: string): number {
  return profile.confidence?.[actionCategory] || 0.5;
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
// Stem-ish matching: "sun"/"sunday", "jul"/"july", "reply"/"replying" count as the same word — catches
// the model re-abbreviating dates/verbs, the most common "same task, slightly different wording" case.
const tokenMatches = (w: string, set: Set<string>) => {
  if (set.has(w)) return true;
  for (const x of set) if (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))) return true;
  return false;
};
function tokenOverlap(a: string, b: string): { jaccard: number; containment: number; inter: number } {
  const A = distinctiveTokens(a), B = distinctiveTokens(b);
  if (!A.size || !B.size) return { jaccard: 0, containment: 0, inter: 0 };
  let inter = 0; for (const w of A) if (tokenMatches(w, B)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), containment: inter / Math.min(A.size, B.size), inter };
}
function nearDup(a: string, b: string): boolean {
  const { jaccard, containment, inter } = tokenOverlap(a, b);
  return jaccard >= 0.55 || (inter >= 3 && containment >= 0.75) || (inter >= 2 && containment >= 0.9);
}
/** LOOSER similarity, used ONLY to suppress new tasks that resemble a DISMISSED one — a dismissal is a
 *  signal ("I don't want this kind of task"), so we'd rather over-suppress near a dismissed item than
 *  resurface it reworded. Never used to merge two live tasks (that needs the stricter nearDup). */
function looseDup(a: string, b: string): boolean {
  const { jaccard, containment, inter } = tokenOverlap(a, b);
  return jaccard >= 0.4 || (inter >= 2 && containment >= 0.6);
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
// Progression order for merges: a MORE progressed copy always beats a less progressed one.
const rankStatus = (t: WebTask) => {
  const c = canonStatus(t.status);
  return c === "done" || c === "dismissed" ? 6
    : c === "needs_review" ? 5
    : c === "failed_terminal" ? 4
    : c === "failed_retryable" ? 3
    : c === "executing" ? 2.5
    : c === "queued" ? 2 : 1;
};
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
    const i = kept.findIndex((k) => {
      const kak = normKey(k.anchorKey);
      if (!!ak && kak === ak) return true;             // SAME anchor (same thread/event) → dup
      if (!!link && linkOf(k) === link) return true;   // same source link → dup
      // Two tasks that BOTH carry a REAL anchor and those anchors DIFFER are different real-world items
      // (two distinct emails/events). A genuinely NEW email must not be swallowed into a similarly-titled
      // OLD *handled* task ("refresh finds nothing") — so across distinct anchors, don't let a DONE or
      // DISMISSED task title-suppress a new one. But two ACTIVE same-title cards ARE worth merging (the
      // user shouldn't see visual duplicates), and anchorless tasks (manual/agent-sweep) still title-dedupe.
      if (!!ak && !!kak && kak !== ak && (k.status === "done" || k.status === "dismissed")) return false;
      return sameTask(k, t);
    });
    if (i >= 0) kept[i] = betterOf(kept[i], t);
    else kept.push(t);
  }
  return kept;
}

/** Cross-device/instance task merge (used by session commits AND the session-free job runner). The
 *  more-PROGRESSED copy wins (done never regresses); equal progress → most recently UPDATED wins; step
 *  done-state is unioned. Then entity-dedupe, since two sessions can mint different ids for one item. */
export function mergeTaskLists(existing: WebTask[], incoming: WebTask[]): WebTask[] {
  const rank = (s: WebTask["status"]) => rankStatus({ status: s } as WebTask);
  const when = (t: WebTask) => Date.parse(t.updatedAt || t.createdAt || "") || 0;
  const map = new Map<string, WebTask>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) {
    const ext = map.get(t.id);
    if (!ext) { map.set(t.id, t); continue; }
    const winner = rank(t.status) > rank(ext.status) ? t
      : rank(t.status) < rank(ext.status) ? ext
      : when(t) >= when(ext) ? t : ext;
    const loser = winner === t ? ext : t;
    const steps = winner.steps?.map((s) => {
      if (s.done) return s;
      const other = loser.steps?.find((o) => o.text === s.text);
      return other?.done ? { ...s, done: true, doneAt: other.doneAt, result: s.result ?? other.result } : s;
    });
    map.set(t.id, steps ? { ...winner, steps } : winner);
  }
  return dedupeTasks(Array.from(map.values()));
}

/** Cross-device profile merge: entity-level fact dedupe; `paused` follows the most RECENT toggle. */
export function mergeProfileStates(p1: Profile, p2: Profile): Profile {
  const pausedAt = (p: Profile) => Date.parse(p.pausedAt || "") || 0;
  const pausedSide = pausedAt(p2) >= pausedAt(p1) ? p2 : p1;
  return {
    name: p2.name || p1.name,
    about: p2.about || p1.about,
    preferences: dedupeFacts([...(p1.preferences || []), ...(p2.preferences || [])]),
    people: dedupeFacts([...(p1.people || []), ...(p2.people || [])]),
    projects: dedupeFacts([...(p1.projects || []), ...(p2.projects || [])]),
    paused: pausedSide.paused,
    pausedAt: pausedSide.pausedAt,
    // Keep the MOST RECENT sweep marker across devices/instances (a stale copy must never reset it).
    lastSweepAt: (Date.parse(p2.lastSweepAt || "") || 0) >= (Date.parse(p1.lastSweepAt || "") || 0) ? (p2.lastSweepAt ?? p1.lastSweepAt) : (p1.lastSweepAt ?? p2.lastSweepAt),
    lastForcedAt: (Date.parse(p2.lastForcedAt || "") || 0) >= (Date.parse(p1.lastForcedAt || "") || 0) ? (p2.lastForcedAt ?? p1.lastForcedAt) : (p1.lastForcedAt ?? p2.lastForcedAt),
    // Structured settings: explicit ?? picks (a plain {...p2} spread would clobber p1's values with
    // p2's explicit `undefined` keys from normalizeProfile — the bug that silently dropped workingHours).
    workingHours: p2.workingHours ?? p1.workingHours,
    responseStyle: p2.responseStyle ?? p1.responseStyle,
    autoApprove: p2.autoApprove ?? p1.autoApprove,
    highPriorityPeople: p2.highPriorityPeople ?? p1.highPriorityPeople,
    autoArchivePatterns: p2.autoArchivePatterns ?? p1.autoArchivePatterns,
    // Usage counters are monotonic — take the MAX of each field so a stale copy can't reset the total
    // (a concurrent increment on another instance may under-count by one delta; fine for a display metric).
    usage: (p1.usage || p2.usage) ? {
      in: Math.max(p1.usage?.in || 0, p2.usage?.in || 0),
      out: Math.max(p1.usage?.out || 0, p2.usage?.out || 0),
      runs: Math.max(p1.usage?.runs || 0, p2.usage?.runs || 0),
      since: [p1.usage?.since, p2.usage?.since].filter(Boolean).sort()[0] || new Date().toISOString(),
    } : undefined,
  };
}

/**
 * Regenerate from the user's connected apps (the agent reads Gmail + Calendar via Composio), preserving
 * manual tasks and anything already run. Dedupe is ANCHOR-based (the agent returns a stable anchorKey like
 * "gmail:<threadId>"), so the same email/meeting never resurfaces just because the model reworded the title
 * — with a near-duplicate-title fallback for tasks that aren't tied to one item.
 */
// Ceiling on how many genuinely NEW cards one sweep may add — a short list the user trusts beats a
// complete one they ignore. Anything past the top 8 by score is dropped (it'll resurface tomorrow if
// it still matters).
const MAX_NEW_PER_SWEEP = 8;

/** Deterministic post-classification quality bar — the model SUGGESTS urgency/importance, code DECIDES
 *  what's worth a card: real scores, a VIP's ask, or a deadline'd commitment. "Maybe useful" dies here. */
export function applyQualityBar<T extends { anchorKey?: string; when?: string; urgency: number; importance: number }>(
  genTasks: T[],
  items: { anchorKey: string; labels: string[]; sender?: string }[],
  vips: string[] = [],
): T[] {
  const byAnchor = new Map(items.map((i) => [normKey(i.anchorKey), i]));
  const vipTokens = vips.flatMap((v) => {
    const email = v.toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const name = v.split(/[—\-(,]/)[0].trim().toLowerCase();
    return [email, name.length >= 3 ? name : undefined].filter((x): x is string => !!x);
  });
  const isVip = (sender?: string) => !!sender && vipTokens.some((tok) => sender.toLowerCase().includes(tok));
  return genTasks.filter((g) => {
    const it = byAnchor.get(normKey(g.anchorKey));
    if (it?.labels?.includes("sent") && g.when) return true;  // a commitment THEY made, with a deadline: always keep
    if (isVip(it?.sender)) return true;                        // high-priority person's ask: always keep
    // The classifier is ALREADY the judgment layer — and a SELECTIVE one (typically a handful out of
    // dozens of candidates). So this is only a last-ditch safety net against the model contradicting its
    // own "actionable" verdict with a near-zero score: drop a task ONLY when it scored trivial on BOTH
    // axes. Scoring is mildly non-deterministic run to run, so a tight floor (0.45) would flip a genuine
    // "reply awaited" task in and out of the list across sweeps — keep the floor low and trust the
    // classifier's inclusion decision; scores drive RANKING, not survival.
    return g.importance >= 0.35 || g.urgency >= 0.35;
  });
}

/** Local calendar day (YYYY-MM-DD) of an instant in the user's timezone — for the once-per-day force gate.
 *  Duplicated tiny helper (not imported from jobs.ts) to avoid a circular module dependency. */
function localDayOf(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}
/** Have we NOT yet forced a daily-minimum task in the user's current local day? */
function forcedDueToday(profile: Profile, now: Date = new Date()): boolean {
  if (!profile.lastForcedAt) return true;
  const tz = profile.workingHours?.timezone;
  return localDayOf(profile.lastForcedAt, tz) !== localDayOf(now.toISOString(), tz);
}

export async function generate(existing: WebTask[], profile: Profile, extras?: AgentTools, userEmail?: string): Promise<WebTask[]> {
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
  // …and what's currently ACTIVE, so the sweep reports only DELTAS instead of rebuilding the world —
  // the top source of near-duplicates and wasted submit tokens.
  const active = existing
    .filter((t) => t.status !== "done" && t.status !== "dismissed")
    .map((t) => ({ title: t.title, anchorKey: t.anchorKey }));

  // PREFERRED PATH — the deterministic discovery pipeline: fixed read calls → normalize → filter noise +
  // known anchors → ONE classification call. Cheaper, grounded (anchors come from the source, never the
  // model), and deterministic about noise. Falls back to the open agent sweep only when the pipeline's
  // sources are unreachable (e.g. Gmail not connected).
  if (userEmail) {
    try {
      const { items, attempted } = await discoverSourceItems(userEmail);
      if (attempted) {
        const knownAnchors = existing.map((t) => t.anchorKey);
        const candidates = filterCandidates(items, knownAnchors);
        const classified = candidates.length
          ? await classifyCandidates(candidates, profile, active.map((a) => a.title))
          : { tasks: [], profileUpdates: [] as ProfileUpdate[] };
        addUsage(profile, (classified as { tokens?: { in: number; out: number } }).tokens);
        // The classification pass also LEARNS: durable facts these items revealed (a key person, an
        // ongoing project) fold straight into the profile — memory keeps growing on every sweep.
        for (const u of classified.profileUpdates) applyProfileUpdate(profile, u);
        // Model suggests scores; CODE decides what clears the bar (VIPs + deadline'd commitments always do).
        const kept = applyQualityBar(classified.tasks, candidates, profile.highPriorityPeople || []);
        const folded = foldGenerated(existing, kept, profile.highPriorityPeople || []);
        // Pipeline visibility: where do candidates go? A sudden "0 new" is now diagnosable at a glance —
        // was it the classifier (classified 0), the quality bar (kept 0), or dedupe (folded == existing).
        const newCards = folded.filter((t) => t.status === "ready" && !existing.some((e) => e.id === t.id)).length;
        console.log(`${new Date().toISOString()} [tasks] sweep pipeline: ${items.length} items → ${candidates.length} candidates → ${classified.tasks.length} classified → ${kept.length} passed bar → ${newCards} new card${newCards === 1 ? "" : "s"}`);
        // DAILY MINIMUM — "at least one task a day": if this sweep surfaced nothing new AND we haven't
        // already forced a task in the user's current local day, pick the single most useful candidate and
        // add it. Gated once-per-local-day (lastForcedAt) so repeated manual refreshes don't pile up, and
        // only when there ARE candidates to choose from. The forced pick still folds through dedupe.
        if (newCards === 0 && candidates.length && forcedDueToday(profile)) {
          const one = await pickOneTask(candidates, profile, active.map((a) => a.title));
          if (one) {
            addUsage(profile, one.tokens);
            profile.lastForcedAt = new Date().toISOString();
            const withForced = foldGenerated(existing, [...kept, one.task], profile.highPriorityPeople || []);
            const forcedNew = withForced.filter((t) => t.status === "ready" && !existing.some((e) => e.id === t.id)).length;
            console.log(`${new Date().toISOString()} [tasks] daily-minimum: forced "${one.task.title}" (${forcedNew} new after fold)`);
            return withForced;
          }
        }
        return folded;
      }
    } catch (e: any) { console.warn("[tasks] discovery pipeline failed, falling back to agent sweep:", e?.message || e); }
  }

  // FALLBACK — open-ended agent sweep over the read-only tool view (covers non-Google sources too).
  const gen = await generateTasks(profile, extras ? readOnly(extras) : undefined, handled, active);
  addUsage(profile, gen.tokens);
  for (const u of gen.profileUpdates) applyProfileUpdate(profile, u);
  return foldGenerated(existing, gen.tasks, profile.highPriorityPeople || []);
}

/** Pure post-processing of a sweep's output: absorb duplicates into the existing list, cap genuinely NEW
 *  cards at MAX_NEW_PER_SWEEP (top by score), prune old handled records. Split out so it's unit-testable
 *  without an AI call. */
export function foldGenerated(existing: WebTask[], genTasks: { title: string; why: string; when?: string; source: string; risk: "low" | "high"; urgency: number; importance: number; anchorKey?: string; link?: string; accountId?: string }[], highPriorityPeople: string[] = []): WebTask[] {
  const now = new Date().toISOString();
  // DISMISSED = "I don't want this" — suppress not just the exact item but anything SIMILAR to it, with a
  // deliberately looser match (incl. cross-field title↔why) than the live-task dedupe. A false positive
  // here only hides a card resembling one the user already rejected; a false negative resurfaces it.
  // (Done tasks keep the stricter matching — a NEW similar task after a finished one is often legit,
  // e.g. this week's edition of a recurring report.)
  const dismissed = existing.filter((t) => t.status === "dismissed");
  const resemblesDismissed = (g: { title: string; why: string; source: string; anchorKey?: string; link?: string }) =>
    dismissed.some((d) =>
      (!!g.anchorKey && !!d.anchorKey && normKey(g.anchorKey) === normKey(d.anchorKey)) ||
      (!!g.link && linkOf(d) === g.link) ||
      looseDup(g.title, d.title) || looseDup(g.title, d.why) || looseDup(g.why, d.title) ||
      (g.source === d.source && looseDup(g.why, d.why)));
  genTasks = genTasks.filter((g) => !resemblesDismissed(g));

  const candidates: WebTask[] = [...existing];
  const freshIds = new Set<string>();
  for (const g of genTasks) {
    const e = eisenhower(g.urgency, g.importance);
    const evidence: TaskLink[] | undefined = g.link ? [{ label: g.source === "calendar" ? "Open event" : g.source === "gmail" ? "Open in Gmail" : g.source === "github" ? "Open on GitHub" : "Open source", url: g.link }] : undefined;
    const id = randomUUID();
    freshIds.add(id);
    candidates.push({
      id, title: g.title, why: g.why, when: g.when, source: g.source, risk: g.risk, sourceAccountId: g.accountId,
      urgency: g.urgency, importance: g.importance, quadrant: e.quadrant, score: e.score,
      status: "ready", createdAt: now, anchorKey: g.anchorKey, evidence,
    });
  }
  const deduped = dedupeTasks(candidates);
  // A fresh id that SURVIVED dedupe is a genuinely new card (duplicates were absorbed into existing
  // entries, which keep their old ids). Cap those at the top MAX_NEW_PER_SWEEP by score.
  const keepNew = new Set(
    deduped.filter((t) => freshIds.has(t.id)).sort((a, b) => b.score - a.score).slice(0, MAX_NEW_PER_SWEEP).map((t) => t.id));
  const calmed = deduped.filter((t) => !freshIds.has(t.id) || keepNew.has(t.id));
  // Eisenhower ranking with deadline/VIP/freshness tie-breaks (was: bare score sort).
  return pruneHandled(sortWithinQuadrant(calmed, highPriorityPeople), 120);
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
    ...(refined ? {} : { unrefined: true }), // AI paused/unavailable — raw text in, offer Refine later
  });
  return list;
}

/** Refine an existing unrefined manual task in place (the "Refine" action once AI is back). */
export function applyRefinement(list: WebTask[], id: string, refined: RefinedTask | null): WebTask | undefined {
  const t = list.find((x) => x.id === id);
  if (!t || !refined) return t;
  t.title = refined.title.trim().slice(0, 120) || t.title;
  t.why = refined.why || t.why;
  t.when = refined.when ?? t.when;
  t.urgency = refined.urgency;
  t.importance = refined.importance;
  const e = eisenhower(t.urgency, t.importance);
  t.quadrant = e.quadrant;
  t.score = e.score;
  delete t.unrefined;
  t.updatedAt = new Date().toISOString();
  return t;
}

/**
 * Run a task: the agent gathers facts and does the reversible work itself through the user's connected apps
 * (drafts a reply, creates a doc/deck/sheet, adds a task/event, updates an issue — never an irreversible
 * send/delete), then the task shows its context, a synthesis of what it did, and a checklist of what's left.
 */
type Artifact = NonNullable<WebTask["artifacts"]>[number];
/** Pull artifact ids out of a run's output: doc/sheet/slides links + gmail draft / calendar event sendables. */
export function extractArtifacts(out: { links?: TaskLink[]; sendables?: Sendable[] }): Artifact[] {
  const found: Artifact[] = [];
  for (const l of out.links || []) {
    const m = DOC_LINK.exec(l.url);
    if (m) found.push({ kind: m[1] === "spreadsheets" ? "sheet" : m[1] === "presentation" ? "slides" : "doc", id: m[2], url: l.url, label: l.label });
  }
  for (const s of out.sendables || []) {
    if (s.app === "gmail" && s.draftId) found.push({ kind: "draft", id: s.draftId, label: s.label });
    if (s.app === "gcal" && s.eventId) found.push({ kind: "event", id: s.eventId, label: s.label });
  }
  return found;
}
/** Union by id — a rerun keeps knowing about the artifacts earlier runs made. */
export function unionArtifacts(prior: Artifact[] | undefined, fresh: Artifact[]): Artifact[] | undefined {
  const map = new Map<string, Artifact>();
  for (const a of [...(prior || []), ...fresh]) if (a?.id) map.set(a.id, { ...map.get(a.id), ...a });
  const all = [...map.values()].slice(-12); // bounded — a task never accumulates unbounded artifact history
  return all.length ? all : undefined;
}

export async function runById(list: WebTask[], id: string, profile: Profile, extras?: AgentTools, revision?: string): Promise<WebTask | undefined> {
  const task = list.find((t) => t.id === id);
  if (!task) return undefined;
  if (canonStatus(task.status) === "executing") return task; // already in flight — never double-run
  task.status = "executing";
  task.autoRan = true; // set before the await so concurrent auto-runs skip it (pendingAutoRun checks !autoRan)
  // A user revision: they reviewed a draft and asked for a change before sending → re-run with that instruction.
  const focus = revision?.trim()
    ? `The user reviewed your previous draft/output for this task and wants this CHANGE before they send it: "${revision.trim()}". Redo the task incorporating it — UPDATE the existing draft/doc (don't create a new copy) and re-offer it as a sendable.`
    : undefined;
  try {
    // Rerun/revision: Otto may UPDATE the artifacts it made for this task (never the user's own docs) —
    // that's what turns "redo" into an edit instead of a duplicate. MUST happen BEFORE scopeTools: the
    // carve-out view's call() closes over the full toolset; scoping narrows `.tools` while preserving
    // whatever `.call` it's given, so scoping-after-carve-out keeps both properties. The reverse order
    // silently discards the scoping (its closure reopens the full toolset) — do not reorder this.
    const priorArtifactIds = (task.artifacts || []).map((a) => a.id);
    const withArtifacts = extras?.withAllowedArtifacts && priorArtifactIds.length ? extras.withAllowedArtifacts(priorArtifactIds) : extras;
    const scoped = withArtifacts ? scopeTools(withArtifacts, task) : undefined;
    if (extras && scoped) console.log(`[tasks] run "${task.title.slice(0, 40)}": ${scoped.tools.length}/${extras.tools.length} tools after scoping`);
    const out = await aiRun({ title: task.title, why: task.why, source: task.source, links: task.links, artifacts: task.artifacts }, profile, focus, scoped);
    // Fold anything the agent learned about the user into the profile.
    for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
    task.context = out.context;
    task.synthesis = out.synthesis;
    task.did = out.did?.length ? out.did : undefined;
    // A re-run (Redo / revision) must NOT forget which steps the user already completed: carry each
    // prior step's done/doneAt/result onto the matching new step (matched by near-duplicate text).
    const prior = (task.steps || []).filter((s) => s.done);
    task.steps = (out.steps || []).map((s) => {
      const old = prior.find((o) => nearDup(o.text, s.text));
      return old ? { ...s, done: true, doneAt: old.doneAt, result: s.result || old.result } : s;
    });
    task.links = out.links?.length ? out.links : undefined; // links to the draft/doc/event it made, so the user can open it
    task.sendables = out.sendables?.length ? out.sendables : undefined; // drafts the user can send in one click
    task.artifacts = unionArtifacts(task.artifacts, extractArtifacts(out));
    task.lastRunTokens = out.tokens;
    addUsage(profile, out.tokens);
    // Spin off DISTINCT new obligations the run discovered as their OWN tasks — so Otto plans + works each
    // fully (as if freshly generated) instead of burying it as a one-line step. Deduped against the list;
    // inherits the source account so its own execution routes to the right inbox. The job layer auto-runs them.
    for (const f of out.followUps || []) {
      if (!f.title || list.some((x) => !isHandled(x.status) && nearDup(x.title, f.title))) continue;
      const e = eisenhower(0.5, 0.6);
      list.push({
        id: randomUUID(), title: f.title.slice(0, 120), why: f.why || `Follow-up from "${task.title}"`,
        source: task.source, risk: "low", urgency: 0.5, importance: 0.6, quadrant: e.quadrant, score: e.score,
        status: "ready", createdAt: new Date().toISOString(), sourceAccountId: task.sourceAccountId,
      });
    }
    task.status = "needs_review";
    task.lastError = undefined;
    task.updatedAt = new Date().toISOString();
    return task;
  } catch (e: any) {
    // Failure (AI/Composio error) → never leave it stuck on "executing". The JOB layer decides
    // retryable-vs-terminal from its attempt count; record the failure on the task for display.
    task.status = "failed_retryable";
    task.lastError = String(e?.message || e).slice(0, 300);
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
  addUsage(profile, out.tokens);
  for (const u of out.profileUpdates || []) applyProfileUpdate(profile, u);
  step.result = out.synthesis.slice(0, 1200);
  // If the focused run still needs the user (it returned a needs-you step), it couldn't finish — flip this step
  // to needs-you so it shows honestly (not a false ✓) and won't auto-retry; otherwise mark it done.
  // EXCLUDE synthetic backstop steps (finalize's deterministic "Review <artifact>" nudge) — those exist to
  // give the TOP-level task a checklist entry, not to say this focused step run failed to finish.
  if ((out.steps || []).some((s) => !s.automatable && !s.synthetic)) { step.automatable = false; step.done = false; }
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
