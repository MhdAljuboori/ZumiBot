import { promises as fs } from 'node:fs'
import type { UsageRecord } from '@zumibot/shared/usageReport'
import { writeFileAtomic } from '../fsutil'

export const USAGE_RECORDS_FILE = 'usage-records.jsonl'

/** Append-only record log, one JSON record per line, so a sync can join two machines by id. */
export class UsageStore {
  private records: UsageRecord[] = []
  private ids = new Set<string>()
  private torn = false // file ends without a newline: the next append would glue onto the broken tail
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Runs ops one at a time so appends never interleave lines. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  load(): Promise<void> {
    return this.run(async () => {
      let text = ''
      try {
        text = await fs.readFile(this.file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      this.records = []
      this.ids = new Set()
      this.torn = text.length > 0 && !text.endsWith('\n')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as UsageRecord
          if (typeof r?.id !== 'string' || this.ids.has(r.id)) continue // a torn tail line or a duplicate
          this.records.push(r)
          this.ids.add(r.id)
        } catch {
          /* broken line: skip it, the rest still counts */
        }
      }
    })
  }

  all(): readonly UsageRecord[] {
    return this.records
  }

  add(records: readonly UsageRecord[]): Promise<UsageRecord[]> {
    return this.run(async () => {
      const seen = new Set<string>()
      const fresh = records.filter((r) => {
        if (this.ids.has(r.id) || seen.has(r.id)) return false // also dedupes within this batch
        seen.add(r.id)
        return true
      })
      if (!fresh.length) return []
      // Ids join the held set only after the write, so a failed append can be retried.
      try {
        await fs.appendFile(this.file, (this.torn ? '\n' : '') + fresh.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
      } catch (err) {
        this.torn = true // a partial write may have left a line without its newline
        throw err
      }
      this.torn = false
      for (const r of fresh) this.ids.add(r.id)
      this.records.push(...fresh)
      return fresh
    })
  }

  renameAgent(from: string, to: string): Promise<boolean> {
    return this.run(async () => {
      let changed = false
      const next = this.records.map((r) => {
        if (r.kind === 'msg' || r.agent !== from) return r
        changed = true
        return { ...r, agent: to }
      })
      if (!changed) return false
      await writeFileAtomic(this.file, next.map((r) => JSON.stringify(r) + '\n').join(''))
      this.records = next
      this.torn = false
      return true
    })
  }
}
