import { describe, expect, test } from 'vitest'
import { locateClaude, pathOf, shimTarget, type LocateDeps } from '../../src/core/chat/claudeLocator'
import { createRunEnv, resolveRunPath } from '../../src/core/chat/shellEnv'
import { controlPath } from '../../src/control'
import { isPipePath, pipeName, usesPipes } from '../../src/core/ipc/ipcEndpoint'
import { defaultBash } from '../../src/core/procKill'

// Windows behaviour, checked on any host: each helper takes the platform (or reads Windows-shaped input) explicitly.

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'
].join('\r\n')

const win = (exec: string[], files: Record<string, string> = {}, o: Partial<LocateDeps> = {}): LocateDeps => ({
  override: null,
  pathEnv: 'C:\\Windows\\system32;C:\\Users\\u\\AppData\\Roaming\\npm',
  home: 'C:\\Users\\u',
  platform: 'win32',
  isExecutable: async (p) => exec.includes(p),
  loginShellWhich: async () => {
    throw new Error('no login shell on Windows')
  },
  readShim: async (p) => files[p] ?? null,
  ...o
})

describe('locating claude on Windows', () => {
  const npmExe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'

  test('splits PATH on ; and resolves an npm .cmd shim to the exe it runs', async () => {
    const d = win([npmExe], { 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd': NPM_SHIM })
    expect(await locateClaude(d)).toBe(npmExe)
  })

  test('prefers claude.exe in a PATH folder over a later shim', async () => {
    const d = win(['C:\\Windows\\system32\\claude.exe', npmExe], { 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd': NPM_SHIM })
    expect(await locateClaude(d)).toBe('C:\\Windows\\system32\\claude.exe')
  })

  test('finds the native installer in ~\\.local\\bin', async () => {
    expect(await locateClaude(win(['C:\\Users\\u\\.local\\bin\\claude.exe']))).toBe('C:\\Users\\u\\.local\\bin\\claude.exe')
  })

  test('an override naming a .cmd shim becomes its exe', async () => {
    const shim = 'D:\\tools\\claude.cmd'
    const d = win(['D:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'], { [shim]: NPM_SHIM }, { override: shim })
    expect(await locateClaude(d)).toBe('D:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  })

  test('never asks a login shell, and a relative PATH entry is skipped', async () => {
    const d = win(['bin\\claude.exe'], {}, { pathEnv: 'bin;' })
    expect(await locateClaude(d)).toBeNull()
  })

  test('a shim that runs a script through node has no exe to spawn', async () => {
    expect(
      await shimTarget('C:\\n\\codex.cmd', async () => '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')
    ).toBeNull()
  })
})

describe('environment on Windows', () => {
  test('pathOf reads PATH whatever its case', () => {
    expect(pathOf({ Path: 'C:\\a;C:\\b' })).toBe('C:\\a;C:\\b')
    expect(pathOf({ PATH: '/x' })).toBe('/x')
    expect(pathOf({})).toBe('')
  })

  test('a run env folds Path into one PATH key', () => {
    const env = createRunEnv({ base: { Path: 'C:\\a', HOME: 'h' }, platform: 'win32' }).env()
    expect(env.PATH).toBe('C:\\a')
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH'])
  })

  test('never asks bash for a PATH (it would be WSL or Git Bash paths)', async () => {
    let asked = false
    const out = await resolveRunPath({
      capture: async () => {
        asked = true
        return '__CB__/usr/bin'
      },
      fallback: 'C:\\a',
      platform: 'win32'
    })
    expect(out).toBe('C:\\a')
    expect(asked).toBe(false)
  })
})

describe('IPC on Windows', () => {
  test('pipe names are fresh and recognised', () => {
    const a = pipeName('t')
    expect(a).toMatch(/^\\\\\.\\pipe\\zumibot-t-[0-9a-f]{24}$/)
    expect(pipeName('t')).not.toBe(a)
    expect(isPipePath(a)).toBe(true)
    expect(isPipePath('/tmp/cb-t-x/s')).toBe(false)
    expect(usesPipes('win32')).toBe(true)
    expect(usesPipes('linux')).toBe(false)
  })

  test('the control pipe is named from the data dir, ignoring letter case', () => {
    const a = controlPath('C:\\Users\\u\\zumi', 'win32')
    expect(a).toMatch(/^\\\\\.\\pipe\\zumibot-control-[0-9a-f]{24}$/)
    expect(controlPath('C:\\Users\\u\\zumi', 'win32')).toBe(a)
    expect(controlPath('C:\\Users\\u\\other', 'win32')).not.toBe(a)
    expect(controlPath('/data', 'linux')).toMatch(/control\.sock$/)
  })
})

test('background processes use bash on Linux, Git Bash when Windows names one', () => {
  expect(defaultBash({}, 'linux')).toBe('/bin/bash')
  expect(defaultBash({ CLAUDE_CODE_GIT_BASH_PATH: process.execPath }, 'win32')).toBe(process.execPath)
})

test('attachment names become ones NTFS can hold, on Windows only', async () => {
  const { storableName } = await import('../../src/core/attachments/attachmentStore')
  expect(storableName('a:b*c?.png', 'win32')).toBe('a_b_c_.png')
  expect(storableName('notes. ', 'win32')).toBe('notes')
  expect(storableName('CON.txt', 'win32')).toBe('_CON.txt')
  expect(storableName('a:b*c?.png', 'linux')).toBe('a:b*c?.png')
})

// The vault guard hook, run as Claude Code runs it on Windows: in Git Bash, over the call's JSON on stdin.
test.runIf(process.platform === 'win32')('the vault guard blocks a Bash call naming the key folder, in any Windows spelling', async () => {
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { vaultGuardCommand } = await import('../../src/core/vault/vaultGuard')
  const home = join(tmpdir(), 'zb-home')
  const keyFile = join(home, '.config', 'zumibot-vault', 'vault.key')
  const cmd = vaultGuardCommand({ keyFile, vaultFile: join(home, 'data', 'vault.json'), home })
  const run = (command: string): number => {
    try {
      execFileSync(defaultBash(), ['-c', cmd], { input: JSON.stringify({ tool_input: { command } }), stdio: ['pipe', 'ignore', 'ignore'] })
      return 0
    } catch (e) {
      return (e as { status: number }).status
    }
  }
  const dir = join(home, '.config', 'zumibot-vault')
  expect(run(`type ${dir}\\vault.key`)).toBe(2)
  expect(run(`cat ${dir.replace(/\\/g, '/')}/vault.key`)).toBe(2)
  expect(run(`cat /${dir[0]!.toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}/vault.key`)).toBe(2)
  expect(run(`cat ${dir.toUpperCase()}\\VAULT.KEY`)).toBe(2)
  expect(run('cat ~/.config/zumibot-vault/vault.key')).toBe(2)
  expect(run('ls C:\\Windows')).toBe(0)
})
