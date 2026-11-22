import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GhError, createGhLocator, isAuthError, makeGh } from '../../../src/core/github/gh'
import { locateBin, type LocateDeps } from '../../../src/core/chat/claudeLocator'
import { writeFakeBin } from '../../support/fakeBin'

const FAKE_GH = fileURLToPath(new URL('../../fixtures/fake-gh.mjs', import.meta.url))

let dir: string
let bin: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-gh-')))
  bin = writeFakeBin(dir, 'gh', FAKE_GH)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describe('locateBin', () => {
  // POSIX paths and lookup rules on every machine; the Windows rules are claudeLocator's own tests.
  const deps = (found: string[], name = 'gh'): LocateDeps => ({
    platform: 'linux',
    override: null,
    pathEnv: '/a/bin:/b/bin',
    home: '/home/u',
    isExecutable: async (p) => found.includes(p),
    loginShellWhich: async () => `/shell/${name}`
  })

  it('takes an override first, then PATH, then ~/.local/bin, then the login shell', async () => {
    expect(await locateBin('gh', { ...deps(['/o/gh', '/a/bin/gh']), override: '/o/gh' })).toBe('/o/gh')
    expect(await locateBin('gh', deps(['/b/bin/gh', '/home/u/.local/bin/gh']))).toBe('/b/bin/gh')
    expect(await locateBin('gh', deps(['/home/u/.local/bin/gh', '/shell/gh']))).toBe('/home/u/.local/bin/gh')
    expect(await locateBin('gh', deps(['/shell/gh']))).toBe('/shell/gh')
    expect(await locateBin('gh', deps([]))).toBeNull()
  })

  it('looks for the binary it was asked for, not for claude', async () => {
    expect(await locateBin('claude', deps(['/a/bin/claude'], 'claude'))).toBe('/a/bin/claude')
    expect(await locateBin('gh', deps(['/a/bin/claude'], 'claude'))).toBeNull()
  })
})

describe('makeGh', () => {
  it('runs gh with no shell and gives back its stdout', async () => {
    const gh = makeGh(
      async () => bin,
      () => ({ ...process.env })
    )
    const r = await gh(['pr', 'view', 'b', '--json', 'number'], dir)
    expect(JSON.parse(r.stdout)).toMatchObject({ number: 7 })
  })

  it("rejects with gh's own line, and allows the exit codes it is told to", async () => {
    const gh = makeGh(
      async () => bin,
      () => ({ ...process.env, FAKE_GH_AUTH: 'out' })
    )
    await expect(gh(['auth', 'status'], dir)).rejects.toThrow(/not logged into any GitHub hosts/)
    expect((await gh(['auth', 'status'], dir, { allowExit: [1] })).code).toBe(1)
  })

  it('says gh was not found rather than anything of the environment', async () => {
    const gh = makeGh(
      async () => null,
      () => ({})
    )
    await expect(gh(['pr', 'view'], dir)).rejects.toThrow(new GhError('gh not found'))
  })
})

describe('isAuthError', () => {
  it('knows the lines that mean "sign in again"', () => {
    expect(isAuthError('You are not logged into any GitHub hosts')).toBe(true)
    expect(isAuthError('error: Bad credentials')).toBe(true)
    expect(isAuthError('To log in, run: gh auth login')).toBe(true)
    expect(isAuthError('error: could not reach github.com')).toBe(false)
  })
})

describe('createGhLocator', () => {
  it('reports missing, logged out and ready, and only asks again once the answer has aged', async () => {
    let auth = 'out'
    let calls = 0
    const gh = makeGh(
      async () => bin,
      () => {
        calls += 1
        return { ...process.env, FAKE_GH_AUTH: auth }
      }
    )
    // state() first looks gh up on PATH: the fake's folder goes first, so the case does not need a real gh installed.
    const saved = process.env.PATH
    process.env.PATH = [dir, saved ?? ''].join(delimiter)
    onTestFinished(() => {
      process.env.PATH = saved
    })
    const loc = createGhLocator(gh)
    expect(await loc.state()).toBe('logged-out')
    auth = 'in'
    expect(await loc.state()).toBe('ready')
    const after = calls
    expect(await loc.state()).toBe('ready') // kept for a minute: gh is not asked again
    expect(calls).toBe(after)
    loc.forgetAuth()
    auth = 'out'
    expect(await loc.state()).toBe('logged-out')
  })

  it('is missing when gh is not on the machine at all', async () => {
    const loc = createGhLocator(
      makeGh(
        async () => null,
        () => ({})
      )
    )
    expect(await loc.state()).toBe('missing')
  })
})
