import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { priceMessage, usageTokens, type MessageTokens } from '@zumibot/shared/pricing'

/** One model request as the CLI's session log has it: its lines' first and last time, its tokens and its tool calls. */
export interface LogRequest {
  id: string // the API message id
  model: string
  startedAt: number // the request's first logged line
  endedAt: number // its last
  tokens: MessageTokens
  costUsd: number | null
  toolIds: string[]
  wrote: boolean // a text or thinking block
}

/** A subagent's log file and the dispatching tool use id its `.meta.json` names (null: older CLIs wrote none). */
export interface SubagentLog {
  file: string
  toolUseId: string | null
}

type Obj = Record<string, any>

interface Acc extends LogRequest {
  best: number // the most output seen: the CLI repeats a message's usage on each block line, growing
}

/**
 * The requests logged in [from, to], oldest first. Only assistant lines are parsed (a quick substring check first), so a
 * long session log costs one pass of reading. A file that is gone reads as none.
 */
export async function readRequests(file: string, from: number, to: number): Promise<LogRequest[]> {
  const byId = new Map<string, Acc>()
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return []
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('"assistant"')) continue
      let o: Obj
      try {
        o = JSON.parse(line)
      } catch {
        continue // a torn last line the CLI is still writing
      }
      if (o?.type !== 'assistant') continue
      const m = o.message
      if (!m || typeof m.id !== 'string' || typeof m.model !== 'string' || m.model === '<synthetic>') continue
      const at = Date.parse(o.timestamp)
      if (!Number.isFinite(at) || at < from || at > to) continue
      const blocks: Obj[] = Array.isArray(m.content) ? m.content : []
      const tools = blocks.flatMap((b) => (b?.type === 'tool_use' && typeof b.id === 'string' ? [b.id as string] : []))
      const wrote = blocks.some((b) => b?.type === 'text' || b?.type === 'thinking' || b?.type === 'redacted_thinking')
      const tokens = usageTokens(m.usage)
      let r = byId.get(m.id)
      if (!r) {
        r = {
          id: m.id,
          model: m.model,
          startedAt: at,
          endedAt: at,
          tokens: tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, fast: false },
          costUsd: null,
          toolIds: [],
          wrote: false,
          best: -1
        }
        byId.set(m.id, r)
      }
      r.startedAt = Math.min(r.startedAt, at)
      r.endedAt = Math.max(r.endedAt, at)
      for (const id of tools) if (!r.toolIds.includes(id)) r.toolIds.push(id)
      r.wrote ||= wrote
      if (tokens && tokens.output >= r.best) {
        r.best = tokens.output
        r.tokens = tokens
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  } finally {
    rl.close()
    stream.destroy()
  }
  return [...byId.values()]
    .map(({ best: _best, ...r }) => ({ ...r, costUsd: priceMessage(r.model, r.tokens) }))
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** Each subagent log with the tool use id that dispatched it, read from its `.meta.json` (`toolUseId`). */
export async function subagentLogs(files: readonly string[]): Promise<SubagentLog[]> {
  return Promise.all(
    files.map(async (file) => {
      let toolUseId: string | null = null
      try {
        const meta = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as Obj
        if (typeof meta?.toolUseId === 'string' && meta.toolUseId) toolUseId = meta.toolUseId
      } catch {
        /* no meta file (older CLIs) or a broken one: matched by its tool calls instead */
      }
      return { file, toolUseId }
    })
  )
}
