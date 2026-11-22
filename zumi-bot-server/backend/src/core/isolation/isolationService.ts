import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { engineCaps, isolationRefusal, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import {
  ISOLATION_OFF,
  parseIsolation,
  type AgentIsolation,
  type IsolationLevel,
  type IsolationStatus,
  type SandboxSupport
} from '@zumibot/shared/isolation'
import { writeFileAtomic } from '../fsutil'
import { wideningRefusal } from './projectWiden'
import { gitDirsOf, sandboxSettings, toolchainReads, type HookRuntime } from './sandboxSettings'
import type { ContainerRun, ContainerRunner } from './containerRunner'
import { toSupport, type ContainerCheck } from './containerSupport'

// Each agent's isolation, kept in a server-owned file inside the audit folder: the vault guard's deny rules and hook already keep
// every agent off that folder, and Zumi Bot (which edits agent files with its file tools) cannot reach it. Only the UI's
// isolation:set changes it. Absent = Off, so agents never set behave exactly as before.

// Codex's sentences (isolationRefusal's), kept under their names for the callers and tests that use them.
export const CODEX_SANDBOX_REFUSED = isolationRefusal('codex', 'sandbox')
export const ISOLATION_UNREADABLE =
  "ZumiBot could not read this agent's isolation setting, so the run was not started. Open Agent Studio and save the agent's Isolation again."
export const sandboxUnavailable = (reason: string): string =>
  `This agent is sandboxed, but the sandbox is not available on this machine: ${reason} The run was not started.`
/** Agent Studio's reason for a Codex agent: neither level is offered. */
export const CODEX_ISOLATION_REFUSED = isolationRefusal('codex', null)
export const CODEX_CONTAINER_REFUSED = isolationRefusal('codex', 'container')
export const containerUnavailable = (reason: string): string =>
  `This agent runs in a container, but containers are not available on this machine: ${reason} The run was not started.`
export const CONTAINER_DESKTOP_REFUSED =
  'This agent runs in a container and has computer use on. Computer use drives your own desktop, outside any container, so the run was not started. Turn computer use off for this agent, or choose another isolation level.'
export const containerRefused = (reason: string): string =>
  `This agent runs in a container, and this run cannot: ${reason} The run was not started.`

export interface IsolationDeps {
  file: string
  home: string
  dataDir: string
  keyDir: string
  /** PATH as the CLI sees it (the user's shell's). */
  pathEnv(): Promise<string>
  checkSupport(): Promise<SandboxSupport>
  /** The file guard hook's runtime; null when this build lacks it, which refuses every sandboxed run. */
  fileHook: HookRuntime | null
  /** What each engine can do (default engineCaps): an engine without `isolation` has every isolated run refused. */
  caps?(engine: Engine): EngineCaps
}

/** Level 3's wiring (app.ts): the machine check, and the runner it makes possible (null when this build lacks the entry). */
export interface ContainerWiring {
  check(): Promise<ContainerCheck>
  runner(c: Extract<ContainerCheck, { available: true }>): ContainerRunner | null
}

export interface RunPlace {
  engine: Engine
  cwd: string
  tmpDir: string | null
  addDirs: string[]
  memoryDir: string | null
  /** The run has computer use, which a container cannot hold. */
  desktop?: boolean
  chatId?: string
}

/** A contained run's container, opened once the turn's env is known (its names cross; their values stay in podman's env). */
export interface ContainerPlan {
  open(env: Record<string, string>): Promise<ContainerRun | { refused: string }>
}

export type RunIsolation =
  | { level: 'off' }
  | { level: 'sandbox'; settings: string; network: string[] }
  | { level: 'sandbox'; refused: string }
  | { level: 'container'; network: string[]; autoBash: boolean; webSearch: boolean; plan: ContainerPlan }
  | { level: 'container'; refused: string }

interface StoredFile {
  v: 1
  agents: Record<string, AgentIsolation>
}

export class IsolationService {
  private agents = new Map<string, AgentIsolation>()
  private queue: Promise<void> = Promise.resolve()
  private support: Promise<SandboxSupport> | null = null
  private containerCheck: Promise<ContainerCheck> | null = null
  private containerWiring: ContainerWiring | null = null
  private runner: { key: string; runner: ContainerRunner | null } | null = null
  // The file could not be read: no agent's level is known, so every run is refused until the user saves a setting again.
  private broken = false
  private unreadable = new Set<string>()

  constructor(private d: IsolationDeps) {}

  async start(): Promise<void> {
    let text: string | null
    try {
      text = await fs.readFile(this.d.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      this.broken = true
      console.error('isolation settings not read:', (err as { code?: unknown }).code ?? 'error')
      return
    }
    let parsed: Partial<StoredFile>
    try {
      parsed = JSON.parse(text) as Partial<StoredFile>
    } catch {
      this.broken = true
      console.error('isolation settings not read: bad JSON')
      return
    }
    for (const [name, v] of Object.entries(parsed.agents ?? {})) {
      // A hand-broken entry refuses that agent's runs (logged by name only): it may have been Sandboxed.
      try {
        this.agents.set(name, parseIsolation(v))
      } catch {
        this.unreadable.add(name)
        console.error('isolation entry not read:', name)
      }
    }
  }

  useContainers(w: ContainerWiring): void {
    this.containerWiring = w
  }

  get(agent: string): AgentIsolation {
    return this.agents.get(agent) ?? ISOLATION_OFF
  }

  levelOf(agent: string): IsolationLevel {
    return this.get(agent).level
  }

  async set(agent: string, iso: AgentIsolation): Promise<void> {
    this.broken = false
    this.unreadable.delete(agent)
    if (iso.level === 'off' && iso.write.length + iso.read.length + iso.network.length === 0 && !iso.webSearch && !iso.autoBash)
      this.agents.delete(agent)
    else this.agents.set(agent, iso)
    await this.save()
  }

  /** An Agent Studio rename: the setting follows the agent. Never dropped on delete, so a re-added name stays as it was. */
  async rename(from: string, to: string): Promise<void> {
    const iso = this.agents.get(from)
    if (!iso) return
    this.agents.delete(from)
    this.agents.set(to, iso)
    await this.save()
  }

  async status(fresh = false): Promise<IsolationStatus> {
    if (fresh) {
      this.support = null
      this.containerCheck = null
    }
    const [sandbox, container] = await Promise.all([this.supportOf(), this.containerCheckOf().then(toSupport)])
    return { sandbox, container, toolchain: toolchainReads(await this.d.pathEnv(), this.d.home) }
  }

  private containerCheckOf(): Promise<ContainerCheck> {
    const w = this.containerWiring
    if (!w) return Promise.resolve({ available: false, reason: "This server's build has no container support." })
    // As the sandbox's: a failed check is not cached, so building the image needs no restart.
    this.containerCheck ??= w.check().then((c) => {
      if (!c.available) this.containerCheck = null
      return c
    })
    return this.containerCheck
  }

  private supportOf(): Promise<SandboxSupport> {
    // A failed check is not cached, so installing bwrap needs no restart.
    this.support ??= this.d.checkSupport().then((s) => {
      if (!s.available) this.support = null
      return s
    })
    return this.support
  }

  /** What a run of this agent gets: nothing (Off), the sandbox's settings, or a refusal shown as the chat's error. */
  async runFor(agent: string, place: RunPlace): Promise<RunIsolation> {
    if (this.broken || this.unreadable.has(agent)) return { level: 'sandbox', refused: ISOLATION_UNREADABLE }
    const iso = this.get(agent)
    if (iso.level === 'off') return { level: 'off' }
    // Codex, ACP and remote agents: ZumiBot can't hold their tools in the sandbox or a container, so the run is refused,
    // never run as Off (governance.md 2.3; protocol-engines.md, Capability table).
    if (!(this.d.caps ?? engineCaps)(place.engine).isolation) {
      const refused = isolationRefusal(place.engine, iso.level)
      return iso.level === 'container' ? { level: 'container', refused } : { level: 'sandbox', refused }
    }
    if (iso.level === 'container') return this.containerFor(agent, iso, place)
    const support = await this.supportOf()
    if (!support.available) return { level: 'sandbox', refused: sandboxUnavailable(support.reason) }
    if (this.d.fileHook === null)
      return { level: 'sandbox', refused: sandboxUnavailable("this server's build lacks the sandbox's file guard (sandboxFileHook.mjs).") }
    const widened = await wideningRefusal(place.cwd, this.d.home)
    if (widened !== null) return { level: 'sandbox', refused: widened }
    const toolchain = toolchainReads(await this.d.pathEnv(), this.d.home)
    const settings = sandboxSettings(
      iso,
      {
        cwd: place.cwd,
        tmpDir: place.tmpDir,
        gitDirs: await gitDirsOf(place.cwd),
        readDirs: place.addDirs,
        memoryDir: place.memoryDir
      },
      { home: this.d.home, dataDir: this.d.dataDir, keyDir: this.d.keyDir },
      toolchain,
      this.d.fileHook
    )
    return { level: 'sandbox', settings: JSON.stringify(settings), network: iso.network }
  }

  private async containerFor(agent: string, iso: AgentIsolation, place: RunPlace): Promise<RunIsolation> {
    if (place.desktop) return { level: 'container', refused: CONTAINER_DESKTOP_REFUSED }
    const check = await this.containerCheckOf()
    if (!check.available) return { level: 'container', refused: containerUnavailable(check.reason) }
    const key = `${check.podman}\n${check.claudeBin}`
    if (this.runner?.key !== key) this.runner = { key, runner: this.containerWiring!.runner(check) }
    const runner = this.runner.runner
    if (runner === null)
      return { level: 'container', refused: containerUnavailable("this server's build lacks the container entry (containerEntry.mjs).") }
    const gitDirs = await gitDirsOf(place.cwd)
    const chatId = place.chatId ?? 'chat'
    return {
      level: 'container',
      network: iso.network,
      autoBash: iso.autoBash,
      webSearch: iso.webSearch,
      plan: {
        open: async (env) => {
          const run = await runner.open({ chatId, agent, cwd: place.cwd, tmpDir: place.tmpDir, addDirs: place.addDirs, gitDirs, env, iso })
          return 'refused' in run ? { refused: containerRefused(run.refused) } : run
        }
      }
    }
  }

  private save(): Promise<void> {
    const next = this.queue.then(async () => {
      await fs.mkdir(dirname(this.d.file), { recursive: true, mode: 0o700 })
      const body: StoredFile = { v: 1, agents: Object.fromEntries([...this.agents].sort(([a], [b]) => a.localeCompare(b))) }
      await writeFileAtomic(this.d.file, JSON.stringify(body, null, 2) + '\n', 0o600)
    })
    this.queue = next.catch(() => {})
    return next
  }
}

/** The `--add-dir` folders in a run's args (attachments): the file tools see them, so a sandboxed Bash may read them too. */
export function addDirsOf(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (a === '--add-dir' && typeof args[i + 1] === 'string' ? [args[i + 1]] : []))
}
