// ASSISTANCE LEDGER + KNOWLEDGE STATES + RECAP — pure, built from what code saw (turn records, verdicts, the board),
// never from what the model claims. Help at support ≥ 4 is logged against the skill; a later UNAIDED success on that
// skill settles it (transfer), and until then the skill counts as "assisted", never "independent".
import type { AssistanceEntry, BoardEntry, TaskObjective, TutorTurnRecord } from "../../shared/types.ts";

export const LEDGER_CAP = 50;
const RETEST_AFTER_MS = 12 * 3600 * 1000; // "next session": not in the same sitting

export function logAssistance(ledger: AssistanceEntry[] | undefined, e: { skill: string; level: number; now: Date }): AssistanceEntry[] {
  if (e.level < 4 || !e.skill) return ledger || [];
  const l = ledger || [];
  // one open entry per skill: more help on a skill that's already pending doesn't stack
  if (l.some((x) => x.skill === e.skill && x.status === "pending" && e.now.getTime() - Date.parse(x.at) < RETEST_AFTER_MS)) return l;
  return [...l, { skill: e.skill, level: e.level, at: e.now.toISOString(), status: "pending" as const }].slice(-LEDGER_CAP);
}

/** An independent success on a skill settles its oldest pending help — but only once the help is old enough to count as a retest. */
export function settleRetest(ledger: AssistanceEntry[] | undefined, skill: string, unaided: boolean, now: Date): { ledger: AssistanceEntry[]; settled: boolean } {
  const l = ledger || [];
  if (!unaided) return { ledger: l, settled: false };
  const i = l.findIndex((x) => x.skill === skill && x.status === "pending" && now.getTime() - Date.parse(x.at) >= RETEST_AFTER_MS);
  if (i < 0) return { ledger: l, settled: false };
  return { ledger: l.map((x, j) => (j === i ? { ...x, status: "passed" as const, settledAt: now.toISOString() } : x)), settled: true };
}

export function dueRetests(ledger: AssistanceEntry[] | undefined, now: Date): AssistanceEntry[] {
  return (ledger || []).filter((x) => x.status === "pending" && now.getTime() - Date.parse(x.at) >= RETEST_AFTER_MS);
}

export type KnowledgeState = "not_assessed" | "introduced" | "assisted" | "independent" | "repeated" | "review_due";

/** Per-skill state from evidence counts. Explaining something never raises it above "introduced". */
export function knowledgeState(ev: { unaided: number; assisted: number; mistakes: number; pendingRetest?: boolean; seen: boolean }): KnowledgeState {
  if (ev.pendingRetest && ev.unaided === 0) return "review_due";
  if (ev.unaided >= 2) return "repeated";
  if (ev.unaided === 1) return "independent";
  if (ev.assisted > 0) return "assisted";
  return ev.seen ? "introduced" : "not_assessed";
}

export interface Recap {
  learned: string[];
  canDoAlone: string[];
  canDoWithHelp: string[];
  mistakes: string[];
  keyLines: string[];
  gaps: string[];
  next: string;
  retrieval?: string;
}

/** The recap, every line traceable to a record or the board. `lang` only picks the wording of the fixed phrases. */
export function buildRecap(i: { log: TutorTurnRecord[]; board: BoardEntry[]; objectives?: TaskObjective[]; lang: "fr" | "en" }): Recap {
  const en = i.lang === "en";
  const log = i.log || [];
  const done = (i.objectives || []).filter((o) => (o as any).done || (o as any).status === "done").map((o) => o.label);
  const open = (i.objectives || []).filter((o) => !((o as any).done || (o as any).status === "done")).map((o) => o.label);
  const fixed = log.filter((r) => r.diagnosis && /misconception|slip|partial/.test(r.diagnosis)).length;
  const solvedAlone = log.filter((r) => r.verdict === "correct" && r.support <= 2).length;
  const solvedHelped = log.filter((r) => r.verdict === "correct" && r.support > 2).length;
  const wrong = log.filter((r) => r.verdict === "incorrect").length;
  const lines = i.board.filter((b) => (b.kind === "result" || b.kind === "formula") && b.text).map((b) => String(b.text)).slice(-4);
  // (The board never carries the student's own lines any more: steps they got right alone are the correct answer boxes — old stored boards may still hold student lines.)
  const mine = i.board.filter((b) => b.status === "correct" && (b.kind === "gap" || b.owner === "student")).length;
  return {
    learned: done,
    canDoAlone: solvedAlone || mine ? [`${Math.max(solvedAlone, mine)} step(s) solved on your own`] : [],
    canDoWithHelp: solvedHelped ? [`${solvedHelped} step(s) solved with Otto's help`] : [],
    mistakes: [...new Set(log.map((r) => r.misconception).filter((m): m is string => !!m))].slice(0, 4).map((m) => (`Misconception worked on: ${m}`)).concat(wrong || fixed ? [`${Math.max(wrong, fixed)} slip(s) or misconception(s) worked through`] : []),
    keyLines: lines,
    gaps: open,
    next: open[0]
      ? (`Next: ${open[0]}`)
      : solvedAlone > 0 ? ("Next: try a similar problem with new numbers, alone.")
      : ("Next: redo the last step on your own."),
  };
}

/** One short line for the profile's session notes (what Otto "knows about you"), built from the code-made recap only:
 *  objective labels, misconception labels, the next step. Never the student's own words. null when nothing happened. */
export function sessionMemoryNote(subject: string | undefined, recap: Pick<Recap, "learned" | "gaps" | "mistakes" | "next">): string | null {
  const bits: string[] = [];
  if (recap.learned.length) bits.push(`finished: ${recap.learned.slice(0, 3).join("; ")}`);
  if (recap.gaps.length) bits.push(`still to do: ${recap.gaps.slice(0, 2).join("; ")}`);
  const mis = recap.mistakes.map((m) => m.replace(/^Misconception worked on:\s*/i, "")).filter(Boolean);
  if (mis.length) bits.push(`kept tripping on: ${mis.slice(0, 2).join("; ")}`);
  if (!bits.length) return null;
  const note = `${subject ? `${subject.slice(0, 40)} — ` : ""}${bits.join(" | ")}`;
  return note.length > 280 ? note.slice(0, 279).trimEnd() + "…" : note;
}
