// The live voice tutor: ONE conversation with a speech-to-speech model (Gemini Live) that sounds like a person, while Otto's
// own engine stays the brain and the pen — it checks the maths, decides the next question and writes on the board. The voice
// model never solves, computes or writes anything itself: for every thing the student says about the work it calls `ask_otto`
// and then says what comes back. Pure (no SDK imports) so the server, the browser and the tests share it.

export const LIVE_TOOL_NAME = "ask_otto";

export interface LiveToolArgs { student_said: string }
export interface LiveToolResult { say: string; board?: string; error?: string }

/** The tool as a Gemini function declaration (JSON-schema style; `type` strings are the SDK's enum values). */
export const ASK_OTTO_DECLARATION = {
  name: LIVE_TOOL_NAME,
  description: "Hand what the student just said to Otto, the tutor's brain. Otto checks the maths, chooses the next guiding question and writes on the shared board. Returns the words to say aloud.",
  parameters: {
    type: "OBJECT",
    properties: {
      student_said: { type: "STRING", description: "What the student just said about the work, as close to their own words as you heard them (numbers and symbols included)." },
    },
    required: ["student_said"],
  },
} as const;

export function liveInstructions(o: { subject?: string; level?: string; opener?: string; resuming?: boolean }): string {
  const focus = !o.subject || /anything|other/i.test(o.subject) ? "any school subject" : o.subject;
  return `You are Otto, a warm Socratic tutor for ${o.level ? `${o.level} ` : "school "}students, here to help with ${focus}. Speak English. You are the VOICE of a tutoring team: you talk like a favourite human teacher sitting beside the student with a sheet of paper (patient, curious about how they think, never judgmental), while Otto's brain, behind the tool ask_otto, does the thinking and the writing on the shared board.

HOW EVERY TURN WORKS
- Whenever the student says anything about the work (an answer, a guess, an idea, a question, "I don't get it", "write that down", "draw it", "start over", "can we do a different one"), call ask_otto with their words. Before the call say at most five words once ("Let me check that", "Hm, one second"). Then WAIT for the result.
- When ask_otto returns, say what it returned in a natural spoken way: the same meaning, the same single question at the end, in one to three short sentences. Never add facts, numbers, steps, hints or answers of your own, and never skip its question. If board is not empty you may add "it's on the board". If it returns an error, say so in a few words and ask them to repeat.
- You never solve, compute, check or explain the maths yourself, and you never give the answer, even if asked. Greetings, thanks, "ok", "mm-hm" and small talk you answer yourself in one short sentence, then ask what they want to work on.
- If the student interrupts, stop and listen. If their words make no sense (a noisy line), say it didn't come through and ask them to say it again; do not call the tool on noise.
- Plain words, contractions, short sentences, no lists. A little warmth when a feeling shows; no filler praise.

${o.opener ? `OPENING: when the call starts, greet them in your own words based on this opening line, in one or two short sentences, ending with its question: "${o.opener.slice(0, 400)}"` : o.resuming ? "OPENING: welcome them back in one short sentence and ask where they want to continue." : "OPENING: greet them in one short sentence and ask what they want to work on."}`;
}

/** What the model hears for a message the student TYPED while the call is open: say Otto's reply in the voice. */
export function sayThis(text: string): string {
  return `(The student typed instead of speaking. Say the following to them now in your own natural voice, same meaning, no additions: ${String(text).slice(0, 900)})`;
}

/** Otto's reply (markdown + LaTeX in $…$) as plain spoken words for the voice model: the app's own maths-to-words function does the converting. */
export function toolResultFor(reply: string, wroteBoard: boolean, toSpoken: (md: string) => string): LiveToolResult {
  const say = toSpoken(String(reply || "")).replace(/\s+/g, " ").trim();
  return say ? { say, ...(wroteBoard ? { board: "Otto wrote on the board" } : {}) } : { say: "", error: "Otto had nothing to say. Ask the student to try again." };
}
