/**
 * background.js
 *
 * All HubSpot API access lives here. Panels (popup/, compose/) never see the
 * access token — they send a message and get back plain data or a status.
 *
 * Depends on popup/common.js being loaded first (see manifest.json
 * background.scripts) for parseAddressList(), isNeverLogged(), etc.
 */

"use strict";

// Runs once when this script is loaded. If you don't see this line (with
// this exact build tag) in the Inspect console right after reloading the
// add-on, Thunderbird is still running the previous build — temporary
// add-ons don't pick up file changes until you explicitly reload them.
console.info("[HubSpot for Thunderbird] background.js loaded — build 0.1.4 (contact-company)");

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

// HubSpot's default "Email to Contact" engagement association type.
// (associationCategory: HUBSPOT_DEFINED, typeId: 198.) If HubSpot changes
// their default type IDs, fetch the current one from
// GET /crm/v4/associations/emails/contacts/labels instead of hardcoding.
const EMAIL_TO_CONTACT_ASSOCIATION_TYPE_ID = 198;

const DEFAULT_SETTINGS = {
  accessToken: "",
  portalId: "",
  bccAddress: "",
  currencyCode: "USD",
  neverLogList: [] // array of lowercased emails/domains, one per line in the UI
};

// email -> { expires, data }
const contactCache = new Map();
// ownerId -> { expires, data }
const ownerCache = new Map();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await browser.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = Object.assign({}, current, partial);
  await browser.storage.local.set({ settings: next });
  contactCache.clear();
  ownerCache.clear();
  return next;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    contactCache.clear();
    ownerCache.clear();
  }
});

// ---------------------------------------------------------------------------
// Low-level HubSpot fetch
// ---------------------------------------------------------------------------

async function hubspotFetch(token, path, { method = "GET", body } = {}) {
  const resp = await fetch(HUBSPOT_API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      if (errBody && errBody.message) message = errBody.message;
    } catch (_) {
      /* body wasn't JSON; keep the status-only message */
    }
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  if (resp.status === 204) return null;
  return resp.json();
}

// ---------------------------------------------------------------------------
// HubSpot operations
// ---------------------------------------------------------------------------

const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "company",
  "phone",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  "notes_last_contacted"
];

async function searchContactByEmail(token, email) {
  const result = await hubspotFetch(token, "/crm/v3/objects/contacts/search", {
    method: "POST",
    body: {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] }
      ],
      properties: CONTACT_PROPERTIES,
      limit: 1
    }
  });
  return (result.results && result.results[0]) || null;
}

async function getOwner(token, ownerId) {
  if (!ownerId) return null;
  const cached = ownerCache.get(ownerId);
  if (cached && cached.expires > Date.now()) return cached.data;

  try {
    const owner = await hubspotFetch(token, `/crm/v3/owners/${ownerId}`);
    ownerCache.set(ownerId, { expires: Date.now() + CACHE_TTL_MS, data: owner });
    return owner;
  } catch (err) {
    // Missing owners.read scope, or the owner was deactivated. Don't fail
    // the whole lookup over it.
    return null;
  }
}

// HubSpot's UI shows a contact's associated Company record (name, domain,
// etc.) separately from the contact's own "Company Name" property
// (properties.company on the contact — a plain text field that only tracks
// the association if it was set by typing into that field, not if the
// company was associated via the Associations panel). The panel shows both
// side by side rather than picking one, since they can legitimately
// disagree.
//
// A contact can have more than one associated company; HubSpot lets exactly
// one be flagged "Primary". That flag isn't visible on the plain v3
// associations list (bare IDs only), so this uses the v4 endpoint, which
// reports each association's type(s). typeId 1 (category HUBSPOT_DEFINED) is
// HubSpot's stable identifier for the "Primary" contact-to-company
// association — confirmed via GET /crm/v4/associations/contacts/companies/
// labels. HubSpot's own docs warn that the *label text* ("Primary") can be
// renamed per portal, so this matches on typeId, not the label string.
//
// v4 is on a deprecation path (HubSpot is moving to date-based API
// versions; v4 support ends March 2027) but is still the best-documented,
// stable option today and everything else in this file is on v3 anyway —
// worth a full versioning pass across the project at some point, not scoped
// to this one call.
const PRIMARY_COMPANY_ASSOCIATION_TYPE_ID = 1;

async function getPrimaryCompanyForContact(token, contactId) {
  const assoc = await hubspotFetch(
    token,
    `/crm/v4/objects/contacts/${contactId}/associations/companies`
  );
  const results = assoc.results || [];
  if (results.length === 0) return null;

  const primary = results.find((r) =>
    (r.associationTypes || []).some(
      (t) => t.category === "HUBSPOT_DEFINED" && t.typeId === PRIMARY_COMPANY_ASSOCIATION_TYPE_ID
    )
  );
  // Nothing explicitly flagged primary (older data, or every association is
  // unlabeled) — fall back to HubSpot's first result rather than showing
  // nothing.
  const companyId = (primary || results[0]).toObjectId;
  if (!companyId) return null;
  return hubspotFetch(token, `/crm/v3/objects/companies/${companyId}?properties=name,domain`);
}

async function getDealsForContact(token, contactId) {
  const assoc = await hubspotFetch(
    token,
    `/crm/v3/objects/contacts/${contactId}/associations/deals`
  );
  const ids = (assoc.results || []).map((r) => r.id).slice(0, 25);
  if (ids.length === 0) return [];

  const batch = await hubspotFetch(token, "/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: {
      properties: ["dealname", "dealstage", "amount", "pipeline"],
      inputs: ids.map((id) => ({ id }))
    }
  });
  return batch.results || [];
}

async function createContact(token, properties) {
  return hubspotFetch(token, "/crm/v3/objects/contacts", {
    method: "POST",
    body: { properties }
  });
}

async function logEmailMessage(token, contactId, { subject, bodyText, direction, timestampMs }) {
  return hubspotFetch(token, "/crm/v3/objects/emails", {
    method: "POST",
    body: {
      properties: {
        hs_timestamp: String(timestampMs),
        hs_email_direction: direction, // "EMAIL" (outgoing) or "INCOMING_EMAIL"
        hs_email_subject: subject || "",
        hs_email_text: bodyText || "",
        hs_email_status: "SENT"
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: EMAIL_TO_CONTACT_ASSOCIATION_TYPE_ID
            }
          ]
        }
      ]
    }
  });
}

function messageTimestampMs(value, fallback = Date.now()) {
  if (!value) return fallback;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? fallback : timestamp;
}

// ---------------------------------------------------------------------------
// Activity history (emails, calls, meetings, notes) for the contact panel
//
// Scopes: despite the crm.objects.<type>.read naming pattern used elsewhere
// (deals, owners), HubSpot doesn't have crm.objects.calls.read /
// crm.objects.meetings.read / crm.objects.notes.read scopes at all — those
// three APIs are gated behind crm.objects.contacts.read/.write instead (see
// HubSpot's own calls/meetings/notes v3 API reference pages). Only the
// emails branch needs the separate sales-email-read scope.
// ---------------------------------------------------------------------------

// Per-type property lists. hs_timestamp is present on all four engagement
// types and is what we sort by.
const ACTIVITY_PROPERTIES = {
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_direction"],
  calls: ["hs_timestamp", "hs_call_title", "hs_call_direction", "hs_call_duration"],
  meetings: ["hs_timestamp", "hs_meeting_title"],
  notes: ["hs_timestamp", "hs_note_body"]
};

const ACTIVITY_HISTORY_LIMIT = 5;
// How many associated IDs to pull per engagement type before merging and
// sorting. HubSpot's associations-listing endpoint isn't sorted by recency,
// so a contact with more than this many of one engagement type could in
// theory have a newer item excluded from the merged top-5. Generous enough
// in practice; see README limitations.
const ACTIVITY_IDS_PER_TYPE = 20;

async function getEngagementsForContact(token, contactId, objectType) {
  const assoc = await hubspotFetch(
    token,
    `/crm/v3/objects/contacts/${contactId}/associations/${objectType}`
  );
  const ids = (assoc.results || []).map((r) => r.id).slice(0, ACTIVITY_IDS_PER_TYPE);
  console.debug(
    `[HubSpot for Thunderbird] activity history: contact ${contactId} has ${ids.length} associated ${objectType}`
  );
  if (ids.length === 0) return [];

  const batch = await hubspotFetch(token, `/crm/v3/objects/${objectType}/batch/read`, {
    method: "POST",
    body: {
      properties: ACTIVITY_PROPERTIES[objectType],
      inputs: ids.map((id) => ({ id }))
    }
  });
  const results = batch.results || [];
  const withTimestamp = results.filter((item) => item.properties && item.properties.hs_timestamp).length;
  console.debug(
    `[HubSpot for Thunderbird] activity history: ${objectType} batch/read returned ${results.length} items, ${withTimestamp} with hs_timestamp. First item properties: ${JSON.stringify(results[0] ? results[0].properties : null)}`
  );
  return results.map((item) => normalizeActivity(objectType, item));
}

// hs_timestamp (and other HubSpot date/datetime properties) can come back
// either as an epoch-milliseconds numeric string or as an ISO-8601 string
// like "2026-06-19T15:07:06Z" depending on the property and object type.
// Number("2026-06-19T15:07:06Z") is silently NaN, so handle both shapes.
function parseHubspotTimestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeActivity(objectType, item) {
  const p = item.properties || {};
  const timestamp = parseHubspotTimestamp(p.hs_timestamp);

  switch (objectType) {
    case "emails":
      return { type: "email", timestamp, title: p.hs_email_subject || null, direction: p.hs_email_direction || null };
    case "calls":
      return {
        type: "call",
        timestamp,
        title: p.hs_call_title || null,
        direction: p.hs_call_direction || null,
        durationMs: p.hs_call_duration ? Number(p.hs_call_duration) : null
      };
    case "meetings":
      return { type: "meeting", timestamp, title: p.hs_meeting_title || null };
    case "notes":
      return { type: "note", timestamp, title: p.hs_note_body ? stripHtml(p.hs_note_body).slice(0, 140) : null };
    default:
      return { type: objectType, timestamp, title: null };
  }
}

async function getActivityHistory(token, contactId) {
  const perType = await Promise.all(
    Object.keys(ACTIVITY_PROPERTIES).map((type) =>
      // A failure on one type (missing scope, bad object-type name, etc.)
      // shouldn't blank out the other three — but don't fail silently
      // either. Check this extension's background-page Inspect console
      // if history is unexpectedly empty.
      getEngagementsForContact(token, contactId, type).catch((err) => {
        console.warn(
          `[HubSpot for Thunderbird] activity history: fetching "${type}" for contact ${contactId} failed:`,
          err.status,
          err.message
        );
        return [];
      })
    )
  );
  return perType
    .flat()
    .filter((a) => a.timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ACTIVITY_HISTORY_LIMIT);
}

async function testConnection(token, ownEmail) {
  // Cheapest read that proves the token works and has contacts.read.
  await hubspotFetch(token, "/crm/v3/objects/contacts?limit=1");

  let name = null;
  if (ownEmail) {
    try {
      const owners = await hubspotFetch(
        token,
        `/crm/v3/owners/?email=${encodeURIComponent(ownEmail)}`
      );
      const owner = owners.results && owners.results[0];
      if (owner) {
        name = [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email;
      }
    } catch (_) {
      // owners.read is optional; ignore failures here.
    }
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Cached contact bundle (contact + owner + company + deals) for one email
// address
// ---------------------------------------------------------------------------

async function getContactBundle(token, email) {
  const key = email.toLowerCase();
  const cached = contactCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const contact = await searchContactByEmail(token, email);
  let bundle;
  if (!contact) {
    bundle = { found: false };
  } else {
    const ownerId = contact.properties && contact.properties.hubspot_owner_id;
    const [owner, company, deals, activities] = await Promise.all([
      getOwner(token, ownerId),
      getPrimaryCompanyForContact(token, contact.id).catch((err) => {
        console.warn(
          `[HubSpot for Thunderbird] company lookup for contact ${contact.id} failed:`,
          err.status,
          err.message
        );
        return null;
      }),
      getDealsForContact(token, contact.id).catch(() => []),
      getActivityHistory(token, contact.id).catch(() => [])
    ]);
    bundle = { found: true, contact, owner, company, deals, activities };
  }

  contactCache.set(key, { expires: Date.now() + CACHE_TTL_MS, data: bundle });
  return bundle;
}

// ---------------------------------------------------------------------------
// Message-display helpers (which address are we even looking at?)
// ---------------------------------------------------------------------------

async function resolveCounterpart(tabId) {
  const message = await browser.messageDisplay.getDisplayedMessage(tabId);
  if (!message) return null;

  const identities = await browser.identities.list();
  const ownEmails = new Set(identities.map((i) => i.email.toLowerCase()));

  const authorAddr = parseAddressList(message.author || "")[0] || null;
  const authorIsMe = !!authorAddr && ownEmails.has(authorAddr.email.toLowerCase());

  let targetAddr = authorAddr;
  if (authorIsMe) {
    const recipientHeaders = [].concat(message.recipients || [], message.ccList || []);
    const parsed = recipientHeaders.flatMap(parseAddressList);
    targetAddr = parsed.find((a) => !ownEmails.has(a.email.toLowerCase())) || parsed[0] || null;
  }

  return { address: targetAddr, youSent: authorIsMe, message };
}

function addressesFromHeaders(headers) {
  return dedupeAddresses([].concat(...headers).flatMap(parseAddressList));
}

function findNeverLoggedParticipant(addresses, neverLogList) {
  return addresses.find((address) => isNeverLogged(address.email, neverLogList)) || null;
}

function displayedMessageParticipants(message) {
  return addressesFromHeaders([
    message.author || "",
    message.recipients || [],
    message.ccList || [],
    message.bccList || []
  ]);
}

async function composeParticipants(details) {
  const identities = await browser.identities.list();
  const identity = identities.find((item) => item.id === details.identityId);
  return addressesFromHeaders([
    identity && identity.email ? identity.email : [],
    details.replyTo || [],
    details.to || [],
    details.cc || [],
    details.bcc || []
  ]);
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "getSettingsForOptions":
      return getSettings();

    case "saveSettings":
      return saveSettings(normalizeIncomingSettings(msg.settings));

    case "testConnection":
      return testConnection(msg.token, msg.ownEmail)
        .then((result) => ({ ok: true, ...result }))
        .catch((err) => ({ ok: false, error: err.message }));

    case "lookupForDisplayedMessage":
      return withErrorStatus(handleLookupForDisplayedMessage(msg.tabId));

    case "createContact":
      return withErrorStatus(handleCreateContact(msg.email, msg.properties));

    case "logDisplayedMessage":
      return withErrorStatus(handleLogDisplayedMessage(msg.tabId));

    case "lookupComposeRecipients":
      return withErrorStatus(handleLookupComposeRecipients(msg.tabId));

    case "getComposeRecipientDetails":
      return withErrorStatus(handleGetRecipientDetails(msg.email));

    case "addLoggingBcc":
      return withErrorStatus(handleAddLoggingBcc(msg.tabId));

    default:
      return undefined; // not for us
  }
});

function withErrorStatus(promise) {
  return Promise.resolve(promise).catch((err) => ({
    status: "error",
    error: err && err.message ? err.message : String(err)
  }));
}

function normalizeIncomingSettings(settings) {
  const next = Object.assign({}, settings);
  if (typeof next.neverLogList === "string") {
    next.neverLogList = next.neverLogList
      .split("\n")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(next.neverLogList)) {
    next.neverLogList = next.neverLogList.map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  next.accessToken = (next.accessToken || "").trim();
  next.portalId = (next.portalId || "").trim();
  next.bccAddress = (next.bccAddress || "").trim();
  return next;
}

async function handleLookupForDisplayedMessage(tabId) {
  const settings = await getSettings();
  if (!settings.accessToken) return { status: "not_configured" };

  const counterpart = await resolveCounterpart(tabId);
  if (!counterpart || !counterpart.address) return { status: "no_message" };

  const email = counterpart.address.email;
  if (isNeverLogged(email, settings.neverLogList)) {
    return { status: "never_log", email, youSent: counterpart.youSent };
  }

  try {
    const bundle = await getContactBundle(settings.accessToken, email);
    return {
      status: bundle.found ? "found" : "not_found",
      email,
      name: counterpart.address.name,
      youSent: counterpart.youSent,
      contact: bundle.contact || null,
      owner: bundle.owner || null,
      company: bundle.company || null,
      deals: bundle.deals || [],
      activities: bundle.activities || [],
      portalId: settings.portalId,
      currencyCode: settings.currencyCode
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function handleCreateContact(email, properties) {
  const settings = await getSettings();
  if (!settings.accessToken) return { status: "not_configured" };
  if (isNeverLogged(email, settings.neverLogList)) return { status: "never_log", email };

  try {
    const contact = await createContact(settings.accessToken, {
      email,
      ...properties
    });
    contactCache.delete(email.toLowerCase());
    return { status: "created", contact };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function handleLogDisplayedMessage(tabId) {
  const settings = await getSettings();
  if (!settings.accessToken) return { status: "not_configured" };

  const counterpart = await resolveCounterpart(tabId);
  if (!counterpart || !counterpart.address) return { status: "no_message" };

  const email = counterpart.address.email;
  const excludedParticipant = findNeverLoggedParticipant(
    displayedMessageParticipants(counterpart.message),
    settings.neverLogList
  );
  if (excludedParticipant) {
    return { status: "never_log", email: excludedParticipant.email };
  }

  try {
    const bundle = await getContactBundle(settings.accessToken, email);
    if (!bundle.found) return { status: "not_found", email };

    const full = await browser.messages.getFull(counterpart.message.id);
    const subject = counterpart.message.subject || "";
    const bodyText = extractPlainTextBody(full);
    const timestampMs = messageTimestampMs(counterpart.message.date);

    await logEmailMessage(settings.accessToken, bundle.contact.id, {
      subject,
      bodyText,
      direction: counterpart.youSent ? "EMAIL" : "INCOMING_EMAIL",
      timestampMs
    });

    return { status: "logged" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function handleLookupComposeRecipients(tabId) {
  const settings = await getSettings();
  if (!settings.accessToken) return { status: "not_configured" };

  const details = await browser.compose.getComposeDetails(tabId);
  const addresses = await composeParticipants(details);
  const bccLower = settings.bccAddress ? settings.bccAddress.toLowerCase() : null;
  const excludedParticipant = findNeverLoggedParticipant(addresses, settings.neverLogList);

  const results = await Promise.all(
    addresses.map(async (addr) => {
      // The configured logging BCC address is HubSpot's own ingestion
      // pipe, not a person — skip the lookup and label it as what it is
      // instead of reporting it as "not found."
      if (bccLower && addr.email.toLowerCase() === bccLower) {
        return { email: addr.email, name: addr.name, state: "logging_bcc" };
      }
      if (isNeverLogged(addr.email, settings.neverLogList)) {
        return { email: addr.email, name: addr.name, state: "never_log" };
      }
      try {
        const bundle = await getContactBundle(settings.accessToken, addr.email);
        return {
          email: addr.email,
          name: addr.name,
          state: bundle.found ? "found" : "not_found",
          contactId: bundle.found ? bundle.contact.id : null
        };
      } catch (err) {
        return { email: addr.email, name: addr.name, state: "error", error: err.message };
      }
    })
  );

  return {
    status: "ok",
    recipients: results,
    bccAddress: settings.bccAddress,
    loggingBlockedBy: excludedParticipant ? excludedParticipant.email : null
  };
}

// Full contact + deals + activity bundle for one compose recipient,
// fetched on demand when its row is expanded rather than upfront for every
// recipient in lookupComposeRecipients (which stays a cheap badge-only
// check). Reuses the same 5-minute contactCache as the message panel.
async function handleGetRecipientDetails(email) {
  const settings = await getSettings();
  if (!settings.accessToken) return { status: "not_configured" };
  if (isNeverLogged(email, settings.neverLogList)) return { status: "never_log", email };

  try {
    const bundle = await getContactBundle(settings.accessToken, email);
    if (!bundle.found) return { status: "not_found", email };
    return {
      status: "found",
      email,
      contact: bundle.contact,
      owner: bundle.owner || null,
      company: bundle.company || null,
      deals: bundle.deals || [],
      activities: bundle.activities || [],
      portalId: settings.portalId,
      currencyCode: settings.currencyCode
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function handleAddLoggingBcc(tabId) {
  const settings = await getSettings();
  if (!settings.bccAddress) return { status: "no_bcc_configured" };

  const details = await browser.compose.getComposeDetails(tabId);
  const excludedParticipant = findNeverLoggedParticipant(
    await composeParticipants(details),
    settings.neverLogList
  );
  if (excludedParticipant) {
    return { status: "never_log", email: excludedParticipant.email };
  }

  const existingBcc = addressesFromHeaders([details.bcc || []]);
  const already = existingBcc.some(
    (a) => a.email.toLowerCase() === settings.bccAddress.toLowerCase()
  );
  if (already) return { status: "already_present" };

  const nextBcc = [].concat(details.bcc || [], settings.bccAddress);
  await browser.compose.setComposeDetails(tabId, { bcc: nextBcc });
  return { status: "added" };
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

function extractPlainTextBody(fullMessage) {
  if (!fullMessage) return "";
  if (fullMessage.parts && fullMessage.parts.length) {
    const plain = findPartByContentType(fullMessage, "text/plain");
    if (plain && plain.body) return plain.body;
    const html = findPartByContentType(fullMessage, "text/html");
    if (html && html.body) return stripHtml(html.body);
  }
  return fullMessage.body || "";
}

function findPartByContentType(node, contentType) {
  if (node.contentType && node.contentType.startsWith(contentType)) return node;
  for (const part of node.parts || []) {
    const found = findPartByContentType(part, contentType);
    if (found) return found;
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
