/**
 * Pronote (the French school-management portal) integration — READ-ONLY, and deliberately NOT part of the
 * Composio-routed agent toolset.
 *
 * Pronote has no official public API or OAuth. This uses `pawnote` (https://github.com/LiterateInk/Pawnote.js),
 * an unofficial, reverse-engineered client library — not affiliated with Index-Education/PRONOTE. That has
 * two consequences worth stating plainly:
 *   1. It can break whenever Pronote changes its protocol, independent of anything in this codebase.
 *   2. Since there's no OAuth, connecting requires the account's REAL username/password once. The password
 *      is used for exactly one login call and is NEVER stored or logged — pawnote's `loginCredentials`
 *      returns a `RefreshInformation.token` that acts as a password replacement from then on (scoped to a
 *      per-account deviceUUID), the same shape as an OAuth refresh token. That token IS what gets persisted
 *      (see StoredPronote in store.ts), protected by RLS + the service-role-only write path AND, on top of
 *      that, app-level AES-256-GCM encryption (server/crypto.ts) applied transparently in store.ts's
 *      loadState/saveState — this file never sees the encrypted form, just the live token.
 *
 * GUARDRAIL: this module exposes READS ONLY (homework, timetable). It is never wired into
 * integrations.getAgentTools() — the agent has no path to call anything here, so none of Pronote's write
 * actions (e.g. marking homework done) can ever be reached autonomously. If that's ever wanted, it must go
 * through the same explicit-approval machinery as everything else, not be added quietly to this file.
 */
import { randomUUID } from "node:crypto";
import * as pronote from "pawnote";
import { loadState, saveState, type StoredPronote } from "./store.ts";

export const PRONOTE_KIND = { STUDENT: pronote.AccountKind.STUDENT, PARENT: pronote.AccountKind.PARENT } as const;

/** Turn pawnote's typed errors into something a user can actually act on. */
function humanizeError(e: unknown): string {
  if (e instanceof pronote.BadCredentialsError) return "Wrong Pronote username or password.";
  if (e instanceof pronote.AccountDisabledError) return "This Pronote account is disabled.";
  if (e instanceof pronote.SuspendedIPError) return "Pronote has temporarily blocked this server's IP — try again later.";
  if (e instanceof pronote.RateLimitedError) return "Pronote rate-limited this request — try again in a moment.";
  if (e instanceof pronote.SecurityError) return "Pronote requires an extra security step this integration doesn't support (double authentication / CAPTCHA).";
  if (e instanceof pronote.SessionExpiredError) return "Pronote session expired — reconnect in Settings.";
  const msg = (e as any)?.message || String(e);
  return `Couldn't reach Pronote: ${msg}`.slice(0, 200);
}

/** Connect a Pronote account: log in ONCE with the real credentials (never stored past this call), then
 *  persist only the rotating token pawnote issues in their place. */
export async function connectPronote(email: string, opts: { url: string; username: string; password: string; kind?: number }): Promise<{ ok: boolean; error?: string }> {
  const url = opts.url.trim(), username = opts.username.trim();
  if (!url || !username || !opts.password) return { ok: false, error: "URL, username and password are required." };
  const kind = opts.kind === pronote.AccountKind.PARENT ? pronote.AccountKind.PARENT : pronote.AccountKind.STUDENT;
  const deviceUUID = randomUUID();
  try {
    const session = pronote.createSessionHandle();
    const refresh = await pronote.loginCredentials(session, { url, kind, username, password: opts.password, deviceUUID });
    const stored: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier };
    const current = await loadState(email);
    await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: stored });
    return { ok: true };
  } catch (e: any) {
    console.warn("[pronote] connect failed:", e?.message || e);
    return { ok: false, error: humanizeError(e) };
  }
}

export async function disconnectPronote(email: string): Promise<void> {
  const current = await loadState(email);
  await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: undefined });
}

export async function pronoteConnected(email: string): Promise<{ connected: boolean; username?: string }> {
  const { pronote: stored } = await loadState(email);
  return stored ? { connected: true, username: stored.username } : { connected: false };
}

/** Open a fresh Pronote session from the stored token, run `fn`, then persist the ROTATED token (pawnote
 *  issues a new one on every login) before returning — skipping that would lock the next read out. Never
 *  throws; a login/read failure returns undefined and is logged (best-effort, same pattern as the rest of
 *  the discovery pipeline — one flaky source must not break the whole sweep). */
async function withPronoteSession<T>(email: string, fn: (session: pronote.SessionHandle) => Promise<T>): Promise<T | undefined> {
  const { pronote: stored } = await loadState(email);
  if (!stored) return undefined;
  try {
    const session = pronote.createSessionHandle();
    const refresh = await pronote.loginToken(session, {
      url: stored.url, username: stored.username, kind: stored.kind as pronote.AccountKind, token: stored.token,
      deviceUUID: stored.deviceUUID, navigatorIdentifier: stored.navigatorIdentifier,
    });
    const rotated: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID: stored.deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier };
    const current = await loadState(email);
    await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: rotated });
    try { return await fn(session); }
    finally { if (session.presence) pronote.clearPresenceInterval(session); }
  } catch (e: any) {
    console.warn("[pronote] session failed:", e?.message || e);
    return undefined;
  }
}

export interface PronoteHomeworkItem { id: string; subject: string; description: string; deadline: string; done: boolean; }

// Homework is graded work due days-to-weeks out, so a 10-day window used to miss anything a student
// should already be starting on (a long essay, a project) — widened so nothing due within ~3 weeks is
// silently invisible to Otto. Urgency/importance still scale with proximity in classify (claude.ts), so
// a far-off deadline doesn't crowd out what's actually due soon.
const HOMEWORK_DAYS_AHEAD = 21;

/** Homework due in the next `daysAhead` days, not yet marked done. */
export async function pronoteHomework(email: string, daysAhead = HOMEWORK_DAYS_AHEAD): Promise<PronoteHomeworkItem[]> {
  const out = await withPronoteSession(email, async (session) => {
    const now = new Date();
    const end = new Date(now.getTime() + daysAhead * 86_400_000);
    const assignments = await pronote.assignmentsFromIntervals(session, now, end);
    return assignments
      .filter((a) => !a.done)
      .map((a): PronoteHomeworkItem => ({
        id: a.id,
        subject: a.subject?.name || "Homework",
        description: String(a.description || "").replace(/\s+/g, " ").trim().slice(0, 400),
        deadline: a.deadline.toISOString(),
        done: a.done,
      }));
  });
  return out || [];
}

export interface PronoteTestItem { id: string; subject: string; deadline: string; }

// Tests/exams need more lead time than homework — they're the thing a student should be STUDYING FOR
// ahead of the date, not just showing up to. A wider window than homework gives Otto (and the student)
// real runway to plan study sessions instead of surfacing the exam the day before.
const TEST_DAYS_AHEAD = 28;

/** Upcoming tests/exams (Pronote flags a lesson slot as "test") in the next `daysAhead` days. Pronote's
 *  timetable has no stable per-instance id across re-fetches, so the anchor identity used by the caller
 *  (discover.ts) is built from subject+date, not `id` alone — this "id" is only for display/de-dup within
 *  a single fetch. */
export async function pronoteTests(email: string, daysAhead = TEST_DAYS_AHEAD): Promise<PronoteTestItem[]> {
  const out = await withPronoteSession(email, async (session) => {
    const now = new Date();
    const end = new Date(now.getTime() + daysAhead * 86_400_000);
    const timetable = await pronote.timetableFromIntervals(session, now, end);
    return timetable.classes
      .filter((c): c is pronote.TimetableClassLesson => c.is === "lesson" && (c as pronote.TimetableClassLesson).test === true && !(c as pronote.TimetableClassLesson).canceled)
      .map((c): PronoteTestItem => ({
        id: c.id,
        subject: c.subject?.name || "Class",
        deadline: c.startDate.toISOString(),
      }));
  });
  return out || [];
}
