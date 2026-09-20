import { useState } from "react";
import type { TaskProblem } from "../../shared/types.ts";
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
  const [textAnswer, setTextAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Free-response check: trimmed, case-insensitive comparison
  const checkFreeResponse = (): boolean => {
    if (!problem.answer) return false;
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return normalize(textAnswer) === normalize(problem.answer);
  };

  const isCorrect = isMCQ ? picked === problem.correct : submitted ? checkFreeResponse() : false;
  const answered = isMCQ ? picked !== null : submitted;

  return (
    <div className="sm-inline-problem">
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
            const state = !answered ? "" : oi === problem.correct ? "correct" : oi === picked ? "wrong" : "";
            return (
              <button
                key={oi}
                type="button"
                className={`quiz-opt ${state}`}
                disabled={answered}
                onClick={() => setPicked(oi)}
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
          {submitted ? (
            <div className={`sm-inline-problem-result ${isCorrect ? "correct" : "wrong"}`}>
              {isCorrect
                ? L("Correct !", "Correct!")
                : L(`Non — la réponse était : ${problem.answer}`, `Not quite — the answer was: ${problem.answer}`)}
            </div>
          ) : (
            <div className="sm-inline-problem-input-row">
              <input
                type="text"
                className="sm-inline-problem-input"
                placeholder={L("Ta réponse…", "Your answer…")}
                value={textAnswer}
                onChange={e => setTextAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && textAnswer.trim()) setSubmitted(true); }}
                disabled={submitted}
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

      {answered && problem.why ? (
        <div className="sm-inline-problem-why">{stripStrayMarkdown(problem.why)}</div>
      ) : null}
    </div>
  );
}
