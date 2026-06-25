const input = document.getElementById("url");
const status = document.getElementById("status");
const go = document.getElementById("go");

function open() {
  let u = input.value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  chrome.runtime.sendMessage({ type: "open-tab", url: u, group: "Weave" });
  status.textContent = "Opened in the Weave group ↗";
  input.value = "";
  input.focus();
}

go.addEventListener("click", open);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
input.focus();
