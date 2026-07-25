// Repo test suite — run with `npm test` (tsx). Pure-function tests: no network, no AI calls.
import { dedupeTasks, foldGenerated, applyProfileUpdate, mergeTaskLists, mergeProfileStates, applyQualityBar, extractArtifacts, unionArtifacts, pruneHandled } from "../server/tasks.ts";
import { parseGenerated, finalize } from "../server/claude.ts";
import { isWriteGatedAction, isGatedAction, ACTION_POLICIES, scopeTools, isArtifactShared } from "../server/integrations.ts";
import { isNoise, filterCandidates, calendarToItems, dedupeByThread } from "../server/discover.ts";
import { dedupeFacts, emptyProfile, canonStatus, isHandled, isInFlight, sortWithinQuadrant, deadlineEpoch, addUsage, monthKeyOf, monthCostUsd, overMonthlyBudget, usageCostUsd, tzOf, isValidTz, isPeakHourUtc } from "../shared/types.ts";
import { sweepDueForDay, localDay, genIntervalMs, sweepDue } from "../server/jobs.ts";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log("  FAIL:", name)); };
const section = (name) => console.log(`— ${name}`);

// ── Generation gates ──────────────────────────────────────────────────────────
section("parseGenerated grounding gates");
const gt = (over = {}) => ({ title: "Reply to Sarah about budget", why: "Sarah asked Tuesday", source: "gmail", urgency: 0.6, importance: 0.7, ...over });
check("gmail without anchor/link dropped", parseGenerated([gt()]).length === 0);
check("gmail with anchor kept", parseGenerated([gt({ anchorKey: "gmail:abc" })]).length === 1);
check("web source without anchor kept", parseGenerated([gt({ source: "web" })]).length === 1);
check("why-less dropped", parseGenerated([gt({ why: "", anchorKey: "gmail:x" })]).length === 0);
check("cap 20", parseGenerated(Array.from({ length: 30 }, (_, i) => gt({ title: `Task ${i} topic${i}`, anchorKey: `gmail:t${i}` }))).length === 20);

// ── Dedupe + dismissed suppression ────────────────────────────────────────────
section("dedupe + dismissed suppression");
const base = { risk: "low", urgency: 0.5, importance: 0.5, quadrant: "do", score: 2, createdAt: new Date().toISOString() };
const dismissed = { ...base, id: "d1", title: "Reply to Vendor Corp pricing survey", why: "Vendor Corp asked for pricing feedback", source: "gmail", status: "dismissed", anchorKey: "gmail:aaa" };
const reworded = { title: "Respond to the Vendor Corp survey on pricing", why: "Vendor Corp wants pricing input", source: "gmail", risk: "low", urgency: 0.6, importance: 0.6, anchorKey: "gmail:bbb" };
const out1 = foldGenerated([dismissed], [reworded]);
check("dismissed lookalike suppressed", out1.length === 1 && out1[0].status === "dismissed");
const doneA = { ...base, id: "a", title: "Book dentist for Thursday", why: "postcard from Dr Wu", source: "gmail", status: "done", anchorKey: "gmail:x1" };
const freshDup = { ...base, id: "b", title: "Book dentist for Thursday", why: "postcard from Dr Wu", source: "gmail", status: "ready", anchorKey: "GMAIL_X1" };
check("done beats fresh duplicate", dedupeTasks([doneA, freshDup]).length === 1 && dedupeTasks([doneA, freshDup])[0].status === "done");
// A genuinely NEW email (distinct anchor) whose title merely RESEMBLES an old DONE task must NOT be
// swallowed into it — different anchors = different real-world items. (Regression: "refresh finds nothing"
// when a fresh inbox thread looked like stale done history.)
const doneOld = { ...base, id: "o1", title: "Reply to the media coverage email", why: "press asked earlier", source: "gmail", status: "done", anchorKey: "gmail:old1" };
const newEmail = { ...base, id: "n1", title: "Reply to the media coverage email", why: "new press request today", source: "gmail", status: "ready", anchorKey: "gmail:new2" };
check("new email not suppressed by similar done task", dedupeTasks([doneOld, newEmail]).length === 2);
// …but two ACTIVE same-title cards (distinct anchors) still merge — no visual duplicates for the user.
const activeOld = { ...doneOld, id: "ac1", status: "needs_review" };
check("active same-title cards still merge", dedupeTasks([activeOld, newEmail]).length === 1);
// …same anchor (formatting drift) always merges, regardless of status.
check("same anchor still merges", dedupeTasks([doneOld, { ...newEmail, anchorKey: "GMAIL_OLD1" }]).length === 1);
// …and anchorless title dups still merge (agent-sweep fallback, non-manual source).
check("anchorless title dup still merges", dedupeTasks([{ ...doneOld, anchorKey: undefined }, { ...newEmail, anchorKey: undefined }]).length === 1);
// MANUAL tasks are a deliberate user action — fuzzy title similarity must NEVER swallow a fresh manual add
// into an old dismissed/done one just because the wording is similar (regression: "add task, it instantly
// disappears" when retesting with a similarly-worded title after an earlier dismissed/done attempt).
const oldManualDone = { ...base, id: "m1", title: "Buy milk", why: "Added by you", source: "manual", status: "done" };
const newManualSimilar = { ...base, id: "m2", title: "Buy milk and eggs", why: "Added by you", source: "manual", status: "ready" };
check("similarly-worded manual tasks do NOT merge (a deliberate add must always survive)", dedupeTasks([oldManualDone, newManualSimilar]).length === 2);
// A truly identical re-add (exact same normalized title) still collapses — that's a real duplicate, not two
// different to-dos, and the more-progressed copy correctly wins.
const newManualExact = { ...base, id: "m3", title: "buy milk", why: "Added by you", source: "manual", status: "ready" };
check("an EXACT-title manual re-add still merges (keeps the more-progressed copy)", dedupeTasks([oldManualDone, newManualExact]).length === 1 && dedupeTasks([oldManualDone, newManualExact])[0].status === "done");

// ── Stale idle tasks auto-archive (keeps the active list a genuine "now" list) ─
section("stale ready tasks auto-archive");
const now = new Date("2026-07-25T12:00:00Z");
const old15d = new Date(now.getTime() - 15 * 86_400_000).toISOString();
const old10d = new Date(now.getTime() - 10 * 86_400_000).toISOString();
// foldGenerated mutates its `existing` items in place, so each fixture below is its own fresh object —
// spreading an already-checked one would silently inherit whatever status the PRIOR call mutated it to.
const staleTask = (over) => ({ ...base, title: "Reply to old outreach thread", why: "asked 3 weeks ago", source: "gmail", status: "ready", ...over });
check("idle ready task older than 14d archives to dismissed", foldGenerated([staleTask({ id: "sr1", anchorKey: "gmail:sr1", createdAt: old15d })], [], [], now).find((t) => t.id === "sr1")?.status === "dismissed");
check("idle ready task under 14d stays active", foldGenerated([staleTask({ id: "sr2", anchorKey: "gmail:sr2", createdAt: old10d })], [], [], now).find((t) => t.id === "sr2")?.status === "ready");
check("a real upcoming deadline keeps an old card alive regardless of age", foldGenerated([staleTask({ id: "sr3", anchorKey: "gmail:sr3", createdAt: old15d, when: new Date(now.getTime() + 86_400_000).toISOString() })], [], [], now).find((t) => t.id === "sr3")?.status === "ready");
check("non-ready statuses are never auto-archived (only untouched 'ready' cards)", foldGenerated([staleTask({ id: "sr4", anchorKey: "gmail:sr4", createdAt: old15d, status: "needs_review" })], [], [], now).find((t) => t.id === "sr4")?.status === "needs_review");

// ── pruneHandled keeps the most recently ACTIONED records, not the most recently CREATED ──
// Bug: sorting by createdAt meant a task dismissed TODAY (but generated weeks ago) could be evicted in
// favor of an OLDER dismissal that just happened to be generated more recently — so a just-dismissed
// item's suppression record could vanish the same sweep it was dismissed in, and the item would resurface
// on the very next sweep. This is the "I dismissed this and it came right back" bug.
section("pruneHandled: dismissed-recency, not created-recency");
const weeksAgo = new Date(now.getTime() - 20 * 86_400_000).toISOString();
const justNow = now.toISOString();
// Generated weeks ago (old inbox item), but the user only just dismissed it moments ago.
const staleCreateFreshDismiss = { ...base, id: "birthday1", title: "Wish Sonya Nyrop a happy birthday", why: "her birthday is on the calendar", source: "calendar", anchorKey: "calendar:sonya-bday-2026", status: "dismissed", createdAt: weeksAgo, updatedAt: justNow };
// A pile of OTHER dismissals, each actioned (updatedAt) progressively longer ago than staleCreateFreshDismiss's
// just-now dismissal, though all created MORE recently than its weeks-old createdAt.
const filler = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `filler${i}`, title: `Filler task ${i}`, why: "noise", source: "gmail", anchorKey: `gmail:filler${i}`, status: "dismissed", createdAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(), updatedAt: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString() }));
const pruned = pruneHandled([staleCreateFreshDismiss, ...filler], 3);
check("a just-dismissed record survives pruning even if it was CREATED long ago", pruned.some((t) => t.id === "birthday1"));
check("older-by-dismissal-time records are the ones dropped when over the cap", pruned.length === 3 && !pruned.some((t) => t.id === "filler4"));

// ── Cross-device merge ────────────────────────────────────────────────────────
section("mergeTaskLists");
const older = new Date(Date.now() - 60000).toISOString(), newer = new Date().toISOString();
const cloudT = { ...base, id: "t1", title: "Send weekly metrics to leadership", why: "Friday report due", source: "gmail", status: "done", anchorKey: "gmail:m1", updatedAt: newer };
const staleT = { ...cloudT, status: "ready", updatedAt: older };
check("done never regresses", mergeTaskLists([cloudT], [staleT])[0].status === "done");
const s1 = { ...base, id: "s1", title: "Prep the offsite agenda deck", why: "offsite Monday", source: "gmail", status: "executed", anchorKey: "gmail:o1", updatedAt: older, steps: [{ text: "Pick venue", automatable: false, done: true }, { text: "Send invites", automatable: false }] };
const s2 = { ...s1, updatedAt: newer, steps: [{ text: "Pick venue", automatable: false }, { text: "Send invites", automatable: false, done: true }] };
const mergedSteps = mergeTaskLists([s1], [s2])[0].steps;
check("step ticks union across devices", mergedSteps.every((s) => s.done));

// ── Profile ───────────────────────────────────────────────────────────────────
section("profile merge + updates");
const p = emptyProfile();
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) leads the Q3 budget review" });
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) now leads marketing" });
check("correction replaces same-entity fact", p.people.length === 1 && p.people[0].includes("marketing"));
check("dedupeFacts caps at 40", dedupeFacts(Array.from({ length: 60 }, (_, i) => `Fact ${i} about very distinct topic ${i} x${i}`)).length <= 40);
const pm = mergeProfileStates(
  { ...emptyProfile(), paused: true, pausedAt: older, workingHours: { start: "09:00", end: "18:00", timezone: "UTC" } },
  { ...emptyProfile(), paused: false, pausedAt: newer },
);
check("newer pause toggle wins", pm.paused === false);
check("structured settings survive merge", pm.workingHours?.start === "09:00");
const pmAcct = mergeProfileStates(
  { ...emptyProfile(), primaryAccounts: { gmail: "acct-a" } },
  { ...emptyProfile(), primaryAccounts: { googlecalendar: "acct-b" } },
);
check("primaryAccounts merge across devices instead of one side clobbering the other", pmAcct.primaryAccounts?.gmail === "acct-a" && pmAcct.primaryAccounts?.googlecalendar === "acct-b");

// ── Policy registry ───────────────────────────────────────────────────────────
section("action policy registry");
check("send email is never-allowed", ACTION_POLICIES.GMAIL_SEND_EMAIL === "never");
check("draft is auto-allowed", ACTION_POLICIES.GMAIL_CREATE_EMAIL_DRAFT === "auto");
check("calendar create needs approval", isWriteGatedAction("GOOGLECALENDAR_CREATE_EVENT") === true);
check("gmail read needs no approval", isWriteGatedAction("GMAIL_FETCH_EMAILS") === false);
check("doc edit needs approval", isWriteGatedAction("GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT") === true);
check("unlisted destructive action falls back to regex", isWriteGatedAction("GOOGLESLIDES_BATCH_UPDATE_PRESENTATION") === true);
check("sheet cell write is auto", isWriteGatedAction("GOOGLESHEETS_UPDATE_VALUES") === false);

// ── Irreversible-action guardrail — the app must NEVER send/delete/invite/pay unattended ─────────
// isGatedAction (tool is STRIPPED from the agent's toolset entirely) — the hardest guarantee.
section("guardrail: never-run (isGatedAction) — sends, deletes, invites, payments");
// Sends (reaching other people) — every channel.
check("Gmail send is gated", isGatedAction("GMAIL_SEND_EMAIL"));
check("Gmail reply is gated", isGatedAction("GMAIL_REPLY_TO_THREAD"));
check("Gmail forward is gated", isGatedAction("GMAIL_FORWARD_MESSAGE"));
check("Gmail send-draft is gated", isGatedAction("GMAIL_SEND_DRAFT"));
check("Slack post is gated", isGatedAction("SLACK_CHAT_POST_MESSAGE"));
check("Slack send-message is gated", isGatedAction("SLACK_SEND_MESSAGE"));
check("Twitter tweet is gated", isGatedAction("TWITTER_CREATE_TWEET"));
check("LinkedIn post is gated", isGatedAction("LINKEDIN_CREATE_POST"));
check("Discord DM is gated", isGatedAction("DISCORD_CREATE_DM"));
check("generic 'invite' action is gated", isGatedAction("GOOGLECALENDAR_SEND_INVITE"));
check("generic 'share' action is gated", isGatedAction("GOOGLEDRIVE_SHARE_FILE"));
check("generic notify/broadcast/announce actions are gated", isGatedAction("SLACK_NOTIFY_CHANNEL") && isGatedAction("TODOIST_BROADCAST_UPDATE") && isGatedAction("HUBSPOT_ANNOUNCE_CAMPAIGN"));
// Deletes / destructive (data can't come back) — every app, not just Google.
check("Gmail delete is gated", isGatedAction("GMAIL_DELETE_MESSAGE"));
check("Gmail trash is gated", isGatedAction("GMAIL_TRASH_MESSAGE"));
check("Calendar delete is gated", isGatedAction("GOOGLECALENDAR_DELETE_EVENT"));
check("Drive delete is gated", isGatedAction("GOOGLEDRIVE_DELETE_FILE"));
check("Sheets delete-sheet is gated", isGatedAction("GOOGLESHEETS_DELETE_SHEET"));
check("generic delete on ANY toolkit is gated (Notion)", isGatedAction("NOTION_DELETE_PAGE"));
check("generic delete on ANY toolkit is gated (GitHub)", isGatedAction("GITHUB_DELETE_REPOSITORY"));
check("generic delete on ANY toolkit is gated (Linear)", isGatedAction("LINEAR_DELETE_ISSUE"));
check("wipe/purge/erase/destroy are gated", isGatedAction("AIRTABLE_WIPE_BASE") && isGatedAction("TRELLO_PURGE_BOARD") && isGatedAction("CLICKUP_ERASE_SPACE") && isGatedAction("ASANA_DESTROY_PROJECT"));
check("empty-trash is gated", isGatedAction("GMAIL_EMPTY_TRASH"));
// Financial (moves money) — a category the old regex never covered at all.
check("payment is gated", isGatedAction("STRIPE_CREATE_PAYMENT"));
check("charge is gated", isGatedAction("STRIPE_CHARGE_CUSTOMER"));
check("refund is gated", isGatedAction("STRIPE_CREATE_REFUND"));
check("checkout is gated", isGatedAction("SHOPIFY_CHECKOUT_COMPLETE"));
check("transfer is gated", isGatedAction("PAYPAL_TRANSFER_FUNDS"));
check("subscribe (recurring charge) is gated", isGatedAction("STRIPE_SUBSCRIBE_CUSTOMER"));
// Safe actions must NOT be caught by the broadened regex (no false positives).
check("reading mail is NOT gated", !isGatedAction("GMAIL_FETCH_EMAILS"));
check("creating a draft is NOT gated", !isGatedAction("GMAIL_CREATE_EMAIL_DRAFT"));
check("updating a draft is NOT gated", !isGatedAction("GMAIL_UPDATE_EMAIL_DRAFT"));
check("listing drafts is NOT gated", !isGatedAction("GMAIL_LIST_DRAFTS"));
check("creating a doc is NOT gated", !isGatedAction("GOOGLEDOCS_CREATE_DOCUMENT"));
check("creating a calendar event is NOT gated (only write-gated)", !isGatedAction("GOOGLECALENDAR_CREATE_EVENT"));
check("a company named 'Sharemint' etc. doesn't false-positive on SHARE", !isGatedAction("HUBSPOT_GET_CONTACT")); // sanity: unrelated read

// isWriteGatedAction (DEFAULT DENY) — the "any other irreversible action" backstop. Any write the code
// hasn't explicitly reviewed as safe must require the user's "Approve & Run" click, not silently run.
section("guardrail: default-deny for unaudited writes (isWriteGatedAction)");
check("unknown app's create action requires approval (GitHub issue)", isWriteGatedAction("GITHUB_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Notion page)", isWriteGatedAction("NOTION_CREATE_PAGE") === true);
check("unknown app's create action requires approval (Linear ticket)", isWriteGatedAction("LINEAR_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Jira issue)", isWriteGatedAction("JIRA_CREATE_ISSUE") === true);
check("unknown app's create action requires approval (Todoist task)", isWriteGatedAction("TODOIST_CREATE_TASK") === true);
check("unknown app's create action requires approval (HubSpot contact)", isWriteGatedAction("HUBSPOT_CREATE_CONTACT") === true);
check("unknown app's update action requires approval (Trello card)", isWriteGatedAction("TRELLO_UPDATE_CARD") === true);
// Reads on any toolkit stay auto (gathering context isn't an action against the world).
check("reads on unaudited toolkits stay auto (GitHub list)", isWriteGatedAction("GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER") === false);
check("reads on unaudited toolkits stay auto (Notion search)", isWriteGatedAction("NOTION_SEARCH_PAGES") === false);
check("reads on unaudited toolkits stay auto (Linear get)", isWriteGatedAction("LINEAR_GET_ISSUE") === false);
// The explicitly-reviewed Google auto-writes must still work (no regression from the default-deny flip).
check("Gmail draft create stays auto (explicit policy)", isWriteGatedAction("GMAIL_CREATE_EMAIL_DRAFT") === false);
check("Sheets cell update stays auto (explicit policy)", isWriteGatedAction("GOOGLESHEETS_UPDATE_VALUES") === false);
check("Sheets append stays auto (explicit policy)", isWriteGatedAction("GOOGLESHEETS_APPEND_VALUES") === false);
check("Docs create-new stays auto (explicit policy)", isWriteGatedAction("GOOGLEDOCS_CREATE_DOCUMENT") === false);

// ── Task lifecycle ────────────────────────────────────────────────────────────
section("task lifecycle");
check("legacy running → executing", canonStatus("running") === "executing");
check("legacy executed → needs_review", canonStatus("executed") === "needs_review");
check("queued is in-flight", isInFlight("queued") && isInFlight("executing") && isInFlight("running"));
check("failed is not in-flight", !isInFlight("failed_retryable") && !isInFlight("failed_terminal"));
check("done/dismissed are handled", isHandled("done") && isHandled("dismissed") && !isHandled("needs_review"));
const doneCopy = { ...base, id: "lc1", title: "Renew the trademark registration", why: "USPTO notice arrived", source: "gmail", status: "done", anchorKey: "gmail:lc1", updatedAt: newer };
const failedCopy = { ...doneCopy, status: "failed_terminal", updatedAt: newer };
check("done beats failed_terminal in merge", mergeTaskLists([doneCopy], [failedCopy])[0].status === "done");
const nrCopy = { ...doneCopy, status: "needs_review" };
const execCopy = { ...doneCopy, status: "executing" };
check("needs_review beats executing in merge", mergeTaskLists([execCopy], [nrCopy])[0].status === "needs_review");

// ── Discovery pipeline filters ────────────────────────────────────────────────
section("discovery filters");
const mk = (over = {}) => ({ sourceApp: "gmail", externalId: "x", anchorKey: "gmail:x", title: "Quick question about the offsite", snippet: "…", sender: "sarah@acme.com", timestamp: "", labels: ["inbox"], ...over });
check("newsletter sender is noise", isNoise(mk({ sender: "newsletter@shop.com" })));
check("no-reply sender is noise", isNoise(mk({ sender: "no-reply@stripe.com" })));
check("unsubscribe subject is noise", isNoise(mk({ title: "March deals — unsubscribe anytime" })));
check("real person is not noise", !isNoise(mk()));
check("sent commitment never noise", isNoise(mk({ sender: "noreply@x.com", labels: ["sent"] })) === false);
const filtered = filterCandidates([mk(), mk({ anchorKey: "GMAIL_KNOWN1", externalId: "k1" }), mk({ sender: "marketing@spam.io", anchorKey: "gmail:sp" })], ["gmail:known1"]);
check("known anchors + noise filtered out", filtered.length === 1 && filtered[0].anchorKey === "gmail:x");

// ── Quality bar (deterministic post-classification thresholds) ────────────────
section("quality bar");
const qItems = [
  { anchorKey: "gmail:vip1", labels: ["inbox"], sender: "Sarah Chen <sarah@acme.com>" },
  { anchorKey: "gmail:low1", labels: ["inbox"], sender: "random@somewhere.com" },
  { anchorKey: "gmail:sent1", labels: ["sent"], sender: "me@me.com" },
  { anchorKey: "gmail:sent2", labels: ["sent"], sender: "me@me.com" },
  { anchorKey: "gmail:hi1", labels: ["inbox"], sender: "colleague@acme.com" },
];
const qTasks = [
  { anchorKey: "gmail:vip1", title: "Reply to Sarah", urgency: 0.2, importance: 0.3 },        // low scores BUT VIP → keep
  { anchorKey: "gmail:low1", title: "Skim optional survey", urgency: 0.2, importance: 0.3 },   // marginal → drop
  { anchorKey: "gmail:sent1", title: "Send the deck", when: "by Friday", urgency: 0.4, importance: 0.4 }, // commitment + deadline → keep
  { anchorKey: "gmail:sent2", title: "Vague follow up", urgency: 0.3, importance: 0.3 },       // commitment, NO deadline, low scores → drop
  { anchorKey: "gmail:hi1", title: "Review the contract", urgency: 0.7, importance: 0.5 },     // high urgency → keep
];
const kept = applyQualityBar(qTasks, qItems, ["Sarah — my manager (sarah@acme.com)"]);
const keptAnchors = kept.map((t) => t.anchorKey);
check("VIP kept despite low scores", keptAnchors.includes("gmail:vip1"));
check("marginal maybe dropped", !keptAnchors.includes("gmail:low1"));
check("deadline'd commitment kept", keptAnchors.includes("gmail:sent1"));
check("vague commitment dropped", !keptAnchors.includes("gmail:sent2"));
check("high-urgency kept", keptAnchors.includes("gmail:hi1"));

// ── Run report guarantees (finalize) ──────────────────────────────────────────
section("finalize run report");
const docLink = { label: "Q3 budget doc", url: "https://docs.google.com/document/d/1xVdKvq8GjwskuuAmuAbCdEfGhIjKlMnOp/edit" };
const fin1 = finalize({ context: "c", synthesis: "Created the budget doc.", steps: [], links: [docLink], sendables: [] }, "", []);
check("links with no steps/sendables get a Review checklist", fin1.steps.length === 1 && fin1.steps[0].text.startsWith("Review") && fin1.steps[0].url === docLink.url);
const fin2 = finalize({ context: "c", synthesis: "Drafted a reply to Sarah.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send reply", to: "s@a.com", subject: "Re", body: "hi", draftId: "r-1234567890" }] }, "", []);
check("sendable needs no backstop step", fin2.steps.length === 0 && fin2.sendables.length === 1);
const fin3 = finalize({ context: "c", synthesis: "Booked nothing.", steps: [{ text: "Pick a date", automatable: false }], links: [docLink], sendables: [] }, "", []);
check("real steps are never overwritten", fin3.steps.length === 1 && fin3.steps[0].text === "Pick a date");
let finThrew = false;
try { finalize({ context: "", synthesis: "Let me first check the calendar and then I'll draft it.", steps: [], links: [], sendables: [] }, "", []); }
catch { finThrew = true; }
check("planning-tense-only result still fails honestly", finThrew);
const fin4 = finalize({ context: "c", synthesis: "Created the doc.", did: ["Created the Q3 doc with the table", "Let me now check the calendar", "- Drafted a reply to Sam"], steps: [{ text: "Pick a date", automatable: false }], links: [], sendables: [] }, "", []);
check("did bullets kept, planning prose dropped, dashes stripped", fin4.did.length === 2 && fin4.did[1] === "Drafted a reply to Sam");
const fin5 = finalize({ context: "c", synthesis: "Made a doc.", steps: [], links: [{ label: "Open", url: docLink.url }], sendables: [] }, "", []);
check("junk link label relabeled by kind", /Google Doc/i.test(fin5.links[0].label));

// ── Task-scoped toolset ───────────────────────────────────────────────────────
section("scopeTools");
const mkTool = (kit, n) => ({ name: `${kit.toUpperCase()}_ACTION_${n}`, description: `[${kit}] does thing ${n}`, input_schema: { type: "object", properties: {} } });
const bigSet = { tools: ["gmail", "googledocs", "googledrive", "googlecalendar", "googlesheets", "googleslides", "github", "notion"].flatMap((k) => Array.from({ length: 8 }, (_, i) => mkTool(k, i))), call: async () => null, connected: [] };
const scopedMail = scopeTools(bigSet, { title: "Reply to Sarah about the offsite venue", why: "she asked yesterday", source: "gmail" });
check("email task drops calendar/sheets/github/notion kits", scopedMail.tools.length === 24 && !scopedMail.tools.some((t) => /^\[(googlecalendar|googlesheets|github|notion)\]/.test(t.description)));
const scopedCal = scopeTools(bigSet, { title: "Schedule a call with the vendor", why: "meeting needed", source: "gmail" });
check("meeting keywords pull calendar back in", scopedCal.tools.some((t) => /^\[googlecalendar\]/.test(t.description)));
const small = { ...bigSet, tools: bigSet.tools.slice(0, 20) };
check("small toolsets pass through untouched", scopeTools(small, { title: "x", why: "y" }).tools.length === 20);

// ── Artifact registry ─────────────────────────────────────────────────────────
section("artifact registry + guardrail: never edit a document Otto didn't create");
const tripDocId = "1xVdKvq8GjwskuuAmuAbCdEfGhIjKlMnOp";
const artInput = {
  links: [{ label: "Trip doc", url: `https://docs.google.com/document/d/${tripDocId}/edit` }],
  sendables: [{ app: "gmail", label: "Send reply", draftId: "r777777777" }, { app: "gcal", label: "Invites", eventId: "evt123456" }],
};
// GUARDRAIL — "Otto may only edit what Otto created": a doc link is only an ARTIFACT (grants the
// no-approval edit carve-out later) when its id is independently VERIFIED as created this run. The
// model's self-reported link alone is never enough — see the fail-closed cases below.
const arts = extractArtifacts(artInput, [tripDocId]);
check("verified doc + draft + event extracted", arts.length === 3 && arts[0].kind === "doc" && arts[1].kind === "draft" && arts[2].kind === "event");
const noVerify = extractArtifacts(artInput);
check("fails closed: no verifiedDocIds → doc dropped (draft/event unaffected)", noVerify.length === 2 && !noVerify.some((a) => a.kind === "doc"));
const wrongVerify = extractArtifacts(artInput, ["someOtherDocIdEntirely1234567"]);
check("fails closed: a link to a DIFFERENT (unverified) doc id is dropped, not trusted", wrongVerify.length === 2 && !wrongVerify.some((a) => a.kind === "doc"));
const merged = unionArtifacts(arts, [{ kind: "doc", id: tripDocId, label: "Trip doc v2" }]);
check("union dedupes by id, keeps latest label", merged.length === 3 && merged.find((a) => a.kind === "doc")?.label === "Trip doc v2");

// ── Discovery: past events + replied threads ──────────────────────────────────
section("discovery time filters");
const NOW = Date.parse("2026-07-19T12:00:00Z");
const evs = calendarToItems({ items: [
  { id: "past1", summary: "Old standup", start: { dateTime: "2026-07-19T09:00:00Z" } },
  { id: "soon1", summary: "Client call", start: { dateTime: "2026-07-19T15:00:00Z" } },
] }, NOW);
check("started events dropped, upcoming kept", evs.length === 1 && evs[0].externalId === "soon1");
const thread = (labels, ts) => ({ sourceApp: "gmail", externalId: "t1", anchorKey: "gmail:t1", title: "Budget question", snippet: "…", sender: "a@b.com", timestamp: ts, labels });
const replied = dedupeByThread([thread(["inbox"], "2026-07-18T10:00:00Z"), thread(["sent"], "2026-07-18T14:00:00Z")]);
check("user's newer reply wins (thread handled)", replied.length === 1 && replied[0].labels.includes("sent"));
const reopened = dedupeByThread([thread(["sent"], "2026-07-18T10:00:00Z"), thread(["inbox"], "2026-07-18T14:00:00Z")]);
check("their newer message wins (thread live again)", reopened.length === 1 && reopened[0].labels.includes("inbox"));

// ── Report guarantees: step flip + stale-step drop ────────────────────────────
section("step quality");
const fin6 = finalize({ context: "c", synthesis: "Gathered the trip details.", did: [], steps: [
  { text: "Create a packing checklist doc with all sections", automatable: false },
  { text: "Decide which hotel you prefer", automatable: false },
], links: [], sendables: [] }, "", []);
check("doable step flipped to automatable, judgment step stays", fin6.steps[0].automatable === true && fin6.steps[1].automatable === false);
// Regression: "Research X and compile a list" was leaving the model's own research work as a hand-back
// step instead of triggering the FINISH-DON'T-HAND-BACK enforcement, because "research"/"find" weren't
// recognized as doable verbs — Otto has web_search + doc tools and should just do this itself.
const fin6b = finalize({ context: "c", synthesis: "Looked into it.", did: [], steps: [
  { text: "Research summer programs for next summer and compile a list of options", automatable: false },
  { text: "Find a time that works for the team", automatable: false },
], links: [], sendables: [] }, "", []);
check("'Research ... compile a list' flipped to automatable", fin6b.steps[0].automatable === true);
check("'Find a time' (coordination, not research) also treated as doable", fin6b.steps[1].automatable === true);
const fin7 = finalize({ context: "c", synthesis: "Created the checklist doc.", did: ["Created the packing checklist doc with all sections"], steps: [
  { text: "Create the packing checklist doc with all sections", automatable: false },
  { text: "Print the checklist for the trip", automatable: false },
], links: [], sendables: [] }, "", []);
check("step duplicating a did-bullet dropped", fin7.steps.length === 1 && /Print/.test(fin7.steps[0].text));

// ── Durable daily sweep (WS1) ─────────────────────────────────────────────────
section("daily sweep timing");
const utcProfile = { ...emptyProfile() };
const nyProfile = { ...emptyProfile(), workingHours: { start: "09:00", end: "18:00", timezone: "America/New_York" } };
check("no prior sweep is due", sweepDueForDay(undefined, utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept earlier same UTC day is NOT due", !sweepDueForDay("2026-07-20T06:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept yesterday IS due", sweepDueForDay("2026-07-19T23:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
// 2026-07-20T02:00Z is still Jul 19 in New York (22:00 EDT) — a "morning" sweep the next NY day is due.
check("timezone day boundary respected", sweepDueForDay("2026-07-20T02:00:00Z", nyProfile, new Date("2026-07-20T13:00:00Z")));
check("localDay in NY vs UTC differ across midnight", localDay("2026-07-20T02:00:00Z", "America/New_York") === "2026-07-19" && localDay("2026-07-20T02:00:00Z", "UTC") === "2026-07-20");

// ── Sweep cadence (genPerDay 1–4) ─────────────────────────────────────────────
section("sweep cadence");
check("default cadence is once a day (24h)", genIntervalMs(utcProfile) === 86_400_000);
check("4×/day cadence is 6h", genIntervalMs({ ...emptyProfile(), genPerDay: 4 }) === 21_600_000);
check("genPerDay clamps above 4", genIntervalMs({ ...emptyProfile(), genPerDay: 9 }) === 21_600_000);
check("genPerDay clamps below 1", genIntervalMs({ ...emptyProfile(), genPerDay: 0 }) === 86_400_000);
// 1×/day: a sweep 2h ago on the SAME day is not due yet (interval not elapsed, day floor met).
check("1×/day: not due 2h after a same-day sweep", !sweepDue({ ...utcProfile, genPerDay: 1, lastSweepAt: "2026-07-20T06:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
// 4×/day: same 2h gap IS enough once >6h... 2h isn't, 7h is.
check("4×/day: not due 2h after a sweep", !sweepDue({ ...utcProfile, genPerDay: 4, lastSweepAt: "2026-07-20T06:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
check("4×/day: due 7h after a sweep", sweepDue({ ...utcProfile, genPerDay: 4, lastSweepAt: "2026-07-20T01:00:00Z" }, new Date("2026-07-20T08:00:00Z")));

// ── DeepSeek peak-hour pricing (UTC 01:00-04:00, 06:00-10:00 cost 2x) ─────────
section("peak-hour pricing");
check("02:00 UTC is peak", isPeakHourUtc(new Date("2026-07-20T02:00:00Z")));
check("01:00 UTC boundary is peak (inclusive start)", isPeakHourUtc(new Date("2026-07-20T01:00:00Z")));
check("04:00 UTC boundary is OFF-peak (exclusive end)", !isPeakHourUtc(new Date("2026-07-20T04:00:00Z")));
check("08:00 UTC is peak", isPeakHourUtc(new Date("2026-07-20T08:00:00Z")));
check("06:00 UTC boundary is peak (inclusive start)", isPeakHourUtc(new Date("2026-07-20T06:00:00Z")));
check("10:00 UTC boundary is OFF-peak (exclusive end)", !isPeakHourUtc(new Date("2026-07-20T10:00:00Z")));
check("12:00 UTC (the cron slot) is off-peak", !isPeakHourUtc(new Date("2026-07-20T12:00:00Z")));
check("00:00 UTC is off-peak", !isPeakHourUtc(new Date("2026-07-20T00:00:00Z")));
check("23:00 UTC is off-peak", !isPeakHourUtc(new Date("2026-07-20T23:00:00Z")));

// ── Timezone resolution ───────────────────────────────────────────────────────
section("timezone");
check("tzOf prefers profile.timezone", tzOf({ ...emptyProfile(), timezone: "Europe/Paris", workingHours: { start: "9", end: "18", timezone: "UTC" } }) === "Europe/Paris");
check("tzOf falls back to workingHours", tzOf({ ...emptyProfile(), workingHours: { start: "9", end: "18", timezone: "America/New_York" } }) === "America/New_York");
check("tzOf falls back to UTC", tzOf(emptyProfile()) === "UTC");
check("isValidTz accepts a real zone", isValidTz("Europe/Paris"));
check("isValidTz rejects junk", !isValidTz("Mars/Olympus"));

// ── Monthly spend cap ─────────────────────────────────────────────────────────
section("spend cap");
// usageCostUsd: 1M input + 1M output = 0.27 + 1.10 USD.
check("usageCostUsd weights in/out separately", Math.abs(usageCostUsd(1e6, 1e6) - 1.37) < 1e-9);
// addUsage accumulates within a month and rolls the month* counters over at the boundary.
const upA = emptyProfile();
addUsage(upA, { in: 1000, out: 2000 });
check("addUsage sets monthKey + month counters", upA.usage.monthKey === monthKeyOf("UTC") && upA.usage.monthIn === 1000 && upA.usage.monthOut === 2000);
addUsage(upA, { in: 500, out: 0 });
check("addUsage accumulates within the month", upA.usage.monthIn === 1500 && upA.usage.in === 1500);
// A stale monthKey → this month reads as $0 (rollover), even though cumulative persists.
const stale = { ...emptyProfile(), usage: { in: 9e9, out: 9e9, runs: 5, since: "2020-01-01", monthKey: "2020-01", monthIn: 9e9, monthOut: 9e9 } };
check("monthCostUsd is 0 after a month rollover", monthCostUsd(stale, "UTC") === 0);
// overMonthlyBudget honors MONTHLY_AI_BUDGET_USD.
const heavy = { ...emptyProfile(), usage: { in: 5e8, out: 5e8, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthIn: 5e8, monthOut: 5e8 } }; // ≈ $685 this month
const prevBudget = process.env.MONTHLY_AI_BUDGET_USD;
process.env.MONTHLY_AI_BUDGET_USD = "3";
check("overMonthlyBudget true when way over", overMonthlyBudget(heavy) === true);
check("overMonthlyBudget false for a fresh profile", overMonthlyBudget(emptyProfile()) === false);
process.env.MONTHLY_AI_BUDGET_USD = "0";
check("budget of 0 blocks any usage", overMonthlyBudget(upA) === true);
if (prevBudget === undefined) delete process.env.MONTHLY_AI_BUDGET_USD; else process.env.MONTHLY_AI_BUDGET_USD = prevBudget;

// ── Eisenhower ranking (WS2) ──────────────────────────────────────────────────
section("sortWithinQuadrant");
const RANK_NOW = new Date("2026-07-20T12:00:00Z");
const rt = (over) => ({ score: 2, when: "", source: "gmail", why: "", title: "", updatedAt: "2026-07-20T00:00:00Z", createdAt: "2026-07-20T00:00:00Z", ...over });
const byScore = sortWithinQuadrant([rt({ title: "low", score: 1 }), rt({ title: "high", score: 3 })], [], RANK_NOW);
check("higher Eisenhower score first", byScore[0].title === "high");
const byDeadline = sortWithinQuadrant([rt({ title: "later", when: "July 30" }), rt({ title: "sooner", when: "today" })], [], RANK_NOW);
check("same score → sooner deadline first", byDeadline[0].title === "sooner");
const noWhenLast = sortWithinQuadrant([rt({ title: "none" }), rt({ title: "dated", when: "tomorrow" })], [], RANK_NOW);
check("a real deadline beats no deadline", noWhenLast[0].title === "dated");
const byVip = sortWithinQuadrant([rt({ title: "random", why: "someone asked" }), rt({ title: "boss", why: "Sarah needs the numbers" })], ["Sarah — my manager (sarah@acme.com)"], RANK_NOW);
check("high-priority person breaks a tie", byVip[0].title === "boss");
check("deadlineEpoch: empty sorts last", deadlineEpoch("") === Infinity && deadlineEpoch("today", RANK_NOW) === RANK_NOW.getTime());

// ── Guardrail: shared-doc edits fail CLOSED, never open ───────────────────────
// isArtifactShared backs the "Otto may edit its own artifact" carve-out (integrations.ts). Any error —
// including "integrations not configured" (COMPOSIO_API_KEY unset here) — must be treated as SHARED, so
// the carve-out never silently fires when sharing status can't actually be confirmed.
section("guardrail: shared-artifact check fails closed");
check("no fileId → treated as shared (no bypass)", await isArtifactShared("user@example.com", "") === true);
check("unreachable/unconfigured Composio → treated as shared (fail closed)", await isArtifactShared("user@example.com", "some-real-looking-file-id-12345") === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
