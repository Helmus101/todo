
import "../env.ts";
import express from "express";
import { emptyProfile, addUsage, bumpActivityHour } from "../../shared/types.ts";
import { parsePolicy, summarize as summarizePolicy } from "../tutorPolicy.ts";
import { schoolRecordLine } from "../schoolRecord.ts";
import { aiReady, visionReady, describeWhiteboard, describeUploadedPhoto, synthesizeSpeech, TTS_MAX_TEXT, tutorOpener } from "../claude.ts";
import { recordEvent, loadBanditState, saveBanditState } from "../store.ts";
import { M, ah, commit, dailyCap, isPaused, rateLimit, requireAuth } from "../http.ts";
import { backgroundBlock } from "../tutor.ts";
import { selectJournal } from "../journal.ts";
import { writeBoard } from "../tutorTurn/boardWriter.ts";
import { liveInstructions } from "../../shared/liveTutor.ts";

export function registerTutorRoutes(app: express.Express): void {
  // Otto SPEAKS FIRST: the tutor session's opening line (see tutorOpener in server/claude.ts). REAL, not a
  // template — the browser's own session history (the actual board lines and questions from the student's
  // last sessions, which exist ONLY in their browser) rides up in the request and is grounded in alongside
  // what the server already knows (the tutor's own end-of-session recaps, the running student model,
  // milestones). The client shows its own instant greeting until this lands, so a slow or failed AI call here
  // degrades to that line instead of an empty greeting — which is why a failure is a 502 the client quietly
  // ignores rather than an error the student sees.
  app.post("/api/tutor/opener", requireAuth, rateLimit(30, 60_000), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim().slice(0, 80) : "";
    // Client-controlled input, so every field is capped here (the prompt builder does no capping of its own).
    const rawMemory = Array.isArray(req.body?.pastSessions) ? req.body.pastSessions : [];
    const memory = rawMemory.slice(0, 3).map((m: any) => ({
      when: typeof m?.when === "string" ? m.when.trim().slice(0, 40) : undefined,
      subject: typeof m?.subject === "string" ? m.subject.trim().slice(0, 80) : undefined,
      lines: (Array.isArray(m?.lines) ? m.lines : []).filter((x: any) => typeof x === "string" && x.trim()).slice(0, 6).map((x: string) => x.trim().slice(0, 200)),
      asked: (Array.isArray(m?.asked) ? m.asked : []).filter((x: any) => typeof x === "string" && x.trim()).slice(0, 3).map((x: string) => x.trim().slice(0, 200)),
    })).filter((m: any) => m.lines.length || m.asked.length || (m.subject && m.when));
    try {
      const profile = req.session.profile ||= emptyProfile();
      const out = await tutorOpener({ subject: subject || undefined, memory, schoolRecord: schoolRecordLine(req.session.tasks, profile, subject || undefined) }, profile);
      addUsage(profile, out.tokens, "chat");
      bumpActivityHour(profile, new Date(), subject || undefined);
      await commit(req);
      res.json({ opener: out.opener });
    } catch (e: any) {
      console.error(`[tutor] opener failed: ${e?.message || e}`);
      res.status(502).json({ error: "Otto couldn't start the session — try again." });
    }
  }));

  // Whiteboard → tutor: the student draws (any freehand canvas, e.g. the Tutor's own whiteboard panel), the
  // client exports it as a PNG data URL, this reads it with Gemini Flash (see describeWhiteboard's own
  // comment for why a separate provider — DeepSeek has no image input at all) and hands back a plain-text
  // transcription for the CLIENT to then send into the normal text-only tutor chat as an ordinary message —
  // this route never talks to the tutor/DeepSeek itself, it only answers "what does the image show."
  // A canvas snapshot is bigger than a typical JSON body (a dense 800x600 PNG can run a few hundred KB once
  // base64-inflated by ~33%) — same bumped-limit pattern as /api/account/import, just smaller: nothing
  // resembling a real whiteboard sketch should ever approach 8mb.
  // LIVE VOICE: the browser talks to Gemini Live directly (instant, interruptible speech), so it needs a credential. This mints a
  // short-lived token — the real key never leaves the server — and returns the tutor's instructions WITH what Otto knows about the
  // student (profile, past sessions kept on their device, journal, school record), so the voice has Otto's memory. Capped per day.
  app.post("/api/tutor/live/token", requireAuth, rateLimit(6, 60_000), dailyCap("live", Number(process.env.TUTOR_DAILY_LIVE) || 20), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!geminiKey && !openaiKey) { res.status(503).json({ error: "Live voice isn't set up on this server.", code: "live_unavailable" }); return; }
    let detail = "";
    try {
      const subject = typeof req.body?.subject === "string" ? req.body.subject.trim().slice(0, 80) : "";
      const profile = req.session.profile || emptyProfile();
      const memory = (Array.isArray(req.body?.pastSessions) ? req.body.pastSessions : []).slice(0, 3).map((m: any) => ({
        when: typeof m?.when === "string" ? m.when.trim().slice(0, 40) : undefined,
        subject: typeof m?.subject === "string" ? m.subject.trim().slice(0, 80) : undefined,
        lines: (Array.isArray(m?.lines) ? m.lines : []).filter((x: any) => typeof x === "string" && x.trim()).slice(0, 6).map((x: string) => x.trim().slice(0, 200)),
        asked: (Array.isArray(m?.asked) ? m.asked : []).filter((x: any) => typeof x === "string" && x.trim()).slice(0, 3).map((x: string) => x.trim().slice(0, 200)),
      })).filter((m: any) => m.lines.length || m.asked.length || (m.subject && m.when));
      let background = "";
      try {
        const journal = selectJournal(req.session.tasks || [], { subject, query: subject, known: profile.subjects });
        background = backgroundBlock({ profile, subject, journal: journal.entries, journalMeta: { total: journal.total, subjects: journal.subjects }, schoolRecord: schoolRecordLine(req.session.tasks, profile, subject), memory } as any);
      } catch { /* memory is a bonus: the voice works without it */ }
      const instructions = liveInstructions({ subject, level: undefined, background, resuming: req.body?.resuming === true });

      // 1) OpenAI Realtime (WebRTC from the browser, a "mini" model): preferred when a key is configured (LIVE_PROVIDER=gemini forces Gemini).
      if (openaiKey && process.env.LIVE_PROVIDER !== "gemini") {
        const candidates = [...new Set([process.env.OPENAI_REALTIME_MODEL, "gpt-realtime-mini", "gpt-realtime-2.1-mini", "gpt-realtime-2.1"].filter((m): m is string => !!m))];
        for (const model of candidates) {
          for (const full of [true, false]) {
            const session: any = { type: "realtime", model, instructions, output_modalities: ["audio"], audio: { output: { voice: "marin" }, ...(full ? { input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "semantic_vad" } } } : {}) } };
            const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ session }) });
            if (r.ok) {
              const j: any = await r.json();
              const value = String(j?.value || j?.client_secret?.value || "");
              if (value) { res.json({ provider: "openai", token: value, model, models: [model], instructions }); return; }
            }
            detail = `openai ${model}: ${r.status}`;
            if (r.status === 401 || r.status === 403 || r.status === 429) break;
          }
          if (/: (401|403|429)$/.test(detail)) break;
        }
        console.warn(`[live] OpenAI realtime token failed (${detail})`);
      }

      // 2) Gemini Live (WebSocket from the browser).
      if (!geminiKey) { res.status(502).json({ error: "Live voice isn't available right now.", code: "live_unavailable", detail }); return; }
      const now = Date.now();
      const r = await fetch(`https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${encodeURIComponent(geminiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uses: 3, expireTime: new Date(now + 35 * 60_000).toISOString(), newSessionExpireTime: new Date(now + 60_000).toISOString() }),
      });
      if (!r.ok) throw new Error(`gemini token request ${r.status}`);
      const token = String(((await r.json()) as { name?: string }).name || "");
      if (!token) throw new Error("no token returned");
      // Model ids change often; the browser tries them in order until Google accepts one (a configured id always goes first).
      const models = [...new Set([process.env.GEMINI_LIVE_MODEL, "gemini-3.8-live", "gemini-2.5-flash-native-audio-preview-09-2025"].filter((m): m is string => !!m))];
      res.json({ provider: "gemini", token, model: models[0], models, instructions });
    } catch (e: any) {
      console.warn(`[live] token request failed: ${String(e?.message || e).slice(0, 160)}`);
      res.status(502).json({ error: "Live voice isn't available right now.", code: "live_unavailable", detail: String(e?.message || e).slice(0, 120) });
    }
  }));

  // THE BOARD FOR THE LIVE VOICE: after each spoken exchange the browser sends what was said and the board as it stands; one call decides
  // what goes on the paper (the problem, the student's correct steps as Otto's own lines, a takeaway of what was explained, figures).
  app.post("/api/tutor/live/board", requireAuth, rateLimit(30, 60_000), dailyCap("live-board", Number(process.env.TUTOR_DAILY_LIVE_BOARD) || 400), ah(async (req, res) => {
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to chat." }); return; }
    if (!aiReady()) { res.status(503).json({ error: "AI isn't configured." }); return; }
    const exchange = typeof req.body?.exchange === "string" ? req.body.exchange.slice(0, 4000) : "";
    if (!exchange.trim()) { res.json({ board: [] }); return; }
    const board = (Array.isArray(req.body?.board) ? req.body.board : []).slice(-40).filter((e: any) => e && typeof e.id === "string" && typeof e.kind === "string");
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim().slice(0, 80) : "";
    const tokens = { in: 0, out: 0, cachedIn: 0 };
    try {
      const out = await writeBoard({ exchange, board, subject }, tokens);
      const profile = req.session.profile || emptyProfile();
      addUsage(profile, tokens, "chat");
      res.json({ board: out.board });
    } catch (e: any) {
      console.warn(`[live] board writer failed: ${String(e?.message || e).slice(0, 120)}`);
      res.status(502).json({ error: "The board couldn't be updated just now.", board: [] });
    }
  }));

  app.post("/api/tutor/read-whiteboard", requireAuth, rateLimit(15, 60_000), express.json({ limit: "8mb" }), ah(async (req, res) => {
    if (!visionReady()) { res.status(503).json({ error: "Whiteboard reading isn't configured on this server." }); return; }
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to continue." }); return; }
    const image = String(req.body?.image || "");
    if (!image) { res.status(400).json({ error: "No drawing received." }); return; }
    // The vision helper composes its own (diagnostic, sometimes upstream-detail-bearing) message, so it
    // takes the request's language instead of returning English the client would show inside a French UI.
    const r = await describeWhiteboard(image, (fr, en) => en, typeof req.body?.context === "string" ? req.body.context : "");
    if ("error" in r) { res.status(422).json({ error: r.error }); return; }
    void recordEvent(req.session.user!, "whiteboard_read", {});
    res.json({ description: r.description });
  }));

  // The Tutor's file-upload attach button — a photo of an exercise/textbook page/handwritten note, read with
  // the same vision model as the whiteboard (describeUploadedPhoto, server/claude.ts), then handed to the
  // chat as plain text context. Images only here; PDFs are extracted client-side (client/study/pdfText.ts,
  // no server round trip needed) and plain text files are read directly in the browser — this route exists
  // specifically for the case neither of those cover: a phone-camera photo with no text layer at all.
  app.post("/api/tutor/read-photo", requireAuth, rateLimit(15, 60_000), express.json({ limit: "8mb" }), ah(async (req, res) => {
    if (!visionReady()) { res.status(503).json({ error: "Image reading isn't configured on this server." }); return; }
    if (isPaused(req)) { res.status(403).json({ error: "AI is paused — resume it in Settings to continue." }); return; }
    const image = String(req.body?.image || "");
    if (!image) { res.status(400).json({ error: "No image received." }); return; }
    const r = await describeUploadedPhoto(image, (fr, en) => en);
    if ("error" in r) { res.status(422).json({ error: r.error }); return; }
    void recordEvent(req.session.user!, "photo_read", {});
    res.json({ description: r.description });
  }));

  // Delete ONE grade entry by id (the normal path from the UI's per-row × ). Falls back to matching by
  // subject for anything still lacking an id (a pre-history-model entry that never got normalized) or for
  // a bulk "remove this whole subject" — same param, whichever matches.
  // Primer: Get dependence metrics for parent dashboard (Phase 1.5)
  // What Otto's learned policy currently favours for this student (transparency) + reset.
  app.get("/api/tutor/policy", requireAuth, async (req, res) => {
    try {
      const st = await loadBanditState(req.session.user!, "tutorpolicy");
      const p = parsePolicy((st as any)?.policy);
      res.json(p ? { learning: true, ...summarizePolicy(p) } : { learning: false, updates: 0 });
    } catch { res.json({ learning: false, updates: 0 }); }
  });

  app.delete("/api/tutor/policy", requireAuth, async (req, res) => {
    try { await saveBanditState(req.session.user!, "tutorpolicy", {} as any); res.json({ ok: true }); }
    catch { res.status(500).json({ error: "Couldn't reset." }); }
  });

  app.get("/api/primer/dependence", requireAuth, (req, res) => {
    const profile = req.session.profile;
    const metrics = profile?.dependenceMetrics || {};
    
    // Calculate trends from the metrics
    const domainMetrics = Object.entries(metrics).map(([domain, data]) => ({
      domain,
      helpRatio: data.helpRatio,
      answerSeekRate: data.answerSeekRate,
      unaidedRate: data.unaidedRate,
      fadeIndex: data.fadeIndex,
      trend: data.helpRatio > 0.5 ? "warning" : data.unaidedRate > 0.7 ? "good" : "neutral",
    }));
    
    const hasWarning = domainMetrics.some(m => m.trend === "warning");
    
    res.json({
      metrics: domainMetrics,
      summary: {
        totalDomains: domainMetrics.length,
        warningCount: domainMetrics.filter(m => m.trend === "warning").length,
        goodCount: domainMetrics.filter(m => m.trend === "good").length,
        hasWarning,
      },
    });
  });

  // The tutor's spoken voice (see synthesizeSpeech in server/claude.ts): a free, keyless, MALE-ONLY voice
  // pool. Called one chunk at a time by client/voice/useSpeechSynthesis.ts, which on failure plays NOTHING for
  // that reply rather than substituting a female/browser voice — a loud, honest failure is the intended
  // behavior here, so a failure is logged with the provider's own reason. Rate-limited generously: one reply
  // is 1-3 chunks, and voice mode can go quickly.
  app.post("/api/tts", requireAuth, rateLimit(120, 60_000), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const lang = "en";
    if (!text) { res.status(400).json({ error: "text is required" }); return; }
    // One free, keyless provider speaking from a MALE-ONLY voice pool (see synthesizeSpeech in
    // server/claude.ts): no Gemini TTS, no female voice to fall back to, and a failure retries the next male
    // voice rather than switching gender. Long text is CHUNKED by that function, never sliced — the old
    // `text.slice(0, 1000)` here was silently cutting the tail off every reply longer than 1000 characters,
    // which is what "all voices cut off early" actually was. TTS_MAX_TEXT bounds only how much text one
    // request may carry (the client never sends more than it); it is not a content limit.
    const out = await synthesizeSpeech(text.slice(0, TTS_MAX_TEXT), lang);
    if ("error" in out) {
      console.error(`[tts] every male voice failed: ${out.error}`);
      res.status(out.status === 429 ? 429 : 502).json({ error: "TTS generation failed" });
      return;
    }
    res.setHeader("Content-Type", out.mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.audio);
  });
}
