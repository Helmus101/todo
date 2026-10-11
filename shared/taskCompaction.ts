// What an account row keeps of FINISHED work. Every read of the row downloads all of it — the dominant Supabase
// egress (reported: ~300 MB in a day). Each tutor session is its own task, and an ended one used to keep its full
// chat, board (SVG figures, interactive scenes), board-event log and problems in the row forever, even though the
// browser keeps its own copy of finished sessions (client/tutor/tutorSessions.ts) and the server already strips
// those fields before sending a task to the client. Pure; applied at the one write choke point (store.saveState).
import type { WebTask } from "./types.ts";
import { isHandled } from "./types.ts";

/** Ended tutor sessions kept as tiny stubs (id/status/timestamps only) — enough that a stale tab can never revive
 *  one (tasks.recoverTutorTask refuses an id the account still has); older ones are dropped. */
export const ENDED_TUTOR_STUBS_KEPT = 50;

export function compactTasksForStorage(tasks: WebTask[]): WebTask[] {
  const list = (tasks || []).filter((t) => t && typeof t === "object");
  // Which ended tutor sessions survive as stubs: the most recent ENDED_TUTOR_STUBS_KEPT.
  const stamp = (t: WebTask) => String(t.updatedAt || t.createdAt || "");
  const keptTutor = new Set(list.filter((t) => t.source === "freestudy" && isHandled(t.status))
    .sort((a, b) => stamp(b).localeCompare(stamp(a))).slice(0, ENDED_TUTOR_STUBS_KEPT).map((t) => t.id));
  const out: WebTask[] = [];
  for (const t of list) {
    if (!isHandled(t.status)) { out.push(t); continue; }
    if (t.source === "freestudy") {
      if (!keptTutor.has(t.id)) continue;
      out.push({
        id: t.id, title: t.title, why: t.why, source: t.source, status: t.status, risk: t.risk,
        urgency: t.urgency, importance: t.importance, quadrant: t.quadrant, score: t.score,
        createdAt: t.createdAt, ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
        ...(t.anchorKey ? { anchorKey: t.anchorKey } : {}), ...(t.sourceSubject ? { sourceSubject: t.sourceSubject } : {}),
      } as WebTask);
      continue;
    }
    // Any other finished task: its conversation and board are done with; its notes/flashcards/quizzes are kept
    // (they're the student's material), its audit trail trimmed to the last few lines.
    const { chat: _c, board: _b, boardEvents: _e, ...rest } = t as WebTask & { chat?: unknown; board?: unknown; boardEvents?: unknown };
    out.push({ ...(rest as WebTask), ...(t.audit ? { audit: t.audit.slice(-3) } : {}) });
  }
  return out;
}
