// Hint system (spec §2.2)
// Progressive disclosure with graduated help levels
// Implements the 6-level hint system from the specification

/** Hint level from spec §2.2 */
export type HintLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A hint with its level and content */
export interface Hint {
  level: HintLevel;
  text: string;
  /** Whether this hint reveals a formula (for disclosure tracking) */
  revealsFormula?: string;
  /** Whether this hint reveals a calculation step */
  revealsStep?: boolean;
}

/** Hint strategy for a problem */
export interface HintStrategy {
  /** The problem or skill this strategy applies to */
  target: string;
  /** Progressive hints by level */
  hints: Hint[];
  /** Level at which to stop (6 = full solution) */
  maxLevel?: HintLevel;
}

/** Generate progressive hints for a linear equilibrium problem */
export function generateEquilibriumHints(givens: { Qd: string; Qs: string }): HintStrategy {
  return {
    target: "solve_linear_equilibrium",
    hints: [
      {
        level: 0,
        text: "What relationship holds at market equilibrium?",
      },
      {
        level: 1,
        text: "At equilibrium, quantity demanded equals quantity supplied. Look at the two equations you have.",
      },
      {
        level: 2,
        text: "The equilibrium condition is Q_d = Q_s. Set the two expressions equal to each other.",
        revealsFormula: "Q_d = Q_s",
      },
      {
        level: 3,
        text: `Set ${givens.Qd} = ${givens.Qs}. What do you get when you collect like terms?`,
        revealsFormula: `${givens.Qd} = ${givens.Qs}`,
      },
      {
        level: 4,
        text: "Collect the P terms on one side and the constants on the other. You should have an equation like 400 = 50P.",
        revealsStep: true,
      },
      {
        level: 5,
        text: "Divide both sides by the coefficient of P to solve for P. The calculation is 400 ÷ 50.",
        revealsStep: true,
      },
      {
        level: 6,
        text: "P = 400 ÷ 50 = 8. The equilibrium price is 8.",
        revealsStep: true,
      },
    ],
    maxLevel: 6,
  };
}

/** Generate progressive hints for a demand shift problem */
export function generateDemandShiftHints(): HintStrategy {
  return {
    target: "predict_demand_shift",
    hints: [
      {
        level: 0,
        text: "What happens to the demand curve when consumer incomes rise for a normal good?",
      },
      {
        level: 1,
        text: "Think about what 'normal good' means in economics. How does income affect demand?",
      },
      {
        level: 2,
        text: "For a normal good, higher income increases demand at each price level. The demand curve shifts.",
        revealsFormula: "Income ↑ → Demand ↑ (normal good)",
      },
      {
        level: 3,
        text: "The demand curve shifts to the right. With supply unchanged, what happens to equilibrium?",
      },
      {
        level: 4,
        text: "Rightward demand shift with unchanged supply: both equilibrium price and equilibrium quantity increase.",
      },
      {
        level: 5,
        text: "Trace the shift: new demand curve is to the right of the original. New equilibrium is at higher P and higher Q.",
      },
      {
        level: 6,
        text: "Consumer incomes rise (normal good) → demand shifts right → equilibrium price rises, equilibrium quantity rises.",
      },
    ],
    maxLevel: 6,
  };
}

/** Generate progressive hints for a supply shift problem */
export function generateSupplyShiftHints(): HintStrategy {
  return {
    target: "predict_supply_shift",
    hints: [
      {
        level: 0,
        text: "What happens to the supply curve when production costs rise?",
      },
      {
        level: 1,
        text: "Higher production costs affect producers' willingness to supply at each price level.",
      },
      {
        level: 2,
        text: "When costs rise, supply decreases at each price. The supply curve shifts.",
        revealsFormula: "Production costs ↑ → Supply ↓",
      },
      {
        level: 3,
        text: "The supply curve shifts to the left. With demand unchanged, what happens to equilibrium?",
      },
      {
        level: 4,
        text: "Leftward supply shift with unchanged demand: equilibrium price rises, but equilibrium quantity falls.",
      },
      {
        level: 5,
        text: "Trace the shift: new supply curve is to the left of the original. New equilibrium is at higher P but lower Q.",
      },
      {
        level: 6,
        text: "Production costs rise → supply shifts left → equilibrium price rises, equilibrium quantity falls.",
      },
    ],
    maxLevel: 6,
  };
}

/** Get the appropriate hint for a given level */
export function getHint(strategy: HintStrategy, level: HintLevel): Hint | null {
  const hint = strategy.hints.find(h => h.level === level);
  return hint || null;
}

/** Get all hints up to a given level (for revealing progressively) */
export function getHintsUpTo(strategy: HintStrategy, level: HintLevel): Hint[] {
  return strategy.hints.filter(h => h.level <= level);
}

/** Check if a hint level reveals a formula */
export function hintRevealsFormula(hint: Hint): boolean {
  return !!hint.revealsFormula;
}

/** Check if a hint level reveals a calculation step */
export function hintRevealsStep(hint: Hint): boolean {
  return !!hint.revealsStep;
}

/** Determine the next hint level based on current level and performance */
export function nextHintLevel(currentLevel: HintLevel, wasCorrect: boolean, consecutiveErrors: number): HintLevel {
  if (wasCorrect) {
    // Reset to level 0 after success
    return 0;
  }
  
  // Increase hint level based on consecutive errors
  if (consecutiveErrors >= 2) {
    // Jump to level 3 or higher after repeated errors
    return Math.min(currentLevel + 2, 6) as HintLevel;
  }
  
  // Normal progression
  return Math.min(currentLevel + 1, 6) as HintLevel;
}

/** Create a hint strategy for recall practice (definitions, formulas) */
export function createRecallHints(term: string, definition: string): HintStrategy {
  return {
    target: `recall_${term}`,
    hints: [
      {
        level: 0,
        text: `Can you define ${term}?`,
      },
      {
        level: 1,
        text: `Think about what ${term} means in this subject. What's the core idea?`,
      },
      {
        level: 2,
        text: `${term} relates to scarcity and choice. What specifically does it measure?`,
      },
      {
        level: 3,
        text: `The definition involves trade-offs and alternatives. What's given up when a choice is made?`,
      },
      {
        level: 4,
        text: `${term} is the value of the next-best alternative forgone when making a choice.`,
        revealsFormula: definition,
      },
      {
        level: 5,
        text: `For example: if you choose to study economics instead of computer science, the opportunity cost is the computer science education you gave up.`,
      },
      {
        level: 6,
        text: `${definition}`,
      },
    ],
    maxLevel: 6,
  };
}

/** Hint strategy registry */
const hintStrategies = new Map<string, HintStrategy>();

/** Register a hint strategy */
export function registerHintStrategy(strategy: HintStrategy): void {
  hintStrategies.set(strategy.target, strategy);
}

/** Get a hint strategy by target */
export function getHintStrategy(target: string): HintStrategy | null {
  return hintStrategies.get(target) || null;
}

/** Initialize default hint strategies */
export function initializeDefaultHintStrategies(): void {
  registerHintStrategy(generateEquilibriumHints({ Qd: "500 - 20P", Qs: "100 + 30P" }));
  registerHintStrategy(generateDemandShiftHints());
  registerHintStrategy(generateSupplyShiftHints());
  registerHintStrategy(createRecallHints("opportunity cost", "the next-best alternative forgone when a choice is made"));
  registerHintStrategy(createRecallHints("scarcity", "resources are limited relative to human wants"));
}

/** Auto-initialize default strategies */
initializeDefaultHintStrategies();
