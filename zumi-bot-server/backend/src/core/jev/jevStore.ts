import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { JevStatus, JevSwitches } from '@zumibot/shared/jev'
import { writeFileAtomic } from '../fsutil'

interface JevFile extends JevSwitches {
  apiKey: string | null
}

const defaults = (): JevFile => ({ apiKey: null, enabled: true, moderator: true, approvalRisk: true, agentSuggest: true })

/** jev.json: the OpenRouter key and Jev's switches. It holds a secret, so it is written 0600. */
export class JevStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'jev.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  // Read on every use: tiny, and a switch flipped in one tab applies to the very next decision.
  private async read(): Promise<JevFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<JevFile>
      const d = defaults()
      const flag = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def)
      return {
        apiKey: typeof raw.apiKey === 'string' && raw.apiKey !== '' ? raw.apiKey : null,
        enabled: flag(raw.enabled, d.enabled),
        moderator: flag(raw.moderator, d.moderator),
        approvalRisk: flag(raw.approvalRisk, d.approvalRisk),
        agentSuggest: flag(raw.agentSuggest, d.agentSuggest)
      }
    } catch {
      return defaults()
    }
  }

  private async write(f: JevFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(f, null, 2), 0o600)
  }

  private static status({ apiKey, ...switches }: JevFile): JevStatus {
    return { keySet: apiKey !== null, ...switches }
  }

  status(): Promise<JevStatus> {
    return this.run(async () => JevStore.status(await this.read()))
  }

  key(): Promise<string | null> {
    return this.run(async () => (await this.read()).apiKey)
  }

  setKey(apiKey: string | null): Promise<JevStatus> {
    return this.run(async () => {
      const next = { ...(await this.read()), apiKey }
      await this.write(next)
      return JevStore.status(next)
    })
  }

  setSwitches(patch: Partial<JevSwitches>): Promise<JevStatus> {
    return this.run(async () => {
      const next = { ...(await this.read()), ...patch }
      await this.write(next)
      return JevStore.status(next)
    })
  }
}
