import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXT_TEXT, type AgentExtensions, type Loadout } from '@zumibot/shared/extensions'
import type { AgentSummary } from '@zumibot/shared/types'
import type { VaultItem } from '@zumibot/shared/vault'
import { buildAgentRunConfig, NO_RUN_CONFIG } from '../../../src/core/extensions/agentRunConfig'
import { ENGINE_COMMANDS_STALE_MS, ExtensionsService, type ExtensionsDeps } from '../../../src/core/extensions/extensionsService'
import { probeClaude, type ProbeAnswers } from '../../../src/core/extensions/probe'
import { stampOf } from '../../../src/core/extensions/settingsFile'
import { writeFakeBin } from '../../support/fakeBin'
import { isWindows, symlinksWork, removeDir } from '../../support/platform'

const FAKE = fileURLToPath(new URL('../../fixtures/fake-extensions-claude.mjs', import.meta.url))
const SECRET = 'sk-SECRET-123'
const NEW_SECRET = 'new-secret-2'
const KEY_VALUE = 'tok-secret-1'

let dir: string
let fakeClaude: string
let home: string
let claudeDir: string
let claudeJson: string
let folder: string
let agentsDir: string
let extraEnv: Record<string, string>
let logs: string[]
let changed: number
let trashed: string[]
let exts: Map<string, AgentExtensions>
let keys: VaultItem[] | 'locked'
let runConfigCalls: string[]
let runConfigOpts: Array<{ serversOff: boolean; skillsOff: boolean }>
let agentList: AgentSummary[]

const at = (name: string) => join(dir, name)
const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
const cliLog = (): string[][] => lines(at('cli.jsonl')).map((l) => JSON.parse(l))
const starts = () => lines(at('start.jsonl')).map((l) => JSON.parse(l) as { args: string[]; cwd: string; envNames: string[] })
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const fakeState = () => readJson(at('state.json'))

const ext = (over: Partial<AgentExtensions> = {}): AgentExtensions => ({
  serversOff: [],
  skillsOff: [],
  plugins: {},
  servers: [],
  serversEditable: true,
  hooks: {},
  hooksEditable: true,
  ...over
})
const key = (env: string, value: string): VaultItem => ({
  id: `id-${env}`,
  updatedAt: 1,
  name: env,
  agents: ['helper'],
  kind: 'apiKey',
  env,
  value,
  description: ''
})

const summary = (name: string, over: Partial<AgentSummary> = {}): AgentSummary => {
  const filePath = join(agentsDir, `${name}.md`)
  if (!existsSync(filePath)) writeFileSync(filePath, `---\nname: ${name}\ndescription: d\n---\nbody\n`)
  return { filePath, name, description: 'd', color: null, icon: null, error: null, builtIn: false, ...over }
}

const writeState = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    at('state.json'),
    JSON.stringify({
      version: '2.1.322',
      mcpServers: [
        {
          name: 'github',
          status: 'connected',
          config: { type: 'stdio', command: 'gh-mcp', env: { GH_TOKEN: SECRET } },
          transport: 'stdio',
          scope: 'user',
          tools: [{ name: 'issues' }]
        },
        {
          name: 'plugin:caveman:cave',
          status: 'connected',
          config: { type: 'http', headers: { Authorization: SECRET } },
          transport: 'http',
          scope: 'dynamic',
          source: 'plugin',
          tools: []
        },
        { name: 'claude.ai Gmail', status: 'needs-auth', config: {}, scope: 'claudeai', source: 'claudeai' }
      ],
      skills: [
        { name: 'mine', description: 'My own', source: 'user', tokens: 10, state: 'on' },
        { name: 'caveman:compress', description: 'c', source: 'plugin', tokens: 5, state: 'on' }
      ],
      // The fake lists the settings files' hooks itself, as the CLI does; these come after them.
      hooks: [
        // A user-settings row no file holds (as one the CLI read from a file this page does not know): listed, read-only.
        { event: 'PreToolUse', matcher: 'Bash', source: 'userSettings', type: 'command', commandText: 'from-probe.sh' },
        {
          event: 'SessionStart',
          matcher: '',
          source: 'pluginHook',
          pluginName: 'caveman@caveman',
          type: 'command',
          commandText: 'node x.js',
          timeout: 5
        }
      ],
      // The real list carries each plugin's server configs; none of it may reach the page.
      plugins: [
        { id: 'caveman@caveman', enabled: true, version: '1', mcpServers: { cave: { env: { K: SECRET } } } },
        { id: 'other@market', enabled: false }
      ],
      ...over
    })
  )

const USER_SETTINGS = () => join(claudeDir, 'settings.json')
const userSettings = {
  theme: 'dark',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh', timeout: 3 }] }] }
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-ext-svc-')))
  fakeClaude = writeFakeBin(dir, 'claude', FAKE)
  home = join(dir, 'home')
  claudeDir = join(home, '.claude')
  claudeJson = join(home, '.claude.json')
  folder = join(dir, 'work')
  agentsDir = join(dir, 'agents')
  // The work folder is its own repo, so its local servers' key is the folder whatever lies above the temp folder (an empty /tmp/.git was seen).
  for (const d of [claudeDir, folder, join(folder, '.git'), agentsDir, join(claudeDir, 'skills', 'mine')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(claudeDir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: My own\n---\nDo it.\n')
  writeFileSync(USER_SETTINGS(), JSON.stringify(userSettings, null, 2) + '\n')
  writeFileSync(
    claudeJson,
    JSON.stringify({
      numStartups: 3,
      mcpServers: { github: { type: 'stdio', command: 'gh-mcp', env: { GH_TOKEN: SECRET } } },
      projects: { [folder]: { mcpServers: { loc: { command: 'loc-mcp', headers: { H: SECRET } } } } }
    })
  )
  writeState()
  extraEnv = {}
  logs = []
  changed = 0
  trashed = []
  exts = new Map()
  keys = []
  runConfigCalls = []
  runConfigOpts = []
  agentList = [
    summary('helper'),
    summary('zumi-bot', { builtIn: true }),
    summary('desk', { computerUse: true }),
    summary('codexer', { provider: 'codex' })
  ]
})
afterEach(() => removeDir(dir))

// Nothing of the test process but PATH, which the fake's shebang needs to find node; HOME is the temp one.
const envOf = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  FAKE_EXT_STATE: at('state.json'),
  FAKE_EXT_CLI_OUT: at('cli.jsonl'),
  FAKE_EXT_START_OUT: at('start.jsonl'),
  ...extraEnv
})

const make = (over: Partial<ExtensionsDeps> = {}): ExtensionsService =>
  new ExtensionsService({
    locate: async () => fakeClaude,
    locateCodex: async () => null,
    env: async () => envOf(),
    home,
    agents: async () => agentList,
    extensionsOf: async (n) => exts.get(n) ?? null,
    runConfig: async (n, opts) => {
      runConfigCalls.push(n)
      runConfigOpts.push(opts)
      const e = exts.get(n)
      return e ? buildAgentRunConfig(e, keys, opts) : NO_RUN_CONFIG
    },
    trash: async (p) => {
      trashed.push(p)
    },
    now: () => 1000,
    onChanged: () => {
      changed++
    },
    log: (l) => {
      logs.push(l)
    },
    agentKeys: async () => ({}),
    probe: { timings: { pollMs: 20, killGraceMs: 300 } },
    ...over
  })

const names = (l: Loadout, section: 'servers' | 'skills') => l[section].map((r) => r.name)
// Everything the service could have leaked through: its own log lines and the page's answer.
const noSecret = (...texts: string[]) => {
  for (const t of texts) for (const s of [SECRET, NEW_SECRET, KEY_VALUE]) expect(t).not.toContain(s)
}

// Each CLI start goes through a launcher and a slower node start on Windows, so a test of several takes seconds there.
const SLOW = isWindows ? { timeout: 30_000 } : {}

describe('ExtensionsService.loadout', SLOW, () => {
  it("lists the CLI's rows, the plugins it counts and the file hooks, and nothing of ZumiBot's without an agent, with no secret", async () => {
    const l = await make().loadout(folder, null, false)
    expect(l).toMatchObject({ engine: 'claude', version: '2.1.322', folder, agent: null, errors: {}, at: 1000 })
    // A folder with no agent is not a run: ZumiBot's bridges and guard hooks belong to an agent's runs only.
    expect(names(l, 'servers')).toEqual(['github', 'plugin:caveman:cave', 'claude.ai Gmail'])
    expect(l.hooks.some((h) => h.source === 'zumibot')).toBe(false)
    expect(l.servers.find((s) => s.name === 'github')).toMatchObject({ source: 'user', scope: 'user', tools: ['issues'] })
    expect(names(l, 'skills')).toEqual(['mine', 'caveman:compress'])
    expect(l.skills.find((s) => s.name === 'mine')?.editable).toBe(true)
    // Counted by the plugin's name segment (`caveman`) against the list's `caveman@caveman`.
    expect(l.plugins).toEqual([
      { id: 'caveman@caveman', enabled: true, skills: 1, servers: 1, hooks: 1 },
      { id: 'other@market', enabled: false, skills: 0, servers: 0, hooks: 0 }
    ])
    // Ruling 24: the CLI's row joins its file row, which gives its place, its file's stamp and its timeout (the listing has none).
    const userHooks = l.hooks.filter((h) => h.source === 'user')
    expect(userHooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        type: 'command',
        command: 'check.sh',
        timeout: 3,
        source: 'user',
        plugin: null,
        at: { group: 0, hook: 0 },
        stamp: stampOf(readFileSync(USER_SETTINGS(), 'utf8'))
      },
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        type: 'command',
        command: 'from-probe.sh',
        timeout: null,
        source: 'user',
        plugin: null,
        at: null,
        stamp: null
      }
    ])
    expect(l.hooks.find((h) => h.source === 'plugin')).toMatchObject({ event: 'SessionStart', plugin: 'caveman@caveman' })
    noSecret(JSON.stringify(l), ...logs)
    expect(starts()).toHaveLength(1)
    expect(starts()[0].cwd).toBe(folder)
  })

  it('serves a second call from the cache, and refresh probes again', async () => {
    const s = make()
    const a = await s.loadout(folder, null, false)
    expect(await s.loadout(folder, null, false)).toEqual(a)
    expect(starts()).toHaveLength(1)
    await s.loadout(folder, null, true)
    expect(starts()).toHaveLength(2)
  })

  it('peek leaves nothing in the cache: the first page read after it probes the files as they are then', async () => {
    const s = make()
    await s.peek(folder)
    expect(starts()).toHaveLength(1)
    await s.loadout(folder, null, false)
    expect(starts()).toHaveLength(2)
    // The page's own read is cached as before, and peek then reads that answer for free.
    await s.loadout(folder, null, false)
    await s.peek(folder)
    expect(starts()).toHaveLength(2)
  })

  it('peek joins a probe already running and is refused after stop()', async () => {
    extraEnv = { FAKE_EXT_PENDING_POLLS: '3' }
    const s = make()
    const [a, b] = await Promise.all([s.loadout(folder, null, false), s.peek(folder)])
    expect(b).toEqual(a)
    expect(starts()).toHaveLength(1)
    await s.stop()
    await expect(s.peek(folder)).rejects.toThrow()
  })

  it('shares one probe between callers asking for the same key at once', async () => {
    extraEnv = { FAKE_EXT_PENDING_POLLS: '3' }
    const s = make()
    const [a, b, c] = await Promise.all([s.loadout(folder, null, false), s.loadout(folder, null, false), s.loadout(folder, null, true)])
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(starts()).toHaveLength(1)
  })

  it('runs at most two probes at once and queues the rest', async () => {
    extraEnv = { FAKE_EXT_PENDING_POLLS: '3' }
    let running = 0
    let most = 0
    const s = make({
      probe: {
        timings: { pollMs: 50, killGraceMs: 300 },
        claude: async (o) => {
          most = Math.max(most, ++running)
          try {
            return await probeClaude(o)
          } finally {
            running--
          }
        }
      }
    })
    const folders = ['a', 'b', 'c'].map((n) => {
      const f = join(dir, n)
      mkdirSync(f)
      return f
    })
    const all = await Promise.all(folders.map((f) => s.loadout(f, null, false)))
    expect(all.map((l) => l.folder)).toEqual(folders)
    expect(most).toBe(2)
    expect(starts()).toHaveLength(3)
  })

  // A probe the test holds until it lets it go, recording which folder each started for.
  const heldProbes = () => {
    const started: string[] = []
    const release = new Map<string, () => void>()
    const empty: ProbeAnswers = { version: '9', mcp: { mcpServers: [] }, skills: { skills: [] }, hooks: { hooks: [] }, errors: {} }
    const claude = async (o: { folder: string }): Promise<ProbeAnswers> => {
      started.push(o.folder)
      await new Promise<void>((r) => release.set(o.folder, r))
      return empty
    }
    const until = async (n: number) => {
      // By the clock, not a count of 5 ms sleeps: a Windows timer tick is 15 ms, and a loaded CI runner is slower still.
      const deadline = Date.now() + 10_000
      while (started.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    }
    return { started, release, claude, until }
  }

  it('starts queued probes in the order they were asked for (FIFO), two at a time', async () => {
    const h = heldProbes()
    const s = make({ probe: { claude: h.claude as never } })
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => {
      const f = join(dir, n)
      mkdirSync(f)
      return f
    })
    const all = [a, b, c, d].map((f) => s.loadout(f, null, false))
    await h.until(2)
    expect(h.started).toEqual([a, b])
    // The second one ends first: the oldest waiting probe (c) takes its slot, not the newest.
    h.release.get(b)!()
    await h.until(3)
    expect(h.started).toEqual([a, b, c])
    h.release.get(a)!()
    await h.until(4)
    expect(h.started).toEqual([a, b, c, d])
    h.release.get(c)!()
    h.release.get(d)!()
    await Promise.all(all)
  })

  it('never caches a probe that was running across a write (it may have read the old files)', async () => {
    const h = heldProbes()
    const s = make({ probe: { claude: h.claude as never } })
    const first = s.loadout(folder, null, false)
    await h.until(1)
    await s.setSkill('mine', false)
    h.release.get(folder)!()
    await first
    // Asked again with no refresh: the answer from before the write is not served.
    const second = s.loadout(folder, null, false)
    await h.until(2)
    expect(h.started).toEqual([folder, folder])
    h.release.get(folder)!()
    await second
  })

  it('probes again once a write forgot the cache, and tells the pages', async () => {
    const s = make()
    await s.loadout(folder, null, false)
    await s.setSkill('mine', false)
    expect(changed).toBe(1)
    await s.loadout(folder, null, false)
    expect(starts()).toHaveLength(2)
    s.forget()
    await s.loadout(folder, null, false)
    expect(starts()).toHaveLength(3)
  })

  it("keys the cache on the agent file's text", async () => {
    exts.set('helper', ext())
    const s = make()
    await s.loadout(folder, 'helper', false)
    await s.loadout(folder, 'helper', false)
    expect(starts()).toHaveLength(1)
    writeFileSync(agentList[0].filePath, '---\nname: helper\ndescription: changed\n---\nbody\n')
    await s.loadout(folder, 'helper', false)
    expect(starts()).toHaveLength(2)
  })

  it('probes an agent with its own args and Vault env, marks its own servers and shows the ones a run leaves out', async () => {
    keys = [key('TOKEN', KEY_VALUE)]
    exts.set(
      'helper',
      ext({
        serversOff: ['github'],
        servers: [
          { name: 'mine', def: { command: 'mine-mcp', env: { T: '${vault:TOKEN}' } } },
          { name: 'needkey', def: { type: 'http', url: 'https://x.invalid', headers: { K: '${vault:MISSING}' } } },
          { name: 'zumibot_x', def: { command: 'y' } },
          { name: 'github', def: null }
        ]
      })
    )
    const state = JSON.parse(readFileSync(at('state.json'), 'utf8'))
    state.mcpServers.push({
      name: 'mine',
      status: 'connected',
      config: { command: 'mine-mcp', env: { T: KEY_VALUE } },
      scope: 'dynamic',
      tools: [{ name: 't' }]
    })
    writeFileSync(at('state.json'), JSON.stringify(state))

    const l = await make().loadout(folder, 'helper', false)
    const [start] = starts()
    expect(start.args.slice(start.args.indexOf('--agent'), start.args.indexOf('--agent') + 2)).toEqual(['--agent', 'helper'])
    // Ruling 4: the agent's own servers start with their Vault values, through env only.
    expect(start.envNames).toContain('ZUMIBOT_MCP_VAULT_0')
    expect(JSON.stringify(start.args)).not.toContain(KEY_VALUE)
    // A server the agent turned off is still probed, so it can be switched back on.
    expect(JSON.stringify(start.args)).not.toContain('deniedMcpServers')
    expect(l.servers.find((s) => s.name === 'mine')).toMatchObject({
      source: 'agent',
      transport: 'stdio',
      status: 'connected',
      tools: ['t']
    })
    expect(l.servers.find((s) => s.name === 'github')).toMatchObject({ source: 'user' })
    expect(l.servers.find((s) => s.name === 'needkey')).toEqual({
      name: 'needkey',
      status: 'disabled',
      source: 'agent',
      transport: 'http',
      plugin: null,
      tools: [],
      scope: null,
      note: EXT_TEXT.vaultMissing('MISSING'),
      connector: null
    })
    expect(l.servers.find((s) => s.name === 'zumibot_x')).toMatchObject({
      status: 'disabled',
      source: 'agent',
      note: EXT_TEXT.reservedName
    })
    noSecret(JSON.stringify(l), ...logs)
  })

  it("relabels only the CLI's unscoped row of an own server, and flags an own server that shares a configured server's name", async () => {
    exts.set(
      'helper',
      ext({
        servers: [
          { name: 'github', def: { command: 'my-gh' } },
          { name: 'solo', def: { command: 'solo-mcp' } }
        ]
      })
    )
    const state = fakeState()
    // As claude 2.1.322 lists it: the --mcp-config `github` replaces the user's, unscoped ('dynamic').
    state.mcpServers = state.mcpServers.filter((x: { name: string }) => x.name !== 'github')
    state.mcpServers.push(
      { name: 'github', status: 'connected', config: { command: 'my-gh' }, scope: 'dynamic', tools: [] },
      { name: 'solo', status: 'connected', config: { command: 'solo-mcp' }, scope: 'dynamic', tools: [] }
    )
    writeFileSync(at('state.json'), JSON.stringify(state))
    const l = await make().loadout(folder, 'helper', false)
    // The user's own github is in ~/.claude.json: the agent's replaces it, which the card says.
    expect(l.servers.filter((x) => x.name === 'github')).toEqual([
      expect.objectContaining({ source: 'agent', scope: null, note: EXT_TEXT.sameName })
    ])
    expect(l.servers.find((x) => x.name === 'solo')).toMatchObject({ source: 'agent', note: null })

    // A CLI that lists both keeps the user's row as the user's.
    state.mcpServers.push({ name: 'github', status: 'connected', config: { command: 'gh-mcp' }, scope: 'user', tools: [] })
    writeFileSync(at('state.json'), JSON.stringify(state))
    const both = await make().loadout(folder, 'helper', true)
    expect(both.servers.filter((x) => x.name === 'github').map((x) => [x.source, x.scope])).toEqual([
      ['agent', null],
      ['user', 'user']
    ])
  })

  it("gives an agent's probe the agent's granted API keys as env, as its runs get them, and a folder's probe none", async () => {
    keys = [key('TOKEN', KEY_VALUE)]
    exts.set('helper', ext())
    const s = make({ agentKeys: async (n): Promise<Record<string, string>> => (n === 'helper' ? { TOKEN: KEY_VALUE } : {}) })
    const l = await s.loadout(folder, 'helper', false)
    await s.loadout(folder, null, false)
    const [agentStart, folderStart] = starts()
    expect(agentStart.envNames).toContain('TOKEN')
    expect(folderStart.envNames).not.toContain('TOKEN')
    expect(JSON.stringify(agentStart.args)).not.toContain(KEY_VALUE)
    noSecret(JSON.stringify(l), ...logs)
  })

  it("probes without the agent's own skillsOff and serversOff, so those rows can be switched back on", async () => {
    const hook = { type: 'command' as const, command: './check.sh' }
    exts.set(
      'helper',
      ext({
        serversOff: ['github'],
        skillsOff: ['apple-design'],
        plugins: { 'a@m': false },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] }
      })
    )
    await make().loadout(folder, 'helper', false)
    expect(runConfigOpts).toEqual([{ serversOff: false, skillsOff: false }])
    const [start] = starts()
    const text = JSON.stringify(start.args)
    expect(text).not.toContain('skillOverrides')
    expect(text).not.toContain('deniedMcpServers')
    // What the run adds besides those two still rides: the agent's hooks and its plugin overrides.
    const settings = JSON.parse(start.args[start.args.indexOf('--settings') + 1])
    expect(settings).toEqual({ enabledPlugins: { 'a@m': false }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } })
  })

  it('notes a locked Vault on every own server that names a key', async () => {
    keys = 'locked'
    exts.set('helper', ext({ servers: [{ name: 'mine', def: { command: 'm', env: { T: '${vault:TOKEN}' } } }] }))
    const l = await make().loadout(folder, 'helper', false)
    expect(l.servers.find((s) => s.name === 'mine')).toMatchObject({ status: 'disabled', note: EXT_TEXT.vaultLocked })
  })

  it("adds Zumi Bot's automations bridge, not the ask bridge, and a computer-use agent's desktop", async () => {
    const s = make()
    const bot = await s.loadout(folder, 'zumi-bot', false)
    expect(names(bot, 'servers')).toContain('zumibot_automations')
    expect(names(bot, 'servers')).not.toContain('zumibot_agents')
    expect(names(bot, 'servers')).not.toContain('zumibot_desktop')
    const desk = await s.loadout(folder, 'desk', false)
    expect(names(desk, 'servers')).toEqual(expect.arrayContaining(['zumibot_agents', 'zumibot_desktop']))
    expect(desk.hooks.filter((h) => h.source === 'zumibot')).toHaveLength(3)
    const plain = await s.loadout(folder, 'helper', false)
    expect(names(plain, 'servers')).not.toContain('zumibot_desktop')
  })

  it('lists the recall bridge only for an agent with recall on', async () => {
    agentList.push(summary('rememberer', { recall: 'folder' }))
    const s = make()
    expect(names(await s.loadout(folder, 'rememberer', false), 'servers')).toContain('zumibot_recall')
    expect(names(await s.loadout(folder, 'helper', false), 'servers')).not.toContain('zumibot_recall')
  })

  it('probes a Codex agent with codex, lists no plugins and builds no per-agent config', async () => {
    const answers: ProbeAnswers = {
      version: '0.164.0',
      mcp: { data: [{ name: 'codex_apps', runtimeStatus: null, tools: { a: {} } }] },
      skills: { data: [] },
      hooks: { data: [] },
      errors: {}
    }
    const asked: string[] = []
    const s = make({
      locateCodex: async () => '/opt/codex',
      probe: {
        codex: async (o) => {
          asked.push(`${o.bin} ${o.folder}`)
          return answers
        }
      }
    })
    const l = await s.loadout(folder, 'codexer', false)
    expect(asked).toEqual([`/opt/codex ${folder}`])
    expect(l).toMatchObject({ engine: 'codex', version: '0.164.0', plugins: [], errors: {} })
    expect(names(l, 'servers')).toEqual(['codex_apps', 'zumibot_browser', 'zumibot_todos', 'zumibot_vault', 'zumibot_agents'])
    expect(l.hooks.filter((h) => h.source === 'zumibot')).toHaveLength(2)
    expect(runConfigCalls).toEqual([])
    expect(cliLog()).toEqual([])
    expect(starts()).toEqual([])
  })

  it('probes nothing for an ACP agent: every section says the agent keeps its own, with no ZumiBot rows', async () => {
    agentList.push(summary('gem', { provider: 'acp' }))
    const asked: string[] = []
    const s = make({
      locateCodex: async () => '/opt/codex',
      probe: {
        codex: async (o) => {
          asked.push(o.bin)
          return { version: null, mcp: null, skills: null, hooks: null, errors: {} }
        }
      }
    })
    const l = await s.loadout(folder, 'gem', false)
    const text = EXT_TEXT.acpUnsupported
    expect(l).toMatchObject({ engine: 'acp', version: null, agent: 'gem', servers: [], plugins: [], skills: [], hooks: [] })
    expect(l.errors).toEqual({ servers: text, plugins: text, skills: text, hooks: text })
    expect(asked).toEqual([])
    expect(runConfigCalls).toEqual([])
    expect(cliLog()).toEqual([])
    expect(starts()).toEqual([])
  })

  it('probes nothing for a remote agent: every section says its server keeps its own, with no ZumiBot rows', async () => {
    agentList.push(summary('rem', { provider: 'ag-ui' }))
    const asked: string[] = []
    const s = make({
      locateCodex: async () => '/opt/codex',
      probe: {
        codex: async (o) => {
          asked.push(o.bin)
          return { version: null, mcp: null, skills: null, hooks: null, errors: {} }
        }
      }
    })
    const l = await s.loadout(folder, 'rem', false)
    const text = EXT_TEXT.aguiUnsupported
    expect(l).toMatchObject({ engine: 'ag-ui', version: null, agent: 'rem', servers: [], plugins: [], skills: [], hooks: [] })
    expect(l.errors).toEqual({ servers: text, plugins: text, skills: text, hooks: text })
    expect(text).not.toMatch(/ACP|Codex/)
    expect(asked).toEqual([])
    expect(runConfigCalls).toEqual([])
    expect(cliLog()).toEqual([])
    expect(starts()).toEqual([])
  })

  it("says Claude Code is missing in every section and still lists what ZumiBot adds to an agent's runs", async () => {
    const l = await make({ locate: async () => null }).loadout(folder, 'helper', false)
    expect(l.errors).toEqual({
      servers: EXT_TEXT.cliMissing,
      skills: EXT_TEXT.cliMissing,
      hooks: EXT_TEXT.cliMissing,
      plugins: EXT_TEXT.cliMissing
    })
    expect(names(l, 'servers')).toContain('zumibot_browser')
    expect(names(await make({ locate: async () => null }).loadout(folder, null, false), 'servers')).toEqual([])
  })

  describe("the hooks list is the CLI's (Ruling 24)", () => {
    it("lists a hook of the repo root's settings.local.json, which the CLI loads for a subfolder, read-only; the folder's own is editable", async () => {
      const repo = join(dir, 'repo')
      const sub = join(repo, 'sub')
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(join(repo, '.claude'), { recursive: true })
      mkdirSync(join(sub, '.claude'), { recursive: true })
      writeFileSync(
        join(repo, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'root-local.sh' }] }] } })
      )
      writeFileSync(
        join(sub, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sub-local.sh', timeout: 4 }] }] } })
      )
      const l = await make().loadout(sub, null, false)
      const local = l.hooks.filter((h) => h.source === 'local')
      expect(local.find((h) => h.command === 'sub-local.sh')).toMatchObject({
        at: { group: 0, hook: 0 },
        stamp: stampOf(readFileSync(join(sub, '.claude', 'settings.local.json'), 'utf8')),
        timeout: 4
      })
      expect(local.find((h) => h.command === 'root-local.sh')).toMatchObject({ at: null, stamp: null })
      expect(local).toHaveLength(2)
    })

    it('leaves out the hooks of a file the CLI did not load (a PreToolUse hook timed 0 drops the whole file)', async () => {
      mkdirSync(join(folder, '.claude'), { recursive: true })
      writeFileSync(
        join(folder, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'never-loaded.sh' }] }],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'zero.sh', timeout: 0 }] }]
          }
        })
      )
      const l = await make().loadout(folder, null, false)
      expect(l.hooks.some((h) => h.source === 'project')).toBe(false)
      expect(l.hooks.some((h) => h.command === 'check.sh' && h.at !== null)).toBe(true)
    })

    it('joins two identical hooks of one file to their own places', async () => {
      const twice = {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'same.sh' },
                { type: 'command', command: 'same.sh' }
              ]
            }
          ]
        }
      }
      writeFileSync(USER_SETTINGS(), JSON.stringify(twice))
      const l = await make().loadout(folder, null, false)
      expect(l.hooks.filter((h) => h.command === 'same.sh').map((h) => h.at)).toEqual([
        { group: 0, hook: 0 },
        { group: 0, hook: 1 }
      ])
    })
  })

  it('names a settings file that is not JSON in the hooks section and still lists servers and skills', async () => {
    writeFileSync(USER_SETTINGS(), '{bad')
    const l = await make().loadout(folder, null, false)
    expect(l.errors).toEqual({ hooks: EXT_TEXT.badJson('Your settings.json') })
    expect(names(l, 'servers')).toContain('github')
    expect(names(l, 'skills')).toEqual(['mine', 'caveman:compress'])
    expect(l.hooks.some((h) => h.source === 'plugin')).toBe(true)
  })

  it('refuses an agent no one has', async () => {
    await expect(make().loadout(folder, 'nobody', false)).rejects.toThrow(EXT_TEXT.notFound)
  })
})

describe('ExtensionsService servers', SLOW, () => {
  it('shows a user server with its values hidden and a stamp of its own definition only', async () => {
    const s = make()
    const v = await s.server(folder, 'user', 'github')
    expect(v).toMatchObject({
      name: 'github',
      scope: 'user',
      def: { type: 'stdio', command: 'gh-mcp', env: { GH_TOKEN: '' } },
      hidden: { env: ['GH_TOKEN'], headers: [] }
    })
    expect(v.stamp).toMatch(/^[0-9a-f]{64}$/)
    noSecret(JSON.stringify(v))
    // The CLI rewrites ~/.claude.json all the time: only a change to this server makes the stamp stale.
    const json = readJson(claudeJson)
    json.numStartups = 4
    writeFileSync(claudeJson, JSON.stringify(json))
    expect((await s.server(folder, 'user', 'github')).stamp).toBe(v.stamp)
    json.mcpServers.github.args = ['x']
    writeFileSync(claudeJson, JSON.stringify(json))
    expect((await s.server(folder, 'user', 'github')).stamp).not.toBe(v.stamp)
    const local = await s.server(folder, 'local', 'loc')
    expect(local.hidden.headers).toEqual(['H'])
    await expect(s.server(folder, 'user', 'nope')).rejects.toThrow(EXT_TEXT.notFound)
  })

  it('edits a user server through the CLI: remove, then add-json with the scope after the name, values never logged', async () => {
    const s = make()
    const { stamp } = await s.server(folder, 'user', 'github')
    await s.saveServer(
      folder,
      'user',
      'github',
      { type: 'stdio', command: 'gh-mcp', args: ['--x'], env: { GH_TOKEN: null, NEW: NEW_SECRET } },
      undefined,
      stamp
    )
    expect(cliLog()).toEqual([
      ['mcp', 'remove', 'github', '-s', 'user'],
      [
        'mcp',
        'add-json',
        'github',
        JSON.stringify({ type: 'stdio', command: 'gh-mcp', args: ['--x'], env: { GH_TOKEN: '<value>', NEW: '<value>' } }),
        '-s',
        'user'
      ]
    ])
    // A blank value kept the stored one; the CLI got both values.
    expect(fakeState().mcpServers.find((x: { name: string }) => x.name === 'github').config.env).toEqual({
      GH_TOKEN: SECRET,
      NEW: NEW_SECRET
    })
    expect(changed).toBe(1)
    noSecret(...logs)
    expect(logs.join('\n')).not.toContain('{')
  })

  it('refuses a stale user server edit before the CLI runs', async () => {
    await expect(make().saveServer(folder, 'user', 'github', { command: 'x' }, undefined, 'f'.repeat(64))).rejects.toThrow(EXT_TEXT.stale)
    expect(cliLog()).toEqual([])
  })

  it('puts the old server back when the add fails, and says so', async () => {
    extraEnv = { FAKE_EXT_FAIL_ADD_ONCE: at('failed-once') }
    const s = make()
    const { stamp } = await s.server(folder, 'user', 'github')
    const err = await s
      .saveServer(folder, 'user', 'github', { command: 'broken', env: { GH_TOKEN: null } }, undefined, stamp)
      .catch((e: Error) => e)
    expect((err as Error).message).toBe(EXT_TEXT.addFailedRestored)
    const log = cliLog()
    expect(log.map((a) => a.slice(0, 3))).toEqual([
      ['mcp', 'remove', 'github'],
      ['mcp', 'add-json', 'github'],
      ['mcp', 'add-json', 'github']
    ])
    expect(JSON.parse(log[2][3])).toEqual({ type: 'stdio', command: 'gh-mcp', env: { GH_TOKEN: '<value>' } })
    expect(fakeState().mcpServers.find((x: { name: string }) => x.name === 'github').config).toEqual({
      type: 'stdio',
      command: 'gh-mcp',
      env: { GH_TOKEN: SECRET }
    })
    expect(changed).toBe(1)
    noSecret((err as Error).message, ...logs)
  })

  it('says so when the old server could not be put back either', async () => {
    extraEnv = { FAKE_EXT_FAIL_ADD: '1' }
    const s = make()
    const { stamp } = await s.server(folder, 'user', 'github')
    await expect(s.saveServer(folder, 'user', 'github', { command: 'broken' }, undefined, stamp)).rejects.toThrow(EXT_TEXT.addFailedLost)
  })

  it('adds a new local server, and refuses a new one whose name is taken', async () => {
    const s = make()
    await s.saveServer(folder, 'local', 'fresh', { command: 'f', env: { A: NEW_SECRET } })
    expect(cliLog()).toEqual([['mcp', 'add-json', 'fresh', JSON.stringify({ command: 'f', env: { A: '<value>' } }), '-s', 'local']])
    await expect(s.saveServer(folder, 'user', 'github', { command: 'x' })).rejects.toThrow(EXT_TEXT.nameTaken)
    expect(cliLog()).toHaveLength(1)
  })

  it('refuses a definition outside the CLI format with its own sentence', async () => {
    await expect(make().saveServer(folder, 'project', 'p', { args: ['a'] })).rejects.toThrow(EXT_TEXT.badServer)
  })

  it('writes project servers into .mcp.json: create, stale, rename keeping a blank value', async () => {
    const mcp = join(folder, '.mcp.json')
    writeFileSync(mcp, JSON.stringify({ mcpServers: { keep: { command: 'k' } } }))
    const s = make()
    await s.saveServer(folder, 'project', 'new', { command: 'n', env: { A: 'v' } })
    const view = await s.server(folder, 'project', 'new')
    expect(view.stamp).toBe(stampOf(readFileSync(mcp, 'utf8')))
    await expect(s.saveServer(folder, 'project', 'new', { command: 'n2' }, undefined, stampOf('old'))).rejects.toThrow(EXT_TEXT.stale)
    await s.saveServer(folder, 'project', 'renamed', { command: 'n2', env: { A: null } }, 'new', view.stamp)
    expect(readJson(mcp)).toEqual({ mcpServers: { keep: { command: 'k' }, renamed: { command: 'n2', env: { A: 'v' } } } })
    await s.removeServer(folder, 'project', 'renamed')
    expect(readJson(mcp)).toEqual({ mcpServers: { keep: { command: 'k' } } })
    expect(cliLog()).toEqual([])
  })

  it("finds a repo subfolder's local servers under the repo root, as the CLI files them: view, stale edit, edit, remove", async () => {
    const repo = join(dir, 'repo')
    const sub = join(repo, 'packages', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    const json = readJson(claudeJson)
    json.projects[repo] = { mcpServers: { 'sub-loc': { command: 'sub-mcp', env: { K: SECRET } } } }
    writeFileSync(claudeJson, JSON.stringify(json))
    const state = fakeState()
    state.mcpServers.push({
      name: 'sub-loc',
      status: 'connected',
      config: { command: 'sub-mcp', env: { K: SECRET } },
      scope: 'local',
      tools: []
    })
    writeFileSync(at('state.json'), JSON.stringify(state))

    const s = make()
    const view = await s.server(sub, 'local', 'sub-loc')
    expect(view).toMatchObject({ name: 'sub-loc', scope: 'local', def: { command: 'sub-mcp', env: { K: '' } }, hidden: { env: ['K'] } })
    await expect(s.saveServer(sub, 'local', 'sub-loc', { command: 'x' }, undefined, 'f'.repeat(64))).rejects.toThrow(EXT_TEXT.stale)
    expect(cliLog()).toEqual([])
    await s.saveServer(sub, 'local', 'sub-loc', { command: 'sub-mcp2', env: { K: null } }, undefined, view.stamp)
    expect(cliLog()).toEqual([
      ['mcp', 'remove', 'sub-loc', '-s', 'local'],
      ['mcp', 'add-json', 'sub-loc', JSON.stringify({ command: 'sub-mcp2', env: { K: '<value>' } }), '-s', 'local']
    ])
    // The old def was found under the repo key, so its hidden value went back to the CLI.
    expect(fakeState().mcpServers.find((x: { name: string }) => x.name === 'sub-loc').config).toEqual({
      command: 'sub-mcp2',
      env: { K: SECRET }
    })
    await s.removeServer(sub, 'local', 'sub-loc')
    expect(cliLog()[2]).toEqual(['mcp', 'remove', 'sub-loc', '-s', 'local'])
    // The raw folder is no key: nothing is filed under it.
    expect(json.projects[sub]).toBeUndefined()
  })

  it('.mcp.json servers the CLI reads from a parent folder are read-only and say where they come from', async () => {
    const repo = join(dir, 'repo')
    const sub = join(repo, 'sub')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { rootsrv: { command: 'r' } } }))
    writeFileSync(join(sub, '.mcp.json'), JSON.stringify({ mcpServers: { subsrv: { command: 's' } } }))
    const state = fakeState()
    state.mcpServers.push(
      { name: 'rootsrv', status: 'connected', config: {}, scope: 'project', tools: [] },
      { name: 'subsrv', status: 'connected', config: {}, scope: 'project', tools: [] }
    )
    writeFileSync(at('state.json'), JSON.stringify(state))
    const l = await make().loadout(sub, null, false)
    expect(l.servers.find((x) => x.name === 'subsrv')).toMatchObject({ source: 'project', scope: 'project', note: null })
    expect(l.servers.find((x) => x.name === 'rootsrv')).toMatchObject({
      source: 'project',
      scope: null,
      note: EXT_TEXT.fromParentMcp(repo)
    })
  })

  it('removes a user server through the CLI', async () => {
    await make().removeServer(folder, 'user', 'github')
    expect(cliLog()).toEqual([['mcp', 'remove', 'github', '-s', 'user']])
  })
})

describe('ExtensionsService plugins, skills and hooks', SLOW, () => {
  it('turns a plugin off through the CLI', async () => {
    const s = make()
    await s.setPlugin('caveman@caveman', false)
    expect(cliLog()).toEqual([['plugin', 'disable', 'caveman@caveman']])
    expect(changed).toBe(1)
    await expect(s.setPlugin('nope@x', true)).rejects.toThrow(EXT_TEXT.cliFailed)
  })

  it('turns a skill off in the user settings file and on again', async () => {
    const s = make()
    await s.setSkill('a', false)
    expect(readJson(USER_SETTINGS())).toEqual({ ...userSettings, skillOverrides: { a: 'off' } })
    await s.setSkill('a', true)
    expect(readJson(USER_SETTINGS())).toEqual(userSettings)
  })

  it('lists the user skills by name with their descriptions, skipping a folder with no readable SKILL.md', async () => {
    const s = make()
    mkdirSync(join(claudeDir, 'skills', 'empty-folder'))
    await s.saveSkill('user', folder, { name: 'a-first', description: 'First', body: 'b' })
    expect(await s.userSkills()).toEqual([
      { name: 'a-first', description: 'First' },
      { name: 'mine', description: 'My own' }
    ])
  })

  it('creates, reads, edits and removes a user skill, and never overwrites one on create', async () => {
    const s = make()
    await s.saveSkill('user', folder, { name: 'new-one', description: 'New', body: 'Steps' })
    expect(readFileSync(join(claudeDir, 'skills', 'new-one', 'SKILL.md'), 'utf8')).toContain('Steps')
    const mineFile = join(claudeDir, 'skills', 'mine', 'SKILL.md')
    const before = readFileSync(mineFile, 'utf8')
    await expect(s.saveSkill('user', folder, { name: 'mine', description: 'Other', body: 'x' })).rejects.toThrow(EXT_TEXT.nameTaken)
    await expect(s.saveSkill('user', folder, { name: 'synced', description: 'x', body: 'x' })).rejects.toThrow(EXT_TEXT.nameTaken)
    expect(readFileSync(mineFile, 'utf8')).toBe(before)
    const view = await s.skill('user', folder, 'mine')
    expect(view).toMatchObject({ scope: 'user', name: 'mine', description: 'My own', body: 'Do it.\n' })
    await expect(s.saveSkill('user', folder, { name: 'mine', description: 'D', body: 'B', stamp: stampOf('x') })).rejects.toThrow(
      EXT_TEXT.stale
    )
    await s.saveSkill('user', folder, { name: 'mine', description: 'D', body: 'B\n', stamp: view.stamp })
    expect((await s.skill('user', folder, 'mine')).description).toBe('D')
    await s.removeSkill('user', folder, 'mine')
    expect(trashed).toEqual([join(claudeDir, 'skills', 'mine')])
    await expect(s.skill('user', folder, 'gone')).rejects.toThrow(EXT_TEXT.notFound)
  })

  it("writes a project skill under the folder's .claude/skills", async () => {
    await make().saveSkill('project', folder, { name: 'proj', description: 'P', body: 'b' })
    expect(existsSync(join(folder, '.claude', 'skills', 'proj', 'SKILL.md'))).toBe(true)
  })

  it('adds, edits and removes hooks in each settings file, with the stale check', async () => {
    const s = make()
    await s.saveHook('project', folder, { event: 'Stop', matcher: '', command: 'done.sh' }, null)
    const projectFile = join(folder, '.claude', 'settings.json')
    expect(readJson(projectFile)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }] } })
    await s.saveHook('local', folder, { event: 'Stop', matcher: '', command: 'l.sh', timeout: 9 }, null)
    expect(readJson(join(folder, '.claude', 'settings.local.json')).hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: 'l.sh',
      timeout: 9
    })

    const l = await s.loadout(folder, null, false)
    const row = l.hooks.find((h) => h.source === 'project')!
    expect(row).toMatchObject({ command: 'done.sh', at: { group: 0, hook: 0 } })
    await expect(s.saveHook('project', folder, { event: 'Stop', matcher: '', command: 'x', at: row.at! }, stampOf('old'))).rejects.toThrow(
      EXT_TEXT.stale
    )
    await s.saveHook('project', folder, { event: 'Stop', matcher: '', command: 'edited.sh', at: row.at! }, row.stamp)
    expect(readJson(projectFile).hooks.Stop[0].hooks[0].command).toBe('edited.sh')
    await s.removeHook('project', folder, 'Stop', row.at!, stampOf(readFileSync(projectFile, 'utf8')))
    expect(readJson(projectFile)).toEqual({ hooks: {} })
  })

  // Ruling 25: a cloned repo's links never redirect a project write, and the page shows those rows read-only.
  // Links .mcp.json to a file too, so it needs file symlinks.
  it.skipIf(!symlinksWork)('shows the rows of linked project files read-only and refuses every write through them', async () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(join(elsewhere, 'skills', 'linked-skill'), { recursive: true })
    writeFileSync(join(elsewhere, 'skills', 'linked-skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: x\n---\nb\n')
    writeFileSync(
      join(elsewhere, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'linked.sh' }] }] } })
    )
    // .claude -> elsewhere (holding settings.json and skills/), .mcp.json -> ~/.claude.json
    symlinkSync(elsewhere, join(folder, '.claude'))
    symlinkSync(claudeJson, join(folder, '.mcp.json'))
    const before = readFileSync(claudeJson, 'utf8')
    const state = fakeState()
    state.mcpServers.push({ name: 'github', status: 'connected', config: {}, scope: 'project', tools: [] })
    state.skills.push({ name: 'linked-skill', description: 'x', source: 'project', tokens: 1, state: 'on' })
    writeFileSync(at('state.json'), JSON.stringify(state))

    const s = make()
    const l = await s.loadout(folder, null, false)
    expect(l.servers.find((x) => x.source === 'project')).toMatchObject({ name: 'github', scope: null, note: EXT_TEXT.linkedFile })
    expect(l.skills.find((x) => x.name === 'linked-skill')?.editable).toBe(false)
    expect(l.hooks.find((h) => h.command === 'linked.sh')).toMatchObject({ source: 'project', at: null, stamp: null })

    await expect(s.saveServer(folder, 'project', 'evil', { command: 'x' })).rejects.toThrow(EXT_TEXT.notEditable)
    await expect(s.removeServer(folder, 'project', 'github')).rejects.toThrow(EXT_TEXT.notEditable)
    await expect(s.saveHook('project', folder, { event: 'Stop', matcher: '', command: 'evil.sh' }, null)).rejects.toThrow(
      EXT_TEXT.notEditable
    )
    await expect(s.saveHook('local', folder, { event: 'Stop', matcher: '', command: 'evil.sh' }, null)).rejects.toThrow(
      EXT_TEXT.notEditable
    )
    await expect(s.saveSkill('project', folder, { name: 'evil', description: 'd', body: 'b' })).rejects.toThrow(EXT_TEXT.notEditable)
    await expect(s.removeSkill('project', folder, 'linked-skill')).rejects.toThrow(EXT_TEXT.notEditable)
    expect(readFileSync(claudeJson, 'utf8')).toBe(before)
    expect(readdirSync(elsewhere).sort()).toEqual(['settings.json', 'skills'])
    expect(readdirSync(join(elsewhere, 'skills'))).toEqual(['linked-skill'])
    expect(trashed).toEqual([])
  })

  it('keeps both keys when writes to one settings file overlap', async () => {
    const s = make()
    await Promise.all([
      s.setSkill('a', false),
      s.setSkill('b', false),
      s.saveHook('user', folder, { event: 'Stop', matcher: '', command: 'one.sh' }, null),
      s.saveHook('user', folder, { event: 'Stop', matcher: '', command: 'two.sh' }, null)
    ])
    const out = readJson(USER_SETTINGS())
    expect(out.skillOverrides).toEqual({ a: 'off', b: 'off' })
    expect(out.hooks.Stop[0].hooks.map((h: { command: string }) => h.command).sort()).toEqual(['one.sh', 'two.sh'])
    expect(changed).toBe(4)
  })
})

describe('ExtensionsService paths and stop', SLOW, () => {
  it("reads and writes the user's settings where the CLI will look: CLAUDE_CONFIG_DIR of the run env, not this process's", async () => {
    const cfg = join(dir, 'cfg')
    mkdirSync(join(cfg, 'skills', 'cfg-skill'), { recursive: true })
    writeFileSync(join(cfg, 'skills', 'cfg-skill', 'SKILL.md'), '---\nname: cfg-skill\ndescription: c\n---\nb\n')
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cfg.sh' }] }] } }))
    const state = fakeState()
    state.skills.push({ name: 'cfg-skill', description: 'c', source: 'user', tokens: 1, state: 'on' })
    writeFileSync(at('state.json'), JSON.stringify(state))
    extraEnv = { CLAUDE_CONFIG_DIR: cfg }
    const s = make()
    await s.setSkill('a', false)
    expect(readJson(join(cfg, 'settings.json')).skillOverrides).toEqual({ a: 'off' })
    expect(readJson(USER_SETTINGS())).toEqual(userSettings)
    const l = await s.loadout(folder, null, false)
    expect(l.hooks.find((h) => h.command === 'cfg.sh')).toMatchObject({ source: 'user', at: { group: 0, hook: 0 } })
    expect(l.hooks.some((h) => h.command === 'check.sh')).toBe(false)
    expect(l.skills.find((x) => x.name === 'cfg-skill')?.editable).toBe(true)
    await s.saveSkill('user', folder, { name: 'made-here', description: 'd', body: 'b' })
    expect(existsSync(join(cfg, 'skills', 'made-here', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(claudeDir, 'skills', 'made-here'))).toBe(false)
  })

  it('a stop between the remove and the add of an edit puts the old server back, then refuses what comes after', async () => {
    extraEnv = { FAKE_EXT_SLOW_ADD_ONCE: at('slow-once') }
    const s = make()
    const { stamp } = await s.server(folder, 'user', 'github')
    const saving = s
      .saveServer(folder, 'user', 'github', { command: 'new-gh', env: { GH_TOKEN: null } }, undefined, stamp)
      .catch((e: Error) => e)
    for (let i = 0; i < 200 && !existsSync(at('slow-once')); i++) await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(at('slow-once'))).toBe(true)
    await s.stop()
    expect(((await saving) as Error).message).toBe(EXT_TEXT.addFailedRestored)
    // The restore ran to its end before stop() answered: the server is there with its old definition and value.
    expect(fakeState().mcpServers.find((x: { name: string }) => x.name === 'github').config).toEqual({
      type: 'stdio',
      command: 'gh-mcp',
      env: { GH_TOKEN: SECRET }
    })
    expect(cliLog().map((a) => a.slice(0, 3))).toEqual([
      ['mcp', 'remove', 'github'],
      ['mcp', 'add-json', 'github'],
      ['mcp', 'add-json', 'github']
    ])
    await expect(s.setSkill('a', false)).rejects.toThrow('ESHUTDOWN')
    await expect(s.loadout(folder, null, false)).rejects.toThrow('ESHUTDOWN')
    noSecret(...logs)
  })

  it('ends a probe in flight and its process group', async () => {
    extraEnv = { FAKE_EXT_HANG: '1', FAKE_EXT_PID_FILE: at('probe.pid') }
    const s = make({ probe: { timings: { deadlineMs: 60_000, killGraceMs: 300 } } })
    const loading = s.loadout(folder, null, false)
    for (let i = 0; i < 200 && !existsSync(at('probe.pid')); i++) await new Promise((r) => setTimeout(r, 20))
    const pid = Number(readFileSync(at('probe.pid'), 'utf8'))
    const started = Date.now()
    await s.stop()
    await loading.catch(() => {})
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe('ExtensionsService.engineCommands', () => {
  // What probeClaudeCommands resolves: the raw initialize answer and the raw skills listing.
  const CLAUDE_ANSWER = { commands: { commands: [{ name: 'review', description: 'Review a PR', argumentHint: '[pr]' }] }, skills: null }
  const CODEX_ANSWER = { data: [{ skills: [{ name: 'pdf', enabled: true, path: '/skills/pdf/SKILL.md', description: 'Pdf things' }] }] }
  const CODEX_BIN = async () => '/bin/codex'

  // Counts the probes and lets a test hold one open; `answer` is what the next probe resolves.
  const stubs = () => {
    const seen: Array<{ folder: string; agent: string | null; args: string[]; env: NodeJS.ProcessEnv }> = []
    const codexSeen: string[] = []
    const gates: Array<() => void> = []
    let answer: unknown = CLAUDE_ANSWER
    let hold = false
    const wait = async () => {
      if (hold) await new Promise<void>((r) => gates.push(r))
    }
    return {
      seen,
      codexSeen,
      setAnswer: (a: unknown) => (answer = a),
      holdProbes: (v: boolean) => (hold = v),
      releaseAll: () => gates.splice(0).forEach((g) => g()),
      probe: {
        claudeCommands: (async (o: { folder: string; agent: string | null; args: string[]; env: NodeJS.ProcessEnv }) => {
          seen.push({ folder: o.folder, agent: o.agent, args: o.args, env: o.env })
          await wait()
          return answer
        }) as never,
        codexCommands: (async (o: { folder: string }) => {
          codexSeen.push(o.folder)
          await wait()
          return CODEX_ANSWER
        }) as never
      }
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('probes once for the same folder, agent and file text, and again after the file is edited', async () => {
    const st = stubs()
    const s = make({ probe: st.probe })
    const first = await s.engineCommands(folder, 'helper')
    expect(first).toEqual({ engine: 'claude', rows: [{ name: 'review', description: 'Review a PR', hint: '[pr]', kind: 'command' }] })
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(1)
    writeFileSync(join(agentsDir, 'helper.md'), '---\nname: helper\ndescription: d\n---\nnew body\n')
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(2)
  })

  it('probes with the run config of switched-off servers and skills, and the agent name', async () => {
    const st = stubs()
    const s = make({ probe: st.probe })
    await s.engineCommands(folder, 'helper')
    expect(runConfigOpts.at(-1)).toEqual({ serversOff: true, skillsOff: true })
    expect(st.seen[0]).toMatchObject({ folder, agent: 'helper' })
  })

  it('probes with no agent keys, no own server values, hooks off, strict MCP and no --mcp-config', async () => {
    keys = [key('TOKEN', KEY_VALUE)]
    exts.set(
      'helper',
      ext({
        skillsOff: ['noisy'],
        plugins: { 'p@m': true },
        servers: [{ name: 'own', def: { command: 'srv', env: { TOKEN: '${vault:TOKEN}' } } }]
      })
    )
    const st = stubs()
    await make({ probe: st.probe, agentKeys: async () => ({ TOKEN: KEY_VALUE }) }).engineCommands(folder, 'helper')
    const { args, env } = st.seen[0]
    expect(args).not.toContain('--mcp-config')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--disallowedTools')
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings).toMatchObject({ disableAllHooks: true, skillOverrides: { noisy: 'off' }, enabledPlugins: { 'p@m': true } })
    expect(Object.keys(env).filter((k) => k === 'TOKEN' || k.startsWith('ZUMIBOT_MCP_VAULT_'))).toEqual([])
    expect(JSON.stringify(env)).not.toContain(KEY_VALUE)
  })

  it('logs one fixed line, naming the engine and code only, for a probe that failed', async () => {
    const st = stubs()
    st.setAnswer(null)
    const s = make({ probe: st.probe })
    await s.engineCommands(folder, 'helper')
    const thrown = make({
      probe: {
        claudeCommands: (async () => {
          throw Object.assign(new Error('/secret/path ' + KEY_VALUE), { code: 'ENOENT' })
        }) as never
      }
    })
    await thrown.engineCommands(folder, 'helper')
    const lines = logs.filter((l) => l.includes('commands probe'))
    expect(lines).toEqual(['engine commands probe failed (claude)', 'engine commands probe failed (claude, ENOENT)'])
    noSecret(...logs)
    for (const l of lines) expect(l).not.toContain('/secret')
  })

  it('cachedEngineCommands reads the cache, never probes, and is null on a miss or for an agent with no rows', async () => {
    const st = stubs()
    const s = make({ probe: st.probe })
    expect(await s.cachedEngineCommands(folder, 'helper')).toBeNull()
    expect(st.seen).toHaveLength(0)
    await s.engineCommands(folder, 'helper')
    expect((await s.cachedEngineCommands(folder, 'helper'))?.rows.map((r) => r.name)).toEqual(['review'])
    expect(await s.cachedEngineCommands(folder, 'ghost')).toBeNull()
    s.forget()
    expect(await s.cachedEngineCommands(folder, 'helper')).toBeNull()
    expect(st.seen).toHaveLength(1)
  })

  it('treats Zumi Bot as Claude', async () => {
    const st = stubs()
    const r = await make({ probe: st.probe }).engineCommands(folder, 'zumi-bot')
    expect(r?.engine).toBe('claude')
    expect(st.seen[0].agent).toBe('zumi-bot')
  })

  it('joins a probe already running for the same key', async () => {
    const st = stubs()
    st.holdProbes(true)
    const s = make({ probe: st.probe })
    const a = s.engineCommands(folder, 'helper')
    const b = s.engineCommands(folder, 'helper')
    await settle()
    st.releaseAll()
    expect(await a).toEqual(await b)
    expect(st.seen).toHaveLength(1)
  })

  it('probes again after forget(), and a probe begun before forget() never lands in the cache', async () => {
    const st = stubs()
    const s = make({ probe: st.probe })
    await s.engineCommands(folder, 'helper')
    s.forget()
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(2)

    st.holdProbes(true)
    const slow = s.engineCommands(folder, 'desk')
    await settle()
    s.forget()
    st.releaseAll()
    await slow
    st.holdProbes(false)
    await s.engineCommands(folder, 'desk')
    expect(st.seen.filter((x) => x.agent === 'desk')).toHaveLength(2)
  })

  it('configChanged() drops every cached answer and tells the pages, but not for the echo of its own write', async () => {
    const st = stubs()
    let clock = 1000
    const s = make({ probe: st.probe, now: () => clock })
    await s.engineCommands(folder, 'helper')
    s.configChanged()
    expect(changed).toBe(1)
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(2)

    // The write already forgot and told the pages; its own file events must not start a second round of probes.
    await s.setSkill('mine', false)
    expect(changed).toBe(2)
    await s.engineCommands(folder, 'helper')
    s.configChanged()
    expect(changed).toBe(2)
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(3)

    clock += 5_000
    s.configChanged()
    expect(changed).toBe(3)
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(4)
  })

  it('configChanged() is ignored while a write runs', async () => {
    let release = () => {}
    const s = make({
      // The write's paths wait on env(): held here, the write is still running when configChanged() comes.
      env: () => new Promise((r) => (release = () => r(envOf())))
    })
    const writing = s.setSkill('mine', false)
    await settle()
    s.configChanged()
    expect(changed).toBe(0)
    release()
    await writing
    expect(changed).toBe(1)
  })

  it('watchConfig() follows the config folder until stop()', async () => {
    const s = make()
    await s.watchConfig()
    await vi.waitFor(
      async () => {
        writeFileSync(join(claudeDir, 'skills', 'mine', 'SKILL.md'), `---\nname: mine\ndescription: ${Math.random()}\n---\n`)
        await new Promise((r) => setTimeout(r, 600))
        expect(changed).toBeGreaterThan(0)
      },
      { timeout: 6000 }
    )
    await s.stop()
    const before = changed
    writeFileSync(join(claudeDir, 'settings.json'), '{}\n')
    await new Promise((r) => setTimeout(r, 900))
    expect(changed).toBe(before)
  })

  it("watches a chat folder's own .claude from its first menu ask, until stop()", async () => {
    const st = stubs()
    mkdirSync(join(folder, '.claude'), { recursive: true })
    const s = make({ probe: st.probe })
    await s.engineCommands(folder, 'helper')
    await vi.waitFor(
      async () => {
        mkdirSync(join(folder, '.claude', 'skills', 'proj'), { recursive: true })
        writeFileSync(join(folder, '.claude', 'skills', 'proj', 'SKILL.md'), `---\nname: proj\ndescription: ${Math.random()}\n---\n`)
        await new Promise((r) => setTimeout(r, 600))
        expect(changed).toBeGreaterThan(0)
      },
      { timeout: 6000 }
    )
    await s.engineCommands(folder, 'helper')
    expect(st.seen).toHaveLength(2)
    await s.stop()
    const before = changed
    writeFileSync(join(folder, '.claude', 'settings.json'), '{}\n')
    await new Promise((r) => setTimeout(r, 900))
    expect(changed).toBe(before)
  })

  it('returns an old hit at once after five minutes and re-probes once in the background', async () => {
    const st = stubs()
    let clock = 1000
    const s = make({ probe: st.probe, now: () => clock })
    await s.engineCommands(folder, 'helper')
    clock += ENGINE_COMMANDS_STALE_MS + 1
    st.setAnswer({ commands: { commands: [{ name: 'fresh', description: '' }] }, skills: null })
    st.holdProbes(true)
    const old = await s.engineCommands(folder, 'helper')
    expect(old?.rows.map((r) => r.name)).toEqual(['review'])
    // A second call while the background probe runs does not start another.
    await s.engineCommands(folder, 'helper')
    await settle()
    expect(st.seen).toHaveLength(2)
    st.releaseAll()
    await settle()
    const next = await s.engineCommands(folder, 'helper')
    expect(next?.rows.map((r) => r.name)).toEqual(['fresh'])
    expect(st.seen).toHaveLength(2)
  })

  it('gives no rows for a null probe and does not cache it', async () => {
    const st = stubs()
    st.setAnswer(null)
    const s = make({ probe: st.probe })
    expect(await s.engineCommands(folder, 'helper')).toEqual({ engine: 'claude', rows: [] })
    st.setAnswer(CLAUDE_ANSWER)
    expect((await s.engineCommands(folder, 'helper'))?.rows).toHaveLength(1)
    expect(st.seen).toHaveLength(2)
  })

  it('gives no rows, without a probe, when the CLI is missing', async () => {
    const st = stubs()
    const r = await make({ probe: st.probe, locate: async () => null }).engineCommands(folder, 'helper')
    expect(r).toEqual({ engine: 'claude', rows: [] })
    expect(st.seen).toHaveLength(0)
  })

  it('reads a Codex agent as codex and finds a skill by name, with its path', async () => {
    const st = stubs()
    const s = make({ probe: st.probe, locateCodex: CODEX_BIN })
    const r = await s.engineCommands(folder, 'codexer')
    expect(r?.engine).toBe('codex')
    expect(r?.rows).toEqual([{ name: 'pdf', description: 'Pdf things', path: '/skills/pdf/SKILL.md', kind: 'skill' }])
    expect(await s.codexSkill(folder, 'codexer', 'pdf')).toEqual({ name: 'pdf', path: '/skills/pdf/SKILL.md' })
    expect(await s.codexSkill(folder, 'codexer', 'nope')).toBeNull()
    // A Claude agent has no Codex skills.
    expect(await s.codexSkill(folder, 'helper', 'review')).toBeNull()
    expect(st.codexSeen).toHaveLength(1)
  })

  it('gives null for an ACP agent and an unknown one', async () => {
    agentList.push(summary('gem', { provider: 'acp' }), summary('broken', { error: 'bad' }))
    const st = stubs()
    const s = make({ probe: st.probe })
    expect(await s.engineCommands(folder, 'gem')).toBeNull()
    expect(await s.engineCommands(folder, 'broken')).toBeNull()
    expect(await s.engineCommands(folder, 'ghost')).toBeNull()
    expect(st.seen).toHaveLength(0)
  })

  it('stop() ends a probe in flight and refuses later calls', async () => {
    const st = stubs()
    st.holdProbes(true)
    const s = make({ probe: st.probe })
    const running = s.engineCommands(folder, 'helper')
    await settle()
    const stopping = s.stop()
    st.releaseAll()
    await stopping
    await running.catch(() => null)
    await expect(s.engineCommands(folder, 'helper')).rejects.toThrow('ESHUTDOWN')
  })
})
