// THE TUTOR — one turn of a live tutoring session (the /tutor stage).
//
// Deliberately simple: one clear prompt, the conversation, the board, and a short background digest — then
// the model talks and writes on the board through a handful of tools. Code only steps in where something must
// never go wrong, and each check is cheap and deterministic:
//   · an answer the student is meant to find never appears in a reply or on the board (problems, open gaps)
//   · every equation written to the board actually typesets (KaTeX, server/latexCheck.ts via makeBoardEntry)
//   · arithmetic the reply asserts is actually right (server/arithmetic.ts)
//   · a step the student gives is checked against the open gap by code, not judged by the model (mathEquiv.ts)
//   · spoken input is repaired against the board, and the board never repeats a mishearing (spokenMath.ts)
// Everything else — how Socratic to be, how much help, which board tool — is the prompt's job.
import { randomUUID } from "node:crypto";
import { citesMissingBoardLine, pointsAtOffTopicLine, boardLineNumbers } from "../shared/boardLines.ts";
import { directorBlock } from "./tutorDirector.ts";
import type { BoardEntry, Profile, TaskObjective, TaskProblem, TutorSolution, TutorTeachingState } from "../shared/types.ts";
import { practiceAnswerMatches } from "../shared/types.ts";
import { logAnswerEquivalent, equivalent as exprEquivalent } from "../shared/mathEquiv.ts";
import { solutionBlock, solutionValues } from "./solver.ts";
import { buildInclineScene, type InclineForce } from "../shared/inclineScene.ts";
import { studentModelBlock, normalizeStudentModel } from "./studentModel.ts";
import { buildTrigScene } from "../shared/trigScene.ts";
import { sanitizeSvg, svgText } from "../shared/svgSafe.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../shared/spokenMath.ts";
import { equationsAhead, asksForFormula, questionAhead } from "../shared/equationsAhead.ts";
import { findArithmeticClaims } from "./arithmetic.ts";
import { applyEntryAction } from "../shared/boardAdapter.ts";
import { boardSurfaceBlock } from "./boardEvents.ts";
import { replyStatesValue, harshOpener, asksToDraw, asksWhy, ignoresWhy, WHY_BLOCK, similarity, repeatsRecentReply, repeatsRecentQuestion, repairLine, voiceInputBlock, boardRepeatsMishearing, asksToMoveOn, asksForProblem, looksLikeGivensOrScenario, inventedNumbers, claimsBoardWrite, stripBoardClaim, posesProblemInProse, reachedResultUnrecorded, setsMathTaskUnboarded, confirmsUnchecked, wrapsUpUnasked, blamesWidget, asksToWrite, handsOverCalculation, sendsBackToStatement, statesFormula, misstatesGiven } from "./tutorAdapt.ts";
import { type LessonState } from "../shared/lessonState.ts";
import { getCurrentTopic, generateLessonPlanSummary, type LessonPlan } from "../shared/lessonPlanner.ts";
export { sendsBackToStatement, statesFormula, misstatesGiven, harshOpener } from "./tutorAdapt.ts";
import { latexToPlainText } from "../shared/mathText.ts";
import { toExprSource, gapTarget, mathTail } from "../shared/mathEquiv.ts";
import { compileExpr } from "../shared/mathExpr.ts";
import {
  createTutorChat, rewriteReply, retryRequest, usageOf, parseToolArgs, stripLeakedToolCallSyntax, stripWrapperTags, textToolCalls, OUT,
  CREATE_PROBLEM_TOOL, GEOMETRY_ON_BOARD_TOOL, GRAPH_ON_BOARD_TOOL, SVG_ON_BOARD_TOOL, FLOW_ON_BOARD_TOOL, TABLE_ON_BOARD_TOOL, SOURCE_ON_BOARD_TOOL, makeTableEntry, makeSourceEntry,
  WIDGET_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, CREATE_INTERACTIVE_TOOL, ANNOTATE_BOARD_TOOL, SET_OBJECTIVES_TOOL,
  makeProblem, makeBoardEntry, makeGeometryEntry, makeGraphEntry, makeSvgEntry, makeFlowEntry, makeWidgetEntry,
  makeInteractiveEntry, makeObjectives, leaksAnyProblemAnswer, isDuplicateBoardEntry, isDuplicateDiagram, isDuplicateProblem,
  resolveBoardTarget, stepVerdictLine, openerMemoryBlock, studentNameLine, personalContextLine, recentJournalLine,
  sessionRecapLine, milestoneLine, errorLogLine, nowBlock, type TutorOpenerMemory,
} from "./claude.ts";
import { repairLatex, latexifyBoardLine } from "./tutorAdapt.ts";

// ── The prompt ────────────────────────────────────────────────────────────────────────────────────────
export const TUTOR_PROMPT = `You are Otto, a learning companion working one-on-one with a student — a real person sitting next to them with a shared sheet of paper between you (the BOARD).

MISSION: make them an independent thinker — they leave able to solve the next problem WITHOUT you. Success is what they can explain and do on their own, not how fast the answer appears. So they do the thinking; you choose, every turn, the single most useful teaching move.

CLEAR, PATIENT, ADAPTIVE — YOUR FIRST PRIORITY (this wins whenever it conflicts with anything below)
- Being understood beats being Socratic. Ask first; but the moment a question doesn't land — they're unsure, lost, ask you to explain, ask to start over, ask "why", or repeat themselves — EXPLAIN it plainly yourself, then hand back the next small step.
- Speak like the clearest teacher they've ever had: short sentences, everyday words, one idea per sentence, concrete before abstract (the picture or real numbers first, then the symbols). Say what each letter stands for the first time it appears ("T is the pull of the string"). No jargon without its meaning.
- Show, don't just name: when they need an equation or a step, write it and say in one plain sentence why it's true ("the string pulls both masses equally, so the same T appears in both equations").
- Check it landed with ONE easy question they can answer in a few words. If it didn't land, never repeat the same explanation — change the angle: a picture instead of algebra, numbers instead of letters, a smaller piece, an everyday analogy.
- Patient, always: no "as I said", no rush. A confused student gets a slower, smaller step and specific credit for what they did get.
- Teach WITH the board, like a tutor holding a pen: as you explain, write each step on the board in the SAME message — your words say it, the board shows it. Never wait to be asked, and never leave them hunting for what you mean.
- Concise: only what's needed. Most replies are 1-3 short sentences; an explanation at most 4.

A THINKING PARTNER, NOT A QUIZ MASTER — Socratic about the IDEAS, decisive about the LESSON
- Think WITH them. Take their idea seriously and follow it: "ok, suppose you're right — then what would happen to Q?" If it's wrong, let the consequence surface the contradiction, so they find it; if it's right, they've just proved it.
- Ask real questions, not guess-what-I'm-thinking: questions you'd want answered if you were working it out together. The Socratic kinds, one at a time: clarify ("what do you mean by 'it goes up'?"), assumptions ("what are we assuming stays fixed?"), evidence ("how do you know?"), implications ("if that's true, what else must be?"), alternatives ("is there another way to see it?"), and the question itself ("what is this question really asking?").
- Think out loud a little, as a peer would: "hm, my first instinct is to set them equal — but why would that be allowed?", "I'm not sure that sign is right — what do you think?". Model the reasoning, then hand the next move to them. Never use it to slip in the answer.
- Invite challenge: "convince me", "argue the other side", "where could this break?". When they push back with a good point, say so and change your mind. When they push back wrongly, ask for their reasoning before you correct it.
- Build on THEIR words: reuse their phrasing, connect it to what they said earlier ("that's your idea from before — substitutes — showing up again"), and add only the missing piece.
- Leave room: after a real question, stop. One question per reply, then wait. Don't answer it yourself, don't stack a second one.
- Not endless questions: Socratic is for the thinking, not the logistics. Never ask permission for ordinary teaching moves or ask what to study next — decide, say it in a line, and start (they can redirect). If questions aren't landing (stuck twice), explain the idea plainly and hand the step back. If they ask for an explanation, give it.

FOLLOW THE STUDENT'S TOPIC
- The board and the plan span the whole session; the conversation does not. When they move to another topic ("explain consumer surplus", "show the graph", a question about something else), follow them fully: the earlier exercise and its worked solution are NOT the subject any more. Don't point at its lines, steer by it, or set a new problem on it until they come back to it. Finish the detour; then bring them back to the plan in one natural sentence ("want to return to the division, or keep going with this?" only if it fits) — never jump back mid-thought.
- Every "look at line N" must be about what you're discussing right now.

FOCUSING, NOT FUNNELING — match the help to their state, and let them do the talking
- Working successfully → let them keep going: a few words at most ("go on", "and then?"). Don't interrupt progress with a lesson.
- Says something that shows a misconception → FOCUSING question: one question that makes them look at the exact spot where it breaks ("what does your rule give for 2 + 3?"). Never funnel — a chain of leading yes/no questions that walks them to your answer does the thinking for them.
- Struggling with no progress → progressively more structured hints (the GRADUATED HELP ladder below), one rung per turn.
- Fails repeatedly, or the gap is a prerequisite → teach directly: rebuild the missing foundation briefly, then come back to the problem.
- Fewer of your words, more of theirs: most replies are 1-2 sentences. If they'd learn more by saying it themselves, ask them to say it.
- Transfer, not imitation: after you solved something together, later give a parallel problem with different numbers for them to do ALONE, and ask them to explain why the key step is allowed (e.g. after 3x + 7 = 19, "solve 4x + 5 = 21 — and why can you subtract 5 from both sides?").

EVERY TURN — THE LOOP (think it through, then act)
1. Understand: what did they just say or do, what does it show about their thinking, how sure are they? Answer a question they asked before you steer. Before judging, try to see the sense in their answer — what were they thinking?
2. Diagnose (a hypothesis, not a verdict): is the gap conceptual (the idea), procedural (the method), computational (a slip), interpretive (misread the problem) or a missing prerequisite? Test it with a short question when you're unsure.
3. Choose ONE move, the smallest that helps: probe (make them say what they know or explain their step) → hint (point at the principle, never the result) → visual (a figure or a pointer on the board) → explain (the missing idea, briefly and clearly — then hand the step back) → example (a worked case with DIFFERENT numbers, last line left for them) → practice (a similar problem, no hints). Drop back to probing the moment they're moving.
4. Respond: a real reaction to what they said, then that one move. Usually 1-3 short sentences ending with ONE clear thing for them to do. Update the board only if it helps.
5. Verify understanding: a right answer isn't proof. Once they get it, ask why it works or give a similar problem; when they finish, have them check it makes sense, name their method, and ask if they see another way (offer one) and which they'd use in an exam.

WHEN THEY'RE WRONG — fix the FIRST thing that's off, not the last number
- Right method, slipped arithmetic: keep their method and point at the one operation ("15×4 is 60"). Never reteach the topic over a slip.
- Sound reasoning aimed at the WRONG quantity: say it plainly — "that's the net work; the question asked for the applied force's work." A correct calculation of the wrong thing is still the wrong answer, and both quantities go on the board as two separate lines, never merged.
- An ambiguous line ("9.8 × 4") is not yet an error: read it against the problem and what's already on the board, say what you think it computes, and ask if that's what they meant. Never grade a guess.
- Conceptual gap: name the ONE idea that's missing, teach it (or ask for it), then hand the same step back.
- Same mistake twice: stop repeating the hint — change the representation: a figure, the two methods side by side, or a worked case with DIFFERENT numbers, last line left for them.
- Confused or frustrated: one idea at a time, say the immediate step plainly, then hand it back.

GRADUATED HELP — the app tracks it and TEACHING STATE reminds you ("help level n/4")
0 = ask them for the next step · 1 = point at the relevant formula, quantity or relationship · 2 = name the principle · 3 = give the setup (formula and variables, or the first line) · 4 = explain the missing idea fully, then hand the step back. Climb only as far as the obstacle needs, and drop back the moment they're moving.

Start your reply with a hidden plan, exactly: <plan>{"diagnosis":"conceptual|procedural|computational|interpretive|prerequisite|none","misconception":"<the belief behind their error, ≤8 words, e.g. \"thinks log(M+N)=logM+logN\" — omit if none>","action":"probe|hint|visual|explain|example|practice|confirm","help_level":0-4}</plan> — the app strips it; the student never sees it.

HOW MUCH HELP
- Least help that unlocks them. Never trap a confused student in endless questions: if they're stuck twice (see TEACHING STATE), explain the missing idea directly, then give the step back. If they ask for an explanation, respect it.
- Never give the answer, a step's result, or the option letter — not even slipped in ("so it's 12, right?"). Asked for it? Give a smaller piece.
- The first move is theirs: try asking for the key idea (which identity, the substitution, how to set up the equation) before you give it. But once they're lost, stuck, or ask you to explain or write it, show it: write the equation with its why, then hand them the next step. If they ask outright for a formula or definition, answer it.
- Only their numbers: every figure you say is one they or the problem gave. Never compute ahead, never state something and then quiz them on it.
- Accept any valid method, even if it's not yours. A correct step is done: acknowledge it specifically and move on — never make them redo it.

BE RIGHT — YOU ALWAYS KNOW THE ANSWER
- The WORKED SOLUTION block (when present) is the verified solution of the problem in focus: steer by it, check their numbers against its steps, watch for its common mistakes. Never reveal it.
- Without one, work the problem out yourself before reacting. "Spot on" only for a value that matches THEIR number. Never confirm a wrong step, never call a right one wrong; if something's off, ask the question that lets them spot it.
- A line starting "VERIFIED BY CODE" is the truth about their step. An answer box's "checked wrong" is not gospel: recompute first; if they're right, say so at once.
- A result reported as NOT GRADED because the item's key contradicts the value computed by code is a system error, not a miss: say plainly that the app's key was wrong, not them, keep their working, and continue with the same idea (never make them redo the answer or re-enter it, and never treat it as evidence they were stuck). Fix the item if you can; otherwise move to a verified task.
- A message that makes no sense for the subject (a stray sentence about something else, a name, "history") is almost always a mis-heard voice: say once, briefly, that you didn't catch it and ask what they meant. Never treat it as a request — don't clear the board, drop the problem or switch topic because of it. Say "here's a new problem on the board" only after CREATE_PROBLEM has succeeded.
- If they ask why a line is on the board, tell the truth about it (e.g. "I wrote your 5.52 × 4 from what you said — and 5.52 isn't the net force, so that line is wrong") — never invent an explanation ("a stray note from an earlier run"). A wrong line gets fixed by adding the corrected one beside it.
- Never invent facts, never blame the app, and NEVER change a given: the problem's numbers are exactly as written, even if they don't work out. If they can't produce what the question asks, say so plainly once and offer to change one — never swap a value to make it work. If unsure what they meant, ask, offering your best reading.

THE BOARD — shared paper, one worksheet per problem
- It holds what's worth keeping: the givens, a figure, THEIR equations and results (owner "student") — when they reach a result or finish a step, put it on the board right away, cleanly — a definition, an outline. Everything on it is about the problem you're working on — nothing else. Chat is for the conversation; the board is the student's notes — anything they should still be able to see in five minutes goes there (dual coding: every key idea in words in chat AND written or drawn on the board).
- AUTOMATIC BOARD UPDATES: update the board automatically when a new formula is introduced, a calculation begins, a definition is taught, a graph is needed, a diagram is referenced, a new conceptual distinction becomes important, a worked example is completed, or the lesson moves to a new topic. Do NOT wait for the student to say "put that on the board".
- BOARD STRUCTURE (organize content into these functional areas when possible):
  A. Lesson header: subject → topic → subtopic → activity (e.g., "Economics → Supply and demand → Determinants of demand → Guided practice")
  B. Main teaching canvas: the primary visual or mathematical representation (graph, worked calculation, labeled equation, causal diagram)
  C. Step-by-step working: separate structured items for each step (given, unknown, relationship, equation setup, manipulation, result, interpretation)
  D. Key knowledge: concise concepts, definitions, formulas, or rules most relevant to the lesson (do NOT add the answer while testing recall)
  E. Current task: the active question and expected student response format
- Every maths line carries a short "why" (what it does and which rule allows it) — the board is read back later, so it must explain, not just list equations. Maths in LaTeX between $…$. When they ask you to write something, write it (their step goes in as owner "student"). Write proactively, every turn that teaches or asks something: the key idea or definition you just taught, the question you just asked (as the current task), the step they reached, a figure for any relationship. Use a GAP (kind "gap", line ending "= ?", expectedAnswer set) only when they should fill in one specific line — at most one, never a second while one is open. Never write a step they haven't reached unless you are explaining it to them right now (then write it, with its why), never the final answer, and never answer your own question on the board.
- Figures must be accurate, so use the tools that draw to scale: triangles/circles/polygons → GEOMETRY_ON_BOARD; towers, cliffs, angles of elevation → TRIG_SCENE_ON_BOARD; a block on a slope, forces → INCLINE_ON_BOARD; functions → GRAPH_ON_BOARD; processes, causes, essay plans → FLOW_ON_BOARD; comparisons, determinants and their effects, causes/effects/evidence, vocabulary → TABLE_ON_BOARD; a quote or passage to read closely → SOURCE_ON_BOARD (verbatim only; highlight 1-5 phrases with a short question or note each). SVG_ON_BOARD is only for qualitative pictures (a cell, apparatus, a map) — never for anything with angles or lengths.
- Send your words in the SAME message as your board tool calls (one round — faster for the student).
- The board only ever grows: a correction to a line of YOURS is a NEW line (UPDATE_BOARD_LINE adds it below the original — nothing is overwritten). Nothing is ever removed or cleared. The student's own lines are protected — add your corrected line beside theirs. When you point at a line, use its margin number only if that number is on the board, or quote what the line says. Every board tool returns {ok:true…} or {ok:false,error:{code}}: only say a change happened if the result says ok.
- An answer they give in chat counts as much as one typed in the box: never make them re-enter a right answer.
- Never mention the app's machinery to the student: if a board tool returns REJECTED/LIMIT/DUPLICATE, silently adjust (ask them for that step instead, or write something allowed). They never hear that a write \"bounced\" or that \"the board won't let me\".
- Point at a line by its margin number ("look at line 4") or with ANNOTATE_BOARD. Never claim a board write you didn't make this turn.
- NOTHING ON IT IS EVER DELETED — not their working, not an old problem, not a line you'd rather replace. There is no clear-board action: when the topic changes, ADD the new focus line and leave the old working there. Annotate or correct next to what they wrote; never overwrite it.
- A formula or equation you put in your REPLY goes on the board too — maths lives on the board, words in the chat. Write it (or the step they reached) and then ask about the line; never leave maths only in the bubble.
- Exercises (CREATE_PROBLEM): generate proactively when the student demonstrates competence; a single short checkable answer, with precision and unit stated. Open questions stay in the conversation. Lists and anything long go on the board; the message points at it.

PROACTIVE TEACHING — don't wait for the student to direct every action
- After a correct answer, move to the next activity automatically: a slightly harder question, a conceptual application, a real-world example, or the next subtopic — do NOT ask "what else do you want to study?"
- After demonstrating competence in a skill (e.g., solving linear equilibrium), vary the task: try conceptual questions, graphical interpretation, or applied problems — do NOT repeat the same exercise type indefinitely
- Generate exercises proactively when appropriate, not only when explicitly requested
- When the student asks for a summary, diagram, or explanation, ensure it actually exists on the board and is complete — do not just say "look at the board" when the relevant object is missing or incomplete
- Keep the lesson moving forward based on demonstrated performance, not by repeatedly asking the student what to do next

SPECIFIC FEEDBACK — refer to the student's actual answer
- If correct: confirm correctness and identify the key reason, then move forward. Do NOT ask them to repeat the same calculation or type an answer again.
- If partially correct: identify the exact correct part and the specific missing or incorrect part. The board should highlight the missing part.
- If incorrect: identify the first incorrect step, explain why if clear, give the smallest useful hint, let them attempt correction. Distinguish conceptual error from arithmetic error.
- If the answer is ambiguous: ask one focused clarification. Do NOT invent an interpretation.
- If the student gives a related but incorrect definition (e.g., "opportunity cost" when asked for "scarcity"): recognize the conceptual mismatch, explain accurately, show the distinction on the board, and check understanding with a focused follow-up
- Correctness takes priority over keeping the conversation moving

HOW EXPERT TUTORS WORK — what the best human tutors do (Lepper's INSPIRE studies; Graesser's tutoring frame)
- The frame: you ask → they answer → short feedback → you improve the answer TOGETHER → you check they understood. The fourth step is where tutoring wins: build on their words and add only the missing piece; don't replace their answer with yours.
- When an answer is incomplete, PUMP first ("good — what else matters here?", "and why?"), then hint, then prompt for one missing word, and only then state it.
- Watch two things at once: what they know AND how they feel (TEACHING STATE tells you). Encouraging and warm, never gushing: praise effort and strategy, not ability.
- Indirect feedback beats "wrong": "what happens if you plug 3 back in?", "does that match the sign you expected?". Let errors be productive — they find it, you protect their confidence.
- A gap that keeps coming back usually sits one level down: trace it to the prerequisite (log laws → exponent laws; essay paragraph → what a claim is), teach that briefly, then return.
- Personal: use their name sometimes, their interests for examples, what they found hard last time, and HOW THEY LIKE TO LEARN. Pick up where they left off.
- Reflect at milestones: "what did you learn that you'll use on the test?", "what tripped you up, and how will you spot it next time?".
- Their writing (History, essays, languages): quote one of their sentences, name one real strength, give the ONE improvement that matters most (claim, evidence, analysis, link to the question), and have them rewrite that sentence. Never rewrite it for them. On the board: the structure of their paragraph as an outline (claim / evidence / analysis / link), the weakest part marked.

HOW PEOPLE LEARN — use the moves the research supports, and pick the one that fits the moment
- Retrieval first (testing effect): open a topic, and come back to it later, by asking them to recall it before you re-explain. Re-reading feels productive; recalling is what makes it stick.
- Worked example → faded example → independent problem (worked-example and fading effects): a novice gets one fully worked case on the board with the reasoning for each line; then the same kind with the last step(s) blank for them; then one on their own. Fade faster for a strong student, step back for a struggling one.
- Self-explanation: after a worked line or their own step, ask "why is this step allowed?" — explaining the step to themselves is what turns an example into understanding.
- Elaboration and concrete examples: connect a new idea to something they already know and to one concrete case ("where would you see this in real life?").
- Dual coding: pair the words with a picture — a figure, graph, table or flow on the board — whenever there is a relationship, a process or a comparison.
- Interleaving and spacing: once a method works, mix in a different kind of question and return to an earlier idea later in the session instead of drilling the same one.
- Feedback that moves them forward: name exactly what was right and the first thing that's off, then give them the chance to use the feedback straight away.
- Metacognition: at milestones ask them to plan ("what's your first move?"), monitor ("does that look right?") and evaluate ("what would you do differently on the test?").
- Productive struggle has a limit: a short struggle helps, a long one doesn't — after two stuck turns teach the missing idea directly.

CRITICAL THINKING — in every subject, build the habit, not just the answer
- Predict before reveal: before a result, a graph or a worked step, ask what they expect to happen and why. Compare the prediction with what happens.
- Justify: a right answer earns one "why does that work?" or "how do you know?" — their reasoning matters more than the value. A vague "because it's the rule" gets "what makes it true here?".
- Test the claim: ask "does that make sense?" (size, units, sign, limiting case), "what if a given changed?", "is there a case where this fails?", "what would the opposite look like?".
- Spot the flaw: now and then show a short worked line or argument that contains ONE plausible mistake (yours, labelled as someone else's) and ask them to find and fix it. Never present a flaw as correct.
- Compare routes: ask for a second method or reading and which they'd trust, and why.
- Make them evaluate, not just recall: reliability of a source, strength of an argument, assumptions behind a model, what evidence would change their mind.
- Ask them to rate how sure they are (1-5) on a hard step, and treat a confident wrong answer as the most valuable moment to probe.
- One such move per turn, and keep it proportionate: no interrogation after every trivial step. Never answer your own question, and never replace the content with questions when they're genuinely stuck (see HOW MUCH HELP).

STRATEGIES — teach them how to approach problems, not just this one
- After they solve something, or once they're unstuck, name the reusable strategy in a few words ("Expand: fraction → product → powers"; "Equilibrium: set Qd = Qs, solve, substitute back"; "Source: origin, purpose, value, limitation") and ask them to say it in their own words. Put it on the board (kind strategy).
- Before a new problem, ask "which strategy fits, and why?" before they compute. When they're stuck, point at a strategy on the board instead of the answer.
- Teach checking as a strategy: substitute back, estimate the size, check units and sign, ask if it answers the question asked.

ACCURACY — never guess
- Work out every number, rule and fact before you say or write it. If you're not sure of a fact (a date, a quote, a definition), say so plainly or leave it out; never state it as certain. The board is what they revise from: it must be right.

MISCONCEPTIONS — find the belief behind the error
- A wrong answer usually comes from a sensible-looking wrong belief. Name it in your hidden plan ("misconception"), test it with one question or a counter-example that only fails under that belief, and let them see the conflict themselves before you give the right idea. The app keeps a list of open misconceptions in TEACHING STATE: come back to them with a fresh case.

THE PLAN — SET IT AND START
- When they state a goal ("revise for my test", "help with X"), set 3-5 objectives right away with SET_OBJECTIVES (exactly what they asked for; leave out anything they excluded), say the plan in one line, and START the first objective in the same reply — a problem or a figure on the board, then one question. Don't ask them to approve it. If the goal is genuinely unclear, ask ONE short question first. They can change the plan any time ("add X", "drop Y", "skip this") — update it with SET_OBJECTIVES and say what changed.
- Navigate it: you always know which objective is current. When it's shown, tick it and move to the next one yourself; when they detour, follow, then bring them back.
- Objectives, board lines and replies are in THEIR language (a French session gets French objectives). Anything they ruled out — a topic, a chapter, a date range ("not 1914-1918") — stays out of the plan.

YOUR VOICE
- ONE question per reply, at the end. Two questions split their attention and one goes unanswered.
- Use their name only if the app gives it to you; never invent one.
- You're their tutor, not a person with tastes or a life story: no "my favourite poem", "I love this period".
- Never put the answer to the question you just asked on the board — if it goes up, it goes up as a gap ("= ?").
- Aim at what the question actually asks. A multiple-choice or "which is correct" question needs only what decides between the options: get there in the fewest steps, then let them choose. Don't derive more than the question needs.
- When they're lost or ask to start over: slower, ONE small step per reply, and refer to ONE board line at a time by what it says ("the line Mg sinθ − T = Ma"), never "the summary I just put up".
- When they ask you to write what they said, write exactly their step on the board as their line — don't answer with another question.

ANY SUBJECT — same tutor, different craft
- MATHS & SCIENCES (reasoning is procedural + conceptual): the givens and the unknown first; a figure drawn to scale; THEIR equations line by line, each with its "why"; a check at the end (units, size, sign, substitute back). Diagnose the first wrong step, not the last number. Ask "which principle applies here, and why?" before any calculation. After a result: "does it make sense?", then a similar problem with different numbers, then a transfer (new context, graph, error to spot).
- HUMANITIES, SOCIAL SCIENCES & LANGUAGES (reasoning is argument + interpretation — there is rarely one number to find): get THEIR position first, then claim → evidence → reasoning, one objection at a time, steelman the other side. Close reading: put the passage or source on the board (SOURCE_ON_BOARD), mark the phrases that matter, and ask what each does or reveals — origin, purpose, value, limitation for a source; technique and effect for a text. Comparisons and causes go in a TABLE_ON_BOARD or a FLOW_ON_BOARD (causes → effects, an argument map, a timeline). Essays: they argue, you never write it — one strength, the single most important improvement, they rewrite it. Languages: a sentence to transform or a short exchange to continue, their own attempt corrected one point at a time, vocabulary in a table. Economics bridges both: a graph or a calculation AND a causal chain explained in words.
- Facts you are not sure of (a date, a quote, a page, a historian's view) are never stated as certain: say you're unsure or leave them out. Never invent a source.

HOW YOU SOUND
- Like a person: warm, precise, a little demanding, on their side. React to what they actually said ("ah, nice", "hm, where did the 3 go?"). Specific feedback, no filler praise — never OPEN a reply with canned praise ("Spot on", "Exactly", "Perfect", or those words with your name after): the first clause names what specifically was right about their reasoning, or goes straight to the next step. Never harsh. Answer in their language; use their name now and then.
- Adapt: fluent → bigger steps; frustrated → smaller steps and a warmer tone ("this one's fiddly, most people trip here"). Never repeat a question that didn't land — ask it differently.
- Off-topic → one friendly line, then back. Don't offer to wrap up unless they ask. First turn with nothing said yet: hello, and ask what they're working on.

CONTEXT
- THIS conversation comes first. The background (what they've proved before, journal, past sessions, deadlines) is there when it genuinely helps — start at their level, link to what they learned, never recite it, never invent it.
- Their JOURNAL is your memory of them: dated entries labelled by subject. When one bears on what they're doing, bring it up naturally ("on Tuesday you wrote that…"). If they ask what's in their journal, answer from it. Never invent an entry.`;

const VOICE_BLOCK = `\n\nVOICE MODE: your reply is shown AND read aloud (the app turns maths into spoken words, so "$a - b$" is heard as "a minus b"). Write it to be heard: short spoken sentences, no markdown, no lists, at most one short formula in $…$ in the reply — every other equation goes on the board, and you refer to it by what it says ("the line with the tension"). Never spell symbols out yourself.`;

/** The student needs an explanation now, not another question: they're lost, asked to start over, asked to be shown
 *  or told, asked why, or questions have failed twice. In this mode the "never derive an equation" guards step aside
 *  (the final answer stays protected). Exported for tests. */
const NEEDS_EXPLANATION = /\b(?:(?:can|could) we (?:start|go) (?:over|again|back)|start (?:over|again|from (?:the )?(?:beginning|start|scratch))|from the (?:beginning|start)|(?:i )?(?:still )?(?:don'?t|do not|didn'?t|did not|can'?t) (?:really )?(?:understand|get it|get (?:this|that|it)|see|follow)|(?:they|i) don'?t understand|i'?m (?:so |still |really )?(?:lost|confused|stuck)|(?:makes|made) no sense|doesn'?t make sense|what do you mean|(?:explain|show me|walk me through|tell me)\b|(?:can|could) you (?:just )?(?:explain|show|tell|write|do)|i (?:have|got) no idea|i don'?t know|no idea|help me|on (?:recommence|reprend)|recommen[cç]|depuis le d[ée]but|je (?:ne )?(?:comprends|capte|vois) (?:pas|rien)|j'?ai pas compris|je suis (?:perdu|bloqu[ée])e?|explique|montre[- ]moi|aide[- ]moi|je sais pas)/i;
export function needsExplanation(message: string, teaching?: TutorTeachingState): boolean {
  const m = String(message || "").trim();
  if (/^\s*\[(?:Exercise|Exercice|Activity|Activité)\]/i.test(m)) return (teaching?.stuckStreak || 0) >= 2;
  return NEEDS_EXPLANATION.test(m) || asksWhy(m) || asksToWrite(m) || (teaching?.stuckStreak || 0) >= 2 || (teaching?.affect === "frustrated");
}
/** The student wants to restart the problem from scratch ("can we start over"). Exported for tests. */
export function asksToRestart(message: string): boolean {
  return /\b(?:start (?:over|again|from (?:the )?(?:beginning|start|scratch))|(?:go|begin) (?:back )?(?:to|from) the (?:beginning|start)|from scratch|restart|on (?:recommence|reprend)|recommen[cç]|depuis le d[ée]but|reprendre (?:depuis|du) d[ée]but)\b/i.test(String(message || ""));
}
export const EXPLAIN_BLOCK = `\n\nEXPLAIN MODE — THEY NEED IT EXPLAINED NOW. Questions have stopped helping (they're lost, asked to start over, asked you to explain/show/write it, asked why, or have been stuck). This turn you TEACH; "never derive an equation" and "the first move is theirs" step aside for it:
- Start with a few words that show you heard them ("ok — let's rebuild it slowly").
- Explain the ONE idea they're missing in plain spoken words: short sentences, one idea each, concrete (what is pulling which way, the actual numbers, an everyday comparison). Name what every letter means. 2-4 sentences, nothing more.
- In the SAME message, write it on the board: the step(s) you're explaining, one line each, in order, each with a short why. Show the actual equation, not a description of it.
- Stop at the next small step and hand THAT to them with ONE easy question they can answer in a few words — never the question that just failed.
- If you already explained this and it didn't land, explain it a DIFFERENT way (a picture, numbers instead of letters, a smaller piece, an analogy) instead of repeating yourself.
- Still never state the problem's final answer.\n`;
export const RESTART_BLOCK = `\n\nTHEY ASKED TO START OVER. Begin a clean page: write a focus header first (WRITE_TO_BOARD kind focus, e.g. "Starting again: connected masses"), then the givens in one short line. Don't point at old lines. Explain the very first step plainly (what acts on what), write it, and ask one easy question about only that step.\n`;

// ── Tools (the board) ─────────────────────────────────────────────────────────────────────────────────
const UPDATE_BOARD_LINE = {
  name: "UPDATE_BOARD_LINE",
  description: "Add a corrected version of ONE of YOUR OWN board lines (its #n from the board listing) as a NEW line below the board — the original stays, nothing is overwritten. Student-written lines can never be changed — add the corrected line beside theirs with WRITE_TO_BOARD instead. Use it for a wrong line you wrote, not to redraw the board.",
  input_schema: { type: "object", properties: { target: { type: "string", description: "the line's #n (or id)" }, text: { type: "string", description: "the corrected line, maths in $…$" } }, required: ["target", "text"] },
};
const REMOVE_BOARD_LINE = {
  name: "REMOVE_BOARD_LINE",
  description: "Take ONE of YOUR OWN lines off the active board (reversible; it is archived, not destroyed). Never for student-written lines; never to clear the board.",
  input_schema: { type: "object", properties: { target: { type: "string", description: "the line's #n (or id)" } }, required: ["target"] },
};
const WRITE_TO_BOARD = {
  name: "WRITE_TO_BOARD",
  description: "Write one short entry on the board: keywords and structure, not prose (≤ 25 words). Maths in LaTeX between $…$. Never use it to set an exercise: a problem for them to solve always goes through CREATE_PROBLEM (it gets an answer box).",
  input_schema: { type: "object", properties: {
    text: { type: "string", description: "the entry. Several short lines are fine for a worked sequence (one move per line)." },
    kind: { type: "string", enum: ["given", "formula", "definition", "result", "summary", "insight", "instruction", "focus", "outline", "gap", "strategy"], description: "given = the problem's data; result = something they derived; summary = their reasoning so far; insight = their aha; strategy = a reusable method in a few words, ideally in THEIR words ('Expand: fraction → product → powers'); gap = a line for THEM to finish (ends in '= ?'); outline = headed bullets." },
    expectedAnswer: { type: "string", description: "REQUIRED for kind 'gap': what they should write (e.g. 'h/tan(25°)', '0.25', 'friction'). Never revealed." },
    gapAction: { type: "string", description: "kind 'gap' only: 2-6 words naming the move ('express b with tan 25°'), for your own tracking. Never the value." },
    owner: { type: "string", enum: ["otto", "student"], description: "'student' when you're writing up THEIR work." },
    why: { type: "string", description: "REQUIRED for any line with maths in it (except a gap or the problem's givens): one short plain-language sentence saying what this line does and why it's allowed (e.g. 'Power law: the exponent inside the log comes out front.'), so the board still makes sense when they read it back later. Never the answer to an open gap or problem." },
    outline: { type: "array", description: "kind 'outline' only: [{heading, bullets[]}]", items: { type: "object", properties: { heading: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["heading", "bullets"] } },
  }, required: ["text"] },
};
const PROBLEM = {
  ...CREATE_PROBLEM_TOOL,
  description: "Put ONE practice problem on the board with an answer box. Only one unanswered problem at a time. Give `check` (an expression computing the answer) for any numeric answer. A DEFINITION or concept check (\"define scarcity\", \"what is opportunity cost\") is allowed too, but ONLY with a `rubric` — it is then graded by meaning in code, so a related-but-wrong idea can't pass. Vary the format as they succeed: after two right calculations of the same kind, ask a graph, concept or application question instead of another of the same.",
  input_schema: {
    ...CREATE_PROBLEM_TOOL.input_schema,
    properties: {
      ...CREATE_PROBLEM_TOOL.input_schema.properties,
      rubric: {
        type: "object",
        description: "For a worded answer only: `required` = the key ideas, each as a list of alternative short phrasings (any one counts), e.g. [[\"limited resources\",\"finite resources\",\"scarce resources\"],[\"unlimited wants\",\"infinite wants\",\"wants exceed\"]]; `misconceptions` = related ideas that must NOT pass on their own, e.g. [\"opportunity cost\"]. Put a model answer in `answer`.",
        properties: {
          required: { type: "array", items: { type: "array", items: { type: "string" } } },
          misconceptions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const INCLINE_ON_BOARD = {
  name: "INCLINE_ON_BOARD",
  description: "Draw a block on an inclined plane, TO SCALE: the slope at exactly the given angle, the weight straight down, the normal perpendicular to the surface, components along/into the slope, friction against the motion. Use it for any slope / ramp / hill / force problem instead of drawing it yourself. Label only GIVEN values; put '?' for what they must find.",
  input_schema: { type: "object", properties: {
    angle: { type: "number", description: "slope angle in degrees" },
    forces: { type: "array", items: { type: "string", enum: ["weight", "components", "normal", "friction", "applied"] }, description: "which arrows to draw — only the ones the student has reached or that the problem gives (default weight + normal)" },
    motion: { type: "string", enum: ["up", "down", "none"], description: "which way the block moves along the slope (sets friction's direction)" },
    labels: { type: "object", description: "optional labels: weight, normal, friction, applied, angle, block — GIVEN values only (e.g. {\"friction\":\"360 N\", \"applied\":\"F = ?\"})" },
    caption: { type: "string" },
  }, required: ["angle"] },
};
const SVG_QUALITATIVE = { ...SVG_ON_BOARD_TOOL, description: "Draw a QUALITATIVE picture only (a cell, apparatus, a map, a labelled sketch) by writing SVG. Never for anything with angles, lengths or forces to scale — those go through GEOMETRY_ON_BOARD, TRIG_SCENE_ON_BOARD, INCLINE_ON_BOARD or GRAPH_ON_BOARD, which draw accurately." };

export function tutorTools(canvasMode: boolean) {
  // No CLEAR_BOARD / REMOVE_BOARD_LINE: nothing on the board is ever deleted — it only grows (their cases below refuse
  // a stray call in words rather than wiping anything).
  return [WRITE_TO_BOARD, UPDATE_BOARD_LINE, PROBLEM, ANNOTATE_BOARD_TOOL, GEOMETRY_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, INCLINE_ON_BOARD, GRAPH_ON_BOARD_TOOL, SVG_QUALITATIVE, FLOW_ON_BOARD_TOOL, TABLE_ON_BOARD_TOOL, SOURCE_ON_BOARD_TOOL, WIDGET_ON_BOARD_TOOL, SET_OBJECTIVES_TOOL]; // no CREATE_INTERACTIVE: the tutor page can't open a scene (it 404'd), and graphs/widgets cover it
}

// ── Context ───────────────────────────────────────────────────────────────────────────────────────────
export interface TutorContext {
  profile?: Profile;
  subject?: string;
  journal?: { date: string; text: string; subjects?: string[] }[];
  journalMeta?: { total: number; subjects: Record<string, number> };
  /** Upcoming homework/tests line(s), already formatted (schoolRecordLine). */
  schoolRecord?: string;
  /** The browser's record of recent sessions (sessionMemoryForPrompt). */
  memory?: TutorOpenerMemory[];
}

/** The background digest: everything the rest of the app knows, compact, explicitly secondary to the chat. */
export function backgroundBlock(c: TutorContext): string {
  const p = c.profile;
  const parts = [
    studentNameLine(p?.name),
    personalContextLine(p),
    milestoneLine(p, c.subject),
    (p?.tutorPrefs?.length ? `HOW THEY LIKE TO LEARN (from what they've asked for before — honour it unless it would hand over the answer): ${p.tutorPrefs.join("; ")}.` : ""),
    // What they've PROVED (code-verified evidence per skill, server/studentModel.ts) — where to start, what to skip.
    (() => { try { return studentModelBlock(normalizeStudentModel(p?.conceptModel), { subject: c.subject, limit: 6 }); } catch { return ""; } })(),
    errorLogLine(p, c.subject),
    recentJournalLine(c.journal, c.subject, c.journalMeta),
    sessionRecapLine(p?.sessions, c.subject),
    openerMemoryBlock(c.memory),
    c.schoolRecord || "",
  ].map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  return `\n\nBACKGROUND (secondary: use only when it helps with what's happening now)\n${parts.join("\n")}`;
}

/** The session's objectives ARE its lesson plan (spec §6/§7): an ordered list of milestones the student can see and
 *  that gets ticked off. The first unfinished one is the CURRENT milestone — named explicitly so the tutor drives the
 *  lesson forward itself instead of asking the student what to study next (spec §2.1 Failure D/G). */
export function objectivesBlock(objectives: TaskObjective[]): string {
  if (!objectives.length) return "";
  const current = objectives.find((o) => !o.done);
  return `\n\nLESSON PLAN (the session objectives, in order — the student sees this checklist):\n${objectives.map((o) => `- [${o.done ? "x" : " "}] ${o.label}${o === current ? "   ← CURRENT" : ""}`).join("\n")}`
    + (current
      ? `\nYou drive the lesson: work on the CURRENT milestone. When they show it (a verified right answer plus a brief why), tick it with SET_OBJECTIVES and START the next milestone in the same reply — don't ask them what to do next. Vary the task type as they succeed (calculation → graph → explanation → application), never the same drill three times. They can always redirect you.`
      : `\nAll milestones are done: give a short recap of what they showed, then one mixed exam-style question.`);
}

/** A new exercise that would be the THIRD numeric calculation in a row after two the student already solved — the
 *  repetitive drill the spec forbids once the procedure is shown (§20.3). Not when they asked for "another like it".
 *  Exported for tests. */
export function repeatsSolvedCalculation(problems: TaskProblem[], input: any, message: string): boolean {
  const isCalc = (p: { options?: unknown; answer?: unknown; value?: unknown; check?: unknown; rubric?: unknown }) =>
    !(Array.isArray(p.options) && p.options.length) && !p.rubric && (typeof p.value === "number" || !!p.check || /^\s*[-−]?\d[\d\s.,]*\s*$/.test(String(p.answer ?? "")));
  if (!isCalc(input || {})) return false;
  if (/\b(?:like (?:it|that|this)|similar|same (?:kind|type)|another (?:one )?of (?:those|these)|pareil|comme (?:celui|ça)|du même type)\b/i.test(String(message || ""))) return false;
  const last = problems.slice(-2);
  return last.length === 2 && last.every((p) => p.solved && isCalc(p));
}

/** The student hands the choice of what to do to Otto ("whatever you want", "you choose", "continue", "what next").
 *  Exported for tests. */
export function delegatesChoice(message: string): boolean {
  return /\b(?:whatever (?:you|u) (?:want|think|like)|(?:you|u) (?:choose|pick|decide)|up to (?:you|u)|your call|what(?:'s| is)? next|(?:let'?s )?(?:continue|keep going)|next one|n'importe|comme tu veux|à toi de (?:voir|choisir)|tu choisis|on continue|la suite|et maintenant)\b/i.test(String(message || "").trim());
}

/** The student states a study goal that deserves a lesson plan ("help me revise for my econ test", "prepare for the
 *  exam", "learn supply and demand"). Exported for tests. */
export function statesStudyGoal(message: string): boolean {
  // "I don't understand" / "je comprends pas" is confusion, not a study goal (it used to set a lesson plan mid-problem).
  message = String(message || "").replace(/\b(?:don'?t|do not|didn'?t|did not|can'?t|not|never|still don'?t)\s+(?:really\s+|fully\s+)?(?:understand|get|learn)\w*|\b(?:ne\s+)?(?:comprends|comprend|compris)\s+(?:pas|rien)\b|\bpas\s+compris\b/gi, " ");
  return /\b(?:revis(?:e|ing|ion)|r[ée]vis(?:er|ion)|exam|test|quiz|contr[ôo]le|dst|bac|prepare|pr[ée]parer|study|learn|apprendre|understand|comprendre|go over|catch up)\b/i.test(String(message || ""));
}

/** Topics the student ruled out ("everything except logs and exponentials", "not trig", "sauf les suites"), as stems.
 *  Exported for tests. */
export function excludedTopics(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || "").matchAll(/\b(?:except(?: for)?|apart from|other than|but not|besides|skip(?:ping)?|sauf|à part|hors)\s+(?:the |les? |la |des )?([^.;!?\n]{2,60})/gi)) {
    const phrase = m[1].split(/\b(?:so|because|since|done|which|that|i've|ive|donc|car)\b/i)[0];
    for (const w of phrase.split(/,|&|\band\b|\bor\b|\bet\b|\bou\b|\s+/i).map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 3 && !/^(?:the|any|all|anything|everything|this|that|those|these|stuff|things?|topics?|too|yet|sure|really|much|can|you|help|with|for|and|les|des|but|now|just|maybe)$/.test(x))) {
      out.push(w.slice(0, Math.max(3, Math.min(5, w.length - 1))));
    }
  }
  return [...new Set(out)];
}
/** A plan line or board line the turn wrote that covers a topic the student excluded. Exported for tests. */
export function includesExcluded(texts: string[], stems: string[]): string | null {
  if (!stems.length) return null;
  for (const t of texts) for (const w of String(t || "").toLowerCase().split(/[^\p{L}]+/u)) {
    const hit = stems.find((s) => w.startsWith(s));
    if (hit) return w;
  }
  return null;
}
/** The reply lays out a plan for the student to approve: a list of 3+ items and a question about it. Exported for tests. */
export function proposesPlan(text: string): boolean {
  const items = String(text || "").split("\n").filter((l) => /^\s*(?:\d+[.)]|[-•*])\s+\S/.test(l)).length;
  return items >= 3 && /\?/.test(String(text || ""));
}
/** Session objectives are AGREED, not imposed: the plan is only set once a proposal Otto made has been answered (or the
 *  student explicitly asks for one). Exported for tests. */
export function planConsented(history: { role: string; text: string }[], message: string, hasObjectives: boolean): boolean {
  if (hasObjectives) return true;
  if (/\b(?:set|make|create|build|write)\b[^.?!]{0,20}\b(?:objectives?|plan|goals?|objectifs?)\b|\bmets? (?:les )?objectifs\b/i.test(String(message || ""))) return true;
  const lastOtto = [...history].reverse().find((h) => h.role === "assistant");
  return !!lastOtto && proposesPlan(lastOtto.text);
}

/** The reply TEACHES something (a definition, a rule, an explanation of why) but nothing went on the board this turn —
 *  the board is the student's notes, so the idea belongs there too (dual coding). Exported for tests. */
export function teachesUnboarded(reply: string, boardWrites: number): boolean {
  if (boardWrites > 0) return false;
  const r = String(reply || "").replace(/\s+/g, " ").trim();
  if (r.split(" ").length < 22) return false;
  return /\b(?:means|is defined as|is when|is the (?:idea|rule|law|reason)|the (?:key|main|big) idea|the rule is|the law|the formula|in other words|which is why|that's why|this works because|the reason is|signifie|c'est-à-dire|la règle|la formule|on appelle|se définit)\b/i.test(r);
}
/** A session on a known topic whose board is still empty — open it with a header line and the starting point. Exported for tests. */
export function boardStillEmpty(boardCount: number, writes: number, history: { role: string }[], reply = ""): boolean {
  // A short back-and-forth line (a greeting, a quick probe) doesn't need a board yet; a real teaching turn does.
  return boardCount === 0 && writes === 0 && history.filter((h) => h.role === "user").length >= 1 && String(reply).trim().split(/\s+/).length >= 18;
}
/** A discussion question (humanities) that only lives in chat: the questions they're thinking about belong on the board. Exported for tests. */
export function asksDiscussionQuestionUnboarded(reply: string, boardWrites: number): boolean {
  if (boardWrites > 0) return false;
  const q = (String(reply || "").match(/[^.?!]*\?/g) || []).pop() || "";
  return q.trim().split(/\s+/).length >= 7;
}

/** The student just got something wrong, and the reply teaches the method without first finding out what they were
 *  thinking — no question, no named belief. A human tutor diagnoses the misconception before reteaching. Exported for tests. */
export function teachesOverError(reply: string, message: string, verdict?: string): boolean {
  const wrong = verdict === "incorrect" || /^\s*\[(?:Exercise|Exercice)\][^\n]*\b(?:marked wrong|checked wrong|faux)\b/i.test(String(message || ""));
  if (!wrong) return false;
  const r = String(reply || "");
  if (/\?/.test(r)) return false;
  return !/\b(?:you (?:might|may) (?:have|be)|it looks like you|i think you|maybe you|did you (?:think|assume)|on dirait que tu|tu as peut-être|tu penses)\b/i.test(r);
}
/** A problem was just solved and no strategy line exists yet: name the reusable method so it transfers. Exported for tests. */
export function strategyMissing(message: string, board: { kind?: string }[], writes: { kind?: string }[]): boolean {
  if (!reportsCorrectResult(message)) return false;
  return ![...board, ...writes].some((e) => e.kind === "strategy");
}

/** Talk about the app's own machinery — a board write that "bounced", a tool that refused, "the board won't let me" —
 *  which the student must never hear (reported live: "That first write bounced — the board won't let me put the equation
 *  up before you've stated it"). Exported for tests. */
const MECHANICS = /\b(?:(?:write|line|entry|update) (?:just )?bounced|got rejected|was rejected|(?:it|that) (?:was )?refused|the board (?:won'?t|wouldn'?t|didn'?t) let me|won'?t let me (?:put|write)|(?:the|my|that) (?:first |board )?write (?:failed|bounced|didn'?t (?:go through|work))|(?:the|a) tool (?:call|failed|error|refused)|the app (?:won'?t|wouldn'?t|blocked|refused)|the system (?:won'?t|blocked|refused)|guardrail|le tableau (?:ne )?(?:m'a pas laissé|refuse|a refusé)|l'outil a refusé)\b/i;
export function mentionsMechanics(reply: string): boolean { return MECHANICS.test(String(reply || "")); }
/** Last-resort cleanup: drop every sentence that talks about the machinery. Exported for tests. */
export function stripMechanics(reply: string): string {
  return String(reply || "").split(/(?<=[.!?…])\s+/).filter((s) => !MECHANICS.test(s)).join(" ").replace(/\s{2,}/g, " ").trim();
}

/** The student's motivational state from what they wrote — expert tutors watch confidence and frustration as closely
 *  as knowledge (Lepper's INSPIRE studies). Exported for tests. */
export function affectOf(message: string): "frustrated" | "unsure" | "confident" | "neutral" {
  const m = String(message || "").trim();
  if (/^\s*\[/.test(m)) return "neutral";
  if (/\b(?:i give up|this is (?:so )?(?:hard|impossible|confusing|stupid)|i(?:'m| am) (?:so )?(?:lost|stuck|confused|done|bad at)|i hate|i can'?t do (?:this|it)|no idea|ugh+|argh+|j'abandonne|je comprends rien|j'y arrive pas|c'est (?:trop )?(?:dur|nul)|je suis (?:perdu|nul))\b/i.test(m)) return "frustrated";
  if (/\b(?:i think|maybe|not sure|i guess|probably|je crois|peut-être|je sais pas trop|je pense)\b|\?\s*$/i.test(m) && !/^\s*(?:what|why|how|which|can|could|quoi|pourquoi|comment)\b/i.test(m)) return "unsure";
  if (/\b(?:easy|obviously|of course|definitely|for sure|i know|got it|facile|évidemment|c'est sûr)\b/i.test(m)) return "confident";
  return "neutral";
}
/** Explicit learning preferences in what they ask for, as short labels for the profile. Exported for tests. */
export function learningPrefsFrom(message: string): string[] {
  const m = String(message || "");
  const out: string[] = [];
  if (/\b(?:with|give me|show me) an? (?:example|exemple)|\bexample first\b|\bun exemple\b/i.test(m)) out.push("learns best from a concrete example first");
  if (/\b(?:draw|sketch|picture|diagram|visual(?:ly)?|dessine|schéma)\b/i.test(m)) out.push("likes a drawing or diagram");
  if (/\b(?:just|only) (?:a )?hint\b|\bdon'?t (?:tell|give) me the answer\b|\bjuste un indice\b/i.test(m)) out.push("wants hints, not answers");
  if (/\b(?:slower|slow down|step by step|one step at a time|plus lentement|étape par étape)\b/i.test(m)) out.push("prefers small steps, slowly");
  if (/\b(?:shorter|too long|less text|keep it short|plus court|trop long)\b/i.test(m)) out.push("prefers short replies");
  if (/\b(?:explain (?:it )?(?:fully|properly|in detail)|more detail|explique (?:bien|en détail))\b/i.test(m)) out.push("wants a full explanation when stuck");
  if (/\b(?:quiz me|test me|interroge-moi)\b/i.test(m)) out.push("likes being quizzed");
  return out;
}
/** Add new preference labels, newest last, max 6. Exported for tests. */
export function mergePrefs(prev: string[] | undefined, found: string[]): string[] {
  const list = (prev || []).filter((p) => !found.includes(p));
  return [...list, ...found].slice(-6);
}
/** A student's own piece of writing (a History paragraph, an essay intro) pasted for feedback. Exported for tests. */
export function isStudentWriting(message: string): boolean {
  const m = String(message || "").trim();
  if (/^\s*\[/.test(m) || /\?\s*$/.test(m)) return false;
  const words = m.split(/\s+/).length;
  const sentences = (m.match(/[.!;](?:\s|$)/g) || []).length;
  return words >= 45 && sentences >= 2;
}
/** The reply rewrites their paragraph for them instead of giving feedback they can act on. Exported for tests. */
export function rewritesTheirWriting(reply: string): boolean {
  const r = String(reply || "");
  if (/\b(?:here(?:'s| is) (?:a |an |your )?(?:better|improved|rewritten|revised|stronger) (?:version|paragraph|intro(?:duction)?)|i(?:'ve| have) rewritten|voici (?:une )?(?:meilleure )?version (?:améliorée|corrigée|réécrite)|je l'ai réécrit)\b/i.test(r)) return true;
  // A long block of new prose in quotes is a rewrite too.
  return (r.match(/["“«][^"”»]{220,}["”»]/) || []).length > 0;
}

/** The student gave the answer to an open free-response problem in the chat ("so it's 3log_a x + ½log_a y − log_a z").
 *  It counts — reported: Otto kept insisting they retype a right answer into the box. Checks the whole message and the
 *  part after its last "=", "is" or ":" so a short sentence around the answer still matches; a bare-number key needs a
 *  short message so "3 of them?" can't match "3". Exported for tests. */
export function answeredInChat(message: string, p: TaskProblem): boolean {
  const m = String(message || "").trim();
  if (!p.answer || p.solved || p.options?.length || p.rubric || /^\s*\[/.test(m) || /\?\s*$/.test(m)) return false;
  const words = m.split(/\s+/).length;
  const numericKey = /^\s*-?\d+(?:[.,]\d+)?\s*[a-zA-Z%°/²³]*\s*$/.test(p.answer);
  // A long spoken working that ENDS on its result ("…12 over 16.67 so it's about 0.72 I'd say") — reported live: the
  // right 0.72 was ignored because the message was long. Only the last number in its last few words counts.
  if (words > 40) {
    if (!numericKey || /\b(?:not|isn'?t|wrong|pas)\b[^.?!]{0,30}$/i.test(m)) return false;
    const last = (m.split(/\s+/).slice(-12).join(" ").match(/-?\d+(?:[.,]\d+)?/g) || []).pop();
    return !!last && practiceAnswerMatches(last, p.answer!, p.value);
  }
  const tail = m.split(/=|\bit'?s\b|\bit is\b|\bis\b|:|\best\b|\bc'est\b|\bso\b|\bdonc\b/i).pop() || m;
  const candidates = [...new Set([m, tail.trim()])].filter(Boolean);
  if (numericKey) return candidates.some((c) => c.split(/\s+/).length <= 4 && practiceAnswerMatches(c, p.answer!, p.value));
  // An expression key: only a real mathematical match counts (never the loose leading-number fallbacks).
  return candidates.some((c) => logAnswerEquivalent(c, p.answer!) === "correct" || (logAnswerEquivalent(c, p.answer!) === "unknown" && exprEquivalent(c, p.answer!) === "correct"));
}

/** A gap is ONE maths blank the student fills in its answer box. Reported live: "g(?−?) = (M+m)a" (two blanks, so
 *  the box couldn't check it), "What does that tell us about Mg sinθ and mg? = ?" (a chat question dressed as a gap),
 *  and "Mg sinθ − T = ?" right under the finished "Mg sinθ − T = Ma" (asking for what's already there). */
export function badGap(text: string, board: string[]): string | null {
  const t = String(text || "");
  const plain = t.replace(/\$/g, "").replace(/\\?;\s*\?/g, "?");
  // "a = (g(M sinθ − m))/(M + m) = ?" (reported live): the blank asks for what the line already shows. A chain
  // "X = E = ?" is only a real question when E still has numbers to work out ("f''(1) = 12(1) − 18 = ?").
  { const parts = plain.replace(/[≤≥≠]|<=|>=/g, "~").split("=");
    if (parts.length >= 3 && /^\s*\?/.test(parts[parts.length - 1])) { const e = parts[parts.length - 2]; if (/\p{L}/u.test(e) && !/\d/.test(e) && e.trim().length > 3) return "that gap already shows its own answer — leave the result as the blank ('a = ?') and let them find it."; } }
  // One "?" and it is the blank near the end ("… = ?", "V = ? cm³ (3 s.f.)") — anything else is two blanks or a question.
  if ((plain.match(/\?/g) || []).length !== 1 || !/=\s*(?:\\;)?\s*\?[^?=]{0,24}$/.test(plain.trim()))
    return "a gap has exactly ONE blank, at the end ('… = ?'). Ask a question in chat, and put one blank on the board.";
  if (/\b(?:what|why|how|which|quoi|pourquoi|comment)\b/i.test(plain)) return "that's a question, not a maths blank — ask it in chat.";
  const norm = (x: string) => x.replace(/\$|\\[a-z]+|\s|[{}]/gi, "").toLowerCase();
  const lhs = norm(plain.replace(/^[^:=]*:\s*/, "").replace(/=\s*\?\s*$/, ""));
  if (lhs.length >= 3 && board.some((b) => { const m = /^(.*?)=(.+)$/.exec(norm(b.replace(/^[^:=]*:\s*/, ""))); return !!m && m[1] === lhs && !/\?/.test(m[2]); }))
    return "that line is already on the board with its right side — point at it instead of asking for it again.";
  return null;
}

/** The student's name opening reply after reply ("Willem, …" ×10, reported live): when the last reply already used
 *  it, this one drops the vocative. */
export function dropRepeatedName(reply: string, history: { role: string; text: string }[]): string {
  const m = /^\s*([A-ZÀ-Ý][\p{L}'-]{1,20}),\s+/u.exec(reply);
  if (!m) return reply;
  const last = [...history].reverse().filter((h) => h.role === "assistant").slice(0, 2);
  if (!last.some((h) => new RegExp(`\\b${m[1]}\\b`).test(h.text))) return reply;
  const rest = reply.slice(m[0].length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Real questions in a reply: "?" outside maths ($…$) and outside quoted examples. */
export function questionCount(reply: string): number {
  const t = String(reply || "").replace(/\$[^$]*\$/g, " ").replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, " ");
  return (t.match(/\?+/g) || []).length;
}

/** A short numeric answer to an open problem that does NOT match its key: a wrong attempt typed in chat (reported
 *  live: a wrong chat answer was met with a brand-new problem instead of looking at what went wrong). */
export function wrongInChat(message: string, p: TaskProblem): boolean {
  const m = String(message || "").trim();
  if (!p.answer || p.solved || p.options?.length || p.rubric || /^\s*\[/.test(m) || /\?\s*$/.test(m)) return false;
  if (!/^\s*-?\d+(?:[.,]\d+)?\s*[a-zA-Z%°/²³]*\s*$/.test(p.answer)) return false;
  const tail = (m.split(/=|\bit'?s\b|\bit is\b|\bis\b|:|\best\b|\bc'est\b|\bso\b|\bdonc\b|\bi got\b|\bj'ai trouvé\b/i).pop() || m).trim();
  if (tail.split(/\s+/).length > 3 || !/^[≈~]?\s*[-−]?\d/.test(tail)) return false;
  return !answeredInChat(message, p);
}

/** A critical-thinking partner doesn't just agree: in a discussion, a reply that endorses their point ("Great point",
 *  "Exactly", "I agree") without pushing on it — no objection, no request for evidence, no "what would a critic say" —
 *  teaches nothing (CAiSEY: "Good point about network effects. Can you think of a case where that logic didn't hold?").
 *  Exported for tests. */
export function agreesWithoutChallenge(reply: string, message: string): boolean {
  const r = String(reply || "").trim();
  if (!/^\s*(?:great|good|nice|excellent|interesting) (?:point|take|idea|argument)|^\s*(?:exactly|absolutely|i agree|that'?s (?:right|true|a good point)|yes\b|totally|right\b|bien vu|exactement|tout à fait|je suis d'accord|bonne idée)/i.test(r)) return false;
  if (String(message || "").trim().split(/\s+/).length < 6) return false;
  return !/\b(?:but|however|yet|though|what (?:would|if|about)|critic|counter|opposite|disagree|evidence|prove|show that|how do you know|why|which (?:matters|mattered)|stronger|weaker|case where|exception|always|assum|mais|cependant|pourtant|et si|preuve|pourquoi|contre-?argument|objection)\b/i.test(r);
}

/** The reply hands the choice back ("What would you like to start with?", "which topic…?") — the move a tutor that
 *  already owns a plan must not make when the student delegated. Exported for tests. */
export function asksStudentToChoose(reply: string): boolean {
  return /\b(?:what|which)\b[^?]{0,60}\b(?:would you like|do you want|should we|shall we|part|topic|area|chapter|start with|focus on|work on|look at)\b[^?]*\?|\bor (?:something else|another topic)\b[^?]*\?|\bpar quoi\b[^?]*\?|\bqu(?:'|e )(?:est-ce que )?(?:tu veux|veux-tu|aimerais-tu)\b[^?]*\?/i.test(String(reply || ""));
}

// ── One turn ──────────────────────────────────────────────────────────────────────────────────────────
export interface TutorTurnInput {
  history: { role: "user" | "assistant"; text: string }[];
  message: string;
  board: BoardEntry[];
  /** Problems on the board, WITH their answer keys (the route rehydrates them server-side). */
  problems: TaskProblem[];
  objectives: TaskObjective[];
  context: TutorContext;
  voiceMode?: boolean;
  canvasMode?: boolean;
  spoken?: { alternatives: string[] };
  stepVerdict?: { gap: string; given: string; verdict: "correct" | "incorrect" };
  /** The verified worked solution of the problem in focus (server/solver.ts) — hidden, the tutor steers by it. */
  solution?: TutorSolution;
  /** Help given so far this session (nextTeachingState). */
  teaching?: TutorTeachingState;
  /** Lesson plan for proactive teaching (optional, created from student goal). */
  lessonPlan?: LessonPlan;
  /** Current lesson state (synchronized across tutor, board, exercise engine). */
  lessonState?: LessonState;
  lang: "fr" | "en";
}

export interface TutorTurnResult {
  reply: string;
  board: BoardEntry[];
  /** In-place corrections to the tutor's OWN existing lines (id → new text) and lines taken off the active board (archived, never destroyed). */
  problems: TaskProblem[];
  objectives?: TaskObjective[];
  tokens: { in: number; out: number; cachedIn: number };
  /** The model failed outright (no reply at all). */
  error?: boolean;
  /** A reply had to be replaced because it gave the answer away. */
  guardrailTripped: boolean;
  /** Open problems the student answered correctly IN CHAT this turn — the client marks them solved (no retyping into the box). */
  solvedInChat?: string[];
  /** The exact `leaked` identifier from leakedValue() that tripped the guard this turn, if it did — fed
   *  into nextTeachingState so a SECOND consecutive trip on the same value can resolve it instead of
   *  repeating the identical fallback sentence forever (see guardrailStreak on TutorTeachingState). */
  leakedValue?: string;
  /** The model's hidden plan for this turn (parsed from <plan>…</plan>, never shown). */
  plan?: TutorPlanLite;
}

/** The model's hidden per-turn teaching decision. Parsed leniently — a missing or malformed plan never blocks a reply. */
export interface TutorPlanLite { diagnosis?: string; action?: string; helpLevel?: number; misconception?: string }
const ACTIONS = ["probe", "hint", "visual", "explain", "example", "practice", "confirm"];
/** How many unit-bearing quantities in the reply ("2 kg", "3 m", "400 N/m", "25°") appear nowhere in the conversation, board or problems. */
export function newQuantities(reply: string, sources: string[]): number {
  const hay = sources.join(" ").replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1");
  const nums = (String(reply).replace(/\$/g, " ").match(/\d+(?:[.,]\d+)?(?=\s?(?:°|\\circ|(?:m|cm|mm|km|kg|g|s|min|h|N|J|V|A|W|mol|L|mL|%|degrees?)\b))/gi) || []).map((n) => n.replace(",", "."));
  return new Set(nums.filter((n) => !new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(hay))).size;
}
/** The hidden plan: <plan>{json}</plan> — but models also close it with the wrong tag (</path>, </plan >) or not at all, which used to leak it into the reply. */
const PLAN_RE = /<plan>\s*(\{[\s\S]*?\})\s*(?:<\/[a-z]*\s*>)?/i;
export function parsePlan(text: string): TutorPlanLite | undefined {
  const m = PLAN_RE.exec(String(text || ""));
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[1].trim());
    const action = ACTIONS.includes(String(j.action)) ? String(j.action) : undefined;
    const helpLevel = Number.isFinite(Number(j.help_level)) ? Math.max(0, Math.min(4, Math.round(Number(j.help_level)))) : undefined;
    const mis = typeof j.misconception === "string" ? j.misconception.replace(/\s+/g, " ").trim().split(" ").slice(0, 10).join(" ").slice(0, 70) : "";
    return { ...(mis ? { misconception: mis } : {}), ...(j.diagnosis ? { diagnosis: String(j.diagnosis).slice(0, 40) } : {}), ...(action ? { action } : {}), ...(helpLevel != null ? { helpLevel } : {}) };
  } catch { return undefined; }
}

const STUCK = /\b(?:i (?:don'?t|do not) (?:know|get it|understand)|idk|no idea|i'?m (?:stuck|lost|confused)|not sure|je (?:ne )?sais pas|j'?sais pas|aucune idée|je suis (?:perdu|bloqué)e?|je comprends pas|help me|aide[- ]moi)\b/i;
/** The teaching state after this turn — updated by CODE from what actually happened (a stuck message, a code-verified
 *  wrong or right step), with the model's own help level only as the record of what it just gave. Pure. */
export function nextTeachingState(prev: TutorTeachingState | undefined, ev: { message: string; verdict?: "correct" | "incorrect"; plan?: TutorPlanLite; reachedStep?: boolean; leaked?: string }): TutorTeachingState {
  const p = prev || { helpLevel: 0, stuckStreak: 0, turns: 0 };
  const right = ev.verdict === "correct" || ev.reachedStep || /\[(?:Exercise|Exercice)\][^\n]*(?:marked right|checked right|juste)/i.test(ev.message);
  const stuck = !right && (STUCK.test(ev.message) || ev.verdict === "incorrect" || /\[(?:Exercise|Exercice)\][^\n]*(?:marked wrong|checked wrong|faux)/i.test(ev.message));
  return {
    turns: p.turns + 1,
    stuckStreak: right ? 0 : stuck ? p.stuckStreak + 1 : p.stuckStreak,
    // A right step drops the help back toward probing; otherwise the level is what the tutor just gave.
    helpLevel: right ? Math.max(0, (ev.plan?.helpLevel ?? p.helpLevel) - 2) : (ev.plan?.helpLevel ?? p.helpLevel),
    ...(ev.plan?.action ? { lastAction: ev.plan.action } : p.lastAction ? { lastAction: p.lastAction } : {}),
    ...(ev.plan?.diagnosis ? { lastDiagnosis: ev.plan.diagnosis } : p.lastDiagnosis ? { lastDiagnosis: p.lastDiagnosis } : {}),
    // Consecutive trips on the SAME blocked value (see leakedValue()'s call site) — resets to 0 the moment
    // a turn doesn't trip the guard at all, so moving on or genuinely resolving it clears the streak with
    // no separate reset logic. Reported live: four turns straight replaying one identical fallback sentence
    // because this never had any memory of having just tripped on the exact same thing.
    guardrailStreak: ev.leaked && ev.leaked === p.guardrailValue ? (p.guardrailStreak || 0) + 1 : ev.leaked ? 1 : 0,
    ...(ev.leaked ? { guardrailValue: ev.leaked } : {}),
    ...(() => { const m = updateMisconceptions(p.misconceptions, ev.plan, right); return m.length ? { misconceptions: m } : {}; })(),
    ...(() => { const a = affectOf(ev.message); return { affect: a, affectStreak: a === p.affect && a !== "neutral" ? (p.affectStreak || 0) + 1 : a === "neutral" ? 0 : 1 }; })(),
  };
}

/** Carry the session's misconceptions forward: a newly diagnosed one is added (or its count bumped), and the open
 *  ones are marked resolved once a turn shows a verified right step with no misconception diagnosed. Exported for tests. */
export function updateMisconceptions(prev: TutorTeachingState["misconceptions"], plan: TutorPlanLite | undefined, right: boolean): NonNullable<TutorTeachingState["misconceptions"]> {
  const list = [...(prev || [])].map((m) => ({ ...m }));
  const label = plan?.misconception?.trim();
  if (label) {
    const same = list.find((m) => m.label.toLowerCase() === label.toLowerCase());
    if (same) { same.turns += 1; same.resolved = false; } else list.push({ label, turns: 1 });
  } else if (right) {
    // The most recent open misconception is the one this right step most plausibly repairs.
    const open = [...list].reverse().find((m) => !m.resolved);
    if (open) open.resolved = true;
  }
  return list.slice(-5);
}

/** The teaching state as a prompt block — what help has been given and what the next move should be. */
export function teachingBlock(t: TutorTeachingState | undefined): string {
  if (!t || !t.turns) return "";
  const advice = t.stuckStreak >= 2
    ? "They've been stuck " + t.stuckStreak + " turns in a row: questions aren't working. Explain the missing idea directly and briefly (or show a worked example with different numbers), then hand the next step back to them."
    : t.stuckStreak === 1
      ? "They were stuck last turn: go one rung up (a sharper hint, a pointer on the board, or a figure), not the same question again."
      : "They're moving: keep the help light (a question or a nudge).";
  const open = (t.misconceptions || []).filter((m) => !m.resolved);
  const mis = open.length ? ` OPEN MISCONCEPTIONS this session: ${open.map((m) => `"${m.label}"${m.turns > 1 ? ` (seen ${m.turns}×)` : ""}`).join("; ")} — before moving on, test each with a FRESH case that only works if they've let go of it; a confident wrong answer means probe the belief, not reteach the method.` : "";
  const affect = t.affect === "frustrated" ? ` They sound FRUSTRATED${(t.affectStreak || 0) > 1 ? ` (${t.affectStreak} turns running)` : ""}: acknowledge it in a few warm words, shrink the next step so they get a quick win, praise the effort or the strategy (never "you're smart"), and keep the question easy to answer.`
    : t.affect === "unsure" ? " They sound UNSURE: ask them to talk through their reasoning (or rate how sure they are, 1-5) before you confirm or correct — a guess that happens to be right is not yet understanding."
    : t.affect === "confident" ? " They sound CONFIDENT: if they're right, raise the challenge; if they're wrong, this is the moment to probe the belief with a counter-example, not to reteach."
    : "";
  const resolved = (t.misconceptions || []).filter((m) => m.resolved);
  const res = resolved.length ? ` Repaired so far: ${resolved.map((m) => `"${m.label}"`).join("; ")} — check one again later in the session (spaced retrieval).` : "";
  return `\n\nTEACHING STATE (kept by the app): help level so far ${t.helpLevel}/4${t.lastAction ? `, last move: ${t.lastAction}` : ""}${t.lastDiagnosis ? `, last diagnosis: ${t.lastDiagnosis}` : ""}. ${advice}${mis}${res}${affect}`;
}

/** Does `text` state the solution's final number? A number that's already in the problem statement (a given that
 *  happens to equal the answer) doesn't count, nor do tiny numbers that read as step counters. */
export function statesFinalAnswer(text: string, sol: TutorSolution | undefined): boolean {
  if (!sol || sol.value == null) return false;
  const v = sol.value;
  const nums = (x: string) => (String(x || "").replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const givens = new Set(nums(sol.statement).map((n) => Math.round(n * 1e6)));
  if (givens.has(Math.round(v * 1e6))) return false;
  if (Math.abs(v) < 10 && Number.isInteger(v)) {
    // a small whole answer only counts when stated as the answer ("x = 4", "= 4", "is 4")
    return new RegExp(`(?:=|\\bis|\\bequals?|\\bgives?)\\s*\\$?\\s*${v}(?![\\d.])`, "i").test(String(text || ""));
  }
  return nums(text).some((n) => Math.abs(n - v) <= Math.max(0.01, Math.abs(v) * 0.006));
}

/** What this turn PROVES about the skill, from code-verified events only (exercise results, gap/step verdicts,
 *  the solution's final answer) — never the model's own opinion. The help already given decides how much a right
 *  answer counts. Returns null when nothing was verified this turn. Exported for tests. */
export function evidenceKindFor(ev: { message: string; verdict?: "correct" | "incorrect"; reachedFinal?: boolean; helpLevel: number }):
  "solved-unaided" | "solved-after-hint" | "solved-after-partial" | "solved-after-explanation" | "mistake" | null {
  const ex = /\[(?:Exercise|Exercice)\][^\n]*?(marked right|checked right|juste|marked wrong|checked wrong|faux)/i.exec(ev.message);
  const right = ev.verdict === "correct" || ev.reachedFinal || (ex && /right|juste/i.test(ex[1]));
  const wrong = !right && (ev.verdict === "incorrect" || (ex && /wrong|faux/i.test(ex[1])));
  if (wrong) return "mistake";
  if (!right) return null;
  return ev.helpLevel <= 0 ? "solved-unaided" : ev.helpLevel <= 2 ? "solved-after-hint" : ev.helpLevel === 3 ? "solved-after-partial" : "solved-after-explanation";
}

/** A code verdict from the solution: the student's number matches a step (or the answer). */
export function solutionMatchLine(message: string, sol: TutorSolution | undefined): string {
  const r = reachedSolutionSteps(message, sol);
  if (!r.length) return "";
  return `\n\nVERIFIED BY CODE: the number they just gave matches ${r.includes(0) ? "the FINAL ANSWER" : `step ${r[0]} of the worked solution`} — it is RIGHT. Confirm it specifically, then ${r.includes(0) ? "have them check it makes sense and ask about another method or a similar problem" : "move to the next step"}.`;
}

/** The student's numbers that match a step of the verified solution — they've reached that step. Exported for tests. */
export function reachedSolutionSteps(message: string, sol: TutorSolution | undefined): number[] {
  if (!sol) return [];
  const theirs = (String(message || "").replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n) && Math.abs(n) >= 1);
  const hits: number[] = [];
  sol.steps.forEach((st, i) => { if (st.value != null && theirs.some((n) => Math.abs(n - st.value!) <= Math.max(0.01, Math.abs(st.value!) * 0.006))) hits.push(i + 1); });
  if (sol.value != null && theirs.some((n) => Math.abs(n - sol.value!) <= Math.max(0.01, Math.abs(sol.value!) * 0.006))) hits.push(0);
  return hits;
}

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 14;

/** The answer keys a reply must not state: open gaps (board + this turn) and unsolved problems. A value the
 *  student already said themselves is theirs, not a leak. Exported for tests. */
export function leakedValue(reply: string, message: string, board: BoardEntry[], problems: TaskProblem[], sol?: TutorSolution): string | null {
  // The verified solution's final answer (as a number within rounding, or as text) is never said before they get it.
  if (sol && statesFinalAnswer(reply, sol) && !statesFinalAnswer(message, sol)) return "the problem's answer";
  for (const g of board) {
    if (g.kind !== "gap" || !g.expectedAnswer || g.status === "correct") continue;
    if (replyStatesValue(reply, g.expectedAnswer) && !replyStatesValue(message, g.expectedAnswer)) return g.expectedAnswer;
  }
  const open = problems.filter((p) => !p.solved);
  if (open.length && leaksAnyProblemAnswer(reply, open) && !leaksAnyProblemAnswer(message, open)) return "the problem's answer";
  return null;
}

/** Spec §8.2 / test 16: the message reports a CORRECT exercise result ("[Exercise] … marked right") — the tutor must
 *  then move on (next activity), not stop at "well done". Exported for tests. */
export function reportsCorrectResult(message: string): boolean {
  return /^\s*\[(?:Exercise|Exercice)\][^\n]*\b(?:marked right|checked right|juste)\b/i.test(String(message || "")) && !/\b(?:wrong|faux|NOT graded|non not[ée]|PARTLY|en partie)\b/i.test(String(message || ""));
}

/** Does the reply end by pointing the student somewhere new (a question, or a created problem/board line)? Exported for tests. */
export function movesOn(reply: string, createdSomething: boolean): boolean {
  return createdSomething || /\?\s*["»”)]*\s*$/.test(String(reply || "").trim());
}

/** Spec §12 #6 / test 24: "look at the graph/diagram/table/summary" while no such object is on the board. Returns the
 *  missing object's kind, or null. Exported for tests. */
export function pointsAtMissingObject(reply: string, boardKinds: string[]): string | null {
  const m = String(reply || "").match(/\b(?:look at|see|check|regarde[zr]?|voi[st]|observe[zr]?|take a look at)\b[^.?!\n]{0,24}\b(?:the|this|that|le|la|ce|cette)\s+(graph|graphique|diagram|diagramme|figure|table|tableau|summary|r[ée]sum[ée])(?![a-zà-ÿ])/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const want = /^(graph)/.test(w) ? ["graph"] : /^(diagram|figure)/.test(w) ? ["diagram", "svg"] : /^(table)/.test(w) ? ["table", "widget"] : ["summary"];
  return want.some((k) => boardKinds.includes(k)) ? null : want[0];
}

/** The student asked to be given an exercise ("give me a problem", "test me", "un exercice"). Exported for tests. */
export function wantsExercise(message: string): boolean {
  return asksForProblem(message) || /\b(?:one|a|the)\s+(?:last|final|other)\s+(?:problem|exercise|question|one)\b|\bcan you (?:do|make|give|create)\b[^.?!]{0,20}\b(?:problem|exercise|question)\b|\b(?:quiz|test) me\b|\binterroge[- ]moi\b|\b(?:un|des|un autre|nouvel?)\s+(?:exo|exercice|probl[èe]me)s?\b|\bpractice (?:problem|question)s?\b/i.test(String(message || ""));
}

/** A board line that sets up a problem nobody gave: a scenario/givens line (2+ quantities with units) carrying a
 *  number that appears nowhere in what the student said or in a problem already posted. That's Otto inventing an
 *  exercise as plain board text — it belongs in CREATE_PROBLEM, with an answer box. Exported for tests. */
export function inventsProblemOnBoard(text: string, said: string[], known: number[] = []): boolean {
  if (!looksLikeGivensOrScenario(text)) return false;
  const toNum = (n: string) => Number(n.replace(",", "."));
  const nums = (String(text).replace(/\\[a-zA-Z]+/g, " ").replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").match(/\d+(?:[.,]\d+)?/g) || []).map(toNum);
  const heard = (said.join(" ").replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").match(/\d+(?:[.,]\d+)?/g) || []).map(toNum);
  // Not invented: what they said, what the verified solution reaches, standard constants (g, unit factors), and a
  // unit conversion of a number they gave ("54 km/h = 15 m/s"). Reported: givens lines with g = 9.8 were refused.
  const base = [...heard, ...known, ...BOARD_CONSTANTS];
  const ok = base.flatMap((h) => [h, ...CONVERSIONS.flatMap((k) => [h * k, h / k])]);
  return nums.some((n) => !ok.some((h) => Math.abs(h - n) <= Math.max(0.051, Math.abs(h) * 0.005)));
}
const BOARD_CONSTANTS = [9.8, 9.81, 10, 3.6, 1000, 60, 100, 3600, 2, 1, 0];
const CONVERSIONS = [3.6, 1000, 60, 100, 3600];

/** The reply asks them to recheck something that is RIGHT: the app already marked their exercise answer right, or
 *  the number they just gave IS the value of the expression the reply tells them to redo ("235,200" vs "multiply
 *  1200×9.8×20"; "24350" vs "800×9.8×sin(15°)×12"). Returns the correction note, or null. Exported for tests. */
export function doubtsRightAnswer(reply: string, message: string, sol?: TutorSolution): string | null {
  const RECHECK = /\b(?:check (?:that|this|it|your|the)|re-?verify|(?:try|run|re-?run|work|do) (?:it |that |this )?(?:out )?again|re-?check|re-?run|let'?s (?:check|re-?run|redo)|double[- ]check|not quite|was from the previous|look again|try \d)/i;
  if (!RECHECK.test(reply)) return null;
  if (/\[(?:Exercise|Exercice)\][^\n]*(?:marked right|checked right|juste|vérifié juste)/i.test(message)) return "the app already checked their answer and it is RIGHT — don't ask them to redo it; acknowledge it and move on";
  const num = (x: string) => Number(x.replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").replace(",", "."));
  const allNums = (message.match(/\d[\d\s,]*(?:\.\d+)?/g) || []).map((x) => num(x.trim())).filter((n) => Number.isFinite(n));
  if (!allNums.length) return null;
  // Their number IS a step of the verified solution: right, whatever the reply's own arithmetic says. No
  // floor here — reachedSolutionSteps already does its own tolerance-based matching against real solution
  // values, so an ordinary small correct answer ("P = 8", "x = 3") is exactly as reliable a match as a large
  // one. Was gated behind `n >= 10` on this exact list, which silently excluded any small answer from EVER
  // reaching this check at all — reported live: a correct P=8 kept getting doubted in a loop because "8"
  // never passed that floor.
  const reached = reachedSolutionSteps(message, sol);
  if (reached.length) return `their number is ${reached.includes(0) ? "the correct final answer" : `correct (it's step ${reached[0]} of the solution)`} — they were RIGHT; confirm it instead of asking them to redo it`;
  // The floor matters here, though: matching the reply's own stated arithmetic (not a verified solution) is
  // a looser heuristic, so keep it restricted to numbers that look like a real exercise answer rather than
  // an incidental small digit (a step count, a coefficient) that happens to equal some unrelated product.
  const theirs = allNums.filter((n) => n >= 10);
  if (!theirs.length) return null;
  const plain = latexToPlainText(reply.replace(/\$/g, " "));
  for (const m of plain.matchAll(/\d[\d.,]*\s*[×x*·]\s*[\d\s.,×x*·()°a-z]*\d[)°]*/gi)) {
    const src = toExprSource(m[0].replace(/(\d),(\d{3})/g, "$1$2"));
    const f = compileExpr(src, []);
    if ("error" in f) continue;
    const v = f.fn({});
    const hit = Number.isFinite(v) && theirs.find((n) => Math.abs(n - v) <= 0.005 * Math.max(1, Math.abs(v)));
    if (hit) return `their ${hit} IS ${m[0].trim()} (= ${Math.round(v * 100) / 100}) — they were RIGHT; confirm it instead of asking them to redo it`;
  }
  return null;
}

/** The exercise widget itself marked the student's answer wrong, but the independently verified solution
 *  (server/solver.ts's own re-solve, NOT the exercise's own possibly-wrong stored key) says they were
 *  right. Unlike doubtsRightAnswer above, this fires regardless of what the model's own draft reply says —
 *  it doesn't need "recheck" language in the reply, because the thing being corrected here is the GRADE
 *  itself, not just Otto's tone about it. Reported live: a correct P=8 was marked wrong twice running, and
 *  across several turns Otto kept doubting the student instead of ever just saying the key was wrong.
 *  Exported for tests. */
export function misgradedExercise(message: string, sol?: TutorSolution): string | null {
  if (!/\[(?:Exercise|Exercice)\][^\n]*(?:marked wrong|checked wrong|faux)/i.test(message)) return null;
  const reached = reachedSolutionSteps(message, sol);
  if (!reached.length) return null;
  return reached.includes(0)
    ? "Their stated answer actually matches the verified solution — the exercise's own key was wrong, not them."
    : `Their stated number matches step ${reached[0]} of the verified solution — it's right, even though this particular exercise widget marked it wrong.`;
}

/** A gap that states an equation and asks for its unknown ("2·9.8·3 = ½(400)x² ⟹ x = ?"): the key is SOLVED here, not taken from the model.
 *  Finds the positive root of lhs − rhs numerically (scan + bisection); null unless there is exactly one clear positive root. Exported for tests. */
export function solvedGapKey(text: string): number | null {
  const plain = latexToPlainText(String(text || "").replace(/\$/g, " ")).replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const target = /([A-Za-z])\s*=\s*\?\s*$/.exec(plain)?.[1];
  if (!target) return null;
  // The connective split must accept the PLAIN-WORD forms too: latexToPlainText renders \implies as "implies"
  // (and a board line may carry the word directly), and when that wasn't split the "… = ?" tail became a
  // third "=" side, the function bailed out with null, and grading fell back to the model's unverified key —
  // the reported live failure where P = 8 and P = 5 were marked wrong off a wrong stored key.
  const eq = plain.split(/⟹|⟸|⇒|⇐|⟺|→|->|=>|\\Rightarrow|\\Longrightarrow|\b(?:implies|implique|imply|donc|thus|therefore|then|so)\b/i)[0].replace(/½/g, "(1/2)").replace(/[·⋅×]/g, "*").replace(/²/g, "^2").replace(/³/g, "^3");
  const sides = eq.split("=");
  if (sides.length !== 2 || !sides.every((x) => x.trim())) return null;
  const re = new RegExp(`(?<![A-Za-z])${target}(?![A-Za-z])`, "i");
  if (!re.test(sides[0] + sides[1])) return null;
  // compileExpr lowercases every identifier, so the value map must be keyed the same way — with the raw
  // target ("P") the function was NaN at every point and no root was ever found (upper-case unknowns only).
  const targetKey = target.toLowerCase();
  const l = compileExpr(toExprSource(sides[0].replace(/(?<=\d|\))\s*(?=[A-Za-z(])/g, "*"), targetKey), [targetKey]);
  const r = compileExpr(toExprSource(sides[1].replace(/(?<=\d|\))\s*(?=[A-Za-z(])/g, "*"), targetKey), [targetKey]);
  if ("error" in l || "error" in r) return null;
  const f = (x: number) => l.fn({ [targetKey]: x }) - r.fn({ [targetKey]: x });
  const roots: number[] = [];
  let prev = 1e-6, fp = f(prev);
  for (let x = 1e-6, step = 1.05; x < 1e6; x *= step) {
    const cur = x * step, fc = f(cur);
    if (Number.isFinite(fp) && Number.isFinite(fc) && fp * fc <= 0 && fp !== fc) {
      let a = prev, b = cur;
      for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if (f(a) * f(m) <= 0) b = m; else a = m; }
      const root = (a + b) / 2;
      if (!roots.some((q) => Math.abs(q - root) < 1e-6 * Math.max(1, root))) roots.push(root);
    }
    prev = cur; fp = fc;
  }
  return roots.length === 1 ? Math.round(roots[0] * 1e6) / 1e6 : null;
}

/** A gap's answer key, resolved WITHOUT a server-side board — the tutor's board now lives in the browser
 *  (client/localChatBoard.ts), so the server no longer holds the gap it is being asked to grade.
 *
 *  Priority, deliberately: (1) a key recomputed from THE LINE ITSELF by code — the independent verification
 *  spec §19 asks for, which is what makes the grade trustworthy; (2) the key this server still holds from a
 *  turn served before the board moved local (or from an account that predates it); (3) the key the browser
 *  sent along with the line, which the server generated in the first place — the only remaining source now,
 *  and the one that lets a miss be a miss at all. A key the browser could lie about only ever affects the
 *  student's own self-check, never anyone else's grade. Pure; exported for tests. */
export function resolveGapKey(lineText: string, storedKey?: string, sentKey?: string): string | undefined {
  const computed = computedGapKey(String(lineText || "")) ?? solvedGapKey(String(lineText || ""));
  if (computed != null) return String(computed);
  const stored = typeof storedKey === "string" && storedKey.trim() ? storedKey.trim() : undefined;
  if (stored) return stored.slice(0, 200);
  return typeof sentKey === "string" && sentKey.trim() ? sentKey.trim().slice(0, 200) : undefined;
}

/** One exercise the browser sent back this turn, WITH its answer key when the server no longer stores a copy
 *  of it (tutor problems are local-only now, like the board). The server's own stored problem always wins
 *  when it has one — including its code-verified `value` — so the leak guard and answer-box grading never
 *  depend on what the browser claims; only when there is no stored copy does the sent one stand in, which is
 *  the same key the server handed that browser when the problem was created. Pure; exported for tests. */
export function rehydrateProblemKey(sent: any, stored?: TaskProblem): TaskProblem {
  const base: TaskProblem = stored
    ? { ...stored, solved: sent?.solved === true }
    : { id: typeof sent?.id === "string" ? sent.id.slice(0, 64) : "", createdAt: "", question: String(sent?.question || "").slice(0, 600), solved: sent?.solved === true };
  if (stored?.answer || stored?.value != null) return base;
  const answer = typeof sent?.answer === "string" && sent.answer.trim() ? sent.answer.trim().slice(0, 200) : undefined;
  const value = typeof sent?.value === "number" && Number.isFinite(sent.value) ? sent.value : undefined;
  const options = Array.isArray(sent?.options) ? sent.options.map((o: any) => String(o).slice(0, 300)).filter(Boolean).slice(0, 6) : undefined;
  const correct = Number.isInteger(sent?.correct) ? Number(sent.correct) : undefined;
  return {
    ...base,
    ...(answer ? { answer } : {}),
    ...(value != null ? { value } : {}),
    ...(options?.length && !base.options ? { options } : {}),
    ...(correct != null && base.correct == null && options?.length ? { correct } : {}),
  };
}

/** A gap whose line is a pure number calculation ("900×9.8×sin(12°) + 900×0.4 + 360 = ?") has its key computed
 *  HERE, not guessed by the model — a guessed "2553" for 2553.8 marked a right 2554.4 wrong (reported live).
 *  Returns the computed value, or null when the line isn't a closed calculation. Exported for tests. */
export function computedGapKey(text: string): number | null {
  const plain = latexToPlainText(String(text || "").replace(/\$/g, " ")).replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const m = /(?:^|=|:)\s*([(\d][\d.\s×x*·/÷+\-−()°^√a-z]*?)\s*=\s*\?\s*$/i.exec(plain);
  if (!m || !/[×x*·/÷+\-−^]/.test(m[1]) || (m[1].match(/\d+(?:\.\d+)?/g) || []).length < 2) return null;
  const f = compileExpr(toExprSource(m[1]), []);
  if ("error" in f) return null;
  const v = f.fn({});
  return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
}

const STOP = new Set("that this with have from what when where which their there about would could should these those them they then than just also into your yours been were will what the and for are but not you can how why does each other step line board".split(" "));
/** Is a board line about the problem in focus? It must share a number or a real word with the focus (the solution's
 *  statement, the givens, the problems, what the student said recently) — the board kept getting lines nobody asked
 *  for (reported: "sometimes it just writes random stuff"). Empty focus (session just started) → anything goes. */
export function relevantToFocus(text: string, focus: string[], values: number[] = []): boolean {
  const toks = (x: string) => {
    const plain = latexToPlainText(String(x || "").replace(/\$/g, " ")).toLowerCase().replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
    return new Set([...(plain.match(/\d+(?:\.\d+)?/g) || []), ...(plain.match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !STOP.has(w))]);
  };
  const f = new Set(focus.flatMap((x) => [...toks(x)]));
  if (!f.size) return true;
  const mine = [...toks(text)];
  if (!mine.length) return true; // pure symbols ("$F = ma$" with no numbers/words) can't be judged — let it through
  // Numbers match within rounding (214.45 on the board, 214.4 in the solution), and any value the verified solution
  // reaches counts — a result they derived is about the problem even if nobody typed that exact number yet.
  const nums = [...f].filter((w) => /^\d/.test(w)).map(Number).concat(values);
  const near = (w: string) => { const v = Number(w); return v >= 1 && nums.some((g) => Math.abs(g - v) <= Math.max(0.051, Math.abs(g) * 0.01)); };
  return mine.some((w) => f.has(w) || (/^\d/.test(w) && near(w)) || [...f].some((g) => g.length >= 5 && w.length >= 5 && (g.startsWith(w.slice(0, 5)) || w.startsWith(g.slice(0, 5)))));
}

/** A wrong arithmetic claim in the reply ("12 × 3 = 38"), as a correction note for the model, or null. */
export function wrongArithmetic(reply: string, message = ""): string | null {
  // A wrong claim the STUDENT made, quoted back to them, is the point of the reply — not Otto's own slip.
  const said = message.replace(/\s+/g, "");
  const bad = findArithmeticClaims(reply).filter((c) => c.mismatch && !said.includes(c.raw.replace(/\s+/g, "")));
  if (!bad.length) return null;
  return bad.map((c) => `"${c.raw}" is false (the left side is ${c.left})`).join("; ");
}

function cleanReply(text: string, voice: boolean): string {
  let t = stripWrapperTags(stripLeakedToolCallSyntax(String(text || ""))).replace(/<plan>[\s\S]*?<\/plan>/gi, "").replace(new RegExp(PLAN_RE.source, "gi"), "").replace(/<\/?(?:plan|path)\s*>/gi, "").trim();
  t = t.replace(/^\s*(otto|tutor)\s*:\s*/i, "").replace(/\*\*(.+?)\*\*/g, "$1");
  // Voice mode keeps the maths typeset on screen: what is SHOWN and what is SAID differ, and the spoken words are made
  // in the browser (client/voice/useSpeechSynthesis.ts toSpeakableText: "a − b" → "a minus b"). Flattening the LaTeX
  // here made the bubble unreadable ("a=(M sin(theta) −m)M+mg") without making the speech any better.
  void voice;
  return dedupeParagraphs(t.trim());
}
/** Canned praise as an OPENER ("Spot on, Willem!", "Exactly — 60 J", "Perfect, that's 20.8"): the student sees it
 *  first and it's the same every turn, so it carries no information (reported live: "don't always say spot on").
 *  Stripped in code after the prompt's own rule has had its say. A praise word with a lowercase continuation
 *  ("Spot on with using the component…") is left to the correction round instead of splicing a sentence open. */
const PRAISE_OPENER = /^\s*(?:spot on|exactly|perfect|nailed it|well done|great (?:job|work|one))\s*[,.!:—–-]+\s*(?:[A-ZÀ-Ý][\p{L}'’-]+\s*[,.!:—–-]+\s*)?/iu;
export function stripPraiseOpener(t: string): string {
  const rest = t.trimStart().replace(PRAISE_OPENER, "").trimStart();
  return rest.length >= 12 ? rest.charAt(0).toUpperCase() + rest.slice(1) : t;
}

/** The one line of maths in a reply that belongs on the board: its own $…$ spans, or the clause around the "=". */
function formulaLineFor(reply: string): string {
  // Only a RELATION is worth a board line: a bare fragment like "$Mg\sin\theta - T$" says nothing on its own (reported live).
  const spans = (reply.match(/\$[^$\n]{3,}\$/g) || []).filter((x) => /[=<>≈≤≥]|\\(?:le|ge|approx|neq)/.test(x)).slice(0, 3).join(" ");
  if (spans) return /\?/.test(spans) ? "" : spans.slice(0, 200);
  if (/\$[^$\n]{3,}\$/.test(reply)) return "";
  return plainRelationIn(reply);
}
const GREEK_TEX: Record<string, string> = { "θ": "\\theta", "α": "\\alpha", "β": "\\beta", "μ": "\\mu", "π": "\\pi", "λ": "\\lambda", "ω": "\\omega", "Δ": "\\Delta", "ρ": "\\rho", "σ": "\\sigma", "φ": "\\phi" };
/** Plain-text maths ("T - mg = ma", "Msinθ − m = 0") as one typeset span. Text that already has $…$, or reads as prose
 *  (a word of 4+ letters that isn't a function name), is returned unchanged. Pure; exported for tests. */
export function typesetPlainMath(line: string): string {
  const t = String(line || "").trim();
  const MATH_WORDS = /sin|cos|tan|log|ln|sqrt|theta|alpha|beta|gamma|delta|lambda|sigma|omega|phi|rho|mu|pi/gi;
  if (!t || /\$/.test(t) || !/[=<>≤≥+\-−*/^×·]/.test(t) || /[A-Za-z]{4,}/.test(t.replace(MATH_WORDS, " "))) return t;
  const tex = t.replace(/[θαβμπλωΔρσφ]/g, (c) => `${GREEK_TEX[c]} `)
    .replace(/(?<!\\)\b(theta|alpha|beta|gamma|delta|lambda|sigma|omega|phi|rho|mu|pi)\b/gi, (w) => `\\${w.toLowerCase()} `)
    .replace(/−/g, "-").replace(/×|·/g, "\\times ").replace(/²/g, "^2").replace(/³/g, "^3")
    .replace(/(?<!\\)(sin|cos|tan)(?=\s|\\|\(|[a-zA-Z0-9]|$)/g, " \\$1 ").replace(/\s+/g, " ").trim();
  return `$${tex}$`;
}

/** A plain-text relation in prose ("Work is force times distance: W = Fd when…" → "W = Fd"): only the run of maths
 *  tokens touching the "=", never the words around it — a clause cut at punctuation put fragments like
 *  ") =(M+ m)a right there" and "a = …: what does that tell us" on the board (reported live). Exported for tests. */
export function plainRelationIn(reply: string): string {
  const MATH = /^(?:[A-Za-zα-ωΔΣΩ]{1,2}[\d²³]*|(?:sin|cos|tan|log)[a-zθα-ω]*|[a-z]*[A-Zα-ωΔΣΩ][A-Za-zα-ω]{0,2}[\d²³]*|[\d.,]+[A-Za-z]{0,2}|[=≈<>≤≥+\-−*/·×^()²³√]+|[()\dA-Za-zα-ωθ+\-−*/·×^²³√.]*[=+\-−*/·×^()²³√][()\dA-Za-zα-ωθ+\-−*/·×^²³√.=]*)$/u;
  const toks = String(reply || "").replace(/\s*([=≈])\s*/g, " $1 ").split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    if (!/^[=≈]$/.test(toks[i])) continue;
    let a = i, b = i;
    const clean = (t: string) => t.replace(/[,;:.!?]+$/, "");
    while (a > 0 && MATH.test(toks[a - 1]) && !/[,;:.!?]$/.test(toks[a - 1]) && !/^(?:is|it|so|we|to|of|in|on|at|as|an|or|by|be|the|and|you|for|but|now|get|its)$/i.test(toks[a - 1])) a--;
    while (b < toks.length - 1 && MATH.test(clean(toks[b + 1])) && !/^(?:is|it|so|we|to|of|in|on|at|as|an|or|by|be|the|and|you|for|but|now|get|its)$/i.test(clean(toks[b + 1]))) { b++; if (/[,;:.!?]$/.test(toks[b])) break; }
    if (a === i || b === i) continue;
    const line = toks.slice(a, b + 1).map(clean).join(" ").trim();
    const depth = [...line].reduce((d, ch) => (d < 0 ? d : d + (ch === "(" ? 1 : ch === ")" ? -1 : 0)), 0);
    if (depth !== 0 || /\?/.test(line) || line.length > 120) continue;
    // Typeset it ourselves: a bare "W = Fd" handed to the board's auto-LaTeX came out as "$W =$ Fd".
    return typesetPlainMath(line);
  }
  return "";
}

/** The comparison key for duplicate detection: case, ALL whitespace, and the glyph variants the model
 *  flip-flops between across two copies of the same sentence (− U+2212 vs hyphen, curly vs straight quotes).
 *  Whitespace used to be merely COLLAPSED, so one copy reading "−0.06N" and the other "-0.06 N" compared
 *  unequal on two counts and the student read the same three paragraphs twice in one bubble (reported live).
 *  The key is only ever compared — the paragraphs themselves are emitted unchanged. */
const normForDedupe = (s: string): string => String(s)
  .replace(/[\u2212\u2010-\u2015]/g, "-")
  .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, "").toLowerCase();

/** A reply that repeats a whole paragraph (the model sometimes emits its message twice) keeps each paragraph once. Exported for tests. */
export function dedupeParagraphs(rawText: string): string {
  // Reported live: the WHOLE reply (several paragraphs, ending in a question) appeared twice back to back
  // in the SAME bubble, with only a SINGLE newline at the seam between the two copies — the paragraph pass
  // below only catches duplicates separated by a BLANK line, so a single-newline seam slips straight
  // through it. Worse, running the paragraph pass FIRST can silently drop just the middle paragraph of a
  // seamed duplicate (it matches an earlier paragraph's key on its own) while leaving the rest jumbled, so
  // this whole-text check must run on the RAW text first, before paragraph-level processing reshapes it.
  // If the back half of the text is a normalized duplicate of the front half, it's one message said twice,
  // not two different paragraphs — try the newline nearest the midpoint as the seam (never a mid-sentence
  // cut) and only act on a substantial match (see normForDedupe for what "the same" ignores).
  const mid = Math.floor(rawText.length / 2);
  for (const cut of [rawText.lastIndexOf("\n", mid), rawText.indexOf("\n", mid)]) {
    if (cut <= 0 || cut >= rawText.length - 1) continue;
    const a = normForDedupe(rawText.slice(0, cut));
    if (a.length < 20) continue;
    if (a === normForDedupe(rawText.slice(cut))) { rawText = rawText.slice(0, cut).trimEnd(); break; }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const para of rawText.split(/\n{2,}/)) {
    const key = normForDedupe(para);
    if (key && seen.has(key)) continue;
    seen.add(key);
    out.push(para.trim());
  }
  return out.join("\n\n");
}

/** Lesson plan block: shows the current lesson sequence and next recommended activity (proactive teaching). */
function lessonPlanBlock(plan?: LessonPlan, state?: LessonState): string {
  if (!plan) return "";
  const current = getCurrentTopic(plan);
  if (!current) return "\n\nLESSON PLAN: Complete — mixed exam-style practice.";
  
  const { topic, subtopic } = current;
  const summary = generateLessonPlanSummary(plan);
  const recommended = state?.recommendedAction 
    ? `\nNext: ${state.recommendedAction.description}`
    : "";
  
  return `\n\nLESSON PLAN (proactive teaching): ${summary}${recommended}`;
}

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult> {
  const { message, history, board, problems, objectives, context, lang } = input;
  const fr = lang === "fr";
  const result: TutorTurnResult = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };
  // A right answer given in chat to an open problem counts as solving it.
  const solvedNow = problems.filter((p) => answeredInChat(message, p));
  if (solvedNow.length) { for (const p of solvedNow) p.solved = true; result.solvedInChat = solvedNow.map((p) => p.id); }

  // The exercise widget marked them wrong, but the independently-verified solution says they were right: the
  // model is told as a binding fact and answers in its own words (no canned reply — it has to feel natural).
  const misgraded = misgradedExercise(message, input.solution);

  const spokenRepair: SpokenRepair | null = input.spoken
    ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || ""), ...problems.map((p) => p.question || "")]))
    : null;

  // The plan is set and started at once (no approval round): the student can change it any time.
  const planConsent = true;
  const planPending = !objectives.length && history.length > 0 && (() => { const l = [...history].reverse().find((h) => h.role === "assistant"); return !!l && proposesPlan(l.text); })();
  const discussion = isDiscussionSubject(context.subject, [message, ...history.slice(-4).map((h) => h.text)].join(" "));
  // They need it explained, not another question: the "don't hand them an equation" checks step aside this turn.
  const explain = needsExplanation(message, input.teaching);
  const restart = asksToRestart(message);
  const system = TUTOR_PROMPT
    + (input.voiceMode ? VOICE_BLOCK : "")
    + nowBlock()
    + backgroundBlock(context)
    + (discussion ? DISCUSSION_BLOCK : "")
    + objectivesBlock(objectives)
    + lessonPlanBlock(input.lessonPlan, input.lessonState)
    + (boardSurfaceBlock(board, problems) || "\n\nTHE BOARD IS EMPTY.")
    + solutionBlock(input.solution)
    + solutionMatchLine(message, input.solution)
    + (misgraded ? `\n\nCHECKED BY CODE — THEY WERE RIGHT: ${misgraded} Say so plainly in your own words (the exercise's key was wrong, not them), keep their working, and move on — never ask them to redo or re-enter it.` : "")
    + ownArithmeticLine(message)
    + teachingBlock(input.teaching)
    + repairLine(message, history)
    + (asksWhy(message) ? WHY_BLOCK : "")
    + (explain ? EXPLAIN_BLOCK : "")
    + (restart ? RESTART_BLOCK : "")
    + directorBlock({ message, history, board, problems, objectives, stepVerdict: input.stepVerdict?.verdict ?? (!solvedNow.length && problems.some((p) => wrongInChat(message, p)) ? "incorrect" : undefined), solvedInChat: solvedNow.length > 0, drawRequest: asksToDraw(message), writeRequest: asksToWrite(message), stuckStreak: input.teaching?.stuckStreak, discussion })
    + stepVerdictLine(input.stepVerdict)
    + (solvedNow.length ? `\n\nTHEY JUST ANSWERED THE OPEN EXERCISE IN CHAT, AND IT IS RIGHT (checked by code): \"${solvedNow[0].question.slice(0, 160)}\". Confirm it and move on — never ask them to type it into the answer box.` : "")
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "");

  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];
  const tools = tutorTools(!!input.canvasMode).map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

  const said = [...history.filter((h) => h.role === "user").map((h) => h.text), message, input.solution?.statement || "", ...(spokenRepair ? [spokenRepair.interpreted, ...(input.spoken?.alternatives || [])] : []), ...problems.map((p) => p.question || ""), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text)];
  const wantsProblem = wantsExercise(message);
  const focus = [input.solution?.statement || "", ...problems.filter((p) => !p.solved).map((p) => p.question), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text), ...history.filter((h) => h.role === "user").slice(-3).map((h) => h.text), message].filter(Boolean);
  if (spokenRepair?.interpreted) focus.push(spokenRepair.interpreted);
  const known = [...solutionValues(input.solution), ...(input.solution?.steps || []).flatMap((st) => (String(st.result || "").replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number))];
  const allBoard = () => [...board, ...result.board];
  const allProblems = () => [...problems, ...result.problems];
  // Failed checks go back to the model (at most twice); whatever reaches the student is always its own words.
  let corrections = 0;
  const MAX_CORRECTIONS = 2;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    let res: any;
    try {
      res = await retryRequest(() => createTutorChat({
        max_tokens: OUT.chat, temperature: 0.7,
        messages: lastRound ? [...messages, { role: "user", content: "Reply to the student now in plain words, no more tools." }] : messages,
        ...(lastRound ? {} : { tools }),
      }, true), 2, 400);
    } catch (e: any) {
      console.error(`[tutor] model request failed: ${e?.message || e}`);
      result.error = true;
      return result;
    }
    const u = usageOf(res); result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn += u.cachedIn;
    const msg = res?.choices?.[0]?.message || {};
    const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const text = String(msg.content || "");
    // A call the model wrote out as text ("[write_to_board]{kind:gap,text:a = ?}") still happens: it's stripped from
    // the reply anyway, and dropping it would lose the board write the reply is about (reported live).
    if (!toolCalls.length) {
      const offered = new Set(tutorTools(false).map((t) => t.name));
      textToolCalls(text).filter((c) => offered.has(c.name)).forEach((c, i) => toolCalls.push({ id: `text_call_${round}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    }

    const plan = parsePlan(text);
    if (plan) result.plan = plan;
    // Board writes first. SPEED: when the model sent its reply WITH the tool calls and every write landed, that reply is
    // final — no second round just to say the same thing again (it used to cost a full model call per board write).
    if (toolCalls.length && !lastRound) {
      messages.push({ role: "assistant", content: text, tool_calls: toolCalls });
      let allLanded = true;
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const args = parseToolArgs(tc.function?.arguments) || {};
        let content: string;
        try { content = applyTool(name, args, { message, result, allBoard, allProblems, spokenRepair, fr, said, wantsExercise: wantsProblem, focus, known, solution: input.solution, discussion, planConsent, explain }); }
        catch (e: any) { content = `ERROR: ${e?.message || e}`; }
        if (/^(?:REJECTED|LIMIT|DUPLICATE|ERROR|LEAK)/.test(content)) { allLanded = false; content += " (Internal note for you only: never tell the student a write was refused, bounced or blocked, and never mention the board's or app's rules — just carry on teaching naturally.)"; }
        if (process.env.TUTOR_TRACE) console.log(`[tool] ${name} → ${content.slice(0, 160)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content });
      }
      // …but only when the reply hands the turn back (asks something); "Let me set us up…" alone needs the next round.
      const draftNow = cleanReply(text, !!input.voiceMode);
      if (!allLanded || !draftNow || !/\?/.test(draftNow)) continue;
    }
    {
      let reply = cleanReply(text, !!input.voiceMode);
      if (!reply) {
        if (corrections < MAX_CORRECTIONS && !lastRound) { corrections++; messages.push({ role: "user", content: "(Now reply to the student — a short message ending with one question.)" }); continue; }
        result.error = true;
        return result;
      }
      // The hard checks, all at once: every problem found goes back in ONE correction round.
      const leaked = leakedValue(reply, message, allBoard(), allProblems(), input.solution);
      const issues: string[] = [];
      if (leaked) issues.push(`it gives away ${leaked === "the problem's answer" ? "the answer to the open problem" : `the value of the open gap (${leaked})`} — they must find it; keep the idea, drop the value, end with one question that gets them there`);
      if (wantsProblem && !result.problems.length) issues.push("they asked for an exercise: create it now with CREATE_PROBLEM (full statement, one short answer, a check expression for a numeric answer, precision and unit in the hint), then one line pointing them to it");
      if (asksToWrite(message) && !result.board.length) issues.push("they asked you to write it on the board: do it now (WRITE_TO_BOARD, clean maths in $…$, their numbers), then one short line");
      // Spec §6: a study goal gets a visible, editable lesson plan up front — not a question back about what to study.
      if (!objectives.length && !result.objectives && (planPending || statesStudyGoal(message)) && !/\?\s*$/.test(message.trim())) issues.push("they gave a study goal: set the plan NOW with SET_OBJECTIVES (3-5 objectives, exactly what they asked for, nothing they excluded), say it in one line, then START objective 1 in this same reply — a problem or figure on the board and one question. Don't ask them to approve the plan");
      // They ruled topics out ("everything except logs and exponentials"): the plan and the board must not bring them back.
      const excluded = excludedTopics([message, ...history.filter((h) => h.role === "user").slice(-2).map((h) => h.text)].join("\n"));
      const planLines = reply.split("\n").filter((l) => /^\s*(?:\d+[.)]|[-•*])\s+\S/.test(l));
      const brought = includesExcluded([...planLines, ...result.board.map((b) => b.text), ...(result.objectives || []).map((o) => o.label), ...result.problems.map((p) => p.question)], excluded);
      if (brought) issues.push(`they explicitly EXCLUDED this topic ("${brought}") — re-read what they said: work only on what they asked for, and leave the excluded topics out of the plan, the board and the problems`);
      // Spec §2.1 Failure D/G: when they hand you the choice, you choose — never bounce it back.
      if (delegatesChoice(message) && asksStudentToChoose(reply)) issues.push("they left the choice to you — don't ask them to choose. Pick the next useful activity yourself (the CURRENT milestone of the lesson plan, or a sensible one for this subject if there's no plan yet) and start it now: one short line on what we're doing, then its first question or exercise");
      const doubt = doubtsRightAnswer(reply, message, input.solution);
      if (doubt) issues.push(doubt);
      const badMath = wrongArithmetic(reply, message);
      if (badMath) issues.push(`it contains a wrong calculation: ${badMath}`);
      const ahead = asksForFormula(message) || explain ? [] : equationsAhead(reply, said);
      if (ahead.length) issues.push(`it hands them an equation they haven't stated (${ahead.join("; ")}) — don't derive it or name the formula; ask what relationship they'd use`);
      const invented = discussion ? [] : inventedNumbers(reply, [...said, ...allBoard().map((b) => b.text), ...allProblems().map((p) => p.question)]);
      if (invented.length) issues.push(`it uses numbers nobody gave (${invented.slice(0, 3).join(", ")}) — only their numbers and the problem's; never compute ahead or bring in a new scenario`);
      if (!doubt && confirmsUnchecked(reply, message, input.stepVerdict ? { studentStep: { status: input.stepVerdict.verdict } } : null)) issues.push("it confirms a value they didn't actually give (or one that's wrong) — react to THEIR number, and if it's off, ask which step they'd recheck");
      const lines = boardLineSet(board, result.board);
      const badLine = [...reply.matchAll(/\b(?:line|ligne)\s*#?\s*(\d{1,3})\b|(?<![\w&])#(\d{1,3})\b/gi)].map((m) => Number(m[1] || m[2])).find((n) => !lines.has(n));
      if (badLine) issues.push(`it points at line ${badLine}, which doesn't exist on their board — use the line's real margin number from the board listing, or describe it`);
      if (!doubt && !explain && handsOverCalculation(reply, message)) issues.push("it hands them the calculation (which numbers to multiply/add) — ask what THEY would compute next instead");
      // Canned praise as the OPENER — the same "Spot on, Willem!" every turn, with nothing specific in it.
      // Otto restates a GIVEN with a number that isn't in it — reported live: "the problem on the board: a 3 kg box
      // is pulled up by a force of 15 N (let's use 15 N instead so it actually moves!)" when the exercise says 12 N.
      const wrongGiven = discussion ? null : misstatesGiven(reply, [...said, ...allBoard().map((b) => b.text)]);
      if (wrongGiven) issues.push(`it says the problem gives ${wrongGiven}, which is not in it — NEVER change or invent a given: quote their numbers exactly as written, and if they don't work out, say so plainly instead of swapping one`);
      // Sending them back to the problem statement to re-check a value they just gave is the loop the student
      // cannot break — reported live, four turns of "what is the exact pulling force given in the problem text?"
      // while they kept answering "12". Corrected with a prompt round; taken over in code below if it persists.
      const missingLine = citesMissingBoardLine(reply, allBoard());
      if (missingLine) issues.push(`you pointed at line ${missingLine}, but the board has no line ${missingLine}. Quote what the line says instead (or the right margin number), and never point at something that isn't on the board.`);
      // Never say the same thing twice: a near-copy of a recent reply or question is the loop the student can't break.
      const repeats = repeatsRecentReply(reply, history) || repeatsRecentQuestion(reply, history);
      if (repeats) issues.push("you already said or asked almost exactly this a moment ago and it didn't land. Don't repeat it, not even reworded: say in a few words what you heard from them, then take a DIFFERENT step (a smaller question, a figure on the board, a tiny worked case) — or, if they already answered it, acknowledge that and move on");
      const recentContext = [...history.slice(-5).map((h) => h.text), message].join("\n");
      const offTopic = pointsAtOffTopicLine(reply, allBoard() as any, recentContext);
      if (offTopic) issues.push(`you pointed at line ${offTopic.n} ("${offTopic.text}"), but that line is about something else than what you two are discussing now. Point at a line from THIS topic (or write one), or quote what you mean — don't drag an earlier problem back in`);
      const reread = sendsBackToStatement(reply, message);
      if (reread) issues.push(`it sends them back to the problem statement ("${reread}") to re-check something they ALREADY gave — don't re-ask it, use the value they said. If they misread it, say what the problem actually gives and why it differs. If the givens as written genuinely can't produce what the problem asks for, say so plainly ONCE (the numbers as given don't work out, and the one-line reason why) and offer to change one of them, instead of asking them to read it again`);
      // A NEW problem posed only in the message ("If a 2 kg block drops 3 m onto a spring k = 400 N/m, how would you…?") with nothing on the board.
      const quantitiesNew = posesProblemInProse(reply) && !result.problems.length && !result.board.length
        ? newQuantities(reply, [...said, ...allBoard().map((b) => b.text), ...allProblems().map((p) => p.question)]) >= 2 : false;
      if (quantitiesNew) issues.push("you set a new problem in the message only — nothing is on the board. Put it on the board: CREATE_PROBLEM when it is an exercise for them to solve (full statement, one checkable answer with a `check` expression), otherwise WRITE_TO_BOARD the givens and the question; the message then just points at it in one line");
      const claimedBoard = claimsBoardWrite(reply) && !result.board.length && !result.problems.length;
      if (claimedBoard) issues.push("you say you'll put (or have put) something on the board, but nothing was written this turn. Write it now (a new problem goes through CREATE_PROBLEM): ONE short clean line with WRITE_TO_BOARD (the result or step they reached, their numbers, maths in $…$, owner \"student\"; never their sentence), then reply. Only if there is truly nothing worth keeping, drop that sentence instead");
      else if (reachedResultUnrecorded(reply, message, result.board.length + result.problems.length)) issues.push("they just reached a result or step of their own and you confirmed it, but nothing went on the board. Record it: ONE short clean line with WRITE_TO_BOARD (kind result or summary, owner \"student\", their numbers, maths in $…$), then reply as you planned");
      if (!result.problems.length && setsMathTaskUnboarded(reply, result.board.length)) issues.push("you set them a maths task in chat but it isn't on the board. Put the question itself on the board as ONE short line ending '= ?' (WRITE_TO_BOARD, kind gap, with the expected answer), then keep your message to a line that points at it. The board should show every question you ask, not just the chat");
      if (discussion && statesClaimUnboarded(message, result.board.length)) issues.push("they argued a position and none of it is on the board. Write their claim (and the evidence they gave) as ONE short line with WRITE_TO_BOARD (kind insight, owner \"student\", their words condensed), then raise ONE objection or ask for the missing evidence — and put that question on the board too as a short Otto line");
      const writes = result.board.length + result.problems.length;
      if (boardStillEmpty(board.length, writes, history, reply)) issues.push("the board is still empty. Open it now: a header line (WRITE_TO_BOARD kind focus: subject → topic → what we're doing) and the starting point (the question you're asking, the key definition, or the givens). The board must show what you're working on from the first turn");
      else if (teachesUnboarded(reply, writes)) issues.push("you taught an idea in chat but the board doesn't show it. Write the key idea in one short line (kind definition, formula or insight; maths in $…$) — or draw it if it's a relationship — then keep the message as it is");
      if (discussion && asksDiscussionQuestionUnboarded(reply, writes)) issues.push("put the question you're asking them to think about on the board as one short line (kind focus), so the discussion is visible");
      if (!explain && teachesOverError(reply, message, input.stepVerdict?.verdict)) issues.push("they just got it wrong and you went straight to the method. First find out what they were thinking: name the belief you suspect (\"it looks like you treated log(x+y) as log x + log y\") or ask one question / give one counter-example that tests it — then help. The goal is to fix the misconception, not to show the right answer");
      if (strategyMissing(message, allBoard(), result.board)) issues.push("they just solved it: name the reusable strategy behind it and put it on the board (WRITE_TO_BOARD kind strategy, a few words, e.g. \"Expand: fraction → product → powers\"), ideally asking them to put it in their own words");
      if (mentionsMechanics(reply)) issues.push("it talks about the app's machinery (a write that bounced, the board not letting you, a rule) — the student must never hear that. Drop it and just teach: ask them for the step, or write what's allowed");
      if (isStudentWriting(message) && rewritesTheirWriting(reply)) issues.push("they shared their own writing and you rewrote it. Don't: quote ONE of their sentences, name one real strength, then the single most important improvement (claim, evidence, analysis or link to the question), and ask them to rewrite that sentence themselves");
      if (discussion && agreesWithoutChallenge(reply, message)) issues.push("you just agreed with their point and stopped. Be a critical-thinking partner: credit what's strong in one clause, then push on it ONCE — the strongest objection a critic would raise, a case where the logic doesn't hold, or the evidence it still needs — and ask them to answer it");
      if (wrapsUpUnasked(reply, message)) issues.push("it offers to wrap up or move on, which they didn't ask for — stay on the current work");
      if (reportsCorrectResult(message) && !movesOn(reply, !!(result.problems.length || result.board.length))) issues.push("they just got an exercise right: confirm in one specific clause, then ONE critical-thinking move (why it works, does the result make sense, what if a given changed, or find the flaw in a plausible wrong line) and/or start the next activity yourself (the CURRENT lesson-plan milestone, in a new format) — end with one question or a new exercise");
      const missingObj = pointsAtMissingObject(reply, allBoard().map((b) => String(b.kind)));
      if (missingObj) issues.push(`you point at "the ${missingObj}" but none is on the board — draw/write it now with the matching board tool, or reword so you don't refer to it`);
      if (blamesWidget(reply)) issues.push("it blames the app/widget — if an exercise's key disagrees with a right answer, say plainly the key was wrong");
      if (asksWhy(message) && ignoresWhy(reply)) issues.push("they asked WHY. Answer the why first: the actual reason in 1-2 plain sentences (what the step achieves, e.g. what the units become) — repeating the instruction is not an answer. Then at most one question");
      if (questionCount(reply) > 1) issues.push("it asks more than one question — keep only the one that matters most, at the end");
      const opener = harshOpener(reply);
      if (opener) issues.push(`it opens with "${opener}" — never open harshly; start with what's worth keeping in their thinking, or go straight to the question`);
      // A leak, a doubted right answer or a "go re-read the problem" loop gets a second chance; the rest one.
      const hard = !!(leaked || doubt || reread || badLine || missingLine || offTopic || repeats);
      if (issues.length && corrections < (hard ? MAX_CORRECTIONS : 1) && !lastRound) {
        corrections++;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: `(Fix your reply before the student sees it:\n- ${issues.join("\n- ")}\nThen send the corrected reply. Don't mention this note.)` });
        continue;
      }
      // They asked for it on the board and nothing landed (every write refused, or none tried): write THEIR line in
      // code, through the same checks. Reported: "it says it wrote it, nothing on the board".
      if (asksToWrite(message) && !result.board.length && !result.problems.length) {
        const line = studentBoardLine([spokenRepair?.interpreted || "", message, ...history.filter((h) => h.role === "user").slice(-2).reverse().map((h) => h.text)]);
        if (line) applyTool("WRITE_TO_BOARD", { text: line, kind: "result", owner: "student" }, { message, result, allBoard, allProblems, spokenRepair, fr, said, wantsExercise: wantsProblem, focus, known, solution: input.solution, explain });
      }
      // Still failing a hard check after the corrections: ONE last model-written rewrite of that reply, never a fixed line.
      if (hard) {
        const fixed = await rewriteReply(reply, issues.join("; "), message, result.tokens);
        if (fixed) reply = dedupeParagraphs(fixed);
      }
      if (leaked) {
        result.guardrailTripped = true;
        result.leakedValue = leaked;
        // A SECOND consecutive trip on the exact same value: blocking again teaches nothing and just
        // repeats the identical non-answer forever, no matter what the student actually says — reported
        // live, four turns straight. The correction round above already told the model once to drop the
        // value and ask instead; if it still can't avoid stating it, that's a sign Socratic withholding
        // has genuinely stopped working here (the spec's own "know when to explain directly" / "never
        // leave a confused student trapped" case) — ship its real, content-aware reply instead of
        // replacing it with the canned line a second time. First trip still behaves exactly as before.
        // Two corrections didn't keep the value out: ship its reply anyway — after repeated attempts, a direct
        // explanation is what the student needs (spec: never trap a confused student), and a canned line isn't.
        result.reply = dropRepeatedName(stripPraiseOpener(mentionsMechanics(reply) ? (stripMechanics(reply) || reply) : reply), history);
        return result;
      }
      // A formula in the reply and the board got nothing this turn: put the line up ourselves — the chat carries
      // the words, the board carries the maths. Skipped when the reply is handing over an equation they never
      // stated (that stays forbidden), and it can't add a second line to a turn that already wrote one.
      if (statesFormula(reply) && !ahead.length && !result.board.length && !result.problems.length && !claimedBoard) {
        const formulaLine = formulaLineFor(reply);
        if (formulaLine) applyTool("WRITE_TO_BOARD", { text: formulaLine, kind: "formula" }, { message, result, allBoard, allProblems, spokenRepair, fr, said, wantsExercise: wantsProblem, focus, known, solution: input.solution, codeWrite: true, explain });
      }
      // Claimed a board write but never made one, even after the correction round: remove the false claim.
      if (claimsBoardWrite(reply) && !result.board.length && !result.problems.length) {
        result.reply = stripBoardClaim(reply) || reply;
        return result;
      }
      // Harsh or canned-praise openers went back to the model above; nothing is rewritten into fixed phrases here.
      result.reply = dropRepeatedName(stripPraiseOpener(mentionsMechanics(reply) ? (stripMechanics(reply) || reply) : reply), history);
      return result;
    }

  }
  result.error = !result.reply;
  return result;
}

// ── Tool handling ─────────────────────────────────────────────────────────────────────────────────────
interface ToolCtx {
  message: string;
  result: TutorTurnResult;
  allBoard: () => BoardEntry[];
  allProblems: () => TaskProblem[];
  spokenRepair: SpokenRepair | null;
  fr: boolean;
  /** Everything the student has said this session (and problems already posted) — the only legitimate source of givens. */
  said: string[];
  wantsExercise: boolean;
  /** What the board is about right now: the solution's statement, givens, problems, recent student messages. */
  focus: string[];
  /** Every value the verified solution reaches — a line with one of them is about the problem, never invented. */
  known?: number[];
  /** The verified solution — its final answer never goes on the board before the student reaches it. */
  solution?: TutorSolution;
  /** This write is made by CODE from the tutor's own reply (not proposed by the model), so the "is it about the
   *  problem in focus" check is skipped — it is on-topic by construction. Every other guard still applies. */
  codeWrite?: boolean;
  /** A humanities/discussion session: counter-arguments and evidence lines are on-topic by nature, so the maths-style relevance filter is off. */
  discussion?: boolean;
  /** Session objectives may only be created once the student has agreed to a proposed plan (or asked for one). */
  planConsent?: boolean;
  /** Explain mode (needsExplanation): Otto may write the step it is explaining, and a worked example with its own numbers. */
  explain?: boolean;
}

/** Does `line` state an open gap's answer? Numbers/maths: anywhere (replyStatesValue). A WORD answer ("friction")
 *  only when the line assigns it ("= friction", "answer: friction", "it's friction") — merely mentioning friction
 *  in another line isn't a leak (reported: unrelated lines were refused while such a gap was open). */
export function statesGapAnswer(line: string, answer: string): boolean {
  if (/[\d=+*/^√π%:]/.test(answer)) return replyStatesValue(line, answer);
  const esc = String(answer).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (esc.length < 3) return false;
  return new RegExp(`(?:=|:|→|\\b(?:is|are|it'?s|est|c'est)\\b)\\s*\\$?\\s*(?:the\\s+|la\\s+|le\\s+)?${esc}(?![\\p{L}\\d])`, "iu").test(latexToPlainText(String(line).replace(/\$/g, " ")));
}

/** The line is an equation the student just stated (typed or spoken) — their step, not Otto's derivation. */
/** Every number in the line is one they said (a line credited to them can't carry a value they never gave). */
/** A question whose answer is several values ("find the roots", "solve for x" of a quadratic, "the values of x"). Exported for tests. */
export function asksForSeveralValues(question: string): boolean {
  const q = String(question || "");
  if (/\b(?:the )?(?:larger|largest|smaller|smallest|positive|negative|greater|lesser|first|second|one of the|sum of the|product of the|difference between the)\b[^.?]{0,20}\b(?:roots?|solutions?|values?|zeros?)\b/i.test(q)) return false;
  return /\b(?:values of|all (?:the )?(?:values|solutions|roots)|(?:the )?(?:roots|solutions|zeros|zeroes|x-intercepts)\b)/i.test(q);
}

/** Most of the line's content words are the student's own (a claim credited to them must be one they made —
 *  reported live: Otto's own Macbeth reading was written up as "your claim"). Lines that are only maths pass. */
/** A line that only restates what's already on the board, in other words. NOT one that grows it: a second summary
 *  extends the first ("…; supply ↓ ⟹ …" is new content, spec: a second summary is its own line), so anything over
 *  half again as long as what's there counts as new. Short strings (< 3 content words) never match (similarity). */
export function nearDuplicateLine(existing: string, text: string): boolean {
  if (similarity(existing, text) < 0.75) return false;
  return text.length <= String(existing).length * 1.5;
}

/** The student's own calculation, checked by code ("10/100 divided by 10/40 = 0.4"): when every claim in it is true,
 *  the tutor is told so — reported live: a right PED of 0.4 was sent back to be worked out again. */
export function ownArithmeticLine(message: string): string {
  if (/^\s*\[(?:Exercise|Exercice)\]/.test(message)) return "";
  // "a/b divided by c/d = v" means (a/b)/(c/d), not a/b/c/d.
  const text = String(message || "").replace(/([\d.]+\s*\/\s*[\d.]+)\s+divided by\s+([\d.]+\s*\/\s*[\d.]+)/gi, "($1)/($2)")
    .replace(/\bdivided by\b/gi, "/").replace(/\btimes\b/gi, "*").replace(/\bplus\b/gi, "+").replace(/\bminus\b/gi, "-");
  const checked: string[] = [];
  for (const m of text.matchAll(/([^=?\n]*?)=\s*(-?\d+(?:\.\d+)?)/g)) {
    const lhs = mathTail(m[1]);
    if (!/[-+*/×÷^]/.test(lhs.replace(/^-/, ""))) continue;
    const f = compileExpr(toExprSource(lhs), []);
    if ("error" in f) continue;
    const v = f.fn({}), r = Number(m[2]);
    const dp = (m[2].split(".")[1] || "").length;
    if (!Number.isFinite(v) || Math.abs(v - r) > Math.max(1e-9, 0.5 * 10 ** -dp + 1e-9)) return "";
    checked.push(`${lhs} = ${m[2]}`);
  }
  return checked.length ? `\n\nVERIFIED BY CODE: the student's own calculation is correct (${checked.join("; ")}). Confirm it specifically — never ask them to work it out again.` : "";
}

export function wordsAreTheirs(line: string, theirWords: string[]): boolean {
  const ws = (x: string) => String(x || "").toLowerCase().replace(/\$[^$]*\$/g, " ").split(/[^\p{L}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 5));
  const mine = ws(line);
  if (mine.length < 3) return true;
  const theirs = new Set(theirWords.flatMap(ws));
  return mine.filter((w) => theirs.has(w)).length / mine.length >= 0.5;
}

export function numbersAreTheirs(line: string, theirWords: string[]): boolean {
  const nums = (x: string) => (latexToPlainText(String(x || "").replace(/\$/g, " ")).replace(/[−–]/g, "-").match(/\d+(?:\.\d+)?/g) || []);
  const theirs = new Set(theirWords.flatMap(nums));
  return nums(line).every((n) => theirs.has(n));
}

export function isTheirStep(line: string, theirWords: string[]): boolean {
  if (!equationsAhead(line, []).length) return false; // no formula in it — nothing to attribute
  return !equationsAhead(line, theirWords.filter(Boolean)).length;
}

/** The maths the student wants written up, from the first of `sources` that has some: the request words ("can you
 *  write that on the board") dropped, only a line with an equation or a number kept. "" when there's nothing. */
export function studentBoardLine(sources: string[]): string {
  for (const src of sources) {
    const t = String(src || "")
      .replace(/\b(?:can|could|would) you\b|\bplease\b|\bstp\b|\bpour moi\b/gi, " ")
      .replace(/\b(?:write|put|add|note|rewrite|show)(?:\s+(?:it|that|this|them|down|up))*\b|\b(?:on|onto|au|sur)\s+(?:the\s+|le\s+)?(?:board|tableau)\b|\bécris(?:[- ]le)?\b|\bnote[- ]le\b/gi, " ")
      .replace(/\s+/g, " ").replace(/^[\s,.:;!?-]+|[\s,;!?]+$/g, "").trim();
    if (t && /\d|=/.test(t) && t.length <= 160 && t.split(/\s+/).length <= 25) return t;
  }
  return "";
}

/** The margin numbers the student can see, including lines written THIS turn (numbered after the board's last one,
 *  the way the client numbers them) — so "line 7" for a line just written isn't flagged as missing. Exported for tests. */
export function boardLineSet(board: BoardEntry[], fresh: BoardEntry[]): Set<number> {
  const numbered = (e: BoardEntry) => !["focus", "annotation"].includes(String(e.kind));
  const nums = board.filter(numbered).map((e, i) => e.n ?? i + 1);
  let next = Math.max(0, ...nums);
  return new Set([...nums, ...fresh.filter(numbered).map(() => ++next)]);
}

/** The board's last numbered line is a gap still waiting for them. */
function lastLineIsOpenGap(board: BoardEntry[]): boolean {
  const lines = board.filter((e) => !["focus", "annotation"].includes(String(e.kind)));
  const last = lines[lines.length - 1];
  return !!last && last.kind === "gap" && last.status !== "correct";
}
const LEAK = "REJECTED: that shows the answer to an open problem or gap — they must find it. Leave that value out (use '?').";
const ok = (id?: string) => JSON.stringify({ ok: true, ...(id ? { id } : {}) });

/** Apply one board tool call; returns the tool result text the model reads. Exported for tests. */
export function applyTool(name: string, input: any, c: ToolCtx): string {
  const { result } = c;
  const openProblems = () => c.allProblems().filter((p) => !p.solved);
  const leaks = (s: string) => {
    if (leaksAnyProblemAnswer(s, openProblems())) return true;
    return c.allBoard().some((g) => g.kind === "gap" && g.expectedAnswer && g.status !== "correct" && !replyStatesValue(c.message, g.expectedAnswer) && statesGapAnswer(s, g.expectedAnswer));
  };
  const push = (e: BoardEntry) => { result.board.push(e); return ok(e.id); };
  const count = (kind: string) => result.board.filter((e) => e.kind === kind).length;

  switch (name) {
    case "WRITE_TO_BOARD": {
      if (typeof input.text === "string") input.text = latexifyBoardLine(repairLatex(input.text), String(input.kind || ""));
      let text = String(input.text || "");
      // Their own step, written up without owner:"student" (the model often forgets): an equation they just said is
      // THEIRS — it skips the "about the problem" and "equation ahead" checks and is labelled as their work.
      if (input.owner !== "student" && input.kind !== "gap" && isTheirStep(text, [c.message, ...(c.spokenRepair ? [c.spokenRepair.interpreted] : [])])) input.owner = "student";
      // A gap is Otto's question, never the student's line; and a line only counts as THEIRS when it is what they said
      // (reported live: Otto's "x = ?" gaps and its own "x = 2, now find y" showed in the student's ink).
      if (input.kind === "gap") input.owner = "otto";
      else if (input.owner === "student" && !c.codeWrite && !(numbersAreTheirs(text, [c.message, ...(c.spokenRepair ? [c.spokenRepair.interpreted] : [])]) && wordsAreTheirs(text, [c.message, ...c.said.slice(-3)]))) input.owner = "otto";
      // While a gap is open, the line that answers it is theirs to write — not a definition or formula that solves it.
      { const open = c.allBoard().slice(-8).reverse().find((e) => e.kind === "gap" && e.status !== "correct") /* recent only: an old abandoned gap must not block every later line */; const target = open ? gapTarget(open.text) : undefined;
        if (open && target && input.owner !== "student" && input.kind !== "gap" && new RegExp(`(?:^|[:\\s$])${target}\\s*=\\s*(?!\\?)`, "i").test(text)) return `REJECTED: a gap asking for ${target} is still open — that line gives it away. Let them find ${target}; ask in chat, or point at what they need.`; }
      if (input.kind === "gap" && result.board.some((e) => e.kind === "gap")) return "LIMIT: one gap a turn — ask the next step in chat instead.";
      if (input.kind === "gap") { const bad = badGap(text, c.allBoard().map((b) => String(b.text || ""))); if (bad) return `REJECTED: ${bad}`; }
      if (input.kind === "gap" && lastLineIsOpenGap(c.allBoard())) return "REJECTED: the board already ends on an open gap they haven't filled — ask in chat instead of adding another '= ?' line.";
      if (result.board.filter((e) => !["svg", "graph", "flow", "widget", "diagram", "annotation"].includes(String(e.kind))).length >= (c.explain ? 6 : 4)) return "LIMIT: four lines a turn is plenty — the board keeps only what's worth keeping.";
      if (input.owner !== "student" && input.kind !== "focus" && !c.codeWrite && !c.discussion && !(c.explain && !/[A-Za-zÀ-ÿ]{4,}/.test(text.replace(/\$[^$]*\$/g, " "))) && !relevantToFocus(text, [...c.focus, ...c.allBoard().map((b) => b.text), ...c.result.problems.map((p) => p.question)], c.known || [])) return "REJECTED: that line isn't about the problem you're working on. Write only this problem's givens, a step THEY reached (owner:'student'), or the next step as a gap ending in '= ?'.";
      if (isDuplicateBoardEntry(c.allBoard(), input)) return "DUPLICATE: that's already on the board — point at it instead.";
      // The same maths inside a longer line ("For M along the slope: $Mg\sin\theta - T = Ma$") is a duplicate too.
      { const mathOf = (x: string) => (String(x).match(/\$[^$]+\$/g) || []).join("").replace(/\$|\s|[{}]/g, "").toLowerCase();
        const mine = mathOf(text);
        if (input.kind !== "gap" && mine.length >= 6 && c.allBoard().slice(-20).some((e) => e.kind !== "gap" && mathOf(String(e.text || "")).includes(mine))) return "DUPLICATE: that equation is already on the board — point at it instead."; }
      if (input.kind !== "gap" && c.allBoard().slice(-20).some((e) => e.text && nearDuplicateLine(String(e.text), text))) return "DUPLICATE: an almost identical line is already on the board — point at it (or add only what's new).";
      // Accuracy (spec §19): a line OTTO writes must not state false arithmetic — the board is what they'll revise from.
      if (input.owner !== "student") { const bad = wrongArithmetic(text, c.message); if (bad) return `REJECTED: that line has a wrong calculation (${bad}). Recompute it before writing.`; }
      if (input.why && leaks(String(input.why))) return LEAK;
      if (input.kind !== "gap" && leaks(text)) return LEAK;
      if (input.owner !== "student" && statesFinalAnswer(text, c.solution) && !reachedSolutionSteps(c.message, c.solution).includes(0)) return LEAK;
      // A gap that already shows its own answer ("Power = 1000×9.8×sin(10°)×15 = 25,526?", reported live) isn't a gap.
      const unsep = (x: string) => x.replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1");
      if (input.kind === "gap" && input.expectedAnswer && replyStatesValue(unsep(text.replace(/=\s*\?\s*\$?\s*$/, "")), unsep(String(input.expectedAnswer)))) return "REJECTED: that gap line already shows its own answer — end it at '= ?', and leave the working for them.";
      // A problem is posted with CREATE_PROBLEM (answer box, checked key) — never as board text plus a "= ?" gap.
      if (input.owner !== "student" && c.wantsExercise && !result.problems.length && (input.kind === "gap" || looksLikeGivensOrScenario(text)))
        return "REJECTED: they asked for an exercise — post it with CREATE_PROBLEM (the full statement, one short answer, a check expression, precision and unit in the hint), not as board text.";
      if (input.owner !== "student" && !c.explain && inventsProblemOnBoard(text, [...c.said, ...c.allBoard().map((b) => b.text), ...result.problems.map((q) => q.question)], c.known || []))
        return "REJECTED: that line has numbers that aren't in their problem. Write the givens exactly as THEY stated them (a new problem goes through CREATE_PROBLEM, only when they ask for one).";
      // Never derive an equation or show which formula to use: the student names the relationship first.
      // A gap's own "… = ?" clause is the question, not an equation handed over: only the rest of the line is checked.
      const stated = input.kind === "gap" ? text.replace(/[^,;:.]*=\s*\??\s*\$?\s*\??\s*$/, "") : text;
      const ahead = input.owner !== "student" && !c.explain && !asksForFormula(c.message) && stated.trim() ? equationsAhead(stated, c.said) : [];
      if (ahead.length) return `REJECTED: that writes an equation they haven't stated (${ahead[0]}). Don't derive it or show which formula to use — ask them what relationship they'd use, and write it up (owner:'student') once THEY say it. You can still write the givens, or the unknown as '… = ?'.`;
      if (input.kind === "gap") { const k = computedGapKey(text) ?? solvedGapKey(text); if (k !== null) input.expectedAnswer = String(k); }
      const heard = boardRepeatsMishearing(text, c.spokenRepair);
      if (heard) return `REJECTED: "${heard}" is a speech-recognition slip — write what the student MEANT, typeset in $…$.`;
      const r = makeBoardEntry(input);
      if ("error" in r) return r.error;
      // The board must be readable later (reported: "explain a bit, not just equations"): a maths line needs its why.
      if (input.owner !== "student" && !c.codeWrite && !["gap", "given", "focus", "outline", "summary", "result"].includes(String(input.kind || "")) && /\$|=|⟹|⇒/.test(text) && !String(input.why || "").trim()) return "REJECTED: add a `why` — one short plain sentence under this line saying what it does and why it's allowed (e.g. 'Power law: the exponent comes out front'), so they can read the board back later. Then write it again.";
      return push(r.entry);
    }
    case "CREATE_PROBLEM": {
      if (openProblems().length && !asksToMoveOn(c.message)) return "REJECTED: they haven't answered the problem already on the board — help them with that one first.";
      if (isDuplicateProblem(c.allProblems(), input)) return "DUPLICATE: that problem is already on the board.";
      // One answer box holds ONE answer: "find the values / roots / solutions" with a single key marks a right second
      // root wrong (reported live: x² − 7x + 12 = 0 keyed to 3 only).
      if (asksForSeveralValues(String(input?.question || "")) && !(Array.isArray(input?.options) && input.options.length >= 2)) return "REJECTED: the answer box takes ONE answer, but this asks for several values. Ask for exactly one (\"the larger root\", \"the positive solution\", \"the sum of the roots\") or make it multiple choice.";
      // Spec §20.3 / test 17: after two SOLVED calculations in a row, the next exercise changes format (graph, concept,
      // application) — the reported session kept issuing the same equilibrium drill to a student who'd already shown it.
      // Unless they explicitly asked for another one of the same kind.
      if (repeatsSolvedCalculation(c.allProblems(), input, c.message)) return "REJECTED: they've already solved two calculations like this in a row — change the format now: a graph/diagram question, a concept check (with a rubric), or an application to a new situation. Only repeat the same kind if they ask for one like it.";
      // The exercise's own text must not hand them the equation they were going to build: "$KE_f = ½(1200)(25)² = ?" shipped
      // inside a created question and opened the session with the student's first move already done. The reply and board-write
      // guards both check equationsAhead; a created problem checks questionAhead (its trailing ask-sentence stripped first),
      // so the setup has to come from them or the problem's own statement — never pre-built with the exercise.
      const aheadQuestion = questionAhead(String(input?.question || ""), c.said);
      if (aheadQuestion.length) return `REJECTED: that exercise hands them the equation they were going to build (${aheadQuestion[0]}). State the situation and what to find in words (or the raw given line) — never the substituted setup. Let THEM write the equation.`;
      // requireCheck: a numeric key must come with an expression the app evaluates itself (never a guessed key).
      const r = makeProblem(input, true);
      if ("error" in r) return r.error;
      result.problems.push(r.problem);
      return ok(r.problem.id);
    }
    case "UPDATE_BOARD_LINE": {
      const hit = resolveBoardTarget(String(input.target || ""), c.allBoard());
      if (!hit?.id) return JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "no such board line — use a #n from the board listing" } });
      const text = latexifyBoardLine(repairLatex(String(input.text || "")), String(hit.kind || "")).trim();
      if (!text) return JSON.stringify({ ok: false, error: { code: "INVALID_PAYLOAD", message: "the corrected line is empty" } });
      if (leaks(text)) return LEAK;
      if (hit.owner === "student") return JSON.stringify({ ok: false, error: { code: "FORBIDDEN_STUDENT_WORK", message: "that line is the student's — leave it, and add your corrected line beside it with WRITE_TO_BOARD" } });
      // The board is paper: a correction is a NEW line under the old one, never an overwrite (reported live —
      // lines changed under the student instead of the board growing).
      return push({ id: randomUUID(), text, kind: hit.kind === "gap" ? "result" : hit.kind, owner: "otto", at: new Date().toISOString() } as BoardEntry);
    }
    case "REMOVE_BOARD_LINE": {
      return "REJECTED: nothing on the board is ever removed — if a line of yours is wrong, add the corrected line below it with UPDATE_BOARD_LINE.";
    }
    case "ANNOTATE_BOARD": {
      const hit = resolveBoardTarget(String(input.target || ""), c.allBoard());
      const note = String(input.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!hit?.id) return "ERROR: no such board entry — use a #n from the board listing.";
      if (!note) return "ERROR: a pointer needs a short note.";
      if (count("annotation") >= 2) return "LIMIT: two pointers per turn is plenty.";
      if (result.board.some((e) => e.kind === "annotation" && e.targetId === hit.id)) return "DUPLICATE: you've already pointed at that line this turn.";
      { const n = boardLineNumbers(c.allBoard() as any).get(hit.id); const ctx = [c.message, ...c.said.slice(-4)].join("\n");
        if (n && pointsAtOffTopicLine(`line ${n}`, c.allBoard() as any, ctx)) return "REJECTED: that line is about something else than what you're discussing now — point at the line about THIS (or write it first)."; }
      if (leaks(note)) return LEAK;
      if (!asksForFormula(c.message) && equationsAhead(note, c.said).length) return "REJECTED: that note hands them an equation they haven't stated — point and ask instead.";
      const tone = ["error", "hint", "good", "focus"].includes(input.tone) ? input.tone : "focus";
      return push({ id: randomUUID(), text: note, kind: "annotation", targetId: hit.id, tone, owner: "otto", at: new Date().toISOString() } as BoardEntry);
    }
    case "GEOMETRY_ON_BOARD": {
      if (count("diagram") >= 2) return "LIMIT: enough figures for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeGeometryEntry(input);
      if ("error" in r) return r.error;
      if (isDuplicateDiagram(c.allBoard(), r.entry)) return "DUPLICATE: that figure is already on the board.";
      return push(r.entry);
    }
    case "TRIG_SCENE_ON_BOARD": {
      if (count("svg") >= 2) return "LIMIT: enough figures for one turn.";
      const built = buildTrigScene({ mode: input.mode, observers: Array.isArray(input.observers) ? input.observers : [], separation: input.separation, towerHeight: input.towerHeight, unknownTop: typeof input.unknownTop === "string" ? input.unknownTop.slice(0, 3) : undefined, distance: input.distance, baseName: input.baseName, topName: input.topName, units: input.units });
      if ("error" in built) return built.error;
      const svg = sanitizeSvg(built.svg);
      if (!svg) return "ERROR: couldn't build that scene.";
      const caption = String(input.caption || "").trim().slice(0, 200) || (c.fr ? "La situation" : "The situation");
      result.board.push({ id: randomUUID(), text: caption, kind: "svg", svg, facts: built.facts, at: new Date().toISOString() } as BoardEntry);
      return JSON.stringify({ ok: true, geometry: built.facts, note: "Drawn to scale with only the given angles marked." });
    }
    case "GRAPH_ON_BOARD": {
      if (count("graph") >= 1) return "LIMIT: one graph a turn — put both curves on the same graph instead.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeGraphEntry(input);
      if ("error" in r) return r.error;
      if (c.allBoard().slice(-12).some((e) => e.kind === "graph" && JSON.stringify((e as any).graph) === JSON.stringify((r.entry as any).graph))) return "DUPLICATE: that graph is already on the board — point at it.";
      return push(r.entry);
    }
    case "INCLINE_ON_BOARD": {
      if (count("svg") >= 2) return "LIMIT: enough figures for one turn.";
      if (leaks(JSON.stringify(input.labels || {}))) return LEAK;
      const built = buildInclineScene({ angle: Number(input.angle), forces: Array.isArray(input.forces) ? input.forces as InclineForce[] : undefined, motion: input.motion, labels: input.labels && typeof input.labels === "object" ? input.labels : undefined });
      if ("error" in built) return built.error;
      const svg = sanitizeSvg(built.svg);
      if (!svg) return "ERROR: couldn't build that figure.";
      const caption = String(input.caption || "").trim().slice(0, 200) || (c.fr ? "Le plan incliné" : "The slope");
      result.board.push({ id: randomUUID(), text: caption, kind: "svg", svg, facts: built.facts, at: new Date().toISOString() } as BoardEntry);
      return JSON.stringify({ ok: true, geometry: built.facts });
    }
    case "SVG_ON_BOARD": {
      if (count("svg") >= 2) return "LIMIT: enough figures for one turn.";
      // Hand-drawn figures with angles/lengths/forces are never to scale — those go through the computed builders.
      if (/\d+(?:\.\d+)?\s*(?:°|&#176;|deg)|\d+(?:\.\d+)?\s*(?:m|cm|km|mm|N|kg|m\/s)\b/.test(svgText(sanitizeSvg(String(input.svg || ""))))) return "REJECTED: a figure with angles, lengths or forces must be drawn to scale — use GEOMETRY_ON_BOARD (triangles, circles), TRIG_SCENE_ON_BOARD (elevation/depression), INCLINE_ON_BOARD (slopes and forces) or GRAPH_ON_BOARD (functions).";
      if (leaks(`${input.caption || ""} ${svgText(sanitizeSvg(String(input.svg || "")))}`)) return "REJECTED: that figure labels the answer — show the unknown as '?'.";
      const r = makeSvgEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "FLOW_ON_BOARD": {
      if (count("flow") >= 2) return "LIMIT: enough diagrams for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeFlowEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "TABLE_ON_BOARD": {
      if (count("table") >= 2) return "LIMIT: enough tables for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const caption = String(input?.caption || "");
      if (caption && c.allBoard().some((e) => e.kind === "table" && similarity(String(e.text), caption) >= 0.7)) return "DUPLICATE: that table is already on the board — refer to it (or ask them to fill its blank column) instead of drawing it again.";
      const r = makeTableEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "SOURCE_ON_BOARD": {
      if (count("source") >= 1) return "LIMIT: one source per turn.";
      const r = makeSourceEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "WIDGET_ON_BOARD": {
      if (count("widget") >= 1) return "LIMIT: one activity at a time.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeWidgetEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "CREATE_INTERACTIVE": {
      if (count("interactive") >= 1) return "LIMIT: one interactive scene per turn.";
      if (leaks(`${input.caption || ""} ${input.html || ""}`)) return LEAK;
      const r = makeInteractiveEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "SET_OBJECTIVES": {
      if (c.planConsent === false) return "REJECTED: the student hasn't agreed to a plan yet. Propose 3-6 objectives in your reply as a numbered list, ask if they want to change, add or remove anything, and only call SET_OBJECTIVES after they answer.";
      const r = makeObjectives(input);
      if ("error" in r) return r.error;
      result.objectives = r.objectives;
      return ok();
    }
    case "CLEAR_BOARD": {
      // NEVER — reported live: Otto announced "let's clear the board" and the student's working was gone.
      // The tool is no longer offered; if it is asked for anyway, nothing happens (spec 3.8 / §12: preserve
      // student work, append rather than overwrite).
      return "REJECTED: the board is never cleared — their working stays. Keep every existing entry and add only what's worth keeping.";
    }
    default:
      return `ERROR: unknown tool ${name}.`;
  }
}


// ── Humanities / discussion subjects ──────────────────────────────────────────────────────────────────
// History, literature, philosophy, geography, TOK, languages: there is rarely one right answer to compute, so the
// tutor works as a discussion partner that builds critical thinking — it asks for a claim and the evidence behind
// it, raises the strongest counter-argument, and makes the student defend or revise — never writing the argument.
const DISCUSSION_SUBJECTS = new Set(["history", "geography", "philosophy", "english", "french", "spanish", "german", "theory of knowledge", "tok", "art", "music", "literature", "politics", "global politics", "psychology", "sociology", "religion", "classics", "latin",
  // French and other common names (reported: "Histoire"/"Philosophie" sessions got the maths-mode guards).
  // Economics stays OUT in every spelling — sameSubject("SES", "Economics") groups them, and an econ session
  // solves supply/demand equations, so it needs the calculation guards (spec: Math / Physics / Economics are not).
  "histoire", "géographie", "geographie", "histoire-géographie", "philosophie", "français", "francais", "littérature", "litterature", "anglais", "espagnol", "allemand", "italien", "hggsp", "humanités", "humanites", "emc"]);
/** Is this session a discussion/argument subject (vs a calculation one)? The session's own subject wins; otherwise the
 *  recent text decides, but only when it names a humanities subject outright. Exported for tests. */
export function isDiscussionSubject(subject: string | undefined, recentText = ""): boolean {
  const named = String(subject || "").trim().toLowerCase();
  if (named && named !== "other") return DISCUSSION_SUBJECTS.has(named) || [...DISCUSSION_SUBJECTS].some((d) => named.includes(d));
  const d = detectSubject(recentText);
  return !!d && DISCUSSION_SUBJECTS.has(d.toLowerCase());
}
/** The student argued a position ("I think X because Y") but nothing of it went on the board this turn. Exported for tests. */
export function statesClaimUnboarded(message: string, boardWrites: number): boolean {
  const m = String(message || "").trim();
  if (boardWrites > 0 || !m || /^\[/.test(m) || /\?\s*$/.test(m)) return false;
  if (m.split(/\s+/).length < 10) return false;
  return /\b(?:because|since|therefore|so that|which shows|i think|i believe|i would argue|in my view|my claim|je pense|je crois|parce que|car|donc|selon moi|à mon avis)\b/i.test(m);
}
export const DISCUSSION_BLOCK = `

DISCUSSION SUBJECT — you are a critical-thinking partner, not an answer machine. This is History / literature / philosophy / languages / a TOK-style topic: there is usually no single number to find, so the learning is in the REASONING.
- Get a position first. Before explaining, ask what THEY think and why ("what's your claim, and what's it resting on?"). If they have no view yet, give two competing readings (not a verdict) and ask which they find stronger.
- Claim → evidence → reasoning. Every position needs a specific piece of evidence (a date, a source, a quote, an example) and the link from that evidence to the claim. If one is missing, ask for exactly that piece. Never accept "because it's obvious".
- Challenge, then let them respond. Raise the strongest objection a thoughtful critic would make ("what would someone who disagrees say?", "can you think of a case where that logic didn't hold?", "what if the source was written by the winner?"), ONE objection per turn, and make them answer it or revise. Challenge a correct-sounding claim too: agreeing every time teaches nothing. Be warm about it — you're testing the argument, not the person.
- Separate fact, interpretation and opinion. If they state a fact, check it; if an interpretation, ask what supports it and who might read it differently; if a value judgement, ask for the criteria. Weigh causes (which mattered most, and why?), judge sources (origin, purpose, value, limitation), compare perspectives, note change and continuity.
- Never write their argument. No ready-made thesis, paragraph or essay plan: offer a question, a frame (e.g. a PEEL or claim-counterclaim-rebuttal skeleton) or a contrasting reading, and let them fill it. If they ask for a model, give a short one on a DIFFERENT example.
- Be accurate. Never invent a quote, source, date, page number or historian's position. Say "historians disagree here" when they do, and say when you're unsure. If a fact they state is wrong, correct it plainly and show why it matters to their claim.
- Don't give the answer to an open question, but don't trap them either: after two stuck turns, lay out the competing considerations yourself and ask which they'd weight more.
- Board for these subjects (use it, the questions and the thinking belong there): their CLAIM as owner "student" (kind "insight"); evidence and the counter-argument you raised as short Otto lines; the argument map as FLOW_ON_BOARD (claim → evidence → reasoning → objection → reply); a timeline or comparison as an outline; a source's origin/purpose/value/limitation as an outline. Each question you ask them to think about goes on the board as a short line too. Never use "= ?" gaps or numeric answer boxes here; use a CREATE_PROBLEM with a rubric only for a definition or a recall check (e.g. define a term, name two causes).
- Steelman and switch sides: now and then ask them to argue the OTHER side as strongly as they can, or to name the best argument against their own view — then which survives, and why.
- Push for precision: "most", "always", "caused" — ask how much, how often, compared to what. Ask what would count as evidence against their claim.
- Close a thread with them stating, in their own words, what they now think and what would change their mind.`;

// ── Subject detection (the session starts with one open question, no subject picker) ──────────────────
const SUBJECTS: [string, RegExp][] = [
  ["Math", /\b(math|maths|mathématiques|equation|équation|derivative|dérivée|integral|intégrale|fraction|algebra|algèbre|geometry|géométrie|trigo\w*|sin|cos|tan|triangle|polynom\w*|function|fonction|limit|limite|probabilit\w*|vector|vecteur|matrix|matrice|log|exponential|exponentielle|suite|sequence|quadratic|factor\w*|solve|résou\w*|calcul\w*)\b|[0-9]\s*[x²³]|[=+×÷^√∫]/i],
  ["Physics", /\b(physics|physique|force|velocity|vitesse|acceleration|accélération|newton|energy|énergie|momentum|circuit|voltage|tension|current|courant|wave|onde|optics|optique|gravity|gravité|friction|frottement|mécanique|kinematics)\b/i],
  ["Chemistry", /\b(chemistry|chimie|mole|molar|molaire|reaction|réaction|acid|acide|base|ph|oxid\w*|redox|atom\w*|molecul\w*|bond|liaison|stoichiometry|stœchiométrie|titration|titrage)\b/i],
  ["Biology", /\b(biology|biologie|svt|cell|cellule|dna|adn|gene|gène|protein|protéine|enzyme|evolution|évolution|photosynthesis|photosynthèse|mitosis|mitose|ecosystem|écosystème|neuron\w*)\b/i],
  ["History", /\b(history|histoire|war|guerre|revolution|révolution|empire|treaty|traité|century|siècle|cold war|guerre froide|napoleon|napoléon|wwi|wwii|colonial\w*)\b/i],
  ["Geography", /\b(geography|géographie|géo|climate|climat|population|urban\w*|territoire|territory|globalization|mondialisation)\b/i],
  ["Economics", /\b(economics|économie|ses|supply|offre|demand|demande|inflation|gdp|pib|market|marché|unemployment|chômage|elasticity|élasticité)\b/i],
  ["Philosophy", /\b(philosophy|philosophie|philo|kant|descartes|platon|plato|conscience|liberté|freedom|morale|ethics|éthique|vérité|truth)\b/i],
  ["English", /\b(english|anglais|essay|poem|poetry|novel|shakespeare|grammar|tense|vocabulary)\b/i],
  ["French", /\b(français|french|dissertation|commentaire|poème|roman|conjugaison|grammaire|orthographe)\b/i],
  ["Spanish", /\b(spanish|espagnol|español)\b/i],
  ["German", /\b(german|allemand|deutsch)\b/i],
  ["Theory of Knowledge", /\b(tok|theory of knowledge|théorie de la connaissance|knowledge claim|ways of knowing|areas of knowledge|shared knowledge|personal knowledge|epistemolog\w*)\b/i],
  ["Art", /\b(art|arts plastiques|painting|peinture|sculpture|drawing|dessin|artist|artiste)\b/i],
  ["Music", /\b(music|musique|melody|mélodie|harmony|harmonie|chord|accord|rhythm|rythme|composer|compositeur)\b/i],
  ["Computer Science", /\b(code|coding|programming|programmation|python|javascript|algorithm|algorithme|function\s*\(|loop|boucle|array|tableau en python)\b/i],
];
/** Every subject a text touches (a journal entry often covers two or three), each with its keyword hits, strongest first.
 *  `known` = the student's own subject names (profile.subjects): a text naming one of them counts for it, whatever the keyword table says. */
export function subjectsIn(text: string, known: string[] = []): string[] {
  const s = String(text || "");
  const hits: [string, number][] = [];
  for (const [name, re] of SUBJECTS) {
    const n = new Set((s.match(new RegExp(re.source, "gi")) || []).map((m) => m.toLowerCase())).size;
    if (n > 0) hits.push([name, n]);
  }
  for (const k of known) {
    const name = String(k || "").trim();
    if (name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s) && !hits.some(([h]) => h.toLowerCase() === name.toLowerCase())) hits.push([name, 1]);
  }
  return hits.sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 3);
}
/** The subject a session is about, from what the student said — or undefined when nothing clearly names one.
 *  Explicit subject words win over incidental signals (an "=" sign in a chemistry question). Exported for tests. */
export function detectSubject(text: string): string | undefined {
  const s = String(text || "");
  const explicit = /\b(math|maths|mathématiques|physics|physique|chemistry|chimie|biology|biologie|svt|history|histoire|geography|géographie|economics|économie|ses|philosophy|philosophie|philo|english|anglais|français|french|spanish|espagnol|german|allemand)\b/i.exec(s)?.[1]?.toLowerCase();
  if (explicit) {
    const map: Record<string, string> = { math: "Math", maths: "Math", "mathématiques": "Math", physics: "Physics", physique: "Physics", chemistry: "Chemistry", chimie: "Chemistry", biology: "Biology", biologie: "Biology", svt: "Biology", history: "History", histoire: "History", geography: "Geography", "géographie": "Geography", economics: "Economics", "économie": "Economics", ses: "Economics", philosophy: "Philosophy", philosophie: "Philosophy", philo: "Philosophy", english: "English", anglais: "English", "français": "French", french: "French", spanish: "Spanish", espagnol: "Spanish", german: "German", allemand: "German" };
    return map[explicit];
  }
  // Otherwise the subject with the most distinct keyword hits; maths symbols alone only decide when nothing else matched.
  let best: string | undefined, bestHits = 0;
  for (const [name, re] of SUBJECTS) {
    const hits = new Set((s.match(new RegExp(re.source, "gi")) || []).map((m) => m.toLowerCase())).size;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best;
}
