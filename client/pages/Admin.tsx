import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useLang, ErrorNote } from "../ui.tsx";


/** Standalone "Error log" tab (route /errorlog) — a student-maintained record of specific mistakes: what
 *  question tripped them up, what they got wrong, what to do next time. Separate from the journal's
 *  flashcards (that's "review this fact again"); this is closer to an exam-prep error journal, grouped by
 *  subject (errorLogBySubject, shared/types.ts — subjects with the most entries surface first, since that's
 *  where mistakes are piling up). Fetches its own profile copy rather than threading one down from
 *  Settings — this tab needs to work as a standalone destination, not only reachable via Settings. */
/** Admin-only usage dashboard. Access is enforced server-side (ADMIN_EMAILS); the client only hides the link. */
type AdminUserRow = { email: string; taskCount: number; completedTaskCount: number; tutorSessionCount: number; tutorMinutes: number; journalCount: number };

type AdminSortKey = "email" | "taskCount" | "completedTaskCount" | "tutorSessionCount" | "tutorMinutes" | "journalCount";

export function AdminPage() {
  const L = useLang();
  const [metrics, setMetrics] = useState<{ userCount: number; taskCount: number; completedTaskCount: number; tutorSessionCount: number; tutorMinutesTotal: number; journalCount: number; tasksBySource: Record<string, number>; byUser: AdminUserRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<AdminSortKey>("taskCount");
  const [sortDesc, setSortDesc] = useState(true);
  const toggleSort = (key: AdminSortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else { setSortKey(key); setSortDesc(true); }
  };
  const load = () => {
    setError(null);
    void api.adminMetrics().then(setMetrics).catch((e: any) => setError(e?.message || "Couldn't load metrics."));
  };
  useEffect(() => { load(); }, []);
  const cards: { label: [string, string]; value: string }[] = metrics ? [
    { label: ["Utilisateurs", "Users"], value: String(metrics.userCount) },
    { label: ["Tâches", "Tasks"], value: String(metrics.taskCount) },
    { label: ["Tâches terminées", "Tasks completed"], value: String(metrics.completedTaskCount) },
    { label: ["Séances de tuteur", "Tutor sessions"], value: String(metrics.tutorSessionCount) },
    { label: ["Minutes de tuteur (total)", "Tutor minutes (total)"], value: String(metrics.tutorMinutesTotal) },
    { label: ["Entrées de journal", "Journal entries"], value: String(metrics.journalCount) },
  ] : [];
  return (
    <main className="list-wrap">
      <h1 className="list-head">{"Admin"}</h1>
      {error ? (
        <ErrorNote onRetry={load}>{error}</ErrorNote>
      ) : !metrics ? (
        <p className="settings-hint">{"Loading…"}</p>
      ) : (
        <>
          <div className="admin-metric-grid">
            {cards.map((c, i) => (
              <div key={i} className="admin-metric-card">
                <span className="admin-metric-value">{c.value}</span>
                <span className="admin-metric-label">{c.label[1]}</span>
              </div>
            ))}
          </div>
          <section className="settings-sec mt-5">
            <h3>{"Tasks by source"}</h3>
            <div className="set-list">
              {Object.entries(metrics.tasksBySource).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                <div key={src} className="modal-row"><span className="lbl">{src}</span><span className="val">{n}</span></div>
              ))}
            </div>
          </section>
          <section className="settings-sec mt-5">
            <h3>{"By user"}</h3>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    {([
                      ["email", "Utilisateur", "User"],
                      ["taskCount", "Tâches", "Tasks"],
                      ["completedTaskCount", "Terminées", "Completed"],
                      ["tutorSessionCount", "Séances", "Sessions"],
                      ["tutorMinutes", "Minutes", "Minutes"],
                      ["journalCount", "Journal", "Journal"],
                    ] as [AdminSortKey, string, string][]).map(([key, fr, en]) => (
                      <th key={key} onClick={() => toggleSort(key)} className={sortKey === key ? "sorted" : ""}>
                        {en}{sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...metrics.byUser].sort((a, b) => {
                    const dir = sortDesc ? -1 : 1;
                    if (sortKey === "email") return dir * a.email.localeCompare(b.email);
                    return dir * (a[sortKey] - b[sortKey]);
                  }).map((u) => (
                    <tr key={u.email}>
                      <td className="admin-table-email">{u.email}</td>
                      <td>{u.taskCount}</td>
                      <td>{u.completedTaskCount}</td>
                      <td>{u.tutorSessionCount}</td>
                      <td>{u.tutorMinutes}</td>
                      <td>{u.journalCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
