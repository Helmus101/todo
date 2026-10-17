// WHAT THE STUDENT WANTS FROM THIS SITTING — learned before any plan is made. A plan built from a guess is the plan that drifts
// ("a labour-market plan in a physics session"); one built from their own words (a test on Friday, energy is the hard part, 30
// minutes) is the plan they follow. Code owns when the plan may be made; the model only asks the questions and reports what it learned.
import type { SessionGoals } from "../../shared/types.ts";

const SKIP = /\b(?:just start|let'?s start|start already|skip (?:this|that|the questions)|whatever|you (?:choose|decide|pick)|pick (?:for me|something)|surprise me|don'?t (?:care|mind)|commen[cç]e|choisis|peu importe|vas-y)\b/i;

export const MAX_GOAL_QUESTIONS = 3;

export function emptyGoals(): SessionGoals { return { asked: 0 }; }

const clean = (x: unknown, n: number): string | undefined => { const t = String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n); return t || undefined; };

/** Fold what this turn learned into what was known; `asked` counts the tutor turns spent on goals so the questioning can't go on forever. */
export function mergeGoals(prev: SessionGoals | undefined, learned: Partial<SessionGoals> | undefined, askedThisTurn: boolean): SessionGoals {
  const p = prev || emptyGoals();
  const minutes = Number(learned?.minutes);
  return {
    aim: clean(learned?.aim, 160) ?? p.aim,
    deadline: clean(learned?.deadline, 60) ?? p.deadline,
    hard: clean(learned?.hard, 160) ?? p.hard,
    ...(Number.isFinite(minutes) && minutes > 0 ? { minutes: Math.min(600, Math.round(minutes)) } : p.minutes ? { minutes: p.minutes } : {}),
    asked: p.asked + (askedThisTurn ? 1 : 0),
  };
}

/** May the plan be made now? Yes when a plan already exists, they told us to just start, we know what they're after AND one more fact
 *  about it (when it's due, what's hard, how long they have) or we have asked enough. */
export function goalsKnown(goals: SessionGoals | undefined, message: string, hasObjectives: boolean): boolean {
  if (hasObjectives) return true;
  if (SKIP.test(String(message || ""))) return true;
  const g = goals || emptyGoals();
  if (g.asked >= MAX_GOAL_QUESTIONS) return true;
  return !!g.aim && !!(g.deadline || g.hard || g.minutes || g.asked >= 2);
}

export function goalsLine(goals: SessionGoals | undefined): string {
  const g = goals || emptyGoals();
  const known = [g.aim && `wants: ${g.aim}`, g.deadline && `when: ${g.deadline}`, g.hard && `hardest: ${g.hard}`, g.minutes && `time: ${g.minutes} min`].filter(Boolean);
  return known.length ? known.join("; ") : "nothing yet";
}
