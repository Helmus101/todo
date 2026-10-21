import { COURSEWORK_MAX_CHARS, COURSEWORK_MAX_DOCS, COURSEWORK_MAX_PAGES } from "../../shared/coursework.ts";
import "../env.ts";
import express from "express";
import { randomUUID } from "node:crypto";
import type { CourseworkDoc } from "../../shared/coursework.ts";
import { subjectsIn } from "../tutor.ts";
import type { WebTask, Profile, StudySession, StudyProfile, FocusSession } from "../../shared/types.ts";
import { emptyProfile, isHandled, addUsage, bumpActivityHour, MAX_DUE_SETS_PER_DAY, subjectMastery } from "../../shared/types.ts";
import { findSourceQuestions, sourcesForTrack } from "../questionSources.ts";
import { summarizeCoursework, fallbackCourseworkSummary, aiReady, generateDailyStudyCards, generateDailyPracticeProblem, checkFeynmanGap, extractJournalMemory, generateWeeklyStudyDeck, generateWeeklyQuiz, generateMonthlyStudyDeck, generateMonthlyQuiz, generateSchedulingSuggestion, recommendArtifactType } from "../claude.ts";
import { htmlToPlainText, readBodyCapped } from "../safeHtml.ts";
import { saveStudySessions, loadState, saveState, cloudEnabled, loadBanditState, saveBanditState, recordSessionOutcome, recordMetric } from "../store.ts";
import { contextKey as banditContextKey, chooseArm, updatePosterior, computeReward, computeCardReward, POMODORO_ARMS, FLASHCARD_ARMS, AUDIO_ARMS, DENSITY_ARMS } from "../bandit.ts";
import * as tasks from "../tasks.ts";
import * as jobs from "../jobs.ts";
import * as integrations from "../integrations.ts";
import * as pronoteSvc from "../pronote.ts";
import { M, ah, commit, isPaused, mergeProfiles, mergeTasks, rateLimit, reqLang, requireAuth, saveSession, tasksPayload, toolsFor } from "../http.ts";

// ── Study log: daily "what I learned today" → auto flashcards, + a week-end summary deck ──────────────
// Each entry is modeled as a WebTask with source:"studylog" — reuses the existing flashcard-deck type,
// the FlashcardDeck review UI, and (crucially) the Leitner spaced-repetition schedule + the cross-task
// /api/reviews/due view above, entirely for free. These tasks are excluded from the normal dashboard
// client-side (see App.tsx) — they're not to-dos. A real anchorKey (date-keyed) is essential here: without
// one, dedupeTasks' anchorless title-similarity fallback (see server/tasks.ts) could merge two DIFFERENT
// days' entries just for having similar-sounding titles — the anchor is what tells it these are distinct
// real-world items, the same guarantee a real Gmail/Calendar anchor gives an ordinary task.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Monday (YYYY-MM-DD) of the week containing `dateStr` — a simple, year-boundary-safe week key (avoids
// ISO week-numbering edge cases entirely) rather than a formal "2026-W35" string.
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

function weekdayDates(monday: string): string[] {
  const d = new Date(`${monday}T00:00:00Z`);
  // 7 days (Mon..Sun) — the Journal now covers the full week, not just weekdays, per direct instruction.
  return Array.from({ length: 7 }, (_, i) => new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

// YYYY-MM of the month containing `dateStr` — used to group weekly decks (keyed by their Monday) into a
// month-end summary without any formal calendar-month task list of its own.
function monthOf(dateStr: string): string { return dateStr.slice(0, 7); }

// The client (client/App.tsx's `month` = `monday.slice(0, 7)`) only ever sends a bare "YYYY-MM" to these two
// routes — NEVER a full date — so validating against DATE_RE (which requires "YYYY-MM-DD") rejected every
// single call with a 400, unconditionally. Both month endpoints were broken 100% of the time, not
// intermittently. `monthOf()` on a value that's already "YYYY-MM" is a harmless no-op (slice(0,7) of a
// 7-char string returns itself), so accepting either shape here is safe.
const MONTH_RE = /^\d{4}-\d{2}$/;

// Server-side text extraction for a document material's URL — so the "Ask Otto" chat can reference what's
// actually IN a doc/webpage material, not just its title/filename, the same way pdfText.ts already does for
// UPLOADED PDFs. Uploaded-PDF extraction runs client-side (the file never leaves the browser as a Blob); a
// URL-based material has no local bytes to read from, and the app's own CSP (connect-src 'self') blocks the
// browser from fetching a THIRD-PARTY url directly — this has to happen server-side instead, where there's
// no such restriction. Two strategies:
//  1. docs.google.com: read via the properly-authenticated GOOGLEDOCS_GET_DOCUMENT_BY_ID tool (works for a
//     student's own PRIVATE doc, which a raw fetch() never could — Google's real access control applies).
//  2. anything else: a plain fetch() + strip HTML tags. Only ever sees what's PUBLICLY reachable (same
//     honest limit a logged-out visitor would hit), which is the right, unavoidable scope for a generic URL.
// Best-effort throughout, same posture as pdfText.ts's own extractPdfText: never throws, "" on any failure
// (a login wall, a network blip, a page that's mostly non-text) rather than surfacing an error over what's
// explicitly an enhancement, not something the material's own viewer depends on to already be usable.
const GDOC_URL_RE = /^https:\/\/docs\.google\.com\/document\/d\/([^/]+)/;

const MAX_EXTRACTED_CHARS = 6000;

const stripHtmlToText = (html: string): string => htmlToPlainText(html);

// Calculate aggregated focus statistics from session history
function recalculateFocusStats(p: Profile) {
  const sessions = p.focusSessions || [];
  if (sessions.length === 0) {
    p.focusStats = undefined;
    return;
  }
  
  // Overall averages
  const avgConcentration = sessions.reduce((sum, s) => sum + s.avgConcentration, 0) / sessions.length;
  const avgGazeOnScreenPct = sessions.reduce((sum, s) => sum + s.gazeOnScreenPct, 0) / sessions.length;
  const avgBlinkRate = sessions.reduce((sum, s) => sum + s.avgBlinkRate, 0) / sessions.length;
  const restlessPct = sessions.filter(s => s.avgMovement > 30).length / sessions.length * 100;
  
  // Subject-specific averages
  const subjectFocus: Record<string, number> = {};
  const subjectSessions: Record<string, FocusSession[]> = {};
  for (const s of sessions) {
    if (s.subject) {
      if (!subjectSessions[s.subject]) subjectSessions[s.subject] = [];
      subjectSessions[s.subject].push(s);
    }
  }
  for (const [subject, subjSessions] of Object.entries(subjectSessions)) {
    subjectFocus[subject] = subjSessions.reduce((sum, s) => sum + s.avgConcentration, 0) / subjSessions.length;
  }
  
  // Hourly focus patterns
  const hourlyFocus: Record<number, number> = {};
  const hourlyCounts: Record<number, number> = {};
  for (const s of sessions) {
    const hour = new Date(s.startTime).getHours();
    if (!hourlyFocus[hour]) hourlyFocus[hour] = 0;
    if (!hourlyCounts[hour]) hourlyCounts[hour] = 0;
    hourlyFocus[hour] += s.avgConcentration;
    hourlyCounts[hour]++;
  }
  for (const hour of Object.keys(hourlyFocus)) {
    hourlyFocus[Number(hour)] /= hourlyCounts[Number(hour)];
  }
  
  // Find peak focus hour
  let peakFocusHour = 10; // default 10am
  let maxAvg = 0;
  for (const [hour, avg] of Object.entries(hourlyFocus)) {
    if (avg > maxAvg) {
      maxAvg = avg;
      peakFocusHour = Number(hour);
    }
  }
  
  // Calculate focus stability
  const variance = sessions.reduce((sum, s) => sum + s.concentrationVariance, 0) / sessions.length;
  let focusStability: "stable" | "unstable" | "highly_variable";
  if (variance < 15) focusStability = "stable";
  else if (variance < 30) focusStability = "unstable";
  else focusStability = "highly_variable";
  
  // Calculate weekly trend (compare last 7 days to previous 7 days)
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  
  const recentSessions = sessions.filter(s => new Date(s.startTime) >= weekAgo);
  const olderSessions = sessions.filter(s => new Date(s.startTime) >= twoWeeksAgo && new Date(s.startTime) < weekAgo);
  
  let weeklyTrend: "improving" | "stable" | "declining";
  if (recentSessions.length === 0 || olderSessions.length === 0) {
    weeklyTrend = "stable";
  } else {
    const recentAvg = recentSessions.reduce((sum, s) => sum + s.avgConcentration, 0) / recentSessions.length;
    const olderAvg = olderSessions.reduce((sum, s) => sum + s.avgConcentration, 0) / olderSessions.length;
    if (recentAvg > olderAvg + 5) weeklyTrend = "improving";
    else if (recentAvg < olderAvg - 5) weeklyTrend = "declining";
    else weeklyTrend = "stable";
  }
  
  // Find best day
  const dayAvg: Record<string, { sum: number; count: number }> = {};
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (const s of sessions) {
    const day = days[new Date(s.startTime).getDay()];
    if (!dayAvg[day]) dayAvg[day] = { sum: 0, count: 0 };
    dayAvg[day].sum += s.avgConcentration;
    dayAvg[day].count++;
  }
  let bestDay = "Monday";
  let bestAvg = 0;
  for (const [day, data] of Object.entries(dayAvg)) {
    const avg = data.sum / data.count;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestDay = day;
    }
  }
  
  // Generate insights and recommendations
  const insights: string[] = [];
  const recommendations: string[] = [];
  
  if (avgConcentration >= 75) {
    insights.push("Your average focus is excellent");
  } else if (avgConcentration >= 60) {
    insights.push("Your average focus is good");
  } else if (avgConcentration >= 45) {
    insights.push("Your average focus is fair");
  } else {
    insights.push("Your average focus could be improved");
  }
  
  if (focusStability === "stable") {
    insights.push("Your focus is very consistent");
  } else if (focusStability === "unstable") {
    insights.push("Your focus fluctuates moderately");
    recommendations.push("Try taking more frequent breaks to maintain consistency");
  } else {
    insights.push("Your focus varies significantly");
    recommendations.push("Consider shorter study sessions to reduce variability");
  }
  
  if (peakFocusHour >= 9 && peakFocusHour <= 11) {
    recommendations.push("Schedule your hardest tasks in the morning for best results");
  } else if (peakFocusHour >= 14 && peakFocusHour <= 16) {
    recommendations.push("Your peak focus is in the afternoon - plan accordingly");
  }
  
  if (avgBlinkRate > 30) {
    recommendations.push("Consider taking breaks to reduce eye strain");
  }
  
  if (restlessPct > 50) {
    recommendations.push("Try incorporating more movement into your study sessions");
  }
  
  p.focusStats = {
    totalTrackedSessions: sessions.length,
    avgConcentration: Math.round(avgConcentration),
    avgGazeOnScreenPct: Math.round(avgGazeOnScreenPct),
    avgBlinkRate: Math.round(avgBlinkRate),
    restlessPct: Math.round(restlessPct),
    subjectFocus: Object.keys(subjectFocus).length > 0 ? subjectFocus : undefined,
    hourlyFocus: Object.keys(hourlyFocus).length > 0 ? hourlyFocus : undefined,
    focusStability,
    peakFocusHour,
    weeklyTrend,
    bestDay,
    insights,
    recommendations,
  };
}

export function registerStudyRoutes(app: express.Express): void {
  // Cards due for review RIGHT NOW, across every task — not scoped to one deck's own view, since spaced
  // repetition only actually compounds if the student can see everything due at a glance instead of having
  // to reopen each task to check. Cheap enough to compute on every request (no AI, just a filter/sort).
  // MAX_DUE_SETS_PER_DAY (shared/types.ts) caps distinct decks surfaced per day — spaced repetition only
  // sticks if a day's review stays doable; dumping every due deck at once (which grows unboundedly as more
  // days/weeks/months get logged) is exactly the overwhelm that makes students bail on review entirely. 3
  // sets is a deliberately small daily dose — still-due decks simply reappear the next day. Shared (not a
  // local const) so normalizeProfile can clamp Profile.reviewSetDeckIds to the same number.
  app.get("/api/reviews/due", requireAuth, ah(async (req, res) => {
    const now = Date.now();
    const due: { taskId: string; taskTitle: string; deckId: string; deckTitle: string; cardIndex: number; front: string }[] = [];
    const profile = req.session.profile ||= emptyProfile();
    // Which decks already count against today's 3-set cap — persisted (see tasks.reviewSetDeckIdsToday/
    // setReviewSetDeckIdsToday), NOT recomputed from scratch each request. Recomputing fresh would let
    // reviewing a deck (which moves its cards' dueAt into the future, so it stops looking "due") silently
    // free up its slot for a 4th deck later the SAME day — exactly the overwhelm the cap exists to prevent.
    const admitted = new Set(tasks.reviewSetDeckIdsToday(profile, new Date(now)));
    const admittedAtStart = admitted.size;
    outer: for (const t of req.session.tasks || []) {
      if (isHandled(t.status)) continue;
      for (const deck of t.flashcards || []) {
        // Never-reviewed cards aren't "due" — they're simply unreviewed; a fresh deck showing up in the due
        // list before the student has even seen it once would be confusing, not helpful.
        const deckDue = deck.cards.flatMap((c, i) => (!c.notNeeded && c.review?.dueAt && Date.parse(c.review.dueAt) <= now)
          ? [{ taskId: t.id, taskTitle: t.title, deckId: deck.id, deckTitle: deck.title, cardIndex: i, front: c.front }]
          : []);
        if (!deckDue.length) continue;
        // Once today's 3-set budget is spent, stop pulling in NEW decks — but a deck already admitted (this
        // request or persisted from an earlier one today) keeps all its own due cards.
        if (!admitted.has(deck.id) && admitted.size >= MAX_DUE_SETS_PER_DAY) continue;
        // Admit complete decks only when they fit the remaining 60-card response budget — a monthly-summary
        // deck can hold more than 60 cards on its own, and slicing mid-deck would silently drop the rest of
        // it. The very first admitted deck is let through in full even if it alone exceeds 60, so a single
        // oversized deck still shows up instead of vanishing.
        if (due.length > 0 && due.length + deckDue.length > 60) break outer;
        admitted.add(deck.id);
        due.push(...deckDue);
        if (due.length >= 60) break outer;
      }
    }
    if (admitted.size !== admittedAtStart) {
      tasks.setReviewSetDeckIdsToday(profile, [...admitted], new Date(now));
      await commit(req);
    }
    res.json({ due, setsShown: admitted.size, setCap: MAX_DUE_SETS_PER_DAY });
  }));

  app.post("/api/studylog/day", requireAuth, rateLimit(20, 60_000), ah(async (req, res) => {
    const date = String(req.body?.date || "");
    const text = String(req.body?.text || "").trim().slice(0, 4000);
    if (!DATE_RE.test(date)) { res.status(400).json({ error: "Invalid date." }); return; }
    const list = req.session.tasks || [];
    const anchorKey = `studylog:${date}`;
    let t = list.find((x) => x.source === "studylog" && x.logDate === date);
    if (!text) {
      // Clearing an entry — keep the (now-empty) task shell rather than deleting, so re-typing later just
      // upserts the same anchor again instead of minting a fresh id.
      if (t) { t.logText = ""; t.flashcards = []; t.quizzes = []; t.practiceProblem = undefined; t.updatedAt = new Date().toISOString(); await commit(req, { awaitCloud: true }); }
      res.json(tasksPayload(req, req.session.tasks));
      return;
    }
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate flashcards." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const now = new Date().toISOString();
    if (!t) {
      const e = tasks.eisenhower(0, 0);
      t = {
        // `why` MUST embed the actual date — see the CRITICAL note at dedupeTasks/sameTask in server/tasks.ts:
        // a literal identical "Daily study log" for every single day meant sameTask()'s `source === source &&
        // nearDup(why, why)` fallback matched EVERY pair of studylog day tasks (different anchors, but that
        // fallback is only skipped for handled/manual tasks — a live "needs_review" day task hits it every
        // time). dedupeTasks runs inside mergeTaskLists, which fires on every commit()'s background cloud
        // sync — so this was silently collapsing DIFFERENT days' entries into one on essentially every save,
        // which is what made a day's flashcards look like they'd never been saved at all after a reload.
        id: randomUUID(), title: date, why: `Daily study log — ${date}`, source: "studylog", risk: "low",
        // status "needs_review" (never "done"/"dismissed"): GET /api/reviews/due (above) explicitly SKIPS
        // handled tasks (`if (isHandled(t.status)) continue`) — "done" would silently hide these decks from
        // the exact cross-task due-for-review view this feature was built to reuse. Not "ready" either: the
        // cron catch-all (tasksToEnqueue in jobs.ts) auto-enqueues plain "ready" tasks through the normal AI
        // agent run pipeline, which makes no sense for a studylog entry.
        urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
        createdAt: now, anchorKey, logDate: date,
      };
      list.push(t);
      req.session.tasks = list;
    }
    // Re-generate on a real edit, not on every save — the save button is a deliberate click (not per-
    // keystroke autosave), so re-running generation whenever the text actually CHANGED is the right call:
    // that's the only way editing a day's entry after its deck already exists can ever do anything. Only skip
    // regeneration when the text is genuinely UNCHANGED (a duplicate/no-op save) — that's the case that used
    // to be conflated with "already has a deck", which made editing a logged day's entry silently do nothing
    // ("saved" the identical deck, never picked up what was actually typed). A prior FAILED attempt
    // (flashcards still empty after a real try) also always retries, same as before.
    const textChanged = t.logText !== text;
    t.logText = text;
    t.logSubjects = subjectsIn(text, req.session.profile?.subjects);
    if (req.session.profile) { bumpActivityHour(req.session.profile, new Date(), t.sourceSubject); req.session.profile.lastTutorActivityAt = new Date().toISOString(); }
    void recordMetric(req.session.user!, "journal_entry_saved", 1);
    void recordMetric(req.session.user!, "journal_entry_length_chars", text.length);
    if (t.flashcards?.length && !textChanged) {
      t.updatedAt = new Date().toISOString();
      await commit(req, { awaitCloud: true });
      res.json(tasksPayload(req, req.session.tasks));
      return;
    }
    // Score the OUTGOING deck (if any) against the flashcard-style bandit before it's replaced — its Leitner
    // review history is the only point this signal exists, so this is the one place it can be captured. Then
    // pick the arm for the NEW deck about to be generated. Both best-effort: a bandit hiccup must never block
    // the flashcards the student is actually waiting on (same posture as the Pomodoro routes above).
    let flashcardArmId: string | undefined;
    // Beta-gated (see Profile.betaFeatures' own doc comment) — leaves flashcardArmId undefined, same as a
    // live failure, so generation below proceeds with the default style.
    if (req.session.profile?.betaFeatures) {
      try {
        const email = req.session.user!;
        const banditKey = banditContextKey(new Date(), req.session.profile);
        let banditState = await loadBanditState(email, "flashcards");
        const outgoing = t.flashcards?.[0];
        if (outgoing?.styleArmId) {
          const reviewed = outgoing.cards.filter((c) => (c.review?.seen || 0) > 0 && c.review?.box);
          if (reviewed.length) {
            const avgBoxProgress = reviewed.reduce((s, c) => s + ((c.review!.box || 1) - 1), 0) / reviewed.length;
            const reward = computeCardReward(avgBoxProgress);
            banditState = updatePosterior(banditState, banditKey, outgoing.styleArmId, reward);
            await saveBanditState(email, "flashcards", banditState);
            void recordSessionOutcome({ userEmail: email, decisionKey: "flashcards", arm: outgoing.styleArmId, context: banditKey, reward, at: new Date().toISOString() });
          }
        }
        flashcardArmId = chooseArm(FLASHCARD_ARMS, banditState, banditKey).arm.id;
      } catch { /* best-effort — generation below still proceeds with the default style */ }
    }
    // REAL spaced-repetition reinforcement from PREVIOUS days — not "recently got wrong within N days" (that's
    // not what spaced repetition means), but cards whose own Leitner schedule says they're due for review
    // RIGHT NOW, exactly the same due-ness check GET /api/reviews/due uses. A box-1 card comes back in a day
    // or two; a box-4 card the student clearly knows won't resurface for weeks — the schedule decides, not a
    // fixed lookback window. Excludes today's own (still-being-written) entry and week/month summary decks.
    // Weakest-first (lowest box) and capped, since this is reinforcement, not the point of today's deck.
    const nowMs = Date.now();
    const priorWeakCards = list
      .filter((x) => x.source === "studylog" && x.logDate && x.logDate !== date && !x.logDate.startsWith("week:") && !x.logDate.startsWith("month:"))
      .flatMap((x) => (x.flashcards || []).flatMap((deck) => deck.cards
        .filter((c) => !c.notNeeded && c.review?.dueAt && Date.parse(c.review.dueAt) <= nowMs)
        .map((c) => ({ front: c.front, box: c.review!.box || 1 }))))
      .sort((a, b) => a.box - b.box)
      .slice(0, 6)
      .map((c) => c.front);
    try {
      const result = await generateDailyStudyCards(text, req.session.profile, flashcardArmId, priorWeakCards);
      if (result) addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
      t.flashcards = result ? [result.deck] : [];
      if (result) void recordMetric(req.session.user!, "flashcard_deck_created", result.deck.cards.length, "daily");
      // No quiz from the daily call any more (see generateDailyStudyCards's own comment) — leave t.quizzes
      // untouched rather than clobbering it either way.
      t.title = result?.deck.title || date;
      // Separate, best-effort, math/physics/science-only call (see generateDailyPracticeProblem's own
      // comment on why this is never bundled into the deck call above) — a failure here never blocks the
      // flashcards the student is actually waiting on; it just means no practice problem for today.
      try {
        const pp = await generateDailyPracticeProblem(text, req.session.profile);
        if (pp) { addUsage(req.session.profile ||= emptyProfile(), pp.tokens, "studylog"); t.practiceProblem = pp.problem; }
        else t.practiceProblem = undefined;
      } catch { /* best-effort — flashcards above already succeeded regardless */ }
      // Feynman-technique gap-check on the entry itself — same "separate, best-effort, never blocks the
      // flashcards" posture as the practice problem above. Cleared then re-set fresh on every save (a
      // rewritten entry deserves its own check, not a stale flag from a previous version of the text).
      try {
        const fg = await checkFeynmanGap(text, req.session.profile);
        if (fg) { addUsage(req.session.profile ||= emptyProfile(), fg.tokens, "studylog"); t.feynmanGap = fg.gap; }
        else t.feynmanGap = undefined;
      } catch { /* best-effort */ }
      // Durable-fact extraction, same "separate, best-effort, never blocks the flashcards" posture as the two
      // calls above — see extractJournalMemory's own comment for why this stays a SEPARATE small call rather
      // than folded into generateDailyStudyCards. Applied into profile.courses (the SAME category/mechanism
      // chat's own "remember" tool already writes to), which profileBlock already surfaces in every future
      // agent/chat prompt — this is the one piece of wiring that makes a journal entry's durable insight
      // available to Otto in chat generally, not just re-readable within the Journal feature itself.
      try {
        const jm = await extractJournalMemory(text, req.session.profile);
        if (jm) {
          addUsage(req.session.profile ||= emptyProfile(), jm.tokens, "studylog");
          for (const fact of jm.facts) tasks.applyProfileUpdate(req.session.profile, { category: "course", fact });
          // Milestones ACCUMULATE (like errorLog/grades), never overwritten — appended here and self-healed of
          // same-topic duplicates on the next normalizeProfile pass (shared/types.ts's dedupeMilestones), same
          // "write raw, clean up on read" posture as dedupePronoteGrades' own comment explains for grades.
          if (jm.milestones.length) {
            const p = req.session.profile;
            p.milestones = [...(p.milestones || []), ...jm.milestones.map((m) => ({ id: crypto.randomUUID(), ...m, achievedAt: new Date().toISOString() }))];
          }
        }
      } catch { /* best-effort */ }
      t.updatedAt = new Date().toISOString();
      // Awaited (not fire-and-forget) — this is THE write that actually creates the day's journal/flashcards
      // record, reported live as not reliably surviving in the cloud on serverless. See commit()'s own comment
      // for why the default fire-and-forget mode is genuinely at risk here. (commit() itself now also trims
      // old studylog artifacts on every call — see its own comment — so that no longer needs to happen here.)
      await commit(req, { awaitCloud: true });
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't make flashcards from that — try again." }); }
  }));

  app.get("/api/studylog/week", requireAuth, ah(async (req, res) => {
    const start = String(req.query.start || "");
    if (!DATE_RE.test(start)) { res.status(400).json({ error: "Invalid date." }); return; }
    const monday = mondayOf(start);
    const dates = weekdayDates(monday);
    // Same cloud-reconcile as GET /api/tasks — see week-summary's identical comment for why. bypassCache:true
    // (all four studylog GET/reconcile routes) — reported live as "flashcards saved but not showing": POST
    // /api/studylog/day awaits its cloud write before responding, but this GET can land on a DIFFERENT warm
    // lambda instance whose loadState cache is still up to 3min stale, so the just-saved deck read as missing
    // for the rest of that window. These routes are page-navigation-triggered, not a poll/per-keystroke call,
    // so the extra Supabase read here is bounded — worth paying for a page that must show what was just saved.
    if (req.session.user && cloudEnabled()) {
      try {
        const cloud = await loadState(req.session.user, { bypassCache: true });
        req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      } catch { /* best-effort — fall back to whatever the session already has */ }
    }
    const list = req.session.tasks || [];
    const days = dates.map((d) => list.find((x) => x.source === "studylog" && x.logDate === d) || null);
    const summary = list.find((x) => x.source === "studylog" && x.logDate === `week:${monday}`) || null;
    res.json({ monday, days, summary });
  }));

  app.post("/api/studylog/week-summary", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate the summary." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const weekStart = String(req.body?.weekStart || "");
    if (!DATE_RE.test(weekStart)) { res.status(400).json({ error: "Invalid date." }); return; }
    const monday = mondayOf(weekStart);
    const dates = weekdayDates(monday);
    // Reconcile with the cloud copy first — same reasoning as GET /api/tasks's own reload. This route used to
    // trust ONLY req.session.tasks, unlike mutation routes (findTaskOrReload) which fall back to a fresh cloud
    // read on a miss — reported live as "No entries logged this week yet" despite every day genuinely having
    // an entry: a session that hadn't picked up a write from another tab/device/reload had no way to recover
    // before this, since nothing here ever went back to the cloud to check.
    if (req.session.user && cloudEnabled()) {
      try {
        const cloud = await loadState(req.session.user, { bypassCache: true });
        req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      } catch { /* best-effort — fall back to whatever the session already has */ }
    }
    const list = req.session.tasks || [];
    const dayTasks = dates.map((d) => list.find((x) => x.source === "studylog" && x.logDate === d)).filter((x): x is WebTask => !!x?.logText?.trim());
    if (!dayTasks.length) {
      // Self-diagnosing error: this exact "No entries logged this week yet" message was reported live despite
      // the student having saved an entry every day — with no server log access on their end, the error
      // message itself is the only way to see what actually happened. Lists every studylog day task that DOES
      // exist server-side (whatever its real logDate is) against what this request was actually looking for,
      // so a genuine date-key mismatch (the real suspect — e.g. a stale/incorrectly-computed weekStart) is
      // visible directly in the toast instead of requiring DevTools access the student may not have/know how
      // to use. Not a permanent UX feature — the underlying mismatch found is what actually gets fixed.
      const allLogs = list.filter((x) => x.source === "studylog" && x.logDate && !x.logDate.startsWith("week:") && !x.logDate.startsWith("month:"));
      const en2 = reqLang(req) === "en";
      const found = allLogs.length
        ? allLogs.map((x) => `${x.logDate}${x.logText?.trim() ? "" : en2 ? " (empty)" : " (vide)"}`).sort().join(", ")
        : (en2 ? "none at all" : "aucune");
      res.status(400).json({ error: `No entries logged this week yet. (Looked for ${dates.join(", ")} — entries that actually exist: ${found})` });
      return;
    }
    const boxBreakdown = tasks.leitnerBoxBreakdown(dayTasks);
    try {
      const result = await generateWeeklyStudyDeck(dayTasks.map((dt) => ({ date: dt.logDate!, logText: dt.logText! })), boxBreakdown, req.session.profile);
      if (!result) { res.status(500).json({ error: "Couldn't build the week summary — try again." }); return; }
      addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
      const deck = result.deck;
      const anchorKey = `studylog:week:${monday}`;
      const logDate = `week:${monday}`;
      let t = list.find((x) => x.source === "studylog" && x.logDate === logDate);
      const now = new Date().toISOString();
      if (!t) {
        const e = tasks.eisenhower(0, 0);
        t = {
          // `why` embeds the week so it can't collide with another week's summary via sameTask's nearDup(why)
          // fallback — see the CRITICAL note on the daily task above; the same bug applied here identically.
          id: randomUUID(), title: deck.title, why: `Weekly study summary — week of ${monday}`, source: "studylog", risk: "low",
          // status "needs_review" (never "done"/"dismissed"): GET /api/reviews/due (above) explicitly SKIPS
        // handled tasks (`if (isHandled(t.status)) continue`) — "done" would silently hide these decks from
        // the exact cross-task due-for-review view this feature was built to reuse. Not "ready" either: the
        // cron catch-all (tasksToEnqueue in jobs.ts) auto-enqueues plain "ready" tasks through the normal AI
        // agent run pipeline, which makes no sense for a studylog entry.
        urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
          createdAt: now, anchorKey, logDate,
        };
        list.push(t);
        req.session.tasks = list;
      }
      t.title = deck.title;
      t.flashcards = [deck];
      t.updatedAt = now;
      void recordMetric(req.session.user!, "journal_week_summary_generated", deck.cards.length);
      void recordMetric(req.session.user!, "flashcard_deck_created", deck.cards.length, "weekly");
      // Quiz is a separate, best-effort call now (see generateWeeklyQuiz's own comment) — a slow/failed quiz
      // attempt must never cost the deck the student is actually waiting on, which is why this runs AFTER the
      // deck is already saved rather than blocking it.
      try {
        const qr = await generateWeeklyQuiz(dayTasks.map((dt) => ({ date: dt.logDate!, logText: dt.logText! })), req.session.profile);
        addUsage(req.session.profile ||= emptyProfile(), qr.tokens, "studylog");
        t.quizzes = qr.quiz ? [qr.quiz] : [];
        if (qr.quiz) void recordMetric(req.session.user!, "quiz_created", qr.quiz.questions.length, "weekly");
      } catch { /* best-effort — the deck above already succeeded regardless */ }
      await commit(req, { awaitCloud: true });
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't build the week summary — try again." }); }
  }));

  app.get("/api/studylog/month", requireAuth, ah(async (req, res) => {
    const start = String(req.query.start || "");
    if (!MONTH_RE.test(start) && !DATE_RE.test(start)) { res.status(400).json({ error: "Invalid date." }); return; }
    const month = monthOf(start);
    // Same cloud-reconcile as GET /api/tasks — see week-summary's identical comment for why.
    if (req.session.user && cloudEnabled()) {
      try {
        const cloud = await loadState(req.session.user, { bypassCache: true });
        req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      } catch { /* best-effort — fall back to whatever the session already has */ }
    }
    const list = req.session.tasks || [];
    const weeks = list.filter((x) => x.source === "studylog" && x.logDate?.startsWith("week:") && monthOf(x.logDate.slice(5)) === month)
      .sort((a, b) => a.logDate!.localeCompare(b.logDate!));
    const summary = list.find((x) => x.source === "studylog" && x.logDate === `month:${month}`) || null;
    res.json({ month, weeks, summary });
  }));

  app.post("/api/studylog/month-summary", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to generate the summary." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const monthStart = String(req.body?.monthStart || "");
    if (!MONTH_RE.test(monthStart) && !DATE_RE.test(monthStart)) { res.status(400).json({ error: "Invalid date." }); return; }
    const month = monthOf(monthStart);
    // Same cloud-reconcile as GET /api/tasks — see week-summary's identical comment for why.
    if (req.session.user && cloudEnabled()) {
      try {
        const cloud = await loadState(req.session.user, { bypassCache: true });
        req.session.tasks = mergeTasks(cloud.tasks || [], req.session.tasks || []);
      } catch { /* best-effort — fall back to whatever the session already has */ }
    }
    const list = req.session.tasks || [];
    const weekTasks = list.filter((x) => x.source === "studylog" && x.logDate?.startsWith("week:") && monthOf(x.logDate.slice(5)) === month && x.flashcards?.length);
    if (!weekTasks.length) { res.status(400).json({ error: "No weekly summaries yet this month." }); return; }
    const boxBreakdown = tasks.leitnerBoxBreakdown(weekTasks);
    try {
      const result = await generateMonthlyStudyDeck(
        weekTasks.map((wt) => ({ label: wt.logDate!.slice(5), cards: (wt.flashcards![0]?.cards || []).map((c) => ({ front: c.front, back: c.back })) })),
        boxBreakdown, req.session.profile,
      );
      if (!result) { res.status(500).json({ error: "Couldn't build the month summary — try again." }); return; }
      addUsage(req.session.profile ||= emptyProfile(), result.tokens, "studylog");
      const deck = result.deck;
      const anchorKey = `studylog:month:${month}`;
      const logDate = `month:${month}`;
      let t = list.find((x) => x.source === "studylog" && x.logDate === logDate);
      const now = new Date().toISOString();
      if (!t) {
        const e = tasks.eisenhower(0, 0);
        t = {
          // `why` embeds the month, same fix and same reason as the daily/weekly tasks above.
          id: randomUUID(), title: deck.title, why: `Monthly study summary — ${month}`, source: "studylog", risk: "low",
          urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
          createdAt: now, anchorKey, logDate,
        };
        list.push(t);
        req.session.tasks = list;
      }
      t.title = deck.title;
      t.flashcards = [deck];
      t.updatedAt = now;
      void recordMetric(req.session.user!, "journal_month_summary_generated", deck.cards.length);
      void recordMetric(req.session.user!, "flashcard_deck_created", deck.cards.length, "monthly");
      // Quiz is a separate, best-effort call now — see the week-summary route's identical comment above.
      try {
        const qr = await generateMonthlyQuiz(
          weekTasks.map((wt) => ({ label: wt.logDate!.slice(5), cards: (wt.flashcards![0]?.cards || []).map((c) => ({ front: c.front, back: c.back })) })),
          req.session.profile,
        );
        addUsage(req.session.profile ||= emptyProfile(), qr.tokens, "studylog");
        t.quizzes = qr.quiz ? [qr.quiz] : [];
        if (qr.quiz) void recordMetric(req.session.user!, "quiz_created", qr.quiz.questions.length, "monthly");
      } catch { /* best-effort — the deck above already succeeded regardless */ }
      await commit(req, { awaitCloud: true });
      res.json(tasksPayload(req, req.session.tasks));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't build the month summary — try again." }); }
  }));

  // A "just let me start studying" entry point — the full StudyMode workspace (StudyMode.tsx) and the /tutor
  // Tutor Session (client/tutor/TutorSession.tsx) are both built around a WebTask (chat/notes/artifacts all
  // key off task.id server-side), so a session not tied to any real to-do still needs a lightweight
  // placeholder task to attach to. No AI call, no refine pass, no quadrant weight — this is intentionally NOT
  // a real to-do, just a peg for persistence for the DURATION of one session.
  //
  // RESUME (default): find-or-create — if an active (not done/dismissed) freestudy task already exists,
  // return the list UNCHANGED. This is what Tutor Session's loadTask() calls on every mount, since a mount
  // isn't necessarily "the student wants a fresh session" — it's just as often a route remount, a background
  // re-render, or (in dev) React 18 StrictMode's deliberate double-invoke of effects. Before this, EVERY call
  // unconditionally dismissed the existing session and minted a new one — so simply navigating away from
  // /tutor and back (or a StrictMode double-mount) silently discarded whatever the student was mid-conversation
  // on, replacing it with a blank one; reported live as the tutor "losing" sessions and (when a stale client
  // closure kept sending to the now-dismissed task's id) a 404 from /api/tasks/:id/chat. Passing `fresh: true`
  // keeps the OLD unconditional behavior for a caller that explicitly wants a clean slate (StandaloneStudyEntry
  // in App.tsx, "Enter study mode" — a genuinely fresh workspace every time is the intended UX there).
  app.post("/api/study/free", requireAuth, rateLimit(20, 60_000), ah(async (req, res) => {
    const list = req.session.tasks || [];
    const now = new Date().toISOString();
    const fresh = req.body?.fresh === true;
    const subject = req.body?.subject as string | undefined;
    const topic = typeof req.body?.topic === "string" ? req.body.topic.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    const en = req.session.profile?.language === "en";
    
    if (!fresh) {
      // Resume-first: ANY active freestudy session resumes, regardless of subject — the subject stamp is a
      // label on the session, never a reason to hide an active one from a passive mount (see the route's
      // header comment; a remount is just as often a route re-render or a StrictMode double-invoke as an
      // explicit "new session" request).
      const active = list.find((t) => t.source === "freestudy" && !isHandled(t.status));
      if (active) {
        if (active.sourceSubject) { try { active.mastery = subjectMastery(list, req.session.profile?.milestones, active.sourceSubject); } catch { /* mastery is a nicety */ } }
        res.json(list); return;
      }
    }
    
    // Fresh mode: only dismiss sessions for the specified subject, or all if no subject
    for (const old of list) {
      if (old.source === "freestudy" && !isHandled(old.status)) {
        if (!subject || old.sourceSubject === subject) {
          old.status = "dismissed";
          old.updatedAt = now;
        }
      }
    }
    
    const e = tasks.eisenhower(0, 0);
    const id = randomUUID();
    const t: WebTask = {
      id, 
      title: topic ? topic : subject ? `${subject} session` : ("Free study session"),
      why: topic ? (`The student chose to work on exactly this: ${topic}${subject ? ` (${subject})` : ""}.`) : ("Started on demand, not tied to a task."),
      ...(topic ? { sourceTopic: topic } : {}),
      source: "freestudy", risk: "low",
      urgency: 0, importance: 0, quadrant: e.quadrant, score: e.score, status: "needs_review",
      createdAt: now, anchorKey: `freestudy:${id}`,
      sourceSubject: subject,
      mastery: undefined,
    };
    if (subject) { try { t.mastery = subjectMastery(list, req.session.profile?.milestones, subject); } catch { /* mastery is a nicety */ } }
    list.push(t);
    req.session.tasks = list;
    // The new session must be in the ACCOUNT ROW before the page starts chatting: the slim session row never
    // carries tasks (store.ts), so the next request on another serverless instance can only find this task
    // through the cloud reload in findTaskOrReload — and a write-behind commit can still be pending (or lost
    // to a frozen function) when that request lands. That was the live "/chat → 404 Not found" on a brand-new
    // tutor session. One awaited write per session start; on a cloud error fall back to write-behind (the
    // session still works on this instance, and the chat route can rebuild it — see recoverTutorTask).
    try { await commit(req, { awaitCloud: true }); } catch (e: any) { console.warn("[study/free] awaited cloud write failed, falling back to write-behind:", e?.message || e); await commit(req); }
    res.json(tasksPayload(req, req.session.tasks));
  }));

  app.post("/api/study/extract-text", requireAuth, rateLimit(30, 60_000), ah(async (req, res) => {
    const url = String(req.body?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: "Invalid URL." }); return; }
    // Same SSRF guard the Pronote connect flow uses for the identical risk: an authenticated student could
    // otherwise point this at an internal address (cloud metadata, an internal service) and have the server
    // fetch it on their behalf, handing the response back as "extracted text." Checks scheme + both a literal
    // IP and the DNS-resolved address against private/reserved ranges — a normal-looking hostname isn't
    // enough to trust on its own (DNS rebinding).
    try { await pronoteSvc.assertSafeExternalUrl(url); } catch { res.status(400).json({ error: "Invalid URL." }); return; }
    try {
      const gdoc = url.match(GDOC_URL_RE);
      if (gdoc) {
        try {
          const rawExtras = await toolsFor(req);
          if (rawExtras) {
            const ro = integrations.readOnly(rawExtras);
            const raw = await ro.call("GOOGLEDOCS_GET_DOCUMENT_BY_ID", { id: gdoc[1] });
            // Pragmatic extraction, not a full Docs-API structural walk: every real paragraph of text in the
            // response lands in a `"content":"..."` field (Google's textRun.content) — collecting all matches
            // of that key is good-enough plain text without needing to model the whole nested document tree.
            if (raw) {
              const matches = [...raw.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
              const text = matches.map((m) => m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")).join("").trim();
              if (text) { res.json({ text: text.slice(0, MAX_EXTRACTED_CHARS) }); return; }
            }
          }
        } catch { /* fall through to the generic fetch below */ }
      }
      // redirect:"error" — the safety check above only vets THIS url; a redirect could land on an internal host.
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { "user-agent": "Mozilla/5.0 (compatible; OttoStudyBot/1.0)" } });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !/text\/html|text\/plain/i.test(ct)) { res.json({ text: "" }); return; }
      const html = await readBodyCapped(r, 400_000);
      res.json({ text: stripHtmlToText(html).slice(0, MAX_EXTRACTED_CHARS) });
    } catch {
      res.json({ text: "" }); // best-effort — never a hard error over an enhancement, matches pdfText.ts's own posture
    }
  }));

  // ── Personalization bandit (see server/bandit.ts + the approved plan) ──────────────────────────────────
  // v1 target: Pomodoro work/break length. Best-effort in both directions — a bandit hiccup must never block
  // starting or ending a study session, so both routes degrade to a safe default/no-op on any failure rather
  // than surfacing an error the student would have to do anything about.
  app.get("/api/study/pomodoro-suggestion", requireAuth, ah(async (req, res) => {
    // Beta-gated — see Profile.betaFeatures' own doc comment. Off (the common case) takes exactly the
    // same safe default this route already falls back to on a live failure — no new behavior to invent.
    if (!req.session.profile?.betaFeatures) { res.json({ enabled: false, workMinutes: 25, breakMinutes: 5, coldStart: true }); return; }
    try {
      const key = banditContextKey(new Date(), req.session.profile);
      const state = await loadBanditState(req.session.user!, "pomodoro");
      const { arm, coldStart } = chooseArm(POMODORO_ARMS, state, key);
      res.json({ enabled: arm.enabled, workMinutes: arm.workMinutes, breakMinutes: arm.breakMinutes, coldStart });
    } catch {
      // Safe, non-personalized default — must never regress the plain "pick your own Pomodoro" experience.
      res.json({ enabled: false, workMinutes: 25, breakMinutes: 5, coldStart: true });
    }
  }));

  // Fourth bandit target: desk ambience (see AUDIO_ARMS in bandit.ts) — "if trends emerge in study mode,
  // pre-build that environment" from the personalization ask. Same shape as pomodoro-suggestion above.
  app.get("/api/study/audio-suggestion", requireAuth, ah(async (req, res) => {
    if (!req.session.profile?.betaFeatures) { res.json({ audioType: "silence", coldStart: true }); return; }
    try {
      const key = banditContextKey(new Date(), req.session.profile);
      const state = await loadBanditState(req.session.user!, "audio");
      const { arm, coldStart } = chooseArm(AUDIO_ARMS, state, key);
      res.json({ audioType: arm.id, coldStart });
    } catch {
      res.json({ audioType: "silence", coldStart: true });
    }
  }));

  app.post("/api/study/session-outcome", requireAuth, rateLimit(30, 60_000), ah(async (req, res) => {
    try {
      const armId = String(req.body?.armId || "");
      if (!POMODORO_ARMS.some((a) => a.id === armId)) { res.status(400).json({ error: "Unknown arm." }); return; }
      const completedPlanned = !!req.body?.completedPlanned;
      const idleRatio = Number(req.body?.idleRatio);
      const netBoxDelta = req.body?.netBoxDelta !== undefined ? Number(req.body.netBoxDelta) : undefined;
      const avgConcentration = req.body?.avgConcentration !== undefined ? Number(req.body.avgConcentration) : undefined;
      const gazeOnScreenPct = req.body?.gazeOnScreenPct !== undefined ? Number(req.body.gazeOnScreenPct) : undefined;
      const avgBlinkRate = req.body?.avgBlinkRate !== undefined ? Number(req.body.avgBlinkRate) : undefined;
      const restlessPct = req.body?.restlessPct !== undefined ? Number(req.body.restlessPct) : undefined;
      const headPoseStability = req.body?.headPoseStability !== undefined ? Number(req.body.headPoseStability) : undefined;
      if (!Number.isFinite(idleRatio)) { res.status(400).json({ error: "Invalid idleRatio." }); return; }
      const reward = computeReward({
        completedPlanned, idleRatio,
        netBoxDelta: Number.isFinite(netBoxDelta) ? netBoxDelta : undefined,
        avgConcentration: Number.isFinite(avgConcentration) ? avgConcentration : undefined,
        gazeOnScreenPct: Number.isFinite(gazeOnScreenPct) ? gazeOnScreenPct : undefined,
        avgBlinkRate: Number.isFinite(avgBlinkRate) ? avgBlinkRate : undefined,
        restlessPct: Number.isFinite(restlessPct) ? restlessPct : undefined,
        headPoseStability: Number.isFinite(headPoseStability) ? headPoseStability : undefined,
      });
      const key = banditContextKey(new Date(), req.session.profile);
      const email = req.session.user!;
      const state = await loadBanditState(email, "pomodoro");
      await saveBanditState(email, "pomodoro", updatePosterior(state, key, armId, reward));
      void recordSessionOutcome({ userEmail: email, decisionKey: "pomodoro", arm: armId, context: key, reward, at: new Date().toISOString() });
      if (req.session.profile) bumpActivityHour(req.session.profile);
      // Audio arm is optional (a custom upload or Spotify link has no arm — see AUDIO_ARMS's own comment) —
      // scored with the SAME reward as Pomodoro when present, since it's the same underlying session outcome.
      const audioArmId = req.body?.audioArmId ? String(req.body.audioArmId) : undefined;
      if (audioArmId && AUDIO_ARMS.some((a) => a.id === audioArmId)) {
        const audioState = await loadBanditState(email, "audio");
        await saveBanditState(email, "audio", updatePosterior(audioState, key, audioArmId, reward));
        void recordSessionOutcome({ userEmail: email, decisionKey: "audio", arm: audioArmId, context: key, reward, at: new Date().toISOString() });
      }
      // Density is scored from the SAME session outcome (a student comfortable in their layout should show up
      // as a more focused session, same reasoning as audio) — but ONLY while still on the bandit's own
      // suggestion; a manual Settings choice stops learning here entirely, it's already decided.
      const densityArmId = req.body?.densityArmId ? String(req.body.densityArmId) : undefined;
      if (densityArmId && !req.session.profile?.uiDensity && DENSITY_ARMS.some((a) => a.id === densityArmId)) {
        const densityState = await loadBanditState(email, "density");
        await saveBanditState(email, "density", updatePosterior(densityState, key, densityArmId, reward));
        void recordSessionOutcome({ userEmail: email, decisionKey: "density", arm: densityArmId, context: key, reward, at: new Date().toISOString() });
      }
      res.json({ ok: true });
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't record that — it won't affect your session." }); }
  }));

  // ── Exercises (route /exercises — reachable by URL only, not from the navbar) ──
  // Practice questions pulled from the registered sources for the student's programme (IB / AP): the same lookup the tutor
  // uses, shown to the student directly with a link to each original. Other programmes have no registered sources.
  app.post("/api/exercises/search", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
    const topic = String(req.body?.topic || "").trim().slice(0, 120);
    const subject = String(req.body?.subject || "").trim().slice(0, 60);
    const track = req.session.profile?.track;
    const sources = sourcesForTrack(track).map((s) => ({ name: s.name, host: s.host }));
    if (!topic) { res.status(400).json({ error: "Enter a topic." }); return; }
    if (!sources.length) { res.json({ track: track || null, sources, questions: [] }); return; }
    const questions = await findSourceQuestions({ track, subject: subject || undefined, topic, limit: 6 }).catch(() => []);
    res.json({ track, sources, questions });
  }));

  // ── Coursework ───────────────────────────────────────────────────────────────────────────────────────────────
  // The browser extracts text from the FIRST few pages only (COURSEWORK_MAX_PAGES / COURSEWORK_MAX_CHARS, enforced
  // again here), the server distils it to a short summary + key points the tutor and chat can cite, and — when the
  // document itself sets work (a worksheet, an assignment brief) — proposes up to 3 tasks. The file itself is never
  // uploaded or stored; only the summary and a short excerpt are kept on the profile.
  app.post("/api/coursework", requireAuth, rateLimit(15, 60_000), ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const subject = String(req.body?.subject || "").trim().slice(0, 60);
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ").slice(0, 140);
    const text = String(req.body?.text || "").replace(/\u0000/g, "").trim().slice(0, COURSEWORK_MAX_CHARS);
    if (!subject || !name) { res.status(400).json({ error: "pick a subject and a document name" }); return; }
    if (text.length < 40) { res.status(400).json({ error: "I couldn't read any text in that document (a scanned page with no text?)." }); return; }
    if ((p.coursework || []).length >= COURSEWORK_MAX_DOCS) { res.status(400).json({ error: "You've reached the document limit — remove one first." }); return; }
    const pages = Math.max(1, Math.min(COURSEWORK_MAX_PAGES, Math.round(Number(req.body?.pages) || 1)));
    const totalPages = Number(req.body?.totalPages) > 0 ? Math.min(9999, Math.round(Number(req.body.totalPages))) : undefined;
    const truncated = req.body?.truncated === true || (totalPages != null && totalPages > pages) || String(req.body?.text || "").length > COURSEWORK_MAX_CHARS;
    const ready = aiReady() && !isPaused(req);
    const sum = ready ? await summarizeCoursework(subject, name, text, p).catch(() => null) : null;
    if (sum) addUsage(p, sum.tokens, "other");
    const id = randomUUID();
    const doc: CourseworkDoc = {
      id, subject, name,
      summary: sum?.summary || fallbackCourseworkSummary(text),
      keyPoints: sum?.keyPoints?.length ? sum.keyPoints : undefined,
      // 4000 chars, not 1500: `courseworkLine` quotes each document's own opening to the tutor, and a worksheet's
      // actual questions must be inside that quote for "set an exercise from their worksheet" to mean anything.
      excerpt: text.replace(/\s+/g, " ").slice(0, 4000),
      pages, totalPages, truncated: truncated || undefined,
      addedAt: new Date().toISOString(),
    };
    // Tasks only when the document itself sets work (the summarizer returns [] otherwise). Added like a manual
    // task (same shape, idempotent clientId), tagged with the subject, then queued for planning when AI is ready.
    const created: WebTask[] = [];
    for (const [i, t] of (sum?.tasks || []).entries()) {
      req.session.tasks = tasks.addManual(req.session.tasks || [], t.title, null, !ready, t.due, `cw:${id}:${i}`);
      const added = req.session.tasks[0];
      added.sourceSubject = subject;
      if (t.why) added.why = t.why;
      if (ready) added.status = "queued";
      created.push(added);
    }
    if (created.length) doc.taskIds = created.map((t) => t.id);
    p.coursework = [doc, ...(p.coursework || [])].slice(0, COURSEWORK_MAX_DOCS);
    await saveSession(req);
    if (created.length && req.session.user) {
      const email = req.session.user;
      try {
        const current = await loadState(email);
        await saveState(email, { profile: mergeProfiles(current.profile || emptyProfile(), p), tasks: mergeTasks(current.tasks || [], req.session.tasks || []) });
      } catch { /* best-effort — the enqueue below merges on write too */ }
      if (ready) for (const t of created) { try { await jobs.enqueueAndDrain(email, "execute_task", t.id, undefined, false); } catch { /* the kick loop / cron picks it up */ } }
    }
    await commit(req);
    res.json({ doc, tasks: created.map((t) => ({ id: t.id, title: t.title })), profile: p, aiSummarized: !!sum });
  }));

  app.delete("/api/coursework/:id", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const id = decodeURIComponent(String(req.params.id || ""));
      p.coursework = (p.coursework || []).filter((d) => d.id !== id);
      if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't remove that document — try again." }); }
  });

  // ── Focus Tracking ─────────────────────────────────────────────────────────────
  // Save a focus session from the camera artifact
  app.post("/api/focus/session", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      // Whitelist: only the scalar fields a focus session has (the body used to be stored as-is, so any extra key rode into the account row).
      const FOCUS_KEYS = ["id", "taskId", "taskTitle", "subject", "startTime", "endTime", "duration", "avgConcentration", "avgMovement", "avgBlinkRate", "gazeOnScreenPct", "avgHeadYaw", "avgHeadPitch", "avgHeadRoll", "concentrationVariance", "focusStability", "taskCompleted", "quality"];
      const raw = req.body && typeof req.body === "object" ? req.body : {};
      const session = Object.fromEntries(FOCUS_KEYS.filter((k) => ["string", "number", "boolean"].includes(typeof raw[k])).map((k) => [k, typeof raw[k] === "string" ? raw[k].slice(0, 200) : raw[k]])) as unknown as FocusSession;
      
      // Validate required fields
      if (!session.id || !session.startTime || !session.endTime || session.duration === undefined) {
        res.status(400).json({ error: "Missing required session fields" });
        return;
      }
      
      // Add to profile
      const sessions = (p.focusSessions ||= []);
      sessions.push(session);
      
      // Keep only last 10 sessions
      if (sessions.length > 10) {
        p.focusSessions = sessions.slice(-10);
      }
      
      // Recalculate aggregated stats
      recalculateFocusStats(p);
      
      await commit(req);
      res.json({ success: true, stats: p.focusStats });
    } catch (e: any) {
      console.error("Failed to save focus session:", e);
      console.error(e);
      res.status(500).json({ error: "Couldn't save session — try again." });
    }
  });

  // Get focus statistics
  app.get("/api/focus/stats", requireAuth, async (req, res) => {
    try {
      const p = req.session.profile;
      if (!p) {
        res.json({ stats: null });
        return;
      }
      recalculateFocusStats(p);
      res.json({ stats: p.focusStats });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't load stats — try again." });
    }
  });

  // Get focus session history
  app.get("/api/focus/sessions", requireAuth, async (req, res) => {
    try {
      const p = req.session.profile;
      if (!p) {
        res.json({ sessions: [] });
        return;
      }
      const limit = Math.min(50, Number(req.query?.limit) || 20);
      const sessions = (p.focusSessions || []).slice(-limit).reverse();
      res.json({ sessions });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't load sessions — try again." });
    }
  });

  // Get scheduling suggestion for a task
  app.get("/api/focus/schedule-suggestion", requireAuth, async (req, res) => {
    try {
      const subject = String(req.query?.subject || "");
      const difficulty = String(req.query?.difficulty || "");
      const p = req.session.profile;
      const suggestion = generateSchedulingSuggestion({ sourceSubject: subject || undefined, difficulty: difficulty || undefined }, p);
      res.json({ suggestion });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't generate suggestion — try again." });
    }
  });

  // Get artifact type recommendation for a subject
  app.get("/api/focus/artifact-recommendation", requireAuth, async (req, res) => {
    try {
      const subject = String(req.query?.subject || "");
      const p = req.session.profile;
      const recommendation = recommendArtifactType(subject, p);
      res.json({ recommendation });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't generate recommendation — try again." });
    }
  });

  // ── Study Mode ────────────────────────────────────────────────────────���────
  // Get study session history
  app.get("/api/study/sessions", requireAuth, async (req, res) => {
    try {
      if (req.session.user && cloudEnabled()) {
        const cloud = await loadState(req.session.user);
        res.json(cloud.studySessions || []);
      } else {
        res.json([]);
      }
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't load study sessions." }); }
  });

  // Create/save a study session
  app.post("/api/study/session", requireAuth, async (req, res) => {
    try {
      const sessionData = req.body as Partial<StudySession>;
      if (!sessionData.taskId || !sessionData.userId) {
        res.status(400).json({ error: "taskId and userId are required" });
        return;
      }
      
      const email = req.session.user;
      if (!email) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      
      const current = await loadState(email);
      const sessions = current.studySessions || [];
      const existingIndex = sessions.findIndex((s) => s.id === sessionData.id);
      
      const session: StudySession = {
        id: sessionData.id || randomUUID(),
        taskId: sessionData.taskId,
        userId: sessionData.userId,
        startTime: sessionData.startTime || new Date().toISOString(),
        endTime: sessionData.endTime,
        plannedDuration: sessionData.plannedDuration || 45,
        actualDuration: sessionData.actualDuration,
        state: sessionData.state || "idle",
        reflection: sessionData.reflection,
        interruptionCount: sessionData.interruptionCount || 0,
        notes: sessionData.notes,
        completedSteps: sessionData.completedSteps,
        createdAt: sessionData.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      if (existingIndex >= 0) {
        sessions[existingIndex] = session;
      } else {
        sessions.push(session);
      }
      
      // Keep only last 100 sessions
      const trimmedSessions = sessions.length > 100 ? sessions.slice(-100) : sessions;
      
      await saveStudySessions(email, trimmedSessions, { throwOnError: true });
      res.json(session);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save study session." }); }
  });

  // Get study profile
  app.get("/api/study/profile", requireAuth, async (req, res) => {
    try {
      if (req.session.user && cloudEnabled()) {
        const cloud = await loadState(req.session.user);
        res.json(cloud.studyProfile || { userId: req.session.user, updatedAt: new Date().toISOString() });
      } else {
        res.json({ userId: req.session.user, updatedAt: new Date().toISOString() });
      }
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't load study profile." }); }
  });

  // Update study profile
  app.post("/api/study/profile", requireAuth, async (req, res) => {
    try {
      const profileData = req.body as Partial<StudyProfile>;
      const email = req.session.user;
      if (!email) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      
      const current = await loadState(email);
      const existing = current.studyProfile || { userId: email, updatedAt: new Date().toISOString() };
      
      const updated: StudyProfile = {
        userId: existing.userId || email,
        preferredSessionLength: profileData.preferredSessionLength,
        preferredBreakLength: profileData.preferredBreakLength,
        prefersPomodoro: profileData.prefersPomodoro,
        uninterruptedSessions: profileData.uninterruptedSessions,
        preferredStartTimes: profileData.preferredStartTimes,
        theme: profileData.theme,
        timerStyle: profileData.timerStyle,
        showTimer: profileData.showTimer,
        showSidebar: profileData.showSidebar,
        animationLevel: profileData.animationLevel,
        audioType: profileData.audioType,
        audioBySubject: profileData.audioBySubject,
        volume: profileData.volume,
        notesPosition: profileData.notesPosition,
        materialsPosition: profileData.materialsPosition,
        aiVisibility: profileData.aiVisibility,
        focusLevel: profileData.focusLevel,
        sessionHistory: profileData.sessionHistory,
        updatedAt: new Date().toISOString(),
      };
      
      await saveState(email, { profile: current.profile, tasks: current.tasks, studyProfile: updated }, { throwOnError: true });
      res.json(updated);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save study profile." }); }
  });
}
