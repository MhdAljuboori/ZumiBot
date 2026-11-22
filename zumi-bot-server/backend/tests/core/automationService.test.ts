import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { STALE_REFUSED, WRITE_REFUSED } from '@zumibot/shared/automations'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { Routine } from '@zumibot/shared/routines'
import type { AgentSummary, ChatItem, ChatMeta } from '@zumibot/shared/types'
import { problemsOf } from '@zumibot/shared/workflowGraph'
import type { Workflow } from '@zumibot/shared/workflows'
import { RoutineStore } from '../../src/core/routines/routineStore'
import { routineEditing } from '../../src/core/routines/routineEditing'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'
import { workflowEditing } from '../../src/core/workflows/workflowEditing'
import { AutomationService, type AutomationCall, type AutomationOwner } from '../../src/core/automations/automationService'

const SECRET = 'a-secret-long-enough-1234'
// What the bridge's IPC passes on to the agent (automationIpc.ts errorText): plain characters, no bare "/", at most 400.
const PLAIN = /^[A-Za-z0-9 .,:;'"“”(){}?-]{1,400}$/
const agent = (name: string, o: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...o
})

let dir: string
let routines: RoutineStore
let workflows: WorkflowStore
let agents: AgentSummary[]
let chats: Map<string, { meta: ChatMeta; items: ChatItem[] }>
let asked: string[]
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-automations-'))
  routines = new RoutineStore(dir)
  workflows = new WorkflowStore(dir)
  agents = [
    agent('x-expert'),
    agent('medium-writer'),
    agent('broken-one', { error: 'Bad frontmatter' }),
    agent(ZUMI_BOT_NAME, { builtIn: true })
  ]
  chats = new Map()
  asked = []
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const problems = async (w: Pick<Workflow, 'trigger' | 'steps' | 'edges'>) => problemsOf(w, agents, ZUMI_BOT_NAME)
const service = () =>
  new AutomationService({
    routines,
    workflows,
    routineEditing: routineEditing({ store: routines, scheduler: { rearm: async () => {} }, changed: () => {}, newSecret: () => SECRET }),
    workflowEditing: workflowEditing({
      store: workflows,
      runner: { problems, stopAllOf: async () => {} },
      scheduler: { rearm: async () => {} },
      changed: () => {},
      newSecret: () => SECRET
    }),
    workflowProblems: problems,
    chats: { get: async (id) => chats.get(id)?.meta ?? null, loadItems: async (id) => chats.get(id)?.items ?? [] },
    agents: async () => {
      asked.push('agents')
      return agents
    },
    ctx: async () => {
      asked.push('ctx')
      return { timeZone: 'UTC', folders: { 'x-expert': '/home/u/x' }, groupFolder: '/home/u/rooms', home: '/home/u' }
    }
  })
const user: AutomationOwner = { chatId: 'bot-chat', writable: true }
const routineRun: AutomationOwner = { chatId: 'bot-chat', writable: false }
const run = (call: AutomationCall, owner = user) => service().run(owner, call)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runJson = async (call: AutomationCall, owner = user): Promise<any> => JSON.parse(await run(call, owner))

const daily = (o: object = {}) => ({
  name: 'Daily tech hashtags',
  trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  target: { kind: 'new-chat', agent: 'x-expert' },
  prompt: 'Get the trending tech hashtags and draft a post for each.',
  ...o
})
const flow = (o: object = {}) => ({
  name: 'Hashtags',
  trigger: { kind: 'manual' },
  steps: [
    { handle: 'find', name: 'Find', kind: 'agent', agent: 'x-expert', prompt: 'Find new tech hashtags, one per line.', cwd: '/work' },
    { handle: 'tell', name: 'Tell', kind: 'notify', title: 'Hashtags', body: '{{steps.find.output}}' }
  ],
  edges: [
    { from: 'trigger', to: 'find' },
    { from: 'find', to: 'tell' }
  ],
  ...o
})
const saveRoutine = (routine: unknown, owner = user) => runJson({ op: 'routine_save', routine }, owner)
const saveWorkflow = (workflow: unknown, owner = user) => runJson({ op: 'workflow_save', workflow }, owner)

describe('a remote agent', () => {
  const asClaude = agent('remote-one')
  const remote = { ...asClaude, provider: 'ag-ui' as const, remoteHost: 'agents.example.com' }
  const PICK = 'Zumi Bot does not pick remote-one'

  it('is never added to a routine or a workflow, with the fixed sentence', async () => {
    agents.push(remote)
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: 'remote-one' } }))).rejects.toThrow(PICK)
    await expect(
      saveWorkflow(
        flow({
          steps: [{ handle: 'find', kind: 'agent', agent: 'Remote One', prompt: 'Go', cwd: '/work' }],
          edges: [{ from: 'trigger', to: 'find' }]
        })
      )
    ).rejects.toThrow(PICK)
    expect(await routines.list()).toEqual([])
    expect(await workflows.list()).toEqual([])
  })

  it('stays on a routine or workflow that already holds it, through an edit', async () => {
    agents.push(asClaude)
    const r = await saveRoutine(daily({ target: { kind: 'new-chat', agent: 'remote-one', cwd: '/work' } }))
    const w = await saveWorkflow(
      flow({
        steps: [{ handle: 'find', kind: 'agent', agent: 'remote-one', prompt: 'Go', cwd: '/work' }],
        edges: [{ from: 'trigger', to: 'find' }]
      })
    )
    // The agent becomes a remote one after they were made.
    agents[agents.length - 1] = remote
    const got = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ id: r.id, updatedAt: got.updatedAt, prompt: 'Only this' })
    expect((await routines.get(r.id))?.prompt).toBe('Only this')
    const wGot = await runJson({ op: 'workflow_get', id: w.id })
    await saveWorkflow({ ...wGot, name: 'Renamed' })
    expect((await workflows.get(w.id))?.name).toBe('Renamed')
    // The same agent put into another step, or a new one, is a pick again; its own step may keep it.
    const wAgain = await runJson({ op: 'workflow_get', id: w.id })
    const step = (handle: string) => ({ handle, kind: 'agent', agent: 'remote-one', prompt: 'Go', cwd: '/work' })
    await expect(
      saveWorkflow({
        ...wAgain,
        steps: [step('find'), step('other')],
        edges: [
          { from: 'trigger', to: 'find' },
          { from: 'find', to: 'other' }
        ]
      })
    ).rejects.toThrow(PICK)
    await expect(saveWorkflow({ ...wAgain, steps: [step('renamed')], edges: [{ from: 'trigger', to: 'renamed' }] })).rejects.toThrow(PICK)
    await saveWorkflow({ ...wAgain, steps: [step('find')], edges: [{ from: 'trigger', to: 'find' }] })
    // Moving a routine onto a remote agent it did not hold is still a pick.
    agents.push({ ...remote, name: 'remote-two', filePath: '/agents/remote-two.md' })
    const again = await runJson({ op: 'routine_get', id: r.id })
    await expect(
      saveRoutine({ id: r.id, updatedAt: again.updatedAt, target: { kind: 'new-chat', agent: 'remote-two', cwd: '/work' } })
    ).rejects.toThrow('Zumi Bot does not pick remote-two')
  })
})

describe('a turn the user did not type', () => {
  it('is refused every write before anything is looked up', async () => {
    const writes: AutomationCall[] = [
      { op: 'routine_save', routine: daily({ id: 'gone', updatedAt: 1 }) },
      { op: 'routine_delete', id: 'gone', name: 'x' },
      { op: 'workflow_save', workflow: flow({ id: 'gone', updatedAt: 1 }) },
      { op: 'workflow_delete', id: 'gone', name: 'x' }
    ]
    for (const call of writes) await expect(run(call, routineRun)).rejects.toThrow(WRITE_REFUSED)
    expect(asked).toEqual([])
    expect(await routines.list()).toEqual([])
    expect(await workflows.list()).toEqual([])
  })

  it('still reads', async () => {
    expect(await runJson({ op: 'routines_list' }, routineRun)).toEqual([])
    expect(await runJson({ op: 'workflows_list' }, routineRun)).toEqual([])
  })
})

describe('agent names', () => {
  it('resolves a display name to the agent, before the folder default is filled from it', async () => {
    const r = await saveRoutine(daily({ target: { kind: 'new-chat', agent: 'X Expert' } }))
    expect((await routines.get(r.id))?.target).toEqual({ kind: 'new-chat', agent: 'x-expert', cwd: '/home/u/x' })
  })

  it('resolves a name in any case, with a leading @', async () => {
    const r = await saveRoutine(daily({ target: { kind: 'new-chat', agent: '@X-EXPERT' } }))
    expect((await routines.get(r.id))?.target).toMatchObject({ agent: 'x-expert' })
  })

  it('resolves every room member', async () => {
    const r = await saveRoutine(daily({ target: { kind: 'new-group', members: ['X Expert', 'medium-writer'], role: '' } }))
    expect((await routines.get(r.id))?.target).toEqual({
      kind: 'new-group',
      members: ['x-expert', 'medium-writer'],
      role: '',
      cwd: '/home/u/rooms'
    })
  })

  it('refuses an unknown agent, listing the loadable ones without Zumi Bot', async () => {
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: 'nobody' } }))).rejects.toThrow(
      'Unknown agent "nobody". Agents: medium-writer, x-expert'
    )
    expect(await routines.list()).toEqual([])
  })

  it('treats a broken agent as unknown', async () => {
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: 'broken-one' } }))).rejects.toThrow('Unknown agent "broken-one"')
  })

  it('refuses a name that matches several agents', async () => {
    agents = [agent('x-expert'), agent('X-Expert')]
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: 'x-EXPERT' } }))).rejects.toThrow(
      'Unknown agent "x-EXPERT". Agents: X-Expert, x-expert'
    )
  })

  it('echoes an odd name only in plain characters', async () => {
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: 'a"b<c>' } }))).rejects.toThrow('Unknown agent "a?b?c?"')
  })

  // The bridge passes on only short plain sentences (letters, digits, basic punctuation, quotes, slashes; at most 400).
  it('cuts a long roster so the refusal still reaches the agent', async () => {
    agents = Array.from({ length: 40 }, (_, i) => agent(`agent-with-a-long-name-${String(i).padStart(2, '0')}`))
    const error = await saveRoutine(daily({ target: { kind: 'new-chat', agent: 'nobody' } })).catch((e: Error) => e.message)
    expect(error).toMatch(/^Unknown agent "nobody"\. Agents: agent-with-a-long-name-00, .*, and \d+ more$/)
    expect(error).toMatch(/^[A-Za-z0-9 .,:;'(){}?“”"/-]{1,400}$/)
  })

  it('refuses Zumi Bot as a routine agent or room member', async () => {
    await expect(saveRoutine(daily({ target: { kind: 'new-chat', agent: ZUMI_BOT_NAME } }))).rejects.toThrow(
      "Zumi Bot can't run routines or workflow steps"
    )
    await expect(saveRoutine(daily({ target: { kind: 'new-group', members: ['Zumi Bot', 'x-expert'], role: '' } }))).rejects.toThrow(
      "Zumi Bot can't run routines or workflow steps"
    )
  })

  it('refuses Zumi Bot as a workflow step agent', async () => {
    const steps = [{ handle: 'find', kind: 'agent', agent: 'Zumi Bot', prompt: 'p' }]
    await expect(saveWorkflow(flow({ steps, edges: [{ from: 'trigger', to: 'find' }] }))).rejects.toThrow(
      "Zumi Bot can't run routines or workflow steps"
    )
    expect(await workflows.list()).toEqual([])
  })
})

describe('routines', () => {
  it('creates one, switched on, and gives its path', async () => {
    const r = await saveRoutine(daily())
    expect(Object.keys(r).sort()).toEqual(['enabled', 'id', 'name', 'nextRunAt', 'path', 'timeZone'])
    expect(r).toMatchObject({ name: 'Daily tech hashtags', enabled: true, timeZone: 'UTC', path: `/routines/${r.id}` })
    const stored = await routines.get(r.id)
    expect(r.nextRunAt).toBe(new Date(stored!.nextRunAt!).toISOString())
    expect(stored).toMatchObject({ timeZone: 'UTC', limitPolicy: 'wait', missedPolicy: 'run-once', sessionPolicy: 'continue' })
  })

  it('reads one in the authoring format, with updatedAt and path', async () => {
    const r = await saveRoutine(daily())
    const got = await runJson({ op: 'routine_get', id: r.id })
    const stored = await routines.get(r.id)
    expect(got).toMatchObject({
      id: r.id,
      updatedAt: stored!.updatedAt,
      path: `/routines/${r.id}`,
      target: { kind: 'new-chat', agent: 'x-expert' }
    })
    expect(got).not.toHaveProperty('nextRunAt')
  })

  it('lists them with a trigger and target summary', async () => {
    const r = await saveRoutine(daily())
    const rows = await runJson({ op: 'routines_list' })
    expect(rows).toEqual([
      {
        id: r.id,
        name: 'Daily tech hashtags',
        enabled: true,
        timeZone: 'UTC',
        trigger: 'Every day at 9:00 AM (UTC)',
        target: 'New chat with @x-expert',
        nextRunAt: r.nextRunAt,
        path: `/routines/${r.id}`
      }
    ])
  })

  it('edits by get, change, save', async () => {
    const r = await saveRoutine(daily())
    const got = await runJson({ op: 'routine_get', id: r.id })
    const saved = await saveRoutine({ ...got, prompt: 'Something else' })
    expect(saved.id).toBe(r.id)
    expect((await routines.get(r.id))?.prompt).toBe('Something else')
    expect(await routines.list()).toHaveLength(1)
  })

  it('keeps the stored command pick on an edit while the prompt still starts with its name', async () => {
    const now = Date.now()
    const stored: Routine = {
      id: '0d8e7a52-3a40-4bd5-8a8f-9a3a4f3f1a11',
      name: 'Check',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], role: '', cwd: '/work' },
      prompt: '/check today',
      command: { agent: 'x-expert', name: 'check' },
      nextRunAt: null,
      createdAt: now,
      updatedAt: now
    }
    await routines.put(stored)
    const got = await runJson({ op: 'routine_get', id: stored.id })
    await saveRoutine({ ...got, prompt: '/check tomorrow' })
    expect((await routines.get(stored.id))?.command).toEqual({ agent: 'x-expert', name: 'check' })
    const again = await runJson({ op: 'routine_get', id: stored.id })
    await saveRoutine({ ...again, prompt: 'By hand now' })
    expect((await routines.get(stored.id))?.command).toBeUndefined()
  })

  it('refuses a stale edit and changes nothing', async () => {
    const r = await saveRoutine(daily())
    const got = await runJson({ op: 'routine_get', id: r.id })
    await expect(saveRoutine({ ...got, updatedAt: got.updatedAt - 1, prompt: 'Overwrite' })).rejects.toThrow(STALE_REFUSED)
    expect((await routines.get(r.id))?.prompt).toBe(daily().prompt)
  })

  it('refuses an edit that does not say which version it read', async () => {
    const r = await saveRoutine(daily())
    const { updatedAt: _read, ...got } = await runJson({ op: 'routine_get', id: r.id })
    await expect(saveRoutine({ ...got, prompt: 'Overwrite' })).rejects.toThrow(/read it first/)
    expect((await routines.get(r.id))?.prompt).toBe(daily().prompt)
  })

  it('refuses an updatedAt that is not the number the get returned', async () => {
    const r = await saveRoutine(daily())
    const got = await runJson({ op: 'routine_get', id: r.id })
    const refused = await saveRoutine({ ...got, updatedAt: String(got.updatedAt), prompt: 'Overwrite' }).catch((e: Error) => e.message)
    expect(refused).toBe('updatedAt must be the number the get returned')
    expect(refused).toMatch(PLAIN)
    expect((await routines.get(r.id))?.prompt).toBe(daily().prompt)
    const w = await saveWorkflow(flow())
    const wGot = await runJson({ op: 'workflow_get', id: w.id })
    await expect(saveWorkflow({ ...wGot, updatedAt: { at: wGot.updatedAt }, name: 'X' })).rejects.toThrow(
      'updatedAt must be the number the get returned'
    )
    expect((await workflows.get(w.id))?.name).toBe('Hashtags')
  })

  it('refuses an unknown id', async () => {
    await expect(saveRoutine(daily({ id: '0d8e7a52-3a40-4bd5-8a8f-000000000000', updatedAt: 1 }))).rejects.toThrow(
      'No routine with that id'
    )
    await expect(run({ op: 'routine_get', id: 'nope' })).rejects.toThrow('No routine with that id')
    expect(await routines.list()).toEqual([])
  })

  it('makes a webhook routine with its hook, and no result carries the URL or secret', async () => {
    const r = await run({ op: 'routine_save', routine: daily({ trigger: { kind: 'webhook' } }) })
    const { id } = JSON.parse(r)
    expect((await routines.hook(id))?.secret).toBe(SECRET)
    expect((await routines.get(id))?.enabled).toBe(true)
    const texts = [r, await run({ op: 'routine_get', id }), await run({ op: 'routines_list' })]
    for (const t of texts) {
      expect(t).not.toContain('secret')
      expect(t).not.toContain('url')
      expect(t).not.toContain(SECRET)
      expect(t).not.toContain('/hooks/')
    }
  })

  it('posts into an existing chat named by its address', async () => {
    chats.set('abc-123', { meta: chatMeta(), items: [] })
    const r = await saveRoutine(daily({ target: { kind: 'chat', chatId: '/chat/abc-123' } }))
    expect((await routines.get(r.id))?.target).toEqual({ kind: 'chat', chatId: 'abc-123' })
    expect((await runJson({ op: 'routines_list' }))[0].target).toBe('Chat "Fix the build" (abc-123)')
    await expect(saveRoutine(daily({ target: { kind: 'chat', chatId: 'not-a-chat' } }))).rejects.toThrow('No chat with that id')
  })

  it('refuses to post into an A→B ask chat, which is read-only', async () => {
    chats.set('ab-1', {
      meta: { ...chatMeta(), id: 'ab-1', asked: { by: 'medium-writer', from: 'abc-123', fromTitle: 'Fix the build', chain: [] } },
      items: []
    })
    const refused = await saveRoutine(daily({ target: { kind: 'chat', chatId: '/chat/ab-1' } })).catch((e: Error) => e.message)
    expect(refused).toBe('That chat is read-only: routines cannot post into it')
    expect(refused).toMatch(PLAIN)
    expect(await routines.list()).toEqual([])
  })

  it('deletes only when the name still matches the id', async () => {
    const r = await saveRoutine(daily())
    await expect(run({ op: 'routine_delete', id: r.id, name: 'Old name' })).rejects.toThrow(
      'That id is now named “Daily tech hashtags”: check with the user.'
    )
    expect(await routines.get(r.id)).not.toBeNull()
    expect(await runJson({ op: 'routine_delete', id: r.id, name: 'Daily tech hashtags' })).toEqual({ deleted: 'Daily tech hashtags' })
    expect(await routines.get(r.id)).toBeNull()
    await expect(run({ op: 'routine_delete', id: r.id, name: 'Daily tech hashtags' })).rejects.toThrow('No routine with that id')
  })

  it('echoes a stored name in plain characters when it refuses a delete', async () => {
    const r = await saveRoutine(daily({ name: 'Posts “daily” <b>' }))
    await expect(run({ op: 'routine_delete', id: r.id, name: 'Posts' })).rejects.toThrow(
      'That id is now named “Posts ?daily? ?b?”: check with the user.'
    )
  })
})

describe('workflows', () => {
  it('creates one, switched on, with its path and the step agent resolved', async () => {
    const w = await saveWorkflow(flow({ steps: [{ ...flow().steps[0], agent: 'X Expert' }, flow().steps[1]] }))
    expect(w).toEqual({
      id: w.id,
      name: 'Hashtags',
      enabled: true,
      timeZone: 'UTC',
      nextRunAt: null,
      problems: [],
      path: `/workflows/${w.id}`
    })
    expect((await workflows.get(w.id))?.steps.find((s) => s.handle === 'find')).toMatchObject({ agent: 'x-expert' })
  })

  it('saves one with a problem off, and says what the problem is', async () => {
    const steps = [flow().steps[0], { ...flow().steps[1], body: '{{steps.nope.output}}' }]
    const w = await saveWorkflow(flow({ steps }))
    expect(w.enabled).toBe(false)
    expect(w.problems).toEqual(['Step "tell": No step has the handle "nope"'])
    expect((await workflows.get(w.id))?.enabled).toBe(false)
  })

  it('reads one with updatedAt, problems and path, and saves it back unchanged in place', async () => {
    const w = await saveWorkflow(flow())
    const before = await workflows.get(w.id)
    const got = await runJson({ op: 'workflow_get', id: w.id })
    expect(got).toMatchObject({ id: w.id, updatedAt: before!.updatedAt, problems: [], path: `/workflows/${w.id}` })
    await saveWorkflow({ ...got, name: 'Renamed' })
    const after = await workflows.get(w.id)
    expect(after?.name).toBe('Renamed')
    expect(after?.steps.map((s) => s.id)).toEqual(before!.steps.map((s) => s.id))
  })

  it('lists them with the trigger, step count and problems', async () => {
    const w = await saveWorkflow(flow())
    expect(await runJson({ op: 'workflows_list' })).toEqual([
      {
        id: w.id,
        name: 'Hashtags',
        enabled: true,
        timeZone: 'UTC',
        trigger: 'Manual',
        steps: 2,
        problems: [],
        nextRunAt: null,
        path: `/workflows/${w.id}`
      }
    ])
  })

  it('lists an event trigger by its label, and get shows it in the authoring form without an email account', async () => {
    const kinds: [Record<string, unknown>, string][] = [
      [{ kind: 'reply', filters: [] }, 'Reply ended'],
      [{ kind: 'todo', filters: [] }, 'To-do added'],
      [{ kind: 'inbox', filters: [] }, 'Inbox message'],
      [{ kind: 'file', path: '/tmp/in' }, 'File changed'],
      [{ kind: 'email', host: 'imap.example.com' }, 'Email arrived']
    ]
    for (const [trigger, label] of kinds) {
      const w = await saveWorkflow(flow({ name: label, trigger }))
      expect((await runJson({ op: 'workflows_list' })).find((x: { id: string }) => x.id === w.id)?.trigger).toBe(label)
      expect((await runJson({ op: 'workflow_get', id: w.id })).trigger.kind).toBe(trigger.kind)
    }
  })

  it('refuses a stale edit, one with no updatedAt, and an unknown id', async () => {
    const w = await saveWorkflow(flow())
    const got = await runJson({ op: 'workflow_get', id: w.id })
    await expect(saveWorkflow({ ...got, updatedAt: got.updatedAt + 1, name: 'X' })).rejects.toThrow(STALE_REFUSED)
    const { updatedAt: _read, ...unread } = got
    await expect(saveWorkflow({ ...unread, name: 'X' })).rejects.toThrow(/read it first/)
    expect((await workflows.get(w.id))?.name).toBe('Hashtags')
    await expect(saveWorkflow(flow({ id: 'gone', updatedAt: 1 }))).rejects.toThrow('No workflow with that id')
    await expect(run({ op: 'workflow_get', id: 'gone' })).rejects.toThrow('No workflow with that id')
  })

  it('makes a webhook workflow with its hook, and no result carries the URL or secret', async () => {
    const r = await run({ op: 'workflow_save', workflow: flow({ trigger: { kind: 'webhook' } }) })
    const { id } = JSON.parse(r)
    expect((await workflows.hooks.hook(id))?.secret).toBe(SECRET)
    for (const t of [r, await run({ op: 'workflow_get', id }), await run({ op: 'workflows_list' })]) {
      expect(t).not.toContain('secret')
      expect(t).not.toContain('url')
      expect(t).not.toContain(SECRET)
    }
  })

  it('deletes only when the name still matches the id', async () => {
    const w = await saveWorkflow(flow())
    await expect(run({ op: 'workflow_delete', id: w.id, name: 'Other' })).rejects.toThrow(
      'That id is now named “Hashtags”: check with the user.'
    )
    expect(await runJson({ op: 'workflow_delete', id: w.id, name: 'Hashtags' })).toEqual({ deleted: 'Hashtags' })
    expect(await workflows.get(w.id)).toBeNull()
    await expect(run({ op: 'workflow_delete', id: w.id, name: 'Hashtags' })).rejects.toThrow('No workflow with that id')
  })
})

// The ruling: on an edit, a key the agent leaves out keeps the stored value; the create-time defaults are for a create.
describe('an edit keeps what the agent left out', () => {
  const without = (o: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

  it('a disabled routine stays off when enabled is not sent', async () => {
    const r = await saveRoutine(daily({ enabled: false }))
    const got = await runJson({ op: 'routine_get', id: r.id })
    const saved = await saveRoutine({ ...without(got, 'enabled'), prompt: 'Something else' })
    expect(saved.enabled).toBe(false)
    expect(await routines.get(r.id)).toMatchObject({ enabled: false, prompt: 'Something else' })
  })

  it('a routine keeps its time zone and policies when they are not sent', async () => {
    const r = await saveRoutine(daily({ timeZone: 'Asia/Tokyo', limitPolicy: 'skip', missedPolicy: 'skip', sessionPolicy: 'fresh' }))
    const got = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...without(got, 'timeZone', 'limitPolicy', 'missedPolicy', 'sessionPolicy'), prompt: 'Something else' })
    expect(await routines.get(r.id)).toMatchObject({
      timeZone: 'Asia/Tokyo',
      limitPolicy: 'skip',
      missedPolicy: 'skip',
      sessionPolicy: 'fresh'
    })
    // null reads as left out, as it does on a create.
    const again = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...again, timeZone: null, limitPolicy: null, prompt: 'Third' })
    expect(await routines.get(r.id)).toMatchObject({ timeZone: 'Asia/Tokyo', limitPolicy: 'skip', prompt: 'Third' })
  })

  it("a routine keeps its folder when the target's agent stays; another agent gets that agent's default", async () => {
    const r = await saveRoutine(daily({ target: { kind: 'new-chat', agent: 'x-expert', cwd: '/srv/app' } }))
    const got = await runJson({ op: 'routine_get', id: r.id })
    // A display name is resolved first, so it is the same agent.
    await saveRoutine({ ...got, target: { kind: 'new-chat', agent: 'X Expert' } })
    expect((await routines.get(r.id))?.target).toEqual({ kind: 'new-chat', agent: 'x-expert', cwd: '/srv/app' })
    const again = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...again, target: { kind: 'new-chat', agent: 'x-expert', cwd: ' ' } })
    expect((await routines.get(r.id))?.target).toMatchObject({ cwd: '/srv/app' })
    const third = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...third, target: { kind: 'new-chat', agent: 'medium-writer' } })
    expect((await routines.get(r.id))?.target).toEqual({ kind: 'new-chat', agent: 'medium-writer', cwd: '/home/u' })
  })

  it('a room keeps its folder when its members change', async () => {
    const r = await saveRoutine(
      daily({ target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], role: 'Pair', cwd: '/srv/room' } })
    )
    const got = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...got, target: { kind: 'new-group', members: ['medium-writer', 'x-expert'] } })
    expect((await routines.get(r.id))?.target).toMatchObject({
      kind: 'new-group',
      members: ['medium-writer', 'x-expert'],
      cwd: '/srv/room'
    })
  })

  it('a target sent without its title or section keeps them; null clears them, another kind drops them', async () => {
    const room = {
      kind: 'new-group',
      members: ['x-expert', 'medium-writer'],
      role: '',
      cwd: '/srv/room',
      title: 'Standup',
      section: 'sec-1'
    }
    const r = await saveRoutine(daily({ target: room }))
    expect((await routines.get(r.id))?.target).toEqual(room)
    const got = await runJson({ op: 'routine_get', id: r.id })
    expect(got.target).toEqual(room)
    await saveRoutine({ ...got, target: { kind: 'new-group', members: ['medium-writer', 'x-expert'] } })
    expect((await routines.get(r.id))?.target).toEqual({ ...room, members: ['medium-writer', 'x-expert'] })
    const again = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...again, target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], title: null, section: null } })
    expect((await routines.get(r.id))?.target).toEqual({
      kind: 'new-group',
      members: ['x-expert', 'medium-writer'],
      role: '',
      cwd: '/srv/room'
    })
    const titled = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({
      ...titled,
      target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], title: 'Standup', section: 'sec-1' }
    })
    const third = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...third, target: { kind: 'new-chat', agent: 'x-expert' } })
    expect((await routines.get(r.id))?.target).toEqual({ kind: 'new-chat', agent: 'x-expert', cwd: '/home/u/x' })
  })

  it('a spend cap stays when left out, and null clears it, for routines and workflows alike', async () => {
    const r = await saveRoutine(daily({ spendCap: 3 }))
    expect((await routines.get(r.id))?.spendCap).toBe(3)
    const got = await runJson({ op: 'routine_get', id: r.id })
    expect(got.spendCap).toBe(3)
    await saveRoutine({ ...without(got, 'spendCap'), prompt: 'Other' })
    expect((await routines.get(r.id))?.spendCap).toBe(3)
    const again = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ ...again, spendCap: null })
    expect(await routines.get(r.id)).not.toHaveProperty('spendCap')
    const w = await saveWorkflow({ ...flow(), spendCap: 7 })
    expect((await workflows.get(w.id))?.spendCap).toBe(7)
    const wGot = await runJson({ op: 'workflow_get', id: w.id })
    await saveWorkflow({ ...without(wGot, 'spendCap'), name: 'Renamed' })
    expect((await workflows.get(w.id))?.spendCap).toBe(7)
    const wAgain = await runJson({ op: 'workflow_get', id: w.id })
    await saveWorkflow({ ...wAgain, spendCap: null })
    expect(await workflows.get(w.id)).not.toHaveProperty('spendCap')
  })

  it('a routine edit may send only what changes', async () => {
    const r = await saveRoutine(daily({ enabled: false, timeZone: 'Asia/Tokyo' }))
    const { id, updatedAt } = await runJson({ op: 'routine_get', id: r.id })
    await saveRoutine({ id, updatedAt, prompt: 'Only this' })
    expect(await routines.get(r.id)).toMatchObject({
      name: 'Daily tech hashtags',
      enabled: false,
      timeZone: 'Asia/Tokyo',
      prompt: 'Only this',
      target: { kind: 'new-chat', agent: 'x-expert', cwd: '/home/u/x' },
      trigger: daily().trigger
    })
  })

  it('a disabled workflow stays off when enabled is not sent', async () => {
    const w = await saveWorkflow(flow({ enabled: false, timeZone: 'Asia/Tokyo' }))
    expect(w.enabled).toBe(false)
    const got = await runJson({ op: 'workflow_get', id: w.id })
    const saved = await saveWorkflow({ ...without(got, 'enabled', 'timeZone'), name: 'Renamed' })
    expect(saved.enabled).toBe(false)
    expect(await workflows.get(w.id)).toMatchObject({ enabled: false, timeZone: 'Asia/Tokyo', name: 'Renamed' })
  })

  it("an existing step's missing or blank folder keeps its stored one; a new step gets the agent's default", async () => {
    const w = await saveWorkflow(flow())
    const got = await runJson({ op: 'workflow_get', id: w.id })
    const steps = got.steps.map((s: { handle: string }) => (s.handle === 'find' ? { ...s, cwd: '' } : s))
    const added = { handle: 'more', kind: 'agent', agent: 'x-expert', prompt: 'More.' }
    await saveWorkflow({ ...got, steps: [...steps, added], edges: [...got.edges, { from: 'tell', to: 'more' }] })
    const stored = await workflows.get(w.id)
    expect(stored?.steps.find((s) => s.handle === 'find')).toMatchObject({ cwd: '/work' })
    expect(stored?.steps.find((s) => s.handle === 'more')).toMatchObject({ cwd: '/home/u/x' })
    const again = await runJson({ op: 'workflow_get', id: w.id })
    const noCwd = again.steps.map((s: Record<string, unknown>) => (s.handle === 'find' ? without(s, 'cwd') : s))
    await saveWorkflow({ ...again, steps: noCwd })
    expect((await workflows.get(w.id))?.steps.find((s) => s.handle === 'find')).toMatchObject({ cwd: '/work' })
  })

  it('a step whose kind changed takes no stored folder', async () => {
    const w = await saveWorkflow(flow())
    const got = await runJson({ op: 'workflow_get', id: w.id })
    const steps = got.steps.map((s: { handle: string }) => (s.handle === 'find' ? { handle: 'find', kind: 'llm', prompt: 'Think.' } : s))
    await saveWorkflow({ ...got, steps })
    expect((await workflows.get(w.id))?.steps.find((s) => s.handle === 'find')).not.toHaveProperty('cwd')
  })

  it('enabled sent as true still switches it on', async () => {
    const r = await saveRoutine(daily({ enabled: false }))
    const got = await runJson({ op: 'routine_get', id: r.id })
    expect((await saveRoutine({ ...got, enabled: true })).enabled).toBe(true)
    const w = await saveWorkflow(flow({ enabled: false }))
    const wGot = await runJson({ op: 'workflow_get', id: w.id })
    expect((await saveWorkflow({ ...wGot, enabled: true })).enabled).toBe(true)
  })

  it('a create still defaults to on, in the user time zone', async () => {
    expect(await saveRoutine(daily())).toMatchObject({ enabled: true, timeZone: 'UTC' })
    expect(await saveWorkflow(flow())).toMatchObject({ enabled: true, timeZone: 'UTC' })
  })
})

function chatMeta(): ChatMeta {
  return {
    id: 'abc-123',
    agentName: 'x-expert',
    sessionId: null,
    cwd: '/work/app',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 2,
    inFlight: false
  }
}

describe('chat_read', () => {
  it('returns the transcript text of a chat named by its address', async () => {
    chats.set('abc-123', { meta: chatMeta(), items: [{ type: 'user', id: 'u1', text: 'Run the build', ts: 1 } as ChatItem] })
    const text = await run({ op: 'chat_read', chat: 'https://bot.example.com/chat/abc-123' })
    expect(text.startsWith('<chat id="abc-123">')).toBe(true)
    expect(text).toContain('[user] Run the build')
  })

  it('refuses a chat that does not exist or an address that names none', async () => {
    await expect(run({ op: 'chat_read', chat: 'abc-123' })).rejects.toThrow('No chat with that id')
    await expect(run({ op: 'chat_read', chat: '/routines/abc' })).rejects.toThrow('No chat with that id')
  })
})

describe('Room steps', () => {
  const ROOM = 'room-1'
  const roomMeta = (): ChatMeta =>
    ({ ...chatMeta(), id: ROOM, title: 'Design room', group: { members: ['x-expert'], role: '' } }) as ChatMeta
  const roomFlow = (room: string) => ({
    name: 'Panel flow',
    trigger: { kind: 'manual' },
    steps: [{ handle: 'panel', name: 'Panel', kind: 'room', room }],
    edges: [{ from: 'trigger', to: 'panel' }]
  })

  it('refuses a room that does not exist or a chat that is no room', async () => {
    await expect(saveWorkflow(roomFlow(ROOM))).rejects.toThrow('Room not found')
    chats.set('plain-1', { meta: { ...chatMeta(), id: 'plain-1' }, items: [] })
    await expect(saveWorkflow(roomFlow('/chat/plain-1'))).rejects.toThrow('Room not found')
  })

  it('saves a room named by its link, and workflow_get gives its title, or null once it is gone', async () => {
    chats.set(ROOM, { meta: roomMeta(), items: [] })
    const w = await saveWorkflow(roomFlow(`https://bot.example.com/chat/${ROOM}`))
    expect((await workflows.get(w.id))?.steps.find((s) => s.handle === 'panel')).toMatchObject({
      kind: 'room',
      room: ROOM,
      prompt: '{{input}}'
    })
    const got = await runJson({ op: 'workflow_get', id: w.id })
    expect(got.steps.find((s: { handle: string }) => s.handle === 'panel')).toMatchObject({ room: ROOM, roomTitle: 'Design room' })
    expect(JSON.stringify(got)).not.toContain('rules')
    chats.delete(ROOM)
    const gone = await runJson({ op: 'workflow_get', id: w.id })
    expect(gone.steps.find((s: { handle: string }) => s.handle === 'panel').roomTitle).toBeNull()
    // Saving what the get returned back is not blocked by the room being gone: the room is unchanged.
    await expect(saveWorkflow({ ...gone, name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' })
  })

  it('keeps the stored rules when an edit sends its own', async () => {
    chats.set(ROOM, { meta: roomMeta(), items: [] })
    const w = await saveWorkflow(roomFlow(ROOM))
    await workflows.update(w.id, (stored) => ({
      ...stored,
      steps: stored.steps.map((s) => (s.kind === 'room' ? { ...s, rules: [{ tool: 'Bash', command: 'ls' }] } : s))
    }))
    const got = await runJson({ op: 'workflow_get', id: w.id })
    await saveWorkflow({ ...got, steps: got.steps.map((s: object) => ({ ...s, rules: [{ tool: 'Write' }] })) })
    expect((await workflows.get(w.id))?.steps.find((s) => s.kind === 'room')).toMatchObject({ rules: [{ tool: 'Bash', command: 'ls' }] })
  })
})

describe('Chat steps, rooms from agents and run settings', () => {
  const CHAT = 'chat-1'
  const chatFlow = (chat: string, o: object = {}) => ({
    name: 'Post flow',
    trigger: { kind: 'manual' },
    steps: [{ handle: 'post', name: 'Post', kind: 'chat', chat, ...o }],
    edges: [{ from: 'trigger', to: 'post' }]
  })

  it('round trips a chat step by link, a room from agents, a kept agent and both settings through save and get', async () => {
    chats.set(CHAT, { meta: { ...chatMeta(), id: CHAT }, items: [] })
    const w = await saveWorkflow({
      name: 'All',
      trigger: { kind: 'manual' },
      limitPolicy: 'skip',
      missedPolicy: 'skip',
      steps: [
        { handle: 'post', kind: 'chat', chat: `https://bot.example.com/chat/${CHAT}`, session: 'fresh' },
        { handle: 'panel', kind: 'room', members: ['@X Expert', 'medium-writer'], role: 'Review', keep: true, title: 'Panel' },
        { handle: 'solo', kind: 'agent', agent: 'x-expert', prompt: 'go', keep: true, title: 'Notes' }
      ],
      edges: [
        { from: 'trigger', to: 'post' },
        { from: 'post', to: 'panel' },
        { from: 'panel', to: 'solo' }
      ]
    })
    expect(w.problems).toEqual([])
    const stored = await workflows.get(w.id)
    expect(stored).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    expect(stored?.steps.find((s) => s.handle === 'panel')).toMatchObject({
      members: ['x-expert', 'medium-writer'],
      cwd: '/home/u/rooms',
      keep: true,
      title: 'Panel'
    })
    const got = await runJson({ op: 'workflow_get', id: w.id })
    expect(got).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    const step = (h: string) => got.steps.find((s: { handle: string }) => s.handle === h)
    expect(step('post')).toMatchObject({ chat: CHAT, session: 'fresh' })
    expect(step('panel')).toMatchObject({ members: ['x-expert', 'medium-writer'], role: 'Review', keep: true, title: 'Panel' })
    expect(step('panel')).not.toHaveProperty('roomTitle')
    expect(step('solo')).toMatchObject({ keep: true, title: 'Notes' })
    // get, change, save works.
    await expect(saveWorkflow({ ...got, name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' })
  })

  it('an edit keeps what it leaves out: the settings, the stored section and the room folder', async () => {
    const w = await saveWorkflow({
      ...chatFlow('x'),
      limitPolicy: 'skip',
      missedPolicy: 'skip',
      steps: [{ handle: 'panel', kind: 'room', members: ['x-expert', 'medium-writer'], keep: true }],
      edges: [{ from: 'trigger', to: 'panel' }]
    })
    await workflows.update(w.id, (s) => ({
      ...s,
      steps: s.steps.map((x) => (x.kind === 'room' ? { ...x, section: 'sec-1', cwd: '/srv/rooms' } : x))
    }))
    const got = await runJson({ op: 'workflow_get', id: w.id })
    expect(JSON.stringify(got)).not.toContain('sec-1')
    const without = Object.fromEntries(Object.entries(got).filter(([k]) => k !== 'limitPolicy' && k !== 'missedPolicy'))
    await saveWorkflow({ ...without, steps: got.steps.map((s: object) => ({ ...s, cwd: undefined, title: 'Now titled' })) })
    const after = await workflows.get(w.id)
    expect(after).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    expect(after?.steps.find((s) => s.kind === 'room')).toMatchObject({ section: 'sec-1', cwd: '/srv/rooms', title: 'Now titled' })
    // wait clears the stored skip.
    await saveWorkflow({ ...(await runJson({ op: 'workflow_get', id: w.id })), limitPolicy: 'wait' })
    expect(await workflows.get(w.id)).not.toHaveProperty('limitPolicy')
  })

  it('an edit that omits members keeps them with the role and folder, and is not saved off', async () => {
    const w = await saveWorkflow({
      name: 'Panel',
      trigger: { kind: 'manual' },
      steps: [{ handle: 'panel', kind: 'room', members: ['x-expert', 'medium-writer'], role: 'Review', cwd: '/srv/rooms' }],
      edges: [{ from: 'trigger', to: 'panel' }]
    })
    const got = await runJson({ op: 'workflow_get', id: w.id })
    const bare = got.steps.map((s: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !['members', 'role', 'cwd'].includes(k)))
    )
    expect((await saveWorkflow({ ...got, steps: bare })).problems).toEqual([])
    expect((await workflows.get(w.id))?.steps.find((s) => s.kind === 'room')).toMatchObject({
      members: ['x-expert', 'medium-writer'],
      role: 'Review',
      cwd: '/srv/rooms'
    })
    const again = await runJson({ op: 'workflow_get', id: w.id })
    await saveWorkflow({ ...again, steps: bare.map((s: object) => ({ ...s, role: 'Audit' })) })
    expect((await workflows.get(w.id))?.steps.find((s) => s.kind === 'room')).toMatchObject({
      members: ['x-expert', 'medium-writer'],
      role: 'Audit',
      cwd: '/srv/rooms'
    })
  })

  it('refuses a chat id that is an A to B chat with the read-only text, and one that does not exist', async () => {
    chats.set(CHAT, {
      meta: { ...chatMeta(), id: CHAT, asked: { by: 'a', from: 'src', fromTitle: 't', chain: [] } } as ChatMeta,
      items: []
    })
    const err = await saveWorkflow(chatFlow(CHAT)).then(
      () => '',
      (e: Error) => e.message
    )
    expect(err).toBe('This chat is read-only')
    expect(err).toMatch(PLAIN)
    await expect(saveWorkflow(chatFlow('missing-1'))).rejects.toThrow('Chat not found')
  })

  it('refuses a workflow chat, and a single chat whose agent is Zumi Bot, with the editor texts', async () => {
    chats.set(CHAT, {
      meta: { ...chatMeta(), id: CHAT, workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'n' } } as ChatMeta,
      items: []
    })
    await expect(saveWorkflow(chatFlow(CHAT))).rejects.toThrow('This chat belongs to a workflow')
    chats.set('bot-1', { meta: { ...chatMeta(), id: 'bot-1', agentName: ZUMI_BOT_NAME }, items: [] })
    const err = await saveWorkflow(chatFlow('bot-1')).then(
      () => '',
      (e: Error) => e.message
    )
    expect(err).toBe('Zumi Bot cannot be a workflow step')
  })

  it('a chat the workflow already held is left alone when it is gone or turned read-only', async () => {
    chats.set(CHAT, { meta: { ...chatMeta(), id: CHAT }, items: [] })
    const w = await saveWorkflow(chatFlow(CHAT))
    chats.delete(CHAT)
    const got = await runJson({ op: 'workflow_get', id: w.id })
    await expect(saveWorkflow({ ...got, name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' })
  })

  it('refuses Zumi Bot among the members with the same sentence as an agent step, and an unknown member', async () => {
    const panel = (members: string[]) => ({
      name: 'Panel',
      trigger: { kind: 'manual' },
      steps: [{ handle: 'panel', kind: 'room', members }],
      edges: [{ from: 'trigger', to: 'panel' }]
    })
    const err = await saveWorkflow(panel([ZUMI_BOT_NAME, 'a'])).then(
      () => '',
      (e: Error) => e.message
    )
    expect(err).toBe("Zumi Bot can't run routines or workflow steps")
    expect(err).toMatch(PLAIN)
    await expect(saveWorkflow(panel(['x-expert', 'nobody']))).rejects.toThrow('Unknown agent "nobody"')
  })

  it('saves a room with one member off, since problemsOf asks for two', async () => {
    const saved = await saveWorkflow({
      name: 'Lonely',
      trigger: { kind: 'manual' },
      steps: [{ handle: 'panel', kind: 'room', members: ['x-expert'] }],
      edges: [{ from: 'trigger', to: 'panel' }]
    })
    expect(saved.enabled).toBe(false) // a workflow with problems is saved off
    expect(saved.problems.join(' ')).toContain('Pick at least two agents')
  })
})
