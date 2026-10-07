import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import { useLang, useNotify } from "./ui.tsx";
import { extractPdfTextLimited } from "./study/pdfText.ts";
import { COMMON_SUBJECTS, COURSEWORK_MAX_CHARS, COURSEWORK_MAX_PAGES, canonSubject, type CourseworkDoc } from "../shared/coursework.ts";

type Job = { id: number; name: string; state: "reading" | "summarizing" | "done" | "error"; note?: string };
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,text/plain,text/markdown,.md,.txt,.csv";

/** Coursework (route /coursework): upload the documents your class actually uses, PER SUBJECT. Otto reads only the
 *  first few pages (hard limit, shown to the student), summarises them and keeps the summary — so the tutor and the
 *  chat can refer to "your worksheet on …" — and, when the document sets work, turns it into tasks. */
export function Coursework({ onTasksChanged }: { onTasksChanged?: () => void }) {
  const L = useLang();
  const notify = useNotify();
  const [docs, setDocs] = useState<CourseworkDoc[] | null>(null);
  const [mine, setMine] = useState<string[]>([]);
  const [subject, setSubject] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const jobId = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void api.profile().then((p) => { setDocs(p.coursework || []); setMine(p.subjects || []); }).catch(() => setDocs([])); }, []);

  const effectiveSubject = subject === "Other" ? custom.trim() : subject;
  const subjectsInUse = useMemo(() => [...new Set((docs || []).map((d) => d.subject))], [docs]);
  const chips = useMemo(() => {
    const common = COMMON_SUBJECTS.filter((s) => s !== "Other") as string[];
    // The student's own subjects first, then the common list, then anything else already in use.
    const base = [...new Set<string>([...mine, ...common])];
    const extra = subjectsInUse.filter((s) => !base.some((b) => canonSubject(b) === canonSubject(s)));
    return [...base, ...extra, "Other"];
  }, [subjectsInUse, mine]);

  const setJob = (id: number, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const readFile = async (file: File): Promise<{ text: string; pages: number; totalPages?: number; truncated: boolean }> => {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return extractPdfTextLimited(file, COURSEWORK_MAX_PAGES, COURSEWORK_MAX_CHARS);
    if (file.type.startsWith("image/")) {
      const dataUrl: string = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
      const { description } = await api.readPhoto(dataUrl);
      return { text: description.slice(0, COURSEWORK_MAX_CHARS), pages: 1, truncated: false };
    }
    const raw = await file.text();
    return { text: raw.slice(0, COURSEWORK_MAX_CHARS), pages: 1, truncated: raw.length > COURSEWORK_MAX_CHARS };
  };

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!effectiveSubject) { notify(L("Choisis d'abord la matière.", "Pick the subject first."), "error"); return; }
    for (const file of Array.from(files).slice(0, 5)) {
      const id = ++jobId.current;
      setJobs((js) => [{ id, name: file.name, state: "reading" as const }, ...js].slice(0, 8));
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error(L("Fichier trop lourd (25 Mo max).", "File too big (25 MB max)."));
        const read = await readFile(file);
        if (read.text.trim().length < 40) throw new Error(L("Aucun texte lisible (page scannée ?). Essaie une photo nette ou un PDF avec texte.", "No readable text (a scanned page?). Try a clear photo or a PDF with a text layer."));
        setJob(id, { state: "summarizing" });
        const r = await api.uploadCoursework({ subject: effectiveSubject, name: file.name.replace(/\.[a-z0-9]+$/i, ""), text: read.text, pages: read.pages, totalPages: read.totalPages, truncated: read.truncated });
        setDocs(r.profile.coursework || []);
        setJob(id, { state: "done", note: r.tasks.length ? L(`${r.tasks.length} tâche(s) créée(s)`, `${r.tasks.length} task(s) created`) : undefined });
        if (r.tasks.length) onTasksChanged?.();
      } catch (e: any) {
        setJob(id, { state: "error", note: e?.message || L("Échec de l'envoi.", "Upload failed.") });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSubject, L, notify, onTasksChanged]);

  const remove = async (id: string) => {
    try { setDocs((await api.deleteCoursework(id)).coursework || []); }
    catch { notify(L("Impossible de supprimer — réessaie.", "Couldn't remove it — try again."), "error"); }
  };

  const shown = (docs || []).filter((d) => filter === "all" || canonSubject(d.subject) === canonSubject(filter));
  const grouped = useMemo(() => {
    const m = new Map<string, CourseworkDoc[]>();
    for (const d of shown) { const k = d.subject; m.set(k, [...(m.get(k) || []), d]); }
    return [...m.entries()];
  }, [shown]);

  return (
    <main className="list-wrap cw">
      <h1 className="list-head">{L("Cours", "Coursework")}</h1>
      <p className="cw-sub">{L("Ajoute ce que ta classe utilise : fiches, chapitres, énoncés. Otto lit les premières pages, en fait un résumé, et s'y réfère dans le chat et avec le tuteur.", "Add what your class uses: worksheets, chapters, briefs. Otto reads the first pages, summarizes them, and refers to them in chat and with the tutor.")}</p>

      <section className="cw-upload" aria-label={L("Ajouter un document", "Add a document")}>
        <div className="cw-step"><span className="cw-num">1</span>{L("Matière", "Subject")}</div>
        <div className="cw-chips" role="radiogroup" aria-label={L("Matière", "Subject")}>
          {chips.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={subject === s} className={`cw-chip${subject === s ? " on" : ""}`} onClick={() => setSubject(s)}>{s === "Other" ? L("Autre…", "Other…") : s}</button>
          ))}
        </div>
        {subject === "Other" && <input className="cw-custom" value={custom} maxLength={60} placeholder={L("Nom de la matière", "Subject name")} onChange={(e) => setCustom(e.target.value)} autoFocus />}

        <div className="cw-step"><span className="cw-num">2</span>{L("Document", "Document")}</div>
        <div
          className={`cw-drop${drag ? " over" : ""}${effectiveSubject ? "" : " disabled"}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void handleFiles(e.dataTransfer.files); }}
        >
          <p>{effectiveSubject ? L(`Dépose des fichiers pour « ${effectiveSubject} »`, `Drop files for “${effectiveSubject}”`) : L("Choisis une matière pour commencer", "Pick a subject to start")}</p>
          <button type="button" className="btn primary" disabled={!effectiveSubject} onClick={() => fileRef.current?.click()}>{L("Choisir des fichiers", "Choose files")}</button>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); e.target.value = ""; }} />
          <small>{L(`PDF, photo ou texte · Otto lit les ${COURSEWORK_MAX_PAGES} premières pages (≈ ${Math.round(COURSEWORK_MAX_CHARS / 1000)} 000 caractères) · le fichier reste sur ton appareil`, `PDF, photo or text · Otto reads the first ${COURSEWORK_MAX_PAGES} pages (≈ ${Math.round(COURSEWORK_MAX_CHARS / 1000)},000 characters) · the file itself stays on your device`)}</small>
        </div>
        {jobs.length > 0 && (
          <ul className="cw-jobs" aria-live="polite">
            {jobs.map((j) => (
              <li key={j.id} className={j.state}>
                <span className="cw-job-name">{j.name}</span>
                <span className="cw-job-state">
                  {j.state === "reading" ? L("Lecture…", "Reading…") : j.state === "summarizing" ? L("Résumé…", "Summarizing…") : j.state === "done" ? `✓ ${j.note || L("Ajouté", "Added")}` : j.note}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cw-library" aria-label={L("Mes documents", "My documents")}>
        <div className="cw-lib-head">
          <h2>{L("Mes documents", "My documents")}</h2>
          {subjectsInUse.length > 1 && (
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={L("Filtrer par matière", "Filter by subject")}>
              <option value="all">{L("Toutes les matières", "All subjects")}</option>
              {subjectsInUse.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
        {docs === null ? <p className="cw-muted">{L("Chargement…", "Loading…")}</p>
          : grouped.length === 0 ? <p className="cw-empty">{L("Rien ici pour l'instant. Ajoute un document : le tuteur pourra s'en servir tout de suite.", "Nothing here yet. Add a document — the tutor can use it right away.")}</p>
          : grouped.map(([subj, list]) => (
            <div key={subj} className="cw-group">
              <h3 className="cw-subject">{subj}<span>{list.length}</span></h3>
              {list.map((d) => (
                <article key={d.id} className="cw-doc">
                  <header>
                    <h4>{d.name}</h4>
                    <button type="button" className="cw-del" onClick={() => void remove(d.id)} aria-label={L(`Supprimer ${d.name}`, `Remove ${d.name}`)}>✕</button>
                  </header>
                  <p className="cw-meta">{d.truncated ? L(`Pages 1–${d.pages}${d.totalPages ? ` sur ${d.totalPages}` : ""} lues`, `Read pages 1–${d.pages}${d.totalPages ? ` of ${d.totalPages}` : ""}`) : L("Lu en entier", "Read in full")}{d.taskIds?.length ? ` · ${L(`${d.taskIds.length} tâche(s) créée(s)`, `${d.taskIds.length} task(s) created`)}` : ""}</p>
                  <p className="cw-summary">{d.summary}</p>
                  {d.keyPoints?.length ? <ul className="cw-points">{d.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul> : null}
                  <a className="cw-ask" href="/tutor">{L("Étudier avec le tuteur →", "Study this with the tutor →")}</a>
                </article>
              ))}
            </div>
          ))}
      </section>
    </main>
  );
}
