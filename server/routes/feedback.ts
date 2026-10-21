import "../env.ts";
import express from "express";
import { addFeedback, listFeedbackFor, deleteFeedbackById, listFeedbackForAdmin, decideFeedback, listPublicTestimonials, recordEvent, type FeedbackStatus } from "../store.ts";
import { ah, isAdmin, rateLimit, requireAuth } from "../http.ts";

/** Feedback + consented testimonials. Real feedback only, GDPR-shaped:
 *   - sharing feedback is separate from agreeing to PUBLISH it (a second, unchecked-by-default box, with its own timestamp);
 *   - what's published is only text the student wrote, under a name THEY typed (never derived from their email);
 *   - an admin must approve each quote before it can appear, and approval is impossible without the consent flag;
 *   - the student can see everything they sent and withdraw any of it at any time (which also removes a public quote);
 *   - deleting the account deletes all of it (store.deleteAccount) and the data export includes it. */
const clean = (v: unknown, max: number) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const HELPFUL = new Set(["yes", "somewhat", "no"]);

export const publicView = (r: { id: string; helpful: string; comment: string; publish_consent: boolean; status: string; display_name: string; level: string; created_at: string }) => ({
  id: r.id, helpful: r.helpful, comment: r.comment, publish: r.publish_consent, status: r.status, name: r.display_name, level: r.level, at: r.created_at,
});

export function registerFeedbackRoutes(app: express.Express): void {
  // Send feedback (signed in).
  app.post("/api/feedback", requireAuth, rateLimit(5, 24 * 60 * 60_000), ah(async (req, res) => {
    const helpful = String(req.body?.helpful || "");
    if (!HELPFUL.has(helpful)) { res.status(400).json({ error: "Tell us whether Otto helped." }); return; }
    const comment = clean(req.body?.comment, 600);
    const wantsPublish = req.body?.publish === true;
    const name = clean(req.body?.name, 30);
    const level = clean(req.body?.level, 40);
    if (wantsPublish && (!comment || comment.length < 10)) { res.status(400).json({ error: "To share a quote, write a sentence or two first." }); return; }
    if (wantsPublish && !name) { res.status(400).json({ error: "Choose the first name or initial to show next to your quote." }); return; }
    const row = await addFeedback({ user_email: req.session.user!, helpful: helpful as "yes" | "somewhat" | "no", comment, publish_consent: wantsPublish, display_name: wantsPublish ? name : "", level: wantsPublish ? level : "" });
    if (!row) { res.status(500).json({ error: "Couldn't save that — try again." }); return; }
    void recordEvent(req.session.user!, "feedback_sent", { message: wantsPublish ? "publish-consent" : "private" });
    res.json({ ok: true, feedback: publicView(row) });
  }));

  // Everything this student has sent (access), and withdrawal.
  app.get("/api/feedback/mine", requireAuth, ah(async (req, res) => {
    res.json({ feedback: (await listFeedbackFor(req.session.user!)).map(publicView) });
  }));
  app.delete("/api/feedback/:id", requireAuth, rateLimit(30, 60_000), ah(async (req, res) => {
    const ok = await deleteFeedbackById(req.session.user!, String(req.params.id || ""));
    if (!ok) { res.status(404).json({ error: "Not found." }); return; }
    void recordEvent(req.session.user!, "feedback_withdrawn", {});
    res.json({ ok: true });
  }));

  // Public: approved + consented quotes only. No email, no ids. Cached briefly at the edge.
  app.get("/api/testimonials", rateLimit(60, 60_000), ah(async (_req, res) => {
    res.set("Cache-Control", "public, max-age=300, s-maxage=300");
    res.json({ testimonials: await listPublicTestimonials(6) });
  }));

  // Admin moderation: see what is waiting, approve (only possible with the author's consent) or reject.
  app.get("/api/admin/feedback", requireAuth, ah(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "Access denied." }); return; }
    const status = (["pending", "approved", "rejected", "all"].includes(String(req.query.status)) ? String(req.query.status) : "pending") as FeedbackStatus | "all";
    // The email is deliberately NOT sent to the admin screen: moderation needs the words, not who wrote them.
    res.json({ feedback: (await listFeedbackForAdmin(status)).map(publicView) });
  }));
  app.post("/api/admin/feedback/:id", requireAuth, rateLimit(60, 60_000), ah(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "Access denied." }); return; }
    const decision = req.body?.decision === "approve" ? "approved" : req.body?.decision === "reject" ? "rejected" : null;
    if (!decision) { res.status(400).json({ error: "decision must be approve or reject." }); return; }
    const ok = await decideFeedback(String(req.params.id || ""), decision);
    if (!ok) { res.status(404).json({ error: decision === "approved" ? "Not found, or the author did not agree to publication." : "Not found." }); return; }
    res.json({ ok: true });
  }));
}
