import type { TurnOutput } from "../../shared/tutorTurn.ts";

const ANSWER_LEAK = /(?:the answer is|so the answer is|the correct (?:answer|option) is|it's option|it is option|the work done .* is equal to|therefore .*\bis\b|which is\s+[-+]?\d)/i;
const CONFIRMATION = /\b(?:you(?:'re| are) right|that is correct|correct answer|yes, that's it)\b/i;

/** A narrow safety boundary, not a tutor personality: preserve natural pacing unless the turn clearly leaks or repeats an answer. */
export function enforceSocraticTurn(turn: TurnOutput): TurnOutput {
  const seen = new Set<string>();
  const speech = turn.speech.filter((sentence) => {
    const key = sentence.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const leaked = speech.some((sentence) => ANSWER_LEAK.test(sentence) || CONFIRMATION.test(sentence));
  if (!leaked) return { ...turn, speech };
  return {
    ...turn,
    speech: speech.map((sentence) =>
      ANSWER_LEAK.test(sentence) || CONFIRMATION.test(sentence)
        ? "Let's check that reasoning together without jumping to the result."
        : sentence,
    ),
  };
}
