"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const commonSource = fs.readFileSync(path.join(root, "popup/common.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");

function createHarness({ settings = {}, message, composeDetails, failures = {}, fetchImpl } = {}) {
  let listener;
  let setComposeDetailsCalls = 0;
  let fetchCalls = 0;
  // The consent opt-in ships off by default. Most tests exercise behaviour
  // after the user has granted it, so default it on here and let the gate
  // tests below opt back out explicitly.
  const storageData = {
    settings: Object.assign({ hubspotEnabled: true }, settings)
  };

  const browser = {
    storage: {
      local: {
        get: async (key) => ({ [key]: storageData[key] }),
        set: async (values) => { Object.assign(storageData, values); }
      },
      onChanged: { addListener: () => undefined }
    },
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } }
    },
    i18n: { getMessage: (key) => key },
    identities: {
      list: async () => [{ id: "identity-1", email: "sender@example.com" }]
    },
    messageDisplay: {
      getDisplayedMessage: async () => {
        if (failures.displayedMessage) throw new Error(failures.displayedMessage);
        return message;
      }
    },
    messages: {
      getFull: async () => ({ body: "message body" })
    },
    compose: {
      getComposeDetails: async () => {
        if (failures.composeDetails) throw new Error(failures.composeDetails);
        return composeDetails;
      },
      setComposeDetails: async () => { setComposeDetailsCalls += 1; }
    }
  };

  const context = vm.createContext({
    browser,
    fetch:
      fetchImpl ||
      (async () => {
        fetchCalls += 1;
        throw new Error("Unexpected HubSpot request");
      }),
    console: { info() {}, debug() {}, warn() {} },
    Intl,
    Date,
    Map,
    Set,
    Promise
  });
  vm.runInContext(commonSource, context, { filename: "popup/common.js" });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  return {
    context,
    send: (msg) => listener(msg),
    get fetchCalls() { return fetchCalls; },
    get setComposeDetailsCalls() { return setComposeDetailsCalls; },
    get storageData() { return storageData; }
  };
}

test("never-log matching covers exact addresses, domains, and subdomains", () => {
  const harness = createHarness();
  assert.equal(
    vm.runInContext('isNeverLogged("Person@Example.com", ["person@example.com"])', harness.context),
    true
  );
  assert.equal(
    vm.runInContext('isNeverLogged("user@eu.example.com", ["example.com"])', harness.context),
    true
  );
  assert.equal(
    vm.runInContext('isNeverLogged("user@notexample.com", ["example.com"])', harness.context),
    false
  );
});

test("manual logging is blocked when any displayed-message participant is excluded", async () => {
  const harness = createHarness({
    settings: { accessToken: "token", neverLogList: ["private.example"] },
    message: {
      id: 1,
      author: "sender@example.com",
      recipients: ["customer@example.com"],
      ccList: ["person@private.example"],
      bccList: []
    }
  });

  const result = await harness.send({ type: "logDisplayedMessage", tabId: 7 });
  assert.deepEqual({ ...result }, { status: "never_log", email: "person@private.example" });
  assert.equal(harness.fetchCalls, 0);
});

test("logging BCC is blocked when any compose participant is excluded", async () => {
  const harness = createHarness({
    settings: {
      accessToken: "token",
      bccAddress: "123@bcc.hubspot.com",
      neverLogList: ["private.example"]
    },
    composeDetails: {
      identityId: "identity-1",
      to: ["customer@example.com"],
      cc: ["person@private.example"],
      bcc: []
    }
  });

  const result = await harness.send({ type: "addLoggingBcc", tabId: 8 });
  assert.deepEqual({ ...result }, { status: "never_log", email: "person@private.example" });
  assert.equal(harness.setComposeDetailsCalls, 0);
});

test("rejected message-display APIs return a structured error", async () => {
  const harness = createHarness({
    settings: { accessToken: "token" },
    failures: { displayedMessage: "message tab disappeared" }
  });

  const result = await harness.send({ type: "lookupForDisplayedMessage", tabId: 9 });
  assert.deepEqual({ ...result }, { status: "error", error: "message tab disappeared" });
});

test("rejected compose APIs return a structured error", async () => {
  const harness = createHarness({
    settings: { accessToken: "token" },
    failures: { composeDetails: "compose tab disappeared" }
  });

  const result = await harness.send({ type: "lookupComposeRecipients", tabId: 10 });
  assert.deepEqual({ ...result }, { status: "error", error: "compose tab disappeared" });
});

test("createContact is blocked for a never-logged address", async () => {
  const harness = createHarness({
    settings: { accessToken: "token", neverLogList: ["private.example"] }
  });

  const result = await harness.send({
    type: "createContact",
    email: "person@private.example",
    properties: {}
  });

  assert.deepEqual({ ...result }, { status: "never_log", email: "person@private.example" });
  assert.equal(harness.fetchCalls, 0);
});

test("createContact (used by both the message panel and the compose panel) creates the contact", async () => {
  let requestBody = null;
  const harness = createHarness({
    settings: { accessToken: "token" },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: "999", properties: requestBody.properties })
      };
    }
  });

  const result = await harness.send({
    type: "createContact",
    email: "new.person@example.com",
    properties: { firstname: "New" }
  });

  assert.equal(result.status, "created");
  assert.equal(result.contact.id, "999");
  assert.equal(requestBody.properties.email, "new.person@example.com");
  assert.equal(requestBody.properties.firstname, "New");
});

// Shared by the two company tests below: everything except the
// contacts/associations/companies response is identical, so the fetchImpl
// only needs a companiesAssociationResponse override.
function companyLookupFetchImpl(companiesAssociationResponse) {
  return async (url) => {
    if (url.includes("/contacts/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: "1", properties: { email: "person@example.com", company: "Text Company" } }]
        })
      };
    }
    if (url.includes("/contacts/1/associations/companies")) {
      return { ok: true, status: 200, json: async () => companiesAssociationResponse };
    }
    if (url.includes("/companies/55")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "55", properties: { name: "Real Company Inc", domain: "realcompany.com" } })
      };
    }
    if (url.includes("/companies/56")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "56", properties: { name: "Other Company LLC", domain: "othercompany.com" } })
      };
    }
    // Deals and the four activity types all list associations the same
    // way; empty results short-circuit before any batch/read call.
    if (/\/associations\/(deals|emails|calls|meetings|notes)$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    throw new Error(`Unexpected HubSpot request: ${url}`);
  };
}

const DISPLAYED_MESSAGE_FIXTURE = {
  id: 1,
  author: "person@example.com",
  recipients: [],
  ccList: [],
  bccList: [],
  subject: "Hi",
  date: "2026-08-06T10:00:00Z"
};

test("a found contact includes the associated Company record, shown alongside the contact's text company field", async () => {
  const harness = createHarness({
    settings: { accessToken: "token" },
    message: DISPLAYED_MESSAGE_FIXTURE,
    fetchImpl: companyLookupFetchImpl({
      results: [{ toObjectId: "55", associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 1, label: "Primary" }] }]
    })
  });

  const result = await harness.send({ type: "lookupForDisplayedMessage", tabId: 1 });

  assert.equal(result.status, "found");
  assert.equal(result.contact.properties.company, "Text Company");
  assert.equal(result.company.properties.name, "Real Company Inc");
});

test("with multiple associated companies, the one flagged Primary is used, not just the first result", async () => {
  const harness = createHarness({
    settings: { accessToken: "token" },
    message: DISPLAYED_MESSAGE_FIXTURE,
    fetchImpl: companyLookupFetchImpl({
      results: [
        // Listed first, but not the primary — a naive "take results[0]"
        // implementation would wrongly pick this one.
        { toObjectId: "56", associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 279, label: null }] },
        { toObjectId: "55", associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 1, label: "Primary" }] }
      ]
    })
  });

  const result = await harness.send({ type: "lookupForDisplayedMessage", tabId: 1 });

  assert.equal(result.status, "found");
  assert.equal(result.company.properties.name, "Real Company Inc");
});

test("with multiple associated companies and none flagged Primary, falls back to the first result", async () => {
  const harness = createHarness({
    settings: { accessToken: "token" },
    message: DISPLAYED_MESSAGE_FIXTURE,
    fetchImpl: companyLookupFetchImpl({
      results: [
        { toObjectId: "56", associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 279, label: null }] },
        { toObjectId: "55", associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 279, label: null }] }
      ]
    })
  });

  const result = await harness.send({ type: "lookupForDisplayedMessage", tabId: 1 });

  assert.equal(result.status, "found");
  assert.equal(result.company.properties.name, "Other Company LLC");
});

test("malformed message dates use a valid fallback timestamp", () => {
  const harness = createHarness();
  assert.equal(vm.runInContext('messageTimestampMs("not-a-date", 1234)', harness.context), 1234);
  assert.equal(
    vm.runInContext('messageTimestampMs("2026-08-06T10:00:00Z", 1234)', harness.context),
    Date.parse("2026-08-06T10:00:00Z")
  );
});

test("direct logging is persisted and a second attempt is blocked", async () => {
  let emailCreateCalls = 0;
  const message = {
    ...DISPLAYED_MESSAGE_FIXTURE,
    headerMessageId: "unique-message@example.com"
  };
  const harness = createHarness({
    settings: { accessToken: "token" },
    message,
    fetchImpl: async (url) => {
      if (url.includes("/contacts/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ id: "1", properties: { email: "person@example.com" } }] })
        };
      }
      if (url.includes("/contacts/1/associations/companies")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (/\/associations\/(deals|emails|calls|meetings|notes)$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (url.endsWith("/crm/v3/objects/emails")) {
        emailCreateCalls += 1;
        return { ok: true, status: 201, json: async () => ({ id: "email-1" }) };
      }
      throw new Error(`Unexpected HubSpot request: ${url}`);
    }
  });

  const first = await harness.send({ type: "logDisplayedMessage", tabId: 1 });
  const second = await harness.send({ type: "logDisplayedMessage", tabId: 1 });

  assert.equal(first.status, "logged");
  assert.equal(second.status, "already_logged");
  assert.equal(emailCreateCalls, 1);
  assert.ok(harness.storageData.loggedMessages["header:unique-message@example.com"]);
});

test("message lookup reports persisted direct-log state for the disabled UI", async () => {
  const message = {
    ...DISPLAYED_MESSAGE_FIXTURE,
    headerMessageId: "reopened-message@example.com"
  };
  const harness = createHarness({
    settings: { accessToken: "token" },
    message,
    fetchImpl: companyLookupFetchImpl({ results: [] })
  });
  harness.storageData.loggedMessages = {
    "header:reopened-message@example.com": Date.now()
  };

  const result = await harness.send({ type: "lookupForDisplayedMessage", tabId: 1 });
  assert.equal(result.status, "found");
  assert.equal(result.alreadyLogged, true);
});

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

test("no request reaches HubSpot while the opt-in is off", async () => {
  const harness = createHarness({
    settings: { hubspotEnabled: false, accessToken: "token" },
    message: {
      id: 1,
      author: "customer@example.com",
      recipients: ["sender@example.com"],
      ccList: [],
      bccList: []
    }
  });

  for (const type of [
    "lookupForDisplayedMessage",
    "logDisplayedMessage",
    "lookupComposeRecipients",
    "addLoggingBcc"
  ]) {
    const result = await harness.send({ type, tabId: 7 });
    assert.equal(result.status, "not_enabled", type);
  }

  assert.equal(harness.fetchCalls, 0);
});

test("the opt-in gate outranks a configured token", async () => {
  const harness = createHarness({
    settings: { hubspotEnabled: false, accessToken: "token" }
  });

  const result = await harness.send({
    type: "createContact",
    email: "customer@example.com",
    properties: {}
  });

  assert.equal(result.status, "not_enabled");
  assert.equal(harness.fetchCalls, 0);
});

test("testConnection refuses to transmit while the opt-in is off", async () => {
  const harness = createHarness({ settings: { hubspotEnabled: false } });

  const result = await harness.send({ type: "testConnection", token: "token" });

  assert.equal(result.ok, false);
  assert.match(result.error, /turned off/i);
  assert.equal(harness.fetchCalls, 0);
});

test("saveSettings stores the opt-in as a strict boolean", async () => {
  const harness = createHarness({ settings: { hubspotEnabled: false } });

  const saved = await harness.send({
    type: "saveSettings",
    settings: { accessToken: "token", hubspotEnabled: "yes" }
  });

  assert.equal(saved.hubspotEnabled, false);
});

test("an absent opt-in defaults to off", async () => {
  const harness = createHarness({ settings: { hubspotEnabled: undefined, accessToken: "token" } });
  const settings = await harness.send({ type: "getSettingsForOptions" });
  assert.equal(settings.hubspotEnabled, false);
  assert.equal(harness.fetchCalls, 0);
});
