# Mark a New Relic issue as investigating (1.7.1)

Version 1.7.1 fixes the 1.7.0 deployment error: the organization setting's
58-character display name exceeded DevRev's 50-character limit. The setting is
now **Mark as investigating after GitHub handoff** (42 characters); its internal
name and behavior are unchanged. If deployment reports this manifest parse
error followed by missing-version-ID errors, the parse error is the cause:
version creation was rejected. Pull this patch before retrying.

Enable **Mark as investigating after GitHub handoff** in the
snap-in's organization configuration to report the next step after acknowledgment.
This optional boolean (`investigate_on_github_issue`) defaults to false.

The lifecycle becomes:

1. **User starts analysis or triage:** optional acknowledgment through the existing
   setting (both individual Analyze buttons are included from 1.7.2).
2. **GitHub issue confirmed:** optional native New Relic investigation update.
3. **Coding/deployment/recovery:** unchanged; this release does not resolve alerts
   or infer a fix from a GitHub issue, assignment, PR or closed alert.

## Trigger and connection

Both **Create GitHub issue** and **Triage and start fix** support the setting.
The update runs after the agent's final callback validates a created or existing
GitHub issue result and publishes the durable winning result in DevRev. It does
not run merely because a button was clicked or an issue request was queued.
For combined triage, a valid partial result that reached GitHub but stopped at
coding still qualifies; a partial result stopped at GitHub does not. There is no
intermediate GitHub-tool event: combined triage waits for the agent callback,
which may arrive after it has also attempted the coding handoff.

Reuse the initiating user's existing personal **New Relic context connection**.
Its owner needs permission to manage the source alert issues. New Relic attributes
the update to that key's owner. No additional key, ingest key, MCP setup or
Advanced Compute analysis tool is required. AG-6 and AG-7 instructions stay the
same; the connector handles this status update.

The request must have opted in when it started, and the setting must still be
enabled when its callback arrives. Enabling it later does not affect older
requests. Disabling it prevents remaining callbacks from starting the update.

## Credential handling and callback binding

At request time, the connector saves only the initiating actor ID, installation,
source URL, imported AirSync record ID and creation date in a bot-owned private
request record. Agent callback metadata carries an opt-in flag and record ID;
it does not contain the actor ID or API key. The private record must match the
current request, issue, bot and source before credential lookup.

After the winning GitHub result is published, the callback fetches the initiating
user's current `newrelic_context` resource from this installation through DevRev.
It ignores credentials or user IDs suggested by an agent reply. Neither the
New Relic API key nor the original DevRev actor session token is persisted for
callbacks or sent as agent evidence. Missing, expired or inaccessible connections
produce a separate failure report and preserve the GitHub result.

## New Relic operation and verification

The mutation was identified from New Relic's **Mark as investigating** UI request:

```graphql
mutation markAsInvestigate($accountId: Int!, $issueId: ID!) {
  aiIssuesMarkAsInvestigating(accountId: $accountId, issueId: $issueId) {
    result { accountId action issueId }
    error
  }
}
```

This operation was not located in the public mutation tutorial during research;
the source of the contract is the captured UI operation. The connector uses its
existing regional NerdGraph endpoint, user key and `AiIssues` experimental header.
Availability with a user key and account permissions must be verified after
upgrade. It does not call a browser-only endpoint or send browser cookies.

The client reads `investigatedAt` before sending a mutation and skips closed or
already-investigating source issues. Acknowledgment alone does not skip this
step. It validates UUID/account/date inputs and reports investigation only when
a subsequent query of the originally requested source confirms a positive
investigation timestamp. It accepts safe numeric or canonical decimal-string
timestamps and does not assume an undocumented `result.action` enum value.

Lost/unexpected mutation responses are reconciled with at most three reads,
with 500 ms and 1,500 ms delays. The mutation is not automatically repeated.
Explicit mutation errors remain failures. If verification cannot confirm the
state, the report stays unconfirmed and includes a fixed diagnostic code.

## Reporting, retries and limits

The GitHub result/incident brief remains in its original discussion comment.
The New Relic status gets a separate **New Relic investigation status** entry.
Its outcome is saved privately before that entry is published. Duplicate
callbacks and retries of a failed report reuse the outcome without looking up
the key or repeating the New Relic update. A New Relic failure does not hide or
replace the GitHub result.

Requests retain the existing 30-minute callback lifetime. Independent concurrent
first deliveries, new clicks, and other installations can still race between
the read and write; this is not a global incident lock or exactly-once guarantee.
A process failure before an outcome is persisted can require checking source
state again on delivery retry. Source-state checks prevent ordinary repeated
updates, but no mutation retry loop is added.

Logs contain fixed `[newrelic-context] investigation:...` messages and diagnostic
codes. They do not include credentials, actor IDs or raw API payloads. API tests
use mocked responses; the captured UI mutation must be verified against your
account rather than treated as a guaranteed public API contract.

## Upgrade and verify

After merging, pull and upgrade the existing installation from `code/`:

```bash
git pull --ff-only origin main
npm run upgrade -- '<current-snap-in-version-DON>'
```

Enable **Mark as investigating after GitHub handoff** in the
organization configuration, then save. Keep your existing personal connection.
On an imported open New Relic issue, run **Create GitHub issue** after analysis
or **Triage and start fix**. Confirm the GitHub link appears, followed by a
separate investigation status comment, and check New Relic for the native state.
Repeat with an existing GitHub issue to verify reuse. A source issue that is
already investigating or closed should be reported without another mutation.
Check the diagnostic code if the update cannot be confirmed; older discussion
comments are not rewritten by an upgrade.
