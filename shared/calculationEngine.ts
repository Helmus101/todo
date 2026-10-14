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
const defaultEngine = createCalculationEngine();

/** Check if an arithmetic claim is correct */
export function checkArithmeticClaim(claim: string): boolean {
  const result = defaultEngine.validateArithmetic?.(claim);
  return result ? result.correct : false;
}

/** Validate a calculation step against the engine */
interface ValidationResult {
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
