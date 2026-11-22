import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepRule, Workflow, WorkflowInput } from '@zumibot/shared/workflows'
import type { WorkflowLink } from '@zumibot/shared/types'
import { ChatStore } from '../../src/core/store/chatStore'
import { stepRuleSaver } from '../../src/core/workflows/stepRuleSave'

let tmp: string
let store: ChatStore
let stored: Workflow | null
let save: ReturnType<typeof vi.fn<(input: WorkflowInput) => Promise<unknown>>>
let n: number

const room = (over: Record<string, unknown> = {}) =>
  ({ id: 's', handle: 'room', name: 'Room', x: 1, y: 2, kind: 'room', room: 't', prompt: 'p', ...over }) as Workflow['steps'][number]
const workflow = (steps: Workflow['steps']): Workflow => ({
  id: 'w',
  name: 'Flow',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' } as Workflow['trigger'],
  steps,
  edges: [],
  notes: [],
  groups: [],
  nextRunAt: 9,
  createdAt: 1,
  updatedAt: 2
})
const link = (over: Partial<WorkflowLink> = {}): WorkflowLink => ({ workflowId: 'w', runId: 'r', stepId: 's', name: 'Flow', ...over })
const saver = () => stepRuleSaver({ chats: store, workflows: { get: async (id) => (stored && stored.id === id ? stored : null) }, save })
const copy = async (workflow?: WorkflowLink) => {
  const c = await store.createGroup(['a', 'b'], '/tmp/x', 'R')
  return workflow ? store.update(c.id, { workflow }) : c
}
const bash: StepRule = { tool: 'Bash', command: 'ls' }
const read: StepRule = { tool: 'Read' }

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'step-rule-save-'))
  n = 0
  store = new ChatStore(
    join(tmp, 'data'),
    () => 1000,
    () => `c${++n}`
  )
  stored = workflow([room()])
  save = vi.fn<(input: WorkflowInput) => Promise<unknown>>().mockImplementation(async (input) => {
    stored = { ...stored!, ...input, id: 'w' } as Workflow
  })
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('stepRuleSaver', () => {
  it('adds the rule to the copy and to the step, leaving the rest of the workflow as stored', async () => {
    const c = await copy(link())
    const before = stored!
    await saver()(c.id, bash)
    expect((await store.get(c.id))!.workflowRules).toEqual([bash])
    expect(save).toHaveBeenCalledTimes(1)
    const input = save.mock.calls[0][0]
    expect((input.steps[0] as { rules?: StepRule[] }).rules).toEqual([bash])
    expect(input).toEqual({
      id: before.id,
      name: before.name,
      enabled: before.enabled,
      timeZone: before.timeZone,
      trigger: before.trigger,
      steps: [{ ...before.steps[0], rules: [bash] }],
      edges: before.edges,
      notes: before.notes,
      groups: before.groups
    })
  })

  it("keeps the workflow's spend cap and run policies when it saves the rule", async () => {
    stored = { ...workflow([room()]), spendCap: 5, limitPolicy: 'skip', missedPolicy: 'skip' }
    const c = await copy(link())
    await saver()(c.id, bash)
    expect(save.mock.calls[0][0]).toMatchObject({ spendCap: 5, limitPolicy: 'skip', missedPolicy: 'skip' })
  })

  it('changes nothing for a rule already there', async () => {
    const c = await copy(link())
    await saver()(c.id, bash)
    save.mockClear()
    const upd = (await store.get(c.id))!.updatedAt
    await saver()(c.id, { ...bash })
    expect(save).not.toHaveBeenCalled()
    expect((await store.get(c.id))!.workflowRules).toEqual([bash])
    expect((await store.get(c.id))!.updatedAt).toBe(upd)
  })

  it('still updates the copy when the workflow is deleted, with no save and no throw', async () => {
    const c = await copy(link())
    stored = null
    await expect(saver()(c.id, bash)).resolves.toBeUndefined()
    expect((await store.get(c.id))!.workflowRules).toEqual([bash])
    expect(save).not.toHaveBeenCalled()
  })

  it('does not save when the step is gone or no longer a room step', async () => {
    const c = await copy(link())
    stored = workflow([])
    await saver()(c.id, bash)
    stored = workflow([room({ kind: 'agent', agent: 'a', cwd: '/x' })])
    await saver()(c.id, read)
    expect(save).not.toHaveBeenCalled()
  })

  it('writes nothing for a chat with no workflow link', async () => {
    const c = await copy()
    await saver()(c.id, bash)
    expect((await store.get(c.id))!.workflowRules).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps both of two rules saved at once', async () => {
    const c = await copy(link())
    const s = saver()
    await Promise.all([s(c.id, bash), s(c.id, read)])
    expect((await store.get(c.id))!.workflowRules).toEqual([bash, read])
    expect((stored!.steps[0] as { rules?: StepRule[] }).rules).toEqual([bash, read])
  })

  it("saves nothing for a rule past the step's cap, in the copy or the workflow", async () => {
    const full: StepRule[] = Array.from({ length: 100 }, (_, i) => ({ tool: 'Bash', command: `c${i}` }))
    stored = workflow([room({ rules: full })])
    const c = await copy(link())
    await store.patchInPlace(c.id, () => ({ workflowRules: full }))
    await saver()(c.id, { tool: 'Bash', command: 'one more' })
    expect(save).not.toHaveBeenCalled()
    expect((await store.get(c.id))!.workflowRules).toEqual(full)
  })

  it('saves nothing for a rule the parser would refuse', async () => {
    const c = await copy(link())
    await saver()(c.id, { tool: 'Bash', command: 'x'.repeat(5_000) })
    expect(save).not.toHaveBeenCalled()
    expect((await store.get(c.id))!.workflowRules).toBeUndefined()
  })
})
