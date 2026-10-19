import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { WebTask, ConnectionStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useLang, TaskModal, useNotify, FlashcardDeck, Spinner, ErrorNote } from "../ui.tsx";
import { Logo, firstName } from "../appShared.tsx";

/** Cards due for spaced-repetition review, across EVERY task — the one genuinely new cross-task view the
 *  spaced-repetition work needed (see nextLeitnerReview in shared/types.ts): a deck's own player only ever
 *  shows what's due for THAT task's deck, but the whole point of spacing is seeing everything due at a
 *  glance without reopening every task to check. Opens the deck's review player DIRECTLY in a modal —
 *  reported live that linking to `/task/<id>` instead (the original version) meant clicking a due-review
 *  chip opened the whole task, and the student still had to go find the flashcard deck inside it. `tasks`
 *  is already loaded by the parent (App.tsx's main dashboard state), so the deck itself can be looked up
 *  locally — no extra fetch needed, same pattern as the Journal page's day/month deck review modals
 *  (StudyLogPage's onDayReview/onSummaryReview). */
export function DueReviews({ lang, tasks }: { lang?: "fr" | "en"; tasks: WebTask[] }) {
  const en = lang === "en";
  const [due, setDue] = useState<{ taskId: string; taskTitle: string; deckId: string; deckTitle: string; cardIndex: number }[] | null>(null);
  const [error, setError] = useState(false);
  const [openDeck, setOpenDeck] = useState<{ taskId: string; deckId: string } | null>(null);
  useEffect(() => { void api.reviewsDue().then((r) => setDue(r.due)).catch(() => { setDue([]); setError(true); }); }, []);
  // Once the open deck has nothing left due, close the modal automatically — a clear "you're done" signal
  // instead of leaving an empty-feeling review screen open with nothing more to click through.
  useEffect(() => {
    if (openDeck && due && !due.some((d) => d.deckId === openDeck.deckId)) setOpenDeck(null);
  }, [due, openDeck]);
  if (error) return <ErrorNote small>{"Couldn't load reviews due."}</ErrorNote>;
  if (!due?.length) return null;
  // Group by DECK (not task) — a task with two decks should show two chips, not one merged count.
  const byDeck = new Map<string, { taskId: string; deckTitle: string; count: number }>();
  for (const d of due) {
    const cur = byDeck.get(d.deckId);
    if (cur) cur.count++; else byDeck.set(d.deckId, { taskId: d.taskId, deckTitle: d.deckTitle, count: 1 });
  }
  // Capped at 3 decks/day — this strip sits at the very top of the Journal tab, and a student with a lot of
  // accumulated review debt used to see every single overdue deck at once (reported live: 7+ chips stacked
  // above the day picker), crowding out the actual journal entry below the fold. Most decks with the most
  // cards due first — that's the review that's actually gone stale longest, the one worth surfacing over a
  // deck that's barely behind.
  const dueDecks = [...byDeck.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
  const openTask = openDeck ? tasks.find((t) => t.id === openDeck.taskId) : undefined;
  const openDeckObj = openTask?.flashcards?.find((f) => f.id === openDeck?.deckId);
  return (
    <div className="due-reviews">
      <div className="exam-strip-label">{"Due for review"}</div>
      <div className="exam-strip">
        {dueDecks.map(([deckId, t]) => (
          <button key={deckId} type="button" className="exam-chip due-review-chip" onClick={() => setOpenDeck({ taskId: t.taskId, deckId })}>
            <span className="exam-days">{t.count}</span>
            <span className="exam-subject">{t.deckTitle}</span>
          </button>
        ))}
      </div>
      {openTask && openDeckObj && (
        <TaskModal onClose={() => setOpenDeck(null)} title={openDeckObj.title} nested>
          <FlashcardDeck
            deck={openDeckObj}
            taskId={openTask.id}
            onlyIndices={due.filter((d) => d.deckId === openDeckObj.id).map((d) => d.cardIndex)}
            onReview={(cardIndex, correct) => {
              void api.reviewFlashcard(openTask.id, openDeckObj.id, cardIndex, correct).catch(() => {});
              // Mark it complete immediately — reported live that a reviewed card stayed showing as "due"
              // (chip count unchanged) until the next full reload. Reviewing IS what clears "due today,"
              // regardless of right/wrong (that only changes which Leitner box it moves to next), so drop
              // it from the local due list the moment the review fires rather than waiting on a refetch.
              setDue((prev) => prev?.filter((d) => !(d.deckId === openDeckObj.id && d.cardIndex === cardIndex)) ?? prev);
            }}
            onAllCorrect={() => setOpenDeck(null)}
          />
        </TaskModal>
      )}
    </div>
  );
}

/** Thorough loading screen while Otto loads/scans — a spinner, a status line, and shimmer rows so the
 *  whole list arrives at once (never a half-populated flash). */
export function TaskSkeleton() {
  const L = useLang();
  const widths = ["66%", "52%", "71%", "58%", "63%"];
  return (
    <div className="loading-screen" aria-busy="true" aria-live="polite">
      <div className="loading-head">
        <Spinner size="sm" />
        <span className="loading-msg">{"Pulling up your day…"}</span>
      </div>
      <div className="list" aria-hidden="true">
        {widths.map((w, i) => (
          <div key={i} className="card skel">
            <div className="card-main">
              <span className="skel-box skel-pill" />
              <div className="card-text">
                <div className="skel-box skel-line" style={{ width: w }} />
                <div className="skel-box skel-line sm" style={{ width: "34%" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A connect-Gmail call to action — shown on the dashboard until Gmail is linked (via Composio, in Settings). */
export function ConnectCard({ status, onSkip }: { status: ConnectionStatus; onSkip: () => void }) {
  const who = status.name || firstName(status.user);
  const en = status.language === "en";
  return (
    <div className="connect-card">
      <div className="connect-mark"><Logo size={30} /></div>
      <h2>{who ? (`Welcome, ${who}`) : ("Welcome to Otto")}</h2>
      {/* Pronote is ONE option, never the premise: someone with no Pronote (IB/AP, a school on another
          portal, or nobody at all) must not read this as "this app isn't for me". Same picker either way. */}
      <p>{"Connect whatever holds your homework — Pronote, Gmail, Calendar or Drive — and Otto turns it into a clear plan for today. It never does the exercise for you, and never checks anything off without you."}</p>
      {/* A raw env-var name means nothing to a student — say what's actually broken instead. */}
      {!status.aiReady && <div className="warn">{"Otto's AI isn't set up on this server yet — task generation is off for now."}</div>}
      <a className="btn primary big" href="/settings">{"Choose what to connect"}</a>
      {/* Escape hatch — reported live: no Pronote/school with Pronote, no Google account, just wants to add
          tasks by hand and use the tutor. Connecting nothing is a legitimate way to use Otto (manual tasks
          + chat/Study Mode still work fully; the only thing missing is AUTOMATIC detection), so this isn't
          hidden behind Settings or worded as a dead end — it's a real, first-class choice right here. It
          sits at the same weight as the connect button for the same reason: nothing connected is not a
          downgrade, and Otto must not read as a Pronote-only app. */}
      <button type="button" className="btn ghost" onClick={onSkip}>{"Use Otto without connecting"}</button>
      <p className="fineprint">{"Connect or disconnect any app, or pause Otto, any time in Settings. "}<a href="/privacy">{"What Otto reads and why →"}</a></p>
    </div>
  );
}

export function AddTask({ onAdded }: { onAdded: Dispatch<SetStateAction<WebTask[]>> }) {
  const L = useLang();
  const notify = useNotify();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Optional explicit date — the "personal commitment" capture path (a job shift, a club meeting, an
  // appointment): a real date attached right here beats waiting on the AI to maybe infer one from vague
  // phrasing, and it's the lowest-friction way to get something that isn't from a connected app onto the
  // same list as everything else. Collapsed by default so it never adds weight to the common case of just
  // typing a quick task.
  const [showWhen, setShowWhen] = useState(false);
  const [when, setWhen] = useState("");
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setText("");
    const whenToSend = when;
    setShowWhen(false); setWhen("");
    // Show it in the list RIGHT AWAY instead of waiting on the round-trip — which includes a blocking AI
    // refinement call server-side and can take a couple seconds. A real "Add" should feel instant, like
    // any to-do list. The server's actual response (refined title, possibly auto-queued) replaces this
    // stub the moment it lands; a failure rolls the stub back and returns your text so nothing is lost.
    const stubId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stub: WebTask = {
      id: stubId, title: v, why: "Added by you", when: whenToSend || undefined, source: "manual", risk: "low",
      urgency: 0.5, importance: 0.5, quadrant: "do", score: 1,
      status: "ready", createdAt: new Date().toISOString(), unrefined: true,
    };
    onAdded((prev) => [stub, ...prev]);
    try {
      const fresh = await api.add(v, whenToSend || undefined, stubId);
      // Defensive: a 401 (session expired) resolves instead of throwing (see api.ts's j()), returning the
      // error BODY where an array was expected. Setting `tasks` state to that non-array object crashed the
      // whole app on the next render — which, from the outside, looked exactly like the new task vanishing.
      if (!Array.isArray(fresh)) throw new Error("Looks like you got logged out — reload the page.");
      onAdded(fresh);
    } catch (e: any) {
      onAdded((prev) => prev.filter((t) => t.id !== stubId));
      setText(v); setWhen(whenToSend);
      notify(e?.message || "Couldn't add this task — try again.", "error");
    }
    finally { setBusy(false); }
  };
  return (
    <div className="add-task-row">
      <span className="add-plus" aria-hidden="true">+</span>
      <input
        className="add-task-input"
        placeholder={"What do you owe yourself next?"} aria-label={"What do you owe yourself next?"}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      {showWhen ? (
        <input
          className="addinput sm add-task-when"
          type="date"
          value={when}
          disabled={busy}
          onChange={(e) => setWhen(e.target.value)}
          title={"When this is due"}
        />
      ) : (
        <button type="button" className="btn xs ghost add-when-toggle" disabled={busy} onClick={() => setShowWhen(true)}>{"+ date"}</button>
      )}
      {text.trim() && <button className="btn xs primary" disabled={busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add"}</button>}
    </div>
  );
}
