// Two small teaching visuals the tutor can ask for by name, drawn by code so they're always tidy and to scale:
// a NUMBER LINE (points, open/closed intervals — inequalities, rounding, negatives) and a BALANCE (an equation as a
// scale: what you do to one side you do to the other). SVG strings; the caller sanitises them like any figure.

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);

export interface NumberLineSpec { min?: number; max?: number; points?: { x: number; label?: string }[]; intervals?: { from: number; to: number; open?: boolean | "left" | "right" | "both" }[] }

export function buildNumberLine(spec: NumberLineSpec): { svg: string; facts: string } | { error: string } {
  const pts = (Array.isArray(spec?.points) ? spec.points : []).filter((p) => Number.isFinite(Number(p?.x))).slice(0, 8);
  const ivs = (Array.isArray(spec?.intervals) ? spec.intervals : []).filter((i) => Number.isFinite(Number(i?.from)) && Number.isFinite(Number(i?.to))).slice(0, 3);
  const xs = [...pts.map((p) => Number(p.x)), ...ivs.flatMap((i) => [Number(i.from), Number(i.to)])];
  let min = num(spec?.min, xs.length ? Math.floor(Math.min(...xs)) - 1 : -5);
  let max = num(spec?.max, xs.length ? Math.ceil(Math.max(...xs)) + 1 : 5);
  if (max <= min) { min = -5; max = 5; }
  if (max - min > 200) return { error: "ERROR: a number line spans at most 200 units — choose min/max closer to the points." };
  const W = 520, H = 90, L = 30, R = W - 30, Y = 50;
  const X = (v: number) => L + ((v - min) / (max - min)) * (R - L);
  const step = Math.max(1, Math.ceil((max - min) / 12));
  const ticks: string[] = [];
  for (let v = Math.ceil(min); v <= max; v += step) ticks.push(`<line x1="${X(v)}" y1="${Y - 5}" x2="${X(v)}" y2="${Y + 5}" stroke="currentColor"/><text x="${X(v)}" y="${Y + 20}" font-size="12" text-anchor="middle" fill="currentColor">${v}</text>`);
  const bands = ivs.map((i) => {
    const a = Math.min(Number(i.from), Number(i.to)), b = Math.max(Number(i.from), Number(i.to));
    const openL = i.open === true || i.open === "left" || i.open === "both", openR = i.open === true || i.open === "right" || i.open === "both";
    return `<line x1="${X(a)}" y1="${Y}" x2="${X(b)}" y2="${Y}" stroke="currentColor" stroke-width="5" opacity="0.55"/>` +
      `<circle cx="${X(a)}" cy="${Y}" r="6" fill="${openL ? "var(--surface, #fff)" : "currentColor"}" stroke="currentColor" stroke-width="2"/>` +
      `<circle cx="${X(b)}" cy="${Y}" r="6" fill="${openR ? "var(--surface, #fff)" : "currentColor"}" stroke="currentColor" stroke-width="2"/>`;
  });
  const marks = pts.map((p) => `<circle cx="${X(Number(p.x))}" cy="${Y}" r="5" fill="currentColor"/>${p.label ? `<text x="${X(Number(p.x))}" y="${Y - 14}" font-size="13" text-anchor="middle" fill="currentColor">${esc(String(p.label).slice(0, 12))}</text>` : ""}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><line x1="${L - 10}" y1="${Y}" x2="${R + 10}" y2="${Y}" stroke="currentColor" stroke-width="1.5"/>${ticks.join("")}${bands.join("")}${marks.join("")}</svg>`;
  const facts = `number line from ${min} to ${max}` + (pts.length ? `; points ${pts.map((p) => `${p.label || ""}${p.label ? "=" : ""}${p.x}`).join(", ")}` : "") + (ivs.length ? `; intervals ${ivs.map((i) => `${i.from}…${i.to}${i.open ? " (open ends)" : ""}`).join(", ")}` : "");
  return { svg, facts };
}

export interface BalanceSpec { left?: string[]; right?: string[] }

export function buildBalance(spec: BalanceSpec): { svg: string; facts: string } | { error: string } {
  const side = (x: unknown) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []).map((t) => String(t).replace(/\$/g, "").trim().slice(0, 14)).filter(Boolean).slice(0, 5);
  const left = side(spec?.left), right = side(spec?.right);
  if (!left.length || !right.length) return { error: "ERROR: a balance needs terms on both sides (left: [..], right: [..])." };
  const W = 520, H = 200, cx = W / 2;
  const pan = (terms: string[], x0: number) => terms.map((t, i) => {
    const w = Math.max(34, t.length * 9 + 14), x = x0 - (terms.length * 50) / 2 + i * 50 + 25 - w / 2;
    return `<rect x="${x}" y="${96 - 30}" width="${w}" height="26" rx="5" fill="none" stroke="currentColor"/><text x="${x + w / 2}" y="${96 - 12}" font-size="13" text-anchor="middle" fill="currentColor">${esc(t)}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<polygon points="${cx - 22},${H - 14} ${cx + 22},${H - 14} ${cx},${H - 60}" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<line x1="${cx}" y1="${H - 60}" x2="${cx}" y2="110" stroke="currentColor" stroke-width="2"/>` +
    `<line x1="${cx - 180}" y1="110" x2="${cx + 180}" y2="110" stroke="currentColor" stroke-width="3"/>` +
    `<line x1="${cx - 180}" y1="110" x2="${cx - 180}" y2="98" stroke="currentColor"/><line x1="${cx + 180}" y1="110" x2="${cx + 180}" y2="98" stroke="currentColor"/>` +
    `<line x1="${cx - 240}" y1="98" x2="${cx - 120}" y2="98" stroke="currentColor" stroke-width="2"/><line x1="${cx + 120}" y1="98" x2="${cx + 240}" y2="98" stroke="currentColor" stroke-width="2"/>` +
    pan(left, cx - 180) + pan(right, cx + 180) +
    `<text x="${cx}" y="${H - 64 - 6}" font-size="18" text-anchor="middle" fill="currentColor">=</text></svg>`;
  return { svg, facts: `balance: ${left.join(" + ")} on the left equals ${right.join(" + ")} on the right` };
}
