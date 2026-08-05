# Privacy

HubSpot for Thunderbird is a local-only bridge between your Thunderbird
profile and your own HubSpot account. There is no server operated by this
project, no analytics, and no telemetry.

## What data this add-on touches

- **Message headers and bodies** of the message currently open in the reading
  pane, or being composed, so it can look up the counterpart's address and
  (if you press the button) log the message.
- **Your HubSpot access token** (a Service Key or a private app token — both
  work identically), portal ID, logging BCC address, currency preference, and
  never-log list — all entered by you in the settings page.
- **Contact, owner, and deal data** returned by the HubSpot APIs for the
  address currently in view.

## Where that data goes

Everywhere data can go is listed here, in full:

- **api.hubapi.com** — the only network destination this add-on ever
  contacts. Requests carry your access token and, depending on the action,
  an email address, a message subject/body, or contact properties. This
  happens only when a message is open in a message-display or compose tab,
  or when you press **Test connection**, **Create contact**, or **Log this
  message**.
- **Thunderbird's local `storage.local`** — your token, portal ID, BCC
  address, currency, and never-log list are stored here, on this device,
  in your Thunderbird profile. They are not synced to Mozilla Sync or
  anywhere else.
- **In-memory cache** — looked-up contacts, owners, and deals are cached in
  the background script's memory for five minutes to avoid refetching while
  you read several messages from the same person. This cache is never
  written to disk and is cleared whenever you change settings or restart
  Thunderbird.

Nothing is sent to the add-on's authors, to any analytics or crash-reporting
service, or to any third party. There is no update-check "phone home" beyond
Thunderbird's own add-on update mechanism, which behaves the same as for any
other extension.

## Addresses you exclude

Anything on your never-log list (an exact address or a whole domain) is
never looked up and never logged — the add-on skips the HubSpot request
entirely for those addresses.

## Your token

The access token you paste into settings — whether a Service Key or a
private app token — is yours: scoped by you, revocable by you at any time
from HubSpot's Service Keys or Private Apps screen, and visible only to
`background.js` in this add-on. Panels (the message and compose popups)
never receive it — they ask the background script to perform an action and
get back plain data.

## Questions

Open an issue on the project's repository if anything here is unclear or if
you find behavior that doesn't match this document.
