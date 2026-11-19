# Report acknowledgment to New Relic (1.6.0)

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

To include acknowledgment in the combined workflow, open the snap-in's
organization configuration, enable **Acknowledge in New Relic when triage starts**
(`acknowledge_on_triage`), and save. This optional boolean defaults to false;
upgrading alone does not start writing to New Relic. When enabled,
**Triage and start fix** attempts acknowledgment after its configuration and issue
access checks, before gathering evidence and starting the GitHub agent.
Individual analysis, evidence, GitHub and coding actions do not acknowledge.

The acknowledgment outcome gets a separate internal discussion entry so a later
agent callback cannot replace it. Rejection, uncertain completion, or failure
to post that entry does not prevent the combined analysis/GitHub workflow. If
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
identifiers. It then reads the source again and requires a positive
`acknowledgedAt` timestamp before reporting verified acknowledgment. A failed
read-back or lost mutation response is reported as **unconfirmed**; it may have
taken effect. Inspect the source before retrying. A deliberate retry reads the
current source state first rather than automatically replaying the write.

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
