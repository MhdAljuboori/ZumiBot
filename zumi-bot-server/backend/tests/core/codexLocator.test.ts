import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import type { LocateDeps } from '../../src/core/chat/claudeLocator'
import { defaultCodexLocateDeps, locateCodex } from '../../src/core/codex/codexLocator'
import { fakeBinName } from '../support/fakeBin'

// What a PATH lookup finds here: `codex`, or `codex.exe` on Windows.
const CODEX = fakeBinName('codex')

// POSIX paths and lookup rules on every machine; the Windows rules are claudeLocator's own tests.
const mk = (exec: string[], o: Partial<LocateDeps> = {}): LocateDeps => ({
  platform: 'linux',
  override: null,
  pathEnv: '/a/bin:/b/bin',
  home: '/home/u',
  isExecutable: async (p) => exec.includes(p),
  loginShellWhich: async () => '/shell/codex',
  ...o
})

test('override wins', async () => {
  const d = mk(['/o/codex', '/a/bin/codex'], { override: '/o/codex' })
  expect(await locateCodex(d)).toBe('/o/codex')
})
test('PATH beats ~/.local/bin', async () => {
  expect(await locateCodex(mk(['/b/bin/codex', '/home/u/.local/bin/codex']))).toBe('/b/bin/codex')
})
test('~/.local/bin beats login shell', async () => {
  expect(await locateCodex(mk(['/home/u/.local/bin/codex', '/shell/codex']))).toBe('/home/u/.local/bin/codex')
})
test('login shell fallback', async () => {
  expect(await locateCodex(mk(['/shell/codex']))).toBe('/shell/codex')
})
test('nothing found returns null', async () => {
  expect(await locateCodex(mk([], { loginShellWhich: async () => null }))).toBeNull()
  expect(await locateCodex(mk([]))).toBeNull()
})
test('looks for codex, never claude', async () => {
  expect(await locateCodex(mk(['/a/bin/claude', '/home/u/.local/bin/claude'], { loginShellWhich: async () => null }))).toBeNull()
})

const tmp = mkdtempSync(join(tmpdir(), 'cb-codex-locate-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, ZUMIBOT_CODEX_BIN: process.env.ZUMIBOT_CODEX_BIN }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
function exe(p: string) {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, '#!/bin/sh\n')
  chmodSync(p, 0o755)
  return p
}

test('the default deps read ZUMIBOT_CODEX_BIN as the override, and a given override beats it', async () => {
  const fromEnv = exe(join(tmp, 'env', 'my-codex'))
  const given = exe(join(tmp, 'given', 'codex'))
  process.env.ZUMIBOT_CODEX_BIN = fromEnv
  expect(defaultCodexLocateDeps(null).override).toBe(fromEnv)
  expect(await locateCodex(defaultCodexLocateDeps(null))).toBe(fromEnv)
  expect(await locateCodex(defaultCodexLocateDeps(given))).toBe(given)
  process.env.ZUMIBOT_CODEX_BIN = ''
  expect(defaultCodexLocateDeps(null).override).toBeNull()
})

test('the default deps find an executable codex on PATH, and skip one that is not executable', async () => {
  delete process.env.ZUMIBOT_CODEX_BIN
  const dirA = join(tmp, 'pa'),
    dirB = join(tmp, 'pb')
  mkdirSync(dirA, { recursive: true })
  writeFileSync(join(dirA, 'codex'), '#!/bin/sh\n') // not executable (on Windows, not a name the lookup takes)
  const found = exe(join(dirB, CODEX))
  process.env.PATH = [dirA, dirB, saved.PATH ?? ''].join(delimiter)
  process.env.HOME = join(tmp, 'nohome')
  expect(await locateCodex(defaultCodexLocateDeps(null))).toBe(found)
})

// A desktop-launched server's PATH lacks nvm (it lives in .bashrc), so codex is looked up on the interactive PATH.
test('the default deps search a given PATH instead of the server process PATH', async () => {
  delete process.env.ZUMIBOT_CODEX_BIN
  const found = exe(join(tmp, 'nvm', 'bin', CODEX))
  process.env.PATH = ['/usr/bin', '/bin'].join(delimiter)
  process.env.HOME = join(tmp, 'nohome')
  const d = defaultCodexLocateDeps(null, ['/usr/bin', join(tmp, 'nvm', 'bin')].join(delimiter))
  expect(d.pathEnv).toBe(['/usr/bin', join(tmp, 'nvm', 'bin')].join(delimiter))
  expect(await locateCodex({ ...d, loginShellWhich: async () => null })).toBe(found)
})
