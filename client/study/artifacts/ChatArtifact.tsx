import type { WebTask } from "../../../shared/types.ts";
import { AskOttoPanel } from "../AskOttoPanel.tsx";

interface ChatArtifactProps {
  task: WebTask;
  currentStep: { text: string } | undefined;
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  error: string | null;
  pendingMsg: string | null;
  slow: boolean;
  verySlow: boolean;
  onSend: () => void;
  onOpenNote: (id: string, title: string) => void;
  onOpenDeck: (id: string, title: string) => void;
  onOpenQuiz: (id: string, title: string) => void;
  voiceChat?: boolean;
}

// Thin wrapper, same pattern as FlashcardArtifact/QuizArtifact: hosts the existing AskOttoPanel content on
// the desk instead of reimplementing chat. The chat state itself (input/sending/history/etc.) still lives
// in StudyMode.tsx — this just threads it through ArtifactCanvas into a movable/resizable artifact instead
// of a fixed side drawer, so it can be dragged, resized, docked, or minimized like every other tool.
export function ChatArtifact(props: ChatArtifactProps) {
  return <AskOttoPanel {...props} />;
}
