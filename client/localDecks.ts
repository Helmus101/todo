// Local backup of every flashcard deck Otto has ever generated for this browser — separate from
// FlashcardDeck's own localStorage use (client/ui.tsx's `otto-deck:${id}`, which only stores REVIEW
// PROGRESS: which card you're on, right/wrong so far). This stores the deck's actual CONTENT (title,
// cards), so a generated deck survives even if it's ever missing from a server response (a sync hiccup, a
// task that got pruned/merged away, briefly offline) instead of just disappearing. Decks are small (capped
// at 50 cards per deck, ARTIFACT_CAP=12 decks per task) so plain localStorage — not IndexedDB — is fine.
// NOW ACCOUNT-SPECIFIC: keyed by user ID to prevent sharing across accounts.
import type { TaskFlashcards } from "../shared/types.ts";

const BASE_KEY = "otto-local-decks";
// Bounded so a very active account's local cache can't grow forever — oldest-saved decks get evicted first.
const MAX_DECKS = 300;

interface StoredDeck { taskId: string; taskTitle: string; deck: TaskFlashcards; savedAt: string; logDate?: string }

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

function readAll(userId: string | null): Record<string, StoredDeck> {
  try {
    const raw = localStorage.getItem(getKey(userId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeAll(map: Record<string, StoredDeck>, userId: string | null): void {
  try { localStorage.setItem(getKey(userId), JSON.stringify(map)); } catch { /* storage full/unavailable — best-effort only */ }
}

/** Clear all decks for a specific user (called on signout) */
export function clearLocalDecks(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}

/** Save (or refresh) one deck's local copy — idempotent, cheap to call repeatedly (e.g. on every task-list
 *  update); a deck already saved with identical content is a no-op write. */
export function saveDeckLocally(taskId: string, taskTitle: string, deck: TaskFlashcards, logDate?: string, userId: string | null = null): void {
  if (!deck?.id || !deck.cards?.length) return;
  const map = readAll(userId);
  const existing = map[deck.id];
  // Same content already saved — skip the write (this runs on every task-list change, so most calls are
  // re-saving something unchanged).
  if (existing && JSON.stringify(existing.deck) === JSON.stringify(deck) && existing.logDate === logDate) return;
  map[deck.id] = { taskId, taskTitle, deck, savedAt: new Date().toISOString(), ...(logDate ? { logDate } : {}) };
  const ids = Object.keys(map);
  if (ids.length > MAX_DECKS) {
    // Evict the oldest-saved entries first (bounded growth, not a strict LRU — good enough for a backup cache).
    for (const id of ids.sort((a, b) => Date.parse(map[a].savedAt) - Date.parse(map[b].savedAt)).slice(0, ids.length - MAX_DECKS)) delete map[id];
  }
  writeAll(map, userId);
}

/** Every locally-saved deck, newest first — for a "your flashcards" offline/backup view. */
export function getAllLocalDecks(userId: string | null = null): StoredDeck[] {
  return Object.values(readAll(userId)).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** One deck by id, if this browser has ever saved it — the fallback when a deck is missing from the
 * current task list (offline, or a sync gap) but was generated at some point on this device. */
export function getLocalDeck(deckId: string, userId: string | null = null): TaskFlashcards | null {
  return readAll(userId)[deckId]?.deck || null;
}
