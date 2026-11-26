import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { ackArgs } from '../../src/core/chat/acknowledge'
import { buildArgs, runClaude, type RunOptions } from '../../src/core/chat/claudeRunner'
import { parseLine, type RunEvent } from '../../src/core/chat/streamParser'
import { allowResponse } from '../../src/core/chat/controlProtocol'
import { pauseSettings } from '../../src/core/chat/pauseSettings'
import { vaultGuardSettings } from '../../src/core/vault/vaultGuard'

const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))
const basic = fileURLToPath(new URL('../fixtures/stream/basic.jsonl', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'cb-runner-'))
const pidFile = join(tmp, 'gc.pid')
afterEach(() => {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
  } catch {
    /* gone */
  }
  rmSync(pidFile, { force: true })
})
let n = 0
async function ready(env: Record<string, string>) {
  const f = join(tmp, `ready-${n++}`)
  env.FAKE_READY_FILE = f
  return async () => {
    for (let i = 0; i < 400 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 10))
  }
}
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const args = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })
function run(env: Record<string, string>, o: Partial<RunOptions> = {}) {
  const events: RunEvent[] = []
  const h = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, ...env },
    onEvent: (e) => events.push(e),
    ...o
  })
  return { h, events }
}

test('buildArgs', () => {
  expect(args).toEqual([
    '-p',
    '--agent',
    'a',
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ])
  expect(buildArgs({ agentName: 'a', resumeSessionId: 'sid', permissionMode: 'auto' }).slice(0, 5)).toEqual([
    '-p',
    '--agent',
    'a',
    '--resume',
    'sid'
  ])
  const manual = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'manual' })
  expect(manual.map((a) => (a === 'manual' ? 'auto' : a))).toEqual(args)
  expect(manual[manual.indexOf('--permission-mode') + 1]).toBe('manual')
  for (const bad of ['bypassPermissions', '--dangerously-skip-permissions', '--model']) expect(args).not.toContain(bad)
})

test('buildArgs asks for thinking summaries only when told the CLI takes the flag', () => {
  const on = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', thinking: true })
  expect(on.slice(on.indexOf('--thinking-display'), on.indexOf('--thinking-display') + 2)).toEqual(['--thinking-display', 'summarized'])
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', thinking: false })).toEqual(args)
  // Before --disallowedTools, which is variadic and must stay last.
  const both = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', thinking: true, disallowedTools: ['Bash'] })
  expect(both.slice(-2)).toEqual(['--disallowedTools', 'Bash'])
})

test('buildArgs passes a model right after the agent, which overrides the agent file', () => {
  expect(buildArgs({ agentName: 'a', model: 'sonnet', resumeSessionId: 'sid', permissionMode: 'auto' }).slice(0, 7)).toEqual([
    '-p',
    '--agent',
    'a',
    '--model',
    'sonnet',
    '--resume',
    'sid'
  ])
})

test("buildArgs starts the process in a chat's own mode", () => {
  for (const mode of ['acceptEdits', 'plan'] as const) {
    const a = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: mode })
    expect(a[a.indexOf('--permission-mode') + 1]).toBe(mode)
  }
})

test('buildArgs passes an effort after the model, and none by default', () => {
  expect(buildArgs({ agentName: 'a', model: 'opus', effort: 'xhigh', resumeSessionId: null, permissionMode: 'auto' }).slice(0, 7)).toEqual([
    '-p',
    '--agent',
    'a',
    '--model',
    'opus',
    '--effort',
    'xhigh'
  ])
  expect(args).not.toContain('--effort')
})

test('replays basic fixture', async () => {
  const { h, events } = run({ FAKE_STDOUT_FILE: basic })
  const out = await h.done
  const expected = readFileSync(basic, 'utf8').split('\n').flatMap(parseLine)
  expect(events).toEqual(expected)
  expect(out.result?.subtype).toBe('success')
  expect(out.exitCode).toBe(0)
  expect(out.spawnError).toBeNull()
})

// A throw in the stream listener would be uncaught (the server dies) or skip finish() (the turn never ends).
test('an onEvent that throws costs only that event: the rest arrive and the run still finishes', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const seen: RunEvent[] = []
  let first = true
  const { h } = run(
    { FAKE_STDOUT_FILE: basic },
    {
      onEvent: (e) => {
        if (first) {
          first = false
          throw new Error('boom')
        }
        seen.push(e)
      }
    }
  )
  const out = await h.done
  const expected = readFileSync(basic, 'utf8').split('\n').flatMap(parseLine)
  expect(seen).toEqual(expected.slice(1))
  expect(out.result?.subtype).toBe('success')
  expect(log).toHaveBeenCalledWith('run event failed:', 'boom')
  log.mockRestore()
})

test('delivers large unicode as one stream-json line', async () => {
  const input = 'مرحبا 👋 "quoted" back\\slash\nnewline '.repeat(7_500)
  expect(input.length).toBeGreaterThan(225_000)
  const f = join(tmp, 'stdin.txt')
  const script = join(tmp, 'only-result.jsonl')
  writeFileSync(script, '{"type":"result","subtype":"success","is_error":false}\n')
  const { h } = run({ FAKE_STDIN_OUT: f, FAKE_STDOUT_FILE: script }, { stdin: input })
  await h.done
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  expect(lines).toHaveLength(1)
  const msg = JSON.parse(lines[0])
  expect(msg.type).toBe('user')
  expect(msg.message.content).toBe(input)
}, 20_000)

test('answers a control request mid-run', async () => {
  const input = { command: 'ls' }
  const script = join(tmp, 'control.jsonl')
  const respFile = join(tmp, 'responses.jsonl')
  rmSync(respFile, { force: true })
  writeFileSync(
    script,
    [
      JSON.stringify({
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input, description: 'd', decision_reason: 'r', tool_use_id: 'toolu_1' }
      }),
      '#WAIT_RESPONSE r1',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
    ].join('\n') + '\n'
  )
  const sent: boolean[] = []
  const events: RunEvent[] = []
  let hh: ReturnType<typeof runClaude> | null = null
  hh = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_RESPONSES_FILE: respFile },
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'permissionRequest') sent.push(hh!.send(allowResponse(e.requestId, e.input)))
    }
  })
  const out = await hh.done
  expect(out.result).not.toBeNull()
  expect(sent).toEqual([true])
  const got = readFileSync(respFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(got).toEqual([allowResponse('r1', input)])
}, 10_000)

test('#MCP_CALL runs the --mcp-config server once per run, behind its permission request', async () => {
  // A minimal stdio MCP server: it echoes each call with its env token, its pid and whether `initialized` came first.
  const echo = join(tmp, 'mcp-echo.mjs')
  writeFileSync(
    echo,
    `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let ready = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'notifications/initialized') { ready = true; return }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } })
  if (m.method === 'tools/call') return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ ready, tool: m.params.name, args: m.params.arguments, token: process.env.ECHO_TOKEN, pid: process.pid }) }], ...(m.params.name === 'fail' ? { isError: true } : {}) } })
})
`
  )
  const config = {
    mcpServers: { echo: { type: 'stdio', command: process.execPath, args: [echo], env: { ECHO_TOKEN: '${FAKE_TEST_TOKEN}' } } }
  }
  const other = { mcpServers: { other: { type: 'stdio', command: '/nonexistent', args: [] } } }
  const script = join(tmp, 'mcp.jsonl')
  const call = (o: object) => `#MCP_CALL ${JSON.stringify(o)}`
  writeFileSync(
    script,
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-mcp' }),
      call({ server: 'echo', tool: 'list', args: { a: 1 }, id: 'toolu_m1', permission: 'req-m1' }),
      call({ server: 'echo', tool: 'list', args: { a: 2 }, id: 'toolu_m2', permission: 'req-m2' }),
      call({ server: 'echo', tool: 'fail', args: {}, id: 'toolu_m3' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
    ].join('\n') + '\n'
  )
  const events: RunEvent[] = []
  let hh: ReturnType<typeof runClaude> | null = null
  hh = runClaude({
    bin: process.execPath,
    args: [fake, ...args, '--mcp-config', JSON.stringify(other), '--mcp-config', JSON.stringify(config)],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_TEST_TOKEN: 'tok-1' },
    onEvent: (e) => {
      events.push(e)
      // The first is allowed with a changed input, which is what the server must get; the second is denied.
      if (e.kind === 'permissionRequest')
        hh!.send(
          e.requestId === 'req-m1'
            ? allowResponse(e.requestId, { a: 9 })
            : {
                type: 'control_response',
                response: { subtype: 'success', request_id: e.requestId, response: { behavior: 'deny', message: 'No.' } }
              }
        )
    }
  })
  const done = await hh.done
  expect(done.result?.subtype).toBe('success')
  expect(events.filter((e) => e.kind === 'toolUse')).toEqual([
    { kind: 'toolUse', id: 'toolu_m1', name: 'mcp__echo__list', input: { a: 1 }, message: 'msg_toolu_m1' },
    { kind: 'toolUse', id: 'toolu_m2', name: 'mcp__echo__list', input: { a: 2 }, message: 'msg_toolu_m2' },
    { kind: 'toolUse', id: 'toolu_m3', name: 'mcp__echo__fail', input: {}, message: 'msg_toolu_m3' }
  ])
  expect(
    events
      .filter((e) => e.kind === 'permissionRequest')
      .map((e) => e.kind === 'permissionRequest' && [e.requestId, e.toolName, e.toolUseId])
  ).toEqual([
    ['req-m1', 'mcp__echo__list', 'toolu_m1'],
    ['req-m2', 'mcp__echo__list', 'toolu_m2']
  ])
  const results = events.flatMap((e) => (e.kind === 'toolResult' ? [e] : []))
  expect(results.map((r) => [r.toolUseId, r.isError])).toEqual([
    ['toolu_m1', false],
    ['toolu_m2', true],
    ['toolu_m3', true]
  ])
  const first = JSON.parse(results[0].content),
    third = JSON.parse(results[2].content)
  expect(first).toMatchObject({ ready: true, tool: 'list', args: { a: 9 }, token: 'tok-1' })
  expect(results[1].content).toBe('No.') // denied: the server never saw it
  expect(third).toMatchObject({ tool: 'fail', pid: first.pid }) // the same server process for the whole run
  // Stopped with the run: no MCP server outlives the fake.
  await expect
    .poll(
      () => {
        try {
          process.kill(first.pid, 0)
          return true
        } catch {
          return false
        }
      },
      { timeout: 3000 }
    )
    .toBe(false)
}, 15_000)

test('send after exit returns false', async () => {
  const { h } = run({})
  await h.done
  expect(h.send({ type: 'x' })).toBe(false)
})

test('send never throws when stdin is gone', async () => {
  const env: Record<string, string> = { FAKE_HANG: '1' }
  const wait = await ready(env)
  const { h } = run(env)
  await wait()
  expect(h.send({ type: 'x' })).toBe(true)
  h.stop()
  expect(() => expect(h.send({ type: 'x' })).toBe(false)).not.toThrow()
  await h.done
  expect(() => {
    expect(h.send({ type: 'x' })).toBe(false)
  }).not.toThrow()
  await new Promise((r) => setTimeout(r, 50))
}, 10_000)

test('closes stdin after the result event', async () => {
  const script = join(tmp, 'result-only.jsonl')
  writeFileSync(script, '{"type":"result","subtype":"success","is_error":false}\n')
  const { h } = run({ FAKE_STDOUT_FILE: script, FAKE_HANG: '1', FAKE_EXIT_ON_STDIN_END: '1' })
  let timer: NodeJS.Timeout | undefined
  try {
    // Self-cleaning: a regression must fail the test, not orphan the hanging fake.
    const out = await Promise.race([
      h.done,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          h.stop()
          rej(new Error('stdin was not closed after result'))
        }, 3000)
      })
    ])
    expect(out.stopped).toBe(false)
    expect(out.exitCode).toBe(0)
    expect(out.result?.subtype).toBe('success')
  } finally {
    clearTimeout(timer)
    h.stop()
    await h.done
  }
}, 8_000)

test('turns background tasks off, whatever the given env says', async () => {
  const givens: Record<string, string>[] = [{}, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' }]
  for (const given of givens) {
    const f = join(tmp, 'env.json')
    const { h } = run({ ...given, FAKE_ENV_OUT: f })
    await h.done
    expect(JSON.parse(readFileSync(f, 'utf8')).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
  }
})

// A one-shot call (the ack line here) starts beside a run, so it must not replace the env and argv the fake captured for the
// run: app tests read the run's env from FAKE_ENV_OUT, and on a slow runner the ack call's fake used to write it last.
test("the fake's env and argv capture is the run's, never a one-shot call's started beside it", async () => {
  const envOut = join(tmp, 'pair-env.json'),
    argsOut = join(tmp, 'pair-args.json')
  const { h } = run({ FAKE_ENV_OUT: envOut, FAKE_ARGS_OUT: argsOut, FAKE_TEST_MARK: 'run' })
  await h.done
  spawnSync(process.execPath, [fake, ...ackArgs()], {
    input: '',
    env: { ...process.env, FAKE_ENV_OUT: envOut, FAKE_ARGS_OUT: argsOut, FAKE_TEST_MARK: 'ack' },
    timeout: 10_000
  })
  expect(JSON.parse(readFileSync(envOut, 'utf8')).FAKE_TEST_MARK).toBe('run')
  expect(JSON.parse(readFileSync(argsOut, 'utf8'))).toEqual(args)
})

test('gives Bash longer timeouts unless the server env sets its own', async () => {
  const f = join(tmp, 'env.json')
  let { h } = run({ FAKE_ENV_OUT: f })
  await h.done
  expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '1800000' })
  ;({ h } = run({ FAKE_ENV_OUT: f, BASH_MAX_TIMEOUT_MS: '60000' }))
  await h.done
  expect(JSON.parse(readFileSync(f, 'utf8')).BASH_MAX_TIMEOUT_MS).toBe('60000')
})

test('utf8 split across chunks stays intact', async () => {
  const { h, events } = run({ FAKE_SPLIT_UTF8: '1' })
  await h.done
  expect(events).toEqual([{ kind: 'textDelta', text: 'hi 👋' }])
})

test('missing cwd', async () => {
  const { h, events } = run({}, { cwd: '/nope/xyz' })
  const out = await h.done
  expect(out.spawnError).toBe('Folder not found: /nope/xyz')
  expect(events).toEqual([])
})

test('cwd that is a file', async () => {
  const { h } = run({}, { cwd: fake })
  expect((await h.done).spawnError).toBe(`Folder not found: ${fake}`)
})

test('bad bin', async () => {
  const { h } = run({}, { bin: '/nope/claude' })
  const out = await h.done
  expect(out.spawnError).toContain('ENOENT')
  expect(out.exitCode).toBeNull()
  expect(out.signal).toBeNull()
})

test('stop hanging process', async () => {
  const env: Record<string, string> = { FAKE_HANG: '1' }
  const wait = await ready(env)
  const { h } = run(env)
  await wait()
  const t = Date.now()
  h.stop()
  const out = await h.done
  expect(Date.now() - t).toBeLessThan(1000)
  expect(out.stopped).toBe(true)
  // Windows has no SIGINT for a child: Stop ends claude's tree with taskkill, so there is no signal to report.
  if (process.platform !== 'win32') expect(out.signal).toBe('SIGINT')
})

// POSIX signals: Windows ends the tree at once and has nothing to escalate.
test.skipIf(process.platform === 'win32')(
  'escalates to SIGTERM',
  async () => {
    const env: Record<string, string> = { FAKE_HANG: '1', FAKE_IGNORE_SIGINT: '1' }
    const wait = await ready(env)
    const { h } = run(env, { killGraceMs: 200 })
    await wait()
    h.stop()
    const out = await h.done
    expect(out.signal).toBe('SIGTERM')
    expect(out.stopped).toBe(true)
  },
  10_000
)

// POSIX signals: Windows ends the tree at once and has nothing to escalate.
test.skipIf(process.platform === 'win32')(
  'escalates to SIGKILL when SIGTERM is ignored too',
  async () => {
    const env: Record<string, string> = { FAKE_HANG: '1', FAKE_IGNORE_SIGINT: '1', FAKE_IGNORE_SIGTERM: '1' }
    const wait = await ready(env)
    const { h } = run(env, { killGraceMs: 100, killForceMs: 200 })
    await wait()
    const t = Date.now()
    h.stop()
    const out = await h.done
    expect(out.signal).toBe('SIGKILL')
    expect(out.stopped).toBe(true)
    expect(Date.now() - t).toBeLessThan(3000)
  },
  10_000
)

test('stop after exit is a no-op', async () => {
  const { h } = run({})
  const out = await h.done
  expect(() => {
    h.stop()
    h.stop()
  }).not.toThrow()
  expect(out.stopped).toBe(false)
})

test('nonzero exit', async () => {
  const { h } = run({ FAKE_EXIT: '1', FAKE_STDERR: 'boom' })
  const out = await h.done
  expect(out.exitCode).toBe(1)
  expect(out.stderr).toBe('boom')
})

test('stop settles even if a grandchild holds stdout open', async () => {
  const env: Record<string, string> = { FAKE_HANG: '1', FAKE_LEAK_STDOUT: '1', FAKE_PID_FILE: pidFile }
  const wait = await ready(env)
  const { h } = run(env)
  await wait()
  const t = Date.now()
  h.stop()
  const out = await h.done
  expect(Date.now() - t).toBeLessThan(3500)
  expect(out.stopped).toBe(true)
  // Windows has no SIGINT for a child: Stop ends claude's tree with taskkill, so there is no signal to report.
  if (process.platform !== 'win32') expect(out.signal).toBe('SIGINT')
}, 10_000)

test('buildArgs appends deny rules only when given', () => {
  const base = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })
  expect(base).not.toContain('--disallowedTools')
  const denied = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', disallowedTools: ['Edit(//x/y.md)'] })
  expect(denied).toEqual([...base, '--disallowedTools', 'Edit(//x/y.md)'])
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', disallowedTools: [] })).toEqual(base)
})

test('buildArgs puts extra args before the deny list', () => {
  const base = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })
  const both = buildArgs({
    agentName: 'a',
    resumeSessionId: null,
    permissionMode: 'auto',
    extraArgs: ['--x', '1'],
    disallowedTools: ['Agent(b)']
  })
  expect(both).toEqual([...base, '--x', '1', '--disallowedTools', 'Agent(b)'])
  expect(both.slice(-4)).toEqual(['--x', '1', '--disallowedTools', 'Agent(b)'])
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', extraArgs: [] })).toEqual(base)
})

test("buildArgs merges several --settings into one, at the first one's place", () => {
  const base = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })
  const one = '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"exit 2"}]}]}}'
  // A lone --settings is passed through byte for byte.
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', extraArgs: ['--settings', one] })).toEqual([
    ...base,
    '--settings',
    one
  ])
  const merged = buildArgs({
    agentName: 'a',
    resumeSessionId: null,
    permissionMode: 'auto',
    disallowedTools: ['Agent(b)'],
    extraArgs: [
      '--mcp-config',
      'm1',
      '--settings',
      one,
      '--mcp-config',
      'm2',
      '--settings',
      '{"permissions":{"ask":["x","y"]}}',
      '--x',
      '--settings',
      '{"permissions":{"ask":["y","z"],"deny":["d"]}}'
    ]
  })
  expect(merged).toEqual([
    ...base,
    '--mcp-config',
    'm1',
    '--settings',
    expect.any(String),
    '--mcp-config',
    'm2',
    '--x',
    '--disallowedTools',
    'Agent(b)'
  ])
  const value = merged[merged.indexOf('--settings') + 1]
  expect(merged.filter((a) => a === '--settings')).toHaveLength(1)
  expect(JSON.parse(value)).toEqual({ ...JSON.parse(one), permissions: { ask: ['x', 'y', 'z'], deny: ['d'] } })
  expect(value.startsWith(one.slice(0, -1))).toBe(true)
  expect(() =>
    buildArgs({
      agentName: 'a',
      resumeSessionId: null,
      permissionMode: 'auto',
      extraArgs: ['--settings', '/a/file.json', '--settings', one]
    })
  ).toThrow()
})

test('merges the vault guard with the pause hook and desktop ask rules into one --settings', () => {
  const guard = vaultGuardSettings({
    keyFile: '/home/u/.config/zumibot-vault/vault.key',
    vaultFile: '/home/u/.local/share/zumibot/vault.json',
    home: '/home/u'
  })
  const pause = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
  const ask = '{"permissions":{"ask":["mcp__zumibot_desktop__desktop_click"]}}'
  const args = buildArgs({
    agentName: 'a',
    resumeSessionId: null,
    permissionMode: 'auto',
    extraArgs: ['--settings', ask, '--settings', guard, '--settings', pause]
  })
  expect(args.filter((a) => a === '--settings')).toHaveLength(1)
  const merged = JSON.parse(args[args.indexOf('--settings') + 1]) as {
    permissions: { ask: string[]; deny: string[] }
    hooks: { PreToolUse: { matcher: string }[] }
  }
  expect(merged.permissions.ask).toEqual(['mcp__zumibot_desktop__desktop_click'])
  expect(merged.permissions.deny).toEqual(JSON.parse(guard).permissions.deny)
  expect(merged.hooks.PreToolUse.map((h) => h.matcher)).toEqual(['Bash', '*'])
})

test('buildArgs appends a system prompt with a fresh snapshot, before extra args', () => {
  const base = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })
  const withSystem = buildArgs({
    agentName: 'a',
    resumeSessionId: null,
    permissionMode: 'auto',
    appendSystemPrompt: 'be brief',
    extraArgs: ['--x', '1']
  })
  expect(withSystem).toEqual([...base, '--append-system-prompt', 'be brief', '--system-prompt-snapshot', 'off', '--x', '1'])
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', appendSystemPrompt: '' })).toEqual(base)
})

test('buildArgs adds resume-at and fork after --resume', () => {
  const a = buildArgs({ agentName: 'a', resumeSessionId: 's', resumeAt: 'u', permissionMode: 'auto' })
  const i = a.indexOf('--resume')
  expect(a.slice(i, i + 5)).toEqual(['--resume', 's', '--resume-session-at', 'u', '--fork-session'])
  const none = buildArgs({ agentName: 'a', resumeSessionId: null, resumeAt: 'u', permissionMode: 'auto' })
  expect(none).not.toContain('--resume-session-at')
  expect(none).not.toContain('--fork-session')
})

test('buildArgs asks the CLI to echo stdin user messages only when told', () => {
  const on = buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', replayUser: true })
  expect(on).toContain('--replay-user-messages')
  expect(on.indexOf('--replay-user-messages')).toBe(on.indexOf('--include-partial-messages') + 1)
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto' })).toEqual(args)
  expect(buildArgs({ agentName: 'a', resumeSessionId: null, permissionMode: 'auto', replayUser: false })).toEqual(args)
})

// ---- mid-turn steers (docs/architecture/mid-turn-messages.md) ----

const line = (o: object) => JSON.stringify(o)
const INIT = line({ type: 'system', subtype: 'init', session_id: 'sid-steer' })
const RESULT = line({ type: 'result', subtype: 'success', is_error: false })
const TEXT = (t: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })

/** done, or a failed test (the fake hangs until stdin closes) instead of an orphaned process. */
async function settles(h: ReturnType<typeof runClaude>, ms = 4000) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      h.done,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          h.stop()
          rej(new Error('run did not end'))
        }, ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('steer writes a stream-json user line under the given uuid', async () => {
  const f = join(tmp, 'steer-stdin.txt')
  const script = join(tmp, 'steer-mid.jsonl')
  writeFileSync(script, [INIT, '#STEER_REPLAY', TEXT('ok'), RESULT].join('\n') + '\n')
  let steered: boolean | null = null
  const events: RunEvent[] = []
  const h: ReturnType<typeof runClaude> = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_STDIN_OUT: f },
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'init') steered = h.steer!('more detail', 's-1')
    }
  })
  await settles(h)
  expect(steered).toBe(true)
  const lines = readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(lines[1]).toEqual({ type: 'user', message: { role: 'user', content: 'more detail' }, uuid: 's-1' })
  expect(events.filter((e) => e.kind === 'userReplay')).toEqual([{ kind: 'userReplay', uuid: 's-1' }])
})

test('steer returns false once the result closed stdin', async () => {
  const script = join(tmp, 'steer-late.jsonl')
  writeFileSync(script, [INIT, RESULT].join('\n') + '\n')
  const { h } = run({ FAKE_STDOUT_FILE: script })
  await settles(h)
  expect(h.steer!('too late', 's-2')).toBe(false)
})

test('keeps stdin open past a result while a steer is unread, then closes at the next result', async () => {
  const script = join(tmp, 'steer-second-turn.jsonl')
  writeFileSync(script, [INIT, TEXT('first'), RESULT, '#STEER_REPLAY', INIT, TEXT('second'), RESULT].join('\n') + '\n')
  const events: RunEvent[] = []
  let steered = false
  const h: ReturnType<typeof runClaude> = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_HANG: '1', FAKE_EXIT_ON_STDIN_END: '1' },
    onEvent: (e) => {
      events.push(e)
      // Handled before the result that follows in the same read: the steer is unread when the result comes.
      if (e.kind === 'assistantText' && e.text === 'first') steered = h.steer!('late detail', 's-3')
    }
  })
  const out = await settles(h)
  expect(steered).toBe(true)
  expect(out.exitCode).toBe(0)
  expect(events.filter((e) => e.kind === 'result')).toHaveLength(2)
  expect(events.some((e) => e.kind === 'userReplay' && e.uuid === 's-3')).toBe(true)
}, 10_000)

test('closes stdin after the grace when an unread steer never comes back', async () => {
  const script = join(tmp, 'steer-lost.jsonl')
  writeFileSync(script, [INIT, RESULT].join('\n') + '\n')
  let steered = false
  const h: ReturnType<typeof runClaude> = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    steerGraceMs: 50,
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_HANG: '1', FAKE_EXIT_ON_STDIN_END: '1' },
    onEvent: (e) => {
      if (e.kind === 'init') steered = h.steer!('never read', 's-4')
    }
  })
  const out = await settles(h)
  expect(steered).toBe(true)
  expect(out.exitCode).toBe(0)
}, 10_000)

test('a steer before the process is up goes in right after the prompt', async () => {
  const f = join(tmp, 'steer-early-stdin.txt')
  const script = join(tmp, 'steer-early.jsonl')
  writeFileSync(script, [INIT, '#STEER_REPLAY', TEXT('ok'), RESULT].join('\n') + '\n')
  const events: RunEvent[] = []
  const h = runClaude({
    bin: process.execPath,
    args: [fake, ...args],
    cwd: tmp,
    stdin: 'hello',
    env: { ...process.env, FAKE_STDOUT_FILE: script, FAKE_STDIN_OUT: f },
    onEvent: (e) => events.push(e)
  })
  // Synchronously, before the folder check and the spawn.
  expect(h.steer!('right away', 's-5')).toBe(true)
  await settles(h)
  const lines = readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(lines.map((l) => l.message.content)).toEqual(['hello', 'right away'])
  expect(events.some((e) => e.kind === 'userReplay' && e.uuid === 's-5')).toBe(true)
})
