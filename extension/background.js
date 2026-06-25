// Open Weave's tabs and collect them into a NAMED tab group (one group per task). Reuses an existing
// group with the same title in that window, so a task's pages — opened one step at a time — stay together.
async function openInGroup(urls, groupTitle) {
  const tabIds = [];
  let windowId;
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;
    const tab = await chrome.tabs.create({ url, active: false });
    tabIds.push(tab.id);
    windowId = tab.windowId;
  }
  if (!tabIds.length) return;

  let groupId;
  if (groupTitle) {
    try {
      const existing = await chrome.tabGroups.query({ title: groupTitle, windowId });
      if (existing.length) groupId = existing[0].id;
    } catch { /* tabGroups may be unavailable; fall through to a fresh group */ }
  }
  try {
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds });
    } else {
      const gid = await chrome.tabs.group({ tabIds });
      if (groupTitle) await chrome.tabGroups.update(gid, { title: String(groupTitle).slice(0, 40), color: "blue" });
    }
  } catch { /* grouping failed (e.g. older Chrome) — the tabs are still open, just ungrouped */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "open-tab" && typeof msg.url === "string") openInGroup([msg.url], msg.group);
  else if (msg.type === "open-tabs" && Array.isArray(msg.urls)) openInGroup(msg.urls, msg.group);
});
