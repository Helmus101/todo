// Dependence Metrics Service - anti-dependence system from Primer §6.9
// Tracks help-seeking, answer-seeking, and unaided success to prevent children from
// learning to rely on the AI instead of developing independent problem-solving

import type { DependenceMetric } from "../shared/types.ts";

const DEPENDENCE_CAP = 52; // Keep one year of weekly metrics

/**
 * Get the current week identifier (ISO format: YYYY-Www)
 */
function getCurrentWeek(): string {
  const now = new Date();
  const year = now.getFullYear();
  const week = Math.ceil((now.getTime() - new Date(year, 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

/**
 * Record a hint request (child asked for help)
 */
export function recordHintRequest(domain: string, userId: string): void {
  // This would be stored in the database in a real implementation
  // For now, this is a placeholder for the API structure
  console.log(`[Dependence] Hint request recorded for user ${userId}, domain ${domain}`);
}

/**
 * Record an answer-seeking request ("just tell me")
 */
export function recordAnswerSeekRequest(domain: string, userId: string): void {
  console.log(`[Dependence] Answer-seeking recorded for user ${userId}, domain ${domain}`);
}

/**
 * Record an unaided success (child solved without help)
 */
export function recordUnaidedSuccess(domain: string, userId: string): void {
  console.log(`[Dependence] Unaided success recorded for user ${userId}, domain ${domain}`);
}

/**
 * Calculate the fade index - are hint levels trending down per skill?
 * Positive = good (fading dependence), negative = bad (increasing dependence)
 */
export function calculateFadeIndex(historicalMetrics: DependenceMetric[]): number {
  if (historicalMetrics.length < 2) return 0;

  // Simple calculation: compare current week's help ratio to previous weeks
  const current = historicalMetrics[historicalMetrics.length - 1];
  const previous = historicalMetrics[historicalMetrics.length - 2];

  if (previous.helpRatio === 0) return 0;
  return (previous.helpRatio - current.helpRatio) / previous.helpRatio;
}

/**
 * Check if dependence metrics trigger a policy adjustment
 * Returns true if the child should receive less scaffolding
 */
export function shouldFadeScaffolding(metrics: DependenceMetric[]): boolean {
  if (metrics.length < 2) return false;

  const current = metrics[metrics.length - 1];
  const fadeIndex = calculateFadeIndex(metrics);

  // Fade scaffolding if:
  // 1. Unaided success rate is high (> 0.7)
  // 2. Help-seeking is low (< 0.3)
  // 3. Answer-seeking is very low (< 0.1)
  // 4. Fade index is positive (dependence decreasing)
  return (
    current.unaidedRate > 0.7 &&
    current.helpRatio < 0.3 &&
    current.answerSeekRate < 0.1 &&
    fadeIndex > 0
  );
}

/**
 * Check if dependence metrics trigger a warning (answer-seeking spike)
 */
export function isDependenceWarning(metrics: DependenceMetric[]): boolean {
  if (metrics.length === 0) return false;

  const current = metrics[metrics.length - 1];

  // Warning if:
  // 1. Answer-seeking is high (> 0.5)
  // 2. Help-seeking is high (> 0.6)
  // 3. Unaided success is low (< 0.3)
  return (
    current.answerSeekRate > 0.5 ||
    current.helpRatio > 0.6 ||
    current.unaidedRate < 0.3
  );
}
