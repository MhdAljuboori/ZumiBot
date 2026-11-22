import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { writeFakeBin } from '../support/fakeBin'
import type { BrowserTurn } from '../../src/core/browser/browserIpc'
import { FORK_IGNORED, type SideBase, type SideTurn } from '../../src/core/chat/chatService'
import { buildArgs, type RunHandle, type RunOptions, type RunOutcome } from '../../src/core/chat/claudeRunner'
import { allowResponse, denyResponse, errorResponse, UNKNOWN_REQUEST_ERROR } from '../../src/core/chat/controlProtocol'
import type { ResultEvent, RunEvent } from '../../src/core/chat/streamParser'
import { ASK_SIDE_TOOL, ASK_TOOL } from '@zumibot/shared/agentAsk'
import { SIDE_TIMEOUT_MS, SIDE_TIMEOUT_TEXT } from '@zumibot/shared/btw'
import {
  SIDE_GUARD_ASKING,
  SIDE_GUARD_SETTINGS,
  SIDE_POINT_OTHER_ENGINE,
  sideArgs,
  startSideRun,
  type SideRunOptions
} from '../../src/core/btw/sideRun'
import { DESKTOP_ASK_RULES, type DesktopTurn } from '../../src/core/desktop/desktopIpc'
import { NO_MCP, type McpServerSpec } from '../../src/core/ipc/mcpSpec'
import { runCodex, type CodexRunOptions } from '../../src/core/codex/codexRunner'
import { CODEX_SIDE_DENY_HOOK } from '../../src/core/codex/codexHooks'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import { CODEX_REFUSALS } from '@zumibot/shared/engine'
import { NO_EXTENSIONS } from '@zumibot/shared/extensions'
import { buildAgentRunConfig } from '../../src/core/extensions/agentRunConfig'

const guard =
  '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'
const base: SideBase = {
  bin: '/bin/claude',
  cwd: '/work',
  browser: true,
  asks: false,
  tmpDir: null,
  active: true,
  args: {
    agentName: 'a',
    permissionMode: 'manual',
    disallowedTools: ['Edit(//memory.md)', 'Agent(b)'],
    extraArgs: ['--add-dir', '/files'],
    appendSystemPrompt: 'House style and memory'
  },
  live: { session: 'S', at: 'A' },
  start: { session: 'old', at: 'old-at' }
}
const browser: BrowserTurn = {
  mcp: NO_MCP,
  args: ['--mcp-config', '{"servers":{}}', '--no-chrome'],
  prompt: 'Browser prompt',
  env: { ZUMIBOT_BROWSER_CAPABILITY: 'side-capability' },
  dispose: async () => {}
}
const cost = { totalUsd: 0.1, models: { haiku: { input: 10, output: 5, cacheRead: 30, cacheWrite: 0, costUsd: 0.1 } } }
const result: ResultEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 1,
  sessionId: 'F',
  denials: [],
  windows: {},
  uuid: 'result-id',
  cost
}

function fakeRun(overrides: Partial<SideRunOptions> = {}) {
  let options!: RunOptions
  let finish!: (outcome: RunOutcome) => void
  const handle: RunHandle = {
    stop: vi.fn(),
    send: vi.fn(() => true),
    done: new Promise((resolve) => {
      finish = resolve
    })
  }
  const onText = vi.fn(),
    onCost = vi.fn()
  let now = 100
  const side = startSideRun({
    base,
    point: base.live,
    message: 'Side note and question',
    browser,
    now: () => now,
    onText,
    onCost,
    run: (o) => {
      options = o
      return handle
    },
    ...overrides
  })
  return {
    side,
    options,
    handle,
    onText,
    onCost,
    emit: (e: RunEvent) => options.onEvent(e),
    setTime: (value: number) => {
      now = value
    },
    finish: (o: Partial<RunOutcome> = {}) =>
      finish({ exitCode: 0, signal: null, stderr: '', spawnError: null, result, stopped: false, ...o })
  }
}

afterEach(() => vi.useRealTimers())

test('sideArgs keeps the main args and only swaps the session', () => {
  const main = buildArgs({
    ...base.args,
    resumeSessionId: 'main',
    extraArgs: [...base.args.extraArgs, ...browser.args],
    appendSystemPrompt: 'House style and memory\n\nBrowser prompt'
  })
  const expected = [...main]
  expected.splice(expected.indexOf('--resume'), 2, '--resume', 'S', '--resume-session-at', 'A', '--fork-session')
  expected.splice(expected.indexOf('--disallowedTools'), 0, '--no-session-persistence', '--settings', guard)
  const actual = sideArgs(base, base.live, browser)
  expect(actual).toEqual(expected)
  expect(actual.slice(-3)).toEqual(['--disallowedTools', 'Edit(//memory.md)', 'Agent(b)'])
  expect(SIDE_GUARD_SETTINGS).toBe(guard)
  expect(base.args.extraArgs).toEqual(['--add-dir', '/files'])
})

test('sideArgs with a desktop carries the ask rules in the one guard settings', () => {
  const desktop: DesktopTurn = {
    mcp: NO_MCP,
    args: ['--mcp-config', '{"mcpServers":{"zumibot_desktop":{}}}'],
    prompt: 'Desktop prompt',
    env: { ZUMIBOT_DESKTOP_CAPABILITY: 'side-desktop' },
    dispose: async () => {}
  }
  const actual = sideArgs(base, base.live, browser, desktop)
  expect(actual.filter((a) => a === '--settings')).toHaveLength(1)
  const settings = actual[actual.indexOf('--settings') + 1]
  expect(JSON.parse(settings)).toEqual({ ...JSON.parse(guard), permissions: { ask: [...DESKTOP_ASK_RULES] } })
  expect(DESKTOP_ASK_RULES).toHaveLength(8)
  // The guard's hooks stay byte for byte as the probe pins them.
  expect(settings.startsWith(guard.slice(0, -1))).toBe(true)
  // After the browser's server, and like every --mcp-config value, followed by an option.
  const at = actual.indexOf(desktop.args[1])
  expect(at).toBeGreaterThan(actual.indexOf(browser.args[1]))
  expect(actual[at - 1]).toBe('--mcp-config')
  expect(actual[at + 1].startsWith('--')).toBe(true)
  expect(actual.slice(-3)).toEqual(['--disallowedTools', 'Edit(//memory.md)', 'Agent(b)'])
  expect(actual[actual.indexOf('--append-system-prompt') + 1]).toBe('House style and memory\n\nBrowser prompt\n\nDesktop prompt')
  // An unavailable desktop adds only its prompt: the guard is untouched.
  const unavailable = sideArgs(base, base.live, browser, { ...desktop, args: [], env: {} })
  expect(unavailable[unavailable.indexOf('--settings') + 1]).toBe(guard)
  expect(unavailable[unavailable.indexOf('--append-system-prompt') + 1]).toContain('Desktop prompt')
})

test('sideArgs keeps the old guard unless asking', () => {
  const settingsOf = (args: string[]) => args[args.indexOf('--settings') + 1]
  const plain = sideArgs(base, null, null)
  expect(settingsOf(plain)).toBe(SIDE_GUARD_SETTINGS)
  expect(plain).not.toContain(SIDE_GUARD_ASKING)
  const asking = sideArgs(base, null, null, null, true)
  expect(settingsOf(asking)).toBe(SIDE_GUARD_ASKING)
  expect(asking).not.toContain(SIDE_GUARD_SETTINGS)
  const desktop: DesktopTurn = {
    mcp: NO_MCP,
    args: ['--mcp-config', '{"mcpServers":{"zumibot_desktop":{}}}'],
    prompt: 'Desktop prompt',
    env: {},
    dispose: async () => {}
  }
  const both = sideArgs(base, null, null, desktop, true)
  expect(both.filter((a) => a === '--settings')).toHaveLength(1)
  expect(JSON.parse(settingsOf(both))).toEqual({ ...JSON.parse(SIDE_GUARD_ASKING), permissions: { ask: [...DESKTOP_ASK_RULES] } })
})

test('SIDE_GUARD_ASKING matches the probe', async () => {
  // @ts-expect-error the probe is plain .mjs with no types
  expect(SIDE_GUARD_ASKING).toBe((await import('../../../e2e/sideAskProbe.mjs')).SIDE_GUARD_ASKING)
})

test('allows only the side tool when asking', async () => {
  const f = fakeRun({ asking: true })
  const input = { agent: 'b', message: 'hi' }
  const ask = (requestId: string, toolName: string) =>
    f.emit({ kind: 'permissionRequest', requestId, toolName, input, description: null, reason: null, toolUseId: 'tool' })
  ask('side', ASK_SIDE_TOOL)
  ask('ask', ASK_TOOL)
  ask('bash', 'Bash')
  ask('other', 'mcp__other__side_question')
  expect(f.handle.send).toHaveBeenCalledTimes(4)
  expect(f.handle.send).toHaveBeenNthCalledWith(1, allowResponse('side', input))
  for (const [n, id] of [
    [2, 'ask'],
    [3, 'bash'],
    [4, 'other']
  ] as const)
    expect(f.handle.send).toHaveBeenNthCalledWith(n, denyResponse(id, 'No tools in a side answer'))
  expect(f.options.args[f.options.args.indexOf('--settings') + 1]).toBe(SIDE_GUARD_ASKING)
  f.finish()
  await f.side.done
  // Without the exception the side tool is denied like any other.
  const plain = fakeRun()
  plain.emit({
    kind: 'permissionRequest',
    requestId: 'side',
    toolName: ASK_SIDE_TOOL,
    input,
    description: null,
    reason: null,
    toolUseId: 'tool'
  })
  expect(plain.handle.send).toHaveBeenCalledExactlyOnceWith(denyResponse('side', 'No tools in a side answer'))
  plain.finish()
  await plain.side.done
})

test('a side run gets the browser and desktop env together', async () => {
  const desktop: DesktopTurn = {
    mcp: NO_MCP,
    args: ['--mcp-config', 'desktop'],
    prompt: 'Desktop prompt',
    env: { ZUMIBOT_DESKTOP_CAPABILITY: 'side-desktop' },
    dispose: async () => {}
  }
  const f = fakeRun({ desktop })
  expect(f.options.env).toEqual({ ...browser.env, ...desktop.env })
  expect(f.options.args).toEqual(sideArgs(base, base.live, browser, desktop))
  f.finish()
  await f.side.done
})

test('sideArgs with no point has no --resume', () => {
  const actual = sideArgs(base, null, null)
  expect(actual).not.toContain('--resume')
  expect(actual).not.toContain('--resume-session-at')
  expect(actual).not.toContain('--fork-session')
  expect(actual).toContain('--no-session-persistence')
  expect(actual[actual.indexOf('--append-system-prompt') + 1]).toBe('House style and memory')
})

test('starts with the side message, base working directory and fresh browser environment', async () => {
  const f = fakeRun()
  expect(f.options).toMatchObject({ bin: '/bin/claude', cwd: '/work', stdin: 'Side note and question', env: browser.env })
  expect(f.options.args).toEqual(sideArgs(base, base.live, browser))
  f.finish()
  await f.side.done
})

test('denies every permission request', async () => {
  const f = fakeRun()
  for (const [requestId, toolName] of [
    ['req', 'Bash'],
    ['req2', 'mcp__browser__click']
  ]) {
    f.emit({ kind: 'permissionRequest', requestId, toolName, input: {}, description: null, reason: null, toolUseId: 'tool' })
  }
  expect(f.handle.send).toHaveBeenCalledTimes(2)
  expect(f.handle.send).toHaveBeenNthCalledWith(1, denyResponse('req', 'No tools in a side answer'))
  expect(f.handle.send).toHaveBeenNthCalledWith(2, denyResponse('req2', 'No tools in a side answer'))
  expect(f.onText).not.toHaveBeenCalled()
  expect(f.onCost).not.toHaveBeenCalled()
  f.finish()
  await f.side.done
})

test('denies permission requests emitted before the run handle is returned', async () => {
  const send = vi.fn(() => true)
  const f = fakeRun({
    run: (o) => {
      o.onEvent({
        kind: 'permissionRequest',
        requestId: 'early',
        toolName: 'Bash',
        input: {},
        description: null,
        reason: null,
        toolUseId: 'tool'
      })
      return {
        send,
        stop: () => {},
        done: Promise.resolve({ exitCode: 0, signal: null, stderr: '', spawnError: null, result, stopped: false })
      }
    }
  })
  await f.side.done
  expect(send).toHaveBeenCalledExactlyOnceWith(denyResponse('early', 'No tools in a side answer'))
})

test('fork ignored stops with FORK_IGNORED', async () => {
  const f = fakeRun()
  f.emit({ kind: 'init', sessionId: 'S', version: '2.1.317' })
  expect(f.handle.stop).toHaveBeenCalledOnce()
  expect(await f.side.done).toEqual({ ok: false, stopped: false, error: FORK_IGNORED('2.1.317'), answer: '' })
})

test('streams the answer without duplicating completed text', async () => {
  const f = fakeRun()
  f.emit({ kind: 'textDelta', text: '17 ' })
  f.emit({ kind: 'textDelta', text: 'done' })
  expect(f.onText.mock.calls).toEqual([['17 '], ['17 done']])
  f.emit({ kind: 'assistantText', text: '17 done' })
  f.finish()
  expect(await f.side.done).toEqual({ ok: true, stopped: false, error: null, answer: '17 done' })
  expect(f.onText.mock.calls).toEqual([['17 '], ['17 done'], ['17 done']])
})

test('joins completed messages and replaces their partial text with the complete text', async () => {
  const f = fakeRun()
  f.emit({ kind: 'assistantText', text: 'First' })
  f.emit({ kind: 'textDelta', text: 'Sec' })
  f.emit({ kind: 'assistantText', text: 'Second' })
  f.emit({ kind: 'textDelta', text: 'Third' })
  expect(f.onText.mock.calls).toEqual([['First'], ['First\n\nSec'], ['First\n\nSecond'], ['First\n\nSecond\n\nThird']])
  f.finish()
  expect((await f.side.done).answer).toBe('First\n\nSecond\n\nThird')
})

test('cost uses the side init session and the attempt time window', async () => {
  const f = fakeRun()
  f.emit({ kind: 'init', sessionId: 'F' })
  f.setTime(250)
  f.emit({ ...result, sessionId: 'main-session' })
  expect(f.onCost).toHaveBeenCalledExactlyOnceWith({ sessionId: 'F', window: [100, 250], cost, id: 'result-id' })
  f.finish()
  await f.side.done
})

test("a forked side run reports only what it added to the main session's restored cost", async () => {
  const read: string[] = []
  const f = fakeRun({
    costBaseline: async (id) => {
      read.push(id)
      return { haiku: { input: 4, output: 5, cacheRead: 20, cacheWrite: 0, costUsd: 0.04 } }
    }
  })
  expect(read).toEqual(['S'])
  f.emit({ kind: 'init', sessionId: 'F' })
  f.setTime(250)
  f.emit(result)
  f.finish()
  await f.side.done
  await f.side.exited
  await vi.waitFor(() => expect(f.onCost).toHaveBeenCalledTimes(1))
  const reported = f.onCost.mock.calls[0][0]
  expect(reported).toMatchObject({ sessionId: 'F', window: [100, 250], id: 'result-id' })
  expect(reported.cost.models).toEqual({ haiku: { input: 6, output: 0, cacheRead: 10, cacheWrite: 0, costUsd: expect.closeTo(0.06, 10) } })
})

test('a seeded side run reads no baseline', async () => {
  const read: string[] = []
  const f = fakeRun({
    point: null,
    costBaseline: async (id) => {
      read.push(id)
      return null
    }
  })
  f.emit(result)
  expect(read).toEqual([])
  expect(f.onCost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cost }))
  f.finish()
  await f.side.done
})

test('cost without init never falls back to the main or result session', async () => {
  const f = fakeRun()
  f.emit({ ...result, sessionId: 'S', uuid: null })
  expect(f.onCost).toHaveBeenCalledExactlyOnceWith({ sessionId: null, window: [100, 100], cost, id: null })
  f.finish()
  await f.side.done
})

test('times out even when the process never settles', async () => {
  vi.useFakeTimers()
  const f = fakeRun({ timeoutMs: 1000 })
  f.emit({ kind: 'textDelta', text: 'Partial' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await f.side.done).toEqual({ ok: false, stopped: false, error: 'Took too long', answer: 'Partial' })
  expect(f.handle.stop).toHaveBeenCalledOnce()
  f.emit({ kind: 'assistantText', text: 'Late' })
  expect(f.onText).toHaveBeenCalledTimes(1)
})

test('stop preserves the partial answer and is idempotent', async () => {
  const f = fakeRun()
  f.emit({ kind: 'textDelta', text: 'Partial' })
  f.side.stop()
  f.side.stop()
  expect(await f.side.done).toEqual({ ok: false, stopped: true, error: null, answer: 'Partial' })
  expect(f.handle.stop).toHaveBeenCalledOnce()
})

test.each(['stop', 'timeout'])('a result arriving after %s still reports its cost', async (mode) => {
  vi.useFakeTimers()
  const f = fakeRun({ timeoutMs: 1000 })
  f.emit({ kind: 'init', sessionId: 'F' })
  if (mode === 'stop') f.side.stop()
  else await vi.advanceTimersByTimeAsync(1000)
  await f.side.done
  f.setTime(300)
  f.emit(result)
  expect(f.onCost).toHaveBeenCalledExactlyOnceWith({ sessionId: 'F', window: [100, 300], cost, id: 'result-id' })
})

test.each(['stop', 'timeout'])('exited waits for the process after %s', async (mode) => {
  vi.useFakeTimers()
  const f = fakeRun({ timeoutMs: 1000 })
  let exited = false
  void f.side.exited.then(() => {
    exited = true
  })
  if (mode === 'stop') f.side.stop()
  else await vi.advanceTimersByTimeAsync(1000)
  await f.side.done
  await Promise.resolve()
  expect(exited).toBe(false)
  f.finish({ stopped: true, result: null })
  await f.side.exited
  expect(exited).toBe(true)
})

test('exited is settled when the run could not start', async () => {
  const f = fakeRun({
    run: () => {
      throw new Error('spawn failed')
    }
  })
  expect((await f.side.done).error).toBe('spawn failed')
  await f.side.exited
})

test.each([
  [{ result: null, stderr: '  failure details\n', exitCode: 1 }, 'failure details'],
  [{ result: null, exitCode: 7 }, 'Claude exited with code 7'],
  [{ result: { ...result, isError: true }, stderr: '  result failed\n' }, 'result failed'],
  [{ result: null, spawnError: 'Folder not found: /work' }, 'Folder not found: /work']
])('reports failed process outcomes: %j', async (outcome, error) => {
  const f = fakeRun()
  f.finish(outcome)
  expect(await f.side.done).toEqual({ ok: false, stopped: false, error, answer: '' })
})

test('a failed run never stores the browser or desktop capability or IPC path in its error', async () => {
  const privateBrowser: BrowserTurn = {
    ...browser,
    env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-token-1', ZUMIBOT_BROWSER_IPC: '/tmp/cb-b-x/s' }
  }
  const desktop: DesktopTurn = {
    mcp: NO_MCP,
    args: ['--mcp-config', 'desktop'],
    prompt: 'Desktop prompt',
    dispose: async () => {},
    env: {
      ZUMIBOT_DESKTOP_CAPABILITY: 'desktop-token-2',
      ZUMIBOT_DESKTOP_IPC: '/tmp/cb-d-y/s',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'
    }
  }
  const f = fakeRun({ browser: privateBrowser, desktop })
  f.finish({
    result: null,
    exitCode: 1,
    stderr: 'MCP zumibot_desktop failed: token desktop-token-2 at /tmp/cb-d-y/s; browser-token-1 /tmp/cb-b-x/s exit 1\n'
  })
  const { error } = await f.side.done
  expect(error).toBe(
    'MCP zumibot_desktop failed: token [private desktop value] at [private desktop value]; [private browser value] [private browser value] exit 1'
  )
})

test('the to-do and ask capability and IPC path merged into the browser env are redacted like the browser values', async () => {
  const merged: BrowserTurn = {
    ...browser,
    env: {
      ZUMIBOT_BROWSER_CAPABILITY: 'browser-token-1',
      ZUMIBOT_BROWSER_IPC: '/tmp/cb-b-x/s',
      ZUMIBOT_TODOS_CAPABILITY: 'todo-token-3',
      ZUMIBOT_TODOS_IPC: '/tmp/cb-t-x/s',
      ZUMIBOT_ASKS_CAPABILITY: 'ask-token-4',
      ZUMIBOT_ASKS_IPC: '/tmp/cb-a-x/s'
    }
  }
  const f = fakeRun({ browser: merged })
  f.finish({ result: null, exitCode: 1, stderr: 'MCP failed: todo-token-3 /tmp/cb-t-x/s ask-token-4 /tmp/cb-a-x/s browser-token-1\n' })
  const { error } = await f.side.done
  expect(error).toBe(
    'MCP failed: [private browser value] [private browser value] [private browser value] [private browser value] [private browser value]'
  )
})

test("scrubs a side answer with the base agent's keys", async () => {
  const key = 'tok-secret-ABCD1234'
  const f = fakeRun({ base: { ...base, scrub: new Map([[key, '[vault: Azure PAT]']]) } })
  // A value split across two deltas never shows, not even in the live answer.
  f.emit({ kind: 'textDelta', text: 'it is tok-secret-' })
  f.emit({ kind: 'textDelta', text: 'ABCD1234 ok' })
  expect(f.onText.mock.calls.map((c) => c[0]).join('|')).not.toContain('tok-')
  f.emit({ kind: 'assistantText', text: `it is ${key} ok` })
  f.emit({ kind: 'textDelta', text: 'tail' })
  f.finish({ result: null, exitCode: 1, stderr: `boom ${key}\n` })
  const end = await f.side.done
  expect(end.error).toBe('boom [vault: Azure PAT]')
  expect(end.answer).toBe('it is [vault: Azure PAT] ok\n\ntail')
  expect(JSON.stringify([end, f.onText.mock.calls])).not.toContain(key)
})

test('a side answer keeps the held tail of its text when the run ends', async () => {
  const f = fakeRun({ base: { ...base, scrub: new Map([['tok-secret-ABCD1234', '[vault: K]']]) } })
  f.emit({ kind: 'textDelta', text: 'short answer' })
  f.finish()
  expect((await f.side.done).answer).toBe('short answer')
})

test('a spawn failure is redacted too', async () => {
  const desktop: DesktopTurn = {
    mcp: NO_MCP,
    args: [],
    prompt: '',
    dispose: async () => {},
    env: { ZUMIBOT_DESKTOP_IPC: '/tmp/cb-d-z/s' }
  }
  const f = fakeRun({
    desktop,
    run: () => {
      throw new Error('cannot reach /tmp/cb-d-z/s')
    }
  })
  expect((await f.side.done).error).toBe('cannot reach [private desktop value]')
})

test('a limited run reports stderr as chatService does', async () => {
  const f = fakeRun()
  f.emit({ kind: 'limited', resetsAt: 123 })
  f.finish({ result: { ...result, isError: true }, stderr: ' Usage limit reached\n' })
  expect((await f.side.done).error).toBe('Usage limit reached')
})

test('a completed run clears its timeout and cannot later be stopped', async () => {
  vi.useFakeTimers()
  const f = fakeRun({ timeoutMs: 1000 })
  f.finish()
  await f.side.done
  await vi.advanceTimersByTimeAsync(1000)
  f.side.stop()
  expect(f.handle.stop).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('with expired, an abort ends as a timeout and stops the process; there is no timer of its own', async () => {
  vi.useFakeTimers()
  const expired = new AbortController()
  const f = fakeRun({ expired: expired.signal })
  f.emit({ kind: 'textDelta', text: 'Partial' })
  expect(vi.getTimerCount()).toBe(0)
  let settled = false
  void f.side.done.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(SIDE_TIMEOUT_MS * 3)
  expect(settled).toBe(false)
  expect(f.handle.stop).not.toHaveBeenCalled()
  expired.abort()
  expect(await f.side.done).toEqual({ ok: false, stopped: false, error: SIDE_TIMEOUT_TEXT, answer: 'Partial' })
  expect(f.handle.stop).toHaveBeenCalledOnce()
})

test('an expired signal that is already aborted ends at once', async () => {
  const f = fakeRun({ expired: AbortSignal.abort() })
  expect(await f.side.done).toEqual({ ok: false, stopped: false, error: SIDE_TIMEOUT_TEXT, answer: '' })
  expect(f.handle.stop).toHaveBeenCalledOnce()
})

test('an abort after the run ended changes nothing', async () => {
  const expired = new AbortController()
  const f = fakeRun({ expired: expired.signal })
  f.finish()
  expect((await f.side.done).ok).toBe(true)
  expired.abort()
  expect(f.handle.stop).not.toHaveBeenCalled()
})

test("a side run gets its main run's CLAUDE_CODE_TMPDIR even with no browser or desktop, and no key when there is none", () => {
  const f = fakeRun({ base: { ...base, tmpDir: '/x' }, browser: undefined })
  expect(f.options.env).toEqual({ CLAUDE_CODE_TMPDIR: '/x' })
  const g = fakeRun({ base: { ...base, tmpDir: '/x' } })
  expect(g.options.env).toEqual({ ...browser.env, CLAUDE_CODE_TMPDIR: '/x' })
  const none = fakeRun({ browser: undefined })
  expect(none.options.env).toBeUndefined()
  expect(fakeRun().options.env).toEqual(browser.env)
  expect('CLAUDE_CODE_TMPDIR' in (fakeRun().options.env ?? {})).toBe(false)
})

test("a side run spawns with its base's env (the agent's own servers' values) beside the bridges' and the temp folder", () => {
  const env = { ZUMIBOT_MCP_VAULT_0: 'db-secret-value' }
  const f = fakeRun({ base: { ...base, env, tmpDir: '/x' } })
  expect(f.options.env).toEqual({ ...env, ...browser.env, CLAUDE_CODE_TMPDIR: '/x' })
  expect(f.options.args.join('\n')).not.toContain('db-secret-value')
  // Alone it still makes an env; an empty one is as before.
  expect(fakeRun({ base: { ...base, env }, browser: undefined }).options.env).toEqual(env)
  expect(fakeRun({ base: { ...base, env: {} }, browser: undefined }).options.env).toBeUndefined()
})

test("sideArgs keeps the agent's own args before the bridges' and merges its settings with the guard", () => {
  const cfg = buildAgentRunConfig(
    {
      ...NO_EXTENSIONS,
      serversOff: ['claude.ai Gmail'],
      skillsOff: ['apple-design'],
      servers: [{ name: 'db', def: { command: 'db-mcp' } }]
    },
    []
  )
  // As agentTurn and baseFor store them: right after the turn's own args.
  const b: SideBase = {
    ...base,
    args: {
      ...base.args,
      disallowedTools: [...base.args.disallowedTools, ...cfg.disallowedTools],
      extraArgs: [...base.args.extraArgs, ...cfg.extraArgs]
    }
  }
  const actual = sideArgs(b, base.live, browser)
  const own = cfg.extraArgs[cfg.extraArgs.indexOf('--mcp-config') + 1]
  expect(actual[actual.indexOf(own) - 1]).toBe('--mcp-config')
  expect(actual.indexOf(own)).toBeLessThan(actual.indexOf(browser.args[1]))
  expect(actual.filter((a) => a === '--settings')).toHaveLength(1)
  expect(JSON.parse(actual[actual.indexOf('--settings') + 1])).toEqual({
    deniedMcpServers: [{ serverName: 'claude.ai Gmail' }],
    skillOverrides: { 'apple-design': 'off' },
    ...JSON.parse(guard)
  })
  expect(actual.slice(-4)).toEqual(['--disallowedTools', 'Edit(//memory.md)', 'Agent(b)', 'mcp__claude_ai_Gmail'])
})

describe('a Codex side run', () => {
  const spec = (name: string): McpServerSpec => ({ name, command: '/node', args: [`/${name}.mjs`], passEnv: [], fixedEnv: {} })
  const codexBase: SideBase = {
    bin: '/bin/codex',
    cwd: '/work',
    browser: true,
    asks: true,
    tmpDir: null,
    active: true,
    live: null,
    start: null,
    args: { agentName: 'cx', permissionMode: 'auto', disallowedTools: [], extraArgs: [], appendSystemPrompt: 'Main system' },
    codex: { threadId: 'T', at: 'turn-2', baseInstructions: 'Codex body\n\nMain system', model: 'gpt-6-sol' }
  }
  // The merged side turn sideBrowser makes: each bridge turn's own spec, an unavailable one (NO_MCP) among them.
  const sideTurn: SideTurn = {
    ...browser,
    mcp: NO_MCP,
    servers: [spec('zumibot_browser'), NO_MCP, spec('zumibot_todos'), spec('zumibot_agents')]
  }
  const point = { session: 'T', at: 'turn-2', engine: 'codex' as const }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  function fakeCodex(overrides: Partial<SideRunOptions> = {}) {
    let options!: CodexRunOptions
    let finish!: (outcome: RunOutcome) => void
    const handle: RunHandle = {
      stop: vi.fn(),
      send: vi.fn(() => true),
      done: new Promise((resolve) => {
        finish = resolve
      })
    }
    const onText = vi.fn(),
      onCost = vi.fn(),
      run = vi.fn()
    let now = 100
    const side = startSideRun({
      base: codexBase,
      point,
      message: 'Side note and question',
      browser: sideTurn,
      now: () => now,
      onText,
      onCost,
      run,
      codexRun: (o) => {
        options = o
        return handle
      },
      ...overrides
    })
    return {
      side,
      options,
      handle,
      onText,
      onCost,
      run,
      emit: (e: RunEvent) => options.onEvent(e),
      setTime: (value: number) => {
        now = value
      },
      finish: (o: Partial<RunOutcome> = {}) =>
        finish({ exitCode: 0, signal: null, stderr: '', spawnError: null, result, stopped: false, ...o })
    }
  }

  test('forks the last completed turn ephemerally, read-only and asking first, on its own bridges', async () => {
    const f = fakeCodex()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.options).toMatchObject({
      bin: '/bin/codex',
      cwd: '/work',
      env: browser.env,
      start: { kind: 'fork', threadId: 'T', lastTurnId: 'turn-2', ephemeral: true },
      action: { kind: 'turn', prompt: 'Side note and question' }
    })
    // The main thread's instructions, then the side turn's browser prompt, as a Claude side run appends it.
    expect(f.options.thread).toEqual({
      cwd: '/work',
      model: 'gpt-6-sol',
      permissionMode: 'manual',
      sandbox: 'read-only',
      baseInstructions: 'Codex body\n\nMain system\n\nBrowser prompt',
      mcpServers: [spec('zumibot_browser'), spec('zumibot_todos'), spec('zumibot_agents')],
      // The deny-all hook alone (R20): no vault or pause hook, since a side run has no keys and is never paused.
      hooks: [CODEX_SIDE_DENY_HOOK]
    })
    // Trust is asked from the cache first, by a pre-flight that gets none of the run's own env.
    expect(f.options.hookTrustEnv).toEqual({})
    expect(f.options.freshHookTrust).toBeUndefined()
    expect(f.options.requestTag).toMatch(UUID)
    expect(fakeCodex().options.requestTag).not.toBe(f.options.requestTag)
    f.finish()
    expect((await f.side.done).ok).toBe(true)
  })

  test('with no point it starts a new thread on the message, which the caller seeded', async () => {
    const f = fakeCodex({ point: null, browser: null })
    expect(f.options.start).toEqual({ kind: 'new' })
    expect(f.options.action).toEqual({ kind: 'turn', prompt: 'Side note and question' })
    expect(f.options.thread.mcpServers).toEqual([])
    expect(f.options.thread.baseInstructions).toBe('Codex body\n\nMain system')
    expect(f.options.thread.hooks).toEqual([CODEX_SIDE_DENY_HOOK])
    expect(f.options.env).toBeUndefined()
    f.finish()
    await f.side.done
  })

  test('declines every request at once, the side tool and a question too, even when asking', async () => {
    const f = fakeCodex({ asking: true })
    const ask = (requestId: string, toolName: string) =>
      f.emit({ kind: 'permissionRequest', requestId, toolName, input: { agent: 'b' }, description: null, reason: null, toolUseId: 'tool' })
    ask('tag:0', 'Bash')
    ask('tag:1', ASK_SIDE_TOOL)
    ask('tag:2', 'mcp__zumibot_browser__browser_click')
    ask('tag:3', QUESTION_TOOL)
    expect(f.handle.send).toHaveBeenCalledTimes(4)
    for (const [n, id] of [
      [1, 'tag:0'],
      [2, 'tag:1'],
      [3, 'tag:2'],
      [4, 'tag:3']
    ] as const)
      expect(f.handle.send).toHaveBeenNthCalledWith(n, denyResponse(id, 'No tools in a side answer'))
    f.finish()
    await f.side.done
  })

  test("the answer is the turn's text, and its cost is the turn's own (no baseline)", async () => {
    const read: string[] = []
    const f = fakeCodex({
      costBaseline: async (id) => {
        read.push(id)
        return null
      }
    })
    f.emit({ kind: 'init', sessionId: 'F' })
    f.emit({ kind: 'textDelta', text: 'Fif' })
    f.emit({ kind: 'assistantText', text: 'Fifty' })
    f.setTime(250)
    f.emit(result)
    f.finish()
    expect(await f.side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Fifty' })
    expect(f.onText.mock.calls).toEqual([['Fif'], ['Fifty']])
    expect(read).toEqual([])
    expect(f.onCost).toHaveBeenCalledExactlyOnceWith({ sessionId: 'F', window: [100, 250], cost, id: 'result-id' })
  })

  test('a fork that reports the source thread is stopped, with the Codex wording', async () => {
    const f = fakeCodex()
    f.emit({ kind: 'init', sessionId: 'T', version: '0.164.0' })
    expect(f.handle.stop).toHaveBeenCalledOnce()
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error: CODEX_REFUSALS.forkIgnored('0.164.0'), answer: '' })
    expect(CODEX_REFUSALS.forkIgnored('0.164.0')).not.toBe(FORK_IGNORED('0.164.0'))
  })

  test('a missing thread ends as missing, so the caller can seed', async () => {
    const f = fakeCodex()
    f.finish({ result: null, missingSession: true })
    expect(await f.side.done).toEqual({ ok: false, stopped: false, missing: true, error: CODEX_REFUSALS.threadGone, answer: '' })
  })

  test('a request it cannot map is answered at once as unknown, not left open until the deadline', async () => {
    const f = fakeCodex()
    f.emit({ kind: 'controlUnknown', requestId: 'tag:5', subtype: 'item/somethingNew' })
    f.emit({ kind: 'controlUnknown', requestId: null, subtype: 'odd' })
    expect(f.handle.send).toHaveBeenCalledExactlyOnceWith(errorResponse('tag:5', UNKNOWN_REQUEST_ERROR))
    f.finish()
    await f.side.done
  })

  test('the question feature follows its cap: off only when the caller says so', async () => {
    const on = fakeCodex()
    expect(on.options.questions).toBeUndefined()
    on.finish()
    await on.side.done
    const off = fakeCodex({ questions: false })
    expect(off.options.questions).toBe(false)
    off.finish()
    await off.side.done
  })

  test.each([
    [{ result: null, stderr: '  codex said no\n', exitCode: 1 }, 'codex said no'],
    [{ result: null, exitCode: 7 }, 'Codex exited with code 7'],
    [{ result: null, spawnError: 'Folder not found: /work' }, 'Folder not found: /work']
  ])('reports a failed Codex outcome: %j', async (outcome, error) => {
    const f = fakeCodex()
    f.finish(outcome)
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error, answer: '' })
  })

  test('stop stops the Codex process and keeps the partial answer', async () => {
    const f = fakeCodex()
    f.emit({ kind: 'textDelta', text: 'Partial' })
    f.side.stop()
    expect(await f.side.done).toEqual({ ok: false, stopped: true, error: null, answer: 'Partial' })
    expect(f.handle.stop).toHaveBeenCalledOnce()
  })

  test('a deadline that passes stops the Codex process as a timeout', async () => {
    const expired = new AbortController()
    const f = fakeCodex({ expired: expired.signal })
    f.emit({ kind: 'textDelta', text: 'Partial' })
    expired.abort()
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error: SIDE_TIMEOUT_TEXT, answer: 'Partial' })
    expect(f.handle.stop).toHaveBeenCalledOnce()
  })

  test('against the fake codex, a request of a kind it does not know is answered at once and the answer still lands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-side-codex-'))
    try {
      const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
      const bin = writeFakeBin(root, 'codex', fake)
      mkdirSync(join(root, 'home'))
      const script = join(root, 'script.jsonl'),
        answers = join(root, 'answers.jsonl')
      writeFileSync(
        script,
        [
          { request: { method: 'item/somethingNew/request', params: { threadId: '$THREAD', turnId: '$TURN' } } },
          {
            notify: {
              method: 'item/completed',
              params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'Answered' } }
            }
          }
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n'
      )
      const env = { ...process.env, FAKE_CODEX_HOME: join(root, 'home'), FAKE_CODEX_SCRIPT: script, FAKE_CODEX_ANSWERS: answers }
      // Short of the 3-minute deadline, so an answer left open fails here as a timeout.
      const side = startSideRun({
        base: { ...codexBase, bin, cwd: root },
        point: null,
        message: 'Why?',
        browser: null,
        now: () => Date.now(),
        onText: () => {},
        onCost: () => {},
        run: () => {
          throw new Error('no Claude run')
        },
        timeoutMs: 5000,
        codexRun: (o) => runCodex({ ...o, env })
      })
      expect(await side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Answered' })
      await side.exited
      const got = readFileSync(answers, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      expect(got).toEqual([{ id: 0, error: { code: -32601, message: UNKNOWN_REQUEST_ERROR } }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('a point of the other engine is never forked: nothing runs, and the end says missing, so the caller seeds instead', async () => {
    // A Codex base with a Claude point: no Claude session id may reach codex.
    const run = vi.fn(),
      codexRun = vi.fn(),
      costBaseline = vi.fn(async () => null)
    const claudePoint = startSideRun({
      base: codexBase,
      point: { session: 'S', at: 'A' },
      message: 'q',
      browser: null,
      now: () => 1,
      onText: () => {},
      onCost: () => {},
      run,
      codexRun,
      costBaseline
    })
    expect(await claudePoint.done).toEqual({ ok: false, stopped: false, error: SIDE_POINT_OTHER_ENGINE, answer: '', missing: true })
    // The reverse: a Claude base with a Codex point: no thread id reaches claude --resume, nor its cost log.
    const codexPoint = startSideRun({
      base,
      point,
      message: 'q',
      browser: null,
      now: () => 1,
      onText: () => {},
      onCost: () => {},
      run,
      codexRun,
      costBaseline
    })
    expect(await codexPoint.done).toEqual({ ok: false, stopped: false, error: SIDE_POINT_OTHER_ENGINE, answer: '', missing: true })
    expect(run).not.toHaveBeenCalled()
    expect(codexRun).not.toHaveBeenCalled()
    expect(costBaseline).not.toHaveBeenCalled()
    await codexPoint.exited
    // A point of the base's own engine, or none, runs as before.
    expect(fakeCodex().options.start).toEqual({ kind: 'fork', threadId: 'T', lastTurnId: 'turn-2', ephemeral: true })
    expect(fakeCodex({ point: null }).options.start).toEqual({ kind: 'new' })
  })

  // Each call of `codexRun` is one process: the n-th handle, finished by `finish(n, ...)`.
  function fakeCodexRuns(overrides: Partial<SideRunOptions> = {}) {
    const calls: CodexRunOptions[] = []
    const handles: RunHandle[] = []
    const finishers: ((o: RunOutcome) => void)[] = []
    const side = startSideRun({
      base: codexBase,
      point,
      message: 'Side note and question',
      browser: sideTurn,
      now: () => 100,
      onText: vi.fn(),
      onCost: vi.fn(),
      run: vi.fn(),
      codexRun: (o) => {
        calls.push(o)
        const h: RunHandle = {
          stop: vi.fn(),
          send: vi.fn(() => true),
          done: new Promise((resolve) => {
            finishers.push(resolve)
          })
        }
        handles.push(h)
        return h
      },
      ...overrides
    })
    const outcome = (o: Partial<RunOutcome>): RunOutcome => ({
      exitCode: 0,
      signal: null,
      stderr: '',
      spawnError: null,
      result,
      stopped: false,
      ...o
    })
    return {
      side,
      calls,
      handles,
      finish: (n: number, o: Partial<RunOutcome> = {}) => finishers[n](outcome(o)),
      untrusted: (n: number) => finishers[n](outcome({ result: null, hooksUntrusted: true }))
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const shape = (o: CodexRunOptions) => ({
    hooks: o.thread.hooks ?? null,
    fresh: o.freshHookTrust ?? false,
    trustEnv: o.hookTrustEnv ?? null
  })

  test('hooks codex does not trust: once more with trust asked afresh, then without the hook, logged by code only', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      lines.push(a.join(' '))
    })
    try {
      const f = fakeCodexRuns()
      expect(f.calls.map(shape)).toEqual([{ hooks: [CODEX_SIDE_DENY_HOOK], fresh: false, trustEnv: {} }])
      f.untrusted(0)
      await tick()
      expect(f.calls.map(shape)).toEqual([
        { hooks: [CODEX_SIDE_DENY_HOOK], fresh: false, trustEnv: {} },
        { hooks: [CODEX_SIDE_DENY_HOOK], fresh: true, trustEnv: {} }
      ])
      f.untrusted(1)
      await tick()
      // Decline-all is the guarantee then, as before the hook: no hooks, no pre-flight env, same everything else.
      expect(f.calls).toHaveLength(3)
      expect(shape(f.calls[2])).toEqual({ hooks: null, fresh: false, trustEnv: null })
      expect('hooks' in f.calls[2].thread).toBe(false)
      expect(f.calls[2]).toMatchObject({ env: browser.env, start: f.calls[0].start, action: f.calls[0].action })
      expect({ ...f.calls[2].thread, hooks: undefined }).toEqual({ ...f.calls[0].thread, hooks: undefined })
      expect(new Set(f.calls.map((c) => c.requestTag)).size).toBe(3)
      expect(lines.filter((l) => /codex side hook not confirmed/i.test(l))).toHaveLength(1)
      expect(lines.join('\n')).not.toContain('Side note')
      // The third run answers (a text and a result), and its end is the side run's.
      f.calls[2].onEvent({ kind: 'assistantText', text: 'Fifty' })
      f.finish(2)
      expect(await f.side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Fifty' })
      await f.side.exited
    } finally {
      spy.mockRestore()
    }
  })

  test('a second try that codex trusts runs there: no third process', async () => {
    const f = fakeCodexRuns()
    f.untrusted(0)
    await tick()
    f.finish(1)
    expect((await f.side.done).ok).toBe(true)
    expect(f.calls).toHaveLength(2)
  })

  test('a Stop during the hook pre-flight ends the side run as stopped, with nothing run after it', async () => {
    const f = fakeCodexRuns()
    f.side.stop()
    expect(f.handles[0].stop).toHaveBeenCalledOnce()
    // The runner ends a stopped pre-flight with `stopped`, never `hooksUntrusted`.
    f.finish(0, { result: null, stopped: true })
    expect(await f.side.done).toEqual({ ok: false, stopped: true, error: null, answer: '' })
    await tick()
    expect(f.calls).toHaveLength(1)
    await f.side.exited
  })

  test('a Stop that lands as an untrusted run ends starts no rerun', async () => {
    const f = fakeCodexRuns()
    f.untrusted(0)
    f.side.stop()
    await tick()
    expect(await f.side.done).toEqual({ ok: false, stopped: true, error: null, answer: '' })
    expect(f.calls).toHaveLength(1)
  })

  test('a Stop during a rerun stops that process', async () => {
    const f = fakeCodexRuns()
    f.untrusted(0)
    await tick()
    f.side.stop()
    expect(f.handles[1].stop).toHaveBeenCalledOnce()
    f.finish(1, { result: null, stopped: true })
    expect(await f.side.done).toEqual({ ok: false, stopped: true, error: null, answer: '' })
    expect(f.calls).toHaveLength(2)
  })

  test('the deadline spans the reruns: it stops the process then running, and nothing starts after it', async () => {
    const expired = new AbortController()
    const f = fakeCodexRuns({ expired: expired.signal })
    f.untrusted(0)
    await tick()
    expect(f.calls).toHaveLength(2)
    expired.abort()
    expect(f.handles[1].stop).toHaveBeenCalledOnce()
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error: SIDE_TIMEOUT_TEXT, answer: '' })
    // Even a late untrusted end of that process starts nothing.
    f.untrusted(1)
    await tick()
    expect(f.calls).toHaveLength(2)
  })

  test("a deadline that passes during the pre-flight is the side run's timeout, with no rerun", async () => {
    const expired = new AbortController()
    const f = fakeCodexRuns({ expired: expired.signal })
    expired.abort()
    f.untrusted(0)
    await tick()
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error: SIDE_TIMEOUT_TEXT, answer: '' })
    expect(f.calls).toHaveLength(1)
  })

  test('exited waits for the last process of the reruns', async () => {
    const f = fakeCodexRuns()
    let exited = false
    void f.side.exited.then(() => {
      exited = true
    })
    f.untrusted(0)
    await tick()
    expect(exited).toBe(false)
    f.finish(1)
    await f.side.exited
    expect(exited).toBe(true)
  })

  test('a request while the guard runs is still declined at once with no card, in a rerun too', async () => {
    const f = fakeCodexRuns()
    f.untrusted(0)
    await tick()
    f.calls[1].onEvent({
      kind: 'permissionRequest',
      requestId: 'tag:0',
      toolName: 'Bash',
      input: { command: 'ls' },
      description: null,
      reason: null,
      toolUseId: 't'
    })
    expect(f.handles[1].send).toHaveBeenCalledExactlyOnceWith(denyResponse('tag:0', 'No tools in a side answer'))
    expect(f.handles[0].send).not.toHaveBeenCalled()
    f.finish(1)
    await f.side.done
  })

  describe('against the fake codex', () => {
    const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
    let root = ''
    function setup(steps: object[], extra: Record<string, string> = {}) {
      root = mkdtempSync(join(tmpdir(), 'cb-side-hook-'))
      const bin = writeFakeBin(root, 'codex', fake)
      mkdirSync(join(root, 'home'))
      const script = join(root, 'script.jsonl'),
        answers = join(root, 'answers.jsonl'),
        hooksOut = join(root, 'hooks.jsonl')
      writeFileSync(script, steps.map((x) => JSON.stringify(x)).join('\n') + '\n')
      const env = {
        ...process.env,
        FAKE_CODEX_HOME: join(root, 'home'),
        FAKE_CODEX_SCRIPT: script,
        FAKE_CODEX_ANSWERS: answers,
        FAKE_CODEX_HOOKS_OUT: hooksOut,
        ...extra
      }
      const rows: RunEvent[] = []
      const side = startSideRun({
        base: { ...codexBase, bin, cwd: root },
        point: null,
        message: 'Why?',
        browser: null,
        now: () => Date.now(),
        onText: () => {},
        onCost: () => {},
        run: () => {
          throw new Error('no Claude run')
        },
        timeoutMs: 8000,
        codexRun: (o) =>
          runCodex({
            ...o,
            env,
            onEvent: (e) => {
              rows.push(e)
              o.onEvent(e)
            }
          })
      })
      const read = (f: string) => {
        try {
          return readFileSync(f, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        } catch {
          return []
        }
      }
      return { side, rows, answers: () => read(answers), hooksOut: () => read(hooksOut) }
    }
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })
    const msg = (text: string) => ({
      notify: { method: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text } } }
    })

    test('the deny hook blocks an auto-run read in a side answer: no item runs, and the answer still lands', async () => {
      // An exec step is a call codex runs with no approval request (the auto-run read of probe check 11).
      const h = setup([{ exec: { command: 'cat secret.txt', output: 'TOPSECRET\n', id: 'cat-1' } }, msg('Answered')])
      expect(await h.side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Answered' })
      await h.side.exited
      expect(h.hooksOut()).toEqual([{ id: 'cat-1', tool: 'Bash', agentId: null, blocked: true }])
      // Its row is the Blocked one with the hook's text, and the command never ran as an item.
      expect(h.rows).toContainEqual({ kind: 'toolResult', toolUseId: 'cat-1', content: 'No tools in a side answer', isError: true })
      expect(h.rows.filter((e) => e.kind === 'toolUse').map((e) => (e as { name: string }).name)).toEqual(['Blocked'])
      expect(JSON.stringify(h.rows)).not.toContain('TOPSECRET')
    }, 20_000)

    test('an approval request is still declined, with no card', async () => {
      const ask = {
        request: {
          method: 'item/commandExecution/requestApproval',
          params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'e-ls', command: 'ls', cwd: '/w', reason: null }
        }
      }
      const h = setup([ask, msg('Answered')])
      expect(await h.side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Answered' })
      await h.side.exited
      expect(h.answers()).toEqual([{ id: 0, result: { decision: 'decline' } }])
    }, 20_000)

    test('a codex that never trusts the hook runs the side answer without it, decline-all still in force', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // hooks/list lists nothing: each pre-flight comes back untrusted, so the third try goes without the hook.
        const ask = {
          request: {
            method: 'item/commandExecution/requestApproval',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'e-ls', command: 'ls', cwd: '/w', reason: null }
          }
        }
        const h = setup([ask, { exec: { command: 'cat secret.txt', id: 'cat-2' } }, msg('Answered')], { FAKE_CODEX_HOOKS_LIST: 'empty' })
        expect(await h.side.done).toEqual({ ok: true, stopped: false, error: null, answer: 'Answered' })
        await h.side.exited
        expect(h.hooksOut()).toEqual([{ id: 'cat-2', tool: 'Bash', agentId: null, blocked: false }])
        expect(h.answers()).toEqual([{ id: 0, result: { decision: 'decline' } }])
        expect(spy.mock.calls.filter((c) => /codex side hook not confirmed/i.test(c.join(' ')))).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    }, 20_000)
  })

  test('without a Codex runner it ends with the fixed sentence and runs nothing', async () => {
    const f = fakeCodex({ codexRun: undefined })
    expect(await f.side.done).toEqual({ ok: false, stopped: false, error: CODEX_REFUSALS.notFound, answer: '' })
    expect(f.run).not.toHaveBeenCalled()
  })
})
