// Two board objects that suit every subject: a TABLE (a comparison, causes vs effects, determinants and their
// shifts, a truth table, a vocab list) and a SOURCE excerpt (a quote or primary source with the phrases that
// matter highlighted and annotated — close reading for history, literature, languages, philosophy).
// Validation is shared: the server checks what the model wrote, the client re-checks what it renders.

export interface TableSpec {
  headers: string[];
  rows: string[][];
  /** Recall practice: this column's cells are hidden until the student reveals them. */
  hideColumn?: number;
}

export interface SourceSpec {
  text: string;
  attribution?: string;
  /** Phrases quoted verbatim from `text`, each with a short note. */
  highlights: { phrase: string; note?: string }[];
}

const cell = (x: unknown, cap: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

export function normalizeTable(input: any): { table: TableSpec } | { error: string } {
  const headers = (Array.isArray(input?.headers) ? input.headers : []).map((h: unknown) => cell(h, 60)).slice(0, 5);
  if (headers.length < 2 || headers.some((h: string) => !h)) return { error: "ERROR: a table needs 2-5 non-empty `headers`." };
  const rows = (Array.isArray(input?.rows) ? input.rows : [])
    .filter((r: unknown) => Array.isArray(r))
    .map((r: unknown[]) => headers.map((_: string, i: number) => cell(r[i], 160)))
    .filter((r: string[]) => r.some(Boolean))
    .slice(0, 12);
  if (!rows.length) return { error: "ERROR: a table needs at least one row in `rows` (an array of arrays, one cell per header)." };
  const hide = Number.isInteger(input?.hideColumn) && input.hideColumn >= 0 && input.hideColumn < headers.length ? input.hideColumn : undefined;
  return { table: { headers, rows, ...(hide != null ? { hideColumn: hide } : {}) } };
}

export function normalizeSource(input: any): { source: SourceSpec } | { error: string } {
  const text = String(input?.text ?? "").trim().slice(0, 900);
  if (text.length < 10) return { error: "ERROR: a source needs the excerpt itself in `text`." };
  const highlights = (Array.isArray(input?.highlights) ? input.highlights : [])
    .map((h: any) => ({ phrase: cell(h?.phrase, 160), note: cell(h?.note, 160) }))
    .filter((h: { phrase: string }) => h.phrase && text.includes(h.phrase))
    .slice(0, 5)
    .map((h: { phrase: string; note: string }) => (h.note ? h : { phrase: h.phrase }));
  const attribution = cell(input?.attribution, 140);
  return { source: { text, ...(attribution ? { attribution } : {}), highlights } };
}

/** Split a source's text into plain and highlighted runs, in order (each highlight's first occurrence). */
export function sourceRuns(src: SourceSpec): { text: string; mark?: number }[] {
  const spots = src.highlights
    .map((h, i) => ({ i, at: src.text.indexOf(h.phrase), len: h.phrase.length }))
    .filter((s) => s.at >= 0)
    .sort((a, b) => a.at - b.at);
  const runs: { text: string; mark?: number }[] = [];
  let pos = 0;
  for (const s of spots) {
    if (s.at < pos) continue; // overlapping highlight: keep the earlier one
    if (s.at > pos) runs.push({ text: src.text.slice(pos, s.at) });
    runs.push({ text: src.text.slice(s.at, s.at + s.len), mark: s.i });
    pos = s.at + s.len;
  }
  if (pos < src.text.length) runs.push({ text: src.text.slice(pos) });
  return runs;
}
