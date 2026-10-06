import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { useLang, TaskModal } from "./ui.tsx";
import { setTutorLaunch } from "./courseLaunch.ts";
import { COURSE_CATALOG, courseProgress, nextUnit, unitState, type EnrolledCourse, type CourseTrack } from "../shared/courses.ts";
import "./courses.css";

const TRACK_LABEL: Record<CourseTrack, [string, string]> = {
  ib: ["IB Diploma", "IB Diploma"], bac: ["Baccalauréat", "Baccalauréat"], ap: ["AP", "AP"], other: ["Autres matières", "Other subjects"],
};
const pct = (x: number) => Math.round(x * 100);

function Ring({ value, size = 56 }: { value: number; size?: number }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r;
  return (
    <svg className="crs-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${pct(value)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="crs-ring-bg" />
      <circle cx={size / 2} cy={size / 2} r={r} className="crs-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="crs-ring-txt">{pct(value)}%</text>
    </svg>
  );
}

function Quiz({ course, unitId, onClose, onDone }: { course: EnrolledCourse; unitId: string; onClose: () => void; onDone: (c: EnrolledCourse[] | null) => void }) {
  const L = useLang();
  const unit = course.units.find((u) => u.id === unitId)!;
  const [qs, setQs] = useState<{ q: string; options: string[]; answer: number; why: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [right, setRight] = useState(0);
  const [done, setDone] = useState(false);
  const load = useCallback(() => {
    setErr(null); setQs(null);
    api.courseQuiz(course.id, unitId).then((r) => setQs(r.questions)).catch((e) => setErr(e?.status != null ? e.message : L("Impossible de charger le quiz.", "Couldn't load the quiz.")));
  }, [course.id, unitId, L]);
  useEffect(load, [load]);
  const finish = (score: number) => {
    setDone(true);
    api.courseQuizResult(course.id, unitId, score).then((p) => onDone(p.enrolledCourses || null)).catch(() => onDone(null));
  };
  const next = () => {
    if (!qs) return;
    if (i + 1 >= qs.length) finish(right / qs.length);
    else { setI(i + 1); setPicked(null); }
  };
  const q = qs?.[i];
  return (
    <TaskModal onClose={onClose} title={`${L("Quiz", "Quiz")} · ${unit.name}`}>
      <div className="crs-quiz">
        {err ? <><p className="crs-err">{err}</p><button className="btn primary" onClick={load}>{L("Réessayer", "Try again")}</button></>
          : !qs ? <p className="crs-muted">{L("Otto prépare tes questions…", "Otto is writing your questions…")}</p>
          : done ? (
            <div className="crs-quiz-done">
              <Ring value={right / qs.length} size={88} />
              <h3>{right / qs.length >= 0.8 ? L("Unité maîtrisée 🎉", "Unit mastered 🎉") : L("Bon début", "Good start")}</h3>
              <p className="crs-muted">{right}/{qs.length} — {right / qs.length >= 0.8 ? L("Cette unité compte comme solide.", "This unit now counts as solid.") : L("Atteins 80 % pour valider l'unité, ou continue avec le tuteur.", "Reach 80% to lock in the unit, or keep going with the tutor.")}</p>
              <button className="btn primary" onClick={onClose}>{L("Terminer", "Done")}</button>
            </div>
          ) : q && (
            <>
              <div className="crs-quiz-step">{i + 1} / {qs.length}</div>
              <h3 className="crs-quiz-q">{q.q}</h3>
              <div className="crs-opts" role="radiogroup">
                {q.options.map((o, k) => (
                  <button key={k} role="radio" aria-checked={picked === k} disabled={picked !== null}
                    className={`crs-opt ${picked !== null && k === q.answer ? "right" : ""} ${picked === k && k !== q.answer ? "wrong" : ""}`}
                    onClick={() => { setPicked(k); if (k === q.answer) setRight((n) => n + 1); }}>{o}</button>
                ))}
              </div>
              {picked !== null && (
                <div className="crs-why">
                  <p>{q.why}</p>
                  <button className="btn primary" onClick={next} autoFocus>{i + 1 >= qs.length ? L("Voir le résultat", "See result") : L("Suivant", "Next")}</button>
                </div>
              )}
            </>
          )}
      </div>
    </TaskModal>
  );
}

function CourseDetail({ course, onBack, onChange }: { course: EnrolledCourse; onBack: () => void; onChange: (c: EnrolledCourse[] | null) => void }) {
  const L = useLang();
  const [quizUnit, setQuizUnit] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const prog = courseProgress(course);
  const next = nextUnit(course);
  const study = (unitId: string) => { setTutorLaunch({ courseId: course.id, unitId }); window.history.pushState({}, "", "/tutor"); window.dispatchEvent(new PopStateEvent("popstate")); };
  const totalMin = Object.values(course.progress).reduce((n, p) => n + p.minutes, 0);
  const totalSessions = Object.values(course.progress).reduce((n, p) => n + p.sessions, 0);
  const label = (s: string) => (s === "solid" ? L("Solide", "Solid") : s === "started" ? L("En cours", "In progress") : L("À faire", "To do"));
  return (
    <>
      <button className="crs-back" onClick={onBack}>← {L("Mes cours", "My courses")}</button>
      <div className="crs-hero">
        <Ring value={prog} size={84} />
        <div className="crs-hero-main">
          <h2>{course.name}</h2>
          <p className="crs-muted">{[course.level, `${totalSessions} ${L("séances", totalSessions === 1 ? "session" : "sessions")}`, `${totalMin} min`].filter(Boolean).join(" · ")}</p>
        </div>
        {next && <button className="btn primary" onClick={() => study(next.id)}>{L("Continuer : ", "Continue: ")}{next.name}</button>}
      </div>
      <p className="crs-hint">{L("Toutes tes séances avec le tuteur sur cette matière comptent — Otto repère l'unité travaillée.", "Every tutor session on this subject counts — Otto spots which unit you covered.")}</p>
      <ol className="crs-units">
        {course.units.map((u, idx) => {
          const p = course.progress[u.id];
          const st = unitState(p);
          return (
            <li key={u.id} className={`crs-unit ${st}`}>
              <span className="crs-unit-dot" aria-hidden>{st === "solid" ? "✓" : idx + 1}</span>
              <div className="crs-unit-main">
                <div className="crs-unit-name">{u.name}</div>
                <div className="crs-unit-meta">{label(st)}{p ? ` · ${p.sessions} ${L("séance(s)", "session(s)")}${p.quizBest != null ? ` · quiz ${pct(p.quizBest)}%` : ""}` : ""}</div>
              </div>
              <button className="btn ghost" onClick={() => setQuizUnit(u.id)}>{L("Quiz", "Quiz")}</button>
              <button className="btn primary" onClick={() => study(u.id)}>{st === "new" ? L("Étudier", "Study") : L("Revoir", "Review")}</button>
            </li>
          );
        })}
      </ol>
      <div className="crs-danger">
        {confirmRemove
          ? <><span>{L("Retirer ce cours et sa progression ?", "Remove this course and its progress?")}</span>
              <button className="btn ghost" onClick={() => setConfirmRemove(false)}>{L("Annuler", "Cancel")}</button>
              <button className="btn" onClick={() => void api.courseRemove(course.id).then((p) => { onChange(p.enrolledCourses || []); onBack(); })}>{L("Retirer", "Remove")}</button></>
          : <button className="btn ghost" onClick={() => setConfirmRemove(true)}>{L("Ne plus suivre ce cours", "Stop following this course")}</button>}
      </div>
      {quizUnit && <Quiz course={course} unitId={quizUnit} onClose={() => setQuizUnit(null)} onDone={onChange} />}
    </>
  );
}

export function CoursesPage({ track }: { track?: CourseTrack }) {
  const L = useLang();
  const [courses, setCourses] = useState<EnrolledCourse[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api.profile().then((p) => setCourses(p.enrolledCourses || [])).catch(() => setCourses([])); }, []);
  const enrolledIds = useMemo(() => new Set((courses || []).map((c) => c.id)), [courses]);
  const enroll = async (body: { catalogId?: string; name?: string }) => {
    setBusy(body.catalogId || "custom"); setErr(null);
    try {
      const p = await api.courseEnroll(body);
      setCourses(p.enrolledCourses || []);
      setCustom("");
      if ((p.enrolledCourses || []).length) setAdding(false);
    } catch (e: any) { setErr(e?.status != null ? e.message : L("Impossible d'ajouter ce cours.", "Couldn't add that course.")); }
    finally { setBusy(null); }
  };
  if (!courses) return <main className="list-wrap crs"><p className="crs-muted">{L("Chargement…", "Loading…")}</p></main>;
  const open = courses.find((c) => c.id === openId);
  if (open) return <main className="list-wrap crs"><CourseDetail course={open} onBack={() => setOpenId(null)} onChange={(c) => c && setCourses(c)} /></main>;

  const showPicker = adding || courses.length === 0;
  const tracks: CourseTrack[] = track ? [track, ...(["ib", "bac", "ap", "other"] as CourseTrack[]).filter((t) => t !== track)] : ["ib", "bac", "ap", "other"];
  const overall = courses.length ? courses.reduce((n, c) => n + courseProgress(c), 0) / courses.length : 0;
  return (
    <main className="list-wrap crs">
      <div className="crs-head">
        <div>
          <h1 className="list-head">{L("Mes cours", "My courses")}</h1>
          <p className="crs-muted">{courses.length ? L("Choisis tes matières, avance avec le tuteur et vois ta progression.", "Pick your subjects, learn with the tutor, and watch your progress.") : L("Choisis les matières que tu suis — Otto t'y emmène pas à pas.", "Choose the subjects you take — Otto walks you through them step by step.")}</p>
        </div>
        {courses.length > 0 && !showPicker && <button className="btn primary" onClick={() => setAdding(true)}>+ {L("Ajouter un cours", "Add a course")}</button>}
      </div>

      {courses.length > 0 && (
        <>
          <div className="crs-summary"><Ring value={overall} size={64} /><div><strong>{L("Progression globale", "Overall progress")}</strong><div className="crs-muted">{courses.length} {L("cours suivis", courses.length === 1 ? "course followed" : "courses followed")}</div></div></div>
          <div className="crs-grid">
            {courses.map((c) => {
              const n = nextUnit(c);
              return (
                <button key={c.id} className="crs-card" onClick={() => setOpenId(c.id)}>
                  <Ring value={courseProgress(c)} />
                  <div className="crs-card-main">
                    <div className="crs-card-name">{c.name}</div>
                    <div className="crs-muted">{c.level ? `${c.level} · ` : ""}{c.units.filter((u) => unitState(c.progress[u.id]) === "solid").length}/{c.units.length} {L("unités solides", "units solid")}</div>
                    {n && <div className="crs-next">{L("Prochaine : ", "Next: ")}{n.name}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {showPicker && (
        <section className="crs-picker" aria-label={L("Catalogue de cours", "Course catalog")}>
          {courses.length > 0 && <div className="crs-picker-head"><h2>{L("Ajouter un cours", "Add a course")}</h2><button className="btn ghost" onClick={() => setAdding(false)}>{L("Fermer", "Close")}</button></div>}
          {err && <p className="crs-err" role="alert">{err}</p>}
          {tracks.map((t) => {
            const items = COURSE_CATALOG.filter((c) => c.track === t);
            return (
              <div key={t} className="crs-track">
                <h3>{L(TRACK_LABEL[t][0], TRACK_LABEL[t][1])}</h3>
                <div className="crs-chips">
                  {items.map((c) => (
                    <button key={c.id} className={`crs-chip ${enrolledIds.has(c.id) ? "on" : ""}`} disabled={enrolledIds.has(c.id) || busy !== null} onClick={() => void enroll({ catalogId: c.id })}>
                      {enrolledIds.has(c.id) ? "✓ " : "+ "}{c.name}{c.level ? <small> {c.level}</small> : null}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <form className="crs-custom" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void enroll({ name: custom.trim() }); }}>
            <label htmlFor="crs-custom">{L("Une autre matière ? Otto écrit le plan du cours.", "Another subject? Otto drafts the course outline.")}</label>
            <div className="crs-custom-row">
              <input id="crs-custom" value={custom} maxLength={80} placeholder={L("ex. Psychologie IB, Terminale Maths expertes…", "e.g. IB Psychology, A-level Further Maths…")} onChange={(e) => setCustom(e.target.value)} />
              <button className="btn primary" type="submit" disabled={!custom.trim() || busy !== null}>{busy === "custom" ? L("Création…", "Drafting…") : L("Créer", "Create")}</button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
