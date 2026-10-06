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
