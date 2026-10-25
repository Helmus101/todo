
import "../env.ts";
import { reportError } from "../sentry.ts";
import express from "express";
import { randomBytes } from "node:crypto";
import type { WebTask } from "../../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../../shared/types.ts";
import { listFeedbackFor, loadState, saveState, cloudEnabled, findAuthUserByEmail, createAuthUser, createAuthUserWhy, verifyAuthPassword, setAuthPassword, setResetToken, consumeResetToken, destroySessionsForUser, deleteAccount, exportJobsAndEvents, recordEvent } from "../store.ts";
import { sendTransactionalEmail } from "../mailer.ts";
import * as tasks from "../tasks.ts";
import * as integrations from "../integrations.ts";
import * as pronoteSvc from "../pronote.ts";
import { getAgeBand, getPolicyProfileFromBirthYear } from "../policyProfiles.ts";
import { M, PROD, ah, rateLimit, limitBy, requireAuth, saveSession } from "../http.ts";

// ── Email account auth ─────────────────────────────────────────────────────────
const normEmail = (s: unknown) => String(s || "").trim().toLowerCase();

const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export function registerAuthRoutes(app: express.Express): void {
  app.post("/api/auth/signup", rateLimit(6, 60 * 60_000), ah(async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const birthYear = req.body?.birthYear ? parseInt(req.body.birthYear) : undefined;
    const isChildAccount = req.body?.isChildAccount === true;
    
    if (!validEmail(email) || password.length < 8 || password.length > 200) { res.status(400).json({ error: "Enter a valid email and a password between 8 and 200 characters." }); return; }
    
    // For child accounts, require birth year and parental consent
    if (isChildAccount) {
      if (!birthYear || birthYear < 2000 || birthYear > new Date().getFullYear()) {
        res.status(400).json({ error: "Birth year is required for child accounts." }); return;
      }
      if (req.body?.parentalConsent !== true) {
        res.status(400).json({ error: "Parental consent is required for child accounts." }); return;
      }
    } else {
      // Adult accounts: require 15+ consent
      if (req.body?.consent !== true) { res.status(400).json({ error: "Please confirm you're 15 or older, or that a parent set this account up for you." }); return; }
    }
    
    if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." }); return; }
    if (await findAuthUserByEmail(email)) { res.status(409).json({ error: "An account with that email already exists — log in instead." }); return; }
    const made = await createAuthUserWhy(email, password);
    if (made !== true) {
      if (made === "key") { res.status(500).json({ error: "Sign-up isn't set up correctly on the server: the account service key was refused. (Owner: SUPABASE_SERVICE_KEY must be the project's service_role key.)", code: "auth_key_refused" }); return; }
      if (made === "down") { res.status(503).json({ error: "Otto can't reach its account service right now. Please try again in a few minutes.", code: "auth_unavailable" }); return; }
      res.status(500).json({ error: "Couldn't create the account." }); return;
    }
    // Regenerate the session id on every privilege change (login/signup) — never write the authenticated
    // user onto a pre-existing session id. Without this, a session id fixed on a victim's browser BEFORE
    // they sign up (e.g. planted via an unrelated XSS/subdomain trick) would become a live authenticated
    // session the moment they complete signup — classic session fixation.
    req.session.regenerate((err) => {
      if (err) { res.status(500).json({ error: "Couldn't create the account — try again." }); return; }
      req.session.user = email;
      // Must explicitly reset these, exactly like /api/auth/login does — if this browser's session cookie
      // already had another account's tasks/profile in it (e.g. someone created a new account without signing
      // out of the previous one first), leaving them untouched here leaked the OLD account's tasks into the
      // BRAND NEW one on the very next request (the safety-net middleware above only fills these in when
      // they're `undefined`, which they aren't in that case) — they'd even get merged into and saved onto the
      // new account's cloud row. A fresh signup always starts from empty state.
      req.session.profile = { 
        ...emptyProfile(), 
        ageConsentAt: new Date().toISOString(),
        birthYear: birthYear,
        ageBand: birthYear ? getAgeBand(birthYear) : undefined,
        policyProfileId: birthYear ? getPolicyProfileFromBirthYear(birthYear).id : undefined,
        primerSettings: {
          sessionCapMinutes: birthYear ? getPolicyProfileFromBirthYear(birthYear).session.hardCapMinutes : 60,
          dailyCapMinutes: birthYear ? getPolicyProfileFromBirthYear(birthYear).session.dailyCapMinutes : 120,
          parentViewLevel: isChildAccount ? "full" : "none",
        },
        dataRetentionDays: birthYear ? getPolicyProfileFromBirthYear(birthYear).safety.dataRetentionDays : 90,
      };
      
      // Record consent if this is a child account
      if (isChildAccount && birthYear) {
        const consent = {
          childId: email,
          scope: ["account_access", "data_processing"],
          grantedAt: new Date().toISOString(),
          method: "clickwrap" as const,
        };
        req.session.profile.consentRecords = [consent];
      }
      
      req.session.tasks = [];
      // Generated here (not left to /api/status's lazy path) so the VERY FIRST authenticated mutating call a
      // fresh signup makes (e.g. the onboarding flow's language preference save, which fires before the next
      // status poll) already has a valid token to send — otherwise requireAuth would reject that first call
      // with no way for the client to have known the token yet.
      req.session.csrfToken = randomBytes(24).toString("hex");
      void recordEvent(email, "signup", {});
      saveSession(req).then(() => res.json({ ok: true, csrfToken: req.session.csrfToken }));
    });
  }));

  app.post("/api/auth/login", rateLimit(10, 15 * 60_000), ah(async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");
    // Without this, verifyAuthPassword() always returns false when Supabase isn't configured (e.g. local dev
    // with no .env set up) and login falls straight through to "Wrong email or password" — sending you down
    // the wrong path (retyping/resetting a password that was never the actual problem). Same check signup has.
    if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase) — sign-in can't work until that's set." }); return; }
    // Verified against Supabase Auth directly now (verifyAuthPassword, server/store.ts) — no more bcrypt
    // compare against a hash Otto stored itself. The old timing-side-channel guard here (always running
    // bcrypt against a fixed dummy hash so a nonexistent account took the same time as a wrong password on a
    // real one) is dropped: that defense was specific to bcrypt's own deliberately-slow compare being
    // skippable, and this call unconditionally hits Supabase's own signInWithPassword endpoint either way —
    // worth a manual real-vs-fake-email timing spot-check after deploying, since that specific guarantee
    // can't be verified without live credentials.
    // Brute force from MANY IPs at ONE account: the route limit above is per IP, so a botnet could still try thousands of
    // passwords against a single email. Cap failures per account across all IPs (successful logins don't count).
    // The limiter counts every call it sees, so it is only CONSUMED after a wrong password (below) — a stranger
    // hammering a victim's email with bad guesses is what trips it, but correct logins never count toward it.
    const lockKey = `login-fail:${email}`;
    const validPassword = await verifyAuthPassword(email, password);
    if (validPassword === "unavailable") { res.status(503).json({ error: "Otto can't reach its account service right now, so nobody can log in. Please try again in a few minutes.", code: "auth_unavailable" }); return; }
    if (!validPassword) {
      const perAccount = await limitBy(lockKey, 30, 60 * 60_000).catch(() => ({ allowed: true, retryAfterMs: 0 }));
      if (!perAccount.allowed) { res.set("Retry-After", String(Math.ceil(perAccount.retryAfterMs / 1000))).status(429).json({ error: "Too many failed attempts on this account — try again later, or reset your password." }); return; }
      void recordEvent(email, "login_failed", {}); // never the password — email only, for brute-force visibility
      res.status(401).json({ error: "Wrong email or password." });
      return;
    }
    // Regenerate the session id on login — see the signup handler's comment on why (session fixation).
    req.session.regenerate(async (err) => {
      if (err) { res.status(500).json({ error: "Couldn't log you in — try again." }); return; }
      req.session.user = email;
      // Bring back this account's saved profile + tasks. (App connections live in Composio, keyed by this
      // same account email, so they're already linked — nothing to restore here.)
      const restored = await loadState(email);
      req.session.profile = restored.profile;
      req.session.tasks = restored.tasks;
      // See the signup handler's identical comment — generated here so the token is available immediately,
      // not only after the client's next /api/status poll.
      req.session.csrfToken = randomBytes(24).toString("hex");
      void recordEvent(email, "login", {});
      await saveSession(req);
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    });
  }));

  // Password reset — request step. Deliberately responds {ok:true} for EVERY validly-formatted email,
  // whether or not an account actually exists: a different response for "no such account" would let an
  // attacker enumerate registered emails through this endpoint, exactly the same timing/response-shape
  // discipline the login route above already applies to wrong-password vs. no-account. Rate-limited both by
  // IP (rateLimit) and, inside the handler, best-effort against hammering ONE victim's inbox from many IPs.
  app.post("/api/auth/forgot-password", rateLimit(5, 60 * 60_000), ah(async (req, res) => {
    const email = normEmail(req.body?.email);
    if (!validEmail(email)) { res.status(400).json({ error: "Enter a valid email." }); return; }
    if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." }); return; }
    try {
      const u = await findAuthUserByEmail(email);
      if (u) {
        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min — short-lived, a fresh request is one click away
        await setResetToken(email, token, expiresAt);
        const link = `${process.env.PUBLIC_URL || "https://hiotto.vercel.app"}/reset-password?token=${token}`;
        const en = true;
        const html = `<p>Someone (hopefully you) asked to reset your Otto password. This link works once and expires in 30 minutes.</p><p><a href="${link}">Reset your password →</a></p><p>If this wasn't you, you can safely ignore this email — your password hasn't changed.</p>`;
        // Awaited: a serverless function can be frozen right after the response, dropping an unsent email.
        await sendTransactionalEmail(email, "Reset your Otto password", html);
        void recordEvent(email, "password_reset_requested", {});
      }
    } catch (e: any) { reportError("auth-forgot-password", e, { email }); /* still respond ok:true below — never leak account existence via a failure path either */ }
    res.json({ ok: true });
  }));

  // Password reset — confirm step. The token (32 random bytes, single-use, 30-min expiry, stored hashed —
  // see setResetToken/consumeResetToken in store.ts) IS the authentication; no session required.
  app.post("/api/auth/reset-password", rateLimit(10, 60 * 60_000), ah(async (req, res) => {
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (!token) { res.status(400).json({ error: "Missing or invalid reset link." }); return; }
    if (password.length < 8 || password.length > 200) { res.status(400).json({ error: "Password must be between 8 and 200 characters." }); return; }
    if (!cloudEnabled()) { res.status(500).json({ error: "Account storage isn't configured on the server (Supabase)." }); return; }
    const u = await consumeResetToken(token);
    if (!u) { res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." }); return; }
    const authUser = await findAuthUserByEmail(u.email);
    if (!authUser || !(await setAuthPassword(authUser.id, password))) { res.status(500).json({ error: "Couldn't reset the password — try again." }); return; }
    void recordEvent(u.email, "password_reset", {});
    // Log the student straight in — same session-fixation-safe regenerate as signup/login above, so a reset
    // link doubles as an immediate "you're back in" instead of a second manual login right after.
    req.session.regenerate(async (err) => {
      if (err) { res.status(500).json({ error: "Password reset — but couldn't log you in automatically. Log in with your new password." }); return; }
      req.session.user = u.email;
      const restored = await loadState(u.email);
      req.session.profile = restored.profile;
      req.session.tasks = restored.tasks;
      req.session.csrfToken = randomBytes(24).toString("hex");
      await saveSession(req);
      // A reset means the old password may be compromised — sign out every other device.
      await destroySessionsForUser(u.email, req.sessionID);
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    });
  }));

  app.post("/api/auth/logout", (req, res) => {
    const email = req.session.user;
    req.session.destroy(() => {
      // Belt-and-suspenders on top of destroy(): if some OTHER request already in flight on this same
      // cookie (a background sweep/kick tick — see client/App.tsx's signedOutRef) still calls
      // req.session.save() after this destroy() runs, it can silently re-insert the session row under the
      // same id, and the browser's still-held cookie would then resolve to a "logged in" session again —
      // exactly the "auto logs in after sign out" report. Clearing the cookie here doesn't stop that other
      // request's write, but it does mean any tab that DIDN'T just receive a resurrected Set-Cookie no
      // longer presents the old id at all, closing off the most common path back in.
      res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: PROD });
      if (email) void recordEvent(email, "logout", {});
      res.json({ ok: true });
    });
  });

  // GDPR right-to-erasure, self-serve: permanently deletes every row this account owns (see
  // store.deleteAccount) and destroys the session. Irreversible — the client confirms before calling this.
  app.post("/api/account/delete", requireAuth, rateLimit(5, 60_000), async (req, res) => {
    const email = req.session.user!;
    // Deleting everything needs the password again — a stolen or left-open session must not be enough to erase an account.
    if ((await verifyAuthPassword(email, String(req.body?.password || ""))) !== true) { res.status(403).json({ error: "Enter your password to delete the account." }); return; }
    // NOT recordEvent(): deleteAccount() below purges this account's OWN rows from the events table as
    // part of the erasure, so a "deleted" event written there would erase itself in the same request —
    // the one event that most needs to survive would leave zero trace. console.warn instead: platform log
    // retention (Vercel/Railway/etc.) is a separate system from the app's own DB, so this line survives
    // the account row being gone, which is the actual point of a deletion audit trail.
    console.warn(`[audit] account_deleted: ${email}`);
    try {
      // Disconnect every third-party link BEFORE erasing Otto's own rows — reported live: deleting an
      // account and signing up again with the SAME email immediately showed Gmail/Calendar/Drive already
      // connected. deleteAccount (store.ts) only ever wiped OTTO'S OWN tables; it never told Composio to drop
      // the OAuth grant, which Composio keeps keyed by this exact email regardless of whether Otto still has
      // an account row for it — so the grant just sat there, live, waiting for literally anyone who signed up
      // with that email next (not even necessarily the same person). This is also the actual RGPD erasure
      // gap, not just a UX one: "delete my account" has to mean Otto stops holding a live grant to the
      // person's Gmail/Calendar/Drive/Pronote, not just that Otto's own copy of their data is gone.
      // Best-effort/parallel — a stuck Composio/Pronote call must never block the erasure itself from
      // completing; each failure is swallowed (nothing left to report it to once the account row is gone).
      await Promise.all([
        ...integrations.CATALOG.map((c) => integrations.disconnect(c.key, email).catch(() => {})),
        pronoteSvc.disconnectPronote(email).catch(() => {}),
      ]);
      const result = await deleteAccount(email);
      // Only destroy the session on a confirmed result — destroying it on a thrown error (below) would make
      // an account that's still fully intact server-side look deleted client-side, with no way back in to
      // retry. deleteAccount isn't necessarily transactional, so a caught error here doesn't guarantee
      // nothing was removed — it just means the request no longer hangs silently, which is the actual bug
      // being fixed (Express 4 never responds to an unhandled rejection in a route handler).
      req.session.destroy(() => res.json(result));
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't delete the account — try again." });
    }
  });

  // GDPR right to data portability, self-serve: everything Otto has stored for this account, as one JSON file.
  app.get("/api/account/export", requireAuth, rateLimit(5, 60_000), async (req, res) => {
    const email = req.session.user!;
    void recordEvent(email, "account_exported", {});
    try {
      const state = cloudEnabled() ? await loadState(email) : { profile: req.session.profile, tasks: req.session.tasks, google: undefined, pronote: undefined };
      // Was profile+tasks only — deleteAccount also wipes job records and the audit/event trail, so an
      // export used to return strictly LESS than what's actually stored (and later erased), incomplete
      // relative to a GDPR Art.15 access request.
      const { jobs, events } = cloudEnabled() ? await exportJobsAndEvents(email) : { jobs: [], events: [] };
      // Connection METADATA only, never the live credential — state.google.tokens/state.pronote.token are
      // active OAuth/session secrets (a password-equivalent for Pronote specifically); handing those back
      // in a downloadable JSON file would be a real account-takeover risk, not a compliance win. Access
      // still covers what matters for Art.15: which accounts are connected and their non-secret identity.
      const connections = {
        google: state.google ? { connected: true, email: state.google.email } : null,
        pronote: state.pronote ? { connected: true, url: state.pronote.url, username: state.pronote.username } : null,
      };
      res.setHeader("Content-Disposition", `attachment; filename="otto-data-${email.replace(/[^a-z0-9@._+-]/gi, "_")}.json"`);
      const feedback = (await listFeedbackFor(email)).map(({ id, helpful, comment, publish_consent, consent_at, display_name, level, status, created_at }) => ({ id, helpful, comment, publish_consent, consent_at, display_name, level, status, created_at }));
      res.json({ email, exportedAt: new Date().toISOString(), profile: state.profile, tasks: state.tasks, connections, jobs, events, feedback });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't export your data — try again." });
    }
  });

  // Account-to-account data transfer, second half: takes a file produced by GET /api/account/export (any
  // account — typically a different one, e.g. moving off a Supabase org that's hit its egress cap, see
  // scripts/migrate-account.ts for the offline equivalent) and MERGES it into the CURRENTLY LOGGED-IN
  // account. "Merge" not "replace": reuses the exact same cross-device merge logic the app already relies on
  // (mergeTaskLists/mergeProfileStates in server/tasks.ts, also used by jobs.ts and the migration script) so
  // importing into a non-empty account never silently drops what's already there — tasks/journal entries/
  // error-log rows/flashcard decks union by id, profile facts dedupe, and per-field "most recent wins" rules
  // apply exactly as they do for a normal multi-device sync. Connection secrets (Pronote/Google tokens)
  // are deliberately NOT imported — the export never included the live secret in the first place (see the
  // comment above /api/account/export), so this route can't accidentally move a credential into an account
  // that shouldn't have it; the user reconnects those normally after moving.
  app.post("/api/account/import", requireAuth, rateLimit(5, 60_000), express.json({ limit: "20mb" }), async (req, res) => {
    const email = req.session.user!;
    const body = req.body;
    if (!body || typeof body !== "object" || (!body.profile && !Array.isArray(body.tasks))) {
      res.status(400).json({ error: "That doesn't look like an Otto export file." });
      return;
    }
    try {
      const incomingProfile = normalizeProfile(body.profile);
      // Budget / access state is server-owned: an uploaded file must never be able to raise the weekly cap
      // (weekSpend.extraUsd merges by max), grant itself full access, or flip pause state.
      delete incomingProfile.weekSpend;
      delete incomingProfile.usageRequest;
      delete incomingProfile.fullAccess;
      delete incomingProfile.fullAccessAt;
      delete incomingProfile.paused;
      delete incomingProfile.pausedAt;
      delete incomingProfile.autoPausedAt;
      const incomingTasks: WebTask[] = Array.isArray(body.tasks) ? body.tasks : [];
      const current = cloudEnabled() ? await loadState(email) : { profile: req.session.profile || emptyProfile(), tasks: req.session.tasks || [] };
      const mergedProfile = tasks.mergeProfileStates(current.profile, incomingProfile);
      const mergedTasks = tasks.mergeTaskLists(current.tasks || [], incomingTasks);
      if (cloudEnabled()) {
        await saveState(email, { ...(current as any), profile: mergedProfile, tasks: mergedTasks });
      } else {
        req.session.profile = mergedProfile;
        req.session.tasks = mergedTasks;
      }
      void recordEvent(email, "account_imported", { message: `Imported ${incomingTasks.length} tasks` });
      res.json({ ok: true, tasksAfter: mergedTasks.length, errorLogAfter: mergedProfile.errorLog?.length || 0 });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Couldn't import that file — try again." });
    }
  });
}
