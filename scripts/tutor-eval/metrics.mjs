// Model-free metrics over one finished scenario (a list of turn records from lib.mjs playTurn). Reuses the app's own pure
// checks, so the residual rate AFTER the engine's guards is what is measured. Heuristics, not ground truth: read the
// flagged turns, don't trust the totals blindly.
const { similarity, harshOpener, asksWhy, ignoresWhy } = await import("../../server/tutorAdapt.ts");
const { questionCount } = await import("../../server/tutor.ts");
const { findArithmeticClaims } = await import("../../server/arithmetic.ts");
const { hideToolLeaks } = await import("../../shared/toolLeak.ts");
const { claimsBoard, hasVisual } = await import("../../server/tutorTurn/verify.ts");

const words = (t) => String(t || "").split(/\s+/).filter(Boolean).length;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const QUESTION_MOVES = new Set(["elicit", "revoice", "focus", "probe_why", "hint_concept", "hint_procedure"]);
const EN_STOP = /\b(?:the|and|you|that|this|what|with|your|have)\b/gi;
const FR_STOP = /\b(?:le|la|les|des|que|vous|tu|est|pour|dans|une?)\b/gi;

export function computeMetrics(S, scenario) {
  const turns = S.turns.filter((t) => !t.error);
  const errors = S.turns.length - turns.length;
  const flags = []; // {turn, kind, detail}
  const flag = (i, kind, detail) => flags.push({ turn: i, kind, detail: String(detail).slice(0, 160) });
  const replies = turns.map((t) => t.reply);
  let boardSoFar = [];
  const name = S.profile?.name;
  let nameStarts = 0, multiQ = 0, longReplies = 0, repeats = 0, askedWhyIgnored = 0, askedWhy = 0, qOnlyRun = 0, qOnlyMax = 0, frWrong = 0;
  turns.forEach((t, i) => {
    const r = t.reply;
    if (hideToolLeaks(r) !== r.replace(/\s+/g, " ").trim() && hideToolLeaks(r).trim() !== r.trim()) flag(i, "tool-syntax", r);
    if (/\bWRITE_TO_BOARD\b|\{"op"|"cue":|\[Exercise\]|\bSET_OBJECTIVES\b/.test(r)) flag(i, "tool-syntax", r);
    // guardrailTripped is set from the PRE-repair issues (the guard fired and the reply was fixed), so it is informational.
    if (t.guardrailTripped) flag(i, "guard-fired", "the first draft leaked a key; repaired before sending");
    // Only plain-number claims: algebra and integrals ("2x^2 - 8 = 0", "3(0)^2+1 = 1") lose their variables to the parser.
    for (const c of findArithmeticClaims(r.replace(/\$[^$]*[A-Za-z\\^_][^$]*\$/g, " ").replace(/\b\d*[a-z]\^?\d*\b/gi, (m) => (/^\d+$/.test(m) ? m : " ")))) if (c.mismatch) flag(i, "wrong-arithmetic", c.raw);
    const created = (t.newBoard || []).some((e) => e.kind !== "focus" && e.kind !== "annotation") || (t.newProblems || []).length > 0;
    if (r.split(/(?<=[.!?])\s+/).some((sn) => claimsBoard(sn, hasVisual([...boardSoFar, ...(t.newBoard || [])]))) && !created) flag(i, "board-claim", r);
    boardSoFar = [...boardSoFar, ...(t.newBoard || [])];
    const q = questionCount(r);
    if (q > 1) { multiQ++; flag(i, "multi-question", `${q} questions`); }
    if (words(r) > 90) longReplies++;
    if (harshOpener(r)) flag(i, "harsh-opener", r.slice(0, 80));
    if (name && new RegExp(`^\\s*${name}\\b`, "i").test(r)) nameStarts++;
    for (let j = Math.max(0, i - 3); j < i; j++) if (similarity(r, replies[j]) >= 0.6) { repeats++; flag(i, "repeat", `like turn ${j}: ${r.slice(0, 80)}`); break; }
    if (asksWhy(t.message)) { askedWhy++; if (ignoresWhy(r)) { askedWhyIgnored++; flag(i, "ignored-why", r.slice(0, 100)); } }
    const mv = t.turn?.move;
    if (QUESTION_MOVES.has(mv)) { qOnlyRun++; qOnlyMax = Math.max(qOnlyMax, qOnlyRun); } else qOnlyRun = 0;
    const en = (r.match(EN_STOP) || []).length, fr = (r.match(FR_STOP) || []).length;
    const studentEnglish = /\b(?:the|and|you|that|this|what|with)\b/i.test(t.message);
    if (scenario.lang === "fr" && !studentEnglish && en > fr + 2) { frWrong++; flag(i, "wrong-language", r.slice(0, 80)); }
    if (scenario.lang === "en" && /\b(?:le|la|les|des|que|vous|est)\b/i.test(r) && fr > en) flag(i, "wrong-language", r.slice(0, 80));
  });
  // Robotic patterns: the same opening words again and again, and stock phrases the tutor leans on.
  const opener = (r) => r.toLowerCase().replace(/[^a-zà-ÿ' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  const openers = {}; for (const r of replies) { const o = opener(r); if (o) openers[o] = (openers[o] || 0) + 1; }
  const repeatedOpeners = Object.entries(openers).filter(([, n]) => n >= 3).map(([o, n]) => `${o} ×${n}`);
  const STOCK = /\b(?:the real question|the deeper bit|the harder (?:half|one|part)|now push it|now the why|here's a fresh case|that's (?:exactly|the key|the whole)|exactly right|spot on|great question|good question|worth (?:chasing|knowing))\b/gi;
  const stockPhrases = replies.reduce((n, r) => n + (r.match(STOCK) || []).length, 0);
  const ms = turns.map((t) => t.ms), moves = {};
  for (const t of turns) { const m = t.turn?.move || "?"; moves[m] = (moves[m] || 0) + 1; }
  const problems = S.problems.length, solved = S.problems.filter((p) => p.solved).length;
  const repaired = turns.filter((t) => t.turn?.repaired).length, droppedOps = turns.reduce((n, t) => n + (t.turn?.dropped?.length || 0), 0);
  const issueCounts = {};
  for (const t of turns) for (const c of t.turn?.issues || []) issueCounts[c] = (issueCounts[c] || 0) + 1;
  const kinds = S.problems.map((p) => (p.options?.length ? "mcq" : p.rubric ? "rubric" : "free"));
  const hard = flags.filter((f) => ["tool-syntax", "leak", "wrong-arithmetic", "board-claim"].includes(f.kind)).length + errors;
  return {
    turns: turns.length, errors, hardFails: hard, flags, repeatedOpeners, stockPhrases,
    wordsAvg: Math.round(replies.reduce((n, r) => n + words(r), 0) / Math.max(1, replies.length)), wordsMax: Math.max(0, ...replies.map(words)),
    multiQuestionReplies: multiQ, longReplies, repeats, nameStarts, askedWhy, askedWhyIgnored, questionMoveRunMax: qOnlyMax, wrongLanguage: frWrong,
    msMedian: median(ms), msP90: pct(ms, 0.9), repaired, droppedOps, issueCounts, moves, problems, solved, problemKinds: kinds,
    tokensIn: turns.reduce((n, t) => n + (t.tokens?.in || 0), 0), tokensOut: turns.reduce((n, t) => n + (t.tokens?.out || 0), 0),
  };
}
