import { RECALL_SERVER } from '@zumibot/shared/recall'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { assertNever, engineOfAgent, type Engine } from '@zumibot/shared/engine'
import type { CommandEngine } from '@zumibot/shared/engineCommands'
import {
  EXT_TEXT,
  type AgentExtensions,
  type HookFile,
  type HookInput,
  type HookPosition,
  type Loadout,
  type LoadoutHook,
  type LoadoutPlugin,
  type LoadoutSection,
  type LoadoutServer,
  type McpScope,
  type McpServerDef,
  type McpServerInput,
  type McpServerView,
  type SkillView
} from '@zumibot/shared/extensions'
import type { AgentSummary } from '@zumibot/shared/types'
import { NO_RUN_CONFIG, type AgentRunConfig } from './agentRunConfig'
import { mcpAdd, mcpRemove, pluginList, pluginSet } from './claudeCli'
import {
  localProjectKey,
  mergeInput,
  projectMcpNames,
  readProjectServers,
  readUserServers,
  serverView,
  storedServerNames,
  writeProjectServer
} from './mcpFiles'
import { commandsProbeArgs } from './commandsProbeArgs'
import { watchClaudeConfig } from './configWatch'
import { claudeCommandRows, codexSkillRows, type EngineCommandRow } from './engineCommandRows'
import { probeClaude, probeClaudeCommands, probeCodex, probeCodexCommands, type ProbeAnswers } from './probe'
import { toLoadout } from './sanitize'
import {
  hookRows,
  projectPathOk,
  readText,
  removeHook as removeHookIn,
  setHook,
  setSkillOverride,
  settingsPath,
  SETTINGS_LABEL,
  stampOf,
  writeSettings
} from './settingsFile'
import { listSkillDirs, readSkill, removeSkill as removeSkillDir, saveSkill as saveSkillFile } from './skillFiles'

// What an agent (or a plain folder) loads, from the CLI itself, and the page's writes to the user's Claude Code config. A probe's raw
// answers hold MCP server configs with env and header values: they go to `toLoadout` and nowhere else, and only the sanitized Loadout is
// cached or returned. Every error that leaves here is an EXT_TEXT sentence or a bare error code (`pageError`), never a path, a value
// or anything a CLI printed.

export interface ProbeTimings {
  deadlineMs?: number
  pendingMs?: number
  pollMs?: number
  killGraceMs?: number
}

export interface ExtensionsDeps {
  /** The claude binary, or null when it is not found. */
  locate(): Promise<string | null>
  locateCodex(): Promise<string | null>
  /** The env every CLI run gets (the interactive shell's PATH), with no agent's keys in it. */
  env(): Promise<NodeJS.ProcessEnv>
  /** The home folder; the user's settings.json, skills and `~/.claude.json` move with `CLAUDE_CONFIG_DIR` of `env()`, as the CLI's do. */
  home: string
  agents(): Promise<AgentSummary[]>
  extensionsOf(agent: string): Promise<AgentExtensions | null>
  /** The env names and values of the Vault API keys granted to the agent, as its main runs get them (`vaultEnvOf(...).env`). */
  agentKeys(agent: string): Promise<Record<string, string>>
  /** What a run of the agent adds (app.ts's `agentRunConfig`); the probe asks with `serversOff: false, skillsOff: false`. */
  runConfig(agent: string, opts: { serversOff: boolean; skillsOff: boolean }): Promise<AgentRunConfig>
  trash(path: string): Promise<void>
  now(): number
  /** Tells every page to refetch (`extensions:changed`). */
  onChanged(): void
  /** Exit codes of failed CLI writes only. */
  log(line: string): void
  /** Test seams: the probes and their timings. */
  probe?: {
    claude?: typeof probeClaude
    codex?: typeof probeCodex
    claudeCommands?: typeof probeClaudeCommands
    codexCommands?: typeof probeCodexCommands
    timings?: ProbeTimings
  }
}

/** What the `/` menu may show for an agent in a folder; `path` (Codex only) stays on the server. */
export interface EngineCommandsAnswer {
  engine: CommandEngine
  rows: EngineCommandRow[]
}

const PROBES_MAX = 2
const CACHE_MAX = 100
/** A cached command list older than this is still served, and re-probed once in the background. */
export const ENGINE_COMMANDS_STALE_MS = 300_000
// A write's own file events land while it runs or just after: they are not a change made outside the app.
const WRITE_ECHO_MS = 2_000
// Project folders whose `.claude` is watched at once; the oldest asked-for goes first.
const FOLDER_WATCH_MAX = 20
const HOOK_FILES: HookFile[] = ['user', 'project', 'local']
// listSkillDirs never lists these folders, so a skill made under either name would vanish from the page.
const RESERVED_SKILL_FOLDERS = new Set(['synced', '.trash'])

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const own = <T>(map: Record<string, T>, name: string): T | undefined => (has(map, name) ? map[name] : undefined)

/** Keys sorted at every level, so the same definition always hashes the same however the file orders it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** A user or local server's stamp (Ruling 16): its own stored definition, not the whole `~/.claude.json`, which the CLI rewrites all the time. */
export const defStamp = (def: McpServerDef): string => sha(canonical(def))

// Every sentence the page may see, so anything else (a message holding a path) is cut down to its code or a fixed one.
const SENTENCES: ReadonlySet<string> = new Set([
  ...Object.values(EXT_TEXT).filter((v): v is string => typeof v === 'string'),
  ...[...Object.values(SETTINGS_LABEL), '.mcp.json'].map(EXT_TEXT.badJson),
  ...(['servers', 'plugins', 'skills', 'hooks'] as LoadoutSection[]).flatMap((s) => [EXT_TEXT.unsupported(s), EXT_TEXT.codexUnsupported(s)])
])
const CODE = /^E[A-Z0-9_]{1,30}$/

function pageError(err: unknown): Error {
  const message = err instanceof Error ? err.message : ''
  if (SENTENCES.has(message) || CODE.test(message)) return err as Error
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return new Error(typeof code === 'string' && CODE.test(code) ? code : 'EIO')
}

// A definition the CLI format does not take: the file helpers say badName, which reads as a naming problem on the page.
function asServer<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw err instanceof Error && err.message === EXT_TEXT.badName ? new Error(EXT_TEXT.badServer) : err
  }
}

const transportOf = (def: McpServerDef | null | undefined): string | null =>
  def ? (def.type ?? (def.url !== undefined ? 'http' : 'stdio')) : null

const NOTE: Record<AgentRunConfig['dropped'][number]['reason'], (env: string | null) => string> = {
  'vault-missing': (env) => EXT_TEXT.vaultMissing(env ?? ''),
  'vault-locked': () => EXT_TEXT.vaultLocked,
  'reserved-name': () => EXT_TEXT.reservedName
}

const bridge = (name: string): LoadoutServer => ({
  name,
  status: 'unknown',
  source: 'zumibot',
  transport: 'stdio',
  plugin: null,
  tools: [],
  scope: null,
  note: null,
  connector: null
})
const guardHook = (matcher: string, type: string, command: string): LoadoutHook => ({
  event: 'PreToolUse',
  matcher,
  type,
  command,
  timeout: null,
  source: 'zumibot',
  plugin: null,
  at: null,
  stamp: null
})

/**
 * What ZumiBot adds to a run, from the same facts the runner uses: the browser, to-do and vault bridges for everyone, the ask bridge
 * for every agent but Zumi Bot, Zumi Bot's automations, a computer-use Claude agent's desktop; the pause hook, the vault guard and the
 * desktop ask rules. A plain folder (no agent) shows what an ordinary agent gets.
 */
/**
 * The tool the vault guard sits on, as the row shows it: every tool for Codex (`''`), Bash beside Claude's deny rules. None for
 * ACP or a remote agent, whose runs have no guard (and whose card lists no ZumiBot rows at all).
 */
const VAULT_GUARD_ON: Record<Engine, string | null> = { claude: 'Bash', codex: '', acp: null, 'ag-ui': null }

function zumiBotAdds(agent: AgentSummary | null, engine: Engine): { servers: LoadoutServer[]; hooks: LoadoutHook[] } {
  const isBot = agent?.name === ZUMI_BOT_NAME
  const desktop = engine === 'claude' && !isBot && agent?.computerUse === true
  const servers = [
    'zumibot_browser',
    'zumibot_todos',
    'zumibot_vault',
    isBot ? 'zumibot_automations' : 'zumibot_agents',
    ...(desktop ? ['zumibot_desktop'] : []),
    // Hive recall rides only on runs of an agent that has it on.
    ...(agent?.recall ? [RECALL_SERVER] : [])
  ]
  const guardOn = VAULT_GUARD_ON[engine]
  const hooks = [
    guardHook('*', 'command', 'Pause: holds new calls of the main agent while the chat is pausing'),
    // Codex takes one hook on every tool; Claude's guard sits on Bash beside its deny rules for the file tools.
    ...(guardOn !== null ? [guardHook(guardOn, 'command', 'Vault guard: blocks calls that name the vault key or file')] : []),
    ...(desktop ? [guardHook('mcp__zumibot_desktop__*', 'ask', 'Asks you before every desktop action')] : [])
  ]
  return { servers: servers.map(bridge), hooks }
}

/** Where the user's Claude Code config lives for a CLI run with this env: its settings.json and skills, and `.claude.json`. */
interface Paths {
  claudeDir: string
  claudeJson: string
}

// As the CLI reads them: `$CLAUDE_CONFIG_DIR` of the env it gets (claudeAccount.ts' claudeConfigFile reads `.claude.json` the same way).
function pathsOf(env: NodeJS.ProcessEnv, home: string): Paths {
  const dir = env['CLAUDE_CONFIG_DIR']
  return { claudeDir: dir || join(home, '.claude'), claudeJson: dir ? join(dir, '.claude.json') : join(home, '.claude.json') }
}

const settingsFileOf = (file: HookFile, folder: string, p: Paths): string =>
  settingsPath(file, folder, '', { CLAUDE_CONFIG_DIR: p.claudeDir })
const skillRoot = (scope: 'user' | 'project', folder: string, p: Paths): string =>
  scope === 'user' ? join(p.claudeDir, 'skills') : join(folder, '.claude', 'skills')

const missing = (text: string = EXT_TEXT.cliMissing): ProbeAnswers => ({
  version: null,
  mcp: null,
  skills: null,
  hooks: null,
  errors: { mcp: text, skills: text, hooks: text }
})

// The plugin's own name: `caveman` in `caveman@caveman`, `plugin:caveman:x` rows and `caveman:compress` skills (Ruling 13).
const pluginName = (id: string): string => (id.includes('@') ? id.slice(0, id.indexOf('@')) : id)

// The file's text (an agent's) is part of the key; a folder read has none.
const cacheKey = (folder: string, agent: string | null, text: string): string => `${folder}\n${agent ?? ''}\n${sha(text)}`

export class ExtensionsService {
  private readonly cache = new Map<string, Loadout>()
  private readonly inflight = new Map<string, Promise<Loadout>>()
  // The `/` menu's engine commands: their own cache, so a refresh of the loadout never waits on them (and the reverse).
  private readonly engineCache = new Map<string, { at: number; answer: EngineCommandsAnswer }>()
  private readonly engineInflight = new Map<string, Promise<EngineCommandsAnswer>>()
  // A probe that started before a forget() may have read the old files: its answer goes to its callers, never into the cache.
  private generation = 0
  private running = 0
  private readonly waiting: Array<() => void> = []
  private readonly tails = new Map<string, Promise<void>>()
  // Set by stop(): what runs is ended, what comes after is refused.
  private stopping = false
  private readonly aborts = new Set<AbortController>()
  private readonly builds = new Set<Promise<unknown>>()
  private writing = 0
  private wroteAt = Number.NEGATIVE_INFINITY
  private unwatch: (() => void) | null = null
  private readonly folderWatches = new Map<string, () => void>()

  constructor(private readonly d: ExtensionsDeps) {}

  /**
   * At server stop: ends every probe and CLI write in flight (their process groups go) and waits for the write queues. An edit's
   * restore (the old server put back after its add failed) runs without a signal, so a stop between `mcp remove` and `mcp add` never
   * loses the server. Every call after it is refused with `ESHUTDOWN`.
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.unwatch?.()
    this.unwatch = null
    for (const stop of this.folderWatches.values()) stop()
    this.folderWatches.clear()
    for (const a of this.aborts) a.abort()
    await Promise.allSettled([...this.builds, ...this.tails.values()])
  }

  // An abort for one probe or one write, aborted at once when the server is already stopping.
  private abortable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const a = new AbortController()
    if (this.stopping) a.abort()
    this.aborts.add(a)
    return fn(a.signal).finally(() => this.aborts.delete(a))
  }

  private refuseStopped(): void {
    if (this.stopping) throw new Error('ESHUTDOWN')
  }

  /** Drops every cached loadout; a probe still running is no longer joined by new callers. */
  forget(): void {
    this.generation++
    this.cache.clear()
    this.inflight.clear()
    this.engineCache.clear()
    this.engineInflight.clear()
  }

  /**
   * Follows the user's Claude config folder (the one `CLAUDE_CONFIG_DIR` of `env()` names, as the CLI reads it), so a skill,
   * command or plugin added outside the app reaches the `/` menu and the Claude Code page without a restart. Ended by stop().
   */
  async watchConfig(): Promise<void> {
    const { claudeDir } = await this.paths()
    if (this.stopping || this.unwatch) return
    this.unwatch = watchClaudeConfig(claudeDir, () => this.configChanged())
  }

  // A project's own skills, commands and settings.json, from the first time its `/` menu is asked for. The user's own folder
  // (home's `.claude`) is watchConfig()'s.
  private async watchFolder(folder: string): Promise<void> {
    const had = this.folderWatches.get(folder)
    if (had) {
      this.folderWatches.delete(folder)
      this.folderWatches.set(folder, had)
      return
    }
    const dir = join(folder, '.claude')
    if (dir === (await this.paths()).claudeDir) return
    // Not kept when missing, so a `.claude` made later is watched from the next ask.
    const isDir = await fs.stat(dir).then((st) => st.isDirectory(), () => false)
    if (!isDir || this.stopping || this.folderWatches.has(folder)) return
    this.folderWatches.set(folder, watchClaudeConfig(dir, () => this.configChanged()))
    if (this.folderWatches.size > FOLDER_WATCH_MAX) {
      const [oldest, stop] = this.folderWatches.entries().next().value as [string, () => void]
      stop()
      this.folderWatches.delete(oldest)
    }
  }

  /** The user's skills, commands, plugins or settings.json changed on disk: every cached answer goes and open pages refetch. */
  configChanged(): void {
    // A write of ours already did both, and a second round would probe everything again.
    if (this.stopping || this.writing > 0 || this.d.now() - this.wroteAt < WRITE_ECHO_MS) return
    this.forget()
    try {
      this.d.onChanged()
    } catch {
      /* a page that is not told refetches on its next load */
    }
  }

  // ---- what loads ----

  async loadout(folder: string, agent: string | null, refresh: boolean): Promise<Loadout> {
    this.refuseStopped()
    let summary: AgentSummary | null = null
    let text = ''
    if (agent !== null) {
      summary =
        (
          await this.d.agents().catch((err: unknown) => {
            throw pageError(err)
          })
        ).find((a) => a.name === agent && a.error === null) ?? null
      if (!summary) throw new Error(EXT_TEXT.notFound)
      // The file's text keys the cache, so a Save (or an edit on disk) is never served an older answer.
      text = await fs.readFile(summary.filePath, 'utf8').catch(() => '')
    }
    const key = cacheKey(folder, agent, text)
    const hit = refresh ? undefined : this.cache.get(key)
    if (hit) return hit
    // A refresh joins a probe already running: that one is as fresh.
    const running = this.inflight.get(key)
    if (running) return running
    const generation = this.generation
    const probe = this.slot(() => this.build(folder, summary))
      .then(
        (l) => {
          if (this.generation === generation) this.remember(key, l)
          return l
        },
        (err: unknown) => {
          throw pageError(err)
        }
      )
      .finally(() => {
        if (this.inflight.get(key) === probe) this.inflight.delete(key)
      })
    this.inflight.set(key, probe)
    this.builds.add(probe)
    void probe.then(
      () => this.builds.delete(probe),
      () => this.builds.delete(probe)
    )
    return probe
  }

  /**
   * A folder read (no agent) that leaves nothing in the cache: a cached answer is free and a probe already running is joined, else it
   * probes on its own. For a reader that is not the page (the start-up name read), so the page's first read still probes the files as
   * they are then; the cache's key holds no file text for a folder, so an answer cached at start would hide a later edit to settings.json.
   */
  async peek(folder: string): Promise<Loadout> {
    this.refuseStopped()
    const key = cacheKey(folder, null, '')
    const hit = this.cache.get(key) ?? this.inflight.get(key)
    if (hit) return hit
    const probe = this.slot(() => this.build(folder, null)).catch((err: unknown) => {
      throw pageError(err)
    })
    this.builds.add(probe)
    void probe.then(
      () => this.builds.delete(probe),
      () => this.builds.delete(probe)
    )
    return probe
  }

  private remember(key: string, l: Loadout): void {
    this.cache.delete(key)
    this.cache.set(key, l)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string)
  }

  // ---- the engine's own slash commands (Claude Code commands, Codex skills) ----

  /**
   * The rows of the `/` menu for an agent in a folder, from its CLI. Null for an ACP or remote agent and for an unknown or broken one;
   * Zumi Bot counts as Claude. A missing CLI or a failed probe gives no rows and is not cached, so the next call tries again. A hit older
   * than ENGINE_COMMANDS_STALE_MS is returned at once and re-probed once in the background.
   */
  async engineCommands(folder: string, agent: string): Promise<EngineCommandsAnswer | null> {
    const target = await this.engineTarget(folder, agent)
    if (!target) return null
    void this.watchFolder(folder).catch(() => undefined)
    const hit = this.engineCache.get(target.key)
    if (hit) {
      if (this.d.now() - hit.at > ENGINE_COMMANDS_STALE_MS)
        void this.engineProbe(target.key, folder, target.summary, target.engine).catch(() => undefined)
      return hit.answer
    }
    return this.engineProbe(target.key, folder, target.summary, target.engine)
  }

  /** What `engineCommands` has cached, however old, and never a probe: null on a miss and for an agent with no engine rows. */
  async cachedEngineCommands(folder: string, agent: string): Promise<EngineCommandsAnswer | null> {
    const target = await this.engineTarget(folder, agent)
    return target ? (this.engineCache.get(target.key)?.answer ?? null) : null
  }

  private async engineTarget(
    folder: string,
    agent: string
  ): Promise<{ summary: AgentSummary; engine: CommandEngine; key: string } | null> {
    this.refuseStopped()
    const summary = (
      await this.d.agents().catch((err: unknown) => {
        throw pageError(err)
      })
    ).find((a) => a.name === agent && a.error === null)
    if (!summary) return null
    const engine: Engine = summary.name === ZUMI_BOT_NAME ? 'claude' : engineOfAgent(summary)
    if (!(engine === 'claude' || engine === 'codex')) return null
    // The file's text keys the cache, so a Save is never served the old agent's commands.
    const text = await fs.readFile(summary.filePath, 'utf8').catch(() => '')
    return { summary, engine, key: cacheKey(folder, agent, text) }
  }

  /** A Codex skill's name and the SKILL.md path of its row, for the turn that runs it. Null when the agent has no such skill. */
  async codexSkill(folder: string, agent: string, name: string): Promise<{ name: string; path: string } | null> {
    const found = await this.engineCommands(folder, agent)
    if (found?.engine === 'codex') {
      const row = found.rows.find((r) => r.name === name)
      return row?.path ? { name: row.name, path: row.path } : null
    }
    return null
  }

  // One probe per key at a time: a caller (or the background refresh) joins the one running.
  private engineProbe(key: string, folder: string, agent: AgentSummary, engine: CommandEngine): Promise<EngineCommandsAnswer> {
    const running = this.engineInflight.get(key)
    if (running) return running
    const generation = this.generation
    const probe = this.slot(() => this.abortable((signal) => this.probeEngineCommands(folder, agent, engine, signal)))
      .then(
        (rows) => {
          const answer = { engine, rows: rows ?? [] }
          // Only a real answer is kept, and not one from before a forget(), which may have read the old files.
          if (rows !== null && this.generation === generation) this.rememberEngine(key, answer)
          return answer
        },
        (err: unknown) => {
          throw pageError(err)
        }
      )
      .finally(() => {
        if (this.engineInflight.get(key) === probe) this.engineInflight.delete(key)
      })
    this.engineInflight.set(key, probe)
    this.builds.add(probe)
    void probe.then(
      () => this.builds.delete(probe),
      () => this.builds.delete(probe)
    )
    return probe
  }

  private rememberEngine(key: string, answer: EngineCommandsAnswer): void {
    this.engineCache.delete(key)
    this.engineCache.set(key, { at: this.d.now(), answer })
    if (this.engineCache.size > CACHE_MAX) this.engineCache.delete(this.engineCache.keys().next().value as string)
  }

  // Null when the CLI is missing or the probe failed. The raw answer is read into rows here and goes no further. It runs on its
  // own (a chat opens, a folder is picked), so it gets the least a command list needs: the base env with no agent's keys or own
  // servers' values, hooks off, no MCP servers (`commandsProbeArgs`); only skill and plugin switches are kept.
  private async probeEngineCommands(
    folder: string,
    agent: AgentSummary,
    engine: CommandEngine,
    signal: AbortSignal
  ): Promise<EngineCommandRow[] | null> {
    // Fixed words only: the engine and an error's code, never output, a path or a value.
    const failed = (err?: unknown): null => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      this.d.log(`engine commands probe failed (${engine}${typeof code === 'string' && CODE.test(code) ? `, ${code}` : ''})`)
      return null
    }
    try {
      const timings = this.d.probe?.timings
      if (engine === 'codex') {
        const [env, bin] = await Promise.all([this.d.env(), this.d.locateCodex()])
        if (!bin) return null
        const answer = await (this.d.probe?.codexCommands ?? probeCodexCommands)({ bin, folder, env, signal, ...timings })
        return answer === null ? failed() : codexSkillRows(answer)
      }
      const [env, bin] = await Promise.all([this.d.env(), this.d.locate()])
      if (!bin) return null
      const config = await this.d.runConfig(agent.name, { serversOff: true, skillsOff: true })
      const answer = await (this.d.probe?.claudeCommands ?? probeClaudeCommands)({
        bin,
        folder,
        agent: agent.name,
        args: commandsProbeArgs(config.extraArgs),
        env,
        signal,
        ...timings
      })
      return answer === null ? failed() : claudeCommandRows(answer.commands, answer.skills)
    } catch (err) {
      return failed(err)
    }
  }

  // At most two probes server-wide; the rest wait their turn in order.
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < PROBES_MAX) this.running++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      // A probe that waited its turn past a stop never starts.
      this.refuseStopped()
      return await fn()
    } finally {
      const next = this.waiting.shift()
      // The slot passes straight to the next one, so `running` never dips and lets a newcomer past the queue.
      if (next) next()
      else this.running--
    }
  }

  private build(folder: string, agent: AgentSummary | null): Promise<Loadout> {
    const engine: Engine = agent && agent.name !== ZUMI_BOT_NAME ? engineOfAgent(agent) : 'claude'
    return this.abortable((signal) => {
      switch (engine) {
        case 'claude':
          return this.buildClaude(folder, agent, signal)
        // A Codex engine needs an agent (Zumi Bot and the folder page are Claude's), so this is the agent's own probe.
        case 'codex':
          return agent ? this.buildCodex(folder, agent, signal) : this.buildClaude(folder, agent, signal)
        // No probe: ZumiBot does not read an ACP agent's own configuration, and gives its runs none of its own parts.
        case 'acp':
          return agent ? Promise.resolve(this.buildAcp(folder, agent)) : this.buildClaude(folder, agent, signal)
        // Nor a remote agent's: it runs on its server, with nothing of ZumiBot's.
        case 'ag-ui':
          return agent ? Promise.resolve(this.buildAgui(folder, agent)) : this.buildClaude(folder, agent, signal)
        default:
          return assertNever(engine)
      }
    })
  }

  private async buildClaude(folder: string, agent: AgentSummary | null, signal: AbortSignal): Promise<Loadout> {
    const [env, bin] = await Promise.all([this.d.env(), this.d.locate()])
    const paths = pathsOf(env, this.d.home)
    const config = agent ? await this.d.runConfig(agent.name, { serversOff: false, skillsOff: false }) : NO_RUN_CONFIG
    const ext = agent ? await this.d.extensionsOf(agent.name) : null
    // The agent's granted API keys, as its runs get them, so a global server whose config names one connects here as it does there.
    // Only in this process's env for the probe's life: never logged, cached or passed on; a folder's probe (no agent) gets none.
    const keyEnv = agent ? await this.d.agentKeys(agent.name).catch(() => ({})) : {}
    let answers = missing()
    let plugins: Array<{ id: string; enabled: boolean }> | string = EXT_TEXT.cliMissing
    if (bin) {
      const probe = this.d.probe?.claude ?? probeClaude
      ;[answers, plugins] = await Promise.all([
        // Ruling 4: the agent's own Vault-backed servers start with their values, as in a run; through env only, never argv. The order is
        // a run's: the keys after the base env, the own servers' values after them.
        probe({
          bin,
          folder,
          agent: agent?.name ?? null,
          args: config.extraArgs,
          env: { ...env, ...keyEnv, ...config.env },
          signal,
          ...this.d.probe?.timings
        }),
        pluginList({ bin, env, cwd: folder, log: (l) => this.d.log(l), signal }).catch((err: unknown) => {
          const e = pageError(err)
          return SENTENCES.has(e.message) ? e.message : EXT_TEXT.unsupported('plugins')
        })
      ])
    }
    const base = toLoadout(answers, {
      engine: 'claude',
      folder,
      agent: agent?.name ?? null,
      now: this.d.now(),
      skillDirs: await this.skillDirs(folder, paths)
    })
    const errors = { ...base.errors }

    // The agent's own servers: one winner per name, the last definition (Ruling 11), as the run builds them.
    const defs = new Map<string, McpServerDef | null>()
    if (ext?.serversEditable) for (const s of ext.servers) defs.set(s.name, s.def)
    const dropped = new Set(config.dropped.map((x) => x.server))
    // The CLI lists an --mcp-config server unscoped, in place of a configured one of the same name: the files say whether there was one.
    const stored = defs.size > 0 ? await this.storedNames(folder, paths) : new Set<string>()
    const project = await this.projectServerPlaces(folder)
    const servers: LoadoutServer[] = base.servers.map((s) => {
      const def = defs.get(s.name)
      if (def && !dropped.has(s.name) && s.scope === null && s.source === 'other')
        return {
          ...s,
          source: 'agent',
          scope: null,
          transport: s.transport ?? transportOf(def),
          note: stored.has(s.name) ? EXT_TEXT.sameName : s.note
        }
      return s.scope === 'project' ? project(s) : s
    })
    for (const x of config.dropped)
      servers.push({
        name: x.server,
        status: 'disabled',
        source: 'agent',
        transport: transportOf(defs.get(x.server)),
        plugin: null,
        tools: [],
        scope: null,
        note: NOTE[x.reason](x.env),
        connector: null
      })

    // Ruling 24: the CLI's rows are what loads. A user, project or local row takes its place, its file's stamp and its timeout from the
    // file row with the same source, event, matcher and command (each file row once), which makes it editable; a row no file row matches
    // (the repo root's settings.local.json, a file this page does not read) stays read-only, and a file row the CLI did not list (its
    // file rejected, or not loaded here) is not shown. A file that does not parse is still named in the hooks section.
    const files = await this.fileHooks(folder, paths)
    if (files.error) errors.hooks = errors.hooks ? `${errors.hooks} ${files.error}` : files.error
    const pool = [...files.rows]
    const joined = base.hooks.map((h): LoadoutHook => {
      if (h.source !== 'user' && h.source !== 'project' && h.source !== 'local') return h
      const i = pool.findIndex(
        (f) => f.source === h.source && f.event === h.event && f.matcher === h.matcher && f.command === h.command && f.type === h.type
      )
      if (i === -1) return { ...h, at: null, stamp: null }
      const [f] = pool.splice(i, 1)
      return { ...h, timeout: f.timeout, at: f.at, stamp: f.at ? f.stamp : null }
    })
    // A folder with no agent is no run: ZumiBot's bridges and guards belong to an agent's runs.
    const adds = agent ? zumiBotAdds(agent, 'claude') : { servers: [], hooks: [] }
    const hooks = [...joined, ...adds.hooks]

    let pluginRows: LoadoutPlugin[] = []
    if (typeof plugins === 'string') errors.plugins = plugins
    else {
      const count = (rows: Array<{ plugin: string | null }>, name: string) =>
        rows.filter((r) => r.plugin !== null && pluginName(r.plugin) === name).length
      pluginRows = plugins.map(({ id, enabled }) => {
        const name = pluginName(id)
        return { id, enabled, skills: count(base.skills, name), servers: count(servers, name), hooks: count(hooks, name) }
      })
    }
    return { ...base, servers: [...servers, ...adds.servers], plugins: pluginRows, hooks, errors }
  }

  // Codex agents get none of the per-agent config and no plugin list; their skills and hooks live in Codex's own config, view only.
  private async buildCodex(folder: string, agent: AgentSummary, signal: AbortSignal): Promise<Loadout> {
    const [env, bin] = await Promise.all([this.d.env(), this.d.locateCodex()])
    const answers = bin
      ? await (this.d.probe?.codex ?? probeCodex)({ bin, folder, env, signal, ...this.d.probe?.timings })
      : missing(EXT_TEXT.codexMissing)
    const base = toLoadout(answers, { engine: 'codex', folder, agent: agent.name, now: this.d.now(), skillDirs: new Map() })
    const adds = zumiBotAdds(agent, 'codex')
    return { ...base, servers: [...base.servers, ...adds.servers], plugins: [], hooks: [...base.hooks, ...adds.hooks] }
  }

  /** An ACP agent's card: every section says the agent keeps its own, and no ZumiBot rows (its runs get no bridges or hooks). */
  private buildAcp(folder: string, agent: AgentSummary): Loadout {
    const text = EXT_TEXT.acpUnsupported
    return {
      engine: 'acp',
      version: null,
      folder,
      agent: agent.name,
      servers: [],
      plugins: [],
      skills: [],
      hooks: [],
      errors: { servers: text, plugins: text, skills: text, hooks: text },
      at: this.d.now()
    }
  }

  private buildAgui(folder: string, agent: AgentSummary): Loadout {
    const text = EXT_TEXT.aguiUnsupported
    return {
      engine: 'ag-ui',
      version: null,
      folder,
      agent: agent.name,
      servers: [],
      plugins: [],
      skills: [],
      hooks: [],
      errors: { servers: text, plugins: text, skills: text, hooks: text },
      at: this.d.now()
    }
  }

  // The names of the user's and this folder's local servers (`~/.claude.json`) and of every `.mcp.json` the CLI reads from here up.
  private async storedNames(folder: string, paths: Paths): Promise<Set<string>> {
    const text = (await readText(paths.claudeJson).catch(() => null)) ?? ''
    const names = storedServerNames(text, localProjectKey(folder))
    for (const { names: found } of await projectMcpNames(folder)) for (const n of found) names.add(n)
    return names
  }

  /**
   * What a project row may do. The CLI reads `.mcp.json` from the folder and every folder above it, but only the chosen folder's file is
   * edited here: a server only a parent's file holds is read-only and says where it comes from, and so is every row while the folder's
   * file is a link (Ruling 25).
   */
  private async projectServerPlaces(folder: string): Promise<(s: LoadoutServer) => LoadoutServer> {
    const [files, writable] = await Promise.all([projectMcpNames(folder), projectPathOk(folder, join(folder, '.mcp.json'))])
    const real = await fs.realpath(folder).catch(() => folder)
    const own = files.find((f) => f.dir === real)?.names ?? new Set<string>()
    return (s) => {
      if (!writable) return { ...s, scope: null, note: EXT_TEXT.linkedFile }
      if (own.has(s.name)) return s
      const from = files.find((f) => f.dir !== real && f.names.has(s.name))
      return { ...s, scope: null, note: from ? EXT_TEXT.fromParentMcp(from.dir) : s.note }
    }
  }

  private async skillDirs(folder: string, paths: Paths): Promise<Map<string, 'user' | 'project'>> {
    const out = new Map<string, 'user' | 'project'>()
    for (const name of (await listSkillDirs(skillRoot('user', folder, paths))).keys()) out.set(name, 'user')
    // A project skills folder that is a link, or lies outside the folder, is never written (Ruling 25): its skills show read-only.
    const project = skillRoot('project', folder, paths)
    if (await projectPathOk(folder, project)) for (const name of (await listSkillDirs(project)).keys()) out.set(name, 'project')
    return out
  }

  private async fileHooks(folder: string, paths: Paths): Promise<{ rows: LoadoutHook[]; error: string | null }> {
    const rows: LoadoutHook[] = []
    const errors: string[] = []
    const seen = new Set<string>()
    for (const file of HOOK_FILES) {
      const path = settingsFileOf(file, folder, paths)
      // In the home folder the project file is the user's own: listed once.
      if (seen.has(path)) continue
      seen.add(path)
      // A project file that is a link, or lies outside the folder, is never written (Ruling 25): its hooks show read-only.
      if (file !== 'user' && !(await projectPathOk(folder, path))) continue
      try {
        const text = await readText(path)
        const stamp = stampOf(text)
        for (const r of hookRows(text, file))
          rows.push({
            event: r.event,
            matcher: r.matcher,
            type: r.type,
            command: r.command,
            timeout: r.timeout,
            source: file,
            plugin: null,
            at: r.type === 'command' ? r.at : null,
            stamp
          })
      } catch (err) {
        // A file that does not parse names itself in the hooks section; the other files and sections still show.
        errors.push(pageError(err).message)
      }
    }
    return { rows, error: errors.length > 0 ? errors.join(' ') : null }
  }

  // ---- paths ----

  // From the env a CLI run gets (Task 7 item 9), not this process's: the page then reads and writes what the CLI does.
  private async paths(): Promise<Paths> {
    return pathsOf(await this.d.env(), this.d.home)
  }

  // A project or local file is checked against the chosen folder before a write (Ruling 25); the user's own files keep following links.
  private inside(scope: HookFile, folder: string): string | undefined {
    return scope === 'user' ? undefined : folder
  }

  // ---- writes: one queue per file, and every write tells the pages ----

  // Calls on one file run one after another, so two edits never read the same text and lose each other's key.
  private queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => {},
      () => {}
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return run
  }

  private async write<T>(key: (p: Paths) => string, fn: (p: Paths, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.writing++
    try {
      this.refuseStopped()
      const paths = await this.paths()
      // A write still queued when the server stops never starts; the one running finishes (or its CLI run is ended).
      return await this.queued(key(paths), () => {
        this.refuseStopped()
        return this.abortable((signal) => fn(paths, signal))
      })
    } catch (err) {
      throw pageError(err)
    } finally {
      this.writing--
      this.wroteAt = this.d.now()
      // Also after a failure: a remove that went through before its add failed changed what loads.
      this.forget()
      try {
        this.d.onChanged()
      } catch {
        /* a page that is not told refetches on its next load */
      }
    }
  }

  private async cli(
    signal: AbortSignal
  ): Promise<{ bin: string; env: NodeJS.ProcessEnv; log: (line: string) => void; signal: AbortSignal }> {
    const bin = await this.d.locate()
    if (!bin) throw new Error(EXT_TEXT.cliMissing)
    return { bin, env: await this.d.env(), log: (l) => this.d.log(l), signal }
  }

  // ---- MCP servers ----

  // The one place local servers are read (the view, an edit's old def, stamp and restore): under the key the CLI files them by, the repo
  // root for a folder inside a repo (Ruling 21). The CLI writes still run in the chosen folder and pick that key themselves.
  private async userDefs(folder: string, scope: Exclude<McpScope, 'project'>, paths: Paths): Promise<Record<string, McpServerDef>> {
    const text = (await readText(paths.claudeJson)) ?? ''
    return scope === 'user' ? readUserServers(text, folder).user : readUserServers(text, localProjectKey(folder)).local
  }

  async server(folder: string, scope: McpScope, name: string): Promise<McpServerView> {
    try {
      if (scope === 'project') {
        const { servers, stamp } = await readProjectServers(folder)
        const def = own(servers, name)
        if (!def) throw new Error(EXT_TEXT.notFound)
        return serverView(def, scope, name, stamp)
      }
      const def = own(await this.userDefs(folder, scope, await this.paths()), name)
      if (!def) throw new Error(EXT_TEXT.notFound)
      return serverView(def, scope, name, defStamp(def))
    } catch (err) {
      throw pageError(err)
    }
  }

  /**
   * With a stamp, edits the server `prevName ?? name` (renaming it to `name`); without one, adds `name`, which must be free. User and
   * local scope go through the CLI: an edit is a remove then an add, and a failed add puts the old definition back.
   */
  async saveServer(folder: string, scope: McpScope, name: string, input: McpServerInput, prevName?: string, stamp?: string): Promise<void> {
    const from = prevName ?? name
    const edit = stamp !== undefined
    if (scope === 'project') {
      return this.write(
        () => join(folder, '.mcp.json'),
        async () => {
          if (!edit && prevName !== undefined) throw new Error(EXT_TEXT.notFound)
          const { servers, stamp: fileStamp } = await readProjectServers(folder)
          if (edit && stamp !== fileStamp) throw new Error(EXT_TEXT.stale)
          const old = edit ? own(servers, from) : undefined
          if (edit && !old) throw new Error(EXT_TEXT.notFound)
          if ((!edit || from !== name) && own(servers, name)) throw new Error(EXT_TEXT.nameTaken)
          const def = asServer(() => mergeInput(old ?? {}, input))
          await writeProjectServer(folder, name, def, fileStamp)
          if (from !== name) await writeProjectServer(folder, from, null, null)
        }
      )
    }
    return this.write(
      (p) => p.claudeJson,
      async (paths, signal) => {
        if (!edit && prevName !== undefined) throw new Error(EXT_TEXT.notFound)
        const defs = await this.userDefs(folder, scope, paths)
        const old = edit ? own(defs, from) : undefined
        if (edit && !old) throw new Error(EXT_TEXT.notFound)
        if (old && defStamp(old) !== stamp) throw new Error(EXT_TEXT.stale)
        if ((!edit || from !== name) && own(defs, name)) throw new Error(EXT_TEXT.nameTaken)
        const def = asServer(() => mergeInput(old ?? {}, input))
        const cli = await this.cli(signal)
        if (old) await mcpRemove({ ...cli, folder, scope, name: from })
        try {
          await mcpAdd({ ...cli, folder, scope, name, def })
        } catch (err) {
          if (!old) throw err
          try {
            // No signal: the old definition goes back even while the server stops, so a stop never leaves the server removed.
            await mcpAdd({ ...cli, signal: undefined, folder, scope, name: from, def: old })
          } catch {
            throw new Error(EXT_TEXT.addFailedLost)
          }
          throw new Error(EXT_TEXT.addFailedRestored)
        }
      }
    )
  }

  async removeServer(folder: string, scope: McpScope, name: string): Promise<void> {
    if (scope === 'project')
      return this.write(
        () => join(folder, '.mcp.json'),
        () => writeProjectServer(folder, name, null, null)
      )
    return this.write(
      (p) => p.claudeJson,
      async (_p, signal) => mcpRemove({ ...(await this.cli(signal)), folder, scope, name })
    )
  }

  // ---- plugins ----

  // The CLI writes `enabledPlugins` into the user's settings.json, so it waits in that file's queue.
  async setPlugin(id: string, enabled: boolean): Promise<void> {
    return this.write(
      (p) => settingsFileOf('user', this.d.home, p),
      async (_p, signal) => pluginSet({ ...(await this.cli(signal)), id, enabled, cwd: this.d.home })
    )
  }

  // ---- skills ----

  /** The user-scope skills by name, for Zumi Bot's skills_list: no path, and a skill that cannot be read is left out. */
  async userSkills(): Promise<{ name: string; description: string }[]> {
    try {
      const root = skillRoot('user', this.d.home, await this.paths())
      const out: { name: string; description: string }[] = []
      for (const dir of (await listSkillDirs(root)).values()) {
        const view = await readSkill(root, dir, 'user').catch(() => null)
        if (view) out.push({ name: view.name, description: view.description })
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (err) {
      throw pageError(err)
    }
  }

  async skill(scope: 'user' | 'project', folder: string, name: string): Promise<SkillView> {
    try {
      const root = skillRoot(scope, folder, await this.paths())
      const dir = (await listSkillDirs(root)).get(name)
      if (!dir) throw new Error(EXT_TEXT.notFound)
      return await readSkill(root, dir, scope)
    } catch (err) {
      throw pageError(err)
    }
  }

  /** With a stamp, edits that skill's description and body; without one, creates a new skill and never touches one that exists. */
  async saveSkill(
    scope: 'user' | 'project',
    folder: string,
    input: { name: string; description: string; body: string; stamp?: string }
  ): Promise<void> {
    return this.write(
      (p) => skillRoot(scope, folder, p),
      async (paths) => {
        const root = skillRoot(scope, folder, paths)
        // saveSkill with no stamp edits a skill of that name, so a create checks first.
        if (input.stamp === undefined && (RESERVED_SKILL_FOLDERS.has(input.name) || (await listSkillDirs(root)).has(input.name)))
          throw new Error(EXT_TEXT.nameTaken)
        await saveSkillFile(root, input, this.inside(scope, folder))
      }
    )
  }

  async removeSkill(scope: 'user' | 'project', folder: string, name: string): Promise<void> {
    return this.write(
      (p) => skillRoot(scope, folder, p),
      async (paths) => {
        const root = skillRoot(scope, folder, paths)
        const dir = (await listSkillDirs(root)).get(name)
        if (!dir) throw new Error(EXT_TEXT.notFound)
        await removeSkillDir(root, dir, this.d.trash, this.inside(scope, folder))
      }
    )
  }

  /** Off or on for every agent: `skillOverrides` in the user's settings.json. No page stamp: the edit touches that one key. */
  async setSkill(name: string, on: boolean): Promise<void> {
    const path = (p: Paths) => settingsFileOf('user', this.d.home, p)
    return this.write(path, (p) => writeSettings(path(p), null, (s) => setSkillOverride(s, name, on), SETTINGS_LABEL.user))
  }

  // ---- hooks ----

  /** An add may pass a null stamp (it only appends); an edit (`at`) carries the stamp of the file the page read. */
  async saveHook(file: HookFile, folder: string, input: HookInput, stamp: string | null): Promise<void> {
    const path = (p: Paths) => settingsFileOf(file, folder, p)
    return this.write(path, async (p) => {
      // A place in the file is only good for the text it was read from.
      if (input.at && stamp === null) throw new Error(EXT_TEXT.stale)
      await writeSettings(path(p), stamp, (s) => setHook(s, input), SETTINGS_LABEL[file], this.inside(file, folder))
    })
  }

  async removeHook(file: HookFile, folder: string, event: string, at: HookPosition, stamp: string): Promise<void> {
    const path = (p: Paths) => settingsFileOf(file, folder, p)
    return this.write(path, (p) =>
      writeSettings(path(p), stamp, (s) => removeHookIn(s, event, at), SETTINGS_LABEL[file], this.inside(file, folder))
    )
  }
}
