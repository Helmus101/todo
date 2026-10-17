// THE PEDAGOGY CHECK — a handful of structural checks on the structured turn, run in code before anything reaches the
// student. They replace the old pile of regex guards: with a structured turn, a tool call can't leak into the text, a
// board pointer either names a listed line or it doesn't, and the amount of help is a number to compare with a limit.
//
// verifyTurn() lists what's wrong (each issue is a precise instruction for the one repair call); degradeTurn() fixes
// what code can fix on its own (drops a leaking sentence or a bad board op, trims to one question) when the repair
// call didn't — so the reply that ships is always the model's own words, never a canned sentence.
import type { BoardEntry, TaskProblem, TutorSolution } from "../../shared/types.ts";
import { MOVE_SUPPORT, type BoardOp, type TurnOutput } from "../../shared/tutorTurn.ts";
import { boardLineNumbers } from "../../shared/boardLines.ts";
import { resolveBoardTarget, leaksAnyProblemAnswer } from "../claude.ts";
import { replyStatesValue, ignoresWhy, repeatsRecentReply, repeatsRecentQuestion, inventedNumbers, harshOpener } from "../tutorAdapt.ts";
import { statesFinalAnswer, wrongArithmetic, badGap, mentionsMechanics } from "../tutor.ts";
import type { Policy } from "./policy.ts";
import { repeatedExercise, mostlyContains } from "./exercises.ts";
import { inScope } from "./scope.ts";

/** A sentence that says something is (or is about to be) on the board. */
const BOARD_CLAIM = /\b(?:on the (?:board|whiteboard)|(?:look|take a look|have a look) at the (?:board|chart|grid|diagram|table|graph|figure|picture)|(?:i'?ve|i have|i'?ll|i will|let me|let'?s|we'?ll|here'?s|here is|here are) (?:just )?(?:draw|drawn|sketch|put|add|map|write|written|plot|build|make|made|show)\w*|sur le tableau|regarde (?:le|la|l')\s*(?:tableau|sch[ée]ma|graphique|figure))\b/i;
// A sentence that points at a picture ("notice how the curve flattens", "the graph shows") when no picture exists.
const VISUAL_REF = /\b(?:notice|observe|see|look at|check out)\b[^.?!]{0,50}\b(?:curve|graph|diagram|figure|picture|chart|plot|sketch|table|slope of the line)\b|\b(?:the|this|that|our)\s+(?:curve|graph|diagram|figure|chart|plot|sketch|picture)\b/i;
const VISUAL_KINDS = new Set(["graph", "diagram", "svg", "flow", "table", "source", "widget", "interactive"]);
export const hasVisual = (board: { kind?: string }[]): boolean => board.some((e) => VISUAL_KINDS.has(String(e.kind)));
/** True when a sentence says something is on the board, or points at a figure while the board has none. */
export const claimsBoard = (sentence: string, visualOnBoard = true): boolean => BOARD_CLAIM.test(sentence) || (!visualOnBoard && VISUAL_REF.test(sentence));
const CREATING = new Set(["draw", "step", "gap", "problem", "topic"]);
const OFFER = /\b(?:let'?s|i'?ll|shall we|want me to|should i|let me|we can|would you like)\b[^.?!]*\b(?:draw|map|sketch|chart|grid|plot|put|write|show|diagram|table)\b/i;
const YES = /^\s*(?:yes|yeah|yep|yup|ok(?:ay)?|sure|please|do it|do that|go ahead|go on|oui|d'accord|vas-y)\b/i;
/** They said yes to Otto's own offer to draw or write something. */
export function acceptsBoardOffer(message: string, history: { role: string; text: string }[]): boolean {
  if (!YES.test(message) && !/\b(?:can you|could you|please)\b[^.?!]*\b(?:do|show|draw)\b/i.test(message)) return false;
  const lastOtto = [...history].reverse().find((h) => h.role === "assistant");
  return !!lastOtto && OFFER.test(lastOtto.text);
}

export interface VerifyContext {
  message: string;
  history: { role: string; text: string }[];
  board: BoardEntry[];
  problems: TaskProblem[];
  solution?: TutorSolution;
  policy: Policy;
  /** What code detected the student wants this turn. */
  wants: { why: boolean; write: boolean; restart: boolean; exercise: boolean; draw?: boolean; problemOnBoard?: boolean; different?: boolean };
  /** Everything the student and the problem said — the only legitimate source of numbers. */
  said: string[];
  discussion: boolean;
  /** Exercises already used this session and in earlier ones (exercises.ts). */
  usedExercises?: string[];
  /** The content words this session has used (scope.ts): plans, headers and exercises must touch them. */
  scope?: Set<string>;
  /** The code-checked verdict on their step/answer this turn, if any. */
  verdict?: "correct" | "incorrect";
}

export interface Issue {
  code: "support" | "leak" | "target" | "intent_why" | "intent_write" | "intent_restart" | "intent_exercise" | "intent_draw" | "board_promise" | "repeat_exercise" | "vague" | "intent_problem" | "unwritten" | "diagnosis" | "invented_object" | "prose_equation" | "off_topic" | "ignores_student" | "questions" | "length" | "visuals" | "gap" | "arithmetic" | "numbers" | "repeat" | "mechanics" | "harsh";
  /** The instruction for the repair call. */
  fix: string;
  /** A leak or a pointer at nothing must be fixed; the rest are quality. */
  hard: boolean;
}

/** Words a reply may use for its move (maths spans count as one word). */
export function wordBudget(move: TurnOutput["move"]): number {
  return move === "worked_example" ? 120 : move === "explain" || move === "worked_step" ? 95 : move === "practice" || move === "recap" ? 60 : 50;
}
export const countWords = (text: string): number => String(text || "").replace(/\$[^$]*\$/g, " x ").split(/\s+/).filter(Boolean).length;

const speechText = (t: TurnOutput) => t.speech.join(" ");
const opText = (o: BoardOp) => [o.text, o.why, o.note, o.question, o.hint, o.spec ? JSON.stringify(o.spec) : ""].filter(Boolean).join(" ");

/** The open answer keys this turn must not reveal: the verified solution's final answer, open gaps' keys, unsolved
 *  exercises' answers. A value the student already said themselves is theirs. */
export function revealsKey(text: string, c: VerifyContext): string | null {
  if (!text.trim()) return null;
  if (c.solution && statesFinalAnswer(text, c.solution) && !statesFinalAnswer(c.message, c.solution)) return "the problem's final answer";
  for (const g of c.board) {
    if (g.kind !== "gap" || !g.expectedAnswer || g.status === "correct") continue;
    if (replyStatesValue(text, g.expectedAnswer) && !replyStatesValue(c.message, g.expectedAnswer)) return `the open gap's answer (${g.expectedAnswer})`;
  }
  const open = c.problems.filter((p) => !p.solved);
  if (open.length && leaksAnyProblemAnswer(text, open) && !leaksAnyProblemAnswer(c.message, open)) return "the open exercise's answer";
  return null;
}

/** Does a board pointer name a line the student can actually see? */
export function targetExists(target: string | undefined, board: BoardEntry[]): boolean {
  if (!target) return false;
  const n = /^#?\s*(\d{1,3})$/.exec(target.trim());
  if (n) return [...boardLineNumbers(board as any).values()].includes(Number(n[1]));
  return !!resolveBoardTarget(target, board);
}

/** Every "line N" / "#N" in the speech must be a real margin number. */
function missingLineRefs(speech: string, board: BoardEntry[]): number[] {
  const nums = new Set(boardLineNumbers(board as any).values());
  return [...speech.matchAll(/\b(?:line|ligne)\s*#?\s*(\d{1,3})\b|(?<![\w&])#(\d{1,3})\b/gi)].map((m) => Number(m[1] || m[2])).filter((n) => !nums.has(n));
}

const FILLER = new Set(["that","this","with","have","what","your","about","there","their","then","them","into","from","will","would","could","should","some","just","like","next","part","lets","let's","okay","right","good","great","here","step","time","back","work","going","think","thing","things","know","need","want"]);
const contentWords = (text: string) => new Set((String(text || "").toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !FILLER.has(w)));

/** A reply that says nothing in particular: too short, hands nothing back, or touches nothing the student said or the board shows. */
export function vagueReply(t: TurnOutput, c: VerifyContext): string | null {
  const say = speechText(t);
  const words = countWords(say);
  if (words < 5) return "it is only a few words";
  if (["elicit", "focus", "practice", "probe_why", "hint_concept", "hint_procedure", "worked_step", "correct_error", "explain", "worked_example"].includes(t.move)) {
    const hands = t.speech.some((s) => /\?\s*["»”)]*\s*$/.test(s) || /^(?:try|write|tell|find|compute|work out|calculate|draw|sketch|say|explain|show|now (?:try|write|find))\b/i.test(s.trim()));
    if (!hands) return "it ends without handing the student anything to do or answer";
  }
  const concrete = /\d|\$|[=^]/.test(say) || t.board.some((o) => ["draw", "step", "gap", "problem", "mark"].includes(o.op));
  const askedSomethingReal = t.speech.some((s) => /\?\s*["»”)]*\s*$/.test(s) && contentWords(s).size >= 2);
  if (!concrete && !askedSomethingReal) {
    const anchors = contentWords([c.message, ...c.board.map((b) => b.text || ""), ...c.problems.map((p) => p.question || ""), ...c.history.slice(-4).map((h) => h.text)].join(" "));
    const hit = [...contentWords(say)].some((w) => anchors.has(w));
    if (!hit) return "it names nothing from the student's words, the board or the problem";
  }
  return null;
}

/** Scenario objects a tutor might invent ("the cyclist" in a problem about a car). */
const SCENE_NOUNS = ["cyclist","bicycle","bike","runner","sprinter","skier","skater","swimmer","diver","climber","hiker","pilot","driver","passenger","pedestrian","car","truck","lorry","bus","train","boat","ship","plane","aeroplane","rocket","satellite","ball","stone","rock","block","box","crate","barrel","pulley","spring","pendulum","ladder","elevator","lift","cart","trolley","parachutist","skydiver","football","bullet","arrow","dog","bird","horse"];
const nounRe = (n: string) => new RegExp(`\\b${n}(?:s|es)?\\b`, "i");
/** The scenario objects a text mentions (synonyms folded: bike = bicycle = cyclist, car = truck…). */
export function sceneNounsIn(text: string): string[] {
  const fold = (n: string) => ({ bicycle: "bike", cyclist: "bike", truck: "car", lorry: "car", driver: "car", elevator: "lift", aeroplane: "plane", football: "ball", skydiver: "parachutist" } as Record<string, string>)[n] || n;
  return [...new Set(SCENE_NOUNS.filter((n) => nounRe(n).test(text)).map(fold))];
}

/** Scenario objects the reply names that the problem, the board and the student never mentioned. */
export function inventedObjects(texts: string[], sources: string[]): string[] {
  const src = sources.join(" ").toLowerCase();
  const out: string[] = [];
  for (const n of SCENE_NOUNS) {
    if (!texts.some((t) => nounRe(n).test(t))) continue;
    // a synonym group counts as present (car/truck/lorry/driver, ball/football, bike/bicycle/cyclist…)
    const near = ({ car: ["truck","lorry","driver","vehicle"], truck: ["car","lorry","vehicle"], bike: ["bicycle","cyclist"], bicycle: ["bike","cyclist"], ball: ["football","sphere"], lift: ["elevator"], elevator: ["lift"], plane: ["aeroplane","aircraft"], aeroplane: ["plane","aircraft"] } as Record<string, string[]>)[n] || [];
    if (!nounRe(n).test(src) && !near.some((m) => nounRe(m).test(src))) out.push(n);
  }
  return out;
}

/** A board "equation" with plain words on a side ("4 × 10 × sin 25° − 30 = pull down − 30"): not maths. */
export function proseEquation(text: string): boolean {
  const t = String(text || "").replace(/\$/g, " ").replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{[^}]*\}/g, " ").replace(/\\[a-zA-Z]+/g, " ").replace(/\b(?:sin|cos|tan|cot|sec|csc|log|ln|exp|sqrt|min|max|mod|lim|det|arcsin|arccos|arctan)\b/gi, " ");
  if (!/=/.test(t)) return false;
  return t.split("=").some((side) => (side.match(/\b[a-zA-Z]{3,}\b/g) || []).length >= 2 && /\b[a-zA-Z]{3,}\s+[a-zA-Z]{3,}\b/.test(side));
}

/** They gave a short answer with a number ("about 56%") and the model's own reading of it ("heard") and its reply have nothing in common
 *  with it: the turn answers something else. (An empty `heard` means we can't tell, so it is never flagged.) */
export function ignoresStudentAnswer(message: string, heard: string, speech: string): boolean {
  const m = String(message || "").trim();
  if (!m || !String(heard || "").trim() || m.length > 220 || /^\[(?:Exercise|Exercice|Activity|Activité)\]/i.test(m)) return false;
  const nums = m.match(/\d+(?:[.,]\d+)?/g) || [];
  if (!nums.length) return false;
  const both = `${heard} ${speech}`.replace(/,/g, ".");
  if (nums.some((n) => new RegExp(`(?<![\\d.])${n.replace(/[.,]/g, "\\.")}(?![\\d])`).test(both))) return false;
  const have = new Set([...contentWordsOf(heard), ...contentWordsOf(speech)]);
  return !contentWordsOf(m).some((w) => have.has(w));
}
const contentWordsOf = (t: string): string[] => (String(t).toLowerCase().match(/[a-zà-ÿ]{5,}/g) || []).filter((w) => !FILLER.has(w));

export function verifyTurn(t: TurnOutput, c: VerifyContext): Issue[] {
  const out: Issue[] = [];
  const say = speechText(t);
  const level = MOVE_SUPPORT[t.move];
  // 1. Help within the limit code set for this turn.
  if (level > c.policy.maxSupport) out.push({ code: "support", hard: true, fix: `"${t.move}" gives too much help right now (level ${level}; the limit is ${c.policy.maxSupport} because ${c.policy.reason}). Choose one of: ${c.policy.allowed.join(", ")} — let them take the next step.` });
  // 2. No answer given away (an explanation may show steps, never the final answer or an open blank's value).
  const leakSpeech = revealsKey(say, c);
  if (leakSpeech) out.push({ code: "leak", hard: true, fix: `the speech states ${leakSpeech} — they must find it. Keep the idea, drop the value, and end with one question that gets them there.` });
  for (const o of t.board) { const l = o.op !== "gap" ? revealsKey(opText(o), c) : null; if (l) { out.push({ code: "leak", hard: true, fix: `a board ${o.op} shows ${l} — leave it as '?' or don't write it.` }); break; } }
  // 3. Every pointer names a real board line.
  const missing = missingLineRefs(say, c.board);
  if (missing.length) out.push({ code: "target", hard: true, fix: `the speech mentions line ${missing[0]}, which isn't on the board. Use a margin number from the listing, or say what the line says.` });
  const badMark = t.board.find((o) => o.op === "mark" && !targetExists(o.target, c.board));
  if (badMark) out.push({ code: "target", hard: true, fix: `the mark points at "${badMark.target ?? ""}", which isn't a line on the board — use a #n from the listing.` });
  // 4. What they asked for is actually done.
  if (c.wants.why && (!["probe_why", "explain", "hint_concept", "worked_step", "worked_example", "correct_error", "revoice"].includes(t.move) || ignoresWhy(say))) out.push({ code: "intent_why", hard: false, fix: "they asked WHY. Give the actual reason first, in 1–2 plain sentences (because…, so that…, it means…) — repeating the instruction is not a reason. Then at most one question." });
  if (c.wants.write && !t.board.some((o) => o.op === "step" && o.owner === "student")) out.push({ code: "intent_write", hard: false, fix: 'they asked you to write their working on the board: add a step op with owner "student" holding exactly the step they last stated, tidied into $…$.' });
  if (c.wants.restart && !t.board.some((o) => o.op === "topic")) out.push({ code: "intent_restart", hard: false, fix: 'they asked to start over: begin with a topic op (a fresh worksheet), put the givens up again as one step, and explain the very first idea plainly.' });
  if (c.wants.exercise && !t.board.some((o) => o.op === "problem")) out.push({ code: "intent_exercise", hard: false, fix: "they asked for an exercise: add a problem op (full statement, one short answer, a check expression for a number, the format in 'format')." });
  if (c.wants.problemOnBoard && !t.board.some((o) => o.op === "problem" || (o.op === "step" && o.kind === "given"))) out.push({ code: "intent_problem", hard: true, fix: "they asked you to put the PROBLEM on the board: open with a topic op, then add a step op of kind \"given\" holding the full problem statement (all the givens and the question), in this turn. Then ask the first step." });
  if (c.wants.draw && !t.board.some((o) => o.op === "draw" || o.op === "step")) out.push({ code: "intent_draw", hard: true, fix: "they asked you to draw or show it — do it NOW, in this turn: add a draw op (a table op for a sign chart, grid or comparison; graph, numberline, geometry, flow for the rest), or a step op for a formula. Don't describe it and wait for them to ask again." });
  const visualHere = hasVisual(c.board) || t.board.some((o) => o.op === "draw");
  if (t.speech.some((sn) => claimsBoard(sn, visualHere)) && !t.board.some((o) => CREATING.has(o.op))) out.push({ code: "board_promise", hard: true, fix: "the speech says something is on the board (or will be) but the board list has nothing new — add the draw/step op that puts it there, or take the board claim out of the speech." });
  // An exercise is never set twice: the spoken question or a problem op must differ from every earlier one.
  if (c.usedExercises?.length) {
    // The whole reply counts when it sets a problem in words ("now let's look at the car problem: … 10° … 2v²"): an old problem dragged back.
    const setsProblem = (say.match(/\d+(?:[.,]\d+)?/g) || []).length >= 2 && /\?/.test(say) && say.length >= 60;
    const prompts = [...t.board.filter((o) => o.op === "problem").map((o) => String(o.question || "")), t.speech.length ? t.speech.filter((s) => /\?\s*["»”)]*\s*$/.test(s)).pop() || "" : "", ...(setsProblem ? [say] : [])].filter(Boolean);
    let dup = prompts.map((p) => (p === say ? c.usedExercises!.find((u) => mostlyContains(say, u, 0.45)) : repeatedExercise(p, c.usedExercises!, c.wants.different ? 0.35 : 0.5))).find(Boolean);
    // "Totally different" means a different SITUATION: sharing the setting (a car again) with a recent exercise is the same idea re-skinned.
    if (!dup && c.wants.different) {
      const recent = c.usedExercises.slice(-3);
      for (const p of [...prompts, say]) { const mine = sceneNounsIn(p); const hit = recent.find((r) => sceneNounsIn(r).some((n) => mine.includes(n))); if (hit) { dup = hit; break; } }
    }
    if (dup) out.push({ code: "repeat_exercise", hard: true, fix: `this is the same exercise as one already used ("${dup}"). Set a NEW one: change the function or numbers AND the situation, and either make it a step harder or test the skill a different way (spot the error, sketch, explain).` });
  }
  const vague = vagueReply(t, c);
  if (vague) out.push({ code: "vague", hard: true, fix: `the reply says nothing in particular (${vague}). Say something specific: refer to their actual words, a board line or the problem, teach or check ONE concrete thing, and hand back one concrete question or step.` });
  // Teaching must leave something on the board to look back at, and an error must be diagnosed and named.
  const WRITTEN = ["step", "draw", "mark", "gap", "problem", "topic"];
  if (["explain", "worked_step", "worked_example", "correct_error"].includes(t.move) && !t.board.some((o) => WRITTEN.includes(o.op))) out.push({ code: "unwritten", hard: false, fix: "you taught something but wrote nothing: add a step op with the key idea or formula (with its short 'why'), or a mark on the line that is off, so it stays on the board after you've spoken." });
  const d = t.diagnosis;
  if (c.verdict === "incorrect" && ["none", "correct", "unclear"].includes(d.status)) out.push({ code: "diagnosis", hard: false, fix: "their answer is wrong (checked by code) but the diagnosis says otherwise: find the FIRST thing that's off and set diagnosis.status to slip, misconception or partial." });
  if (d.status === "misconception") {
    if (!d.misconception) out.push({ code: "diagnosis", hard: false, fix: "you diagnosed a misconception: name the mistaken belief in diagnosis.misconception (≤8 words)." });
    if (["confirm", "elicit", "recap"].includes(t.move)) out.push({ code: "diagnosis", hard: false, fix: "a misconception shows, so don't just confirm or move on: name the idea that is off, gently, in the speech, and choose focus, correct_error, explain or probe_why to repair it." });
  }
  // Stay on the session's topic: a plan, a new worksheet or an exercise that touches nothing the session has used is another topic.
  if (c.scope) {
    const off = t.board.find((o) => (o.op === "plan" && (o.objectives || []).some((l) => !inScope(l, c.scope!))) || (o.op === "topic" && !inScope(String(o.text || ""), c.scope!)) || (o.op === "problem" && !inScope(`${o.question || ""}`, c.scope!, 1)));
    if (off) out.push({ code: "off_topic", hard: true, fix: `the ${off.op} op is about a different topic from this session. Stay on the session's subject and plan; only change topic when the student asks for it.` });
  }
  const prose = t.board.find((o) => (o.op === "step" || o.op === "gap") && o.kind !== "note" && o.kind !== "definition" && proseEquation(String(o.text || "")));
  if (prose) out.push({ code: "prose_equation", hard: false, fix: `the board line "${String(prose.text).slice(0, 80)}" has words where numbers or symbols belong. Write the actual value (or just the expression) and put the explanation in the step's "why".` });
  if (!c.wants.exercise && !c.wants.different && !c.wants.problemOnBoard && !c.wants.draw && !c.verdict && ignoresStudentAnswer(c.message, t.heard, say)) out.push({ code: "ignores_student", hard: true, fix: `the student just said "${c.message.slice(0, 80)}" and the reply doesn't respond to it. Start from THEIR words: say whether it fits (or what it would need to be) and ask how they got it, before anything else.` });
  // Only objects that exist in the problem: no cyclist in a car problem.
  const objs = inventedObjects([say, ...t.board.map(opText)], [...c.said, ...c.board.map((b) => b.text || ""), ...c.problems.map((p) => p.question || ""), ...(c.solution ? [c.solution.statement, ...c.solution.steps.map((s) => `${s.idea || ""} ${s.result || ""}`)] : [])]);
  // A NEW problem brings its own objects; only an existing problem's objects are fixed.
  const introducesProblem = c.wants.different || c.wants.exercise || c.wants.problemOnBoard || t.move === "practice" || t.board.some((o) => o.op === "problem" || o.op === "topic");
  if (objs.length && !introducesProblem) out.push({ code: "invented_object", hard: true, fix: `it mentions ${objs.slice(0, 2).map((o) => `"${o}"`).join(" and ")}, which is not in the problem, the board or anything the student said. Refer only to the actual objects of the problem.` });
  // 5. One question, last.
  const qs = t.speech.map((s, i) => ({ i, q: /\?\s*["»”)]*\s*$/.test(s.replace(/\$[^$]*\$/g, "x")) })).filter((x) => x.q);
  if (qs.length > 1 || (qs.length === 1 && qs[0].i !== t.speech.length - 1)) out.push({ code: "questions", hard: false, fix: "ask at most ONE question, as the last sentence." });
  // 6. Length for the move.
  if (countWords(say) > wordBudget(t.move)) out.push({ code: "length", hard: false, fix: `too long for "${t.move}" (${countWords(say)} words; keep it under ${wordBudget(t.move)}). Fewer, shorter sentences — longer maths goes on the board.` });
  // 7. Board tidy: one new visual; one valid gap.
  if (t.board.filter((o) => o.op === "draw").length > 1) out.push({ code: "visuals", hard: false, fix: "at most ONE new visual per turn — keep the most useful one." });
  for (const g of t.board.filter((o) => o.op === "gap")) { const bad = badGap(String(g.text || ""), c.board.map((b) => String(b.text || ""))); if (bad) { out.push({ code: "gap", hard: false, fix: `gap "${g.text}": ${bad}` }); break; } }
  // 8. Correct maths, and no numbers from nowhere (a worked example may use its own).
  const maths = [say, ...t.board.filter((o) => o.op === "step").map((o) => o.text || "")].join("\n");
  const bad = wrongArithmetic(maths, c.message);
  if (bad) out.push({ code: "arithmetic", hard: true, fix: `a calculation is wrong: ${bad}. Recompute it.` });
  if (!c.discussion && t.move !== "worked_example") {
    const invented = inventedNumbers(say, [...c.said, ...c.board.map((b) => b.text), ...c.problems.map((p) => p.question), ...(c.solution ? [c.solution.statement, ...c.solution.steps.map((s) => s.result || "")] : [])]);
    if (invented.length) out.push({ code: "numbers", hard: false, fix: `it uses numbers nobody gave (${invented.slice(0, 3).join(", ")}) — only the problem's, the student's, or the verified solution's.` });
  }
  // 9. Not a repeat of what just failed to land; no app machinery; never harsh.
  if (repeatsRecentReply(say, c.history) || repeatsRecentQuestion(say, c.history)) out.push({ code: "repeat", hard: false, fix: "you said almost exactly this a moment ago and it didn't land. Change the angle: a smaller step, a picture on the board, numbers instead of letters, or explain it plainly." });
  if (mentionsMechanics(say)) out.push({ code: "mechanics", hard: false, fix: "it talks about the app's machinery — just teach." });
  const harsh = harshOpener(say);
  if (harsh) out.push({ code: "harsh", hard: false, fix: `it opens with "${harsh}" — start with what's worth keeping in their thinking.` });
  return out;
}

/** Fix in code what the repair call didn't: drop leaking sentences and ops, bad pointers, extra visuals and invalid
 *  gaps; keep only the last question; trim an over-long reply at sentence boundaries. Never adds words of its own. */
export function degradeTurn(t: TurnOutput, c: VerifyContext): TurnOutput {
  let speech = t.speech.filter((s) => !revealsKey(s, c));
  const nums = new Set(boardLineNumbers(c.board as any).values());
  speech = speech.map((s) => s.replace(/\s*\(?(?:look at |see |on )?(?:line|ligne)\s*#?\s*(\d{1,3})\)?/gi, (m, n) => (nums.has(Number(n)) ? m : "")).trim()).filter(Boolean);
  // One question, kept at the end: earlier questions go (their statements stay).
  const lastQ = [...speech].reverse().find((s) => /\?\s*["»”)]*\s*$/.test(s));
  speech = speech.filter((s) => !/\?\s*["»”)]*\s*$/.test(s) || s === lastQ);
  if (lastQ && speech[speech.length - 1] !== lastQ) speech = [...speech.filter((s) => s !== lastQ), lastQ];
  // Over budget: keep the opening sentences and the closing question.
  while (speech.length > 2 && countWords(speech.join(" ")) > wordBudget(t.move)) speech.splice(speech.length - 2, 1);
  let draws = 0;
  const board = t.board.filter((o) => {
    if (o.op !== "gap" && revealsKey(opText(o), c)) return false;
    if (o.op === "mark" && !targetExists(o.target, c.board)) return false;
    if (c.scope && ((o.op === "plan" && (o.objectives || []).some((l) => !inScope(l, c.scope!))) || (o.op === "topic" && !inScope(String(o.text || ""), c.scope)))) return false;
    if (o.op === "draw" && ++draws > 1) return false;
    if ((o.op === "step" || o.op === "gap") && o.kind !== "note" && o.kind !== "definition" && proseEquation(String(o.text || ""))) return false;
    if (o.op === "problem" && c.usedExercises?.length && repeatedExercise(String(o.question || ""), c.usedExercises)) return false;
    if (o.op === "gap" && badGap(String(o.text || ""), c.board.map((b) => String(b.text || "")))) return false;
    return true;
  }).map((o) => ({ ...o, cue: Math.min(o.cue, Math.max(0, speech.length - 1)) }));
  // Never claim a board change that isn't in the list.
  if (!board.some((o) => CREATING.has(o.op))) speech = speech.filter((s) => !claimsBoard(s, hasVisual(c.board) || board.some((o) => o.op === "draw")));
  // Empty speech (every sentence leaked) is returned as is: the engine then asks for a rewrite rather than shipping a leak.
  return { ...t, speech, board };
}
