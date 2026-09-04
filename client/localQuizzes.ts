// Local backup of every quiz Otto has ever generated for this browser — same reasoning and shape as
// localDecks.ts for flashcard decks (see that file's own header comment). Kept as a separate module/key
// rather than folded into localDecks.ts since a quiz and a deck are different content shapes reviewed by
// different components (QuizPlayer vs FlashcardDeck), even though the backup mechanics are identical.
import type { TaskQuiz } from "../shared/types.ts";

const KEY = "otto-local-quizzes";
const MAX_QUIZZES = 300;

interface StoredQuiz { taskId: string; taskTitle: string; quiz: TaskQuiz; savedAt: string }

function readAll(): Record<string, StoredQuiz> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeAll(map: Record<string, StoredQuiz>): void {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* storage full/unavailable — best-effort only */ }
}

/** Save (or refresh) one quiz's local copy — idempotent, cheap to call repeatedly. */
export function saveQuizLocally(taskId: string, taskTitle: string, quiz: TaskQuiz): void {
  if (!quiz?.id || !quiz.questions?.length) return;
  const map = readAll();
  const existing = map[quiz.id];
  if (existing && JSON.stringify(existing.quiz) === JSON.stringify(quiz)) return;
  map[quiz.id] = { taskId, taskTitle, quiz, savedAt: new Date().toISOString() };
  const ids = Object.keys(map);
  if (ids.length > MAX_QUIZZES) {
    for (const id of ids.sort((a, b) => Date.parse(map[a].savedAt) - Date.parse(map[b].savedAt)).slice(0, ids.length - MAX_QUIZZES)) delete map[id];
  }
  writeAll(map);
}

/** Every locally-saved quiz, newest first. */
export function getAllLocalQuizzes(): StoredQuiz[] {
  return Object.values(readAll()).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}
