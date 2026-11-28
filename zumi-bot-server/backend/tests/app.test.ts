import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as moderator from '../src/core/chat/moderator'
import { pickArgs } from '../src/core/btw/sidePicker'
import { UsageService } from '../src/core/usage/usageService'
import { SideQuestions } from '../src/core/btw/sideQuestions'
import { MemoryStore } from '../src/core/memory/memoryStore'
import { MemoryTurns } from '../src/core/memory/memoryTurns'
import { buildBriefing } from '../src/core/chat/groupPrompts'
import { HOUSE_STYLE } from '../src/core/chat/houseStyle'
import { capNote } from '@zumibot/shared/memory'
import { TODO_SYSTEM } from '../src/core/todos/todoPrompt'
import { askedSystem } from '../src/core/asks/askPrompt'
import { workflowSystem } from '../src/core/workflows/workflowPrompt'
import { WorkflowRunner } from '../src/core/workflows/workflowRunner'
import { NEEDS_AUTH, startServer } from '../src/app'
import { startSetupServer } from '../src/setupServer'
import { ExtensionsService } from '../src/core/extensions/extensionsService'
import * as desktopProcess from '../src/core/desktop/desktopProcess'
import { DesktopManager } from '../src/core/desktop/desktopManager'
import { loadConfig } from '../src/config'
import { resolveBrowserRuntime } from '../src/core/browser/browserRuntime'
import * as browserRuntime from '../src/core/browser/browserRuntime'
import type { ChatItem, ChatMeta, ChatPush, ItemsPage, WirePush } from '@zumibot/shared/types'
import type { RpcEvent, RpcResponse } from '@zumibot/shared/rpc'
import { stopServer } from './support/stopServer'
import { writeFakeBin } from './support/fakeBin'
import { gitBashPath } from '../src/core/vault/vaultGuard'
import { isArchived } from '@zumibot/shared/archive'
import type { Workflow, WorkflowRun, WorkflowRunSummary } from '@zumibot/shared/workflows'

const SECRET = 'test-secret-'.padEnd(40, 'x')
const backendDir = fileURLToPath(new URL('..', import.meta.url))
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const basic = fileURLToPath(new URL('./fixtures/stream/basic.jsonl', import.meta.url))

let root: string
let claudeBin: string
let dataDir: string
let agentsDir: string
let started: { close(): Promise<void> } | null = null
let lines: string[]
const FAKE_VARS = ['FAKE_STDOUT_FILE', 'FAKE_STDOUT_DIR', 'FAKE_HANG', 'FAKE_ENV_OUT', 'FAKE_ARGS_OUT', 'FAKE_INVOCATIONS_OUT']

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-app-'))
  dataDir = join(root, 'data')
  agentsDir = join(root, 'agents')
  await mkdir(dataDir)
  await mkdir(agentsDir)
  await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\n---\nTest agent.')
  claudeBin = writeFakeBin(root, 'claude', fake)
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ claudePath: claudeBin }))
  // Already switched over: the first-start probe would run the fake claude once more and overwrite the args and env these tests read back.
  await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: {}, migration: 'kept' }))
  process.env['FAKE_STDOUT_FILE'] = basic
  lines = []
})
afterEach(async () => {
  await started?.close()
  started = null
  for (const v of FAKE_VARS) delete process.env[v]
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  // A child that just ended may still hold a file in it for a moment on Windows (ENOTEMPTY, EBUSY).
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

// For a test that seeds a connector on: the start-up name read would run the fake claude once more and overwrite the args and env the
// test reads back. Home reads (agent null) get an empty loadout; agent reads stay real.
const noHomeProbe = (): void => {
  const real = ExtensionsService.prototype.loadout
  vi.spyOn(ExtensionsService.prototype, 'loadout').mockImplementation(function (this: ExtensionsService, folder, agent, refresh) {
    return agent === null
      ? Promise.resolve({
          engine: 'claude',
          version: '2',
          folder,
          agent: null,
          servers: [],
          plugins: [],
          skills: [],
          hooks: [],
          errors: {},
          at: 1
        })
      : real.call(this, folder, agent, refresh)
  })
  // The start-up name reads (switch-over, learn) go through peek.
  vi.spyOn(ExtensionsService.prototype, 'peek').mockImplementation((folder) =>
    Promise.resolve({
      engine: 'claude',
      version: '2',
      folder,
      agent: null,
      servers: [],
      plugins: [],
      skills: [],
      hooks: [],
      errors: {},
      at: 1
    })
  )
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HOME: root,
  ZUMIBOT_MODE: 'local',
  ZUMIBOT_LOCAL_SECRET: SECRET,
  ZUMIBOT_DATA_DIR: dataDir,
  ZUMIBOT_AGENTS_DIR: agentsDir,
  ZUMIBOT_PORT: '0',
  ...extra
})

const boot = async (extra: Record<string, string> = {}) => {
  const s = await startServer(loadConfig(env(extra)), { out: (l) => lines.push(l) })
  started = s
  return s
}

function connect(port: number): Promise<{ ws: WebSocket; call(method: string, ...args: unknown[]): Promise<unknown>; events: RpcEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `cb_local=${SECRET}`, Origin: `http://127.0.0.1:${port}` } })
  const events: RpcEvent[] = []
  const waiting = new Map<number, (r: RpcResponse) => void>()
  let id = 0
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as RpcResponse | RpcEvent
    if ('event' in m) events.push(m)
    else waiting.get(m.id)?.(m)
  })
  return new Promise((resolve, reject) => {
    ws.once('error', reject)
    ws.once('open', () =>
      resolve({
        ws,
        events,
        call: (method, ...args) =>
          new Promise((res, rej) => {
            const n = ++id
            waiting.set(n, (r) => (r.ok ? res(r.value) : rej(new Error(r.error))))
            ws.send(JSON.stringify({ id: n, method, args }))
          })
      })
    )
  })
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// For a change made in the agents folder after boot. macOS starts the folder's FSEvents stream asynchronously and drops
// events from before it runs, so the change can go unseen there. Any later change makes the watcher rescan the whole
// folder, so on macOS a spare file is written now and then, spaced past the watcher's 150 ms debounce.
const untilWatched = async (cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const darwin = process.platform === 'darwin'
  let nudgedAt = Date.now()
  await until(
    async () => {
      if (await cond()) return true
      if (darwin && Date.now() - nudgedAt > 500) {
        nudgedAt = Date.now()
        await writeFile(join(agentsDir, 'nudge.txt'), String(nudgedAt))
      }
      return false
    },
    darwin ? Math.max(ms, 10_000) : ms
  )
}

describe('startServer', () => {
  it('btw busy counts side runs alongside main runs and stop leaves main running', async () => {
    process.env.FAKE_HANG = '1'
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    const main = c.call('chats:send', chat.id, 'main', [])
    const { queryBusy, controlPath } = await import('../src/control')
    await until(async () => (await queryBusy(controlPath(dataDir))) === 1)
    await c.call('btw:ask', chat.id, 'side question', 'side')
    expect(await queryBusy(controlPath(dataDir))).toBe(2)
    await c.call('btw:stop', chat.id, 'side')
    await until(async () => (await queryBusy(controlPath(dataDir))) === 1)
    await c.call('chats:stop', chat.id)
    await main
    c.ws.close()
  })

  it('btw fresh room base matches briefing, style, memory, rules, attachments and browser settings', async () => {
    await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\nmemory: user\n---\nTest agent.')
    await writeFile(join(agentsDir, 'other.md'), '---\nname: other\ndescription: Other agent\n---\nOther agent.')
    const count = vi.spyOn(MemoryStore.prototype, 'count').mockResolvedValue(2)
    const repair = vi.spyOn(MemoryStore.prototype, 'repairIndex')
    const memoryStart = vi.spyOn(MemoryTurns.prototype, 'started')
    process.env.FAKE_ARGS_OUT = join(root, 'side-args.json')
    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '')
    const s = await boot(),
      c = await connect(s.port)
    await c.call('app:setHouseStyle', true)
    const chat = (await c.call('chats:createGroup', ['tester', 'other'], root, 'Review carefully')) as ChatMeta
    const { ChatStore } = await import('../src/core/store/chatStore')
    const store = new ChatStore(dataDir)
    await store.saveItems(chat.id, [
      { type: 'user', id: 'prior', text: 'context', ts: 1, attachments: [{ id: 'file', name: 'note.txt', mime: 'text/plain', size: 4 }] }
    ] as ChatItem[])
    await c.call('btw:ask', chat.id, '@tester Why?', 'side')
    await until(async () => {
      try {
        await stat(join(root, 'side-args.json'))
        return true
      } catch {
        return false
      }
    })
    const args = JSON.parse(await readFile(join(root, 'side-args.json'), 'utf8')) as string[]
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    const briefing = buildBriefing(
      'tester',
      [
        { name: 'tester', description: 'Test agent' },
        { name: 'other', description: 'Other agent' }
      ],
      root,
      'Review carefully'
    )
    expect(prompt.startsWith([briefing, HOUSE_STYLE, capNote(2, 100)].join('\n\n'))).toBe(true)
    expect(prompt).toContain(`${capNote(2, 100)}\n\n${TODO_SYSTEM}`) // a fresh base has the main run's to-do paragraph too
    expect(args).toContain('Agent(other)')
    expect(args).toContain('--add-dir')
    expect(args).toContain(join(dataDir, 'attachments', chat.id))
    expect(args).toContain('--mcp-config')
    expect(args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))).toContain('zumibot_todos')
    expect(args).toContain('--no-session-persistence')
    expect(count).toHaveBeenCalledWith('tester')
    expect(repair).not.toHaveBeenCalled()
    expect(memoryStart).not.toHaveBeenCalled()
    c.ws.close()
  })

  it.each(['save', 'watcher'])('btw %s rename keeps a running entry under the new name', async (path) => {
    process.env.FAKE_HANG = '1'
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('btw:ask', chat.id, 'Why?', 'side')
    // Rename only once the side run is up: one still starting checks its agent on disk and would find it gone.
    await until(async () => (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')).includes('--no-session-persistence'))
    const raw = '---\nname: renamed\ndescription: Test agent\n---\nTest agent.'
    if (path === 'save') await c.call('agents:save', join(agentsDir, 'tester.md'), raw)
    else {
      await writeFile(join(agentsDir, 'tester.md'), raw)
      await untilWatched(async () => ((await c.call('chats:list')) as ChatMeta[]).some((m) => m.id === chat.id && m.agentName === 'renamed'))
    }
    await c.call('btw:stop', chat.id, 'side')
    await until(async () => ((await c.call('btw:list', chat.id)) as { agent: string; state: string }[])[0]?.state === 'stopped')
    expect(await c.call('btw:list', chat.id)).toMatchObject([{ agent: 'renamed', state: 'stopped' }])
    c.ws.close()
  })

  it('btw room picker uses its JSON prompt and moderator cost recording', async () => {
    await writeFile(join(agentsDir, 'other.md'), '---\nname: other\ndescription: Other agent\n---\nOther agent.')
    const record = vi.spyOn(UsageService.prototype, 'recordModerator').mockImplementation(() => {})
    const json = vi.spyOn(moderator, 'runJsonCall').mockImplementation(async (o) => {
      expect(o.args).toEqual(pickArgs())
      expect(o.stdin).toContain('Side question:\nWho knows?')
      expect(o.env?.PATH).toBeTruthy()
      expect(o.cwd).toBe(root)
      expect(o.signal).toBeInstanceOf(AbortSignal)
      expect(o.parse('{"structured_output":{"member":"tester"}}')).toBe('tester')
      o.onCost?.({ totalUsd: 0.001 } as never, 'pick-cost')
      return 'tester' as never
    })
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:createGroup', ['tester', 'other'], root, '')) as ChatMeta
    await c.call('btw:ask', chat.id, 'Who knows?', 'side')
    await until(() => json.mock.calls.length > 0)
    expect(record).toHaveBeenCalledWith(chat.id, { totalUsd: 0.001 }, 'pick-cost', expect.any(Number))
    await until(async () => c.events.some((e) => e.event === 'btw:changed' && e.payload.entry.agent === 'tester'))
    c.ws.close()
  })

  it('btw shutdown cleans main runs and the lock when side persistence fails', async () => {
    process.env.FAKE_HANG = '1'
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    void c.call('chats:send', chat.id, 'main', []).catch(() => {})
    await until(async () => ((await c.call('chats:list')) as ChatMeta[]).some((m) => m.id === chat.id && m.inFlight))
    const stop = vi.spyOn(SideQuestions.prototype, 'stopAll').mockRejectedValue(new Error('disk unavailable'))
    await s.close()
    expect(stop).toHaveBeenCalled()
    expect((JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')) as { chats: ChatMeta[] }).chats[0].inFlight).toBe(false)
    await expect(stat(join(dataDir, 'server.lock'))).rejects.toThrow()
    c.ws.close()
  })

  it('browser socket authenticates through the real app and closes 1001 without starting a watch', async () => {
    const s = await boot()
    const browser = new WebSocket(`ws://127.0.0.1:${s.port}/ws/browser`, { headers: { Cookie: `cb_local=${SECRET}`, Origin: s.origin } })
    await new Promise<void>((resolve, reject) => {
      browser.once('open', resolve)
      browser.once('error', reject)
    })
    const closed = new Promise<number>((resolve) => browser.once('close', resolve))
    await s.close()
    expect(await closed).toBe(1001)
  })

  it('desktop socket authenticates through the real app, refuses a hostile Origin and closes 1001 without starting a desktop', async () => {
    const s = await boot()
    const hostile = new WebSocket(`ws://127.0.0.1:${s.port}/ws/desktop`, {
      headers: { Cookie: `cb_local=${SECRET}`, Origin: 'http://evil.test' }
    })
    expect(await new Promise<number>((resolve) => hostile.once('close', resolve))).toBe(4401)
    const desktop = new WebSocket(`ws://127.0.0.1:${s.port}/ws/desktop`, { headers: { Cookie: `cb_local=${SECRET}`, Origin: s.origin } })
    await new Promise<void>((resolve, reject) => {
      desktop.once('open', resolve)
      desktop.once('error', reject)
    })
    const messages: unknown[] = []
    desktop.on('message', (data) => messages.push(JSON.parse(String(data))))
    desktop.send(JSON.stringify({ id: 1, op: 'unwatch' }))
    await until(async () => messages.length > 0)
    expect(messages).toEqual([{ type: 'response', id: 1, ok: true, value: null }])
    const closed = new Promise<number>((resolve) => desktop.once('close', resolve))
    await s.close()
    expect(await closed).toBe(1001)
    await expect(stat(join(dataDir, 'desktops', 'profiles.json'))).rejects.toThrow()
  })

  it('browser startup reconciliation preserves malformed-file mappings until deletion, then recreates a fresh profile', async () => {
    const profileId = randomUUID()
    await mkdir(join(dataDir, 'browsers', profileId), { recursive: true })
    await writeFile(join(dataDir, 'browsers', 'profiles.json'), JSON.stringify({ version: 1, profiles: { canonical: profileId } }))
    const bad = join(agentsDir, 'mismatched.md')
    await writeFile(bad, 'malformed frontmatter')
    const s = await boot(),
      c = await connect(s.port)
    const mapping = async () =>
      JSON.parse(await readFile(join(dataDir, 'browsers', 'profiles.json'), 'utf8')) as { profiles: Record<string, string> }
    expect((await mapping()).profiles.canonical).toBe(profileId)
    await rm(bad)
    await untilWatched(async () => (await mapping()).profiles.canonical === undefined)
    await writeFile(join(agentsDir, 'canonical.md'), '---\nname: canonical\ndescription: Test agent\n---\nTest agent.')
    expect(((await c.call('browsers:status', 'canonical')) as { profileId: string }).profileId).not.toBe(profileId)
    expect((await stat(join(dataDir, 'browsers', profileId))).isDirectory()).toBe(true)
    c.ws.close()
  })

  it('browser profile identity survives app save rename and the following watcher removal pass', async () => {
    const s = await boot(),
      c = await connect(s.port)
    const original = (await c.call('browsers:status', 'tester')) as { profileId: string }
    await c.call('agents:save', join(agentsDir, 'tester.md'), '---\nname: renamed\ndescription: Test agent\n---\nTest agent.')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await c.call('browsers:status', 'renamed')).toMatchObject({ profileId: original.profileId, agent: 'renamed' })
    await expect(c.call('browsers:status', 'tester')).rejects.toThrow()
    c.ws.close()
  })

  const apiKey = (agents: string[]) => ({
    kind: 'apiKey',
    name: 'PAT',
    agents,
    env: 'AZURE_PAT',
    value: 'sk-test-12345678',
    description: ''
  })

  it('vault grants follow an agent rename, and each change is broadcast', async () => {
    const s = await boot(),
      c = await connect(s.port)
    expect(await c.call('vault:status')).toBe('empty')
    const saved = (await c.call('vault:save', apiKey(['tester']))) as { id: string }
    await until(() => c.events.some((e) => e.event === 'vault:changed'))
    // The key lands in the test's own HOME, never the real one.
    expect((await stat(join(root, '.config', 'zumibot-vault', 'vault.key'))).isFile()).toBe(true)
    await c.call('agents:save', join(agentsDir, 'tester.md'), '---\nname: renamed\ndescription: Test agent\n---\nTest agent.')
    expect(await c.call('vault:list')).toMatchObject([{ id: saved.id, agents: ['renamed'] }])
    // The watcher's following removal pass must not drop what was just moved.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await c.call('vault:list')).toMatchObject([{ id: saved.id, agents: ['renamed'] }])
    c.ws.close()
  })

  it('vault grants follow an agent rename made outside the app', async () => {
    const s = await boot(),
      c = await connect(s.port)
    await c.call('vault:save', apiKey(['tester']))
    await writeFile(join(agentsDir, 'tester.md'), '---\nname: renamed\ndescription: Test agent\n---\nTest agent.')
    await untilWatched(async () => ((await c.call('vault:list')) as { agents: string[] }[])[0]?.agents[0] === 'renamed', 3000)
    c.ws.close()
  })

  it('vault grants of an agent whose file was deleted are dropped by the folder watcher', async () => {
    const s = await boot(),
      c = await connect(s.port)
    await c.call('vault:save', apiKey(['tester']))
    await rm(join(agentsDir, 'tester.md'))
    await untilWatched(async () => ((await c.call('vault:list')) as { agents: string[] }[])[0]?.agents.length === 0, 3000)
    c.ws.close()
  })

  it('browser startup rollback stops resumed turns, closes the listener, and releases the data lock', async () => {
    process.env.FAKE_HANG = '1'
    const meta = {
      id: 'queued',
      agentName: 'tester',
      title: 'Queued',
      cwd: root,
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      tasks: [{ id: 'task', text: 'hello', ts: 1 }]
    }
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
    await expect(
      startServer(loadConfig(env()), {
        out: () => {
          throw new Error('Synthetic startup failure')
        }
      })
    ).rejects.toThrow('Synthetic startup failure')
    await expect(stat(join(dataDir, 'server.lock'))).rejects.toThrow()
    const persisted = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')) as { chats: ChatMeta[] }
    expect(persisted.chats[0].inFlight).toBe(false)
  })
  it('browser text turns merge scoped env with PATH, exclude app secrets, and do not launch missing Chromium', async () => {
    vi.stubEnv('ZUMIBOT_BROWSER_EXECUTABLE_PATH', join(root, 'absent-chrome'))
    vi.stubEnv('ZUMIBOT_LOCAL_SECRET', SECRET)
    process.env.FAKE_ENV_OUT = join(root, 'turn-env.json')
    process.env.FAKE_ARGS_OUT = join(root, 'turn-args.json')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    const childEnv = JSON.parse(await readFile(join(root, 'turn-env.json'), 'utf8')) as NodeJS.ProcessEnv
    const args = JSON.parse(await readFile(join(root, 'turn-args.json'), 'utf8')) as string[]
    expect(Boolean(childEnv.PATH)).toBe(true)
    expect(Boolean(childEnv.ZUMIBOT_BROWSER_CAPABILITY)).toBe(true)
    expect(Boolean(childEnv.ZUMIBOT_BROWSER_IPC)).toBe(true)
    expect(childEnv.ZUMIBOT_LOCAL_SECRET).toBeUndefined()
    expect(args).toContain('--no-chrome')
    expect(args).toContain('--mcp-config')
    expect(await c.call('browsers:status', 'tester')).toMatchObject({ state: 'stopped', tabs: [] })
    await expect(c.call('browsers:status', 'missing')).rejects.toThrow()
    await expect(c.call('browsers:clear', 'missing')).rejects.toThrow()
    c.ws.close()
  })

  it('a single-chat turn gets the ask tool and a sorted roster of the other loadable agents', async () => {
    await writeFile(join(agentsDir, 'zed.md'), '---\nname: zed\ndescription: Last one\n---\nZed.')
    await writeFile(join(agentsDir, 'abe.md'), '---\nname: abe\ndescription: First one\n---\nAbe.')
    await writeFile(join(agentsDir, 'bad.md'), '---\nname: bad\ndescription: [oops\n---\nBad.')
    process.env.FAKE_ARGS_OUT = join(root, 'turn-args.json')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    const args = JSON.parse(await readFile(join(root, 'turn-args.json'), 'utf8')) as string[]
    const servers = args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))
    expect(servers).toContain('zumibot_agents')
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    const roster = prompt.split('\n').filter((l) => l.startsWith('- @'))
    expect(roster).toEqual(['- @abe: First one', '- @zed: Last one'])
    c.ws.close()
  })

  it('a fresh single-chat side base joins the ask bridge and ends its prompt with the roster, as a main run does', async () => {
    await writeFile(join(agentsDir, 'zed.md'), '---\nname: zed\ndescription: Last one\n---\nZed.')
    await writeFile(join(agentsDir, 'abe.md'), '---\nname: abe\ndescription: First one\n---\nAbe.')
    process.env.FAKE_ARGS_OUT = join(root, 'side-args.json')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('btw:ask', chat.id, 'Why?', 'side')
    await until(async () => {
      try {
        await stat(join(root, 'side-args.json'))
        return true
      } catch {
        return false
      }
    })
    const args = JSON.parse(await readFile(join(root, 'side-args.json'), 'utf8')) as string[]
    const servers = args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))
    expect(servers).toContain('zumibot_agents')
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(prompt.split('\n').filter((l) => l.startsWith('- @'))).toEqual(['- @abe: First one', '- @zed: Last one'])
    expect(prompt.indexOf(TODO_SYSTEM)).toBeGreaterThanOrEqual(0)
    expect(prompt.indexOf('- @abe')).toBeGreaterThan(prompt.indexOf(TODO_SYSTEM))
    expect(prompt).not.toContain(askedSystem('tester', 'New chat').split('\n')[0])
    c.ws.close()
  })

  it("only Zumi Bot's runs get the automation tools: its turn with the delete ask rules in its one --settings, its side run without them", async () => {
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const bot = (await c.call('chats:create', 'zumi-bot', agentsDir)) as ChatMeta
    await c.call('chats:send', bot.id, 'hello', [])
    const other = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', other.id, 'hello', [])
    await c.call('btw:ask', bot.id, 'Why?', 'side')
    const runs = async () =>
      (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((x) => (JSON.parse(x) as { args: string[] }).args)
        // Agent runs only: the ack call (acknowledge.ts) is a claude call of its own, with no --agent.
        .filter((a) => a.includes('--agent'))
    await until(async () => (await runs()).length >= 3)
    const servers = (args: string[]) =>
      args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))
    const asks = (args: string[]) =>
      args.flatMap((a, i) =>
        args[i - 1] === '--settings' ? ((JSON.parse(a) as { permissions?: { ask?: string[] } }).permissions?.ask ?? []) : []
      )
    const all = await runs()
    const of = (agent: string, side: boolean) =>
      all.find((a) => a[a.indexOf('--agent') + 1] === agent && a.includes('--no-session-persistence') === side)!
    const botTurn = of('zumi-bot', false),
      botSide = of('zumi-bot', true),
      testerTurn = of('tester', false)
    expect(servers(botTurn)).toEqual(['zumibot_browser', 'zumibot_todos', 'zumibot_vault', 'zumibot_automations', 'zumibot_processes'])
    expect(botTurn.filter((a) => a === '--settings')).toHaveLength(1)
    expect(asks(botTurn)).toEqual([
      'mcp__zumibot_automations__routine_delete',
      'mcp__zumibot_automations__workflow_delete',
      'mcp__zumibot_processes__start'
    ])
    // The side run's tool definitions match; its settings are the side guard's alone.
    expect(servers(botSide)).toEqual(servers(botTurn))
    expect(asks(botSide)).toEqual([])
    expect(servers(testerTurn)).not.toContain('zumibot_automations')
    // Every main run asks before a process start, whatever its mode.
    expect(asks(testerTurn)).toEqual(['mcp__zumibot_processes__start'])
    c.ws.close()
  })

  it("every main run's one --settings denies the file tools on connectors.json and every connector its agent has not switched on", async () => {
    await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: { tester: ['slack'] }, migration: 'kept' }))
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const bot = (await c.call('chats:create', 'zumi-bot', agentsDir)) as ChatMeta
    const tester = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', bot.id, 'hello', [])
    await c.call('chats:send', tester.id, 'hello', [])
    const runs = async () =>
      (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((x) => (JSON.parse(x) as { args: string[] }).args)
    await until(async () => (await runs()).length >= 2)
    type Settings = { permissions?: { deny?: string[] }; deniedMcpServers?: Array<{ serverUrl?: string }> }
    const settings = (args: string[]): Settings => JSON.parse(args[args.indexOf('--settings') + 1]) as Settings
    const all = await runs()
    const of = (agent: string) => all.find((a) => a[a.indexOf('--agent') + 1] === agent)!
    // The CLI's //absolute form; on Windows that is the POSIX spelling of the drive path (`/c/...`).
    const file = process.platform === 'win32' ? gitBashPath(join(dataDir, 'connectors.json')) : join(dataDir, 'connectors.json')
    for (const agent of ['zumi-bot', 'tester']) {
      const { permissions } = settings(of(agent))
      expect(permissions?.deny).toContain(`Read(/${file})`)
      expect(permissions?.deny).toContain(`Write(/${file})`)
    }
    const urls = (agent: string) =>
      (settings(of(agent)).deniedMcpServers ?? [])
        .map((d) => d.serverUrl)
        .filter(Boolean)
        .join('\n')
    expect(urls('zumi-bot')).toContain('slack')
    expect(urls('tester')).not.toContain('slack')
    expect(urls('tester')).toContain('notion')
    c.ws.close()
  })

  it('a run that starts before the start-up name read finishes still gets the ask rule for a renamed connector', async () => {
    await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: { tester: ['github'] }, migration: 'kept' }))
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    // The home read is slow and names the user's GitHub connector (GitHub has no catalog name, so only a read can teach it).
    // The start-up read is a peek (it leaves nothing in the loadout cache).
    vi.spyOn(ExtensionsService.prototype, 'peek').mockImplementation(function (this: ExtensionsService, folder) {
      const server = {
        name: 'My GitHub',
        status: 'connected',
        source: 'claude-ai',
        transport: 'claudeai-proxy',
        plugin: null,
        tools: [],
        scope: null,
        note: null,
        connector: 'github'
      }
      return new Promise((r) =>
        setTimeout(
          () =>
            r({
              engine: 'claude',
              version: '2',
              folder,
              agent: null,
              servers: [server],
              plugins: [],
              skills: [],
              hooks: [],
              errors: {},
              at: 1
            } as never),
          2500
        )
      )
    })
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    await until(async () => (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')).includes('--agent'))
    const run = (await readFile(join(root, 'invocations.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((x) => (JSON.parse(x) as { args: string[] }).args)
      .find((a) => a[a.indexOf('--agent') + 1] === 'tester')!
    const settings = JSON.parse(run[run.indexOf('--settings') + 1]) as { permissions?: { ask?: string[] } }
    expect(settings.permissions?.ask).toContain('mcp__My_GitHub__*')
    c.ws.close()
  })

  it('a fresh side base denies every connector its agent has not switched on, by URL and by the belt, like its main run', async () => {
    await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: { tester: ['slack'] }, migration: 'kept' }))
    noHomeProbe()
    process.env.FAKE_ARGS_OUT = join(root, 'side-args.json')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('btw:ask', chat.id, 'Why?', 'side')
    await until(async () => {
      try {
        await stat(join(root, 'side-args.json'))
        return true
      } catch {
        return false
      }
    })
    const args = JSON.parse(await readFile(join(root, 'side-args.json'), 'utf8')) as string[]
    expect(args).toContain('--no-session-persistence')
    type Settings = { deniedMcpServers?: Array<{ serverUrl?: string }> }
    const denied = args.flatMap((a, i) => (args[i - 1] === '--settings' ? ((JSON.parse(a) as Settings).deniedMcpServers ?? []) : []))
    const urls = denied
      .map((d) => d.serverUrl)
      .filter(Boolean)
      .join('\n')
    expect(urls).toContain('notion')
    expect(urls).toContain('gmail')
    expect(urls).not.toContain('slack')
    // The belt: a deny rule per connector name's tool prefix, here Notion's and not the switched-on Slack's.
    const belt = args.slice(args.indexOf('--disallowedTools') + 1)
    expect(belt.join(' ')).toContain('mcp__claude_ai_Notion')
    expect(belt.join(' ')).not.toContain('mcp__claude_ai_Slack')
    c.ws.close()
  })

  it('a close while the first start is still switching over leaves no connectors.json, so the next start switches over', async () => {
    await rm(join(dataDir, 'connectors.json'))
    // The fake claude never answers the switch-over's probe (it takes the first control request for the turn's message and hangs), so the
    // switch-over is provably still running once the probe's CLI has started; the close must end it without a write.
    process.env.FAKE_HANG = '1'
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot()
    await until(async () => (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')).includes('--input-format'))
    expect(await readFile(join(dataDir, 'connectors.json'), 'utf8').catch(() => null)).toBeNull()
    await s.close()
    started = null
    expect(await readFile(join(dataDir, 'connectors.json'), 'utf8').catch(() => null)).toBeNull()
  })

  it('the first start without a connectors.json runs the switch-over once and keeps the file', async () => {
    await rm(join(dataDir, 'connectors.json'))
    const s = await boot(),
      c = await connect(s.port)
    await until(async () => (await readFile(join(dataDir, 'connectors.json'), 'utf8').catch(() => '')) !== '')
    const stored = JSON.parse(await readFile(join(dataDir, 'connectors.json'), 'utf8')) as { v: number; migration: string }
    expect(stored.v).toBe(1)
    expect(['kept', 'failed']).toContain(stored.migration)
    c.ws.close()
  })

  describe('with an ask bridge built from this source', () => {
    // The ask bridge is a built file: a server run from source starts it from backend/dist, which only `npm run build:server`
    // makes, so on a fresh checkout its MCP server exited and no side run ever came. Built here, from this source, never stale.
    let bridgeDir: string
    beforeAll(async () => {
      bridgeDir = await mkdtemp(join(tmpdir(), 'cb-ask-bridge-'))
      await build({ root: backendDir, logLevel: 'silent', build: { outDir: bridgeDir, emptyOutDir: true } })
    }, 60_000)
    afterAll(() => rm(bridgeDir, { recursive: true, force: true }))

    it("a fresh side base for an A to B chat carries the asked paragraph first, as its main run does, and the chat's effort; a normal chat does not", async () => {
      await writeFile(join(agentsDir, 'abe.md'), '---\nname: abe\ndescription: First one\n---\nAbe.')
      const scripts = join(root, 'scripts')
      await mkdir(scripts)
      const l = (o: object) => JSON.stringify(o)
      const say = (sid: string, text: string) => [
        l({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5', permissionMode: 'default' }),
        l({
          type: 'assistant',
          message: {
            model: 'claude-haiku-5-5',
            id: `msg_${sid}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            stop_reason: null,
            usage: { input_tokens: 2, output_tokens: 2 }
          },
          parent_tool_use_id: null,
          session_id: sid,
          uuid: randomUUID()
        }),
        l({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, uuid: randomUUID() })
      ]
      const call = `#MCP_CALL ${l({ server: 'zumibot_agents', tool: 'side_question', args: { agent: 'abe', question: 'Why?' }, id: 'toolu_side' })}`
      const sidA = '0a1b2c3d-4e5f-4a60-8172-93a4b5c6d7e8'
      await writeFile(
        join(scripts, 'tester.jsonl'),
        [l({ type: 'system', subtype: 'init', session_id: sidA }), call, ...say(sidA, 'Done').slice(1)].join('\n') + '\n'
      )
      await writeFile(join(scripts, 'abe.side.jsonl'), say('1b2c3d4e-5f60-4b71-8283-a4b5c6d7e8f9', 'Because').join('\n') + '\n')
      const fromId = 'a0000000-0000-4000-8000-000000000001',
        askedId = 'a0000000-0000-4000-8000-000000000002'
      const meta = (id: string, agentName: string, extra: object = {}) => ({
        id,
        agentName,
        sessionId: null,
        cwd: root,
        title: 'Plan',
        createdAt: 1,
        updatedAt: 1,
        inFlight: false,
        ...extra
      })
      await writeFile(
        join(dataDir, 'chats.json'),
        JSON.stringify({
          chats: [
            meta(fromId, 'tester'),
            meta(askedId, 'abe', { effort: 'high', asked: { by: 'tester', from: fromId, fromTitle: 'Plan', chain: [] } })
          ]
        })
      )
      process.env.FAKE_STDOUT_DIR = scripts
      process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
      vi.stubEnv('FAKE_MCP_RESULTS_OUT', join(root, 'mcp-results.jsonl'))
      const real = browserRuntime.resolveBrowserRuntime
      vi.spyOn(browserRuntime, 'resolveBrowserRuntime').mockImplementation((o) => ({
        ...real(o),
        askBridgeEntry: join(bridgeDir, 'askBridge.mjs')
      }))
      const s = await boot(),
        c = await connect(s.port)
      await c.call('chats:send', fromId, 'go', [])
      // The turn ends only after its side ask has, so a broken bridge fails here with the tool's error, not as a wait that times out.
      const results = (await readFile(join(root, 'mcp-results.jsonl'), 'utf8')).split('\n').filter(Boolean)
      expect(results.map((x) => JSON.parse(x) as object)).toEqual([
        expect.objectContaining({ id: 'toolu_side', text: 'Because', isError: false })
      ])
      const runs = async () =>
        (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((x) => (JSON.parse(x) as { args: string[] }).args)
          // Agent runs only: the ack call (acknowledge.ts) is a claude call of its own, with no --agent.
          .filter((a) => a.includes('--agent'))
      await until(async () => (await runs()).some((a) => a.includes('--no-session-persistence')))
      const side = (await runs()).find((a) => a.includes('--no-session-persistence'))!
      expect(side[side.indexOf('--agent') + 1]).toBe('abe')
      expect(side[side.indexOf('--effort') + 1]).toBe('high')
      const prompt = side[side.indexOf('--append-system-prompt') + 1]
      const asked = askedSystem('tester', 'Plan')
      expect(prompt.startsWith(asked)).toBe(true)
      expect(prompt.indexOf(TODO_SYSTEM)).toBeGreaterThan(asked.length)
      c.ws.close()
    })
  })

  it("a Codex agent's fresh side base forks its last turn on Codex, ephemeral, read-only and asking first, and declines what it asks", async () => {
    await writeFile(
      join(agentsDir, 'cx.md'),
      '---\nname: cx\ndescription: Codex agent\nprovider: codex\nmodel: gpt-fake\n---\nYou are the Codex test agent.'
    )
    const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
    const codexBin = writeFakeBin(root, 'codex', fakeCodex)
    const home = join(root, 'codex-home'),
      log = join(root, 'codex-log.jsonl'),
      answers = join(root, 'codex-answers.jsonl'),
      script = join(root, 'codex-script.jsonl')
    await mkdir(home)
    await writeFile(script, '')
    vi.stubEnv('ZUMIBOT_CODEX_BIN', codexBin)
    for (const [k, v] of [
      ['FAKE_CODEX_HOME', home],
      ['FAKE_CODEX_LOG', log],
      ['FAKE_CODEX_ANSWERS', answers],
      ['FAKE_CODEX_SCRIPT', script]
    ])
      vi.stubEnv(k, v)
    const lines = async (file: string) =>
      (await readFile(file, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown>; result?: unknown })
    let s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'cx', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    const ended = async () => ((await c.call('chats:items', chat.id)) as ItemsPage).items.find((i) => i.end?.engine === 'codex')?.end
    await until(async () => (await ended()) !== undefined)
    const end = (await ended())!
    // A new server has no side base from a main run: this one is built fresh, by baseFor.
    c.ws.close()
    await started!.close()
    started = null
    s = await boot()
    c = await connect(s.port)
    await writeFile(
      script,
      [
        {
          request: {
            method: 'item/commandExecution/requestApproval',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'e1', command: 'touch side-marker', cwd: root, reason: null }
          }
        },
        {
          notify: {
            method: 'item/completed',
            params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'Side answer' } }
          }
        }
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n'
    )
    await c.call('btw:ask', chat.id, 'Why?', 'side')
    await until(async () => ((await c.call('btw:list', chat.id)) as { state: string }[])[0]?.state === 'done')
    expect(((await c.call('btw:list', chat.id)) as { answer: string }[])[0].answer).toBe('Side answer')
    const fork = (await lines(log)).find((l) => l.method === 'thread/fork')!.params!
    expect(fork).toMatchObject({
      threadId: end.session,
      lastTurnId: end.at,
      ephemeral: true,
      excludeTurns: true,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      model: 'gpt-fake'
    })
    const instructions = fork.baseInstructions as string
    expect(instructions.startsWith('You are the Codex test agent.')).toBe(true)
    expect(instructions.indexOf(TODO_SYSTEM)).toBeGreaterThan(0)
    expect(Object.keys(fork.config as object)).toEqual(
      expect.arrayContaining(['mcp_servers.zumibot_todos', 'mcp_servers.zumibot_vault', 'mcp_servers.zumibot_agents'])
    )
    // The command was declined, and nothing of the side answer reached the chat: no card, no approval item.
    expect(await lines(answers)).toEqual([expect.objectContaining({ result: { decision: 'decline' } })])
    expect(existsSync(join(root, 'side-marker'))).toBe(false)
    expect(((await c.call('chats:items', chat.id)) as ItemsPage).items.map((i) => i.type)).toEqual(['user'])
    c.ws.close()
  })

  it('a Codex side run gets the same instructions from the base its main run kept and from a fresh baseFor (the two builders agree)', async () => {
    await writeFile(
      join(agentsDir, 'cx.md'),
      '---\nname: cx\ndescription: Codex agent\nprovider: codex\nmodel: gpt-fake\n---\nYou are the Codex test agent.'
    )
    await writeFile(join(agentsDir, 'abe.md'), '---\nname: abe\ndescription: Another agent, for the ask roster\n---\nAbe.')
    const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
    const codexBin = writeFakeBin(root, 'codex', fakeCodex)
    const home = join(root, 'codex-home'),
      log = join(root, 'codex-log.jsonl')
    await mkdir(home)
    vi.stubEnv('ZUMIBOT_CODEX_BIN', codexBin)
    vi.stubEnv('FAKE_CODEX_HOME', home)
    vi.stubEnv('FAKE_CODEX_LOG', log)
    const lines = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })
    let s = await boot(),
      c = await connect(s.port)
    await c.call('app:setHouseStyle', true)
    const chat = (await c.call('chats:create', 'cx', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    const done = async (n: number) =>
      ((await c.call('btw:list', chat.id)) as { state: string }[]).filter((e) => e.state === 'done').length >= n
    await until(async () => ((await c.call('chats:items', chat.id)) as ItemsPage).items.some((i) => i.end?.engine === 'codex'))
    // The base the main run kept.
    await c.call('btw:ask', chat.id, 'Kept?', 'kept')
    await until(() => done(1))
    c.ws.close()
    await started!.close()
    started = null
    // A new server has none: baseFor builds it.
    s = await boot()
    c = await connect(s.port)
    await c.call('btw:ask', chat.id, 'Fresh?', 'fresh')
    await until(() => done(2))
    const all = await lines()
    const main = all.find((l) => l.method === 'thread/start')!.params!.baseInstructions as string
    const forks = all.filter((l) => l.method === 'thread/fork').map((l) => l.params!.baseInstructions as string)
    expect(forks).toHaveLength(2)
    expect(forks[1]).toBe(forks[0])
    // And both are what the main thread got (the side turn's browser prompt is the main run's).
    expect(forks[0]).toBe(main)
    expect(main.startsWith('You are the Codex test agent.')).toBe(true)
    expect(main).toContain(TODO_SYSTEM)
    expect(main).toContain('@abe')
    c.ws.close()
  })

  it("a room's Codex member runs over fake-codex with the room briefing while the moderator stays on claude; its side questions and Compact run on codex", async () => {
    await writeFile(
      join(agentsDir, 'cx.md'),
      '---\nname: cx\ndescription: Codex agent\nprovider: codex\nmodel: gpt-fake\n---\nYou are the Codex test agent.'
    )
    const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
    const codexBin = writeFakeBin(root, 'codex', fakeCodex)
    const home = join(root, 'codex-home'),
      log = join(root, 'codex-log.jsonl'),
      script = join(root, 'codex-script.jsonl')
    await mkdir(home)
    // Every codex turn (the member's and its side answers) says something, so the member's turn leaves a reply and its end stamp.
    await writeFile(
      script,
      JSON.stringify({
        notify: {
          method: 'item/completed',
          params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'cx says hi' } }
        }
      }) + '\n'
    )
    vi.stubEnv('ZUMIBOT_CODEX_BIN', codexBin)
    vi.stubEnv('FAKE_CODEX_HOME', home)
    vi.stubEnv('FAKE_CODEX_LOG', log)
    vi.stubEnv('FAKE_CODEX_SCRIPT', script)
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const lines = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })
    let s = await boot(),
      c = await connect(s.port)
    const room = (await c.call('chats:createGroup', ['tester', 'cx'], root, 'Ship it')) as ChatMeta
    await c.call('chats:send', room.id, '@cx hello', [])
    const cxEnd = async () =>
      ((await c.call('chats:items', room.id)) as ItemsPage).items.find((i) => i.end?.engine === 'codex' && i.end.agent === 'cx')?.end
    await until(async () => (await cxEnd()) !== undefined, 15_000)
    await until(async () => !((await c.call('chats:list')) as ChatMeta[]).find((m) => m.id === room.id)?.inFlight, 15_000)
    const main = (await lines()).find((l) => l.method === 'thread/start')!.params!.baseInstructions as string
    const briefing = buildBriefing(
      'cx',
      [
        { name: 'tester', description: 'Test agent' },
        { name: 'cx', description: 'Codex agent' }
      ],
      root,
      'Ship it'
    )
    expect(main.startsWith(['You are the Codex test agent.', briefing].join('\n\n'))).toBe(true)
    expect(main).toContain(TODO_SYSTEM)
    const meta = ((await c.call('chats:list')) as ChatMeta[]).find((m) => m.id === room.id)!
    expect(meta.group?.sessions.cx).toBe((await cxEnd())!.session)
    expect(meta.group?.sessionEngines).toEqual({ cx: 'codex' })
    // The moderator is a claude call (the fake claude's, with its JSON schema); codex only ever ran cx's one turn.
    const invocations = (await readFile(join(root, 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] })
    expect(invocations.filter((i) => i.args.includes('--json-schema') && !i.args.includes('--agent')).length).toBeGreaterThan(0)
    expect(invocations.some((i) => i.args.includes('--agent') && i.args.includes('cx'))).toBe(false)
    expect((await lines()).filter((l) => l.method === 'turn/start')).toHaveLength(1)
    // A side question to cx: from the base its main run kept, then (after a restart) from a fresh baseFor; both are the main thread's instructions.
    const done = async (n: number) =>
      ((await c.call('btw:list', room.id)) as { state: string; agent: string }[]).filter((e) => e.state === 'done' && e.agent === 'cx')
        .length >= n
    await c.call('btw:ask', room.id, '@cx Kept?', 'kept')
    await until(() => done(1), 15_000)
    c.ws.close()
    await started!.close()
    started = null
    s = await boot()
    c = await connect(s.port)
    await c.call('btw:ask', room.id, '@cx Fresh?', 'fresh')
    await until(() => done(2), 15_000)
    const forks = (await lines()).filter((l) => l.method === 'thread/fork')
    expect(forks).toHaveLength(2)
    expect(forks.map((l) => l.params!.threadId)).toEqual([meta.group?.sessions.cx, meta.group?.sessions.cx])
    expect(forks[1].params!.baseInstructions).toBe(forks[0].params!.baseInstructions)
    expect(forks[0].params!.baseInstructions).toBe(main)
    // Compact on cx compacts its thread on codex.
    await c.call('chats:compact', room.id, '', 'cx')
    await until(async () => (await lines()).some((l) => l.method === 'thread/compact/start'), 15_000)
    expect((await lines()).find((l) => l.method === 'thread/compact/start')!.params!.threadId).toBe(meta.group?.sessions.cx)
    c.ws.close()
  }, 60_000)

  it('a fresh side base of a workflow step chat or a step test chat starts its prompt with the workflow paragraph, as its main run does', async () => {
    const meta = (id: string, extra: object) => ({
      id,
      agentName: 'tester',
      sessionId: null,
      cwd: root,
      title: 'Flow · Ask',
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      ...extra
    })
    await writeFile(
      join(dataDir, 'chats.json'),
      JSON.stringify({
        chats: [
          meta('wf', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 'a', name: 'Flow' } }),
          meta('wt', { workflowTest: 'Flow test' })
        ]
      })
    )
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const sides = async () =>
      (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((x) => (JSON.parse(x) as { args: string[] }).args)
        .filter((a) => a.includes('--no-session-persistence'))
    for (const [id, name] of [
      ['wf', 'Flow'],
      ['wt', 'Flow test']
    ] as const) {
      const before = (await sides()).length
      await c.call('btw:ask', id, 'Why?', `side-${id}`)
      await until(async () => (await sides()).length > before)
      const args = (await sides()).at(-1)!
      const prompt = args[args.indexOf('--append-system-prompt') + 1]
      // First, in agentTurn's order: the side run shares the main run's cache prefix and its material rule.
      expect(prompt.startsWith(workflowSystem(name))).toBe(true)
      expect(prompt.indexOf(TODO_SYSTEM)).toBeGreaterThan(workflowSystem(name).length)
    }
    c.ws.close()
  })

  it("a fresh side base of a voice chat is an ordinary chat's: no extra paragraph, and it can ask other agents", async () => {
    await writeFile(join(agentsDir, 'abe.md'), '---\nname: abe\ndescription: First one\n---\nAbe.')
    await writeFile(
      join(dataDir, 'chats.json'),
      JSON.stringify({
        chats: [
          {
            id: 'vc',
            agentName: 'tester',
            sessionId: null,
            cwd: root,
            title: 'Voice · Nov 13',
            createdAt: 1,
            updatedAt: 1,
            inFlight: false,
            voice: true
          }
        ]
      })
    )
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const sides = async () =>
      (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((x) => (JSON.parse(x) as { args: string[] }).args)
        .filter((a) => a.includes('--no-session-persistence'))
    await c.call('btw:ask', 'vc', 'Why?', 'side-vc')
    await until(async () => (await sides()).length > 0)
    const args = (await sides()).at(-1)!
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain(TODO_SYSTEM)
    expect(prompt).not.toMatch(/spoken/)
    const servers = args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))
    expect(servers).toContain('zumibot_agents')
    c.ws.close()
  })

  it("an agent's servers, skills and Vault references reach a fresh side base and its main run alike, an unfillable server left out of both", async () => {
    const DB = 'postgres://db-secret-5678'
    await writeFile(
      join(agentsDir, 'ext.md'),
      [
        '---',
        'name: ext',
        'description: Extension agent',
        'serversOff:',
        '  - claude.ai Gmail',
        'skillsOff:',
        '  - apple-design',
        'mcpServers:',
        '  - gh:',
        '      command: gh-mcp',
        '      env:',
        '        TOKEN: "${vault:GITHUB_TOKEN}"',
        '  - db:',
        '      command: db-mcp',
        '      env:',
        '        URL: "${vault:DB_URL}"',
        '---',
        'Ext.'
      ].join('\n')
    )
    await writeFile(
      join(dataDir, 'chats.json'),
      JSON.stringify({
        chats: [{ id: 'ext-chat', agentName: 'ext', sessionId: null, cwd: root, title: 'Ext', createdAt: 1, updatedAt: 1, inFlight: false }]
      })
    )
    // Every connector on for this agent, so only its own serversOff entry (Gmail) is denied, as before connectors had switches.
    await writeFile(
      join(dataDir, 'connectors.json'),
      JSON.stringify({
        v: 1,
        agents: { ext: ['gmail', 'google-calendar', 'google-drive', 'notion', 'github', 'slack', 'linear'] },
        migration: 'kept'
      })
    )
    noHomeProbe()
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    process.env.FAKE_ENV_OUT = join(root, 'run-env.json')
    const s = await boot(),
      c = await connect(s.port)
    await c.call('vault:save', { kind: 'apiKey', name: 'Database', agents: ['ext'], env: 'DB_URL', value: DB, description: '' })
    const runs = async () =>
      (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((x) => (JSON.parse(x) as { args: string[] }).args)
    const envNow = async () => JSON.parse(await readFile(join(root, 'run-env.json'), 'utf8')) as NodeJS.ProcessEnv
    // No main run on this server yet: baseFor builds the side base.
    await c.call('btw:ask', 'ext-chat', 'Why?', 'side-1')
    await until(async () => (await runs()).some((a) => a.includes('--no-session-persistence')))
    await until(async () =>
      ((await c.call('btw:list', 'ext-chat')) as { state: string }[]).every((e) => e.state !== 'running' && e.state !== 'picking')
    )
    const sideEnv = await envNow()
    await c.call('chats:send', 'ext-chat', 'hello', [])
    await until(async () => (await runs()).some((a) => !a.includes('--no-session-persistence')))
    await until(async () => !((await c.call('chats:list')) as ChatMeta[]).find((m) => m.id === 'ext-chat')?.inFlight)
    const mainEnv = await envNow()
    const all = await runs()
    const side = all.find((a) => a.includes('--no-session-persistence'))!,
      main = all.find((a) => !a.includes('--no-session-persistence'))!
    const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? [a] : []))
    const own = (args: string[]) => configs(args).filter((a) => 'db' in (JSON.parse(a) as { mcpServers: object }).mcpServers)
    expect(own(main)).toHaveLength(1)
    expect(own(side)).toEqual(own(main))
    expect(JSON.parse(own(main)[0])).toEqual({ mcpServers: { db: { command: 'db-mcp', env: { URL: '${ZUMIBOT_MCP_VAULT_0}' } } } })
    // The agent's servers come before ZumiBot's own in both.
    for (const args of [main, side]) {
      const names = configs(args).flatMap((a) => Object.keys((JSON.parse(a) as { mcpServers: object }).mcpServers))
      expect(names[0]).toBe('db')
      expect(names).toContain('zumibot_todos')
      // The fake takes the flag as claude 2.1.322 does: a fresh side base asks for thinking summaries as the main run does.
      expect(args.filter((a) => a === '--thinking-display' || a === 'summarized')).toEqual(['--thinking-display', 'summarized'])
      expect(args.join('\n')).not.toContain('gh-mcp')
      expect(args.join('\n')).not.toContain(DB)
      expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'mcp__claude_ai_Gmail'])
      const settings = args.flatMap((a, i) => (args[i - 1] === '--settings' ? [JSON.parse(a) as Record<string, unknown>] : []))
      expect(settings).toHaveLength(1)
      expect(settings[0]).toMatchObject({
        deniedMcpServers: [{ serverName: 'claude.ai Gmail' }],
        skillOverrides: { 'apple-design': 'off' }
      })
    }
    expect(sideEnv.ZUMIBOT_MCP_VAULT_0).toBe(DB)
    expect(mainEnv.ZUMIBOT_MCP_VAULT_0).toBe(DB)
    c.ws.close()
  }, 20_000)

  it('a Vault change and an agent file change drop the cached loadouts', async () => {
    const forget = vi.spyOn(ExtensionsService.prototype, 'forget')
    try {
      const s = await boot(),
        c = await connect(s.port)
      const before = forget.mock.calls.length
      await c.call('vault:save', {
        kind: 'apiKey',
        name: 'Forget test',
        agents: [],
        env: 'FORGET_TEST',
        value: 'forget-value-1',
        description: ''
      })
      await until(() => forget.mock.calls.length > before)
      const mid = forget.mock.calls.length
      await writeFile(join(agentsDir, 'forget-me.md'), '---\nname: forget-me\ndescription: d\n---\nBody.\n')
      await untilWatched(() => forget.mock.calls.length > mid)
      c.ws.close()
    } finally {
      forget.mockRestore()
    }
  })

  it('browser metadata failure still permits a text turn with no capability or system-browser fallback', async () => {
    await mkdir(join(dataDir, 'browsers'))
    await writeFile(join(dataDir, 'browsers', 'profiles.json'), 'broken')
    process.env.FAKE_ENV_OUT = join(root, 'turn-env.json')
    process.env.FAKE_ARGS_OUT = join(root, 'turn-args.json')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'hello', [])
    const childEnv = JSON.parse(await readFile(join(root, 'turn-env.json'), 'utf8')) as NodeJS.ProcessEnv
    const args = JSON.parse(await readFile(join(root, 'turn-args.json'), 'utf8')) as string[]
    expect(childEnv.ZUMIBOT_BROWSER_CAPABILITY).toBeUndefined()
    expect(args).toContain('--no-chrome')
    // Only the to-do, vault, agent-ask and process servers, which every single-chat run gets: no browser tools.
    const servers = args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? Object.keys(JSON.parse(a).mcpServers) : []))
    expect(servers).toEqual(['zumibot_todos', 'zumibot_vault', 'zumibot_agents', 'zumibot_processes'])
    expect(args.join(' ')).toContain('do not open a system browser')
    expect(await readFile(join(dataDir, 'browsers', 'profiles.json'), 'utf8')).toBe('broken')
    await expect(c.call('browsers:clear', 'tester')).rejects.toThrow('Browser unavailable')
    c.ws.close()
  })

  it('browser tools are scoped to real group-member attempts and never injected into the moderator', async () => {
    for (const name of ['ui', 'wk'])
      await writeFile(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Test agent\n---\nTest agent.`)
    process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
    const s = await boot(),
      c = await connect(s.port)
    const chat = (await c.call('chats:createGroup', ['ui', 'wk'], root, '')) as ChatMeta
    await c.call('chats:send', chat.id, '@ui @wk hello', [])
    await until(async () => {
      const entries = await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')
      return entries.split('\n').filter((line) => line.includes('--agent')).length === 2
    })
    await until(async () => !((await c.call('chats:list')) as ChatMeta[]).find((meta) => meta.id === chat.id)?.inFlight)
    const invocations = (await readFile(join(root, 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; browser: boolean; appSecret: boolean; path: boolean })
    const members = invocations.filter((i) => i.args.includes('--agent'))
    const moderators = invocations.filter((i) => i.args.includes('--strict-mcp-config'))
    expect(members).toHaveLength(2)
    expect(moderators.length).toBeGreaterThan(0)
    expect(members.every((i) => i.browser && i.path && !i.appSecret && i.args.includes('--mcp-config'))).toBe(true)
    expect(moderators.every((i) => !i.browser && !i.args.includes('--mcp-config'))).toBe(true)
    c.ws.close()
  })
  it('desktop profile identity survives app save rename and the following watcher removal pass', async () => {
    const on = (name: string) => `---\nname: ${name}\ndescription: Test agent\ncomputerUse: true\n---\nTest agent.`
    await writeFile(join(agentsDir, 'tester.md'), on('tester'))
    const profileId = randomUUID()
    await mkdir(join(dataDir, 'desktops', profileId), { recursive: true })
    await writeFile(join(dataDir, 'desktops', 'profiles.json'), JSON.stringify({ version: 1, profiles: { tester: profileId } }))
    const mapping = async () =>
      (JSON.parse(await readFile(join(dataDir, 'desktops', 'profiles.json'), 'utf8')) as { profiles: Record<string, string> }).profiles
    const s = await boot(),
      c = await connect(s.port)
    await c.call('agents:save', join(agentsDir, 'tester.md'), on('renamed'))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await mapping()).toEqual({ renamed: profileId })
    // Deleting the agent detaches its desktop; the folder stays until Clear desktop data.
    await c.call('agents:trash', join(agentsDir, 'renamed.md'))
    expect(await mapping()).toEqual({})
    expect((await stat(join(dataDir, 'desktops', profileId))).isDirectory()).toBe(true)
    c.ws.close()
  })

  it('desktop leftovers are recovered at startup and desktops close before the lock is released', async () => {
    const recover = vi.spyOn(desktopProcess, 'recoverDesktops').mockResolvedValue()
    const real = DesktopManager.prototype.close
    let lockHeldAfterClose: boolean | undefined
    const close = vi.spyOn(DesktopManager.prototype, 'close').mockImplementation(async function (this: DesktopManager) {
      await real.call(this)
      lockHeldAfterClose = await stat(join(dataDir, 'server.lock')).then(
        () => true,
        () => false
      )
    })
    const s = await boot()
    expect(recover).toHaveBeenCalledWith(join(dataDir, 'desktops'))
    started = null
    await s.close()
    expect(close).toHaveBeenCalled()
    // The desktops were stopped while the lock was still held; it went only afterwards.
    expect(lockHeldAfterClose).toBe(true)
    await expect(stat(join(dataDir, 'server.lock'))).rejects.toThrow()
  })

  const desktopMapping = async () =>
    (JSON.parse(await readFile(join(dataDir, 'desktops', 'profiles.json'), 'utf8')) as { profiles: Record<string, string> }).profiles
  const seedDesktop = async (agent: string) => {
    const profileId = randomUUID()
    await mkdir(join(dataDir, 'desktops', profileId), { recursive: true })
    await writeFile(join(dataDir, 'desktops', 'profiles.json'), JSON.stringify({ version: 1, profiles: { [agent]: profileId } }))
    return profileId
  }

  it('a desktop of an agent deleted while the server was off is detached at startup, its folder kept', async () => {
    const profileId = await seedDesktop('gone')
    await boot()
    // The startup sync runs before LISTENING.
    expect(await desktopMapping()).toEqual({})
    expect((await stat(join(dataDir, 'desktops', profileId))).isDirectory()).toBe(true)
  })

  it('deleting an agent file outside the app detaches its desktop, its folder kept', async () => {
    await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\ncomputerUse: true\n---\nTest agent.')
    const profileId = await seedDesktop('tester')
    await boot()
    expect(await desktopMapping()).toEqual({ tester: profileId })
    await rm(join(agentsDir, 'tester.md'))
    await untilWatched(async () => Object.keys(await desktopMapping()).length === 0, 3000)
    expect((await stat(join(dataDir, 'desktops', profileId))).isDirectory()).toBe(true)
  })

  it('a desktop cleanup that cannot be confirmed keeps the data lock', async () => {
    vi.spyOn(DesktopManager.prototype, 'close').mockRejectedValue(new Error('Desktop processes did not exit'))
    const s = await boot()
    started = null
    await expect(s.close()).rejects.toThrow('Desktop cleanup could not be confirmed; data lock retained')
    expect((await stat(join(dataDir, 'server.lock'))).isFile()).toBe(true)
  })

  // Computer use is Linux-only in the app.
  it.skipIf(process.platform !== 'linux')(
    'desktop tools go only to computer-use room members, each with its own profile, never to the moderator',
    async () => {
      for (const [name, on] of [
        ['ui', true],
        ['wk', true],
        ['plain', false]
      ] as const) {
        await writeFile(
          join(agentsDir, `${name}.md`),
          `---\nname: ${name}\ndescription: Test agent\n${on ? 'computerUse: true\n' : ''}---\nTest agent.`
        )
      }
      // Every desktop program "found", so the plan does not depend on what this machine has installed.
      for (const v of ['ZUMIBOT_DESKTOP_XVNC', 'ZUMIBOT_DESKTOP_DBUS_DAEMON', 'ZUMIBOT_DESKTOP_SESSION', 'ZUMIBOT_CUA_DRIVER'])
        vi.stubEnv(v, process.execPath)
      process.env.FAKE_INVOCATIONS_OUT = join(root, 'invocations.jsonl')
      const s = await boot(),
        c = await connect(s.port)
      const chat = (await c.call('chats:createGroup', ['ui', 'wk', 'plain'], root, '')) as ChatMeta
      await c.call('chats:send', chat.id, '@ui @wk @plain hello', [])
      await until(async () => {
        const entries = await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')
        return entries.split('\n').filter((line) => line.includes('--agent')).length === 3
      })
      await until(async () => !((await c.call('chats:list')) as ChatMeta[]).find((meta) => meta.id === chat.id)?.inFlight)
      const invocations = (await readFile(join(root, 'invocations.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; desktop: boolean })
      const member = (name: string) =>
        invocations.find((i) => i.args.includes('--agent') && i.args[i.args.indexOf('--agent') + 1] === name)!
      for (const name of ['ui', 'wk']) {
        const { args, desktop } = member(name)
        expect(desktop).toBe(true)
        expect(args.some((a) => a.includes('zumibot_desktop'))).toBe(true)
        expect(args.filter((a) => a === '--settings')).toHaveLength(1)
        const ask = (JSON.parse(args[args.indexOf('--settings') + 1]) as { permissions: { ask: string[] } }).permissions.ask
        expect(ask.filter((t) => t.startsWith('mcp__zumibot_desktop__'))).toHaveLength(8)
        expect(ask).toContain('mcp__zumibot_processes__start')
      }
      expect(member('plain').desktop).toBe(false)
      expect(member('plain').args.some((a) => a.includes('zumibot_desktop'))).toBe(false)
      // Every member run's one --settings holds the vault guard's deny rules and Bash hook, and the pause hook when this build has
      // its entry; a plain member's asks only before a process start.
      const hooked = existsSync(resolveBrowserRuntime().pauseHookEntry)
      type Merged = {
        permissions?: { ask?: string[]; deny?: string[] }
        hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] }
      }
      const settingsOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--settings' ? [JSON.parse(a) as Merged] : []))
      for (const name of ['ui', 'wk', 'plain']) {
        const settings = settingsOf(member(name).args)
        expect(settings).toHaveLength(1)
        expect(settings[0].permissions?.deny?.some((d) => d.startsWith('Read(//') && d.endsWith('/zumibot-vault/**)'))).toBe(true)
        expect(
          settings[0].hooks?.PreToolUse?.some((h) => h.matcher === 'Bash' && h.hooks.some((x) => x.command.includes('zumibot-vault')))
        ).toBe(true)
        if (hooked) expect(settings[0].hooks?.PreToolUse?.some((h) => h.hooks.some((x) => x.command.includes('pauseHook.mjs')))).toBe(true)
      }
      expect(
        settingsOf(member('plain').args).every(
          (s) => JSON.stringify(s.permissions?.ask) === JSON.stringify(['mcp__zumibot_processes__start'])
        )
      ).toBe(true)
      const moderators = invocations.filter((i) => i.args.includes('--strict-mcp-config'))
      expect(moderators.length).toBeGreaterThan(0)
      expect(moderators.every((i) => !i.desktop && !i.args.some((a) => a.includes('zumibot_desktop')))).toBe(true)
      const profiles = (
        JSON.parse(await readFile(join(dataDir, 'desktops', 'profiles.json'), 'utf8')) as { profiles: Record<string, string> }
      ).profiles
      expect(Object.keys(profiles).sort()).toEqual(['ui', 'wk'])
      expect(profiles.ui).not.toBe(profiles.wk)
      c.ws.close()
    }
  )

  it('prints LISTENING <port> once, on 127.0.0.1, and 401s without the cookie', async () => {
    const s = await boot()
    expect(lines).toEqual([`LISTENING ${s.port}`])
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`)
    const res = await fetch(`http://127.0.0.1:${s.port}/api/x`)
    expect(res.status).toBe(401)
  })

  it('keeps /hooks and look-alike paths behind the gate: only /hooks/<id> skips it', async () => {
    const s = await boot()
    const base = `http://127.0.0.1:${s.port}`
    // A cookie-less GET the gate sees goes to /login; one the webhook route took would be a 401 JSON instead.
    for (const path of ['/hooks', '/hooksX', '/hooks?x=1', '/hooksx/nope']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' })
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location'), path).toBe('/login')
    }
  })

  it('webhooks bypass the gate: unknown hook is 401 JSON, a draft url from the live origin captures a test call', async () => {
    const s = await boot()
    const base = `http://127.0.0.1:${s.port}`
    // The gate would answer a cookie-less GET with a 302 to /login.
    const unknown = await fetch(`${base}/hooks/nope`, { redirect: 'manual' })
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toEqual({ error: 'Unauthorized' })
    expect((await fetch(`${base}/`, { redirect: 'manual' })).status).toBe(302)

    const c = await connect(s.port)
    const draft = (await c.call('routines:draftWebhook')) as { id: string; url: string; secret: string }
    expect(draft.url.startsWith(`${base}/hooks/`)).toBe(true) // the origin is learned after listen
    const body = { hello: 'world' }
    const res = await fetch(draft.url, {
      method: 'POST',
      headers: { 'x-zumibot-secret': draft.secret, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'test call captured' })
    const hook = (await c.call('routines:webhook', draft.id)) as { latest: { body: unknown } | null }
    expect(hook.latest?.body).toEqual(body)
    const saved = (await c.call('routines:save', {
      id: draft.id,
      name: 'Hook',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'webhook', sample: null },
      target: { kind: 'chat', chatId: 'nowhere' },
      prompt: 'Go'
    })) as { id: string }
    expect(saved.id).toBe(draft.id)
    c.ws.close()
  })

  it('recovering several interrupted runs at start raises no unhandled rejection', async () => {
    const routine = {
      id: 'r1',
      name: 'R',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'chat', chatId: 'gone' },
      prompt: 'p',
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    await writeFile(join(dataDir, 'routines.json'), JSON.stringify([routine]))
    const mk = (id: string) => ({
      id,
      routineId: 'r1',
      via: 'manual',
      status: 'running',
      late: false,
      chatId: 'gone',
      messageId: 'm',
      startedAt: 1
    })
    await writeFile(join(dataDir, 'routine-runs.json'), JSON.stringify({ r1: [mk('a'), mk('b')] }))
    const seen: unknown[] = []
    const onRejection = (e: unknown): void => void seen.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      const s = await boot()
      const c = await connect(s.port)
      const runs = async () => ((await c.call('routines:list')) as { runs: Record<string, { status: string }[]> }).runs['r1'] ?? []
      await until(async () => (await runs()).every((r) => r.status === 'failed'))
      expect((await runs()).map((r) => r.status)).toEqual(['failed', 'failed'])
      await new Promise((r) => setTimeout(r, 100))
      expect(seen).toEqual([])
      c.ws.close()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('recovers routine runs before queued messages resume: a queued run ends done, not failed', async () => {
    const meta = {
      id: 'q',
      agentName: 'tester',
      title: 'Q',
      cwd: root,
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      tasks: [{ id: 't1', text: 'held', ts: 1 }]
    }
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
    const routine = {
      id: 'r1',
      name: 'R',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'chat', chatId: 'q' },
      prompt: 'held',
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    await writeFile(join(dataDir, 'routines.json'), JSON.stringify([routine]))
    const run = { id: 'run1', routineId: 'r1', via: 'manual', status: 'running', late: false, chatId: 'q', messageId: 't1', startedAt: 1 }
    await writeFile(join(dataDir, 'routine-runs.json'), JSON.stringify({ r1: [run] }))
    const s = await boot()
    const c = await connect(s.port)
    const status = async (): Promise<string | undefined> =>
      ((await c.call('routines:list')) as { runs: Record<string, { status: string }[]> }).runs['r1']?.[0]?.status
    await until(async () => (await status()) !== 'running')
    expect(await status()).toBe('done')
    c.ws.close()
  })

  it('a workflow runs end to end: its Agent step replies, the step chat is archived and every tab hears workflows:changed', async () => {
    const s = await boot()
    const c = await connect(s.port)
    const w = (await c.call('workflows:save', {
      id: null,
      name: 'Flow',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [
        { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
        { id: 'a', handle: 'ask', name: 'Ask', x: 200, y: 0, kind: 'agent', agent: 'tester', prompt: 'Answer me', cwd: root }
      ],
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'a' }]
    })) as Workflow
    const run = (await c.call('workflows:run', w.id, 'hello')) as WorkflowRunSummary
    const runOf = async (): Promise<WorkflowRun> => (await c.call('workflows:getRun', run.id)) as WorkflowRun
    await until(async () => (await runOf()).status === 'done')
    const visit = (await runOf()).visits.find((v) => v.stepId === 'a')!
    expect(visit.output).toBe('pong')
    const chat = ((await c.call('chats:list')) as ChatMeta[]).find((m) => m.id === visit.chatId)
    expect(chat?.workflow).toMatchObject({ workflowId: w.id, runId: run.id, stepId: 'a' })
    expect(isArchived(chat!)).toBe(true)
    // The archive reached the tabs as a meta push, so the sidebar drops the chat without a reload.
    expect(
      c.events.some(
        (e) => e.event === 'chats:push' && e.payload.kind === 'meta' && e.payload.chatId === visit.chatId && isArchived(e.payload.meta)
      )
    ).toBe(true)
    const snapshots = c.events.filter((e): e is Extract<RpcEvent, { event: 'workflows:changed' }> => e.event === 'workflows:changed')
    expect(snapshots.at(-1)?.payload.runs[w.id]?.[0]).toMatchObject({ id: run.id, status: 'done' })
    expect(JSON.stringify(snapshots)).not.toContain('pong') // outputs only through getRun
    c.ws.close()
  })

  it('a to-do added in a chat starts a workflow whose trigger is a to-do, and the run keeps the event body', async () => {
    const s = await boot()
    const c = await connect(s.port)
    const w = (await c.call('workflows:save', {
      id: null,
      name: 'On to-do',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'todo', filters: [] },
      steps: [
        { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
        { id: 'a', handle: 'ask', name: 'Ask', x: 200, y: 0, kind: 'agent', agent: 'tester', prompt: 'Answer me', cwd: root }
      ],
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'a' }]
    })) as Workflow
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('todos:add', 'Send the report', chat.id)
    const runs = async (): Promise<WorkflowRunSummary[]> =>
      ((await c.call('workflows:list')) as { runs: Record<string, WorkflowRunSummary[]> }).runs[w.id] ?? []
    await until(async () => (await runs()).length === 1)
    const run = (await c.call('workflows:getRun', (await runs())[0].id)) as WorkflowRun
    expect(run.via).toBe('event')
    expect(run.event).toEqual({ kind: 'todo' })
    c.ws.close()
  })

  it("a reply workflow's Chat step posting back into the chat it listens to runs once, not in a loop", async () => {
    const s = await boot()
    const c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    const w = (await c.call('workflows:save', {
      id: null,
      name: 'Echo',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'reply', filters: [{ field: 'body.chat.id', equals: chat.id }] },
      steps: [
        { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
        { id: 'k', handle: 'post', name: 'Post', x: 200, y: 0, kind: 'chat', chat: chat.id, prompt: 'Again' }
      ],
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'k' }]
    })) as Workflow
    await c.call('chats:send', chat.id, 'hello', [])
    const runs = async (): Promise<WorkflowRunSummary[]> =>
      ((await c.call('workflows:list')) as { runs: Record<string, WorkflowRunSummary[]> }).runs[w.id] ?? []
    await until(async () => (await runs())[0]?.status === 'done')
    // The Chat step's own reply would start the next run at once, before this one ends: give it time to show.
    await new Promise((r) => setTimeout(r, 500))
    expect((await runs()).length).toBe(1)
    c.ws.close()
  })

  it('a usage limit in an Agent step is waited out by the step alone: the chat stores no wait of its own', async () => {
    // As the CLI answers a 429: a rejected rate_limit_event, a synthetic reply, an error result. The reset is an hour out.
    const lines = (await readFile(basic, 'utf8')).split('\n').filter(Boolean)
    const result = JSON.parse(lines.at(-1)!) as Record<string, unknown>
    const script = join(root, 'limit.jsonl')
    await writeFile(
      script,
      [
        lines[0],
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' },
          uuid: 'limit',
          session_id: result['session_id']
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'limit-msg',
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: "You've hit your session limit" }]
          },
          error: 'rate_limit',
          session_id: result['session_id']
        }),
        JSON.stringify({ ...result, is_error: true, result: "You've hit your session limit" })
      ].join('\n') + '\n'
    )
    process.env['FAKE_STDOUT_FILE'] = script
    const s = await boot()
    const c = await connect(s.port)
    const w = (await c.call('workflows:save', {
      id: null,
      name: 'Flow',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [
        { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
        { id: 'a', handle: 'ask', name: 'Ask', x: 200, y: 0, kind: 'agent', agent: 'tester', prompt: 'Answer me', cwd: root }
      ],
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'a' }]
    })) as Workflow
    const run = (await c.call('workflows:run', w.id)) as WorkflowRunSummary
    const visitOf = async () => ((await c.call('workflows:getRun', run.id)) as WorkflowRun).visits.find((v) => v.stepId === 'a')
    await until(async () => (await visitOf())?.until !== undefined)
    const chatId = (await visitOf())!.chatId!
    // LimitResumes runs on the same idle, queued per chat: give it time to (wrongly) store its wait.
    await new Promise((r) => setTimeout(r, 300))
    expect(((await c.call('chats:list')) as ChatMeta[]).find((m) => m.id === chatId)?.resume).toBeUndefined()
    await c.call('workflows:stop', run.id)
    c.ws.close()
  })

  it('a workflow webhook goes through the live hooks route: a test call is captured, then a call runs the saved workflow', async () => {
    const s = await boot()
    const c = await connect(s.port)
    const steps = [
      { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
      { id: 'n', handle: 'tell', name: 'Tell', x: 200, y: 0, kind: 'notify', title: 'Hi' }
    ]
    const edges = [{ id: 'e1', from: 't', port: 'out', to: 'n' }]
    const w = (await c.call('workflows:save', {
      id: null,
      name: 'Hooked',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps,
      edges
    })) as Workflow
    const hook = (await c.call('workflows:webhook', w.id)) as { url: string; secret: string }
    expect(hook.url).toBe(`http://127.0.0.1:${s.port}/hooks/${w.id}`)
    const post = (body: unknown): Promise<Response> =>
      fetch(hook.url, {
        method: 'POST',
        headers: { 'x-zumibot-secret': hook.secret, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    const captured = await post({ ref: 'main' })
    expect([captured.status, await captured.json()]).toEqual([202, { status: 'test call captured' }])
    const saved = (await c.call('workflows:save', {
      id: w.id,
      name: 'Hooked',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'webhook', sample: null, filters: [] },
      steps,
      edges
    })) as Workflow
    expect(saved.trigger).toMatchObject({ kind: 'webhook', sample: { body: { ref: 'main' } } })
    const off = await post({ ref: 'dev' })
    expect([off.status, await off.json()]).toEqual([409, { error: 'Workflow is disabled' }])
    await c.call('workflows:setEnabled', w.id, true)
    const res = await post({ ref: 'dev' })
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    await until(async () => ((await c.call('workflows:getRun', runId)) as WorkflowRun | null)?.status === 'done')
    expect(((await c.call('workflows:getRun', runId)) as WorkflowRun).call?.body).toEqual({ ref: 'dev' })
    c.ws.close()
  })

  it('recovers workflow runs before queued messages resume: an Agent step whose message waited ends done', async () => {
    const meta = {
      id: 'q',
      agentName: 'tester',
      title: 'Q',
      cwd: root,
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      tasks: [{ id: 't1', text: 'held', ts: 1 }],
      workflow: { workflowId: 'w1', runId: 'run1', stepId: 'a', name: 'Flow' }
    }
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
    const steps = [
      { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
      { id: 'a', handle: 'ask', name: 'Ask', x: 200, y: 0, kind: 'agent', agent: 'tester', prompt: 'held', cwd: root }
    ]
    const edges = [{ id: 'e1', from: 't', port: 'out', to: 'a' }]
    const workflow = {
      id: 'w1',
      name: 'Flow',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps,
      edges,
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    await writeFile(join(dataDir, 'workflows.json'), JSON.stringify([workflow]))
    const run = {
      id: 'run1',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      snapshot: { steps, edges },
      visits: [
        { id: 'v0', stepId: 't', n: 1, status: 'done', input: '', inputs: [], output: '', port: 'out', startedAt: 1, endedAt: 1 },
        { id: 'v1', stepId: 'a', n: 1, status: 'running', input: '', inputs: [], chatId: 'q', messageId: 't1', startedAt: 1 }
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: 1
    }
    await writeFile(join(dataDir, 'workflow-runs.json'), JSON.stringify({ w1: [run] }))
    const s = await boot()
    const c = await connect(s.port)
    const status = async (): Promise<string | undefined> => ((await c.call('workflows:getRun', 'run1')) as WorkflowRun | null)?.status
    await until(async () => (await status()) !== 'running')
    expect(await status()).toBe('done')
    expect(((await c.call('workflows:getRun', 'run1')) as WorkflowRun).visits.find((v) => v.id === 'v1')?.output).toBe('pong')
    c.ws.close()
  })

  it('a workflow webhook call that lands while workflow recovery is still pending starts its run only after it', async () => {
    const steps = [
      { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' },
      { id: 'n', handle: 'tell', name: 'Tell', x: 200, y: 0, kind: 'notify', title: 'Hi' }
    ]
    const workflow = {
      id: 'wh',
      name: 'Hooked',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'webhook', sample: null, filters: [] },
      steps,
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'n' }],
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    await writeFile(join(dataDir, 'workflows.json'), JSON.stringify([workflow]))
    const secret = 's'.repeat(32)
    await writeFile(join(dataDir, 'workflow-hooks.json'), JSON.stringify([{ id: 'wh', secret, latest: null, draftAt: null }]), {
      mode: 0o600
    })
    // recover() is held, so the server listens (it recovers after listen) while recovery has not finished.
    const original = WorkflowRunner.prototype.recover
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const recover = vi.spyOn(WorkflowRunner.prototype, 'recover').mockImplementation(async function (this: WorkflowRunner) {
      await held
      return original.call(this)
    })
    const run = vi.spyOn(WorkflowRunner.prototype, 'run')
    const net = await import('node:net')
    const probe = net.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as import('node:net').AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    const booting = boot({ ZUMIBOT_PORT: String(port) })
    await until(() => recover.mock.calls.length > 0)
    let answered = false
    const call = fetch(`http://127.0.0.1:${port}/hooks/wh`, {
      method: 'POST',
      headers: { 'x-zumibot-secret': secret, 'content-type': 'application/json' },
      body: '{"ref":"dev"}'
    }).then((r) => {
      answered = true
      return r
    })
    await until(() => run.mock.calls.length > 0) // the hook reached the runner
    await new Promise((r) => setTimeout(r, 100))
    const stored = async (): Promise<WorkflowRun[]> =>
      (JSON.parse(await readFile(join(dataDir, 'workflow-runs.json'), 'utf8').catch(() => '{}')) as Record<string, WorkflowRun[]>).wh ?? []
    expect(await stored()).toEqual([])
    expect(answered).toBe(false)
    release()
    const s = await booting
    const res = await call
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    await until(async () => (await stored()).find((r) => r.id === runId)?.status === 'done')
    expect(s.port).toBe(port)
  })

  it('a corrupt routine file does not stop the server from starting', async () => {
    await writeFile(join(dataDir, 'routine-runs.json'), '{not json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = await boot()
      expect(lines).toEqual([`LISTENING ${s.port}`])
    } finally {
      err.mockRestore()
    }
  })

  it('a ws client sends chats:create + chats:send and receives chats:push deltas then an items push', async () => {
    const s = await boot()
    const c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'ping', [])
    await until(() => c.events.some((e) => e.event === 'chats:push' && e.payload.kind === 'items'))
    const pushes = c.events
      .filter((e): e is Extract<RpcEvent, { event: 'chats:push' }> => e.event === 'chats:push')
      .map((e) => e.payload as ChatPush)
    const delta = pushes.findIndex((p) => p.kind === 'delta')
    const items = pushes.map((p) => p.kind).lastIndexOf('items') // the first items push is the user's message
    expect(delta).toBeGreaterThanOrEqual(0)
    expect(items).toBeGreaterThan(delta)
    expect(JSON.stringify(pushes)).toContain('pong')
    c.ws.close()
  })

  it('sends a later message as the items past the list the last turn ended with, which chats:items matches', async () => {
    const s = await boot()
    const c = await connect(s.port)
    const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
    await c.call('chats:send', chat.id, 'ping', [])
    const itemPushes = () =>
      c.events.flatMap((e) =>
        e.event === 'chats:push' && e.payload.kind === 'items' ? [e.payload as Extract<WirePush, { kind: 'items' }>] : []
      )
    const ended = itemPushes().at(-1)!
    const snap = (await c.call('chats:items', chat.id)) as ItemsPage
    expect(snap.seq).toBe(ended.seq)
    const held = snap.start + snap.items.length
    const before = itemPushes().length
    await c.call('chats:send', chat.id, 'again', [])
    // The new turn reads the chat from disk, so its items are new objects; they still count as already sent.
    const first = itemPushes()[before]!
    expect(first).toMatchObject({ base: ended.seq, from: held })
    expect(first.items.map((i: ChatItem) => i.type === 'user' && i.text)).toEqual(['again'])
    c.ws.close()
  })

  it('a chat marked inFlight in chats.json on start is recovered as interrupted', async () => {
    const meta = { id: 'c1', agentName: 'a', title: 'T', cwd: root, createdAt: 1, updatedAt: 1, inFlight: true }
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
    const s = await boot()
    const c = await connect(s.port)
    const list = (await c.call('chats:list')) as ChatMeta[]
    expect(list.find((m) => m.id === 'c1')?.inFlight).toBe(false)
    const { items } = (await c.call('chats:items', 'c1')) as { items: { type: string; kind?: string }[] }
    expect(items.some((i) => i.type === 'notice' && i.kind === 'interrupted')).toBe(true)
    c.ws.close()
  })

  it('local mode migrates a desktop folder in before the stores load', async () => {
    const from = join(root, 'desktop')
    await mkdir(from)
    await writeFile(
      join(from, 'chats.json'),
      JSON.stringify({ chats: [{ id: 'old', agentName: 'a', title: 'Old', cwd: root, createdAt: 1, updatedAt: 1, inFlight: false }] })
    )
    const s = await boot({ ZUMIBOT_MIGRATE_FROM: from })
    const c = await connect(s.port)
    expect(((await c.call('chats:list')) as ChatMeta[]).map((m) => m.id)).toEqual(['old'])
    c.ws.close()
  })

  it('a second server on the same data dir is refused', async () => {
    await boot()
    await expect(startServer(loadConfig(env()), { out: () => {} })).rejects.toThrow('Another ZumiBot server is using')
  })

  it('creates the data dir with mode 0o700 and answers busy on control.sock', async () => {
    const fresh = join(root, 'fresh')
    const s = await startServer(loadConfig(env({ ZUMIBOT_DATA_DIR: fresh })), { out: () => {} })
    started = s
    const { stat } = await import('node:fs/promises')
    if (process.platform !== 'win32') expect((await stat(fresh)).mode & 0o777).toBe(0o700)
    const { queryBusy, controlPath } = await import('../src/control')
    expect(await queryBusy(controlPath(fresh))).toBe(0)
  })

  it('a chats:send during shutdown is rejected and starts no run', async () => {
    process.env['FAKE_HANG'] = '1'
    const s = await boot()
    const c = await connect(s.port)
    const a = (await c.call('chats:create', 'tester', root)) as ChatMeta
    const b = (await c.call('chats:create', 'tester', root)) as ChatMeta
    void c.call('chats:send', a.id, 'ping', []).catch(() => {})
    await until(() => c.events.some((e) => e.event === 'chats:push' && e.payload.kind === 'delta'))
    const closing = s.close()
    await expect(c.call('chats:send', b.id, 'ping', [])).rejects.toThrow('Server is shutting down')
    await closing
    started = null
    const items = JSON.parse(await readFile(join(dataDir, 'chats', `${b.id}.json`), 'utf8').catch(() => '[]')) as unknown[]
    expect(items).toEqual([])
  })

  it('closing the server does not start a queued message when the stopped run ends', async () => {
    process.env['FAKE_HANG'] = '1'
    const s = await boot()
    const c = await connect(s.port)
    const a = (await c.call('chats:create', 'tester', root)) as ChatMeta
    void c.call('chats:send', a.id, 'one', []).catch(() => {})
    await until(() => c.events.some((e) => e.event === 'chats:push' && e.payload.kind === 'delta'))
    expect(await c.call('chats:send', a.id, 'two', [])).toBe('queued')
    await s.close()
    started = null
    await new Promise((r) => setTimeout(r, 300)) // a wrongly started task would take the store lock and write by now
    const meta = (JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')) as { chats: ChatMeta[] }).chats.find((m) => m.id === a.id)
    expect(meta?.tasks?.map((t) => t.text)).toEqual(['two'])
    const items = JSON.parse(await readFile(join(dataDir, 'chats', `${a.id}.json`), 'utf8')) as ChatItem[]
    expect(items.some((i) => i.type === 'user' && i.text === 'two')).toBe(false)
  })

  it('a message queued before a restart goes in once the server listens', async () => {
    const meta = {
      id: 'q',
      agentName: 'tester',
      title: 'Q',
      cwd: root,
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      tasks: [{ id: 't1', text: 'held', ts: 1 }]
    }
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
    const s = await boot()
    const c = await connect(s.port)
    await until(async () => ((await c.call('chats:items', 'q')) as ItemsPage).items.some((i) => i.type === 'user' && i.id === 't1'))
    await until(async () => !((await c.call('chats:list')) as ChatMeta[])[0].inFlight)
    expect(((await c.call('chats:list')) as ChatMeta[])[0].tasks ?? []).toEqual([])
    c.ws.close()
  })

  it('a failed listen releases the lock and removes control.sock', async () => {
    const net = await import('node:net')
    const taken = net.createServer()
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
    const port = (taken.address() as import('node:net').AddressInfo).port
    await expect(startServer(loadConfig(env({ ZUMIBOT_PORT: String(port) })), { out: () => {} })).rejects.toThrow()
    taken.close()
    await expect(stat(join(dataDir, 'server.lock'))).rejects.toThrow()
    await expect(stat(join(dataDir, 'control.sock'))).rejects.toThrow()
  })

  it('vps mode without auth refuses, pointing at the browser wizard', async () => {
    const cfg = loadConfig({
      HOME: root,
      ZUMIBOT_MODE: 'vps',
      ZUMIBOT_ORIGIN: 'https://x.example.com',
      ZUMIBOT_DATA_DIR: dataDir,
      ZUMIBOT_PORT: '0'
    })
    // A backstop only: `serve` runs startSetupServer first, which serves /setup instead of failing.
    await expect(startServer(cfg, { out: (l) => lines.push(l) })).rejects.toThrow(NEEDS_AUTH)
    expect(NEEDS_AUTH).toContain('/setup')
    expect(lines).toEqual([])
  })

  it('serves the setup wizard on the same data folder instead of refusing', async () => {
    const cfg = loadConfig({
      HOME: root,
      ZUMIBOT_MODE: 'vps',
      ZUMIBOT_ORIGIN: 'https://x.example.com',
      ZUMIBOT_DATA_DIR: dataDir,
      ZUMIBOT_PORT: '0'
    })
    const setup = await startSetupServer(cfg, { out: (l) => lines.push(l) })
    try {
      expect(setup).not.toBeNull()
      expect(lines[0]).toBe(`LISTENING ${setup!.port}`)
      expect(lines.join('\n')).toMatch(/Setup code: [A-Z2-7-]+/)
      const res = await fetch(`http://127.0.0.1:${setup!.port}/setup`)
      expect(res.status).toBe(200)
    } finally {
      await setup?.close()
    }
  })
})

describe('the built bundle', () => {
  let outDir: string
  let child: ChildProcess | null = null
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'cb-bundle-'))
    await build({ root: backendDir, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
  }, 60_000)
  afterAll(() => rm(outDir, { recursive: true, force: true }))
  afterEach(() => stopServer(child))

  // POSIX signal: on Windows kill('SIGTERM') is TerminateProcess, with no shutdown to watch.
  it.skipIf(process.platform === 'win32')(
    'SIGTERM while a reply streams stops it, marks the chat stopped, exits 0',
    async () => {
      process.env['FAKE_HANG'] = '1'
      child = spawn(process.execPath, [join(outDir, 'server.mjs')], {
        env: { ...process.env, ...env() },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      child.stdout!.on('data', (d) => (out += d))
      await until(() => /LISTENING \d+/.test(out))
      const port = Number(/LISTENING (\d+)/.exec(out)![1])
      const c = await connect(port)
      const chat = (await c.call('chats:create', 'tester', root)) as ChatMeta
      void c.call('chats:send', chat.id, 'ping', []).catch(() => {}) // settles only when the turn ends, which is after the SIGTERM
      await until(() => c.events.some((e) => e.event === 'chats:push' && e.payload.kind === 'delta'))
      const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)))
      const exited = new Promise<number | null>((r) => child!.once('exit', (code) => r(code)))
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(await closed).toBe(1001)
      const items = JSON.parse(await readFile(join(dataDir, 'chats', `${chat.id}.json`), 'utf8')) as { type: string; kind?: string }[]
      expect(items.some((i) => i.type === 'notice' && i.kind === 'interrupted')).toBe(true)
      const { chats: list } = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')) as { chats: ChatMeta[] }
      expect(list.find((m) => m.id === chat.id)?.inFlight).toBe(false)
    },
    30_000
  )

  it('busy prints the running count, exit 1 when no server', async () => {
    const run = (): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [join(outDir, 'server.mjs'), 'busy'], { env: { ...process.env, ...env() } })
        let o = ''
        p.stdout.on('data', (d) => (o += d))
        p.on('exit', (code) => resolve({ code, out: o }))
      })
    expect((await run()).code).toBe(1)
    child = spawn(process.execPath, [join(outDir, 'server.mjs'), 'serve'], {
      env: { ...process.env, ...env() },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout!.on('data', (d) => (out += d))
    await until(() => /LISTENING \d+/.test(out))
    expect(await run()).toEqual({ code: 0, out: '0\n' })
  }, 30_000)
})
