# HubSpot for Thunderbird

See who you are emailing — their HubSpot record, owner, and open deals — without
leaving Thunderbird. Log messages to the contact timeline in one click.

HubSpot ships an Outlook add-in and a Chrome extension for Gmail, but nothing for
Thunderbird. The BCC workaround covers logging; it cannot show you context. This
covers both.

> **Screenshot:** a panel showing a contact's details and deals next to an open
> message. (Add one at `docs/screenshot.png` and link it here once you have a
> build to capture.)

## Features

- **Contact panel** on any open message: name, title, company, phone, lifecycle
  stage, lead status, record owner, and last-contacted date
- **Deals** associated with that contact, with stage and amount
- **Recent activity** — the last 5 emails, calls, meetings, and notes on the
  contact, merged and sorted newest first
- **Sent mail aware** — opening a message you sent looks up the recipient, not you
- **Log this message** attaches the subject and body to the contact timeline
- **Create contact** for senders not yet in your CRM
- **Compose panel** shows which recipients are already in HubSpot, adds your
  logging BCC address in one click, and lets you click any matched recipient
  to expand their full contact card, deals, and recent activity inline
- **Never-log list** for addresses or whole domains that must not reach the CRM

## Requirements

- Thunderbird 115 or later
- A HubSpot account where you can create a private app (portal admin rights)

## Install

**From a release:** download the `.xpi`, then in Thunderbird go to
**Add-ons and Themes → gear icon → Install Add-on From File**.

**From source:**

```sh
git clone https://github.com/hughsheehy/hubspot-for-thunderbird
cd hubspot-for-thunderbird
./build.sh          # produces dist/hubspot-for-thunderbird-<version>.xpi
```

For development, use **Add-ons and Themes → gear → Debug Add-ons → Load Temporary
Add-on** and pick `manifest.json`. Temporary add-ons are removed on restart.

Thunderbird requires extensions to be signed on release builds. An unsigned build
installs on Daily and Beta, or on release after setting
`xpinstall.signatures.required` to `false` in the Config Editor — do that only if
you understand what it turns off. A signed build from addons.thunderbird.net
needs no such change.

## Setup

The add-on opens its settings page on first install. It walks you through
getting a HubSpot access token; the short version:

1. **New to this:** HubSpot → **Development → Keys → Service keys → Create
   service key**. This is HubSpot's current recommendation for a simple
   read/write integration like this one, and it's in public beta — you need
   to be a super admin or have the "Developer tools access" permission.
   **Already have a private app?** Settings → Integrations → Private Apps
   still works exactly the same way; use its token below instead of creating
   a new key.
2. Add only the scopes below for the features you want:

   | Scope | Needed for |
   |---|---|
   | `crm.objects.contacts.read` | looking anyone up, and calls/meetings/notes in Recent activity — required |
   | `crm.objects.contacts.write` | the "Create contact" button |
   | `crm.objects.deals.read` | showing deals |
   | `crm.objects.owners.read` | showing the record owner |
   | `sales-email-read` | logging messages, and emails in Recent activity |

   There's no separate scope for calls, meetings, or notes — despite the
   `crm.objects.<type>.read` naming pattern used for deals, HubSpot gates
   those three engagement APIs behind `crm.objects.contacts.read` itself (see
   their [calls](https://developers.hubspot.com/docs/api-reference/crm-calls-v3/guide),
   [meetings](https://developers.hubspot.com/docs/api-reference/crm-meetings-v3/guide), and
   [notes](https://developers.hubspot.com/docs/api-reference/crm-notes-v3/guide)
   API references) — you already have what you need. Only the email part of
   Recent activity needs the separate `sales-email-read` scope above; skip it
   and emails are silently left out of the panel rather than breaking the
   rest of it.

3. Copy the token into the add-on settings and press **Test connection**.

Optionally add your portal ID (for "Open in HubSpot" links) and your HubSpot
logging BCC address (Settings → Objects → Activities → **Email Log & Track**
tab → **Manual Logging** → **BCC Address** → Copy — it's a personal address
unique to you, format `xxxxxxx@bcc.hubspot.com`, available on every HubSpot
plan). This is unrelated to your API token — it's HubSpot's separate,
mail-based logging pipeline, only needed for the compose panel's "Add logging
BCC" button.

**Don't use a HubSpot "personal access key."** That's a separate credential
for the HubSpot CLI (local development / deploying CMS projects) — it's
capped at one per user per account and inherits that user's own permissions
rather than a scope list you choose. It's not meant to be embedded in a
client like this one.

Service Keys and private app tokens both look like `pat-na1-...` and
authenticate the same way (`Authorization: Bearer <token>`), so either one
works here with no other change — `background.js` doesn't care which kind of
token it was given.

### Why an access token and not "Sign in with HubSpot"

HubSpot's OAuth requires a client secret at token exchange and does not support
PKCE for general CRM APIs. A secret shipped inside an extension is readable by
anyone who unzips it, so a one-click OAuth button would require this project to
run a server that holds the secret and brokers every user's tokens. A Service
Key or private app token avoids that entirely: your credential is yours,
scoped by you, revocable by you, and no third party ever sees it.

## Privacy

No analytics, no telemetry, no third-party servers. See [PRIVACY.md](PRIVACY.md).

## Limitations

- Lookup is an exact match on the contact's `email` property; mail from a
  secondary address will not resolve
- Logging does not deduplicate — pressing the button twice logs twice
- Attachments are not uploaded with a logged message
- Logs against the contact only, not a specific deal or ticket
- No open or click tracking; that needs HubSpot's own send infrastructure
- No templates, sequences, or snippets in the compose window
- Deal amounts are formatted with one currency for all deals, set in settings
- Recent activity shows the last 5 items across emails/calls/meetings/notes,
  merged client-side from up to 20 of each type per contact. HubSpot's
  associations-listing endpoint isn't sorted by recency, so a contact with
  more than ~20 of one engagement type could in theory have a newer item
  excluded from the merge

## Development

```
manifest.json          permissions, entry points
background.js          HubSpot client, cache, message router
popup/                 message panel + shared helpers and styles
compose/                compose window panel
options/                setup and settings
_locales/en/            all user-facing strings
```

All network access is in `background.js`; panels talk to it over
`runtime.sendMessage` and never hold the token. Lookups are cached in memory for
five minutes and cleared whenever settings change.

Strings live in `_locales/en/messages.json`. To add a language, copy that folder
to `_locales/<code>/` and translate the `message` values.

Run the dependency-free test suite with Node.js 18 or later:

```sh
npm test
```

The tests execute the background scripts with mocked Thunderbird APIs, so they
do not need a Thunderbird profile or HubSpot account.

### Notes on the HubSpot API calls made here

- Contact lookup: `POST /crm/v3/objects/contacts/search`, exact match on `email`.
- Deals: `GET /crm/v3/objects/contacts/{id}/associations/deals`, then
  `POST /crm/v3/objects/deals/batch/read`.
- Owner: `GET /crm/v3/owners/{id}`.
- Recent activity: the same associations + batch/read pattern as deals, run
  once per engagement type (`emails`, `calls`, `meetings`, `notes`) against
  `/crm/v3/objects/contacts/{id}/associations/{type}` and
  `/crm/v3/objects/{type}/batch/read`, then merged and sorted by
  `hs_timestamp` client-side. Calls, meetings, and notes ride on
  `crm.objects.contacts.read`; only emails need the separate
  `sales-email-read` scope. Each type still fails independently if a scope
  is missing, so partial results render rather than an error.
- Logging: `POST /crm/v3/objects/emails` with an association to the contact
  (`associationCategory: HUBSPOT_DEFINED`, `associationTypeId: 198`, HubSpot's
  default "email to contact" type). If HubSpot ever changes their default
  association type IDs, the current one can be confirmed against
  `GET /crm/v4/associations/emails/contacts/labels`.

## Contributing

Issues and pull requests welcome. Please keep the no-telemetry rule and the
"all network calls in the background script" structure intact — both are things
reviewers and users check for.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by HubSpot, Inc. or MZLA Technologies.
