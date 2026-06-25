// Runs on the Weave web app. Tells the page the extension is present (a DOM flag the page reads — content
// scripts can't touch the page's window), and relays the page's open-tab requests to the background.
document.documentElement.setAttribute("data-weave-ext", "1");

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data) return;
  const d = e.data;
  const group = d.group ? String(d.group) : undefined;
  try {
    if (d.type === "weave-open-tab" && d.url) chrome.runtime.sendMessage({ type: "open-tab", url: String(d.url), group });
    else if (d.type === "weave-open-tabs" && Array.isArray(d.urls)) chrome.runtime.sendMessage({ type: "open-tabs", urls: d.urls.map(String), group });
  } catch { /* ignore */ }
});
