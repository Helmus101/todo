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

// ---- Never hand over an open gap's answer ----
/** True when `reply` plainly STATES `value` — the `expectedAnswer` of a gap still open on the board. Boundary-
 *  aware on purpose: "4.9" must not fire inside "84.9" or "4.95", and "friction" must not fire inside
 *  "frictionless". Word-valued answers only match as whole words; maths/number answers also match the
 *  spacing-free form the model actually types ("x=2orx=3", "8.5n"), still never inside a longer number. */
export function replyStatesValue(reply: string, value: string): boolean {
  const raw = String(value || "").replace(/\$/g, "").trim().toLowerCase();
  const compactNeedle = raw.replace(/\s+/g, "");
  if (compactNeedle.length < 3) return false;
  const hay = String(reply || "").toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // word-for-word, with real word boundaries (spaces intact)
  if (new RegExp(`(?<![\\p{L}\\d])${esc(raw)}(?![\\p{L}\\d])`, "u").test(hay)) return true;
  // maths/number answers: also allow the no-spacing form, but never inside a longer number (digit/dot boundaries)
  if (!/[\d=+*/^√π%:]/.test(compactNeedle)) return false;
  return new RegExp(`(?<![\\d.])${esc(compactNeedle)}(?![\\d.])`).test(hay.replace(/\s+/g, ""));
}

// ---- Answers count, wherever they came from ----
/** Did the STUDENT just put an answer on the table themselves? True for a stated value, an option letter, a
 *  short maths statement — false for a question or an admission of confusion. Used so Otto can RECOGNISE an
 *  answer (confirm it and move on) instead of tripping its own "never state the answer" guardrail on a reply
 *  that only repeats what the student already said — which reads as the tutor failing to notice the question
 *  was answered, even when the answer came from outside the session. */
export function studentStatedAnswer(message: string, _history: { role: string; text: string }[] = []): boolean {
  const last = String(message || "").trim();
  if (!last || /\?/.test(last)) return false; // a question is not an answer
  if (/\b(?:the (?:correct |final )?answer is|la (?:bonne )?réponse est|c['’]est donc l['’]option|option [a-d])\b/i.test(last)) return true;
  if (/^\s*(?:option\s*)?[a-d][.)]?\s*$/i.test(last)) return true; // "B"
  const words = last.split(/\s+/).length;
  if (words < 2 || words > 14) return false;
  if (/\b(?:why|how|don['’]?t|understand|explain|je ne|comment|pourquoi|explique)\b/i.test(last)) return false;
  return /[0-9=+\-*/^√π]/.test(last); // a short maths statement: "x = 2 or x = 3", "8.5 N"
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

// ---- Problems the STUDENT poses, multi-solution traps, and "I wrote the calculation for you" ----

const POSE_WORD = /\b(?:find|solve|determine|calculate|compute|evaluate|simplify|express|prove|show(?: that)?|work out|how (?:many|much|long|far|fast)|what(?:'s| is| are) (?:the|all)|trouve[rz]?|résous|calcule[rz]?|détermine[rz]?|démontre[rz]?|combien)\b/i;

/** A problem the student states in chat ("find all unknown angles in triangle ABC where a=35 …"), cleaned up for the
 *  board — or "" when the message isn't a problem statement. Voice dictation spells things out ("equals", "degrees",
 *  "centimeters"), which is tidied; the student's own wording is otherwise kept. */
export function studentProblemStatement(message: string): string {
  const raw = message.replace(/\s+/g, " ").trim();
  if (raw.length < 25 || raw.length > 900 || /^\[(?:Exercise|Exercice|Activity|Activité)\]/i.test(raw)) return "";
  if (!POSE_WORD.test(raw)) return "";
  const quantities = (raw.match(/\d+(?:[.,]\d+)?/g) || []).length + (raw.match(/\b(?:equals?|égale?s?)\b/gi) || []).length;
  if (quantities < 2) return ""; // "find the main idea" is a request, not a posed problem
  if (/^(?:can|could|would|will|please|peux|pouvez)\b.{0,40}\b(?:you|tu|vous)\b/i.test(raw) && quantities < 3) return "";
  let t = raw
    .replace(/^(?:all ?right|alright|okay|ok|so|um+|uh+|well|right|d['’]accord|alors|bon)[,.\s]+(?:so\s+)?(?:(?:first|now|next)\s+)?(?:i(?:'ll| will)?\s+(?:do|try|have|want)\s+)?/i, "")
    .replace(/\bequals?\b/gi, "=").replace(/\bdegrees?\b/gi, "°").replace(/\bcentimet(?:er|re)s?\b/gi, "cm").replace(/\bmet(?:er|re)s?\b/gi, "m")
    .replace(/\s*=\s*/g, " = ").replace(/\s+°/g, "°").replace(/\s{2,}/g, " ").trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.slice(0, 600);
}

/** A student's own words only go on the board when they ARE a clean problem statement — never a spoken ramble, a
 *  request wrapped around a problem ("just draw it…"), or a pasted math-renderer dump (duplicated "25 ∘ 25 ∘"). */
export function cleanToPost(statement: string): boolean {
  if (!statement || statement.length > 420) return false;
  if (/[∘\u200b]|\n/.test(statement)) return false;
  if (/\b(?:yeah|um+|uh+|like|you know|i want|i mean|please|can you|could you|draw|sketch|show me|action|actually|basically|go back)\b/i.test(statement)) return false;
  return true;
}

/** Does any board entry / problem already carry this statement (by numbers + main words)? */
export function boardCoversStatement(statement: string, boardTexts: string[]): boolean {
  const nums = (statement.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
  if (!nums.length) return false;
  const hay = boardTexts.join("\n").replace(/[$\\{}]/g, " ").replace(/,/g, ".");
  const hits = nums.filter((n) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(hay)).length;
  return hits >= Math.max(2, Math.ceil(nums.length * 0.75));
}

interface CaseTrap { id: string; test: (t: string) => boolean; hint: string; covered: RegExp }
const CASE_TRAPS: CaseTrap[] = [
  {
    id: "ssa",
    test: (t) => /\btriangle\b|\bABC\b/i.test(t) && /(?:\bangle\b|°|degrees?)/i.test(t) && (t.match(/\b[a-c]\s*(?:=|equals)\s*\d/gi) || []).length >= 2
      && /\b(?:find|solve|determine|all (?:the )?(?:unknown|missing)|sine (?:rule|law)|sin\b)/i.test(t),
    hint: "two sides and a NON-included angle (SSA) can give TWO different triangles (the ambiguous case)",
    covered: /ambiguous|second (?:case|triangle|solution|angle)|other (?:case|triangle|solution|angle)|obtuse|two (?:triangles|solutions|cases|possible)|180\s*[-−–]\s*(?:B|45|\d)|supplement/i,
  },
  {
    id: "trig-eq",
    test: (t) => /\b(?:sin|cos|tan)\s*\(?\s*[a-zθ]\w*\)?\s*=/i.test(t) && /\b(?:find all|all (?:values|solutions)|solve|interval|\[\s*0|0\s*[≤<]|0\s*to\s*(?:360|2π))/i.test(t),
    hint: "a trig equation usually has MORE than one solution in the interval (the second quadrant / the period)",
    covered: /second (?:solution|quadrant|angle)|other (?:solution|quadrant|angle)|180\s*[-−–]|period|all (?:the )?solutions|both/i,
  },
  {
    id: "abs-or-square",
    test: (t) => /\|[^|]{1,30}\|\s*=|\bx\^?2\s*=\s*\d|\bx²\s*=\s*\d|\bsquare root\b.*\bsolve\b/i.test(t),
    hint: "an absolute-value or squared equation has TWO solutions (positive and negative)",
    covered: /both|two (?:solutions|cases|roots|values)|±|negative (?:case|root|solution|value)|positive and negative/i,
  },
  {
    id: "quadratic",
    test: (t) => /\bsolve\b/i.test(t) && /\bx\^?2\b|x²|quadratic/i.test(t) && /=\s*0|quadratic/i.test(t),
    hint: "a quadratic can have two roots (or none, or a double one)",
    covered: /both|two (?:solutions|roots)|±|discriminant|other (?:root|solution)|second (?:root|solution)|roots?\b/i,
  },
];

/** Multi-solution traps that apply to the problem under discussion and that nobody has raised yet. The student's
 *  messages define the problem; the WHOLE conversation (including the tutor's own words) defines "raised". */
export function pendingCaseTraps(message: string, history: { role: string; text: string }[], draft = ""): { id: string; hint: string }[] {
  const userText = [...history.filter((h) => h.role === "user").map((h) => h.text), message].join(" \n ");
  const all = `${history.map((h) => h.text).join(" \n ")} \n ${message} \n ${draft}`;
  return CASE_TRAPS.filter((c) => c.test(userText) && !c.covered.test(all)).map((c) => ({ id: c.id, hint: c.hint }));
}

/** System-prompt block that makes the tutor raise the case itself — as a QUESTION, never as an announcement. */
export function caseTrapBlock(traps: { hint: string }[]): string {
  if (!traps.length) return "";
  return `\n\nCASE CHECK (the student shouldn't have to raise this themselves): ${traps.map((t) => t.hint).join("; ")}. ` +
    `Do not call the problem finished, and do not offer "another one", until the student has been ASKED whether there could be another case/solution — ` +
    `ask it as a question once the first case is done ("how many triangles/solutions can fit these numbers?"), never announce it. ` +
    `When they do raise or find the second case, don't write its calculation for them: ask what makes it possible (e.g. "which other angle between 0° and 180° has the same sine?") and let THEM produce it.\n`;
}

const WRAP_UP = /\b(?:whole|entire|full|complete|all)\b[^.!?]{0,30}\b(?:solved|done|finished|found|worked out)\b|\bsolved\b|\bthat'?s (?:it|everything|all|the lot)\b|\ball (?:angles|sides|unknowns?) (?:are )?(?:found|done)\b|\bnailed it\b|c['’]est tout|c['’]est résolu|\bterminé\b/i;
const MOVE_ON = /\b(?:another|next one|harder|something else|want to try|autre|suivant|prochain)\b/i;
/** True when the draft closes the problem (or moves on) while a multi-solution trap is still unraised. */
export function closesWithMissedCase(draft: string, traps: { id: string }[]): boolean {
  return traps.length > 0 && (WRAP_UP.test(draft) || MOVE_ON.test(draft)) ;
}

/** The tutor wrote out the calculation and only asked the student to EVALUATE it ("180° − 45.6° — what does that come
 *  out to?"): choosing the operation was the real thinking, and it's been done for them. Echoing an expression the
 *  student themselves just wrote is fine. */
export function handsOverCalculation(reply: string, lastUser: string): boolean {
  const ASKS_EVAL = /\b(?:what|how much)\b[^.?!]{0,40}\b(?:come|comes|work|works|equal|equals|give|gives|simplify|simplifies|reduce|reduces)\b[^.?!]{0,30}\?|\bcalculate (?:it|that|this)\b|\bwhat(?:'s| is) (?:the )?(?:result|value)\b|\bcombien (?:ça|cela|ca) (?:fait|donne)\b/i;
  if (!ASKS_EVAL.test(reply)) return false;
  const plain = reply.replace(/\\circ|\\degree|\^\s*\{?\\?circ\}?|\\[a-z]+/gi, " ").replace(/[$]/g, " ");
  const exprs = [...plain.matchAll(/(\d+(?:\.\d+)?)\s*°?\s*([-−–+×x*/÷])\s*(\d+(?:\.\d+)?)/g)];
  if (!exprs.length) return false;
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/[−–]/g, "-").replace(/[×x]/g, "*").replace(/÷/g, "/").replace(/°/g, "");
  const user = norm(lastUser);
  return exprs.some((m) => !user.includes(norm(m[0])) && !user.includes(`${m[1]}${norm(m[2])}${m[3]}`));
}

/** Specific, worked-out equation pieces in `text` — a trig value at a named angle ("tan(40°)") or a variable sum
 *  ("x+500", "470+h") — that appear in NOTHING the student said and in no given. Those are the fingerprints of a
 *  SETUP STEP the tutor took for them (the equation they were meant to build). General formulas ("a/sinA = b/sinB")
 *  carry no such pieces, so teaching a formula is never flagged. */
export function equationAhead(text: string, studentTexts: string[], givens: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/\\(?:circ|degree|left|right|cdot|times)|\^\s*\{?\\?circ\}?|degrees?|[°$\s{}\\*·×]/g, "").replace(/[−–]/g, "-");
  const body = norm(text);
  const pieces = new Set<string>();
  for (const m of body.matchAll(/(?:sin|cos|tan)\(?\d+(?:\.\d+)?\)?/g)) pieces.add(m[0].replace(/[()]/g, ""));
  for (const m of body.matchAll(/\(?[a-z]\+\d+(?:\.\d+)?\)?|\(?\d+(?:\.\d+)?\+[a-z]\)?/g)) pieces.add(m[0].replace(/[()]/g, ""));
  if (!pieces.size) return [];
  const said = norm([...studentTexts, ...givens].join(" \n ")).replace(/[()]/g, "");
  return [...pieces].filter((p) => !said.includes(p));
}

// ---- The student shows Otto a drawing ----
const DRAWING_MARKER = /Here's what I drew:|Voici ce que j['’]ai dessiné|What I wrote\/drew on the board:|Ce que j['’]ai écrit\/dessiné/i;
/** The message carries a read of the student's whiteboard drawing (the "Show Otto" button, or ink read automatically). */
export function isDrawingTurn(message: string): boolean { return DRAWING_MARKER.test(message); }
/** Does the drawing look spatial (a figure worth redrawing) rather than just handwriting? */
export function drawingLooksSpatial(message: string): boolean {
  return /\b(?:diagram|triangle|circle|line|lines|axis|axes|graph|sketch|shape|angle|arrow|rectangle|square|polygon|figure|vector|curve|cliff|vertical|horizontal|schéma|triangle|cercle|droite|axe|courbe)\b/i.test(message);
}
/** System-prompt block for a turn where the student showed a drawing. */
export const DRAWING_TURN_BLOCK = `

THE STUDENT JUST SHOWED YOU A DRAWING (the text after "Here's what I drew" is a vision read of their whiteboard — it may mis-transcribe; trust the labels and numbers you can cross-check against the board). Do exactly this, in ONE reply:
1. COMMENT on it first, in one or two short sentences: say what is genuinely right about it (be specific — "you've put the 470 on the vertical side"), and if something looks off or missing, raise it as a QUESTION, never a correction.
2. Then REDRAW THE SAME THING, cleaner and clearer, with GEOMETRY_ON_BOARD (any triangle/circle/polygon/angles) or SVG_ON_BOARD (everything else — write the SVG): the same shapes, the same labels, the same numbers, the same layout — only neater (straight lines, correct proportions, readable labels, right angles marked). Add NOTHING they didn't draw: no solved values, no extra construction, no next step. If part of their drawing is doubtful, draw it as they drew it and ask about it.
3. End with ONE short question about the next step. The board also shows what you drew earlier (listed above) — if they were commenting on one of YOUR figures, use what is on the board together with their marks.
`;

// ---- Consistency: answering the same question twice, and computing for the student ----

/** The student asked (nearly) the same thing twice in a row — the previous answer didn't land or contradicted itself. */
export function repeatedClaim(message: string, history: { role: string; text: string }[]): boolean {
  const lastUser = [...history].reverse().find((h) => h.role === "user")?.text;
  if (!lastUser || /^\[/.test(message) || /^\[/.test(lastUser)) return false;
  const a = message.replace(/\s+/g, " ").trim(), b = lastUser.replace(/\s+/g, " ").trim();
  if (a.length < 8 || b.length < 8) return false;
  const tok = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9à-ÿ°]+/g, " ").split(" ").filter((w) => w.length > 1 && !["no", "but", "wait", "so", "yes", "yeah", "ok", "okay", "um", "uh", "like", "just", "actually", "oui", "non", "mais"].includes(w)));
  const ta = tok(a), tb = tok(b);
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 3) return false;
  const shared = [...small].filter((w) => big.has(w)).length;
  // the shorter restatement is mostly CONTAINED in the longer one ("no but angle J is 25° right" ⊂ "…we now know the angle J is 25° right")
  return shared / small.size >= 0.7 || similarity(a, b) >= 0.55;
}
export const REPEATED_CLAIM_BLOCK = `\n\nTHEY JUST ASKED THE SAME THING AGAIN — your previous answer didn't land, or it contradicted something you said earlier. Don't flip your verdict to match their phrasing and don't repeat yourself: re-derive it from the givens and your ledger, answer the question plainly first (yes / no, in a few words, and the one-line reason), and if your earlier answer was wrong or inconsistent, say so openly ("I muddled that — here's the right way to see it"). Then ask your guiding question.\n`;

/** "40° − 25° = 15°" written by the tutor where the result is a number nobody (student, givens, board) has produced:
 *  the tutor did the step. Echoing a result the student already stated is fine. */
export function arithmeticAhead(reply: string, studentTexts: string[], givens: string[]): string[] {
  const plain = reply.replace(/\\circ|\\degree|\^\s*\{?\\?circ\}?|\\[a-z]+/gi, " ").replace(/[$]/g, " ");
  const said = [...studentTexts, ...givens].join(" \n ").replace(/,/g, ".");
  const out: string[] = [];
  for (const m of plain.matchAll(/(\d+(?:\.\d+)?)\s*°?\s*[-−–+×x*/÷]\s*(\d+(?:\.\d+)?)\s*°?\s*(?:=|≈|equals|gives|makes)\s*(\d+(?:\.\d+)?)/g)) {
    const result = m[3];
    if (!new RegExp(`(?<![\\d.])${result.replace(".", "\\.")}(?![\\d])`).test(said)) out.push(m[0].trim());
  }
  return out;
}

// ---- "Just draw it" and praise for nothing ----
/** The student is asking Otto to DRAW/show the picture (not describing their own drawing). */
export function asksToDraw(message: string): boolean {
  const m = String(message || "");
  if (m.length > 320 || isDrawingTurn(m) || /\bi (?:drew|am drawing|'ll draw|will draw|created a drawing)\b|my (?:drawing|diagram|sketch)/i.test(m)) return false;
  if (/\b(?:graph|plot|trace|représente)\b/i.test(m) && /\b(?:it|them|these|those|the (?:lines?|functions?|curves?|equations?)|can we|could we|let'?s|maybe|please|show|just)\b/i.test(m) && !/\bi (?:graphed|plotted)\b/i.test(m)) return true;
  return /\b(?:draw|sketch|illustrate|dessine[rz]?|dessin|schéma|diagram)\b/i.test(m) && /\b(?:can you|could you|please|just|for me|again|show|do it|try|make|peux-tu|pouvez|s'il)\b|^draw\b/i.test(m)
    || /\bshow (?:me )?(?:the )?(?:angles|diagram|picture|figure|situation|it)\b/i.test(m);
}
const PRAISE_OPEN = /^\s*(?:spot on|exactly|correct|that'?s (?:right|it|correct)|great|nice|perfect|well done|yes[,!.\s]|you(?:'ve| have) got)/i;
/** The student said nothing checkable ("to do", "yeah", a stray name) — there is nothing to praise. */
export function lowSignal(message: string): boolean {
  const t = message.replace(/\[[^\]]*\]/g, "").trim();
  if (!t || /^\[/.test(message.trim())) return false;
  return t.split(/\s+/).length <= 4 && !/\d|=|[+\-×*/^]/.test(t) && !/\?/.test(t);
}
export function praisesNothing(reply: string, message: string): boolean { return PRAISE_OPEN.test(reply) && lowSignal(message); }

// ---- Grounding: respond only to what the student ACTUALLY said ----
const SUCCESS_EVIDENCE = new Set(["solved-unaided", "solved-after-hint", "solved-after-partial", "solved-after-explanation", "self-corrected", "recall", "transfer-success"]);
const PRAISE_START = /^\s*(?:spot on|exactly|correct|that'?s (?:right|it|correct|the idea)|nailed it|perfect|well done|nice (?:one|work|job|catch)|great[,!.]|great (?:job|work|catch|idea|thinking)|yes[,!.\s]|you(?:'ve| have) got (?:it|that|the))/i;
/** Praise (or "you're right") when nothing the student said was a checkable, correct step. Uses the tutor's own plan
 *  (its read of the student's last move) when it has one, and the plain "nothing was said" test either way. */
export function praiseUngrounded(reply: string, message: string, plan?: { studentStep?: { status?: string }; evidence?: { kind?: string } } | null): boolean {
  if (!PRAISE_START.test(reply)) return false;
  if (lowSignal(message)) return true;
  if (/^\[/.test(message.trim())) return false; // an exercise/activity result is a real signal, handled elsewhere
  if (!plan) return false;
  const ok = plan.studentStep?.status === "correct" || (plan.evidence?.kind ? SUCCESS_EVIDENCE.has(plan.evidence.kind) : false);
  return !ok;
}

const GROUND_STOP = new Set("that this with have from what when where which their there about would could should these those them they then than just also into your yours been were will shall cannot dont doesnt isnt arent".split(" "));
/** "You've got the two sides lined up" / "as you said, …" when the student never said it: the clause's content words
 *  must (mostly) appear in what they actually said or wrote on the board. Returns the offending clause or null. */
export function misattributes(reply: string, studentTexts: string[], studentBoard: string[] = []): string | null {
  const said = new Set((studentTexts.concat(studentBoard).join(" ").toLowerCase().match(/[a-zà-ÿ0-9°]+/g) || []));
  const re = /\b(?:you(?:'ve| have)?\s+(?:just\s+)?(?:said|mentioned|noticed|found|got|identified|written|wrote|drawn|drew|set up|lined up|worked out|figured out|spotted|used)|as you (?:said|noted|mentioned)|like you said|your (?:last|previous) (?:step|answer|idea))\b([^.?!\n]{0,90})/gi;
  for (const m of reply.matchAll(re)) {
    const words = (m[1].toLowerCase().match(/[a-zà-ÿ0-9°]{4,}/g) || []).filter((w) => !GROUND_STOP.has(w));
    if (words.length < 2) continue;
    const present = words.filter((w) => said.has(w) || [...said].some((s) => s.length >= 4 && (s.startsWith(w.slice(0, 5)) || w.startsWith(s.slice(0, 5))))).length;
    if (present / words.length < 0.5) return m[0].trim();
  }
  return null;
}

const METHOD_WORDS = /\b(tan|sin|cos|arctan|arcsin|arccos|log|ln|sqrt|slope|gradient|derivative|integral|discriminant|quadratic formula|sine rule|cosine rule|pythagoras|chain rule|product rule|bayes|factorise|factorize|completing the square)\b/gi;
export function wantsHelp(message: string): boolean {
  return /\b(hint|help|stuck|lost|don'?t know|no idea|how (?:do|would|can) (?:i|we)|what (?:do i|should i)|explain|show me how|indice|aide|bloqué|perdu|je ne sais pas)\b/i.test(message);
}
/** The tutor names the METHOD/formula ("tan(θ) = slope") before the student reached for it. Only the words that
 *  appear next to an equation sign in the reply count, and only when nobody (student, givens) has used them. */
export function methodAhead(reply: string, said: string[]): string[] {
  const hay = said.join(" ").toLowerCase();
  const out = new Set<string>();
  for (const sentence of reply.split(/(?<=[.!?\n])\s+/)) {
    if (!/[=≈→]|\bequals?\b|\bgives?\b|\buse the\b|\bapply the\b|\bremember\b|\bcalculator\b/i.test(sentence)) continue;
    for (const m of sentence.matchAll(METHOD_WORDS)) {
      const w = m[1].toLowerCase();
      if (!hay.includes(w) && !(w === "slope" && /gradient/.test(hay)) && !(w === "gradient" && /slope/.test(hay))) out.add(w);
    }
  }
  return [...out];
}

// ---- Off-topic messages never become "student work" ----
/** Does what the student said have anything to do with the problem/lesson in play? Math content (digits, operators,
 *  degrees) always counts; otherwise it must share a real word with the problem, the board or what Otto just asked.
 *  "Gary left avocado on the ground" shares nothing → it is chatter, not a step. */
export function onTopic(text: string, context: string[]): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\d|=|[+×*/^√π∫°]|\b(?:equals?|plus|minus|times|over|divided|squared|slope|angle|sin|cos|tan|log|root|sum|value)\b/i.test(t)) return true;
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !GROUND_STOP.has(w)));
  const ctx = words(context.join(" "));
  return [...words(t)].some((w) => ctx.has(w) || [...ctx].some((c) => c.length >= 6 && w.length >= 6 && c.slice(0, 6) === w.slice(0, 6)));
}

// ---- Listen first: answer THEIR question, respond to THEIR work, only then guide ----
const Q_STOP = new Set("what whats what's does do did is are was the a an of to it this that mean means show shows stand stands for in on about why how which who when where wait so um uh and or but then you your tell me again exactly really just actually".split(" "));
/** The student is asking what something IS or MEANS ("what does m show", "what's M1", "what is a slope?"): returns the term
 *  they are asking about, or null when it isn't a clarification question. */
export function clarificationTerm(message: string): string | null {
  const m = message.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (!m || m.length > 140 || /^\[/.test(message.trim())) return null;
  if (!/^(?:wait[, ]+)?(?:what(?:'s|s| is| are| does| do)?|why|how come|which|who|i (?:don'?t|do not) (?:get|understand|know what)|c'est quoi|qu'est-ce|que veut|pourquoi)\b/i.test(m) && !/\?\s*$/.test(m)) return null;
  const toks = (m.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ0-9₀-₉_]*/g) || []).filter((w) => !Q_STOP.has(w));
  return toks.length ? toks[toks.length - 1].replace(/[₀-₉_]/g, (c) => (c === "_" ? "" : String("₀₁₂₃₄₅₆₇₈₉".indexOf(c)))) : null;
}
export const CLARIFY_BLOCK = `\n\nTHEY ASKED A QUESTION ABOUT WHAT SOMETHING IS OR MEANS. Answer THAT, and only that, this turn — a tutor who ignores the question and carries on with their own plan isn't listening. In one or two short sentences, say what the thing is IN THIS PROBLEM (e.g. "m₁ is just the name for the slope of the first line"), pointing at where it is on the board or in the problem, then ask ONE small question that makes THEM connect it to what they have ("which line has slope 5?"). A question about a term is NOT a request for the next step: don't escalate the help, don't advance your own plan, don't calculate anything for them, and don't write anything new on the board.\n`;

/** The reply to a clarification question never mentions the term they asked about — it carried on with its own plan. */
export function ignoresQuestion(reply: string, message: string): boolean {
  const term = clarificationTerm(message);
  if (!term) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[₀-₉]/g, (c) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(c))).replace(/[_$\\{}\s]/g, "");
  const r = norm(reply);
  if (term.length >= 2) return !r.includes(norm(term));
  return !new RegExp(`(?<![a-z0-9])${term}(?![a-z]|\\d)`, "i").test(reply.replace(/[_$\\{}]/g, "").replace(/[₀-₉]/g, (c) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(c))));
}

/** The student reported real work (a value, a claim) and the reply says nothing about it: no number and no real word
 *  of theirs appears. ("I found the intersection is x = 3/14" → "Got the formula up there. Now plug in…") */
export function ignoresWork(reply: string, message: string): boolean {
  const m = message.replace(/\[[^\]]*\]/g, " ").trim();
  if (!m || /\?/.test(m) || clarificationTerm(m) || /^\[/.test(message.trim())) return false;
  const nums = (m.match(/\d+(?:[.,]\d+)?/g) || []);
  if (!nums.length) return false;
  const words = (m.toLowerCase().match(/[a-zà-ÿ]{5,}/g) || []).filter((w) => !GROUND_STOP.has(w));
  const r = reply.toLowerCase();
  return !nums.some((n) => new RegExp(`(?<![\\d.])${n.replace(/[.,]/, "[.,]")}(?![\\d])`).test(r)) && !words.some((w) => r.includes(w.slice(0, Math.max(5, w.length - 2))));
}

/** The student explicitly wants something written down. */
export function asksToWrite(message: string): boolean {
  return /\b(?:write|put|add|note)\b[^.?!]{0,30}\b(?:board|down|up)\b|\bon the board\b|\bwrite (?:it|that|this)\b|\bnote (?:it|that) (?:down|for me)\b|écris|note[- ]le/i.test(message);
}
