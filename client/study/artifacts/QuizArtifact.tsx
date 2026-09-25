import type { WebTask } from "../../../shared/types.ts";
import { QuizPlayer, useLang } from "../../ui.tsx";
import { getLocalQuiz } from "../../localQuizzes.ts";

interface QuizArtifactProps {
  task: WebTask;
  quizId: string;
  userId: string | null;
}

// Thin wrapper over the same QuizPlayer used elsewhere in the app (client/ui.tsx) — it already records
// attempts itself via `taskId`, so Study Mode just has to host it on the desk.
export function QuizArtifact({ task, quizId, userId }: QuizArtifactProps) {
  const L = useLang();
  const quiz = task.quizzes?.find((q) => q.id === quizId) || getLocalQuiz(quizId, userId);
  if (!quiz) return <div className="sm-artifact-empty">{L("Ce quiz n'est plus disponible.", "This quiz is no longer available.")}</div>;
  return (
    <div className="sm-quiz-body">
      <QuizPlayer quiz={quiz} taskId={task.id} />
    </div>
  );
}
