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
import { credentialEncryptionConfigured } from "./crypto.ts";

export const PRONOTE_KIND = { STUDENT: pronote.AccountKind.STUDENT, PARENT: pronote.AccountKind.PARENT } as const;

// ── Dev-only mock (no real Pronote account needed) ──────────────────────────────────────────────────
// Index Éducation's public demo instance has moved/changed URLs often enough that hardcoding one here
// would just go stale again. This lets local dev/testing exercise the WHOLE pipeline (connect → discover
// → classify → French task cards) without touching pawnote or any real school at all. Gated behind an env
// var so it can never accidentally ship live — enable with PRONOTE_MOCK=1 in .env, then in the Connecter
// Pronote form type "demo" as the URL (username/password can be anything non-empty).
const MOCK_ENABLED = process.env.PRONOTE_MOCK === "1";
const MOCK_URL = "mock://demo";
// Deadlines are FIXED offsets from the moment the mock account was connected (mockConnectedAt) — NOT
// recomputed from "now" on every fetch. Real Pronote's assignmentsFromIntervals/timetableFromIntervals only
// ever return items inside a [now, now+daysAhead] window, so a real homework due yesterday simply stops
// coming back once "now" passes it. If these were "N days from right now" on every call, every mock item
// would be permanently un-passable — exactly the dynamic-expiry behavior this is meant to help test would
// never actually trigger. Instead: fixed offset from a fixed anchor, then filtered like the real API filters.
function mockHomework(anchor: string): PronoteHomeworkItem[] {
  const at = (days: number) => new Date(Date.parse(anchor) + days * 86_400_000).toISOString();
  const now = Date.now();
  return [
    { id: "mock-hw-1", subject: "Physique", description: "Exercices 12 à 15 p.87 — mécanique du point", deadline: at(2), done: false },
    { id: "mock-hw-2", subject: "Anglais", description: "Rédiger un paragraphe (150 mots) sur l'essay set text", deadline: at(4), done: false },
    { id: "mock-hw-3", subject: "SES", description: "Fiche de lecture chapitre 3 — la mondialisation", deadline: at(9), done: false },
  ].filter((h) => Date.parse(h.deadline) >= now && Date.parse(h.deadline) <= now + HOMEWORK_DAYS_AHEAD * 86_400_000);
}
function mockTests(anchor: string): PronoteTestItem[] {
  const at = (days: number) => new Date(Date.parse(anchor) + days * 86_400_000).toISOString();
  const now = Date.now();
  return [
    { id: "mock-test-1", subject: "Maths", deadline: at(3) },
    { id: "mock-test-2", subject: "Philosophie", deadline: at(12) },
  ].filter((t) => Date.parse(t.deadline) >= now && Date.parse(t.deadline) <= now + TEST_DAYS_AHEAD * 86_400_000);
}

/** Turn pawnote's typed errors into something a user can actually act on. */
function humanizeError(e: unknown): string {
  if (e instanceof pronote.BadCredentialsError) return "Identifiant ou mot de passe Pronote incorrect.";
  if (e instanceof pronote.AccountDisabledError) return "Ce compte Pronote est désactivé.";
  if (e instanceof pronote.SuspendedIPError) return "Pronote a temporairement bloqué ce serveur — réessaie plus tard.";
  if (e instanceof pronote.RateLimitedError) return "Pronote a limité cette requête — réessaie dans un instant.";
  if (e instanceof pronote.SecurityError) return "Pronote demande une étape de sécurité supplémentaire non gérée ici (double authentification / CAPTCHA).";
  if (e instanceof pronote.SessionExpiredError) return "Session Pronote expirée — reconnecte-toi dans les Réglages.";
  const msg = (e as any)?.message || String(e);
  return `Impossible de contacter Pronote : ${msg}`.slice(0, 200);
}

/** Connect a Pronote account: log in ONCE with the real credentials (never stored past this call), then
 *  persist only the rotating token pawnote issues in their place. */
export async function connectPronote(email: string, opts: { url: string; username: string; password: string; kind?: number }): Promise<{ ok: boolean; error?: string }> {
  // Mandatory HERE specifically, unlike the rest of the app: a Pronote token is the replacement for a
  // student's REAL school password, a materially bigger liability than a revocable Google OAuth token if
  // this database ever leaked. crypto.ts itself stays non-fatal (it's imported by nearly everything, so a
  // hard failure there would take down the whole app over one feature) — but THIS specific write, storing
  // that real credential's replacement, refuses to proceed without encryption actually configured.
  if (!credentialEncryptionConfigured()) {
    return { ok: false, error: "Pronote n'est pas disponible pour le moment — ce serveur n'est pas encore " +
      "configuré pour stocker les identifiants scolaires en toute sécurité. Réessaie plus tard ou contacte le support." };
  }
  const url = opts.url.trim(), username = opts.username.trim();
  if (!url || !username || !opts.password) return { ok: false, error: "L'URL, l'identifiant et le mot de passe sont requis." };
  const kind = opts.kind === pronote.AccountKind.PARENT ? pronote.AccountKind.PARENT : pronote.AccountKind.STUDENT;
  const deviceUUID = randomUUID();
  if (MOCK_ENABLED && url.toLowerCase() === "demo") {
    const stored: StoredPronote = { url: MOCK_URL, username, kind, token: "mock-token", deviceUUID, mockConnectedAt: new Date().toISOString() };
    const current = await loadState(email);
    await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: stored });
    return { ok: true };
  }
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
  if (MOCK_ENABLED) { const { pronote: stored } = await loadState(email); if (stored?.url === MOCK_URL) return mockHomework(stored.mockConnectedAt || new Date().toISOString()); }
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
  if (MOCK_ENABLED) { const { pronote: stored } = await loadState(email); if (stored?.url === MOCK_URL) return mockTests(stored.mockConnectedAt || new Date().toISOString()); }
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
