// Numbers a student actually said (digits or words), and whether a transcribed claim is made only of them.
const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, half: 2, third: 3, quarter: 4, fifth: 5, squared: 2, cubed: 3, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six_: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

/** Every number the student actually said, as digits or words ("nine", "squared" counts as 2), so a transcribed claim can be held to it. Pure. */
const SUPER_SUB: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "⁻": "-", "₋": "-" };
/** Unicode superscripts and subscripts as plain digits ("x²" → "x2", "CO₂" → "CO2"), so they count as numbers that were written. */
export const plainDigits = (t: string): string => String(t || "").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉⁻₋]/g, (c) => SUPER_SUB[c] || c);

export function numbersSaid(raw: string): Set<number> {
  const text = plainDigits(raw);
  const out = new Set<number>();
  for (const m of String(text || "").matchAll(/\d+(?:[.,]\d+)?/g)) out.add(Number(m[0].replace(",", ".")));
  const lower = String(text || "").toLowerCase();
  for (const w of lower.match(/[a-zà-ÿ]+/g) || []) if (w in NUMBER_WORDS) out.add(NUMBER_WORDS[w]);
  // "forty-five", "three point five"
  for (const m of lower.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/g)) out.add(NUMBER_WORDS[m[1]] + NUMBER_WORDS[m[2]]);
  for (const m of lower.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\s+point\s+((?:zero|one|two|three|four|five|six|seven|eight|nine)(?:\s+(?:zero|one|two|three|four|five|six|seven|eight|nine))*)\b/g)) out.add(Number(`${NUMBER_WORDS[m[1]]}.${m[2].split(/\s+/).map((w) => NUMBER_WORDS[w]).join("")}`));
  return out;
}

/** A transcribed claim is only trusted when every number in it was said by the student: a model that "transcribes" a number nobody said would
 *  otherwise make the second opinion accuse the tutor, and the student, of an error that is not there. Pure. */
export function claimIsGrounded(claim: string, said: string): boolean {
  const spoken = numbersSaid(said);
  const nums = [...String(claim || "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return nums.length > 0 && nums.every((n) => spoken.has(n) || n === 1 || n === 0);
}

