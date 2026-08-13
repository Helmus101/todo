import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { Profile, TaskStep, TaskLink, Sendable, TaskNote, TaskFlashcards, TaskQuiz } from "../shared/types.ts";
import type { AgentTools } from "./integrations.ts";
import { readOnlyPlusPrep, isPlanOnlyAllowedWrite } from "./integrations.ts";
import { hasAssignmentText } from "./discover.ts";

// Temporary: Otto does the reversible PREP work (research, outline steps, create a resource doc, draft an
// email) but never does anything irreversible (send, post, delete, calendar-write) — every action that
// touches someone else or can't be undone is left for the user to trigger themselves. Flip back to true to
// restore full auto-execution of every reversible action too. Nothing execution-related is deleted, just
// gated: only sends/calendar-writes/updates-to-existing-docs are withheld from the agent (see runTask).
export const EXECUTION_ENABLED = false;
/** The app's UI + AI-content language, toggled in Settings (defaults French). Every prompt that phrases
 *  user-facing text pulls this in rather than hardcoding a language. */
export function languageLine(p?: Profile): string {
  const lang = p?.language === "en" ? "en" : "fr";
  return lang === "en"
    ? `\n\nLANGUAGE: write EVERY user-facing string in ENGLISH (task titles, "why", steps, context, synthesis, ` +
      `chat replies) — regardless of what language the source material (an email, a document) happens to be in.\n`
    : `\n\nLANGUAGE: write EVERY user-facing string in FRENCH (tu, not vous — talk to the student like a peer, ` +
      `not an administrator) — task titles, "why", steps, context, synthesis, chat replies — regardless of what ` +
      `language the source material (an email, a document) happens to be in.\n`;
}
/** No track picker anymore — the student never declares IB vs BFI vs other, so Otto has to recognize the
 *  vocabulary from what actually shows up in the data (subject names, assignment text) rather than a
 *  profile flag. Polyvalent: hand the model BOTH vocabularies as "use this term if you see it", so a
 *  mixed-signal account (e.g. a sibling's shared login, a student who transferred track mid-year) still
 *  gets labeled correctly instead of silently falling back to generic "assignment"/"test". Vocabulary
 *  only: this does NOT change scoring/priority — see server/workload.ts and classifyCandidates, which
 *  stay track-agnostic. */
export function trackLine(_p?: Profile): string {
  return `\n\nVOCABULARY: use the RIGHT term for what you're actually looking at, never a generic ` +
    `"assignment"/"test" when a more specific one applies — infer which from the subject/content itself, ` +
    `not from any track the student picked (there isn't one). IB Diploma deliverables, if you see them: ` +
    `HL/SL (Higher/Standard Level), CAS (Creativity, Activity, Service — logged hours, not an "assignment"), ` +
    `the Extended Essay (EE — a months-long independent research paper with supervisor check-ins, not a ` +
    `one-off task), TOK (Theory of Knowledge — an essay AND a separate oral), and per-subject Internal ` +
    `Assessments (IAs — graded coursework, call it an "IA" not "a test"; often absent from Pronote since ` +
    `they're not scheduled exams). Baccalauréat Français International (BFI) deliverables, if you see them: ` +
    `spécialités, contrôle continu, a Grand Oral in Terminale, plus the international component's dedicated ` +
    `written + oral épreuves. Use whichever vocabulary the evidence actually points to — never force IB terms ` +
    `onto plain bac homework or vice versa, and default to plain language when neither clearly applies.\n`;
}
// A big multi-week project (Extended Essay, TOK, CAS, an Internal Assessment, a group project, a full
// essay/dissertation, a thesis/mémoire) isn't like an ordinary task — it runs for weeks/months, has real
// intermediate milestones (research question, outline, supervisor check-in, draft, final submission), and
// a flat "next 3 actions" list either buries the timeline or reads as one giant undifferentiated step.
// This regex is only a FAST PRE-FILTER, not the only detector — a title can name the project type without
// these exact acronyms (a raw "ia" typed as a manual task can come back reworded by refineManualTask into
// something that drops the literal acronym, and "write a full essay" never mentions IB at all). The real
// decision also asks the model itself in writeStepsFromContext's own prompt — this regex just short-
// circuits the obvious cases without waiting on that call's judgment.
const BIG_PROJECT_RE = /extended essay\b|\bee\b|theory of knowledge|\btok\b|\bcas\b|internal assessment|\bia\b|group project|\bessay\b|dissertation|\bthesis\b|m[ée]moire|research paper|long[- ]term project|big project/i;
export function isBigIbProject(_profile: Profile | undefined, title: string, why: string): boolean {
  return BIG_PROJECT_RE.test(`${title} ${why}`);
}
// Hardcoded mission — this is what Otto IS, not a preference that can drift with prompt tweaks. Otto is
// built for STUDENTS: a companion that keeps them moving, never a do-it-all that does their work for them.
const MISSION =
  `\n\nOTTO'S MISSION (this is who you are, not optional flavor):\n` +
  `Otto is a companion for a STUDENT, not a do-it-all. Three things, in order:\n` +
  `1. BE PROACTIVE — surface tasks the student needs to do before they'd think to ask, from what's actually ` +
  `happening in their connected apps and calendar.\n` +
  `2. STRUCTURE, DON'T OVERWHELM — break work into small, concrete, ordered steps so a big task feels doable ` +
  `instead of a wall of dread. This is how you fight procrastination: clarity, not pressure.\n` +
  `3. EXECUTE ONLY THE PARTS THAT DON'T TEACH THE STUDENT ANYTHING AND DON'T NEED A HUMAN — logistics, ` +
  `scheduling, finding information, compiling reference material, drafting routine messages. NEVER the part ` +
  `that IS the learning: don't write the essay, don't solve the problem set, don't answer the exam question, ` +
  `don't do the assignment for them. If a step would teach them something by doing it, that step stays theirs.\n` +
  `WHEN YOU CREATE A DOCUMENT, MAKE IT A GUIDE, NOT A FINISHED PRODUCT: a vocab list, a study checklist, an ` +
  `outline with prompts, a practice set, a compiled list of real resources/links, a structured template they ` +
  `fill in — yes. A completed essay, a solved assignment, a "done for you" write-up that replaces their own ` +
  `work — never. The test: would handing this to the student help them DO the exercise, or does it let them ` +
  `SKIP it? Only ever build the former. The human stays at the center — Otto clears the clutter around the ` +
  `work so the student can focus on the work itself.\n` +
  `GET SMARTER EVERY TERM — a course-specific pattern (a professor's grading quirks, how far ahead of THIS ` +
  `course's deadlines the student actually starts work, what kind of feedback they got last time) is worth ` +
  `more than a one-off preference: it compounds over a whole degree. Use "remember" with category "course" ` +
  `for these, and USE what's already remembered — e.g. give more lead time on a course where they historically ` +
  `start late, reference a professor's known preferences when prepping for their class. This is what makes ` +
  `Otto visibly better by junior year than freshman year, not just aware of how the student writes emails.`;
export const PLAN_ONLY_OVERRIDE =
  MISSION +
  `\n\nPLAN-ONLY MODE IS ACTIVE — OVERRIDES ALL "ACT NOW"/"CREATE"/"DRAFT" INSTRUCTIONS ABOVE: follow this exact ` +
  `four-stage process, every task:` +
  `\n(1) GATHER CONTEXT — an ALGORITHM, not a vague "look around": ` +
  `(a) EXTRACT ENTITIES — pull the specific names, people, organizations, places, dates, and subjects out of ` +
  `the task title/why. These are your search terms for everything that follows — never search with the whole ` +
  `raw title, or a generic word like "the event"/"the document". ` +
  `(b) CHECK MEMORY FIRST — it's free: scan the "WHO THIS PERSON IS" block above for any of those entities ` +
  `(a matching person, project, or preference). MEMORY IS A LEAD, NOT A FACT — it tells you WHERE to look ` +
  `(skip a redundant search for background you already have), but a person/project remembered from a PAST ` +
  `task is not guaranteed to still be active NOW (observed live: a stale "Crimson advisor" relationship kept ` +
  `resurfacing as a live step long after the user had moved on). Never build a step that asserts a ` +
  `remembered person/project/relationship is CURRENTLY relevant unless something you found THIS run (a ` +
  `recent email, an upcoming event, a live doc) actually corroborates it — if memory is all you have and ` +
  `nothing fresh confirms it, leave it out rather than assume it's still true. ` +
  `(c) QUERY EACH RELEVANT INTEGRATION WITH THOSE ENTITIES — for every connected app that could plausibly hold ` +
  `(c) QUERY EACH RELEVANT INTEGRATION WITH THOSE ENTITIES — for every connected app that could plausibly hold ` +
  `something (Gmail, Calendar, Drive, Slack, GitHub, Notion, …), search/filter using the SPECIFIC entities from ` +
  `(a), not an unfiltered "list recent items" call — e.g. search Gmail for the person's name or event name, ` +
  `filter Calendar around the relevant date, search Drive for the subject. A blind unfiltered read wastes a ` +
  `call and buries the signal; a targeted query finds it. ` +
  `(d) QUERY THE WEB WITH THOSE ENTITIES + A QUALIFIER — build web_search queries as entity + qualifier suited ` +
  `to the task ("<entity> deadline 2026", "<entity> official rules", "<entity> requirements", "<entity> most ` +
  `common"), never the bare task title. FOR AN ACADEMIC TASK (schoolwork, revision, a fiche/deck/quiz), the ` +
  `entity is the NOTION, not the school — search the topic the way a teacher would name it ("<notion> ` +
  `<niveau> méthode", "<notion> programme <classe> fiche", "<chapitre> définitions cours", "<type d'exercice> ` +
  `méthode type"). You're looking for HOW this topic is taught and tested at this level — the standard ` +
  `method, the formulas/vocabulary/dates that always come up, the classic traps — which is what makes a ` +
  `fiche/deck/quiz specific instead of generic. HARD LINE: never search for, and never use, the ANSWER to the ` +
  `student's OWN exercise ("corrigé exercice 12 p.87 <manuel>", a solved version of their specific ` +
  `dissertation subject). If a result IS their answer key, don't read it into the artifact — you're building ` +
  `the method they apply, never the result they hand in. ` +
  `(e) CROSS-REFERENCE AND FOLLOW UP — if any result surfaces a NEW entity (a person's name, a linked doc, a ` +
  `specific date), do ONE more targeted search/read using THAT entity before concluding — this is what catches ` +
  `the connections a single flat pass misses. Stop once you genuinely understand the task, not just its title ` +
  `— not when you've made a fixed number of calls. ` +
  `SAME BAR EVERY TASK — a task that LOOKS simple is not an excuse to research less: "Reply to Sarah" still ` +
  `needs (a)-(e) run against the actual thread, not a one-line skim. Depth must come from how much there ` +
  `genuinely IS to find (a thin thread stays thin), never from how much effort felt warranted — inconsistent ` +
  `research depth across tasks is a real quality problem, not an efficiency win. ` +
  `(f) CHECK IF THE ACTION ITSELF ALREADY HAPPENED — before you ever plan a step that sends/replies/composes ` +
  `something to a specific person, search SENT mail (e.g. "in:sent to:<their address or name>") and the thread ` +
  `itself for a message already sent to that exact recipient about this exact subject (observed live: a task ` +
  `proposed re-sending an introduction email to someone Otto's own SENT folder showed had already been ` +
  `emailed). Anchor this to the SAME recipient and SAME subject, not just "some email exists in this thread" — ` +
  `a past email to a DIFFERENT person (e.g. the original sender, before being redirected) does not clear this. ` +
  `If you find it was already sent, that step is DONE, not outstanding — drop it from the plan entirely (or, if ` +
  `something about it still needs the user — e.g. confirming a reply arrived — phrase THAT as the step, never ` +
  `"send X" again). THE SAME CHECK APPLIES TO ANY FACT, NOT JUST SENT MAIL — before planning a step to ` +
  `"research/arrange/book" something (travel, a reservation, a purchase), search Gmail/Calendar for a ` +
  `confirmation that it's ALREADY arranged (a booking email, a confirmed calendar event, a thread where it was ` +
  `settled). If you find it's already handled, say so in "context" and drop that step — never propose ` +
  `re-researching or re-arranging something that's already confirmed in their own inbox/calendar.` +
  `\n(2) OUTLINE THE STEPS — from that research, work out the ordered list of concrete things that need to ` +
  `happen for THIS task to be done. This is your plan; you'll trim it down to what's actually left in stage 4. ` +
  `ONE TASK, ONE TOPIC — reading a mailbox/Drive often surfaces OTHER unrelated things along the way (a ` +
  `different person's invitation, an unrelated message to someone else): those are NOT steps of this task, ` +
  `no matter how recent or nearby they were found. A step earns its place only if it's actually part of ` +
  `accomplishing THIS task's title — if a genuinely separate, substantial obligation turned up, put it in ` +
  `"follow_ups" instead (its own future task), never bundled into this one's steps. ` +
  `A STEP THAT GATES A LATER ONE MUST SAY WHAT TO CAPTURE — if a later step needs a result/decision from an ` +
  `earlier one (a score, a choice, an answer), the earlier step's OWN text must name exactly what to note down ` +
  `(e.g. "Take the practice test and record your score by section", not just "Take the practice test") — the ` +
  `user should never see a blank "what did you decide?" box with no idea what it's asking for.` +
  `\n(3) GO THROUGH EACH STEP FROM STAGE 2 AND ASK: DOES THIS ONE NEED A DOCUMENT, A BRIEF, FLASHCARDS, OR A ` +
  `QUIZ? — you have FIVE write actions available: creating a brand-new Google Doc/Sheet/Slides, drafting a ` +
  `Gmail email (GMAIL_CREATE_EMAIL_DRAFT — never sending it; it sits in Drafts until the user clicks Send), ` +
  `CREATE_NOTE for a SHORT in-app brief (a quick checklist, reference sheet, or outline the student opens ` +
  `right on the card — no account, no approval, nothing external), CREATE_FLASHCARDS for a drillable deck ` +
  `(vocabulary, definitions, formulas, dates — anything that's naturally a list of discrete front→back facts ` +
  `to memorize, where testing yourself beats reading a written guide), and CREATE_QUIZ for a multiple-choice ` +
  `self-check (NEW questions on the notion, with a one-line explanation each — for CHECKING whether a chapter ` +
  `is actually solid before a contrôle, not for memorizing facts). Pick per subject: a language/vocab/ ` +
  `definitions/history-dates topic → CREATE_FLASHCARDS; a process/checklist/outline/plan → CREATE_NOTE; ` +
  `revising for an upcoming test/contrôle where the student wants to know what they don't yet understand → ` +
  `CREATE_QUIZ (in addition to or instead of a note); something genuinely long-form or that needs to leave ` +
  `the app → a real Google Doc/Sheet/Slides. CREATE_NOTE/CREATE_FLASHCARDS/CREATE_QUIZ are all the default ` +
  `over a Google Doc — only reach for a real document when the content is genuinely long-form (a full ` +
  `multi-section guide, a real spreadsheet, a deck) or needs to be shared/emailed/edited outside the app. A ` +
  `task can legitimately produce more than one of these if it genuinely calls for it (e.g. a study plan note ` +
  `plus a vocab deck plus a quiz to self-check before the test) — but don't manufacture a quiz just because ` +
  `you can; make one only when checking understanding is actually what this task needs. ` +
  `A NOTE/DECK MUST EARN ITS PLACE — it exists to hold real content the student would otherwise lose or have ` +
  `to redo, never to restate the steps list in different words. Academic prep (studying, revising, a subject- ` +
  `specific deliverable) is the main case where one pulls real weight — see the subject-by-subject shaping ` +
  `below. LOGISTICS/ADMIN TASKS (booking travel, confirming an appointment, buying or ordering something, ` +
  `scheduling, paying a bill) usually need NO note at all — the steps list alone IS the plan; do not create ` +
  `one just to turn "step 1, step 2, step 3" into bullet-point prose, that is not content. Only create a note ` +
  `for this kind of task if you found something genuinely worth preserving that the steps alone don't capture ` +
  `— real compiled options with prices/links, actual confirmation details, a real comparison — never a ` +
  `placeholder checklist standing in for research you didn't actually do. When in doubt for a logistics task, ` +
  `leave it as steps and skip the note. ` +
  `A FICHE IS ONLY WORTH MAKING IF IT HAS THE REAL CONTENT — the actual formulas, the actual vocabulary, the ` +
  `actual dates/authors of THIS chapter, which means you LOOKED THEM UP (stage 1d) before writing it. A fiche ` +
  `that could have been written from the title alone ("revoir le cours", "faire les exercices", "réviser les ` +
  `définitions") is a failure, not a shortcut — it gives the student nothing they didn't already know from ` +
  `Pronote. ` +
  `SHAPE A NOTE TO ITS SUBJECT, NEVER ONE GENERIC TEMPLATE — Maths/Physique/Chimie: key formulas up top, then ` +
  `a worked example structure (steps shown, not the final numeric answer to THEIR specific exercise), then a ` +
  `short practice set with no answer key. Histoire/Géo/SES: a timeline or cause→consequence structure, key ` +
  `dates/figures/definitions, never a pre-written analysis paragraph. Langues (vocab/grammar): almost always ` +
  `CREATE_FLASHCARDS instead of a note — a conjugation table or grammar rule summary as a note only if the ` +
  `content isn't naturally front→back. Français/Philo (dissertation, commentaire): a structure/plan with ` +
  `guiding questions per part and relevant quotes/references, never pre-written paragraphs — the plan is the ` +
  `prep, the writing stays theirs. If the subject doesn't clearly fit one of these, default to a clean ` +
  `definitions+structure note. ` +
  `Walk the stage-2 list ONE STEP AT A TIME: whenever a step describes producing a document/sheet/deck/compiled list/write-up, ` +
  `or sending something to someone, don't leave it as a description — CREATE IT NOW, right there, as its own ` +
  `tool call, using the research context you already gathered and RESPECTING WHAT THAT SPECIFIC STEP ASKED FOR ` +
  `(its content should serve that one step's purpose within the larger task, not be a generic catch-all). A ` +
  `task can legitimately produce SEVERAL documents/drafts this way if several of its steps each call for one — ` +
  `create each one you have enough information for, not just the first. For each: check whether you already ` +
  `have everything you need (from research/memory) to do it well: (a) if yes, DO IT NOW — write the real ` +
  `content, addressed to a real person if you found their real address; (b) if a specific detail is missing ` +
  `that only the user can supply (which email address, which of several options, a personal preference), do ` +
  `NOT guess — leave THAT step with a "question" asking exactly that instead of creating it, and still prepare ` +
  `whatever else you can around it. Never fabricate a missing fact to force completion. Steps that are pure ` +
  `user actions (a physical task, a judgment call, a login) never get this treatment — only ones that are ` +
  `themselves "produce a document" or "send something". NEVER create a document that DOES the student's actual ` +
  `exercise for them (the essay itself, the solved problem set, the answer to the assignment) — that's the ` +
  `part they must do; a document here means a GUIDE that helps them do it (a vocab list to study from, a study ` +
  `checklist, an outline with prompts to fill in, a compiled list of real options/resources with links, a ` +
  `practice set). If a step IS the graded work itself, leave it as a step for the student, not a document.` +
  `\n(4) REPORT — "did" = what you actually accomplished this run: a document/draft you created (one bullet ` +
  `each), OR a genuine research win worth calling out (e.g. "Found the exam date and compiled the 40 most ` +
  `common words"), OR both. Never a search log — "searched Gmail", "checked Drive", "listed calendar events", ` +
  `"looked into X" is NOT a ` +
  `"did" bullet, that's process, not a result; leave nothing at all when there's no real win to report. "links" ` +
  `= the real URL of EVERY document you created AND of any specific email/doc/file you found and referenced; ` +
  `"steps" = the stage-2 list MINUS whichever ones you just fulfilled by creating ` +
  `their document/draft — what's left is only what genuinely still needs the user, each a short concrete ` +
  `one-liner (mark automatable=true for a step Otto already prepared — the user just needs to click Send/ ` +
  `approve). "context" = the facts you found. "synthesis" = one past-tense line, e.g. "Researched X, created 2 ` +
  `documents and drafted the outreach email, and left 1 step." Never claim to have created/drafted/sent ` +
  `anything you didn't actually call a tool for.` +
  `\n\nINCLUDE LINKS — when you recommend specific resources or reference specific emails/docs you found, ` +
  `include their URLs in "links" (or inline as markdown [text](url) in "steps"/"context") so the user can open ` +
  `them directly. Never describe finding something without giving a way to open it.`;
import { webSearch } from "./websearch";
import type { PronoteHomeworkItem, PronoteTestItem } from "./pronote.ts";

export interface AcademicContext { homework?: PronoteHomeworkItem[]; tests?: PronoteTestItem[]; }

/** One entry in a task's audit log — see WebTask.audit in shared/types.ts for why this exists. */
export interface AuditEvent { at: string; kind: "tool" | "artifact" | "guardrail"; label: string }

/** Render the person-profile for prompts so generation + execution are personalized + grounded. */
function profileBlock(p?: Profile): string {
  if (!p) return "";
  // Newest 12 facts per category go into the prompt (storage keeps up to 40): keeps every call lean —
  // this block ships with EVERY agent request, so its size is a direct cost multiplier.
  const recent = (l?: string[]) => (l || []).slice(-12);
  // Deliberately NOT sending p.name (or any other direct identifier) to the LLM — it's a minor's real
  // name and the model has no actual need for it (nothing in these prompts asks it to address the
  // student by name). Data minimization: don't ship personally-identifying data to a third-party API
  // just because it happens to be sitting in the profile object.
  const parts: string[] = [];
  if (p.about) parts.push(`About them: ${p.about}`);
  if (recent(p.preferences).length) parts.push(`Preferences: ${recent(p.preferences).join("; ")}`);
  if (recent(p.people).length) parts.push(`Key people: ${recent(p.people).join("; ")}`);
  if (recent(p.projects).length) parts.push(`Ongoing projects: ${recent(p.projects).join("; ")}`);
  // Course-level patterns compound over a term/degree (a professor's grading quirks, how far ahead of THIS
  // course's deadlines the student actually starts) — see MEMORY IS A LEAD, NOT A FACT in PLAN_ONLY_OVERRIDE:
  // still only a lead to verify against fresh research, never grounds for asserting something is CURRENT.
  if (recent(p.courses).length) parts.push(`Course patterns (leads to verify, not guaranteed still current): ${recent(p.courses).join("; ")}`);
  // NOTE: responseStyle is deliberately NOT injected — reply tone/formality comes from the THREAD, not a
  // global preference (a "formal" default would fight a casual thread and vice-versa).
  // Auto-approve entries are the user's PREFERENCE, never permission: the code-enforced action policy
  // still gates every tool call — a policy-gated action stays gated no matter what this list says.
  if (p.autoApprove?.length) parts.push(`Prefers automated handling of: ${p.autoApprove.join(", ")} (preference only — the permission system still decides; gated actions still need approval)`);
  if (p.highPriorityPeople?.length) parts.push(`High-priority people: ${p.highPriorityPeople.join(", ")}`);
  if (p.autoArchivePatterns?.length) parts.push(`Considers noise (never surface as tasks): ${p.autoArchivePatterns.join(", ")}`);
  // Self-reported, not ground truth — a signal for WHICH subject needs more lead time/attention, never a
  // fact to restate to the student ("your grade is X") unless they bring it up themselves. Lowest first so
  // the weakest subject is the one the model actually notices, not buried after strong ones.
  if (p.grades?.length) {
    const sorted = [...p.grades].sort((a, b) => a.grade / a.scale - b.grade / b.scale);
    parts.push(`Grades by subject (self-reported, lowest first — weigh the LOW ones as needing more lead time/attention, not just what's due soonest): ${sorted.map((g) => `${g.subject} ${g.grade}/${g.scale}`).join(", ")}`);
  }
  return parts.length ? `\nWHO THIS PERSON IS — their stated preferences are INSTRUCTIONS to follow (what to include, skip, prioritize, and how to phrase/do things), not background:\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
}

/** Render live Pronote homework/exams for a single task's run/chat context — the candidate-discovery pass
 *  (classifyCandidates) already sees these as separate items, but a task's OWN execution/chat previously
 *  only saw `profile.grades`; this gives it the same real, dated homework/exam picture so it can weigh
 *  "what else is due" (e.g. don't suggest cramming the night before a Physique test) without guessing. */
function academicBlock(a?: AcademicContext): string {
  if (!a) return "";
  const parts: string[] = [];
  const fmt = (iso: string) => { try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); } catch { return iso; } };
  if (a.homework?.length) {
    parts.push(`Homework due soon (from Pronote, not yet done): ${a.homework.map((h) => `${h.subject} — ${h.description.slice(0, 80)} (due ${fmt(h.deadline)})`).join("; ")}`);
  }
  if (a.tests?.length) {
    parts.push(`Upcoming tests/exams (from Pronote): ${a.tests.map((t) => `${t.subject} (${fmt(t.deadline)})`).join("; ")}`);
  }
  return parts.length ? `\nTHEIR CURRENT PRONOTE WORKLOAD — use this to judge real urgency/conflicts, never invent or assume beyond it:\n${parts.map((x) => `- ${x}`).join("\n")}\n` : "";
}

/** The source item's OWN words for THIS task — for Pronote, the teacher's assignment text. Distinct from
 *  academicBlock in both content and FRAMING: academicBlock is ambient "what else is on your plate,
 *  judge urgency by it, don't assume beyond it"; this is "this is the actual thing you are working on,
 *  research it and build the artifact around it".
 *
 *  Before this existed, the énoncé was read by the classifier and then dropped, so a run only ever saw
 *  "Physique homework" — which is exactly why fiches came out generic ("revoir le cours") instead of
 *  being about mécanique du point. */
export function assignmentBlock(t: { sourceSubject?: string; sourceDetail?: string; sourceDue?: string }): string {
  if (!t.sourceDetail?.trim()) return "";
  const fmt = (iso?: string) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); } catch { return iso; } };
  const due = fmt(t.sourceDue);
  return `\nTHE ASSIGNMENT ITSELF — copied VERBATIM from Pronote; these are the teacher's own words.\n` +
    `This is the SUBJECT MATTER of this task, not background context. Everything you look up and every\n` +
    `artifact you build must be about THIS, in this subject, at this level.\n` +
    (t.sourceSubject ? `- Subject: ${t.sourceSubject}\n` : "") +
    (due ? `- Due: ${due}\n` : "") +
    `- What the teacher wrote: "${t.sourceDetail.trim()}"\n` +
    `Never invent parts of the énoncé that aren't quoted above — if you'd need the full question text or\n` +
    `the textbook page to go further, say so plainly (it's on the student's own sheet) instead of guessing\n` +
    `at what the exercise asks.\n`;
}

/** Current date + time, injected into every agent prompt so "today"/"tomorrow"/deadlines/scheduling are
 *  grounded. (Server runtime — new Date() is fine here; this is not a workflow script.) */
function nowBlock(): string {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* ignore */ }
  return `CURRENT DATE & TIME: ${date}, ${time}${tz ? ` (${tz})` : ""}. Reason about "today", "tomorrow", deadlines, scheduling and date conflicts relative to THIS. If you need a date/fact you're unsure of (a public deadline, a format, current info), use web_search rather than guess.\n`;
}

function deadlineBlock(text: string): string {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const match = raw.match(/\b(before|by|until|due)\b\s*[:\-]?\s*([^\n]+)/i);
  if (!match) return "";
  // Don't emit a deadline hint for a date that is clearly in the past — the agent would
  // think it missed the window, stall, or produce unhelpful "deadline passed" steps.
  const snippet = match[0];
  const yearMatch = snippet.match(/\b(20\d{2})\b/);
  const monthDayMatch = snippet.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
    const months: Record<string,number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const mo = months[monthDayMatch[1].slice(0,3).toLowerCase()];
    const dy = Number(monthDayMatch[2]);
    if (mo !== undefined) {
      const deadline = new Date(year, mo, dy);
      if (deadline < new Date()) return ""; // already past — suppress the misleading hint
    }
  }
  return `EXPLICIT DEADLINE PHRASE FROM THE TASK: "${snippet}". Treat that deadline/date as exact and preserve it unless the source data clearly contradicts it.\n`;
}

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "your", "you",
  "this", "that", "is", "are", "be", "it", "its", "from", "at", "into", "about", "up", "check", "make", "sure",
  "prepare", "review", "update", "complete", "finish", "verify", "create", "find", "get", "do", "not", "if"]);
/** Significant (non-generic) words from a task title, for a cheap "did the model even stay on-topic?" check. */
function titleKeywords(title: string): string[] {
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
 *  distinctive words to match against (avoids false positives on short titles). */
function stepsMatchTitle(title: string, steps: { text: string }[]): boolean {
  const kws = titleKeywords(title);
  if (!kws.length || !steps.length) return true;
  const matching = steps.filter((s) => { const t = s.text.toLowerCase(); return kws.some((k) => t.includes(k)); }).length;
  return matching / steps.length >= 0.5;
}

// Observed live: a task titled "Prepare for the Wharton Investment Competition" came back with steps ALL
// about moving files between Drive folders — one step happened to name-drop a file called "Wharton
// Investment Notes", which was enough to pass stepsMatchTitle's loose keyword check even though the
// content is pure folder housekeeping, not competition prep. This is the narrower, targeted pattern for
// that exact drift: the agent apparently found a relevantly-named FILE during research and fixated on
// organizing where it lives instead of using what's in it.
const FOLDER_HOUSEKEEPING_STEP = /\b(move (the |this |that )?[\w\s]{0,40}?\bfile|create (a |the )?['"]?\w*['"]? ?folder|folder (exists|contains)|organi[sz]e (the |your )?(files?|folders?|drive)|clean(ing)? up (the |your )?(drive|folder))\b/i;
/** Is EVERY step pure Drive folder/file housekeeping, on a task that isn't actually ABOUT organizing files? */
function isFolderHousekeepingDrift(title: string, steps: { text: string }[]): boolean {
  if (!steps.length) return false;
  if (/\b(organi[sz]e|folder|clean ?up|file management|sort (my|the) files)\b/i.test(title)) return false; // legitimately about this
  return steps.every((s) => FOLDER_HOUSEKEEPING_STEP.test(s.text));
}

// DeepSeek retired "deepseek-chat"/"deepseek-reasoner" in favor of "deepseek-v4-flash" (fast/cheap) and
// "deepseek-v4-pro" (heavier reasoning) — calls with an old name now fail outright with a 400. Map the old
// names forward so an existing deployment's DEEPSEEK_MODEL=deepseek-chat env var doesn't start hard-failing
// every AI call the moment the old names stop working; new deployments should just set the new names directly.
const LEGACY_DEEPSEEK_MODEL_MAP: Record<string, string> = { "deepseek-chat": "deepseek-v4-flash", "deepseek-reasoner": "deepseek-v4-pro" };
const DEEPSEEK_MODEL = LEGACY_DEEPSEEK_MODEL_MAP[process.env.DEEPSEEK_MODEL || ""] || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

// CRITICAL: deepseek-v4-flash (and -pro) are REASONING models — they emit hidden reasoning tokens that
// count against `max_tokens` BEFORE the visible answer. Confirmed live: a classify call spends ~400-1500+
// tokens reasoning, so the old 1800 cap left too little for the JSON, which got truncated mid-object →
// unparseable → ZERO tasks over a full inbox (then two empty retries burned it again). Every completion
// budget below must therefore fit reasoning + the actual structured output. `reserve()` gives a generous
// headroom so the model never runs out mid-JSON; it caps waste, it doesn't force spend (the model emits
// only the reasoning it needs). If a future non-reasoning model is used, these caps are simply never hit.
// `chat` was 500 — DeepSeek v4 is a REASONING model (its internal reasoning tokens count against
// max_tokens, same failure mode already fixed elsewhere for task generation): a low cap lets the
// reasoning pass alone consume the whole budget before any visible reply is emitted, leaving
// `message.content` empty and silently returning chatAboutTask's generic fallback ("I'm here — what
// part of this is giving you trouble?") on EVERY message, not just when the model was actually stuck.
// `plan` was 800 — same reasoning-token risk class as the `chat` fix above: planResearch already
// falls back to an empty query list on any parse failure, so a truncation here degrades silently
// (the research loop just improvises live instead of following a planned query list) rather than
// producing a visible bug — but it's still worth closing before it causes one.
// chat: 8000 (was 2000) — DeepSeek v4 is a REASONING model, its thinking tokens count against max_tokens.
// A plain "just talking" turn still only spends ~200 tokens; this is a CEILING for the rare turn that
// thinks, calls a tool, then emits a 12-question quiz with explanations — a real payload that size would
// silently truncate at 2000. CHAT_MAX_ROUNDS/CHAT_TOKEN_CEILING (near chatAboutTask) bound the real cost.
const OUT = { classify: 8000, generate: 8000, run: 8000, rescue: 5000, pick: 4000, refine: 3000, steps: 1500, plan: 1800, chat: 8000 } as const;

export function aiReady(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

/** Pull token usage from a DeepSeek response, INCLUDING the cache-hit portion of the prompt tokens
 *  (dramatically cheaper — see callCostUsd). DeepSeek exposes it as `prompt_cache_hit_tokens` and/or the
 *  OpenAI-shaped `prompt_tokens_details.cached_tokens`; read both defensively. `in` is the FULL prompt count. */
function usageOf(res: any): { in: number; out: number; cachedIn: number } {
  const u = res?.usage || {};
  const cachedIn = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  return { in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0, cachedIn };
}

function deepseekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY in web/.env.");
  return new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
    // Cap a single request at 90s (SDK default is 10 min — a hung upstream would pin a job for the whole
    // lock lease). retryRequest owns retries, so disable the SDK's own to avoid double-retrying.
    timeout: 90_000,
    maxRetries: 0,
  });
}

/** Is this a TRANSIENT failure worth retrying (connection dropped / gateway / rate limit)? Checks the
 *  error's own code, the undici CAUSE chain ("TypeError: terminated" wraps an ECONNRESET cause — the exact
 *  shape that was killing whole sweeps un-retried), the message, and the HTTP status. */
function isTransient(e: any): boolean {
  const code = String(e?.code || e?.cause?.code || "");
  if (["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
  const msg = `${e?.message || ""} ${e?.cause?.message || ""}`;
  if (/fetch failed|socket hang up|terminated|aborted|premature close|network|other side closed/i.test(msg)) return true;
  return [429, 500, 502, 503, 504].includes(Number(e?.status));
}

async function retryRequest<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (!isTransient(e) || i === retries - 1) throw e;
      console.warn(`[ai] request failed (${e?.message || e}), retrying in ${delayMs}ms... (attempt ${i + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  throw lastErr;
}

/** Tolerant: pull the first JSON value (object or array) out of a model reply. */
function firstJson<T>(raw: string): T | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)) as T; } catch { return null; } } }
  }
  return null;
}

/** Older tool results have served their purpose (the model already acted on them). Truncating them hard
 *  before each round stops the transcript growing quadratically over a long run — the biggest token sink.
 *  The most recent results stay full so current work is never degraded. */
// Keep the last N tool results FULL, truncate older ones. The old 4/250 was too aggressive — by round 6 of
// 8 the model was drafting from a transcript where most of its evidence (a Gmail search's threads, a doc's
// text) had been cut to a single line, a live driver of thin/subtly-wrong drafts. 6/1000 keeps far more of
// the gathered facts in view; the per-run token logging + circuit breaker bound the extra cost.
const TRIM_KEEP = 6, TRIM_TO = 1000;
function trimOldToolResults(messages: any[]): any[] {
  if (messages.length <= TRIM_KEEP) return messages;
  const cut = messages.length - TRIM_KEEP;
  return messages.map((m, i) =>
    i < cut && m.role === "tool" && typeof m.content === "string" && m.content.length > TRIM_TO
      ? { ...m, content: m.content.slice(0, TRIM_TO) + "\n…[older result truncated]" }
      : m);
}

function parseToolArgs(raw: any): any {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const repaired = firstJson<any>(text);
    return repaired && typeof repaired === "object" ? repaired : {};
  }
}

export interface GeneratedTask {
  title: string;
  why: string;
  when?: string;
  source: string;          // the app this is from: "gmail" | "calendar" | a connected-app slug (slack, github, …)
  risk: "low" | "high";
  urgency: number;
  importance: number;
  /** Stable id of the underlying item the agent based this on (e.g. "gmail:<threadId>",
   *  "calendar:<eventId>") — used for dedupe across refreshes. */
  anchorKey?: string;
  /** A URL to open the source item (the Gmail thread / the calendar event), if the agent has one. */
  link?: string;
  /** Multi-Gmail: the Composio connected-account id this item came from, so execution acts on the right inbox. */
  accountId?: string;
  /** Verbatim source text (Pronote's assignment description) + the source's own subject/due — copied off
   *  the SourceItem, never model-authored. See WebTask.sourceDetail for why this exists. */
  sourceDetail?: string;
  sourceSubject?: string;
  sourceDue?: string;
}

const GEN_SYSTEM =
  MISSION +
  `\n\nYou are an autonomous operations assistant — a sharp chief-of-staff turning someone's live world into their ` +
  `real, COMPLETE to-do list. Your job is to FIND, PRIORITIZE, and EXECUTE work — not just record it. Use EVERY ` +
  `tool available — across ALL their connected apps, not just email — to READ what genuinely needs them right ` +
  `now, then call submit_tasks. Sweep each connected source AGGRESSIVELY for actionable items, e.g.:\n` +
  `- Gmail: threads awaiting a reply or asking something (skip newsletters/promos/receipts/no-reply).\n` +
  `NEWSLETTERS & PROMOTIONAL EMAIL — HARD EXCLUSION: NEVER create a task to reply to, respond to, or otherwise ` +
  `engage with a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender — a Gmail ` +
  `"promotions"/"social" category, an unsubscribe footer, or a sender containing "noreply"/"no-reply"/` +
  `"newsletter"/"marketing"/"updates@"/"news@" are all signals of this. This holds even if the email asks a ` +
  `question, has a "reply" call-to-action, or looks personalized — it's still mass mail. Skip it entirely; ` +
  `do not surface it as a to-do of any kind.\n` +
  `- Calendar: meetings in the next ~48h to prepare for or respond to, conflicts to resolve.\n` +
  `- Slack / Discord: DMs & mentions awaiting your reply.\n` +
  `- GitHub / Linear / Jira: issues & PRs assigned to you, review requests, things blocking others.\n` +
  `- Notion / Todoist / Asana / Trello / ClickUp: tasks assigned or due soon.\n` +
  `- CRM (HubSpot, Salesforce): deals needing follow-up, tasks due, opportunities at risk.\n` +
  `- Any other connected app: whatever is genuinely waiting on this person.\n` +
  `- COMMITMENTS THEY MADE: also check their recently SENT mail/messages (e.g. Gmail search "in:sent newer_than:7d") ` +
  `for promises THEY made to others — "I'll send you X", "I'll get back to you by Friday", "let me check and ` +
  `follow up" — and create a task to FULFILL each one that looks unfulfilled (no later reply/attachment in the ` +
  `thread). Title it as the commitment ("Send Sarah the budget deck"), set "when" from the promised deadline, ` +
  `and anchor it to the sent thread ('gmail:<threadId>'). A broken promise is worse than a missed email.\n` +
  `- CONTEXT GATHERING: For every actionable item, GATHER FULL CONTEXT — search related threads, check calendar ` +
  `for conflicts, find relevant docs, pull in CRM data. A task without context is half-baked.\n` +
  `Surface a clear, actionable to-do for EVERYTHING that needs them (one per item). Skip true non-actionable ` +
  `noise. Rank by urgency/importance rather than dropping. Ground every task STRICTLY in what the tools return; ` +
  `never invent people, dates, or facts. You may also use web_search for quick external context (e.g. who a ` +
  `sender is, a public deadline).\n` +
  `GMAIL — SEARCH IT SEVERAL WAYS, not one generic fetch: (1) recent inbox needing action ` +
  `("in:inbox newer_than:7d -category:promotions -category:social"), (2) unread ("is:unread in:inbox"), ` +
  `(3) their SENT mail for open loops ("in:sent newer_than:10d") — read what THEY promised and check whether ` +
  `they delivered, (4) threads where someone asked them something and the last message is NOT theirs ` +
  `(they owe a reply), (5) search for key people/projects from their profile to find loose ends.\n` +
  `USE THEIR PROFILE AS SEARCH LEADS: pick the 2-3 most active projects/people listed below and run ONE ` +
  `targeted search each (the name in Gmail or the relevant app) to find loose ends — an unanswered thread, ` +
  `an upcoming deadline, a doc waiting on them. What did they say they'd do but haven't?\n` +
  `PREFERENCES ARE BINDING, not decoration — the "Preferences" lines in their profile MUST shape the list:\n` +
  `- FILTER: if a preference says they don't care about something (a topic, a sender, a kind of work), do NOT ` +
  `create tasks for it, even if it looks actionable.\n` +
  `- RANK: automatically prioritize tasks strictly by deadline proximity, high-stakes importance (people/projects), and open commitments; raise importance/urgency for firm deadlines, high-priority contacts, or promises made — lower it for what they've deprioritized. Two equal emails ≠ two equal tasks if a preference separates them.\n` +
  `- BREAK DOWN: for large, complex projects, ensure the task title and why reflect a clear, single actionable first step so the user is never overwhelmed by a vague backlog.\n` +
  `- SHAPE: phrase titles/whys in line with how they work (e.g. "batch admin on Fridays" → set "when" accordingly; ` +
  `"prefers calls over email" → the task suggests a call). When a preference influenced a task, reflect it in "why".\n` +
  `- WORKING HOURS: if they have working hours set, consider whether tasks can be done within those hours.\n` +
  `- RESPONSE STYLE: if they prefer concise/detailed/casual/formal, this should influence how you phrase tasks.\n` +
  `- AUTO-APPROVE: if they've approved certain categories (e.g., "schedule_meetings_under_30min"), mark those as low risk.\n` +
  `- HIGH PRIORITY PEOPLE: if someone is in their high-priority list, their requests get higher urgency.\n` +
  `- AUTO-ARCHIVE: if they've set patterns to auto-archive (e.g., newsletters), filter those out.\n` +
  `NEVER resurface a to-do the user already finished or DISMISSED — if an ` +
  `"ALREADY HANDLED" list is given below, skip every item on it, even if its source email/event still exists. ` +
  `ONE TASK PER UNDERLYING ITEM: never submit two wordings of the same to-do — one thread/event/commitment = ` +
  `ONE task, with its stable anchorKey. If two findings point at the same obligation, merge them into one task.\n` +
  `QUALITY OVER QUANTITY — surface the handful (≤ ~12) of items that genuinely matter; skip marginal ` +
  `"maybes". A short list the user trusts beats a complete list they ignore.\n` +
  `THE USER IS NOT A CONTACT: their own name (given as "Their name" below) never belongs in a task's title or ` +
  `"why" as someone to ask, email, or follow up with — that's them, not a third party. If a task needs info ` +
  `only THEY have (e.g. a missing email address, a decision only they can make), phrase it as something for ` +
  `them to fill in directly (e.g. "Add Victoria's email to send the invite"), never "Ask <their name> for X".\n` +
  `READ ONLY here — do NOT create, modify, draft, or send anything during ` +
  `generation. BUDGET: you have roughly 6-8 tool calls TOTAL — batch your Gmail searches into ONE round ` +
  `(issue them as parallel calls), give each other app ONE targeted read, never re-read the same source, ` +
  `and submit as soon as you have the picture. Thorough ≠ exhaustive.`;

const SUBMIT_TASKS_TOOL = {
  name: "submit_tasks",
  description: "Submit the full actionable to-do list you found.",
  input_schema: { type: "object", properties: {
    tasks: { type: "array", description: "one per actionable thread/event", items: { type: "object", properties: {
      title: { type: "string", description: "short imperative, <= 9 words" },
      why: { type: "string", description: "one grounded clause naming the concrete trigger" },
      when: { type: "string", description: "concise timeline/deadline grounded in the data (e.g. 'today', 'by Fri 5pm') or '' " },
      source: { type: "string", description: "the connected app this is from, as a lowercase slug: gmail, calendar, slack, github, notion, linear, todoist, …" },
      risk: { type: "string", enum: ["low", "high"], description: "'high' if completing it means sending/inviting (irreversible)" },
      urgency: { type: "number", description: "0..1 time pressure" },
      importance: { type: "number", description: "0..1 stakes" },
      anchorKey: { type: "string", description: "ALWAYS set this — the item's STABLE id EXACTLY as the tool returned it, prefixed by app: 'gmail:<threadId>', 'calendar:<eventId>', etc. Use the SAME value every run so the task is never duplicated." },
      link: { type: "string", description: "a URL to open the source item, if you have one" },
    }, required: ["title", "why", "source", "urgency", "importance"] } },
    profileUpdates: { type: "array", description: "0-4 durable facts about WHO THIS PERSON IS that you discovered while sweeping (their role, a key relationship, an ongoing project, a work preference) — including a CORRECTED/updated version of a profile line above that's now outdated. Not task content; only lasting identity facts.", items: { type: "object", properties: {
      category: { type: "string", enum: ["name", "about", "preference", "person", "project", "course"] },
      fact: { type: "string", description: "one short sentence" },
    }, required: ["category", "fact"] } },
  }, required: ["tasks"] },
};

/** Validate model-supplied profile updates (shared by generation submit + task-run remember). */
export function parseProfileUpdates(arr: any): ProfileUpdate[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((u): ProfileUpdate => ({
      category: ["name", "about", "preference", "person", "project", "course"].includes(u?.category) ? u.category : "preference",
      fact: String(u?.fact || "").trim().slice(0, 200),
    }))
    .filter((u) => u.fact)
    .slice(0, 4);
}

// Shared web-search tool for the task agents — gives generation + execution the power to "look it up",
// so planning or doing a task can pull in external context (a person, a deadline, a how-to, a link).
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the web for current or background facts you can't get from the connected apps — a person/company, a deadline or figure, how to do something, a reference link. Returns top results (title, url, snippet).",
  input_schema: { type: "object", properties: { query: { type: "string", description: "the search query" } }, required: ["query"] },
};
async function runWebSearch(input: any): Promise<string> {
  const q = String(input?.query || "").trim();
  if (!q) return "[]";
  return JSON.stringify((await webSearch(q)).slice(0, 6));
}

// A short in-app brief attached directly to the task — no account, no OAuth, no approval, never leaves
// Otto's own storage. This is the default for a short study aid (a checklist, a quick reference, a small
// outline); reserve an actual GOOGLEDOCS/SHEETS/SLIDES document for something that's genuinely long-form
// or needs to leave the app (shared/emailed/edited elsewhere).
const CREATE_NOTE_TOOL = {
  name: "CREATE_NOTE",
  description: "Create a SHORT in-app brief/note attached to this task — a quick checklist, reference sheet, or outline the student opens in a popup right on the card. No account, no approval, nothing external. Use this by default for anything short; only create a real Google Doc/Sheet/Slides when the content is genuinely long-form or needs to leave the app.",
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Fiche de révision — Suites numériques'" },
    body: { type: "string", description: "the real content, in markdown (headings, **bold**, bullet/numbered lists, and a GFM pipe table — `| col | col |` with a `|---|---|` separator row — when the content is naturally tabular, e.g. a timing/schedule breakdown) — this IS the brief, not a placeholder." },
  }, required: ["title", "body"] },
};

// A drillable flashcard deck attached to the task — for vocab/definitions/formulas/concept review, where
// testing yourself front→back beats reading a written guide. Same no-account/no-approval model as notes.
const CREATE_FLASHCARDS_TOOL = {
  name: "CREATE_FLASHCARDS",
  description: "Create an in-app flashcard deck attached to this task — for drilling vocabulary, definitions, formulas, dates, or any front→back recall. The student flips each card and marks it right/wrong to self-test. Use this INSTEAD OF CREATE_NOTE when the content is naturally a list of discrete facts to memorize/recall, not a checklist or outline.",
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Vocabulaire — Chapitre 4'" },
    cards: {
      type: "array",
      description: "8-20 cards, MEDIUM length each side (a phrase/sentence, not one word and not a paragraph) — real content from the task's subject, never placeholders.",
      items: { type: "object", properties: {
        front: { type: "string", description: "the prompt side — a term, question, or formula name" },
        back: { type: "string", description: "the answer side — the definition, translation, or value" },
      }, required: ["front", "back"] },
    },
  }, required: ["title", "cards"] },
};

// An in-app multiple-choice quiz. Distinct purpose from a deck: a deck drills recall, a quiz makes the
// student DISCRIMINATE between plausible answers, which is what actually exposes a shaky notion.
const CREATE_QUIZ_TOOL = {
  name: "CREATE_QUIZ",
  description: "Create an in-app multiple-choice quiz attached to this task — the student answers each question, gets immediate feedback with a one-line explanation, and a score at the end. Use this to CHECK UNDERSTANDING before a contrôle (which parts of the chapter aren't solid), where CREATE_FLASHCARDS is for drilling raw recall. NEVER turn the student's OWN assigned exercise into a quiz — write NEW questions on the same notion.",
  input_schema: { type: "object", properties: {
    title: { type: "string", description: "short label shown on the button, e.g. 'Quiz — Mécanique du point'" },
    questions: {
      type: "array",
      description: "5-12 questions on the task's real subject matter — never placeholders, never the student's own assigned exercise reworded.",
      items: { type: "object", properties: {
        q: { type: "string", description: "the question — one clear sentence" },
        options: { type: "array", description: "3-4 answer options. EXACTLY ONE is correct; the wrong ones must be genuinely plausible (a common misconception, an off-by-one, the right idea applied to the wrong case). An obviously-silly option teaches nothing.", items: { type: "string" } },
        correct: { type: "number", description: "0-based index into options of the CORRECT one" },
        why: { type: "string", description: "one line on why that answer is right — this is what makes the quiz teach instead of just score" },
      }, required: ["q", "options", "correct"] },
    },
  }, required: ["title", "questions"] },
};

// ── Shared in-app artifact factories ──────────────────────────────────────────
// Pure, no I/O. Used by BOTH runTask's tool loop and the tutor chat's tool loop, so validation can't drift
// between "the artifact Otto made during a run" and "the artifact Otto made when you asked in chat".
// Each returns either the artifact or an `error` string that goes straight back to the model as the tool
// result (so it can retry properly rather than silently producing something empty).

/** A note whose body is empty/near-empty used to be ACCEPTED and still set `wroteAny`, which satisfied every
 *  artifact-enforcement check in the run loop with nothing to show the student — a real hole in the chain.
 *  40 chars is comfortably below any genuine fiche and comfortably above "TODO". */
const MIN_NOTE_BODY = 40;
export function makeNote(input: any): { note: TaskNote } | { error: string } {
  const title = String(input?.title || "Note").trim().slice(0, 120) || "Note";
  const body = String(input?.body || "").trim().slice(0, 8000);
  if (body.length < MIN_NOTE_BODY) return { error: "ERROR: the note body is empty or too short — write the ACTUAL content (the real formulas/definitions/steps), not a placeholder or a title with nothing under it." };
  return { note: { id: randomUUID(), title, body, createdAt: new Date().toISOString() } };
}

export function makeDeck(input: any): { deck: TaskFlashcards } | { error: string } {
  const title = String(input?.title || "Flashcards").trim().slice(0, 120) || "Flashcards";
  const cards = (Array.isArray(input?.cards) ? input.cards : [])
    .map((c: any) => ({ front: String(c?.front || "").trim().slice(0, 300), back: String(c?.back || "").trim().slice(0, 300) }))
    .filter((c: { front: string; back: string }) => c.front && c.back)
    .slice(0, 30);
  if (!cards.length) return { error: "ERROR: no valid cards (each needs a non-empty front and back)." };
  return { deck: { id: randomUUID(), title, cards, createdAt: new Date().toISOString() } };
}

export function makeQuiz(input: any): { quiz: TaskQuiz } | { error: string } {
  const title = String(input?.title || "Quiz").trim().slice(0, 120) || "Quiz";
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const questions = raw
    .map((item: any) => {
      const q = String(item?.q || "").trim().slice(0, 300);
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
      if (kept.length < 2 || kept.length > 4 || correct < 0) return null;
      const why = item?.why ? String(item.why).trim().slice(0, 300) : undefined;
      return { q, options: kept.map((o) => o.text), correct, ...(why ? { why } : {}) };
    })
    .filter(Boolean)
    .slice(0, 15) as TaskQuiz["questions"];
  if (!questions.length) return { error: "ERROR: no valid questions (each needs a question, 2-4 distinct options, and a `correct` index pointing at one of them)." };
  return { quiz: { id: randomUUID(), title, questions, createdAt: new Date().toISOString() } };
}

// Sources where every item HAS a stable id/link the tools return — a task claiming to come from one of
// these without either is unverifiable (likely hallucinated or sloppily reported) and gets dropped.
const ANCHORED_SOURCES = new Set(["gmail", "calendar", "googlecalendar", "slack"]);

export function parseGenerated(arr: any): GeneratedTask[] {
  if (!Array.isArray(arr)) return [];
  return arr
    // Grounding gate: a task needs a real title AND a concrete trigger ("why") — junk without evidence is dropped.
    .filter((t) => t && typeof t.title === "string" && t.title.trim().length >= 4 && String(t.why || "").trim())
    // Grounding gate 2: an app-sourced task must POINT at its source item (anchorKey or link).
    .filter((t) => !ANCHORED_SOURCES.has(String(t.source || "").trim().toLowerCase()) ||
      !!String(t.anchorKey || "").trim() || /^https?:\/\//i.test(String(t.link || "")))
    .map((t): GeneratedTask => ({
      title: String(t.title).slice(0, 90),
      why: String(t.why || "").slice(0, 400),
      when: t.when ? String(t.when).slice(0, 40) : undefined,
      source: typeof t.source === "string" && t.source.trim() ? t.source.trim().toLowerCase().slice(0, 24) : "gmail",
      risk: t.risk === "high" ? "high" : "low",
      urgency: clamp01(t.urgency ?? 0.5),
      importance: clamp01(t.importance ?? 0.6),
      anchorKey: t.anchorKey ? String(t.anchorKey).trim().slice(0, 120) : undefined,
      link: t.link && /^https?:\/\//i.test(String(t.link)) ? String(t.link) : undefined,
    }))
    // 20 is generous for a DELTA sweep (the model is told what's already on the list) — anything beyond
    // this is the model rebuilding the world, not reporting what's new.
    .slice(0, 20);
}

/**
 * Generate the to-do list as a tool-using agent over the user's CONNECTED apps (Composio Gmail + Calendar):
 * it reads the recent inbox + upcoming events itself, then submits tasks. Returns [] if nothing is connected
 * to read (the client then prompts the user to connect Gmail/Calendar in Settings).
 */
export interface GenerationResult { tasks: GeneratedTask[]; profileUpdates: ProfileUpdate[]; tokens?: { in: number; out: number; cachedIn?: number }; }

export async function generateTasks(profile?: Profile, extras?: AgentTools, handled?: { title: string; anchorKey?: string }[], active?: { title: string; anchorKey?: string }[]): Promise<GenerationResult> {
  const empty: GenerationResult = { tasks: [], profileUpdates: [] };
  if (!extras?.tools?.length) return empty; // nothing connected to read
  const tools = [...extras.tools, WEB_SEARCH_TOOL, SUBMIT_TASKS_TOOL];
  const connectedLine = extras.connected?.length
    ? `My connected apps you can read: ${extras.connected.join(", ")}. Check EACH of them, not just email.`
    : `Use whatever tools you have to read what needs me.`;
  const handledBlock = handled?.length
    ? `\nALREADY HANDLED — I already finished or dismissed these; do NOT create a task for any of them again, ` +
      `even if its source email/event is still around. A dismissal is a PREFERENCE SIGNAL: I looked at that ` +
      `task and said no — so also skip anything SIMILAR to a dismissed item (same thread, same kind of ask, ` +
      `same sender's request reworded):\n` +
      handled.slice(0, 40).map((h) => `- ${h.title}${h.anchorKey ? ` [${h.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  // The sweep is a DELTA: knowing what's already on the list is what keeps it from re-reporting (and
  // re-wording) the same items every day — the top source of both duplicates and wasted submit tokens.
  const activeBlock = active?.length
    ? `\nALREADY ON THEIR LIST (active) — do NOT re-report these; submit ONLY items that are on NEITHER this ` +
      `list nor the handled list. If nothing new is waiting, submit an empty list — that is a GOOD answer:\n` +
      active.slice(0, 30).map((a) => `- ${a.title}${a.anchorKey ? ` [${a.anchorKey}]` : ""}`).join("\n") + `\n`
    : "";
  const messages: any[] = [{
    role: "user",
    content: nowBlock() + profileBlock(profile) + activeBlock + handledBlock +
      `\n${connectedLine}\nSweep across all of them for everything genuinely awaiting me that is NOT already ` +
      `covered above — including what I promised others and haven't done yet (check my sent mail), and loose ` +
      `ends on my projects/people above — then call submit_tasks with the NEW actionable items. Respect my ` +
      `stated preferences above when choosing, ranking, and phrasing tasks.`,
  }];
  const actualModel = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
  // Each round re-sends the whole growing transcript (tools + history) — rounds are the real cost driver.
  // The prompt tells the agent to BATCH searches as parallel calls in one round, so 6 is plenty; the forced
  // final round below is the safety net for a straggler.
  const MAX = 6;
  let tokIn = 0, tokOut = 0, tokCached = 0, rounds = 0;
  const tok = () => ({ in: tokIn, out: tokOut, cachedIn: tokCached }); // so the fallback sweep is metered too
  let didRead = false;        // has the model actually called ANY read tool yet?
  let lazyRejected = false;   // reject an unread empty submit only ONCE, then take whatever comes
  try {
  for (let i = 0; i < MAX; i++) {
    const client = deepseekClient();
    const lastRoundHint = i === MAX - 1 ? "You must call submit_tasks now with the full actionable list. Do not answer with prose." : "";
    const base = trimOldToolResults(messages);
    const apiMessages = lastRoundHint ? [...base, { role: "user" as const, content: lastRoundHint }] : base;
    const res = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: OUT.generate,
      messages: [
        { role: "system", content: languageLine(profile) + trackLine(profile) + GEN_SYSTEM },
        ...apiMessages,
      ],
      tools: tools.map((t: any) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }));
    rounds++; { const u = usageOf(res); tokIn += u.in; tokOut += u.out; tokCached += u.cachedIn; }
    const toolUses = res.choices[0]?.message?.tool_calls || [];
    if (!toolUses.length) {
      const assistantText = res.choices[0]?.message?.content || "";
      if (i < MAX - 1) {
        if (assistantText) messages.push({ role: "assistant", content: assistantText });
        messages.push({ role: "user", content: "You have not used any tools yet. Inspect the connected apps first. Call at least one connected tool now and do not answer with prose." });
        continue;
      }
      return empty;
    }
    messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
    let submitted: GenerationResult | null = null;
    for (const tu of toolUses) {
      const input = parseToolArgs((tu as any).function?.arguments);
      const toolName = (tu as any).function?.name;
      let content = "ok";
      try {
        if (toolName === "submit_tasks") {
          const parsed: GenerationResult = { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates) };
          // Lazy-submit guard: an EMPTY submit before reading anything isn't an answer, it's giving up.
          // Reject exactly once so the model goes and sweeps; a legit "nothing new" after real reads passes.
          if (!parsed.tasks.length && !didRead && !lazyRejected) {
            lazyRejected = true;
            content = "Rejected: you submitted before sweeping. Read the connected apps first (batch your searches), then resubmit — an empty list is only acceptable AFTER you have actually looked.";
          } else { submitted = parsed; content = "submitted"; }
        }
        else if (toolName === "web_search") { didRead = true; content = await runWebSearch(input); }
        else { didRead = true; const r = await extras.call(toolName, input || {}); content = r ?? `Unknown tool: ${toolName}`; }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      // Capped well below the old 4000 — a fresh result only needs enough to extract the fact/id you asked
      // for; anything you need beyond that, search again. This cap applies to every tool call, every round.
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 2000) });
    }
    if (submitted) { if (!submitted.tasks.length) console.warn("[claude] generateTasks submitted 0 tasks"); return { ...submitted, tokens: tok() }; }
  }
  // Round budget exhausted without a submit — a sweep that read everything but never reported is why
  // "Refresh finds nothing". Force ONE final call where the model MUST call submit_tasks with what it has.
  try {
    const client = deepseekClient();
    const res = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: OUT.generate,
      messages: [
        { role: "system", content: languageLine(profile) + trackLine(profile) + GEN_SYSTEM },
        ...trimOldToolResults(messages),
        { role: "user", content: "STOP researching. Call submit_tasks NOW with every actionable task you found so far." },
      ],
      tools: [{ type: "function" as const, function: { name: SUBMIT_TASKS_TOOL.name, description: SUBMIT_TASKS_TOOL.description, parameters: SUBMIT_TASKS_TOOL.input_schema } }],
      tool_choice: { type: "function", function: { name: "submit_tasks" } },
    }));
    rounds++; { const u = usageOf(res); tokIn += u.in; tokOut += u.out; tokCached += u.cachedIn; }
    const tu = res.choices[0]?.message?.tool_calls?.[0];
    if (tu) {
      const input = parseToolArgs((tu as any).function?.arguments);
      return { tasks: parseGenerated(input?.tasks), profileUpdates: parseProfileUpdates(input?.profileUpdates), tokens: tok() };
    }
  } catch (e: any) { console.warn("[claude] forced submit failed:", e?.message || e); }
  return { ...empty, tokens: tok() };
  } finally {
    console.log(`${new Date().toISOString()} [ai] generateTasks: ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
}

/**
 * Stage-2 of the discovery pipeline: classify PRE-FILTERED, NORMALIZED source items in ONE model call
 * (no tools, no agent loop). The model only says WHICH items are actionable and how — every anchor, link,
 * and source on the resulting task is copied from the item itself, so references cannot be hallucinated.
 */
export async function classifyCandidates(
  items: { sourceApp: string; anchorKey: string; url?: string; title: string; snippet: string; sender?: string; timestamp?: string; labels: string[]; accountId?: string; subject?: string }[],
  profile?: Profile,
  activeTitles?: string[],
  handledTitles?: string[],
): Promise<GenerationResult> {
  if (!items.length) return { tasks: [], profileUpdates: [] };
  const list = items.slice(0, 30).map((it, i) =>
    `#${i} [${it.sourceApp}${it.labels.includes("sent") ? "/SENT-BY-USER" : ""}${it.labels.includes("shared") ? "/SHARED-WITH-USER" : ""}${it.labels.includes("assigned") ? "/ASSIGNED-TO-USER" : ""}${it.labels.includes("review-requested") ? "/REVIEW-REQUESTED" : ""}${it.labels.includes("test") ? "/TEST" : ""}${it.labels.includes("homework") ? "/HOMEWORK" : ""}] from:"${it.sender || "?"}" when:"${it.timestamp || "?"}" title:"${it.title}" body:"${it.snippet}"`).join("\n");
  const activeBlock = activeTitles?.length ? `\nALREADY ON THEIR LIST (skip anything covering these):\n${activeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n` : "";
  // filterCandidates (discover.ts) already drops any candidate whose ANCHOR exactly matches a done/dismissed
  // task, so an unchanged email/event never gets re-classified. This catches what that can't: a genuinely
  // NEW anchor (a new message, a reworded ask) that's really the SAME underlying obligation the student
  // already explicitly said no to. A dismissal is a preference signal, not a one-time skip — without this,
  // "reply to the same recurring request" kept resurfacing as a fresh-looking task every sweep.
  const handledBlock = handledTitles?.length ? `\nALREADY DISMISSED/DONE — do NOT recreate a task for these, or anything that's really the same underlying ask reworded (same sender's request, same recurring thing):\n${handledTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n` : "";
  const sys =
    languageLine(profile) + trackLine(profile) +
    `This is for a STUDENT'S to-do list — Otto is their companion, not a do-it-all; a task should name a real ` +
    `next action THEY take, never phrase graded/learning work as already done for them.\n` +
    `You classify a person's inbox/calendar/drive items into their to-do list. For each candidate decide if it ` +
    `GENUINELY needs them to act. TENTATIVE ≠ A COMMITMENT — "maybe I'll send it over", "I might look into X", ` +
    `"we should grab coffee sometime" are casual musings, not promises; only a clear, specific commitment ` +
    `("I'll send you the deck Friday", "I'll call you back") counts as SENT-BY-USER. When genuinely unsure ` +
    `whether something is firm, leave it out — a missed maybe costs nothing, a false "you promised this" erodes ` +
    `trust in every task after it. Inbox items: does someone await their reply / ask something of them? SENT-BY-USER ` +
    `items are commitments THEY made ("I'll send you X") — create a task to FULFILL unfulfilled ones. Events: only ` +
    `if prep or a response is genuinely needed (within ~48h, or with real stakes). SHARED-WITH-USER files: only if ` +
    `someone is clearly waiting on their review/input. GitHub ASSIGNED-TO-USER issues and REVIEW-REQUESTED PRs ` +
    `are actionable while open. Pronote homework (labeled "homework"): actionable while not yet marked done; ` +
    `urgency scales with how close the deadline is (≥0.7 within ~48h). Pronote tests/exams (labeled "test"): ` +
    `these need STUDY TIME before the date, not last-minute action — surface one even weeks out (importance ` +
    `≥0.7 always, since a test is inherently high-stakes), with urgency rising as the date nears (≥0.7 inside ` +
    `~5 days) so it doesn't get crowded out by same-day noise but also doesn't wait until it's too late to ` +
    `study. Title/why for a test should point at STARTING to prepare (e.g. "Start reviewing for the Math test ` +
    `on Friday"), never phrase it as already studied. If their profile lists a LOW grade in this subject, push ` +
    `importance/urgency higher and earlier than the deadline alone would justify — a weak subject needs more ` +
    `lead time, not the same runway as one they're already doing well in. Skip FYIs, receipts, automated mail, and anything already on ` +
    `their list.\n` +
    `NEWSLETTERS & PROMOTIONAL EMAIL — HARD EXCLUSION: NEVER create a task to reply to, respond to, or otherwise ` +
    `engage with a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender — a sender ` +
    `containing "noreply"/"no-reply"/"newsletter"/"marketing"/"updates@"/"news@", an unsubscribe footer, or a ` +
    `Gmail promotions/social label are all signals of this. This holds even if it asks a question, has a ` +
    `"reply"/"take our survey" call-to-action, or looks personalized (a school's mass newsletter addressed ` +
    `"Dear Willem" is still mass mail) — it is still not a real to-do. Skip it entirely, no matter how it's worded.\n` +
    `USE THEIR PROFILE: items from their HIGH-PRIORITY people or touching their stated projects rank ` +
    `HIGHER (importance ≥ 0.7); things their preferences deprioritize rank lower or get skipped. Quality over ` +
    `quantity — the handful that matter. ALWAYS include: a direct question or request from a real person awaiting ` +
    `their reply; a SENT-BY-USER commitment ("I'll send/do/call…") with no later fulfilment visible; an event in ` +
    `the next 48h that plainly needs prep. When such an item exists, an empty tasks list is WRONG.\n` +
    `CONSOLIDATE — one real-world obligation = ONE task. If several candidates concern the SAME thing (a ` +
    `calendar event AND the email thread that set it up; several copies of one outreach the user sent), emit a ` +
    `SINGLE task and pick the candidate the user must ACT on to anchor it (prefer the email/thread they need to ` +
    `handle; else the event). NEVER emit two tasks for one meeting, thread, or commitment. SCORING & PRIORITIZATION: Score importance (0..1) and urgency (0..1) based on deadlines, effort required, and high-priority contacts/projects. Items with imminent deadlines, unfulfilled promises, or high-priority senders score urgency ≥ 0.7 and importance ≥ 0.7. For large complex requests, focus the task on the immediate, concrete next actionable step.\n` +
    `TITLES MUST BE SPECIFIC — name the actual person/company AND the actual subject, so the task is clear ` +
    `without opening anything. GOOD: "Reply to Chloe at BOND about the demo", "Send media-coverage docs to ` +
    `Paris Model Congress", "Confirm attendance to Guillaume's Aug call". BAD (too vague — never do this): ` +
    `"Follow up on sent email", "Reply to email", "Respond to message", "Handle request". If you can't name ` +
    `the person or subject from the candidate, you don't understand it well enough to include it — omit it.\n` +
    `Answer with STRICT JSON only: {"tasks":[{"i":<candidate #>,"title":"specific imperative naming who+what, ≤11 words",` +
    `"why":"one clause naming the concrete trigger","when":"the REAL deadline stated in or directly implied by the item — NEVER an invented one; '' if none","urgency":0..1,"importance":0..1,` +
    `"risk":"low"|"high"}],"profileUpdates":[{"category":"preference"|"person"|"project"|"course"|"name"|"about",` +
    `"fact":"one short sentence"}]} — profileUpdates: 0-3 DURABLE facts about who this person is that these ` +
    `items reveal (a key relationship, an ongoing project) — only lasting identity facts, not task content. ` +
    `Use "course" for a class-specific pattern worth compounding over the term (a professor's grading style, ` +
    `how far ahead of THIS course's deadlines they actually start work) — this is what makes Otto visibly ` +
    `smarter about a student's classes over a degree, not just their tone. Empty arrays are fine.`;
  const client = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
  let tokIn = 0, tokOut = 0, tokCached = 0, calls = 0;
  const ask = async (extra?: string) => {
    calls++;
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: OUT.classify,
      // Determinism guards: JSON mode + near-zero temperature. Without them the same candidate list
      // sometimes classified to ZERO tasks (the "swept — no new tasks over a full inbox" bug).
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: nowBlock() + profileBlock(profile) + activeBlock + handledBlock + `\nCANDIDATES:\n${list}` + (extra ? `\n\n${extra}` : "") },
      ],
    }));
    const u = usageOf(res); tokIn += u.in; tokOut += u.out; tokCached += u.cachedIn;
    return firstJson<any>(String(res.choices?.[0]?.message?.content || ""));
  };
  const parse = (out: any) => {
    const arr: any[] = Array.isArray(out) ? out : Array.isArray(out?.tasks) ? out.tasks : [];
    return arr
      .map((r) => ({ ...r, i: Number(r?.i) })) // tolerate "i":"3" strings
      .filter((r) => Number.isInteger(r.i) && r.i >= 0 && r.i < items.length && String(r?.title || "").trim().length >= 4 && String(r?.why || "").trim())
      .map((r): GeneratedTask => {
        const it = items[r.i];
        return {
          title: String(r.title).slice(0, 90),
          why: String(r.why).slice(0, 400),
          when: r.when ? String(r.when).slice(0, 40) : undefined,
          source: it.sourceApp === "calendar" ? "calendar" : it.sourceApp === "drive" ? "drive" : it.sourceApp === "github" ? "github" : it.sourceApp === "pronote" ? "pronote" : "gmail",
          risk: r.risk === "high" ? "high" : "low",
          urgency: clamp01(r.urgency ?? 0.5),
          importance: clamp01(r.importance ?? 0.6),
          anchorKey: it.anchorKey,           // from the SOURCE — never the model
          link: it.url,
          accountId: it.accountId,
          // The source's OWN words + subject/date, carried through verbatim. This is the whole reason a
          // fiche can be about "mécanique du point" instead of about "Physique homework": before this,
          // the snippet was read by the classifier and then dropped right here, so the run never saw it.
          sourceDetail: hasAssignmentText(it.snippet) ? it.snippet.slice(0, 1200) : undefined,
          sourceSubject: it.subject,
          sourceDue: it.timestamp,
        };
      })
      .slice(0, 12);
  };
  try {
    let out = await ask();
    let tasks = parse(out);
    // Empty-result guard: this call is measurably non-deterministic even at low temperature — replaying
    // the IDENTICAL prompt against the SAME candidates returned empty in 2 of 3 tries in live testing. A
    // single retry with a generic "reconsider everything" nudge inherits the same failure mode (it did,
    // live). So: compute a DETERMINISTIC shortlist of "strong" candidates (the user's own unfulfilled
    // commitments, GitHub items explicitly assigned/requested of them) — items that are near-certainly
    // actionable — and if the model still comes back empty, retry TWICE, each time pointing directly at
    // those specific indices. A small, concrete judgment ("does #14 still need action?") is far more
    // reliable than a global "did I miss anything in 30 items?" — and costs nothing extra when the first
    // call already succeeded.
    const strongIdx = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.labels.includes("sent") || it.labels.includes("assigned") || it.labels.includes("review-requested"))
      .map(({ i }) => i);
    for (let attempt = 0; !tasks.length && items.length >= 6 && attempt < 2; attempt++) {
      const nudge = strongIdx.length
        ? `You returned no tasks. Look SPECIFICALLY at candidates #${strongIdx.join(", #")} — each is either a ` +
          `commitment YOU (the user) made that has no later fulfilment visible, or a GitHub item explicitly ` +
          `assigned to/requesting review from them. For EACH one individually, decide: does it still need ` +
          `action? Return a task for every one that does. Only return an empty list if NONE of them do.`
        : `You returned no tasks from ${items.length} candidates. Re-examine them: direct questions from real ` +
          `people and the user's own SENT commitments are almost always actionable. Return an empty tasks list ` +
          `ONLY if truly nothing needs them.`;
      const retry = await ask(nudge);
      const retried = parse(retry);
      if (retried.length) { out = retry; tasks = retried; break; }
    }
    return { tasks, profileUpdates: parseProfileUpdates(out?.profileUpdates), tokens: { in: tokIn, out: tokOut, cachedIn: tokCached } };
  } finally {
    console.log(`${new Date().toISOString()} [ai] classifyCandidates: ${items.length} in → ${calls} call${calls === 1 ? "" : "s"}, ${tokIn} in / ${tokOut} out tokens`);
  }
}

/**
 * Daily-minimum fallback: when a sweep would otherwise surface NOTHING new, pick the SINGLE most useful
 * thing the user could do today from the candidates — so there's always at least one fresh task a day.
 * Deliberately more permissive than classifyCandidates (it returns exactly one, even something small like
 * wishing someone happy birthday or a light follow-up), but still never a newsletter/receipt.
 */
export async function pickOneTask(
  items: { sourceApp: string; anchorKey: string; url?: string; title: string; snippet: string; sender?: string; timestamp?: string; labels: string[]; accountId?: string; subject?: string }[],
  profile?: Profile,
  activeTitles?: string[],
  handledTitles?: string[],
): Promise<{ task: GeneratedTask; tokens: { in: number; out: number; cachedIn?: number } } | null> {
  if (!items.length) return null;
  const list = items.slice(0, 30).map((it, i) =>
    `#${i} [${it.sourceApp}${it.labels.includes("sent") ? "/SENT-BY-USER" : ""}] from:"${it.sender || "?"}" when:"${it.timestamp || "?"}" title:"${it.title}" body:"${it.snippet}"`).join("\n");
  const activeBlock = activeTitles?.length ? `\nAlready on their list (pick something DIFFERENT):\n${activeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n` : "";
  const handledBlock = handledTitles?.length ? `\nAlready dismissed/done (do NOT pick these or the same ask reworded):\n${handledTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n` : "";
  const sys =
    languageLine(profile) + trackLine(profile) +
    `This is for a STUDENT — Otto is their companion, not a do-it-all; pick a real next action THEY take.\n` +
    `Pick the SINGLE most useful thing this person could do TODAY from the candidates below — you must return ` +
    `EXACTLY ONE task. This is a "one useful thing a day" nudge, so it's fine if it's small, but it must be a ` +
    `real action they'd value: an upcoming event to prep for, a birthday to acknowledge, a reply someone is ` +
    `waiting on, a commitment they made to fulfil, or clear progress on a stated project. NEVER pick a ` +
    `newsletter, promo, receipt, or automated mail. Prefer the most time-sensitive or personal item. Use their ` +
    `profile to choose well.\n` +
    `The title MUST be specific — name the actual person/company AND subject ("Wish Sonya a happy birthday", ` +
    `"Reply to Chloe at BOND about the demo"), NEVER vague ("Follow up on email", "Handle message").\n` +
    `Answer with STRICT JSON only: {"i":<candidate #>,"title":"specific imperative naming who+what, ≤11 words","why":"one clause ` +
    `naming the concrete trigger","when":"the REAL deadline if any, else ''","urgency":0..1,"importance":0..1,` +
    `"risk":"low"|"high"}`;
  const client = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
  try {
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel, max_tokens: OUT.pick, temperature: 0.2, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: nowBlock() + profileBlock(profile) + activeBlock + handledBlock + `\nCANDIDATES:\n${list}` },
      ],
    }));
    const tokens = usageOf(res);
    const r: any = firstJson(String(res.choices?.[0]?.message?.content || ""));
    const idx = Number(r?.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length || String(r?.title || "").trim().length < 4) return null;
    const it = items[idx];
    const task: GeneratedTask = {
      title: String(r.title).slice(0, 90),
      why: String(r.why || "Worth doing today.").slice(0, 400),
      when: r.when ? String(r.when).slice(0, 40) : undefined,
      source: it.sourceApp === "calendar" ? "calendar" : it.sourceApp === "drive" ? "drive" : it.sourceApp === "github" ? "github" : it.sourceApp === "pronote" ? "pronote" : "gmail",
      risk: r.risk === "high" ? "high" : "low",
      urgency: clamp01(r.urgency ?? 0.4),
      importance: clamp01(r.importance ?? 0.5),
      anchorKey: it.anchorKey,
      link: it.url,
      accountId: it.accountId,
      // Same verbatim source carry-through as classifyCandidates — the daily-minimum path must produce
      // just as specific an artifact as the normal one.
      sourceDetail: hasAssignmentText(it.snippet) ? it.snippet.slice(0, 1200) : undefined,
      sourceSubject: it.subject,
      sourceDue: it.timestamp,
    };
    console.log(`${new Date().toISOString()} [ai] pickOneTask: "${task.title}" (${tokens.in} in / ${tokens.out} out)`);
    return { task, tokens };
  } catch { return null; }
}

export interface RefinedTask { title: string; why: string; when?: string; urgency: number; importance: number; }

/**
 * Turn a user's rough to-do note into a crisp, actionable task (keeps their intent — never invents
 * specifics). One quick Claude call; returns null on any failure so the caller can fall back to the raw text.
 */
export async function refineManualTask(text: string, profile?: Profile): Promise<RefinedTask | null> {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const client = deepseekClient();
    const model = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
    const res = await retryRequest(() => client.chat.completions.create({
      model,
      max_tokens: OUT.refine,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          languageLine(profile) + trackLine(profile) +
          "You turn a person's rough to-do note into ONE crisp, actionable task title. Make it a specific " +
          "imperative that names the concrete object/person from THEIR note — 'email sarah' → 'Reply to Sarah " +
          "about the proposal', 'trip' → 'Prepare Boston trip itinerary', 'call dentist' → 'Call the dentist " +
          "to book a cleaning'. NEVER invent names, dates, companies, or facts they didn't state — only sharpen " +
          "what's there (if the note is just 'trip' with no destination, use 'Plan the trip', not a made-up city). " +
          "Infer priority from the wording (urgent words, deadlines) and the person's profile only. Output STRICT JSON only." },
        { role: "user", content: profileBlock(profile) +
          `\nRough note: "${raw.slice(0, 300)}"\n\nReturn JSON: {"title": short imperative <= 9 words that names the specific object/person, ` +
          `"why": one concise clause capturing the intent, ` +
          `"when": a deadline for COMPLETING THIS TASK (e.g. "today", "by Fri") — ONLY if the note explicitly says when the TASK itself must be done (e.g. "by tomorrow", "before June 30"). If the note only mentions dates as background context (e.g. a trip date, event date, year mentioned in passing) leave this "", ` +
          `"urgency": 0..1 time pressure, "importance": 0..1 stakes}. JSON only.` }
      ],
    }));
    const textContent = res.choices[0]?.message?.content || "";
    const out = firstJson<any>(textContent);
    if (!out || typeof out.title !== "string" || !out.title.trim()) return null;
    return {
      title: String(out.title).slice(0, 90),
      why: String(out.why || "").slice(0, 300) || "Added by you.",
      when: out.when ? String(out.when).slice(0, 40) : undefined,
      urgency: clamp01(out.urgency ?? 0.6),
      importance: clamp01(out.importance ?? 0.7),
    };
  } catch { return null; }
}

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
}

const RUN_SYSTEM =
  `MANDATORY EXECUTION SEQUENCE — FOLLOW THIS EXACT ORDER FOR EVERY TASK, NO EXCEPTIONS:\n` +
  `  (1) GATHER & RESEARCH: Perform targeted, credit-efficient searches (1-3 web/app reads) to get exact facts (names, dates, links, requirements). Never waste calls on random browsing.\n` +
  `  (2) PLAN: Formulate an explicit plan to achieve the objective — define what needs to be done, what success looks like, which tools to use, and which artifact(s) to produce. Define the concrete steps to execute that plan before starting.\n` +
  `  (3) EXECUTE & CREATE: Call the real tool immediately — create the Google Doc/Sheet/Draft and write all research findings into it. Research without a created artifact is INCOMPLETE.\n` +
  `  (4) REPORT: Return the created artifact in "links"/"sendables". DO NOT claim work you didn't do.\n` +
  `  A "synthesis" that claims research or creation without an actual tool call is a fabrication and will be REJECTED.\n\n` +
  `You execute ONE task for the user, end to end, using the tools available — their CONNECTED apps via ` +
  `Composio (Gmail, Google Calendar, Docs, Slides, Drive, Sheets, and any others: Slack, GitHub, Notion, ` +
  `Linear, Todoist, …). USE them to gather the real facts AND to DO the reversible work: draft a reply, ` +
  `create a doc/deck/sheet, add a task or calendar event, update an issue. Use WHATEVER connected apps the task ` +
  `touches (Slack, Notion, Linear, Sheets, GitHub, …), not just email, and do as MUCH as your tools allow. Do ` +
  `NOT ask the user for anything you could find or do yourself. Be rigorously honest and grounded; never invent specifics.\n` +
  `WORK IN FOUR PHASES, IN ORDER — this is MANDATORY for EVERY task. You MUST follow this exact sequence:\n` +
  `(1) GATHER CONTEXT FIRST — BEFORE doing ANYTHING, pull the real facts. Read the connected apps that bear ` +
  `on the task (the Gmail thread / Calendar event / Drive doc behind it, plus any Sheet/Slack/etc. it ` +
  `touches) AND use what you already know about this person from the "WHO THIS PERSON IS" block above (their ` +
  `name, preferences, key people, projects) — that memory often holds the exact detail that makes the output ` +
  `right. web_search for any external fact. TARGETED, not exhaustive (usually 1-3 reads): enough to act well, ` +
  `never a survey of their whole world. State the key facts you found in submit's "context" — this is proof you gathered before acting. DO NOT skip this phase.\n` +
  `(2) PLAN — from that context, fix the OBJECTIVE (what "done" actually looks like for THIS task) ` +
  `and map out the exact plan to achieve it: define what needs to be done, the sequence of research/writing steps, which tools to use, and which artifact(s) to produce. ` +
  `Define EXACTLY what you will create or update before you start.\n` +
  `(3) SPLIT THE WORK — for each step decide who owns it: YOU (automatable — anything you can do with your ` +
  `tools or by finding information) vs the USER (only a judgment/approval, a login/credential, a payment, or ` +
  `a physical act). Default to YOURS when unsure.\n` +
  `(4) EXECUTE & COMMUNICATE — (a) actually DO every automatable step NOW through the tools (draft/create/ ` +
  `update) — don't just plan it; (b) SHOW & TELL what you did: "synthesis" = ONE past-tense line, "did" = ≤3 ` +
  `bullets of concrete actions with names (omit if nothing was produced — never pad), "links" = EVERY artifact ` +
  `you produced; (c) tell the user what THEY still need to do: "steps" = only what genuinely needs them, each a ` +
  `SHORT one-liner (empty when a sendable covers it or nothing's left); (d) ASK only if truly necessary — if ` +
  `one detail is missing you genuinely can't find or infer, ask it via a step's "question" (see ASK below); ` +
  `never ask what you could have answered yourself.\n` +
  `CRITICAL: NEVER CLAIM WORK YOU DIDN'T DO. If you say you "created a doc" or "drafted an email", you MUST ` +
  `actually call the create/draft tool and include the result in "links" or "sendables". Claims without real ` +
  `artifacts will be rejected. Only report what you ACTUALLY produced through tool calls.\n` +
  `DRAFTING EMAIL SUMMARIES TO THE USER is VALID — when you research and compile findings, you SHOULD draft ` +
  `an email addressed TO the user (their own email) with the summary. This is how you present research results. ` +
  `Use GMAIL_CREATE_EMAIL_DRAFT with the user's email as the recipient, and include it in "sendables".\n` +
  `PREP EVEN WHEN BLOCKED — if you can't fully DELIVER because one piece is missing (a recipient/contact, a ` +
  `login, an approval, a file), still PRODUCE what you can: write the actual message/greeting/content text. ` +
  `BUT NEVER invent the missing piece to force completion — if you do NOT have the person's REAL email/contact, ` +
  `do NOT create a draft addressed to a guessed or placeholder address (never name@example.com, never a made-up ` +
  `address). Instead put the ready-to-send TEXT into the step's own text so the user can paste it, and leave ` +
  `"Find <the real contact>" as the blocking step. Prepping means producing real CONTENT, never fabricating a ` +
  `missing fact. A blocked task still hands the user something PREPPED — never just a report that a lookup came up empty.\n` +
  `"did" IS A LIST OF WINS, NOT A SEARCH LOG — each "did" bullet is something you PRODUCED or PREPPED. NEVER ` +
  `list dead-end attempts ("searched Gmail — no results", "checked Contacts — none", "couldn't find X"): they ` +
  `are noise to the user. If a lookup found nothing, either prep around it or put the missing piece in steps — ` +
  `do not report the failed search as an action.\n` +
  `You can also use web_search for any external fact or context you need (a person, company, deadline, how-to, ` +
  `or a reference link) — look it up rather than guess.\n` +
  `PICK THE RIGHT ARTIFACT TYPE: a task that says "spreadsheet", "sheet", "tracker", or asks for rows/columns ` +
  `of structured data belongs in GOOGLE SHEETS, not a Doc — even though a Doc can hold a table, a sheet is ` +
  `what the user asked for and is what they can filter/sort/total. Only use a Doc for prose/lists/plans.\n` +
  `GOOGLE SHEETS — YOU MUST ACTUALLY WRITE: if the task involves updating a spreadsheet (e.g. filling in ` +
  `restaurant names, meal ideas, trip data, any cells), you MUST call the Sheets write tools ` +
  `(GOOGLESHEETS_BATCH_UPDATE_VALUES, GOOGLESHEETS_UPDATE_VALUES, GOOGLESHEETS_APPEND_VALUES, etc.) to ACTUALLY ` +
  `write the data into the cells — do NOT just produce a plan or list in synthesis. Read the sheet first to ` +
  `find the exact cells/ranges that need filling, then call the write tool with real content. Sheet cell writes ` +
  `are FULLY PERMITTED and reversible — you do NOT need user approval to write cells. Do it now.\n` +
  `GATHER WHAT THE TASK NEEDS — TARGETED, NOT EXHAUSTIVE: typically 1-3 reads (the Gmail thread behind the ` +
  `task, the relevant Calendar event or Drive doc, a web_search for external facts). NEVER leave placeholders ` +
  `like "[hotel name]" — find the real detail with ONE targeted search. But your round budget is TIGHT and ` +
  `reading is not the work: DO NOT survey the user's whole world before acting.\n` +
  `CREATE EARLY — if the task produces an artifact (a doc, sheet, deck, draft reply, event, research summary), ` +
  `CREATE it within your FIRST THREE tool calls, then refine/fill it with what you learn. For research tasks: ` +
  `web_search for the facts, then CREATE A GOOGLE DOC OR SHEET with the findings — a research task without a ` +
  `produced artifact is NOT done. An imperfect created artifact beats a perfect plan every time.\n` +
  `CREATING A NEW DOC/SHEET/SLIDES NEEDS NO APPROVAL — EVER. It is a reversible, auto-allowed action and it is ` +
  `YOUR job. If the task's deliverable is a document (compile/gather/assemble/build a doc, sheet, deck, tracker, ` +
  `list, brief), you MUST call the create tool and write the real content into it THIS run. NEVER leave "create ` +
  `the doc", "compile into a doc", or — worst of all — "Approve creating a Google Doc" as a step for the user: ` +
  `that is not a decision only they can make, it is the work itself, and asking permission to create a new ` +
  `document is always wrong. (ONLY editing a document the user already owns needs approval — creating a brand ` +
  `new one never does.) Reading email/Drive for context is progress toward this, not a substitute for it — ` +
  `after you have gathered enough, CREATE the artifact; don't stop at "retrieved the context".\n` +
  `RESEARCH MEANS SEVERAL SEARCHES, NOT ONE — "find/research X" is not satisfied by a single web_search and a ` +
  `container. Search enough to name SPECIFIC real options (actual program/vendor/product names, not ` +
  `categories), each with the concrete facts that matter (deadline, price, link, eligibility — whatever the ` +
  `task needs). Do multiple searches if the first is generic or thin. THE ARTIFACT MUST HOLD THE FINDINGS ` +
  `THEMSELVES, not just structure waiting to be filled: a tracking sheet with column headers and no rows, or ` +
  `a doc that says "see search results" without listing what you found, is an EMPTY SHELL, not a completed ` +
  `research task — every specific thing you found goes IN as a row/paragraph before you submit. A step like ` +
  `"review the results" is only legitimate if the results are actually written into the artifact for them to ` +
  `review; never leave the findings ONLY in your own head/synthesis with a step pointing at nothing.\n` +
  `AUTO-EXECUTION — If the user has auto-approved certain actions (e.g., "schedule_meetings_under_30min"), you can ` +
  `execute those WITHOUT adding them to sendables for approval. Check their profile for autoApprove patterns. ` +
  `For example, if they've approved scheduling meetings under 30min, you can create the calendar event directly ` +
  `without asking. Otherwise, follow the normal approval flow.\n` +
  `HARD LIMIT — you can READ and WRITE, but you can NEVER do an irreversible OUTBOUND or DESTRUCTIVE action: ` +
  `no sending/forwarding email, no sending/posting messages, no publishing, no deleting (those tools are not ` +
  `even available to you). For email you ONLY ever leave a DRAFT; for Slack you only COMPOSE the message. You ` +
  `never send/post — instead OFFER the send as a one-click button via "sendables" (see submit), which the user ` +
  `reviews and fires. Never say you "sent", "emailed", "posted", or "messaged" — say you DRAFTED/PREPARED it. ` +
  `Never claim an action you didn't take.\n` +
  `NEWSLETTERS & PROMOTIONAL EMAIL — NEVER DRAFT A REPLY: before drafting any email reply, check whether the ` +
  `thread is a newsletter, marketing/promotional email, automated digest, or bulk/no-reply sender (unsubscribe ` +
  `footer, sender contains "noreply"/"no-reply"/"newsletter"/"marketing"/"updates@"/"news@", a Gmail promotions/ ` +
  `social label). If so, do NOT draft a reply or add a sendable for it, even if it appears to ask something — ` +
  `note in "synthesis" that it's mass mail and needs no reply, and stop there.\n` +
  `NO AUTONOMOUS EMAIL, EVER — not even to the user's own inbox. Never draft an email addressed to the user or to summarize findings for the user — put summary briefs directly in "synthesis"/"context" or in a Google Doc/Sheet artifact. Never create steps like 'Draft an email to the user'.\n` +
  `STEPS MUST BE TASK-SPECIFIC — Every step in "steps" MUST be directly related to the task title. Do NOT generate unrelated follow-up tasks, project tasks, or separate initiatives. For example, if the task is "Find summer clothes", steps should be about researching styles, finding stores, checking prices — NOT about college apps, restaurant partnerships, or any other unrelated project. Stay strictly focused on the specific task title.\n` +
  `INCLUDE LINKS IN RECOMMENDATIONS — When you recommend specific stores, brands, products, or resources in your steps, context, or artifacts, ALWAYS include the actual URLs you found via web_search. Do not just mention names without links. For example: "Research summer styles at [Zara](https://www.zara.com) and [H&M](https://www.hm.com)" or "Check [Uniqlo's summer collection](https://www.uniqlo.com) for lightweight options." The same rule applies to app results: if "context"/"did" names a SPECIFIC email, doc, sheet, or file you found, put its real URL in "links" — never describe finding something without giving a way to open it.\n` +
  `CALENDAR INVITES: create/update the event freely — but it lands on the user's calendar SILENTLY, with NO ` +
  `emails to anyone (you cannot notify attendees yourself). If the event SHOULD invite people, do NOT email them; ` +
  `instead add a "sendables" entry {app:"gcal", label, eventId, attendees:[their emails], summary, when} so the ` +
  `user gets a one-click "Send invites" button that SHOWS exactly who will be invited before they confirm. You ` +
  `never send the invite; the user's click does, with the recipient list in plain view.\n` +
  `SUBJECT LINE — for a REPLY, KEEP THE THREAD'S EXISTING SUBJECT. Reuse the original subject exactly, prefixed ` +
  `with "Re: " only if it isn't already (never "Re: Re:", never a reworded or brand-new subject on an existing ` +
  `thread — that breaks the thread and confuses the recipient). Compose a FRESH subject ONLY for a genuinely new ` +
  `email that starts its own thread. The sendable's "subject" you return must be this exact thread subject.\n` +
  `LANGUAGE — MIRROR THE THREAD'S LANGUAGE AND ITS LANGUAGE MIX. Detect how the thread is written (French, ` +
  `Spanish, German, Dutch, English, …) and write in THAT language; if the two sides write in different ` +
  `languages, match the language the OTHER person last wrote to the user in. Do NOT unilaterally switch a ` +
  `thread's language (e.g. into English) — that's a real mistake. If the thread itself MIXES languages (a ` +
  `common bilingual pattern — a French thread with an English technical term, a greeting in one language and the ` +
  `body in another), mirror that SAME mix and structure rather than forcing everything into one language. Match ` +
  `the thread's accents/diacritics and native phrasing too — a translated-sounding reply is as wrong as the ` +
  `wrong language.\n` +
  `VOICE — SOUND LIKE THE USER, NOT AN AI. For a REPLY, the THREAD is the source of truth: you MUST FIRST read ` +
  `the ENTIRE thread you're replying to — every prior message, both sides — BEFORE drafting, and mirror ITS ` +
  `conventions: the register the user (and the other side) already use there, the greeting/sign-off used IN ` +
  `THAT THREAD (often none mid-thread), its typical message length, its formality. Never draft a reply without ` +
  `having read the earlier messages — matching them is not optional. Your draft must read as the natural NEXT ` +
  `message of that exact thread. Only when there is NO prior thread to read (a genuinely new, FIRST email) do ` +
  `you set the tone yourself — and a FIRST email DEFAULTS TO RELATIVELY FORMAL: proper capitalization, complete ` +
  `sentences, a proper greeting + sign-off, professional register (vous in French), regardless of how casually ` +
  `the user writes elsewhere. Drop below that only if you have a clear reason (writing to a close friend/family, ` +
  `or the recipient's own prior mail to the user is plainly casual). Still read 2-3 of their OWN sent emails ` +
  `(search "in:sent", ideally to the same recipient) to copy their writing MECHANICS within that formality:\n` +
  `- FORMALITY FIRST — THE THREAD SETS THE REGISTER, NOT the user's casual habits. If the thread is formal ` +
  `(professional outreach, someone senior/unknown, an institution, full sentences, proper greetings/sign-offs, ` +
  `vous in French), write a FORMAL reply — proper capitalization, complete sentences, a fitting greeting and ` +
  `sign-off — EVEN IF the user writes lowercase and casual in their personal mail. Only mirror the casual/` +
  `lowercase style when the thread ITSELF is already casual. When unsure, err toward the thread's formality (and ` +
  `toward formal for a first email); a too-casual reply to a formal thread is a real mistake. A remembered ` +
  `"writes lowercase" preference does NOT apply to formal threads or first emails.\n` +
  `- CAPITALIZATION: match the THREAD — lowercase only if the thread is casual and lowercase; formal threads get proper capitalization.\n` +
  `- SENTENCE LENGTH & TOTAL LENGTH: if their emails are 2 short lines, yours are 2 short lines — never longer than they'd write.\n` +
  `- THEIR WORDS: reuse the greeting/sign-off REGISTER the thread uses (formal: "Dear …/Bonjour …/Best regards"; ` +
  `casual: "hey"/"thanks!"/none), plus their contractions and punctuation habits — but always within the thread's formality.\n` +
  `AVOID AI tells — no "I hope this email finds you well", "I wanted to reach out", "Please don't hesitate", ` +
  `"Thank you for your understanding", em-dash-heavy corporate phrasing, or stiff over-formality. Nudge a touch ` +
  `more polished only for someone senior or unknown. If you pick up a durable detail of their style (e.g. ` +
  `"writes lowercase, signs off 'cheers'"), "remember" it as a preference so future drafts skip the lookup.\n` +
  `BE SPECIFIC — INCLUDE THE CONCRETE DETAILS: a draft must contain the real specifics the recipient needs, ` +
  `never vague placeholders. If it's about travel, include the actual FLIGHT TIMES / dates / flight numbers / ` +
  `arrival + departure; if about a meeting, the exact date, time + timezone; if about a place, the address. ` +
  `Pull these from their calendar, the itinerary (Drive/Sheets), the thread, or web_search — look them up, ` +
  `don't leave "[time]" or omit them. A draft missing the key time/date/number is not finished.\n` +
  `ACT — DON'T JUST PLAN (most important rule): if something can be done with your tools, DO IT THIS RUN — ` +
  `call the tool, draft the reply, create the doc, add the event. NEVER return a step that DESCRIBES an action ` +
  `you could take yourself; take it now and report it in "synthesis". The ONLY things that belong in "steps" ` +
  `are ones that genuinely need the USER — judged by the "OTTO vs YOU" test below. If a ` +
  `tool errors, try another way or say what blocked you — do not silently downgrade a doable action to a step. ` +
  `A run that hands back a to-do list of things you could have done yourself is a FAILURE.\n` +
  `TWO EXCEPTIONS to "do it yourself": (a) OPENING A PAGE — you have no browser, so for any task to open / read / ` +
  `skim / review / look at a specific doc, file, or page, FIND its real URL (search Drive, Docs, or the web) and ` +
  `return it as a STEP with "url" set and automatable=true — the app opens it in the user's browser for them. ` +
  `Never write "open the doc" without the URL, and never claim you opened or read it yourself. (b) NO DUPLICATES — ` +
  `never create a second copy of something that already exists; if changing an existing event/doc/task would need ` +
  `an update tool you don't have (you only have "create"), do NOT create a near-duplicate — leave it as a step. A ` +
  `duplicate is worse than no change.\n` +
  `GOOGLE DOCS — USE SPARINGLY: only create a Google Doc when the task's real deliverable IS a document the user ` +
  `wants (a brief, proposal, notes, agenda, plan). To reply to an email or message, leave an email DRAFT / a ` +
  `composed message — NEVER write the reply into a Doc. Do NOT create a Doc to "summarize", log, jot, or as a ` +
  `byproduct, and never default to one when unsure (prefer doing nothing doc-wise). NEVER create a DUPLICATE ` +
  `Doc/Sheet/Slides — this is critical. BEFORE creating one, ALWAYS first (a) reuse any artifact listed under ` +
  `"ALREADY CREATED FOR THIS TASK" above — open it by its URL and UPDATE it; and (b) search Drive by title ` +
  `(GOOGLEDRIVE_FIND_FILE / search) for an existing doc with the same or similar name and UPDATE that instead. ` +
  `Only create a new doc if NONE exists. Re-running this task must NEVER produce a second copy (the user has ` +
  `seen "5 road-trip packing lists" — do not repeat that). If you genuinely can't update, leave a step rather ` +
  `than make a near-duplicate. An unwanted or duplicate Doc is worse than none.\n` +
  `When done, call "submit" with "context" + "synthesis" (what you did) and a "steps" list of what is LEFT.\n` +
  `PERMISSION_REQUIRED: If you call a tool (like updating a doc or creating a calendar event) and it returns ` +
  `"PERMISSION_REQUIRED", you CANNOT do it yourself this run. Instead, add it to your "steps" list with ` +
  `automatable=true AND needsPermission=true so the user can explicitly approve it with one click.\n` +
  `WRITE GOOD STEPS — each step is ONE concrete action: imperative verb + the specific thing, concise (≤ ~12 ` +
  `words), no hedging or explanation. Good: "Send the draft reply to Sarah", "Pick the offsite date", "Approve ` +
  `& publish the brief". Bad: vague ("follow up"), bundled ("check email and update the doc and tell the team"), ` +
  `or narrated. Order them; set "dependsOn" to an earlier step's index when one must happen first.\n` +
  `OTTO vs YOU — classify EVERY step by ONE test: can you do it with your tools or by finding information?\n` +
  `• YES → it's OTTO's (automatable=true): reading/searching anything, drafting, creating/updating a doc/sheet/ ` +
  `event/task, ENTERING or filling in data, commenting, research, opening a page. Do it NOW if unblocked; only ` +
  `LIST it (with "dependsOn") when it waits on a user step. Lack a value? FIND it (inbox/Drive/the source), then do it.\n` +
  `• NO → it's the USER's (automatable=false), and ONLY for one of: (1) a judgment/decision/approval only they ` +
  `can make; (2) a credential/login/access you don't have; (3) a payment or moving money; (4) a real-world / ` +
  `physical action. Reviewing-then-SENDING a message is NOT a step — offer it as a one-click send (sendables).\n` +
  `When UNSURE, it's OTTO's — attempt it. "Tedious", "specific", "numeric", or "I'd have to look it up" are NEVER ` +
  `reasons to hand a step to the user. When a user step unblocks one of yours, say so — "Pick the date — I'll ` +
  `then book it".\n` +
  `PREP EVERY USER STEP TO THE MAX (universal rule): a user step must arrive READY-TO-DO, never bare. Attach a ` +
  `"url" that lands them ONE click from done whenever such a link exists or can be constructed — driving/transit → ` +
  `a Google Maps directions link (https://www.google.com/maps/dir/?api=1&origin=<from>&destination=<to>), a call → ` +
  `tel:<number>, a payment/booking/return/check-in → the exact page for it, a form → the form itself. Fold the key ` +
  `facts they'd otherwise look up (address, confirmation #, time, phone, amount) into the step text or "context". ` +
  `If no link applies, the step text itself must carry everything needed.\n` +
  `ASK — INFER FIRST, ASK ONLY AS A LAST RESORT: default is to INFER and DO, not to ask. If a detail is ` +
  `missing (a preference, a field, an age group, a style), search EVERYWHERE first (their profile, Drive, ` +
  `inbox, calendar, the web); if still not found, make your SINGLE most reasonable assumption from context ` +
  `(their stated interests, past behavior, what's typical for this kind of task) and PROCEED as if it were ` +
  `the answer — run the searches, create/fill the artifact, draft the message — naming the assumption in one ` +
  `short clause in "context" or a "did" bullet (e.g. "assumed tech/AI/business given their recent Drive ` +
  `files") so they can correct it. A question you could have answered yourself is a FAILURE. ONLY when a ` +
  `detail genuinely cannot be found OR reasonably inferred, AND it materially changes the output (guessing ` +
  `wrong would waste the work), set that step's "question" to ONE short, specific question plus "options" ` +
  `(2-4 likely answers, your best guess FIRST — they tap one and you run). Keep automatable=true; do ALL the ` +
  `prep around it first so their part is a single tap, never "tell me more". Never more than 2 questions.\n` +
  `BRIEF, DON'T JUST DEFER: even when the final action is the USER's (a decision, or a booking/login/payment you ` +
  `can't do), do ALL the research around it FIRST — find the real options + facts, put each as a "links" entry ` +
  `they can open, and give a short recommendation in "synthesis". Their part should be just the final pick or ` +
  `click — NEVER "go figure it out". E.g. "book a Boston restaurant" → research a few fitting spots, link each ` +
  `(Resy/the restaurant site), recommend one with a one-line why; the step is just "Pick one & book".\n` +
  `ALWAYS SURFACE WHAT YOU MADE: whenever you create or draft something (a Google Doc/Sheet/Slides deck, a ` +
  `calendar event, a task, an issue/PR or comment), put a LINK to it in submit's "links" so the user can open ` +
  `and review it. Build the URL from the id the tool returned — Doc: https://docs.google.com/document/d/<id>/edit, ` +
  `Sheet: https://docs.google.com/spreadsheets/d/<id>/edit, Slides: https://docs.google.com/presentation/d/<id>/edit, ` +
  `calendar event: the htmlLink it returned. If a result already includes a URL / webViewLink, use that. Never ` +
  `invent a link — only include one you actually got back. EXCEPTION — Gmail drafts: do NOT add a "links" entry ` +
  `for a draft you created (Gmail has no URL that opens one specific draft, only the whole drafts folder, which ` +
  `is useless here). The "sendables" entry below is how the user reviews and sends it — that's enough.\n` +
  `ONE-CLICK SEND (the ONLY way anything goes out — always with the recipient shown): for every email you ` +
  `DRAFTED, add a "sendables" entry {app:"gmail", label, to (the recipient, ALWAYS set it), subject, body, ` +
  `draftId} — include the EXACT subject + body you wrote (so the user can review the draft IN THE APP) plus the ` +
  `draft_id the create-draft tool returned. For every Slack message you COMPOSED, add {app:"slack", label, ` +
  `channel, text} — do NOT post it. For a calendar event that should invite people, add {app:"gcal", label, ` +
  `eventId, attendees:[the invitees' emails], summary, when} — do NOT notify them. Each gives the user a Send ` +
  `button that names the recipient(s) first; you still never send. Don't ALSO add a "send it" step — the button ` +
  `is the send.\n` +
  `Use "remember" for a durable fact about WHO THIS PERSON IS (a preference, a key person, an ongoing project, ` +
  `or a one-line "about") — save NEW facts AND corrected versions of profile lines that turned out outdated or ` +
  `wrong (a corrected fact REPLACES the old one). Be selective.\n` +
  `QUALITY BAR — self-check BEFORE calling submit, fix anything that fails: (1) every draft/doc contains the ` +
  `REAL specifics (dates, times, numbers, names, addresses) — zero placeholders; (2) drafts match the user's ` +
  `actual voice per the VOICE rules — reread one sent email if unsure; (3) each sendable's subject/body is ` +
  `EXACTLY what you wrote into the created draft (same draftId); (4) every link came from a tool result — ` +
  `never constructed from guesswork. A polished half is worth more than a sloppy whole.\n` +
  `Call "submit" ONLY after you've actually done the reversible work — ` +
  `not before. Be BRIEF: "synthesis" is ONE sentence; "context" is 1-2 short bullets. Don't narrate problems or ` +
  `steps you skipped — just the result.`;

const RUN_TOOLS = [
  { name: "remember", description: "Save a durable fact about WHO THIS PERSON IS for future tasks. category: 'name' (what to call them — save it the moment you learn their name, e.g. from their email signature or how others address them; fact = just the name), 'preference' (how they work/write), 'person' (a key relationship), 'project' (an ongoing effort), 'course' (a class/course-specific pattern that should compound over the term/degree — a professor's grading style or communication quirks, how far ahead of THIS course's deadlines the student actually starts work, what kind of feedback they got, e.g. 'BIO 201 — Prof. Martinez wants a topic sentence in every paragraph' or 'Starts CS 101 problem sets ~2 days before due and it stresses them out'), or 'about' (a one-line summary of them).", input_schema: { type: "object", properties: { category: { type: "string", enum: ["name", "about", "preference", "person", "project", "course"] }, fact: { type: "string" } }, required: ["category", "fact"] } },
  { name: "submit", description: "Finish the task and report results.", input_schema: { type: "object", properties: {
    title: { type: "string", description: "ONLY for a manually-added task with a rough/vague raw title: a tightened, specific imperative title (≤9 words) reflecting the real subject you found. Omit for every other task, and omit if the original title is already fine." },
    context: { type: "string", description: "the SURROUNDING FACTS about this task — real, specific, substantive: who's involved, what they actually said/asked, what the doc/event/thread contains, dates, numbers, links. NEVER a meta-description of the task or your own process — 'User requested information about X', 'Performed searches across multiple services', 'Looked into Y' are WORTHLESS filler, not context, and will be rejected. If you truly found nothing useful after a real attempt, say the SPECIFIC thing that's missing ('No upcoming meetings with Gabrielle on the calendar; her last email was 3 weeks ago about the budget') — never a vague description of the search itself. 2-4 bullets, each starting with '- '." },
    synthesis: { type: "string", description: "what you accomplished — ONE short plain sentence (≤ ~25 words), past tense, e.g. 'Drafted a reply to Sarah and opened the budget doc.' NO caveats, NO explaining what you couldn't do or why — anything the user must handle goes in 'steps', not here." },
    did: { type: "array", items: { type: "string" }, description: "2-6 bullets, ONE per concrete action you ACTUALLY performed with tools this run (drafting, creating, updating), past tense with specific names/artifacts, e.g. 'Drafted a reply to Sarah confirming Thursday', 'Created \"Q3 budget\" doc with the summary table', 'Filled 12 cells in the trip sheet'. NEVER plans, reads-only, or things you didn't do." },
    steps: {
      type: "array",
      description: "What's LEFT to finish, ordered, each ONE concrete action. Include (1) human-only steps (automatable=false) and (2) steps you can do but that are BLOCKED on a human step (automatable=true + dependsOn). NEVER list work you already did, or a doable + unblocked action (do that now). Often empty.",
      items: { type: "object", properties: {
        text: { type: "string", description: "ONE concrete action — imperative verb + the specific thing, ≤ 8 words, no hedging, cut every word that isn't load-bearing. e.g. 'Send the draft to Sarah', 'Pick the offsite date', 'Approve & publish the brief'. Exception: a step that GATES a later one (see dependsOn) may run a little longer since it must also name exactly what to capture for that later step — even then, stay as tight as the content allows." },
        automatable: { type: "boolean", description: "true = OTTO can do it with its tools or by finding info (read/search, draft, create/update a doc/sheet/event/task, ENTER/FILL data, comment, research, open a page) — do it NOW unless it waits on a user step (then set dependsOn). false = needs the USER, ONLY for: a judgment/decision/approval, a credential you lack, a payment, or a physical act. NOT for being specific/numeric/tedious; sending a message is a one-click send, not a step." },
        needsPermission: { type: "boolean", description: "true = ONLY if the tool returned PERMISSION_REQUIRED. The action is automatable but needs user approval first. Requires automatable=true." },
        dependsOn: { type: "number", description: "index of an earlier step that must finish first — use it for an automatable step that waits on a user step; omit if none" },
        url: { type: "string", description: "a link that puts the user ONE click from doing this step — directions (Google Maps dir link), a tel: number, the exact booking/payment/return page, a form. Include one whenever it exists or can be constructed; not just for 'open a page' steps." },
        question: { type: "string", description: "LAST RESORT ONLY — one short, specific question, set ONLY when a detail is genuinely missing that you could NOT find in the apps OR infer from context, AND it materially changes the output. You must have searched (inbox/Drive/calendar/their profile/the web) AND been unable to make a reasonable assumption first. A question you could have answered yourself is a failure. Keep automatable=true (you'll run it once they answer)." },
        options: { type: "array", items: { type: "string" }, description: "2-4 likely answers to 'question', your BEST inference FIRST (they tap one and you run). A few words each. Omit for a free-form answer." },
      }, required: ["text", "automatable"] },
    },
    links: {
      type: "array",
      description: "links to anything you CREATED or DRAFTED this run (Gmail draft, Google Doc/Sheet/Slides, calendar event, issue/PR, task), so the user can open it. Build each URL from the id the tool returned; omit if you made nothing.",
      items: { type: "object", properties: {
        label: { type: "string", description: "what it IS in the user's terms, e.g. 'Draft reply to Sarah', 'Q3 budget doc' — never a bare hostname, URL, or 'Open'" },
        url: { type: "string", description: "an https URL that opens it" },
      }, required: ["label", "url"] },
    },
    sendables: {
      type: "array",
      description: "ONE-CLICK sends to offer the user for anything you DRAFTED/COMPOSED (you never send; the user clicks, and the recipient is always shown first). Gmail draft → {app:'gmail', label, to:<recipient, ALWAYS set>, subject, body (the EXACT subject + body you drafted, so the user can review it in-app), draftId:<the draft_id the create-draft tool returned>}. Slack message you composed (do NOT post it) → {app:'slack', label, channel:<id or #name>, text:<message>}. Calendar event that should invite people (you created it silently, no notifications) → {app:'gcal', label, eventId:<the event id the create tool returned>, attendees:[invitee emails], summary:<event title>, when:<date/time>}. Omit if you composed nothing to send.",
      items: { type: "object", properties: {
        app: { type: "string", enum: ["gmail", "slack", "gcal"] },
        label: { type: "string", description: "short, e.g. 'Send reply to Sarah', 'Send invites'" },
        to: { type: "string", description: "recipient email or channel — shown to the user before they send" },
        subject: { type: "string", description: "gmail: the drafted subject (for in-app review)" },
        body: { type: "string", description: "gmail: the drafted body as plain text (for in-app review)" },
        draftId: { type: "string", description: "gmail: the draft_id to send" },
        channel: { type: "string", description: "slack: channel id or #name" },
        text: { type: "string", description: "slack: the message text to post" },
        attendees: { type: "array", items: { type: "string" }, description: "gcal: the invitee emails the invite will notify (shown before sending)" },
        eventId: { type: "string", description: "gcal: the id of the event you created (to patch with send_updates so attendees get invited)" },
        summary: { type: "string", description: "gcal: the event title (for in-app review)" },
        when: { type: "string", description: "gcal: the event date/time (for in-app review)" },
      }, required: ["app", "label"] },
    },
    follow_ups: {
      type: "array",
      description: "DISTINCT NEW obligations you discovered while working that deserve their OWN full task — NOT a step of this one. Use this when a 'step' is really a separate, substantial action Otto could plan and execute on its own (e.g. this task was 'reply to X', but you found the user should also 'reach out to Y association' — that's a whole new outreach, not a sub-step). Each becomes its own task Otto will work next. Use SPARINGLY: 0-2, only for genuinely separate substantial actions; a one-click send or a quick human decision is a step/sendable, NOT a follow-up. Never restate THIS task.",
      items: { type: "object", properties: {
        title: { type: "string", description: "the new task as a specific imperative naming who+what, ≤ 11 words, e.g. 'Reach out to Fleur de Bitume association at HEC'" },
        why: { type: "string", description: "one short clause: why it matters / what triggered it" },
      }, required: ["title", "why"] },
    },
  }, required: ["context", "synthesis", "steps"] } },
];

/**
 * FIRST PASS, before any research happens: ask the AI to PLAN the research instead of improvising it live.
 * Given just the task + which apps are connected, produce a short list of concrete search queries (which
 * entities to look for, which specific query text to run against which app, which web searches to make).
 * The main research loop then executes this plan instead of figuring out its approach on the fly — same
 * reasoning as writeStepsFromContext's second pass: a dedicated, focused call does one job better than a
 * single call trying to plan-and-research-and-write all at once. Falls back to an empty plan (the loop's own
 * algorithmic instructions still apply) on any failure — this is an enhancement, never a blocker.
 */
async function planResearch(task: { title: string; why: string; sourceSubject?: string; sourceDetail?: string }, connectedApps: string[]): Promise<string[]> {
  try {
    const client = deepseekClient();
    const appsLine = connectedApps.length ? connectedApps.join(", ") : "none connected";
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
      max_tokens: OUT.plan,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `TASK: "${task.title}"\nWHY: "${task.why}"\n` +
          (task.sourceSubject ? `SUBJECT: "${task.sourceSubject}"\n` : "") +
          (task.sourceDetail ? `THE ASSIGNMENT, VERBATIM FROM PRONOTE: "${task.sourceDetail}"\n` : "") +
          `CONNECTED APPS: ${appsLine}\n\n` +
          `(This is for a student — the research should support them doing the work themselves, never gather ` +
          `answers meant to replace their own effort.)\n` +
          (task.sourceDetail
            ? `This is SCHOOLWORK with a real énoncé above. At least 2 of your queries must be about the ` +
              `ACADEMIC TOPIC ITSELF — the notion, the method, how it's taught and tested at this level — ` +
              `not about the logistics of the task. Name the notion the way a teacher would ` +
              `("<notion> méthode", "<notion> programme lycée", "<chapitre> définitions cours", ` +
              `"<type d'exercice> méthode type"). NEVER plan a search for the ANSWER to this specific ` +
              `exercise (no "corrigé exercice 12 p.87", no solved version of their dissertation subject) — ` +
              `you are finding the method they will apply, never the result they hand in.\n`
            : "") +
          `Before researching, PLAN it. First extract the key entities (names, people, organizations, places, ` +
          `dates, subjects) from the task. Then list 3-6 concrete search actions to actually run — each one ` +
          `naming a SPECIFIC query, not a vague instruction. For a connected app, phrase it as "Search <app> for ` +
          `'<specific query>'" (e.g. "Search Gmail for 'Wharton Investment Competition'", not "check email"). ` +
          `For external facts, phrase it as "web_search: '<specific query>'" using an entity + qualifier (e.g. ` +
          `"web_search: 'Wharton Global Investment Competition 2026 rules deadline'"). Only include apps from ` +
          `CONNECTED APPS above.\n\nReturn ONLY this JSON: {"queries": ["...", "...", ...]}`,
      }],
    }));
    const out = firstJson<{ queries?: string[] }>(String(res.choices?.[0]?.message?.content || ""));
    return (out?.queries || []).map((q) => String(q || "").trim().slice(0, 160)).filter(Boolean).slice(0, 6);
  } catch { return []; } // planning failure just means the loop falls back to its own general algorithm
}

/**
 * Run a task as a bounded tool-using agent over the user's CONNECTED apps (Composio): it gathers facts and
 * does the reversible work (drafts, docs, tasks, updates) itself, then submits a context + synthesis + the
 * steps that are LEFT. Irreversible sends/deletes are never available to it. Also returns durable profile facts.
 */
export async function runTask(task: { title: string; why: string; source?: string; links?: TaskLink[]; artifacts?: { kind: string; id: string; url?: string; label?: string }[]; sourceDetail?: string; sourceSubject?: string; sourceDue?: string }, profile?: Profile, focus?: string, extras?: AgentTools, academic?: AcademicContext): Promise<RunOutput> {
  const profileUpdates: ProfileUpdate[] = [];
  // Plan-only mode: withhold every irreversible/other-people-facing write tool structurally, so the agent
  // physically cannot send/post/delete/schedule — same "deny by absence" pattern already used for irreversible
  // sends (see isGatedAction). It DOES still get two prep actions: creating a resource doc/sheet/slides, and
  // drafting (never sending) a Gmail email — see readOnlyPlusPrep.
  const scopedExtras = EXECUTION_ENABLED || !extras ? extras : readOnlyPlusPrep(extras);
  const tools = [...RUN_TOOLS, WEB_SEARCH_TOOL, CREATE_NOTE_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_QUIZ_TOOL, ...(scopedExtras?.tools?.length ? scopedExtras.tools : [])];
  const connectedLine = extras?.connected?.length
    ? `\nConnected apps you can use (${EXECUTION_ENABLED ? "read + reversible writes; never send/post/delete" : "read-only, plus creating a resource doc/sheet/slides or drafting a Gmail email — never sending"}): ${extras.connected.join(", ")}.\n`
    : `\nNo apps are connected yet — if you can't proceed without one, say so in the synthesis and put "Connect the app in Settings" as a step.\n`;
  const manualHint = task.source === "manual"
    ? `\nThe USER added this to-do themselves, typed as a rough note. Treat the title as their intent: use your ` +
      `tools (search their Gmail/Drive, etc.) and what you know about them to find the real, specific context ` +
      `behind it BEFORE acting. If the raw title is vague, sloppy, or could be tighter (e.g. "milk" → "Buy milk", ` +
      `"wharton comp" → "Prepare for the Wharton Investment Competition"), also set submit's "title" to a crisp, ` +
      `specific imperative (≤9 words, name the real subject you found) — omit it if the title is already fine.`
    : "";
  // Artifacts this task already produced on a previous run — the agent MUST reuse + UPDATE these, never make
  // a fresh copy (this is what stops "5 road-trip packing lists"). A deterministic anti-duplication signal.
  const hasArtifactIds = !!task.artifacts?.length; // real ids to check writes against (vs. legacy links-only)
  const priorArtifactIds = new Set((task.artifacts || []).map((a) => a.id));
  const priorArtifacts: { label?: string; url?: string; extra?: string }[] = hasArtifactIds
    ? task.artifacts!.map((a) => ({ label: a.label || a.kind, url: a.url, extra: `${a.kind} id ${a.id}` }))
    : (task.links || []).filter((l) => l?.url);
  const artifactsBlock = priorArtifacts.length
    ? `\nALREADY CREATED FOR THIS TASK (you made these on a prior run — OPEN and UPDATE the existing one; ` +
      `updates to THESE ids are permitted without approval. Do NOT create a new copy). For a Google Doc, ` +
      `prefer the MARKDOWN update tool (whole-document markdown text) over the raw index-based batch-update ` +
      `API — it needs no structural inspection, so update it directly instead of reading the doc's internal ` +
      `structure first:\n` +
      `${priorArtifacts.map((l) => `- ${l.label}${l.extra ? ` (${l.extra})` : ""}${l.url ? `: ${l.url}` : ""}`).join("\n")}\n`
    : "";
  // FIRST PASS: plan the research before doing it (see planResearch) — skipped for a focused single-step
  // re-run, which already knows exactly what it's doing and doesn't need a fresh research plan.
  const researchPlan = (!EXECUTION_ENABLED && !focus) ? await planResearch({ title: task.title, why: task.why, sourceSubject: task.sourceSubject, sourceDetail: task.sourceDetail }, extras?.connected || []) : [];
  const researchPlanBlock = researchPlan.length
    ? `\nRESEARCH PLAN — run these searches, in order, before writing "context":\n${researchPlan.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n(This plan is a starting point, not a ceiling — follow up on anything it turns up, per the GATHER CONTEXT algorithm below.)\n`
    : "";
  // assignmentBlock goes FIRST (before the ambient workload in academicBlock) so the model reads "this is
  // the exercise I am working on" before "this is everything else that is due".
  const head = nowBlock() + `TASK: ${task.title}\nWHY: ${task.why}\n` + assignmentBlock(task) + profileBlock(profile) + academicBlock(academic) + artifactsBlock + connectedLine + researchPlanBlock;
  const deadlineHint = deadlineBlock(`${task.title}\n${task.why}`);
  const messages: any[] = [{
    role: "user",
    content: !EXECUTION_ENABLED
      ? head + deadlineHint + manualHint + `\nGather what you need and record the key facts in submit's "context". You have NO write/create/draft tools this run — do not attempt to act. Break the work into a clear, ordered "steps" list (see PLAN-ONLY MODE above) so the user has an exact plan of what Otto will do once executed, then call submit.`
      : focus
      // Focused single-step run (the user hit "Auto-do" on one automatable step).
      ? head + deadlineHint + `\nDo ONLY this one step now: "${focus}". Actually DO it with your tools (draft/create/update) — don't describe it, DO it — then submit: synthesis = what you did; steps = [] unless something still genuinely needs the user.`
      : head + deadlineHint + manualHint + `\nGather what you need and record the key facts in submit's "context" (who sent what, what the ask/event/doc detail is). Then ACTUALLY DO the reversible work now with your tools (draft/create/update) — don't just plan it. Only once you've done everything you can, call submit; list as steps only what truly needs the user.`,
  }];

  const actualModel = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
  // Plan-only mode never spends rounds on writes (there are none), so its budget goes entirely to research —
  // give it a bit more room than execution mode to actually check every relevant connected app.
  const MAX = EXECUTION_ENABLED ? 8 : 10; // tight round budget: transcripts grow quadratically, so rounds are the real cost driver
  let tokIn = 0, tokOut = 0, tokCached = 0, rounds = 0;
  // Circuit breaker: round count alone doesn't bound cost — a pathological task (a huge thread, tool errors
  // burning rounds, retries) can cost 10-20× a normal run. Cap the TOTAL tokens a single run may spend; once
  // crossed, stop looping and let the rescue pass turn whatever was gathered into an honest result.
  const RUN_TOKEN_CEILING = 220_000;
  const overTokenCeiling = () => tokIn + tokOut > RUN_TOKEN_CEILING;
  // Has the agent performed ANY write/create yet? Drives the deterministic act-now enforcement below.
  const WRITE_NAME = /(CREATE|UPDATE|APPEND|PATCH|MODIFY|BATCH|DRAFT|INSERT|WRITE|REPLACE|QUICK_ADD|MOVE|COPY|ADD_)/i;
  // Verbs that claim PRODUCED work — used to catch a report that says it did something with no artifact/
  // write to back it up (the "it just says it did the research" failure). Kept in sync with the DOABLE
  // verb list in finalize(): if a phrasing counts as doable-therefore-enforce-it-now, a claim using that
  // same phrasing after the fact must also count as a claim needing proof.
  const CLAIM_VERBS = /\b(drafted|created|updated|filled|composed|wrote|added a|built|compiled|assembled|produced|generated|populated|put together|set up|organized|researched|gathered|collected|found (?:a|the|\d)|identified|prepared|summar(?:ized|y))\b/i;
  // A step that describes CONSTRUCTING a new document artifact (doc/sheet/deck) — used to catch a run that
  // left artifact creation as a step (incl. the "Approve creating a Google Doc" dodge) instead of doing it.
  // Matches build verbs + an artifact noun; deliberately excludes update/edit/revise (editing an existing
  // doc genuinely needs approval).
  const CREATE_ARTIFACT_STEP = /\b(creat\w*|build\w*|compil\w*|generat\w*|assembl\w*|put together)\b[^.]*\b(google\s+)?(docs?|documents?|sheets?|spreadsheets?|slides?|decks?|presentations?|trackers?|briefs?|notes?|checklists?|flashcards?|quiz(?:zes)?)\b/i;
  // "context" describing the REQUEST or the SEARCH PROCESS instead of what was actually found — e.g. "User
  // requested information about Gabrielle; performed searches across multiple Google services" or "Assistant
  // retrieved calendar event for essay writing, read emails about X, and searched for Y on Drive and Gmail
  // without success" (observed live, second variant). Technically non-empty (passes every other check),
  // completely useless to the user. Catches: narrating what the user asked for, narrating the act of
  // searching/checking/retrieving itself (in EITHER first- or third-person, "I searched" / "Assistant
  // retrieved"), and a search described as having failed with no follow-up fact stated.
  const META_NARRATION = /\b(user (requested|asked (for|about)|wants?)\b|(?:^|\. )(?:the )?assistant \w+ed\b|performed (a )?searches?\b|conduct(?:ed)? (a )?search(?:es)?\b|search(?:ed|ing)? (across|through|multiple|for)\b.{0,40}\bwithout (success|results?|luck)\b|checked (multiple|several|various)\b|looked (into|through) (multiple|several|various)\b|across multiple (google )?services\b|\bread emails? about\b|\bretrieved (?:the |a )?calendar event\b)/i;
  // MISSION INTEGRITY: catches a claim that Otto did the student's actual graded/learning work FOR them —
  // the one line the whole "companion, not do-it-all" mission is built around. Checked against synthesis/did
  // (the model's own narrative of what it produced), the same place every other claim-verification check in
  // this file looks — a false claim here is worse than a fabricated artifact claim, because a student could
  // actually act on it (hand in what Otto wrote) instead of just seeing a broken card.
  let wroteAny = false;
  // Real integration reads (Gmail/Calendar/Drive/Slack/… — NOT web_search, NOT submit/remember) actually
  // succeeded this run. Drives the plan-only "don't submit a shallow plan" enforcement below: a plan built
  // on zero reads of the user's connected apps is a guess, not research, no matter how confident it reads.
  let readCalls = 0;
  // A task genuinely doing open-ended research (web_search called at least once) is NOT "read-only drift"
  // even though it hasn't written anything yet — it needs a few rounds of searching BEFORE it has enough
  // to compile into a doc/reply. Exempts it from the early-bail below, which used to cut research tasks
  // off right when they were making real progress, producing the "just read stuff, gave up" failure.
  let searchedWeb = false;
  let finishBacks = 0; // times we've bounced a submit for leaving work undone / claiming a phantom artifact
  // Backstop for a drafted-but-unreported reply: the model sometimes drafts a real Gmail reply, says so in
  // synthesis, but forgets to populate the structured "sendables" entry — leaving no Send button for
  // something that genuinely exists. Track the last successful draft call so withTokens can patch it in.
  let lastGmailDraft: { to?: string; subject?: string; body?: string; draftId?: string } | undefined;
  // Doc/Sheet/Slide ids VERIFIED created this run (from real tool results, never the model's say-so) —
  // the only ids extractArtifacts() is allowed to treat as "Otto's own", see the guardrail comment below.
  const createdDocIds = new Set<string>();
  // Briefs created THIS run via CREATE_NOTE — a real tool call each, same "verified, not claimed" bar.
  const notesCreated: TaskNote[] = [];
  const flashcardsCreated: TaskFlashcards[] = [];
  const quizzesCreated: TaskQuiz[] = [];
  const audit: AuditEvent[] = [];
  const logAudit = (kind: AuditEvent["kind"], label: string) => audit.push({ at: new Date().toISOString(), kind, label });
  // Backstop for the same class of bug as lastGmailDraft, but for Docs/Sheets/Slides: the model creates a
  // real spreadsheet/doc, mentions it in a "did" bullet, but forgets to add a "links" entry — so the card
  // shows text describing an artifact with no way to actually open it. Tracks only the LAST one created;
  // good enough since a single research/tracking task typically produces one primary artifact.
  let lastCreatedDoc: { kind: "document" | "spreadsheets" | "presentation"; id: string; label?: string } | undefined;
  const withTokens = (o: RunOutput): RunOutput => {
    let sendables = o.sendables;
    // NOTE: does NOT require lastGmailDraft.to — a REPLY draft often has no explicit recipient argument
    // (Gmail infers it from the thread being replied to), so requiring one here used to mean a genuine
    // reply draft with an empty "to" silently got NO sendable at all: the did-bullet said "created a
    // draft reply to X" but no View-draft/Send button ever appeared. The confirm dialog already has a
    // "the recipient" fallback for a blank `to`, so it's safe to surface the draft either way.
    if (lastGmailDraft?.draftId && !sendables.some((s) => s.app === "gmail")) {
      sendables = [...sendables, {
        app: "gmail" as const, label: "Send reply", to: lastGmailDraft.to,
        subject: lastGmailDraft.subject, body: lastGmailDraft.body, draftId: lastGmailDraft.draftId,
      }].slice(0, 6);
    }
    // "did" backstop: the model sometimes omits the structured did[] field even after genuinely writing
    // something (submit still requires synthesis, which then carries the same information) — fall back to
    // the one-line synthesis rather than showing an empty "What Otto did" section for real work.
    const did = o.did.length || !wroteAny || !o.synthesis || o.synthesis === "Done." ? o.did : [o.synthesis];
    // Links backstop: if the last doc/sheet/slide it created isn't already linked, add it — a "did" bullet
    // describing an artifact with no way to open it is a broken card, the same failure class as a drafted
    // reply with no Send button (see lastGmailDraft above).
    let links = o.links;
    if (lastCreatedDoc && !links.some((l) => l.url.includes(lastCreatedDoc!.id))) {
      const kindName = lastCreatedDoc.kind === "spreadsheets" ? "Sheet" : lastCreatedDoc.kind === "presentation" ? "Slides" : "Doc";
      links = [...links, { label: lastCreatedDoc.label || `Open ${kindName}`, url: `https://docs.google.com/${lastCreatedDoc.kind}/d/${lastCreatedDoc.id}/edit` }].slice(0, 3);
    }
    // FINAL integrity pass — reconcile the narrative with the artifacts that actually survived (runs LAST,
    // after both backstops above have had their chance to re-attach a real draft/doc). A "Drafted a reply…"
    // claim with no sendable to show is a fabrication to the user, so it must not survive to the card.
    return reconcileArtifactClaims({ ...o, did, links, sendables, tokens: { in: tokIn, out: tokOut, cachedIn: tokCached }, createdDocIds: [...createdDocIds], notes: notesCreated.length ? notesCreated : undefined, flashcards: flashcardsCreated.length ? flashcardsCreated : undefined, quizzes: quizzesCreated.length ? quizzesCreated : undefined, audit: audit.length ? audit : undefined });
  };
  try {
  for (let i = 0; i < MAX; i++) {
    // Early-bail on read-only drift: after 5 full rounds (which include 3 write-enforcement nudges from
    // round 3) with ZERO writes and no submit, another round won't change the outcome — it's either a
    // nothing-to-do task or a stuck one. Stop here and let the rescue pass turn the gathered context into
    // an honest conclusion, instead of burning rounds 6-8 (the most expensive, since the transcript is
    // largest) to reach the same end. Focused single-step runs and revisions-with-artifacts are exempt:
    // a focus run does one specific thing, and a revision's non-write is caught by the fabricated-revision
    // gate. Observed live: a vacuous "follow up on sent email" task ran a full 8 rounds / 137k tokens only
    // to conclude nothing was needed — this caps that at ~5 rounds.
    // …but NOT if we've already bounced a submit this run (finishBacks): that means the model reached a
    // conclusion and is being pushed to actually DO the work (e.g. create the doc it tried to defer) — give
    // it the remaining rounds to comply instead of bailing it into the rescue with the work still undone.
    if (i >= 5 && !wroteAny && !focus && !hasArtifactIds && !searchedWeb && !finishBacks) break;
    // Circuit breaker: a run that has already burned the token ceiling stops here — another round only
    // deepens the overspend. The rescue pass below salvages whatever was gathered into an honest result.
    if (overTokenCeiling()) { console.warn(`${new Date().toISOString()} [ai] runTask hit token ceiling (${tokIn + tokOut}) — stopping at round ${i}`); break; }
    // Mid-loop nudge: if the agent has used many turns without calling submit, remind it to
    // actually WRITE the data (not just keep reading) and move toward finishing.
    // Write-aware enforcement: prompts alone don't stop read-forever drift (observed live: 8 rounds of
    // reads, zero artifacts, "create the doc" left as a step). Track whether ANY write/create tool has
    // actually run and escalate EVERY round from round 3 until one does.
    // Revisions start closer to done (the artifact + its id are already known) — enforce a round earlier.
    if (i >= (priorArtifacts.length ? 1 : 2) && !wroteAny && !focus) {
      // Artifact-aware: when this is a rerun/revision, the enforcement must point at UPDATING the existing
      // artifact, never suggest CREATE — naming a create tool here was observed live steering revisions
      // into making a SECOND copy instead of editing the one listed in "ALREADY CREATED FOR THIS TASK".
      const nudge = priorArtifacts.length
        ? `ENFORCEMENT (round ${i + 1}/${MAX}): you have written NOTHING yet. Your NEXT tool call MUST update ` +
          `the EXISTING artifact listed above under "ALREADY CREATED FOR THIS TASK" (its id is listed — use ` +
          `an UPDATE/PATCH/APPEND tool with that id) with the requested change. Do NOT create a new one. Do ` +
          `NOT make another read call.`
        : `ENFORCEMENT (round ${i + 1}/${MAX}): you have CREATED NOTHING yet — only reads. If this is academic prep or genuinely needs a document/draft, your NEXT tool call MUST be a create/write tool (CREATE_NOTE for a short brief, CREATE_FLASHCARDS for a drillable deck, GOOGLEDOCS_CREATE_DOCUMENT, GMAIL_CREATE_EMAIL_DRAFT, GOOGLESHEETS_UPDATE_VALUES, …) that produces the task's artifact with the content you already have. Do NOT make another read call. But if this is a logistics/admin task (booking, confirming, buying, scheduling) with nothing worth preserving beyond the steps list, do NOT force a note just to have one — call submit now with steps only.`;
      messages.push({ role: "user", content: nudge });
    }
    const client = deepseekClient();
    const lastRoundHint = i === MAX - 1 ? "You must call submit now with the final result. Do not answer with prose." : "";
    const base = trimOldToolResults(messages);
    const apiMessages = lastRoundHint ? [...base, { role: "user" as const, content: lastRoundHint }] : base;
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: actualModel,
      max_tokens: OUT.run,
      messages: [
        { role: "system", content: languageLine(profile) + trackLine(profile) + (EXECUTION_ENABLED ? RUN_SYSTEM : RUN_SYSTEM + PLAN_ONLY_OVERRIDE) },
        ...apiMessages,
      ],
      tools: tools.map((t: any) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }));
    rounds++; { const u = usageOf(res); tokIn += u.in; tokOut += u.out; tokCached += u.cachedIn; }
    const toolUses = res.choices[0]?.message?.tool_calls || [];
    if (!toolUses.length) {
      const textContent = res.choices[0]?.message?.content || "";
      const out = firstJson<RunOutput>(textContent);
      if (out) return withTokens(finalize(out, textContent, profileUpdates));
      if (i < MAX - 1) {
        if (textContent) messages.push({ role: "assistant", content: textContent });
        messages.push({ role: "user", content: "You still have not used any tools. Read the connected apps and do the work now. Do not answer with prose until you have actually acted." });
        continue;
      }
      break; // last round, no tools, no parseable JSON → fall through to the rescue + honest fallback (never throw)
    }
    messages.push({ role: "assistant", content: res.choices[0]?.message?.content || "", tool_calls: toolUses });
    let submitted: RunOutput | null = null;
    for (const tu of toolUses) {
      const input = parseToolArgs((tu as any).function?.arguments);
      let content = "ok";
      try {
        const toolName = (tu as any).function?.name;
        if (toolName === "remember") {
          const fact = String(input.fact || "").trim();
          const cat = ["name", "about", "preference", "person", "project", "course"].includes(input.category) ? input.category : "preference";
          if (fact) profileUpdates.push({ category: cat, fact });
          content = "saved";
        }
        else if (toolName === "submit") {
          const draft = finalize(input as RunOutput, "", profileUpdates);
          // Plan-only mode has its own lighter-weight enforcement (below) instead of the execute-now mode's
          // enforcement further down, which assumes full read/write access and would reject constantly here.
          if (!EXECUTION_ENABLED) {
            // Quality pushback, but NEVER at the cost of losing the run entirely: a rejection on the final
            // two rounds risks the model running out of rounds → the defeatist "Open and handle:" fallback,
            // which is strictly worse than an imperfect plan (observed live). So bounce only when there's
            // round budget left to actually act on the feedback. Kept deliberately SIMPLE — quality checks
            // only (did you research at all, are the steps real and on-topic), no quantity thresholds
            // (search counts, character minimums) that just make the model perform depth instead of having it.
            const roundsLeft = MAX - 1 - i;
            const canBounce = finishBacks < 2 && roundsLeft >= 2;
            const hasConnectedApps = !!extras?.connected?.length;
            if (DOES_STUDENT_WORK.test(`${draft.synthesis} ${(draft.did || []).join(" ")}`)) {
              // No finishBacks cap, no canBounce gate — this is THE mission invariant, not a style call.
              // Otto guides; it never claims to have done the student's actual graded/learning work FOR
              // them. Reject every time until the claim is gone, even on the last round (better an honest
              // "Open and handle:" fallback than a false claim a student could act on).
              logAudit("guardrail", "Bloqué : une réponse ressemblait à un travail fait à la place de l'élève — renvoyée pour reformulation.");
              content = "REJECTED: you claimed to have written/completed/solved the student's actual " +
                "assignment/essay/exam/problem set FOR them — Otto NEVER does that, no matter how confident " +
                "or well-researched. Rephrase: whatever you produced must be a GUIDE (outline, checklist, " +
                "study notes, compiled resources) that helps the student do the work themselves, and the " +
                "actual exercise stays a step for them — never something you report as already done.";
            } else if (hasConnectedApps && readCalls === 0 && canBounce) {
              finishBacks++;
              content = "REJECTED: you have NOT read any connected app yet — \"context\" would be a guess, not " +
                "research. Read whatever's relevant (the Gmail thread / Calendar event / Drive doc behind this, " +
                "or any other connected app that plausibly bears on it) before you submit. If you genuinely " +
                "checked and none apply, say so explicitly in \"context\" — but only after actually trying.";
            } else if (META_NARRATION.test(draft.context) && canBounce) {
              // Observed live: "context" describing the REQUEST or the SEARCH PROCESS instead of what was
              // actually found ("User requested information about Gabrielle; performed searches across
              // multiple Google services") — technically non-empty, completely worthless to the user. This
              // is the single biggest driver of INCONSISTENT quality across tasks: when research comes up
              // thin, the model defaults to narrating its own effort instead of either digging further or
              // admitting a SPECIFIC gap. Reject it every time — no finishBacks cap, this is a content-shape
              // defect, not a judgment call to relax under round pressure.
              content = "REJECTED: \"context\" describes the REQUEST or your SEARCH PROCESS, not what you " +
                "actually found — \"User requested X\" / \"performed searches across Y\" is worthless filler. " +
                "Replace it with the real substantive facts (names, dates, what a thread/doc/event actually " +
                "says) — dig further with another targeted search/read if you don't have enough yet. If you " +
                "genuinely found nothing after a real attempt, state the SPECIFIC gap (e.g. \"no upcoming " +
                "meetings with Gabrielle; her last email was 3 weeks ago about the budget\"), never a vague " +
                "description of the search itself.";
            } else if (!draft.steps.length && canBounce) {
              // Otto never actually executes (plan-only), so "steps" is the ONE thing every task must leave
              // the user. Zero steps reads as "did nothing useful" even when research happened, so never
              // accept an empty plan.
              finishBacks++;
              content = "REJECTED: \"steps\" is empty. Every task must leave the user at least one concrete " +
                "next action. An empty steps[] is never acceptable here.";
            } else if ((!stepsMatchTitle(task.title, draft.steps) || isFolderHousekeepingDrift(task.title, draft.steps)) && canBounce) {
              // Observed live: a task titled "Prepare for the Wharton Investment Competition" came back with
              // steps entirely about reorganizing Google Drive folders — the agent found a file with a
              // relevant-sounding name during research and fixated on organizing where it lives instead of
              // actually preparing for the task.
              finishBacks++;
              content = `REJECTED: your "steps" don't actually move "${task.title}" forward — they read like you ` +
                `found a file/folder during research and fixated on organizing it instead of using what's in it ` +
                `to prepare for the real task. Discard those steps and write ones that substantively address ` +
                `"${task.title}" itself.`;
            } else if (/\bfound\b[^.]{0,60}\b(documents?|emails?|files?|spreadsheets?)\b/i.test(`${draft.context} ${(draft.did || []).join(" ")}`) && !draft.links.length && canBounce) {
              // "I found the relevant documents and emails" with nothing in links is a report of work the
              // user can't act on — they have no way to open what was supposedly found.
              finishBacks++;
              content = "REJECTED: your \"context\"/\"did\" says you found specific documents/emails/files, but " +
                "\"links\" is empty — the user has no way to open what you claim to have found. Add their real " +
                "URLs (from the tool results you already have) to \"links\", or rephrase to not claim you found " +
                "named items you can't link to.";
            } else if (CLAIM_VERBS.test(`${draft.synthesis} ${(draft.did || []).join(" ")}`) && !wroteAny && !draft.links.length && !draft.sendables.length && canBounce) {
              // Claims to have created/drafted something, but no write tool actually succeeded this run and
              // there's no artifact/sendable to back it up — the same fabrication risk execution mode guards
              // against. Reject rather than let a claimed-but-nonexistent doc/draft reach the user.
              finishBacks++;
              content = "REJECTED: you claim to have created or drafted something, but no create/draft tool " +
                "call actually succeeded this run — there's no link or sendable to back that up. Either call the " +
                "real tool (GOOGLEDOCS_CREATE_DOCUMENT / GMAIL_CREATE_EMAIL_DRAFT / etc.) and include the result " +
                "in \"links\"/\"sendables\", or don't claim you created it.";
            } else {
              // A "did" bullet claiming creation is legitimate ONLY if a create/draft call actually succeeded
              // this run (wroteAny) or there's a real artifact/sendable to point at — otherwise it's dropped
              // rather than shown as unverified work. Genuine research-result bullets always pass through
              // (finalize() already strips investigative/dead-end "searched X, no results" noise separately).
              draft.did = (draft.did || []).filter((d) =>
                !CLAIM_VERBS.test(d) || /research|gather|found|identif/i.test(d) ||
                wroteAny || draft.links.length > 0 || draft.sendables.length > 0);
              // Dedicated second pass for the steps themselves — see writeStepsFromContext for why this is
              // a SEPARATE call instead of trusting the steps the research loop proposed inline. The original
              // draft.steps already passed the on-topic/drift checks above; the refined steps have NOT, so
              // re-validate them and fall back to the original (already-validated) steps if the refinement
              // pass itself drifted off-topic — never let a second-pass failure produce a WORSE result.
              const refined = await writeStepsFromContext(task, draft.context, draft.links, draft.steps, draft.did, profile);
              draft.steps = (stepsMatchTitle(task.title, refined) && !isFolderHousekeepingDrift(task.title, refined)) ? refined : draft.steps;
              submitted = draft; content = "submitted";
            }
          }
          else {
          // (a) A revision that never actually wrote anything is a FABRICATED success (observed live: agent
          //     spent its whole budget reading the doc, never called update, then claimed "Updated the doc").
          const fabricatedRevision = hasArtifactIds && !wroteAny;
          // (b) PREPARED WITHOUT AN ARTIFACT: claims to have drafted/created/updated something but produced
          //     no link/sendable AND no write ever succeeded this run — the "it just prepares stuff" failure.
          //     IMPORTANT: this check has NO finishBacks cap — a false artifact claim is NEVER accepted,
          //     no matter how many times the model has been rejected. A fabrication that persists twice is
          //     still a fabrication, and accepting it on the third try defeats the entire guardrail.
          const claimsArtifact = CLAIM_VERBS.test(`${draft.synthesis} ${(draft.did || []).join(" ")}`);
          const hasArtifact = draft.links.length > 0 || draft.sendables.length > 0 || wroteAny;
          // (c) FINISH, DON'T HAND BACK: an unblocked automatable step Otto could do itself must not survive
          //     into steps[] — Otto acts. (synthetic backstop / permission-gated / dependent / question steps
          //     are legitimately left for the user.)
          const leftUndone = draft.steps.find((s) => s.automatable && !s.synthetic && s.dependsOn === undefined && !s.needsPermission && !s.question);
          // (d) DEFERRED ARTIFACT CREATION: the task's deliverable is a doc/sheet/deck, but instead of CREATING
          //     it the model left a STEP to create it — often dodging the "do it yourself" rule by phrasing it
          //     as "Approve creating a new Google Doc" (a fake user-approval step). Creating a NEW artifact is
          //     an auto-allowed action that needs NO approval, so it must be done this run, never handed back.
          //     Only fires when nothing was actually created (no link, no write) — editing an EXISTING doc
          //     (update/edit/revise wording) is deliberately NOT matched, since that legitimately needs approval.
          const defersCreation = !draft.links.length && !wroteAny && !hasArtifactIds &&
            draft.steps.some((s) => !s.done && CREATE_ARTIFACT_STEP.test(s.text));
          if (fabricatedRevision) {
            content = "REJECTED: you're revising an artifact that already exists, but you have not made any " +
              "update/write tool call this run. Call the update tool on the id listed under 'ALREADY CREATED " +
              "FOR THIS TASK' now — THEN submit. Do not resubmit the same claim without writing first.";
          } else if (claimsArtifact && !hasArtifact) {
            // No finishBacks cap here — this is an integrity violation, not a style disagreement.
            finishBacks++;
            content = "REJECTED: your report claims you drafted/created/assembled/produced something, but NO " +
              "artifact (draft, doc, sheet, event) was actually produced — no write or create tool call " +
              "succeeded this run. This is a fabrication and will be rejected every time until you either: " +
              "(a) call the REAL tool (GMAIL_CREATE_EMAIL_DRAFT, GOOGLEDOCS_CREATE_DOCUMENT, etc.) and " +
              "include the result in \"links\"/\"sendables\", OR (b) report honestly what you found without " +
              "claiming work you didn't do. Do NOT resubmit the same claim.";
          } else if (leftUndone && finishBacks < 2) {
            finishBacks++;
            content = `REJECTED: "${leftUndone.text}" is something YOU can do with your tools — do it NOW, don't ` +
              `leave it for the user. steps[] must contain ONLY what genuinely needs the user (an approval, a ` +
              `decision, an answer only they have, or a login/payment/physical action). Act, then submit.`;
          } else if (defersCreation && finishBacks < 2) {
            finishBacks++;
            content = "REJECTED: the deliverable here is a document/brief/deck, and you left CREATING it as a " +
              "step instead of doing it. Creating it needs NO approval — it is YOUR job, not the user's (never " +
              "phrase it as 'approve creating a doc'). Call the create tool NOW — CREATE_NOTE for a short " +
              "brief, CREATE_FLASHCARDS for vocab/definitions/facts to drill, CREATE_QUIZ to check understanding, or GOOGLEDOCS_CREATE_DOCUMENT / " +
              "GOOGLESHEETS_CREATE_GOOGLE_SHEET1 / GOOGLESLIDES_CREATE_PRESENTATION for something long-form — " +
              "write the actual compiled content INTO it, add a links entry with its URL, THEN submit.";
          } else {
            // did[] must be backed by a real write: if nothing was written, drop bullets that claim creation.
            if (!wroteAny) draft.did = draft.did.filter((d) => !CLAIM_VERBS.test(d));
            submitted = draft; content = "submitted";
          }
          }
        }
        else if (toolName === "web_search") {
          searchedWeb = true; content = await runWebSearch(input);
          logAudit("tool", `Recherche web : "${String((input as any)?.query || "").slice(0, 140)}"`);
        }
        else if (toolName === "CREATE_NOTE") {
          const r = makeNote(input);
          if ("error" in r) content = r.error;
          else { notesCreated.push(r.note); wroteAny = true; content = JSON.stringify({ ok: true, id: r.note.id }); logAudit("artifact", `Fiche créée : « ${r.note.title} »`); }
        }
        else if (toolName === "CREATE_FLASHCARDS") {
          const r = makeDeck(input);
          if ("error" in r) content = r.error;
          else { flashcardsCreated.push(r.deck); wroteAny = true; content = JSON.stringify({ ok: true, id: r.deck.id, count: r.deck.cards.length }); logAudit("artifact", `Cartes créées : « ${r.deck.title} » (${r.deck.cards.length})`); }
        }
        else if (toolName === "CREATE_QUIZ") {
          const r = makeQuiz(input);
          if ("error" in r) content = r.error;
          else { quizzesCreated.push(r.quiz); wroteAny = true; content = JSON.stringify({ ok: true, id: r.quiz.id, count: r.quiz.questions.length }); logAudit("artifact", `Quiz créé : « ${r.quiz.title} » (${r.quiz.questions.length} questions)`); }
        }
        // No autonomous email tool exists — every send goes through the user's explicit "Yes, send" click
        // (see sendSendable in integrations.ts). If a stale/cached tool call still names this, fail safe.
        else if (toolName === "send_self_brief") { content = "Blocked: autonomous email is disabled — put this in synthesis/context instead."; }
        // A revision with existing artifacts blocks CREATE_* calls entirely — not just "discourages" them.
        // Observed live: after only counting ANY write as satisfying the "you must write" enforcement, the
        // agent found the update path hard and called CREATE again instead — same duplicate, different
        // gate. Block it before the tool runs, so a duplicate can't be created even by mistake.
        else if (hasArtifactIds && /CREATE/i.test(toolName) && !/CREATE.*(SUB.?ISSUE|COMMENT|LABEL|BRANCH)/i.test(toolName)) {
          content = "BLOCKED: this task already has an artifact (see 'ALREADY CREATED FOR THIS TASK') — creating a new one would duplicate it. Use the UPDATE tool on the EXISTING id instead.";
        }
        // Plan-only mode: even a hallucinated call to a write tool name (not offered in the schema, so
        // unlikely, but not impossible) is blocked here too — enforcement can't rely on the model just not
        // trying. Reads/searches still pass through below. TWO exceptions: creating a resource doc/sheet/
        // slides, or drafting (never sending) a Gmail email — plan-only's allowed writes (see
        // readOnlyPlusPrep) — fall through to the real call below instead of being blocked.
        else if (!EXECUTION_ENABLED && WRITE_NAME.test(String(toolName)) && !isPlanOnlyAllowedWrite(String(toolName))) {
          content = "BLOCKED: plan-only mode — no write/create/draft tool is available this run (except creating a NEW resource doc/sheet/slides, or drafting a Gmail email). Put this in \"steps\" instead.";
        }
        else {
          // A connected-integration tool (Gmail/Calendar/Slack/GitHub/…). Returns null if it isn't one.
          const r = extras ? await extras.call(toolName, input || {}) : null;
          content = r ?? `Unknown tool: ${toolName}`;
          if (r !== null && !/^ERROR|PERMISSION_REQUIRED/i.test(String(r))) readCalls++;
          // Count as satisfying "you must write" ONLY when it's a genuine update (references an existing
          // artifact id) OR there are no prior artifacts to conflict with (a create is legitimately new work).
          const isRealWrite = r !== null && WRITE_NAME.test(String(toolName)) && !/^ERROR|PERMISSION_REQUIRED/i.test(String(r));
          const argStr = JSON.stringify(input || {});
          const targetsExisting = [...priorArtifactIds].some((id) => id.length >= 8 && argStr.includes(id));
          if (isRealWrite && (!hasArtifactIds || targetsExisting)) wroteAny = true;
          if (isRealWrite && /GMAIL_(CREATE|UPDATE)_EMAIL_DRAFT/i.test(toolName)) {
            // Grab the DRAFT id specifically — not the message/thread id that also appears in the response.
            // Composio's GMAIL_CREATE_EMAIL_DRAFT returns the draft under an explicit draft-id key AND a
            // generic "id"; the generic one can be the nested message id. Gmail DRAFT ids are distinctive
            // (they start with "r", e.g. "r-4589..."), so we try, in order: an explicit draft-id key → an
            // id whose value looks like a draft id → the first id as a last resort. Getting this wrong means
            // the Send button points at a non-draft id and the send fails, so the ORDER matters.
            const rs = String(r);
            const idMatch =
              /"draft_?id"\s*:\s*"([\w-]{4,})"/i.exec(rs) ||
              /"id"\s*:\s*"(r-?[\w-]{6,})"/i.exec(rs) ||
              /"id"\s*:\s*"([\w-]{6,})"/i.exec(rs);
            if (idMatch) lastGmailDraft = { to: String(input?.recipient_email || input?.to || "").trim() || undefined, subject: input?.subject ? String(input.subject) : undefined, body: input?.body ? String(input.body) : undefined, draftId: idMatch[1] };
          }
          // GUARDRAIL — "Otto may only edit what Otto created": extractArtifacts() later grants the
          // no-approval-needed edit carve-out to whatever doc ids land in this set. The model's own
          // self-reported "links" are NOT proof of creation (nothing stops it claiming a doc it merely
          // read) — only a REAL successful CREATE call's response id counts. Verified here from the actual
          // tool result, never from the model's narration of what it did.
          if (isRealWrite && /^GOOGLE(DOCS|SHEETS|SLIDES)_CREATE/i.test(toolName)) {
            // Try multiple patterns for the ID - Composio responses vary in format
            const idMatch = /"(?:document|spreadsheet|presentation)?Id"\s*:\s*"([\w-]{15,})"/i.exec(String(r)) ||
                            /"id"\s*:\s*"([\w-]{15,})"/i.exec(String(r)) ||
                            /"spreadsheetId"\s*:\s*"([\w-]{15,})"/i.exec(String(r)) ||
                            /"documentId"\s*:\s*"([\w-]{15,})"/i.exec(String(r)) ||
                            /"presentationId"\s*:\s*"([\w-]{15,})"/i.exec(String(r));
            if (idMatch) {
              createdDocIds.add(idMatch[1]);
              const kind = /^GOOGLESHEETS_/i.test(toolName) ? "spreadsheets" : /^GOOGLESLIDES_/i.test(toolName) ? "presentation" : "document";
              const label = input?.title ? String(input.title).slice(0, 80) : undefined;
              lastCreatedDoc = { kind, id: idMatch[1], label };
            }
          }
        }
      } catch (e: any) { content = "ERROR: " + (e?.message || e); }
      // Capped at 6000 so full thread context / doc contents fit without being truncated.
      messages.push({ role: "tool", tool_call_id: (tu as any).id || `tool_${Date.now()}`, content: String(content).slice(0, 6000) });
    }
    if (submitted) return withTokens(submitted);
  }
  // Rescue path: if the model never called submit, ask it once (without tools) to produce a final JSON result.
  try {
    const client = deepseekClient();
    const transcript = messages.map((m) => {
      const role = String(m?.role || "assistant");
      const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return `${role.toUpperCase()}: ${content}`;
    }).join("\n\n").slice(-24000);
    const rescue: any = await client.chat.completions.create({
      model: actualModel,
      max_tokens: OUT.rescue,
      response_format: { type: "json_object" }, // FORCE parseable JSON — without this the rescue sometimes
      // returned prose, so finalize threw and the run fell to the defeatist fallback. JSON mode makes the
      // rescue reliably usable, so a run that gathered ANY context produces a real result.
      messages: [
        {
          role: "system",
          content:
            "You must output STRICT JSON only: {context:string,synthesis:string,did:array,steps:array,links:array,sendables:array}. " +
            "did = one short past-tense bullet per action ACTUALLY performed with tools (empty if none). " +
            "Report ONLY what the transcript shows was ACTUALLY DONE with tools. synthesis = one short past-tense " +
            "sentence of performed actions ('Created X', 'Drafted Y'); if nothing was created or written, say " +
            "plainly what was found and put ALL remaining work in steps (each {text, automatable}) — do NOT " +
            "describe the user or summarize their life. links = ONLY artifacts CREATED this run (URLs from " +
            "create-tool results in the transcript, each with a label saying what it IS); NEVER list pre-existing " +
            "files that were merely read. Fabricating a result is worse than admitting the run fell short.",
        },
        { role: "user", content: transcript },
      ],
    });
    const text = rescue.choices[0]?.message?.content || "";
    const out = firstJson<RunOutput>(text);
    if (out) return withTokens(finalize(out, text, profileUpdates));
  } catch {
    // fall through to the throw below
  }
  // No usable result even after the rescue pass. Do NOT throw: throwing sends the task back through the
  // job queue's retry (observed live: the SAME non-converging run replays 3× at 130–240k tokens each, then
  // fails terminally — a huge burn to keep re-discovering a vacuous task has nothing to do). A genuinely
  // transient tool/API error is already handled per-round above, so reaching here means the agent RAN but
  // couldn't converge on a concrete action. Return an HONEST result instead — no fabricated "executed"
  // claim, no artifact — so the task lands in a visible "needs you" state and the expensive loop stops.
  const sourceUrl = (task.links || []).find((l) => l?.url)?.url;
  return withTokens(finalize({
    synthesis: "This one needs your call — take it from here.",
    did: [],
    steps: [{ text: `Open and handle: ${task.title.slice(0, 70)}`, automatable: false, ...(sourceUrl ? { url: sourceUrl } : {}) }],
    links: [],
    sendables: [],
  }, "", profileUpdates));
  } finally {
    console.log(`${new Date().toISOString()} [ai] runTask "${task.title.slice(0, 50)}": ${rounds} rounds, ${tokIn} in / ${tokOut} out tokens`);
  }
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
async function writeStepsFromContext(
  task: { title: string; why: string },
  context: string,
  links: TaskLink[],
  fallbackSteps: TaskStep[],
  did: string[] = [],
  profile?: Profile,
): Promise<TaskStep[]> {
  const keywordHit = isBigIbProject(profile, task.title, task.why);
  // Normally: no distilled research context means nothing to refine, so bail to the loop's own steps.
  // But a big project (EE/TOK/CAS/IA/a full essay) doesn't need research context to know it needs a
  // milestone breakdown instead of a flat list — that structure comes from the project TYPE, not from
  // what was found online. Bailing here was the actual bug: "Start the Extended Essay" (a task with
  // nothing to research — the student just needs the plan) produced empty context, short-circuited
  // before this was even checked, and silently kept ordinary dependsOn-chained steps instead of ever
  // getting milestone dates. Only skip the call when there's neither context NOR an obvious keyword hit.
  if (!context.trim() && !keywordHit) return fallbackSteps;
  try {
    const client = deepseekClient();
    const linksBlock = links.length ? `\n\nRESOURCES ALREADY FOUND/CREATED:\n${links.map((l) => `- ${l.label}: ${l.url}`).join("\n")}` : "";
    const didBlock = did.length ? `\n\nWHAT WAS ALREADY DONE THIS RUN (do not re-list these as steps):\n${did.map((d) => `- ${d}`).join("\n")}` : "";
    // The keyword regex is only a FAST PRE-FILTER (catches "IA"/"EE"/"essay" etc. verbatim); it misses a
    // paraphrased title (refineManualTask can reword a raw "ia" into something that drops the literal
    // acronym) or a big project that's real but never named as one ("write my English coursework" is
    // just as multi-week as an EE). So don't hard-branch on the regex alone — hand the model BOTH shapes
    // and let it decide which this task actually is, with the regex hit only as a strong hint, not the
    // final word. This is a single unified call either way (never two round-trips).
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
      max_tokens: OUT.steps,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `TASK: "${task.title}"\nWHY: "${task.why}"\n\n${context.trim() ? `CONTEXT ALREADY RESEARCHED (do not research more, just use this):\n${context}` : "No research was needed for this one — plan it from the task itself."}${linksBlock}${didBlock}\n\n` +
          languageLine(profile) + trackLine(profile) + nowBlock() +
          `FIRST, decide: is this a BIG, multi-week/multi-stage project — a full essay, dissertation, thesis/` +
          `mémoire, an IB Extended Essay/TOK/CAS/Internal Assessment, a group project, a major report — where a ` +
          `flat "next 3 actions" list would bury the real timeline? Or an ordinary task that's actually doable ` +
          `in one sitting or a few short steps?` +
          (keywordHit ? ` (This one LOOKS like a big project from its title/why — confirm that reading unless the ` +
            `actual content clearly contradicts it.)` : "") + `\n\n` +
          `IF BIG: break it into an ORDERED list of MILESTONES from where it stands now through final submission ` +
          `(e.g. research question, source-gathering, outline, supervisor check-in, first draft, revision, final ` +
          `submission — adapt to what this specific project actually needs, don't force every category to apply). ` +
          `Each milestone needs a realistic "targetDate" (YYYY-MM-DD, relative to the CURRENT DATE above) spaced ` +
          `out over the weeks/months a project like this genuinely takes — don't cram them all into the next few ` +
          `days. 4 to 8 milestones, each text ≤10 words.\n\n` +
          `IF ORDINARY: break the remaining work into a clear, ORDERED list of concrete, actionable steps — each ` +
          `a SHORT one-liner (≤8 words: imperative verb + the specific thing, no hedging, no filler) naming a ` +
          `specific action (not a vague category like "look into options"), small enough that the list feels ` +
          `doable, not overwhelming. If a resource above was already CREATED (not just found), do NOT list ` +
          `"create X" as a step — that's done; instead say what to DO with it now (review it, send it, use it, ` +
          `decide something). Only list creating a document/draft as a step if none of the resources above cover ` +
          `it yet. Order them; set "dependsOn" to an earlier step's index (0-based, in THIS list) when one must ` +
          `happen first — e.g. an automatable step that's blocked until the user makes a call on an earlier one. ` +
          `1 to 6 steps, omit "dependsOn" when a step doesn't wait on another.\n\n` +
          `EITHER WAY, this is for a STUDENT: every step/milestone must be something THEY do — never phrase the ` +
          `graded/learning work itself (writing the essay, doing the research, forming the argument, solving the ` +
          `problem) as if it were already done or as Otto's job; that work always stays theirs. Every item must ` +
          `be directly about "${task.title}" — no unrelated tangents; the context above may mention OTHER people/` +
          `threads/obligations that came up during research but aren't actually part of this task — don't turn ` +
          `those into steps just because they're in the context.\n\n` +
          `Return ONLY this JSON: {"isBigProject": true|false, "steps": [{"text": "...", "targetDate": "YYYY-MM-DD" ` +
          `(big only), "automatable": false (ordinary only), "dependsOn": 0 (ordinary only)}, ...]}.`,
      }],
    }));
    const out = firstJson<{ isBigProject?: boolean; steps?: { text?: string; automatable?: boolean; targetDate?: string; dependsOn?: number }[] }>(String(res.choices?.[0]?.message?.content || ""));
    // The model's own judgment wins when it answers at all — it saw the actual content, the regex only
    // saw the title. Fall back to the keyword hit only if the response is malformed/missing the field.
    const bigProject = typeof out?.isBigProject === "boolean" ? out.isBigProject : keywordHit;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const rawSteps = out?.steps || [];
    const steps = rawSteps
      .map((s, idx) => ({
        text: String(s?.text || "").trim().slice(0, 180),
        automatable: bigProject ? false : !!s?.automatable,
        ...(bigProject && dateRe.test(String(s?.targetDate || "")) ? { targetDate: s!.targetDate } : {}),
        // Same validation as finalize()'s dependsOn handling — must point at a REAL other step in
        // THIS (possibly reordered/re-worded) list, never dropped silently as it was before this fix.
        ...(!bigProject && Number.isInteger(s?.dependsOn) && s!.dependsOn! >= 0 && s!.dependsOn! < rawSteps.length && s!.dependsOn !== idx
          ? { dependsOn: s!.dependsOn }
          : {}),
      }))
      .filter((s) => s.text)
      .slice(0, bigProject ? 8 : 6);
    return steps.length ? steps : fallbackSteps;
  } catch { return fallbackSteps; } // a failed refinement pass falls back to the loop's own steps, never blocks submission
}

/** Break ONE step down into its own small checklist — "Write the introduction" (a milestone inside a big
 *  project, but the same is useful for an ordinary step too) becomes 3-6 concrete sub-actions. On-demand
 *  only (a "Détailler cette étape" button), never generated automatically — most steps are fine as-is,
 *  and forcing every step through this would bury the plan in sub-lists nobody asked for. Persisted on
 *  the step itself by the caller (server/index.ts), not returned as throwaway chat text. */
export async function expandStep(task: { title: string; why: string }, step: { text: string }, profile?: Profile): Promise<{ text: string; done: boolean }[]> {
  try {
    const client = deepseekClient();
    const res: any = await retryRequest(() => client.chat.completions.create({
      model: DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL,
      max_tokens: OUT.steps,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `TASK: "${task.title}" (${task.why})\nSTEP TO BREAK DOWN: "${step.text}"\n\n` +
          languageLine(profile) +
          `Break this ONE step into 3 to 6 small, concrete sub-actions the student can tick off one at a time — ` +
          `each a SHORT imperative (≤10 words), specific enough to just start doing, no vague categories like ` +
          `"plan it out". This is for a STUDENT: every sub-step is something THEY do — never phrase the graded/` +
          `learning work itself (writing, arguing, solving) as if it were already done or as Otto's job. Stay ` +
          `strictly inside the scope of "${step.text}" — do not re-plan the whole task, only this one step.\n\n` +
          `Return ONLY this JSON: {"substeps": ["...", "...", ...]}.`,
      }],
    }));
    const out = firstJson<{ substeps?: string[] }>(String(res.choices?.[0]?.message?.content || ""));
    return (out?.substeps || [])
      .map((t) => String(t || "").trim().slice(0, 140))
      .filter(Boolean)
      .slice(0, 6)
      .map((text) => ({ text, done: false }));
  } catch { return []; }
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

export function finalize(out: any, fallbackText: string, profileUpdates: ProfileUpdate[]): RunOutput {
  const rawSteps = Array.isArray(out?.steps) ? out.steps : [];
  const steps: TaskStep[] = rawSteps
    .map((s: any, idx: number) => ({
      text: String(s?.text || "").trim().slice(0, 180), // keep steps to a scannable one-liner, not a paragraph
      automatable: !!s?.automatable,
      needsPermission: !!s?.needsPermission,
      // Valid only if it points at a REAL other step — a bad index (9 in a 3-step list, or itself)
      // would permanently block the step client-side.
      dependsOn: Number.isInteger(s?.dependsOn) && s.dependsOn >= 0 && s.dependsOn < rawSteps.length && s.dependsOn !== idx ? s.dependsOn : undefined,
      url: s?.url && /^https?:\/\//i.test(String(s.url)) ? String(s.url) : undefined,
      question: s?.question ? String(s.question).trim().slice(0, 200) : undefined,
      options: Array.isArray(s?.options) ? s.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 4) : undefined,
    }))
    .filter((s: TaskStep) => s.text)
    // Filter out illegitimate self-email steps ("Draft an email summary to the user", "Email yourself")
    .filter((s: TaskStep) => !/\b(draft|send|write|email)\b[^.]{0,30}\b(email|summary|update|findings)\b[^.]{0,30}\b(to (the )?user|to yourself|to me)\b/i.test(s.text))
    .slice(0, 6); // fewer, tighter steps — a short list reads better than an exhaustive one
  // Generic labels ("Open", "Link", a bare URL) tell the user nothing — name the artifact by its URL kind.
  const kindLabel = (url: string): string =>
    /docs\.google\.com\/document/i.test(url) ? "the Google Doc Otto created"
    : /docs\.google\.com\/spreadsheets/i.test(url) ? "the Google Sheet Otto created"
    : /docs\.google\.com\/presentation/i.test(url) ? "the slides Otto created"
    : /mail\.google\.com/i.test(url) ? "the email thread"
    : /calendar\.google\.com/i.test(url) ? "the calendar event"
    : "the linked page";
  const isJunkLabel = (s: string) => !s || /^(open|link|url|click here|view|here|document|doc)$/i.test(s.trim()) || /^https?:\/\//i.test(s.trim());
  const links: TaskLink[] = (Array.isArray(out?.links) ? out.links : [])
    .map((l: any) => {
      const url = String(l?.url || "").trim();
      const raw = String(l?.label || "").slice(0, 80);
      return { label: isJunkLabel(raw) ? kindLabel(url) : raw, url };
    })
    .filter((l: TaskLink) => /^https?:\/\//i.test(l.url))
    // Artifact verification: a Google Docs/Sheets/Slides link must carry a REAL document id (25+ chars of
    // id alphabet) — a made-up or truncated link would render a polished card pointing at a 404.
    .filter((l: TaskLink) => !/docs\.google\.com/i.test(l.url) || /\/(document|spreadsheets|presentation)\/(d\/)?[-\w]{25,}/i.test(l.url))
    // Never a "Gmail draft" link — Gmail has no URL for one specific draft, only the generic drafts
    // folder (mail.google.com/…/#drafts), which is useless/confusing next to the real "View draft"/Send
    // UI the sendables entry already gives. Belt-and-suspenders in case the model adds one out of habit.
    .filter((l: TaskLink) => !/mail\.google\.com.*#drafts/i.test(l.url))
    .slice(0, 3); // max 3 open links per task — the essentials, not a link dump
  const sendables: Sendable[] = (Array.isArray(out?.sendables) ? out.sendables : [])
    .map((s: any): Sendable => ({
      app: s?.app === "slack" ? "slack" : s?.app === "gcal" ? "gcal" : "gmail",
      label: String(s?.label || (s?.app === "slack" ? "Send message" : s?.app === "gcal" ? "Send invites" : "Send email")).slice(0, 80),
      to: s?.to ? String(s.to).slice(0, 160) : undefined,
      subject: s?.subject ? String(s.subject).slice(0, 300) : undefined,
      body: s?.body ? String(s.body).slice(0, 6000) : undefined,
      draftId: s?.draftId ? String(s.draftId).slice(0, 200) : undefined,
      channel: s?.channel ? String(s.channel).slice(0, 120) : undefined,
      text: s?.text ? String(s.text).slice(0, 4000) : undefined,
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
      (s.app === "slack" && !!s.channel && !!s.text) ||
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
  const DEAD_END = /\bno (results?|matches?|contacts?|entries|records|response|reply|emails?|luck|info(?:rmation)?)\b|\bnothing (?:found|available|to)\b|\bcouldn'?t\b|\bcould not\b|\bunable to\b|\bnot? found\b|\bno .{0,20}\bfound\b|\bfailed to\b|\bwithout success\b/i;
  // A fabricated placeholder recipient/fact ("name@example.com", "[email]") is worse than admitting the
  // contact is unknown — drop any bullet that leans on one, so a made-up address never reads as a real action.
  const PLACEHOLDER = /@example\.(?:com|org|net)\b|@(?:test|placeholder|domain|email)\.\w+|\[[^\]]*\b(?:email|address|name|phone|contact)\b[^\]]*\]|\bplaceholder\b/i;
  // "did" = things PRODUCED, not the looking that preceded them. A bullet that merely describes investigation
  // ("Searched Gmail for X", "Checked Contacts", "Looked through Drive", "Scrolled contacts") is a MEANS, not
  // a result — drop it. Real wins start with produce-verbs (drafted/created/wrote/updated/added/prepared/…).
  const INVESTIGATIVE = /^(searched|search|checked|check|looked|look|scrolled|scroll|browsed|scanned|scan|examined|inspected|explored|queried|tried to|attempted|reviewed|read|opened|combed|dug|hunted|retrieved|retrieve|fetched|fetch|pulled up|located|listed|list|viewed|view|got|fetching)\b/i;
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
  if (synthesis && !did.length && !links.length && !sendables.length && (DEAD_END.test(synthesis) || INVESTIGATIVE.test(synthesis))) synthesis = "";
  void fallbackText; // kept in the signature for call-site compatibility; intentionally unused as content
  // A completely empty result (no report, no steps, no artifacts) is a FAILED run, not a quiet success —
  // throwing routes it to the honest-failure path (task returns to ready + client auto-retries).
  if (!synthesis && !steps.length && !links.length && !sendables.length) {
    throw new Error("The run produced no output — it will retry.");
  }
  // Otto-work leak check (observed live: "Create a new Google Doc…" listed as a USER step): a step that
  // starts with a doable verb and carries no judgment for the user gets flipped to automatable — Auto-do
  // then executes it instead of dumping Otto's own work on the user.
  // "Research X and compile a list" / "Find options for Y" / "Look into Z" are exactly the open-ended
  // research Otto can do itself (web_search + a doc) — missing these verbs was letting the model dodge
  // the FINISH-DON'T-HAND-BACK enforcement below by phrasing real work as a step instead of doing it.
  const DOABLE = /^(create|draft|write|update|add|fill|schedule|search|compile|prepare|generate|make|research|find|look up|look into|gather|collect|identify|explore|investigate|list)\b/i;
  const JUDGMENT = /\b(choose|decide|pick|confirm|approve|review|prefer|want|which|verify|check with|sign|pay)\b/i;
  for (const s of steps) {
    if (!s.automatable && DOABLE.test(s.text) && !JUDGMENT.test(s.text) && !s.question) s.automatable = true;
  }
  // Never list DONE work as remaining: a step that near-duplicates a did-bullet is stale planning residue.
  const stale = (txt: string) => did.some((d) => {
    const a = new Set(txt.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const b = new Set(d.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const inter = [...a].filter((w) => b.has(w)).length;
    return a.size > 2 && inter / a.size >= 0.7;
  });
  const cleanedSteps = steps.filter((s) => !stale(s.text));
  steps.length = 0; steps.push(...cleanedSteps);
  // Checklist backstop: artifacts with NO steps and NO sendable leave the user without a "what's left"
  // list — the report the card promises. Deterministically add "Review <artifact>" so the checklist can
  // never be absent when something was produced. (Sendables don't need it: the send button IS the next action.)
  if (!steps.length && !sendables.length && links.length) {
    for (const l of links.slice(0, 2)) steps.push({ text: `Review ${l.label}`.slice(0, 80), automatable: false, url: l.url, synthetic: true });
  }
  // Follow-up tasks the run discovered — distinct new obligations that each deserve their own task. Capped
  // and validated; the run loop turns these into real tasks the sweep/kick then executes.
  const followUps = (Array.isArray(out?.follow_ups) ? out.follow_ups : Array.isArray(out?.followUps) ? out.followUps : [])
    .map((f: any) => ({ title: String(f?.title || "").trim().slice(0, 90), why: String(f?.why || "").trim().slice(0, 200) }))
    .filter((f: { title: string; why: string }) => f.title.length >= 4)
    .slice(0, 2);
  const title = out?.title ? String(out.title).trim().slice(0, 90) : undefined;
  return {
    context: brief(String(out?.context || ""), 2, 380),
    // Fallback only when there's genuinely nothing to say: "Done." if the run left no open steps, else a
    // neutral placeholder (never "Done." on a task that still needs the user — that would misread as finished).
    synthesis: synthesis || (!EXECUTION_ENABLED && steps.length ? "Gathered context and broke this into steps." : steps.some((s) => !s.done) ? "" : "Done."),
    did,
    steps,
    links,
    sendables,
    profileUpdates,
    ...(followUps.length ? { followUps } : {}),
    ...(title ? { title } : {}),
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }

// Otto's OWN narrative claiming it did the student's graded work — checked against `did`/`synthesis` in
// runTask (the model's report of what it produced). Both languages: languageLine makes those FRENCH by
// default (this app's default language), so an English-only guard would leave the actual default path
// unprotected. Exported for tests/run.mjs (pinning both the true-positive AND the false-positive that
// would break legitimate tutoring, e.g. "rédigé" appearing in "aide à rédiger ton plan").
export const DOES_STUDENT_WORK = /\b(wrote|completed|finished|did|solved|answered) (?:your |the |his |her |their )?(essay|assignment|homework|problem set|paper|report|exam|quiz|test|worksheet|questions?)\b|\bsolved (?:all |every )?(?:the )?(?:problems?|questions?)\b|\b(answers? (?:to|for) (?:the |your )?(?:exam|quiz|test|questions?))\b|\b(rédigé|terminé|fini|résolu|répondu)\s+(?:à |aux )?(?:ta |ton |tes |ses |sa |son |les? |la |l['’])?(dissertation|devoir|exercices?|contrôle|examen|quiz|questions?|rédaction)\b|\br(?:é|e)ponses? (?:au?|aux) (?:contrôle|examen|quiz|exercices?)\b/i;

// Same integrity line runTask() enforces on itself — a coaching reply must never cross into doing the
// student's actual work either (a student stuck on an essay could easily ask the chat to "just write the
// intro paragraph for me", which is exactly the failure mode this guards against).
// Both languages — the app defaults to FRENCH, so an English-only guard left the actual default path
// unprotected ("Voici l'introduction :" would have sailed straight through).
export const CHAT_DOES_WORK = /\bhere('s| is)?\s+(the|your|an?)\s+(essay|paragraph|answer|solution|response)\b|\bwrote (?:it|the|your) (essay|paragraph|answer|solution)\b|\bvoici\s+(?:donc\s+)?(?:l['’]|la |le |ta |ton |une |un )?(introduction|conclusion|dissertation|paragraphe|réponse|solution|corrigé|traduction|rédaction)\b|\bje (?:l['’]ai|t['’]ai) (?:rédigé|écrit)\b/i;

/** What `chatAboutTask` returns: the spoken reply, plus any artifacts the tutor made this turn (empty
 *  arrays, never undefined — the route accumulates these straight onto the task). */
export interface ChatResult {
  reply: string;
  notes: TaskNote[];
  flashcards: TaskFlashcards[];
  quizzes: TaskQuiz[];
  audit: AuditEvent[];
  tokens: { in: number; out: number; cachedIn?: number };
}

// The tutor's own tool loop is bounded much tighter than runTask's: a chat turn is "maybe look something
// up, maybe make ONE thing, then talk" — never a research pass. Also caps how many artifacts one message
// can produce (a wall of chips defeats the point of a CONVERSATION) and a small total-token ceiling so a
// pathological turn can't cost like a small run.
const CHAT_MAX_ROUNDS = 3;
const CHAT_MAX_ARTIFACTS = 2;
const CHAT_TOKEN_CEILING = 40_000;

/**
 * Reply in a per-task coaching thread. Grounded in that ONE task's own context/steps/why so the student
 * never has to re-explain their situation, and scoped to being a supportive guide — never a ghostwriter.
 * Tool-capable (web_search + the three CREATE_* artifact tools, bounded) so the tutor can look something up
 * or hand over a deck/quiz/fiche mid-conversation instead of only ever talking — but NEVER Composio: chat
 * must not be able to touch the student's connected accounts.
 */
export async function chatAboutTask(
  task: { title: string; why: string; context?: string; steps?: { text: string; done?: boolean }[]; sourceDetail?: string; sourceSubject?: string; sourceDue?: string },
  history: { role: "user" | "assistant"; text: string }[],
  message: string,
  profile?: Profile,
  academic?: AcademicContext,
  opts?: { stepIndex?: number },
): Promise<ChatResult> {
  const steps = task.steps || [];
  const stepsBlock = steps.length
    ? `\nSteps (${steps.filter((s) => s.done).length}/${steps.length} done):\n` +
      steps.map((s, i) => `- [${s.done ? "x" : " "}] ${s.text}${opts?.stepIndex === i ? "  ← THEY TAPPED \"HELP\" ON THIS ONE" : ""}`).join("\n")
    : "";
  const stepHint = (opts?.stepIndex != null && steps[opts.stepIndex])
    ? `\nThey just asked for help specifically on "${steps[opts.stepIndex].text}" (marked above) — start FROM THERE, don't re-open the whole task or restate the step back at them. Still diagnose before explaining (rule 1).\n`
    : "";
  const fr = profile?.language !== "en";
  const sys = languageLine(profile) + trackLine(profile) + MISSION +
    `\n\nYou are Otto, tutoring this student one-to-one about ONE specific task. Think of yourself as the ` +
    `good tutor they can't afford to hire: patient, genuinely curious about how THEY think, and interested ` +
    `in them actually understanding the material — not in getting the assignment off their plate. Ground ` +
    `every reply in the task context below; never make them re-explain what's already here.\n\n` +

    `HOW A GOOD TUTOR ACTUALLY WORKS — follow this, it's the whole point of this feature:\n` +
    `1. DIAGNOSE BEFORE EXPLAINING. When they say "I don't get it" or "I'm stuck", your FIRST move is to find ` +
    `out where exactly it breaks down — ask them to show you their attempt, or what they think the question ` +
    `is asking, or which specific line/step loses them. A tutor who lectures before diagnosing is just a ` +
    `textbook. One focused diagnostic question beats three paragraphs of explanation they didn't need.\n` +
    `2. TEACH THE IDEA, NOT THE INSTANCE. Once you know where they're stuck, explain the underlying concept or ` +
    `method in plain language, then let THEM apply it to their actual question. If a worked example genuinely ` +
    `helps, work a PARALLEL one — same method, different numbers/text/topic — never their assigned problem.\n` +
    `3. HAND BACK THE THINKING. Prefer a question that makes them take the next step ("what happens if you ` +
    `substitute that back in?", "which of the two readings does your evidence actually support?") over ` +
    `stating the step yourself. Leave the last inferential step to them wherever it's reachable.\n` +
    `4. CHECK IT LANDED. After explaining something non-trivial, ask them to say it back in their own words, ` +
    `or try the next bit themselves. Don't just move on assuming it worked.\n` +
    `5. BUILD ON WHAT THEY KNOW. Connect to something in their context — an earlier step they already ` +
    `finished, a subject they're stronger in, the class material referenced in the task.\n` +
    `6. BE HONEST ABOUT UNCERTAINTY. If the task context doesn't contain what's needed to answer well, say so ` +
    `and tell them where to look (their cours, the énoncé, the teacher) rather than inventing plausible ` +
    `subject content. A confident wrong explanation is far worse than "I don't have that here."\n\n` +

    `THE LINE YOU NEVER CROSS — this is what makes Otto different from asking a chatbot to do it:\n` +
    `Never produce the graded work itself. No essay/dissertation paragraphs (not even "just the intro"), no ` +
    `solved exercises with the final answer, no completed proofs, no filled-in commentaire, no translated ` +
    `passage they were assigned to translate, no code for a graded assignment. Outlines, sentence STARTERS ` +
    `they finish, "here's how to structure this", method walkthroughs on parallel examples, and checking ` +
    `reasoning they've already done are all fine and encouraged. If they push ("just write it", "just give me ` +
    `the answer", "I'm out of time"), be kind and firm and get them moving instead — the smallest concrete ` +
    `action that unblocks them (open the cours to p.X, write one bad first sentence, set a 10-minute timer, ` +
    `do just part a). Never lecture them about integrity; just redirect and help.\n\n` +

    `THINGS YOU CAN MAKE, RIGHT HERE IN THE CHAT: a fiche (CREATE_NOTE), a flashcard deck, or a quick MCQ ` +
    `quiz — and you can web_search first if you need real subject content to make it specific. Make one when ` +
    `it genuinely helps THEM practise: they ask for cards/a quiz/a summary, or you can see they need to drill ` +
    `something before Friday. Same line as everywhere else: a fiche is method, structure, prompts and real ` +
    `course content — NEVER their essay, their solved exercise, or their translated passage. A quiz is NEW ` +
    `questions on the notion, never their own exercise reformatted into multiple choice. Don't announce it ` +
    `before you make it and don't describe it at length after — make it, then say ONE short line ("je t'ai ` +
    `fait 10 cartes sur les dérivées"). Default is still: no artifact, most turns are just talking. You get ` +
    `at most ${CHAT_MAX_ARTIFACTS} per message — pick the ONE thing that actually helps right now.\n\n` +

    `HOW YOU SOUND — this matters as much as what you say:\n` +
    `Write like a real person talking to them, not like an app — and test every reply against this: could you ` +
    `say it out loud, as-is, and have it sound like a person talking? If it needs to be READ to make sense ` +
    `(a bullet list, a bolded label, anything you'd only write, never say), rewrite it as something you'd ` +
    `actually say. This is a CHAT: short lines, contractions, plain words. Plain prose is the default and ` +
    `almost always right. You may use **bold** for a single key term and a link as [texte](url); reach for a ` +
    `dash list only when you're genuinely listing 2-4 parallel things AND prose would be more awkward, not ` +
    `less. Never a header, never a bold "Label:" in front of every line, never a numbered framework, never a ` +
    `list where a sentence would do. If more than a third of your reply is formatting, you're writing a ` +
    `document instead of talking. Default to ONE short sentence — think of it as a text message back, not an ` +
    `answer. Two is already a longer reply than most turns need. Three or four is the ceiling, and that's for ` +
    `walking through a method, not for a normal exchange.\n` +
    `Say the thing, then stop. Don't restate their question back, don't preamble ("Great question!", "I can ` +
    `definitely help with that!"), don't recap what you just said, don't close every message with an offer of ` +
    `more help. No fake enthusiasm and no therapy-speak — they're stressed, not fragile, and they can tell ` +
    `when they're being managed. Dry warmth beats cheerleading.\n` +
    `Ask ONE question at a time, never a list of them. Go longer only to walk through a method or a parallel ` +
    `worked example — and even then keep it plain prose, in small steps, pausing to check they're with you.` +
    `\n\nTASK: ${task.title}\nWHY IT MATTERS: ${task.why}${task.context ? `\nCONTEXT: ${task.context}` : ""}${stepsBlock}${stepHint}` +
    assignmentBlock(task) + profileBlock(profile) + academicBlock(academic);
  const messages: any[] = [
    { role: "system", content: sys },
    ...history.slice(-16).map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: message },
  ];
  const client = deepseekClient();
  const actualModel = DEEPSEEK_MODEL === "deepseek-v4-pro" ? "deepseek-v4-flash" : DEEPSEEK_MODEL;
  const tools = [CREATE_NOTE_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_QUIZ_TOOL, WEB_SEARCH_TOOL];
  const empty = (): ChatResult => ({ reply: "", notes: [], flashcards: [], quizzes: [], audit: [], tokens: { in: 0, out: 0, cachedIn: 0 } });
  const result = empty();
  const logAudit = (kind: AuditEvent["kind"], label: string) => result.audit.push({ at: new Date().toISOString(), kind, label });
  const finish = (reply: string): ChatResult => {
    // The redirect line replaces a violating REPLY, but if that same turn also produced artifacts, they were
    // almost certainly the same violation wearing a different container (a "fiche" that's just the essay) —
    // discard them too rather than hand over a chip whose text just got rejected.
    if (CHAT_DOES_WORK.test(reply)) {
      result.notes = []; result.flashcards = []; result.quizzes = [];
      logAudit("guardrail", "Bloqué : une réponse dans le chat ressemblait à un travail fait à la place de l'élève — remplacée.");
      reply = fr
        ? "Je peux t'aider à débloquer ça, mais je ne vais pas le rédiger à ta place — cette partie est la tienne. On cherche un point de départ ensemble ?"
        : "I can help you get unstuck on this, but I won't write it for you — that part's yours. Want help finding a starting point instead?";
    }
    // 2400 (was 1200): a genuine tutoring turn — a method walked through step by step, or a parallel worked
    // example — legitimately runs longer than a one-line nudge, and truncating mid-explanation is worse than
    // no explanation. The prompt still pushes hard for SHORT by default; this only stops the rare long-but-
    // warranted reply from being cut off mid-sentence.
    result.reply = reply.trim().slice(0, 2400) || (fr ? "Je suis là — qu'est-ce qui te bloque exactement ?" : "I'm here — what part of this is giving you trouble?");
    return result;
  };

  for (let round = 0; round < CHAT_MAX_ROUNDS; round++) {
    if (result.tokens.in + result.tokens.out > CHAT_TOKEN_CEILING) break; // circuit breaker — see CHAT_TOKEN_CEILING
    const lastRound = round === CHAT_MAX_ROUNDS - 1;
    const apiMessages = lastRound
      ? [...messages, { role: "user" as const, content: "Out of tool calls for this turn — reply in plain words now, no more tool use." }]
      : messages;
    let res: any;
    try {
      res = await retryRequest(() => client.chat.completions.create({
        model: actualModel, max_tokens: OUT.chat, temperature: 0.6,
        messages: apiMessages,
        // The chat tool set is deliberately in-app only (CREATE_*/web_search) — NEVER Composio. A tutoring
        // chat must not be able to touch the student's connected accounts, unlike runTask's tool set.
        ...(lastRound ? {} : { tools: tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })) }),
      }));
    } catch { return finish(""); } // network/API failure → the honest fallback line, never a throw to the route
    { const u = usageOf(res); result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn = (result.tokens.cachedIn || 0) + u.cachedIn; }
    const toolCalls = res.choices?.[0]?.message?.tool_calls || [];
    const textContent = res.choices?.[0]?.message?.content || "";
    if (!toolCalls.length) return finish(textContent);
    messages.push({ role: "assistant", content: textContent, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const input = parseToolArgs(tc.function?.arguments);
      let content: string;
      const madeEnough = result.notes.length + result.flashcards.length + result.quizzes.length >= CHAT_MAX_ARTIFACTS;
      if (name === "web_search") {
        content = await runWebSearch(input);
        logAudit("tool", `Recherche web : "${String((input as any)?.query || "").slice(0, 140)}"`);
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
            logAudit("guardrail", "Bloqué : une fiche créée en chat ressemblait à un travail fait à la place de l'élève.");
          }
          else { result.notes.push(r.note); content = JSON.stringify({ ok: true, id: r.note.id }); logAudit("artifact", `Fiche créée : « ${r.note.title} »`); }
        }
      } else if (name === "CREATE_FLASHCARDS") {
        if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
        else { const r = makeDeck(input); if ("error" in r) content = r.error; else { result.flashcards.push(r.deck); content = JSON.stringify({ ok: true, id: r.deck.id, count: r.deck.cards.length }); logAudit("artifact", `Cartes créées : « ${r.deck.title} » (${r.deck.cards.length})`); } }
      } else if (name === "CREATE_QUIZ") {
        if (madeEnough) content = "LIMIT: you've already made enough this message — talk to them about what you made instead of making more.";
        else { const r = makeQuiz(input); if ("error" in r) content = r.error; else { result.quizzes.push(r.quiz); content = JSON.stringify({ ok: true, id: r.quiz.id, count: r.quiz.questions.length }); logAudit("artifact", `Quiz créé : « ${r.quiz.title} » (${r.quiz.questions.length} questions)`); } }
      } else content = "ERROR: unknown tool.";
      messages.push({ role: "tool", tool_call_id: tc.id || `tool_${Date.now()}`, content: String(content).slice(0, 2000) });
    }
  }
  return finish(""); // exhausted CHAT_MAX_ROUNDS still calling tools — the honest fallback line, not silence
}
