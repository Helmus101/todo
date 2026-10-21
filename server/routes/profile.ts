
import "../env.ts";
import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { emptyProfile, isValidTz, monthCostUsd, addUsage, learnedProductiveHour } from "../../shared/types.ts";
import { aiReady, generateThemeTokens } from "../claude.ts";
import { loadState, saveState, cloudEnabled, recordEvent, loadBanditState, recordMetric, getAdminMetrics } from "../store.ts";
import { contextKey as banditContextKey, chooseArm, DENSITY_ARMS } from "../bandit.ts";
import { predictNextEngagement, predictWeakSubjects, aggregateSubjectSignals } from "../patterns.ts";
import * as tasks from "../tasks.ts";
import * as integrations from "../integrations.ts";
import { M, ah, commit, isAdmin, isPaused, rateLimit, requireAuth } from "../http.ts";

// ── Profile (who the user is) — available once logged in ───────────────────────
const listKey = (c: string) => (c === "preference" ? "preferences" : c === "person" ? "people" : c === "project" ? "projects" : c === "course" ? "courses" : "");

export function registerProfileRoutes(app: express.Express): void {
  app.post("/api/settings/pause", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      p.paused = req.body?.paused === true;
      p.pausedAt = new Date().toISOString();
      if (p.paused) { p.autoPausedAt = undefined; } else { p.autoPausedAt = undefined; p.autoResumedAt = p.pausedAt; }
      void recordEvent(req.session.user!, "settings_changed", { message: p.paused ? "AI paused" : "AI resumed" });
      void recordMetric(req.session.user!, "ai_paused_toggled", p.paused ? 1 : 0);
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save — try again." }); }
  });

  // Live integration check — create → verify → clean up against the REAL connected account, on the user's
  // explicit click. No AI involved (direct hardcoded steps), so it works even while AI is paused.
  app.post("/api/settings/smoke", requireAuth, rateLimit(3, 60_000), async (req, res) => {
    try {
      const results = await integrations.runSmokeTest(req.session.user!);
      void recordEvent(req.session.user!, "smoke_test", { message: `${results.filter((r) => r.ok).length}/${results.length} checks passed` });
      res.json(results);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "integration check failed" }); }
  });

  // Fifth bandit target: overall UI density (see DENSITY_ARMS in bandit.ts) — app-wide, not Study-Mode-scoped,
  // so this lives under /api/ui rather than /api/study. Never suggested at all once the student has picked one
  // manually (profile.uiDensity) — a manual choice always wins and this route becomes a no-op confirmation of
  // it, never silently overriding it.
  app.get("/api/ui/density-suggestion", requireAuth, ah(async (req, res) => {
    try {
      if (req.session.profile?.uiDensity) { res.json({ density: req.session.profile.uiDensity, manual: true }); return; }
      if (!req.session.profile?.betaFeatures) { res.json({ density: "cozy", manual: false, coldStart: true }); return; }
      const key = banditContextKey(new Date(), req.session.profile);
      const state = await loadBanditState(req.session.user!, "density");
      const { arm, coldStart } = chooseArm(DENSITY_ARMS, state, key);
      res.json({ density: arm.id, manual: false, coldStart });
    } catch {
      res.json({ density: "cozy", manual: false, coldStart: true });
    }
  }));

  // AI-personalized theme — explicitly opt-in (a Settings button click, never automatic/periodic) and rare
  // (rate-limited hard). See generateThemeTokens's own doc comment in claude.ts for the full safety story:
  // the model proposes values for a small fixed allowlist only, every value is independently re-validated
  // (format + WCAG contrast) before it's ever stored, and normalizeProfile re-checks it again on every load.
  app.post("/api/ui/theme-personalize", requireAuth, rateLimit(5, 60_000), ah(async (req, res) => {
    // Beta-gated (defense in depth — the client button is already hidden when off, but the route itself
    // must not trust that alone). See Profile.betaFeatures' own doc comment.
    if (!req.session.profile?.betaFeatures) { res.status(403).json({ error: "Beta features are off — turn them on in Settings to try this." }); return; }
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to personalize your theme." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    try {
      const profile = req.session.profile ||= emptyProfile();
      // A short, factual summary — no free text from the student goes into this prompt, just already-computed
      // signals, so there's nothing here for a prompt-injection attempt to even ride in on.
      const density = profile.uiDensity || (learnedProductiveHour(profile) !== null ? "cozy (learned)" : "cozy (default)");
      const peakHour = learnedProductiveHour(profile);
      const engagement = predictNextEngagement(profile);
      const weakSubjects = predictWeakSubjects(aggregateSubjectSignals(req.session.tasks || []));
      const summary = `Preferred UI density: ${density}. ` +
        (peakHour !== null ? `Most active around ${peakHour}:00 local time.` : "Not enough activity history yet for a time-of-day pattern.") +
        (engagement && engagement.hour >= 20 ? " Frequently active in the evening/night." : "") +
        (weakSubjects.length ? ` Currently showing a struggle pattern in ${weakSubjects.length} subject(s).` : "") +
        ` Track: ${profile.track || "unknown"}.`;
      const result = await generateThemeTokens(summary, profile);
      addUsage(profile, result.tokensUsed, "other");
      if (!Object.keys(result.tokens).length) { res.status(502).json({ error: "Couldn't come up with a theme just now — try again." }); return; }
      profile.customTheme = result.tokens;
      profile.preferencesUpdatedAt = new Date().toISOString();
      await commit(req);
      res.json({ customTheme: profile.customTheme });
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't personalize your theme — try again." }); }
  }));

  app.post("/api/ui/theme-reset", requireAuth, ah(async (req, res) => {
    const profile = req.session.profile ||= emptyProfile();
    profile.customTheme = undefined;
    profile.preferencesUpdatedAt = new Date().toISOString();
    await commit(req);
    res.json({ ok: true });
  }));

  // Generic, flexible metrics ingestion ��� deliberately an open `name` string (not a fixed enum route per
  // signal) so a new data point (task lateness, flashcard struggle, study exit-early, journal consistency,
  // whatever comes up next) is "call this with a name" from wherever it happens, never a new endpoint. Nothing
  // reads these back automatically yet beyond what's wired below — this is the flexible collection point the
  // personalization ask for "capture every relevant metric" needs, ahead of specific uses being built for it.
  app.post("/api/metrics", requireAuth, rateLimit(60, 60_000), ah(async (req, res) => {
    const name = String(req.body?.name || "").slice(0, 60);
    const value = Number(req.body?.value);
    if (!name || !Number.isFinite(value)) { res.status(400).json({ error: "name and numeric value required." }); return; }
    const bucket = req.body?.bucket ? String(req.body.bucket).slice(0, 60) : "n/a";
    const context = req.body?.context ? String(req.body.context).slice(0, 200) : "";
    void recordMetric(req.session.user!, name, value, bucket, context);
    res.json({ ok: true });
  }));

  // AI token usage for the signed-in user — read from the CLOUD (not the session), so usage racked up by
  // background job runs (sweeps/executions with the browser closed) is reflected, not just this tab's.
  app.get("/api/usage", requireAuth, async (req, res) => {
    try {
      const state = await loadState(req.session.user!);
      const p = state.profile;
      const u = p?.usage;
      res.json({
        in: u?.in || 0, out: u?.out || 0, total: (u?.in || 0) + (u?.out || 0), runs: u?.runs || 0, since: u?.since || null,
        monthCostUsd: monthCostUsd(p),
        // Month-to-date spend BY WHAT SPENT IT (sweep/autorun/chat/manual_refine) — added so "what's actually
        // costing money" is an answerable question instead of one opaque total (see addUsage's own comment).
        byCategory: u?.monthByCategory || {},
      });
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "usage failed" }); }
  });

  app.get("/api/profile", requireAuth, (req, res) => {
    try {
      // ETag: every page that shows profile data re-fetches it on mount; an unchanged profile costs a 304, not the whole body again.
      const body = JSON.stringify(tasks.stripProfileForResponse(req.session.profile || emptyProfile()));
      const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
      res.setHeader("ETag", etag);
      if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
      res.type("json").send(body);
    }
    catch (e: any) { console.error(e); res.json(emptyProfile()); }
  });

  app.post("/api/profile", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const category = String(req.body?.category || "");
      const value = String(req.body?.value || "").trim();
      if (category === "name") { p.name = value.slice(0, 60) || undefined; }
      else if (category === "about") { p.about = value.slice(0, 400); }
      else {
        const k = listKey(category);
        if (!k) { res.status(400).json({ error: `Unknown profile category "${category}".` }); return; }
        if (value && !(p as any)[k].some((x: string) => x.toLowerCase() === value.toLowerCase())) (p as any)[k].push(value.slice(0, 160));
      }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save — try again." }); }
  });

  // /full: opening it unlocks the whole app (Today, Journal, Coursework, Mistakes, Settings…) for this account from then on.
  app.post("/api/full-access", requireAuth, rateLimit(10, 60_000), ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    p.fullAccess = req.body?.on === false ? false : true;
    p.fullAccessAt = new Date().toISOString();
    await commit(req);
    res.json({ ok: true, fullApp: p.fullAccess });
  }));

  app.post("/api/profile/preference", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const key = String(req.body?.key || "");
      const value = req.body?.value;
      // Every branch below except primaryAccount (a per-app map, merged by union — see mergeProfileStates)
      // stamps preferencesUpdatedAt: without it, a stale session on another device/tab committing ANYTHING
      // unrelated could silently overwrite a setting just changed here — see preferencesUpdatedAt's doc
      // comment in shared/types.ts for the full "settings aren't the same everywhere" failure mode this fixes.
      if (key === "responseStyle" && ["concise", "detailed", "casual", "formal"].includes(value)) {
        p.responseStyle = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "uiDensity" && ["cozy", "compact", "spacious"].includes(value)) {
        // A manual pick here ALWAYS wins over the density bandit's own suggestion from now on — see
        // DENSITY_ARMS's doc comment (server/bandit.ts) for why an auto-changing layout would undermine the
        // "calm" goal the rest of this app is built around.
        p.uiDensity = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "betaFeatures" && typeof value === "boolean") {
        p.betaFeatures = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "autoApprove" && Array.isArray(value)) {
        p.autoApprove = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "genPerDay") {
        p.genPerDay = Math.min(4, Math.max(1, Math.round(Number(value) || 1))); p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "timezone" && typeof value === "string" && isValidTz(value)) {
        p.timezone = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "highPriorityPeople" && Array.isArray(value)) {
        p.highPriorityPeople = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "autoArchivePatterns" && Array.isArray(value)) {
        p.autoArchivePatterns = value.map(String); p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "primaryAccount" && value && typeof value === "object" && typeof value.app === "string" && typeof value.accountId === "string"
        // Defense-in-depth: value.app is attacker-controlled and becomes an object key below. Not currently
        // exploitable (accountId is constrained to a string, and assigning a string through the __proto__
        // setter is a documented no-op), but an explicit denylist means it can never become exploitable if
        // that value-type constraint ever loosens.
        && !["__proto__", "constructor", "prototype"].includes(value.app)) {
        // Which connected account a multi-account app (Gmail, Calendar, Docs…) defaults to when a task isn't
        // tied to a specific one (a manual task, a brand-new doc) — see integrations.getAgentTools. No stamp
        // needed: mergeProfileStates unions this per-app map instead of picking one side wholesale.
        (p.primaryAccounts ||= {})[value.app] = value.accountId;
      } else if (key === "language" && (value === "fr" || value === "en")) {
        p.language = value;
        p.languageSetAt = new Date().toISOString();
      } else if (key === "track" && ["ib", "ap", "bac", "other"].includes(value)) {
        // "ap" was missing from this allow-list even though the type (shared/types.ts), the Settings AND
        // onboarding UI both offer an "AP" button, and examStyleLine/syllabusGroundingLine (claude.ts) both
        // gate real content on p.track === "ap" — a student clicking "AP" silently failed to ever save it.
        p.track = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "learningStyle" && ["visual", "auditory", "reading", "kinesthetic", "mixed"].includes(value)) {
        // Fully wired for a while on the READ side (learningStyleLine, claude.ts) but had no write path at
        // all until now — a student could never actually set it, so the field sat permanently empty.
        p.learningStyle = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "hintDensity" && ["steps", "hints", "balanced"].includes(value)) {
        p.hintDensity = value; p.preferencesUpdatedAt = new Date().toISOString();
      } else if (key === "yearLevel" && typeof value === "string" && value.trim()) {
        p.yearLevel = value.trim().slice(0, 40); p.preferencesUpdatedAt = new Date().toISOString();
      } else {
        // Every recognized key/value combo is handled above — anything else used to fall through to a
        // silent no-op 200 (profile committed unchanged, client reads back success). A typo'd key or an
        // out-of-range value should say so, not look like it saved.
        res.status(400).json({ error: `Unrecognized preference "${key}" or invalid value.` });
        return;
      }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't save — try again." }); }
  });

  // Per-subject grades — self-reported (Pronote's read API doesn't expose grades), so Otto can weigh which
  // subject actually needs attention, not just what's due soonest. Upsert by subject name (case-insensitive).
  // A manually-logged grade always APPENDS a new entry — never overwrites a same-subject one. Unlike the
  // Pronote sync (which writes "the current average as of now", one row per subject), a hand-entered grade
  // is a specific test/assignment score the student is choosing to keep a record of, so history matters.
  app.post("/api/profile/grade", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const subject = String(req.body?.subject || "").trim().slice(0, 60);
    const grade = Number(req.body?.grade);
    const scale = Number(req.body?.scale) > 0 ? Number(req.body.scale) : 20;
    if (!subject || !Number.isFinite(grade)) { res.status(400).json({ error: "subject and grade are required" }); return; }
    const list = (p.grades ||= []);
    list.push({ id: randomUUID(), subject, grade: Math.max(0, Math.min(scale, grade)), scale, updatedAt: new Date().toISOString(), source: "manual" });
    await commit(req);
    res.json(p);
  }));

  app.delete("/api/profile/grade/:key", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const key = decodeURIComponent(String(req.params.key || ""));
      const list = p.grades || [];
      p.grades = list.some((g) => g.id === key) ? list.filter((g) => g.id !== key) : list.filter((g) => g.subject.toLowerCase() !== key.toLowerCase());
      // commit()'s cross-device merge unions this list with whatever's still in the cloud copy — a plain
      // remove-then-commit would have the deleted grade resurface (the cloud copy doesn't know it was removed,
      // same tombstone-less limitation as the preference/people/project lists). Persist the deletion to cloud
      // directly FIRST, so by the time commit() reloads "current" for the merge, it already reflects the delete.
      if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't delete that grade — try again." }); }
  });

  // Manually-logged exams/deadlines — the Pronote-less equivalent of Pronote's test list (server/pronote.ts),
  // for a student whose school doesn't use it at all (most IB/international schools). Merged into the SAME
  // data ExamCountdown/computeWorkload already consume — see GET /api/pronote/tests and /api/workload below —
  // so a manual-entry student gets the identical exam-countdown/workload experience a Pronote student does.
  app.post("/api/profile/exam", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const subject = String(req.body?.subject || "").trim().slice(0, 60);
    const deadline = String(req.body?.deadline || "");
    if (!subject || !/^\d{4}-\d{2}-\d{2}/.test(deadline)) { res.status(400).json({ error: "subject and a real deadline are required" }); return; }
    const list = (p.manualExams ||= []);
    list.push({ id: randomUUID(), subject, deadline });
    await commit(req);
    res.json(p);
  }));

  // ── First-run tour ───────────────────────────────────────────────────────────────────────────────────────────
  // Stamped when the student finishes or skips the tour, server-side so it follows the account across devices
  // (a replay from Settings never needs this).
  app.post("/api/profile/onboarded", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    if (!p.onboardedAt) p.onboardedAt = new Date().toISOString();
    await commit(req);
    res.json({ ok: true });
  }));

  // A page guide was shown (or skipped): remember it on the account so it never repeats, on any device.
  app.post("/api/profile/tour-seen", requireAuth, ah(async (req, res) => {
    const id = String(req.body?.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
    if (!id) { res.status(400).json({ error: "id required" }); return; }
    const p = (req.session.profile ||= emptyProfile());
    p.toursSeen = [...new Set([...(p.toursSeen || []), id])].slice(0, 40);
    await commit(req);
    res.json({ ok: true, toursSeen: p.toursSeen });
  }));

  // "Test onboarding" (Settings): forget the basic flow AND every page guide so the whole first-run experience replays.
  app.post("/api/profile/onboarding-reset", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    p.toursSeen = [];
    p.onboardedAt = undefined;
    if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
    await commit(req);
    res.json({ ok: true });
  }));

  // The subjects the student takes (onboarding step) — ordered first wherever a subject is picked.
  app.post("/api/profile/subjects", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const list = Array.isArray(req.body?.subjects) ? req.body.subjects : [];
    p.subjects = [...new Set<string>(list.map((s: unknown) => String(s).trim().slice(0, 60)).filter(Boolean))].slice(0, 14);
    await commit(req);
    res.json({ ok: true, subjects: p.subjects });
  }));

  app.delete("/api/profile/exam/:id", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const id = decodeURIComponent(String(req.params.id || ""));
      p.manualExams = (p.manualExams || []).filter((e) => e.id !== id);
      // Same tombstone-less-merge reasoning as the grade delete above — persist the delete to cloud FIRST.
      if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't remove that exam — try again." }); }
  });

  // Error log — a student-maintained record of specific mistakes (question / what went wrong / what to do
  // next), grouped by subject client-side (see errorLogBySubject, shared/types.ts). Same accumulate-forever,
  // union-by-id-on-merge, delete-persists-to-cloud-first shape as grades/manualExams above.
  app.post("/api/profile/errorlog", requireAuth, ah(async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const subject = String(req.body?.subject || "").trim().slice(0, 60);
    const question = String(req.body?.question || "").trim().slice(0, 500);
    const mistake = String(req.body?.mistake || "").trim().slice(0, 500);
    const fix = String(req.body?.fix || "").trim().slice(0, 500);
    if (!subject || !question) { res.status(400).json({ error: "subject and question are required" }); return; }
    const list = (p.errorLog ||= []);
    list.push({ id: randomUUID(), subject, question, mistake, fix, createdAt: new Date().toISOString() });
    await commit(req);
    res.json(p);
  }));

  app.delete("/api/profile/errorlog/:id", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      const id = decodeURIComponent(String(req.params.id || ""));
      p.errorLog = (p.errorLog || []).filter((e) => e.id !== id);
      if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't remove that entry — try again." }); }
  });

  // Reset Otto's synthesized "read" on this student (profile.studentModel) — same transparency posture as
  // errorLog/usage above: this is the most surveillance-adjacent field in the app (an AI-authored read of how
  // a student thinks, not self-reported), so a genuinely destructive, one-click reset is required, not
  // optional. Otto rebuilds it from scratch on the next 4pm sweep if there's still activity to synthesize from.
  app.delete("/api/profile/student-model", requireAuth, async (req, res) => {
    try {
      const p = (req.session.profile ||= emptyProfile());
      p.studentModel = undefined;
      // Delete-persists-to-cloud-first — same reasoning as the errorLog/grade/exam deletes above: without
      // this, commit()'s cross-device merge could resurrect the "deleted" summary from a stale cloud copy.
      if (req.session.user) { try { await saveState(req.session.user, { profile: p, tasks: req.session.tasks || [] }); } catch { /* commit() below still tries */ } }
      await commit(req);
      res.json(p);
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't reset — try again." }); }
  });

  // Wipe everything Otto has learned (restart from zero memory). The agent rebuilds it over time via `remember`.
  app.delete("/api/profile", requireAuth, async (req, res) => {
    try {
      req.session.profile = emptyProfile();
      await commit(req);
      res.json(tasks.stripProfileForResponse(req.session.profile));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't reset your profile — try again." }); }
  });

  app.delete("/api/profile/:category/:index", requireAuth, async (req, res) => {
    const p = (req.session.profile ||= emptyProfile());
    const k = listKey(String(req.params.category));
    const i = Number(String(req.params.index));
    // Was a silent no-op on a bad category/out-of-range index — still 200'd with the unchanged profile,
    // indistinguishable from success (same anti-pattern already fixed on the task routes).
    if (!k || !Array.isArray((p as any)[k]) || !(i >= 0 && i < (p as any)[k].length)) {
      res.status(404).json({ error: "Nothing to delete there — it may have already changed elsewhere." }); return;
    }
    try {
      (p as any)[k].splice(i, 1);
      await commit(req);
      res.json(tasks.stripProfileForResponse(p));
    } catch (e: any) { console.error(e);
      res.status(500).json({ error: "Couldn't delete that — try again." }); }
  });
}
