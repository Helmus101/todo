// THE BOARD WRITER for the live voice. The voice (Gemini Live) is the tutor: it talks, and never writes. After every spoken exchange this
// one call decides what goes on the paper: the problem, the student's own CORRECT steps (as Otto's own clean lines, never their words),
// a one-line takeaway when the tutor explained an idea, and figures. Same op shapes and builders as the engine (apply.ts), so graphs,
// geometry, tables, timelines and cycles all render the same way.
import type { BoardEntry } from "../../shared/types.ts";
import { extractJsonObject, normalizeTurn, salvageTurn } from "../../shared/tutorTurn.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { createTutorChat, usageOf } from "../claude.ts";
import { applyOps } from "./apply.ts";
import { numbersSaid, claimIsGrounded, plainDigits } from "./numbers.ts";
import { verifyConfirmedStep } from "./verifier.ts";
export { numbersSaid, claimIsGrounded };
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
0. A MULTI-PART QUESTION (an exam question with parts (a), (b), (c) and marks, or a data table): write the whole of it, the data and the setup as one "given" line and EACH part as its own "given" line with its marks in brackets, using exactly the numbers and units the tutor said and never a changed or invented value. Chemical formulae keep their subscripts (CaCO_3). Never write the answer to a part.
1. THE PROBLEM, once, when the student states it: a "topic" op for a new problem or topic, then a "given" step with the full statement, cleanly typeset (maths in $…$). Never their raw words, never a "how would I solve this" lead-in.
2. THE STUDENT'S OWN STEPS and results, as they say them, ONLY when they are right: first recompute each one yourself. Write it as your own clean typeset line (kind "result" or "formula"), with no "why". A step that is wrong or unclear: write nothing for it, and never write the correction.
3. WHAT THE TUTOR EXPLAINED OR DEMONSTRATED: whenever the tutor gives a definition, a rule, a formula, an identity or a worked example, WRITE IT, as clean lines (kind "definition", "formula" or "result"; typeset maths in $…$; add a short "why" only when the reason is not obvious). The student should be able to look back at it: if the tutor said "since 2 to the power of 3 is 8, the log base 2 of 8 is 3", the board gets the definition and that example. Write the explanation and the example the tutor used, NOT the question the tutor then asks. When in doubt about an explanation, write it.
4. FIGURES that help them see it (draw ops: a graph, geometry, flow / cycle / timeline, table, number line, source...), whenever a picture would teach faster. Draw on an existing graph with "extend" instead of redrawing it.

PACING (the board must never run ahead of the student): the board shows only what the STUDENT has already said or reached, plus what the tutor explained as a general rule or a separate example. It never shows the next step, never the answer to the problem they are working on, and never a worked solution of that problem.
- THE STUDENT'S OWN PROBLEM: write the working lines the student produced or confirmed. A line the TUTOR supplied (a rule it named as a hint such as the power rule, a substitution, a simplified form such as "t = 8 ln 3 / ln 2", a set-up) is written only after the student has repeated it, used it or agreed with it, and never in the same pass in which the tutor first says it while the next question about it is still open. What the tutor TEACHES on request (a definition, a formula the student asked for, a worked example on another case) is written as usual.
- THE SAME HOLDS FOR EVERY KIND OF QUESTION, not only arithmetic: an algebraic expression, a name or term, a definition, a rule, a reason, a choice between options, a sign, a unit, a graph feature. If the tutor's last question asks the student to produce it ("what is the derivative?", "which rule applies?", "why?", "what do you get when you factorise?"), it goes on the board only after a Student line says it, in the student's own content cleaned into notation. What the tutor merely names or hints at does not count as the student having said it. Until then write the question's setup, never its answer.
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

/** The tutor poses a NEW concrete problem (an introducing cue such as "solve", "find", "try this", "here's one", "next question", with real maths in it). A follow-up
 *  question about the problem already under way ("what do you do next?", "does that quadratic factorise?") is not a new problem and must not
 *  produce a task line. Pure. */
export function posesProblem(question: string): boolean {
  const q = String(question || "");
  if (q.split(/\s+/).length < 6) return false;
  const INTRO = /\b(?:solve|find|calculate|compute|determine|evaluate|simplify|expand|factori[sz]e|prove|show that|differentiate|integrate|sketch|work out|rewrite|let'?s try|here'?s (?:one|a|the|another)|try this|next (?:one|question|problem)|new (?:one|question|problem)|another (?:one|question|problem)|how about|consider|suppose|given that|what (?:is|'s|would be) the (?:value|sum|product|derivative|integral|probability|mean|speed|force|energy|logarithm|log|limit|area|volume|gradient)|a (?:ball|particle|car|object|cell|company|firm|sample|solution|bag|box|sequence|function)\b)/gi;
  const MATH = /\d+(?:\.\d+)?|\$|\b(?:log|ln|sin|cos|tan|root|squared|cubed|equals?|over|plus|minus|times|derivative|integral|equation|probability|limit|mean|force|speed|energy|mass|velocity)\b|=/gi;
  const ANAPHOR = /\b(?:that|those|these|them|both|your|it|the (?:quadratic|equation|roots?|expression|result|answer|two|first|second|next|last|previous|step))\b/i;
  // A problem is posed when an introducing cue is followed, straight away, by a self-contained statement made of maths (not by "that", "it" or "the roots",
  // which point back at the work already under way).
  for (const m of q.matchAll(INTRO)) {
    const words = q.slice((m.index || 0) + m[0].length).split(/\s+/);
    const maths = (`${m[0]} ${words.slice(0, 20).join(" ")}`.match(MATH) || []).length;
    if (maths >= 3 && !ANAPHOR.test(words.slice(0, 8).join(" "))) return true;
  }
  return false;
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

/** Is the problem the tutor just posed already on the board? Compared by the numbers in it: a new problem after a short board is NOT already there
 *  just because some task line is, which is what used to leave a second problem (a system of equations after a log equation) off the paper. Pure. */
export function problemOnBoard(question: string, board: { kind?: string; text?: string }[]): boolean {
  const said = [...numbersSaid(question)].filter((n) => n > 1);
  if (!said.length) return board.some((e) => e.kind === "given");
  return board.some((e) => {
    if (e.kind !== "given" || typeof e.text !== "string") return false;
    const onBoard = new Set([...e.text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
    return said.filter((n) => onBoard.has(n)).length / said.length >= 0.75;
  });
}

/** Does this board line already carry the answer to the question just asked? The question names its numbers ("what is 0.0500 times 22.7?"); a line that uses all of them and
 *  ends in "= <a number nobody has said>" is the answer. Pure. */
export function answersOpenQuestion(line: string, question: string, known: Set<number>): boolean {
  const qn = [...new Set([...String(plainDigits(question)).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])))].filter((n) => n !== 1 && n !== 0);
  const text = plainDigits(line);
  const eq = text.lastIndexOf("=");
  if (eq < 0) return false;
  const rhs = [...text.slice(eq + 1).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!rhs.length) return false;
  const lhsNums = new Set([...text.slice(0, eq).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
  // A question worded in words ("what is two to the power of four?") names no digits: any line that computes from numbers already said into a value nobody has said is the answer.
  const usesQuestion = qn.length >= 2 ? qn.every((n) => lhsNums.has(n)) : lhsNums.size > 0 && [...lhsNums].every((n) => n <= 1 || known.has(n));
  const value = rhs[rhs.length - 1];
  return usesQuestion && !known.has(value) && !qn.includes(value);
}

/** A rule or identity the tutor merely NAMES as a hint while it waits for the student's next step ("use the power rule", "combine with log a + log b") is the thing the student is meant
 *  to find. It is held off the board unless the student asked for it (what is / formula / rule / remind me / no idea). Pure. */
export function hintedRuleHeld(kind: string, studentWords: string[], openQuestion: string): boolean {
  if (!openQuestion || !["formula", "definition"].includes(kind)) return false;
  const last = studentWords.slice(-2).join(" ");
  return !/\b(?:what(?:'s| is| are)|formula|rule|law|identity|remind|forgot|forget|don'?t (?:know|remember|get|understand)|do not (?:know|understand)|confus\w*|lost|stuck|no idea|explain|define|meaning|mean|teach|learn|from scratch)\b/i.test(last);
}

/** The tutor says it is putting something on the board (or that it is there). Pure. */
export function promisesBoard(tutorText: string): boolean {
  return /\b(?:put|putting|write|writing|wrote|written|draw|drawing|drew|add|adding|added|up)\b[^.?!]{0,40}\bboard\b|\bon the board\b|\bon the paper\b|\bon the whiteboard\b|\bsur le tableau\b/i.test(String(tutorText || ""));
}

/** The tutor said something worth keeping (a definition, a rule, a worked example, a formula): numbers or maths with an explaining word. */
export function tutorExplained(exchange: string): boolean {
  const tutor = exchange.split("\n").filter((l) => /^Tutor:/i.test(l)).map((l) => l.replace(/^Tutor:\s*/i, "")).join(" ");
  if (tutor.split(/\s+/).length < 14) return false;
  return /\b(?:for example|for instance|means|is the (?:opposite|inverse|same)|opposite of|equals?|is called|defined as|the rule|formula|because|so that|therefore|works like|think of)\b/i.test(tutor) && (/\d|\$|=|\bsquared|\bpower\b|\bbase\b|\bderivative\b|\bintegral\b/i.test(tutor) || tutor.split(/\s+/).length > 30);
}

export async function writeBoard(input: { exchange: string; board: BoardEntry[]; subject?: string; history?: string; language?: string; early?: boolean; toolMode?: boolean; penWrote?: boolean }, tokens: { in: number; out: number; cachedIn: number }): Promise<{ board: BoardEntry[]; dropped: string[]; concepts: any[]; remember?: any[]; flags: string[] }> {
  // Runs alongside the board call, so it adds no waiting: the step verifier recomputes a step the tutor just agreed to, from the problem. (The older
  // claim checker, checkStudentClaims, turned spoken steps into equations and misread speech such as "root 1 over 2 is a half" as sqrt(1/2) = 1/2,
  // which raised false alarms; it no longer feeds the tutor.)
  const flagsP: Promise<string[]> = input.early ? Promise.resolve([] as string[]) : verifyConfirmedStep({ exchange: input.exchange, history: input.history, board: input.board, subject: input.subject }, tokens).then((f) => (f ? [f] : [])).catch((): string[] => []);
  const canDraw = true; // Unlimited visual artifact capabilities across all subjects
  const system = BOARD_WRITER_PROMPT + (input.language ? `\n\nLANGUAGE: the student works in ${input.language}. Write every board line, heading, option and label in ${input.language} (maths stays LaTeX). Op names and kinds stay as specified.` : "") + (canDraw ? DRAW_REFERENCE : "") + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(input.board, []) || ": empty."}`;
  // The tutor's closing question is still UNANSWERED: it is shown to the writer separately, so the working for it is never mistaken for something the student reached.
  const { finished, openQuestion } = splitOpenQuestion(input.exchange.slice(0, 4000));
  // toolMode: the tutor writes the board itself (write_board). This pass then records only what the tutor may have missed: the student's own
  // working, and pictures. Problems, rules, explanations and corrections are the tutor's.
  const toolNote = input.toolMode ? "\n\nTHE TUTOR WRITES THE BOARD ITSELF in this session. You only add (a) a drawing the exchange needs (graph, diagram, number line, table, multiple-choice options), and (b) a NEW problem the tutor just posed out loud that is not on the board (as a task line, kind \"given\", without its answer). Never write the student's working, a heading, rule, formula, definition or explanation: those are the tutor's." : "";
  const user = `${input.subject ? `Subject: ${input.subject}\n` : ""}${input.history ? `EARLIER IN THIS SESSION (context only: it tells you what a short answer like "two, right?" refers to; do NOT rewrite what is already on the board):\n${input.history.slice(-2500)}\n\n` : ""}LATEST EXCHANGE (what has been said and settled):\n${finished}${openQuestion ? `\n\nTHE TUTOR THEN ASKED THE STUDENT (still unanswered: never write its answer or its working; if it poses a NEW problem, WRITE that problem now as a task line in LaTeX, without its answer; if it is only the next step or sub-question of the problem already on the board, write NO task line for it: the problem line already carries it):\n${openQuestion}` : ""}${toolNote}`;
  const studentWords = input.exchange.split("\n").filter((l) => /^Student:/i.test(l)).map((l) => l.replace(/^Student:\s*/i, ""));
  // A new problem may be posed in a sentence before the closing question ("Now the trap: try e^{2x} - 3e^x - 4 = 0. What happens to y?"): look
  // at the open question first, then at each sentence of the tutor's last line.
  const lastTutor = (input.exchange.split("\n").filter((l) => /^Tutor:/i.test(l)).pop() || "").replace(/^Tutor:\s*/i, "");
  const posedText = posesProblem(openQuestion) ? openQuestion : lastTutor.split(/(?<=[.?!])\s+/).find((x) => posesProblem(x)) || "";
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
    // A task line may only contain numbers that were actually said or are already on the board: a writer that "tidies" a problem and changes a
    // number (reported in simulation: "3.5 hours" became "5 hours") would put a different problem in front of the student.
    const known = numbersSaid(`${input.exchange} ${input.history || ""} ${input.board.map((e) => e.text || "").join(" ")}`);
    const grounded = board.filter((e) => {
      if (e.kind !== "given" || typeof e.text !== "string") return true;
      // Chemical formulae and units are not numbers anybody "said": drop \text{...} bodies, subscripts and digits glued to letters (CaCO_3, CO$_2$, H₂O).
      const stripped = plainDigits(e.text).replace(/\\text\{[^}]*\}/g, " ").replace(/\\[a-zA-Z]+/g, " ").replace(/_\{[^}]*\}|_\d+|\^\{[^}]*\}|\^\d+/g, " ").replace(/[A-Za-z]\d+|\d+[A-Za-z]/g, " ");
      const bad = [...stripped.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => n > 1 && !known.has(n));
      if (bad.length) { applied.dropped.push(`given: it contains numbers nobody said (${bad.join(", ")}), not written: ${String(e.text).slice(0, 80)}`); console.warn(`[live] task line dropped, number not said (${bad.join(", ")}): ${String(e.text).slice(0, 100)}`); return false; }
      return true;
    });
    // The answer to the question the tutor has just asked must not already be on the paper (reported in simulation: "what is 0.0500 times 22.7?" was
    // answered on the board with "= 1.14" before the student said a word).
    // While Otto is still speaking only the setup goes up (problem, heading, definition, formula, figure): a result, step or summary waits for the pass after the turn, when the
    // student has said it. Otherwise the paper shows the answer the tutor is in the middle of announcing, before the student has reached it.
    const SETUP = new Set(["focus", "given", "definition", "formula", "graph", "svg", "diagram", "geometry", "flow", "table", "numberline", "topic", "source"]);
    // A result, step or summary may only hold numbers the STUDENT said (or already on the paper): the tutor announcing "x equals sixteen" is not the student reaching it.
    const studentKnown = numbersSaid(`${studentWords.join(" ")} ${(input.history || "").split("\n").filter((l) => /^Student:/i.test(l)).join(" ")} ${input.board.map((e) => e.text || "").join(" ")}`);
    const earned = grounded.filter((e) => {
      if (typeof e.text !== "string") return true;
      const kind = String(e.kind);
      if (hintedRuleHeld(kind, studentWords, openQuestion)) { applied.dropped.push(`${kind}: a rule the tutor only hinted at, held until the student uses it: ${e.text.slice(0, 80)}`); return false; }
      if (input.early && !SETUP.has(kind)) { applied.dropped.push(`${kind}: held back until the student has said it, not written yet: ${e.text.slice(0, 80)}`); return false; }
      if (!["result", "summary", "step", "insight", "note", "strategy", "gap"].includes(kind)) return true;
      const stripped = plainDigits(e.text).replace(/\\text\{[^}]*\}/g, " ").replace(/\\[a-zA-Z]+/g, " ").replace(/_\{[^}]*\}|_\d+|\^\{[^}]*\}|\^\d+/g, " ").replace(/[A-Za-z]\d+|\d+[A-Za-z]/g, " ");
      const unsaid = [...stripped.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => n > 1 && !studentKnown.has(n));
      if (unsaid.length) { applied.dropped.push(`${kind}: it holds numbers the student has not said (${unsaid.join(", ")}), not written yet: ${e.text.slice(0, 80)}`); return false; }
      return true;
    });
    const noPreempt = earned.filter((e) => {
      if (!openQuestion || typeof e.text !== "string" || !["result", "formula", "step", "gap"].includes(String(e.kind))) return true;
      if (!answersOpenQuestion(e.text, openQuestion, known)) return true;
      applied.dropped.push(`${e.kind}: it gives the answer to the question the tutor just asked, not written: ${String(e.text).slice(0, 80)}`);
      return false;
    });
    // The tutor is asking about the unit: a unit the student has not said must not already be on the board.
    const askedUnit = /\bunits?\b/i.test(openQuestion);
    const unitFixed = askedUnit
      ? noPreempt.map((e) => (typeof e.text === "string" && ["result", "formula", "step", "given"].includes(String(e.kind)) ? { ...e, text: stripUnaskedUnit(e.text, studentWords.join(" ")) } : e))
      : noPreempt;
    // When the tutor's pen already wrote during this exchange, only a drawing can still be missing: text lines would repeat what it wrote in other words.
    const DRAWN = new Set(["graph", "svg", "diagram", "geometry", "flow", "table", "numberline", "choice"]);
    // A problem the tutor posed out loud and never wrote (the pen stayed still this exchange) is still put up: the student must see it.
    const posedMissing = !!posedText && !problemOnBoard(posedText, input.board.slice(-12));
    // In tool mode the student's working is written by the pen alone: the writer's own versions repeated it in other words and sometimes recorded
    // a misconception as a result (seen in simulation). It keeps only drawings and a posed problem the pen left off.
    const finalBoard = input.toolMode ? unitFixed.filter((e) => { const keep = DRAWN.has(String(e.kind)) || (String(e.kind) === "given" && posedMissing); if (!keep) applied.dropped.push(`${e.kind}: the tutor writes that itself`); return keep; }) : unitFixed;
    return { board: finalBoard, dropped: applied.dropped, concepts };
  };
  let out = await once();
  // The board has to match the lesson. Two things are always checked, and one more call fixes both: (1) the tutor explained something and
  // nothing was written (the model was cautious, or the app rejected the ops); (2) the tutor posed a problem and no task line came back.
  // While Otto is still speaking (early) only the problem the tutor just posed is chased: it is the line the student needs in front of them first.
  const needExplain = !input.toolMode && !input.early && !out.board.length && tutorExplained(input.exchange);
  const needProblem = !!posedText && !problemOnBoard(posedText, [...out.board, ...input.board.slice(-12)]);
  // The tutor says it is putting something on the board and nothing came out: write the problem or step it means, from the earlier conversation.
  const tutorLines = input.exchange.split("\n").filter((l) => /^Tutor:/i.test(l)).join(" ");
  const needPromised = !input.toolMode && !input.early && !out.board.length && !needProblem && promisesBoard(tutorLines);
  const stepSaid = confirmedStudentStep(input.exchange);
  const needStep = !input.toolMode && !input.early && !!stepSaid && !out.board.some((e) => ["gap", "result", "formula", "insight"].includes(String(e.kind)));
  const needPicture = !input.early && canDraw && wantsPicture(input.exchange) && !out.board.some((e) => ["graph", "svg", "diagram", "geometry", "flow", "table", "numberline"].includes(String(e.kind)));
  if (needExplain || needProblem || needPicture || needStep || needPromised) {
    const why = out.dropped.length ? ` The app rejected these ops: ${out.dropped.slice(0, 3).join("; ")}.` : "";
    const asks = [
      needExplain ? "(You wrote nothing, but the tutor explained something worth keeping." + why + " Write the definition or rule and the worked example the tutor gave as board lines now, never the question it asked.)" : "",
      needStep ? `The tutor just confirmed the student's step ("${stepSaid.slice(0, 160)}"). Write that step on the board now as a clean line of correct maths (fix the speech-recognition wording into proper notation; never write anything the student has not said, and never the step after it).` : "",
      needPromised ? "The tutor said it is putting something on the board (or that it is there) but nothing was written. Look at EARLIER IN THIS SESSION and the board: write the problem or step it means now (the most recent problem the tutor posed, as a task line, kind \"given\", without its answer), unless it is already on the board." : "",
      needPicture ? "The exchange is about graphing or a picture: DRAW it now (a graph op with the real function, or an svg / geometry / flow op), never leave it as words." : "",
      needProblem ? `The tutor posed a problem and you did not write it: write the problem itself now as a task line (kind "given") in LaTeX, without its answer, using EXACTLY the numbers the tutor said and no others:${why} ${posedText.slice(0, 400)}` : "",
    ].filter(Boolean).join(" ");
    const second = await once(`${asks} Return the same JSON shape.`, out.board);
    if (second.board.length) { const all = [...out.board, ...second.board]; out = { board: [...all.filter((e) => e.kind === "focus"), ...all.filter((e) => e.kind !== "focus")], dropped: out.dropped, concepts: out.concepts.length ? out.concepts : second.concepts }; }
    else console.warn(`[live] board writer still wrote nothing (${(second.dropped.length ? second.dropped : out.dropped).slice(0, 2).join("; ") || "no ops"})`);
  }
  // The step checks run beside the board call; the paper never waits for them longer than 8 s (a slow check is skipped, the board is not held up).
  return { ...out, remember: remembered, flags: await Promise.race([flagsP, new Promise<string[]>((res) => setTimeout(() => res([]), 8000))]) };
}
