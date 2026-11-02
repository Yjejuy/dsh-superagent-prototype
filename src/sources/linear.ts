/** Opt-in Linear Issue Source: scoped polling, comment follow-ups, thread context and idempotent result delivery. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind, ContextMessage } from './kind.ts'
import { cursorAt, pause } from './poll.ts'
import { LINEAR, LinearIssue, LinearComment, LinearPage, linearIssueTrigger, linearCommentTrigger, linearIssueText } from './linear-protocol.ts'

const uuid = z.string().uuid()
export const LinearConfig = z.object({
  cli: z.string().trim().refine(value => !value || value.startsWith('/'), 'Use an absolute bridge wrapper path').default(''),
  teamId: uuid.or(z.literal('')).default(''), projectId: uuid.or(z.literal('')).default(''),
  dispatch: z.enum(['label', 'comment']).default('label'), label: z.string().trim().min(1).max(100).default('superagent'),
  states: z.string().trim().min(1).max(300).default('Todo'), mention: z.string().regex(/^@[a-zA-Z][\w-]{0,49}$/).default('@superagent'),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
}).strict()
export type LinearConfig = z.infer<typeof LinearConfig>
const configKey = (config: LinearConfig) => JSON.stringify([config.cli, config.teamId, config.projectId, config.label, config.dispatch, config.states, config.mention])
const selected = (meta: Record<string, unknown>, config: LinearConfig) => !!config.cli && !!config.teamId
  && meta.teamId === config.teamId && (!config.projectId || meta.projectId === config.projectId)
  && (Array.isArray(meta.labels) && meta.labels.includes(config.label))
const scopeArgs = (config: LinearConfig) => ['--team', config.teamId, '--label', config.label,
  ...(config.projectId ? ['--project', config.projectId] : [])]
const field = (key: string, en: string, zh: string, hint?: { en: string; zh: string }) =>
  ({ key, type: 'text' as const, label: { en, zh }, ...(hint ? { hint } : {}) })

export const linearKind: SourceKind<LinearConfig> = {
  kind: LINEAR, title: { en: 'Linear', zh: 'Linear' },
  description: { en: 'Dispatch scoped issues and receive follow-up comments; results return to the same issue.', zh: '接收指定范围的 Issue 和后续评论，把结果回写到原 Issue。' },
  schema: LinearConfig, health: [LINEAR],
  fields: [field('cli', 'Bridge wrapper', '桥接命令', { en: 'Absolute wrapper path. Keep the API credential in a private file, never in these settings.', zh: '包装脚本的绝对路径。凭据保存在私有文件中，不填入设置。' }),
    field('teamId', 'Team UUID', '团队 UUID'), field('projectId', 'Project UUID (optional)', '项目 UUID（可选）'),
    { key: 'dispatch', type: 'select', label: { en: 'Dispatch by', zh: '派单方式' }, options: [
      { value: 'label', label: { en: 'Label + status (inferred)', zh: '标签 + 状态（推断任务）' } },
      { value: 'comment', label: { en: 'Mention in a comment', zh: '评论中提及' } }] },
    field('label', 'Required issue label', '必需的 Issue 标签'), field('states', 'Dispatch statuses (comma-separated)', '派单状态（逗号分隔）'),
    field('mention', 'Comment mention', '评论命令前缀'),
    { key: 'pollSeconds', type: 'number', min: 60, max: 3600, advanced: true, label: { en: 'Poll seconds', zh: '轮询秒数' } }],
  scope({ meta }, config) {
    if (!selected(meta, config)) return { listened: false, reason: 'linear_issue_outside_scope' }
    if (meta.kind === 'issue' && !config.states.split(',').map(state => state.trim()).includes(String(meta.state))) {
      return { listened: false, reason: 'linear_issue_not_in_dispatch_status' }
    }
    return { listened: true, observed: true, row: meta.kind === 'issue' ? 'issues' : 'comments' }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: uuid, name: z.string().optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { en: 'Allowed Linear users', zh: '可派单的 Linear 用户' },
      columns: [field('id', 'User UUID', '用户 UUID'), { ...field('name', 'Name', '名称'), optional: true }] }],
    explicit: { en: 'An allowed person writes the configured mention in a scoped issue comment. Label dispatch is inferred and needs a rule plus auto mode.',
      zh: '允许的用户在范围内的 Issue 评论中使用命令前缀。标签派单属于推断任务，需要规则及 auto 模式。' },
    rows: () => ['issues', 'comments'].map(id => ({ id, label: { en: id === 'issues' ? 'Labeled issues' : 'Comments', zh: id === 'issues' ? '标签派单' : '评论' },
      note: { en: 'Team, project and label scope', zh: '限定团队、项目和标签' },
      cells: { listedUnaddressed: id === 'comments', unlistedAddressed: id === 'comments', unlistedUnaddressed: true } })),
  },
  channel: {
    allowed: (address, config) => address.cli === config.cli && address.teamId === config.teamId
      && !!config.teamId && (!config.projectId || address.projectId === config.projectId),
    send: sendLinear,
    link: address => ({ url: address.url ?? '', label: { en: `Linear ${address.identifier ?? ''}`, zh: `Linear ${address.identifier ?? ''}` } }),
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])] }),
  threadContext: {
    messageId: trigger => String(trigger.meta.commentId ?? trigger.meta.issueId),
    async read(commands, trigger, part, cursor, config) {
      if (!selected(trigger.meta, config)) throw new Error('Linear issue is outside the configured scope')
      const issueId = String(trigger.meta.issueId)
      const issue = LinearIssue.parse(JSON.parse(await commands.run(config.cli, ['issue', '--id', issueId])))
      if (!selected({ teamId: issue.team.id, projectId: issue.project?.id ?? '', labels: issue.labels.nodes.map(x => x.name) }, config)) {
        throw new Error('Linear issue moved outside the configured scope')
      }
      const root: ContextMessage = { id: issue.id, from: issue.creator?.id ?? '', at: issue.createdAt, text: linearIssueText(issue), url: issue.url }
      if (part !== 'thread') return { messages: [root], body: { issue } }
      const page = LinearPage.parse(JSON.parse(await commands.run(config.cli, ['thread', '--issue', issueId, ...(cursor ? ['--after', cursor] : [])])))
      const comments = page.nodes.map(value => LinearComment.omit({ issue: true }).parse(value))
      return { messages: [...cursor ? [] : [root], ...comments.map(comment => ({ id: comment.id, from: comment.user?.id ?? '',
        at: comment.createdAt, text: comment.body, url: comment.url }))],
      ...(page.pageInfo.hasNextPage ? { next: nextCursor(page, cursor) } : {}), body: { issue, comments } }
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_LINEAR_ISSUE', description: { en: 'Originating Linear issue identifier', zh: '来源 Linear Issue 编号' } },
      { key: 'DSH_SUPERAGENT_LINEAR_URL', description: { en: 'Originating Linear issue URL', zh: '来源 Linear Issue 链接' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_LINEAR_ISSUE: trigger?.source === LINEAR ? String(trigger.meta.identifier ?? '') : '',
      DSH_SUPERAGENT_LINEAR_URL: trigger?.source === LINEAR ? trigger.channel?.address.url ?? '' : '' }),
  },
}

function nextCursor(page: z.infer<typeof LinearPage>, before?: string): string {
  const next = page.pageInfo.endCursor
  if (!next || next === before) throw new Error('Linear returned a non-advancing page cursor')
  return next
}
/** Delivery carries the account wrapper selected at acceptance; changing accounts cannot redirect queued replies. */
export async function sendLinear(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { cli, issueId, teamId, projectId } = message.channel.address
  if (!cli?.startsWith('/') || !uuid.safeParse(issueId).success || !uuid.safeParse(teamId).success) throw new Error('Invalid Linear reply destination')
  try {
    const result = z.object({ sent: z.literal(true) }).parse(JSON.parse(await host.commands.run(cli,
      ['reply', '--issue', issueId!, '--team', teamId!, ...(projectId ? ['--project', projectId] : []), '--key', message.id, '--text', message.text])))
    return result.sent ? 'sent' : 'gone'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
/** Complete both streams before advancing the overlap-safe cursor. Partial rounds replay stable event IDs. */
export async function pollLinear(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number }> {
  const config = ctx.config<LinearConfig>(LINEAR)
  if (!config?.cli || !config.teamId) throw new Error('Set the Linear bridge wrapper and team UUID')
  const start = new Date().toISOString(), identity = configKey(config)
  const state = ctx.state.get(KV.linear.cursor)
  const since = state?.config === identity ? state.since : start
  const commands = ctx.commands.withSignal(signal)
  const check = () => {
    if (signal.aborted || configKey(ctx.config<LinearConfig>(LINEAR) ?? LinearConfig.parse({})) !== identity) throw new Error('Linear poll interrupted or configuration changed')
  }
  const readPage = async (operation: string, args: string[]) => {
    const nodes: unknown[] = []; let cursor: string | undefined
    for (let n = 0; n < 100; n++) {
      check()
      const page = LinearPage.parse(JSON.parse(await commands.run(config.cli, [operation, ...scopeArgs(config), ...args, ...(cursor ? ['--after', cursor] : [])])))
      nodes.push(...page.nodes)
      if (!page.pageInfo.hasNextPage) return nodes
      cursor = nextCursor(page, cursor)
    }
    throw new Error('Linear poll exceeded 100 pages; narrow the source scope')
  }
  // Discover eligible issues from the complete scoped queue; each issue dispatches once, even after restarts and edits.
  const issueRows = config.dispatch === 'label' ? await readPage('issues', ['--states', config.states]) : []
  const commentRows = await readPage('comments', ['--since', since])
  const triggers: Trigger[] = []
  for (const value of issueRows) {
    const issue = LinearIssue.parse(value)
    if (issue.labels.pageInfo.hasNextPage) throw new Error('Linear issue labels are truncated; narrow the issue labels')
    triggers.push(linearIssueTrigger(issue, config.cli))
  }
  for (const value of commentRows) {
    const comment = LinearComment.parse(value)
    // The bridge proves authorship using a deterministic outbound UUID and the authenticated user, not text alone.
    const own = z.object({ own: z.boolean() }).parse(value).own
    if (!own) triggers.push(linearCommentTrigger(comment, config.cli, config.mention))
  }
  for (const trigger of triggers.sort((a, b) => a.at.localeCompare(b.at))) {
    check(); await ctx.receive(trigger)
    ctx.threads.describe(`${LINEAR}:${String(trigger.meta.issueId)}`, { label: String(trigger.meta.identifier), url: trigger.channel!.address.url })
  }
  check(); ctx.state.set(KV.linear.cursor, { config: identity, since: cursorAt(start) })
  return { read: triggers.length }
}

export const name = 'dsh-superagent-linear'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(linearKind), 'linear: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, linearKind), controller = new AbortController()
    const running = watchLinear(source, controller.signal).catch((error: unknown) => source.report(LINEAR, { state: 'error', detail: String(error) }))
    return async () => { controller.abort(); await running }
  })
}
export async function watchLinear(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(LINEAR, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<LinearConfig>(LINEAR)
    if (!config) ctx.report(LINEAR, health('paused', 'sourceOff'))
    else if (!config.cli || !config.teamId) ctx.report(LINEAR, { state: 'paused', detail: 'Set the Linear bridge wrapper and team UUID' })
    else try {
      await pollLinear(ctx, signal); failures = 0
      ctx.report(LINEAR, { state: 'ready', detail: 'Listening for scoped Linear issues and comments' })
    } catch (error) {
      if (!signal.aborted && ++failures >= 3) ctx.report(LINEAR, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
