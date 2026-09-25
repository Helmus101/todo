// Per-task chat thread + Board + practice problems, kept ENTIRELY in this browser — never sent to the
// cloud account state. Direct request: "chat and board [should be] not in cloud but local" — unlike every
// other task field (steps, notes, flashcards, quizzes), which still sync across devices via the account's
// cloud row, these three never reach server/store.ts at all. The server still runs the AI call itself (it
// needs the API key, and DeepSeek is a remote model — that part can't be local), but the CONTENT of what
// was said and written never gets persisted server-side, even transiently: server/index.ts's chat route
// receives this browser's own history in the request body and returns only this turn's delta, which lands
// here, not on the account's Supabase row. That also means it doesn't follow you to another device/browser
// — the trade-off the user explicitly chose over keeping cloud sync.
// Same account-scoping pattern as localDecks.ts (keyed by userId) so signing into a different account on
// the same browser doesn't leak one student's conversations into another's.
import type { WebTask, BoardEntry, TaskProblem } from "../shared/types.ts";

type ChatMessage = NonNullable<WebTask["chat"]>[number];

interface LocalTaskThread {
  chat: ChatMessage[];
  board: BoardEntry[];
  problems: TaskProblem[];
}

const BASE_KEY = "otto-local-chat-board";
// Same caps the (formerly cloud-side) fields used — CHAT_CAP/board-cap/ARTIFACT_CAP mirrors in tasks.ts —
// so behavior (how much history survives) doesn't change just because the storage location did.
const CHAT_CAP = 40;
const BOARD_CAP = 60;
const PROBLEMS_CAP = 12;

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

function readAll(userId: string | null): Record<string, LocalTaskThread> {
  try {
    const raw = localStorage.getItem(getKey(userId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeAll(map: Record<string, LocalTaskThread>, userId: string | null): void {
  try { localStorage.setItem(getKey(userId), JSON.stringify(map)); } catch { /* storage full/unavailable — best-effort only */ }
}

/** One task's locally-stored thread — empty arrays (never undefined) so callers can spread straight onto
 *  a task object without a null check at every call site. */
export function getLocalThread(taskId: string, userId: string | null = null): LocalTaskThread {
  const t = readAll(userId)[taskId];
  return { chat: t?.chat || [], board: t?.board || [], problems: t?.problems || [] };
}

/** Overlay every task's local thread onto a freshly-fetched task list — the server stops sending fresh
 *  chat/board/problems going forward (see the route's own comment), so without this every task would
 *  render as if it had never been talked to, on every page load after the very first.
 *  ONE-TIME MIGRATION built in: an account that had real conversations before this change still has them
 *  sitting on the cloud task object for exactly one more load (the server hasn't been told to stop SENDING
 *  what it already had — only to stop WRITING new turns). If local storage has nothing yet for a task but
 *  the server response does, that's exactly that transitional case — copy it into local storage once so it
 *  survives, rather than silently losing every past conversation the moment this shipped. */
export function hydrateLocalThreads(list: WebTask[], userId: string | null = null): WebTask[] {
  const all = readAll(userId);
  let migrated = false;
  const out = list.map((t) => {
    const local = all[t.id];
    if (local?.chat?.length || local?.board?.length || local?.problems?.length) {
      return {
        ...t,
        ...(local.chat?.length ? { chat: local.chat } : {}),
        ...(local.board?.length ? { board: local.board } : {}),
        ...(local.problems?.length ? { problems: local.problems } : {}),
      };
    }
    // Nothing local yet — if the server still has legacy cloud data for this task, capture it now.
    if (t.chat?.length || t.board?.length || t.problems?.length) {
      all[t.id] = { chat: t.chat || [], board: t.board || [], problems: t.problems || [] };
      migrated = true;
    }
    return t;
  });
  if (migrated) writeAll(all, userId);
  return out;
}

/** Append this turn's new user+assistant messages, returning the updated (capped) array — call sites store
 *  the RETURN VALUE onto their in-memory task object for immediate rendering, same as the old server round
 *  trip used to provide. */
export function appendLocalChat(taskId: string, newMessages: ChatMessage[], userId: string | null = null): ChatMessage[] {
  const map = readAll(userId);
  const existing = map[taskId]?.chat || [];
  const chat = [...existing, ...newMessages].slice(-CHAT_CAP);
  map[taskId] = { chat, board: map[taskId]?.board || [], problems: map[taskId]?.problems || [] };
  writeAll(map, userId);
  return chat;
}

export function appendLocalBoard(taskId: string, newEntries: BoardEntry[], userId: string | null = null): BoardEntry[] {
  if (!newEntries.length) return getLocalThread(taskId, userId).board;
  const map = readAll(userId);
  const existing = map[taskId]?.board || [];
  const board = [...existing, ...newEntries].slice(-BOARD_CAP);
  map[taskId] = { chat: map[taskId]?.chat || [], board, problems: map[taskId]?.problems || [] };
  writeAll(map, userId);
  return board;
}

export function appendLocalProblems(taskId: string, newProblems: TaskProblem[], userId: string | null = null): TaskProblem[] {
  if (!newProblems.length) return getLocalThread(taskId, userId).problems;
  const map = readAll(userId);
  const existing = map[taskId]?.problems || [];
  const problems = [...existing, ...newProblems].slice(-PROBLEMS_CAP);
  map[taskId] = { chat: map[taskId]?.chat || [], board: map[taskId]?.board || [], problems };
  writeAll(map, userId);
  return problems;
}

/** Called on signout — this browser's local conversations belong to the account that's leaving, never the
 *  next person who signs in on the same device. */
export function clearLocalChatBoard(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}
