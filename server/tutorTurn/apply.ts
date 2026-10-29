// BOARD OPS → BOARD ENTRIES. The verified turn's ops become the entries the board renders, through the same builders
// the figures always used (graphs, geometry, slopes and angle scenes drawn to scale; tables, sources, flows). Every
// entry carries its `cue` (the sentence it belongs to) so the board can change as Otto speaks. An op that can't be
// built is dropped and reported — the reply never claims it, because the model only ever describes what it asked for
// in the same turn and the dropped op is logged for the eval report.
import { randomUUID } from "node:crypto";
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
  /** What the student said this turn (typed, plus the repaired spoken reading) — the only source of "their" lines. */
  theirWords: string[];
  board: BoardEntry[];
  problems: TaskProblem[];
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

function sceneEntry(o: BoardOp): { entry: BoardEntry } | { error: string } {
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
    case "incline": return svgEntry(buildInclineScene({ angle: Number(spec.angle), forces: Array.isArray(spec.forces) ? (spec.forces as InclineForce[]) : undefined, motion: spec.motion, labels: spec.labels && typeof spec.labels === "object" ? spec.labels : undefined }), "The slope");
    case "trig": return svgEntry(buildTrigScene({ mode: spec.mode, observers: Array.isArray(spec.observers) ? spec.observers : [], separation: spec.separation, towerHeight: spec.towerHeight, unknownTop: typeof spec.unknownTop === "string" ? spec.unknownTop.slice(0, 3) : undefined, distance: spec.distance, baseName: spec.baseName, topName: spec.topName, units: spec.units }), "The situation");
    case "numberline": return svgEntry(buildNumberLine(spec), "Number line");
    case "balance": return svgEntry(buildBalance(spec), "The balance");
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

/** A line that is only a whole number of up to 4 digits (a year, a count), with no unit, sign, decimal or words. */
export function bareNumeral(text: string): boolean {
  return /^[\s$]*\d{1,4}[\s$.]*$/.test(String(text || ""));
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
        // The same heading again ("Logarithmic Equations" four times in one session) adds nothing.
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9àâçéèêëîïôûùüÿñæœ ]+/g, " ").replace(/\s+/g, " ").trim();
        if (all().slice(-14).some((e) => e.kind === "focus" && (norm(String(e.text || "")) === norm(text) || similarity(String(e.text || ""), text) >= 0.9))) { drop("that heading is already on the board"); break; }
        add({ id: randomUUID(), text, kind: "focus", owner: "otto", at: now() } as BoardEntry, o.cue);
        break;
      }
      case "step": {
        const kind = o.kind && o.kind !== "note" ? o.kind : "note";
        const raw = String(o.text || "");
        // THE BOARD NEVER SHOWS THE STUDENT'S OWN TEXT: a line the model marks as theirs is refused, and so is one that mostly repeats what they said
        // (a speech transcript, a typed answer). Otto writes its own clean, verified line instead (engine.ts builds it from the verified solution).
        if (transcribes(raw, c.theirWords)) { drop("echoes the student's words"); break; }
        const text = latexifyBoardLine(repairLatex(typesetPlainMath(raw)), kind);
        // A bare whole number or year ("1917", "5", "$12$") says nothing on a board: reported live as "given: 1917" and "result: 5"
        // (the tail of a spoken sentence). A decimal, a percentage or a value with its unit is a real result and stays.
        if (bareNumeral(text)) { drop("a bare number says nothing without its label"); break; }
        const owner = "otto"; // (no student ink, ever)
        if (isDuplicateBoardEntry(all(), { text, kind })) { drop("already on the board"); break; }
        const m = mathOf(text);
        if (m.length >= 6 && all().slice(-20).some((e) => e.kind !== "gap" && mathOf(String(e.text || "")).includes(m))) { drop("that equation is already on the board"); break; }
        // "dy/dx = -x/y" after a line that already ends "... = -x/y": same result, said twice.
        { const parts = m.split("="); if (parts.length === 2 && parts[0].length >= 3 && parts[1].length >= 2 && all().slice(-20).some((e) => { const em = mathOf(String(e.text || "")); return e.kind !== "gap" && em.startsWith(`${parts[0]}=`) && em.endsWith(`=${parts[1]}`); })) { drop("that result is already on the board"); break; } }
        if (all().slice(-20).some((e) => e.text && nearDuplicateLine(String(e.text), text))) { drop("near-duplicate line"); break; }
        const r = makeBoardEntry({ text, kind, owner, why: o.why });
        if ("error" in r) { drop(r.error); break; }
        add(r.entry, o.cue);
        break;
      }
      case "choice": {
        // A multiple-choice question (the tutor asked it out loud with its options): shown on the board as tappable answers. The right one is never marked.
        const q = latexifyBoardLine(repairLatex(typesetPlainMath(String(o.text || ""))), "note");
        const options = (o.options || []).map((x) => latexifyBoardLine(repairLatex(typesetPlainMath(String(x))), "note")).filter(Boolean);
        if (!q || options.length < 2) { drop("a choice needs a question and two options"); break; }
        if (all().some((e) => e.kind === "choice" && similarity(String(e.text || ""), q) > 0.8)) { drop("that question is already on the board"); break; }
        add({ id: randomUUID(), kind: "choice", text: q, options, owner: "otto", at: now() } as BoardEntry, o.cue);
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
        // "extend": draw ON a graph that is already on the board (a point, a dashed line, a shaded area, one more curve) — same entry, redrawn in place.
        const ext = o.scene === "graph" ? (o.spec as any)?.extend : undefined;
        if (ext) {
          const target = resolveBoardTarget(String(ext), c.board);
          const base = target?.kind === "graph" ? target : [...c.board].reverse().find((e) => e.kind === "graph");
          const g: any = (base as any)?.graph;
          if (!base || !g || (g.kind && g.kind !== "function")) { drop("no graph to draw on"); break; }
          const sp: any = o.spec || {};
          const merged = { maxFns: 6, caption: base.text, kind: "function", xmin: g.xmin, xmax: g.xmax, ymin: g.ymin, ymax: g.ymax, xLabel: g.xLabel, yLabel: g.yLabel, params: g.params, connect: g.connect,
            fns: [...(g.fns || []), ...(sp.fns || [])], points: [...(g.points || []), ...(sp.points || [])], regions: [...(g.regions || []), ...(sp.regions || [])], vlines: [...(g.vlines || []), ...(sp.vlines || [])] };
          const r2 = makeGraphEntry(merged);
          if ("error" in r2) { drop(r2.error); break; }
          if (JSON.stringify((r2.entry as any).graph) === JSON.stringify(g)) { drop("nothing new to draw on that graph"); break; }
          add({ ...r2.entry, id: base.id, at: (base as any).at || r2.entry.at } as BoardEntry, o.cue);
          break;
        }
        const r = sceneEntry(o);
        if ("error" in r) { drop(r.error); break; }
        if (r.entry.kind === "graph" && all().slice(-12).some((e) => e.kind === "graph" && JSON.stringify((e as any).graph) === JSON.stringify((r.entry as any).graph))) { drop("that graph is already on the board"); break; }
        add(r.entry, o.cue);
        break;
      }
    }
  }
  return out;
}
