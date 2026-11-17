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
| Source deep link | External item URL |
| Created/updated timestamps | Created/modified dates |

IDs include both the account ID and source issue ID. No owners or creators are
fabricated. The initial domain mapping asks the installer to select an applicable
DevRev product. Review the priority and stage mappings for your workspace before
starting an import.

## Extraction and limits

- Initial imports request the previous **30 days**, subject to New Relic retention
  and API access limits. This connector does not promise full historical import.
- Subsequent runs use AirSync's `extract_from`, overlapping by one minute. If it is
  absent, the connector requests the previous 30 days again with stable IDs.
- Each invocation processes one NerdGraph page. The cursor and frozen start/end
  window survive continuations. Completed extractions and excluded record types
  are skipped. A cursor advances only after the page is accepted by the SDK repo.
- HTTP 429, server/network failures and GraphQL throttling return a delayed
  extraction result. Other GraphQL errors fail the phase, including partial
  responses, so an inaccessible account is not silently imported as empty.
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
selection, pagination and continuation state, retry delays, partial errors,
credential-safe error messages, normalization and import-only metadata.

For local development, copy `code/.env.example` to `code/.env`, set the DevRev
organization/email and `NEW_RELIC_API_KEY`, and use the fixtures under
`code/fixtures`. Replace the fixture account ID `1234567` with an account you can
access. Fixture placeholders are resolved by the local test runner; they are not
runtime environment variables used by the deployed connector. The connector
reads credentials from AirSync's `connection_data`.

## Deployment and live validation

Install the [DevRev CLI](https://developer.devrev.ai/snapin-development/references/cli-install),
`jq`, and `ngrok` if using local deployment. From `code`, run `npm run deploy` and
choose local or Lambda deployment. After installing the snap-in, open DevRev
AirSync, create the regional connection, select an account and import.

Before production use, validate with a test account:

1. Confirm the keyring accepts a valid user key and rejects an invalid key.
2. Confirm account discovery lists only accounts available to that user.
3. Import known open and closed issues and inspect links, priority and stage.
4. Exercise a multi-page import and a subsequent sync after an issue changes.
5. Confirm US/EU deployment behavior and workspace mapping compatibility.

Live New Relic/DevRev validation requires credentials and is not covered by the
mocked test suite. No deployment is performed by the tests.
