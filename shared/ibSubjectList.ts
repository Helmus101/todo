// The IB Diploma subjects a student can pick, by group, and the helpers around a student's own selection (subject + level).
// Otto is built only for the IB Diploma, so this list IS the subject picker everywhere (onboarding, Settings, the tutor's start
// screen) and the names are chosen so that shared/ibSubjects.ts' packs recognise them ("Math AA HL", "Physics SL"...).

export type IbLevel = "HL" | "SL";
export interface IbSubject { name: string; level: IbLevel }

export interface IbSubjectOption { name: string; short: string; group: 1 | 2 | 3 | 4 | 5 | 6 }

/** Every selectable subject. `name` is what is stored and shown; `short` is the form handed to the tutor with the level
 *  (for example "Math AA HL"), so the subject packs match it. */
export const IB_SUBJECTS: IbSubjectOption[] = [
  { name: "English A: Language and Literature", short: "English A Lang & Lit", group: 1 },
  { name: "English A: Literature", short: "English A Literature", group: 1 },
  { name: "French A: Langue et littérature", short: "French A Langue et littérature", group: 1 },
  { name: "French A: Littérature", short: "French A Littérature", group: 1 },
  { name: "Other language A", short: "Language A", group: 1 },
  { name: "French B", short: "French B", group: 2 },
  { name: "English B", short: "English B", group: 2 },
  { name: "Spanish B", short: "Spanish B", group: 2 },
  { name: "Chinese B", short: "Chinese B", group: 2 },
  { name: "Language ab initio", short: "Language ab initio", group: 2 },
  { name: "Economics", short: "Economics", group: 3 },
  { name: "History", short: "History", group: 3 },
  { name: "Geography", short: "Geography", group: 3 },
  { name: "Business Management", short: "Business Management", group: 3 },
  { name: "Psychology", short: "Psychology", group: 3 },
  { name: "Global Politics", short: "Global Politics", group: 3 },
  { name: "Philosophy", short: "Philosophy", group: 3 },
  { name: "Digital Society", short: "Digital Society", group: 3 },
  { name: "Environmental Systems and Societies", short: "ESS", group: 3 },
  { name: "Physics", short: "Physics", group: 4 },
  { name: "Chemistry", short: "Chemistry", group: 4 },
  { name: "Biology", short: "Biology", group: 4 },
  { name: "Computer Science", short: "Computer Science", group: 4 },
  { name: "Design Technology", short: "Design Technology", group: 4 },
  { name: "Sports, Exercise and Health Science", short: "SEHS", group: 4 },
  { name: "Mathematics: Analysis and Approaches", short: "Math AA", group: 5 },
  { name: "Mathematics: Applications and Interpretation", short: "Math AI", group: 5 },
  { name: "Visual Arts", short: "Visual Arts", group: 6 },
  { name: "Music", short: "Music", group: 6 },
  { name: "Theatre", short: "Theatre", group: 6 },
  { name: "Film", short: "Film", group: 6 },
];

/** The core: no levels, always available to the tutor. */
export const IB_CORE = ["Theory of Knowledge", "Extended Essay", "CAS"] as const;

export const IB_GROUP_NAMES: Record<number, string> = {
  1: "Language and literature", 2: "Language acquisition", 3: "Individuals and societies", 4: "Sciences", 5: "Mathematics", 6: "The arts",
};

const byName = new Map(IB_SUBJECTS.map((s) => [s.name, s]));

/** A student's saved selection, cleaned: known subjects only, one entry per subject, a valid level, at most 7 (six subjects and a spare). */
export function cleanIbSubjects(raw: unknown): IbSubject[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(); const out: IbSubject[] = [];
  for (const r of raw) {
    const name = typeof (r as any)?.name === "string" ? (r as any).name : "";
    const level: IbLevel = (r as any)?.level === "HL" ? "HL" : "SL";
    if (!byName.has(name) || seen.has(name)) continue;
    seen.add(name); out.push({ name, level });
    if (out.length >= 7) break;
  }
  return out;
}

/** What the tutor is told the subject is, with the level ("Math AA HL"). */
export function ibSessionSubject(s: IbSubject): string {
  const o = byName.get(s.name);
  return `${o?.short || s.name} ${s.level}`;
}

/** The subjects offered as chips on the tutor's start screen: the student's own, then the core. */
export function ibStartChips(mine: IbSubject[]): { label: string; subject: string }[] {
  const own = mine.map((s) => ({ label: `${byName.get(s.name)?.short || s.name} ${s.level}`, subject: ibSessionSubject(s) }));
  const core = IB_CORE.map((c) => ({ label: c === "Theory of Knowledge" ? "TOK" : c === "Extended Essay" ? "EE" : c, subject: c }));
  return [...own, ...core];
}

/** The HL/SL level of the subject being studied, read from the session subject string ("Physics HL" → "HL"). */
export function ibLevelOf(subject?: string): IbLevel | undefined {
  const m = /\b(HL|SL)\b/i.exec(String(subject || ""));
  return m ? (m[1].toUpperCase() as IbLevel) : undefined;
}
