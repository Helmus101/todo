// A safety net for "I marked it done and it came back". Whatever the cause (a lost cloud write, a stale copy on another server
// instance, a response that never arrived), a task the student finished or dismissed is remembered on THIS device until the server
// has shown it handled. Until then, a copy that comes back open is shown as handled again and the confirmation is re-sent.
// Pure functions plus a thin localStorage wrapper, so the rules are testable.
import type { WebTask } from "../shared/types.ts";
import { isHandled } from "../shared/types.ts";

export type PendingHandled = Record<string, { status: "done" | "dismissed"; at: number }>;
export const PENDING_TTL_MS = 24 * 3_600_000;

const key = (user: string | null | undefined) => `otto-pending-handled:${user || "anon"}`;
export function loadPendingHandled(user: string | null | undefined): PendingHandled {
  try { const v = JSON.parse(localStorage.getItem(key(user)) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function savePendingHandled(user: string | null | undefined, p: PendingHandled): void {
  try { if (Object.keys(p).length) localStorage.setItem(key(user), JSON.stringify(p)); else localStorage.removeItem(key(user)); } catch { /* private mode: the in-memory guards still apply */ }
}

/** Reconcile a list from the server against what this device finished. `heal` lists the tasks the server still shows open (re-send the
 *  confirmation for these); `pending` is the map with entries removed once the server shows them handled, a task is gone, or they expired. Pure. */
export function applyPendingHandled(list: WebTask[], pending: PendingHandled, now: number): { list: WebTask[]; pending: PendingHandled; heal: { id: string; status: "done" | "dismissed" }[] } {
  const next: PendingHandled = {};
  const heal: { id: string; status: "done" | "dismissed" }[] = [];
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const [id, p] of Object.entries(pending)) {
    if (!p || now - p.at > PENDING_TTL_MS) continue;
    const t = byId.get(id);
    if (!t) continue; // pruned or deleted: nothing left to heal
    if (isHandled(t.status)) continue; // the server agrees: done with it
    next[id] = p; heal.push({ id, status: p.status });
  }
  const out = list.map((t) => (next[t.id] ? { ...t, status: next[t.id].status, updatedAt: new Date(now).toISOString() } as WebTask : t));
  return { list: out, pending: next, heal };
}
