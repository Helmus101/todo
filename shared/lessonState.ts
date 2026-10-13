// Shared lesson state (spec §14)
// Keeps the current objective, exercise, answer, board objects, and learning progress synchronized
// between the tutor, board, exercise engine, and student interactions

/** Current learning objective */
export interface LearningObjective {
  /** The subject being studied (e.g., "Economics", "Physics") */
  subject: string;
  /** The current topic (e.g., "Supply and demand") */
  topic: string;
  /** The current subtopic (e.g., "Determinants of demand") */
  subtopic?: string;
  /** The current activity type */
  activity: "explanation" | "guided_practice" | "independent_practice" | "recap" | "assessment";
  /** Progress indicator (not a percentage, but actual activity stages) */
  progress: string[];
  /** Current stage index */
  currentStage: number;
}

/** Exercise state with authoritative answer */
export interface ExerciseState {
  /** Stable exercise ID */
  id: string;
  /** Exact problem statement */
  statement: string;
  /** Input values and assumptions */
  givens: Record<string, number | string>;
  /** The requested unknown */
  unknown: string;
  /** Answer type (number, text, choice, etc.) */
  answerType: "number" | "text" | "choice" | "expression";
  /** Rounding rule (e.g., "nearest whole number") */
  rounding?: string;
  /** Unit requirements */
  unitRequired?: boolean;
  /** Expected unit if required */
  expectedUnit?: string;
  /** The authoritative mathematical result (computed, not guessed) */
  computedResult: number | string;
  /** Tolerance for numeric answers */
  tolerance?: number;
  /** Current attempt state */
  attempts: Array<{
    /** Student's submitted answer */
    answer: string;
    /** Whether it was correct according to independent verification */
    verifiedCorrect: boolean;
    /** Whether the exercise checker marked it correct */
    checkerCorrect: boolean;
    /** Timestamp */
    at: string;
    /** Discrepancy detected? */
    discrepancy?: boolean;
  }>;
  /** Current status */
  status: "unattempted" | "in_progress" | "completed" | "bypassed";
  /** The exercise's own answer key (for discrepancy detection) */
  exerciseKey?: number | string;
}

/** Skill mastery tracking */
export interface SkillState {
  /** Skill identifier (e.g., "solve_linear_equilibrium") */
  skill: string;
  /** Current mastery level */
  level: "needs_review" | "practising" | "demonstrated" | "mastered";
  /** Number of correct attempts */
  correctCount: number;
  /** Number of total attempts */
  attemptCount: number;
  /** Last practiced timestamp */
  lastPracticed?: string;
  /** Last timestamp when level changed */
  lastLevelChange?: string;
}

/** Complete lesson state */
export interface LessonState {
  /** Unique session ID */
  sessionId: string;
  /** Current learning objective */
  objective: LearningObjective;
  /** Current exercise (if any) */
  currentExercise?: ExerciseState;
  /** All exercises in this session */
  exercises: ExerciseState[];
  /** Skill mastery tracking */
  skills: Map<string, SkillState>;
  /** Current board object IDs and their revisions */
  boardObjects: Map<string, { id: string; type: string; revision: number; author: string }>;
  /** Current formula disclosure state (which formulas are visible) */
  formulaDisclosure: Set<string>;
  /** Recommended next action */
  recommendedAction?: {
    type: "explain" | "ask" | "exercise" | "hint" | "reveal" | "move_topic" | "review";
    description: string;
    target?: string;
  };
  /** Session start time */
  startedAt: string;
  /** Last updated time */
  updatedAt: string;
}

/** Create a new lesson state */
export function createLessonState(subject: string, topic: string): LessonState {
  return {
    sessionId: `session_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`,
    objective: {
      subject,
      topic,
      activity: "explanation",
      progress: ["Explanation", "Guided practice", "Independent practice", "Review"],
      currentStage: 0,
    },
    exercises: [],
    skills: new Map(),
    boardObjects: new Map(),
    formulaDisclosure: new Set(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Create an exercise state with computed answer */
export function createExerciseState(
  statement: string,
  givens: Record<string, number | string>,
  unknown: string,
  computedResult: number | string,
  options: {
    answerType?: ExerciseState["answerType"];
    rounding?: string;
    unitRequired?: boolean;
    expectedUnit?: string;
    tolerance?: number;
  } = {}
): ExerciseState {
  return {
    id: `exercise_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`,
    statement,
    givens,
    unknown,
    answerType: options.answerType || "number",
    rounding: options.rounding,
    unitRequired: options.unitRequired,
    expectedUnit: options.expectedUnit,
    computedResult,
    tolerance: options.tolerance || 0.01,
    attempts: [],
    status: "unattempted",
  };
}

/** Record an exercise attempt with verification */
export function recordExerciseAttempt(
  exercise: ExerciseState,
  studentAnswer: string,
  verifiedCorrect: boolean,
  checkerCorrect: boolean
): ExerciseState {
  const attempt = {
    answer: studentAnswer,
    verifiedCorrect,
    checkerCorrect,
    at: new Date().toISOString(),
    discrepancy: verifiedCorrect !== checkerCorrect,
  };
  
  exercise.attempts.push(attempt);
  
  if (verifiedCorrect) {
    exercise.status = "completed";
  } else {
    exercise.status = "in_progress";
  }
  
  return exercise;
}

/** Detect discrepancy between independent verification and exercise checker */
export function detectDiscrepancy(exercise: ExerciseState): { hasDiscrepancy: boolean; message?: string } {
  if (exercise.attempts.length === 0) return { hasDiscrepancy: false };
  
  const lastAttempt = exercise.attempts[exercise.attempts.length - 1];
  if (lastAttempt.discrepancy) {
    if (lastAttempt.verifiedCorrect && !lastAttempt.checkerCorrect) {
      return {
        hasDiscrepancy: true,
        message: "The independently verified solution says the answer is correct, but the exercise checker marked it wrong. The exercise's answer key appears to be incorrect.",
      };
    } else if (!lastAttempt.verifiedCorrect && lastAttempt.checkerCorrect) {
      return {
        hasDiscrepancy: true,
        message: "The exercise checker marked the answer correct, but independent verification shows it is incorrect. The exercise's answer key appears to be incorrect.",
      };
    }
  }
  
  return { hasDiscrepancy: false };
}

/** Get recommended next action based on current state */
export function getRecommendedAction(state: LessonState): LessonState["recommendedAction"] {
  // If there's a discrepancy, that's the priority
  if (state.currentExercise) {
    const discrepancy = detectDiscrepancy(state.currentExercise);
    if (discrepancy.hasDiscrepancy) {
      return {
        type: "explain",
        description: "Explain the answer-checking discrepancy and continue",
      };
    }
  }
  
  // If current exercise is in progress, focus on that
  if (state.currentExercise && state.currentExercise.status === "in_progress") {
    return {
      type: "hint",
      description: "Provide hint for current exercise",
      target: state.currentExercise.id,
    };
  }
  
  // If current exercise is completed, recommend next action
  if (state.currentExercise && state.currentExercise.status === "completed") {
    const lastAttempt = state.currentExercise.attempts[state.currentExercise.attempts.length - 1];
    if (lastAttempt.verifiedCorrect) {
      return {
        type: "exercise",
        description: "Generate next exercise with appropriate difficulty",
      };
    } else {
      return {
        type: "explain",
        description: "Explain the concept before trying another exercise",
      };
    }
  }
  
  // If no current exercise, start with explanation or exercise
  if (!state.currentExercise) {
    if (state.objective.activity === "explanation") {
      return {
        type: "ask",
        description: "Ask a focused question to assess understanding",
      };
    } else {
      return {
        type: "exercise",
        description: "Generate an appropriate exercise",
      };
    }
  }
  
  return state.recommendedAction;
}
