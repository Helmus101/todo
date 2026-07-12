// Repo test suite — run with `npm test` (tsx). Pure-function tests: no network, no AI calls.
import { dedupeTasks, foldGenerated, applyProfileUpdate, mergeTaskLists, mergeProfileStates, applyQualityBar } from "../server/tasks.ts";
import { parseGenerated } from "../server/claude.ts";
import { isWriteGatedAction, ACTION_POLICIES } from "../server/integrations.ts";
import { isNoise, filterCandidates } from "../server/discover.ts";
import { dedupeFacts, emptyProfile, canonStatus, isHandled, isInFlight } from "../shared/types.ts";

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

// ── Policy registry ───────────────────────────────────────────────────────────
section("action policy registry");
check("send email is never-allowed", ACTION_POLICIES.GMAIL_SEND_EMAIL === "never");
check("draft is auto-allowed", ACTION_POLICIES.GMAIL_CREATE_EMAIL_DRAFT === "auto");
check("calendar create needs approval", isWriteGatedAction("GOOGLECALENDAR_CREATE_EVENT") === true);
check("gmail read needs no approval", isWriteGatedAction("GMAIL_FETCH_EMAILS") === false);
check("doc edit needs approval", isWriteGatedAction("GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT") === true);
check("unlisted destructive action falls back to regex", isWriteGatedAction("GOOGLESLIDES_BATCH_UPDATE_PRESENTATION") === true);
check("sheet cell write is auto", isWriteGatedAction("GOOGLESHEETS_UPDATE_VALUES") === false);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
