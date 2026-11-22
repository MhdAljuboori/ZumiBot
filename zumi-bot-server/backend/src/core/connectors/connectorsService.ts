import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { CONNECTORS, CONNECTOR_TEXT, connectorState, connectorTools, unknownTools } from '@zumibot/shared/connectors'
import type { ConnectorAgent, ConnectorCardView, ConnectorId, ConnectorServerName, ConnectorsView } from '@zumibot/shared/connectors'
import { engineOfAgent } from '@zumibot/shared/engine'
import type { AgentExtensions, Loadout } from '@zumibot/shared/extensions'
import type { AgentSummary } from '@zumibot/shared/types'
import type { ConnectorStore } from './connectorStore'
import { keptSwitches } from './migration'
import type { MigratingAgent } from './migration'

export interface ConnectorsDeps {
  store: ConnectorStore
  /** The home folder, no agent. `keep: false` (the start-up reads) leaves nothing in the loadout cache, so Settings › Claude Code's first read still probes. */
  loadout(refresh: boolean, keep?: boolean): Promise<Loadout>
  agents(): Promise<AgentSummary[]>
  extensionsOf(agent: string): Promise<AgentExtensions | null>
  /** The env var that makes the CLI skip claude.ai connectors: its name, never its value. */
  keyVar(): Promise<string | null>
  now(): number
  /** `connectors:changed` */
  onChanged(): void
  log(line: string): void
}

/** A failed name read is tried again no sooner than this after the last try started. */
const RETRY_MS = 60_000

// Zumi Bot never uses connectors; a Codex agent can't (it never sees claude.ai's).
const listed = (agents: AgentSummary[]): AgentSummary[] => agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)

export class ConnectorsService {
  private migrating: Promise<void> | null = null
  // Set by stop(): a shutdown abort of the probe is not a probe failure, so nothing is written and the next start tries again.
  private stopped = false
  // Catalog servers seen in successful home-folder reads, under whatever name the user gave them. Only ever grows.
  private readonly names = new Map<string, ConnectorId>()
  // For ready(): the read in flight, the start-up chain (switch-over then read), and how the last read went.
  private learning: Promise<void> | null = null
  private chain: Promise<void> | null = null
  private lastStart: number | null = null
  private lastOk = false

  constructor(private readonly d: ConnectorsDeps) {}

  /** Once per process: concurrent calls share one run. A failed write is forgotten so the next call can try again. */
  migrate(): Promise<void> {
    if (this.stopped || this.d.store.migrated()) return Promise.resolve()
    if (!this.migrating) {
      this.migrating = this.runMigration().catch((err) => {
        this.migrating = null
        throw err
      })
    }
    return this.migrating
  }

  /** Catalog servers seen in this process's successful home-folder reads (union, insertion order, no duplicates). */
  serverNames(): ConnectorServerName[] {
    return [...this.names].map(([name, connector]) => ({ name, connector }))
  }

  /** One home-folder read (`loadout(false)`, so a cached one is free) that adds to serverNames; never throws, no-op after stop(). Calls in flight share one read. */
  learn(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.learning) return this.learning
    if (!this.anyOn()) return Promise.resolve()
    this.lastStart = this.d.now()
    const run = (async () => {
      try {
        this.lastOk = this.note(await this.d.loadout(false, false))
      } catch {
        this.lastOk = false
        this.d.log('connectors: server names not read') // no error text: it may carry CLI output
      }
    })().finally(() => {
      this.learning = null
    })
    this.learning = run
    return run
  }

  // Names only matter for connectors some agent has on; with all off the probe is pure cost.
  private anyOn(): boolean {
    return this.d.store.agents().some((a) => (this.d.store.onFor(a)?.length ?? 0) > 0)
  }

  /** Server start: registers the switch-over and name read so ready() joins them. */
  track(chain: Promise<void>): void {
    const p = chain
      .catch(() => undefined)
      .finally(() => {
        if (this.chain === p) this.chain = null
      })
    this.chain = p
  }

  /**
   * A run's wait for the names its ask rules need (never throws, at most maxMs): joins a read in flight, else starts one when none
   * worked yet and some agent has a connector on, at most once a minute (a failed read is retried when runs need it, not on a timer).
   */
  async ready(maxMs: number): Promise<void> {
    if (this.stopped) return
    let wait = this.chain ?? this.learning
    if (!wait && !this.lastOk && this.anyOn() && (this.lastStart === null || this.d.now() - this.lastStart >= RETRY_MS)) wait = this.learn()
    if (!wait) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs)
    })
    try {
      await Promise.race([wait, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  // A read that reported a server error is partial, so it adds nothing (and is no success for ready()).
  private note(l: Loadout): boolean {
    if (l.errors.servers) return false
    for (const s of l.servers) if (s.connector) this.names.set(s.name, s.connector)
    return true
  }

  /** At server stop, before the probes are aborted: ends the switch-over without a write and waits for it, so none lands after the lock goes. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.migrating?.catch(() => undefined)
  }

  private async runMigration(): Promise<void> {
    const claude = listed(await this.d.agents()).filter((a) => engineOfAgent(a) === 'claude')
    if (this.stopped) return
    if (claude.length === 0) {
      await this.d.store.replace({}, 'kept')
      this.d.onChanged()
      this.d.log('connectors: kept on-state for 0 agents')
      return
    }
    let kept: Record<string, ConnectorId[]> | null = null
    try {
      const l = await this.d.loadout(false, false)
      this.note(l)
      if (!l.errors.servers) {
        const migrating: MigratingAgent[] = []
        for (const a of claude) {
          const e = await this.d.extensionsOf(a.name)
          migrating.push({
            name: a.name,
            serversOff: e?.serversOff ?? [],
            own: (e?.servers ?? []).flatMap((s) => (s.def ? [{ name: s.name, url: s.def.url ?? null }] : []))
          })
        }
        kept = keptSwitches(l.servers, migrating)
      }
    } catch {
      kept = null
    }
    if (this.stopped) return
    if (kept === null) {
      await this.d.store.replace({}, 'failed')
      this.d.log('connectors: switch-over probe failed, every connector starts off')
    } else {
      await this.d.store.replace(kept, 'kept')
      this.d.log(`connectors: kept on-state for ${Object.keys(kept).length} agents`)
    }
    this.d.onChanged()
  }

  async list(refresh: boolean): Promise<ConnectorsView> {
    const agents: ConnectorAgent[] = listed(await this.d.agents())
      .map((a) => ({ name: a.name, engine: engineOfAgent(a) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const keyVar = await this.d.keyVar()
    const migration = this.d.store.migration() ?? 'running'

    let loadout: Loadout | null = null
    let error: string | null = null
    try {
      loadout = await this.d.loadout(refresh)
      error = loadout.errors.servers ?? null
      this.note(loadout)
    } catch {
      error = CONNECTOR_TEXT.probeFailed // never the exception's text: it may carry CLI output
    }

    const claude = agents.filter((a) => a.engine === 'claude')
    const connectors: ConnectorCardView[] = CONNECTORS.map((c) => {
      if (error !== null || loadout === null)
        return { id: c.id, state: 'unknown', tools: [], unknownTools: [], on: [], remember: this.d.store.remembers(c.id) }
      const tools = connectorTools(loadout.servers, c.id)
      return {
        id: c.id,
        state: connectorState(loadout.servers, c.id),
        tools,
        unknownTools: unknownTools(c.id, tools),
        on: claude.filter((a) => this.d.store.onFor(a.name)?.includes(c.id)).map((a) => a.name),
        remember: this.d.store.remembers(c.id)
      }
    })
    return { keyVar, migration, error, agents, connectors, at: this.d.now() }
  }

  async setAgent(id: ConnectorId, agent: string, on: boolean): Promise<void> {
    await this.d.store.set(agent, id, on)
    this.d.onChanged()
  }

  async setRemember(id: ConnectorId, on: boolean): Promise<void> {
    await this.d.store.setRemember(id, on)
    this.d.onChanged()
  }
}

/** Server start: the switch-over, then one name read whether it worked or not (a failed write must not leave names unlearned). Never rejects; runs wait for it through ready(). */
export function startConnectors(svc: ConnectorsService, onSwitchOverFailed: (code: string) => void): Promise<void> {
  const run = (async () => {
    try {
      await svc.migrate()
    } catch (err) {
      onSwitchOverFailed((err as NodeJS.ErrnoException | undefined)?.code ?? 'write error')
    }
    await svc.learn()
  })()
  svc.track(run)
  return run
}
