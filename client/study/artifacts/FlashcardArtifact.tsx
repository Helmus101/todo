import type { WebTask } from "../../../shared/types.ts";
import { FlashcardDeck } from "../../ui.tsx";
import { api } from "../../api.ts";

interface FlashcardArtifactProps {
  task: WebTask;
  deckId: string;
}

// Thin wrapper over the same FlashcardDeck used elsewhere in the app (client/ui.tsx) — Study Mode
// shouldn't reimplement drilling/spaced-repetition logic, just host it on the desk.
export function FlashcardArtifact({ task, deckId }: FlashcardArtifactProps) {
  const deck = task.flashcards?.find((f) => f.id === deckId);
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
