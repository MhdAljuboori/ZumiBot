import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../fsutil'

export const SPEND_CAPS_FILE = 'spend-caps.json'

/**
 * One agent's day under its daily spend cap. limitUsd: what Resume or Allow more today raised the day's limit to (absent = the
 * cap). tripped: the cap paused its turns and told the user, so the same crossing does neither again (also after a restart).
 */
export interface CapDay {
  day: string
  limitUsd?: number
  tripped?: true
}

const isDay = (v: unknown): v is CapDay => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.day) &&
    (o.limitUsd === undefined || (typeof o.limitUsd === 'number' && Number.isFinite(o.limitUsd) && o.limitUsd > 0)) &&
    (o.tripped === undefined || o.tripped === true)
  )
}

/**
 * `spend-caps.json`: each agent's latest day under its cap. Only today's entry ever counts, so an older one is simply
 * replaced. It stays on its machine (never synced): each server pauses and raises only its own runs.
 */
export class CapStore {
  private days = new Map<string, CapDay>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: unknown = null
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      // Missing or broken: no day was raised or tripped, which at worst pauses a turn once more.
    }
    const agents = raw && typeof raw === 'object' ? (raw as { agents?: unknown }).agents : null
    this.days = new Map()
    if (agents && typeof agents === 'object') {
      for (const [name, d] of Object.entries(agents as Record<string, unknown>)) if (isDay(d)) this.days.set(name, { ...d })
    }
  }

  /** The agent's state for this day; null when it has none for it. */
  day(agent: string, day: string): CapDay | null {
    const d = this.days.get(agent)
    return d && d.day === day ? d : null
  }

  set(agent: string, d: CapDay): Promise<void> {
    this.days.set(agent, d)
    return this.save()
  }

  renameAgent(from: string, to: string): Promise<void> {
    const d = this.days.get(from)
    if (!d) return Promise.resolve()
    this.days.delete(from)
    this.days.set(to, d)
    return this.save()
  }

  // In memory first, written in order: a read never waits for the file.
  private save(): Promise<void> {
    const body = JSON.stringify({ v: 1, agents: Object.fromEntries(this.days) }, null, 2) + '\n'
    const next = this.queue.then(() => writeFileAtomic(this.file, body))
    this.queue = next.catch(() => undefined)
    return next
  }
}
