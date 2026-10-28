
import { randomUUID } from "node:crypto";
import type { Profile, TaskFlashcards, TaskQuiz, DailyPracticeProblem, ThemeTokens, WebTask } from "../../shared/types.ts";
import { validateThemeTokens } from "../../shared/types.ts";
import { computeCheck, statedKeyNumber } from "../../shared/exerciseVerification.ts";
import { errorLogBySubject, gradesBySubject, learnedProductiveHourForSubject } from "../../shared/types.ts";
import { aggregateSubjectSignals, predictNextEngagement } from "../patterns.ts";
import { leadingArm, CHAT_STYLE_ARMS, POMODORO_ARMS, ORDERING_ARMS, contextKey as banditContextKey, type BanditState } from "../bandit.ts";
import { DAILY_DECK_CARD_CAP, MONTHLY_DECK_CARD_CAP, makeDeck, makeQuiz, scrubAnswerLeak } from "./board.ts";
import { DEEPSEEK_MODEL, OUT, deepseekClient, firstJson, retryRequest, usageOf } from "./client.ts";
import { languageLine, trackLine } from "./context.ts";
import { personalizationBlock } from "../../shared/tutorMemory.ts";
import { normalizeStudentModel, studentModelBlock } from "../studentModel.ts";

/** ONE free-response practice problem — validated the same defensive way as makeDeck/makeQuiz. Both
 *  `problem` and `answer` are required (a problem with no stored answer can never be checked; an "answer"
 *  with no problem is meaningless), `format` is optional guidance text. */
export function makePracticeProblem(input: any): { problem: DailyPracticeProblem } | { error: string } {
  const problem = String(input?.problem || "").trim().slice(0, 600);
  let answer = String(input?.answer || "").trim().slice(0, 200);
  if (!problem || !answer) return { error: "ERROR: a practice problem needs both a non-empty problem and answer." };
  const format = scrubAnswerLeak(input?.format ? String(input.format).trim().slice(0, 200) : undefined, answer);
  // Spec §19: the key is verified by CODE, not by the generator's confidence. When the model supplies a
  // `check` expression, it is evaluated here and the COMPUTED value wins if the written key disagrees — the
  // same rule makeProblem already applies to chat exercises. No check means the key stays unverified, which
  // the grader reports as "uncertain" (and which can therefore never be turned into a false "wrong").
  const check = input?.check ? String(input.check).trim().slice(0, 200) : undefined;
  const value = check ? computeCheck(check, problem) : null;
  if (value != null) {
    const stated = statedKeyNumber(answer);
    // A WORD key ("H₂", "friction") is not a number, so the check — which COMPUTES a number — can't confirm or
    // contradict it and must never replace it (reported live: a hydrogen-symbol key became "2"). Only a key
    // that itself reads as a number can disagree with its own check; that one still yields to the computation.
    if (Number.isFinite(stated) && Math.abs(stated - value) > Math.max(0.01, Math.abs(value) * 0.01)) {
      console.warn(`[practice] answer key disagreed with its own check — using the computed value ${value}`);
      answer = String(value);
    }
  }
  return { problem: { id: randomUUID(), problem, answer, ...(check ? { check } : {}), ...(value != null ? { value } : {}), ...(format ? { format } : {}), createdAt: new Date().toISOString() } };
}

// Synthesis prompt for profile.studentModel (server/jobs.ts's processSweep is the only caller — see that
// file's shouldRefreshStudentModel for the once-a-day-and-only-if-active gate that keeps this from becoming
// a 4th AI-spend window). This is a COMPRESSION task over data Otto already has, not new reasoning over new
// content — deliberately NOT the full 8-rule tutoring prompt above.
const STUDENT_MODEL_SYS =
  `You are updating a tutor's private running notes on ONE specific teenage student (IB/Lycée, not a young ` +
  `child), based on real data below. Write a 150-300 word third-person summary covering: how they seem to ` +
  `think/reason (not just what subjects they're in), any recurring misconception or pattern of mistake worth ` +
  `watching for, what kind of explanation or approach has actually worked for them before, a genuine interest ` +
  `or project worth drawing a future analogy from, and how they seem to be growing/changing over time (don't ` +
  `just restate today's snapshot; when previous notes are given, revise them instead of starting over). When the data below shows real per-subject signal for two or more subjects ` +
  `(a correct-rate trend, a mistake pattern, a focus-time pattern), structure part of the summary around those ` +
  `subjects individually (e.g. "In Math HL specifically: ...") instead of one undifferentiated paragraph — but ` +
  `never manufacture a per-subject aside when the data doesn't actually support one. Write it as if for a ` +
  `tutor picking up where the last one left off — plain, specific, no praise-speak, no clinical/diagnostic ` +
  `labels, nothing invented beyond what the data supports. This text may later be shown directly to the ` +
  `student themselves, so nothing that would feel judgmental or surveillance-like if they read it verbatim. ` +
  `Output plain prose only, no headers, no bullet points.`;

/** Assembles a small (~800-1000 token) text blob purely from data already resident in `profile`/`list` (plus
 *  the bandit posteriors the caller already loaded for the sweep — see synthesizeStudentModel) — no new AI
 *  call, no raw full chat history. Returns undefined when there's genuinely nothing to synthesize from yet
 *  (true cold start), so synthesizeStudentModel can skip the call entirely rather than spending one to say
 *  "not enough data". */
function buildStudentModelInputs(profile: Profile, list: WebTask[], banditStates?: Partial<Record<"chatstyle" | "pomodoro" | "ordering", BanditState>>): string | undefined {
  const parts: string[] = [];
  const errLog = errorLogBySubject(profile.errorLog).flatMap((g) => g.entries).slice(0, 10);
  if (errLog.length) {
    parts.push(`Mistakes they've logged themselves (most recent first):\n` +
      errLog.map((e) => `- [${e.subject}] Q: "${e.question}" — mistake: "${e.mistake}"${e.fix ? ` — fix noted: "${e.fix}"` : ""}`).join("\n"));
  }
  const weakFronts: string[] = [];
  for (const t of list) for (const deck of t.flashcards || []) for (const c of deck.cards) if (c.review?.box === 1 && !c.notNeeded) weakFronts.push(c.front);
  if (weakFronts.length) parts.push(`Flashcards still shaky (Leitner box 1, gotten wrong / never advanced): ${weakFronts.slice(0, 15).join("; ")}`);
  const grades = gradesBySubject(profile.grades);
  if (grades.length) parts.push(`Current grade averages (weakest first, /20): ${grades.map((g) => `${g.subject} ${g.avg20.toFixed(1)}`).join(", ")}`);
  // Per-subject correct-rate + trend from flashcards/quizzes (server/patterns.ts) — the same data the
  // dashboard's weak-subject boost already uses, now also feeding the synthesis so it can name which
  // subjects are genuinely improving vs. sliding, not just restate a flat grade average.
  const subjectSignals = aggregateSubjectSignals(list).filter((s) => s.attempts >= 3);
  if (subjectSignals.length) {
    parts.push(`Per-subject correct-rate from recent flashcard/quiz activity (trend where known):\n` +
      subjectSignals.map((s) => `- ${s.subject}: ${Math.round(s.correctRate * 100)}% correct over ${s.attempts} attempts${s.trend ? ` (trending ${s.trend})` : ""}`).join("\n"));
  }
  // What the tutor has actually seen them do (concept evidence: alone / after a hint / after an explanation, live misconceptions) and what it has
  // learned about them as a person (goals, what landed, how their sittings go): the richest inputs, which this note used to ignore.
  try { const cm = studentModelBlock(normalizeStudentModel(profile.conceptModel), { limit: 8 }); if (cm) parts.push(cm); } catch { /* the concept record is a bonus */ }
  const personal = personalizationBlock(profile, undefined, new Date(), { tz: profile.timezone, bestHour: null, maxChars: 2400 });
  if (personal) parts.push(personal);
  if (profile.studentModel?.summary) parts.push(`YOUR PREVIOUS NOTES on this student (revise them: keep what still holds, correct what the new data changes, and say what has shifted since):\n${profile.studentModel.summary.slice(0, 1800)}`);
  if (profile.about?.trim()) parts.push(`What they've told Otto about themselves: ${profile.about.trim()}`);
  if (profile.projects?.length) parts.push(`Projects/interests on record: ${profile.projects.slice(0, 5).join("; ")}`);
  // Real working rhythm (server/patterns.ts) — when confident, gives the synthesis something concrete to
  // reference about when this student actually shows up, not just what they study.
  const engagement = predictNextEngagement(profile);
  if (engagement && engagement.confidence >= 0.3) {
    const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    parts.push(`Most likely to actually engage: ${WEEKDAYS[engagement.weekday]} around ${engagement.hour}:00 local time.`);
  }
  // Subject-specific focus windows (shared/types.ts) — only once there's enough per-subject history.
  const subjectFocusLines: string[] = [];
  for (const s of subjectSignals) {
    const peak = learnedProductiveHourForSubject(profile, s.subject);
    if (peak && peak.confidence >= 0.3) subjectFocusLines.push(`${s.subject} around ${peak.hour}:00`);
  }
  if (subjectFocusLines.length) parts.push(`Subjects they tend to be most focused on at a specific time of day: ${subjectFocusLines.join("; ")}`);
  // Learned behavioral preferences from the bandits (server/bandit.ts) — how this student learns best, not
  // just what they're weak on. Only included once each bandit has real evidence (leadingArm's own gate).
  if (banditStates) {
    const now = new Date();
    const key = banditContextKey(now, profile);
    const prefLines: string[] = [];
    const chat = banditStates.chatstyle && leadingArm(CHAT_STYLE_ARMS, banditStates.chatstyle, key);
    if (chat) prefLines.push(`responds best to a "${chat.arm.id}" chat style`);
    const pomo = banditStates.pomodoro && leadingArm(POMODORO_ARMS, banditStates.pomodoro, key);
    if (pomo && pomo.arm.enabled) prefLines.push(`focuses best with ~${pomo.arm.workMinutes}-minute work blocks`);
    const ordering = banditStates.ordering && leadingArm(ORDERING_ARMS, banditStates.ordering, key);
    if (ordering) prefLines.push(`does best with tasks ordered "${ordering.arm.id}"`);
    if (prefLines.length) parts.push(`Learned behavioral preferences (from observed session outcomes, not self-reported): ${prefLines.join("; ")}.`);
  }
  // Recent student-side chat highlights — the last 1-2 things THEY said (not Otto's replies) from a handful
  // of recently-active task threads, as a compression input, not a full re-read of the conversation.
  const chatHighlights = list
    .filter((t) => t.chat?.length)
    .sort((a, b) => Date.parse(b.chat![b.chat!.length - 1].at) - Date.parse(a.chat![a.chat!.length - 1].at))
    .slice(0, 5)
    .flatMap((t) => (t.chat || []).filter((m) => m.role === "user").slice(-2).map((m) => `- (${t.title}) "${m.text.slice(0, 150)}"`));
  if (chatHighlights.length) parts.push(`Recent things they've said in chat:\n${chatHighlights.join("\n")}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Cheap, bounded synthesis of profile.studentModel — the ONE new AI-spend site this feature adds, and it
 *  lives INSIDE the existing 4pm sweep window (server/jobs.ts's processSweep), never a 4th AI-spend window.
 *  Small model tier, small max_tokens, small input: a compression pass over data Otto already has.
 *  `banditStates` is optional (best-effort — the caller loads them from store.ts; a load failure there just
 *  means this synthesis runs without the "learned behavioral preferences" section, never blocks the sweep).
 *  Returns undefined if there's nothing worth synthesizing yet, spending zero tokens. */
export async function synthesizeStudentModel(profile: Profile, list: WebTask[], banditStates?: Partial<Record<"chatstyle" | "pomodoro" | "ordering", BanditState>>): Promise<{ summary: string; tokens: { in: number; out: number; cachedIn: number } } | undefined> {
  const inputs = buildStudentModelInputs(profile, list, banditStates);
  if (!inputs) return undefined;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: OUT.studentModel,
      temperature: 0.3,
      messages: [
        { role: "system", content: STUDENT_MODEL_SYS },
        { role: "user", content: inputs },
      ],
    }));
    const summary = String(res.choices?.[0]?.message?.content || "").trim().slice(0, 2000);
    if (!summary) return undefined;
    return { summary, tokens: usageOf(res) };
  } catch { return undefined; }
}

// Shared by every study-deck generator below (daily/weekly/monthly/topic) — the "minimum information
// principle" from the actual research on effective flashcards (retrieval practice + spacing are the two
// best-evidenced study techniques; a card only serves that if it forces ONE precise retrieval, not
// recognition of a vague paragraph). Supersedes an earlier version of this rule that said to COMBINE a
// multi-part answer into one card — that was backwards: "three reasons for X" as one card lets you
// recognize the gist without being able to produce any ONE of the three on demand, which is exactly the
// "testing yourself on a paragraph" failure mode this whole approach exists to avoid.
const CARD_STYLE_RULE =
  `CARD QUALITY — every card must pass this bar:\n` +
  `1. ONE IDEA PER CARD (the minimum-information principle). If a question would need several facts, ` +
  `causes, steps, or examples to answer fully, that is SEVERAL cards, not one with a multi-part back — ` +
  `"three reasons demand curves slope down" is three separate cards, one reason each, not one card listing ` +
  `all three. A card testing more than one fact tests recognition of a blob, not recall of a precise idea.\n` +
  `2. HARD, SPECIFIC FRONT — make the student actually RECALL, never just recognize or pattern-match. Name ` +
  `the subject/context so it stands alone outside the deck ("Physics: what does 'a' represent in v = u + at?" ` +
  `not just "what does a represent?"), and always phrase it as a genuine retrieval prompt ("Why does...", ` +
  `"What happens when...", "What's the difference between...", "Derive...", "Explain why..."), never a bare ` +
  `recognition prompt ("Do you know X?") or a fill-in-the-blank so obvious it gives itself away. NEVER put ` +
  `the answer — or a giveaway that makes it trivial — IN the front: if the card is testing WHEN something ` +
  `happened, the front asks for the date, it doesn't already state the date ("What year did the French ` +
  `Revolution begin?" not "In 1789, what began?" — the second one answers itself). Same for any other fact ` +
  `the back is supposed to supply: never pre-load it into the question.\n` +
  `3. BACK LENGTH MATCHES WHAT'S ACTUALLY BEING TESTED — don't force every back to the same length either ` +
  `way. A pure lookup fact (a value, a term, a single date with nothing more to say) gets a short, precise ` +
  `back — padding it with filler just to look "detailed" is as bad as being too terse. But when the real ` +
  `answer NEEDS context to actually teach something (why a date matters, what a formula's symbols mean, the ` +
  `mechanism behind a cause-effect relationship), give that — a bare "1789" or "because X" with zero mechanism ` +
  `is under-explaining, not being concise. Judge each card on its own: some backs are a single word, some are ` +
  `two sentences, and that variation is correct, not a flaw. Still ONE idea per card (rule 1) either way — ` +
  `long or short, never padded with a second unrelated fact or a restatement of the question.\n` +
  `4. YOUR OWN WORDING, not the textbook's or the student's notes verbatim — paraphrasing is itself part of ` +
  `what makes a card test understanding rather than memorized phrasing.\n` +
  `5. VARY THE CARD TYPE to fit what's actually being tested, don't force everything into one shape: a ` +
  `definition card ("what is X?") for vocabulary, a contrast card ("how does X differ from Y?") for two ideas ` +
  `students actually confuse, a cause-effect card ("why does X lead to Y?") for mechanisms, an application ` +
  `card (a short scenario, "which principle applies here?") for conceptual subjects, a cloze card (one ` +
  `key term blanked in an otherwise-meaningful sentence) when the surrounding context matters to the answer.\n` +
  `6. FLASHCARDS ARE EXCLUSIVELY FOR LEARNING DEFINITIONS AND CONCEPTS — vocabulary, core principles, laws, ` +
  `theorems, key facts, and formula recall. NEVER put multi-step practice problems, worked calculation exercises, ` +
  `or numerical problem-solving tasks inside flashcards. Practice problems and worked calculation exercises ` +
  `belong in Quizzes or Practice Problem cards, NOT in flashcard decks.\n` +
  `Output STRICT JSON only.`;

// Same "one idea, real discrimination, teach not just score" bar as CREATE_QUIZ_TOOL's own description
// (kept in sync deliberately — a companion quiz on a review deck should read exactly as well-made as one
// the student explicitly asked for in chat, not a lesser auto-generated version).
const QUIZ_STYLE_RULE =
  `IF you include a "quiz" (see below), same bar as any real quiz: each question tests ONE distinct sub-` +
  `notion (never the same question with numbers swapped); 3-4 options, EXACTLY one correct, and the wrong ` +
  `ones must be genuinely plausible (a common mix-up, an off-by-one, the right idea applied to the wrong ` +
  `case) — an obviously-silly distractor teaches nothing; every question needs a one-line "why" the correct ` +
  `answer is right, which is what makes it teach instead of just score.`;

/** Turns a Leitner box breakdown (server/tasks.ts's leitnerBoxBreakdown) into the spaced-repetition
 *  instruction block for a summary deck's prompt. This is the real spacing signal, not just "wrong or
 *  right": box 0/1 (never tested, or currently "Learning") needs frequent re-exposure — heavy weight in
 *  the new deck; box 2 ("Known") should get LESS space here, not equal space — spaced repetition's whole
 *  premise is that review time should concentrate on what's shaky, not spread evenly across everything ever
 *  learned. Two boxes now (was five, per LEITNER_BOX_LABEL in shared/types.ts) — simpler for a student to
 *  actually understand at a glance ("Learning" vs "Known"), so this only needs a weak/strong split, not a
 *  three-tier one. */
function spacedRepetitionBlock(boxBreakdown: { front: string; box: number }[], periodLabel: string): string {
  if (!boxBreakdown.length) return "";
  const weak = boxBreakdown.filter((c) => c.box <= 1).map((c) => c.front);
  const strong = boxBreakdown.filter((c) => c.box >= 2).map((c) => c.front);
  let block = `\n\nSPACED-REPETITION SIGNAL FROM ${periodLabel} (Leitner box per card — use this to decide how ` +
    `much space each concept gets in the new deck, don't weight everything evenly):\n`;
  if (weak.length) block += `- NEVER TESTED YET OR STILL "LEARNING" (box 0-1) — these need the MOST space, re-tested a genuinely ` +
    `different way, not copy-pasted: ${weak.slice(0, 25).map((f) => `"${f}"`).join(", ")}\n`;
  if (strong.length) block += `- "KNOWN" (box 2) — give these the LEAST space (a light check-in at most, or skip ` +
    `entirely in favor of the weaker concepts above) — re-testing something already solid wastes review time ` +
    `that spaced repetition says should go elsewhere: ${strong.slice(0, 15).map((f) => `"${f}"`).join(", ")}\n`;
  return block;
}

/** Daily study-log entry → a flashcard deck built from the CONCEPTS the entry is actually about — not a
 *  strict transcript of it. One-shot, no tool loop (same shape as refineManualTask above): the log text is
 *  the starting point/signal for what to study, not a ceiling on what the deck may contain. Reuses
 *  makeDeck() for the same validation every other deck-producing path already gets. */
// Bandit-controlled verbosity bias (server/bandit.ts's FLASHCARD_ARMS) — layered ON TOP of CARD_STYLE_RULE's
// own content-dependent length rule (rule 3), not replacing it: "concise"/"thorough" nudge the overall bias,
// they don't override a genuinely short fact getting a short back or a genuine derivation getting a long one.
const FLASHCARD_STYLE_TEXT: Record<string, string> = {
  concise: " Lean toward the SHORTER end of what CARD_STYLE_RULE allows — prefer more, punchier cards over fewer dense ones.",
  thorough: " Lean toward the more THOROUGH end of what CARD_STYLE_RULE allows — don't hesitate to include worked steps/context where it genuinely helps recall.",
};

export async function generateDailyStudyCards(logText: string, profile?: Profile, styleArm?: string, weakCards?: string[]): Promise<{ deck: TaskFlashcards; quiz?: TaskQuiz; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const raw = String(logText || "").trim();
  if (!raw) return null;
  // A handful of cards the student got wrong on a PREVIOUS day (Leitner box 1 — see weakCardFronts in
  // tasks.ts, which computes the same signal for week/month summaries) — reinforcement, not the point of
  // today's deck. Capped small and phrased as a secondary ask so it can never crowd out today's own content
  // (a day with 6 genuine topics shouldn't turn into "6 topics + 8 old mistakes").
  const weakBlock = weakCards?.length
    ? `\n\nA FEW THINGS THEY GOT WRONG ON A PREVIOUS DAY (weak spots, for light reinforcement only — do NOT ` +
      `let this outweigh today's own content): ${weakCards.slice(0, 6).join("; ")}. If 1-2 of these genuinely ` +
      `connect to today's material, fold a card for them in naturally; otherwise add at most 1-2 short standalone ` +
      `review cards for the ones most worth re-testing. Never more than 2 cards total from this list.`
    : "";
  // DELIBERATELY SIMPLE: this call runs on every single daily save (the most frequent AI action in the
  // whole app), so it needs to be small and fast above almost everything else. An earlier version of this
  // asked for full topic coverage + a guaranteed practice problem per subject + an optional bundled quiz +
  // up to 50 cards, ALL in one JSON response — genuinely better decks when it worked, but a bigger, slower,
  // more reasoning-heavy ask that failed ("Saved, but couldn't make flashcards") often enough to matter more
  // than the extra polish was worth. One prompt in, one small JSON response out, render it — that's the
  // whole feature; anything that makes that one round-trip less reliable is a net loss. No quiz here at all
  // any more (that's still a thing for week/month summaries, generated separately, never blocking a daily
  // save); no forced practice-problem-per-subject mandate — CARD_STYLE_RULE's own rule 6 already asks for
  // practice problems on quantitative subjects when a card actually calls for one.
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const makeReq = (maxTokens: number, concise: boolean) => retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          `Turn a student's own "what I learned today" entry into a flashcard deck worth revising from — not a ` +
          `1:1 transcript of their notes. Cover the distinct facts/definitions/formulas/dates they actually ` +
          `wrote, one idea per card; fix anything they got wrong instead of repeating the error; if they named ` +
          `a concept without its content (e.g. "SUVAT equations", nothing listed), fill in the real content as ` +
          `its own card(s), using your own subject knowledge — but stay strictly on the topics they named, no ` +
          `detours. THERE IS NO CARD LIMIT: make one card for EVERY distinct idea the entry supports and cover ` +
          `all of it — don't stop at ten, don't summarise several ideas into one card to save space. A short ` +
          `one-topic entry usually yields 10-20 cards, a normal day 20-40, a dense multi-subject day 40-80 or ` +
          `more. Only fewer when the entry genuinely holds fewer ideas; never pad with filler.` +
          (concise ? " Keep the backs SHORT and precise this time (no worked solutions) — but still one card per idea, as many as the entry supports." : ` ${CARD_STYLE_RULE}${FLASHCARD_STYLE_TEXT[styleArm || ""] || ""}`) },
        { role: "user", content:
          `TODAY'S LOG ENTRY:\n"""\n${raw.slice(0, 12000)}\n"""${weakBlock}\n\n` +
          `Return JSON: {"title": short label (≤8 words, name the actual topic(s)), "cards": [{"front": "...", "back": "..."}, ...]}.` },
      ],
    }));
    // DeepSeek's v4 models are reasoning models — REASONING tokens count against max_tokens too, before any
    // visible `content` is emitted, so a cap sized only for the expected JSON output routinely gets consumed
    // entirely by reasoning on a genuinely dense multi-subject entry, leaving `content` EMPTY (not truncated
    // — literally zero characters) even though the ask itself is small. Confirmed live: a real 5-subject
    // entry failed outright at max_tokens=10000 (both this call AND the 3000-token fallback below came back
    // with empty content), then succeeded cleanly at 24000 using ~13800 output tokens, most of it reasoning.
    // 24000 leaves real headroom for a genuinely dense day (up to 50 varied-length cards) plus its reasoning
    // overhead — most days use a fraction of this.
    const res = await makeReq(24000, false);
    let out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res.choices[0]?.message?.content || "");
    let result = out ? makeDeck(out, DAILY_DECK_CARD_CAP) : { error: "no parseable JSON in the response" };
    let tokens = usageOf(res);
    // FALLBACK: on the rare response that still gets cut off before its closing brace (firstJson can't
    // parse a truncated JSON blob AT ALL — one dropped brace loses the whole deck, not just the tail),
    // retry ONCE with an even smaller, plainer ask so a save reliably produces SOMETHING instead of
    // silently nothing. Only fires on failure, so it never adds cost to the normal path.
    if (!("deck" in result)) {
      console.log(`${new Date().toISOString()} [ai] generateDailyStudyCards: first attempt unparseable, retrying with a smaller ask`);
      // Same reasoning-tokens-eat-the-budget risk applies here — 3000 was too tight to reliably leave any
      // room for actual `content` once reasoning ran, undermining the whole point of a fallback (observed
      // live: the fallback ALSO came back with empty content on the same failing entry). Still meaningfully
      // smaller than the primary attempt's 24000, just not so small it can't realistically finish.
      const res2 = await makeReq(12000, true);
      out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res2.choices[0]?.message?.content || "");
      result = out ? makeDeck(out, DAILY_DECK_CARD_CAP) : { error: "no parseable JSON in the retry either" };
      const t2 = usageOf(res2);
      tokens = { in: tokens.in + t2.in, out: tokens.out + t2.out, cachedIn: (tokens.cachedIn || 0) + (t2.cachedIn || 0) };
      if (!("deck" in result)) {
        // Both attempts failed — log WHY (a bare `catch { return null; }` used to swallow this completely,
        // so a real recurring failure had zero visibility beyond the student's generic toast). `result.error`
        // is makeDeck's own reason when JSON parsed but validation rejected it; otherwise firstJson itself
        // returned null (unparseable/truncated) — the raw tail shows which.
        console.log(`${new Date().toISOString()} [ai] generateDailyStudyCards: FAILED after fallback — ${("error" in result ? result.error : "unknown")}. Raw tail: ${String(res2.choices[0]?.message?.content || "").slice(-300)}`);
        return null;
      }
    }
    console.log(`${new Date().toISOString()} [ai] generateDailyStudyCards: ${result.deck.cards.length} cards, ${tokens.in} in / ${tokens.out} out tokens`);
    if (styleArm) result.deck.styleArmId = styleArm;
    return { deck: result.deck, tokens };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateDailyStudyCards: EXCEPTION — ${e?.message || e}`);
    return null;
  }
}

// Cheap pre-filter (no AI call) so generateDailyPracticeProblem only fires when the entry plausibly
// mentions math/physics/science at all — bilingual (this app is FR/EN), and deliberately generous (a false
// positive just costs one extra small AI call that self-selects "no problem"; a false negative silently
// loses the feature entirely for that day, which is the worse failure). Pure + exported so it's testable.
const STEM_HINT_RE = /\b(math|maths|mathématiques|algebra|alg[eè]bre|geometry|g[eé]om[eé]trie|calculus|trigonometry|trigonom[eé]trie|equation|[eé]quation|physics|physique|chemistry|chimie|biology|biologie|science|force|velocity|vitesse|acceleration|acc[eé]l[eé]ration|energy|[eé]nergie|mole|reaction|r[eé]action|derivative|d[eé]riv[eé]e|integral|int[eé]grale|vector|vecteur|probability|probabilit[eé]|statistics|statistiques|SUVAT|Newton|thermodynamics|thermodynamique|kinematics|cin[eé]matique)\b/i;

export function looksLikeStem(logText: string): boolean {
  return STEM_HINT_RE.test(logText);
}

/** ONE free-response practice problem on the day's math/physics/science themes — a SEPARATE, small, best-
 *  effort call from generateDailyStudyCards, never bundled into it (the exact bundling that made the daily
 *  save unreliable before — see that function's own comment). Failing here must NEVER cost the student their
 *  flashcards: the caller treats a null return as "no problem today", not an error. Deliberately NOT multiple
 *  choice — the student types an answer, checked via practiceAnswerMatches (shared/types.ts), which actually
 *  exercises DOING the calculation rather than recognizing it among options. */
export async function generateDailyPracticeProblem(logText: string, profile?: Profile): Promise<{ problem: DailyPracticeProblem; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const raw = String(logText || "").trim();
  if (!raw || !looksLikeStem(raw)) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: 1200,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          `The student's log entry below MAY cover math/physics/science. If it genuinely does, write ONE real ` +
          `practice problem (a calculation, an equation to solve, a short applied problem) on THOSE actual ` +
          `themes, calibrated to their year/grade level above. This is FREE-RESPONSE, not multiple choice — the ` +
          `student will type their own answer, so: "answer" must be JUST THE BARE NUMBER in its simplest normal ` +
          `form (e.g. "84", "3.5", "-2") — NO unit attached to it (not "84 m", not "3.5 s"), same convention as ` +
          `an SAT/digital-exam grid-in answer: the number alone is what's graded, a unit is never required or ` +
          `expected. If the quantity genuinely can't be reduced to one bare number (a short expression, a ` +
          `word/phrase answer), that's fine — just never pad a numeric answer with its unit. Not a worked ` +
          `solution, not a sentence explaining it, just the answer itself, since it's checked by comparison. ` +
          `"format" is a short note on what the typed answer should look like — decimal places, simplification, ` +
          `and explicitly REMIND the student they don't need to type the unit — IMPORTANT: use GENERIC examples ` +
          `that don't reveal the actual answer (e.g. "round to one decimal place" instead of "e.g. 14.7", "as a ` +
          `simplified fraction" instead of "e.g. 3/4") — AND which plain-text symbols to use for anything not on a ` +
          `normal keyboard (e.g. "^" for an exponent, "sqrt(x)" for a square root, "pi", "x_1" for a subscript, ` +
          `"->" for a reaction arrow), so the student knows how to actually type it. "check" is an arithmetic ` +
          `expression that COMPUTES "answer" from the problem's own numbers, using + - * / ^ ( ) sqrt sin cos tan ` +
          `(plain sin/cos/tan mean DEGREES when the problem is in degrees) and pi — e.g. "(500-100)/(20+30)" for ` +
          `an equilibrium price. The app evaluates it and the computed value wins if it disagrees with "answer", ` +
          `so a wrong key can never mark a right answer wrong; write it even when the answer is short. Omit it ` +
          `only when "answer" genuinely isn't numeric. If the entry has NO real ` +
          `math/physics/science content, or you cannot write a genuine problem from it, output {"problem": null}.\n\n` +
          `Return ONLY this JSON: {"problem": {"problem": "...", "answer": "...", "check": "...", "format": "..."} | null}.` },
        { role: "user", content: `TODAY'S LOG ENTRY:\n"""\n${raw.slice(0, 4000)}\n"""` },
      ],
    }));
    const out = firstJson<{ problem?: { problem?: string; answer?: string; check?: string; format?: string } | null }>(res.choices[0]?.message?.content || "");
    if (!out?.problem) return null;
    const result = makePracticeProblem(out.problem);
    if (!("problem" in result)) return null;
    const tokens = usageOf(res);
    console.log(`${new Date().toISOString()} [ai] generateDailyPracticeProblem: 1 problem, ${tokens.in} in / ${tokens.out} out tokens`);
    return { problem: result.problem, tokens };
  } catch { return null; }
}

// Same core mechanic as chatAboutTask's system prompt rule 4 ("CHECK IT LANDED — THE FEYNMAN LOOP":
// explaining something back in your own plain words is the real test of understanding — wherever it goes
// vague, circular, or leans on a term you can't unpack, that's the gap) — applied here to the student's own
// WRITTEN journal entry instead of a live chat turn. generateDailyStudyCards already turns this same text
// into flashcards; this is a separate, best-effort, non-blocking call (same posture as
// generateDailyPracticeProblem right above) precisely BECAUSE the daily-save round trip is deliberately kept
// small and fast (see generateDailyStudyCards's own comment) — bolting a second judgment call onto that one
// request would make the single most frequent AI action in the app slower/less reliable for a nice-to-have.
// A failure here costs nothing: the entry saved and the flashcards generated regardless.
export async function checkFeynmanGap(logText: string, profile?: Profile): Promise<{ gap: string; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const raw = String(logText || "").trim();
  if (raw.length < 40) return null; // too short to genuinely contain an explanation worth checking
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: 300,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          `Read the student's own written explanation of what they learned today, below. Judge it exactly like ` +
          `the Feynman technique: does it actually hold together end to end in plain words, or does it go ` +
          `vague, circular, or lean on a term/fact it never actually unpacks (e.g. "mitosis splits the cell ` +
          `because that's how it works", "the derivative just gives the rate")? Most entries are genuinely ` +
          `fine — a short, honest recap of what was studied, not a rigorous proof — so only flag a REAL gap, ` +
          `not "could be more detailed" or "could add an example." If you flag one, write ONE short, specific, ` +
          `plain-spoken question pointing at that exact spot (mirror how a tutor would ask it out loud, not a ` +
          `graded-feedback tone) — the same move as asking "you said X 'just happens' — what actually makes it ` +
          `happen?", never a generic "can you elaborate?" If the entry is too short/logistics-only to contain ` +
          `any real explanation to check (e.g. "did exercises 3-5", "reviewed vocab"), or it genuinely holds ` +
          `together, output {"gap": null}.\n\n` +
          `Return ONLY this JSON: {"gap": "..." | null}.` },
        { role: "user", content: `TODAY'S LOG ENTRY:\n"""\n${raw.slice(0, 4000)}\n"""` },
      ],
    }));
    const out = firstJson<{ gap?: string | null }>(res.choices[0]?.message?.content || "");
    const gap = String(out?.gap || "").trim().slice(0, 300);
    if (!gap) return null;
    const tokens = usageOf(res);
    console.log(`${new Date().toISOString()} [ai] checkFeynmanGap: 1 gap flagged, ${tokens.in} in / ${tokens.out} out tokens`);
    return { gap, tokens };
  } catch { return null; }
}

/** Extracts 0-2 DURABLE, generalizable facts from a journal entry worth remembering long-term — a
 *  professor's grading quirk, a recurring conceptual mix-up, a genuine subject preference — as opposed to
 *  "what they studied today" (which belongs in the flashcards, not durable memory). Applied into
 *  profile.courses (applyProfileUpdate, same category the "remember" tool already uses from chat/task runs),
 *  which profileBlock ALREADY surfaces in every agent/chat prompt — so this is the one piece of wiring that
 *  makes journal-derived facts available to Otto EVERYWHERE, not just within the Journal feature itself, per
 *  direct request ("things learned in journal should stay in memory... AI can reference it in chat too").
 *  Separate, best-effort side call — same posture as checkFeynmanGap/generateDailyPracticeProblem right next
 *  to this in the route: a failure here never blocks the day's actual flashcards, and this call is
 *  deliberately NOT folded into generateDailyStudyCards' own schema (see that function's own comment on why
 *  it stays small/simple — a richer combined ask was found live to fail more often than the extra content
 *  was worth). Small threshold to skip logistics-only entries with nothing durable to extract. */
export async function extractJournalMemory(logText: string, profile?: Profile): Promise<{ facts: string[]; milestones: { subject: string; topic: string; label: string }[]; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const raw = String(logText || "").trim();
  if (raw.length < 40) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: 400,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          `Read the student's own "what I learned today" journal entry. Do TWO separate extractions from it:\n\n` +
          `1. FACTS (0-2): genuinely worth REMEMBERING LONG-TERM about how THIS student learns — not what they ` +
          `studied today, that's already captured elsewhere. Only extract something that would still be true ` +
          `and useful weeks from now: a recurring conceptual mix-up ("consistently confuses métaphore and ` +
          `métonymie"), a real preference ("prefers worked examples over abstract proofs"), a teacher/class-` +
          `specific pattern they mentioned ("Mr. X's tests always include a data-analysis question"), a genuine ` +
          `strength or blind spot that keeps showing up. Do NOT extract: today's topic, a one-off event, generic ` +
          `study advice, anything already obvious from the subject name alone. Most entries have NOTHING durable ` +
          `to extract — that's the normal, common case, output an empty array, don't force it. Each fact: one ` +
          `short plain sentence, ≤20 words, no preamble.\n\n` +
          `2. MILESTONES (0-2): a SPECIFIC topic/skill they now show real command of — evidence of actually ` +
          `GETTING something, not just "studied X" (studying isn't mastering). Look for phrasing like "finally ` +
          `understood...", "I can now...", "got the hang of...", solving something they were stuck on before, or ` +
          `a teacher/quiz confirming it clicked. Each needs: subject (e.g. "Maths", "Physique-Chimie" — the ` +
          `actual course name, inferred from context if not stated), topic (the specific skill/concept, ≤6 ` +
          `words, e.g. "factoring quadratics", "subjonctif conjugation" — NOT the whole subject), and label (one ` +
          `short sentence describing what they can now do, ≤15 words). Most entries have NO milestone-worthy ` +
          `moment either — don't force one from routine "did my homework" logging.\n\n` +
          `Return ONLY this JSON: {"facts": ["...", ...], "milestones": [{"subject": "...", "topic": "...", ` +
          `"label": "..."}, ...]} (each array 0-2 items, empty is normal/expected).` },
        { role: "user", content: `TODAY'S LOG ENTRY:\n"""\n${raw.slice(0, 4000)}\n"""` },
      ],
    }));
    const out = firstJson<{ facts?: string[]; milestones?: { subject?: string; topic?: string; label?: string }[] }>(res.choices[0]?.message?.content || "");
    const facts = Array.isArray(out?.facts) ? out.facts.map((f) => String(f).trim().slice(0, 200)).filter(Boolean).slice(0, 2) : [];
    const milestones = Array.isArray(out?.milestones)
      ? out.milestones.map((m) => ({ subject: String(m?.subject || "").trim().slice(0, 60), topic: String(m?.topic || "").trim().slice(0, 80), label: String(m?.label || "").trim().slice(0, 200) }))
        .filter((m) => m.subject && m.topic && m.label).slice(0, 2)
      : [];
    const tokens = usageOf(res);
    if (facts.length || milestones.length) console.log(`${new Date().toISOString()} [ai] extractJournalMemory: ${facts.length} fact(s), ${milestones.length} milestone(s) extracted`);
    return { facts, milestones, tokens };
  } catch { return null; }
}

/** End-of-week summary deck: synthesizes across the week's daily entries, weighted by a REAL spaced-
 *  repetition signal (Leitner box breakdown — see spacedRepetitionBlock/nextLeitnerReview) rather than
 *  either re-testing everything evenly or only tracking "wrong or not". Also decides, per week, whether a
 *  companion multiple-choice quiz would genuinely help — concepts easily confused with each other, or that
 *  need discrimination between similar options, test better as MCQ than recall flashcards — and includes
 *  one only when the material calls for it, never as a default add-on. */
export async function generateWeeklyStudyDeck(entries: { date: string; logText: string }[], boxBreakdown: { front: string; box: number }[], profile?: Profile): Promise<{ deck: TaskFlashcards; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const days = entries.filter((e) => e.logText?.trim());
  if (!days.length) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const spacedBlock = spacedRepetitionBlock(boxBreakdown, "THIS WEEK'S DAILY DECKS");
    const entriesBlock = days.map((d) => `— ${d.date}:\n"""\n${d.logText.slice(0, 2000)}\n"""`).join("\n\n");
    const makeReq = (maxTokens: number, concise: boolean) => retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          (concise
            ? `Build a CONCISE week-end-review flashcard deck from a student's daily "what I learned" entries — ` +
              `merge near-duplicate ideas across days, cover the week's distinct concepts, short precise backs, ` +
              `no worked solutions, no quiz. At most 25 cards. WEIGHT TOWARD what the spaced-repetition signal ` +
              `below marks as never-tested-or-still-"Learning" (box 0-1) — a short concise deck is exactly ` +
              `where it matters MOST to spend the limited card budget on what didn't stick yet, not on "Known" ` +
              `concepts that are already solid. ${CARD_STYLE_RULE}`
            : `You build a WEEK-END-REVIEW flashcard deck from a student's own daily "what I learned" entries. ` +
              `This is a SUMMARY across the whole week, not a re-dump of every daily card verbatim — merge near-` +
              `duplicate ideas from different days into one card, connect genuinely related concepts across days. ` +
              `THIS DECK SHOULD BE LARGER THAN ANY SINGLE DAY'S — it spans up to 5 days of material, so on ` +
              `average it should run noticeably longer than one day's deck, not come out similar in size; a week ` +
              `with real content across several days that produces a SHORT summary has under-covered it. Cover ` +
              `every distinct concept the week actually contained, up to 50 cards (a hard technical ceiling on ` +
              `this reply's token budget, not a product opinion) — aim for full coverage, not a "highlights" ` +
              `selection. WITHIN that coverage, WEIGHT HEAVILY toward what's in the spaced-repetition signal ` +
              `below as never-tested-or-still-"Learning" (box 0-1): those concepts should make up a CLEARLY LARGER ` +
              `share of the deck than "Known" ones — re-tested a genuinely different way each ` +
              `time, not copy-pasted — since the whole point of a week-end review is catching what didn't stick ` +
              `the first time, not re-visiting everything evenly. ${CARD_STYLE_RULE}`) },
        { role: "user", content:
          // BUG, reported live: "weekly/monthly decks keep repeating stuff that's already very learned" —
          // this spaced-repetition signal (which cards are weak vs. already-known) was being DROPPED
          // entirely on the concise fallback tier (`concise ? "" : spacedBlock`). That fallback tier fires
          // often in practice (DeepSeek v4's reasoning tokens routinely eat the primary attempt's budget —
          // see generateDailyStudyCards' own comment on this), so the one signal telling the model to favor
          // unlearned concepts was silently missing on a meaningful fraction of real weekly decks, leaving
          // it free to just re-surface whatever was most salient across entries — which skews toward
          // well-practiced, already-"Known" material, not what actually needs review. Always include it.
          `THIS WEEK'S DAILY ENTRIES:\n${entriesBlock}` + spacedBlock +
          `\n\nReturn JSON: {"title": short label for the week's deck (≤8 words), "cards": [{"front": "...", "back": "..."}, ...]}.` },
      ],
    }));
    const res = await makeReq(OUT.studylog, false);
    let out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res.choices[0]?.message?.content || "");
    let result = out ? makeDeck(out) : { error: "no parseable JSON in the response" };
    let tokens = usageOf(res);
    // FALLBACK: same reasoning as generateDailyStudyCards — an ambitious single JSON response (full week
    // coverage + heavy weak-focus reweighting, up to 50 cards) can run long enough to get cut off before its
    // closing brace, which loses the WHOLE deck, not just the tail. Retry ONCE with a much smaller ask so
    // "generate week summary" reliably produces something. (The quiz used to be bundled into this same
    // call — split out into generateWeeklyQuiz below, a separate best-effort call, exactly like
    // generateDailyPracticeProblem is kept separate from generateDailyStudyCards: bundling it in made the
    // ONE ask more likely to blow its token budget before finishing the deck, which is what actually
    // mattered — reproduced live as decks landing at only ~10 cards because two ambitious/bundled attempts
    // kept failing and every summary was quietly falling all the way to the tiny last-resort tier below.)
    if (!("deck" in result)) {
      console.log(`${new Date().toISOString()} [ai] generateWeeklyStudyDeck: first attempt unparseable, retrying with a smaller ask`);
      const res2 = await makeReq(5000, true);
      out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res2.choices[0]?.message?.content || "");
      result = out ? makeDeck(out) : { error: "no parseable JSON in the retry either" };
      const t2 = usageOf(res2);
      tokens = { in: tokens.in + t2.in, out: tokens.out + t2.out, cachedIn: (tokens.cachedIn || 0) + (t2.cachedIn || 0) };
      if (!("deck" in result)) {
        console.log(`${new Date().toISOString()} [ai] generateWeeklyStudyDeck: second attempt also unparseable — ${("error" in result ? result.error : "unknown")}. Raw tail: ${String(res2.choices[0]?.message?.content || "").slice(-300)}`);
        // THIRD, LAST-RESORT tier: two failures in a row on a genuinely dense/long week (5 days of real
        // content) means DeepSeek's hidden reasoning is eating the budget before real output even at 5000
        // tokens — reproduced live as two straight "Couldn't build the week summary" failures for the same
        // account. Strip the instruction down to the bare minimum (no style rules, no spaced-repetition
        // weighting, explicitly told to skip deliberation) so there's as little for the model to reason
        // ABOUT before writing JSON — a small, plain deck beats a third silent failure.
        // Preserve EVERY day here, just with each one trimmed harder (500 chars vs the primary ask's 2000)
        // — the earlier version sliced the already-joined block to 3000 chars total, which in practice
        // meant only the FIRST day or two survived at all. That's the direct cause of "only one or two days
        // covered": the one fallback tier that was actually succeeding was silently dropping the rest of
        // the week. Cap raised 10 → 20 cards too, since a genuinely 5-day week deserves more than a token deck.
        const lastResortBlock = days.map((d) => `— ${d.date}: ${d.logText.slice(0, 500)}`).join("\n");
        const res3 = await retryRequest(() => client.chat.completions.create({
          model, max_tokens: 3000, temperature: 0.2, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: languageLine(profile) +
              `Output a flashcard deck directly — no analysis, no reasoning out loud, just the JSON. Cover ` +
              `EVERY day listed below, at least one card each — do not skip any day. Up to 20 cards total, ` +
              `short front/back pairs.` },
            { role: "user", content: `${lastResortBlock}\n\nReturn ONLY: {"title": "...", "cards": [{"front": "...", "back": "..."}, ...]}.` },
          ],
        }));
        out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res3.choices[0]?.message?.content || "");
        result = out ? makeDeck(out) : { error: "no parseable JSON in the last-resort retry either" };
        const t3 = usageOf(res3);
        tokens = { in: tokens.in + t3.in, out: tokens.out + t3.out, cachedIn: (tokens.cachedIn || 0) + (t3.cachedIn || 0) };
        if (!("deck" in result)) {
          console.log(`${new Date().toISOString()} [ai] generateWeeklyStudyDeck: FAILED after all 3 attempts — ${("error" in result ? result.error : "unknown")}. Raw tail: ${String(res3.choices[0]?.message?.content || "").slice(-300)}`);
          return null;
        }
      }
    }
    console.log(`${new Date().toISOString()} [ai] generateWeeklyStudyDeck: ${days.length} day(s), ${result.deck.cards.length} cards, ${tokens.in} in / ${tokens.out} out tokens`);
    // Quiz is now a separate, best-effort call (see generateWeeklyQuiz) — never bundled into the deck ask
    // above, so a quiz failure/timeout can never cost the deck the student is actually waiting on.
    return { deck: result.deck, tokens };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateWeeklyStudyDeck: EXCEPTION — ${e?.message || e}`);
    return null;
  }
}

/** Companion quiz for the week-end deck — split out from generateWeeklyStudyDeck (see that function's own
 *  comment) so an ambitious/slow quiz ask can never cost the deck itself. Best-effort: returns undefined on
 *  any failure or when the week's material doesn't genuinely call for MCQ-style testing, never throws. */
export async function generateWeeklyQuiz(entries: { date: string; logText: string }[], profile?: Profile): Promise<{ quiz?: TaskQuiz; tokens: { in: number; out: number; cachedIn: number } }> {
  const days = entries.filter((e) => e.logText?.trim());
  const empty = { tokens: { in: 0, out: 0, cachedIn: 0 } };
  if (!days.length) return empty;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const entriesBlock = days.map((d) => `— ${d.date}:\n"""\n${d.logText.slice(0, 1500)}\n"""`).join("\n\n");
    const res = await retryRequest(() => client.chat.completions.create({
      model, max_tokens: 4000, temperature: 0.3, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: languageLine(profile) +
          `Decide if a multiple-choice quiz is warranted for this week's material: only when there are ` +
          `concepts students commonly confuse with each other, or that genuinely need discriminating between ` +
          `similar-looking answers (not just recalling one fact). If nothing calls for that format, output ` +
          `{"quiz": null} — it is NOT a default add-on. Otherwise 4-10 questions. ${QUIZ_STYLE_RULE}` },
        { role: "user", content: `THIS WEEK'S DAILY ENTRIES:\n${entriesBlock}\n\nReturn JSON: {"quiz": {"title": "...", "questions": [{"q": "...", "options": ["...", ...], "correct": 0, "why": "..."}, ...]} | null}.` },
      ],
    }));
    const out = firstJson<{ quiz?: { title?: string; questions?: any[] } | null }>(res.choices[0]?.message?.content || "");
    const tokens = usageOf(res);
    if (!out?.quiz) return { tokens };
    const qr = makeQuiz(out.quiz);
    return { quiz: "quiz" in qr ? qr.quiz : undefined, tokens };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateWeeklyQuiz: EXCEPTION — ${e?.message || e}`);
    return empty;
  }
}

/** Month-end summary: synthesizes across that month's WEEKLY decks (not the raw daily entries — by the
 *  time a month has passed the weekly decks are already the distilled signal, so re-reading every daily
 *  entry again would just re-spend tokens re-deriving what the weekly pass already figured out). Weighted
 *  by the same real Leitner spaced-repetition signal as weekly (spacedRepetitionBlock), and can likewise
 *  include a companion quiz when the month's material genuinely calls for discrimination-style testing. */
export async function generateMonthlyStudyDeck(weeks: { label: string; cards: { front: string; back: string }[] }[], boxBreakdown: { front: string; box: number }[], profile?: Profile): Promise<{ deck: TaskFlashcards; tokens: { in: number; out: number; cachedIn: number } } | null> {
  const nonEmpty = weeks.filter((w) => w.cards.length);
  if (!nonEmpty.length) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const spacedBlock = spacedRepetitionBlock(boxBreakdown, "THIS MONTH'S WEEKLY DECKS");
    const weeksBlock = nonEmpty.map((w) => `— ${w.label}:\n${w.cards.map((c) => `  Q: ${c.front}\n  A: ${c.back}`).join("\n")}`).join("\n\n");
    const makeReq = (maxTokens: number, concise: boolean) => retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          (concise
            ? `Build a CONCISE month-end-review flashcard deck from a student's weekly summary decks — merge ` +
              `near-duplicates across weeks, cover the month's distinct concepts, short precise backs, no ` +
              `worked solutions, no quiz. At most 30 cards. WEIGHT TOWARD what the spaced-repetition signal ` +
              `below marks as never-tested-or-still-"Learning" (box 0-1), not "Known" concepts that are ` +
              `already solid. ${CARD_STYLE_RULE}`
            : `You build a MONTH-END-REVIEW flashcard deck from a student's own weekly summary decks. Merge ` +
              `near-duplicate cards that show up across different weeks into one, and weight the space each ` +
              `concept gets using the spaced-repetition signal below, NOT evenly — but otherwise keep FULL ` +
              `coverage of the month's distinct concepts, don't shrink down to a "highlights only" selection. A ` +
              `month with many weeks of real material should produce a correspondingly large deck, up to 100 ` +
              `cards (a hard product ceiling — monthly decks get double the usual cap since they cover a ` +
              `whole month's material). ` +
              `${CARD_STYLE_RULE}`) },
        { role: "user", content:
          // Same fix as generateWeeklyStudyDeck's identical bug — see that function's own comment.
          `THIS MONTH'S WEEKLY DECKS:\n${weeksBlock}` + spacedBlock +
          `\n\nReturn JSON: {"title": short label for the month's deck (≤8 words), "cards": [{"front": "...", "back": "..."}, ...]}.` },
      ],
    }));
    const res = await makeReq(OUT.studylog, false);
    let out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res.choices[0]?.message?.content || "");
    let result = out ? makeDeck(out, MONTHLY_DECK_CARD_CAP) : { error: "no parseable JSON in the response" };
    let tokens = usageOf(res);
    // FALLBACK: same reasoning as generateDailyStudyCards/generateWeeklyStudyDeck. Quiz split out into
    // generateMonthlyQuiz below — see generateWeeklyStudyDeck's own comment for why bundling it in was
    // making decks land small.
    if (!("deck" in result)) {
      console.log(`${new Date().toISOString()} [ai] generateMonthlyStudyDeck: first attempt unparseable, retrying with a smaller ask`);
      const res2 = await makeReq(5000, true);
      out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res2.choices[0]?.message?.content || "");
      result = out ? makeDeck(out, MONTHLY_DECK_CARD_CAP) : { error: "no parseable JSON in the retry either" };
      const t2 = usageOf(res2);
      tokens = { in: tokens.in + t2.in, out: tokens.out + t2.out, cachedIn: (tokens.cachedIn || 0) + (t2.cachedIn || 0) };
      if (!("deck" in result)) {
        console.log(`${new Date().toISOString()} [ai] generateMonthlyStudyDeck: second attempt also unparseable — ${("error" in result ? result.error : "unknown")}. Raw tail: ${String(res2.choices[0]?.message?.content || "").slice(-300)}`);
        // Preserve EVERY week here (500 chars/card-pair budget instead of slicing the joined block, which
        // in practice meant only the first week or two survived) — see generateWeeklyStudyDeck's identical
        // fix for why. Cap raised 10 → 20 cards.
        const lastResortBlock = nonEmpty.map((w) => `— ${w.label}: ${w.cards.slice(0, 8).map((c) => c.front).join("; ").slice(0, 500)}`).join("\n");
        const res3 = await retryRequest(() => client.chat.completions.create({
          model, max_tokens: 3000, temperature: 0.2, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: languageLine(profile) +
              `Output a flashcard deck directly — no analysis, no reasoning out loud, just the JSON. Cover ` +
              `EVERY week listed below, at least one card each — do not skip any week. Up to 20 cards total, ` +
              `short front/back pairs.` },
            { role: "user", content: `${lastResortBlock}\n\nReturn ONLY: {"title": "...", "cards": [{"front": "...", "back": "..."}, ...]}.` },
          ],
        }));
        out = firstJson<{ title?: string; cards?: { front?: string; back?: string }[] }>(res3.choices[0]?.message?.content || "");
        result = out ? makeDeck(out, MONTHLY_DECK_CARD_CAP) : { error: "no parseable JSON in the last-resort retry either" };
        const t3 = usageOf(res3);
        tokens = { in: tokens.in + t3.in, out: tokens.out + t3.out, cachedIn: (tokens.cachedIn || 0) + (t3.cachedIn || 0) };
        if (!("deck" in result)) {
          console.log(`${new Date().toISOString()} [ai] generateMonthlyStudyDeck: FAILED after all 3 attempts — ${("error" in result ? result.error : "unknown")}. Raw tail: ${String(res3.choices[0]?.message?.content || "").slice(-300)}`);
          return null;
        }
      }
    }
    console.log(`${new Date().toISOString()} [ai] generateMonthlyStudyDeck: ${nonEmpty.length} week(s), ${result.deck.cards.length} cards, ${tokens.in} in / ${tokens.out} out tokens`);
    return { deck: result.deck, tokens };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateMonthlyStudyDeck: EXCEPTION — ${e?.message || e}`);
    return null;
  }
}

/** Companion quiz for the month-end deck — same split-out reasoning as generateWeeklyQuiz. */
export async function generateMonthlyQuiz(weeks: { label: string; cards: { front: string; back: string }[] }[], profile?: Profile): Promise<{ quiz?: TaskQuiz; tokens: { in: number; out: number; cachedIn: number } }> {
  const nonEmpty = weeks.filter((w) => w.cards.length);
  const empty = { tokens: { in: 0, out: 0, cachedIn: 0 } };
  if (!nonEmpty.length) return empty;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const weeksBlock = nonEmpty.map((w) => `— ${w.label}:\n${w.cards.map((c) => `  Q: ${c.front}\n  A: ${c.back}`).join("\n")}`).join("\n\n");
    const res = await retryRequest(() => client.chat.completions.create({
      model, max_tokens: 4000, temperature: 0.3, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: languageLine(profile) +
          `Decide if a multiple-choice quiz is warranted for this month's material: only when there are ` +
          `concepts students commonly confuse with each other, or that genuinely need discriminating between ` +
          `similar-looking answers. If nothing calls for that format, output {"quiz": null} — it is NOT a ` +
          `default add-on. Otherwise 4-10 questions. ${QUIZ_STYLE_RULE}` },
        { role: "user", content: `THIS MONTH'S WEEKLY DECKS:\n${weeksBlock}\n\nReturn JSON: {"quiz": {"title": "...", "questions": [{"q": "...", "options": ["...", ...], "correct": 0, "why": "..."}, ...]} | null}.` },
      ],
    }));
    const out = firstJson<{ quiz?: { title?: string; questions?: any[] } | null }>(res.choices[0]?.message?.content || "");
    const tokens = usageOf(res);
    if (!out?.quiz) return { tokens };
    const qr = makeQuiz(out.quiz);
    return { quiz: "quiz" in qr ? qr.quiz : undefined, tokens };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateMonthlyQuiz: EXCEPTION — ${e?.message || e}`);
    return empty;
  }
}

// ── AI-personalized theme tokens ────────────────────────────────────────────────────────────────────────
// Explicitly requested despite the safety pushback in the approved plan ("never let an autonomous agent
// mutate live code/CSS") — the compromise that keeps the spirit of the request without the actual risk: the
// model NEVER writes or touches a stylesheet. It only proposes values for a small, fixed ALLOWLIST of CSS
// custom properties (colors as hex, radii/sizes as bounded px numbers) as plain JSON. Every value is
// strictly re-validated server-side against format AND range before it's ever stored (see
// validateThemeTokens) — a value that fails validation for ANY reason is dropped silently, never applied
// partially-trusted. Nothing here can inject a selector, a URL, a script, or any CSS beyond "this token
// equals this color/number". Rare and opt-in by design (a Settings button click, not automatic/periodic) —
// cheap and infrequent enough that OUT.theme's budget doesn't need to be stingy. It WAS 500 — far too tight
// for a reasoning model whose hidden reasoning tokens count against max_tokens (see DeepSeek v4 notes
// elsewhere in this file): the model's real JSON output routinely got cut off mid-object before it ever
// finished, firstJson returned null on the unbalanced braces, and the button silently 502'd — "personalize
// my theme" looking broken every time, reported live. Raised to 2000, matching sibling one-shot JSON calls.
/** One-shot, opt-in, best-effort: propose a small personalized palette from a short account summary. Empty
 *  result (never throws) on ANY failure — the caller falls back to the current theme unchanged. */
export async function generateThemeTokens(summary: string, profile?: Profile): Promise<{ tokens: ThemeTokens; tokensUsed: { in: number; out: number; cachedIn: number } }> {
  const empty = { tokens: {}, tokensUsed: { in: 0, out: 0, cachedIn: 0 } };
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model, max_tokens: OUT.theme, temperature: 0.5, response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          trackLine(profile) +
          `Propose a small personalized color/shape palette for a calm, minimal study app, based on this ` +
          `student's own usage pattern. Output ONLY hex colors and pixel radii for these exact keys — nothing ` +
          `else, no explanation: "--bg" (page background, hex), "--surface" (card background, hex, close in ` +
          `lightness to --bg — this is a subtle, not a loud, distinction), "--bg-2" (a third subtle fill), ` +
          `"--line" (hairline border/divider color, hex — subtle, a touch more visible than --bg but still ` +
          `quiet, never a strong outline), "--radius" (main corner radius, 8-20px), "--radius-sm" (6-14px), ` +
          `"--radius-xs" (4-9px). Keep colors LIGHT and desaturated (this is a light-mode paper/ink aesthetic, ` +
          `not a dark or vivid theme) — think subtle warm/cool off-whites, never a saturated or dark color. ` +
          `If the summary mentions the student is mostly active in the evening/night, you may lean the palette ` +
          `subtly cooler/dimmer WITHIN that same light constraint (never actually dark) — a small, tasteful ` +
          `nod, not a different theme. If it mentions weak/struggling subjects, prefer LOWER contrast-variance ` +
          `between --bg/--surface/--bg-2 (a calmer, less busy-feeling desk) rather than a more energetic one. ` +
          `Do not explain your reasoning.` },
        { role: "user", content: `Student's recent usage pattern:\n${summary.slice(0, 800)}\n\nReturn JSON: {"--bg": "#......", "--surface": "#......", "--bg-2": "#......", "--line": "#......", "--radius": "..px", "--radius-sm": "..px", "--radius-xs": "..px"}.` },
      ],
    }));
    const raw = firstJson<Record<string, string>>(res.choices[0]?.message?.content || "");
    const tokens = validateThemeTokens(raw);
    return { tokens, tokensUsed: usageOf(res) };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] generateThemeTokens: EXCEPTION — ${e?.message || e}`);
    return empty;
  }
}
