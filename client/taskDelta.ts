// Client half of the delta task lists (server/index.ts's tasksPayload). The server tags every task with a short content hash;
// we remember task+hash, send back "<id8><hash6>,…" as `x-have`, and the server answers with only what changed plus the id
// order. `expand` turns ANY of the three shapes (full tagged list, delta, plain list) back into a normal task array, so the
// rest of the app never knows. The store only ever grows between sign-outs (never deletes on update) so two overlapping
// responses can't leave a delta pointing at a task we dropped.
type Tagged = { id: string; _h?: string; [k: string]: any };

export function makeTaskSync() {
  const store = new Map<string, Tagged>();
  const hashes = new Map<string, string>();
  const remember = (t: Tagged) => { const { _h, ...rest } = t; store.set(t.id, rest as Tagged); if (_h) hashes.set(t.id, _h); return rest as Tagged; };
  return {
    /** Value for the `x-have` request header, or "" when a delta isn't worthwhile. */
    haveHeader(): string {
      if (!store.size || store.size > 300) return "";
      const parts: string[] = [];
      for (const [id, h] of hashes) if (store.has(id)) parts.push(id.slice(0, 8).padEnd(8, "_") + h);
      return parts.length ? parts.join(",") : "";
    },
    /** Expand a response body. Returns the input untouched when it isn't a task list. */
    expand(json: any): any {
      if (json && typeof json === "object" && json.__delta === true && Array.isArray(json.order) && Array.isArray(json.changed)) {
        const changed = new Map<string, Tagged>();
        for (const t of json.changed) changed.set(t.id, remember(t));
        const out: Tagged[] = [];
        for (const entry of json.order as string[]) {
          const i = entry.lastIndexOf(":");
          const id = entry.slice(0, i), h = entry.slice(i + 1);
          const t = changed.get(id) || store.get(id);
          if (!t) throw new Error("task delta referenced a task we don't have");
          hashes.set(id, changed.has(id) ? hashes.get(id) || h : h);
          out.push(t);
        }
        return out;
      }
      if (Array.isArray(json) && json.length && json.every((t) => t && typeof t === "object" && typeof t.id === "string" && typeof t._h === "string")) {
        return json.map((t) => remember(t));
      }
      return json;
    },
    reset() { store.clear(); hashes.clear(); },
    size: () => store.size,
  };
}
export const taskSync = makeTaskSync();
