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
    catch (e: any) { notify(e?.message || "Couldn't search — try again.", "error"); }
    setBusy(false);
  };

  return (
    <main className="list-wrap exercises-page">
      <h1>{"Exercises"}</h1>
      <p className="muted">{"Questions pulled from your programme's sources. Pick a topic, then work the original."}</p>
      <form className="exercises-form" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={"Subject (e.g. Maths)"} aria-label={"Subject"} list="ex-subjects" />
        <datalist id="ex-subjects">{(subjects || []).map((s) => <option key={s} value={s} />)}</datalist>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={"Topic (e.g. sine rule)"} aria-label={"Topic"} />
        <button type="submit" className="btn primary" disabled={busy || !topic.trim()}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {res && !res.sources.length ? (
        <p className="muted">{"No registered sources for your programme. Set IB or AP in Settings."}</p>
      ) : null}
      {res && res.sources.length ? (
        <>
          <p className="muted small">{"Searched: "}{res.sources.map((s) => s.name).join(", ")}</p>
          {res.questions.length ? (
            <ol className="exercises-list">
              {res.questions.map((q) => (
                <li key={q.url}>
                  <h3><a href={q.url} target="_blank" rel="noopener noreferrer">{q.title || q.sourceName}</a> <span className="muted small">· {q.sourceName}</span></h3>
                  <p>{q.excerpt}</p>
                </li>
              ))}
            </ol>
          ) : <p className="muted">{"Nothing usable found for that topic. Try wording it more specifically."}</p>}
        </>
      ) : null}
    </main>
  );
}
