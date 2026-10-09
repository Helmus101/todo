// THE BOARD EVENT STREAM — spec §12: "the trajectory can be more informative than the final answer."
//
// Otto could already see what is CURRENTLY on the board, but not what HAPPENED on it: that a student wrote
// F = ma, erased it, rewrote it as ΣF = ma, then added friction and removed it again says far more about
// their reasoning than the final line does — and it was completely invisible.
//
// The events are DERIVED app-side by diffing the previously-persisted board against the one the client just
// sent (spec §13 asks for an event stream rather than shipping the whole board to the model on every action;
// this gets the same signal for zero model cost and zero new client protocol), plus the pedagogical events
// the app already observes directly: an objective ticked, a problem answered, an answer given on the board.
//
// Everything here is pure: no I/O, no clock of its own, so the diffing is unit-testable without a server.
import type { BoardEntry, TaskObjective, TaskProblem } from "../shared/types.ts";
import { BOARD_EVENT_CAP, type BoardEventKind, type BoardEventShape } from "../shared/agentTypes.ts";

/** One meaningful thing that happened on the page. `detail` is the human-readable trace the prompt reads;
 *  `entryId` links back to the entry for the client's trajectory view. The shape is shared so the client can
 *  render the trajectory without importing server code. */
export type BoardEvent = BoardEventShape;
export type { BoardEventKind };
/** Cap on the retained stream — a session-scale signal (the last few minutes of work), not an archive; a
 *  whole-term history would be noise in the prompt and growth on the profile row. */
export { BOARD_EVENT_CAP };
/** How many events the prompt block actually shows. The tail is what's relevant; the head is context. */
export const TRAJECTORY_LINES = 14;

/** Content fingerprint for change detection: the kind plus whitespace-collapsed, case-folded text. Deliberately
 *  insensitive to formatting so re-rendering the same working (a MathText pass, a re-flow) never registers as
 *  an edit, while a real rewrite — a sign change, a new term — does. */
export function boardFingerprint(entry: { kind?: string; text?: string; diagram?: unknown[]; outline?: unknown[] }): string {
  const body = [
    entry.text || "",
    Array.isArray(entry.diagram) && entry.diagram.length ? `ops:${JSON.stringify(entry.diagram)}` : "",
    Array.isArray(entry.outline) && entry.outline.length ? `outline:${JSON.stringify(entry.outline)}` : "",
  ].join("|");
  return `${entry.kind || "note"}::${body.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** A short, quote-free label for an entry inside a trajectory line. */
function label(entry: { text?: string }): string {
  return String(entry.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Diff the previously-persisted board against the incoming one.
 *
 *  Identity is by `id` where both sides have one (that's what the client sends back), and by fingerprint when
 *  an entry arrives without an id — a re-sent board after a reload legitimately comes back id-less. A changed
 *  fingerprint on the same id is an edit; an id that disappears is an erase, which §12 is explicit about
 *  wanting surfaced rather than silently dropped. */
export function diffBoard(prev: BoardEntry[] | undefined, next: BoardEntry[] | undefined, now: Date = new Date()): BoardEvent[] {
  const before = prev || [];
  const after = next || [];
  if (!before.length && !after.length) return [];
  const at = now.toISOString();
  const events: BoardEvent[] = [];
  const beforeById = new Map(before.filter((e) => e.id).map((e) => [e.id, e]));
  const afterById = new Map(after.filter((e) => e.id).map((e) => [e.id, e]));
  const beforePrints = new Set(before.map(boardFingerprint));

  // Removals first, so a rewrite reads as "erased X, wrote Y" in the right order rather than "wrote Y, erased X".
  for (const e of before) {
    const stillHere = e.id ? afterById.get(e.id) : after.find((n) => boardFingerprint(n) === boardFingerprint(e));
    if (stillHere) continue;
    events.push({ at, kind: "erased", ...(e.id ? { entryId: e.id } : {}), detail: `removed ${e.owner === "student" ? "their own" : "your"} entry "${label(e)}"` });
  }
  for (const e of after) {
    const old = e.id ? beforeById.get(e.id) : before.find((n) => boardFingerprint(n) === boardFingerprint(e));
    if (!old) {
      const who = e.owner === "student" ? "the student wrote" : "you wrote";
      events.push({ at, kind: e.owner === "student" ? "student-wrote" : "otto-wrote", ...(e.id ? { entryId: e.id } : {}), detail: `${who} "${label(e)}"` });
      continue;
    }
    if (boardFingerprint(old) === boardFingerprint(e)) continue;
    events.push({ at, kind: "rewrote", ...(e.id ? { entryId: e.id } : {}), detail: `${e.owner === "student" ? "the student rewrote their entry" : "you rewrote your entry"} from "${label(old)}" to "${label(e)}"` });
  }
  // A board that arrives id-less and unchanged should not read as a page of brand-new work: the fingerprint
  // set above already covers the common case, and an unchanged id-less board produces create+erase pairs that
  // would double-count — collapse that specific pairing back to "unchanged".
  const unchangedIdless = !before.some((e) => e.id) && !after.some((e) => e.id) && before.length === after.length && after.every((e) => beforePrints.has(boardFingerprint(e)));
  return unchangedIdless ? [] : events;
}

/** Objective transitions — the app already knows precisely which items flipped, so this is read rather than
 *  inferred. Ticking an objective is real evidence about the student (spec §47's mastery column). */
export function objectiveEvents(prev: TaskObjective[] | undefined, next: TaskObjective[] | undefined, now: Date = new Date()): BoardEvent[] {
  const before = new Map((prev || []).map((o) => [o.label.toLowerCase(), o.done]));
  const out: BoardEvent[] = [];
  for (const o of next || []) {
    if (!o.done) continue;
    const was = before.get(o.label.toLowerCase());
    if (was === true) continue; // already done — no new event, and no double-counted evidence
    out.push({ at: now.toISOString(), kind: "objective-done", detail: `demonstrated: ${o.label.slice(0, 120)}` });
  }
  return out;
}

/** Problem transitions: creation, and a first-time solve. `answeredWrong` is passed separately by the client
 *  path (it knows the attempt outcome) since a wrong answer isn't a state change on the problem itself. */
export function problemEvents(prev: TaskProblem[] | undefined, next: TaskProblem[] | undefined, now: Date = new Date()): BoardEvent[] {
  const at = now.toISOString();
  const beforeIds = new Set((prev || []).map((p) => p.id));
  const beforeSolved = new Set((prev || []).filter((p) => p.solved).map((p) => p.id));
  const out: BoardEvent[] = [];
  for (const p of next || []) {
    if (!beforeIds.has(p.id)) out.push({ at, kind: "problem-created", detail: `set a problem: "${p.question.replace(/\s+/g, " ").slice(0, 100)}"` });
    else if (p.solved && !beforeSolved.has(p.id)) out.push({ at, kind: "problem-solved", detail: `solved: "${p.question.replace(/\s+/g, " ").slice(0, 100)}"` });
  }
  return out;
}

/** Append events to a task's stream, capped. Returns the new array (callers store the return value). */
export function recordBoardEvents(existing: BoardEvent[] | undefined, incoming: BoardEvent[]): BoardEvent[] {
  if (!incoming.length) return existing || [];
  return [...(existing || []), ...incoming].slice(-BOARD_EVENT_CAP);
}

/** Relative recency wording. Deliberately not clock times: the server has no reliable view of the student's
 *  wall clock, and a wrong "10:32" in the prompt is worse than an honest "a few minutes ago". */
function when(at: string, now: Date): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "earlier";
  const mins = (now.getTime() - t) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 6) return "a few minutes ago";
  if (mins < 25) return "earlier this session";
  if (mins < 120) return "about an hour ago";
  return "earlier";
}

/** THE TRAJECTORY BLOCK (spec §12).
 *
 *  Only emitted when there is something worth saying — a trajectory that's just "you wrote three things" adds
 *  prompt weight without insight, so the block stays silent unless the page shows a student action, an erase,
 *  or a rewrite. The prompt is told explicitly what to DO with it, because a raw log invites the model to
 *  narrate the log back at the student, which is exactly the wrong behaviour. */
export function boardTrajectoryBlock(events: BoardEvent[] | undefined, opts: { now?: Date; limit?: number } = {}): string {
  const now = opts.now || new Date();
  const all = events || [];
  const interesting = all.filter((e) => e.kind !== "otto-wrote" || all.some((x) => x.kind === "rewrote" || x.kind === "erased"));
  const relevant = (interesting.length ? interesting : all).slice(-(opts.limit ?? TRAJECTORY_LINES));
  if (!relevant.length) return "";
  const studentActed = relevant.some((e) => e.kind.startsWith("student-") || e.kind === "erased" || e.kind === "rewrote");
  return (
    `\nWHAT JUST HAPPENED ON THE BOARD (the trajectory, oldest first — NOT a summary of the current state; ` +
    `the moves matter, so read the erases and rewrites as reasoning, not as noise):\n` +
    relevant.map((e) => `- ${when(e.at, now)}: ${e.detail}`).join("\n") +
    (studentActed
      ? `\nA deleted entry is not a mistake to point out — a student who erases and retries is doing exactly the ` +
        `right thing. Where they rewrote something, respond to the CHANGE (why the new version is better, or ` +
        `what the old one got right) instead of restating either version. NEVER read this log back to them; ` +
        `it's your own situational awareness.\n`
      : "\n")
  );
}

/** Did the student correct themselves on the board? An erase followed by a write of the same concept is the
 *  strongest independence signal the page can produce (spec §12 + §47), so the model update reads it directly
 *  rather than guessing. Returns the concepts involved, newest first, capped. */
export function selfCorrections(events: BoardEvent[] | undefined, lookback = 12): BoardEvent[] {
  const tail = (events || []).slice(-lookback);
  return tail.filter((e, i) => e.kind === "rewrote" && tail.slice(0, i).some((p) => p.kind === "erased" || p.kind === "student-wrote"));
}

/** A compact, structured "what's on the page" surface for the prompt — the upgrade of the existing board
 *  block that makes the §11 ownership distinction visible to the tutor instead of implicit. Student-owned
 *  entries are called out because "this is my equation" vs "this is the student's proposed equation" is the
 *  distinction every diagnosis depends on. */
/** What a figure on the board SHOWS, in words — so when the student comments on something Otto drew, the tutor knows
 *  what is actually on the board (labels, equations, shapes), not just its caption. Compact on purpose. */
export function figureSummary(e: BoardEntry): string {
  if (e.kind === "diagram" && e.diagram?.length) {
    const labels = e.diagram.filter((o: any) => o.op === "label").map((o: any) => String(o.text)).slice(0, 14);
    const eqs = e.diagram.filter((o: any) => o.op === "equation").map((o: any) => String(o.latex)).slice(0, 4);
    const shapes = [...new Set(e.diagram.map((o: any) => o.op).filter((x: string) => x !== "label" && x !== "equation"))];
    return ` — FIGURE: shapes ${shapes.join(", ") || "none"}${labels.length ? `; labels: ${labels.join(", ")}` : ""}${eqs.length ? `; equations: ${eqs.join(" ; ")}` : ""}`.slice(0, 420);
  }
  if (e.kind === "graph" && e.graph) return ` — GRAPH: ${(e.graph.fns || []).map((f) => f.expr).join(", ") || e.graph.kind || ""}`.slice(0, 200);
  if (e.kind === "svg" && e.svg) return ` — FIGURE (svg): labels: ${e.svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`;
  if (e.kind === "flow" && e.flow) return ` — DIAGRAM (${e.flow.type}): ${e.flow.nodes.map((n) => n.label).join(" → ")}`.slice(0, 360);
  if (e.kind === "widget" && e.widget) return ` — ACTIVITY: ${e.widget.type}`;
  return "";
}

export function boardSurfaceBlock(entries: BoardEntry[] | undefined, problems: TaskProblem[] | undefined, opts: { limit?: number } = {}): string {
  const board = (entries || []).slice(-(opts.limit ?? 40));
  const probs = (problems || []).slice(-8);
  if (!board.length && !probs.length) return "";
  const lines: string[] = [];
  for (const [i, e] of board.entries()) {
    if (e.kind === "annotation") continue; // annotations are shown on the entry they point at, below
    const notes = board.filter((a) => a.kind === "annotation" && a.targetId && a.targetId === e.id).map((a) => `your note (${a.tone || "focus"}): ${a.text}`);
    const tags = [
      `#${i + 1}`,
      ...notes,
      e.owner === "student" ? "STUDENT'S WORK" : "yours",
      e.kind === "gap" ? "GAP — they must fill this" : "",
      e.status === "incorrect" ? "marked WRONG" : e.status === "correct" ? "marked correct" : "",
      e.concept ? `concept: ${e.concept}` : "",
    ].filter(Boolean);
    lines.push(`- [${e.kind || "note"}] (${tags.join("; ")}) ${e.text.slice(0, 400)}${figureSummary(e)}` +
      (e.kind === "outline" && e.outline?.length ? "\n" + e.outline.map((s) => `  · ${s.heading}: ${s.bullets.join("; ")}`).join("\n") : ""));
  }
  for (const p of probs) lines.push(`- [problem] ${p.question.slice(0, 300)}${p.options?.length ? ` (options: ${p.options.join(" / ")})` : ""}${p.solved ? " — SOLVED" : ""}`);
  return (
    `\nWHAT'S CURRENTLY ON THE BOARD (the visible surface next to this chat — you can see it, the student ` +
    `can see it, don't ask them to describe it back to you; a NEW WRITE_TO_BOARD call adds to this, it ` +
    `never replaces it). Entries marked STUDENT'S WORK are THEIRS, not yours — never rewrite, correct or ` +
    `delete one silently; respond to it in chat and let them fix it. Everything listed here is ALREADY DONE ` +
    `or already asked — never redo or re-explain it; continue from the LAST entry:\n` +
    lines.join("\n") + "\n"
  );
}

/** Tag the entries the STUDENT produced this turn. Called by the chat route when their message was an answer
 *  to something on the board (the inline answer box sends it as an ordinary chat message — see
 *  BoardArtifact's onAnswer) or when the client reports a wrong attempt. App-side attribution is the point of
 *  spec §11: the tutor must never be the one deciding which work was its own. */
export function tagStudentAnswer(entries: BoardEntry[] | undefined, text: string, opts: { at: Date; correct?: boolean; concept?: string }): BoardEntry[] | undefined {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!entries?.length || clean.length < 2) return entries;
  // Find the newest entry this answer is plausibly answering: the last gap (or any line left ending in "?").
  let targetIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "gap" || /=\s*\?\s*$/.test(e.text || "")) { targetIdx = i; break; }
  }
  if (targetIdx < 0) return entries;
  const target = entries[targetIdx];
  const status: BoardEntry["status"] = opts.correct === undefined ? undefined : opts.correct ? "correct" : "incorrect";
  const answered: BoardEntry = {
    id: `ans-${opts.at.getTime().toString(36)}-${targetIdx}`,
    text: clean.slice(0, 400),
    kind: "result",
    owner: "student",
    ...(status ? { status } : {}),
    ...(opts.concept ? { concept: opts.concept.slice(0, 80) } : target.concept ? { concept: target.concept } : {}),
    at: opts.at.toISOString(),
  };
  return [...entries, answered];
}
