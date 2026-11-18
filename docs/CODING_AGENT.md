# Copilot coding handoff (1.4.0)

The workflow is **New Relic analysis → GitHub issue → Start coding agent →
Copilot's proposed fix PR → Check coding progress**. Each external write is
requested on demand. The connector does not assign an issue automatically after
analysis or issue creation.

Copilot creates its branch and PR when assigned the issue. The coordinator must
not call the separately installed `create_pr`/`create_pull_request` tool: creating
another PR would duplicate Copilot's work and does not itself implement a fix.

## Prepare AG-7

You can reuse **O11yParty GitHub Issue Agent (AG-7)**:
`don:core:dvrv-us-1:devo/1j1eA4yHRR:ai_agent/7`.

1. Open **Settings → Agent Studio → AG-7 → Build**.
2. Replace its goal and instructions with the updated combined workflow in
   [GitHub issue agent setup](GITHUB_ISSUE_AGENT.md). Earlier instructions forbid
   all assignment/PR operations and must be replaced before using these buttons.
3. Keep issue search/read/create tools. Enable `assign_copilot_to_issue` (already
   configured in this org), plus PR search/read capabilities such as
   `search_pull_requests` and `pull_request_read` (`method: get`). Use equivalent
   names from your installed MCP server. The agent needs to read issue assignees,
   PR bodies, base repository, URL, number, open/closed/merged state and draft flag.
   `create_pr` is not a substitute for these reads.
4. Allow the connection to operate on **harrykimpel/O11yParty-Buzzer**. The user
   behind the GitHub connection needs write access and Copilot coding-agent
   access enabled for that repository. Issue-creation permissions alone may not
   permit Copilot assignment. Follow your installed MCP server's authentication
   requirements; the official assignment tool advertises OAuth `repo` scope.
5. Publish the updated agent. The clicking DevRev user must be allowed to invoke
   it and use the connection. Add repository setup/test conventions in
   `.github/copilot-instructions.md` if they are not already documented.

Alternatively, create a separate published internal coordinator using the coding
sections of those instructions and set **Coding agent ID** to its full DON. The
GitHub issue agent remains responsible for creating issues; the optional coding
coordinator handles only the two coding actions.

## Upgrade and configure

Pull the merged release. From `code/`, upgrade the **existing** snap-in:

```bash
git pull --ff-only origin main
npm run upgrade -- '<current-snap-in-version-DON>'
```

This argument is the installed snap-in's **current version DON**, not the agent
DON or snap-in installation DON. The script builds the new version and updates
the installation. `npm run deploy` creates a new installation instead.

In **Settings → Integrations → Snap-ins → New Relic → Configure**:

| Input | Value |
| --- | --- |
| GitHub issue agent ID | Existing full DON for AG-7 |
| GitHub issue repository | `harrykimpel/O11yParty-Buzzer` |
| Coding agent ID | Empty to reuse AG-7; otherwise a separate published coordinator's full DON |
| Coding agent provider | `copilot` |
| Coding agent base branch | Empty for repository default, or an existing branch such as `main` |

Keep the existing analyst ID, bot/user permissions and connections. This release
adds optional organization inputs and reuses the existing action, initializer,
response event source and callback. No new callback server or keyring is needed.
Refresh the DevRev issue after upgrading so it renders the new controls.

## Use the workflow

1. Run an analysis and **Create GitHub issue**, or use an existing completed
   GitHub issue result in the current installation's internal discussion.
2. Click **Start coding agent**. The connector sends the validated GitHub issue
   number/URL, repository, source IDs, incident marker and optional base branch
   to the coordinator. It does not resend raw telemetry or unrelated discussion.
3. The coordinator verifies the exact incident marker in the GitHub issue and
   checks existing assignments and PRs. It reuses an existing linked PR, even if
   closed/merged, or an existing Copilot assignment. Otherwise it assigns the
   open issue once. Copilot investigates the issue and proposes code and tests.
4. The pending internal comment becomes either an assignment notice or a PR link.
   A PR might not be available when the assignment tool returns. Use **Check coding
   progress** later to read the current state and add the link/state to discussion.
5. Review the changes and test results on GitHub before merging. A PR link does
   not prove the fix works or that production has recovered. This workflow does
   not merge, enable auto-merge, deploy or close the DevRev issue.

Progress is checked on demand. There is no GitHub webhook/polling service pushing
future PR updates into DevRev. The 30-minute callback lifetime applies to the
DevRev coordinator response, not the duration of Copilot's coding task.

## Reports and retries

The coordinator returns one structured report with `provider: copilot`, the exact
`issue_number` and `issue_url`, and one of:

- `assigned`: Copilot assignment was verified; no linked PR was verified yet.
- `pull_request`: include `pr_number`, `pr_url`, `pr_state` (`open`, `closed` or
  `merged`) and boolean `draft`, all read from GitHub.
- `not_started`: permitted only for a read-only progress check.
- `error`: no validated result, or insufficient/ambiguous tool evidence.

Examples (numbers are illustrative):

```json
{"status":"assigned","provider":"copilot","issue_number":165,"issue_url":"https://github.com/harrykimpel/O11yParty-Buzzer/issues/165"}
```

```json
{"status":"pull_request","provider":"copilot","issue_number":165,"issue_url":"https://github.com/harrykimpel/O11yParty-Buzzer/issues/165","pr_number":166,"pr_url":"https://github.com/harrykimpel/O11yParty-Buzzer/pull/166","pr_state":"open","draft":true}
```

The connector accepts formatting around one JSON report, then checks provider,
repository, URL path and matching numeric IDs. Callback routing is bound to the
installation, configured agent, issue, operation, service-owned pending comment
and session. It validates the report rather than independently querying GitHub;
test the agent's actual MCP tool behavior in your org.

All Start clicks for the same installation/coordinator/provider/GitHub issue use
one reserved request, including after an error or timeout. Repeated terminal
callbacks cannot replace an already completed comment. Progress checks get their
own request and must never assign or create anything. If a Start result is
uncertain, inspect GitHub or check progress. If progress confirms nothing started,
correct permissions/instructions and explicitly start Copilot on GitHub; this
release has no automatic reset/retry of a reserved Start. Do not delete the request
comment or reinstall the snap-in to bypass the reservation.

Reservations use DevRev timeline external references. Reads are limited to the
last 100 internal entries, so an older GitHub result may need to be located again
with **Create GitHub issue**. This asks the issue agent to reuse its incident
marker. Cross-installation requests, changed coordinator configurations and
concurrent search/assignment operations are not a global GitHub lock; checking
existing assignment/PRs in the agent remains necessary. If searches are incomplete
or their outcome is uncertain, the coordinator must report an error.

## Additional providers

The provider registry and report contract are in
`code/src/functions/fetch_newrelic_context/coding-policy.ts`. This release only
implements `copilot`. A future adapter must supply its own supported tool/API
instructions, assignment verification and tests while retaining repository,
issue, callback and read-only status checks. An arbitrary provider string cannot
activate tools or silently fall back to Copilot.

## Verification

Unit/integration tests mock DevRev and GitHub agent replies; they exercise actor
authorization, trusted issue selection, reservations, status requests, callback
bindings and URL/report validation. They do not run Copilot or spend GitHub usage.

After publishing the agent, perform one deliberate end-to-end Start on an open
incident issue with no existing Copilot assignment/PR. Confirm the assignment on
GitHub and inspect the agent's tool calls in **Observe → Sessions**. Check progress
after Copilot opens its PR. Repeat Start to confirm it reuses the request, and
confirm a progress check performs only read operations. Starting Copilot is a real
coding task subject to your GitHub plan's usage limits.

References:

- [Assigning issues to Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- [Official GitHub MCP tools](https://github.com/github/github-mcp-server)
