import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blocks, pauseHookOf, pauseSettings, runPauseHook } from '../../src/core/chat/pauseSettings'
import { resolveBrowserRuntime } from '../../src/core/browser/browserRuntime'

const exitTwoFixture = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/exit-two.mjs')
const cmdOf = (node: string, entry: string, electronNode = false): string =>
  JSON.parse(pauseSettings({ node, entry, electronNode })).hooks.PreToolUse[0].hooks[0].command

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-pause-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('blocks', () => {
  it('lets subagent calls through', () => expect(blocks('{"tool_name":"Bash","agent_id":"a1"}')).toBe(false))
  it('blocks main-thread calls, even with agent_type (an --agent session has it)', () =>
    expect(blocks('{"tool_name":"Agent","agent_type":"helper"}')).toBe(true))
  it('blocks unreadable input', () => expect(blocks('not json')).toBe(true))
  it('ignores an agent_id nested in tool_input', () => expect(blocks('{"tool_input":{"agent_id":"x"}}')).toBe(true))
  it('blocks an empty or non-string agent_id', () => {
    expect(blocks('{"agent_id":""}')).toBe(true)
    expect(blocks('{"agent_id":5}')).toBe(true)
  })

  // R22: a paused Codex main thread may still wait for (and list) its running subagents, as Claude's pause lets them finish.
  // Check 11 recorded the wait's input on the main thread: no agent_id, `tool_name: "collaborationwait_agent"`.
  const recorded = () =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../fixtures/codex/codex-check11.jsonl', import.meta.url)), 'utf8')
        .trim()
        .split('\n')
        .at(-1)!
    )
      .meta.files['hook-log'].split('\n')
      .filter(Boolean) as string[]
  it("lets Codex's own wait for subagents and their list through on the main thread; the spawn and every other call still block", () => {
    const wait = recorded().find((l) => l.includes('"collaborationwait_agent"'))!
    const spawn = recorded().find((l) => l.includes('"collaborationspawn_agent"'))!
    expect(JSON.parse(wait).agent_id).toBeUndefined()
    expect(blocks(wait)).toBe(false)
    expect(blocks('{"tool_name":"collaborationlist_agents","tool_input":{}}')).toBe(false)
    expect(blocks(spawn)).toBe(true)
    for (const tool of ['collaborationsend_input', 'collaborationclose_agent', 'Bash', 'apply_patch', 'mcp__probe__probe_echo']) {
      expect(blocks(JSON.stringify({ tool_name: tool, tool_input: {} }))).toBe(true)
    }
  })
  it('only the exact top-level tool_name passes: a nested, differently cased or non-string one still blocks', () => {
    expect(blocks('{"tool_input":{"tool_name":"collaborationwait_agent"}}')).toBe(true)
    expect(blocks('{"tool_name":"CollaborationWait_Agent"}')).toBe(true)
    expect(blocks('{"tool_name":"collaborationwait_agent "}')).toBe(true)
    expect(blocks('{"tool_name":["collaborationwait_agent"]}')).toBe(true)
  })
  it('every Claude main-thread call blocks as before, and every Claude subagent call passes as before', () => {
    const claude = [
      'Agent',
      'Task',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'TaskOutput',
      'KillShell',
      'AskUserQuestion',
      'ExitPlanMode',
      'NotebookEdit',
      'mcp__zumibot_todos__add',
      'mcp__zumibot_browser__browser_click'
    ]
    for (const tool of claude) {
      expect(blocks(JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }))).toBe(true)
      expect(
        blocks(JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, agent_id: 'sub-1' }))
      ).toBe(false)
    }
  })
})

// Printed by HEAD's pauseSettings, before pauseCommand was factored out: every Claude run's --settings must stay byte for byte.
describe('pauseSettings output is pinned', () => {
  const pinned: [{ node: string; entry: string; electronNode: boolean }, string][] = [
    [
      { node: '/usr/bin/node', entry: '/opt/zumibot/pauseHook.mjs', electronNode: false },
      '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"[ -e \\"$ZUMIBOT_PAUSE_FILE\\" ] || exit 0; exec \'/usr/bin/node\' \'/opt/zumibot/pauseHook.mjs\'"}]}]}}'
    ],
    [
      { node: '/opt/Zumi Bot/zumibot', entry: '/opt/zumibot/pauseHook.mjs', electronNode: true },
      '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"[ -e \\"$ZUMIBOT_PAUSE_FILE\\" ] || exit 0; ELECTRON_RUN_AS_NODE=1 exec \'/opt/Zumi Bot/zumibot\' \'/opt/zumibot/pauseHook.mjs\'"}]}]}}'
    ],
    [
      { node: '/opt/my node/bin/node', entry: '/opt/zumibot/pause hook.mjs', electronNode: false },
      '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"[ -e \\"$ZUMIBOT_PAUSE_FILE\\" ] || exit 0; exec \'/opt/my node/bin/node\' \'/opt/zumibot/pause hook.mjs\'"}]}]}}'
    ],
    [
      { node: "/opt/it's/node", entry: "/opt/it's/pauseHook.mjs", electronNode: true },
      '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"[ -e \\"$ZUMIBOT_PAUSE_FILE\\" ] || exit 0; ELECTRON_RUN_AS_NODE=1 exec \'/opt/it\'\\\\\'\'s/node\' \'/opt/it\'\\\\\'\'s/pauseHook.mjs\'"}]}]}}'
    ]
  ]
  it.each(pinned)('%j', (o, expected) => expect(pauseSettings(o)).toBe(expected))
})

describe('pauseSettings', () => {
  it('has the PreToolUse shape for every tool', () => {
    const s = JSON.parse(pauseSettings({ node: '/n', entry: '/e', electronNode: false }))
    expect(s).toEqual({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: expect.any(String) }] }] } })
  })
  it('exits 0 without running node when the flag is absent', () => {
    const cmd = cmdOf('/nonexistent/node', '/x.mjs')
    expect(spawnSync('sh', ['-c', cmd], { env: { ZUMIBOT_PAUSE_FILE: join(tmp, 'none') } }).status).toBe(0)
  })
  it('runs the entry when the flag exists (exit code passes through)', async () => {
    const flag = join(tmp, 'flag')
    await fs.writeFile(flag, '')
    expect(spawnSync('sh', ['-c', cmdOf(process.execPath, exitTwoFixture)], { env: { ZUMIBOT_PAUSE_FILE: flag } }).status).toBe(2)
  })
  it('quotes paths with spaces and quotes', () => expect(cmdOf("/a b/it's/node", '/e.mjs')).toContain(`'/a b/it'\\''s/node'`))
  it('prefixes ELECTRON_RUN_AS_NODE only for Electron node', () => {
    expect(cmdOf('/n', '/e', true)).toContain('ELECTRON_RUN_AS_NODE=1 exec')
    expect(cmdOf('/n', '/e', false)).not.toContain('ELECTRON_RUN_AS_NODE')
  })
})

it('the runtime names the pause hook entry', () => {
  expect(resolveBrowserRuntime().pauseHookEntry).toMatch(/pauseHook\.(ts|mjs)$/)
})

describe('pauseHookOf', () => {
  const rt = { node: '/usr/bin/node', pauseHookEntry: '/opt/zumibot/pauseHook.mjs', electronNode: false }
  it("is the hook's settings for an install that has its entry", () => {
    expect(pauseHookOf(rt, (p) => p === rt.pauseHookEntry)).toEqual({
      settings: pauseSettings({ node: rt.node, entry: rt.pauseHookEntry, electronNode: false })
    })
    expect(pauseHookOf({ ...rt, electronNode: true }, () => true)?.settings).toContain('ELECTRON_RUN_AS_NODE=1 exec')
  })
  it('is null when the entry is missing (an incomplete build) or a path is relative', () => {
    expect(pauseHookOf(rt, () => false)).toBeNull()
    expect(pauseHookOf({ ...rt, pauseHookEntry: 'pauseHook.mjs' }, () => true)).toBeNull()
    expect(pauseHookOf({ ...rt, node: 'node' }, () => true)).toBeNull()
  })
})

describe('runPauseHook', () => {
  const TEXT = 'Blocked (zumibot-pause).'
  // The hook's run over fake streams: what it wrote to stderr, and every exit it asked for.
  const hookRun = (o: { failStderr?: boolean; timeoutMs?: number } = {}) => {
    const stdin = new PassThrough()
    let err = ''
    const exits: number[] = []
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        if (o.failStderr) return cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        err += String(chunk)
        cb()
      }
    })
    stderr.on('error', () => {}) // the stream's own listener; the hook adds its own
    let settled!: () => void
    const exited = new Promise<void>((resolve) => {
      settled = resolve
    })
    runPauseHook({
      stdin,
      stderr,
      exit: (code) => {
        exits.push(code)
        settled()
      },
      blockText: TEXT,
      timeoutMs: o.timeoutMs ?? 5000
    })
    const result = async () => {
      await exited
      await new Promise((r) => setTimeout(r, 20)) // a second exit, if any, would come by now
      return { exits, err }
    }
    return { stdin, result }
  }

  it('blocks a main-thread call with the text, and lets a subagent call through', async () => {
    const main = hookRun()
    main.stdin.end('{"tool_name":"Bash"}')
    expect(await main.result()).toEqual({ exits: [2], err: `${TEXT}\n` })
    const sub = hookRun()
    sub.stdin.end('{"tool_name":"Bash","agent_id":"a1"}')
    expect(await sub.result()).toEqual({ exits: [0], err: '' })
  })

  it('stdin closing without its end counts as the end of the input: what was read decides, partial input blocks', async () => {
    const partial = hookRun()
    partial.stdin.write('{"tool_name":"Ba')
    await new Promise((r) => setImmediate(r))
    partial.stdin.destroy()
    expect(await partial.result()).toEqual({ exits: [2], err: `${TEXT}\n` })
    const whole = hookRun()
    whole.stdin.write('{"tool_name":"Bash","agent_id":"a1"}')
    await new Promise((r) => setImmediate(r))
    whole.stdin.destroy()
    expect(await whole.result()).toEqual({ exits: [0], err: '' })
  })

  it('a stdin error blocks with the text, once', async () => {
    const run = hookRun()
    run.stdin.write('{"agent_id":"a1"}')
    run.stdin.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' }))
    expect(await run.result()).toEqual({ exits: [2], err: `${TEXT}\n` })
  })

  it('a stderr it cannot write to still blocks, once', async () => {
    const run = hookRun({ failStderr: true })
    run.stdin.end('{"tool_name":"Bash"}')
    expect((await run.result()).exits).toEqual([2])
  })

  it('a stdin that never ends blocks after the timeout instead of hanging until the CLI gives up on it', async () => {
    const run = hookRun({ timeoutMs: 30 })
    run.stdin.write('{"tool_name":"Bash","agent_id":"a1"}')
    expect(await run.result()).toEqual({ exits: [2], err: `${TEXT}\n` })
    run.stdin.end() // too late: it already exited
    await new Promise((r) => setTimeout(r, 20))
    expect((await run.result()).exits).toEqual([2])
  })
})
