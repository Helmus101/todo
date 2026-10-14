// The student's journal ("what I learned today", studylog tasks) as the tutor's and chats' MEMORY: every real daily entry is labelled
// by the subjects it talks about, and the ones that bear on the current subject / message come first.
import type { WebTask } from "../shared/types.ts";
import { subjectsIn } from "./tutor.ts";

interface JournalEntry { date: string; text: string; subjects: string[] }
interface JournalContext { entries: JournalEntry[]; total: number; subjects: Record<string, number> }

/** Real daily entries only (a `week:` / `month:` logDate is a rolled-up summary, not something they wrote). */
function journalTasks(list: WebTask[]): WebTask[] {
  return list.filter((x) => x.source === "studylog" && x.logDate && !x.logDate.startsWith("week:") && !x.logDate.startsWith("month:") && x.logText?.trim());
}
export { countJournalEntries } from "../shared/journalCount.ts";
const STOP = new Set("the and for that this with have from what when where which their there about would could should these those them they then than just also into your yours been were will shall cannot dont doesnt isnt arent les des une est pas que qui dans pour avec sur mais".split(" "));
const words = (t: string) => new Set((t.toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !STOP.has(w)));

/** Tags every entry with its subjects (the stored `logSubjects` when saved with the entry, else computed now), then ranks: entries labelled with
 *  the current subject first, then by word overlap with what's being said, then newest. Returns the best `limit` plus the overall picture. */
export function selectJournal(list: WebTask[], opts: { subject?: string; query?: string; known?: string[]; limit?: number }): JournalContext {
  const limit = opts.limit ?? 6;
  const all = journalTasks(list).map((t) => ({
    date: t.logDate!, text: t.logText!.trim(),
    subjects: (t.logSubjects?.length ? t.logSubjects : subjectsIn(t.logText!, opts.known)),
  })).sort((a, b) => b.date.localeCompare(a.date));
  const subjects: Record<string, number> = {};
  for (const e of all) for (const s of e.subjects) subjects[s] = (subjects[s] || 0) + 1;
  const subj = (opts.subject || "").toLowerCase();
  const q = words(opts.query || "");
  const scored = all.slice(0, 80).map((e, i) => {
    let score = 0;
    if (subj && (e.subjects.some((s) => s.toLowerCase() === subj) || e.text.toLowerCase().includes(subj))) score += 5;
    if (q.size) { const w = words(e.text); let hit = 0; for (const x of q) if (w.has(x)) hit++; score += Math.min(6, hit * 2); }
    return { e, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.e);
  // Nothing relevant? Still give the newest few, so the tutor knows how they've been doing.
  const entries = picked.length ? picked : all.slice(0, Math.min(3, limit));
  return { entries, total: all.length, subjects };
}
