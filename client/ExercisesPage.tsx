import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useLang, useNotify } from "./ui.tsx";

type Q = { sourceName: string; url: string; title: string; excerpt: string };

/** Exercises (route /exercises — deliberately NOT in the navbar): practice questions pulled from the registered sources for
 *  the student's programme (IB / AP), each with a link to the original. Shows which sources are searched. */
export function ExercisesPage() {
  const L = useLang();
  const notify = useNotify();
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ track: string | null; sources: { name: string; host: string }[]; questions: Q[] } | null>(null);

  useEffect(() => { void api.profile().then((p) => { setSubjects(p.subjects || []); setSubject((cur) => cur || (p.subjects || [])[0] || ""); }).catch(() => {}); }, []);

  const search = async () => {
    if (busy || !topic.trim()) return;
    setBusy(true);
    try { { const r = await api.exerciseSearch(topic.trim(), subject.trim() || undefined); setRes({ track: r?.track ?? null, sources: r?.sources || [], questions: r?.questions || [] }); }; }
    catch (e: any) { notify(e?.message || L("Recherche impossible — réessaie.", "Couldn't search — try again."), "error"); }
    setBusy(false);
  };

  return (
    <main className="list-wrap exercises-page">
      <h1>{L("Exercices", "Exercises")}</h1>
      <p className="muted">{L("Des questions tirées des sources de ton programme. Choisis un sujet, puis travaille l'original.", "Questions pulled from your programme's sources. Pick a topic, then work the original.")}</p>
      <form className="exercises-form" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={L("Matière (ex : Maths)", "Subject (e.g. Maths)")} aria-label={L("Matière", "Subject")} list="ex-subjects" />
        <datalist id="ex-subjects">{(subjects || []).map((s) => <option key={s} value={s} />)}</datalist>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={L("Sujet (ex : règle des sinus)", "Topic (e.g. sine rule)")} aria-label={L("Sujet", "Topic")} />
        <button type="submit" className="btn primary" disabled={busy || !topic.trim()}>{busy ? L("Recherche…", "Searching…") : L("Chercher", "Search")}</button>
      </form>
      {res && !res.sources.length ? (
        <p className="muted">{L("Aucune source enregistrée pour ton programme. Choisis IB ou AP dans les Réglages.", "No registered sources for your programme. Set IB or AP in Settings.")}</p>
      ) : null}
      {res && res.sources.length ? (
        <>
          <p className="muted small">{L("Sources cherchées : ", "Searched: ")}{res.sources.map((s) => s.name).join(", ")}</p>
          {res.questions.length ? (
            <ol className="exercises-list">
              {res.questions.map((q) => (
                <li key={q.url}>
                  <h3><a href={q.url} target="_blank" rel="noopener noreferrer">{q.title || q.sourceName}</a> <span className="muted small">· {q.sourceName}</span></h3>
                  <p>{q.excerpt}</p>
                </li>
              ))}
            </ol>
          ) : <p className="muted">{L("Rien d'utilisable trouvé pour ce sujet. Reformule-le plus précisément.", "Nothing usable found for that topic. Try wording it more specifically.")}</p>}
        </>
      ) : null}
    </main>
  );
}
