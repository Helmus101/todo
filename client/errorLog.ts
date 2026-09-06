// A visible place to see what's gone wrong recently — every error-kind toast (notify(msg, "error")) already
// fires app-wide through ONE context (NotifyContext in ui.tsx), so this is the single choke point that
// catches all of them without touching every call site. Purely client-side (localStorage), per-browser —
// this is a "what just happened on THIS device" log for the student/parent to glance at, not a server-side
// error-tracking system (Sentry already covers that for the team, see server/sentry.ts).
export interface LoggedError {
  message: string;
  at: string; // ISO
}

const KEY = "otto-error-log";
const CAP = 50;

export function pushError(message: string): void {
  if (!message) return;
  try {
    const list = getErrors();
    list.unshift({ message: message.slice(0, 500), at: new Date().toISOString() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, CAP)));
  } catch { /* best-effort — a full/blocked localStorage must never break the toast itself */ }
}

export function getErrors(): LoggedError[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.message === "string" && typeof e.at === "string") : [];
  } catch { return []; }
}

export function clearErrors(): void {
  try { localStorage.removeItem(KEY); } catch { /* best-effort */ }
}
