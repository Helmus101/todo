// An independent look at what the tutor just SAID. The voice model hears audio and answers on its own; nothing else reads its words. After each
// finished tutor turn one cheap, temperature-0 call is given the board, the last few turns and the tutor's last words, and says whether the tutor
//   - stated the result of the step the student is working on (or the next step) before the student did,
//   - agreed to something the student did not actually say as an answer ("Power 2", "Hi", "dart", "Um"),
//   - made a mathematical claim that is false (it recomputes it),
//   - said something is on the board, or is not, against the board listing.
// A flag only counts when the judge quotes the offending words and those words really are in the tutor's turn, so a judge that invents a quote is
// ignored. The result is a private note the tutor reads and answers with its own words; nothing canned is ever shown to the student.
import { createTutorChat, usageOf } from "../claude.ts";
import { extractJsonObject } from "../../shared/tutorTurn.ts";
import { renderJudgeRubric } from "../../shared/tutorCharter.ts";

export interface SpokenFlag { kind: "gaveResult" | "confirmedUnclear" | "falseMath" | "claimedBoard" | "ignoredRoute" | "stockPraise"; quote: string; fix: string }

const SYSTEM = `You audit ONE spoken turn of an AI maths/science tutor. You do not teach and you do not speak to the student. Input: the board (numbered lines), the last few turns ("Student:" / "Tutor:" lines; the LAST Tutor line is the turn you audit), and nothing else.

Report each problem you find, quoting the tutor's own words EXACTLY as they appear in the last Tutor line. The kinds:
${renderJudgeRubric()}

Be strict about evidence and lenient about style: only report a clear problem, and when in doubt report nothing. Fewer, correct flags are far better than many doubtful ones.
Return ONLY JSON: {"flags":[{"kind":"gaveResult|confirmedUnclear|falseMath|claimedBoard|ignoredRoute","quote":"exact words from the last Tutor line","fix":"what the tutor should do now, in one short sentence addressed to the tutor"}]} with an empty list when the turn is fine.`;

/** Pure: the flags the judge returned, kept only when their quote really is in the tutor's turn. Exported for tests. */
export function parseSpokenFlags(raw: unknown, tutorTurn: string): SpokenFlag[] {
  const kinds = ["gaveResult", "confirmedUnclear", "falseMath", "claimedBoard", "ignoredRoute"];
  const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const turn = flat(tutorTurn);
  const parsed: any = typeof raw === "string" ? extractJsonObject(raw) : raw;
  const list = Array.isArray(parsed?.flags) ? parsed.flags : [];
  const out: SpokenFlag[] = [];
  for (const f of list.slice(0, 4)) {
    const quote = typeof f?.quote === "string" ? f.quote.trim().slice(0, 200) : "";
    if (!kinds.includes(f?.kind) || quote.length < 4 || !turn.includes(flat(quote))) continue;
    out.push({ kind: f.kind, quote, fix: typeof f?.fix === "string" ? f.fix.trim().slice(0, 240) : "" });
  }
  return out;
}

/** Pure: the private note for the tutor, or "" when there is nothing to say. The tutor answers in its own words. */
export function spokenCheckNote(flags: SpokenFlag[], opts?: { rewrite?: boolean }): string {
  if (!flags.length) return "";
  const lines = flags.map((f) => {
    const what = f.kind === "gaveResult" ? "you stated a result or next step the student had not reached"
      : f.kind === "confirmedUnclear" ? "you agreed to something that was not a real answer"
      : f.kind === "falseMath" ? "that is not correct"
      : f.kind === "stockPraise" ? "that opens with stock praise"
      : f.kind === "ignoredRoute" ? "they had named their own method and you steered away from it"
      : "that does not match the board";
    return `You said "${f.quote}": ${what}.${f.fix ? ` ${f.fix}` : ""}`;
  });
  if (opts?.rewrite) return `Private note for you, not from the student: your reply was checked before they heard it. ${lines.join(" ")} They have not heard it yet: write the reply again without that problem, hand the question back to them, and do not mention this note.`;
  // No "own it" speech: asked to own each note, the tutor opened turn after turn with an apology about itself ("I've been treating your
  // half-sentences as answers…") and the lesson stopped. A wrong fact is corrected in a few words; everything else is simply not done again.
  return `Private note for you, not from the student: ${lines.join(" ")} If you stated something false, correct it in a few words at your next turn; otherwise say nothing about it and simply do not do it again. No apology, no talk about your own mistakes, and do not mention this note: carry on with the lesson and hand the question back to them.`;
}

export async function checkSpokenTurn(input: { exchange: string; listing: string }, tokens: { in: number; out: number; cachedIn: number }): Promise<SpokenFlag[]> {
  const lines = String(input.exchange || "").split("\n").filter((l) => l.trim());
  const lastTutor = [...lines].reverse().find((l) => /^Tutor:/i.test(l));
  if (!lastTutor) return [];
  const turn = lastTutor.replace(/^Tutor:\s*/i, "");
  if (turn.trim().length < 12) return [];
  try {
    const res = await createTutorChat({
      max_tokens: 500, temperature: 0, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `BOARD:\n${String(input.listing || "(empty)").slice(0, 2500)}\n\nTURNS:\n${lines.slice(-8).join("\n").slice(-2500)}` },
      ],
    }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const lastStudent = ([...lines].reverse().find((l) => /^Student:/i.test(l)) || "").replace(/^Student:\s*/i, "");
    return withStockPraise(parseSpokenFlags(String(res?.choices?.[0]?.message?.content || ""), turn).filter((f) => f.kind !== "confirmedUnclear" || !isRealAnswer(lastStudent)), turn);
  } catch { return withStockPraise([], turn); }
}

const MATHS_IN_SPEECH = /\d|[=+\-*/^√]|\b(?:over|minus|plus|times|squared?|cubed?|root|equals?|divided|half|double[sd]?|quadruples?|twice|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b[b-df-hj-np-xz]\b/i; // a lone letter is a variable (not a, e, i, o, y: words in English or Spanish)
/** Pure: the student's line is a real turn, not microphone noise: it carries maths ("2L over T2", "L minus X") or is a whole sentence (six words
 *  or more). The judge called such terse spoken answers "not a real answer" turn after turn, and each false note derailed the tutor. Only a short
 *  line with no maths in it ("most valuable", "lleva", "um") can be agreed-to noise. */
export function isRealAnswer(studentLine: string): boolean {
  const t = String(studentLine || "").trim();
  if (!t) return false;
  return t.split(/\s+/).length >= 6 || MATHS_IN_SPEECH.test(t);
}

/** The deterministic flag (stock praise opener) joins whatever the judge found. Pure. */
export function withStockPraise(flags: SpokenFlag[], tutorTurn: string): SpokenFlag[] {
  const opener = stockPraiseOpener(tutorTurn);
  return opener ? [...flags, { kind: "stockPraise", quote: opener, fix: "Open with what they did, in their own terms, or just ask the next thing; no praise word." }] : flags;
}

const STOCK_OPENERS = /^\s*(?:(?:oh|ah|ok(?:ay)?|yes|yep|yeah|right|so|and)[,!.\s]+)*(?:exactly(?=\s*(?:[.!,]|$))|spot on|perfect(?:ly)?|great(?: job| question| work)?|wonderful|absolutely|brilliant|excellent|fantastic|awesome|that'?s (?:spot on|exactly (?:right|it)|perfect|great)|you'?re exactly right|that is exactly right|well done)\b/i;
/** Pure: the tutor's turn opens with stock praise ("Exactly", "That's spot on", "Perfect"), which the charter bans: returns the opening words, or "". Code can see this; no model call. */
export function stockPraiseOpener(tutorTurn: string): string {
  const m = STOCK_OPENERS.exec(String(tutorTurn || "").trim());
  return m ? m[0].trim() : "";
}
