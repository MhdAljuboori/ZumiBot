import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomic } from '../fsutil'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function agentName(agent: string): void {
  if (!agent || agent.length > 256 || agent === '.' || agent === '..' || /[/\\\0]/.test(agent)) {
    throw new Error('Invalid browser agent name')
  }
}
export type BrowserProfile = { id: string; dir: string }

/** A failed read blocks writes; mappings change only after their atomic write succeeds. */
export class BrowserProfileStore {
  private readonly root: string
  private readonly file: string
  private profiles = new Map<string, string>()
  private loaded = false
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()

  /** `folder` lets agent desktops keep their own opaque profiles (`desktops/`) with the same rules. */
  constructor(
    dataDir: string,
    private readonly newId: () => string = randomUUID,
    folder: 'browsers' | 'desktops' = 'browsers'
  ) {
    this.root = join(dataDir, folder)
    this.file = join(this.root, 'profiles.json')
  }
  private run<T>(op: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Browser profiles are closed'))
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }
  /**
   * Shutdown: a turn still being set up may ask for its agent's profile after the server stopped, and would create
   * a directory in the data dir after its lock is released. The write in flight finishes; later ones are refused.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.queue
  }
  private async privateDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe browser profile directory')
    await fs.chmod(path, 0o700)
  }
  load(): Promise<void> {
    return this.run(async () => {
      this.loaded = false
      await this.privateDir(this.root)
      let raw: unknown
      try {
        const stat = await fs.lstat(this.file)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe browser profile metadata')
        raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
        await fs.chmod(this.file, 0o600)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Browser profile metadata could not be read')
        raw = { version: 1, profiles: {} }
      }
      const value = raw as { version?: unknown; profiles?: unknown } | null
      if (!value || value.version !== 1 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) {
        throw new Error('Invalid browser profile metadata')
      }
      const next = new Map<string, string>(),
        seen = new Set<string>()
      for (const [agent, id] of Object.entries(value.profiles)) {
        agentName(agent)
        if (typeof id !== 'string' || !uuid.test(id) || seen.has(id)) throw new Error('Invalid browser profile metadata')
        next.set(agent, id)
        seen.add(id)
      }
      this.profiles = next
      this.loaded = true
    })
  }
  agents(): string[] {
    return [...this.profiles.keys()]
  }
  byId(profileId: string): Promise<(BrowserProfile & { agent: string }) | null> {
    return this.run(async () => {
      this.check()
      for (const [agent, id] of this.profiles) {
        if (id === profileId) return { agent, id, dir: join(this.root, id) }
      }
      return null
    })
  }
  private check(): void {
    if (!this.loaded) throw new Error('Browser profile metadata must be loaded before changes')
  }
  private async save(next: Map<string, string>): Promise<void> {
    await this.privateDir(this.root)
    try {
      const stat = await fs.lstat(this.file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe browser profile metadata')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await writeFileAtomic(this.file, JSON.stringify({ version: 1, profiles: Object.fromEntries(next) }, null, 2), 0o600)
    this.profiles = next
  }
  private async create(agent: string): Promise<BrowserProfile> {
    await this.privateDir(this.root)
    const id = this.newId()
    if (!uuid.test(id) || [...this.profiles.values()].includes(id)) throw new Error('Invalid or duplicate browser profile ID')
    const dir = join(this.root, id)
    // Exclusive creation prevents even orphaned directories from being reused.
    await fs.mkdir(dir, { mode: 0o700 })
    await fs.chmod(dir, 0o700)
    const next = new Map(this.profiles)
    next.set(agent, id)
    await this.save(next)
    return { id, dir }
  }
  ensure(agent: string): Promise<BrowserProfile> {
    return this.run(async () => {
      agentName(agent)
      this.check()
      const id = this.profiles.get(agent)
      if (!id) return this.create(agent)
      const dir = join(this.root, id)
      await this.privateDir(this.root)
      await this.privateDir(dir)
      return { id, dir }
    })
  }
  renameAgent(from: string, to: string): Promise<void> {
    return this.run(async () => {
      agentName(from)
      agentName(to)
      this.check()
      if (from === to || !this.profiles.has(from)) return
      if (this.profiles.has(to)) throw new Error('Browser profile rename collision')
      const next = new Map(this.profiles),
        id = next.get(from)!
      next.delete(from)
      next.set(to, id)
      await this.save(next)
    })
  }
  detachAgents(names: readonly string[]): Promise<void> {
    return this.run(async () => {
      names.forEach(agentName)
      this.check()
      const next = new Map(this.profiles)
      for (const name of names) next.delete(name)
      await this.save(next)
    })
  }
  replace(agent: string): Promise<BrowserProfile> {
    return this.run(async () => {
      agentName(agent)
      this.check()
      return this.create(agent)
    })
  }
}
