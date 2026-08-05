/**
 * popup/common.js
 *
 * Shared helpers used by background.js, popup/panel.js, compose/compose.js,
 * and options/options.js. Loaded as a plain classic script everywhere (no
 * modules), so everything it defines is a plain global function.
 */

"use strict";

/**
 * Parse a raw address-header value (e.g. `"Doe, Jane" <jane@example.com>,
 * bob@example.com`) into [{ name, email }, ...]. Handles quoted display
 * names that contain commas.
 */
function parseAddressList(headerValue) {
  if (!headerValue) return [];
  const chunks = splitTopLevelCommas(headerValue);
  return chunks.map(parseSingleAddress).filter((a) => a && a.email);
}

function splitTopLevelCommas(str) {
  const parts = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "<" && !inQuotes) inAngle = true;
    if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseSingleAddress(chunk) {
  const trimmed = chunk.trim();
  const angleMatch = trimmed.match(/^(.*)<([^<>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1].trim().replace(/^"|"$/g, "");
    const email = angleMatch[2].trim();
    return { name: name || email, email };
  }
  if (trimmed.includes("@")) {
    return { name: trimmed, email: trimmed };
  }
  return null;
}

/** De-duplicate a list of {name, email} by lower-cased email. */
function dedupeAddresses(addresses) {
  const seen = new Map();
  for (const addr of addresses) {
    const key = addr.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, addr);
  }
  return Array.from(seen.values());
}

/**
 * A never-log list entry is either a full address ("person@example.com")
 * or a bare domain ("example.com"). Matching is case-insensitive.
 */
function isNeverLogged(email, neverLogList) {
  if (!email || !neverLogList || neverLogList.length === 0) return false;
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] || "";
  return neverLogList.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (!e) return false;
    return e === lower || e === domain || domain.endsWith("." + e);
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCurrency(amount, currencyCode) {
  if (amount === null || amount === undefined || amount === "") return null;
  const num = Number(amount);
  if (Number.isNaN(num)) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode || "USD",
      maximumFractionDigits: 0
    }).format(num);
  } catch (_) {
    return `${currencyCode || "USD"} ${num.toFixed(0)}`;
  }
}

/** ms -> "12m 30s" / "45s" / "3m". Returns null for falsy/invalid input. */
function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatDate(value) {
  if (!value) return null;
  const num = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const d = new Date(num);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(d);
}

/**
 * Apply _locales/en/messages.json strings to every element under `root`
 * carrying data-i18n / data-i18n-placeholder / data-i18n-title attributes.
 * Keeps all user-facing strings out of the HTML files.
 */
function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = browser.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const msg = browser.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.setAttribute("placeholder", msg);
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const msg = browser.i18n.getMessage(el.getAttribute("data-i18n-title"));
    if (msg) el.setAttribute("title", msg);
  });
}

function i18n(key, subs) {
  return browser.i18n.getMessage(key, subs);
}

// ---------------------------------------------------------------------------
// Shared contact-card rendering, used by both popup/panel.js (the message
// panel) and compose/compose.js (expanded recipient cards). Kept here so the
// two never drift out of sync — a contact/deals/activity card should look
// and behave identically no matter which panel it's shown in.
// ---------------------------------------------------------------------------

const ACTIVITY_ICONS = { email: "✉", call: "📞", meeting: "📅", note: "📝" };

function activityIcon(type) {
  return ACTIVITY_ICONS[type] || "•";
}

function activityTitle(activity) {
  return activity.title || i18n(`panel_activity_${activity.type}_untitled`);
}

function activityMeta(activity) {
  const parts = [i18n(`panel_activity_${activity.type}_label`)];

  if (activity.type === "email" && activity.direction) {
    parts.push(i18n(activity.direction === "INCOMING_EMAIL" ? "panel_activity_email_incoming" : "panel_activity_email_outgoing"));
  }
  if (activity.type === "call") {
    if (activity.direction) {
      parts.push(i18n(activity.direction === "INBOUND" ? "panel_activity_call_inbound" : "panel_activity_call_outbound"));
    }
    const duration = formatDuration(activity.durationMs);
    if (duration) parts.push(duration);
  }

  const date = formatDate(activity.timestamp);
  if (date) parts.push(date);

  return parts.join(" · ");
}

/** Clears `container` and fills it with the activity rows for `activities`. */
function renderActivityListInto(container, activities) {
  container.innerHTML = "";

  if (!activities || activities.length === 0) {
    const p = document.createElement("p");
    p.className = "status-line";
    p.textContent = i18n("panel_no_history");
    container.appendChild(p);
    return;
  }

  for (const activity of activities) {
    const row = document.createElement("div");
    row.className = "activity-row";

    const icon = document.createElement("span");
    icon.className = "activity-icon";
    icon.textContent = activityIcon(activity.type);

    const body = document.createElement("div");
    body.className = "activity-body";

    const title = document.createElement("div");
    title.className = "activity-title";
    title.textContent = activityTitle(activity);

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    meta.textContent = activityMeta(activity);

    body.appendChild(title);
    body.appendChild(meta);
    row.appendChild(icon);
    row.appendChild(body);
    container.appendChild(row);
  }
}

/** Clears `container` and fills it with deal rows for `deals`. */
function renderDealsListInto(container, deals, currencyCode) {
  container.innerHTML = "";

  if (!deals || deals.length === 0) {
    const p = document.createElement("p");
    p.className = "status-line";
    p.textContent = i18n("panel_no_deals");
    container.appendChild(p);
    return;
  }

  for (const deal of deals) {
    const dp = deal.properties || {};
    const row = document.createElement("div");
    row.className = "deal-row";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "deal-name";
    name.textContent = dp.dealname || i18n("panel_no_value");
    const stage = document.createElement("div");
    stage.className = "deal-meta";
    stage.textContent = dp.dealstage || i18n("panel_no_value");
    left.appendChild(name);
    left.appendChild(stage);

    const amount = document.createElement("div");
    amount.className = "deal-meta";
    amount.textContent = formatCurrency(dp.amount, currencyCode) || i18n("panel_no_value");

    row.appendChild(left);
    row.appendChild(amount);
    container.appendChild(row);
  }
}

/** Clears `dl` (a <dl> element) and fills it with the standard contact fields. */
function renderContactFieldsInto(dl, props, ownerLabel) {
  dl.innerHTML = "";
  const fields = [
    ["panel_field_title", props.jobtitle],
    ["panel_field_company", props.company],
    ["panel_field_phone", props.phone],
    ["panel_field_lifecycle", props.lifecyclestage],
    ["panel_field_lead_status", props.hs_lead_status],
    ["panel_field_owner", ownerLabel],
    ["panel_field_last_contacted", formatDate(props.notes_last_contacted)]
  ];
  for (const [labelKey, value] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = i18n(labelKey);
    const dd = document.createElement("dd");
    dd.textContent = value || i18n("panel_no_value");
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

function ownerDisplayLabel(owner) {
  return owner
    ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email
    : i18n("panel_owner_unknown");
}
