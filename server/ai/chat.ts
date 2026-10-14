
import type { Profile } from "../../shared/types.ts";
import { tzOf } from "../../shared/types.ts";
import { notationGloss, voiceInputBlock, currentFocus, focusBlock, spokenMathHint, scaffoldLine, probeLine, cheerLine } from "../tutorAdapt.ts";
import { boardSurfaceBlock, boardTrajectoryBlock } from "../boardEvents.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../../shared/spokenMath.ts";
import { sourcesForTrack } from "../questionSources.ts";
import { sessionStateBlock } from "../sessionState.ts";
import { webSearch } from "../websearch";
import { AcademicContext, AuditEvent, CHAT_LANGUAGE_OVERRIDE, dueLine, errorLogLine, hintDensityLine, languageLine, learningStyleLine, milestoneLine, notNeededLine, nowBlock, personalContextLine, recentJournalLine, sessionRecapLine, studentModelLine, studentNameLine, syllabusGroundingLine, trackLine, weakCardLine } from "./context.ts";
import { DEEPSEEK_MODEL, OUT, createTutorChat, deepseekClient, retryRequest, stripWrapperTags, usageOf } from "./client.ts";
import { courseworkLine } from "./coursework.ts";
import { GEOMETRY_ON_BOARD_TOOL, GRAPH_ON_BOARD_TOOL, earlierDigest } from "./board.ts";
import { CREATE_CALC_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_INTERACTIVE_TOOL, CREATE_NOTE_TOOL, CREATE_PROBLEM_TOOL, CREATE_QUIZ_TOOL, FIND_SOURCE_QUESTION_TOOL, FLOW_ON_BOARD_TOOL, TABLE_ON_BOARD_TOOL, SOURCE_ON_BOARD_TOOL, READ_PAGE_TOOL, SET_OBJECTIVES_TOOL, SOLID_ON_BOARD_TOOL, SVG_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, WEB_SEARCH_TOOL, WIDGET_ON_BOARD_TOOL, WRITE_TO_BOARD_TOOL } from "./tools.ts";
import { REMEMBER_TOOL } from "./run.ts";
import { ChatHistory, ChatOptions, ChatResult, ChatTask } from "./chatTypes.ts";
import { buildChatSystemPrompt } from "./chatPrompt.ts";
import { finishChatReply, runChatRounds } from "./chatRounds.ts";

// ── OTTO SPEAKS FIRST: the real opening line of a tutor session ─────────────────────────────────────────
// Direct request: the session's opening line has to be REAL — grounded in what this student actually did
// last time — instead of a canned sentence with a topic slotted into it. The old line filled its slot from
// the first stored board text, which is a caption half the time ("The equation to work with" was quoted
// back to a student as "what we worked on last time" — a placeholder reading as memory).
// The browser holds the RICHEST real record (the actual board lines and the student's own questions from
// their last sessions) and the server can't see it, so the client sends a compact recap up with the
// request (see client/tutor/tutorSessions.ts's sessionMemoryForPrompt) and this grounds the line in that
// PLUS everything the server already knows: the tutor's own end-of-session recaps (profile.sessions), the
// running student model, and the milestones for this subject.
export interface TutorOpenerMemory {
  /** When it happened, already localized by the client ("yesterday", "3 days ago"). */
  when?: string;
  subject?: string;
  /** REAL board lines from that session — the actual content, never a title or a kind label. */
  lines?: string[];
  /** What the STUDENT asked in that session, in their own words. */
  asked?: string[];
}

/** The real-memory block the opener is grounded in. Exported so its exact shape is pinned by tests: the
 *  whole point of this feature is that the line is grounded, not invented. */
export function openerMemoryBlock(memory: TutorOpenerMemory[] | undefined): string {
  const items = (memory || []).filter((m) => m && (m.lines?.length || m.asked?.length || (m.subject && m.when)));
  if (!items.length) return "";
  return `\nWHAT THEY ACTUALLY DID IN RECENT SESSIONS (real record from this student's own browser, newest ` +
    `first — these are the REAL board lines and questions from those sessions, not titles or topic labels):\n` +
    items.map((m) => `- ${[m.when, m.subject].filter(Boolean).join(" · ") || "recent session"}` +
      (m.lines?.length ? `\n  what was on the board: ${m.lines.join(" | ")}` : "") +
      (m.asked?.length ? `\n  what they asked: ${m.asked.map((q) => `"${q}"`).join(" ")}` : "")).join("\n") + "\n";
}

/** Never let a model's formatting habits reach the bubble: this line is spoken, not written. Drops a code
 *  fence, a leading "Otto:" speaker label, a bullet dash, a surrounding quote pair, and markdown emphasis;
 *  collapses newlines to spaces; clamps at a sentence boundary. Exported for tests. */
export function cleanOpener(raw: string): string {
  let t = stripWrapperTags(String(raw || "")).trim();
  t = t.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
  t = t.replace(/^[-–—*•]\s+/, "");
  t = t.replace(/^(otto|professeur|teacher)\s*:\s*/i, "");
  t = t.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^«\s*([\s\S]*?)\s*»$/, "$1").trim();
  t = t.replace(/\*\*|__|`/g, "").replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (t.length > 320) {
    const cut = t.slice(0, 320);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = end > 80 ? cut.slice(0, end + 1).trim() : cut.trimEnd() + "…";
  }
  return t;
}

/** Compose the tutor session's opening line from real memory. Throws when the AI genuinely failed (empty
 *  completion included) — the route turns that into a quiet 502 and the client keeps its own instant line,
 *  so a failure here never leaves the student with an empty greeting. */
export async function tutorOpener(
  opts: { subject?: string; memory?: TutorOpenerMemory[]; schoolRecord?: string },
  profile?: Profile,
): Promise<{ opener: string; tokens: { in: number; out: number; cachedIn: number } }> {
  const subject = (opts.subject || "").trim();
  const en = profile?.language === "en";
  const sys =
    `You are Otto, a patient one-to-one tutor, opening a BRAND-NEW session with this student. Write ONLY ` +
    `the first thing you say to them — ONE or two short spoken sentences, no headings, no bullets, no ` +
    `markdown, no name/speaker label. Warm and specific, like a person who remembers them, never ` +
    `ceremonious.\n` +
    `THE LINE MUST BE REAL. Ground every specific thing you say in the memory below and nowhere else: name ` +
    `what they ACTUALLY worked on — the real equation, the technique, the topic as it appeared on the board ` +
    `— never a generic category, and never a board caption or a placeholder label (a label like "The ` +
    `equation to work with" is a heading on the board, NOT something the student studied). When the memory ` +
    `says when it happened, a light time reference ("yesterday", "the other day") is welcome — but use ` +
    `exactly ONE time reference: never stack "last time" on top of the stamp ("Last time, earlier today, ` +
    `we…" reads as machine-stitched — write "Earlier today we worked on X" instead).\n` +
    `NEVER invent a topic, a detail, or a number that isn't in the memory — and that includes inventing a ` +
    `RECOLLECTION: "last time we were working on X" when nothing on record says X is a lie the student can ` +
    `catch, and it is the exact placeholder this line exists to replace. When nothing is on record, say ` +
    `nothing about a previous session at all and just ask what they want to work on — an honest blank start ` +
    `beats a fabricated memory.\n` +
    `End with ONE short question that gets them talking. When there IS real memory, make it a retrieval ` +
    `question about that work (get THEM to recall it — don't just tell them what it was): recalling beats ` +
    `re-reading. Otherwise ask what's tripping them up. Vary the wording — this line must never read like a ` +
    `template.\n` +
    `Spoken tone: contractions, plain words, the rhythm of speech.`;
  const recorded =
    sessionRecapLine(profile?.sessions, subject || undefined) +
    studentModelLine(profile) +
    milestoneLine(profile, subject || undefined) +
    openerMemoryBlock(opts.memory) +
    (opts.schoolRecord || "");
  // The empty case is stated as its OWN instruction rather than left as an absence: with no memory block at
  // all, the model's default was to confabulate a warm "last time we were working on…" (verified live — it
  // invented a whole discriminant session for a student with no history), which is precisely the fake
  // recollection this feature exists to remove. Naming the fact out loud is what stops it.
  const memorySection = recorded.trim()
    ? recorded
    : `\nNOTHING IS ON RECORD about what this student has worked on${subject ? ` in ${subject}` : ""} — no ` +
      `previous session, no notes, nothing. You have NO memory of them. Do NOT refer to a previous session, ` +
      `do NOT say "last time" / "la dernière fois", and do NOT name any topic, exercise, equation or number. ` +
      `Just open by asking what they want to work on today.\n`;
  const user =
    (subject ? `The session is about ${subject}.\n` : "") +
    memorySection +
    nowBlock() + studentNameLine(profile?.name) +
    `\nWrite the opening line ${en ? "in English" : "in French (tu, not vous)"} — nothing else.`;
  const res = await createTutorChat({
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    temperature: 0.8,
    max_tokens: 200,
  }, true);
  const opener = cleanOpener(res?.choices?.[0]?.message?.content || "");
  if (!opener) throw new Error("empty opener completion");
  return { opener, tokens: usageOf(res) };
}

// Small, bounded — this is a "nudge me in the right direction" sidebar next to a card/question, not a
// full tutoring thread (that's chatAboutTask). No tool loop, no artifacts: giving THIS panel the power to
// hand over a fresh deck/quiz mid-drill would defeat the point of drilling the one already open.
const STUDY_HELP_HISTORY_CAP = 8;

/** Code-level backstop for studyHelp's rule 1 ("never reveal the final answer") — unlike chatAboutTask
 *  (CHAT_DOES_WORK/CHAT_STATES_ANSWER), studyHelp had ZERO programmatic check on its own output before
 *  this; the "never reveal" rule was pure prompt discipline with nothing catching a slip. Unlike those two
 *  regexes (which have to guess at phrasing since they don't know the actual answer), studyHelp already
 *  has the real answer string in scope — so this checks the reply against THAT specific string directly,
 *  a much higher-precision check than a generic pattern. Short (<3 char) answers are skipped: a card whose
 *  answer is "5" or "x" would false-positive on almost any reply that happens to contain that character. */
export function revealsAnswer(reply: string, answer: string): boolean {
  const needle = answer.trim().toLowerCase();
  if (needle.length < 3) return false;
  return reply.toLowerCase().includes(needle);
}

/**
 * Guidance chat scoped to ONE flashcard/quiz question currently on screen. The single hard rule: never
 * reveal the front/back or the correct option — the whole feature exists so a student stuck mid-drill can
 * get unstuck without the drill turning into "just tell me the answer." Stateless on the server (the
 * client keeps its own short local history for this one card, same as it keeps score) — persisting a
 * blow-by-blow of every card's hints would bloat the task for no benefit once the card's been answered.
 */
export async function studyHelp(
  card: { kind: "flashcard"; front: string; back: string } | { kind: "quiz"; question: string; options: string[]; correct: number },
  history: { role: "user" | "assistant"; text: string }[],
  message: string,
  profile?: Profile,
): Promise<{ reply: string; tokens: { in: number; out: number; cachedIn: number }; error?: boolean }> {
  const client = deepseekClient();
  const answer = card.kind === "flashcard" ? card.back : card.options[card.correct];
  const cardBlock = card.kind === "flashcard"
    ? `FLASHCARD FRONT (what the student sees): "${card.front}"\nFLASHCARD BACK / ANSWER (NEVER reveal this, not even paraphrased): "${answer}"`
    : `QUIZ QUESTION: "${card.question}"\nOPTIONS: ${card.options.map((o, i) => `${i + 1}) ${o}`).join(" ")}\nCORRECT OPTION (NEVER reveal which one, not even by elimination down to one): "${answer}"`;
  let webSearchBlock = "";
  try {
    const cardText = card.kind === "flashcard" ? card.front : card.question;
    const query = `${cardText} ${message}`.trim().slice(0, 150);
    if (query) {
      const results = await webSearch(query);
      if (results.length > 0) {
        webSearchBlock = `\n\nREAL-WORLD OUTSIDE CONTEXT & WEB SEARCH RESULTS:\n` +
          results.slice(0, 3).map((r) => `- [${r.title}] (${r.url}): ${r.snippet}`).join("\n");
      }
    }
  } catch { /* best-effort */ }

  const sys = languageLine(profile) + CHAT_LANGUAGE_OVERRIDE +
    `You are Otto, sitting next to a student while they drill ${card.kind === "flashcard" ? "flashcards" : "a quiz"}. They're stuck on ` +
    `ONE specific card/question and want a nudge, not the answer.\n\n${cardBlock}${webSearchBlock}\n\n` +
    `RULES:\n` +
    `1a. USE OUTSIDE CONTEXT & REAL-WORLD KNOWLEDGE — You are NOT limited to the text on the card. Use real-world ` +
    `examples, analogies, historical/scientific background, web search context, and broader domain knowledge to help the ` +
    `student understand the concept intuitively without revealing the final answer.\n` +
    `1. NEVER state, confirm, or rule out the FINAL answer — not the exact text, not a paraphrase, not by ` +
    `process of elimination down to a single remaining option, not even if they ask directly or claim they ` +
    `"already know" it. If they explicitly beg for the final answer, gently decline and offer another angle ` +
    `of hint instead. If they ask again after that, decline again the same way — don't get more generous the ` +
    `more times they ask; repeated begging is pressure, not a reason to cave. But this does NOT mean staying silent on their METHOD: "isn't this the way to do it, ` +
    `5/x = 1/10?" is asking whether their APPROACH is valid, not what x equals — answer THAT plainly ("yes, ` +
    `cross-multiplying works here — go ahead and solve it" / "not quite — that setup would work if the ratio ` +
    `were flipped, try again with..."). Confirming or correcting the METHOD/setup/formula/first step is ` +
  `always fair game; only the final value/text is off-limits. However, if the student's message contains an ` +
  `attempt, equation, calculation, or proposed correction, do NOT fix it for them or point out the sign/error ` +
  `immediately. Treat it as evidence that they are thinking: ask one precise question that makes them inspect ` +
  `the relevant relationship, direction, unit, or assumption themselves. Only discuss whether the method is valid ` +
  `when they explicitly ask whether their method/setup is valid. Never turn "check my work" into the corrected ` +
  `working or final result.\n` +
  `1a. FOCUS, DON'T FUNNEL — prefer a focusing question ("what do you notice about...?", "which part of ` +
    `the question is the key clue?") over a fill-in-the-blank ("so the answer starts with..."). Never give a ` +
    `hint that decomposes the reasoning FOR them — make them do the noticing. Let them struggle productively ` +
    `before narrowing down; only narrow after they've genuinely tried and missed.\n` +
    `2. Guide with questions, a relevant fact, an analogy, or by pointing at what part of the question actually ` +
    `matters — the same first-principles style as Otto's regular tutoring, just compressed to 1-3 short ` +
  `sentences (this is a sidebar next to a drill, not a lecture). ONE nudge, then stop — never a multi-step ` +
  `walkthrough of the whole method in one reply, even if you could. If the student has not shown any attempt, ` +
  `start with a question instead of an explanation. Keep the reply short enough that the student has to do ` +
  `the next move, rather than giving them a mini-solution.\n` +
    `3. If they seem to genuinely understand it now, encourage them to flip the card / pick an option ` +
    `themselves rather than telling them they're right.\n` +
    `4. Stay on this one card. If they ask something unrelated to it, answer briefly but steer back.\n` +
    `5. ALWAYS write something — even a one-sentence nudge is required. An empty or near-empty reply is a ` +
    `worse failure than being slightly too generous with a hint; never leave the message blank.`;
  const res: any = await retryRequest(() => client.chat.completions.create({
    model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
    // DeepSeek v4 is a REASONING model — its hidden reasoning tokens count against max_tokens (same trap
    // documented on OUT above/chatAboutTask's CHAT_DEADLINE_MS history). 300 was sized for the visible
    // reply alone; reasoning could eat the whole budget before a single reply token came out, leaving an
    // empty completion that silently fell through to the generic fallback line below — reproduced live via
    // this exact fallback appearing in the hint panel. Match OUT.chat's ceiling instead of a bespoke small one.
    max_tokens: OUT.chat,
    temperature: 0.4,
    messages: [
      { role: "system", content: sys },
      ...history.slice(-STUDY_HELP_HISTORY_CAP).map((h) => ({ role: h.role, content: h.text.slice(0, 1000) })),
      { role: "user", content: message.slice(0, 1000) },
    ],
  }));
  let raw = String(res.choices?.[0]?.message?.content || "").trim().slice(0, 800);
  // Backstop: if the model slipped and the reply actually contains the real answer, discard it — the same
  // "don't just trust the prompt" posture as chatAboutTask's CHAT_DOES_WORK/CHAT_STATES_ANSWER guardrail,
  // applied here with a stronger check since the actual answer string is right there (see revealsAnswer).
  if (raw && revealsAnswer(raw, answer)) {
    raw = profile?.language === "en"
      ? "I can point you at another angle, but not the answer directly — what part of the question feels like the key clue?"
      : "Je peux te donner un autre angle, mais pas la réponse directement — qu'est-ce qui te semble être l'indice clé dans la question ?";
  }
  // Honest failure message, not a pretend-present "what's tripping you up?" — see chatAboutTask's identical
  // fix (its finish()) for why: this text only ever shows when the AI call genuinely came back empty/failed,
  // never because Otto is waiting on the student to clarify something.
  const reply = raw || (profile?.language === "en" ? "Otto couldn't reply just now — try again in a moment." : "Otto n'a pas pu répondre tout de suite — réessaie dans un instant.");
  return { reply, tokens: usageOf(res), ...(raw ? {} : { error: true }) };
}

// Otto's OWN narrative claiming it did the student's graded work — checked against `did`/`synthesis` in
// runTask (the model's report of what it produced). Both languages: languageLine makes those FRENCH by
// default (this app's default language), so an English-only guard would leave the actual default path
// unprotected. Exported for tests/run.mjs (pinning both the true-positive AND the false-positive that
// would break legitimate tutoring, e.g. "rédigé" appearing in "aide à rédiger ton plan").
export const DOES_STUDENT_WORK = /\b(wrote|completed|finished|did|solved|answered) (?:your |the |his |her |their )?(essay|assignment|homework|problem set|paper|report|exam|quiz|test|worksheet|questions?)\b|\bsolved (?:all |every )?(?:the )?(?:problems?|questions?)\b|\b(answers? (?:to|for) (?:the |your )?(?:exam|quiz|test|questions?))\b|\b(rédigé|terminé|fini|résolu|répondu)\s+(?:à |aux )?(?:ta |ton |tes |ses |sa |son |les? |la |l['’])?(dissertation|devoir|exercices?|contrôle|examen|quiz|questions?|rédaction)\b|\br(?:é|e)ponses? (?:au?|aux) (?:contrôle|examen|quiz|exercices?)\b/i;

/**
 * Reply in a per-task coaching thread. Grounded in that ONE task's own context/steps/why so the student
 * never has to re-explain their situation, and scoped to being a supportive guide — never a ghostwriter.
 * Tool-capable (web_search + the three CREATE_* artifact tools, bounded) so the tutor can look something up
 * or hand over a deck/quiz/fiche mid-conversation instead of only ever talking.
 * Composio access (opts.extras) is READ-ONLY, unlike runTask's — `integrations.readOnly()` strips every
 * write action at both the schema AND call level (server/integrations.ts) before it ever reaches here, so
 * chat can search/read a connected account (e.g. "did my teacher already reply about the deadline?") but
 * can never send, draft, delete, or modify anything through it. Whatever `extras` this function receives
 * MUST already be read-only-scoped by the caller — this function does not scope it itself.
 */
// Cheap, local, conservative heuristic for the tool-narrowing latency fix above chatAboutTask's `tools`
// construction. Biased toward INCLUDING the artifact tools (false negatives are the only acceptable
// failure mode — a wrongly-INCLUDED tool costs tokens, a wrongly-EXCLUDED one costs a feature that turn).
// Exported for direct unit testing.
const ARTIFACT_KEYWORDS = /flashcard|fiche|quiz|carte|\bcards?\b|résum|note|deck|exercice|questionnaire|quizz|révis|study ?card|practice ?problem|\b(?:make|create|generate|redo|regenerate|add|more|again|build|prepare|fais|crée|génère|refais|ajoute|encore|plus)\b|\bps\b|\bpaper\b/i;

export function wantsArtifactTools(message: string, history: { role: "user" | "assistant"; text: string }[]): boolean {
  const recent = `${history.slice(-2).map((h) => h.text).join(" ")} ${message}`;
  if (ARTIFACT_KEYWORDS.test(recent)) return true;
  // Short (≤6 words) with no question mark reads as small talk/acknowledgement ("ok merci", "got it",
  // "d'accord") — exactly the turns where attaching 4 unused tool schemas costs tokens for nothing.
  // Anything longer or that asks a question stays on the safe (included) side.
  const words = message.trim().split(/\s+/).filter(Boolean);
  return !(words.length > 0 && words.length <= 6 && !message.includes("?"));
}

/** The code-checked verdict on the student's step, as a binding prompt line. A correct step means MOVE ON —
 *  don't make them re-derive what they just wrote (reported live: "replace 1025 with tan" micro-steps on a
 *  line that was already right). A wrong one names nothing about the right answer. */
export function stepVerdictLine(v?: { gap: string; given: string; verdict: "correct" | "incorrect" }): string {
  if (!v) return "";
  return v.verdict === "correct"
    ? `\n\nVERIFIED BY CODE: the student's step «${v.given}» is CORRECT for the open gap «${v.gap}» (checked by numeric equivalence — trust this over your own reading). Acknowledge it in a few words, record it on the board as their line, and move to the NEXT step — do not ask them to re-derive, rewrite or justify what they just got right. If the problem is now solved, ask whether they see another way to it (name the method they used first).\n`
    : `\n\nVERIFIED BY CODE: the student's step «${v.given}» is NOT equivalent to what the open gap «${v.gap}» needs (checked numerically — trust this over your own reading). Don't say "wrong" and never reveal the right expression: ask ONE question that makes them test their own line (plug in a value, check which side of the triangle is which, check the units).\n`;
}




export async function chatAboutTask(
  task: ChatTask,
  history: ChatHistory,
  message: string,
  profile?: Profile,
  academic?: AcademicContext,
  opts?: ChatOptions,
): Promise<ChatResult> {
  // Spoken input: the deterministic mishearing repair, computed once against what's in play (board lines,
  // problems, the task itself) — it feeds the prompt (voiceInputBlock) and the board guard below.
  const spokenRepair: SpokenRepair | null = opts?.spoken
    ? repairSpokenMath(message, spokenContextFrom([task.title, task.context || "", ...(opts.currentBoard || []).map((b) => b.text || ""), ...(opts.currentProblems || []).map((p) => p.question || "")]))
    : null;
  // What the student SAID, as every guard that asks "did they reach this?" should read it: the raw message plus,
  // when spoken, the repaired reading and the recognizer's alternatives — "1025 = height over b" did reach
  // "tan 25° = h/b", and writing that line up as theirs is exactly right.
  const heard = [message, ...(spokenRepair ? [spokenRepair.interpreted, ...(opts?.spoken?.alternatives || [])] : [])];
  const steps = task.steps || [];
  // Substeps (a step's own on-demand sub-checklist, ticked independently — see Profile.grades-style comment
  // on TaskStep.substeps) used to be invisible here: the tutor could see a step as "not done" while the
  // student had already ticked off 3 of its 4 sub-items, and would re-explain or re-ask about progress it
  // couldn't see. Nest them under their parent step, same [x]/[ ] convention, so "which of these did you
  // already do" is answered by the context instead of asked.
  const stepsBlock = steps.length
    ? `\nSteps (${steps.filter((s) => s.done).length}/${steps.length} done):\n` +
      steps.map((s, i) => `- [${s.done ? "x" : " "}] ${s.text}${opts?.stepIndex === i ? "  ← THEY TAPPED \"HELP\" ON THIS ONE" : ""}` +
        (s.substeps?.length ? "\n" + s.substeps.map((sub) => `  - [${sub.done ? "x" : " "}] ${sub.text}`).join("\n") : "")).join("\n")
    : "";
  // WHAT'S ALREADY ON THE BOARD — this used to not exist at all: the model could WRITE to the board but had
  // no idea what was already there, so it would reference "that triangle" or "the formula above" purely
  // from its own imagined context, then have no way to answer when the student said "I can't see what
  // you're pointing at". Oldest first (reading order, matches how the board itself renders).
  const boardEntries = opts?.currentBoard || [];
  const currentProblems = opts?.currentProblems || [];
  // boardSurfaceBlock (server/boardEvents.ts) replaces what used to be a hand-rolled duplicate of the same
  // logic here — same content, plus the concept/status tags this inline version never had (spec §11's
  // ownership distinction made visible: "STUDENT'S WORK", "marked WRONG"/"marked correct").
  const boardBlock = boardSurfaceBlock(boardEntries, currentProblems);
  // THE TRAJECTORY (spec §12) — what HAPPENED on the board across past turns, not just its current state.
  // Silent unless there's something worth saying (boardTrajectoryBlock's own gate).
  const trajectoryBlock = boardTrajectoryBlock(opts?.boardEvents);
  // SESSION STATE (spec §18) — app-tracked turn count/hint rung/independence, read-only context; empty on
  // a session's first turn (sessionStateBlock's own gate).
  const sessionBlock = opts?.sessionState ? sessionStateBlock(opts.sessionState) : "";
  const objectives = opts?.currentObjectives || [];
  const objectivesBlock = objectives.length
    ? `\nTODAY'S SESSION OBJECTIVES (student-visible checklist, set via SET_OBJECTIVES — update it, don't ` +
      `re-narrate it in chat):\n` +
      objectives.map((o) => `- [${o.done ? "x" : " "}] ${o.label}`).join("\n") + "\n"
    : `\nNo session objectives set yet. Once you and the student have settled on today's topic (usually after ` +
      `the first exchange or two, not before), call SET_OBJECTIVES with 3-6 concrete objectives for THIS ` +
      `session — this is separate from and more useful than a single WRITE_TO_BOARD focus sentence, since the ` +
      `student can watch it fill in as they demonstrate each one. Don't set objectives for a quick one-off ` +
      `question that isn't really a session (e.g. "what's 12% of 340").\n`;
  const stepHint = (opts?.stepIndex != null && steps[opts.stepIndex])
    ? `\nThey just asked for help specifically on "${steps[opts.stepIndex].text}" (marked above) — start FROM THERE, don't re-open the whole task or restate the step back at them. Still diagnose before explaining (rule 1).\n`
    : "";

  // Primer Policy Profile - age-appropriate tutoring behavior with warmth
  const policyBlock = ""; // Primer policy disabled for now
  
  // Warm, human-like opening for fresh sessions
  const isFirstMessage = history.length === 0;
  const warmthBlock = isFirstMessage && opts?.primer
    ? `\nThis is the VERY FIRST message in a fresh tutoring session. Start with a warm, friendly greeting - not robotic. 
    Be conversational and encouraging. Use their name if you know it from the profile. Make them feel welcome and supported. 
    Something like "Hey! Great to see you. What shall we work on today?" or "Hello! I'm Otto, and I'm here to help you learn. 
    What would you like to explore?" - warm, human, friendly.\n`
    : "";
    
  // Board integration — UNCONDITIONAL. It used to be gated on the board already being non-empty, which is
  // exactly backwards: a fresh session has NOTHING on the board, so the model was handed no instruction to
  // start using it and a session that opened with three chat turns and an empty board tended to stay that
  // way (reported live: "the tutor is not using the board enough"). The empty-board half now says the quiet
  // part out loud, and the "how often" rule below is the actual ask being enforced — most turns should ADD
  // something, and "talking about the math instead of putting it up" is named as the failure it is.
  const boardIntegrationBlock =
    `\nBOARD INTEGRATION — the board is the shared workspace, and this session should LOOK like the tutoring ` +
    `that happened. SHOW IT, DON'T JUST SAY IT: a formula in play, a term being defined, the given values, ` +
    `the cases a problem splits into, a diagram, or the step the student just landed — each of those belongs ` +
    `ON the board. Explaining it in chat instead is the commonest way the document ends up empty while the ` +
    `conversation looks fine. ` +
    (boardEntries.length || currentProblems.length
      ? `Reference what's already up ("look at what we have on the board") and build on it — never ` +
        `re-explain an entry that's already there. `
      : `NOTHING IS ON THE BOARD YET and this is the moment that changes: put the focus line up ` +
        `(kind:"focus") as soon as you know what you're working on, then the first formula/definition/values ` +
        `the moment they come into play. `) +
    `HOW OFTEN: any turn that produced something worth holding in the head — a formula, a definition, the ` +
    `problem's values, a case split, the student's own step — should normally END with ONE new board entry. ` +
    `A turn with real content and no write is the exception, not the default; several such turns in a row is ` +
    `the failure mode this rule exists to correct. ONE short entry per call, never a wall of text — the next ` +
    `thing gets its own entry later.\n` +
    `- For history/literature/language-arts/social-science content specifically: reach for kind:'outline' by ` +
    `default, not a flat sentence or a bare list crammed into 'text' — causes of an event, a source's key ` +
    `points, an essay's plan (thesis/evidence/counter-argument) are all headed-sections-with-bullets, which ` +
    `'outline' renders as real structure instead of a wall of text. Diagrams and 'formula' still make sense ` +
    `for anything genuinely spatial or numeric even in a humanities session (a map, a timeline with dates as ` +
    `a number line) — the subject decides the kind, not a fixed rule per subject.\n` +
    `- NOT TOO MUCH, NOT TOO LITTLE — the budget a real teacher works to. Normally ONE new line per turn; ` +
    `up to three only when you're setting up a new problem (the given, the question, one starting formula); ` +
    `four or more in a turn that isn't a setup is transcription, not teaching. Keep the PAGE readable too: ` +
    `when you move to a new problem, write the new focus line and LEAVE the old working where it is (the board is never cleared — their work is never deleted) so the problem they're on stays visible, ` +
    `instead of appending aimlessly until nothing is legible. Under-writing is the other failure — a turn with a real formula, definition or student step and ` +
    `nothing up there is a lesson that happened only in the scrollback. A line is worth writing when they'd ` +
    `otherwise hold it in their head or scroll back for it; anything else stays in chat.\n` +
    `- SELF-EXPLANATION — the cheapest big gain in the research: when they get a step RIGHT and it carries ` +
    `the method (not routine arithmetic), ask WHY it works before moving on ("why does that split it?", ` +
    `"what makes that allowed here?"). At most once per exchange — never after every line, and never as a ` +
    `condition for accepting an answer they already gave.\n` +
    `- SHOW THE WORKING, LINE BY LINE. When you work a problem through, the working goes up as SEPARATE LINES ` +
    `in the order you did it: each line one move, maths in $…$, a 2-5 word margin note only where the move ` +
    `isn't obvious, and the NEXT line left as the gap ("= ?") for them to do themselves. That gap is the ` +
    `point — the page shows how far you got TOGETHER and hands them the step that actually teaches. A short ` +
    `multi-line block like that is ONE entry, not "a wall of text": the ~25-word ceiling is about prose, ` +
    `never about a line of working.\n` +
    `- ASK IF YOU'RE UNSURE. If you don't know what they want on the page, or which of two things to put ` +
    `up, ask ONE short question instead of guessing or writing both — the question stays in CHAT, never a ` +
    `board entry: the board holds problems, working and figures, and questions are spoken, not posted.\n` +
    `- WHEN THEY ANSWER, TAKE IT: the moment they state an answer — even partial, even one they looked up or ` +
    `guessed, even without showing their working — recognise it in a few words (right: say so and move ON; ` +
    `wrong: say exactly what's off and ask the ONE next question). Never make them re-derive it to prove ` +
    `they were really with you, never re-ask the same question because the reasoning wasn't shown, and never ` +
    `refuse to confirm a value THEY just put on the table. You can ask "quick one — why?" as a follow-up, but ` +
    `as a question, never as a precondition for accepting the answer.\n` +
    `- WRITE EVERY LINE FRESH AND ADAPTIVE: no stock openings, no template labels (never \"Given:\", \"Established:\", ` +
    `\"Step 1\"), no recycled phrasing from earlier turns. Write in THEIR words and their notation, at their ` +
    `level, in the language they're using, shaped by what just happened this session — the same idea said any ` +
    `other way would be the wrong line for THIS student at THIS moment.\n`;
    
  // Smarter responses - contextual awareness
  const contextAwarenessBlock = history.length > 0
    ? `\nCONTEXTUAL AWARENESS: You're in an ongoing conversation. 
    - Reference what we've already discussed ("earlier we talked about...", "remember when we worked on...")
    - Build on previous understanding - don't restart from scratch each time
    - Notice patterns in their questions - if they keep asking about the same concept, dig deeper into it
    - Remember their level - adjust difficulty based on how they're responding
    - If they seem confused, back up and try a different angle
    - If they're getting it right, push them a bit further\n`
    : "";
  // Flashcard/quiz results already recorded on this task (flashcard review counts written by FlashcardDeck's
  // per-card review, quiz attempts written by /quiz/:quizId/attempt) — lets the tutor actually reference how
  // the drilling went ("you missed 3 of these last time") instead of only ever seeing the artifact exists.
  const artifactsBlock = (() => {
    const lines: string[] = [];
    for (const d of task.flashcards || []) {
      const reviewed = d.cards.filter((c) => c.review && c.review.seen);
      if (!reviewed.length) continue;
      const correct = reviewed.reduce((s, c) => s + (c.review!.correct || 0), 0);
      const seen = reviewed.reduce((s, c) => s + (c.review!.seen || 0), 0);
      lines.push(`- Flashcards "${d.title}": ${correct}/${seen} correct across reviews so far (${reviewed.length}/${d.cards.length} cards attempted)`);
    }
    for (const q of task.quizzes || []) {
      const last = q.attempts?.[q.attempts.length - 1];
      if (!last) continue;
      lines.push(`- Quiz "${q.title}": last attempt ${last.score}/${last.total}${q.attempts!.length > 1 ? ` (${q.attempts!.length} attempts total)` : ""}`);
    }
    return lines.length ? `\nSTUDY RESULTS ON THIS TASK SO FAR (use these to spot what's still shaky — don't just recite the numbers back):\n${lines.join("\n")}\n` : "";
  })();
  const fr = profile?.language !== "en";
  // MISSION (used by runTask/planning prompts) is deliberately NOT included here: it's ~330 tokens about
  // task generation and the `remember` tool — neither applies to this one-to-one chat (chat's tool set has
  // no `remember`, see `tools` below), and everything actually relevant to tutoring (purpose, boundaries,
  // method) is already covered more precisely by the methodology block right below. Resent on every turn
  // and every tool-loop round (CHAT_MAX_ROUNDS), so cutting genuinely-irrelevant content here is a real,
  // recurring token saving, not a one-off trim.
  // Seventh bandit target (server/bandit.ts's CHAT_STYLE_ARMS) — a small bias on TOP of the methodology
  // below, not a replacement for it (rule 1's diagnose-first step still always applies). "concise" adds
  // nothing (today's default); the other two lean the reply's SHAPE one way once the diagnosis is done.
  const styleLine = opts?.styleArm === "socratic"
    ? "\nSTYLE THIS TURN: lean HARDER into questions than usual — even after diagnosing, prefer one more good question over explaining, only explain once they're genuinely stuck on the question itself.\n"
    : opts?.styleArm === "worked-example"
    ? "\nSTYLE THIS TURN: once diagnosis is done, prefer leading with a PARALLEL worked example (same method, different numbers/case) before asking them to try their own — concrete before abstract.\n"
    : "";
  const growthLine = opts?.growthTrend === "up"
    ? `\nGROWTH: their recent quiz results in this subject show real, measurable improvement over their last ` +
      `few attempts. If it comes up naturally (don't force it into an unrelated reply), acknowledge that ` +
      `genuinely — a tutor who's watched them improve, not one meeting them for the first time.\n`
    : "";
  // Everything that changes from one call to the next (the clock, the student's profile facts, their error
  // log, journal, weak cards, the bandit's style pick) is assembled SEPARATELY and appended at the very END
  // of `sys`, not the front. It used to lead the prompt — with `nowBlock()` (changes every MINUTE) as
  // literally the first token — which broke prefix-based prompt caching for the ENTIRE ~4000-token
  // instruction block that follows: a cache hit requires an identical prefix from character 1, so a
  // per-minute-changing preamble meant DeepSeek re-processed (and re-billed, at full non-cached input-token
  // price) the whole methodology block on every single call, every tool-loop round, every message, with no
  // caching benefit ever available. The instruction block below is 100% static — identical for every
  // student, every task, every turn — so it belongs FIRST, where it can actually be cached; the volatile
  // per-request context goes last, right next to the equally-volatile TASK block it keeps company with
  // anyway.
  const dynamicContext = nowBlock() + courseworkLine(profile, task.sourceSubject) + studentNameLine(profile?.name) + dueLine(task.sourceDue, tzOf(profile)) + languageLine(profile) + CHAT_LANGUAGE_OVERRIDE + trackLine(profile) + syllabusGroundingLine(profile, task.sourceSubject) + learningStyleLine(profile) + hintDensityLine(profile) + personalContextLine(profile) + studentModelLine(profile) + growthLine + errorLogLine(profile, task.sourceSubject, opts?.subjectSignal) + milestoneLine(profile, task.sourceSubject) + sessionRecapLine(profile?.sessions, task.sourceSubject) + recentJournalLine(opts?.recentJournal, task.sourceSubject, opts?.journalMeta) + (opts?.schoolRecord || "") + weakCardLine(task) + notNeededLine(opts?.notNeeded) + styleLine + (opts?.primer ? (opts?.moveLine || "") + (opts?.repair || "") + stepVerdictLine(opts?.stepVerdict) + (opts?.spoken && spokenRepair ? voiceInputBlock(message, opts.spoken.alternatives, spokenRepair) : spokenMathHint(message)) + notationGloss(message, history) + scaffoldLine(message, history) + probeLine(message, history) + cheerLine(message, history, opts?.currentObjectives) : "");
  const sys =
    buildChatSystemPrompt({ academic, artifactsBlock, boardBlock, boardIntegrationBlock, contextAwarenessBlock, dynamicContext, history, message, objectivesBlock, opts, profile, sessionBlock, stepHint, stepsBlock, task, trajectoryBlock, warmthBlock });
  // 10, not the whole thread: every one of these is resent verbatim on every turn AND every intra-turn
  // tool-loop round (up to CHAT_MAX_ROUNDS) — a long-running chat's cost scales with this window, not just
  // message count. 10 turns is still enough for rule 5's "tie back to something from earlier in THIS
  // thread" and the Feynman-loop follow-up (rule 4) to work in practice; a real tutoring exchange rarely
  // needs to reference something from 12+ messages ago.
  // The Tutor's thread is made of many short turns (one-tap chips, automatic exercise/whiteboard messages), so
  // 10 messages was only ~3 real exchanges — the model forgot what was done and re-explained it. Primer turns
  // get a 24-message verbatim window PLUS a one-line-per-message digest of everything older (earlierDigest).
  const histWindow = opts?.primer ? 24 : 10;
  const digestText = opts?.primer
    ? (opts.opening?.length ? `HOW THIS SESSION BEGAN (verbatim — this is what the whole session is about; the problem/equation as the student first gave it. Never lose it, never ask for it again):\n${opts.opening.map((m) => `${m.role === "assistant" ? "Otto" : "Student"}: ${m.text.replace(/\s+/g, " ")}`).join("\n")}\n\n` : "") + earlierDigest(history.slice(0, -histWindow), 2600)
    : "";
  const messages: any[] = [
    { role: "system", content: sys },
    ...(digestText ? [{ role: "system", content: digestText }] : []),
    ...(opts?.primer ? (() => { const fb = focusBlock(currentFocus(opts?.currentProblems || [], opts?.currentBoard || [], opts?.opening || [])); return fb ? [{ role: "system", content: fb }] : []; })() : []),
    ...history.slice(-histWindow).map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: message },
  ];
  // No `client`/`actualModel` here any more: every model call in this function goes through
  // createTutorChat (Gemini first, DeepSeek as the fallback), which owns provider selection — resolving a
  // DeepSeek client up front would also make a DeepSeek key mandatory even when Gemini is answering.
  // REMEMBER_TOOL added here (chat previously had no way to persist anything from a tutoring conversation
  // into the student's profile, even though real conversations are the richest signal for this — a
  // mentioned teammate, a recurring struggle, a professor's grading quirk) — writes through applyRememberFact,
  // the same category/dedup rules tasks.ts's applyProfileUpdate uses for a fact learned during a task run, so
  // both land in the exact same place and get deduped against each other.
  // opts.extras is already read-only-scoped by the caller (server/index.ts wraps it in integrations.readOnly
  // before passing it here) — e.g. GMAIL_FETCH_EMAILS, so the tutor can check "did my teacher already
  // reply?" without ever being able to send/draft/delete anything through it.
  const readOnlyExtras = opts?.extras;
  // Canvas mode (see the CANVAS MODE prompt block below): a code-level guarantee, not just a prompt
  // request, that Otto can't sidestep "one problem at a time" by reaching for CREATE_QUIZ/CREATE_NOTE/
  // CREATE_FLASHCARDS instead — same "don't just trust the model" posture as the CHAT_DOES_WORK/
  // CHAT_STATES_ANSWER guardrails, applied here by removing the tool entirely rather than catching it
  // after the fact.
  // Latency lever: CREATE_NOTE/CREATE_FLASHCARDS/CREATE_QUIZ/REMEMBER's JSON schemas are ~10.3k chars
  // (~2.6k tokens) combined, resent IDENTICALLY on every round of the tool-loop regardless of whether
  // this turn has anything to do with them — a real, confirmed per-round cost on top of the already
  // large static prompt. Conservative and reversible: only drops them on a turn that's clearly short/
  // conversational with no artifact-ish keyword; a wrongly-dropped tool just means the model can't call
  // it THIS round, not a permanent loss — the student's next message is evaluated fresh. The tools that
  // stay ALWAYS available either way (search, calc) are core to live tutoring and/or already cheap.
  // Direct instruction: the board (and everything that renders ON it — practice problems, session
  // objectives) is a TUTOR-ONLY surface now, not "board-writing is always on." Previously WRITE_TO_BOARD/
  // DRAW_ON_BOARD/etc. were offered unconditionally (canvas mode or not) — gated to `opts?.primer` so the
  // model can no longer call them in a plain task chat or the general Study canvas, matching the client,
  // which no longer renders a board anywhere except the Tutor (TutorSession.tsx).
  const includeArtifactTools = wantsArtifactTools(message, history);
  const boardTools = opts?.primer
    ? [CREATE_PROBLEM_TOOL, ...(sourcesForTrack(profile?.track).length ? [FIND_SOURCE_QUESTION_TOOL] : []), WRITE_TO_BOARD_TOOL, SVG_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, SOLID_ON_BOARD_TOOL, GEOMETRY_ON_BOARD_TOOL, GRAPH_ON_BOARD_TOOL, WIDGET_ON_BOARD_TOOL, FLOW_ON_BOARD_TOOL, TABLE_ON_BOARD_TOOL, SOURCE_ON_BOARD_TOOL, ...(opts?.canvasMode ? [CREATE_INTERACTIVE_TOOL] : []), SET_OBJECTIVES_TOOL]
    : [];
  const tools = opts?.canvasMode
    ? [...boardTools, WEB_SEARCH_TOOL, READ_PAGE_TOOL, CREATE_CALC_TOOL, ...(includeArtifactTools ? [REMEMBER_TOOL] : []), ...(readOnlyExtras?.tools || [])]
    : [...(includeArtifactTools ? [CREATE_NOTE_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_QUIZ_TOOL] : []), ...boardTools, WEB_SEARCH_TOOL, READ_PAGE_TOOL, CREATE_CALC_TOOL, ...(includeArtifactTools ? [REMEMBER_TOOL] : []), ...(readOnlyExtras?.tools || [])];
  const empty = (): ChatResult => ({ reply: "", notes: [], flashcards: [], quizzes: [], problems: [], board: [], audit: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false });
  const result = empty();
  const logAudit = (kind: AuditEvent["kind"], label: string) => result.audit.push({ at: new Date().toISOString(), kind, label });
  const finish = (reply: string): Promise<ChatResult> => finishChatReply({ fr, history, logAudit, message, opts, result }, reply);

  const turnStartedAt = Date.now();
  const runRounds = (): Promise<ChatResult> => runChatRounds({ finish, fr, heard, history, includeArtifactTools, logAudit, message, messages, opts, profile, readOnlyExtras, result, spokenRepair, task, tools, turnStartedAt });
  // Hard SLA: the student is staring at a "thinking…" indicator, not reading a report — whatever's still
  // in flight past this point (a slow model round, a hung tool call) gets abandoned in favor of the honest
  // fallback line rather than leave them waiting indefinitely. A Promise.race can't cancel the underlying
  // HTTP call, but it guarantees THIS function returns within the deadline regardless of what DeepSeek does.
  // Was 28s — reproduced live: a single round asking for a large CREATE_FLASHCARDS batch (DeepSeek v4's
  // hidden reasoning tokens plus ~50 cards of real output) routinely took LONGER than that, so the
  // deadline fired and silently discarded a round that was actually about to succeed (visible after the
  // fact: round 0 finished with real content just after this raced fallback had already been returned).
  // The client's own `chat` call has no timeout of its own (plain `post`, not `postTimed`) and Vercel's
  // function ceiling is 300s (vercel.json), so there's ample room to raise this without creating a
  // mismatch. Was 45s, raised to a flat 2-minute buffer per explicit instruction — do not lower this
  // again even if a fix elsewhere makes replies fast again; a slow-but-real reply beating the generic
  // fallback is always the better outcome, and DeepSeek v4's hidden reasoning tokens make "slow" hard to
  // bound tightly (see the 28s→45s history right above).
  const CHAT_DEADLINE_MS = opts?.primer ? 45_000 : 120_000; // an interactive tutor turn never hangs for two minutes
  return Promise.race([
    runRounds(),
    new Promise<ChatResult>((resolve) => setTimeout(() => resolve(finish("")), CHAT_DEADLINE_MS)),
  ]);
}
