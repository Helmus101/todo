import type { WebTask } from "../../../shared/types.ts";
import { QuizPlayer } from "../../ui.tsx";

interface QuizArtifactProps {
  task: WebTask;
  quizId: string;
}

// Thin wrapper over the same QuizPlayer used elsewhere in the app (client/ui.tsx) — it already records
// attempts itself via `taskId`, so Study Mode just has to host it on the desk.
export function QuizArtifact({ task, quizId }: QuizArtifactProps) {
  const quiz = task.quizzes?.find((q) => q.id === quizId);
  if (!quiz) return <div className="sm-artifact-empty">This quiz is no longer available.</div>;
  return (
    <div className="sm-quiz-body">
      <QuizPlayer quiz={quiz} taskId={task.id} />
    </div>
  );
}
