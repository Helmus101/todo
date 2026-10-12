// Calculation engine integration (spec §2.5)
// Connects the arithmetic and math expression modules with the board state engine
// for deterministic validation and dependency tracking
// This module is self-contained to avoid server dependencies in the shared module

import { compileExpr } from "./mathExpr.ts";
import type { Engine } from "./boardState.ts";

// Simple number parser (subset of server/arithmetic.ts)
function parseNumber(raw: string): number | null {
  let s = raw.trim()
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/^(?:€|\$|£)/, "")
    .replace(/(?:%|°[CF]?|kg|km|cm|mm|€|\$|£|h|min|L|g|t|m|s)$/i, "")
    .trim();
  if (!s) return null;
  
  // Handle scientific notation
  const sci = s.match(/^([\d.,]+(?: [\d.,]+)*)\s*(?:[eE]|×\s*10\s*\^?)\s*(-?\d+)$/);
  if (sci) {
    const mantissa = parseGrouped(sci[1].replace(/ /g, ""));
    return mantissa == null ? null : mantissa * Math.pow(10, parseInt(sci[2], 10));
  }
  return parseGrouped(s);
}

function parseGrouped(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  
  // EN comma grouping (1,234.5)
  if (/,/.test(s) && !/\./.test(s)) {
    s = s.replace(/,/g, ".");
  } else if (/,/.test(s) && /\./.test(s)) {
    s = s.replace(/,/g, "");
  }
  
  // FR thin-space grouping (1 234,5)
  if (/\d \d/.test(s)) {
    if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return null;
    s = s.replace(/ /g, "").replace(/,/g, ".");
  }
  
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Evaluate one side of a claim ("3 × 47") to a number. The left side of a claim is an EXPRESSION, not a bare
// number — parseFloat("3 × 47") is 3, which would call every correct product wrong.
function evalSide(raw: string): number | null {
  const s = raw.trim();
  // A single number (possibly grouped: "1,234.5", "1 234,5") is parsed, not compiled — the compiler's
  // tokenizer reads those separators as unsupported characters.
  if (!/[+\-−–×x*·÷/]/.test(s)) return parseNumber(s);
  const compiled = compileExpr(s.replace(/×|·/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/,/g, "."), []);
  if ("error" in compiled) return null;
  const v = compiled.fn({});
  return Number.isFinite(v) ? v : null;
}

// Simple arithmetic claim finder
function findArithmeticClaims(text: string): Array<{ raw: string; left: number | null; right: number | null; mismatch: boolean }> {
  const claims: Array<{ raw: string; left: number | null; right: number | null; mismatch: boolean }> = [];
  const pattern = /((?:\d+(?:[\.,]\d+)?|\d+(?: \d{3})+)(?:\s*[+\-−–×x*·÷/]\s*(?:\d+(?:[\.,]\d+)?|\d+(?: \d{3})+))+)\s*(=|donne|fait|vaut)\s*(\d+(?:[\.,]\d+)?|\d+(?: \d{3})+)/g;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const leftVal = evalSide(match[1]);
    const rightVal = evalSide(match[3]);
    const mismatch = leftVal !== null && rightVal !== null && Math.abs(leftVal - rightVal) > 1e-9 * Math.max(1, Math.abs(leftVal), Math.abs(rightVal));
    
    claims.push({
      raw: match[0],
      left: leftVal,
      right: rightVal,
      mismatch,
    });
  }
  
  return claims;
}

/** Create a calculation engine with full validation capabilities */
export function createCalculationEngine(): Engine {
  return {
    evaluate: (expr: string) => {
      try {
        const s = String(expr).trim();
        if (!s) return null;
        // A single number (possibly grouped: "1,234.5", "1 234,5") is parsed; anything with an operator is
        // COMPILED — parseFloat("15*4") is 15, which would silently verify a wrong result.
        if (!/[+\-−–×x*·÷/]/.test(s)) return parseNumber(s);
        const compiled = compileExpr(s.replace(/×|·/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/,/g, "."), []);
        if ("error" in compiled) return null;
        const v = compiled.fn({});
        return Number.isFinite(v) ? v : null;
      } catch {
        return null;
      }
    },
    
    validateArithmetic: (claim: string) => {
      const claims = findArithmeticClaims(claim);
      if (!claims || claims.length === 0) return null;
      
      const claimResult = claims[0];
      return {
        correct: !claimResult.mismatch,
        left: claimResult.left,
        right: claimResult.right,
        mismatch: claimResult.mismatch,
      };
    },
    
    compileExpression: (expr: string, vars: string[]) => {
      return compileExpr(expr, vars);
    },
    
    now: () => new Date().toISOString(),
    
    newId: () => `calc_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`,
  };
}

/** Default engine instance */
export const defaultEngine = createCalculationEngine();

/** Evaluate an expression with the given variable values */
export function evaluateWithVars(expr: string, vars: Record<string, number>): number | null {
  const compiled = compileExpr(expr, Object.keys(vars));
  if ("error" in compiled) return null;
  return compiled.fn(vars);
}

/** Check if an arithmetic claim is correct */
export function checkArithmeticClaim(claim: string): boolean {
  const result = defaultEngine.validateArithmetic?.(claim);
  return result ? result.correct : false;
}

/** Extract the numeric value from a calculation step */
export function extractCalculationValue(step: {
  formula?: string;
  substituted?: string;
  expr?: string;
  result?: number | string;
}): number | null {
  // If result is already a number, return it
  if (typeof step.result === "number") return step.result;
  
  // Try to parse result as a number
  if (typeof step.result === "string") {
    const parsed = parseNumber(step.result);
    if (parsed !== null) return parsed;
  }
  
  // Try to evaluate the expression
  if (step.expr) {
    const evaluated = defaultEngine.evaluate?.(step.expr);
    if (evaluated !== null && typeof evaluated === "number") return evaluated;
  }
  
  return null;
}

/** Build a dependency graph from calculation steps */
export interface CalculationDependency {
  id: string;
  dependsOn: string[];
  value?: number | null;
  stale: boolean;
}

export function buildDependencyGraph(steps: Array<{ id: string; dependsOn?: string[]; expr?: string }>): Map<string, CalculationDependency> {
  const graph = new Map<string, CalculationDependency>();
  
  for (const step of steps) {
    graph.set(step.id, {
      id: step.id,
      dependsOn: step.dependsOn || [],
      value: step.expr ? defaultEngine.evaluate?.(step.expr) : undefined,
      stale: false,
    });
  }
  
  return graph;
}

/** Mark dependents as stale when a dependency changes */
export function markDependentsStale(
  graph: Map<string, CalculationDependency>,
  changedId: string
): string[] {
  const stale: string[] = [];
  
  for (const [id, dep] of graph) {
    if (dep.dependsOn.includes(changedId)) {
      dep.stale = true;
      stale.push(id);
    }
  }
  
  return stale;
}

/** Recalculate all stale nodes in the dependency graph */
export function recalculateStale(
  graph: Map<string, CalculationDependency>,
  stepExpressions: Map<string, string>
): Map<string, number | null> {
  const results = new Map<string, number | null>();
  
  for (const [id, dep] of graph) {
    if (dep.stale) {
      const expr = stepExpressions.get(id);
      if (expr) {
        const value = defaultEngine.evaluate?.(expr) ?? null;
        results.set(id, value);
        dep.value = value;
        dep.stale = false;
      }
    }
  }
  
  return results;
}

/** Validate a calculation step against the engine */
export interface ValidationResult {
  valid: boolean;
  calculated?: number;
  claimed?: number;
  difference?: number;
  toleranceMet?: boolean;
}

export function validateCalculationStep(
  step: {
    expr?: string;
    result?: number | string;
    unit?: string;
  },
  tolerance: number = 0.01
): ValidationResult {
  const calculated = step.expr ? (defaultEngine.evaluate?.(step.expr) ?? null) : null;

  if (calculated === null) {
    return { valid: false };
  }
  
  const claimed = typeof step.result === "number" 
    ? step.result 
    : typeof step.result === "string" 
      ? parseNumber(step.result) 
      : null;
  
  if (claimed === null) {
    return { valid: false, calculated };
  }
  
  const difference = Math.abs(calculated - claimed);
  const relativeTolerance = tolerance * Math.max(1, Math.abs(calculated), Math.abs(claimed));
  const toleranceMet = difference <= relativeTolerance;
  
  return {
    valid: toleranceMet,
    calculated,
    claimed,
    difference,
    toleranceMet,
  };
}

/** Check if a calculation step uses units correctly */
export function validateUnits(
  step: { result?: number | string; unit?: string },
  expectedUnit?: string
): boolean {
  if (!expectedUnit) return true; // No unit constraint
  if (!step.unit) return false; // Missing required unit
  return step.unit === expectedUnit;
}

/** Format a number with appropriate precision */
export function formatNumber(value: number, precision: number = 2): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(precision);
}

/** Format a calculation result with unit */
export function formatResult(value: number, unit?: string, precision: number = 2): string {
  const formatted = formatNumber(value, precision);
  return unit ? `${formatted} ${unit}` : formatted;
}
