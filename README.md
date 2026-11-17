# New Relic AirSync connector for DevRev

Imports New Relic alert issues into DevRev through `@devrev/airsync-sdk` 2.0.0.
Each accessible New Relic account appears as a selectable external sync unit.
This initial implementation supports **import only**.

## Connection

Create a New Relic **user API key** with access to the accounts you want to import.
Ingest/license keys cannot query NerdGraph.

When creating the DevRev connection, enter:

| Field | Value |
| --- | --- |
| User API key | Your New Relic user API key |
| Subdomain, US region | `api` |
| Subdomain, EU region | `api.eu` |

The keyring verifies the credential against the authenticated regional REST
`/v2/applications.json` endpoint. Import discovery then checks NerdGraph account
access. The connector sends the key only to the fixed regional NerdGraph endpoint;
it disables redirects and strips Axios request details from reported errors.

## Imported data

| New Relic | DevRev |
| --- | --- |
| Account | External sync unit |
| Alert issue | Issue |
| Title(s) | Title |
| Description, source state/priority, entity names | Body |
| `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` | `P0`, `P1`, `P2`, `P3` |
| `CLOSED` | `completed` stage |
| Other states | `in_development` stage |
| Issue ID and regional New Relic host | External item URL and “Open in New Relic” link in the issue body |
| Created/updated timestamps | Created/modified dates |

IDs include both the account ID and source issue ID. No owners or creators are
fabricated from source data. The initial domain mapping asks the installer to
select an applicable DevRev product, one or more DevRev issue owners, and a
DevRev user for **Created by**. The alert payload used by this connector does not
provide a human creator or owner. Selected DevRev users provide issue ownership
and explicit attribution for these automated records. Missing priorities fall back to P2; missing states
fall back to the `in_development` stage. Review these defaults and the priority
and stage mappings for your workspace before starting an import.

If an import reports "Failed to map the creator ... using the default user as a
fallback", the issue was imported with DevRev's default creator. Select a DevRev
user in the import's **Created by** mapping to provide explicit attribution;
this does not identify a human who created the alert in New Relic. The creator
picker uses one DevRev user, separately from the collection of issue owners.

Updated bundled mappings do not automatically rewrite an existing import's
selected recipe or existing issue creators. Review the existing import's mapping
choices after upgrading the snap-in, and validate creator attribution on newly
imported issues. A fresh test import is another way to verify the new defaults.

## Extraction and limits

- Initial imports request the previous **30 days**, subject to New Relic retention
  and API access limits. This connector does not promise full historical import.
- Subsequent runs use AirSync's `extract_from`, overlapping by one minute. If it is
  absent, the connector requests the previous 30 days again with stable IDs.
- Each invocation processes one NerdGraph page. The cursor and frozen start/end
  window survive continuations within the same `run_id`. A new run resets
  completion, cursor and time bounds, including state from older installations.
  Completed extractions in the same run and excluded record types are skipped.
  A cursor advances only after the page is accepted by the SDK repo.
- During issue extraction, HTTP 429, server/network failures and GraphQL
  throttling return an AirSync delay result. Account discovery is non-resumable
  in SDK 2.0.0, so it retries transient failures inside the worker instead:
  at most three attempts within four minutes, honoring the requested delay and
  stopping on an SDK timeout. Delays that exceed this budget fail with retry
  guidance. Other GraphQL errors fail the phase, including partial responses,
  so an inaccessible account is not silently imported as empty.
- The AiIssues API requires the experimental opt-in header. Its schema can change.
- Users, raw telemetry, entity inventory, dashboards, attachments, deletion
  propagation and write-back are outside this initial implementation. Unexpected
  loading events explicitly fail instead of reporting simulated success.

API references: [New Relic issue queries](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github/)
and [DevRev connection configuration](https://developer.devrev.ai/airsync/authentication).

## Development

Install Node.js 20 or newer, then:

```sh
cd code
npm ci
npm run build
npm run lint
npm test -- --runInBand
```

Tests use mocked API responses and cover regional authentication, account
selection, pagination, per-run state resets and continuations, bounded discovery
retries, extraction delays, partial errors, credential-safe error messages,
regional links and import-only metadata.

For local development, copy `code/.env.example` to `code/.env`, set the DevRev
organization/email and `NEW_RELIC_API_KEY`, and use the fixtures under
`code/fixtures`. Replace the fixture account ID `1234567` with an account you can
access. Fixture placeholders are resolved by the local test runner; they are not
runtime environment variables used by the deployed connector. The connector
reads credentials from AirSync's `connection_data`.

## Deployment and live validation

Install the [DevRev CLI](https://developer.devrev.ai/snapin-development/references/cli-install),
`jq`, and `ngrok` if using local deployment. From `code`, run `npm run deploy` and
choose local or Lambda deployment. The script prompts for your DevRev organization
slug and email, authenticates, builds the version and activates the snap-in.
You can set the prompt defaults in `code/.env`:

```ini
DEV_ORG=your-org-slug
USER_EMAIL=you@example.com
ENV=prod
```

The current public DevRev CLI targets production and does not accept `--env`.
The scripts check the installed CLI's help and pass an environment flag only
when supported. A non-production `ENV` with a CLI that has no environment
selector fails before deployment. To authenticate manually with the public CLI:

```sh
devrev profiles authenticate --org your-org-slug --usr you@example.com
```

See the [DevRev authentication guide](https://developer.devrev.ai/snapin-development/tutorials/getting-started).
After installing the snap-in, open DevRev AirSync, create the regional connection,
select an account and import.

For **GitHub Codespaces or CI**, provide a DevRev PAT as the `DEVREV_TOKEN`
environment variable (for example, a Codespaces secret). This is separate from
the New Relic user API key. Alternatively, import a PAT into the CLI profile with
`devrev profiles set-token --org your-org-slug --usr you@example.com` (the command
reads the token from stdin). Create the PAT in the target DevRev organization
under Settings > Account > Personal Access Token.

Deployment and cleanup import an explicit `DEVREV_TOKEN` into the selected
profile via stdin, then validate access with a read-only snap-in package query.
They never fall back to browser login when that explicit token fails. Some CLI
versions report manually imported PAT expiry as `0001-01-01 00:00:00 +0000 UTC`;
the scripts validate the saved token with the same read-only query rather than
assuming the zero timestamp means expired. If no usable token exists in
Codespaces, the scripts stop with instructions instead of opening a terminal
browser. Tokens are not printed or passed as command-line arguments.

Before production use, validate with a test account:

1. Confirm the keyring accepts a valid user key and rejects an invalid key.
2. Confirm account discovery lists only accounts available to that user.
3. Import known open and closed issues and inspect links, priority and stage.
4. Exercise a multi-page import and a subsequent sync after an issue changes.
5. Confirm US/EU deployment behavior and workspace mapping compatibility.

Live New Relic/DevRev validation requires credentials and is not covered by the
mocked test suite. No deployment is performed by the tests.
