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
import type { Profile } from "../shared/types.ts";
import { loadState, saveState, type StoredPronote } from "./store.ts";
import { credentialEncryptionConfigured } from "./crypto.ts";

export const PRONOTE_KIND = { STUDENT: pronote.AccountKind.STUDENT, PARENT: pronote.AccountKind.PARENT } as const;

// pawnote (the unofficial Pronote client this file wraps — see the module doc comment above) talks to a
// real school's own server, which has no uptime/latency guarantee at all — a slow or hanging school portal
// had no ceiling here, unlike server/websearch.ts's DuckDuckGo call which already timed out at 9s. A LOGICAL
// timeout, same caveat as integrations.ts's Composio wrapper: this stops OUR wait, not necessarily the
// underlying request. 20s: a login/homework-fetch round trip against a real (sometimes slow) school server
// legitimately needs more room than a search API.
const PRONOTE_TIMEOUT_MS = 20_000;
function withPronoteTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Pronote call timed out: ${label}`)), PRONOTE_TIMEOUT_MS)),
  ]);
}

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
// Static (doesn't need the connection anchor — a grade average isn't a deadline that expires); deliberately
// includes one clearly-weak subject (Anglais) and one strong one (SES) so the "prioritize the weak subject"
// behavior (see profileBlock/classifyCandidates in claude.ts) has something real to demonstrate against.
function mockGrades(): PronoteGradeItem[] {
  return [
    { subject: "Maths", average: 13.5, outOf: 20 },
    { subject: "Physique", average: 11, outOf: 20 },
    { subject: "Anglais", average: 8, outOf: 20 },
    { subject: "SES", average: 16, outOf: 20 },
    { subject: "Philosophie", average: 12, outOf: 20 },
  ];
}

/** Turn pawnote's typed errors into something a user can actually act on. */
function humanizeError(e: unknown): string {
  if (e instanceof pronote.BadCredentialsError) return "Identifiant ou mot de passe Pronote incorrect.";
  if (e instanceof pronote.AccountDisabledError) return "Ce compte Pronote est désactivé.";
  if (e instanceof pronote.SuspendedIPError) return "Pronote a temporairement bloqué ce serveur — réessaie plus tard.";
  if (e instanceof pronote.RateLimitedError) return "Pronote a limité cette requête — réessaie dans un instant.";
  if (e instanceof pronote.SecurityError) return "Pronote demande une étape de sécurité supplémentaire non gérée ici (double authentification / CAPTCHA).";
  if (e instanceof pronote.SessionExpiredError) return "Session Pronote expirée — reconnecte-toi dans les Réglages.";
  // PageUnavailableError is thrown by BOTH a genuinely wrong URL AND — confirmed live, see the comment
  // below — a URL that's verifiably correct (pronote.instance() succeeds against it) but where
  // loginCredentials() still fails this way, even before checking credentials. normalizePronoteUrl (above)
  // already fixes the common bare-domain case before this is ever reached, so don't claim "check your URL"
  // here — that's actively misleading once the URL is already right. Something in pawnote's login
  // handshake itself isn't completing against this account/instance (observed against a real, live 2026.2
  // -era Pronote server) — outside what a URL fix or a retry can resolve from this app's side.
  if (e instanceof pronote.PageUnavailableError) {
    return "Pronote a refusé la connexion à cette adresse (« page introuvable » pendant la connexion, alors que l'adresse elle-même est correcte) — ça ressemble à un problème de compatibilité entre notre outil et la version actuelle du Pronote de ton établissement, pas à une erreur de ta part. Réessaie plus tard ; si ça persiste, contacte le support.";
  }
  const msg = (e as any)?.message || String(e);
  return `Impossible de contacter Pronote : ${msg}`.slice(0, 200);
}

// Pronote's refresh token is single-use/rotating — two concurrent operations for the SAME account (a
// discovery sweep mid-rotation racing a user's "reconnect" click, or two sweeps overlapping) would both
// read the same stored token/credentials and race their saveState calls; whichever lands last silently
// discards the other's result, which can strand the account if the losing write held the newer token.
// Serialize EVERY Pronote operation for an account through this one lock — not just reads
// (runPronoteSessionOnce below), but connectPronote too, since a fresh login's save can just as easily
// interleave with an in-flight rotation's save. A failed run doesn't poison the chain for the next caller.
const pronoteLocks = new Map<string, Promise<unknown>>();
function withPronoteLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const prior = pronoteLocks.get(email) || Promise.resolve();
  const run = prior.then(fn, fn);
  pronoteLocks.set(email, run.catch(() => undefined));
  return run;
}

// A student pasting just the school's base domain (e.g. "https://0753874d.index-education.net", copied
// from a bookmark or a school handout rather than the actual login page's address bar) hit Pronote's
// server root — not a real page — and got back a raw, unhelpful "The requested page does not exist" with
// no indication of what was actually wrong. Real Pronote URLs need the specific page path (the Settings
// form's own placeholder shows this: .../pronote/eleve.html or .../pronote/parent.html) — normalize a
// bare-domain input to the right one for the account kind instead of forcing the student to already know
// this and retype it. Leaves an already-correct URL untouched.
// NOTE: deliberately does NOT use pawnote's own `cleanURL` here — that function strips the page filename
// entirely (turns ".../pronote/eleve.html" into just ".../pronote"), which is presumably right for
// whatever pawnote uses it for internally, but is exactly the WRONG transformation for what this function
// needs: loginCredentials wants the full page path, and blindly cleaning first (an earlier version of this
// function did) silently mangled an already-correct URL into ".../pronote/pronote/eleve.html" — a real,
// shipped regression, caught immediately when a real account with the full correct URL still failed.
function normalizePronoteUrl(url: string, kind: number): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/\/pronote\/[a-z]+\.html/i.test(trimmed)) return trimmed; // already points at a specific page — leave it alone
  const page = kind === pronote.AccountKind.PARENT ? "parent.html" : "eleve.html";
  return /\/pronote$/i.test(trimmed) ? `${trimmed}/${page}` : `${trimmed}/pronote/${page}`;
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
  const rawUrl = opts.url.trim(), username = opts.username.trim();
  if (!rawUrl || !username || !opts.password) return { ok: false, error: "L'URL, l'identifiant et le mot de passe sont requis." };
  const kind = opts.kind === pronote.AccountKind.PARENT ? pronote.AccountKind.PARENT : pronote.AccountKind.STUDENT;
  const url = rawUrl.toLowerCase() === "demo" ? rawUrl : normalizePronoteUrl(rawUrl, kind);
  const deviceUUID = randomUUID();
  return withPronoteLock(email, async () => {
    if (MOCK_ENABLED && url.toLowerCase() === "demo") {
      const stored: StoredPronote = { url: MOCK_URL, username, kind, token: "mock-token", deviceUUID, mockConnectedAt: new Date().toISOString() };
      const current = await loadState(email);
      await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: stored });
      return { ok: true };
    }
    try {
      const session = pronote.createSessionHandle();
      const refresh = await withPronoteTimeout("loginCredentials", pronote.loginCredentials(session, { url, kind, username, password: opts.password, deviceUUID }));
      // needsReconnect is deliberately omitted (not set false) — a fresh successful login has nothing to
      // carry forward from any prior dead-token flag; a full replacement object naturally clears it.
      const stored: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier };
      const current = await loadState(email);
      await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: stored });
      return { ok: true };
    } catch (e: any) {
      console.warn("[pronote] connect failed:", e?.message || e);
      return { ok: false, error: humanizeError(e) };
    }
  });
}

export async function disconnectPronote(email: string): Promise<void> {
  const current = await loadState(email);
  await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: undefined });
}

export async function pronoteConnected(email: string): Promise<{ connected: boolean; username?: string; needsReconnect?: boolean }> {
  const { pronote: stored } = await loadState(email);
  if (!stored) return { connected: false };
  return { connected: true, username: stored.username, ...(stored.needsReconnect ? { needsReconnect: true } : {}) };
}

// Cached wrapper for the hot /api/status path (client/App.tsx polls it every 45s, plus on every focus/
// visibility change) — pronoteConnected() otherwise does a full cloud state load on EVERY call, with no
// caching at all, for a value that only ever changes on an explicit connect/disconnect. 60s TTL, longer
// than the poll interval so a normal poll actually hits the cache instead of re-reading every time.
const connectedCache = new Map<string, { at: number; data: { connected: boolean; username?: string; needsReconnect?: boolean } }>();
export async function pronoteConnectedCached(email: string): Promise<{ connected: boolean; username?: string; needsReconnect?: boolean }> {
  const hit = connectedCache.get(email);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = await pronoteConnected(email);
  connectedCache.set(email, { at: Date.now(), data });
  return data;
}
/** Invalidate after an explicit connect/disconnect so the status endpoint reflects it immediately
 *  instead of waiting out the cache TTL. */
export function invalidatePronoteStatus(email: string): void { connectedCache.delete(email); }

// The rotated token is the one Pronote write where losing it means real account lockout (the OLD token
// is already dead on Pronote's own server the moment loginToken() returns) — unlike every other read in
// this pipeline, a dropped write here isn't just "try again next sweep," it's "the student has to
// re-enter their real password." A transient DB blip on this ONE call shouldn't cost that.
async function saveRotatedToken(email: string, rotated: StoredPronote): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const current = await loadState(email);
      await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: rotated });
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

/** Open a fresh Pronote session from the stored token, run `fn`, then persist the ROTATED token (pawnote
 *  issues a new one on every login) before returning — skipping that would lock the next read out. Never
 *  throws; a login/read failure returns undefined and is logged (best-effort, same pattern as the rest of
 *  the discovery pipeline — one flaky source must not break the whole sweep). */
async function runPronoteSessionOnce<T>(email: string, fn: (session: pronote.SessionHandle) => Promise<T>): Promise<T | undefined> {
  const { pronote: stored } = await loadState(email);
  if (!stored) return undefined;
  try {
    const session = pronote.createSessionHandle();
    const refresh = await withPronoteTimeout("loginToken", pronote.loginToken(session, {
      url: stored.url, username: stored.username, kind: stored.kind as pronote.AccountKind, token: stored.token,
      deviceUUID: stored.deviceUUID, navigatorIdentifier: stored.navigatorIdentifier,
    }));
    const rotated: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID: stored.deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier };
    await saveRotatedToken(email, rotated);
    try { return await fn(session); }
    finally { if (session.presence) pronote.clearPresenceInterval(session); }
  } catch (e: any) {
    // A genuinely dead token (not a transient portal/network blip) looks identical to "no homework today"
    // to every caller (pronoteHomework/Tests/Grades all collapse this to []) — flag it so pronoteConnected
    // can tell the student to reconnect instead of silently showing an empty list forever. Best-effort:
    // this must never throw on top of the real error being handled below.
    if (e instanceof pronote.SessionExpiredError || e instanceof pronote.BadCredentialsError) {
      const current = await loadState(email).catch(() => undefined);
      if (current) void saveState(email, { profile: current.profile, tasks: current.tasks, pronote: { ...stored, needsReconnect: true } }).catch(() => {});
    }
    console.warn("[pronote] session failed:", e?.message || e);
    return undefined;
  }
}

// Covers the same concurrent-rotation hazard the withPronoteLock comment above describes (e.g. a
// discovery sweep's Promise.all fetching homework and tests together, server/discover.ts) — reuses the
// SAME lock connectPronote goes through, so a read-triggered rotation and a fresh reconnect can never
// interleave for the same account either.
function withPronoteSession<T>(email: string, fn: (session: pronote.SessionHandle) => Promise<T>): Promise<T | undefined> {
  return withPronoteLock(email, () => runPronoteSessionOnce(email, fn));
}

export interface PronoteHomeworkItem { id: string; subject: string; description: string; deadline: string; done: boolean;
  /** A file/link the teacher attached to this assignment (a worksheet PDF, a reference link) — pawnote's
   *  Assignment.attachments, previously never read at all: Otto had zero visibility that one existed,
   *  not just an inability to read its content. Carried through so the student gets a direct link to
   *  open it themselves (see server/discover.ts's pronoteToItems). */
  attachments?: { name: string; url: string }[];
}

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
    const assignments = await withPronoteTimeout("assignmentsFromIntervals", pronote.assignmentsFromIntervals(session, now, end));
    return assignments
      .filter((a) => !a.done)
      .map((a): PronoteHomeworkItem => ({
        id: a.id,
        subject: a.subject?.name || "Homework",
        description: String(a.description || "").replace(/\s+/g, " ").trim().slice(0, 400),
        deadline: a.deadline.toISOString(),
        done: a.done,
        ...(a.attachments?.length ? { attachments: a.attachments.map((x) => ({ name: x.name, url: x.url })) } : {}),
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
    const timetable = await withPronoteTimeout("timetableFromIntervals", pronote.timetableFromIntervals(session, now, end));
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

/**
 * Merge Pronote's grade averages into profile.grades in place — Pronote is the source of truth for any
 * subject it reports; a manually-entered grade for a subject Pronote doesn't cover (or before this ever
 * ran) is left alone. Shared by every place grades get pulled in — the daily sweep (jobs.ts), the manual
 * "Sync from Pronote" button (index.ts), and connecting Pronote for the first time — so a student's
 * grades show up real, without a separate click, the moment there's something to show.
 */
export function applyPronoteGrades(profile: Profile, fromPronote: PronoteGradeItem[]): void {
  if (!fromPronote.length) return;
  const now = new Date().toISOString();
  const list = (profile.grades ||= []);
  for (const g of fromPronote) {
    // Only overwrite a PRONOTE-sourced row in place (it's "the average as of now" — one live value per
    // subject). A manually-logged grade for the same subject is a separate historical data point and is
    // never touched here — see the type comment on Profile.grades for why the two sources don't merge.
    const i = list.findIndex((x) => x.subject.toLowerCase() === g.subject.toLowerCase() && x.source === "pronote");
    const entry = { id: i >= 0 ? list[i].id : randomUUID(), subject: g.subject, grade: g.average, scale: g.outOf, updatedAt: now, source: "pronote" as const };
    if (i >= 0) list[i] = entry; else list.push(entry);
  }
}

export interface PronoteGradeItem { subject: string; average: number; outOf: number; }

/** Per-subject grade averages for the CURRENT period (Pronote splits the year into trimesters/semesters —
 *  the period containing today's date, falling back to the most recent one if none matches, e.g. holidays).
 *  Uses subjectsAverages (the student's own average per subject) rather than every individual grade — that's
 *  exactly the "which subject needs attention" signal Otto's profile block wants, with no averaging logic
 *  duplicated here. */
export async function pronoteGrades(email: string): Promise<PronoteGradeItem[]> {
  if (MOCK_ENABLED) { const { pronote: stored } = await loadState(email); if (stored?.url === MOCK_URL) return mockGrades(); }
  const out = await withPronoteSession(email, async (session) => {
    const periods = session.instance.periods;
    if (!periods.length) return [];
    const now = Date.now();
    const period = periods.find((p) => p.startDate.getTime() <= now && now <= p.endDate.getTime()) || periods[periods.length - 1];
    const overview = await pronote.gradesOverview(session, period);
    return overview.subjectsAverages
      .filter((s) => s.student && s.outOf?.points)
      .map((s): PronoteGradeItem => ({
        subject: s.subject?.name || "Matière",
        average: Math.round((s.student!.points / (s.outOf!.points || 20)) * 20 * 10) / 10,
        outOf: 20,
      }));
  });
  return out || [];
}
