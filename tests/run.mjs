// Repo test suite — run with `npm test` (tsx). Pure-function tests: no network, no AI calls.
import { readFileSync } from "node:fs";
import { dedupeTasks, foldGenerated, applyProfileUpdate, mergeTaskLists, mergeProfileStates, applyQualityBar, extractArtifacts, unionArtifacts, pruneHandled, forcedDueToday, forceWeekCoverage } from "../server/tasks.ts";
import { parseGenerated, finalize, reconcileArtifactClaims, trackLine, isBigIbProject, makeNote, makeDeck, makeQuiz, assignmentBlock, CHAT_DOES_WORK, DOES_STUDENT_WORK, PLAN_ONLY_OVERRIDE } from "../server/claude.ts";
import { replanMilestones } from "../server/milestones.ts";
import { isWriteGatedAction, isGatedAction, ACTION_POLICIES, scopeTools, isArtifactShared } from "../server/integrations.ts";
import { isNoise, filterCandidates, calendarToItems, dedupeByThread, pronoteToItems, pronoteTestsToItems, hasAssignmentText } from "../server/discover.ts";
import { dedupeFacts, emptyProfile, canonStatus, isHandled, isInFlight, sortWithinQuadrant, deadlineEpoch, addUsage, monthKeyOf, monthCostUsd, overMonthlyBudget, overInteractiveBudget, usageCostUsd, callCostUsd, USD_PER_1M_IN, USD_PER_1M_CACHED_IN, USD_PER_1M_OUT, tzOf, isValidTz, isPeakHourUtc, isLowGrade, gradesBySubject } from "../shared/types.ts";
import { sweepDueForDay, localDay, genIntervalMs, sweepDue, tasksToEnqueue } from "../server/jobs.ts";
import { computeWorkload, isPileUp, lightestDay } from "../server/workload.ts";

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
// Even an EXACT-title re-add of a HANDLED task must survive as a NEW active task — re-typing a to-do you
// finished or dismissed before is a deliberate request to do it again, never a duplicate to hide. (This is
// the "add a task, it instantly auto-deletes" bug: a handled copy was swallowing the fresh manual add.)
const newManualExact = { ...base, id: "m3", title: "buy milk", why: "Added by you", source: "manual", status: "ready" };
const exactRes = dedupeTasks([oldManualDone, newManualExact]);
check("an EXACT-title manual re-add of a DONE task still survives as a new active task", exactRes.length === 2 && exactRes.some((t) => t.id === "m3" && t.status === "ready"));
// Two ACTIVE identical manual cards DO still merge — that's a genuine visual duplicate, not two to-dos.
const activeA = { ...base, id: "m4", title: "buy milk", why: "Added by you", source: "manual", status: "ready" };
const activeB = { ...base, id: "m5", title: "buy milk", why: "Added by you", source: "manual", status: "queued" };
check("two ACTIVE identical manual cards still merge (no visual duplicate)", dedupeTasks([activeA, activeB]).length === 1);

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

const c1 = { ...base, id: "c1", title: "Finish the essay", why: "due Friday", source: "manual", status: "needs_review", updatedAt: older, chat: [{ role: "user", text: "how do I start?", at: older }, { role: "assistant", text: "Start with the thesis.", at: older }] };
const c2 = { ...c1, updatedAt: newer, chat: [{ role: "user", text: "what about the conclusion?", at: newer }, { role: "assistant", text: "Tie it back to the thesis.", at: newer }] }; // no earlier turns — a device that only just opened the task
const mergedChat = mergeTaskLists([c1], [c2])[0].chat;
check("chat turns union across devices instead of the winner's copy replacing the loser's", mergedChat.length === 4);
check("unioned chat stays chronologically ordered", mergedChat[0].text === "how do I start?" && mergedChat[3].text === "Tie it back to the thesis.");

// ── Profile ───────────────────────────────────────────────────────────────────
section("profile merge + updates");
const p = emptyProfile();
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) leads the Q3 budget review" });
applyProfileUpdate(p, { category: "person", fact: "Sarah (sarah@acme.com) now leads marketing" });
check("correction replaces same-entity fact", p.people.length === 1 && p.people[0].includes("marketing"));
check("dedupeFacts caps at 40", dedupeFacts(Array.from({ length: 60 }, (_, i) => `Fact ${i} about very distinct topic ${i} x${i}`)).length <= 40);
const pm = mergeProfileStates(
  { ...emptyProfile(), paused: true, pausedAt: older, responseStyle: "concise" },
  { ...emptyProfile(), paused: false, pausedAt: newer },
);
check("newer pause toggle wins", pm.paused === false);
check("structured settings survive merge", pm.responseStyle === "concise");
const pmAcct = mergeProfileStates(
  { ...emptyProfile(), primaryAccounts: { gmail: "acct-a" } },
  { ...emptyProfile(), primaryAccounts: { googlecalendar: "acct-b" } },
);
check("primaryAccounts merge across devices instead of one side clobbering the other", pmAcct.primaryAccounts?.gmail === "acct-a" && pmAcct.primaryAccounts?.googlecalendar === "acct-b");
// A manual grade logged on device A must survive a merge against device B's copy, which doesn't have it
// yet — grades are a history now (union by id), not a one-row-per-subject snapshot (last-write-wins).
const pmGrades = mergeProfileStates(
  { ...emptyProfile(), grades: [{ id: "a", subject: "Maths", grade: 15, scale: 20, updatedAt: older, source: "manual" }] },
  { ...emptyProfile(), grades: [{ id: "b", subject: "Maths", grade: 12, scale: 20, updatedAt: newer, source: "manual" }] },
);
check("both devices' manual grade entries survive the merge (union by id)", pmGrades.grades?.length === 2);
const pmGradeSync = mergeProfileStates(
  { ...emptyProfile(), grades: [{ id: "p1", subject: "Physique", grade: 10, scale: 20, updatedAt: older, source: "pronote" }] },
  { ...emptyProfile(), grades: [{ id: "p1", subject: "Physique", grade: 14, scale: 20, updatedAt: newer, source: "pronote" }] },
);
check("same-id Pronote row still collapses to the newer sync, not duplicated", pmGradeSync.grades?.length === 1 && pmGradeSync.grades?.[0].grade === 14);

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
// The model's own "is this big?" judgment (not a keyword guess) rides through finalize() so
// writeStepsFromContext can use it even when the title never names an acronym — see RunOutput.isBigProject.
const finBig = finalize({ context: "c", synthesis: "Gathered sources.", steps: [], links: [], sendables: [], isBigProject: true }, "", []);
check("finalize passes through a true isBigProject flag", finBig.isBigProject === true);
const finNotBig = finalize({ context: "c", synthesis: "Done.", steps: [], links: [], sendables: [], isBigProject: false }, "", []);
check("finalize passes through a false isBigProject flag", finNotBig.isBigProject === false);
const finNoFlag = finalize({ context: "c", synthesis: "Done.", steps: [], links: [], sendables: [] }, "", []);
check("finalize omits isBigProject when the model didn't answer (no silent default)", finNoFlag.isBigProject === undefined);
const fin2 = finalize({ context: "c", synthesis: "Drafted a reply to Sarah.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send reply", to: "s@a.com", subject: "Re", body: "hi", draftId: "r-1234567890" }] }, "", []);
check("sendable needs no backstop step", fin2.steps.length === 0 && fin2.sendables.length === 1);
// A REPLY draft has no explicit "to" (Gmail infers it from the thread) — it must STILL surface as a
// sendable, or the drafted reply never shows a Send button ("draft reply isn't showing the reply" bug).
const finReply = finalize({ context: "c", synthesis: "Drafted a reply.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send reply", subject: "Re: hi", body: "thanks!", draftId: "r-99" }] }, "", []);
check("reply draft without `to` still surfaces a sendable", finReply.sendables.length === 1 && finReply.sendables[0].draftId === "r-99");
// But a placeholder recipient is still dropped (never offer to send into the void).
const finPh = finalize({ context: "c", synthesis: "Drafted.", steps: [], links: [],
  sendables: [{ app: "gmail", label: "Send", to: "someone@example.com", subject: "s", body: "b", draftId: "r-1" }] }, "", []);
check("placeholder recipient still dropped", finPh.sendables.length === 0);
const fin3 = finalize({ context: "c", synthesis: "Booked nothing.", steps: [{ text: "Pick a date", automatable: false }], links: [docLink], sendables: [] }, "", []);
check("real steps are never overwritten", fin3.steps.length === 1 && fin3.steps[0].text === "Pick a date");
let finThrew = false;
try { finalize({ context: "", synthesis: "Let me first check the calendar and then I'll draft it.", steps: [], links: [], sendables: [] }, "", []); }
catch { finThrew = true; }
check("planning-tense-only result still fails honestly", finThrew);
const fin4 = finalize({ context: "c", synthesis: "Created the doc.", did: ["Created the Q3 doc with the table", "Let me now check the calendar", "- Drafted a reply to Sam"], steps: [{ text: "Pick a date", automatable: false }], links: [], sendables: [] }, "", []);
check("did bullets kept, planning prose dropped, dashes stripped", fin4.did.length === 2 && fin4.did[1] === "Drafted a reply to Sam");
// Regression: a model that returns OBJECTS in did[] (instead of the requested strings) must never render as
// "[object Object]" on the card — finalize coerces each entry to readable text before it reaches the client.
const fin4b = finalize({ context: "c", synthesis: "Created the doc.", did: [{ text: "Created the Q3 doc with the table" }, { message: "Filled 12 cells in the sheet" }], steps: [], links: [], sendables: [] }, "", []);
check("object did[] entries coerced to their text, never [object Object]", fin4b.did.every((d) => typeof d === "string" && !d.includes("[object Object]")) && fin4b.did.length === 2);
const fin5 = finalize({ context: "c", synthesis: "Made a doc.", steps: [], links: [{ label: "Open", url: docLink.url }], sendables: [] }, "", []);
check("junk link label relabeled by kind", /Google Doc/i.test(fin5.links[0].label));

// ── Reconcile draft claims with surviving artifacts (the "said it drafted, didn't" bug) ──
section("reconcile artifact claims");
// A "Drafted a reply" claim with NO sendable is a fabrication — strip it.
const rc1 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi apologizing about the AI service.", did: ["Drafted a reply to Mmachi apologizing that the AI service on Weave wasn't working"], links: [], sendables: [], steps: [] });
check("unbacked draft claim stripped from did", rc1.did.length === 0);
check("unbacked draft claim stripped from synthesis", rc1.synthesis === "");
check("honest step added when nothing real remains", rc1.steps.length === 1 && !rc1.steps[0].automatable);
// WITH a sendable, the same claim is truthful — leave it untouched.
const rc2 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi.", did: ["Drafted a reply to Mmachi"], links: [], sendables: [{ app: "gmail", label: "Send", to: "m@a.com", draftId: "r-1", body: "x" }], steps: [] });
check("backed draft claim kept when a sendable exists", rc2.did.length === 1 && rc2.synthesis === "Drafted a reply to Mmachi.");
// Non-draft work (a real doc with a link) is never touched by this pass.
const rc3 = reconcileArtifactClaims({ synthesis: "Built the Q3 doc.", did: ["Built the Q3 budget doc"], links: [{ label: "Q3 doc", url: "https://docs.google.com/document/d/x" }], sendables: [], steps: [] });
check("non-draft claim untouched", rc3.did.length === 1 && rc3.synthesis === "Built the Q3 doc.");
// FALSE-POSITIVE GUARD: "Drafted the proposal doc" is DOCUMENT drafting (backed by a link, not a sendable) —
// the message-claim regex must NOT strip it just because it contains the word "drafted".
const rc3b = reconcileArtifactClaims({ synthesis: "Drafted the proposal document.", did: ["Drafted the proposal doc", "Composed a one-page summary"], links: [{ label: "Proposal", url: "https://docs.google.com/document/d/z" }], sendables: [], steps: [] });
check("document drafting not mistaken for an email claim", rc3b.did.length === 2 && rc3b.synthesis === "Drafted the proposal document.");
// A draft claim stripped but OTHER real output remains → no hollow step added.
const rc4 = reconcileArtifactClaims({ synthesis: "Drafted a reply.", did: ["Drafted a reply", "Created the Q3 doc"], links: [{ label: "d", url: "https://docs.google.com/document/d/y" }], sendables: [], steps: [] });
check("no honest step when other real output survives", rc4.did.length === 1 && rc4.did[0] === "Created the Q3 doc" && !rc4.steps.length);
// Tolerates the WebTask shape (undefined arrays) — the job-layer call path.
const rc5 = reconcileArtifactClaims({ synthesis: "Drafted a reply to Mmachi.", did: undefined, links: undefined, sendables: undefined, steps: undefined });
check("tolerates undefined arrays (WebTask shape)", rc5.synthesis === "" && Array.isArray(rc5.steps) && rc5.steps.length === 1);
// A genuine user step already present → stays honest without piling on another.
const rc6 = reconcileArtifactClaims({ synthesis: "Drafted it.", did: ["Drafted the message"], links: [], sendables: [], steps: [{ text: "Pick the recipient", automatable: false }] });
check("existing real step preserved, none added", rc6.steps.length === 1 && rc6.steps[0].text === "Pick the recipient");

// ── Task-scoped toolset ───────────────────────────────────────────────────────
section("scopeTools");
const mkTool = (kit, n) => ({ name: `${kit.toUpperCase()}_ACTION_${n}`, description: `[${kit}] does thing ${n}`, input_schema: { type: "object", properties: {} } });
const bigSet = { tools: ["gmail", "googledocs", "googledrive", "googlecalendar", "googlesheets", "googleslides", "github", "notion"].flatMap((k) => Array.from({ length: 8 }, (_, i) => mkTool(k, i))), call: async () => null, connected: [] };
const scopedMail = scopeTools(bigSet, { title: "Reply to Sarah about the offsite venue", why: "she asked yesterday", source: "gmail" });
check("email task drops calendar/slides/github/notion kits (sheets is core, stays)", scopedMail.tools.length === 32 && !scopedMail.tools.some((t) => /^\[(googlecalendar|googleslides|github|notion)\]/.test(t.description)) && scopedMail.tools.some((t) => /^\[googlesheets\]/.test(t.description)));
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
const nyProfile = { ...emptyProfile(), timezone: "America/New_York" };
check("no prior sweep is due", sweepDueForDay(undefined, utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept earlier same UTC day is NOT due", !sweepDueForDay("2026-07-20T06:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
check("swept yesterday IS due", sweepDueForDay("2026-07-19T23:00:00Z", utcProfile, new Date("2026-07-20T08:00:00Z")));
// 2026-07-20T02:00Z is still Jul 19 in New York (22:00 EDT) — a "morning" sweep the next NY day is due.
check("timezone day boundary respected", sweepDueForDay("2026-07-20T02:00:00Z", nyProfile, new Date("2026-07-20T13:00:00Z")));
check("localDay in NY vs UTC differ across midnight", localDay("2026-07-20T02:00:00Z", "America/New_York") === "2026-07-19" && localDay("2026-07-20T02:00:00Z", "UTC") === "2026-07-20");

// ── Daily-minimum "≥1 task/day" force gate (once per local day) ───────────────
section("daily-minimum force gate");
check("never forced before → due", forcedDueToday({ ...utcProfile }, new Date("2026-07-20T08:00:00Z")));
check("forced earlier the SAME local day → NOT due (no double-force)", !forcedDueToday({ ...utcProfile, lastForcedAt: "2026-07-20T06:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
check("forced YESTERDAY → due again today", forcedDueToday({ ...utcProfile, lastForcedAt: "2026-07-19T23:00:00Z" }, new Date("2026-07-20T08:00:00Z")));
// Timezone: 2026-07-20T02:00Z is still Jul 19 in NY, so a force the next NY day is due — the gate is per LOCAL day.
check("force gate respects the user's timezone", forcedDueToday({ ...nyProfile, lastForcedAt: "2026-07-20T02:00:00Z" }, new Date("2026-07-20T13:00:00Z")));

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

// ── Cron catch-all: offline auto-run + stuck-queued recovery ──────────────────
section("cron enqueue + stuck-queued recovery");
const tsk = (over) => ({ ...base, id: over.id, title: over.id, why: "w", source: "manual", status: over.status, ...over });
// A plain ready + never-attempted task is picked up (the normal offline auto-run).
check("ready task enqueued", tasksToEnqueue([tsk({ id: "r1", status: "ready" })], []).map((t) => t.id).join() === "r1");
// A ready task already attempted (autoRan) is NOT re-run by the catch-all.
check("ready+autoRan skipped", tasksToEnqueue([tsk({ id: "r2", status: "ready", autoRan: true })], []).length === 0);
// The core regression: a task stranded at "queued" with NO live job (its job was consumed by a
// pause/over-budget skip or a task-not-found race) gets recovered — nothing else would re-queue it.
check("orphaned queued task recovered", tasksToEnqueue([tsk({ id: "q1", status: "queued" })], []).map((t) => t.id).join() === "q1");
// …but a queued task that STILL has a live job is left alone (no double-run).
check("queued task with live job left alone", tasksToEnqueue([tsk({ id: "q2", status: "queued" })], ["q2"]).length === 0);
// In-flight "executing" is never touched, and handled tasks are never enqueued.
check("executing task not enqueued", tasksToEnqueue([tsk({ id: "x1", status: "executing" })], []).length === 0);
check("done task not enqueued", tasksToEnqueue([tsk({ id: "d9", status: "done" })], []).length === 0);
check("failed_terminal not enqueued (waits for Retry)", tasksToEnqueue([tsk({ id: "f1", status: "failed_terminal" })], []).length === 0);
// Bounded per tick.
check("cron enqueue is bounded", tasksToEnqueue(Array.from({ length: 10 }, (_, i) => tsk({ id: `m${i}`, status: "ready" })), []).length === 3);
// Legacy "running" alias counts as in-flight (canonicalized), not orphaned-queued.
check("legacy running alias not enqueued", tasksToEnqueue([tsk({ id: "lr", status: "running" })], []).length === 0);

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
check("tzOf uses profile.timezone", tzOf({ ...emptyProfile(), timezone: "Europe/Paris" }) === "Europe/Paris");
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

// callCostUsd: cache-hit input priced separately from miss, ×2 during peak. (at = off-peak noon UTC.)
const noon = new Date("2026-07-20T12:00:00Z"), peak = new Date("2026-07-20T02:00:00Z");
check("callCostUsd prices a full miss at the miss rate", Math.abs(callCostUsd(1e6, 0, 0, noon) - USD_PER_1M_IN) < 1e-9);
check("callCostUsd prices a full cache hit at the cheaper rate", Math.abs(callCostUsd(1e6, 0, 1e6, noon) - USD_PER_1M_CACHED_IN) < 1e-9);
check("callCostUsd splits mixed input hit/miss", Math.abs(callCostUsd(1e6, 0, 4e5, noon) - (6e5/1e6*USD_PER_1M_IN + 4e5/1e6*USD_PER_1M_CACHED_IN)) < 1e-9);
check("callCostUsd doubles during peak", Math.abs(callCostUsd(1e6, 1e6, 0, peak) - (USD_PER_1M_IN + USD_PER_1M_OUT) * 2) < 1e-9);
check("callCostUsd clamps cachedIn to total", Math.abs(callCostUsd(1e6, 0, 5e6, noon) - USD_PER_1M_CACHED_IN) < 1e-9);
// addUsage meters the true per-call cost into monthCost, and monthCostUsd prefers it over the token estimate.
const costP = emptyProfile();
addUsage(costP, { in: 1e6, out: 0, cachedIn: 1e6 }, noon); // a fully-cached call is cheap
// (addUsage uses now() for peak; the assertion just checks the cheap-cache path landed in monthCost)
check("addUsage records a metered monthCost", typeof costP.usage.monthCost === "number" && costP.usage.monthCost > 0 && costP.usage.monthCost < USD_PER_1M_IN);
check("monthCostUsd prefers the metered cost", Math.abs(monthCostUsd(costP, "UTC") - costP.usage.monthCost) < 1e-12);

// Interactive reserve: a user-present action is allowed a small band above the cap that background work isn't.
process.env.MONTHLY_AI_BUDGET_USD = "3";
const atCap = { ...emptyProfile(), usage: { in: 0, out: 0, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthCost: 3.05 } }; // just over $3, under $3.30
check("background blocked at the cap", overMonthlyBudget(atCap) === true);
check("interactive still allowed within the reserve", overInteractiveBudget(atCap) === false);
const wayOver = { ...emptyProfile(), usage: { in: 0, out: 0, runs: 1, since: "x", monthKey: monthKeyOf("UTC"), monthCost: 3.5 } };
check("interactive blocked past the reserve", overInteractiveBudget(wayOver) === true);
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

// ── Grades: individual entries, per-subject average, any scale ────────────────
section("gradesBySubject");
{
  const gs = gradesBySubject([
    { id: "1", subject: "Maths", grade: 15, scale: 20, updatedAt: "2026-01-01T00:00:00Z", source: "manual" },
    { id: "2", subject: "Maths", grade: 12, scale: 20, updatedAt: "2026-02-01T00:00:00Z", source: "manual" },
    { id: "3", subject: "Physique — IA", grade: 4, scale: 7, updatedAt: "2026-01-15T00:00:00Z", source: "manual" }, // IB /7 scale
    { id: "4", subject: "physique — ia", grade: 5, scale: 7, updatedAt: "2026-02-15T00:00:00Z", source: "pronote" }, // same subject, case-insensitive group
  ]);
  check("groups by subject case-insensitively", gs.length === 2);
  const maths = gs.find((s) => s.subject === "Maths");
  check("keeps every individual entry for a subject", maths.entries.length === 2);
  check("per-subject average is the mean, not just the latest", Math.abs(maths.avg20 - 13.5) < 0.01);
  const physique = gs.find((s) => /physique/i.test(s.subject));
  check("a /7 scale is normalized to /20 for the average", Math.abs(physique.avg20 - ((4 / 7 + 5 / 7) / 2) * 20) < 0.01);
  check("weakest subject sorts first", gs[0].subject === "Maths" ? maths.avg20 <= physique.avg20 : physique.avg20 <= maths.avg20);
}

// ── Weekly workload balancing (deterministic, no AI) ──────────────────────────
section("workload heuristic");
check("isLowGrade: below 45% is low", isLowGrade(8, 20) === true);
check("isLowGrade: above 45% is not low", isLowGrade(13, 20) === false);
const WL_NOW = new Date("2026-08-05T08:00:00Z"); // a Wednesday
const wlIso = (daysOut) => new Date(WL_NOW.getTime() + daysOut * 86_400_000).toISOString();
const wl1 = computeWorkload({
  homework: [{ id: "h1", subject: "Maths", description: "Exercices 1-10", deadline: wlIso(1), done: false }],
  tests: [
    { id: "t1", subject: "Physique", deadline: wlIso(2) },
    { id: "t2", subject: "Anglais", deadline: wlIso(2) }, // same day → pile-up
  ],
  tasks: [
    { id: "task1", title: "Undated project step", when: "", status: "ready", steps: [{ text: "a", automatable: false }, { text: "b", automatable: false, done: true }] },
  ],
  grades: [{ subject: "Physique", grade: 8, scale: 20, updatedAt: "x" }], // low grade → test effort ×1.5
  now: WL_NOW,
});
check("computeWorkload returns 7 days", wl1.days.length === 7);
check("undated task lands on today", wl1.days[0].items.some((it) => it.kind === "task" && it.taskId === "task1"));
check("undated task is movable", wl1.days[0].items.find((it) => it.taskId === "task1")?.movable === true);
check("undated task effort counts only UNDONE steps", wl1.days[0].items.find((it) => it.taskId === "task1")?.effort === 1);
const testDay = wl1.days.find((d) => d.items.some((it) => it.kind === "test"));
check("both same-day tests land on the same day", testDay?.items.filter((it) => it.kind === "test").length === 2);
check("low-grade subject's test costs more than a normal one", testDay.items.find((it) => it.subject === "Physique").effort === 4.5 && testDay.items.find((it) => it.subject === "Anglais").effort === 3);
check("the 2-test day is flagged as a pile-up", isPileUp(testDay, wl1.days) === true);
const quietDay = wl1.days.find((d) => d.items.length === 0);
check("an empty day is never a pile-up", !quietDay || isPileUp(quietDay, wl1.days) === false);
check("lightestDay excludes the given date and picks the lowest-effort remaining day", lightestDay(wl1.days, testDay.date) !== testDay.date);
const wlOutside = computeWorkload({ homework: [{ id: "h2", subject: "SES", description: "x", deadline: wlIso(20), done: false }], tests: [], tasks: [], now: WL_NOW });
check("items past the 7-day window are dropped", wlOutside.days.every((d) => d.items.length === 0));

// Regression: a task's `when` is often prose ("vendredi", "this week"), not an ISO date — Date.parse
// failing on it must NOT be read as "no deadline". A task that states ANY deadline, parseable or not,
// must never be offered as movable (silently relabeling it away from a real due date would mislead).
const wlProseDeadline = computeWorkload({
  homework: [], tests: [],
  tasks: [{ id: "task2", title: "Rendre le devoir de SES", when: "vendredi", status: "ready", steps: [] }],
  now: WL_NOW,
});
const proseItem = wlProseDeadline.days[0].items.find((it) => it.taskId === "task2");
check("a task with an unparseable-but-real deadline is NOT movable", proseItem?.movable === false);

// Regression: /api/tasks/:id/reschedule ("move to a lighter day") writes a bare "YYYY-MM-DD" — that string
// already unambiguously names a local calendar day and must be used AS the bucket key directly. Re-parsing
// it as an instant (Date.parse → UTC midnight) and re-projecting into a timezone WEST of UTC rolls it back
// to the previous day, so a task "moved to the 8th" landed back on the 7th for e.g. US timezones.
const wlTz = computeWorkload({
  homework: [], tests: [],
  tasks: [{ id: "task3", title: "Moved task", when: "2026-08-08", status: "ready", steps: [] }],
  now: WL_NOW, timezone: "America/Los_Angeles",
});
check("a bare YYYY-MM-DD reschedule date lands on that exact day, not the day before", wlTz.days[3]?.date === "2026-08-08" && wlTz.days[3].items.some((it) => it.taskId === "task3"));
check("...and NOT on the previous day (the timezone round-trip bug)", !wlTz.days[2]?.items.some((it) => it.taskId === "task3"));

// ── Polyvalent prompt vocabulary (no track picker — IB/BFI both always offered) ──
section("trackLine vocabulary");
check("mentions CAS/IA vocabulary regardless of profile", /CAS/.test(trackLine({ track: "ib" })) && /IA/.test(trackLine(undefined)));
check("mentions Grand Oral / BFI vocabulary regardless of profile", /Grand Oral/.test(trackLine({})) && /BFI/.test(trackLine(undefined)));
check("same output no matter what's in the (now-unused) track field", trackLine({ track: "ib" }) === trackLine(undefined) && trackLine({ track: "bac" }) === trackLine({}));

// ── Big project detection + milestone re-plan (no track gate — polyvalent) ────
section("isBigIbProject");
check("EE is a big project regardless of profile", isBigIbProject({ track: "ib" }, "Extended Essay research question", "") && isBigIbProject(undefined, "Extended Essay research question", ""));
check("CAS is a big project regardless of profile", isBigIbProject({ track: "ib" }, "Log CAS hours", "for the CAS reflection") && isBigIbProject({}, "Log CAS hours", "for the CAS reflection"));
check("an ordinary homework is NOT a big project", !isBigIbProject({ track: "ib" }, "Finish the worksheet", "due tomorrow") && !isBigIbProject(undefined, "Finish the worksheet", "due tomorrow"));
// Broadened beyond IB-specific acronyms: a full essay/dissertation/thesis is just as multi-week as an EE,
// even for a non-IB student — this is the fast pre-filter half of the "not only by keywords" fix (the
// other half, letting the model self-classify from actual content, calls the network and isn't testable
// here — see the writeStepsFromContext prompt itself).
check("a full essay is a big project even without IB vocabulary", isBigIbProject(undefined, "Write a full essay on climate policy", ""));
check("a dissertation/thesis/mémoire is a big project", isBigIbProject(undefined, "Finish my dissertation", "") && isBigIbProject(undefined, "Work on my thesis", "") && isBigIbProject(undefined, "Avancer mon mémoire", ""));
check("ordinary homework mentioning neither essay nor acronym is still NOT a big project", !isBigIbProject(undefined, "Finish exercise 4", "due tomorrow"));
// Live bug: a task like "Start the Extended Essay" needs no web research (nothing to look up — the
// student just needs the plan), so writeStepsFromContext's `context` argument comes back empty. The
// milestone rewrite used to bail out on ANY empty context before it ever checked bigProject, silently
// keeping the ordinary dependsOn-chained steps instead of ever generating milestone dates — invisible in
// isBigIbProject's own tests since those never touch the context-gating logic. Source-string pin (no
// network-calling function to unit test directly, and this file is deliberately network-free): a
// big-project task must NOT be short-circuited by an empty context.
{
  const src = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("writeStepsFromContext does not bail on empty context for a big project", /if \(!context\.trim\(\)[^)]*!keywordHit\)/.test(src));
}

section("replanMilestones");
const msNow = new Date("2026-06-15T12:00:00Z");
const msSteps = [
  { text: "Pick research question", automatable: false, done: true, targetDate: "2026-06-01" },
  { text: "Gather sources", automatable: false, targetDate: "2026-06-10" }, // slipped 5 days
  { text: "Write outline", automatable: false, targetDate: "2026-06-20" },
  { text: "Submit", automatable: false, targetDate: "2026-07-01" },
];
const replanned = replanMilestones(msSteps, msNow);
check("replan flags a change when a milestone slipped", replanned.changed === true);
check("a done milestone is left untouched even if its date is in the past", replanned.steps[0].targetDate === "2026-06-01");
check("the slipped milestone snaps to today", replanned.steps[1].targetDate === "2026-06-15");
check("later milestones shift by the same slip amount, preserving spacing", replanned.steps[2].targetDate === "2026-06-26" && replanned.steps[3].targetDate === "2026-07-07");
const noSlip = replanMilestones([{ text: "Submit", automatable: false, targetDate: "2026-07-01" }], msNow);
check("nothing changes when no milestone has slipped", noSlip.changed === false);

// ── Pronote → sourceDetail/Subject/Due plumbing (the "extension of Pronote" root-cause fix) ────────────
section("pronoteToItems carries the real énoncé + subject");
const hwItems = pronoteToItems([{ id: "hw1", subject: "Physique-Chimie", description: "Exercices 12 à 15 p.87 — mécanique du point", deadline: "2026-09-02T08:00:00Z", done: false }]);
check("snippet is the teacher's real words", hwItems[0].snippet === "Exercices 12 à 15 p.87 — mécanique du point");
check("subject carried onto the item", hwItems[0].subject === "Physique-Chimie");
const emptyHw = pronoteToItems([{ id: "hw2", subject: "Anglais", description: "", deadline: "2026-09-02T08:00:00Z", done: false }]);
check("no description falls back to a bare due-date placeholder", /^Due /.test(emptyHw[0].snippet));
const testItems = pronoteTestsToItems([{ id: "t1", subject: "Maths", deadline: "2026-09-03T08:00:00Z" }]);
check("a test's snippet is a bare marker, not a real énoncé", testItems[0].snippet.startsWith("Test on"));

section("hasAssignmentText — real énoncé vs synthesized placeholder");
check("real assignment text passes", hasAssignmentText("Exercices 12 à 15 p.87 — mécanique du point"));
check("the 'Due <date>' fallback is rejected", !hasAssignmentText("Due 2026-09-02T08:00:00Z"));
check("the 'Test on <date>' marker is rejected", !hasAssignmentText("Test on 2026-09-02T08:00:00Z"));
check("too-short text is rejected", !hasAssignmentText("DM"));

section("sourceDetail survives fold/dedupe/merge (the mergeProfileStates-class trap)");
const genWithDetail = [{ title: "Physique — exercices mécanique", why: "Due Wednesday", source: "pronote", risk: "low", urgency: 0.7, importance: 0.6, anchorKey: "pronote:hw1", sourceDetail: "Exercices 12 à 15 p.87 — mécanique du point", sourceSubject: "Physique-Chimie", sourceDue: "2026-09-02T08:00:00Z" }];
const foldedWithDetail = foldGenerated([], genWithDetail);
// This is the field-forgotten-in-a-structural-literal trap the plumbing plan flagged — TypeScript will NOT
// catch it if `candidates.push` in foldGenerated forgets a field that IS listed in its param type.
check("foldGenerated keeps sourceDetail (not silently dropped like `track` was)", foldedWithDetail[0]?.sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("foldGenerated keeps sourceSubject", foldedWithDetail[0]?.sourceSubject === "Physique-Chimie");
const olderNoDetail = { ...foldedWithDetail[0], id: "old", status: "done", sourceDetail: undefined, sourceSubject: undefined };
const dedupedSurvives = dedupeTasks([olderNoDetail, { ...foldedWithDetail[0], id: "fresh" }]);
check("dedupeTasks carries sourceDetail onto the winner even when the higher-ranked copy lacks it", dedupedSurvives.length === 1 && dedupedSurvives[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
const mergedA = { ...foldedWithDetail[0], id: "x", updatedAt: "2026-01-01T00:00:00Z" };
const mergedB = { ...foldedWithDetail[0], id: "x", updatedAt: "2026-01-02T00:00:00Z", sourceDetail: undefined, sourceSubject: undefined };
check("mergeTaskLists carries sourceDetail across devices even when the newer/winning copy lacks it", mergeTaskLists([mergedA], [mergedB])[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("mergeTaskLists carries it regardless of merge direction", mergeTaskLists([mergedB], [mergedA])[0].sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
check("parseGenerated (the agent-sweep fallback path) never invents sourceDetail — no source item to copy it from", parseGenerated([{ title: "Reply to Sarah about budget", why: "Sarah asked Tuesday", source: "web" }])[0].sourceDetail === undefined);

section("mergeTaskLists unions in-app study artifacts across devices (notes/flashcards/quizzes)");
const taskBase = { title: "t", why: "w", source: "pronote", risk: "low", urgency: 0.5, importance: 0.5, quadrant: "do", score: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" };
const deviceA = { ...taskBase, id: "y", updatedAt: "2026-01-01T00:00:00Z", notes: [{ id: "n1", title: "Fiche A", body: "x", createdAt: "2026-01-01T00:00:00Z" }] };
const deviceB = { ...taskBase, id: "y", updatedAt: "2026-01-02T00:00:00Z", notes: [{ id: "n2", title: "Fiche B", body: "y", createdAt: "2026-01-02T00:00:00Z" }] };
const mergedNotes = mergeTaskLists([deviceA], [deviceB])[0].notes;
check("both devices' notes survive the merge", mergedNotes?.length === 2 && mergedNotes.some((n) => n.id === "n1") && mergedNotes.some((n) => n.id === "n2"));
check("unioned artifacts come out chronological (createdAt order), not loser-appended-last", mergedNotes[0].id === "n1" && mergedNotes[1].id === "n2");

section("assignmentBlock — the run/chat prompt's own view of the assignment");
check("empty when there's no real sourceDetail", assignmentBlock({}) === "");
const ab = assignmentBlock({ sourceSubject: "Physique-Chimie", sourceDetail: "Exercices 12 à 15 p.87 — mécanique du point", sourceDue: "2026-09-02T08:00:00Z" });
check("quotes the teacher's real wording", ab.includes("Exercices 12 à 15 p.87 — mécanique du point"));
check("carries the subject", ab.includes("Physique-Chimie"));
check("frames it as never-invent", /never invent/i.test(ab));

// ── Prompt content — pins the academic-research + specificity instructions (house style: trackLine
// vocabulary above is already tested this same way) ───────────────────────────────────────────────────
section("PLAN_ONLY_OVERRIDE — academic research guidance");
check("tells the model to research the NOTION, not just admin logistics", /notion/i.test(PLAN_ONLY_OVERRIDE));
check("explicitly forbids fetching the answer key", /corrigé/i.test(PLAN_ONLY_OVERRIDE));
check("calls out a title-only fiche as a failure", /revoir le cours/i.test(PLAN_ONLY_OVERRIDE));
check("mentions CREATE_QUIZ as one of the write actions", /CREATE_QUIZ/.test(PLAN_ONLY_OVERRIDE));

// ── CREATE_QUIZ / CREATE_NOTE / CREATE_FLASHCARDS validation (makeQuiz/makeNote/makeDeck) ──────────────
section("makeQuiz validation");
const validQuiz = makeQuiz({ title: "Quiz", questions: [
  { q: "2+2?", options: ["3", "4", "5"], correct: 1, why: "basic addition" },
  { q: "Capital of France?", options: ["Lyon", "Paris", "Nice"], correct: 1 },
] });
check("a valid payload produces a quiz", "quiz" in validQuiz && validQuiz.quiz.questions.length === 2);
check("an out-of-range `correct` drops that question", "error" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "b"], correct: 5 }] }));
// The remap-by-identity case: duplicate options collapse, and `correct` must follow the SAME text, not the
// original numeric index (which shifts once a preceding duplicate is dropped) — asserting on the option
// TEXT is what actually catches a broken remap; asserting on the index alone would pass even if it now
// pointed at the wrong answer.
const remapped = makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["la bonne", "fausse", "la bonne", "fausse2"], correct: 0 }] });
check("duplicate options collapse and `correct` still points at the RIGHT TEXT after the shift", "quiz" in remapped && remapped.quiz.questions[0].options[remapped.quiz.questions[0].correct] === "la bonne");
const manyQuestions = Array.from({ length: 20 }, (_, i) => ({ q: `q${i}`, options: ["a", "b"], correct: 0 }));
check("questions capped at 15", makeQuiz({ title: "Q", questions: manyQuestions }).quiz.questions.length === 15);
check("all-invalid questions produce an error, no artifact", "error" in makeQuiz({ title: "Q", questions: [{ q: "", options: [], correct: 0 }] }));
check("a question left with only 1 surviving option (after dedupe) is dropped", "error" in makeQuiz({ title: "Q", questions: [{ q: "x?", options: ["a", "a", "a"], correct: 0 }] }));

section("makeNote / makeDeck validation");
check("an empty/whitespace-only note body is rejected (was silently accepted before this pass)", "error" in makeNote({ title: "x", body: "   " }));
check("a real note body is accepted", "note" in makeNote({ title: "x", body: "a real fiche body with plenty of actual content in it, more than forty chars" }));
check("a deck with at least one valid card is accepted", "deck" in makeDeck({ title: "D", cards: [{ front: "a", back: "b" }] }));
check("a deck with no valid cards is rejected", "error" in makeDeck({ title: "D", cards: [{ front: "", back: "" }] }));

// ── Guardrails: the graded-work detector must catch the real thing without flagging legitimate tutoring
section("CHAT_DOES_WORK / DOES_STUDENT_WORK — true positives without false positives");
check("catches an EN reply that hands over the essay", CHAT_DOES_WORK.test("Here's your essay introduction, ready to submit"));
check("catches a FR reply that hands over the intro", CHAT_DOES_WORK.test("Voici l'introduction :"));
check("does NOT flag legitimate structural help", !CHAT_DOES_WORK.test("Voici comment structurer ton introduction"));
check("DOES_STUDENT_WORK catches an EN claim of having done the homework", DOES_STUDENT_WORK.test("I solved all the problems for you"));
check("DOES_STUDENT_WORK catches a FR claim of having written the dissertation", DOES_STUDENT_WORK.test("J'ai rédigé ta dissertation pour toi"));
check("DOES_STUDENT_WORK catches a FR claim of having finished the homework", DOES_STUDENT_WORK.test("J'ai terminé le devoir de maths"));
check("DOES_STUDENT_WORK does NOT flag preparing a fiche FOR a contrôle", !DOES_STUDENT_WORK.test("Fiche de révision préparée pour le contrôle"));
check("DOES_STUDENT_WORK does NOT flag a plan to help them write", !DOES_STUDENT_WORK.test("Plan pour rédiger ta dissertation"));

section("forceWeekCoverage — everything due this week gets a task, no matter what the classifier decided");
{
  const now = new Date("2026-08-12T08:00:00Z");
  const candidates = [
    { sourceApp: "pronote", anchorKey: "pronote:hw1", snippet: "Exercices 12 à 15 p.87 — mécanique du point", timestamp: "2026-08-14T00:00:00Z", subject: "Physique", labels: ["homework"] },
    { sourceApp: "pronote", anchorKey: "pronote-test:maths:2026-08-15", snippet: "Test on 2026-08-15", timestamp: "2026-08-15T00:00:00Z", subject: "Maths", labels: ["test"] },
    { sourceApp: "pronote", anchorKey: "pronote:hw2", snippet: "Devoir déjà couvert par le classifier", timestamp: "2026-08-13T00:00:00Z", subject: "SES", labels: ["homework"] },
    { sourceApp: "pronote", anchorKey: "pronote:hw3", snippet: "Trop loin dans le temps", timestamp: "2026-09-01T00:00:00Z", subject: "Anglais", labels: ["homework"] },
    { sourceApp: "gmail", anchorKey: "gmail:xyz", snippet: "not pronote at all", timestamp: "2026-08-13T00:00:00Z", subject: undefined, labels: [] },
  ];
  const out = forceWeekCoverage(candidates, ["pronote:hw2"], { now });
  check("covers homework the classifier skipped", out.some((t) => t.anchorKey === "pronote:hw1"));
  check("covers a test the classifier skipped", out.some((t) => t.anchorKey === "pronote-test:maths:2026-08-15"));
  check("does NOT duplicate an anchor already covered", !out.some((t) => t.anchorKey === "pronote:hw2"));
  check("skips anything outside the 7-day window", !out.some((t) => t.anchorKey === "pronote:hw3"));
  check("skips non-Pronote sources entirely", !out.some((t) => t.anchorKey === "gmail:xyz"));
  check("carries the real énoncé as sourceDetail, verbatim", out.find((t) => t.anchorKey === "pronote:hw1")?.sourceDetail === "Exercices 12 à 15 p.87 — mécanique du point");
  check("a bare test marker (no real énoncé) leaves sourceDetail undefined", out.find((t) => t.anchorKey === "pronote-test:maths:2026-08-15")?.sourceDetail === undefined);
  check("every forced task clears applyQualityBar's own floor", out.every((t) => t.urgency >= 0.35 || t.importance >= 0.35));
}

// The client is split across App.tsx / TaskCard.tsx / ui.tsx, which import each other. An ES-module import
// CYCLE doesn't fail `tsc` or `vite build` — it resolves to `undefined` at runtime and the app renders a
// blank screen. There are no DOM/render tests in this suite, so this is the one automated guard for it:
// import the client modules for real and assert every component actually came through as a function.
section("client module graph — no import cycle leaves a component undefined");
let uiModule;
for (const [mod, names] of [
  ["../client/ui.tsx", ["FlashcardDeck", "QuizPlayer", "TaskModal", "renderNoteBody", "renderChatText", "statusChip"]],
  ["../client/TaskCard.tsx", ["TaskCardRow", "TaskFocus"]],
]) {
  const m = await import(mod);
  if (mod.endsWith("ui.tsx")) uiModule = m;
  for (const n of names) check(`${mod.replace("../client/", "")} exports ${n} as a function`, typeof m[n] === "function");
}

// A note's markdown body can contain a GFM pipe table (a schedule, a comparison) — the hand-rolled
// renderNoteBody parser (no full markdown library) must actually turn "| a | b |\n|---|---|\n| 1 | 2 |"
// into a <table>, not dump raw pipe characters as plain paragraphs. Render it for real via
// react-dom/server rather than just introspecting the element tree — this is the one place in the suite
// that can assert actual HTML output, since react-dom is already a real dependency.
section("renderNoteBody — GFM pipe table support");
{
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const table = "| Étape | Durée |\n|---|---|\n| Module 1 | 32 min |\n| Module 2 | 32 min |";
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, uiModule.renderNoteBody(table)));
  check("renders a <table>", /<table/.test(html));
  check("renders the header cells", /<th[^>]*>Étape<\/th>/.test(html) && /<th[^>]*>Durée<\/th>/.test(html));
  check("renders every data row", /Module 1/.test(html) && /Module 2/.test(html) && /32 min/.test(html));
  check("does not leak raw pipe characters into the output", !html.includes("|"));
  // Non-table content must still render exactly as before — a heading, list, and paragraph, no stray table.
  const plain = renderToStaticMarkup(React.createElement(React.Fragment, null, uiModule.renderNoteBody("# Titre\n- un\n- deux\n\nTexte.")));
  check("plain markdown (no pipes) renders no table", !plain.includes("<table"));
  check("plain markdown still renders the heading/list/paragraph", /<h3/.test(plain) && /<ul/.test(plain) && /Texte\./.test(plain));
}
// Source-order pin, not a real interaction test (no DOM test runner exists — see the module-graph check
// above for why). .card-main is the task row's real "open this task" control. An earlier version used a
// separate invisible `.card-open` overlay sibling instead — textbook-correct by every CSS stacking rule,
// but taps on it silently failed to register on live mobile testing (multiple browsers, no JS error, no
// plausible cause found after two independent targeted fixes shipped and confirmed live with zero effect).
// Replaced with the simpler, standard pattern: the visible content itself IS the button. Pin that a future
// edit doesn't quietly reintroduce the invisible-overlay pattern this bug came from.
{
  const src = readFileSync(new URL("../client/TaskCard.tsx", import.meta.url), "utf8");
  check("TaskCardRow does not reintroduce the invisible .card-open overlay pattern", !src.includes('"card-open"'));
  check("TaskCardRow's .card-main is a real <button>, not a styled <div>", /<button[^>]*className="card-main"/.test(src));
}
// The ACTUAL live-confirmed root cause of "tapping a task marks it done instead of opening it": any element
// using the `::after { position: absolute; inset: -Npx }` hit-expander pattern MUST itself have
// `position: relative`, or the ::after positions relative to the nearest positioned ANCESTOR instead (here,
// `.card`) — silently blowing the invisible hit-expander up to cover almost the entire row instead of just
// the small control it belongs to. This exact regression (removing `.card-check`'s `position: relative` as
// apparently-dead code during an unrelated cleanup) shipped and was live for multiple rounds before being
// found. Pin the coupling directly: every selector with this ::after pattern must also declare position:
// relative somewhere in the file.
{
  const css = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");
  const hitExpanders = [...css.matchAll(/([.\w-]+)::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*-\d/g)].map((m) => m[1]);
  check("found the known ::after hit-expanders to check (styles.css structure changed?)", hitExpanders.length >= 3);
  for (const sel of hitExpanders) {
    const re = new RegExp(`(^|[,\\s}])${sel.replace(".", "\\.")}\\s*\\{[^}]*position:\\s*relative`, "m");
    check(`${sel} (has an ::after hit-expander) also declares position: relative`, re.test(css));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
