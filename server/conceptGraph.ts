// THE KNOWLEDGE GRAPH — Otto needs to understand that knowledge is hierarchical (spec §4), because that is
// what turns "they're stuck on inclined planes" into "actually, they're stuck on resolving a force into
// components, two levels down" (spec §5). Without this, every step-backwards decision is a guess the model
// makes inside one prompt; with it, the application can compute the step-back target and hand the tutor a
// specific, justified place to go.
//
// Two kinds of node (spec §25/§24):
//
//   • SPINE  — a small hand-authored prerequisite tree for the subjects where the graph is load-bearing
//              (maths and physics: nearly every hard problem decomposes into a specific earlier skill).
//              Curated on purpose: a wrong edge here sends the student backwards for no reason, so the
//              spine stays small and only contains edges we're confident about.
//   • DISCOVERED — concepts pulled out of the student's own courses and uploaded documents (spec §24), which
//              is what makes the graph cover what this student is ACTUALLY being taught instead of a generic
//              curriculum. Discovered nodes carry no curated edges; they attach to the spine by matching a
//              spine label inside the document, which is what lets a teacher's worksheet inherit real
//              prerequisites.
//
// Pure and dependency-free (verified by tests, not by assertion).
import { conceptKey, type StudentModel, findConcept } from "./studentModel.ts";
import {
  GRAPH_DISCOVERED_CAP,
  PREREQ_MAX_DEPTH,
  WEAK_MASTERY,
  UNKNOWN_CONFIDENCE,
  type ConceptNode,
  type ConceptGraphShape,
} from "../shared/agentTypes.ts";

export type { ConceptNode };
export { GRAPH_DISCOVERED_CAP, PREREQ_MAX_DEPTH, WEAK_MASTERY, UNKNOWN_CONFIDENCE };

/** Alias — the graph type is the shared shape; nothing server-only is added to it. */
export type ConceptGraph = ConceptGraphShape;

/* ── the hand-authored spine ────────────────────────────────────────────────────────────────────────── */

type SpineSpec = [id: string, label: string, prereqs: string[], aliases?: string[]];

const MATH_SPINE: SpineSpec[] = [
  ["math.arithmetic", "Arithmetic with negative numbers and fractions", []],
  ["math.rearrange", "Rearranging a formula", ["math.arithmetic"]],
  ["math.linear", "Solving a linear equation", ["math.rearrange"]],
  ["math.expand", "Expanding brackets", ["math.arithmetic"]],
  ["math.factor", "Factorising an expression", ["math.expand"]],
  ["math.quadratic", "Solving a quadratic equation", ["math.factor", "math.linear"]],
  ["math.exponent", "Rules of indices/exponents", ["math.arithmetic"]],
  ["math.surd", "Surds and roots", ["math.exponent"]],
  ["math.fraction-algebra", "Algebraic fractions", ["math.factor"]],
  ["math.function", "Function notation and substitution", ["math.linear"]],
  ["math.composite", "Composite and inverse functions", ["math.function"]],
  ["math.graph-line", "Gradient and equation of a straight line", ["math.linear"]],
  ["math.graph-transform", "Graph transformations", ["math.function", "math.graph-line"]],
  ["geom.right-triangle", "Right-triangle geometry (sides and angles)", []],
  ["geom.pythagoras", "Pythagoras' theorem", ["geom.right-triangle"]],
  ["trig.ratio", "Trigonometric ratios (sin, cos, tan)", ["geom.right-triangle", "geom.pythagoras"]],
  ["trig.identity", "Trigonometric identities", ["trig.ratio"]],
  ["trig.equation", "Solving a trigonometric equation", ["trig.identity", "math.quadratic"]],
  ["trig.radian", "Radians and arc/sector measure", ["trig.ratio"]],
  ["vector.operation", "Adding and scaling vectors", ["math.rearrange"]],
  ["vector.component", "Resolving a vector into components", ["trig.ratio", "vector.operation"]],
  ["vector.scalar", "Scalar (dot) product", ["vector.component"]],
  ["calc.derivative", "Differentiating a function", ["math.expand", "math.exponent"]],
  ["calc.chain", "Chain rule", ["calc.derivative"]],
  ["calc.integral", "Integrating a function", ["calc.derivative", "math.exponent"]],
  ["calc.area", "Area under a curve", ["calc.integral"]],
  ["prob.basic", "Basic probability", ["math.fraction-algebra"]],
  ["stats.mean", "Mean, median and spread", ["math.arithmetic"]],
];

const PHYSICS_SPINE: SpineSpec[] = [
  ["phys.units", "Units and significant figures", []],
  ["phys.vector-quantity", "Scalar vs vector quantities", ["phys.units"]],
  ["phys.kinematics", "Kinematics / SUVAT equations", ["math.rearrange", "phys.units"], ["suvat"]],
  ["phys.motion-graph", "Reading a motion graph", ["phys.kinematics"]],
  ["phys.force", "Identifying the forces on an object", ["phys.vector-quantity"]],
  ["phys.weight", "Weight and mass", ["phys.force"]],
  ["phys.normal", "Normal (contact) force", ["phys.force"]],
  ["phys.newton1", "Newton's first law", ["phys.force"], ["inertia"]],
  ["phys.netforce", "Net force and free-body diagrams", ["phys.newton1", "vector.component"], ["free-body", "fbd"]],
  ["phys.newton2", "Newton's second law (F = ma)", ["phys.netforce"], ["f=ma", "f = ma"]],
  ["phys.newton3", "Newton's third law", ["phys.newton2"]],
  ["phys.friction", "Friction", ["phys.normal"]],
  ["phys.tension", "Tension and connected bodies", ["phys.newton2", "phys.normal"]],
  ["phys.incline", "Motion on an inclined plane", ["phys.netforce", "phys.friction", "vector.component"], ["inclined plane", "slope", "ramp"]],
  ["phys.work", "Work done by a force", ["phys.newton2"]],
  ["phys.energy-kinetic", "Kinetic energy", ["phys.work"]],
  ["phys.energy-potential", "Gravitational potential energy", ["phys.weight", "phys.work"]],
  ["phys.energy-conservation", "Conservation of energy", ["phys.energy-kinetic", "phys.energy-potential"]],
  ["phys.power", "Power", ["phys.work"]],
  ["phys.momentum", "Momentum", ["phys.newton2"]],
  ["phys.momentum-conservation", "Conservation of momentum", ["phys.momentum"]],
  ["phys.projectile", "Projectile motion", ["phys.kinematics", "vector.component", "phys.newton2"]],
  ["phys.circular", "Circular motion", ["phys.newton2", "vector.component"]],
];

const ECON_SPINE: SpineSpec[] = [
  ["econ.demand-supply", "Demand and supply", []],
  ["econ.elasticity", "Elasticity", ["econ.demand-supply"]],
  ["econ.surplus", "Consumer and producer surplus", ["econ.demand-supply"]],
  ["econ.externality", "Externalities", ["econ.surplus"], ["negative externality", "positive externality"]],
  ["econ.market-failure", "Market failure", ["econ.externality"], ["market failure"]],
  ["econ.tax", "Indirect taxes and subsidies", ["econ.demand-supply", "econ.market-failure"], ["pigouvian"]],
  ["econ.regulation", "Regulation and alternative interventions", ["econ.market-failure"]],
];

const SUBJECT_OF = (id: string): string => (id.startsWith("phys.") ? "Physics" : id.startsWith("math.") || id.startsWith("geom.") || id.startsWith("trig.") || id.startsWith("vector.") || id.startsWith("calc.") || id.startsWith("prob.") || id.startsWith("stats.") ? "Math" : id.startsWith("econ.") ? "Economics" : "General");

function buildSpine(): Record<string, ConceptNode> {
  const nodes: Record<string, ConceptNode> = {};
  for (const [id, label, prereqs, aliases] of [...MATH_SPINE, ...PHYSICS_SPINE, ...ECON_SPINE]) {
    nodes[id] = { id, label, subject: SUBJECT_OF(id), prereqs: prereqs.filter((p) => true), kind: "spine", ...(aliases?.length ? { aliases } : {}) };
  }
  return nodes;
}

/** The immutable seed. Exported as a function so callers can't mutate the shared graph. */
export function seedGraph(): ConceptGraph {
  return { nodes: buildSpine(), updatedAt: new Date(0).toISOString() };
}

/** A graph for a profile that has never had one — spine only. */
export function emptyConceptGraph(): ConceptGraph {
  return seedGraph();
}

/* ── queries ────────────────────────────────────────────────────────────────────────────────────────── */

/** Every ancestor of `id`, nearest-left-to-right at each depth, bounded by PREREQ_MAX_DEPTH and by a visited
 *  set (a malformed/discovered cycle can't hang the walk). */
export function prereqChain(graph: ConceptGraph, id: string): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>([id]);
  let frontier = [...(graph.nodes[id]?.prereqs || [])];
  for (let depth = 1; depth <= PREREQ_MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      if (seen.has(p) || !graph.nodes[p]) continue;
      seen.add(p);
      out.push({ id: p, depth });
      next.push(...(graph.nodes[p].prereqs || []));
    }
    frontier = next;
  }
  return out;
}

export interface StepBack {
  id: string;
  label: string;
  subject: string;
  depth: number;
  mastery: number | null;
  confidence: number;
  /** true when the prerequisite is measurably weak; false when it's merely unestablished (no evidence). */
  weak: boolean;
  /** A ready-to-use, honest reason for the tutor — never a verdict on the student. */
  reason: string;
}

/** The single most useful place to step back to, or null when nothing below this concept is in doubt.
 *
 *  Priority is DEPTH-MAJOR and weakness-minor: given two weak prerequisites, the DEEPER one is the actual
 *  root cause (that's the spec's whole example — the student isn't stuck on inclines OR on resolving forces
 *  as such, they're stuck on the trigonometry underneath). A measurably weak prerequisite outranks a merely
 *  unestablished one at the same depth, because we have evidence for the former and only a suspicion for
 *  the latter. */
export function weakestPrereq(graph: ConceptGraph, model: StudentModel | undefined, conceptId: string, opts: { now?: Date } = {}): StepBack | null {
  const _now = opts.now || new Date();
  const chain = prereqChain(graph, conceptId);
  if (!chain.length) return null;
  const scored = chain.map((c) => {
    // Look the record up by the node's own id AND by its label's key — a record may have been created from a
    // document that named the concept slightly differently, and both are legitimate ways to find it.
    const rec = findConcept(model, c.id) || findConcept(model, graph.nodes[c.id].label);
    const mastery = rec ? rec.mastery : null;
    const confidence = rec ? rec.confidence : 0;
    const weak = mastery !== null && confidence >= UNKNOWN_CONFIDENCE && mastery < WEAK_MASTERY;
    const unknown = confidence < UNKNOWN_CONFIDENCE;
    return { ...c, node: graph.nodes[c.id], mastery, confidence, weak, unknown };
  });
  const candidates = scored.filter((s) => s.weak || s.unknown);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.depth - a.depth) || (Number(b.weak) - Number(a.weak)) || ((a.mastery ?? 0.5) - (b.mastery ?? 0.5)));
  const pick = candidates[0];
  const reason = pick.weak
    ? `their mastery of "${pick.node.label}" looks genuinely shaky (${Math.round((pick.mastery ?? 0) * 100)}%) and it sits under what they're asking about`
    : `there's no evidence yet that "${pick.node.label}" is solid, and it sits under what they're asking about`;
  return { id: pick.id, label: pick.node.label, subject: pick.node.subject, depth: pick.depth, mastery: pick.mastery, confidence: pick.confidence, weak: pick.weak, reason };
}

/** Concepts from the spine that the given text actually mentions — the bridge that lets a teacher's
 *  worksheet inherit real prerequisites instead of floating free (spec §24). Matches the label and any
 *  alias, word-boundary-anchored, against a lower-cased copy with accents folded. */
export function matchSpine(graph: ConceptGraph, text: string, opts: { subject?: string; limit?: number } = {}): ConceptNode[] {
  const hay = ` ${conceptKey(text)} `;
  if (hay.trim().length < 2) return [];
  const out: ConceptNode[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.kind !== "spine") continue;
    if (opts.subject && node.subject.toLowerCase() !== opts.subject.toLowerCase()) continue;
    const needles = [node.label, ...(node.aliases || [])].map(conceptKey).filter((n) => n.length >= 4);
    if (needles.some((n) => hay.includes(` ${n} `))) out.push(node);
  }
  return out.slice(0, opts.limit ?? 12);
}

/* ── discovery from documents and courses (spec §24) ───────────────────────────────────────────────── */

/** Concepts named by a document's own structure: markdown/plain headings, then numbered or lettered section
 *  titles. Deliberately structure-first — a heading is the document author's own statement of what this
 *  section is about, which is far more reliable than guessing from frequency. */
export function headingConcepts(text: string, limit = 24): string[] {
  const out: string[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 120) continue;
    const md = /^#{1,4}\s+(.+)$/.exec(line);
    const numbered = /^(?:\(?(?:[0-9]{1,2}|[a-hA-H])\)?[.)]|[-•*])\s+(.{3,120})$/.exec(line);
    const titleCase = /^(?:[A-ZÀ-Þ][\w'À-ÿ-]*(?:\s+(?:of|the|and|in|to|a|an|for|on|with|vs)\s+)?){1,8}[A-ZÀ-Þ]?[\w'À-ÿ-]*$/.exec(line);
    const candidate = md?.[1] || numbered?.[1] || (titleCase && line.split(/\s+/).length <= 7 && !/[.:;]$/.test(line) ? line : "");
    const cleaned = candidate.trim().replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
    // A heading that's really a sentence heading a paragraph ("In this section we will look at…") is not a
    // concept name; the length and word-count bounds plus a sentence-punctuation check filter most of those.
    if (cleaned.length >= 4 && cleaned.length <= 70 && cleaned.split(/\s+/).length <= 8 && !/[.!?]$/.test(cleaned)) out.push(cleaned);
  }
  return [...new Set(out)].slice(0, limit);
}

/** Build discovered nodes from a document + an optional course/subject label. Concepts that already exist
 *  in the spine are NOT duplicated — they're returned separately as `matched` so the caller can attach the
 *  document as evidence to the real node instead of creating a look-alike. */
export function discoverConcepts(graph: ConceptGraph, text: string, opts: { subject?: string; source?: string; limit?: number } = {}): { nodes: ConceptNode[]; matched: ConceptNode[] } {
  const matched = matchSpine(graph, text, { limit: 16 });
  const matchedLabels = new Set(matched.map((m) => conceptKey(m.label)));
  const subject = opts.subject || "General";
  const nodes: ConceptNode[] = [];
  for (const label of headingConcepts(text, opts.limit ?? 24)) {
    const id = `disc.${conceptKey(label).replace(/ /g, "-").slice(0, 48)}`;
    if (!id || id === "disc.") continue;
    if (graph.nodes[id] || matchedLabels.has(conceptKey(label))) continue;
    if (nodes.some((n) => n.id === id)) continue;
    nodes.push({ id, label, subject, prereqs: [], kind: "discovered", ...(opts.source ? { source: opts.source.slice(0, 80) } : {}) });
  }
  return { nodes, matched };
}

/** Merge discovered nodes into the graph. Existing nodes (spine or already-discovered) are never replaced —
 *  the spine is authoritative for its own ids, and a re-upload of the same document is idempotent. */
export function mergeDiscovered(graph: ConceptGraph, nodes: ConceptNode[], now: Date = new Date()): ConceptGraph {
  if (!nodes.length) return graph;
  const next = { ...graph.nodes };
  for (const n of nodes) if (!next[n.id]) next[n.id] = n;
  const discovered = Object.values(next).filter((n) => n.kind === "discovered");
  if (discovered.length > GRAPH_DISCOVERED_CAP) {
    // Evict the last-added discovered nodes — the spine is never touched.
    const keep = new Set(discovered.slice(-GRAPH_DISCOVERED_CAP).map((n) => n.id));
    for (const n of discovered) if (!keep.has(n.id)) delete next[n.id];
  }
  return { nodes: next, updatedAt: now.toISOString() };
}

/* ── validation ─────────────────────────────────────────────────────────────────────────────────────── */

/** Re-validate a persisted graph on load. An unknown prerequisite is DROPPED rather than kept: a dangling
 *  edge would make the step-back walk point at a node with no label, which is worse than having no edge. */
export function normalizeConceptGraph(raw: unknown): ConceptGraph | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as any;
  if (!r.nodes || typeof r.nodes !== "object") return undefined;
  const nodes: Record<string, ConceptNode> = {};
  const rawNodes = Object.entries(r.nodes as Record<string, any>).slice(0, 500);
  for (const [k, v] of rawNodes) {
    if (!v || typeof v !== "object") continue;
    const id = String(v.id || k).slice(0, 80);
    const label = typeof v.label === "string" ? v.label.trim().slice(0, 80) : "";
    if (!id || !label) continue;
    const kind: ConceptNode["kind"] = v.kind === "discovered" ? "discovered" : "spine";
    const prereqs = Array.isArray(v.prereqs) ? [...new Set<string>(v.prereqs.map((p: any) => String(p).slice(0, 80)).filter(Boolean))].slice(0, 12) : [];
    const aliases = Array.isArray(v.aliases) ? [...new Set<string>(v.aliases.map((a: any) => String(a).trim().slice(0, 60)).filter(Boolean))].slice(0, 8) : [];
    nodes[id] = {
      id,
      label,
      subject: typeof v.subject === "string" && v.subject.trim() ? v.subject.trim().slice(0, 40) : "General",
      prereqs,
      kind,
      ...(typeof v.source === "string" && v.source.trim() ? { source: v.source.trim().slice(0, 80) } : {}),
      ...(aliases.length ? { aliases } : {}),
    };
  }
  // Drop now-dangling prerequisite edges (see the doc comment above).
  for (const n of Object.values(nodes)) n.prereqs = n.prereqs.filter((p) => nodes[p]);
  // A graph missing the seed entirely (corrupt/partial row) is repaired rather than discarded — the spine is
  // static data, so re-seeding can never lose anything the student produced.
  for (const [id, node] of Object.entries(buildSpine())) if (!nodes[id]) nodes[id] = node;
  return { nodes, updatedAt: typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt)) ? r.updatedAt : new Date(0).toISOString() };
}

/** Ensure a graph exists, seeded and validated — the one call site the routes need. */
export function ensureGraph(existing: unknown): ConceptGraph {
  return normalizeConceptGraph(existing) || seedGraph();
}
