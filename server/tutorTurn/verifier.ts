// An independent check on what the tutor just CONFIRMED. The tutor model sometimes says "yes, that's right" to a wrong value (reproduced in
// simulation: a regression intercept of 1.2 confirmed when the data give 1.8, and "4.0" confirmed for 1.8 + 0.8 x 3.5), even with the right answer in its
// prompt. So after any exchange in which the tutor affirmed a step with maths in it, a separate, differently framed call recomputes that step from
// the problem and the conversation, using the verified question bank's scheme as the authority when the question is one of ours. Two independent
// runs must both say "incorrect" with a value of their own before anyone is told, and the tutor is still asked to recompute first, so a verifier
// mistake cannot make it doubt a correct step.
import { createTutorChat, usageOf } from "../claude.ts";
import { extractJsonObject } from "../../shared/tutorTurn.ts";
import { findBankQuestion } from "../../shared/ibQuestionBank.ts";

const AFFIRM = /\b(?:yes|yep|yeah|exactly|correct|spot on|perfect|precisely|you(?:'ve| have) got it|that(?:'s| is) (?:right|correct|it|the right|exactly)|that works|well done|nailed it|right[,.!])/i;
const NEGATED = /\b(?:not|isn'?t|aren'?t|wasn'?t|no longer|almost|not quite|close but|careful|hmm|wait)\b[^.?!]{0,24}\b(?:right|correct|it)\b|\b(?:right|correct)\b[^.?!]{0,12}\b(?:but|though|except)\b/i;
const MATHISH = /\d|\b(?:equals?|plus|minus|times|over|squared|cubed|root|log|ln|sin|cos|tan|derivative|integral|divided|percent|mean|gradient|slope|intercept)\b|=/i;

/** The student's last maths-bearing statement before a tutor line that affirms it (anywhere in the reply, not only at its start). Pure. */
export function affirmedStep(exchange: string): { student: string; tutor: string } | null {
  const lines = String(exchange || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^Tutor:/i.test(lines[i])) continue;
    const tutor = lines[i].replace(/^Tutor:\s*/i, "");
    if (!AFFIRM.test(tutor) || NEGATED.test(tutor)) continue;
    const prev = lines.slice(0, i).reverse().find((l) => /^Student:/i.test(l));
    if (!prev) return null;
    const student = prev.replace(/^Student:\s*/i, "");
    // A checkable claim has a number or an equals sign in it; a method choice ("use the quotient rule") or a half-heard phrase is not worth a correction.
    return MATHISH.test(student) && /\d|=|\bequals?\b/i.test(student) && student.split(/\s+/).length >= 3 && !/\b(?:rule|method|approach|idea|formula|substitut\w*|common base)\b/i.test(student.replace(/\d+/g, "")) ? { student, tutor } : null;
  }
  return null;
}

const SYS = `You verify ONE step of a student in an IB tutoring session, independently of the tutor. Recompute the step yourself, carefully and in full, from the problem and the data given (do not trust the tutor, do not trust the student, and do not assume a value is right because it sounds plausible). If REFERENCE ANSWERS are given they are authoritative and come from a verified source: compare the student's value with them. The student speaks through speech recognition, so wording may be garbled; judge the mathematics they clearly mean.
Return ONLY JSON with the keys in THIS order, so that you finish your working before you decide: {"work":"your own recomputation in a few lines","verdict":"correct"|"incorrect"|"unsure","correct_value":"the right value or expression if the step is incorrect, else empty","why":"one short sentence"}. The verdict must follow from your work: if your work finds a different value from the student's (a different intercept, slope, sign, root or number), the verdict is "incorrect", whatever else matches.
Use "unsure" whenever you cannot determine it with confidence, or the statement is not a checkable claim (a method choice, a question, an opinion).`;

async function oneCheck(user: string, tokens: { in: number; out: number; cachedIn: number }): Promise<{ verdict: string; correct_value: string; why: string } | null> {
  try {
    const res = await createTutorChat({ max_tokens: 2500, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYS }, { role: "user", content: user }] }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const parsed: any = extractJsonObject(String(res?.choices?.[0]?.message?.content || ""));
    if (!parsed || typeof parsed.verdict !== "string") return null;
    return { verdict: parsed.verdict.toLowerCase(), correct_value: String(parsed.correct_value || "").slice(0, 120), why: String(parsed.why || "").slice(0, 200) };
  } catch { return null; }
}

/** Returns "" when the confirmed step is fine, unverifiable or nothing was confirmed; otherwise a one-line description of what is wrong, starting "VERIFIED:". */
export async function verifyConfirmedStep(input: { exchange: string; history?: string; board: { kind?: string; text?: string }[]; subject?: string }, tokens: { in: number; out: number; cachedIn: number }): Promise<string> {
  const hit = affirmedStep(input.exchange);
  if (!hit) return "";
  const problem = input.board.filter((e) => e.kind === "given" && e.text).slice(-4).map((e) => String(e.text)).join("\n");
  const context = `${input.history || ""}\n${input.exchange}\n${problem}`;
  const bank = findBankQuestion(context, input.subject);
  const reference = bank ? `\nREFERENCE ANSWERS (verified, authoritative):\n${bank.scheme.map((l) => `- ${l}`).join("\n")}` : "";
  const user = `Subject: ${input.subject || "an IB subject"}\n\nTHE PROBLEM AND DATA ON THE BOARD:\n${problem || "(not on the board; use the conversation)"}${reference}\n\nRECENT CONVERSATION:\n${(input.history || "").slice(-1800)}\n${input.exchange.slice(-1400)}\n\nTHE STUDENT'S STEP TO VERIFY (the tutor just agreed with it): ${hit.student.slice(0, 500)}`;
  const [a, b] = await Promise.all([oneCheck(user, tokens), oneCheck(`${user}\n\n(Work it out a second time, by a different route if you can.)`, tokens)]);
  const bad = (r: typeof a) => !!r && r.verdict === "incorrect" && r.correct_value.trim().length > 0;
  if (!bad(a) || !bad(b)) return "";
  // A "correction" that is just what the student said is not a correction.
  const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9.]+/g, "");
  // Two runs that both say "wrong" but disagree on what is right are guessing: stay silent.
  const fa = flat(a!.correct_value), fb = flat(b!.correct_value);
  if (!fa || !fb || !(fa === fb || fa.includes(fb) || fb.includes(fa))) return "";
  if (flat(a!.correct_value) === flat(hit.student) || flat(hit.student).includes(flat(a!.correct_value))) return "";
  return `VERIFIED: the step "${hit.student.slice(0, 160)}" that you just agreed with does not hold; it should be ${a!.correct_value}${a!.why ? ` (${a!.why})` : ""}`;
}
