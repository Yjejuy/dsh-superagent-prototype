# 009 Linear Issue dispatch

Linear is an optional Source for the same Ticket and worker pipeline described in [001 Domain model](001-domain.md).
One deployment still targets one GitHub repository: Linear supplies requests and receives results, while GitHub supplies code and pull requests.
GitHub request polling may be disabled while its repository and CLI remain configured for worker execution.
There is no requirement for a different GitHub requester account when requests originate in Linear.

## Install the Source

Build the bundle and enable its `dsh-superagent-linear` entry in the dedicated profile:

```yaml
- id: dsh-superagent-linear
  disabled: false
```

Restart the profile as described in [006 Deployment](006-deployment.md).
The Linear card appears under Settings → Sources, and Linear authorization appears under Settings → Eval → On each Source.
Its default CLI and team are empty, so it reads nothing until configured.
The plugin remains disabled in the distributed bundle by default.

## Private API bridge

Use Python 3.8+ and a Linear personal API key with read access and permission to create comments.
Keep the credential in a private file; never paste it into a prompt, a panel field, a shell argument or a tracked file.
OAuth access tokens are also supported.
Create a private executable wrapper, replacing the two paths:

```sh
#!/bin/sh
exec python3 /absolute/checkout/scripts/linear-source \
  --credential-file /absolute/private/linear.key "$@"
```

Set the card's **Bridge wrapper** to that wrapper's absolute path.
Running the wrapper with `identity` reads its authenticated user without exposing the credential.
The existing DSH read-only Linear MCP integration stays independent; it cannot supply unattended result writes.

## Label dispatch

Set **Team UUID**, optionally **Project UUID**, **Required issue label** to `superagent`, **Dispatch by** to Label, and **Dispatch statuses** to `Todo` (or the exact statuses you use, comma-separated).
Set the allowed Linear user UUIDs in Eval for follow-up comments.
Add this admission row to Linear's Policy: `issues.unlistedUnaddressed = inferred`.
A label snapshot has no reliable author for the label change: the Source deliberately records no human authorization for it.

Add an enabled assessment rule limiting work to Linear Issue snapshots in that exact configured scope, implementing their title and description and returning a reviewable, verified PR.
Start with **observe** to inspect proposed decisions; select **auto** when label dispatch should create workers.
Other Sources and rules should remain disabled unless separately intended.
With the Source enabled and processing resumed, putting an Issue in Todo with the label dispatches it on the next poll, normally within a minute.
Existing eligible labeled Issues are included at the first poll.

Each Issue has a stable initial Trigger ID, so replay, restarts, title edits and label toggles never create another initial Ticket.
Use comments for subsequent requests; use the panel's re-evaluation/retry actions for an ignored or failed dispatch.
Removing the label stops receipt of new comments in that Issue; it does not cancel already authorized running work.
To stop a task, use its panel stop action or an allowed person's explicit stop request.

## Comments, results and supervision

Comments on scoped issues are ingested independently of their dispatch status, so follow-ups still arrive after an Issue leaves Todo.
An allowed person's `@superagent <request>` comment is explicit; later human comments on a subscribed Issue go to its Ticket's worker.
Comment-command dispatch mode skips the initial labeled Issue snapshot and waits for these explicit requests, still requiring the configured label/team/project scope.
Historical comments are not imported on first configuration; subsequent polling uses a five-second overlap and stable per-edit event IDs.

The main Session assesses and routes, the worker implements and verifies, and the normal outbound channel posts the outcome or one concrete question on the originating Linear Issue.
Replies use a deterministic Linear comment UUID, so a lost response does not cause a duplicate on retry.
Only comments with both that UUID and the authenticated author's identity are treated as the agent's own replies; personal-account human comments remain usable.
The bridge rechecks the Issue's team/project before every send and refuses a moved destination.
Permission errors are retried and reported rather than silently treated as a deleted Issue.

Overview, Source, Trigger, Eval and Execution work as described in [005 Panel](005-panel.md).
The integration does not automatically change Issue status, remove labels or merge PRs.
A person reviews and merges the PR and decides whether to close the Linear Issue.
The stock deployment runs unattended workers with full OS-user permissions; credential wrappers choose accounts, not a sandbox.

## API references

The bridge uses Linear's official GraphQL API, scoped filters, cursor pagination and `CommentCreateInput.id` for deterministic delivery:
[GraphQL](https://linear.app/developers/graphql), [filtering](https://linear.app/developers/filtering), [pagination](https://linear.app/developers/pagination).
Read and mutation responses are checked for GraphQL errors even when HTTP returns 200.
Only fixed bridge diagnostics are returned on authentication/network errors; credentials and remote error bodies are never printed.
