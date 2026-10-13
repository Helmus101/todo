
import type { TaskStep, TaskLink, TaskArtifact, SeparateTask } from "../../shared/types.ts";


// Temporary: Otto does the reversible PREP work (research, outline steps, create a resource doc, draft an
// email) but never does anything irreversible (send, post, delete, calendar-write) — every action that
// touches someone else or can't be undone is left for the user to trigger themselves. Flip back to true to
// restore full auto-execution of every reversible action too. Nothing execution-related is deleted, just
// gated: only sends/calendar-writes/updates-to-existing-docs are withheld from the agent (see runTask).
export const EXECUTION_ENABLED = false;

/** Backstop for step text — NOT a length editor. The prompt asks for a short one-liner (≤8 words ordinary,
 *  ≤10 for milestones); when the model complies, this is a no-op. When it doesn't, a mid-sentence chop
 *  (with or without "…" tacked on) reads as broken either way — a step should be concise OR complete, never
 *  a fragment presented as finished. So this only steps in on a genuinely pathological, far-oversized
 *  output (`max` is generous, well beyond any real one-liner) — and even then it cuts at the last COMPLETE
 *  sentence it can find (a period/!/?), never mid-clause, so what's left always reads as a whole thought,
 *  just a shorter one. Normal over-by-a-few-words output (the common case) passes through untouched. */
export function truncateStepText(text: string, max = 220): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastSentenceEnd > 30) return cut.slice(0, lastSentenceEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Validate a raw step's url/question/options/minutes exactly the same way regardless of which pass produced it.
 * NOTE: doneWhen, difficulty, checkpoint are NOT included here — the AI no longer generates them for steps.
 * They belong on the main task's Definition of Done (task.goal), not on individual subtasks. */
export function sanitizeStepExtras(s: any): Pick<TaskStep, "url" | "question" | "options" | "needsPermission" | "minutes"> {
  const minutes = Number(s?.minutes);
  return {
    url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : undefined,
    question: s?.question ? String(s.question).trim().slice(0, 200) : undefined,
    options: Array.isArray(s?.options) ? s.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 4) : undefined,
    needsPermission: !!s?.needsPermission,
    minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 240 ? minutes : undefined,
  };
}

/** Rough token-overlap similarity between two step texts (Jaccard over words >3 chars) — used ONLY to
 *  reattach a draft step's url/question/options to its corresponding step after the refinement pass, since
 *  that pass reorders, merges, splits, and rewords steps (and in the big-project branch replaces them with
 *  milestones entirely) — so the step at the same INDEX has no reliable relationship to the original. */
function stepTextTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3));
}

export function bestMatchingStep(text: string, candidates: TaskStep[]): TaskStep | undefined {
  const target = stepTextTokens(text);
  if (!target.size) return undefined;
  let best: TaskStep | undefined, bestScore = 0;
  for (const c of candidates) {
    const cTokens = stepTextTokens(c.text);
    if (!cTokens.size) continue;
    const inter = [...target].filter((t) => cTokens.has(t)).length;
    const union = new Set([...target, ...cTokens]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : undefined; // below this, two step texts don't genuinely describe the same action
}

// A step that just hands the student a lookup instead of doing it — "Look up train times", "Cherche les
// horaires" — is a FAILURE of PREP EVERY USER STEP TO THE MAX (the search is one tool call, do it now, see
// the run prompt), not a legitimate step. MUST be bilingual: languageLine() makes steps FRENCH by default,
// so an English-only pattern (matching the existing DEAD_END/INVESTIGATIVE style elsewhere in this file)
// would fire on almost no real French student. Anchored with ^ so it only matches the LEADING verb, never
// a mid-sentence "check" ("Check with your teacher..." must survive — see TRIVIAL_EXEMPT below).
const SEARCH_INSTRUCTION = /^(look\s?up|search(?:\s+for)?|google|find out|research|check\s+(?:the\s+)?(?:opening hours|prices?|times?|schedules?|weather)|see if|figure out)\b|^(cherch(?:e|er|ons)?|recherch(?:e|er|ons)?|renseigne[- ]?(?:toi|nous)|regarde\s+(?:si|les?\s+(?:horaires|prix|tarifs))|v[ée]rifie[rz]?\s+(?:les?\s+)?(?:horaires|prix|tarifs)|trouve[rz]?)\b/i;

// Bare navigation ("Open X", "Go to the site") is sanctioned ONLY with a url attached — see the run
// prompt's OPENING A PAGE rule, which explicitly wants "open X" steps as long as the real URL is on them.
// Without one it's the same "go find out" failure as SEARCH_INSTRUCTION, just phrased as a destination
// instead of a query.
const BARE_NAVIGATION = /^(open|go to|visit|consult|browse|access|navigate to)\b|^(ouvr(?:e|ir|ons)|va(?:s)?[- ]y|va sur|consulte[rz]?|acc[èe]de[rz]?\s+[àa])\b/i;

// Legitimate steps that would otherwise false-positive on the patterns above: checking with a real human
// ("Check with your teacher which title is allowed") is genuine student work, not a deferred search; and
// opening/consulting something OTTO ITSELF PREPARED (a fiche, a deck, a quiz) is navigation to a resource
// that already exists in-app, not a lookup Otto dodged.
// "to"/"à" are too common (any infinitive, any "hand X to Y") to exempt on their own — bare "to"/"à" within
// reach of "teacher"/"prof" wrongly exempted genuine lookups like "Look up when to submit forms to the
// teacher" (the "to" there is "submit forms TO", not "ask/defer TO"). Require an actual deferral verb
// immediately before "to"/"à"; "with"/"ask"/"from" stay bare since those prepositions are far less
// ambiguous ("ask the teacher", "check with the teacher", "hear from the teacher" are always deferral).
const TRIVIAL_EXEMPT = /\b(with|ask|from|(?:talk|speak|refer|report|turn|reach out|defer)\s+to)\b.{0,20}\b(teacher|prof(?:esseur)?e?s?|supervisor|tutor|coordinator|parent|classmate)\b|\b(avec|aupr[èe]s de|(?:parle|r[ée]f[èe]re[rz]?|adresse[- ]toi)\s+[àa])\b.{0,20}\b(prof(?:esseur)?e?s?|enseignant|superviseur|camarade|parent)\b|\b(fiche|note|flashcards?|cartes?|quiz|checklist|r[ée]vision|revisions)\b/i;

// BARE_NAVIGATION is only trivial WITHOUT a url — "Open sncf-connect.com" with a url set is exactly what
// the run prompt's OPENING A PAGE rule wants; without one it's the same "go find out" as SEARCH_INSTRUCTION.
export const isTrivialStep = (text: string, url?: string): boolean =>
  !TRIVIAL_EXEMPT.test(text) && (SEARCH_INSTRUCTION.test(text) || (BARE_NAVIGATION.test(text) && !url));

/** Historically also glued the full task title onto any step whose text didn't literally repeat one of
 *  the title's own significant words (a crude cross-task-contamination guard). Removed after TWO separate
 *  real reports of it firing on entirely legitimate steps: a title phrased as an artifact-production
 *  instruction ("Build X flashcards and Y quiz") or a plain decision ("Cancel or keep Docusign now the
 *  30-day trial ended") naturally produces per-step instructions that don't repeat the title's own
 *  vocabulary — "Note the exact next billing date", "Compare that count with free alternatives" — because
 *  they're worded naturally, not because they drifted onto a different task. In the Docusign case exactly
 *  half the steps failed the keyword check, which is well within normal variation for a well-written step
 *  list, not a signal of contamination; raising the mismatch threshold further would just move where the
 *  next false positive lands rather than fix the underlying unreliability of keyword-overlap as a drift
 *  signal. Genuine cross-task contamination (a different task's content actually bleeding in) is now
 *  caught by the more targeted, evidence-based checks that run later in the same pipeline —
 *  dropForeignEntitySteps (flags steps naming a person/place absent from the task's own title/why/
 *  sourceDetail) and dropSiblingBleedSteps — so this function no longer needs to also guess at it. Kept as
 *  a thin passthrough (rather than removed outright) since several call sites still use it for the
 *  truncate + sanitizeSteps + maxCount-cap bundle. */
export function anchorStepsToTask(steps: TaskStep[], _title: string, maxCount: number): TaskStep[] {
  const truncated = steps.map((step) => ({ ...step, text: truncateStepText(String(step.text || "")) }));
  return sanitizeSteps(truncated, maxCount);
}

export function sanitizeSteps(steps: TaskStep[], maxCount: number): TaskStep[] {
  return steps
    .filter((s) => s.text)
    // Filter out illegitimate self-email steps ("Draft an email summary to the user", "Email yourself")
    .filter((s) => !/\b(draft|send|write|email)\b[^.]{0,30}\b(email|summary|update|findings)\b[^.]{0,30}\b(to (the )?user|to yourself|to me)\b/i.test(s.text))
    .slice(0, maxCount);
}

/** The triviality gate itself — called AFTER a step's final `automatable` value is settled (finalize's
 *  DOABLE/JUDGMENT flip, or writeStepsFromContext's direct model value), because "Research X and compile
 *  a list" is a legitimate step Otto will do itself once flipped automatable — only a step that's actually
 *  being LEFT to the student, and is nothing but a deferred lookup or bare navigation, gets dropped. */
export function dropTrivialSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter((s) => {
    if (s.automatable) return true;
    const trivial = isTrivialStep(s.text, s.url);
    if (trivial) console.log(`${new Date().toISOString()} [ai] dropped trivial step: "${s.text}"`);
    return !trivial;
  });
}

/** Step 4's prompt says "never include artifact-creation steps (flashcards/quiz/note creation — that's
 *  handled separately)", but nothing verified it, and live it is plainly violated: a "Build flashcards and
 *  quiz for figures de style" task shipped with step 1 = "Build flashcards (definition, mechanism, example)
 *  for each figure" sitting directly above the flashcard deck Otto had ALREADY built for that exact task.
 *  The student is handed a to-do that is already done — the single most visible way a plan looks like it
 *  wasn't grounded in the task at all.
 *
 *  Deliberately narrow, because this file's history is full of keyword deletion filters that "zeroed out
 *  valid steps": a step is only dropped when it is a create-verb aimed at an artifact noun AND an artifact
 *  of that same kind actually exists on this run AND dropping it leaves at least one step standing. So
 *  "Build flashcards for each figure" goes only when there is a real deck; "Review the flashcards" (no
 *  create verb) and "Build a packing list" (no artifact noun) always stay. */
const ARTIFACT_STEP_VERB = /^(build|create|make|write|prepare|assemble|generate|draft|produce|put together)\b/i;

const ARTIFACT_STEP_NOUNS: Record<"note" | "flashcards" | "quiz", RegExp> = {
  note: /\b(note|notes|fiche|fiches|summary sheet|revision sheet|study sheet)\b/i,
  flashcards: /\b(flashcards?|flash cards?|cartes m[ée]moire|card deck|deck of cards)\b/i,
  quiz: /\b(quiz|quizzes|self-?test|practice test|questionnaire)\b/i,
};

export function dropRedundantArtifactSteps(
  steps: TaskStep[],
  created: { note?: boolean; flashcards?: boolean; quiz?: boolean },
): TaskStep[] {
  const kept = steps.filter((s) => {
    const text = String(s.text || "");
    if (!ARTIFACT_STEP_VERB.test(text.trim())) return true;
    for (const kind of ["note", "flashcards", "quiz"] as const) {
      if (created[kind] && ARTIFACT_STEP_NOUNS[kind].test(text)) {
        console.log(`${new Date().toISOString()} [ai] dropped step duplicating an artifact Otto already made: "${text}"`);
        return false;
      }
    }
    return true;
  });
  // Never empty the plan out over a wording coincidence — that is exactly the failure mode the deleted
  // keyword gates kept hitting. If every step looked redundant, the plan is the problem, not these steps.
  return kept.length ? kept : steps;
}

/** The flip side of dropRedundantArtifactSteps: a deck or quiz Otto made is only worth anything if the plan
 *  actually sends the student to USE it — otherwise it sits as a chip on the card while the steps say
 *  "Revise chapter 4", and the artifact reads as useless. Appends at most one drill step (deck) and one
 *  check step (quiz) when no step already points at it, with an honest time estimate; never grows a plan
 *  past 6 steps. Pure, so it's testable without the live pipeline. */
const ARTIFACT_USE_RE = /flash ?cards?|cartes?|deck|paquet|quiz|qcm/i;

export function ensureArtifactUseSteps(
  steps: TaskStep[],
  created: { decks?: { title: string; count: number }[]; quizzes?: { title: string; count: number }[] },
  fr: boolean,
): TaskStep[] {
  const out = [...steps];
  const mentions = (title: string) => out.some((s) => ARTIFACT_USE_RE.test(s.text) || s.text.toLowerCase().includes(title.toLowerCase().slice(0, 25)));
  const deck = created.decks?.[0];
  if (deck && out.length < 6 && !mentions(deck.title)) {
    out.push({
      text: fr ? `Réviser les cartes « ${deck.title.slice(0, 40)} » jusqu'à toutes les avoir justes` : `Drill the "${deck.title.slice(0, 40)}" flashcards until every card is right`,
      automatable: false, minutes: Math.min(45, Math.max(5, Math.round(deck.count * 1.5))),
    });
  }
  const quiz = created.quizzes?.[0];
  if (quiz && out.length < 6 && !out.some((s) => /quiz|qcm/i.test(s.text))) {
    out.push({
      text: fr ? `Faire le quiz « ${quiz.title.slice(0, 40)} » sans notes, puis revoir les erreurs` : `Take the "${quiz.title.slice(0, 40)}" quiz without notes, then review what you missed`,
      automatable: false, minutes: Math.min(30, Math.max(5, Math.round(quiz.count * 1.5))),
    });
  }
  return out;
}

/** A step's url may only ever be one the research actually returned. Left ungated, "attach a link" is an
 *  open invitation to emit a plausible-looking store or booking URL from memory — the same fabrication the
 *  step text's own GROUNDING rule exists to stop, except a wrong link is worse than a wrong sentence: it
 *  looks authoritative and the student clicks it. Anything not in the task's own link list is stripped;
 *  the step itself survives without it. Compared host+path so a tracking query string or a trailing slash
 *  isn't treated as a different page. */
export function canonicalUrl(url: string): string | undefined {
  try {
    const u = new URL(String(url));
    return `${u.hostname.replace(/^www\./i, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return undefined; }
}

export function restrictStepUrlsToLinks(steps: TaskStep[], links: TaskLink[]): TaskStep[] {
  const allowed = new Map<string, string>();
  for (const l of links) { const c = canonicalUrl(l.url); if (c) allowed.set(c, l.url); }
  return steps.map((s) => {
    if (!s.url) return s;
    const c = canonicalUrl(s.url);
    const match = c ? allowed.get(c) : undefined;
    if (match) return { ...s, url: match };
    console.log(`${new Date().toISOString()} [ai] stripped an invented step link: "${s.url}"`);
    const { url: _dropped, ...rest } = s;
    return rest as TaskStep;
  });
}

/** Keep only steps that the step-writer itself tied to a numbered part of the definition of done — with a
 *  floor, because a plan is never worth emptying out over this. If fewer than 2 steps would survive, the
 *  model's part-numbering is more likely broken than the whole plan is, so the original list stands. */
export function dropUnanchoredSteps(steps: TaskStep[], isAnchored: (text: string) => boolean): TaskStep[] {
  const kept = steps.filter((s) => isAnchored(s.text));
  return kept.length >= 2 ? kept : steps;
}

/** Carry step 4's structured extras (url / question / options / minutes) across the plan-repair pass, which
 *  returns text + automatable only. Without this, a repaired plan silently loses the clickable link or the
 *  inline question a step was carrying. Matched on token overlap rather than exact text because repair is
 *  explicitly allowed to reword and to split one step into two. */
function stepTokens(text: string): Set<string> {
  return new Set(String(text || "").toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || []);
}

export function reattachStepExtras(repaired: TaskStep[], original: TaskStep[]): TaskStep[] {
  const originalTokens = original.map((s) => stepTokens(s.text));
  return repaired.map((step) => {
    const tokens = stepTokens(step.text);
    if (!tokens.size) return step;
    let best = -1;
    let bestScore = 0;
    originalTokens.forEach((other, i) => {
      if (!other.size) return;
      let shared = 0;
      for (const t of tokens) if (other.has(t)) shared++;
      const score = shared / new Set([...tokens, ...other]).size;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0 || bestScore < 0.5) return step;
    const { url, question, options, needsPermission, minutes } = original[best];
    return { ...step, ...(url ? { url } : {}), ...(question ? { question } : {}), ...(options ? { options } : {}), ...(needsPermission ? { needsPermission } : {}), ...(minutes ? { minutes } : {}) };
  });
}

/** validateStepAgainstDefinitionOfDone/filterStepsByDefinitionOfDone/isResearchOperation/isInternalOttoWork
 *  used to live here — a keyword-matching gate meant to delete steps that don't relate to the task. Deleted
 *  (not just left disabled): it was never actually reachable in the live pipeline (every real call site had
 *  been deliberately disabled, one by one, after each was "verified live to crash tests/run.mjs by zeroing
 *  out valid steps" — isResearchOperation in particular deleted legitimate research/compile steps that the
 *  automatable-flip design (see finalize's DOABLE/JUDGMENT pass) exists to convert into Otto's own work,
 *  not reject outright), and one remaining call site (regenerateStepsWithScaffolding) had drifted out of
 *  sync with its own neighboring comment and was calling it anyway. Real DoD alignment is now checked a
 *  fundamentally different way — see runTask's own post-hoc DoD verification pass (a semantic check via
 *  one small model call, not a keyword-overlap heuristic that can't tell "unrelated" from "phrased
 *  differently than the title"). isArtifactCreationStep (below) is kept — it has its own real caller. */

/**
 * Identifies steps about creating Otto's artifacts that should not be user steps.
 */
function isArtifactCreationStep(stepText: string): boolean {
  const artifactPatterns = [
    /\b(create|make|build|generate|draft|write|compile|assemble|prepare|organize|extract)\s+(outline|summary|reference|checklist|evidence\s+bank|research\s+notes|revision\s+sheet|study\s+guide|flashcards?|quiz|practice\s+questions|fiche|brief|deck|presentation|document|doc|sheet|list|content|information|data|definitions|examples|effects)\b/i,
    /\b(create|make|build|generate|draft|write|compile|assemble|prepare|organize|extract)\s+(a\s+)?(note|brief|fiche|deck|presentation|document|doc|sheet|list)\b/i,
    /\b(build|create|draft|write|make)\s+(a\s+)?(revision|study|vocab|vocabulary|reference)\s+(sheet|list|guide|bank)\b/i,
    /\b(extract|gather|collect|compile)\s+(content|information|data|definitions|examples|effects)\s+(from|into)\b/i,
    // French — the app defaults to French, so English-only patterns miss "Créer des flashcards", "Faire une fiche", etc.
    /\b(cr[ée]er?|faire|construire|g[ée]n[ée]rer|pr[ée]parer|r[ée]diger|élaborer|extraire|compiler|rassembler)\s+(?:une?\s+|des\s+|d['e]\s*)?(flashcards?|quiz|guide\s+d['e]tude|r[ée]f[ée]rence|plan|checklist|r[ée]sum[ée]|banque\s+de\s+preuves|note|fiche|brief|contenu|informations?|donn[ée]es?|d[ée]finitions?|exemples?)\b/i,
  ];
  return artifactPatterns.some(pattern => pattern.test(stepText));
}

/**
/**
 * NEW ARCHITECTURE: Separate artifacts from steps
 * Identifies items that should be artifacts rather than user steps.
 */
export function separateArtifactsFromSteps(
  steps: TaskStep[],
  existingArtifacts: TaskArtifact[] = []
): { filteredSteps: TaskStep[]; artifacts: TaskArtifact[] } {
  const filteredSteps: TaskStep[] = [];
  const artifacts: TaskArtifact[] = [...existingArtifacts];

  for (const step of steps) {
    const stepText = step.text.toLowerCase();
    
    // Check if this is about creating an artifact (bilingual — app defaults to French)
    if (/\b(create|make|build|draft|write|cr[ée]er?|faire|construire|r[ée]diger|élaborer)\s+(?:une?\s+|des\s+|d['e]\s*)?(outline|summary|reference|checklist|evidence\s+bank|research\s+notes|plan|r[ée]sum[ée]|r[ée]f[ée]rence|banque\s+de\s+preuves|notes\s+de\s+recherche)\b/i.test(stepText)) {
      // Extract artifact type
      let type: TaskArtifact["type"] = "other";
      if (/outline/i.test(stepText)) type = "outline";
      else if (/summary/i.test(stepText)) type = "summary";
      else if (/reference/i.test(stepText)) type = "reference";
      else if (/checklist/i.test(stepText)) type = "checklist";
      else if (/evidence\s+bank/i.test(stepText)) type = "evidence_bank";
      else if (/research\s+notes/i.test(stepText)) type = "note";

      const artifact: TaskArtifact = {
        title: step.text,
        type,
        status: "needed",
        description: `To be created by Otto before user steps`,
      };
      
      // Check if this artifact already exists
      const exists = artifacts.some(a => a.title.toLowerCase() === stepText);
      if (!exists) {
        artifacts.push(artifact);
        console.log(`${new Date().toISOString()} [ai] extracted artifact: "${step.text}"`);
      }
    } else {
      filteredSteps.push(step);
    }
  }

  return { filteredSteps, artifacts };
}

/**
 * NEW ARCHITECTURE: Separate unrelated tasks
 * Identifies steps that should be separate tasks rather than steps in the current task.
 */
export function separateUnrelatedTasks(
  steps: TaskStep[],
  currentTaskTitle: string
): { filteredSteps: TaskStep[]; separateTasks: SeparateTask[] } {
  const filteredSteps: TaskStep[] = [];
  const separateTasks: SeparateTask[] = [];

  for (const step of steps) {
    const stepText = step.text.toLowerCase();
    const titleLower = currentTaskTitle.toLowerCase();

    // Check if this step is about a completely different topic
    const stepKeywords = stepText.split(/\s+/).filter(w => w.length > 3);
    const titleKeywords = titleLower.split(/\s+/).filter(w => w.length > 3);
    
    const hasOverlap = stepKeywords.some(sk => 
      titleKeywords.some(tk => sk.includes(tk) || tk.includes(sk))
    );

    if (!hasOverlap && stepText.length > 10) {
      // This looks like a separate task
      const separateTask: SeparateTask = {
        title: step.text,
        reason: "Discovered during research but unrelated to current task",
      };
      separateTasks.push(separateTask);
      console.log(`${new Date().toISOString()} [ai] extracted separate task: "${step.text}"`);
    } else {
      filteredSteps.push(step);
    }
  }

  return { filteredSteps, separateTasks };
}

/**
 * Cleanup function: remove artifact creation steps from existing tasks
 * This is for migrating old tasks that have persisted artifact creation steps.
 */
export function cleanupArtifactCreationSteps(steps: TaskStep[]): TaskStep[] {
  const cleaned = steps.filter(step => !isArtifactCreationStep(step.text));
  if (cleaned.length !== steps.length) {
    console.log(`${new Date().toISOString()} [ai] cleanup: removed ${steps.length - cleaned.length} artifact creation steps from existing task`);
  }
  return cleaned;
}

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "your", "you",
  "this", "that", "is", "are", "be", "it", "its", "from", "at", "into", "about", "up", "check", "make", "sure",
  "prepare", "review", "update", "complete", "finish", "verify", "create", "find", "get", "do", "not", "if"]);

/** Significant (non-generic) words from a task title, for a cheap "did the model even stay on-topic?" check. */
export function titleKeywords(title: string): string[] {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Structural drift backstop: do MOST steps mention a real word from the task title? Catches both wholesale
 *  topic drift (a title about a competition, steps entirely about reorganizing Drive folders) AND partial
 *  bleed-in (research swept up 2-3 UNRELATED email threads it happened to read along the way, and each got
 *  turned into its own step — observed live: task "Send media coverage requests for Paris Model Congress"
 *  came back with steps about replying to an unrelated Playbac invitation AND a separate message to "Kaan"
 *  about a student network, alongside the one genuinely on-topic step). A single-step match used to be
 *  enough to pass the WHOLE array, so 1-related-of-3 sailed through. Requiring a MAJORITY catches that while
 *  staying lenient enough that legitimately-phrased steps (which won't all repeat the title's exact nouns)
 *  don't false-positive: any task with just one step is trivially 100%. Skips entirely when the title has no
 *  distinctive words to match against (avoids false positives on short titles).
 *
 *  STRICTLY greater than half, not >=: observed live, a manual task "Reply to Denis with thanks" came back
 *  with exactly 2 steps — one about "consolidating Drive files and Gmail messages related to 'Denis'" (an
 *  entirely different, invented deliverable) and one legitimately on-topic — an exact 1-of-2 tie that the
 *  old >= 0.5 let sail through as "matching" even though the comment above already called for a MAJORITY,
 *  which a 50/50 split isn't. */
export function stepsMatchTitle(title: string, steps: { text: string }[]): boolean {
  const kws = titleKeywords(title);
  if (!kws.length || !steps.length) return true;
  const matching = steps.filter((s) => { const t = s.text.toLowerCase(); return kws.some((k) => t.includes(k)); }).length;
  return matching / steps.length > 0.5;
}

// Observed live: a task titled "Prepare for the Wharton Investment Competition" came back with steps ALL
// about moving files between Drive folders — one step happened to name-drop a file called "Wharton
// Investment Notes", which was enough to pass stepsMatchTitle's loose keyword check even though the
// content is pure folder housekeeping, not competition prep. This is the narrower, targeted pattern for
// that exact drift: the agent apparently found a relevantly-named FILE during research and fixated on
// organizing where it lives instead of using what's in it.
const FOLDER_HOUSEKEEPING_STEP = /\b(move (the |this |that )?[\w\s]{0,40}?\bfile|create (a |the )?['"]?\w*['"]? ?folder|folder (exists|contains)|organi[sz]e (the |your )?(files?|folders?|drive)|clean(ing)? up (the |your )?(drive|folder))\b/i;

/** Is EVERY step pure Drive folder/file housekeeping, on a task that isn't actually ABOUT organizing files? */
export function isFolderHousekeepingDrift(title: string, steps: { text: string }[]): boolean {
  if (!steps.length) return false;
  if (/\b(organi[sz]e|folder|clean ?up|file management|sort (my|the) files)\b/i.test(title)) return false; // legitimately about this
  return steps.every((s) => FOLDER_HOUSEKEEPING_STEP.test(s.text));
}

// Defense in depth for runTask's artifact-creation gate (STEP 5): taskType alone (an upstream AI
// classification, fixable but not infallible — see the taskType enum-sync fix elsewhere in this file)
// shouldn't be the ONLY thing standing between a misclassified task and an irrelevant flashcard deck.
// Observed live: "Prepare Oslo trip: confirm purpose, dates, bookings" got tagged taskType
// "learn_understand" upstream and, on the strength of that alone, got a 13-card flashcard deck — a real-
// world coordination outcome has nothing drillable in it. This checks the DEFINITION OF DONE's own
// wording directly: if it reads as a booking/coordination/decision outcome (not memorizable content),
// veto flashcards/quiz regardless of what taskType or the model's own artifact judgment said.
const COORDINATION_OUTCOME_DOD = /\b(book(ed|ing)?|confirm(ed|ing)?|decide[ds]?|decision|refund(ed)?|replace(d|ment)?|schedul(ed|ing)?|arrang(ed|ing|ement)?|reserv(ed|ation)?)\b/i;

const MEMORIZABLE_CONTENT_DOD = /\b(formula|formule|equation|[ée]quation|definition|d[ée]finition|vocab|vocabulary|vocabulaire|grammar|grammaire|conjug|tense|verbe?|noun|adjective|adverb|element|[ée]l[ée]ment|compound|compos[ée]|reaction|r[ée]action|theorem|th[ée]or[èe]me|principle|principe|rule|r[èe]gle|memoris|memoriz|drill|flashcard)\b/i;

/** Does this DEFINITION OF DONE read as a real-world booking/coordination/decision outcome rather than
 *  something with actual discrete facts to memorize? Used to veto flashcards/quiz independently of
 *  taskType — see the comment above. */
export function dodLooksLikeCoordinationOutcome(definitionOfDone: string): boolean {
  return COORDINATION_OUTCOME_DOD.test(definitionOfDone) && !MEMORIZABLE_CONTENT_DOD.test(definitionOfDone);
}

// Otto-work leak check, module-scope so both runTask's step-4 filtering and finalize() share the same
// definition: a step starting with a doable verb and carrying no judgment word for the user is Otto's own
// work ("Research X and compile a list" / "Find options for Y"), not a to-do to dump on the student.
export const DOABLE_STEP = /^(create|draft|write|update|add|fill|schedule|search|compile|prepare|generate|make|research|find|look up|look into|gather|collect|identify|explore|investigate|list|build|assemble|organize|categorize|sort)\b/i;

export const JUDGMENT_STEP = /\b(choose|decide|pick|confirm|approve|review|prefer|want|which|verify|check with|sign|pay)\b/i;

// A step that narrates OTTO'S OWN RUN/TOOL STATE instead of something the STUDENT should do — observed live
// patterns include: "Enable or reconnect a create/write tool — this run was in plan-only mode",
// "Rerun the Sheets content reads, which were blocked this run", "Rerun the web search, which was
// unavailable this run", "Open Settings in your account" (follow-on from reconnect), "Find the connected
// apps or tools section", "Confirm it is connected, then rerun task", "Re-run this task with a write tool
// enabled". None of these are legitimate student to-do items — they describe Otto's own internal state.
const PROCESS_COMPLAINT_STEP = new RegExp(
  "\\b(?:" +
  // Original patterns
  "no (?:write|create|creation)\\b[^.]{0,30}\\btool\\b" +
  "|tool (?:was|is|wasn'?t) (?:not )?available" +
  "|re-?run (?:this|the) task" +
  "|once (?:a |the )?(?:creation|write) tool is enabled" +
  "|recreate the missing\\b" +
  "|no (?:document|note|deck|email) was produced this run" +
  // New patterns observed live in the bug above
  "|(?:enable|reconnect|re-?connect)\\b[^.]{0,50}\\b(?:create|write|creation)\\b[^.]{0,30}\\btool" +
  "|plan.only mode" +
  "|this run was in plan.only" +
  "|(?:blocked|unavailable|not available) this run" +
  // "Rerun the Sheets content reads ... this run" / "Rerun the web search ... this run"
  "|re-?run the \\w[\\w\\s]{0,30}(?:reads?|searches?|lookups?|content|data)\\b" +
  // Settings reconnect substeps
  "|add (?:one|it|a tool) in settings before re-?run" +
  "|settings before re-?run" +
  "|find the connected (?:apps?|tools?)\\b" +
  "|(?:enable|reconnect|re-?connect) (?:a |the )?(?:create|write|creation|connected) tool" +
  "|confirm it is connected,? then re-?run" +
  ")\\b",
  "i",
);

// Steps that describe Otto preparing/gathering inputs for the task, rather than the student's actual path
// through the task. Keep this intentionally general: the product rule is "Otto prepares; the user acts."
const APP_PREP_STEP = /\b(?:build|create|make|prepare|draft|compile|fetch|pull|open|search|look up|find|check|read|scan|review|re-?run|retry)\b[^.]{0,100}\b(?:reference sheet|study material|source material|existing material|spreadsheet|folder|drive|doc(?:ument)?|remaining pages?|web searches?|queries|search results?|write tool|create tool|no write tool|this run|before drafting|before creating|before preparing)\b/i;

const CONNECTION_HEALTH_STEP = /\b(?:reconnect|re-?connect|sign in|open settings|settings)\b[^.]{0,120}\b(?:pronote|gmail|google|drive|calendar|connected app|session expired|broken connection|homework and tests|inbox|account)\b/i;

export function dropProcessComplaintSteps<T extends { text: string }>(steps: T[]): T[] {
  return steps.filter((s) => !PROCESS_COMPLAINT_STEP.test(s.text) && !APP_PREP_STEP.test(s.text) && !CONNECTION_HEALTH_STEP.test(s.text));
}

// Steps that are clearly admin/communication/announcement work on a task that is a STUDY type — observed
// live: a "Revise French figures de style" task (review) came back with steps about "parent letters",
// "Natalie La Balme", "EJM calendar", "staff announcement" because the research pass read unrelated school
// admin emails. These steps never belong on a study-type task regardless of what the model found while
// researching. Applied only when taskType is a known study type so it can't accidentally fire on a task
// that genuinely IS about communication (e.g. "Write parent letter for EJM transition").
const ADMIN_COMM_STEP = /\b(parent\s+letters?|announcement\s+(message|email|draft|text|letter)|school\s+office|contact\s+(email|address|the\s+school|the\s+teacher|teacher\s+contact)|send\s+(a\s+)?(short\s+)?(message|email|letter)\s+(asking|to\s+ask|to\s+confirm|confirming)|ask\s+for\s+a\s+reply\s+deadline|staff\s+(announcement|update|email|meeting|memo)|website\s+update|transition\s+timeline\s+wording|internal\s+staff|confirm\s+with\s+(the\s+)?school\s+whether|official\s+\w+\s+(calendar|handbook)\s+or|handover\s+wording|parallel\s+internal)\b/i;

// Otto's internal/setup steps that should never appear in the student's task list (not their actual work)
export const OTTO_INTERNAL_STEP = /^(re-?run|re-?fetch|re-?read|retry|re-attempt|re-execute|re-query|reconnect|enable|open\s+settings|approve|sign\s+in)\s+/i;

// A step written in THIRD PERSON about "the student"/"the user" ("Confirm with the student which…", "Ask the
// user whether…") is Otto's own internal planning note leaking through — never a genuine to-do, since a real
// step addresses the reader directly (imperative "Confirm which…", or "you"), not as someone else being
// discussed. Observed live: "Confirm with the student which French/English course track... is being taken" on
// a task the STUDENT is themselves looking at — nonsensical as a to-do (they'd be confirming with themselves).
export const THIRD_PERSON_STUDENT_STEP = /\b(the\s+student|the\s+user)\b/i;

export const STUDY_TASK_TYPES = new Set<string>(["learn_understand", "review", "practice", "prepare_assessment", "homework_problem_set"]);

/** On a known study-type task, strip steps that are clearly admin/communication/announcement work — almost
 *  always bleed-in from an unrelated email or calendar item read during research. Not applied to non-study
 *  tasks (write/research/project/admin) where some of those actions may genuinely be on-topic. */
export function dropOffTopicStudySteps<T extends { text: string }>(taskType: string | undefined, steps: T[]): T[] {
  if (!taskType || !STUDY_TASK_TYPES.has(taskType)) return steps;
  return steps.filter((s) => !ADMIN_COMM_STEP.test(s.text));
}

// Capitalized single words that are common in step/artifact text but aren't proper-noun ENTITIES worth
// checking (sentence starters, weekday/month names, Otto's own name, generic time words) — excluded so the
// entity heuristic below doesn't flag ordinary sentences.
const ENTITY_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "otto", "today", "tomorrow", "tonight", "next", "start",
  "open", "read", "write", "send", "check", "review", "finish", "complete", "prepare", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may",
  "june", "july", "august", "september", "october", "november", "december",
  // Common imperative step-starting verbs — steps in this app are always phrased as instructions ("Contact
  // X about Y", "Follow up with Z"), so the sentence-leading verb routinely sits right next to a real name
  // and would otherwise greedily merge into the entity span (e.g. "Follow Cardin Foundation" instead of just
  // "Cardin Foundation"), or get flagged as its own bogus single-word entity.
  "follow", "contact", "email", "call", "text", "ask", "tell", "remind", "confirm", "book", "buy", "pay",
  "attend", "join", "submit", "upload", "download", "print", "sign", "schedule", "cancel", "draft", "reply",
  "message", "notify", "invite", "meet", "visit", "bring", "return", "pick", "drop", "set", "plan", "add",
  "remove", "update", "fix", "look", "find", "gather", "collect", "organize", "continue", "keep", "take",
  "give", "share", "post", "publish", "go", "get",
]);

/** Extract proper-noun-like spans (1-3 consecutive capitalized words, e.g. "Pierre Cotteau", plus
 *  specific dates/times) from a piece of text. Deliberately simple/interpretable, no NER model,
 *  same posture as every other pattern-matching backstop in this file. */
function extractEntities(text: string): string[] {
  const out: string[] = [];
  // Capitalized phrases (proper nouns, names, places)
  const matches = text.match(/\b[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2}\b/g) || [];
  for (const m of matches) {
    const words = m.split(/\s+/);
    let start = 0, end = words.length;
    while (start < end && ENTITY_STOPWORDS.has(words[start].toLowerCase())) start++;
    while (end > start && ENTITY_STOPWORDS.has(words[end - 1].toLowerCase())) end--;
    const trimmed = words.slice(start, end);
    if (trimmed.length) out.push(trimmed.join(" "));
  }
  // Also extract specific dates/times (e.g. "September 21", "2:00 PM", "Sept 24") — these are often
  // cross-task contaminators when multiple tasks reference different dates
  const dateMatches = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Oct|Nov|Dec)\s+\d{1,2}|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/gi) || [];
  out.push(...dateMatches);
  return [...new Set(out)]; // dedupe
}

function textMentionsEntity(haystack: string, entity: string): boolean {
  return haystack.toLowerCase().includes(entity.toLowerCase());
}

/** Cross-task contamination backstop: a step (or artifact title) naming a SPECIFIC person/place/
 *  organization that appears NOWHERE in the task's own title/why/sourceDetail/links is very likely bleed-in
 *  from an unrelated thread the research pass happened to read along the way — observed live: a Math AA HL
 *  task's steps included "Contact Pierre Cotteau de Simencourt about the IEO France finals date" and "Start
 *  the 19th arrondissement sampling/data collection", real obligations from OTHER tasks, not this one. The
 *  research `context` a run reads from is, by definition, where this pollution originates (it legitimately
 *  contains snippets from other threads the model read along the way), so it can't be used as the allowlist
 *  here — only the task's own already-scoped fields can. Drops flagged items individually (same posture as
 *  dropTrivialSteps) rather than rejecting the whole batch: most items in a contaminated draft are still
 *  legitimate, and an entity absent from title/why isn't necessarily wrong (a name first surfaced by
 *  legitimate research, e.g. a teacher's name in the énoncé, is caught by including sourceDetail below). */
export function dropForeignEntitySteps<T extends { text: string }>(task: { title: string; why: string; sourceDetail?: string }, links: TaskLink[], steps: T[]): T[] {
  // Deliberately NOT including `links` in the allowlist (a prior version did): a link found during broad
  // research can ALREADY be the contaminated thing — the model reading an unrelated Gmail thread and adding
  // it to "links" as something it found, then a step naming that same person passes this check simply
  // because its own contaminated link vouches for it. Observed live: a "figures de style" task's steps
  // included "Decide whether to reply to the Julien Tafanel thread" — unrelated to the task, but the run's
  // own links apparently already carried that name in, so the old links-inclusive allowlist let it through.
  // Only the task's OWN known facts (never anything the run itself found) are trustworthy as an allowlist.
  void links; // kept in the signature — every call site already has it handy, and it may earn a narrower use later
  const allow = `${task.title} ${task.why} ${task.sourceDetail || ""}`;
  return steps.filter((s) => {
    // The FIRST word of a step is its sentence-leading imperative verb ("Analyse les schémas…", "Ouvre le
    // manuel…", "Contact Pierre…") — capitalized in French exactly like a proper noun would be, and the
    // English-only verb list in ENTITY_STOPWORDS can't cover every verb in either language ("Analyze"
    // slipped through in English, wrongly dropping a legitimate step; in French — this app's PRIMARY
    // audience — virtually every step starts with an uncovered verb, so this filter was quietly deleting
    // ENTIRE legitimate French step lists and tripping the severe-contamination fallback on them). Skip the
    // first word before entity extraction: a genuine multi-word foreign name is still caught (its later
    // words survive the skip — "Pierre Cotteau…" → "Cotteau…" still matches the regex), and a foreign
    // single-word name in first position is the sibling-bleed check's (dropSiblingBleedSteps) job to
    // catch — not worth trading the entire French-language step UX for.
    const body = s.text.replace(/^\S+\s+/, "");
    return extractEntities(body).every((e) => textMentionsEntity(allow, e));
  });
}

/** Same cross-task-contamination backstop as dropForeignEntitySteps, applied to "links" instead of steps —
 *  reported live: a TOK reading-prep note carrying a "Foreign relations of India ↗" link, and a Paris-
 *  Versailles race-bib note carrying "Pat Cleveland ↗" and "Paris Marathon ↗" links, none remotely related
 *  to either task. `links` never got this check at all — only URL-shape validation (a real Google Docs id,
 *  no bare Gmail-drafts link) — so a web_search call that surfaced tangentially-related or outright
 *  unrelated pages during broad research sailed straight through as long as the model dutifully followed
 *  the "always include the URLs you found" instruction, with nothing checking those URLs were actually
 *  ABOUT this task. Checked against the label only (a URL slug rarely contains a readable proper noun) —
 *  and against the task's own trusted fields + its FINAL steps text, same allowlist reasoning as the step
 *  version: never `out.context`/`synthesis`, which is where this contamination originates in the first
 *  place and so can't vouch for itself. */
export function dropForeignEntityLinks<T extends { text: string }>(taskTitle: string, definitionOfDone: string | undefined, steps: T[], links: TaskLink[]): TaskLink[] {
  const allow = `${taskTitle} ${definitionOfDone || ""} ${steps.map((s) => s.text).join(" ")}`;
  return links.filter((l) => extractEntities(l.label).every((e) => textMentionsEntity(allow, e)));
}

/** Cross-task bleed backstop #2, alongside dropForeignEntitySteps above: that check only catches steps
 *  naming a capitalized proper-noun ENTITY absent from this task's own fields — it misses bleed-in with no
 *  such entity, observed live on the SAME incident its own comment cites: a "Prep for Math HL prior
 *  knowledge test" task whose steps included "Scout the 19th arrondissement — the 7th is started..." (no
 *  capitalized entity: ordinals aren't proper nouns) and "Push Otto to classmates (app is ready...)" ("Otto"
 *  is in ENTITY_STOPWORDS on purpose, since the app's own name shows up constantly in legitimate steps).
 *  Both are real content from OTHER tasks in the SAME account ("Scout the 19th arrondissement" belongs to a
 *  door-to-door/canvassing task; "Push Otto to classmates" to a promote-the-app task) — the strongest signal
 *  available for exactly this failure is comparing a step's own vocabulary against the account's OTHER real
 *  tasks, not just against a fixed entity allowlist. Deliberately requires a CLEAR win for another task
 *  (own overlap is zero while some sibling scores >=2 shared keywords, or a sibling beats the task's own
 *  score by >=2) so ordinary generically-phrased steps ("Draft the outline", "Get feedback") — which
 *  legitimately share little vocabulary with a short title — are never penalized for being unspecific; only
 *  dropped when a REAL sibling task is a demonstrably better match. Titles/why only for siblings (never
 *  links/artifacts/sourceDetail) — this is a post-hoc filter over already-generated text, never fed back
 *  into the model's own context, so it can't itself become a new leak vector. */
function stepBleedKeywords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function keywordOverlap(words: string[], allow: string): number {
  const allowWords = new Set(stepBleedKeywords(allow));
  return words.filter((w) => allowWords.has(w)).length;
}

/** Shared scoring for both step text and artifact titles below: does this text's own vocabulary match some
 *  SIBLING task clearly better than it matches the task it's supposedly for? Same conservative "clear win
 *  only" bar as the callers' own doc comments — a short/generic/empty text never counts against itself. */
function bleedsToSibling(text: string, task: { title: string; why: string; sourceDetail?: string }, siblingTasks: { title: string; why?: string }[]): boolean {
  const words = stepBleedKeywords(text);
  if (!words.length) return false;
  const ownScore = keywordOverlap(words, `${task.title} ${task.why} ${task.sourceDetail || ""}`);
  let bestSibling = 0;
  for (const sib of siblingTasks) {
    const score = keywordOverlap(words, `${sib.title} ${sib.why || ""}`);
    if (score > bestSibling) bestSibling = score;
  }
  return (ownScore === 0 && bestSibling >= 1) || (bestSibling >= ownScore + 1);
}

export function dropSiblingBleedSteps<T extends { text: string }>(
  task: { title: string; why: string; sourceDetail?: string },
  siblingTasks: { title: string; why?: string }[],
  steps: T[],
): T[] {
  if (!siblingTasks.length) return steps;
  return steps.filter((s) => !bleedsToSibling(s.text, task, siblingTasks));
}

/** Same cross-task bleed check as dropSiblingBleedSteps, applied to an ARTIFACT's title (note/flashcard
 *  deck/quiz) instead of a step's text — the entity-based check already run against artifact titles
 *  (extractEntities, alongside `finalize`'s callers) misses the same non-proper-noun bleed dropSiblingBleedSteps
 *  exists to catch for steps (e.g. a note titled "19th Arrondissement Canvassing Plan" attached to a Math AA
 *  HL task has no capitalized entity absent from the task's own fields, but obviously belongs to a different,
 *  real task in the account). */
export function dropSiblingBleedTitles<T extends { title: string }>(
  task: { title: string; why: string; sourceDetail?: string },
  siblingTasks: { title: string; why?: string }[],
  items: T[],
): T[] {
  if (!siblingTasks.length) return items;
  return items.filter((it) => !bleedsToSibling(it.title, task, siblingTasks));
}

/**
 * Stage 14b: Semantic Domain Contamination — detect when steps belong to a completely different task domain.
 * ONLY applies to study tasks (learn/review/practice/prepare_assessment).
 * Write/research/project tasks legitimately mix domains (research + admin + creativity).
 * Returns true if STUDY steps seem completely off-topic.
 */
export function hasDomainContamination(taskTitle: string, steps: TaskStep[]): boolean {
  const task = `${taskTitle}`.toLowerCase();

  // Only check contamination for study tasks — those should be pure academic domain
  const isStudyTask = /study|learn|understand|practice|revision|exam|prepare.*for|review.*for/i.test(task);
  if (!isStudyTask) return false; // Write/research/project tasks can mix domains legitimately

  // For study tasks: they should be MOSTLY academic, not mostly admin/communication
  const academicMarkers = /study|learn|understand|analyze|essay|assignment|homework|exam|revision|practice|concept|theory|principle|technique/i;
  const adminMarkers = /email|contact|confirm|verify|send|communication|letter|announcement|schedule|meeting/i;

  let stepAdminCount = 0, stepAcademicCount = 0;
  for (const step of steps) {
    const text = String(step.text).toLowerCase();
    if (adminMarkers.test(text)) stepAdminCount++;
    if (academicMarkers.test(text)) stepAcademicCount++;
  }

  if (steps.length < 2) return false;

  // For study tasks: if >50% are admin/communication and few are academic, that's contamination
  return stepAdminCount > steps.length * 0.5 && stepAdminCount > stepAcademicCount;
}
