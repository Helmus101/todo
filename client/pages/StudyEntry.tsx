import { useState, useRef, type Dispatch, type SetStateAction } from "react";
import type { WebTask, ConnectionStatus } from "../../shared/types.ts";
import { isHandled } from "../../shared/types.ts";
import { api } from "../api.ts";
import { StudyMode } from "../study/StudyMode.tsx";
import { unionChatEntries } from "../appShared.tsx";

export function StandaloneStudyEntry({ tasks, setTasks, status, notify, navigate }: {
  tasks: WebTask[]; setTasks: Dispatch<SetStateAction<WebTask[]>>; status: ConnectionStatus; notify: (msg: string, kind?: "error" | "info") => void; navigate: (r: string) => void;
}) {
  const en = status?.language === "en";
  const [taskId, setTaskId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Same stable-ref pattern as the main study/:id route (App.tsx's studyModeTask) — a freestudy task has no
  // URL to re-derive from, so a background syncTasks that momentarily omits or dismisses it (e.g. right after
  // /api/study/free's own "dismiss the previous freestudy task" step, or a plain stale/incomplete fetch) must
  // not make `task` go null mid-session, or this component falls straight back to the landing screen — the
  // "study mode auto gets out of it" report, for free-study sessions specifically.
  const studyTaskRef = useRef<WebTask | null>(null);
  const start = () => {
    setStarting(true);
    void api.studyFreeSession(true).then((list) => {
      setTasks(list);
      const t = list.find((x) => x.source === "freestudy" && !isHandled(x.status));
      if (t) { studyTaskRef.current = t; setTaskId(t.id); }
      else notify("Couldn't start a study session — try again.", "error");
    }).catch((e: any) => notify(e?.message || ("Couldn't start a study session — try again."), "error"))
      .finally(() => setStarting(false));
  };
  if (taskId && studyTaskRef.current?.id === taskId) {
    const fresh = tasks.find((t) => t.id === taskId);
    if (fresh) studyTaskRef.current = fresh;
  }
  const task = taskId && studyTaskRef.current?.id === taskId ? studyTaskRef.current : null;
  if (!task) {
    return (
      <main className="list-wrap">
        <div className="empty-state">
          <h3>{"Study whenever you want"}</h3>
          <p>{"Not tied to a task — a free workspace with notes, materials, and Otto's help."}</p>
          <button className="btn primary" disabled={starting} onClick={start}>{starting ? ("Starting…") : ("Enter study mode")}</button>
        </div>
      </main>
    );
  }
  return (
    <StudyMode
      task={task}
      onExit={() => navigate("tasks")}
      // Free-study session (no linked task, its own synthetic "study id" task) — same chat-union protection
      // as the task-linked path above, previously entirely missing here: a plain replace let a stale
      // background sync directly overwrite a fresher local chat with no merge at all, the most exposed of
      // the three onTaskUpdate call sites to "chat sometimes auto-deletes stuff".
      onTaskUpdate={(u) => setTasks((prev) => prev.some((x) => x.id === u.id)
        ? prev.map((x) => {
            if (x.id !== u.id) return x;
            const existingChat = x.chat || [];
            if (!existingChat.length) return u;
            return { ...u, chat: unionChatEntries(existingChat, u.chat || []) };
          })
        : [...prev, u])}
      userId={status?.user}
      language="en"
      betaFeatures={!!status?.betaFeatures}
    />
  );
}
