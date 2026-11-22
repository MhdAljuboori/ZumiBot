import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAUSE_BLOCK_TEXT } from '@zumibot/shared/pause'
import { CODEX_SIDE_DENY_HOOK, codexPauseHook, codexVaultHooks } from '../../src/core/codex/codexHooks'
import { hookConfig, type CodexHook } from '../../src/core/codex/codexParams'
import { blocks, pauseHookOf } from '../../src/core/chat/pauseSettings'
import { VAULT_GUARD_TEXT, vaultGuardCommand } from '../../src/core/vault/vaultGuard'
import { symlinksWork } from '../support/platform'
import { writeFakeBin } from '../support/fakeBin'

const FAKE = join(__dirname, '..', 'fixtures', 'fake-codex.mjs')
const PAUSE_ENTRY = join(__dirname, '..', 'fixtures', 'pause-hook-src.mjs')
const RECORDED = join(__dirname, '..', 'fixtures', 'codex', 'codex-check11.jsonl')

// Resolved, so on Windows they are drive paths as the guard's patterns are (the same strings on Linux).
const home = resolve('/home/ann')
const keyFile = join(home, '.config', "it's vault", 'vault.key')
const vaultFile = join(home, '.local', 'share', 'zumibot', 'vault.json')

// Probe check 11's hook stdin, verbatim: the file's last line holds every hook input of the run.
const recorded: Record<string, unknown>[] = (() => {
  const lines = readFileSync(RECORDED, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const meta = lines.find((l) => l.meta)!.meta
  return String(meta.files['hook-log'])
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
})()
const main = recorded.find((i) => i.tool_name === 'Bash' && (i.tool_input as { command: string }).command === 'echo main')!
const sub = recorded.find((i) => typeof i.agent_id === 'string')!
const withCommand = (input: Record<string, unknown>, command: string) => ({ ...input, tool_input: { command } })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-hooks-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sh = (command: string, input: unknown, env: Record<string, string> = {}) => {
  const r = spawnSync('sh', ['-c', command], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return { code: r.status, stderr: r.stderr.trim() }
}

describe("check 11's recorded input", () => {
  it('has a subagent call carrying agent_id and a main-thread call carrying none', () => {
    expect(sub.agent_id).toEqual(expect.any(String))
    expect(main.agent_id).toBeUndefined()
  })

  it('the existing pause rule reads it as is: a subagent call passes, the main thread, {} and unreadable input are blocked; only the main wait for subagents passes (R22)', () => {
    expect(blocks(JSON.stringify(sub))).toBe(false)
    expect(blocks(JSON.stringify(main))).toBe(true)
    const mains = recorded.filter((i) => i.agent_id === undefined)
    expect(mains.map((i) => i.tool_name)).toContain('collaborationwait_agent')
    for (const input of mains)
      expect(blocks(JSON.stringify(input)), String(input.tool_name)).toBe(input.tool_name !== 'collaborationwait_agent')
    expect(blocks('{}')).toBe(true)
    expect(blocks('not json')).toBe(true)
  })
})

describe('vaultGuardCommand', () => {
  const o = { keyFile, vaultFile, home }
  it("blocks check 11's recorded stdin naming the key file or vault.json, and passes one that does not", () => {
    const hit = sh(vaultGuardCommand(o), withCommand(main, `cat ${keyFile}`))
    expect(hit).toEqual({ code: 2, stderr: VAULT_GUARD_TEXT })
    expect(sh(vaultGuardCommand(o), withCommand(main, 'cat ~/.local/share/zumibot/vault.json')).code).toBe(2)
    expect(sh(vaultGuardCommand(o), main)).toEqual({ code: 0, stderr: '' })
    expect(sh(vaultGuardCommand(o), withCommand(main, 'ls /home/ann')).code).toBe(0)
  })

  it('names the path in an MCP and a patch call too, since the plain grep reads the whole JSON', () => {
    const patch = recorded.find((i) => i.tool_name === 'apply_patch')!
    expect(
      sh(vaultGuardCommand(o), { ...patch, tool_input: { command: `*** Begin Patch\n*** Update File: ${vaultFile}\n*** End Patch` } }).code
    ).toBe(2)
    expect(sh(vaultGuardCommand(o), { tool_name: 'mcp__x__read', tool_input: { path: vaultFile } }).code).toBe(2)
  })

  it('the Claude form lets a failing grep through (its own exit 2 skips the block), the failClosed form does not', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'grep'), '#!/bin/sh\nexit 2\n')
    chmodSync(join(bin, 'grep'), 0o755)
    const env = { PATH: `${bin}${delimiter}${process.env.PATH}` }
    expect(sh(vaultGuardCommand(o), withCommand(main, `cat ${keyFile}`), env).code).toBe(0)
    expect(sh(vaultGuardCommand(o, true), withCommand(main, 'ls'), env)).toEqual({ code: 2, stderr: VAULT_GUARD_TEXT })
  })
})

describe('the Codex hooks', () => {
  const rt = { node: process.execPath, pauseHookEntry: PAUSE_ENTRY, electronNode: false }

  it('codexVaultHooks: one hook with no matcher (so shell, MCP and patch calls all reach it), the fail-closed vault command, a 30 s timeout', () => {
    const hooks = codexVaultHooks({ keyFile, vaultFile, home })
    expect(hooks).toEqual([
      { event: 'preToolUse', matcher: null, command: vaultGuardCommand({ keyFile, vaultFile, home }, true), timeoutSec: 30 }
    ])
  })

  it('codexPauseHook: null exactly when pauseHookOf is null, else a hook that never ends in exec node', () => {
    for (const [r, exists] of [
      [rt, () => false],
      [{ ...rt, pauseHookEntry: 'pauseHook.mjs' }, () => true],
      [{ ...rt, node: 'node' }, () => true],
      [rt, () => true]
    ] as const) {
      expect(codexPauseHook(r, exists) === null).toBe(pauseHookOf(r, exists) === null)
    }
    expect(codexPauseHook({ ...rt, pauseHookEntry: join(dir, 'missing.mjs') })).toBeNull()
    const hook = codexPauseHook(rt, () => true)!
    expect(hook).toMatchObject({ event: 'preToolUse', matcher: null, timeoutSec: 30 })
    expect(hook.command).toMatch(/^\[ -e "\$ZUMIBOT_PAUSE_FILE" \] \|\| exit 0; /)
    expect(hook.command).not.toContain('exec')
    expect(hook.command).toMatch(/; \[ \$\? -eq 0 \] && exit 0; exit 2$/)
    expect(codexPauseHook({ ...rt, electronNode: true }, () => true)!.command).toContain(`ELECTRON_RUN_AS_NODE=1 '${process.execPath}'`)
    expect(codexPauseHook(rt, () => true)!.command).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it("the pause hook's timeout is well above runPauseHook's 10 s input deadline", () => {
    expect(codexPauseHook(rt, () => true)!.timeoutSec).toBeGreaterThanOrEqual(20)
  })

  it('CODEX_SIDE_DENY_HOOK blocks every call with the side guard text', () => {
    expect(CODEX_SIDE_DENY_HOOK).toMatchObject({ event: 'preToolUse', matcher: null, timeoutSec: 30 })
    expect(sh(CODEX_SIDE_DENY_HOOK.command, main)).toEqual({ code: 2, stderr: 'No tools in a side answer' })
    expect(sh(CODEX_SIDE_DENY_HOOK.command, sub)).toEqual({ code: 2, stderr: 'No tools in a side answer' })
  })

  it('every hook encodes into app-server arguments', () => {
    const hooks: CodexHook[] = [...codexVaultHooks({ keyFile, vaultFile, home }), codexPauseHook(rt, () => true)!, CODEX_SIDE_DENY_HOOK]
    expect(hookConfig(hooks)).toHaveLength(2)
  })
})

// The real commands through the fake app-server: hookConfig's arguments, the fake's trust check and its `sh -c` with check 11's stdin.
describe('round trip through fake-codex', () => {
  type Msg = { id?: number; method?: string; params?: any; result?: any }
  const children: ChildProcessWithoutNullStreams[] = []
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL')
  })

  class Client {
    readonly seen: Msg[] = []
    private nextId = 1
    private child: ChildProcessWithoutNullStreams
    constructor(args: string[], env: Record<string, string>) {
      this.child = spawn(process.execPath, [FAKE, 'app-server', '--listen', 'stdio://', ...args], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      children.push(this.child)
      let buf = ''
      this.child.stdout.setEncoding('utf8').on('data', (c: string) => {
        buf += c
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const l = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (l) this.seen.push(JSON.parse(l))
        }
      })
    }
    private wait(pred: (m: Msg) => boolean, ms = 15_000): Promise<Msg> {
      return new Promise((resolve, reject) => {
        const t0 = Date.now()
        const tick = () => {
          const m = this.seen.find(pred)
          if (m) return resolve(m)
          if (Date.now() - t0 > ms) return reject(new Error(`timed out; seen: ${JSON.stringify(this.seen)}`))
          setTimeout(tick, 10)
        }
        tick()
      })
    }
    request(method: string, params?: unknown): Promise<Msg> {
      const id = this.nextId++
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      return this.wait((m) => m.id === id && m.method === undefined)
    }
    async open() {
      await this.request('initialize', { clientInfo: { name: 't', title: null, version: '0' }, capabilities: null })
      this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      return (await this.request('thread/start', { cwd: dir })).result.thread.id as string
    }
    async turn() {
      const thread = await this.open()
      await this.request('turn/start', { threadId: thread, input: [] })
      await this.wait((m) => m.method === 'turn/completed')
    }
    completed() {
      return this.seen.filter((m) => m.method === 'hook/completed').map((m) => m.params.run)
    }
    items() {
      return this.seen.filter((m) => m.method === 'item/started').map((m) => m.params.item)
    }
  }

  /** What one process saw for a scripted list of shell calls, its hooks trusted as ZumiBot's pre-flight does. */
  async function run(hooks: CodexHook[], calls: object[], env: Record<string, string> = {}) {
    const plain = hookConfig(hooks)
    const probe = new Client(plain, env)
    await probe.request('initialize', { clientInfo: { name: 't', title: null, version: '0' }, capabilities: null })
    const listed = (await probe.request('hooks/list', { cwds: [dir] })).result.data[0].hooks as { key: string; currentHash: string }[]
    const args = hookConfig(hooks, new Map(listed.map((h) => [h.key, h.currentHash])))
    const script = join(dir, 'script.jsonl')
    writeFileSync(script, calls.map((exec) => JSON.stringify({ exec })).join('\n') + '\n')
    const c = new Client(args, { FAKE_CODEX_HOME: join(dir, 'home'), FAKE_CODEX_SCRIPT: script, ...env })
    await c.turn()
    return c
  }
  const call = (command: string, agent?: { threadId: string }) => ({ command, ...(agent ? { agent } : {}) })

  it('the vault hook, with a quote in the key path, blocks a Bash call naming the key file with exactly VAULT_GUARD_TEXT', async () => {
    const c = await run(codexVaultHooks({ keyFile, vaultFile, home }), [call(`cat ${keyFile}`), call('echo hello')])
    const [blocked, passed] = c.completed()
    expect(blocked.status).toBe('blocked')
    expect(blocked.entries).toEqual([{ kind: 'feedback', text: VAULT_GUARD_TEXT }])
    expect(passed.status).toBe('completed')
    // The blocked call has no item at all, the other one runs.
    expect(c.items().map((i) => i.command)).toEqual(["/bin/bash -lc 'echo hello'"])
  })

  // A 20 s limit: four processes and a node start per hook, which on a busy Windows (launcher, Git Bash) can pass 5 s.
  it('the pause hook, with a node path holding a space: blocks the main thread while the flag exists, passes a subagent, passes all without the flag', async () => {
    const spaced = join(dir, 'a b')
    mkdirSync(spaced)
    // Without the symlink privilege (Windows), a fake bin that runs node stands in for the link.
    let node = join(spaced, 'node')
    if (symlinksWork) symlinkSync(process.execPath, node)
    else node = writeFakeBin(spaced, 'node', null)
    const hooks = [codexPauseHook({ node, pauseHookEntry: PAUSE_ENTRY, electronNode: false })!]
    expect(hooks[0]).not.toBeNull()
    const flag = join(dir, 'flag')
    writeFileSync(flag, '')
    const paused = await run(hooks, [call('echo main'), call('echo sub', { threadId: 'child-thread' })], { ZUMIBOT_PAUSE_FILE: flag })
    const [main1, sub1] = paused.completed()
    expect(main1.status).toBe('blocked')
    expect(main1.entries).toEqual([{ kind: 'feedback', text: PAUSE_BLOCK_TEXT }])
    expect(sub1.status).toBe('completed')
    expect(paused.items().map((i) => i.command)).toEqual(["/bin/bash -lc 'echo sub'"])
    // No flag file: every call passes, with no node start.
    const free = await run(hooks, [call('echo main')], { ZUMIBOT_PAUSE_FILE: join(dir, 'absent') })
    expect(free.completed().map((r) => r.status)).toEqual(['completed'])
    expect(free.items()).toHaveLength(1)
  }, 20_000)

  it('a pause hook whose node binary crashes (exit 1) blocks: Codex fails open on exit 1, so the command turns it into 2', async () => {
    const bad = join(dir, 'crash-node')
    writeFileSync(bad, '#!/bin/sh\nexit 1\n')
    chmodSync(bad, 0o755)
    const flag = join(dir, 'flag')
    writeFileSync(flag, '')
    const c = await run([codexPauseHook({ node: bad, pauseHookEntry: PAUSE_ENTRY, electronNode: false })!], [call('echo main')], {
      ZUMIBOT_PAUSE_FILE: flag
    })
    expect(c.completed().map((r) => r.status)).toEqual(['blocked'])
    expect(c.items()).toEqual([])
  })
})
