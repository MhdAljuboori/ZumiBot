import { describe, expect, it } from 'vitest'
import {
  PROCESS_COMMAND_MAX,
  PROCESS_REFUSALS,
  cleanOutput,
  commandError,
  cutLines,
  deriveName,
  isProcessId,
  isProcessName,
  lineMatches,
  spanText,
  stateText,
  tailLines
} from '../src/processes'

describe('processes', () => {
  it('checks ids and names', () => {
    expect(isProcessId('p_012345678')).toBe(false)
    expect(isProcessId('p_0123456789abcdef'.slice(0, 12))).toBe(true)
    expect(isProcessId('p_ABCDEF0123')).toBe(false)
    expect(isProcessName('dev server')).toBe(true)
    expect(isProcessName('web.api_2-x')).toBe(true)
    expect(isProcessName(' dev')).toBe(false)
    expect(isProcessName('dev ')).toBe(false)
    expect(isProcessName('-dev')).toBe(false)
    expect(isProcessName('a/b')).toBe(false)
    expect(isProcessName('x'.repeat(41))).toBe(false)
  })

  it('refuses empty, long and NUL commands', () => {
    expect(commandError('npm run dev')).toBeNull()
    expect(commandError('  ')).toBe(PROCESS_REFUSALS.command)
    expect(commandError('a'.repeat(PROCESS_COMMAND_MAX + 1))).toBe(PROCESS_REFUSALS.command)
    expect(commandError('echo \0')).toBe(PROCESS_REFUSALS.command)
  })

  it('derives a name from the command', () => {
    expect(deriveName('npm run dev', new Set())).toBe('npm dev')
    expect(deriveName('PORT=3000 ./node_modules/.bin/vite --host', new Set())).toBe('vite')
    expect(deriveName('pytest -x', new Set())).toBe('pytest')
    expect(deriveName('npm run dev', new Set(['npm dev', 'npm dev-2']))).toBe('npm dev-3')
    expect(deriveName('!!!', new Set())).toBe('process')
    expect(isProcessName(deriveName('x'.repeat(100), new Set(['x'.repeat(37)])))).toBe(true)
  })

  it('cleans escapes and carriage returns', () => {
    expect(cleanOutput('\u001b[32mready\u001b[0m\r\n')).toBe('ready\n')
    expect(cleanOutput('10%\r20%\r')).toBe('10%\n20%\n')
    expect(cleanOutput('\u001b]0;title\u0007ok')).toBe('ok')
  })

  it('cuts lines and takes tails', () => {
    expect(cutLines('abcdef\nx', 3)).toBe('abc…\nx')
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tailLines('', 2)).toBe('')
  })

  it('matches literal patterns only', () => {
    expect(lineMatches('Local: http://localhost:5173/', ['Local:'])).toBe(true)
    expect(lineMatches('ready in 300 ms', ['(a+)+$'])).toBe(false)
    expect(lineMatches('anything', [''])).toBe(false)
  })

  it('says spans and states in words', () => {
    expect(spanText(5_000)).toBe('5s')
    expect(spanText(125_000)).toBe('2m')
    expect(spanText(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m')
    expect(stateText({ state: 'exited', exitCode: 1, signal: null, stoppedBy: null, note: null })).toBe('exited with code 1')
    expect(stateText({ state: 'stopped', exitCode: null, signal: 'SIGTERM', stoppedBy: 'archive', note: null })).toBe(
      'stopped when the chat was archived'
    )
    expect(stateText({ state: 'failed', exitCode: null, signal: null, stoppedBy: null, note: 'ENOENT' })).toBe('failed to start (ENOENT)')
  })
})

describe('withProcessTools', () => {
  it('adds every process tool once to a tools list, and leaves no list alone', async () => {
    const { PROCESS_TOOLS, withProcessTools } = await import('../src/processes')
    expect(withProcessTools(null)).toBeNull()
    const once = withProcessTools(['Read'])!
    expect(once).toEqual(['Read', ...PROCESS_TOOLS])
    expect(withProcessTools(once)).toEqual(once)
  })
})

describe('processStartOf', () => {
  it("reads a start card's command, folder and name, and nothing else", async () => {
    const { processStartOf } = await import('../src/processes')
    expect(processStartOf('mcp__zumibot_processes__start', { command: 'npm run dev', cwd: 'web', name: 'web' })).toEqual({
      command: 'npm run dev',
      cwd: 'web',
      name: 'web'
    })
    expect(processStartOf('mcp__zumibot_processes__start', { command: 'x', cwd: '.' })).toEqual({ command: 'x', cwd: null, name: null })
    expect(processStartOf('Bash', { command: 'x' })).toBeNull()
    expect(processStartOf('mcp__zumibot_processes__start', { cmd: 'x' })).toBeNull()
  })
})
