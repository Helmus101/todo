import { useCallback, useEffect, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { api } from "../api.ts";
import { hydrateLocalThreads, appendLocalChat, appendLocalBoard, appendLocalProblems } from "../localChatBoard.ts";
import { useLang } from "../ui.tsx";
import { AskOttoPanel } from "../study/AskOttoPanel.tsx";
import { BoardArtifact } from "../study/artifacts/BoardArtifact.tsx";

/** Tutor Session (route /tutor) — the Primer-style one-to-one lesson: a chat with Otto on one side and
 *  Otto's board on the other. It reuses the free-study task as a private anchor for the thread (chat, board
 *  and problems persist locally, keyed by task id — see localChatBoard.ts), and talks to the SAME chat
 *  endpoint as everywhere else, with `primer: true` so the server swaps in the Primer persona. */
export function TutorSession({ userId }: { userId: string | null }) {
  const L = useLang();
  const [task, setTask] = useState<WebTask | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setLoadError(false);
    api.studyFreeSession().then((list) => {
      if (stop) return;
      const t = Array.isArray(list) ? list.find((x) => x.source === "freestudy" && x.status !== "dismissed" && x.status !== "done") : undefined;
      if (t) setTask(hydrateLocalThreads([t], userId)[0]);
      else setLoadError(true);
    }).catch(() => { if (!stop) setLoadError(true); });
    return () => { stop = true; };
  }, [userId]);

  const send = useCallback(async (override?: string, voiceMode?: boolean) => {
    const message = (override ?? input).trim();
    if (!message || sending || !task) return;
    setInput(""); setSending(true); setError(null); setPendingMsg(message);
    try {
      const { task: updated, chatDelta, board, problems } = await api.chat(task.id, message, task.chat || [], task.board || [], task.problems || [], undefined, undefined, voiceMode, undefined, true);
      const chat = appendLocalChat(task.id, chatDelta, userId);
      const newBoard = appendLocalBoard(task.id, board, userId);
      const newProblems = appendLocalProblems(task.id, problems, userId);
      setTask({ ...task, ...updated, chat, board: newBoard, problems: newProblems });
    } catch (e: any) {
      setError(e?.message || L("Otto n'a pas pu répondre — réessaie.", "Otto couldn't reply — try again."));
      setInput(message);
    } finally {
      setSending(false); setPendingMsg(null);
    }
  }, [input, sending, task, userId, L]);

  if (loadError) {
    return (
      <main className="list-wrap"><div className="empty-state">
        <h3>{L("Impossible de démarrer la séance", "Couldn't start the session")}</h3>
        <button className="btn primary" onClick={() => { setLoadError(false); setTask(null); api.studyFreeSession().then((l) => { const t = l.find((x) => x.source === "freestudy"); if (t) setTask(hydrateLocalThreads([t], userId)[0]); else setLoadError(true); }).catch(() => setLoadError(true)); }}>{L("Réessayer", "Try again")}</button>
      </div></main>
    );
  }
  if (!task) return <main className="list-wrap"><div className="spinner" /></main>;

  const noop = () => {};
  const fresh = !task.chat?.length && !pendingMsg;
  return (
    <main className="tutor-session">
      <section className="tutor-chat" aria-label={L("Discuter avec Otto", "Ask Otto")}>
        <div className="tutor-pane-title">{L("Demande à Otto", "Ask Otto")}</div>
        {fresh && (
          <div className="tutor-start">
            <p>{L("Salut ! Je suis Otto, ton tuteur. On travaille ensemble sur ce que tu veux apprendre ?", "Hi! I'm Otto, your tutor. Ready to work on whatever you'd like to learn?")}</p>
            <button className="btn primary" disabled={sending} onClick={() => void send(L("Bonjour Otto !", "Hello Otto!"))}>{L("Commencer", "Let's begin")}</button>
          </div>
        )}
        <div className="tutor-chat-body">
          <AskOttoPanel
            task={task} currentStep={undefined} input={input} setInput={setInput} sending={sending}
            error={error} pendingMsg={pendingMsg} onSend={(o, v) => void send(o, v)}
            onOpenNote={noop} onOpenDeck={noop} onOpenQuiz={noop}
            emptyText="" placeholder={L("Écris ici…", "Type here…")}
          />
        </div>
      </section>
      <section className="tutor-board" aria-label={L("Tableau", "Board")}>
        <div className="tutor-pane-title">{L("Le tableau", "Board")}</div>
        <div className="tutor-board-body"><BoardArtifact task={task} /></div>
      </section>
    </main>
  );
}
