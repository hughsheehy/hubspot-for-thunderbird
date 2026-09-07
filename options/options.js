/**
 * options/options.js
 *
 * Settings UI. Reads/writes settings via background.js messages so that
 * background.js remains the single place that talks to HubSpot and the
 * single place that touches browser.storage.
 */

"use strict";

const KNOWN_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];

function el(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ type: "getSettingsForOptions" });

  el("enabled-input").checked = settings.hubspotEnabled === true;
  el("token-input").value = settings.accessToken || "";
  el("portal-id-input").value = settings.portalId || "";
  el("bcc-input").value = settings.bccAddress || "";
  el("never-log-textarea").value = (settings.neverLogList || []).join("\n");

  const currency = settings.currencyCode || "USD";
  if (KNOWN_CURRENCIES.includes(currency)) {
    el("currency-select").value = currency;
    el("currency-custom-input").hidden = true;
  } else {
    el("currency-select").value = "other";
    el("currency-custom-input").hidden = false;
    el("currency-custom-input").value = currency;
  }
}

function currentCurrencyCode() {
  const selected = el("currency-select").value;
  if (selected === "other") {
    return (el("currency-custom-input").value || "USD").trim().toUpperCase();
  }
  return selected;
}

async function handleSave() {
  const status = el("save-status");
  status.classList.remove("error", "success");
  status.textContent = "";

  const settings = {
    hubspotEnabled: el("enabled-input").checked,
    accessToken: el("token-input").value.trim(),
    portalId: el("portal-id-input").value.trim(),
    bccAddress: el("bcc-input").value.trim(),
    currencyCode: currentCurrencyCode(),
    neverLogList: el("never-log-textarea").value
  };

  await browser.runtime.sendMessage({ type: "saveSettings", settings });

  status.classList.add("success");
  status.textContent = i18n("options_saved_notice");
  setTimeout(() => {
    status.textContent = "";
    status.classList.remove("success");
  }, 3000);
}

// The opt-in gates every outbound request, including this one. Reflect that in
// the UI rather than letting the user press a button that is bound to fail.
function syncEnabledState() {
  const enabled = el("enabled-input").checked;
  el("test-connection-btn").disabled = !enabled;
  el("test-connection-btn").title = enabled ? "" : i18n("options_consent_required_hint");
  const hint = el("test-status");
  if (!enabled) {
    hint.classList.remove("error", "success");
    hint.textContent = i18n("options_consent_required_hint");
  } else if (hint.textContent === i18n("options_consent_required_hint")) {
    hint.textContent = "";
  }
}

async function guessOwnEmail() {
  try {
    const identities = await browser.identities.list();
    return identities.length ? identities[0].email : null;
  } catch (_) {
    return null;
  }
}

async function handleTestConnection() {
  const status = el("test-status");
  const btn = el("test-connection-btn");
  status.classList.remove("error", "success");
  status.textContent = i18n("options_testing_notice");
  btn.disabled = true;

  // Testing sends a request to HubSpot, so persist the consent (and the token
  // it applies to) first — the background script reads the stored flag.
  await browser.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      hubspotEnabled: el("enabled-input").checked,
      accessToken: el("token-input").value.trim(),
      portalId: el("portal-id-input").value.trim(),
      bccAddress: el("bcc-input").value.trim(),
      currencyCode: currentCurrencyCode(),
      neverLogList: el("never-log-textarea").value
    }
  });

  const token = el("token-input").value.trim();
  const ownEmail = await guessOwnEmail();

  const result = await browser.runtime.sendMessage({
    type: "testConnection",
    token,
    ownEmail
  });

  btn.disabled = false;
  if (result.ok) {
    status.classList.add("success");
    status.textContent = result.name
      ? i18n("options_test_success", [result.name])
      : i18n("options_test_success_generic");
  } else {
    status.classList.add("error");
    status.textContent = i18n("options_test_failure", [result.error]);
  }
}

function handleCurrencyChange() {
  el("currency-custom-input").hidden = el("currency-select").value !== "other";
}

function handleToggleToken() {
  const input = el("token-input");
  input.type = input.type === "password" ? "text" : "password";
}

document.addEventListener("DOMContentLoaded", () => {
  applyI18n(document);
  loadSettings().then(syncEnabledState);

  el("save-btn").addEventListener("click", handleSave);
  el("test-connection-btn").addEventListener("click", handleTestConnection);
  el("currency-select").addEventListener("change", handleCurrencyChange);
  el("toggle-token-btn").addEventListener("click", handleToggleToken);
  el("enabled-input").addEventListener("change", syncEnabledState);
});
