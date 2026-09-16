/**
 * A real, general-purpose system mailer — via Resend's HTTP API, no SDK dependency (a plain fetch call, so
 * this needs no npm install). Distinct from integrations.ts's `sendSystemEmail`, which sends THROUGH the
 * account's OWN connected Gmail (fine for an already-logged-in, already-connected user like the Pronote
 * reconnect nudge) — that mechanism can't reach someone who's locked out and never connected Gmail at all,
 * which is exactly the case password reset has to cover. Best-effort like every other outbound-email call
 * in this codebase: a mailer hiccup must never surface as a 500 to the caller, just a quiet log line.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "Otto <onboarding@resend.dev>";

export function mailerConfigured(): boolean {
  return !!RESEND_API_KEY;
}

export async function sendTransactionalEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) { console.warn("[mailer] RESEND_API_KEY not set — email not sent:", subject); return false; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    });
    if (!res.ok) { console.warn("[mailer] send failed:", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e: any) { console.warn("[mailer] send error:", e?.message || e); return false; }
}
