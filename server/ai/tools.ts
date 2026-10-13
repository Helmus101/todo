
import { randomUUID } from "node:crypto";
import type { BoardEntry } from "../../shared/types.ts";
import { evaluateArithmetic } from "../arithmetic.ts";
import { normalizeWidget, WIDGET_TYPES } from "../../shared/widgets.ts";
import { normalizeFlow } from "../../shared/flow.ts";
import { sanitizeSvg, MAX_SVG_CHARS } from "../../shared/svgSafe.ts";
import { webSearch, readPage } from "../websearch";


// Shared web-search tool for the task agents — gives generation + execution the power to "look it up",
// so planning or doing a task can pull in external context (a person, a deadline, a how-to, a link).
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the web for current or background facts you can't get from the connected apps — a person/company, a deadline or figure, how to do something, a reference link, a worked example, past-paper style questions. Returns top results (title, url, snippet). Write a SPECIFIC query (include the subject, level and exact topic, e.g. 'IB Math AA HL integration by parts worked example'), not a vague one; if the snippets don't answer it, call read_page on the best result instead of guessing. Optional `domains` restricts results to those sites (e.g. [\"khanacademy.org\"]).",
  input_schema: { type: "object", properties: {
    query: { type: "string", description: "the search query" },
    domains: { type: "array", items: { type: "string" }, description: "optional: only return results from these sites, e.g. [\"collegeboard.org\"]" },
  }, required: ["query"] },
};

export const READ_PAGE_TOOL = {
  name: "read_page",
  description: "Read the text of ONE web page (a result from web_search) when its snippet isn't enough — to check a fact, find a worked example or pull the real wording. Returns up to ~5000 characters of plain text, or an empty string if the page is unreadable (then say so and rely on the snippet or your own knowledge). Only pass a url that web_search returned or the student gave you.",
  input_schema: { type: "object", properties: { url: { type: "string", description: "the https url to read" } }, required: ["url"] },
};

export async function runWebSearch(input: any): Promise<string> {
  const q = String(input?.query || "").trim();
  if (!q) return "[]";
  const domains = (Array.isArray(input?.domains) ? input.domains : []).map((d: unknown) => String(d || "").trim()).filter((d: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)).slice(0, 6);
  return JSON.stringify((await webSearch(q, { domains })).slice(0, 6));
}

export async function runReadPage(input: any): Promise<string> {
  const url = String(input?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "ERROR: url must be an http(s) address from a search result.";
  const text = await readPage(url, 5000);
  return text || "EMPTY: that page couldn't be read (login wall, PDF, or blocked). Use the search snippet or your own knowledge, and say which.";
}

// The tutor's deterministic calculator (server/arithmetic.ts — the same evaluator the post-reply
// verifier and the client's double-check affordance use, so there is exactly ONE arithmetic oracle
// in the app). The model's mental arithmetic is the single most common factual error a tutor makes;
// this gives it a way to be right instead of careful. In both tool arrays below — canvas mode too:
// checking a number has nothing to do with one-problem-at-a-time pacing.
export const CREATE_CALC_TOOL = {
  name: "CREATE_CALC",
  description: "Evaluate an arithmetic expression with a real calculator — exact, deterministic. USE IT instead of mental arithmetic whenever you compute or double-check a number for the student (a product, a sum, a quotient); if your mental result and the calculator disagree, the calculator wins — never argue with it. Also use it to CHECK the student's own arithmetic before you confirm it. Supports integers/decimals, + - × ÷ (* or /), parentheses, unary minus, and EN (1,234.5) or FR (1 234,5) number forms. NOT algebra (letters like 2x), no exponents (^), no percentages-as-percentages — those return an error: don't retry them here, handle them in chat by reasoning (or rewrite as pure arithmetic, e.g. 0.25 × 80).",
  input_schema: { type: "object", properties: { expression: { type: "string", description: "the arithmetic expression, e.g. '3 × 47' or '(12 + 8) / 4' or '2,5 + 1'" } }, required: ["expression"] },
};

/** The handler behind CREATE_CALC — exported so tests exercise the exact code the tool loop runs. */
export function runCalcTool(input: any): string {
  const expression = String(input?.expression || "").trim();
  if (!expression) return "ERROR: no expression given.";
  if (expression.length > 200) return "ERROR: expression too long.";
  const value = evaluateArithmetic(expression);
  if (value == null) {
    return "ERROR: that expression isn't in the supported subset (integers/decimals, + - × ÷, parentheses; EN 1,234.5 or FR 1 234,5 numbers; no algebra letters, no ^). Handle it in chat by reasoning, or rewrite it as pure arithmetic (e.g. 0.25 × 80).";
  }
  return JSON.stringify({ ok: true, expression, result: value });
}

// A short in-app brief attached directly to the task — no account, no OAuth, no approval, never leaves
// Otto's own storage. This is the default for a short study aid (a checklist, a quick reference, a small
// outline); reserve an actual GOOGLEDOCS/SHEETS/SLIDES document for something that's genuinely long-form
// or needs to leave the app (shared/emailed/edited elsewhere).
/** The voice of every brief: straight to the point, critical, no padding. Short on purpose — it rides on every tool call. */
export const BRIEF_STYLE = "STYLE: direct and critical, zero filler. Open with the point itself — no greeting, no 'this brief covers', no restating the task, no encouragement. Short declarative lines. Name what students get wrong (the traps and common errors), give the test of whether they truly understand it, and end on what to do next. Every line must be a fact, a rule, a trap or an action — cut the rest. About 150 words unless the task truly needs more.";

export const CREATE_NOTE_TOOL = {
  name: "CREATE_NOTE",
  description: "Create a SHORT in-app brief/note attached to this task — a quick checklist, reference sheet, or outline the student opens in a popup right on the card. No account, no approval, nothing external. Use this by default for anything short; only create a real Google Doc/Sheet/Slides when the content is genuinely long-form or needs to leave the app. " + BRIEF_STYLE,
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Fiche de révision — Suites numériques'" },
    body: { type: "string", description: "the real content, STRICTLY SCOPED TO THIS TASK — reported live: a 'plan a birthday gift' brief included a checklist item to 'check Pronote for the Russia/USSR History test,' an entirely unrelated subject pulled in from ambient calendar/workload context. Other things going on (a different subject's test, another task's deadline) can justify a scheduling choice IN this content ('do this on the 7th, not test-eve') but must never appear as their own fact/item/checklist entry — if it's not about THIS task's own subject, it doesn't belong in the body at all. In markdown (headings, **bold**, bullet/numbered lists, and a GFM pipe table — `| col | col |` with a `|---|---|` separator row — when the content is naturally tabular, e.g. a timing/schedule breakdown) — this IS the brief, not a placeholder. Be concise throughout: short lines, no padding, no restating the task title/why back at the student, no filler sentences before getting to substance — every line should earn its place. Most briefs should read in under a minute (roughly 100-200 words, or a short table) — a brief that runs long is usually restating things the student already knows or padding a thin point with extra sentences; if the genuinely necessary content is longer than that (a real multi-part checklist, a full itinerary), let it run, but never pad TOWARD a length. If you make a table, every cell must actually be filled in with real content — NEVER leave a column blank/empty for the student to fill in later (e.g. a 'your own example' or 'your answer' column with nothing in it); a note is something the student reads, not a form they complete, so either fill every cell yourself with a genuine, specific answer or drop that column entirely. This includes the case where the source material needed to fill a row (an extract/text you don't actually have) is missing — do NOT publish an empty template grid with blank rows waiting for it; state in one line what's missing and skip the table entirely, then send the actual filled table in a follow-up once you have the real content. NEVER include a markdown link whose URL you made up (this app has no domain of its own for notes/tasks — a link like otto.ai/... or similar is always fabricated, never real) — only ever a URL copied verbatim from an actual source (a task's own link/attachment, or a real web_search result). Plain text with no link is always fine when you don't have a real one." },
  }, required: ["title", "body"] },
};

// A drillable flashcard deck attached to the task — for vocab/definitions/formulas/concept review, where
// testing yourself front→back beats reading a written guide. Same no-account/no-approval model as notes.
// Kept DELIBERATELY SHORT — this full description (plus CREATE_QUIZ_TOOL's own) is resent on EVERY round
// of EVERY task run and chat turn app-wide, whether flashcards are relevant to that task or not (tool
// schemas are part of every request in a tool-calling loop, not a one-time cost). An earlier version of
// this grew to ~2000 characters across several rounds of "make the cards better" edits — genuinely better
// guidance, but a real, silent latency/cost tax on every single agent run and chat message in the whole
// app, not just the one place that guidance mattered. Detailed card-quality rules (one-idea-per-card, front
// never leaking the answer, back length matching content, STEM practice problems) live in CARD_STYLE_RULE
// (used by the Study Journal's dedicated generators, which are NOT a shared hot-path tool list) — this tool
// gets the short version.
export const CREATE_FLASHCARDS_TOOL = {
  name: "CREATE_FLASHCARDS",
  description: "Create an in-app flashcard deck attached to this task — for drilling vocabulary, definitions, formulas, dates, or any front→back recall. Use this INSTEAD OF CREATE_NOTE for discrete facts to memorize, not a checklist. SCOPE: only content THIS student is actually expected to know for this course at their level — what the assignment/material names, or the core notions of the topic; never adjacent, advanced, or obscure detail their teacher wouldn't test. A card they can't answer because it was never part of their course reads as a gap that isn't one. NEVER make cards about the assessment itself — how many parts/sections an exam has, how many marks a part is worth, what format/timing it follows, what to bring, logistics. Reported live: a deck for an Economics test opened with 'Paper 1 has two parts. What is each one asking for, and how many marks?' — that's exam trivia, not economics; every card must test the SUBJECT-MATTER CONCEPTS AND KNOWLEDGE the exam covers (definitions, mechanisms, relationships, applications), never the exam's own structure. If the context lists cards the student marked as 'not something I need to learn', never make cards on those or similar content. CRITICAL: ALWAYS BASE FLASHCARDS ON THE STUDENT'S JOURNAL FIRST. Check the 'THEIR RECENT STUDY JOURNAL' section in the context — if it exists and mentions this subject/topic, ALL cards must be drawn from what the student has explicitly studied and written about in their journal. ONLY use broader curriculum material if: (1) the journal is completely empty, OR (2) the journal has no entries related to this subject/topic at all. Never guess or assume what they're studying — if you don't see it in their journal, don't make cards about it unless the journal is truly empty. LANGUAGE MATCHING: If the journal entry is in French, the flashcard must be in French. If it's in English, the flashcard must be in English. A single deck can mix languages (e.g., French history cards alongside English science cards) ONLY if the student's journal entries themselves mix languages — match the language of each specific journal section, not force everything into one language.",
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Vocabulaire — Chapitre 4'" },
    cards: {
      type: "array",
      description: "~25 by default, adapted to the task; if the student named a number, make exactly that (max 50/call — a hard token-budget ceiling, tell them if they asked for more). ONE RETRIEVABLE UNIT per card, not merely 'one idea' — split multi-fact answers into separate cards, and split a broad question ('what caused the French Revolution?') into several narrow ones (one per cause), not one card with an everything-back. TEST RETRIEVAL, NOT RECOGNITION: a front the student can answer by pattern-matching a memorized definition's shape ('what is the definition of X?') is weaker than one requiring them to reconstruct or apply the concept ('what do you give up when you choose option A over B?', or a concrete scenario that requires identifying X). VARY RETRIEVAL DIRECTION when it strengthens a likely weak spot — not mechanically every direction for every card, but deliberately mix some of: term→definition, definition→term, example→concept, concept→example, cause→consequence, consequence→cause, situation→formula, formula→meaning/application. A deck that's 100% 'term→definition' only ever tests recognition in one direction. Front: specific, names the subject, never states the answer/date being tested. Back: length matches what's needed — short for a plain fact, a sentence or two when context makes it stick; never padded either way. Own wording, not verbatim. For math/physics/chemistry, include real practice problems (not just recall) with a worked step-by-step back. IF THE PROMPT'S CONTEXT SHOWS A RECURRING CONFUSION (past mistakes logged, a card still shaky after repeated review) between two specific things — don't just make another plain definition card for either one; make a CONTRAST/DISCRIMINATION card that forces distinguishing them (e.g. not another 'what is marginal cost?' but 'a firm's average cost is falling while marginal cost is above it — what does that mean is about to happen to average cost?'). A repeated identical-shape card doesn't fix a confusion; a card that forces the distinction does.",
      items: { type: "object", properties: {
        front: { type: "string", description: "the prompt — never leak the answer/a giveaway. Each card a genuinely distinct fact/problem." },
        back: { type: "string", description: "the answer — detailed enough to teach, not padded; full worked solution for a practice problem." },
      }, required: ["front", "back"] },
    },
  }, required: ["title", "cards"] },
};

// An in-app multiple-choice quiz. Distinct purpose from a deck: a deck drills recall, a quiz makes the
// student DISCRIMINATE between plausible answers, which is what actually exposes a shaky notion.
export const CREATE_QUIZ_TOOL = {
  name: "CREATE_QUIZ",
  description: "Create an in-app multiple-choice quiz attached to this task — the student answers each question, gets immediate feedback with a one-line explanation, and a score at the end. Use this to CHECK UNDERSTANDING before a contrôle (which parts of the chapter aren't solid), where CREATE_FLASHCARDS is for drilling raw recall. NEVER turn the student's OWN assigned exercise into a quiz — write NEW questions on the same notion. MATCH THE REAL EXAM'S SHAPE, not a generic quiz — see the IB/AP/SAT/ACT question-format guidance above (examStyleLine) for the student's actual program/exam and follow IT, including option count (each question's own `options` field below says what that means).",
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Quiz — Mécanique du point'" },
    questions: {
      type: "array",
      description: "Around 8-12 by default when the student didn't name a number, adapted to the actual task (a single short notion needs fewer, a whole chapter needs more) and to the student (more if they're stress-testing understanding before a contrôle, fewer for a quick check). If the student named a SPECIFIC number, make exactly that many, up to 50 IN THIS ONE CALL — 50 is a hard technical ceiling (this single reply's token budget), not a product opinion, so never attempt more than 50 in one call no matter how high the student's number is. If they asked for more than 50, make exactly 50 now, say plainly in your reply that this is the first 50 of the N they asked for, and offer to make the rest in a follow-up message — never silently hand back a smaller quiz with no explanation. On subject matter: never placeholders, never the student's own assigned exercise reworded. WRITE THESE LIKE THE REAL THING, not generic trivia: match the phrasing, question types, and rigor of an actual contrôle/bac/IB paper for this subject and level (see VOCABULARY/track above for which) — a maths question should require the same steps a real exam question would, a history question should ask for analysis/argument the way a real dissertation prompt does, not just a fact lookup, unless the notion genuinely IS a fact lookup. Calibrate difficulty to THIS student: if their profile shows a grade for this subject, weak (well below the class/scale norm) means start with more foundational/scaffolded questions before harder ones; strong means skip the easy ones and go straight to exam-level rigor. No signal either way → assume mid-level exam difficulty, not a beginner quiz.",
      items: { type: "object", properties: {
        q: { type: "string", description: "the question — one clear sentence. Every question in this quiz must test a DIFFERENT sub-notion, formula, or skill — never two questions that are really the same question with the numbers/wording swapped (e.g. two separate 'solve for x' questions using the same technique on a trivially different equation). If the topic only genuinely supports fewer distinct angles than the requested count, make FEWER questions rather than pad with near-duplicates — a shorter quiz of all-distinct questions beats a longer one with repeats." },
        options: { type: "array", description: "3-4 answer options by default; EXACTLY 5 (lettered A-E in substance, though the UI numbers them) for an AP-track student — see the AP block above, College Board MCQs are always 5-option, never 4. EXACTLY ONE is correct either way; the wrong ones must be genuinely plausible (a common misconception, an off-by-one, the right idea applied to the wrong case). An obviously-silly option teaches nothing.", items: { type: "string" } },
        correct: { type: "number", description: "0-based index into options of the CORRECT one" },
        why: { type: "string", description: "one line on why that answer is right — this is what makes the quiz teach instead of just score" },
      }, required: ["q", "options", "correct"] },
    },
  }, required: ["title", "questions"] },
};

export const CREATE_PROBLEM_TOOL = {
  name: "CREATE_PROBLEM",
  description: "MIX THE FORMATS: roughly one exercise in three should be MULTIPLE CHOICE (options + correct index) — conceptual \"which statement is true\", naming the law / unit / process, spotting the error in a worked line, or a calculation whose wrong options are the genuine common mistakes; use free-response for a computation where the number itself is the point (then its answer is a bare number, no units). Create ONE standalone practice problem displayed INLINE in the chat itself (not a chip that opens elsewhere) — the student answers right there in the thread and you help them through it. Use this when a single focused exercise is the best way to help (a quick check, a worked example to try, a 'try this one' moment), where CREATE_QUIZ would be a whole set. THINK OF THIS AS A MEASUREMENT, NOT JUST PRACTICE: before writing it, be clear what uncertainty about THIS student you're actually trying to resolve right now — do they have the concept or did they just memorize a formula's shape? is the error a slip or a real misconception? can they apply it to a new case, not just the one you walked through? Pick the smallest problem that would tell them (and you) apart between those possibilities, rather than a generic 'another one of the same'. Can be multiple-choice (give options + correct index) or free-response (give an answer string). NEVER use the student's OWN assigned exercise — write a NEW problem on the same notion. Include a one-line 'why' explanation (shown after they answer) and optionally a hint. MATCH THE REAL EXAM'S SHAPE — see the IB/AP/SAT/ACT guidance above (examStyleLine): an IB extended-response or AP FRQ is free-response mode with the FULL multi-part prompt (lettered (a), (b), (c)..., each part's point value stated) written straight into `question` as one structured block — this tool's single-answer-string grading then applies to the FINAL part only; walk the earlier parts with them in chat rather than silently grading only the last line with no comment on the rest. `answer` MUST be the FINAL lettered part's value ONLY, never an earlier part's — even though an earlier part's value is itself a complete, correct answer to ITS OWN question. Concretely, for '(a) find cos θ [2]  (b) hence find cos 2θ [2]', `answer` is the (b) value (e.g. '7/25'), NEVER the (a) value (e.g. '-4/5') — setting it to the earlier part means the widget marks the WHOLE problem solved, and reveals `why` (which should explain the FULL chain, both parts), the instant the student states only the easier first part, before they've done the part that's actually testing them.",
  input_schema: { type: "object", properties: {
    question: { type: "string", description: "the question/prompt — math in LaTeX between $…$ (it is typeset for the student) — one clear sentence, OR a full multi-part structured prompt (IB/AP extended-response/FRQ style — lettered sub-parts with their own point values) when the student's program calls for one. Match the phrasing, format, and rigor of an actual exam/contrôle question for this subject and level (see VOCABULARY/track/exam-style above), not generic trivia." },
    options: { type: "array", description: "MCQ mode: 2-4 answer options by default; EXACTLY 5 for an AP-track student (College Board MCQs are always 5-option — see the AP block above). EXACTLY ONE is correct; the wrong ones must be genuinely plausible. Omit entirely for free-response mode (this is also the mode for any IB/AP multi-part structured question — see above).", items: { type: "string" } },
    correct: { type: "number", description: "MCQ mode only: 0-based index into options of the CORRECT one" },
    check: { type: "string", description: "REQUIRED for any NUMERIC free-response answer: an arithmetic expression that computes the answer from the givens, which the app evaluates itself to verify your key — numbers, + - * / ^, parentheses, pi, sqrt/sin/cos/tan/ln/log/exp, and DEGREE trig sind/cosd/tand/asind/acosd/atand — e.g. '100/(1/tand(30) - 1/tand(50))'. If it disagrees with `answer`, the app uses ITS number. Compute it independently; do not just restate your answer." },
    answer: { type: "string", description: "Free-response mode only. A NUMERIC answer is ALWAYS a bare number — no units, no words (\"112\", never \"112 m\"); put the unit in `format` (\"answer as a number, in metres\"). The expected answer — SHORT and checkable (a number, a simple expression, a single word), checked loosely (trimmed, case-insensitive, and with a few-percent tolerance on decimal numeric answers to absorb ordinary rounding). An EXERCISE is ONLY for a question with exactly ONE correct, short answer. NEVER create one for anything open-ended (explain, why, describe, justify, prove/show that, compare, discuss, multi-part (a)(b)(c)) — ask those in the conversation. If you can't state one short answer, it is not an exercise. Omit for MCQ mode. MULTI-STEP NUMERIC PROBLEMS (physics/chem/finance): compute this value by carrying full precision through every intermediate step — NEVER round an intermediate result (an angle, a sub-total) before using it in a later step, since that can shift the final value by several percent and make a student's equally valid, less-rounded calculation get marked wrong. If a constant isn't a fixed convention (g, a rate, a density), state the exact value to use directly in `question` so every valid path converges on the same number." },
    why: { type: "string", description: "one line on why the answer is right — this is what makes the problem teach instead of just score" },
    hint: { type: "string", description: "an optional hint the student can reveal before answering" },
    sourceUrl: { type: "string", description: "ONLY when this exercise is adapted from a FIND_SOURCE_QUESTION result: that result's url, exactly. Never invent one." },
    format: { type: "string", description: "free-response mode only: guidance on expected format/units/notation — for ANY numeric answer you MUST state the precision (\"to 1 decimal place\", \"to 3 significant figures\", \"to the nearest whole number\") and the unit (e.g. 'to two decimal places, in m/s'); if you omit the precision the app adds one. NEVER use the real answer as an example — use a placeholder ('x = a') or a different value." },
  }, required: ["question"] },
};

// Pre-built interactive ACTIVITIES — always render, themed, and report back how the student did. Prefer these over
// CREATE_INTERACTIVE (model-written HTML) whenever one fits.
export const WIDGET_ON_BOARD_TOOL = {
  name: "WIDGET_ON_BOARD",
  description: "Put a ready-made interactive activity on the board — the student DOES something instead of reading. " +
    "Types: `match` (pair 3-6 terms with their definitions/formulas/causes/translations), `order` (put 3-7 steps, events or stages in the right order — list them in the CORRECT order, the student sees them shuffled), " +
    "`sort` (drop 4-10 items into 2-4 categories — e.g. acid/base, renewable/non-renewable, primary/secondary source; category is the 0-based index), " +
    "`unit_circle` (drag the angle, watch the point and the cos/sin readout — to build intuition BEFORE asking them anything), `projectile` (angle/speed sliders and a live trajectory with range/height/time). " +
    "match/order/sort check themselves and tell you afterwards how they went, so use them to practise or check a set of facts, not to teach from zero; the explore ones (unit_circle, projectile) are for noticing a pattern — ask ONE prediction question first. " +
    "Works for ANY subject. One per turn; don't put the answer to something they're still working on in the labels.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line shown above the activity, e.g. 'Match each term to its meaning' — an instruction, never the answer" },
    type: { type: "string", enum: [...WIDGET_TYPES] },
    pairs: { type: "array", description: "match only: 3-6 {left, right}", items: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] } },
    items: { type: "array", description: "order: strings in the CORRECT order. sort: {text, category} objects.", items: {} },
    categories: { type: "array", description: "sort only: 2-4 category names", items: { type: "string" } },
    angle: { type: "number", description: "unit_circle: starting angle in degrees (0-360). projectile: launch angle (5-85)." },
    speed: { type: "number", description: "projectile only: launch speed in m/s (5-60)" },
    g: { type: "number", description: "projectile only: gravity in m/s² (default 9.8; e.g. 1.6 for the Moon)" },
  }, required: ["caption", "type"] },
};

export function makeWidgetEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const r = normalizeWidget(input);
  if ("error" in r) return r;
  return { entry: { id: randomUUID(), text: caption, kind: "widget", widget: r.widget, at: new Date().toISOString() } };
}

// Angle of elevation / depression problems (lighthouse and boats, a tower and a tree, a plane and a runway): the app
// COMPUTES the figure — the model keeps mis-placing which angle sits where — so use this instead of drawing them by hand.
export const TRIG_SCENE_ON_BOARD_TOOL = {
  name: "TRIG_SCENE_ON_BOARD",
  description: "Draw an angle-of-elevation / angle-of-depression situation CORRECTLY, to scale: a tower, cliff, lighthouse or building at the base B with top T, and one or two observers (boats, people, points) on the ground in line with it. " +
    "It marks the angle of depression at the top (measured from the horizontal) AND the equal angle of elevation at the ground (alternate angles), labels only the GIVEN values, and shows unknown lengths as letters. " +
    "USE THIS for any such problem the moment the student wants a picture (or asks you to draw it) — never hand-draw these. " +
    "mode \"depression\" (angles measured down from the top) or \"elevation\" (angles measured up from the ground). observers: 1-2 items {name, angle in degrees}. separation: distance between two observers (if given). towerHeight: the KNOWN height (e.g. the 470 m cliff). unknownTop: a letter (e.g. \"h\") when the thing to find sits ON TOP of the known height (a lighthouse on a cliff); omit it when towerHeight is the whole height. distance: base-to-observer distance for ONE observer, if given. Never reveal the unknown.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line, e.g. 'The lighthouse and the two boats'" },
    mode: { type: "string", enum: ["depression", "elevation"] },
    observers: { type: "array", description: "1-2 observers on the ground", items: { type: "object", properties: { name: { type: "string" }, angle: { type: "number" } }, required: ["angle"] } },
    separation: { type: "number" }, towerHeight: { type: "number" }, unknownTop: { type: "string" }, distance: { type: "number" },
    baseName: { type: "string" }, topName: { type: "string" }, units: { type: "string" },
  }, required: ["caption", "observers"] },
};

// 3D solids (cuboid, cube, pyramid, prism, cylinder, cone, sphere): the app COMPUTES the figure in the textbook oblique projection —
// hidden edges dashed, vertices named, only GIVEN dimensions labelled — so use this instead of hand-drawing a solid.
export const SOLID_ON_BOARD_TOOL = {
  name: "SOLID_ON_BOARD",
  description: "Draw a 3D solid correctly on the board: cuboid, cube, pyramid (square base), prism (triangular), cylinder, cone or sphere. The app computes the projection (front face true shape, depth receding up-right), draws hidden edges dashed and names the vertices (cuboid: front ABCD, back EFGH behind A,B,C,D; pyramid: base ABCD, apex E; prism: front ABC, back DEF). " +
    "Give proportions in width/height/depth (or radius) and put ONLY the values the problem GIVES (or letters for unknowns) in dims — never a value they are asked to find. highlight draws extra lines between named vertices (e.g. the space diagonal A to G, a slant height) in colour. " +
    "USE THIS for any 3D shape problem (volume, surface area, diagonals, angles between a line and a plane) the moment a picture would help or they ask for one; for 2D figures use GEOMETRY_ON_BOARD, for anything else SVG_ON_BOARD.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line, e.g. 'The cuboid ABCDEFGH'" },
    shape: { type: "string", enum: ["cuboid", "cube", "pyramid", "prism", "cylinder", "cone", "sphere"] },
    width: { type: "number" }, height: { type: "number" }, depth: { type: "number" }, radius: { type: "number" },
    dims: { type: "object", description: "labels to print: given values like '8 cm' or letters like 'h'", properties: { width: { type: "string" }, height: { type: "string" }, depth: { type: "string" }, radius: { type: "string" } } },
    labels: { type: "boolean", description: "name the vertices (default true)" },
    highlight: { type: "array", description: "up to 3 lines between named vertices", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" }, dashed: { type: "boolean" } }, required: ["from", "to"] } },
  }, required: ["caption", "shape"] },
};

// The tutor's general drawing tool: it WRITES SVG, exactly the way Claude and ChatGPT draw diagrams. A model is far better at
// composing a complete, well-labelled SVG than at emitting a list of shape ops with hand-picked coordinates. The app
// sanitises it (shared/svgSafe.ts) and renders it inline, themed to the board. No KaTeX anywhere in a figure.
export const SVG_ON_BOARD_TOOL = {
  name: "SVG_ON_BOARD",
  description: "Draw ONE clear diagram on the board by writing SVG yourself — free-body diagrams, labelled geometry sketches, circuits, number lines, molecules, apparatus, maps, anatomy, supply-and-demand curves, annotated figures, anything spatial. " +
    "Write a COMPLETE, self-contained `<svg viewBox=\"0 0 800 500\">…</svg>` (no width/height). Rules for a figure a student can actually read: " +
    "(1) PLAN the layout first — keep everything inside the viewBox with 40px margins, one clear focal shape, generous spacing, nothing overlapping. " +
    "(2) Use `stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\"` for lines and `fill=\"currentColor\"` for text (so it follows the board's theme); at most TWO accent colours for what you want them to notice (e.g. #2563EB, #DC2626). " +
    "(3) Draw to scale where proportions or angles matter (a 30° angle must LOOK like 30°); mark right angles with a small square and equal sides with ticks. " +
    "(4) Label EVERY point, side and angle that the question mentions, with `<text font-size=\"18\" font-family=\"Inter, system-ui, sans-serif\">` placed just off the shape — plain text and unicode only (θ ° ² √ ± → ·), NEVER LaTeX or KaTeX. " +
    "(5) Arrows: define `<marker id=\"a\" markerWidth=\"10\" markerHeight=\"10\" refX=\"8\" refY=\"5\" orient=\"auto\"><path d=\"M0,0 L10,5 L0,10 z\" fill=\"currentColor\"/></marker>` and use `marker-end=\"url(#a)\"`. " +
    "(6) Show the SETUP and GIVEN values; show unknowns as '?' or a letter — never the answer to what they're solving. " +
    "Only these elements work: svg g defs marker path line polyline polygon rect circle ellipse text tspan title desc linearGradient radialGradient stop clipPath symbol use. No <style>, scripts, images or HTML. " +
    "For boxes-and-arrows concept diagrams use FLOW_ON_BOARD, for exact triangles/circles use GEOMETRY_ON_BOARD, for function plots GRAPH_ON_BOARD. One figure per call; redraw the WHOLE figure to add to it.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line shown as the figure's title" },
    svg: { type: "string", description: "the complete <svg viewBox=\"0 0 800 500\">…</svg> markup" },
  }, required: ["caption", "svg"] },
};

export function makeSvgEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const raw = String(input?.svg || "");
  if (raw.length > MAX_SVG_CHARS * 2) return { error: `REJECTED: the SVG is too long (max ${MAX_SVG_CHARS} characters) — simplify the figure.` };
  const svg = sanitizeSvg(raw);
  if (!svg) return { error: "ERROR: that wasn't usable SVG — send ONE complete <svg viewBox=\"0 0 800 500\">…</svg> using only: svg g defs marker path line polyline polygon rect circle ellipse text tspan title desc linearGradient radialGradient stop clipPath symbol use (no style/script/image/foreignObject), under " + MAX_SVG_CHARS + " characters." };
  if (!/<(?:path|line|polyline|polygon|rect|circle|ellipse)\b/i.test(svg)) return { error: "ERROR: the SVG has no shapes — draw the figure (lines, shapes), not just text." };
  return { entry: { id: randomUUID(), text: caption, kind: "svg", svg, at: new Date().toISOString() } };
}

// Concept diagrams with AUTOMATIC layout — flowcharts, cause→effect chains, cycles, timelines, trees. The model names
// the boxes and arrows; the app lays them out (no coordinates to get wrong, no KaTeX), the way ChatGPT/Claude draw them.
export const FLOW_ON_BOARD_TOOL = {
  name: "FLOW_ON_BOARD",
  description: "Draw a CLEAR concept diagram on the board and let the app do the layout — you only list the boxes and the arrows. " +
    "type \"flow\": a process, algorithm, cause→effect chain, argument structure, classification tree or any boxes-and-arrows idea (direction TD = top-down, LR = left-to-right; use shape \"diamond\" for a yes/no decision). " +
    "type \"cycle\": a loop of stages (water/carbon/Krebs cycle, business cycle, feedback loop) — just list the stages in order. " +
    "type \"timeline\": events in order (history, a process over time) — put the date in the label, e.g. \"1917 — October Revolution\". " +
    "Use this for ANY non-geometric picture: biology/chemistry processes, history causes and sequences, economics flows, essay plans, code/algorithm steps, concept maps. " +
    "Do NOT use it for triangles/circles/angles (GEOMETRY_ON_BOARD) or function graphs (GRAPH_ON_BOARD). " +
    "Keep node labels SHORT (2-6 words, plain text — no LaTeX); 3-10 nodes; put detail in the optional `note`. Never put the answer to something they're working out in a label.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line shown as the diagram's title" },
    type: { type: "string", enum: ["flow", "cycle", "timeline"] },
    direction: { type: "string", enum: ["TD", "LR"], description: "flow only: TD (default) or LR" },
    nodes: { type: "array", description: "2-14 boxes", items: { type: "object", properties: {
      id: { type: "string", description: "short unique id used by the edges" }, label: { type: "string" }, note: { type: "string", description: "optional smaller second line" },
      shape: { type: "string", enum: ["box", "round", "diamond", "circle"] } }, required: ["id", "label"] } },
    edges: { type: "array", description: "arrows. Optional for cycle/timeline (stages are joined in order); required for flow.", items: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" }, label: { type: "string", description: "optional short text on the arrow (\"yes\", \"causes\", \"heat\")" } }, required: ["from", "to"] } },
  }, required: ["caption", "type", "nodes"] },
};

export function makeFlowEntry(input: any): { entry: BoardEntry } | { error: string } {
  const caption = String(input?.caption || "").trim().slice(0, 200);
  if (!caption) return { error: "ERROR: caption is required." };
  const r = normalizeFlow(input);
  if ("error" in r) return r;
  return { entry: { id: randomUUID(), text: caption, kind: "flow", flow: r.flow, at: new Date().toISOString() } };
}

// IB / AP students practise on registered sources (IB Documents, Revision Village, College Board AP Central).
// Offered ONLY to those programs; for everyone else exercises are generated exactly as before.
export const FIND_SOURCE_QUESTION_TOOL = {
  name: "FIND_SOURCE_QUESTION",
  description: "Look up real practice questions on the topic from the student's registered source (IB: IB Documents / Revision Village; AP: College Board AP Central). Call this ONCE, before you write an exercise, when the topic is something exam-style questions exist for. Returns up to 2 excerpts with a url. If one fits, ADAPT it into your CREATE_PROBLEM (reword and re-number it — never paste long passages verbatim) and pass its url as sourceUrl so the student gets a link to the original. If it returns nothing usable, write the exercise yourself as usual — never invent a source or a url.",
  input_schema: { type: "object", properties: { topic: { type: "string", description: "the specific topic/skill, e.g. 'integration by parts' or 'Le Chatelier equilibrium shifts'" } }, required: ["topic"] },
};

// Unlike every other CREATE_* tool here, this one is ALWAYS in the tool list — canvas mode or not (see
// the `tools` array in chatAboutTask). It's not an artifact the student opens on demand; it's a persistent
// surface Otto writes to unprompted, whenever putting something in writing genuinely helps more than just
// saying it in chat — kicking off a working session, a formula they'll need again, a running summary of
// the student's own reasoning once they've worked through something. Not scoped to practice problems.
export const WRITE_TO_BOARD_TOOL = {
  name: "WRITE_TO_BOARD",
  description: "Write ONE short entry onto the student's persistent tutor Board — a visible, always-accessible surface separate from the chat thread, NOT limited to practice problems. The board is a document being BUILT entry by entry across the session: it opens with the day's focus, collects the key definitions and formulas as they come up, credits the student's own insights, and ends with a summary of their reasoning. Each call adds ONE entry; the next thing gets its own entry later as the session moves on. ONE idea per call and no walls of PROSE — but a short multi-line block of WORKING (each line one move, the last line left as '= ?' for them to finish) IS one entry, and it is the fastest way to make the page look like the paper you'd both be writing on. What belongs here is decided by one test: would the student otherwise have to hold it in their head, or scroll back through chat to find it? (given values and the goal, a formula in play, the cases a problem splits into, a diagram, the sub-goal they're on, a key term's gloss, their own insight). Anything that fails that test stays in chat. Don't narrate that you're writing it ('let me jot that down') — just call the tool. NEVER GET AHEAD OF THE CHAT: a 'summary'/'formula'/'note' entry records a step ONLY once the student has actually said/derived it in chat THAT turn — never a later step of the SAME derivation they haven't reached yet, even symbolically with no numbers (reported live: the board already showed 'F_net down slope = mg sin25 - mg cos25 * tan20' as a finished line while the chat was still walking the student through deriving exactly that, one piece at a time — the board had done the derivation FOR them, just quietly, on a different surface than chat). If you're tempted to write the NEXT formula before asking the question that gets them there, ask the question first and write the entry after they answer it.",
  input_schema: { type: "object", properties: {
    text: { type: "string", description: "the entry itself — plain text/light markdown, ONE idea, in KEYWORDS AND STRUCTURE rather than prose: ~25 words of prose max, and fewer is better. Write the skeleton of the idea, never a restatement of what you just said in chat (a board that repeats your sentences measurably hurts learning — the redundancy effect). Annotate like handwritten notes: 'term = plain gloss' on its own line; relationships as arrows ('A --pushes--> B'); contrasts stacked with '<-' margin asides ('NOT x <- what you'd expect' / 'BUT y <- the actual point'); dash lines for anything sequential, one idea each. Anything with REAL SPATIAL POSITION — a shape, a triangle, a number line, points on axes — belongs in DRAW_ON_BOARD instead, which renders an actual figure. For kind:'outline' this is just a one-line title (the sections go in `outline` below) — for anything else, reserve a fenced ASCII block here for genuinely textual structure (a small table) where neither a real drawing nor an outline fits. ANY such ASCII sketch MUST be wrapped in a triple-backtick code fence (```\\n...\\n```) — the board renders a fenced block as monospace, preserving every space exactly as typed; UNFENCED text renders ONE LINE PER LINE as ordinary page lines — which is exactly what you want for a step-by-step derivation (each line one move), so do NOT fence working; a fence is ONLY for a shape whose exact spacing IS the content. When you write 'maths in $…$' anywhere in this entry, wrap ONLY the actual numbers/symbols — '0.05 m' or '10 N', never a surrounding phrase or whole sentence like '$under a force of 10 N$' — KaTeX renders real words as garbled, jammed-together italic letters, not prose." },
    kind: { type: "string", enum: ["note", "instruction", "given", "result", "formula", "summary", "focus", "insight", "definition", "outline", "gap"], description: "styling/role hint: 'given' for the problem's data / statement exactly as given (typeset maths in $…$); 'result' for something the STUDENT has just derived, found or confirmed that matters for the next part (an equation, a value, a simplified form — in $…$, written plain with no label or prefix, only once THEY reached it); 'focus' ONCE to open a session's document — today's arc, where you start and what you're building toward; 'instruction' for a directive to start/try something; 'definition' the first time a key term comes up — the term in **bold**, then a plain-language definition; 'formula' for a plain fact/rule worth keeping visible in words (not real math notation — for an actual expression/equation with a fraction, exponent, or root, use DRAW_ON_BOARD's 'equation' op instead, which typesets it for real instead of describing it in text); 'insight' when the STUDENT has a genuine aha in their own words — credit them by name ('Will's insight: ...'); 'summary' for a recap of the STUDENT's reasoning — it is for THEIR reasoning, never yours, and it renders like any other line: no heading, no numbering, no category — NOT the default kind: most entries are plain text ('note', 'given', 'formula', 'definition', 'result'), written as ordinary page lines, one idea per line; 'outline' for headed, bulleted structure — a timeline, the causes/effects of an event, a source's key points, an essay's section-by-section plan (REQUIRES the separate `outline` field below, with real sections and bullets — this is the DEFAULT reach for history/literature/language-arts/social-science content instead of trying to force it into a flat sentence); 'gap' for a DELIBERATELY INCOMPLETE step or equation the student must finish — the `text` contains the setup with a '?' where the answer goes (e.g. 'a = ? / m' or 'F_net = ?'), and you MUST also set `expectedAnswer` to the value the student should produce. You MUST also set `gapAction` — 2-6 words naming the SPECIFIC thing they have to do on that line (\"expand the bracket\", \"resolve into components\", \"pick the identity\") — it becomes the chip under the line (\"Your turn: expand the bracket\") so their move is named, never a generic \"finish this\". Never put the value in `gapAction`. This is the completion effect: Otto supplies the method, the student performs the final transformation. Use gaps aggressively — every worked line should end in a gap before the student fills it, rather than Otto completing every step. 'note' for anything else. Defaults to 'note' if omitted." },
    expectedAnswer: { type: "string", description: "REQUIRED when kind is 'gap', omitted otherwise. The value the student should fill in — e.g. '10/3', '4.5', 'friction'. Otto must NEVER reveal this in chat while the gap is open; the student discovers it by working through the problem." },
    gapAction: { type: "string", description: "REQUIRED when kind is 'gap', omitted otherwise. 2-6 words naming the SPECIFIC next move (the chip under the line: 'Your turn: expand the bracket'). Never the value itself, never a generic 'finish this'." },
    owner: { type: "string", enum: ["otto", "student"], description: "Who wrote this entry. 'otto' (default) for everything Otto writes. 'student' ONLY for entries transcribing the student's OWN work (their equations, their reasoning steps, their answers) — use this when you're putting their actual work onto the board so it's visually distinguishable from your scaffolding. Otto never silently rewrites or overwrites student-owned entries." },
    outline: {
      type: "array",
      description: "REQUIRED when kind is 'outline', omitted otherwise. 1-6 headed sections, each with 1-8 short bullets — e.g. for 'why did the Provisional Government fail?': [{heading: 'Kept fighting WWI', bullets: ['lost the army', 'lost the people']}, {heading: 'Lenin\\'s slogan', bullets: ['Peace, Land, Bread']}]. Bullets are KEYWORDS, same discipline as `text` above — not full sentences.",
      items: { type: "object", properties: {
        heading: { type: "string", description: "the section's short title (a cause, a date range, a source's name, an essay section like 'Thesis' or 'Counter-argument')" },
        bullets: { type: "array", items: { type: "string" }, description: "1-8 short bullet points under this heading" },
      }, required: ["heading", "bullets"] },
    },
  }, required: ["text"] },
};

// A GENUINELY interactive scene (drag/rotate/slide something to understand it), distinct from
// DRAW_ON_BOARD's static SVG figures above. Scoped to Study Mode (canvas mode) only — the regular task
// chat's popup modal is too narrow for a real embedded scene. Rendered in a sandboxed iframe with no
// allow-same-origin (BoardArtifact.tsx) — the AI-authored HTML/JS can't read this app's DOM/cookies/
// storage or navigate the parent window, the same posture this app's existing Desmos/PDF/video iframes
// already use for lower-trust embedded content. This should be RARE: most "show me a graph" asks are
// better served by DRAW_ON_BOARD's equation op or the existing Desmos button — reach for this only when
// manipulation itself is the point.
export const CREATE_INTERACTIVE_TOOL = {
  name: "CREATE_INTERACTIVE",
  description: "Embed ONE genuinely interactive scene on the board — something the student DRAGS, " +
    "ROTATES, or adjusts with a slider to understand it (a rotatable 3D solid, a spring-mass simulation, " +
    "a parametric curve with a draggable parameter). Use this ONLY when manipulation is the actual point " +
    "— if a static DRAW_ON_BOARD figure, a DRAW_ON_BOARD equation, or the student just opening Desmos " +
    "would show the same thing just as well, use one of those instead; this tool should be rare, not a " +
    "default reach for every graph. `html` is a self-contained HTML/JS BODY ONLY — no <html>/<head>/<body> " +
    "wrapper, that's added for you. You may load AT MOST ONE library via " +
    "<script src=\"https://cdn.jsdelivr.net/npm/...\"> or cdnjs.cloudflare.com — suggested: JSXGraph (dynamic geometry the student can DRAG — move a vertex and watch the angles/lengths change; cdn.jsdelivr.net/npm/jsxgraph), three.js (3D " +
    "shapes), p5.js (simulations), chart.js or plotly.js (interactive charts), jsxgraph (interactive " +
    "geometry). Any other script source gets stripped before this ever reaches the student. No network " +
    "calls beyond that one library, no forms, no navigation, no iframes of your own. Keep it small, fast, " +
    "and focused on the one manipulation that matters — this is a focused manipulative, not an app. " +
    "NEVER SHIP SOMETHING THAT CAN RENDER BLANK — a blank box teaches nothing and is worse than no scene " +
    "at all. So: (a) PREFER NO LIBRARY. Inline SVG + a few lines of plain JS, or CSS 3D transforms " +
    "(transform-style:preserve-3d + rotate3d) for a rotatable object, always render; a CDN script is one " +
    "more thing that can fail to answer. Only load a library when the scene genuinely can't be done " +
    "without it. (b) If you DO load one, guard it: check the global exists " +
    "(if (typeof THREE === 'undefined') { ...render a plain-text explanation... }) and wrap setup in " +
    "try/catch, since WebGL in particular may be unavailable. (c) Draw something visible on the FIRST " +
    "frame, before any interaction — never an empty canvas waiting for a click or a timer. (d) Label the " +
    "scene's parts in the scene itself, so it still teaches even if interaction never happens.",
  input_schema: { type: "object", properties: {
    caption: { type: "string", description: "one short line describing the scene, shown as its title on the board" },
    html: { type: "string", description: "self-contained HTML/JS body implementing the scene — see the rules above" },
  }, required: ["caption", "html"] },
};

// Replaces the WHOLE objectives list every call (like WRITE_TO_BOARD's kind:"focus", but structured and
// checkable instead of one sentence). Called once when a session settles on today's topic (3-6 objectives),
// and again — passing the SAME list back with `done` flags updated — the moment the student demonstrates one,
// so the checklist reflects Otto's current read of progress rather than staying frozen at session start.
export const SET_OBJECTIVES_TOOL = {
  name: "SET_OBJECTIVES",
  description: "Set or update today's session learning objectives — a short checklist shown to the student (distinct from the single WRITE_TO_BOARD focus entry, which is one sentence of narrative framing, not a checklist). Call it ONCE early in a session, right after you and the student have settled on today's topic, with 3-6 concrete objectives phrased as skills/understanding to demonstrate (e.g. 'Explaining the collapse of tsarism in 1917', 'Comparing War Communism and the New Economic Policy') — not vague topic labels ('The Russian Revolution'). Call it AGAIN, passing the FULL list back with `done` flipped to true on whichever objective the student just actually demonstrated (through their own explanation, not just by being told the answer) — never remove or reorder objectives the student hasn't finished, and never mark one done on a guess or a lucky MCQ click alone. Don't call this mid-thought for every tiny sub-point — only for the real, session-defining objectives.",
  input_schema: { type: "object", properties: {
    objectives: {
      type: "array",
      description: "the FULL current list (not a delta) — 3-5 items, each a condensed checklist label of at most 6 words (e.g. 'Expand logs with the 3 laws').",
      items: { type: "object", properties: {
        label: { type: "string", description: "the objective itself, exam-skill-phrased ('Evaluating X', 'Comparing Y and Z', 'Explaining why...')" },
        done: { type: "boolean", description: "true once the student has actually demonstrated this, false otherwise" },
      }, required: ["label", "done"] },
    },
  }, required: ["objectives"] },
};
