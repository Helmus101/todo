// Open Otto's tabs and collect them ALL into ONE named tab group. Calls are SERIALIZED (a promise chain) and
// the group id is REMEMBERED, so a burst of "open" messages can't each spawn their own "Otto" group (the
// "5 Otto groups" bug) — every tab lands in the single shared group, reused across steps and refreshes.
let opChain = Promise.resolve();
let knownGroupId = null;

function openInGroup(urls, groupTitle) {
  opChain = opChain.then(() => doOpenInGroup(urls, groupTitle)).catch(() => {});
  return opChain;
}

async function doOpenInGroup(urls, groupTitle) {
  const tabIds = [];
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;
    const tab = await chrome.tabs.create({ url, active: false });
    tabIds.push(tab.id);
  }
  if (!tabIds.length) return;

  let groupId = null;
  if (groupTitle) {
    // 1) reuse the group we already made (if it still exists)…
    if (knownGroupId != null) {
      try { await chrome.tabGroups.get(knownGroupId); groupId = knownGroupId; }
      catch { knownGroupId = null; }
    }
    // 2) …else find an existing group with this title in ANY window (survives a service-worker restart)…
    if (groupId == null) {
      try {
        const existing = await chrome.tabGroups.query({ title: groupTitle });
        if (existing.length) groupId = existing[0].id;
      } catch { /* tabGroups unavailable */ }
    }
  }
  try {
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds });
    } else {
      groupId = await chrome.tabs.group({ tabIds });
      if (groupTitle) await chrome.tabGroups.update(groupId, { title: String(groupTitle).slice(0, 40), color: "blue" });
    }
    if (groupTitle) knownGroupId = groupId; // remember → the next open reuses this exact group
  } catch { /* grouping failed (older Chrome) — tabs still open, just ungrouped */ }
}

// ── Study Mode site blocking ───────────────────────────────────────────────────────────
// While a session is active, every navigation NOT to an allowed origin (the Otto app itself, plus a small
// fixed allowlist for things a student legitimately needs mid-session — Google auth, since Otto's own sign-
// in/reconnect flows redirect through accounts.google.com) redirects to blocked.html instead. Persisted in
// chrome.storage.local (not just an in-memory flag) so the block survives a service-worker restart — Chrome
// can kill and respawn this worker at any time on Manifest V3, and losing the block state on a respawn would
// silently un-block everything mid-session with no user action at all, defeating the entire point of "you
// must deliberately end the session to unblock."
const RULE_ID = 1; // single dynamic rule — always replaced wholesale, never accumulated
const ALWAYS_ALLOWED_HOSTS = [
  "accounts.google.com", // Google sign-in — needed for Otto's own auth/reconnect flows
  "chrome.google.com",   // the extension's own store page / chrome:// surfaces some flows touch
];

async function applyBlockRule(allowedOrigin) {
  let allowedHost;
  try { allowedHost = new URL(allowedOrigin).hostname; } catch { return; }
  const allowedHosts = [allowedHost, ...ALWAYS_ALLOWED_HOSTS];
  // requestDomains would ALSO need excludedRequestDomains kept in sync forever as ALWAYS_ALLOWED_HOSTS
  // grows — a urlFilter regex expressing "anything NOT these hosts" is simpler to keep correct: one
  // negative-lookahead pattern, no second list to maintain.
  const excludePattern = allowedHosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: {
        // Match any http(s) URL whose host is NOT in the allowlist. resourceTypes scoped to main_frame only
        // — blocking sub-resources (images, XHR, fonts a legitimately-open site needs) would just break
        // pages randomly instead of cleanly redirecting the TAB itself.
        regexFilter: `^https?://(?!(${excludePattern}))`,
        resourceTypes: ["main_frame"],
      },
    }],
  });
}

async function clearBlockRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
}

async function startStudyBlocking(originUrl) {
  await chrome.storage.local.set({ studyModeActive: true, studyModeOrigin: originUrl });
  await applyBlockRule(originUrl);
}

async function stopStudyBlocking() {
  await chrome.storage.local.set({ studyModeActive: false });
  await clearBlockRule();
}

// Re-apply blocking on every service-worker wake if a session was left active — covers the worker-restart
// case described above (Chrome can respawn this file at any time; the dynamic rule does NOT survive that on
// its own, only what's re-applied here from persisted storage does).
chrome.runtime.onStartup?.addListener(async () => {
  const { studyModeActive, studyModeOrigin } = await chrome.storage.local.get(["studyModeActive", "studyModeOrigin"]);
  if (studyModeActive && studyModeOrigin) await applyBlockRule(studyModeOrigin);
});
(async () => {
  const { studyModeActive, studyModeOrigin } = await chrome.storage.local.get(["studyModeActive", "studyModeOrigin"]);
  if (studyModeActive && studyModeOrigin) await applyBlockRule(studyModeOrigin);
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "open-tab" && typeof msg.url === "string") openInGroup([msg.url], msg.group);
  else if (msg.type === "open-tabs" && Array.isArray(msg.urls)) openInGroup(msg.urls, msg.group);
  else if (msg.type === "study-mode-start" && typeof msg.origin === "string") void startStudyBlocking(msg.origin);
  else if (msg.type === "study-mode-end") void stopStudyBlocking();
});
