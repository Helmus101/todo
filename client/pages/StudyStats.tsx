import { useMemo } from "react";
import { getTutorSessions, type TutorSessionSummary } from "../tutor/tutorSessions.ts";

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Everything below is computed from the sessions kept on THIS device: no server call, so it costs no database reads. */
export function computeStudyStats(sessions: TutorSessionSummary[], now = Date.now()) {
  const rows = sessions
    .map((s) => ({ start: Date.parse(s.startTime), end: Date.parse(s.endTime), subject: s.subject || "Other", messages: s.messageCount || 0 }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    // A tab left open overnight would count as hours: one session never counts for more than 3 hours.
    .map((r) => ({ ...r, minutes: Math.min(180, Math.round((r.end - r.start) / 60000)) }));
  const weekAgo = now - 7 * 86_400_000;
  const total = rows.reduce((n, r) => n + r.minutes, 0);
  const week = rows.filter((r) => r.start >= weekAgo);
  const bySubject = new Map<string, number>();
  for (const r of rows) bySubject.set(r.subject, (bySubject.get(r.subject) || 0) + r.minutes);
  const days = new Set(rows.map((r) => dayKey(r.start)));
  // Streak = consecutive days with a session, counting back from today (or from yesterday if today has none yet).
  let streak = 0;
  let t = days.has(dayKey(now)) ? now : now - 86_400_000;
  while (days.has(dayKey(t)) && streak < 1000) { streak++; t -= 86_400_000; }
  return {
    sessions: rows.length, totalMinutes: total,
    weekSessions: week.length, weekMinutes: week.reduce((n, r) => n + r.minutes, 0),
    avgMinutes: rows.length ? Math.round(total / rows.length) : 0,
    longest: rows.reduce((m, r) => Math.max(m, r.minutes), 0),
    activeDays: days.size, streak,
    subjects: [...bySubject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

export function StudyStatsSection({ userId }: { userId: string | null }) {
  const s = useMemo(() => computeStudyStats(getTutorSessions(userId)), [userId]);
  return (
    <section className="settings-sec reveal">
      <h3>{"Your study"}</h3>
      {s.sessions === 0 ? <p className="settings-hint">{"Your sessions will show up here after your first one."}</p> : (
        <div className="set-list">
          {([
            ["This week", `${hm(s.weekMinutes)} · ${s.weekSessions} session${s.weekSessions === 1 ? "" : "s"}`],
            ["All time", `${hm(s.totalMinutes)} · ${s.sessions} session${s.sessions === 1 ? "" : "s"}`],
            ["Average session", hm(s.avgMinutes)],
            ["Longest session", hm(s.longest)],
            ["Days studied", `${s.activeDays}${s.streak > 1 ? ` · ${s.streak}-day streak` : ""}`],
          ] as const).map(([k, v]) => (
            <div className="set-row" key={k}><span className="set-text">{k}</span><span className="usage-figure muted">{v}</span></div>
          ))}
          {s.subjects.map(([sub, m]) => (
            <div className="set-row" key={sub}><span className="set-text">{sub}</span><span className="usage-figure muted">{hm(m)}</span></div>
          ))}
          <p className="settings-hint">{"Counted from the sessions saved on this device."}</p>
        </div>
      )}
    </section>
  );
}
