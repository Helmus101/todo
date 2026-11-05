import type { TurnOutput } from "../../shared/tutorTurn.ts";

const ANSWER_LEAK = /(?:the answer is|so the answer is|the correct (?:answer|option) is|it's option|it is option|therefore\s+(?:x|y|z|a|b|c)\s*=|thus\s+[^?!.]{0,40}=\s*[-+]?\d)/i;
const CONFIRMATION = /\b(?:you(?:'re| are) right|that is correct|correct answer|exactly right|yes, that's it)\b/i;
const QUESTION = /[?？](?:\s|$)/;

function safeQuestion(board: TurnOutput["board"]): string {
  const line = [...board].reverse().find((op) => op.text?.trim())?.text?.trim();
  return line
    ? `What part of ${line.slice(0, 100)} would you use first, and why?`
    : "What is the first relationship or idea you notice here?";
}

/** Keeps generated turns inside Otto's non-answering contract without trying to solve the student's work. */
export function enforceSocraticTurn(turn: TurnOutput): TurnOutput {
  const leaked = turn.speech.some((s) => ANSWER_LEAK.test(s) || CONFIRMATION.test(s));
  const speech = leaked
    ? ["I won't complete that step for you; let's inspect the reasoning instead.", safeQuestion(turn.board)]
    : turn.speech.slice(0, 3);
  if (!speech.some((s) => QUESTION.test(s))) speech.push(safeQuestion(turn.board));
  return { speech: speech.slice(0, 4), board: turn.board };
}
