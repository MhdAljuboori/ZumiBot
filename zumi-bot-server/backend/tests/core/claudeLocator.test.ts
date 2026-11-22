import { expect, test } from 'vitest'
import { locateClaude, type LocateDeps } from '../../src/core/chat/claudeLocator'

const mk = (exec: string[], o: Partial<LocateDeps> = {}): LocateDeps => ({
  override: null,
  pathEnv: '/a/bin:/b/bin',
  home: '/home/u',
  isExecutable: async (p) => exec.includes(p),
  loginShellWhich: async () => '/shell/claude',
  platform: 'linux',
  ...o
})

test('override wins', async () => {
  const d = mk(['/o/claude', '/a/bin/claude'], { override: '/o/claude' })
  expect(await locateClaude(d)).toBe('/o/claude')
})
test('PATH beats ~/.local/bin', async () => {
  expect(await locateClaude(mk(['/b/bin/claude', '/home/u/.local/bin/claude']))).toBe('/b/bin/claude')
})
test('~/.local/bin beats login shell', async () => {
  expect(await locateClaude(mk(['/home/u/.local/bin/claude', '/shell/claude']))).toBe('/home/u/.local/bin/claude')
})
test('login shell fallback', async () => {
  expect(await locateClaude(mk(['/shell/claude']))).toBe('/shell/claude')
})
test('nothing found returns null', async () => {
  expect(await locateClaude(mk([], { loginShellWhich: async () => null }))).toBeNull()
  expect(await locateClaude(mk([]))).toBeNull()
})
test('on a Mac, Homebrew folders come after ~/.local/bin and before the login shell; elsewhere they are not looked at', async () => {
  const mac = { platform: 'darwin' as const }
  expect(await locateClaude(mk(['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/shell/claude'], mac))).toBe('/opt/homebrew/bin/claude')
  expect(await locateClaude(mk(['/usr/local/bin/claude', '/shell/claude'], mac))).toBe('/usr/local/bin/claude')
  expect(await locateClaude(mk(['/home/u/.local/bin/claude', '/opt/homebrew/bin/claude'], mac))).toBe('/home/u/.local/bin/claude')
  expect(await locateClaude(mk(['/opt/homebrew/bin/claude', '/shell/claude']))).toBe('/shell/claude')
})
