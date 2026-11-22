import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ModelSpend, ModelSpends } from '@zumibot/shared/usageReport'
import type { RunCost } from './runCost'

/**
 * A resumed CLI restores the session's last `cost-state` line and adds the run to it, so a result's `total_cost_usd` and
 * `modelUsage` are the whole session's so far (forks and cut runs carry the source session's too). Read before the run
 * starts, that line is what the run's own cost must be measured from.
 */
export type CostBaseline = (sessionId: string) => Promise<ModelSpends | null>

const CHUNK = 64 * 1024
const MARK = '"type":"cost-state"'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

function spendsOf(line: string): ModelSpends | null {
  let o: any
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (o?.type !== 'cost-state' || !o.modelUsage || typeof o.modelUsage !== 'object') return null
  const out: ModelSpends = {}
  for (const [name, m] of Object.entries(o.modelUsage as Record<string, any>)) {
    if (!m || typeof m !== 'object') continue
    out[name] = {
      input: num(m.inputTokens),
      output: num(m.outputTokens),
      cacheRead: num(m.cacheReadInputTokens),
      cacheWrite: num(m.cacheCreationInputTokens),
      costUsd: typeof m.costUSD === 'number' && Number.isFinite(m.costUSD) ? m.costUSD : null
    }
  }
  return out
}

/** The newest cost-state of a session log, read backwards a chunk at a time (logs grow to many MB). */
export async function lastCostState(path: string): Promise<ModelSpends | null> {
  let fh: fs.FileHandle
  try {
    fh = await fs.open(path, 'r')
  } catch {
    return null
  }
  try {
    let end = (await fh.stat()).size
    let carry = '' // the start of a line cut by the chunk before it
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, buf.length, start)
      // Splitting on '\n' bytes keeps multi-byte characters whole: a newline byte never sits inside one.
      const lines = (buf.toString('latin1') + carry).split('\n')
      carry = start > 0 ? lines.shift()! : ''
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(MARK)) continue
        const found = spendsOf(Buffer.from(lines[i], 'latin1').toString('utf8'))
        if (found) return found
      }
      end = start
    }
    return carry.includes(MARK) ? spendsOf(Buffer.from(carry, 'latin1').toString('utf8')) : null
  } finally {
    await fh.close()
  }
}

/** The project folder name is never rebuilt from the cwd: any folder may hold the log (as findSessionFiles does). */
export function createCostBaseline(projectsDir: string): CostBaseline {
  return async (sessionId) => {
    let projects: string[]
    try {
      projects = await fs.readdir(projectsDir)
    } catch {
      return null
    }
    for (const p of projects) {
      const file = join(projectsDir, p, `${sessionId}.jsonl`)
      try {
        await fs.access(file)
      } catch {
        continue
      }
      return lastCostState(file)
    }
    return null
  }
}

const minus = (a: number, b: number): number => Math.max(0, a - b)

/** What the run added on top of the restored state; a model it did not use again drops out. */
export function minusBaseline(cost: RunCost, base: ModelSpends | null): RunCost {
  if (!base) return cost
  const models: ModelSpends = {}
  for (const [name, m] of Object.entries(cost.models)) {
    const b = base[name]
    const d: ModelSpend = b
      ? {
          input: minus(m.input, b.input),
          output: minus(m.output, b.output),
          cacheRead: minus(m.cacheRead, b.cacheRead),
          cacheWrite: minus(m.cacheWrite, b.cacheWrite),
          costUsd: m.costUsd === null ? null : minus(m.costUsd, b.costUsd ?? 0)
        }
      : m
    if (d.input || d.output || d.cacheRead || d.cacheWrite) models[name] = d
  }
  const totalUsd = Object.values(models).reduce((s, m) => s + (m.costUsd ?? 0), 0)
  return { totalUsd, models }
}
