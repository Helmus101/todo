// "Never derive an equation or show which formula to use — ask first." A pure check for it: the equations in a
// tutor line (board or reply) whose formula side the student has never stated. A line like "m = 1000 kg" (a
// given), "b = ?" (naming the unknown) or a bare number is not a formula; "P = mgv sin θ", "tan 25° = h/b" and
// "mgv sin(10°) = ?" are. A formula the student said — typed, as LaTeX, or spoken ("h over b") — is theirs.
import { latexToPlainText } from "./mathText.ts";
import { equivalent } from "./mathEquiv.ts";

const SPOKEN: [RegExp, string][] = [
  // quantity names → their usual symbols, so "power is force times velocity" counts as "P = Fv"
  [/\bpower\b|\bpuissance\b/gi, "p"], [/\bforce\b/gi, "f"], [/\bvelocity\b|\bspeed\b|\bvitesse\b/gi, "v"], [/\bmass\b|\bmasse\b/gi, "m"],
  [/\bacceleration\b|\baccélération\b/gi, "a"], [/\bheight\b|\bhauteur\b/gi, "h"], [/\btime\b|\btemps\b/gi, "t"], [/\bdistance\b/gi, "d"],
  [/\bgravity\b|\bgravité\b/gi, "g"], [/\benergy\b|\bénergie\b/gi, "e"], [/\bwork\b|\btravail\b/gi, "w"],
  [/\bover\b|\bdivided by\b|\bsur\b/gi, "/"], [/\btimes\b|\bfois\b/gi, "*"], [/\bequals?\b|\bis equal to\b|\bégale?\b/gi, "="],
  [/\bplus\b/gi, "+"], [/\bminus\b|\bmoins\b/gi, "-"], [/\bsquared\b|\bau carré\b/gi, "^2"], [/\btheta\b|\bthêta\b/gi, "θ"],
  [/\bsine\b|\bsinus\b/gi, "sin"], [/\bcosine\b|\bcosinus\b/gi, "cos"], [/\btangent\b|\btangente\b/gi, "tan"],
];

/** Plain, comparable form: LaTeX → text, spoken words → symbols, no spaces/multiplication dots/brackets/degrees. */
function norm(s: string, spoken = false): string {
  let t = latexToPlainText(String(s || "").replace(/\$/g, " "));
  if (spoken) for (const [re, rep] of SPOKEN) t = t.replace(re, rep);
  return t.toLowerCase().replace(/°|\bdeg(?:rees?)?\b|degrés?/g, "").replace(/[\s*·×()[\]{}]/g, "").replace(/−/g, "-");
}

/** One side of an equation is a FORMULA when it relates two or more symbols (letters or functions). */
function isFormula(side: string): boolean {
  // Units after a number are not symbols ("1000 kg", "15 m/s").
  const t = latexToPlainText(side.replace(/\$/g, " ")).replace(/(\d)\s*(?:kg|km|cm|mm|m\/s²?|m\/s\^?2|m|s|n|j|w|kw|kj|g|h|min|v|a|mol|l|ml|%|°)(?![a-z])/gi, "$1");
  const symbols = (t.match(/\b(?:sin|cos|tan|cot|log|ln|sqrt|exp)\b|[a-zA-Zα-ωΑ-Ω]/g) || []);
  if (symbols.length >= 2) return true;
  // A substituted set-up is a formula too: two or more quantities chained by operators ("900×9.8×sin(12°)+900×0.4+360"
  // — reported live, written on the board before the student had built it). Building it IS the student's work.
  // A product with parentheses counts without any written operator: "½(1200)(25)²" (the live exercise question
  // "KE_f = ½(1200)(25)² = ?" dumped the substituted KE with a single ÷ and implicit ×) — so an opening paren or
  // ^ directly after a quantity is an operator, same as × is.
  const operators = (t.replace(/^[-−]/, "").match(/\d[)\^°]*\s*(?:[+\-−×*·/÷]|\()\s*[(\d.a-z]/gi) || []).length;
  return operators >= 2;
}

const FUNCS = /^(?:sin|cos|tan|cot|sec|csc|log|ln|exp|sqrt|arcsin|arccos|arctan)$/i;
/** Is this whitespace-separated token maths? Digits/operators, a short symbol run ("Fv", "mgv"), a function name. */
function mathToken(tok: string): boolean {
  if (!tok) return false;
  if (/[\d=+\-*/^()√π×·°]/.test(tok)) return /^[\w\d=+\-*/^().,√π×·°θα-ωΑ-Ω]+$/u.test(tok);
  if (FUNCS.test(tok) || /^[a-zA-Zθα-ωΑ-Ω]{1,2}$/u.test(tok)) return true;
  // "mgv", "mgh", "mgsinθ" — products of symbols (function names allowed inside), not words
  const rest = tok.replace(/sin|cos|tan|cot|log|ln|sqrt|exp/gi, "");
  return tok.length <= 10 && /^[a-zA-Zθα-ωΑ-Ω]*$/u.test(tok) && rest.length <= 5 && !/[aeiouy]/i.test(rest);
}
/** The maths run touching the "=": trailing tokens of the left side, leading tokens of the right side. */
function mathRun(side: string, fromEnd: boolean): string {
  const toks = side.trim().split(/\s+/);
  const out: string[] = [];
  for (const tok of fromEnd ? [...toks].reverse() : toks) { if (!mathToken(tok)) break; out.push(tok); }
  return (fromEnd ? out.reverse() : out).join(" ");
}

/** Equations in `text` that the student hasn't reached: returns each one ("P = mgv sin θ") — empty when none. */
export function equationsAhead(text: string, said: string[]): string[] {
  // Thousands separators out first, so "25,526" isn't split into two segments at the comma.
  const plain = latexToPlainText(String(text || "").replace(/\$/g, " ")).replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const heard = said.map((x) => norm(x, true)).join(" | ");
  const saidSides = said.flatMap((x) => latexToPlainText(x.replace(/\$/g, " ")).split(/[=\n,;]/)).map((x) => x.trim()).filter((x) => x && x.length < 80);
  const out: string[] = [];
  for (const seg of plain.split(/[\n;,]|(?<=[.!?])\s+/)) {
    if (!seg.includes("=")) continue;
    const parts = seg.split(/=|≈/);
    const sides = parts.map((x, i) => mathRun(x.replace(/[—–]/g, " ").replace(/[?!]+/g, " "), i === 0 ? true : i === parts.length - 1 ? false : false)).filter(Boolean);
    const formulaSides = sides.filter(isFormula);
    if (!formulaSides.length) continue;
    // Theirs if every formula side was said (string match after normalizing, or numerically the same expression).
    const reached = formulaSides.every((f) => {
      const n = norm(f);
      if (n.length >= 2 && (heard.includes(n) || heard.replace(/\bis\b|est/g, "").includes(n))) return true;
      if (saidSides.some((s) => equivalent(f, s) === "correct")) return true;
      // A substituted set-up they spoke ("mass 1000 times g 9.8 sine 10 times 15"): every number in it came from one
      // of their messages — they built it, the words around the numbers just don't normalize the same way.
      const nums = (f.match(/\d+(?:\.\d+)?/g) || []);
      return nums.length >= 3 && said.some((x) => { const theirs = new Set(x.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/\d+(?:\.\d+)?/g) || []); return nums.every((n) => theirs.has(n)); });
    });
    if (!reached) out.push(seg.trim().slice(0, 80));
  }
  return out;
}

/** The solve-ask at the end of a CREATED question ("Find the average net force acting on the brick.", "What power is needed?", "Details: … Find x.") — an instruction to the student, not their equation. Stripped
 *  before the setup check: in the live transcript exercise, the trailing ask made the math run on that side empty and the dumped substituted setup went through untouched — the exercise opened with the student's first
 *  equation already built for them. */
const SOLVE_ASK = /(?:find|calculate|compute|determine|evaluate|express|solve|draw|sketch)\b[^.]*\?\s*$|(?:how\s+(?:long|much|many|far|fast)|what(?:'s|\s+is|\s+will|\s+are)?|which|trouve[rz]?|calcule?z?|détermine[rz]?|combien)\b[^.]*\?\s*$/i;
function stripSolveAsk(text: string): string {
  let s = String(text || "").trim();
  for (let pass = 0; pass < 2; pass++) {
    const m = s.match(SOLVE_ASK);
    if (!m) break;
    s = s.slice(0, m.index).replace(/[—–.,:;\])\s]+$/, "").trim();
    if (!s) return "";
  }
  return s;
}

/** The solve-ask at the end of a CREATED question stripped, then the straight setup check. The student's own
 *  setup can never ship pre-built with the exercise — the transcript bug: CREATE_PROBLEM's own question carried
 *  "$KE_f = \\frac{1}{2}(1200)(25)^2 = ?$" and never faced the guard every tutor line and reply already has. */
export function questionAhead(question: string, said: string[]): string[] {
  const stripped = stripSolveAsk(question);
  if (!stripped) return [];
  return equationsAhead(stripped, said.map((s) => stripSolveAsk(s)).filter(Boolean));
}

/** The student explicitly asked for the formula/equation/definition — then telling them is answering them. */
export function asksForFormula(message: string): boolean {
  return /\b(?:formula|equation|formule|équation|definition|définition|define|définis|remind me|rappelle[- ]moi)\b|\bwhat(?:'s| is| are)\b|\bc'est quoi\b|\bqu'est[- ]ce que?\b/i.test(String(message || ""));
}
