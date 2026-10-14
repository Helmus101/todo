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
import type { WebTask, BoardEntry, TaskProblem, TaskObjective } from "../shared/types.ts";

type ChatMessage = NonNullable<WebTask["chat"]>[number];

interface LocalTaskThread {
  chat: ChatMessage[];
  board: BoardEntry[];
  problems: TaskProblem[];
  objectives: TaskObjective[];
}

const BASE_KEY = "otto-local-chat-board";
// Same caps the (formerly cloud-side) fields used (server/index.ts's own CHAT_CAP=60, the old board cap of
// 60, tasks.ts's ARTIFACT_CAP=12 for problems) — how much history survives shouldn't shrink just because
// the storage location did. CHAT_CAP here was briefly 40 (a copy-paste guess, never actually matched the
// server's 60) — a real regression that trimmed more aggressively than before and read as "chat deletes
// itself" on any longer-running conversation.
// Kept long on purpose: this is the student's own on-device transcript (the Chat drawer shows ALL of it); the
// server only ever receives the last 60 messages of it per turn.
const CHAT_CAP = 400;
// The board is the student's paper: it only grows. Caps are a far-off safety net, not a working limit
// (60 used to silently drop the oldest lines of a long session).
const BOARD_CAP = 500;
const PROBLEMS_CAP = 100;

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

// In-memory mirror, keyed the same as localStorage. Exists because `readAll` used to fall back to `{}` on
// ANY failure — a quota-exceeded write (Safari private browsing caps localStorage hard, or a long-running
// account simply accumulates enough decks/quizzes/chat across many tasks to hit the ~5-10MB per-origin
// limit) meant the NEXT read after a failed write saw nothing, which read as "chat deletes itself" with no
// error ever surfacing. This mirror survives for the life of the tab even when disk writes are failing, so
// a quota/private-mode failure degrades to "doesn't survive a reload" instead of "vanishes immediately."
const memory = new Map<string, Record<string, LocalTaskThread>>();

function readAll(userId: string | null): Record<string, LocalTaskThread> {
  const key = getKey(userId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) { const parsed = JSON.parse(raw); memory.set(key, parsed); return parsed; }
  } catch { /* corrupt/unavailable — fall through to memory mirror below */ }
  return memory.get(key) || {};
}

function lastActivity(t: LocalTaskThread): number {
  const stamps = [...(t.chat || []), ...(t.board || [])].map((x) => Date.parse((x as { at?: string }).at || "") || 0);
  return stamps.length ? Math.max(...stamps) : 0;
}

/** Persist. When storage is full, make room by dropping the least-recently-used OTHER tasks' threads —
 *  never the thread being written — so the current board is never the thing that gets lost. */
function writeAll(map: Record<string, LocalTaskThread>, userId: string | null, keepTaskId?: string): void {
  const key = getKey(userId);
  memory.set(key, map); // always succeeds — the durable fallback when disk fails
  const evictable = Object.keys(map).filter((id) => id !== keepTaskId).sort((a, b) => lastActivity(map[a]) - lastActivity(map[b]));
  for (let attempt = 0; ; attempt++) {
    try { localStorage.setItem(key, JSON.stringify(map)); return; } catch {
      const victim = evictable.shift();
      if (!victim) return; // nothing else to drop — the memory mirror still has it for this tab
      delete map[victim];
    }
  }
}

/** One task's locally-stored thread — empty arrays (never undefined) so callers can spread straight onto
 *  a task object without a null check at every call site. */
export function getLocalThread(taskId: string, userId: string | null = null): LocalTaskThread {
  const t = readAll(userId)[taskId];
  return { chat: t?.chat || [], board: t?.board || [], problems: t?.problems || [], objectives: t?.objectives || [] };
}

/** Overlay every task's local thread onto a freshly-fetched task list. THIS BROWSER IS THE RECORD OF TRUTH
 *  for a tutor session's chat/board/problems/objectives: the server writes none of them any more (see the
 *  file header), so its response is empty for exactly the fields that matter and a session would render as
 *  if it had never been talked to — on every load, and on every resume.
 *
 *  LOCAL WINS whenever it has anything; the cloud copy (still present on an account that predates the change,
 *  because the server has only stopped WRITING new turns) fills in only when local storage is empty for that
 *  field. That direction is also the one-time migration: the first tutor turn after this ships persists the
 *  merged thread locally from the hydrated task, so a pre-change conversation is carried into local storage
 *  instead of vanishing the moment the cloud copy is cleared. */
export function hydrateLocalThreads(list: WebTask[], userId: string | null = null): WebTask[] {
  const all = readAll(userId);
  return list.map((t) => { const local = all[t.id]; return local ? overlayLocalThread(t, local) : t; });
}

/** ONE task's local copy laid over the server's row — the precedence rule on its own, so it can be tested
 *  without storage (and so "Reprendre" can never silently go back to reading the empty cloud fields).
 *  LOCAL WINS for every field it actually has; a field local storage is empty for keeps what the server
 *  sent (a conversation from before the local switch). Pure; exported for tests. */
export function overlayLocalThread(task: WebTask, local: LocalTaskThread): WebTask {
  const chat = local.chat?.length ? local.chat : undefined;
  const board = local.board?.length ? local.board : undefined;
  const problems = local.problems?.length ? local.problems : undefined;
  const objectives = local.objectives?.length ? local.objectives : undefined;
  if (!chat && !board && !problems && !objectives) return task;
  return {
    ...task,
    ...(chat ? { chat } : {}),
    ...(board ? { board } : {}),
    ...(problems ? { problems } : {}),
    ...(objectives ? { objectives } : {}),
  };
}

/** Append this turn's new user+assistant messages, returning the updated (capped) array — call sites store
 *  the RETURN VALUE onto their in-memory task object for immediate rendering, same as the old server round
 *  trip used to provide. */
export function appendLocalChat(taskId: string, newMessages: ChatMessage[], userId: string | null = null): ChatMessage[] {
  const map = readAll(userId);
  const existing = map[taskId]?.chat || [];
  const chat = [...existing, ...newMessages].slice(-CHAT_CAP);
  map[taskId] = { chat, board: map[taskId]?.board || [], problems: map[taskId]?.problems || [], objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return chat;
}

export function appendLocalBoard(taskId: string, newEntries: BoardEntry[], userId: string | null = null): BoardEntry[] {
  if (!newEntries.length) return getLocalThread(taskId, userId).board;
  const map = readAll(userId);
  const existing = map[taskId]?.board || [];
  const board = [...existing, ...newEntries].slice(-BOARD_CAP);
  map[taskId] = { chat: map[taskId]?.chat || [], board, problems: map[taskId]?.problems || [], objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return board;
}

export function appendLocalProblems(taskId: string, newProblems: TaskProblem[], userId: string | null = null): TaskProblem[] {
  if (!newProblems.length) return getLocalThread(taskId, userId).problems;
  const map = readAll(userId);
  const existing = map[taskId]?.problems || [];
  const problems = [...existing, ...newProblems].slice(-PROBLEMS_CAP);
  map[taskId] = { chat: map[taskId]?.chat || [], board: map[taskId]?.board || [], problems, objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return problems;
}

/** Replaces the WHOLE objectives list (SET_OBJECTIVES' own contract — the model always sends the full
 *  current list, never a delta), unlike the append* functions above which grow their array. */
export function setLocalObjectives(taskId: string, objectives: TaskObjective[], userId: string | null = null): TaskObjective[] {
  const map = readAll(userId);
  map[taskId] = { chat: map[taskId]?.chat || [], board: map[taskId]?.board || [], problems: map[taskId]?.problems || [], objectives };
  writeAll(map, userId, taskId);
  return objectives;
}

/** Replaces the WHOLE board/problems arrays with an already-merged result (the caller has already applied
 *  in-place edits/removals/clear and deduped against what's on screen — see TutorSession.tsx's send()) —
 *  unlike appendLocalBoard/appendLocalProblems above, which only ever grow their array and can't express a
 *  clear or an in-place correction. Still capped, same reasoning as the append versions. */
export function setLocalBoard(taskId: string, board: BoardEntry[], userId: string | null = null): BoardEntry[] {
  const capped = board.slice(-BOARD_CAP);
  const map = readAll(userId);
  map[taskId] = { chat: map[taskId]?.chat || [], board: capped, problems: map[taskId]?.problems || [], objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return capped;
}
/** Replaces the WHOLE chat array with an already-merged result — the same contract as setLocalBoard/
 *  setLocalProblems above, and the same reason: appendLocalChat appends to whatever is ALREADY IN LOCAL
 *  STORAGE, so for a thread this browser has no local copy of yet (a session resumed from the cloud era, or
 *  a second tab) it returned only the new delta — and the caller then stored that onto the in-memory task,
 *  visibly dropping every earlier message mid-conversation. The chat that belongs on screen is
 *  [...what's on screen, ...this turn's delta], which only the caller knows. */
export function setLocalChat(taskId: string, chat: ChatMessage[], userId: string | null = null): ChatMessage[] {
  const capped = chat.slice(-CHAT_CAP);
  const map = readAll(userId);
  map[taskId] = { chat: capped, board: map[taskId]?.board || [], problems: map[taskId]?.problems || [], objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return capped;
}

export function setLocalProblems(taskId: string, problems: TaskProblem[], userId: string | null = null): TaskProblem[] {
  const capped = problems.slice(-PROBLEMS_CAP);
  const map = readAll(userId);
  map[taskId] = { chat: map[taskId]?.chat || [], board: map[taskId]?.board || [], problems: capped, objectives: map[taskId]?.objectives || [] };
  writeAll(map, userId, taskId);
  return capped;
}

/** Called on signout — this browser's local conversations belong to the account that's leaving, never the
 *  next person who signs in on the same device. */
export function clearLocalChatBoard(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}
