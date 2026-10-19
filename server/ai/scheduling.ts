
import type { Profile } from "../../shared/types.ts";


/** Calculate the best time to schedule a task based on focus patterns. Returns the recommended hour (0-23). */
export function calculateOptimalScheduleTime(task: { sourceSubject?: string; difficulty?: string }, profile?: Profile): number {
  if (!profile?.focusStats) return 10; // default 10am
  
  // Prefer subject-specific peak hour if available
  if (task.sourceSubject && profile.focusStats.subjectFocus) {
    const subjectData = profile.focusStats.subjectFocus[task.sourceSubject];
    if (subjectData && subjectData >= 70) {
      // If this subject has good focus, use the general peak hour
      return profile.focusStats.peakFocusHour || 10;
    }
  }
  
  // Use general peak focus hour
  return profile.focusStats.peakFocusHour || 10;
}

/** Generate a scheduling suggestion based on focus patterns. */
export function generateSchedulingSuggestion(task: { sourceSubject?: string; difficulty?: string }, profile?: Profile): string | null {
  if (!profile?.focusStats) return null;
  
  const optimalHour = calculateOptimalScheduleTime(task, profile);
  const currentHour = new Date().getHours();
  const isOptimalNow = Math.abs(currentHour - optimalHour) <= 1;
  
  if (isOptimalNow) {
    return null; // Already at optimal time
  }
  
  const en = profile.language === "en";
  const hourStr = optimalHour === 0 ? "12am" : optimalHour < 12 ? `${optimalHour}am` : optimalHour === 12 ? "12pm" : `${optimalHour - 12}pm`;
  
  if (task.sourceSubject && profile.focusStats.subjectFocus?.[task.sourceSubject]) {
    const subjectFocus = profile.focusStats.subjectFocus[task.sourceSubject];
    if (subjectFocus < 50) {
      return `This subject typically shows lower focus. Consider scheduling for ${hourStr} when your overall focus is at its peak.`;
    }
  }
  
  return `This task might be easier at ${hourStr} (your peak focus hour).`;
}

/** Recommend artifact types based on focus patterns for a subject. */
export function recommendArtifactType(subject: string, profile?: Profile): "flashcards" | "quiz" | "note" | "mixed" | null {
  if (!profile?.focusStats) return null;
  
  const subjectFocus = profile.focusStats.subjectFocus?.[subject];
  const avgBlinkRate = profile.focusStats.avgBlinkRate;
  const restlessPct = profile.focusStats.restlessPct;
  
  // High blink rate -> visual fatigue -> recommend audio or quizzes (less reading)
  if (avgBlinkRate > 30) {
    return "quiz"; // Interactive, less sustained reading
  }
  
  // High movement -> active learner -> recommend interactive formats
  if (restlessPct > 50) {
    return "quiz"; // More engaging than flashcards
  }
  
  // Low focus on this subject -> recommend simpler formats
  if (subjectFocus && subjectFocus < 50) {
    return "flashcards"; // Bite-sized, quick wins
  }
  
  // High focus on this subject -> can handle deeper formats
  if (subjectFocus && subjectFocus >= 75) {
    return "note"; // More comprehensive reference material
  }
  
  // Default to mixed approach
  return "mixed";
}
