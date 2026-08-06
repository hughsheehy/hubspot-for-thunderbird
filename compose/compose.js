/**
 * compose/compose.js
 *
 * Runs inside the compose_action popup. Shows which recipients already
 * exist in HubSpot and offers to add the logging BCC address.
 */

"use strict";

let currentTabId = null;
// email -> details response, so re-expanding a row doesn't refetch.
const recipientDetailsCache = new Map();

function showState(id) {
  for (const s of ["state-loading", "state-not-configured", "state-error", "state-ready"]) {
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
      showError();
      return;
    }

    const result = await browser.runtime.sendMessage({
      type: "lookupComposeRecipients",
      tabId: currentTabId
    });

    if (result.status === "not_configured") {
      showState("state-not-configured");
      return;
    }
    if (result.status === "error") {
      showError(result.error);
      return;
    }

    renderRecipients(result.recipients || []);
    const addBccBtn = document.getElementById("add-bcc-btn");
    addBccBtn.disabled = !result.bccAddress || !!result.loggingBlockedBy;
    document.getElementById("bcc-status").textContent = result.loggingBlockedBy
      ? i18n("compose_bcc_never_log_blocked", [result.loggingBlockedBy])
      : result.bccAddress
        ? ""
        : i18n("compose_no_bcc_configured");

    showState("state-ready");
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  document.getElementById("error-message").textContent =
    typeof err === "string"
      ? err
      : err && err.message
        ? err.message
        : i18n("panel_error_generic");
  showState("state-error");
}

function renderRecipients(recipients) {
  const list = document.getElementById("recipients-list");
  list.innerHTML = "";
  document.getElementById("no-recipients").hidden = recipients.length > 0;

  for (const r of recipients) {
    const wrapper = document.createElement("div");
    wrapper.className = "recipient-wrapper";

    const row = document.createElement("div");
    row.className = "recipient-row";

    const addr = document.createElement("div");
    addr.className = "recipient-address";
    const nameLine = document.createElement("div");
    nameLine.className = "recipient-name";
    nameLine.textContent = r.name && r.name !== r.email ? r.name : r.email;
    const emailLine = document.createElement("div");
    emailLine.className = "recipient-email";
    emailLine.textContent = r.email;
    addr.appendChild(nameLine);
    addr.appendChild(emailLine);

    const right = document.createElement("div");
    right.className = "recipient-right";

    const badge = document.createElement("span");
    badge.className = `badge badge-${r.state}`;
    badge.textContent = i18n(badgeKey(r.state));
    right.appendChild(badge);

    row.appendChild(addr);

    if (r.state === "found") {
      const chevron = document.createElement("span");
      chevron.className = "expand-chevron";
      chevron.textContent = "▸";
      right.appendChild(chevron);
      row.classList.add("expandable");
      row.addEventListener("click", () => toggleRecipientDetails(wrapper, chevron, r.email));
    } else if (r.state === "not_found") {
      const createBtn = document.createElement("button");
      createBtn.type = "button";
      createBtn.className = "link-button recipient-create-btn";
      createBtn.textContent = i18n("compose_create_contact_button");
      createBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        handleCreateRecipientContact(createBtn, wrapper, r);
      });
      right.appendChild(createBtn);
    }

    row.appendChild(right);
    wrapper.appendChild(row);
    list.appendChild(wrapper);
  }
}

async function handleCreateRecipientContact(button, wrapper, recipient) {
  button.disabled = true;
  button.textContent = i18n("compose_creating_contact");

  const displayName = recipient.name && recipient.name !== recipient.email ? recipient.name : "";
  const nameParts = displayName.split(" ").filter(Boolean);
  const properties = {};
  if (nameParts.length) {
    properties.firstname = nameParts[0];
    if (nameParts.length > 1) properties.lastname = nameParts.slice(1).join(" ");
  }

  try {
    const result = await browser.runtime.sendMessage({
      type: "createContact",
      email: recipient.email,
      properties
    });

    if (result.status === "created") {
      recipientDetailsCache.delete(recipient.email);
      await load(); // re-run the lookup so the row now renders as "found"
      return;
    }
    showRecipientCreateError(wrapper, result.error || i18n("panel_create_contact_error"));
  } catch (err) {
    showRecipientCreateError(wrapper, err && err.message ? err.message : i18n("panel_create_contact_error"));
  } finally {
    button.disabled = false;
    button.textContent = i18n("compose_create_contact_button");
  }
}

function showRecipientCreateError(wrapper, message) {
  let status = wrapper.querySelector(".recipient-create-status");
  if (!status) {
    status = document.createElement("p");
    status.className = "status-line error recipient-create-status";
    wrapper.appendChild(status);
  }
  status.textContent = message;
}

async function toggleRecipientDetails(wrapper, chevron, email) {
  const existing = wrapper.querySelector(".recipient-details");
  if (existing) {
    const wasHidden = existing.hidden;
    existing.hidden = !wasHidden;
    chevron.textContent = wasHidden ? "▾" : "▸";
    return;
  }

  chevron.textContent = "▾";
  const details = document.createElement("div");
  details.className = "recipient-details";
  const loading = document.createElement("p");
  loading.className = "status-line";
  loading.textContent = i18n("compose_loading_details");
  details.appendChild(loading);
  wrapper.appendChild(details);

  let result = recipientDetailsCache.get(email);
  try {
    if (!result) {
      result = await browser.runtime.sendMessage({ type: "getComposeRecipientDetails", email });
      recipientDetailsCache.set(email, result);
    }
  } catch (err) {
    result = {
      status: "error",
      error: err && err.message ? err.message : i18n("panel_error_generic")
    };
  }

  details.innerHTML = "";
  renderRecipientDetails(details, result);
}

function renderRecipientDetails(container, result) {
  if (result.status !== "found") {
    const p = document.createElement("p");
    p.className = result.status === "error" ? "status-line error" : "status-line";
    p.textContent =
      result.status === "error" ? result.error || i18n("panel_error_generic") : i18n("compose_details_unavailable");
    container.appendChild(p);
    return;
  }

  const { contact, owner, company, deals, activities, portalId, currencyCode } = result;
  const props = contact.properties || {};

  const card = document.createElement("div");
  card.className = "contact-card";

  const header = document.createElement("div");
  header.className = "contact-header";
  const nameEl = document.createElement("div");
  nameEl.className = "contact-name";
  nameEl.textContent = [props.firstname, props.lastname].filter(Boolean).join(" ") || props.email;
  header.appendChild(nameEl);
  if (portalId) {
    const link = document.createElement("a");
    link.className = "pill-link";
    link.target = "_blank";
    link.rel = "noopener";
    link.href = `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contact.id}`;
    link.textContent = i18n("panel_open_in_hubspot");
    header.appendChild(link);
  }
  card.appendChild(header);

  const dl = document.createElement("dl");
  dl.className = "contact-fields";
  renderContactFieldsInto(dl, props, ownerDisplayLabel(owner), companyDisplayLabel(company));
  card.appendChild(dl);
  container.appendChild(card);

  const dealsSection = document.createElement("div");
  dealsSection.className = "deals-section";
  const dealsHeading = document.createElement("h4");
  dealsHeading.textContent = i18n("panel_deals_heading");
  const dealsList = document.createElement("div");
  renderDealsListInto(dealsList, deals, currencyCode);
  dealsSection.append(dealsHeading, dealsList);
  container.appendChild(dealsSection);

  const activitySection = document.createElement("div");
  activitySection.className = "activity-section";
  const activityHeading = document.createElement("h4");
  activityHeading.textContent = i18n("panel_history_heading");
  const activityList = document.createElement("div");
  renderActivityListInto(activityList, activities);
  activitySection.append(activityHeading, activityList);
  container.appendChild(activitySection);
}

function badgeKey(state) {
  switch (state) {
    case "found":
      return "compose_recipient_in_hubspot";
    case "never_log":
      return "compose_recipient_never_log";
    case "logging_bcc":
      return "compose_recipient_logging_bcc";
    case "error":
      return "compose_recipient_error";
    case "not_found":
    default:
      return "compose_recipient_not_in_hubspot";
  }
}

async function handleAddBcc() {
  const btn = document.getElementById("add-bcc-btn");
  const status = document.getElementById("bcc-status");
  let keepDisabled = false;
  btn.disabled = true;

  try {
    const result = await browser.runtime.sendMessage({
      type: "addLoggingBcc",
      tabId: currentTabId
    });

    switch (result.status) {
      case "added":
        status.classList.remove("error");
        status.textContent = i18n("compose_bcc_added");
        break;
      case "already_present":
        status.classList.remove("error");
        status.textContent = i18n("compose_bcc_already_present");
        break;
      case "no_bcc_configured":
        keepDisabled = true;
        status.classList.add("error");
        status.textContent = i18n("compose_no_bcc_configured");
        break;
      case "never_log":
        keepDisabled = true;
        status.classList.add("error");
        status.textContent = i18n("compose_bcc_never_log_blocked", [result.email]);
        break;
      default:
        status.classList.add("error");
        status.textContent = result.error || i18n("panel_error_generic");
    }
  } catch (err) {
    status.classList.add("error");
    status.textContent = err && err.message ? err.message : i18n("panel_error_generic");
  } finally {
    btn.disabled = keepDisabled;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyI18n(document);
  document.getElementById("open-settings-btn").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
  });
  document.getElementById("add-bcc-btn").addEventListener("click", handleAddBcc);
  load();
});
