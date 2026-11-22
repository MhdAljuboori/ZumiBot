import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../fsutil'
import type { LogMessage } from './sessionLogs'

export const ESTIMATE_VERSION = 1 // bump when pricing or reading rules change: the whole cache is dropped
export const ESTIMATES_FILE = 'usage-estimates.json'

export interface CachedLog {
  size: number
  offset: number
  messages: LogMessage[]
}

/** Per-log-file read results, so a restart reads only what was appended. Derived data: never synced. */
export class EstimateCache {
  private logs = new Map<string, CachedLog>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.logs = new Map()
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (data?.version !== ESTIMATE_VERSION || typeof data.logs !== 'object' || !data.logs) return
      for (const [path, log] of Object.entries<CachedLog>(data.logs)) {
        if (Array.isArray(log?.messages)) this.logs.set(path, log)
      }
    } catch {
      /* missing or broken cache: it is rebuilt from the logs */
    }
  }

  get(path: string): CachedLog | undefined {
    return this.logs.get(path)
  }

  merge(path: string, read: { messages: LogMessage[]; offset: number; size: number }): void {
    const byId = new Map((this.logs.get(path)?.messages ?? []).map((m) => [m.id, m]))
    for (const m of read.messages) {
      const prev = byId.get(m.id)
      if (!prev || m.tokens.output > prev.tokens.output) byId.set(m.id, m)
    }
    this.logs.set(path, { size: read.size, offset: read.offset, messages: [...byId.values()] })
  }

  reset(path: string): void {
    this.logs.delete(path)
  }

  async save(): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify({ version: ESTIMATE_VERSION, logs: Object.fromEntries(this.logs) }))
  }
}
