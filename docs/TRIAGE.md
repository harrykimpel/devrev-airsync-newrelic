# One-click New Relic incident triage (1.5.0)

The issue component is now **New Relic incident triage**. Its primary button,
**Triage and start fix**, requests all three stages:

1. Analyze bounded telemetry from the alert window and the latest 30 minutes.
2. Create or reuse the GitHub issue using the stable incident marker.
3. Assign the verified open issue to Copilot, or return its existing assignment/PR.

The incident brief and validated GitHub/coding links replace one pending comment
in the issue's internal discussion. If a later stage fails, a structured partial
result retains the earlier analysis and verified issue link. A PR is a proposed
fix for human review; assignment does not mean coding finished or production
recovered.

## Prepare the existing GitHub agent

Update and publish **AG-7**, the agent configured by **GitHub issue agent ID**,
using the combined instructions in [GITHUB_ISSUE_AGENT.md](GITHUB_ISSUE_AGENT.md).
The new operation is `triage_and_fix`. Earlier instructions reject that operation
and must be updated before using the button.

It needs the same GitHub capabilities as the individual issue/coding workflows:
issue search/read/create, Copilot assignment, and PR search/read. Keep its target
repository and connection restricted appropriately. No extra DevRev agent, MCP
connection, callback server, manifest input or scope is added.

The combined action runs in **one user-authorized AG-7 session**. AG-7 performs
the analysis using the same bounded evidence and instructions supplied to the
Incident Analyst, then runs its GitHub tools. It does not invoke AG-6 or the
separately configured **Coding agent ID**. Those agents remain available through
the individual buttons. The combined mode requires AG-7 to have assignment tools
even if a different agent is used for individual coding requests.

This design avoids saving/reusing the user's session token across callbacks.
Only safe routing metadata and scrubbed results are persisted; tokens are never
stored in request records or sent as agent input. Agent instructions define the
stage order; the connector validates the returned report, not an independent MCP
execution trace. Verify actual tool order and duplicate checks in Observe.

## Upgrade and use

Pull the merged changes and, from `code/`, upgrade the existing installation:

```bash
git pull --ff-only origin main
npm run upgrade -- '<current-snap-in-version-DON>'
```

Keep the existing **GitHub issue repository**, **Coding agent provider** and
optional **Coding agent base branch**. Currently only `copilot` is implemented.
The combined action also needs the clicking user's New Relic connection, since
it collects fresh evidence. It does not require Incident analysis agent ID; the
individual analysis buttons still use that setting.

Refresh the issue and open **New Relic incident triage**. Its description and
primary button explicitly identify the GitHub/coding handoff. Clicking the button
authorizes those writes; no analysis-only request triggers them automatically.

The individual actions remain available:

- **Analyze incident** / **Analyze latest 30 minutes** invoke the Incident Analyst.
- **Fetch alert evidence** / **Fetch latest evidence** post the bounded raw results.
- **Create GitHub issue** uses the latest completed individual or combined brief.
- **Start coding agent** uses a completed individual or combined GitHub result.
- **Check coding progress** reads the assignment/PR state after either workflow.

If a completed combined report already contains an assignment/PR, Start coding
agent directs you to Check coding progress rather than dispatching another Start.
If the combined report stops at coding, inspect GitHub before using the individual
action: the write may have succeeded even when its response was uncertain.

## Retries and limitations

Repeated deliveries of the same click reuse its pending request. New clicks
start a fresh analysis; AG-7 must search/read the existing incident marker and
existing assignment/PR before writing. Independent/concurrent clicks, standalone
actions and other installations are not a global GitHub lock; search indexing
can lag, so search-before-write is not an exactly-once guarantee.

The callback uses the existing bot-owned request, 30-minute lifetime, private
terminal-result arbitration, repository/provider checks and safe logging. An
uncertain initial response leaves the comment pending. A callback must have the
expected agent, installation, issue, session and configured repository/provider;
unknown or mismatched URLs/IDs are never accepted as success. The combined report
has a bounded JSON size and a scrubbed analysis capped at 8,000 characters.

No automatic polling, merging or deployment is added. Use Check coding progress
to retrieve a PR once Copilot has opened it. If no validated result arrives,
inspect the agent session and GitHub before retrying. Upgrading does not rewrite
older pending comments.

## Verify in DevRev

Tests mock API calls and agent replies. After republishing AG-7 and upgrading,
perform one deliberate end-to-end combined run. Confirm both evidence windows
were analyzed before the first GitHub write, the marker is in the issue body,
the verified issue was used for assignment, and the internal comment contains
the brief plus issue/assignment or PR links. Repeat a run to confirm reuse of the
existing GitHub issue and assignment, and use Check coding progress to retrieve
the later PR. Check partial-result behavior when a tool is unavailable in a test
configuration. These are real GitHub writes subject to your account's usage limits.
