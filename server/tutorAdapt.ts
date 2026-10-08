// Tutor adaptation — keeps Otto from looping and lets it learn, per student, WHICH teaching move works.
//
// Two layers, both pure and unit-tested (tests/run.mjs, tests/tutor-sim.mjs):
//  1. REPAIR — detects a stuck conversation (the student repeats themself, says "I told you", "you're not
//     listening", "still don't get it", or Otto's last replies are near-copies) and returns a hard directive:
//     stop the current line, say back what they told you, change the approach, ask ONE different question.
//  2. MOVES — a small Thompson-sampling bandit (server/bandit.ts, same machinery as the other decisions)
//     over teaching moves. Each turn's move is scored by the student's NEXT message (got it / a real attempt
//     = reward, frustration or repeating = penalty) and a move that just failed is never served twice in a row.
// One move-learner for the whole tutor. There used to be TWO: this file's Thompson-sampling bandit over
// teaching moves (planMove/TUTOR_MOVE_ARMS) and server/tutorPolicy.ts's REINFORCE net. Only the net was ever
// called by the app — planMove was reachable from tests alone — and two learners choosing the same decision
// from different posteriors is a personalization bug waiting to happen (whichever ran last would win, and the
// "learned" line shown to the student could describe a policy that didn't actually pick the move). The bandit
// is gone; server/tutorPolicy.ts is the single source of truth, and MOVE_TEXT below is the directive text for
// its moves.

/** Each learned move carries a CONCRETE board action, not just a conversational one. The RL policy chooses
 *  HOW to teach; the board is where the teaching is visible (see claude.ts's board section: the page is the
 *  student's paper, working goes up line by line, and the next line is left as a gap). Telling the policy what
 *  to put up is what stops a "visual" turn from being a paragraph about a picture — it draws instead. */
const MOVE_TEXT: Record<Move, string> = {
  probe: "ask what they currently think and where exactly it stops making sense — ONE open question, then listen. Put that question ON THE BOARD (kind:'question') so it stays in front of them while they think.",
  "smaller-step": "shrink the step: split what you were about to ask into a tiny first piece they can answer in a few words, and put THAT shrunk step on the board as its own short entry, ending in the gap ('= ?') they are meant to fill.",
  "worked-parallel": "show a PARALLEL worked example (same method, different numbers) and put it on the board LINE BY LINE — each line one move, maths in $…$ — with the last line left open as '= ?' for them, then ask them to do the same on their own problem.",
  visual: "stop using words: put a figure on the board (GEOMETRY_ON_BOARD for geometry, DRAW_ON_BOARD, GRAPH_ON_BOARD or a small CREATE_INTERACTIVE) and ask what they notice in it.",
  analogy: "give one everyday analogy for the idea (a real-life situation, not another formula), put the MAPPING on the board as short arrow lines (for example 'voltage --pushes--> current'), and ask how it maps onto their problem.",
  "reflect-back": "say back, in your own words, what you think they just said or tried, and put THAT back on the board as a short entry (kind:'summary' is right here — it is THEIR reasoning being reflected) before asking whether you got it right.",
  "direct-hint": "give ONE concrete hint (the rule or the first move, never the answer), write the rule up on the board (kind:'formula') with the next line left as a gap, then ask them to take the step.",
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

/** What the PREVIOUS tutor turn actually PRODUCED, over and above what the student typed back. The reaction to
 *  a move used to be the student's next message and nothing else — but a tutoring move's real payoff is often
 *  visible in the session itself: the board grew (the move's board action landed), or an objective got ticked
 *  off (the teaching worked end-to-end). Both are already known to the caller, so they are folded into the
 *  reward rather than ignored. Every field is optional and only BLENDS what the message already says — a
 *  frustrated student's 0 stays 0, and a signal that doesn't apply is omitted rather than counted as failure
 *  (the same posture as computeReward's optional terms in bandit.ts). */
export interface TurnOutcome {
  /** Did the turn that served the previous move write to the board? Only counts WITH a positive reaction —
   *  a page that grew while the student got more lost is not evidence the move worked. */
  prevWroteBoard?: boolean;
  /** How many session objectives were newly completed since the previous turn (SET_OBJECTIVES, see claude.ts). */
  objectivesAdvanced?: number;
}

/** How the student reacted to the PREVIOUS Otto turn, read from their new message (and, when supplied, what
 *  that turn produced). reward ∈ [0,1]; ≥ 0.5 is a win. */
export function reactionTo(message: string, history: { role: string; text: string }[], outcome?: TurnOutcome): Reaction {
  const m = message.trim();
  const priorUsers = history.filter((h) => h.role === "user").slice(-4).map((h) => h.text);
  const frustrated = FRUSTRATED.test(m);
  const repeated = !frustrated && priorUsers.some((u) => similarity(u, m) >= 0.6);
  const base = (() => {
    if (frustrated) return { reward: 0, frustrated: true, repeated, label: "frustrated" as const };
    if (repeated) return { reward: 0.1, frustrated: false, repeated: true, label: "repeated" as const };
    const ex = /^\[Exercise\].*marked (right|wrong)/s.exec(m);
    if (ex) return { reward: ex[1] === "right" ? 1 : 0.3, frustrated: false, repeated: false, label: (ex[1] === "right" ? "positive" : "neutral") as Reaction["label"] };
    if (POSITIVE.test(m)) return { reward: 1, frustrated: false, repeated: false, label: "positive" as const };
    if (m.split(/\s+/).length >= 4 || /[0-9=]/.test(m)) return { reward: 0.75, frustrated: false, repeated: false, label: "attempt" as const };
    return { reward: 0.4, frustrated: false, repeated: false, label: "neutral" as const };
  })();
  let reward = base.reward;
  // The move's own board action landed AND the student engaged → a small, bounded nudge upward. Deliberately
  // additive-on-success only: it can never turn a bad reaction into a "win" (0 + 0.1 is still far below 0.5),
  // which keeps the Bernoulli reduction's meaning intact.
  if (outcome?.prevWroteBoard && reward >= 0.5) reward = Math.min(1, reward + 0.1);
  // An objective ticked off is end-to-end evidence the teaching landed, whatever the student happened to type.
  if ((outcome?.objectivesAdvanced || 0) > 0) reward = Math.max(reward, 0.6);
  return { ...base, reward };
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

// (The dead move bandit's per-(user,task) `lastMove` map, MoveDecision, and `planMove` were removed here —
// see the comment above MOVE_TEXT. tutorPolicy.ts's own `pendingExp` map is the one that scores the previous
// turn's action against the student's reaction.)

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
  // sentences that ASK (end in "?") or INSTRUCT ("Find…", "Write … as…", "Simplify…") — both name something the
  // student is meant to produce, so the board must not already state it.
  const asks = (reply.match(/[^.!?\n]*\?/g) || []).slice(-2);
  const tasks = (reply.match(/(?:^|[.!\n]\s*)((?:so\s+|now\s+|try to\s+)?(?:find|write|show|calculate|compute|simplify|solve|determine|express|evaluate|work out|trouve|écris|calcule|simplifie|résous|détermine|exprime)\b[^.!?\n]*)/gi) || []).slice(-3);
  const q = [...asks, ...tasks].join(" ");
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

// ---- The question a reply actually asks (repeat detection only) ----
const GENERIC_CLOSER = /^(?:so\s+|and\s+)?(?:does (?:that|this|it) (?:make sense|click|help|work|sound)|make sense|(?:do you )?(?:want|wanna|would you like) (?:to |another|more|me)|ready|ok(?:ay)?|sound good|shall we|how (?:are|is) (?:you|it|that)|is that (?:ok|okay|clear|right)|any questions|veux-tu|tu veux|ça va|c['’]est clair|ça te parle)/i;

/** The question Otto is asking, as one clean sentence — or "" when there is no real question about the work
 *  (a generic "does that make sense?" / "want another?" / "ok?" is conversation, not a question). Used to
 *  catch Otto re-asking something it already asked. Questions are never written to the board — they live in
 *  chat only, so this never becomes a board entry. */
export function boardQuestionOf(reply: string): string {
  const qs = reply.replace(/\s+/g, " ").match(/[^.!?]*[^.!?\s][^.!?]*\?/g) || [];
  const last = (qs[qs.length - 1] || "").trim().replace(/^(?:and|so|now|okay|ok|alright|right|well)[,\s—–-]+/i, "").trim();
  if (last.length < 14 || last.split(/\s+/).length < 4) return "";
  if (GENERIC_CLOSER.test(last)) return "";
  return last.slice(0, 300);
}

// ---- "How you got there" must be THEIR steps ----
const NUM_WORDS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", eighteen: "18", twenty: "20", un: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six_fr: "6", sept: "7", huit: "8", neuf: "9", dix: "10", douze: "12" };
/** Student text → comparable compact maths: number words → digits, "pi"→π, "over"→/, "root"→√, spaces/brackets gone. */
export function compactMaths(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|un|deux|trois|quatre|cinq|sept|huit|neuf|dix|douze)\b/g, (w) => NUM_WORDS[w] || w);
  s = s.replace(/\b(?:a|one|une?)\s+half\b|\bhalf\b|\bun demi\b/g, "1/2").replace(/\bpi\b/g, "π").replace(/\b(?:over|sur|divided by|divisé par)\b/g, "/").replace(/\b(?:square )?root(?: of)?\b|\bracine(?: carrée)?(?: de)?\b/g, "√").replace(/\bsquared\b/g, "²");
  return s.replace(/[\s()\[\]{}]/g, "").replace(/[−–]/g, "-");
}
/** The structured maths tokens in a trace line (π-terms, roots, fractions) — what a student would have to have SAID. */
export function traceTokens(line: string): string[] {
  const c = compactMaths(line.replace(/\$/g, ""));
  return [...new Set(c.match(/\d*π(?:\/\d+)?|\d*√\d+|\d+\/\d+/g) || [])];
}
/** Tokens in a would-be "How you got there" entry that appear in NOTHING the student said and in no given (problem
 *  statement / earlier board). Non-empty → the tutor is writing a step the student hasn't taken. */
export function traceAheadOfStudent(entryText: string, studentTexts: string[], givens: string[]): string[] {
  const said = compactMaths([...studentTexts, ...givens].join(" \n "));
  return traceTokens(entryText).filter((t) => !said.includes(t));
}

// ---- Don't pile on / don't repeat ----
/** The student explicitly asked to move on / get another (so a NEW exercise or question is welcome). */
export function asksToMoveOn(message: string): boolean {
  return /\b(next|another|skip|pass|move on|new (?:one|question|problem|exercise)|different (?:one|question|problem)|harder|easier|passe|suivant|un autre|une autre|autre (?:exercice|question)|plus dur|plus facile|je passe)\b/i.test(message);
}

/** The question this reply asks matches one the tutor already asked in its last few turns. */
export function repeatsRecentQuestion(draft: string, history: { role: string; text: string }[], lookback = 8): boolean {
  const q = boardQuestionOf(draft);
  if (!q) return false;
  const past = history.filter((h) => h.role === "assistant").slice(-lookback);
  return past.some((h) => { const pq = boardQuestionOf(h.text); return !!pq && similarity(q, pq) >= 0.6; });
}

// ---- Neural RL policy (server/tutorPolicy.ts) wiring ----
import { act, learn, initPolicy, paceLine, MOVES as POLICY_MOVES, type Policy, type Experience, type Move, type Pace } from "./tutorPolicy.ts";

const pendingExp = new Map<string, { exp: Experience; move: Move }>();
const PENDING_CAP = 2000;

export interface TurnPlan { move: Move; pace: Pace; line: string; policy: Policy; learned?: { move: Move; reward: number }; stuck: boolean }
/** One turn of the RL loop: (1) score + learn from the PREVIOUS turn's action using how the student just reacted,
 *  (2) pick this turn's move and pace from the updated policy, (3) hand back the directive line + new weights. */
export function planTurn(o: { userKey: string; message: string; history: { role: string; text: string }[]; subject?: string; policy: Policy | null; now?: Date; rng?: () => number; outcome?: TurnOutcome; context?: { mastery?: number; objectiveProgress?: number; boardRich?: number } }): TurnPlan {
  let policy = o.policy || initPolicy();
  const reaction = reactionTo(o.message, o.history, o.outcome);
  const prev = pendingExp.get(o.userKey);
  let learned: TurnPlan["learned"];
  if (prev && o.history.length >= 2) {
    policy = learn(policy, prev.exp, reaction.reward);
    learned = { move: prev.move, reward: reaction.reward };
  }
  const users = o.history.filter((h) => h.role === "user").slice(-5).map((h) => h.text);
  const ctx = {
    reaction: reaction.label, stuckStreak: stuckStreak(o.message, o.history), turn: o.history.filter((h) => h.role === "assistant").length,
    subject: o.subject, hour: (o.now || new Date()).getHours(), messageWords: o.message.trim().split(/\s+/).filter(Boolean).length,
    hasMaths: /[0-9=+\-*/^√π]/.test(o.message), recentWrong: users.filter((m) => /^\[Exercise\].*marked wrong/s.test(m.trim())).length,
    repeatedStudent: reaction.repeated, prevMove: prev?.move,
    mastery: o.context?.mastery, objectiveProgress: o.context?.objectiveProgress, boardRich: o.context?.boardRich,
  };
  const failed = prev && reaction.reward < 0.5 ? prev.move : undefined;
  const a = act(policy, ctx, o.rng, failed);
  if (pendingExp.size >= PENDING_CAP) pendingExp.delete(pendingExp.keys().next().value as string);
  pendingExp.set(o.userKey, { exp: a.exp, move: a.move });
  const line = `\nTEACHING MOVE THIS TURN (a policy learned from how THIS student responds): ${MOVE_TEXT[a.move]} Keep every other rule — short, Socratic, never the answer.\n` + paceLine(a.pace);
  return { move: a.move, pace: a.pace, line, policy, ...(learned ? { learned } : {}), stuck: ctx.stuckStreak > 0 };
}
export const _POLICY_MOVES_CHECK: readonly string[] = POLICY_MOVES;
