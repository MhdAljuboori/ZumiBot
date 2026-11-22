import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_IDS, CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import { ConnectorStore } from '../../src/core/connectors/connectorStore'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-connectors-'))
  file = join(dir, 'connectors.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const fresh = async () => {
  const s = new ConnectorStore(dir)
  await s.load()
  return s
}
const stored = async () => JSON.parse(await fs.readFile(file, 'utf8'))

// Windows has no mode bits, so chmod cannot make the file unreadable there: a read failing with EACCES stands in.
const isWin = process.platform === 'win32'
let denyRead: MockInstance | null = null
const unreadable = async () => {
  if (!isWin) return fs.chmod(file, 0o000)
  const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>
  denyRead = vi
    .spyOn(fs, 'readFile')
    .mockImplementation(((p: unknown, ...rest: unknown[]) =>
      p === file ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : real(p, ...rest)) as typeof fs.readFile)
}
const readable = async () => {
  if (!isWin) return fs.chmod(file, 0o600)
  denyRead?.mockRestore()
  denyRead = null
}

describe('ConnectorStore', () => {
  it('missing file is not migrated', async () => {
    const s = await fresh()
    expect(s.migrated()).toBe(false)
    expect(s.migration()).toBeNull()
    expect(s.onFor('a')).toBeNull()
    expect(s.offFor('a')).toEqual([])
    await expect(s.set('a', 'gmail', true)).rejects.toThrow(CONNECTOR_TEXT.settingUp)
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('replace then set round-trips', async () => {
    const s = await fresh()
    await s.replace({ a: ['slack', 'gmail'] }, 'kept')
    expect(s.migrated()).toBe(true)
    expect(s.onFor('a')).toEqual(['gmail', 'slack'])
    await s.set('a', 'notion', true)
    const r = await fresh()
    expect(r.onFor('a')).toEqual(['gmail', 'notion', 'slack'])
    expect(r.offFor('a')).toEqual(['google-calendar', 'google-drive', 'github', 'linear'])
    expect(r.migration()).toBe('kept')
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await stored()).toEqual({ v: 1, agents: { a: ['gmail', 'notion', 'slack'] }, migration: 'kept', remember: {} })
  })

  it('set off removes the id and an emptied agent', async () => {
    const s = await fresh()
    await s.replace({ a: ['gmail'] }, 'kept')
    await s.set('a', 'gmail', false)
    expect(s.onFor('a')).toEqual([])
    expect(s.agents()).toEqual([])
    expect((await stored()).agents).toEqual({})
    expect(s.offFor('a')).toHaveLength(7)
  })

  it('replace runs once', async () => {
    const s = await fresh()
    await s.replace({ a: ['gmail'] }, 'kept')
    await s.replace({ b: ['gmail'] }, 'kept')
    expect(s.onFor('b')).toEqual([])
    expect(s.onFor('a')).toEqual(['gmail'])
  })

  it('a failed switch-over leaves everything off', async () => {
    const s = await fresh()
    await s.replace({}, 'failed')
    expect(s.migrated()).toBe(true)
    expect(s.migration()).toBe('failed')
    expect(s.onFor('a')).toEqual([])
    expect((await fresh()).migration()).toBe('failed')
  })

  it('unknown ids are dropped on read', async () => {
    await fs.writeFile(file, JSON.stringify({ v: 1, agents: { a: ['gmail', 'fax'], b: 'gmail', c: ['fax'] }, migration: 'kept' }))
    const s = await fresh()
    expect(s.onFor('a')).toEqual(['gmail'])
    expect(s.onFor('b')).toEqual([])
    expect(s.agents()).toEqual(['a'])
  })

  it('corrupt file is moved aside and reads as all off', async () => {
    await fs.writeFile(file, '{not json')
    const s = await fresh()
    expect(s.migrated()).toBe(true)
    expect(s.migration()).toBe('failed')
    expect(s.onFor('a')).toEqual([])
    const names = await fs.readdir(dir)
    expect(names.some((n) => n.startsWith('connectors.json.corrupt-'))).toBe(true)
    expect(await stored()).toEqual({ v: 1, agents: {}, migration: 'failed', remember: {} })
  })

  it('a corrupt file reads as all off after a restart too', async () => {
    await fs.writeFile(file, '{not json')
    await fresh()
    const r = await fresh()
    expect(r.migrated()).toBe(true)
    expect(r.migration()).toBe('failed')
    expect(r.onFor('a')).toEqual([])
    expect(r.offFor('a')).toHaveLength(7)
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['another version', '{"v":2,"agents":{"a":["gmail"]},"migration":"kept"}']
  ])('JSON of the wrong shape (%s) is moved aside and persisted as failed', async (_n, body) => {
    await fs.writeFile(file, body)
    const s = await fresh()
    expect(s.migration()).toBe('failed')
    expect(s.onFor('a')).toEqual([])
    const names = await fs.readdir(dir)
    const aside = names.find((n) => n.startsWith('connectors.json.corrupt-'))
    expect(aside).toBeDefined()
    expect(await fs.readFile(join(dir, aside!), 'utf8')).toBe(body)
    const r = await fresh()
    expect(r.migration()).toBe('failed')
    expect(r.onFor('a')).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('unreadable file is never overwritten', async () => {
    const body = JSON.stringify({ v: 1, agents: { a: ['gmail'] }, migration: 'kept' })
    await fs.writeFile(file, body)
    await unreadable()
    const s = await fresh()
    expect(s.migrated()).toBe(true)
    expect(s.onFor('a')).toEqual([])
    await expect(s.set('a', 'slack', true)).rejects.toThrow('connectors.json could not be read, so the change was not saved')
    await expect(s.replace({ a: ['slack'] }, 'kept')).resolves.toBeUndefined()
    await readable()
    expect(await fs.readFile(file, 'utf8')).toBe(body)
    // Once readable, the next change re-reads first and keeps what was stored.
    await s.set('a', 'slack', true)
    expect(s.onFor('a')).toEqual(['gmail', 'slack'])
  })

  it('rename moves synchronously', async () => {
    const s = await fresh()
    await s.replace({ a: ['gmail'] }, 'kept')
    const p = s.renameAgent('a', 'b')
    expect(s.onFor('b')).toEqual(['gmail'])
    expect(s.onFor('a')).toEqual([])
    await p
    expect((await stored()).agents).toEqual({ b: ['gmail'] })
  })

  it('rename onto an agent with entries joins both lists', async () => {
    const s = await fresh()
    await s.replace({ a: ['slack'], b: ['gmail'] }, 'kept')
    await s.renameAgent('a', 'b')
    expect(s.onFor('b')).toEqual(['gmail', 'slack'])
    expect(s.agents()).toEqual(['b'])
  })

  it('forgetAgents drops entries and agents() lists only names holding ids', async () => {
    const s = await fresh()
    await s.replace({ a: ['gmail'], b: ['slack'], c: [] }, 'kept')
    expect(s.agents().sort()).toEqual(['a', 'b'])
    await s.forgetAgents(['a', 'zzz'])
    expect(s.agents()).toEqual(['b'])
    expect((await stored()).agents).toEqual({ b: ['slack'] })
  })

  it('queued writes all land', async () => {
    const s = await fresh()
    await s.replace({ a: [] }, 'kept')
    await Promise.all(['gmail', 'slack', 'linear'].map((id) => s.set('a', id as 'gmail', true)))
    expect((await fresh()).onFor('a')).toEqual(['gmail', 'slack', 'linear'])
  })
})

// The remembering services in catalog order, read through the one public question.
const remembering = (s: ConnectorStore) => CONNECTOR_IDS.filter((id) => s.remembers(id))

describe('ConnectorStore remember', () => {
  it('round-trips and writes the file shape at 0600', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    expect(s.remembers('gmail')).toBe(false)
    await s.setRemember('slack', true)
    await s.setRemember('gmail', true)
    expect(s.remembers('gmail')).toBe(true)
    expect(remembering(s)).toEqual(['gmail', 'slack'])
    const r = await fresh()
    expect(r.remembers('gmail')).toBe(true)
    expect(r.remembers('slack')).toBe(true)
    expect(r.remembers('linear')).toBe(false)
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await stored()).toEqual({ v: 1, agents: {}, migration: 'kept', remember: { gmail: true, slack: true } })
    expect(Object.keys(await stored())).toEqual(['v', 'agents', 'migration', 'remember'])
  })

  it('off removes the key', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    await s.setRemember('gmail', true)
    await s.setRemember('gmail', false)
    expect(s.remembers('gmail')).toBe(false)
    expect((await stored()).remember).toEqual({})
  })

  it('a phase-1 file without remember loads with every id false', async () => {
    await fs.writeFile(file, JSON.stringify({ v: 1, agents: { a: ['gmail'] }, migration: 'kept' }))
    const s = await fresh()
    expect(remembering(s)).toEqual([])
    expect(s.remembers('gmail')).toBe(false)
    expect(s.onFor('a')).toEqual(['gmail'])
  })

  it('drops unknown ids and non-true values without calling the file corrupt', async () => {
    await fs.writeFile(file, JSON.stringify({ v: 1, agents: {}, migration: 'kept', remember: { gmail: true, nope: true, slack: 'yes' } }))
    const s = await fresh()
    expect(remembering(s)).toEqual(['gmail'])
    expect((await fs.readdir(dir)).some((n) => n.startsWith('connectors.json.corrupt-'))).toBe(false)
  })

  it('a remember of the wrong type reads as none', async () => {
    await fs.writeFile(file, JSON.stringify({ v: 1, agents: {}, migration: 'kept', remember: ['gmail'] }))
    expect(remembering(await fresh())).toEqual([])
  })

  it('replace keeps remember, and rename and forget leave it alone', async () => {
    await fs.writeFile(file, JSON.stringify({ v: 1, agents: {}, migration: 'kept', remember: { gmail: true } }))
    const s = await fresh()
    await s.replace({}, 'kept')
    expect(s.remembers('gmail')).toBe(true)
    await s.set('a', 'slack', true)
    await s.renameAgent('a', 'b')
    await s.forgetAgents(['b'])
    expect(s.remembers('gmail')).toBe(true)
    expect((await stored()).remember).toEqual({ gmail: true })
  })

  it('a corrupt file resets remember to none', async () => {
    await fs.writeFile(file, '{not json')
    const s = await fresh()
    expect(remembering(s)).toEqual([])
    expect((await stored()).remember).toEqual({})
  })

  it('before the switch-over there is nothing to change', async () => {
    const s = await fresh()
    await expect(s.setRemember('gmail', true)).rejects.toThrow(CONNECTOR_TEXT.settingUp)
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('queued with set, all land', async () => {
    const s = await fresh()
    await s.replace({ a: [] }, 'kept')
    await Promise.all([s.set('a', 'gmail', true), s.setRemember('gmail', true), s.set('a', 'slack', true), s.setRemember('slack', true)])
    const r = await fresh()
    expect(r.onFor('a')).toEqual(['gmail', 'slack'])
    expect(remembering(r)).toEqual(['gmail', 'slack'])
  })

  it.skipIf(process.getuid?.() === 0)('an unreadable file is never overwritten', async () => {
    const body = JSON.stringify({ v: 1, agents: {}, migration: 'kept', remember: { gmail: true } })
    await fs.writeFile(file, body)
    await unreadable()
    const s = await fresh()
    expect(s.remembers('gmail')).toBe(false)
    await expect(s.setRemember('slack', true)).rejects.toThrow('connectors.json could not be read, so the change was not saved')
    await readable()
    expect(await fs.readFile(file, 'utf8')).toBe(body)
    await s.setRemember('slack', true)
    expect(remembering(s)).toEqual(['gmail', 'slack'])
  })
})

// A read-only folder fails the atomic write (its temp file cannot be made); root ignores the mode. Windows has no mode
// bits: a rename failing with a code renameRetrying does not retry stands in.
describe.skipIf(process.getuid?.() === 0)('ConnectorStore after a failed write', () => {
  let failRename: MockInstance | null = null
  const lock = async () => {
    if (!isWin) return fs.chmod(dir, 0o500)
    failRename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }))
  }
  const unlock = async () => {
    if (!isWin) return fs.chmod(dir, 0o700)
    failRename?.mockRestore()
    failRename = null
  }
  afterEach(unlock)

  it('setRemember rejects, remembers nothing, and a later write does not persist it', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    await lock()
    await expect(s.setRemember('gmail', true)).rejects.toThrow()
    expect(s.remembers('gmail')).toBe(false)
    await unlock()
    await s.set('a', 'slack', true)
    expect((await stored()).remember).toEqual({})
    expect(remembering(await fresh())).toEqual([])
  })

  it('a failed switch-off puts the remembered value back', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    await s.setRemember('gmail', true)
    await lock()
    await expect(s.setRemember('gmail', false)).rejects.toThrow()
    expect(s.remembers('gmail')).toBe(true)
  })

  it('set rejects, leaves the connector off, and a later write does not persist it', async () => {
    const s = await fresh()
    await s.replace({ a: ['slack'] }, 'kept')
    await lock()
    await expect(s.set('a', 'gmail', true)).rejects.toThrow()
    expect(s.onFor('a')).toEqual(['slack'])
    await unlock()
    await s.setRemember('linear', true)
    expect((await stored()).agents).toEqual({ a: ['slack'] })
  })

  it('a failed set of a first connector leaves the agent with no entry', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    await lock()
    await expect(s.set('a', 'gmail', true)).rejects.toThrow()
    expect(s.agents()).toEqual([])
  })

  it('a failure does not undo a value a later call already changed', async () => {
    const s = await fresh()
    await s.replace({}, 'kept')
    // Only the first save fails; the queued second one goes through.
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    const failing = s.setRemember('gmail', true)
    const later = s.setRemember('gmail', false)
    await expect(failing).rejects.toThrow('disk full')
    await later
    rename.mockRestore()
    expect(s.remembers('gmail')).toBe(false)
    expect((await stored()).remember).toEqual({})
  })
})
