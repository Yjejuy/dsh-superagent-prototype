/** Linear Source through the real Store, Registry and Engine, with a deterministic stand-in for its private bridge. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { LinearConfig, linearKind, pollLinear, sendLinear, apply } from '../src/sources/linear.ts'
import { LinearIssue, LinearComment, linearIssueTrigger, linearCommentTrigger } from '../src/sources/linear-protocol.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'

const TEAM = '11111111-1111-4111-8111-111111111111', ISSUE = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444'
const CLI = '/opt/linear-agent', AT = '2026-11-02T10:00:00.000Z'
const config = LinearConfig.parse({ cli: CLI, teamId: TEAM })
const issue = (patch: Partial<LinearIssue> = {}): LinearIssue => ({ id: ISSUE, identifier: 'ENG-1', title: 'Fix typo', description: 'Correct a typo',
  url: 'https://linear.app/team/issue/ENG-1/typo', createdAt: AT, updatedAt: AT, team: { id: TEAM, key: 'ENG' },
  project: null, creator: { id: USER, name: 'Alice' }, state: { name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ name: 'superagent' }], pageInfo: { hasNextPage: false } }, ...patch })
const comment = (patch: Partial<LinearComment> = {}): LinearComment => ({ id: '55555555-5555-4555-8555-555555555555', body: '@superagent fix this',
  url: 'https://linear.app/team/issue/ENG-1/typo#comment-1', createdAt: AT, updatedAt: AT, user: { id: USER, name: 'Alice' }, issue: issue(), ...patch })
const page = (nodes: unknown[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: !!next, endCursor: next } })
const directories: string[] = [], stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function host(mode: 'observe' | 'auto' = 'auto', configured = true) {
  const directory = mkdtempSync(join(tmpdir(), 'linear-source-')); directories.push(directory)
  const store = new Store(join(directory, 'db.sqlite')); stores.push(store)
  store.saveSettings(SettingsSchema.parse({ sources: { linear: { enabled: true, config } }, eval: { mode },
    policy: { rules: [{ id: 'linear', name: 'Linear dispatch', enabled: true, instruction: 'Implement labeled Todo issues' }],
      sources: { linear: { allowed: [{ id: USER }], admission: { issues: { unlistedUnaddressed: 'inferred' } } } } } }))
  const board = new HealthBoard(), sources = new SourceRegistry(() => store.settings(), board)
  sources.register(linearKind)
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, sources, engine, commands, deployment: testDeployment(), ready: Promise.resolve(), configured: () => configured,
    receive, outbox: { send: vi.fn() } }
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  return { store, sources, engine, executor, commands, receive, board, deps, ctx: sourceContextOf(deps, linearKind) }
}
const reply = (): OutboundMessage => ({ id: 'reply-1', kind: 'reply', channel: linearIssueTrigger(issue(), CLI).channel!, text: 'Ready for review' })

describe('Linear source', () => {
  it('defaults to no account/team scope and refuses out-of-scope issues and non-dispatch statuses', () => {
    const trigger = linearIssueTrigger(issue(), CLI)
    expect(linearKind.scope!(trigger, LinearConfig.parse({})).listened).toBe(false)
    expect(linearKind.scope!(trigger, config).listened).toBe(true)
    expect(linearKind.scope!(linearIssueTrigger(issue({ team: { id: OTHER, key: 'OTHER' } }), CLI), config).listened).toBe(false)
    expect(linearKind.scope!(linearIssueTrigger(issue({ state: { name: 'Done', type: 'completed' } }), CLI), config).listened).toBe(false)
    expect(linearKind.scope!(linearIssueTrigger(issue({ labels: { nodes: [], pageInfo: { hasNextPage: false } } }), CLI), config).listened).toBe(false)
  })
  it('never attributes a label edit to its issue creator or treats it as an explicit human request', () => {
    const trigger = linearIssueTrigger(issue(), CLI)
    expect(trigger).toMatchObject({ human: false, actor: { id: '' } })
    expect(trigger.addressed).toBeUndefined()
    expect(linearIssueTrigger(issue({ title: 'Edited', updatedAt: '2026-11-02T11:00:00Z' }), CLI).id).toBe(trigger.id)
  })
  it('keeps human comment identities and requires a complete configured mention', () => {
    expect(linearCommentTrigger(comment(), CLI, '@superagent')).toMatchObject({ human: true, actor: { id: USER }, addressed: 'mention' })
    expect(linearCommentTrigger(comment({ body: '@superagent-other' }), CLI, '@superagent').addressed).toBeUndefined()
    expect(linearCommentTrigger(comment({ body: 'someone@superagent' }), CLI, '@superagent').addressed).toBeUndefined()
    expect(linearCommentTrigger(comment({ user: null }), CLI, '@superagent').human).toBe(false)
  })
  it('paginates both streams, accepts a label once through policy, and routes human follow-ups to its Ticket', async () => {
    const h = host(), trigger = linearIssueTrigger(issue(), CLI)
    const run = vi.spyOn(h.commands, 'run').mockImplementation(async (_cli, args) => {
      if (args[0] === 'issues') return JSON.stringify(page(args.includes('--after') ? [] : [issue()], args.includes('--after') ? null : 'page-2'))
      return JSON.stringify(page([]))
    })
    await pollLinear(h.ctx, new AbortController().signal)
    expect(h.engine.candidate(trigger.id)?.strength).toBe('inferred')
    const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix typo', scope: 'Fix typo', reason: 'Label rule matches', rules: ['linear'] })
    expect(decision.ticketId).toBeTruthy()
    await pollLinear(h.ctx, new AbortController().signal)
    expect(h.store.tickets.list()).toHaveLength(1)
    const followup = comment({ body: 'Also cover the edge case' })
    run.mockImplementation(async (_cli, args) => JSON.stringify(page(args[0] === 'comments' ? [{ ...followup, own: false }] : [])))
    await pollLinear(h.ctx, new AbortController().signal)
    expect(h.store.triggers.disposition(linearCommentTrigger(followup, CLI, '@superagent').id)?.fanout).toContain(decision.ticketId)
    expect(h.ctx.state.get(KV.linear.cursor)?.config).toContain(TEAM)
  })
  it('observe mode never accepts label candidates, while allowed comment mentions are explicit', async () => {
    const h = host('observe'), trigger = linearIssueTrigger(issue(), CLI)
    h.receive(trigger)
    expect(h.engine.candidate(trigger.id)?.strength).toBe('inferred')
    expect(() => h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'Label rule matches', rules: ['linear'] })).toThrow()
    const otherIssue = issue({ id: OTHER })
    const explicit = linearCommentTrigger(comment({ issue: otherIssue }), CLI, '@superagent')
    h.receive(explicit)
    expect(h.engine.candidate(explicit.id)?.strength).toBe('explicit')
  })
  it('does not grant explicit authority to an unlisted comment author', () => {
    const h = host(), trigger = linearCommentTrigger(comment({ user: { id: OTHER, name: 'Unknown' } }), CLI, '@superagent')
    h.receive(trigger)
    expect(h.engine.candidate(trigger.id)).toBeUndefined()
  })
  it('keeps its cursor on abort, malformed records, failed pages, and non-advancing cursors', async () => {
    for (const failure of ['abort', 'malformed', 'failure', 'cursor']) {
      const h = host(), controller = new AbortController()
      vi.spyOn(h.commands, 'run').mockImplementation(async (_cli, args) => {
        if (failure === 'abort') controller.abort()
        if (failure === 'failure') throw new Error('API unavailable')
        if (failure === 'malformed') return JSON.stringify(page([{ id: 'broken' }]))
        return JSON.stringify(page(args[0] === 'issues' ? [issue()] : [], failure === 'cursor' ? 'same' : null))
      })
      await expect(pollLinear(h.ctx, controller.signal)).rejects.toThrow()
      expect(h.ctx.state.get(KV.linear.cursor)).toBeUndefined()
    }
  })
  it('suppresses bridge-proven agent replies, including when the account is also the human requester', async () => {
    const h = host()
    vi.spyOn(h.commands, 'run').mockImplementation(async (_cli, args) => JSON.stringify(page(args[0] === 'comments' ? [{ ...comment(), own: true }] : [])))
    await pollLinear(h.ctx, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('does not read historical comments when a different account or scope is selected', async () => {
    const h = host()
    h.ctx.state.set(KV.linear.cursor, { config: 'old-account', since: '2000-01-01T00:00:00Z' })
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify(page([])))
    await pollLinear(h.ctx, new AbortController().signal)
    const args = run.mock.calls.find(([, args]) => args[0] === 'comments')![1]
    expect(args[args.indexOf('--since') + 1]).not.toBe('2000-01-01T00:00:00Z')
  })
  it('sends replies by stable outbound ID and retries permission errors, while permanently dropped destinations return gone', async () => {
    const h = host(), run = vi.spyOn(h.commands, 'run').mockResolvedValue('{"sent":true}')
    await expect(sendLinear(h.ctx, reply())).resolves.toBe('sent')
    expect(run).toHaveBeenCalledWith(CLI, expect.arrayContaining(['--issue', ISSUE, '--team', TEAM, '--key', 'reply-1']))
    run.mockRejectedValue(new CliError('Moved team', 410))
    await expect(sendLinear(h.ctx, reply())).resolves.toBe('gone')
    run.mockRejectedValue(new CliError('Permission denied', 403))
    await expect(sendLinear(h.ctx, reply())).rejects.toThrow('Permission denied')
    expect(linearKind.channel!.allowed!(reply().channel.address, { ...config, cli: '/another/account' })).toBe(false)
  })
  it('provides paginated original issue and comment context and rejects issues that moved outside scope', async () => {
    const h = host(), run = vi.spyOn(h.commands, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'issue' ? issue() : page([comment()], 'next')))
    const context = await linearKind.threadContext!.read(h.commands, linearIssueTrigger(issue(), CLI), 'thread', undefined, config)
    expect(context.messages.map(message => message.id)).toEqual([ISSUE, comment().id])
    expect(context.next).toBe('next')
    run.mockResolvedValue(JSON.stringify(issue({ team: { id: OTHER, key: 'OTHER' } })))
    await expect(linearKind.threadContext!.read(h.commands, linearIssueTrigger(issue(), CLI), 'root', undefined, config)).rejects.toThrow('outside')
  })
  it('registers the Source and reports pending setup, then unregisters cleanly without starting a poll', async () => {
    const h = host('observe', false), disposers: (() => unknown)[] = []
    const sources = new SourceRegistry(() => h.store.settings(), new HealthBoard())
    const deps = { ...h.deps, sources }
    const sourceHost = { sources, context: (kind: typeof linearKind) => sourceContextOf(deps, kind) }
    apply({ orchestrator: sourceHost, effect: (fn: () => () => unknown) => { disposers.push(fn()) } } as never)
    await vi.waitFor(() => expect(sources.healthEntries(['linear']).get('linear')?.get()?.state).toBe('paused'))
    expect(sources.kind('linear')).toBe(linearKind)
    for (const dispose of disposers.reverse()) await dispose()
    expect(sources.kind('linear')).toBeUndefined()
  })
})
