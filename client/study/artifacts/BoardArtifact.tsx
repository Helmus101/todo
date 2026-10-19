import { MathAnswerInput } from "../MathAnswerInput.tsx";
import { BlockBoundary } from "./BlockBoundary.tsx";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import type { WebTask, BoardEntry, TaskProblem, DiagramOp } from "../../../shared/types.ts";
import { sourceRuns, type TableSpec, type SourceSpec } from "../../../shared/boardTable.ts";
import { isNumericAnswer, problemIsPercent } from "../../../shared/types.ts";
import { gradeExerciseAnswer, gradeConceptAnswer, type GradeStatus } from "../../../shared/exerciseVerification.ts";
import { autoMathLine, repairLatex, latexToPlainText } from "../../../shared/mathText.ts";
import { GraphBlock } from "./GraphBlock.tsx";
import { FlowDiagram } from "./FlowDiagram.tsx";
import { sanitizeSvg, plainLabel } from "../../../shared/svgSafe.ts";
import { boardLineNumbers } from "../../../shared/boardLines.ts";
import { WidgetBlock, type WidgetResult } from "./WidgetBlock.tsx";
import { renderChatText, useLang, FirstTimeHint, stripStrayMarkdown, formatMath, boldify } from "../../ui.tsx";

// A guarded DYNAMIC import, not a static `import "katex/dist/katex.min.css"` — this module is also pulled
// in by tests/run.mjs's client-module-graph check, which runs under plain Node/tsx (no Vite), and Node's
// ESM loader hard-crashes on a bare `.css` specifier with ERR_UNKNOWN_FILE_EXTENSION. `typeof window` is
// false in that Node test run, so the import() call inside is never reached there; in an actual browser
// (Vite), it resolves normally and Vite bundles/injects the stylesheet as it would any CSS import.
// The stylesheet is ALSO imported statically from client/main.tsx: without it KaTeX's hidden MathML copy
// shows next to the HTML copy (every equation printed twice). Both renderers below also pass
// output:"html", so even a missing stylesheet can no longer double the text.
if (typeof window !== "undefined") { void import("katex/dist/katex.min.css"); }

interface BoardArtifactProps {
  task: WebTask;
  /** Undo the last board change (Tutor session) — rendered in the board's own header row, not floating over content. */
  onUndo?: () => void;
  /** True while the tutor's reply is being generated — the board shows a live "Otto écrit…" indicator so
   *  the document feels like it's being drafted in real time next to the conversation, not refreshed after
   *  the fact (reported: board work should feel "smooth, mechanical" — the writing hand is always visible). */
  writing?: boolean;
  /** Tutor only — fired on every answer attempt (right or wrong) so Otto can react to it like a person would
   *  ("what made you pick B?") instead of the board silently marking it. `attempt` counts tries on this
   *  problem including this one. Never carries the correct answer — only what the student gave. */
  onProblemResult?: (r: { problem: TaskProblem; given: string; correct: boolean; attempt: number; /** a sealed exercise answered right: the correct option and explanation the server just revealed (the page stores them with the solved exercise). */ reveal?: { correct?: number; why?: string }; /** the item's own key and the independently computed value disagreed — nobody's mistake (spec §19.1). */ systemError?: boolean; /** a worded answer had some, not all, of the rubric's key ideas (spec §8.3). */ partial?: boolean }) => void;
  /** Tutor only — a match / order / sort activity was finished (how many slips), so Otto can react to it. */
  onWidgetResult?: (r: WidgetResult) => void;
  /** Tutor only — each bump reserves `height` px of blank space right after the board's CURRENT last item: the
   *  student drew on the blank page below, and whatever Otto writes next must land AFTER that drawing. */
  sheetSignal?: { n: number; height: number };
  /** Tutor only — a gap with an answer key ("b = ?") gets an answer box; the attempt is graded by the SERVER
   *  (numeric equivalence, shared/mathEquiv.ts) and the result reaches Otto like an exercise result does. */
  onGapCheck?: (entry: BoardEntry, given: string) => Promise<"correct" | "incorrect" | "unknown" | "system_error">;
  /** Tutor only — an exercise whose key is SEALED (it carries a `keyToken`, never the answer) is graded by the server; what comes back is only what the
   *  student has earned (the explanation and the correct option appear after a right answer). Exercises from an older stored board still grade locally. */
  onCheckProblem?: (problem: TaskProblem, given: string) => Promise<ServerGrade>;
}
/** What the server tells the student about one answer. */
export type ServerGrade = { status: GradeStatus; correct?: number; why?: string; miss?: string };

/** The answer box under an open gap. "unknown" (an answer the checker couldn't read) is never shown as
 *  wrong, and neither is "system_error" (the stored key disagreed with the value the app computed itself,
 *  spec §19.4) — both say Otto will look at it, and the attempt still goes to the tutor. */
function GapAnswer({ entry, onCheck, en }: { entry: BoardEntry; onCheck: NonNullable<BoardArtifactProps["onGapCheck"]>; en: boolean }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<"correct" | "incorrect" | "unknown" | "system_error" | "failed" | null>(null);
  const submit = async () => {
    const given = value.trim();
    if (!given || busy) return;
    setBusy(true);
    try { setVerdict(await onCheck(entry, given)); } catch { setVerdict("failed"); } finally { setBusy(false); }
  };
  if (verdict === "correct") return <div className="sm-inline-problem-result correct">{"Correct!"}</div>;
  return (
    <div className="sm-board-problem-free sm-board-gap-answer">
      <div className="sm-inline-problem-input-row">
        <MathAnswerInput
          en={en}
          showKeys={!(entry.answerKind ? entry.answerKind === "number" : isNumericAnswer(entry.expectedAnswer || ""))}
          answer={entry.expectedAnswer || ""}
          context={entry.text || ""}
          placeholder={"Your answer…"}
          value={value}
          onChange={(v) => { setValue(v); if (verdict) setVerdict(null); }}
          onEnter={() => void submit()}
          ariaLabel={"Your answer for this line"}
        />
        <button type="button" className="sm-btn sm-btn-primary sm-btn-sm" disabled={!value.trim() || busy} onClick={() => void submit()}>
          {"Check"}
        </button>
      </div>
      {verdict === "incorrect" ? <div className="sm-inline-problem-result wrong" role="status">{"Not quite — Otto will help you check it."}</div> : null}
      {verdict === "unknown" ? <div className="sm-inline-problem-result" role="status">{"Sent to Otto to look at."}</div> : null}
      {verdict === "failed" ? <div className="sm-inline-problem-result wrong" role="alert">{"Couldn't check that just now — try again."}</div> : null}
      {verdict === "system_error" ? <div className="sm-inline-problem-result" role="status">{"Otto can't trust this line's answer key — he'll check it with you."}</div> : null}
    </div>
  );
}

const LABEL_SIZE: Record<string, number> = { sm: 12, md: 14, lg: 18 };

/** Decorative glyphs a model sometimes prefixes a step with ("○ 6. collect → …"). They carry no meaning at
 *  all, and left in place they render as part of the step's own text. */
const STEP_DECOR = "•·▪‣∙◦∘○●◯◆◇";
const LEAD_DECOR_RE = new RegExp(`^[\\s${STEP_DECOR}\\-–—*]+`);
/** The line's own list marker: "3. " / "10) ". */
const LEAD_MARKER_RE = /^(\d{1,2})[.)]\s*/;

/** ONE LINE, SEVERAL STEPS. The model intermittently packs two numbered moves onto a single line
 *  ("5. ○ 6. collect → 3sec²x − 17sec x − 28 = 0"), and the board then rendered it as step 5 whose text read
 *  "○ 6 collect → …" — a stray glyph and a second step number inside one step (reported live, with a
 *  screenshot). Such a line is split at every embedded marker that CONTINUES the line's own numbering
 *  (1,2,3…), which is what keeps a legitimate "2)" inside prose ("divide by 2) then…") from being torn into
 *  a bogus step. Exported for unit tests. */
export function splitMergedSteps(line: string): string[] {
  const first = LEAD_MARKER_RE.exec(line.trimStart());
  if (!first) return [line];
  const body = line.trimStart().slice(first[0].length);
  const pieces: string[] = [];
  const boundary = new RegExp(`[\\s${STEP_DECOR}]+(?=\\d{1,2}[.)]\\s)`, "g");
  let cursor = 0;
  let expected = Number(first[1]) + 1;
  for (let m = boundary.exec(body); m; m = boundary.exec(body)) {
    const at = m.index + m[0].length;
    const num = Number(/^(\d{1,2})/.exec(body.slice(at))?.[1]);
    // Not the next step the model would be numbering → this is prose, leave it in place.
    if (!(num >= expected && num <= expected + 2)) continue;
    pieces.push(body.slice(cursor, m.index));
    cursor = at;
    expected = num + 1;
  }
  pieces.push(body.slice(cursor));
  return pieces;
}

/** "How you got there", one step per rendered line. Exported for unit tests. */
export function traceLines(text: string): string[] {
  const rawLines = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, "").split("\n");
  const lines: string[] = [];
  for (const raw of rawLines) {
    // Peel the line's own marker AND any glyphs around it, from both ends of the marker: "○ 6. x" and
    // "6. ○ x" are the same step written by a model that decorates and double-numbers freely.
    for (const piece of splitMergedSteps(raw)) {
      const cleaned = piece.replace(LEAD_DECOR_RE, "").replace(LEAD_MARKER_RE, "").replace(LEAD_DECOR_RE, "").trim();
      if (cleaned) lines.push(cleaned);
    }
  }
  // The model sometimes adds its own header (or a lead-in ending in a colon) — the board draws the
  // heading itself, so that first line would otherwise count as step one.
  while (lines.length > 1 && (/^(how you got there|ton raisonnement)\b/i.test(lines[0]) || /:\s*$/.test(lines[0]))) lines.shift();
  return lines;
}

// Reported live: a board question rendered as "...05 m*underaforceof*10 N, *what's*k?" — the model had
// wrapped a whole PROSE phrase in $…$ (over-applying the board prompt's "maths in $…$" instruction to a
// sentence fragment, not just the actual numbers/variables). KaTeX happily "renders" that: real English
// words become a run of individually-italicized single-letter atoms with none of their original spacing
// (math mode has no concept of word-spacing), which is exactly the jammed-together, italic mess reported.
// Guard: a captured $…$ span only goes to KaTeX if it actually LOOKS like math — plain multi-letter
// English words (not a recognized function/unit/greek name) are the tell that this is misplaced prose,
// not an equation. A real equation ("0.05 m", "F = ma", "\sin(x)") has at most one such word, if any.
const MATH_WORD_ALLOW = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "sqrt", "frac", "mod", "min", "max",
  "det", "gcd", "arg", "sup", "inf", "pi", "theta", "alpha", "beta", "gamma", "delta", "lambda", "mu",
  "sigma", "phi", "omega", "eta", "rho", "tau", "chi", "psi", "nu", "xi", "zeta", "kappa",
  // the other macros a tutoring model actually writes — without these, a perfectly good equation whose
  // latex uses two unfamiliar commands ("\Rightarrow … \approx …") counted as 2 "prose words", tripped
  // the gate and fell back to plain text, which is how the (1)/(2) pseudo-fractions reached the chat.
  "tfrac", "dfrac", "cfrac", "approx", "Rightarrow", "rightarrow", "Leftrightarrow", "infty", "times", "div",
  "cdot", "cdots", "ldots", "dots", "angle", "perp", "parallel", "cong", "sim", "equiv", "propto",
  "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "gcd",
]);
export function looksLikeRealMath(latex: string): boolean {
  // A backslash command is never prose: "\displaystyle \frac{h}{100+\tan 25^\circ}" fell back to raw source
  // because "displaystyle" and "circ" counted as two English words (reported live on the tower problem).
  // Only bare words count; the words inside \text{…} are still bare, so prose-in-\text still trips the gate.
  const words = latex.replace(/\\[a-zA-Z]+/g, " ").match(/\p{L}{3,}/gu) || [];
  const prose = words.filter((w) => !MATH_WORD_ALLOW.has(w.toLowerCase()));
  return prose.length < 2;
}

/** Prose with real typeset math inline: `$…$` and `\(…\)` segments go through KaTeX, everything else through
 *  the normal chat renderer (bold, ==highlight==, unicode math). A bad equation falls back to its source. */
export function MathText({ text }: { text: string }) {
  // Bare model maths (no $…$: "E = \tfrac12(250)(0.12)^2 = 1.8\ J", "(1)/(2)(0.5)v² = 1.8 ⇒ v ≈ 2.68\ m/s")
  // used to fall straight through to formatMath's plain-text approximation — literal \tfrac commands and
  // (1)/(2) pseudo-fractions in the chat, reported live twice. autoMathLine wraps each line's maths in $…$
  // FIRST so the KaTeX path below renders real stacked fractions; prose passes through untouched and text
  // already in $…$ is left alone (autoMathLine is a no-op on it), so this is safe for every caller.
  const auto = autoMathLine(repairLatex(text));
  const parts = auto.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g);
  if (parts.length === 1) return <>{renderChatText(auto)}</>;
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\$\$([^$]+)\$\$$|^\$([^$\n]+)\$$|^\\\(([\s\S]*)\\\)$|^\\\[([\s\S]*)\\\]$/.exec(p);
        const latex = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
        return latex && looksLikeRealMath(latex)
          ? <InlineEquation key={i} latex={latex.trim()} />
          : <span key={i} style={{ whiteSpace: "pre-wrap" }}>{boldify(formatMath(latex ?? p))}</span>;
      })}
    </>
  );
}

/** Otto points at a line the way a tutor does with a pen: circle, box, underline, arrow, cross or tick. Drawn with CSS on
 *  the line itself (no measured overlay), so it can't drift out of place when the board reflows. */
function markClass(marks?: BoardEntry[]): string {
  const m = (marks || []).find((a) => a.markStyle);
  return m ? ` sm-mark sm-mark-${m.markStyle} sm-mark-${m.tone || "focus"}` : "";
}

function InlineEquation({ latex }: { latex: string }) {
  const html = useMemo(() => {
    try { return katex.renderToString(/\\frac|\\sqrt/.test(latex) ? `\\displaystyle ${latex}` : latex, { throwOnError: false, strict: false, trust: false, displayMode: false, output: "html", maxSize: 20, maxExpand: 500 }); } catch { return null; }
  }, [latex]);
  if (html === null) return <span>{latexToPlain(latex)}</span>;
  return <span className="sm-inline-eq" role="math" aria-label={latexToPlain(latex)} dangerouslySetInnerHTML={{ __html: html }} />;
}

// The "how you got there" reasoning-trace box is gone by direct instruction — a board line is a board line:
// no heading, no numbering, no category, just the work written out (kind:"summary" now renders like any
// other text entry). traceLines below stays exported: it still backs the model's own header-peeling and tests.

/** The student's reasoning, written as plain lines on the page — one step per line, no heading, no boxes. */
function PlainSteps({ text }: { text: string }) {
  const lines = traceLines(text);
  if (!lines.length) return null;
  return <>{lines.map((l, i) => <div key={i} className="sm-board-line"><MathText text={autoMathLine(l)} /></div>)}</>;
}

/** An AI-authored interactive scene (CREATE_INTERACTIVE, server/claude.ts) — rendered in a sandboxed
 *  iframe via `srcdoc`, DELIBERATELY without `allow-same-origin`, `allow-top-navigation`, or
 *  `allow-popups`: without allow-same-origin the iframe's document is an opaque, unique origin, so its
 *  script can't read this app's DOM/cookies/localStorage or call window.parent, and with no top-
 *  navigation/popups it can't navigate away or spawn windows either. `allow-scripts` alone is what the
 *  scene actually needs to run. The server already stripped any non-allowlisted <script src> and any
 *  nested <iframe>/<object>/<embed> (makeInteractiveEntry) before this ever reaches the client — this is
 *  the second, independent layer (sandbox attributes), not the only one.
 *
 *  Why `src` and not `srcdoc`: a srcdoc frame INHERITS the embedding page's CSP, and this app's policy has
 *  no 'unsafe-inline' in script-src — so with srcdoc every scene's script (the model's, and our own
 *  blank-guard) was silently blocked and the frame rendered EMPTY. The scene is therefore served from its
 *  own same-origin route (/api/interactive, server/index.ts), which carries its own much tighter CSP and
 *  wraps the html in the blank-guard document (interactiveSceneDocument, server/claude.ts). */
function InteractiveFrame({ taskId, entryId }: { taskId: string; entryId: string }) {
  return (
    <iframe
      className="sm-board-interactive-frame"
      src={`/api/interactive/${encodeURIComponent(taskId)}/${encodeURIComponent(entryId)}`}
      sandbox="allow-scripts"
      title="interactive"
      loading="lazy"
    />
  );
}

/** Pure mapping from one DiagramOp (shared/types.ts) to its SVG element — DRAW_ON_BOARD's real-figure
 *  rendering, plus real typeset math via the "equation" op (KaTeX, see Equation above). Coordinates arrive
 *  already clamped to 0-800x0-600 server-side (makeDiagramEntry) — this component trusts that and just draws. */
/** LaTeX → readable plain text for figure labels (figures are SVG text, never KaTeX). */
function latexToPlain(latex: string): string {
  return formatMath(latexToPlainText(latex));
}
/** Tight viewBox around what a figure actually draws (so no dead space above/below it), with a little margin. */
function opsViewBox(ops: DiagramOp[]): string {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const o of ops as any[]) {
    if (o.op === "line") { add(o.x1, o.y1); add(o.x2, o.y2); }
    else if (o.op === "rect") { add(o.x, o.y); add(o.x + o.w, o.y + o.h); }
    else if (o.op === "circle" || o.op === "arc") add(o.cx, o.cy, o.r);
    else if (o.op === "polyline" || o.op === "polygon") for (const p of o.points || []) add(p.x, p.y);
    else if (o.op === "axes") { add(o.x, o.y); add(o.x + o.w, o.y + o.h); }
    else if (o.op === "label") add(o.x + ((o.text || "").length * 5), o.y, 12);
    else if (o.op === "equation") add(o.x + 140, o.y, 16);
  }
  if (!Number.isFinite(x0)) return "0 0 800 600";
  const pad = 28;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(800, x1 + pad); y1 = Math.min(600, y1 + pad);
  return `${Math.round(x0)} ${Math.round(y0)} ${Math.max(120, Math.round(x1 - x0))} ${Math.max(80, Math.round(y1 - y0))}`;
}

/** `partId` scopes the op's stable id to its own figure (shared/geometry.ts gives every element one, so the
 *  tutor can say "highlight segment_AB" and the app points at that exact element rather than redrawing). */
function DiagramOpSVG({ op, partId }: { op: DiagramOp; partId?: string }) {
  const stroke = op.op !== "label" && "color" in op && op.color ? op.color : "currentColor";
  // data-geo-id, not id: ids share a document with <marker id> references, and the scoped value can contain ':'.
  const gid = op.id && partId ? { "data-geo-id": `${partId}#${op.id}` } : {};
  switch (op.op) {
    case "line":
      return <line {...gid} x1={op.x1} y1={op.y1} x2={op.x2} y2={op.y2} stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeDasharray={op.dashed ? "6 5" : undefined} markerEnd={op.arrow ? "url(#sm-diagram-arrow)" : undefined} />;
    case "rect":
      return <rect {...gid} x={op.x} y={op.y} width={op.w} height={op.h} stroke={stroke} strokeWidth={2} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.15 : undefined} />;
    case "circle":
      return <circle {...gid} cx={op.cx} cy={op.cy} r={op.r} stroke={op.r <= 4 && op.fill ? "none" : stroke} strokeWidth={2} strokeDasharray={op.dashed ? "6 5" : undefined} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? (op.r <= 4 ? 1 : 0.15) : undefined} />;
    case "polyline":
      return <polyline {...gid} points={op.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={2} strokeDasharray={op.dashed ? "6 5" : undefined} strokeLinejoin="round" fill="none" />;
    case "polygon":
      return <polygon {...gid} points={op.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={2} strokeLinejoin="round" fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.12 : undefined} />;
    case "arc": {
      const rad = (d: number) => (d * Math.PI) / 180;
      const sweep = op.a1 > op.a0;
      const large = Math.abs(op.a1 - op.a0) > 180 ? 1 : 0;
      // a full turn collapses start and end onto one point (SVG draws nothing) — pull the end in a hair.
      const end = Math.abs(op.a1 - op.a0) >= 359.9 ? op.a0 + (sweep ? 359.9 : -359.9) : op.a1;
      const sx = op.cx + op.r * Math.cos(rad(op.a0)), sy = op.cy + op.r * Math.sin(rad(op.a0));
      const ex = op.cx + op.r * Math.cos(rad(end)), ey = op.cy + op.r * Math.sin(rad(end));
      return <path {...gid} d={`M ${sx} ${sy} A ${op.r} ${op.r} 0 ${large} ${sweep ? 1 : 0} ${ex} ${ey}`} stroke={stroke} strokeWidth={2} strokeDasharray={op.dashed ? "6 5" : undefined} fill="none" />;
    }
    case "label": {
      const mid = op.anchor === "middle";
      const t = formatMath(/\$/.test(op.text) ? plainLabel(op.text) : op.text);
      return <text {...gid} x={op.x} y={op.y} fontSize={LABEL_SIZE[op.size || "md"]} fill="currentColor" textAnchor={mid ? "middle" : "start"} dominantBaseline={mid ? "central" : undefined} fontStyle={/^[A-Za-z][′'₀-₉0-9]*$/.test(t) ? "italic" : undefined}>{t}</text>;
    }
    case "axes":
      return (
        <g stroke="currentColor" strokeWidth={1.5} fill="currentColor">
          <line x1={op.x} y1={op.y + op.h} x2={op.x + op.w} y2={op.y + op.h} markerEnd="url(#sm-diagram-arrow)" />
          <line x1={op.x} y1={op.y + op.h} x2={op.x} y2={op.y} markerEnd="url(#sm-diagram-arrow)" />
          {op.xLabel ? <text x={op.x + op.w - 4} y={op.y + op.h + 16} fontSize={12} stroke="none" textAnchor="end">{plainLabel(op.xLabel)}</text> : null}
          {op.yLabel ? <text x={op.x + 4} y={op.y + 10} fontSize={12} stroke="none">{plainLabel(op.yLabel)}</text> : null}
        </g>
      );
    case "equation": {
      // Diagrams are plain SVG text now (no KaTeX): the equation is rendered as readable text next to the figure.
      const t = latexToPlain(op.latex);
      return <text x={op.x} y={op.y} fontSize={16} fill="currentColor" fontStyle="italic">{t}</text>;
    }
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
  state: ProblemState;
  hintShown: boolean;
  isCorrect: boolean;
  onShowHint: () => void;
  onPick: (picked: number) => void;
  onTextAnswer: (text: string) => void;
  onSubmit: () => void;
  en: boolean;
  fresh?: boolean;
  /** The submitted answer met a stored key that contradicts the verified value (spec §19.1): never shown as wrong. */
  systemError?: boolean;
  /** What the server said about a sealed exercise (the correct option and explanation only once right; a worded miss message). */
  info?: ServerGrade;
}

// A practice problem NEVER reveals its answer. Reported live ("it gives the answer, this should never
// happen"): a wrong pick used to light up the correct option ✓ and show the full worked explanation, and a
// wrong typed answer printed "Not quite — the answer was: …". Now a miss only says "try again" (the wrong
// option is struck out, a typed answer stays editable); the ✓ and the explanation appear only once the
// student gets it right themselves.
type ProblemState = { picked: number | null; textAnswer: string; submitted: boolean; wrong?: number[] };

/** A rubric-graded (worded) answer's specific miss message (spec §8.3/§8.6): "partly right — an idea is missing",
 *  or "related idea, not what's asked" — instead of a bare "Not quite". null for anything without a rubric. Never
 *  reveals the model answer. Exported for tests. */
export function conceptMissMessage(problem: Pick<TaskProblem, "rubric">, given: string, en: boolean): string | null {
  if (!problem.rubric?.required?.length || !String(given || "").trim()) return null;
  const g = gradeConceptAnswer(problem.rubric, given);
  if (g.status === "partially_correct") return `Partly right — you have ${g.met} of the ${g.total} key ideas. What's still missing?`;
  if (g.misconception) return `"${g.misconception}" is a related idea, but it isn't what's being asked here. Try again.`;
  return null;
}

function ProblemBlock({ problem, sectionNumber, state, hintShown, isCorrect, systemError, info, onShowHint, onPick, onTextAnswer, onSubmit, en, fresh }: ProblemBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const problemIsMCQ = Array.isArray(problem.options) && problem.options.length >= 2;
  const wrong = state.wrong || [];
  const correctIdx = problem.correct ?? info?.correct; // a sealed exercise learns its correct option only once the student has it right
  const numericBox = problem.answerKind ? problem.answerKind === "number" : isNumericAnswer(problem.answer);
  const answered = !!problem.solved || (problemIsMCQ ? state.picked !== null && state.picked === correctIdx : state.submitted && isCorrect);
  const missed = !answered && !systemError && (problemIsMCQ ? wrong.length > 0 : state.submitted);

  if (answered && !expanded) {
    return (
      <div
        className={`sm-board-problem sm-board-problem-solved-compact sm-board-writein${fresh ? " sm-board-reveal" : ""}`}
        style={fresh ? { animationDuration: `.35s, ${Math.min(1.6, Math.max(0.5, problem.question.length / 90))}s` } : undefined}
      >
        <div className="sm-board-entry-main">
          <div className="sm-board-problem-compact-inner">
            <span className="sm-board-problem-compact-mark" aria-hidden="true">✓</span>
            <span className="sm-board-problem-compact-q"><MathText text={stripStrayMarkdown(problem.question)} /></span>
            <button type="button" className="sm-btn sm-btn-ghost sm-btn-xs sm-board-compact-btn" onClick={() => setExpanded(true)}>
              {"Details"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sm-board-problem sm-board-writein${answered ? " sm-board-problem-solved" : ""}${fresh ? " sm-board-reveal" : ""}`}
      style={fresh ? { animationDuration: `.35s, ${Math.min(1.6, Math.max(0.5, problem.question.length / 90))}s` } : undefined}
    >
      <div className="sm-board-entry-main">
      <div className="sm-board-problem-heading-row">
        <div className="sm-board-problem-label">{answered ? ("Resolved") : ("Your turn")}</div>
        {answered && (
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-xs sm-board-compact-btn" onClick={() => setExpanded(false)}>
            {"Compact"}
          </button>
        )}
      </div>
      <div className="sm-board-problem-q"><MathText text={stripStrayMarkdown(problem.question)} /></div>
      {problem.source && /^https:\/\//i.test(problem.source.url) ? <a className="sm-board-problem-source" href={problem.source.url} target="_blank" rel="noopener noreferrer">{"Source"}: {problem.source.name} ↗</a> : null}
      {problem.format && !answered ? <div className="sm-board-problem-format"><MathText text={problem.format} /></div> : null}
      {problem.hint && !answered ? (
        <div className="sm-board-problem-hint-row">
          {hintShown ? (
            <div className="sm-board-problem-hint"><MathText text={stripStrayMarkdown(problem.hint)} /></div>
          ) : (
            <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onShowHint}>
              {"Hint"}
            </button>
          )}
        </div>
      ) : null}
      {problemIsMCQ ? (
        <div className="sm-board-problem-opts">
          {problem.options!.map((opt, oi) => {
            const optState = answered && oi === correctIdx ? "correct" : wrong.includes(oi) ? "wrong" : "";
            return (
              <button
                key={oi}
                type="button"
                className={`quiz-opt ${optState}`}
                disabled={answered || wrong.includes(oi)}
                onClick={() => onPick(oi)}
              >
                <span className="quiz-opt-text"><MathText text={stripStrayMarkdown(opt)} /></span>
                {optState === "correct" && <span className="quiz-opt-mark" aria-hidden="true">✓</span>}
                {optState === "wrong" && <span className="quiz-opt-mark" aria-hidden="true">✗</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sm-board-problem-free">
          {answered ? (
            <div className="sm-inline-problem-result correct">{"Correct!"}</div>
          ) : (
            <div className="sm-inline-problem-input-row">
              <MathAnswerInput
                en={en}
                showKeys={!numericBox}
                answer={problem.answer || ""}
                context={problem.question || ""}
                placeholder={numericBox ? ("Your answer (a number, no units)…") : ("Your answer…")}
                value={state.textAnswer}
                onChange={onTextAnswer}
                onEnter={() => { if (state.textAnswer.trim()) onSubmit(); }}
                disabled={answered}
              />
              <button
                type="button"
                className="sm-btn sm-btn-primary sm-btn-sm"
                disabled={!state.textAnswer.trim()}
                onClick={onSubmit}
              >
                {"Check"}
              </button>
            </div>
          )}
        </div>
      )}
      {missed ? (
        <div className="sm-inline-problem-result wrong" role="status">
          {problemIsMCQ
            ? ("Not quite — try another option.")
            : info?.miss || conceptMissMessage(problem, state.textAnswer, en) || ("Not quite — try again.")}
        </div>
      ) : null}
      {systemError && state.submitted && !answered ? (
        <div className="sm-inline-problem-result" role="status">
          {"This exercise's answer key disagrees with the verified value — your answer isn't counted wrong. Otto will sort it out."}
        </div>
      ) : null}
      {answered && (problem.why || info?.why) ? (
        <div className="sm-inline-problem-why"><MathText text={stripStrayMarkdown(problem.why || info?.why || "")} /></div>
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
/** Two headings that say the same thing ("Test-2 prep: Exponents & Logarithms" / "Math HL Test-2 Prep: Exponents &
 *  Logarithms"): most of the shorter one's words appear in the other. Exported for tests. */
export function nearSameHeading(a: string, b: string): boolean {
  const words = (x: string) => new Set(String(x || "").toLowerCase().replace(/\$[^$]*\$/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return [...small].filter((w) => big.has(w)).length / small.size >= 0.8;
}

/** A table on the board. With `hideColumn` set (recall practice) those cells stay hidden until the student reveals them. */
function BoardTable({ spec, en }: { spec: TableSpec; en: boolean }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const hide = spec.hideColumn;
  const reveal = (i: number) => setShown((prev) => new Set(prev).add(i));
  return (
    <div className="sm-board-table-wrap">
      <table className="sm-board-table">
        <thead><tr>{spec.headers.map((h, i) => <th key={i} scope="col"><MathText text={h} /></th>)}</tr></thead>
        <tbody>
          {spec.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => ci === hide && !shown.has(ri)
                ? <td key={ci}><button type="button" className="sm-board-table-reveal" onClick={() => reveal(ri)}>{"Recall, then reveal"}</button></td>
                : <td key={ci}><MathText text={c} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A source excerpt with its highlighted phrases and the notes beside them (close reading). */
function SourceBlock({ spec, en }: { spec: SourceSpec; en: boolean }) {
  const runs = sourceRuns(spec);
  return (
    <figure className="sm-board-source">
      <blockquote className="sm-board-source-text">
        {runs.map((r, i) => r.mark == null ? <span key={i}>{r.text}</span> : <mark key={i} className="sm-board-source-mark"><sup>{r.mark + 1}</sup>{r.text}</mark>)}
      </blockquote>
      {spec.attribution ? <figcaption className="sm-board-source-by">— {spec.attribution}</figcaption> : null}
      {spec.highlights.some((h) => h.note) ? (
        <ol className="sm-board-source-notes" aria-label={"Notes on the source"}>
          {spec.highlights.map((h, i) => h.note ? <li key={i} value={i + 1}><em>{h.phrase}</em> — <MathText text={h.note} /></li> : null)}
        </ol>
      ) : null}
    </figure>
  );
}

/** One worksheet per problem: the flow splits into sections at every topic header (kind focus) and every new practice
 *  problem (unless a header was written just before it). Only the CURRENT section is open; earlier ones fold into a
 *  one-line row the student can tap open again — nothing is ever deleted, but the board stops reading as one long
 *  pile of three different problems (reported live: "the board is cluttered"). Returns the index where each section
 *  starts. Pure; exported for tests. */
export function boardSectionStarts(items: Array<{ entry?: Pick<BoardEntry, "kind">; problem?: unknown }>): number[] {
  const starts: number[] = [];
  items.forEach((it, i) => {
    if (i === 0) { starts.push(0); return; }
    const prev = items[i - 1];
    if (it.entry?.kind === "focus") starts.push(i);
    else if (it.problem && prev.entry?.kind !== "focus") starts.push(i);
  });
  return starts;
}

/** The section's one-line title for its folded row: its header, its problem, or its first line. Pure; exported for tests. */
export function boardSectionTitle(items: Array<{ entry?: Pick<BoardEntry, "kind" | "text">; problem?: { question: string } }>): string {
  const head = items.find((it) => it.entry?.kind === "focus")?.entry?.text || items.find((it) => it.problem)?.problem?.question || items.find((it) => it.entry?.text)?.entry?.text || "";
  const t = head.replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 88).replace(/\s+\S*$/, "")}…` : t;
}

/** "Key ideas" holds only what's worth revising from: definitions, strategies, and formulas Otto wrote WITH a why —
 *  never a fragment cut out of a sentence (") =(M+ m)a right there"), a line with a blank or a question in it, or two
 *  near-identical strategies. Pure; exported for tests. */
export function keyIdeaEntries<T extends Pick<BoardEntry, "id" | "kind" | "text" | "why">>(entries: T[], exclude: Set<string> = new Set()): T[] {
  const balanced = (t: string) => [...t].reduce((d, ch) => (d < 0 ? d : d + (ch === "(" ? 1 : ch === ")" ? -1 : 0)), 0) === 0;
  const words = (t: string) => new Set(String(t).toLowerCase().replace(/\$[^$]*\$/g, " ").split(/[^\p{L}\d]+/u).filter((w) => w.length >= 4));
  const near = (a: string, b: string) => { const A = words(a), B = words(b); if (!A.size || !B.size) return false; const both = [...A].filter((w) => B.has(w)).length; return both / Math.min(A.size, B.size) >= 0.6; };
  const out: T[] = [];
  for (const e of entries) {
    if (exclude.has(e.id) || out.some((x) => x.id === e.id)) continue;
    const t = String(e.text || "").trim();
    if (!t || /\?/.test(t) || !balanced(t) || /^[)\]}=+\-−*/]/.test(t)) continue;
    const ok = e.kind === "definition" || e.kind === "strategy" || (e.kind === "formula" && !!String(e.why || "").trim() && /=/.test(t));
    if (!ok) continue;
    const mathKey = (z: string) => repairLatex(String(z)).replace(/\\(?:times|cdot)|[×·]|[\s${}\\]/g, "").toLowerCase();
    const dupe = out.findIndex((x) => near(x.text, t) || (mathKey(x.text).length >= 5 && mathKey(x.text) === mathKey(t)));
    if (dupe >= 0) { out[dupe] = e; continue; } // the newer wording of the same idea wins
    out.push(e);
  }
  return out.slice(-5);
}

export function BoardArtifact({ task, onUndo, writing, onProblemResult, onWidgetResult, sheetSignal, onGapCheck, onCheckProblem }: BoardArtifactProps) {
  const L = useLang();
  const endRef = useRef<HTMLDivElement>(null);
  const entries = (task.board || []).filter((e) => !e.archived);
  const problems = task.problems || [];
  const [showHint, setShowHint] = useState<{ [key: string]: boolean }>({});
  const [problemState, setProblemState] = useState<{ [key: string]: ProblemState }>({});
  // What the server told them about sealed exercises (status, and — only once right — the correct option and the explanation).
  const [serverInfo, setServerInfo] = useState<{ [key: string]: ServerGrade }>({});
  const isSealed = (p: TaskProblem) => !!onCheckProblem && !!p.keyToken && p.answer == null && p.correct == null;

  // Content-level dedupe on RENDER (by id): sync merges (tasks.ts's unionStudyArtifacts) and a
  // double-responded turn can hand back an array containing the same entry/problem twice. Entries drop
  // kind:"focus" (pinned above as the board's header strip) and any legacy kind:"problem" rows (problems
  // render as flow items from task.problems — never twice). Every problem surface reads the DEDUPED list.
  // ALSO dedupes by normalized question text — defense-in-depth for a board saved before server/claude.ts's
  // own CREATE_PROBLEM dedupe (isDuplicateProblem) existed: reproduced live, the exact same question
  // appeared twice, once unanswered and once already answered, because the model called CREATE_PROBLEM
  // again without knowing an earlier, identical call had already landed. The server fix stops a NEW
  // duplicate from being created; this stops an already-duplicated board from rendering one. Prefers
  // whichever duplicate the student actually has state recorded against (answered/picked/hinted) over a
  // bare first-occurrence pick — dropping the ANSWERED copy in favor of an untouched one would silently
  // show their already-correct answer as a fresh, unanswered question.
  const normQ = (s: string) => s.toLowerCase().replace(/```[a-z]*|[`*]{1,3}|^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
  const hasState = (id: string) => {
    const st = problemState[id];
    return !!st && (st.picked !== null || st.submitted || !!st.textAnswer || !!st.wrong?.length) || !!showHint[id];
  };
  const dedupedProblems = problems
    .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i)
    .filter((p, i, arr) => {
      const dupes = arr.filter(x => normQ(x.question) === normQ(p.question));
      if (dupes.length < 2) return true;
      const withState = dupes.find(x => hasState(x.id));
      return (withState || dupes[0]).id === p.id;
    });
  // KEY IDEAS — the definitions, rules, strategies and the summary, gathered into one compact strip at the top so the
  // board doubles as the student's revision sheet (spec §10.4 knowledge panel). Rendered as a COPY: each entry also
  // keeps its place in the flow, so line numbers, undo and pointers are untouched.
  // Only once the board is long enough to scroll, and never repeating what is already in the first few lines
  // (reported: the definition and the laws appeared twice in a row at the top).
  const topIds = new Set(entries.filter((e) => e.kind !== "focus" && e.kind !== "annotation").slice(0, 4).map((e) => e.id));
  const boardIsLong = entries.length + (task.problems?.length || 0) >= 7;
  const keyIdeas = boardIsLong ? keyIdeaEntries(entries, topIds) : [];
  const latestSummary = boardIsLong ? [...entries].reverse().find((e) => e.kind === "summary" && e.owner !== "student" && !topIds.has(e.id)) : undefined;
  const [ideasOpen, setIdeasOpen] = useState<boolean>(() => { try { return localStorage.getItem("otto.board.ideasOpen") !== "0"; } catch { return true; } });
  const toggleIdeas = () => setIdeasOpen((o) => { try { localStorage.setItem("otto.board.ideasOpen", o ? "0" : "1"); } catch { /* storage blocked: still toggles */ } return !o; });
  // A heading that only repeats a topic header ("Math HL Test-2 Prep: Exponents & Logarithms" under "Test-2 prep:
  // Exponents & Logarithms") is shown once: the repeat's title is hidden, the content stays.
  const focusTexts = entries.filter((e) => e.kind === "focus").map((e) => e.text);
  const repeatsHeading = (text: string, except?: string) => focusTexts.some((f) => f !== except && nearSameHeading(f, text));
  const flowEntries = entries
    .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
    // Topic headers stay in the flow where they were written, each starting a section (the session bar shows the
    // current one); a header that repeats the one just before it is shown once.
    .filter((e, i, arr) => e.kind !== "focus" || !arr.slice(0, i).reverse().find((x) => x.kind === "focus" && nearSameHeading(x.text, e.text)))
    .filter(e => (e.kind as string) !== "problem" && e.kind !== "annotation");

  // Otto's mark-ups (ANNOTATE_BOARD) sit under the line they point at, in that line's place — not in the flow.
  const notesFor = useMemo(() => {
    const m = new Map<string, BoardEntry[]>();
    for (const a of entries) if (a.kind === "annotation" && a.targetId) m.set(a.targetId, [...(m.get(a.targetId) || []), a]);
    return m;
  }, [entries]);

  // The margin line numbers — the SAME numbering the tutor reads (#n), so "look at line 4" is findable.
  const lineNo = useMemo(() => boardLineNumbers(entries), [entries]);

  // THE FLOW: entries (by their `at`) and problems (by `createdAt`) merged and sorted by timestamp —
  // the board reads top-to-bottom in the order the session actually happened. A missing/unparseable
  // timestamp sorts to the end (defensive; both writers always stamp).
  const flowItems = useMemo(() => {
    const items: Array<{ key: string; at: number; entry?: BoardEntry; problem?: TaskProblem }> = [];
    for (const e of flowEntries) items.push({ key: e.id, at: Date.parse(e.at || "") || Number.MAX_SAFE_INTEGER, entry: e });
    for (const p of dedupedProblems) items.push({ key: p.id, at: Date.parse(p.createdAt || "") || Number.MAX_SAFE_INTEGER, problem: p });
    items.sort((a, b) => a.at - b.at);
    return items;
    // Keyed on the arrays themselves, not their lengths: a gap marked right, or a cleared board with the same count,
    // must re-render (it used to keep showing the stale lines).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, problems, problemState, showHint]);

  const sectionStarts = useMemo(() => boardSectionStarts(flowItems), [flowItems]);
  const currentSection = sectionStarts.length ? sectionStarts[sectionStarts.length - 1] : 0;
  const sectionOf = (idx: number) => { let s = 0; for (const st of sectionStarts) if (st <= idx) s = st; return s; };
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set());
  const toggleSection = (key: string) => setOpenSections((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // Sheets: blank room kept for a drawing the student made BELOW the board, so Otto's next writes come after it.
  const [sheets, setSheets] = useState<{ id: number; afterKey: string | null; height: number }[]>([]);
  const lastSheetN = useRef(0);
  useEffect(() => {
    if (!sheetSignal || sheetSignal.n === lastSheetN.current || sheetSignal.height <= 0) return;
    lastSheetN.current = sheetSignal.n;
    const afterKey = flowItems.length ? flowItems[flowItems.length - 1].key : null;
    setSheets((prev) => [...prev, { id: sheetSignal.n, afterKey, height: Math.min(sheetSignal.height, 240) }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetSignal?.n]);

  // Default position: all the way down to the END of the board (the newest line) — the blank page for drawing is one
  // more page below that, reached by scrolling, never the place the board opens on.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries.length, problems.length, sheets.length]);
  // OPENING a board (a resumed session, a past one) lands on the bottom at once — no visible scroll from the top. Math and
  // diagrams finish laying out a moment later and push the end down, so re-pin a few times while it settles.
  useEffect(() => {
    const jump = () => endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    jump();
    const timers = [80, 250, 700].map((ms) => window.setTimeout(jump, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  // "Ink reveal" — an entry that just arrived writes itself onto the page (clip-path wipe, duration scaled
  // to how much text there is) instead of popping in fully formed, the "watching it actually get written"
  // feel Aristotle's board is built around. Seeded with every id already on the board at FIRST render, so
  // reopening/resuming a session never replays the reveal on old content — only entries that arrive during
  // this mount ever get it. A later rerender (e.g. answering a problem) doesn't replay it either: the DOM
  // node isn't remounted, so a CSS mount-animation only ever plays once regardless of the class staying put.
  const seenKeysRef = useRef<Set<string> | null>(null);
  if (seenKeysRef.current === null) {
    const initial = new Set<string>();
    for (const i of flowItems) initial.add(i.key);
    seenKeysRef.current = initial;
  }
  const isFreshlyWritten = (key: string) => !seenKeysRef.current!.has(key);
  useEffect(() => {
    for (const i of flowItems) seenKeysRef.current!.add(i.key);
  }, [flowItems]);
  const revealDuration = (text: string): number => Math.min(1.6, Math.max(0.5, text.length / 90));

  // A wrong pick is recorded (struck out) but never "answers" the problem — only the correct one does.
  const attemptsRef = useRef<Record<string, number>>({});
  const lastGivenRef = useRef<Record<string, string>>({});
  const reportResult = (problem: TaskProblem, given: string, status: GradeStatus, reveal?: { correct?: number; why?: string }) => {
    const attempt = (attemptsRef.current[problem.id] = (attemptsRef.current[problem.id] || 0) + 1);
    onProblemResult?.({ problem, given, correct: status === "correct", attempt, ...(reveal ? { reveal } : {}), ...(status === "system_error" ? { systemError: true } : {}), ...(status === "partially_correct" ? { partial: true } : {}) });
  };
  const setProblemPicked = (problem: TaskProblem, picked: number) => {
    if (isSealed(problem)) {
      void (async () => {
        let g: ServerGrade;
        try { g = await onCheckProblem!(problem, String(picked)); } catch { return; } // could not reach the server: nothing is marked, they can pick again
        reportResult(problem, problem.options?.[picked] ?? String(picked), g.status, g.status === "correct" ? { correct: g.correct, why: g.why } : undefined);
        setServerInfo((prev) => ({ ...prev, [problem.id]: g }));
        setProblemState((prev) => {
          const cur = prev[problem.id] || { picked: null, textAnswer: "", submitted: false };
          return g.status === "correct" ? { ...prev, [problem.id]: { ...cur, picked, submitted: false } } : { ...prev, [problem.id]: { ...cur, wrong: [...(cur.wrong || []).filter((w) => w !== picked), picked] } };
        });
      })();
      return;
    }
    reportResult(problem, problem.options?.[picked] ?? String(picked), gradeExerciseAnswer(problem, String(picked)).status);
    setProblemState(prev => {
      const cur = prev[problem.id] || { picked: null, textAnswer: "", submitted: false };
      return picked === problem.correct
        ? { ...prev, [problem.id]: { ...cur, picked, submitted: false } }
        : { ...prev, [problem.id]: { ...cur, wrong: [...(cur.wrong || []).filter(w => w !== picked), picked] } };
    });
  };

  const setProblemTextAnswer = (problemId: string, textAnswer: string) => {
    setProblemState(prev => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, textAnswer, submitted: false } }));
  };

  const submitProblem = (problemId: string) => {
    const pr = problems.find((p) => p.id === problemId);
    if (pr && isSealed(pr)) {
      const given = (problemState[problemId]?.textAnswer || "").trim();
      if (!given) return;
      void (async () => {
        let g: ServerGrade;
        try { g = await onCheckProblem!(pr, given); } catch { return; }
        // The same answer checked twice in a row is one attempt, not two.
        if (lastGivenRef.current[problemId] !== given) { lastGivenRef.current[problemId] = given; reportResult(pr, given, g.status, g.status === "correct" ? { why: g.why } : undefined); }
        setServerInfo((prev) => ({ ...prev, [problemId]: g }));
        setProblemState((prev) => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, submitted: true } }));
      })();
      return;
    }
    // The same answer checked twice in a row is one attempt, not two (reported: identical "[Exercise] … wrong" spam to Otto).
    if (pr && pr.answer) { const given = (problemState[problemId]?.textAnswer || "").trim(); if (given && lastGivenRef.current[problemId] !== given) { lastGivenRef.current[problemId] = given; reportResult(pr, given, gradeExerciseAnswer(pr, given, { percent: problemIsPercent(pr) }).status); } }
    setProblemState(prev => ({ ...prev, [problemId]: { ...prev[problemId] || { picked: null, textAnswer: "", submitted: false }, submitted: true } }));
  };

  const getProblemState = (problemId: string) => problemState[problemId] || { picked: null, textAnswer: "", submitted: false };

  // A practice problem is NOT pinned — it renders in the flow in its own chronological place, like every
  // other entry. An earlier version pinned the current unanswered problem in its own card at the top of
  // the board; reported live as wrong — the board is a session document read top to bottom, and a problem
  // jumping out of its place in that document to sit above even the day's focus line broke that reading
  // order for no real benefit. Reverted.

  // Free-response check: the same lenient matcher as the journal's practice problem (shared/types.ts) —
  // "5pi/6" = "5π/6", "7/2" = "3.5", "84" = "84 m" — wrapped in the shared grader (spec §19), which grades
  // against the independently computed value and reports a stored key that disagrees with it as a SYSTEM
  // ERROR (shown as "Otto will check it", never as wrong). A plain string compare here marked those wrong.
  const freeResponseStatus = (problemId: string): GradeStatus | null => {
    const problem = problems.find(p => p.id === problemId);
    const st = getProblemState(problemId);
    if (problem && isSealed(problem)) return st.submitted ? (serverInfo[problemId]?.status ?? null) : null;
    if (!problem || !problem.answer || !st.submitted) return null;
    return gradeExerciseAnswer(problem, st.textAnswer, { percent: problemIsPercent(problem) }).status;
  };
  const checkFreeResponse = (problemId: string): boolean => {
    const problem = problems.find(p => p.id === problemId);
    if (problem && isSealed(problem)) return getProblemState(problemId).submitted && serverInfo[problemId]?.status === "correct";
    if (!problem || !problem.answer) return false;
    return gradeExerciseAnswer(problem, getProblemState(problemId).textAnswer, { percent: problemIsPercent(problem) }).status === "correct";
  };

  const hint = (
    <FirstTimeHint
      id="board"
      title={"Otto's board"}
      body={"Otto builds a session document here, entry by entry: today's focus, key definitions and formulas, your own insights, a summary of your reasoning — and problems to solve. Always accessible, no need to reopen it each time."}
    />
  );

  const hasContent = entries.length > 0 || problems.length > 0;

  if (!hasContent) {
    return (
      <div className="sm-board-body">
        {hint}
        <div className="sm-board-header">
          <span className="sm-board-header-date">
            {new Date().toLocaleDateString("en" === "en" ? "en-US" : "fr-FR", { weekday: "long", day: "numeric", month: "long" })}
          </span>
          {task.sourceSubject ? <span className="sm-board-header-subject">{task.sourceSubject}</span> : null}
        </div>
        <div className="sm-board-empty">
          {/* The prototype's board empty state: two big serif lines with a quiet promise under them —
              the page reads as an invitation, not as an error message about missing content. */}
          <p className="sm-board-empty-line">{"Let's take it apart together."}</p>
          <p className="sm-board-empty-line">{"What's beating you right now?"}</p>
          <p className="sm-board-empty-sub">{"I won't give you the answer — you find it, I push. One idea at a time."}</p>
        </div>
        {writing ? (
          <div className="sm-board-drafting" role="status" aria-live="polite">
            <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {"en" === "en" ? "Otto is writing…" : "Otto écrit…"}
          </div>
        ) : null}
      </div>
    );
  }

  const en = "en" === "en";

  const renderItem = (item: (typeof flowItems)[number], idx: number) => {
        const node = item.problem ? (
          <ProblemBlock
            key={item.key}
            fresh={isFreshlyWritten(item.key)}
            problem={item.problem}
            sectionNumber={idx + 1}
            state={getProblemState(item.problem.id)}
            hintShown={!!showHint[item.problem.id]}
            isCorrect={checkFreeResponse(item.problem.id)}
            systemError={freeResponseStatus(item.problem.id) === "system_error"}
            info={serverInfo[item.problem.id]}
            onShowHint={() => setShowHint(prev => ({ ...prev, [item.problem!.id]: true }))}
            onPick={(picked) => setProblemPicked(item.problem!, picked)}
            onTextAnswer={(text) => setProblemTextAnswer(item.problem!.id, text)}
            onSubmit={() => submitProblem(item.problem!.id)}
            en={en}
          />
        ) : (() => {
          const e = item.entry!;
          const fresh = isFreshlyWritten(item.key);
          const isPastGap = idx < flowItems.length - 1 && e.kind === "gap";
          return (
            <div
              key={item.key}
              className={`sm-board-entry sm-board-entry-${e.kind || "note"}${e.owner === "student" ? " sm-board-entry-student" : ""}${e.status === "incorrect" && e.kind !== "gap" ? " sm-board-entry-incorrect" : ""} sm-board-writein${fresh ? " sm-board-reveal" : ""}${isPastGap || (e.kind === "gap" && e.status === "correct") ? " sm-board-gap-past" : ""}${e.kind === "gap" && e.status !== "correct" && flowItems.slice(idx + 1).some((it) => it.entry?.kind === "gap") ? " sm-board-gap-skipped" : ""}`}
              style={fresh ? { animationDuration: `.35s, ${revealDuration(e.text)}s`, ...(e.cue ? { animationDelay: `${Math.min(e.cue, 6) * 0.9}s` } : {}) } : undefined}
            >
              {lineNo.get(e.id) ? <span className="sm-board-lineno" aria-label={`line ${lineNo.get(e.id)}`}>{lineNo.get(e.id)}</span> : null}
              <div className="sm-board-entry-main">
              {/* No kind-label chip here on purpose (removed: "Formule"/"Définition"/"Insight"/…) — the board
                  reads as ONE continuous document the tutor is working on, not a form with labeled fields.
                  The underlying `kind` still drives real formatting differences below (a diagram is a figure,
                  a summary is a reasoning trace) and a quiet style hook (sm-board-entry-{kind}), just never a
                  visible tag naming what category an entry is. */}
              {e.kind === "diagram" && e.diagram?.length ? (
                e.diagram.every((op) => op.op === "equation") ? (
                  // Equation-only diagram (no real spatial shapes) — reported live as a huge near-empty box:
                  // the SVG below is always forced to the full 800x600 coordinate space's aspect ratio via
                  // CSS regardless of content, so one small equation on a wide board pane rendered as a tall
                  // mostly-blank card. Real 2D content (a triangle, axes, a free-body diagram) still needs
                  // that fixed canvas to keep its geometry proportional; a bare equation doesn't — it's just
                  // typeset text that should size to its own content and wrap like the rest of the board.
                  <>
                    <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                    <div className="sm-board-eq-list">
                      {e.diagram.map((op, i) => op.op === "equation" ? <div key={i} className="sm-board-line">{latexToPlain(op.latex)}</div> : null)}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                    <svg viewBox={opsViewBox(e.diagram)} className="sm-board-diagram" preserveAspectRatio="xMidYMid meet">
                      <defs>
                        <marker id="sm-diagram-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                          <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                        </marker>
                      </defs>                       {e.diagram.map((op, i) => <DiagramOpSVG key={i} op={op} partId={e.id} />)}
                    </svg>
                  </>
                )
              ) : e.kind === "summary" ? (
                <PlainSteps text={e.text} />
              ) : e.kind === "outline" && e.outline?.length ? (
                <>
                  {stripStrayMarkdown(e.text) && !repeatsHeading(e.text) ? <div className="sm-board-entry-text sm-board-outline-title">{stripStrayMarkdown(e.text)}</div> : null}
                  <div className="sm-board-outline">
                    {e.outline.map((section, i) => (
                      <div key={i} className="sm-board-outline-section">
                        <div className="sm-board-outline-heading">{stripStrayMarkdown(section.heading)}</div>
                        <ul className="sm-board-outline-bullets">
                          {section.bullets.map((b, j) => <li key={j}><MathText text={b} /></li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                </>
              ) : e.kind === "graph" && e.graph ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <GraphBlock spec={e.graph} />
                </>
              ) : e.kind === "svg" && e.svg ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  {/* sanitised again on render (defence in depth): stored entries can come back from the cloud/local cache */}
                  <div className="sm-svgfig" role="img" aria-label={latexToPlain(e.text)} dangerouslySetInnerHTML={{ __html: sanitizeSvg(e.svg) }} />
                </>
              ) : e.kind === "table" && e.table ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <BoardTable spec={e.table} en={en} />
                </>
              ) : e.kind === "source" && e.source ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <SourceBlock spec={e.source} en={en} />
                </>
              ) : e.kind === "flow" && e.flow ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <FlowDiagram spec={e.flow} />
                </>
              ) : e.kind === "widget" && e.widget ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <WidgetBlock id={e.id} caption={e.text} spec={e.widget} onResult={onWidgetResult} Text={MathText} />
                </>
              ) : e.kind === "interactive" && e.html ? (
                <>
                  <div className="sm-board-entry-text sm-board-diagram-caption"><MathText text={stripStrayMarkdown(e.text)} /></div>
                  <InteractiveFrame taskId={task.id} entryId={e.id} />
                </>
              ) : (
                <>
                  <div className={`sm-board-line${markClass(notesFor.get(e.id))}`}><MathText text={autoMathLine(stripStrayMarkdown((e.kind === "result" ? e.text.replace(/^\s*(?:established|établi|found|result|trouvé)\s*:\s*/i, "") : e.text).replace(/&nbsp;|&#160;/gi, " ")))} /></div>
                  {e.why ? <div className="sm-board-why"><MathText text={autoMathLine(stripStrayMarkdown(e.why))} /></div> : null}
                  {e.kind === "gap" && (e.expectedAnswer || e.keyToken) && e.status !== "correct" && !flowItems.slice(idx + 1).some((it) => it.entry?.kind === "gap") && onGapCheck ? <GapAnswer entry={e} onCheck={onGapCheck} en={en} /> : null}
                </>
              )}
              {(notesFor.get(e.id) || []).filter((a) => a.text).map((a) => (
                <div key={a.id} className={`sm-board-note sm-board-note-${a.tone || "focus"}`}><span aria-hidden>↳ </span><MathText text={a.text} /></div>
              ))}
              </div>
            </div>
          );
        })();
        return <Fragment key={item.key}><BlockBoundary>{node}</BlockBoundary>{sheets.filter((sh) => sh.afterKey === item.key).map((sh) => <div key={`sheet-${sh.id}`} className="sm-board-sheet" style={{ height: sh.height }} aria-hidden />)}</Fragment>;
  };

  return (
    <div className="sm-board-body">
      {hint}

      {/* THE WORKSHEET HEADER — date + subject above the pinned goal, like a lesson page's heading block:
          the board is a document you could print and keep, not a feed. The subject comes from the task's
          sourceSubject (stamped at session start); date is today (the board is per-session). */}
      <div className="sm-board-header">
        <span className="sm-board-header-date">
          {new Date().toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}
        </span>
        {task.sourceSubject ? <span className="sm-board-header-subject">{task.sourceSubject}</span> : null}
        {onUndo ? (
          <button type="button" className="sm-board-undo" onClick={onUndo} title={"Undo the last board change"}>
            ↶ {"Undo"}
          </button>
        ) : null}
      </div>


      {keyIdeas.length || latestSummary ? (
        <section className={`sm-board-ideas${ideasOpen ? "" : " is-collapsed"}`} aria-label={"Key ideas"}>
          <button type="button" className="sm-board-ideas-head" aria-expanded={ideasOpen} onClick={toggleIdeas}>
            <span>{"Key ideas"}</span>
            <span className="sm-board-ideas-count">{keyIdeas.length + (latestSummary ? 1 : 0)}</span>
            <span className="sm-chev sm-board-ideas-chev" aria-hidden="true" />
          </button>
          {ideasOpen ? (
            <ul className="sm-board-ideas-list">
              {keyIdeas.map((e) => (
                <li key={`idea-${e.id}`} className={`sm-board-idea sm-board-idea-${e.kind}`}>
                  {e.kind === "strategy" ? <span className="sm-board-idea-tag">{"Strategy"}</span> : null}
                  <MathText text={autoMathLine(stripStrayMarkdown(e.text))} />
                </li>
              ))}
              {latestSummary ? (
                <li className="sm-board-idea sm-board-idea-summary">
                  <span className="sm-board-idea-tag">{"Summary"}</span>
                  <MathText text={autoMathLine(stripStrayMarkdown(latestSummary.text))} />
                </li>
              ) : null}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* ONE FLOW — entries and problems interleaved by timestamp, in the order the session produced them.
          Every step stays visible: an earlier version collapsed everything but the last four behind a
          show/hide disclosure, but the board is a lesson document — hiding the working is the opposite of
          what a student needs when they scroll back to see how they got here. */}
      {sheets.filter((sh) => sh.afterKey === null).map((sh) => <div key={`sheet-${sh.id}`} className="sm-board-sheet" style={{ height: sh.height }} aria-hidden />)}
      {flowItems.map((item, idx) => {
        // Earlier worksheets fold away: the first item of a closed section becomes its one-line row, the rest hide.
        const sec = sectionOf(idx);
        const secKey = flowItems[sec]?.key || String(sec);
        const folded = sec !== currentSection && !openSections.has(secKey);
        if (sec !== currentSection && idx === sec) {
          const end = sectionStarts.find((st) => st > sec) ?? flowItems.length;
          const row = (
            <button type="button" className={`sm-board-section-row${folded ? "" : " is-open"}`} aria-expanded={!folded} onClick={() => toggleSection(secKey)}>
              <span className="sm-chev sm-board-section-chev" aria-hidden="true" />
              <span className="sm-board-section-title"><MathText text={autoMathLine(stripStrayMarkdown(boardSectionTitle(flowItems.slice(sec, end))))} /></span>
              <span className="sm-board-section-count">{end - sec}</span>
            </button>
          );
          if (folded) return <Fragment key={`sec-${item.key}`}>{row}</Fragment>;
          return <Fragment key={`sec-${item.key}`}>{row}{renderItem(item, idx)}</Fragment>;
        }
        if (folded) return null;
        return renderItem(item, idx);
      })}

      {/* The live drafting indicator — while the tutor's reply is being generated the document shows its
          writing hand ("Otto écrit…"), so new entries arrive as the continuation of a visible act of
          writing, not a swap of the page. Shown on the EMPTY board too (that's exactly when the session
          needs to feel alive, not blank). */}
      {writing ? (
        <div className="sm-board-drafting" role="status" aria-live="polite">
          <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          {"Otto is writing…"}
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
