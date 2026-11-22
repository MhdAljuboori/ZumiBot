import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { HISTORY_KEPT } from '@zumibot/shared/definitionHistory'
import { HistoryStore } from '../../src/core/history/historyStore'
import { renameWorkflowDef } from '../../src/core/history/renameAgent'
import { workflowDef } from '@zumibot/shared/definitionHistory'
import type { Step } from '@zumibot/shared/workflows'

type Def = { name: string; agent?: string }
let dir: string
let store: HistoryStore<Def>
let n: number
let clock: number
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-history-'))
  n = 0
  clock = 1000
  store = new HistoryStore<Def>(join(dir, 'history', 'workflows'), { newId: () => `v${++n}`, now: () => clock++, label: 'workflows' })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const names = async (id = 'w1') => (await store.list(id)).map((v) => [v.source, v.def.name])

describe('HistoryStore', () => {
  it('keeps every save that changed something, newest first, and nothing for a save that changed nothing', async () => {
    expect(await store.record('w1', { before: null, after: { name: 'A' }, source: 'editor' })).toBe(true)
    expect(await store.record('w1', { before: { def: { name: 'A' }, at: 5 }, after: { name: 'B' }, source: 'zumi-bot' })).toBe(true)
    expect(await store.record('w1', { before: { def: { name: 'B' }, at: 6 }, after: { name: 'B' }, source: 'editor' })).toBe(false)
    expect(await names()).toEqual([
      ['zumi-bot', 'B'],
      ['editor', 'A']
    ])
    const file = JSON.parse(await fs.readFile(join(dir, 'history', 'workflows', 'w1.json'), 'utf8'))
    expect(file.v).toBe(1)
  })

  it('keeps what a save replaced first when the history does not end in it', async () => {
    // Saved before history was kept: the old definition becomes an earlier version dated by its updatedAt.
    await store.record('w1', { before: { def: { name: 'Old' }, at: 42 }, after: { name: 'New' }, source: 'editor' })
    const kept = await store.list('w1')
    expect(kept.map((v) => [v.source, v.def.name, v.savedAt])).toEqual([
      ['editor', 'New', 1000],
      ['earlier', 'Old', 42]
    ])
    // Something wrote around a save (a rename, a sync): the replaced definition is kept again.
    await store.record('w1', { before: { def: { name: 'Elsewhere' }, at: 50 }, after: { name: 'Newer' }, source: 'editor' })
    expect(await names()).toEqual([
      ['editor', 'Newer'],
      ['earlier', 'Elsewhere'],
      ['editor', 'New'],
      ['earlier', 'Old']
    ])
  })

  it('marks a save of a restored version with the time it came from', async () => {
    await store.record('w1', { before: null, after: { name: 'A' }, source: 'editor' })
    await store.record('w1', { before: { def: { name: 'A' }, at: 1 }, after: { name: 'B' }, source: 'restore', restoredFrom: 7 })
    expect((await store.list('w1'))[0]).toMatchObject({ source: 'restore', restoredFrom: 7, def: { name: 'B' } })
    expect(await store.get('w1', 'v2')).toMatchObject({ def: { name: 'B' } })
    expect(await store.get('w1', 'nope')).toBeNull()
  })

  it('caps the versions kept', async () => {
    let before: Def | null = null
    for (let i = 0; i < HISTORY_KEPT + 3; i++) {
      await store.record('w1', { before: before && { def: before, at: 1 }, after: { name: `N${i}` }, source: 'editor' })
      before = { name: `N${i}` }
    }
    const kept = await store.list('w1')
    expect(kept).toHaveLength(HISTORY_KEPT)
    expect(kept[0]!.def.name).toBe(`N${HISTORY_KEPT + 2}`)
  })

  it('runs saves of one item in turn, so none is lost', async () => {
    await Promise.all(
      ['A', 'B', 'C'].map((name, i) =>
        store.record('w1', { before: i === 0 ? null : { def: { name: ['A', 'B'][i - 1]! }, at: 1 }, after: { name }, source: 'editor' })
      )
    )
    expect(await names()).toEqual([
      ['editor', 'C'],
      ['editor', 'B'],
      ['editor', 'A']
    ])
  })

  it('removes an item’s history, and refuses an id that is not one', async () => {
    await store.record('w1', { before: null, after: { name: 'A' }, source: 'editor' })
    await store.remove('w1')
    expect(await store.list('w1')).toEqual([])
    await expect(store.list('../x')).rejects.toThrow('Invalid id')
    await expect(store.record('a/b', { before: null, after: { name: 'A' }, source: 'editor' })).rejects.toThrow('Invalid id')
  })

  it('rewrites kept definitions, as an agent rename does, and leaves untouched files alone', async () => {
    await store.record('w1', { before: null, after: { name: 'A', agent: 'old' }, source: 'editor' })
    await store.record('w2', { before: null, after: { name: 'B', agent: 'other' }, source: 'editor' })
    const file2 = join(dir, 'history', 'workflows', 'w2.json')
    const stat = await fs.stat(file2)
    await store.rewrite((d) => (d.agent === 'old' ? { ...d, agent: 'new' } : null))
    expect((await store.list('w1'))[0]!.def.agent).toBe('new')
    expect((await fs.stat(file2)).mtimeMs).toBe(stat.mtimeMs)
    // No folder yet: nothing to do.
    await new HistoryStore<Def>(join(dir, 'none'), { newId: () => 'x', now: () => 1, label: 'x' }).rewrite(() => null)
  })

  it('moves a corrupt file aside and starts over', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await fs.mkdir(join(dir, 'history', 'workflows'), { recursive: true })
    await fs.writeFile(join(dir, 'history', 'workflows', 'w1.json'), '{nope')
    expect(await store.list('w1')).toEqual([])
    expect((await fs.readdir(join(dir, 'history', 'workflows'))).some((f) => f.startsWith('w1.json.corrupt-'))).toBe(true)
    expect(err.mock.calls.flat().join(' ')).not.toContain('w1')
    err.mockRestore()
  })
})

describe('renameWorkflowDef', () => {
  it('renames room members and command agents in kept steps, and is null when nothing names the agent', () => {
    const room: Step = {
      id: 'r',
      kind: 'room',
      handle: 'r',
      name: 'R',
      x: 0,
      y: 0,
      room: '',
      prompt: 'p',
      members: ['a', 'b'],
      role: '',
      cwd: '/w',
      command: { agent: 'a', name: 'go' }
    }
    const def = workflowDef({ name: 'W', timeZone: 'UTC', trigger: { kind: 'manual' }, steps: [room], edges: [] })
    expect(renameWorkflowDef(def, 'a', 'z')!.steps[0]).toMatchObject({ members: ['z', 'b'], command: { agent: 'z' } })
    expect(renameWorkflowDef(def, 'q', 'z')).toBeNull()
  })
})
