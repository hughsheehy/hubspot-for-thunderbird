/**
 * popup/panel.js
 *
 * Runs inside the message_display_action popup. Never touches the HubSpot
 * API directly — everything goes through background.js via runtime.sendMessage.
 */

"use strict";

const states = [
  "state-loading",
  "state-no-message",
  "state-not-configured",
  "state-never-log",
  "state-error",
  "state-not-found",
  "state-found"
];

let currentTabId = null;
let currentEmail = null;
let currentName = null;

function showState(id) {
  for (const s of states) {
    document.getElementById(s).hidden = s !== id;
  }
}

async function getActiveTabId() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function load() {
  showState("state-loading");

  try {
    currentTabId = await getActiveTabId();
    if (currentTabId === null) {
      showState("state-no-message");
      return;
    }

    const result = await browser.runtime.sendMessage({
      type: "lookupForDisplayedMessage",
      tabId: currentTabId
    });

    render(result);
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  document.getElementById("error-message").textContent =
    err && err.message ? err.message : i18n("panel_error_generic");
  showState("state-error");
}

function render(result) {
  switch (result.status) {
    case "not_configured":
      showState("state-not-configured");
      break;

    case "no_message":
      showState("state-no-message");
      break;

    case "never_log":
      showState("state-never-log");
      break;

    case "error":
      document.getElementById("error-message").textContent =
        result.error || i18n("panel_error_generic");
      showState("state-error");
      break;

    case "not_found":
      currentEmail = result.email;
      currentName = result.name;
      document.getElementById("not-found-message").textContent = i18n("panel_no_match_body", [
        result.email
      ]);
      document.getElementById("create-contact-status").textContent = "";
      document.getElementById("create-contact-btn").disabled = false;
      showState("state-not-found");
      break;

    case "found":
      renderFound(result);
      showState("state-found");
      break;

    default:
      document.getElementById("error-message").textContent = i18n("panel_error_generic");
      showState("state-error");
  }
}

function renderFound(result) {
  const { contact, owner, deals, portalId, currencyCode, youSent } = result;
  const props = contact.properties || {};

  document.getElementById("you-sent-note").hidden = !youSent;

  const fullName = [props.firstname, props.lastname].filter(Boolean).join(" ") || props.email;
  document.getElementById("contact-name").textContent = fullName;

  const openLink = document.getElementById("open-in-hubspot");
  if (portalId) {
    openLink.href = `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contact.id}`;
    openLink.hidden = false;
  } else {
    openLink.hidden = true;
  }

  renderContactFieldsInto(document.getElementById("contact-fields"), props, ownerDisplayLabel(owner));
  renderDealsListInto(document.getElementById("deals-list"), deals, currencyCode);
  renderActivityListInto(document.getElementById("activity-list"), result.activities || []);

  const logButton = document.getElementById("log-button");
  logButton.disabled = false;
  document.getElementById("log-status").textContent = "";
  logButton.dataset.contactId = contact.id;
}

// activityIcon/activityTitle/activityMeta/renderActivityListInto,
// renderDealsListInto, renderContactFieldsInto, and ownerDisplayLabel are
// shared with compose.js and live in popup/common.js.

async function handleCreateContact() {
  const btn = document.getElementById("create-contact-btn");
  const status = document.getElementById("create-contact-status");
  btn.disabled = true;
  status.classList.remove("error");
  status.textContent = i18n("panel_creating_contact");

  const nameParts = (currentName || "").split(" ").filter(Boolean);
  const properties = {};
  if (nameParts.length) {
    properties.firstname = nameParts[0];
    if (nameParts.length > 1) properties.lastname = nameParts.slice(1).join(" ");
  }

  try {
    const result = await browser.runtime.sendMessage({
      type: "createContact",
      email: currentEmail,
      properties
    });

    if (result.status === "created") {
      await load(); // re-run the lookup so it now renders as "found"
      return;
    }
    status.classList.add("error");
    status.textContent = result.error || i18n("panel_create_contact_error");
  } catch (err) {
    status.classList.add("error");
    status.textContent = err && err.message ? err.message : i18n("panel_create_contact_error");
  } finally {
    btn.disabled = false;
  }
}

async function handleLogMessage() {
  const btn = document.getElementById("log-button");
  const status = document.getElementById("log-status");
  btn.disabled = true;
  status.classList.remove("error");
  status.textContent = i18n("panel_logging");

  try {
    const result = await browser.runtime.sendMessage({
      type: "logDisplayedMessage",
      tabId: currentTabId
    });

    if (result.status === "logged") {
      status.textContent = i18n("panel_log_success");
    } else if (result.status === "never_log") {
      status.classList.add("error");
      status.textContent = i18n("panel_log_never_log_blocked", [result.email]);
    } else {
      status.classList.add("error");
      status.textContent = result.error || i18n("panel_log_error");
    }
  } catch (err) {
    status.classList.add("error");
    status.textContent = err && err.message ? err.message : i18n("panel_log_error");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyI18n(document);
  document.getElementById("open-settings-btn").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
  });
  document.getElementById("create-contact-btn").addEventListener("click", handleCreateContact);
  document.getElementById("log-button").addEventListener("click", handleLogMessage);
  load();
});
