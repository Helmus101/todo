
import type { Profile, TaskStep, TaskLink, Sendable, TaskNote, TaskFlashcards, TaskQuiz, TaskType, InfoRequirement, TaskArtifact, SeparateTask } from "../../shared/types.ts";
import { dedupeFacts, sameFact, tzOf } from "../../shared/types.ts";
import type { AgentTools } from "../integrations.ts";
import { webSearch } from "../websearch";
import { AcademicContext, AuditEvent, academicBlock, assignmentBlock, errorLogLine, isBigIbProject, languageLine, learningStyleLine, notNeededLine, nowBlock, personalContextLine, profileBlock, recentJournalLine, studentModelLine, syllabusGroundingLine, taskNeedsStepList, trackLine, weakCardLine } from "./context.ts";
import { DEEPSEEK_MODEL, OUT, countWords, deepseekClient, firstJson, retryRequest } from "./client.ts";
import { courseworkLine } from "./coursework.ts";
import { runWebSearch } from "./tools.ts";
import { DOABLE_STEP, EXECUTION_ENABLED, JUDGMENT_STEP, OTTO_INTERNAL_STEP, STUDY_TASK_TYPES, THIRD_PERSON_STUDENT_STEP, anchorStepsToTask, bestMatchingStep, canonicalUrl, dodLooksLikeCoordinationOutcome, dropForeignEntityLinks, dropForeignEntitySteps, dropOffTopicStudySteps, dropProcessComplaintSteps, dropRedundantArtifactSteps, dropSiblingBleedSteps, dropTrivialSteps, dropUnanchoredSteps, ensureArtifactUseSteps, hasDomainContamination, isFolderHousekeepingDrift, reattachStepExtras, restrictStepUrlsToLinks, sanitizeStepExtras, sanitizeSteps, separateArtifactsFromSteps, stepsMatchTitle, titleKeywords, truncateStepText } from "./steps.ts";
import { recommendArtifactType } from "./scheduling.ts";
import { BRIEF_COMPRESS_WORDS, makeDeck, makeNote, makeQuiz } from "./board.ts";

// Manual-add and sweep-generated tasks are both planned by the single `runTask()` agent below (see
// enqueueJob("execute_task") callers) — it already reads every connected integration (Gmail, Calendar,
// Drive, Slack, GitHub, Notion, ...) plus web_search and produces task.context/task.steps. A separate
// web-search-only enrichment pass used to run here too (generateBrief/enrichManualTask); it was removed
// because it duplicated runTask with strictly less context (no integrations) and produced a second,
// disconnected "next steps" list next to the real one.

export interface ProfileUpdate { category: "name" | "about" | "preference" | "person" | "project" | "course"; fact: string; }

export interface RunOutput {
  context: string;
  synthesis: string;
  did: string[];              // concrete past-tense bullets — one per action actually performed
  steps: TaskStep[];
  links: TaskLink[];          // the artifacts it made this run (draft / doc / sheet / event / issue), so the user can open them
  sendables: Sendable[];      // drafted email / composed Slack message the user can fire with one click
  profileUpdates: ProfileUpdate[];
  followUps?: { title: string; why: string }[]; // distinct NEW obligations discovered → each becomes its own task
  tokens?: { in: number; out: number; cachedIn?: number }; // cost telemetry — recorded on the task's timeline per run
  /** Doc/Sheet/Slide ids VERIFIED created THIS run, from real tool results — never from the model's
   *  self-reported "links" (nothing stops it claiming a doc it merely read, not created). This is the
   *  guardrail input for extractArtifacts(): only ids in here may ever be edited without the user's
   *  explicit approval on a later revision — "Otto may only edit what Otto created," enforced, not assumed. */
  createdDocIds?: string[];
  /** What Otto actually did this run, verified against real tool calls — see WebTask.audit. */
  audit?: AuditEvent[];
  /** A tightened title for a raw user-typed task (source==="manual" only) — set ONLY when the model actually
   *  refined it; runById applies it to task.title. Replaces the old separate "refine before queueing" pass:
   *  the title now gets crisped as a side effect of the SAME run that does the work, instead of a distinct
   *  step the user had to wait through before anything started. */
  title?: string;
  /** In-app briefs (CREATE_NOTE) created THIS run — verified (a real tool call each), persisted onto
   *  WebTask.notes and rendered as a popup button on the card instead of an external doc. */
  notes?: TaskNote[];
  /** In-app flashcard decks (CREATE_FLASHCARDS) created THIS run — verified, persisted onto
   *  WebTask.flashcards and rendered as a drillable popup on the card. */
  flashcards?: TaskFlashcards[];
  /** In-app MCQ quizzes (CREATE_QUIZ) created THIS run — verified, persisted onto WebTask.quizzes. */
  quizzes?: TaskQuiz[];
  /** The model's OWN judgment, from the same call that did the actual research — not a keyword guess on
   *  the title — that this is a big multi-week/multi-stage project (a full essay, an IB EE/TOK/CAS/IA, a
   *  dissertation) that needs a milestone breakdown rather than a flat step list. Threaded into
   *  writeStepsFromContext so a task with real signal for this (genuinely large, but never named an
   *  acronym and has nothing to research — so the keyword pre-filter AND the empty-context bail would
   *  otherwise both miss it) still gets the milestone treatment. */
  isBigProject?: boolean;
  /** The smallest possible first move on this task (the anti-procrastination hook) — see FIRST ACTION in
   *  runTask's own step-4 prompt. Validated in finalize() the same way a step's text/minutes are. */
  firstAction?: { text: string; minutes?: number };
  taskType?: TaskType;
  goal?: string;
  infoRequirement?: InfoRequirement;
  unknowns?: string[];
}

export const REMEMBER_TOOL = { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'name' (what to call them — save it the moment you learn their name, e.g. from their email signature or how others address them; fact = just the name), 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), 'course' (a class/course-specific pattern that should compound over the term/degree — a professor's grading style or communication quirks, how far ahead of THIS course's deadlines the student actually starts work, what kind of feedback they got, e.g. 'BIO 201 — Prof. Martinez wants a topic sentence in every paragraph' or 'Starts CS 101 problem sets ~2 days before due and it stresses them out'), 'about' (a one-line summary of them), or 'session' (a short recap of what just happened THIS session — call this once, right as a session wraps up: the student is leaving, the task is done, or the conversation has clearly reached a natural stopping point. fact = subject + what was worked on + where they landed + what's still shaky, e.g. 'Physique — worked SUVAT for projectile motion, landed the range calculation; still mixing up which component stays constant.' This is what makes a LATER session, possibly on a different task, pick up like you remember them instead of starting cold — so write it from THIS session's actual content, never a generic 'studied physics').", input_schema: { type: "object", properties: { category: { type: "string", enum: ["name", "about", "preference", "person", "project", "course", "session"] }, fact: { type: "string" } }, required: ["category", "fact"] } };

/** Same write path as tasks.ts's applyProfileUpdate (that function can't be imported here — tasks.ts
 *  already imports FROM claude.ts, so importing back would be a circular value dependency) — same caps,
 *  same "newest wording of a fact replaces the old one" dedup via sameFact/dedupeFacts. Kept in sync
 *  manually; if one changes (a new cap, a new category), so should the other. */
export function applyRememberFact(profile: Profile, category: string, fact: string): void {
  const f = fact.trim();
  if (!f) return;
  if (category === "name") { profile.name = f.slice(0, 60); return; }
  if (category === "about") { profile.about = f.slice(0, 400); return; }
  if (category === "person" && profile.name && f.toLowerCase().includes(profile.name.toLowerCase())) return;
  // "session" is append-only, newest-last, capped at 30 — NOT deduped like the others (see its field
  // comment in shared/types.ts): each entry is a snapshot of one specific session, so a later session that
  // happens to read similarly must not silently overwrite an earlier, genuinely different one.
  if (category === "session") { profile.sessions = [...(profile.sessions || []), f.slice(0, 280)].slice(-30); return; }
  const key = category === "preference" ? "preferences" : category === "person" ? "people" : category === "course" ? "courses" : "projects";
  const fact160 = f.slice(0, 160);
  const list = (profile as any)[key] as string[] | undefined;
  const rest = (list || []).filter((x) => !sameFact(x, fact160));
  (profile as any)[key] = dedupeFacts([...rest, fact160]);
}

/** Extra pacing guidance for step creation, from the student's measured focus (Study Mode camera stats). */
function focusAdaptiveInstructions(profile: Profile | undefined, task: { sourceSubject?: string }): string {
  const focusStats = profile?.focusStats;
  const subjFocus = (task.sourceSubject && focusStats?.subjectFocus) ? focusStats.subjectFocus[task.sourceSubject] : undefined;
  const focusLevel = subjFocus ?? focusStats?.avgConcentration ?? 100;
  const isLowFocus = focusLevel < 50;
  const isUnstableFocus = focusStats?.focusStability === "unstable" || focusStats?.focusStability === "highly_variable";
  const peakHour = focusStats?.peakFocusHour;
  const currentHour = new Date().getHours();
  const isPeakTime = peakHour !== undefined && Math.abs(currentHour - peakHour) <= 1;
  const subjectRestless = (task.sourceSubject && focusStats?.subjectFocus) ? 
    (focusStats.subjectFocus[task.sourceSubject] < 50) : false;

  let adaptiveInstructions = "";
  if (isLowFocus) {
    adaptiveInstructions += `\nADAPTIVE PACING (Low Focus Baseline ${Math.round(focusLevel)}%): Keep steps very short (5-15 mins max per step), low initial difficulty, with explicit checkpoint criteria to sustain momentum.\n`;
  }
  if (isUnstableFocus) {
    adaptiveInstructions += `FOCUS STABILITY: Focus fluctuates frequently - include more frequent checkpoints and break steps into smaller chunks to maintain momentum.\n`;
  }
  if (!isPeakTime && peakHour !== undefined) {
    adaptiveInstructions += `TIMING: Current time (${currentHour}:00) is not peak focus hour (${peakHour}:00) - consider scheduling this task for ${peakHour}:00 for best results.\n`;
  }
  if (subjectRestless) {
    adaptiveInstructions += `SUBJECT PATTERN: This subject typically shows lower focus - include more engaging, interactive steps and consider shorter duration.\n`;
  }
  return adaptiveInstructions;
}

/**
 * Run a task as a bounded tool-using agent over the user's CONNECTED apps (Composio): it gathers facts and
 * does the reversible work (drafts, docs, tasks, updates) itself, then submits a context + synthesis + the
 * steps that are LEFT. Irreversible sends/deletes are never available to it. Also returns durable profile facts.
 */
export async function runTask(
  task: {
    title: string;
    why: string;
    source?: string;
    links?: TaskLink[];
    artifacts?: { kind: string; id: string; url?: string; label?: string }[];
    sourceDetail?: string;
    sourceSubject?: string;
    sourceDue?: string;
    taskType?: TaskType;
    goal?: string;
    infoRequirement?: InfoRequirement;
    unknowns?: string[];
    // Existing flashcards on this task (a re-run/revision, not a first pass) — lets weakCardLine flag cards
    // this student is still shaky on, same signal chat already gets. Empty/absent on a genuinely first run.
    flashcards?: TaskFlashcards[];
  },
  profile?: Profile,
  focus?: string,
  extras?: AgentTools,
  academic?: AcademicContext,
  siblingTasks?: { title: string; why?: string }[],
  // Same personalization signals chatAboutTask's dynamicContext already assembles (learningStyleLine,
  // errorLogLine, weakCardLine, recentJournalLine) — until this was wired in, ONLY a conversation the
  // student initiated got the full picture; the notes/steps/flashcards/quizzes Otto generates unprompted
  // (the actual output of the "proactive" mission) knew none of it. Optional/best-effort: every one of
  // these lines degrades to "" silently when the signal isn't available (cold start, no sibling-task list
  // to compute a trend from, etc.), matching how chat already treats them.
  personalization?: { subjectSignal?: { correctRate: number; attempts: number; trend?: "up" | "down" | "flat" }; recentJournal?: { date: string; text: string; subjects?: string[] }[]; journalMeta?: { total: number; subjects: Record<string, number> }; notNeeded?: string[]; inApp?: string },
): Promise<RunOutput> {
  // ── 5-STEP EXECUTION PIPELINE ──────────────────────────────────────────────
  // Once we have the task + definition of done, execution follows this order:
  //   1. Ask the AI which available tools are most useful → pick them
  //   2. Ask the AI what searches to run → run them → look at results → ask for follow-up
  //      searches → run those → gather all context
  //   3. Ask the AI what information could be useful → come up with a few ideas
  //   4. With all context in hand, ask the AI to create small, minimal, actionable steps
  //   5. Ask the AI whether an artifact (quiz/flashcard) is necessary → only if YES
  // The order is a guideline, not a rigid checklist — the AI can skip a step that doesn't
  // apply (e.g. no web searches needed for a simple task), but it always goes top-to-bottom.
  const fr = profile?.language === "fr";
  const definitionOfDone = task.goal || task.why;
  const client = deepseekClient();
  const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;

  let tokIn = 0;
  let tokOut = 0;
  // Total-outage detection: ask() deliberately never throws (a single failed call shouldn't break the
  // whole pipeline — see its own comment), which means a COMPLETE AI outage for this entire run previously
  // fell through silently: every ask() call returned {}, but runTask still built and returned a normal-
  // looking RunOutput (a one-step fallback, an "Error during analysis. Retry." synthesis) instead of
  // throwing — server/tasks.ts's aiRun then took the SUCCESS path (task.status = "needs_review"), never
  // the failure path that feeds jobs.ts's actual attempt-count/backoff/retry machinery. A sweep-time outage
  // produced a batch of tasks stuck at needs_review with garbage content, indistinguishable in state from a
  // genuinely completed run, with no automatic retry. Tracked here and checked right before the final
  // return — if every single ask() call in this run failed, throw for real instead of pretending to succeed.
  let askCalls = 0;
  let askFailures = 0;
  let context = "";
  let links: TaskLink[] = [];
  let notes: TaskNote[] = [];
  let flashcards: TaskFlashcards[] = [];
  let quizzes: TaskQuiz[] = [];
  let did: string[] = [];
  const audit: AuditEvent[] = [];

  // `focus` carries the caller's scoping for THIS run: a student's revision request on a draft ("redo it with
  // this change"), the granularity bandit's "smaller steps" arm (server/tasks.ts runById), and — for a
  // single-step run (runStep) — which step to do, what's already decided, and the student's answer to that
  // step's own question. It was accepted as a parameter and then never read anywhere in this function, so
  // all three silently did nothing: revisions re-produced the same output, the granularity arm measured
  // noise, and a "do this one step" run planned the whole task again instead. In baseCtx so every ask()
  // (research, steps, artifacts) sees it.
  const focusBlock = focus?.trim()
    ? `\nFOCUS FOR THIS RUN — this is what the run is actually for; where it conflicts with the general plan, it wins:\n${focus.trim().slice(0, 1500)}\n`
    : "";
  const baseCtx = profileBlock(profile) + assignmentBlock(task, tzOf(profile)) + academicBlock(academic) + (personalization?.inApp || "") + focusBlock;
  const langLine = languageLine(profile) + courseworkLine(profile, task.sourceSubject) + trackLine(profile) + syllabusGroundingLine(profile, task.sourceSubject) + personalContextLine(profile) + studentModelLine(profile) +
    learningStyleLine(profile) + errorLogLine(profile, task.sourceSubject, personalization?.subjectSignal) +
    recentJournalLine(personalization?.recentJournal, task.sourceSubject, personalization?.journalMeta) + weakCardLine(task) + notNeededLine(personalization?.notNeeded);
  const nowLine = nowBlock();

  /** Helper: one JSON chat call, accumulates tokens. Retries ONCE on truncation (finish_reason "length" OR
   *  a parse failure on a genuinely non-empty response) with a bumped budget and a "be more concise"
   *  instruction — DeepSeek v4's hidden reasoning tokens count against max_tokens (see OUT's own comment
   *  elsewhere in this file), so a tight budget can silently eat the whole thing before any visible JSON
   *  comes out, especially for a JSON-array-of-objects response (steps, each with several fields) rather
   *  than a short list of strings. Without this retry, a truncated response just returned {} — reported
   *  live as a task ending up with a single generic "Continue working on: X" step instead of the real plan,
   *  the exact failure the caller's OWN fallback-for-empty-array branch exists to catch, but shouldn't need
   *  to reach nearly this often. */
  async function ask(prompt: string, maxTokens: number): Promise<any> {
    askCalls++;
    const attempt = async (tokens: number, extraInstruction: string): Promise<{ parsed: any; truncated: boolean } | null> => {
      const res = await retryRequest(() => client.chat.completions.create({
        model, max_tokens: tokens, temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt + baseCtx + extraInstruction + langLine + nowLine }],
      }));
      tokIn += res.usage?.prompt_tokens || 0;
      tokOut += res.usage?.completion_tokens || 0;
      const content = String(res.choices?.[0]?.message?.content || "");
      const truncated = res.choices?.[0]?.finish_reason === "length";
      const parsed = firstJson<any>(content);
      if (!parsed) {
        // Truncated preview only — never the full content. This can be a student's real task details/
        // personal context; logging it unbounded to Vercel's log aggregator (retained, searchable, visible
        // beyond just this process) is a real exposure, not just noise, for zero extra diagnostic value
        // over the 500-char preview already here.
        console.error(`${new Date().toISOString()} [ai] ask failed to parse JSON${truncated ? " (truncated — finish_reason: length)" : ""}. Content: ${content.slice(0, 500)}`);
        return { parsed: null, truncated };
      }
      return { parsed, truncated };
    };
    try {
      // DeepSeek v4 is a reasoning model: its hidden reasoning counts against max_tokens, so the small per-call budgets
      // truncated EVERY step on the first try (verified live: all 7 steps of one run retried) — doubling a task's run
      // time. max_tokens is a ceiling, not a charge, so a real floor on the first attempt costs nothing extra.
      const first = await attempt(Math.max(maxTokens, 8000), "");
      if (first?.parsed && !first.truncated) return first.parsed;
      if (first?.parsed && first.truncated) return first.parsed; // valid JSON that still fits — use it, no need to retry
      // Either unparseable, or cut off before any JSON closed — retry ONCE with real headroom (2.5x, floor
      // 2000) and an explicit steer toward brevity, so the retry is less likely to hit the SAME ceiling.
      console.log(`${new Date().toISOString()} [ai] ask retrying with a larger budget after truncation/parse failure`);
      const second = await attempt(Math.max(maxTokens * 2.5, 16000), "\n\nBe concise — short phrases, no extra commentary. Fit your ENTIRE answer well within the token budget.");
      if (!second?.parsed) askFailures++;
      return second?.parsed || {};
    } catch (err: any) {
      console.error(`${new Date().toISOString()} [ai] ask error: ${err?.message || err}`);
      console.error(`${new Date().toISOString()} [ai] error stack: ${err?.stack || "no stack"}`);
      // Return empty object instead of throwing to avoid breaking the entire pipeline
      askFailures++;
      return {};
    }
  }

  try {
    console.log(`${new Date().toISOString()} [ai] runTask starting: "${task.title}"`);
    
    // ── STEP 1: Which tools are most useful? ────────────────────────────────
    console.log(`${new Date().toISOString()} [ai] step 1: asking for useful tools`);
    const availableToolNames = extras?.tools?.map((t) => t.name).filter(Boolean) || [];
    const allTools = [...new Set([...availableToolNames, "web_search"])]; // web_search is always available
    // With no connected integrations the only tool on offer is web_search — asking a reasoning model to
    // "pick the most useful of: web_search" is a pure wasted round-trip (seconds of latency per task, the
    // common case for a student who hasn't connected anything). Only ask when there's an actual choice.
    const toolsOut = allTools.length > 1 ? await ask(
      `You are helping a student with this task.\n` +
      `TASK: "${task.title}"\n` +
      `WHY: "${task.why}"\n` +
      `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
      `AVAILABLE TOOLS: ${allTools.join(", ")}\n` +
      `Tools include web search and any connected integrations (Gmail, Calendar, Drive, Notion, etc.).\n\n` +
      `Which of these tools would be MOST useful for completing this task? ` +
      `Pick only the ones that genuinely help — don't list everything. ` +
      `Return JSON: {"usefulTools": ["tool1", "tool2"], "reason": "brief why"}`,
      // 250 was verified live to truncate before any JSON closed (DeepSeek v4's hidden reasoning tokens eat
      // into max_tokens regardless of how small the actual output is — see ask()'s own comment). Even this
      // tiny payload needs real headroom.
      600,
    ) : { usefulTools: ["web_search"] };
    const usefulTools: string[] = toolsOut.usefulTools || [];
    console.log(`${new Date().toISOString()} [ai] step 1 result: usefulTools=${usefulTools.join(",")}`);
    if (!usefulTools.length) {
      console.warn(`${new Date().toISOString()} [ai] step 1: no tools selected, using default (web_search)`);
    }
    if (usefulTools.length) audit.push({ at: new Date().toISOString(), kind: "tool", label: `tools: ${usefulTools.join(", ")}` });

    // ── STEP 2: What searches to run? → run → look at results → follow-up ────
    // First round: ask the AI what searches to do.
    console.log(`${new Date().toISOString()} [ai] step 2: asking for searches`);
    const searchesOut = await ask(
      `You are helping a student with this task.\n` +
      `TASK: "${task.title}"\n` +
      `WHY: "${task.why}"\n` +
      `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
      `USEFUL TOOLS SELECTED: ${usefulTools.join(", ") || "none"}\n\n` +
      `What web searches should be performed to gather the context needed for this task? ` +
      `Each query should target ONE specific missing fact or piece of context — not a vague topic. ` +
      `For an academic task, search for the NOTION (the topic itself, how it's taught/tested at this level), ` +
      `never the answer to the student's own exercise. ` +
      `For a task whose definition of done calls for an actual produced list/comparison of real-world ` +
      `options (activities, places, products, providers, sources) — NOT an academic exercise — the searches ` +
      `must be specific enough to come back with real, nameable candidates: one query per distinct sub-area ` +
      `or category, not one broad query for the whole thing. A single vague query ("things to do in Oslo") ` +
      `returns too little to actually build a curated list from; several targeted ones ("best museums Oslo", ` +
      `"outdoor winter activities Tromsø") do. Go up to the full 5 when the definition of done genuinely ` +
      `needs that much real material — don't under-search a task that needs a real list just to stay terse.\n` +
      `RESOLVE WHAT THE TASK LEAVES UNNAMED. If the task or its definition of done points at something ` +
      `without naming it — "the items still left", "the book", "the form", "the remaining questions" — the ` +
      `specifics are in the source material further down this message (the email, the Pronote assignment). ` +
      `Read them out of there and search for THOSE, not for the vague phrase. Never search the vague phrase ` +
      `itself: a query like "items still left" returns nothing usable and leaves the whole task generic.\n` +
      `IF THE TASK MEANS OBTAINING SOMETHING REAL — buying a book or product, booking travel or a ticket, ` +
      `applying, or downloading an official document — then searching for where to actually get it is part ` +
      `of the job: the exact edition/version named, what it currently costs, and a real page to buy or book ` +
      `it from. A step that says "order the Actes Sud Babel edition" with no link behind it just hands the ` +
      `research back to the student.\n` +
      `Return 1-5 search queries. If no web search is needed, return an empty array.\n` +
      `Return JSON: {"searches": ["query 1", "query 2"]}`,
      600, // same truncation risk as step 1's budget — see that comment
    );
    let searches: string[] = searchesOut.searches || [];
    console.log(`${new Date().toISOString()} [ai] step 2 result: ${searches.length} searches`);

    // Run the first round of searches and gather results.
    const allSearchResults: { query: string; results: { title: string; url: string; snippet?: string }[] }[] = [];
    let searchesAttempted = 0;
    for (const query of searches) {
      searchesAttempted++;
      try {
        const raw = await runWebSearch({ query });
        const parsed = JSON.parse(raw) as { title: string; url: string; snippet?: string }[];
        allSearchResults.push({ query, results: parsed });
        audit.push({ at: new Date().toISOString(), kind: "tool", label: `web_search: ${query}` });
      } catch { /* a failed search is not fatal */ }
    }

    // Look at the results and ask the AI if follow-up searches are needed.
    if (allSearchResults.length) {
      const resultsSummary = allSearchResults.map((r) =>
        `Query: "${r.query}"\n${r.results.slice(0, 3).map((x) => `- ${x.title}: ${x.snippet || x.url}`).join("\n")}`,
      ).join("\n\n");

      const followUpOut = await ask(
        `You are helping a student with this task.\n` +
        `TASK: "${task.title}"\n` +
        `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
        `SEARCH RESULTS SO FAR:\n${resultsSummary}\n\n` +
        `Based on these results, are there any FOLLOW-UP searches that would help? ` +
        `Look for new entities, names, dates, or gaps that surfaced and need a targeted search. ` +
        `If the results are sufficient, return an empty array.\n` +
        `Return JSON: {"searches": ["query 1", "query 2"]}`,
        600, // same truncation risk as step 1's budget — see that comment
      );
      const followUps: string[] = followUpOut.searches || [];

      for (const query of followUps.slice(0, 3)) { // cap follow-ups to avoid runaway loops
        searchesAttempted++;
        try {
          const raw = await runWebSearch({ query });
          const parsed = JSON.parse(raw) as { title: string; url: string; snippet?: string }[];
          allSearchResults.push({ query, results: parsed });
          audit.push({ at: new Date().toISOString(), kind: "tool", label: `web_search: ${query}` });
        } catch { /* */ }
      }
    }

    // Build the context string from all search results.
    if (allSearchResults.length) {
      const parts = allSearchResults.map((r) =>
        `[${r.query}]\n${r.results.slice(0, 4).map((x) => `- ${x.title}${x.snippet ? ` — ${x.snippet.slice(0, 200)}` : ""} (${x.url})`).join("\n")}`,
      );
      context = `Web research:\n${parts.join("\n\n")}`;
      // Collect useful links from search results.
      for (const r of allSearchResults) for (const x of r.results.slice(0, 2)) {
        if (x.url && !links.some((l) => l.url === x.url)) {
          links.push({ label: x.title.slice(0, 60), url: x.url });
        }
      }
      // Keep research links scarce and task-specific; the card should not become a bibliography.
    // Relevance gate, same reasoning as finalize()'s link check below: a web_search's results are only
    // candidates. Reported live: a "download your Ledger OP3N ticket" task carrying a Mailchimp marketing
    // page and a "Sell tickets with Luma" pricing page — the search engine's loose keyword match surfaced
    // them and they sailed onto the card. A link that shares no real word (4+ chars) with the task's own
    // title/why/definition of done is noise, however real the URL. Only applied when there IS a usable
    // word set (a very short title would over-filter); worst case = old behavior.
    const linkAllowWords = new Set(`${task.title} ${task.why} ${definitionOfDone}`.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || []);
    links = links
      .filter((link, index, all) => all.findIndex((other) => canonicalUrl(other.url) === canonicalUrl(link.url)) === index)
      .filter((link) => {
        if (linkAllowWords.size < 2) return true;
        const linkWords = `${link.label} ${link.url}`.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
        return linkWords.some((w) => linkAllowWords.has(w));
      })
      .slice(0, 3);
    }
    // Distinguish "no search needed" from "search attempted and totally failed" — without this, context
    // stays the exact same "(no external context)" string step 4 sees either way, so its grounding rule
    // (claude.ts step-4 prompt) has nothing to act on and can't tell a legitimately-skipped search from
    // one that failed outright, silently letting step 4 invent specifics for a DoD that needed real facts.
    const totalSearchResults = allSearchResults.reduce((n, r) => n + r.results.length, 0);
    if (searchesAttempted > 0 && totalSearchResults === 0) {
      audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `web search: ${searchesAttempted} quer${searchesAttempted === 1 ? "y" : "ies"} attempted, 0 results — steps may be under-grounded` });
      context = `${context ? `${context}\n\n` : ""}NOTE: web search was attempted for this task but returned no results — do not treat this as "no search was needed." If the definition of done requires real gathered facts, say so plainly rather than inventing them.`;
    }

    // ── STEP 3: What information could be useful? ───────────────────────────
    console.log(`${new Date().toISOString()} [ai] step 3: asking for useful information`);
    const infoOut = await ask(
      `You are helping a student with this task.\n` +
      `TASK: "${task.title}"\n` +
      `WHY: "${task.why}"\n` +
      `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
      `${context ? `CONTEXT GATHERED SO FAR:\n${context}\n\n` : ""}` +
      `What information would be useful for the student to have to achieve this definition of done? ` +
      `Come up with a few ideas — things they should know, understand, or have ready. ` +
      `Be concrete and specific to THIS task, not generic advice. ` +
      `Return JSON: {"info": ["idea 1", "idea 2", "idea 3"]}`,
      800, // same truncation risk as step 1's budget — see that comment
    );
    const usefulInfo: string[] = infoOut.info || [];
    console.log(`${new Date().toISOString()} [ai] step 3 result: ${usefulInfo.length} info items`);
    if (usefulInfo.length) {
      context += `${context ? "\n\n" : ""}Useful information to have:\n${usefulInfo.map((i) => `- ${i}`).join("\n")}`;
    }

    // ── STEP 4: Create small, minimal, actionable steps ─────────────────────
    console.log(`${new Date().toISOString()} [ai] step 4: creating steps`);
    const adaptiveInstructions = focusAdaptiveInstructions(profile, task);

    const stepsOut = await ask(
      `There is this task: "${task.title}".\n` +
      `The user wants to have this definition of done: ${definitionOfDone}\n\n` +
      `Based on all this information:\n${context || "(no external context was needed — plan from the task itself)"}\n\n` +
      `Create small, minimal, actionable steps to help the user achieve this.
` +
      `SIZE THE PLAN TO THE TASK — steps are OPTIONAL, not the default output shape:\n` +
      `- SMALL, SINGLE-SESSION task (an errand, a download, a form, a booking, one short drill — doable in one sitting): NO step list. One useful artifact only if genuinely needed, plus a tiny first action. A step list on a 5-minute errand is clutter, not structure.\n` +
      `- MULTI-DAY or ASSESSMENT-PREP work: 3-4 short, scannable steps, each anchored to a part of the Definition of Done.\n` +
      `- GENUINELY COMPLEX PROJECT (multi-week, multi-stage): the full breakdown, capped at 8 steps / milestones.\n` +
      `RULES:\n` +
      `- Each step, when you write one, is a SHORT concrete one-liner (≤10 words). Each step is ONE single action, not a broad category.\n` +
      `- Break the work into INDIVIDUAL steps — never one big step with sub-steps. If you're tempted to write a step like "Review chapter 5" that's really several things, write each thing as its own step instead.\n` +
      `- SEQUENCE STEPS IN THE ORDER THE STUDENT WILL ACTUALLY DO THEM. Before writing the list, ask of every step: what must already be true for the student to be able to start this one? That prerequisite step goes FIRST. Two forms of this keep going wrong live:\n` +
      `  (a) REACTING TO AN ATTEMPT. A step that reacts to, reviews, or repeats based on an attempt (retake, log mistakes, fix what was wrong, redo until clean) can only come AFTER the step where that attempt actually happens. Reported live: a "reach a clean run on an MCQ set" task generated step 1 as "Log missed items, then retake until no unresolved misses" and step 2 as "Sit a timed set" — backwards, since there's nothing to log or retake before a first attempt has happened.\n` +
      `  (b) SETTLING WHAT THE LATER WORK OPERATES ON. A step that decides the scope, dates, list, or selection that a later step then acts on must come BEFORE that later step. Reported live: a trip task generated step 1 as "Book transport and lodging" and step 2 as "Fix trip dates against the school calendar" — you cannot book before the dates are settled. Same failure on a revision task: "Build flashcards for each figure" before "Mark the 15 figures you'll actually be tested on".\n` +
      `- ONE DELIVERABLE PER STEP. If a step names two or more separate things to produce or do, it is not one step — split it. Reported live: "Book transport and lodging, draft itinerary and packing list" is FOUR steps crammed into one, and a student reading it cannot tell what "done" means or tick it off honestly.\n` +
      `- Only steps the STUDENT must do (decisions, physical actions, logins, review, practice, solving).\n` +
      `- GROUNDING — DO NOT INVENT: every specific name, place, price, date, or option a step mentions MUST actually appear in the CONTEXT above. If the context doesn't name it, the step can't either — no exceptions, even for something that sounds plausible or that you know to be real from general knowledge. A step about a real-world place/attraction/product you weren't actually handed research on is a fabrication, not a shortcut.\n` +
      `- Never include research/search steps IF the context above already contains enough concrete, specific material to satisfy the definition of done. But check that first: if the definition of done asks for a produced list/comparison/shortlist of real specific options (activities, sources, products, providers) and the context above is thin, generic, or missing that — a handful of search queries and a paragraph of vague summary is NOT the same as an actual curated list — then the FIRST steps must be genuine research/compilation steps that actually build that list, not steps that assume it already exists. Skipping straight to refinement steps (filtering, tagging, comparing) when there's nothing concrete yet to filter/tag/compare produces a step list that can't reach the definition of done at all.\n` +
      `- Never include artifact-creation steps (flashcards/quiz/note creation — that's handled separately).\n` +
      `- COVER THE DEFINITION OF DONE'S OWN PARTS: identify its distinct sub-requirements (usually separated by commas/"and"/semicolons — e.g. "purpose, dates, travellers, transport and accommodation booked, and any required documents identified" is FIVE separate things, not one) and make sure the step list, together, actually addresses every one of them. A step list that looks plausible but silently leaves a named part of the definition of done untouched is incomplete, not just short — go back and add the missing step rather than padding an already-covered part.\n` +
      `- Match the plan's size to the task's real complexity: zero steps for a single-session task (just a first action), 3-4 for multi-day/assessment prep, at most 8 for a genuinely complex project. Never pad to look thorough. Fewer is better. If one honest attempt (a diagnostic step) would tell the student where they actually stand, that can be the ENTIRE plan — don't manufacture a longer one just to look thorough.\n` +
      `- STEP QUALITY — for every step, internally check (never expose this checklist in the wording): can they start it immediately with no further planning? Is the action concrete with a clear object? Does it produce something, or just consume time? Will they know when it's actually finished? "Review chapter" fails this (can't tell when done, no output); "Explain each of the three laws in one sentence from memory, no notes" passes (concrete, self-checking, produces something). Write it as a normal sentence, not a template — just make sure the substance answers all four questions.\n` +
      `- FIRST STEP MUST BE STARTABLE RIGHT NOW. Reject a first step like "Research the topic", "Review everything", "Prepare for the test", or "Figure out what to do" unless research/review genuinely IS the whole task — prefer a first move that reduces uncertainty or produces the first real piece of work (for "prepare for tomorrow's test": not "review everything" but "answer five questions from memory covering the main topics, no notes, and see what's actually still shaky").\n` +
      `- WHEN MASTERY IS GENUINELY UNCERTAIN (a review/exam-prep/understanding-check task, not a known-quantity logistics task), prefer a step that MEASURES where the student actually stands before one that assumes they need to relearn everything from scratch.\n` +
      `- NAME THE CONCRETE CUE. Plans with a specific "with what / where" are followed 2-3x more often than vague ones (implementation-intentions research) — "Open your cahier to the Fanon text and underline 3 dates" beats "Read about Fanon". Name the actual material, page, document, deck or site the student opens, whenever the context gives it.\n` +
      `- FEWER, SHARPER STEPS BEAT MORE, VAGUER ONES. A short list of well-specified steps outperforms a long list of loose ones — if a step can't be made specific, cut it rather than keep it vague.\n` +
      `- IF OTTO ALREADY HAS SOMETHING FOR THIS (see WHAT OTTO ALREADY HAS IN-APP above, when present), a step should USE it — open the existing fiche, drill the weak cards in the existing deck, retake the quiz — never propose recreating it, and never re-propose a step already done.\n` +
      `- "minutes" on EVERY step: a realistic estimate for THIS student to finish it (1-240). Be honest, not optimistic — a step that says 10 and takes 45 teaches them to distrust the plan. A step that's genuinely ≤2 minutes is worth flagging as such: it's the "just do it now" kind.\n` +
      `- Mark automatable=true ONLY for a step Otto already prepared (the student just clicks).\n` +
      (links.length
        ? `- ATTACH A LINK WHERE ONE WOULD SAVE THE STUDENT THE LOOKUP. A step that sends them somewhere — to ` +
          `buy, book, order, download, register, or read a specific source — should carry "url", so they can ` +
          `act on it instead of re-searching what Otto already found. Use ONLY these exact URLs, copied ` +
          `character for character; never invent, shorten or guess one, and leave "url" off any step where ` +
          `none of them genuinely fits:\n` +
          links.map((l) => `  · ${l.label} — ${l.url}`).join("\n") + `\n` +
          `- IF THE TASK ALREADY HAS A LINK (especially an email/message link), never write a step like "find the email", "search for the email", or "locate the message". Instead, write "open the link" and attach the existing URL. The link is already provided — use it directly.\n`
        : "") +
      adaptiveInstructions +
      `\nHOW TO ANSWER:\n` +
      `First fill "dodParts": split the DEFINITION OF DONE into its distinct parts, in order, one short ` +
      `phrase each — these are the things that must be true for this task to be finished.\n` +
      `Then write the steps. EVERY step must carry "dodPart": the 1-based number of the part it directly ` +
      `advances. This is the real test of a step: if you cannot point at the part of the definition of done ` +
      `it moves forward, it is not a step for this task — do not write it, and write the step that part ` +
      `actually needs instead. A step that is merely on-topic, generically sensible, or good study advice ` +
      `is exactly what this rule exists to keep out.\n` +
      `Finally, "firstAction": the smallest possible first move on this task — ONE tiny, concrete action (≤12 words, 1-10 minutes) a stuck student can't refuse, e.g. "Open the énoncé and circle the three question verbs". It's the on-ramp INTO step 1, not a copy of it; omit it only if step 1 is already that small.\n` +
      `Return JSON: {"dodParts": ["...", "..."], "steps": [{"text": "...", "minutes": 15, "automatable": false, "dodPart": 1, "url": "only if one of the links above fits"}], "firstAction": {"text": "...", "minutes": 3}, "definitionOfDone": "refined if needed"}`,
      // 800 was verified live to truncate mid-JSON on an ordinary task (DeepSeek v4's hidden reasoning
      // tokens count against max_tokens — see ask()'s own comment) — up to 10 step objects, each with 5
      // fields, needs real headroom. ask() now also retries once with a bumped budget on truncation, but
      // starting realistically sized means that retry (extra latency + cost) is the rare case, not routine.
      2200,
    );

    const dodParts: string[] = (Array.isArray(stepsOut.dodParts) ? stepsOut.dodParts : [])
      .map((p: any) => String(p || "").trim()).filter(Boolean).slice(0, 8);
    let steps: TaskStep[] = (stepsOut.steps || []).map((s: any) => ({
      text: truncateStepText(String(s.text || "")),
      automatable: !!s.automatable,
      ...sanitizeStepExtras(s),
    }));
    console.log(`${new Date().toISOString()} [ai] step 4 result: ${steps.length} steps before filtering`);
    // The anti-procrastination on-ramp (RunOutput.firstAction → the task card's "start here" nudge and
    // patterns.ts's twoMinuteRuleBoost). Only the rarely-used manual "regenerate steps" route ever produced
    // it before — the main pipeline that plans every task never asked, so the whole feature sat dead for
    // nearly every real task. Same bounds finalize() applies (≤90 chars, 1-10 minutes).
    const firstActionText = stepsOut?.firstAction?.text ? truncateStepText(String(stepsOut.firstAction.text), 90) : "";
    const firstActionMinutes = Number(stepsOut?.firstAction?.minutes);
    steps = restrictStepUrlsToLinks(steps, links);

    // Anchoring: a step only belongs in this plan if it advances a named part of the definition of done.
    // The model was just asked to enumerate those parts and cite one per step, so a step that cites none
    // (or an out-of-range part) is the model itself saying it couldn't connect that step to the goal —
    // which is exactly the "on-topic but not actually pointed at the DoD" step that keeps showing up.
    // Acting on this is safe only because the signal comes from the model's own bookkeeping rather than a
    // keyword guess (this file's repeatedly-deleted step filters were all the latter), and even so it is
    // floored: at least 2 anchored steps must survive, otherwise the whole plan stands untouched.
    if (dodParts.length) {
      const anchoredTexts = new Set<string>(
        (stepsOut.steps || [])
          .filter((s: any) => Number.isInteger(s?.dodPart) && s.dodPart >= 1 && s.dodPart <= dodParts.length)
          .map((s: any) => truncateStepText(String(s.text || ""))),
      );
      const beforeAnchor = steps.length;
      steps = dropUnanchoredSteps(steps, (text) => anchoredTexts.has(text));
      if (steps.length < beforeAnchor) {
        console.log(`${new Date().toISOString()} [ai] step 4: dropped ${beforeAnchor - steps.length} step(s) not tied to any part of the definition of done`);
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Étape(s) retirée(s) : aucun lien avec la définition de terminé` : `Removed step(s) that didn't advance any part of the definition of done` });
      }
    }
    // Apply the same quality gates every step list passes through.
    steps = anchorStepsToTask(steps, task.title, 6);
    // The contamination filters below were built (and are still used) in writeStepsFromContext, the
    // separate pipeline reachable only from the manual /regenerate route — this is the LIVE task-creation
    // codepath (server/tasks.ts consumes runTask's steps directly) and never called them, despite the
    // comment above claiming "the same quality gates every step list passes through." Wired in now, same
    // order writeStepsFromContext already uses.
    steps = dropProcessComplaintSteps(steps);
    steps = dropForeignEntitySteps(task, links, steps);
    steps = dropSiblingBleedSteps(task, siblingTasks || [], steps);
    steps = dropOffTopicStudySteps(task.taskType, steps);
    // Same gap as the comment above (a filter that existed but was never wired into THIS live pipeline):
    // OTTO_INTERNAL_STEP/THIRD_PERSON_STUDENT_STEP were only ever applied in the separate manual-regenerate
    // path. Reported live: "Build a shortlist of Oslo activities" left a step reading "Re-run searches for
    // Oslo prices, hours, booking channels" — Otto narrating its OWN research action as if it were the
    // student's to-do, exactly what OTTO_INTERNAL_STEP exists to catch (the searches already ran THIS turn
    // in step 2 above; a leftover "re-run" instruction is stale process narration, not a real next action).
    steps = steps.filter((s) => !OTTO_INTERNAL_STEP.test(s.text) && !THIRD_PERSON_STUDENT_STEP.test(s.text));
    // DOABLE/JUDGMENT automatable-flip — otherwise pulled forward from the dead finalize() (see its own
    // comment there): a step starting with a doable verb ("research", "compile", "find", "draft"...) and
    // carrying no judgment word is Otto's own work, not a to-do to dump on the student.
    for (const s of steps) {
      if (!s.automatable && DOABLE_STEP.test(s.text) && !JUDGMENT_STEP.test(s.text) && !s.question) s.automatable = true;
    }
    // dropTrivialSteps runs HERE, AFTER the automatable flip above — not before it, which is the ordering
    // bug finalize()'s own comment (search "Triviality gate runs HERE") explicitly warns about and this
    // file has "verified live to crash tests/run.mjs by zeroing out valid steps": a not-yet-flipped step
    // like "Research X and compile a list" or "Find a time that works for the team" still looks like a
    // bare trivial lookup BEFORE the flip runs, and dropTrivialSteps would delete it before it ever gets
    // the chance to be marked as Otto's own automatable work. This file's own earlier revision of this
    // exact block ran them in the wrong order — fixed to match finalize()'s documented-correct sequence.
    steps = dropTrivialSteps(steps);
    // Granularity gate: steps are OPTIONAL for small, single-session tasks (errand, form, download,
    // booking — doable in one sitting). For those, keep at most one step ("start here") and rely on
    // the first action; a step list on a 5-minute errand is clutter, and the model kept producing one
    // despite the prompt. Any task with a study/assessment/project signal (taskNeedsStepList) keeps its
    // full list; only shapes with no such signal at all get trimmed to the one-step + first-action form.
    if (!taskNeedsStepList({ title: task.title, why: task.why, goal: definitionOfDone, taskType: task.taskType }) && steps.length > 1) {
      steps = steps.slice(0, 1);
      audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Plan réduit à une seule action : petite tâche d'une seule session` : `Plan trimmed to a single action — small, single-session task` });
    }
    // Observational only — never deletes a step. stepsMatchTitle/isFolderHousekeepingDrift are whole-plan
    // drift signals; this file has repeated scars from keyword-based DELETION filters "verified live to
    // crash tests by zeroing out valid steps," so these only ever log for debugging, never remove anything.
    if (!stepsMatchTitle(task.title, steps)) {
      audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `guardrail: most steps don't share a keyword with the task title — possible drift` });
    }
    if (isFolderHousekeepingDrift(task.title, steps)) {
      audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `guardrail: every step is pure Drive folder/file housekeeping — possible drift` });
    }
    console.log(`${new Date().toISOString()} [ai] step 4 result: ${steps.length} steps after filtering`);
    // If all steps were filtered out, keep at least the raw model output rather than falling back to a
    // single generic "Continue working on" step that then gets auto-broken into substeps (the exact
    // failure mode reported live: one step with 8 sub-steps instead of 8 real steps).
    if (!steps.length && stepsOut.steps?.length) {
      steps = (stepsOut.steps || []).map((s: any) => ({
        text: truncateStepText(String(s.text || "")),
        automatable: !!s.automatable,
        ...sanitizeStepExtras(s),
      })).filter((s: TaskStep) => s.text).slice(0, 12);
    }
    // If stepsOut itself is empty (AI returned no steps), create a fallback step
    if (!steps.length) {
      console.warn(`${new Date().toISOString()} [ai] step 4: no steps from AI, creating fallback`);
      steps = [{ text: fr ? `Avancer sur : ${task.title}` : `Continue working on: ${task.title}`, automatable: false }];
    }
    if (stepsOut.definitionOfDone && String(stepsOut.definitionOfDone).trim()) {
      // The model may refine the definition of done during step planning — keep it.
    }

    // ── STEP 5: Is an artifact necessary? → create artifacts for academic tasks ──
    // For academic revision/prep tasks, artifacts (flashcards, quizzes, notes) are genuinely useful
    // and should be created proactively. For logistics/admin tasks, skip them.
    console.log(`${new Date().toISOString()} [ai] step 5: checking if artifacts needed`);
    // taskType (set by the classifier in step 1/2) is the authoritative signal for "is this actually
    // a learning task" — when known, trust it over the keyword regex below. The regex used to include
    // a bare "prep" match, which fired on "Oslo Trip Prep: Purpose, Dates, Bookings" (a logistics task)
    // and generated an irrelevant flashcard deck. BUT this used to hard-skip on ANY non-study taskType,
    // including "research"/"analyze"/"decide"/"project"/"create"/"write" — reported live: "Build a
    // shortlist of Oslo activities" (taskType "research", DoD asking for a categorized list of 15-20 real
    // options) never even got a note artifact considered, so the actual compiled shortlist Otto's own
    // research produced had nowhere to live — it stayed as ungrounded STEPS ("Build 15-20 rows by
    // category…") instead of a real note the student could open. A "note" is exactly the right artifact
    // for a compiled research shortlist/comparison, not just an academic reference sheet — see the note
    // type's own broadened description below. Only hard-skip taskTypes where an artifact genuinely never
    // makes sense (pure logistics/admin/upkeep with no content worth saving); every other type still asks.
    // ...and even those don't get NOTHING. Reported live: "Lock dates, bookings and an Arctic-ready
    // itinerary" (taskType "logistics") was hard-skipped here, so a run that had already researched dates,
    // transport options and Arctic kit produced no document at all — the student got two vague steps and
    // every real specific Otto found was thrown away. A logistics/admin task's right artifact is a BRIEF:
    // the dates settled, what's booked vs still outstanding, the itinerary skeleton, the checklist. So
    // these types stay in the pipeline and can have a "note"; what they can never have is flashcards or a
    // quiz (nothing here is memorizable content), enforced below rather than by skipping the whole step.
    const NOTE_ONLY_TASK_TYPES = new Set<string>(["administrative", "logistics", "maintain"]);
    const isNoteOnly = !!task.taskType && NOTE_ONLY_TASK_TYPES.has(task.taskType);
    {
    const isAcademic = task.taskType
      ? STUDY_TASK_TYPES.has(task.taskType) || task.taskType === "analyze" || task.taskType === "problem_solve"
      : /revision|revis|study|exam|test|control|contr[ôo]le|assessment|memoris|memoriz|drill|practice|pratique|exercis|exercic|chapter|chapitre|notion|formula|formule|definition|d[ée]finition|vocab|vocabulary|vocabulaire|grammar|grammaire|history|histoire|dates|biology|biologie|chemistry|chimie|physics|physique|maths|math[ée]mat|geography|g[ée]o|econom|[ée]conom|philosophy|philo|french|fran[çc]ais|english|anglais|spanish|espagnol|german|allemand|literature|litt[ée]rature/i.test(`${task.title} ${task.why} ${definitionOfDone}`);

    // Get focus-based artifact recommendation
    const artifactRecommendation = task.sourceSubject ? recommendArtifactType(task.sourceSubject, profile) : null;
    if (artifactRecommendation) {
      console.log(`${new Date().toISOString()} [ai] step 5: focus-based artifact recommendation: ${artifactRecommendation}`);
    }

    const artifactOut = await ask(
      `There is this task: "${task.title}".\n` +
      `The user wants to have this definition of done: ${definitionOfDone}\n\n` +
      `Context:\n${context || "(no external context)"}\n\n` +
      `For this task, what artifact(s) would genuinely help the student achieve the definition of done?\n` +
      `Available types:\n` +
      `- "flashcards": a drillable deck for discrete SUBJECT-MATTER facts (vocab, definitions, formulas, dates, ` +
      `equations) the student must memorize. NEVER for methodology/format/how-to-write-it rules of an essay, ` +
      `commentaire, notice, or any other written deliverable (e.g. "what must a notice biographique contain" is ` +
      `a rule about the assignment, not a fact to drill) — that belongs in a "note" instead, as a structure/ ` +
      `checklist the student references while writing.\n` +
      `- "quiz": multiple-choice self-check with NEW questions (for checking understanding before a test).\n` +
      `- "note": a short in-app document — an academic reference sheet (formulas, key concepts, a study ` +
      `checklist, a worked example structure) OR a COMPILED RESEARCH OUTPUT: if the definition of done asks ` +
      `for a produced list/shortlist/comparison of real-world options (activities, places, products, ` +
      `providers, sources) and the context above actually contains enough concrete, specific material to ` +
      `build it, this is where that compiled result belongs — a categorized table/list with the real names, ` +
      `prices, locations, etc. from the context. Otherwise the student is left with a step describing work ` +
      `Otto already had the material to just do — OR a BRIEF for a practical/coordination task: the dates ` +
      `and decisions settled, what is booked versus still outstanding, the itinerary or schedule skeleton, ` +
      `the checklist of what to bring/prepare/send, each line carrying the real specifics from the context. ` +
      `A brief is a document the student opens while doing the task, not a study aid — a trip, a booking, ` +
      `an application, a repair, an event all deserve one.\n` +
      `- "none": no artifact needed.\n` +
      (artifactRecommendation ? `FOCUS-BASED RECOMMENDATION: Based on the student's historical focus patterns, consider prioritizing "${artifactRecommendation}" for this task/subject.\n` : "") +
      `For ACADEMIC revision/prep/study tasks, flashcards or a note are almost always useful — say yes.\n` +
      `For a research/compilation task whose definition of done asks for a produced list/shortlist/comparison, ` +
      `say yes to "note" WHENEVER the context above already has enough real, specific material to build it — ` +
      `only say none if the context is genuinely too thin to compile anything real from.\n` +
      (isNoteOnly
        ? `This is a practical/coordination task, so flashcards and a quiz are both WRONG here — never request them. ` +
          `The question is only whether a "note" (a BRIEF, as described above) is worth writing: say yes whenever the ` +
          `context or the definition of done carries real specifics worth having in one place while doing the task — ` +
          `dates, options, prices, what is booked vs outstanding, what to bring, who to contact. Say none only for a ` +
          `genuinely single-action task (pay one bill, send one message) where a document would be noise.\n`
        : `For a pure single-action logistics/admin task (pay one bill, send one message — nothing to compile or reference later), the answer is none.\n`) +
      `DECIDE BY WHAT KIND OF LEARNING THIS ACTUALLY IS, not by habit: raw memorization (vocab, dates, formulas, ` +
      `discrete facts) → flashcards; checking whether understanding is solid enough to discriminate between ` +
      `plausible answers before a test → quiz; a reference/structure the student needs WHILE doing something ` +
      `else (a checklist, a compiled list, a brief, an essay's required structure) → note. Every artifact must ` +
      `earn its place — don't request one just because the task is "academic"; a task that's genuinely just ` +
      `one clear action needs none.\n` +
      `You can request MULTIPLE artifacts if the task genuinely calls for it (e.g. flashcards AND a note).\n` +
      `Return JSON: {"artifacts": [{"type": "flashcards", "reason": "..."}], "needsArtifact": true/false}\n` +
      `Set needsArtifact to true if any artifacts are requested. Use an empty array with needsArtifact=false if none.`,
      600, // same truncation risk as step 1's budget — see that comment
    );

    // Process artifact requests — support flashcards, quizzes, AND notes.
    const requestedArtifacts: { type: string; reason?: string }[] = Array.isArray(artifactOut.artifacts)
      ? artifactOut.artifacts.filter((a: any) => a && a.type && a.type !== "none")
      : (artifactOut.needsArtifact === true && artifactOut.type && artifactOut.type !== "none" ? [{ type: artifactOut.type, reason: artifactOut.reason }] : []);
    console.log(`${new Date().toISOString()} [ai] step 5 result: ${requestedArtifacts.length} artifacts requested, isAcademic=${isAcademic}`);
    // For academic tasks where the AI didn't explicitly request artifacts, nudge it to create flashcards
    // if the content is naturally discrete facts (formulas, definitions, vocab, dates).
    if (!requestedArtifacts.length && isAcademic && /formula|formule|equation|[ée]quation|definition|d[ée]finition|vocab|vocabulary|vocabulaire|dates|grammar|grammaire|conjug|tense|temps|verb|verbe|noun|adjective|adverb|adjectif|adverbe|element|[ée]l[ée]ment|compound|compos[ée]|reaction|r[ée]action|law|loi|theorem|th[ée]or[èe]me|principle|principe|method|m[ée]thode|rule|r[èe]gle/i.test(`${task.title} ${task.why} ${context}`)) {
      requestedArtifacts.push({ type: "flashcards", reason: "Academic task with discrete facts to memorize" });
      console.log(`${new Date().toISOString()} [ai] step 5: auto-adding flashcards for academic task`);
    }
    // For academic tasks that don't match the discrete-facts pattern (essays, analysis, understanding a
    // concept, problem-solving), a note CAN be the right fallback artifact — but only when there's actually
    // something worth writing down. This used to fire unconditionally for EVERY non-discrete-facts academic
    // task regardless of what the model itself had just said — overriding an explicit "none" from the very
    // call above whenever the task merely LOOKED academic, even for something with no real structure/method/
    // reference to capture (a single essay paragraph, a one-off problem set with nothing to compile). That
    // produced a brief nobody asked for and nobody needed just because the task was "academic" — the exact
    // "not every task needs a brief" default this nudge should never have overridden. Now it only fires when
    // the context actually has enough real material to write something substantive with (same floor as the
    // isNoteOnly branch below) — a thin/empty context means there's nothing to structure yet, so no note.
    if (!requestedArtifacts.length && isAcademic && `${context || ""}`.trim().length > 400) {
      requestedArtifacts.push({ type: "note", reason: "Academic task with real material to structure into a study guide/outline" });
      console.log(`${new Date().toISOString()} [ai] step 5: auto-adding note for academic task (context has real substance)`);
    }

    // Practical/coordination tasks: a note (brief) is the ONLY artifact that can make sense, so drop any
    // flashcards/quiz the model asked for regardless of its reasoning, and nudge a brief when this run
    // actually has substance to put in one. The context-length floor is what keeps this from producing an
    // empty document for a one-action errand: with nothing researched and a one-line DoD there's nothing
    // to brief, and a near-blank note is worse than no note.
    if (isNoteOnly) {
      const wrongType = requestedArtifacts.filter((a) => a.type !== "note");
      if (wrongType.length) {
        console.log(`${new Date().toISOString()} [ai] step 5: dropped ${wrongType.length} non-note artifact request(s) — taskType "${task.taskType}" can only have a brief`);
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `artifact: dropped flashcards/quiz — a practical task gets a brief, not a study aid` });
        for (const w of wrongType) requestedArtifacts.splice(requestedArtifacts.indexOf(w), 1);
      }
      if (!requestedArtifacts.length && `${context || ""}`.trim().length > 400) {
        requestedArtifacts.push({ type: "note", reason: "Practical task with researched specifics — a brief keeps them in one place" });
        console.log(`${new Date().toISOString()} [ai] step 5: auto-adding a brief for practical task`);
      }
    }

    // Defense in depth, independent of taskType/isAcademic (both upstream classifications that can be
    // wrong — see dodLooksLikeCoordinationOutcome's own comment for the live bug this closes): veto any
    // flashcards/quiz request whose DEFINITION OF DONE itself reads as a booking/coordination/decision
    // outcome rather than actual memorizable content, no matter what requested it.
    if (dodLooksLikeCoordinationOutcome(definitionOfDone)) {
      const vetoed = requestedArtifacts.filter((a) => a.type === "flashcards" || a.type === "flashcard" || a.type === "quiz");
      if (vetoed.length) {
        console.log(`${new Date().toISOString()} [ai] step 5: vetoed ${vetoed.length} flashcards/quiz request(s) — DoD reads as a coordination outcome, not memorizable content`);
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `artifact: vetoed flashcards/quiz — DoD is a coordination outcome, not memorizable content` });
        for (const v of vetoed) requestedArtifacts.splice(requestedArtifacts.indexOf(v), 1);
      }
    }

    // A WRITING task (an essay, a literary "notice biographique", a commentaire) never has real
    // front→back facts to drill — the only thing to know about it is HOW to write it (structure, required
    // elements, length), and that's methodology, not knowledge. Reported live: a "write two 4-line author
    // notices" task got a flashcard deck asking "what must a notice biographique contain / not contain" —
    // that's a rule about the FORMAT, not a fact about Fanon or Baldwin, and belongs in a note (a structure/
    // checklist), never a drillable card. The step 5 prompt already tells the model this in prose; this is
    // the hard backstop for when it asks for one anyway.
    if (task.taskType === "write") {
      const vetoed = requestedArtifacts.filter((a) => a.type === "flashcards" || a.type === "flashcard");
      if (vetoed.length) {
        console.log(`${new Date().toISOString()} [ai] step 5: vetoed ${vetoed.length} flashcards request(s) — a writing task's own methodology isn't drillable knowledge`);
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `artifact: vetoed flashcards — writing tasks need a structure note, not a methodology deck` });
        for (const v of vetoed) requestedArtifacts.splice(requestedArtifacts.indexOf(v), 1);
      }
    }

    // The deck, quiz and note are independent of each other (all read the same finished `context`), so they
    // are generated CONCURRENTLY — a task that wants all three used to wait for three reasoning-model calls
    // back to back. Results land in whatever order they finish; each only appends to its own list.
    await Promise.all(requestedArtifacts.map(async (artReq) => {
      console.log(`${new Date().toISOString()} [ai] step 5: creating artifact of type ${artReq.type}`);
      if (artReq.type === "flashcards" || artReq.type === "flashcard") {
        const deckOut = await ask(
          `Create a flashcard deck for this task.\n` +
          `TASK: "${task.title}"\n` +
          `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
          `Context:\n${context}\n\n` +
          `Create 8-15 flashcards with real, specific content. Use the context above when available, but ` +
          `Missing the class's EXACT source material is NEVER a reason to skip: use your general knowledge of the topic. ` +
          `SCOPE — ONLY WHAT THIS STUDENT IS ACTUALLY EXPECTED TO KNOW: a card the student can't answer because it ` +
          `was never part of their course is worse than useless — it reads as a gap they must fill when it isn't. ` +
          `Draw cards from what the assignment/énoncé/attached material actually names first; when you fall back on ` +
          `general knowledge, stay on the CORE notions the task title names, at THIS student's level/track (see ` +
          `VOCABULARY/track and year above) — never adjacent topics, advanced extensions, historiography, obscure ` +
          `dates/names, or detail a teacher at this level wouldn't test. When unsure whether something is in scope, ` +
          `leave it out: fewer in-scope cards beat a full deck padded with off-syllabus ones.\n` +
          `One idea per card. Front: asks for recall, never leaks the answer. Back: the answer, detailed enough to teach.\n` +
          `Cards must build real understanding of the topic, not just isolated trivia — cover the concept's core ` +
          `mechanics/reasoning (the "why"/"how"), not only names, dates, or definitions to memorize by rote when the ` +
          `topic genuinely calls for understanding a process or method (e.g. a formula's derivation or when to apply ` +
          `it, not just the formula itself in isolation).\n` +
          `Return JSON: {"title": "deck title", "cards": [{"front": "...", "back": "..."}]}`,
          1500,
        );
        const deck = makeDeck(deckOut);
        if ("deck" in deck) {
          flashcards.push(deck.deck);
          did.push(fr ? `Créé un jeu de flashcards : ${deck.deck.title}` : `Created flashcard deck: ${deck.deck.title}`);
          audit.push({ at: new Date().toISOString(), kind: "artifact", label: `flashcards: ${deck.deck.title}` });
          console.log(`${new Date().toISOString()} [ai] step 5: created flashcard deck with ${deck.deck.cards.length} cards`);
        } else {
          console.error(`${new Date().toISOString()} [ai] step 5: failed to create flashcard deck`);
        }
      } else if (artReq.type === "quiz") {
        const quizOut = await ask(
          `Create a quiz for this task.\n` +
          `TASK: "${task.title}"\n` +
          `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
          `Context:\n${context}\n\n` +
          `Create 4-8 multiple-choice quiz questions with NEW questions on the same notion (never the student's own exercise). ` +
          `Use the context above when available, but Missing the class's EXACT source material is NEVER a reason to skip: use your general knowledge of the topic. ` +
          `Each question needs 2-4 options, a correct index, and a one-line explanation.\n` +
          `Return JSON: {"title": "quiz title", "questions": [{"q": "...", "options": ["a", "b", "c", "d"], "correct": 0, "why": "..."}]}`,
          2000,
        );
        const quiz = makeQuiz(quizOut);
        if ("quiz" in quiz) {
          quizzes.push(quiz.quiz);
          did.push(fr ? `Créé un quiz : ${quiz.quiz.title}` : `Created quiz: ${quiz.quiz.title}`);
          audit.push({ at: new Date().toISOString(), kind: "artifact", label: `quiz: ${quiz.quiz.title}` });
          console.log(`${new Date().toISOString()} [ai] step 5: created quiz with ${quiz.quiz.questions.length} questions`);
        } else {
          console.error(`${new Date().toISOString()} [ai] step 5: failed to create quiz`);
        }
      } else if (artReq.type === "note") {
        const noteOut = await ask(
          `Create a short in-app reference note for this task.\n` +
          `TASK: "${task.title}"\n` +
          `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
          `Context:\n${context}\n\n` +
          `Create a concise reference sheet with REAL content. Use the context above when available, but ` +
          `Missing the class's EXACT source material is NEVER a reason to skip: use your general knowledge of the topic. ` +
          `Choose the shape that fits this task:\n` +
          `- ACADEMIC reference (key formulas, definitions, concepts, a worked example structure, a study checklist).\n` +
          `- COMPILED RESULT, if the definition of done asks for a produced list/shortlist/comparison of ` +
          `real-world options: a categorized table/list using the real names, prices, locations, durations ` +
          `from the context above — this is the deliverable itself, not a guide to making one.\n` +
          `- BRIEF, if this is a practical/coordination task (a trip, a booking, an application, an event, a ` +
          `repair): the working document the student opens while doing it. Lead with what is already SETTLED ` +
          `(dates, decisions, anything confirmed), then what is still OPEN with the concrete options and their ` +
          `real prices/links/deadlines from the context, then the checklist of what to book, bring, prepare or ` +
          `send. Every line carries a real specific — a brief made of generic advice ("research your options", ` +
          `"pack warm clothes") is worthless; the whole point is that the specifics are already in it. ` +
          `SIZE IT TO THE TASK: a small, single-session task (install an app, download a ticket, send a form) ` +
          `gets a SHORT brief — roughly 60-120 words, at most 2 sections, NO troubleshooting table and no ` +
          `what-if branches; only the 2-4 specifics that matter (where it lives, which email/account, the one ` +
          `real gotcha). A genuinely multi-leg task (a trip, a multi-stage application, a multi-week project) ` +
          `may run longer and use a table — but only with rows that each carry a real, necessary specific. ` +
          `A brief that mostly restates the task's own title, dates or due-status is too long however well ` +
          `organized.\n` +
          `Use markdown ` +
          `(headings, **bold**, bullet lists, GFM pipe tables when tabular). Every cell in a table must be ` +
          `filled with real content from the context — never leave blanks, and never invent a name/price/detail ` +
          `the context doesn't actually contain. For the academic case only, this is a GUIDE to help the ` +
          `student do the work, never a completed assignment — that distinction doesn't apply to a compiled ` +
          `research shortlist or a brief, both of which ARE the deliverable.\n` +
          `Return JSON: {"title": "note title", "body": "markdown content"}`,
          2000,
        );
        const note = makeNote(noteOut);
        if ("note" in note) {
          // Brief compression pass — brief length should be ADAPTED TO THE TASK, not a fixed output shape:
          // a 5-minute errand needs ~80 words, a multi-leg trip brief may legitimately run long. The prompt
          // above already asks for 60-120 words on a small task, but the reported live brief (700+ words,
          // two troubleshooting tables, for "download your ticket") ran long anyway — a prompt instruction
          // alone isn't a guarantee, same reasoning as every other verify-don't-trust gate in this file.
          // So: small task only (taskNeedsStepList false), body clearly bloated (> BRIEF_COMPRESS_WORDS)
          // → ONE rewrite call that keeps every real specific and cuts the rest. Never a silent chop: if
          // the rewrite fails or comes back empty, the original brief ships unchanged.
          if (!taskNeedsStepList({ title: task.title, why: task.why, goal: definitionOfDone, taskType: task.taskType })) {
            const wc = countWords(note.note.body);
            if (wc > BRIEF_COMPRESS_WORDS) {
              const compressed = await ask(
                `Below is a brief Otto wrote for this task:\nTASK: "${task.title}"\n` +
                `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
                `BRIEF (markdown):\n${note.note.body}\n\n` +
                `This task is small and single-session, and the brief is too long (${wc} words). Rewrite it in at most 120 words: ` +
                `keep every real specific it contains (names, dates, links, prices, account details, and the one or two genuine gotchas) and the minimum structure needed to carry them. ` +
                `Cut: anything that restates the task's own title/dates/status, what-if branches, troubleshooting tables, background the student already knows, and filler sentences. ` +
                `Write in the same language as the original. Return JSON: {"body": "compressed markdown"}. ` +
                `Only return the original unchanged if cutting anything would lose a real specific.`,
                1600,
              );
              const body = String(compressed?.body || "").trim();
              const rewritten = body && countWords(body) < wc ? makeNote({ title: note.note.title, body }) : null;
              if (rewritten && "note" in rewritten) {
                audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Fiche raccourcie : ${wc} → ${countWords(rewritten.note.body)} mots` : `Brief compressed: ${wc} → ${countWords(rewritten.note.body)} words` });
                console.log(`${new Date().toISOString()} [ai] step 5: compressed an over-long brief for a small task (${wc} → ${countWords(rewritten.note.body)} words)`);
                note.note = rewritten.note;
              } else {
                console.log(`${new Date().toISOString()} [ai] step 5: brief compression didn't return a usable rewrite — keeping the original (${wc} words)`);
              }
            }
          }
          notes.push(note.note);
          did.push(fr ? `Créé une fiche : ${note.note.title}` : `Created note: ${note.note.title}`);
          audit.push({ at: new Date().toISOString(), kind: "artifact", label: `note: ${note.note.title}` });
          console.log(`${new Date().toISOString()} [ai] step 5: created note`);
        } else {
          console.error(`${new Date().toISOString()} [ai] step 5: failed to create note`);
        }
      }
    }));
    if (!requestedArtifacts.length) {
      audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `artifact: skipped (not needed)` });
    }
    }

    // ── DoD verification — does the finished plan actually GET THERE? ──────────────────────────────────
    // Every other check in this pipeline (stepsMatchTitle, dropForeignEntitySteps, the DOABLE/JUDGMENT
    // automatable-flip, etc.) only asks "does the model's own output look internally sane" — none of them
    // check whether the finished plan actually satisfies definitionOfDone. Reported live: a "curated
    // shortlist of activities" task's steps were ALL refinement steps ("tag every activity", "cut options
    // outside the season window") with nothing concrete yet to refine — a plan that could never reach its
    // own definition of done, and nothing anywhere caught it. The step-writing PROMPT was tightened
    // separately (grounding + conditional research-allowed rules), but a prompt asking the model to behave
    // is not the same as verifying it did — same "don't just trust the model" posture as CHAT_DOES_WORK/
    // CHAT_STATES_ANSWER. This is the actual verification, covering BOTH steps and artifacts together
    // (nothing else in this file checks artifact content against the DoD at all). Deliberately ONE small,
    // cheap, best-effort call — never blocks or fails the run; on any failure `ask()` already returns {},
    // which the check below treats as "assume satisfied" rather than risk false-flagging a genuinely fine
    // plan just because this one extra call had a hiccup.
    if (steps.length && definitionOfDone) {
      const artifactSummary = [
        ...notes.map((n) => `Note "${n.title}": ${n.body.slice(0, 200)}`),
        ...flashcards.map((f) => `Flashcard deck "${f.title}" (${f.cards.length} cards)`),
        ...quizzes.map((q) => `Quiz "${q.title}" (${q.questions.length} questions)`),
      ].join("\n") || "(none)";
      // Deterministic pre-pass: never hand the student a step telling them to build something that is
      // already sitting on the task as a finished artifact. Runs BEFORE the repair call so the model is
      // auditing the plan the student would actually see.
      const beforeArtifactDedupe = steps.length;
      steps = dropRedundantArtifactSteps(steps, { note: notes.length > 0, flashcards: flashcards.length > 0, quiz: quizzes.length > 0 });
      if (steps.length < beforeArtifactDedupe) {
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Étape retirée : Otto avait déjà créé ce document` : `Removed a step that asked for something Otto had already made` });
      }

      // The old version of this pass asked one yes/no question, was told to "say yes" on anything that
      // wasn't the produced-list failure mode, and could add at most ONE step — so the failures reported
      // live sailed straight through it. A DoD naming five things while the plan covers two is not a close
      // enough match, and a plan whose steps are in an impossible order is not satisfied just because every
      // part is mentioned somewhere. So this is now a repair pass over the whole plan: coverage, order and
      // one-deliverable-per-step, returning the corrected list rather than a single patch step.
      const repair = await ask(
        `DEFINITION OF DONE: ${definitionOfDone}\n\n` +
        `TASK: "${task.title}"\n\n` +
        `PLANNED STEPS (what the student will do):\n${steps.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}\n\n` +
        `ARTIFACTS ALREADY CREATED FOR THE STUDENT:\n${artifactSummary}\n\n` +
        `Audit this plan on three things, then return the corrected plan.\n\n` +
        (dodParts.length
          ? `1. COVERAGE. The definition of done breaks into these parts:\n${dodParts.map((p, i) => `   ${i + 1}. ${p}`).join("\n")}\n` +
            `Every one of them must be either addressed by a step or already fully delivered by an artifact ` +
            `listed above. Add a step for each part that is neither, and drop any step that advances none of them.`
          : `1. COVERAGE. Break the definition of done into its distinct parts — commas, "and" and semicolons ` +
            `usually separate them, so "flashcards covering each figure, plus an identification quiz, worked ` +
            `through once, scored, with every missed figure noted" is FIVE parts, not one. Every part must be ` +
            `either addressed by a step or already fully delivered by an artifact listed above. Add a step for ` +
            `each part that is neither.`) +
        ` Be strict in particular when the definition of done asks for a produced ` +
        `list/comparison/set of real specific options (activities, sources, products, providers) and ` +
        `neither the steps nor the artifacts actually contain or will produce real specific content — only ` +
        `refinement/filtering/tagging steps with nothing concrete yet to refine.\n` +
        `2. ORDER. Put the steps in the order the student will really do them: whatever settles the scope, ` +
        `dates or selection comes before the work that acts on it, and anything that logs, scores, retakes ` +
        `or fixes comes after the attempt it reacts to.\n` +
        `3. ONE DELIVERABLE PER STEP. Split any step naming two or more separate things to produce or do.\n\n` +
        `Rules for the corrected plan: keep every existing step's intent (you may reword, reorder or split, ` +
        `but never drop work); never add a step that just re-creates an artifact already listed above; each ` +
        `step is a short concrete one-liner (≤10 words); at most 8 steps total.\n` +
        `Return JSON: {"uncovered": ["definition-of-done part that had no step, if any"], "steps": [{"text": "...", "automatable": true|false}]}`,
        // Returning a full rewritten plan (up to 8 step objects) on top of DeepSeek's hidden reasoning
        // tokens needs step 4's own order of budget, not the 800 a yes/no answer used to get by on.
        2200,
      );

      const repaired: TaskStep[] = (Array.isArray(repair?.steps) ? repair.steps : [])
        .map((s: any) => ({ text: truncateStepText(String(s?.text || "")), automatable: !!s?.automatable }))
        .filter((s: TaskStep) => s.text);
      // The one invariant that matters: a repair may grow or reshuffle the plan, never shrink it. This is
      // the guard that keeps this pass from becoming another of this file's step-zeroing filters — if the
      // model returned fewer steps than it was given, it dropped work, so the original plan stands.
      if (repaired.length >= steps.length && repaired.length <= 8) {
        const uncovered = (Array.isArray(repair?.uncovered) ? repair.uncovered : []).map((u: any) => String(u)).filter(Boolean);
        const grew = repaired.length > steps.length;
        const reordered = repaired.length === steps.length && repaired.some((s, i) => s.text !== steps[i].text);
        steps = reattachStepExtras(repaired, steps);
        // Repaired/split steps have never been through step 4's own gates, so re-run them here, in the same
        // order step 4 uses: the automatable flip FIRST, then the triviality gate (see step 4's comment on
        // why the reverse ordering deletes legitimate research steps), then the artifact dedupe again.
        for (const s of steps) {
          if (!s.automatable && DOABLE_STEP.test(s.text) && !JUDGMENT_STEP.test(s.text) && !s.question) s.automatable = true;
        }
        steps = dropRedundantArtifactSteps(steps, { note: notes.length > 0, flashcards: flashcards.length > 0, quiz: quizzes.length > 0 });
        steps = dropTrivialSteps(steps);
        if (uncovered.length) {
          console.log(`${new Date().toISOString()} [ai] DoD repair: parts with no step — ${uncovered.join("; ")}`);
          audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Étapes ajoutées pour couvrir la définition de terminé : ${uncovered.join(" ; ")}` : `Added steps so the plan covers every part of the definition of done: ${uncovered.join("; ")}` });
        } else if (grew || reordered) {
          audit.push({ at: new Date().toISOString(), kind: "guardrail", label: fr ? `Étapes réordonnées / séparées pour suivre l'ordre réel du travail` : `Steps reordered and split so they follow the real order of the work` });
        }
      } else if (!repaired.length) {
        // ask() returned {} or nothing usable — the call failed even after its own retry. Falling through
        // with the original plan is the intended best-effort behavior, but leaving no trace makes a bad
        // plan that slipped through indistinguishable from one that was genuinely verified.
        audit.push({ at: new Date().toISOString(), kind: "guardrail", label: `DoD check inconclusive — the verification call didn't return a parseable result` });
      } else {
        console.log(`${new Date().toISOString()} [ai] DoD repair rejected: returned ${repaired.length} steps for a plan of ${steps.length} — keeping the original`);
      }
    }

    // Total-outage check — see askCalls/askFailures' own comment above. Every single ask() call in this
    // run failed: this isn't a genuinely completed run with thin content, it's an AI outage wearing a
    // success shape. Throw for real so the outer catch below (and, past that, server/tasks.ts's error
    // path) actually runs — the same retry/backoff machinery a non-AI bug already gets.
    if (askCalls > 0 && askFailures === askCalls) {
      throw new Error(`runTask: all ${askCalls} AI calls failed — likely a total outage, not a thin result`);
    }

    steps = ensureArtifactUseSteps(steps, {
      decks: flashcards.map((d) => ({ title: d.title, count: d.cards.length })),
      quizzes: quizzes.map((q) => ({ title: q.title, count: q.questions.length })),
    }, fr);

    // Build the synthesis line.
    const didLines: string[] = [];
    if (allSearchResults.length) didLines.push(fr ? `Recherche web effectuée (${allSearchResults.length} requêtes)` : `Web research done (${allSearchResults.length} queries)`);
    if (notes.length) didLines.push(fr ? `Fiche(s) créée(s)` : `Note(s) created`);
    if (flashcards.length) didLines.push(fr ? `Flashcards créées` : `Flashcards created`);
    if (quizzes.length) didLines.push(fr ? `Quiz créé` : `Quiz created`);
    const synthesis = didLines.length
      ? (fr ? `${didLines.join(", ")}. ${steps.length} étape(s) restante(s).` : `${didLines.join(", ")}. ${steps.length} step(s) left.`)
      : (fr ? `Analyse terminée. ${steps.length} étape(s) à faire.` : `Analysis done. ${steps.length} step(s) to do.`);

    return {
      context: context || (fr ? "Analyse basée sur la tâche elle-même." : "Analyzed from the task itself."),
      synthesis,
      did: did.length ? did : [],
      steps: steps.length ? steps : [{ text: fr ? `Avancer sur : ${task.title}` : `Continue working on: ${task.title}`, automatable: false }],
      ...(firstActionText && steps.some((st) => !st.automatable && !st.done) ? { firstAction: {
        text: firstActionText,
        ...(Number.isInteger(firstActionMinutes) && firstActionMinutes >= 1 && firstActionMinutes <= 10 ? { minutes: firstActionMinutes } : {}),
      } } : {}),
      links,
      sendables: [],
      notes: notes.length ? notes : undefined,
      flashcards: flashcards.length ? flashcards : undefined,
      quizzes: quizzes.length ? quizzes : undefined,
      profileUpdates: [],
      tokens: { in: tokIn, out: tokOut, cachedIn: 0 },
      audit: audit.length ? audit : undefined,
    };
  } catch (e: any) {
    console.error(`${new Date().toISOString()} [ai] runTask error: ${e?.message || e}`);
    return {
      context,
      synthesis: fr ? "Erreur lors de l'analyse. Réessaie." : "Error during analysis. Retry.",
      did: [],
      steps: [{ text: fr ? `Avancer sur : ${task.title}` : `Continue working on: ${task.title}`, automatable: false }],
      links: [],
      sendables: [],
      notes: notes.length ? notes : undefined,
      flashcards: flashcards.length ? flashcards : undefined,
      quizzes: quizzes.length ? quizzes : undefined,
      profileUpdates: [],
      tokens: { in: tokIn, out: tokOut, cachedIn: 0 },
      audit: audit.length ? audit : undefined,
    };
  }
}

/**
 * NEW ARCHITECTURE: Structured task planning output
 * Defines the structure for task planning with artifacts, steps, and separate tasks.
 */
export interface TaskPlanningOutput {
  definitionOfDone: string;
  contextRelevance: string; // How the gathered context relates to the task
  artifacts: TaskArtifact[];
  steps: TaskStep[];
  separateTasks: SeparateTask[];
}

/**
 * Plan-only mode's dedicated SECOND PASS for writing steps — separate from the research loop on purpose.
 * The research loop's transcript is full of raw tool-call JSON, retries, and reasoning by the time it reaches
 * "submit"; asking the SAME call to also produce the final actionable steps means the model is synthesizing
 * a clean plan while still holding all that noise in context. This call sees NONE of that — only the task
 * and the DISTILLED context/links already found — so it can focus entirely on "given what we now know, what
 * are the concrete next actions?" instead of "given everything I just read AND what I know, what's next?"
 * Falls back to the research loop's own steps on any failure (never worse than before, only sometimes better).
 */
export async function writeStepsFromContext(
  task: {
    title: string;
    why: string;
    source?: string;
    sourceSubject?: string;
    sourceDetail?: string;
    sourceDue?: string;
    taskType?: TaskType;
    goal?: string;
    infoRequirement?: InfoRequirement;
    unknowns?: string[];
  },
  context: string,
  links: TaskLink[],
  fallbackSteps: TaskStep[],
  siblingTasks: { title: string; why?: string }[] = [],
  did: string[] = [],
  profile?: Profile,
  modelJudgedBigProject?: boolean,
): Promise<{ steps: TaskStep[]; artifacts: TaskArtifact[] }> {
  const keywordHit = modelJudgedBigProject === true || isBigIbProject(profile, task.title, task.why);
  if (!context.trim() && !keywordHit) return { steps: fallbackSteps, artifacts: [] };
  try {
    const client = deepseekClient();
    const linksBlock = links.length ? `\n\nRESOURCES ALREADY FOUND/CREATED:\n${links.map((l) => `- ${l.label}: ${l.url}`).join("\n")}` : "";
    const didBlock = did.length ? `\n\nWHAT WAS ALREADY DONE THIS RUN (do not re-list these as steps):\n${did.map((d) => `- ${d}`).join("\n")}` : "";
    const taskTypeLine = task.taskType ? `\nTASK TYPE: ${task.taskType}` : "";
    const goalLine = task.goal ? `\nGOAL / DEFINITION OF DONE: ${task.goal}` : "";
    const unknownsLine = task.unknowns?.length ? `\nUNKNOWNS: ${task.unknowns.join("; ")}` : "";

    const res: any = await retryRequest(() => client.chat.completions.create({
      model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
      max_tokens: OUT.steps,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `TASK TITLE: "${task.title}"\nTASK WHY: "${task.why}"\n${taskTypeLine}${goalLine}${unknownsLine}\n\n` +
          `CORE INVARIANT: The task title is the OBJECTIVE. The Definition of Done is the SUCCESS CONDITION. ` +
          `The context below is SUPPORTING INFORMATION only. Never let the context become the objective.\n\n` +
          `${context.trim() ? `CONTEXT GATHERED (supporting information only — not the objective):\n${context}` : "No research was needed for this one — plan it from the task itself."}${linksBlock}${didBlock}` +
          assignmentBlock(task, tzOf(profile)) + profileBlock(profile) + `\n\n` +
          languageLine(profile) + trackLine(profile) + syllabusGroundingLine(profile, task.sourceSubject) + nowBlock() +
          `NEW ARCHITECTURE: TWO-STEP PLANNING — Otto's Internal Steps → User's Visible Steps\n\n` +
          `STEP 1: Re-anchor to the ORIGINAL TASK\n` +
          `The task title is the objective: "${task.title}"\n` +
          `The Definition of Done is the success condition: ${task.goal || "define this concretely"}\n` +
          `Answer: What is the user actually trying to accomplish? What does "done" mean for THIS exact task?\n\n` +
          `STEP 2: Filter context for TASK RELEVANCE\n` +
          `Review the gathered context above. Which parts actually help achieve the Definition of Done?\n` +
          `Discard: unrelated curriculum materials, other subjects, unrelated deadlines, disconnected accounts.\n` +
          `Keep: only information that directly supports completing "${task.title}".\n` +
          `State briefly: Which context is relevant and why?\n\n` +
          `STEP 3: Plan OTTO'S INTERNAL STEPS (what Otto will do itself)\n` +
          `Based on the RELEVANT context, what will Otto ACTUALLY DO ITSELF?\n` +
          `Otto's internal steps include:\n` +
          `- Research: search Drive, Gmail, web for missing information\n` +
          `- Artifact creation: summaries, reference sheets, flashcards, practice questions, quizzes, outlines, evidence banks\n` +
          `- Prep work: organizing information, compiling data, drafting content\n` +
          `Otto EXECUTES these steps INTERNALLY — the user never sees them.\n` +
          `List in "artifacts" — these represent what Otto will create.\n\n` +
          `STEP 4: Plan USER'S VISIBLE STEPS (what the user must do)\n` +
          `NOW that Otto has done what it can, what does the student ACTUALLY need to do?\n` +
          `User steps include ONLY:\n` +
          `- Decisions/judgments only the student can make\n` +
          `- Physical actions the student must perform\n` +
          `- Logins/credentials only the student has\n` +
          `- Payments or approvals\n` +
          `- Genuine review/approval of Otto's work\n` +
          `User steps are SHORT (≤12 words), concrete, and action-oriented.\n` +
          `List in "steps" — these are what the user sees.\n\n` +
          `STEP 5: Identify unrelated tasks discovered during research\n` +
          `Did the research uncover other actionable items that are NOT part of THIS task?\n` +
          `Examples: "Send Weave reply", "Confirm IEO finals date". These become separate tasks, not steps.\n\n` +
          `CRITICAL RULES:\n` +
          `1. The TASK TITLE is the objective — never lose sight of it\n` +
          `2. CONTEXT is supporting information only — never let it become the objective\n` +
          `3. Otto's steps are INTERNAL — never shown to the user\n` +
          `4. User steps are ONLY what the user must do — not research, not artifact creation\n` +
          `5. Unrelated tasks become separate tasks, not steps\n` +
          `6. Each user step must directly move toward the Definition of Done\n` +
          `7. Generate the MINIMUM required user steps — not everything that could be done. Apply this ladder: small/single-session tasks get exactly one concise \"start here\" step; multi-day or assessment-prep work gets 3-4 scannable steps; genuinely complex projects get at most 8. Artifacts are optional: create zero, one, or several only when each is necessary for the task. Links are optional too: include only verified, task-specific links the student needs, never incidental research results or links merely because they are available.\n` +
          `8. GROUNDING — every specific name/place/price/date a step mentions must actually appear in ` +
          `CONTEXT above, never invented from general knowledge, even if it's factually real\n` +
          `9. EXCEPTION to "not research X": if the Definition of Done asks for a produced list/comparison ` +
          `of real specific options and CONTEXT above is thin or generic (not an actual list of real ` +
          `candidates), the first user steps must be genuine research/compilation steps that build it — ` +
          `refinement-style steps (filter, tag, compare) with nothing concrete yet to filter/tag/compare ` +
          `can't reach the Definition of Done\n` +
          `10. SEQUENCE steps in the order the student will actually do them — a step that reacts to an ` +
          `ATTEMPT (retake, log mistakes, fix what was wrong, redo until clean) must come AFTER the step ` +
          `where that attempt happens, never before it (reported live: "log misses, then retake" was ` +
          `generated as step 1, before "sit a timed set" as step 2 — backwards, nothing to log yet)\n\n` +
          LEARNING_SCIENCE_RULES + `\n` +
          `- Directly contribute to the Definition of Done for "${task.title}"\n` +
          `- Be something the student must do (not Otto)\n` +
          `- Be concrete and actionable (not "research X" or "find Y") UNLESS rule 9 above applies\n` +
          `- Not be about creating Otto's artifacts (Otto creates those)\n` +
          `- Not be internal Otto work (re-search, re-fetch, retry)\n` +
          `- Not be an unrelated task discovered during research\n` +
          `- Not be microscopic instructions (no 6-step sub-plans)\n\n` +
          `STEP 5: Identify unrelated tasks discovered during research\n` +
          `Did the research uncover other actionable items that are NOT part of "${task.title}"?\n` +
          `Examples: "Send Weave reply", "Confirm IEO finals date". These become separate tasks, not steps.\n\n` +
          `CRITICAL RULES:\n` +
          `1. The TASK TITLE is the objective — never lose sight of it\n` +
          `2. CONTEXT is supporting information only — never let it become the objective\n` +
          `3. Otto's steps are INTERNAL — never shown to the user\n` +
          `4. User steps are ONLY what the user must do — not research, not artifact creation\n` +
          `5. Unrelated tasks become separate tasks, not steps\n` +
          `6. Each user step must directly move toward the Definition of Done\n` +
          `7. Generate the MINIMUM required user steps — not everything that could be done\n\n` +
          LEARNING_SCIENCE_RULES + `\n` +
          `Return ONLY this JSON:\n` +
          `{\n` +
          `  "definitionOfDone": "concrete success criteria for this exact task",\n` +
          `  "contextRelevance": "brief explanation of which gathered context is relevant and why",\n` +
          `  "artifacts": [{"title": "...", "type": "note|flashcards|quiz|outline|checklist|reference|draft|summary|evidence_bank|other", "status": "created|needed|not_needed", "description": "..."}],\n` +
          `  "steps": [{"text": "...", "minutes": 15, "doneWhen": "...", "checkpoint": "...", "difficulty": "easy|medium|hard", "automatable": false (ALWAYS false for user steps), "dependsOn": 0, "url": "..." (optional), "question": "..." (optional), "options": ["..."] (optional)}],\n` +
          `  "separateTasks": [{"title": "...", "reason": "..."}]\n` +
          `}\n\n` +
          `IMPORTANT: All steps must have automatable=false — these are USER steps only. Otto's internal work goes in artifacts.`,
      }],
    }));
    
    const out = firstJson<TaskPlanningOutput & { isBigProject?: boolean }>(String(res.choices?.[0]?.message?.content || ""));
    
    if (!out) {
      console.log(`${new Date().toISOString()} [ai] writeStepsFromContext: failed to parse output, using fallback`);
      return { steps: fallbackSteps, artifacts: [] };
    }

    // Removed by direct request: the "big IB project" milestone-breakdown (dated sub-steps for Extended
    // Essay/TOK/CAS/IA, via targetDate) used to be triggered here. Forced off going forward — every task,
    // IB project or not, now takes the ordinary step path below (same one every other task type already
    // uses). The model is no longer asked for "isBigProject"/"targetDate" at all (see the prompt above), so
    // this isn't reading stale data, it's just never turning the old branch back on. `keywordHit` above
    // still exists (it also gates whether this call runs at all when there's no context — unrelated to the
    // milestone feature, kept so a genuinely big/complex task still gets a real planning call rather than
    // silently falling back when there's nothing to research). Pre-existing tasks that already have
    // targetDate steps from before this change are untouched — replanMilestones (server/milestones.ts)
    // still keeps those working; this only stops NEW ones from being created.
    const bigProject = false;
    const definitionOfDone = out.definitionOfDone || task.goal || task.why;
    
    // Log the re-anchoring process
    console.log(`${new Date().toISOString()} [ai] Task: "${task.title}"`);
    console.log(`${new Date().toISOString()} [ai] Definition of Done: ${definitionOfDone}`);
    if (out.contextRelevance) {
      console.log(`${new Date().toISOString()} [ai] Context Relevance: ${out.contextRelevance}`);
    }
    
    // Log artifacts
    if (out.artifacts && out.artifacts.length > 0) {
      console.log(`${new Date().toISOString()} [ai] Otto prepared ${out.artifacts.length} artifacts: ${out.artifacts.map(a => a.title).join(", ")}`);
    }
    
    // Log separate tasks
    if (out.separateTasks && out.separateTasks.length > 0) {
      console.log(`${new Date().toISOString()} [ai] Discovered ${out.separateTasks.length} separate tasks: ${out.separateTasks.map(t => t.title).join(", ")}`);
    }

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const rawSteps = out.steps || [];
    const linkUrls = new Set(links.map((l) => l.url));
    
    // Apply the new architecture filters
    let steps = sanitizeSteps(rawSteps
      .map((s, idx) => {
        const matched = !bigProject ? bestMatchingStep(String(s?.text || ""), fallbackSteps) : undefined;
        const own = sanitizeStepExtras(s);
        const url = (own.url && linkUrls.has(own.url)) ? own.url
          : (matched?.url && linkUrls.has(matched.url)) ? matched.url : undefined;
        return {
          text: truncateStepText(String(s?.text || "")),
          automatable: bigProject ? false : !!s?.automatable,
          minutes: own.minutes ?? matched?.minutes,
          // NOTE: doneWhen, checkpoint, difficulty are no longer included - they belong on the main task's Definition of Done
          ...(bigProject && dateRe.test(String(s?.targetDate || "")) ? { targetDate: s!.targetDate } : {}),
          ...(!bigProject && Number.isInteger(s?.dependsOn) && s!.dependsOn! >= 0 && s!.dependsOn! < rawSteps.length && s!.dependsOn !== idx
            ? { dependsOn: s!.dependsOn }
            : {}),
          ...(!bigProject ? {
            url,
            question: own.question ?? matched?.question,
            options: own.options ?? matched?.options,
            needsPermission: own.needsPermission || matched?.needsPermission || undefined,
          } : {}),
        };
      }), bigProject ? 20 : 15);
    
    // filterStepsByDefinitionOfDone NOT applied here — see the identical comment at its other call site
    // (finalize(), a few hundred lines up) for why: isResearchOperation() blindly rejects any step starting
    // with "Research"/"Find" regardless of context, conflicting with the established automatable-flip design
    // below (a research-and-compile step Otto does itself is legitimate). Verified live: crashed tests by
    // zeroing out valid steps.

    // Apply artifact separation
    const { filteredSteps: stepsWithoutArtifacts, artifacts } = separateArtifactsFromSteps(steps);
    steps = stepsWithoutArtifacts;
    
    // separateUnrelatedTasks NOT applied here — see the identical comment at its other call site above
    // (finalize()) for why: a half-finished feature that only logs what it extracts, never creates it, while
    // permanently deleting the steps it pulled out based on a keyword-overlap heuristic that misfires on
    // ordinary on-topic steps.

    const gated = bigProject ? steps : dropTrivialSteps(steps);
    const cleaned = dropProcessComplaintSteps(gated);
    // Also filter out any steps that describe Otto's internal retry/re-run logic, or that talk ABOUT the
    // student in third person instead of addressing them directly (both are Otto's own planning notes
    // leaking through, never a genuine to-do — see THIRD_PERSON_STUDENT_STEP's own comment).
    const noInternalOttoSteps = cleaned.filter((s) => !OTTO_INTERNAL_STEP.test(s.text) && !THIRD_PERSON_STUDENT_STEP.test(s.text));
    // Apply full contamination checking: same multi-layer filtering as during phase 1
    let filtered = dropForeignEntitySteps(task, links, noInternalOttoSteps);
    const beforeSibling = filtered.length;
    filtered = dropSiblingBleedSteps(task, siblingTasks, filtered);
    filtered = dropOffTopicStudySteps(task.taskType, filtered);
    // Domain contamination only applies strictly to study tasks
    if (task.taskType && ["learn", "review", "practice", "prepare_assessment"].includes(task.taskType) && hasDomainContamination(task.title, filtered)) {
      filtered = [];
    }
    // Title-match warning: if 0% of steps contain keywords from the task title, log warning but still keep steps
    // (a legitimate task might rephrase entirely, e.g. "Learn the Krebs cycle" → steps about mitochondria/energy)
    const kws = titleKeywords(task.title);
    if (kws.length && filtered.length) {
      const titleMatching = filtered.filter((s) => kws.some((k) => s.text.toLowerCase().includes(k))).length;
      if (titleMatching === 0) {
        // ZERO matches is suspicious — log for debugging, but still use the steps
        console.warn(`[writeStepsFromContext] title keyword warning for "${task.title.slice(0,40)}" — no steps mention task keywords (${kws.join(", ")}); might be contaminated`);
      }
    }
    // Additional check: if filtering removed MORE than half the steps, likely severe contamination —
    // reject all of them and use fallback instead (better an honest "continue working" than half-wrong steps)
    const severlyContaminated = beforeSibling > 0 && filtered.length < beforeSibling / 2;
    if (severlyContaminated && filtered.length > 0) {
      console.warn(`[writeStepsFromContext] severe contamination detected for "${task.title.slice(0,40)}" — removed ${beforeSibling - filtered.length}/${beforeSibling} steps; using fallback`);
      filtered = [];
    }

    return { steps: filtered.length ? filtered : (noInternalOttoSteps.length && !severlyContaminated ? noInternalOttoSteps : fallbackSteps), artifacts: out.artifacts || [] };
  } catch (e: any) {
    console.log(`${new Date().toISOString()} [ai] writeStepsFromContext error: ${e?.message || e}`);
    return { steps: fallbackSteps, artifacts: [] };
  }
}

/** Break ONE step down into its own small checklist — "Write the introduction" (a milestone inside a big
 *  project, but the same is useful for an ordinary step too) becomes 3-6 concrete sub-actions. On-demand
 *  only (a "Détailler cette étape" button), never generated automatically — most steps are fine as-is,
 *  and forcing every step through this would bury the plan in sub-lists nobody asked for. Persisted on
 *  the step itself by the caller (server/index.ts), not returned as throwaway chat text. */
// Evidence-based study-step shaping, injected into every prompt that generates or breaks down the
// student's own steps (writeStepsFromContext's user steps + expandStep's substeps). Rooted in established
// findings from learning science (testing effect, desirable difficulties, distributed practice,
// interleaving) — the whole point of this app's "execution" half is that doing the tasks actually makes
// the student LEARN, so the generated work must follow what research says produces learning rather than
// what merely looks organized. Kept as ONE shared const so the three surfaces can't drift apart.
export const LEARNING_SCIENCE_RULES =
  `LEARNING SCIENCE (shape the steps so they actually produce learning, not just organized busywork):\n` +
  `a) ACTIVE RECALL over re-reading: prefer steps where the student PRODUCES something (write from memory, self-explain aloud, solve a timed set). If a step says "read X", pair it with what they must DO with X (summarize X from memory, answer N questions on X).\n` +
  `b) 10-25 MINUTE CHUNKS: keep each step's minutes inside that band; something genuinely longer is either split into its natural parts or explicitly one long-haul session.\n` +
  `c) CHECKABLE doneWhen: observable and countable ("8/10 on a timed set", "two paragraphs written from memory") — never "feel ready" or "understand X".\n` +
  `d) SPACED RETRIEVAL: for memorization-heavy material (vocab, dates, formulas, verb conjugations), include ONE short re-test step ~1-3 days after the first pass (set its targetDate when the deadline allows).\n` +
  `e) PRODUCTIVE STRUGGLE FIRST: the student's own attempt comes BEFORE consulting solutions or Otto's notes — Otto's artifacts (summaries, decks) exist to be tested against, not copied.\n`;

export async function expandStep(
  task: { title: string; why: string; goal?: string; context?: string; sourceDetail?: string; sourceSubject?: string; steps?: TaskStep[] },
  step: { text: string },
  profile?: Profile,
  // Resources the TASK already found this run/prior runs (task.links) — not a fresh web_search: giving
  // this call its own tool-calling loop just to break one step into sub-actions was judged not worth the
  // extra round-trip cost/latency for what's an on-demand, single-step-scoped refinement. Instead a
  // substep may point at a link ALREADY on the task, the same "never fabricate, only ever a real url the
  // run found" discipline as writeStepsFromContext, just bounded to what's already sitting on the card
  // instead of a fresh search.
  links: TaskLink[] = [],
): Promise<{ text: string; done: boolean; url?: string }[]> {
  try {
    const client = deepseekClient();
    const linksBlock = links.length ? `\n\nRESOURCES ALREADY ON THIS TASK:\n${links.map((l) => `- ${l.label}: ${l.url}`).join("\n")}` : "";
    // Anchor the substeps in the task's FULL context — not just the title/why. Without the Definition of
    // Done (goal), the research context, the source material, and the sibling steps, the model breaks a
    // step down in a vacuum: substeps drift from the task's actual goal, duplicate work a sibling step
    // already covers, or miss a part of the DoD this step was supposed to address. Each block is included
    // only when present so a thin task (no goal/context/source) behaves exactly as before.
    const goalBlock = task.goal?.trim() ? `\nDEFINITION OF DONE: ${task.goal.trim()}\n` : "";
    const contextBlock = task.context?.trim() ? `\nCONTEXT (research already gathered for this task):\n${task.context.trim()}\n` : "";
    const sourceBlock = task.sourceDetail?.trim() ? `\nSOURCE MATERIAL (the teacher's own assignment text):\n${task.sourceDetail.trim().slice(0, 800)}\n` : "";
    const siblingSteps = (task.steps || [])
      .filter((s) => s.text !== step.text && !s.done)
      .map((s) => `- ${s.text}`)
      .join("\n");
    const siblingBlock = siblingSteps ? `\nOTHER STEPS IN THIS TASK (do not duplicate these — your substeps are for the ONE step above only):\n${siblingSteps}\n` : "";
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
      max_tokens: OUT.steps,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `TASK: "${task.title}" (${task.why})\nSTEP TO BREAK DOWN: "${step.text}"${goalBlock}${contextBlock}${sourceBlock}${siblingBlock}${linksBlock}\n\n` +
          languageLine(profile) +
      `Break this ONE step into small, concrete sub-actions the student can tick off one at a time — ` +
      `each a SHORT imperative (≤10 words), specific enough to just start doing, no vague categories like ` +
      `"plan it out". Use AS MANY or AS FEW sub-actions as the step genuinely needs: it could be one, two, ` +
      `five, or more — let the actual complexity of the step decide, not a fixed count. Never split a single ` +
          `real action into several sub-actions that just restate or narrate each other's sub-parts ("identify ` +
          `X", "replace X", "update X", "test X", "remove old X" for what's really one swap/migration) — merge ` +
          `those into however few genuinely distinct sub-actions the step actually has. This is for a STUDENT: ` +
          `every sub-step is something THEY do — never phrase the graded/` +
          `learning work itself (writing, arguing, solving) as if it were already done or as Otto's job. Stay ` +
          `strictly inside the scope of "${step.text}" — do not re-plan the whole task, only this one step.\n\n` +
          `SAME QUALITY BAR AS A REAL STEP, just smaller in scope:\n` +
          `- ORDER THEM IN THE SEQUENCE THE STUDENT WILL ACTUALLY DO THEM — whatever a later sub-action needs ` +
          `already decided or already done comes first (same dependency check as ordering full steps: "what ` +
          `must already be true to start this one?").\n` +
          `- ONE DELIVERABLE PER SUB-ACTION — if it names two separate things to produce, it's two sub-actions, ` +
          `not one joined by "and"/"then".\n` +
          `- SELF-CHECKING: the student should be able to tell, without asking anyone, whether they actually ` +
          `finished it — a concrete object or outcome, not an open-ended activity ("underline the 3 dates ` +
          `Otto's context names" beats "review the dates").\n` +
          `- NAME THE CONCRETE CUE when the context/source material gives you one — the actual page, document, ` +
          `deck, or site to open, not a generic "your notes"/"the material".\n\n` +
          LEARNING_SCIENCE_RULES + `\n` +
          `ANCHOR IN THE TASK'S CONTEXT: the substeps must serve the DEFINITION OF DONE and use the CONTEXT ` +
          `and SOURCE MATERIAL above — ground every sub-action in what this specific task actually needs, ` +
          `not a generic breakdown of the step's verb. If the DEFINITION OF DONE names specific deliverables ` +
          `or requirements, the substeps should move toward those, not toward a generic version of the step. ` +
          `Do NOT duplicate any work already covered by the OTHER STEPS listed above — your substeps are for ` +
          `this ONE step only.\n\n` +
          `If one of RESOURCES ALREADY ON THIS TASK above is exactly the page a sub-action needs, give that ` +
          `sub-action a "url" copied VERBATIM from the list — never invent or guess one, and never a url that ` +
          `isn't in that list. Most sub-actions won't have one.\n\n` +
          `Mark "automatable": true ONLY for a sub-action that's a pure lookup/research fact (a schedule, a ` +
          `price, an opening hour, an address, a definition) that needs no login and isn't the student's own ` +
          `graded/learning work — Otto can just go find the answer for those. Everything else (writing, ` +
          `deciding, arguing, practicing, anything the student has to actually do or learn) is "automatable": ` +
          `false. Most sub-actions are NOT automatable.\n\n` +
          `Return ONLY this JSON: {"substeps": [{"text": "...", "url": "..." (optional), "automatable": true|false}, ...]}.`,
      }],
    }));
    const out = firstJson<{ substeps?: ({ text?: string; url?: string; automatable?: boolean } | string)[] }>(String(res.choices?.[0]?.message?.content || ""));
    const linkUrls = new Set(links.map((l) => l.url));
    return (out?.substeps || [])
      .map((s) => {
        // Tolerate the old plain-string shape too — a live client on a stale deploy, or the model
        // reverting to the pre-url format under load, should still produce a usable substep, not nothing.
        const raw = typeof s === "string" ? { text: s } : (s || {});
        const text = String(raw.text || "").trim().slice(0, 140);
        const url = raw.url && linkUrls.has(String(raw.url)) ? String(raw.url) : undefined;
        const automatable = raw.automatable === true && !url; // a sub-action with its own url is opened, not run
        return { text, url, automatable };
      })
      .filter((s) => s.text)
      .map(({ text, url, automatable }) => ({ text, done: false, ...(url ? { url } : {}), ...(automatable ? { automatable: true } : {}) }));
  } catch { return []; }
}

/** Run ONE automatable sub-action (see expandStep's `automatable` classification): a pure lookup, not the
 *  student's own work, so it's safe to just answer with a web search + a short synthesis — no permissioned
 *  tools, no approval gate, same posture as any other read-only research the agent already does. Runs
 *  inline in the request (unlike a full step, this never needs the job queue: it's bounded, read-only,
 *  and has nothing to retry against on failure). Throws on failure — the route surfaces that as an error. */
export async function runSubstep(
  task: { title: string; why: string },
  step: { text: string },
  substep: { text: string },
  profile?: Profile,
): Promise<string> {
  const results = await webSearch(`${substep.text} ${task.title}`);
  // A genuinely empty search has nothing to answer from — don't ask the model to write a sentence about
  // that (the prompt's own "if they don't answer it, say so plainly" instruction is exactly how "The search
  // returned no results, so I cannot identify a public store registry..." ended up written INTO a substep's
  // answer field, reading as a real result instead of a failure). Fail the same honest way an empty model
  // answer already does below, so the client's existing error handling (a toast, substep stays unanswered)
  // takes over instead of a dead-end paragraph masquerading as content.
  if (!results.length) throw new Error("Otto n'a rien trouvé pour cette recherche — essaie manuellement.");
  const client = deepseekClient();
  const context = results.slice(0, 5).map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n");
  const res: any = await retryRequest(() => client.chat.completions.create({
    model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
    max_tokens: 200,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: `TASK: "${task.title}" (${task.why})\nSTEP: "${step.text}"\nSUB-ACTION TO ANSWER: "${substep.text}"\n\n` +
        `SEARCH RESULTS:\n${context}\n\n` +
        languageLine(profile) +
        `Answer the sub-action directly in 1-2 short sentences, using ONLY the search results above. If they ` +
        `don't actually answer it, say so plainly instead of guessing. No preamble, just the answer.`,
    }],
  }));
  const answer = String(res.choices?.[0]?.message?.content || "").trim().slice(0, 400);
  if (!answer) throw new Error("Otto n'a pas trouvé de réponse — essaie manuellement.");
  return answer;
}

/**
 * Reconcile a run's NARRATIVE with the artifacts that actually SURVIVED. A claim that a reply/email/message
 * was drafted is only truthful if there is a "sendable" to review + send it — Otto never sends, so the
 * sendable IS the draft's only access path; no sendable means the user has no draft, and a "Drafted a reply
 * to X" line with no Send button is a fabrication (reported live: "send email to mmachi" showed "Drafted a
 * reply to Mmachi" with nothing to send). This can happen two ways: the sendable was dropped at finalize
 * (an unresolved recipient — a bare first name), or live artifact verification pruned it (the draft the
 * model claimed doesn't actually exist in the account). Either way, strip the unbacked claim; if nothing
 * truthful remains, leave an honest "needs you" step instead of a hollow "Done for you".
 *
 * Pure + idempotent + exported — called at the end of the run (withTokens) AND again in the job layer after
 * live verification prunes artifacts (jobs.ts). Deliberately NARROW: only draft/reply/email claims (where a
 * sendable is the unambiguous proof) — it does not touch research/synthesis wording or doc claims (doc links
 * carry their own validity checks in finalize).
 */
// An EMAIL/MESSAGE claim specifically — NOT document drafting ("Drafted the proposal doc" is backed by a
// link, not a sendable, and is checked elsewhere). So: an inherently-message verb (replied/emailed/messaged),
// OR a produce verb sitting right next to a message noun (reply/email/message/response/note).
const DRAFT_CLAIM = /\b(replied|emailed|messaged)\b|\b(draft(?:ed)?|compos(?:e|ed)|prepared|wrote|sent)\b[^.]{0,40}\b(repl(?:y|ies)|e-?mails?|messages?|responses?|notes?)\b/i;

export function reconcileArtifactClaims<T extends { synthesis?: string; did?: string[]; links?: TaskLink[]; sendables?: Sendable[]; steps?: TaskStep[] }>(o: T): T {
  // Tolerate the WebTask shape too, where these are optional/undefined (the job layer passes a live task).
  if ((o.sendables?.length ?? 0) > 0) return o; // there IS a draft to send → every draft claim is backed
  const did = o.did || [];
  const didHadClaim = did.some((d) => DRAFT_CLAIM.test(d));
  if (didHadClaim) o.did = did.filter((d) => !DRAFT_CLAIM.test(d));
  const synthHadClaim = !!o.synthesis && DRAFT_CLAIM.test(o.synthesis);
  if (synthHadClaim) o.synthesis = "";
  // If we removed a draft claim and nothing real is left to show (no other synthesis/did/link and no genuine
  // user step), the run has nothing to hand back — say so honestly rather than present an empty "done" card.
  if ((didHadClaim || synthHadClaim) && !o.synthesis && !(o.did?.length) && !(o.links?.length) && !(o.steps || []).some((s) => !s.synthetic)) {
    o.steps = [...(o.steps || []), { text: "Otto couldn't draft this — open it and take it from here.", automatable: false }];
  }
  return o;
}

export function finalize(out: any, fallbackText: string, profileUpdates: ProfileUpdate[], taskTitle?: string, definitionOfDone?: string): RunOutput {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  
  // Filter out steps that start with the full task title (bad pattern - indicates internal work leaking)
  const taskTitlePrefix = taskTitle ? new RegExp(`^${taskTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,-]`, 'i') : null;
  const withoutTitlePrefix = taskTitlePrefix ? rawSteps.filter((s: any) => !taskTitlePrefix.test(s.text)) : rawSteps;
  
  // Also filter out steps that are obviously Otto's internal work (consolidate, decide, gather, identify, extract, build)
  // Noun set deliberately narrow — GENUINE Otto artifact types only (document/sheet/deck/note/flashcard/quiz/
  // reference), never generic words like "list"/"information"/"data"/"content"/"output"/"deliverable": those
  // appear constantly in completely ordinary, legitimate steps ("Research X and compile a LIST of options"
  // matched the old broader set via "compile...list", silently deleting a step the DOABLE-verb flip further
  // down exists specifically to keep — see checkStepContamination's identical comment on isResearchOperation
  // for the same failure mode via a different regex. Verified live: crashed tests/run.mjs by zeroing steps.
  const ottoInternalVerbs = /\b(consolidat\w*|decid\w*|gather\w*|identif\w*|extract\w*|build\w*|prepar\w*|organiz\w*|compil\w*|assembl\w*|collect\w*|draft\w*|generat\w*|creat\w*|mak\w*)\b[^.]*\b(documents?|sheets?|decks?|notes?|flashcards?|quiz(?:zes)?|revision|reference)\b/i;
  const withoutOttoInternal = withoutTitlePrefix.filter((s: any) => !ottoInternalVerbs.test(s.text));
  
  // filterStepsByDefinitionOfDone / separateUnrelatedTasks / a premature dropTrivialSteps are deliberately
  // NOT applied here (a "new architecture" block used to run all three at this early point, gated on
  // taskTitle+definitionOfDone) — see the identical, detailed comment a bit further down (right before the
  // contamination-filter pipeline) for why each one is unsafe: isResearchOperation() blindly rejects any
  // step starting with "Research"/"Find" regardless of context; separateUnrelatedTasks permanently deletes
  // ordinary on-topic steps via a keyword-overlap heuristic while only ever logging what it extracts; and
  // dropTrivialSteps here runs BEFORE the DOABLE-verb automatable-flip further down, so a step like "Find a
  // time that works for the team" still looks like a bare trivial lookup at this point and gets deleted
  // before the flip ever gets a chance to mark it as Otto's own work. Verified live: this exact block
  // crashed tests/run.mjs by zeroing out valid steps — twice now, in two different locations within this
  // same function, after two separate rewrites reintroduced it. artifactSeparation and the anchoring/
  // contamination pipeline below already give real protection without this false-positive risk.
  const preAnchorSteps = withoutOttoInternal;

  // Anchor steps to the task title so a model can't drift to a related-but-different noun from research.
  // Always applied — not gated on definitionOfDone, which is often undefined for manual/pronote tasks.
  const steps: TaskStep[] = anchorStepsToTask(preAnchorSteps
    .map((s: any, idx: number) => ({
      text: truncateStepText(String(s?.text || "")), // keep steps to a scannable one-liner, not a paragraph
      automatable: !!s?.automatable,
      // Valid only if it points at a REAL other step — a bad index (9 in a 3-step list, or itself)
      // would permanently block the step client-side.
      dependsOn: Number.isInteger(s?.dependsOn) && s.dependsOn >= 0 && s.dependsOn < rawSteps.length && s.dependsOn !== idx ? s.dependsOn : undefined,
      ...sanitizeStepExtras(s),
    })), taskTitle || "", 8); // keep step lists short — 3 for simple tasks, up to 8 for genuinely complex ones

  // Apply contamination filters ALWAYS — not gated on definitionOfDone (often undefined for manual/pronote
  // tasks), which left cross-contamination unchecked for the majority of real tasks.
  let filteredSteps = steps;
  // filterStepsByDefinitionOfDone NOT applied here — see its own doc comment (top of file) for why:
  // isResearchOperation() blindly rejects any step starting with "Research"/"Find" regardless of context,
  // which conflicts with the established automatable-flip design (a research-and-compile step Otto does
  // itself is legitimate, not a violation) and was verified live to crash on valid steps. The contamination
  // filters that follow below (dropForeignEntitySteps, dropSiblingBleedSteps, domain checks, etc.) already
  // give this path real protection without that false-positive risk.

  // Apply artifact separation
  const beforeArtifactCount = filteredSteps.length;
  const { filteredSteps: stepsWithoutArtifacts } = separateArtifactsFromSteps(filteredSteps);
  filteredSteps = stepsWithoutArtifacts;
  
  // Log how many artifact creation steps were filtered
  if (beforeArtifactCount !== filteredSteps.length) {
    console.log(`${new Date().toISOString()} [ai] finalize: filtered ${beforeArtifactCount - filteredSteps.length} artifact creation steps from research phase`);
  }

  // separateUnrelatedTasks NOT applied here — see the identical comment at its other call sites (finalize(),
  // writeStepsFromContext) for why: a half-finished feature (extracted "separate tasks" are only ever
  // logged, never actually created) whose keyword-overlap heuristic destructively removes ordinary on-topic
  // steps with few words in common with the title.

  // NOTE: the triviality gate does NOT run here — it runs further down (see "Triviality gate runs HERE,
  // after automatable is settled"), AFTER the DOABLE-verb flip below has had a chance to mark a step like
  // "Research X and compile a list" as Otto's own automatable work. A premature dropTrivialSteps() call used
  // to sit here too, evaluating steps BEFORE that flip — silently deleting exactly the research/compile
  // steps the flip exists to save, since they still looked like a bare trivial lookup at this earlier point.
  // Verified live: this crashed tests/run.mjs by zeroing out valid steps. Removed; the single, correctly-
  // ordered call downstream already covers this same ground.

  console.log(`${new Date().toISOString()} [ai] finalize: ${rawSteps.length} raw steps → ${withoutTitlePrefix.length} after title-prefix → ${withoutOttoInternal.length} after otto-internal → ${preAnchorSteps.length} after architecture filters → ${steps.length} after anchoring → ${filteredSteps.length} final (contamination filters)`);
  // Generic labels ("Open", "Link", a bare URL) tell the user nothing — name the artifact by its URL kind.
  const kindLabel = (url: string): string =>
    /docs\.google\.com\/document/i.test(url) ? "the Google Doc Otto created"
    : /docs\.google\.com\/spreadsheets/i.test(url) ? "the Google Sheet Otto created"
    : /docs\.google\.com\/presentation/i.test(url) ? "the slides Otto created"
    : /mail\.google\.com/i.test(url) ? "the email thread"
    : /calendar\.google\.com/i.test(url) ? "the calendar event"
    : "the linked page";
  const isJunkLabel = (s: string) => !s || /^(open|link|url|click here|view|here|document|doc)$/i.test(s.trim()) || /^https?:\/\//i.test(s.trim());
  const linksRaw: (TaskLink & { autoLabel: boolean })[] = (Array.isArray(out?.links) ? out.links : [])
    .map((l: any) => {
      const url = String(l?.url || "").trim();
      const raw = String(l?.label || "").slice(0, 80);
      const auto = isJunkLabel(raw);
      return { label: auto ? kindLabel(url) : raw, url, autoLabel: auto };
    })
    .filter((l: TaskLink & { autoLabel: boolean }) => /^https?:\/\//i.test(l.url))
    // Artifact verification: a Google Docs/Sheets/Slides link must carry a REAL document id (25+ chars of
    // id alphabet) — a made-up or truncated link would render a polished card pointing at a 404.
    .filter((l: TaskLink & { autoLabel: boolean }) => !/docs\.google\.com/i.test(l.url) || /\/(document|spreadsheets|presentation)\/(d\/)?[-\w]{25,}/i.test(l.url))
    // Never a "Gmail draft" link — Gmail has no URL for one specific draft, only the generic drafts
    // folder (mail.google.com/…/#drafts), which is useless/confusing next to the real "View draft"/Send
    // UI the sendables entry already gives. Belt-and-suspenders in case the model adds one out of habit.
    .filter((l: TaskLink & { autoLabel: boolean }) => !/mail\.google\.com.*#drafts/i.test(l.url));
  // Contamination filter BEFORE the top-3 cap below — so if a run returned one genuinely relevant link
  // alongside two unrelated ones a broad web_search happened to surface, the relevant one survives the cap
  // instead of possibly losing its slot to noise that gets dropped a moment later anyway.
  //
  // autoLabel links are EXEMPT: their label is kindLabel()'s own template text ("the Google Doc Otto
  // created", "the calendar event"), never anything the model wrote — checking it for foreign entities was
  // a real regression caught by the test suite: "Google"/"Otto" are capitalized proper nouns that will
  // essentially never appear in a task's own title/steps, so this was wrongly dropping links to artifacts
  // Otto had ACTUALLY JUST CREATED on this exact run, the most legitimate link there is.
  const modelLinks = linksRaw.filter((l) => !l.autoLabel);
  const survivingModelLinks = new Set(dropForeignEntityLinks(taskTitle || "", definitionOfDone, filteredSteps, modelLinks));
  // Relevance gate (reported live: a "download your Ledger OP3N ticket" task linking to a Mailchimp page
  // and a "Sell Luma tickets" page — DDG's loose keyword match on "luma" returned them and the model
  // dutifully listed the URLs it was handed). A web_search's OWN results are only candidates, not facts
  // about the task: a link that shares NO real word with the task's own fields and final steps is noise
  // the task card is better without, however real the URL is. Kind-label links ("the Google Doc Otto
  // created") are exempt — same reasoning as the foreign-entity exemption above.
  const stepTexts = filteredSteps.map((s) => s.text).join(" ");
  const titleWords = new Set(`${taskTitle || ""} ${definitionOfDone || ""} ${stepTexts}`.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || []);
  const relevantModelLinks = modelLinks.filter((l) => {
    if (!titleWords.size) return true;
    const linkWords = `${l.label} ${l.url}`.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
    return linkWords.some((w) => titleWords.has(w));
  });
  const cleanLinks = linksRaw
    .filter((l) => l.autoLabel || (survivingModelLinks.has(l) && relevantModelLinks.includes(l)))
    .map(({ autoLabel, ...l }) => l)
    .slice(0, 3); // original relative order preserved — autoLabel links aren't more/less important, just exempt from the check
  const sendables: Sendable[] = (Array.isArray(out?.sendables) ? out.sendables : [])
    .map((s: any): Sendable => ({
      app: s?.app === "gcal" ? "gcal" : "gmail",
      label: String(s?.label || (s?.app === "gcal" ? "Send invites" : "Send email")).slice(0, 80),
      to: s?.to ? String(s.to).slice(0, 160) : undefined,
      subject: s?.subject ? String(s.subject).slice(0, 300) : undefined,
      body: s?.body ? String(s.body).slice(0, 6000) : undefined,
      draftId: s?.draftId ? String(s.draftId).slice(0, 200) : undefined,
      attendees: Array.isArray(s?.attendees) ? s.attendees.map((a: any) => String(a).slice(0, 160)).filter(Boolean).slice(0, 50) : undefined,
      eventId: s?.eventId ? String(s.eventId).slice(0, 200) : undefined,
      summary: s?.summary ? String(s.summary).slice(0, 300) : undefined,
      when: s?.when ? String(s.when).slice(0, 120) : undefined,
    }))
    // Artifact verification: a sendable must be COMPLETE enough to review. A Gmail send needs the draft id
    // AND reviewable content (subject or body) — but NOT necessarily a visible "to": a REPLY draft usually
    // has no explicit recipient (Gmail infers it from the thread being replied to), and GMAIL_SEND_DRAFT
    // sends whatever the live draft contains, using the draft's own recipient. Requiring `to` here was
    // silently dropping EVERY reply draft — the "draft reply isn't showing the reply" bug — so it's gone;
    // the confirm dialog shows the recipient when known and falls back to "the recipient" when not. A
    // calendar invite still needs its event + attendees + what/when.
    .filter((s: Sendable) =>
      (s.app === "gmail" && !!s.draftId && !!(s.subject || s.body)) ||
      (s.app === "gcal" && !!s.eventId && !!s.attendees?.length && !!(s.summary || s.when)))
    // Never surface a Send button aimed at a FABRICATED recipient (example.com / placeholder) — the model
    // guessed an address it couldn't find. Drop it so the user isn't offered to send into the void.
    .filter((s: Sendable) => !/@example\.(?:com|org|net)\b|@(?:test|placeholder|domain|email)\.\w+|\bplaceholder\b/i.test(`${s.to || ""} ${(s.attendees || []).join(" ")}`))
    .slice(0, 6);
  // Cut at the last word boundary within the limit (never mid-word) and mark the cut with "…" so a
  // truncated bullet reads as intentionally shortened, not like a bug that ate the rest of the sentence.
  const truncate = (s: string, max: number): string => {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  };
  // Brevity backstop: a few lines + a hard char cap, so even a verbose run can't produce a wall of text.
  const brief = (s: string, lines: number, chars: number) => truncate(s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join("\n"), chars);
  // Synthesis is ONLY the structured field the model submitted — NEVER its raw reply text. Falling back
  // to the transcript is how the user ended up reading the model's THINKING ("Seems like… Let me first…
  // Now I'll create…") on the card instead of a result. And planning-tense text is not a result even when
  // it arrives in the right field — a run that only says what it WOULD do gets the honest-failure retry.
  let synthesis = brief(String(out?.synthesis || ""), 2, 260);
  const PLANNING = /\b(let me|i'?ll (?:first|now|then|use|create|draft|check)|i will (?:first|now|then)|now i(?:'?ll)? |first,? i(?:'?ll)? |seems like|my plan is|i need to|i should)\b/i;
  if (PLANNING.test(synthesis)) synthesis = "";
  // "What Otto did" bullets: same hygiene as synthesis — past-tense actions only, planning prose dropped.
  // ALSO drop dead-end bullets: a "searched X — no results / couldn't find / not found" line is NOT a
  // meaningful action to the user, it's noise about a failed attempt. This section should show only what
  // Otto actually PRODUCED or PREPPED, never a log of things that came up empty.
  const DEAD_END = /\bno (results?|matches?|contacts?|entries|records|response|reply|emails?|luck|info(?:rmation)?)\b|\bnothing (?:found|available|to)\b|\bcouldn'?t\b|\bcould not\b|\bunable to\b|\bnot? found\b|\bno .{0,20}\bfound\b|\bfailed to\b|\bwithout success\b|\bcame (?:back|up) (?:empty|with nothing)\b|\breturned (?:empty|no|nothing)\b|\b(?:empty|zero) results\b/i;
  // A fabricated placeholder recipient/fact ("name@example.com", "[email]") is worse than admitting the
  // contact is unknown — drop any bullet that leans on one, so a made-up address never reads as a real action.
  const PLACEHOLDER = /@example\.(?:com|org|net)\b|@(?:test|placeholder|domain|email)\.\w+|\[[^\]]*\b(?:email|address|name|phone|contact)\b[^\]]*\]|\bplaceholder\b/i;
  // "did" = things PRODUCED, not the looking that preceded them. A bullet that merely describes investigation
  // ("Searched Gmail for X", "Checked Contacts", "Looked through Drive", "Scrolled contacts") is a MEANS, not
  // a result — drop it. Real wins start with produce-verbs (drafted/created/wrote/updated/added/prepared/…).
  const INVESTIGATIVE = /^(searched|search|checked|check|looked|look|scrolled|scroll|browsed|scanned|scan|examined|inspected|explored|queried|tried to|attempted|reviewed|read|opened|combed|dug|hunted|retrieved|retrieve|fetched|fetch|pulled up|located|listed|list|viewed|view|got|fetching|ran|run|retried|retry|re-?ran)\b/i;
  const did: string[] = (Array.isArray(out?.did) ? out.did : [])
    .map((d: any) => {
      // Handle objects that might be returned by the AI instead of strings
      if (typeof d === 'object' && d !== null) {
        return String(d.text || d.message || d.description || JSON.stringify(d)).trim();
      }
      return String(d || "").trim();
    })
    .map((d: string) => d.replace(/^\s*[-•*]\s*/, ""))
    .filter((d: string) => d.length >= 6 && !PLANNING.test(d) && !DEAD_END.test(d) && !PLACEHOLDER.test(d) && !INVESTIGATIVE.test(d))
    .map((d: string) => truncate(d, 140))
    .slice(0, 4);
  // A purely dead-end synthesis ("searched … found none", "couldn't find …") is the same noise we strip from
  // did — if the run PRODUCED nothing (no did, no artifact), blank it so the card leads with "what's left"
  // instead of a report of what came up empty. (Kept when there IS a produced result to describe.)
  if (synthesis && !did.length && !cleanLinks.length && !sendables.length && (DEAD_END.test(synthesis) || INVESTIGATIVE.test(synthesis))) synthesis = "";
  // A synthesis that OPENS with an investigative verb ("Ran several additional Drive/Gmail queries that came
  // back empty") is meta-narration about the search PROCESS regardless of whether other work got produced
  // this run — synthesis's own tool description explicitly forbids this shape ("no explaining what you
  // couldn't do or why"). This is the field runStep (server/tasks.ts) copies verbatim into a single step's
  // own `result`, shown right under that step in the UI — observed live reaching the student that way even
  // on a run that otherwise had did/links, which the narrower blank-out above doesn't cover. Unlike the
  // blank-out above (which clears an empty-run synthesis entirely), this only strips the OPENING
  // process-narration sentence and keeps the rest, in case a later sentence has real content.
  if (synthesis && INVESTIGATIVE.test(synthesis)) {
    const rest = synthesis.replace(/^[^.!?]*[.!?]\s*/, "").trim();
    synthesis = INVESTIGATIVE.test(rest) ? "" : rest;
  }
  void fallbackText; // kept in the signature for call-site compatibility; intentionally unused as content
  // A completely empty result (no report, no steps, no artifacts) is a FAILED run, not a quiet success —
  // throwing routes it to the honest-failure path (task returns to ready + client auto-retries).
  if (!synthesis && !steps.length && !cleanLinks.length && !sendables.length) {
    throw new Error("The run produced no output — it will retry.");
  }
  // Otto-work leak check (observed live: "Create a new Google Doc…" listed as a USER step): a step that
  // starts with a doable verb and carries no judgment for the user gets flipped to automatable — Auto-do
  // then executes it instead of dumping Otto's own work on the user.
  // "Research X and compile a list" / "Find options for Y" / "Look into Z" are exactly the open-ended
  // research Otto can do itself (web_search + a doc) — missing these verbs was letting the model dodge
  // the FINISH-DON'T-HAND-BACK enforcement below by phrasing real work as a step instead of doing it.
  // (DOABLE_STEP/JUDGMENT_STEP live at module scope — runTask's own step-4 filtering reuses them too.)
  for (const s of filteredSteps) {
    if (!s.automatable && DOABLE_STEP.test(s.text) && !JUDGMENT_STEP.test(s.text) && !s.question) s.automatable = true;
  }
  // Triviality gate runs HERE, after automatable is settled — a step already flipped to Otto's own job by
  // the DOABLE check above is fine even if it started with "Research"/"Find"; only a step still left to
  // the STUDENT that's nothing but a deferred lookup or bare "open the site" gets dropped (see the "Chercher
  // les horaires de train" live report this closes: a step the model should have searched for itself, not
  // handed back as a to-do). `const filteredSteps` can't be reassigned, so mutate in place like the stale-filter below.
  const detrivialized = dropTrivialSteps(filteredSteps);
  filteredSteps.length = 0; filteredSteps.push(...detrivialized);
  // Never list DONE work as remaining: a step that near-duplicates a did-bullet is stale planning residue.
  const stale = (txt: string) => did.some((d) => {
    const a = new Set(txt.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const b = new Set(d.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const inter = [...a].filter((w) => b.has(w)).length;
    return a.size > 2 && inter / a.size >= 0.7;
  });
  const cleanedSteps = filteredSteps.filter((s) => !stale(s.text));
  filteredSteps.length = 0; filteredSteps.push(...cleanedSteps);
  // Checklist backstop: artifacts with NO steps and NO sendable leave the user without a "what's left"
  // list — the report the card promises. Deterministically add "Review <artifact>" so the checklist can
  // never be absent when something was produced. (Sendables don't need it: the send button IS the next action.)
  if (!filteredSteps.length && !sendables.length && cleanLinks.length) {
    for (const l of cleanLinks.slice(0, 2)) filteredSteps.push({ text: `Review ${l.label}`.slice(0, 80), automatable: false, url: l.url, synthetic: true });
  }
  // Follow-up tasks the run discovered — distinct new obligations that each deserve their own task. Capped
  // and validated; the run loop turns these into real tasks the sweep/kick then executes.
  const followUps = (Array.isArray(out?.follow_ups) ? out.follow_ups : Array.isArray(out?.followUps) ? out.followUps : [])
    .map((f: any) => ({ title: String(f?.title || "").trim().slice(0, 90), why: String(f?.why || "").trim().slice(0, 200) }))
    .filter((f: { title: string; why: string }) => f.title.length >= 4)
    .slice(0, 2);
  const title = out?.title ? String(out.title).trim().slice(0, 90) : undefined;
  // Backstop the model's own "omit when..." instructions rather than trust them blindly: only keep
  // firstAction when there's actually a real user step left to unblock, and never for a big project (a
  // milestone list already sets the direction — see FIRST ACTION in this same function's step-4 prompt).
  // 90, not the default: firstAction is a UI badge/nudge, not a step — deliberately tighter than a step's
  // own backstop, not a leftover from before truncateStepText's default was widened.
  const firstActionText = out?.firstAction?.text ? truncateStepText(String(out.firstAction.text), 90) : "";
  const firstActionMinutes = Number(out?.firstAction?.minutes);
  const firstAction = (firstActionText && !out?.isBigProject && filteredSteps.some((s) => !s.automatable)) ? {
    text: firstActionText,
    ...(Number.isInteger(firstActionMinutes) && firstActionMinutes >= 1 && firstActionMinutes <= 10 ? { minutes: firstActionMinutes } : {}),
  } : undefined;
  return {
    // The context schema promises "2-4 bullets" (the "context" field's own description above) but this kept only the
    // first 2 lines and cut the total at 380 chars — silently dropping bullets 3-4 outright regardless of
    // content, and chopping even 2 real bullets mid-sentence for anything substantive (reported live: a
    // Pronote assignment's context cut off at "...The three…" losing the actual focus-questions bullet).
    // 4 lines / 900 chars actually matches what was promised instead of quietly reneging on it.
    context: brief(String(out?.context || ""), 4, 900),
    // Fallback only when there's genuinely nothing to say: "Done." if the run left no open steps, else a
    // neutral placeholder (never "Done." on a task that still needs the user — that would misread as finished).
    synthesis: synthesis || (!EXECUTION_ENABLED && filteredSteps.length ? "Gathered context and broke this into steps." : filteredSteps.some((s) => !s.done) ? "" : "Done."),
    did,
    steps: filteredSteps,
    links: cleanLinks,
    sendables,
    profileUpdates,
    ...(followUps.length ? { followUps } : {}),
    ...(title ? { title } : {}),
    ...(typeof out?.isBigProject === "boolean" ? { isBigProject: out.isBigProject } : {}),
    ...(firstAction ? { firstAction } : {}),
    ...(out?.taskType ? { taskType: out.taskType } : {}),
    ...(out?.goal ? { goal: out.goal } : {}),
    ...(out?.infoRequirement ? { infoRequirement: out.infoRequirement } : {}),
    ...(out?.unknowns ? { unknowns: out.unknowns } : {}),
  };
}

export function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
