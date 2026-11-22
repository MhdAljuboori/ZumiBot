import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Step, Workflow, WorkflowRun } from '@zumibot/shared/workflows'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-workflows-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const agentStep = (agent = 'A'): Step => ({
  id: 's1',
  kind: 'agent',
  handle: 'one',
  name: 'One',
  x: 0,
  y: 0,
  agent,
  prompt: 'p',
  cwd: '/tmp'
})
const workflow = (id = 'w1'): Workflow => ({
  id,
  name: 'Flow',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [{ id: 't', kind: 'trigger', handle: 'trigger', name: 'Start', x: 0, y: 0 }, agentStep()],
  edges: [{ id: 'e1', from: 't', port: 'out', to: 's1' }],
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1
})
const run = (id: string, workflowId = 'w1', status: WorkflowRun['status'] = 'done'): WorkflowRun => ({
  id,
  workflowId,
  via: 'manual',
  late: false,
  status,
  snapshot: { steps: [agentStep()], edges: [] },
  visits: [],
  inbox: {},
  allowance: { perStep: {}, total: 200 },
  halted: false,
  startedAt: Number(id)
})

describe('WorkflowStore', () => {
  it('put/get/list round trip', async () => {
    const s = new WorkflowStore(dir)
    await s.put(workflow())
    await s.put({ ...workflow(), name: 'Renamed' })
    expect(await new WorkflowStore(dir).get('w1')).toMatchObject({ name: 'Renamed' })
    expect(await s.list()).toHaveLength(1)
    expect(await s.get('nope')).toBeNull()
    expect(await s.update('w1', (w) => ({ ...w, enabled: false }))).toMatchObject({ enabled: false })
    expect(await s.update('w1', () => null)).toBeNull()
    expect(await s.update('nope', (w) => w)).toBeNull()
    expect((await s.get('w1'))?.enabled).toBe(false)
  })
  it('copy adds what make returns from the source and every workflow, in one step; null when the source is gone', async () => {
    const s = new WorkflowStore(dir)
    await s.put(workflow('w1'))
    await s.put({ ...workflow('w2'), name: 'Other' })
    const made = await s.copy('w1', (src, all) => ({ ...src, id: 'w3', name: `${src.name} of ${all.length}` }))
    expect(made).toMatchObject({ id: 'w3', name: 'Flow of 2' })
    expect((await s.list()).map((w) => w.id)).toEqual(['w1', 'w2', 'w3'])
    expect(await s.get('w1')).toEqual(workflow('w1')) // the source is untouched
    expect(await s.copy('nope', (src) => src)).toBeNull()
    expect(await s.list()).toHaveLength(3)
  })
  it('hooks file is 0600', async () => {
    const s = new WorkflowStore(dir)
    await s.hooks.putHook({ id: 'w1', secret: 'x'.repeat(16), latest: null, draftAt: null })
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'workflow-hooks.json'))).mode & 0o777).toBe(0o600)
  })
  it('a workflow id named like an Object.prototype member is a plain key', async () => {
    // The server refuses such ids; the store still reads the runs map by own keys only.
    const s = new WorkflowStore(dir)
    await s.addRun(run('1', 'constructor'))
    await s.addRun(run('2', 'constructor'))
    expect(Object.entries(await s.runs()).map(([id, rows]) => [id, rows.map((r) => r.id)])).toEqual([['constructor', ['2', '1']]])
  })

  it('addRun keeps 30 newest and at most 10 skipped, never drops running', async () => {
    const s = new WorkflowStore(dir)
    await s.addRun(run('1', 'w1', 'running'))
    for (let i = 2; i <= 40; i++) await s.addRun(run(String(i)))
    let kept = (await s.runs()).w1!
    expect(kept).toHaveLength(31) // the newest 30 plus the old unfinished one, which is never pruned
    expect(kept[0]!.id).toBe('40')
    expect(kept.some((r) => r.id === '1')).toBe(true) // the old running one stays
    for (let i = 41; i <= 80; i++) await s.addRun({ ...run(String(i)), status: 'skipped' })
    kept = (await s.runs()).w1!
    expect(kept.filter((r) => r.status === 'skipped')).toHaveLength(10)
    expect(kept.filter((r) => r.status === 'done').length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(31)
    expect(kept.some((r) => r.id === '1')).toBe(true)
  })
  it('updateRun returns null for unknown run', async () => {
    const s = new WorkflowStore(dir)
    await s.addRun(run('1'))
    expect(await s.updateRun('nope', (r) => r)).toBeNull()
    expect(await s.updateRun('1', () => null)).toBeNull()
    expect(await s.updateRun('1', (r) => ({ ...r, status: 'failed' }))).toMatchObject({ id: '1', status: 'failed' })
    expect(await s.getRun('1')).toMatchObject({ status: 'failed' })
    expect(await s.getRun('nope')).toBeNull()
  })
  it('remove drops runs and hook', async () => {
    const s = new WorkflowStore(dir)
    await s.put(workflow())
    await s.addRun(run('1'))
    await s.hooks.putHook({ id: 'w1', secret: 'x'.repeat(16), latest: null, draftAt: null })
    await s.remove('w1')
    expect(await s.list()).toEqual([])
    expect(await s.runs()).toEqual({})
    expect(await s.hooks.hook('w1')).toBeNull()
  })
  it('renameAgent moves agent in steps and run snapshots', async () => {
    const s = new WorkflowStore(dir)
    await s.put(workflow())
    await s.addRun(run('1'))
    await s.renameAgent('A', 'B')
    const agents = (steps: Step[]) => steps.flatMap((x) => (x.kind === 'agent' ? [x.agent] : []))
    expect(agents((await s.get('w1'))!.steps)).toEqual(['B'])
    expect(agents((await s.getRun('1'))!.snapshot.steps)).toEqual(['B'])
  })
  it('renameAgent moves foreach steps in workflows and run snapshots', async () => {
    const s = new WorkflowStore(dir)
    const each: Step = { id: 'f1', kind: 'foreach', handle: 'each', name: 'Each', x: 0, y: 0, agent: 'old', prompt: 'p', cwd: '/tmp' }
    await s.put({ ...workflow(), steps: [...workflow().steps, each] })
    await s.addRun({ ...run('1'), snapshot: { steps: [each], edges: [] } })
    await s.renameAgent('old', 'new')
    const agents = (steps: Step[]) => steps.flatMap((x) => (x.kind === 'foreach' ? [x.agent] : []))
    expect(agents((await s.list())[0]!.steps)).toEqual(['new'])
    expect(agents((await s.getRun('1'))!.snapshot.steps)).toEqual(['new'])
  })
  it('renames room members and command agents in workflows and run snapshots', async () => {
    const s = new WorkflowStore(dir)
    const room: Step = {
      id: 'r1',
      kind: 'room',
      handle: 'room',
      name: 'Room',
      x: 0,
      y: 0,
      room: '',
      prompt: 'p',
      members: ['a', 'b'],
      role: '',
      cwd: '/w',
      command: { agent: 'a', name: 'go' }
    }
    const chat: Step = {
      id: 'c1',
      kind: 'chat',
      handle: 'chat',
      name: 'Chat',
      x: 0,
      y: 0,
      chat: 'x',
      prompt: 'p',
      command: { agent: 'a', name: 'go' }
    }
    await s.put({ ...workflow(), steps: [room, chat] })
    await s.addRun({ ...run('1'), snapshot: { steps: [room, chat], edges: [] } })
    await s.renameAgent('a', 'z')
    for (const steps of [(await s.list())[0]!.steps, (await s.getRun('1'))!.snapshot.steps]) {
      expect(steps[0]).toMatchObject({ members: ['z', 'b'], command: { agent: 'z' } })
      expect(steps[1]).toMatchObject({ command: { agent: 'z' } })
    }
  })
  it('snapshot carries summaries without visits', async () => {
    const s = new WorkflowStore(dir)
    await s.put(workflow())
    await s.addRun(run('1'))
    await s.addRun(run('2', 'gone'))
    const snap = await s.snapshot()
    expect(Object.keys(snap.runs)).toEqual(['w1'])
    expect(snap.runs.w1![0]).toMatchObject({ id: '1', workflowId: 'w1', waiting: [], failed: [] })
    expect(JSON.stringify(snap)).not.toContain('visits')
    expect(JSON.stringify(snap)).not.toContain('snapshot')
  })

  describe('waitingApprovals', () => {
    const approval = (id = 'ap', question = 'ok?'): Step => ({
      id,
      kind: 'approval',
      handle: id,
      name: 'Ask ' + id,
      x: 0,
      y: 0,
      question,
      editable: false
    })
    const visit = (
      id: string,
      stepId: string,
      status: WorkflowRun['visits'][number]['status'],
      startedAt: number
    ): WorkflowRun['visits'][number] => ({ id, stepId, n: 1, status, input: '', inputs: [], startedAt })
    const waitingRun = (
      id: string,
      steps: Step[],
      visits: WorkflowRun['visits'],
      status: WorkflowRun['status'] = 'waiting'
    ): WorkflowRun => ({ ...run(id, 'w1', status), snapshot: { steps, edges: [] }, visits })

    it('lists only waiting Approval visits', async () => {
      const s = new WorkflowStore(dir)
      await s.put(workflow())
      // Waiting on an Agent step's chat card, a done Approval and a finished run: none listed.
      await s.addRun(waitingRun('1', [agentStep()], [visit('v1', 's1', 'waiting', 1)]))
      await s.addRun(waitingRun('2', [approval()], [visit('v2', 'ap', 'done', 2)]))
      await s.addRun(waitingRun('3', [approval()], [visit('v3', 'ap', 'waiting', 3)], 'done'))
      await s.addRun(waitingRun('4', [agentStep(), approval()], [visit('v4', 's1', 'waiting', 4), visit('v5', 'ap', 'waiting', 5)]))
      const got = await s.waitingApprovals()
      expect(got.map((a) => [a.runId, a.visit.id, a.workflowName, a.step.id])).toEqual([['4', 'v5', 'Flow', 'ap']])
    })
    it("uses the run snapshot's step, not the edited workflow, and lists the oldest first", async () => {
      const s = new WorkflowStore(dir)
      await s.put({ ...workflow(), steps: [{ ...approval(), question: 'edited later' } as Step] })
      await s.addRun(waitingRun('10', [approval('ap', 'as run')], [visit('v10', 'ap', 'waiting', 50)]))
      await s.addRun(waitingRun('11', [approval('ap', 'as run 2')], [visit('v11', 'ap', 'waiting', 20)]))
      const got = await s.waitingApprovals()
      expect(got.map((a) => a.visit.id)).toEqual(['v11', 'v10'])
      expect(got.map((a) => a.step.question)).toEqual(['as run 2', 'as run'])
    })
    it('leaves out a run whose workflow was removed', async () => {
      const s = new WorkflowStore(dir)
      await s.addRun(waitingRun('20', [approval()], [visit('v20', 'ap', 'waiting', 1)]))
      expect(await s.waitingApprovals()).toEqual([])
    })
  })
})
