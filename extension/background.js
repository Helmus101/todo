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

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "open-tab" && typeof msg.url === "string") openInGroup([msg.url], msg.group);
  else if (msg.type === "open-tabs" && Array.isArray(msg.urls)) openInGroup(msg.urls, msg.group);
});
