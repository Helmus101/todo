// Coursework — documents a student uploads PER SUBJECT (worksheets, syllabi, lecture notes, past papers). Only a
// bounded slice is ever read (the first few pages, capped characters) and distilled to a short summary + key
// points the tutor and chat can cite; the full file never leaves the device.

/** The subjects offered everywhere a subject is picked (tutor start, coursework upload). One list so the two
 *  can't drift. */
export const COMMON_SUBJECTS = [
  "Math", "Physics", "Chemistry", "Biology", "History",
  "English", "French", "Spanish", "Geography", "Economics",
  "Philosophy", "Computer Science", "Art", "Music", "Other",
] as const;

/** Reading limits — enforced in the browser before upload AND re-enforced server-side. */
export const COURSEWORK_MAX_PAGES = 15;
export const COURSEWORK_MAX_CHARS = 30_000;
export const COURSEWORK_MAX_DOCS = 60;

export interface CourseworkDoc {
  id: string;
  subject: string;
  name: string;
  /** Plain-language summary (≤ ~110 words) the tutor/chat can cite. */
  summary: string;
  keyPoints?: string[];
  /** The first ~1500 characters of what was read, kept so the tutor can quote exact wording. */
  excerpt: string;
  /** Pages actually read / total pages when known (PDF). */
  pages: number;
  totalPages?: number;
  /** True when the document was longer than the reading limits and only its start was read. */
  truncated?: boolean;
  addedAt: string;
  /** Tasks generated from this document, if it contained assignments/deadlines. */
  taskIds?: string[];
}

const ALIASES: Record<string, string[]> = {
  math: ["math", "maths", "mathematiques", "mathematics", "calculus", "algebra", "algebre", "geometry", "geometrie"],
  physics: ["physics", "physique", "physique chimie", "pc"],
  chemistry: ["chemistry", "chimie"],
  biology: ["biology", "biologie", "svt", "bio", "sciences de la vie"],
  history: ["history", "histoire", "histoire geographie", "hggsp", "histoire geo"],
  geography: ["geography", "geographie", "geo"],
  english: ["english", "anglais", "litterature anglaise"],
  french: ["french", "francais", "lettres", "litterature"],
  spanish: ["spanish", "espagnol"],
  economics: ["economics", "economie", "ses", "sciences economiques et sociales"],
  philosophy: ["philosophy", "philosophie", "philo"],
  "computer science": ["computer science", "informatique", "nsi", "cs", "programming"],
  art: ["art", "arts", "arts plastiques"],
  music: ["music", "musique"],
};

const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** A canonical key for a free-text subject ("Maths", "Mathématiques" → "math"); unknown subjects keep their own
 *  normalized text so custom subjects still group with themselves. */
export function canonSubject(s: string): string {
  const n = norm(s);
  if (!n) return "";
  for (const [canon, list] of Object.entries(ALIASES)) if (list.includes(n)) return canon;
  for (const [canon, list] of Object.entries(ALIASES)) if (list.some((a) => a.length > 3 && n.includes(a))) return canon;
  return n;
}

export function sameSubject(a: string | undefined, b: string | undefined): boolean {
  const x = canonSubject(a || ""), y = canonSubject(b || "");
  return !!x && !!y && x === y;
}

/** Clean up whatever comes out of storage / a request body. */
export function normalizeCoursework(raw: any): CourseworkDoc[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CourseworkDoc[] = [];
  for (const d of raw.slice(0, COURSEWORK_MAX_DOCS)) {
    const id = typeof d?.id === "string" ? d.id.slice(0, 60) : "";
    const subject = String(d?.subject || "").trim().slice(0, 60);
    const name = String(d?.name || "").trim().slice(0, 140);
    if (!id || !subject || !name) continue;
    out.push({
      id, subject, name,
      summary: String(d?.summary || "").trim().slice(0, 900),
      keyPoints: Array.isArray(d?.keyPoints) ? d.keyPoints.map((k: any) => String(k).trim().slice(0, 160)).filter(Boolean).slice(0, 6) : undefined,
      excerpt: String(d?.excerpt || "").slice(0, 1600),
      pages: Math.max(0, Math.min(999, Math.round(Number(d?.pages) || 0))),
      totalPages: Number(d?.totalPages) > 0 ? Math.min(9999, Math.round(Number(d.totalPages))) : undefined,
      truncated: d?.truncated === true ? true : undefined,
      addedAt: typeof d?.addedAt === "string" ? d.addedAt : new Date().toISOString(),
      taskIds: Array.isArray(d?.taskIds) ? d.taskIds.map((t: any) => String(t).slice(0, 60)).slice(0, 5) : undefined,
    });
  }
  return out;
}

/** The documents for one subject, newest first. */
export function courseworkForSubject(docs: CourseworkDoc[] | undefined, subject: string | undefined): CourseworkDoc[] {
  return (docs || []).filter((d) => sameSubject(d.subject, subject)).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}
