import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Step, WorkflowInput } from '@zumibot/shared/workflows'
import type { Problem } from '@zumibot/shared/workflowGraph'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'
import { workflowEditing } from '../../src/core/workflows/workflowEditing'
import { HistoryStore } from '../../src/core/history/historyStore'
import type { WorkflowDef } from '@zumibot/shared/definitionHistory'

let dir: string
let store: WorkflowStore
let calls: string[]
let problems: Problem[]
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-workflow-editing-'))
  store = new WorkflowStore(dir)
  calls = []
  problems = []
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const editing = () =>
  workflowEditing({
    store,
    runner: {
      problems: async () => problems,
      stopAllOf: async (id: string) => {
        calls.push(`stop:${id}`)
      }
    },
    scheduler: {
      rearm: async () => {
        calls.push('rearm')
      }
    },
    changed: () => {
      calls.push('changed')
    },
    newSecret: () => 'a-secret-long-enough-1234'
  })
const agentStep = (): Step => ({ id: 's1', kind: 'agent', handle: 'one', name: 'One', x: 0, y: 0, agent: 'A', prompt: 'p', cwd: '/tmp' })
const input = (o: Partial<WorkflowInput> = {}): WorkflowInput => ({
  id: null,
  name: 'Flow',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [{ id: 't', kind: 'trigger', handle: 'trigger', name: 'Start', x: 0, y: 0 }, agentStep()],
  edges: [{ id: 'e1', from: 't', port: 'out', to: 's1' }],
  ...o
})

describe('workflowEditing', () => {
  it('turns on a workflow without problems and returns an empty problem list', async () => {
    const r = await editing().save(input())
    expect(r.workflow.enabled).toBe(true)
    expect(r.problems).toEqual([])
    expect(calls).toEqual(['rearm', 'changed'])
  })

  it('saves a workflow with problems off and returns them', async () => {
    problems = [{ stepId: 's1', text: 'Agent is missing' }]
    const r = await editing().save(input())
    expect(r.workflow.enabled).toBe(false)
    expect(r.problems).toEqual(problems)
    expect(await store.get(r.workflow.id)).toMatchObject({ enabled: false })
  })

  it('refuses an edit of a workflow that is gone', async () => {
    await expect(editing().save(input({ id: 'gone' }))).rejects.toThrow('Workflow not found')
  })

  it('makes a webhook workflow hook when asked to, with no sample and nothing in the result', async () => {
    const r = await editing().save(input({ trigger: { kind: 'webhook', sample: null, filters: [] } }), { ensureHook: true })
    const hook = await store.hooks.hook(r.workflow.id)
    expect(hook).toMatchObject({ id: r.workflow.id, latest: null, draftAt: null })
    expect(JSON.stringify(r)).not.toContain('a-secret-long-enough-1234')
  })

  it('stops the workflow runs before removing it', async () => {
    const r = await editing().save(input())
    calls.length = 0
    await editing().remove(r.workflow.id)
    expect(calls).toEqual([`stop:${r.workflow.id}`, 'rearm', 'changed'])
    expect(await store.get(r.workflow.id)).toBeNull()
  })
})

describe('workflowEditing keeps history', () => {
  const withHistory = (history: HistoryStore<WorkflowDef>) =>
    workflowEditing({
      store,
      runner: { problems: async () => problems, stopAllOf: async () => {} },
      scheduler: { rearm: async () => {} },
      changed: () => {},
      newSecret: () => 'a-secret-long-enough-1234',
      history
    })
  const history = () =>
    new HistoryStore<WorkflowDef>(join(dir, 'history', 'workflows'), {
      newId: (() => {
        let n = 0
        return () => `v${++n}`
      })(),
      now: () => 5,
      label: 'workflows'
    })

  it('records each save by who made it, nothing for an on/off-only save, and drops the history with the workflow', async () => {
    const h = history()
    const e = withHistory(h)
    const { workflow } = await e.save(input())
    await e.save({ ...input(), id: workflow.id, name: 'Renamed' }, { source: 'zumi-bot' })
    await e.save({ ...input(), id: workflow.id, name: 'Renamed', enabled: false })
    await e.save({ ...input(), id: workflow.id, name: 'Flow', enabled: false }, { restoredFrom: 5 })
    expect((await h.list(workflow.id)).map((v) => [v.source, v.def.name, v.restoredFrom])).toEqual([
      ['restore', 'Flow', 5],
      ['zumi-bot', 'Renamed', undefined],
      ['editor', 'Flow', undefined]
    ])
    await e.remove(workflow.id)
    expect(await h.list(workflow.id)).toEqual([])
  })

  it('still saves when the history cannot be written', async () => {
    const h = history()
    vi.spyOn(h, 'record').mockRejectedValue(Object.assign(new Error('/secret/path'), { code: 'EACCES' }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { workflow } = await withHistory(h).save(input())
    expect(await store.get(workflow.id)).toMatchObject({ name: 'Flow' })
    expect(err.mock.calls.flat().join(' ')).toBe('history: could not keep a version (EACCES)')
    err.mockRestore()
  })
})
