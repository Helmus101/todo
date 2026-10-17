
import { randomUUID } from "node:crypto";
import type { TaskNote, TaskFlashcards, TaskQuiz, TaskProblem, BoardEntry, DiagramOp, GraphSpec, TaskObjective } from "../../shared/types.ts";
import { isNumericAnswer as isNumericAnswerValue } from "../../shared/types.ts";
import { compileExpr } from "../../shared/mathExpr.ts";
import { buildGeometry } from "../../shared/geometry.ts";
import { evalCheckFor, similarity } from "../tutorAdapt.ts";
import { unrenderableMath } from "../latexCheck.ts";
import { cleanProblemSource } from "../questionSources.ts";
import { stripLeakedToolCallSyntax } from "./client.ts";

// ── Shared in-app artifact factories ──────────────────────────────────────────
// Pure, no I/O. Used by BOTH runTask's tool loop and the tutor chat's tool loop, so validation can't drift
// between "the artifact Otto made during a run" and "the artifact Otto made when you asked in chat".
// Each returns either the artifact or an `error` string that goes straight back to the model as the tool
// result (so it can retry properly rather than silently producing something empty).

/** A note whose body is empty/near-empty used to be ACCEPTED and still set `wroteAny`, which satisfied every
 *  artifact-enforcement check in the run loop with nothing to show the student — a real hole in the chain.
 *  40 chars is comfortably below any genuine fiche and comfortably above "TODO". */
const MIN_NOTE_BODY = 40;

// Brief compression trigger: a SMALL, single-session task whose note came back with more than this many
// words gets ONE rewrite pass (a small model call that keeps the real specifics and cuts the padding).
// This is a trigger for a smart rewrite, NOT a hard cap: a brief is long either because the model padded
// it (compress that) or because the task genuinely carries that much content (leave it alone — the pass
// only fires for small tasks at all, and the rewrite itself is told to return the original unchanged if
// cutting anything would lose a real specific). Failure is fail-open: if the rewrite call fails or
// returns nothing usable, the original brief ships unchanged.
export const BRIEF_COMPRESS_WORDS = 150;

// Defense-in-depth against a fabricated self-referential link (observed live: a note linked to a fake
// "otto.ai/note/<uuid>" URL — this app has no such domain and no public per-note page at all, everything is
// in-app SPA state). The prompt (CREATE_NOTE_TOOL's own description) already forbids inventing a URL, but a
// prompt instruction alone isn't a guarantee — strip any markdown link whose host contains "otto" down to
// plain text (keep the label, drop the fake href) rather than trust the model never slips.
function stripFakeSelfLinks(body: string): string {
  return body.replace(/\[([^\]]*)\]\((https?:\/\/[^)]*otto[^)]*)\)/gi, "$1");
}

export function makeNote(input: any): { note: TaskNote } | { error: string } {
  const title = String(input?.title || "Note").trim().slice(0, 120) || "Note";
  const body = stripFakeSelfLinks(String(input?.body || "").trim().slice(0, 8000));
  if (body.length < MIN_NOTE_BODY) return { error: "ERROR: the note body is empty or too short — write the ACTUAL content (the real formulas/definitions/steps), not a placeholder or a title with nothing under it." };
  return { note: { id: randomUUID(), title, body, createdAt: new Date().toISOString() } };
}

// Hard product cap, direct instruction: no deck exceeds 50 cards, except a MONTHLY summary deck (more
// material to cover across a whole month), capped at 100. Overrides the earlier "no real product cap" stance
// for every other deck-producing path (daily/weekly journal decks, task-run/chat CREATE_FLASHCARDS).
const DECK_CARD_CAP = 50;

export const MONTHLY_DECK_CARD_CAP = 100;

/** Daily decks have no real limit — this is only a runaway-output backstop (the prompt says "no card limit"). */
export const DAILY_DECK_CARD_CAP = 150;

export function makeDeck(input: any, maxCards: number = DECK_CARD_CAP): { deck: TaskFlashcards } | { error: string } {
  const title = String(input?.title || "Flashcards").trim().slice(0, 120) || "Flashcards";
  const cards = (Array.isArray(input?.cards) ? input.cards : [])
    // back's cap is well above front's: a practice-problem card's back is a full worked step-by-step
    // solution (see CARD_STYLE_RULE's rule 3 exception) — 300 chars silently chopped that off mid-solution.
    .map((c: any) => ({ front: String(c?.front || "").trim().slice(0, 300), back: String(c?.back || "").trim().slice(0, 900) }))
    .filter((c: { front: string; back: string }) => c.front && c.back)
    .slice(0, maxCards);
  if (!cards.length) return { error: "ERROR: no valid cards (each needs a non-empty front and back)." };
  return { deck: { id: randomUUID(), title, cards, createdAt: new Date().toISOString() } };
}

// Reported live: an economics MCQ marked "A shift of the demand curve to the LEFT" correct while its own
// `why` explanation said "...shifting the entire demand curve RIGHTWARD" — the model picked the wrong
// index among a classic antonym-pair distractor set (direction/sign/comparison words), confidently
// explaining the opposite of what it marked correct. There's no numeric `check` expression for a
// qualitative MCQ the way makeProblem has for a computed answer, but THIS class of error is still
// mechanically catchable: when `why` uses one word of a known antonym pair, and that SAME word appears in
// a DIFFERENT option's text while the marked-correct option's text uses the OPPOSITE word of the pair,
// the explanation is arguing for the wrong option. Deliberately narrow (an explicit pair list, whole-word
// matches only) to avoid false positives on ordinary prose that merely mentions one of these words once.
// Regex per side (not a plain word) so a variant like "rightward" is recognized as the same concept as
// "right" — the real reported case used "rightward" in `why` against options written with plain "right"/
// "left", which a literal word-for-word pairing would have missed entirely.
// Deliberately narrow to pairs that rarely need BOTH words in one legitimate explanation of a single
// answer — "increase"/"decrease", "rise"/"fall", "more"/"less" etc. are excluded even though they're
// classic antonyms: a correct economics/science explanation routinely uses both in the same sentence to
// contrast two different variables ("as supply increases, price decreases"), which would false-positive
// as a contradiction when it isn't one. The pairs kept here are purely spatial/binary, where a single
// coherent explanation needing both sides at once is rare.
const ANTONYM_PAIRS: [RegExp, RegExp][] = [
  [/\bright(?:ward)?\b/i, /\bleft(?:ward)?\b/i],
  [/\bclockwise\b/i, /\bcounter-?clockwise\b/i],
  [/\bup(?:ward)?\b/i, /\bdown(?:ward)?\b/i],
  [/\bpositive\b/i, /\bnegative\b/i],
  [/\binward\b/i, /\boutward\b/i],
  [/\bforward\b/i, /\bbackward\b/i],
];

/** True when `why`'s own directional language contradicts the option it's attached to — see ANTONYM_PAIRS
 *  above. Exported for tests. */
export function whyContradictsCorrect(why: string, options: string[], correctIdx: number): boolean {
  if (!why || !options[correctIdx]) return false;
  for (const [ra, rb] of ANTONYM_PAIRS) {
    for (const [re, opp] of [[ra, rb], [rb, ra]] as [RegExp, RegExp][]) {
      if (!re.test(why)) continue;
      // The correct option argues for the OPPOSITE word of the pair, while a DIFFERENT option argues for
      // the word `why` actually used — `why` is explaining a different option than the one marked correct.
      if (opp.test(options[correctIdx]) && options.some((o, i) => i !== correctIdx && re.test(o))) return true;
    }
  }
  return false;
}

export function makeQuiz(input: any): { quiz: TaskQuiz } | { error: string } {
  const title = String(input?.title || "Quiz").trim().slice(0, 120) || "Quiz";
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const questions = raw
    .map((item: any) => {
      // 300 chars fit "one clear sentence" (the tool schema's own description) but silently chopped a
      // passage-based reading-comprehension question mid-word — a full SAT-style passage-plus-question
      // legitimately runs 400-600+ chars. Raised well above that, same reasoning as `back`'s cap above.
      const q = String(item?.q || "").trim().slice(0, 1500);
      const correctIdx = Number(item?.correct);
      if (!q || !Array.isArray(item?.options) || !Number.isInteger(correctIdx)) return null;
      // Sanitise options while tracking WHICH one was flagged correct, by identity — not by index. Trimming
      // empties and de-duplicating shifts every later index, so carrying the raw `correct` through would
      // silently mark a DIFFERENT option as the right answer: a quiz that confidently teaches the wrong
      // thing, which is worse than no quiz. If the flagged option doesn't survive, drop the question.
      const seen = new Set<string>();
      const kept: { text: string; wasCorrect: boolean }[] = [];
      (item.options as any[]).forEach((o, i) => {
        const text = String(o ?? "").trim().slice(0, 200);
        if (!text || seen.has(text.toLowerCase())) return;
        seen.add(text.toLowerCase());
        kept.push({ text, wasCorrect: i === correctIdx });
      });
      const correct = kept.findIndex((o) => o.wasCorrect);
      // Was `> 4` — silently REJECTED (dropped the whole question, not just trimmed it) any 5-option
      // question, which is exactly what the AP-track exam-style guidance (examStyleLine/CREATE_QUIZ_TOOL's
      // own schema) now explicitly asks the model to write. The schema said 5 while this validator still
      // only ever accepted up to 4 — raised to match, so an AP question doesn't get silently thrown away
      // after the model correctly followed the instruction to write one.
      if (kept.length < 2 || kept.length > 5 || correct < 0) return null;
      const why = item?.why ? String(item.why).trim().slice(0, 300) : undefined;
      // Reported live: a question marked "shift to the LEFT" correct while its own `why` explained
      // "...shifting the demand curve RIGHTWARD" — confidently teaching the opposite of the marked
      // answer. Drop it rather than ship a self-contradictory question (same "worse than no quiz" call
      // as the index-collision case above).
      if (why && whyContradictsCorrect(why, kept.map((o) => o.text), correct)) return null;
      return { q, options: kept.map((o) => o.text), correct, ...(why ? { why } : {}) };
    })
    .filter(Boolean)
    // No real product cap — mirrors makeDeck's own reasoning above: a student who names a specific count
    // should get it, not an arbitrary product-level ceiling. This is a sanity backstop only, matching the
    // tool description's own 50-per-call technical ceiling.
    .slice(0, 50) as TaskQuiz["questions"];
  if (!questions.length) return { error: "ERROR: no valid questions (each needs a question, 2-5 distinct options, and a `correct` index pointing at one of them)." };
  return { quiz: { id: randomUUID(), title, questions, createdAt: new Date().toISOString() } };
}

/** A single standalone problem for inline chat display — validated the same defensive way as makeQuiz.
 *  Can be MCQ (options + correct index) or free-response (answer string). At least one of the two modes
 *  must be valid; a `why` explanation is strongly encouraged (it's what makes the problem teach). */
/** True when guidance text (a problem's `format` or `hint`) contains the problem's own answer. Reported live:
 *  a format line "the x-coordinate only, e.g. x = 3" where the answer WAS x = 3 — the example gave it away.
 *  Matches the answer's core value (a leading "x =" and trailing "." stripped) as a standalone token, so
 *  "3" doesn't match inside "13" or "3.5". Exported for unit tests. */
export function leaksAnswer(text: string, answer: string): boolean {
  const core = answer.trim().replace(/^[a-zθ]\s*=\s*/i, "").replace(/\.$/, "").trim();
  if (!core) return false;
  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp(`(^|[^0-9a-z.])${esc}($|[^0-9a-z.]|\\.(?!\\d))`, "i").test(text);
}

/** Remove an answer leak from guidance text: drop the leaking "e.g./for example/par ex." clause first (keeps
 *  the useful format instruction), and if the answer still shows, drop the text entirely. */
export function scrubAnswerLeak(text: string | undefined, answer: string | undefined): string | undefined {
  if (!text || !answer || !leaksAnswer(text, answer)) return text;
  const withoutExample = text.replace(/[,;(]?\s*(?:e\.g\.|eg\b|for example|for instance|par ex(?:emple|\.)?|ex\s*:)[^;)\n]*\)?/gi, "").trim();
  if (withoutExample && !leaksAnswer(withoutExample, answer)) return withoutExample;
  return undefined;
}

/** Every problem currently in play's "secret" value (free-response answer, or the correct MCQ option's
 *  text) — the set of strings that must never appear, stated outright, anywhere OTHER than the problem
 *  widget's own gated reveal (which only shows after the student genuinely gets it right there). Short
 *  (<3 char) secrets are dropped, same reasoning as revealsAnswer: a single-character answer like "x" or
 *  a bare "5" would false-positive on almost any text that happens to contain that character. */
function problemSecrets(problems: TaskProblem[]): string[] {
  return problems
    .map((p) => (Array.isArray(p.options) && typeof p.correct === "number" ? p.options[p.correct] : p.answer))
    .filter((s): s is string => !!s && s.trim().replace(/\s/g, "").length >= 3);
}

/** True when `text` states ANY current problem's answer outright. Reported live: the tutor Socratically
 *  withheld a problem's answer in chat while separately writing a WRITE_TO_BOARD "summary" entry that
 *  spelled out the full derivation INCLUDING the final value ("cos θ = −4/5. Then cos 2θ = ... = 7/25") —
 *  a multi-part question (CREATE_PROBLEM's single-answer-string grading only covers the FINAL part, see
 *  that tool's own description) while the student was still mid-way through an EARLIER part in chat. Every
 *  other surface (CREATE_PROBLEM's own format/hint via leaksAnswer/scrubAnswerLeak, the MCQ/free-response
 *  UI) was already guarded against this; board entries, diagram captions, and the chat reply itself were
 *  not — this is the shared check closing that gap, used by both the WRITE_TO_BOARD/DRAW_ON_BOARD tool
 *  handlers (reject and let the model rewrite) and chatAboutTask's own finish() (discard and substitute a
 *  safe reply), the same two-tier posture CHAT_DOES_WORK/CHAT_STATES_ANSWER already use for other leaks. */
export function leaksAnyProblemAnswer(text: string, problems: TaskProblem[]): boolean {
  const secrets = problemSecrets(problems);
  return secrets.some((s) => leaksAnswer(text, s));
}

export function makeProblem(input: any, requireCheck = false): { problem: TaskProblem } | { error: string } {
  // 600 chars fit "one clear sentence" but would chop a genuine IB extended-response/AP FRQ multi-part
  // prompt ((a)/(b)/(c), each with its own point value) mid-sentence — same reasoning, same raised cap, as
  // makeQuiz's own `q` field above.
  const question = String(input?.question || "").trim().slice(0, 1500);
  if (!question) return { error: "ERROR: a problem needs a non-empty question." };
  
  // Reject symbolic notation format (spec §10.E): exercises must be in clear prose, not "A ⟹ B = ?" format
  if (/⟹|⇒|→|= \?|=\s*\?$/.test(question)) {
    return { error: "REJECTED: write the question in clear prose, not symbolic notation (e.g., \"Technology improves ⟹ supply shifts = ?\"). State the situation in words (e.g., \"Technology improves production. What happens to the supply curve?\"). Then specify the expected answer format." };
  }
  
  const why = input?.why ? String(input.why).trim().slice(0, 300) : undefined;
  let hint = input?.hint ? String(input.hint).trim().slice(0, 300) : undefined;
  let format = input?.format ? String(input.format).trim().slice(0, 200) : undefined;
  // MCQ mode: options + correct index
  const rawOptions = Array.isArray(input?.options) ? input.options : [];
  const options = rawOptions.map((o: any) => String(o || "").trim().slice(0, 300)).filter(Boolean);
  const correctIdx = Number(input?.correct);
  const hasMCQ = options.length >= 2 && Number.isInteger(correctIdx) && correctIdx >= 0 && correctIdx < options.length;
  // Same check as makeQuiz's own — a `why` whose directional language argues for a DIFFERENT option than
  // the one marked correct (reported live, see whyContradictsCorrect's own comment) means the key is wrong.
  if (hasMCQ && why && whyContradictsCorrect(why, options, correctIdx)) return { error: "REJECTED: your `why` explanation argues for a DIFFERENT option than the one you marked `correct` (opposite direction/sign) — re-check which option is actually right and make `correct` and `why` agree." };
  // Free-response mode: answer string
  let answer = input?.answer ? String(input.answer).trim().slice(0, 200) : undefined;
  // The answer key is verified, not trusted: when the model supplies a `check` expression, the app evaluates it and, if the
  // key disagrees (beyond ~1 %), the COMPUTED value wins — a wrong key marked a student's correct 112 wrong seven times.
  // Trig in degrees: a plain sin(12) in the check evaluates in RADIANS, which turned a right key (25,538 W for a 12°
  // slope) into a "verified" −40,126 that marked the student's correct 25537.8 wrong (reported live). When the problem
  // is stated in degrees, sin/cos/tan in the check mean degrees.
  const checkSrc = input?.check ? String(input.check) : "";
  // A WORD key ("H₂", "the mitochondria") is never overwritten by a number: the check only verifies numeric keys
  // (reported: a key of "H₂" with a stray check became "1").
  const wordKey = !!answer && !/\d/.test(answer.replace(/[₀-₉²³]/g, ""));
  const verified = !hasMCQ && checkSrc && !wordKey ? evalCheckFor(checkSrc, question) : null;
  if (verified != null) {
    // "25,538" is twenty-five thousand, not 25.538: thousands separators out before parsing the model's own key.
    const given = answer ? Number(answer.replace(/(\d)[,\s](?=\d{3}(?!\d))/g, "$1").replace(/,/g, ".").replace(/[^0-9.eE+-]/g, "")) : NaN;
    if (!Number.isFinite(given) || Math.abs(given - verified) > Math.max(0.01, Math.abs(verified) * 0.01)) {
      const dec = (answer?.match(/[.,](\d+)/)?.[1] || (/(?:one|1) decimal|une décimale/i.test(String(input?.format || "")) ? "x" : "")).length;
      answer = Math.abs(verified) >= 1000 ? String(Math.round(verified)) : verified.toFixed(Number.isFinite(dec) && dec > 0 ? Math.min(dec, 4) : (Math.abs(verified - Math.round(verified)) < 1e-9 ? 0 : 1));
      console.warn(`[problem] answer key disagreed with its own check — using the computed value ${answer}`);
    }
  }
  if (!hasMCQ && !answer) return { error: "ERROR: a problem needs either MCQ (2+ options + correct index) or a free-response answer." };
  // A numeric key must come with the expression that computes it — an unverified key is how a correct 200 got marked wrong.
  if (requireCheck && !hasMCQ && answer && verified == null && !/[π√a-df-zA-DF-Z]\w*[π√]|[π√]/.test(answer) && isNumericAnswerValue(answer.replace(/[^0-9.,eE+\-−–]/g, "")) && /\d/.test(answer) && !/^[\s≈~=]*\d+\s*\/\s*\d+\s*$/.test(answer)) return { error: input?.check ? "REJECTED: your `check` expression does not evaluate to a number — for a physics/maths problem that usually means the numbers are impossible (e.g. the pull is smaller than gravity-along-the-slope plus friction, so a square root of a negative comes out). Work the problem yourself, pick feasible numbers, and call CREATE_PROBLEM again with a check that evaluates." : "REJECTED: give a `check` expression that COMPUTES the numeric answer from the givens (e.g. \"60000/(1*300)\") — the app verifies the key with it, so a wrong key can't mark a right answer wrong. Recompute it carefully, then call CREATE_PROBLEM again." };
  // A numeric key is ALWAYS a bare number: units never go in the widget ("112 m" marked a correct "112" wrong), they go in the format
  // hint ("answer as a number, in metres"). The exact computed value (when verified) rides along so rounding never fails a right answer.
  let exactValue: number | undefined = verified != null ? verified : undefined;
  if (!hasMCQ && answer) {
    const unitMatch = /^[\s≈~=]*([-−–]?\d[\d\s.,]*(?:e-?\d+)?)\s*(?:°\s*)?([A-Za-zμΩ°%/·^²³⁻¹ ]{1,16})$/.exec(answer);
    const degMatch = /^[\s≈~=]*([-−–]?\d[\d\s.,]*)\s*°\s*$/.exec(answer);
    if (degMatch) { answer = degMatch[1].replace(/\s+/g, "").replace(/[−–]/g, "-"); if (!/degree|°|\bunit/i.test(String(format || ""))) format = `${format ? format + " — " : ""}answer as a number, in degrees`; }
    else if (unitMatch && /[A-Za-zμΩ%°]/.test(unitMatch[2]) && !/^(?:pi|π|e|sqrt|ln|log)\b/i.test(unitMatch[2].trim())) {
      const unit = unitMatch[2].trim();
      answer = unitMatch[1].replace(/\s+/g, "").replace(/[−–]/g, "-").replace(/,(?=\d{3}(?!\d))/g, "");
      if (!/\bunit|\bin\b|\ben\b|\bavec\b/i.test(String(format || ""))) format = `${format ? format + " — " : ""}answer as a number, in ${unit}`;
    }
  }
  // An EXERCISE the student types an answer into must have exactly ONE correct, short, checkable answer — a number,
  // an expression, a single term. Open-ended asks (explain/describe/justify/prove/compare…), multi-part prompts and
  // prose "answers" can't be auto-checked and would mark a right idea wrong; those belong in the conversation.
  // A worded concept answer ("define scarcity") CAN be an exercise once it carries a rubric: it's then graded by
  // meaning in code (shared/exerciseVerification.ts gradeConceptAnswer), not by string match — spec §18.2.
  const rubric = (() => {
    const req = Array.isArray(input?.rubric?.required) ? input.rubric.required : [];
    const required = req.map((g: any) => (Array.isArray(g) ? g : [g]).map((p: any) => String(p || "").trim().slice(0, 80)).filter(Boolean).slice(0, 6))
      .filter((g: string[]) => g.length).slice(0, 5);
    if (!required.length) return undefined;
    const misconceptions = (Array.isArray(input?.rubric?.misconceptions) ? input.rubric.misconceptions : []).map((m: any) => String(m || "").trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    return { required, ...(misconceptions.length ? { misconceptions } : {}) };
  })();
  if (!hasMCQ && answer && rubric && /\(\s*a\s*\)[\s\S]*\(\s*b\s*\)/i.test(question)) return { error: "REJECTED: multi-part prompts can't be auto-checked — create ONE problem per part, each with a single answer." };
  if (!hasMCQ && answer && !rubric) {
    const proseWords = (answer.match(/[A-Za-zÀ-ÿ]{3,}/g) || []).length;
    if (answer.length > 40 || proseWords > 3 || /[.;]\s+\S/.test(answer) || /\b(because|since|donc|parce que|therefore)\b/i.test(answer)) return { error: "REJECTED: a type-in exercise needs ONE short checkable answer (a number, an expression, a single word/term — e.g. \"7\", \"x = 2\", \"sec²x − 1\"). Prose answers can't be auto-checked. Ask this in the conversation instead, or rewrite it so the answer is a single value." };
    if (/\b(explain|describe|discuss|justify|prove|show that|demonstrate|compare|outline|comment on|in your own words|what do you think|why|how (?<verb>would|could|might|do you)|explique|décris|décrivez|discute|justifie|démontre|montre que|compare|pourquoi|à ton avis)\b/i.test(question)) return { error: "REJECTED: that question is open-ended (explain / why / prove / compare…) — it has no single checkable answer, so it is NOT an exercise. Ask it in the conversation, or reword it so it has exactly one correct short answer (\"what is …?\", \"find …\", \"simplify … to a single value\")." };
    if (/\(\s*a\s*\)[\s\S]*\(\s*b\s*\)/i.test(question)) return { error: "REJECTED: multi-part prompts can't be auto-checked — create ONE problem per part, each with a single answer." };
  }
  // Never let the guidance give the answer away. Free-response: scrub format AND hint against the answer.
  // MCQ: scrub against the correct option's text, but only when it's specific enough (3+ chars) not to
  // false-positive on an ordinary number in the hint.
  const secret = hasMCQ ? options[correctIdx] : answer;
  const checkHint = !!secret && (!hasMCQ || secret.replace(/\s/g, "").length >= 3);
  format = scrubAnswerLeak(format, secret);
  // ALWAYS tell them how precise the answer must be: a numeric key with no stated precision gets "to N decimal places" (N from the key itself;
  // 0 → nearest whole number). Added AFTER the leak scrub so a key like "2" can't have its own hint scrubbed away.
  if (!hasMCQ && answer && isNumericAnswerValue(answer) && !/decimal|d\.?p\.?\b|significant|sig\.? ?fig|s\.?f\.?\b|nearest|whole number|integer|exact|fraction|décimale|chiffres? significatifs?|arrondi|entier/i.test(String(format || ""))) {
    const dec = (String(answer).match(/[.,](\d+)\s*$/)?.[1] || "").length;
    const fr = /\b(?:le|la|les|un|une|des|quel|quelle|calcule[rz]?|détermine[rz]?|trouve[rz]?)\b/i.test(question) && !/\b(?:the|find|calculate|what)\b/i.test(question);
    const prec = dec === 0 ? (fr ? "arrondi à l'entier le plus proche" : "to the nearest whole number") : (fr ? `à ${dec} décimale${dec > 1 ? "s" : ""}` : `to ${dec} decimal place${dec > 1 ? "s" : ""}`);
    format = `${format ? format + " — " : ""}${prec}`;
  }
  if (checkHint) hint = scrubAnswerLeak(hint, secret);
  return {
    problem: {
      id: randomUUID(),
      question,
      ...(hasMCQ ? { options, correct: correctIdx } : {}),
      ...(answer && !hasMCQ ? { answer } : {}),
      ...(why ? { why } : {}),
      ...(hint ? { hint } : {}),
      ...(format ? { format } : {}),
      ...(exactValue != null && !hasMCQ ? { value: exactValue } : {}),
      ...(rubric && !hasMCQ ? { rubric } : {}),
      ...(cleanProblemSource(input?.sourceUrl) ? { source: cleanProblemSource(input?.sourceUrl) } : {}),
      createdAt: new Date().toISOString(),
    },
  };
}

const BOARD_KINDS = new Set(["note", "instruction", "given", "result", "formula", "summary", "focus", "insight", "definition", "outline", "gap", "strategy"]);

/** Resolve an ANNOTATE_BOARD target ("#3" or an id) against the board as the model saw it (the last 40 entries, annotations excluded). */
export function resolveBoardTarget(target: string, board: BoardEntry[]): BoardEntry | null {
  const visible = board.slice(-40);
  const m = /^#?\s*(\d{1,3})$/.exec(String(target || "").trim());
  if (m) {
    const n = Number(m[1]);
    // The student-visible margin number wins when the board carries one (shared/boardLines.ts).
    const byNumber = board.find((e) => e.n === n && e.kind !== "annotation");
    if (byNumber) return byNumber;
    return n >= 1 && n <= visible.length && visible[n - 1].kind !== "annotation" ? visible[n - 1] : null;
  }
  const id = String(target || "").trim();
  return id ? visible.find((e) => e.id === id && e.kind !== "annotation") || null : null;
}

const MAX_OUTLINE_SECTIONS = 6;

const MAX_OUTLINE_BULLETS = 8;

/** Cut at a word boundary, with an ellipsis, never mid-word (a "why" ending "…the gradi" read as broken). */
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, "") + "…";
}

export function makeBoardEntry(input: any): { entry: BoardEntry } | { error: string } {
  // A literal "\n" the model typed (not LaTeX like \neq / \nu) is a line break (reported: recaps showed "\n").
  const text = stripLeakedToolCallSyntax(String(input?.text || "").replace(/\\n(?!(?:eq?|u|abla|ot|otin|ewline|i|less|gtr|mid|parallel|leq|geq|rightarrow|leftarrow|Rightarrow|Leftarrow|sim|cong|subset|vdash|vDash|exists)(?![a-zA-Z]))/g, "\n").trim()).replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, "").replace(/&nbsp;|&#160;/gi, " ").slice(0, 600);
  if (!text) return { error: "ERROR: a board entry needs non-empty text." };
  const whyRaw = stripLeakedToolCallSyntax(String(input?.why || "")).replace(/<\/?[a-z][^>]*>/gi, "").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
  const why = clipWords(whyRaw, 160);
  const kindRaw = String(input?.kind || "").trim();
  const kind = BOARD_KINDS.has(kindRaw) ? (kindRaw as BoardEntry["kind"]) : undefined;
  if (kind === "outline") {
    const raw = Array.isArray(input?.outline) ? input.outline : [];
    const outline = raw
      .map((s: any) => ({
        heading: stripLeakedToolCallSyntax(String(s?.heading || "").trim()).slice(0, 120),
        bullets: (Array.isArray(s?.bullets) ? s.bullets : [])
          .map((b: any) => stripLeakedToolCallSyntax(String(b || "").trim()).slice(0, 200))
          .filter(Boolean)
          .slice(0, MAX_OUTLINE_BULLETS),
      }))
      .filter((s: { heading: string; bullets: string[] }) => s.heading && s.bullets.length)
      .slice(0, MAX_OUTLINE_SECTIONS);
    if (!outline.length) return { error: "ERROR: kind:'outline' needs at least one section with a heading and bullets — pass the `outline` field, not just `text`." };
    return { entry: { id: randomUUID(), text, kind, outline, at: new Date().toISOString() } };
  }
  // Bad LaTeX never reaches the board: one span KaTeX can't parse used to print as raw source. Bounce it back
  // to the model (same one-corrective-round shape as the leak guards) with KaTeX's own error.
  const bad = unrenderableMath(text);
  if (bad) return { error: `REJECTED: this maths doesn't typeset — "${bad.latex.slice(0, 120)}" (${bad.message}). Fix the LaTeX (balanced braces, \\frac{a}{b}, \\tan, 25^\\circ) and call WRITE_TO_BOARD again; don't mention this.` };
  const owner: BoardEntry["owner"] = input?.owner === "student" ? "student" : "otto";
  const expectedAnswer = kind === "gap" && input?.expectedAnswer ? String(input.expectedAnswer).trim().slice(0, 200) : undefined;
  const gapAction = kind === "gap" && input?.gapAction ? String(input.gapAction).trim().replace(/\s+/g, " ").slice(0, 60) : undefined;
  return { entry: { id: randomUUID(), text, ...(kind ? { kind } : {}), ...(owner === "student" ? { owner } : {}), ...(expectedAnswer ? { expectedAnswer } : {}), ...(gapAction ? { gapAction } : {}), ...(why ? { why } : {}), at: new Date().toISOString() } };
}

/** Session objectives are a condensed checklist (reported: long sentences made the panel unreadable): drop a trailing
 *  explanation after a dash/colon/parenthesis, then cut to 48 characters on a word boundary. Exported for tests. */
export function condenseObjective(label: string): string {
  let l = String(label || "").replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  const head = l.split(/\s+[—–-]\s+|:\s+|\s+\(/)[0].trim();
  if (head.length >= 8) l = head;
  if (l.length <= 48) return l;
  const cut = l.slice(0, 48);
  const sp = cut.lastIndexOf(" ");
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[,;:—–-]+$/, "").trim() + "…";
}

/** Full-replace validator for SET_OBJECTIVES — mirrors the tool's own contract (the model always sends the
 *  WHOLE current list, never a delta), so there's nothing to merge against prior state here. */
export function makeObjectives(input: any): { objectives: TaskObjective[] } | { error: string } {
  const raw = Array.isArray(input?.objectives) ? input.objectives : [];
  const objectives = raw
    .map((o: any) => ({
      id: randomUUID(),
      label: condenseObjective(stripLeakedToolCallSyntax(String(o?.label || "").trim())),
      done: Boolean(o?.done),
    }))
    .filter((o: TaskObjective) => o.label)
    .slice(0, 5);
  if (!objectives.length) return { error: "ERROR: SET_OBJECTIVES needs at least one objective with a non-empty label." };
  return { objectives };
}

/** True when an incoming board write is content-identical to an entry ALREADY on the board — the visual
 *  duplicate problem. UUIDs make the client's by-id dedupe useless here (every write gets a fresh id, so a
 *  re-written formula sails through and stacks a second visual copy), so comparison has to be on CONTENT:
 *  normalized text (trim, collapse whitespace, lowercase, strip the code fences/markdown emphasis/bullets
 *  the prompt says entries are built from — those are formatting, not content) plus a kind guard. Normalized
 *  comparison is deliberately EXACT — no fuzzy/prefix matching, which would eat genuinely different entries
 *  ("F = ma" vs "a = F/m" share a word set but are different board content). A TYPED incoming kind must
 *  match the existing entry's kind, so quoting "F = ma" as a deliberate kind:"insight" beside the formula
 *  still works; an UNTYPED incoming write matches any kind — the model is inconsistent about kinds, and a
 *  duplicate is a duplicate regardless of its label. Diagrams are handled by their caller (DRAW_ON_BOARD
 *  explicitly redraws whole figures with additions, so a same-caption redraw is legitimate, not a
 *  duplicate). Pure; unit-tested in tests/run.mjs. */
export function isDuplicateBoardEntry(existing: BoardEntry[], incoming: { text?: unknown; kind?: unknown }): boolean {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/```[a-z]*|[`*]{1,3}|^\s*[-•]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  const kindOf = (k: unknown) => (typeof k === "string" && BOARD_KINDS.has(k) ? k : "note");
  const raw = typeof incoming?.text === "string" ? incoming.text : "";
  if (!norm(raw)) return false; // empty/whitespace never counts as a duplicate
  const inKind = typeof incoming?.kind === "string" && BOARD_KINDS.has(incoming.kind) ? incoming.kind : undefined;
  const inText = norm(raw);
  // Near-duplicates count too: the same line re-worded or re-ordered slightly used to stack as a second copy
  // (the board "repeating itself").
  return existing.some((e) => (inKind === undefined || kindOf(e.kind) === inKind) && (norm(e.text) === inText || similarity(norm(e.text), inText) >= 0.85));
}

/** A figure/equation entry that repeats one already on the board: same caption AND same drawing (or the same
 *  set of typeset equations). Re-drawing with something genuinely NEW (an added altitude, a corrected value)
 *  differs and passes. */
export function isDuplicateDiagram(existing: BoardEntry[], incoming: BoardEntry): boolean {
  const sig = (e: BoardEntry) => JSON.stringify((e.diagram || []).map((o) => (o.op === "equation" ? { l: String(o.latex || "").replace(/\s+/g, "") } : o)));
  const cap = (e: BoardEntry) => e.text.trim().toLowerCase();
  const eqs = (e: BoardEntry) => (e.diagram || []).filter((o) => o.op === "equation").map((o) => String((o as any).latex || "").replace(/\s+/g, "")).sort().join("|");
  const allEq = (e: BoardEntry) => !!e.diagram?.length && e.diagram.every((o) => o.op === "equation");
  return existing.some((e) => e.kind === "diagram" && e.diagram?.length && (sig(e) === sig(incoming) || (allEq(e) && allEq(incoming) && eqs(e) === eqs(incoming))));
}

/** True when an incoming CREATE_PROBLEM call would create a content-identical copy of a problem that's
 *  already there — unlike a diagram (which legitimately gets redrawn under the same caption to add
 *  something — see isDuplicateBoardEntry's own comment), there is no such legitimate case for a second
 *  practice problem with the same question: CREATE_PROBLEM's own description already says "ONE standalone
 *  practice problem," so a repeat is always a mistake, not an intentional update. Reproduced live: a long
 *  session's board showed the exact same question twice — once unanswered, once answered — because a turn
 *  that already called CREATE_PROBLEM successfully failed its OWN final reply (the empty-completion/
 *  token-ceiling bug), the student never saw it got made, and a later turn made it again from scratch.
 *  Comparison is on normalized `question` text only (same normalization as isDuplicateBoardEntry) — options/
 *  answer/hint are ignored, since a reworded option on an otherwise-identical question is still the same
 *  problem being recreated, not a genuinely new one. Pure; unit-tested in tests/run.mjs. */
export function isDuplicateProblem(existing: TaskProblem[], incoming: { question?: unknown }): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/```[a-z]*|[`*]{1,3}|^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
  const raw = typeof incoming?.question === "string" ? incoming.question : "";
  if (!norm(raw)) return false;
  const inText = norm(raw);
  // near-duplicates too: "Find sin(5π/12) by writing it as a sum" re-asked with a few words changed is the same exercise
  return existing.some((p) => norm(p.question) === inText || similarity(norm(p.question), inText) >= 0.7);
}

/** True when a finished chat reply is exactly the moment the board's reasoning-trace rule exists for:
 *  Otto just CONFIRMED the student's own step was right ("Yes — exactly that", "bien joué", "parfait")
 *  and there's real math in play — but nothing was written to the board this turn. This is the live-reported
 *  miss: the confirmation and the worked algebra ("1 − cos²θ is sin²θ, so the fraction is sin²θ over
 *  sinθ·cosθ — what does that cancel down to?") stay in chat, and the board never records the student's
 *  own reasoning or the formula the step established — the session document stalls at the last thing OTTO
 *  wrote instead of reflecting the student's thinking. Deliberately conservative, because the corrective
 *  round costs a round trip and a false positive injects an instruction into a flowing conversation:
 *  - CONFIRMATION: an affirmative opener (English + French, the two account languages). Replies that
 *    explain from scratch ("Let's start with...") or only ask the next question are the normal coaching
 *    loop, not a miss — never triggered.
 *  - MATH IN PLAY: a math marker anywhere in the reply or the student's message (an equals sign, greek
 *    letters/superscripts, function names like sin/cos/log, or formula vocabulary). A confirmed step in a
 *    literature essay isn't board content; the derivation is what the board holds.
 *  - NOTHING WRITTEN: `wroteToBoardThisTurn` false — if Otto already wrote, the rule is satisfied; never nag.
 *  Pure; unit-tested in tests/run.mjs. Consumed by chatAboutTask's tool loop as a ONE-SHOT corrective
 *  round (same posture as the empty-board-claim fix — a prompt line alone was reported-live ignorable). */
/** Is there real math (or a formula being talked about) in this text? Shared by the two board-write
 *  enforcement predicates below so "what counts as board-worthy" can't drift between them. Pure. */
export function mathInPlay(text: string): boolean {
  return /=/.test(text)
    || /[\^√πθ²³±×÷≤≥]/.test(text)
    || /\b(sin|cos|tan|log|ln|exp|lim|deriv\w*|dériv\w*|factor\w*|simplif\w*|cancel\w*)\b/i.test(text)
    || /\b(formula|formule|equation|équation|square|carré)\b/i.test(text);
}

/** Formatting-insensitive comparison key: fences, markdown emphasis and dollar delimiters go, and so does
 *  EVERY space — "So we use F_net = mg sin25 here" has to compare equal to what the board carries as
 *  "F_net = mg sin25", and word-level comparison would call that new. */
function boardCompareKey(s: string): string {
  return String(s || "").toLowerCase().replace(/```[a-z]*|[`*$]{1,3}/g, "").replace(/\s+/g, "");
}

/** Is this fragment actual working, rather than prose that happens to contain an equals sign? The case this
 *  exists for is "the author's tone = ironic throughout" — a humanities reply must never look like a board
 *  miss. Working is: something numeric, something with a real operator/symbol, an algebraic identity of short
 *  symbol tokens ("x = a"), or a subscripted quantity ("F_net = mg"). Two ordinary words never qualify. */
function looksLikeWorking(fragment: string): boolean {
  const f = fragment.replace(/\$/g, "").trim();
  if (f.length < 4) return false;
  if (/[0-9]/.test(f)) return true;
  // Includes the UNICODE minus/dash a model actually emits (−, –), not just the ASCII hyphen.
  if (/[\^√πθ²³×÷±·+\-−–*/()\[\]]/.test(f)) return true;
  const [l, r] = f.split("=");
  const short = (t: string) => /^[a-zA-Zα-ωΑ-Ω]{1,3}$/.test((t || "").trim());
  const scripted = (t: string) => /_[a-zA-Z0-9]{1,6}$/.test((t || "").trim());
  return (short(l) && short(r)) || scripted(l) || scripted(r);
}

/** The real WORKING a reply introduces that is NOT already on the board: every `$…$` segment, plus the
 *  equation inside every line carrying an equals sign (the shape actual working takes). Containment is
 *  whitespace-insensitive and formatting-insensitive, in the same spirit as isDuplicateBoardEntry's own
 *  normalization, so a formula the board already carries is never counted as new — and "F = ma" quoted in a
 *  reply when "F = ma" is already up is not a miss. Deliberately requires an actual relation/segment rather
 *  than mathInPlay's fuzzy vocabulary: a mid-session nudge has to be right, and "the formula for the area" in
 *  passing is not working. Pure; unit-tested. */
export function newMathOffBoard(reply: string, boardText: string): string[] {
  const board = boardCompareKey(boardText);
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string) => {
    const f = String(raw || "")
      .replace(/^\s*(?:so|then|now|and)\s+/i, "")
      .replace(/\$/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[.,;:!?]+|[.,;:!?]+$/g, "")
      .trim();
    const key = boardCompareKey(f);
    if (!looksLikeWorking(f) || seen.has(key) || board.includes(key)) return;
    seen.add(key);
    out.push(f);
  };
  const text = String(reply || "");
  for (const m of text.matchAll(/\$\$([^$]+)\$\$|\$([^$\n]+)\$/g)) consider(m[1] ?? m[2] ?? "");
  for (const line of text.split("\n")) {
    if (!/=/.test(line)) continue;
    // The EQUATION inside the sentence, not the sentence: "So we use F_net = mg sin25 here." has to be
    // recognised as the thing the board already carries, and "the author's tone = ironic" has to be
    // recognised as prose rather than as working (see looksLikeWorking).
    for (const m of line.matchAll(/[^\s=]{1,30}\s*=\s*[^\s=]{1,30}/g)) consider(m[0]);
  }
  return out;
}

/** Is there real working in this reply that the page doesn't carry yet? */
export function replyIntroducesNewMath(reply: string, boardText: string): boolean {
  return newMathOffBoard(reply, boardText).length > 0;
}

/** The OTHER half of the board-write enforcement: the tutor put real working in CHAT that the board doesn't
 *  carry — "it explains the formula but never shows it". Reported live as "the tutor is not using the board
 *  enough": a session could run several turns with a worked formula in every reply and a board that never
 *  filled up, because nothing enforced the write (shouldNudgeBoardWrite only fires on a CONFIRMATION, and
 *  nudgeReasoning only on a student-contributed step).
 *
 *  This used to be gated on the board being EMPTY, on the theory that an empty board is the only case where
 *  a nudge can't nag. That gate was the bug: a session wrote its focus line, and every turn after that could
 *  do the entire derivation in chat with no correction ever — the board stalled at one or two entries while
 *  the conversation worked through everything. It now fires whenever the reply introduces working the page
 *  doesn't have (see replyIntroducesNewMath), so "already wrote something" is no longer a free pass; the
 *  once-per-turn latch in nudgeReasoning is what keeps it from nagging. A reply that is just the next
 *  question introduces no working and never triggers it. Pure; unit-tested. */
export function shouldNudgeBoardContent(reply: string, boardText: string, wroteToBoardThisTurn: boolean): boolean {
  if (wroteToBoardThisTurn) return false;
  if (!mathInPlay(reply)) return false;
  return replyIntroducesNewMath(reply, boardText);
}

/** Never triggered by a reply that says nothing and asks the next question (the coaching loop). */
export function shouldNudgeBoardWrite(reply: string, lastStudentMessage: string, wroteToBoardThisTurn: boolean): boolean {
  if (wroteToBoardThisTurn) return false;
  const text = `${reply}\n${lastStudentMessage}`;
  if (!mathInPlay(text)) return false;
  // Reproduced live: a real session where every "Spot on. The thruster gave it a boost…" confirmation after
  // a correct physics answer never triggered the nudge — "spot on" (and a few other everyday ways of saying
  // "you got it") simply weren't in this list, so the ONE mechanism meant to catch "confirmed the student's
  // math/physics and wrote nothing down" silently missed every single one of them in that session. Board
  // ends up looking empty even though the tutor is actively confirming worked answers turn after turn.
  return /^\s*(yes|yeah|yep|exactly|correct|right|nice|perfect|well done|good|bravo|spot on|nailed it|(you(?:'ve)? )?got it( right)?|absolutely|that'?s (it|right|correct)|oui|ouais|exact|exactement|c'est (ça|ca|exact|correct)|parfait|bien joué|très bien|nickel|voilà|tout à fait)\b/i.test(reply.trim());
}

/** Everything in the thread that falls OUTSIDE the model's verbatim window, condensed to one line per message
 *  (newest kept when over budget) — so a long session never "forgets" what was already covered and re-explains
 *  it. Deterministic, no model call. Returns "" when there's nothing older. Pure; unit-tested. */
export function earlierDigest(older: { role: string; text: string }[], maxChars = 1800): string {
  const lines = older
    .map((m) => {
      const clean = String(m.text || "").replace(/\[(?:Exercise|Exercice)\][^\n]*/g, "(answered a board exercise)").replace(/\[(?:What I wrote\/drew on the board|Ce que j'ai écrit\/dessiné sur le tableau)[\s\S]*?\]/g, "(showed their whiteboard)").replace(/\s+/g, " ").trim();
      if (!clean) return "";
      const firstSentence = m.role === "assistant" ? (clean.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? clean) : clean;
      return `- ${m.role === "assistant" ? "Otto" : "Student"}: ${firstSentence.slice(0, 130)}`;
    })
    .filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) { if (used + lines[i].length + 1 > maxChars) break; kept.unshift(lines[i]); used += lines[i].length + 1; }
  if (!kept.length) return "";
  return `EARLIER IN THIS SESSION (condensed, oldest first — this is already DONE: don't re-explain it or re-ask it, build on it):\n${kept.join("\n")}`;
}

/** True when the student just CONTRIBUTED something worth recording — a step, a result, a line of reasoning —
 *  as opposed to a question, a one-tap chip, an acknowledgement, "I don't know" or an automatic message.
 *  Used only to decide whether Otto should be asked (never a model-free copy) to put the reasoning on the
 *  board. Pure; unit-tested. */
export function isSubstantiveStep(message: string): boolean {
  const raw = String(message || "")
    .replace(/\[(?:Exercise|Exercice)\][^\n]*/g, " ")
    .replace(/\[(?:What I wrote\/drew on the board|Ce que j'ai écrit\/dessiné sur le tableau)[\s\S]*?\]/g, " ")
    .replace(/(?:Here's what I drew|Voici ce que j'ai dessiné)\s*:[\s\S]*$/i, " ")
    .replace(/\s+/g, " ").trim();
  if (raw.length < 6) return false;
  const words = raw.split(/\s+/).length;
  const mathy = /[=^√π²³±×÷≤≥<>]|\d/.test(raw); // any number or operator: a result or a calculation
  if (/^\s*(ok(ay)?|oui|non|yes|no|yeah|merci|thanks?|thank you|d'accord|compris|got it|i see|je vois|hi|hello|salut|bonjour|hey)\b[\s.!]*$/i.test(raw)) return false;
  if (/(can i have a small hint|i'm lost|got it! give me another|i'm stuck on a problem|i'd like to understand a topic|quiz me|un petit indice|je suis perdu|donne-m'en un autre|je bloque sur un exercice|interroge-moi|comprendre un chapitre)/i.test(raw)) return false;
  if (/\b(i don'?t know|idk|je ne sais pas|je sais pas|no idea|aucune id[ée]e)\b/i.test(raw) && words < 8) return false;
  if (/\?\s*$/.test(raw) && !/=/.test(raw)) return false;
  return mathy || words >= 6;
}

const MAX_DIAGRAM_OPS = 15;

const clampCoord = (n: unknown, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : 0));

const clampX = (n: unknown) => clampCoord(n, 0, 800);

const clampY = (n: unknown) => clampCoord(n, 0, 600);

const clampR = (n: unknown) => clampCoord(n, 0, 400);

const DIAGRAM_SIZES = new Set(["sm", "md", "lg"]);

/** Validates/clamps one raw op from the model into a real DiagramOp — every coordinate is clamped into the
 *  0-800x0-600 space so a bad value can't produce a shape that renders off-canvas or breaks the SVG viewBox.
 *  Returns null for an unrecognized `op` or one missing its required fields, so ONE bad op just gets dropped
 *  rather than rejecting the whole figure the model otherwise got right. */
function validateDiagramOp(raw: any): DiagramOp | null {
  const color = typeof raw?.color === "string" && raw.color.trim() ? raw.color.trim().slice(0, 20) : undefined;
  switch (raw?.op) {
    case "line":
      return { op: "line", x1: clampX(raw.x1), y1: clampY(raw.y1), x2: clampX(raw.x2), y2: clampY(raw.y2), ...(raw.arrow ? { arrow: true } : {}), ...(raw.dashed ? { dashed: true } : {}), ...(color ? { color } : {}) };
    case "rect":
      return { op: "rect", x: clampX(raw.x), y: clampY(raw.y), w: clampCoord(raw.w, 1, 800), h: clampCoord(raw.h, 1, 600), ...(raw.fill ? { fill: true } : {}), ...(color ? { color } : {}) };
    case "circle":
      return { op: "circle", cx: clampX(raw.cx), cy: clampY(raw.cy), r: clampR(raw.r) || 1, ...(raw.fill ? { fill: true } : {}), ...(raw.dashed ? { dashed: true } : {}), ...(color ? { color } : {}) };
    case "polyline": {
      const pts = Array.isArray(raw.points) ? raw.points.slice(0, 30).map((p: any) => ({ x: clampX(p?.x), y: clampY(p?.y) })) : [];
      if (pts.length < 2) return null;
      return { op: "polyline", points: pts, ...(raw.dashed ? { dashed: true } : {}), ...(color ? { color } : {}) };
    }
    case "polygon": {
      const pts = Array.isArray(raw.points) ? raw.points.slice(0, 20).map((p: any) => ({ x: clampX(p?.x), y: clampY(p?.y) })) : [];
      if (pts.length < 3) return null;
      return { op: "polygon", points: pts, ...(raw.fill ? { fill: true } : {}), ...(color ? { color } : {}) };
    }
    case "arc": {
      const a0 = clampCoord(raw.a0, -720, 720), a1 = clampCoord(raw.a1, -720, 720);
      if (a0 === a1) return null;
      return { op: "arc", cx: clampX(raw.cx), cy: clampY(raw.cy), r: clampR(raw.r) || 1, a0, a1, ...(raw.dashed ? { dashed: true } : {}), ...(color ? { color } : {}) };
    }
    case "label": {
      const text = String(raw?.text || "").trim().slice(0, 60);
      if (!text) return null;
      const size = DIAGRAM_SIZES.has(raw?.size) ? raw.size : undefined;
      return { op: "label", x: clampX(raw.x), y: clampY(raw.y), text, ...(size ? { size } : {}) };
    }
    case "axes":
      return {
        op: "axes", x: clampX(raw.x), y: clampY(raw.y), w: clampCoord(raw.w, 1, 800), h: clampCoord(raw.h, 1, 600),
        ...(raw.xLabel ? { xLabel: String(raw.xLabel).trim().slice(0, 30) } : {}),
        ...(raw.yLabel ? { yLabel: String(raw.yLabel).trim().slice(0, 30) } : {}),
      };
    case "equation": {
      // Strip $ / \( \) / \[ \] delimiters if the model included them anyway — `latex` is meant to be bare.
      const latex = String(raw?.latex || "").trim()
        .replace(/^\$+|\$+$/g, "")
        .replace(/^\\\(|\\\)$/g, "")
        .replace(/^\\\[|\\\]$/g, "")
        .trim().slice(0, 300);
      if (!latex) return null;
      return { op: "equation", x: clampX(raw.x), y: clampY(raw.y), latex };
    }
    default:
      return null;
  }
}

export function makeDiagramEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const rawOps = Array.isArray(input?.ops) ? input.ops : [];
  if (!rawOps.length) return { error: "ERROR: ops cannot be empty." };
  if (rawOps.length > MAX_DIAGRAM_OPS) return { error: `REJECTED: max ${MAX_DIAGRAM_OPS} ops — simplify the figure or split it into two board entries.` };
  const ops = rawOps.map(validateDiagramOp).filter((o: DiagramOp | null): o is DiagramOp => o !== null);
  if (!ops.length) return { error: "ERROR: no valid ops after validation — check each op has its required fields (see the tool schema)." };
  return { entry: { id: randomUUID(), text: caption, kind: "diagram", diagram: ops, at: new Date().toISOString() } };
}

/** GEOMETRY_ON_BOARD: the model states points in REAL units + relations; shared/geometry.ts does the drawing maths. */
export function makeGeometryEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const r = buildGeometry(input || {});
  if ("error" in r) return r;
  return { entry: { id: randomUUID(), text: caption, kind: "diagram", diagram: r.ops, at: new Date().toISOString() } };
}

export const GEOMETRY_ON_BOARD_TOOL = {
  name: "GEOMETRY_ON_BOARD",
  description: "Draw an ACCURATE geometry figure on the board — triangles, circles, sectors/arcs, polygons, angle marks, " +
    "altitudes, midpoints. You give the MATHS (named points in real units, what joins what), the board does the drawing: " +
    "correct proportions (a 3-4-5 triangle really is right-angled), centred, every point labelled outside the shape, angle " +
    "arcs and right-angle squares, tick marks for equal sides. NEVER work out pixel coordinates. Use this for ANY geometry " +
    "or trig-setup figure (ALWAYS say what joins what: `segments`/`polygons`, or use `triangle`); use CREATE_INTERACTIVE with JSXGraph when the student should drag points; use DRAW_ON_BOARD only for non-geometric sketches (arrows, number lines, free diagrams). " +
    "Show the GIVEN information only (lengths, angles the problem states) — label what the student must find with '?' " +
    "or leave it unlabelled, never the answer. `triangle.sides` CANNOT express an unknown — it takes exactly three " +
    "real numbers and solves+labels ALL three sides (that's what it's for: a fully-given SSS triangle). The moment " +
    "ANY side or angle is the thing the student must find — including a 'two sides and the angle between them, find " +
    "the third side' law-of-cosines setup — do NOT compute that value yourself and feed it into `triangle.sides` just " +
    "to satisfy the schema: that silently draws and labels the answer before they've solved anything (reported live: " +
    "a 'find x' triangle came out with x already labelled with a real, computed number). Use `points`+`segments` " +
    "instead: place the two known-length vertices with plain coordinates (exact position doesn't matter, only that " +
    "the figure looks roughly right), and give the unknown segment a LETTER label ('x', not a number). Redraw the " +
    "WHOLE figure when adding to it (e.g. add the altitude). " +
    "EXAMPLES: a 3-4-5 triangle with the right angle at C, ALL THREE SIDES GIVEN → triangle:{names:['A','B','C'], sides:[3,4,5]} " +
    "(sides are [a=BC, b=CA, c=AB]) + angles:[{at:'C',from:'A',to:'B',right:true}]. Triangle with altitude → triangle + " +
    "derive:[{name:'H',kind:'foot',from:'A',onto:['B','C']}] + segments:[{from:'A',to:'H',dashed:true}] + angles:[{at:'H',from:'A',to:'B',right:true}]. " +
    "Two sides 10 and 7 with a 65° angle between them, THIRD SIDE UNKNOWN (never use `triangle` here) → " +
    "points:{A:[0,0], B:[10,0], C:[7*cos(65°),7*sin(65°)]} (compute C's coordinates from the given angle — that's " +
    "trig on the GIVENS, not solving the unknown), segments:[{from:'A',to:'B',label:'10'},{from:'A',to:'C',label:'7'}," +
    "{from:'B',to:'C',label:'x'}], angles:[{at:'A',from:'B',to:'C',label:'65°'}]. " +
    "Sector of radius 2 and angle 5π/6 → points:{O:[0,0]}, arcs:[{center:'O',r:2,from:0,to:150,label:'5π/6'}], " +
    "derive:[{name:'A',kind:'polar',from:'O',dist:2,deg:0},{name:'B',kind:'polar',from:'O',dist:2,deg:150}], segments:[{from:'O',to:'A',label:'2'},{from:'O',to:'B',label:'2'}]. " +
    "Two circles → circles:[{center:'O1',r:15},{center:'O2',r:10}] with points O1:[0,0], O2:[25,0].",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line, shown as the figure's title" },
    points: { type: "object", description: "named points in REAL units, maths orientation (y up): {\"A\":[0,0],\"B\":[4,0]}. Names are letters like A, B, O, H, A'." },
    triangle: { type: "object", description: "alternative to points for a FULLY-GIVEN (SSS) triangle only: {names:[A,B,C], sides:[a,b,c]} where a=BC, b=CA, c=AB; solved exactly (law of cosines) and all three sides get a real numeric length label. NEVER use this when any side is the student's unknown — there is no way to omit or letter-label a `sides` entry, so doing so always draws the computed answer. Use `points`+`segments` for that case instead (see the tool description's own example).", properties: { names: { type: "array", items: { type: "string" } }, sides: { type: "array", items: { type: "number" } }, labelSides: { type: "boolean" } } },
    derive: { type: "array", description: "points computed in order: {name,kind:'midpoint',of:[P,Q]} | {name,kind:'foot',from:P,onto:[Q,R]} (foot of the perpendicular = altitude/height) | {name,kind:'polar',from:P,dist,deg} (a point at a distance and angle from P, degrees counter-clockwise from the +x axis).", items: { type: "object" } },
    segments: { type: "array", description: "\"AB\" or {from,to,label?,dashed?,ticks?(1-3 equal-side marks),arrow?,color?}. label is a length like \"5\" or \"x\".", items: {} },
    polygons: { type: "array", description: "closed shapes: \"ABC\" or {points:[...],fill?:true,color?}", items: {} },
    circles: { type: "array", description: "{center,r | through,label?,dashed?,fill?} — r in the same real units as the points", items: { type: "object" } },
    arcs: { type: "array", description: "{center,r,from,to,label?} degrees counter-clockwise from +x — sectors, arc length problems", items: { type: "object" } },
    angles: { type: "array", description: "{at:'B',from:'A',to:'C',label?:'40°'|'θ'|'?',right?:true} — an arc (or right-angle square) at vertex B between rays BA and BC", items: { type: "object" } },
    unlabeled: { type: "array", items: { type: "string" }, description: "point names that should NOT get a name label" },
  }, required: ["caption"] },
};

/** ANNOTATE_BOARD — Otto's pointer: a short note attached to a specific board entry (its #n from the board listing, or its
 *  id). This is how a tutor "circles the mistake" or "points at the equation" instead of writing a paragraph in chat. */
export const ANNOTATE_BOARD_TOOL = {
  name: "ANNOTATE_BOARD",
  description: "Attach a SHORT pointer to one existing board entry — highlight it, circle a mistake in the student's work, point at the " +
    "line to look at, or mark something they got right. Use the entry's #n from WHAT'S CURRENTLY ON THE BOARD (or its id). The note " +
    "points and asks; it NEVER states the correction or the answer (\"look at the direction of this force — perpendicular to what?\" " +
    "not \"N should be mg cos θ\"). Prefer this to explaining a mistake in chat: show WHERE, let them find WHAT. One or two per turn.",
  input_schema: { type: "object", properties: {
    target: { type: "string", description: "which entry: '#3' (its number in the board listing) or its id" },
    note: { type: "string", description: "the pointer, ≤ 20 words, maths in $…$, a question or a nudge — never the fix" },
    tone: { type: "string", enum: ["error", "hint", "good", "focus"], description: "error = this looks wrong; hint = look here; good = nicely done; focus = this is the line we're working on" },
  }, required: ["target", "note"] },
};

const GRAPH_COLORS = ["blue", "red", "green", "orange", "purple", "ink"] as const;

/** Validate a GRAPH_ON_BOARD request: every expression must compile (shared/mathExpr.ts, no eval) and produce
 *  real numbers somewhere in the window, params are single letters, ranges are sane. Errors are written for
 *  the MODEL to read and retry from. */
export function makeGraphEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : NaN);
  const kind: NonNullable<GraphSpec["kind"]> = ["bars", "histogram", "surface"].includes(input?.kind) ? input.kind : "function";
  const label = (v: any, n: number) => (v ? String(v).trim().slice(0, n) : undefined);
  const mk = (graph: GraphSpec): { entry: BoardEntry } => ({ entry: { id: randomUUID(), text: caption, kind: "graph", graph, at: new Date().toISOString() } });
  const axes = { xLabel: label(input?.xLabel, 20), yLabel: label(input?.yLabel, 20) };

  if (kind === "bars") {
    const bars = (Array.isArray(input?.bars) ? input.bars : []).slice(0, 14)
      .map((b: any) => ({ label: String(b?.label ?? "").trim().slice(0, 24), value: num(b?.value) }))
      .filter((b: { label: string; value: number }) => b.label && Number.isFinite(b.value));
    if (bars.length < 2) return { error: "ERROR: a bar chart needs `bars`: at least 2 items like {label, value}." };
    return mk({ kind, bars, fns: [], xmin: 0, xmax: 1, ...axes });
  }
  if (kind === "histogram") {
    const data = (Array.isArray(input?.data) ? input.data : []).slice(0, 500).map(num).filter((n: number) => Number.isFinite(n));
    if (data.length < 5) return { error: "ERROR: a histogram needs `data`: at least 5 numbers." };
    if (Math.min(...data) === Math.max(...data)) return { error: "ERROR: all the data values are identical — nothing to bin." };
    const bins = Math.round(num(input?.bins));
    return mk({ kind, data, bins: bins >= 2 && bins <= 40 ? bins : undefined, fns: [], xmin: 0, xmax: 1, ...axes });
  }

  const xmin = num(input?.xmin), xmax = num(input?.xmax);
  if (!(xmin < xmax) || xmax - xmin > 10000) return { error: "ERROR: xmin and xmax are required numbers with xmin < xmax (span ≤ 10000)." };
  let ymin: number | undefined = num(input?.ymin), ymax: number | undefined = num(input?.ymax);
  if (Number.isNaN(ymin) || Number.isNaN(ymax) || !(ymin < ymax)) { ymin = undefined; ymax = undefined; }
  const rawParams = Array.isArray(input?.params) ? input.params.slice(0, 3) : [];
  const params: NonNullable<GraphSpec["params"]> = [];
  for (const rp of rawParams) {
    const name = String(rp?.name || "").trim().toLowerCase();
    if (!/^[a-df-wz]$/.test(name)) return { error: `ERROR: slider name "${name}" must be a single letter other than x, y and e (e.g. a, b, k, m).` };
    if (params.some((q) => q.name === name)) return { error: `ERROR: slider "${name}" is declared twice.` };
    const min = num(rp?.min), max = num(rp?.max);
    if (!(min < max)) return { error: `ERROR: slider "${name}" needs min < max.` };
    const value = Math.min(max, Math.max(min, Number.isFinite(num(rp?.value)) ? num(rp?.value) : (min + max) / 2));
    const step = Number.isFinite(num(rp?.step)) && num(rp?.step) > 0 ? num(rp?.step) : (max - min) / 40;
    params.push({ name, min, max, value, step, label: label(rp?.label, 40) });
  }
  const base: Record<string, number> = Object.fromEntries(params.map((q) => [q.name, q.value]));

  if (kind === "surface") {
    if (ymin === undefined || ymax === undefined) return { error: "ERROR: a surface needs ymin and ymax (the y-range of the x-y plane) as well as xmin/xmax." };
    const zExpr = String(input?.z || "").trim().replace(/^z\s*=\s*/i, "").replace(/^f\(x\s*,\s*y\)\s*=\s*/i, "");
    const c = compileExpr(zExpr, ["x", "y", ...params.map((q) => q.name)]);
    if ("error" in c) return { error: `ERROR: can't plot z = "${zExpr}": ${c.error}. Use plain math in x, y${params.length ? ` and ${params.map((q) => q.name).join(", ")}` : ""} (e.g. "x^2 + y^2", "sin(x)*cos(y)").` };
    let finite = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) if (Number.isFinite(c.fn({ ...base, x: xmin + ((xmax - xmin) * i) / 8, y: ymin + ((ymax - ymin) * j) / 8 }))) finite++;
    if (finite < 20) return { error: `ERROR: z = "${zExpr}" has almost no real values on that x-y window — widen it or fix the expression.` };
    return mk({ kind, z: zExpr, fns: [], params: params.length ? params : undefined, xmin, xmax, ymin, ymax, ...axes });
  }

  const vars = ["x", ...params.map((q) => q.name)];
  const fns: GraphSpec["fns"] = [];
  for (const rf of (Array.isArray(input?.fns) ? input.fns : []).slice(0, 4)) {
    const expr = String(rf?.expr || "").trim().replace(/^y\s*=\s*/i, "").replace(/^f\(x\)\s*=\s*/i, "");
    const c = compileExpr(expr, vars);
    if ("error" in c) return { error: `ERROR: can't plot "${expr}": ${c.error}. Use plain math in x${params.length ? ` and ${params.map((q) => q.name).join(", ")}` : ""} (e.g. "2*x^2 - 3*x + 1", "sin(2x)", "sqrt(x)"). A function of TWO variables needs kind "surface".` };
    let finite = 0;
    for (let i = 0; i <= 40; i++) if (Number.isFinite(c.fn({ ...base, x: xmin + ((xmax - xmin) * i) / 40 }))) finite++;
    if (finite < 5) return { error: `ERROR: "${expr}" has no real values in x ∈ [${xmin}, ${xmax}] — widen the window or fix the expression.` };
    fns.push({ expr, label: label(rf?.label, 40), color: (GRAPH_COLORS as readonly string[]).includes(rf?.color) ? rf.color : GRAPH_COLORS[fns.length % 5], dashed: rf?.dashed === true ? true : undefined });
  }
  const points = (Array.isArray(input?.points) ? input.points : []).slice(0, 12)
    .map((pt: any) => ({ x: num(pt?.x), y: num(pt?.y), label: label(pt?.label, 30) }))
    .filter((pt: { x: number; y: number }) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (!fns.length && !points.length) return { error: "ERROR: give at least one function in `fns` or some `points`." };
  return mk({ kind: "function", fns, params: params.length ? params : undefined, xmin, xmax, ymin, ymax, points: points.length ? points : undefined, connect: input?.connect === true && points.length > 1 ? true : undefined, ...axes });
}

export const GRAPH_ON_BOARD_TOOL = {
  name: "GRAPH_ON_BOARD",
  description: "Put a REAL chart on the board that the student can play with. kind \"function\" (default): one to four functions of x, optional " +
    "sliders (up to 3) so they can drag a parameter and watch the curve change, and optional marked points (a root, " +
    "a vertex, data). Reach for this whenever a picture of a function or a data trend teaches faster than words — " +
    "parabolas and how a, b, c move them, trig amplitude/period, exponentials, transformations, a line of best fit, " +
    "motion graphs. It is fast and always renders (unlike CREATE_INTERACTIVE), so prefer it over a hand-drawn " +
    "DRAW_ON_BOARD graph. Expressions are plain math: x, the slider letters, + - * / ^, parentheses, pi, e, and " +
    "sin cos tan sqrt abs ln log exp (e.g. \"a*x^2 + b*x + c\", \"sin(k*x)\", \"2^x\"). Choose a window that shows the " +
    "interesting part. DON'T plot the exact answer to a problem the student is still working on — plot the family " +
    "or the setup and ask what they notice. Then ask ONE question about what moving it shows. Other kinds: \"bars\" " +
    "to compare quantities (a labelled bar chart), \"histogram\" for the shape of a data set (give the raw numbers), " +
    "and \"surface\" for a function of TWO variables, z = f(x, y) — a 3D plot the student drags to rotate (add sliders " +
    "to morph it).",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line titling the graph (and what to try, e.g. 'Drag a — what happens to the opening?')" },
    kind: { type: "string", enum: ["function", "bars", "histogram", "surface"], description: "function (default): curves y=f(x). bars: a labelled bar chart (needs `bars`). histogram: raw numbers binned (needs `data`). surface: a rotatable 3D plot z=f(x,y) (needs `z`, xmin/xmax AND ymin/ymax)." },
    bars: { type: "array", description: "kind bars: 2-14 items", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"] } },
    data: { type: "array", description: "kind histogram: the raw numbers (5-500)", items: { type: "number" } },
    bins: { type: "number", description: "kind histogram: bin count 2-40 (omit to auto)" },
    z: { type: "string", description: "kind surface: z as an expression in x and y (and slider letters), e.g. \"x^2 - y^2\", \"sin(x)*cos(y)\"" },
    fns: { type: "array", description: "1-4 functions of x", items: { type: "object", properties: {
      expr: { type: "string", description: "e.g. \"a*x^2 + b*x + c\"" },
      label: { type: "string", description: "short legend text, e.g. 'y = ax²+bx+c'" },
      color: { type: "string", enum: ["blue", "red", "green", "orange", "purple", "ink"] },
      dashed: { type: "boolean" },
    }, required: ["expr"] } },
    params: { type: "array", description: "optional sliders", items: { type: "object", properties: {
      name: { type: "string", description: "single letter, not x or e" }, min: { type: "number" }, max: { type: "number" }, value: { type: "number" }, step: { type: "number" }, label: { type: "string" },
    }, required: ["name", "min", "max", "value"] } },
    xmin: { type: "number" }, xmax: { type: "number" },
    ymin: { type: "number", description: "optional; omit to auto-fit" }, ymax: { type: "number" },
    points: { type: "array", description: "optional marked points / data", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, label: { type: "string" } }, required: ["x", "y"] } },
    connect: { type: "boolean", description: "join the points with a line (a data plot)" },
    xLabel: { type: "string" }, yLabel: { type: "string" },
  }, required: ["caption"] },
};

const MAX_INTERACTIVE_HTML_CHARS = 8000;

// Script sources the sandboxed iframe may load a library from — the same CDN this app's own CSP already
// whitelists for script-src (see vercel.json/server/index.ts), so nothing new is being trusted here that
// isn't already trusted for the app's own code.
const INTERACTIVE_SCRIPT_ALLOWLIST = ["https://cdn.jsdelivr.net/", "https://cdnjs.cloudflare.com/"];

/** Strips anything out of an AI-authored interactive scene that shouldn't be there: a <script src> NOT
 *  pointing at the allowlisted CDNs (any other source is dropped — the tag itself removed, not just its
 *  src, since a scriptless <script> tag serves no purpose), and any nested <iframe>/<object>/<embed> tag
 *  outright (defense in depth — the outer sandbox already blocks most of what those could do, but there's
 *  no reason to let the model try). Regex-based, same posture as stripLeakedToolCallSyntax elsewhere in
 *  this file — simple and defensive, not a full HTML parser (this content runs same-origin-less in a
 *  sandboxed iframe either way, so a parser-evasion edge case here is not a privilege escalation). */
function sanitizeInteractiveHtml(html: string): string {
  return html
    .replace(/<iframe\b[\s\S]*?<\/iframe>|<iframe\b[^>]*\/?>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']*)["']([^>]*)>\s*<\/script>/gi, (whole, _pre, src) =>
      INTERACTIVE_SCRIPT_ALLOWLIST.some((p) => src.startsWith(p)) ? whole : "");
}

/** The CSP served WITH an interactive scene (see /api/interactive in server/index.ts) — deliberately its
 *  own, much tighter policy than the app's: no default-src at all, scripts only inline (the scene IS inline
 *  code) plus the two allowlisted CDNs, and `connect-src 'none'` so a scene can't call anything out. This
 *  is also the reason the scene is served from its own route instead of an iframe `srcdoc`: a srcdoc frame
 *  INHERITS the embedding document's CSP, and the app's policy has no 'unsafe-inline' in script-src, so
 *  every scene's script — the model's and our own guard alike — was silently blocked and the frame rendered
 *  blank. A real same-origin navigation gets its own policy from these response headers instead. */
export const INTERACTIVE_SCENE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "script-src-elem 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** Wraps a validated scene's HTML into the full document actually served to the iframe. Everything outside
 *  `${html}` is OURS, not the model's: a minimal reset, and a guard that makes a failed or empty scene say
 *  so rather than render as a blank box (direct instruction — "make sure artifacts aren't blank"). The
 *  parent can't detect blankness from outside: the frame is sandboxed with no allow-same-origin, so its DOM
 *  is unreachable. Hence the check lives inside the frame. */
export function interactiveSceneDocument(html: string): string {
  const guard =
    `(function(){var F=function(msg){try{var d=document.getElementById('__otto_fallback');if(!d)return;` +
    `d.style.display='flex';var m=document.getElementById('__otto_fallback_msg');if(m&&msg)m.textContent=msg;}catch(e){}};` +
    `window.addEventListener('error',function(e){F(e&&e.message?String(e.message).slice(0,160):'');},true);` +
    `window.addEventListener('unhandledrejection',function(){F('');});` +
    `window.addEventListener('load',function(){setTimeout(function(){try{` +
    `var drawn=document.querySelector('canvas,svg,img,video');` +
    `var painted=drawn&&drawn.getBoundingClientRect().height>8;` +
    `var text=(document.body.innerText||'').replace(/\\s+/g,' ').trim();` +
    `var own=document.getElementById('__otto_fallback');` +
    `var ownText=own?(own.innerText||'').replace(/\\s+/g,' ').trim():'';` +
    `if(!painted&&text.replace(ownText,'').length<2)F('');}catch(e){}},1500);});})();`;
  const fallback =
    `<div id="__otto_fallback" style="display:none;position:absolute;inset:0;align-items:center;` +
    `justify-content:center;flex-direction:column;gap:6px;text-align:center;padding:16px;` +
    `font:13px/1.5 system-ui,sans-serif;color:#71717A;background:#F4F4F5;">` +
    `<div style="font-weight:600;color:#18181B;">This interactive didn't load</div>` +
    `<div id="__otto_fallback_msg"></div>` +
    `<div style="font-size:12px;">Ask Otto to explain it in the chat instead.</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<style>html,body{margin:0;padding:8px;box-sizing:border-box;font-family:system-ui,sans-serif;` +
    `overflow:hidden;position:relative;height:100%;}*{box-sizing:border-box;}</style>` +
    `<script>${guard}</` + `script></head><body>${html}${fallback}</body></html>`;
}

export function makeInteractiveEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const rawHtml = String(input?.html || "").trim();
  if (!rawHtml) return { error: "ERROR: html cannot be empty." };
  if (rawHtml.length > MAX_INTERACTIVE_HTML_CHARS) return { error: `REJECTED: max ${MAX_INTERACTIVE_HTML_CHARS} characters — simplify the scene.` };
  const html = sanitizeInteractiveHtml(rawHtml);
  return { entry: { id: randomUUID(), text: caption, kind: "interactive", html, at: new Date().toISOString() } };
}
