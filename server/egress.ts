// Per-profile, per-day meter for bytes read from PostgREST (Supabase). The target is ~10 MB per profile per day.
// The store notes what each real read cost; once a profile is over budget the store stops re-validating/refreshing
// from the database and serves its cached copy until the day rolls over (writes always still go through).
// Per server instance (serverless instances don't share memory), which is a conservative approximation.
export const DEFAULT_EGRESS_BUDGET_BYTES = 10 * 1024 * 1024;

export function makeEgressMeter(budget: number = DEFAULT_EGRESS_BUDGET_BYTES, today: () => string = () => new Date().toISOString().slice(0, 10), maxKeys = 2000) {
  let day = today();
  let used = new Map<string, number>();
  const roll = () => { const d = today(); if (d !== day) { day = d; used = new Map(); } };
  return {
    note(key: string, bytes: number) {
      roll();
      const n = (used.get(key) || 0) + Math.max(0, Math.round(bytes));
      used.delete(key); used.set(key, n);
      while (used.size > maxKeys) { const oldest = used.keys().next().value; if (oldest === undefined) break; used.delete(oldest); }
      return n;
    },
    used(key: string) { roll(); return used.get(key) || 0; },
    over(key: string) { roll(); return (used.get(key) || 0) >= budget; },
    budget,
  };
}
