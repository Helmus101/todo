// Local backup of every quiz Otto has ever generated for this browser — same reasoning and shape as
// localDecks.ts for flashcard decks (see that file's own header comment). Kept as a separate module/key
// rather than folded into localDecks.ts since a quiz and a deck are different content shapes reviewed by
// different components (QuizPlayer vs FlashcardDeck), even though the backup mechanics are identical.
// NOW ACCOUNT-SPECIFIC: keyed by user ID to prevent sharing across accounts.
import type { TaskQuiz } from "../shared/types.ts";

const BASE_KEY = "otto-local-quizzes";
const MAX_QUIZZES = 300;

interface StoredQuiz { taskId: string; taskTitle: string; quiz: TaskQuiz; savedAt: string; logDate?: string }

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

function readAll(userId: string | null): Record<string, StoredQuiz> {
  try {
    const raw = localStorage.getItem(getKey(userId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeAll(map: Record<string, StoredQuiz>, userId: string | null): void {
  try { localStorage.setItem(getKey(userId), JSON.stringify(map)); } catch { /* storage full/unavailable — best-effort only */ }
}

/** Clear all quizzes for a specific user (called on signout) */
export function clearLocalQuizzes(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}

/** Save (or refresh) one quiz's local copy — idempotent, cheap to call repeatedly. */
export function saveQuizLocally(taskId: string, taskTitle: string, quiz: TaskQuiz, logDate?: string, userId: string | null = null): void {
  if (!quiz?.id || !quiz.questions?.length) return;
  const map = readAll(userId);
  const existing = map[quiz.id];
  if (existing && JSON.stringify(existing.quiz) === JSON.stringify(quiz) && existing.logDate === logDate) return;
  map[quiz.id] = { taskId, taskTitle, quiz, savedAt: new Date().toISOString(), ...(logDate ? { logDate } : {}) };
  const ids = Object.keys(map);
  if (ids.length > MAX_QUIZZES) {
    for (const id of ids.sort((a, b) => Date.parse(map[a].savedAt) - Date.parse(map[b].savedAt)).slice(0, ids.length - MAX_QUIZZES)) delete map[id];
  }
  writeAll(map, userId);
}

/** Every locally-saved quiz, newest first. */
export function getAllLocalQuizzes(userId: string | null = null): StoredQuiz[] {
  return Object.values(readAll(userId)).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** One quiz by id, if this browser has ever saved it — the fallback when a quiz is missing from the
 * current task list (offline, or a sync gap) but was generated at some point on this device. */
export function getLocalQuiz(quizId: string, userId: string | null = null): TaskQuiz | null {
  return readAll(userId)[quizId]?.quiz || null;
}
