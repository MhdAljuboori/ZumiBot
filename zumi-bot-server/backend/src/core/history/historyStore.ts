import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  HISTORY_ID_RE,
  pruneVersions,
  sameDef,
  type DefinitionVersion,
  type HistoryFile,
  type VersionSource
} from '@zumibot/shared/definitionHistory'
import { writeFileAtomic } from '../fsutil'

export interface RecordInput<D> {
  before: { def: D; at: number } | null // the definition the save replaced, and its updatedAt; null for a new one
  after: D
  source: Exclude<VersionSource, 'earlier'>
  restoredFrom?: number
}

const isVersion = (v: unknown): v is DefinitionVersion<unknown> => {
  const x = v as Partial<DefinitionVersion<unknown>> | null
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.savedAt === 'number' && !!x.def && typeof x.def === 'object'
}

/**
 * The saved history of one kind (workflows or routines): one file per item, `<dir>/<id>.json`, newest version first.
 * One queue per item, so a save's read and write never interleave with another's; different items never wait on each other.
 */
export class HistoryStore<D> {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly dir: string,
    private readonly d: { newId: () => string; now: () => number; label: string }
  ) {}

  private file(id: string): string {
    // Ids are the server's own, but a bad one must never become a path outside the folder.
    if (!HISTORY_ID_RE.test(id)) throw new Error('Invalid id')
    return join(this.dir, `${id}.json`)
  }

  private run<T>(id: string, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(op, op)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(id, tail)
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id)
    })
    return next
  }

  private async read(id: string): Promise<DefinitionVersion<D>[]> {
    const file = this.file(id)
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      // Only a missing file is empty: any other failure must not end in a write that wipes the rest.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      console.error(`${this.d.label}: a history file is not valid JSON, moved aside`) // never its name's id or contents
      return []
    }
    const versions = (value as Partial<HistoryFile<D>> | null)?.versions
    return Array.isArray(versions) ? (versions.filter(isVersion) as DefinitionVersion<D>[]) : []
  }

  private async write(id: string, versions: DefinitionVersion<D>[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const file: HistoryFile<D> = { v: 1, versions: pruneVersions(versions) }
    await writeFileAtomic(this.file(id), JSON.stringify(file))
  }

  list(id: string): Promise<DefinitionVersion<D>[]> {
    return this.run(id, () => this.read(id))
  }

  async get(id: string, versionId: string): Promise<DefinitionVersion<D> | null> {
    return (await this.list(id)).find((v) => v.id === versionId) ?? null
  }

  /**
   * Keeps a save's definition. A save that changed nothing keeps nothing. What the save replaced is kept first, as an
   * earlier version, when the history does not end in it (none kept yet, or something wrote around a save). True when a
   * version was added.
   */
  record(id: string, o: RecordInput<D>): Promise<boolean> {
    return this.run(id, async () => {
      if (o.before && sameDef(o.before.def, o.after)) return false
      const versions = await this.read(id)
      const out = versions.slice()
      if (o.before && (out.length === 0 || !sameDef(out[0]!.def, o.before.def))) {
        out.unshift({ id: this.d.newId(), savedAt: o.before.at, source: 'earlier', def: o.before.def })
      }
      if (out[0] && sameDef(out[0].def, o.after)) return false
      out.unshift({
        id: this.d.newId(),
        savedAt: this.d.now(),
        source: o.source,
        ...(o.source === 'restore' && o.restoredFrom !== undefined ? { restoredFrom: o.restoredFrom } : {}),
        def: o.after
      })
      await this.write(id, out)
      return true
    })
  }

  remove(id: string): Promise<void> {
    return this.run(id, async () => {
      await fs.rm(this.file(id), { force: true })
    })
  }

  /** Rewrites every kept definition through `fn` (null: unchanged), as an agent rename does; only changed files are written. */
  async rewrite(fn: (def: D) => D | null): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
      if (!HISTORY_ID_RE.test(id)) continue
      await this.run(id, async () => {
        const versions = await this.read(id)
        let changed = false
        const next = versions.map((v) => {
          const def = fn(v.def)
          if (!def) return v
          changed = true
          return { ...v, def }
        })
        if (changed) await this.write(id, next)
      })
    }
  }
}
