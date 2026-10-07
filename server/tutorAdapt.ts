// Tutor adaptation — keeps Otto from looping and lets it learn, per student, WHICH teaching move works.
//
// Two layers, both pure and unit-tested (tests/run.mjs, tests/tutor-sim.mjs):
//  1. REPAIR — detects a stuck conversation (the student repeats themself, says "I told you", "you're not
//     listening", "still don't get it", or Otto's last replies are near-copies) and returns a hard directive:
//     stop the current line, say back what they told you, change the approach, ask ONE different question.
//  2. MOVES — a small Thompson-sampling bandit (server/bandit.ts, same machinery as the other decisions)
//     over teaching moves. Each turn's move is scored by the student's NEXT message (got it / a real attempt
//     = reward, frustration or repeating = penalty) and a move that just failed is never served twice in a row.
import { chooseArm } from "./bandit.ts";
import type { BanditState } from "./bandit.ts";

export interface TutorMoveArm { id: "probe" | "smaller-step" | "worked-parallel" | "visual" | "analogy" | "reflect-back" | "direct-hint" }
export const TUTOR_MOVE_ARMS: TutorMoveArm[] = [
  { id: "probe" }, { id: "smaller-step" }, { id: "worked-parallel" }, { id: "visual" }, { id: "analogy" }, { id: "reflect-back" }, { id: "direct-hint" },
];

const MOVE_TEXT: Record<TutorMoveArm["id"], string> = {
  probe: "ask what they currently think and where exactly it stops making sense — one open question, then listen.",
  "smaller-step": "shrink the step: split what you were about to ask into a tiny first piece they can answer in a few words.",
  "worked-parallel": "show a PARALLEL worked example (same method, different numbers) on the board, leave its last line open, then ask them to do the same on their problem.",
  visual: "stop using words: put a picture on the board (GEOMETRY_ON_BOARD for geometry, DRAW_ON_BOARD, GRAPH_ON_BOARD or a small CREATE_INTERACTIVE) and ask what they notice in it.",
  analogy: "give one everyday analogy for the idea (a real-life situation, not another formula) and ask how it maps onto their problem.",
  "reflect-back": "say back, in your own words, what you think they just said or tried, and ask if you got it right before going further.",
  "direct-hint": "give ONE concrete hint (the rule or the first move, never the answer), then ask them to take the step.",
};

// What a stuck / frustrated student actually types (EN + FR). Deliberately specific phrases — a bare "no" or
// "again" is ordinary conversation and must not trip it.
const FRUSTRATED = /(?:^|\b)(?:no,? but |wait,? no|you (got|have) (it|that) wrong|you('|’)?re wrong|that('|’)?s wrong|(that|it) (is|was)n('|’)?t (right|what)|i('|’)?m not understanding|i don('|’)?t see why)|\b(i (already |just )?(told|said|explained|wrote)( you)?|i['’]?ve (already )?(told|said)|you['’]?re not (listening|understanding|getting)|you (don['’]?t|do not|aren['’]?t) (listen|understand|get it)|that['’]?s not what i (said|meant|asked)|not what i (meant|asked)|still (don['’]?t|do not|not|confused|lost|stuck)|i (really )?(don['’]?t|do not) (understand|get)|i['’]?m (so |still |really )?(lost|confused|stuck)|doesn['’]?t (work|help|make sense)|not working|makes? no sense|you keep (saying|asking|repeating)|same (thing|question) (again|over)|stop (asking|repeating)|going in circles|je t['’]?ai (déjà )?(dit|expliqué)|tu (ne )?(m['’])?(écoutes|comprends) (pas|rien)|ce n['’]?est pas ce que|toujours (pas|perdu)|je (ne )?comprends (toujours )?(pas|rien)|je suis (perdu|paumé)|ça (ne )?(marche|aide) pas|ça n['’]?a (aucun )?sens|tu (te )?répètes|tu tournes en rond)\b/i;
const POSITIVE = /\b(got it|i get it|i see|makes sense|that (helps|works|makes sense)|oh+[!, ]|ah+[!, ]|aha|thanks|thank you|ok(ay)? so|so (it['’]?s|the|that)|c['’]?est (clair|bon)|j['’]?ai (compris|trouvé)|ah (ok|oui|d['’]?accord)|merci|je vois|ça marche)\b/i;

const STOP = new Set("the a an and or of to in is it i you we my me that this what how do does did can be are was were for on with at as so but not no yes ok le la les un une des et ou de du en est je tu il on ce ca que qui quoi pas oui non ne".split(" "));
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}=+\-*/^]+/gu, " ").split(" ").filter((w) => w && !STOP.has(w)));
}
/** Jaccard overlap of content words, 0..1. Short strings (< 3 content words) return 0 — "ok" vs "ok" is not a loop. */
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface Reaction { reward: number; frustrated: boolean; repeated: boolean; label: "frustrated" | "repeated" | "positive" | "attempt" | "neutral" }

/** How the student reacted to the PREVIOUS Otto turn, read from their new message. reward ∈ [0,1]; ≥ 0.5 is a win. */
export function reactionTo(message: string, history: { role: string; text: string }[]): Reaction {
  const m = message.trim();
  const priorUsers = history.filter((h) => h.role === "user").slice(-4).map((h) => h.text);
  const frustrated = FRUSTRATED.test(m);
  const repeated = !frustrated && priorUsers.some((u) => similarity(u, m) >= 0.6);
  if (frustrated) return { reward: 0, frustrated: true, repeated, label: "frustrated" };
  if (repeated) return { reward: 0.1, frustrated: false, repeated: true, label: "repeated" };
  const ex = /^\[Exercise\].*marked (right|wrong)/s.exec(m);
  if (ex) return { reward: ex[1] === "right" ? 1 : 0.3, frustrated: false, repeated: false, label: ex[1] === "right" ? "positive" : "neutral" };
  if (POSITIVE.test(m)) return { reward: 1, frustrated: false, repeated: false, label: "positive" };
  if (m.split(/\s+/).length >= 4 || /[0-9=]/.test(m)) return { reward: 0.75, frustrated: false, repeated: false, label: "attempt" };
  return { reward: 0.4, frustrated: false, repeated: false, label: "neutral" };
}

/** Is Otto going round in circles? True when its last replies are near-copies of each other. */
export function tutorIsLooping(history: { role: string; text: string }[]): boolean {
  const mine = history.filter((h) => h.role === "assistant").slice(-3).map((h) => h.text);
  if (mine.length < 2) return false;
  return similarity(mine[mine.length - 1], mine[mine.length - 2]) >= 0.55;
}

/** A draft that (nearly) repeats one of Otto's recent replies. */
export function repeatsRecentReply(draft: string, history: { role: string; text: string }[]): boolean {
  return history.filter((h) => h.role === "assistant").slice(-3).some((h) => similarity(draft, h.text) >= 0.6);
}

/** The hard directive injected when the conversation is stuck; "" when it isn't. */
export function repairLine(message: string, history: { role: string; text: string }[], reaction = reactionTo(message, history)): string {
  const looping = tutorIsLooping(history);
  if (!reaction.frustrated && !reaction.repeated && !looping) return "";
  const why = reaction.frustrated ? "the student is telling you it isn't working" : reaction.repeated ? "the student just said the same thing again — they don't feel heard" : "your last replies were near-copies of each other";
  const recent = history.filter((h) => h.role === "assistant").slice(-3).map((h) => `• ${h.text.replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
  return `\n\nREPAIR — YOU ARE STUCK IN A LOOP (${why}). This beats every other rule in this prompt:\n` +
    `1. STOP the line you were on. Do not ask the same question again, not even reworded.\n` +
    `2. Start by showing you HEARD them: say back, in your own words and in ONE short sentence, what they are telling you (what they did, what confuses them, or what is not working). Own it plainly if you missed it ("ah, I was pushing the wrong thing") — no grovelling.\n` +
    `3. Then change APPROACH, not wording: use a different representation (a picture or a tiny worked case instead of a question), or ask what exactly they see/want. ONE question at most.\n` +
    `4. If they gave you a method or a number, work WITH it (check it on the board) before steering elsewhere.\n` +
    `Your recent replies — do NOT resemble any of them:\n${recent}\n`;
}

// Last move served per (user, task) so the NEXT message can score it. In-memory and best-effort: losing it on a
// restart only costs one unscored turn.
const lastMove = new Map<string, TutorMoveArm["id"]>();
const LAST_MOVE_CAP = 2000;

export interface MoveDecision { arm: TutorMoveArm["id"]; line: string; scoredPrev?: { arm: TutorMoveArm["id"]; reward: number }; state?: BanditState }

/** Score the move served last turn against the student's reaction now, then pick this turn's move. `state` is the
 *  user's stored bandit state; the returned `state` is the updated one to persist (undefined if nothing changed). */
export function planMove(opts: { userKey: string; message: string; history: { role: string; text: string }[]; state: BanditState; contextKey: string; update: (s: BanditState, key: string, arm: string, reward: number) => BanditState; rng?: () => number }): MoveDecision {
  const reaction = reactionTo(opts.message, opts.history);
  const prev = lastMove.get(opts.userKey);
  let state = opts.state, scoredPrev: MoveDecision["scoredPrev"];
  if (prev && opts.history.length >= 2) {
    state = opts.update(state, opts.contextKey, prev, reaction.reward);
    scoredPrev = { arm: prev, reward: reaction.reward };
  }
  // Never serve a move twice in a row once it has just failed; otherwise Thompson sampling decides (and keeps exploring).
  const failedPrev = prev && reaction.reward < 0.5 ? prev : undefined;
  const pool = TUTOR_MOVE_ARMS.filter((a) => a.id !== failedPrev);
  const arm = chooseArm(pool, state, opts.contextKey, opts.rng).arm.id;
  if (lastMove.size >= LAST_MOVE_CAP) lastMove.delete(lastMove.keys().next().value as string);
  lastMove.set(opts.userKey, arm);
  const line = `\nTEACHING MOVE THIS TURN (chosen from what has worked for THIS student): ${MOVE_TEXT[arm]} Keep every other rule — short, Socratic, never the answer.\n`;
  return { arm, line, scoredPrev, state };
}

const HARSH_OPENERS: [RegExp, string][] = [
  [/^(?:careful|watch out|attention)\s*[—–:,-]\s*/i, "Hm, let's check that — "],
  [/^(?:no|nope|wrong|incorrect|not quite|non|faux)[,.!:—–-]\s*/i, "Almost — let's look closer. "],
  [/^that(?:'|’)?s (?:not right|wrong|incorrect|not correct|false)[,.!:—–-]?\s*/i, "Let's check that together. "],
  [/^actually[,:]?\s+/i, "Hm, one thing to check — "],
];
/** A reply must never OPEN harshly. Rewrites a leading "Careful —" / "No," / "Wrong." into a gentler lead-in
 *  (the persona forbids them; this is the backstop for a draft that did it anyway). */
export function softenOpener(text: string): string {
  const t = text.trimStart();
  for (const [re, rep] of HARSH_OPENERS) if (re.test(t)) return t.replace(re, rep);
  return text;
}

const SPOKEN: [RegExp, string][] = [
  [/\b(?:square root of|racine carrée de)\b/gi, "√"], [/\bsquared\b/gi, "²"], [/\bcubed\b/gi, "³"], [/\bover\b/gi, "/"],
  [/\bco-?tan(?:gent)?\b/gi, "cot"], [/\bco-?sine\b/gi, "cos"], [/\bsine\b/gi, "sin"], [/\btangent\b/gi, "tan"], [/\bsecant\b/gi, "sec"], [/\bcosecant\b/gi, "csc"],
  [/\b(?:plus)\b/gi, "+"], [/\b(?:minus)\b/gi, "−"], [/\b(?:times|multiplied by)\b/gi, "×"], [/\b(?:equals|is equal to)\b/gi, "="], [/\bpi\b/gi, "π"], [/\btheta\b/gi, "θ"],
];
/** Dictated / speech-to-text maths ("three times one over cotan squared minus 3 over cosine") reads fine to a
 *  human but its STRUCTURE (what sits under which fraction bar, what a bracket holds) is lost. When a message looks
 *  dictated, hand the tutor a literal symbol transcription AND the reminder that the grouping is unreliable. */
export function spokenMathHint(message: string): string {
  const hits = (message.match(/\b(over|squared|cubed|cosine|co-?tan|sine|tangent|secant|plus|minus|times|equals|square root)\b/gi) || []).length;
  if (hits < 2 || message.length > 400) return "";
  let s = message;
  for (const [re, rep] of SPOKEN) s = s.replace(re, rep);
  s = s.replace(/\s+/g, " ").trim();
  return `\n\nDICTATED MATHS: the student's message looks spoken/transcribed. Literal symbol reading: «${s}». The GROUPING (what is under which fraction bar, what a bracket holds, what multiplies what) is NOT reliable in speech — write your typeset reading on the board and confirm it with them before working on it, and if a word looks like a transcription slip ("Cortex" for "cot x"), say what you took it to mean.\n`;
}

/** What the tutor is ASKING about: the specific values/expressions in its final question — angles/units ("270°",
 *  "5π/6"), and small arithmetic expressions ("7 × 8"). Plain bare numbers are ignored (too common to mean anything). */
export function askedTokens(reply: string): string[] {
  const q = (reply.match(/[^.!?\n]*\?/g) || []).slice(-2).join(" ");
  const toks = new Set<string>();
  for (const m of q.matchAll(/\d+(?:[.,]\d+)?\s*(?:°|π|pi\b|rad\b|degrees?\b|degrés?\b)|\d*π(?:\s*\/\s*\d+)?|\b\d+(?:[.,]\d+)?\s*[×x*+\-−/÷^]\s*\d+(?:[.,]\d+)?/gi)) toks.add(m[0].replace(/\s+/g, "").toLowerCase());
  return [...toks].filter((t) => t.length >= 2);
}

/** Does any of these board entries already STATE a value for something the question asks about? (e.g. the board
 *  shows "270°: (0, −1)" while Otto asks "what's cos(270°) and sin(270°)?" — the question answers itself.)
 *  Returns the indices of the offending entries. A "?" placeholder after the marker is fine. */
export function boardStatesAskedValue(reply: string, entries: { text?: string; diagram?: { text?: string; latex?: string }[] }[]): number[] {
  const toks = askedTokens(reply);
  if (!toks.length) return [];
  const bad: number[] = [];
  entries.forEach((e, i) => {
    const hay = [e.text || "", ...(e.diagram || []).map((o) => `${o.text || ""} ${o.latex || ""}`)].join("\n").replace(/[ \t]+/g, "").toLowerCase();
    for (const tok of toks) {
      const esc = tok.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
      // token, then (within a few chars of function/bracket noise) a value marker and a real value that isn't "?"
      if (new RegExp(`${esc}[)\\]]?(?:[:=→⇒]|-->|->|=>|\\\\to|\\\\rightarrow)(?!\\?|\\s*$)[^\\n]{1,}`).test(hay)) { bad.push(i); break; }
    }
  });
  return bad;
}

// ---- Socratic scaffolding (Graesser's tutoring frame: pump → prompt → hint → partial example → assertion last) ----
const STUCK = /\b(i don['’]?t know|idk|no idea|not sure|i give up|i['’]?m (?:so |still |really )?(?:lost|stuck)|je ne sais pas|je sais pas|aucune id[ée]e|je suis (?:perdu|bloqu[ée])|help me|aide[- ]moi)\b|^\s*\??\s*$|^\s*(?:what|quoi)\s*\??\s*$/i;
const isStuckMsg = (m: string): boolean => STUCK.test(m.trim()) || /^\[Exercise\].*marked wrong/s.test(m.trim());

/** How many of the student's most recent turns in a row (including this one) show they're stuck. */
export function stuckStreak(message: string, history: { role: string; text: string }[]): number {
  let n = isStuckMsg(message) ? 1 : 0;
  if (!n) return 0;
  const users = history.filter((h) => h.role === "user").map((h) => h.text).reverse();
  for (const u of users) { if (isStuckMsg(u)) n++; else break; }
  return n;
}

/** The escalation rung for THIS turn: help in the smallest dose that unlocks them, never the answer. */
export function scaffoldLine(message: string, history: { role: string; text: string }[]): string {
  const n = stuckStreak(message, history);
  if (!n) return "";
  const rung = n === 1
    ? "PUMP: they're stuck, so don't explain. First NORMALISE it in a few warm words (\"this one's fiddly — most people trip here\"), then ask what they DO know or have tried so far, or one much smaller question about the first thing in the problem that they can answer in a few words."
    : n === 2
      ? "PROMPT: still stuck — give a cue, not the step: a fill-in-the-blank frame (\"the area of a sector uses ___ × r²\") or point at the relevant given on the board, then ask them to supply the missing piece."
      : "PARTIAL EXAMPLE: several attempts, still stuck — put a PARALLEL worked example (different numbers) on the board with its last line left open as \"?\", plus ONE concrete hint about the method. Still never their answer; then ask them to do the open step on their own problem. Acknowledge that this one is genuinely tricky.";
  return `\n\nSCAFFOLD LEVEL ${Math.min(n, 3)} (the student has been stuck ${n} turn${n > 1 ? "s" : ""} running) — ${rung}\n`;
}

const PROBES = [
  "JUSTIFY: ask why that step is allowed / why it works (\"what lets you do that?\").",
  "ASSUMPTIONS: ask what they're assuming and whether it always holds (\"is that true for every x? what if it's negative?\").",
  "ANOTHER WAY: ask whether there's a different route to the same result and which they'd trust more.",
  "CHECK IT: ask how they could test their result themselves (plug a value back in, estimate, check units, sanity-check a limit).",
  "GENERALISE: ask what stays the same if the numbers change, or to state the rule in their own words (self-explanation).",
  "REFLECT: ask how sure they are (1–5) and what in their method felt shakiest, or what they'd do differently next time.",
];
/** Every few turns of PROGRESS, a critical-thinking probe — the IB learner-profile habits (thinker, inquirer,
 *  reflective, communicator) made concrete: justify, question assumptions, find another way, self-check, generalise, reflect. */
export function probeLine(message: string, history: { role: string; text: string }[]): string {
  const assistantTurns = history.filter((h) => h.role === "assistant").length;
  if (assistantTurns < 3 || assistantTurns % 3 !== 0) return "";
  const r = reactionTo(message, history);
  if (r.label !== "attempt" && r.label !== "positive") return "";
  return `\n\nCRITICAL-THINKING PROBE THIS TURN (they are making progress — deepen it, don't just move on). After a brief SPECIFIC acknowledgement of what was right, ask ONE of these in your own words: ${PROBES[Math.floor(assistantTurns / 3) % PROBES.length]}\n`;
}

/** A tutor turn that asks the student nothing is a lecture. True when a reply to a real student contribution
 *  contains no question at all (so a corrective round should add ONE guiding question). */
export function needsQuestion(draft: string, message: string): boolean {
  if (!draft.trim() || /[?？]/.test(draft)) return false;
  if (/^(?:thanks?|thank you|merci|bye|au revoir|ok(?:ay)? thanks|great thanks|c['’]est tout|that['’]?s all)\b/i.test(message.trim()) && message.trim().length < 40) return false;
  return message.trim().length > 0;
}

/** Genuine, brief cheer at real milestones (never every turn): a streak of right exercises, or every session
 *  objective ticked off. The line asks for a few specific words and then a raised challenge — not gushing. */
export function cheerLine(message: string, history: { role: string; text: string }[], objectives?: { done: boolean }[]): string {
  const recent = [...history.filter((h) => h.role === "user").map((h) => h.text).slice(-5), message];
  const rights = recent.filter((m) => /^\[Exercise\].*marked right/s.test(m.trim())).length;
  const justRight = /^\[Exercise\].*marked right/s.test(message.trim());
  if (justRight && rights >= 2) return `\n\nMILESTONE: that's ${rights} exercises right recently. Give a short, genuine, SPECIFIC cheer (what they did well — a few words, no gushing), then raise the challenge a notch or ask what they want to tackle next.\n`;
  if (objectives?.length && objectives.every((o) => o.done)) return `\n\nMILESTONE: every objective for this session is done. Say so warmly in a few words, name one thing they did well, and ask what they'd like to do next (more practice, a harder one, or wrap up with a reflection).\n`;
  return "";
}
