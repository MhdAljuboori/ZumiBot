import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { BrowserProfileStore } from '../../src/core/browser/profileStore'
import { symlinksWork } from '../support/platform'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'browser-profiles-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})
const fresh = async () => {
  const s = new BrowserProfileStore(dir)
  await s.load()
  return s
}
const metadata = () => join(dir, 'browsers', 'profiles.json')

it('isolates agents and reloads stable opaque profile paths', async () => {
  const s = await fresh()
  const a = await s.ensure('alice'),
    b = await s.ensure('bob')
  expect(a.id).not.toBe(b.id)
  expect(a.id).toMatch(/^[a-f0-9-]{36}$/)
  expect(a.dir).toBe(join(dir, 'browsers', a.id))
  expect(await (await fresh()).ensure('alice')).toEqual(a)
  expect(s.agents()).toEqual(['alice', 'bob'])
})
it('preserves identity on rename and rejects a collision without losing profiles', async () => {
  const s = await fresh(),
    a = await s.ensure('alice')
  await s.renameAgent('alice', 'renamed')
  expect(await (await fresh()).ensure('renamed')).toEqual(a)
  await s.ensure('bob')
  await expect(s.renameAgent('renamed', 'bob')).rejects.toThrow()
  expect(s.agents()).toEqual(['renamed', 'bob'])
})
it('detaches deleted agents, keeps orphaned data, and replaces with a fresh profile', async () => {
  const s = await fresh(),
    a = await s.ensure('alice')
  await fs.writeFile(join(a.dir, 'cookie'), 'private')
  await s.detachAgents(['alice'])
  expect(s.agents()).toEqual([])
  const recreated = await s.ensure('alice')
  expect(recreated.id).not.toBe(a.id)
  expect(await fs.readFile(join(a.dir, 'cookie'), 'utf8')).toBe('private')
  const replacement = await s.replace('alice')
  expect(replacement.id).not.toBe(recreated.id)
  expect(await (await fresh()).ensure('alice')).toEqual(replacement)
})
it('serializes concurrent creation so one agent gets exactly one directory', async () => {
  const s = await fresh()
  const profiles = await Promise.all(Array.from({ length: 8 }, () => s.ensure('alice')))
  expect(new Set(profiles.map((p) => p.id)).size).toBe(1)
})
it.each(['../outside', 'a/b', 'a\\b', '.', '..', '', 'a\0b'])('rejects path-shaped agent names %j', async (agent) => {
  const s = await fresh()
  await expect(s.ensure(agent)).rejects.toThrow()
  await expect(s.renameAgent('alice', agent)).rejects.toThrow()
})
it('creates private directories and metadata even under a permissive umask', async () => {
  const old = process.umask(0)
  try {
    const s = await fresh(),
      p = await s.ensure('alice')
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'browsers'))).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await fs.stat(p.dir)).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await fs.stat(metadata())).mode & 0o777).toBe(0o600)
  } finally {
    process.umask(old)
  }
})
it('keeps disk and memory unchanged if atomic replacement fails', async () => {
  const s = await fresh()
  await s.ensure('alice')
  const before = await fs.readFile(metadata(), 'utf8')
  // EIO, not EACCES: Windows retries a rename refused for a lock (renameRetrying).
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('i/o error'), { code: 'EIO' }))
  await expect(s.ensure('bob')).rejects.toThrow()
  expect(s.agents()).toEqual(['alice'])
  expect(await fs.readFile(metadata(), 'utf8')).toBe(before)
  expect((await fs.readdir(join(dir, 'browsers'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
})
it('never overwrites unreadable metadata', async () => {
  await (await fresh()).ensure('alice')
  const before = await fs.readFile(metadata(), 'utf8')
  const s = new BrowserProfileStore(dir)
  const read = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(s.load()).rejects.toThrow()
  await expect(s.ensure('bob')).rejects.toThrow()
  read.mockRestore()
  expect(await fs.readFile(metadata(), 'utf8')).toBe(before)
})
it.each([
  '{oops',
  '{"version":1,"profiles":{"alice":"../outside"}}',
  '{"version":1,"profiles":{"a":"00000000-0000-4000-8000-000000000001","b":"00000000-0000-4000-8000-000000000001"}}'
])('fails closed for corrupt metadata %j', async (raw) => {
  await fs.mkdir(join(dir, 'browsers'))
  await fs.writeFile(metadata(), raw)
  const s = new BrowserProfileStore(dir)
  await expect(s.load()).rejects.toThrow()
  await expect(s.ensure('bob')).rejects.toThrow()
  expect(await fs.readFile(metadata(), 'utf8')).toBe(raw)
})
it('rejects a symlinked profile directory without accessing its contents', async () => {
  const s = await fresh(),
    a = await s.ensure('alice')
  await fs.rmdir(a.dir)
  await fs.symlink(dir, a.dir, 'junction') // a junction needs no privilege on Windows; POSIX ignores the type
  await expect(s.ensure('alice')).rejects.toThrow()
})
it.skipIf(!symlinksWork)('does not follow metadata replaced with a symlink after load', async () => {
  const s = await fresh()
  await s.ensure('alice')
  const target = join(dir, 'keep.json')
  await fs.writeFile(target, 'keep private state')
  await fs.unlink(metadata())
  await fs.symlink(target, metadata())
  await expect(s.renameAgent('alice', 'bob')).rejects.toThrow()
  expect(await fs.readFile(target, 'utf8')).toBe('keep private state')
  expect(s.agents()).toEqual(['alice'])
})
it('uses the injected identity source and refuses to reuse retained orphan data', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const s = new BrowserProfileStore(dir, () => id)
  await s.load()
  const a = await s.ensure('alice')
  expect(a.id).toBe(id)
  await s.detachAgents(['alice'])
  await expect(s.ensure('bob')).rejects.toThrow()
  expect(s.agents()).toEqual([])
})
it('close waits for a write in flight and refuses later ones, so nothing lands after shutdown', async () => {
  const s = await fresh()
  const inFlight = s.ensure('alice')
  await s.close()
  const a = await inFlight
  expect(JSON.parse(await fs.readFile(metadata(), 'utf8')).profiles).toEqual({ alice: a.id })
  await expect(s.ensure('bob')).rejects.toThrow()
  await expect(s.byId(a.id)).rejects.toThrow()
  expect((await fs.readdir(join(dir, 'browsers'))).sort()).toEqual([a.id, 'profiles.json'].sort())
  expect(JSON.parse(await fs.readFile(metadata(), 'utf8')).profiles).toEqual({ alice: a.id })
})
it('keeps desktop profiles in their own folder', async () => {
  const s = new BrowserProfileStore(dir, randomUUID, 'desktops')
  await s.load()
  const a = await s.ensure('alice')
  expect(a.dir).toBe(join(dir, 'desktops', a.id))
  expect(JSON.parse(await fs.readFile(join(dir, 'desktops', 'profiles.json'), 'utf8')).profiles).toEqual({ alice: a.id })
  if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'desktops'))).mode & 0o777).toBe(0o700)
  await expect(fs.access(join(dir, 'browsers'))).rejects.toThrow()
  // A browser profile of the same agent is a different one.
  expect((await (await fresh()).ensure('alice')).id).not.toBe(a.id)
})
