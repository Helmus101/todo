import type { WebTask } from "../../../shared/types.ts";
import { FlashcardDeck } from "../../ui.tsx";
import { api } from "../../api.ts";
import { getLocalDeck } from "../../localDecks.ts";

interface FlashcardArtifactProps {
  task: WebTask;
  deckId: string;
}

// Thin wrapper over the same FlashcardDeck used elsewhere in the app (client/ui.tsx) — Study Mode
// shouldn't reimplement drilling/spaced-repetition logic, just host it on the desk.
export function FlashcardArtifact({ task, deckId }: FlashcardArtifactProps) {
  // Falls back to this browser's local backup (client/localDecks.ts) if the deck is missing from the live
  // task — a sync hiccup or brief offline gap shouldn't mean a generated deck just vanishes. Reviewing from
  // the local copy still posts to the server as usual; it just won't reflect a review made on ANOTHER
  // device until the real sync catches up (this is a local backup, not a second source of truth).
  const deck = task.flashcards?.find((f) => f.id === deckId) || getLocalDeck(deckId) || undefined;
  if (!deck) return <div className="sm-artifact-empty">This deck is no longer available.</div>;
  return (
    <div className="sm-flashcard-body">
      <FlashcardDeck
        deck={deck}
        taskId={task.id}
        onReview={(cardIndex, correct) => { void api.reviewFlashcard(task.id, deckId, cardIndex, correct).catch(() => {}); }}
      />
    </div>
  );
}
