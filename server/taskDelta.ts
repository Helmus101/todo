// Server half of the delta task lists — pure, so the round trip with client/taskDelta.ts is unit-tested.
export const fnv = (str: string): string => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6); };

/** Parse the client's `x-have` header: "<first 8 of task id><6-char hash>" entries joined by commas. */
export function parseHave(h: unknown): Map<string, string> | null {
  if (typeof h !== "string" || !h || h.length > 40_000) return null;
  const m = new Map<string, string>();
  for (const part of h.split(",")) if (part.length === 14) m.set(part.slice(0, 8), part.slice(8));
  return m.size ? m : null;
}

/** Hash of what a task IS, ignoring the two response-only overlays (score boost, nudge line) so routes that apply them
 *  and routes that don't never make a task look "changed" to each other. */
export const taskHash = (t: any): string => { const { score: _s, nudgeLine: _n, ...rest } = t; return fnv(JSON.stringify(rest)); };

/** The response body for a task-list route: the full tagged list when the client holds nothing (or too much), else only the
 *  tasks whose hash changed plus the id order. */
export function buildTasksPayload(outgoing: any[], haveHeader: unknown): any {
  const have = parseHave(haveHeader);
  const tagged = outgoing.map((t) => ({ t, h: taskHash(t) }));
  if (!have) return tagged.map(({ t, h }) => ({ ...t, _h: h }));
  const changed = tagged.filter(({ t, h }) => have.get(String(t.id).slice(0, 8).padEnd(8, "_")) !== h).map(({ t, h }) => ({ ...t, _h: h }));
  return { __delta: true, order: tagged.map(({ t, h }) => `${t.id}:${h}`), changed };
}
