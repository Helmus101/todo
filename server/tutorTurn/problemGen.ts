// EVERY EXERCISE COMES FROM HERE, THROUGH THE ANSWER WIDGET. The tutor decides WHEN to give one; this makes it: one focused
// model call that is told the subject, the topic, the student's level, how hard to go (up while they succeed, down when they
// struggle), what has already been used and what kind of task to set. The answer key is then verified by code (makeProblem
// evaluates the `check` expression and overrules a wrong key), the exercise must differ from every earlier one, and a bad
// result gets one corrective retry. Pure apart from the model call.
import { createTutorChat, retryRequest, usageOf, OUT, makeProblem } from "../claude.ts";
import { solveProblem } from "../solver.ts";
import { extractJsonObject } from "../../shared/tutorTurn.ts";
import { repeatedExercise, mostlyContains, type QuestionKind } from "./exercises.ts";
import { inScope } from "./scope.ts";
import { unsourcedQuotes } from "./verify.ts";
import { asksForSeveralValues } from "../tutor.ts";
import type { TutorTurnRecord } from "../../shared/types.ts";

export type Difficulty = "easier" | "at_level" | "harder";

export interface ProblemRequest {
  subject?: string;
  topic?: string;
  /** Year/grade, programme and courses from Settings. */
  level?: string;
  difficulty: Difficulty;
  kind: QuestionKind | "any";
  used: string[];
  lang: "fr" | "en";
  /** What the student asked for, in their own words ("something about sign charts"). */
  ask?: string;
  /** The skill that was shaky, for a retest or a targeted exercise. */
  skill?: string;
  /** The last student message and the tutor's last reply, so the lead-in can connect to what just happened. */
  recent?: { student?: string; tutor?: string };
  /** A belief this student has held on this topic (from earlier sittings): make a wrong option encode it, so a wrong pick is diagnostic. */
  probe?: string;
  /** The first two words of the tutor's last few replies — the intro must not start the same way. */
  openers?: string[];
  /** What the tutor has just said it wants to practise next, this turn (the exercise must deliver exactly that skill). */
  announced?: string;
  /** Epoch ms after which no further model call is worth starting (the turn's hard budget). */
  deadline?: number;
  /** The session's plan labels: the exercise must stay within them. */
  allowedTopics?: string[];
  /** Words the session has used (scope.ts): an exercise touching none of them is off topic. */
  scope?: Set<string>;
}

export interface GeneratedProblem {
  /** Fields for a `problem` board op / makeProblem. */
  input: Record<string, unknown>;
  /** One sentence the tutor can say to introduce it (never the problem text). */
  intro: string;
  topic: string;
}

/** How hard to go, from what the student has just done (code, not the model's mood). */
export function difficultyFrom(log: TutorTurnRecord[] | undefined): Difficulty {
  const l = (log || []).slice(-4);
  const right = l.filter((r) => r.verdict === "correct" && r.support <= 2).length;
  const wrong = l.slice(-2).filter((r) => r.verdict === "incorrect").length;
  if (wrong >= 2) return "easier";
  if (right >= 3 || (l.length >= 2 && l.slice(-2).every((r) => r.verdict === "correct" && r.support <= 1))) return "harder";
  return "at_level";
}

const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easier: "ONE step easier than their level: a single idea, familiar numbers, so they get a win.",
  at_level: "a typical exam-style question for their exact level: two or three connected steps, not a one-line recall.",
  harder: "clearly HARDER than a typical question at their level: several connected steps or an unfamiliar situation, something that makes a strong student think.",
};
const KIND_TEXT: Record<string, string> = {
  compute: "a calculation with ONE numeric answer (for symbolic topics such as derivatives, integrals or limits, ask for the VALUE at a point, e.g. f'(2) or the definite integral, so the answer is one number with a \"check\" expression — not a formula)",
  spot_error: "multiple choice: a short worked solution is shown in the statement with ONE real mistake (recompute every line yourself first: if all lines are right, change one); options name only WHERE the mistake is and its TYPE in general words (\"Line 3 — a slip when solving the equation\"), NEVER the corrected value or result, and no option may contain false reasoning. Add a \"mistake\" field: the wrong line and what it should be",
  explain_why: "multiple choice: which explanation is correct (the distractors are real misconceptions)",
  predict: "multiple choice: what happens if something changes (the distractors are the common wrong predictions)",
  compare: "multiple choice: which statement correctly compares two things",
  sketch: "a question about the shape/features of a graph or figure, answerable with a number or one option",
  recall: "a short factual question with a one-word or one-number answer, or multiple choice",
  any: "whichever kind fits the topic best",
};

const SYSTEM = `You write ONE exercise for a student, to be shown in an answer widget. Return ONLY a JSON object.

RULES
- Pitch it exactly as asked (level, difficulty, topic, subject). The statement is self-contained: every given is in it; it needs no figure or earlier context.
- STAY ON THE SESSION'S TOPIC: the exercise is about the given topic (and the allowed topics), in the given subject — never another subject or an unrelated topic.
- Use a situation and numbers that are NOT in the list of exercises already used — a genuinely different setting, not the same problem re-worded.
- Quantitative: free response with ONE numeric answer. "answer" is a bare number (no units); the unit goes in "format" ("answer in m s^-1, to 3 s.f."). "check" is a plain expression that computes the answer (use * / ^ sqrt() sin() cos() ln(); trig in DEGREES when the statement uses degrees). The app evaluates "check" and trusts it over "answer", so it must be right.
- Conceptual or humanities: multiple choice. "options" has 4 plausible options (distractors are real misconceptions, similar length, exactly one correct), "correct" is the index of the right one (0-3), no "check".
- Multiple choice: make the options similar in length; the correct one must NOT be the longest, and it must not be written in a different style from the others.
- "hint": a nudge towards the idea, never a value and never a restatement of any option. "why": the one-sentence reason the answer is right.
- "intro": ONE short spoken sentence introducing the exercise like a person who was just talking with this student: it picks up what they just did or said and says what kind of task this is — in a different sentence shape each time (a short reason, a challenge, a "what if", a plain "okay, one more"), e.g. "That worked for 3 — does it survive a negative?" or "Okay, same idea, trickier numbers." Never open with "You handled", "You've got", "Now", "Great" or any praise formula. It never starts with "Let's", never uses stock phrases ("a fresh case", "the next level"), and must NOT contain the problem text or the answer.
- "topic": a short title (≤6 words) for the worksheet.
- Backslashes in LaTeX are doubled (\\\\frac, \\\\sin). Language: as asked. Put each step of a worked solution on its own line with a real line break (a JSON \\n inside the string), maths in $…$.

JSON: {"topic":"…","question":"…","answer":"…","check":"…","format":"…","options":["…"],"correct":0,"hint":"…","why":"…","intro":"…"}  (use either answer+check OR options+correct)`;

function userPrompt(r: ProblemRequest): string {
  return [
    `Subject: ${r.subject || "(unspecified)"}`,
    `Topic: ${r.topic || r.ask || "(the topic they have been working on)"}`,
    r.announced ? `The tutor has just announced what this exercise is for: "${r.announced.replace(/\s+/g, " ").slice(0, 300)}". Practise exactly that SKILL (if it names one), but the FORMAT of the task is set by \"Kind of task\" below — do not copy a format the tutor mentioned (for example a worked solution with a slip) unless that is the kind asked for.` : "",
    r.allowedTopics?.length ? `Allowed topics this session (stay inside them): ${r.allowedTopics.join("; ")}` : "",
    r.ask && r.topic ? `They asked for: "${r.ask.slice(0, 200)}"` : "",
    `Their level (from their Settings): ${r.level || "not given — pitch it at the level of the work so far"}`,
    `Difficulty: ${DIFFICULTY_TEXT[r.difficulty]}`,
    r.probe ? `This student has previously believed: "${r.probe.slice(0, 160)}". Where the format allows, build one wrong option (or the setting of an error-spotting item) around exactly that belief, so a wrong pick shows it.` : "",
    `Kind of task: ${KIND_TEXT[r.kind] || KIND_TEXT.any}`,
    r.skill ? `Target the skill they found hard: ${r.skill}` : "",
    r.used.length ? `Exercises ALREADY USED (never repeat or re-skin these): ${r.used.map((u) => `"${u}"`).join(" · ")}` : "",
    r.recent?.student ? `What just happened (the "intro" must connect to it, in your own words): the student said "${r.recent.student.replace(/\s+/g, " ").slice(0, 200)}"${r.recent.tutor ? ` and the tutor replied "${r.recent.tutor.replace(/\s+/g, " ").slice(0, 220)}"` : ""}.` : "",
    `Write it in ${"English"}.`,
  ].filter(Boolean).join("\n");
}

async function once(messages: any[], tokens: { in: number; out: number; cachedIn: number }, deadline?: number): Promise<any | null> {
  const ask = async (json: boolean) => retryRequest(() => createTutorChat({ max_tokens: OUT.chat, temperature: 0.8, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, true, { deadline }), 2, 400);
  let res: any;
  try { res = await ask(true); } catch (e: any) { if (Number(e?.status) === 400) res = await ask(false); else throw e; }
  const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
  const j = extractJsonObject(String(res?.choices?.[0]?.message?.content || ""));
  return j && typeof j === "object" ? j : null;
}

/** One exercise at the right level, or null (the caller then falls back to whatever the tutor wrote itself). */
export async function generateProblem(req: ProblemRequest, tokens: { in: number; out: number; cachedIn: number }): Promise<GeneratedProblem | null> {
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt(req) }];
  let problem: any = null, last: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (req.deadline && Date.now() > req.deadline - 4000) return null; // out of time: the caller falls back to what the tutor wrote
    let j: any;
    try { j = await once(messages, tokens, req.deadline); } catch (e: any) { console.warn(`[problemGen] model call failed: ${e?.message || e}`); return null; }
    last = j;
    let complaint = "";
    if (!j || !String(j.question || "").trim()) complaint = "that wasn't a usable exercise: return the JSON object with a question";
    else {
      const built = makeProblem(j, true);
      if ("error" in built) complaint = String(built.error).replace(/^(?:ERROR|REJECTED):\s*/i, "");
      else if (asksForSeveralValues(String(j.question || "")) && !(Array.isArray(j.options) && j.options.length >= 2)) complaint = "the answer box takes ONE answer, but this asks for several values — ask for exactly one (\"the larger root\", \"the sum of the roots\", \"the value of x\") or make it multiple choice"
      else if (unsourcedQuotes(String(j.question || ""), [req.recent?.student || "", req.recent?.tutor || "", req.ask || ""]).length) complaint = "the statement quotes a text (a letter, a speech, a source) that you made up — never invent a quotation or present it as a real document. Describe the source in your own words without quoting it, or ask about the student's own text"
      else if (req.scope && !inScope(`${j.topic || ""} ${j.question}`, req.scope, 1)) complaint = `that is off topic for this session (${req.topic || req.subject || "the session's topic"}) — write it on the session's topic`;
      else if (/\b(?:error|mistake|wrong|erreur|faute)\b/i.test(String(j.question)) && String(j.mistake || "").trim().length < 8) complaint = "an error-spotting exercise needs a \"mistake\" field: the one wrong line and what it should be (recompute every line first — if all are correct, introduce one error)"
      else if (rambles(j)) complaint = "the explanation or hint thinks aloud (\"wait\", \"actually\", \"let's re-verify\") — work it out first, then write only the clean final reasoning"
      else if (isErrorSpotting(j) && optionRevealsFix(j)) complaint = "the right option states the corrected value, which gives the fix away — options may name the line and the TYPE of mistake in general words, but must not contain any number that is not already in the statement"
      else if (correctIsLongest(j)) complaint = "the correct option is much longer than the others, which gives it away — make the options similar in length";
      else if (repeatedExercise(String(j.question), req.used)) complaint = "that is too close to an exercise already used — set a different situation with different numbers";
      else if (!String(j.intro || "").trim()) complaint = "add the one-sentence spoken intro";
      else if (req.openers?.includes(String(j.intro).toLowerCase().replace(/[^a-zà-ÿ' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" "))) complaint = "the intro starts with the same words as a recent reply — open the sentence differently (not with praise, not with the same two words)";
      else if ((await keyDisagrees(j, built.problem, req, tokens)) && (complaint = `an independent solution of your statement gives a different answer than your key (${String(j.answer ?? "")}) — recompute it carefully from the givens, or change the problem so there is no doubt`)) { /* complaint set above */ }
      else if (isErrorSpotting(j) && !(await mistakeConfirmed(j, tokens))) complaint = "your worked solution has NO real mistake at the line you named (or has a different one). Recompute every line; either put one genuine error in a line, or set a different kind of exercise"
      else { problem = j; break; }
    }
    messages.push({ role: "assistant", content: JSON.stringify(last || {}).slice(0, 3000) }, { role: "user", content: `(Fix this and send the whole JSON object again: ${complaint})` });
  }
  if (!problem) return null;
  const { intro, topic, mistake, ...input } = problem;
  scrub(input);
  input.question = tidyQuestion(String(input.question));
  return { input, intro: String(intro || "").replace(/\s+/g, " ").trim().slice(0, 240), topic: String(topic || req.topic || "").replace(/\s+/g, " ").trim().slice(0, 60) };
}

/** A numeric exercise's key checked by a SEPARATE solve of its statement (reported live: a right 15/√56 was marked wrong five
 *  times because the generator's own key was wrong). True only when the independent solver is verified and disagrees;
 *  an unverifiable or non-numeric item passes (nothing to compare). */
export async function keyDisagrees(j: any, built: any, req: ProblemRequest, tokens: { in: number; out: number; cachedIn: number }): Promise<boolean> {
  if (process.env.TUTOR_KEYCHECK === "off") return false; // (the call-counting sims switch it off)
  // Multiple choice: only when every option is a computed value ("… = 288.4"), never a place or a reason ("line 3").
  const opts: string[] = Array.isArray(j?.options) ? j.options.map((o: unknown) => String(o || "")) : [];
  const numericOptions = opts.length >= 3 && opts.every((o) => /\d[.,]\d|\d{2,}/.test(o)) && !/\b(?:which line|what line|where|error|mistake|wrong|erreur|faute|quelle ligne)\b/i.test(String(j?.question || ""));
  if (opts.length && !numericOptions) return false;
  const optValue = (o: string) => Number((o.split("=").pop() || "").replace(",", ".").match(/-?\d+(?:\.\d+)?/g)?.pop());
  const mine = numericOptions ? optValue(opts[Number(j?.correct)] || "") : Number.isFinite(Number(built?.value)) ? Number(built.value) : Number(String(built?.answer ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(mine)) return false;
  try {
    const r = await solveProblem(String(j.question), req.subject);
    tokens.in += r.tokens.in; tokens.out += r.tokens.out; tokens.cachedIn += r.tokens.cachedIn;
    const sol = r.solution;
    if (!sol?.verified || !Number.isFinite(sol.value)) return false;
    const theirs = Number(sol.value), pct = /%/.test(String(built?.answer ?? "") + String(sol.finalAnswer));
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.015, 0.0006);
    return !(close(mine, theirs) || (pct && (close(mine, theirs * 100) || close(mine * 100, theirs))));
  } catch { return false; }
}

/** An error-spotting item whose right option states the corrected value ("solving 4Q=16 gives Q=4"): the numbers in it that the statement never used ARE the fix. */
export function optionRevealsFix(j: any): boolean {
  const opts: string[] = Array.isArray(j?.options) ? j.options.map((o: unknown) => String(o || "")) : [];
  const c = Number(j?.correct);
  if (opts.length < 2 || !Number.isInteger(c) || !opts[c]) return false;
  const nums = (t: string) => (String(t).replace(/\b(?:line|ligne)\s*\d+/gi, " ").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
  const stem = new Set(nums(String(j?.question || "")));
  return nums(opts[c]).some((n) => !stem.has(n));
}

/** In a multiple-choice exercise the right option is much longer than every other (a giveaway). */
export function correctIsLongest(j: any): boolean {
  const opts: string[] = Array.isArray(j?.options) ? j.options.map((o: unknown) => String(o || "")) : [];
  const c = Number(j?.correct);
  if (opts.length < 3 || !Number.isInteger(c) || !opts[c]) return false;
  const others = opts.filter((_, i) => i !== c).map((o) => o.length);
  return opts[c].length > 1.4 * Math.max(...others);
}

/** A hint that states or restates the answer: the correct option's content, or the numeric answer itself. */
export function hintLeaks(j: any): boolean {
  const hint = String(j?.hint || "");
  if (!hint) return false;
  const opts: string[] = Array.isArray(j?.options) ? j.options.map((o: unknown) => String(o || "")) : [];
  const c = Number(j?.correct);
  if (opts.length >= 2 && Number.isInteger(c) && opts[c]) {
    if (mostlyContains(hint, opts[c], 0.5)) return true;
    const nums = opts[c].match(/\d+(?:[.,]\d+)?/g) || [];
    return nums.length >= 2 && nums.every((n) => hint.includes(n));
  }
  const ans = String(j?.answer || "").trim();
  return ans.length > 0 && /\d/.test(ans) && new RegExp(`(?<![\\d.])${ans.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(hint);
}

/** Final touches on a validated exercise: a leaking hint is removed (better none than the answer), and multiple-choice
 *  options are shuffled so the right one isn't always first. */
function scrub(input: Record<string, any>): void {
  if (hintLeaks(input)) delete input.hint;
  const opts: string[] = Array.isArray(input.options) ? input.options.map((o: unknown) => String(o)) : [];
  const c = Number(input.correct);
  if (opts.length >= 2 && Number.isInteger(c) && opts[c]) {
    const right = opts[c];
    const shuffled = [...opts];
    for (let i = shuffled.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[k]] = [shuffled[k], shuffled[i]]; }
    input.options = shuffled;
    input.correct = shuffled.indexOf(right);
  }
}

const TEX_N = "(?:eq?|u|abla|ot|otin|ewline|i|less|gtr|mid|parallel|leq|geq|rightarrow|leftarrow|Rightarrow|Leftarrow|sim|cong|subset|vdash|vDash|exists)";

/** A statement the model wrote with literal "\\n" (or a lost "\\n\\n" that became "nn") gets real line breaks; LaTeX like \\neq is left alone. */
export function tidyQuestion(q: string): string {
  return q
    .replace(new RegExp(`\\\\n(?!${TEX_N}(?![a-zA-Z]))`, "g"), "\n")
    .replace(/([.?!:)])n{1,2}(?=[A-Z][a-z])/g, "$1\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const isErrorSpotting = (j: any) => /\b(?:error|mistake|wrong|erreur|faute)\b/i.test(String(j?.question || "")) && String(j?.mistake || "").trim().length >= 8;

/** Thinking aloud inside text the student will read ("wait, let's re-verify"). */
export function rambles(j: any): boolean {
  return [j?.why, j?.hint, ...(Array.isArray(j?.options) ? j.options : [])].some((t) => /\b(?:wait|actually,|let'?s (?:re-?verify|recalculate|look closer|re-?check)|hmm|on second thought|attendez|en fait,)\b/i.test(String(t || "")));
}

/** An independent check that an error-spotting statement really contains the mistake it claims: a fresh call recomputes each
 *  line without seeing the claimed mistake. Anything unclear counts as not confirmed. */
async function mistakeConfirmed(j: any, tokens: { in: number; out: number; cachedIn: number }): Promise<boolean> {
  try {
    const res: any = await retryRequest(() => createTutorChat({ max_tokens: 900, temperature: 0, messages: [
      { role: "system", content: 'You check a worked solution. Recompute EVERY line yourself from the given data. Return ONLY JSON: {"lines":[{"n":1,"ok":true}],"first_wrong":null or the line number}. Be strict and numerical; do not assume there is an error.' },
      { role: "user", content: String(j.question).slice(0, 2500) },
    ], response_format: { type: "json_object" } }, true), 2, 400);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const v: any = extractJsonObject(String(res?.choices?.[0]?.message?.content || ""));
    return !!v && v.first_wrong != null && Number.isFinite(Number(v.first_wrong));
  } catch { return false; }
}
