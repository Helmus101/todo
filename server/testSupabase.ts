// An in-memory stand-in for the Supabase client, used ONLY by tests (TEST_FAKE_SUPABASE=1, refused in production). It implements just
// the query-builder surface server/store.ts uses (select/insert/upsert/update/delete with eq/neq/in/lt/gt/gte/lte, order/limit/range,
// maybeSingle/single, rpc, auth.admin) so the REAL store, session store, rate limiter, CSRF and account-merge code run with no network.
// Rows are JSON-cloned on the way in and out like a network hop would, so aliasing bugs show up the same way.
import { randomUUID, createHash } from "node:crypto";

type Row = Record<string, any>;
const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export interface FakeStats { calls: number; writes: number; conflicts: number }

export function createFakeSupabase() {
  const tables = new Map<string, Row[]>();
  const users = new Map<string, { id: string; email: string; hash: string }>();
  const stats: FakeStats = { calls: 0, writes: 0, conflicts: 0 };
  const tbl = (n: string) => { let t = tables.get(n); if (!t) { t = []; tables.set(n, t); } return t; };
  const hashPw = (p: string) => createHash("sha256").update(p).digest("hex");
  // Optional fault injection for tests: reject calls to a table with an error message.
  const faults = new Map<string, string>();

  class Query implements PromiseLike<any> {
    private mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    private payload: any; private onConflict?: string;
    private filters: ((r: Row) => boolean)[] = [];
    private wantRows = false; private orderBy?: { col: string; asc: boolean }; private lim?: number; private rng?: [number, number];
    private head = false; private count = false; private single: "none" | "maybe" | "one" = "none";
    constructor(private name: string) {}
    select(_cols?: string, o?: { count?: string; head?: boolean }) { this.wantRows = true; if (o?.count) this.count = true; if (o?.head) this.head = true; return this; }
    insert(p: any) { this.mode = "insert"; this.payload = p; return this; }
    upsert(p: any, o?: { onConflict?: string }) { this.mode = "upsert"; this.payload = p; this.onConflict = o?.onConflict; return this; }
    update(p: any) { this.mode = "update"; this.payload = p; return this; }
    delete() { this.mode = "delete"; return this; }
    private f(fn: (r: Row) => boolean) { this.filters.push(fn); return this; }
    eq(c: string, v: any) { return this.f((r) => r[c] === v); }
    neq(c: string, v: any) { return this.f((r) => r[c] !== v); }
    in(c: string, vs: any[]) { return this.f((r) => vs.includes(r[c])); }
    lt(c: string, v: any) { return this.f((r) => r[c] != null && r[c] < v); }
    lte(c: string, v: any) { return this.f((r) => r[c] != null && r[c] <= v); }
    gt(c: string, v: any) { return this.f((r) => r[c] != null && r[c] > v); }
    gte(c: string, v: any) { return this.f((r) => r[c] != null && r[c] >= v); }
    not() { return this; }
    or() { return this; }
    order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }
    range(a: number, b: number) { this.rng = [a, b]; return this; }
    maybeSingle() { this.single = "maybe"; return this; }
    // (insert().select().single() returns the inserted row)
    singleRow() { this.single = "one"; return this; }
    async run(): Promise<{ data: any; error: any; count?: number }> {
      stats.calls++;
      const fault = faults.get(this.name); if (fault) return { data: null, error: { message: fault } };
      const t = tbl(this.name);
      const match = (r: Row) => this.filters.every((fn) => fn(r));
      let out: Row[] = [];
      if (this.mode === "insert") {
        stats.writes++;
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ id: r.id ?? randomUUID(), ...clone(r) }));
        t.push(...rows); out = rows;
      } else if (this.mode === "upsert") {
        stats.writes++;
        const key = this.onConflict || "id";
        for (const r of Array.isArray(this.payload) ? this.payload : [this.payload]) {
          const i = t.findIndex((x) => x[key] === r[key]);
          if (i >= 0) { t[i] = { ...t[i], ...clone(r) }; out.push(t[i]); } else { const n = clone(r); t.push(n); out.push(n); }
        }
      } else if (this.mode === "update") {
        out = t.filter(match);
        if (out.length) stats.writes++;
        for (const r of out) Object.assign(r, clone(this.payload));
      } else if (this.mode === "delete") {
        out = t.filter(match);
        if (out.length) stats.writes++;
        for (const r of out) t.splice(t.indexOf(r), 1);
      } else {
        out = t.filter(match);
      }
      if (this.orderBy) { const { col, asc } = this.orderBy; out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1)); }
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
      const cnt = this.count ? out.length : undefined;
      if (this.head) return { data: null, error: null, count: cnt };
      const returnRows = this.mode === "select" || this.wantRows;
      if (!returnRows) return { data: null, error: null };
      if (this.single !== "none") return { data: out[0] ? clone(out[0]) : null, error: null };
      return { data: clone(out), error: null, count: cnt };
    }
    then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) { return this.run().then(ok, bad); }
  }
  // supabase-js lets `.single()` follow insert().select(); alias it onto maybeSingle semantics.
  (Query.prototype as any).single = function () { return this.singleRow(); };

  const rateHits = new Map<string, number[]>();
  const client = {
    from: (name: string) => new Query(name),
    async rpc(fn: string, args: any) {
      stats.calls++;
      if (fn === "otto_rate_limit") {
        const now = Date.now(); const hits = (rateHits.get(args.p_key) || []).filter((t) => now - t < args.p_window_ms);
        if (hits.length >= args.p_max) { rateHits.set(args.p_key, hits); return { data: { allowed: false, retry_after_ms: args.p_window_ms - (now - hits[0]) }, error: null }; }
        hits.push(now); rateHits.set(args.p_key, hits);
        return { data: { allowed: true, retry_after_ms: 0 }, error: null };
      }
      if (fn === "otto_auth_user_id") return { data: users.get(String(args.p_email).toLowerCase())?.id ?? null, error: null };
      return { data: null, error: { message: `function ${fn} does not exist`, code: "42883" } };
    },
    auth: {
      admin: {
        async listUsers() { return { data: { users: [...users.values()].map((u) => ({ id: u.id, email: u.email })) }, error: null }; },
        async createUser({ email, password }: { email: string; password: string }) {
          const e = email.toLowerCase();
          if (users.has(e)) return { data: null, error: { message: "User already registered" } };
          users.set(e, { id: randomUUID(), email: e, hash: hashPw(password) });
          return { data: {}, error: null };
        },
        async updateUserById(id: string, { password }: { password: string }) { const u = [...users.values()].find((x) => x.id === id); if (!u) return { data: null, error: { message: "not found" } }; u.hash = hashPw(password); return { data: {}, error: null }; },
        async deleteUser(id: string) { for (const [k, u] of users) if (u.id === id) users.delete(k); return { data: {}, error: null }; },
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const u = users.get(String(email).toLowerCase());
        return u && u.hash === hashPw(password) ? { data: {}, error: null } : { data: null, error: { message: "Invalid login credentials" } };
      },
    },
  };
  return { client: client as any, stats, tables, users, faults };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
