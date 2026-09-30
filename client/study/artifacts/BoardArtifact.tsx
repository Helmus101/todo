import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import type { WebTask, BoardEntry, TaskProblem, DiagramOp } from "../../../shared/types.ts";
import { renderChatText, useLang, FirstTimeHint, stripStrayMarkdown } from "../../ui.tsx";

// A guarded DYNAMIC import, not a static `import "katex/dist/katex.min.css"` — this module is also pulled
// in by tests/run.mjs's client-module-graph check, which runs under plain Node/tsx (no Vite), and Node's
// ESM loader hard-crashes on a bare `.css` specifier with ERR_UNKNOWN_FILE_EXTENSION. `typeof window` is
// false in that Node test run, so the import() call inside is never reached there; in an actual browser
// (Vite), it resolves normally and Vite bundles/injects the stylesheet as it would any CSS import.
if (typeof window !== "undefined") { void import("katex/dist/katex.min.css"); }

interface BoardArtifactProps {
  task: WebTask;
  /** True while the tutor's reply is being generated — the board shows a live "Otto écrit…" indicator so
   *  the document feels like it's being drafted in real time next to the conversation, not refreshed after
   *  the fact (reported: board work should feel "smooth, mechanical" — the writing hand is always visible). */
  writing?: boolean;
}

const KIND_LABEL: Record<string, [string, string]> = {
  focus: ["Objectif du jour", "Today's focus"],
  instruction: ["Consigne", "Instruction"],
  formula: ["Formule", "Formula"],
  summary: ["Ton raisonnement", "Your reasoning"],
  problem: ["Problème", "Problem"],
  insight: ["Déclic", "Insight"],
  definition: ["Définition", "Definition"],
  diagram: ["Figure", "Figure"],
};

// Quiet margin glyph per kind — a worksheet's annotations, not badges. Typographic on purpose (no icon
// dependency here), muted, identical across languages.
const KIND_GLYPH: Record<string, string> = {
  focus: "◎",
  instruction: "→",
  formula: "∑",
  summary: "⌇",
  insight: "✦",
  definition: "≡",
  diagram: "◫",
};

const LABEL_SIZE: Record<string, number> = { sm: 12, md: 14, lg: 18 };

/** The completion effect made visible: a worked line the tutor deliberately left unfinished ("= ?", a short
 *  line ending in "?") renders with a highlighted "à toi" chip — the gap is an invitation, not an omission
 *  (Sweller's completion effect: doing the last step yourself is where the learning happens; the prompt
 *  already asks Otto to end worked lines this way, the board now SHOWS it). Only a line ENDING in a gap
 *  marker qualifies, and short, so mid-sentence question marks never trigger it. */
function isCompletionGap(text: string): boolean {
  const t = text.trimEnd();
  if (/[=→>:]\s*\?\s*$/.test(t)) return true;
  const last = t.split("\n").pop() || "";
  return /\?\s*$/.test(last) && last.trim().length <= 40;
}

/** kind:"summary" rendered as a REASONING TRACE — the record of HOW the student got there: dash lines in
 *  the order they actually did it, wrong turns they corrected included. This is the board's centerpiece:
 *  what accumulates on it should increasingly be the student's own thinking, not the tutor's explanation.
 *  (ICAP: the visible artifact of a session is the student's constructions — the tutor's voice stays in chat.) */
function ReasoningTrace({ text, en }: { text: string; en: boolean }) {
  const lines = text.split("\n").map((l) => l.replace(/^\s*[-–—•]\s*/, "").trim()).filter(Boolean);
  if (!lines.length) return null;
  return (
    <div className="sm-board-trace">
      <div className="sm-board-trace-heading">{en ? "How you got there" : "Ton raisonnement"}</div>
      <ol className="sm-board-trace-list">
        {lines.map((l, i) => (
          <li key={i} className={/\b(corrigé?|en fait|non pas|pas ça|oops|my bad)\b/i.test(l) ? "sm-board-trace-turn" : undefined}>{l}</li>
        ))}
      </ol>
    </div>
  );
}

/** Real typeset math (stacked fractions, exponents, roots) instead of formatMath's plain-text approximation
 *  (client/ui.tsx) — this is what makes "2/(x-1) + 3/(x+2)" actually show as a fraction, not a slash. KaTeX
 *  throws on malformed LaTeX (a model slip, an unbalanced brace); caught here so ONE bad equation renders as
 *  its raw source instead of blanking the whole board entry or crashing the canvas. `strict: false` because
 *  a tutoring model's LaTeX is rarely publication-clean (stray spacing, a non-standard macro) and KaTeX's
 *  default strict mode throws console warnings-as-errors for things that still render fine visually. */
function Equation({ latex }: { latex: string }) {
  const html = useMemo(() => {
    try { return katex.renderToString(latex, { throwOnError: true, strict: false, displayMode: true }); }
    catch { try { return katex.renderToString(latex, { throwOnError: false, strict: false, displayMode: true }); } catch { return null; } }
  }, [latex]);
  if (html === null) return <span className="sm-board-eq-fallback">{latex}</span>;
  return <span className="sm-board-eq" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Pure mapping from one DiagramOp (shared/types.ts) to its SVG element — DRAW_ON_BOARD's real-figure
 *  rendering, plus real typeset math via the "equation" op (KaTeX, see Equation above). Coordinates arrive
 *  already clamped to 0-800x0-600 server-side (makeDiagramEntry) — this component trusts that and just draws. */
function DiagramOpSVG({ op }: { op: DiagramOp }) {
  const stroke = op.op !== "label" && "color" in op && op.color ? op.color : "currentColor";
  switch (op.op) {
    case "line":
      return <line x1={op.x1} y1={op.y1} x2={op.x2} y2={op.y2} stroke={stroke} strokeWidth={2} markerEnd={op.arrow ? "url(#sm-diagram-arrow)" : undefined} />;
    case "rect":
      return <rect x={op.x} y={op.y} width={op.w} height={op.h} stroke={stroke} strokeWidth={2} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.15 : undefined} />;
    case "circle":
      return <circle cx={op.cx} cy={op.cy} r={op.r} stroke={stroke} strokeWidth={2} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.15 : undefined} />;
    case "polyline":
      return <polyline points={op.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={2} fill="none" />;
    case "label":
      return <text x={op.x} y={op.y} fontSize={LABEL_SIZE[op.size || "md"]} fill="currentColor">{op.text}</text>;
    case "axes":
      return (
        <g stroke="currentColor" strokeWidth={1.5} fill="currentColor">
          <line x1={op.x} y1={op.y + op.h} x2={op.x + op.w} y2={op.y + op.h} markerEnd="url(#sm-diagram-arrow)" />
          <line x1={op.x} y1={op.y + op.h} x2={op.x} y2={op.y} markerEnd="url(#sm-diagram-arrow)" />
          {op.xLabel ? <text x={op.x + op.w - 4} y={op.y + op.h + 16} fontSize={12} stroke="none" textAnchor="end">{op.xLabel}</text> : null}
          {op.yLabel ? <text x={op.x + 4} y={op.y + 10} fontSize={12} stroke="none">{op.yLabel}</text> : null}
        </g>
      );
    case "equation":
      // Generous, uncapped-looking box (foreignObject can't auto-size to its HTML content in SVG) — KaTeX
      // content is left-aligned and vertically centered inside it via CSS (.sm-board-eq below) so a short
      // equation doesn't look adrift in a huge box and a long one still has real room.
      return (
        <foreignObject x={Math.max(0, op.x - 10)} y={Math.max(0, op.y - 30)} width={800 - Math.max(0, op.x - 10)} height={70}>
          {/* No xmlns needed — React renders this div straight into the live DOM (not serialized XML), same
              as any other JSX inside an SVG foreignObject. */}
          <div className="sm-board-eq-box">
            <Equation latex={op.latex} />
          </div>
        </foreignObject>
      );
    default:
      return null;
  }
}

/** One CREATE_PROBLEM block as it renders IN THE BOARD FLOW (no longer a pinned "current problem" section
 *  above everything — the user's request: problems are part of the lesson's story, interleaved exactly where
 *  they were created between the entries around them). State lives in BoardArtifact (keyed by problem id)
 *  so answers survive the flow being re-sorted or the same problem re-rendering. */
interface ProblemBlockProps {
  problem: TaskProblem;
  sectionNumber: number;
  state: { picked: number | null; textAnswer: string; submitted: boolean };
  hintShown: boolean;
  isCorrect: boolean;
  onShowHint: () => void;
  onPick: (picked: number) => void;
  onTextAnswer: (text: string) => void;
  onSubmit: () => void;
  en: boolean;
}

function ProblemBlock({ problem, sectionNumber, state, hintShown, isCorrect, onShowHint, onPick, onTextAnswer, onSubmit, en }: ProblemBlockProps) {
  const problemIsMCQ = Array.isArray(problem.options) && problem.options.length >= 2;
  const answered = problemIsMCQ ? state.picked !== null : state.submitted;
  return (
    <div className="sm-board-problem sm-board-writein">
      <span className="sm-board-section-num" aria-hidden="true">{String(sectionNumber).padStart(2, "0")}</span>
      <div className="sm-board-entry-main">
      <div className="sm-board-problem-label">{en ? "Problem" : "Problème"}</div>
      <div className="sm-board-problem-q">{stripStrayMarkdown(problem.question)}</div>
      {problem.format && !answered ? <div className="sm-board-problem-format">{problem.format}</div> : null}
      {problem.hint && !answered ? (
        <div className="sm-board-problem-hint-row">
          {hintShown ? (
            <div className="sm-board-problem-hint">{stripStrayMarkdown(problem.hint)}</div>
          ) : (
            <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onShowHint}>
              {en ? "Hint" : "Indice"}
            </button>
          )}
        </div>
      ) : null}
      {problemIsMCQ ? (
        <div className="sm-board-problem-opts">
          {problem.options!.map((opt, oi) => {
            const optState = !answered ? "" : oi === problem.correct ? "correct" : oi === state.picked ? "wrong" : "";
            return (
              <button
                key={oi}
                type="button"
                className={`quiz-opt ${optState}`}
                disabled={answered}
                onClick={() => onPick(oi)}
              >
                <span className="quiz-opt-text">{stripStrayMarkdown(opt)}</span>
                {optState === "correct" && <span className="quiz-opt-mark" aria-hidden="true">✓</span>}
                {optState === "wrong" && <span className="quiz-opt-mark" aria-hidden="true">✗</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sm-board-problem-free">
          {answered ? (
            <div className={`sm-inline-problem-result ${isCorrect ? "correct" : "wrong"}`}>
              {isCorrect
                ? (en ? "Correct !" : "Correct!")
                : (en ? `Not quite — the answer was: ${problem.answer}` : `Non — la réponse était : ${problem.answer}`)}
            </div>
          ) : (
            <div className="sm-inline-problem-input-row">
              <input
                type="text"
                className="sm-inline-problem-input"
                placeholder={en ? "Your answer…" : "Ta réponse…"}
                value={state.textAnswer}
                onChange={e => onTextAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && state.textAnswer.trim()) onSubmit(); }}
                disabled={answered}
              />
              <button
                type="button"
                className="sm-btn sm-btn-primary sm-btn-sm"
                disabled={!state.textAnswer.trim()}
                onClick={onSubmit}
              >
                {en ? "Check" : "Vérifier"}
              </button>
            </div>
          )}
        </div>
      )}
      {answered && problem.why ? (
        <div className="sm-inline-problem-why">{stripStrayMarkdown(problem.why)}</div>
      ) : null}
      </div>
    </div>
  );
}

/** The persistent tutor Board (WRITE_TO_BOARD, server/claude.ts) — a general-purpose surface Otto writes
 *  to at its own discretion, any time: formulas, instructions, running summaries of the student's own reasoning,
 *  and practice problems. ONE DOCUMENT, ONE FLOW: entries and problems interleave in the order the session
 *  actually produced them (a problem sits between the formula it exercises and the insight answering it —
 *  the lesson's story, not a problem section pinned on top). kind:"focus" stays pinned above as the heading. */
export function BoardArtifact({ task, writing }: BoardArtifactProps) {
  const L = useLang();
  const endRef = useRef<HTMLDivElement>(null);
  const entries = task.board || [];
  const problems = task.problems || [];
  // Content-level dedupe on RENDER (by id): sync merges (tasks.ts's unionStudyArtifacts) and a
  // double-responded turn can hand back an array containing the same entry/problem twice. Entries drop
  // kind:"focus" (pinned above as the board's header strip) and any legacy kind:"problem" rows (problems
  // render as flow items from task.problems — never twice). Every problem surface reads the DEDUPED list.
  const dedupedProblems = problems.filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i);
  const latestFocus = [...entries].reverse().find((e) => e.kind === "focus");
  const flowEntries = entries
    .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
    .filter(e => e.kind !== "focus" && (e.kind as string) !== "problem");

  // THE FLOW: entries (by their `at`) and problems (by `createdAt`) merged and sorted by timestamp —
  // the board reads top-to-bottom in the order the session actually happened. A missing/unparseable
  // timestamp sorts to the end (defensive; both writers always stamp).
  const flowItems = useMemo(() => {
    const items: Array<{ key: string; at: number; entry?: BoardEntry; problem?: TaskProblem }> = [];
    for (const e of flowEntries) items.push({ key: e.id, at: Date.parse(e.at || "") || Number.MAX_SAFE_INTEGER, entry: e });
    for (const p of dedupedProblems) items.push({ key: p.id, at: Date.parse(p.createdAt || "") || Number.MAX_SAFE_INTEGER, problem: p });
    items.sort((a, b) => a.at - b.at);
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, problems.length]);

  const [showHint, setShowHint] = useState<{ [key: string]: boolean }>({});
  const [problemState, setProblemState] = useState<{ [key: string]: { picked: number | null; textAnswer: string; submitted: boolean } }>({});

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, problems.length]);

  const setProblemPicked = (problemId: string, picked: number | null) => {
    setProblemState(prev => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, picked, submitted: false } }));
  };

  const setProblemTextAnswer = (problemId: string, textAnswer: string) => {
    setProblemState(prev => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, textAnswer, submitted: false } }));
  };

  const submitProblem = (problemId: string) => {
    setProblemState(prev => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, submitted: true } }));
  };

  const getProblemState = (problemId: string) => problemState[problemId] || { picked: null, textAnswer: "", submitted: false };

  // Free-response check: trimmed, case-insensitive comparison
  const checkFreeResponse = (problemId: string): boolean => {
    const problem = problems.find(p => p.id === problemId);
    if (!problem || !problem.answer) return false;
    const state = getProblemState(problemId);
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return normalize(state.textAnswer) === normalize(problem.answer);
  };

  const hint = (
    <FirstTimeHint
      id="board"
      title={L("Le tableau d'Otto", "Otto's board")}
      body={L(
        "Otto construit ici un document de séance, entrée par entrée : l'objectif du jour, les définitions et formules clés, tes propres déclics, un résumé de ton raisonnement — et des problèmes à résoudre. Toujours accessible, pas besoin de le rouvrir à chaque fois.",
        "Otto builds a session document here, entry by entry: today's focus, key definitions and formulas, your own insights, a summary of your reasoning — and problems to solve. Always accessible, no need to reopen it each time.",
      )}
    />
  );

  const hasContent = entries.length > 0 || problems.length > 0;

  if (!hasContent) {
    return (
      <div className="sm-board-body">
        {hint}
        <div className="sm-board-header">
          <span className="sm-board-header-date">
            {new Date().toLocaleDateString(L("fr", "en") === "en" ? "en-US" : "fr-FR", { weekday: "long", day: "numeric", month: "long" })}
          </span>
          {task.sourceSubject ? <span className="sm-board-header-subject">{task.sourceSubject}</span> : null}
        </div>
        <div className="sm-board-empty">
          {L(
            "Le document de séance se construira ici — objectif du jour, définitions, formules, déclics, résumés — dès que ce sera utile.",
            "The session document will build here — today's focus, definitions, formulas, insights, summaries — whenever it's useful.",
          )}
        </div>
        {writing ? (
          <div className="sm-board-drafting" role="status" aria-live="polite">
            <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {L("fr", "en") === "en" ? "Otto is writing…" : "Otto écrit…"}
          </div>
        ) : null}
      </div>
    );
  }

  const en = L("fr", "en") === "en";

  return (
    <div className="sm-board-body">
      {hint}

      {/* THE WORKSHEET HEADER — date + subject above the pinned goal, like a lesson page's heading block:
          the board is a document you could print and keep, not a feed. The subject comes from the task's
          sourceSubject (stamped at session start); date is today (the board is per-session). */}
      <div className="sm-board-header">
        <span className="sm-board-header-date">
          {new Date().toLocaleDateString(en ? "en-US" : "fr-FR", { weekday: "long", day: "numeric", month: "long" })}
        </span>
        {task.sourceSubject ? <span className="sm-board-header-subject">{task.sourceSubject}</span> : null}
      </div>

      {/* The pinned session goal (kind:"focus") — always the FIRST thing on the board, like the heading of
          a lesson page: the day's arc stays visible no matter how long the flow below grows. The latest
          focus wins if a session ever writes a second one. */}
      {latestFocus ? (
        <div className="sm-board-focus-pin">
          <span className="sm-board-entry-kind"><span className="sm-board-glyph">{KIND_GLYPH.focus}</span>{L(...KIND_LABEL.focus)}</span>
          <div className="sm-board-focus-text">{renderChatText(latestFocus.text)}</div>
        </div>
      ) : null}

      {/* ONE FLOW — entries and problems interleaved by timestamp, in the order the session produced them.
          Problems are NOT a pinned section: a CREATE_PROBLEM sits right between the entry that set it up and
          the insight that answered it. Every item gets a worksheet section number (01, 02, …) — the document
          is being drafted, section by section, not fed in as cards. */}
      {flowItems.map((item, idx) =>
        item.problem ? (
          <ProblemBlock
            key={item.key}
            problem={item.problem}
            sectionNumber={idx + 1}
            state={getProblemState(item.problem.id)}
            hintShown={!!showHint[item.problem.id]}
            isCorrect={checkFreeResponse(item.problem.id)}
            onShowHint={() => setShowHint(prev => ({ ...prev, [item.problem!.id]: true }))}
            onPick={(picked) => setProblemPicked(item.problem!.id, picked)}
            onTextAnswer={(text) => setProblemTextAnswer(item.problem!.id, text)}
            onSubmit={() => submitProblem(item.problem!.id)}
            en={en}
          />
        ) : (() => {
          const e = item.entry!;
          return (
            <div key={item.key} className={`sm-board-entry sm-board-entry-${e.kind || "note"} sm-board-writein`}>
              <span className="sm-board-section-num" aria-hidden="true">{String(idx + 1).padStart(2, "0")}</span>
              <div className="sm-board-entry-main">
              {e.kind && KIND_LABEL[e.kind] ? (
                <span className="sm-board-entry-kind">
                  {KIND_GLYPH[e.kind] ? <span className="sm-board-glyph" aria-hidden="true">{KIND_GLYPH[e.kind]}</span> : null}
                  {L(...KIND_LABEL[e.kind])}
                </span>
              ) : null}
              {e.kind === "diagram" && e.diagram?.length ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption">{stripStrayMarkdown(e.text)}</div>
                  <svg viewBox="0 0 800 600" className="sm-board-diagram" preserveAspectRatio="xMidYMid meet">
                    <defs>
                      <marker id="sm-diagram-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                        <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                      </marker>
                    </defs>
                    {e.diagram.map((op, i) => <DiagramOpSVG key={i} op={op} />)}
                  </svg>
                </>
              ) : e.kind === "summary" ? (
                <ReasoningTrace text={e.text} en={en} />
              ) : (
                <>
                  <div className="sm-board-entry-text">{renderChatText(e.text)}</div>
                  {isCompletionGap(e.text) ? (
                    <span className="sm-board-todo-chip">{en ? "Your turn to finish" : "À toi de finir"}</span>
                  ) : null}
                </>
              )}
              </div>
            </div>
          );
        })()
      )}

      {/* The live drafting indicator — while the tutor's reply is being generated the document shows its
          writing hand ("Otto écrit…"), so new entries arrive as the continuation of a visible act of
          writing, not a swap of the page. Shown on the EMPTY board too (that's exactly when the session
          needs to feel alive, not blank). */}
      {writing ? (
        <div className="sm-board-drafting" role="status" aria-live="polite">
          <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          {en ? "Otto is writing…" : "Otto écrit…"}
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
