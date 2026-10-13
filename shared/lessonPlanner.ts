// Lesson planner (spec §9)
// Creates lesson sequences from student goals and adapts based on performance
// Implements proactive teaching where Otto drives the lesson forward

/** A single lesson topic with subtopics */
export interface LessonTopic {
  /** Topic identifier */
  id: string;
  /** Topic name */
  name: string;
  /** Subtopics within this topic */
  subtopics: LessonSubtopic[];
  /** Estimated time in minutes */
  estimatedTime: number;
  /** Prerequisite topics */
  prerequisites?: string[];
  /** Whether this topic is optional: plan generation marks some topics optional and
   *  advanceLesson() skips them when time is short or the student wants to focus. */
  optional?: boolean;
}

/** A subtopic with specific skills to practice */
export interface LessonSubtopic {
  /** Subtopic identifier */
  id: string;
  /** Subtopic name */
  name: string;
  /** Skills to be practiced in this subtopic */
  skills: string[];
  /** Estimated time in minutes */
  estimatedTime: number;
  /** Whether this subtopic is optional */
  optional?: boolean;
}

/** A complete lesson plan */
export interface LessonPlan {
  /** Subject (e.g., "Economics", "Physics") */
  subject: string;
  /** Student's goal (e.g., "Revise for exam", "Learn supply and demand") */
  goal: string;
  /** Topics in order */
  topics: LessonTopic[];
  /** Current topic index */
  currentTopicIndex: number;
  /** Current subtopic index within the topic */
  currentSubtopicIndex: number;
  /** Created timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
}

/** Activity type for the next step */
export type ActivityType = "explain" | "guided_practice" | "independent_practice" | "conceptual" | "graphical" | "applied" | "recall" | "assessment";

/** Recommended next activity */
export interface NextActivity {
  type: ActivityType;
  topic: string;
  subtopic: string;
  skill?: string;
  description: string;
  difficulty: "recognize" | "apply" | "connect" | "reason" | "transfer";
}

/** Create a lesson plan for economics (example from spec) */
export function createEconomicsLessonPlan(goal: string): LessonPlan {
  const topics: LessonTopic[] = [
    {
      id: "demand_supply_fundamentals",
      name: "Demand and supply fundamentals",
      subtopics: [
        {
          id: "demand_definition",
          name: "Definition of demand",
          skills: ["define_demand", "identify_demand_curve"],
          estimatedTime: 10,
        },
        {
          id: "supply_definition",
          name: "Definition of supply",
          skills: ["define_supply", "identify_supply_curve"],
          estimatedTime: 10,
        },
        {
          id: "market_equilibrium",
          name: "Market equilibrium",
          skills: ["identify_equilibrium", "explain_equilibrium_concept"],
          estimatedTime: 15,
        },
      ],
      estimatedTime: 35,
    },
    {
      id: "determinants",
      name: "Determinants of demand and supply",
      subtopics: [
        {
          id: "demand_determinants",
          name: "Determinants of demand",
          skills: ["identify_demand_determinants", "predict_demand_shift"],
          estimatedTime: 20,
        },
        {
          id: "supply_determinants",
          name: "Determinants of supply",
          skills: ["identify_supply_determinants", "predict_supply_shift"],
          estimatedTime: 20,
        },
      ],
      estimatedTime: 40,
    },
    {
      id: "equilibrium_calculations",
      name: "Market equilibrium calculations",
      subtopics: [
        {
          id: "linear_equilibrium",
          name: "Linear equilibrium equations",
          skills: ["solve_linear_equilibrium", "calculate_equilibrium_price", "calculate_equilibrium_quantity"],
          estimatedTime: 25,
        },
      ],
      estimatedTime: 25,
    },
    {
      id: "equilibrium_shifts",
      name: "Shifts in equilibrium",
      subtopics: [
        {
          id: "demand_shift_analysis",
          name: "Demand shift analysis",
          skills: ["analyze_demand_shift_effect", "predict_price_quantity_change"],
          estimatedTime: 20,
        },
        {
          id: "supply_shift_analysis",
          name: "Supply shift analysis",
          skills: ["analyze_supply_shift_effect", "predict_price_quantity_change"],
          estimatedTime: 20,
        },
      ],
      estimatedTime: 40,
    },
    {
      id: "price_controls",
      name: "Price ceilings, floors, and shortages/surpluses",
      subtopics: [
        {
          id: "price_ceilings",
          name: "Price ceilings and shortages",
          skills: ["explain_price_ceiling", "calculate_shortage"],
          estimatedTime: 15,
        },
        {
          id: "price_floors",
          name: "Price floors and surpluses",
          skills: ["explain_price_floor", "calculate_surplus"],
          estimatedTime: 15,
        },
      ],
      estimatedTime: 30,
      optional: true,
    },
    {
      id: "definitions_applications",
      name: "Definitions and real-world applications",
      subtopics: [
        {
          id: "key_definitions",
          name: "Key economic definitions",
          skills: ["define_scarcity", "define_opportunity_cost", "distinguish_concepts"],
          estimatedTime: 15,
        },
        {
          id: "real_world_applications",
          name: "Real-world market applications",
          skills: ["apply_concepts_to_markets", "analyze_real_world_cases"],
          estimatedTime: 20,
        },
      ],
      estimatedTime: 35,
    },
    {
      id: "exam_practice",
      name: "Mixed exam-style practice",
      subtopics: [
        {
          id: "mixed_questions",
          name: "Mixed problem types",
          skills: ["solve_mixed_problems", "apply_multiple_concepts"],
          estimatedTime: 30,
        },
      ],
      estimatedTime: 30,
    },
  ];

  return {
    subject: "Economics",
    goal,
    topics,
    currentTopicIndex: 0,
    currentSubtopicIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Get the current topic and subtopic from the plan */
export function getCurrentTopic(plan: LessonPlan): { topic: LessonTopic; subtopic: LessonSubtopic } | null {
  if (plan.currentTopicIndex >= plan.topics.length) return null;
  const topic = plan.topics[plan.currentTopicIndex];
  if (plan.currentSubtopicIndex >= topic.subtopics.length) return null;
  const subtopic = topic.subtopics[plan.currentSubtopicIndex];
  return { topic, subtopic };
}

/** Advance to the next subtopic or topic */
export function advanceLesson(plan: LessonPlan): LessonPlan {
  const current = getCurrentTopic(plan);
  if (!current) return plan; // Already at end

  const { topic, subtopic } = current;
  
  // Check if there are more subtopics in current topic
  if (plan.currentSubtopicIndex < topic.subtopics.length - 1) {
    plan.currentSubtopicIndex++;
  } else {
    // Move to next topic
    plan.currentTopicIndex++;
    plan.currentSubtopicIndex = 0;
    
    // Skip optional topics if we're running short on time or if student wants focus
    while (plan.currentTopicIndex < plan.topics.length && plan.topics[plan.currentTopicIndex].optional) {
      plan.currentTopicIndex++;
      plan.currentSubtopicIndex = 0;
    }
  }
  
  plan.updatedAt = new Date().toISOString();
  return plan;
}

/** Recommend the next activity based on current state and performance */
export function recommendNextActivity(
  plan: LessonPlan,
  skillStates: Map<string, { level: string; correctCount: number; attemptCount: number }>,
  recentPerformance: "strong" | "mixed" | "weak"
): NextActivity {
  const current = getCurrentTopic(plan);
  if (!current) {
    return {
      type: "assessment",
      topic: "Review",
      subtopic: "Overall",
      description: "Complete lesson - mixed exam-style practice",
      difficulty: "transfer",
    };
  }

  const { topic, subtopic } = current;
  
  // Check if any skills in current subtopic need more practice
  const skillsNeedingPractice = subtopic.skills.filter(
    skill => {
      const state = skillStates.get(skill);
      return !state || state.level === "needs_review" || (state.attemptCount < 3 && state.correctCount / state.attemptCount < 0.7);
    }
  );

  if (skillsNeedingPractice.length > 0) {
    // Still practicing current subtopic
    const skill = skillsNeedingPractice[0];
    return {
      type: recentPerformance === "weak" ? "guided_practice" : "independent_practice",
      topic: topic.name,
      subtopic: subtopic.name,
      skill,
      description: `Practice ${skill} - ${recentPerformance === "weak" ? "guided" : "independent"} practice`,
      difficulty: "apply",
    };
  }

  // All skills in current subtopic demonstrated
  if (recentPerformance === "strong") {
    // Move to next activity type within same subtopic
    const currentType = skillStates.get(subtopic.skills[0])?.level === "demonstrated" ? "independent_practice" : "guided_practice";
    
    if (currentType === "independent_practice") {
      // Try conceptual or graphical application
      if (subtopic.name.includes("shift") || subtopic.name.includes("determinants")) {
        return {
          type: "graphical",
          topic: topic.name,
          subtopic: subtopic.name,
          description: "Apply concepts graphically - predict curve shifts and equilibrium changes",
          difficulty: "connect",
        };
      }
      if (subtopic.name.includes("definition")) {
        return {
          type: "recall",
          topic: topic.name,
          subtopic: subtopic.name,
          description: "Test recall of key definitions",
          difficulty: "recognize",
        };
      }
      // Move to next subtopic
      advanceLesson(plan);
      return recommendNextActivity(plan, skillStates, recentPerformance);
    }
    
    return {
      type: "conceptual",
      topic: topic.name,
      subtopic: subtopic.name,
      description: "Explain the conceptual reasoning behind the calculation",
      difficulty: "reason",
    };
  }

  if (recentPerformance === "mixed") {
    return {
      type: "guided_practice",
      topic: topic.name,
      subtopic: subtopic.name,
      description: "Continue guided practice to solidify understanding",
      difficulty: "apply",
    };
  }

  // Default: independent practice
  return {
    type: "independent_practice",
    topic: topic.name,
    subtopic: subtopic.name,
    description: "Practice independently to check understanding",
    difficulty: "apply",
  };
}

/** Create a lesson plan from a student's goal statement */
export function createLessonPlanFromGoal(goal: string, subject?: string): LessonPlan {
  const lowerGoal = goal.toLowerCase();
  
  // Detect subject from goal if not provided
  const detectedSubject = subject || detectSubject(goal);
  
  if (detectedSubject === "economics") {
    return createEconomicsLessonPlan(goal);
  }
  
  // Generic lesson plan for other subjects
  return {
    subject: detectedSubject,
    goal,
    topics: [
      {
        id: "fundamentals",
        name: "Fundamentals",
        subtopics: [
          {
            id: "basic_concepts",
            name: "Basic concepts",
            skills: ["understand_basics"],
            estimatedTime: 15,
          },
        ],
        estimatedTime: 15,
      },
    ],
    currentTopicIndex: 0,
    currentSubtopicIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Detect subject from goal statement */
function detectSubject(goal: string): string {
  const lower = goal.toLowerCase();
  
  if (lower.includes("economics") || lower.includes("supply") || lower.includes("demand") || lower.includes("equilibrium") || lower.includes("market")) {
    return "Economics";
  }
  if (lower.includes("physics") || lower.includes("force") || lower.includes("energy") || lower.includes("motion")) {
    return "Physics";
  }
  if (lower.includes("math") || lower.includes("algebra") || lower.includes("calculus") || lower.includes("equation")) {
    return "Mathematics";
  }
  if (lower.includes("chemistry") || lower.includes("reaction") || lower.includes("molecule")) {
    return "Chemistry";
  }
  
  return "General";
}

/** Check if a lesson plan is complete */
export function isLessonComplete(plan: LessonPlan): boolean {
  return plan.currentTopicIndex >= plan.topics.length;
}

/** Get lesson progress percentage (for display only, not for decisions) */
export function getLessonProgress(plan: LessonPlan): number {
  let totalSubtopics = 0;
  let completedSubtopics = 0;
  
  for (let i = 0; i < plan.topics.length; i++) {
    const topic = plan.topics[i];
    for (let j = 0; j < topic.subtopics.length; j++) {
      totalSubtopics++;
      if (i < plan.currentTopicIndex || (i === plan.currentTopicIndex && j < plan.currentSubtopicIndex)) {
        completedSubtopics++;
      }
    }
  }
  
  return totalSubtopics > 0 ? Math.round((completedSubtopics / totalSubtopics) * 100) : 0;
}

/** Generate a compact lesson plan summary for the board */
export function generateLessonPlanSummary(plan: LessonPlan): string {
  const current = getCurrentTopic(plan);
  if (!current) return "Lesson complete";
  
  const { topic, subtopic } = current;
  const progress = getLessonProgress(plan);
  
  return `${plan.subject} → ${topic.name} → ${subtopic.name}\nProgress: ${progress}%`;
}
