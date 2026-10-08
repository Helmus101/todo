import { useState } from "react";
import type { TaskProblem } from "../../shared/types.ts";
import { practiceAnswerMatches } from "../../shared/types.ts";
import { stripStrayMarkdown, useLang } from "../ui.tsx";

interface InlineProblemProps {
  problem: TaskProblem;
}

/** A single standalone practice problem rendered INLINE in the chat bubble — not a chip that opens
 *  elsewhere. The student answers right there in the thread (MCQ = pick an option, free-response = type
 *  an answer), gets immediate feedback with the explanation, and Otto stays in the conversation to help
 *  them through it. This is the "sometimes just one problem" mode — distinct from a full quiz opened on
 *  the canvas. */
export function InlineProblem({ problem }: InlineProblemProps) {
  const L = useLang();
  const isMCQ = Array.isArray(problem.options) && problem.options!.length >= 2 && typeof problem.correct === "number";
  const [picked, setPicked] = useState<number | null>(null);
  const [wrong, setWrong] = useState<number[]>([]);
  const [textAnswer, setTextAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Same lenient matcher as everywhere else ("5pi/6" = "5π/6", "7/2" = "3.5").
  const checkFreeResponse = (): boolean => !!problem.answer && practiceAnswerMatches(textAnswer, problem.answer);

  // NEVER reveals the answer (same rule as the Board): a miss says "try again"; the ✓ and the explanation
  // only appear once the student gets it right themselves.
  const answered = isMCQ ? picked !== null && picked === problem.correct : submitted && checkFreeResponse();
  const missed = !answered && (isMCQ ? wrong.length > 0 : submitted);
  const pick = (oi: number) => { if (oi === problem.correct) setPicked(oi); else setWrong((w) => [...w.filter((x) => x !== oi), oi]); };

  return (
    <div className="sm-inline-problem">
      <div className="sm-inline-problem-label">{L("Problème d'entraînement", "Practice problem")}</div>
      <div className="sm-inline-problem-q">{stripStrayMarkdown(problem.question)}</div>

      {problem.format && !answered ? (
        <div className="sm-inline-problem-format">{problem.format}</div>
      ) : null}

      {problem.hint && !answered ? (
        <div className="sm-inline-problem-hint-row">
          {showHint ? (
            <div className="sm-inline-problem-hint">{stripStrayMarkdown(problem.hint)}</div>
          ) : (
            <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => setShowHint(true)}>
              {L("Indice", "Hint")}
            </button>
          )}
        </div>
      ) : null}

      {isMCQ ? (
        <div className="sm-inline-problem-opts">
          {problem.options!.map((opt, oi) => {
            const state = answered && oi === problem.correct ? "correct" : wrong.includes(oi) ? "wrong" : "";
            return (
              <button
                key={oi}
                type="button"
                className={`quiz-opt ${state}`}
                disabled={answered || wrong.includes(oi)}
                onClick={() => pick(oi)}
              >
                <span className="quiz-opt-text">{stripStrayMarkdown(opt)}</span>
                {state === "correct" && <span className="quiz-opt-mark" aria-hidden="true">✓</span>}
                {state === "wrong" && <span className="quiz-opt-mark" aria-hidden="true">✗</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sm-inline-problem-free">
          {answered ? (
            <div className="sm-inline-problem-result correct">{L("Correct !", "Correct!")}</div>
          ) : (
            <div className="sm-inline-problem-input-row">
              <input
                type="text"
                className="sm-inline-problem-input"
                placeholder={L("Ta réponse…", "Your answer…")}
                value={textAnswer}
                onChange={e => { setTextAnswer(e.target.value); setSubmitted(false); }}
                onKeyDown={e => { if (e.key === "Enter" && textAnswer.trim()) setSubmitted(true); }}
                autoFocus
              />
              <button
                type="button"
                className="sm-btn sm-btn-primary sm-btn-sm"
                disabled={!textAnswer.trim()}
                onClick={() => setSubmitted(true)}
              >
                {L("Vérifier", "Check")}
              </button>
            </div>
          )}
        </div>
      )}

      {missed ? (
        <div className="sm-inline-problem-result wrong" role="status">
          {isMCQ ? L("Pas tout à fait — essaie une autre réponse.", "Not quite — try another option.") : L("Pas tout à fait — réessaie.", "Not quite — try again.")}
        </div>
      ) : null}
      {answered && problem.why ? (
        <div className="sm-inline-problem-why">{stripStrayMarkdown(problem.why)}</div>
      ) : null}
    </div>
  );
}
