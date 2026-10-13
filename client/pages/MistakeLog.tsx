import { useEffect, useState } from "react";
import type { Profile } from "../../shared/types.ts";
import { errorLogBySubject } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useLang, useNotify, ErrorNote } from "../ui.tsx";


/** Grows a textarea to fit its content on every keystroke, up to its CSS max-height (where overflow-y:auto
 *  takes over and it scrolls instead of growing forever) — pairs with .errorlog-textarea's small one-line
 *  min-height. Reset to "auto" before reading scrollHeight each time, or a textarea that's SHRUNK (deleted
 *  text) would stay stuck at its previous, taller height — scrollHeight only ever reports the content's
 *  actual size against the CURRENT height, not the natural one. */
function autoGrowTextarea(e: React.FormEvent<HTMLTextAreaElement>): void {
  const el = e.currentTarget;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function MistakeLogPage({ lang }: { lang?: "fr" | "en" }) {
  const L = useLang();
  const notify = useNotify();
  const en = lang === "en";
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [subject, setSubject] = useState("");
  const [question, setQuestion] = useState("");
  const [mistake, setMistake] = useState("");
  const [fix, setFix] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterSubject, setFilterSubject] = useState("");
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());
  // Same "don't silently drop a failed load" fix as SettingsPage's profileError/loadProfile — a failed
  // fetch used to just flip `loaded` true with `profile` still null, rendering the same "no mistakes yet"
  // empty state a genuinely-empty account gets, with no way to tell the two apart or retry.
  const [profileError, setProfileError] = useState(false);
  const loadProfile = () => { setProfileError(false); void api.profile().then((p) => { setProfile(p); setLoaded(true); }).catch(() => { setProfileError(true); setLoaded(true); }); };

  useEffect(loadProfile, []);

  const groups = errorLogBySubject(profile?.errorLog);
  const [expandAll, setExpandAll] = useState(false);
  const filteredGroups = filterSubject ? groups.filter(g => g.subject.toLowerCase().includes(filterSubject.toLowerCase())) : groups;

  const toggleExpandAll = () => {
    setExpandAll(!expandAll);
    if (!expandAll) {
      setExpandedSubjects(new Set(filteredGroups.map(g => g.subject)));
    } else {
      setExpandedSubjects(new Set());
    }
  };

  const toggleSubject = (subject: string) => {
    const newExpanded = new Set(expandedSubjects);
    if (newExpanded.has(subject)) {
      newExpanded.delete(subject);
    } else {
      newExpanded.add(subject);
    }
    setExpandedSubjects(newExpanded);
  };

  const add = async () => {
    const s = subject.trim(), q = question.trim();
    if (!s || !q) return;
    setSaving(true);
    try {
      const p = await api.addErrorLogEntry(s, q, mistake.trim(), fix.trim());
      setProfile(p); setQuestion(""); setMistake(""); setFix(""); setSubject("");
      setShowAddForm(false);
      setExpandedSubjects(new Set([s]));
    } catch (e: any) { notify(e?.message || L("Impossible d'ajouter cette erreur.", "Couldn't add that entry."), "error"); }
    finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    try { setProfile(await api.deleteErrorLogEntry(id)); }
    catch (e: any) { notify(e?.message || L("Impossible de supprimer cette entrée.", "Couldn't remove that entry."), "error"); }
  };

  const totalMistakes = groups.reduce((sum, g) => sum + g.entries.length, 0);

  return (
    <main className="list-wrap">
      <div className="dash-head">
        <div className="row-between">
          <h1 className="list-head">{L("Les erreurs que tu ne referas plus.", "The mistakes you won't make twice.")}</h1>
          <button className="btn primary" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? L("Fermer", "Close") : L("+ Ajouter", "+ Add")}
          </button>
        </div>
        <p className="page-sub mt-3">
          {totalMistakes > 0 ? (
            <>{totalMistakes} {totalMistakes === 1 ? L("erreur notée", "mistake logged") : L("erreurs notées", "mistakes logged")} · {groups.length} {groups.length === 1 ? L("matière", "subject") : L("matières", "subjects")}</>
          ) : (
            L("La question. Ce qui a mal tourné. Ce que tu essaieras la prochaine fois.", "The question. What went wrong. What you'll try next time.")
          )}
        </p>
      </div>

      {profileError ? (
        <ErrorNote onRetry={loadProfile}>{L("Certaines infos n'ont pas pu être chargées.", "Some info couldn't load.")}</ErrorNote>
      ) : null}

      {groups.length > 0 && (
        <div className="stack-3 mt-4">
          <input
            className="addinput mb-0"
            placeholder={L("Filtrer par matière...", "Filter by subject...")} aria-label={L("Filtrer par matière...", "Filter by subject...")}
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}
          />
          <div className="row-between">
            <p className="muted small">
              {filteredGroups.length} {filteredGroups.length === 1 ? L("résultat", "result") : L("résultats", "results")}
            </p>
            <button className="btn xs ghost" onClick={toggleExpandAll}>
              {expandAll ? L("Tout réduire", "Collapse all") : L("Tout développer", "Expand all")}
            </button>
          </div>
        </div>
      )}

      {showAddForm && (
        <div className="errorlog-addform">
          <div className="addrow">
            <input className="addinput sm" placeholder={L("ex : Physique", "e.g. Physics")} aria-label={L("ex : Physique", "e.g. Physics")} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={60} />
          </div>
          <textarea className="errorlog-textarea" rows={1} placeholder={L("La question ?", "What was the question?")} aria-label={L("La question ?", "What was the question?")} value={question} onChange={(e) => setQuestion(e.target.value)} onInput={autoGrowTextarea} maxLength={500} />
          <textarea className="errorlog-textarea" rows={1} placeholder={L("Ce qui a mal tourné ?", "What went wrong?")} aria-label={L("Ce qui a mal tourné ?", "What went wrong?")} value={mistake} onChange={(e) => setMistake(e.target.value)} onInput={autoGrowTextarea} maxLength={500} />
          <textarea className="errorlog-textarea" rows={1} placeholder={L("Ce que tu essaieras la prochaine fois ?", "What will you try next time?")} aria-label={L("Ce que tu essaieras la prochaine fois ?", "What will you try next time?")} value={fix} onChange={(e) => setFix(e.target.value)} onInput={autoGrowTextarea} maxLength={500} />
          <button type="button" className="btn primary" disabled={saving || !subject.trim() || !question.trim()} onClick={() => void add()}>
            {saving ? L("Enregistrement…", "Saving…") : L("Ajouter au journal", "Add to log")}
          </button>
        </div>
      )}

      {!loaded ? (
        <p className="muted small">{L("Récupération de ton journal…", "Pulling up your log…")}</p>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <h3>{L("Aucune erreur notée. Soit tu maîtrises, soit tu évites.", "No mistakes logged. Either you've mastered it or you're avoiding it.")}</h3>
          <p>{L("Note ta première erreur. C'est là que tu progresses vraiment.", "Log your first mistake. That's where you actually improve.")}</p>
          <button className="btn primary" onClick={() => setShowAddForm(true)}>{L("Ajouter une erreur", "Add a mistake")}</button>
        </div>
      ) : (
        <div className="errorlog-groups">
          {filteredGroups.map((g) => (
            <div key={g.subject} className="errorlog-group">
              <button type="button" className="errorlog-group-head" onClick={() => toggleSubject(g.subject)}>
                <span className="card-title">{g.subject}</span>
                <span className="card-sub">{g.entries.length} {g.entries.length === 1 ? L("erreur", "mistake") : L("erreurs", "mistakes")}</span>
              </button>
              {expandedSubjects.has(g.subject) ? (
                <ul className="errorlog-entries">
                  {g.entries.map((e) => (
                    <li key={e.id} className="errorlog-entry">
                      <div className="errorlog-entry-head">
                        <span className="muted">{new Date(e.createdAt).toLocaleDateString(en ? "en-GB" : "fr-FR", { day: "numeric", month: "short", year: "numeric" })}</span>
                        <button className="x" title={L("Supprimer", "Remove")} aria-label={L("Supprimer", "Remove")} onClick={() => void remove(e.id)}>×</button>
                      </div>
                      <p><strong>{L("Question : ", "Question: ")}</strong>{e.question}</p>
                      {e.mistake ? <p><strong>{L("Erreur : ", "Mistake: ")}</strong>{e.mistake}</p> : null}
                      {e.fix ? <p><strong>{L("À faire : ", "Next time: ")}</strong>{e.fix}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
