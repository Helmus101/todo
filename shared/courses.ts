// Courses — the "follow a subject, see your progress" layer. A student ENROLLS in a subject (picked from the
// built-in syllabus catalog below, or a custom one whose outline the AI drafts); the course is a list of
// units, and progress is DERIVED from real work, never ticked by hand:
//   • every tutor session on that subject is credited (to the unit the session was launched from, or — for a
//     free session — to whichever unit the session actually covered, matched by the server);
//   • a unit quiz scored well counts as mastery evidence.
// Pure, dependency-free helpers so client, server and tests all share the same maths.

export type CourseTrack = "ib" | "ap" | "bac" | "other";

export interface CourseUnit { id: string; name: string }

/** Per-unit evidence. `sessions` = tutor sessions credited here; `quizBest` = best 0-1 score of a unit quiz. */
export interface UnitProgress { sessions: number; minutes: number; quizBest?: number; lastAt: string }

export interface EnrolledCourse {
  id: string;
  name: string;
  track?: CourseTrack;
  level?: string;
  units: CourseUnit[];
  progress: Record<string, UnitProgress>;
  enrolledAt: string;
}

export interface CatalogCourse { id: string; name: string; track: CourseTrack; level?: string; units: string[] }

const u = (...names: string[]) => names;

/** Built-in syllabus outlines (unit names follow the public programme structure; the AI is told to ground
 *  lessons in them, never to invent a different syllabus). */
export const COURSE_CATALOG: CatalogCourse[] = [
  { id: "ib-math-aa", name: "Mathematics: Analysis & Approaches", track: "ib", level: "HL/SL", units: u("Number & algebra", "Functions", "Geometry & trigonometry", "Statistics & probability", "Differentiation", "Integration", "Complex numbers & proof (HL)") },
  { id: "ib-physics", name: "Physics", track: "ib", level: "HL/SL", units: u("Measurement & uncertainties", "Mechanics", "Thermal physics", "Waves", "Electricity & magnetism", "Circular motion & gravitation", "Atomic, nuclear & particle physics", "Energy production") },
  { id: "ib-chemistry", name: "Chemistry", track: "ib", level: "HL/SL", units: u("Stoichiometric relationships", "Atomic structure", "Periodicity", "Chemical bonding & structure", "Energetics / thermochemistry", "Chemical kinetics", "Equilibrium", "Acids & bases", "Redox & electrochemistry", "Organic chemistry") },
  { id: "ib-biology", name: "Biology", track: "ib", level: "HL/SL", units: u("Cells", "Molecular biology", "Genetics", "Ecology", "Evolution & biodiversity", "Human physiology", "Nucleic acids", "Metabolism, cell respiration & photosynthesis") },
  { id: "ib-history", name: "History", track: "ib", level: "HL/SL", units: u("Source skills & Paper 1", "Causes & effects of 20th-century wars", "Authoritarian states", "Cold War", "Rights & protest", "Paper 2 essay technique", "Internal assessment") },
  { id: "ib-economics", name: "Economics", track: "ib", level: "HL/SL", units: u("Introduction to economics", "Microeconomics", "Macroeconomics", "The global economy", "Internal assessment (commentaries)") },
  { id: "ib-english-a", name: "English A: Language & Literature", track: "ib", level: "HL/SL", units: u("Readers, writers & texts", "Time & space", "Intertextuality", "Paper 1 textual analysis", "Paper 2 comparative essay", "Individual oral") },
  { id: "ib-cs", name: "Computer Science", track: "ib", level: "HL/SL", units: u("System fundamentals", "Computer organisation", "Networks", "Computational thinking & programming", "Abstract data structures (HL)", "Resource management (HL)") },
  { id: "ib-tok", name: "Theory of Knowledge", track: "ib", units: u("Knowledge & the knower", "Knowledge & technology", "Knowledge & politics", "Knowledge & language", "Knowledge & religion", "Exhibition", "Essay") },
  { id: "bac-maths", name: "Mathématiques (spécialité)", track: "bac", level: "Première/Terminale", units: u("Suites numériques", "Limites et continuité", "Dérivation et convexité", "Fonctions exponentielle et logarithme", "Intégration et primitives", "Probabilités et loi binomiale", "Géométrie dans l'espace", "Dénombrement") },
  { id: "bac-pc", name: "Physique-Chimie", track: "bac", level: "Première/Terminale", units: u("Constitution et transformations de la matière", "Mouvement et interactions", "Énergie : conversions et transferts", "Ondes et signaux", "Mouvement dans un champ", "Chimie organique et dosages", "Thermodynamique") },
  { id: "bac-svt", name: "SVT", track: "bac", level: "Première/Terminale", units: u("Génétique et évolution", "La Terre, la vie et l'organisation du vivant", "Enjeux planétaires contemporains", "Corps humain et santé", "Photosynthèse et énergie") },
  { id: "bac-hggsp", name: "HGGSP", track: "bac", level: "Première/Terminale", units: u("Analyser le monde", "Frontières et territoires", "Puissances et conflits", "Mémoires et histoire", "Environnement", "Savoirs et pouvoirs") },
  { id: "bac-philo", name: "Philosophie", track: "bac", level: "Terminale", units: u("La conscience et l'inconscient", "La liberté", "La vérité", "Le bonheur et le devoir", "L'État et la justice", "L'art et la technique", "Dissertation : méthode", "Explication de texte : méthode") },
  { id: "bac-ses", name: "SES", track: "bac", level: "Première/Terminale", units: u("Croissance et fluctuations", "Mondialisation", "Marché et concurrence", "Structure sociale", "Mobilité sociale", "Politiques économiques", "Travail et emploi") },
  { id: "bac-nsi", name: "NSI", track: "bac", level: "Première/Terminale", units: u("Python et structures de données", "Algorithmes de tri et de recherche", "Bases de données et SQL", "Réseaux et protocoles", "Architecture et systèmes", "Récursivité, arbres et graphes") },
  { id: "bac-francais", name: "Français (EAF)", track: "bac", level: "Première", units: u("Le roman et le récit", "La poésie", "Le théâtre", "La littérature d'idées", "Commentaire de texte", "Dissertation", "Oral : explication linéaire") },
  { id: "ap-calc-ab", name: "AP Calculus AB", track: "ap", units: u("Limits & continuity", "Differentiation: definition & basics", "Composite, implicit & inverse derivatives", "Applications of derivatives", "Analytical applications", "Integration & accumulation", "Differential equations", "Applications of integration") },
  { id: "ap-physics-1", name: "AP Physics 1", track: "ap", units: u("Kinematics", "Force & translational dynamics", "Work, energy & power", "Linear momentum", "Torque & rotational motion", "Oscillations", "Fluids") },
  { id: "ap-bio", name: "AP Biology", track: "ap", units: u("Chemistry of life", "Cell structure & function", "Cellular energetics", "Cell communication & cycle", "Heredity", "Gene expression & regulation", "Natural selection", "Ecology") },
  { id: "ap-us-history", name: "AP US History", track: "ap", units: u("Period 1–2: Colonial era", "Period 3: Revolution & early republic", "Period 4: Expansion & reform", "Period 5: Civil War & Reconstruction", "Period 6: Gilded Age", "Period 7–8: 1898–1945", "Period 9: 1945–present", "DBQ, LEQ & SAQ skills") },
  { id: "ap-csa", name: "AP Computer Science A", track: "ap", units: u("Primitive types", "Using objects", "Boolean expressions & if statements", "Iteration", "Writing classes", "Arrays & ArrayList", "Recursion & searching/sorting") },
  { id: "gen-maths", name: "Mathematics", track: "other", units: u("Algebra", "Functions", "Geometry", "Trigonometry", "Statistics & probability", "Calculus") },
  { id: "gen-english", name: "English", track: "other", units: u("Reading comprehension", "Essay writing", "Grammar & style", "Literary analysis", "Vocabulary", "Speaking & presentation") },
  { id: "gen-spanish", name: "Spanish", track: "other", units: u("Present tense & basics", "Past tenses", "Subjunctive", "Vocabulary & everyday dialogue", "Reading & writing", "Listening & speaking") },
];

export function findCatalog(id: string): CatalogCourse | undefined { return COURSE_CATALOG.find((c) => c.id === id); }

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unit";

/** Snapshot a catalog entry as an enrolled course (units are copied so later catalog edits never reshuffle a
 *  student's saved progress). */
export function enrollFromCatalog(c: CatalogCourse, now = new Date().toISOString()): EnrolledCourse {
  return { id: c.id, name: c.name, track: c.track, level: c.level, units: unitsFromNames(c.units), progress: {}, enrolledAt: now };
}

export function unitsFromNames(names: string[]): CourseUnit[] {
  const seen = new Set<string>();
  return names.map((n) => n.trim()).filter(Boolean).slice(0, 40).map((name, i) => {
    let id = `${i + 1}-${slug(name)}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    return { id, name: name.slice(0, 100) };
  });
}

export type UnitState = "new" | "started" | "solid";

/** 0 = untouched, 0.5 = studied with the tutor, 1 = solid (2+ sessions, or a quiz ≥ 80%). */
export function unitScore(p: UnitProgress | undefined): number {
  if (!p) return 0;
  if ((p.quizBest ?? 0) >= 0.8 || p.sessions >= 2) return 1;
  if (p.sessions >= 1 || (p.quizBest ?? 0) > 0) return 0.5;
  return 0;
}
export function unitState(p: UnitProgress | undefined): UnitState {
  const s = unitScore(p);
  return s >= 1 ? "solid" : s > 0 ? "started" : "new";
}

/** Whole-course progress 0-1. */
export function courseProgress(c: Pick<EnrolledCourse, "units" | "progress">): number {
  if (!c.units.length) return 0;
  return c.units.reduce((n, un) => n + unitScore(c.progress[un.id]), 0) / c.units.length;
}

/** What the tutor should steer the student to next: the first unit not yet solid, preferring ones already
 *  started (finish what you began) over fresh ones. */
export function nextUnit(c: Pick<EnrolledCourse, "units" | "progress">): CourseUnit | undefined {
  return c.units.find((x) => unitState(c.progress[x.id]) === "started") || c.units.find((x) => unitState(c.progress[x.id]) === "new");
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Which enrolled course does a free-text tutor subject ("Math", "Physics", "Maths") belong to? Loose on
 *  purpose — the tutor's subject picker uses short generic labels. */
export function matchCourseForSubject(courses: EnrolledCourse[], subject: string): EnrolledCourse | undefined {
  const s = norm(subject);
  if (!s) return undefined;
  const alias: Record<string, string[]> = { math: ["math", "maths", "mathematiques", "mathematics", "calculus"], physics: ["physics", "physique"], chemistry: ["chemistry", "chimie"], biology: ["biology", "svt"], history: ["history", "histoire", "hggsp"], english: ["english", "anglais", "litterature"], french: ["francais", "french"], economics: ["economics", "ses", "economie"], philosophy: ["philosophy", "philosophie", "philo"], "computer science": ["computer", "nsi", "informatique"], spanish: ["spanish", "espagnol"] };
  const keys = new Set<string>([s, ...s.split(" ")]);
  for (const [k, vs] of Object.entries(alias)) if (keys.has(k) || vs.some((v) => keys.has(v))) vs.concat(k).forEach((v) => keys.add(v));
  return courses.find((c) => { const n = norm(c.name); return n === s || [...keys].some((k) => k.length > 2 && n.includes(k)); });
}

/** Credit one tutor session to a unit (immutably). Minutes are capped per session so an idle tab left open
 *  can't inflate progress; a session needs ≥ 2 minutes of substance to count at all. */
export function creditSession(c: EnrolledCourse, unitId: string, minutes: number, now = new Date().toISOString()): EnrolledCourse {
  if (!c.units.some((x) => x.id === unitId)) return c;
  const m = Math.max(0, Math.min(90, Math.round(minutes)));
  if (m < 2) return c;
  const cur = c.progress[unitId];
  return { ...c, progress: { ...c.progress, [unitId]: { sessions: (cur?.sessions || 0) + 1, minutes: (cur?.minutes || 0) + m, quizBest: cur?.quizBest, lastAt: now } } };
}

export function creditQuiz(c: EnrolledCourse, unitId: string, score: number, now = new Date().toISOString()): EnrolledCourse {
  if (!c.units.some((x) => x.id === unitId)) return c;
  const s = Math.max(0, Math.min(1, score));
  const cur = c.progress[unitId];
  return { ...c, progress: { ...c.progress, [unitId]: { sessions: cur?.sessions || 0, minutes: cur?.minutes || 0, quizBest: Math.max(cur?.quizBest ?? 0, s), lastAt: now } } };
}

/** Defensive clean-up for whatever comes out of storage / a request body. */
export function normalizeCourses(raw: any): EnrolledCourse[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EnrolledCourse[] = [];
  for (const c of raw.slice(0, 12)) {
    const name = String(c?.name || "").trim().slice(0, 80);
    const units: CourseUnit[] = Array.isArray(c?.units)
      ? c.units.slice(0, 40).map((x: any) => ({ id: String(x?.id || "").slice(0, 60), name: String(x?.name || "").trim().slice(0, 100) })).filter((x: CourseUnit) => x.id && x.name)
      : [];
    if (!name || !units.length || typeof c?.id !== "string" || !c.id) continue;
    const progress: Record<string, UnitProgress> = {};
    for (const un of units) {
      const p = c.progress?.[un.id];
      if (!p || typeof p !== "object") continue;
      progress[un.id] = {
        sessions: Math.max(0, Math.min(999, Math.round(Number(p.sessions) || 0))),
        minutes: Math.max(0, Math.min(99999, Math.round(Number(p.minutes) || 0))),
        quizBest: p.quizBest == null ? undefined : Math.max(0, Math.min(1, Number(p.quizBest) || 0)),
        lastAt: typeof p.lastAt === "string" ? p.lastAt : new Date().toISOString(),
      };
    }
    out.push({
      id: c.id.slice(0, 60), name, units, progress,
      track: ["ib", "ap", "bac", "other"].includes(c.track) ? c.track : undefined,
      level: typeof c.level === "string" ? c.level.slice(0, 30) : undefined,
      enrolledAt: typeof c.enrolledAt === "string" ? c.enrolledAt : new Date().toISOString(),
    });
  }
  return out;
}
// ── Courses — built-in syllabi + unit-level progress ────────────────────────────────────────────────────
// Direct request: a "Courses" surface like the ones students already know (Khan Academy's course → unit →
// mastery path, Duolingo's follow-a-course list) where you see the subjects you actually take, your
// progress through them, and every tutor session / flashcard review / milestone counts toward that
// progress. Content model, per explicit scoping: BUILT-IN syllabi (deterministic data below — no runtime
// AI call just to render a course list, no per-account topic-tree generation) with AI units on demand —
// the unit's own topics seed the tutor session, and the existing generation endpoints (decks/quizzes)
// produce the practice material scoped to them.
//
// Progress model, per explicit scoping: MASTERY SIGNALS — exactly the signals the app already tracks, no
// new per-account state: (1) the Leitner "known" ratio across that unit's flashcards (the same box field
// subjectMastery in types.ts reads) and (2) recency-weighted milestones (types.ts's milestonesBySubject
// shape). Tutor sessions feed (2) directly: completed session objectives are recorded as milestones on
// session end (see recordSessionMilestones in server/index.ts), so "all sessions count towards progress"
// holds without inventing a third signal. Never a fabricated 0% — a unit nobody has touched is null
// ("not started"), which the UI renders as such.
import type { Profile, WebTask } from "./types.ts";
import { MASTERY_LEITNER_WEIGHT, MASTERY_MILESTONE_WEIGHT } from "./types.ts";

export interface CourseUnit {
  id: string;
  /** Bilingual display title — the app is French-first with full EN support (see Profile.language). */
  title: { fr: string; en: string };
  /** What this unit actually covers — shown in the UI and used to seed a tutor session's objective list. */
  topics: { fr: string; en: string }[];
  /** Lowercase, accent-free terms used to match this unit against flashcard fronts and milestone topics
   *  (both languages' spellings included). Deliberately generous — matching is a soft signal feeding a
   *  mastery estimate, not a classifier. */
  keywords: string[];
}

export interface Course {
  id: string;
  /** Canonical subject key used for grouping/sorting ("Math", "Physics", …) — the same vocabulary
   *  TutorSession's subject picker stamps onto sessions. */
  subject: string;
  title: { fr: string; en: string };
  /** Which Profile.track values this course belongs to ("bac" = the French lycée programme). */
  tracks: ("bac" | "ib" | "ap" | "other")[];
  /** Free-text year labels (Profile.yearLevel vocabulary), primary label first — display + suggestion
   *  ordering only, never a hard gate. */
  yearLevels: string[];
  /** Every sourceSubject spelling this course should match, case/accent-insensitively (Pronote syncs
   *  French subject names like "Physique-Chimie"; the tutor stamps English ones like "Physics"). */
  subjects: string[];
  units: CourseUnit[];
}

/** Authoring helper — keeps the catalog below compact and readable. */
const u = (id: string, fr: string, en: string, topics: [string, string][], keywords: string[]): CourseUnit => ({
  id,
  title: { fr, en },
  topics: topics.map(([tfr, ten]) => ({ fr: tfr, en: ten })),
  keywords,
});

// Shared alias lists — subjects are spelled differently by Pronote (FR) and the tutor picker (EN).
const M = ["math", "maths", "mathématiques", "mathematiques", "mathematics", "maths spé", "spé maths"];
const PC = ["physique", "physique-chimie", "physique chimie", "physics", "chimie", "chemistry"];
const SVT = ["svt", "sciences de la vie et de la terre", "biology", "biologie", "bio"];
const HG = ["histoire", "géographie", "geographie", "history", "geography", "histoire-géographie", "histoire geo"];
const FR = ["français", "francais", "french", "lettres"];
const PH = ["philosophie", "philo", "philosophy"];
const AN = ["anglais", "english", "anglais lv1", "anglais lv2"];
const SES = ["ses", "sciences économiques et sociales", "économie", "economie", "economics"];
const NSI = ["nsi", "informatique", "computer science", "numérique et sciences informatiques"];
const ESP = ["espagnol", "spanish"];

/** The built-in catalog. Order here is the default display order within a track. */
export const COURSES: Course[] = [
  // ── Bac — Maths ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: "maths-2nde", subject: "Math", tracks: ["bac"], yearLevels: ["Seconde", "2nde"], subjects: M,
    title: { fr: "Maths — Seconde", en: "Maths — Grade 10" },
    units: [
      u("nombres", "Nombres et calculs", "Numbers and algebra", [["Ensembles de nombres", "Number sets"], ["Calcul littéral", "Algebraic manipulation"], ["Équations et inéquations", "Equations and inequalities"]], ["nombre", "nombres", "calcul littéral", "calcul litteral", "équation", "equation", "inéquation", "inequation", "intervalle", "valeur absolue", "number", "algebra", "inequality"]),
      u("fonctions", "Fonctions", "Functions", [["Notion de fonction", "Function basics"], ["Courbes et tableaux de valeurs", "Graphs and tables"], ["Fonctions affines", "Linear functions"]], ["fonction", "fonctions", "courbe", "graphique", "affine", "linéaire", "lineaire", "image", "antécédent", "antecedent", "function", "graph", "linear"]),
      u("geometrie", "Géométrie", "Geometry", [["Vecteurs", "Vectors"], ["Repérage dans le plan", "Coordinate geometry"], ["Trigonométrie", "Trigonometry"]], ["vecteur", "vecteurs", "géométrie", "geometrie", "trigonométrie", "trigonometrie", "repère", "repere", "cosinus", "sinus", "vector", "geometry", "trigonometry"]),
      u("stats-proba", "Statistiques et probabilités", "Statistics and probability", [["Statistiques descriptives", "Descriptive statistics"], ["Probabilités", "Probability"], ["Échantillonnage", "Sampling"]], ["statistique", "statistiques", "probabilité", "probabilite", "moyenne", "médiane", "mediane", "fréquence", "frequence", "statistics", "probability", "average", "median"]),
      u("algorithmique", "Algorithmique et programmation", "Algorithms and programming", [["Boucles et conditions", "Loops and conditionals"], ["Fonctions en Python", "Python functions"]], ["algorithme", "algorithmique", "python", "programme", "boucle", "algorithm", "loop", "script", "code"]),
    ],
  },
  {
    id: "maths-1re", subject: "Math", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: M,
    title: { fr: "Maths — Première (spé)", en: "Maths — Grade 11 (major)" },
    units: [
      u("second-degre", "Second degré", "Quadratics", [["Forme canonique", "Vertex form"], ["Discriminant", "Discriminant"], ["Signe d'un trinôme", "Sign of a quadratic"]], ["second degré", "second degre", "quadratique", "quadratic", "discriminant", "trinôme", "trinome", "parabole", "canonique", "vertex", "polynôme", "polynomial"]),
      u("suites", "Suites numériques", "Sequences", [["Suites arithmétiques", "Arithmetic sequences"], ["Suites géométriques", "Geometric sequences"], ["Sens de variation", "Monotonicity"]], ["suite", "suites", "arithmétique", "arithmetique", "géométrique", "geometrique", "récurrence", "recurrence", "sequence", "arithmetic", "geometric"]),
      u("derivation", "Dérivation", "Differentiation", [["Nombre dérivé", "Derivative at a point"], ["Fonction dérivée", "Derivative function"], ["Tangentes", "Tangent lines"]], ["dérivée", "derivee", "dérivation", "derivation", "tangente", "taux de variation", "derivative", "tangent", "rate of change"]),
      u("exponentielle", "Fonction exponentielle", "Exponential function", [["Propriétés algébriques", "Algebraic properties"], ["Étude et représentation", "Study and graph"]], ["exponentielle", "exponentiel", "exp(", "exponential", "croissance", "growth"]),
      u("proba-cond", "Probabilités conditionnelles", "Conditional probability", [["Arbres pondérés", "Probability trees"], ["Indépendance", "Independence"]], ["probabilité conditionnelle", "probabilite conditionnelle", "conditionnelle", "indépendance", "independance", "arbre pondéré", "arbre pondere", "conditional probability", "tree diagram"]),
      u("produit-scalaire", "Produit scalaire", "Dot product", [["Définition et propriétés", "Definition and properties"], ["Applications géométriques", "Geometric applications"]], ["produit scalaire", "scalaire", "orthogonal", "dot product", "scalar product"]),
    ],
  },
  {
    id: "maths-tle", subject: "Math", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: M,
    title: { fr: "Maths — Terminale (spé)", en: "Maths — Grade 12 (major)" },
    units: [
      u("limites", "Limites et continuité", "Limits and continuity", [["Limites de fonctions", "Limits"], ["Théorème des valeurs intermédiaires", "Intermediate value theorem"]], ["limite", "limites", "continuité", "continuite", "asymptote", "limit", "continuity"]),
      u("convexite", "Dérivation et convexité", "Differentiation and convexity", [["Dérivées successives", "Higher derivatives"], ["Convexité", "Convexity"]], ["convexité", "convexite", "concave", "dérivée seconde", "derivee seconde", "convex", "inflection"]),
      u("ln", "Fonction logarithme", "Logarithm", [["Propriétés", "Properties"], ["Étude de ln", "Studying ln"]], ["logarithme", "ln(", "log ", "logarithme népérien", "neperien", "logarithm"]),
      u("integration", "Intégration", "Integration", [["Primitives", "Antiderivatives"], ["Intégrale et aire", "Integrals and area"]], ["intégrale", "integrale", "primitive", "primitives", "aire", "intégration", "integration", "antiderivative"]),
      u("suites-tle", "Suites et récurrence", "Sequences and induction", [["Raisonnement par récurrence", "Proof by induction"], ["Convergence", "Convergence"]], ["récurrence", "recurrence", "convergence", "converge", "suite", "induction"]),
      u("espace", "Géométrie dans l'espace", "3D geometry", [["Droites et plans", "Lines and planes"], ["Vecteurs de l'espace", "3D vectors"]], ["espace", "plan", "droite", "vecteur", "3d", "plane", "cube"]),
    ],
  },
  // ── Bac — Physique-Chimie ───────────────────────────────────────────────────────────────────────────
  {
    id: "pc-2nde", subject: "Physics", tracks: ["bac"], yearLevels: ["Seconde", "2nde"], subjects: PC,
    title: { fr: "Physique-Chimie — Seconde", en: "Physics & Chemistry — Grade 10" },
    units: [
      u("pc-2nde-mesure", "Mesures et incertitudes", "Measurement and uncertainty", [["Incertitudes", "Uncertainties"], ["Notation scientifique", "Scientific notation"]], ["incertitude", "mesure", "mesures", "unité", "unite", "uncertainty", "measurement", "unit"]),
      u("pc-2nde-mouvement", "Mouvement et interactions", "Motion and interactions", [["Vitesse", "Velocity"], ["Forces", "Forces"], ["Gravitation", "Gravitation"]], ["vitesse", "mouvement", "force", "forces", "gravitation", "trajectoire", "velocity", "motion", "gravity"]),
      u("pc-2nde-ondes", "Ondes et signaux", "Waves and signals", [["Son et lumière", "Sound and light"], ["Réfraction", "Refraction"], ["Circuits électriques", "Electric circuits"]], ["onde", "ondes", "son", "lumière", "lumiere", "réfraction", "refraction", "circuit", "tension", "wave", "sound", "light"]),
      u("pc-2nde-chimie", "Constitution de la matière", "Structure of matter", [["Atomes et ions", "Atoms and ions"], ["Tableau périodique", "Periodic table"], ["Molécules", "Molecules"]], ["atome", "atomes", "ion", "ions", "molécule", "molecule", "périodique", "periodique", "élément", "element", "atom", "periodic"]),
      u("pc-2nde-transfo", "Transformations chimiques", "Chemical transformations", [["Réactions", "Reactions"], ["Équations bilan", "Balanced equations"], ["Mole", "Moles"]], ["réaction", "reaction", "équation", "equation", "mole", "moles", "bilan", "stœchiométrie", "stoechiometrie", "stoichiometry"]),
    ],
  },
  {
    id: "pc-1re", subject: "Physics", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: PC,
    title: { fr: "Physique-Chimie — Première (spé)", en: "Physics & Chemistry — Grade 11 (major)" },
    units: [
      u("pc-1re-energie", "Énergie et conversions", "Energy and conversions", [["Énergie cinétique", "Kinetic energy"], ["Travail", "Work"], ["Rendement", "Efficiency"]], ["énergie", "energie", "cinétique", "cinetique", "travail", "rendement", "joule", "energy", "kinetic", "work", "efficiency"]),
      u("pc-1re-champs", "Champs et interactions", "Fields and interactions", [["Champ électrique", "Electric field"], ["Champ magnétique", "Magnetic field"]], ["champ", "électrique", "electrique", "magnétique", "magnetique", "field", "magnetic", "electric"]),
      u("pc-1re-optique", "Optique", "Optics", [["Lentilles", "Lenses"], ["Images", "Images"]], ["optique", "lentille", "lentilles", "image", "focale", "optics", "lens", "focal"]),
      u("pc-1re-chimie", "Chimie quantitative", "Quantitative chemistry", [["Titrages", "Titrations"], ["Concentrations", "Concentrations"]], ["titrage", "concentration", "solution", "dilution", "titration", "molarité", "molarity"]),
      u("pc-1re-orga", "Chimie organique", "Organic chemistry", [["Chaînes carbonées", "Carbon chains"], ["Groupes caractéristiques", "Functional groups"]], ["organique", "carbone", "alcane", "alcool", "groupe caractéristique", "groupe caracteristique", "organic", "alkane", "alcohol"]),
    ],
  },
  {
    id: "pc-tle", subject: "Physics", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: PC,
    title: { fr: "Physique-Chimie — Terminale (spé)", en: "Physics & Chemistry — Grade 12 (major)" },
    units: [
      u("pc-tle-meca", "Mécanique newtonienne", "Newtonian mechanics", [["Lois de Newton", "Newton's laws"], ["Mouvement dans un champ", "Motion in a field"]], ["newton", "mécanique", "mecanique", "accélération", "acceleration", "chute", "mechanics", "force"]),
      u("pc-tle-ondes", "Ondes et diffraction", "Waves and diffraction", [["Diffraction", "Diffraction"], ["Interférences", "Interference"], ["Effet Doppler", "Doppler effect"]], ["diffraction", "interférence", "interference", "doppler", "ondes", "wave"]),
      u("pc-tle-elec", "Électricité et circuits", "Electricity and circuits", [["Condensateurs", "Capacitors"], ["RC", "RC circuits"]], ["condensateur", "capacitor", "rc", "charge", "décharge", "decharge", "circuit"]),
      u("pc-tle-nucleaire", "Physique nucléaire", "Nuclear physics", [["Décroissance radioactive", "Radioactive decay"], ["Fission et fusion", "Fission and fusion"]], ["radioactivité", "radioactivite", "noyau", "fission", "fusion", "nucléaire", "nucleaire", "nuclear", "decay"]),
      u("pc-tle-acide", "Acides et bases", "Acids and bases", [["pH", "pH"], ["Réactions acido-basiques", "Acid-base reactions"]], ["acide", "base", "ph", "acido-basique", "acid", "buffer", "tampon"]),
      u("pc-tle-orga", "Synthèse organique", "Organic synthesis", [["Mécanismes", "Mechanisms"], ["Spectroscopie", "Spectroscopy"]], ["synthèse", "synthese", "mécanisme", "mecanisme", "spectroscopie", "irm", "spectroscopy", "synthesis", "nmr"]),
    ],
  },
  // ── Bac — SVT ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: "svt-2nde", subject: "Biology", tracks: ["bac"], yearLevels: ["Seconde", "2nde"], subjects: SVT,
    title: { fr: "SVT — Seconde", en: "Biology — Grade 10" },
    units: [
      u("svt-2nde-cellule", "La cellule et l'organisation du vivant", "Cells and organization of life", [["Cellule", "The cell"], ["ADN", "DNA"], ["Division cellulaire", "Cell division"]], ["cellule", "cellules", "adn", "dna", "mitose", "chromosome", "cell", "division"]),
      u("svt-2nde-geo", "Géosciences", "Earth sciences", [["Tectonique", "Plate tectonics"], ["Volcanisme", "Volcanism"], ["Séismes", "Earthquakes"]], ["tectonique", "plaque", "volcan", "séisme", "seisme", "tectonic", "volcano", "earthquake"]),
      u("svt-2nde-eco", "Écosystèmes et environnement", "Ecosystems and environment", [["Chaînes alimentaires", "Food chains"], ["Biodiversité", "Biodiversity"]], ["écosystème", "ecosysteme", "biodiversité", "biodiversite", "chaîne alimentaire", "chaine alimentaire", "ecosystem", "biodiversity"]),
      u("svt-2nde-corps", "Corps humain et santé", "Human body and health", [["Reproduction", "Reproduction"], ["Système nerveux", "Nervous system"]], ["reproduction", "nerveux", "hormone", "santé", "sante", "health", "nervous"]),
    ],
  },
  {
    id: "svt-1re", subject: "Biology", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: SVT,
    title: { fr: "SVT — Première (spé)", en: "Biology — Grade 11 (major)" },
    units: [
      u("svt-1re-genetique", "Génétique", "Genetics", [["Méiose", "Meiosis"], ["Brassage génétique", "Genetic recombination"], ["Mutations", "Mutations"]], ["génétique", "genetique", "méiose", "meiose", "mutation", "allèle", "allele", "genetics", "meiosis"]),
      u("svt-1re-immunite", "Immunité", "Immunity", [["Réponse immunitaire", "Immune response"], ["Vaccination", "Vaccination"]], ["immunité", "immunite", "immunitaire", "vaccin", "anticorps", "immunity", "antibody", "vaccine"]),
      u("svt-1re-ecologie", "Écologie", "Ecology", [["Flux d'énergie", "Energy flow"], ["Cycles biogéochimiques", "Biogeochemical cycles"]], ["écologie", "ecologie", "énergie", "energie", "cycle", "ecology", "energy flow"]),
    ],
  },
  {
    id: "svt-tle", subject: "Biology", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: SVT,
    title: { fr: "SVT — Terminale (spé)", en: "Biology — Grade 12 (major)" },
    units: [
      u("svt-tle-genetique", "Génétique et évolution", "Genetics and evolution", [["Évolution", "Evolution"], ["Phylogénie", "Phylogeny"], ["Sélection naturelle", "Natural selection"]], ["évolution", "evolution", "phylogénie", "phylogenie", "sélection naturelle", "selection naturelle", "phylogeny", "natural selection"]),
      u("svt-tle-plantes", "Les plantes", "Plants", [["Photosynthèse", "Photosynthesis"], ["Reproduction des plantes", "Plant reproduction"]], ["plante", "plantes", "photosynthèse", "photosynthese", "photosynthesis", "plant", "végétal", "vegetal"]),
      u("svt-tle-corps", "Corps humain et santé", "Human body and health", [["Système immunitaire", "Immune system"], ["Comportements", "Behaviors"], ["Neurone", "Neuron"]], ["neurone", "immunitaire", "cerveau", "brain", "neuron", "immunity", "hormone"]),
      u("svt-tle-enjeux", "Enjeux planétaires", "Planetary challenges", [["Climat", "Climate"], ["Ressources", "Resources"]], ["climat", "climate", "réchauffement", "rechauffement", "warming", "ressources", "resources"]),
    ],
  },
  // ── Bac — Français / Philo / Histoire-Géo / SES / NSI / Anglais ─────────────────────────────────────
  {
    id: "francais-2nde-1re", subject: "French", tracks: ["bac"], yearLevels: ["Seconde", "Première", "1re"], subjects: FR,
    title: { fr: "Français — Seconde & Première", en: "French — Grades 10–11" },
    units: [
      u("fr-roman", "Le roman et le récit", "The novel and narrative", [["Personnages", "Characters"], ["Narration", "Narration"], ["Œuvres au programme", "Set texts"]], ["roman", "récit", "recit", "personnage", "narrateur", "narration", "novel", "narrative", "character"]),
      u("fr-theatre", "Le théâtre", "Theatre", [["Tragédie et comédie", "Tragedy and comedy"], ["Mise en scène", "Staging"], ["Dialogue", "Dialogue"]], ["théâtre", "theatre", "tragédie", "tragedie", "comédie", "comedie", "scène", "scene", "tragedy", "comedy"]),
      u("fr-poesie", "La poésie", "Poetry", [["Versification", "Versification"], ["Figures de style", "Literary devices"], ["Mouvements", "Movements"]], ["poésie", "poesie", "poème", "poeme", "vers", "strophe", "figure de style", "poetry", "poem", "metaphor"]),
      u("fr-argumentation", "La littérature d'idées", "Literature of ideas", [["Argumentation", "Argumentation"], ["Essais", "Essays"], ["Convaincre et persuader", "Persuasion"]], ["argumentation", "essai", "argument", "persuader", "convaincre", "rhetoric", "essay"]),
      u("fr-methode", "Méthodes du bac", "Exam methods", [["Commentaire", "Close reading"], ["Dissertation", "Essay"], ["Contraction de texte", "Text summary"]], ["commentaire", "dissertation", "méthode", "methode", "introduction", "plan", "method", "outline"]),
    ],
  },
  {
    id: "philo-tle", subject: "Philosophy", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: PH,
    title: { fr: "Philosophie — Terminale", en: "Philosophy — Grade 12" },
    units: [
      u("philo-conscience", "La conscience et l'inconscient", "Consciousness and the unconscious", [["Conscience", "Consciousness"], ["Inconscient", "Unconscious"], ["Sujet", "The subject"]], ["conscience", "inconscient", "sujet", "moi", "consciousness", "unconscious", "self"]),
      u("philo-raison", "La raison et le réel", "Reason and reality", [["Vérité", "Truth"], ["Science", "Science"], ["Démonstration", "Demonstration"]], ["raison", "vérité", "verite", "science", "démonstration", "demonstration", "truth", "reason"]),
      u("philo-morale", "La morale et la politique", "Ethics and politics", [["Liberté", "Freedom"], ["Devoir", "Duty"], ["Justice", "Justice"], ["État", "The state"]], ["morale", "liberté", "liberte", "devoir", "justice", "état", "etat", "ethics", "freedom", "state"]),
      u("philo-art", "L'art et la technique", "Art and technology", [["Beau", "Beauty"], ["Technique", "Technique"], ["Œuvre", "Artwork"]], ["art", "beau", "technique", "œuvre", "oeuvre", "beauty", "artwork"]),
      u("philo-methode", "Méthode de la dissertation", "Essay method", [["Problématisation", "Problematization"], ["Plan", "Outline"], ["Citations", "Quotes"]], ["dissertation", "problématique", "problematique", "plan", "méthode", "methode", "method"]),
    ],
  },
  {
    id: "hg-2nde", subject: "History", tracks: ["bac"], yearLevels: ["Seconde", "2nde"], subjects: HG,
    title: { fr: "Histoire-Géo — Seconde", en: "History & Geography — Grade 10" },
    units: [
      u("hg-2nde-modernes", "Les grandes étapes de la modernité", "Early modern history", [["Renaissance", "Renaissance"], ["Lumières", "Enlightenment"], ["Révolutions", "Revolutions"]], ["renaissance", "lumières", "lumieres", "révolution", "revolution", "enlightenment", "revolution"]),
      u("hg-2nde-env", "Environnement et développement", "Environment and development", [["Ressources", "Resources"], ["Développement durable", "Sustainable development"]], ["environnement", "ressources", "développement durable", "developpement durable", "environment", "sustainability"]),
      u("hg-2nde-metropoles", "Métropolisation", "Metropolization", [["Villes", "Cities"], ["Mondialisation", "Globalization"]], ["métropole", "metropole", "ville", "mondialisation", "globalization", "city", "urban"]),
    ],
  },
  {
    id: "hg-1re", subject: "History", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: HG,
    title: { fr: "Histoire-Géo — Première", en: "History & Geography — Grade 11" },
    units: [
      u("hg-1re-nation", "La Révolution et l'Empire", "Revolution and Empire", [["Révolution française", "French Revolution"], ["Napoléon", "Napoleon"], ["Nation", "The nation"]], ["révolution française", "revolution francaise", "napoléon", "napoleon", "nation", "empire", "french revolution"]),
      u("hg-1re-industrie", "Industrialisation et sociétés", "Industrialization and societies", [["Révolution industrielle", "Industrial revolution"], ["Ouvriers", "Workers"], ["Villes industrielles", "Industrial cities"]], ["industrialisation", "industrie", "ouvrier", "industrial", "factory", "worker"]),
      u("hg-1re-guerre", "La Première Guerre mondiale", "World War I", [["1914-1918", "1914-1918"], ["Tranchées", "Trenches"], ["Traité de Versailles", "Treaty of Versailles"]], ["guerre", "1914", "1918", "tranchée", "tranchee", "versailles", "war", "trench"]),
    ],
  },
  {
    id: "hg-tle", subject: "History", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: HG,
    title: { fr: "Histoire-Géo — Terminale", en: "History & Geography — Grade 12" },
    units: [
      u("hg-tle-guerre-monde", "Le monde depuis 1945", "The world since 1945", [["Guerre froide", "Cold War"], ["Décolonisation", "Decolonization"], ["Nouvel ordre mondial", "New world order"]], ["guerre froide", "cold war", "décolonisation", "decolonisation", "décolonization", "1945", "monde", "world"]),
      u("hg-tle-france", "La France depuis 1945", "France since 1945", [["Ve République", "Fifth Republic"], ["Construction européenne", "European construction"]], ["france", "république", "republique", "europe", "gaulle", "republic"]),
      u("hg-tle-mondia", "Mondialisation", "Globalization", [["Flux mondiaux", "Global flows"], ["Acteurs", "Actors"], ["Inégalités", "Inequalities"]], ["mondialisation", "flux", "globalization", "inequality", "trade"]),
      u("hg-tle-env", "Enjeux environnementaux", "Environmental challenges", [["Changement climatique", "Climate change"], ["Transition", "Transition"]], ["climat", "climatique", "transition", "climate", "environment"]),
    ],
  },
  {
    id: "ses-1re", subject: "Economics", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: SES,
    title: { fr: "SES — Première (spé)", en: "Economics & Social Sciences — Grade 11" },
    units: [
      u("ses-1re-marche", "Le marché", "Markets", [["Offre et demande", "Supply and demand"], ["Élasticité", "Elasticity"], ["Défaillances", "Market failures"]], ["marché", "marche", "offre", "demande", "prix", "élasticité", "elasticite", "market", "supply", "demand", "price"]),
      u("ses-1re-socialisation", "Socialisation", "Socialization", [["Normes et valeurs", "Norms and values"], ["Instances", "Agents of socialization"]], ["socialisation", "norme", "valeur", "socialization", "norm", "value"]),
      u("ses-1re-opinion", "Opinion publique", "Public opinion", [["Sondages", "Polls"], ["Médias", "Media"]], ["opinion", "sondage", "média", "media", "poll", "public opinion"]),
    ],
  },
  {
    id: "ses-tle", subject: "Economics", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: SES,
    title: { fr: "SES — Terminale (spé)", en: "Economics & Social Sciences — Grade 12" },
    units: [
      u("ses-tle-croissance", "Croissance économique", "Economic growth", [["PIB", "GDP"], ["Facteurs de production", "Factors of production"], ["Innovation", "Innovation"]], ["croissance", "pib", "gdp", "growth", "innovation", "production"]),
      u("ses-tle-chomage", "Chômage", "Unemployment", [["Taux de chômage", "Unemployment rate"], ["Politiques de l'emploi", "Employment policies"]], ["chômage", "chomage", "emploi", "unemployment", "employment", "job"]),
      u("ses-tle-mondial", "Commerce international", "International trade", [["Avantages comparatifs", "Comparative advantage"], ["Protectionnisme", "Protectionism"]], ["commerce international", "échange", "echange", "comparatif", "protectionnisme", "trade", "export", "import"]),
      u("ses-tle-env", "Économie et environnement", "Economics and environment", [["Externalités", "Externalities"], ["Transition écologique", "Ecological transition"]], ["externalité", "externalite", "écologie", "ecologie", "climat", "externality", "environment"]),
    ],
  },
  {
    id: "nsi-1re", subject: "Computer Science", tracks: ["bac"], yearLevels: ["Première", "1re", "1ère"], subjects: NSI,
    title: { fr: "NSI — Première", en: "Computer Science — Grade 11" },
    units: [
      u("nsi-1re-python", "Python et bases", "Python basics", [["Variables et types", "Variables and types"], ["Boucles", "Loops"], ["Fonctions", "Functions"]], ["python", "variable", "boucle", "loop", "fonction", "function", "type", "algorithme"]),
      u("nsi-1re-donnees", "Représentation des données", "Data representation", [["Binaire", "Binary"], ["Encodage", "Encoding"], ["Tableaux", "Arrays"]], ["binaire", "binary", "encodage", "encoding", "bit", "octet", "byte", "tableau", "array"]),
      u("nsi-1re-web", "Le Web", "The Web", [["HTML et CSS", "HTML and CSS"], ["Protocole HTTP", "HTTP"], ["Réseaux", "Networks"]], ["html", "css", "web", "http", "réseau", "reseau", "network", "internet"]),
    ],
  },
  {
    id: "nsi-tle", subject: "Computer Science", tracks: ["bac"], yearLevels: ["Terminale", "Tle"], subjects: NSI,
    title: { fr: "NSI — Terminale", en: "Computer Science — Grade 12" },
    units: [
      u("nsi-tle-structures", "Structures de données", "Data structures", [["Listes", "Lists"], ["Piles et files", "Stacks and queues"], ["Arbres", "Trees"], ["Graphes", "Graphs"]], ["liste", "pile", "file", "arbre", "graphe", "list", "stack", "queue", "tree", "graph", "structure"]),
      u("nsi-tle-bases", "Bases de données", "Databases", [["SQL", "SQL"], ["Modèle relationnel", "Relational model"]], ["sql", "base de données", "base de donnees", "relationnel", "database", "relational", "requête", "query"]),
      u("nsi-tle-algo", "Algorithmes avancés", "Advanced algorithms", [["Tri", "Sorting"], ["Recherche", "Search"], ["Complexité", "Complexity"]], ["tri", "recherche", "complexité", "complexite", "sort", "search", "complexity", "récursif", "recursive"]),
    ],
  },
  {
    id: "anglais-lycee", subject: "English", tracks: ["bac"], yearLevels: ["Seconde", "Première", "Terminale"], subjects: AN,
    title: { fr: "Anglais — Lycée", en: "English — High school" },
    units: [
      u("en-grammar", "Grammaire", "Grammar", [["Temps", "Tenses"], ["Modaux", "Modals"], ["Conditionnel", "Conditionals"]], ["grammaire", "grammar", "temps", "tense", "modal", "conditionnel", "conditional", "present perfect"]),
      u("en-vocab", "Vocabulaire et expressions", "Vocabulary and idioms", [["Thèmes d'actualité", "Current topics"], ["Idiomes", "Idioms"]], ["vocabulaire", "vocabulary", "idiom", "expression", "mot", "word", "lexique"]),
      u("en-comprehension", "Compréhension", "Comprehension", [["Compréhension écrite", "Reading"], ["Compréhension orale", "Listening"]], ["compréhension", "comprehension", "reading", "listening", "texte", "text", "audio"]),
      u("en-expression", "Expression écrite et orale", "Writing and speaking", [["Essais", "Essays"], ["Présentations", "Presentations"]], ["expression", "essai", "essay", "writing", "speaking", "présentation", "presentation", "argument"]),
    ],
  },
  // ── IB ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ib-math-aa", subject: "Math", tracks: ["ib"], yearLevels: ["DP1", "DP2", "Year 12", "Year 13"], subjects: M,
    title: { fr: "Mathématiques AA — IB", en: "Mathematics AA — IB" },
    units: [
      u("ib-aa-algebra", "Algèbre", "Algebra", [["Suites", "Sequences"], ["Logarithmes", "Logarithms"], ["Binôme", "Binomial theorem"]], ["suite", "sequence", "logarithme", "logarithm", "binôme", "binomial", "log"]),
      u("ib-aa-functions", "Fonctions", "Functions", [["Fonctions et graphes", "Functions and graphs"], ["Transformations", "Transformations"], ["Équations", "Equations"]], ["fonction", "function", "graphe", "graph", "transformation", "équation", "equation"]),
      u("ib-aa-calculus", "Analyse", "Calculus", [["Dérivées", "Derivatives"], ["Intégrales", "Integrals"], ["Limites", "Limits"]], ["dérivée", "derivative", "intégrale", "integral", "limite", "limit", "calculus"]),
      u("ib-aa-stats", "Probabilités et statistiques", "Probability and statistics", [["Distributions", "Distributions"], ["Normal", "Normal distribution"], ["Binomiale", "Binomial"]], ["probabilité", "probability", "statistique", "statistics", "normale", "normal", "binomiale", "binomial", "distribution"]),
      u("ib-aa-geometry", "Géométrie et trigonométrie", "Geometry and trigonometry", [["Vecteurs", "Vectors"], ["Cercles", "Circles"], ["Identités", "Identities"]], ["vecteur", "vector", "cercle", "circle", "trigonométrie", "trigonometry", "identité", "identity"]),
    ],
  },
  {
    id: "ib-physics", subject: "Physics", tracks: ["ib"], yearLevels: ["DP1", "DP2", "Year 12", "Year 13"], subjects: PC,
    title: { fr: "Physique — IB", en: "Physics — IB" },
    units: [
      u("ib-phy-mechanics", "Mécanique", "Mechanics", [["Cinématique", "Kinematics"], ["Dynamique", "Dynamics"], ["Énergie", "Energy"]], ["mécanique", "mechanics", "cinématique", "kinematics", "dynamique", "dynamics", "énergie", "energy", "suvat"]),
      u("ib-phy-thermal", "Thermique", "Thermal physics", [["Chaleur", "Heat"], ["Gaz parfaits", "Ideal gases"]], ["thermique", "thermal", "chaleur", "heat", "gaz", "gas", "température", "temperature"]),
      u("ib-phy-waves", "Ondes", "Waves", [["Ondes stationnaires", "Standing waves"], ["Optique", "Optics"], ["Son", "Sound"]], ["onde", "wave", "optique", "optics", "son", "sound", "réfraction", "refraction"]),
      u("ib-phy-electricity", "Électricité et magnétisme", "Electricity and magnetism", [["Circuits", "Circuits"], ["Champs", "Fields"], ["Induction", "Induction"]], ["circuit", "électricité", "electricity", "champ", "field", "induction", "magnétisme", "magnetism"]),
      u("ib-phy-nuclear", "Physique nucléaire et énergie", "Nuclear and energy", [["Radioactivité", "Radioactivity"], ["Énergie nucléaire", "Nuclear energy"]], ["nucléaire", "nuclear", "radioactivité", "radioactivity", "énergie", "energy"]),
    ],
  },
  {
    id: "ib-chemistry", subject: "Chemistry", tracks: ["ib"], yearLevels: ["DP1", "DP2", "Year 12", "Year 13"], subjects: PC,
    title: { fr: "Chimie — IB", en: "Chemistry — IB" },
    units: [
      u("ib-chem-stoich", "Stœchiométrie", "Stoichiometry", [["Moles", "Moles"], ["Équations", "Equations"], ["Concentrations", "Concentrations"]], ["stœchiométrie", "stoichiometry", "mole", "concentration", "équation", "equation"]),
      u("ib-chem-atomic", "Structure atomique", "Atomic structure", [["Modèle atomique", "Atomic model"], ["Orbitales", "Orbitals"], ["Spectres", "Spectra"]], ["atome", "atom", "orbitale", "orbital", "spectre", "spectrum", "électron", "electron"]),
      u("ib-chem-bonding", "Liaisons", "Bonding", [["Liaisons covalentes", "Covalent bonds"], ["Forces intermoléculaires", "Intermolecular forces"]], ["liaison", "bond", "covalente", "covalent", "intermoléculaire", "intermolecular", "molécule", "molecule"]),
      u("ib-chem-organic", "Chimie organique", "Organic chemistry", [["Fonctions", "Functional groups"], ["Réactions", "Reactions"], ["Polymères", "Polymers"]], ["organique", "organic", "alcane", "alkane", "polymère", "polymer", "fonction", "functional group"]),
      u("ib-chem-energetics", "Énergétique", "Energetics", [["Enthalpie", "Enthalpy"], ["Entropie", "Entropy"], ["Cinétique", "Kinetics"]], ["enthalpie", "enthalpy", "entropie", "entropy", "cinétique", "kinetics", "thermodynamique", "thermodynamics"]),
    ],
  },
  {
    id: "ib-biology", subject: "Biology", tracks: ["ib"], yearLevels: ["DP1", "DP2", "Year 12", "Year 13"], subjects: SVT,
    title: { fr: "Biologie — IB", en: "Biology — IB" },
    units: [
      u("ib-bio-cells", "Cellules", "Cells", [["Membrane", "Membrane"], ["Mitose", "Mitosis"], ["Transport", "Transport"]], ["cellule", "cell", "membrane", "mitose", "mitosis", "transport"]),
      u("ib-bio-molecular", "Biologie moléculaire", "Molecular biology", [["ADN", "DNA"], ["Protéines", "Proteins"], ["Enzymes", "Enzymes"]], ["adn", "dna", "protéine", "protein", "enzyme", "arn", "rna", "transcription"]),
      u("ib-bio-genetics", "Génétique", "Genetics", [["Hérédité", "Inheritance"], ["Punnett", "Punnett squares"], ["Mutations", "Mutations"]], ["génétique", "genetics", "hérédité", "heredity", "punnett", "mutation", "allèle", "allele"]),
      u("ib-bio-ecology", "Écologie", "Ecology", [["Chaînes alimentaires", "Food chains"], ["Cycles", "Cycles"]], ["écologie", "ecology", "chaîne alimentaire", "food chain", "cycle"]),
      u("ib-bio-physiology", "Physiologie humaine", "Human physiology", [["Systèmes", "Systems"], ["Homéostasie", "Homeostasis"]], ["physiologie", "physiology", "homéostasie", "homeostasis", "système", "system"]),
    ],
  },
  {
    id: "ib-history", subject: "History", tracks: ["ib"], yearLevels: ["DP1", "DP2", "Year 12", "Year 13"], subjects: HG,
    title: { fr: "Histoire — IB", en: "History — IB" },
    units: [
      u("ib-hist-papers", "Méthodes IB", "IB methods", [["Source analysis", "Source analysis"], ["Essais", "Essays"], ["Historiographie", "Historiography"]], ["source", "essai", "essay", "historiographie", "historiography", "méthode", "method", "paper 1", "paper 2"]),
      u("ib-hist-wars", "Guerres mondiales", "World wars", [["Causes", "Causes"], ["Conséquences", "Consequences"]], ["guerre", "war", "1914", "1939", "conflit", "conflict"]),
      u("ib-hist-coldwar", "Guerre froide", "Cold War", [["Superpuissances", "Superpowers"], ["Crise", "Crises"], ["Détente", "Détente"]], ["guerre froide", "cold war", "urss", "ussr", "usa", "détente", "detente"]),
      u("ib-hist-authoritarian", "États autoritaires", "Authoritarian states", [["Totalitarisme", "Totalitarianism"], ["Propagande", "Propaganda"]], ["autoritaire", "authoritarian", "totalitarisme", "totalitarianism", "propagande", "propaganda"]),
    ],
  },
  // ── AP ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ap-calculus-ab", subject: "Math", tracks: ["ap"], yearLevels: ["Grade 11", "Grade 12", "AP"], subjects: M,
    title: { fr: "Calculus AB — AP", en: "Calculus AB — AP" },
    units: [
      u("ap-calc-limits", "Limites et continuité", "Limits and continuity", [["Limites", "Limits"], ["Continuité", "Continuity"]], ["limite", "limit", "continuité", "continuity", "asymptote"]),
      u("ap-calc-derivatives", "Dérivées", "Derivatives", [["Règles de dérivation", "Derivative rules"], ["Chaîne", "Chain rule"], ["Implicite", "Implicit differentiation"]], ["dérivée", "derivative", "chaîne", "chain rule", "implicite", "implicit", "taux", "rate"]),
      u("ap-calc-applications", "Applications des dérivées", "Applications of derivatives", [["Extremums", "Extrema"], ["Optimisation", "Optimization"], ["Related rates", "Related rates"]], ["extremum", "extrema", "optimisation", "optimization", "variation", "related rates"]),
      u("ap-calc-integrals", "Intégrales", "Integrals", [["Riemann", "Riemann sums"], ["Primitives", "Antiderivatives"], ["Substitution", "Substitution"]], ["intégrale", "integral", "riemann", "primitive", "antiderivative", "substitution"]),
      u("ap-calc-diffeq", "Équations différentielles", "Differential equations", [["Séparation des variables", "Separation of variables"], ["Croissance", "Growth and decay"]], ["équation différentielle", "differential equation", "croissance", "growth", "decay", "slope field"]),
    ],
  },
  {
    id: "ap-physics-1", subject: "Physics", tracks: ["ap"], yearLevels: ["Grade 11", "Grade 12", "AP"], subjects: PC,
    title: { fr: "Physique 1 — AP", en: "Physics 1 — AP" },
    units: [
      u("ap-phy-kinematics", "Cinématique", "Kinematics", [["Mouvement 1D", "1D motion"], ["Projectiles", "Projectiles"]], ["cinématique", "kinematics", "projectile", "vitesse", "velocity", "accélération", "acceleration"]),
      u("ap-phy-dynamics", "Dynamique", "Dynamics", [["Newton", "Newton's laws"], ["Friction", "Friction"], ["Plans inclinés", "Inclined planes"]], ["newton", "dynamique", "dynamics", "friction", "force", "plan incliné", "inclined plane"]),
      u("ap-phy-energy", "Énergie et quantité de mouvement", "Energy and momentum", [["Travail", "Work"], ["Conservation", "Conservation"], ["Collisions", "Collisions"]], ["énergie", "energy", "travail", "work", "quantité de mouvement", "momentum", "collision", "conservation"]),
      u("ap-phy-rotation", "Rotation", "Rotation", [["Couple", "Torque"], ["Moment d'inertie", "Moment of inertia"], ["Angulaire", "Angular motion"]], ["rotation", "couple", "torque", "inertie", "inertia", "angulaire", "angular"]),
      u("ap-phy-waves", "Ondes et circuits", "Waves and circuits", [["Ondes", "Waves"], ["Circuits", "Circuits"]], ["onde", "wave", "circuit", "électricité", "electricity", "résistance", "resistance"]),
    ],
  },
  {
    id: "ap-chemistry", subject: "Chemistry", tracks: ["ap"], yearLevels: ["Grade 11", "Grade 12", "AP"], subjects: PC,
    title: { fr: "Chimie — AP", en: "Chemistry — AP" },
    units: [
      u("ap-chem-atomic", "Structure atomique", "Atomic structure", [["Électrons", "Electrons"], ["Périodicité", "Periodicity"]], ["atome", "atom", "électron", "electron", "périodique", "periodic", "orbitale", "orbital"]),
      u("ap-chem-bonding", "Liaisons et molécules", "Bonding and molecules", [["Lewis", "Lewis structures"], ["Géométrie", "Geometry"], ["Forces", "Intermolecular forces"]], ["liaison", "bond", "lewis", "géométrie", "geometry", "intermoléculaire", "intermolecular"]),
      u("ap-chem-reactions", "Réactions", "Reactions", [["Équilibrage", "Balancing"], ["Stœchiométrie", "Stoichiometry"], ["Redox", "Redox"]], ["réaction", "reaction", "stœchiométrie", "stoichiometry", "redox", "équilibre", "equilibrium"]),
      u("ap-chem-kinetics", "Cinétique et thermodynamique", "Kinetics and thermodynamics", [["Vitesse", "Rates"], ["Enthalpie", "Enthalpy"], ["Entropie", "Entropy"]], ["cinétique", "kinetics", "enthalpie", "enthalpy", "entropie", "entropy", "thermodynamique", "thermodynamics"]),
      u("ap-chem-acids", "Acides et bases", "Acids and bases", [["pH", "pH"], ["Titrages", "Titrations"], ["Tampons", "Buffers"]], ["acide", "acid", "base", "ph", "titrage", "titration", "tampon", "buffer"]),
    ],
  },
  {
    id: "ap-biology", subject: "Biology", tracks: ["ap"], yearLevels: ["Grade 11", "Grade 12", "AP"], subjects: SVT,
    title: { fr: "Biologie — AP", en: "Biology — AP" },
    units: [
      u("ap-bio-chemistry", "Chimie du vivant", "Chemistry of life", [["Macromolécules", "Macromolecules"], ["Eau", "Water"], ["Enzymes", "Enzymes"]], ["macromolécule", "macromolecule", "eau", "water", "enzyme", "protéine", "protein"]),
      u("ap-bio-cells", "Cellules", "Cells", [["Structure", "Structure"], ["Transport", "Transport"], ["Signalisation", "Signaling"]], ["cellule", "cell", "membrane", "transport", "signalisation", "signaling"]),
      u("ap-bio-genetics", "Génétique", "Genetics", [["Mendel", "Mendel"], ["ADN", "DNA"], ["Expression génique", "Gene expression"]], ["génétique", "genetics", "mendel", "adn", "dna", "gène", "gene", "expression"]),
      u("ap-bio-evolution", "Évolution", "Evolution", [["Sélection naturelle", "Natural selection"], ["Phylogénie", "Phylogeny"]], ["évolution", "evolution", "sélection naturelle", "natural selection", "phylogénie", "phylogeny"]),
      u("ap-bio-ecology", "Écologie", "Ecology", [["Écosystèmes", "Ecosystems"], ["Populations", "Populations"]], ["écologie", "ecology", "écosystème", "ecosystem", "population"]),
    ],
  },
  {
    id: "ap-english-lang", subject: "English", tracks: ["ap"], yearLevels: ["Grade 11", "Grade 12", "AP"], subjects: AN,
    title: { fr: "English Language — AP", en: "English Language — AP" },
    units: [
      u("ap-eng-rhetoric", "Rhétorique", "Rhetoric", [["Appeals", "Rhetorical appeals"], ["Stratégies", "Strategies"]], ["rhétorique", "rhetoric", "ethos", "pathos", "logos", "argument"]),
      u("ap-eng-analysis", "Analyse de texte", "Text analysis", [["Close reading", "Close reading"], ["Ton", "Tone"], ["Structure", "Structure"]], ["analyse", "analysis", "close reading", "ton", "tone", "structure"]),
      u("ap-eng-argument", "Argumentation", "Argumentation", [["Thèse", "Thesis"], ["Preuves", "Evidence"], ["Synthèse", "Synthesis"]], ["thèse", "thesis", "preuve", "evidence", "synthèse", "synthesis", "argument"]),
    ],
  },
];

/** Look up a course by id (undefined for an unknown/removed id — callers degrade gracefully). */
export function findCourse(id: string): Course | undefined {
  return COURSES.find((c) => c.id === id);
}

// ── Matching helpers ────────────────────────────────────────────────────────────────────────────────────
/** Lowercase + strip accents + collapse anything non-alphanumeric to single spaces — the one normalization
 *  every match below goes through, so "Physique-Chimie", "physique chimie" and "PHYSIQUE_CHIMIE" all meet. */
export function normText(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Does a normalized haystack contain this (normalized) keyword as a whole word/phrase? Word-boundary
 *  aware so "art" doesn't match "partiel" — the one false-positive class that would actually mislead.
 *  Also accepts a plain s/x plural ("acide" matches "acides", "derivative" matches "derivatives") —
 *  milestone topics and flashcard fronts are free prose, and requiring every author to list every plural
 *  in keywords would make the catalog lie about its own coverage. Irregular plurals (travaux, …) stay
 *  explicit keywords. */
function hasKeyword(normHaystack: string, keyword: string): boolean {
  const kw = normText(keyword);
  if (!kw) return false;
  const padded = ` ${normHaystack} `;
  return padded.includes(` ${kw} `) || padded.includes(` ${kw}s `) || padded.includes(` ${kw}x `);
}

/** Does a sourceSubject string (Pronote's "Physique-Chimie", the tutor picker's "Physics") belong to this
 *  course? Case/accent-insensitive, exact match against the course's own alias list. */
export function subjectMatches(sourceSubject: string | undefined, course: Course): boolean {
  const s = normText(sourceSubject || "");
  if (!s) return false;
  return course.subjects.some((alias) => normText(alias) === s);
}

/** Does a free-text topic/milestone/objective mention this unit? True when ANY of the unit's keywords
 *  appears in the text. */
export function matchesUnit(text: string | undefined, unit: CourseUnit): boolean {
  const hay = normText(text || "");
  if (!hay) return false;
  return unit.keywords.some((k) => hasKeyword(hay, k));
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────────────
// Same recency decay + saturation as subjectMastery (types.ts) — kept in sync deliberately: a unit's
// progress should mean exactly what a subject's mastery means, one level down. The constants are the
// same product-judgment values (weights imported from types.ts, decay/saturation mirrored here).
const UNIT_MILESTONE_DECAY_DAYS = 90;
const UNIT_MILESTONES_FOR_FULL_SCORE = 3;

export interface UnitProgress {
  unit: CourseUnit;
  /** 0-1, or null when NO signal exists for this unit yet ("not started" — never a fabricated 0%). */
  mastery: number | null;
  /** Where the number came from, for honest UI ("from 6 cards", "from a session") — counts only, no scores. */
  signal: { cards: number; known: number; milestones: number };
}

/** Mastery for ONE unit of a course, from the same two signals subjectMastery uses — scoped by keyword
 *  match instead of by subject: (1) Leitner known-ratio across flashcards whose front/back mention the
 *  unit, (2) recency-weighted milestones whose topic/label mention it. null when neither exists. */
export function unitMastery(
  tasks: WebTask[],
  milestones: Profile["milestones"] | undefined,
  course: Course,
  unit: CourseUnit,
  now: Date = new Date(),
): UnitProgress {
  let cards = 0;
  let known = 0;
  for (const t of tasks) {
    if (!subjectMatches(t.sourceSubject, course)) continue;
    for (const deck of t.flashcards || []) {
      for (const card of deck.cards) {
        if (card.notNeeded) continue;
        if (!matchesUnit(card.front, unit) && !matchesUnit(card.back, unit)) continue;
        cards++;
        if (card.review?.box === 2) known++;
      }
    }
  }
  const leitnerRatio = cards > 0 ? known / cards : null;

  let milestoneWeight = 0;
  let milestoneCount = 0;
  for (const m of milestones || []) {
    if (!subjectMatches(m.subject, course)) continue;
    if (!matchesUnit(`${m.topic} ${m.label}`, unit)) continue;
    const daysAgo = (now.getTime() - Date.parse(m.achievedAt)) / 86_400_000;
    milestoneWeight += Math.max(0, 1 - daysAgo / UNIT_MILESTONE_DECAY_DAYS);
    milestoneCount++;
  }
  const milestoneScore = milestoneCount > 0 ? Math.min(1, milestoneWeight / UNIT_MILESTONES_FOR_FULL_SCORE) : null;

  const mastery = leitnerRatio === null && milestoneScore === null ? null
    : leitnerRatio === null ? milestoneScore
    : milestoneScore === null ? leitnerRatio
    : MASTERY_LEITNER_WEIGHT * leitnerRatio + MASTERY_MILESTONE_WEIGHT * milestoneScore;
  return { unit, mastery, signal: { cards, known, milestones: milestoneCount } };
}

export interface CourseProgress {
  course: Course;
  units: UnitProgress[];
  /** Mean of the units that HAVE data, 0-1 — null when no unit has any signal yet. */
  pct: number | null;
  /** Units with a real signal / total units. */
  touched: number;
}

export function courseProgress(tasks: WebTask[], milestones: Profile["milestones"] | undefined, course: Course, now: Date = new Date()): CourseProgress {
  const units = course.units.map((unit) => unitMastery(tasks, milestones, course, unit, now));
  const withData = units.filter((x) => x.mastery !== null);
  const pct = withData.length ? withData.reduce((a, x) => a + (x.mastery || 0), 0) / withData.length : null;
  return { course, units, pct, touched: withData.length };
}

/** A unit reads as "mastered" at/above this — the same 0.8 bar the mastery UI already implies, exported so
 *  the client's state labels and this function can't drift apart. */
export const UNIT_MASTERED_AT = 0.8;
export type UnitBand = "new" | "learning" | "mastered";
export function masteryBand(mastery: number | null): UnitBand {
  if (mastery === null) return "new";
  return mastery >= UNIT_MASTERED_AT ? "mastered" : "learning";
}

/** The unit to work on next in a course, in course order: the first unit with NO data yet, else the first
 *  unit still below the mastered bar. null when every unit is mastered (or the course has no units). */
export function nextUnitToWork(progress: CourseProgress): UnitProgress | null {
  for (const up of progress.units) if (up.mastery === null) return up;
  for (const up of progress.units) if ((up.mastery || 0) < UNIT_MASTERED_AT) return up;
  return null;
}

/** Suggested courses for a student, best first: their own track's courses before the other tracks', and
 *  within a track, courses whose yearLevels mention the student's yearLevel. Pure ordering — the UI still
 *  shows everything; this only decides what's pinned near the top ("ton programme"). */
export function orderCoursesForProfile(courses: Course[], profile: Profile | null | undefined): Course[] {
  const track = profile?.track;
  const year = normText(profile?.yearLevel || "");
  const score = (c: Course): number => {
    let s = 0;
    if (track && c.tracks.includes(track)) s += 10;
    if (year && c.yearLevels.some((y) => normText(y) === year || (normText(y) && year.includes(normText(y))))) s += 5;
    return s;
  };
  return [...courses].sort((a, b) => score(b) - score(a));
}

/** Followed course ids, self-healed on every read: unknown ids dropped (catalog changed since), duplicates
 *  collapsed, order preserved. Used by both the server route and the client render. */
export function normalizeEnrolledCourses(ids: unknown, courses: Course[] = COURSES): string[] {
  if (!Array.isArray(ids)) return [];
  const valid = new Set(courses.map((c) => c.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw);
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Objective labels to seed a tutor session with when starting from a unit ("learn this unit") — the
 *  unit's own topics, one objective each, capped to the session-objective range (3-6, see SET_OBJECTIVES).
 *  Deterministic, zero AI cost: the tutor still decides when each is actually done. */
export function unitObjectives(unit: CourseUnit, lang: "fr" | "en"): string[] {
  const topics = unit.topics.map((t) => (lang === "en" ? t.en : t.fr));
  const all = topics.length ? topics : [lang === "en" ? unit.title.en : unit.title.fr];
  return all.slice(0, 6);
}
