// A prerequisite map of IB Mathematics: Analysis and Approaches (SL and HL), the pilot subject for "check what it builds on". Each node is
// one assessable idea; `needs` lists the ideas it rests on. It is a teaching aid, not the syllabus: the syllabus itself is in the subject
// pack (shared/ibPacks/maths.ts) and the official guide. HL-only nodes are marked.
export interface MathsNode { id: string; title: string; needs: string[]; hl?: boolean; match: RegExp }

export const MATHS_AA_GRAPH: MathsNode[] = [
  // number and algebra
  { id: "exp-laws", title: "laws of exponents and surds", needs: [], match: /exponent|index|indices|surd|power law/i },
  { id: "logs", title: "logarithms", needs: ["exp-laws"], match: /logarithm|\blogs?\b|\bln\b/i },
  { id: "sequences", title: "arithmetic and geometric sequences and series", needs: ["exp-laws"], match: /sequence|series|sigma|arithmetic|geometric/i },
  { id: "binomial", title: "binomial theorem", needs: ["exp-laws", "sequences"], match: /binomial|pascal/i },
  { id: "systems", title: "solving equations and systems", needs: [], match: /simultaneous|system of equation|solving equation|rearrang/i },
  { id: "proof", title: "proof (induction, contradiction, counterexample)", needs: ["sequences", "systems"], hl: true, match: /proof|induction|contradiction|counterexample/i },
  { id: "complex", title: "complex numbers", needs: ["systems", "quadratics"], hl: true, match: /complex|argand|de moivre|modulus and argument/i },
  { id: "partial-fractions", title: "partial fractions", needs: ["polynomials", "systems"], hl: true, match: /partial fraction/i },
  // functions
  { id: "functions", title: "function notation, domain and range", needs: [], match: /function notation|domain|range|mapping/i },
  { id: "composite-inverse", title: "composite and inverse functions", needs: ["functions"], match: /composite|inverse function|f\s*∘|g\s*∘/i },
  { id: "transformations", title: "transformations of graphs", needs: ["functions"], match: /transformation|translation|reflection|stretch/i },
  { id: "quadratics", title: "quadratics, completing the square and the discriminant", needs: ["systems"], match: /quadratic|discriminant|complet(e|ing) the square/i },
  { id: "polynomials", title: "polynomials, factor and remainder theorems", needs: ["quadratics"], match: /polynomial|factor theorem|remainder theorem/i },
  { id: "rational", title: "rational functions and asymptotes", needs: ["functions", "polynomials"], match: /rational function|asymptote/i },
  { id: "exp-log-fns", title: "exponential and logarithmic functions", needs: ["exp-laws", "logs", "functions"], match: /exponential function|exponential growth|exponential decay|log function/i },
  { id: "modulus", title: "modulus functions and inequalities", needs: ["functions", "systems"], hl: true, match: /modulus|absolute value/i },
  // geometry and trigonometry
  { id: "triangles", title: "right-angled and non-right-angled triangle trigonometry", needs: [], match: /sine rule|cosine rule|right.?angle|pythag|triangle trig|area of a triangle/i },
  { id: "radians", title: "radians, arcs and sectors", needs: ["triangles"], match: /radian|arc length|sector/i },
  { id: "unit-circle", title: "the unit circle and trigonometric functions", needs: ["radians", "functions"], match: /unit circle|trigonometric function|sinusoidal|period|amplitude/i },
  { id: "trig-identities", title: "trigonometric identities and equations", needs: ["unit-circle", "quadratics"], match: /identit|trig(onometric)? equation|double angle|compound angle|sin\^?2/i },
  { id: "vectors", title: "vectors, lines and planes", needs: ["triangles", "systems"], hl: true, match: /vector|scalar product|dot product|cross product|plane/i },
  // statistics and probability
  { id: "descriptive", title: "descriptive statistics and data", needs: [], match: /mean|median|quartile|standard deviation|box plot|histogram|descriptive/i },
  { id: "prob-rules", title: "probability rules and Venn diagrams", needs: [], match: /probability|venn|tree diagram|mutually exclusive|independent event/i },
  { id: "conditional", title: "conditional probability", needs: ["prob-rules"], match: /conditional|given that|bayes/i },
  { id: "discrete-rv", title: "discrete random variables and expectation", needs: ["prob-rules"], match: /random variable|expected value|expectation|discrete/i },
  { id: "binomial-dist", title: "the binomial distribution", needs: ["discrete-rv", "binomial"], match: /binomial distribution|\bB\(n/i },
  { id: "normal", title: "the normal distribution", needs: ["descriptive", "discrete-rv"], match: /normal distribution|z-?score|inverse normal/i },
  { id: "regression", title: "correlation and regression", needs: ["descriptive"], match: /regression|correlation|line of best fit|least squares/i },
  { id: "continuous-rv", title: "continuous random variables", needs: ["normal", "integration"], hl: true, match: /continuous random variable|probability density/i },
  // calculus
  { id: "limits", title: "limits and the idea of the gradient", needs: ["functions"], match: /limit|gradient of a curve|first principles/i },
  { id: "differentiation", title: "differentiation rules (power, chain, product, quotient)", needs: ["limits", "exp-laws"], match: /differentiat|derivative|chain rule|product rule|quotient rule/i },
  { id: "tangents", title: "tangents, normals and rates of change", needs: ["differentiation", "systems"], match: /tangent|normal line|rate of change/i },
  { id: "optimisation", title: "stationary points, optimisation and curve sketching", needs: ["differentiation", "quadratics"], match: /stationary|turning point|optimi[sz]|maxima|minima|concav|inflection|curve sketch/i },
  { id: "integration", title: "integration and the area under a curve", needs: ["differentiation"], match: /integra|antiderivative|area under|definite integral/i },
  { id: "kinematics", title: "kinematics with calculus", needs: ["differentiation", "integration"], match: /kinematic|velocity|acceleration|displacement/i },
  { id: "advanced-integration", title: "integration by substitution and by parts", needs: ["integration", "differentiation"], hl: true, match: /by parts|substitution method|integration by substitution/i },
  { id: "implicit-related", title: "implicit differentiation and related rates", needs: ["differentiation"], hl: true, match: /implicit|related rates/i },
  { id: "diff-equations", title: "differential equations", needs: ["integration", "advanced-integration"], hl: true, match: /differential equation|separation of variables|euler|integrating factor/i },
  { id: "series-limits", title: "Maclaurin series and l'Hopital's rule", needs: ["differentiation", "sequences"], hl: true, match: /maclaurin|l.?h[oô]pital|taylor series/i },
];

/** The node a concept label refers to, if any. */
export function mathsNodeFor(label: string): MathsNode | undefined {
  const l = String(label || "");
  return MATHS_AA_GRAPH.find((n) => n.match.test(l));
}

/** The nodes a concept builds on, directly (one level), by id. */
export function mathsPrerequisites(label: string): MathsNode[] {
  const n = mathsNodeFor(label);
  if (!n) return [];
  const byId = new Map(MATHS_AA_GRAPH.map((x) => [x.id, x]));
  return n.needs.map((id) => byId.get(id)!).filter(Boolean);
}
