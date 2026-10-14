// THE TURN DIRECTOR — decides, in code, what this turn must DO (on the board and in the lesson), from what just
// happened. The model still chooses the words and the teaching move; this only makes sure the obvious next action
// is taken without the student asking for it: start teaching from a goal, record their working, draw a new idea,
// put up the next problem after a right answer, mark up what they drew, recap at milestones, follow a topic change.
// Telling the model up front is also what keeps turns fast: no correction round to ask for a board write afterwards.
// Pure, unit-tested in tests/run.mjs.
import type { BoardEntry, TaskObjective, TaskProblem } from "../shared/types.ts";

export interface DirectorInput {
  message: string;
  history: { role: string; text: string }[];
  board: Pick<BoardEntry, "kind" | "text" | "owner">[];
  problems: Pick<TaskProblem, "question" | "solved">[];
  objectives: TaskObjective[];
  stepVerdict?: "correct" | "incorrect";
  solvedInChat?: boolean;
  stuckStreak?: number;
  discussion?: boolean;
  /** They asked Otto to draw/show the picture ("draw it"). */
  drawRequest?: boolean;
}

const words = (t: string) => new Set(String(t || "").toLowerCase().replace(/\$[^$]*\$/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
const overlaps = (a: string, b: string) => { const B = words(b); return [...words(a)].some((w) => B.has(w)); };

export const DREW_ON_BOARD = /\[(?:What I wrote\/drew on the board|Ce que j'ai écrit\/dessiné sur le tableau)\s*:/i;
const EXERCISE_RIGHT = /\[(?:Exercise|Exercice)\][^\n]*(?:marked right|checked right|— juste|vérifié juste)/i;
const EXERCISE_WRONG = /\[(?:Exercise|Exercice)\][^\n]*(?:marked wrong|checked wrong|— faux|vérifié faux|PARTLY right|en partie juste)/i;
const CONCEPT_REQUEST = /\b(?:explain|what (?:is|are|does)|what's|how (?:does|do)|why (?:does|do|is)|teach me|show (?:me )?(?:the |a )?(?:graph|diagram|curve|picture|how)|c'est quoi|qu'est-ce que|explique|montre(?:-moi)?)\b/i;
// "what is the answer / x / the next step" asks about THIS problem, not for a new idea (reported: it opened a new topic).
const NOT_A_CONCEPT = /\b(?:what(?:'s| is| are)|c'est quoi|quelle est)\s+(?:the\s+|la\s+|le\s+)?(?:answer|réponse|next|suivant|result|résultat|value|valeur|[xyzkn]|it|this|that|ça|wrong|my|mine|left)\b/i;
// A goal, not just the word "learn"/"test" in passing ("let me test x = 3" is not a study goal).
const STUDY_GOAL = /\b(?:revis(?:e|ing|ion)|r[ée]vis(?:er|ion)|prepar(?:e|ing) for|pr[ée]parer|(?:an?|my|the) (?:exam|test|quiz)|exam(?:s|en)?\b|contr[ôo]le|bac\b|learn (?:about|how|the)|study (?:for|the)|apprendre (?:les?|la|à)|go over|catch up|teach me)\b/i;
const RECAP_REQUEST = /\b(?:summar(?:y|ise|ize)|recap|résumé|bilan|what (?:did|have) we (?:do|done|cover))/i;

/** The actions this turn must take, most important first (at most 3). Empty when nothing in particular is due. */
export function turnActions(d: DirectorInput): string[] {
  const out: string[] = [];
  const msg = String(d.message || "");
  const userTurns = d.history.filter((h) => h.role === "user").length;
  const open = [...d.problems].reverse().find((p) => !p.solved);
  const current = d.objectives.find((o) => !o.done);
  const right = d.stepVerdict === "correct" || !!d.solvedInChat || EXERCISE_RIGHT.test(msg);
  const wrong = !right && (d.stepVerdict === "incorrect" || EXERCISE_WRONG.test(msg));
  const asksConcept = (CONCEPT_REQUEST.test(msg) && !NOT_A_CONCEPT.test(msg) || !!d.drawRequest) && !/^\s*\[(?:Exercise|Exercice)\]/.test(msg);
  // A new topic needs a topic: "draw it" / "explain that" is about what's already on the table.
  const topicChange = asksConcept && !!open && words(msg.replace(/\b(?:explain|draw|show|sketch|please|could|would|can|what|does|this|that|again|dessine|explique|montre)\b/gi, " ")).size >= 1 && !overlaps(msg, open.question);

  // 1. A study goal and no plan yet: plan AND start, in this reply.
  if (!d.objectives.length && STUDY_GOAL.test(msg)) {
    out.push("START TEACHING NOW: call SET_OBJECTIVES with 3-5 objectives for exactly what they asked (leave out anything they excluded), write a focus header for objective 1 (WRITE_TO_BOARD kind focus), and put the first thing to work on up — a problem (CREATE_PROBLEM) or, for a new idea, a figure/table. In the reply: the plan in one line, then the first question. Don't ask them to approve the plan; they can change it any time.");
  }
  // 2. They drew or wrote on the board: respond ON the board.
  if (DREW_ON_BOARD.test(msg)) out.push("They worked on the board: mark it up — ANNOTATE_BOARD on the relevant line (tone good for what's right, error for the first slip, hint for where to look next), or write the clean version of their step beside it as THEIR line (owner student). Then react to what they drew.");
  // 3. A right answer: record it and move on without being asked.
  if (right) {
    out.push(`They got it right: write their result on the board as their line (owner student) if it isn't there, then put the NEXT problem up with CREATE_PROBLEM in this same reply — ${current ? `still on "${current.label}" but harder or in a different format (graph, concept, application, spot-the-error)` : "harder, or in a different format (graph, concept, application, spot-the-error)"}. If this objective is now shown (two right answers on it), tick it with SET_OBJECTIVES and start the next objective instead. One line of specific credit, then the new task.`);
  } else if (wrong) {
    out.push("Their answer was wrong: find the FIRST thing that's off. Put the step where it breaks on the board (their line, then a gap or an annotation pointing at it), and ask one focusing question about that exact spot. Don't put up a new problem.");
  }
  // 4. A new idea asked for: visual first.
  if (asksConcept) {
    out.push(`${topicChange ? "They've moved to a NEW topic: write a focus header for it (WRITE_TO_BOARD kind focus) and leave the earlier problem alone. " : ""}Visual first: before explaining, put it on the board — GRAPH_ON_BOARD for a relationship between quantities, FLOW_ON_BOARD for a process or cause→effect, TABLE_ON_BOARD for a comparison, a figure tool for geometry — plus ONE definition/key-idea line. Then explain briefly by pointing at it, and end with one question about the figure.`);
  }
  // 5. Their own working (a step, an equation) said in chat goes on the board.
  if (!right && !wrong && !asksConcept && !/^\s*\[(?:Exercise|Exercice|Activity|Activité)\]/i.test(msg) && /[=<>≤≥]|\d\s*[×x*/+−-]\s*\d/.test(msg) && msg.length < 300) {
    out.push("They stated a step of their own: write it on the board as THEIR line (owner student, maths in $…$) with a short 'why', then ask about the next step.");
  }
  // 6. Stuck: a worked example, on the board.
  if ((d.stuckStreak || 0) >= 2 && !right) {
    out.push("They've been stuck twice: put a short worked example with DIFFERENT numbers on the board (one line per step, each with its why), last step left as a gap for them.");
  }
  // 7. Recap at milestones or on request.
  const sinceSummary = (() => { const i = [...d.board].reverse().findIndex((e) => e.kind === "summary"); return i < 0 ? d.board.length : i; })();
  if (RECAP_REQUEST.test(msg) || (current === undefined && d.objectives.length > 0) || (userTurns >= 10 && sinceSummary >= 12)) {
    out.push("Recap on the board: ONE summary entry (kind summary) of what they've shown so far — key ideas, the method, the mistake to avoid — then one quick retrieval question on something from EARLIER in the session.");
  }
  // 8. Empty board on a real teaching turn: open it.
  if (!d.board.length && !out.length && userTurns >= 1) {
    out.push("The board is empty: open it with a focus header (what we're working on) and the first useful line — the givens, a definition, or a figure.");
  }
  return out.slice(0, 3);
}

/** The prompt block. */
export function directorBlock(d: DirectorInput): string {
  const acts = turnActions(d);
  if (!acts.length) return "";
  return `\n\nTHIS TURN — decided by the app from what just happened (do these in THIS reply; send your words in the SAME message as the board tool calls):\n${acts.map((a) => `- ${a}`).join("\n")}`;
}
