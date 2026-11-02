/** Validated bridge records and stable Linear event identities. No credentials cross this interface. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const LINEAR = 'linear'
const id = z.string().uuid()
const url = z.url().refine(value => new URL(value).origin === 'https://linear.app', 'Expected a Linear URL')
export const LinearIssue = z.object({
  id, identifier: z.string(), title: z.string(), description: z.string().nullish(), url,
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  team: z.object({ id, key: z.string() }), project: z.object({ id }).nullish(),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
  creator: z.object({ id, name: z.string() }).nullish(),
})
export type LinearIssue = z.infer<typeof LinearIssue>
export const LinearComment = z.object({
  id, body: z.string(), url, createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  user: z.object({ id, name: z.string() }).nullish(), issue: LinearIssue,
})
export type LinearComment = z.infer<typeof LinearComment>
export const LinearPage = z.object({ nodes: z.array(z.unknown()), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) })
export const linearIssueText = (issue: LinearIssue): string => `${issue.identifier}: ${issue.title}\n\n${issue.description ?? ''}`
export const linearAddress = (issue: LinearIssue, cli: string) => ({ issueId: issue.id, teamId: issue.team.id,
  projectId: issue.project?.id ?? '', identifier: issue.identifier, url: issue.url, cli })
const meta = (issue: LinearIssue) => ({ issueId: issue.id, teamId: issue.team.id, projectId: issue.project?.id ?? '',
  identifier: issue.identifier, labels: issue.labels.nodes.map(label => label.name), state: issue.state.name })

/** A label is a machine-observed dispatch signal, never evidence that its creator authorized the latest edit. */
export function linearIssueTrigger(issue: LinearIssue, cli: string): Trigger {
  return { id: key('linear-issue', issue.id), source: LINEAR, threads: [{ source: LINEAR, id: issue.id }],
    actor: { source: LINEAR, id: '' }, human: false, at: issue.updatedAt, text: linearIssueText(issue), url: issue.url,
    channel: { source: LINEAR, thread: `${LINEAR}:${issue.id}`, address: linearAddress(issue, cli) },
    meta: { ...meta(issue), kind: 'issue' } }
}
/** Same-account human comments are supported; agent replies are recognized by persisted outbound IDs instead. */
export function linearCommentTrigger(comment: LinearComment, cli: string, mention: string): Trigger {
  // The configured mention contains only @, letters, digits, underscores and hyphens.
  const addressed = new RegExp(`(?:^|[^\\w@])${mention}(?![\\w-])`).test(comment.body)
  return { id: key('linear-comment', comment.id, comment.updatedAt, comment.body), source: LINEAR,
    threads: [{ source: LINEAR, id: comment.issue.id }], actor: { source: LINEAR, id: comment.user?.id ?? '' },
    human: !!comment.user, ...(addressed ? { addressed: 'mention' as const } : {}),
    at: comment.updatedAt, text: comment.body, url: comment.url,
    channel: { source: LINEAR, thread: `${LINEAR}:${comment.issue.id}`, address: linearAddress(comment.issue, cli) },
    meta: { ...meta(comment.issue), kind: 'comment', commentId: comment.id } }
}
