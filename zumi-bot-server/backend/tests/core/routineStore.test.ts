import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Routine, RoutineRun } from '@zumibot/shared/routines'
import { RoutineStore } from '../../src/core/routines/routineStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-routines-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const routine = (id = 'r1'): Routine => ({
  id,
  name: 'Daily',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  target: { kind: 'new-chat', agent: 'A', cwd: '/tmp' },
  prompt: 'hello',
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1
})
const run = (id: string, routineId = 'r1'): RoutineRun => ({
  id,
  routineId,
  via: 'manual',
  status: 'done',
  late: false,
  chatId: null,
  messageId: null,
  startedAt: Number(id)
})

describe('RoutineStore', () => {
  it('round-trips routines across a fresh store', async () => {
    const s = new RoutineStore(dir)
    await s.put(routine())
    expect(await new RoutineStore(dir).get('r1')).toEqual(routine())
    expect(await s.list()).toEqual([routine()])
  })
  it('atomically updates an existing routine without creating missing rows', async () => {
    const s = new RoutineStore(dir)
    expect(await s.update('missing', (r) => ({ ...r, enabled: false }))).toBeNull()
    expect(await s.list()).toEqual([])

    await s.put(routine())
    expect(await s.update('r1', () => null)).toBeNull()
    expect(await s.get('r1')).toEqual(routine())
    expect(await s.update('r1', (r) => ({ ...r, enabled: false }))).toMatchObject({ id: 'r1', enabled: false })
    expect(await s.list()).toHaveLength(1)
  })
  it("remove drops the routine's runs and hook", async () => {
    const s = new RoutineStore(dir)
    await s.put(routine())
    await s.addRun(run('1'))
    await s.putHook({ id: 'r1', secret: 'secret', latest: null, draftAt: null })
    await s.remove('r1')
    expect(await s.runs()).toEqual({})
    expect(await s.hook('r1')).toBeNull()
  })
  it('leaves runs of a removed routine out of the snapshot', async () => {
    const s = new RoutineStore(dir)
    await s.put(routine())
    await s.addRun(run('1'))
    await s.remove('r1')
    // A run that started before the remove records itself after it.
    await s.addRun(run('2'))
    await s.addRun(run('3', 'gone'))
    await s.put(routine('r2'))
    await s.addRun(run('4', 'r2'))
    expect(await s.snapshot()).toEqual({ routines: [routine('r2')], runs: { r2: [run('4', 'r2')] } })
  })
  it('keeps the newest 50 runs first', async () => {
    const s = new RoutineStore(dir)
    for (let i = 1; i <= 55; i++) await s.addRun(run(String(i)))
    expect((await s.runs()).r1).toHaveLength(50)
    expect((await s.runs()).r1[0].id).toBe('55')
    expect((await s.runs()).r1.at(-1)?.id).toBe('6')
  })
  it('keeps only the newest 10 skipped runs, so they never push out real ones', async () => {
    const s = new RoutineStore(dir)
    for (let i = 1; i <= 3; i++) await s.addRun(run(String(i)))
    for (let i = 4; i <= 60; i++) await s.addRun({ ...run(String(i)), status: 'skipped' })
    const kept = (await s.runs()).r1
    expect(kept.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual([
      '60',
      '59',
      '58',
      '57',
      '56',
      '55',
      '54',
      '53',
      '52',
      '51'
    ])
    expect(kept.filter((r) => r.status === 'done').map((r) => r.id)).toEqual(['3', '2', '1'])
  })
  it('patches a run and returns null for unknown ids', async () => {
    const s = new RoutineStore(dir)
    await s.addRun(run('1'))
    expect(await s.updateRun('r1', '1', { status: 'failed' })).toMatchObject({ id: '1', status: 'failed' })
    expect(await s.updateRun('r1', 'missing', { status: 'done' })).toBeNull()
  })
  it('writes hooks with private file mode', async () => {
    const s = new RoutineStore(dir)
    await s.putHook({ id: 'draft', secret: 'secret', latest: null, draftAt: 1 })
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'routine-hooks.json'))).mode & 0o777).toBe(0o600)
  })
  it('drops only stale ownerless drafts', async () => {
    const s = new RoutineStore(dir)
    await s.put(routine('owned'))
    await s.putHook({ id: 'old', secret: 's', latest: null, draftAt: 2 })
    await s.putHook({ id: 'new', secret: 's', latest: null, draftAt: 9 })
    await s.putHook({ id: 'owned', secret: 's', latest: null, draftAt: 1 })
    expect(await s.dropStaleDrafts(5)).toEqual(['old'])
    expect(await s.hook('new')).not.toBeNull()
    expect(await s.hook('owned')).not.toBeNull()
  })
  it('renames agents in new targets and leaves chat targets alone', async () => {
    const s = new RoutineStore(dir)
    await s.put(routine('a'))
    await s.put({ ...routine('b'), target: { kind: 'new-group', members: ['A', 'B'], role: 'role', cwd: '/tmp' } })
    await s.put({ ...routine('c'), target: { kind: 'chat', chatId: 'A' } })
    await s.renameAgent('A', 'Z')
    expect((await s.get('a'))?.target).toMatchObject({ kind: 'new-chat', agent: 'Z' })
    expect((await s.get('b'))?.target).toMatchObject({ kind: 'new-group', members: ['Z', 'B'] })
    expect((await s.get('c'))?.target).toEqual({ kind: 'chat', chatId: 'A' })
  })
  it('omits hook secrets from snapshots', async () => {
    const s = new RoutineStore(dir)
    await s.put(routine())
    await s.putHook({ id: 'r1', secret: 'top-secret-value', latest: null, draftAt: null })
    expect(JSON.stringify(await s.snapshot())).not.toContain('top-secret-value')
  })
})

describe('RoutineStore read failures', () => {
  it('moves a corrupt file aside, logs only its name, and reads as empty', async () => {
    const file = join(dir, 'routine-hooks.json')
    await fs.writeFile(file, '{not json secret-abc')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await new RoutineStore(dir).hook('x')).toBeNull()
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-abc')
    log.mockRestore()
    const kept = (await fs.readdir(dir)).filter((f) => f.startsWith('routine-hooks.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(join(dir, kept[0]!), 'utf8')).toBe('{not json secret-abc')
  })
  it('rejects on a non-ENOENT read error and leaves the stored hooks untouched', async () => {
    const s = new RoutineStore(dir)
    const first = { id: 'a', secret: 'x'.repeat(16), latest: null, draftAt: null }
    await s.putHook(first)
    const before = await fs.readFile(join(dir, 'routine-hooks.json'), 'utf8')
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('io'), { code: 'EIO' }))
    await expect(s.putHook({ ...first, id: 'b' })).rejects.toThrow('io')
    spy.mockRestore()
    expect(await fs.readFile(join(dir, 'routine-hooks.json'), 'utf8')).toBe(before)
    expect(await s.hook('a')).toEqual(first)
    expect(await s.hook('b')).toBeNull()
  })
  it('writes compact JSON', async () => {
    await new RoutineStore(dir).put(routine())
    expect(await fs.readFile(join(dir, 'routines.json'), 'utf8')).not.toContain('\n')
  })
  it('ensureHook keeps an existing record and creates a missing one', async () => {
    const s = new RoutineStore(dir)
    const made = vi.fn(() => 'first-secret-123456')
    expect(await s.ensureHook('r1', made, 5)).toEqual({ id: 'r1', secret: 'first-secret-123456', latest: null, draftAt: 5 })
    expect(await s.ensureHook('r1', () => 'other-secret-1234567', null)).toMatchObject({ secret: 'first-secret-123456', draftAt: 5 })
    expect(made).toHaveBeenCalledTimes(1)
    expect(await s.hook('r1')).toMatchObject({ secret: 'first-secret-123456' })
  })
  it('rotateSecret and clearDraft change only their field and never resurrect a gone hook', async () => {
    const s = new RoutineStore(dir)
    expect(await s.rotateSecret('r1', 'new-secret-1234567')).toBe(false)
    await s.clearDraft('r1')
    expect(await s.hook('r1')).toBeNull()
    const call = { method: 'POST', query: {}, body: 1, receivedAt: 1 }
    await s.putHook({ id: 'r1', secret: 'old-secret-1234567', latest: call, draftAt: 9 })
    expect(await s.rotateSecret('r1', 'new-secret-1234567')).toBe(true)
    await s.clearDraft('r1')
    expect(await s.hook('r1')).toEqual({ id: 'r1', secret: 'new-secret-1234567', latest: call, draftAt: null })
  })
})
