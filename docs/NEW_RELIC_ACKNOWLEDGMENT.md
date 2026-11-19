# Report acknowledgment to New Relic (1.7.2)

The issue component provides **Acknowledge in New Relic**. It acknowledges the
original New Relic Alert Intelligence issue through NerdGraph and posts the
outcome to the DevRev issue's internal discussion. It does not call a DevRev
agent or require New Relic MCP or Advanced Compute analysis tools.

## Existing connection and permissions

Reuse the personal **New Relic context connection** (`newrelic_context`) already
used to fetch triage telemetry. No additional connection or API key is needed.
The New Relic user who owns that key must be allowed to query and manage alert
issues in the source account. Query access alone may not permit acknowledgment.
New Relic attributes the acknowledgment to that credential's identity; this may
differ from the DevRev user who clicked the button.

The region comes from the validated source alert link: US and EU use their
respective allowlisted NerdGraph endpoints. The DevRev issue is read as the
clicking user, and the imported record ID must match its source link before any
New Relic write. The result comment is internal and created as that user.

## Upgrade and configure

After merging, pull the changes and upgrade the existing installation from
`code/` (keep its existing AirSync and personal connection):

```bash
git pull --ff-only origin main
npm run upgrade -- '<current-snap-in-version-DON>'
```

Refresh the DevRev issue and open **New Relic incident triage**. Click
**Acknowledge in New Relic** to use the standalone action. It needs the existing
personal connection and issue access, but no analysis/GitHub agent configuration.

To include acknowledgment when analysis starts, open the snap-in's
organization configuration, enable **Acknowledge New Relic when analysis starts**
(`acknowledge_on_triage`), and save. This optional boolean defaults to false;
upgrading alone does not enable the setting. In version 1.7.2, when enabled,
**Analyze incident**, **Analyze latest 30 minutes**, and **Triage and start fix**
attempt acknowledgment after their configuration and issue access checks, before
gathering evidence and starting their agent. The internal input name is retained
for upgrade compatibility. Existing true values now also apply to the individual
Analyze buttons. Evidence, GitHub and coding actions do not request the
acknowledgment mutation. The separately enabled investigation callback can still
mark New Relic as investigating after a validated GitHub result.

Syncing an alert and opening its issue/component never request acknowledgment.
The AirSync HTTP client also explicitly rejects lifecycle mutations. Importing
an old New Relic alert preserves any acknowledgment it already had; it does not
clear it. Compare the source alert's UUID and acknowledgment timestamp with the
DevRev issue's import time when determining whether an acknowledgment was new.
The connector never automatically unacknowledges an imported alert.

User-triggered acknowledgment logs include a fixed action value, for example
`[newrelic-context] acknowledgment:requested action=alert` for Analyze incident,
`action=recent` for the latest window, `action=triage` for the combined action,
or `action=acknowledge` for the standalone button. The separate outcome
`acknowledgment:already_acknowledged` means this invocation sent no acknowledgment.

The acknowledgment outcome gets a separate internal discussion entry so a later
agent callback cannot replace it. Rejection, uncertain completion, or failure
to post that entry does not prevent individual analysis or the combined GitHub workflow. If
the entry cannot be posted, the action response includes that reporting failure
and logs contain `[newrelic-context] acknowledgment:report_failed`. A triage
configuration, source-read or agent-start failure can still stop triage normally.
No AG-6 or AG-7 instruction changes are needed for acknowledgment.

## Verification and retry behavior

The connector reads the source issue before writing. A closed or already
acknowledged issue is reported without another mutation. New writes require a
UUID issue identifier, a valid account, and a recognized open issue state.

For `aiIssuesAckIssue`, an HTTP success is insufficient. The connector checks the
mutation's own `error`, the returned `ACK` action, and the exact account/issue
identifiers. A business-logic error is rejected. If a response is lost or its
receipt is unexpected, version 1.6.1 reconciles by reading the originally
requested source account/UUID; it never switches to identifiers from the receipt
or infers success from that receipt. It requires a positive
`acknowledgedAt` timestamp before reporting verified acknowledgment. Numeric
timestamps and canonical decimal strings are accepted; dates, booleans and
unsafe numbers are not coerced into acknowledgment.

Version 1.6.1 checks the source up to three times after an accepted or uncertain
mutation, with 500 ms and 1,500 ms delays before the second and third reads. This allows
the issue-query results time to reflect the write. Only read-back is retried;
the mutation is still sent at most once per invocation. If source verification
cannot confirm the acknowledgment, the outcome remains **unconfirmed**. Inspect the source before
retrying. A deliberate retry reads the current source state first rather than
automatically replaying the write.

Failure comments and logs now include a fixed diagnostic code, without raw
response data. Important distinctions:

- `source_read_failed`: the initial source lookup failed; no mutation was sent.
- `mutation_request_failed`: the mutation request could not be confirmed.
- `mutation_rejected`: the mutation returned a business-logic error.
- `receipt_*`: the mutation receipt was missing or did not match the expected
  action/account/issue, and source-state verification did not confirm acknowledgment.
  Do not assume the write failed; inspect New Relic.
- `read_back_pending`: New Relic accepted the write but none of the three reads
  showed the acknowledgment timestamp yet. The comment explicitly distinguishes
  this from missing connection permissions.
- `read_back_failed`: New Relic accepted the write but the final verification
  query failed.

If the source already shows **Acknowledged by ...** while DevRev says unconfirmed,
the acknowledgment may have succeeded and only confirmation failed. After
upgrading, share the diagnostic code instead of credentials or API payloads:

```bash
devrev snap_in_package logs --query newrelic-context --limit 100 --org '<org>' --usr '<email>'
```

Look for `[newrelic-context] acknowledgment:diagnostic code=...`. If an uncertain
receipt was successfully reconciled, logs instead include
`[newrelic-context] acknowledgment:reconciled code=...` followed by the confirmed
outcome. The command requires DevRev CLI 0.4.16 or newer.
Older discussion comments are historical;
upgrading does not rewrite their outcomes.

Repeated deliveries of the same click use the same discussion external reference.
Independent concurrent clicks can race between the source read and mutation;
this is not an exactly-once write guarantee or a global incident lock. There is
no automatic mutation retry, unacknowledgment, or background callback using a
saved user credential. API keys, actor tokens, raw responses and error payloads
are never persisted in acknowledgment comments or logged.

After upgrading, test against an open source issue you intend to acknowledge:

1. Click the standalone button and confirm both New Relic's acknowledgment and
   the verified DevRev internal comment.
2. Click again and confirm the already-acknowledged outcome.
3. Enable the organization setting and run combined triage. Confirm the separate
   acknowledgment entry plus the normal incident brief and GitHub/coding result.
4. With a query-only connection in a test setup, confirm the acknowledgment is
   rejected or unconfirmed while combined triage can still analyze and hand off.

Automated tests use mocked APIs; live New Relic permissions and writes must be
verified in your org. The connector does not mark an issue fixed, resolve it,
send progress events, or watch deployments in this release. Closed state alone
is not proof of service recovery.

## API references

- [NerdGraph issue model and mutations](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github/)
- [New Relic acknowledgment action and mutation response](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/newrelic/issue/newrelic-issue-acknowledge/)

The existing client sends the documented `nerd-graph-unsafe-experimental-opt-in:
AiIssues` header. New Relic documents that this schema is experimental and subject
to breaking changes.
