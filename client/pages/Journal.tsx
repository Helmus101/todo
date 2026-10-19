import { useEffect, useState, useCallback, useRef } from "react";
import type { WebTask, ConnectionStatus } from "../../shared/types.ts";
import { milestonesBySubject } from "../../shared/types.ts";
import { api } from "../api.ts";
import { saveDeckLocally } from "../localDecks.ts";
import { saveQuizLocally } from "../localQuizzes.ts";
import { useLang, todayIso, fmtDate, TaskModal, useNotify, FlashcardDeck, QuizPlayer, PracticeProblemCard } from "../ui.tsx";
import { useSpeechRecognition } from "../voice/useSpeechRecognition.ts";
import { 
  Mic,
  MicOff
} from "lucide-react";
import { STUDYLOG_CACHE_PREFIX, STUDYLOG_MONTH_CACHE_PREFIX } from "../appShared.tsx";
import { DueReviews } from "./Dashboard.tsx";
import { FlashcardsLibraryPage } from "./Flashcards.tsx";

/** Otto's own record of what's actually landed, per topic — profile.milestones (shared/types.ts), extracted
 *  from journal entries (extractJournalMemory, server/claude.ts) alongside the existing journal→courses fact
 *  pipeline. Same chip strip pattern as DueReviews/exam-strip right above — one visual language for "here's
 *  a small stack of things about your studying," not a new bespoke widget. This is the direct, visible half
 *  of "the tutor remembers your progress" — the other half (feeding it back INTO chat so Otto builds on it
 *  instead of re-teaching) is milestoneLine in server/claude.ts, invisible by design (a tutor doesn't
 *  announce "per my notes...").  Own profile fetch (same pattern as MistakeLogPage/SettingsPage below) since
 *  StudyLogPage doesn't otherwise carry profile state. */
function MilestonesStrip({ lang }: { lang?: "fr" | "en" }) {
  const en = lang === "en";
  const [groups, setGroups] = useState<ReturnType<typeof milestonesBySubject> | null>(null);
  useEffect(() => { void api.profile().then((p) => setGroups(milestonesBySubject(p.milestones))).catch(() => setGroups([])); }, []);
  if (!groups?.length) return null;
  return (
    <div className="due-reviews milestones-strip">
      <div className="exam-strip-label">{"What's clicked so far"}</div>
      <div className="exam-strip">
        {groups.flatMap((g) => g.entries.slice(0, 3).map((m) => (
          <span key={m.id} className="exam-chip milestone-chip" title={m.label}>
            <span className="exam-subject">{g.subject}</span>
            <span className="milestone-topic">{m.topic}</span>
          </span>
        )))}
      </div>
    </div>
  );
}

// Monday (YYYY-MM-DD) of the week containing `dateStr` — mirrors mondayOf in server/index.ts exactly
// (same simple, year-boundary-safe scheme, not a formal ISO week number). MUST do the arithmetic in UTC,
// not local time: parsing "T00:00:00" (no Z) reads it as LOCAL midnight, but then calling .toISOString()
// converts that back to UTC — for anyone in a timezone ahead of UTC (most of Europe/Asia/Australia), local
// midnight is still the PREVIOUS day in UTC, so every date this produced came out shifted back by one day.
// That silently misaligned which date a saved entry's logDate landed on vs. what the server's own
// (correctly all-UTC) mondayOf/weekdayDates expected when building the week-summary lookup — the real cause
// of "No entries logged this week yet" despite entries clearly being there. Parsing with an explicit "Z"
// and using the UTC getters/setters throughout makes this a pure calendar-string computation, immune to the
// browser's local timezone, and byte-for-byte the same scheme the server already uses.
const mondayOf = (dateStr: string): string => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
};

const addDays = (dateStr: string, n: number): string => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function studylogWeekKey(userId: string | null, monday: string): string { return `${STUDYLOG_CACHE_PREFIX}${userId || "anon"}:${monday}`; }

function loadWeekCache(userId: string | null, monday: string): { days: (WebTask | null)[]; summary: WebTask | null } | null {
  try {
    const raw = localStorage.getItem(studylogWeekKey(userId, monday));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveWeekCache(userId: string | null, monday: string, data: { days: (WebTask | null)[]; summary: WebTask | null }): void {
  try { localStorage.setItem(studylogWeekKey(userId, monday), JSON.stringify(data)); } catch { /* storage full/private — cache is best-effort only */ }
}

function studylogMonthKey(userId: string | null, month: string): string { return `${STUDYLOG_MONTH_CACHE_PREFIX}${userId || "anon"}:${month}`; }

function loadMonthCache(userId: string | null, month: string): { weeks: WebTask[]; summary: WebTask | null } | null {
  try {
    const raw = localStorage.getItem(studylogMonthKey(userId, month));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveMonthCache(userId: string | null, month: string, data: { weeks: WebTask[]; summary: WebTask | null }): void {
  try { localStorage.setItem(studylogMonthKey(userId, month), JSON.stringify(data)); } catch { /* best-effort */ }
}

// REVERSAL: this used to prefer "whichever side actually has content" (server vs. local cache) on the
// theory that a server response briefly showing no deck was more likely a stale read/merge race than a
// real absence. In practice this masked genuine data loss instead: a day whose save never actually finished
// writing to the cloud (see commit()'s awaitCloud fix) still showed its deck forever via the local cache,
// with no way to tell "safely stored" from "only exists in this one browser" — reported live as a deck
// visible in the Journal while the week-summary route (which only ever reads real server state) insisted
// the day had nothing. A successful server response is now trusted outright; the local cache is used ONLY
// when the fetch itself fails (see load()'s .catch() below), never merged against a response that succeeded.

export function StudyLogPage({ lang, tasks, status, phoneOnly }: { lang?: "fr" | "en"; tasks: WebTask[]; status?: ConnectionStatus | null; phoneOnly?: boolean }) {
  const L = useLang();
  const notify = useNotify();
  const en = lang === "en";
  // The flashcards library used to be its own top-level tab — folded in here instead, since every deck a
  // student reviews (Journal-generated or task-generated) belongs next to where they're already studying,
  // not one more thing in the sidebar to remember. Journal is the default view; Flashcards is a click away.
  // On a phone (phoneOnly), this page IS the flashcards library — writing a journal entry on a phone-sized
  // screen is one of the things deliberately not offered there (see App.tsx's PHONE_ALLOWED_ROUTES comment).
  const [tab, setTab] = useState<"journal" | "flashcards">(phoneOnly ? "flashcards" : "journal");
  const [monday, setMonday] = useState(() => mondayOf(todayIso()));
  const [days, setDays] = useState<(WebTask | null)[]>(() => loadWeekCache(status?.user || null, mondayOf(todayIso()))?.days || [null, null, null, null, null, null, null]);
  const [summary, setSummary] = useState<WebTask | null>(() => loadWeekCache(status?.user || null, mondayOf(todayIso()))?.summary || null);
  const [loaded, setLoaded] = useState(false);
  // Mon=0..Sun=6 (the week now covers all 7 days, not just weekdays) — getUTCDay() is Sun=0..Sat=6, so
  // shifting by +6 mod 7 maps Mon(1)->0 ... Sat(6)->5, Sun(0)->6.
  const todayIdx = (() => { const d = new Date(`${todayIso()}T00:00:00Z`).getUTCDay(); return (d + 6) % 7; })();
  const [selected, setSelected] = useState(mondayOf(todayIso()) === monday ? todayIdx : 0);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  // Speech-to-text dictation for the Journal entry — never auto-started; explicit user tap required.
  const speechLang = "en-US";
  const recog = useSpeechRecognition({
    lang: speechLang,
    onResult: (transcript) => {
      if (transcript.trim()) {
        setText((prev) => (prev ? `${prev} ${transcript.trim()}` : transcript.trim()));
      }
    },
  });

  // Stop listening whenever switching tabs, days, or unmounting (prevents stray mic active state) — NOT on
  // every render. useSpeechRecognition returns a fresh object literal each call (its individual functions
  // are memoized via useCallback, but the wrapping object itself isn't), so having `recog` itself in this
  // effect's deps meant the cleanup ran on EVERY re-render of this page, not just a real tab/day switch —
  // any unrelated re-render while dictating (a background status poll landing, anything) silently called
  // stop() mid-sentence. Reported live as "voice dictation turns off by itself." A ref sidesteps this: it
  // always holds the LATEST recog for the cleanup to read, without the effect re-subscribing on every render.
  const recogRef = useRef(recog);
  recogRef.current = recog;
  useEffect(() => {
    return () => {
      if (recogRef.current.listening) recogRef.current.stop();
    };
  }, [selected, monday, tab]);
  // Editing a day whose deck already exists — false by default so a day WITH a deck shows the deck/quiz
  // straight away, not the entry textarea again. Flipping this back to the textarea is an explicit choice
  // (the "modifier" link), never the default view once a deck exists.
  const [editingDay, setEditingDay] = useState(false);
  const [openDeckFor, setOpenDeckFor] = useState<"summary" | "month" | null>(null);
  // Companion quiz on week/month summaries — separate open-state from the flashcard deck's, since a summary
  // can have both live at once and they're reviewed independently (see generateWeeklyStudyDeck/
  // generateMonthlyStudyDeck in server/claude.ts: a quiz is included only when the material genuinely calls
  // for discrimination-style testing, so it may not exist even when the deck does).
  const [openQuizFor, setOpenQuizFor] = useState<"day" | "summary" | "month" | null>(null);

  // Month summary: aggregates whatever weekly decks already exist in the month containing `monday`, not
  // its own calendar nav — riding the week nav keeps this simple (no second date picker) at the cost of
  // the month view following whichever week you're currently on.
  const month = monday.slice(0, 7);
  const [monthWeeks, setMonthWeeks] = useState<WebTask[]>(() => loadMonthCache(status?.user || null, mondayOf(todayIso()).slice(0, 7))?.weeks || []);
  const [monthSummary, setMonthSummary] = useState<WebTask | null>(() => loadMonthCache(status?.user || null, mondayOf(todayIso()).slice(0, 7))?.summary || null);
  const [monthGenBusy, setMonthGenBusy] = useState(false);

  // Journal decks/quizzes live on their own synthetic studylog tasks, fetched through /api/studylog/* —
  // entirely separate from the main app-level `tasks` list, so they never reached the App-level backup
  // effect that mirrors every deck/quiz to localStorage (client/localDecks.ts, client/localQuizzes.ts) for
  // the Flashcards tab. That's why a Journal deck could be generated, reviewed, everything — yet never show
  // up in "Your flashcards" and not survive a sync hiccup the way an ordinary task's deck already did. Same
  // backup call, just driven off this page's own day/week/month state instead of the global task list.
  const userId = status?.user;
  useEffect(() => {
    for (const d of days) {
      if (!d) continue;
      for (const deck of d.flashcards || []) saveDeckLocally(d.id, d.title, deck, d.logDate, userId);
      for (const quiz of d.quizzes || []) saveQuizLocally(d.id, d.title, quiz, d.logDate, userId);
    }
    if (summary) {
      for (const deck of summary.flashcards || []) saveDeckLocally(summary.id, summary.title, deck, undefined, userId);
      for (const quiz of summary.quizzes || []) saveQuizLocally(summary.id, summary.title, quiz, undefined, userId);
    }
  }, [days, summary, userId]);
  useEffect(() => {
    if (!monthSummary) return;
    for (const deck of monthSummary.flashcards || []) saveDeckLocally(monthSummary.id, monthSummary.title, deck, undefined, userId);
    for (const quiz of monthSummary.quizzes || []) saveQuizLocally(monthSummary.id, monthSummary.title, quiz, undefined, userId);
  }, [monthSummary, userId]);

  // STALE-RESPONSE GUARD: clicking "prev/next week" (or arriving back at a week you'd already left)
  // fires a new fetch on every `monday` change, but nothing stopped an OLDER request from resolving AFTER
  // a newer one and overwriting the right week's data with the wrong week's — reported live as "I go back
  // a week and it shows only the entry, not the flashcards" (a day that genuinely has a deck momentarily,
  // or permanently if the user doesn't revisit, shows as deck-less because a slower, now-stale response
  // for a DIFFERENT week landed last and clobbered `days`/`summary`). A plain incrementing ref — bumped on
  // every call, captured per-call, checked before either setState — makes only the LATEST request's
  // response ever allowed to apply, same pattern as useSpeechSynthesis's genRef for the identical class of
  // "an async step must not touch state after something newer has superseded it" race.
  const loadGenRef = useRef(0);
  const load = useCallback((m: string) => {
    const gen = ++loadGenRef.current;
    const cached = loadWeekCache(status?.user || null, m);
    if (cached) { setDays(cached.days); setSummary(cached.summary); setLoaded(true); }
    else setLoaded(false);
    void api.studyLogWeek(m).then((r) => {
      if (loadGenRef.current !== gen) return; // superseded by a newer week request — discard
      // A SUCCESSFUL server response is authoritative, full stop — richerTask's "prefer whichever has
      // content" merge used to run even here, which meant a day the server genuinely has no deck for could
      // still show a stale LOCAL-ONLY deck left over from an earlier save that looked like it worked
      // client-side but never actually finished writing to the cloud (reported live: a deck visible on
      // screen, yet the week-summary route — which only ever reads real server state — insisted the day had
      // nothing). richerTask stays useful for the .catch() branch below (a genuine fetch failure, where the
      // cache is the only copy there is at all) — just not here, where server truth already won the race.
      setDays(r.days); setSummary(r.summary); setLoaded(true);
      saveWeekCache(status?.user || null, m, { days: r.days, summary: r.summary });
    }).catch(() => {
      if (loadGenRef.current !== gen) return; // superseded ��� a newer request's own success/failure wins
      if (!cached) { setLoaded(true); notify("Couldn't load this week.", "error"); }
    });
  }, [en, notify]);
  useEffect(() => { load(monday); }, [monday, load]);
  // `days` gets a new array reference on every background refresh (load()'s cache-then-network double-set,
  // onDayReview after a flashcard review, save() itself) — resetting text/editingDay on every single one of
  // those silently discarded in-progress edits, and on a page refresh could flash a saved entry then snap
  // back to an empty textarea before the network response landed. Only force a reset when the student
  // actually navigated to a different day/week (tracked via this ref); a `days` update while they're
  // actively editing is left alone entirely, and a `days` update while they're NOT editing still re-syncs
  // `text` (so a fresh fetch's content actually shows up) without touching `editingDay`.
  const navKeyRef = useRef<string>("");
  const editingDayRef = useRef(editingDay);
  editingDayRef.current = editingDay;
  useEffect(() => {
    const key = `${monday}:${selected}`;
    const navigated = navKeyRef.current !== key;
    navKeyRef.current = key;
    if (navigated) { setText(days[selected]?.logText || ""); setEditingDay(false); }
    else if (!editingDayRef.current) { setText(days[selected]?.logText || ""); }
  }, [selected, monday, days]);
  // Same stale-response race as the week loader above (loadGenRef) — the month changes alongside `monday`
  // every time the week nav crosses a month boundary, so a slower, now-superseded request here can land
  // just as easily and clobber the right month's data with the wrong one's.
  const monthGenRef = useRef(0);
  useEffect(() => {
    const gen = ++monthGenRef.current;
    const cached = loadMonthCache(status?.user || null, month);
    if (cached) { setMonthWeeks(cached.weeks); setMonthSummary(cached.summary); }
    void api.studyLogMonth(month).then((r) => {
      if (monthGenRef.current !== gen) return; // superseded by a newer month request — discard
      // Same reasoning as the week load above — a successful response is authoritative, never overridden
      // by a stale local-only cache entry.
      setMonthWeeks(r.weeks); setMonthSummary(r.summary);
      saveMonthCache(status?.user || null, month, { weeks: r.weeks, summary: r.summary });
    }).catch(() => {});
  }, [month]);

  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const save = async () => {
    setSaving(true);
    try {
      const list = await api.studyLogDay(dates[selected], text);
      const fresh = list.find((t) => t.logDate === dates[selected]) || null;
      setDays((prev) => {
        const next = prev.map((d, i) => (i === selected ? fresh : d));
        saveWeekCache(status?.user || null, monday, { days: next, summary });
        return next;
      });
      setEditingDay(false);
      // The server saves the log text either way (never loses what you typed) but can come back with a
      // 200 success and an EMPTY deck if generation itself failed (a truncated/unparseable model response —
      // see generateDailyStudyCards) — that used to be entirely silent: text saved, no deck, no error, no
      // clue why the flashcards never appeared. Detect it here since the client already has enough info
      // (non-empty text, no cards) without needing a server response-shape change.
      if (text.trim() && !fresh?.flashcards?.length) {
        notify("Saved, but couldn't make flashcards from that — try saving again.", "error");
      }
    } catch (e: any) { notify(e?.message || ("That didn't save — give it another try."), "error"); }
    finally { setSaving(false); }
  };
  const genSummary = async () => {
    setGenBusy(true);
    try {
      const list = await api.studyLogWeekSummary(monday);
      const fresh = list.find((t) => t.logDate === `week:${monday}`) || null;
      setSummary(fresh);
      saveWeekCache(status?.user || null, monday, { days, summary: fresh });
      // Open it immediately — leaving the student to notice a button's label silently changed to "View
      // summary" and click it a SECOND time read as "nothing happened" after a real wait for generation.
      if (fresh?.flashcards?.length) setOpenDeckFor("summary");
    } catch (e: any) { notify(e?.message || ("Couldn't build the week summary — try again."), "error"); }
    finally { setGenBusy(false); }
  };

  // NEWEST deck wins — deliberately not `flashcards[0]`. A journal day normally holds exactly one deck (the
  // save route replaces it in place), but a cross-device/list merge can legitimately end up holding two copies
  // of the same day under different deck ids, and the merge sorts decks oldest-first — so `[0]` handed the
  // student a STALE deck from before the day was regenerated. Reported live as a journal day showing only 10
  // cards when the newer deck for that same day had many more. The newest copy is the one that day's current
  // entry actually generated; the same reasoning applies to the week/month summaries below.
  const newestDeck = (t: WebTask | null | undefined): NonNullable<WebTask["flashcards"]>[number] | undefined =>
    (t?.flashcards || []).reduce<NonNullable<WebTask["flashcards"]>[number] | undefined>(
      (best, d) => (best && (Date.parse(best.createdAt || "") || 0) > (Date.parse(d.createdAt || "") || 0) ? best : d), undefined);
  const dayTask = days[selected];
  const dayDeck = newestDeck(dayTask);
  const dayQuiz = dayTask?.quizzes?.[0];
  const summaryDeck = newestDeck(summary);
  const summaryQuiz = summary?.quizzes?.[0];
  const anyEntryThisWeek = days.some((d) => d?.logText?.trim());
  const onDayReview = dayTask && dayDeck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(dayTask.id, dayDeck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === dayTask.id);
      if (fresh) setDays((prev) => {
        const next = prev.map((d) => (d?.id === dayTask.id ? fresh : d));
        saveWeekCache(status?.user || null, monday, { days: next, summary });
        return next;
      });
    }).catch(() => {});
  } : undefined;
  const onSummaryReview = summary && summaryDeck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(summary.id, summaryDeck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === summary.id);
      if (fresh) { setSummary(fresh); saveWeekCache(status?.user || null, monday, { days, summary: fresh }); }
    }).catch(() => {});
  } : undefined;

  const monthDeck = newestDeck(monthSummary);
  const monthQuiz = monthSummary?.quizzes?.[0];
  const onMonthReview = monthSummary && monthDeck ? (cardIndex: number, correct: boolean) => {
    void api.reviewFlashcard(monthSummary.id, monthDeck.id, cardIndex, correct).then((list) => {
      const fresh = list.find((t) => t.id === monthSummary.id);
      if (fresh) { setMonthSummary(fresh); saveMonthCache(status?.user || null, month, { weeks: monthWeeks, summary: fresh }); }
    }).catch(() => {});
  } : undefined;
  const genMonthSummary = async () => {
    setMonthGenBusy(true);
    try {
      const list = await api.studyLogMonthSummary(month);
      const fresh = list.find((t) => t.logDate === `month:${month}`) || null;
      setMonthSummary(fresh);
      saveMonthCache(status?.user || null, month, { weeks: monthWeeks, summary: fresh });
      if (fresh?.flashcards?.length) setOpenDeckFor("month");
    } catch (e: any) { notify(e?.message || ("Couldn't build the month summary — try again."), "error"); }
    finally { setMonthGenBusy(false); }
  };

  return (
    <main className="list-wrap studylog-page">
      <h1 className="list-head">{phoneOnly ? "Your flashcards" : "Journal"}</h1>
      <p className="page-sub mt-3">{phoneOnly
        ? "Review your flashcards here — the rest of Otto works better on a bigger screen."
        : "Keep what you learned. Come back to what matters."}</p>

      {/* Same .seg/.seg-btn segmented-control pattern as Pronote's Student/Parent picker — one visual
          language for every binary switcher in the app, not a second bespoke tab style. Hidden on phone:
          there's only one tab to show there, so a switcher with one real destination is just clutter. */}
      {!phoneOnly && <div className="seg studylog-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "journal"} className={`seg-btn ${tab === "journal" ? "on" : ""}`} onClick={() => setTab("journal")}>{"Journal"}</button>
        <button type="button" role="tab" aria-selected={tab === "flashcards"} className={`seg-btn ${tab === "flashcards" ? "on" : ""}`} onClick={() => setTab("flashcards")}>{"Flashcards"}</button>
      </div>}

      {/* The spaced-repetition system (Leitner boxes, see nextLeitnerReview in shared/types.ts) was otherwise
          entirely invisible from Journal — the ONE place a student would expect to see "you have cards due
          for review," reported live as "i never see this." The cross-task /api/reviews/due signal already
          existed but was buried in the dashboard's "This week" popover, nowhere near the Journal tab where
          these decks actually live. */}
      {!phoneOnly && <DueReviews lang={lang} tasks={tasks} />}
      {!phoneOnly && <MilestonesStrip lang={lang} />}

      {phoneOnly || tab === "flashcards" ? <FlashcardsLibraryPage lang={lang} tasks={tasks} embedded userId={status?.user || null} /> : (
      <>
      <div className="studylog-weeknav">
        <button type="button" className="btn xs ghost" onClick={() => setMonday(addDays(monday, -7))}>{"← " + "Prev week"}</button>
        <span className="studylog-weeklabel">{fmtDate(monday, L)} – {fmtDate(addDays(monday, 4), L)}</span>
        <button type="button" className="btn xs ghost" onClick={() => setMonday(addDays(monday, 7))}>{"Next week" + " →"}</button>
      </div>

      <div className="studylog-days">
        {dayLabels.map((label, i) => (
          <button key={i} type="button" className={`studylog-day-btn ${selected === i ? "active" : ""} ${days[i]?.logText ? "has-entry" : ""}`} onClick={() => setSelected(i)}>
            <span>{label}</span><span className="studylog-day-date">{fmtDate(dates[i], L)}</span>
          </button>
        ))}
      </div>

      {!loaded ? <p className="muted small">{"Pulling up your journal…"}</p> : (
        <>
          {/* Once a day has a deck, that IS the view — the entry textarea only comes back if you explicitly
              ask to edit. This is the point of the whole redesign: flashcards (and the quiz, when Otto made
              one) are always what you see for a day you already logged, not a "make cards" screen again. */}
          {dayDeck && !editingDay ? (
            <div className="studylog-day-cards">
              <div className="studylog-day-cards-head">
                <h3>{dayDeck.title}</h3>
                <button type="button" className="btn xs ghost" onClick={() => setEditingDay(true)}>{"Edit entry"}</button>
              </div>
              <FlashcardDeck deck={dayDeck} onReview={onDayReview} taskId={dayTask?.id} userId={status?.user || null} />
              {/* The quiz is only present when today's material genuinely called for discrimination-style
                  testing (server decides, not a guaranteed add-on) — so it may not exist even with a deck. */}
              {dayQuiz ? <button type="button" className="btn ghost" onClick={() => setOpenQuizFor("day")}>{"Quiz"} ({dayQuiz.questions.length})</button> : null}
              {/* Only present when the day's entry actually covered math/physics/science (server decides via
                  looksLikeStem) — a free-response problem, not multiple choice, so it's rendered inline
                  rather than behind a button: it's one problem, not a sequence to open a popup for. */}
              {dayTask?.practiceProblem ? (
                <div className="studylog-practice-sec">
                  <h4>{"Practice problem"}</h4>
                  <PracticeProblemCard problem={dayTask.practiceProblem} taskId={dayTask.id} />
                </div>
              ) : null}
              {/* Feynman-technique gap-check on the entry's OWN explanation (server/claude.ts's
                  checkFeynmanGap) — quiet, only shown when a real gap was actually found (most entries clear
                  this silently). Not a form to fill in: the point is to notice the gap and go find the
                  answer, in the cours or by asking Otto in chat — not to answer it here on the spot. */}
              {dayTask?.feynmanGap ? (
                <p className="studylog-feynman-gap">
                  <span aria-hidden="true">◐</span> {dayTask.feynmanGap}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="studylog-editor-toolbar">
                {recog.supported ? (
                  <button
                    type="button"
                    className={`btn xs ${recog.listening ? "danger pulse-btn" : "ghost"}`}
                    onClick={() => {
                      if (recog.listening) recog.stop();
                      else recog.start();
                    }}
                    title={recog.listening ? "Stop voice dictation" : "Voice dictation (STT)"}
                  >
                    {recog.listening ? <MicOff size={13} /> : <Mic size={13} />}
                    <span>{recog.listening ? "Listening…" : "Voice dictation"}</span>
                  </button>
                ) : null}
              </div>
              {recog.listening ? (
                <div className="studylog-stt-live">
                  <span className="stt-dot" /> {recog.interimTranscript || "Speak now, Otto is writing down your notes…"}
                </div>
              ) : null}
              <textarea className="studylog-textarea" rows={14}
                placeholder={"What did you learn today?"} aria-label={"What did you learn today?"}
                value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
              <div className="studylog-actions">
                <button type="button" className="btn primary" disabled={saving || !text.trim()} onClick={() => void save()}>
                  {saving ? "Saving…" : "Save & make flashcards"}
                </button>
                {dayDeck ? <button type="button" className="btn ghost" onClick={() => setEditingDay(false)}>{"View flashcards"}</button> : null}
              </div>
            </>
          )}

          <div className="studylog-summary-sec">
            <h3>{"Week summary"}</h3>
            {summaryDeck ? (
              <div className="studylog-actions">
                <button type="button" className="btn ghost" onClick={() => setOpenDeckFor("summary")}>{"View summary"} ({summaryDeck.cards.length})</button>
                {/* The quiz is only present when the week's material genuinely called for discrimination-style
                    testing (server decides, not a guaranteed add-on) — so it may not exist even with a deck. */}
                {summaryQuiz ? <button type="button" className="btn ghost" onClick={() => setOpenQuizFor("summary")}>{"Quiz"} ({summaryQuiz.questions.length})</button> : null}
              </div>
            ) : (
              <button type="button" className="btn ghost" disabled={genBusy || !anyEntryThisWeek} onClick={() => void genSummary()}>
                {genBusy ? "Building…" : "Generate week summary"}
              </button>
            )}
            {!anyEntryThisWeek ? <p className="settings-hint">{"Add at least one entry this week first."}</p> : null}
          </div>

          <div className="studylog-summary-sec">
            <h3>{"Month summary"}</h3>
            {monthDeck ? (
              <div className="studylog-actions">
                <button type="button" className="btn ghost" onClick={() => setOpenDeckFor("month")}>{"View summary"} ({monthDeck.cards.length})</button>
                {monthQuiz ? <button type="button" className="btn ghost" onClick={() => setOpenQuizFor("month")}>{"Quiz"} ({monthQuiz.questions.length})</button> : null}
              </div>
            ) : (
              <button type="button" className="btn ghost" disabled={monthGenBusy || monthWeeks.length === 0} onClick={() => void genMonthSummary()}>
                {monthGenBusy ? "Building…" : "Generate month summary"}
              </button>
            )}
            {monthWeeks.length === 0 ? <p className="settings-hint">{"Build at least one week summary this month first."}</p> : null}
          </div>
        </>
      )}

      {openDeckFor === "summary" && summaryDeck ? (
        <TaskModal onClose={() => setOpenDeckFor(null)} title={summaryDeck.title}><FlashcardDeck deck={summaryDeck} onReview={onSummaryReview} taskId={summary?.id} onAllCorrect={() => setOpenDeckFor(null)} userId={status?.user || null} /></TaskModal>
      ) : null}
      {openDeckFor === "month" && monthDeck ? (
        <TaskModal onClose={() => setOpenDeckFor(null)} title={monthDeck.title}><FlashcardDeck deck={monthDeck} onReview={onMonthReview} taskId={monthSummary?.id} onAllCorrect={() => setOpenDeckFor(null)} userId={status?.user || null} /></TaskModal>
      ) : null}
      {openQuizFor === "day" && dayQuiz ? (
        <TaskModal onClose={() => setOpenQuizFor(null)} title={dayQuiz.title}><QuizPlayer quiz={dayQuiz} taskId={dayTask?.id} userId={status?.user || null} /></TaskModal>
      ) : null}
      {openQuizFor === "summary" && summaryQuiz ? (
        <TaskModal onClose={() => setOpenQuizFor(null)} title={summaryQuiz.title}><QuizPlayer quiz={summaryQuiz} taskId={summary?.id} userId={status?.user || null} /></TaskModal>
      ) : null}
      {openQuizFor === "month" && monthQuiz ? (
        <TaskModal onClose={() => setOpenQuizFor(null)} title={monthQuiz.title}><QuizPlayer quiz={monthQuiz} taskId={monthSummary?.id} userId={status?.user || null} /></TaskModal>
      ) : null}
      </>
      )}
    </main>
  );
}
