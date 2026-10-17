// STAY ON THE SESSION'S TOPIC. A session has a subject and a plan; Otto must not wander into another topic (a labour-market
// plan in a physics session). The scope is the set of content words the session has actually used: the subject, the plan
// labels, the board, the problems, what the student said and — for the same subject only — what earlier sessions covered.
// A plan label, worksheet header, exercise or lead-in whose words touch none of it is off topic, unless the student asked
// for it. Pure.
import type { BoardEntry, TaskObjective, TaskProblem } from "../../shared/types.ts";

const STOP = new Set(["that","this","with","have","what","your","about","there","their","then","them","into","from","will","would","could","should","some","just","like","next","part","lets","let's","okay","right","good","great","here","step","time","back","work","going","think","thing","things","know","need","want","topic","topics","question","questions","problem","problems","exercise","exercises","switch","look","plan","session","today","examine","explore","understand","practice","review","using","given","find","calculate","explain","describe","show","which","where","when","does","make","take","give","also","more","most","very","each","other","same","only"]);

export const contentWords = (text: string): string[] =>
  (String(text || "").toLowerCase().replace(/\\[a-z]+/g, " ").match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !STOP.has(w));

export interface ScopeInput {
  subject?: string;
  objectives: TaskObjective[];
  board: BoardEntry[];
  problems: TaskProblem[];
  history: { role: string; text: string }[];
  message: string;
  /** Earlier sessions' memory, only the same subject's. */
  memory?: { subject?: string; lines?: string[]; asked?: string[]; done?: string[] }[];
}

export function sessionScope(i: ScopeInput): Set<string> {
  const texts = [
    i.subject || "",
    ...i.objectives.map((o) => o.label),
    // Only what the STUDENT or the problem itself put on the board counts: Otto's own headers and notes are exactly what drifts.
    ...i.board.slice(-60).filter((b) => b.owner === "student" || b.kind === "given").map((b) => String(b.text || "")),
    ...i.problems.map((p) => p.question || ""),
    ...i.history.filter((h) => h.role === "user").map((h) => h.text),
    i.message,
    ...(i.memory || []).flatMap((m) => [...(m.lines || []), ...(m.asked || []), ...(m.done || [])]),
  ];
  return new Set(texts.flatMap(contentWords));
}

/** True when `text` shares at least `min` content words with the session (or the session is too young to judge). */
export function inScope(text: string, scope: Set<string>, min = 1): boolean {
  if (scope.size < 8) return true;
  const mine = new Set(contentWords(text));
  if (!mine.size) return true;
  let hit = 0;
  for (const w of mine) {
    if (scope.has(w)) hit++;
    else for (const s of scope) if (s.length >= 5 && w.length >= 5 && (s.startsWith(w.slice(0, 5)) || w.startsWith(s.slice(0, 5)))) { hit++; break; } // light stemming: wave/waves, energy/energies
    if (hit >= min) return true;
  }
  return false;
}

/** Memory from other subjects must never reach a session in this one. */
export function sameSubjectMemory<T extends { subject?: string }>(memory: T[] | undefined, subject?: string): T[] {
  const norm = (s?: string) => String(s || "").toLowerCase().replace(/[^a-zà-ÿ]/g, "");
  const want = norm(subject);
  if (!want) return memory || [];
  return (memory || []).filter((m) => { const got = norm(m.subject); return !got || got === want || got.startsWith(want.slice(0, 5)) || want.startsWith(got.slice(0, 5)); });
}

/** Objectives the session never supports (an economics goal set during a physics session) are dropped. The scope passed in must
 *  be built WITHOUT the objectives themselves, or they would vouch for each other. */
export function cleanObjectives<T extends { label: string }>(objectives: T[], baseScope: Set<string>): T[] {
  return objectives.filter((o) => inScope(o.label, baseScope));
}
