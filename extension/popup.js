const statusEl = document.getElementById("status");

// "Connected" = the extension is installed and active (you're seeing this popup). If an Otto tab is open, say so.
chrome.tabs.query({ url: ["http://localhost:5273/*", "http://127.0.0.1:5273/*"] }, (tabs) => {
  if (chrome.runtime.lastError) return;
  if (tabs && tabs.length) statusEl.textContent = "Connected to Otto";
});
