// THE PEDAGOGY CHECK — a handful of structural checks on the structured turn, run in code before anything reaches the
// student. They replace the old pile of regex guards: with a structured turn, a tool call can't leak into the text, a
// board pointer either names a listed line or it doesn't, and the amount of help is a number to compare with a limit.
//
// verifyTurn() lists what's wrong (each issue is a precise instruction for the one repair call); degradeTurn() fixes
// what code can fix on its own (drops a leaking sentence or a bad board op, trims to one question) when the repair
// call didn't — so the reply that ships is always the model's own words, never a canned sentence.
import { figureClaimFalse, SHADE_CLAIM } from "./graphFacts.ts";
import { parseExerciseResults, verdictFromResults } from "./results.ts";
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
  wants: { why: boolean; write: boolean; restart: boolean; exercise: boolean; draw?: boolean; problemOnBoard?: boolean; different?: boolean; topicSwitch?: boolean; advice?: boolean };
  /** Everything the student and the problem said — the only legitimate source of numbers. */
  said: string[];
  /** The student's own saved notes (about, projects, preferences): used silently, never repeated back at them. */
  private?: string[];
  /** The app's mark was probably wrong (an independent solve agrees with the student): the reply may disagree with it. */
  keyDoubt?: boolean;
  discussion: boolean;
  /** Exercises already used this session and in earlier ones (exercises.ts). */
  usedExercises?: string[];
  /** The content words this session has used (scope.ts): plans, headers and exercises must touch them. */
  scope?: Set<string>;
  /** False while they haven't yet told us enough about what they want (goals.ts) and no plan exists. */
  goalsKnown?: boolean;
  /** The code-checked verdict on their step/answer this turn, if any. */
  verdict?: "correct" | "incorrect";
}

export const SELF_CORRECTION = /(?:…|\.\.\.|—|,)\s*(?:non,?\s+(?:pardon|attends|en fait)|no,?\s+wait|wait,?\s+(?:no|that)|hmm,?\s|sorry,?\s+(?:let me|that'?s|i)|let me (?:redo|recompute|recalculate|rethink)|pardon,|oops)|\b(?:actually,? (?:no|that'?s wrong|let me)|scratch that|je me trompe|je reprends)\b/i;

export interface Issue {
  code: "support" | "leak" | "target" | "intent_why" | "intent_write" | "intent_restart" | "intent_exercise" | "intent_draw" | "board_promise" | "repeat_exercise" | "vague" | "intent_problem" | "unwritten" | "diagnosis" | "invented_object" | "prose_equation" | "off_topic" | "plan_too_early" | "ignores_student" | "verdict_mismatch" | "questions" | "length" | "visuals" | "gap" | "arithmetic" | "numbers" | "repeat" | "mechanics" | "harsh" | "no_error" | "self_correct" | "unsourced_quote" | "stale_opener" | "fact" | "format_leak" | "unstated_setup" | "intent_topic" | "intent_equation" | "graph_inconsistent" | "shaded_claim" | "dead_end" | "echo_private" | "intent_advice";
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

/** The "Line N" numbers inside an exercise worksheet (an error-spotting item shows Line 1–4 in the widget) or in the student's own answer — real references, not board lines. */
function exerciseLineNumbers(c: { problems?: { question?: string }[]; message?: string }): Set<number> {
  const out = new Set<number>();
  for (const t of [...(c.problems || []).map((p) => p.question || ""), c.message || ""]) for (const m of String(t).matchAll(/\b(?:line|ligne)\s*(\d{1,2})\b/gi)) out.add(Number(m[1]));
  return out;
}

/** Every "line N" / "#N" in the speech must be a real margin number. */
function missingLineRefs(speech: string, board: BoardEntry[], extra: Set<number> = new Set()): number[] {
  const nums = new Set([...boardLineNumbers(board as any).values(), ...extra]);
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
/** Otto asked a question, they answered it in words, and the reply neither reacts nor touches a single word of the answer
 *  (reported live: "kilogram metres per second" was answered with "Let's set up that collision… what is the total momentum?"). */
export function ignoresAnswerToQuestion(history: { role: string; text: string }[], message: string, heard: string, speech: string[]): boolean {
  const m = String(message || "").trim();
  const prev = [...history].reverse().find((h) => h.role === "assistant")?.text || "";
  if (!/\?\s*["»”)]*\s*$/.test(prev.trim()) || m.split(/\s+/).length < 3 || m.length > 260 || /\?|^\[/.test(m)) return false;
  const first = `${heard || ""} ${speech.slice(0, 2).join(" ")}`;
  if (/\b(?:right|correct|yes|yep|exactly|not quite|close|careful|almost|good|nope|no\b|true|false|wrong|mistake|oui|non|juste|faux|exact|bien|presque|d'accord|ok|okay|sure|fair|good point|i see|got it)\b/i.test(speech.slice(0, 2).join(" "))) return false;
  const words = (t: string) => (String(t).toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !FILLER.has(w));
  const have = new Set(words(first));
  const mine = words(m);
  return mine.length >= 2 && !mine.some((w) => have.has(w) || [...have].some((h) => h.length > 5 && w.length > 5 && (h.startsWith(w.slice(0, 5)) || w.startsWith(h.slice(0, 5)))));
}
const contentWordsOf = (t: string): string[] => (String(t).toLowerCase().match(/[a-zà-ÿ]{5,}/g) || []).filter((w) => !FILLER.has(w));

/** "the blocks", "those masses", "the two carts" — a definite reference to objects nobody has introduced yet in this sitting
 *  (reported live: "Let's set up that collision… what is the total momentum before the blocks collide?" with no collision stated). */
export function unstatedSetup(speech: string, sources: string[]): string | null {
  const hay = sources.join(" \n ").toLowerCase();
  for (const m of speech.matchAll(/\b(?:the|those|these|both|the two|the three)\s+((?:\w+\s)?)(blocks|masses|carts|trolleys|balls|cars|particles|crates|boxes|bodies|spheres|skaters|wagons|vehicles)\b/gi)) {
    const noun = m[2].toLowerCase(), stem = noun.replace(/(?:es|s)$/, "");
    if (!new RegExp(`\\b${noun}\\b|\\b${stem}s?\\b`).test(hay)) return `${m[0]}`;
  }
  return null;
}

/** Quotations (« … » / "…") of five or more words that appear nowhere the student gave: a model quoting a poem, a source or a
 *  thinker from memory gets the words wrong, and the student then analyses text that does not exist. */
export function unsourcedQuotes(speech: string, sources: string[]): string[] {
  const norm = (x: string) => x.toLowerCase().replace(/[\u2018\u2019\u201c\u201d«»"']/g, " ").replace(/[^a-zà-ÿ0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
  const hay = sources.map(norm).join(" | ");
  const out: string[] = [];
  for (const m of speech.matchAll(/«\s*([^»]{12,})\s*»|[“"]([^”"]{12,})[”"]/g)) {
    const q = m[1] || m[2] || "";
    if (/[$\\=^]/.test(q) || q.trim().split(/\s+/).length < 5) continue;
    if (!hay.includes(norm(q))) out.push(q.trim().slice(0, 60));
  }
  return out;
}

/** The answer widget's own instruction line, leaked into the speech. */
const FORMAT_INSTRUCTION = /^\s*(?:provide|give|round|express|write|state)\s+(?:your|the)\s+(?:final\s+)?answer\s+(?:to|in|as|with|correct to)\b[^.?!]*[.]?\s*$/i;

/** The student is closing the conversation (thanks, bye, that's all) — the only time a reply may end without a next step. */
export const CLOSING = /\b(?:thanks|thank you|thx|merci|bye|goodbye|au revoir|that'?s all|that is all|i'?m done|gotta go|see you|à plus|à demain|c'est tout)\b/i;
/** A reply with nothing to do after it: no question, no task for them, nothing placed on the board for them to act on. */
export function endsDead(speech: string[], board: { op: string; kind?: string }[], message: string): boolean {
  if (CLOSING.test(message) || !speech.length) return false;
  const text = speech.join(" ");
  if (/\?/.test(text)) return false;
  if (board.some((o) => o.op === "problem" || o.op === "gap" || o.op === "draw")) return false;
  const last = speech[speech.length - 1] || "";
  return !/\b(?:try|work out|find|calculate|tell me|write|say|show me|sketch|have a go|your turn|now do|go ahead|compute|explain (?:why|how|it)|describe|compare|predict|decide|pick|choose|name|give me|solve|substitute|plug|check)\b/i.test(last);
}

/** A reply sentence that repeats a run of 4+ words from the student's saved notes ("Fewer words, more thinking — try it") — those shape HOW Otto teaches and are never said aloud. */
export function echoesPrivate(sentence: string, priv: string[]): boolean {
  const w = (t: string) => t.toLowerCase().replace(/[^a-zà-ÿ0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  const sw = w(sentence).join(" ");
  for (const p of priv) {
    const pw = w(p);
    if (pw.length < 4) continue;
    for (let i = 0; i + 4 <= pw.length; i++) if (sw.includes(pw.slice(i, i + 4).join(" "))) return true;
  }
  return false;
}

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
  const missing = missingLineRefs(say, c.board, exerciseLineNumbers(c));
  if (missing.length) out.push({ code: "target", hard: false, fix: `the speech mentions line ${missing[0]}, which isn't on the board. Use a margin number from the listing, or say what the line says.` });
  const badMark = t.board.find((o) => o.op === "mark" && !targetExists(o.target, c.board));
  if (badMark) out.push({ code: "target", hard: false, fix: `the mark points at "${badMark.target ?? ""}", which isn't a line on the board — use a #n from the listing.` });
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
  if (c.goalsKnown === false && t.board.some((o) => o.op === "plan")) out.push({ code: "plan_too_early", hard: true, fix: "don't make a plan yet: you haven't learned what they want from this sitting. Remove the plan op and ask ONE short question about their goal (what they want today, when it is due or what is hardest, how long they have)." });
  // Stay on the session's topic: a plan, a new worksheet or an exercise that touches nothing the session has used is another topic.
  if (c.scope) {
    const off = t.board.find((o) => (o.op === "plan" && (o.objectives || []).some((l) => !inScope(l, c.scope!))) || (o.op === "topic" && !inScope(String(o.text || ""), c.scope!)) || (o.op === "problem" && !inScope(`${o.question || ""}`, c.scope!, 1)));
    if (off) out.push({ code: "off_topic", hard: true, fix: `the ${off.op} op is about a different topic from this session. Stay on the session's subject and plan; only change topic when the student asks for it.` });
  }
  const prose = t.board.find((o) => (o.op === "step" || o.op === "gap") && o.kind !== "note" && o.kind !== "definition" && proseEquation(String(o.text || "")));
  if (prose) out.push({ code: "prose_equation", hard: false, fix: `the board line "${String(prose.text).slice(0, 80)}" has words where numbers or symbols belong. Write the actual value (or just the expression) and put the explanation in the step's "why".` });
  {
    // The app already graded their widget answer: the reply must agree with that mark.
    // (parseExerciseResults also reads the French messages: "juste" / "faux".)
    const gradedBy = verdictFromResults(parseExerciseResults(c.message));
    const marked = gradedBy ? [gradedBy === "correct" ? "marked right" : "marked wrong"] : /\bmarked (right|wrong)\b|\bchecked (right|wrong)\b/i.exec(c.message);
    const first = (say.split(/(?<=[.!?])\s+/)[0] || "");
    if (marked && !c.keyDoubt) {
      const right = /right/i.test(marked[0]);
      if (!right && /\b(?:that'?s (?:right|correct|it)|exactly|spot on|well done|correct|you got it|bien joué|exact)\b/i.test(first) && !/\b(?:not|n't|isn'?t|pas)\b/i.test(first)) out.push({ code: "verdict_mismatch", hard: true, fix: "the app marked their answer WRONG, but the reply starts by saying it is right. Open by saying it isn't there yet, find the first thing that's off and ask one question aimed at it." });
      if (right && /\b(?:not quite|incorrect|isn'?t right|not right|wrong|pas tout à fait)\b/i.test(first)) out.push({ code: "verdict_mismatch", hard: true, fix: "the app marked their answer RIGHT, but the reply says it is wrong. Confirm it in a few words, then move on." });
    }
  }
  if (!c.wants.exercise && !c.wants.different && !c.wants.problemOnBoard && !c.wants.draw && !c.verdict && (ignoresStudentAnswer(c.message, t.heard, say) || (!c.wants.restart && !c.wants.why && !c.wants.write && !/\b(?:don'?t|do not|can'?t) (?:understand|get|see)|lost|confus|idk|no idea|comprends pas|perdu\b/i.test(c.message) && ignoresAnswerToQuestion(c.history, c.message, t.heard, t.speech)))) out.push({ code: "ignores_student", hard: true, fix: `the student just said "${c.message.slice(0, 80)}" and the reply doesn't respond to it. Start from THEIR words: say whether it fits (or what it would need to be) and ask how they got it, before anything else.` });
  // Only objects that exist in the problem: no cyclist in a car problem.
  { // The same first words as the last replies ("That's the…", "Right —", "Yes —"): a script, not a person.
    const open2 = (x: string) => x.toLowerCase().replace(/[^a-zà-ÿ' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    const mine = open2(say), recent = c.history.filter((h) => h.role === "assistant").slice(-3).map((h) => open2(h.text));
    const same = mine ? recent.filter((r) => r === mine).length : 0;
    if (same >= 1) out.push({ code: "stale_opener", hard: same >= 2, fix: `it opens with "${say.split(/\s+/).slice(0, 2).join(" ")}" again, as in recent replies. Start differently: react to something specific they said (in their own words), or begin straight with the content — no stock confirmation.` });
  }
  if (t.speech.some((sn) => FORMAT_INSTRUCTION.test(sn))) out.push({ code: "format_leak", hard: false, fix: "a sentence is an answer-format instruction (\"Provide your answer to three significant figures\"): that belongs to the exercise's answer box, not to what you say — remove it." });
  { const ghost = unstatedSetup(say, [...c.board.map((b) => b.text || ""), ...c.problems.map((p) => p.question || ""), ...c.said, ...c.history.map((h) => h.text), ...t.board.map(opText)]);
    if (ghost) out.push({ code: "unstated_setup", hard: true, fix: `it refers to "${ghost}" but the situation hasn't been stated yet. First put the problem on the board (a step op of kind "given" with all the numbers) or state it in a sentence — then ask about it.` }); }
  if (c.wants.topicSwitch && !t.board.some((o) => o.op === "topic")) out.push({ code: "intent_topic", hard: true, fix: "they asked to work on a different topic: open a fresh worksheet with a topic op (and a plan op for the new topic), state the first problem on the board, and say in a few words that you can come back to the old one. Do not carry on with the old plan." });
  if (/\b(?:equation|formula|expression|relation|formule)\b/i.test(c.message) && /\b(?:(?:didn'?t|did not|haven'?t|not|never) (?:put|write|written|show|on)|don'?t see|can'?t see|(?:write|put|show|add)\b|pas (?:écrit|au tableau)|je (?:ne )?vois pas)/i.test(c.message) && !/^\s*\[/.test(c.message) && !t.board.some((o) => (o.op === "step" || o.op === "gap") && ["formula", "strategy", "definition", "result", "insight"].includes(String(o.kind || "")) && /[=]/.test(String(o.text || ""))))
    out.push({ code: "intent_equation", hard: true, fix: "they asked for the EQUATION/FORMULA on the board and none was written: add a step op (kind formula or strategy) with the actual equation, in $…$, this turn — not just the givens — and say which line it is." });
  { const drawn = t.board.filter((o) => o.op === "draw" && (o as any).scene === "graph");
    const figures = [...drawn.map((o) => (o as any).spec), ...(drawn.length ? [] : c.board.filter((b: any) => b.graph).slice(-1).map((b: any) => b.graph))];
    for (const g of figures) { const bad = g ? figureClaimFalse(t.speech.join(" "), g) : null; if (bad) { out.push({ code: "graph_inconsistent", hard: true, fix: `what you say about the figure is not what it shows: ${bad}. Either redraw it so the curves really have that property (build related curves from ONE underlying function), or describe what the figure does show.` }); break; } }
    const regionsAnywhere = [...drawn.map((o) => (o as any).spec), ...c.board.map((b: any) => b.graph)].some((g: any) => (g?.regions || []).length > 0);
    if (!regionsAnywhere && t.speech.some((sn) => SHADE_CLAIM.test(sn))) out.push({ code: "shaded_claim", hard: true, fix: "the speech points at a shaded area or rectangle but nothing is shaded on any graph. Redraw the graph with a \"regions\" entry for that area (upper curve, lower curve, from, to, label), or stop referring to shading." }); }
  if (endsDead(t.speech, t.board, c.message)) out.push({ code: "dead_end", hard: true, fix: "the reply stops with nothing for them to do (\"That gives a total profit of 15.\"). Confirm in a few words, then keep the conversation going: ask why it works, give a small variation, or hand them the next step — end on ONE concrete question or task." });
  if (c.private?.length && t.speech.some((sn) => echoesPrivate(sn, c.private!))) out.push({ code: "echo_private", hard: true, fix: "a sentence repeats the student's own saved notes/preferences back at them (e.g. a style preference). Those only shape how you teach — never say them. Remove that sentence." });
  if (c.wants.advice && (t.move !== "recap" || t.board.some((o) => o.op === "problem"))) out.push({ code: "intent_advice", hard: true, fix: "they asked WHAT TO PRACTISE. Do not start another exercise: use the recap move — say in a few plain sentences what they showed today, what is still shaky, and name 2–3 specific things to practise before the test (each one concrete), then ask which they want to start with." });
  const uq = unsourcedQuotes(say, [...c.said, ...c.board.map((b) => b.text || ""), ...c.problems.map((p) => p.question || "")]);
  if (uq.length) out.push({ code: "unsourced_quote", hard: true, fix: `it quotes "${uq[0]}", words the student never gave and that are not on the board. Never quote a text from memory: point at a line by number or describe it in your own words, or ask the student to read the line out.` });
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
    if (invented.length) out.push({ code: "numbers", hard: ["confirm", "elicit", "focus", "probe_why", "practice", "revoice", "correct_error", "hint_procedure"].includes(t.move), fix: `it uses numbers nobody gave (${invented.slice(0, 3).join(", ")}) — only the problem's, the student's, or the verified solution's.` });
  }
  // 8b. Never invent an error in work that is right (reported live: "what went wrong there?" asked about a correct line).
  if (c.verdict === "correct" && !c.problems.some((p) => !p.solved) && /\b(?:what went wrong|what'?s wrong|where(?:'s| is| was) the (?:error|mistake|slip)|spot the (?:error|mistake|slip)|find the (?:error|mistake|slip)|qu'?est-ce qui (?:ne va pas|cloche)|où est l'erreur)\b/i.test(say))
    out.push({ code: "no_error", hard: true, fix: "their step is RIGHT (checked) — there is no error to find. Don't ask what went wrong or hint at a mistake; confirm in a few words and move on (a different example is fine, but say it is a new one)." });
  // 8c. Thinking aloud / correcting itself mid-reply ("= 40… non, pardon") reads as chaos: work it out first, then say it once.
  if (SELF_CORRECTION.test(say)) out.push({ code: "self_correct", hard: true, fix: "the reply corrects itself mid-way (\"wait\", \"non, pardon\", \"let me redo\", \"actually\"). Work the maths out first, then say only the clean final version, once." });
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
  let speech = t.speech.filter((s) => !revealsKey(s, c) && !FORMAT_INSTRUCTION.test(s) && !(c.private?.length && echoesPrivate(s, c.private)));
  const nums = new Set([...boardLineNumbers(c.board as any).values(), ...exerciseLineNumbers(c)]);
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
    if (c.goalsKnown === false && o.op === "plan") return false;
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
