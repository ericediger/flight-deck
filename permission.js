/* Requests mic permission from a full tab — the grant applies to the whole
   extension origin, which unblocks getUserMedia in the side panel. */

"use strict";

const statusEl = document.getElementById("status");
const blockedHelp = document.getElementById("blockedHelp");
const retryBtn = document.getElementById("retryBtn");
const settingsBtn = document.getElementById("settingsBtn");

async function requestMic() {
  statusEl.textContent = "Requesting microphone access…";
  statusEl.className = "";
  blockedHelp.classList.add("hidden");
  retryBtn.classList.add("hidden");
  settingsBtn.classList.add("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    statusEl.textContent = "✓ Microphone enabled. Close this tab and use the mic in the side panel.";
    statusEl.className = "ok";
  } catch (err) {
    statusEl.textContent = "✗ Microphone access is blocked.";
    statusEl.className = "blocked";
    blockedHelp.classList.remove("hidden");
    retryBtn.classList.remove("hidden");
    settingsBtn.classList.remove("hidden");
  }
}

retryBtn.addEventListener("click", requestMic);
settingsBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: "chrome://settings/content/siteDetails?site=" + encodeURIComponent(location.origin),
  });
});

requestMic();
