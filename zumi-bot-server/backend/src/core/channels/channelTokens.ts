import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ChannelPlatform } from '@zumibot/shared/channels'
import { writeFileAtomic } from '../fsutil'

/** A platform's tokens: Slack also has an app-level token for Socket Mode. */
export interface ChannelToken {
  token: string
  appToken?: string
}

/** The part of VaultStore this needs: sealing under the vault key, without ever handing the key out. */
export interface Sealer {
  sealExtra(id: string, updatedAt: number, body: unknown): Promise<string>
  openExtra(id: string, updatedAt: number, sealed: string): unknown
}

interface Entry {
  updatedAt: number
  sealed: string
}
interface TokensFile {
  v: 1
  tokens: Partial<Record<ChannelPlatform, Entry>>
}

const sealId = (p: ChannelPlatform) => `channel-token:${p}`

/**
 * channel-tokens.json (0600): each platform's bot token sealed under the vault key (AES-256-GCM, the vault's own seal).
 * Kept apart from vault.json on purpose: an older server reading a vault.json with an item kind it does not know would
 * read the whole vault as unreadable after a sync. Per machine, never synced: the token is needed only where the bot runs.
 * Never logged; read back only by the server itself.
 */
export class ChannelTokens {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private values = new Map<ChannelPlatform, ChannelToken>()
  private locked = new Set<ChannelPlatform>()

  constructor(
    dataDir: string,
    private readonly vault: Sealer,
    private readonly now: () => number = Date.now
  ) {
    this.file = join(dataDir, 'channel-tokens.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async readFile(): Promise<TokensFile> {
    try {
      const f = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<TokensFile>
      if (f && f.v === 1 && typeof f.tokens === 'object' && f.tokens !== null) return f as TokensFile
    } catch {
      /* missing or unreadable: no tokens */
    }
    return { v: 1, tokens: {} }
  }

  /** Opens every stored token; one that does not open (the vault key is missing or another) reads as `locked`. */
  load(): Promise<void> {
    return this.run(async () => {
      const f = await this.readFile()
      this.values.clear()
      this.locked.clear()
      for (const [p, e] of Object.entries(f.tokens) as [ChannelPlatform, Entry][]) {
        if (!e || typeof e.sealed !== 'string' || typeof e.updatedAt !== 'number') continue
        const body = this.vault.openExtra(sealId(p), e.updatedAt, e.sealed) as { token?: unknown; appToken?: unknown } | null
        if (body && typeof body.token === 'string' && body.token !== '') {
          this.values.set(p, {
            token: body.token,
            ...(typeof body.appToken === 'string' && body.appToken !== '' ? { appToken: body.appToken } : {})
          })
        } else this.locked.add(p)
      }
    })
  }

  get(p: ChannelPlatform): ChannelToken | null {
    return this.values.get(p) ?? null
  }

  /** A token is stored but can't be opened here (the vault key is missing or another one). */
  isLocked(p: ChannelPlatform): boolean {
    return this.locked.has(p)
  }

  configured(p: ChannelPlatform): boolean {
    return this.values.has(p) || this.locked.has(p)
  }

  /** Every token value, for the vault's scrub set. */
  all(): string[] {
    return [...this.values.values()].flatMap((t) => [t.token, ...(t.appToken ? [t.appToken] : [])])
  }

  set(p: ChannelPlatform, value: ChannelToken): Promise<void> {
    return this.run(async () => {
      const f = await this.readFile()
      const updatedAt = Math.max(this.now(), (f.tokens[p]?.updatedAt ?? 0) + 1)
      f.tokens[p] = { updatedAt, sealed: await this.vault.sealExtra(sealId(p), updatedAt, value) }
      await writeFileAtomic(this.file, JSON.stringify(f, null, 2), 0o600)
      this.values.set(p, value)
      this.locked.delete(p)
    })
  }

  remove(p: ChannelPlatform): Promise<void> {
    return this.run(async () => {
      const f = await this.readFile()
      delete f.tokens[p]
      await writeFileAtomic(this.file, JSON.stringify(f, null, 2), 0o600)
      this.values.delete(p)
      this.locked.delete(p)
    })
  }
}
