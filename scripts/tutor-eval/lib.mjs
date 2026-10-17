// Tutor evaluation harness — the session simulator. It mirrors what server/routes/tasks.ts (tutorTurn) and
// client/tutor/TutorSession.tsx do around runTutorTurn, so a scripted conversation behaves like a real session:
// the teaching state and turn log advance, the board and problems merge by id, an answer typed in the widget is graded
// and reported as the "[Exercise] …" message the client sends, gaps close, evidence reaches the student model.
//
// No database and no accounts: only the engine chain is imported, and the Supabase variables are blanked. The model key
// is loaded by server/env.ts (dotenv only) — never printed here.
for (const k of ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"]) process.env[k] = "";
await import("../../server/env.ts");
// env.ts loads .env into process.env WITHOUT overriding values already set, so the blanked Supabase variables above stay blank.
for (const k of ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"]) process.env[k] = "";

const { runTutorTurn } = await import("../../server/tutorTurn/engine.ts");
const { nextSupportState } = await import("../../server/tutorTurn/policy.ts");
const { logAssistance, settleRetest, dueRetests } = await import("../../server/tutorTurn/ledger.ts");
const { solveProblem, focusKeyOf, isNewProblem } = await import("../../server/solver.ts");
const { nextTeachingState, evidenceKindFor, reachedSolutionSteps, rehydrateProblemKey, detectSubject, learningPrefsFrom, mergePrefs } = await import("../../server/tutor.ts");
const { studentProblemStatement } = await import("../../server/tutorAdapt.ts");
const { verifyStepAgainstGap } = await import("../../shared/mathEquiv.ts");
const { gradeExerciseAnswer } = await import("../../shared/exerciseVerification.ts");
const { recordConceptEvidence, normalizeStudentModel, emptyStudentModel } = await import("../../server/studentModel.ts");
const { emptyProfile, callCostUsd } = await import("../../shared/types.ts");
const { createTutorChat, usageOf } = await import("../../server/claude.ts");
export { createTutorChat, usageOf, callCostUsd };

export const provider = () => (process.env.GEMINI_API_KEY ? "gemini" : process.env.DEEPSEEK_API_KEY ? "deepseek" : "none");

/** Money spent so far this process (tutor + student + judge), by the app's own rates. */
export const spend = { usd: 0, inTok: 0, outTok: 0, calls: 0 };
export const addSpend = (t) => { spend.inTok += t.in || 0; spend.outTok += t.out || 0; spend.calls++; spend.usd += callCostUsd(t.in || 0, t.out || 0, t.cachedIn || 0, new Date()); };

// ── client helpers copied from client/tutor/TutorSession.tsx (it imports React, so it can't be loaded here) ──
export function mergeBoardById(existing, incoming) {
  const seen = new Set(existing.map((x) => x.id));
  const fresh = incoming.filter((x) => x && !seen.has(x.id));
  if (!fresh.length) return existing;
  const when = (x) => Date.parse(x.at || x.createdAt || "") || Number.MAX_SAFE_INTEGER;
  return [...existing, ...fresh].map((x, i) => ({ x, i })).sort((a, b) => when(a.x) - when(b.x) || a.i - b.i).map((o) => o.x);
}
export function fillGap(b, given) {
  const v = (String(given || "").split("=").pop() || "").trim();
  return { ...b, status: "correct", ...(v ? { text: b.text.replace(/=\s*\?/, `= ${v}`) } : {}) };
}

/** A fresh session: what the browser and the stored task hold at the start. */
export function newSession({ subject, lang = "en", profile = {}, memory, objectives = [], board = [], problems = [], history = [], dueRetestSkills = [] } = {}) {
  const p = { ...emptyProfile(), language: lang, ...profile };
  return { task: { id: "eval", sourceSubject: subject, tutorState: undefined, solution: undefined }, profile: p, board, problems, objectives, history, memory, lang, attempts: {}, dueRetestSkills, turns: [] };
}

/** The "[Exercise] …" message the client sends after the answer widget grades an answer (English variants). */
/** Which option a student's answer picks: a leading letter ("(C) …", "C.", "C"), else the option whose text it contains/starts. -1 = none. */
export function pickedOption(problem, given) {
  const opts = problem.options || [];
  const t = String(given).trim();
  const m = /^\(?([A-Da-d])[).:]?(?:\s|$)/.exec(t);
  if (m) { const i = m[1].toUpperCase().charCodeAt(0) - 65; if (i < opts.length) return i; }
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const g = norm(t.replace(/^\(?[A-Da-d][).:]?\s+/, ""));
  return opts.findIndex((o) => { const n = norm(o); return n && (g === n || g.startsWith(n) || n.startsWith(g.slice(0, 40)) && g.length >= 12); });
}

export function exerciseMessage(problem, given, attempt, lang = "en") {
  if (problem.options?.length) { const i = pickedOption(problem, given); given = i >= 0 ? problem.options[i] : given; problem = { ...problem }; problem.__pick = i; }
  const g = given.slice(0, 120);
  if (lang === "fr") {
    const grade = gradeExerciseAnswer(problem, problem.options?.length ? String(problem.__pick ?? -1) : given);
    const ok = grade.status === "correct";
    return { text: `[Exercice] J'ai répondu « ${g} » — ${grade.status === "system_error" ? "non noté : la clé du problème contredit la valeur vérifiée par le calcul" : ok ? "juste" : grade.status === "partially_correct" ? "en partie juste (une idée clé manque)" : "faux"} (essai n°${attempt}).`, correct: ok, status: grade.status };
  }
  const grade = gradeExerciseAnswer(problem, problem.options?.length ? String(problem.__pick ?? -1) : given);
  const ok = grade.status === "correct";
  if (grade.status === "partially_correct") return { text: `[Exercise] I answered "${g}" — PARTLY right: some of the key ideas, one still missing (try #${attempt}). Credit what's right, then ask for the missing piece.`, correct: false, status: grade.status };
  if (grade.status === "system_error") return { text: `[Exercise] I answered "${g}" — NOT graded: this problem's stored answer key contradicts the independently computed value (try #${attempt}).`, correct: false, status: grade.status };
  return { text: `[Exercise] I answered "${g}" — marked ${ok ? "right" : "wrong"} (try #${attempt}).`, correct: ok, status: grade.status };
}

/** One student message → one tutor turn, with the route's and client's bookkeeping. Returns the turn's record. */
export async function playTurn(S, message, opts = {}) {
  const { task, profile } = S;
  const history = S.history;
  const turnStart = new Date().toISOString();
  if (!task.sourceSubject) { const s = detectSubject([message, ...history.filter((h) => h.role === "user").map((h) => h.text)].join("\n")); if (s) task.sourceSubject = s; }
  const problems = S.problems.slice(-12).map((p) => rehydrateProblemKey(p, p));
  const stepVerdict = verifyStepAgainstGap(message, S.board);
  const openProblem = [...problems].reverse().find((p) => !p.solved);
  const statedRaw = studentProblemStatement(message);
  const stated = statedRaw && isNewProblem(statedRaw, task.solution) ? statedRaw : "";
  const boardGiven = [...S.board].reverse().find((b) => b.kind === "given" && b.text && b.text.split(/\s+/).length >= 12)?.text || "";
  const focus = openProblem?.question || stated || boardGiven;
  const solving = focus && focusKeyOf(focus) !== task.solution?.focusKey ? solveProblem(focus, task.sourceSubject) : null;
  const t0 = Date.now();
  const out = await runTutorTurn({
    message, history: [...history], board: S.board, problems, objectives: S.objectives, lang: S.lang,
    solution: solving ? undefined : task.solution, solutionPromise: solving ? solving.then((r) => r.solution).catch(() => null) : undefined,
    teaching: task.tutorState, dueRetests: S.dueRetestSkills.length ? S.dueRetestSkills : dueRetests(profile.assistance, new Date()).map((a) => a.skill),
    voiceMode: !!opts.voice, canvasMode: true, spoken: opts.spoken, stepVerdict,
    context: { profile, subject: task.sourceSubject, journal: [], memory: S.memory },
  });
  const ms = Date.now() - t0;
  let solverTokens = { in: 0, out: 0 };
  if (solving) { const solved = await solving.catch(() => null); if (solved) { solverTokens = solved.tokens || solverTokens; addSpend(solverTokens); if (solved.solution) task.solution = solved.solution; } }
  addSpend(out.tokens);
  if (out.error || !out.reply.trim()) { S.turns.push({ message, error: true, ms }); return { error: true, ms, reply: "", board: [], problems: [] }; }

  // teaching state + evidence (routes/tasks.ts)
  const reached = reachedSolutionSteps(message, task.solution);
  const helpBefore = task.tutorState?.helpLevel ?? 0;
  { const found = learningPrefsFrom(message); if (found.length) profile.tutorPrefs = mergePrefs(profile.tutorPrefs, found); }
  { const prev = task.tutorState;
    const next = nextTeachingState(prev, { message, verdict: stepVerdict?.verdict, plan: out.plan, reachedStep: reached.length > 0, leaked: out.leakedValue });
    const turn = out.turn;
    const verdict = turn?.verdict ?? stepVerdict?.verdict;
    const support = turn ? nextSupportState(prev, { move: turn.move, verdict, progressed: verdict === "correct" || reached.length > 0 || !!out.solvedInChat?.length, struggled: turn.struggled }) : {};
    const record = turn ? { at: new Date().toISOString(), move: turn.move, support: turn.support, intent: turn.intent, diagnosis: turn.diagnosis, ...(turn.angle ? { angle: turn.angle } : {}), ...(turn.misconception ? { misconception: turn.misconception } : {}), ...(verdict ? { verdict } : {}), words: turn.speech.join(" ").split(/\s+/).filter(Boolean).length, studentWords: message.split(/\s+/).filter(Boolean).length, repaired: turn.repaired, ms: turn.ms } : null;
    task.tutorState = { ...next, ...support, ...(turn?.goals ? { goals: turn.goals } : prev?.goals ? { goals: prev.goals } : {}), ...(record ? { log: [...(prev?.log || []), record].slice(-30) } : {}) }; }
  const evidence = evidenceKindFor({ message, verdict: stepVerdict?.verdict, reachedFinal: reached.includes(0), helpLevel: helpBefore });
  const skill = task.solution?.skill || task.sourceSubject;
  if (skill && out.turn) { profile.assistance = logAssistance(profile.assistance, { skill, level: out.turn.support, now: new Date() }); if (evidence === "solved-unaided") profile.assistance = settleRetest(profile.assistance, skill, true, new Date()).ledger; }
  if (evidence && skill) { try { profile.conceptModel = recordConceptEvidence(normalizeStudentModel(profile.conceptModel) || emptyStudentModel(), { label: skill, subject: task.sourceSubject, kind: evidence, evidence: "tutor session" }, new Date()); } catch { /* best effort */ } }

  // a gap answered right in chat closes in place; a verified right step becomes their line (routes/tasks.ts)
  const closed = stepVerdict?.verdict === "correct" ? S.board.filter((e) => e.kind === "gap" && e.id && e.text.slice(0, 160) === stepVerdict.gap).map((e) => ({ id: e.id, given: stepVerdict.given })) : [];
  if (stepVerdict?.verdict === "correct" && !closed.length) {
    const norm = (x) => x.toLowerCase().replace(/[\s$]/g, "");
    if (![...S.board, ...out.board].some((e) => norm(e.text) === norm(stepVerdict.given))) out.board.unshift({ id: `stu-${S.turns.length}`, text: stepVerdict.given, kind: "result", owner: "student", status: "correct", at: turnStart });
  }
  const now = new Date().toISOString();
  history.push({ role: "user", text: message }, { role: "assistant", text: out.reply });
  // client merge (TutorSession.tsx)
  const gapMap = new Map(closed.map((g) => [g.id, g.given]));
  S.board = mergeBoardById(S.board, out.board.map((b) => ({ ...b, at: b.at || now }))).map((b) => (gapMap.has(b.id) ? fillGap(b, gapMap.get(b.id)) : b));
  S.problems = mergeBoardById(S.problems, out.problems.map((p) => ({ ...p, createdAt: p.createdAt || now }))).map((p) => ((out.solvedInChat || []).includes(p.id) ? { ...p, solved: true } : p));
  if (out.objectives) S.objectives = out.objectives;
  const rec = { message, reply: out.reply, ms, tokens: { ...out.tokens }, newBoard: out.board, newProblems: out.problems, turn: out.turn, guardrailTripped: out.guardrailTripped, solvedInChat: out.solvedInChat, verdict: stepVerdict?.verdict, objectives: out.objectives };
  S.turns.push(rec);
  return { ...rec, error: false };
}

/** The student answers the open exercise in the widget: graded by code, reported as the client's "[Exercise]" message. */
export function widgetAnswer(S, text) {
  const open = [...S.problems].reverse().find((p) => !p.solved);
  if (!open) return null;
  const attempt = (S.attempts[open.id] = (S.attempts[open.id] || 0) + 1);
  const m = exerciseMessage(open, text, attempt, S.lang);
  if (m.correct) S.problems = S.problems.map((p) => (p.id === open.id ? { ...p, solved: true } : p));
  return { message: m.text, problem: open, correct: m.correct };
}
