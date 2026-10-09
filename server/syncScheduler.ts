// Write-behind for the account row. Every mutating request used to rewrite the WHOLE profile+tasks blob to Supabase (and, for the
// "high-value" ones, read it back first). A student ticking steps or reviewing 40 flashcards in a minute caused 40 full writes.
// This coalesces them: the latest snapshot per account is held in memory and written ONCE after a quiet period (or at the latest
// after `maxWaitMs`), `flush` writes it immediately (journal saves, tab hidden, shutdown). Pure of any I/O — the writer is injected.
export interface SyncSnapshot<T = unknown> { tasks: T; profile: unknown }
export interface Scheduler<T = unknown> {
  schedule(key: string, snap: SyncSnapshot<T>): void;
  /** Write the pending snapshot for `key` now (optionally with a fresher one); resolves when written. */
  flush(key: string, snap?: SyncSnapshot<T>): Promise<void>;
  flushAll(): Promise<void>;
  /** Forget a pending snapshot (a direct write just superseded it). */
  cancel(key: string): void;
  pending(): number;
}

export function makeSyncScheduler<T = unknown>(
  write: (key: string, snap: SyncSnapshot<T>) => Promise<void>,
  opts: { debounceMs?: number; maxWaitMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void; now?: () => number } = {},
): Scheduler<T> {
  const debounceMs = opts.debounceMs ?? 8000, maxWaitMs = opts.maxWaitMs ?? 30000;
  const setT = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; });
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t as any));
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { snap: SyncSnapshot<T>; timer: unknown; firstAt: number; inflight?: Promise<void> }>();

  const run = (key: string): Promise<void> => {
    const e = entries.get(key);
    if (!e) return Promise.resolve();
    clearT(e.timer);
    entries.delete(key);
    const p = write(key, e.snap).catch(() => {
      // Keep the data: put the snapshot back (unless a newer one arrived) and try again after another quiet period.
      if (!entries.has(key)) { entries.set(key, { snap: e.snap, timer: setT(() => void run(key), debounceMs * 2), firstAt: now() }); }
    });
    return p;
  };
  return {
    schedule(key, snap) {
      const e = entries.get(key);
      if (e) {
        e.snap = snap;
        clearT(e.timer);
        const wait = Math.max(0, Math.min(debounceMs, maxWaitMs - (now() - e.firstAt)));
        e.timer = setT(() => void run(key), wait);
      } else {
        entries.set(key, { snap, timer: setT(() => void run(key), debounceMs), firstAt: now() });
      }
    },
    async flush(key, snap) {
      if (snap) {
        const e = entries.get(key);
        if (e) e.snap = snap; else entries.set(key, { snap, timer: setT(() => {}, 0), firstAt: now() });
      }
      await run(key);
    },
    async flushAll() { await Promise.all([...entries.keys()].map((k) => run(k))); },
    cancel(key) { const e = entries.get(key); if (e) { clearT(e.timer); entries.delete(key); } },
    pending: () => entries.size,
  };
}
