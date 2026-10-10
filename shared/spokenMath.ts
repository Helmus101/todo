// Speech-to-text repair for spoken maths. Browser speech recognition is tuned for everyday speech, so maths
// comes out mangled in ways a human tutor would see through at once. These are real examples from one
// session (the tower problem with angles 15° and 25°):
//   "tan 25 = h / b"          → "1025 = height over b"   ("tan" heard as "ten" → "10", then merged with 25)
//   "opposite over adjacent"  → "opposite over json"
//   "b = h / tan 25"          → "b = count 25/8"
// This module proposes what the student most likely SAID, using what's on the board and in the problem (which
// angles, which trig functions, which letters). It only proposes: every change is listed so the tutor can
// judge, confirm briefly when the change matters, and never repeat the garbled words back. Pure.

export interface SpokenContext {
  /** Angles (in degrees) that appear on the board / in the problem: 15, 25, … */
  angles: number[];
  /** Trig functions in play: "sin" | "cos" | "tan" | … */
  fns: string[];
  /** Single-letter variables in play: "h", "b", "x", … */
  vars: string[];
}

export interface SpokenRepair {
  /** The transcript with every likely mishearing replaced (unchanged when nothing looked wrong). */
  interpreted: string;
  changes: { from: string; to: string; why: string }[];
  /** "high" when every change is backed by the board context; "low" when any one is a guess. */
  confidence: "high" | "low";
}

const TRIG = ["sin", "cos", "tan", "cot", "sec", "csc"];
const EVERYDAY = /^(?:can|count|ten|tin|ton|town|turn|sign|seen|sing|scene|cause|because|cost|course|cut|caught|court)$/i;

/** What the board / problem text says is in play. Accepts LaTeX or plain text. */
export function spokenContextFrom(texts: string[]): SpokenContext {
  const all = texts.join("\n");
  const angles = new Set<number>();
  for (const m of all.matchAll(/(\d{1,3}(?:\.\d+)?)\s*(?:°|\^\s*\{?\\circ\}?|\\circ|\s?deg(?:rees?)?\b|\s?degrés?\b)/gi)) angles.add(Number(m[1]));
  const fns = TRIG.filter((f) => new RegExp(`(?:\\\\|\\b)${f}\\b`, "i").test(all));
  const vars = new Set<string>();
  for (const m of all.replace(/\\[a-zA-Z]+/g, " ").matchAll(/(?<![A-Za-z])([a-zA-Z])(?![A-Za-z])/g)) vars.add(m[1]);
  return { angles: [...angles], fns, vars: [...vars] };
}

// Words a recognizer substitutes for a trig function name. Only applied right before an angle that's in play
// (or an opening bracket), so ordinary uses of "can", "count", "sign" are left alone.
const FN_SOUNDALIKES: [string, RegExp][] = [
  ["tan", /^(?:tan|tans|tam|tang|ten|tin|ton|town|turn|count|can|10)$/i],
  ["sin", /^(?:sin|sign|sine|sane|seen|sing|scene)$/i],
  ["cos", /^(?:cos|coast|cause|cosign|kos|cost|course|coz|because)$/i],
  ["cot", /^(?:cot|cut|caught|court)$/i],
];
// Whole words a recognizer substitutes for a maths word, regardless of position.
const WORD_SOUNDALIKES: [RegExp, string, string][] = [
  [/\b(?:json|jason|jayson|a\s?jason|a\s?json|ajay\s?sent|adjacents)\b/gi, "adjacent", "sounds like \"adjacent\""],
  [/\b(?:hypothenuse|hippopotamus|high\s?pot(?:en|in)use|hypotenus)\b/gi, "hypotenuse", "sounds like \"hypotenuse\""],
  [/\bcortex\b/gi, "cot x", "sounds like \"cot x\""],
  [/\b(?:opposites?|a\s?posit)\b/gi, "opposite", "sounds like \"opposite\""],
];

export function repairSpokenMath(transcript: string, ctx: SpokenContext): SpokenRepair {
  const changes: SpokenRepair["changes"] = [];
  let low = false;
  let s = String(transcript || "");
  const trigInPlay = ctx.fns.length > 0 || /\b(?:tan|sin|cos|opposite|adjacent|hypotenuse|angle|elevation|depression)\b/i.test(s);
  const knownAngle = (n: string) => ctx.angles.includes(Number(n));

  for (const [re, to, why] of WORD_SOUNDALIKES) {
    s = s.replace(re, (m) => { if (m.toLowerCase() === to) return m; changes.push({ from: m, to, why }); return to; });
  }

  if (trigInPlay && ctx.angles.length) {
    // "1025" / "1015": "tan" heard as "ten" and fused with the angle that follows it.
    s = s.replace(/\b10(\d{1,2})\b/g, (m, a: string) => {
      if (!knownAngle(a)) return m;
      changes.push({ from: m, to: `tan ${a}°`, why: `"tan" heard as "ten" and merged with the ${a}° angle on the board` });
      return `tan ${a}°`;
    });
    // "<soundalike> 25" → "tan 25°": a function-sounding word right before a known angle.
    s = s.replace(/(^|.{0,12}?)\b([A-Za-z]+|10)\s+(?:of\s+)?(\d{1,3})(?!\d)(\s*°)?(?=(.{0,12}))/g, (m, before: string, w: string, a: string, deg: string | undefined, after: string) => {
      if (!knownAngle(a)) return m;
      const hit = FN_SOUNDALIKES.find(([, re]) => re.test(w));
      if (!hit) return m;
      // An everyday word ("I can 15…", "count 25 people") only counts when it sits in maths: next to an
      // operator or a maths word. "10", "tam", "sine" etc. are never everyday words before an angle.
      const mathsNear = /[=+\-*/×÷()]|\b(?:over|times|equals?|plus|minus|is)\b/i;
      if (EVERYDAY.test(w) && !mathsNear.test(before) && !mathsNear.test(after)) return m;
      m = m.slice(before.length);
      const to = `${hit[0]} ${a}°`;
      if (w.toLowerCase() === hit[0] && deg) return m;
      if (w.toLowerCase() !== hit[0]) {
        changes.push({ from: m.trim(), to, why: `"${w}" right before the ${a}° angle is most likely "${hit[0]}"` });
        // Backed by the board only when that function is actually in play there.
        if (!ctx.fns.includes(hit[0])) low = true;
      }
      return before + to;
    });
  }

  // Letter names heard as numbers/words ("h" → "8"/"age", "b" → "be", "x" → "ex", "y" → "why"). Only when the
  // letter is a variable in play AND the word sits in a maths position (next to an operator) — always a guess.
  const LETTERS: [string, RegExp][] = [["h", /^(?:8|age|each|aitch|edge)$/i], ["b", /^(?:be|bee)$/i], ["x", /^(?:ex|eggs)$/i], ["y", /^(?:why)$/i], ["c", /^(?:see|sea)$/i]];
  s = s.replace(/(^|[=+\-*/×÷(]\s*|\bover\s+|\btimes\s+)([A-Za-z]+|8)(?=\s*(?:$|[=+\-*/×÷)]|\bover\b|\btimes\b))/gi, (m, pre: string, w: string) => {
    const hit = LETTERS.find(([v, re]) => ctx.vars.includes(v) && re.test(w));
    if (!hit) return m;
    changes.push({ from: w, to: hit[0], why: `"${w}" in a maths position, and ${hit[0]} is a variable in this problem` });
    low = true;
    return `${pre}${hit[0]}`;
  });

  return { interpreted: s.replace(/\s{2,}/g, " ").trim(), changes, confidence: low ? "low" : "high" };
}
