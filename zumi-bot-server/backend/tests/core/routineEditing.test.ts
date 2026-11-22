import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { RoutineInput } from '@zumibot/shared/routines'
import { RoutineStore } from '../../src/core/routines/routineStore'
import { routineEditing } from '../../src/core/routines/routineEditing'
import { HistoryStore } from '../../src/core/history/historyStore'
import type { RoutineDef } from '@zumibot/shared/definitionHistory'

let dir: string
let store: RoutineStore
let rearmed: number
let told: number
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-routine-editing-'))
  store = new RoutineStore(dir)
  rearmed = 0
  told = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const editing = () =>
  routineEditing({
    store,
    scheduler: {
      rearm: async () => {
        rearmed++
      }
    },
    changed: () => {
      told++
    },
    newSecret: () => 'a-secret-long-enough-1234'
  })
const input = (o: Partial<RoutineInput> = {}): RoutineInput => ({
  id: null,
  name: 'Daily',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  target: { kind: 'new-chat', agent: 'alpha', cwd: '/work' },
  prompt: 'Go',
  limitPolicy: 'wait',
  missedPolicy: 'run-once',
  sessionPolicy: 'continue',
  command: null,
  ...o
})

describe('routineEditing', () => {
  it('puts a new schedule routine with its next run, rearms and broadcasts once', async () => {
    const r = await editing().save(input())
    expect(r.nextRunAt).toBeGreaterThan(Date.now() - 1)
    expect(await store.get(r.id)).toEqual(r)
    expect(rearmed).toBe(1)
    expect(told).toBe(1)
  })

  it('refuses a webhook routine with no test call by default', async () => {
    await expect(editing().save(input({ trigger: { kind: 'webhook', sample: null } }))).rejects.toThrow(
      'Webhook needs a test call before saving'
    )
    expect(await store.list()).toEqual([])
  })

  it('saves a webhook routine with sample null and makes its hook when asked to', async () => {
    const r = await editing().save(input({ trigger: { kind: 'webhook', sample: null } }), { webhookWithoutSample: true })
    expect(r.trigger).toEqual({ kind: 'webhook', sample: null })
    const hook = await store.hook(r.id)
    expect(hook).toMatchObject({ id: r.id, latest: null, draftAt: null })
    expect(hook?.secret).toBe('a-secret-long-enough-1234')
  })

  it('removes the routine, rearms and broadcasts', async () => {
    const r = await editing().save(input())
    await editing().remove(r.id)
    expect(await store.get(r.id)).toBeNull()
    expect(rearmed).toBe(2)
    expect(told).toBe(2)
  })
})

describe('routineEditing keeps history', () => {
  it('records each save that changed the routine and drops the history with it', async () => {
    let n = 0
    const h = new HistoryStore<RoutineDef>(join(dir, 'history', 'routines'), { newId: () => `v${++n}`, now: () => 5, label: 'routines' })
    const e = routineEditing({
      store,
      scheduler: { rearm: async () => {} },
      changed: () => {},
      newSecret: () => 'a-secret-long-enough-1234',
      history: h
    })
    const r = await e.save(input())
    await e.save(input({ id: r.id, prompt: 'Go faster' }), { source: 'zumi-bot' })
    await e.save(input({ id: r.id, prompt: 'Go faster', enabled: false }))
    expect((await h.list(r.id)).map((v) => [v.source, v.def.prompt])).toEqual([
      ['zumi-bot', 'Go faster'],
      ['editor', 'Go']
    ])
    await e.remove(r.id)
    expect(await h.list(r.id)).toEqual([])
  })
})
