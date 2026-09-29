// Tutor session summaries — kept ENTIRELY in this browser (same pattern as localChatBoard.ts: the
// content of what was said/written never reaches the cloud). Each time a student ends a tutor session,
// a short summary of what was accomplished is derived from the board entries + chat and stored here so
// the tutor can "remember" past sessions and the student can review what they've done.
import type { BoardEntry, WebTask } from "../../shared/types.ts";

export interface TutorSessionSummary {
  id: string;
  taskId: string;
  startTime: string;   // ISO
  endTime: string;      // ISO
  messageCount: number;
  boardEntries: string[];   // flat text of each board entry — the compact recap line (pastSessionsLine)
  // The FULL board (kind labels, diagrams, equations — everything BoardArtifact needs to actually re-render
  // it), not just the flattened text above. Added so ending a session doesn't reduce a worked-through
  // diagram or written-out equation down to a caption in a bullet list — the student can reopen the real
  // board exactly as it looked when the session ended. Optional or absent for a session saved before this
  // field existed (older localStorage entries) — history views must degrade to the text-only boardEntries.
  board?: BoardEntry[];
  summary: string;          // a short auto-generated recap
}

const BASE_KEY = "otto-tutor-sessions";
const CAP = 50;

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

function readAll(userId: string | null): TutorSessionSummary[] {
  try {
    const raw = localStorage.getItem(getKey(userId));
    if (raw) return JSON.parse(raw) as TutorSessionSummary[];
  } catch { /* corrupt/unavailable */ }
  return [];
}

function writeAll(list: TutorSessionSummary[], userId: string | null): void {
  try { localStorage.setItem(getKey(userId), JSON.stringify(list.slice(-CAP))); } catch { /* storage full */ }
}

/** Build a short recap string from the board + chat of a just-ended session. */
export function buildSessionSummary(board: BoardEntry[], chat: NonNullable<WebTask["chat"]>): string {
  const boardTexts = board.map((b) => b.text.trim()).filter(Boolean);
  const parts: string[] = [];
  if (boardTexts.length) {
    parts.push(boardTexts.slice(0, 8).join(" · "));
  }
  const userMsgs = chat.filter((m) => m.role === "user").length;
  if (userMsgs) parts.push(`${userMsgs} message${userMsgs > 1 ? "s" : ""}`);
  return parts.join(" — ") || "Session completed";
}

/** Save a finished session's summary. */
export function saveTutorSession(summary: TutorSessionSummary, userId: string | null = null): void {
  const list = readAll(userId);
  list.push(summary);
  writeAll(list, userId);
}

/** All past session summaries, newest first. */
export function getTutorSessions(userId: string | null = null): TutorSessionSummary[] {
  return readAll(userId).reverse();
}

/** A compact "past sessions" context line for the tutor's opening message — lets Otto reference what
 *  was previously worked on without needing a server round-trip. */
export function pastSessionsLine(sessions: TutorSessionSummary[], lang: "fr" | "en"): string {
  if (!sessions.length) return "";
  const recent = sessions.slice(0, 5);
  const topics = recent.map((s) => s.summary).filter(Boolean);
  if (!topics.length) return "";
  return lang === "en"
    ? `Previous sessions: ${topics.join(" | ")}`
    : `Sessions précédentes : ${topics.join(" | ")}`;
}

/** Called on signout — same scoping rationale as clearLocalChatBoard. */
export function clearTutorSessions(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}
