/**
 * Deterministic discovery — the first stage of the generation pipeline:
 *
 *   discover (explicit read calls) → normalize (SourceItem) → filter (noise + known anchors) → classify (one AI call)
 *
 * Unlike the open-ended agent sweep, this pulls candidate items with FIXED read calls (Gmail inbox,
 * unread, sent commitments, Calendar next 7 days), normalizes them into one shape, and drops noise
 * DETERMINISTICALLY before any model sees them. The model's only job is classification of survivors —
 * and every anchor/link on a resulting task comes from the SOURCE item, never from the model, so a
 * hallucinated reference is structurally impossible.
 */
import { readAction } from "./integrations.ts";

export interface SourceItem {
  sourceApp: "gmail" | "calendar" | "drive";
  externalId: string;
  anchorKey: string;      // "gmail:<threadId>" / "calendar:<eventId>" / "drive:<fileId>" — the dedupe identity
  url?: string;
  title: string;
  snippet: string;
  sender?: string;
  timestamp?: string;
  labels: string[];       // e.g. ["inbox"], ["sent"] (a sent item = a commitment the user made), ["event"], ["shared"]
}

// Deterministic noise filters — mass mail never even reaches the model.
const NOISE_SENDER = /no-?reply|donotreply|newsletter|marketing|notifications?@|updates?@|news@|mailer@|bounce|billing@|receipts?@|noreply/i;
const NOISE_SUBJECT = /unsubscribe|newsletter|weekly digest|daily digest|% off|sale ends|flash sale|your receipt|order confirmation|payment received|has shipped|delivery update|verify your email|security alert/i;
export function isNoise(it: SourceItem): boolean {
  if (it.labels.includes("sent")) return false; // the user's own commitments are never noise
  return NOISE_SENDER.test(it.sender || "") || NOISE_SUBJECT.test(it.title || "");
}

const normKey = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Composio response shapes drift between versions — read every known key defensively.
function gmailToItems(data: any, label: string): SourceItem[] {
  const msgs: any[] = data?.messages || data?.data?.messages || data?.response_data?.messages || (Array.isArray(data) ? data : []);
  return (msgs || []).slice(0, 25).map((m: any): SourceItem | null => {
    const threadId = String(m?.threadId ?? m?.thread_id ?? m?.id ?? "").trim();
    if (!threadId) return null;
    return {
      sourceApp: "gmail",
      externalId: threadId,
      anchorKey: `gmail:${threadId}`,
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      title: String(m?.subject ?? m?.messageSubject ?? "(no subject)").slice(0, 140),
      snippet: String(m?.preview?.body ?? m?.snippet ?? m?.messageText ?? m?.preview ?? "").replace(/\s+/g, " ").slice(0, 240),
      sender: String(m?.sender ?? m?.from ?? m?.fromAddress ?? "").slice(0, 120),
      timestamp: String(m?.messageTimestamp ?? m?.internalDate ?? m?.date ?? ""),
      labels: [label],
    };
  }).filter((x): x is SourceItem => !!x);
}

function calendarToItems(data: any): SourceItem[] {
  const evs: any[] = data?.items || data?.events || data?.data?.items || (Array.isArray(data) ? data : []);
  return (evs || []).slice(0, 25).map((e: any): SourceItem | null => {
    const id = String(e?.id ?? e?.eventId ?? "").trim();
    if (!id) return null;
    const start = e?.start?.dateTime || e?.start?.date || e?.start || "";
    return {
      sourceApp: "calendar",
      externalId: id,
      anchorKey: `calendar:${id}`,
      url: e?.htmlLink || undefined,
      title: String(e?.summary ?? "(untitled event)").slice(0, 140),
      snippet: `${start}${e?.location ? ` @ ${e.location}` : ""}${e?.description ? ` — ${String(e.description).replace(/\s+/g, " ").slice(0, 140)}` : ""}`,
      sender: String(e?.organizer?.email ?? "").slice(0, 120),
      timestamp: String(start),
      labels: ["event"],
    };
  }).filter((x): x is SourceItem => !!x);
}

function driveToItems(data: any): SourceItem[] {
  const files: any[] = data?.files || data?.items || data?.data?.files || (Array.isArray(data) ? data : []);
  return (files || []).slice(0, 15).map((f: any): SourceItem | null => {
    const id = String(f?.id ?? f?.fileId ?? "").trim();
    if (!id) return null;
    const modifiedBy = String(f?.lastModifyingUser?.emailAddress ?? f?.lastModifyingUser?.displayName ?? "");
    return {
      sourceApp: "drive",
      externalId: id,
      anchorKey: `drive:${id}`,
      url: f?.webViewLink || undefined,
      title: String(f?.name ?? f?.title ?? "(untitled file)").slice(0, 140),
      snippet: `${f?.mimeType ? String(f.mimeType).replace("application/vnd.google-apps.", "") : "file"}${modifiedBy ? ` — last modified by ${modifiedBy}` : ""}${f?.sharedWithMeTime ? ` — shared with you ${f.sharedWithMeTime}` : ""}`,
      sender: modifiedBy.slice(0, 120),
      timestamp: String(f?.modifiedTime ?? f?.sharedWithMeTime ?? ""),
      labels: [f?.sharedWithMeTime ? "shared" : "modified"],
    };
  }).filter((x): x is SourceItem => !!x);
}

/**
 * Pull candidates from the fixed Google sources. Per-source failures are tolerated (one bad call must
 * not kill the sweep); `attempted` reports whether ANY source responded, so the caller can fall back
 * to the agent sweep when the whole pipeline is unavailable (e.g. Gmail not connected).
 */
export async function discoverSourceItems(userEmail: string): Promise<{ items: SourceItem[]; attempted: boolean }> {
  const items: SourceItem[] = [];
  let attempted = false;
  const grab = async (fn: () => Promise<SourceItem[]>) => {
    try { const got = await fn(); attempted = true; items.push(...got); } catch { /* source unavailable — skip */ }
  };
  await Promise.all([
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:inbox newer_than:7d -category:promotions -category:social", max_results: 20,
    }), "inbox")),
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:sent newer_than:10d", max_results: 15,
    }), "sent")),
    grab(async () => {
      const now = new Date();
      const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      return calendarToItems(await readAction(userEmail, "GOOGLECALENDAR_EVENTS_LIST", {
        timeMin: now.toISOString(), timeMax: week.toISOString(), maxResults: 20, singleEvents: true, orderBy: "startTime",
      }));
    }),
    // Drive: recent files OTHERS shared/touched — docs waiting on the user that never arrive by email.
    grab(async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split(".")[0];
      const files = driveToItems(await readAction(userEmail, "GOOGLEDRIVE_LIST_FILES", {
        q: `(sharedWithMe = true or modifiedTime > '${since}') and trashed = false`,
        orderBy: "modifiedTime desc", pageSize: 15,
        fields: "files(id,name,mimeType,webViewLink,modifiedTime,sharedWithMeTime,lastModifyingUser)",
      }));
      // Only files where ANOTHER person is the actor — the user's own edits aren't a to-do trigger.
      return files.filter((f) => f.labels.includes("shared") || (f.sender && !f.sender.toLowerCase().includes(userEmail.split("@")[0].toLowerCase())));
    }),
  ]);
  // Dedupe by anchor (a sent reply and an inbox thread can share a threadId — keep the inbox copy first).
  const seen = new Set<string>();
  const unique = items.filter((it) => { const k = normKey(it.anchorKey); if (seen.has(k)) return false; seen.add(k); return true; });
  return { items: unique, attempted };
}

/** Deterministic pre-model filter: drop noise and anything whose anchor is already known (active OR handled —
 *  both lists come from the caller's task state). What survives is what the model gets to classify. */
export function filterCandidates(items: SourceItem[], knownAnchors: (string | undefined)[]): SourceItem[] {
  const known = new Set(knownAnchors.map(normKey).filter(Boolean));
  return items.filter((it) => !isNoise(it) && !known.has(normKey(it.anchorKey)));
}
