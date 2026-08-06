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

  const browser = {
    storage: {
      local: {
        get: async () => ({ settings }),
        set: async () => undefined
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
    get setComposeDetailsCalls() { return setComposeDetailsCalls; }
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

test("malformed message dates use a valid fallback timestamp", () => {
  const harness = createHarness();
  assert.equal(vm.runInContext('messageTimestampMs("not-a-date", 1234)', harness.context), 1234);
  assert.equal(
    vm.runInContext('messageTimestampMs("2026-08-06T10:00:00Z", 1234)', harness.context),
    Date.parse("2026-08-06T10:00:00Z")
  );
});
