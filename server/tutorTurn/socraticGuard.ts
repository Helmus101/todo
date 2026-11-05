import type { TurnOutput } from "../../shared/tutorTurn.ts";

const ANSWER_LEAK = /(?:the answer is|so the answer is|the correct (?:answer|option) is|it's option|it is option)\b/i;
const CONFIRMATION = /\b(?:you(?:'re| are) right|that is correct|correct answer|yes, that's it)\b/i;

/** A narrow safety boundary, not a tutor personality: preserve the model's natural pacing unless it clearly leaks an answer. */
export function enforceSocraticTurn(turn: TurnOutput): TurnOutput {
  if (!turn.speech.some((sentence) => ANSWER_LEAK.test(sentence) || CONFIRMATION.test(sentence))) return turn;
  const speech = turn.speech.map((sentence) =>
    ANSWER_LEAK.test(sentence) || CONFIRMATION.test(sentence)
      ? "Let's check that reasoning together without jumping to the result."
      : sentence,
  );
  return { ...turn, speech };
}
