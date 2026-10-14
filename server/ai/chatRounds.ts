import { randomUUID } from "node:crypto";
import type { Profile, BoardEntry } from "../../shared/types.ts";
import { studentProblemStatement, cleanToPost, posesProblemInProse, echoesStudentWords, repairLatex, latexifyBoardLine, statesOwnMath, startsNewProblem, looksLikeGivensOrScenario, NO_UNPROMPTED_EXERCISE, asksForProblem, asksWhichProblem, isBoardContent, splitBoardContent, asksWhy, ignoresWhy, statesOwnAnswer, namesExactStep, bubbleDoesMath, bareMath, boardRepeatsMishearing, boardCoversStatement, asksToDraw, praisesNothing, praiseUngrounded, confirmsUnchecked, wrapsUpUnasked, blamesWidget, misattributes, methodAhead, wantsHelp, clarificationTerm, ignoresQuestion, ignoresWork, asksToWrite, arithmeticAhead, equationAhead, inventedNumbers, isDrawingTurn, drawingLooksSpatial, pendingCaseTraps, closesWithMissedCase, handsOverCalculation, repeatsRecentReply, harshOpener, boardStatesAskedValue, needsQuestion, replyStatesValue, studentStatedAnswer, traceAheadOfStudent, stuckStreak, asksToMoveOn, repeatsRecentQuestion } from "../tutorAdapt.ts";
import type { AgentTools } from "../integrations.ts";
import { findArithmeticClaims } from "../arithmetic.ts";
import { questionAhead } from "../../shared/equationsAhead.ts";
import { buildTrigScene } from "../../shared/trigScene.ts";
import { buildSolid } from "../../shared/solid3d.ts";
import { type SpokenRepair } from "../../shared/spokenMath.ts";
import { sanitizeSvg, svgText } from "../../shared/svgSafe.ts";
import { findSourceQuestions } from "../questionSources.ts";
import { extractPlan, validatePlan } from "../tutorBrain.ts";
import { citesMissingBoardLine } from "../../shared/boardLines.ts";
import { OUT, countWords, createTutorChat, rewriteReply, detectLang, parseToolArgs, retryRequest, stripLeakedToolCallSyntax, stripWrapperTags, tightenForChat, truncateCleanly, untrustedToolResult, usageOf } from "./client.ts";
import { isDuplicateBoardEntry, isDuplicateDiagram, isDuplicateProblem, isSubstantiveStep, leaksAnyProblemAnswer, makeBoardEntry, makeDeck, makeDiagramEntry, makeGeometryEntry, makeGraphEntry, makeInteractiveEntry, makeNote, makeObjectives, makeProblem, makeQuiz, resolveBoardTarget, shouldNudgeBoardContent, shouldNudgeBoardWrite } from "./board.ts";
import { CREATE_FLASHCARDS_TOOL, CREATE_NOTE_TOOL, CREATE_QUIZ_TOOL, makeFlowEntry, makeTableEntry, makeSourceEntry, makeSvgEntry, makeWidgetEntry, runCalcTool, runReadPage, runWebSearch } from "./tools.ts";
import { applyRememberFact } from "./run.ts";
import { ChatHistory, ChatOptions, ChatResult, ChatTask } from "./chatTypes.ts";

// Same integrity line runTask() enforces on itself — a coaching reply must never cross into doing the
// student's actual work either (a student stuck on an essay could easily ask the chat to "just write the
// intro paragraph for me", which is exactly the failure mode this guards against).
// Both languages — the app defaults to FRENCH, so an English-only guard left the actual default path
// unprotected ("Voici l'introduction :" would have sailed straight through).
// "corrigé" ends the noun list with a trailing \b — but JS's \b is ASCII-only ([A-Za-z0-9_]), so `corrigé\b`
// silently NEVER matches: "é" isn't a "word" char to \b, and neither is the space/punctuation after it, so
// no boundary exists between them. Confirmed live via this regex's own test (tests/run.mjs) — "Voici le
// corrigé" slipped straight through the guardrail. Fixed with a lookahead instead of \b for that one word;
// every other noun in the list ends in a plain ASCII letter and is unaffected.
export const CHAT_DOES_WORK = /\bhere('s| is)?\s+(the|your|an?)\s+(essay|paragraph|answer|solution|response)\b|\bwrote (?:it|the|your) (essay|paragraph|answer|solution)\b|\bvoici\s+(?:donc\s+)?(?:l['’]|la |le |ta |ton |une |un )?(introduction|conclusion|dissertation|paragraphe|réponse|solution|traduction|rédaction)\b|\bvoici\s+(?:donc\s+)?(?:l['’]|la |le |ta |ton |une |un )?corrigé(?![a-zà-öø-ÿ])|\bje (?:l['’]ai|t['’]ai) (?:rédigé|écrit)\b/i;

// Distinct from CHAT_DOES_WORK above: that one catches Otto handing over WRITTEN WORK ("here's the essay");
// this one catches Otto directly ANNOUNCING A CONCLUSION — the exact thing rule 3 ("HAND BACK THE THINKING
// — NEVER STATE THE CONCLUSION YOURSELF") is prompt-only about today, with no code-level backstop if the
// model caves under repeated pressure. Deliberately scoped to "answer-announcing" sentence shapes only
// ("the answer is…", "so it's option D…", "la réponse est…") rather than any sentence containing a number
// or letter, which would false-positive on completely ordinary tutoring text ("that's the same rule we used
// on step 3"). Same EN+FR construction as CHAT_DOES_WORK/DOES_STUDENT_WORK, exported for test pinning.
// The letter+dash+confirmation alternative (`\b[a-d]\s*[-—]\s*(?:yes|correct|right)\b`) catches a SHORTER
// reveal shape missed by the phrase-matches above: reported live, a reply like "B — yes." confirmed the
// correct MCQ option without ever saying "the answer is" or "it's option B" — same violation, different
// words. Anchored to a standalone letter directly followed by a dash and a confirmation word (not just any
// sentence with a letter near "yes"), so it won't false-positive on ordinary prose like "a — yes, that's
// one way to start" being extremely unlikely phrasing in normal tutoring text.
export const CHAT_STATES_ANSWER = /\bthe (?:correct |final )?answer is\b|\bthat means the answer is\b|\bso it'?s option [a-d]\b|\bthe correct option is\b|\b[a-d]\s*[-—]\s*(?:yes|correct|right)\b|\bla (?:bonne )?réponse est\b|\bc'est donc (?:la réponse|l['’]option [a-d])\b|\bdonc c'est l['’]option [a-d]\b|\b[a-d]\s*[-—]\s*(?:oui|exact|c'est (?:ça|exact))\b/i;

// Otto pointing the student at something VISIBLE — the board, the canvas, "just above", "on your screen".
// Reported live, verbatim: "My bad — the problem didn't actually load that time. It's on your screen now,
// just above." …with nothing on the board at all, because the model narrated writing something it never
// actually wrote. Prompt rules alone can't catch this (the model believes it did it), so the chat loop
// treats a match with an empty board/problems list as a correction trigger — see its use in runRounds.
// Scoped to explicit "look over there" phrasings in EN+FR; an ordinary "above" inside a sentence about
// maths ("the term above the line") shouldn't fire, hence the required board/screen/canvas anchor words or
// the "just/right above" adverb pair. Exported for test pinning, same as the guardrails above.
export const CHAT_CLAIMS_BOARD = /\b(?:on|to) (?:the|your) (?:board|canvas|screen)\b|\bon screen\b|\b(?:just|right) above\b|\bau tableau\b|\bsur (?:le|ton) tableau\b|\bsur ton écran\b|\bà l['’]écran\b|\bjuste au-dessus\b|\bci-dessus\b/i;

// Narrower companion to CHAT_CLAIMS_BOARD: catches "the graph/diagram/figure I drew/sketched" even in a
// sentence that doesn't use a board/screen anchor word (CHAT_CLAIMS_BOARD's own required-anchor scoping
// would miss it) — the correction loop in runRounds uses this to require a real diagram-kind entry
// specifically, not just any board write, since a text note doesn't make a claimed drawing true.
// NOTE on the French branches below: they deliberately end in a lookahead `(?![a-zà-öø-ÿ])` rather than `\b`
// — JS's `\b` is ASCII-only ("word" = [A-Za-z0-9_]), so a plain `\bdessiné\b` silently NEVER matches (the
// boundary check fails right after the accented "é", since neither "é" nor the following space count as
// "word" chars to `\b`, so no boundary exists between them). Caught by this regex's own test in
// tests/run.mjs — a real bug, not a hypothetical one. `drew`/`sketched`/`dessine`/`trace` above are unaffected
// since they end in plain ASCII letters.
export const CHAT_CLAIMS_DIAGRAM = /\b(?:the |that |this )?(?:graph|diagram|figure|drawing|sketch|triangle|shape)\b.{0,20}\b(?:i(?:'ve| just)? (?:drew|sketched|drawn)|drew|sketched)\b|\b(?:i(?:'ve| just)? (?:drew|sketched|drawn))\b.{0,20}\b(?:graph|diagram|figure|drawing|sketch|triangle|shape)\b|\b(?:le|la) (?:graphique|diagramme|figure|schéma|triangle|dessin) (?:que (?:j['’]ai (?:dessiné|tracé)|je (?:dessine|trace))|ci-dessus)(?![a-zà-öø-ÿ])|\bje (?:viens de |)(?:dessiner|dessiné|tracer|tracé)(?![a-zà-öø-ÿ])/i;

// Confident assertions of UNIQUE FACTS — attributions ("the author of X is Y"), inventions/discoveries
// ("the telephone was invented by…", "a été inventé…"), and dated events ("in 1665 Newton discovered…").
// These are exactly the shapes where an LLM tutor's confident half-memory becomes a factual error a
// student then writes on a real exam (Kestin et al. 2025 name "uncanny confidence when wrong" as THE
// known AI-tutor flaw). The chat loop treats a match as a correction trigger: verify via web_search or
// soften to honest uncertainty — see runRounds. Scoped to claim-verb shapes in EN+FR, NOT any sentence
// containing a name/date (ordinary tutoring prose would false-positive constantly); deliberately BROADER
// than CHAT_STATES_ANSWER (which only catches answer-announcing). NOTE: no trailing \b after accented
// French verbs — JS \b is ASCII-only, so `était\b` would NEVER match (see CHAT_CLAIMS_DIAGRAM's note);
// accented endings use a letter lookahead instead. Exported for test pinning, same as the guardrails above.
export const CHAT_ASSERTS_FACT =
  /\b(?:the\s+)?(?:author|writer|auteur)\s+(?:of|de)\s+[^,.;!?]{2,60}\s*(?:\bis\b|\bwas\b|\best\b|était(?![a-zà-öø-ÿ]))|\b(?:was|were)\s+(?:invented|discovered|founded|composed|first\s+described)\s+(?:by|in|around)\b|\ba\s+été\s+(?:inventé|découvert|fondé|composé)(?:e|es|s)?(?![a-zà-öø-ÿ])|\b(?:in|en)\s+(?:1\d{3}|20\d{2})\b[^.!?]{0,60}?(?:\bdiscovered\b|\binvented\b|\bwas\s+born\b|\ba\s+inventé|\ba\s+découvert|\best\s+né)/i;

// The tutor's own tool loop is bounded much tighter than runTask's: a chat turn is "maybe look something
// up, maybe make ONE thing, then talk" — never a research pass. Also caps how many artifacts one message
// can produce (a wall of chips defeats the point of a CONVERSATION) and a small total-token ceiling so a
// pathological turn can't cost like a small run.
// Was 3 — reproduced live: "find these on Decathlon" (several gear items) needs its OWN web_search per
// item when the model doesn't batch them into one completion's tool_calls, so round 0 searches item 1,
// round 1 searches item 2, and round 2 (the LAST round) has `tools` stripped and is forced to answer in
// plain text — with no room left to search item 3 first. That alone isn't fatal (the forced round still
// usually produces SOME reply), but it means a genuinely multi-item lookup gets cut short after 2 real
// searches, and if the forced final completion's hidden reasoning tokens (DeepSeek v4 — see OUT's own
// comment elsewhere) eat the whole budget while synthesizing several tool results into one answer, it can
// come back GENUINELY EMPTY — which the caller then reports to the user as a hard 502 ("Otto couldn't
// reply just now"), even though nothing actually crashed. Raised to give a multi-lookup turn real headroom.
const CHAT_MAX_ROUNDS = 7;

export const CHAT_MAX_ARTIFACTS = 2;

/** Interactive Primer turns: at most this many model rounds / this long before we stop adding optional rounds and reply. */
const PRIMER_MAX_ROUNDS = 4;

const PRIMER_BUDGET_MS = 9_000;

// Was 40_000, then 150_000 — reproduced live BOTH times as the actual cause of a run of "Otto couldn't
// reply"/generic-fallback turns mid-session, NOT reasoning-token exhaustion (that's OUT.chat's own concern):
// a single round's tokens.in scales with how much the session has ALREADY accumulated (chat history + every
// board entry get resent in full every round, up to the 60-item caps in localChatBoard.ts/server/index.ts),
// so a real, long-running tutoring session (many diagrams, several practice problems in) can cost well over
// 150k for just the rounds a single turn needs — 150k turned out to be exactly the same mistake as 40k, just
// delayed to later in a session instead of fixed. The actual, durable backstop against a genuinely runaway
// turn is CHAT_DEADLINE_MS below (a flat 120s wall-clock cap on the WHOLE call, independent of token count)
// — THAT'S what should be catching a pathological loop, not this ceiling tripping on an ordinary long
// session's ordinary cost. Raised well above any realistic per-turn cost so it stops being the thing that
// fails first; CHAT_MAX_ROUNDS (7) and the deadline are what actually bound a turn now.
const CHAT_TOKEN_CEILING = 500_000;

interface FinishChatReplyContext {
  fr: boolean;
  history: ChatHistory;
  logAudit: (kind: "tool" | "artifact" | "guardrail", label: string) => number;
  message: string;
  opts: ChatOptions | undefined;
  result: ChatResult;
}

export async function finishChatReply(ctx: FinishChatReplyContext, reply: string): Promise<ChatResult> {
  const { fr, history, logAudit, message, opts, result } = ctx;
    reply = stripWrapperTags(stripLeakedToolCallSyntax(extractPlan(reply).reply));
    // The redirect line replaces a violating REPLY, but if that same turn also produced artifacts, they were
    // almost certainly the same violation wearing a different container (a "fiche" that's just the essay) —
    // discard them too rather than hand over a chip whose text just got rejected.
    // RECOGNITION IS NOT A LEAK: when the STUDENT just put the answer on the table themselves ("the answer is
    // 42", "B", "x = 2 or x = 3"), Otto confirming it is exactly what a tutor owes them — but this guard fired
    // on Otto's confirmation and replaced it with a refusal, so the tutor looked like it hadn't noticed the
    // question was already answered (reported live: "it should recognise when the question was answered, even
    // if not fully with the tutor"). The guard stays fully armed for anything the student did NOT state.
    if (CHAT_DOES_WORK.test(reply) || (CHAT_STATES_ANSWER.test(reply) && !studentStatedAnswer(message, history))) {
      result.notes = []; result.flashcards = []; result.quizzes = []; result.problems = []; result.board = [];
      result.guardrailTripped = true;
      logAudit("guardrail", fr
        ? "Tu as demandé quelque chose qui ressemblait à faire le travail à ta place — Otto a dit non et a fait un guide à la place."
        : "That looked like asking Otto to do the graded work for you — it said no and made a guide instead.");
      reply = await rewriteReply(reply, "it does the student's graded work for them (writes the essay/answers). Don't produce that work: say briefly that this part is theirs, then help them find a starting point with one question about their own ideas.", message, result.tokens);
      if (CHAT_DOES_WORK.test(reply)) reply = ""; // still doing the work → an honest error, never a canned line
    }
    // Same leak, different surface: the WRITE_TO_BOARD/DRAW_ON_BOARD tool calls are guarded against stating
    // a problem's answer at creation time (see leaksAnyProblemAnswer), but the chat REPLY itself — plain
    // prose, never a tool call — had no equivalent check. Reported live: a Socratic chat reply about an
    // EARLIER part of a multi-part problem went on to state the LATER (still-unsolved) part's final value.
    else if (leaksAnyProblemAnswer(reply, [...(opts?.currentProblems || []), ...result.problems])) {
      result.notes = []; result.flashcards = []; result.quizzes = []; result.problems = []; result.board = [];
      result.guardrailTripped = true;
      logAudit("guardrail", fr
        ? "La réponse donnait la solution d'un problème en cours — Otto a dit non et a reposé une question à la place."
        : "The reply stated a problem's answer outright — Otto caught it and asked a question instead.");
      reply = await rewriteReply(reply, "it states the answer to a problem the student is still working on. Remove that value and anything that gives it away; keep the idea, and end with one question that helps them get there themselves.", message, result.tokens);
      if (leaksAnyProblemAnswer(reply, [...(opts?.currentProblems || [])])) reply = "";
    }
    // A problem the STUDENT poses goes on the board the moment it's posed, whether or not the model remembered to put
    // it there (reported live: they stated a full triangle problem and the board stayed empty).
    if (opts?.primer && !result.guardrailTripped) {
      const stmt = studentProblemStatement(message);
      if (stmt && cleanToPost(stmt) && !result.problems.length && !asksToDraw(message) && !result.board.some((e) => e.kind === "svg" || e.kind === "flow")) { // a drawn figure already carries the givens; never paste a spoken ramble beside it
        const onBoard = [...(opts?.currentBoard || []).map((e) => e.text), ...(opts?.currentProblems || []).map((p) => p.question), ...result.board.map((e) => e.text), ...result.board.flatMap((e) => (e.diagram || []).map((o: any) => o.latex || ""))];
        if (!boardCoversStatement(stmt, onBoard)) result.board.unshift({ id: randomUUID(), text: stmt, kind: "given", owner: "student", at: new Date().toISOString() } as BoardEntry);
      }
    }
    // 2400 (was 1200): a genuine tutoring turn — a method walked through step by step, or a parallel worked
    // example — legitimately runs longer than a one-line nudge, and truncating mid-explanation is worse than
    // no explanation. The prompt still pushes hard for SHORT by default; this only stops the rare long-but-
    // warranted reply from being cut off mid-sentence — a plain `.slice(0, 2400)` here used to cut off
    // literally mid-WORD ("Bertrand" → "Bertra"), which is worse than the truncation this comment always
    // claimed to prevent. truncateCleanly backs up to the last sentence end (falling back to the last word
    // boundary if there's no sentence break inside the cap) and marks the cut with an ellipsis, so a
    // response is never handed back looking like it broke mid-thought.
    // Fallback: still a wall of text after the corrective round → the app puts it on the board and the bubble just points there.
    if (opts?.primer && !result.guardrailTripped && history.length >= 1 && isBoardContent(reply) && !result.board.some((e) => ["outline", "definition", "formula", "note", "summary", "result"].includes(String(e.kind)))) {
      const { items, question } = splitBoardContent(reply);
      if (items.length >= 2) {
        for (const it of items.slice(0, 6)) {
          const r = makeBoardEntry({ text: latexifyBoardLine(repairLatex(it), "definition").slice(0, 590), kind: "definition" });
          if ("entry" in r) result.board.push(r.entry);
        }
        reply = (await rewriteReply(reply, `this long content has now been written on the board as ${items.length} lines. Replace the reply with one short sentence pointing them at it${question ? ` and keep this question: "${question}"` : ", then one question about it"}.`, message, result.tokens)) || reply;
        console.log(`${new Date().toISOString()} [chat] fallback: moved a list/long block from the bubble to the board (${items.length} items)`);
      }
    }
    // Safety net AFTER every corrective round: a reply that is just a formula, or still writes a step the student never
    // reached, is never shipped — it becomes a plain Socratic question, and the tutor's own derived "result" lines
    // from that turn are dropped so nothing solves it on the board either.
    if (opts?.primer && history.length >= 1 && !result.guardrailTripped
      && bareMath(reply)) {
      console.log(`${new Date().toISOString()} [chat] safety net: reply was only a formula — replacing with a question about what the student just wrote`);
      reply = await rewriteReply(reply, "it's only a formula dropped on the student, possibly doing a step they haven't reached. Don't state the maths; instead ask them one question about what they just wrote or what they'd do next.", message, result.tokens);
      result.board = result.board.filter((e) => !["result", "formula"].includes(String(e.kind)) || e.owner === "student");
    }
    reply = repairLatex(reply);
    const cleaned = truncateCleanly(reply.trim(), 2400);
    if (!cleaned) {
      result.error = true;
      // NEVER the old "I'm here — what part of this is giving you trouble?" — that pretended Otto was
      // present and just didn't understand, when what actually happened is the AI call came back empty/
      // failed (after the retries above already had their chance). Same honest wording used everywhere
      // else a chat turn genuinely fails (server/index.ts's own 500 path, client/StudyMode.tsx's catch) —
      // consistent, and doesn't put words in the student's mouth about what's "giving them trouble".
      // BUT: if a tool call earlier in THIS SAME turn already produced something real (a problem, a board
      // write, a diagram) before the final text-generation round came back empty — reproduced live: a
      // CREATE_PROBLEM landed fine, then the follow-up completion synthesizing a reply around it came back
      // empty, and the student saw a flat "Otto couldn't reply" with a new exercise having silently
      // appeared with no acknowledgment at all — say so honestly instead of pretending nothing happened.
      // Worded to match what ACTUALLY landed: a flat "here's an exercise" shown after a DRAW_ON_BOARD (e.g.
      // "draw the new free body diagram") was a real, reported mismatch — the one thing the student asked
      // for (a diagram) existed, but the message talked about a different thing (an exercise) instead.
      const madeProblem = result.problems.length > 0;
      const madeDiagram = result.board.some((e) => e.kind === "diagram");
      const madeBoardOnly = !madeProblem && result.board.length > 0;
      const landed = madeProblem ? `a new exercise: "${result.problems[0].question.slice(0, 200)}"` : madeDiagram ? "a diagram" : madeBoardOnly ? `a board line: "${String(result.board[0].text || "").slice(0, 200)}"` : "";
      const said = landed ? await rewriteReply("", `the reply is missing. You just put ${landed} on the board; write the short reply that goes with it (point them at it, one question).`, message, result.tokens) : "";
      result.reply = said || (fr ? "Otto n'a pas pu répondre tout de suite — réessaie dans un instant." : "Otto couldn't reply just now — try again in a moment.");
      if (said) result.error = false;
    } else {
      result.reply = cleaned;
    }
    return result;
  }

interface RunChatRoundsContext {
  finish: (reply: string) => Promise<ChatResult>;
  fr: boolean;
  heard: string[];
  history: ChatHistory;
  includeArtifactTools: boolean;
  logAudit: (kind: "tool" | "artifact" | "guardrail", label: string) => number;
  message: string;
  messages: any[];
  opts: ChatOptions | undefined;
  profile: Profile | undefined;
  readOnlyExtras: AgentTools | undefined;
  result: ChatResult;
  spokenRepair: SpokenRepair | null;
  task: ChatTask;
  tools: Array<{ name: string; description?: string; input_schema: unknown }>;
  turnStartedAt: number;
}

export async function runChatRounds(ctx: RunChatRoundsContext): Promise<ChatResult> {
  const { finish, fr, heard, history, includeArtifactTools, logAudit, message, messages, opts, profile, readOnlyExtras, result, spokenRepair, task, tools, turnStartedAt } = ctx;
    // One-shot: a reply that points the student at the board/screen when nothing was actually written there
    // gets ONE corrective round to write it for real (see CHAT_CLAIMS_BOARD's own comment). Latched so a
    // model that keeps doing it can't spin the loop.
    let boardClaimCorrected = false;
    let boardNudgeDone = false;
    let reasoningNudgeDone = false;
    let repeatCorrected = false;
    let planCorrected = false;
    // Tutor-only Socratic latches (each corrective round below fires at most ONCE per turn):
    //  · planMissing  — the turn reached the app with no <plan>, so the policy had nothing to check;
    //  · gapLeakFixed — the reply handed over the value of a gap still open on the board;
    //  · oneQuestionFixed — the reply asked two questions at once;
    //  · poseFixed    — a full problem was posed in chat and never put on the board.
    let planMissing = false;
    let gapLeakFixed = false;
    let oneQuestionFixed = false;
    let poseFixed = false;
    // Tutor only: one corrective round for the two ways a turn can fail to leave a mark on the board —
    // (a) the student contributed a step and Otto wrote NOTHING, and (b) Otto's own reply carried working the
    // page doesn't have (see shouldNudgeBoardContent; the second case used to require an EMPTY board, which is
    // why a session could write one entry and then work everything else out in chat). Latched to once per turn;
    // skipped on the first message, while a guardrail has wiped the turn, and for non-substantive input. Used
    // by BOTH the plain-text path and the after-tool-calls path. Returns true when it queued the round.
    const isStuckLike = (m: string) => stuckStreak(m, []) > 0 || /\b(hint|indice|again|repeat|répète|what do you mean|comment ça)\b/i.test(m);
    const nudgeReasoning = (draft: string, round: number, lastRound: boolean): boolean => {
      const studentStep = isSubstantiveStep(message) || (statesOwnMath(message) && !asksToDraw(message)); // spoken maths ("tan 30 equals h over 100 plus k") counts
      // Two distinct misses, one latch: (a) the student contributed a step and the tutor wrote nothing, and
      // (b) the tutor's OWN reply put real working in chat that the page doesn't carry — "explains the
      // formula but never shows it", the reported "not using the board enough". (b) used to require an
      // EMPTY board, which meant a session wrote its focus line and then did every derivation after that in
      // chat with no correction ever — the board stalling at one or two entries was exactly the reported
      // "it doesn't always use it". It now fires whenever the draft introduces working the board doesn't
      // have, whatever is already up; the once-per-turn latch below is what keeps it from nagging.
      const boardNow = [...(opts?.currentBoard || []), ...result.board];
      const boardIsEmpty = boardNow.length === 0;
      const boardTextNow = boardNow
        .map((e) => `${e.text} ${(e.outline || []).map((s) => `${s.heading}: ${s.bullets.join("; ")}`).join(" ")}`)
        .join("\n");
      const contentMissedBoard = shouldNudgeBoardContent(draft, boardTextNow, false);
      if (!(opts?.primer && !reasoningNudgeDone && !boardNudgeDone && !lastRound && history.length >= 1 && !result.guardrailTripped && (studentStep || contentMissedBoard))) return false;
      reasoningNudgeDone = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: ${studentStep ? "student contributed a step but" : "real working in the reply but"} none of it is on the board — asking for the write`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: studentStep
        ? "The student just contributed a step, but nothing was added to the board this turn — the board is their paper and it should show their work. Before you reply, write to it (1-3 short WRITE_TO_BOARD calls): (a) kind \"summary\" — THEIR reasoning so far in your own words, maths in $…$ (the move they made, why it works, what it gave); (b) if the step produced an equation, value or simplified form that matters for the NEXT part of the problem, kind \"result\" — that thing alone, typeset in $…$, on its own with NO label or prefix (never \"Established:\") — just the line itself); (c) if a formula or rule is in play and not on the board yet, kind \"formula\". Only what THEY have reached — never a step they haven't taken or the final answer, never their message word for word. Write only what is genuinely worth keeping — if the step was trivial, write nothing. Then send your short reply again."
        : boardIsEmpty
        ? "You're working with real math here and the board is still completely empty — the student can see your reply but nothing is visible next to it. Before you reply again, call WRITE_TO_BOARD ONCE: the formula in play, the given values, or the definition you just used (real math through DRAW_ON_BOARD's equation op — one short entry, NOT a wall of text, and not a restatement of your reply). Then send your short reply again. If this exchange genuinely produced nothing worth keeping visible, just continue unchanged and don't mention this."
        : "You just worked through real math in the chat — a formula, an equation, a line of working — and none of it is on the board, which is the page you're both working on. Before you reply again, call WRITE_TO_BOARD and put the WORKING up: SEPARATE LINES, one move per line, maths in $…$, in the order you did it, and leave the NEXT line as the gap (\"= ?\") for the student to finish — that gap is the point, don't close it for them. A short multi-line block like that is ONE entry, not a wall of text. Do NOT reach for kind \"summary\" for this: that one renders as a reasoning trace and is for the STUDENT's own reasoning. If this exchange genuinely produced nothing worth keeping visible, just continue unchanged and don't mention this." });
      return true;
    };
    // The question must not answer itself: a board entry written THIS turn that already states the value Otto is
    // asking for (a table with "270°: (0, −1)" next to "what's cos 270°?") gets pulled before the student sees it
    // and rewritten once with that value left as "?". Only this turn's pending entries are touched — nothing the
    // student already has on their board is ever removed.
    let askedLeakFixed = false;
    const guardAskedValue = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || !result.board.length) return false;
      const bad = boardStatesAskedValue(draft, result.board as any);
      if (!bad.length) return false;
      result.board = result.board.filter((_, i) => !bad.includes(i));
      if (askedLeakFixed || lastRound) return false;
      askedLeakFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: a board entry already states the value the question asks for — pulled, asking for a rewrite with a blank`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "The board entry you just wrote already STATES the value you're asking the student to find, so the question answers itself. I've pulled that entry (they never saw it). Call WRITE_TO_BOARD again with the same idea but leave the asked-for value out — show the OTHER cases or the pattern, and put \"?\" (or nothing) where the value they must work out would be. Then send your short reply again; don't mention this correction." });
      return true;
    };
    // THE VALUE OF AN OPEN GAP NEVER APPEARS IN CHAT. The board carries `expectedAnswer` for every "= ?" line
    // and the tool forbids revealing it — but only the BOARD was ever checked for stating an asked-for value
    // (guardAskedValue above); the reply itself had no equivalent net (CHAT_STATES_ANSWER only catches the
    // phrase "the answer is…", so a bare "8.5 N" in prose passed straight through). Skipped when the STUDENT
    // already said the value: confirming what THEY produced is recognition, handing over what they never said
    // is the violation — which is also what lets the tutor take an answer that came from outside the session.
    const guardGapAnswer = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || gapLeakFixed || lastRound || result.guardrailTripped) return false;
      const open = [...(opts?.currentBoard || []), ...result.board].filter((e) => e.kind === "gap" && e.expectedAnswer);
      if (!open.length) return false;
      const theirs = [message, ...history.filter((h) => h.role === "user").map((h) => h.text)].join("\n");
      const hit = open.find((e) => replyStatesValue(draft, e.expectedAnswer!) && !replyStatesValue(theirs, e.expectedAnswer!));
      if (!hit) return false;
      gapLeakFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply states the value of a gap still open on the board — pulling it, asking for a question instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `Your reply hands over the value the open line on the board (\"${String(hit.text).slice(0, 60)}\") is asking them to produce — while that line is open it is theirs to fill, never yours to say. Take the value OUT: keep the method or the next nudge, and end on the question that gets THEM to produce it. (If they already produced it themselves, confirm what THEY said.) Don't mention this correction.` });
      return true;
    };
    // A turn with no question is a lecture: a reply to a real student contribution that asks them nothing gets ONE
    // corrective round to end on a single guiding question (never the answer).
    let questionAdded = false;
    const guardQuestion = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || questionAdded || lastRound || history.length < 1 || result.guardrailTripped || !needsQuestion(draft, message)) return false;
      questionAdded = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply asks the student nothing — asking for a guiding question`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That reply doesn't ask the student anything, so they just receive information. Keep what's useful but end on ONE short guiding question that makes THEM take the next step or explain their thinking (never the answer, never a yes/no they can guess). Don't mention this instruction." });
      return true;
    };
    // What counts as "given" for the setup-equation check: the problem statements, the student's own board lines, and
    // given-kind entries — NOT the tutor's earlier derived lines (those would launder a step into the givens).
    const ownGivens = (): string[] => [
      ...(opts?.currentBoard || []).filter((e) => e.kind === "given" || e.owner === "student").map((e) => e.text),
      ...(opts?.currentProblems || []).map((p) => p.question),
    ];
    // Same rule for the REPLY: the tutor mentioning an equation the student never wrote ("distribute that tan 25° on the
    // right side") means it built one off-screen. One corrective round: ask for the setup instead.
    let aheadMathFixed = false;
    const guardAheadMath = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || aheadMathFixed || lastRound || result.guardrailTripped) return false;
      if (equationAhead(draft, [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens()).length === 0) return false;
      aheadMathFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply states an equation step the student never reached — asking for the setup instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That reply writes out an equation (or refers to one) that the student never wrote — the setup is THEIR work. Rewrite it without that equation: ask the question that gets them to build it themselves (which relationship links the quantities, what each side stands for), and nothing more." });
      return true;
    };
    // NUMBERS OUT OF NOWHERE. A figure in the reply that is in nothing the student said, the givens or the board is Otto's own
    // computation or an invention (reported live: "take the square root of 390.4" after the student had only found 235,200 J).
    let inventedFixed = false;
    const guardInvented = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || inventedFixed || lastRound || result.guardrailTripped) return false;
      const src = [message, ...heard, ...history.map((h) => h.text), ...(opts?.opening || []).map((m) => m.text), ...ownGivens(), ...(opts?.currentBoard || []).map((e) => e.text), ...result.board.map((e) => e.text), ...result.problems.map((p) => p.question)];
      const bad = inventedNumbers(draft, src);
      if (!bad.length) return false;
      inventedFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply states numbers nobody gave (${bad.join(", ")}) — asking for a reply built on their words`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `That reply states ${bad.join(", ")}, which neither the student nor the problem ever gave — it came from your own calculation or from nowhere, and it jumps ahead of what they said. Rewrite it built ONLY on what the student actually just said (reflect their result or their idea back, e.g. what they found and what they just raised) and ask ONE question about THEIR next step. No new numbers.` });
      return true;
    };
    // The student showed a drawing: comment AND redraw it cleaner. If the reply came back with no figure, one corrective round.
    let redrawFixed = false;
    const guardRedraw = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || redrawFixed || lastRound || result.guardrailTripped || !isDrawingTurn(message) || !drawingLooksSpatial(message)) return false;
      if (result.board.some((e) => e.kind === "diagram" || e.kind === "graph" || e.kind === "svg")) return false;
      redrawFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: the student showed a drawing but nothing was redrawn — asking for the cleaner redraw`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "They showed you a drawing and you haven't redrawn it. Call GEOMETRY_ON_BOARD (triangles/circles/angles) or SVG_ON_BOARD (anything else) NOW to redraw THEIR drawing cleaner — same shapes, labels and numbers, nothing added — then reply with a one- or two-sentence comment on it and ONE question." });
      return true;
    };
    // The tutor computed a step for them ("40° − 25° = 15°") — the arithmetic AND the decision to do it were theirs.
    let ownArithFixed = false;
    const guardOwnArithmetic = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || ownArithFixed || lastRound || result.guardrailTripped) return false;
      const bad = arithmeticAhead(draft, [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens());
      if (!bad.length) return false;
      ownArithFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply computed a step for the student (${bad[0]}) — asking for a question instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `That reply worked out "${bad[0]}" for them — the student never produced that value, so you did their step. Rewrite it WITHOUT stating that result: ask what they get / which relationship gives it, and let THEM compute it. (If they asked whether their own claim is right, judge THEIR claim plainly — yes/no and why — without supplying new values.)` });
      return true;
    };
    // They asked Otto to DRAW it and the reply came back with a question instead — a refusal in disguise (reported live: five
    // "can you just draw it" in a row, five questions back). One corrective round that forces a real figure.
    let drawReqFixed = false;
    const guardDrawRequest = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || drawReqFixed || lastRound || result.guardrailTripped || !asksToDraw(message)) return false;
      if (result.board.some((e) => ["diagram", "svg", "graph", "flow", "widget"].includes(String(e.kind)))) return false;
      drawReqFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: they asked for a drawing and none was made — asking for the figure`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "They asked you to DRAW it, and you answered with a question instead — that's a refusal. Call the right drawing tool NOW: GRAPH_ON_BOARD for lines/functions/data (plot them — no answer in the labels), TRIG_SCENE_ON_BOARD for angles of elevation/depression, GEOMETRY_ON_BOARD for triangles/circles, SOLID_ON_BOARD for 3D solids (cuboid, pyramid, prism, cylinder, cone, sphere), FLOW_ON_BOARD for processes, otherwise SVG_ON_BOARD (a fully labelled figure with the GIVEN values and the unknowns as letters). Then one short line about what's on it and ONE question." });
      return true;
    };
    // The board is the working surface, not a thing to ask for: when they ask for something written and nothing went up this
    // turn, ONE corrective round makes Otto write it (their words, in LaTeX). Their own stated steps go through nudgeReasoning.
    let boardUseFixed = false;
    const guardBoardUse = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || boardUseFixed || lastRound || result.guardrailTripped || history.length < 1) return false;
      if (result.board.some((e) => ["summary", "result", "given", "formula", "note", "diagram", "svg", "graph", "flow", "widget"].includes(String(e.kind)))) return false;
      const asked = asksToWrite(message);
      if (!asked) return false;
      boardUseFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: they asked for it on the board and nothing was written — asking for a board line`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "They asked you to put it on the board and you answered with a question instead. Call WRITE_TO_BOARD NOW — one board line per equation or value they stated (the maths only, tidied into clean LaTeX between $…$ — never their sentence, filler or spoken words; nothing new, nothing you worked out) — then ONE short line and your question. If a value they ask for hasn't been computed by them yet, write only the setup. Don't mention this instruction." });
      return true;
    };
    // The tutor does NO work and names NO operation: one corrective round when the bubble tells them which move to make
    // ("multiply both sides by…", "substitute that into…") or does the maths itself (an equation they never wrote).
    let doingFixed = false;
    const guardNoDoing = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || doingFixed || lastRound || result.guardrailTripped || history.length < 1) return false;
      const names = namesExactStep(draft), maths = bubbleDoesMath(draft, [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard]);
      if (!names && !maths) return false;
      doingFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply ${names ? "names the exact operation" : "does maths for them"} — asking for a guiding question instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That reply does their work: " + (names ? "it tells them WHICH operation to perform (choosing the move IS the thinking). " : "") + (maths ? "it writes out an equation they never wrote (the maths belongs to them, and on the board, not in your bubble). " : "") + "Rewrite it as ONE short question about the GOAL or the IDEA — what they are trying to get, what is in the way, which relationship connects the pieces, what they notice — never the operation, never a formula, never a value. Steer toward the next step of your hidden quickest route without stating it. Don't mention this instruction." });
      return true;
    };
    // KNOW THE ANSWER BEFORE YOU ASK: the plan carries the tutor's own answer to the question it is about to ask; if the reply already
    // states it ("750 J — what are the units?") it is quizzing the student on something it just said. One corrective round.
    let ownAnswerFixed = false;
    const guardOwnAnswer = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || ownAnswerFixed || lastRound || result.guardrailTripped || history.length < 1 || !result.plan?.askAnswer) return false;
      if (!/[?？]/.test(draft) || !statesOwnAnswer(draft, result.plan.askAnswer, [...history.filter((h) => h.role === "user").map((h) => h.text), message])) return false;
      ownAnswerFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: the reply already contains the answer to the question it asks — asking for a fresh question`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `Your reply already states "${String(result.plan.askAnswer).slice(0, 40)}" — the answer to the very question you are asking. Never quiz them on something you just said. Rewrite it: drop the part that gives it away and ask the question so THEY produce it (or, if you meant to confirm their value, ask the next real question instead). Keep it to one or two short sentences. Don't mention this instruction.` });
      return true;
    };
    // The bubble is tiny: a list, a cheat sheet or a long block belongs on the BOARD, and the bubble just says it is there.
    // One corrective round asks for it; if the model still sends the wall of text, the app moves it to the board itself.
    let boardContentFixed = false;
    const guardBoardContent = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || boardContentFixed || lastRound || result.guardrailTripped || !isBoardContent(draft)) return false;
      if (result.board.some((e) => ["outline", "definition", "formula", "note", "summary", "result"].includes(String(e.kind)))) return false;
      boardContentFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: a list / long block in the bubble — asking for it on the board`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That is board content, not bubble content. Put it on the BOARD: WRITE_TO_BOARD (one definition or formula per line, maths in LaTeX between $…$, or an outline with short sections), then reply with ONE short sentence saying you put it on the board plus ONE question about it — never the list itself in the bubble. Don't mention this instruction." });
      return true;
    };
    // A problem they ask for (or can't find) is a real EXERCISE — CREATE_PROBLEM, with the full statement, so it shows up as a widget they can
    // answer and have checked — never plain board text, and never only talked about in chat. One corrective round.
    let problemWidgetFixed = false;
    const guardProblemAsWidget = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || problemWidgetFixed || lastRound || result.guardrailTripped || history.length < 1) return false;
      if (!(asksForProblem(message) || asksWhichProblem(message))) return false;
      if (result.problems.length) return false;
      if ((opts?.currentProblems || []).some((p) => !p.solved) && !asksWhichProblem(message) && !asksToMoveOn(message) && !asksForProblem(message)) return false;
      problemWidgetFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: a problem was asked for / lost and no exercise was created — asking for CREATE_PROBLEM`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "They asked for a problem (or can't see which one you mean). Set it as a real EXERCISE now: call CREATE_PROBLEM with the FULL statement and every given in the question (in LaTeX), a single final answer — a bare NUMBER with its `check` expression and the unit in `format` — or multiple choice (options + correct) for a conceptual one. Never leave it as plain board text, and never ask about a problem that isn't stated in full where they can see it. Then one short line about it. Don't mention this instruction." });
      return true;
    };
    // "Spot on" to a message with nothing in it ("to do", "yeah") — praise for nothing teaches them nothing.
    let emptyPraiseFixed = false;
    let boardLineFixed = false;
    const guardBoardLine = (draft: string, round: number, lastRound: boolean): boolean => {
      if (boardLineFixed || lastRound || !citesMissingBoardLine(draft, [...(opts?.currentBoard || []), ...result.board])) return false;
      boardLineFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply points at a board line that does not exist — asking for a quote instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "You pointed at a board line number that isn't on the board. Rewrite your reply: quote what the line actually says (or use a margin number that exists), and never point at something that isn't on the board. Same question otherwise." });
      return true;
    };
    const guardEmptyPraise = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || emptyPraiseFixed || lastRound || result.guardrailTripped || !praisesNothing(draft, message)) return false;
      emptyPraiseFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: praise for a message with nothing checkable in it — asking for a plain question`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "They said nothing checkable (a fragment or a stray word, maybe a mis-heard voice message) — there is nothing to praise, and \"spot on\" teaches them nothing. Don't praise or assume what they meant: say you didn't quite catch it and ask ONE short question about where they are in the problem." });
      return true;
    };
    // GROUNDING. Respond only to what the student ACTUALLY said: no praise for a step they didn't take, no "you've got X" for
    // something they never said, and no naming the method/formula before they reached for it (reported live: "tan(θ) = slope!"
    // to a student who had only said the two slopes).
    let groundedFixed = false;
    const guardGrounded = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || groundedFixed || lastRound || result.guardrailTripped) return false;
      const studentTexts = [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard];
      let why = "";
      if (praiseUngrounded(draft, message, result.plan)) why = "it opens with praise, but nothing they said was a checkable correct step";
      else if (confirmsUnchecked(draft, message, result.plan)) why = "it confirms a value (\"spot on\") that their own working doesn't reach — recompute it from the givens yourself first; if their numbers don't agree with each other or with your answer, say so kindly and ask which step they'd recheck, instead of praising";
      else if (blamesWidget(draft)) why = "it blames the widget/app for a mismatch — never do that: recompute the answer from the givens yourself; if the key was wrong say so plainly and own it, otherwise ask what they'd check (units, rounding, form)";
      else if (wrapsUpUnasked(draft, message)) why = "it offers to wrap up or move on ('call it a win', 'one more?') when they didn't ask — stay on their problem and ask about the next step or what they'd check";
      else {
        const mis = misattributes(draft, studentTexts, (opts?.currentBoard || []).filter((e) => e.owner === "student").map((e) => e.text));
        if (mis) why = `it credits them with something they never said ("${mis.slice(0, 80)}")`;
        else if (opts?.policy && opts.policy.maxLevel <= 3 && !wantsHelp(message)) {
          const ahead = methodAhead(draft, [...studentTexts, ...ownGivens()]);
          if (ahead.length) why = `it names the method (${ahead.join(", ")}) before they reached for it`;
        }
      }
      if (!why) return false;
      groundedFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: ungrounded reply — ${why}`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `Rewrite that reply — ${why}. Respond ONLY to what the student actually said or did: reflect it back in their own words (e.g. the exact values/terms they gave), say plainly if it isn't there yet, don't praise anything that wasn't a correct step, don't attribute ideas to them, and don't introduce a formula or method they haven't reached for — ask ONE question that gets THEM to bring it up. If they suggested something concrete (like graphing it), do that first.` });
      return true;
    };
    // LISTEN FIRST. A question about a term ("what does m show", "what's M1") gets an answer ABOUT THAT TERM, and real work they report
    // ("I found the intersection at x = 3/14") gets a response before anything else — never a reply that carries on with Otto's own
    // plan as if they hadn't spoken (reported live: three clarifying questions in a row answered with arctan and a calculator).
    let listenFixed = false;
    const guardListen = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || listenFixed || lastRound || result.guardrailTripped) return false;
      const q = ignoresQuestion(draft, message), w = !q && ignoresWork(draft, message);
      if (!q && !w) return false;
      listenFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply ignored what the student said (${q ? "their question" : "their work"}) — asking for a reply that listens`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: q
        ? `They asked "${message.slice(0, 120)}" — a question about "${clarificationTerm(message)}" — and your reply never addresses it, it just carries on with your plan. Answer THEIR question first: in one or two short sentences say what that is in THIS problem (pointing at the board/problem), then ask ONE small question that makes them connect it. Don't advance to the next step, don't calculate, don't give a formula.`
        : `They told you something concrete ("${message.slice(0, 140)}") and your reply says nothing about it. Respond to IT first, in their words: is it right, partly right, or not what this question needs (and how can they tell)? Don't confirm what you haven't checked, don't give the answer, don't jump to your own next step. Then ask ONE question that builds on what THEY did.` });
      return true;
    };
    // "Why do I need to equate those?" is a request to understand, and it must be ANSWERED (briefly, with the reason) before any
    // guiding question — never met with "notice that…" or a restatement of the question. One corrective round.
    let whyFixed = false;
    const guardAnswerWhy = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || whyFixed || lastRound || result.guardrailTripped || !asksWhy(message) || !ignoresWhy(draft)) return false;
      whyFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: they asked WHY and the reply explains nothing — asking for a direct explanation`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `They asked WHY ("${message.slice(0, 140)}") and your reply gives no explanation — it restates their question or answers with a question. Answer it directly now: 2–3 plain sentences with the actual reason, in words with no new equations (a concrete example or comparison helps; this is explaining a concept, not handing over the problem's answer), then at most one small question that checks it landed. Don't restate their question. Don't mention this instruction.` });
      return true;
    };
    // A multi-solution trap (SSA ambiguous triangle, trig equation's second solution, ±) that nobody raised, while the
    // reply closes the problem or offers "another one": the student shouldn't have to ask "isn't there another case?".
    // One corrective round: raise it as a QUESTION (never announce it).
    let missedCaseFixed = false;
    const guardMissedCase = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || missedCaseFixed || lastRound || result.guardrailTripped) return false;
      const traps = pendingCaseTraps(message, history, draft);
      if (!closesWithMissedCase(draft, traps)) return false;
      missedCaseFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply closes the problem but "${traps[0].hint}" was never raised — asking for the case check`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: `Don't close this yet — ${traps[0].hint}, and nobody has raised it. Rewrite the reply WITHOUT saying it's solved or offering another problem: keep any short acknowledgement of what they just did, then end on ONE question that makes THEM check whether there is another case/solution (e.g. "how many triangles could fit these numbers?"). Do NOT tell them the answer to that question.` });
      return true;
    };
    // The tutor wrote the calculation ("180° − 45.6°") and only asked the student to evaluate it: the thinking
    // (which operation, why) was the point. One corrective round: ask for the idea, let THEM write the line.
    let handedCalcFixed = false;
    const guardHandedCalc = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || handedCalcFixed || lastRound || result.guardrailTripped || !handsOverCalculation(draft, message)) return false;
      handedCalcFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply wrote the calculation for the student — asking for the idea instead`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That reply wrote the calculation out for them and only asked them to evaluate it — choosing the operation WAS the thinking. Rewrite it without the expression: ask what relationship/rule tells them the next quantity (e.g. \"which other angle between 0° and 180° has the same sine?\") and let THEM produce the line. No numbers from the step they're about to take." });
      return true;
    };
    // ONE QUESTION AT A TIME. Two questions in one reply split their attention: they answer the easy one and
    // the real question dies (reported live: "it sometimes generated two questions at once"). The count only
    // looks at REAL question marks — the "?" of an open gap ("F_net = ?") is notation, not a question.
    const guardOneQuestion = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || oneQuestionFixed || lastRound || result.guardrailTripped) return false;
      if ((draft.match(/[^=\s]\?/g) || []).length < 2) return false;
      oneQuestionFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply asks two questions at once — asking for the one that matters`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "That reply asks them TWO things at once — they can only be working on one. Keep the ONE question that moves them forward right now and turn the others into a statement (or drop them). Don't mention this instruction." });
      return true;
    };
    // A PROBLEM POSED IN CHAT GOES ON THE BOARD THE MOMENT IT'S POSED. Reported live: a full IB question
    // ("Find all values of x … cos 2x + 3cos x = 1 … what's your first move?") lived only as scrollback —
    // the board sat empty next to an entire session of real work. One corrective round: CREATE_PROBLEM when
    // it's a single-answer exercise, otherwise WRITE_TO_BOARD with the givens and the actual question.
    const POSE_VERB = /\b(?:find|solve|determine|calculate|compute|evaluate|simplify|express|prove|show(?: that)?|work out|deduce|hence|trouve|résous|calcule|démontre|simplifie|exprime|déduis)\b/i;
    const guardPoseOnBoard = (draft: string, round: number, lastRound: boolean): boolean => {
      if (!opts?.primer || poseFixed || lastRound || result.guardrailTripped) return false;
      if (result.problems.length || result.board.length) return false; // something already landed this turn
      const prose = posesProblemInProse(draft); // a worded problem (angles, lengths, quantities) needs no "=" to be a problem
      if (!/\?/.test(draft) || (!POSE_VERB.test(draft) && !prose)) return false;
      const eqs = (draft.match(/[\p{L}\p{N}πθμ√^()\s.,+\-*/]{3,}=[\p{L}\p{N}π√^()\s.,+\-*/-]{1,40}/gu) || [])
        .map((m) => m.trim()).filter((m) => m.replace(/\s+/g, "").length >= 3);
      if (!eqs.length && !prose) return false;
      if (!eqs.length && boardCoversStatement(draft, [...(opts?.currentBoard || []), ...(opts?.currentProblems || []).map((p) => p.question)].map((e: any) => String(e.text ?? e))) ) return false;
      const board = [...(opts?.currentBoard || []), ...result.board]
        .map((e) => `${e.text} ${(e.diagram || []).map((o: any) => o.latex || "").join(" ")} ${(e.outline || []).map((s) => `${s.heading} ${s.bullets.join(" ")}`).join(" ")}`)
        .join("\n").replace(/[\s$]/g, "").toLowerCase();
      if (eqs.length && eqs.some((m) => board.includes(m.replace(/[\s$]/g, "").toLowerCase()))) return false; // already up there
      poseFixed = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: a problem was posed in chat with nothing on the board — asking for it up there`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: "You just posed a real problem in chat only — the moment the thread scrolls it's gone, and the board next to it stays empty. Put it up NOW, same reply: CREATE_PROBLEM if it's a single-answer exercise (it gets the answer box), otherwise WRITE_TO_BOARD with the givens AND the actual question (short lines, maths in $…$), then ask your question about it. Then send your short reply again. Don't mention this instruction." });
      return true;
    };
    // "Done — 50 cards covering…" with NO deck behind it (reported live): the reply CLAIMS an artifact was made but no
    // CREATE_FLASHCARDS / CREATE_NOTE / CREATE_QUIZ ran this turn. One corrective round: make it real (artifact tools
    // are force-offered for that round even if the turn had been classed as small talk) or drop the claim.
    let artifactClaimCorrected = false;
    let forceArtifactTools = false;
    const CLAIMS_ARTIFACT = /\b(?:done|made|created|generated|ready|prepared|here(?:'s| are| is)|j['’]ai (?:créé|fait|généré|préparé)|voilà|c['’]est fait|voici)\b[^.!?\n]{0,70}\b(?:flash ?cards?|cards?|deck|quiz|quizz|fiches?|cartes|questionnaire)\b/i;
    const guardArtifactClaim = (draft: string, round: number, lastRound: boolean): boolean => {
      if (artifactClaimCorrected || lastRound || !CLAIMS_ARTIFACT.test(draft)) return false;
      if (result.notes.length || result.flashcards.length || result.quizzes.length) return false;
      artifactClaimCorrected = true;
      const canMake = !opts?.canvasMode;
      if (canMake) forceArtifactTools = true;
      console.log(`${new Date().toISOString()} [chat] round ${round}: reply claims an artifact was made but none was — asking for the real call`);
      messages.push({ role: "assistant", content: draft });
      messages.push({ role: "user", content: canMake
        ? "You said you made flashcards / a quiz / a note, but you never called CREATE_FLASHCARDS, CREATE_QUIZ or CREATE_NOTE this turn — nothing exists, the student has nothing to open. Call the right tool NOW with the real content (what they asked for), then reply with one short line pointing at it. If you can't, say plainly that you haven't made it yet. Don't mention this instruction."
        : "You said you made a deck / quiz / note, but nothing was created — in tutor mode you can't make those. Rewrite your reply without claiming it, and offer to put the key points on the board instead. Don't mention this instruction." });
      return true;
    };
    let truncationRetried = false;
    // Latches for the post-reply truth pass below (each fires at most ONCE per turn, same shape as the
    // board-claim fix): one corrective round when the draft asserts arithmetic that doesn't recompute,
    // one when it confidently asserts a unique fact it never checked. Not free-firing: CHAT_MAX_ROUNDS
    // is a shared budget with the artifact tool loop, so a reply that's both long and fact-bearing could
    // otherwise spend rounds it needs.
    let arithCorrected = false;
    let factCorrected = false;
    let lengthRetried = false;
    let langCorrected = false;
    // Computed ONCE per turn (not per round): the language the student is actually writing in right now,
    // falling back through recent history when the newest message alone carries no signal (a bare "ok",
    // "idk", a number) — same anchor CHAT_LANGUAGE_OVERRIDE's prompt wording already asks the model to use.
    // "unknown" (checked message AND history both ambiguous) disables the check entirely for this turn —
    // never force a "correction" based on a guess.
    let studentLang = detectLang(message);
    if (studentLang === "unknown") {
      for (let i = history.length - 1; i >= 0 && studentLang === "unknown"; i--) {
        if (history[i].role === "user") studentLang = detectLang(history[i].text);
      }
    }
    const maxRounds = opts?.primer ? PRIMER_MAX_ROUNDS : CHAT_MAX_ROUNDS;
    for (let round = 0; round < maxRounds; round++) {
      if (result.tokens.in + result.tokens.out > CHAT_TOKEN_CEILING) {
        // Reproduced live: a big tool-call payload (e.g. a large flashcard deck) plus the growing
        // conversation history can blow the ceiling on round 0 or 1, landing here BEFORE the loop ever
        // reaches `lastRound` (which is what normally forces a plain-text reply by stripping `tools` from
        // the request). That used to be completely silent — zero log line, same generic fallback text as
        // a genuine API failure, with no way to tell the two apart. Log it so it's diagnosable.
        console.error(`[chat] hit CHAT_TOKEN_CEILING at round ${round} (${result.tokens.in + result.tokens.out} tokens) — falling back`);
        break;
      }
      // LATENCY BUDGET (Primer only): the student is waiting. After PRIMER_BUDGET_MS of model rounds, or PRIMER_MAX_ROUNDS
      // rounds, stop tool use and the optional corrective rounds and just answer in plain words now.
      const lastRound = round === maxRounds - 1 || (!!opts?.primer && round > 0 && Date.now() - turnStartedAt > PRIMER_BUDGET_MS);
      const apiMessages = lastRound
        ? [...messages, { role: "user" as const, content: "Out of tool calls for this turn — reply in plain words now, no more tool use." }]
        : messages;
      let res: any;
      try {
        // Fewer/faster retries than the default (3 attempts, 1s+ backoff) — this is a live chat turn, not
        // a background sweep, and CHAT_DEADLINE_MS below is the real backstop anyway. retryRequest's loop
        // exits when `i === retries - 1`, so `retries: N` gives N-1 actual retries. `retries: 3` (two
        // retries) rather than the earlier `retries: 2` (one retry) — a real DeepSeek blip (a momentary
        // rate limit, a brief network hiccup) going straight to the generic fallback after a SINGLE retry
        // was still common enough to report; the deadline (120s) has ample room for one more attempt.
        // Gemini first, DeepSeek as the fallback — see createTutorChat's own comment. The model name is
        // per-provider now, so it is NOT passed here.
        res = await retryRequest(() => createTutorChat({
          max_tokens: OUT.chat, temperature: 0.6,
          messages: apiMessages,
          // The chat tool set is deliberately in-app only (CREATE_*/web_search) — NEVER Composio. A tutoring
          // chat must not be able to touch the student's connected accounts, unlike runTask's tool set.
          ...(lastRound ? {} : { tools: (forceArtifactTools && !includeArtifactTools ? [CREATE_NOTE_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_QUIZ_TOOL, ...tools] : tools).map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })) }),
        }, !!opts?.primer), opts?.primer ? 2 : 3, 400);
      } catch (e: any) {
        // This used to swallow the real error completely — the ONLY visible symptom was every chat
        // message (even "hello") silently landing on the generic fallback line, with nothing in server
        // logs to diagnose why (bad/expired DEEPSEEK_API_KEY, wrong DEEPSEEK_MODEL, DeepSeek outage, a
        // non-transient error retryRequest gave up on immediately). Log it so a platform's function logs
        // actually show the cause next time instead of a dead end. Still never throws to the route — the
        // honest fallback line is still the right thing to show the student either way.
        console.error(`[chat] DeepSeek request failed: ${e?.message || e}`);
        return finish("");
      }
      { const u = usageOf(res); result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn = (result.tokens.cachedIn || 0) + u.cachedIn; }
      const toolCalls = res.choices?.[0]?.message?.tool_calls || [];
      let textContent = res.choices?.[0]?.message?.content || "";
      // The hidden plan (tutorBrain.ts): captured, then stripped — the student, TTS and the stored thread never
      // see it. The newest plan wins (a re-plan after a correction replaces the vetoed one).
      const rawContent = textContent;
      if (opts?.primer) { const ex = extractPlan(textContent); if (ex.plan) result.plan = ex.plan; textContent = ex.reply; }
      // FULLY SOCRATIC = THE POLICY IS CONSULTED EVERY TURN. Validation below only has something to check
      // when the model wrote a <plan>; a turn that reaches here with NONE could hand over a level-6
      // explanation while the policy allows one rung of help, and nothing would look at it. So a tutor turn
      // with no plan gets ONE corrective round demanding it (latched — a model that still omits it falls
      // through to the other guards rather than spinning).
      if (opts?.primer && opts?.policy && !planCorrected && !planMissing && !lastRound && !result.plan && (toolCalls.length || textContent.trim())) {
        planMissing = true;
        console.log(`${new Date().toISOString()} [chat] round ${round}: tutor turn with no <plan> — asking for it so this turn's help can be checked against the policy`);
        if (toolCalls.length) {
          messages.push({ role: "assistant", content: rawContent, tool_calls: toolCalls });
          for (const tc of toolCalls) messages.push({ role: "tool", tool_call_id: tc.id || `tool_${Date.now()}`, content: "NOT RUN — no plan to check (see next message)." });
        } else messages.push({ role: "assistant", content: rawContent });
        messages.push({ role: "user", content: "TUTOR POLICY CHECK — you wrote no <plan>, so this turn's move could not be checked against how much help is allowed right now. Write the <plan> FIRST (HOW YOU THINK EACH TURN), then your reply and any board writes. Don't mention this check." });
        continue;
      }
      // THE APPLICATION'S VETO: a plan that gives more help than the policy allows this turn (or answers an
      // answer-request the student hasn't attempted) never executes — its tool calls are refused unrun and the
      // model re-plans once. This is the "LLM decides, app validates" line of spec §19/§20.
      if (opts?.primer && opts?.policy && !planCorrected && !lastRound && result.plan) {
        const v = validatePlan(result.plan, opts.policy);
        if (!v.ok) {
          planCorrected = true;
          result.planCorrection = { from: result.plan.action, reason: v.reason };
          console.log(`${new Date().toISOString()} [chat] round ${round}: plan ${result.plan.action} vetoed by tutor policy — ${v.reason}`);
          if (toolCalls.length) {
            messages.push({ role: "assistant", content: rawContent, tool_calls: toolCalls });
            for (const tc of toolCalls) messages.push({ role: "tool", tool_call_id: tc.id || `tool_${Date.now()}`, content: "NOT RUN — tutor policy check failed (see next message)." });
          } else messages.push({ role: "assistant", content: rawContent });
          messages.push({ role: "user", content: `TUTOR POLICY CHECK — your plan was not accepted: ${v.reason} Write a NEW <plan> that respects the policy, then your reply (and any board writes). Don't mention this check.` });
          continue;
        }
      }
      if (!toolCalls.length && !textContent.trim()) {
        // Genuinely empty completion, no tool call either — DeepSeek v4's hidden reasoning tokens ate the
        // WHOLE max_tokens budget before a single reply token came out (the same trap documented on OUT/
        // studyHelp above), not a real "nothing to say". This used to fall straight to the generic fallback
        // line on the very first empty response; retry ONCE with tools stripped (nothing left to reason
        // about calling) and a plain instruction — the same fallback-retry pattern used for flashcards/
        // studylog generation — before actually giving up. Only fires on the rare empty response, so it
        // never adds latency/cost to the normal path.
        console.log(`${new Date().toISOString()} [chat] round ${round}: empty completion, retrying once with tools stripped`);
        try {
          // Bumped budget on this retry (was a flat OUT.chat, same as the attempt that just failed) — if
          // THAT budget wasn't enough for reasoning-about-a-tool-result once, resending the identical
          // ceiling and hoping for a shorter reasoning pass is optimism, not a real second chance. 1.5x
          // gives the retry actual extra headroom instead of just re-rolling the same dice.
          const retryRes: any = await retryRequest(() => createTutorChat({
            max_tokens: Math.round(OUT.chat * 1.5), temperature: 0.6,
            messages: [...apiMessages, { role: "user" as const, content: "Reply in plain words now — no tool use." }],
          }, false), 1, 400);
          const u = usageOf(retryRes);
          result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn = (result.tokens.cachedIn || 0) + u.cachedIn;
          textContent = retryRes.choices?.[0]?.message?.content || "";
          // A turn that just gathered several tool results (e.g. multiple web_search calls for different
          // items) can still come back empty here — reasoning through how to SYNTHESIZE all of it can itself
          // exhaust max_tokens, even with tools stripped. One more attempt, explicitly asking for the
          // shortest possible answer, needs far less headroom to actually fit — this is what used to reach
          // the user as a hard "Otto couldn't reply" 502 despite nothing having actually failed. Budget
          // bumped again (2x base) for the same reason as the retry above.
          if (!textContent.trim()) {
            console.log(`${new Date().toISOString()} [chat] round ${round}: second empty completion, retrying once more asking for ONE short sentence`);
            const shortRes: any = await retryRequest(() => createTutorChat({
              max_tokens: OUT.chat * 2, temperature: 0.6,
              messages: [...apiMessages, { role: "user" as const, content: "Reply in ONE short sentence only — just the single most useful fact/answer, no explanation, no formatting." }],
            }, false), 1, 400);
            const u2 = usageOf(shortRes);
            result.tokens.in += u2.in; result.tokens.out += u2.out; result.tokens.cachedIn = (result.tokens.cachedIn || 0) + u2.cachedIn;
            textContent = shortRes.choices?.[0]?.message?.content || "";
          }
        } catch (e: any) { console.error(`[chat] empty-completion retry also failed: ${e?.message || e}`); }
        return finish(textContent);
      }
      if (!toolCalls.length) {
        // Reported live, verbatim: "it's on your screen now, just above" — with nothing on the board at
        // all, because the model narrated a visual it never actually created. A student staring at an empty
        // space being told to read something off it is worse than no visual at all. Give it exactly one
        // chance to make the claim true (write the thing) or drop the claim, instead of shipping the lie.
        const claimsDiagram = CHAT_CLAIMS_DIAGRAM.test(textContent);
        const hasDiagram = result.board.some((e) => e.kind === "diagram");
        if (!boardClaimCorrected && !lastRound && ((CHAT_CLAIMS_BOARD.test(textContent) && !result.board.length && !result.problems.length) || (claimsDiagram && !hasDiagram))) {
          boardClaimCorrected = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: reply points at the ${claimsDiagram ? "diagram" : "board"} but nothing was written — asking for the actual write`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: claimsDiagram
            ? "You just referred to a graph/diagram/figure you drew, but you never called DRAW_ON_BOARD this " +
              "turn — there is literally nothing for them to look at. Either call DRAW_ON_BOARD with that " +
              "exact figure right now, or rewrite your reply without referring to anything drawn. Same short " +
              "spoken tone, don't mention this correction."
            : "You just pointed them at something on the board/screen, but you never wrote anything there this " +
              "turn — there is literally nothing for them to look at. Either call WRITE_TO_BOARD (or " +
              "CREATE_PROBLEM if it's a problem) with that exact content right now, or rewrite your reply " +
              "without referring to anything visible. Same short spoken tone, don't mention this correction." });
          continue;
        }
        // Reported live, verbatim: a reply ending mid-sentence ("One version with a twist, to make sure the
        // method travels:") with nothing after the colon — DeepSeek v4's hidden reasoning tokens (see OUT's
        // own comment) had already spent most of max_tokens before the visible reply started, so the reply
        // itself hit the ceiling and finish_reason came back "length" with a genuinely non-empty (so the
        // empty-completion retry above never fires), but truncated, reply. One retry, same conversation,
        // asking it to actually finish the thought concisely rather than restart or pad — a truncated tutor
        // reply mid-example is worse than a slightly shorter complete one.
        if (!truncationRetried && res.choices?.[0]?.finish_reason === "length" && textContent.trim()) {
          truncationRetried = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: reply hit finish_reason 'length' — retrying once for a complete, concise reply`);
          try {
            const contRes: any = await retryRequest(() => createTutorChat({
              max_tokens: OUT.chat, temperature: 0.6,
              messages: [...apiMessages, { role: "assistant" as const, content: textContent },
                { role: "user" as const, content: "That got cut off. Continue from EXACTLY where it stopped — a couple of short sentences, concisely — don't restart or repeat what you already said, just complete the thought." }],
            }, false), 2, 400);
            const u = usageOf(contRes);
            result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn = (result.tokens.cachedIn || 0) + u.cachedIn;
            const completion = contRes.choices?.[0]?.message?.content?.trim();
            // Append, don't replace — the continuation call only ever sees "finish this", so its own
            // response is just the missing tail, not a repeat of the part that already arrived.
            if (completion) textContent = `${textContent.trim()} ${completion}`;
          } catch (e: any) { console.error(`[chat] truncation retry failed: ${e?.message || e}`); }
        }
        // POST-REPLY TRUTH PASS — the code-level backstops for the NEVER WRONG / brevity rules in the
        // prompt, living in THIS branch deliberately: the no-tool reply is the only shape a final draft
        // ever takes (a tool round always loops again and lands here), so this is where the LAST look at
        // what actually ships belongs — after the truncation retry, so the completed text is what's
        // verified. Same shape as the empty-board-claim fix above: gate → one corrective round → latched
        // (arithCorrected/factCorrected/lengthRetried), so a single draft can't burn CHAT_MAX_ROUNDS.
        // (1) ARITHMETIC (CoVe executed in code, Dhuliawala et al. 2023): the draft's asserted equalities
        // are re-derived by the deterministic evaluator in server/arithmetic.ts — an INDEPENDENT oracle,
        // per Huang et al. 2024 (the model re-reading its own draft is exactly the self-correction that
        // doesn't work). Gated by findArithmeticClaims: a plain-chat turn parses text and pays zero extra
        // rounds.
        const arithMismatches = !arithCorrected && !lastRound
          ? findArithmeticClaims(textContent).filter((c) => c.mismatch)
          : [];
        if (arithMismatches.length) {
          arithCorrected = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: draft asserts ${arithMismatches.length} incorrect arithmetic claim(s) — asking for a rewrite`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: `Independent recomputation of your draft found arithmetic that does not check out: ${arithMismatches.map((c) => `"${c.lhs}" is ${c.left}, but you wrote it equals ${c.right}`).join("; ")}. Rewrite the affected lines with the correct value(s) — recompute any number you are not certain of with CREATE_CALC first. Same short spoken tone, same tutoring moves, don't mention this correction.` });
          continue;
        }
        // (2) FACT ASSERTIONS (Kadavath 2022 calibration, enforced): a confident unique-fact shape
        // (attribution / invention / dated discovery) that never went through web_search this turn gets
        // one chance to verify-or-hedge, instead of shipping a confident half-memory to an exam.
        if (!factCorrected && !lastRound && CHAT_ASSERTS_FACT.test(textContent) && !result.audit.some((a) => a.kind === "tool" && /web search|Recherche web/i.test(a.label))) {
          factCorrected = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: draft confidently asserts a unique fact without having searched — asking for verify-or-hedge`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: "Your draft states a specific fact (an attribution, invention, or dated event) as certain, but you haven't verified it this turn. Either web_search it now and keep the claim WITH the verified detail, or rewrite that sentence with honest uncertainty (\"de mémoire, je peux me tromper\"). If the fact isn't load-bearing for the tutoring move, drop it. Same short spoken tone, don't mention this correction." });
          continue;
        }
        // (3) LANGUAGE MISMATCH — code-level backstop (see detectLang's own comment for why: prompt wording
        // alone, tried twice, wasn't reliable enough). Only fires on a CONFIDENT mismatch in both
        // directions (the student's established language AND the draft's language both clearly detected,
        // and different) — never on an ambiguous draft (e.g. mostly numbers/symbols), same conservatism as
        // every other check here.
        const draftLang = studentLang !== "unknown" ? detectLang(textContent) : "unknown";
        if (!langCorrected && !lastRound && studentLang !== "unknown" && draftLang !== "unknown" && draftLang !== studentLang) {
          langCorrected = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: draft is in ${draftLang} but the student is writing in ${studentLang} — asking for a same-content rewrite`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: `That reply came out in the wrong language — the student is writing in ${studentLang === "fr" ? "French" : "English"}. Rewrite it in ${studentLang === "fr" ? "French" : "English"}, exact same content and tutoring move, don't mention this correction.` });
          continue;
        }
        // (4) LENGTH BACKSTOP (TALE): the 45-word budget is prompt-side; this catches the draft that
        // ignored it entirely. Silent compression, once, non-voice only (voice mode has its own stricter
        // TTS ceiling and its own retry paths above).
        if (opts?.primer && harshOpener(textContent)) textContent = (await rewriteReply(textContent, `it opens harshly ("${harshOpener(textContent)}"). Start instead with what's worth keeping in their thinking, or go straight to the question.`, message, result.tokens)) || textContent;
        if (opts?.primer && countWords(textContent) > 45) textContent = tightenForChat(textContent, 45);
        // Never say the same thing twice: a draft that is a near-copy of one of Otto's recent replies gets ONE
        // corrective round (the student already saw that and it did not land — repeating it is the loop).
        if (opts?.primer && !repeatCorrected && !lastRound && (repeatsRecentReply(textContent, history) || (repeatsRecentQuestion(textContent, history) && !isStuckLike(message)))) {
          repeatCorrected = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: draft repeats a recent reply — asking for a different approach`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: "That is almost exactly what you already said or asked and it did not land. If this is a question you already asked: do NOT ask it again — if the student has answered it, acknowledge that in a few words and move to the NEXT step; if they haven't, help with THAT question (a hint or a smaller version) instead of re-asking. Do NOT repeat it. In one short sentence say what you heard from the student, then try a DIFFERENT approach (a picture, a tiny worked case, or a different question), one question at most. Don't mention this instruction." });
          continue;
        }
        if (guardArtifactClaim(textContent, round, lastRound)) continue;
        if (guardAskedValue(textContent, round, lastRound)) continue;
        if (guardQuestion(textContent, round, lastRound)) continue;
      if (guardMissedCase(textContent, round, lastRound)) continue;
      if (guardHandedCalc(textContent, round, lastRound)) continue;
      if (guardRedraw(textContent, round, lastRound)) continue;
      if (guardAheadMath(textContent, round, lastRound)) continue;
      if (guardDrawRequest(textContent, round, lastRound)) continue;
      if (guardBoardUse(textContent, round, lastRound)) continue;
      if (guardNoDoing(textContent, round, lastRound)) continue;
      if (guardOwnAnswer(textContent, round, lastRound)) continue;
      if (guardAnswerWhy(textContent, round, lastRound)) continue;
      if (guardBoardContent(textContent, round, lastRound)) continue;
      if (guardProblemAsWidget(textContent, round, lastRound)) continue;
      if (guardListen(textContent, round, lastRound)) continue;
      if (guardGrounded(textContent, round, lastRound)) continue;
      if (guardEmptyPraise(textContent, round, lastRound)) continue;
      if (guardBoardLine(textContent, round, lastRound)) continue;
      if (guardInvented(textContent, round, lastRound)) continue;
      if (guardOwnArithmetic(textContent, round, lastRound)) continue;
        if (guardMissedCase(textContent, round, lastRound)) continue;
        if (guardHandedCalc(textContent, round, lastRound)) continue;
        if (guardRedraw(textContent, round, lastRound)) continue;
        if (guardAheadMath(textContent, round, lastRound)) continue;
        if (guardDrawRequest(textContent, round, lastRound)) continue;
        if (guardBoardUse(textContent, round, lastRound)) continue;
        if (guardNoDoing(textContent, round, lastRound)) continue;
        if (guardOwnAnswer(textContent, round, lastRound)) continue;
        if (guardAnswerWhy(textContent, round, lastRound)) continue;
        if (guardBoardContent(textContent, round, lastRound)) continue;
        if (guardProblemAsWidget(textContent, round, lastRound)) continue;
        if (guardListen(textContent, round, lastRound)) continue;
        if (guardGrounded(textContent, round, lastRound)) continue;
        if (guardEmptyPraise(textContent, round, lastRound)) continue;
        if (guardBoardLine(textContent, round, lastRound)) continue;
      if (guardBoardLine(textContent, round, lastRound)) continue;
        if (guardInvented(textContent, round, lastRound)) continue;
        if (guardOwnArithmetic(textContent, round, lastRound)) continue;
        if (guardGapAnswer(textContent, round, lastRound)) continue;
        if (guardOneQuestion(textContent, round, lastRound)) continue;
        if (guardPoseOnBoard(textContent, round, lastRound)) continue;
        if (nudgeReasoning(textContent, round, lastRound)) continue;
        if (!lengthRetried && !lastRound && !opts?.voiceMode && countWords(textContent) > 120) {
          lengthRetried = true;
          console.log(`${new Date().toISOString()} [chat] round ${round}: draft is ${countWords(textContent)} words — asking for a compressed rewrite`);
          messages.push({ role: "assistant", content: textContent });
          messages.push({ role: "user", content: "That reply is far too long for a chat turn — compress it to the single most useful tutoring move (a few short sentences; under ~60 words), keeping the one question at the end. Don't drop a question the student is mid-way through answering, and don't mention this instruction." });
          continue;
        }
        return finish(textContent);
      }
      messages.push({ role: "assistant", content: textContent, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const input = parseToolArgs(tc.function?.arguments);
        let content: string;
        const madeEnough = result.notes.length + result.flashcards.length + result.quizzes.length + result.problems.length >= CHAT_MAX_ARTIFACTS;
        if (name === "web_search") {
          content = await runWebSearch(input);
          logAudit("tool", fr ? `Recherche web : "${String((input as any)?.query || "").slice(0, 140)}"` : `Web search: "${String((input as any)?.query || "").slice(0, 140)}"`);
        }
        else if (name === "read_page") {
          content = await runReadPage(input);
          logAudit("tool", fr ? `Page lue : ${String((input as any)?.url || "").slice(0, 140)}` : `Read page: ${String((input as any)?.url || "").slice(0, 140)}`);
        }
        else if (name === "CREATE_CALC") {
          content = runCalcTool(input);
          logAudit("tool", fr ? `Vérifié au calculateur : "${String((input as any)?.expression || "").slice(0, 80)}"` : `Checked with calculator: "${String((input as any)?.expression || "").slice(0, 80)}"`);
        }
        else if (name === "CREATE_NOTE") {
          if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
          else {
            const r = makeNote(input);
            if ("error" in r) content = r.error;
            // A note is the obvious vector for "here's your essay, wrapped as a study aid" — check the BODY
            // itself, not just the eventual spoken reply (finish() only ever sees the reply text).
            else if (CHAT_DOES_WORK.test(r.note.body)) {
              content = "REJECTED: that reads like their graded work, not a study aid — a fiche is method/structure/prompts, never the finished essay or solved exercise. Make a structure with prompts instead.";
              result.guardrailTripped = true;
              logAudit("guardrail", fr
                ? "Tu as demandé quelque chose qui ressemblait à faire le travail à ta place — Otto a dit non et a fait un guide à la place."
                : "That looked like asking Otto to do the graded work for you — it said no and made a guide instead.");
            }
            else { result.notes.push(r.note); content = JSON.stringify({ ok: true, id: r.note.id }); logAudit("artifact", fr ? `Fiche créée : « ${r.note.title} »` : `Note created: "${r.note.title}"`); }
          }
        } else if (name === "CREATE_FLASHCARDS") {
          if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
          else { const r = makeDeck(input); if ("error" in r) content = r.error; else { result.flashcards.push(r.deck); content = JSON.stringify({ ok: true, id: r.deck.id, count: r.deck.cards.length }); logAudit("artifact", fr ? `Cartes créées : « ${r.deck.title} » (${r.deck.cards.length})` : `Flashcards created: "${r.deck.title}" (${r.deck.cards.length})`); } }
        } else if (name === "CREATE_QUIZ") {
          if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
          else { const r = makeQuiz(input); if ("error" in r) content = r.error; else { result.quizzes.push(r.quiz); content = JSON.stringify({ ok: true, id: r.quiz.id, count: r.quiz.questions.length }); logAudit("artifact", fr ? `Quiz créé : « ${r.quiz.title} » (${r.quiz.questions.length} questions)` : `Quiz created: "${r.quiz.title}" (${r.quiz.questions.length} questions)`); } }
        } else if (name === "FIND_SOURCE_QUESTION") {
          const found = await findSourceQuestions({ track: profile?.track, subject: task.sourceSubject, topic: String((input as any)?.topic || "") });
          content = found.length
            ? JSON.stringify(found.map((f) => ({ source: f.sourceName, url: f.url, title: f.title, excerpt: f.excerpt })))
            : "NONE: nothing usable from the registered sources for this topic — write the exercise yourself, without a sourceUrl.";
          logAudit("tool", fr ? `Source de questions : ${found.length} résultat(s)` : `Question source lookup: ${found.length} result(s)`);
        } else if (name === "CREATE_PROBLEM") {
          if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
          // Never set an exercise the student didn't ask for (the tutor started a friction-and-car problem nobody mentioned). The first turn of a
          // session and an explicit "another one / put a problem on the board / which problem?" are the only times Otto sets one.
          else if (opts?.primer && history.length >= 1 && !asksForProblem(message) && !asksWhichProblem(message) && !asksToMoveOn(message) && !studentProblemStatement(message)) content = NO_UNPROMPTED_EXERCISE;
          // Same content-level dedupe as WRITE_TO_BOARD (isDuplicateBoardEntry) — checked against BOTH what
          // the student already sees (opts.currentProblems, delivered live every turn) and what this same
          // turn already made (result.problems), so a repeat is caught whether it's an old or a brand-new
          // duplicate.
          // ONE exercise at a time: while the student still has an unanswered one on the board, no new one — unless
          // they explicitly asked to move on / get another.
          else if (opts?.primer && !asksToMoveOn(message) && !asksForProblem(message) && [...(opts?.currentProblems || []).filter((p) => !p.solved), ...result.problems].length > 0) content = "REJECTED: they haven't answered the exercise already on the board — don't pile another on top. Help them with THAT one (a hint, a smaller question). Only create a new exercise once they've answered it or explicitly ask to skip / move on / get another.";
          else if (isDuplicateProblem([...(opts?.currentProblems || []), ...result.problems], input)) content = "DUPLICATE: that exact problem is already on the board — it's already there for them to answer, don't make it again.";
          // Same setup-ahead rule the reply's guardAheadMath has: the created question must not carry the
          // substituted equation the student was going to build (live: "$KE_f = ½(1200)(25)² = ?" shipped inside the
          // question and opened the session with their first move already done). Their reach comes only from what
          // they've said and the problems/board itself — the same launder-guard ownGivens uses everywhere else.
          else if (opts?.primer && questionAhead(String(input?.question || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard, ...(opts?.opening || []).map((m) => m.text), ...(opts?.currentBoard || []).filter((e) => e.owner === "student").map((e) => e.text), ...(opts?.currentProblems || []).map((p) => p.question)]).length)
            content = "REJECTED: that exercise hands them the equation they were going to build — the substituted setup is inside the question itself. State the situation and what to find in words (or the raw given line, e.g. '$E_k = \\frac{1}{2} m v^2 = ?$' only when THEY have already named that relationship); never pre-build the first equation for them. Let THEM set it up.";
          else { const r = makeProblem(input, !!opts?.primer); if ("error" in r) content = r.error; else { result.problems.push(r.problem); content = JSON.stringify({ ok: true, id: r.problem.id }); logAudit("artifact", fr ? `Problème créé : « ${r.problem.question.slice(0, 60)} »` : `Problem created: "${r.problem.question.slice(0, 60)}"`); } }          } else if (name === "CLEAR_BOARD") {
          // Nothing is ever erased: the student's working stays. Reported live — Otto announced "let's clear the
          // board" and the working was gone. The board only grows.
          content = "REJECTED: the board is never cleared — their working stays. Keep every existing entry, and add the new focus line for the new topic.";
        } else if (name === "WRITE_TO_BOARD") {
          if (input && typeof (input as any).text === "string") (input as any).text = repairLatex((input as any).text); // typeset only AFTER the leak / ahead-of-student checks below (they read the plain text)
          // Deliberately NOT gated by madeEnough/CHAT_MAX_ARTIFACTS — a board entry is meant to be cheap
          // and frequent (a short instruction, a formula, a running summary), not a heavyweight artifact
          // like a note/deck/quiz. Capping it the same way would defeat "always accessible, write anything
          // anytime". A generous per-turn cap of its own still applies, just to stop a genuinely broken
          // response from spamming dozens of entries in one turn.
          if (opts?.primer && asksForProblem(message) && !result.problems.length && ["given", "gap", "note", "instruction", "focus"].includes(String((input as any)?.kind)) && looksLikeGivensOrScenario(String((input as any)?.text || ""))) content = "REJECTED: they asked for a PROBLEM — create it first with CREATE_PROBLEM (the full statement with every given, one final answer: a bare number with its precision and unit in the hint, or multiple choice). The givens appear with the exercise; do not write them on the board as plain text instead.";
          else if (opts?.primer && history.length >= 1 && !asksForProblem(message) && !asksWhichProblem(message) && !asksToMoveOn(message) && !studentProblemStatement(message) && ["given", "gap", "note", "instruction", "focus", "result"].includes(String((input as any)?.kind)) && startsNewProblem(String((input as any)?.text || ""), [...(opts?.currentBoard || []).map((e) => e.text), ...(opts?.currentProblems || []).map((p) => p.question), ...result.board.map((e) => e.text), ...history.map((h) => h.text), message])) content = NO_UNPROMPTED_EXERCISE;
          else if (opts?.primer && history.length >= 1 && ["given", "result", "summary", "focus"].includes(String((input as any)?.kind)) && inventedNumbers(String((input as any)?.text || ""), [message, ...heard, ...history.map((h) => h.text), ...(opts?.opening || []).map((m) => m.text), ...ownGivens(), ...(opts?.currentBoard || []).map((e) => e.text), ...result.board.map((e) => e.text), ...result.problems.map((p) => p.question)]).length) content = "REJECTED: that board line has numbers nobody gave — the student, the problem and the board are the only source of numbers. Stay on the CURRENT FOCUS; write only what they said or the problem states, or ask them for the next step.";
          else if (opts?.primer && ["summary", "result", "given", "note", "insight"].includes(String((input as any)?.kind)) && echoesStudentWords(String((input as any)?.text || ""), message)) content = "REJECTED: that line copies the student's own words. The board shows clean MATHS, never a transcript of what they said — rewrite it as just the equation or value in LaTeX between $…$ (e.g. $\\tan(25^\\circ) = \\frac{h}{b}$), with no words from their sentence, or write nothing.";
          else if (result.board.length >= 3) content = "LIMIT: three entries is a full turn on the board (setting up a new problem — the given, the question, one starting line — is exactly three). Keep what's up there and put the rest in your reply.";
          // "How you got there" is the STUDENT's reasoning: a line carrying a π-term / root / fraction that nothing the
          // student said (and no given) contains is a step the TUTOR took for them — refuse it.
          else if (opts?.primer && !asksToWrite(message) && ["summary", "result"].includes(String(input?.kind)) && traceAheadOfStudent(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], [...(opts?.currentBoard || []).filter((e) => e.kind !== "summary").map((e) => e.text), ...(opts?.currentProblems || []).map((p) => p.question)]).length) {
            const missing = traceAheadOfStudent(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], [...(opts?.currentBoard || []).filter((e) => e.kind !== "summary").map((e) => e.text), ...(opts?.currentProblems || []).map((p) => p.question)]);
            content = `REJECTED: "How you got there" and "result" entries record only what the STUDENT has actually said or done, and this line contains ${missing.join(", ")} which they never reached — that's a step you'd be taking for them. Write only the steps they've stated (in your own words). If they haven't got there yet, write nothing and ask them the question instead.`;
          }
          // The tutor must not BUILD the setup equation for them ("x·tan40° = (x+500)·tan25°" appearing out of nowhere is the
          // tutor doing the work): a worked-out equation piece nobody said and no given contains is refused.
          else if (opts?.primer && !["given", "focus"].includes(String(input?.kind)) && String(input?.owner) !== "student" && equationAhead(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens()).length) {
            const missing = equationAhead(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens());
            content = `REJECTED: this writes an equation step (${missing.join(", ")}) that the student never reached — building the setup is THEIR work. Don't write it; ask the question that gets them to produce it (e.g. "what ratio links h, the angle and that distance?") and write their line once they say it.`;
          }
          // The tutor must not put the METHOD on the board ("tan θ = |m1 − m2| / (1 + m1m2)") before the student reached for it, unless they
          // asked for help — the board is where their own reasoning goes, not where the tutor hands over the approach.
          else if (opts?.primer && opts?.policy && opts.policy.maxLevel <= 3 && !wantsHelp(message) && !["given", "focus", "instruction"].includes(String(input?.kind)) && String(input?.owner) !== "student" && methodAhead(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), message, ...ownGivens()]).length) {
            const ahead = methodAhead(String(input?.text || ""), [...history.filter((h) => h.role === "user").map((h) => h.text), message, ...ownGivens()]);
            content = `REJECTED: this writes the method (${ahead.join(", ")}) before the student reached for it. Don't put it up — ask the question that gets THEM to say which relationship connects what they have, then write their idea.`;
          }
          // KEEP THE BOARD FOR WHAT MATTERS. While the help level is low, Otto doesn't pin formulas, notes, definitions or insights the
          // student didn't ask for — the board is for the problem, their own work and what they asked to see (reported live: "Got the
          // formula up there" before they'd said a word about method; a clarifying question must never add anything new to the board).
          else if (opts?.primer && opts?.policy && opts.policy.maxLevel <= 3 && !wantsHelp(message) && !asksToWrite(message) && ["formula", "note", "definition", "insight", "outline"].includes(String(input?.kind || "note")) && String(input?.owner) !== "student") {
            content = "REJECTED: that's your own material, not something they asked for or worked out — keep the board for the problem and THEIR steps. Say it in chat as a question instead, or wait until they reach for it.";
          }
          else if (opts?.primer && clarificationTerm(message) && String(input?.owner) !== "student" && !["given", "focus"].includes(String(input?.kind))) {
            content = "REJECTED: they asked what something means — answer in chat; don't add anything to the board for a clarifying question.";
          }
          // Content-level duplicate check — the client can only dedupe by id,
          // and every write gets a fresh UUID, so a re-written formula previously stacked a second visual
          // copy. Checked against BOTH what the student already sees (opts.currentBoard, delivered live
          // every turn) and what this same turn already wrote (result.board) — returning the guidance as
          // the tool result lets the model adapt mid-turn instead of burning the write.
          else if (isDuplicateBoardEntry([...(opts?.currentBoard || []), ...result.board], input)) content = "DUPLICATE: that exact entry is already on the board — refer to it in your reply instead of writing it again.";
          // Reported live: a "summary" entry stated a problem's full worked answer (including a LATER part's
          // value, e.g. "cos 2θ = 7/25") while the student was still working through an EARLIER part in
          // chat — see leaksAnyProblemAnswer's own comment. Checked against every problem currently in play,
          // same "both what they already see and what this turn made" scope as the duplicate check above.
          else if (leaksAnyProblemAnswer(String(input?.text || ""), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that states a problem's answer outright — rewrite this entry without that value. The answer only shows once they solve the problem themselves, in its own widget.";
          else if (boardRepeatsMishearing(String(input?.text || ""), spokenRepair)) content = `REJECTED: that line repeats a speech-recognition slip ("${boardRepeatsMishearing(String(input?.text || ""), spokenRepair)}") — write what the student MEANT, typeset in $…$ (see SPOKEN INPUT), then call WRITE_TO_BOARD again.`;
          else { if (input && typeof (input as any).text === "string") (input as any).text = latexifyBoardLine((input as any).text, String((input as any).kind)); const r = makeBoardEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Écrit au tableau : « ${r.entry.text.slice(0, 60)} »` : `Written to board: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "DRAW_ON_BOARD") {
          // Its own smaller cap, separate from WRITE_TO_BOARD's — a figure is heavier to render (SVG, not
          // text) and a turn with several genuine diagrams is already an unusual turn.
          if (result.board.filter((e) => e.kind === "diagram").length >= 3) content = "LIMIT: you've already drawn a few figures this message — that's enough for one turn.";
          else if (opts?.primer && equationAhead((Array.isArray(input?.ops) ? input.ops : []).filter((o: any) => o?.op === "equation").map((o: any) => String(o?.latex || "")).join(" ; "), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens()).length) content = "REJECTED: that figure contains an equation step the student never reached — building the setup is THEIR work. Draw the situation without it and ask them to build the equation.";
          // Same answer-leak guard as WRITE_TO_BOARD above — a figure's caption or an equation/label op can
          // state a value just as plainly as prose can.
          else if (leaksAnyProblemAnswer([input?.caption, ...(Array.isArray(input?.ops) ? input.ops.map((o: any) => `${o?.text || ""} ${o?.latex || ""}`) : [])].join(" "), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that figure states a problem's answer outright — redraw it without that value.";
          else { const r = makeDiagramEntry(input); if ("error" in r) content = r.error; else if (isDuplicateDiagram([...(opts?.currentBoard || []), ...result.board], r.entry)) content = "DUPLICATE: that exact figure/equation is already on the board — point at it in your reply instead of drawing it again (draw again only to ADD something new)."; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Figure dessinée : « ${r.entry.text.slice(0, 60)} »` : `Diagram drawn: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "GEOMETRY_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "diagram").length >= 3) content = "LIMIT: you've already drawn a few figures this message — that's enough for one turn.";
          else if (leaksAnyProblemAnswer([input?.caption, ...(Array.isArray(input?.segments) ? input.segments.map((x: any) => (typeof x === "object" ? x?.label : "")) : []), ...(Array.isArray(input?.angles) ? input.angles.map((x: any) => x?.label) : []), ...(Array.isArray(input?.arcs) ? input.arcs.map((x: any) => x?.label) : []), ...(Array.isArray(input?.circles) ? input.circles.map((x: any) => x?.label) : [])].filter(Boolean).join(" "), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that figure labels a problem's answer — redraw it with the unknown shown as '?'.";
          else { const r = makeGeometryEntry(input); if ("error" in r) content = r.error; else if (isDuplicateDiagram([...(opts?.currentBoard || []), ...result.board], r.entry)) content = "DUPLICATE: that exact figure is already on the board — point at it in your reply instead of drawing it again (draw again only to ADD something new)."; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Figure dessinée : « ${r.entry.text.slice(0, 60)} »` : `Diagram drawn: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "ANNOTATE_BOARD") {
          const all = [...(opts?.currentBoard || []), ...result.board];
          const hit = resolveBoardTarget(String((input as any)?.target || ""), all);
          const note = String((input as any)?.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
          const tone = ["error", "hint", "good", "focus"].includes((input as any)?.tone) ? (input as any).tone : "focus";
          if (!hit) content = "ERROR: no such board entry — use a #n from the board listing.";
          else if (!hit.id) content = "ERROR: that entry can't be pointed at yet.";
          else if (!note) content = "ERROR: a pointer needs a short note.";
          else if (result.board.filter((e) => e.kind === "annotation").length >= 2) content = "LIMIT: two pointers per turn is plenty.";
          else if (leaksAnyProblemAnswer(note, [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that note states a problem's answer — point and ask, don't tell.";
          else { result.board.push({ id: randomUUID(), text: note, kind: "annotation", targetId: hit.id, tone, owner: "otto", at: new Date().toISOString() } as BoardEntry); content = JSON.stringify({ ok: true }); logAudit("artifact", fr ? `Annotation : « ${note.slice(0, 60)} »` : `Pointed at the board: "${note.slice(0, 60)}"`); }
        } else if (name === "GRAPH_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "graph").length >= 2) content = "LIMIT: you've already put a couple of graphs on the board this message — that's enough for one turn.";
          else if (leaksAnyProblemAnswer([input?.caption, ...(Array.isArray(input?.fns) ? input.fns.map((f: any) => f?.label || "") : [])].join(" "), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that graph's caption or labels state a problem's answer — title it by what to explore, not by the result.";
          else { const r = makeGraphEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Graphique : « ${r.entry.text.slice(0, 60)} »` : `Graph: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "TRIG_SCENE_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "svg").length >= 2) content = "LIMIT: that's enough figures for one turn.";
          else {
            const inp: any = input || {};
            const caption = String(inp.caption || "").trim().slice(0, 200) || (fr ? "Situation" : "The situation");
            const built = buildTrigScene({ mode: inp.mode, observers: Array.isArray(inp.observers) ? inp.observers : [], separation: inp.separation, towerHeight: inp.towerHeight, unknownTop: typeof inp.unknownTop === "string" ? inp.unknownTop.slice(0, 3) : undefined, distance: inp.distance, baseName: inp.baseName, topName: inp.topName, units: inp.units });
            if ("error" in built) content = built.error;
            else {
              const svg = sanitizeSvg(built.svg);
              if (!svg) content = "ERROR: couldn't build that scene.";
              else {
                const entry: BoardEntry = { id: randomUUID(), text: caption, kind: "svg", svg, facts: built.facts, at: new Date().toISOString() };
                result.board.push(entry);
                content = JSON.stringify({ ok: true, id: entry.id, geometry: built.facts, note: "Drawn to scale with only the GIVEN angles marked (the equal angle at the ground is for the student to find). Now ask ONE question; don't state values they haven't found." });
                logAudit("artifact", fr ? `Figure : « ${caption.slice(0, 60)} »` : `Figure: "${caption.slice(0, 60)}"`);
              }
            }
          }
        } else if (name === "SOLID_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "svg").length >= 2) content = "LIMIT: that's enough figures for one turn.";
          else {
            const inp: any = input || {};
            const caption = String(inp.caption || "").trim().slice(0, 200) || (fr ? "Solide" : "The solid");
            const built = buildSolid({ shape: inp.shape, width: inp.width, height: inp.height, depth: inp.depth, radius: inp.radius, dims: inp.dims && typeof inp.dims === "object" ? inp.dims : undefined, labels: inp.labels, highlight: Array.isArray(inp.highlight) ? inp.highlight : undefined });
            if ("error" in built) content = built.error;
            else {
              const svg = sanitizeSvg(built.svg);
              if (!svg) content = "ERROR: couldn't build that solid.";
              else {
                const entry: BoardEntry = { id: randomUUID(), text: caption, kind: "svg", svg, facts: built.facts, at: new Date().toISOString() };
                result.board.push(entry);
                content = JSON.stringify({ ok: true, id: entry.id, geometry: built.facts, note: "Drawn to scale in oblique projection with only the GIVEN dimensions labelled. Now ask ONE question; don't state values they haven't found." });
                logAudit("artifact", fr ? `Solide : « ${caption.slice(0, 60)} »` : `Solid: "${caption.slice(0, 60)}"`);
              }
            }
          }
        } else if (name === "SVG_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "svg").length >= 2) content = "LIMIT: that's enough figures for one turn.";
          else if (leaksAnyProblemAnswer(`${input?.caption || ""} ${svgText(sanitizeSvg(String(input?.svg || "")))}`, [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that figure labels a problem's answer outright — redraw it with the unknown shown as '?'.";
          else if (opts?.primer && equationAhead(svgText(sanitizeSvg(String(input?.svg || ""))), [...history.filter((h) => h.role === "user").map((h) => h.text), ...heard], ownGivens()).length) content = "REJECTED: that figure contains an equation step the student never reached — draw the situation (givens and unknowns) without it.";
          else { const r = makeSvgEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Figure : « ${r.entry.text.slice(0, 60)} »` : `Figure: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "FLOW_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "flow").length >= 2) content = "LIMIT: that's enough diagrams for one turn.";
          else if (leaksAnyProblemAnswer(JSON.stringify(input || {}), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that diagram states a problem's answer outright — label the boxes without the value.";
          else { const r = makeFlowEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Schéma : « ${r.entry.text.slice(0, 60)} »` : `Diagram: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "TABLE_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "table").length >= 2) content = "LIMIT: enough tables for one turn.";
          else if (leaksAnyProblemAnswer(JSON.stringify(input || {}), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that table states a problem's answer outright — leave that cell out.";
          else { const r = makeTableEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); } }
        } else if (name === "SOURCE_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "source").length >= 1) content = "LIMIT: one source per turn.";
          else { const r = makeSourceEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); } }
        } else if (name === "WIDGET_ON_BOARD") {
          if (result.board.filter((e) => e.kind === "widget").length >= 1) content = "LIMIT: one activity per turn — let them do this one first.";
          else if (leaksAnyProblemAnswer(JSON.stringify(input || {}), [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that activity states a problem's answer outright — build it around different content.";
          else { const r = makeWidgetEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Activité : « ${r.entry.text.slice(0, 60)} »` : `Activity: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "CREATE_INTERACTIVE") {
          // Own small cap, separate from WRITE_TO_BOARD/DRAW_ON_BOARD's — this is the heaviest entry kind
          // (a whole embedded iframe), and a session needing more than a couple is almost certainly
          // reaching for this as a default instead of the rare, deliberate tool it's meant to be.
          if (result.board.filter((e) => e.kind === "interactive").length >= 2) content = "LIMIT: you've already created an interactive artifact this message — that's enough for one turn.";
          // Same answer-leak guard as WRITE_TO_BOARD/DRAW_ON_BOARD above — an embedded scene's labels/text
          // can state a value just as plainly as prose can.
          else if (leaksAnyProblemAnswer(`${input?.caption || ""} ${input?.html || ""}`, [...(opts?.currentProblems || []), ...result.problems])) content = "REJECTED: that scene states a problem's answer outright — rebuild it without that value.";
          else { const r = makeInteractiveEntry(input); if ("error" in r) content = r.error; else { result.board.push(r.entry); content = JSON.stringify({ ok: true, id: r.entry.id }); logAudit("artifact", fr ? `Scène interactive créée : « ${r.entry.text.slice(0, 60)} »` : `Interactive scene created: "${r.entry.text.slice(0, 60)}"`); } }
        } else if (name === "SET_OBJECTIVES") {
          const r = makeObjectives(input);
          if ("error" in r) content = r.error;
          else { result.objectives = r.objectives; content = JSON.stringify({ ok: true, count: r.objectives.length }); logAudit("artifact", fr ? `Objectifs mis à jour (${r.objectives.length})` : `Objectives updated (${r.objectives.length})`); }
        } else if (name === "remember") {
          const category = String((input as any)?.category || "preference");
          const fact = String((input as any)?.fact || "").trim();
          if (!fact) content = "ERROR: fact was empty.";
          else if (!profile) content = "ok"; // no profile on this request (shouldn't normally happen) — silently no-op rather than error, since this never blocks the actual reply
          else {
            applyRememberFact(profile, category, fact);
            content = "saved";
            logAudit("tool", fr ? `Retenu : ${fact.slice(0, 140)}` : `Remembered: ${fact.slice(0, 140)}`);
          }
        } else if (readOnlyExtras?.tools.some((t) => t.name === name)) {
          // A real connected-account call (e.g. GMAIL_FETCH_EMAILS) — unlike the in-app tools above, this is
          // genuine external network latency on top of DeepSeek's own, against the same CHAT_DEADLINE_MS
          // budget. A 15s cap here means one slow Composio call degrades to "couldn't check that" instead of
          // silently eating the whole turn's time budget by itself.
          try {
            const r = await Promise.race([
              readOnlyExtras!.call(String(name), input || {}),
              new Promise<string>((resolve) => setTimeout(() => resolve("ERROR: timed out — try asking again."), 15_000)),
            ]);
            content = r ?? "ERROR: that didn't return anything.";
            logAudit("tool", fr ? `Recherche dans un compte connecté : ${String(name)}` : `Searched a connected account: ${String(name)}`);
          } catch (e: any) { content = `ERROR: ${e?.message || "that call failed"}.`; }
        } else content = "ERROR: unknown tool.";
        messages.push({ role: "tool", tool_call_id: tc.id || `tool_${Date.now()}`, content: untrustedToolResult(String(content).slice(0, 2000)) });
      }
      // The board's reasoning-trace rule, enforced in code (same posture as the empty-board-claim fix in
      // the no-tool branch below — the prompt line alone was ignored live: Otto confirmed the student's
      // own trig step in chat and wrote nothing, so the board never showed THEIR reasoning or the formula
      // in play). ONE corrective round, latched, same shape as that fix: add the entry, or continue
      // unchanged if the exchange genuinely produced nothing board-worthy.
      if (guardArtifactClaim(textContent, round, lastRound)) continue;
      if (guardAskedValue(textContent, round, lastRound)) continue;
      if (guardQuestion(textContent, round, lastRound)) continue;
      if (guardGapAnswer(textContent, round, lastRound)) continue;
      if (guardOneQuestion(textContent, round, lastRound)) continue;
      if (guardPoseOnBoard(textContent, round, lastRound)) continue;
      if (nudgeReasoning(textContent, round, lastRound)) continue;
      if (!boardNudgeDone && !lastRound && shouldNudgeBoardWrite(textContent, message, result.board.length > 0)) {
        boardNudgeDone = true;
        console.log(`${new Date().toISOString()} [chat] round ${round}: reply confirms the student's math step but nothing was written to the board — asking for the write`);
        messages.push({ role: "assistant", content: textContent });
        messages.push({ role: "user", content: "You just confirmed the student's own step was right, and there's math in play — but you didn't write anything on the board this turn. The session document should show THEIR reasoning and the formula in play, not just your explanations. Call WRITE_TO_BOARD now with ONE short entry — the step they got right (kind:\"insight\", their construction/words) or the formula the step established (kind:\"formula\") — then continue your reply. If nothing from this exchange genuinely belongs on the board, just continue unchanged. Don't mention this correction either way." });
        continue;
      }
    }
    // Shouldn't normally be reachable — lastRound strips `tools` from the request, which should force a
    // plain-text reply before the loop runs out — but logged in case some other path lands here, same
    // reasoning as the CHAT_TOKEN_CEILING log above.
    console.error(`[chat] exhausted ${CHAT_MAX_ROUNDS} rounds without a plain-text reply — falling back`);
    return finish("");
  }
