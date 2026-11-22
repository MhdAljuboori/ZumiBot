import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { engineCaps } from '@zumibot/shared/engine'
import { acpEngine, acpStartOf } from '../../src/core/engines/acpEngine'
import { acpLocate } from '../../src/core/acp/acpLocator'
import { turnStart, type RunHandle } from '../../src/core/engines/engine'
import type { AcpRunOptions } from '../../src/core/acp/acpRunner'
import { fakeBinName } from '../support/fakeBin'

const handle: RunHandle = {
  stop: () => {},
  send: () => false,
  done: Promise.resolve({ exitCode: 0, signal: null, stderr: '', spawnError: null, result: null, stopped: false })
}
const onEvent = () => {}
const config = { args: ['--acp'], systemPrompt: 'Be terse.', requestTag: 'tag-1' }

describe('acpStartOf', () => {
  it('maps new and resume; a fork never reaches ACP (no rewind), so it throws', () => {
    expect(acpStartOf(turnStart(null))).toEqual({ kind: 'new' })
    expect(acpStartOf(turnStart('s1'))).toEqual({ kind: 'resume', sessionId: 's1' })
    expect(() => acpStartOf(turnStart('s1', 'u1'))).toThrow()
  })
})

describe('acpEngine', () => {
  const locates: Array<string | undefined> = []
  const seen: AcpRunOptions[] = []
  const adapter = acpEngine({
    caps: () => engineCaps('claude'),
    locate: async (agent) => {
      locates.push(agent)
      return '/bin/agent'
    },
    run: (o) => {
      seen.push(o)
      return handle
    }
  })

  it('is the acp engine, and reads caps and locate through its deps, passing the agent name', async () => {
    expect(adapter.engine).toBe('acp')
    expect(adapter.caps()).toEqual(engineCaps('claude'))
    expect(await adapter.locate('gemini')).toBe('/bin/agent')
    expect(locates).toEqual(['gemini'])
  })

  it('starts a turn with the turn and its own config', () => {
    seen.length = 0
    const env = { PATH: '/bin' }
    expect(
      adapter.start({ bin: '/bin/agent', cwd: '/w', env, start: turnStart('s1'), action: { kind: 'turn', prompt: 'hi' }, onEvent }, config)
    ).toBe(handle)
    expect(seen).toEqual([
      {
        bin: '/bin/agent',
        args: ['--acp'],
        cwd: '/w',
        env,
        start: { kind: 'resume', sessionId: 's1' },
        prompt: 'hi',
        systemPrompt: 'Be terse.',
        requestTag: 'tag-1',
        onEvent
      }
    ])
  })

  it('a new session starts new', () => {
    seen.length = 0
    adapter.start(
      { bin: '/bin/agent', cwd: '/w', env: {}, start: turnStart(null), action: { kind: 'turn', prompt: 'hi' }, onEvent },
      config
    )
    expect(seen[0].start).toEqual({ kind: 'new' })
  })

  it('refuses a fork and a compaction, which ACP has no form of, before anything runs', () => {
    seen.length = 0
    expect(() =>
      adapter.start(
        { bin: '/bin/agent', cwd: '/w', env: {}, start: turnStart('s1', 'u1'), action: { kind: 'turn', prompt: 'hi' }, onEvent },
        config
      )
    ).toThrow()
    expect(() =>
      adapter.start(
        { bin: '/bin/agent', cwd: '/w', env: {}, start: turnStart('s1'), action: { kind: 'compact', prompt: '/compact' }, onEvent },
        config
      )
    ).toThrow()
    expect(seen).toEqual([])
  })
})

describe('acpLocate', () => {
  const root = mkdtempSync(join(tmpdir(), 'cb-acp-locate-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const a = join(root, 'a'),
    b = join(root, 'b')
  mkdirSync(a)
  mkdirSync(b)
  // Named as a PATH lookup finds them: `agent`, or `agent.exe` on Windows.
  mkdirSync(join(b, fakeBinName('dirname')))
  const exe = (p: string) => {
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, 0o755)
    return p
  }
  exe(join(b, fakeBinName('agent')))
  exe(join(a, fakeBinName('first')))
  exe(join(b, fakeBinName('first')))
  writeFileSync(join(a, 'plain'), 'not executable')
  const PATH = [a, b].join(delimiter)
  const abs = exe(join(root, 'abs-agent'))

  it('resolves a bare name on the given env PATH, in PATH order', async () => {
    expect(await acpLocate('agent', { PATH })).toBe(join(b, fakeBinName('agent')))
    expect(await acpLocate('first', { PATH })).toBe(join(a, fakeBinName('first')))
  })

  it('finds nothing for a missing, non-executable or directory name, or with no PATH', async () => {
    expect(await acpLocate('missing', { PATH })).toBeNull()
    expect(await acpLocate('plain', { PATH: a })).toBeNull()
    expect(await acpLocate('dirname', { PATH: b })).toBeNull()
    expect(await acpLocate('agent', {})).toBeNull()
  })

  it('reads the run env PATH only, never this process PATH', async () => {
    expect(await acpLocate('sh', { PATH: a })).toBeNull()
  })

  it('checks that an absolute path is an executable file', async () => {
    expect(await acpLocate(abs, {})).toBe(abs)
    // Windows has no execute bit: an absolute path there only has to be a file.
    if (process.platform !== 'win32') expect(await acpLocate(join(a, 'plain'), {})).toBeNull()
    expect(await acpLocate(b, {})).toBeNull()
    expect(await acpLocate(join(root, 'nope'), {})).toBeNull()
  })

  it('refuses a relative path with a slash, and an empty or odd name', async () => {
    expect(await acpLocate('b/agent', { PATH: root })).toBeNull()
    expect(await acpLocate('./agent', { PATH: b })).toBeNull()
    expect(await acpLocate('', { PATH: b })).toBeNull()
    expect(await acpLocate('..', { PATH: b })).toBeNull()
  })
})
