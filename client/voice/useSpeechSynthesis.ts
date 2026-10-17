import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { hideToolLeaks } from "../../shared/toolLeak.ts";

const GREEK_WORDS: Record<string, string> = {
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", zeta: "zeta",
  eta: "eta", theta: "theta", iota: "iota", kappa: "kappa", lambda: "lambda", mu: "mu", nu: "nu",
  xi: "xi", pi: "pi", rho: "rho", sigma: "sigma", tau: "tau", upsilon: "upsilon", phi: "phi",
  chi: "chi", psi: "psi", omega: "omega",
};

/** Reported live: "sin A cos B + cos A sin B" was read with the ABBREVIATION itself ("sin", "cos") rather
 *  than the word a tutor actually says ("sine", "cosine") — true whether the source had a LaTeX \sin or was
 *  already plain text (angle-addition identities are often typed without backslashes at all). Longer names
 *  listed first so sinh/cosh/tanh/arcsin/etc match whole, never leaving a stray trailing "h" behind once
 *  "sin"/"cos"/"tan" are consumed. */
const TRIG_WORDS: Record<string, string> = {
  arcsin: "arc sine", arccos: "arc cosine", arctan: "arc tangent",
  sinh: "hyperbolic sine", cosh: "hyperbolic cosine", tanh: "hyperbolic tangent",
  sin: "sine", cos: "cosine", tan: "tangent", csc: "cosecant", sec: "secant", cot: "cotangent",
};
const TRIG_WORDS_FR: Record<string, string> = {
  arcsin: "arc sinus", arccos: "arc cosinus", arctan: "arc tangente",
  sinh: "sinus hyperbolique", cosh: "cosinus hyperbolique", tanh: "tangente hyperbolique",
  sin: "sinus", cos: "cosinus", tan: "tangente", csc: "cosécante", sec: "sécante", cot: "cotangente",
};
const TRIG_NAMES = "arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|csc|sec|cot";

/** Words this pipeline can itself produce (or real short English words) that must never be torn apart as if
 *  they were concatenated single-letter variables — see expandImplicitMultiplication below. */
const NO_SPLIT_WORDS = new Set([
  "am", "an", "as", "at", "be", "by", "do", "go", "he", "hi", "if", "in", "is", "it", "me", "my", "no",
  "of", "oh", "ok", "on", "or", "so", "to", "up", "us", "we",
  "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "day", "get",
  "has", "him", "his", "how", "man", "new", "now", "old", "see", "two", "way", "who", "let", "put", "say",
  "she", "too", "use", "the", "dad", "mom", "bad", "bag", "bar", "bed", "bet", "big", "bit", "box", "boy",
  "bus", "buy", "car", "cat", "cup", "cut", "dog", "eat", "egg", "end", "eye", "far", "few", "fly", "fun",
  "gun", "guy", "hat", "hit", "hot", "ice", "job", "joy", "key", "kid", "lap", "law", "leg", "lie", "lot",
  "low", "mad", "map", "mix", "mud", "net", "nor", "nut", "oil", "own", "pan", "pay", "pen", "pet", "pie",
  "pig", "pot", "pub", "rat", "red", "rob", "run", "sad", "sat", "saw", "set", "sit", "sky", "son", "sun",
  "tax", "tea", "ten", "tie", "top", "toy", "try", "van", "war", "wet", "win", "yes", "yet", "arc",
  "ln", "log", "lim", "exp", "min", "max", "gcd", "det",
  "sin", "cos", "tan", "csc", "sec", "cot", "sine", "sinh", "cosh", "tanh",
  "over", "sub", "root", "less", "than", "plus", "gives", "times", "is", "per",
  // French words the same pipeline produces
  "cm", "mm", "km", "kg", "kj", "kw", "kn", "hz", "ml", "mol", "kpa", "mj", "mw", "kwh",
  "fois", "sur", "par", "au", "de", "cube", "est", "ou", "et", "la", "le", "un", "une", "des", "du", "donc", "sinus",
  ...Object.keys(GREEK_WORDS),
]);
/** Implicit multiplication: "ab" in a formula means a×b, not the word "ab" — read literally it sounds like
 *  nonsense ("ab", "mn", "pq"). Scoped to actual LaTeX math zones only (see stripLatexForSpeech's sentinel
 *  markers below): outside real math, a short lowercase run is almost always an actual English word, and
 *  guessing wrong there would be worse than leaving an occasional real formula unexpanded. Runs LAST, after
 *  every other LaTeX word (frac/sqrt/trig/greek/operator) has already been spelled out — NO_SPLIT_WORDS
 *  protects exactly those output words from being torn apart as if they were variables themselves. */
function expandImplicitMultiplication(math: string, times = "times"): string {
  return math.replace(/(?<![\p{L}\d'’])[A-Za-z]{2,4}(?![\p{L}\d'’])/gu, (token) => (NO_SPLIT_WORDS.has(token.toLowerCase()) || /^[A-Z]{2,}$/.test(token) ? token : token.split("").join(` ${times} `)));
}

/** Reported live: a worked-math reply full of real LaTeX ("$\sin\left(\frac{\pi}{12}\right)$") got read
 *  aloud LITERALLY — "dollar sin backslash left parenthesis backslash frac pi 12 ..." — because the TTS
 *  pipeline only ever stripped markdown, never LaTeX. Otto's board/chat math is real LaTeX (KaTeX renders
 *  it visually), so speech needs its own pass that turns the common constructs into the words a tutor would
 *  actually say, then throws away anything left over (an unrecognized command/brace/delimiter) rather than
 *  reading it character by character. Order matters: fractions/roots/sub-superscripts are unwrapped BEFORE
 *  the final sweep that strips remaining backslash-commands and braces, so their arguments survive as plain
 *  text instead of being deleted along with the syntax. Exported for unit tests. */
export function stripLatexForSpeech(text: string, lang: "en" | "fr" = "en"): string {
  const W = SAY[lang];
  const TRIG = lang === "fr" ? TRIG_WORDS_FR : TRIG_WORDS;
  // \x01...\x02 mark genuine math zones (what was inside a LaTeX delimiter) so implicit multiplication can
  // be expanded ONLY there, at the very end, after everything inside has already been turned into words.
  let s = text
    .replace(/\$\$([\s\S]+?)\$\$/g, " \x01$1\x02 ")     // $$...$$ display math — keep the content
    .replace(/\\\[([\s\S]+?)\\\]/g, " \x01$1\x02 ")      // \[...\] display math
    .replace(/\\\(([\s\S]+?)\\\)/g, " \x01$1\x02 ")      // \(...\) inline math
    .replace(/\$([^$\n]+?)\$/g, " \x01$1\x02 ")          // $...$ inline math
    .replace(/\\left|\\right/g, "")                     // sizing commands carry no sound of their own
    .replace(/\^\s*\{?\s*\\circ\s*\}?|\\degree/g, "°")       // 30^\circ is "30°" — the unit pass says "degrees"
    .replace(/\\[,;:!]|\\quad|\\qquad|~/g, " ")             // spacing commands are silence, never a comma
    // A unit typeset as text ("\text{cm}^3", "\,\mathrm{kJ}") is a unit, not letters to multiply: kept whole so the
    // unit pass later reads "cubic centimetres".
    .replace(/\\(?:text|mathrm|rm)\{\s*([A-Za-zΩ]{1,3})\s*\}\s*\^\s*\{?\s*([23])\s*\}?/g, " $1$2 ")
    .replace(/\\(?:text|mathrm|rm|mathit|mathbf)\{([^{}]*)\}/g, " \x03$1\x04 ");
  // Fractions/roots can nest one level deep in typical worked-math output (e.g. a fraction of two sums) —
  // run twice so the inner pair resolves before the outer one is matched.
  for (let i = 0; i < 2; i++) {
    s = s
      // [cdt]? — `d?` alone never matched \tfrac/\cfrac (spoken as nothing; the braces then got deleted
      // along with the syntax, losing the fraction's arguments entirely).
      .replace(/\\[cdt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, ` ($1) ${W.over} ($2) `)
      .replace(/\\[cdt]?frac(\S)(\S)/g, ` ($1) ${W.over} ($2) `) // brace-less: \tfrac12 → ( 1 ) over (2)
      .replace(/\\sqrt\[(\d+)\]\{([^{}]*)\}/g, lang === "fr" ? " racine $1-ième de ($2) " : " the $1th root of ($2) ")
      .replace(/\\sqrt\{([^{}]*)\}/g, ` ${W.sqrt} ($1) `);
  }
  s = s
    .replace(/\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/gi, (_, w) => ` ${GREEK_WORDS[w.toLowerCase()]} `)
    // Function names: the backslash is syntax (keeps KaTeX from italicizing "sin" as s*i*n) — \sin/\cos/\tan
    // become the full spoken word straight away; a function name with no special meaning when spoken (ln,
    // log, lim, exp, min, max, gcd, det) just has its backslash dropped.
    .replace(new RegExp(`\\\\(${TRIG_NAMES})\\b`, "g"), (_, w) => ` ${TRIG[w]} `)
    .replace(/\\(ln|log|lim|exp|min|max|gcd|det)\b/g, " $1 ")
    .replace(/\\cdot|\\times/g, ` ${W.times} `)
    .replace(/\\div/g, ` ${W.dividedBy} `)
    .replace(/\\pm/g, ` ${W.pm} `)
    .replace(/\\leq?/g, ` ${W.le} `)
    .replace(/\\geq?/g, ` ${W.ge} `)
    .replace(/\\neq/g, ` ${W.ne} `)
    .replace(/\\approx/g, ` ${W.approx} `)
    .replace(/\\infty/g, ` ${W.infinity} `)
    .replace(/\^\{?\s*2\s*\}?(?![\d.])/g, ` ${W.squared} `)
    .replace(/\^\{?\s*3\s*\}?(?![\d.])/g, ` ${W.cubed} `)
    .replace(/\^\{([^{}]*)\}/g, ` ${W.power} $1 `)
    .replace(/\^(-?\w)/g, ` ${W.power} $1 `)
    .replace(/_\{([^{}]*)\}/g, ` ${W.sub} $1 `)
    .replace(/_(\w)/g, ` ${W.sub} $1 `)
    .replace(/\\[a-zA-Z]+/g, " ")                       // any other LaTeX command — not worth guessing at
    .replace(/\\/g, " ")                                // lone backslash ("\ J" control space) — silence, not "backslash"
    .replace(/[{}$]/g, "")                              // remaining braces/delimiters
    // Plain-text trig abbreviations (no backslash at all — angle-addition identities are often typed this
    // way directly, "sin A cos B + cos A sin B") get the same word-form treatment as the LaTeX case above.
    .replace(new RegExp(`\\b(${TRIG_NAMES})\\b`, "g"), (_, w) => TRIG[w])
    .replace(/\x01([\s\S]*?)\x02/g, (_, zone: string) => zone.split(/(\x03[^\x04]*\x04)/).map((part) => part.startsWith("\x03") ? part : expandImplicitMultiplication(part, W.times)).join(""))
    .replace(/[\x01-\x04]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return s;
}

type SpeechLang = "en" | "fr";
/** The spoken words for every symbol, per language. */
const SAY: Record<SpeechLang, Record<string, string>> = {
  en: {
    minus: "minus", plus: "plus", equals: "equals", times: "times", over: "over", per: "per", dividedBy: "divided by",
    squared: "squared", cubed: "cubed", power: "to the power of", sqrt: "the square root of", sub: "sub",
    lt: "is less than", gt: "is greater than", le: "is less than or equal to", ge: "is greater than or equal to",
    ne: "is not equal to", approx: "is approximately", pm: "plus or minus", percent: "percent", degrees: "degrees",
    gives: "gives", infinity: "infinity", propto: "is proportional to", therefore: "therefore", and: "and", or: "or",
    at: "at", about: "about", number: "number", forExample: "for example", thatIs: "that is", versus: "versus",
    square: "square", cubic: "cubic",
  },
  fr: {
    minus: "moins", plus: "plus", equals: "égale", times: "fois", over: "sur", per: "par", dividedBy: "divisé par",
    squared: "au carré", cubed: "au cube", power: "puissance", sqrt: "racine carrée de", sub: "indice",
    lt: "est inférieur à", gt: "est supérieur à", le: "est inférieur ou égal à", ge: "est supérieur ou égal à",
    ne: "est différent de", approx: "vaut environ", pm: "plus ou moins", percent: "pour cent", degrees: "degrés",
    gives: "donc", infinity: "l'infini", propto: "est proportionnel à", therefore: "donc", and: "et", or: "ou",
    at: "arobase", about: "environ", number: "numéro", forExample: "par exemple", thatIs: "c'est-à-dire", versus: "contre",
    square: "carré", cubic: "cube",
  },
};
const GREEK_GLYPHS: Record<string, string> = {
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "Δ": "delta", "ε": "epsilon", "ζ": "zeta", "η": "eta",
  "θ": "theta", "ϑ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi",
  "ρ": "rho", "σ": "sigma", "Σ": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi",
  "ω": "omega", "Ω": "omega",
};
const SUPERSCRIPTS: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-" };
const SUBSCRIPTS: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };

/** Units spoken after a number: [singular, plural] per language. Single letters that double as variables (m, g, s, N,
 *  J, …) only count as a unit with a space after the number ("2 m", never the "2m" of "2mg"). */
const UNITS: Record<string, { en: [string, string]; fr: [string, string]; spaced?: boolean }> = {
  m: { en: ["metre", "metres"], fr: ["mètre", "mètres"], spaced: true }, cm: { en: ["centimetre", "centimetres"], fr: ["centimètre", "centimètres"] },
  mm: { en: ["millimetre", "millimetres"], fr: ["millimètre", "millimètres"] }, km: { en: ["kilometre", "kilometres"], fr: ["kilomètre", "kilomètres"] },
  kg: { en: ["kilogram", "kilograms"], fr: ["kilogramme", "kilogrammes"] }, g: { en: ["gram", "grams"], fr: ["gramme", "grammes"], spaced: true },
  s: { en: ["second", "seconds"], fr: ["seconde", "secondes"], spaced: true }, ms: { en: ["millisecond", "milliseconds"], fr: ["milliseconde", "millisecondes"] },
  min: { en: ["minute", "minutes"], fr: ["minute", "minutes"] }, h: { en: ["hour", "hours"], fr: ["heure", "heures"], spaced: true },
  N: { en: ["newton", "newtons"], fr: ["newton", "newtons"], spaced: true }, kN: { en: ["kilonewton", "kilonewtons"], fr: ["kilonewton", "kilonewtons"] },
  J: { en: ["joule", "joules"], fr: ["joule", "joules"], spaced: true }, kJ: { en: ["kilojoule", "kilojoules"], fr: ["kilojoule", "kilojoules"] },
  MJ: { en: ["megajoule", "megajoules"], fr: ["mégajoule", "mégajoules"] }, W: { en: ["watt", "watts"], fr: ["watt", "watts"], spaced: true },
  kW: { en: ["kilowatt", "kilowatts"], fr: ["kilowatt", "kilowatts"] }, MW: { en: ["megawatt", "megawatts"], fr: ["mégawatt", "mégawatts"] },
  kWh: { en: ["kilowatt hour", "kilowatt hours"], fr: ["kilowattheure", "kilowattheures"] },
  V: { en: ["volt", "volts"], fr: ["volt", "volts"], spaced: true }, A: { en: ["amp", "amps"], fr: ["ampère", "ampères"], spaced: true },
  "Ω": { en: ["ohm", "ohms"], fr: ["ohm", "ohms"] }, Hz: { en: ["hertz", "hertz"], fr: ["hertz", "hertz"] },
  Pa: { en: ["pascal", "pascals"], fr: ["pascal", "pascals"] }, kPa: { en: ["kilopascal", "kilopascals"], fr: ["kilopascal", "kilopascals"] },
  mol: { en: ["mole", "moles"], fr: ["mole", "moles"] }, L: { en: ["litre", "litres"], fr: ["litre", "litres"], spaced: true },
  mL: { en: ["millilitre", "millilitres"], fr: ["millilitre", "millilitres"] }, K: { en: ["kelvin", "kelvin"], fr: ["kelvin", "kelvins"], spaced: true },
};
const unitWord = (u: string, plural: boolean, lang: SpeechLang): string | null => {
  const m = /^([A-Za-zΩ]+?)(2|3|²|³)?$/.exec(u);
  if (!m || !UNITS[m[1]]) return null;
  const w = UNITS[m[1]][lang][plural ? 1 : 0];
  const pow = m[2] === "2" || m[2] === "²" ? "2" : m[2] === "3" || m[2] === "³" ? "3" : "";
  if (!pow) return w;
  // "cm³" → "cubic centimetres" / "centimètres cubes"; "m²" → "square metres" / "mètres carrés".
  const adj = SAY[lang][pow === "2" ? "square" : "cubic"];
  return lang === "fr" ? `${w} ${adj}${plural ? "s" : ""}` : `${adj} ${w}`;
};
/** "40 kW" → "40 kilowatts", "34 kJ/cm3" → "34 kilojoules per cubic centimetre", "9.8 m/s²" → "9.8 metres per second squared". */
function unitsToWords(s: string, lang: SpeechLang): string {
  return s.replace(/(\d(?:[\d.,]*\d)?(?:\s+(?:squared|cubed|au carré|au cube|(?:to the power of|puissance)\s+(?:minus\s+|moins\s+)?\d+)(?=\s))?)(\s*)([A-Za-zΩ]{1,3}(?:2|3|²|³)?)(?:\/([A-Za-z]{1,3})(2|3|²|³)?)?(?![\wÀ-ÿ/])/g,
    (whole, num: string, space: string, unit: string, perUnit: string | undefined, perSq: string | undefined, at: number, all: string) => {
      const base = /^([A-Za-zΩ]+?)(2|3|²|³)?$/.exec(unit)?.[1] || unit;
      if (!UNITS[base] || (UNITS[base].spaced && !space && !perUnit)) return whole;
      // A lone letter after a number is only a unit when nothing mathematical touches it: "½ m v²" is a mass, not
      // "metres", and "1 over 2 m" is a denominator.
      if (UNITS[base].spaced && !perUnit) {
        const next = all.slice(at + whole.length), prev = all.slice(0, at);
        if (/^\s*(?:times|plus|minus|over|squared|cubed|to the power|equals|fois|sur|moins|au |égale|[=+\-−*×·/^(]|[A-Za-z]\b)/.test(next) || /(?:over|sur|times|fois|[/*×·])\s*$/.test(prev)) return whole;
      }
      const plural = /\s/.test(num) || Math.abs(Number(num.replace(",", "."))) !== 1;
      const first = unitWord(unit, plural, lang);
      if (!first) return whole;
      if (!perUnit) return `${num} ${first}`;
      // "m/s²" is "per second squared"; "kJ/cm³" is "per cubic centimetre".
      const timeSquared = !!perSq && /^(?:s|h|min)$/.test(perUnit) && /2|²/.test(perSq);
      const second = unitWord(timeSquared ? perUnit : perUnit + (perSq || ""), false, lang);
      if (!second) return whole;
      return `${num} ${first} ${SAY[lang].per} ${second}${timeSquared ? ` ${SAY[lang].squared}` : ""}`;
    });
}

/** Brackets carry meaning that is lost when they are simply dropped ("(M+m)a" is not "M plus m a"). A group that holds
 *  an operation is spoken the way a tutor says it — a pause around it, and "times" where it multiplies: "g(M − m)" →
 *  "g times, M − m,"; "(M+m)a" → "M+m, times a"; "(a+b)/(c+d)" → "a+b, all over c+d". A plain group ("sine (x)",
 *  "(12)") just loses its brackets. Innermost first. Exported for tests. */
export function spokenBrackets(text: string, times = "times"): string {
  let s = text;
  const FN = /(?:sine|cosine|tangent|sinus|cosinus|tangente|sin|cos|tan|log|ln|exp|root of|of|de|sqrt|√)\s*$/i;
  for (let guard = 0; guard < 20; guard++) {
    const m = /\(([^()]*)\)/.exec(s);
    if (!m) break;
    const inner = m[1].trim();
    const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length);
    if (!/[+\-−=]|\b(?:plus|minus|moins)\b/.test(inner) || inner.split(/\s+/).length > 14) { s = `${before} ${inner} ${after}`; continue; }
    const mulBefore = /[\p{L}\d)]\s*$/u.test(before) && !FN.test(before) && !/\b(?:over|sur|is|est|equals|égale|and|et|of)\s*$/i.test(before) && !/[\p{L}]{3,}\s+$/u.test(before);
    const mulAfter = /^\s*(?:[\p{L}\d(√])/u.test(after) && !/^\s*(?:over|sur|is|est|equals|égale|and|et|or|ou|to|the|that|so|but|which|for|on|in|at|with|when|then|because)\b/i.test(after) && !/^\s*[\p{L}]{4,}/u.test(after);
    const overAfter = /^\s*(?:\/|over\b|sur\b)/.test(after);
    s = `${before}${mulBefore ? ` ${times}` : ""}, ${inner},${overAfter ? " all" : mulAfter ? ` ${times}` : ""} ${after}`;
  }
  return s.replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").replace(/,\s*([.!?])/g, "$1");
}

/** Every maths symbol left in plain text becomes the word a tutor says — the student HEARS words only, never "dash",
 *  "slash" or silence where a minus was (reported: "a − b" read as "a b"). What is SHOWN keeps the symbols; only the
 *  speech differs. A hyphen inside a word ("well-known") stays a hyphen; between quantities it is "minus". Exported for tests. */
export function mathSymbolsToWords(text: string, lang: SpeechLang = "en"): string {
  const W = SAY[lang];
  const sp = (w: string) => ` ${w} `;
  let s = spokenBrackets(String(text || ""), W.times)
    .replace(/\be\.g\./gi, W.forExample).replace(/\bi\.e\./gi, W.thatIs).replace(/\bvs\.?(?=\s)/gi, W.versus)
    // Superscripts and subscripts (unicode): x² → "x squared", 10⁴ → "10 to the power of 4", v₀ → "v sub 0".
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => { const v = [...m].map((c) => SUPERSCRIPTS[c]).join(""); return v === "2" ? sp(W.squared) : v === "3" ? sp(W.cubed) : sp(`${W.power} ${v.replace("-", `${W.minus} `)}`); })
    .replace(/[₀-₉]+/g, (m) => sp(`${W.sub} ${[...m].map((c) => SUBSCRIPTS[c]).join("")}`));
  // Scientific notation and units before the generic operators, so "×10^4" and "kJ/cm3" are read as one thing.
  s = s.replace(/(\d)\s*[×x·*]\s*10\s*\^\s*\{?\s*([-−]?\d+)\s*\}?/g, (_, d, e) => `${d} ${W.times} 10 ${W.power} ${e.replace(/^[-−]/, `${W.minus} `)}`);
  s = unitsToWords(s, lang);
  s = s
    .replace(/(\d)\s*%/g, `$1 ${W.percent}`)
    .replace(/(\d)\s*°\s*C\b/g, `$1 ${W.degrees} Celsius`)
    .replace(/(\d)\s*°/g, `$1 ${W.degrees}`)
    .replace(/[αβγδΔεζηθϑικλμνξπρσΣτυφϕχψωΩ]/g, (c) => sp(GREEK_GLYPHS[c]))
    .replace(/√\s*/g, sp(W.sqrt))
    .replace(/±|\+\/-/g, sp(W.pm))
    .replace(/≈|≃|~=/g, sp(W.approx))
    .replace(/≠|!=/g, sp(W.ne))
    .replace(/≤|<=/g, sp(W.le))
    .replace(/≥|>=/g, sp(W.ge))
    .replace(/∝/g, sp(W.propto))
    .replace(/∞/g, sp(W.infinity))
    .replace(/∴/g, sp(W.therefore))
    .replace(/\s*(?:->|=>|→|⇒|⟹)\s*/g, sp(W.gives))
    .replace(/</g, sp(W.lt)).replace(/>/g, sp(W.gt))
    .replace(/=/g, sp(W.equals))
    .replace(/\+/g, sp(W.plus))
    .replace(/[×·∗]/g, sp(W.times))
    .replace(/(?<=[\w)\]]\s*)\*(?=\s*[\w(])/g, sp(W.times))
    .replace(/÷/g, sp(W.dividedBy))
    .replace(/\^\s*\(?\s*([-−]?[\w.]+)\s*\)?/g, (_, e) => sp(`${W.power} ${e.replace(/^[-−]/, `${W.minus} `)}`))
    // A slash between two words is "or" (and/or); between quantities it is "over".
    .replace(/\b([A-Za-zÀ-ÿ]{3,})\/([A-Za-zÀ-ÿ]{3,})\b/g, `$1 ${W.or} $2`)
    .replace(/\//g, sp(W.over))
    .replace(/_\{?([\w]+)\}?/g, (_, x) => sp(`${W.sub} ${x}`))
    // The unicode minus (U+2212) is always a minus.
    .replace(/−/g, sp(W.minus))
    // An em dash is a pause; an en dash between quantities is a minus, otherwise a pause.
    .replace(/\s*—\s*/g, ", ")
    .replace(/([\d\w)])\s*–\s*(?=[\d(]|[A-Za-z]\b)/g, `$1 ${W.minus} `)
    .replace(/\s*–\s*/g, ", ");
  // ASCII hyphen. Spaced " - ": a minus when either neighbour is a quantity (a digit, a single letter, a bracket, a
  // maths word); a pause between two ordinary words ("a nice trick - now try").
  s = s.replace(/(\S+)[ \t]+-[ \t]+(?=(\S+))/g, (whole, a: string, b: string) => {
    const word = (x: string) => /^[\p{L}'’]{2,}[,.;:!?]*$/u.test(x) && !/^(?:sine|cosine|tangent|sinus|cosinus|tangente|theta|alpha|beta|gamma|delta|lambda|sigma|omega|pi|mu|rho|phi|times|over|squared|cubed|fois|sur)$/i.test(x.replace(/[,.;:!?]+$/, ""));
    return word(a) && word(b) ? `${a}, ` : `${a} ${W.minus} `;
  });
  // Unary, glued to its operand (start, after a space, an operator or a bracket): "-3", "= -2", "(-b" → minus.
  s = s.replace(/(^|[\s(\[{,;:=+*/<>])-(?=[\d.(√\p{L}])/gu, (_, pre) => `${pre}${W.minus} `);
  // Unspaced "a-b": a minus unless it's a hyphenated word (both sides 2+ letters: "well-known", "re-check") or an
  // axis name ("x-axis").
  s = s.replace(/([\p{L}\d)\]]+)-(?=([\p{L}\d(]+))/gu, (whole, a: string, b: string) => {
    if (/^\p{L}{2,}$/u.test(a) && /^\p{L}{2,}$/u.test(b)) return whole;
    if (/^(?:axis|axes|intercepts?|coordinates?|values?|components?|directions?|plane|ray)$/i.test(b)) return whole;
    return `${a} ${W.minus} `;
  });
  const HALVES: Record<SpeechLang, Record<string, string>> = { en: { 2: "one half", 3: "one third", 4: "one quarter" }, fr: { 2: "un demi", 3: "un tiers", 4: "un quart" } };
  s = s.replace(new RegExp(String.raw`(?<![\d.])1\s+${W.over}\s+([234])(?![\d.])`, "g"), (_, d) => HALVES[lang][d]);
  return s
    .replace(/&/g, sp(W.and))
    .replace(/#(?=\d)/g, `${W.number} `)
    .replace(/[#@~"“”«»*\[\]{}()|\\`]/g, " ")
    .replace(/…/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\b(equals|over|is|égale|sur|est)\s*,\s*/g, "$1 ")
    .replace(/,\s*$/, "")
    .replace(/,\s*,+/g, ",")
    .replace(/([;:])\s*,/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Strip the markdown Otto's replies use (headings, bold/italic emphasis markers, [links](url), GFM table
 *  pipes, bullet markers) down to plain readable prose, then turn every remaining symbol into words — read aloud
 *  verbatim, "hashtag hashtag", a silent minus or a literal pipe would be nonsense. What is SAID differs from what is
 *  SHOWN on purpose: the screen keeps the maths, the voice says only words. Exported for unit tests. */
/** Plain-text physics the model writes outside $…$ ("F_(net)", "mgsin θ", "m s −1", "30 ∘"): a voice would read it as noise. */
export function spellOutPlainPhysics(text: string, L: SpeechLang = "en"): string {
  const en = L === "en";
  return String(text || "")
    .replace(/\b([A-Za-z])_\(([^()]{1,24})\)/g, (_m, a: string, b: string) => `${a} ${b.replace(/\\text\{([^}]*)\}/g, "$1")}`) // F_(net) → F net
    .replace(/\b([A-Za-z])_([A-Za-z]{2,10})\b/g, "$1 $2")                                                                      // F_net → F net
    .replace(/(\d)\s*[∘°]/g, en ? "$1 degrees" : "$1 degrés").replace(/\b(sin|cos|tan)\s*\(\s*([\d.]+)\s*degrees?\s*\)/gi, "$1 $2 degrees")
    .replace(/\bm\s*s\s*(?:\^\s*)?[−–-]\s*2\b|\bm\s*s⁻²/g, en ? "metres per second squared" : "mètres par seconde carrée")
    .replace(/\bm\s*s\s*(?:\^\s*)?[−–-]\s*1\b|\bm\s*s⁻¹/g, en ? "metres per second" : "mètres par seconde")
    .replace(/(?<![\w.])(\d+(?:\.\d+)?\s?)?mg(sin|cos|tan)\b/gi, (_m, n: string | undefined, f: string) => `${n ? n.trim() + " " : ""}m g ${f}`)
    .replace(/(?<![\w.])(\d+(?:\.\d+)?\s?)?mgh\b/gi, (_m, n: string | undefined) => `${n ? n.trim() + " " : ""}m g h`)
    .replace(/(\d)([a-z]{1,3})\b(?=\s|[.,)$]|$)/g, (m, d: string, l: string) => (/^(?:s|m|g|kg|n|j|w|hz|v|a|k|c|cm|mm|km|ms|mol|st|nd|rd|th|pm|am|l|ml)$/i.test(l) ? m : `${d} ${l.split("").join(" ")}`)); // 2as → 2 a s
}

export function toSpeakableText(md: string, lang: string = "en"): string {
  const L: SpeechLang = String(lang).toLowerCase().startsWith("fr") ? "fr" : "en";
  const prose = stripLatexForSpeech(spellOutPlainPhysics(hideToolLeaks(md), L), L)
    .replace(/```[\s\S]*?```/g, " ")                 // code blocks — not worth reading aloud
    .replace(/`([^`]+)`/g, "$1")                      // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")                // headings
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")         // [label](url) → label
    .replace(/\*\*([^*]+)\*\*/g, "$1")                 // **bold**
    .replace(/==([^=\n]+)==/g, "$1")                    // ==highlight==
    .replace(/\*([^*]+)\*/g, "$1")                     // *italic*
    .replace(/^\s{0,3}[-*+•]\s+/gm, "")                // bullet markers
    .replace(/^\s{0,3}(\d+)[.)]\s+/gm, "$1, ")          // numbered list markers → "1, …"
    .replace(/^\s{0,3}:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*$/gm, "") // table separator rows
    .replace(/\|/g, ", ")                              // table pipes → a pause, not a literal bar
    .replace(/https?:\/\/\S+/g, " ");                  // a URL is never worth reading out
  return mathSymbolsToWords(prose, L);
}

/** Sentence-sized chunks: cancel() stops promptly between chunks, and short utterances stay well under
 *  the ~15s length at which some browser engines silently stop mid-utterance. */
function toSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

// The free provider refuses an over-long synthesis outright ("Usage Limit exceeded"), so chunking exists to
// keep every request inside its ceiling — a chunk that trips the limit would lose the rest of the reply's
// audio. A typical reply is one chunk; a long one splits into as FEW provider-safe chunks as possible
// rather than many small ones, and they're fetched in parallel so playback still starts immediately.
// Kept in lockstep with the server's own per-call cap (server/claude.ts's TTS_CHUNK_MAX): the free provider
// refuses a long synthesis with "Usage Limit exceeded", so a chunk that crosses its ceiling loses the REST
// of that reply's audio — the exact "voice cuts off early" symptom. The client asks for chunks at the
// provider's own safe size (parallel fetches, so the first one still starts immediately) instead of sending
// one huge request for the server to split sequentially.
const CLOUD_CHUNK_MAX_CHARS = 900;
/** Group sentences into as few chunks as possible (fewer requests = less quota burn), each ≤
 *  CLOUD_CHUNK_MAX_CHARS. Joined text is also what makes the neural voice sound fluid — splitting on every
 *  sentence resets the model's intonation at each period. Exported for unit tests. */
export function cloudChunks(sentences: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && `${cur} ${s}`.length > CLOUD_CHUNK_MAX_CHARS) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Names that positively identify a MALE system voice. The browser's own voice list has no gender field at
 *  all — the name is the only signal there is — so the browser fallback is MALE-ONLY BY POSITIVE MATCH:
 *  a voice must appear here (or carry an explicit "male"/"homme" token) to be usable. Direct request:
 *  never use a female voice, and silence is preferred over one. Exported for unit tests. */
const MALE_VOICE_NAMES = new Set([
  // Apple/macOS + iOS system voices
  "thomas", "henri", "rémy", "remy", "nicolas", "matthieu", "guillaume", "aaron", "alex", "daniel", "fred", "guy", "jorge", "diego", "juan", "luca", "paolo", "yannick", "oliver", "ransom", "xander",
  "aaron", "arthur", "gordon", "lee", "reed", "rocko", "tom", "eddy", "flo",
  // Microsoft/Windows + Edge voices
  "david", "mark", "guy", "ryan", "brian", "george", "james", "paul", "matthew", "tarn", "bryce", "liam", "christopher", "eric", "roger", "steffan", "william", "guy",
  // Google/Chrome voices
  "google uk english male", "google français", "google français (fr-fr)", "google español",
  // Android/other
  "male", "homme", "masculin",
]);
/** Names that positively identify a FEMALE voice. Only used to VETO — a name that appears here is never
 *  eligible even if it would otherwise score well, so a system voice list that changes its naming scheme
 *  (or a locale whose male names we don't know) can't accidentally hand the tutor a woman's voice. */
const FEMALE_VOICE_NAMES = new Set([
  "amelie", "amélie", "marie", "julie", "céline", "celine", "chantal", "léa", "lea", "alice", "audrey", "aurélie", "aurelie", "denise", "eloise", "éloise", "jacqueline", "joséphine", "josephine", "margaux", "vivienne", "hortense", "louise", "virginie", "flo", "siri",
  "samantha", "victoria", "karen", "moira", "tessa", "fiona", "serena", "allison", "ava", "susan", "zira", "aria", "jenny", "michelle", "emma", "olivia", "amy", "joanna", "salli", "kimberly", "ivy", "kendra", "nicole", "catherine", "clara", "emily", "linda", "heather", "sara", "hazel", "libby", "maisie", "natasha", "sonia", "amber", "ana", "ashley", "cora", "elizabeth", "mia", "nanami", "yuna",
  "google uk english female", "google us english", "google français",
  "female", "femme", "féminin",
]);
/** Is this voice positively MALE? Name-based, since the Web Speech API exposes no gender. */
export function isMaleVoice(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (FEMALE_VOICE_NAMES.has(n)) return false;
  if (/\b(female|femme|woman)\b/.test(n)) return false;
  if (/\bmale\b|\bhomme\b|masculin/.test(n)) return true;
  if (MALE_VOICE_NAMES.has(n)) return true;
  // "Google français" IS female but "Google français (France)"-style suffixes vary by platform, so match on
  // the base name rather than a fixed list of spellings.
  if (FEMALE_VOICE_NAMES.has(n.replace(/\s*\([^)]*\)\s*$/, ""))) return false;
  return MALE_VOICE_NAMES.has(n.replace(/\s*\([^)]*\)\s*$/, ""));
}
/** Rank browser voices for `lang` (used only by the browser fallback). ON-DEVICE voices first: Chrome's
 *  "Google …" voices are network voices that fail silently and cut out after ~15s. Wrong-language voices
 *  and FEMALE voices are never returned (see isMaleVoice — the tutor has one voice, and it is a man's).
 *  Exported for unit tests. */
export function rankVoices<V extends { lang: string; name: string; localService: boolean; voiceURI: string }>(voices: V[], lang: string, exclude: Set<string> = new Set()): V[] {
  const want = lang.toLowerCase();
  const base = want.slice(0, 2);
  const score = (v: V): number => {
    const vLang = v.lang.toLowerCase().replace("_", "-");
    let s: number;
    if (vLang === want) s = 8;
    else if (vLang.startsWith(base)) s = 4;
    else return -1;
    if (v.localService) s += 10;
    if (/enhanced|premium|natural|neural/i.test(v.name)) s += 2;
    return s;
  };
  return voices
    .filter((v) => !exclude.has(v.voiceURI))
    .filter((v) => isMaleVoice(v.name))
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

/** ~20ms of silence as a WAV data URI — played inside the mic-toggle click to unlock the <audio> element
 *  for later, non-gesture playback (Safari unlocks per element; Chrome per page). */
function silentWavDataUri(): string {
  const samples = 480, bytes = new Uint8Array(44 + samples * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + samples * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, samples * 2, true);
  let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export interface UseSpeechSynthesis {
  supported: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  cancel: () => void;
  /** Call from INSIDE a real click handler (the mic toggle turning voice ON) so the first reply — which
   *  always arrives async, after a network round trip — isn't blocked by autoplay policy. */
  unlock: () => void;
  /** Set ONLY when speech genuinely failed everywhere (never on a normal success). */
  lastDiagnostic: string | null;
}

type QueueItem = { text: string; retried: boolean };

// The server synthesizes a chunk by calling the free provider and, if that voice fails, the NEXT male voice
// in the pool — so one request can legitimately span two upstream attempts. Sized to cover that (2 × the
// provider's own 12s timeout, server/claude.ts's TTS_TIMEOUT_MS) without becoming a one-minute wait before
// the student hears anything.
const CLOUD_FETCH_TIMEOUT_MS = 25_000;  // slower than this → treat the attempt as failed
const CLOUD_RETRY_DELAY_MS = 1200;      // one quick retry on a transient blip before giving up on a chunk
const START_TIMEOUT_MS = 4000;          // browser engine: a chunk that never starts is treated as dropped
// Playback is bounded by PROGRESS, not by a guess at how long the speech ought to take. The old ceiling
// here was `max(8s, text.length × 110ms)` — a text-length estimate of the audio's duration, which pauses,
// emphasis and any voice slower than that estimate could legitimately exceed, at which point the code
// PAUSED the element mid-sentence. That is the other half of "voices cut off early" (the server's 1000-char
// slice was the first half). So: a generous absolute backstop plus a stall detector that only fires when
// playback has genuinely stopped making progress, which is the thing the ceiling was ever meant to catch.
const PLAY_STALL_MS = 10_000;           // no progress at all for this long → treat it as a stuck stream
const PLAY_CEILING_MS = 15 * 60_000;    // absolute backstop so a session can never hang on one chunk
/** Browser-engine chunks only: some engine implementations never fire `end`, so a chunk that started still
 *  needs a ceiling. Speech runs at roughly 12-15 characters/second, and this is deliberately generous
 *  (~90ms/char) because cutting a student off mid-sentence is worse than waiting a moment longer. */
const browserRunTimeoutMs = (text: string) => Math.max(15_000, text.length * 90);

/** The tutor's voice, via one endpoint (/api/tts) that speaks through a free, keyless, MALE-ONLY voice pool
 *  server-side (server/claude.ts's synthesizeSpeech): no Gemini TTS, no female voice anywhere in the chain,
 *  and a failed voice retries the next male one instead of switching gender.
 *  Direct, explicit request: the browser's own speechSynthesis must NEVER be used as a silent substitute for
 *  a failed cloud voice — "the voice is terrible" was the whole reason the cloud chain exists. When it IS
 *  used (only for a browser with no <audio> element at all — ancient/unusual, `audioSupported` false), it is
 *  filtered to MALE voices by positive name match and stays silent if the platform offers none: a woman's
 *  voice reading the tutor is never an acceptable fallback.
 *
 *  Invariants:
 *  - `speaking` can never get stuck true: every chunk ends via an end event, an error, or a timeout.
 *  - A failed cloud request gets ONE quick retry (transient network blips happen); if that also fails,
 *    the reply is silently skipped (lastDiagnostic set) rather than ever switching to the browser voice.
 *  - Stale work can't touch a newer reply: every speak()/cancel() bumps `genRef`, and every async step
 *    re-checks the generation it started with before doing anything. */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const synthSupported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance !== "undefined";
  const audioSupported = typeof window !== "undefined" && typeof window.Audio !== "undefined";
  const supported = synthSupported || audioSupported;
  const [speaking, setSpeaking] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const badVoicesRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<QueueItem[]>([]);
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopPlaybackRef = useRef<(() => void) | null>(null);
  const urlsRef = useRef<string[]>([]);
  const langRef = useRef(lang);
  langRef.current = lang;

  const fr = () => langRef.current.toLowerCase().startsWith("fr");
  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  const getAudio = () => (audioRef.current ||= new Audio());
  const releaseUrls = () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); urlsRef.current = []; };
  const stopAudio = () => {
    stopPlaybackRef.current?.();
    stopPlaybackRef.current = null;
    const a = audioRef.current;
    if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch { /* ignore */ } }
  };
  const failedEverywhere = (reason: string) => setLastDiagnostic(fr()
    ? `La synthèse vocale a échoué (${reason}). Vérifie la sortie audio de ton appareil.`
    : `Speech playback failed (${reason}). Check your device's sound output.`);

  useEffect(() => {
    if (!synthSupported) return;
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => { window.speechSynthesis.removeEventListener?.("voiceschanged", load); };
  }, [synthSupported]);

  // ── Browser fallback engine ──────────────────────────────────────────────────────────────────────────
  const speakNext = useCallback((gen: number) => {
    if (genRef.current !== gen) return;
    clearTimer();
    const item = queueRef.current.shift();
    if (!item) { setSpeaking(false); return; }
    if (!synthSupported) { queueRef.current = []; setSpeaking(false); failedEverywhere("no-speech-engine"); return; }
    const engine = window.speechSynthesis;
    if (!voicesRef.current.length) voicesRef.current = engine.getVoices();
    const voice = rankVoices(voicesRef.current, langRef.current, badVoicesRef.current)[0];
    // MALE-ONLY: `rankVoices` already filters to male voices, so an empty result here means this browser has
    // no male voice for the language. Speaking anyway would hand the tutor the engine's DEFAULT voice, which
    // on most platforms is a woman's — direct instruction is that this must never happen. Silence instead.
    if (voicesRef.current.length && !voice) {
      console.warn(`[tts] no male browser voice for ${langRef.current} — staying silent rather than using a female voice`);
      queueRef.current = [];
      failedEverywhere("no-male-voice");
      setSpeaking(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(item.text);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = langRef.current; // voice list not loaded yet — let the engine pick for this language
    }
    utter.rate = 1.05;

    let settled = false;
    const settle = (failed: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (genRef.current !== gen) return;
      if (failed) {
        console.warn(`[tts] browser chunk failed (${reason}) with voice "${voice?.name ?? "default"}":`, item.text.slice(0, 60));
        if (voice) badVoicesRef.current.add(voice.voiceURI);
        if (!item.retried) queueRef.current.unshift({ text: item.text, retried: true });
        else failedEverywhere(reason);
        try { if (engine.speaking || engine.pending) engine.cancel(); } catch { /* best-effort */ }
      }
      timerRef.current = setTimeout(() => speakNext(gen), failed ? 80 : 0);
    };
    utter.onstart = () => {
      if (genRef.current !== gen) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        console.warn("[tts] browser chunk never reported its end, moving on:", item.text.slice(0, 60));
        try { engine.cancel(); } catch { /* best-effort */ }
        settle(false, "timeout");
      }, browserRunTimeoutMs(item.text));
    };
    utter.onend = () => settle(false, "end");
    utter.onerror = (e: SpeechSynthesisErrorEvent) => settle(true, e?.error || "error");
    timerRef.current = setTimeout(() => settle(true, "never-started"), START_TIMEOUT_MS);
    try {
      if (engine.paused) engine.resume();
      engine.speak(utter);
    } catch (err: any) {
      settle(true, err?.message || "speak-threw");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synthSupported]);

  const speakWithBrowser = useCallback((gen: number, texts: string[]) => {
    if (genRef.current !== gen) return;
    queueRef.current = texts.flatMap((t) => toSentences(t)).map((t) => ({ text: t, retried: false }));
    if (synthSupported) {
      const engine = window.speechSynthesis;
      const wasBusy = engine.speaking || engine.pending;
      try { if (wasBusy) engine.cancel(); if (engine.paused) engine.resume(); } catch { /* best-effort */ }
      if (wasBusy) { timerRef.current = setTimeout(() => speakNext(gen), 60); return; }
    }
    speakNext(gen);
  }, [synthSupported, speakNext]);

  // ── Cloud voice (free male-voice pool, server-side) ─────────────────────────────────────────────────────
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchChunkOnce = async (text: string): Promise<string> => {
    const r = await api.ttsAudio(text, langRef.current.slice(0, 2), AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS));
    if (!r.ok) { const e: any = new Error(`tts ${r.status}`); e.status = r.status; throw e; }
    const blob = await r.blob();
    if (!blob.size) throw new Error("empty audio");
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  };

  // One quick retry on a transient failure (dropped connection, momentary 429/502) before giving up on this
  // chunk — the server has already walked its whole male-voice pool by the time this throws, so a second
  // failure in a row means something's genuinely down for this request, not worth a longer retry loop.
  const fetchChunk = async (text: string, gen: number): Promise<string> => {
    try { return await fetchChunkOnce(text); }
    catch (e) {
      await sleep(CLOUD_RETRY_DELAY_MS);
      if (genRef.current !== gen) throw e;
      return fetchChunkOnce(text);
    }
  };

  const playUrl = (url: string, text: string): Promise<void> => new Promise((resolve, reject) => {
    const a = getAudio();
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(ceiling);
      clearInterval(stallWatch);
      a.onended = null; a.onerror = null; a.ontimeupdate = null;
      if (stopPlaybackRef.current === stopThis) stopPlaybackRef.current = null;
      if (err) reject(err); else resolve();
    };
    const stopThis = () => finish();
    stopPlaybackRef.current = stopThis;
    // Hard backstop (see PLAY_CEILING_MS) — long enough that no real reply can hit it, but still finite so
    // `speaking` can never get stuck true if an element silently stops firing events.
    const ceiling = setTimeout(() => { try { a.pause(); } catch { /* ignore */ } finish(); }, PLAY_CEILING_MS);
    // Progress-based guard: only fires when currentTime has genuinely not advanced at all (a dead stream),
    // never merely because the audio is running longer than a character-count estimate predicted.
    let lastTime = -1;
    let lastProgressAt = Date.now();
    a.ontimeupdate = () => {
      if (a.currentTime > lastTime + 0.01) { lastTime = a.currentTime; lastProgressAt = Date.now(); }
    };
    const stallWatch = setInterval(() => {
      if (Date.now() - lastProgressAt < PLAY_STALL_MS) return;
      console.warn(`[tts] playback stalled at ${lastTime.toFixed(1)}s — moving on: ${text.slice(0, 60)}`);
      try { a.pause(); } catch { /* ignore */ }
      finish(new Error("audio stalled"));
    }, 1000);
    a.onended = () => finish();
    a.onerror = () => finish(new Error("audio element error"));
    a.src = url;
    a.play().catch((e) => finish(e));
  });

  const speakWithCloud = useCallback(async (gen: number, sentences: string[]) => {
    // Almost always ONE chunk now (see cloudChunks — fewer requests = less quota burn); fetched up front
    // so a multi-chunk reply's later chunks download while the first one plays.
    // The first sentence goes out alone so the voice starts as soon as it is synthesised; the rest are grouped as before
    // and download while it plays (time-to-first-audio ≈ one sentence, not the whole reply).
    const chunks = sentences.length > 1 && sentences[0].length >= 12 ? [sentences[0], ...cloudChunks(sentences.slice(1))] : cloudChunks(sentences);
    const pending = chunks.map((c) => fetchChunk(c, gen));
    pending.forEach((p) => p.catch(() => { /* handled in order below */ }));
    for (let i = 0; i < chunks.length; i++) {
      let url: string;
      try { url = await pending[i]; }
      catch (e) {
        if (genRef.current !== gen) return;
        failedEverywhere("cloud-unavailable");
        releaseUrls();
        setSpeaking(false);
        return;
      }
      if (genRef.current !== gen) return;
      try { await playUrl(url, chunks[i]); }
      catch (e) {
        if (genRef.current !== gen) return;
        failedEverywhere("playback-failed");
        releaseUrls();
        setSpeaking(false);
        return;
      }
      if (genRef.current !== gen) return;
    }
    releaseUrls();
    setSpeaking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Public API ───────────────────────────────────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    if (!supported) {
      setLastDiagnostic(fr() ? "Ce navigateur ne gère pas la synthèse vocale." : "This browser doesn't support speech.");
      return;
    }
    const sentences = toSentences(toSpeakableText(text, langRef.current));
    if (!sentences.length) return;
    const gen = ++genRef.current;
    clearTimer();
    stopAudio();
    releaseUrls();
    setLastDiagnostic(null);
    setSpeaking(true);
    // Cloud voice whenever an <audio> element exists at all — the ONLY case that falls to the browser's own
    // voice is a browser with no <audio> support, where no cloud audio could ever play regardless of the
    // server-side voice pool's success. See this file's top-of-hook comment for why a cloud FAILURE never
    // falls through to the browser voice (that's handled inside speakWithCloud instead, as a silent skip).
    const useCloud = audioSupported;
    if (useCloud) void speakWithCloud(gen, sentences);
    else speakWithBrowser(gen, sentences);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, audioSupported, speakWithCloud, speakWithBrowser]);

  const cancel = useCallback(() => {
    genRef.current++;
    clearTimer();
    queueRef.current = [];
    stopAudio();
    releaseUrls();
    if (synthSupported) {
      try { const engine = window.speechSynthesis; if (engine.speaking || engine.pending) engine.cancel(); } catch { /* best-effort */ }
    }
    setSpeaking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synthSupported]);

  const unlock = useCallback(() => {
    // <audio>: play a blip of silence inside the click so later playback isn't blocked by autoplay policy.
    if (audioSupported) {
      const a = getAudio();
      if (a.paused) { try { a.src = silentWavDataUri(); void a.play().catch(() => { /* best-effort */ }); } catch { /* ignore */ } }
    }
    if (!synthSupported) return;
    const engine = window.speechSynthesis;
    if (engine.speaking || engine.pending) return; // already speaking → already unlocked; don't interrupt
    try {
      if (engine.paused) engine.resume();
      // Non-empty (an EMPTY utterance can wedge the queue), silent, cancelled straight away. Voice pinned to
      // a male one when the browser offers one — this blip is inaudible (volume 0 and cancelled at once),
      // but there's no reason for even the warm-up to hand the engine a female default.
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      const warmVoice = rankVoices(voicesRef.current.length ? voicesRef.current : engine.getVoices(), langRef.current, badVoicesRef.current)[0];
      if (warmVoice) { warm.voice = warmVoice; warm.lang = warmVoice.lang; }
      engine.speak(warm);
      engine.cancel();
    } catch { /* best-effort */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSupported, synthSupported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel, unlock, lastDiagnostic };
}
