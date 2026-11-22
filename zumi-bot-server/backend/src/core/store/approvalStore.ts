import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AgentRule } from '@zumibot/shared/types'
import { writeFileAtomic } from '../fsutil'

const isRule = (r: unknown): r is AgentRule => {
  const x = r as Partial<AgentRule> | null
  return (
    !!x &&
    typeof x.key === 'string' &&
    typeof x.toolName === 'string' &&
    (x.command === null || typeof x.command === 'string') &&
    (x.cli === undefined || typeof x.cli === 'string') // absent in files written before CLI rules
  )
}

// "Allow always for this agent" rules, per agent name. Memory answers has/list; every change then queues a file write.
export class ApprovalStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private rules = new Map<string, AgentRule[]>()
  // The file could not be read: no write may replace it until a read succeeds.
  private unread = false

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'approvals.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  async load(): Promise<void> {
    const loaded = await this.read()
    this.unread = loaded === null
    if (loaded) this.rules = loaded
  }

  /** The stored rules: none for a missing file, none for one that is not JSON (moved aside), null if it can't be read. */
  private async read(): Promise<Map<string, AgentRule[]> | null> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return new Map()
      console.error(`approvals: ${this.file} could not be read (${code ?? 'error'}), so changes are not saved`)
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      try {
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        return null // still in place: it must not be overwritten either
      }
      console.error(`approvals: ${this.file} is not valid JSON, moved aside`)
      return new Map()
    }
    const loaded = new Map<string, AgentRule[]>()
    if (raw && typeof raw === 'object') {
      for (const [agent, list] of Object.entries(raw)) {
        if (Array.isArray(list)) loaded.set(agent, list.filter(isRule))
      }
    }
    return loaded
  }

  has(agent: string, key: string): boolean {
    return this.rules.get(agent)?.some((r) => r.key === key) ?? false
  }

  list(agent: string): AgentRule[] {
    return [...(this.rules.get(agent) ?? [])]
  }

  /** The `Bash(<prefix>:*)` rules the agent's turns are started with, in stored order. */
  cliRules(agent: string): string[] {
    return (this.rules.get(agent) ?? []).flatMap((r) => (typeof r.cli === 'string' ? [r.cli] : []))
  }

  /** The agent names that hold rules. */
  agents(): string[] {
    return [...this.rules.keys()]
  }

  private save(): Promise<void> {
    return this.run(async () => {
      if (this.unread) {
        const stored = await this.read()
        if (!stored) throw new Error('approvals.json could not be read, so the change was not saved')
        // The stored rules come back; rules made since start are kept.
        for (const [agent, rules] of stored) {
          const merged = this.list(agent)
          for (const r of rules) if (!merged.some((m) => m.key === r.key)) merged.push(r)
          this.rules.set(agent, merged)
        }
        this.unread = false
      }
      // Taken when the write runs: after a late read, an earlier snapshot would lack the stored rules.
      const snapshot = Object.fromEntries(this.rules)
      await fs.mkdir(this.dataDir, { recursive: true })
      await writeFileAtomic(this.file, JSON.stringify(snapshot, null, 2))
    })
  }

  add(agent: string, rule: AgentRule): Promise<void> {
    if (!this.has(agent, rule.key)) this.rules.set(agent, [...this.list(agent), rule])
    return this.save()
  }

  remove(agent: string, key: string): Promise<void> {
    const rest = this.list(agent).filter((r) => r.key !== key)
    if (rest.length) this.rules.set(agent, rest)
    else this.rules.delete(agent)
    return this.save()
  }

  // Memory moves before the first await: a reply asking in between must already see the new name.
  renameAgent(from: string, to: string): Promise<void> {
    const moving = this.rules.get(from)
    if (!moving || from === to) return Promise.resolve()
    this.rules.delete(from)
    const merged = [...this.list(to)]
    for (const r of moving) if (!merged.some((m) => m.key === r.key)) merged.push(r)
    this.rules.set(to, merged)
    return this.save()
  }

  forgetAgents(names: readonly string[]): Promise<void> {
    let changed = false
    for (const n of names) changed = this.rules.delete(n) || changed
    return changed ? this.save() : Promise.resolve()
  }
}
