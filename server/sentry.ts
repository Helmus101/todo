// Production error visibility. Before this, every failure in this app (a Supabase write that silently
// failed, a sweep that died for one account, an unhandled route error) only ever reached `console.error`/
// `console.warn` — invisible in practice, since Vercel's function logs are ephemeral and only searchable
// for a short retention window. A student's task silently failing to save had ZERO signal reaching anyone
// until they noticed it missing. No-ops entirely when SENTRY_DSN isn't set (same gate pattern as
// aiReady()/cloudEnabled() elsewhere) — this is additive observability, never a hard requirement to run.
import * as Sentry from "@sentry/node";

const DSN = process.env.SENTRY_DSN;
let initialized = false;

export function initSentry(): void {
  if (!DSN || initialized) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || "development",
    // Errors only — no performance tracing. This app's cost/latency is already tracked its own way
    // (token/usage accounting in shared/types.ts); tracing would just add overhead for data already covered.
    tracesSampleRate: 0,
  });
  initialized = true;
}

/** Report an error, tagged with WHERE it came from (a short label, not free text — keeps Sentry's own
 *  issue-grouping useful instead of every call site becoming its own noisy, ungrouped issue). Safe to call
 *  unconditionally: a no-op when Sentry isn't configured, and never throws into the caller's own error path
 *  (an observability call must never become a NEW reason a request fails). */
export function reportError(scope: string, err: unknown, extra?: Record<string, unknown>): void {
  if (!DSN || !initialized) return;
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope },
      extra,
    });
  } catch { /* observability must never itself throw */ }
}
