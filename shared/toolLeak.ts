// Display-side backstop for tool-call plumbing that leaked into a saved reply ("#%%call:default_api:",
// "WRITE_TO_BOARD(gap, …)", "[write_to_board]{…}"). The server strips these before a reply is sent
// (server/ai/client.ts stripLeakedToolCallSyntax); this catches messages saved before a new leak shape was
// handled, so the student never sees them on screen or hears them read aloud. Pure.
const NAME = String.raw`(?:[A-Za-z]+_)+(?:board|board_line)|create_problem|set_objectives`;
const CALL = new RegExp(String.raw`[#%@!&*~^\w]*\[\s*(?:${NAME})\s*\]|[#%@!&*~^]*\b(?:${NAME})\b`, "gi");
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** End (exclusive) of the balanced bracket group opening at `at`; the text's end when it never closes. */
function groupEnd(text: string, at: number): number {
  const stack: string[] = [];
  for (let i = at; i < text.length; i++) {
    if (CLOSE[text[i]]) stack.push(CLOSE[text[i]]);
    else if (text[i] === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return text.length;
}

export function hideToolLeaks(text: string): string {
  let t = String(text || "");
  // A tool name and the argument group right after it go; the prose around them stays.
  for (let guard = 0; guard < 30; guard++) {
    CALL.lastIndex = 0;
    const m = CALL.exec(t);
    if (!m) break;
    let end = m.index + m[0].length;
    const gap = /^\s*[:=]?\s*/.exec(t.slice(end))![0];
    if (CLOSE[t[end + gap.length]]) end = groupEnd(t, end + gap.length);
    t = t.slice(0, m.index).replace(/[ \t]+$/, "") + " " + t.slice(end).replace(/^[ \t]+/, "");
  }
  // Template residue: everything from "default_api" / "<call:" / "%%" onwards is plumbing.
  const cut = t.search(/[#%@!&*~^]*\b(?:call\s*:\s*)?default_api\b|<\/?call:|#?%%/i);
  if (cut >= 0) t = t.slice(0, cut);
  return t.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
