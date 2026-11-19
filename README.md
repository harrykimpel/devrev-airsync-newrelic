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
| Account/issue ID and regional New Relic host | Issue permalink and “Open in New Relic” link in the issue body |
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

### Alert permalinks

Links use the New Relic Issues launcher with a URL-encoded, base64 pane containing
`isPhoton: true`, the exact issue ID and `nerdletId: nrai.issue-redirect`, plus the
account ID. The host follows the connection region (`one.newrelic.com` or
`one.eu.newrelic.com`). `/redirect/issue/...` is not a supported issue route and
can fall through to the entity catalog. The launcher format is also used by
[Port's New Relic issue integration](https://docs.port.io/context-lake/ingestion/ingest-data-into-port/native-integrations/available-integrations/apm-alerting/newrelic/).

Re-sync source issues with the updated extractor to replace stored links. An
incremental sync only refreshes records returned by New Relic; unchanged older
records may need a historical re-sync. The context action also understands the
old link format and posts a corrected link in its result comment.

The extracted `body` is a rich-text array (`["Markdown content"]`), as required
by the external metadata. A bare string causes AirSync's transformer to reject
and redact the field. After upgrading this normalization fix, re-sync affected
source records to restore descriptions and visible links. Upgrading the snap-in
alone does not rewrite bodies already imported; unchanged records may need a
historical re-sync. See the [normalized rich-text contract](https://developer.devrev.ai/airsync/data-model/rich-text-fields).

## New Relic logo

Official New Relic emblem files are included in [assets/newrelic](assets/newrelic).
See [branding configuration](docs/BRANDING.md) for the marketplace icon workflow
and the limits of changing the icon on a direct CLI installation. Adding an image
to the repository or redeploying alone does not change DevRev's displayed icon.

## New Relic incident triage on an issue

Open an imported issue and find the **New Relic incident triage** component:

- **Triage and start fix** analyzes both telemetry windows, creates or reuses the
  GitHub issue, and assigns Copilot in one user-authorized GitHub-agent session.
  The combined brief and validated links appear in the internal discussion.
  [Republish AG-7 with the combined instructions before use](docs/TRIAGE.md).
- **Analyze incident** compares the alert window (creation ±15 minutes,
  clipped to now) with the latest 30 minutes and asks the configured DevRev agent
  for an incident brief focused on the alert.
- **Analyze latest 30 minutes** collects the same two windows, focusing the
  brief on current conditions.
- **Fetch alert evidence** and **Fetch latest evidence** post bounded raw query
  results for their respective window without invoking an agent.
- **Create GitHub issue** invokes a separate GitHub MCP agent on demand using
  the latest completed analysis. It posts the agent's GitHub issue link back to
  the internal discussion. It does not fetch telemetry again or run automatically.
- **Start coding agent** asks the GitHub agent to assign the issue to Copilot,
  which implements a proposed fix and creates its PR. The result is added to the
  internal discussion; an assignment alone is not reported as a completed fix.
- **Check coding progress** asks the agent to read the assignment and linked PR
  state. It posts the PR link when available and never starts another coding run.
- **Acknowledge in New Relic** acknowledges the source alert using your existing
  personal New Relic connection and posts the verified outcome internally. It
  does not invoke an agent or require a separate key. To include this step in
  **Analyze incident**, **Analyze latest 30 minutes**, and **Triage and start fix**,
  enable **Acknowledge New Relic when analysis starts**
  in the snap-in's organization configuration (off by default). Acknowledgment
  failures do not stop analysis or the combined workflow. See the
  [acknowledgment setup and verification guide](docs/NEW_RELIC_ACKNOWLEDGMENT.md).

Version 1.7.0 can also mark the source New Relic issue as **investigating** after
the GitHub agent confirms a created or existing issue. Enable **Mark as
investigating after GitHub handoff** in the snap-in's organization
configuration (off by default). It works with **Create GitHub issue** and
**Triage and start fix**, using the initiating user's saved New Relic connection.
The GitHub result is published first; the New Relic status is reported separately.
No additional key, ingest license key, MCP connection or agent instruction change
is needed. See the [investigation status guide](docs/NEW_RELIC_INVESTIGATION.md).

Version 1.7.1 shortens this setting's label to meet DevRev's 50-character input
display-name limit, fixing the manifest parse error during deployment.

Version 1.7.2 includes both individual Analyze buttons in optional acknowledgment
(the internal setting remains `acknowledge_on_triage`). AirSync clients reject
lifecycle mutations, and opening the issue/component remains read-only. Importing
an older alert preserves its existing New Relic acknowledgment; it does not reset
it. A new DevRev issue therefore does not necessarily represent a new source alert.

Version 1.6.1 improves acknowledgment confirmation with bounded read-only retries
and diagnostic codes for source lookup, mutation receipt and read-back failures.
It reconciles uncertain mutation responses against the exact source issue and
accepts safely encoded decimal-string acknowledgment timestamps.
Version 1.6.0 adds acknowledgment through NerdGraph. The connection owner needs
permission to manage alert issues in addition to query access. No New Relic MCP
or Advanced Compute analysis tools are used. The action does not resolve alerts,
report engineering progress to New Relic, or establish recovery.

Version 1.5.0 adds the combined action and the incident-triage wording. The
individual analysis buttons still invoke the Incident Analyst; the combined mode
has AG-7 analyze the same bounded evidence with the same instructions before it
uses its GitHub tools. This avoids storing a user session token between agent
callbacks. It reuses GitHub issue agent ID, repository/provider/base-branch inputs,
existing connections and permissions. Coding agent ID is used by the individual
coding actions; AG-7 needs its own assignment/PR read capabilities for combined
mode. Structured partial results retain the brief and any verified issue link.
Actual MCP step order and reuse behavior require verification in the agent trace.

For version 1.4.0, follow the [coding agent setup and upgrade guide](docs/CODING_AGENT.md).
The coding actions reuse the **GitHub issue agent ID** by default (AG-7 in the
example org). Republish that agent with the updated instructions and GitHub
assignment/PR read tools. **Coding agent ID** can instead select a separate DevRev
coordinator. **Coding agent provider** defaults to `copilot`; unsupported values
fail explicitly. **Coding agent base branch** is optional and otherwise uses the
GitHub repository default. Adding another provider requires an adapter and its
MCP instructions, rather than merely entering a new name.

The connector selects the latest completed, bot-owned GitHub issue result among
the last 100 internal discussion entries and validates its repository, URL and
number before dispatch. Coding does not require another New Relic query or key.
Start requests reuse a stable reservation for this installation, coordinator,
provider and GitHub issue, including after an uncertain response. Check progress
to inspect an unknown outcome. Status updates are on demand; GitHub completion
does not automatically trigger a DevRev comment. The coordinator must check
existing assignments/PRs before assigning, since GitHub writes and searches are
not atomic. The callback validates the agent's structured report and routing,
not its MCP execution trace. Human review and merge happen on GitHub.

For the GitHub agent, use the ready-to-paste goal, instructions and MCP tool
configuration in [GitHub issue agent setup](docs/GITHUB_ISSUE_AGENT.md). Set the
optional **GitHub issue agent ID** and **GitHub issue repository** organization
inputs after publishing that agent. Its GitHub connection needs issue search,
read and create access in the selected repository. The connector sends only the
latest completed internal brief from the current bot among the last 100 entries,
plus source IDs, a New Relic link and a stable incident marker. Pending/failed
analyses, raw evidence and other users' lookalike comments are not selected.

GitHub result callbacks reuse the existing DevRev event source and bot permission.
They additionally check the selected repository and source analysis binding.
Only a structured `created`/`existing` report with a matching issue number and
HTTPS GitHub issue URL in that repository becomes a linked result. This validates
the agent's report; real tool execution and search-first duplicate avoidance must
be verified in the target agent/MCP setup. Search and create are not atomic.
The parser accepts prose/code fences around one JSON object and Markdown links
in its URL field, then validates the link destination. Arrays, incomplete outer
containers, ambiguous multiple reports and mismatched repositories or issue
numbers are rejected.

For analysis, follow the [New Relic Incident Analyst setup guide](docs/NEW_RELIC_INCIDENT_ANALYST.md)
for the copy-paste goal, instructions, Playground checks and connector settings.
Create and publish an internal agent in **Settings → Agent Studio**.
Give it instructions to summarize supplied evidence, distinguish facts from
hypotheses, acknowledge missing/sampled data, and recommend investigation steps.
The agent receives the issue title, source alert link, alert state and scrubbed,
bounded telemetry. It does not need a New Relic connection or comment-writing
skill: the connector handles collection and posting. Runbooks can be added as
optional agent knowledge.

In **Settings → Integrations → Snap-ins → New Relic → Configure**, set
**Incident analysis agent ID** to the agent's full DON, for example
`don:core:dvrv-us-1:devo/your-org:ai_agent/6`. `AG-6` is a display ID and is not
accepted by this field. The agent must belong to the issue's organization. The
requesting user needs permission to invoke the published agent. Grant the new
optional **New Relic Bot `issue:read`** self scope for asynchronous comments,
in addition to the existing user impersonation permission for reading issues.
Analysis with a missing agent configuration fails explicitly; the evidence
buttons remain available. GitHub issue creation has its own separately configured
agent, and does not require the clicking user's New Relic key when reusing a brief.

The click first authorizes issue access as the user, collects both windows, and
creates a bot-owned internal "analysis requested" comment. It then invokes the
[DevRev asynchronous agent API](https://developer.devrev.ai/beta/api-reference/ai-agents/ai-agent-events-execute-async)
as the user with the issue as the session's access-control parent. Each logical
click gets its own session. The final `ai_agent_response` is routed to the
manifest-managed **New Relic analyst responses** event source and
`complete_newrelic_analysis` automation; no external callback server is needed.
The callback verifies the installation, configured agent, session correlation,
issue, comment reference, bot ownership, internal visibility and 30-minute
request lifetime before replacing the pending comment. It cannot post an
unsolicited comment on another issue. Progress events and repeated terminal
deliveries are ignored. Agent failures become a concise failure notice, with
evidence buttons available for investigation.

Starting in 1.4.1, a failed/timed-out start response leaves the request pending:
the asynchronous agent may already be running and can still return a verified
result. Callbacks persist an immutable private result record owned by the bot
using DevRev's unique timeline external reference. Concurrent callbacks and
update retries publish the same stored winner, so a late error cannot overwrite
a published successful result. The first persisted terminal result wins, which
can also be an agent failure. GitHub requests additionally persist their winning
source-brief binding privately before dispatch; the click's uniqueness key does
not depend on which brief was selected. These records introduce no new connection
or permission requirement. See the [review decisions](docs/COPILOT_REVIEW_FOLLOWUPS.md).

Version 1.4.2 stores the private source-binding record's actual ID in new GitHub
callback metadata. Record reads use that ID directly and provide a bounded,
validated private-list fallback for older external-reference lookups. Completion
stage markers and fixed record error codes/HTTP status help diagnose a GitHub
issue that exists while the discussion remains pending. See
[GitHub callback troubleshooting](docs/GITHUB_ISSUE_AGENT.md#github-issue-exists-but-the-discussion-stays-pending).

The agent prompt stays below 16,384 characters. Per-section samples and rows may
be further omitted or truncated for that budget; omissions and query failures
are included in the evidence. The response is labeled AI-generated, scrubbed for
common secrets, capped at 8,000 characters and linked to the source alert.
The prompt asks for a brief under 400 words and explicitly treats telemetry text
as untrusted data. The user-configured agent is responsible for following these
instructions; generated hypotheses require verification. No complete-trace,
baseline, recovery or root-cause conclusion is guaranteed by sampled data.

`analysis:requested` and `analysis:complete` are fixed log markers. Failures use
fixed codes such as `missing_analysis_agent`, `missing_analysis_context`,
`analysis_comment_failed`, `agent_start_failed` and `invalid_analysis_binding`.
Logs do not include prompts, messages, metadata, API errors or credentials.
If no terminal event arrives within 30 minutes, the pending notice remains and
instructs the user to retry or fetch evidence; DevRev currently does not promise
an error event for every workflow timeout. A new click requests a fresh analysis.

For an existing installation that already has `newrelic_context`, pull the
changes and run `npm run upgrade -- '<current-snap-in-version-id>'` from `code/`.
This analysis upgrade adds an optional organization input, event source,
automation, function and optional self scope; it adds no connections or required
scopes. Configure the agent ID and permissions after upgrading, then refresh the
issue so the buttons bind to the current installation. The existing AirSync and
user connection can be retained.

The component declares `initialize_newrelic_context` as its initializer. This
function returns the snap-kit controls when DevRev initializes the issue
component. Its response includes `snap_kit_body.snap_in_id` from the current
invocation and `snap_kit_body.snap_in_action_name: fetch_newrelic_context`, in
addition to the UI body. This binds the controls to the installed action; package
and version IDs must not be used as the installation ID. It does not query
telemetry or post comments; those actions run only
through `fetch_newrelic_context` after a button is clicked. A static
`snap_kit_body` alone does not satisfy the issue component's initialization flow.
For an installation that already has the context connection, apply this change
with `npm run upgrade -- '<current-snap-in-version-id>'` from `code/`, then refresh
the issue view. This initializer fix adds no connections or required scopes.

If opening the context window fails with `mongo: no documents in result`, the
message alone does not identify the missing record. Check the failing browser
Network request and the initializer invocation in the snap-in logs to distinguish
an initialization/action lookup failure from telemetry execution. Share only URL
paths and relevant IDs/action names, without authorization headers, cookies or
tokens. Refresh the issue after upgrading so it loads the current component.

The initializer now emits `[newrelic-context] initializer:start` and
`initializer:ready`; the telemetry action emits `fetch:start` and `fetch:complete`.
These markers contain only fixed stage strings, without event payloads, API keys,
tokens, issue bodies or telemetry. A start marker establishes that the function
was entered; a missing ready/complete marker helps locate an interrupted call.
Missing logs alone do not prove that a function was never invoked.

The action also logs fixed stage markers `fetch:validated`, `connection:lookup`
(when it needs to retrieve your saved user connection), `connection:ready`, and
`issue:loaded`. Failures log `fetch:failed code=…` using fixed codes such as
`missing_actor_token`, `missing_issue`, `connection_lookup_failed`,
`connection_missing`, or `connection_expired`. These distinguish invalid action
context from connection lookup failures without logging credentials, IDs, event
payloads or raw API errors. `request_failed` means a later operation failed; use
the preceding stage marker to locate it. A gateway response containing only
`debug_message: "{}"` does not expose the handler's actual error.

Use DevRev CLI **0.4.16 or newer** for runtime logs. Earlier clients can return
`501 FetchLogs is deprecated` from the retired logs endpoint. GitHub releases may
be newer than npm's `latest` tag. After opening the window, query the markers
with the newer binary, for example:

```sh
/tmp/devrev-0.4.16 snap_in_package logs --query newrelic-context --limit 50 --org '<org>' --usr '<email>'
```

The newer command does not accept the old `--all` flag. AirSync `transformer`
warnings about `body` describe import validation and do not establish the cause
of a `snap-components.initialize` database error.

Go to **Settings → Integrations → Snap-ins → New Relic → Configure → My Settings**.
Turn on **Enable for me**, select the connection under **Connections**, and save.
The connection description mentions your New Relic user key with access to the
source alert account. You can select an existing New Relic connection you can
access, with a **user API key** for the source account and region. AirSync's
`connection_data` is only delivered to extraction events; an issue action needs
this separate user connection selection. An **Active** connection selected under
**My Settings**, with **Enable for me** on, satisfies this configuration step;
do not recreate it solely because the telemetry action fails.

When DevRev does not inject the selected key into the action event, the handler
retrieves it using [`snap-ins.resources`](https://developer.devrev.ai/snapin-development/references/snap-in-resources)
for this installation and the clicking user's `payload.actor_id`. Only that
resource lookup uses the snap-in's service account, as required by DevRev.
Expired or missing user resources stop the action before any issue or telemetry
request. The handler accepts both `object_id` and the Snap-kit example's
`parent_core_object_id` issue context; conflicting IDs are rejected. The payload
request ID is preferred for deduplication. If absent, the action uses the click's
timestamp (ISO, Unix seconds, or Unix milliseconds), issue, actor and requested
window. If those are unavailable, it uses the execution metadata request ID, then
a generated UUID as a last resort. Missing request IDs do not reject an otherwise
valid action. A `missing_request` response from an older version is a handler
validation failure before connection lookup; upgrade the existing version to
apply this fix. The last-resort path logs the fixed marker `request:generated`.

The action sends this key only to the
fixed regional NerdGraph endpoint inferred from the source alert link. Grant
the optional `issue:read` impersonation permission. Timeline entries use their
parent issue's permissions; DevRev has no separate `comment:write` scope. Issue
reads, evidence comment writes and agent invocation run as the clicking user.
Analysis status/result comments run as the bot only after successful user issue
authorization. The callback updates only its bound, bot-owned internal request.

The evidence actions load the exact source issue and its entity GUIDs, then post
an **internal discussion comment** containing:

- A corrected source alert permalink, account, entity GUIDs and UTC window.
- APM throughput (requests/min), average duration (ms) and error percentage from
  `apm.service.*` metrics, grouped by entity.
- Up to 10 error/warning log samples, with messages limited to 400 characters.
- Up to 5 trace summaries ranked by slowest observed span, followed by up to 10
  sampled spans from those trace IDs within the same entity/time bounds.
- The exact NRQL queries, row limits, truncation notices and section failures.

At most 10 affected entities are queried; extra entities are reported as omitted.
Alerts without GUIDs produce an explanation instead of an account-wide query.
Unrelated DevRev issues are rejected. Queries use NerdGraph variables, allowlisted
identifiers, a five-second NRQL timeout and ten-second HTTP timeouts. The three
initial telemetry queries run independently, so unavailable logs do not discard
successful metrics/traces. Deliveries with the same payload request ID or click
identity reuse a unique comment reference; clicking again deliberately creates
a new snapshot. Timestamp-based identities remain stable even if a retry gets
a different execution request ID. If only an execution request ID is available,
deduplication covers that invocation. If that ID changes on retry, or if no usable
correlation metadata is supplied and a UUID must be generated, repeated deliveries
can create duplicate comments.

Only selected attributes are fetched. Common credentials and email addresses,
including the active API/session keys, are scrubbed before posting; output rows
are capped at 650 characters. This is best-effort scrubbing, not a guarantee that
logs contain no sensitive data. The comment is visible internally to the DevRev
organization, so use a New Relic key approved for sharing these samples there.

APM metrics require compatible instrumentation; infrastructure-only alerts may
have no such metrics. Logs need entity correlation and a recognized `level`.
Traces require retained Span events with `trace.id`. Returned spans are sampled
evidence, not a complete distributed trace, and the slowest span is not the full
trace duration. Empty data and query failures are shown explicitly; no automatic
root cause is established. Agent analysis is a separate interpretation of these
bounded results. This is an on-demand snapshot, not continuous telemetry
ingestion. The snap component is visible on issue views, and the
handler verifies the source before fetching anything.

References: [DevRev issue components](https://developer.devrev.ai/snapin-development/references/snap-components),
[NRQL via NerdGraph](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/),
[APM metric queries](https://docs.newrelic.com/docs/data-apis/understand-data/metric-data/query-apm-metric-timeslice-data-nrql/).

### Installing on versions older than the user context connection

Older connector versions did not have the user context connection. DevRev's documented
[upgrade compatibility rules](https://developer.devrev.ai/snapin-development/upgrade-snap-ins)
do **not** permit adding a connection to an existing snap-in version. If
`npm run upgrade -- <version-DON>` rejects the manifest, do not use `--force`:
that can delete the existing snap-in and disrupt its AirSync.

Use `npm run deploy` to install the updated snap-in alongside the existing one,
configure the user connection and permissions, and use its issue component on
the existing imported issues. **Do not create a second AirSync** for this new
installation. The existing AirSync continues running from its original snap-in.
To update that original extractor's stored links in place, apply the code changes
with its original manifest and use the normal version upgrade, then re-sync.
Fresh installations can use this manifest for both AirSync and the context action.

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
- Bulk telemetry import, users, entity inventory, dashboards, attachments, deletion
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
Context-action tests additionally cover issue access, per-user credentials,
bounded queries, sampled spans, partial failures, secret scrubbing, historical
source links and idempotent comment delivery. All use mocked APIs; deployment,
UI rendering, permissions and queries must also be checked in a live organization.

Every manifest function must have a matching `code/src/functions/<function-name>/index.ts`
and be registered in `function-factory.ts`. The context action is packaged at
`dist/functions/fetch_newrelic_context/index.js`; directory names must match the
manifest exactly. A factory entry alone does not satisfy DevRev's source-function
validation. See the [DevRev function layout reference](https://developer.devrev.ai/snapin-development/references/functions).

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

### Version creation succeeds but deployment cannot read the version ID

`Failed to get version ID` after a successful version-create response is a
deployment-script parsing failure, not evidence that old packages are blocking
deployment. The CLI's interactive terminal output mixes npm logs, terminal
control sequences and JSON. If that output does not yield one version belonging
to the newly created package, Lambda deployment now queries:

```sh
devrev snap_in_version list --package '<new-package-id>' --all --org '<org>' --usr '<email>'
```

The script continues only when that package has exactly one identifiable version.
It accepts bare objects, wrapped lists, arrays and JSON lines, and retries an empty
list up to three times for visibility delays. It never selects a version from
another package or guesses between multiple versions. Real CLI/API errors still
stop deployment.

Once version creation has been attempted, failure paths retain the package and
any versions for inspection rather than trying to delete a potentially non-empty
package. Failures before version creation, such as ngrok startup failure, still
clean up the newly created empty package. Inspect the retained version in DevRev
or with the command above before deciding whether to resume or remove it. These
recovery paths are tested with mocked CLI responses; a live deployment still
needs validation in the target organization.

### Update an existing installation

`npm run deploy` creates a new package, version and installed snap-in. Reusing
its package slug does not overwrite an installation; the create operation can
fail with a slug conflict. Use the explicit upgrade command for routine changes.

Find the package and its **current snap-in version ID** using the DevRev UI or:

```sh
devrev snap_in_package list
devrev snap_in_version list --package '<package-id>'
```

From `code/`, upgrade that exact version using the repository's current code:

```sh
npm run upgrade -- '<full-snap-in-version-id>'
```

This uses the same `.env`/PAT authentication as deployment and calls
`devrev snap_in_version upgrade`. It does not create another package or draft,
and does not use `--force`. Incompatible upgrades fail so you can review them;
DevRev documents that forcing an incompatible upgrade can delete installations.
The upgrade command selects the CLI's supported positional-ID or `--version`
syntax from its help output. The version ID changes after an upgrade: obtain the
current ID before the next upgrade. Check completion/status in DevRev before
starting another sync. No live upgrade has been verified by this project's tests.

Upgrading code does not automatically rewrite existing AirSync recipes. Review
mapping changes against the existing import separately. See [DevRev's upgrade
behavior](https://developer.devrev.ai/snapin-development/upgrade-snap-ins).

Before production use, validate with a test account:

1. Confirm the keyring accepts a valid user key and rejects an invalid key.
2. Confirm account discovery lists only accounts available to that user.
3. Import known open and closed issues and inspect links, priority and stage.
4. Exercise a multi-page import and a subsequent sync after an issue changes.
5. Confirm US/EU deployment behavior and workspace mapping compatibility.

Live New Relic/DevRev validation requires credentials and is not covered by the
mocked test suite. No deployment is performed by the tests.
