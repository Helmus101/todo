// THE BOARD WRITER for the live voice. The voice (Gemini Live) is the tutor: it talks, and never writes. After every spoken exchange this
// one call decides what goes on the paper: the problem, the student's own CORRECT steps (as Otto's own clean lines, never their words),
// a one-line takeaway when the tutor explained an idea, and figures. Same op shapes and builders as the engine (apply.ts), so graphs,
// geometry, tables, timelines and cycles all render the same way.
import type { BoardEntry } from "../../shared/types.ts";
import { extractJsonObject, normalizeTurn, salvageTurn } from "../../shared/tutorTurn.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { createTutorChat, usageOf } from "../claude.ts";
import { applyOps } from "./apply.ts";
import { boardLineIsWrong, stripUnaskedUnit } from "../boardMath.ts";
import { DRAW_REFERENCE, TURN_PROMPT } from "./prompt.ts";

const OPS = TURN_PROMPT.slice(TURN_PROMPT.indexOf("BOARD OPS"), TURN_PROMPT.indexOf("RETURN ONLY"));

export const BOARD_WRITER_PROMPT = `You keep the paper whiteboard for a spoken tutoring session. You never speak. You receive the latest spoken exchange (Student and Tutor lines) and what is already on the board, and you return the board ops to add.

FIRST, in "notes", list in a few words each thing in this exchange that qualifies, answering this checklist honestly:
(a) Was a RULE, DEFINITION, FORMULA or IDENTITY stated or confirmed, by the tutor or by the student (even if the student said it in words)? → it is written, in tidy general form.
(b) Did the student reach a RESULT, expansion, simplification or final answer that the tutor confirmed as right ("exactly", "that's right", "spot on")? → the result line is written (the full line, e.g. the finished expansion). A result counts ONLY if the student reached it BEFORE the tutor's last question: whatever that last question asks them to work out is NOT a result yet (a worked example you would write to answer it is exactly what must not appear).
(c) Did the tutor pose a PROBLEM or task (a question with maths in it, an expression to evaluate, rewrite, solve, simplify or expand), including in its closing question? → ALWAYS write the problem itself on the board as a task line ("given"), in LaTeX, WITHOUT its answer (for example: "Rewrite $\\log_3(2x+1) = 2$ in exponential form"). Every problem that is posed is on the board, once.
(f) Did the tutor read a short PASSAGE aloud for a question (reading practice)? → put it on the board once as a "draw" op with scene "source" (verbatim text from the tutor's words only), before the choice op.
(e) Did the tutor ask a MULTIPLE-CHOICE question (options A, B, C…) or offer choices to pick from? → write ONE "choice" op with the question and EVERY option (LaTeX for maths), never marking the right one. If the tutor only SUMMARISED the question and sent the student to the board for the options ("the options are on the board", "which one?"), YOU compose the full problem: write the complete question as the choice op's text, with exactly four options: one correct (work it out and double check), three plausible wrong ones from typical mistakes. The question must match what the tutor said.
(d) Would a PICTURE help? → DRAW it, in this same pass. Draw whenever graphing, plotting, a curve, a shape, a diagram, a process, a timeline or a cycle comes up, and for any topic that is naturally visual (a function and its inverse, an exponential or log curve, a triangle, supply and demand, a cell): graphs of functions are "graph" ops with the real expressions; anything else is a "geometry", "flow", "table" or "svg" op. At most one new figure per pass; extend an existing graph instead of redrawing it.
Then put the ops for every item you listed in "board". If a box has nothing, say so in "notes" and write nothing for it.

WRITE ONLY:
1. THE PROBLEM, once, when the student states it: a "topic" op for a new problem or topic, then a "given" step with the full statement, cleanly typeset (maths in $…$). Never their raw words, never a "how would I solve this" lead-in.
2. THE STUDENT'S OWN STEPS and results, as they say them, ONLY when they are right: first recompute each one yourself. Write it as your own clean typeset line (kind "result" or "formula"), with no "why". A step that is wrong or unclear: write nothing for it, and never write the correction.
3. WHAT THE TUTOR EXPLAINED OR DEMONSTRATED: whenever the tutor gives a definition, a rule, a formula, an identity or a worked example, WRITE IT, as clean lines (kind "definition", "formula" or "result"; typeset maths in $…$; add a short "why" only when the reason is not obvious). The student should be able to look back at it: if the tutor said "since 2 to the power of 3 is 8, the log base 2 of 8 is 3", the board gets the definition and that example. Write the explanation and the example the tutor used, NOT the question the tutor then asks. When in doubt about an explanation, write it.
4. FIGURES that help them see it (draw ops: a graph, geometry, flow / cycle / timeline, table, number line, source...), whenever a picture would teach faster. Draw on an existing graph with "extend" instead of redrawing it.

PACING (the board must never run ahead of the student): the board shows only what the STUDENT has already said or reached, plus what the tutor explained as a general rule or a separate example. It never shows the next step, never the answer to the problem they are working on, and never a worked solution of that problem.
- A number, value or result goes on the board ONLY if it appears in a Student line of this exchange (or is already on the board). If you can compute it but the student has not said it, do not write it, even if the tutor hinted at it or asked about it.
- Write at most the ONE step the student has just completed correctly. Never write the steps after it, and never a whole calculation chain (for example "$f(0) = \\frac{8}{-1/3} = -24$") unless the student said every part of it.
- If the tutor is correcting them or pushing back ("check that again", "look at that numerator", "let's re-examine"), or the student's latest value is wrong, write NOTHING for that part: no corrected version, no right answer.
- Write a result EXACTLY as the student said it. Do not add a unit, a sign, a degree sign, "approximately", a rounding or a label they did not say. If the tutor's last question asks for exactly that missing piece (the unit, the sign, the direction, the name of the quantity), it must NOT be on the board yet: the student says the number "833", the board shows "833" and the tutor then asks "what unit?".
- A "worked example" means a DIFFERENT, simpler example the tutor used to teach an idea. It never means the student's own problem solved for them.

HOW MUCH: the board is the whole lesson on paper, so an exchange that teaches or confirms something usually adds one to three lines: the rule or definition, the worked example, the result the student reached (when the tutor confirms it is right), the final answer once THEY reached it. An empty list is right only for greetings, small talk, a question that adds nothing new, or an answer that was wrong.

MATHS IS ALWAYS LaTeX: every expression, however small or complicated (logs, fractions, roots, powers, trig, integrals, an equation inside a task line such as "Rewrite $\\log_3(2x+1) = 2$ in exponential form"), is typeset in $…$ — never plain text like log_3(2x+1)=2 or "x squared".

LAYOUT: write it like a clean page of notes. A heading (topic) when the subject changes. Prose lines stay short (under about 14 words) and carry ONE idea. An equation goes on its own line, with the label before it in the previous line or a short lead-in ("Kinetic energy:" then the equation on the next line), never buried in the middle of a sentence. A calculation is one step per line, each line the previous result simplified. Subscripts are written $E_{k,\\text{after}}$, never E_(k,after). Use kind "definition" for a definition, "formula" for a rule or equation, "given" for the numbers in the problem, "result" for what was found. Do not write two lines that say the same thing in different words. Never write a sub-question as a line ("Find the final velocity…"): the board holds the problem once, then the working. When the student finishes a problem, add ONE line of kind "summary": the takeaway in a sentence (what was found and the idea that got there).

NEVER WRITE: the tutor's questions, hints that point at the student's next step, THE ANSWER TO THE QUESTION THE TUTOR ASKS AT THE END OF THE EXCHANGE (the student has not answered it yet: if the tutor asks for log_5 25, "log_5 25 = 2" must not appear), a result the student has not reached, praise, chit-chat, or the tutor's sentences. Maths in $…$, lines short, one idea per line. Never repeat a line that is already on the board. If nothing qualifies, return {"board":[]}.


EXAMPLE
Exchange: "Student: I don't get logarithms" / "Tutor: To start from scratch, think of a logarithm as the opposite of an exponent. For example, since 2 to the power of 3 is 8, the logarithm base 2 of 8 is 3. What do you think the logarithm base 3 of 9 would be?"
Return: {"notes":["definition: a logarithm is the opposite of an exponent","example: 2^3 = 8 so log_2 8 = 3","question about log_3 9: not written"],"board":[{"op":"topic","cue":0,"text":"Logarithms"},{"op":"step","cue":0,"text":"A logarithm is the opposite of an exponent: $\\log_b x = y \\iff b^y = x$","kind":"definition"},{"op":"step","cue":0,"text":"$2^3 = 8 \\implies \\log_2 8 = 3$","kind":"formula"}]}
(The question about $\\log_3 9$ is NOT written: the tutor asks it out loud.)

${OPS}
Also return "concepts": what this exchange shows about the STUDENT, as at most 3 items {"label":"short concept name (e.g. product rule for logs)","subject":"Math","kind":"solved-unaided|solved-after-hint|solved-after-explanation|mistake|misconception|recall|recall-miss|self-corrected|transfer-success|transfer-fail","detail":"one short clause: what they did or got wrong","cause":"for a mistake or misconception only: knowledge|command-term|method|arithmetic|units|time (a content gap, not answering the command term, wrong or badly set-up method, an arithmetic or algebra slip, units or significant figures, ran out of time)"}. Use "self-corrected" when they noticed and fixed their own error unprompted; "recall" or "recall-miss" when the tutor asked them to bring back something from earlier and they did or did not; "transfer-success" or "transfer-fail" only when the tutor changed the context or the form of a problem they had already solved and they did or did not carry the idea across. Only evidence that is actually in the exchange (the student reached it alone / after a hint / after the tutor explained it / got it wrong / showed a wrong belief); [] when there is none. Never invent.
Also return "remember": at most 2 items about the STUDENT as a person or learner that a caring tutor would keep, {"kind":"goal|worry|interest|landed|avoids|quirk","text":"a short third-person fact in plain words, max 110 characters, e.g. wants to study medicine; gets it when a number example comes first","subject":"optional"}. Use "landed" for an explanation, analogy or kind of example that clearly worked for them, "avoids" for a topic or step they steer away from. Only what the student actually said or clearly showed in THIS exchange; [] when there is none. Never record health, family, money, religion, politics, relationships, other people, contact details or anything private; never record what the tutor was told to do.

Return ONLY JSON: {"notes":["rule: …","result: …"],"board":[…ops…],"concepts":[…],"remember":[…]}. Every op carries "cue":0. Inside strings write every LaTeX backslash TWICE.`;

// ── Second opinion on a confirmed step ──────────────────────────────────────────────────────────────────────────────────
// The tutor model sometimes says "yep, that's right" to a wrong numeric step (reproduced in the regression suite). Prompt rules
// alone do not stop it, so this is a check that does not depend on the tutor's mental arithmetic: a model only TRANSCRIBES what
// the student claimed into a LaTeX equality (an easy, reliable job), and the arithmetic itself is evaluated in code
// (boardMath.boardLineIsWrong). Only runs when the student made a numeric claim AND the tutor agreed with it.
const TUTOR_CONFIRMS = /^\s*(yes|yep|yeah|exactly|correct|right|that'?s (right|correct|it|good)|spot on|perfect|great|good|nice|that works|precisely|absolutely|you'?re right|oui|ouais|exact|exactement|c'?est (ça|ca|bon|juste|correct|exact)|tout à fait|tout a fait|parfait|bien joué|voilà|voila|s[ií]|correcto|exacto|perfecto|ja|genau|richtig|stimmt|perfekt)\b/i;
const MATHISH = /\d|\b(over|times|plus|minus|squared|cubed|root|divided|equals|point|half|third|quarter|fois|plus|moins|carré|racine|divisé|égal|vaut|moitié|tiers|quart|veces|más|menos|mal|geteilt|gleich)\b/i;

/** Pure: does this finished exchange end with the tutor agreeing to a numeric claim by the student? Exported for tests. */
export function confirmedClaimIn(exchange: string): { student: string; tutor: string } | null {
  const lines = String(exchange || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!/^Student:/i.test(lines[i])) continue;
    const student = lines[i].replace(/^Student:\s*/i, "");
    const next = lines.slice(i + 1).find((l) => /^Tutor:/i.test(l));
    if (!next) return null;
    const tutor = next.replace(/^Tutor:\s*/i, "");
    return MATHISH.test(student) && TUTOR_CONFIRMS.test(tutor) ? { student, tutor } : null;
  }
  return null;
}

const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, half: 2, third: 3, quarter: 4, fifth: 5, squared: 2, cubed: 3, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six_: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

/** Every number the student actually said, as digits or words ("nine", "squared" counts as 2), so a transcribed claim can be held to it. Pure. */
export function numbersSaid(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of String(text || "").matchAll(/\d+(?:[.,]\d+)?/g)) out.add(Number(m[0].replace(",", ".")));
  for (const w of String(text || "").toLowerCase().match(/[a-zà-ÿ]+/g) || []) if (w in NUMBER_WORDS) out.add(NUMBER_WORDS[w]);
  return out;
}

/** A transcribed claim is only trusted when every number in it was said by the student: a model that "transcribes" a number nobody said would
 *  otherwise make the second opinion accuse the tutor, and the student, of an error that is not there. Pure. */
export function claimIsGrounded(claim: string, said: string): boolean {
  const spoken = numbersSaid(said);
  const nums = [...String(claim || "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return nums.length > 0 && nums.every((n) => spoken.has(n) || n === 1 || n === 0);
}

/** The student claims (as numeric LaTeX equalities) that are arithmetically false although the tutor agreed. [] when fine or unreadable. */
export async function checkStudentClaims(exchange: string, tokens: { in: number; out: number; cachedIn: number }): Promise<string[]> {
  const hit = confirmedClaimIn(exchange);
  if (!hit) return [];
  try {
    const res = await createTutorChat({
      max_tokens: 400, temperature: 0, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You transcribe, you never solve or correct. Given one sentence a student said aloud in a maths lesson, write each numeric claim they made as a LaTeX equality using numbers only (fractions, roots, powers, products), EXACTLY as they stated it, even if it is wrong. Skip anything with a variable or letter, anything that is not a claim, and anything you are unsure they said. Return JSON {"claims":["\\sqrt{\\frac{72}{56}} = \\sqrt{\\frac{9}{14}}"]} with at most 3 claims, or {"claims":[]}. Write every LaTeX backslash twice.` },
        { role: "user", content: `Student said: ${hit.student.slice(0, 600)}` },
      ],
    }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const parsed: any = extractJsonObject(String(res?.choices?.[0]?.message?.content || ""));
    const claims: string[] = Array.isArray(parsed?.claims) ? parsed.claims.filter((c: unknown) => typeof c === "string").slice(0, 3) : [];
    return claims.filter((c) => claimIsGrounded(c, hit.student) && boardLineIsWrong(c));
  } catch { return []; }
}

/** Someone mentioned graphing, plotting, a curve, a shape or a diagram (or the tutor offered to graph it): a figure belongs on the board. Pure. */
export function wantsPicture(exchange: string): boolean {
  return /\b(?:graph(?:ing|ed)?|plot(?:ting|ted)?|sketch|draw(?:ing)?|curve|parabola|diagram|picture|visuali[sz]e|number line|timeline|triangle|circle|cycle|flow ?chart)\b/i.test(exchange);
}

/** The closing question poses a concrete problem (maths in it, or an instruction like "rewrite / evaluate / solve / simplify / expand"). Pure. */
export function posesProblem(question: string): boolean {
  const q = String(question || "");
  if (q.split(/\s+/).length < 4) return false;
  return /\$|\d|\b(?:log|ln|sin|cos|tan|derivative|integral|equation|fraction|square root|squared|cubed|power|base)\b/i.test(q) && /\b(?:rewrite|evaluate|solve|simplify|expand|factori[sz]e|find|work out|calculate|compute|what (?:is|would|does|do)|how (?:would|do)|can you|try)\b/i.test(q);
}

/** The tutor's last line ends in a question: split it off, so "what is log_5 25?" is never turned into "log_5 25 = 2" on the board. Pure. */
// A sentence that hands the student something to do ("Now convert it to exponential form.", "Go ahead and solve it.", "Your turn.") is as open as a
// question: whatever the student is asked to do must never already be on the board.
const DIRECTIVE = /^\s*(?:(?:ok(?:ay)?|so|now|next|then|alright|good|go ahead(?: and)?|please|your turn|you can)[,:]?\s+)*(?:go ahead|try|solve|convert|rewrite|write|find|calculate|compute|work out|simplify|expand|factori[sz]e|apply|use|isolate|substitute|plug|divide|multiply|add|subtract|take|raise|set|check|show|tell|give|continue|finish|complete|differentiate|integrate|evaluate|determine|sketch|draw|label|name|identify|explain|describe|state|your turn)\b/i;
const isOpenSentence = (t: string) => /\?\s*$/.test(t) || DIRECTIVE.test(t);

export function splitOpenQuestion(exchange: string): { finished: string; openQuestion: string } {
  const lines = exchange.split("\n");
  const last = lines.length - 1;
  if (last < 0 || !/^Tutor:/i.test(lines[last])) return { finished: exchange, openQuestion: "" };
  const body = lines[last].replace(/^Tutor:\s*/i, "");
  const sentences = body.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [body];
  if (!isOpenSentence(sentences[sentences.length - 1] || "")) return { finished: exchange, openQuestion: "" };
  // The open part is the trailing run of questions and directives; a statement before it is finished teaching.
  const q: string[] = [];
  while (sentences.length && isOpenSentence(sentences[sentences.length - 1] || "")) q.unshift(sentences.pop()!.trim());
  const rest = sentences.join(" ").trim();
  return { finished: [...lines.slice(0, last), ...(rest ? [`Tutor: ${rest}`] : [])].join("\n"), openQuestion: q.join(" ").trim() };
}

/** The tutor just confirmed a step the student said ("Yes, exactly", "Spot on", "Right") and the student's line carries maths: that step belongs on the paper. */
export function confirmedStudentStep(exchange: string): string {
  const lines = exchange.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^Tutor:/i.test(lines[i]) || !/^Tutor:\s*(?:yes|yep|yeah|right|exactly|correct|spot on|that'?s (?:right|correct|it)|good|nice|well done|perfect|precisely)\b/i.test(lines[i])) continue;
    const prev = lines[i - 1];
    if (/^Student:/i.test(prev)) { const t = prev.replace(/^Student:\s*/i, ""); return /[=]|\d|\blog|\bsquared|\bover\b|\bplus\b|\bminus\b|\btimes\b|\bx\b/i.test(t) && t.split(/\s+/).length >= 3 ? t : ""; }
  }
  return "";
}

/** The tutor said something worth keeping (a definition, a rule, a worked example, a formula): numbers or maths with an explaining word. */
export function tutorExplained(exchange: string): boolean {
  const tutor = exchange.split("\n").filter((l) => /^Tutor:/i.test(l)).map((l) => l.replace(/^Tutor:\s*/i, "")).join(" ");
  if (tutor.split(/\s+/).length < 14) return false;
  return /\b(?:for example|for instance|means|is the (?:opposite|inverse|same)|opposite of|equals?|is called|defined as|the rule|formula|because|so that|therefore|works like|think of)\b/i.test(tutor) && (/\d|\$|=|\bsquared|\bpower\b|\bbase\b|\bderivative\b|\bintegral\b/i.test(tutor) || tutor.split(/\s+/).length > 30);
}

export async function writeBoard(input: { exchange: string; board: BoardEntry[]; subject?: string; history?: string; language?: string; early?: boolean }, tokens: { in: number; out: number; cachedIn: number }): Promise<{ board: BoardEntry[]; dropped: string[]; concepts: any[]; remember?: any[]; flags: string[] }> {
  // Runs alongside the board call, so it adds no waiting: wrong numeric claims the tutor just agreed to (see checkStudentClaims).
  const flagsP = input.early ? Promise.resolve([] as string[]) : checkStudentClaims(input.exchange, tokens).catch((): string[] => []);
  const canDraw = true; // Unlimited visual artifact capabilities across all subjects
  const system = BOARD_WRITER_PROMPT + (input.language ? `\n\nLANGUAGE: the student works in ${input.language}. Write every board line, heading, option and label in ${input.language} (maths stays LaTeX). Op names and kinds stay as specified.` : "") + (canDraw ? DRAW_REFERENCE : "") + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(input.board, []) || ": empty."}`;
  // The tutor's closing question is still UNANSWERED: it is shown to the writer separately, so the working for it is never mistaken for something the student reached.
  const { finished, openQuestion } = splitOpenQuestion(input.exchange.slice(0, 4000));
  const user = `${input.subject ? `Subject: ${input.subject}\n` : ""}${input.history ? `EARLIER IN THIS SESSION (context only: it tells you what a short answer like "two, right?" refers to; do NOT rewrite what is already on the board):\n${input.history.slice(-2500)}\n\n` : ""}LATEST EXCHANGE (what has been said and settled):\n${finished}${openQuestion ? `\n\nTHE TUTOR THEN ASKED THE STUDENT (still unanswered: never write its answer or its working; if it poses a NEW problem, WRITE that problem now as a task line in LaTeX, without its answer; if it is only the next step or sub-question of the problem already on the board, write NO task line for it: the problem line already carries it):\n${openQuestion}` : ""}`;
  const studentWords = input.exchange.split("\n").filter((l) => /^Student:/i.test(l)).map((l) => l.replace(/^Student:\s*/i, ""));
  let remembered: any[] = [];
  const once = async (extra?: string, already: BoardEntry[] = []) => {
    const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
    if (extra) messages.push({ role: "user", content: extra });
    const res = await createTutorChat({ max_tokens: 2500, temperature: 0.1, response_format: { type: "json_object" }, messages }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const raw = String(res?.choices?.[0]?.message?.content || "");
    const parsed: any = extractJsonObject(raw) ?? salvageTurn(raw);
    const concepts = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
    if (Array.isArray(parsed?.remember) && parsed.remember.length) remembered = parsed.remember.slice(0, 2);
    const turn = normalizeTurn({ speech: ["."], board: Array.isArray(parsed?.board) ? parsed.board : [] });
    if (!turn || !turn.board.length) return { board: [] as BoardEntry[], dropped: [] as string[], concepts };
    const applied = applyOps(turn.board.map((o) => ({ ...o, cue: 0 })), { board: [...input.board, ...already], problems: [], theirWords: studentWords });
    // Independent arithmetic check: a line whose own equalities are false (a student slip the model let through, or its own
    // slip) never reaches the paper. Lines the checker cannot read are kept.
    const board = applied.board.filter((e) => {
      const wrong = typeof e.text === "string" && boardLineIsWrong(e.text);
      if (wrong) { applied.dropped.push(`line: its arithmetic does not hold, not written: ${String(e.text).slice(0, 80)}`); console.warn(`[live] board line dropped, arithmetic does not hold: ${String(e.text).slice(0, 120)}`); }
      return !wrong;
    });
    // The tutor is asking about the unit: a unit the student has not said must not already be on the board.
    const askedUnit = /\bunits?\b/i.test(openQuestion);
    const finalBoard = askedUnit
      ? board.map((e) => (typeof e.text === "string" && ["result", "formula", "step", "given"].includes(String(e.kind)) ? { ...e, text: stripUnaskedUnit(e.text, studentWords.join(" ")) } : e))
      : board;
    return { board: finalBoard, dropped: applied.dropped, concepts };
  };
  let out = await once();
  // The board has to match the lesson. Two things are always checked, and one more call fixes both: (1) the tutor explained something and
  // nothing was written (the model was cautious, or the app rejected the ops); (2) the tutor posed a problem and no task line came back.
  // While Otto is still speaking (early) only the problem the tutor just posed is chased: it is the line the student needs in front of them first.
  const needExplain = !input.early && !out.board.length && tutorExplained(input.exchange);
  const needProblem = posesProblem(openQuestion) && !out.board.some((e) => e.kind === "given") && !input.board.slice(-4).some((e) => e.kind === "given"); // a step of the problem already on the board is not a new problem
  const stepSaid = confirmedStudentStep(input.exchange);
  const needStep = !input.early && !!stepSaid && !out.board.some((e) => ["gap", "result", "formula", "insight"].includes(String(e.kind)));
  const needPicture = !input.early && canDraw && wantsPicture(input.exchange) && !out.board.some((e) => ["graph", "svg", "diagram", "geometry", "flow", "table", "numberline"].includes(String(e.kind)));
  if (needExplain || needProblem || needPicture || needStep) {
    const why = out.dropped.length ? ` The app rejected these ops: ${out.dropped.slice(0, 3).join("; ")}.` : "";
    const asks = [
      needExplain ? "(You wrote nothing, but the tutor explained something worth keeping." + why + " Write the definition or rule and the worked example the tutor gave as board lines now, never the question it asked.)" : "",
      needStep ? `The tutor just confirmed the student's step ("${stepSaid.slice(0, 160)}"). Write that step on the board now as a clean line of correct maths (fix the speech-recognition wording into proper notation; never write anything the student has not said, and never the step after it).` : "",
      needPicture ? "The exchange is about graphing or a picture: DRAW it now (a graph op with the real function, or an svg / geometry / flow op), never leave it as words." : "",
      needProblem ? `The tutor posed a problem and you did not write it: write the problem itself now as a task line (kind "given") in LaTeX, without its answer: ${openQuestion.slice(0, 300)}` : "",
    ].filter(Boolean).join(" ");
    const second = await once(`${asks} Return the same JSON shape.`, out.board);
    if (second.board.length) { const all = [...out.board, ...second.board]; out = { board: [...all.filter((e) => e.kind === "focus"), ...all.filter((e) => e.kind !== "focus")], dropped: out.dropped, concepts: out.concepts.length ? out.concepts : second.concepts }; }
    else console.warn(`[live] board writer still wrote nothing (${(second.dropped.length ? second.dropped : out.dropped).slice(0, 2).join("; ") || "no ops"})`);
  }
  return { ...out, remember: remembered, flags: await flagsP };
}
