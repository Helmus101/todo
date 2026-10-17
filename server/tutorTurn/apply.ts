// BOARD OPS → BOARD ENTRIES. The verified turn's ops become the entries the board renders, through the same builders
// the figures always used (graphs, geometry, slopes and angle scenes drawn to scale; tables, sources, flows). Every
// entry carries its `cue` (the sentence it belongs to) so the board can change as Otto speaks. An op that can't be
// built is dropped and reported — the reply never claims it, because the model only ever describes what it asked for
// in the same turn and the dropped op is logged for the eval report.
import { randomUUID } from "node:crypto";
import { tidyQuestion } from "./problemGen.ts";
import type { BoardEntry, TaskObjective, TaskProblem, TutorSolution } from "../../shared/types.ts";
import type { BoardOp } from "../../shared/tutorTurn.ts";
import { buildInclineScene, type InclineForce } from "../../shared/inclineScene.ts";
import { buildTrigScene } from "../../shared/trigScene.ts";
import { buildNumberLine, buildBalance } from "../../shared/simpleScenes.ts";
import { sanitizeSvg } from "../../shared/svgSafe.ts";
import {
  makeBoardEntry, makeGeometryEntry, makeGraphEntry, makeFlowEntry, makeTableEntry, makeSourceEntry, makeWidgetEntry, makeSvgEntry,
  makeProblem, makeObjectives, isDuplicateBoardEntry, isDuplicateProblem, resolveBoardTarget,
} from "../claude.ts";
import { latexifyBoardLine, repairLatex, similarity } from "../tutorAdapt.ts";
import { computedGapKey, solvedGapKey, typesetPlainMath, numbersAreTheirs, asksForSeveralValues, repeatsSolvedCalculation, nearDuplicateLine } from "../tutor.ts";

export interface ApplyContext {
  message: string;
  /** What the student said this turn (typed, plus the repaired spoken reading) — the only source of "their" lines. */
  theirWords: string[];
  board: BoardEntry[];
  problems: TaskProblem[];
  fr: boolean;
  solution?: TutorSolution;
}

export interface Applied {
  board: BoardEntry[];
  problems: TaskProblem[];
  objectives?: TaskObjective[];
  /** Ops that couldn't be built, with the reason — for logs and the eval report, never shown to the student. */
  dropped: string[];
}

const now = () => new Date().toISOString();
const mathOf = (x: string) => (String(x).match(/\$[^$]+\$/g) || []).join("").replace(/\$|\s|[{}]/g, "").toLowerCase();

function sceneEntry(o: BoardOp, fr: boolean): { entry: BoardEntry } | { error: string } {
  const spec: any = { ...(o.spec || {}), caption: String(o.text || (o.spec as any)?.caption || "").slice(0, 200) };
  const svgEntry = (built: { svg: string; facts: string } | { error: string }, fallback: string) => {
    if ("error" in built) return built;
    const svg = sanitizeSvg(built.svg);
    if (!svg) return { error: "couldn't build that figure" };
    return { entry: { id: randomUUID(), text: spec.caption || fallback, kind: "svg", svg, facts: built.facts, at: now() } as BoardEntry };
  };
  switch (o.scene) {
    case "graph": return makeGraphEntry(spec);
    case "geometry": return makeGeometryEntry(spec);
    case "flow": return makeFlowEntry(spec);
    case "table": return makeTableEntry(spec);
    case "source": return makeSourceEntry(spec);
    case "widget": return makeWidgetEntry(spec);
    case "svg": return makeSvgEntry(spec);
    case "incline": return svgEntry(buildInclineScene({ angle: Number(spec.angle), forces: Array.isArray(spec.forces) ? (spec.forces as InclineForce[]) : undefined, motion: spec.motion, labels: spec.labels && typeof spec.labels === "object" ? spec.labels : undefined }), fr ? "Le plan incliné" : "The slope");
    case "trig": return svgEntry(buildTrigScene({ mode: spec.mode, observers: Array.isArray(spec.observers) ? spec.observers : [], separation: spec.separation, towerHeight: spec.towerHeight, unknownTop: typeof spec.unknownTop === "string" ? spec.unknownTop.slice(0, 3) : undefined, distance: spec.distance, baseName: spec.baseName, topName: spec.topName, units: spec.units }), fr ? "La situation" : "The situation");
    case "numberline": return svgEntry(buildNumberLine(spec), fr ? "Droite numérique" : "Number line");
    case "balance": return svgEntry(buildBalance(spec), fr ? "La balance" : "The balance");
    default: return { error: `unknown scene "${o.scene ?? ""}"` };
  }
}

const plainWords = (s: string) => s.replace(/\$[^$]*\$/g, " ").toLowerCase().match(/[a-zà-ÿ']{2,}/g) || [];

/** A step that is mostly the student's own spoken words (a transcript), not maths. */
export function transcribes(text: string, theirWords: string[]): boolean {
  const w = plainWords(text);
  if (w.length < 5) return false;
  const said = new Set(theirWords.flatMap(plainWords));
  return w.filter((x) => said.has(x)).length / w.length >= 0.7;
}

/** The value inside a spoken answer, as a board line: the text unchanged when it is already short maths, "≈ 56%" for "about 56%",
 *  null when there is no number to keep. */
export function valueOfSpeech(text: string): string | null {
  const t = text.trim();
  if (!/\d|=/.test(t) && plainWords(t).length >= 3) return null;
  if (plainWords(t).length < 5 && !/^(?:search|speech)\b/i.test(t)) return t;
  const found = [...t.matchAll(/(?:(about|around|roughly|approximately|≈|~)\s*)?(-?\d+(?:[.,]\d+)?)\s*(%|[a-zA-Zµ°Ω]{1,3}(?:\/[a-zA-Z]{1,3})?\b)?/gi)];
  const last = found[found.length - 1];
  if (!last) return null;
  const unit = last[3] && (last[3] === "%" || !/^(?:is|it|so|and|of|to|at|in|on|or|me|my|be|as|the|yes|yeah|not|but|can|for)$/i.test(last[3])) ? last[3] : "";
  return `${last[1] ? "≈ " : ""}${last[2]}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
}

export function applyOps(ops: BoardOp[], c: ApplyContext): Applied {
  const out: Applied = { board: [], problems: [], dropped: [] };
  const all = () => [...c.board, ...out.board];
  const add = (e: BoardEntry, cue: number) => { out.board.push({ ...e, cue }); };
  for (const o of ops) {
    const drop = (why: string) => out.dropped.push(`${o.op}: ${why}`);
    switch (o.op) {
      case "topic": {
        const text = String(o.text || "").trim().slice(0, 140);
        if (!text) { drop("empty header"); break; }
        add({ id: randomUUID(), text, kind: "focus", owner: "otto", at: now() } as BoardEntry, o.cue);
        break;
      }
      case "step": {
        const kind = o.kind && o.kind !== "note" ? o.kind : "note";
        let raw = String(o.text || "");
        // Speech recognition output ("about 56% is what I would say right yeah I think it's about 56%") is not a board line: keep the value they gave.
        if (o.owner === "student" || transcribes(raw, c.theirWords)) {
          const core = valueOfSpeech(raw);
          if (core == null) { drop("spoken words, not maths"); break; }
          raw = core;
        }
        const text = latexifyBoardLine(repairLatex(typesetPlainMath(raw)), kind);
        // A line is THEIRS only when its numbers are ones they said this turn — Otto's own step never shows in their ink.
        const owner = o.owner === "student" && numbersAreTheirs(text, c.theirWords) ? "student" : "otto";
        if (isDuplicateBoardEntry(all(), { text, kind })) { drop("already on the board"); break; }
        const m = mathOf(text);
        if (m.length >= 6 && all().slice(-20).some((e) => e.kind !== "gap" && mathOf(String(e.text || "")).includes(m))) { drop("that equation is already on the board"); break; }
        if (all().slice(-20).some((e) => e.text && nearDuplicateLine(String(e.text), text))) { drop("near-duplicate line"); break; }
        const r = makeBoardEntry({ text, kind, owner, why: o.why });
        if ("error" in r) { drop(r.error); break; }
        add(r.entry, o.cue);
        break;
      }
      case "gap": {
        if (out.board.some((e) => e.kind === "gap")) { drop("one gap a turn"); break; }
        const text = latexifyBoardLine(repairLatex(typesetPlainMath(String(o.text || ""))), "gap");
        // The key is computed from the line itself when it's a closed calculation or a solvable equation — never guessed.
        const computed = computedGapKey(text) ?? solvedGapKey(text);
        const expected = computed != null ? String(computed) : String(o.expected || "").trim();
        if (!expected) { drop("a gap needs its expected answer"); break; }
        const r = makeBoardEntry({ text, kind: "gap", owner: "otto", expectedAnswer: expected, gapAction: o.action, why: o.why });
        if ("error" in r) { drop(r.error); break; }
        add(r.entry, o.cue);
        break;
      }
      case "mark": {
        const hit = resolveBoardTarget(String(o.target || ""), c.board);
        if (!hit?.id) { drop(`no line ${o.target ?? ""}`); break; }
        if (out.board.filter((e) => e.kind === "annotation").length >= 2) { drop("two marks a turn"); break; }
        // One note per line: a second note on the same line, or one saying the same thing as another, is clutter.
        const onLine = [...c.board, ...out.board].filter((e) => e.kind === "annotation" && e.targetId === hit.id);
        if (onLine.some((e) => (e.tone || "focus") === (o.tone || "focus")) || [...c.board, ...out.board].filter((e) => e.kind === "annotation").slice(-6).some((e) => e.text && o.note && similarity(String(e.text), String(o.note)) >= 0.5)) { drop("that line is already marked"); break; }
        // The part to circle must actually be in the line (else the whole line is marked).
        const plain = (x: string) => x.replace(/[\s$\\{}]/g, "").toLowerCase();
        const part = o.part && plain(String(hit.text || "")).includes(plain(o.part)) ? o.part : undefined;
        add({ id: randomUUID(), text: String(o.note || "").slice(0, 200), kind: "annotation", targetId: hit.id, tone: o.tone || "focus", markStyle: o.style || "circle", ...(part ? { markPart: part } : {}), owner: "otto", at: now() } as BoardEntry, o.cue);
        break;
      }
      case "draw": {
        if (out.board.some((e) => ["graph", "diagram", "svg", "flow", "table", "source", "widget"].includes(String(e.kind)))) { drop("one visual a turn"); break; }
        const r = sceneEntry(o, c.fr);
        if ("error" in r) { drop(r.error); break; }
        if (r.entry.kind === "graph" && all().slice(-12).some((e) => e.kind === "graph" && JSON.stringify((e as any).graph) === JSON.stringify((r.entry as any).graph))) { drop("that graph is already on the board"); break; }
        add(r.entry, o.cue);
        break;
      }
      case "problem": {
        const input = { question: o.question ? tidyQuestion(String(o.question)) : o.question, answer: o.answer, check: o.check, options: o.options, correct: o.correct, format: o.format, hint: o.hint, why: o.why, rubric: o.rubric };
        const open = [...c.problems, ...out.problems].filter((p) => !p.solved);
        if (open.length) { drop("an exercise is still open"); break; }
        if (isDuplicateProblem([...c.problems, ...out.problems], input)) { drop("duplicate exercise"); break; }
        if (asksForSeveralValues(String(o.question || "")) && !(o.options && o.options.length >= 2)) { drop("one answer box, several values asked"); break; }
        if (repeatsSolvedCalculation(c.problems, input, c.message)) { drop("third drill of the same kind"); break; }
        const r = makeProblem(input, true);
        if ("error" in r) { drop(r.error); break; }
        out.problems.push({ ...r.problem, cue: o.cue } as TaskProblem);
        break;
      }
      case "plan": {
        const r = makeObjectives({ objectives: (o.objectives || []).map((label) => ({ label })) });
        if ("error" in r) { drop(r.error); break; }
        out.objectives = r.objectives;
        break;
      }
    }
  }
  return out;
}
