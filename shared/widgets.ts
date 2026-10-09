// Interactive widgets the tutor can put on the board (WIDGET_ON_BOARD). Unlike CREATE_INTERACTIVE (model-written
// HTML/JS in a sandbox, which can render blank), these are pre-built, tested components: the model only supplies
// CONTENT, the client renders it — so they always work, match the app's look, and can report back how it went.
// Pure + dependency-free so the server validates and the tests cover it.

export type WidgetSpec =
  | { type: "match"; pairs: { left: string; right: string }[] }
  | { type: "order"; items: string[] }
  | { type: "sort"; categories: string[]; items: { text: string; category: number }[] }
  | { type: "unit_circle"; angle: number }
  | { type: "projectile"; angle: number; speed: number; g: number };

export const WIDGET_TYPES = ["match", "order", "sort", "unit_circle", "projectile"] as const;

const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

export function normalizeWidget(input: any): { widget: WidgetSpec } | { error: string } {
  const type = String(input?.type || "");
  if (type === "match") {
    const pairs = (Array.isArray(input?.pairs) ? input.pairs : []).slice(0, 6)
      .map((p: any) => ({ left: str(p?.left, 80), right: str(p?.right, 120) }))
      .filter((p: { left: string; right: string }) => p.left && p.right);
    if (pairs.length < 3) return { error: "ERROR: a match widget needs `pairs`: 3-6 items like {left, right}." };
    if (new Set(pairs.map((p: { left: string }) => p.left.toLowerCase())).size !== pairs.length || new Set(pairs.map((p: { right: string }) => p.right.toLowerCase())).size !== pairs.length)
      return { error: "ERROR: every left and every right in a match must be distinct — otherwise two answers would be correct." };
    return { widget: { type, pairs } };
  }
  if (type === "order") {
    const items = (Array.isArray(input?.items) ? input.items : []).slice(0, 7).map((s: unknown) => str(s, 140)).filter(Boolean);
    if (items.length < 3) return { error: "ERROR: an order widget needs `items`: 3-7 steps/events listed in their CORRECT order (the student sees them shuffled)." };
    if (new Set(items.map((s: string) => s.toLowerCase())).size !== items.length) return { error: "ERROR: order items must be distinct." };
    return { widget: { type, items } };
  }
  if (type === "sort") {
    const categories = (Array.isArray(input?.categories) ? input.categories : []).slice(0, 4).map((s: unknown) => str(s, 40)).filter(Boolean);
    if (categories.length < 2) return { error: "ERROR: a sort widget needs `categories`: 2-4 names." };
    const items = (Array.isArray(input?.items) ? input.items : []).slice(0, 10)
      .map((i: any) => ({ text: str(i?.text, 100), category: Number(i?.category) }))
      .filter((i: { text: string; category: number }) => i.text && Number.isInteger(i.category) && i.category >= 0 && i.category < categories.length);
    if (items.length < 4) return { error: "ERROR: a sort widget needs `items`: 4-10 like {text, category} where category is the 0-based index into categories." };
    if (categories.some((_: string, ci: number) => !items.some((i: { category: number }) => i.category === ci))) return { error: "ERROR: every category needs at least one item." };
    return { widget: { type, categories, items } };
  }
  if (type === "unit_circle") return { widget: { type, angle: num(input?.angle, 0, 360, 30) } };
  if (type === "projectile") return { widget: { type, angle: num(input?.angle, 5, 85, 45), speed: num(input?.speed, 5, 60, 20), g: num(input?.g, 1, 25, 9.8) } };
  return { error: `ERROR: unknown widget type "${type}" — use one of: ${WIDGET_TYPES.join(", ")}.` };
}

/** Deterministic shuffle seeded by a string (so a re-render never reshuffles under the student's fingers). */
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** A shuffle that is guaranteed to differ from the input order (an "order" puzzle that starts solved is no puzzle). */
export function shuffledNotSolved<T>(arr: T[], seed: string): T[] {
  for (let k = 0; k < 6; k++) {
    const s = seededShuffle(arr, `${seed}#${k}`);
    if (s.some((x, i) => x !== arr[i])) return s;
  }
  return arr.slice(1).concat(arr[0]);
}

/** Projectile physics for the readout: range, max height, flight time (flat ground, no drag). */
export function projectileStats(angleDeg: number, speed: number, g: number) {
  const a = (angleDeg * Math.PI) / 180;
  const vx = speed * Math.cos(a), vy = speed * Math.sin(a);
  const t = (2 * vy) / g;
  return { range: vx * t, height: (vy * vy) / (2 * g), time: t };
}
