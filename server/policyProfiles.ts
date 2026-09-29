// Policy Profile Service - versioned age-band and level-based policies for the Primer
// Every age-sensitive behavior is a field in a Policy Profile, chosen by (ageBand, domainLevel)
// See Primer plan §4 for the full specification

export type PolicyProfile = {
  id: string;
  version: string;
  ageRange: [number, number];
  mode: {
    childFacingVoice: boolean;
    childFacingText: "full" | "limited" | "none";
    parentInLoop: "required" | "optional_summary" | "none";
    board: "none" | "guided_manipulatives" | "workspace";
  };
  session: {
    targetMinutes: number;
    hardCapMinutes: number;
    dailyCapMinutes: number;
    breakEveryMinutes: number;
  };
  voice: {
    ttsRate: number;
    maxSentenceWords: number;
    maxTurnWords: number;
    endpointing: {
      minMs: number;
      maxMs: number;
    };
    asr: {
      model: string;
      constrainedGrammarFirst: boolean;
      confirmLowConfidence: boolean;
    };
    personaStyle: "warm_playful_character" | "coach" | "socratic_partner";
  };
  pedagogy: {
    hintLadderMax: number;
    waitBeforeHintMs: number;
    directExplainAllowed: "never" | "after_2_attempts_or_confusion" | "when_stuck";
    thinkingMoves: string[];
    abstractionLevel: "concrete_pictorial_first" | "pictorial_abstract" | "abstract_first";
    praiseStyle: "process_specific" | "effort_only" | "minimal";
  };
  content: {
    readingLevelMax: string;
    storyTone: string;
    scaryContent: boolean;
    openEndedEthics: "none" | "simple_fairness_dilemmas" | "complex_dilemmas";
  };
  safety: {
    piiCollection: "none" | "minimal" | "standard";
    attachmentGuard: "strict" | "moderate" | "light";
    escalateToParentOn: string[];
    dataRetentionDays: number;
  };
  privacy: {
    consentRegime: "verifiable_parental" | "teen_consent" | "adult";
    audioStored: boolean;
  };
  approvedBy: string;
  approvedAt: string;
}

// Default policy profiles for each age band (Band C as baseline for current users)
// These are starting hypotheses from the Primer plan §4.2, should be validated with pilots
const DEFAULT_PROFILES: PolicyProfile[] = [
  {
    id: "band_6_8_v1",
    version: "1.0.0",
    ageRange: [6, 8],
    mode: {
      childFacingVoice: true,
      childFacingText: "limited",
      parentInLoop: "optional_summary",
      board: "guided_manipulatives",
    },
    session: {
      targetMinutes: 12,
      hardCapMinutes: 20,
      dailyCapMinutes: 30,
      breakEveryMinutes: 8,
    },
    voice: {
      ttsRate: 0.9,
      maxSentenceWords: 12,
      maxTurnWords: 30,
      endpointing: { minMs: 900, maxMs: 5000 },
      asr: {
        model: "child_tuned_v1",
        constrainedGrammarFirst: true,
        confirmLowConfidence: true,
      },
      personaStyle: "warm_playful_character",
    },
    pedagogy: {
      hintLadderMax: 4,
      waitBeforeHintMs: 6000,
      directExplainAllowed: "after_2_attempts_or_confusion",
      thinkingMoves: ["notice", "wonder", "predict", "explain_simply", "compare"],
      abstractionLevel: "concrete_pictorial_first",
      praiseStyle: "process_specific",
    },
    content: {
      readingLevelMax: "grade_2",
      storyTone: "gentle_adventure",
      scaryContent: false,
      openEndedEthics: "simple_fairness_dilemmas",
    },
    safety: {
      piiCollection: "none",
      attachmentGuard: "strict",
      escalateToParentOn: ["distress", "safety_disclosure"],
      dataRetentionDays: 30,
    },
    privacy: {
      consentRegime: "verifiable_parental",
      audioStored: false,
    },
    approvedBy: "system",
    approvedAt: new Date().toISOString(),
  },
  {
    id: "band_13_18_v1",
    version: "1.0.0",
    ageRange: [13, 18],
    mode: {
      childFacingVoice: true,
      childFacingText: "full",
      parentInLoop: "none",
      board: "workspace",
    },
    session: {
      targetMinutes: 25,
      hardCapMinutes: 45,
      dailyCapMinutes: 60,
      breakEveryMinutes: 15,
    },
    voice: {
      ttsRate: 1.0,
      maxSentenceWords: 25,
      maxTurnWords: 100,
      endpointing: { minMs: 500, maxMs: 3000 },
      asr: {
        model: "standard_v1",
        constrainedGrammarFirst: false,
        confirmLowConfidence: false,
      },
      personaStyle: "socratic_partner",
    },
    pedagogy: {
      hintLadderMax: 3,
      waitBeforeHintMs: 8000,
      directExplainAllowed: "when_stuck",
      thinkingMoves: ["claim_evidence_reasoning", "counterexample", "steel_manning", "uncertainty_calibration", "transfer"],
      abstractionLevel: "abstract_first",
      praiseStyle: "minimal",
    },
    content: {
      readingLevelMax: "grade_12",
      storyTone: "serious",
      scaryContent: false,
      openEndedEthics: "complex_dilemmas",
    },
    safety: {
      piiCollection: "minimal",
      attachmentGuard: "light",
      escalateToParentOn: ["safety_disclosure"],
      dataRetentionDays: 90,
    },
    privacy: {
      consentRegime: "teen_consent",
      audioStored: false,
    },
    approvedBy: "system",
    approvedAt: new Date().toISOString(),
  },
];

const PROFILES_BY_ID = new Map(DEFAULT_PROFILES.map(p => [p.id, p]));

/**
 * Calculate age from birth year
 */
export function calculateAge(birthYear: number): number {
  const currentYear = new Date().getFullYear();
  return currentYear - birthYear;
}

/**
 * Determine age band from age
 * Returns the appropriate band (A-F) based on age ranges from Primer §4.2
 */
export function getAgeBand(age: number): "A" | "B" | "C" | "D" | "E" | "F" {
  if (age < 3) return "A";  // 0-2
  if (age < 6) return "B";  // 3-5
  if (age < 9) return "C";  // 6-8
  if (age < 13) return "D"; // 9-12
  if (age < 16) return "E"; // 13-15
  return "F";              // 16-18
}

/**
 * Get the appropriate policy profile for a given age and domain level
 * Falls back to Band C (6-8) as a safe default for unknown ages
 */
export function getPolicyProfile(age: number, domainLevel?: string): PolicyProfile {
  // For now, use age-based selection. In full implementation, would blend based on domain level
  if (age >= 13 && age <= 18) {
    return PROFILES_BY_ID.get("band_13_18_v1")!;
  }
  // Default to Band C (6-8) for ages 6-12 and as fallback
  return PROFILES_BY_ID.get("band_6_8_v1")!;
}

/**
 * Get policy profile from birth year
 */
export function getPolicyProfileFromBirthYear(birthYear: number): PolicyProfile {
  const age = calculateAge(birthYear);
  return getPolicyProfile(age);
}

/**
 * Get all available policy profiles (for admin/management interfaces)
 */
export function getAllPolicyProfiles(): PolicyProfile[] {
  return DEFAULT_PROFILES;
}

/**
 * Check if a policy profile exists by ID
 */
export function policyProfileExists(id: string): boolean {
  return PROFILES_BY_ID.has(id);
}

/**
 * Get a specific policy profile by ID
 */
export function getPolicyProfileById(id: string): PolicyProfile | undefined {
  return PROFILES_BY_ID.get(id);
}
