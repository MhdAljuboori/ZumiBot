import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acpRecord, aguiRecord, LaunchTrust, type LaunchRecord } from '../../src/core/acp/launchTrust'

let dir: string
let file: string
const gemini: LaunchRecord = { provider: 'acp', command: 'gemini', args: ['--acp'], authEnv: ['GEMINI_API_KEY'] }

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'launch-trust-'))
  file = join(dir, 'protocol-launch.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const loaded = async (): Promise<LaunchTrust> => {
  const t = new LaunchTrust(dir)
  await t.load()
  return t
}

describe('LaunchTrust', () => {
  it('a confirmed launch checks ok; a different one is changed; an agent with none is none', async () => {
    const t = await loaded()
    expect(t.check('gem', gemini)).toBe('none')
    await t.confirm('gem', gemini)
    expect(t.check('gem', gemini)).toBe('ok')
    expect(t.check('gem', { ...gemini })).toBe('ok')
    expect(t.check('gem', { ...gemini, command: '/tmp/evil' })).toBe('changed')
    expect(t.check('gem', { ...gemini, args: ['--acp', '--yolo'] })).toBe('changed')
    expect(t.check('gem', { ...gemini, args: [] })).toBe('changed')
    expect(t.check('gem', { ...gemini, authEnv: [] })).toBe('changed')
    expect(t.check('gem', { ...gemini, authEnv: ['GEMINI_API_KEY', 'OPENAI_API_KEY'] })).toBe('changed')
    expect(t.check('other', gemini)).toBe('none')
    expect(t.confirmed('gem')).toEqual(gemini)
    expect(t.confirmed('other')).toBeNull()
  })

  it('argument order is part of the launch', async () => {
    const t = await loaded()
    await t.confirm('gem', { ...gemini, args: ['--a', '--b'] })
    expect(t.check('gem', { ...gemini, args: ['--b', '--a'] })).toBe('changed')
  })

  it('is kept in <data>/protocol-launch.json, 0600, with the launch itself, and read back by a new instance', async () => {
    const t = await loaded()
    await t.confirm('gem', gemini)
    const st = await fs.stat(file)
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ agents: { gem: gemini } })
    const again = await loaded()
    expect(again.check('gem', gemini)).toBe('ok')
    expect(again.agents()).toEqual(['gem'])
  })

  it('a confirm replaces the earlier launch', async () => {
    const t = await loaded()
    await t.confirm('gem', gemini)
    const next = { ...gemini, args: ['--experimental-acp'] }
    await t.confirm('gem', next)
    expect(t.check('gem', gemini)).toBe('changed')
    expect(t.check('gem', next)).toBe('ok')
  })

  it('rename moves the entry to the new name and drops the old one', async () => {
    const t = await loaded()
    await t.confirm('gem', gemini)
    await t.rename('gem', 'gemini-helper')
    expect(t.check('gem', gemini)).toBe('none')
    expect(t.check('gemini-helper', gemini)).toBe('ok')
    expect((await loaded()).check('gemini-helper', gemini)).toBe('ok')
  })

  it("rename of an agent with no entry changes nothing: the watcher's rename after an Agent Studio Save keeps what that Save confirmed", async () => {
    const t = await loaded()
    // Agent Studio renamed in place and confirmed under the new name; the watcher then sees the same path's new name.
    await t.confirm('b', gemini)
    await t.rename('a', 'b')
    expect(t.check('b', gemini)).toBe('ok')
    expect(t.agents()).toEqual(['b'])
  })

  it('remove drops the named entries only', async () => {
    const t = await loaded()
    await t.confirm('a', gemini)
    await t.confirm('b', gemini)
    await t.confirm('c', gemini)
    await t.remove(['a', 'c', 'never'])
    expect(t.agents()).toEqual(['b'])
    expect((await loaded()).agents()).toEqual(['b'])
  })

  it('calls take effect in the order made, before any lands: a rename then a remove of the new name drops it', async () => {
    const t = await loaded()
    await t.confirm('old', gemini)
    const renamed = t.rename('old', 'new')
    const removed = t.remove(['new'])
    await Promise.all([renamed, removed])
    expect(t.agents()).toEqual([])
    // And a rename then a confirm keeps the confirmed launch, not the moved one.
    await t.confirm('a', gemini)
    const next = { ...gemini, args: ['--other'] }
    await Promise.all([t.rename('a', 'b'), t.confirm('b', next)])
    expect(t.check('b', next)).toBe('ok')
  })

  it('writes queue: concurrent confirms all land', async () => {
    const t = await loaded()
    await Promise.all(['a', 'b', 'c', 'd'].map((n) => t.confirm(n, { ...gemini, command: n })))
    const again = await loaded()
    for (const n of ['a', 'b', 'c', 'd']) expect(again.check(n, { ...gemini, command: n })).toBe('ok')
  })

  it('a stored entry that is not a launch is never trusted', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        agents: {
          gem: { provider: 'acp', command: 'gemini', args: '--acp' },
          odd: { provider: 'ag-ui', command: 'gemini', args: ['--acp'], authEnv: [] }
        }
      })
    )
    const t = await loaded()
    expect(t.check('gem', gemini)).toBe('changed')
    expect(t.check('odd', { ...gemini, authEnv: [] })).toBe('changed')
  })

  it('names that are Object.prototype members are plain names', async () => {
    const t = await loaded()
    for (const n of ['__proto__', 'toString', 'constructor']) expect(t.check(n, gemini)).toBe('none')
    await t.confirm('__proto__', gemini)
    expect(t.check('__proto__', gemini)).toBe('ok')
    expect(t.check('toString', gemini)).toBe('none')
    expect((await loaded()).check('__proto__', gemini)).toBe('ok')
  })

  it('a file that is not JSON is moved aside: nothing is trusted, and the next confirm writes a fresh file', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await fs.writeFile(file, '{not json')
      const t = await loaded()
      expect(t.check('gem', gemini)).toBe('none')
      expect((await fs.readdir(dir)).some((f) => f.startsWith('protocol-launch.json.corrupt-'))).toBe(true)
      await t.confirm('gem', gemini)
      expect((await loaded()).check('gem', gemini)).toBe('ok')
    } finally {
      log.mockRestore()
    }
  })

  it('a file that cannot be read trusts nothing and is never replaced; a write that fails changes nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await fs.mkdir(file) // EISDIR on read, and no rename can land on it
      const t = await loaded()
      expect(t.check('gem', gemini)).toBe('none')
      const logged = log.mock.calls.length
      // Nothing to drop or move: no error and no log (every non-ACP Save asks for a remove).
      await expect(t.remove(['gem'])).resolves.toBeUndefined()
      await expect(t.rename('gem', 'other')).resolves.toBeUndefined()
      expect(log.mock.calls.length).toBe(logged)
      await expect(t.confirm('gem', gemini)).rejects.toThrow()
      expect(t.check('gem', gemini)).toBe('none')
      expect((await fs.stat(file)).isDirectory()).toBe(true)
      // The log names the file's code, never a launch.
      expect(log.mock.calls.flat().map(String).join(' ')).not.toContain('gemini')
    } finally {
      log.mockRestore()
    }
  })

  describe('AG-UI records beside ACP ones', () => {
    const remote: LaunchRecord = {
      provider: 'ag-ui',
      endpoint: 'https://agents.example.com/run',
      authKey: 'EXAMPLE_AGENT_KEY',
      authHeader: null
    }

    it('aguiRecord and acpRecord tag the launch with its provider', () => {
      expect(aguiRecord({ endpoint: 'https://a.example.com/run', authKey: null, authHeader: null })).toEqual({
        provider: 'ag-ui',
        endpoint: 'https://a.example.com/run',
        authKey: null,
        authHeader: null
      })
      expect(acpRecord({ command: 'gemini', args: [], authEnv: [] })).toEqual({ provider: 'acp', command: 'gemini', args: [], authEnv: [] })
    })

    it('a confirmed endpoint checks ok; any change of endpoint, key or header is changed', async () => {
      const t = await loaded()
      expect(t.check('rem', remote)).toBe('none')
      await t.confirm('rem', remote)
      expect(t.check('rem', remote)).toBe('ok')
      expect(t.check('rem', { ...remote })).toBe('ok')
      expect(t.check('rem', { ...remote, endpoint: 'https://evil.example.com/run' })).toBe('changed')
      expect(t.check('rem', { ...remote, endpoint: 'https://agents.example.com/run?x=1' })).toBe('changed')
      expect(t.check('rem', { ...remote, authKey: 'OTHER_KEY' })).toBe('changed')
      expect(t.check('rem', { ...remote, authKey: null })).toBe('changed')
      expect(t.check('rem', { ...remote, authHeader: 'X-Api-Key' })).toBe('changed')
      expect(t.confirmed('rem')).toEqual(remote)
    })

    it("mixed records: one provider's record never confirms the other's, and both are kept side by side, 0600", async () => {
      const t = await loaded()
      await t.confirm('gem', gemini)
      await t.confirm('rem', remote)
      expect(t.check('gem', gemini)).toBe('ok')
      expect(t.check('rem', remote)).toBe('ok')
      // The same agent switched engine: its old record is another provider's, so the new launch is changed until saved.
      expect(t.check('gem', aguiRecord({ endpoint: 'https://a.example.com/run', authKey: null, authHeader: null }))).toBe('changed')
      expect(t.check('rem', gemini)).toBe('changed')
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ agents: { gem: gemini, rem: remote } })
      if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      // Stable JSON: the record's fields in a fixed order, so a byte compare of two saves holds.
      expect(await fs.readFile(file, 'utf8')).toContain(
        '"rem": {\n      "provider": "ag-ui",\n      "endpoint": "https://agents.example.com/run",\n      "authKey": "EXAMPLE_AGENT_KEY",\n      "authHeader": null\n    }'
      )
      const again = await loaded()
      expect(again.confirmed('gem')).toEqual(gemini)
      expect(again.confirmed('rem')).toEqual(remote)
      // A confirm replaces the other provider's record, and a rename moves either kind.
      await again.confirm('gem', remote)
      expect(again.check('gem', gemini)).toBe('changed')
      expect(again.check('gem', remote)).toBe('ok')
      await again.rename('rem', 'remote-2')
      expect(again.check('remote-2', remote)).toBe('ok')
    })

    it('a stored AG-UI entry that is not a launch is never trusted', async () => {
      await fs.writeFile(
        file,
        JSON.stringify({
          agents: {
            bad: { provider: 'ag-ui', endpoint: 'ftp://a.example.com/run', authKey: null, authHeader: null },
            none: { provider: 'ag-ui', authKey: null, authHeader: null },
            acpShaped: { provider: 'acp', endpoint: 'https://agents.example.com/run', authKey: 'EXAMPLE_AGENT_KEY', authHeader: null }
          }
        })
      )
      const t = await loaded()
      expect(t.check('bad', { ...remote, endpoint: 'ftp://a.example.com/run', authKey: null })).toBe('changed')
      expect(t.check('none', remote)).toBe('changed')
      expect(t.check('acpShaped', remote)).toBe('changed')
      expect(t.confirmed('bad')).toBeNull()
    })

    it("a confirm keeps its own copy: changing the caller's record later changes nothing stored", async () => {
      const t = await loaded()
      const mine = { ...remote }
      await t.confirm('rem', mine)
      mine.endpoint = 'https://evil.example.com/run'
      expect(t.check('rem', remote)).toBe('ok')
    })
  })
})
