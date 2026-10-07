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
  visual: "stop using words: put a picture on the board (DRAW_ON_BOARD, GRAPH_ON_BOARD or a small CREATE_INTERACTIVE) and ask what they notice in it.",
  analogy: "give one everyday analogy for the idea (a real-life situation, not another formula) and ask how it maps onto their problem.",
  "reflect-back": "say back, in your own words, what you think they just said or tried, and ask if you got it right before going further.",
  "direct-hint": "give ONE concrete hint (the rule or the first move, never the answer), then ask them to take the step.",
};

// What a stuck / frustrated student actually types (EN + FR). Deliberately specific phrases — a bare "no" or
// "again" is ordinary conversation and must not trip it.
const FRUSTRATED = /\b(i (already |just )?(told|said|explained|wrote)( you)?|i['’]?ve (already )?(told|said)|you['’]?re not (listening|understanding|getting)|you (don['’]?t|do not|aren['’]?t) (listen|understand|get it)|that['’]?s not what i (said|meant|asked)|not what i (meant|asked)|still (don['’]?t|do not|not|confused|lost|stuck)|i (really )?(don['’]?t|do not) (understand|get)|i['’]?m (so |still |really )?(lost|confused|stuck)|doesn['’]?t (work|help|make sense)|not working|makes? no sense|you keep (saying|asking|repeating)|same (thing|question) (again|over)|stop (asking|repeating)|going in circles|je t['’]?ai (déjà )?(dit|expliqué)|tu (ne )?(m['’])?(écoutes|comprends) (pas|rien)|ce n['’]?est pas ce que|toujours (pas|perdu)|je (ne )?comprends (toujours )?(pas|rien)|je suis (perdu|paumé)|ça (ne )?(marche|aide) pas|ça n['’]?a (aucun )?sens|tu (te )?répètes|tu tournes en rond)\b/i;
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
