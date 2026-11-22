import { promises as fs } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import type { WebhookCall } from '@zumibot/shared/routines'
import { writeFileAtomic } from '../fsutil'

export interface HookRecord {
  id: string
  secret: string
  latest: WebhookCall | null
  draftAt: number | null
  /** Explicit workflow id reservation; draftAt alone also marks orphaned hooks for expiry. */
  reserved?: true
}

export const MIN_SECRET_LENGTH = 16

/** Constant-time compare of the presented secret with a stored one; a stored secret that is too short never matches. */
export function secretMatches(stored: unknown, given: unknown): boolean {
  if (typeof stored !== 'string' || stored.length < MIN_SECRET_LENGTH || typeof given !== 'string') return false
  return timingSafeEqual(createHash('sha256').update(stored).digest(), createHash('sha256').update(given).digest())
}

/** One 0600 file of webhook hooks with its own serial queue; routines and workflows each keep one. */
export class HookFile {
  private queue: Promise<unknown> = Promise.resolve()

  /** owners: the ids of the saved owners of a hook, read through the owner's own queue (see dropStaleDrafts). */
  constructor(
    private readonly path: string,
    private readonly owners: () => Promise<string[]> = async () => []
  ) {}

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<HookRecord[]> {
    let text: string
    try {
      text = await fs.readFile(this.path, 'utf8')
    } catch (err) {
      // Only a missing file is empty: any other failure must not end in a write that wipes the rest.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      await fs.rename(this.path, `${this.path}.corrupt-${Date.now()}`)
      console.error(`hooks: ${this.path} is not valid JSON, moved aside`) // name only, never contents (hooks hold secrets)
      return []
    }
    return Array.isArray(value) ? value : []
  }

  private async write(rows: HookRecord[]): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    await writeFileAtomic(this.path, JSON.stringify(rows), 0o600)
  }

  hook(id: string): Promise<HookRecord | null> {
    return this.run(async () => (await this.read()).find((h) => h.id === id) ?? null)
  }

  putHook(h: HookRecord): Promise<void> {
    return this.run(async () => {
      const rows = await this.read()
      const index = rows.findIndex((x) => x.id === h.id)
      if (index < 0) rows.push(h)
      else rows[index] = h
      await this.write(rows)
    })
  }

  /**
   * Sets only `latest`, and only if the hook still exists with the secret the caller presented (a rotation or removal
   * mid-request wins).
   */
  recordCall(id: string, secret: string, call: WebhookCall): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.read()
      const i = rows.findIndex((x) => x.id === id)
      if (i < 0 || !secretMatches(rows[i]!.secret, secret)) return false
      rows[i] = { ...rows[i]!, latest: call }
      await this.write(rows)
      return true
    })
  }

  /** The existing record untouched, or a new one: one step on the queue, so two callers never make two secrets. */
  ensureHook(id: string, makeSecret: () => string, draftAt: number | null): Promise<HookRecord> {
    return this.run(async () => {
      const rows = await this.read()
      const found = rows.find((x) => x.id === id)
      if (found) return found
      const made: HookRecord = { id, secret: makeSecret(), latest: null, draftAt }
      rows.push(made)
      await this.write(rows)
      return made
    })
  }

  /** Sets only `secret`; false when the hook is gone, so a removal mid-request is never undone. */
  rotateSecret(id: string, secret: string): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.read()
      const i = rows.findIndex((x) => x.id === id)
      if (i < 0) return false
      rows[i] = { ...rows[i]!, secret }
      await this.write(rows)
      return true
    })
  }

  /** Sets only `draftAt` to null (the owner was saved). */
  clearDraft(id: string): Promise<void> {
    return this.run(async () => {
      const rows = await this.read()
      const i = rows.findIndex((x) => x.id === id)
      if (i < 0 || rows[i]!.draftAt === null) return
      const { reserved: _reserved, ...hook } = rows[i]!
      rows[i] = { ...hook, draftAt: null }
      await this.write(rows)
    })
  }

  dropHook(id: string): Promise<void> {
    return this.run(async () => {
      await this.write((await this.read()).filter((h) => h.id !== id))
    })
  }

  async dropStaleDrafts(olderThan: number): Promise<string[]> {
    // Through the owner's queue, never straight from the hooks queue: a corrupt-file rename-aside must not race.
    const owners = new Set(await this.owners())
    return this.run(async () => {
      const hooks = await this.read()
      const dropped = hooks.filter((h) => h.draftAt !== null && h.draftAt < olderThan && !owners.has(h.id)).map((h) => h.id)
      await this.write(hooks.filter((h) => !dropped.includes(h.id)))
      return dropped
    })
  }
}
