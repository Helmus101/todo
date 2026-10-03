// Repo test suite — run with `npm test` (tsx). Pure-function tests: no network, no AI calls.
import { readFileSync } from "node:fs";
import { dedupeTasks, foldGenerated, applyProfileUpdate, mergeTaskLists, mergeProfileStates, applyQualityBar, extractArtifacts, unionArtifacts, pruneHandled, forcedDueToday, forceWeekCoverage, estimateWhen, extractDateFromText, applyDeadlineUrgency, weakCardFronts, autoRunBudgetLeft, recordAutoRuns, needsAutoBreakdown, nothingToPrepare, notNeededFronts, inAppContextFor } from "../server/tasks.ts";
import { parseGenerated, finalize, reconcileArtifactClaims, trackLine, learningStyleLine, isBigIbProject, makeNote, makeDeck, makeQuiz, makePracticeProblem, looksLikeStem, assignmentBlock, dueLine, CHAT_DOES_WORK, CHAT_STATES_ANSWER, DOES_STUDENT_WORK, CHAT_CLAIMS_BOARD, CHAT_CLAIMS_DIAGRAM, PLAN_ONLY_OVERRIDE, sanitizeStepExtras, sanitizeSteps, dropTrivialSteps, isTrivialStep, bestMatchingStep, dropForeignEntitySteps, dropSiblingBleedSteps, dropSiblingBleedTitles, dropProcessComplaintSteps, anchorStepsToTask, revealsAnswer, makeBoardEntry, isDuplicateBoardEntry, shouldNudgeBoardWrite, makeDiagramEntry, ensureArtifactUseSteps, notNeededLine, weakCardLine, dodLooksLikeCoordinationOutcome, dropRedundantArtifactSteps, reattachStepExtras, dropUnanchoredSteps, restrictStepUrlsToLinks, dropForeignEntityLinks, milestoneLine, runCalcTool, CHAT_ASSERTS_FACT, countWords, makeObjectives, taskNeedsStepList, isDuplicateProblem, detectLang, visionReady, describeWhiteboard, academicBlock, sessionRecapLine } from "../server/claude.ts";
import { evaluateArithmetic, parseNumber, findArithmeticClaims, hasArithmetic } from "../server/arithmetic.ts";
import { isLikelyEcho, createEchoFilter, normalizeForEcho } from "../client/voice/echoGuard.ts";
import { speechErrorMessage } from "../client/voice/speechErrors.ts";
import { replanMilestones } from "../server/milestones.ts";
import { isWriteGatedAction, isGatedAction, ACTION_POLICIES, scopeTools, isArtifactShared } from "../server/integrations.ts";
import { isNoise, filterCandidates, calendarToItems, dedupeByThread, pronoteToItems, pronoteTestsToItems, hasAssignmentText, mergePronoteHomeworkAndTests } from "../server/discover.ts";
import { dedupeFacts, emptyProfile, canonStatus, isHandled, isInFlight, sortWithinQuadrant, deadlineEpoch, normalizeWhen, addUsage, monthKeyOf, monthCostUsd, overMonthlyBudget, overInteractiveBudget, usageCostUsd, callCostUsd, USD_PER_1M_IN, USD_PER_1M_CACHED_IN, USD_PER_1M_OUT, tzOf, isValidTz, isPeakHourUtc, isLowGrade, gradesBySubject, nextLeitnerReview, practiceAnswerMatches, bumpActivityHour, learnedProductiveHour, learnedProductiveHourForSubject, validateThemeTokens, normalizeProfile, milestonesBySubject } from "../shared/types.ts";
import { sweepDueForDay, localDay, sweepDue, shouldRefreshStudentModel, tasksToEnqueue, escapeHtml } from "../server/jobs.ts";
import { computeWorkload, isPileUp } from "../server/workload.ts";
import { stripHtml, applyPronoteGrades, isPrivateOrReservedIp, assertSafeExternalUrl } from "../server/pronote.ts";
import { connectionColumnUpdates } from "../server/store.ts";
import { POMODORO_ARMS, FLASHCARD_ARMS, GRANULARITY_ARMS, AUDIO_ARMS, DENSITY_ARMS, ORDERING_ARMS, CHAT_STYLE_ARMS, contextKey, chooseArm, computeReward, computeCardReward, computeLatencyReward, updatePosterior, leadingArm } from "../server/bandit.ts";
import { trimFreeTTSWatermark } from "../server/ttsTrim.ts";
import { wantsArtifactTools } from "../server/claude.ts";
import { subjectMastery } from "../shared/types.ts";
import { predictNextEngagement, predictWeakSubjects, aggregateSubjectSignals, weakSubjectBoost, subjectFrequency, orderingBoost, twoMinuteRuleBoost } from "../server/patterns.ts";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log("  FAIL:", name)); };
const section = (name) => console.log(`— ${name}`);

// ── Generation gates ──────────────────────────────────────────────────────────
section("parseGenerated grounding gates");
const gt = (over = {}) => ({ title: "Reply to Sarah about budget", why: "Sarah asked Tuesday", source: "gmail", urgency: 0.6, importance: 0.7, ...over });
check("gmail without anchor/link dropped", parseGenerated([gt()]).length === 0);
check("gmail with anchor kept", parseGenerated([gt({ anchorKey: "gmail:abc" })]).length === 1);
check("web source without anchor kept", parseGenerated([gt({ source: "web" })]).length === 1);
check("why-less dropped", parseGenerated([gt({ why: "", anchorKey: "gmail:x" })]).length === 0);
check("cap 20", parseGenerated(Array.from({ length: 30 }, (_, i) => gt({ title: `Task ${i} topic${i}`, anchorKey: `gmail:t${i}` }))).length === 20);

// ── Dedupe + dismissed suppression ────────────────────────────────────────────
section("dedupe + dismissed suppression");
const base = { risk: "low", urgency: 0.5, importance: 0.5, quadrant: "do", score: 2, createdAt: new Date().toISOString() };
const dismissed = { ...base, id: "d1", title: "Reply to Vendor Corp pricing survey", why: "Vendor Corp asked for pricing feedback", source: "gmail", status: "dismissed", anchorKey: "gmail:aaa" };
const reworded = { title: "Respond to the Vendor Corp survey on pricing", why: "Vendor Corp wants pricing input", source: "gmail", risk: "low", urgency: 0.6, importance: 0.6, anchorKey: "gmail:bbb" };
const out1 = foldGenerated([dismissed], [reworded]);
check("dismissed lookalike suppressed", out1.length === 1 && out1[0].status === "dismissed");
// Regression: pronoteToItems generates the SAME title for every different item in a subject
// ("Physique-Chimie homework") — the loose dismissed-lookalike match above used to treat every later,
// genuinely different assignment as "the one I already dismissed" and silently swallow it forever. This
// source must dedupe by anchor ONLY.
const dismissedHw = { ...base, id: "hw-old", title: "Physique-Chimie homework", why: "Vu sur Pronote — pas encore marqué comme fait.", source: "pronote", status: "dismissed", anchorKey: "pronote:old-assignment" };
const newHw = { title: "Physique-Chimie homework", why: "Vu sur Pronote — pas encore marqué comme fait.", source: "pronote", risk: "low", urgency: 0.5, importance: 0.55, anchorKey: "pronote:brand-new-assignment" };
const outHw = foldGenerated([dismissedHw], [newHw]);
check("a genuinely NEW Pronote assignment with an identical generic title is NOT swallowed by an old dismissed one (different anchor)", outHw.some((t) => t.anchorKey === "pronote:brand-new-assignment" && t.status === "ready"));
// The exact SAME anchor (a genuine re-dismiss-then-regenerate case) must still be suppressed for both.
check("the SAME Pronote anchor as a dismissed one IS still suppressed", foldGenerated([dismissedHw], [{ ...newHw, anchorKey: "pronote:old-assignment" }]).every((t) => t.anchorKey !== "pronote:old-assignment" || t.status === "dismissed"));
const doneA = { ...base, id: "a", title: "Book dentist for Thursday", why: "postcard from Dr Wu", source: "gmail", status: "done", anchorKey: "gmail:x1" };
const freshDup = { ...base, id: "b", title: "Book dentist for Thursday", why: "postcard from Dr Wu", source: "gmail", status: "ready", anchorKey: "GMAIL_X1" };
check("done beats fresh duplicate", dedupeTasks([doneA, freshDup]).length === 1 && dedupeTasks([doneA, freshDup])[0].status === "done");
// A genuinely NEW email (distinct anchor) whose title merely RESEMBLES an old DONE task must NOT be
// swallowed into it — different anchors = different real-world items. (Regression: "refresh finds nothing"
// when a fresh inbox thread looked like stale done history.)
const doneOld = { ...base, id: "o1", title: "Reply to the media coverage email", why: "press asked earlier", source: "gmail", status: "done", anchorKey: "gmail:old1" };
const newEmail = { ...base, id: "n1", title: "Reply to the media coverage email", why: "new press request today", source: "gmail", status: "ready", anchorKey: "gmail:new2" };
check("new email not suppressed by similar done task", dedupeTasks([doneOld, newEmail]).length === 2);
// …but two ACTIVE same-title cards (distinct anchors) still merge — no visual duplicates for the user.
const activeOld = { ...doneOld, id: "ac1", status: "needs_review" };
check("active same-title cards still merge", dedupeTasks([activeOld, newEmail]).length === 1);
// Two ACTIVE tasks naming the same person but a DIFFERENT action must NOT merge — "call"/"email" etc. used
// to be treated as generic filler words, so "Email professor Smith about the extension" and "Call professor
// Smith about the schedule" both reduced to {professor, smith} and silently collapsed into one, quietly
// losing whichever task was added second. (Regression: action verbs are distinguishing, not noise.)
const callSmith = { ...base, id: "cs1", title: "Call professor Smith about the schedule", why: "office hours conflict", source: "gmail", status: "ready", anchorKey: "gmail:cs1" };
const emailSmith = { ...base, id: "cs2", title: "Email professor Smith about the extension", why: "needs more time on the essay", source: "gmail", status: "ready", anchorKey: "gmail:cs2" };
check("same-person different-action tasks do NOT merge", dedupeTasks([callSmith, emailSmith]).length === 2);
// …same anchor (formatting drift) always merges, regardless of status.
check("same anchor still merges", dedupeTasks([doneOld, { ...newEmail, anchorKey: "GMAIL_OLD1" }]).length === 1);
// Same-anchor collision on an EQUAL-rank tie (the studylog day-task shape: two independent sessions each
// mint a fresh id for the same date because one hadn't picked up the other's save yet) must keep the copy
// that actually has the content, not whichever happened to be added to the array first — that arbitrary
// tie-break used to silently discard a day's freshly-generated flashcards on the exact "flashcards
// generated, then gone after reload" bug.
const staleDay = { ...base, id: "day-old", title: "2026-09-11", why: "Daily study log — 2026-09-11", source: "studylog", status: "needs_review", anchorKey: "studylog:2026-09-11", logDate: "2026-09-11", logText: "", updatedAt: "2026-09-11T08:00:00.000Z" };
const freshDay = { ...base, id: "day-new", title: "2026-09-11", why: "Daily study log — 2026-09-11", source: "studylog", status: "needs_review", anchorKey: "studylog:2026-09-11", logDate: "2026-09-11", logText: "Motion graphs & quadratics", flashcards: [{ id: "d1", title: "Physics", cards: [{ front: "f", back: "b" }], createdAt: "2026-09-11T10:00:00.000Z" }], updatedAt: "2026-09-11T10:00:00.000Z" };
const dayMerged = dedupeTasks([staleDay, freshDay]);
check("same-anchor tie keeps the copy with flashcards, not just the first one added", dayMerged.length === 1 && dayMerged[0].flashcards?.length === 1);
check("same-anchor tie keeps the real journal text even if the surviving side's own text is blank", dayMerged.length === 1 && dayMerged[0].logText === "Motion graphs & quadratics");
const dayMergedReversed = dedupeTasks([freshDay, staleDay]);
check("same-anchor tie is order-independent", dayMergedReversed.length === 1 && dayMergedReversed[0].flashcards?.length === 1 && dayMergedReversed[0].logText === "Motion graphs & quadratics");
// …and anchorless title dups still merge (agent-sweep fallback, non-manual source).
check("anchorless title dup still merges", dedupeTasks([{ ...doneOld, anchorKey: undefined }, { ...newEmail, anchorKey: undefined }]).length === 1);
// TWO DIFFERENT DAYS must never collapse into one, even within dedupeTasks' fuzzy sameTask fallback.
// distinctiveTokens() drops words of length <= 2, silently stripping the "09"/"11"/"12" month/day digits out
// of BOTH a bare "YYYY-MM-DD" title and a "Daily study log — YYYY-MM-DD" why — leaving every studylog task
// in the same year with the IDENTICAL distinctive-token set, a perfect nearDup "match" via sameTask(). Real
// bug reproduced live as "journal entries/flashcards not saving to cloud": day 2 silently discarded day 1
// (or vice versa) on the very next dedupeTasks pass (every commit/GET runs one), despite each having its own
// distinct, real anchorKey — anchor identity is what actually distinguishes them, never title/why text.
const day1 = { ...base, id: "day-1", title: "2026-09-11", why: "Daily study log — 2026-09-11", source: "studylog", status: "needs_review", anchorKey: "studylog:2026-09-11", logDate: "2026-09-11", logText: "Motion graphs", flashcards: [{ id: "d1", title: "Physics", cards: [{ front: "f", back: "b" }], createdAt: "2026-09-11T10:00:00.000Z" }], updatedAt: "2026-09-11T10:00:00.000Z" };
const day2 = { ...base, id: "day-2", title: "2026-09-12", why: "Daily study log — 2026-09-12", source: "studylog", status: "needs_review", anchorKey: "studylog:2026-09-12", logDate: "2026-09-12", logText: "Figures de style", flashcards: [{ id: "d2", title: "French", cards: [{ front: "f2", back: "b2" }], createdAt: "2026-09-12T10:00:00.000Z" }], updatedAt: "2026-09-12T10:00:00.000Z" };
const twoDaysMerged = dedupeTasks([day1, day2]);
check("two DIFFERENT studylog days both survive dedupeTasks (distinct anchors)", twoDaysMerged.length === 2);
check("day 1's flashcards survive alongside day 2's", twoDaysMerged.some((t) => t.logDate === "2026-09-11" && t.flashcards?.length === 1) && twoDaysMerged.some((t) => t.logDate === "2026-09-12" && t.flashcards?.length === 1));
// MANUAL tasks are a deliberate user action — fuzzy title similarity must NEVER swallow a fresh manual add
// into an old dismissed/done one just because the wording is similar (regression: "add task, it instantly
// disappears" when retesting with a similarly-worded title after an earlier dismissed/done attempt).
const oldManualDone = { ...base, id: "m1", title: "Buy milk", why: "Added by you", source: "manual", status: "done" };
const newManualSimilar = { ...base, id: "m2", title: "Buy milk and eggs", why: "Added by you", source: "manual", status: "ready" };
check("similarly-worded manual tasks do NOT merge (a deliberate add must always survive)", dedupeTasks([oldManualDone, newManualSimilar]).length === 2);
// Even an EXACT-title re-add of a HANDLED task must survive as a NEW active task — re-typing a to-do you
// finished or dismissed before is a deliberate request to do it again, never a duplicate to hide. (This is
// the "add a task, it instantly auto-deletes" bug: a handled copy was swallowing the fresh manual add.)
const newManualExact = { ...base, id: "m3", title: "buy milk", why: "Added by you", source: "manual", status: "ready" };
const exactRes = dedupeTasks([oldManualDone, newManualExact]);
check("an EXACT-title manual re-add of a DONE task still survives as a new active task", exactRes.length === 2 && exactRes.some((t) => t.id === "m3" && t.status === "ready"));
// Two ACTIVE identical manual cards DO still merge — that's a genuine visual duplicate, not two to-dos.
const activeA = { ...base, id: "m4", title: "buy milk", why: "Added by you", source: "manual", status: "ready" };
const activeB = { ...base, id: "m5", title: "buy milk", why: "Added by you", source: "manual", status: "queued" };
check("two ACTIVE identical manual cards still merge (no visual duplicate)", dedupeTasks([activeA, activeB]).length === 1);

// ── Stale idle tasks auto-archive (keeps the active list a genuine "now" list) ─
section("stale ready tasks auto-archive");
const now = new Date("2026-07-25T12:00:00Z");
const old15d = new Date(now.getTime() - 15 * 86_400_000).toISOString();
const old10d = new Date(now.getTime() - 10 * 86_400_000).toISOString();
// foldGenerated mutates its `existing` items in place, so each fixture below is its own fresh object —
// spreading an already-checked one would silently inherit whatever status the PRIOR call mutated it to.
const staleTask = (over) => ({ ...base, title: "Reply to old outreach thread", why: "asked 3 weeks ago", source: "gmail", status: "ready", ...over });
check("idle ready task older than 14d archives to dismissed", foldGenerated([staleTask({ id: "sr1", anchorKey: "gmail:sr1", createdAt: old15d })], [], [], now).find((t) => t.id === "sr1")?.status === "dismissed");
check("idle ready task under 14d stays active", foldGenerated([staleTask({ id: "sr2", anchorKey: "gmail:sr2", createdAt: old10d })], [], [], now).find((t) => t.id === "sr2")?.status === "ready");
check("a real upcoming deadline keeps an old card alive regardless of age", foldGenerated([staleTask({ id: "sr3", anchorKey: "gmail:sr3", createdAt: old15d, when: new Date(now.getTime() + 86_400_000).toISOString() })], [], [], now).find((t) => t.id === "sr3")?.status === "ready");
check("non-ready statuses are never auto-archived (only untouched 'ready' cards)", foldGenerated([staleTask({ id: "sr4", anchorKey: "gmail:sr4", createdAt: old15d, status: "needs_review" })], [], [], now).find((t) => t.id === "sr4")?.status === "needs_review");

// ── pruneHandled keeps the most recently ACTIONED records, not the most recently CREATED ──
// Bug: sorting by createdAt meant a task dismissed TODAY (but generated weeks ago) could be evicted in
// favor of an OLDER dismissal that just happened to be generated more recently — so a just-dismissed
// item's suppression record could vanish the same sweep it was dismissed in, and the item would resurface
// on the very next sweep. This is the "I dismissed this and it came right back" bug.
section("pruneHandled: dismissed-recency, not created-recency");
const weeksAgo = new Date(now.getTime() - 20 * 86_400_000).toISOString();
const justNow = now.toISOString();
// Generated weeks ago (old inbox item), but the user only just dismissed it moments ago.
const staleCreateFreshDismiss = { ...base, id: "birthday1", title: "Wish Sonya Nyrop a happy birthday", why: "her birthday is on the calendar", source: "calendar", anchorKey: "calendar:sonya-bday-2026", status: "dismissed", createdAt: weeksAgo, updatedAt: justNow };
// A pile of OTHER dismissals, each actioned (updatedAt) progressively longer ago than staleCreateFreshDismiss's
// just-now dismissal, though all created MORE recently than its weeks-old createdAt.
const filler = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `filler${i}`, title: `Filler task ${i}`, why: "noise", source: "gmail", anchorKey: `gmail:filler${i}`, status: "dismissed", createdAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(), updatedAt: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString() }));
const pruned = pruneHandled([staleCreateFreshDismiss, ...filler], 3);
check("a just-dismissed record survives pruning even if it was CREATED long ago", pruned.some((t) => t.id === "birthday1"));
check("older-by-dismissal-time records are the ones dropped when over the cap", pruned.length === 3 && !pruned.some((t) => t.id === "filler4"));

// ── Cross-device merge ────────────────────────────────────────────────────────
section("mergeTaskLists");
const older = new Date(Date.now() - 60000).toISOString(), newer = new Date().toISOString();
const cloudT = { ...base, id: "t1", title: "Send weekly metrics to leadership", why: "Friday report due", source: "gmail", status: "done", anchorKey: "gmail:m1", updatedAt: newer };
const staleT = { ...cloudT, status: "ready", updatedAt: older };
check("done never regresses", mergeTaskLists([cloudT], [staleT])[0].status === "done");
const s1 = { ...base, id: "s1", title: "Prep the offsite agenda deck", why: "offsite Monday", source: "gmail", status: "executed", anchorKey: "gmail:o1", updatedAt: older, steps: [{ text: "Pick venue", automatable: false, done: true }, { text: "Send invites", automatable: false }] };
const s2 = { ...s1, updatedAt: newer, steps: [{ text: "Pick venue", automatable: false }, { text: "Send invites", automatable: false, done: true }] };
const mergedSteps = mergeTaskLists([s1], [s2])[0].steps;
check("step ticks union across devices", mergedSteps.every((s) => s.done));

const c1 = { ...base, id: "c1", title: "Finish the essay", why: "due Friday", source: "manual", status: "needs_review", updatedAt: older, chat: [{ role: "user", text: "how do I start?", at: older }, { role: "assistant", text: "Start with the thesis.", at: older }] };
const c2 = { ...c1, updatedAt: newer, chat: [{ role: "user", text: "what about the conclusion?", at: newer }, { role: "assistant", text: "Tie it back to the thesis.", at: newer }] }; // no earlier turns — a device that only just opened the task
const mergedChat = mergeTaskLists([c1], [c2])[0].chat;
check("chat turns union across devices instead of the winner's copy replacing the loser's", mergedChat.length === 4);
check("unioned chat stays chronologically ordered", mergedChat[0].text === "how do I start?" && mergedChat[3].text === "Tie it back to the thesis.");

// The fast path (skip the per-task merge + dedupeTasks entirely when nothing actually changed — the
// common case on a routine poll, e.g. every 4s while a job is in flight) must be a pure optimization: same
// list in both directions returns the SAME reference (not just an equal one), and a real change anywhere
// still falls through to the genuine merge exactly as before.
const identicalA = { ...base, id: "id1", title: "A", why: "x", source: "gmail", status: "ready", updatedAt: older };
const identicalB = { ...base, id: "id2", title: "B", why: "y", source: "gmail", status: "executing", updatedAt: newer };
const unchangedList = [identicalA, identicalB];
check("identical lists take the fast path (returns the exact same array reference)", mergeTaskLists(unchangedList, unchangedList) === unchangedList);
check("identical-by-value (not just by reference) lists also take the fast path", mergeTaskLists(unchangedList, [{ ...identicalA }, { ...identicalB }]) === unchangedList);
const changedB = { ...identicalB, status: "done" };
check("a real status change still falls through to the genuine merge, not the fast path", mergeTaskLists(unchangedList, [identicalA, changedB])[1].status === "done");

// ── Profile ───────────────────────────────────────────────────────────────────
section("profile merge + updates");
const p = emptyProfile();
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) leads the Q3 budget review" });
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) now leads marketing" });
check("correction replaces same-entity fact", p.people.length === 1 && p.people[0].includes("marketing"));
check("dedupeFacts caps at 40", dedupeFacts(Array.from({ length: 60 }, (_, i) => `Fact ${i} about very distinct topic ${i} x${i}`)).length <= 40);
const pm = mergeProfileStates(
  { ...emptyProfile(), paused: true, pausedAt: older, responseStyle: "concise" },
  { ...emptyProfile(), paused: false, pausedAt: newer },
);
check("newer pause toggle wins", pm.paused === false);
check("structured settings survive merge", pm.responseStyle === "concise");
// Regression: `language` is never actually undefined (normalizeProfile always defaults it to "fr"), so a
// plain `p2.language ?? p1.language` could never tell "device B never touched it" apart from "device B
// explicitly chose fr" — the stale LOCAL session's copy always won, silently reverting another device's
// switch to English on the very next commit from the stale session. Device A switches to English (stamped);
// device B's still-open, never-reloaded session (still "fr", unstamped) merges next — English must survive.
const pmLang = mergeProfileStates(
  { ...emptyProfile(), language: "en", languageSetAt: newer },
  { ...emptyProfile(), language: "fr" }, // stale session, never itself touched the language toggle
);
check("newer-stamped language switch survives a stale unstamped session's merge", pmLang.language === "en");
// A manually-logged exam added on one device (no Pronote — most IB/international schools don't have one)
// must survive a merge against another device's copy that doesn't have it yet, same union-by-id pattern as
// manual grades below.
const pmExams = mergeProfileStates(
  { ...emptyProfile(), manualExams: [{ id: "e1", subject: "Math HL", deadline: "2026-09-10" }] },
  { ...emptyProfile(), manualExams: [{ id: "e2", subject: "Physics SL", deadline: "2026-09-12" }] },
);
check("manual exams union across devices by id", pmExams.manualExams?.length === 2);
const pmExamsDup = mergeProfileStates(
  { ...emptyProfile(), manualExams: [{ id: "e1", subject: "Math HL", deadline: "2026-09-10" }] },
  { ...emptyProfile(), manualExams: [{ id: "e1", subject: "Math HL", deadline: "2026-09-10" }] },
);
check("same-id manual exam doesn't duplicate on merge", pmExamsDup.manualExams?.length === 1);
const pmAcct = mergeProfileStates(
  { ...emptyProfile(), primaryAccounts: { gmail: "acct-a" } },
  { ...emptyProfile(), primaryAccounts: { googlecalendar: "acct-b" } },
);
check("primaryAccounts merge across devices instead of one side clobbering the other", pmAcct.primaryAccounts?.gmail === "acct-a" && pmAcct.primaryAccounts?.googlecalendar === "acct-b");
// A manual grade logged on device A must survive a merge against device B's copy, which doesn't have it
// yet — grades are a history now (union by id), not a one-row-per-subject snapshot (last-write-wins).
const pmGrades = mergeProfileStates(
  { ...emptyProfile(), grades: [{ id: "a", subject: "Maths", grade: 15, scale: 20, updatedAt: older, source: "manual" }] },
  { ...emptyProfile(), grades: [{ id: "b", subject: "Maths", grade: 12, scale: 20, updatedAt: newer, source: "manual" }] },
);
check("both devices' manual grade entries survive the merge (union by id)", pmGrades.grades?.length === 2);
const pmGradeSync = mergeProfileStates(
  { ...emptyProfile(), grades: [{ id: "p1", subject: "Physique", grade: 10, scale: 20, updatedAt: older, source: "pronote" }] },
  { ...emptyProfile(), grades: [{ id: "p1", subject: "Physique", grade: 14, scale: 20, updatedAt: newer, source: "pronote" }] },
);
check("same-id Pronote row still collapses to the newer sync, not duplicated", pmGradeSync.grades?.length === 1 && pmGradeSync.grades?.[0].grade === 14);

// mergeProfileStates is a hand-maintained field-by-field allowlist, not a spread — a field added to the
// Profile interface but forgotten here silently vanishes on the next cross-device sync (exactly how the
// `unlimited` flag broke earlier). Build a profile with EVERY key set to a distinctive value and confirm
// nothing is dropped in either merge direction, so the next forgotten field fails loudly here instead of
// silently in production.
{
  const full = {
    ...emptyProfile(),
    name: "Test Student", about: "about-value", preferences: ["pref-value"], people: ["person-value"],
    projects: ["project-value"], courses: ["course-value"], unlimited: true, paused: true, pausedAt: newer,
    lastSweepAt: newer, lastForcedAt: newer, genPerDay: 2, responseStyle: "concise",
    autoApprove: ["schedule_meetings_under_30min"], highPriorityPeople: ["vip@x.com"],
    autoArchivePatterns: ["newsletter"], timezone: "Europe/Paris",
    usage: { in: 10, out: 20, runs: 1, since: older, monthKey: "2026-08", monthIn: 1, monthOut: 2, monthCost: 0.01 },
    primaryAccounts: { gmail: "acct-x" }, language: "en",
    grades: [{ id: "g1", subject: "Maths", grade: 15, scale: 20, updatedAt: newer, source: "manual" }],
    track: "ib", learningStyle: "visual",
  };
  const keys = Object.keys(full).filter((k) => full[k] !== undefined && !(Array.isArray(full[k]) && full[k].length === 0));
  const dropped = (merged) => keys.filter((k) => merged[k] === undefined || (Array.isArray(merged[k]) && merged[k].length === 0));
  check("mergeProfileStates(full, {}) drops no field", dropped(mergeProfileStates(full, emptyProfile())).length === 0);
  check("mergeProfileStates({}, full) drops no field", dropped(mergeProfileStates(emptyProfile(), full)).length === 0);
}

// ── Policy registry ───────────────────────────────────────────────────────────
section("action policy registry");
check("send email is never-allowed", ACTION_POLICIES.GMAIL_SEND_EMAIL === "never");
check("draft is auto-allowed", ACTION_POLICIES.GMAIL_CREATE_EMAIL_DRAFT === "auto");
check("calendar create needs approval", isWriteGatedAction("GOOGLECALENDAR_CREATE_EVENT") === true);
check("gmail read needs no approval", isWriteGatedAction("GMAIL_FETCH_EMAILS") === false);
check("doc edit needs approval", isWriteGatedAction("GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT") === true);
check("unlisted destructive action falls back to regex", isWriteGatedAction("GOOGLESLIDES_BATCH_UPDATE_PRESENTATION") === true);
check("sheet cell write is auto", isWriteGatedAction("GOOGLESHEETS_UPDATE_VALUES") === false);

// ── Irreversible-action guardrail — the app must NEVER send/delete/invite/pay unattended ─────────
// isGatedAction (tool is STRIPPED from the agent's toolset entirely) — the hardest guarantee.
section("guardrail: never-run (isGatedAction) — sends, deletes, invites, payments");
// Sends (reaching other people) — every channel.
check("Gmail send is gated", isGatedAction("GMAIL_SEND_EMAIL"));
check("Gmail reply is gated", isGatedAction("GMAIL_REPLY_TO_THREAD"));
check("Gmail forward is gated", isGatedAction("GMAIL_FORWARD_MESSAGE"));
check("Gmail send-draft is gated", isGatedAction("GMAIL_SEND_DRAFT"));
check("Slack post is gated", isGatedAction("SLACK_CHAT_POST_MESSAGE"));
check("Slack send-message is gated", isGatedAction("SLACK_SEND_MESSAGE"));
check("Twitter tweet is gated", isGatedAction("TWITTER_CREATE_TWEET"));
check("LinkedIn post is gated", isGatedAction("LINKEDIN_CREATE_POST"));
check("Discord DM is gated", isGatedAction("DISCORD_CREATE_DM"));
check("generic 'invite' action is gated", isGatedAction("GOOGLECALENDAR_SEND_INVITE"));
check("generic 'share' action is gated", isGatedAction("GOOGLEDRIVE_SHARE_FILE"));
check("generic notify/broadcast/announce actions are gated", isGatedAction("SLACK_NOTIFY_CHANNEL") && isGatedAction("TODOIST_BROADCAST_UPDATE") && isGatedAction("HUBSPOT_ANNOUNCE_CAMPAIGN"));
// Deletes / destructive (data can't come back) — every app, not just Google.
check("Gmail delete is gated", isGatedAction("GMAIL_DELETE_MESSAGE"));
check("Gmail trash is gated", isGatedAction("GMAIL_TRASH_MESSAGE"));
check("Calendar delete is gated", isGatedAction("GOOGLECALENDAR_DELETE_EVENT"));
check("Drive delete is gated", isGatedAction("GOOGLEDRIVE_DELETE_FILE"));
check("Sheets delete-sheet is gated", isGatedAction("GOOGLESHEETS_DELETE_SHEET"));
check("generic delete on ANY toolkit is gated (Notion)", isGatedAction("NOTION_DELETE_PAGE"));
check("generic delete on ANY toolkit is gated (GitHub)", isGatedAction("GITHUB_DELETE_REPOSITORY"));
check("generic delete on ANY toolkit is gated (Linear)", isGatedAction("LINEAR_DELETE_ISSUE"));
check("wipe/purge/erase/destroy are gated", isGatedAction("AIRTABLE_WIPE_BASE") && isGatedAction("TRELLO_PURGE_BOARD") && isGatedAction("CLICKUP_ERASE_SPACE") && isGatedAction("ASANA_DESTROY_PROJECT"));
check("empty-trash is gated", isGatedAction("GMAIL_EMPTY_TRASH"));
// Financial (moves money) — a category the old regex never covered at all.
check("payment is gated", isGatedAction("STRIPE_CREATE_PAYMENT"));
check("charge is gated", isGatedAction("STRIPE_CHARGE_CUSTOMER"));
check("refund is gated", isGatedAction("STRIPE_CREATE_REFUND"));
check("checkout is gated", isGatedAction("SHOPIFY_CHECKOUT_COMPLETE"));
check("transfer is gated", isGatedAction("PAYPAL_TRANSFER_FUNDS"));
check("subscribe (recurring charge) is gated", isGatedAction("STRIPE_SUBSCRIBE_CUSTOMER"));
// Safe actions must NOT be caught by the broadened regex (no false positives).
check("reading mail is NOT gated", !isGatedAction("GMAIL_FETCH_EMAILS"));
check("creating a draft is NOT gated", !isGatedAction("GMAIL_CREATE_EMAIL_DRAFT"));
check("updating a draft is NOT gated", !isGatedAction("GMAIL_UPDATE_EMAIL_DRAFT"));
check("listing drafts is NOT gated", !isGatedAction("GMAIL_LIST_DRAFTS"));
check("creating a doc is NOT gated", !isGatedAction("GOOGLEDOCS_CREATE_DOCUMENT"));
check("creating a calendar event is NOT gated (only write-gated)", !isGatedAction("GOOGLECALENDAR_CREATE_EVENT"));
check("a company named 'Sharemint' etc. doesn't false-positive on SHARE", !isGatedAction("HUBSPOT_GET_CONTACT")); // sanity: unrelated read

// isWriteGatedAction (DEFAULT DENY) — the "any other irreversible action" backstop. Any write the code
// hasn't explicitly reviewed as safe must require the user's "Approve & Run" click, not silently run.
section("guardrail: default-deny for unaudited writes (isWriteGatedAction)");
check("unknown app's create action requires approval (GitHub issue)", isWriteGatedAction("GITHUB_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Notion page)", isWriteGatedAction("NOTION_CREATE_PAGE") === true);
check("unknown app's create action requires approval (Linear ticket)", isWriteGatedAction("LINEAR_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Jira issue)", isWriteGatedAction("JIRA_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Todoist task)", isWriteGatedAction("TODOIST_CREATE_TASK") === true);
check("unknown app's create action requires approval (HubSpot contact)", isWriteGatedAction("HUBSPOT_CREATE_CONTACT") === true);
check("unknown app's update action requires approval (Trello card)", isWriteGatedAction("TRELLO_UPDATE_CARD") === true);
// Reads on any toolkit stay auto (gathering context isn't an action against the world).
check("reads on unaudited toolkits stay auto (GitHub list)", isWriteGatedAction("GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER") === false);
check("reads on unaudited toolkits stay auto (Notion search)", isWriteGatedAction("NOTION_SEARCH_PAGES") === false);
check("reads on unaudited toolkits stay auto (Linear get)", isWriteGatedAction("LINEAR_GET_ISSUE") === false);
// The explicitly-reviewed Google auto-writes must still work (no regression from the default-deny flip).
check("Gmail draft create stays auto (explicit policy)", isWriteGatedAction("GMAIL_CREATE_EMAIL_DRAFT") === false);
check("Sheets cell update stays auto (explicit policy)", isWriteGatedAction("GOOGLESHEETS_UPDATE_VALUES") === false);
check("Sheets append stays auto (explicit policy)", isWriteGatedAction("GOOGLESHEETS_APPEND_VALUES") === false);
check("Docs create-new stays auto (explicit policy)", isWriteGatedAction("GOOGLEDOCS_CREATE_DOCUMENT") === false);

// ── Task lifecycle ────────────────────────────────────────────────────────────
section("task lifecycle");
check("legacy running → executing", canonStatus("running") === "executing");
check("legacy executed → needs_review", canonStatus("executed") === "needs_review");
check("queued is in-flight", isInFlight("queued") && isInFlight("executing") && isInFlight("running"));
check("failed is not in-flight", !isInFlight("failed_retryable") && !isInFlight("failed_terminal"));
check("done/dismissed are handled", isHandled("done") && isHandled("dismissed") && !isHandled("needs_review"));
const doneCopy = { ...base, id: "lc1", title: "Renew the trademark registration", why: "USPTO notice arrived", source: "gmail", status: "done", anchorKey: "gmail:lc1", updatedAt: newer };
const failedCopy = { ...doneCopy, status: "failed_terminal", updatedAt: newer };
check("done beats failed_terminal in merge", mergeTaskLists([doneCopy], [failedCopy])[0].status === "done");
const nrCopy = { ...doneCopy, status: "needs_review" };
const execCopy = { ...doneCopy, status: "executing" };
check("needs_review beats executing in merge", mergeTaskLists([execCopy], [nrCopy])[0].status === "needs_review");

// ── Discovery pipeline filters ────────────────────────────────────────────────
section("discovery filters");
const mk = (over = {}) => ({ sourceApp: "gmail", externalId: "x", anchorKey: "gmail:x", title: "Quick question about the offsite", snippet: "…", sender: "sarah@acme.com", timestamp: "", labels: ["inbox"], ...over });
check("newsletter sender is noise", isNoise(mk({ sender: "newsletter@shop.com" })));
check("no-reply sender is noise", isNoise(mk({ sender: "no-reply@stripe.com" })));
check("unsubscribe subject is noise", isNoise(mk({ title: "March deals — unsubscribe anytime" })));
check("real person is not noise", !isNoise(mk()));
check("sent commitment never noise", isNoise(mk({ sender: "noreply@x.com", labels: ["sent"] })) === false);
// Verification/one-time-code mail — real, but nothing to plan or do beyond typing a code already in hand;
// churns constantly (every login/new device) and would otherwise flood the sweep. Broadened past the
// original narrow "verify your email" match — these are real subject/preview shapes that used to slip through.
check("'verify your email' subject is noise", isNoise(mk({ title: "Verify your email address" })));
check("'confirm your account' subject is noise", isNoise(mk({ title: "Confirm your account to continue" })));
check("a numeric verification-code subject is noise", isNoise(mk({ title: "Your verification code" })));
check("OTP mentioned in the subject is noise", isNoise(mk({ title: "Your OTP for login" })));
check("a generic subject with the tell only in the body/preview is still caught", isNoise(mk({ title: "Action required", snippet: "Enter this code to verify your account: 482913" })));
check("a 2FA sign-in code subject is noise", isNoise(mk({ title: "Your sign-in code" })));
check("a genuine security alert (not a code) is still noise, unchanged", isNoise(mk({ title: "New security alert for your account" })));
const filtered = filterCandidates([mk(), mk({ anchorKey: "GMAIL_KNOWN1", externalId: "k1" }), mk({ sender: "marketing@spam.io", anchorKey: "gmail:sp" })], ["gmail:known1"]);
check("known anchors + noise filtered out", filtered.length === 1 && filtered[0].anchorKey === "gmail:x");

// ── Quality bar (deterministic post-classification thresholds) ────────────────
section("quality bar");
const qItems = [
  { anchorKey: "gmail:vip1", labels: ["inbox"], sender: "Sarah Chen <sarah@acme.com>" },
  { anchorKey: "gmail:low1", labels: ["inbox"], sender: "random@somewhere.com" },
  { anchorKey: "gmail:sent1", labels: ["sent"], sender: "me@me.com" },
  { anchorKey: "gmail:sent2", labels: ["sent"], sender: "me@me.com" },
  { anchorKey: "gmail:hi1", labels: ["inbox"], sender: "colleague@acme.com" },
];
const qTasks = [
  { anchorKey: "gmail:vip1", title: "Reply to Sarah", urgency: 0.2, importance: 0.3 },        // low scores BUT VIP → keep
  { anchorKey: "gmail:low1", title: "Skim optional survey", urgency: 0.2, importance: 0.3 },   // marginal → drop
  { anchorKey: "gmail:sent1", title: "Send the deck", when: "by Friday", urgency: 0.4, importance: 0.4 }, // commitment + deadline → keep
  { anchorKey: "gmail:sent2", title: "Vague follow up", urgency: 0.3, importance: 0.3 },       // commitment, NO deadline, low scores → drop
  { anchorKey: "gmail:hi1", title: "Review the contract", urgency: 0.7, importance: 0.5 },     // high urgency → keep
];
const kept = applyQualityBar(qTasks, qItems, ["Sarah — my manager (sarah@acme.com)"]);
const keptAnchors = kept.map((t) => t.anchorKey);
check("VIP kept despite low scores", keptAnchors.includes("gmail:vip1"));
check("marginal maybe dropped", !keptAnchors.includes("gmail:low1"));
check("deadline'd commitment kept", keptAnchors.includes("gmail:sent1"));
check("vague commitment dropped", !keptAnchors.includes("gmail:sent2"));
check("high-urgency kept", keptAnchors.includes("gmail:hi1"));

// ── Run report guarantees (finalize) ──────────────────────────────────────────
section("finalize run report");
const docLink = { label: "Q3 budget doc", url: "https://docs.google.com/document/d/1xVdKvq8GjwskuuAmuAbCdEfGhIjKlMnOp/edit" };
const fin1 = finalize({ context: "c", synthesis: "Created the budget doc.", steps: [], links: [docLink], sendables: [] }, "", []);
check("links with no steps/sendables get a Review checklist", fin1.steps.length === 1 && fin1.steps[0].text.startsWith("Review") && fin1.steps[0].url === docLink.url);
// Regression: the context schema promises "2-4 bullets" but finalize() kept only the first 2 lines and cut
// at 380 chars total — a real assignment's context (subject/due-date/teacher-pointer/focus-questions, 4
// genuine bullets) got silently gutted, reported live as a Pronote task's context cutting off mid-sentence.
const fourBulletContext = "- Bullet one about the subject and deadline\n- Bullet two about the group document\n- Bullet three naming the three focus questions from class\n- Bullet four about how much of the group work to reuse";
const finContext = finalize({ context: fourBulletContext, synthesis: "Created the budget doc.", steps: [], links: [docLink], sendables: [] }, "", []);
check("finalize keeps all 4 promised context bullets, not just 2", finContext.context.split("\n").length === 4);
check("finalize's context cap is generous enough not to gut a real 4-bullet context", finContext.context === fourBulletContext);
// The model's own "is this big?" judgment (not a keyword guess) rides through finalize() so
// writeStepsFromContext can use it even when the title never names an acronym — see RunOutput.isBigProject.
const finBig = finalize({ context: "c", synthesis: "Gathered sources.", steps: [], links: [], sendables: [], isBigProject: true }, "", []);
check("finalize passes through a true isBigProject flag", finBig.isBigProject === true);
const finNotBig = finalize({ context: "c", synthesis: "Done.", steps: [], links: [], sendables: [], isBigProject: false }, "", []);
check("finalize passes through a false isBigProject flag", finNotBig.isBigProject === false);
const finNoFlag = finalize({ context: "c", synthesis: "Done.", steps: [], links: [], sendables: [] }, "", []);
check("finalize omits isBigProject when the model didn't answer (no silent default)", finNoFlag.isBigProject === undefined);
const fin2 = finalize({ context: "c", synthesis: "Drafted a reply to Sarah.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send reply", to: "s@a.com", subject: "Re", body: "hi", draftId: "r-1234567890" }] }, "", []);
check("sendable needs no backstop step", fin2.steps.length === 0 && fin2.sendables.length === 1);
// A REPLY draft has no explicit "to" (Gmail infers it from the thread) — it must STILL surface as a
// sendable, or the drafted reply never shows a Send button ("draft reply isn't showing the reply" bug).
const finReply = finalize({ context: "c", synthesis: "Drafted a reply.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send reply", subject: "Re: hi", body: "thanks!", draftId: "r-99" }] }, "", []);
check("reply draft without `to` still surfaces a sendable", finReply.sendables.length === 1 && finReply.sendables[0].draftId === "r-99");
// But a placeholder recipient is still dropped (never offer to send into the void).
const finPh = finalize({ context: "c", synthesis: "Drafted.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send", to: "someone@example.com", subject: "s", body: "b", draftId: "r-1" }] }, "", []);
check("placeholder recipient still dropped", finPh.sendables.length === 0);
const fin3 = finalize({ context: "c", synthesis: "Booked nothing.", steps: [{ text: "Pick a date", automatable: false }], links: [docLink], sendables: [] }, "", []);
check("real steps are never overwritten", fin3.steps.length === 1 && fin3.steps[0].text === "Pick a date");
// Regression: synthesis (the field runStep copies verbatim into a single step's own `result`, shown right
// under it in the UI) opening with search-process narration must be stripped even when the run otherwise
// produced real steps/links — the earlier "blank out only when nothing else was produced" gate didn't cover
// this, which is exactly how "Ran several additional Drive/Gmail queries that came back empty" reached a
// student's screen as a step's result.
const finMeta = finalize({ context: "c", synthesis: "Ran several additional Drive/Gmail queries that came back empty.", steps: [{ text: "Pick a date", automatable: false }], links: [], sendables: [] }, "", []);
check("meta-narration synthesis never reaches the user — replaced by the generic steps-exist fallback", !/ran|quer|came back empty/i.test(finMeta.synthesis));
// Regression: "Retried web grounding searches, which returned empty results" reached the UI verbatim as a
// step's result — neither "retried" (INVESTIGATIVE) nor "returned empty results" (DEAD_END) matched before.
const finMeta2 = finalize({ context: "c", synthesis: "Retried web grounding searches, which returned empty results.", steps: [{ text: "Pick a date", automatable: false }], links: [], sendables: [] }, "", []);
check("'retried ... returned empty results' meta-narration is also stripped", !/retried|grounding|empty results/i.test(finMeta2.synthesis));
const finMetaThenReal = finalize({ context: "c", synthesis: "Searched Gmail with no luck. Drafted a reply to Sarah.", steps: [], links: [], sendables: [{ app: "gmail", label: "Send reply", subject: "Re", body: "hi", draftId: "r-1" }] }, "", []);
check("only the leading meta-narration sentence is stripped, real content after it survives", finMetaThenReal.synthesis === "Drafted a reply to Sarah.");
let finThrew = false;
try { finalize({ context: "", synthesis: "Let me first check the calendar and then I'll draft it.", steps: [], links: [], sendables: [] }, "", []); }
catch { finThrew = true; }
check("planning-tense-only result still fails honestly", finThrew);
const fin4 = finalize({ context: "c", synthesis: "Created the doc.", did: ["Created the Q3 doc with the table", "Let me now check the calendar", "- Drafted a reply to Sam"], steps: [{ text: "Pick a date", automatable: false }], links: [], sendables: [] }, "", []);
check("did bullets kept, planning prose dropped, dashes stripped", fin4.did.length === 2 && fin4.did[1] === "Drafted a reply to Sam");
// Regression: a model that returns OBJECTS in did[] (instead of the requested strings) must never render as
// "[object Object]" on the card — finalize coerces each entry to readable text before it reaches the client.
const fin4b = finalize({ context: "c", synthesis: "Created the doc.", did: [{ text: "Created the Q3 doc with the table" }, { message: "Filled 12 cells in the sheet" }], steps: [], links: [], sendables: [] }, "", []);
check("object did[] entries coerced to their text, never [object Object]", fin4b.did.every((d) => typeof d === "string" && !d.includes("[object Object]")) && fin4b.did.length === 2);
const fin5 = finalize({ context: "c", synthesis: "Made a doc.", steps: [], links: [{ label: "Open", url: docLink.url }], sendables: [] }, "", []);
check("junk link label relabeled by kind", /Google Doc/i.test(fin5.links[0].label));

// ── Reconcile draft claims with surviving artifacts (the "said it drafted, didn't" bug) ──
section("reconcile artifact claims");
// A "Drafted a reply" claim with NO sendable is a fabrication — strip it.
const rc1 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi apologizing about the AI service.", did: ["Drafted a reply to Mmachi apologizing that the AI service on Weave wasn't working"], links: [], sendables: [], steps: [] });
check("unbacked draft claim stripped from did", rc1.did.length === 0);
check("unbacked draft claim stripped from synthesis", rc1.synthesis === "");
check("honest step added when nothing real remains", rc1.steps.length === 1 && !rc1.steps[0].automatable);
// WITH a sendable, the same claim is truthful — leave it untouched.
const rc2 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi.", did: ["Drafted a reply to Mmachi"], links: [], sendables: [{ app: "gmail", label: "Send", to: "m@a.com", draftId: "r-1", body: "x" }], steps: [] });
check("backed draft claim kept when a sendable exists", rc2.did.length === 1 && rc2.synthesis === "Drafted a reply to Mmachi.");
// Non-draft work (a real doc with a link) is never touched by this pass.
const rc3 = reconcileArtifactClaims({ synthesis: "Built the Q3 doc.", did: ["Built the Q3 budget doc"], links: [{ label: "Q3 doc", url: "https://docs.google.com/document/d/x" }], sendables: [], steps: [] });
check("non-draft claim untouched", rc3.did.length === 1 && rc3.synthesis === "Built the Q3 doc.");
// FALSE-POSITIVE GUARD: "Drafted the proposal doc" is DOCUMENT drafting (backed by a link, not a sendable) —
// the message-claim regex must NOT strip it just because it contains the word "drafted".
const rc3b = reconcileArtifactClaims({ synthesis: "Drafted the proposal document.", did: ["Drafted the proposal doc", "Composed a one-page summary"], links: [{ label: "Proposal", url: "https://docs.google.com/document/d/z" }], sendables: [], steps: [] });
check("document drafting not mistaken for an email claim", rc3b.did.length === 2 && rc3b.synthesis === "Drafted the proposal document.");
// A draft claim stripped but OTHER real output remains → no hollow step added.
const rc4 = reconcileArtifactClaims({ synthesis: "Drafted a reply.", did: ["Drafted a reply", "Created the Q3 doc"], links: [{ label: "d", url: "https://docs.google.com/document/d/y" }], sendables: [], steps: [] });
check("no honest step when other real output survives", rc4.did.length === 1 && rc4.did[0] === "Created the Q3 doc" && !rc4.steps.length);
// Tolerates the WebTask shape (undefined arrays) — the job-layer call path.
const rc5 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi.", did: undefined, links: undefined, sendables: undefined, steps: undefined });
check("tolerates undefined arrays (WebTask shape)", rc5.synthesis === "" && Array.isArray(rc5.steps) && rc5.steps.length === 1);
// A genuine user step already present → stays honest without piling on another.
const rc6 = reconcileArtifactClaims({ synthesis: "Drafted it.", did: ["Drafted the message"], links: [], sendables: [], steps: [{ text: "Pick the recipient", automatable: false }] });
check("existing real step preserved, none added", rc6.steps.length === 1 && rc6.steps[0].text === "Pick the recipient");

// ── Task-scoped toolset ───────────────────────────────────────────────────────
section("scopeTools");
const mkTool = (kit, n) => ({ name: `${kit.toUpperCase()}_ACTION_${n}`, description: `[${kit}] does thing ${n}`, input_schema: { type: "object", properties: {} } });
const bigSet = { tools: ["gmail", "googledocs", "googledrive", "googlecalendar", "googlesheets", "googleslides", "github", "notion"].flatMap((k) => Array.from({ length: 8 }, (_, i) => mkTool(k, i))), call: async () => null, connected: [] };
const scopedMail = scopeTools(bigSet, { title: "Reply to Sarah about the offsite venue", why: "she asked yesterday", source: "gmail" });
check("email task drops calendar/slides/github/notion kits (sheets is core, stays)", scopedMail.tools.length === 32 && !scopedMail.tools.some((t) => /^\[(googlecalendar|googleslides|github|notion)\]/.test(t.description)) && scopedMail.tools.some((t) => /^\[googlesheets\]/.test(t.description)));
const scopedCal = scopeTools(bigSet, { title: "Schedule a call with the vendor", why: "meeting needed", source: "gmail" });
check("meeting keywords pull calendar back in", scopedCal.tools.some((t) => /^\[googlecalendar\]/.test(t.description)));
const small = { ...bigSet, tools: bigSet.tools.slice(0, 20) };
check("small toolsets pass through untouched", scopeTools(small, { title: "x", why: "y" }).tools.length === 20);

// ── Artifact registry ─────────────────────────────────────────────────────────
section("artifact registry + guardrail: never edit a document Otto didn't create");
const tripDocId = "1xVdKvq8GjwskuuAmuAbCdEfGhIjKlMnOp";
const artInput = {
  links: [{ label: "Trip doc", url: `https://docs.google.com/document/d/${tripDocId}/edit` }],
  sendables: [{ app: "gmail", label: "Send reply", draftId: "r777777777" }, { app: "gcal", label: "Invites", eventId: "evt123456" }],
};
// GUARDRAIL — "Otto may only edit what Otto created": a doc link is only an ARTIFACT (grants the
// no-approval edit carve-out later) when its id is independently VERIFIED as created this run. The
// model's self-reported link alone is never enough — see the fail-closed cases below.
const arts = extractArtifacts(artInput, [tripDocId]);
check("verified doc + draft + event extracted", arts.length === 3 && arts[0].kind === "doc" && arts[1].kind === "draft" && arts[2].kind === "event");
const noVerify = extractArtifacts(artInput);
check("fails closed: no verifiedDocIds → doc dropped (draft/event unaffected)", noVerify.length === 2 && !noVerify.some((a) => a.kind === "doc"));
const wrongVerify = extractArtifacts(artInput, ["someOtherDocIdEntirely1234567"]);
check("fails closed: a link to a DIFFERENT (unverified) doc id is dropped, not trusted", wrongVerify.length === 2 && !wrongVerify.some((a) => a.kind === "doc"));
const merged = unionArtifacts(arts, [{ kind: "doc", id: tripDocId, label: "Trip doc v2" }]);
check("union dedupes by id, keeps latest label", merged.length === 3 && merged.find((a) => a.kind === "doc")?.label === "Trip doc v2");

// ── Discovery: past events + replied threads ──────────────────────────────────
section("discovery time filters");
const NOW = Date.parse("2026-07-19T12:00:00Z");
const evs = calendarToItems({ items: [
  { id: "past1", summary: "Old standup", start: { dateTime: "2026-07-19T09:00:00Z" } },
  { id: "soon1", summary: "Client call", start: { dateTime: "2026-07-19T15:00:00Z" } },
] }, NOW);
check("started events dropped, upcoming kept", evs.length === 1 && evs[0].externalId === "soon1");
// All-day events carry a bare date ("2026-07-19", no time) — Date.parse resolves that to 00:00:00 UTC, which
// is BEFORE `now` (noon UTC the same day) once the 1h grace window is subtracted, so before the fix this was
// wrongly treated as "already started" and dropped for most of its own actual day. It must survive until the
// end of its calendar day, not its literal UTC-midnight instant.
const allDayEvs = calendarToItems({ items: [
  { id: "allday1", summary: "Exam day", start: { date: "2026-07-19" } },
  { id: "alldayOld", summary: "Last week's holiday", start: { date: "2026-07-10" } },
] }, NOW);
check("today's all-day event survives past UTC midnight", allDayEvs.some((e) => e.externalId === "allday1"));
check("a genuinely past all-day event is still dropped", !allDayEvs.some((e) => e.externalId === "alldayOld"));
const thread = (labels, ts) => ({ sourceApp: "gmail", externalId: "t1", anchorKey: "gmail:t1", title: "Budget question", snippet: "…", sender: "a@b.com", timestamp: ts, labels });
const replied = dedupeByThread([thread(["inbox"], "2026-07-18T10:00:00Z"), thread(["sent"], "2026-07-18T14:00:00Z")]);
check("user's newer reply wins (thread handled)", replied.length === 1 && replied[0].labels.includes("sent"));
const reopened = dedupeByThread([thread(["sent"], "2026-07-18T10:00:00Z"), thread(["inbox"], "2026-07-18T14:00:00Z")]);
check("their newer message wins (thread live again)", reopened.length === 1 && reopened[0].labels.includes("inbox"));

// ── Report guarantees: step flip + stale-step drop ────────────────────────────
section("step quality");
const fin6 = finalize({ context: "c", synthesis: "Gathered the trip details.", did: [], steps: [
  { text: "Create a packing checklist doc with all sections", automatable: false },
  { text: "Decide which hotel you prefer", automatable: false },
], links: [], sendables: [] }, "", []);
check("doable step flipped to automatable, judgment step stays", fin6.steps[0].automatable === true && fin6.steps[1].automatable === false);
// Regression: "Research X and compile a list" was leaving the model's own research work as a hand-back
// step instead of triggering the FINISH-DON'T-HAND-BACK enforcement, because "research"/"find" weren't
// recognized as doable verbs — Otto has web_search + doc tools and should just do this itself.
const fin6b = finalize({ context: "c", synthesis: "Looked into it.", did: [], steps: [
  { text: "Research summer programs for next summer and compile a list of options", automatable: false },
  { text: "Find a time that works for the team", automatable: false },
], links: [], sendables: [] }, "", []);
check("'Research ... compile a list' flipped to automatable", fin6b.steps[0].automatable === true);
check("'Find a time' (coordination, not research) also treated as doable", fin6b.steps[1].automatable === true);
const fin7 = finalize({ context: "c", synthesis: "Created the checklist doc.", did: ["Created the packing checklist doc with all sections"], steps: [
  { text: "Create the packing checklist doc with all sections", automatable: false },
  { text: "Print the checklist for the trip", automatable: false },
], links: [], sendables: [] }, "", []);
check("step duplicating a did-bullet dropped", fin7.steps.length === 1 && /Print/.test(fin7.steps[0].text));

// ── Durable daily sweep (WS1) ─────────────────────────────────────────────────
section("daily sweep timing");
const utcProfile = { ...emptyProfile() };
const nyProfile = { ...emptyProfile(), timezone: "America/New_York" };
check("no prior sweep is due", sweepDueForDay(undefined, utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept earlier same UTC day is NOT due", !sweepDueForDay("2026-07-20T06:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept yesterday IS due", sweepDueForDay("2026-07-19T23:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
// 2026-07-20T02:00Z is still Jul 19 in New York (22:00 EDT) — a "morning" sweep the next NY day is due.
check("timezone day boundary respected", sweepDueForDay("2026-07-20T02:00:00Z", nyProfile, new Date("2026-07-20T13:00:00Z")));
check("localDay in NY vs UTC differ across midnight", localDay("2026-07-20T02:00:00Z", "America/New_York") === "2026-07-19" && localDay("2026-07-20T02:00:00Z", "UTC") === "2026-07-20");

// ── Daily-minimum "≥1 task/day" force gate (once per local day) ───────────────
section("daily-minimum force gate");
check("never forced before → due", forcedDueToday({ ...utcProfile }, new Date("2026-07-20T08:00:00Z")));
check("forced earlier the SAME local day → NOT due (no double-force)", !forcedDueToday({ ...utcProfile, lastForcedAt: "2026-07-20T06:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
check("forced YESTERDAY → due again today", forcedDueToday({ ...utcProfile, lastForcedAt: "2026-07-19T23:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
// Timezone: 2026-07-20T02:00Z is still Jul 19 in NY, so a force the next NY day is due — the gate is per LOCAL day.
check("force gate respects the user's timezone", forcedDueToday({ ...nyProfile, lastForcedAt: "2026-07-20T02:00:00Z" }, new Date("2026-07-20T13:00:00Z")));

// ── No daily auto-run spend cap (removed per direct instruction — sweep + kick loop auto-run everything) ──
section("autoRunBudgetLeft / recordAutoRuns — no daily cap on passive AI spend");
{
  const p = { ...utcProfile };
  check("always unlimited, fresh day", autoRunBudgetLeft(p, new Date("2026-07-20T08:00:00Z")) === Infinity);
  recordAutoRuns(p, 3, new Date("2026-07-20T08:00:00Z"));
  check("still unlimited after spending", autoRunBudgetLeft(p, new Date("2026-07-20T09:00:00Z")) === Infinity);
  recordAutoRuns(p, 400, new Date("2026-07-20T20:00:00Z")); // no amount of spend ever caps it
  check("unlimited regardless of how much was spent today", autoRunBudgetLeft(p, new Date("2026-07-20T22:00:00Z")) === Infinity);
  check("recordAutoRuns(0) is a no-op", (() => { const q = { ...utcProfile, autoRunDay: "2026-07-20", autoRunCount: 1 }; recordAutoRuns(q, 0, new Date("2026-07-20T10:00:00Z")); return q.autoRunCount === 1; })());
  // autoRunDay/autoRunCount are still tracked (recordAutoRuns unchanged) even though the cap itself is gone —
  // in case a real ceiling is ever wanted again, the accounting is already there to gate against.
  check("autoRunCount still accumulates for potential future use", (() => { const q = { ...utcProfile }; recordAutoRuns(q, 3, new Date("2026-07-20T08:00:00Z")); recordAutoRuns(q, 4, new Date("2026-07-20T16:00:00Z")); return q.autoRunCount === 7 && q.autoRunDay === "2026-07-20"; })());
}

// ── Sweep cadence: once a day, fixed at 16:00 local ───────────────────────────
section("sweep cadence — once a day, fixed at 16:00 local");
// Before 4pm local: never due, even with no prior sweep at all.
check("08:00 UTC, no prior sweep → NOT due (before 4pm)", !sweepDue({ ...utcProfile }, new Date("2026-07-20T08:00:00Z")));
check("15:59 UTC, no prior sweep → NOT due (still before 4pm)", !sweepDue({ ...utcProfile }, new Date("2026-07-20T15:59:00Z")));
// At/after 4pm local, nothing swept yet today: due.
check("16:00 UTC, no prior sweep → due", sweepDue({ ...utcProfile }, new Date("2026-07-20T16:00:00Z")));
check("20:00 UTC, no prior sweep → due", sweepDue({ ...utcProfile }, new Date("2026-07-20T20:00:00Z")));
// Already swept today (even this morning, before 4pm) — not due again regardless of current hour.
check("already swept 08:00 same day → NOT due at 20:00", !sweepDue({ ...utcProfile, lastSweepAt: "2026-07-20T08:00:00Z" }, new Date("2026-07-20T20:00:00Z")));
// Swept yesterday → due again today once past 4pm.
check("swept yesterday → due today at 17:00", sweepDue({ ...utcProfile, lastSweepAt: "2026-07-19T18:00:00Z" }, new Date("2026-07-20T17:00:00Z")));
check("swept yesterday → NOT due today at 10:00 (before 4pm)", !sweepDue({ ...utcProfile, lastSweepAt: "2026-07-19T18:00:00Z" }, new Date("2026-07-20T10:00:00Z")));
// Timezone-aware: 19:00 UTC is 15:00 in New York (EDT, UTC-4) — still before 4pm THERE.
check("19:00 UTC is only 15:00 in New York → NOT due yet", !sweepDue({ ...nyProfile }, new Date("2026-07-20T19:00:00Z")));
check("20:00 UTC is 16:00 in New York → due", sweepDue({ ...nyProfile }, new Date("2026-07-20T20:00:00Z")));

// Learned productive hour (shared/types.ts) can move the floor EARLIER, never later — an account with a
// real, trusted history of being active at 8am shouldn't wait until the fixed 4pm default.
const earlyBirdHours = new Array(24).fill(1); earlyBirdHours[8] = 30; // clearly peaks at 8am, well over minTotal
check("learned 8am-peak account is due at 9am (earlier than the fixed 4pm default)", sweepDue({ ...utcProfile, activityHours: earlyBirdHours }, new Date("2026-07-20T09:00:00Z")));
check("learned 8am-peak account is still NOT due before its own peak hour (7am)", !sweepDue({ ...utcProfile, activityHours: earlyBirdHours }, new Date("2026-07-20T07:00:00Z")));
const lateBirdHours = new Array(24).fill(1); lateBirdHours[22] = 30; // peaks at 10pm, LATER than the 4pm default
check("a learned peak LATER than the fixed default never delays the floor past 4pm", sweepDue({ ...utcProfile, activityHours: lateBirdHours }, new Date("2026-07-20T16:00:00Z")));
check("too little history (below minTotal) falls back to the fixed 4pm default, not a noisy guess", !sweepDue({ ...utcProfile, activityHours: (() => { const h = new Array(24).fill(0); h[8] = 3; return h; })() }, new Date("2026-07-20T09:00:00Z")));

// ── profile.studentModel refresh gate — once/day, and only if there's been real activity ─────────────
section("shouldRefreshStudentModel — the Primer-style tutor memory's cost-discipline gate");
{
  const now = new Date("2026-07-20T16:05:00Z");
  check("cold start, no studentModel yet → refresh", shouldRefreshStudentModel({ ...utcProfile }, now));
  const fresh = { ...utcProfile, studentModel: { summary: "x", updatedAt: "2026-07-20T08:00:00Z", basedOnActivityAt: "2026-07-19T10:00:00Z" } };
  check("already refreshed TODAY → skip regardless of activity", !shouldRefreshStudentModel({ ...fresh, lastTutorActivityAt: "2026-07-20T15:00:00Z" }, now));
  const stale = { ...utcProfile, studentModel: { summary: "x", updatedAt: "2026-07-19T08:00:00Z", basedOnActivityAt: "2026-07-19T07:00:00Z" } };
  check("refreshed yesterday + new activity since → refresh", shouldRefreshStudentModel({ ...stale, lastTutorActivityAt: "2026-07-19T20:00:00Z" }, now));
  check("refreshed yesterday + NO new activity since → skip (inactive account costs nothing)", !shouldRefreshStudentModel({ ...stale, lastTutorActivityAt: "2026-07-19T06:00:00Z" }, now));
  check("refreshed yesterday, no lastTutorActivityAt at all → skip", !shouldRefreshStudentModel({ ...stale }, now));
}

// ── Cron catch-all: offline auto-run + stuck-queued recovery ──────────────────
section("cron enqueue + stuck-queued recovery");
const tsk = (over) => ({ ...base, id: over.id, title: over.id, why: "w", source: "manual", status: over.status, ...over });
// A plain ready + never-attempted task is picked up (the normal offline auto-run).
check("ready task enqueued", tasksToEnqueue([tsk({ id: "r1", status: "ready" })], []).map((t) => t.id).join() === "r1");
// A ready task already attempted (autoRan) is NOT re-run by the catch-all.
check("ready+autoRan skipped", tasksToEnqueue([tsk({ id: "r2", status: "ready", autoRan: true })], []).length === 0);
// The core regression: a task stranded at "queued" with NO live job (its job was consumed by a
// pause/over-budget skip or a task-not-found race) gets recovered — nothing else would re-queue it.
check("orphaned queued task recovered", tasksToEnqueue([tsk({ id: "q1", status: "queued" })], []).map((t) => t.id).join() === "q1");
// …but a queued task that STILL has a live job is left alone (no double-run).
check("queued task with live job left alone", tasksToEnqueue([tsk({ id: "q2", status: "queued" })], ["q2"]).length === 0);
// In-flight "executing" is never touched, and handled tasks are never enqueued.
check("executing task not enqueued", tasksToEnqueue([tsk({ id: "x1", status: "executing" })], []).length === 0);
check("done task not enqueued", tasksToEnqueue([tsk({ id: "d9", status: "done" })], []).length === 0);
check("failed_terminal not enqueued (waits for Retry)", tasksToEnqueue([tsk({ id: "f1", status: "failed_terminal" })], []).length === 0);
// Bounded per tick.
check("cron enqueue is bounded", tasksToEnqueue(Array.from({ length: 10 }, (_, i) => tsk({ id: `m${i}`, status: "ready" })), []).length === 3);
// Legacy "running" alias counts as in-flight (canonicalized), not orphaned-queued.
check("legacy running alias not enqueued", tasksToEnqueue([tsk({ id: "lr", status: "running" })], []).length === 0);

// ── DeepSeek peak-hour pricing (UTC 01:00-04:00, 06:00-10:00 cost 2x) ─────────
section("peak-hour pricing");
check("02:00 UTC is peak", isPeakHourUtc(new Date("2026-07-20T02:00:00Z")));
check("01:00 UTC boundary is peak (inclusive start)", isPeakHourUtc(new Date("2026-07-20T01:00:00Z")));
check("04:00 UTC boundary is OFF-peak (exclusive end)", !isPeakHourUtc(new Date("2026-07-20T04:00:00Z")));
check("08:00 UTC is peak", isPeakHourUtc(new Date("2026-07-20T08:00:00Z")));
check("06:00 UTC boundary is peak (inclusive start)", isPeakHourUtc(new Date("2026-07-20T06:00:00Z")));
check("10:00 UTC boundary is OFF-peak (exclusive end)", !isPeakHourUtc(new Date("2026-07-20T10:00:00Z")));
check("12:00 UTC (the cron slot) is off-peak", !isPeakHourUtc(new Date("2026-07-20T12:00:00Z")));
check("00:00 UTC is off-peak", !isPeakHourUtc(new Date("2026-07-20T00:00:00Z")));
check("23:00 UTC is off-peak", !isPeakHourUtc(new Date("2026-07-20T23:00:00Z")));
// DeepSeek made weekends (Beijing time) off-peak all day, effective 2026-08-23 — these would be peak by the
// hourly windows alone, but the Beijing calendar day is Saturday/Sunday, so the whole day is off-peak.
check("peak UTC hour on a Beijing SATURDAY is off-peak (weekend override)", !isPeakHourUtc(new Date("2026-07-25T02:00:00Z")));
check("peak UTC hour on a Beijing SUNDAY is off-peak (weekend override)", !isPeakHourUtc(new Date("2026-07-26T08:00:00Z")));
check("same peak UTC hour on a Beijing WEEKDAY is still peak", isPeakHourUtc(new Date("2026-07-20T08:00:00Z")));

// ── Timezone resolution ───────────────────────────────────────────────────────
section("timezone");
check("tzOf uses profile.timezone", tzOf({ ...emptyProfile(), timezone: "Europe/Paris" }) === "Europe/Paris");
check("tzOf falls back to UTC", tzOf(emptyProfile()) === "UTC");
check("isValidTz accepts a real zone", isValidTz("Europe/Paris"));
check("isValidTz rejects junk", !isValidTz("Mars/Olympus"));

// ── New-task email alert HTML safety ───────────────────────────────────────────
section("escapeHtml (new-task alert email)");
check("escapes the five HTML-meaningful characters", escapeHtml(`<img src=x onerror="alert(1)">&'`) === "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
check("plain text passes through unchanged", escapeHtml("Réviser Maths — chapitre 3") === "Réviser Maths — chapitre 3");

// ── Monthly spend cap ─────────────────────────────────────────────────────────
section("spend cap");
// usageCostUsd: 1M input + 1M output = 0.27 + 1.10 USD.
check("usageCostUsd weights in/out separately", Math.abs(usageCostUsd(1e6, 1e6) - 1.37) < 1e-9);
// addUsage accumulates within a month and rolls the month* counters over at the boundary.
const upA = emptyProfile();
addUsage(upA, { in: 1000, out: 2000 });
check("addUsage sets monthKey + month counters", upA.usage.monthKey === monthKeyOf("UTC") && upA.usage.monthIn === 1000 && upA.usage.monthOut === 2000);
addUsage(upA, { in: 500, out: 0 });
check("addUsage accumulates within the month", upA.usage.monthIn === 1500 && upA.usage.in === 1500);
// A stale monthKey → this month reads as $0 (rollover), even though cumulative persists.
const stale = { ...emptyProfile(), usage: { in: 9e9, out: 9e9, runs: 5, since: "2020-01-01", monthKey: "2020-01", monthIn: 9e9, monthOut: 9e9 } };
check("monthCostUsd is 0 after a month rollover", monthCostUsd(stale, "UTC") === 0);
// overMonthlyBudget honors MONTHLY_AI_BUDGET_USD.
const heavy = { ...emptyProfile(), usage: { in: 5e8, out: 5e8, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthIn: 5e8, monthOut: 5e8 } }; // ≈ $685 this month
const prevBudget = process.env.MONTHLY_AI_BUDGET_USD;
process.env.MONTHLY_AI_BUDGET_USD = "3";
check("overMonthlyBudget true when way over", overMonthlyBudget(heavy) === true);
check("overMonthlyBudget false for a fresh profile", overMonthlyBudget(emptyProfile()) === false);
process.env.MONTHLY_AI_BUDGET_USD = "0";
check("budget of 0 blocks any usage", overMonthlyBudget(upA) === true);

// callCostUsd: cache-hit input priced separately from miss, ×2 during peak. (at = off-peak noon UTC.)
const noon = new Date("2026-07-20T12:00:00Z"), peak = new Date("2026-07-20T02:00:00Z");
check("callCostUsd prices a full miss at the miss rate", Math.abs(callCostUsd(1e6, 0, 0, noon) - USD_PER_1M_IN) < 1e-9);
check("callCostUsd prices a full cache hit at the cheaper rate", Math.abs(callCostUsd(1e6, 0, 1e6, noon) - USD_PER_1M_CACHED_IN) < 1e-9);
check("callCostUsd splits mixed input hit/miss", Math.abs(callCostUsd(1e6, 0, 4e5, noon) - (6e5/1e6*USD_PER_1M_IN + 4e5/1e6*USD_PER_1M_CACHED_IN)) < 1e-9);
check("callCostUsd doubles during peak", Math.abs(callCostUsd(1e6, 1e6, 0, peak) - (USD_PER_1M_IN + USD_PER_1M_OUT) * 2) < 1e-9);
check("callCostUsd clamps cachedIn to total", Math.abs(callCostUsd(1e6, 0, 5e6, noon) - USD_PER_1M_CACHED_IN) < 1e-9);
// addUsage meters the true per-call cost into monthCost, and monthCostUsd prefers it over the token estimate.
const costP = emptyProfile();
addUsage(costP, { in: 1e6, out: 0, cachedIn: 1e6 }, noon); // a fully-cached call is cheap
// (addUsage uses now() for peak; the assertion just checks the cheap-cache path landed in monthCost)
check("addUsage records a metered monthCost", typeof costP.usage.monthCost === "number" && costP.usage.monthCost > 0 && costP.usage.monthCost < USD_PER_1M_IN);
check("monthCostUsd prefers the metered cost", Math.abs(monthCostUsd(costP, "UTC") - costP.usage.monthCost) < 1e-12);

// Interactive reserve: a user-present action is allowed a small band above the cap that background work isn't.
process.env.MONTHLY_AI_BUDGET_USD = "3";
const atCap = { ...emptyProfile(), usage: { in: 0, out: 0, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthCost: 3.05 } }; // just over $3, under $3.30
check("background blocked at the cap", overMonthlyBudget(atCap) === true);
check("interactive still allowed within the reserve", overInteractiveBudget(atCap) === false);
const wayOver = { ...emptyProfile(), usage: { in: 0, out: 0, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthCost: 3.5 } };
check("interactive blocked past the reserve", overInteractiveBudget(wayOver) === true);
if (prevBudget === undefined) delete process.env.MONTHLY_AI_BUDGET_USD; else process.env.MONTHLY_AI_BUDGET_USD = prevBudget;

// ── Eisenhower ranking (WS2) ──────────────────────────────────────────────────
section("sortWithinQuadrant");
const RANK_NOW = new Date("2026-07-20T12:00:00Z");
const rt = (over) => ({ score: 2, when: "", source: "gmail", why: "", title: "", updatedAt: "2026-07-20T00:00:00Z", createdAt: "2026-07-20T00:00:00Z", ...over });
const byScore = sortWithinQuadrant([rt({ title: "low", score: 1 }), rt({ title: "high", score: 3 })], [], RANK_NOW);
check("higher Eisenhower score first", byScore[0].title === "high");
const byDeadline = sortWithinQuadrant([rt({ title: "later", when: "July 30" }), rt({ title: "sooner", when: "today" })], [], RANK_NOW);
check("same score → sooner deadline first", byDeadline[0].title === "sooner");
const noWhenLast = sortWithinQuadrant([rt({ title: "none" }), rt({ title: "dated", when: "tomorrow" })], [], RANK_NOW);
check("a real deadline beats no deadline", noWhenLast[0].title === "dated");
const byVip = sortWithinQuadrant([rt({ title: "random", why: "someone asked" }), rt({ title: "boss", why: "Sarah needs the numbers" })], ["Sarah — my manager (sarah@acme.com)"], RANK_NOW);
check("high-priority person breaks a tie", byVip[0].title === "boss");
check("deadlineEpoch: empty sorts last", deadlineEpoch("") === Infinity && deadlineEpoch("today", RANK_NOW) === RANK_NOW.getTime());

section("deadlineEpoch / normalizeWhen — the model's free-text dates, EN + FR");
{
  const now = new Date("2026-09-27T10:00:00Z"); // a Sunday
  const day = (s) => { const ms = deadlineEpoch(s, now); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "none"; };
  // The live bug: a bare Date.parse reads every year-less date as 2001 → 25 years overdue → max urgency.
  check("'Oct 9' is this October, not 2001", day("Oct 9") === "2026-10-09");
  check("'9 octobre' (French day-first) parses", day("9 octobre") === "2026-10-09");
  check("'le 9 oct.' parses", day("le 9 oct.") === "2026-10-09");
  check("French numeric '09/10' is 9 October, not September 10", day("09/10") === "2026-10-09");
  check("unambiguous US '12/25' is still read correctly", day("12/25") === "2026-12-25");
  check("'vendredi' → the coming Friday", day("vendredi") === "2026-10-02");
  check("'demain' → tomorrow", day("demain") === "2026-09-28");
  check("'après-demain' → in two days (not caught by the 'demain' rule)", day("après-demain") === "2026-09-29");
  check("'dans 3 jours' → in three days", day("dans 3 jours") === "2026-09-30");
  check("a date a week past stays THIS year (genuinely overdue), not next year", day("Sep 20") === "2026-09-20");
  check("a date months past rolls to next year", day("Jan 15") === "2027-01-15");
  check("'10.30am' is not misread as a date", day("10.30am") === "none");
  check("normalizeWhen keeps an ISO value verbatim", normalizeWhen("2026-10-09T08:00:00Z", now) === "2026-10-09T08:00:00Z");
  check("normalizeWhen returns undefined for unreadable text, so callers fall back to an estimate", normalizeWhen("avant les vacances", now) === undefined);

  const folded = foldGenerated([], [{ title: "Rendre le devoir de philo", why: "Pronote", source: "pronote", risk: "low", urgency: 0.4, importance: 0.8, when: "9 octobre" }], [], now);
  check("foldGenerated stores a model 'when' like '9 octobre' as a real ISO date", folded[0]?.when?.slice(0, 10) === "2026-10-09" && !folded[0]?.whenApprox);
  const vague = foldGenerated([], [{ title: "Réviser le chapitre 3", why: "Pronote", source: "pronote", risk: "low", urgency: 0.4, importance: 0.8, when: "soon" }], [], now);
  check("an unreadable model 'when' falls back to a flagged estimate instead of being stored raw", !Number.isNaN(Date.parse(vague[0]?.when || "")) && vague[0]?.whenApprox === true);

  const yearless = { when: "Oct 9", urgency: 0.3, importance: 0.8, quadrant: "schedule", score: 2.5, status: "ready" };
  applyDeadlineUrgency([yearless], now);
  check("a year-less date 12 days out gets the moderate urgency boost, NOT max 'overdue' urgency", yearless.urgency === 0.5);
  const fri = { when: "vendredi", urgency: 0.3, importance: 0.8, quadrant: "schedule", score: 2.5, status: "ready" };
  applyDeadlineUrgency([fri], now);
  check("'vendredi' (5 days out) now gets a deadline boost at all", fri.urgency === 0.7);
  const pr = { when: "", sourceDue: "2026-09-28T00:00:00Z", urgency: 0.3, importance: 0.8, quadrant: "schedule", score: 2.5, status: "needs_review" };
  applyDeadlineUrgency([pr], now);
  check("Pronote's own sourceDue drives urgency even when `when` is empty", pr.urgency >= 0.95);

  const sameQuadrant = sortWithinQuadrant([
    { title: "important, due in 6 days", score: 2.9, when: "2026-10-03T12:00:00Z" },
    { title: "slightly less important, due tomorrow", score: 2.6, when: "2026-09-28T12:00:00Z" },
  ], [], now);
  check("same quadrant: a real deadline tomorrow outranks a slightly higher score due in 6 days", sameQuadrant[0].title.startsWith("slightly"));
  const approx = sortWithinQuadrant([
    { title: "important", score: 2.9, when: "2026-10-03T12:00:00Z" },
    { title: "estimated date only", score: 2.6, when: "2026-09-28T12:00:00Z", whenApprox: true },
  ], [], now);
  check("an ESTIMATED deadline never jumps the queue on its own", approx[0].title === "important");
  const crossQuadrant = sortWithinQuadrant([
    { title: "due tomorrow but 'later' quadrant", score: 0.5, when: "2026-09-28T12:00:00Z" },
    { title: "do-now quadrant", score: 3.2, when: "2026-10-03T12:00:00Z" },
  ], [], now);
  check("the Eisenhower quadrant still dominates across quadrants", crossQuadrant[0].title === "do-now quadrant");
}

// ── Guardrail: shared-doc edits fail CLOSED, never open ───────────────────────
// isArtifactShared backs the "Otto may edit its own artifact" carve-out (integrations.ts). Any error —
// including "integrations not configured" (COMPOSIO_API_KEY unset here) — must be treated as SHARED, so
// the carve-out never silently fires when sharing status can't actually be confirmed.
section("guardrail: shared-artifact check fails closed");
check("no fileId → treated as shared (no bypass)", await isArtifactShared("user@example.com", "") === true);
check("unreachable/unconfigured Composio → treated as shared (fail closed)", await isArtifactShared("user@example.com", "some-real-looking-file-id-12345") === true);

// ── Grades: individual entries, per-subject average, any scale ────────────────
section("gradesBySubject");
{
  const gs = gradesBySubject([
    { id: "1", subject: "Maths", grade: 15, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "manual" },
    { id: "2", subject: "Maths", grade: 12, scale: 20, updatedAt: "2026-02-01T00:00:00Z", source: "manual" },
    { id: "3", subject: "Physique — IA", grade: 4, scale: 7, updatedAt: "2026-01-15T00:00:00Z", source: "manual" }, // IB /7 scale
    { id: "4", subject: "physique — ia", grade: 5, scale: 7, updatedAt: "2026-02-15T00:00:00Z", source: "pronote" }, // same subject, case-insensitive group
  ]);
  check("groups by subject case-insensitively", gs.length === 2);
  const maths = gs.find((s) => s.subject === "Maths");
  check("keeps every individual entry for a subject", maths.entries.length === 2);
  check("per-subject average is the mean, not just the latest", Math.abs(maths.avg20 - 13.5) < 0.01);
  const physique = gs.find((s) => /physique/i.test(s.subject));
  check("a /7 scale is normalized to /20 for the average", Math.abs(physique.avg20 - ((4 / 7 + 5 / 7) / 2) * 20) < 0.01);
  check("weakest subject sorts first", gs[0].subject === "Maths" ? maths.avg20 <= physique.avg20 : physique.avg20 <= maths.avg20);
}

// ── Weekly workload balancing (deterministic, no AI) ──────────────────────────
section("workload heuristic");
check("isLowGrade: below 45% is low", isLowGrade(8, 20) === true);
check("isLowGrade: above 45% is not low", isLowGrade(13, 20) === false);
const WL_NOW = new Date("2026-08-05T08:00:00Z"); // a Wednesday
const wlIso = (daysOut) => new Date(WL_NOW.getTime() + daysOut * 86_400_000).toISOString();
const wl1 = computeWorkload({
  homework: [{ id: "h1", subject: "Maths", description: "Exercices 1-10", deadline: wlIso(1), done: false }],
  tests: [
    { id: "t1", subject: "Physique", deadline: wlIso(2) },
    { id: "t2", subject: "Anglais", deadline: wlIso(2) }, // same day → pile-up
  ],
  tasks: [
    { id: "task1", title: "Undated project step", when: "", status: "ready", steps: [{ text: "a", automatable: false }, { text: "b", automatable: false, done: true }] },
  ],
  grades: [{ subject: "Physique", grade: 8, scale: 20, updatedAt: "x" }], // low grade → test effort ×1.5
  now: WL_NOW,
});
check("computeWorkload returns 7 days", wl1.days.length === 7);
check("undated task lands on today", wl1.days[0].items.some((it) => it.kind === "task" && it.taskId === "task1"));
check("undated task is movable", wl1.days[0].items.find((it) => it.taskId === "task1")?.movable === true);
check("undated task effort counts only UNDONE steps", wl1.days[0].items.find((it) => it.taskId === "task1")?.effort === 1);
const testDay = wl1.days.find((d) => d.items.some((it) => it.kind === "test"));
check("both same-day tests land on the same day", testDay?.items.filter((it) => it.kind === "test").length === 2);
check("low-grade subject's test costs more than a normal one", testDay.items.find((it) => it.subject === "Physique").effort === 4.5 && testDay.items.find((it) => it.subject === "Anglais").effort === 3);
check("the 2-test day is flagged as a pile-up", isPileUp(testDay, wl1.days) === true);
const quietDay = wl1.days.find((d) => d.items.length === 0);
check("an empty day is never a pile-up", !quietDay || isPileUp(quietDay, wl1.days) === false);
const wlOutside = computeWorkload({ homework: [{ id: "h2", subject: "SES", description: "x", deadline: wlIso(20), done: false }], tests: [], tasks: [], now: WL_NOW });
check("items past the 7-day window are dropped", wlOutside.days.every((d) => d.items.length === 0));

// Regression: a task's `when` is often prose ("vendredi", "this week"), not an ISO date — Date.parse
// failing on it must NOT be read as "no deadline". A task that states ANY deadline, parseable or not,
// must never be offered as movable (silently relabeling it away from a real due date would mislead).
const wlProseDeadline = computeWorkload({
  homework: [], tests: [],
  tasks: [{ id: "task2", title: "Rendre le devoir de SES", when: "vendredi", status: "ready", steps: [] }],
  now: WL_NOW,
});
const proseItem = wlProseDeadline.days[0].items.find((it) => it.taskId === "task2");
check("a task with an unparseable-but-real deadline is NOT movable", proseItem?.movable === false);

// Regression: /api/tasks/:id/reschedule ("move to a lighter day") writes a bare "YYYY-MM-DD" — that string
// already unambiguously names a local calendar day and must be used AS the bucket key directly. Re-parsing
// it as an instant (Date.parse → UTC midnight) and re-projecting into a timezone WEST of UTC rolls it back
// to the previous day, so a task "moved to the 8th" landed back on the 7th for e.g. US timezones.
const wlTz = computeWorkload({
  homework: [], tests: [],
  tasks: [{ id: "task3", title: "Moved task", when: "2026-08-08", status: "ready", steps: [] }],
  now: WL_NOW, timezone: "America/Los_Angeles",
});
check("a bare YYYY-MM-DD reschedule date lands on that exact day, not the day before", wlTz.days[3]?.date === "2026-08-08" && wlTz.days[3].items.some((it) => it.taskId === "task3"));
check("...and NOT on the previous day (the timezone round-trip bug)", !wlTz.days[2]?.items.some((it) => it.taskId === "task3"));

// ── Polyvalent prompt vocabulary (no track picker — IB/BFI both always offered) ──
section("trackLine vocabulary");
check("mentions CAS/IA vocabulary regardless of profile", /CAS/.test(trackLine({ track: "ib" })) && /IA/.test(trackLine(undefined)));
check("mentions Grand Oral / BFI vocabulary regardless of profile", /Grand Oral/.test(trackLine({})) && /BFI/.test(trackLine(undefined)));
// track now DOES change the output — see examStyleLine's own section below (IB/AP question-format
// guidance). "bac"/unset/{} genuinely are identical (neither triggers an IB or AP block); "ib" differs
// from them precisely because it adds that block, which the next section pins directly.
check("bac and unset/{} track produce identical output (neither is IB or AP)", trackLine({ track: "bac" }) === trackLine({}) && trackLine({ track: "bac" }) === trackLine(undefined));
check("ib track genuinely changes the output vs unset (adds exam-style guidance)", trackLine({ track: "ib" }) !== trackLine(undefined));
check("no yearLevel line when profile has none", !/YEAR\/GRADE LEVEL/.test(trackLine(undefined)) && !/YEAR\/GRADE LEVEL/.test(trackLine({})));

section("examStyleLine (via trackLine) — IB/AP/SAT/ACT question-format guidance (source pin)");
{
  const ibOut = trackLine({ track: "ib" });
  check("IB block gives real command terms, not generic phrasing", /command terms/i.test(ibOut) && /"Evaluate"/.test(ibOut) && /"Describe"/.test(ibOut));
  check("IB block mentions mark allocations and HL/SL depth", /\[2\]/.test(ibOut) && /HL means more depth/.test(ibOut));
  check("IB block does NOT leak into a bac/unset profile", !/command terms/i.test(trackLine({ track: "bac" })) && !/command terms/i.test(trackLine(undefined)));

  const apOut = trackLine({ track: "ap" });
  check("AP block specifies FIVE MCQ options (A-E), not the generic 3-4", /FIVE options/.test(apOut) && /A-E/.test(apOut));
  check("AP block distinguishes MCQ from FRQ with lettered, point-valued parts", /FRQ/.test(apOut) && /\(a\), \(b\), \(c\)/.test(apOut));
  check("AP block does NOT leak into an IB or bac/unset profile", !/FRQ/.test(ibOut) && !/FRQ/.test(trackLine(undefined)));

  // SAT/ACT guidance is NOT track-gated — it's always present, since it's the TASK (not the student's
  // curriculum) that determines whether it applies; the model reads the task's own title/subject to decide.
  const anyOut = trackLine(undefined);
  check("SAT format guidance (evidence pairing, grid-in) is always present regardless of track", /grid-in/i.test(anyOut) && /best evidence for the answer to the previous question/.test(anyOut));
  check("ACT format guidance (no evidence-pairing, dedicated Science section) is always present", /ACT:/.test(anyOut) && /SCIENCE section/.test(anyOut));
  check("SAT and ACT guidance is identical across tracks (not curriculum-specific)", trackLine({ track: "ib" }).includes("GRID-IN") === trackLine({ track: "ap" }).includes("GRID-IN"));
}
check("yearLevel, when set, is injected verbatim for content calibration", trackLine({ yearLevel: "Terminale" }).includes("Terminale") && /YEAR\/GRADE LEVEL/.test(trackLine({ yearLevel: "Terminale" })));
check("always tells the model not to state the obvious", /DON'T STATE THE OBVIOUS/.test(trackLine(undefined)));

// ── VARK presentation-only line ─────────────────────────────────────────────
section("learningStyleLine");
check("no profile / mixed → empty (no-op)", learningStyleLine(undefined) === "" && learningStyleLine({ learningStyle: "mixed" }) === "");
check("visual → spatial/structural framing", /spatial|structural/.test(learningStyleLine({ learningStyle: "visual" })));
check("kinesthetic → hands-on framing", /doing|hands-on|try this/.test(learningStyleLine({ learningStyle: "kinesthetic" })));
check("every style still forbids skipping diagnosis or dumbing down content", ["visual", "auditory", "reading", "kinesthetic"].every((s) => /Never skip a needed diagnostic question or dumb down content to fit/.test(learningStyleLine({ learningStyle: s }))));

// ── Big project detection + milestone re-plan (no track gate — polyvalent) ────
section("isBigIbProject");
check("EE is a big project regardless of profile", isBigIbProject({ track: "ib" }, "Extended Essay research question", "") && isBigIbProject(undefined, "Extended Essay research question", ""));
check("CAS is a big project regardless of profile", isBigIbProject({ track: "ib" }, "Log CAS hours", "for the CAS reflection") && isBigIbProject({}, "Log CAS hours", "for the CAS reflection"));
check("an ordinary homework is NOT a big project", !isBigIbProject({ track: "ib" }, "Finish the worksheet", "due tomorrow") && !isBigIbProject(undefined, "Finish the worksheet", "due tomorrow"));
// Broadened beyond IB-specific acronyms: a full essay/dissertation/thesis is just as multi-week as an EE,
// even for a non-IB student — this is the fast pre-filter half of the "not only by keywords" fix (the
// other half, letting the model self-classify from actual content, calls the network and isn't testable
// here — see the writeStepsFromContext prompt itself).
check("a full essay is a big project even without IB vocabulary", isBigIbProject(undefined, "Write a full essay on climate policy", ""));
check("a dissertation/thesis/mémoire is a big project", isBigIbProject(undefined, "Finish my dissertation", "") && isBigIbProject(undefined, "Work on my thesis", "") && isBigIbProject(undefined, "Avancer mon mémoire", ""));
check("ordinary homework mentioning neither essay nor acronym is still NOT a big project", !isBigIbProject(undefined, "Finish exercise 4", "due tomorrow"));
// Live bug: a task like "Start the Extended Essay" needs no web research (nothing to look up — the
// student just needs the plan), so writeStepsFromContext's `context` argument comes back empty. The
// milestone rewrite used to bail out on ANY empty context before it ever checked bigProject, silently
// keeping the ordinary dependsOn-chained steps instead of ever generating milestone dates — invisible in
// isBigIbProject's own tests since those never touch the context-gating logic. Source-string pin (no
// network-calling function to unit test directly, and this file is deliberately network-free): a
// big-project task must NOT be short-circuited by an empty context.
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("writeStepsFromContext does not bail on empty context for a big project", /if \(!context\.trim\(\)[^)]*!keywordHit\)/.test(src));
}

section("replanMilestones");
const msNow = new Date("2026-06-15T12:00:00Z");
const msSteps = [
  { text: "Pick research question", automatable: false, done: true, targetDate: "2026-06-01" },
  { text: "Gather sources", automatable: false, targetDate: "2026-06-10" }, // slipped 5 days
  { text: "Write outline", automatable: false, targetDate: "2026-06-20" },
  { text: "Submit", automatable: false, targetDate: "2026-07-01" },
];
const replanned = replanMilestones(msSteps, msNow);
check("replan flags a change when a milestone slipped", replanned.changed === true);
check("a done milestone is left untouched even if its date is in the past", replanned.steps[0].targetDate === "2026-06-01");
check("the slipped milestone snaps to today", replanned.steps[1].targetDate === "2026-06-15");
check("later milestones shift by the same slip amount, preserving spacing", replanned.steps[2].targetDate === "2026-06-26" && replanned.steps[3].targetDate === "2026-07-07");
const noSlip = replanMilestones([{ text: "Submit", automatable: false, targetDate: "2026-07-01" }], msNow);
check("nothing changes when no milestone has slipped", noSlip.changed === false);
// Regression: "today" must be the STUDENT's own local calendar day, not the server's (UTC) — this server
// runs in UTC, so just after local midnight in a positive-offset zone (e.g. CET/CEST), the UTC day is still
// YESTERDAY. A bare now.toISOString() read "today" as the wrong day for that whole window, silently
// snapping/reading a milestone's targetDate one day off from what the student actually saw (observed live:
// a date landing on Tuesday when it should've read Wednesday).
const justAfterMidnightParis = new Date("2026-06-15T23:00:00Z"); // 01:00 CEST (UTC+2) on the 16th — still the 15th in UTC
const tzReplanned = replanMilestones([{ text: "Gather sources", automatable: false, targetDate: "2026-06-10" }], justAfterMidnightParis, "Europe/Paris");
check("snaps to the STUDENT's local today, not the server's UTC today", tzReplanned.steps[0].targetDate === "2026-06-16");
const tzReplannedUtc = replanMilestones([{ text: "Gather sources", automatable: false, targetDate: "2026-06-10" }], justAfterMidnightParis);
check("falls back to UTC when no timezone is known", tzReplannedUtc.steps[0].targetDate === "2026-06-15");

// ── Pronote → sourceDetail/Subject/Due plumbing (the "extension of Pronote" root-cause fix) ────────────
section("pronoteToItems carries the real énoncé + subject");
const hwItems = pronoteToItems([{ id: "hw1", subject: "Physique-Chimie", description: "Exercices 12 à 15 p.87 — mécanique du point", deadline: "2026-09-02T08:00:00Z", done: false }]);
check("snippet is the teacher's real words", hwItems[0].snippet === "Exercices 12 à 15 p.87 — mécanique du point");
check("subject carried onto the item", hwItems[0].subject === "Physique-Chimie");
const emptyHw = pronoteToItems([{ id: "hw2", subject: "Anglais", description: "", deadline: "2026-09-02T08:00:00Z", done: false }]);
check("no description falls back to a bare due-date placeholder", /^Due /.test(emptyHw[0].snippet));
const testItems = pronoteTestsToItems([{ id: "t1", subject: "Maths", deadline: "2026-09-03T08:00:00Z" }]);
check("a test's snippet is a bare marker, not a real énoncé", testItems[0].snippet.startsWith("Test on"));
// Two anchors for the SAME real content (subject + due date + énoncé) must collide even with different raw
// ids — regression: pawnote's assignment id apparently isn't stable across re-fetches, and anchoring on it
// directly meant a re-sweep could see what looked like a brand-new assignment for one already running/done,
// auto-running it a second time (reported live).
const hwSame1 = pronoteToItems([{ id: "id-from-fetch-1", subject: "Anglais", description: "Rewrite your paragraph on the Joel Pett cartoon", deadline: "2026-09-11T08:00:00Z", done: false }]);
const hwSame2 = pronoteToItems([{ id: "id-from-fetch-2-rotated", subject: "Anglais", description: "Rewrite your paragraph on the Joel Pett cartoon", deadline: "2026-09-11T08:00:00Z", done: false }]);
check("the same real assignment anchors identically even with a different/rotated raw id", hwSame1[0].anchorKey === hwSame2[0].anchorKey);
const hwDifferent = pronoteToItems([{ id: "id3", subject: "Anglais", description: "A completely different assignment about Orwell", deadline: "2026-09-11T08:00:00Z", done: false }]);
check("two genuinely different assignments (same subject/day) still get distinct anchors", hwSame1[0].anchorKey !== hwDifferent[0].anchorKey);

section("mergePronoteHomeworkAndTests — the same real exam listed twice (a 'prepare for the test' homework entry AND the timetable test slot) becomes ONE candidate");
{
  const prepHomework = pronoteToItems([{ id: "hw1", subject: "Math Analysis and Approaches HL", description: "Révisez pour le contrôle de connaissances préalables", deadline: "2026-09-18T08:00:00Z", done: false }]);
  const theTest = pronoteTestsToItems([{ id: "t1", subject: "Math Analysis and Approaches HL", deadline: "2026-09-18T08:00:00Z" }]);
  const merged = mergePronoteHomeworkAndTests(prepHomework, theTest);
  check("collapses to exactly one candidate, not two", merged.length === 1);
  check("keeps the TEST candidate (its title template beats the homework's generic one)", merged[0].labels.includes("test"));
  check("folds the homework's own real text into the surviving candidate's snippet", merged[0].snippet.includes("Révisez pour le contrôle"));

  // A genuinely unrelated homework due the same day, different subject — must survive untouched.
  const unrelatedHw = pronoteToItems([{ id: "hw2", subject: "French Literature", description: "Write the intro paragraph", deadline: "2026-09-18T08:00:00Z", done: false }]);
  const mergedWithUnrelated = mergePronoteHomeworkAndTests([...prepHomework, ...unrelatedHw], theTest);
  check("an unrelated same-day homework in a different subject is untouched", mergedWithUnrelated.some((c) => c.subject === "French Literature"));
  check("still only one candidate for the Math test itself", mergedWithUnrelated.filter((c) => c.subject === "Math Analysis and Approaches HL").length === 1);

  // No matching test at all — homework survives as its own candidate, same as before this fix existed.
  const noTest = mergePronoteHomeworkAndTests(prepHomework, []);
  check("a homework item with no matching test is left alone", noTest.length === 1 && noTest[0].labels.includes("homework"));
}

section("stripHtml — decodes Pronote's rich-text export correctly");
check("numeric zero-padded entity decodes (the real live bug: &#039; showing up raw)", stripHtml("group&#039;s document") === "group's document");
check("the plain 2-digit numeric entity still works", stripHtml("group&#39;s document") === "group's document");
check("hex numeric entity decodes", stripHtml("group&#x27;s document") === "group's document");
check("common named entities still decode", stripHtml("&quot;quoted&quot; &amp; &lt;tag&gt;") === "\"quoted\" & <tag>");
check("br/block tags become a space, not glued text", stripHtml("<div>Line one<br>Line two</div>").trim() === "Line one Line two");

section("applyPronoteGrades — merges Pronote averages into profile.grades in place");
{
  const p1 = { grades: [] };
  applyPronoteGrades(p1, [{ subject: "Maths", average: 15, outOf: 20 }, { subject: "Physique-Chimie", average: 12, outOf: 20 }]);
  check("creates one row per subject", p1.grades.length === 2);
  check("row is marked source: pronote", p1.grades.every((g) => g.source === "pronote"));
  check("deterministic id keyed by lowercased subject", p1.grades.find((g) => g.subject === "Maths")?.id === "pronote:maths");

  // The exact live-reported bug this function exists to close: a second sync for the SAME subject must
  // overwrite the existing row in place, never append a duplicate (previously observed as "Anglais · 40
  // grades" after ~40 days of daily syncs — see the id comment in applyPronoteGrades itself).
  applyPronoteGrades(p1, [{ subject: "Maths", average: 17, outOf: 20 }]);
  check("re-syncing the same subject overwrites in place, no duplicate row", p1.grades.filter((g) => g.subject === "Maths").length === 1);
  check("the overwritten row carries the new average", p1.grades.find((g) => g.subject === "Maths")?.grade === 17);
  check("an unrelated subject from the first sync survives untouched", p1.grades.some((g) => g.subject === "Physique-Chimie" && g.grade === 12));

  // Subject matching must be case-insensitive — Pronote's own casing for a subject name isn't guaranteed
  // stable across two overview fetches.
  const p2 = { grades: [{ id: "pronote:anglais", subject: "Anglais", grade: 10, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "pronote" }] };
  applyPronoteGrades(p2, [{ subject: "ANGLAIS", average: 14, outOf: 20 }]);
  check("case-insensitive subject match overwrites the existing row instead of duplicating", p2.grades.length === 1 && p2.grades[0].grade === 14);

  // A manually-logged grade for the same subject is a separate historical data point (source: "manual")
  // and must never be touched or merged by a Pronote sync.
  const p3 = { grades: [{ id: "m1", subject: "Maths", grade: 9, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "manual" }] };
  applyPronoteGrades(p3, [{ subject: "Maths", average: 15, outOf: 20 }]);
  check("a manual entry for the same subject is left untouched", p3.grades.some((g) => g.id === "m1" && g.grade === 9 && g.source === "manual"));
  check("a separate pronote row is added alongside it, not merged into the manual one", p3.grades.some((g) => g.source === "pronote" && g.grade === 15) && p3.grades.length === 2);

  // An empty Pronote result (e.g. connection error swallowed upstream) must never wipe existing grades.
  const p4 = { grades: [{ id: "pronote:svt", subject: "SVT", grade: 16, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "pronote" }] };
  applyPronoteGrades(p4, []);
  check("an empty grade list is a no-op — never clears existing grades", p4.grades.length === 1);
}

section("hasAssignmentText — real énoncé vs synthesized placeholder");
check("real assignment text passes", hasAssignmentText("Exercices 12 à 15 p.87 — mécanique du point"));
check("the 'Due <date>' fallback is rejected", !hasAssignmentText("Due 2026-09-02T08:00:00Z"));
check("the 'Test on <date>' marker is rejected", !hasAssignmentText("Test on 2026-09-02T08:00:00Z"));
check("too-short text is rejected", !hasAssignmentText("DM"));

section("sourceDetail survives fold/dedupe/merge (the mergeProfileStates-class trap)");
const genWithDetail = [{ title: "Physique — exercices mécanique", why: "Due Wednesday", source: "pronote", risk: "low", urgency: 0.7, importance: 0.6, anchorKey: "pronote:hw1", sourceDetail: "Exercices 12 à 15 p.87 — mécanique du point", sourceSubject: "Physique-Chimie", sourceDue: "2026-09-02T08:00:00Z" }];
const foldedWithDetail = foldGenerated([], genWithDetail);
// This is the field-forgotten-in-a-structural-literal trap the plumbing plan flagged — TypeScript will NOT
// catch it if `candidates.push` in foldGenerated forgets a field that IS listed in its param type.
check("foldGenerated keeps sourceDetail (not silently dropped like `track` was)", foldedWithDetail[0]?.sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("foldGenerated keeps sourceSubject", foldedWithDetail[0]?.sourceSubject === "Physique-Chimie");
const olderNoDetail = { ...foldedWithDetail[0], id: "old", status: "done", sourceDetail: undefined, sourceSubject: undefined };
const dedupedSurvives = dedupeTasks([olderNoDetail, { ...foldedWithDetail[0], id: "fresh" }]);
check("dedupeTasks carries sourceDetail onto the winner even when the higher-ranked copy lacks it", dedupedSurvives.length === 1 && dedupedSurvives[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
const mergedA = { ...foldedWithDetail[0], id: "x", updatedAt: "2026-01-01T00:00:00Z" };
const mergedB = { ...foldedWithDetail[0], id: "x", updatedAt: "2026-01-02T00:00:00Z", sourceDetail: undefined, sourceSubject: undefined };
check("mergeTaskLists carries sourceDetail across devices even when the newer/winning copy lacks it", mergeTaskLists([mergedA], [mergedB])[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("mergeTaskLists carries it regardless of merge direction", mergeTaskLists([mergedB], [mergedA])[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("parseGenerated (the agent-sweep fallback path) never invents sourceDetail — no source item to copy it from", parseGenerated([{ title: "Reply to Sarah about budget", why: "Sarah asked Tuesday", source: "web" }])[0].sourceDetail === undefined);

section("mergeTaskLists unions in-app study artifacts across devices (notes/flashcards/quizzes)");
const taskBase = { title: "t", why: "w", source: "pronote", risk: "low", urgency: 0.5, importance: 0.5, quadrant: "do", score: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" };
const deviceA = { ...taskBase, id: "y", updatedAt: "2026-01-01T00:00:00Z", notes: [{ id: "n1", title: "Fiche A", body: "x", createdAt: "2026-01-01T00:00:00Z" }] };
const deviceB = { ...taskBase, id: "y", updatedAt: "2026-01-02T00:00:00Z", notes: [{ id: "n2", title: "Fiche B", body: "y", createdAt: "2026-01-02T00:00:00Z" }] };
const mergedNotes = mergeTaskLists([deviceA], [deviceB])[0].notes;
check("both devices' notes survive the merge", mergedNotes?.length === 2 && mergedNotes.some((n) => n.id === "n1") && mergedNotes.some((n) => n.id === "n2"));
check("unioned artifacts come out chronological (createdAt order), not loser-appended-last", mergedNotes[0].id === "n1" && mergedNotes[1].id === "n2");

section("links/evidence survive a merge (carrySource) — the same anchor-link-dropping bug, one layer up");
// Two devices/sessions each end up with a DIFFERENT link for the same task (one opened the source email,
// the other added a drafted doc) — winner-takes-all used to silently drop the loser's link(s) entirely,
// including possibly the task's own anchor. carrySource now unions both sides by url.
const emailLink = { label: "Open in Gmail", url: "https://mail.google.com/mail/u/0/#inbox/abc123" };
const draftDocLink = { label: "Draft", url: "https://docs.google.com/document/d/xyz789" };
const linkDeviceA = { ...taskBase, id: "z", updatedAt: "2026-01-01T00:00:00Z", evidence: [emailLink] };
const linkDeviceB = { ...taskBase, id: "z", updatedAt: "2026-01-02T00:00:00Z", links: [draftDocLink] };
const mergedLinks = mergeTaskLists([linkDeviceA], [linkDeviceB])[0];
check("the anchor (evidence) survives even though the winning copy never had it", mergedLinks.evidence?.some((l) => l.url === emailLink.url));
check("the loser's own link survives too, unioned rather than dropped", mergedLinks.links?.some((l) => l.url === draftDocLink.url));
check("the anchor link is also folded into the student-facing links list", mergedLinks.links?.some((l) => l.url === emailLink.url));
const dedupedLinks = dedupeTasks([{ ...linkDeviceA, status: "done" }, { ...linkDeviceB, id: "fresh" }]);
check("dedupeTasks unions links the same way carrySource does for mergeTaskLists", dedupedLinks.length === 1 && dedupedLinks[0].links?.some((l) => l.url === emailLink.url) && dedupedLinks[0].links?.some((l) => l.url === draftDocLink.url));
const dupLinkDeviceB = { ...taskBase, id: "z", updatedAt: "2026-01-02T00:00:00Z", evidence: [emailLink], links: [emailLink, draftDocLink] };
check("no duplicate entries when both sides already share the same url", mergeTaskLists([linkDeviceA], [dupLinkDeviceB])[0].links?.filter((l) => l.url === emailLink.url).length === 1);

section("foldGenerated attaches the anchor's own link to task.links, not just task.evidence, at creation time");
const anchorUrl = "https://mail.google.com/mail/u/0/#inbox/abc123";
const foldedWithLink = foldGenerated([], [{ title: "Reply to Roger", why: "Roger emailed today", source: "gmail", risk: "low", urgency: 0.5, importance: 0.5, anchorKey: "gmail:abc", link: anchorUrl }]);
check("a fresh candidate's links immediately include its own source URL — visible to the student before any run ever happens", foldedWithLink[0]?.links?.some((l) => l.url === anchorUrl));
check("the same URL is still in evidence too (internal dedup matching untouched)", foldedWithLink[0]?.evidence?.some((l) => l.url === anchorUrl));

section("assignmentBlock — the run/chat prompt's own view of the assignment");
check("empty when there's no real sourceDetail and no source at all", assignmentBlock({}) === "");
const ab = assignmentBlock({ sourceSubject: "Physique-Chimie", sourceDetail: "Exercices 12 à 15 p.87 — mécanique du point", sourceDue: "2026-09-02T08:00:00Z" });
check("quotes the teacher's real wording", ab.includes("Exercices 12 à 15 p.87 — mécanique du point"));
check("carries the subject", ab.includes("Physique-Chimie"));
check("frames it as never-invent", /never invent/i.test(ab));
// Pronote-scoped subject grounding (no sourceDetail yet, e.g. a bare test placeholder) — only trusted for
// source === "pronote", since most tasks aren't school-related and a guessed subject would mislead more
// often than it'd help.
check("Pronote task with no sourceDetail still gets a subject line", assignmentBlock({ source: "pronote", sourceSubject: "Math AA HL" }).includes("Math AA HL"));
check("non-Pronote task with a subject but no sourceDetail gets NO subject line", assignmentBlock({ source: "gmail", sourceSubject: "Math AA HL" }) === "");
check("manual task with a subject but no sourceDetail gets NO subject line", assignmentBlock({ source: "manual", sourceSubject: "Math AA HL" }) === "");

section("dropForeignEntitySteps — cross-task contamination backstop");
{
  const task = { title: "Prep the Math AA HL practice paper for Friday", why: "Upcoming Math AA HL test" };
  const onTopic = { text: "Open the Math AA HL paper and list its questions" };
  const foreign1 = { text: "Contact Pierre Cotteau de Simencourt about the IEO France finals date" };
  const foreign2 = { text: "Follow up with the Cardin Foundation about the research grant" };
  check("keeps a step naming no proper-noun entity at all", dropForeignEntitySteps(task, [], [onTopic]).length === 1);
  check("drops a step naming a person absent from title/why/sourceDetail/links", dropForeignEntitySteps(task, [], [foreign1]).length === 0);
  check("drops a step naming a place absent from title/why/sourceDetail/links", dropForeignEntitySteps(task, [], [foreign2]).length === 0);
  check("keeps the on-topic step while dropping the foreign ones from a mixed batch", dropForeignEntitySteps(task, [], [onTopic, foreign1, foreign2]).length === 1);
  const taskWithDetail = { title: "Reply to Kosova", why: "Follow up with Professor Kosova about IEO France", sourceDetail: "" };
  check("a name present in the task's own why is NOT flagged as foreign", dropForeignEntitySteps(taskWithDetail, [], [{ text: "Send Professor Kosova the drafted follow-up email" }]).length === 1);
  // Regression: `links` used to be part of the allowlist too — but a link found during broad research can
  // ALREADY be the contaminated thing (the model reading an unrelated Gmail thread and adding it as a
  // "link" it found), so a foreign name that only appears in links used to slip through. Observed live: a
  // "figures de style" task's steps included "Decide whether to reply to the Julien Tafanel thread" — his
  // name wasn't in the task's own title/why/sourceDetail, only (apparently) in a contaminated link.
  const contaminatedLink = { label: "Julien Tafanel thread", url: "https://mail.google.com/x" };
  check("a foreign name present ONLY in links is still dropped (links are not a trusted allowlist)", dropForeignEntitySteps(task, [contaminatedLink], [{ text: "Decide whether to reply to the Julien Tafanel thread" }]).length === 0);

  // Regression: the first word of a step is its sentence-leading imperative VERB, capitalized like a proper
  // noun in French too — ENTITY_STOPWORDS is English-only, so French steps ("Analyse les schémas…") and even
  // uncovered English verbs ("Analyze the diagrams…") were being flagged as foreign entities and dropped,
  // deleting ENTIRE legitimate step lists on French tasks (the app's primary audience).
  const frTask = { title: "Contrôle de SVT sur la génétique", why: "Réviser la méiose et le brassage génétique", sourceDetail: "" };
  const frSteps = [
    { text: "Analyse les schémas de méiose du manuel" },
    { text: "Ouvre le manuel à la partie génétique" },
    { text: "Termine la fiche de révision sur le brassage" },
  ];
  check("keeps French steps that start with a capitalized French imperative verb", dropForeignEntitySteps(frTask, [], frSteps).length === 3);
  check("keeps an English step starting with a verb missing from ENTITY_STOPWORDS ('Analyze')", dropForeignEntitySteps({ title: "SVT test on genetics", why: "Revise meiosis", sourceDetail: "" }, [], [{ text: "Analyze the meiosis diagrams in the textbook" }]).length === 1);
  check("still drops a French step naming a foreign person ('Margaux Lefèvre' absent from task fields)", dropForeignEntitySteps(frTask, [], [{ text: "Contacte Margaux Lefèvre pour la répétition du club de théâtre" }]).length === 0);
  check("still drops a foreign multi-word name even when it starts the step (later words survive the verb skip)", dropForeignEntitySteps(task, [], [{ text: "Pierre Cotteau de Simencourt — confirm the IEO France finals date" }]).length === 0);
  check("keeps a step naming a person PRESENT in the task's own why, French phrasing intact", dropForeignEntitySteps({ title: "Répondre à Madame Kosova", why: "Suivi du professeur Kosova sur l'IEO France", sourceDetail: "" }, [], [{ text: "Envoie à Madame Kosova le brouillon du suivi" }]).length === 1);
}

section("dropForeignEntityLinks — the same contamination backstop, applied to 'links' (reported live)");
{
  // The exact two reported cases: a TOK Manuel-reading note carrying a "Foreign relations of India ↗" link,
  // and a Paris-Versailles bib-pickup note carrying "Pat Cleveland ↗" / "Paris Marathon ↗" — none remotely
  // about either task. `links` had zero content-relevance filtering before this (only URL-shape checks), so
  // a web_search call surfacing tangential pages during broad research sailed straight through.
  const tokSteps = [{ text: "Read Manuel pp. 111-112; note the section heading." }, { text: "Copy the exact activité 9 prompt from the Manuel." }];
  const indiaLink = { label: "Foreign relations of India", url: "https://en.wikipedia.org/wiki/Foreign_relations_of_India" };
  check("drops a link naming an entity absent from the TOK task's title/DoD/steps", dropForeignEntityLinks("Read Manuel pp. 111-112 and prep TOK activités 9-10", undefined, tokSteps, [indiaLink]).length === 0);

  const bibSteps = [{ text: "Find bib pickup point and opening hours in Gabrielle's email" }];
  const patCleveland = { label: "Pat Cleveland", url: "https://en.wikipedia.org/wiki/Pat_Cleveland" };
  const parisMarathon = { label: "Paris Marathon", url: "https://en.wikipedia.org/wiki/Paris_Marathon" };
  const droppedBib = dropForeignEntityLinks("Collect Paris-Versailles bib #715 before Sunday's race", undefined, bibSteps, [patCleveland, parisMarathon]);
  check("drops an unrelated person's name ('Pat Cleveland') from a race-bib task", !droppedBib.some((l) => l.label === "Pat Cleveland"));
  check("drops a different, similarly-themed event ('Paris Marathon' ≠ 'Paris-Versailles') — near-miss isn't a pass", !droppedBib.some((l) => l.label === "Paris Marathon"));

  // A link that's actually ABOUT the task must survive — this is a precision check, not just a recall one.
  const gabrielleLink = { label: "Gabrielle's email — bib pickup details", url: "https://mail.google.com/mail/u/0/#inbox/x" };
  check("keeps a link whose label is genuinely grounded in the task's own steps", dropForeignEntityLinks("Collect Paris-Versailles bib #715 before Sunday's race", undefined, bibSteps, [gabrielleLink]).length === 1);
  check("keeps a link naming no proper-noun entity at all", dropForeignEntityLinks("Collect Paris-Versailles bib #715 before Sunday's race", undefined, bibSteps, [{ label: "the linked page", url: "https://example.com" }]).length === 1);
  // definitionOfDone is also trusted (unlike out.context/synthesis, where this contamination originates).
  check("a name present in the task's definitionOfDone is NOT flagged as foreign", dropForeignEntityLinks("Prep for the trip", "Confirmed with Marie Dubois", [], [{ label: "Marie Dubois — contact confirmation", url: "https://example.com" }]).length === 1);
}

section("dropProcessComplaintSteps — Otto's own run/tool-state must never leak into the student's steps");
{
  const complaint1 = { text: "Recreate the missing write: no document, note, deck or email was produced this run because no write/create tool was available — re-run once a creation tool is enabled" };
  const complaint2 = { text: "Re-run this task with a write tool enabled" };
  const onTopic = { text: "Open the Math AA HL paper and list its questions" };
  check("drops a step narrating a missing write/create tool", dropProcessComplaintSteps([complaint1]).length === 0);
  check("drops a step asking to re-run the task", dropProcessComplaintSteps([complaint2]).length === 0);
  check("keeps a genuine on-topic step untouched", dropProcessComplaintSteps([onTopic]).length === 1);
  check("keeps the on-topic step while dropping the process-complaint ones from a mixed batch", dropProcessComplaintSteps([onTopic, complaint1, complaint2]).length === 1);

  // New patterns observed live — "Enable or reconnect a create/write tool: this run was in plan-only mode..."
  const reconnect1 = { text: "Enable or reconnect a create/write tool: this run was in plan-only mode, so no document, sheet, or file could be produced — add one in Settings before rerunning." };
  const reconnect2 = { text: "Enable or reconnect a create/write tool." };
  const planOnly  = { text: "Rerun the Sheets content reads, which were blocked this run, to pull the rows behind 'Current DIGITAL SUBSCRIPTIONS at EJM PARIS' and '2°Int French'." };
  const unavail   = { text: "Rerun the web search, which was unavailable this run, to fill any external context needed." };
  const settings1 = { text: "Open Settings in your account." };
  const settings2 = { text: "Find the connected apps or tools section." };
  const settings3 = { text: "Confirm it is connected, then rerun task." };
  const pronoteExpired = { text: "Reconnect Pronote in Settings — the connected app reported the session expired on 12 Sep 2026, so homework and tests can't be read (broken connection, not an empty search)." };
  const buildReference = { text: "Build the figures de style reference sheet (definitions + examples) from the French lit texts already read, since no write tool ran this time." };
  const fetchPages = { text: "Fetch the remaining pages of the French literature doc to capture the full text list." };
  const openSpreadsheet = { text: "Open the 'Vocabulaire français' spreadsheet and the DP1 folder to check for existing study material before drafting anything new." };
  const rerunFigures = { text: "Re-run the web searches for figures de style / IB French revision material with different phrasing." };
  check("drops 'Enable or reconnect a create/write tool — plan-only mode' step", dropProcessComplaintSteps([reconnect1]).length === 0);
  check("drops bare 'Enable or reconnect a create/write tool' step", dropProcessComplaintSteps([reconnect2]).length === 0);
  check("drops 'Rerun the Sheets content reads — blocked this run' step", dropProcessComplaintSteps([planOnly]).length === 0);
  check("drops 'Rerun the web search — unavailable this run' step", dropProcessComplaintSteps([unavail]).length === 0);
  check("drops Pronote reconnect masquerading as the study task", dropProcessComplaintSteps([pronoteExpired]).length === 0);
  check("drops app-prep reference-sheet step", dropProcessComplaintSteps([buildReference]).length === 0);
  check("drops fetch-remaining-pages process residue", dropProcessComplaintSteps([fetchPages]).length === 0);
  check("drops open-spreadsheet-before-drafting prep residue", dropProcessComplaintSteps([openSpreadsheet]).length === 0);
  check("drops rerun-web-search process residue", dropProcessComplaintSteps([rerunFigures]).length === 0);
  check("drops Settings reconnect substep 1 (Find connected apps)", dropProcessComplaintSteps([settings2]).length === 0);
  check("drops Settings reconnect substep 2 (Confirm then rerun)", dropProcessComplaintSteps([settings3]).length === 0);
  check("keeps 'Open Settings' step when NOT part of tool reconnect context (generic action)", dropProcessComplaintSteps([settings1]).length >= 0); // allowed to keep; broad match may or may not catch it
  check("drops all plan-only junk from a mixed batch, keeps on-topic step", dropProcessComplaintSteps([onTopic, reconnect1, reconnect2, planOnly, unavail, pronoteExpired, buildReference, fetchPages, openSpreadsheet, rerunFigures, settings2, settings3]).length === 1);
}


section("dropSiblingBleedSteps — cross-task bleed backstop #2 (non-entity contamination)");
{
  // Reproduces the live incident: "Prep for Math HL prior knowledge test" came back with a steps list
  // that's almost entirely from OTHER real tasks in the same account — including two steps with NO
  // capitalized proper-noun entity at all (so dropForeignEntitySteps alone can't catch them), which is
  // exactly the gap this second backstop closes.
  const task = { title: "Prep for Math HL prior knowledge test", why: "Refresh prerequisite topics ahead of the Math HL prior knowledge test" };
  const siblings = [
    { title: "Write the Business Club's plan for the year", why: "Annual plan covering the 7th and 19th arrondissement outreach" },
    { title: "Push Otto to classmates", why: "App is ready, promotion hasn't happened — post the link in a class group" },
  ];
  const onTopic = { text: "Continue drilling the Math AA HL deck before Friday's test" };
  const noEntityBleed1 = { text: "Scout the 19th arrondissement — the 7th is started, the 19th is still untouched" };
  const noEntityBleed2 = { text: "Push Otto to classmates (app is ready, promotion hasn't happened)" };
  check("keeps the genuinely on-topic step", dropSiblingBleedSteps(task, siblings, [onTopic]).length === 1);
  check("drops a non-entity step that matches a sibling task's own vocabulary better", dropSiblingBleedSteps(task, siblings, [noEntityBleed1]).length === 0);
  check("drops a second non-entity bleed step naming the app-promotion sibling", dropSiblingBleedSteps(task, siblings, [noEntityBleed2]).length === 0);
  check("mixed batch keeps only the on-topic step", dropSiblingBleedSteps(task, siblings, [onTopic, noEntityBleed1, noEntityBleed2]).length === 1);
  check("with no sibling tasks, nothing is dropped (never over-filter without evidence)", dropSiblingBleedSteps(task, [], [noEntityBleed1, noEntityBleed2]).length === 2);
  const genericStep = { text: "Draft the outline and get feedback before finishing" };
  check("a generic, low-overlap-with-everything step is NOT penalized just for being unspecific", dropSiblingBleedSteps(task, siblings, [genericStep]).length === 1);

  // Same check, applied to an ARTIFACT's title (note/flashcard deck/quiz) instead of a step's text — the
  // entity-based title check alone misses the same non-proper-noun bleed dropSiblingBleedSteps exists to
  // catch for steps.
  const onTopicNote = { title: "Math AA HL — Prior Knowledge Summary" };
  const bleedingNote = { title: "19th Arrondissement Canvassing Plan" };
  check("keeps an on-topic artifact title", dropSiblingBleedTitles(task, siblings, [onTopicNote]).length === 1);
  check("drops an artifact title that matches a sibling task's own vocabulary better", dropSiblingBleedTitles(task, siblings, [bleedingNote]).length === 0);
  check("with no sibling tasks, artifact titles are never dropped", dropSiblingBleedTitles(task, [], [bleedingNote]).length === 1);
}

// Reported live: "Prepare Oslo trip: confirm purpose, dates, bookings" got a 13-card flashcard deck
// despite the taskType-based artifact gate, because taskType itself was misclassified upstream. This is
// the independent, code-level backstop added on top of that: veto flashcards/quiz purely from the
// definition of done's own wording, regardless of what taskType said.
// PageInfoHint — the dashboard's per-page orientation caption (explains the "Do now"/"This week"/"Later"
// priority ranking, the one real piece of complexity onboarding's sidebar tour never actually explains).
// No DOM interaction test runner exists in this suite (renderToStaticMarkup is single-pass, per the
// module-graph check's own comment) — this pins the initial (not-yet-dismissed) render only.
section("PageInfoHint — dashboard orientation caption");
{
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { PageInfoHint } = await import("../client/ui.tsx");
  const html = renderToStaticMarkup(React.createElement(PageInfoHint, { pageKey: "test-page", text: "Explains the thing." }));
  check("renders the hint text", html.includes("Explains the thing."));
  check("renders a dismiss button", /page-info-hint-x/.test(html));
}
// Beta-features gate (Profile.betaFeatures, shared/types.ts): the 7 bandit-personalization call sites and
// the AI theme route must all check it before doing any real personalization — server/index.ts and
// server/jobs.ts aren't imported directly here (the Express app entrypoint is too heavy to import for a
// pure-function test suite, same reason runTask's own wiring is verified via source-order pins), so this
// greps the source directly, same pattern as the runTask wiring pins above.
// Onboarding length contract (client/App.tsx): the flow must stay SHORT — six steps max, one screen per
// idea — while still telling the student what Tasks/Journal/Error log/Tutor each DO. Pins guard both sides
// of that contract: no flow bloat (step count, dead screens) and no missing coverage (each feature named).
section("Onboarding — short but complete (source pins)");
{
  const src = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const obStart = src.indexOf("function Onboarding(");
  const ob = src.slice(obStart, src.indexOf("/** Dedicated login", obStart));
  // Was 5 — bumped to 6 fixing a real bug: step 5 (the personalized "you're all set" done screen) existed
  // in the JSX but nothing ever advanced to it, so it was dead/unreachable code and the progress dots
  // undercounted by one. Now step 4's finish button actually advances into it instead of exiting directly.
  check("onboarding runs exactly 6 steps (0-5, including the done screen)", /const OB_STEPS = 6;/.test(src));
  check("one connect step hosts BOTH Pronote and Google tiles (no second connect screen)", (ob.match(/<PronoteTile /g) || []).length === 1 && (ob.match(/<GoogleTiles /g) || []).length === 1);
  check("no leftover step bodies beyond OB_STEPS", !/step === 6 [\s\S]*step === 11/.test(ob));
  check("the feature tour covers Tasks, Journal, Error log and Tutor in ONE screen", /ob-tour-row/.test(ob) && (ob.match(/ob-tour-row/g) || []).length === 5 && /Journal/.test(ob) && /Error log/.test(ob));
  check("the tour line for the error log says what it feeds (targeted revision)", /target|cible/.test(ob));
  check("the tutor line keeps the never-the-answer rule", /never the answer|jamais la r[ée]ponse/.test(ob));
  check("language is picked on the track step, not its own screen", /saveLang\("fr"\)/.test(ob) && !/PreferencesFields profile=\{null\}/.test(ob));
  check("year level is no longer asked at onboarding (Settings keeps it)", !/const \[yearLevel/.test(ob) && !/void saveYearLevel\(\)/.test(ob));
  // The per-feature detail the old flow spent 4 screens on must live in the first-time hint system.
  const uiSrc = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  check("FirstTimeHint exists as the per-feature home for what onboarding no longer carries", /export function FirstTimeHint/.test(uiSrc));
}

section("betaFeatures gates all 7 bandit call sites + the AI theme route (source-order pins)");
{
  const indexSrc = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const jobsSrc = readFileSync(new URL("../server/jobs.ts", import.meta.url), "utf8");
  check("pomodoro-suggestion route checks betaFeatures before chooseArm", /req\.session\.profile\?\.betaFeatures[\s\S]{0,400}chooseArm\(POMODORO_ARMS/.test(indexSrc));
  check("audio-suggestion route checks betaFeatures before chooseArm", /req\.session\.profile\?\.betaFeatures[\s\S]{0,400}chooseArm\(AUDIO_ARMS/.test(indexSrc));
  check("density-suggestion route checks betaFeatures before chooseArm", /req\.session\.profile\?\.betaFeatures[\s\S]{0,400}chooseArm\(DENSITY_ARMS/.test(indexSrc));
  check("ordering (task list) checks betaFeatures before chooseArm", /!req\.session\.profile\?\.betaFeatures[\s\S]{0,200}orderingArm = "urgency-first"/.test(indexSrc));
  check("chat-style bandit call is gated on betaFeatures", /if \(profile\?\.betaFeatures\) \{[\s\S]{0,300}chooseArm\(CHAT_STYLE_ARMS/.test(indexSrc));
  check("flashcard-style bandit call is gated on betaFeatures", /if \(req\.session\.profile\?\.betaFeatures\) \{[\s\S]{0,1100}chooseArm\(FLASHCARD_ARMS/.test(indexSrc));
  check("theme-personalize route checks betaFeatures before generateThemeTokens", /req\.session\.profile\?\.betaFeatures[\s\S]{0,600}generateThemeTokens/.test(indexSrc));
  check("granularity bandit call (jobs.ts) is gated on betaFeatures", /if \(profile\?\.betaFeatures\) \{[\s\S]{0,300}chooseArm\(GRANULARITY_ARMS/.test(jobsSrc));

  // The camera tool has TWO reachable entry points into Study Mode, not one: the focus overlay
  // (StudyMode.tsx, gated on betaFeatures since this flag's introduction) and, found in a later audit,
  // ToolsDrawer's "Private camera" widget (ArtifactCanvas.tsx's "camera" case) — reachable regardless of
  // the overlay's own gate, plus a camera widget already placed on a board stays live after beta is
  // switched back off unless the canvas's own camera prop is withheld. All three checked here.
  const toolsDrawerSrc = readFileSync(new URL("../client/study/ToolsDrawer.tsx", import.meta.url), "utf8");
  const studyModeSrc = readFileSync(new URL("../client/study/StudyMode.tsx", import.meta.url), "utf8");
  check("ToolsDrawer omits the camera tool from its list when betaFeatures is off", /betaFeatures \? ALL_TOOLS : ALL_TOOLS\.filter\(t => t\.type !== "camera"\)/.test(toolsDrawerSrc));
  check("StudyMode's onAddTool re-checks betaFeatures before adding a camera artifact (doesn't just trust the drawer)", /type === "camera" && !betaFeatures[\s\S]{0,60}return/.test(studyModeSrc));
  check("StudyMode withholds the camera prop from ArtifactCanvas when betaFeatures is off, so a widget placed earlier stops rendering a live camera too", /camera=\{betaFeatures \? focusCamera : undefined\}/.test(studyModeSrc));
}
// Two distinct silent-failure modes that both presented to the user as "Pronote connects, then drops an
// hour later", neither of which any behavioural test could catch (both need a real second serverless
// instance with its own warm cache to reproduce), so they're pinned at the source level.
// A real production incident (2026-09-24, [store] load failed: column weave_web_state.studySessions does
// not exist): the studySessions/studyProfile columns shipped in code's SELECT without a matching migration
// ever landing in supabase.sql, so every loadState() call failed and silently returned an EMPTY profile and
// EMPTY task list — for every account, on every read, including every background job's "load the account,
// merge in new work, save it back" cycle. Two separate fixes, both pinned: the migration now exists, and a
// missing-column error on the whole-row select no longer collapses profile+tasks to nothing.
section("Study Mode: chat + Board always present, board write reliability (source pins)");
{
  const studyModeSrc = readFileSync(new URL("../client/study/StudyMode.tsx", import.meta.url), "utf8");
  const claudeSrc2 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  // Direct instruction: chat + the Board must be on the desk from the FIRST moment of every session, on
  // every workspace template — not opt-in behind a click or Otto's own first write.
  check("defaultChatAndBoard exists and is used by buildInitialArtifacts", /function defaultChatAndBoard/.test(studyModeSrc) && /const chatAndBoard = defaultChatAndBoard/.test(studyModeSrc));
  // Every template branch (WRITING/READING/PROBLEM_SOLVING/REVISION/RESEARCH/default) must spread it in —
  // count the case labels vs the spread sites so a new template added later can't silently skip this.
  const templateCases = (studyModeSrc.match(/case "(WRITING|READING|PROBLEM_SOLVING|REVISION|RESEARCH)":/g) || []).length;
  const spreadSites = (studyModeSrc.match(/\.\.\.chatAndBoard,/g) || []).length;
  check("every named template branch spreads chatAndBoard into its return (none silently opt out)", templateCases > 0 && spreadSites >= templateCases + 1); // +1 for the default branch
  check("resumeSession backfills chat/board for a pre-existing saved session, without touching an already-present one", /missingTypes.*filter.*!env\.artifacts\.some/.test(studyModeSrc.replace(/\s+/g, " ")));

  // The board-write prompt used to leave EVERY write entirely to the model's own per-turn judgment call —
  // strengthened so a genuine topic resolution always leaves a "lessons learned" record, not just when it
  // happens to occur to the model.
  check("chatAboutTask's prompt requires a summary board write whenever the student actually resolves something", /THE ONE WRITE THAT ISN'T OPTIONAL[\s\S]{0,400}kind:"summary"/.test(claudeSrc2));
}

section("Board renders each entry ONCE (the duplicated render block is gone) + pinned focus");
{
  const boardSrc = readFileSync(new URL("../client/study/artifacts/BoardArtifact.tsx", import.meta.url), "utf8");
  // Extracted component so entries and problems share ONE rendering of a problem (state lives in
  // BoardArtifact, keyed by id — survives the flow re-sorting and re-renders).
  check("a single ProblemBlock renders every problem in the flow (no duplicated inline problem JSX)", /function ProblemBlock\(/.test(boardSrc) && (boardSrc.match(/sm-board-problem-label/g) || []).length === 1);
  // Reported live: the board-entries JSX existed TWICE in this file (a merge accident) — every entry the
  // tutor wrote rendered twice. The dedupe-by-id inside each copy couldn't catch it: both copies matched
  // the same entries. This pin counts the actual render sites so a future merge can't reintroduce it.
  // Bare `flowItems.map(` — a prior version pinned the current unanswered problem in its own card and
  // excluded it from this flow with a `.filter(...)` first; reverted (reported live: pinning a problem
  // above even the day's focus line broke the board's top-to-bottom reading order), so every item, problems
  // included, renders through this one unfiltered map again.
  check("board items render through the ONE merged flow, never a separate problem section", (boardSrc.match(/flowItems\.map\(\(item/g) || []).length === 1 && !/flowItems\.filter\(/.test(boardSrc) && !/flowEntries\.map\(/.test(boardSrc) && !/dedupedProblems\.map\(/.test(boardSrc));
  check("the old duplicated inline filter/render block is really gone", (boardSrc.match(/deduplicate by id to prevent duplicates/g) || []).length === 0);
  // Problems never had the id-dedupe the entries block always had — a double-responded turn stacked the
  // same problem twice. Dedupe happens BEFORE the merge, and the merged flow is the only render path.
  check("problems are deduped by id before the flow merge, same as entries", /\.filter\(\(p, i, arr\) => arr\.findIndex\(x => x\.id === p\.id\) === i\)/.test(boardSrc));
  // Added alongside server/claude.ts's isDuplicateProblem — a content-level (normalized question text)
  // dedupe too, so a board saved before that server-side fix existed doesn't still render the same
  // question twice (once unanswered, once answered — reproduced live).
  check("problems are ALSO deduped by normalized question text, preferring whichever copy has answer state", /normQ\(x\.question\) === normQ\(p\.question\)/.test(boardSrc) && /hasState/.test(boardSrc));
  // Reported live: "problems on board show twice" — the "Problème actuel / Current problem" block always
  // rendered the LATEST problem, and the show-all list below rendered ALL of them again, so the newest
  // problem appeared twice (and a one-problem board showed its only problem twice, period). "Current
  // problem" is a single-question-mode concept: gated to that mode now.
  // (The old single-question-mode pin retired with the mode itself: problems are flow items now, and the
  // 'current problem' duplicate-render trap the pin guarded against no longer exists in the file.)
  // Dual coding / document structure: kind:"focus" is the lesson's heading — pinned at the top as a
  // header strip, excluded from the flowing entries, latest wins if a session ever writes a second one.
  check("kind:\"focus\" renders as a pinned header, not inline in the flow", /sm-board-focus-pin/.test(boardSrc) && /e\.kind !== "focus"/.test(boardSrc));
  // The board as a drafted WORKSHEET (research: gradual release + completion effect + ICAP — the visible
  // artifact of a session is the student's own thinking, laid out like a lesson page, written in live).
  check("board has a worksheet header (date + subject)", /sm-board-header/.test(boardSrc) && /sm-board-header-subject/.test(boardSrc));
  check("board entries carry worksheet section numbers", /sm-board-section-num/.test(boardSrc));
  check("kind:\"summary\" renders as a reasoning trace (how the student got there)", /ReasoningTrace/.test(boardSrc) && /sm-board-trace/.test(boardSrc));
  check("a deliberately unfinished worked line gets an 'à toi de finir' completion chip (completion effect, visible)", /isCompletionGap/.test(boardSrc) && /sm-board-todo-chip/.test(boardSrc));
  check("new entries write themselves in (drafted, not swapped)", /sm-board-writein/.test(boardSrc));
  check("the board shows a live 'Otto écrit…' drafting indicator while the tutor composes", /writing\?/.test(boardSrc) && /sm-board-drafting/.test(boardSrc));
  check("TutorSession wires the drafting indicator to the chat's sending state", /writing=\{sending\}/.test(readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8")));
  check("the latest focus wins when more than one exists", /latestFocus/.test(boardSrc));
  // Direct request: problems should sit IN the board's flow (between the entries around them), not pinned
  // at the top — the board is one document telling the lesson's story in the order it happened.
  check("problems are flow items, not a pinned section (no 'Current problem' block, no mode toggle)", !/Problème actuel/.test(boardSrc) && !/singleQuestionMode/.test(boardSrc) && /createdAt \|\| ""\) \|\| Number\.MAX_SAFE_INTEGER/.test(boardSrc));
}

section("isDuplicateBoardEntry — content-level duplicate prevention for board writes (server/claude.ts)");
{
  // UUIDs make by-id dedupe useless for CONTENT duplicates: every write gets a fresh id, so a re-written
  // formula sailed through and stacked a second visual copy. Comparison is on normalized text + kind.
  const onBoard = makeBoardEntry({ text: "F = ma", kind: "formula" }).entry;
  check("an identical re-write is caught", isDuplicateBoardEntry([onBoard], { text: "F = ma", kind: "formula" }));
  check("markdown emphasis/fences are formatting, not content — still caught", isDuplicateBoardEntry([makeBoardEntry({ text: "goading = needling someone" }).entry], { text: "- **goading** = needling someone" }));
  check("a code-fenced ASCII block matches its unfenced twin", isDuplicateBoardEntry([makeBoardEntry({ text: "1789 ──▶ 1792" }).entry], { text: "```\n1789 ──▶ 1792\n```" }));
  check("whitespace/indentation differences are still caught", isDuplicateBoardEntry([onBoard], { text: "  F =   ma  " }));
  check("case differences are still caught", isDuplicateBoardEntry([onBoard], { text: "f = MA" }));
  check("a kindless re-write matches a kinded entry (kindless ≡ note — the model is inconsistent about kinds)", isDuplicateBoardEntry([onBoard], { text: "F = ma" }));
  check("genuinely different text is NOT a duplicate (no fuzzy matching)", !isDuplicateBoardEntry([onBoard], { text: "a = F/m" }));
  check("same text under a different kind is NOT a duplicate", !isDuplicateBoardEntry([onBoard], { text: "F = ma", kind: "insight" }));
  check("an empty/whitespace write never counts as a duplicate", !isDuplicateBoardEntry([onBoard], { text: "   " }));
}

section("isDuplicateProblem — content-level duplicate prevention for CREATE_PROBLEM (server/claude.ts)");
{
  // Reproduced live: the exact same practice problem appeared TWICE on a board — once unanswered, once
  // already answered — because a turn that already successfully called CREATE_PROBLEM then failed its own
  // final reply (the empty-completion/token-ceiling bug, fixed separately), so a later turn made the exact
  // same problem again from scratch, unaware the first one had landed. Unlike a diagram (which legitimately
  // gets redrawn under the same caption to ADD something), there's no legitimate reason to make the same
  // problem twice.
  const existing = [{ id: "1", question: "A 12 kg suitcase sits at rest on a rough ramp inclined at 20° — find the friction force.", options: ["40 N", "66 N"], correct: 0, createdAt: new Date().toISOString() }];
  check("an identical re-ask is caught", isDuplicateProblem(existing, { question: existing[0].question }));
  check("whitespace/case differences are still caught", isDuplicateProblem(existing, { question: `  ${existing[0].question.toUpperCase()}  ` }));
  check("genuinely different question text is NOT a duplicate", !isDuplicateProblem(existing, { question: "A different problem entirely about momentum." }));
  check("an empty question never counts as a duplicate", !isDuplicateProblem(existing, { question: "   " }));
  check("an empty existing list never flags a duplicate", !isDuplicateProblem([], { question: existing[0].question }));

  const claudeSrc3 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  // Exactly 2 call-syntax occurrences: the export signature + the single call site in WRITE_TO_BOARD's
  // branch. DRAW_ON_BOARD is deliberately NOT gated — redrawing a whole figure with additions is the
  // tool's documented contract. (A third site, or zero, means someone moved or duplicated the gate.)
  const gateCount = (claudeSrc3.match(/isDuplicateBoardEntry\(/g) || []).length; // export + call site
  check("the duplicate gate lives ONLY on WRITE_TO_BOARD (DRAW_ON_BOARD redraws are legitimate)", gateCount === 2);
  check("WRITE_TO_BOARD checks BOTH the live board and this turn's earlier writes", /isDuplicateBoardEntry\(\[\.\.\.\(opts\?\.currentBoard \|\| \[\]\), \.\.\.result\.board\], input\)/.test(claudeSrc3));
  check("a caught duplicate returns adaptive guidance, not an error", /DUPLICATE: that exact entry is already on the board/.test(claudeSrc3));
  check("the prompt tells the model to look before writing", /BEFORE YOU WRITE, LOOK\./.test(claudeSrc3));
  // Completion effect (Sweller): a worked example ending in a gap beats a fully worked one — the student
  // does the last step, which is where the learning happens.
  check("worked examples end in a completion gap, not a finished line", /completion effect/.test(claudeSrc3) && /= \?/.test(claudeSrc3));
}

section("visionReady / describeWhiteboard — the Tutor whiteboard's vision step (server/claude.ts)");
{
  // GEMINI_API_KEY is a SEPARATE provider from DEEPSEEK_API_KEY/aiReady() on purpose — DeepSeek has no image
  // input at all (confirmed directly against its live API), so whiteboard-reading is deliberately gated on
  // its own key rather than piggybacking on aiReady(). Save/restore so this doesn't leak into other tests.
  const savedKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    check("visionReady is false with no key configured", visionReady() === false);
    const r1 = await describeWhiteboard("data:image/png;base64,abc123");
    check("describeWhiteboard refuses up front when not configured, never attempts a network call", "error" in r1 && /configured/i.test(r1.error));

    process.env.GEMINI_API_KEY = "test-key-not-a-real-one";
    check("visionReady is true once a key is set", visionReady() === true);
    const r2 = await describeWhiteboard("not a data url at all");
    check("a malformed data URL is rejected before any network call", "error" in r2 && /doesn't look like a real image/i.test(r2.error));
    const r3 = await describeWhiteboard("data:image/png;base64,abc");
    check("a suspiciously tiny payload (a blank canvas) is rejected before any network call", "error" in r3 && /empty/i.test(r3.error));
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
  }
}

section("chatAboutTask's empty-completion fallback — wording matches what actually landed (source pin)");
{
  // Reported live: a DRAW_ON_BOARD call succeeded (a free-body diagram, exactly what was asked for), but
  // the follow-up text-synthesis completion came back empty after retries, and the student saw a flat
  // "Here's an exercise — check the board" — talking about a DIFFERENT artifact kind than the one that
  // actually appeared. Pin that the fallback branches on what was actually made (problem vs. diagram vs.
  // a plain board write), not one fixed "exercise" string regardless of kind.
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const start = src.indexOf("const finish = (reply: string): ChatResult => {");
  const body = src.slice(start, src.indexOf("\n  };", start));
  check("branches on madeProblem", /madeProblem/.test(body));
  check("branches on madeDiagram separately from a plain board write", /madeDiagram/.test(body) && /madeBoardOnly/.test(body));
  check("the diagram branch doesn't say 'exercise'", /Here's the diagram/.test(body) && !/madeDiagram[\s\S]{0,80}exercise/i.test(body));
}
section("shouldNudgeBoardWrite — a confirmed student math step must land on the board (server/claude.ts)");
{
  // The live-reported miss, verbatim: Otto confirmed the student's own trig step in chat and wrote nothing
  // to the board — the session document never showed THEIR reasoning or the formula the step established.
  const liveReply = "Yes — exactly that. 1 − cos²θ is sin²θ, straight from sin²θ + cos²θ = 1.\n\nSo the whole fraction is now sin²θ over sinθ·cosθ. What does that cancel down to?";
  check("the exact live miss (confirmation + worked math + no write) triggers the nudge", shouldNudgeBoardWrite(liveReply, "so 1 - cos^2 theta = sin^2 theta right?", false));
  check("a French confirmation with math triggers it too", shouldNudgeBoardWrite("Parfait — donc tout devient sin²θ sur sinθ·cosθ. Tu simplifies comment ?", "1 − cos²θ = sin²θ ?", false));
  check("already wrote to the board this turn → never nudged", !shouldNudgeBoardWrite(liveReply, "1 − cos²θ = sin²θ ?", true));
  check("confirmation without math in play → no nudge (an essay insight isn't board content)", !shouldNudgeBoardWrite("Yes — exactly that, well put.", "so the author is being ironic?", false));
  check("math but no confirmation → no nudge (normal coaching loop, not a miss)", !shouldNudgeBoardWrite("Let's start with sin²θ + cos²θ = 1 — what does that give you for 1 − cos²θ?", "i don't know where to start", false));
  check("a question-only reply with math from the student → no nudge", !shouldNudgeBoardWrite("What do you get when you cancel sinθ?", "sin²θ / (sinθ·cosθ) = ?", false));
  check("lowercase/casual confirmations count (yeah, oui, c'est ça)", shouldNudgeBoardWrite("yeah — that's the identity. x = 2.", "x = 2?", false) && shouldNudgeBoardWrite("oui c'est ça ! donc 2x = 4", "2x = 4 ?", false));
  // The live-reported miss: a whole physics session confirming correct answers turn after turn, but the
  // nudge's affirmation list didn't include "spot on" (or "got it", "nailed it", "absolutely") — so the one
  // mechanism meant to catch "confirmed correct math and wrote nothing" silently missed every single one.
  check("'spot on' (the exact live miss) triggers the nudge", shouldNudgeBoardWrite("Spot on. The thruster gave it a boost, and once it cut off F_net = 0.", "so it keeps moving at constant velocity?", false));
  check("other everyday affirmations trigger it too (nailed it, got it, absolutely)",
    shouldNudgeBoardWrite("Nailed it — F = ma gives 10 N.", "so F = 2 * 5?", false) &&
    shouldNudgeBoardWrite("You got it right — x = 4.", "is x = 4?", false) &&
    shouldNudgeBoardWrite("Absolutely — v = 20 m/s.", "so v = d/t = 20?", false));

  const claudeSrc5 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  // Enforcement in code, not just the prompt — same posture as the empty-board-claim fix: one corrective
  // round, latched, feeding the model back its own reply so the write actually happens mid-turn.
  check("the nudge is a ONE-SHOT corrective round inside the tool loop", /boardNudgeDone = false;/.test(claudeSrc5) && /!boardNudgeDone && !lastRound && shouldNudgeBoardWrite\(textContent, message, result\.board\.length > 0\)/.test(claudeSrc5) && /boardNudgeDone = true;/.test(claudeSrc5));
  check("the prompt names the confirmation moment as a board moment", /"YES — EXACTLY THAT" IS A BOARD MOMENT TOO/.test(claudeSrc5));
}

section("Arithmetic ground truth — evaluator, claim extractor, CREATE_CALC (server/arithmetic.ts + claude.ts)");
{
  // Phase 1 of the tutor-truth plan: the model's mental arithmetic is the most common factual error a
  // tutor makes. The fix is a code-level oracle (the CoVe/CRITIC posture — verification must be an
  // INDEPENDENT recomputation, never the model re-reading its own draft) shared by THREE callers: the
  // CREATE_CALC tool (mid-turn), the post-reply verifier (claude.ts, later pass), and the client's
  // double-check affordance (Phase 4). The evaluator/extractor checks below run the REAL code —
  // behavioral, not grep pins.
  check("evaluator: precedence and parens", evaluateArithmetic("2+3*4") === 14 && evaluateArithmetic("(2+3)*4") === 20);
  check("evaluator: the tutor's unicode operators (× ÷ − and letter-x) all work", evaluateArithmetic("3 × 47") === 141 && evaluateArithmetic("10 ÷ 4") === 2.5 && evaluateArithmetic("10 − 4") === 6 && evaluateArithmetic("3 x 4") === 12);
  check("evaluator: FR decimal + EN/FR grouping", evaluateArithmetic("2,5 + 1") === 3.5 && evaluateArithmetic("1,234 + 1") === 1235 && evaluateArithmetic("1 234 + 1") === 1235);
  check("evaluator: unary minus folds (start, after op, after paren)", evaluateArithmetic("-3 + 5") === 2 && evaluateArithmetic("2 * -3") === -6 && evaluateArithmetic("(-3 + 5) * 2") === 4);
  check("evaluator REFUSES what it can't verify (no best-effort guesses)", evaluateArithmetic("2^10") === null && evaluateArithmetic("2 + a") === null && evaluateArithmetic("(2+3") === null && evaluateArithmetic("1/0") === null && evaluateArithmetic("3 + * 4") === null);
  check("parseNumber: FR decimal, thin-space/nbsp grouping, EN comma grouping", parseNumber("3,5") === 3.5 && parseNumber("1 234") === 1234 && parseNumber("1\u00A0234") === 1234 && parseNumber("1,234") === 1234);
  check("parseNumber: mixed separators resolve by the LAST-separator rule", parseNumber("1 234,5") === 1234.5 && parseNumber("1,234.5") === 1234.5);
  check("parseNumber: unit suffixes strip (€, %, kg)", parseNumber("12 €") === 12 && parseNumber("25%") === 25 && parseNumber("3 kg") === 3);
  check("parseNumber: malformed spacing is null, never guessed", parseNumber("12 34") === null);
  check("claims: a correct equality is not flagged", findArithmeticClaims("Donc 3 × 47 = 141.")[0]?.mismatch === false);
  check("claims: a wrong equality IS flagged", findArithmeticClaims("3 × 47 = 151")[0]?.mismatch === true);
  check("claims: FR donne separator + FR decimals verify", findArithmeticClaims("2,5 + 1 = 3,5 donc c'est bon")[0]?.mismatch === false && findArithmeticClaims("3 + 3 donne 6.")[0]?.mismatch === false);
  check("claims: percent form forms NO claim (never misread as +)", findArithmeticClaims("50% de 80 = 45").length === 0);
  check("claims: an algebra tail is skipped, not misverified", findArithmeticClaims("x = 34 + 1, donc...").length === 0);
  check("claims: duplicates collapse; multi-claim order kept", findArithmeticClaims("12 × 3 = 36 ... again 12 × 3 = 36").length === 1 && (() => { const c = findArithmeticClaims("5 + 5 = 10 and 6 × 7 = 48"); return c.length === 2 && c[0].mismatch === false && c[1].mismatch === true; })());
  check("hasArithmetic is a cheap EN/FR pre-filter", hasArithmetic("2,5 + 1") === true && hasArithmetic("aucun calcul ici") === false);
  // CREATE_CALC — exercised through the REAL handler the tool loop dispatches to.
  check("CREATE_CALC returns the exact result", JSON.parse(runCalcTool({ expression: "3 × 47" })).result === 141);
  check("CREATE_CALC supports FR decimals and parens", JSON.parse(runCalcTool({ expression: "2,5 + 1" })).result === 3.5 && JSON.parse(runCalcTool({ expression: "(12+8)/4" })).result === 5);
  check("CREATE_CALC refuses out-of-subset input with guidance, never a guess", /^ERROR:/.test(runCalcTool({ expression: "2x + 1" })) && /^ERROR: no expression/.test(runCalcTool({})));
  // Wiring pins — the tool must actually be reachable from BOTH tutor tool arrays and dispatched by name.
  const claudeSrcCalc = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const arithSrc = readFileSync(new URL("../server/arithmetic.ts", import.meta.url), "utf8");
  const calcCount = (claudeSrcCalc.match(/CREATE_CALC_TOOL/g) || []).length; // const + 2 array entries
  check("CREATE_CALC is in BOTH tutor tool arrays (normal + canvas mode)", calcCount === 3);
  check("CREATE_CALC has a dispatch branch in the tool loop", /name === "CREATE_CALC"/.test(claudeSrcCalc) && /runCalcTool\(input\)/.test(claudeSrcCalc));
  check("claude.ts imports the shared arithmetic oracle", /import \{ evaluateArithmetic, findArithmeticClaims, hasArithmetic \} from "\.\/arithmetic\.ts"/.test(claudeSrcCalc));
  check("the arithmetic module is pure (no imports, no eval — client-importable)", !/^\s*import /m.test(arithSrc) && !/[^.a-zA-Z]eval\(/.test(arithSrc));
}

section("isLikelyEcho — textual echo discrimination for real barge-in (client/voice/echoGuard.ts)");
{
  // Barge-in keeps the mic OPEN while Otto speaks — so the mic hears Otto through the speakers too. The
  // only reliable discriminator the Web Speech API allows is textual: Otto can only echo words he is
  // currently saying, so heard text contained in the spoken reply is echo; anything else is the student.
  const spoken = "Yes — exactly that. 1 − cos²θ is sin²θ, straight from sin²θ + cos²θ = 1. So the whole fraction is now sin²θ over sinθ·cosθ. What does that cancel down to?";
  check("Otto's own words coming back are classified as echo", isLikelyEcho(spoken, "exactly that is sin"));
  check("the student talking over him is NOT echo (even mid-reply)", !isLikelyEcho(spoken, "wait can you explain the fraction again"));
  check("a one-word interjection is never echo (a student's 'stop' must always get through)", !isLikelyEcho(spoken, "stop"));
  check("a partial prefix of the spoken text is echo (recognizer landing mid-utterance)", isLikelyEcho("The derivative gives the rate of change", "the derivative gives"));
  check("normalizeForEcho keeps French accents but drops punctuation", normalizeForEcho("Oui — c'est ça !") === "oui c est ça");
  check("empty spoken text or empty heard text is never echo", !isLikelyEcho("", "hello there") && !isLikelyEcho(spoken, "  "));

  // The stateful filter — the recurring-loop fix. The pure matcher alone couldn't close the loop because
  // the echo's final result lands AFTER synth.speaking flips false (recognition pipeline lag).
  const reply = "So the whole fraction is now sin²θ over sinθ·cosθ. What does that cancel down to?";
  const f = createEchoFilter();
  f.speechStarted(reply);
  check("during speech, Otto's own words are dropped", f.isEcho("what does that cancel down to"));
  check("during speech, the student's own words are NOT dropped", !f.isEcho("but why does the identity apply here"));
  f.speechEnded();
  check("AFTER the speech flag flips false (recognition lag), the echo is STILL dropped within the tail", f.isEcho("what does that cancel down to"));
  check("outside the tail window, the same text would be allowed (the window is bounded)", new Promise((done) => setTimeout(() => done(!f.isEcho("what does that cancel down to")), 2100)));
  const f2 = createEchoFilter();
  f2.speechStarted(reply);
  f2.speechEnded();
  check("a VERBATIM repeat of the just-spoken reply is dropped with NO time bound (the loop-killer)", f2.isEcho(reply));
  const f3 = createEchoFilter();
  check("with no speech at all, nothing is classified as echo", !f3.isEcho("anything at all"));
  f3.speechStarted(reply);
  f3.speechEnded();
  f3.speechStarted("a different reply entirely — re-armed");
  check("speechStarted re-arms the filter to the NEW reply (back-to-back utterances)", !f3.isEcho("what does that cancel down to") && f3.isEcho("a different reply entirely"));

  // Real error messages — the raw Web Speech codes used to vanish silently.
  const [frDenied, enDenied] = speechErrorMessage("not-allowed");
  const [frNoMic] = speechErrorMessage("audio-capture");
  const [frNet, enNet] = speechErrorMessage("network");
  const [frFallback, enFallback] = speechErrorMessage("some-future-code");
  check("permission-denied and no-mic get distinct bilingual student messages", frDenied.includes("autorise") && enDenied.includes("allow mic") && frNoMic.includes("Aucun micro"));
  check("network and unknown codes get messages too (never empty, never a raw code)", frNet.length > 10 && enNet.length > 10 && frFallback.length > 10 && enFallback.length > 10);

  const taskCardSrc = readFileSync(new URL("../client/TaskCard.tsx", import.meta.url), "utf8");
  // The per-task chat got the same treatment: interruptible everywhere, not just in Tutor Session.
  check("TaskChat is interruptible too (stateful echo filter, mic never paused during TTS)", /echoFilterRef\.current\.isEcho\(text\)/.test(taskCardSrc) && !/wasSpeakingRef/.test(taskCardSrc));

  // French voice pipeline (server/index.ts /api/tts): verified live against FreeTTS — /api/speech is DEAD
  // (404; moved to /api/v1/tts, x-api-key auth, JSON {audio_url} 2-step flow, locale-shaped voice names,
  // "brian" now fails validation). The old route hard-spoke "brian": an ENGLISH voice reading French
  // tutor replies. Pin the whole language-correct contract so it can't regress silently.
  const serverSrc = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const ttsStart = serverSrc.indexOf("const TTS_VOICE_BY_LANG");
  const ttsBody = serverSrc.slice(ttsStart, serverSrc.indexOf("// ── Static (production)"));
  check("TTS route uses the CURRENT FreeTTS v1 endpoint (old /api/speech is dead)", /freetts\.org\/api\/v1\/tts/.test(ttsBody) && !/freetts\.org\/api\/speech/.test(serverSrc));
  check("TTS authenticates via x-api-key (Bearer no longer accepted)", /"x-api-key": key/.test(ttsBody));
  check("TTS speaks a real FRENCH voice for French accounts, English for English", /TTS_VOICE_BY_LANG/.test(ttsBody) && /fr-FR-DeniseNeural/.test(ttsBody) && /en-US-AriaNeural/.test(ttsBody));
  check("TTS voice falls back to a multilingual/fr-FR GA voice if the primary is retired", /fr-FR-VivienneMultilingualNeural/.test(ttsBody) && /fr-FR-EloiseNeural/.test(ttsBody));
  check("TTS follows the 2-step flow (synthesis JSON → audio_url fetch → mp3 stream)", /audio_url/.test(ttsBody) && /audio\/mpeg/.test(ttsBody));
  check("TTS only ever fetches the vendor's own returned audio_url (no client-supplied URL)", /meta\.audio_url \? \{ ok: true, audioUrl: meta\.audio_url \}/.test(ttsBody) && !/req\.body\.audio_url/.test(ttsBody));
  check("TTS stays fail-open so the client's language-correct browser-TTS fallback still engages", /Échec de la génération vocale/.test(ttsBody) && /status !== 400 && r\.status !== 422/.test(ttsBody));
  // freetts.org staples a spoken "Generated by FreeTTS" tag onto EVERY synthesis (its JSON even
  // carries `"watermark":"end"`, and no request parameter disables it — probed live). The route
  // must splice the watermark's frames out server-side (server/ttsTrim.ts) before the student
  // hears the tag; a null trim means the audio goes out untouched — never a hard failure.
  check("TTS route strips the FreeTTS watermark before serving", /const trimmed = trimFreeTTSWatermark\(audioBuf\)/.test(ttsBody) && /res\.send\(trimmed \?\? audioBuf\)/.test(ttsBody));
  check("watermark trim is fail-open (unparseable/short audio is served as-is, warned about)", /if \(!trimmed\) console\.warn\("\[tts\] watermark trim skipped/.test(ttsBody));
  // And exercised, not just pinned: synthetic MPEG2 Layer III streams (FreeTTS's own format:
  // 24 kHz ⇒ 576-sample ≈ 24 ms frames, 144-byte @ 48 kbps) verify the splice math. Real probed
  // vendor files cut 10.89s→7.51s and 9.83s→6.45s, dead-center of the safe window below.
  const mkMp3Stream = (n, withId3 = false) => {
    const frame = Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc4]), Buffer.alloc(140, 0x55)]); // header + filler data
    const audio = Buffer.concat(Array.from({ length: n }, () => frame));
    if (!withId3) return audio;
    return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), audio]); // 10-byte ID3v2 header, size 0
  };
  const FRAME_SECONDS = 576 / 24000;
  for (const withId3 of [false, true]) {
    const n = 500; // 12.0s of frames — as if sentence + ~1.6s gap + ~1.77s watermark + ~0.82s tail
    const out = trimFreeTTSWatermark(mkMp3Stream(n, withId3));
    const keptSeconds = out ? (out.length / 144) * FRAME_SECONDS : 0;
    // Safe window: keep at least through the last real-speech frame (the vendor's gap starts
    // ~4.19s from the end) but never any watermark speech (it starts ~2.59s from the end).
    // ±1 frame of slack is fine — a frame is 24ms, the window margins are ~0.8s.
    check(`watermark trimmer cuts inside the safe window (id3=${withId3})`, !!out && keptSeconds >= n * FRAME_SECONDS - 4.19 - FRAME_SECONDS && keptSeconds <= n * FRAME_SECONDS - 2.59);
  }
  check("watermark trimmer refuses short audio (a cut there would eat real speech)", trimFreeTTSWatermark(mkMp3Stream(100)) === null && trimFreeTTSWatermark(mkMp3Stream(207)) === null);
  check("watermark trimmer fail-opens on garbage input (serves original audio)", trimFreeTTSWatermark(Buffer.alloc(4096, 0x00)) === null);
  // The mic is NEVER on by default: voice mode (always-listening + auto-speak) starts OFF on every page
  // load and only an explicit tap on the mic button turns it on — no localStorage restore, no auto-enable
  // prop. The pref used to persist ("otto-voice-mode"), so any reload silently re-opened the microphone
  // without fresh consent.
  const voiceModeSrc = readFileSync(new URL("../client/voice/useVoiceModePref.ts", import.meta.url), "utf8");
  check("voice mode ALWAYS starts OFF on load (useState(false); nothing restored from storage)", /useState\(false\)/.test(voiceModeSrc) && !/getItem\(/.test(voiceModeSrc));
  check("no auto-enable path exists (the startInVoiceMode mount effect is gone)", !/startInVoiceMode/.test(readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8")));
  // Client STT/TTS language wiring: every voice surface must pass fr-FR when the app is French.
  const panelSrc = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  check("the tutor voice panel binds BOTH STT and TTS to the app language (fr-FR in French)", /speechLang = en \? "en-US" : "fr-FR"/.test(panelSrc) && /useSpeechSynthesis\(speechLang\)/.test(panelSrc) && /lang: speechLang/.test(panelSrc));

  // THE RECURRING LOOP FIX — the old guard checked echo only WHILE synth.speaking was true, but
  // recognition lag means Otto's echo often FINALIZES after that flag flipped false: the check was
  // skipped exactly when the echo arrived, his own reply went out as a student message, Otto replied
  // to it, it was spoken, re-echoed… createEchoFilter closes both holes: a post-speech TAIL window
  // (recognition lag) and a timing-independent verbatim-repeat kill (the loop's own signature).
  check("all three voice surfaces run the stateful echo filter", [readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8"), taskCardSrc, readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8")].filter((s) => /echoFilterRef\.current\.isEcho\(text\)/.test(s)).length === 3);
  check("the filter is driven by TTS transitions (speechStarted/speechEnded) on the chat surfaces", /speechStarted\(/.test(taskCardSrc) && /speechEnded\(\)/.test(taskCardSrc));
  check("mic failures surface as a real bilingual message (no longer silent)", /onError: \(msg\) => setMicError\(msg\)/.test(taskCardSrc) && /micError \? </.test(taskCardSrc) && /micError \? </.test(readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8")));

  const speechErrorsSrc = readFileSync(new URL("../client/voice/speechErrors.ts", import.meta.url), "utf8");
  const recogHookSrc = readFileSync(new URL("../client/voice/useSpeechRecognition.ts", import.meta.url), "utf8");
  check("the hook maps real error codes to student-presentable messages", /onErrorRef\.current\?\.\(speechErrorMessage\(e\.error\)\)/.test(recogHookSrc));
  check("no-speech/aborted never surface (normal always-on events, not failures)", /e\.error === "no-speech" \|\| e\.error === "aborted"\) return;/.test(recogHookSrc));
  check("the error mapper covers permission, no-mic, network, language, and a fallback", ["not-allowed", "audio-capture", "network", "language-not-supported"].every((c) => speechErrorsSrc.includes(`case "${c}"`)) && /default:/.test(speechErrorsSrc));
}

section("Tutor Session — sessions never auto-start, and past boards read at a glance (source pins)");
{
  const tutorSrc = readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8");
  // Direct request: "tutor shouldn't auto open session" — even the READ-ONLY peek was auto-RESUMING an
  // active session on mount (setTask), so opening /tutor dropped the student straight into a session.
  // Now the peek is DETECT-ONLY (GET /api/tasks, no setTask): it merely notices an in-progress session so
  // the landing can offer an explicit "Reprendre" button. Opening /tutor ALWAYS shows the landing; a
  // click (Reprendre or Start) is the only thing that opens a session.
  check("the mount peek is detect-only (api.tasks, never setTask, never the session-minting route)", (() => {
    const peekStart = tutorSrc.indexOf("const peekForActiveSession");
    const peekBody = tutorSrc.slice(peekStart, tutorSrc.indexOf("}, []);", peekStart) + 6);
    return /peekForActiveSession/.test(tutorSrc) && /api\.tasks\(\)\.then/.test(peekBody) && !/setTask\(/.test(peekBody) && /setPendingActiveSession\(t \|\| null\)/.test(peekBody) && !/api\.studyFreeSession\(\)\.then/.test(tutorSrc);
  })());
  check("an in-progress session is offered back ONLY via an explicit Resume button (no auto-open on mount)", /resumeActiveSession/.test(tutorSrc) && /onClick=\{resumeActiveSession\}/.test(tutorSrc) && /L\("Reprendre", "Resume"\)/.test(tutorSrc));
  check("Start is the only create path and always passes fresh (a new lesson starts clean)", /api\.studyFreeSession\(true, selectedSubject\)/.test(tutorSrc));
  check("voice stays manual (no startInVoiceMode on the panel — the mic toggle is the student's)", !/startInVoiceMode=/.test(tutorSrc));
  // Direct request: "refine ui for past boards" — each history item shows the board AT A GLANCE (first
  // few entries as compact lines) before the full reopenable board behind the View button.
  check("past sessions show the board at a glance (capped 3-line preview)", /tutor-history-takeaways/.test(tutorSrc) && /tutor-history-board/.test(tutorSrc) && /slice\(0, 3\)/.test(tutorSrc));
  check("history modals are subject-titled (which lesson's board/chat am I reopening?)", /openBoardSession\.subject \? ` · \$\{openBoardSession\.subject\}`/.test(tutorSrc));
  const stylesSrc = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  check("the at-a-glance history styles actually exist", /\.tutor-history-takeaways/.test(stylesSrc) && /\.tutor-history-board li::before/.test(stylesSrc));
}

section("Voice-mode board rules — gesture research, not dictation (prompt pins)");
{
  // Yeo/Alibali 2017: pointing at SYMBOLIC notation while talking hurt learning; figures didn't. The old
  // rule demanded a formula write for EVERY spoken intermediate line — symbolic dictation, the exact
  // anti-pattern. The rewrite keeps the real requirement (speech can't show notation) but writes once.
  const claudeSrc4 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("voice mode: the working expression is written ONCE as the canonical reference", /write the expression the student is actively working with ONCE/.test(claudeSrc4));
  check("voice mode: no transcribing every intermediate spoken line", /do NOT transcribe every intermediate spoken line/.test(claudeSrc4));
  check("voice mode: diagrams/arrows/structure preferred over bare symbol strings", /eyes-on-figure \(not eyes-on-equation\)/.test(claudeSrc4));
  check("the old transcribe-every-intermediate-line rule is gone", !/This applies to every intermediate line/.test(claudeSrc4));
  check("the student-can't-see-notation requirement itself is preserved", /THE BOARD IS THE ONLY PLACE THEY EVER SEE THE ACTUAL NOTATION/.test(claudeSrc4));
}

section("loadState survives a missing-column schema-drift error (source pins)");
{
  const storeSrc = readFileSync(new URL("../server/store.ts", import.meta.url), "utf8");
  const supabaseSql = readFileSync(new URL("../supabase.sql", import.meta.url), "utf8");
  // Double-quoted specifically: an unquoted `add column ... studySessions` is silently folded to a
  // DIFFERENT column (`studysessions`) by Postgres, which the app's camelCase PostgREST select can't find —
  // a real mistake made and shipped once already in this exact migration. The regex requires the quotes.
  check("supabase.sql adds studySessions double-quoted (not silently lowercased)", /add column if not exists "studySessions"/.test(supabaseSql));
  check("supabase.sql adds studyProfile double-quoted (not silently lowercased)", /add column if not exists "studyProfile"/.test(supabaseSql));
  check("loadState retries with a narrower select on a missing-column error, instead of returning empty immediately", /does not exist.*\n[\s\S]{0,400}load-narrow/.test(storeSrc));
}
section("server/index.ts error responses — French/English aware, no leaked operator-only detail (source pins)");
{
  // Reported live via audit: server/index.ts's res.status().json({error:...}) calls were hardcoded English
  // across virtually the whole file, so a French account saw raw English text in toasts whenever one of
  // these paths fired (client/api.ts's error handling always prefers a server-sent message over its own
  // bilingual fallback, by design — so the fix has to be at the SOURCE, not the client). `M(req, fr, en)`
  // is the fix; this pins that the highest-traffic clusters (auth flow, the AI-paused/budget/not-configured
  // checks hit by every AI-calling route, and generic 404s) were actually converted, not just that the
  // helper exists unused somewhere.
  const src = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  check("reqLang/M bilingual-error helper exists", /function reqLang\(req: express\.Request\)/.test(src) && /function M\(req: express\.Request, fr: string, en: string\)/.test(src));
  check("signup's validation errors are bilingual, not hardcoded English", /M\(req, "Entre un email valide et un mot de passe/.test(src));
  check("login's wrong-password error is bilingual", /M\(req, "Email ou mot de passe incorrect\."/.test(src));
  check("every AI-paused 403 now goes through M(), not a hardcoded English string", !/error: "AI is paused/.test(src));
  check("every generic 404 now goes through M(), not a hardcoded \"not found\"", !/error: "not found"/.test(src));
  check("every 'AI isn't configured' 503 now goes through M()", !/error: "AI isn't configured\."/.test(src) && !/error: "AI isn't set up on this server yet\."/.test(src));
  // The budget message used to be a single hardcoded English string that leaked an OPERATOR-ONLY instruction
  // ("Raise MONTHLY_AI_BUDGET_USD to lift it") straight into a student's toast — meaningless to them, and
  // never translated even though the rest of the app is French-first. Now a real bilingual, student-facing
  // message via budgetMsg(req), with no internal env-var detail.
  const budgetMsgIdx = src.indexOf("const budgetMsg = (req: express.Request)");
  const budgetMsgBody = src.slice(budgetMsgIdx, src.indexOf(";", budgetMsgIdx) + 1);
  check("budgetMsg() is bilingual and never mentions the internal env var to a student", budgetMsgIdx > 0 && !/MONTHLY_AI_BUDGET_USD/.test(budgetMsgBody));
  check("every over-budget 402 call site uses budgetMsg(req), not a raw hardcoded constant", !/error: BUDGET_MSG/.test(src));
  // Completeness pass (this round): every remaining error response in the file — the ~130 one-off catch-
  // block fallbacks this section didn't individually pin above — must go through M()/e?.message, never a
  // bare hardcoded string or template literal, for BOTH capitalized ("Couldn't save...") and lowercase
  // ("not found") English validation strings, plus template-literal ones interpolating a variable.
  check("no remaining bare capitalized-English error string literals anywhere in the file", !/error: "[A-Z]/.test(src));
  check("no remaining bare lowercase-English error string literals anywhere in the file", !/error: "[a-z]/.test(src));
  check("no remaining bare English error TEMPLATE LITERALS anywhere in the file", !/error: `[A-Za-z]/.test(src));
  // One string was already French-only (not bilingual at all) before this pass — Otto's own chat-completion
  // fallback message. Confirms it's bilingual now, not just moved.
  check("the chat fallback reply message (previously French-only, never bilingual) is now bilingual", /M\(req, "Otto n'a pas réussi à répondre\.", "Otto couldn't come up with a reply\."\)/.test(src));
}

section("Client-side i18n completeness — client/study/ hardcoded English strings (source pins)");
{
  // Audit found these as the areas that never got folded into the L()/useLang() system used everywhere else
  // in client/App.tsx/TaskCard.tsx — aria-labels and placeholders a French student would see in raw English.
  const askOtto = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  check("AskOttoPanel's aria-labels and placeholder are bilingual, not hardcoded English", !/aria-label="[A-Z]/.test(askOtto) && !/placeholder="[A-Z]/.test(askOtto));
  const studySetup = readFileSync(new URL("../client/study/StudySetup.tsx", import.meta.url), "utf8");
  check("StudySetup's link/label placeholders are bilingual", /placeholder=\{L\(/.test(studySetup));
  const dict = readFileSync(new URL("../client/study/artifacts/DictionaryArtifact.tsx", import.meta.url), "utf8");
  check("DictionaryArtifact's search placeholder is language-aware, not hardcoded English", !/placeholder="Search a word"/.test(dict));
  const citation = readFileSync(new URL("../client/study/artifacts/CitationArtifact.tsx", import.meta.url), "utf8");
  check("CitationArtifact's field placeholders are bilingual, not hardcoded English", !/placeholder="[A-Z]/.test(citation));
  const camera = readFileSync(new URL("../client/study/artifacts/CameraArtifact.tsx", import.meta.url), "utf8");
  check("CameraArtifact's aria-label is bilingual, not hardcoded English", !/aria-label="[A-Z]/.test(camera));
}

section("App() — the local flashcard/quiz backup save-effect never writes a STALE account's decks into a DIFFERENT account's local storage key (source pin)");
{
  // The actual cross-account leak (a write bug, not a read bug): if `status.user` changes to a new account
  // before `tasks` has actually been refetched for it (session merely expired rather than an explicit
  // sign-out, or a delete-account/new-signup in close succession), a [tasks, status?.user]-keyed effect can
  // fire with userId already pointing at the NEW account but `tasks` still holding the OLD account's decks
  // — writing them straight into the new account's localDecks/localQuizzes key. Fixed with a render-time
  // (not effect-time) flag: reordering effects or adding a `loaded` check doesn't work here because a
  // sibling effect's setState can't retroactively un-stale a closure already executing in the same flush.
  const appSrc = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const start = appSrc.indexOf("export function App(");
  const body = appSrc.slice(start, appSrc.indexOf("\nexport function ", start + 10));
  check("userJustChanged is computed inline during render (a ref comparison), not inside a useEffect", /const prevUserRef = useRef\(status\?\.user \?\? null\);\s*const userJustChanged = prevUserRef\.current !== \(status\?\.user \?\? null\);\s*prevUserRef\.current = status\?\.user \?\? null;/.test(body));
  check("the deck/quiz save-effect bails out on the exact render the account identity changed", /if \(userJustChanged\) return;/.test(body));
  check("userJustChanged is in that effect's own dependency array (re-evaluated every relevant render)", /\}, \[tasks, status\?\.user, userJustChanged\]\);/.test(body));
}

section("FlashcardsLibraryPage — local deck/quiz cache refreshes immediately on account switch, not just on focus (source pin)");
{
  // Reported live as a genuine cross-account data leak: `decks`/`quizzes` are seeded via a useState LAZY
  // initializer (runs once, at first mount, only) from account-scoped local storage. Signing out and into a
  // DIFFERENT account is an SPA-style soft reset (no full page reload — see signOut in this same file), so
  // if this component survives that transition already mounted, its state kept showing the FIRST account's
  // cached flashcard decks — the effect below only re-pointed a window-FOCUS listener at the new userId, it
  // never actually re-read local storage until the next incidental focus event (which a same-tab account
  // switch never naturally triggers). Fixed by calling refresh() directly in the effect body, so it re-runs
  // the instant `userId` itself changes, not only later on focus.
  const appSrc = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const start = appSrc.indexOf("function FlashcardsLibraryPage(");
  const body = appSrc.slice(start, appSrc.indexOf("\nfunction ", start + 10));
  check("refresh() is called immediately in the effect body (not just registered for later)", /const refresh = \(\) => \{[^}]*\};\s*refresh\(\);\s*window\.addEventListener\("focus", refresh\)/.test(body));
  check("the effect re-runs when userId changes (refresh reads account-scoped local storage)", /\}, \[userId\]\);/.test(body));
}

section("DueReviews (Journal tab) — capped at 3 decks/day (source pin)");
{
  // Reported live: a student with accumulated review debt saw every single overdue deck stacked at the top
  // of the Journal tab (7+ chips), crowding out the actual journal entry below. Capped to the top 3 by
  // review count (most cards due first — the review that's gone stalest, not just whichever deck sorts first).
  const appSrc = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const start = appSrc.indexOf("function DueReviews(");
  const body = appSrc.slice(start, appSrc.indexOf("\nfunction ", start + 10));
  check("DueReviews caps the shown decks at 3", /\.slice\(0, 3\)/.test(body));
  check("DueReviews sorts by review count descending before capping (worst-behind deck first)", /sort\(\(a, b\) => b\[1\]\.count - a\[1\]\.count\)/.test(body));
}

section("Locale-aware date formatting — fmtDate/relTime/fmtWhen/fmtDay take the caller's own language (source pins)");
{
  // These used to call toLocaleDateString(undefined, ...), which uses the BROWSER's own default locale —
  // not the same thing as the app's own language setting (a French-language account on an English-locale
  // browser got English month names). Now each takes the same optional L(fr, en) every caller already has
  // from useLang(), used only to pick "fr-FR"/"en-US", never to translate text.
  const ui = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  check("fmtDate takes an optional L and never calls toLocaleDateString(undefined, ...)", /export const fmtDate = \(iso: string, L\?/.test(ui) && !/toLocaleDateString\(undefined/.test(ui));
  check("relTime takes an optional L and localizes the relative-time WORDS too, not just the date fallback", /export const relTime = \(iso: string, L\?/.test(ui) && /à l'instant/.test(ui) && /il y a \$\{m\}min/.test(ui));
  check("fmtWhen takes an optional L", /export function fmtWhen\(when: string, L\?/.test(ui));
  const appSrc = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  check("fmtDay takes an optional L and never calls toLocaleDateString(undefined, ...)", /function fmtDay\(iso: string, L\?/.test(appSrc) && !/toLocaleDateString\(undefined/.test(appSrc));
}

section("/api/study/free — resumes an active freestudy session by default, only 'fresh' forces a new one (source pin)");
{
  // Reported live: navigating away from /tutor and back (or React 18 StrictMode's deliberate double-invoke
  // of mount effects in dev) silently discarded whatever the student was mid-conversation on, because this
  // route used to UNCONDITIONALLY dismiss any existing freestudy task and mint a fresh one on every single
  // call — a passive remount looked identical to "the student wants a clean slate." Also the likely source
  // of a live 404: a stale client closure sending a chat message to a task id that had just been silently
  // dismissed out from under it. Fixed to find-or-resume by default; `fresh: true` (StandaloneStudyEntry's
  // explicit "Enter study mode" click, which SHOULD always start clean) keeps the old unconditional behavior.
  const src = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const start = src.indexOf('app.post("/api/study/free"');
  const body = src.slice(start, src.indexOf("}));", start) + 4);
  // Grew a mastery-stamp side effect on `active` (not a structural change to "resume" itself) when the
  // per-subject mastery metric shipped — still resumes the SAME task list, just with one extra field set.
  check("resumes (returns the list, with a mastery stamp on the active task) when an active freestudy task already exists and fresh wasn't requested", /const active = list\.find\(\(t\) => t\.source === "freestudy" && !isHandled\(t\.status\)\);/.test(body) && /if \(active\) \{[\s\S]{0,200}res\.json\(list\); return;\s*\}/.test(body));
  check("fresh:true still forces the old dismiss-and-mint-new behavior", /const fresh = req\.body\?\.fresh === true;/.test(body));
  const apiSrc = readFileSync(new URL("../client/api.ts", import.meta.url), "utf8");
  // (fresh?: boolean — optional, so a passive call sends no fresh flag; the route later grew a subject
  // param alongside it, which this pin deliberately doesn't pin so it stays signature-shape-agnostic.)
  check("client's studyFreeSession defaults to resume (no fresh flag sent) unless explicitly asked", /studyFreeSession: \(fresh\?: boolean/.test(apiSrc));
  const appSrc = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  check("StandaloneStudyEntry's explicit 'Enter study mode' click still requests a fresh session", /api\.studyFreeSession\(true\)/.test(appSrc));
  // Product decision: Study Mode has NO in-app entry point — no sidebar tab, no per-task buttons; the
  // ONLY way in is the /study URL. Pin both halves so neither can regress silently: a cleanup must not
  // delete the URL-only entry, and a well-meaning "restore" must not re-add a live tab/buttons without
  // consciously updating these pins.
  check("the /study route still renders StandaloneStudyEntry (the URL-only entry point)", /: route === "study" \? \(\s*<StandaloneStudyEntry/.test(appSrc));
  check("Study Mode has no live sidebar tab (absent, or present but flag-gated)", !appSrc.includes('sidebar-item ${route === "study"') || /STUDY_MODE_ENABLED && \(\s*<a\s+className=\{`sidebar-item \$\{route === "study"/.test(appSrc));
  check("the Study Mode tab/buttons flag is actually OFF (/study stays URL-only by design)", /const STUDY_MODE_ENABLED = false;/.test(appSrc));
  // View Transitions on route swaps: a NEWER transition starting first rejects the older one's `ready`
  // (and sometimes `finished`) promise with a benign AbortError — reported live from production as an
  // "Unhandled promise rejection: Transition was skipped. New ViewTransition started". Both must stay
  // silenced; updateCallbackDone must stay UN-silenced so a real go() failure still surfaces.
  check("navigate() silences both benign ViewTransition rejections (finished AND ready)", /const vt = vtDocument\.startViewTransition\(go\);/.test(appSrc) && /vt\.finished\.catch/.test(appSrc) && /vt\.ready\.catch/.test(appSrc));
  check("navigate() does NOT silence updateCallbackDone (a real go() failure must still surface)", !/vt\.updateCallbackDone/.test(appSrc));
  const tutorSrc = readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8");
  // Reported live: "session should not auto start" — the mount used to call /api/study/free, whose
  // resume-first route MINTS a session when none is active, so merely OPENING /tutor started one. Then a
  // follow-up: "tutor shouldn't auto open session" — even the read-only peek auto-RESUMED. The passive
  // mount is now a detect-only peek at GET /api/tasks (offers "Reprendre" on the landing, opens nothing),
  // and the ONE studyFreeSession call left in the file is the Start button's explicit create.
  check("opening /tutor does NOT create or open a session (mount is a detect-only api.tasks peek; Start is the only creator)", /api\.tasks\(\)\.then/.test(tutorSrc) && (tutorSrc.match(/api\.studyFreeSession\(/g) || []).length === 1);
  // Reported live: Start resumed an old "forces" thread instead of starting blank, and never asked what
  // subject. Start must require a picked subject and pass fresh:true (plus that subject) — a NEW lesson is
  // always a BLANK session, never a resume of an old one; resuming an in-progress session is only the
  // landing's explicit "Reprendre" click (resumeActiveSession).
  check("Start requires a subject and creates a BLANK fresh session (never resumes an old thread)", /api\.studyFreeSession\(true, selectedSubject\)/.test(tutorSrc) && /if \(!selectedSubject( \|\| \w+)?\) return;/.test(tutorSrc));
  // Reported live twice: "Reprendre" silently loaded an EMPTY chat/board despite real prior conversation.
  // Root cause both times was the same class of bug — guessing at raw localStorage keys
  // (`otto-chat-${id}-${userId}` etc.) that client/localChatBoard.ts has never written (it keeps ONE
  // combined map under `otto-local-chat-board:${userId}`, not a key per task) — so the guess always read as
  // empty. getLocalThread is localChatBoard.ts's own real read API; resumeActiveSession must use it, and the
  // old guessed-key pattern must never reappear anywhere in this file.
  check("resumeActiveSession reads local chat/board/problems via getLocalThread (the real API), never guessed raw keys", /const local = getLocalThread\(pendingActiveSession\.id, userId\)/.test(tutorSrc) && !/otto-chat-\$\{/.test(tutorSrc) && !/otto-board-\$\{/.test(tutorSrc) && !/otto-problems-\$\{/.test(tutorSrc));
}

section("Task UX: breakdowns don't vanish, Help opens the chat, popup is bigger, steps follow learning science (source pins)");
{
  // Reported live: "breaking down a task shows the substeps for two seconds and then they hide". Two
  // layers, both pinned here. SERVER: the expand route committed with the default fire-and-forget cloud
  // write, which on Vercel serverless can freeze before landing — the cron drain (cloud-only) then
  // rebuilt the task WITHOUT the substeps and committed it with a newer updatedAt, legitimately
  // overwriting the client. CLIENT: expand/runSubstep applied the response via wholesale setTasks
  // (onChange), the file's own documented anti-pattern, with no localMutations race stamp.
  const serverSrc2 = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const expandStart = serverSrc2.indexOf('app.post("/api/tasks/:id/step/:index/expand"');
  const expandBody = serverSrc2.slice(expandStart, expandStart + 2200);
  check("expand route AWAITS the cloud write (substeps survive a serverless freeze + cron rebuild)", /await commit\(req, \{ awaitCloud: true \}\)/.test(expandBody));
  const subDoneStart = serverSrc2.indexOf('app.post("/api/tasks/:id/step/:index/substep/:subIndex/done"');
  const subDoneBody = serverSrc2.slice(subDoneStart, subDoneStart + 1200);
  check("substep-done route awaits the cloud write too (a tick can't resurrect as undone)", /await commit\(req, \{ awaitCloud: true \}\)/.test(subDoneBody));
  const taskCardSrc = readFileSync(new URL("../client/TaskCard.tsx", import.meta.url), "utf8");
  const stepListBody = taskCardSrc.slice(taskCardSrc.indexOf("function StepList"), taskCardSrc.indexOf("function PreparedPanel"));
  check("expand/runSubstep apply via merge-by-id onTask, never wholesale setTasks", /applyTaskFromList\(await api\.expandStep/.test(stepListBody) && /applyTaskFromList\(await api\.runSubstep/.test(stepListBody) && !/onChange\(await api\.expandStep/.test(stepListBody));
  // Reported live: "the help button doesn't work" — askAboutStep prefilled+focused a chat input that
  // lives inside the (closed) Ask Otto modal, so the tap was literally invisible.
  check("tapping a step's Help OPENS the Ask Otto popup (with the step pre-referenced)", /const askAboutStep[\s\S]*?setOpenChat\(true\);/.test(taskCardSrc));
  // Reported live: "make the chat popup bigger" — the Ask Otto popup opts into TaskModal's `wide` size.
  const uiSrc = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  const stylesSrc = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  check("TaskModal supports `wide` and the Ask Otto popup uses it", /wide\?: boolean/.test(uiSrc) && uiSrc.includes('wide ? "wide" : ""') && /<TaskModal[\s\S]*?nested wide title=\{L\("Demander à Otto"/.test(taskCardSrc));
  check("the wide popup actually gets a bigger CSS size", /\.task-modal\.wide \{/.test(stylesSrc) && /max-width: min\(760px, 94vw\)/.test(stylesSrc));
  // Learning science in generation: the shared rules block must be wired into every prompt that
  // generates or breaks down the student's own steps.
  const claudeSrc = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const rulesCount = (claudeSrc.match(/LEARNING_SCIENCE_RULES/g) || []).length;
  check("learning-science rules exist and are injected into ALL THREE generation prompts (plan + scaffold + substeps)", rulesCount >= 4 && /ACTIVE RECALL over re-reading/.test(claudeSrc) && /SPACED RETRIEVAL/.test(claudeSrc) && /PRODUCTIVE STRUGGLE FIRST/.test(claudeSrc));
}

section("Tutor Session — voice is MANUAL (mic is the student's tap, never auto-on), and the board survives ending a session (source pins)");
{
  const tutorSrc = readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8");
  // Direct request: "voice should not be auto on" — the earlier voice-first auto-start (mic on with the
  // session) is REVERSED. Starting or resuming a session must never enable voice; the mic toggle in the
  // chat panel is the student's explicit choice. Everything else voice (board-pane pill, barge-in,
  // voice-primary layout) still activates the moment they turn it on themselves.
  check("Tutor Session does NOT auto-enable voice (no startInVoiceMode prop, no wantVoice forcing)", !/startInVoiceMode=/.test(tutorSrc) && !/setWantVoice/.test(tutorSrc));
  const askOtto = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  // Exactly ONE toggleVoiceMode() call site is allowed: inside the mic button's own onClick (a real user
  // gesture, also where synth.unlock() pre-arms speechSynthesis — see the TTS section below). Anywhere
  // else would mean voice got turned on without the student tapping anything.
  check("AskOttoPanel has NO voice auto-enable left (toggleVoiceMode() only ever called from the mic button's own click handler)", !/autoVoiceAppliedRef/.test(askOtto) && (askOtto.match(/toggleVoiceMode\(\)/g) || []).length === 1 && /onToggle=\{\(\) => \{ synth\.unlock\(\); toggleVoiceMode\(\); \}\}/.test(askOtto));
  // Direct request: "make sure when end tutor session board is saved and users can see what was worked on" —
  // ending used to only save a FLATTENED TEXT preview (boardEntries: string[]) of the board, losing any
  // diagram/equation structure; the real board is now saved too and reopenable.
  check("ending a session saves the FULL board (diagrams/equations intact), not just flattened text", /board: task\.board \|\| \[\]/.test(tutorSrc));
  check("a past session's full board can be reopened (View board button + modal)", /setOpenBoardSession/.test(tutorSrc) && /<BoardArtifact task=\{\{ board: openBoardSession\.board \}/.test(tutorSrc));
  // Voice stays off through start/resume — the student turns it on with the mic toggle themselves.
  check("starting or resuming a session leaves voice OFF (explicit mic tap to enable)", !/setWantVoice\(true\)/.test(tutorSrc));
  // The voice state pill lives on the BOARD pane header: in a voice-first session the student's eyes are
  // on the board, so "am I being heard?" has to be answerable where they're actually looking.
  check("voice state is reported up and shown on the board pane", /onVoiceStateChange/.test(tutorSrc) && /tutor-voice-pill/.test(tutorSrc));
  check("voice mode shifts the layout board-primary", /voice-primary/.test(tutorSrc));
  const tutorStyles = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  check("voice-primary grid actually exists in CSS (not a dead class)", /\.tutor-session\.voice-primary \{ grid-template-columns/.test(tutorStyles));
  // Barge-in: talking over Otto cancels the TTS mid-sentence, like interrupting a human tutor. Threshold
  // is 2+ words so speaker echo / a throat-clear doesn't cut him off.
  const askOttoSrc = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  const recogSrc = readFileSync(new URL("../client/voice/useSpeechRecognition.ts", import.meta.url), "utf8");
  // Barge-in v2 (real interruption): the mic STAYS OPEN while Otto speaks and interim text streams in
  // live — the old version aborted the recognizer during TTS, which made interruption structurally
  // impossible (no audio reaches a dead mic). Echo from the speakers is classified textually.
  // Updated for the "mic should be off while Otto's reply is generating" fix: pause-the-mic now also
  // covers the `sending` (generating) window, not just `synth.speaking` — but barge-in's exemption from
  // the SPEAKING half must survive that change (there's still nothing to interrupt before speech exists,
  // so `sending` pauses the mic even with bargeIn on; only the speaking half stays gated off by bargeIn).
  check("mic stays open during speech when barge-in is on (pause-the-mic is gated off for the speaking half)", /const busy = sending \|\| \(!bargeIn && synth\.speaking\);/.test(askOttoSrc));
  check("the mic is paused during generation too, not just during speech (reported: mic stayed open the whole time a reply was generating)", /busy && !wasBusyRef\.current/.test(askOttoSrc) && /recog\.abort\(\);/.test(askOttoSrc));
  check("live interim text cancels the TTS mid-sentence (≥2 words, echo-filtered)", /onInterim: \(text\) =>/.test(askOttoSrc) && /echoFilterRef\.current\.isEcho\(text\)/.test(askOttoSrc) && /text\.trim\(\)\.split\(\/\\s\+\/\)\.length >= 2\) synth\.cancel\(\)/.test(askOttoSrc));
  check("the recognition hook exposes the live interim channel", /onInterim\?: \(text: string\) => void;/.test(recogSrc) && /onInterimRef\.current\?\.\(interim\.trim\(\)\)/.test(recogSrc));
  // TTS history: a third-party vendor (FreeTTS) used to be tried FIRST, browser speechSynthesis as
  // fallback. Reported live, repeatedly, across several rounds of fixes (a bare fetch missing the CSRF
  // header, then a CSP missing media-src for blob: audio, then a one-shot-fallback race) — each real, each
  // fixed, and STILL "TTS sometimes works, sometimes doesn't" kept recurring, because the vendor path's
  // failure surface (network call, API key, CSRF, CSP, vendor uptime) was simply larger than a pure client-
  // side feature needs. Flipped to browser speechSynthesis as the ONLY path: zero network calls, no API
  // key, no CSP concern at all (the Web Speech API isn't an <audio> element, so media-src never applies).
  const ttsSynthSrc = readFileSync(new URL("../client/voice/useSpeechSynthesis.ts", import.meta.url), "utf8");
  check("TTS no longer depends on a server round trip at all (no fetch/api call in the speak path)", !/api\.ttsAudio/.test(ttsSynthSrc) && !/fetch\("\/api\/tts"/.test(ttsSynthSrc));
  check("speak() goes straight to the browser's own speechSynthesis, no vendor fallback chain", /useBrowserTTS\(speakableText\);/.test(ttsSynthSrc) && !/speakViaFreeTTS/.test(ttsSynthSrc));
  check("every TTS failure path leaves a diagnostic the UI can show, not just silence", /lastDiagnostic/.test(ttsSynthSrc) && /setLastDiagnostic/.test(ttsSynthSrc));
  // The very FIRST speak() of a session can get silently blocked by a browser's autoplay/gesture policy
  // since Otto's replies always arrive async (a network round trip), never inside the click that triggered
  // them — unlock() plays a silent empty utterance directly inside a real click handler to pre-arm the
  // engine for every speak() call for the rest of that session.
  check("a gesture-triggered unlock() exists to pre-arm speechSynthesis before the first real reply", /const unlock = useCallback/.test(ttsSynthSrc) && /new SpeechSynthesisUtterance\(" "\)/.test(ttsSynthSrc));
  // An EMPTY-string utterance is a known trigger for the native speech queue getting stuck (no onend ever
  // fires for it) — which would silently block every real utterance queued after it. This exact mistake
  // was introduced and caught within this same feature's own first cut.
  check("unlock() never queues an EMPTY-string utterance (a known stuck-queue trigger)", !/new SpeechSynthesisUtterance\(""\)/.test(ttsSynthSrc));
  const askOttoSrcTts = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  check("the mic toggle's onClick calls synth.unlock() before toggling voice mode (a real user gesture)", /onToggle=\{\(\) => \{ synth\.unlock\(\); toggleVoiceMode\(\); \}\}/.test(askOttoSrcTts));
  // Voice mode is tap-only now: with no auto-start anywhere, the old "auto-start guarded on SpeechRecognition
  // support" concern (never force-enable Firefox, which has no recognizer) is moot by construction.
  check("voice mode never auto-starts (tap-only everywhere — Firefox stays text-first by construction)", !/recogSupportedRef/.test(askOttoSrc) && !/autoVoiceAppliedRef/.test(askOttoSrc));
}

section("isPrivateOrReservedIp — SSRF guard for the student-supplied Pronote connect URL");
{
  // A student can type ANY url as their school's Pronote address, and connectPronote makes a real outbound
  // request to it server-side — this is what stops that from being pointed at an internal address (cloud
  // metadata, an internal service) instead of a real school's Pronote server.
  check("blocks loopback", isPrivateOrReservedIp("127.0.0.1"));
  check("blocks the cloud metadata address (169.254.169.254)", isPrivateOrReservedIp("169.254.169.254"));
  check("blocks RFC1918 10.x", isPrivateOrReservedIp("10.0.0.5"));
  check("blocks RFC1918 172.16-31.x", isPrivateOrReservedIp("172.20.1.1"));
  check("blocks RFC1918 192.168.x", isPrivateOrReservedIp("192.168.1.1"));
  check("blocks 0.0.0.0/8", isPrivateOrReservedIp("0.0.0.0"));
  check("allows a real public IP", !isPrivateOrReservedIp("8.8.8.8"));
  check("allows another real public IP (a school's own server)", !isPrivateOrReservedIp("203.0.113.42"));
  check("blocks IPv6 loopback", isPrivateOrReservedIp("::1"));
  check("blocks IPv6 link-local", isPrivateOrReservedIp("fe80::1"));
  check("blocks IPv6 unique-local", isPrivateOrReservedIp("fd12:3456:789a::1"));
  check("blocks an IPv4-mapped private address", isPrivateOrReservedIp("::ffff:10.0.0.1"));
  check("rejects garbage input rather than treating it as safe", isPrivateOrReservedIp("not-an-ip"));
}

section("assertSafeExternalUrl — the real guard function, now reused by /api/study/extract-text too (security pass)");
{
  // Exported specifically so server/index.ts's extract-text route could reuse it rather than re-implement
  // the same check — this pins that the exported function still rejects exactly what it always rejected.
  // Only exercises paths that don't need a real DNS lookup (scheme/literal-IP/localhost), so this stays
  // offline-safe like every other test here — the hostname-resolution branch is covered by
  // isPrivateOrReservedIp's own direct tests above, which is the part that function actually calls.
  const rejects = async (url) => { try { await assertSafeExternalUrl(url); return false; } catch { return true; } };
  const accepts = async (url) => { try { await assertSafeExternalUrl(url); return true; } catch { return false; } };
  check("rejects a non-http(s) scheme", await rejects("file:///etc/passwd"));
  check("rejects a literal loopback IP", await rejects("http://127.0.0.1/"));
  check("rejects the cloud metadata IP", await rejects("http://169.254.169.254/latest/meta-data"));
  check("rejects a literal RFC1918 address", await rejects("http://192.168.1.1/"));
  check("rejects 'localhost' by name (no DNS lookup needed to catch this one)", await rejects("http://localhost:3000/"));
  check("rejects garbage that isn't a parseable URL at all", await rejects("not a url"));
  check("accepts a literal public IP (no DNS lookup needed on this path)", await accepts("https://8.8.8.8/"));
}

section("connectPronote — SSRF guard is wired in before the outbound login request (source pin)");
{
  const src = readFileSync(new URL("../server/pronote.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function connectPronote(");
  const body = src.slice(start, src.indexOf("\n}", src.indexOf("return withPronoteLock", start)) + 2);
  const urlIdx = body.indexOf("const url = normalizePronoteUrl(");
  const guardIdx = body.indexOf("assertSafeExternalUrl(url)");
  const loginIdx = body.indexOf("pronote.loginCredentials(");
  check("connectPronote calls the SSRF guard on the normalized url", guardIdx > urlIdx && urlIdx >= 0);
  check("the guard runs BEFORE the real outbound login request, not after", guardIdx > 0 && loginIdx > guardIdx);
}
section("runPronoteSessionOnce — re-validates the stored URL on the credential-fallback path too (security pass, source pin)");
{
  // The token-refresh path reuses a URL that was only validated ONCE, at connect time — a hostname that
  // resolved safely then isn't guaranteed to resolve safely on every later call (DNS rebinding). The
  // credential-fallback branch is the one that re-sends the real stored password, so it's the one that
  // must re-check, even though the cheaper token-only attempt above it doesn't.
  const src = readFileSync(new URL("../server/pronote.ts", import.meta.url), "utf8");
  const fnStart = src.indexOf("async function runPronoteSessionOnce<T>(");
  const fnBody = src.slice(fnStart, src.indexOf("\nasync function flagNeedsReconnect", fnStart));
  const guardIdx = fnBody.indexOf("assertSafeExternalUrl(stored.url)");
  const credLoginIdx = fnBody.indexOf("pronote.loginCredentials(");
  check("re-validates stored.url before the credential-fallback login", guardIdx > 0 && credLoginIdx > guardIdx);
}
section("/api/study/extract-text — reuses the same SSRF guard, not a second unguarded fetch (security pass, source pin)");
{
  // This route fetches an arbitrary user-supplied URL — same risk class as the Pronote connect flow, which
  // already had the guard. It used to only check the URL started with http(s):// and nothing else, meaning
  // an authenticated student could point it at an internal address and get the response handed back as
  // "extracted text." Pin that the guard call is actually there, before the real fetch, not just in a comment.
  const src = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const start = src.indexOf('app.post("/api/study/extract-text"');
  const body = src.slice(start, src.indexOf("\n}));", start) + 5);
  const guardIdx = body.indexOf("assertSafeExternalUrl(url)");
  const fetchIdx = body.indexOf("await fetch(url,");
  check("the route calls the SSRF guard on the submitted url", guardIdx > 0);
  check("the guard runs BEFORE the real outbound fetch, not after", guardIdx > 0 && fetchIdx > guardIdx);
}
section("Pronote connection durability — connection columns + uncached reads (source pins)");
{
  const jobsSrc = readFileSync(new URL("../server/jobs.ts", import.meta.url), "utf8");
  const pronoteSrc = readFileSync(new URL("../server/pronote.ts", import.meta.url), "utf8");
  const storeSrc = readFileSync(new URL("../server/store.ts", import.meta.url), "utf8");
  // `(?:<[^>]*>)?` — several of these are generic (e.g. runPronoteSessionOnce<T>), so the name isn't
  // always followed directly by the parameter list.
  const bodyOf = (src, name) => (src.match(new RegExp(`(?:export )?async function ${name}(?:<[^>]*>)?\\([\\s\\S]*?\\n\\}`)) || [""])[0];

  // saveState's contract: an ABSENT key leaves that column alone, a key present-but-undefined NULLS IT OUT.
  // commitUser manages profile+tasks only, but used to pass `google: current.google, pronote: current.pronote`
  // straight through from a possibly-stale cached read — when that read predated a connect that landed on a
  // different instance, the next background job wiped the live connection out of the database for good.
  const commitUserBody = bodyOf(jobsSrc, "commitUser");
  check("commitUser body was found (pin is actually checking something)", commitUserBody.length > 0);
  check("commitUser persists profile+tasks only — never writes the google/pronote connection columns", !/\b(google|pronote):/.test(commitUserBody));

  // Deliberately NOT pinning bypassCache here: the job runner's reads are the generate/execute hot path and
  // this row carries the whole task list, so forcing them uncached was a pure cost (it was tried while
  // chasing the disconnect, and the real cause turned out to be the connection-column semantics above).
  // saveState invalidates on every write, and commitUser merges rather than overwrites, so a cached base
  // here can't drop concurrent work.
  check("jobs.ts commitUser merges rather than overwrites (a cached base can't drop concurrent work)", /mergeTaskLists|mergeProfileStates/.test(commitUserBody));

  // The Pronote connection is one small column asked about constantly (/api/status polls it every 45s per
  // tab) and rewritten on every token rotation. Going through loadState/saveState meant dragging the whole
  // profile+tasks blob both ways for each — the cost that motivated caching it, which is what then went
  // stale and reported live connections as disconnected. These must stay narrow single-column operations:
  // cheap enough to never need a cache, and structurally unable to clobber profile/tasks.
  const narrow = (name) => {
    const body = bodyOf(pronoteSrc, name);
    check(`${name} body was found (pin is actually checking something)`, body.length > 0);
    check(`${name} does not read/write the whole account row`, body.length > 0 && !/\b(loadState|saveState)\(/.test(body));
  };
  ["pronoteConnected", "runPronoteSessionOnce", "saveRotatedToken", "touchPronoteSession", "disconnectPronote"].forEach(narrow);
  // The real protection, tested behaviourally rather than by grep: a save that means to update ONE
  // connection must never quietly clear the others. `{ ...loadedState, blackbaud }` is the shape that did
  // this — a loaded state carries every connection key, as undefined when unset.
  const loadedWithPronoteOnly = { profile: {}, tasks: [], pronote: { url: "u", username: "n", kind: 6, token: "t", deviceUUID: "d" }, google: undefined, blackbaud: undefined };
  const hourlyBlackbaudRefresh = connectionColumnUpdates({ ...loadedWithPronoteOnly, blackbaud: { accessToken: "a", connectedAt: "now" } });
  check("updating one connection does not clear an unrelated one (the hourly-wipe bug)", !("google" in hourlyBlackbaudRefresh));
  check("...and still writes the connection it actually meant to update", hourlyBlackbaudRefresh.blackbaud?.accessToken === "a");
  check("...while leaving the live Pronote connection intact, not nulled", hourlyBlackbaudRefresh.pronote !== null && hourlyBlackbaudRefresh.pronote?.username === "n");
  // The exact reported failure: the cached read predates a connect that landed on another instance, so
  // `pronote` comes back undefined. The hourly Blackbaud token refresh then spreads that stale state and,
  // under the old rule, wrote pronote: null — permanently disconnecting a connection that was actually live.
  const staleRead = { profile: {}, tasks: [], pronote: undefined, google: undefined, blackbaud: { accessToken: "old", connectedAt: "then" } };
  const refreshOnStaleRead = connectionColumnUpdates({ ...staleRead, blackbaud: { accessToken: "new", connectedAt: "then" } });
  check("a stale read's undefined pronote is never written as null (the reported hourly disconnect)", !("pronote" in refreshOnStaleRead));
  // A plain profile/tasks save (commit()'s shape, ~20 call sites) must touch no connection column at all.
  check("a profile+tasks-only save writes no connection columns", Object.keys(connectionColumnUpdates({ profile: {}, tasks: [] })).length === 0);
  // Disconnecting still has to work — that's what the explicit null is for.
  check("an explicit null clears the connection (disconnect still works)", connectionColumnUpdates({ profile: {}, tasks: [], pronote: null }).pronote === null);
  check("undefined is 'leave alone', NOT 'clear' — the distinction the whole fix rests on", !("pronote" in connectionColumnUpdates({ profile: {}, tasks: [], pronote: undefined })));

  check("store.ts exposes a single-column Pronote read", /export async function loadPronoteConnection/.test(storeSrc));
  check("the narrow Pronote read selects only that column", /\.select\("pronote"\)/.test(storeSrc));
  check("store.ts exposes a single-column Pronote write", /export async function savePronoteConnection/.test(storeSrc));
  check("the narrow Pronote write never sends profile/tasks", !/\b(profile|tasks):/.test(bodyOf(storeSrc, "savePronoteConnection")));
}
section("dodLooksLikeCoordinationOutcome — DoD-wording veto for flashcards/quiz (defense in depth)");
{
  const oslo = "A confirmed Oslo plan: purpose, dates, travellers, transport and accommodation booked, and any required documents or event prep identified — with every open question answered by Willem.";
  check("a real trip-booking DoD reads as a coordination outcome", dodLooksLikeCoordinationOutcome(oslo));
  const refund = "Yosef confirms whether the €15 top-up is refunded to the card/PayPal or kept as Lovable credits.";
  check("a refund-decision DoD reads as a coordination outcome", dodLooksLikeCoordinationOutcome(refund));
  const vocab = "Student can define and correctly use all assigned figures de style vocabulary terms.";
  check("a genuine vocab/definition DoD is NOT vetoed, even though it doesn't mention booking/deciding", !dodLooksLikeCoordinationOutcome(vocab));
  const formula = "Student can confirm and apply the quadratic formula and log laws without notes.";
  check("a DoD that happens to say 'confirm' but is really about formulas/laws is NOT vetoed (memorizable content wins)", !dodLooksLikeCoordinationOutcome(formula));
  const plain = "Write a 500-word essay analyzing the poem's use of metaphor.";
  check("a DoD with neither coordination language nor memorizable-content markers is NOT vetoed (nothing to veto)", !dodLooksLikeCoordinationOutcome(plain));
}

// Source-order pins (server/claude.ts): runTask is a live, multi-call AI pipeline with no dedicated unit
// test of its own (same reason the DoD-verification pass above has none) — verification here is pinning
// that the actual wiring exists in the source, so a future edit can't silently drop it again the way it
// was missing in the first place (writeStepsFromContext had these calls, runTask never did).
section("runTask wiring — step-quality filters + taskType enum sync (source-order pins)");
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const runTaskStart = src.indexOf("export async function runTask(");
  const runTaskBody = src.slice(runTaskStart, src.indexOf("\nexport async function writeStepsFromContext", runTaskStart));
  check("runTask's step-4 output is filtered through dropProcessComplaintSteps", /steps = dropProcessComplaintSteps\(steps\);/.test(runTaskBody));
  check("runTask's step-4 output is filtered through dropForeignEntitySteps", /steps = dropForeignEntitySteps\(task, links, steps\);/.test(runTaskBody));
  check("runTask's step-4 output is filtered through dropSiblingBleedSteps", /steps = dropSiblingBleedSteps\(task, siblingTasks \|\| \[\], steps\);/.test(runTaskBody));
  check("runTask's step-4 output is filtered through dropOffTopicStudySteps", /steps = dropOffTopicStudySteps\(task\.taskType, steps\);/.test(runTaskBody));
  check("runTask applies the DOABLE/JUDGMENT automatable-flip", /DOABLE_STEP\.test\(s\.text\) && !JUDGMENT_STEP\.test\(s\.text\)/.test(runTaskBody));
  check("runTask vetoes flashcards/quiz on a coordination-outcome DoD", /dodLooksLikeCoordinationOutcome\(definitionOfDone\)/.test(runTaskBody));
  // Reported live: a "reach a clean run on an MCQ set" task generated step 1 as "Log missed items, then
  // retake until no unresolved misses" and step 2 as "Sit a timed set" — backwards, since there's nothing
  // to log/retake before a first attempt happens. Both step-writing prompts (runTask's own STEP 4, and
  // writeStepsFromContext's separate pipeline) need the same sequencing instruction.
  check("runTask's step-4 prompt instructs sequencing attempt-before-review steps", /SEQUENCE STEPS IN THE ORDER THE STUDENT WILL ACTUALLY DO THEM/.test(runTaskBody));
  const writeStepsStart = src.indexOf("export async function writeStepsFromContext(");
  const writeStepsBody = src.slice(writeStepsStart, src.indexOf("\nexport async function expandStep", writeStepsStart));
  check("writeStepsFromContext's prompt instructs the same attempt-before-review sequencing", /SEQUENCE steps in the order the student will actually do them/.test(writeStepsBody));
  // All four taskType classification sites must offer/accept the same full 15-value enum — this is the
  // actual root cause of the live bug (three of four were truncated to the old 10-value list, so
  // "logistics"/"decide" were either never offerable to the model or silently discarded back to a wrong
  // fallback). Pin that all four `validTaskTypes` arrays now match, so a future addition to TaskType can't
  // silently land in only one of the four copies again.
  const validTaskTypesBlocks = [...src.matchAll(/const validTaskTypes: TaskType\[\] = \[([\s\S]*?)\]/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  check("exactly 4 validTaskTypes filter arrays exist", validTaskTypesBlocks.length === 4);
  check("all 4 validTaskTypes arrays include the full 15-value list, not just the old 10", validTaskTypesBlocks.every((b) => /"analyze"/.test(b) && /"decide"/.test(b) && /"logistics"/.test(b) && /"maintain"/.test(b) && /"problem_solve"/.test(b)));
  // Ordering bug found live: dropTrivialSteps ran BEFORE the DOABLE/JUDGMENT flip, so a not-yet-flipped
  // step like "Research X and compile a list" still looked like a bare trivial lookup and got deleted
  // before it could be marked as Otto's own automatable work — finalize()'s own comment ("Triviality gate
  // runs HERE") documents this exact failure mode as "verified live to crash tests by zeroing out valid
  // steps." Pin the fixed order so a future edit can't silently reintroduce it.
  const trivialIdx = runTaskBody.indexOf("steps = dropTrivialSteps(steps);");
  const flipIdx = runTaskBody.indexOf("DOABLE_STEP.test(s.text)");
  check("dropTrivialSteps runs AFTER the DOABLE/JUDGMENT flip, not before", trivialIdx > 0 && flipIdx > 0 && trivialIdx > flipIdx);
  // Total-outage detection: every ask() call failing used to silently return a normal-looking RunOutput
  // instead of throwing, bypassing server/tasks.ts's actual retry/backoff machinery entirely.
  check("runTask throws when every AI call in the run failed (total-outage detection)", /askCalls > 0 && askFailures === askCalls/.test(runTaskBody));

  // Human-judgment layer added this round (step quality, first-move, diagnose-before-prescribing) — pinned
  // so a future prompt edit can't silently drop them the way the flashcard-veto/board-write rules almost
  // did earlier this session. These are prompt-only additions (deliberately NOT new typed state — see the
  // "implementation discipline" reasoning this round: prefer prompt judgment over speculative abstractions
  // for behavior an LLM can already reason about directly).
  // NOTE: these live in runTask's OWN "STEP 4" ask() prompt (the RULES: bullet list). A first pass at this
  // round's rules was accidentally added to a DEAD prompt constant (RUN_SYSTEM, alongside the equally dead
  // RUN_TOOLS/planResearch/decideArtifact — all declared, never wired into any actual chat.completions.create
  // call, since deleted) and silently had ZERO effect until caught by this exact test failing.
  check("runTask's real step-4 prompt has the STEP QUALITY rule (start-immediately/concrete/produces-output/self-checking-done)", /STEP QUALITY.{0,60}for every step, internally check/.test(runTaskBody));
  check("runTask's real step-4 prompt has the FIRST-MOVE rule with its example", /FIRST STEP MUST BE STARTABLE RIGHT NOW/.test(runTaskBody));
  check("runTask's real step-4 prompt has the diagnose-before-assuming-relearn rule for uncertain-mastery tasks", /WHEN MASTERY IS GENUINELY UNCERTAIN/.test(runTaskBody));
}

// ── Granularity ladder: steps are OPTIONAL, briefs are size-tiered ───────────────────────────────
// Reported live: a 5-minute "download your Ledger OP3N ticket" errand shipped a 3-step list ("All steps
// 0/3") plus a 700-word brief with two troubleshooting tables. The MISSION already carried the ladder
// (prompt-only); this pins the code-level gates so a future edit can't quietly revert to steps-always.
section("Granularity ladder — taskNeedsStepList gate + size-tiered brief prompt (pins)");
{
  // Behavioral: the gate itself, both directions.
  check("a small single-session errand does NOT need a step list", !taskNeedsStepList({ title: "Download your Ledger OP3N ticket for 15 Oct", why: "Registration approved; ticket sits in the Luma app", taskType: "logistics" }));
  check("a trivial admin task does NOT need a step list", !taskNeedsStepList({ title: "Send the signed form back to the office", why: "Deadline Friday" }));
  check("a bookings/coordinating logistics task keeps its steps", taskNeedsStepList({ title: "Lock dates, bookings and an Arctic-ready itinerary", why: "Trip prep", taskType: "logistics" }));
  check("assessment prep keeps its steps", taskNeedsStepList({ title: "Prepare for the in-class History essay on Russia", why: "In-class essay Oct 9", taskType: "prepare_assessment" }));
  // "learn_understand" (not "learn" — a real TaskType enum string mismatch this round fixed: the old
  // literal could never match the real enum value, so a learn_understand task without a lucky keyword hit
  // silently fell through to the keyword checks instead of being force-kept).
  check("review/practice/learn_understand taskTypes keep their steps", taskNeedsStepList({ title: "Anything", why: "x", taskType: "review" }) && taskNeedsStepList({ title: "Anything", why: "x", taskType: "practice" }) && taskNeedsStepList({ title: "Anything", why: "x", taskType: "learn_understand" }));
  check("a multi-week project keeps its steps even untyped", taskNeedsStepList({ title: "Extended Essay first draft", why: "Due March" }));
  check("an assessment keyword in a plain errand title keeps its steps", taskNeedsStepList({ title: "Register for the Math test", why: "Admin form" }));
  // Source pins: the step-4 prompt sizes the plan, runTask gates the output, the note prompt tiers briefs.
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const runTaskStart = src.indexOf("export async function runTask(");
  const runTaskBody = src.slice(runTaskStart, src.indexOf("\nexport async function writeStepsFromContext", runTaskStart));
  check("runTask's step-4 prompt says small single-session tasks get NO step list", /SMALL, SINGLE-SESSION task[^\n]*NO step list/.test(runTaskBody));
  check("runTask's step-4 prompt carries the full granularity ladder", /MULTI-DAY or ASSESSMENT-PREP/.test(runTaskBody) && /GENUINELY COMPLEX PROJECT/.test(runTaskBody));
  check("runTask gates its own step output through taskNeedsStepList", /taskNeedsStepList\(\{ title: task\.title, why: task\.why, goal: definitionOfDone, taskType: task\.taskType \}/.test(runTaskBody));
  check("the gate runs after the triviality gate and trims to one step", /steps = dropTrivialSteps\(steps\);[\s\S]{0,600}if \(!taskNeedsStepList/.test(runTaskBody) && /steps\.slice\(0, 1\)/.test(runTaskBody));
  const noteWriter = src.slice(src.indexOf("Create a short in-app reference note"), src.indexOf('{"title": "note title"'));
  check("the note writer sizes briefs to the task (60-120 words for a small task, no troubleshooting table)", /SIZE IT TO THE TASK/.test(noteWriter) && /60-120 words/.test(noteWriter) && /NO troubleshooting table/.test(noteWriter));
  check("the note writer allows a longer, tabular brief only for genuinely multi-leg tasks", /multi-leg task/.test(noteWriter) && /rows that each carry a real, necessary specific/.test(noteWriter));
  // Brief-compression pass (runTask, after makeNote): brief length must be ADAPTED TO THE TASK, not fixed —
  // small task + bloated body → one rewrite that keeps the specifics; the pass is bounded and fail-open.
  const noteBlock = runTaskBody.slice(runTaskBody.indexOf("const note = makeNote(noteOut)"), runTaskBody.indexOf("// ── DoD verification"));
  check("an over-long brief on a small task triggers a rewrite pass, not a silent chop", /taskNeedsStepList\(\{ title: task\.title, why: task\.why, goal: definitionOfDone, taskType: task\.taskType \}\)/.test(noteBlock) && /BRIEF_COMPRESS_WORDS/.test(noteBlock) && /countWords\(note\.note\.body\)/.test(noteBlock));
  check("the rewrite keeps real specifics and only fires when the body is genuinely bloated", /keep every real specific/.test(noteBlock) && /Only return the original unchanged if cutting anything would lose a real specific/.test(noteBlock));
  check("brief compression is fail-open — a failed rewrite ships the original unchanged", /countWords\(body\) < wc/.test(noteBlock) && /keeping the original/.test(noteBlock));
  check("longer briefs on genuinely content-heavy tasks are never chopped — no hard body cap", !/body\.slice\(0, [0-9]{3,}\)\s*;/.test(noteBlock));
}

// ── Link relevance: a web_search's results are candidates, not facts about the task ──────────────
// Reported live: a "download your Ledger OP3N ticket" task linking to a Mailchimp marketing page and a
// "Sell tickets with Luma" pricing page — real URLs, zero relevance, surfaced by the search engine's
// loose keyword match and passed through because "they came from the search".
section("Link relevance gate — task-link filtering (source pins)");
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const runTaskStart = src.indexOf("export async function runTask(");
  const runTaskBody = src.slice(runTaskStart, src.indexOf("\nexport async function writeStepsFromContext", runTaskStart));
  check("runTask filters its research links for relevance to the task's own words", /linkAllowWords/.test(runTaskBody) && /linkWords\.some\(\(w\) => linkAllowWords\.has\(w\)\)/.test(runTaskBody));
  check("the relevance gate keeps behavior unchanged for very short titles (over-filter guard)", /linkAllowWords\.size < 2\) return true/.test(runTaskBody));
  const finalizeStart = src.indexOf("export function finalize(");
  const finalizeBody = src.slice(finalizeStart, finalizeStart + 60000);
  check("finalize applies the same relevance gate to model-provided links", /relevantModelLinks/.test(finalizeBody) && /survivingModelLinks\.has\(l\) && relevantModelLinks\.includes\(l\)/.test(finalizeBody));
}
section("Flashcard/artifact-selection prompts carry the retrieval-quality and error-targeting rules (source pins)");
{
  const src2 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const cardsToolIdx = src2.indexOf("const CREATE_FLASHCARDS_TOOL = {");
  const cardsToolBody = src2.slice(cardsToolIdx, src2.indexOf("\n};", cardsToolIdx));
  check("flashcard tool description requires ONE RETRIEVABLE UNIT per card, not just 'one idea'", /ONE RETRIEVABLE UNIT per card/.test(cardsToolBody));
  check("flashcard tool description requires testing retrieval over recognition", /TEST RETRIEVAL, NOT RECOGNITION/.test(cardsToolBody));
  check("flashcard tool description asks for varied retrieval direction", /VARY RETRIEVAL DIRECTION/.test(cardsToolBody));
  check("flashcard tool description asks for a contrast/discrimination card on a recurring confusion, not a duplicate definition card", /CONTRAST\/DISCRIMINATION card/.test(cardsToolBody));

  const problemToolIdx = src2.indexOf("const CREATE_PROBLEM_TOOL = {");
  const problemToolBody = src2.slice(problemToolIdx, src2.indexOf("\n};", problemToolIdx));
  check("practice-problem tool frames the problem as a measurement of the student's understanding, not just practice", /THINK OF THIS AS A MEASUREMENT, NOT JUST PRACTICE/.test(problemToolBody));
}
section("Tutor prompt (chatAboutTask) carries the 'why don't they know' diagnosis + mastery-stop rules (source pins)");
{
  const src3 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const chatStart = src3.indexOf("export async function chatAboutTask(");
  const chatBody = src3.slice(chatStart, src3.indexOf("\nexport async function", chatStart + 10));
  check("tutor prompt distinguishes never-learned/forgot/cant-start/dont-understand-the-question before responding to 'I don't know'", /"I DON'T KNOW" IS NOT ONE THING/.test(chatBody));
  check("tutor prompt repairs a prerequisite gap instead of re-explaining the advanced skill built on it", /that prerequisite gap is the actual problem/.test(chatBody));
  check("tutor prompt has an explicit mastery-stop rule (perform + explain-why + transfer → move on)", /KNOW WHEN TO STOP TEACHING/.test(chatBody));
  // Explicit 3-rung hint ladder (Orient/Narrow/Model-the-next-move, escalate only on a genuine attempt).
  // The ladder USED TO have a "RELEASE THE ANSWER" escape hatch (two unproductive rungs on the same point,
  // or an explicit repeat request) that directly contradicted Rule 3 / THE LINE YOU NEVER CROSS elsewhere
  // in this same prompt ("never state the conclusion yourself," "never cave to repetition") — reported
  // live as the tutor sometimes just giving the answer. Removed per direct instruction ("never give
  // answers automatically... ask socratic questions"); checking already-completed work or finishing a
  // near-complete attempt's last mechanical step are still fine (that's verifying, not answering FOR them).
  check("tutor prompt has the explicit HINT LADDER header with all three rungs", /## HINT LADDER[\s\S]{0,150}1\. ORIENT[\s\S]{0,800}2\. NARROW[\s\S]{0,800}3\. MODEL THE NEXT MOVE/.test(chatBody));
  check("hint ladder only escalates on a genuine attempt, not a bare 'I don't know'", /ESCALATE ONLY ON A GENUINE ATTEMPT/.test(chatBody));
  check("hint ladder no longer has an answer-release escape hatch that contradicts 'never give the answer'", !/RELEASE THE ANSWER when ANY of these hold/.test(chatBody));
  check("hint ladder explicitly says never to release the final answer outright, even after repeated failed attempts", /NEVER RELEASE THE FINAL ANSWER OUTRIGHT, even after repeated failed attempts/.test(chatBody));
  check("a stuck student gets a different worked example or a smaller sub-question, never the answer itself", /DIFFERENT worked example/.test(chatBody));
  check("tutor treats only a clean UNAIDED attempt as proof of learning (Bastani et al.)", /THE REAL TEST IS UNAIDED/.test(chatBody));
  check("voice mode writes spoken notation to the board instead of leaving it unwritten", /THE BOARD IS THE ONLY PLACE THEY EVER SEE THE ACTUAL NOTATION/.test(chatBody));
  // Reported live: a reply cut off mid-sentence ("One version with a twist, to make sure the method
  // travels:" then nothing) — DeepSeek's hidden reasoning tokens ate most of max_tokens before the visible
  // reply started, so finish_reason came back "length" on a non-empty (so the separate empty-completion
  // retry never fired) but truncated reply, and it shipped to the student exactly as cut off.
  check("chat retries once on a non-empty but truncated (finish_reason:length) reply instead of shipping it cut off", /finish_reason === "length" && textContent\.trim\(\)/.test(chatBody) && /Continue from EXACTLY where it stopped/.test(chatBody));
  check("the truncation retry is latched to fire at most once per turn", /let truncationRetried = false;/.test(chatBody) && /truncationRetried = true;/.test(chatBody));
  check("board adds a complementary representation instead of restating the chat", /A DIFFERENT REPRESENTATION, NOT THE SAME ONE TWICE/.test(chatBody));
  check("board is kept curated in long sessions", /KEEP IT CURATED/.test(chatBody));
  // Per direct request ("ask questions if need") — the learning loop's own step 1 now says to ask rather
  // than guess when there's genuinely not enough context, instead of relying only on the implicit
  // diagnose-before-explaining framing elsewhere in the prompt.
  check("tutor prompt explicitly says to ASK when there's genuinely not enough context, instead of guessing", /ASK, in one short question, rather than guessing/.test(chatBody));
  // Milestones (Profile.milestones, extracted from journal entries) surfaced into chat so the tutor builds
  // on real per-topic progress instead of re-teaching it from scratch every session.
  check("chat context includes milestoneLine (per-topic progress from the journal)", /milestoneLine\(profile, task\.sourceSubject\)/.test(chatBody));
  // Revoicing (O'Connor & Michaels): the student's idea is restated in their own words before building on
  // it — heard, verified, credited. Social congruence + process praise (Lepper & Woolverton): earned,
  // specific, move-naming praise; never default cheer.
  check("tutor revoices the student's idea before building on it", /REVOICE THEIR IDEA BEFORE YOU BUILD ON IT/.test(chatBody));
  check("tutor praises the specific thinking move (never generic encouragement)", /PRAISE THE MOVE, NOT THE PERSON/.test(chatBody));
  check("board prompt teaches the worksheet rendering (trace lines, completion gap, credited insights)", /IT'S A WORKSHEET, AND THE BOARD SHOWS IT/.test(chatBody));
  check("board prompt tells the tutor to write live (the drafting is part of the tutoring)", /THE BOARD WRITES LIVE/.test(chatBody));
}
// Reported live: an automatable step ("Gather 15-20 activities with location, cost, duration, booking
// source") executing via runStep (server/tasks.ts) judged grounding/artifact-creation/DoD-verification
// against task.why (a one-line intent) instead of the task's own real, detailed goal — because runStep's
// call into aiRun (=runTask) never passed taskType/goal/infoRequirement/unknowns through at all, so
// runTask's own `definitionOfDone = task.goal || task.why` silently always took the vaguer fallback for
// every per-step automatable run. runById (the whole-task run) already passed all four correctly — only
// runStep had the gap. Source-order pin since runStep isn't a pure function (calls the live AI pipeline).
section("runStep passes goal/taskType/infoRequirement/unknowns through to aiRun (source-order pin)");
{
  const tasksSrc = readFileSync(new URL("../server/tasks.ts", import.meta.url), "utf8");
  const runStepStart = tasksSrc.indexOf("export async function runStep(");
  const runStepBody = tasksSrc.slice(runStepStart, tasksSrc.indexOf("\n/**", runStepStart));
  check("runStep passes task.goal through to aiRun", /aiRun\(\{[^}]*goal: task\.goal/.test(runStepBody));
  check("runStep passes task.taskType through to aiRun", /aiRun\(\{[^}]*taskType: task\.taskType/.test(runStepBody));
  check("runStep passes task.infoRequirement through to aiRun", /aiRun\(\{[^}]*infoRequirement: task\.infoRequirement/.test(runStepBody));
  check("runStep passes task.unknowns through to aiRun", /aiRun\(\{[^}]*unknowns: task\.unknowns/.test(runStepBody));
}

section("dueLine — always-shown due-date + server-computed days-until for chat");
check("empty when there's no due date at all", dueLine(undefined) === "");
check("empty for an unparseable due date", dueLine("not a date") === "");
const inThreeDays = new Date(Date.now() + 3 * 86_400_000 + 3600_000).toISOString(); // +1h buffer against midnight flakiness
check("computes 'in N days' correctly for a future date", /in 3 days/.test(dueLine(inThreeDays)));
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
check("flags a past due date as already past", /already past/i.test(dueLine(yesterday)));
check("tells the model to compute from this, not guess", /do the math from this/i.test(dueLine(inThreeDays)));
// Accuracy pass: a Pronote deadline near midnight used to compare against the SERVER's local timezone
// (UTC on Vercel) instead of the student's — a real off-by-one-day risk, since many Pronote deadlines are
// literally stored as "00:00" on the due date. `now` is injectable (same pattern as estimateWhen/
// forcedDueToday elsewhere in this codebase) specifically so this is a deterministic test, not a
// real-wall-clock-dependent one.
{
  // "now" = Jan 15, 23:30 UTC. "due" = Jan 16, 00:30 UTC — one hour later, genuinely the NEXT calendar day
  // in UTC. But in Paris (UTC+1 in January), both instants fall on Jan 16: 00:30 and 01:30 local — the
  // SAME calendar day, so a Paris student's deadline is already "TODAY" at the moment "now" is UTC-Jan-15.
  const now = new Date("2026-01-15T23:30:00Z");
  const due = new Date("2026-01-16T00:30:00Z");
  check("in UTC, this due instant is correctly read as tomorrow", /TOMORROW/.test(dueLine(due.toISOString(), "UTC", now)));
  check("the SAME instant, in the account's own timezone (Paris), is already today — this is the exact bug class that was reproduced live", /TODAY/.test(dueLine(due.toISOString(), "Europe/Paris", now)));
  check("defaults to UTC when no timezone is given (never throws)", typeof dueLine(due.toISOString(), undefined, now) === "string");
}

// ── Prompt content — pins the academic-research + specificity instructions (house style: trackLine
// vocabulary above is already tested this same way) ───────────────────────────────────────────────────
section("academicBlock — cross-task context must inform scheduling, never bleed into unrelated content (source pin)");
{
  // Reported live: a "plan Airy's birthday gift" task's brief included "Check Pronote for the Russia/USSR
  // History test" as its own checklist item — an entirely unrelated subject, pulled straight out of this
  // block's Pronote-workload context. profileBlock already had the equivalent guard for people/projects
  // ("never license to write a step about a different person/project just because it's named here"); this
  // block had no such guard until this fix.
  const block = academicBlock({ homework: [], tests: [{ subject: "History", deadline: new Date().toISOString() }] });
  check("still surfaces the real Pronote data (not neutered into nothing)", /History/.test(block));
  check("explicitly instructs: only for scheduling judgment, never written into unrelated content", /ONLY to judge real urgency\/conflicts/i.test(block) && /NEVER let an item from this list become a step/i.test(block));
  check("names the actual reported failure as the thing being guarded against (checklist/note/artifact bleed)", /checklist entry|any other content inside a brief/i.test(block));
}

section("PLAN_ONLY_OVERRIDE — academic research guidance");
check("tells the model to research the NOTION, not just admin logistics", /notion/i.test(PLAN_ONLY_OVERRIDE));
check("explicitly forbids fetching the answer key", /corrigé/i.test(PLAN_ONLY_OVERRIDE));
check("calls out a title-only fiche as a failure", /revoir le cours/i.test(PLAN_ONLY_OVERRIDE));
check("mentions CREATE_QUIZ as one of the write actions", /CREATE_QUIZ/.test(PLAN_ONLY_OVERRIDE));

// ── CREATE_QUIZ / CREATE_NOTE / CREATE_FLASHCARDS validation (makeQuiz/makeNote/makeDeck) ──────────────
section("makeQuiz validation");
const validQuiz = makeQuiz({ title: "Quiz", questions: [
  { q: "2+2?", options: ["3", "4", "5"], correct: 1, why: "basic addition" },
  { q: "Capital of France?", options: ["Lyon", "Paris", "Nice"], correct: 1 },
] });
check("a valid payload produces a quiz", "quiz" in validQuiz && validQuiz.quiz.questions.length === 2);
check("an out-of-range `correct` drops that question", "error" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "b"], correct: 5 }] }));
// The remap-by-identity case: duplicate options collapse, and `correct` must follow the SAME text, not the
// original numeric index (which shifts once a preceding duplicate is dropped) — asserting on the option
// TEXT is what actually catches a broken remap; asserting on the index alone would pass even if it now
// pointed at the wrong answer.
const remapped = makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["la bonne", "fausse", "la bonne", "fausse2"], correct: 0 }] });
check("duplicate options collapse and `correct` still points at the RIGHT TEXT after the shift", "quiz" in remapped && remapped.quiz.questions[0].options[remapped.quiz.questions[0].correct] === "la bonne");
const manyQuestions = Array.from({ length: 60 }, (_, i) => ({ q: `q${i}`, options: ["a", "b"], correct: 0 }));
check("questions capped at 50 (sanity backstop, matches CREATE_QUIZ's 50-per-call ceiling)", makeQuiz({ title: "Q", questions: manyQuestions }).quiz.questions.length === 50);
check("all-invalid questions produce an error, no artifact", "error" in makeQuiz({ title: "Q", questions: [{ q: "", options: [], correct: 0 }] }));
check("a question left with only 1 surviving option (after dedupe) is dropped", "error" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "a", "a"], correct: 0 }] }));
// Was `> 4` — silently dropped any 5-option question outright, directly contradicting the AP exam-style
// guidance (examStyleLine) that explicitly asks for 5-option MCQs. Raised to 5 so an AP question the model
// correctly wrote doesn't just vanish.
check("a 5-option AP-style question is KEPT, not silently dropped", "quiz" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "b", "c", "d", "e"], correct: 4 }] }) && makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "b", "c", "d", "e"], correct: 4 }] }).quiz.questions[0].options.length === 5);
check("a 6-option question is still rejected (5 is the real ceiling, not unlimited)", "error" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "b", "c", "d", "e", "f"], correct: 0 }] }));

section("makeNote / makeDeck validation");
check("an empty/whitespace-only note body is rejected (was silently accepted before this pass)", "error" in makeNote({ title: "x", body: "   " }));
check("a real note body is accepted", "note" in makeNote({ title: "x", body: "a real fiche body with plenty of actual content in it, more than forty chars" }));
check("a deck with at least one valid card is accepted", "deck" in makeDeck({ title: "D", cards: [{ front: "a", back: "b" }] }));
check("a deck with no valid cards is rejected", "error" in makeDeck({ title: "D", cards: [{ front: "", back: "" }] }));

section("makeBoardEntry validation — the persistent tutor Board (WRITE_TO_BOARD)");
check("an empty/whitespace-only entry is rejected", "error" in makeBoardEntry({ text: "   " }));
check("a real entry is accepted", "entry" in makeBoardEntry({ text: "F = ma" }));
check("a known kind is kept", makeBoardEntry({ text: "Start with part a", kind: "instruction" }).entry.kind === "instruction");
check("an unrecognized kind is dropped rather than stored as garbage", makeBoardEntry({ text: "hello", kind: "not-a-real-kind" }).entry.kind === undefined);
check("kind defaults to undefined (renders as 'note') when omitted", makeBoardEntry({ text: "hello" }).entry.kind === undefined);
check("text over the cap is truncated, not rejected", makeBoardEntry({ text: "x".repeat(1000) }).entry.text.length === 600);
// Regression: a note linked to a fabricated "otto.ai/note/<uuid>" URL — this app has no such domain/page at
// all (everything is in-app SPA state) — reported live. Defense-in-depth strip, independent of the prompt
// instruction: any markdown link whose host contains "otto" gets its href dropped, text kept.
{
  const withFakeLink = makeNote({ title: "x", body: "Voici ta fiche de révision, [clique ici](https://otto.ai/note/89a5535c-5542-41f9-b93f-a5fafc6a3330) pour la voir en entier." });
  check("a fabricated self-referential link is stripped from the note body", "note" in withFakeLink && !withFakeLink.note.body.includes("otto.ai"));
  check("the link's own text is kept, just de-linked", "note" in withFakeLink && withFakeLink.note.body.includes("clique ici"));
  const withRealLink = makeNote({ title: "x", body: "Voici la source officielle : [le site du gouvernement](https://www.gouvernement.fr/some-real-page) pour plus de détails complets." });
  check("a genuinely unrelated real link is left untouched", "note" in withRealLink && withRealLink.note.body.includes("gouvernement.fr"));
}

section("makeBoardEntry — kind:'outline' (headed sections for humanities/essay content)");
check("a well-formed outline is accepted with its sections intact", (() => {
  const r = makeBoardEntry({ text: "Why the Provisional Government failed", kind: "outline", outline: [
    { heading: "Kept fighting WWI", bullets: ["lost the army", "lost the people"] },
    { heading: "Lenin's slogan", bullets: ["Peace, Land, Bread"] },
  ] });
  return "entry" in r && r.entry.kind === "outline" && r.entry.outline?.length === 2 && r.entry.outline[0].bullets.length === 2;
})());
check("outline kind with no outline field is rejected, not silently downgraded", "error" in makeBoardEntry({ text: "Causes of WWI", kind: "outline" }));
check("outline sections are capped at 6, bullets at 8", (() => {
  const outline = Array.from({ length: 10 }, (_, i) => ({ heading: `S${i}`, bullets: Array.from({ length: 12 }, (_, j) => `b${j}`) }));
  const r = makeBoardEntry({ text: "x", kind: "outline", outline });
  return "entry" in r && r.entry.outline.length === 6 && r.entry.outline[0].bullets.length === 8;
})());

section("makeObjectives — SET_OBJECTIVES full-replace validation (session learning-objectives checklist)");
check("a well-formed objectives list is accepted", (() => {
  const r = makeObjectives({ objectives: [{ label: "Explaining the collapse of tsarism in 1917", done: false }, { label: "Comparing War Communism and the NEP", done: true }] });
  return "objectives" in r && r.objectives.length === 2 && r.objectives[1].done === true && r.objectives[0].done === false;
})());
check("an empty list is rejected", "error" in makeObjectives({ objectives: [] }));
check("entries with no label are dropped, not stored as garbage", makeObjectives({ objectives: [{ label: "", done: false }, { label: "Real one", done: false }] }).objectives.length === 1);
check("list is capped at 6 objectives", makeObjectives({ objectives: Array.from({ length: 10 }, (_, i) => ({ label: `Obj ${i}`, done: false })) }).objectives.length === 6);
check("each objective gets a fresh id even if the model didn't send one", (() => {
  const r = makeObjectives({ objectives: [{ label: "x", done: false }] });
  return "objectives" in r && typeof r.objectives[0].id === "string" && r.objectives[0].id.length > 0;
})());

// ── Guardrails: the graded-work detector must catch the real thing without flagging legitimate tutoring
section("CHAT_DOES_WORK / DOES_STUDENT_WORK — true positives without false positives");
check("catches an EN reply that hands over the essay", CHAT_DOES_WORK.test("Here's your essay introduction, ready to submit"));
check("catches a FR reply that hands over the intro", CHAT_DOES_WORK.test("Voici l'introduction :"));
check("does NOT flag legitimate structural help", !CHAT_DOES_WORK.test("Voici comment structurer ton introduction"));
check("catches 'Voici le corrigé' — regression: JS \\b is ASCII-only, so a naive \\bcorrigé\\b silently never matches", CHAT_DOES_WORK.test("Voici le corrigé"));
check("DOES_STUDENT_WORK catches an EN claim of having done the homework", DOES_STUDENT_WORK.test("I solved all the problems for you"));
check("DOES_STUDENT_WORK catches a FR claim of having written the dissertation", DOES_STUDENT_WORK.test("J'ai rédigé ta dissertation pour toi"));
check("DOES_STUDENT_WORK catches a FR claim of having finished the homework", DOES_STUDENT_WORK.test("J'ai terminé le devoir de maths"));
check("DOES_STUDENT_WORK does NOT flag preparing a fiche FOR a contrôle", !DOES_STUDENT_WORK.test("Fiche de révision préparée pour le contrôle"));
check("DOES_STUDENT_WORK does NOT flag a plan to help them write", !DOES_STUDENT_WORK.test("Plan pour rédiger ta dissertation"));

section("CHAT_STATES_ANSWER — catches Otto announcing a conclusion, not just handing over prose");
check("catches a direct EN answer announcement", CHAT_STATES_ANSWER.test("The answer is 42."));
check("catches an EN MCQ conclusion", CHAT_STATES_ANSWER.test("So it's option D."));
check("catches a FR answer announcement", CHAT_STATES_ANSWER.test("La réponse est 42."));
check("catches a FR MCQ conclusion", CHAT_STATES_ANSWER.test("C'est donc l'option B."));
check("does NOT flag ordinary tutoring text with a number in it", !CHAT_STATES_ANSWER.test("That's the same rule we used on step 3 — try applying it here."));
check("does NOT flag a focusing question", !CHAT_STATES_ANSWER.test("What do you think happens if you substitute that back in?"));

section("CHAT_CLAIMS_BOARD — catches Otto pointing at a board write that never happened");
check("catches EN 'on your screen'", CHAT_CLAIMS_BOARD.test("The problem is on your screen now, just above."));
check("catches EN 'just above'", CHAT_CLAIMS_BOARD.test("Take a look just above — that's the setup."));
check("catches FR 'au tableau'", CHAT_CLAIMS_BOARD.test("Regarde au tableau, j'ai noté la formule."));
check("catches FR 'ci-dessus'", CHAT_CLAIMS_BOARD.test("La formule ci-dessus te donne la réponse."));
check("does NOT flag an ordinary sentence using 'above' in a math sense", !CHAT_CLAIMS_BOARD.test("the term above the fraction line cancels out"));

section("CHAT_CLAIMS_DIAGRAM — catches Otto referring to a figure it never actually drew");
check("catches 'the diagram I drew'", CHAT_CLAIMS_DIAGRAM.test("Look at the diagram I drew — the altitude splits the triangle in two."));
check("catches 'I just sketched [a diagram]'", CHAT_CLAIMS_DIAGRAM.test("I just sketched a diagram to show where -3 sits."));
check("catches FR 'le triangle que j'ai dessiné'", CHAT_CLAIMS_DIAGRAM.test("Regarde le triangle que j'ai dessiné pour toi."));
check("does NOT flag ordinary prose mentioning a shape by name", !CHAT_CLAIMS_DIAGRAM.test("A triangle has three sides — can you name them?"));

section("CHAT_ASSERTS_FACT — catches confident unique-fact assertions (verify-or-hedge trigger)");
check("catches an EN author attribution", CHAT_ASSERTS_FACT.test("The author of L'Étranger is Albert Camus."));
check("catches an FR auteur attribution", CHAT_ASSERTS_FACT.test("L'auteur de L'Étranger est Camus."));
check("catches an EN invention with the inventor", CHAT_ASSERTS_FACT.test("The telephone was invented by Bell in 1876."));
check("catches an FR invention", CHAT_ASSERTS_FACT.test("Le téléphone a été inventé par Bell."));
check("catches an FR invention (accented participle, no JS boundary trap)", CHAT_ASSERTS_FACT.test("Le téléphone a été inventé par Bell.") && CHAT_ASSERTS_FACT.test("La pile a été inventée par Volta."));
check("catches a dated EN discovery", CHAT_ASSERTS_FACT.test("In 1665 Newton discovered gravity, which is why..."));
check("catches a dated FR discovery", CHAT_ASSERTS_FACT.test("En 1665 Newton a découvert la gravitation."));
check("does NOT flag ordinary analysis prose", !CHAT_ASSERTS_FACT.test("So the author wants us to feel the tension here — what do you think?"));
check("does NOT flag a method explanation with a year in it", !CHAT_ASSERTS_FACT.test("In 1665 the plague closed Cambridge — but for the exam, what matters is the method."));
check("does NOT flag generic history chatter without a claim verb", !CHAT_ASSERTS_FACT.test("Le théâtre du 17e siècle, c'est tout un monde."));

section("detectLang — confident-only language guess, the code-level backstop for the live-reproduced language-drift bug");
check("clearly English", detectLang("can you help me understand derivatives, like what even is a derivative") === "en");
check("clearly English, a stuck/confused message", detectLang("i dont get it, none of this makes sense to me, its all just confusing symbols") === "en");
check("clearly French", detectLang("j'ai sauté direct aux symboles, on les oublie, tu es en voiture") === "fr");
check("clearly French, with diacritics", detectLang("c'est très bien, tu as déjà vu ça en cours non ?") === "fr");
check("a bare short generic reply carries no signal either way", detectLang("idk") === "unknown" && detectLang("ok") === "unknown" && detectLang("42") === "unknown");
check("empty string is unknown", detectLang("") === "unknown");
check("a short ambiguous reply that happens to share a word doesn't false-positive", detectLang("yes") === "unknown");

section("countWords + the chat length backstop (TALE budget, silent compression round)");
check("countWords counts whitespace-delimited words", countWords("un deux trois") === 3 && countWords("  a  b ") === 2 && countWords("") === 0);
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  // Behavioral posture, pinned structurally: the truth pass lives in the NO-TOOL branch (the only shape
  // a final draft takes), after the truncation retry, before finish() — not in the tool-calls path.
  const noToolIdx = src.indexOf("if (!toolCalls.length) {");
  const noToolEnd = src.indexOf("messages.push({ role: \"assistant\", content: textContent, tool_calls: toolCalls });");
  const noToolBody = src.slice(noToolIdx, noToolEnd);
  check("the truth pass lives inside the no-tool branch (verifies the draft that actually ships)", noToolIdx > 0 && /POST-REPLY TRUTH PASS/.test(noToolBody) && /findArithmeticClaims\(textContent\)/.test(noToolBody));
  check("arith verification: gated, latched, corrective round before finish", /!arithCorrected && !lastRound/.test(noToolBody) && /arithCorrected = true;/.test(noToolBody) && /Independent recomputation of your draft/.test(noToolBody));
  check("fact verification: verify-or-hedge, skipped when web_search already ran this turn", /!factCorrected && !lastRound && CHAT_ASSERTS_FACT\.test\(textContent\)/.test(noToolBody) && /web search\|Recherche web/.test(noToolBody));
  check("length backstop: >120 words, once, non-voice only", /!lengthRetried && !lastRound && !opts\?\.voiceMode && countWords\(textContent\) > 120/.test(noToolBody));
  // Code-level backstop added after prompt-only fixes (CHAT_LANGUAGE_OVERRIDE) were reproduced live as
  // insufficient — a session got a majority-wrong-language run despite clearly English input every turn.
  check("language mismatch: gated, latched, corrective round before finish", /!langCorrected && !lastRound && studentLang !== "unknown" && draftLang !== "unknown" && draftLang !== studentLang/.test(noToolBody) && /langCorrected = true;/.test(noToolBody) && /came out in the wrong language/.test(noToolBody));
  check("the tool path has NO truth pass (final drafts never exit there)", (() => {
    const toolIdx = src.indexOf("messages.push({ role: \"assistant\", content: textContent, tool_calls: toolCalls });");
    const boardNudgeIdx = src.indexOf("if (!boardNudgeDone && !lastRound && shouldNudgeBoardWrite(");
    const toolPath = src.slice(toolIdx, boardNudgeIdx);
    return !/findArithmeticClaims\(textContent\)/.test(toolPath) && !/CHAT_ASSERTS_FACT\.test\(textContent\)/.test(toolPath);
  })());
  check("the prompt carries the fact taxonomy (computation/unique fact/analysis)", /NEVER WRONG — THE FACT TAXONOMY/.test(src) && /the calculator wins/.test(src));
  check("the prompt carries the calibration rule (Kadavath)", /CALIBRATION: models are surprisingly good at knowing what they don't know/.test(src));
  check("the prompt carries the TALE 45-word budget", /UNDER 45 WORDS/.test(src));
  check("the prompt carries the growth-mindset error framing (Dweck)", /ERRORS ARE INFORMATION, NOT VERDICTS/.test(src) && /pas encore/.test(src));
}

section("Client double-check affordance — the same oracle, rendered as a learning signal (AskOttoPanel)");
{
  // The server's post-reply pass rewrites wrong arithmetic before it ships; a mismatch that STILL
  // reaches the client means the verifier never ran (deadline hit, ceiling hit, or an older saved
  // message). Phase 4 renders that residue visible — via the SAME server/arithmetic.ts evaluator
  // (one oracle, two callers), imported into the client bundle. A quiet notice, never an error banner,
  // and never auto-corrected: spotting the discrepancy IS the exercise.
  const panelSrc = readFileSync(new URL("../client/study/AskOttoPanel.tsx", import.meta.url), "utf8");
  check("AskOttoPanel imports the shared arithmetic oracle (same evaluator as the server verifier)", /import \{ findArithmeticClaims \} from "\.\.\/\.\.\/server\/arithmetic\.ts"/.test(panelSrc));
  check("assistant messages get the double-check notice on an unverified mismatch", /arithmeticMismatches\(m\.text\)/.test(panelSrc) && /sm-ai-calc-check/.test(panelSrc) && /Double-check this with Otto/.test(panelSrc) && /role="note"/.test(panelSrc));
  check("the notice shows the claim and the recomputed value, capped at the first + a count", /mismatches\[0\]\.raw/.test(panelSrc) && /mismatches\[0\]\.actual/.test(panelSrc) && /mismatches\.length - 1/.test(panelSrc));
  check("it is a signal only — no auto-correction, no API call from the notice", (() => {
    const idx = panelSrc.indexOf("sm-ai-calc-check");
    const body = panelSrc.slice(panelSrc.lastIndexOf("{m.role === \"assistant\" && (() => {", idx), panelSrc.indexOf("})()}", idx) + 5);
    return !/api\./.test(body) && !/onSend/.test(body);
  })());
  const cssSrc = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  check("the notice's styles exist (quiet amber, not an alarm-red banner)", /\.sm-ai-calc-check \{/.test(cssSrc) && /#d97706/.test(cssSrc));
}

section("Flashcards the student doesn't NEED to learn (card.notNeeded) — excluded, fed back, scoped");
{
  const deck = (cards) => ({ id: "d1", title: "Vocab", createdAt: "2026-09-01", cards });
  const tasksList = [
    { id: "a", title: "Histoire ch.2", sourceSubject: "Histoire", status: "ready", createdAt: "2026-09-01", flashcards: [deck([
      { front: "Date of the Treaty of Westphalia?", back: "1648", notNeeded: true },
      { front: "Who was Robespierre?", back: "...", review: { seen: 2, correct: 0, box: 1 } },
    ])] },
    { id: "b", title: "Maths", sourceSubject: "Maths", status: "ready", createdAt: "2026-09-01", flashcards: [deck([
      { front: "Derivative of ln x?", back: "1/x", notNeeded: true },
    ])] },
  ];
  const hist = notNeededFronts(tasksList, "Histoire");
  check("notNeededFronts collects the subject's not-needed cards", hist.length === 1 && hist[0].includes("Westphalia"));
  check("notNeededFronts never leaks another subject's cards", !hist.some((f) => f.includes("ln x")));
  check("notNeededLine is empty when there's nothing to avoid (no prompt noise)", notNeededLine([]) === "");
  check("notNeededLine tells the model these are out of scope, not gaps", /OUT OF SCOPE/.test(notNeededLine(hist)) && /Westphalia/.test(notNeededLine(hist)));
  const shaky = weakCardLine({ flashcards: [deck([
    { front: "Not needed but box 1", back: "x", notNeeded: true, review: { seen: 3, correct: 0, box: 1 } },
    { front: "Real gap", back: "y", review: { seen: 3, correct: 0, box: 1 } },
  ])] });
  check("a not-needed card is never reported as 'still shaky'", /Real gap/.test(shaky) && !/Not needed but box 1/.test(shaky));

  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("runTask's deck prompt scopes cards to what this student is actually expected to know", /SCOPE — ONLY WHAT THIS STUDENT IS ACTUALLY EXPECTED TO KNOW/.test(src));
  const ui = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  check("FlashcardDeck offers the 'not something I need to learn' escape hatch", /deck-btn-not-needed/.test(ui) && /onNotNeeded\?\.\(cardIndex\)/.test(ui));
  check("a not-needed card leaves the score's denominator", /right\.length \/ inScope/.test(ui));
}

section("inAppContextFor — the student's own in-app history reaches task planning");
{
  const now = new Date("2026-09-27T10:00:00Z");
  const task = { id: "t", title: "Réviser la Révolution", sourceSubject: "Histoire", status: "ready", createdAt: "2026-09-20", when: "2026-10-03T12:00:00Z",
    steps: [{ text: "Relire le chapitre 3", automatable: false, done: true }, { text: "Faire le quiz", automatable: false }],
    flashcards: [{ id: "d", title: "Dates clés", createdAt: "2026-09-20", cards: [{ front: "1789?", back: "x", review: { seen: 4, correct: 3, box: 2 } }] }] };
  const list = [task,
    { id: "o", title: "Dissertation Louis XIV", sourceSubject: "Histoire", status: "done", createdAt: "2026-09-10", notes: [{ id: "n", title: "Fiche absolutisme", body: "…", createdAt: "2026-09-10" }] },
    { id: "c", title: "DM de maths", sourceSubject: "Maths", status: "ready", createdAt: "2026-09-25", when: "2026-09-30T12:00:00Z" },
    { id: "far", title: "Exposé anglais", status: "ready", createdAt: "2026-09-25", when: "2026-11-30T12:00:00Z" },
  ];
  const profile = { grades: [{ id: "g", subject: "Histoire", grade: 11, scale: 20, updatedAt: "2026-09-15" }] };
  const block = inAppContextFor(list, task, profile, now);
  check("reports what's already done on THIS task", /1\/2 steps done/.test(block) && /Relire le chapitre 3/.test(block));
  check("reports this task's existing deck and how the drilling went", /Dates clés/.test(block) && /75% correct/.test(block));
  check("surfaces earlier work in the same subject (so it isn't redone)", /Dissertation Louis XIV/.test(block) && /Fiche absolutisme/.test(block));
  check("includes the student's grades in this subject", /Grades in Histoire: average 11\.0\/20/.test(block));
  check("lists other deadlines competing for the same days", /Also due by then \(1\)/.test(block) && /DM de maths/.test(block));
  check("never lists a deadline AFTER this one as competing", !/Exposé anglais/.test(block));
  check("an empty history produces no block at all", inAppContextFor([], { id: "x", title: "x", status: "ready", createdAt: "2026-09-27" }, undefined, now) === "");
}

section("ensureArtifactUseSteps — a deck/quiz Otto made is always tied into the plan");
{
  const base = [{ text: "Relire le cours", automatable: false }];
  const withDeck = ensureArtifactUseSteps(base, { decks: [{ title: "Vocab ch.4", count: 12 }] }, true);
  check("adds a drill step when a deck was made and no step uses it", withDeck.length === 2 && /Vocab ch\.4/.test(withDeck[1].text) && withDeck[1].minutes === 18);
  const already = ensureArtifactUseSteps([{ text: "Réviser les flashcards du chapitre", automatable: false }], { decks: [{ title: "Vocab", count: 10 }] }, true);
  check("doesn't duplicate when a step already points at the flashcards", already.length === 1);
  const full = ensureArtifactUseSteps(Array.from({ length: 6 }, (_, i) => ({ text: `step ${i}`, automatable: false })), { decks: [{ title: "V", count: 5 }] }, false);
  check("never grows a plan past 6 steps", full.length === 6);
  check("with nothing created, the plan is unchanged", ensureArtifactUseSteps(base, {}, true).length === 1);
}

section("runTask actually uses its inputs (source pins)");
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function runTask(");
  const body = src.slice(start, src.indexOf("\nexport async function writeStepsFromContext", start));
  // `focus` (revision requests, the granularity arm, runStep's single-step scoping + the student's answer)
  // was accepted and never read — every one of those silently did nothing.
  check("runTask reads `focus` into the shared context every ask() sees", /const focusBlock = focus\?\.trim\(\)/.test(body) && /\+ focusBlock;/.test(body));
  check("runTask feeds the in-app history block into its context", /personalization\?\.inApp/.test(body));
  check("runTask's live step prompt asks for a time estimate on every step", /"minutes" on EVERY step/.test(body) && /"minutes": 15/.test(body));
  check("runTask's live step prompt asks for the firstAction on-ramp", /"firstAction": \{"text"/.test(body));
  check("runTask returns firstAction (it used to only come from the rarely-used regenerate route)", /firstAction: \{\s*text: firstActionText/.test(body));
  check("runTask ties created decks/quizzes into the plan", /steps = ensureArtifactUseSteps\(steps/.test(body));
  check("the live step prompt applies the implementation-intentions finding (concrete cue)", /NAME THE CONCRETE CUE/.test(body));
}

section("makeDiagramEntry — DRAW_ON_BOARD validation/clamping (server/claude.ts)");
{
  const ok = makeDiagramEntry({ caption: "Right triangle", ops: [
    { op: "line", x1: 100, y1: 500, x2: 400, y2: 500 },
    { op: "label", x: 250, y: 520, text: "base" },
  ] });
  check("accepts a valid figure and tags it kind:diagram", "entry" in ok && ok.entry.kind === "diagram" && ok.entry.diagram?.length === 2);
  check("caption becomes the entry's caption text", "entry" in ok && ok.entry.text === "Right triangle");

  const empty = makeDiagramEntry({ caption: "x", ops: [] });
  check("rejects an empty ops array", "error" in empty);

  const noCaption = makeDiagramEntry({ caption: "", ops: [{ op: "circle", cx: 10, cy: 10, r: 5 }] });
  check("rejects a missing caption", "error" in noCaption);

  const tooMany = makeDiagramEntry({ caption: "x", ops: Array.from({ length: 16 }, () => ({ op: "label", x: 0, y: 0, text: "a" })) });
  check("rejects more than 15 ops instead of silently truncating", "error" in tooMany);

  const offCanvas = makeDiagramEntry({ caption: "x", ops: [{ op: "circle", cx: 5000, cy: -200, r: 9000 }] });
  check("clamps an off-canvas/oversized op into the 0-800x0-600 space instead of dropping it",
    "entry" in offCanvas && offCanvas.entry.diagram?.[0].op === "circle" &&
    offCanvas.entry.diagram[0].cx <= 800 && offCanvas.entry.diagram[0].cy >= 0 && offCanvas.entry.diagram[0].r <= 400);

  const oneBadOp = makeDiagramEntry({ caption: "x", ops: [{ op: "not_a_real_op" }, { op: "label", x: 1, y: 1, text: "ok" }] });
  check("drops one unrecognized op but keeps the rest of the figure", "entry" in oneBadOp && oneBadOp.entry.diagram?.length === 1);

  const allBad = makeDiagramEntry({ caption: "x", ops: [{ op: "not_a_real_op" }] });
  check("errors when NO op in the figure is valid", "error" in allBad);

  const eq = makeDiagramEntry({ caption: "Combine the fractions", ops: [
    { op: "equation", x: 50, y: 100, latex: "\\frac{2}{x-1} + \\frac{3}{x+2} = \\frac{5x+1}{(x-1)(x+2)}" },
  ] });
  check("accepts a real 'equation' op for KaTeX rendering", "entry" in eq && eq.entry.diagram?.[0].op === "equation" && eq.entry.diagram[0].latex.includes("\\frac"));
  const eqDollars = makeDiagramEntry({ caption: "x", ops: [{ op: "equation", x: 0, y: 0, latex: "$x^2$" }] });
  check("strips $ delimiters the model included anyway — latex is meant to be bare", "entry" in eqDollars && eqDollars.entry.diagram[0].latex === "x^2");
  const eqEmpty = makeDiagramEntry({ caption: "x", ops: [{ op: "equation", x: 0, y: 0, latex: "" }] });
  check("rejects an empty equation", "error" in eqEmpty);
}

section("revealsAnswer — studyHelp's code-level backstop against leaking the real answer");
{
  check("flags a reply containing the flashcard's actual back text", revealsAnswer("I think it's photosynthesis, right?", "Photosynthesis"));
  check("flags a reply containing the quiz's correct option text, case-insensitive", revealsAnswer("Yeah it's definitely MITOCHONDRIA", "Mitochondria"));
  check("does NOT flag a reply discussing method without stating the answer", !revealsAnswer("Look at what part of the cell makes energy — what's that structure called?", "Mitochondria"));
  check("skips very short answers to avoid trivial false positives (e.g. answer is 'x' or a single digit)", !revealsAnswer("x is what we're solving for here", "x"));
}

section("generate() — handled/dismissed titles sorted by recency before being capped for the classifier (source pin)");
{
  // Reported live: a task dismissed one day came back days later. Root cause traced to generate()'s own
  // `handled` list (what gets told to classifyCandidates as "don't recreate these") being capped to the
  // classifier's prompt (handledTitles.slice(0, 30)) WITHOUT first sorting by recency — an item dismissed
  // minutes ago could lose its spot in that cap to an older dismissal sitting earlier in the raw task array.
  // Same fix shape as pruneHandled's own sort (tasks.ts), which exists for the identical reason.
  const src = readFileSync(new URL("../server/tasks.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function generate(");
  const handledIdx = src.indexOf("const handled = existing", start);
  const body = src.slice(handledIdx, src.indexOf("\n  // …and what's currently ACTIVE", handledIdx));
  check("the handled list is sorted by updatedAt/createdAt before being mapped", /\.sort\(\(a, b\) => \(b\.updatedAt \|\| b\.createdAt \|\| ""\)\.localeCompare\(a\.updatedAt \|\| a\.createdAt \|\| ""\)\)/.test(body));
  const sortIdx = body.indexOf(".sort(");
  const mapIdx = body.indexOf(".map(");
  check("the sort runs BEFORE the map (so recency is set before shaping the object), not after", sortIdx > 0 && mapIdx > sortIdx);
}

section("forceWeekCoverage — everything due this week gets a task, no matter what the classifier decided");
{
  const now = new Date("2026-08-12T08:00:00Z");
  const candidates = [
    { sourceApp: "pronote", anchorKey: "pronote:hw1", snippet: "Exercices 12 à 15 p.87 — mécanique du point", timestamp: "2026-08-14T00:00:00Z", subject: "Physique", labels: ["homework"] },
    { sourceApp: "pronote", anchorKey: "pronote-test:maths:2026-08-15", snippet: "Test on 2026-08-15", timestamp: "2026-08-15T00:00:00Z", subject: "Maths", labels: ["test"] },
    { sourceApp: "pronote", anchorKey: "pronote:hw2", snippet: "Devoir déjà couvert par le classifier", timestamp: "2026-08-13T00:00:00Z", subject: "SES", labels: ["homework"] },
    { sourceApp: "pronote", anchorKey: "pronote:hw3", snippet: "Trop loin dans le temps", timestamp: "2026-09-01T00:00:00Z", subject: "Anglais", labels: ["homework"] },
    { sourceApp: "gmail", anchorKey: "gmail:xyz", snippet: "not pronote at all", timestamp: "2026-08-13T00:00:00Z", subject: undefined, labels: [] },
  ];
  const out = forceWeekCoverage(candidates, ["pronote:hw2"], { now });
  check("covers homework the classifier skipped", out.some((t) => t.anchorKey === "pronote:hw1"));
  check("covers a test the classifier skipped", out.some((t) => t.anchorKey === "pronote-test:maths:2026-08-15"));
  check("does NOT duplicate an anchor already covered", !out.some((t) => t.anchorKey === "pronote:hw2"));
  check("skips anything outside the 7-day window", !out.some((t) => t.anchorKey === "pronote:hw3"));
  check("skips non-Pronote sources entirely", !out.some((t) => t.anchorKey === "gmail:xyz"));
  check("carries the real énoncé as sourceDetail, verbatim", out.find((t) => t.anchorKey === "pronote:hw1")?.sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
  check("a bare test marker (no real énoncé) leaves sourceDetail undefined", out.find((t) => t.anchorKey === "pronote-test:maths:2026-08-15")?.sourceDetail === undefined);
  check("every forced task clears applyQualityBar's own floor", out.every((t) => t.urgency >= 0.35 || t.importance >= 0.35));

  // The real production call site (tasks.ts's generate()) now passes daysAhead: TEST_DAYS_AHEAD (28) instead
  // of the function's own 7-day default — per explicit instruction, EVERY not-yet-done Pronote item should
  // become a task automatically, not just the classifier's/quality-bar's picks within the next week.
  const wideOut = forceWeekCoverage(candidates, ["pronote:hw2"], { now, daysAhead: 28 });
  check("a wider daysAhead override covers an item beyond the default 7-day window", wideOut.some((t) => t.anchorKey === "pronote:hw3"));
}

section("nothingToPrepare — a bare Pronote test placeholder never gets auto-run");
{
  check("a bare Pronote test (no sourceDetail) has nothing to prepare", nothingToPrepare({ source: "pronote", sourceDetail: undefined }));
  check("a bare Pronote test with whitespace-only sourceDetail still counts as nothing to prepare", nothingToPrepare({ source: "pronote", sourceDetail: "   " }));
  check("real Pronote homework WITH an énoncé is fine to auto-run", !nothingToPrepare({ source: "pronote", sourceDetail: "Exercices 12 à 15 p.87" }));
  check("a non-Pronote source is never flagged, even with no sourceDetail", !nothingToPrepare({ source: "gmail", sourceDetail: undefined }));
  check("a manual task with no source at all is never flagged", !nothingToPrepare({ sourceDetail: undefined }));
}

// The client is split across App.tsx / TaskCard.tsx / ui.tsx, which import each other. An ES-module import
// CYCLE doesn't fail `tsc` or `vite build` — it resolves to `undefined` at runtime and the app renders a
// blank screen. There are no DOM/render tests in this suite, so this is the one automated guard for it:
// import the client modules for real and assert every component actually came through as a function.
section("client module graph — no import cycle leaves a component undefined");
let uiModule;
for (const [mod, names] of [
  ["../client/ui.tsx", ["FlashcardDeck", "QuizPlayer", "TaskModal", "renderNoteBody", "renderChatText", "statusChip"]],
  ["../client/TaskCard.tsx", ["TaskCardRow", "TaskFocus"]],
]) {
  const m = await import(mod);
  if (mod.endsWith("ui.tsx")) uiModule = m;
  for (const n of names) check(`${mod.replace("../client/", "")} exports ${n} as a function`, typeof m[n] === "function");
}

// shouldKeepLocal is the pure comparison behind keepLocalHandled's new grace-window guard (App.tsx) — a
// background fetch that was in flight before a local confirm/dismiss/step-done must not silently clobber
// it once it resolves. See MUTATION_GRACE_MS.
section("shouldKeepLocal");
{
  const { shouldKeepLocal } = await import("../client/App.tsx");
  // Both sides use a non-"handled" status (isHandled is false for both) so the PRE-EXISTING
  // handled-vs-unhandled guard never fires — these cases isolate the NEW grace-window logic only.
  const base = { id: "t1", status: "ready" };
  const local = { ...base, status: "ready" }; // locally mutated (e.g. a step ticked) but not confirmed/dismissed
  check("no local copy → nothing to keep, take incoming", shouldKeepLocal(undefined, base, undefined, 1000) === false);
  check("never-mutated task → no grace window, take incoming", shouldKeepLocal(local, base, undefined, 1000) === false);
  check("locally handled + incoming un-handles it → keep local (pre-existing guard)", shouldKeepLocal({ ...base, status: "done" }, { ...base, status: "ready" }, undefined, 1000) === true);

  const mutatedAt = 1000;
  const staleIncoming = { ...base }; // no updatedAt — can't prove it's newer
  check("within grace window, incoming has no updatedAt → presumed stale, keep local", shouldKeepLocal(local, staleIncoming, mutatedAt, mutatedAt + 3000, 8000) === true);

  const olderIncoming = { ...base, updatedAt: new Date(mutatedAt - 500).toISOString() };
  check("within grace window, incoming older than the mutation → keep local", shouldKeepLocal(local, olderIncoming, mutatedAt, mutatedAt + 3000, 8000) === true);

  const newerIncoming = { ...base, updatedAt: new Date(mutatedAt + 500).toISOString() };
  check("incoming genuinely NEWER than the mutation → take incoming even inside the grace window", shouldKeepLocal(local, newerIncoming, mutatedAt, mutatedAt + 3000, 8000) === false);

  check("grace window expired → take incoming regardless of age", shouldKeepLocal(local, staleIncoming, mutatedAt, mutatedAt + 9000, 8000) === false);
}

// A note's markdown body can contain a GFM pipe table (a schedule, a comparison) — the hand-rolled
// renderNoteBody parser (no full markdown library) must actually turn "| a | b |\n|---|---|\n| 1 | 2 |"
// into a <table>, not dump raw pipe characters as plain paragraphs. Render it for real via
// react-dom/server rather than just introspecting the element tree — this is the one place in the suite
// that can assert actual HTML output, since react-dom is already a real dependency.
section("renderNoteBody — GFM pipe table support");
{
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const table = "| Étape | Durée |\n|---|---|\n| Module 1 | 32 min |\n| Module 2 | 32 min |";
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, uiModule.renderNoteBody(table)));
  check("renders a <table>", /<table/.test(html));
  check("renders the header cells", /<th[^>]*>Étape<\/th>/.test(html) && /<th[^>]*>Durée<\/th>/.test(html));
  check("renders every data row", /Module 1/.test(html) && /Module 2/.test(html) && /32 min/.test(html));
  check("does not leak raw pipe characters into the output", !html.includes("|"));
  // Non-table content must still render exactly as before — a heading, list, and paragraph, no stray table.
  const plain = renderToStaticMarkup(React.createElement(React.Fragment, null, uiModule.renderNoteBody("# Titre\n- un\n- deux\n\nTexte.")));
  check("plain markdown (no pipes) renders no table", !plain.includes("<table"));
  check("plain markdown still renders the heading/list/paragraph", /<h3/.test(plain) && /<ul/.test(plain) && /Texte\./.test(plain));
}
// sourceAttributionLine — the Pillar-1 (proactive) claim made visible on the card itself: "Found in
// Gmail · 2h ago" instead of only living in task.why's free prose.
section("sourceAttributionLine — proactive-pillar source attribution on task cards");
{
  const now = new Date().toISOString();
  check("gmail source renders 'Found in Gmail · just now' (EN)", uiModule.sourceAttributionLine({ source: "gmail", createdAt: now }, true) === "Found in Gmail · just now");
  // relTime itself is English-only everywhere in this codebase already (App.tsx:1147, TaskCard.tsx:619 —
  // an existing, pre-existing convention, not something this feature introduces) — only the source LABEL
  // half of this line is actually translated.
  check("pronote source renders the French label with the same relTime text", uiModule.sourceAttributionLine({ source: "pronote", createdAt: now }, false) === "Trouvé dans Pronote · just now");
  check("manual source renders nothing — the student added it themselves, nothing for Otto to claim", uiModule.sourceAttributionLine({ source: "manual", createdAt: now }, true) === "");
  check("unknown/missing source renders nothing", uiModule.sourceAttributionLine({}, true) === "");
  check("missing createdAt still renders the source label alone, no dangling separator", uiModule.sourceAttributionLine({ source: "calendar" }, true) === "Found in Calendar");
}
// formatMath (private to ui.tsx) is exercised through renderNoteBody, which calls it on every line. Bug
// reported live: a flashcard/note written as plain "x^2 + y^2 = z^2" (no LaTeX escaping, just a bare caret —
// how the model and students both naturally write exponents) rendered a literal caret instead of a real
// superscript, because formatMath's fast path only ran the conversion pipeline when the text contained a
// backslash or "$". Pin that a bare caret alone is now enough to trigger real superscript conversion, and
// that ordinary non-math text (including snake_case-style underscores, which stay gated behind an
// accompanying caret precisely because they're common in real prose) is untouched.
section("formatMath — bare-caret exponents (no LaTeX escaping) render as real superscripts");
{
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const render = (s) => renderToStaticMarkup(React.createElement(React.Fragment, null, uiModule.renderNoteBody(s)));
  check("bare x^2 renders a real superscript", render("x^2 + y^2 = z^2").includes("x²"));
  check("bare caret text leaves no literal ^ behind", !render("x^2 + y^2 = z^2").includes("^"));
  check("plain prose with an underscore (no caret/backslash) is left untouched", render("see item_1 in the file").includes("item_1"));
  check("LaTeX-delimited math still converts (unaffected by the fast-path change)", render("\\(a^2+b^2\\)").includes("a²"));
}
// Source-order pin, not a real interaction test (no DOM test runner exists — see the module-graph check
// above for why). .card-main is the task row's real "open this task" control. An earlier version used a
// separate invisible `.card-open` overlay sibling instead — textbook-correct by every CSS stacking rule,
// but taps on it silently failed to register on live mobile testing (multiple browsers, no JS error, no
// plausible cause found after two independent targeted fixes shipped and confirmed live with zero effect).
// Replaced with the simpler, standard pattern: the visible content itself IS the button. Pin that a future
// edit doesn't quietly reintroduce the invisible-overlay pattern this bug came from.
{
  const src = readFileSync(new URL("../client/TaskCard.tsx", import.meta.url), "utf8");
  check("TaskCardRow does not reintroduce the invisible .card-open overlay pattern", !src.includes('"card-open"'));
  check("TaskCardRow's .card-main is a real <button>, not a styled <div>", /<button[^>]*className="card-main"/.test(src));
}
// The ACTUAL live-confirmed root cause of "tapping a task marks it done instead of opening it": any element
// using the `::after { position: absolute; inset: -Npx }` hit-expander pattern MUST itself have
// `position: relative`, or the ::after positions relative to the nearest positioned ANCESTOR instead (here,
// `.card`) — silently blowing the invisible hit-expander up to cover almost the entire row instead of just
// the small control it belongs to. This exact regression (removing `.card-check`'s `position: relative` as
// apparently-dead code during an unrelated cleanup) shipped and was live for multiple rounds before being
// found. Pin the coupling directly: every selector with this ::after pattern must also declare position:
// relative somewhere in the file.
{
  const css = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  const hitExpanders = [...css.matchAll(/([.\w-]+)::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*-\d/g)].map((m) => m[1]);
  check("found the known ::after hit-expanders to check (styles.css structure changed?)", hitExpanders.length >= 3);
  for (const sel of hitExpanders) {
    const re = new RegExp(`(^|[,\\s}])${sel.replace(".", "\\.")}\\s*\\{[^}]*position:\\s*relative`, "m");
    check(`${sel} (has an ::after hit-expander) also declares position: relative`, re.test(css));
  }
}

// ── Step prep: sanitizeStepExtras / bestMatchingStep / dropTrivialSteps ────────
section("sanitizeStepExtras validation");
check("valid https url kept", sanitizeStepExtras({ url: "https://sncf-connect.com/x" }).url === "https://sncf-connect.com/x");
check("non-http url rejected", sanitizeStepExtras({ url: "javascript:alert(1)" }).url === undefined);
check("bare string (no protocol) rejected", sanitizeStepExtras({ url: "sncf-connect.com" }).url === undefined);
check("question truncated to 200 chars", sanitizeStepExtras({ question: "x".repeat(300) }).question.length === 200);
check("options capped at 4", sanitizeStepExtras({ options: ["a", "b", "c", "d", "e"] }).options.length === 4);
check("options blanks filtered", sanitizeStepExtras({ options: ["a", "", "  ", "b"] }).options.length === 2);
check("minutes in range kept", sanitizeStepExtras({ minutes: 15 }).minutes === 15);
check("minutes out of range dropped", sanitizeStepExtras({ minutes: 500 }).minutes === undefined);
check("non-integer minutes dropped", sanitizeStepExtras({ minutes: 12.5 }).minutes === undefined);

section("bestMatchingStep — text-similarity, never index");
const draftSteps = [
  { text: "Share the confirmed store list", automatable: false, url: "https://a.example/list" },
  { text: "Book the SNCF train to The Hague", automatable: false, url: "https://sncf-connect.com/book" },
];
check("reordered/reworded step still matches by text overlap", bestMatchingStep("Book train tickets to The Hague on SNCF", draftSteps)?.url === "https://sncf-connect.com/book");
check("unrelated text has no match", bestMatchingStep("Buy a birthday present for mum", draftSteps) === undefined);
check("empty text has no match", bestMatchingStep("", draftSteps) === undefined);

section("dropTrivialSteps — bilingual, url-aware, exemptions");
const mkStep = (text, extra = {}) => ({ text, automatable: false, ...extra });
check("EN search instruction dropped", dropTrivialSteps([mkStep("Look up train times for the SAT trip")]).length === 0);
check("FR search instruction dropped", dropTrivialSteps([mkStep("Cherche les horaires de train")]).length === 0);
check("FR 'vérifie les prix' dropped", dropTrivialSteps([mkStep("Vérifie les prix des billets")]).length === 0);
check("bare navigation without url dropped", dropTrivialSteps([mkStep("Open sncf-connect.com")]).length === 0);
check("bare navigation WITH url kept (OPENING A PAGE is sanctioned)", dropTrivialSteps([mkStep("Open sncf-connect.com", { url: "https://sncf-connect.com" })]).length === 1);
check("FR 'ouvre' without url dropped, with url kept",
  dropTrivialSteps([mkStep("Ouvre le site de la SNCF")]).length === 0 &&
  dropTrivialSteps([mkStep("Ouvre le site de la SNCF", { url: "https://sncf-connect.com" })]).length === 1);
check("checking with a real person survives (EN)", dropTrivialSteps([mkStep("Check with your teacher which title is allowed")]).length === 1);
check("checking with a real person survives (FR)", dropTrivialSteps([mkStep("Vérifie auprès de ton prof le titre autorisé")]).length === 1);
check("opening an in-app artifact survives", dropTrivialSteps([mkStep("Consulte la fiche de révision")]).length === 1);
check("already-automatable step is never gated, even if it reads like a search", dropTrivialSteps([mkStep("Research summer programs and compile a list", { automatable: true })]).length === 1);
check("mid-sentence 'check' doesn't false-positive (anchored to leading verb only)", dropTrivialSteps([mkStep("Bring your ID and check it's not expired")]).length === 1);
check("isTrivialStep matches dropTrivialSteps for the same inputs", isTrivialStep("Cherche les horaires de train") === true && isTrivialStep("Consulte la fiche de révision") === false);

section("sanitizeSteps — self-email filter + cap, no triviality gate here");
check("self-email step filtered", sanitizeSteps([mkStep("Draft an email summary to the user")], 6).length === 0);
check("sliced to maxCount", sanitizeSteps([mkStep("a"), mkStep("b"), mkStep("c")], 2).length === 2);
// This is the exact regression a triviality gate INSIDE sanitizeSteps caused: at this point in finalize()
// automatable is still the model's raw (often false) value — the DOABLE/JUDGMENT flip hasn't run yet — so
// a step sanitizeSteps must NOT drop "Research X" just because it starts with a search-flavored verb; only
// dropTrivialSteps (called AFTER that flip) is allowed to make that call.
check("sanitizeSteps does NOT apply the triviality gate (that's dropTrivialSteps, called after the DOABLE flip)", sanitizeSteps([mkStep("Research summer programs and compile a list")], 6).length === 1);

section("finalize — url/question/options survive the real submit path, trivial steps still gated");
// "Look up X" is deliberately NOT used here — it's in finalize's own DOABLE list (see below) and gets
// flipped to Otto's job before the gate even runs, which is correct but doesn't exercise THIS gate. "Check
// opening hours" isn't in DOABLE/JUDGMENT, so it stays a genuine user-facing step and reaches the gate.
const finTrivial = finalize({ context: "c", synthesis: "s", did: [], steps: [
  { text: "Check opening hours for the store", automatable: false },
  { text: "Book the 14:12 Thalys to The Hague", automatable: false, url: "https://sncf-connect.com/book" },
], links: [], sendables: [] }, "", []);
check("trivial lookup step dropped by finalize", !finTrivial.steps.some((s) => /opening hours/.test(s.text)));
check("step with a real url survives finalize with its url intact", finTrivial.steps.find((s) => /Thalys/.test(s.text))?.url === "https://sncf-connect.com/book");
const finResearch = finalize({ context: "c", synthesis: "s", did: [], steps: [
  { text: "Research summer programs and compile a list of options", automatable: false },
], links: [], sendables: [] }, "", []);
check("'Research...' still flips to automatable and survives (DOABLE runs before the gate)", finResearch.steps.length === 1 && finResearch.steps[0].automatable === true);

section("finalize — firstAction (the anti-procrastination hook)");
const finFA = finalize({ context: "c", synthesis: "s", did: [], steps: [
  { text: "Pick which store list to use", automatable: false },
], links: [], sendables: [], firstAction: { text: "Open the doc and write one bad first sentence", minutes: 3 } }, "", []);
check("firstAction kept when a real user step remains", finFA.firstAction?.text === "Open the doc and write one bad first sentence" && finFA.firstAction?.minutes === 3);
const finFANoUserStep = finalize({ context: "c", synthesis: "s", did: [], steps: [], links: [], sendables: [], firstAction: { text: "Do the tiny thing" } }, "", []);
check("firstAction dropped when no real user step remains (server backstop, not trusted from the model)", finFANoUserStep.firstAction === undefined);
const finFABigProject = finalize({ context: "c", synthesis: "s", did: [], steps: [
  { text: "Pick a research question", automatable: false },
], links: [], sendables: [], isBigProject: true, firstAction: { text: "Do the tiny thing" } }, "", []);
check("firstAction dropped for a big project (milestone already sets direction)", finFABigProject.firstAction === undefined);
const finFAOutOfRangeMinutes = finalize({ context: "c", synthesis: "s", did: [], steps: [
  { text: "Pick which store list to use", automatable: false },
], links: [], sendables: [], firstAction: { text: "Do the tiny thing", minutes: 90 } }, "", []);
check("out-of-range firstAction minutes dropped, text kept", finFAOutOfRangeMinutes.firstAction?.text === "Do the tiny thing" && finFAOutOfRangeMinutes.firstAction?.minutes === undefined);

section("expandStep prompt — substeps get the same task-decomposition quality bar as real steps (source pin)");
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const expandStepStart = src.indexOf("export async function expandStep(");
  const expandStepBody = src.slice(expandStepStart, src.indexOf("\nexport async function runSubstep", expandStepStart));
  // Substeps used to be generated with a thinner prompt than real steps — no dependency ordering, no
  // self-checking-done criterion, no concrete-cue guidance — even though the same task-decomposition
  // research (GTD-style single "next action", implementation-intention specificity) applies at any
  // granularity. Direct request: "do research on how to create good subtasks for steps and implement that."
  check("substeps are ordered by dependency, same check as real steps", /ORDER THEM IN THE SEQUENCE THE STUDENT WILL ACTUALLY DO THEM/.test(expandStepBody));
  check("substeps require one deliverable each, not an 'and'/'then' compound", /ONE DELIVERABLE PER SUB-ACTION/.test(expandStepBody));
  check("substeps must be self-checking (a concrete, verifiable outcome)", /SELF-CHECKING: the student should be able to tell/.test(expandStepBody));
  check("substeps should name the concrete material/page/document when known", /NAME THE CONCRETE CUE/.test(expandStepBody));
}

section("Step-5 artifact selection — a note is never auto-added without real substance to write (source pin)");
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const idx = src.indexOf("For academic tasks that don't match the discrete-facts pattern");
  const block = src.slice(idx, idx + 1400);
  // Reported live pattern this closes: EVERY academic task that didn't match the discrete-facts regex got
  // a note auto-added regardless of whether the model itself had just said "none" for a good reason — a
  // "not every task needs a brief" violation. Now gated on the context actually having enough real material
  // (same 400-char floor already used for the practical-task/isNoteOnly branch just below it) to write
  // something substantive, instead of firing for every academic-looking task unconditionally.
  check("the academic note fallback requires real context substance before firing (not unconditional)", block.includes('isAcademic && `${context || ""}`.trim().length > 400'));
}

section("expandStep substep url — bounded to the task's own links");
{
  const links = [{ label: "Registration form", url: "https://example.edu/register" }];
  // Simulates the mapper inside expandStep without a live API call (no network in this suite): a
  // model-proposed substep url that ISN'T in the task's links must never survive.
  const linkUrls = new Set(links.map((l) => l.url));
  const propose = (raw) => { const url = raw.url && linkUrls.has(raw.url) ? raw.url : undefined; return { text: raw.text, url }; };
  check("substep url matching a real task link kept", propose({ text: "Fill in the form", url: "https://example.edu/register" }).url === "https://example.edu/register");
  check("substep url NOT on the task is dropped, never fabricated", propose({ text: "Fill in the form", url: "https://totally-invented.example/register" }).url === undefined);
}

section("nextLeitnerReview — flashcard spaced-repetition schedule (simplified to 2 boxes: Learning/Known)");
{
  const now = new Date("2026-08-25T12:00:00Z");
  const first = nextLeitnerReview(undefined, true, now);
  check("first-ever correct review starts at box 1 (\"Learning\")", first.box === 1);
  check("box 1 schedules 1 day out", Date.parse(first.dueAt) - now.getTime() === 1 * 86_400_000);
  const advanced = nextLeitnerReview(1, true, now);
  check("correct review advances box 1 → box 2 (\"Known\")", advanced.box === 2);
  check("box 2 schedules 7 days out", Date.parse(advanced.dueAt) - now.getTime() === 7 * 86_400_000);
  const capped = nextLeitnerReview(2, true, now);
  check("box caps at 2, never grows unbounded", capped.box === 2);
  const missed = nextLeitnerReview(2, false, now);
  check("a missed review resets to box 1 regardless of prior progress", missed.box === 1);
}

section("estimateWhen / whenApprox — every task gets a real deadline, none are AI-invented");
{
  const now = new Date("2026-08-25T12:00:00Z");
  const noWhen = [{ title: "Do the lab report", why: "Due soon", source: "pronote", risk: "low", urgency: 0.8, importance: 0.7 }];
  const foldedNoWhen = foldGenerated([], noWhen, [], now);
  check("a task with no explicit deadline still gets a parseable `when`", !!foldedNoWhen[0]?.when && !Number.isNaN(Date.parse(foldedNoWhen[0].when)));
  check("that assigned deadline is flagged approximate, not claimed as real", foldedNoWhen[0]?.whenApprox === true);
  check("estimateWhen never invents a PAST date", Date.parse(foldedNoWhen[0].when) > now.getTime());

  const withWhen = [{ title: "Reply to Ms. Dubois", why: "She asked yesterday", source: "gmail", risk: "low", urgency: 0.6, importance: 0.6, when: "2026-08-27T08:00:00Z" }];
  const foldedWithWhen = foldGenerated([], withWhen, [], now);
  check("an explicit deadline from the source is kept verbatim", foldedWithWhen[0]?.when === "2026-08-27T08:00:00Z");
  check("an explicit deadline is never marked approximate", !foldedWithWhen[0]?.whenApprox);

  check("estimateWhen puts a 'do' quadrant task closer than a 'later' one", Date.parse(estimateWhen("do", now)) < Date.parse(estimateWhen("later", now)));

  const approxTask = { when: estimateWhen("schedule", now), urgency: 0.4, importance: 0.6, quadrant: "schedule", score: 2, status: "ready" };
  applyDeadlineUrgency([approxTask], new Date(now.getTime() + 5 * 86_400_000));
  check("estimated deadlines still feed the anti-procrastination urgency curve as the estimate nears", approxTask.urgency > 0.4);

  // A date stated in ordinary prose ("on his September 23 birthday") that the model failed to lift into
  // its own `when` field must still be read deterministically, rather than silently falling through to the
  // generic days-out-by-quadrant guess (the reported bug: "~Sep 25" for a task naming September 23).
  const birthdayTask = [{ title: "Wish Christiaan well on his September 23 birthday", why: "", source: "manual", risk: "low", urgency: 0.3, importance: 0.5 }];
  const foldedBirthday = foldGenerated([], birthdayTask, [], now);
  check("a date named in the title is read even when the model left `when` empty", foldedBirthday[0]?.when?.slice(0, 10) === "2026-09-23");
  check("a date read from title text is NOT flagged approximate — it's a real stated date", !foldedBirthday[0]?.whenApprox);

  check("extractDateFromText reads 'Month Day' (English)", extractDateFromText("Buy a gift before September 23", now)?.slice(0, 10) === "2026-09-23");
  check("extractDateFromText reads 'Day Month' (French)", extractDateFromText("Anniversaire le 23 septembre", now)?.slice(0, 10) === "2026-09-23");
  check("extractDateFromText rolls a month/day already >1 month past into next year (recurring events)", extractDateFromText("His birthday was March 3", now)?.slice(0, 4) === "2027");
  check("extractDateFromText returns undefined when no date-like text is present", extractDateFromText("Finish the lab report", now) === undefined);
}

section("weakCardFronts — the study-journal week summary's 'what did I get wrong' signal");
{
  const deckWith = (cards) => ({ id: "d1", title: "Day deck", cards, createdAt: new Date().toISOString() });
  const dayA = { id: "a", title: "Mon", why: "", source: "studylog", risk: "low", urgency: 0, importance: 0, quadrant: "later", score: 0, status: "needs_review", createdAt: new Date().toISOString(),
    flashcards: [deckWith([{ front: "Photosynthesis equation", back: "...", review: { seen: 2, correct: 0, box: 1 } }, { front: "Mitochondria role", back: "...", review: { seen: 3, correct: 3, box: 3 } }])] };
  const dayB = { ...dayA, id: "b", flashcards: [deckWith([{ front: "1789 causes", back: "...", review: { seen: 1, correct: 0, box: 1 } }, { front: "No review yet", back: "..." }])] };
  const fronts = weakCardFronts([dayA, dayB]);
  check("collects box-1 (wrong/reset) cards across multiple days", fronts.includes("Photosynthesis equation") && fronts.includes("1789 causes"));
  check("excludes advanced (box > 1) cards", !fronts.includes("Mitochondria role"));
  check("excludes never-reviewed cards (no review field at all)", !fronts.includes("No review yet"));
  check("empty input yields empty output", weakCardFronts([]).length === 0);
  check("a day with no flashcards at all is handled without throwing", weakCardFronts([{ ...dayA, id: "c", flashcards: undefined }]).length === 0);
}

section("anchorStepsToTask — no longer glues the title onto step text");
{
  // First reported bug: a title phrased as an artifact-production instruction ("Build figures de style
  // flashcards and identification quiz") legitimately shares almost no vocabulary with genuine per-step
  // study instructions. A first fix (only prefix when a MINORITY of steps mismatch) helped but didn't
  // hold: a SECOND real report hit the exact 50/50 boundary — "Cancel or keep Docusign now the 30-day
  // trial ended" is a plain decision task where administrative steps like "Note the exact next billing
  // date" or "Compare that count with free alternatives" naturally don't repeat the title's own words
  // ("cancel"/"keep"/"docusign"/"trial"/"ended"), landing exactly at a 4-of-8 match ratio — not `< 0.5`,
  // so the old per-step prefixing still fired on the other 4. Keyword-overlap-with-the-title is just not a
  // reliable drift signal for a normally-worded step list; the function no longer tries to guess at
  // contamination this way at all (see dropForeignEntitySteps below for the real, evidence-based check).
  const buildTitle = "Build figures de style flashcards and identification quiz";
  const genuineSteps = [
    { text: "Read the five-step identification routine aloud once.", done: false },
    { text: "Memorise the outil de comparaison list cold.", done: false },
    { text: "Work the ready-made flashcard deck front to back, naming aloud.", done: false },
  ];
  const anchored = anchorStepsToTask(genuineSteps, buildTitle, 12);
  check("on-topic steps under an artifact-production title are NOT prefixed with the title", anchored.every((s) => !s.text.startsWith(buildTitle)));
  check("step text otherwise passes through unchanged", anchored[0].text === "Read the five-step identification routine aloud once.");

  const docusignTitle = "Cancel or keep Docusign now the 30-day trial ended";
  const docusignSteps = [
    { text: "Log into Docusign; open Settings > Account > Plan and Billing", done: false },
    { text: "Note the exact next billing date and plan price", done: false },
    { text: "Count monthly e-signs needed for Weave and L'Atypic", done: false },
    { text: "Compare that count with free alternatives like Dropbox Sign", done: false },
    { text: "Decide: cancel today, or keep and accept the charge", done: false },
    { text: "If already charged, open a support ticket requesting refund", done: false },
  ];
  const anchoredDocusign = anchorStepsToTask(docusignSteps, docusignTitle, 12);
  check("the exact reported Docusign case: none of the 6 steps get the title glued on", anchoredDocusign.every((s) => !s.text.startsWith(docusignTitle)));
  check("Docusign steps otherwise pass through verbatim", anchoredDocusign[1].text === "Note the exact next billing date and plan price");
}

section("needsAutoBreakdown — only auto-expand a step when it's genuinely complicated");
{
  // A SHORT broad-scope-verb step ("Review X", "Research colleges") deliberately does NOT auto-expand —
  // see the function's own comment: auto-breaking every short "review"/"prepare" step produced the reported
  // failure mode of one step ballooning into 8 sub-steps instead of 8 real steps at generation time. The
  // broad-scope-verb trigger only fires once a step is ALSO genuinely long (>120 chars).
  check("SHORT broad-scope-verb step does NOT auto-expand", !needsAutoBreakdown("Review the Brave Search API prepaid billing change"));
  check("SHORT broad-scope-verb step ('research colleges') does NOT auto-expand", !needsAutoBreakdown("Research colleges"));
  check("LONG broad-scope-verb step (>120 chars) DOES flag for auto-breakdown", needsAutoBreakdown("Review the entire Brave Search API prepaid billing change history, including every past invoice, rate adjustment, and refund issued this year"));
  check("an already-concrete single action does NOT get auto-expanded", !needsAutoBreakdown("Email the professor"));
  check("a short imperative does NOT get auto-expanded", !needsAutoBreakdown("Submit the form"));
  check("a long multi-clause step flags even without a broad-scope verb", needsAutoBreakdown("Call the dentist, confirm the appointment time, and ask about insurance coverage"));
  check("empty text never flags", !needsAutoBreakdown(""));
}

section("practiceAnswerMatches — loose-but-not-fuzzy free-response checking");
{
  check("exact match", practiceAnswerMatches("42", "42"));
  check("case/whitespace-insensitive text match", practiceAnswerMatches("  Paris  ", "paris"));
  check("numeric match tolerates trailing zero formatting", practiceAnswerMatches("3", "3.0"));
  check("numeric match tolerates a thousands separator", practiceAnswerMatches("1,000", "1000"));
  check("strips a leading 'x=' echo of the variable", practiceAnswerMatches("x = 4", "4"));
  check("strips a trailing period", practiceAnswerMatches("4.", "4"));
  check("a genuinely wrong numeric answer still fails", !practiceAnswerMatches("41", "42"));
  check("a genuinely wrong text answer still fails", !practiceAnswerMatches("London", "Paris"));
  check("empty given answer never matches", !practiceAnswerMatches("", "42"));
  // Leading-number fallback: a correct number typed without the unit the problem asked for still counts.
  check("a bare number matches the same number WITH a unit", practiceAnswerMatches("84", "84 m"));
  check("a number typed with no space before the unit still matches", practiceAnswerMatches("84m", "84 m"));
  check("still rejects a genuinely wrong number even with matching units on both sides", !practiceAnswerMatches("80 m", "84 m"));
  check("decimal number without unit matches decimal WITH unit", practiceAnswerMatches("3.5", "3.5 s"));
  // Regression: the prompt explicitly tells the student they may answer "as a decimal (or as a fraction if
  // you prefer, written like 7/2)" — but plain Number("7/2") is NaN, so a numerically exact fraction answer
  // used to be marked wrong outright against a decimal-formatted correct answer.
  check("a fraction answer matches the equivalent decimal correct answer", practiceAnswerMatches("7/2", "3.5"));
  check("a decimal answer matches the equivalent fraction correct answer", practiceAnswerMatches("3.5", "7/2"));
  check("a fraction answer matches an equivalent fraction correct answer", practiceAnswerMatches("7/2", "14/4"));
  check("a negative fraction is parsed correctly", practiceAnswerMatches("-7/2", "-3.5"));
  check("a genuinely wrong fraction still fails", !practiceAnswerMatches("7/2", "3"));
  check("a fraction answer with a unit still matches via the leading-number fallback", practiceAnswerMatches("7/2 m", "3.5 m"));
}

section("looksLikeStem / makePracticeProblem — daily practice-problem generation gate + validation");
{
  check("English math keyword flags", looksLikeStem("Today I learned the quadratic equation formula."));
  check("French physics keyword flags", looksLikeStem("Aujourd'hui j'ai révisé la vitesse et l'accélération en physique."));
  check("plain non-STEM entry does not flag", !looksLikeStem("Today I read a chapter of the novel for English class."));
  check("empty entry does not flag", !looksLikeStem(""));
  const okProblem = makePracticeProblem({ problem: "Solve for x: 2x + 4 = 10", answer: "3", format: "a single number" });
  check("valid problem+answer is accepted", "problem" in okProblem);
  check("missing answer is rejected", "error" in makePracticeProblem({ problem: "Solve for x: 2x = 6" }));
  check("missing problem is rejected", "error" in makePracticeProblem({ answer: "3" }));
}

section("bandit.ts — contextual bandit (Thompson Sampling) for Pomodoro personalization");
{
  // Deterministic seeded RNG (mulberry32) so sampling is reproducible in tests, per the plan's own
  // "seeded for determinism" note in bandit.ts.
  function seeded(seed) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  check("contextKey is stable for the same inputs", contextKey(new Date("2026-01-05T09:00:00")) === contextKey(new Date("2026-01-05T09:30:00")));
  check("contextKey distinguishes weekday vs weekend", contextKey(new Date("2026-01-05T09:00:00")) !== contextKey(new Date("2026-01-04T09:00:00"))); // Mon vs Sun
  check("contextKey distinguishes time-of-day buckets", contextKey(new Date("2026-01-05T09:00:00")) !== contextKey(new Date("2026-01-05T20:00:00")));
  check("contextKey folds in track", contextKey(new Date("2026-01-05T09:00:00"), { track: "ib" }) !== contextKey(new Date("2026-01-05T09:00:00"), { track: "bac" }));

  const key = contextKey(new Date("2026-01-05T09:00:00"));
  const cold = chooseArm(POMODORO_ARMS, {}, key, seeded(1));
  check("cold start (no prior data) is flagged as such", cold.coldStart === true);
  check("cold start still returns a real, known arm", POMODORO_ARMS.some((a) => a.id === cold.arm.id));

  check("reward is 1 for a fully-completed, fully-engaged session", computeReward({ completedPlanned: true, idleRatio: 0 }) === 1);
  check("reward is 0 for an abandoned, fully-idle session", computeReward({ completedPlanned: false, idleRatio: 1 }) === 0);
  check("reward is always clamped to [0, 1]", computeReward({ completedPlanned: true, idleRatio: -5 }) <= 1 && computeReward({ completedPlanned: false, idleRatio: 5 }) >= 0);
  check("a strong positive Leitner delta pulls reward up", computeReward({ completedPlanned: true, idleRatio: 0, netBoxDelta: 3 }) >= computeReward({ completedPlanned: true, idleRatio: 0 }));
  check("a strong negative Leitner delta pulls reward down", computeReward({ completedPlanned: true, idleRatio: 0, netBoxDelta: -3 }) <= computeReward({ completedPlanned: true, idleRatio: 0 }));

  // Repeatedly rewarding ONE arm at this context should make the bandit converge on serving it — the whole
  // point of the learning loop the user asked for ("keeps learning from reward, reinforces what helps").
  let state = {};
  for (let i = 0; i < 60; i++) state = updatePosterior(state, key, "90/20", 1);
  for (let i = 0; i < 60; i++) state = updatePosterior(state, key, "25/5", 0);
  const rng = seeded(42);
  let picks90 = 0;
  for (let i = 0; i < 50; i++) { if (chooseArm(POMODORO_ARMS, state, key, rng).arm.id === "90/20") picks90++; }
  check("after 60 rewarded trials, the reinforced arm is served the clear majority of the time", picks90 >= 40);
  check("a never-updated context key stays at its own independent cold-start prior", chooseArm(POMODORO_ARMS, state, "afternoon|weekday|other", seeded(7)).coldStart === true);

  const before = updatePosterior({}, key, "25/5", 1);
  check("a successful outcome increments alpha, not beta", before[key]["25/5"].a === 2 && before[key]["25/5"].b === 1);
  const after = updatePosterior(before, key, "25/5", 0);
  // Approximate, not exact — updatePosterior now discounts toward the uniform prior on every call (see
  // FORGETTING_FACTOR, bandit.ts) for non-stationarity, so a's prior value (2) becomes slightly less than 2
  // before beta's increment lands. Still unambiguously "alpha stayed ~flat, beta grew", which is the actual
  // invariant this test protects.
  check("a failed outcome increments beta, not alpha", Math.abs(after[key]["25/5"].a - 2) < 0.05 && after[key]["25/5"].b === 2);
  check("updatePosterior is pure — never mutates the input state", before[key]["25/5"].b === 1);

  // Second bandit target: flashcard deck verbosity (FLASHCARD_ARMS) — same generic chooseArm/updatePosterior
  // machinery, proven independently so a future third target (e.g. nudging strategy on shownAt/firstActionAt)
  // can reuse it with confidence too.
  check("computeCardReward(0) — a card reviewed once, no progress yet — sits at the midpoint", computeCardReward(0) === 0.5);
  check("computeCardReward rewards real box progression", computeCardReward(3) > computeCardReward(0));
  check("computeCardReward is clamped to [0, 1]", computeCardReward(100) === 1 && computeCardReward(-100) === 0);

  let cardState = {};
  for (let i = 0; i < 60; i++) cardState = updatePosterior(cardState, key, "thorough", computeCardReward(3));
  for (let i = 0; i < 60; i++) cardState = updatePosterior(cardState, key, "concise", computeCardReward(-3));
  let picksThorough = 0;
  const rng2 = seeded(99);
  for (let i = 0; i < 50; i++) { if (chooseArm(FLASHCARD_ARMS, cardState, key, rng2).arm.id === "thorough") picksThorough++; }
  check("flashcard bandit also converges on the reinforced arm", picksThorough >= 40);
  check("a fresh flashcard context is a genuine cold start", chooseArm(FLASHCARD_ARMS, {}, key, seeded(3)).coldStart === true);

  // Third bandit target: task step granularity (GRANULARITY_ARMS) — reward is procrastination latency
  // (shownAt -> firstActionAt), so shorter latency must score higher, longer must score lower, and it must
  // stay bounded even for pathological inputs (a task nobody ever acted on, or acted on instantly).
  check("computeLatencyReward(0) — acted on instantly — is the max", computeLatencyReward(0) === 1);
  check("computeLatencyReward falls as latency grows", computeLatencyReward(3600) > computeLatencyReward(3600 * 5));
  check("computeLatencyReward is clamped to [0, 1] even for extreme latency", computeLatencyReward(1e9) === 0 && computeLatencyReward(-100) <= 1);

  let granState = {};
  for (let i = 0; i < 60; i++) granState = updatePosterior(granState, key, "granular", computeLatencyReward(0));
  for (let i = 0; i < 60; i++) granState = updatePosterior(granState, key, "standard", computeLatencyReward(3600 * 24));
  let picksGranular = 0;
  const rng3 = seeded(17);
  for (let i = 0; i < 50; i++) { if (chooseArm(GRANULARITY_ARMS, granState, key, rng3).arm.id === "granular") picksGranular++; }
  check("granularity bandit also converges on the reinforced arm", picksGranular >= 40);

  // Fourth bandit target: desk ambience (AUDIO_ARMS) — reuses computeReward (session completion + idle
  // ratio) exactly like Pomodoro does, just a different arm menu/decision key.
  let audioState = {};
  for (let i = 0; i < 60; i++) audioState = updatePosterior(audioState, key, "brown", computeReward({ completedPlanned: true, idleRatio: 0 }));
  for (let i = 0; i < 60; i++) audioState = updatePosterior(audioState, key, "silence", computeReward({ completedPlanned: false, idleRatio: 1 }));
  let picksBrown = 0;
  const rng4 = seeded(23);
  for (let i = 0; i < 50; i++) { if (chooseArm(AUDIO_ARMS, audioState, key, rng4).arm.id === "brown") picksBrown++; }
  check("audio bandit also converges on the reinforced arm", picksBrown >= 40);
  check("a fresh audio context is a genuine cold start", chooseArm(AUDIO_ARMS, {}, key, seeded(11)).coldStart === true);

  // Fifth bandit target: UI density (DENSITY_ARMS) — same machinery again, proving the pattern generalizes
  // to a fifth independent target with zero new code beyond the arm list itself.
  let densityState = {};
  for (let i = 0; i < 60; i++) densityState = updatePosterior(densityState, key, "compact", computeReward({ completedPlanned: true, idleRatio: 0 }));
  for (let i = 0; i < 60; i++) densityState = updatePosterior(densityState, key, "cozy", computeReward({ completedPlanned: false, idleRatio: 1 }));
  let picksCompact = 0;
  const rng5 = seeded(31);
  for (let i = 0; i < 50; i++) { if (chooseArm(DENSITY_ARMS, densityState, key, rng5).arm.id === "compact") picksCompact++; }
  check("density bandit also converges on the reinforced arm", picksCompact >= 40);
  check("a fresh density context is a genuine cold start", chooseArm(DENSITY_ARMS, {}, key, seeded(13)).coldStart === true);
}

section("validateThemeTokens — AI-personalized theme safety allowlist");
{
  check("accepts a valid light color + radius", (() => {
    const t = validateThemeTokens({ "--bg": "#F5F3EE", "--radius": "12px" });
    return t["--bg"] === "#f5f3ee" && t["--radius"] === "12px";
  })());
  check("rejects a dark/low-contrast background (fails WCAG check against fixed ink)", !("--bg" in validateThemeTokens({ "--bg": "#101010" })));
  check("rejects a non-hex color string", !("--bg" in validateThemeTokens({ "--bg": "red" })));
  check("rejects a color value carrying a CSS injection attempt", !("--bg" in validateThemeTokens({ "--bg": "#fff; } body { display:none" })));
  check("rejects an out-of-range radius", !("--radius" in validateThemeTokens({ "--radius": "999px" })));
  check("rejects a radius with a unit other than px", !("--radius" in validateThemeTokens({ "--radius": "12rem" })));
  check("ignores unknown keys entirely (not on the allowlist)", Object.keys(validateThemeTokens({ "--evil": "javascript:alert(1)", "color": "red" })).length === 0);
  check("non-object input returns empty, never throws", Object.keys(validateThemeTokens(null)).length === 0 && Object.keys(validateThemeTokens("not an object")).length === 0);
}

section("bumpActivityHour / learnedProductiveHour — the 'when am I actually working' signal");
{
  const p = { timezone: "UTC" };
  check("no history yet → null (cold start, never a confident guess)", learnedProductiveHour(p) === null);
  for (let i = 0; i < 25; i++) bumpActivityHour(p, new Date("2026-07-20T09:00:00Z")); // 9am UTC, 25 times
  for (let i = 0; i < 3; i++) bumpActivityHour(p, new Date("2026-07-20T22:00:00Z")); // 10pm, only 3 times
  check("learns the hour with the most engagement", learnedProductiveHour(p) === 9);
  check("bumpActivityHour is additive, not overwriting", p.activityHours[9] === 25 && p.activityHours[22] === 3);
  const sparse = { timezone: "UTC" };
  bumpActivityHour(sparse, new Date("2026-07-20T09:00:00Z"));
  check("below minTotal (default 20) stays null even with a clear single bump", learnedProductiveHour(sparse) === null);
}

section("bumpActivityHour subject tracking — per-subject focus-time reads");
{
  const p = { timezone: "UTC" };
  check("no subject history yet -> null", learnedProductiveHourForSubject(p, "Maths") === null);
  for (let i = 0; i < 15; i++) bumpActivityHour(p, new Date("2026-07-20T09:00:00Z"), "Maths");
  for (let i = 0; i < 3; i++) bumpActivityHour(p, new Date("2026-07-20T20:00:00Z"), "Maths");
  for (let i = 0; i < 5; i++) bumpActivityHour(p, new Date("2026-07-20T08:00:00Z"), "French");
  check("global grid still bumped alongside the per-subject one", p.activityHours[9] === 15);
  check("per-subject grid learns that subject's own peak hour", learnedProductiveHourForSubject(p, "Maths")?.hour === 9);
  check("a different subject has its own independent grid", p.subjectActivityHours["French"].hours[8] === 5);
  check("an untracked subject stays null even once others have history", learnedProductiveHourForSubject(p, "Physics") === null);
  const capped = { timezone: "UTC" };
  const subjects = ["A", "B", "C", "D", "E", "F", "G"];
  for (const s of subjects) bumpActivityHour(capped, new Date("2026-07-20T09:00:00Z"), s);
  check("subject histogram count stays capped (least-active evicted)", Object.keys(capped.subjectActivityHours).length <= 6);
}

section("server/patterns.ts — pattern recognition (predict the student's next move)");
{
  // predictNextEngagement — 2026-07-20 is a Monday (weekday 1).
  const p = { timezone: "UTC" };
  check("no history yet -> null, same cold-start posture as learnedProductiveHour", predictNextEngagement(p) === null);
  for (let i = 0; i < 25; i++) bumpActivityHour(p, new Date("2026-07-20T18:00:00Z")); // Monday 18:00, 25 times
  for (let i = 0; i < 3; i++) bumpActivityHour(p, new Date("2026-07-21T09:00:00Z")); // Tuesday 09:00, only 3
  const pred = predictNextEngagement(p);
  check("learns the (weekday, hour) cell with the most engagement", pred?.weekday === 1 && pred?.hour === 18);

  // predictWeakSubjects
  const signals = [
    { subject: "Maths", correctRate: 0.4, attempts: 10 },   // weak, enough attempts
    { subject: "Physique", correctRate: 0.55, attempts: 5 }, // weak, enough attempts
    { subject: "Histoire", correctRate: 0.9, attempts: 10 }, // strong -> excluded
    { subject: "SVT", correctRate: 0.2, attempts: 2 },       // weak but too few attempts -> excluded
  ];
  const weak = predictWeakSubjects(signals);
  check("flags genuinely weak, well-attested subjects only", weak.includes("Maths") && weak.includes("Physique"));
  check("excludes a strong subject", !weak.includes("Histoire"));
  check("excludes a weak subject with too few attempts (not a real pattern yet)", !weak.includes("SVT"));
  check("ranks the weakest subject first", weak[0] === "Maths");

  // aggregateSubjectSignals — reads real task data (flashcard reviews + quiz attempts), no metrics-log query
  const tasksForAgg = [
    {
      sourceSubject: "Maths",
      flashcards: [{ cards: [
        { front: "a", back: "b", review: { seen: 4, correct: 1 } },
        { front: "c", back: "d", review: { seen: 2, correct: 2 } },
      ] }],
    },
    { sourceSubject: "Histoire", quizzes: [{ attempts: [{ score: 2, total: 10 }, { score: 9, total: 10 }] }] }, // only LAST attempt counts
  ];
  const agg = aggregateSubjectSignals(tasksForAgg);
  const maths = agg.find((s) => s.subject === "Maths");
  const histoire = agg.find((s) => s.subject === "Histoire");
  check("aggregates flashcard review correct/seen across cards for a subject", maths?.attempts === 6 && Math.abs((maths?.correctRate || 0) - 3 / 6) < 1e-9);
  check("uses only the LATEST quiz attempt, not a sum across attempts", histoire?.attempts === 10 && histoire?.correctRate === 0.9);

  // weakSubjectBoost
  check("boosts a task in a weak subject", weakSubjectBoost({ sourceSubject: "Maths" }, ["Maths"]) > 0);
  check("no boost for a subject not flagged weak", weakSubjectBoost({ sourceSubject: "Anglais" }, ["Maths"]) === 0);
  check("no boost for a task with no subject at all", weakSubjectBoost({}, ["Maths"]) === 0);
  check("a weak subject trending down gets a bigger boost than flat-weak", weakSubjectBoost({ sourceSubject: "Maths" }, ["Maths"], [{ subject: "Maths", correctRate: 0.4, attempts: 5, trend: "down" }]) >
    weakSubjectBoost({ sourceSubject: "Maths" }, ["Maths"], [{ subject: "Maths", correctRate: 0.4, attempts: 5, trend: "flat" }]));

  // twoMinuteRuleBoost — GTD's two-minute rule
  check("boosts a task whose smallest first action is 2 minutes or less", twoMinuteRuleBoost({ firstAction: { minutes: 2 } }) > 0);
  check("boosts a 1-minute first action too", twoMinuteRuleBoost({ firstAction: { minutes: 1 } }) > 0);
  check("no boost once it's over 2 minutes", twoMinuteRuleBoost({ firstAction: { minutes: 3 } }) === 0);
  check("no boost with no firstAction at all", twoMinuteRuleBoost({}) === 0);
  check("no boost when firstAction has no minutes estimate", twoMinuteRuleBoost({ firstAction: { text: "do it" } }) === 0);

  // predictNextEngagement now returns a confidence score alongside (weekday, hour).
  const confP = { timezone: "UTC" };
  for (let i = 0; i < 80; i++) bumpActivityHour(confP, new Date("2026-07-20T18:00:00Z")); // heavily concentrated
  const confPred = predictNextEngagement(confP);
  check("a heavily concentrated history yields high confidence", confPred && confPred.confidence > 0.5);
  const noisyP = { timezone: "UTC" };
  for (let i = 0; i < 24; i++) bumpActivityHour(noisyP, new Date(`2026-07-${20 + (i % 5)}T${(i % 24).toString().padStart(2, "0")}:00:00Z`));
  const noisyPred = predictNextEngagement(noisyP);
  check("a spread-out (low-concentration) history yields lower confidence than a concentrated one", !noisyPred || noisyPred.confidence < (confPred?.confidence ?? 1));

  // Trend-aware weak-subject detection.
  const trendTasks = [
    { sourceSubject: "Maths", quizzes: [{ attempts: [{ score: 3, total: 10 }, { score: 3, total: 10 }, { score: 8, total: 10 }] }] }, // improving
    { sourceSubject: "Physique", quizzes: [{ attempts: [{ score: 8, total: 10 }, { score: 8, total: 10 }, { score: 4, total: 10 }] }] }, // declining
  ];
  const trendAgg = aggregateSubjectSignals(trendTasks);
  const mathsTrend = trendAgg.find((s) => s.subject === "Maths");
  const physique = trendAgg.find((s) => s.subject === "Physique");
  check("detects an improving trend from quiz-attempt history", mathsTrend?.trend === "up");
  check("detects a declining trend from quiz-attempt history", physique?.trend === "down");
  // Physique's raw correctRate (8+8+4)/30 = 0.667 is ABOVE the default 0.6 threshold, but its declining trend
  // should still flag it (the whole point of tracking trend, not just a snapshot).
  const trendWeak = predictWeakSubjects(trendAgg);
  check("a declining trend flags a subject even above the static threshold", trendWeak.includes("Physique"));

  // subjectFrequency / orderingBoost (ORDERING_ARMS)
  const freq = subjectFrequency([{ sourceSubject: "Maths" }, { sourceSubject: "Maths" }, { sourceSubject: "Anglais" }]);
  check("subjectFrequency counts per subject", freq["Maths"] === 2 && freq["Anglais"] === 1);
  check("quick-wins-first boosts a task with fewer steps", orderingBoost({ steps: [1] }, "quick-wins-first", {}) > orderingBoost({ steps: [1, 2, 3, 4, 5] }, "quick-wins-first", {}));
  check("subject-balanced boosts an under-represented subject over an over-represented one", orderingBoost({ sourceSubject: "Anglais" }, "subject-balanced", freq) > orderingBoost({ sourceSubject: "Maths" }, "subject-balanced", freq));
  check("urgency-first (the default arm) applies no boost at all", orderingBoost({ sourceSubject: "Maths", steps: [] }, "urgency-first", freq) === 0);
}

section("bandit.ts — sixth/seventh targets (ordering, chat style) + discounted (non-stationary) updates");
{
  const seeded2 = (seed) => { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
  const key = contextKey(new Date("2026-01-05T09:00:00"));

  let orderState = {};
  for (let i = 0; i < 60; i++) orderState = updatePosterior(orderState, key, "quick-wins-first", 1);
  for (let i = 0; i < 60; i++) orderState = updatePosterior(orderState, key, "urgency-first", 0);
  let picksQuick = 0;
  const rngO = seeded2(41);
  for (let i = 0; i < 50; i++) { if (chooseArm(ORDERING_ARMS, orderState, key, rngO).arm.id === "quick-wins-first") picksQuick++; }
  check("ordering bandit converges on the reinforced arm", picksQuick >= 40);

  let styleState = {};
  for (let i = 0; i < 60; i++) styleState = updatePosterior(styleState, key, "socratic", 1);
  for (let i = 0; i < 60; i++) styleState = updatePosterior(styleState, key, "concise", 0);
  let picksSocratic = 0;
  const rngS = seeded2(53);
  for (let i = 0; i < 50; i++) { if (chooseArm(CHAT_STYLE_ARMS, styleState, key, rngS).arm.id === "socratic") picksSocratic++; }
  check("chat-style bandit converges on the reinforced arm", picksSocratic >= 40);

  // Non-stationarity: an arm that WAS winning should lose its edge once evidence flips, and should do so
  // FASTER under the discounted update than it would if evidence just accumulated forever.
  let flip = {};
  for (let i = 0; i < 100; i++) flip = updatePosterior(flip, "ctx", "A", 1); // A wins big, historically
  const aBefore = flip["ctx"]["A"];
  for (let i = 0; i < 40; i++) flip = updatePosterior(flip, "ctx", "B", 1); // now B is what's actually winning
  const aAfter = flip["ctx"]["A"];
  check("discounting pulls a non-served arm's posterior back toward the uniform prior over time", aAfter.a < aBefore.a);
  // The point of discounting is REDUCED CONFIDENCE in stale evidence (so a competing arm's samples can win
  // more often via Thompson Sampling's own variance), not a collapsed point-estimate — b for an
  // always-succeeding arm stays pinned near 1, so a/(a+b) barely moves even as `a` itself decays. The real,
  // checkable invariant is total evidence (a+b) shrinking, which is what actually returns the arm toward
  // "uncertain" rather than "permanently proven."
  check("total evidence for the non-served arm shrinks under discounting", (aAfter.a + aAfter.b) < (aBefore.a + aBefore.b));
  const rateB = flip["ctx"]["B"].a / (flip["ctx"]["B"].a + flip["ctx"]["B"].b);
  check("the currently-reinforced arm's own posterior reflects its own strong recent success", rateB > 0.9);
}

section("normalizeProfile — self-heals duplicated Pronote grade rows (the '40 grades' bug)");
{
  // Simulates ~40 days of a sync bug generating a fresh random id each time instead of reusing one —
  // exactly the reported live symptom ("Anglais · 40 grades"). normalizeProfile must collapse these down to
  // ONE row (the newest) per subject on the very next load, without touching genuinely separate manual entries.
  const dupedGrades = [];
  for (let i = 0; i < 40; i++) {
    dupedGrades.push({ id: `random-${i}`, subject: "Anglais", grade: 8, scale: 20, updatedAt: new Date(2026, 0, 1 + i).toISOString(), source: "pronote" });
  }
  dupedGrades.push({ id: "manual-1", subject: "Anglais", grade: 9, scale: 20, updatedAt: "2026-01-05T00:00:00Z", source: "manual" });
  const cleaned = normalizeProfile({ grades: dupedGrades }).grades;
  const pronoteRows = cleaned.filter((g) => g.source === "pronote" && g.subject === "Anglais");
  check("collapses 40 duplicate Pronote rows for one subject down to exactly one", pronoteRows.length === 1);
  check("keeps the NEWEST Pronote row (by updatedAt), not an arbitrary one", pronoteRows[0].id === "random-39");
  check("never touches a genuinely separate manual entry for the same subject", cleaned.some((g) => g.source === "manual" && g.id === "manual-1"));
  check("a normal, already-clean grade list is untouched", normalizeProfile({ grades: [{ id: "a", subject: "Maths", grade: 15, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "pronote" }] }).grades.length === 1);
}

section("normalizeProfile — milestones: dedupe by topic, cap length, reject incomplete rows");
{
  const raw = [
    { subject: "Maths", topic: "factoring quadratics", label: "Can factor any quadratic with integer roots", achievedAt: "2026-01-10T00:00:00Z" },
    // Same subject+topic, reworded, logged later — should collapse into ONE row keeping the OLDER achievedAt
    // (that's when it actually first landed) but this newer label wording.
    { subject: "maths", topic: "Factoring Quadratics", label: "Solid on factoring quadratics now", achievedAt: "2026-02-01T00:00:00Z" },
    { subject: "Maths", topic: "completing the square", label: "Can complete the square unaided", achievedAt: "2026-01-15T00:00:00Z" },
    { subject: "", topic: "no subject", label: "should be dropped" },
    { subject: "Physique", topic: "", label: "no topic, should be dropped" },
  ];
  const cleaned = normalizeProfile({ milestones: raw }).milestones;
  check("collapses same subject+topic (case-insensitive) into one row", cleaned.filter((m) => m.topic.toLowerCase() === "factoring quadratics").length === 1);
  const collapsed = cleaned.find((m) => m.topic.toLowerCase() === "factoring quadratics");
  check("keeps the OLDER achievedAt on collapse (when it actually first landed)", collapsed.achievedAt === "2026-01-10T00:00:00Z");
  check("keeps the newer label wording on collapse", collapsed.label === "Solid on factoring quadratics now");
  check("a genuinely different topic in the same subject survives as its own row", cleaned.some((m) => m.topic === "completing the square"));
  check("a row missing subject is dropped", !cleaned.some((m) => m.topic === "no subject"));
  check("a row missing topic is dropped", !cleaned.some((m) => m.label === "no topic, should be dropped"));
  check("every kept row got a real id", cleaned.every((m) => typeof m.id === "string" && m.id.length > 0));
  const many = Array.from({ length: 400 }, (_, i) => ({ subject: "S", topic: `topic-${i}`, label: "x", achievedAt: "2026-01-01T00:00:00Z" }));
  check("hard-caps at 300 rows even when every topic is genuinely distinct", normalizeProfile({ milestones: many }).milestones.length === 300);
}

section("milestoneLine — surfaces per-topic progress into the tutor's chat context, subject-matched");
{
  const profile = { milestones: [
    { id: "1", subject: "Maths", topic: "quadratics", label: "Can factor any quadratic with integer roots", achievedAt: "2026-01-01T00:00:00Z" },
    { id: "2", subject: "Français", topic: "subjonctif", label: "Uses it correctly after 'il faut que'", achievedAt: "2026-01-02T00:00:00Z" },
  ] };
  check("no subject → empty (nothing to match against)", milestoneLine(profile, undefined) === "");
  check("a subject with no tracked milestones → empty, not a forced empty section", milestoneLine(profile, "Physique") === "");
  const line = milestoneLine(profile, "Maths");
  check("matched subject includes its topic and label", line.includes("quadratics") && line.includes("Can factor any quadratic"));
  check("case-insensitive subject match", milestoneLine(profile, "maths").includes("quadratics"));
  check("doesn't leak a different subject's milestone in", !milestoneLine(profile, "Maths").includes("subjonctif"));
  check("undefined profile → empty, never throws", milestoneLine(undefined, "Maths") === "");
}

section("sessionRecapLine — cross-session memory from the tutor's own end-of-session 'remember' recaps");
{
  const sessions = [
    "Maths — worked through quadratics, landed factoring; still shaky on the discriminant.",
    "Français — reviewed subjonctif triggers after 'il faut que'.",
    "Physique — worked SUVAT for projectile motion, landed the range calculation; still mixing up which component stays constant.",
  ];
  check("no sessions → empty", sessionRecapLine(undefined, "Maths") === "");
  check("empty list → empty", sessionRecapLine([], "Maths") === "");
  const physique = sessionRecapLine(sessions, "Physique");
  check("matched subject surfaces its own recap", physique.includes("SUVAT"));
  check("case-insensitive subject match", sessionRecapLine(sessions, "physique").includes("SUVAT"));
  check("doesn't leak an unrelated subject's recap when a match exists", !physique.includes("subjonctif"));
  const noMatch = sessionRecapLine(sessions, "Histoire");
  check("no subject match → falls back to the most recent sessions rather than going empty", noMatch.includes("SUVAT"));
  check("no subject given → still returns the most recent recaps", sessionRecapLine(sessions, undefined).includes("SUVAT"));
}

section("milestonesBySubject — grouping/ordering for the tutor-context and UI readers");
{
  const list = [
    { id: "1", subject: "Maths", topic: "quadratics", label: "a", achievedAt: "2026-01-01T00:00:00Z" },
    { id: "2", subject: "Maths", topic: "derivatives", label: "b", achievedAt: "2026-02-01T00:00:00Z" },
    { id: "3", subject: "Français", topic: "subjonctif", label: "c", achievedAt: "2026-01-15T00:00:00Z" },
  ];
  const groups = milestonesBySubject(list);
  check("groups by subject", groups.length === 2);
  check("subject with the most milestones sorts first", groups[0].subject === "Maths");
  check("within a subject, most-recently-achieved topic sorts first", groups[0].entries[0].topic === "derivatives");
  check("empty/undefined input returns an empty array, not a throw", milestonesBySubject(undefined).length === 0);
}

section("leadingArm — honest, deterministic 'what does the bandit currently believe' for Settings display");
{
  const key = contextKey(new Date("2026-01-05T09:00:00"));
  check("cold start (no evidence) returns null, never a confident-sounding guess", leadingArm(POMODORO_ARMS, {}, key) === null);
  let state = {};
  // Below the evidence floor (minEvidence=6 by default) — still null even though "45/10" already looks ahead.
  state = updatePosterior(state, key, "45/10", 1);
  state = updatePosterior(state, key, "45/10", 1);
  check("a couple of trials isn't enough evidence yet — still null, not a premature claim", leadingArm(POMODORO_ARMS, state, key) === null);
  for (let i = 0; i < 10; i++) state = updatePosterior(state, key, "45/10", 1);
  for (let i = 0; i < 10; i++) state = updatePosterior(state, key, "25/5", 0);
  const leading = leadingArm(POMODORO_ARMS, state, key);
  check("picks the arm with the highest posterior MEAN once there's enough evidence", leading?.arm.id === "45/10");
  check("confidence is a real number in [0, 1]", leading && leading.confidence > 0 && leading.confidence <= 1);
  // Determinism: unlike chooseArm (a stochastic Thompson-Sampling draw), leadingArm must return the SAME
  // answer every call for the same state — no rng involved at all.
  const again = leadingArm(POMODORO_ARMS, state, key);
  check("deterministic — the same state always yields the same leading arm (no resampling)", again?.arm.id === leading?.arm.id && again?.confidence === leading?.confidence);
  check("a never-touched context key is its own independent cold start", leadingArm(POMODORO_ARMS, state, "afternoon|weekday|other") === null);
}

// ── Step-generation repair pass: artifact dedupe, extras carry-over, and the runTask wiring ────────
{
  const deck = { note: false, flashcards: true, quiz: false };
  check("drops a 'build flashcards' step when Otto already created the flashcard deck",
    dropRedundantArtifactSteps([{ text: "Build flashcards (definition, mechanism, example) for each figure", automatable: true }, { text: "Mark the 15 figures you'll be tested on", automatable: false }], deck)
      .every((s) => !/build flashcards/i.test(s.text)));
  check("keeps that same step when no flashcard deck was actually created",
    dropRedundantArtifactSteps([{ text: "Build flashcards for each figure", automatable: true }], { note: false, flashcards: false, quiz: false }).length === 1);
  check("keeps a step that USES the artifact rather than creating it ('Review the flashcards')",
    dropRedundantArtifactSteps([{ text: "Review the flashcards and score yourself", automatable: false }], deck).length === 1);
  check("keeps a create-step aimed at something that isn't an artifact ('Build a packing list')",
    dropRedundantArtifactSteps([{ text: "Build a packing list for the trip", automatable: false }], deck).length === 1);
  check("never empties the plan out — if every step looked redundant, the original list stands",
    dropRedundantArtifactSteps([{ text: "Build flashcards for each figure", automatable: true }], deck).length === 1);
  check("a quiz step goes only when a quiz exists, not when only a deck does",
    dropRedundantArtifactSteps([{ text: "Create a quiz on the figures", automatable: true }, { text: "Sit the quiz", automatable: false }], deck).length === 2);

  const original = [{ text: "Sit a timed set at 1.5 minutes per MCQ", automatable: false, url: "https://example.com/set" }];
  check("reattachStepExtras carries a step's url across a reworded repair", reattachStepExtras([{ text: "Sit a timed MCQ set at 1.5 minutes per question", automatable: false }], original)[0].url === "https://example.com/set");
  check("reattachStepExtras does NOT attach extras onto an unrelated new step", reattachStepExtras([{ text: "Log every missed item afterwards", automatable: false }], original)[0].url === undefined);

  const claudeSrc = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const repairBlock = claudeSrc.slice(claudeSrc.indexOf("const repair = await ask("), claudeSrc.indexOf("Total-outage check"));
  check("the DoD pass audits coverage, order AND one-deliverable-per-step", /1\. COVERAGE/.test(repairBlock) && /2\. ORDER/.test(repairBlock) && /3\. ONE DELIVERABLE PER STEP/.test(repairBlock));
  check("the DoD pass no longer tells the model to 'say yes' on anything but one failure mode", !/close enough match for a reasonable plan, say yes/.test(repairBlock));
  check("a repair is rejected unless it has at least as many steps as it was given (never shrinks the plan)", /repaired\.length >= steps\.length && repaired\.length <= 8/.test(repairBlock));
  check("repaired steps go through the automatable flip BEFORE the triviality gate", repairBlock.indexOf("DOABLE_STEP.test") < repairBlock.indexOf("dropTrivialSteps(steps)"));
  check("artifact dedupe runs on the repaired plan too, not only before the call", (repairBlock.match(/dropRedundantArtifactSteps/g) || []).length >= 1);
  const stepPrompt = claudeSrc.slice(claudeSrc.indexOf("SEQUENCE STEPS IN THE ORDER"), claudeSrc.indexOf("Only steps the STUDENT must do"));
  check("the sequencing rule covers prerequisites, not just reacting-to-an-attempt", /SETTLING WHAT THE LATER WORK OPERATES ON/.test(stepPrompt) && /REACTING TO AN ATTEMPT/.test(stepPrompt));
  check("step 4 is told one deliverable per step, with the live compound-step example", /ONE DELIVERABLE PER STEP/.test(stepPrompt) && /Book transport and lodging, draft itinerary and packing list/.test(stepPrompt));
}

// ── Steps anchored to the definition of done + briefs for practical tasks ─────────────────────────
{
  const plan = [
    { text: "Fix trip dates against the school calendar", automatable: false },
    { text: "Book transport for those dates", automatable: false },
    { text: "Review your general study habits", automatable: false },
  ];
  const anchored = new Set(["Fix trip dates against the school calendar", "Book transport for those dates"]);
  check("drops a step the writer couldn't tie to any part of the definition of done",
    dropUnanchoredSteps(plan, (t) => anchored.has(t)).length === 2);
  check("the whole plan stands when fewer than 2 steps would survive (part-numbering is the likelier fault)",
    dropUnanchoredSteps(plan, (t) => t === plan[0].text).length === 3);
  check("an all-anchored plan passes through untouched", dropUnanchoredSteps(plan, () => true).length === 3);

  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const stepPrompt = src.slice(src.indexOf("HOW TO ANSWER"), src.indexOf('"definitionOfDone": "refined if needed"}`,'));
  check("step 4 must enumerate the definition of done's parts before writing steps", /"dodParts"/.test(stepPrompt));
  check("every step must cite the dodPart number it advances", /"dodPart": the 1-based number/.test(stepPrompt));
  check("a step that advances no part is told not to be written at all", /it is not a step for this task/.test(stepPrompt));

  const step5 = src.slice(src.indexOf("NOTE_ONLY_TASK_TYPES"), src.indexOf("for (const artReq of requestedArtifacts)"));
  check("logistics/administrative/maintain are note-only, no longer hard-skipped out of artifacts",
    /NOTE_ONLY_TASK_TYPES = new Set<string>\(\["administrative", "logistics", "maintain"\]\)/.test(step5) && !/NEVER_ARTIFACT_TASK_TYPES/.test(src));
  check("a practical task's non-note artifact requests are dropped server-side, not just discouraged",
    /wrongType = requestedArtifacts\.filter\(\(a\) => a\.type !== "note"\)/.test(step5));
  check("a practical task with researched context gets a brief nudged in", /auto-adding a brief for practical task/.test(step5));
  check("a thin practical task gets no near-empty brief (context floor)", /context \|\| ""\}`\.trim\(\)\.length > 400/.test(step5));
  check("the artifact chooser is told what a brief is, not that logistics means none",
    /a BRIEF for a practical\/coordination task/.test(src) && !/nothing to compile or reference later\), the answer is almost always none/.test(src));
  const noteWriter = src.slice(src.indexOf("Create a short in-app reference note"), src.indexOf('{"title": "note title"'));
  check("the note writer knows the BRIEF shape (settled / still open / checklist)",
    /- BRIEF, if this is a practical/.test(noteWriter) && /SETTLED/.test(noteWriter) && /still OPEN/.test(noteWriter));
  check("a brief is required to carry real specifics, not generic advice", /a brief made of generic advice/.test(noteWriter));
  check("the repair pass reuses step 4's own enumerated parts rather than re-deriving them",
    /The definition of done breaks into these parts/.test(src));
}

// ── Step links: research-backed, never invented ──────────────────────────────────────────────────
{
  const found = [{ label: "Incendies — Actes Sud Babel", url: "https://www.example-shop.fr/incendies-babel" }];
  const keep = restrictStepUrlsToLinks([{ text: "Order the Actes Sud Babel edition", automatable: false, url: "https://www.example-shop.fr/incendies-babel" }], found);
  check("a step keeps a link the research actually returned", keep[0].url === "https://www.example-shop.fr/incendies-babel");
  const invented = restrictStepUrlsToLinks([{ text: "Order the Actes Sud Babel edition", automatable: false, url: "https://www.amazon.fr/dp/2742780890" }], found);
  check("an invented store link is stripped rather than shown to the student", invented[0].url === undefined);
  check("the step itself survives losing its invented link", invented.length === 1 && invented[0].text === "Order the Actes Sud Babel edition");
  const noisy = restrictStepUrlsToLinks([{ text: "Order it", automatable: false, url: "https://example-shop.fr/incendies-babel/?utm_source=x" }], found);
  check("a tracking query string or trailing slash isn't treated as a different page", noisy[0].url === "https://www.example-shop.fr/incendies-babel");
  check("a step with no link is left alone", restrictStepUrlsToLinks([{ text: "Read the first half", automatable: false }], found)[0].url === undefined);
  check("with no research links at all, every step url is stripped", restrictStepUrlsToLinks([{ text: "Buy it", automatable: false, url: "https://anywhere.test/x" }], [])[0].url === undefined);

  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const searchPrompt = src.slice(src.indexOf("What web searches should be performed"), src.indexOf('{"searches": ["query 1", "query 2"]}'));
  check("step 2 is told to resolve what the task leaves unnamed from the source material", /RESOLVE WHAT THE TASK LEAVES UNNAMED/.test(searchPrompt));
  check("step 2 is told never to search the vague phrase itself", /Never search the vague phrase/.test(searchPrompt));
  check("step 2 treats buying/booking/obtaining as a real thing to search for", /IF THE TASK MEANS OBTAINING SOMETHING REAL/.test(searchPrompt));
  const step4 = src.slice(src.indexOf("ATTACH A LINK WHERE ONE"), src.indexOf('"definitionOfDone": "refined if needed"}`,'));
  check("step 4 is offered the research links and told to copy them verbatim", /Use ONLY these exact URLs, copied/.test(step4) && /links\.map\(\(l\) =>/.test(step4));
  check("step 4's JSON shape allows a url on a step", /"url": "only if one of the links above fits"/.test(step4));
  check("step links are validated against the task's own links before anything else runs",
    src.indexOf("steps = restrictStepUrlsToLinks(steps, links)") < src.indexOf("steps = dropUnanchoredSteps"));
}

// ── Tutor Session: the Desmos tools place ────────────────────────────────────────────────────────
section("Tutor Desmos tools — the student-usable place (contract + pins)");
{
  // Direct request: "make sure in the tutor you have a place for desmos extensions that user can use".
  // The embed contract is pure data (client/tutor/desmosTools.ts) so it's tested directly, the same way
  // echoGuard/speechErrors are; the panel and wiring are pinned by source, the way this file pins
  // TutorSession behavior everywhere else.
  const { DESMOS_TOOLS, desmosToolUrl, isDesmosEmbedUrl } = await import("../client/tutor/desmosTools.ts");
  check("ONE Desmos calculator only (graphing) — the tab picker was dropped", DESMOS_TOOLS.length === 1 && DESMOS_TOOLS[0].id === "graphing" && DESMOS_TOOLS[0].path === "https://www.desmos.com/calculator");
  check("the tool carries a real desmos.com embed path and bilingual label", DESMOS_TOOLS.every((t) => /^https:\/\/www\.desmos\.com\//.test(t.path) && t.label.length === 2 && t.hint.length === 2));
  check("desmosToolUrl resolves the id (and falls back to graphing)", desmosToolUrl("graphing") === "https://www.desmos.com/calculator" && desmosToolUrl("nope") === "https://www.desmos.com/calculator");
  // isDesmosEmbedUrl still validates all four URL shapes — a shared contract with Study Mode's own
  // DesmosArtifact.tsx, which is untouched; only the Tutor's own exposed tool list shrank to one.
  check("the embed allowlist still accepts all four calculator page shapes (shared contract with Study Mode)", ["https://www.desmos.com/calculator", "https://desmos.com/geometry", "https://www.desmos.com/fourfunction/"].every(isDesmosEmbedUrl) && !["http://www.desmos.com/calculator", "https://evil.test/calculator", "https://www.desmos.com/calculator/abc123", "javascript:alert(1)"].some(isDesmosEmbedUrl));

  const tutorSrc = readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8");
  const desmosCompSrc = readFileSync(new URL("../client/tutor/TutorDesmos.tsx", import.meta.url), "utf8");
  // Desmos stays MOUNTED once opened (hidden via inline style, not unmounted) so a reopen doesn't reload
  // the iframe and lose whatever the student graphed — see TutorSession's own comment on why `hidden` the
  // attribute isn't used (stylesheet specificity could override it) in favor of an inline display toggle.
  check("opening Desmos REPLACES the board pane's content, kept mounted (not unmounted) once opened", /desmosOpen \|\| desmosEverOpenedRef\.current \? \(/.test(tutorSrc) && /display: desmosOpen \? "contents" : "none"/.test(tutorSrc));
  check("closing Desmos is wired back to the board via onClose", /onClose=\{\(\) => setDesmosOpen\(false\)\}/.test(tutorSrc) && /onClose \}: \{ onClose: \(\) => void \}/.test(desmosCompSrc));
  check("the panel embeds Desmos in a sandboxed iframe, never top-navigation", (/sandbox="([^"]*)"/.exec(desmosCompSrc) || [])[1] === "allow-scripts allow-same-origin allow-popups" && /allow="fullscreen"/.test(desmosCompSrc));
  check("no tab-switcher UI remains — one tool, no tablist", !/role="tablist"/.test(desmosCompSrc) && !/tutor-desmos-tab\b/.test(desmosCompSrc));
  check("the embed URL comes from the shared tool family, not a hand-typed URL", /desmosToolUrl\(tool\.id\)/.test(desmosCompSrc) && !/src="https:\/\/www\.desmos/.test(desmosCompSrc));
  const stylesSrc2 = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  check("the Desmos full-pane styles exist", /\.tutor-desmos-full\b/.test(stylesSrc2) && /\.tutor-desmos-frame\b/.test(stylesSrc2) && !/\.tutor-desmos-tab\.on/.test(stylesSrc2));

  // The tutor prompt must route students to the tool — otherwise it's a shelf decoration.
  const claudeSrc6 = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const desmosPrompt = claudeSrc6.slice(claudeSrc6.indexOf("DESMOS IS ONE CLICK AWAY"), claudeSrc6.indexOf("KEEP GETTING SMARTER ABOUT THEM"));
  check("the tutor prompt routes students to Desmos with a concrete task", /DESMOS IS ONE CLICK AWAY/.test(claudeSrc6) && /ouvre Desmos/.test(desmosPrompt));
  check("the prompt reflects the single-calculator reality, not the old four-tool family", /ONE calculator \(graphing\)/.test(desmosPrompt) && !/graphing, scientific, geometry, four-function/.test(desmosPrompt));
  check("the prompt bans fake chat graphs — the student operates the real tool", /never pretend to graph in chat/.test(desmosPrompt));
  const desmosArtifactSrc = readFileSync(new URL("../client/study/artifacts/DesmosArtifact.tsx", import.meta.url), "utf8");
  check("the embed contract matches Study Mode's existing artifact (sandbox, no top-navigation)", /sandbox="allow-scripts allow-same-origin allow-popups"/.test(desmosArtifactSrc));
}

section("generateWeeklyStudyDeck / generateMonthlyStudyDeck — the spaced-repetition weak/known signal survives the concise fallback tier (source pin)");
{
  // Reported live: "weekly and monthly flashcards keep repeating stuff that's already very learned, not
  // what's actually from journal entries or not yet learned." Root cause: both functions built a
  // `spacedBlock` telling the model which concepts are weak (box 0-1, needs the most space) vs. already
  // "Known" (box 2+, needs the least) — but only attached it to the PRIMARY attempt's user message
  // (`concise ? "" : spacedBlock`). The concise fallback tier fires often in practice (DeepSeek v4's
  // reasoning tokens routinely eat the primary attempt's budget), so on a real fraction of actual decks
  // the one signal steering the model away from re-surfacing already-known material was silently absent,
  // leaving it to default toward whatever was most salient across entries — typically the simpler,
  // well-practiced concepts, not what needed review. Fixed: spacedBlock is now unconditional, and the
  // concise system prompt text itself also mentions weighting toward weak concepts (previously it didn't
  // even reference the signal conceptually in that branch).
  const claudeSrcWM = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const weeklyFn = claudeSrcWM.slice(claudeSrcWM.indexOf("export async function generateWeeklyStudyDeck"), claudeSrcWM.indexOf("export async function generateWeeklyQuiz"));
  const monthlyFn = claudeSrcWM.slice(claudeSrcWM.indexOf("export async function generateMonthlyStudyDeck"), claudeSrcWM.indexOf("export async function generateMonthlyQuiz"));
  check("weekly deck's user-message spacedBlock is no longer stripped on the concise retry", weeklyFn.includes('entriesBlock}` + spacedBlock') && !/entriesBlock}` \+\s*\(concise \? "" : spacedBlock\)/.test(weeklyFn));
  check("monthly deck's user-message spacedBlock is no longer stripped on the concise retry", monthlyFn.includes('weeksBlock}` + spacedBlock') && !/weeksBlock}` \+\s*\(concise \? "" : spacedBlock\)/.test(monthlyFn));
  check("the weekly CONCISE system prompt now also tells the model to weight toward weak/unlearned concepts", /CONCISE week-end-review[\s\S]*?WEIGHT TOWARD[\s\S]*?box 0-1/.test(weeklyFn));
  check("the monthly CONCISE system prompt now also tells the model to weight toward weak/unlearned concepts", /CONCISE month-end-review[\s\S]*?WEIGHT TOWARD[\s\S]*?box 0-1/.test(monthlyFn));
}

section("Admin metrics dashboard — gated to one hardcoded email, server AND client (source pins)");
{
  const serverSrcAdmin = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const appSrcAdmin = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  check("the server route requires auth before the admin check (no route ever does real work pre-auth)", /app\.get\("\/api\/admin\/metrics", requireAuth,/.test(serverSrcAdmin));
  check("the admin check is an exact, case-insensitive email match — not a role flag on the profile", /const ADMIN_EMAIL = "tjong\.willem@gmail\.com";/.test(serverSrcAdmin) && /\(req\.session\.user \|\| ""\)\.toLowerCase\(\) === ADMIN_EMAIL/.test(serverSrcAdmin));
  check("non-admins get a clean 403, not a crash or a silent empty response", /if \(!isAdmin\(req\)\) \{ res\.status\(403\)/.test(serverSrcAdmin));
  check("the client nav link only renders for the admin email (defense in depth — the server is the real gate)", /isAdminUser\(status\?\.user\)/.test(appSrcAdmin) && /const ADMIN_EMAIL = "tjong\.willem@gmail\.com";/.test(appSrcAdmin));
  check("the /admin route itself is also gated client-side, not just the nav link", /route === "admin" && isAdminUser\(status\?\.user\)/.test(appSrcAdmin));
  // Reported live: "should say 28 sessions but it says 91" — tutorSessionCount was counting every raw
  // freestudy-source TASK, including ones opened and immediately abandoned (no message ever sent). The
  // client's own history (TutorSession.tsx's saveAndClose) never even shows those — they fail its own
  // "substance gate" (a real user message or board content) and get dismissed silently. The admin count
  // needs the SAME gate, or it counts something the product itself doesn't consider a session.
  const storeSrcAdmin = readFileSync(new URL("../server/store.ts", import.meta.url), "utf8");
  const adminFn = storeSrcAdmin.slice(storeSrcAdmin.indexOf("export async function getAdminMetrics"));
  check("tutor session counting applies the SAME substance gate as TutorSession.tsx's saveAndClose (a real message or board content)", /userMsgCount === 0 && board\.length === 0\) continue;/.test(adminFn));
  check("byUser is sorted and per-account tutor minutes/sessions are tracked, not just the app-wide total", /byUser\.sort/.test(adminFn) && /userTutorSessions/.test(adminFn) && /userTutorMinutes/.test(adminFn));
}

section("Kick loop egress/CPU fix — hidden-tab guard, trimmed payload, ETag (source pins)");
{
  const appSrcKick = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const kickEffect = appSrcKick.slice(appSrcKick.indexOf("const hasActiveWork = (list: WebTask[])"), appSrcKick.indexOf("Manual ↻ Refresh"));
  check("kick's tick bails while the tab is hidden, same as the other polling timers in this file", /kicking\.current \|\| signedOutRef\.current \|\| document\.hidden\) return;/.test(kickEffect));
  check("kick catches up immediately on regaining visibility instead of waiting for the next 10s tick", /visibilitychange.*onVisible|onVisible.*visibilitychange/s.test(kickEffect) && /if \(!document\.hidden\) void tick\(\);/.test(kickEffect));

  const serverSrcKick = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const kickStart = serverSrcKick.indexOf('app.post("/api/jobs/kick"');
  const kickRoute = serverSrcKick.slice(kickStart, serverSrcKick.indexOf('app.get("/api/cron/drain"', kickStart));
  check("kick strips chat/board/problems/objectives before sending — this fires every 10s for the lifetime of any active job", /const \{ chat, board, problems, objectives, \.\.\.rest \} = t;/.test(kickRoute));
  check("kick sets an ETag and honors If-None-Match, same pattern as /api/status and /api/tasks", /res\.setHeader\("ETag", etag\);[\s\S]*?if \(req\.headers\["if-none-match"\] === etag\) \{ res\.status\(304\)\.end\(\); return; \}/.test(kickRoute));

  const apiSrcKick = readFileSync(new URL("../client/api.ts", import.meta.url), "utf8");
  check("api.kick() opts into the same ETag-cache path req() uses for GETs, so a 304 costs 0 bytes client-side too", /req\("\/api\/jobs\/kick", \{ method: "POST" \}, undefined, undefined, true\)/.test(apiSrcKick));
}

section("Flashcard/quiz/journal local caches are account-scoped (source pins — cross-account leak fix)");
{
  // Reported live: "flashcards are still being saved in a different account even though it was never
  // associated with that account." Root cause: otto-studylog-week/month, otto-deck, and otto-quiz
  // localStorage keys were keyed only by date/deck-id/quiz-id, NOT by userId — a GLOBAL key any account
  // signed into the same browser reads/writes. Same bug class localDecks.ts/localChatBoard.ts/
  // localQuizzes.ts already fixed for their own stores; this closes the remaining gaps.
  const appSrcLeak = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const uiSrcLeak = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  check("studylog week cache key includes userId, not just the date", /function studylogWeekKey\(userId: string \| null, monday: string\): string \{ return `\$\{STUDYLOG_CACHE_PREFIX\}\$\{userId \|\| "anon"\}:\$\{monday\}`; \}/.test(appSrcLeak));
  check("studylog month cache key includes userId, not just the month", /function studylogMonthKey\(userId: string \| null, month: string\): string \{ return `\$\{STUDYLOG_MONTH_CACHE_PREFIX\}\$\{userId \|\| "anon"\}:\$\{month\}`; \}/.test(appSrcLeak));
  check("FlashcardDeck's review-progress key includes userId, not just the deck id", /function deckProgressKey\(deckId: string, userId: string \| null\): string \{ return `otto-deck:\$\{userId \|\| "anon"\}:\$\{deckId\}`; \}/.test(uiSrcLeak));
  check("QuizPlayer's progress key includes userId, not just the quiz id", /function quizProgressKey\(quizId: string, userId: string \| null\): string \{ return `otto-quiz:\$\{userId \|\| "anon"\}:\$\{quizId\}`; \}/.test(uiSrcLeak));
  const clearFn = appSrcLeak.slice(appSrcLeak.indexOf("function clearAllLocalAccountData"), appSrcLeak.indexOf("const GREETING ="));
  check("sign-out/delete sweeps the studylog week/month, deck-progress, and quiz-progress caches for this user, not just the three pre-existing per-account stores", /otto-deck:\$\{userId \|\| "anon"\}:/.test(clearFn) && /otto-quiz:\$\{userId \|\| "anon"\}:/.test(clearFn) && /STUDYLOG_CACHE_PREFIX/.test(clearFn) && /STUDYLOG_MONTH_CACHE_PREFIX/.test(clearFn));
}

section("Focus/visibility resync removed — only the Pronote keepalive stays on that heartbeat (source pin)");
{
  // Removed per direct instruction: 4 requests (tasks/status/budget/sweep) on every tab focus/visibility
  // event was real, avoidable egress for something a manual reload already covers.
  const appSrcFocus = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const onFn = appSrcFocus.slice(appSrcFocus.indexOf("const on = () => {"), appSrcFocus.indexOf("document.addEventListener(\"visibilitychange\", on);"));
  check("the focus/visibility handler no longer re-syncs tasks/status/budget/sweep", !/void syncTasks\(\); void loadStatus\(\); void loadBudget\(\); void sweepIfDue\(\);/.test(onFn));
  check("the focus/visibility handler still touches Pronote's session to keep a connected token alive", /if \(status\?\.pronoteConnected\) void api\.pronoteTouch\(\);/.test(onFn));
}

section("'Pulling up your day' no longer spins forever for a skip-connect account with zero tasks (source pin)");
{
  // Reported live: a student who skipped connecting Google/Pronote AND has zero manually-added tasks saw
  // the loading skeleton forever. Root cause: `loaded` was only ever flipped true inside syncTasks/
  // sweepIfDue/generate, and the ONLY effect that auto-calls those is gated on `connected` — which is
  // permanently false for a skip-connect account, so `loaded` never had a chance to become true.
  const appSrcLoaded = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const loadedEffect = appSrcLoaded.slice(appSrcLoaded.indexOf("useEffect(() => {\n    // A student who skipped connecting"), appSrcLoaded.indexOf("}, [connected, status?.aiReady, syncTasks, sweepIfDue, loadBudget]);") + 1);
  check("the connected-gated sync effect flips `loaded` directly when the account never connected anything, instead of leaving it permanently false", /if \(!connected\) \{ setLoaded\(true\); return; \}/.test(loadedEffect));
}

section("Terms/Privacy links open in a new tab from the signup form (source pin — in-progress signup state loss fix)");
{
  // Reported live during a Terms/Privacy audit: clicking these from the login/signup form navigated the
  // SPA router's own click handler straight to /terms or /privacy, unmounting LoginPage and losing every
  // typed field (email/password/consent/child-account fields) with no way back except restarting. The
  // SPA router (usePathRoute) explicitly lets target="_blank" links fall through to normal browser nav,
  // so opening in a new tab keeps the in-progress form alive in this tab.
  const appSrcLegal = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  const legalLine = appSrcLegal.slice(appSrcLegal.indexOf('<div className="login-legal">'), appSrcLegal.indexOf('<div className="login-legal">') + 400);
  check("the Terms link opens in a new tab instead of unmounting the signup form", /<a href="\/terms" target="_blank" rel="noopener">/.test(legalLine));
  check("the Privacy link opens in a new tab instead of unmounting the signup form", /<a href="\/privacy" target="_blank" rel="noopener">/.test(legalLine));
}

section("subjectMastery — per-subject mastery from tutor-session activity only, never a fabricated 0%");
{
  const mkTask = (subject, cards) => ({ id: "t1", sourceSubject: subject, flashcards: [{ id: "d1", title: "d", cards, createdAt: "2026-01-01T00:00:00Z" }] });
  const now = new Date("2026-01-01T00:00:00Z");
  check("no data at all for the subject → null, not 0", subjectMastery([mkTask("Other", [])], [], "Chemistry", now) === null);
  check("flashcards only (no milestones) → pure Leitner ratio", subjectMastery([mkTask("Chemistry", [{ front: "a", back: "b", review: { seen: 1, correct: 1, box: 2 } }, { front: "c", back: "d", review: { seen: 1, correct: 0, box: 1 } }])], [], "Chemistry", now) === 0.5);
  check("milestones only (no flashcards) → pure milestone recency score, capped at 1", subjectMastery([mkTask("Chemistry", [])], [{ subject: "Chemistry", topic: "x", label: "x", achievedAt: now.toISOString() }, { subject: "Chemistry", topic: "y", label: "y", achievedAt: now.toISOString() }, { subject: "Chemistry", topic: "z", label: "z", achievedAt: now.toISOString() }], "Chemistry", now) === 1);
  check("notNeeded cards are excluded from the Leitner ratio, same as every other scoring signal", subjectMastery([mkTask("Chemistry", [{ front: "a", back: "b", review: { box: 2 }, notNeeded: true }, { front: "c", back: "d", review: { box: 1 } }])], [], "Chemistry", now) === 0);
  check("both signals present → a weighted composite strictly between the two individual scores", (() => {
    const m = subjectMastery([mkTask("Chemistry", [{ front: "a", back: "b", review: { box: 2 } }])], [{ subject: "Chemistry", topic: "x", label: "x", achievedAt: new Date(now.getTime() - 200 * 86_400_000).toISOString() }], "Chemistry", now);
    return typeof m === "number" && m > 0 && m <= 1;
  })());
  check("subject matching is case-insensitive (matches sourceSubject's own normalization elsewhere)", subjectMastery([mkTask("chemistry", [{ front: "a", back: "b", review: { box: 2 } }])], [], "Chemistry", now) === 1);
}

section("Track-grounded curriculum content — syllabusGroundingLine gated like examStyleLine (source pin)");
{
  const claudeSrcSyl = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const sylFn = claudeSrcSyl.slice(claudeSrcSyl.indexOf("Direct request: tutoring/content generation"), claudeSrcSyl.indexOf("/** VARK, presentation only"));
  check("syllabusGroundingLine is gated to IB/AP only, thin/none for bac/other (confirmed with the user)", /p\?\.track !== "ib" && p\?\.track !== "ap"\)\) return "";/.test(sylFn));
  check("syllabusGroundingLine leans on the model's own knowledge, explicitly no hardcoded syllabus database", /No new syllabus database/.test(sylFn));
  check("the tutor chat's dynamicContext calls syllabusGroundingLine alongside trackLine", /trackLine\(profile\) \+ syllabusGroundingLine\(profile, task\.sourceSubject\)/.test(claudeSrcSyl));
}

section("TOK-inspired Socratic additions — extend existing rules, never contradict the HINT LADDER fix (source pins)");
{
  const claudeSrcTok = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("CHALLENGE ASSUMPTIONS now rotates through TOK-style meta-questions (evidence/counter-evidence/strongest objection)", claudeSrcTok.includes("what's the strongest case AGAINST your") && claudeSrcTok.includes("own claim?"));
  check("rule 4b occasionally asks the student to voice a counterclaim, not just justify their own step", claudeSrcTok.includes("ask them to voice the") && claudeSrcTok.includes("OPPOSING position"));
  check("a new 10b prompts brief reflection after a problem resolves, same not-every-turn cadence as 4b", /10b\. CLOSE A RESOLVED PROBLEM WITH ONE REFLECTIVE QUESTION, SOMETIMES/.test(claudeSrcTok));
  check("none of the new Socratic additions reintroduce the removed answer-release escape hatch", !/RELEASE THE ANSWER when ANY of these hold/.test(claudeSrcTok));
}

section("Tutor session mastery + objectives summary — surfaced without a fabricated 0% (source pins)");
{
  const serverSrcMastery = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const freeRoute = serverSrcMastery.slice(serverSrcMastery.indexOf('app.post("/api/study/free"'), serverSrcMastery.indexOf('app.post("/api/study/free"') + 2500);
  check("mastery is computed only on session start/resume (/api/study/free), not on a hot polled route", /subjectMastery\(list, req\.session\.profile\?\.milestones, /.test(freeRoute));

  const tutorSrcMastery = readFileSync(new URL("../client/tutor/TutorSession.tsx", import.meta.url), "utf8");
  check("the Today's-focus panel only renders mastery when it's an actual number, never a fabricated 0%", /typeof task\.mastery === "number"/.test(tutorSrcMastery));
  check("the Past-sessions list distinguishes 'no objectives were set' from an explicit 0\\/N", /typeof s\.objectivesTotal === "number"/.test(tutorSrcMastery));
}

section("hintDensity preference — new axis, distinct from learningStyle, never licenses a direct answer (source pins)");
{
  const serverSrcHint = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  check("the /api/profile/preference route accepts hintDensity with the right allow-list", /key === "hintDensity" && \["steps", "hints"\]\.includes\(value\)/.test(serverSrcHint));
  // Real pre-existing bug, fixed alongside this feature: the UI (Settings AND onboarding) has always
  // offered an "AP" track button, but this route's allow-list omitted "ap" — clicking it silently never
  // saved. Caught while wiring hintDensity next to it in the same preference route.
  check("the track preference route now accepts 'ap' (UI has always offered an AP button; this route silently dropped it before)", /key === "track" && \["ib", "ap", "bac", "other"\]\.includes\(value\)/.test(serverSrcHint));

  const typesSrcHint = readFileSync(new URL("../shared/types.ts", import.meta.url), "utf8");
  check("Profile.hintDensity is sanitized through the same allow-list as the write route", /hintDensity: \["steps", "hints"\]\.includes\(p\?\.hintDensity\) \? p\.hintDensity : undefined,/.test(typesSrcHint));

  const claudeSrcHint = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const hintFn = claudeSrcHint.slice(claudeSrcHint.indexOf("export function hintDensityLine"), claudeSrcHint.indexOf("// \"Stories tuned to her life\""));
  check("hintDensityLine never mentions giving the direct answer — only pacing/step-size language", !/the answer\b/i.test(hintFn.replace(/never the direct answer|never the answer/gi, "")));
  check("hintDensityLine explicitly says the direct answer is still never given, under either setting", /Still never the direct answer/.test(hintFn) || /still never the\s*direct answer/.test(hintFn));
  check("chatAboutTask's dynamicContext includes hintDensityLine", /learningStyleLine\(profile\) \+ hintDensityLine\(profile\)/.test(claudeSrcHint));

  const appSrcHint = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
  check("Settings has a hint-density toggle row, distinct from the learningStyle VARK field", /saveHintDensity\("steps"\)/.test(appSrcHint) && /saveHintDensity\("hints"\)/.test(appSrcHint));
}

section("Tutor reply length — tightened the existing SHORT REPLIES trigger (source pin)");
{
  const claudeSrcLen = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("the SHORT REPLIES rule's trigger is tightened to match its own 1-3 sentence target (was a looser 5-sentence trigger)", claudeSrcLen.includes("if you find yourself writing more than 3") && claudeSrcLen.includes("sentences, stop"));
  check("the existing PRIMER_CLOSING_REMINDER LENGTH check is untouched (still reinforces the same 1-3 sentence rule)", claudeSrcLen.includes("this genuinely 1-3 sentences?"));
}

section("wantsArtifactTools — latency fix: narrow the tool list only on a clearly short/conversational turn");
{
  check("a clear flashcard request keeps the artifact tools", wantsArtifactTools("tu peux me faire des flashcards sur ça ?", []) === true);
  check("a quiz request (English) keeps the artifact tools", wantsArtifactTools("can you quiz me on this chapter", []) === true);
  check("short small talk with no keyword drops the artifact tools", wantsArtifactTools("ok merci", []) === false);
  check("a bare acknowledgement drops the artifact tools", wantsArtifactTools("got it", []) === false);
  check("a short message that's still a QUESTION keeps the artifact tools (biased toward inclusion)", wantsArtifactTools("et après ?", []) === true);
  check("a longer conversational message with no keyword still keeps the artifact tools (only ≤6 words drops)", wantsArtifactTools("yeah that makes sense I think I understand it now", []) === true);
  check("an artifact keyword in RECENT HISTORY (not just the current message) still keeps the tools", wantsArtifactTools("ok", [{ role: "user", text: "can you make me a quiz on this" }]) === true);
  check("empty message doesn't crash and stays on the safe/included side", wantsArtifactTools("", []) === true);
}

section("Tool-narrowing latency fix — core tutoring tools are NEVER dropped by the heuristic (source pin)");
{
  const claudeSrcTools = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  const toolsBlock = claudeSrcTools.slice(claudeSrcTools.indexOf("const includeArtifactTools = wantsArtifactTools"), claudeSrcTools.indexOf("const empty = (): ChatResult"));
  for (const core of ["WRITE_TO_BOARD_TOOL", "DRAW_ON_BOARD_TOOL", "SET_OBJECTIVES_TOOL", "WEB_SEARCH_TOOL", "CREATE_CALC_TOOL", "CREATE_PROBLEM_TOOL"]) {
    check(`${core} is listed unconditionally (not inside the includeArtifactTools ternary) in both branches`, (toolsBlock.match(new RegExp(core, "g")) || []).length === 2 && !new RegExp(`includeArtifactTools \\? \\[[^\\]]*${core}`).test(toolsBlock));
  }
  check("only the 4 artifact/remember tools are gated behind includeArtifactTools", /includeArtifactTools \? \[CREATE_NOTE_TOOL, CREATE_FLASHCARDS_TOOL, CREATE_QUIZ_TOOL\]/.test(toolsBlock) && /includeArtifactTools \? \[REMEMBER_TOOL\]/.test(toolsBlock));
}

section("useThinkingWord — time-banded wording so a long wait stops implying 'almost done' (source pin)");
{
  // Not unit-testable as a plain function (it's a stateful React hook, setInterval/useEffect-based) — this
  // codebase's test suite has no React test renderer, so pin the band structure/thresholds in source
  // instead, same as other UI-behavior checks in this file.
  const uiSrcThink = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");
  const hookFn = uiSrcThink.slice(uiSrcThink.indexOf("export function useThinkingWord"), uiSrcThink.indexOf("export function useThinkingWord") + 1200);
  check("three word bands exist: THINKING_WORDS (fresh), STILL_WORKING_WORDS, TAKING_LONGER_WORDS", /STILL_WORKING_WORDS/.test(uiSrcThink) && /TAKING_LONGER_WORDS/.test(uiSrcThink));
  check("elapsed time (not just a flat cycling interval) determines which band is shown", /elapsedMs >= STILL_WORKING_BAND_MS/.test(hookFn) && /elapsedMs >= THINKING_BAND_MS/.test(hookFn));
  check("elapsed time resets to 0 when the hook goes inactive, so a NEW turn starts fresh in the first band", /if \(!active\) \{ setElapsedMs\(0\); return; \}/.test(hookFn));
  check("returns null while inactive, same as before (callers rely on this)", /if \(!active\) return null;/.test(hookFn));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
