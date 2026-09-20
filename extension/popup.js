// The popup renders when the extension is installed and enabled (its own existence proves that), so it
// doesn't need to check "is the extension present" — it DOES need to show whether Study Mode blocking is
// ACTUALLY active right now, since that's the thing a student debugging "sites aren't being blocked" needs
// to see without opening chrome://extensions' service-worker console. Asks background.js for real state
// (including whether the declarativeNetRequest rule genuinely installed, not just whether a session was
// started) rather than guessing from anything the popup could read itself.

const statusBox = document.getElementById("statusBox");
const statusLabel = document.getElementById("status");
const hint = document.getElementById("hint");
const allowInput = document.getElementById("allowInput");
const allowAdd = document.getElementById("allowAdd");
const allowListEl = document.getElementById("allowList");
const unblockRow = document.getElementById("unblockRow");
const unblockBtn = document.getElementById("unblockBtn");

// Direct escape hatch — sends the SAME "study-mode-end" message the web app's own deliberate long-press
// End button sends (extensionBridge.ts's stopStudyBlocking, relayed by content.js), just triggered from
// here instead. Explicitly requested: the app-side flow requires holding a button in the app itself, which
// doesn't help if the app tab is closed, the student is on a different device, or something's gone wrong
// with the connection between the two — this works regardless, straight from the extension.
unblockBtn.addEventListener("click", () => {
  if (!confirm("Stop blocking sites for this Study Mode session?")) return;
  chrome.runtime.sendMessage({ type: "study-mode-end" }, () => {
    unblockRow.hidden = true;
    statusBox.classList.remove("blocking");
    statusLabel.textContent = "Active";
    hint.textContent = "Blocking stopped. Otto opens drafts, docs and pages for you — grouped into one \"Otto\" tab group, so it can work while you're away.";
  });
});

let currentAllowlist = [];

function renderAllowlist() {
  allowListEl.innerHTML = "";
  if (!currentAllowlist.length) {
    const p = document.createElement("p");
    p.className = "allow-empty";
    p.textContent = "None yet.";
    allowListEl.appendChild(p);
    return;
  }
  for (const host of currentAllowlist) {
    const row = document.createElement("div");
    row.className = "allow-item";
    const span = document.createElement("span");
    span.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.setAttribute("aria-label", `Remove ${host}`);
    btn.onclick = () => saveAllowlist(currentAllowlist.filter((h) => h !== host));
    row.appendChild(span);
    row.appendChild(btn);
    allowListEl.appendChild(row);
  }
}

function saveAllowlist(hosts) {
  chrome.runtime.sendMessage({ type: "update-allowlist", hosts }, (res) => {
    currentAllowlist = res?.customAllowlist || hosts;
    renderAllowlist();
  });
}

// Accepts a bare domain or a pasted URL — strips scheme/path/query down to just the hostname, since
// that's the only shape declarativeNetRequest's excludedRequestDomains actually matches against.
function normalizeHost(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try { return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase(); }
  catch { return ""; }
}

allowAdd.addEventListener("click", () => {
  const host = normalizeHost(allowInput.value);
  if (!host || currentAllowlist.includes(host)) { allowInput.value = ""; return; }
  allowInput.value = "";
  saveAllowlist([...currentAllowlist, host]);
});
allowInput.addEventListener("keydown", (e) => { if (e.key === "Enter") allowAdd.click(); });

chrome.runtime.sendMessage({ type: "get-status" }, (res) => {
  if (!res) return; // background.js unreachable — leave the default "Active" (installed) state showing
  currentAllowlist = res.customAllowlist || [];
  renderAllowlist();
  // Shown whenever a session is active at all — including the "didn't start" failure state below, since
  // studyModeActive can still be true (stuck) there even with no rule actually installed, and clearing it
  // from here is exactly the recovery path for that case too.
  unblockRow.hidden = !res.studyModeActive;
  if (res.studyModeActive && res.ruleActuallyInstalled) {
    statusBox.classList.add("blocking");
    statusLabel.textContent = "Blocking other sites";
    hint.textContent = "Study Mode is active — other sites redirect to a reminder page until the session ends.";
  } else if (res.studyModeActive && !res.ruleActuallyInstalled) {
    // A real, diagnosable failure state: a session says it's active but the actual browser-level rule
    // never installed (or was lost) — this is exactly the "nothing is being blocked" symptom, now visible
    // instead of silent.
    statusLabel.textContent = "Blocking didn't start";
    hint.textContent = "Study Mode says it's active, but the block rule isn't installed. Try ending and restarting the session, or reload this extension at chrome://extensions.";
  } else {
    statusLabel.textContent = "Active";
    hint.textContent = "Otto opens drafts, docs and pages for you — grouped into one \"Otto\" tab group, so it can work while you're away.";
  }
});
