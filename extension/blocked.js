// Fills in the "Back to Otto" link from the allowed origin the background worker stored when Study Mode
// started — inline scripts aren't allowed under Manifest V3's CSP, so this is a separate file instead of a
// <script> tag in blocked.html.
chrome.storage.local.get(["studyModeOrigin"], (data) => {
  const el = document.getElementById("back");
  if (el && data.studyModeOrigin) el.href = data.studyModeOrigin;
});
