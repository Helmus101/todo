import { useEffect, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { getAllLocalDecks } from "../localDecks.ts";
import { getAllLocalQuizzes } from "../localQuizzes.ts";
import { useLang, TaskModal, FlashcardDeck, QuizPlayer } from "../ui.tsx";


/** Standalone "Study" mode (route /study, no task id) — the exact same full StudyMode workspace a task's
 *  own "Study Mode" button opens, just not anchored to a real to-do. StudyMode.tsx persists everything
 *  (chat, notes, artifacts) keyed off task.id server-side, so a session with no task still needs a
 *  lightweight placeholder to attach to — POST /api/study/free finds-or-creates one (source:"freestudy",
 *  excluded from the normal dashboard, see the `live`/`completed` filters above), so returning to /study
 *  later resumes the same workspace instead of starting over. */
/** Every flashcard deck this browser has ever generated, in one place, reachable regardless of where its
 *  source task/journal entry lives — built on the local backup (client/localDecks.ts) that already mirrors
 *  every deck as it's created, so this is always populated even offline or if a task got pruned/merged
 *  server-side. Reviewing from here posts back to the deck's real owner (taskId) exactly like reviewing it
 *  from the task/journal itself — this is a second way IN, not a separate copy of the review state. */
export function FlashcardsLibraryPage({ lang, tasks, embedded, userId }: { lang?: "fr" | "en"; tasks: WebTask[]; embedded?: boolean; userId: string | null }) {
  const L = useLang();
  const en = lang === "en";
  const [decks, setDecks] = useState(() => getAllLocalDecks(userId));
  const [quizzes, setQuizzes] = useState(() => getAllLocalQuizzes(userId));
  const [openId, setOpenId] = useState<string | null>(null);
  const [openQuizId, setOpenQuizId] = useState<string | null>(null);
  // Local storage isn't reactive — refresh the list on focus so a deck/quiz generated in another tab (or
  // just now, before this page was opened) shows up without needing a full reload.
  //
  // Reported live as a genuine cross-account leak: `decks`/`quizzes` above are seeded via a useState LAZY
  // initializer, which only ever runs on this component's very first mount. Signing out and into a
  // DIFFERENT account is an SPA-style soft reset (App.tsx's signOut — no full page reload), so if this
  // component instance survives that transition (React keeps it mounted since the tree shape around it
  // didn't change), its `decks` state kept showing the FIRST account's locally-cached flashcard decks
  // indefinitely — this effect's own cleanup/re-run on `userId` changing only re-pointed the FOCUS listener
  // at the new id, it never actually re-fetched immediately. A plain account switch inside the same tab
  // never fires a real window blur/focus cycle, so the stale list could sit there until the student
  // happened to tab away and back. Calling refresh() directly here (not just registering it for later)
  // closes that gap — it now re-reads local storage under the CURRENT userId the instant that id changes,
  // not just on the next incidental focus event.
  useEffect(() => {
    const refresh = () => { setDecks(getAllLocalDecks(userId)); setQuizzes(getAllLocalQuizzes(userId)); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [userId]);
  const open = decks.find((d) => d.deck.id === openId) || null;
  const openQuiz = quizzes.find((q) => q.quiz.id === openQuizId) || null;
  // The local backup can outlive the deck/quiz it's a copy of — an old day's deck gets replaced by a fresh
  // one (a new id) on regeneration, so a STALE local entry from before that happened points at an id the
  // server no longer has under that task at all. Posting a review for it 404s on every single card (this
  // was observed live: 17 consecutive 404s reviewing a stale deck). Check it actually still exists in the
  // live task list before ever attempting a server post — a stale copy is still fully reviewable locally
  // (FlashcardDeck/QuizPlayer track their own right/wrong regardless), it just can't sync anymore.
  const liveOwner = open ? tasks.find((t) => t.id === open.taskId && t.flashcards?.some((d) => d.id === open.deck.id)) : undefined;
  const liveQuizOwner = openQuiz ? tasks.find((t) => t.id === openQuiz.taskId && t.quizzes?.some((q) => q.id === openQuiz.quiz.id)) : undefined;
  const Wrap = embedded ? "div" : "main";
  return (
    <Wrap className={embedded ? "" : "list-wrap"}>
      {!embedded ? (
        <div className="dash-head">
          <h2>{"Your flashcards"}</h2>
          <p className="dash-line">{"Every deck and quiz you've ever generated, accessible anytime — even offline."}</p>
        </div>
      ) : null}
      {decks.length === 0 ? (
        <p className="muted small">{"No flashcards yet — they'll show up here as soon as Otto (or you) creates some."}</p>
      ) : (
        <div className="list">
          {decks.map(({ deck, taskTitle, savedAt, logDate }) => (
            <button key={deck.id} type="button" className="card" onClick={() => setOpenId(deck.id)}>
              <div className="card-text">
                <div className="card-title">{deck.title}</div>
                <div className="card-sub">
                  {logDate ? `${"Journal entry —"} ${new Date(`${logDate}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" })} · ` : `${taskTitle} · `}
                  {deck.cards.length} {"cards"} · {new Date(savedAt).toLocaleDateString("en-GB")}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {quizzes.length > 0 ? (
        <div className="dash-head mt-4">
          <h2>{"Your quizzes"}</h2>
        </div>
      ) : null}
      {quizzes.length > 0 ? (
        <div className="list">
          {quizzes.map(({ quiz, taskTitle, savedAt, logDate }) => (
            <button key={quiz.id} type="button" className="card" onClick={() => setOpenQuizId(quiz.id)}>
              <div className="card-text">
                <div className="card-title">{quiz.title}</div>
                <div className="card-sub">
                  {logDate ? `${"Journal entry —"} ${new Date(`${logDate}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" })} · ` : `${taskTitle} · `}
                  {quiz.questions.length} {"questions"} · {new Date(savedAt).toLocaleDateString("en-GB")}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <TaskModal onClose={() => setOpenId(null)} title={open.deck.title}>
          {!liveOwner ? (
            <p className="settings-hint mb-3">
              {"This deck's source has changed on the server — you can still review it, but progress won't sync."}
            </p>
          ) : null}
          <FlashcardDeck
            deck={open.deck}
            taskId={open.taskId}
            userId={userId}
            onReview={liveOwner ? (cardIndex, correct) => { void api.reviewFlashcard(open.taskId, open.deck.id, cardIndex, correct).catch(() => {}); } : undefined}
            onNotNeeded={liveOwner ? (cardIndex) => { void api.markFlashcardNotNeeded(open.taskId, open.deck.id, cardIndex).catch(() => {}); } : undefined}
            onAllCorrect={() => setOpenId(null)}
          />
        </TaskModal>
      ) : null}
      {openQuiz ? (
        <TaskModal onClose={() => setOpenQuizId(null)} title={openQuiz.quiz.title}>
          {!liveQuizOwner ? (
            <p className="settings-hint mb-3">
              {"This quiz's source has changed on the server — you can still review it, but progress won't sync."}
            </p>
          ) : null}
          <QuizPlayer quiz={openQuiz.quiz} taskId={liveQuizOwner ? openQuiz.taskId : undefined} userId={userId} />
        </TaskModal>
      ) : null}
    </Wrap>
  );
}
