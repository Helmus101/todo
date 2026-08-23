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
import { readAction, getConnectedAccounts } from "./integrations.ts";
import { pronoteConnected, pronoteHomework, pronoteTests } from "./pronote.ts";

export interface SourceItem {
  sourceApp: "gmail" | "calendar" | "drive" | "github" | "pronote";
  externalId: string;
  anchorKey: string;      // "gmail:<threadId>" / "calendar:<eventId>" / "drive:<fileId>" — the dedupe identity
  url?: string;
  title: string;
  snippet: string;
  sender?: string;
  timestamp?: string;
  labels: string[];       // e.g. ["inbox"], ["sent"] (a sent item = a commitment the user made), ["event"], ["shared"]
  accountId?: string;     // Composio connected-account id this came from (multi-Gmail: routes execution back)
  accountEmail?: string;  // the account's own address (for display / disambiguation)
  /** Pronote only: the school subject as Pronote names it ("Physique-Chimie"). Carried onto the task as
   *  `sourceSubject` so the run can shape the artifact per subject (formulas vs timeline vs vocab deck). */
  subject?: string;
}

// Deterministic noise filters — mass mail never even reaches the model.
const NOISE_SENDER = /no-?reply|donotreply|newsletter|marketing|updates?@|news@|mailer@|bounce/i;
const NOISE_SUBJECT = /unsubscribe|newsletter|weekly digest|daily digest|verify your email|security alert/i;
// Life-admin mail that USED to be hard-dropped as noise (it comes from an automated/billing-style sender
// and often LOOKS like a receipt) but is exactly what a "mind the renewals/returns/duplicate subscriptions"
// pass needs to see: a subscription about to renew or jump in price, a return/exchange window closing, a
// check-in window opening. Automated ≠ irrelevant — let the classifier (server/claude.ts) judge these on
// their merits instead of a deterministic filter discarding them before it ever gets the chance.
const ACTIONABLE_AUTOMATED = /renew(s|al|ing|ed)?\b|price (increase|change|goes up|rises|will (jump|rise))|trial (ends|ending|expires)|about to (charge|renew)|return (by|window|deadline|policy)|exchange (by|window)|final (day|days|chance) to return|check-?in (opens|available|window)|boarding pass|subscription/i;
// Otto's own "new task" alert (server/jobs.ts's notifyNewTasks) is sent from the user's Gmail to that
// same address — it shows up in both "inbox" and "sent" reads with a normal sender, so neither noise
// filter above would catch it. Left unfiltered, the NEXT sweep reads its own alert email back as a
// "new" item and can turn it into a task about itself. Match its fixed subject shape (kept in sync with
// notifyNewTasks) before any other check, regardless of label.
const OTTO_SELF_EMAIL_SUBJECT = /^otto\s*[—-]\s*(nouvelle t[âa]che|\d+\s*nouvelles t[âa]ches)/i;
export function isNoise(it: SourceItem): boolean {
  if (it.sourceApp === "gmail" && OTTO_SELF_EMAIL_SUBJECT.test(it.title || "")) return true;
  if (it.labels.includes("sent")) return false; // the user's own commitments are never noise
  if (ACTIONABLE_AUTOMATED.test(it.title || "") || ACTIONABLE_AUTOMATED.test(it.snippet || "")) return false;
  return NOISE_SENDER.test(it.sender || "") || NOISE_SUBJECT.test(it.title || "");
}

// Collapse (not strip) separators — stripping entirely let two DIFFERENT anchors collide, e.g. GitHub's
// "owner/x1#2" and "owner/x#12" both normalized to "githubownerx12", so dedupeByThread/filterCandidates
// could silently drop or hide a genuinely new issue. A single placeholder character keeps the digit
// boundary intact while still ignoring cosmetic punctuation differences.
const normKey = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");

// Composio response shapes drift between versions — read every known key defensively.
function gmailToItems(data: any, label: string, account?: { id?: string; email?: string }): SourceItem[] {
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
      snippet: String(m?.preview?.body ?? m?.snippet ?? m?.messageText ?? m?.preview ?? "").replace(/\s+/g, " ").slice(0, 400),
      sender: String(m?.sender ?? m?.from ?? m?.fromAddress ?? "").slice(0, 120),
      timestamp: String(m?.messageTimestamp ?? m?.internalDate ?? m?.date ?? ""),
      labels: [label],
      accountId: account?.id,
      accountEmail: account?.email,
    };
  }).filter((x): x is SourceItem => !!x);
}

export function calendarToItems(data: any, now: number = Date.now(), account?: { id?: string; email?: string }): SourceItem[] {
  const evs: any[] = data?.items || data?.events || data?.data?.items || (Array.isArray(data) ? data : []);
  return (evs || []).slice(0, 25).map((e: any): SourceItem | null => {
    const id = String(e?.id ?? e?.eventId ?? "").trim();
    if (!id) return null;
    const start = e?.start?.dateTime || e?.start?.date || e?.start || "";
    // An event that already started can't be prepped for — it must never become a "prep" task.
    const startMs = Date.parse(String(start)) || 0;
    if (startMs && startMs < now - 60 * 60_000) return null;
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
      accountId: account?.id,
      accountEmail: account?.email,
    };
  }).filter((x): x is SourceItem => !!x);
}

function driveToItems(data: any, account?: { id?: string; email?: string }): SourceItem[] {
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
      accountId: account?.id,
      accountEmail: account?.email,
    };
  }).filter((x): x is SourceItem => !!x);
}

function githubToItems(data: any, label: string, account?: { id?: string; email?: string }): SourceItem[] {
  const rows: any[] = data?.issues || data?.items || (Array.isArray(data) ? data : []);
  return (rows || []).slice(0, 15).map((r: any): SourceItem | null => {
    const url = String(r?.html_url ?? r?.htmlUrl ?? "").trim();
    const num = r?.number;
    // repo from html_url ("…github.com/owner/repo/issues/12") — the repository field shape varies more.
    const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1] || "";
    if (!url || !Number.isInteger(num)) return null;
    return {
      sourceApp: "github",
      externalId: `${repo}#${num}`,
      anchorKey: `github:${repo}#${num}`,
      url,
      title: String(r?.title ?? "(untitled)").slice(0, 140),
      snippet: `${r?.pull_request || /\/pull\//.test(url) ? "PR" : "issue"} in ${repo}${r?.user?.login ? ` — opened by ${r.user.login}` : ""}`,
      sender: String(r?.user?.login ?? "").slice(0, 120),
      timestamp: String(r?.updated_at ?? r?.created_at ?? ""),
      labels: [label],
      accountId: account?.id,
      accountEmail: account?.email,
    };
  }).filter((x): x is SourceItem => !!x);
}

// Exported for tests (same precedent as calendarToItems) — the énoncé this carries is what makes every
// downstream artifact specific, so it's worth pinning that `snippet`/`subject` survive.
export function pronoteToItems(items: { id: string; subject: string; description: string; deadline: string; done: boolean }[]): SourceItem[] {
  return items.map((a): SourceItem => ({
    sourceApp: "pronote",
    externalId: a.id,
    anchorKey: `pronote:${a.id}`,
    // No stable deep-link into a specific assignment — Pronote's read API doesn't expose one.
    title: `${a.subject} homework`.slice(0, 140),
    snippet: a.description || `Due ${a.deadline}`,
    timestamp: a.deadline,
    labels: ["homework"],
    subject: a.subject,
  }));
}

export function pronoteTestsToItems(items: { id: string; subject: string; deadline: string }[]): SourceItem[] {
  return items.map((t): SourceItem => ({
    sourceApp: "pronote",
    // Timetable lesson ids aren't stable across re-fetches, so anchor on subject+date instead — this is
    // what keeps a re-sweep from either duplicating the same test or losing it once the id rotates.
    externalId: t.id,
    anchorKey: `pronote-test:${t.subject}:${t.deadline.slice(0, 10)}`,
    title: `${t.subject} test`.slice(0, 140),
    // Pronote's timetable exposes no description for a test — only subject + date. Deliberately left as a
    // bare marker: `hasAssignmentText` below rejects it so a test never produces a fake "énoncé" block.
    snippet: `Test on ${t.deadline}`,
    timestamp: t.deadline,
    labels: ["test"],
    subject: t.subject,
  }));
}

/** Is this snippet the source's REAL words, or just a synthesized placeholder ("Due 2026-09-02",
 *  "Test on …")? Only real text is worth carrying onto the task as `sourceDetail` — a placeholder
 *  would give the run a confident-looking énoncé block containing nothing but a date it already has. */
export function hasAssignmentText(snippet: string): boolean {
  const s = String(snippet || "").trim();
  if (s.length < 12) return false;
  return !/^(due|test on)\b/i.test(s);
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
  // Multi-account (Google): read from EVERY connected account per app, tagging each item with its account so
  // execution routes back to the right one. With 0-1 accounts we pass no id (unchanged single-account path).
  const accountsFor = async (app: string): Promise<{ id?: string; email?: string }[]> => {
    try { const a = await getConnectedAccounts(userEmail, app); return a.length > 1 ? a.map((x) => ({ id: x.id, email: x.email })) : [{}]; } catch { return [{}]; }
  };
  const [gmailAccounts, calAccounts, driveAccounts, githubAccounts, pronoteOn] = await Promise.all([accountsFor("gmail"), accountsFor("googlecalendar"), accountsFor("googledrive"), accountsFor("github"), pronoteConnected(userEmail)]);
  const gmailGrabs = gmailAccounts.flatMap((acc) => [
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:inbox newer_than:7d -category:promotions -category:social", max_results: 20,
    }, acc.id), "inbox", acc)),
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: "in:sent newer_than:10d", max_results: 15,
    }, acc.id), "sent", acc)),
    // Life-admin sweep: renewal/price-hike notices and order confirmations that gate a return window are
    // exactly the mail Gmail auto-sorts into Promotions/Updates (dropped by the -category filter above),
    // and a return window (often 30 days) regularly outlives the 7-day inbox lookback — so without this,
    // isNoise's ACTIONABLE_AUTOMATED carve-out never gets anything to actually see. Bounded by keyword
    // match (not a blanket promotions read) so this doesn't reopen the door to plain marketing blasts.
    grab(async () => gmailToItems(await readAction(userEmail, "GMAIL_FETCH_EMAILS", {
      query: `in:inbox newer_than:30d (subscription OR renews OR renewal OR "price increase" OR "trial ends" ` +
        `OR "trial expires" OR "return by" OR "return window" OR "exchange by" OR "final day to return" OR ` +
        `"final days to return" OR "check-in" OR "boarding pass")`,
      max_results: 15,
    }, acc.id), "inbox", acc)),
  ]);
  const calGrabs = calAccounts.map((acc) => grab(async () => {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    return calendarToItems(await readAction(userEmail, "GOOGLECALENDAR_EVENTS_LIST", {
      timeMin: now.toISOString(), timeMax: week.toISOString(), maxResults: 20, singleEvents: true, orderBy: "startTime",
    }, acc.id), Date.now(), acc);
  }));
  const driveGrabs = driveAccounts.map((acc) => grab(async () => {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split(".")[0];
    const files = driveToItems(await readAction(userEmail, "GOOGLEDRIVE_LIST_FILES", {
      q: `(sharedWithMe = true or modifiedTime > '${since}') and trashed = false`,
      orderBy: "modifiedTime desc", pageSize: 15,
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,sharedWithMeTime,lastModifyingUser)",
    }, acc.id), acc);
    // Only files where ANOTHER person is the actor — the user's own edits aren't a to-do trigger.
    return files.filter((f) => f.labels.includes("shared") || (f.sender && !f.sender.toLowerCase().includes(userEmail.split("@")[0].toLowerCase())));
  }));
  await Promise.all([
    ...gmailGrabs,
    ...calGrabs,
    ...driveGrabs,
    // GitHub (if connected): things waiting on the user — open issues assigned to them, PRs where their
    // review was requested. Both fail silently for accounts without GitHub. Multi-account like Gmail/
    // Calendar/Drive above — a second GitHub account (e.g. work + personal) used to be silently skipped.
    ...githubAccounts.flatMap((acc) => [
      grab(async () => githubToItems(await readAction(userEmail, "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", {
        filter: "assigned", state: "open", per_page: 10,
      }, acc.id), "assigned", acc)),
      grab(async () => githubToItems(await readAction(userEmail, "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", {
        q: "is:open is:pr review-requested:@me", per_page: 10,
      }, acc.id), "review-requested", acc)),
    ]),
    // Pronote (if connected) — outside the Composio/getConnectedAccounts path entirely; checked separately.
    // Gated OUTSIDE grab() deliberately: grab() marks `attempted` true on any non-throwing call, and a
    // "not connected" check always succeeds — that would make `attempted` true for a user with NOTHING
    // connected at all (not even Pronote), wrongly skipping the agent-sweep fallback for them.
    ...(pronoteOn.connected ? [
      grab(async () => pronoteToItems(await pronoteHomework(userEmail))),
      grab(async () => pronoteTestsToItems(await pronoteTests(userEmail))),
    ] : []),
  ]);
  return { items: dedupeByThread(items), attempted };
}

/** Collapse items sharing one anchor (a sent reply + its inbox thread share a threadId). When both an
 *  inbox and a sent copy exist, the TIMESTAMPS decide: the user's reply being NEWER means they already
 *  answered — keep the sent copy (commitment detection) and drop the inbox one, so "reply to X" tasks
 *  never surface for threads the user has handled. An inbox message newer than the sent copy means the
 *  other person wrote back — that's live again, keep the inbox copy. */
export function dedupeByThread(items: SourceItem[]): SourceItem[] {
  const byAnchor = new Map<string, SourceItem>();
  const ts = (it: SourceItem) => Date.parse(it.timestamp || "") || Number(it.timestamp) || 0;
  for (const it of items) {
    const k = normKey(it.anchorKey);
    const cur = byAnchor.get(k);
    if (!cur) { byAnchor.set(k, it); continue; }
    const inbox = cur.labels.includes("inbox") ? cur : it.labels.includes("inbox") ? it : null;
    const sent = cur.labels.includes("sent") ? cur : it.labels.includes("sent") ? it : null;
    if (inbox && sent) byAnchor.set(k, ts(sent) >= ts(inbox) ? sent : inbox);
    // otherwise: same-source duplicate — first wins
  }
  return [...byAnchor.values()];
}

/** Deterministic pre-model filter: drop noise and anything whose anchor is already known (active OR handled —
 *  both lists come from the caller's task state). What survives is what the model gets to classify. */
export function filterCandidates(items: SourceItem[], knownAnchors: (string | undefined)[]): SourceItem[] {
  const known = new Set(knownAnchors.map(normKey).filter(Boolean));
  return items.filter((it) => !isNoise(it) && !known.has(normKey(it.anchorKey)));
}
