import { useContext, useState } from "react";
import type { ArtifactState } from "../StudyTypes.ts";
import { LangContext, useLang } from "../../ui.tsx";

interface CitationArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

type Style = "apa" | "mla" | "chicago";

// One author as "Last, First" for APA/Chicago's inverted format — a plain "First Last" input is what a
// student actually types, so the inversion happens here rather than asking them to type it awkwardly.
function invertName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

// The citation's own fixed words and date format follow the STUDENT'S language, not the style's origin —
// a French student writing an APA bibliography writes "(s.d.)" and "Consulté le 6 octobre 2026".
function formatDate(iso: string, style: Style, en: boolean): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  const loc = en ? "en-US" : "fr-FR";
  if (style === "apa") return `(${d.getFullYear()}, ${d.toLocaleDateString(loc, { month: "long", day: "numeric" })})`;
  if (style === "mla") return d.toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
  return d.toLocaleDateString(loc, { month: "long", day: "numeric", year: "numeric" }); // chicago
}

function buildCitation(style: Style, f: { author: string; title: string; site: string; url: string; published: string; accessed: string }, en: boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const accessed = f.accessed || today;
  if (style === "apa") {
    const parts = [
      f.author ? `${invertName(f.author)}.` : "",
      f.published ? `${formatDate(f.published, "apa", en)}.` : (en ? "(n.d.)." : "(s.d.)."),
      f.title ? `${f.title}.` : "",
      f.site ? `${f.site}.` : "",
      f.url || "",
    ].filter(Boolean);
    return parts.join(" ");
  }
  if (style === "mla") {
    const parts = [
      f.author ? `${invertName(f.author)}.` : "",
      f.title ? `"${f.title}."` : "",
      f.site ? `${f.site},` : "",
      f.published ? `${formatDate(f.published, "mla", en)},` : "",
      f.url ? `${f.url}.` : "",
      `${en ? "Accessed" : "Consulté le"} ${formatDate(accessed, "mla", en)}.`,
    ].filter(Boolean);
    return parts.join(" ");
  }
  // Chicago (notes-bibliography style, web source)
  const parts = [
    f.author ? `${invertName(f.author)}.` : "",
    f.title ? `"${f.title}."` : "",
    f.site ? `${f.site}.` : "",
    f.published ? `${en ? "Published" : "Publié le"} ${formatDate(f.published, "chicago", en)}.` : "",
    f.url ? `${f.url}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

export function CitationArtifact({ artifact, onChange }: CitationArtifactProps) {
  const L = useLang();
  const uiEn = useContext(LangContext) === "en";
  const cs = artifact.contentState || {};
  const style = (cs.style as Style) || "apa";
  const author = (cs.author as string) || "";
  const title = (cs.title as string) || "";
  const site = (cs.site as string) || "";
  const url = (cs.url as string) || "";
  const published = (cs.published as string) || "";
  const accessed = (cs.accessed as string) || "";
  const [copied, setCopied] = useState(false);

  const set = (patch: Record<string, unknown>) => { setCopied(false); onChange({ ...cs, ...patch }); };
  const citation = buildCitation(style, { author, title, site, url, published, accessed }, uiEn);

  const copy = async () => {
    try { await navigator.clipboard.writeText(citation); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable — the text is still selectable/visible */ }
  };

  return (
    <div className="sm-citation-body">
      <div className="sm-citation-style-row">
        {(["apa", "mla", "chicago"] as Style[]).map((s) => (
          <button
            key={s}
            className={`sm-btn sm-btn-ghost sm-btn-sm ${style === s ? "active" : ""}`}
            onClick={() => set({ style: s })}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="sm-citation-fields">
        <input value={author} onChange={(e) => set({ author: e.target.value })} placeholder={L("Auteur (Prénom Nom)", "Author (First Last)")} />
        <input value={title} onChange={(e) => set({ title: e.target.value })} placeholder={L("Titre de la page/article", "Page/article title")} />
        <input value={site} onChange={(e) => set({ site: e.target.value })} placeholder={L("Nom du site ou de l'éditeur", "Site or publisher name")} />
        <input value={url} onChange={(e) => set({ url: e.target.value })} placeholder={L("URL", "URL")} />
        <label>
          {L("Publié le", "Published")}
          <input type="date" value={published} onChange={(e) => set({ published: e.target.value })} />
        </label>
        <label>
          {L("Consulté le", "Accessed")}
          <input type="date" value={accessed} onChange={(e) => set({ accessed: e.target.value })} placeholder={L("Aujourd'hui", "Today")} />
        </label>
      </div>

      <div className="sm-citation-output">
        <p>{citation || L("Remplis au moins un titre pour générer une citation.", "Fill in at least a title to generate a citation.")}</p>
        {citation && (
          <button className="sm-btn sm-btn-primary sm-btn-sm" onClick={copy}>{copied ? L("Copié !", "Copied!") : L("Copier", "Copy")}</button>
        )}
      </div>
      <p className="sm-citation-hint">{L("Généré — vérifie contre le guide de style exact de ta classe avant de rendre.", "Generated — double-check against your class's exact style guide before submitting.")}</p>
    </div>
  );
}
