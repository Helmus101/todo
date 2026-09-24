/**
 * Pronote (the French school-management portal) integration — READ-ONLY, and deliberately NOT part of the
 * Composio-routed agent toolset.
 *
 * Pronote has no official public API or OAuth. This uses `@blockshub/pawnote-lts`, a maintained fork
 * (by the Papillon team, a French school-app project) of the original `pawnote` library — an unofficial,
 * reverse-engineered client, not affiliated with Index-Education/PRONOTE. The original `pawnote` broke
 * against Pronote's ~2026.2.5 login handshake change and has no fix; this fork does, and is kept
 * API-compatible so it was a drop-in swap. That still leaves two consequences worth stating plainly:
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
// Uses @blockshub/pawnote-lts, a maintained fork of the original `pawnote` library (by the Papillon team,
// a French school-app project) — kept API-compatible so it's a drop-in replacement. The original `pawnote`
// stopped working against Pronote servers from ~2026.2.5 onward: those servers changed the login handshake
// so the login "challenge" is no longer decryptable the old way, it must be re-encrypted as-is (the same
// fix pronotepy — the Python equivalent — shipped in PR #347). This fork ships that fix and also handles
// the newer Pronote page HTML format natively, so the old normalizePronoteUrl-only compatibility layer
// below is now sufficient again (no response-transform/HTML-patch hacks needed).
import * as pronote from "@blockshub/pawnote-lts";
import type { Profile } from "../shared/types.ts";
import { loadState, saveState, type StoredPronote } from "./store.ts";
import { credentialEncryptionConfigured } from "./crypto.ts";
import { reportError } from "./sentry.ts";
import { connectionStatusesCached, sendSystemEmail } from "./integrations.ts";

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

// A dev-only mock mode (PRONOTE_MOCK=1, a fake "demo" account) used to live here so local testing could
// exercise the whole pipeline without a real school. Removed entirely — it caused real production
// confusion (a real account got seeded with this fake data while the env var was mistakenly left on, and
// the mock rows had no way to be told apart from real ones downstream). LEGACY_MOCK_URL below exists only
// to detect and purge any already-stored mock connection from before this removal, not to keep the feature.
const LEGACY_MOCK_URL = "mock://demo";

// Everyday, expected outcomes (a wrong password, a rate limit, a real school portal being down) —
// reporting every one of these to Sentry would just be noise around normal user/network behavior, not a
// signal of an actual bug. Anything NOT in this list reaching connect/session-failure catches below is
// genuinely unexpected and worth a report.
function isExpectedPronoteError(e: unknown): boolean {
  return e instanceof pronote.BadCredentialsError || e instanceof pronote.AccountDisabledError ||
    e instanceof pronote.SuspendedIPError || e instanceof pronote.RateLimitedError ||
    e instanceof pronote.SecurityError || e instanceof pronote.SessionExpiredError ||
    e instanceof pronote.PageUnavailableError;
}

/** Turn pawnote's typed errors into something a user can actually act on. */
function humanizeError(e: unknown): string {
  if (e instanceof pronote.BadCredentialsError) return "Identifiant ou mot de passe Pronote incorrect.";
  if (e instanceof pronote.AccountDisabledError) return "Ce compte Pronote est désactivé.";
  if (e instanceof pronote.SuspendedIPError) return "Pronote a temporairement bloqué ce serveur — réessaie plus tard.";
  if (e instanceof pronote.RateLimitedError) return "Pronote a limité cette requête — réessaie dans un instant.";
  if (e instanceof pronote.SecurityError) return "Pronote demande une étape de sécurité supplémentaire non gérée ici (double authentification / CAPTCHA).";
  if (e instanceof pronote.SessionExpiredError) return "Session Pronote expirée — reconnecte-toi dans les Réglages.";
  if (e instanceof pronote.PageUnavailableError) {
    return "Impossible de contacter Pronote à cette adresse — vérifie l'URL (ex : https://0000000a.index-education.net/pronote/eleve.html), copiée depuis la page de connexion de ton établissement.";
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
export async function connectPronote(email: string, opts: { url: string; username: string; password: string; kind?: number }): Promise<{ ok: boolean; error?: string; connected?: boolean; username?: string }> {
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
  const url = normalizePronoteUrl(rawUrl, kind);
  const deviceUUID = randomUUID();
  return withPronoteLock(email, async () => {
    try {
      const session = pronote.createSessionHandle();
      const refresh = await withPronoteTimeout("loginCredentials", pronote.loginCredentials(session, { url, kind, username, password: opts.password, deviceUUID }));
      // needsReconnect is deliberately omitted (not set false) — a fresh successful login has nothing to
      // carry forward from any prior dead-token flag; a full replacement object naturally clears it.
      const stored: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier, password: opts.password };
      const current = await loadState(email, { bypassCache: true });
      // throwOnError: without it, a real Supabase write failure here is only logged (store.ts's saveState
      // is fire-and-forget by default for background syncs) — this call site actually NEEDS to know, since
      // the login itself just succeeded and Pronote's token is single-use; silently reporting {ok:true} back
      // to the client while nothing was actually persisted meant the tile forever showed "not connected"
      // with zero visible error, and reconnecting just burned another one-time token for nothing.
      await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: stored }, { throwOnError: true });
      invalidatePronoteStatus(email);
      return { ok: true, connected: true, username: stored.username };
    } catch (e: any) {
      console.warn("[pronote] connect failed:", e?.message || e);
      if (!isExpectedPronoteError(e)) reportError("pronote-connect", e, { email });
      return { ok: false, error: humanizeError(e) };
    }
  });
}

export async function disconnectPronote(email: string): Promise<void> {
  const current = await loadState(email, { bypassCache: true });
  await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: undefined });
  invalidatePronoteStatus(email);
}

export async function pronoteConnected(email: string): Promise<{ connected: boolean; username?: string; needsReconnect?: boolean }> {
  // bypassCache: this is the direct "did my connect attempt register" read (called once on page load, once
  // right after connect/disconnect — never a tight poll), so the extra Supabase read is cheap. Without it, a
  // connect that landed on one Vercel lambda instance stayed invisible for up to 3min to a status check that
  // landed on a DIFFERENT warm instance still serving its own stale stateCache entry — same root cause as the
  // "flashcards saved but not showing" bug loadState's own comment describes, just for Pronote's connect flow.
  const current = await loadState(email, { bypassCache: true });
  const stored = current.pronote;
  if (!stored) return { connected: false };
  // Purge a leftover mock connection from before PRONOTE_MOCK was removed — an account that got seeded
  // with fake demo data (e.g. the env var mistakenly left on) must never keep reporting "connected" with
  // no real school behind it; clear it here so the student sees "not connected" and can do a real connect.
  if (stored.url === LEGACY_MOCK_URL) {
    await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: undefined });
    return { connected: false };
  }
  return { connected: true, username: stored.username, ...(stored.needsReconnect ? { needsReconnect: true } : {}) };
}

// Used to wrap pronoteConnected() in a per-instance in-memory cache for the hot /api/status path
// (client/App.tsx polls it every 45s, plus on every focus/visibility change). Removed entirely — that
// cache was a plain Map private to whichever single Vercel serverless instance handled a given request,
// keyed only by email (not by session), so it was effectively shared across every tab/device that happened
// to land on the same warm instance. A connect/disconnect could only invalidate the ONE instance that
// handled it; any other instance kept serving its own stale reading for up to the TTL — reported live as
// "connected but still shows Connect," and separately as "signed out of Pronote" right after logging into
// Otto or switching tabs (either one fires a fresh /api/status poll that can land on a different, stale
// instance). Shrinking the TTL (60s → 10s) only narrowed the window; it couldn't fix the actual problem,
// which is that in-memory per-instance state can never be authoritative across instances. pronoteConnected()
// below is already a single lightweight Supabase read (bypassCache) — calling it directly, uncached, trades
// a bit more read volume for this value actually being correct every time, which matters far more for a
// status a student is actively watching after taking an action than the read-volume savings did.
/** Invalidate after an explicit connect/disconnect — now a no-op (see removed connectedCache above) kept
 *  only so existing call sites don't need to change; pronoteConnected() has no cache left to invalidate. */
export function invalidatePronoteStatus(_email: string): void {}

// The rotated token is the one Pronote write where losing it means real account lockout (the OLD token
// is already dead on Pronote's own server the moment loginToken() returns) — unlike every other read in
// this pipeline, a dropped write here isn't just "try again next sweep," it's "the student has to
// re-enter their real password." A transient DB blip on this ONE call shouldn't cost that.
async function saveRotatedToken(email: string, rotated: StoredPronote): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // bypassCache: this fires on EVERY session open (a touch, a homework fetch, a sweep — token rotation
      // happens constantly, not just on connect), spread-merging current.profile/tasks unchanged into the
      // save. Reading a stale (up to 3min old) per-instance-cached profile/tasks here would silently REVERT
      // any more-recent change to either — a task just confirmed/dismissed, a preference just saved — the
      // instant Pronote's token next happened to rotate in the background. Same root cause as the token
      // staleness bug below, just with data-loss stakes instead of a spurious disconnect.
      const current = await loadState(email, { bypassCache: true });
      await saveState(email, { profile: current.profile, tasks: current.tasks, pronote: rotated });
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

/** Actively tells the student their Pronote session died, instead of leaving it as a passive badge in
 *  Settings they'd only see if they happened to open that page — every task Otto would otherwise have found
 *  from Pronote silently stops appearing the moment this happens, so it's worth a real nudge, not a quiet
 *  UI state. Best-effort and silent-fail like every other system email here: a missing/unconnected Gmail
 *  account just means no email goes out, never a thrown error back into the discovery pipeline. */
async function notifyPronoteReconnectNeeded(email: string, profile: Profile): Promise<void> {
  if (!(await connectionStatusesCached(email, ["gmail"]))["gmail"]) return; // no Gmail, nothing to send through
  const en = profile.language === "en";
  const subject = en ? "Otto — reconnect Pronote" : "Otto — reconnecte Pronote";
  const body = en
    ? `<p>Your Pronote session expired — Otto can't see your homework or tests until you reconnect.</p><p><a href="${process.env.PUBLIC_URL || "https://hiotto.vercel.app"}/settings">Reconnect Pronote →</a></p>`
    : `<p>Ta session Pronote a expiré — Otto ne peut plus voir tes devoirs ni tes contrôles tant que tu ne te reconnectes pas.</p><p><a href="${process.env.PUBLIC_URL || "https://hiotto.vercel.app"}/settings">Se reconnecter à Pronote →</a></p>`;
  await sendSystemEmail(email, { to: email, subject, body, primaryAccounts: profile.primaryAccounts });
}

/** Actually perform one login+fn pass, given a pre-built session and login promise — shared by both the
 *  token attempt and the credential-fallback attempt below so the "save rotated token, run fn, clean up
 *  the presence interval" logic exists exactly once. */
async function loginAndRun<T>(
  email: string, deviceUUID: string, loginPromise: Promise<{ url: string; username: string; kind: pronote.AccountKind; token: string; navigatorIdentifier?: string }>,
  session: pronote.SessionHandle, fn: (session: pronote.SessionHandle) => Promise<T>, extra: Partial<StoredPronote>,
): Promise<T> {
  const refresh = await loginPromise;
  const rotated: StoredPronote = { url: refresh.url, username: refresh.username, kind: refresh.kind, token: refresh.token, deviceUUID, navigatorIdentifier: refresh.navigatorIdentifier, lastTouchedAt: new Date().toISOString(), ...extra };
  await saveRotatedToken(email, rotated);
  try { return await fn(session); }
  finally { if (session.presence) pronote.clearPresenceInterval(session); }
}

/** Open a fresh Pronote session and run `fn` — token login first (fast, doesn't touch Pronote's own
 *  password-login rate limiting), and on a genuinely dead token (SessionExpiredError/BadCredentialsError,
 *  not a transient blip), SILENTLY fall back to a fresh credentialed login using the stored encrypted
 *  password before ever bothering the student. This is the fix for "Pronote keeps disconnecting": Pronote's
 *  rotating token dies for reasons entirely outside Otto's control (its own short session lifetime, opening
 *  the official Pronote app, general fragility) — previously that meant an immediate "reconnect" prompt;
 *  now it's just a second, invisible login attempt. `needsReconnect` only ever gets set when BOTH attempts
 *  fail with a credentials error — the one case that genuinely means the password itself is stale (changed
 *  at school) and truly needs the student. Never throws; a failure of both attempts returns undefined and is
 *  logged, same as before. */
async function runPronoteSessionOnce<T>(email: string, fn: (session: pronote.SessionHandle) => Promise<T>): Promise<T | undefined> {
  // bypassCache: the stored token is single-use/rotating — every successful login here immediately
  // supersedes it (saveRotatedToken above). A per-instance-cached read (up to 3min old) can hand back a
  // token that's ALREADY been rotated away by a session opened moments earlier on a different warm Vercel
  // instance, so the very first attempt below fails with SessionExpiredError before ever touching Pronote's
  // real current state. The credential-fallback path usually self-heals in that case, but it means a real,
  // avoidable extra login against Pronote's own server on nearly every touch/sweep/homework fetch — enough
  // of those in a row risk tripping Pronote's own rate limiter, which reads to the student as "it just
  // stopped working" after it's been running a while. Reported live as "disconnects about an hour later."
  const { pronote: stored } = await loadState(email, { bypassCache: true });
  if (!stored) return undefined;
  try {
    const session = pronote.createSessionHandle();
    return await loginAndRun(email, stored.deviceUUID, withPronoteTimeout("loginToken", pronote.loginToken(session, {
      url: stored.url, username: stored.username, kind: stored.kind as pronote.AccountKind, token: stored.token,
      deviceUUID: stored.deviceUUID, navigatorIdentifier: stored.navigatorIdentifier,
    })), session, fn, { password: stored.password });
  } catch (tokenErr: any) {
    if (!(tokenErr instanceof pronote.SessionExpiredError || tokenErr instanceof pronote.BadCredentialsError)) {
      console.warn("[pronote] session failed:", tokenErr?.message || tokenErr);
      if (!isExpectedPronoteError(tokenErr)) reportError("pronote-session", tokenErr, { email });
      return undefined;
    }
    if (!stored.password) {
      // Pre-existing connections made before the password-fallback fix have no stored password to fall
      // back to, so there's no second attempt to wait on — same behavior as before: flag immediately.
      await flagNeedsReconnect(email, stored, tokenErr, { immediate: true });
      return undefined;
    }
    try {
      const session2 = pronote.createSessionHandle();
      const result = await loginAndRun(email, stored.deviceUUID, withPronoteTimeout("loginCredentials", pronote.loginCredentials(session2, {
        url: stored.url, kind: stored.kind as pronote.AccountKind, username: stored.username, password: stored.password, deviceUUID: stored.deviceUUID,
      })), session2, fn, { password: stored.password });
      console.log(`${new Date().toISOString()} [pronote] token had died — self-healed via a fresh credentialed login, student never saw a reconnect prompt`);
      return result;
    } catch (credErr: any) {
      if (credErr instanceof pronote.SessionExpiredError || credErr instanceof pronote.BadCredentialsError) {
        // Both the token AND a fresh password login failed — the password itself is genuinely stale.
        await flagNeedsReconnect(email, stored, credErr);
      } else {
        console.warn("[pronote] session failed (credential fallback):", credErr?.message || credErr);
        if (!isExpectedPronoteError(credErr)) reportError("pronote-session-fallback", credErr, { email });
      }
      return undefined;
    }
  }
}

/** A genuinely dead token AND a dead password fallback (or no password stored to fall back to) looks
 *  identical to "no homework today" to every caller (pronoteHomework/Tests/Grades all collapse this to []) —
 *  flag it so pronoteConnected can tell the student to reconnect instead of silently showing an empty list
 *  forever. Best-effort: this must never throw on top of the real error being handled by the caller.
 *
 *  One-strike grace period (unless `immediate`): observed live — a student kept getting the "reconnect"
 *  email while Settings always showed "connected," because a single momentary Pronote-side blip (its own
 *  server briefly flaky/rate-limited, not the password actually being wrong) was enough to trip BOTH the
 *  token attempt and the immediate password-fallback attempt at once, get reported as "genuinely dead," and
 *  self-heal on the very next sweep/touch — by which point the email had already gone out for nothing. The
 *  FIRST double-failure now only records `firstFailedAt` (silent, no email); only a SECOND, separate
 *  double-failure while that's still set actually flags `needsReconnect` and notifies the student. A
 *  successful login in between (loginAndRun's full-replacement stored object) clears `firstFailedAt`
 *  automatically, so this is a real "confirmed twice" bar, not a fixed delay. `immediate` skips this for the
 *  no-stored-password case, which has no second attempt to wait on in the first place. */
async function flagNeedsReconnect(email: string, stored: StoredPronote, e: any, opts?: { immediate?: boolean }): Promise<void> {
  // bypassCache: same profile/tasks-clobbering risk as saveRotatedToken above — this write path runs
  // straight off the back of a failed session, so the account's cached state here could easily be minutes
  // stale by the time this fires.
  const current = await loadState(email, { bypassCache: true }).catch(() => undefined);
  if (current) {
    if (!opts?.immediate && !stored.firstFailedAt) {
      void saveState(email, { profile: current.profile, tasks: current.tasks, pronote: { ...stored, firstFailedAt: new Date().toISOString() } }).catch(() => {});
      console.warn("[pronote] session failed once (token + credential fallback) — waiting for a second failure before flagging reconnect:", e?.message || e);
      return;
    }
    void saveState(email, { profile: current.profile, tasks: current.tasks, pronote: { ...stored, needsReconnect: true } }).catch(() => {});
    // Direct instruction: don't just leave this as a passive Settings badge the student has to notice on
    // their own — actively tell them. Only on the FALSE→true transition (stored.needsReconnect was not
    // already set) so a broken connection doesn't re-email on every single sweep attempt while it stays
    // broken; the next successful reconnect clears needsReconnect entirely, so this fires again if it ever
    // breaks a second time, same as the first.
    if (!stored.needsReconnect) void notifyPronoteReconnectNeeded(email, current.profile).catch(() => {});
  }
  console.warn("[pronote] session failed (token + credential fallback both dead):", e?.message || e);
  if (!isExpectedPronoteError(e)) reportError("pronote-session", e, { email });
}

// Vercel Hobby's cron only runs once/day (see server/index.ts's /api/cron/drain comment), so the daily
// sweep is the only GUARANTEED session touch — leaving a token idle for a full day between refreshes gives
// Pronote's own server-side session TTL the most possible time to kill it before anything renews it. This
// closes that gap opportunistically: every time a connected student actually has the app open (client's
// periodic heartbeat, client/App.tsx), hit this — it just re-opens a session (rotating the token, exactly
// like a real sweep would) and does nothing else. Gated to at most once per few hours per account so an
// open tab doesn't hammer Pronote or burn the rotation budget for no reason.
const TOUCH_MIN_GAP_MS = 2 * 60 * 60 * 1000; // 2h — tightened from 4h, direct instruction to make this as reliable as possible
export async function touchPronoteSession(email: string): Promise<void> {
  const { pronote: stored } = await loadState(email, { bypassCache: true });
  if (!stored || stored.needsReconnect) return; // nothing to renew, or already dead — only a real reconnect fixes that
  if (stored.lastTouchedAt && Date.now() - Date.parse(stored.lastTouchedAt) < TOUCH_MIN_GAP_MS) return;
  await runPronoteSessionOnce(email, async () => undefined);
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
/** Homework due in the next `daysAhead` days (default 21), not yet marked done. Not the same window the AI
 *  classifier's forceWeekCoverage safety net (tasks.ts) guarantees a task for — that's deliberately
 *  narrower (WEEK_COVERAGE_DAYS, 7 days): something due 3 weeks out is still visible/read here, but doesn't
 *  necessarily get a task card until it's closer. */
// Pronote's assignment `description` is genuinely HTML (the school's own rich-text editor output) — e.g.
// `<div>Exercices n° : &quot;...&quot; <br> - Rédigez...</div>` — but every downstream consumer of this
// field (sourceDetail on WebTask, the "Instructions" panel, the AI prompt itself) treats it as plain text.
// Nothing else in the pipeline ever strips tags/decodes entities, so without this the raw markup was showing
// up verbatim to the student. `<br>`/block tags become a space (never silently glued two clauses together).
// Exported for tests (same precedent as pronoteToItems/normalizeAssignmentText in discover.ts).
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&hellip;/g, "…")
    // Numeric entities generically — was only matching the exact 2-digit &#39; before, so a school's editor
    // emitting the equally-valid zero-padded &#039; (observed live: literal "&#039;" showing up raw in a
    // task's instructions, e.g. "group&#039;s document") slipped through untouched. Decimal (&#39;) and hex
    // (&#x27;) forms both handled; any codepoint, not just apostrophe, so this doesn't need a new case every
    // time a school's export uses a different punctuation entity.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export async function pronoteHomework(email: string, daysAhead = 21): Promise<PronoteHomeworkItem[]> {
  const out = await withPronoteSession(email, async (session) => {
    const now = new Date();
    const end = new Date(now.getTime() + daysAhead * 86_400_000);
    const assignments = await withPronoteTimeout("assignmentsFromIntervals", pronote.assignmentsFromIntervals(session, now, end));
    return assignments
      .filter((a) => !a.done)
      .map((a): PronoteHomeworkItem => ({
        id: a.id,
        subject: a.subject?.name || "Homework",
        // Was capped at 400 — far too short for a real assignment's full instructions (a teacher's actual
        // énoncé regularly runs several paragraphs), and this is the one place that description gets cut
        // BEFORE anything downstream (forceWeekCoverage's own sourceDetail cap, tasks.ts) ever sees it, so
        // raising a cap further down the pipeline couldn't have fixed it — reported live: a real assignment's
        // instructions cut off mid-sentence ("...answering all three...The three…"). 3000 comfortably covers
        // any real assignment text a teacher would actually type into Pronote.
        description: stripHtml(String(a.description || "")).replace(/\s+/g, " ").trim().slice(0, 3000),
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
export const TEST_DAYS_AHEAD = 28;

/** Upcoming tests/exams (Pronote flags a lesson slot as "test") in the next `daysAhead` days. Pronote's
 *  timetable has no stable per-instance id across re-fetches, so the anchor identity used by the caller
 *  (discover.ts) is built from subject+date, not `id` alone — this "id" is only for display/de-dup within
 *  a single fetch. */
export async function pronoteTests(email: string, daysAhead = TEST_DAYS_AHEAD): Promise<PronoteTestItem[]> {
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
    // A DETERMINISTIC id (not randomUUID()) for Pronote-sourced rows — this is what actually guarantees "one
    // live value per subject" instead of just hoping findIndex matches every time. It didn't always: a sync
    // running against a profile copy that (for any reason — a race with another sync, a stale cloud-merge
    // snapshot) doesn't yet contain the prior day's row generated a FRESH random id, and mergeProfileStates
    // (tasks.ts) keys its union by id — so two different random ids for the same subject never collapsed
    // into one and just kept accumulating, one more every sync. Reported live as "Anglais · 40 grades" after
    // roughly 40 days of daily syncs. A stable id makes every sync — no matter which stale/fresh copy it ran
    // against — collide on the SAME key and actually overwrite, closing the bug at the source rather than
    // relying on findIndex's best-effort match.
    const id = i >= 0 ? list[i].id : `pronote:${g.subject.toLowerCase()}`;
    const entry = { id, subject: g.subject, grade: g.average, scale: g.outOf, updatedAt: now, source: "pronote" as const };
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
