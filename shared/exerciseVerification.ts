// THE ANSWER KEY IS VERIFIED, AND A BROKEN KEY NEVER BECOMES A STUDENT ERROR.
//
// Spec §18–§19: an exercise is generated ONCE as a structured object, its answer is computed independently of
// any natural-language generation, and grading compares the student's response against THAT result. When the
// stored key, the independent computation and the exercise's own checker disagree, the item is a SYSTEM
// ERROR — not a wrong answer. Reported live: Qd = 500 − 20P, Qs = 100 + 30P gives 400 = 50P so P = 8, and a
// student who typed 8 was marked wrong, repeatedly, by a key nobody had checked.
//
// Deterministic and shared: the server (routes that grade) and the client (widgets that grade in place) run
// the SAME comparison, so a verdict can never depend on which side evaluated it.
import { compileExpr } from "./mathExpr.ts";
import { equivalent, logAnswerEquivalent, toExprSource } from "./mathEquiv.ts";
import { practiceAnswerMatches } from "./types.ts";

/** What is known about an item's answer key. `conflict` is the release-critical one: it means the stored key
 *  and the independently computed value disagree, so the key — not the student — is what's wrong. */
export type VerificationStatus = "verified" | "conflict" | "uncertain" | "not_checked";

/** The outcome of grading one response. `system_error` means "not graded due to a system error" — the item's
 *  own fault, never the student's (spec §19.1). */
export type GradeStatus = "correct" | "partially_correct" | "incorrect" | "system_error";

/** A worded answer's rubric (spec §18.2): each `required` entry is one idea, as alternative phrasings. */
export interface ConceptRubric { required: string[][]; misconceptions?: string[] }

const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ");
const words = (s: string) => norm(s).split(/\s+/).filter((w) => w.length >= 3);
// Word match by a shared 5-letter stem, so "resources"/"resource", "limited"/"limit", "wants"/"want" all count.
const stemHit = (ans: string[], w: string) => ans.some((a) => a === w || (a.length >= 5 && w.length >= 5 && a.slice(0, 5) === w.slice(0, 5)) || (w.length < 5 && a === w));
/** Does `answer` express `phrase`? Every content word of the phrase must appear (by stem) in the answer. */
export function expressesPhrase(answer: string, phrase: string): boolean {
  const need = words(phrase);
  if (!need.length) return false;
  const ans = words(answer);
  return need.every((w) => stemHit(ans, w));
}

/** Grade a worded answer by MEANING against its rubric — never by a single shared keyword (spec §2.1 Failure F:
 *  "opportunity cost" was accepted as the definition of scarcity). All required ideas → correct; some → partially
 *  correct (says which part is missing); none → incorrect, and a known related-but-wrong idea is named as such. */
export function gradeConceptAnswer(rubric: ConceptRubric, given: string): { status: "correct" | "partially_correct" | "incorrect"; met: number; total: number; misconception?: string; feedback: string } {
  const total = rubric.required.length;
  const met = rubric.required.filter((group) => group.some((p) => expressesPhrase(given, p))).length;
  const misconception = (rubric.misconceptions || []).find((m) => expressesPhrase(given, m));
  if (total > 0 && met === total) return { status: "correct", met, total, feedback: "Correct." };
  if (met > 0) return { status: "partially_correct", met, total, ...(misconception ? { misconception } : {}), feedback: `Partly right — you have ${met} of the ${total} key ideas; one is still missing.` };
  return { status: "incorrect", met, total, ...(misconception ? { misconception } : {}), feedback: misconception ? `"${misconception}" is a related idea, but it isn't what's being asked here.` : "Not quite — try again." };
}

/** One exercise, in the shape both the server and the widgets already hold it. */
export interface ExerciseKey {
  /** The prompt — needed because a problem stated in DEGREES means sin/cos/tan in the check are degrees. */
  question?: string;
  /** The stored key, as the generator wrote it (may carry units, "≈", or be a word/expression). */
  answer?: string;
  /** An expression that COMPUTES the numeric answer from the givens. */
  check?: string;
  /** An already-computed exact value (what makeProblem stores after verifying the key). */
  value?: number;
  /** MCQ mode. */
  options?: string[];
  correct?: number;
  /** A worded answer's rubric — when present, the answer is graded by meaning (gradeConceptAnswer). */
  rubric?: ConceptRubric;
}

export interface KeyCheck {
  status: VerificationStatus;
  /** The independently computed value, when the key could be computed at all. */
  computed?: number;
  /** What the stored key parses to numerically. */
  stated?: number;
  /** One line for diagnostics/logs — never shown as-is to the student. */
  note: string;
}

/** Rewrite degree-trig calls into radians so the shared (explicitly radians) compiler can evaluate them:
 *  `sind(x)`/`cosd(x)`/`tand(x)` always, and plain `sin(x)`/`cos(x)`/`tan(x)` when the problem is stated in
 *  degrees (a plain `sin(12)` read as radians turned a right key of 25,538 W into −40,126 — reported live).
 *  Handles nesting by matching balanced parentheses. */
export function toEvaluableCheck(check: string, problemText = ""): string {
  const degrees = /°|\^\s*\{?\\circ|\bdeg(?:ree)?s?\b|\bdegrés?\b/i.test(problemText) && !/\bpi\b|π|\brad(?:ians?)?\b/i.test(`${problemText} ${check}`);
  const s = String(check || "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/π/g, "pi");
  const needConversion = (fn: string) => fn.endsWith("d") || degrees;
  let out = "";
  for (let i = 0; i < s.length; ) {
    const m = /^(sin|cos|tan|sind|cosd|tand)/i.exec(s.slice(i));
    const after = m ? String(s.slice(i + m[0].length)).match(/^\s*\(/) : null;
    if (!m || !after || !needConversion(m[0].toLowerCase())) { out += s[i++]; continue; }
    const open = i + m[0].length + after[0].length - 1;
    let depth = 0, j = open;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    if (j >= s.length) { out += s[i++]; continue; }
    const inner = toEvaluableCheck(s.slice(open + 1, j), problemText);
    const fn = m[0].toLowerCase().replace(/d$/, "");
    out += `${fn}((${inner})*pi/180)`;
    i = j + 1;
  }
  return out;
}

/** The numeric value of a model-written `check` expression, computed by code (never by a language model).
 *  null when it can't be evaluated — the caller must treat that as "not verified", never as "wrong". */
export function computeCheck(check: string, problemText = ""): number | null {
  const src = String(check || "").trim();
  if (!src) return null;
  const compiled = compileExpr(toEvaluableCheck(src, problemText), []);
  if ("error" in compiled) return null;
  const v = compiled.fn({});
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
}

/** A stored key that IS a number — `8`, `≈ 112 m`, `111,99`, `25,538 W`, `30°` — parses to its value. An
 *  EXPRESSION (`h/tan 25°`, `7/2`) or a word (`friction`) returns NaN: those are compared symbolically by
 *  `keysAgree` below, never number-to-number. Reading "h/tan 25°" as the number 25 (its angle) is exactly the
 *  false disagreement that would call a fine key broken. */
export function statedKeyNumber(answer: string | undefined): number {
  const t = String(answer || "").trim();
  // Leading "≈" / "=" and trailing units/°/% are formatting, not meaning; anything else (an operator, a
  // digit inside the unit, a second quantity) means this key is not a plain number.
  if (!/^[≈~=]*\s*[-−–]?\d+(?:[ \u00a0,]\d{3})*(?:[.,]\d+)?(?:e[+-]?\d+)?\s*[A-Za-zµΩ°%\s]*$/.test(t)) return NaN;
  const n = Number(t.replace(/^[≈~=]*\s*/, "").replace(/[−–]/g, "-").replace(/(\d)[ \u00a0,](?=\d{3}(?!\d))/g, "$1").replace(/,/g, ".").replace(/[^0-9.eE+-].*$/, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** Do a stored key and an independently computed value describe the same answer? 1 % relative, the same bar
 *  makeProblem uses when deciding whether to trust the model's written key.
 *
 *  A conflict is only ever reported between two NUMBERS. A key that is an expression ("h/tan 25°") or a word
 *  ("friction") is not compared here at all: reading the number inside it (the 25) as if it were the answer
 *  would flag a perfectly good key as broken, and a skill key we can't read must never be reported as a
 *  disagreement (spec §19.4). Expression keys are still graded — by comparing the student's expression to
 *  theirs, in mathEquiv.ts. */
export function keysAgree(stored: string | undefined, computed: number): boolean {
  if (stored == null || !String(stored).trim()) return true;
  const stated = statedKeyNumber(stored);
  if (!Number.isFinite(stated)) return true;
  return Math.abs(stated - computed) <= Math.max(0.01, Math.abs(computed) * 0.01);
}

/** Verify an item's key before (or after) presenting it. Never throws, never guesses. */
export function verifyExerciseKey(ex: ExerciseKey): KeyCheck {
  if (Array.isArray(ex.options) && ex.options.length >= 2 && Number.isInteger(ex.correct) && (ex.correct as number) >= 0 && (ex.correct as number) < ex.options.length) {
    return { status: "verified", note: "MCQ: the key is the option index the generator marked correct." };
  }
  const computed = ex.value != null && Number.isFinite(ex.value) ? ex.value : computeCheck(String(ex.check || ""), String(ex.question || ""));
  const stated = statedKeyNumber(ex.answer);
  if (computed != null && Number.isFinite(stated)) {
    // `stated` being finite here already means the stored key IS a plain number (statedKeyNumber refuses
    // expressions), so this really is two numbers being compared — never the 25 inside "h/tan 25°".
    return keysAgree(ex.answer, computed)
      ? { status: "verified", computed, stated, note: "the stored key matches the independently computed value." }
      : { status: "conflict", computed, stated, note: `the stored key (${stated}) disagrees with the independently computed value (${computed}).` };
  }
  if (computed != null) return { status: "verified", computed, note: "the key was computed independently of the stored answer text." };
  if (Number.isFinite(stated)) return { status: "uncertain", stated, note: "no independent computation is available for this item — the stored key is unverified." };
  return { status: "not_checked", note: "this item has no numeric key and no computable check." };
}

export interface Grade {
  status: GradeStatus;
  verification: VerificationStatus;
  /** What was graded against, in the form the student could compare with ("8", "2553.78"). */
  expected?: string;
  /** True only when the item's own key and the independent computation disagree — a system fault. */
  keyConflict: boolean;
  /** A short, specific line safe to show: it states the outcome, never the answer. */
  feedback: string;
}

/** Grade one response. The order of checks is the spec's: the independently computed value wins; a key we
 *  cannot verify is never used to call a student wrong; a key that disagrees with the computation is a
 *  SYSTEM ERROR, not an incorrect answer. */
export function gradeExerciseAnswer(ex: ExerciseKey, given: string, opts: { percent?: boolean } = {}): Grade {
  const check = verifyExerciseKey(ex);
  const hasMCQ = Array.isArray(ex.options) && ex.options.length >= 2 && Number.isInteger(ex.correct);
  if (hasMCQ) {
    const picked = Number(String(given).trim());
    const correct = Number.isInteger(picked) && picked === ex.correct;
    return {
      status: correct ? "correct" : "incorrect",
      verification: "verified",
      expected: ex.options?.[ex.correct as number],
      keyConflict: false,
      feedback: correct ? "Correct." : "Not quite — try another option.",
    };
  }
  // A worded answer with a rubric is graded by meaning, not string match (spec §18.2).
  if (ex.rubric?.required?.length) {
    const g = gradeConceptAnswer(ex.rubric, given);
    return { status: g.status, verification: "verified", expected: ex.answer, keyConflict: false, feedback: g.feedback };
  }
  const computed = check.computed;
  const expected = computed != null ? String(computed) : ex.answer;
  const broken = check.status === "conflict";
  const matchesComputed = computed != null && practiceAnswerMatches(given, String(computed), computed, opts.percent);
  const matchesStored = !!ex.answer && practiceAnswerMatches(given, ex.answer, computed, opts.percent);
  // A right answer to an item whose key is broken is still right — but the ITEM is flagged, so the caller can
  // log it and repair it (spec §19.1: preserve the attempt, log the id/version and checker result, and stop
  // the same false rejection from repeating).
  if (matchesComputed) return { status: "correct", verification: check.status, expected, keyConflict: broken, feedback: "Correct." };
  // A key that disagrees with its own independent computation can't be used to grade anyone: the student's
  // answer matched neither the computed value nor the (broken) key, so this is the item's fault.
  if (check.status === "conflict") {
    return { status: "system_error", verification: "conflict", expected, keyConflict: true, feedback: `This item's answer key disagrees with the independently computed value (${computed}), so your answer wasn't graded as wrong. Otto will fix it.` };
  }
  if (matchesStored) return { status: "correct", verification: check.status, expected, keyConflict: broken, feedback: "Correct." };
  const division = ex.question ? verifyPolynomialDivision(ex.question, given) : null;
  if (division) return { status: division, verification: "verified", expected, keyConflict: false, feedback: division === "correct" ? "Correct." : "Not quite — try again." };
  return { status: "incorrect", verification: check.status, expected, keyConflict: broken, feedback: "Not quite — try again." };
}

/** Polynomial division checked by code: "Divide P(x) = 2x³ − 5x² + x − 3 by (x − 2)" with an answer giving the quotient
 *  and remainder ("quotient = 2x² − x − 1, remainder = −5") or the whole result ("2x² − x − 1 − 5/(x − 2)"). Right
 *  when P(x) = D(x)·Q(x) + R(x) at several points and R has lower degree than D (constant, for a linear divisor).
 *  null when the line isn't a division or the answer can't be read. */
export function verifyPolynomialDivision(line: string, given: string): "correct" | "incorrect" | null {
  const plain = (x: string) => toExprSource(String(x || "").replace(/\$/g, " ").replace(/[²³⁴]/g, (c) => "^" + ({ "²": 2, "³": 3, "⁴": 4 } as Record<string, number>)[c]));
  const m = /divid(?:e|ing)\s+(?:[A-Za-z]\s*\(\s*x\s*\)\s*=\s*)?(.+?)\s+by\s+(.+?)(?:\s*[=:]\s*\?.*)?\s*$/i.exec(String(line || "").replace(/\$/g, " ").replace(/\s+/g, " ").trim());
  if (!m) return null;
  const compile = (src: string) => { const c = compileExpr(plain(src).replace(/[.,;]+$/, ""), ["x"]); return "error" in c ? null : c.fn; };
  const P = compile(m[1]), D = compile(m[2]);
  if (!P || !D) return null;
  const g = String(given || "");
  const q = /(?:quotient|q(?:\s*\(\s*x\s*\))?)\s*[=:]\s*(.+?)(?=[,;]|\s+(?:and\s+)?(?:remainder|r\b)|$)/i.exec(g);
  const r = /(?:remainder|r(?:\s*\(\s*x\s*\))?)\s*[=:]\s*(.+?)\s*$/i.exec(g);
  const xs = [0.7, 1.3, 3.1, -2.4, 5.5];
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (q) {
    const Q = compile(q[1]), R = r ? compile(r[1]) : (() => 0);
    if (!Q || !R) return null;
    // A linear divisor leaves a constant remainder.
    const linear = xs.every((x, i) => i === 0 || close((D({ x }) - D({ x: xs[0] })) / (x - xs[0]), (D({ x: xs[1] }) - D({ x: xs[0] })) / (xs[1] - xs[0])));
    if (linear && !xs.every((x) => close(R({ x }), R({ x: xs[0] })))) return "incorrect";
    return xs.every((x) => close(P({ x }), D({ x }) * Q({ x }) + R({ x }))) ? "correct" : "incorrect";
  }
  const whole = compile(g.replace(/^[^=]*=/, ""));
  if (!whole) return null;
  return xs.every((x) => close(P({ x }) / D({ x }), whole({ x }))) ? "correct" : "incorrect";
}

/** The board-gap equivalent: the key recomputed by code (computedGapKey/solvedGapKey) against the key the
 *  model stored when it wrote the gap. `system_error` means "don't call the student wrong" (spec §19.4). */
export function gradeGapAnswer(storedKey: string | undefined, recomputed: number | null, target: string | undefined, given: string): { verdict: "correct" | "incorrect" | "unknown" | "system_error"; keyConflict: boolean; verification: VerificationStatus } {
  const key = recomputed != null ? String(recomputed) : String(storedKey || "");
  if (!key) return { verdict: "unknown", keyConflict: false, verification: "not_checked" };
  // A log-laws gap ("log_a(x^3) = ?") is compared term by term; anything else as a compiled expression.
  const logV = logAnswerEquivalent(given, key);
  const verdict = logV !== "unknown" ? logV : equivalent(given, key, target);
  const keyConflict = recomputed != null && !!storedKey && !keysAgree(storedKey, recomputed);
  // "verified" here means THE VERDICT IS TRUSTWORTHY: comparing two compiled expressions is itself a real
  // mathematical test, so a definite correct/incorrect against a checkable key is verified even when the key
  // wasn't independently recomputed (a symbolic gap key like "h/tan 25°" has no numeric value to recompute).
  // "uncertain" is reserved for a key nothing could be checked against at all.
  const trust: VerificationStatus = keyConflict ? "conflict" : verdict === "unknown" ? "uncertain" : "verified";
  if (verdict === "correct") return { verdict: "correct", keyConflict, verification: trust };
  // The stored key and the recomputed one disagree: the app can't tell the student they're wrong (the key,
  // not their working, is what's broken). Preserve the attempt and hand it to the tutor.
  if (verdict === "incorrect" && keyConflict) return { verdict: "system_error", keyConflict: true, verification: "conflict" };
  if (verdict === "unknown") return { verdict: "unknown", keyConflict, verification: trust };
  return { verdict: "incorrect", keyConflict, verification: trust };
}
