// Thinking Moves Service - tracks reasoning moves from Primer §6.1
// Measures and tracks the child's use of thinking skills to ensure they're developing
// actual reasoning abilities, not just getting answers

import type { ThinkingStat } from "../shared/types.ts";

/**
 * All thinking moves from the Primer taxonomy (§6.1)
 */
export const THINKING_MOVES = [
  "notice",
  "wonder",
  "predict",
  "explain",
  "compare",
  "give_evidence",
  "counterexample",
  "alternative_strategy",
  "spot_error",
  "estimate",
  "perspective_taking",
  "claim_evidence_reasoning",
  "steel_manning",
  "uncertainty_calibration",
  "transfer",
  "reflect",
] as const;

export type ThinkingMove = typeof THINKING_MOVES[number];

/**
 * Record a thinking move usage
 * @param move - the thinking move used
 * @param quality - 0-2 scale (0=poor, 1=adequate, 2=excellent)
 * @param userId - the user's ID
 */
export function recordThinkingMove(move: string, quality: number, userId: string): void {
  console.log(`[Thinking] Move recorded: ${move} (quality ${quality}) for user ${userId}`);
  // In a real implementation, this would update the profile's thinkingStats
}

/**
 * Get thinking statistics for a user
 */
export function getThinkingStats(userId: string): Record<string, ThinkingStat> {
  // Placeholder - would fetch from profile
  console.log(`[Thinking] Fetching stats for user ${userId}`);
  return {};
}

/**
 * Get the next thinking move to practice
 * Ensures each session exercises at least one thinking move
 * Rotates through moves to ensure balanced development
 */
export function getNextThinkingMove(
  userId: string,
  currentStats: Record<string, ThinkingStat>,
  availableMoves: string[]
): string {
  // Simple rotation strategy: pick the least-used move
  let leastUsedMove = availableMoves[0];
  let minUsage = Infinity;

  for (const move of availableMoves) {
    const stat = currentStats[move];
    const usage = stat?.nUsed || 0;
    if (usage < minUsage) {
      minUsage = usage;
      leastUsedMove = move;
    }
  }

  return leastUsedMove;
}

/**
 * Score a thinking move quality (0-2 scale)
 * This would be called by the Verifier to evaluate child responses
 */
export function scoreThinkingMove(
  move: string,
  response: string,
  expectedQuality: string
): number {
  // Placeholder - in a real implementation, this would use an LLM judge
  // calibrated against human labels (Primer §12.3)
  console.log(`[Thinking] Scoring move ${move}: "${response}"`);
  return 1; // Default to adequate
}

/**
 * Get age-appropriate thinking moves for a given band
 * From Primer §6.1 table
 */
export function getAgeAppropriateMoves(ageBand: string): string[] {
  switch (ageBand) {
    case "A": // 0-2
    case "B": // 3-5
      return ["notice", "wonder", "predict", "show_me"];
    case "C": // 6-8
      return [
        "notice",
        "wonder",
        "predict",
        "explain",
        "compare",
        "spot_error",
        "estimate",
        "reflect",
      ];
    case "D": // 9-12
      return [
        "notice",
        "wonder",
        "predict",
        "explain",
        "compare",
        "give_evidence",
        "counterexample",
        "alternative_strategy",
        "spot_error",
        "estimate",
        "perspective_taking",
        "reflect",
      ];
    case "E": // 13-15
      return [
        "claim_evidence_reasoning",
        "counterexample",
        "steel_manning",
        "uncertainty_calibration",
        "transfer",
        "reflect",
      ];
    case "F": // 16-18
      return [
        "claim_evidence_reasoning",
        "steel_manning",
        "uncertainty_calibration",
        "transfer",
        "reflect",
      ];
    default:
      return [...THINKING_MOVES];
  }
}

/**
 * Get a thinking-move prompt for the current turn
 * Returns a prompt string for the tutor to use
 */
export function getThinkingMovePrompt(move: string): string {
  const prompts: Record<string, string> = {
    notice: "What do you notice about this?",
    wonder: "What are you curious about here?",
    predict: "What do you think will happen next? Why?",
    explain: "Can you explain how you figured that out?",
    compare: "How are these two things alike or different?",
    give_evidence: "How do you know? What makes you say that?",
    counterexample: "Can you think of a time this wouldn't work?",
    alternative_strategy: "Is there another way to solve this?",
    spot_error: "Something here might be off — can you find it?",
    estimate: "About how big should the answer be?",
    perspective_taking: "How might someone else see this?",
    claim_evidence_reasoning: "What's your claim, and what evidence supports it?",
    steel_manning: "What's the strongest case for the other side?",
    uncertainty_calibration: "How sure are you? What would change your mind?",
    transfer: "Where else would this idea work?",
    reflect: "What was tricky? What will you do differently next time?",
    show_me: "Show me what you mean.",
  };
  return prompts[move] || "What do you think?";
}

/**
 * Should use a thinking move on this turn?
 * Simple heuristic: use a move every 3-4 turns to avoid overloading
 */
export function shouldUseThinkingMove(turnCount: number): boolean {
  return turnCount % 4 === 0; // Every 4th turn
}
