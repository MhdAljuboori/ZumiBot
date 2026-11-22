import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { CostRecord, MessageRecord } from '@zumibot/shared/usageReport'
import { UsageStore } from '../../src/core/usage/usageStore'

const cost = (id: string, agent = 'a'): CostRecord => ({
  kind: 'cost',
  id,
  chatId: 'c1',
  agent,
  at: 1,
  sessionId: null,
  window: null,
  models: { m: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.1 } }
})
const msg = (id: string): MessageRecord => ({ kind: 'msg', id, chatId: 'c1', at: 2 })
const tmpFile = async () => join(await mkdtemp(join(tmpdir(), 'usage-')), 'usage-records.jsonl')
const lines = async (f: string) => (await readFile(f, 'utf8')).split('\n').filter(Boolean)

test('add appends and survives a reload', async () => {
  const f = await tmpFile()
  const s = new UsageStore(f)
  await s.load()
  await s.add([cost('1'), msg('2')])
  const r = new UsageStore(f)
  await r.load()
  expect(r.all()).toEqual([cost('1'), msg('2')])
})

test('add ignores ids it already holds', async () => {
  const f = await tmpFile()
  const s = new UsageStore(f)
  await s.load()
  expect(await s.add([cost('1')])).toHaveLength(1)
  expect(await s.add([cost('1')])).toEqual([])
  expect(await lines(f)).toHaveLength(1)
})

test('load skips a broken line', async () => {
  const f = await tmpFile()
  await writeFile(f, `${JSON.stringify(cost('1'))}\n{"kind":"cost","id":\n${JSON.stringify(msg('2'))}\n`)
  const s = new UsageStore(f)
  await s.load()
  expect(s.all()).toHaveLength(2)
})

test('renameAgent rewrites cost records of that agent only', async () => {
  const f = await tmpFile()
  const s = new UsageStore(f)
  await s.load()
  await s.add([cost('1', 'old'), cost('2', 'other'), msg('3')])
  expect(await s.renameAgent('old', 'new')).toBe(true)
  expect(await s.renameAgent('nobody', 'x')).toBe(false)
  const r = new UsageStore(f)
  await r.load()
  expect(r.all()).toEqual([cost('1', 'new'), cost('2', 'other'), msg('3')])
})

test('concurrent adds never interleave lines', async () => {
  const f = await tmpFile()
  const s = new UsageStore(f)
  await s.load()
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.add([cost(`id${i}`)])))
  const ls = await lines(f)
  expect(ls).toHaveLength(20)
  ls.forEach((l) => JSON.parse(l))
})

test('add after a torn tail line keeps the new record', async () => {
  const f = await tmpFile()
  await writeFile(f, `${JSON.stringify(cost('1'))}\n{"kind":"cost","id":`)
  const s = new UsageStore(f)
  await s.load()
  await s.add([msg('2')])
  const r = new UsageStore(f)
  await r.load()
  expect(r.all()).toEqual([cost('1'), msg('2')])
})

test('a failed append can be retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'))
  const f = join(dir, 'sub', 'usage-records.jsonl')
  const s = new UsageStore(f)
  await s.load()
  await expect(s.add([cost('1')])).rejects.toThrow()
  expect(s.all()).toEqual([])
  await mkdir(join(dir, 'sub'))
  expect(await s.add([cost('1')])).toHaveLength(1)
  const r = new UsageStore(f)
  await r.load()
  expect(r.all()).toEqual([cost('1')])
})

test('renameAgent heals a torn line', async () => {
  const f = await tmpFile()
  await writeFile(f, `${JSON.stringify(cost('1', 'old'))}\n{"kind":"cost","id":`)
  const s = new UsageStore(f)
  await s.load()
  await s.renameAgent('old', 'new')
  await s.add([msg('2')])
  const r = new UsageStore(f)
  await r.load()
  expect(r.all()).toEqual([cost('1', 'new'), msg('2')])
})

test('renameAgent rewrites owner records too', async () => {
  const f = join(await mkdtemp(join(tmpdir(), 'ustore-')), 'u.jsonl')
  const s = new UsageStore(f)
  await s.load()
  await s.add([{ kind: 'owner', id: 'o:s:c', chatId: 'c', sessionId: 's', agent: 'a', at: 1 }])
  await s.renameAgent('a', 'b')
  expect(s.all()[0]).toMatchObject({ kind: 'owner', agent: 'b' })
})

test('a failed append marks the tail torn so the next add starts on a new line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ustore-'))
  const f = join(dir, 'u.jsonl')
  await writeFile(f, '{"kind":"msg","id":"a","chatId":"c","at":1}\n')
  const s = new UsageStore(f)
  await s.load()
  await mkdir(join(dir, 'x'))
  const bad = new UsageStore(join(dir, 'x')) // appending to a directory fails
  await bad.load().catch(() => {})
  await expect(bad.add([{ kind: 'msg', id: 'b', chatId: 'c', at: 2 }])).rejects.toThrow()
  expect((bad as unknown as { torn: boolean }).torn).toBe(true)
})
