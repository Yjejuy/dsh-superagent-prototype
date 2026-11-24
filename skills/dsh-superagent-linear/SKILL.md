---
name: dsh-superagent-linear
description: Handle Linear Issue tickets and follow-up comments through the Source and its original conversation.
---

Linear issues with the configured label and status arrive as inferred candidates, and a written rule determines whether they become Tickets.
The issue snapshot does not prove who added a label; never treat its creator as the person authorizing a later edit.
One issue has one initial dispatch; title or description edits do not create another initial Ticket.
An allowed person's comment containing the configured mention is an explicit request; in-scope follow-ups go to the owning Ticket's worker.

Read the originating Trigger with orchestrator_read; it contains the issue title, description, identifier and source URL.
Keep the main Session to assessment, routing and concise delivery; workers investigate, implement and verify.
Use the deployment's GitHub repository and credentials for branches and PRs.
Return the verified result and PR link to the original Linear issue through orchestrator_report and the main Session's normal reply tools.
For a human request, acknowledge once through orchestrator_ack; do not invent an acknowledgement author for a label observation.
Report one concrete question through human_action when a decision is required.
Treat an available PR as ready for review only after the required verification; a person merges it and decides the Linear issue's final state.
Do not directly change Linear states, labels, assignments or comments through shell commands, and never read or print the credential file.
The Source handles comment polling and idempotent delivery; the worker does not poll or send duplicate messages.
