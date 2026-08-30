import { useState } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

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

function formatDate(iso: string, style: Style): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  if (style === "apa") return `(${d.getFullYear()}, ${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })})`;
  if (style === "mla") return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); // chicago
}

function buildCitation(style: Style, f: { author: string; title: string; site: string; url: string; published: string; accessed: string }): string {
  const today = new Date().toISOString().slice(0, 10);
  const accessed = f.accessed || today;
  if (style === "apa") {
    const parts = [
      f.author ? `${invertName(f.author)}.` : "",
      f.published ? `${formatDate(f.published, "apa")}.` : "(n.d.).",
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
      f.published ? `${formatDate(f.published, "mla")},` : "",
      f.url ? `${f.url}.` : "",
      `Accessed ${formatDate(accessed, "mla")}.`,
    ].filter(Boolean);
    return parts.join(" ");
  }
  // Chicago (notes-bibliography style, web source)
  const parts = [
    f.author ? `${invertName(f.author)}.` : "",
    f.title ? `"${f.title}."` : "",
    f.site ? `${f.site}.` : "",
    f.published ? `Published ${formatDate(f.published, "chicago")}.` : "",
    f.url ? `${f.url}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

export function CitationArtifact({ artifact, onChange }: CitationArtifactProps) {
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
  const citation = buildCitation(style, { author, title, site, url, published, accessed });

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
        <input value={author} onChange={(e) => set({ author: e.target.value })} placeholder="Author (First Last)" />
        <input value={title} onChange={(e) => set({ title: e.target.value })} placeholder="Page/article title" />
        <input value={site} onChange={(e) => set({ site: e.target.value })} placeholder="Site or publisher name" />
        <input value={url} onChange={(e) => set({ url: e.target.value })} placeholder="URL" />
        <label>
          Published
          <input type="date" value={published} onChange={(e) => set({ published: e.target.value })} />
        </label>
        <label>
          Accessed
          <input type="date" value={accessed} onChange={(e) => set({ accessed: e.target.value })} placeholder="Today" />
        </label>
      </div>

      <div className="sm-citation-output">
        <p>{citation || "Fill in at least a title to generate a citation."}</p>
        {citation && (
          <button className="sm-btn sm-btn-primary sm-btn-sm" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
        )}
      </div>
      <p className="sm-citation-hint">Generated — double-check against your class's exact style guide before submitting.</p>
    </div>
  );
}
