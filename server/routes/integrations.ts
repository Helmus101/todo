
import "../env.ts";
import { reportError } from "../sentry.ts";
import express from "express";
import { randomBytes } from "node:crypto";
import { emptyProfile } from "../../shared/types.ts";
import { recordMetric } from "../store.ts";
import * as integrations from "../integrations.ts";
import * as pronoteSvc from "../pronote.ts";
import * as blackbaudSvc from "../blackbaud.ts";
import { M, ah, commit, rateLimit, requireAuth, saveSession } from "../http.ts";

export function registerIntegrationRoutes(app: express.Express): void {
  // Google now connects through Composio (Gmail / Calendar / Docs / Slides / Drive / Sheets) like every other
  // app — see the integration routes below. (The old direct-OAuth /auth/google flow has been retired.)

  // ── Integrations (Composio: Google, Slack, GitHub, Notion, Linear, …) ───────────
  // List the catalog + which the account has connected (status is queried LIVE from Composio per account).
  app.get("/api/integrations", requireAuth, ah(async (req, res) => {
    const ready = integrations.integrationsReady();
    const apps = integrations.CATALOG.map((c) => c.key);
    const statuses = ready ? await integrations.getAllConnectionStatuses(req.session.user!, apps, req.session.integrations || {}) : {};
    res.json({
      ready,
      items: integrations.CATALOG.map((c) => ({ key: c.key, name: c.name, blurb: c.blurb, category: c.category, logo: integrations.logoFor(c.toolkit), connected: !!(statuses as any)[c.key] })),
    });
  }));

  // Get connected accounts for a specific app (supports multiple accounts)
  app.get("/api/integrations/:app/accounts", requireAuth, ah(async (req, res) => {
    const app2 = String(req.params.app);
    if (!integrations.CATALOG.some((c) => c.key === app2)) { res.status(404).json({ error: M(req, "Intégration inconnue.", "Unknown integration.") }); return; }
    const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2, true) : [];
    res.json({ accounts });
  }));

  // GET so a plain <a href> can carry the user through the OAuth redirect (like /auth/google).
  app.get("/integrations/:app/connect", requireAuth, async (req, res) => {
    try {
      if (!integrations.integrationsReady()) { res.status(500).send("Integrations aren't configured on the server (COMPOSIO_API_KEY)."); return; }
      const app2 = String(req.params.app);
      if (!integrations.CATALOG.some((c) => c.key === app2)) { res.status(404).send("Unknown integration."); return; }
      const callbackUrl = `${process.env.PUBLIC_URL || `http://localhost:5273`}/integrations/callback`;
      const { redirectUrl, connectionId } = await integrations.initiateConnection(app2, req.session.user!, callbackUrl);
      (req.session.integrations ||= {})[app2] = connectionId;
      integrations.invalidateTools(req.session.user!);
      void recordMetric(req.session.user!, "integration_connected", 1, app2);
      req.session.save(() => res.redirect(redirectUrl));
    } catch (e: any) { reportError("integration-connect", e); res.status(500).send("Couldn't start the connection — please try again."); }
  });

  // Composio sends the user back here after OAuth — bounce to Settings, where status re-checks live.
  app.get("/integrations/callback", (_req, res) => res.redirect("/settings"));

  // ── Pronote — parallel to the Composio-routed integrations above: no OAuth exists, so this is a plain
  // credential form instead of a redirect. READ-ONLY (homework); never wired into the agent's toolset.
  app.get("/api/integrations/pronote/status", requireAuth, ah(async (req, res) => {
    res.json(await pronoteSvc.pronoteConnected(req.session.user!));
  }));

  app.post("/api/integrations/pronote/connect", requireAuth, rateLimit(8, 15 * 60_000), async (req, res) => {
    const { url, username, password, kind } = req.body || {};
    if (typeof url !== "string" || typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: M(req, "L'URL, l'identifiant et le mot de passe sont requis.", "URL, username and password are required.") }); return;
    }
    try {
      const result = await pronoteSvc.connectPronote(req.session.user!, { url, username, password, kind: Number(kind) || undefined });
      if (result.ok) pronoteSvc.invalidatePronoteStatus(req.session.user!); // else /api/status's cache keeps reporting "not connected" for up to 60s
      if (result.ok) void recordMetric(req.session.user!, "pronote_sync", 1);
      // Pull grades right away on a fresh connect — otherwise a student wouldn't see any until the next daily
      // sweep or a manual "Sync from Pronote" click, and "I just connected Pronote" is exactly the moment
      // grades should already be there. Best-effort: never fails the connect itself.
      if (result.ok) {
        try {
          const p = (req.session.profile ||= emptyProfile());
          pronoteSvc.applyPronoteGrades(p, await pronoteSvc.pronoteGrades(req.session.user!));
          await pronoteSvc.syncPronoteLessons(p, req.session.user!);
          await commit(req);
        } catch { /* best-effort */ }
      }
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: M(req, "Impossible de se connecter à Pronote — réessaie.", "Couldn't connect to Pronote — try again.") }); }
  });

  // Upcoming tests for the dashboard's exam countdown strip — a plain read, separate from the task pipeline
  // (a test already has/will have a task, but the countdown needs the raw subject+date list to lay out as a
  // timeline rather than dig it back out of task titles).
  app.get("/api/pronote/tests", requireAuth, async (req, res) => {
    const manual = (req.session.profile?.manualExams || []).map((e) => ({ subject: e.subject, deadline: e.deadline }));
    try {
      const conn = await pronoteSvc.pronoteConnected(req.session.user!);
      if (!conn.connected) { res.json({ tests: manual }); return; }
      const tests = await pronoteSvc.pronoteTests(req.session.user!);
      res.json({ tests: [...tests.map((t) => ({ subject: t.subject, deadline: t.deadline })), ...manual] });
    } catch { res.json({ tests: manual }); }
  });

  // Opportunistic session-keepalive — see touchPronoteSession's own comment (server/pronote.ts) for why this
  // exists: the daily cron sweep alone leaves a token idle long enough that Pronote's own session TTL can
  // kill it before anything renews it. The client calls this on its normal periodic heartbeat (whenever a
  // connected student actually has the app open); the function itself is gated to at most once per few hours
  // so this adds no real load. Fire-and-forget from the client's point of view — always 200s immediately,
  // since a touch failing here just means "no better off than before," never worse.
  // GET (not POST) so it bypasses CSRF entirely — this is a read-only keepalive that changes no state, so
  // there's no CSRF risk to protect against, and a POST needlessly 403-ed in production when the session
  // token was momentarily stale (the exact "pronote/touch 403" report).
  app.get("/api/pronote/touch", requireAuth, rateLimit(10, 60_000), async (req, res) => {
    void pronoteSvc.touchPronoteSession(req.session.user!).catch(() => {});
    res.json({ ok: true });
  });

  app.post("/api/integrations/pronote/disconnect", requireAuth, async (req, res) => {
    try {
      await pronoteSvc.disconnectPronote(req.session.user!);
      pronoteSvc.invalidatePronoteStatus(req.session.user!);
      res.json({ ok: true });
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: M(req, "Impossible de déconnecter Pronote — réessaie.", "Couldn't disconnect Pronote — try again.") }); }
  });

  // Read-only: the raw Pronote grade averages, for anything that just wants to display them.
  app.post("/api/pronote/grades/sync", requireAuth, rateLimit(6, 60_000), async (req, res) => {
    try {
      const live = await pronoteSvc.pronoteGrades(req.session.user!);
      if (!live.length) { res.status(502).json({ error: M(req, "Pronote n'a renvoyé aucune note. Vérifie la période en cours et la connexion.", "Pronote returned no subject grades. Check the current period and connection.") }); return; }
      const profile = (req.session.profile ||= emptyProfile());
      pronoteSvc.applyPronoteGrades(profile, live);
      await pronoteSvc.syncPronoteLessons(profile, req.session.user!);
      await commit(req);
      res.json({ grades: live, synced: true });
    } catch (e: any) {
      console.error(e);
      res.status(502).json({ error: M(req, "Impossible de récupérer les notes depuis Pronote.", "Could not pull grades from Pronote.") });
    }
  });

  app.get("/api/pronote/grades", requireAuth, async (req, res) => {
    const cached = (req.session.profile?.grades || [])
      .filter((grade) => grade.source === "pronote")
      .map((grade) => ({ subject: grade.subject, average: grade.grade, outOf: grade.scale }));
    try {
      const conn = await pronoteSvc.pronoteConnected(req.session.user!);
      if (!conn.connected) { res.json({ grades: cached }); return; }
      const live = await pronoteSvc.pronoteGrades(req.session.user!);
      if (live.length) {
        const profile = (req.session.profile ||= emptyProfile());
        pronoteSvc.applyPronoteGrades(profile, live);
        await commit(req);
      }
      res.json({ grades: live.length ? live : cached });
    } catch { res.json({ grades: cached }); }
  });

  // Blackbaud (school Education Management — assignments/grades) — see blackbaud.ts's file-level comment.
  // Real OAuth flow (auth-url → redirect → callback) needs BLACKBAUD_CLIENT_ID/SECRET on top of the
  // subscription key; connect-mock is the always-available fallback (BLACKBAUD_MOCK=1) with no credentials.
  app.get("/api/integrations/blackbaud/status", requireAuth, ah(async (req, res) => {
    res.json({
      ...(await blackbaudSvc.blackbaudConnected(req.session.user!)),
      configured: blackbaudSvc.blackbaudConfigured(),
      realAuthAvailable: blackbaudSvc.blackbaudRealAuthAvailable(),
    });
  }));

  // GET so a plain <a href> can carry the student through the redirect, same as /integrations/:app/connect.
  app.get("/api/integrations/blackbaud/connect", requireAuth, (req, res) => {
    if (!blackbaudSvc.blackbaudRealAuthAvailable()) { res.status(503).send("Blackbaud isn't configured for real connections on this server yet."); return; }
    const state = randomBytes(24).toString("hex");
    req.session.blackbaudOAuthState = state;
    req.session.save(() => {
      try { res.redirect(blackbaudSvc.getAuthUrl(state)); }
      catch (e: any) { reportError("integration-connect", e); res.status(500).send("Couldn't start the connection — please try again."); }
    });
  });

  app.get("/api/integrations/blackbaud/callback", requireAuth, ah(async (req, res) => {
    const expected = req.session.blackbaudOAuthState;
    req.session.blackbaudOAuthState = undefined;
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    // Same CSRF-nonce verification every OAuth callback needs — without it, a forged callback (an attacker
    // tricking a student into visiting a crafted callback URL) could link the ATTACKER's Blackbaud account to
    // the VICTIM's Otto session, not just fail harmlessly.
    if (!expected || state !== expected || !code) { res.redirect("/settings?blackbaud_error=1"); return; }
    const result = await blackbaudSvc.exchangeCode(req.session.user!, code);
    res.redirect(result.ok ? "/settings" : "/settings?blackbaud_error=1");
  }));

  app.post("/api/integrations/blackbaud/connect-mock", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
    const result = await blackbaudSvc.connectMock(req.session.user!);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  }));

  app.post("/api/integrations/blackbaud/disconnect", requireAuth, async (req, res) => {
    try { await blackbaudSvc.disconnectBlackbaud(req.session.user!); res.json({ ok: true }); }
    catch (e: any) { console.error(e);
      res.status(500).json({ error: M(req, "Impossible de déconnecter — réessaie.", "Couldn't disconnect — try again.") }); }
  });

  app.post("/api/integrations/:app/disconnect", requireAuth, async (req, res) => {
    const app2 = String(req.params.app);
    try {
      const result = integrations.integrationsReady() ? await integrations.disconnect(app2, req.session.user!) : { ok: true };
      if (req.session.integrations) delete req.session.integrations[app2];
      integrations.invalidateTools(req.session.user!);
      void recordMetric(req.session.user!, "integration_disconnected", 1, app2);
      await saveSession(req);
      res.json(result);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: M(req, "Impossible de déconnecter — réessaie.", "Couldn't disconnect — try again.") }); }
  });

  // Disconnect a specific account by ID (for multi-account support)
  app.post("/api/integrations/:app/disconnect/:accountId", requireAuth, async (req, res) => {
    const app2 = String(req.params.app);
    const accountId = String(req.params.accountId);
    try {
      // Verify the account belongs to this user and app before disconnecting
      const accounts = integrations.integrationsReady() ? await integrations.getConnectedAccounts(req.session.user!, app2) : [];
      const account = accounts.find((a) => a.id === accountId);
      if (!account) { res.status(404).json({ error: M(req, "Compte introuvable.", "Account not found.") }); return; }
      const result = await integrations.disconnectAccount(accountId);
      integrations.invalidateTools(req.session.user!);
      await saveSession(req);
      res.json(result);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: M(req, "Impossible de déconnecter — réessaie.", "Couldn't disconnect — try again.") }); return; }
  });
}
