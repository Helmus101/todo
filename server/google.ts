import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";

// Sensitive scopes: read mail + calendar, create DRAFTS (never auto-send), create Docs. While the
// OAuth consent screen is in "Testing" with you as a test user, these need no Google verification.
export const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.modify",      // read all mail + create drafts (no send)
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",     // search + read across your whole Drive
  "https://www.googleapis.com/auth/documents",          // read + create Google Docs
  "https://www.googleapis.com/auth/drive.file",         // own the docs it creates
];

export function redirectUri(): string {
  return process.env.OAUTH_REDIRECT || `${process.env.PUBLIC_URL || "http://localhost:5173"}/auth/google/callback`;
}

export function oauthClient(): OAuth2Client {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in web/.env.");
  return new google.auth.OAuth2(id, secret, redirectUri());
}

export function clientForTokens(tokens: Credentials): OAuth2Client {
  const c = oauthClient();
  c.setCredentials(tokens);
  return c;
}

export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string): Promise<Credentials> {
  const { tokens } = await oauthClient().getToken(code);
  return tokens;
}

export async function getEmail(tokens: Credentials): Promise<string | undefined> {
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: clientForTokens(tokens) });
    const me = await oauth2.userinfo.get();
    return me.data.email || undefined;
  } catch { return undefined; }
}

// ── Context the LLM reasons over ──────────────────────────────────────────────

export interface InboxItem { id: string; threadId: string; from: string; subject: string; snippet: string; date: string; lastInbound: boolean; }
export interface CalItem { id: string; summary: string; start: string; attendees: string[]; htmlLink?: string; }
export interface Context { email?: string; inbox: InboxItem[]; events: CalItem[]; }

function header(headers: any[] | undefined, name: string): string {
  return String(headers?.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "");
}

/** Recent INBOX threads (latest message per thread) + upcoming calendar events — the grounding for tasks. */
export async function fetchContext(tokens: Credentials, myEmail?: string): Promise<Context> {
  const auth = clientForTokens(tokens);
  const gmail = google.gmail({ version: "v1", auth });
  const cal = google.calendar({ version: "v3", auth });

  const inbox: InboxItem[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", q: "in:inbox -category:promotions -category:social newer_than:21d", maxResults: 25 });
    const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
    const seenThreads = new Set<string>();
    for (const id of ids) {
      try {
        const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
        const threadId = String(msg.data.threadId || id);
        if (seenThreads.has(threadId)) continue;
        seenThreads.add(threadId);
        const headers = msg.data.payload?.headers as any[] | undefined;
        const from = header(headers, "From");
        const lastInbound = !!myEmail && !from.toLowerCase().includes(myEmail.toLowerCase());
        inbox.push({
          id, threadId,
          from,
          subject: header(headers, "Subject") || "(no subject)",
          snippet: String(msg.data.snippet || "").slice(0, 300),
          date: header(headers, "Date"),
          lastInbound,
        });
      } catch { /* one bad message shouldn't drop the whole inbox */ }
      if (inbox.length >= 15) break;
    }
  } catch (e) { console.warn("[google] inbox fetch failed:", (e as any)?.message || e); }

  const events: CalItem[] = [];
  try {
    const now = new Date();
    const inTwoDays = new Date(now.getTime() + 48 * 3600 * 1000);
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: inTwoDays.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });
    for (const ev of res.data.items || []) {
      events.push({
        id: String(ev.id),
        summary: ev.summary || "(busy)",
        start: ev.start?.dateTime || ev.start?.date || "",
        attendees: (ev.attendees || []).map((a) => a.email || "").filter(Boolean),
        htmlLink: ev.htmlLink || undefined,
      });
    }
  } catch (e) { console.warn("[google] calendar fetch failed:", (e as any)?.message || e); }

  return { email: myEmail, inbox, events };
}

// ── Reversible execution actions (used by auto-run) ───────────────────────────

/** Create a Gmail DRAFT (never sends). Returns a link to it in the Gmail UI + the draftId (so the user
 *  can later send it with one confirmed click via sendDraft). */
export async function createDraft(tokens: Credentials, opts: { to?: string; subject: string; body: string; threadId?: string }): Promise<TaskLinkLike & { draftId?: string }> {
  const auth = clientForTokens(tokens);
  const gmail = google.gmail({ version: "v1", auth });
  const lines = [
    opts.to ? `To: ${opts.to}` : "",
    `Subject: ${opts.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    opts.body,
  ].filter(Boolean);
  const raw = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId: opts.threadId } } });
  const draftId = res.data.id || undefined;
  return { label: `Draft: ${opts.subject}`.slice(0, 80), url: `https://mail.google.com/mail/u/0/#drafts${draftId ? `?compose=${draftId}` : ""}`, draftId };
}

/** Send a previously-created draft — ONLY ever called from the user's explicit "Send" confirmation. */
export async function sendDraft(tokens: Credentials, draftId: string): Promise<TaskLinkLike> {
  const gmail = google.gmail({ version: "v1", auth: clientForTokens(tokens) });
  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  const id = res.data.id || res.data.threadId || "";
  return { label: "Sent ✓", url: `https://mail.google.com/mail/u/0/#sent${id ? `/${id}` : ""}` };
}

/** Create a Google Doc with text content. Returns its link. */
export async function createDoc(tokens: Credentials, opts: { title: string; body: string }): Promise<TaskLinkLike> {
  const auth = clientForTokens(tokens);
  const docs = google.docs({ version: "v1", auth });
  const created = await docs.documents.create({ requestBody: { title: opts.title.slice(0, 120) } });
  const docId = created.data.documentId!;
  if (opts.body) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: opts.body.slice(0, 40000) } }] },
    });
  }
  return { label: `Doc: ${opts.title}`.slice(0, 80), url: `https://docs.google.com/document/d/${docId}/edit` };
}

interface TaskLinkLike { label: string; url: string; }

// ── Search / read tools (given to the agent so it can look through everything) ─────────────────────

function decodeB64(data?: string | null): string {
  if (!data) return "";
  try { return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}
function plainTextFromPayload(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64(payload.body.data);
  for (const part of payload.parts || []) {
    const t = plainTextFromPayload(part);
    if (t) return t;
  }
  if (payload.body?.data) return decodeB64(payload.body.data); // fallback (may be html)
  return "";
}

/** Search ALL Gmail (not just inbox) with a Gmail query string. */
export async function searchGmail(tokens: Credentials, query: string, max = 8): Promise<Array<{ id: string; threadId: string; from: string; subject: string; date: string; snippet: string }>> {
  const gmail = google.gmail({ version: "v1", auth: clientForTokens(tokens) });
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: max });
  const out: Array<{ id: string; threadId: string; from: string; subject: string; date: string; snippet: string }> = [];
  for (const m of list.data.messages || []) {
    try {
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const h = msg.data.payload?.headers as any[] | undefined;
      out.push({ id: m.id!, threadId: String(msg.data.threadId || m.id), from: header(h, "From"), subject: header(h, "Subject") || "(no subject)", date: header(h, "Date"), snippet: String(msg.data.snippet || "").slice(0, 300) });
    } catch { /* skip */ }
  }
  return out;
}

/** Read the full plain-text body of one email. */
export async function readEmail(tokens: Credentials, id: string): Promise<{ from: string; subject: string; body: string }> {
  const gmail = google.gmail({ version: "v1", auth: clientForTokens(tokens) });
  const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const h = msg.data.payload?.headers as any[] | undefined;
  return { from: header(h, "From"), subject: header(h, "Subject") || "(no subject)", body: plainTextFromPayload(msg.data.payload).slice(0, 6000) };
}

/** Search across the user's Drive (docs, files). `query` is matched against name + full text. */
export async function searchDrive(tokens: Credentials, query: string, max = 10): Promise<Array<{ id: string; name: string; mimeType: string; modifiedTime: string; link: string }>> {
  const drive = google.drive({ version: "v3", auth: clientForTokens(tokens) });
  const safe = query.replace(/['\\]/g, " ");
  const res = await drive.files.list({
    q: `trashed = false and (name contains '${safe}' or fullText contains '${safe}')`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    pageSize: max,
    orderBy: "modifiedTime desc",
  });
  return (res.data.files || []).map((f) => ({ id: String(f.id), name: f.name || "(untitled)", mimeType: f.mimeType || "", modifiedTime: f.modifiedTime || "", link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` }));
}

/** Read the text of a Drive file — Google Docs via the Docs API, other Google-native types via export. */
export async function readDoc(tokens: Credentials, fileId: string): Promise<{ title: string; text: string; link: string }> {
  const auth = clientForTokens(tokens);
  const drive = google.drive({ version: "v3", auth });
  const meta = await drive.files.get({ fileId, fields: "id,name,mimeType,webViewLink" });
  const mime = meta.data.mimeType || "";
  const link = meta.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  let text = "";
  if (mime === "application/vnd.google-apps.document") {
    const docs = google.docs({ version: "v1", auth });
    const doc = await docs.documents.get({ documentId: fileId });
    text = (doc.data.body?.content || [])
      .flatMap((el) => (el.paragraph?.elements || []).map((e) => e.textRun?.content || ""))
      .join("");
  } else if (mime.startsWith("application/vnd.google-apps.")) {
    const res = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
    text = String(res.data || "");
  } else if (mime === "text/plain") {
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    text = String(res.data || "");
  } else {
    text = `(Can't read ${mime} as text — open it: ${link})`;
  }
  return { title: meta.data.name || "(untitled)", text: text.slice(0, 8000), link };
}
