// The IB exam session a student is aiming for ("2027-05" = the May 2027 session, "2026-11" = November 2026), and what that
// means for revision. The IB's exams run roughly from late April to late May and from late October to mid-November; the exact
// timetable is the school's, so every date here is approximate and the tutor says so.

export type ExamSession = string; // "YYYY-05" | "YYYY-11"

const MONTH_START = { "05": 4, "11": 10 } as const; // 0-based month the exams start in (May, November)

export const isExamSession = (v: unknown): v is ExamSession => typeof v === "string" && /^\d{4}-(05|11)$/.test(v);

/** The next few sessions to offer, starting with the first one that has not ended yet. */
export function examSessionOptions(now = new Date()): { value: ExamSession; label: string }[] {
  const out: { value: ExamSession; label: string }[] = [];
  for (let y = now.getUTCFullYear(); out.length < 5 && y < now.getUTCFullYear() + 4; y++) {
    for (const m of ["05", "11"] as const) {
      const value = `${y}-${m}`;
      const end = Date.UTC(y, MONTH_START[m] + 1, 1); // roughly the end of that month
      if (end > now.getTime()) out.push({ value, label: `${m === "05" ? "May" : "November"} ${y}` });
    }
  }
  return out.slice(0, 5);
}

/** Whole weeks until the exams start (about), never negative. null when they have already begun or ended. */
export function weeksToExams(session: ExamSession | undefined, now = new Date()): number | null {
  if (!isExamSession(session)) return null;
  const [y, m] = session.split("-") as [string, "05" | "11"];
  const start = Date.UTC(Number(y), MONTH_START[m], 1);
  const ms = start - now.getTime();
  return ms <= 0 ? null : Math.max(0, Math.round(ms / (7 * 86_400_000)));
}

/** One line for the tutor: how long is left and how to use it. Empty when no session is set or it is already under way. */
export function examLine(session: ExamSession | undefined, now = new Date()): string {
  if (!isExamSession(session)) return "";
  const [y, m] = session.split("-");
  const name = `${m === "05" ? "May" : "November"} ${y}`;
  const w = weeksToExams(session, now);
  if (w === null) return `EXAM SESSION: they sit the ${name} exams, which have started or passed (their school's timetable decides the exact dates). Keep sessions on exam technique, past papers and the weakest topics.`;
  const phase = w > 40 ? "a long way off: build understanding and the habit of doing questions, and do not cram"
    : w > 16 ? "far enough away to fix gaps properly: spend time on the weakest topics and start timed past-paper questions"
    : w > 6 ? "close: mostly past-paper questions and sections under timed conditions, marked against the mark scheme, with each lost mark traced to its cause"
    : "very close: full timed papers, a short list of the most mark-costly weaknesses, sleep and routine; no new big topics unless a paper exposes a gap";
  return `EXAM SESSION: they sit the ${name} exams, about ${w} week${w === 1 ? "" : "s"} away (dates are approximate; their school's timetable decides). That is ${phase}. Let this set how you choose what to practise next, and say the countdown only when it helps them decide, never to scare them.`;
}
