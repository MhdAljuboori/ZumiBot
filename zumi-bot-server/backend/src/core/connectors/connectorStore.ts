import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { CONNECTOR_IDS, CONNECTOR_TEXT, isConnectorId } from '@zumibot/shared/connectors'
import type { ConnectorId, ConnectorMigration } from '@zumibot/shared/connectors'
import { writeFileAtomic } from '../fsutil'

type Settled = Exclude<ConnectorMigration, 'running'>
interface Stored {
  agents: Map<string, ConnectorId[]>
  /** null: no file yet, so the switch-over has not run. */
  migration: Settled | null
  /** Services whose write cards offer Allow for this chat / Allow always, and whose remembered answers then apply: per service, not per agent. */
  remember: Set<ConnectorId>
  /** The file was unusable and moved aside: the all-off state must be written back, or a restart would read "no file" as not migrated. */
  reset?: true
}

const UNREAD = 'connectors.json could not be read, so the change was not saved'

// Catalog order, no repeats: the file and every reader see one shape.
const normalize = (ids: readonly unknown[]): ConnectorId[] => CONNECTOR_IDS.filter((id) => ids.includes(id))

// Which catalog connectors each agent has switched on, and which services remember write approvals (all are off until then). Memory answers reads; every change then queues a file write.
export class ConnectorStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private on = new Map<string, ConnectorId[]>()
  private state: Settled | null = null
  private remember = new Set<ConnectorId>()
  // The file could not be read: no write may replace it until a read succeeds.
  private unread = false

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'connectors.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  async load(): Promise<void> {
    const loaded = await this.read()
    this.unread = loaded === null
    if (!loaded) return
    this.adopt(loaded)
    if (loaded.reset) {
      try {
        await this.write()
      } catch {
        console.error(`connectors: ${this.file} was moved aside but the all-off state could not be saved`)
      }
    }
  }

  private adopt(s: Stored): void {
    this.on = s.agents
    this.state = s.migration
    this.remember = s.remember
  }

  /** The stored switches: none (not migrated) for a missing file, all off for one that is not JSON (moved aside), null if it can't be read. */
  private async read(): Promise<Stored | null> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { agents: new Map(), migration: null, remember: new Set() }
      console.error(`connectors: ${this.file} could not be read (${code ?? 'error'}), so changes are not saved`)
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = undefined
    }
    const obj = raw as { v?: unknown; agents?: unknown; migration?: unknown; remember?: unknown } | null | undefined
    // Not JSON, or JSON of another shape: set aside like any unusable file, so the next write cannot destroy it unseen.
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.v !== 1) {
      try {
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        return null // still in place: it must not be overwritten either
      }
      console.error(`connectors: ${this.file} is not a connectors file, moved aside`)
      return { agents: new Map(), migration: 'failed', remember: new Set(), reset: true }
    }
    const agents = new Map<string, ConnectorId[]>()
    if (obj.agents && typeof obj.agents === 'object' && !Array.isArray(obj.agents)) {
      for (const [agent, list] of Object.entries(obj.agents)) {
        const ids = Array.isArray(list) ? normalize(list) : []
        if (ids.length) agents.set(agent, ids)
      }
    }
    // Only an explicit true counts; an unknown key or any other value is dropped without calling the file corrupt.
    const remember = new Set<ConnectorId>()
    if (obj.remember && typeof obj.remember === 'object' && !Array.isArray(obj.remember)) {
      const flags = obj.remember as Record<string, unknown>
      for (const id of CONNECTOR_IDS) if (flags[id] === true) remember.add(id)
    }
    // A file that exists is a finished switch-over; only an explicit "kept" says the connectors were carried over.
    return { agents, migration: obj.migration === 'kept' ? 'kept' : 'failed', remember }
  }

  // Taken in the queue before a write: the stored switches come back and the change lands on them, so nothing stored is overwritten or lost.
  private async recover(): Promise<boolean> {
    if (!this.unread) return false
    const stored = await this.read()
    if (!stored) throw new Error(UNREAD)
    this.adopt(stored)
    this.unread = false
    return stored.reset === true
  }

  // Runs inside the queue. Taken when the write runs, so queued changes are never written from an older picture.
  private async flush(): Promise<void> {
    await this.recover()
    const agents = Object.fromEntries(this.on)
    await fs.mkdir(this.dataDir, { recursive: true })
    const remember = Object.fromEntries(CONNECTOR_IDS.filter((id) => this.remember.has(id)).map((id) => [id, true]))
    await writeFileAtomic(this.file, JSON.stringify({ v: 1, agents, migration: this.state, remember }, null, 2), 0o600)
  }

  private write(): Promise<void> {
    return this.run(() => this.flush())
  }

  /** A file was read, or the switch-over ran. An unreadable file counts: its switches exist but read as all off. */
  migrated(): boolean {
    return this.unread || this.state !== null
  }

  migration(): Settled | null {
    return this.unread ? null : this.state
  }

  /** The connectors on for the agent in catalog order; null until the switch-over has run. */
  onFor(agent: string): ConnectorId[] | null {
    if (!this.migrated()) return null
    return this.unread ? [] : [...(this.on.get(agent) ?? [])]
  }

  /** The ones to deny for a run: none before the switch-over (today's behaviour), else every catalog connector not on. */
  offFor(agent: string): ConnectorId[] {
    const on = this.onFor(agent)
    return on === null ? [] : CONNECTOR_IDS.filter((id) => !on.includes(id))
  }

  /** The agent names that hold switches. */
  agents(): string[] {
    return this.unread ? [] : [...this.on.keys()]
  }

  /**
   * Applies one change in memory now and returns the job that saves it. If the save fails, that one value goes back
   * (only while nothing newer changed it): memory must never hold a switch the file lacks, or the next write would
   * persist it and, for Remember, writes would skip their card although the user was told the save failed.
   */
  private edit<T>(get: () => T, put: (v: T) => void, next: T, same: (a: T, b: T) => boolean): () => Promise<void> {
    const prev = get()
    put(next)
    return async () => {
      try {
        await this.flush()
      } catch (err) {
        if (same(get(), next)) put(prev)
        throw err
      }
    }
  }

  // Memory answers at once on the fast path; an unreadable file is re-read first (queued), and nothing is written before the switch-over.
  private commit(change: () => () => Promise<void>): Promise<void> {
    if (this.migrated() && !this.unread) return this.run(change())
    return this.run(async () => {
      await this.recover()
      if (this.state === null) throw new Error(CONNECTOR_TEXT.settingUp)
      await change()()
    })
  }

  set(agent: string, id: ConnectorId, on: boolean): Promise<void> {
    const list = (): ConnectorId[] => [...(this.on.get(agent) ?? [])]
    const put = (v: ConnectorId[]): void => {
      if (v.length) this.on.set(agent, v)
      else this.on.delete(agent)
    }
    return this.commit(() =>
      this.edit(
        list,
        put,
        normalize(on ? [...list().filter((x) => x !== id), id] : list().filter((x) => x !== id)),
        (a, b) => a.join() === b.join()
      )
    )
  }

  /** Whether the service's write cards offer Allow for this chat / Allow always and remembered answers apply (a write still gets a card). False while the file is unreadable, like every switch. */
  remembers(id: ConnectorId): boolean {
    return !this.unread && this.remember.has(id)
  }

  setRemember(id: ConnectorId, on: boolean): Promise<void> {
    const put = (v: boolean): void => {
      if (v) this.remember.add(id)
      else this.remember.delete(id)
    }
    return this.commit(() =>
      this.edit(
        () => this.remember.has(id),
        put,
        on,
        (a, b) => a === b
      )
    )
  }

  /** The switch-over's one write. Once a file was read or this ran, it does nothing. */
  replace(agents: Record<string, ConnectorId[]>, migration: 'kept' | 'failed'): Promise<void> {
    if (this.migrated()) return Promise.resolve()
    const next = new Map<string, ConnectorId[]>()
    for (const [agent, list] of Object.entries(agents)) {
      const ids = normalize(list)
      if (ids.length) next.set(agent, ids)
    }
    this.on = next
    this.state = migration
    return this.write()
  }

  // Memory moves before the first await: a run starting in between must already see the new name.
  renameAgent(from: string, to: string): Promise<void> {
    if (from === to) return Promise.resolve()
    const move = (): boolean => {
      const moving = this.on.get(from)
      if (!moving) return false
      this.on.delete(from)
      this.on.set(to, normalize([...(this.on.get(to) ?? []), ...moving]))
      return true
    }
    return this.change(move)
  }

  forgetAgents(names: readonly string[]): Promise<void> {
    return this.change(() => names.reduce((changed, n) => this.on.delete(n) || changed, false))
  }

  // An unreadable file is re-read first (queued), so the change lands on what is stored; before the switch-over there is nothing to change.
  private change(mutate: () => boolean): Promise<void> {
    if (!this.unread) return mutate() ? this.write() : Promise.resolve()
    return this.run(async () => {
      const reset = await this.recover()
      if (mutate() || reset) await this.flush()
    })
  }
}
