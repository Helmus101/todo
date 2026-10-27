// The four evidence states a concept can be in, from the student model's counters. The label is what Otto and the student see; the
// underlying 0-1 estimate stays separate. A topic is never "mastered" because the student said they understood it: it takes
// unaided successes, and "retained" takes a success on a delayed check.
export type MasteryState = "not_assessed" | "developing" | "provisional" | "retained";

export interface MasteryCounters {
  attempts: number; unaided: number; transferWins?: number; recalls?: number; recallWins?: number;
  misconceptions?: { retiredAt?: string }[];
}

export const MASTERY_LABEL: Record<MasteryState, string> = {
  not_assessed: "Not assessed yet", developing: "Developing", provisional: "Provisional mastery", retained: "Retained",
};

export function masteryState(r: MasteryCounters): MasteryState {
  const recalls = r.recalls || 0;
  if (!r.attempts && !recalls) return "not_assessed";
  const liveMisconception = (r.misconceptions || []).some((m) => !m.retiredAt);
  const independent = r.attempts > 0 ? r.unaided / r.attempts : 0;
  if ((r.recallWins || 0) >= 1 && r.unaided >= 2 && !liveMisconception) return "retained";
  if (r.unaided >= 2 && independent >= 0.6 && !liveMisconception) return "provisional";
  return "developing";
}
