import { createReadStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { priceMessage, usageTokens, type MessageTokens } from '@zumibot/shared/pricing'

export interface LogMessage {
  id: string
  at: number
  model: string
  tokens: MessageTokens
  costUsd: number | null
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/** sessionId -> [main log, ...subagent logs]. The escaped project folder name is never rebuilt: any folder may hold the log. */
export async function findSessionFiles(projectsDir: string, sessionIds: ReadonlySet<string>): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  for (const project of await dirNames(projectsDir)) {
    const dir = join(projectsDir, project)
    const names = new Set(await dirNames(dir))
    for (const id of sessionIds) {
      const files: string[] = []
      if (names.has(`${id}.jsonl`)) files.push(join(dir, `${id}.jsonl`))
      if (names.has(id)) {
        const sub = join(dir, id, 'subagents')
        for (const f of (await dirNames(sub)).sort()) if (f.endsWith('.jsonl')) files.push(join(sub, f))
      }
      if (files.length) found.set(id, [...(found.get(id) ?? []), ...files])
    }
  }
  return found
}

function parseLine(line: string): LogMessage | null {
  let o: any
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (o?.type !== 'assistant') return null
  const m = o.message
  const u = m?.usage
  if (!u || typeof m.id !== 'string' || typeof m.model !== 'string' || m.model === '<synthetic>') return null
  const at = Date.parse(o.timestamp)
  if (!Number.isFinite(at)) return null
  const tokens = usageTokens(u)
  if (!tokens) return null
  return { id: m.id, at, model: m.model, tokens, costUsd: priceMessage(m.model, tokens) }
}

/** Streams complete lines from `offset`. A partial last line stays unread (offset stops before it) because the CLI may still be writing it. */
export async function readLogMessages(file: string, offset: number): Promise<{ messages: LogMessage[]; offset: number; size: number }> {
  const byId = new Map<string, LogMessage>()
  let pos = offset
  let rest: Buffer = Buffer.alloc(0)
  try {
    for await (const chunk of createReadStream(file, { start: offset })) {
      rest = rest.length ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer)
      let nl: number
      while ((nl = rest.indexOf(10)) >= 0) {
        const msg = parseLine(rest.subarray(0, nl).toString('utf8'))
        // The CLI logs one line per content block with growing usage: keep the last one that has the most output
        if (msg) {
          const prev = byId.get(msg.id)
          if (!prev || msg.tokens.output >= prev.tokens.output) byId.set(msg.id, msg)
        }
        pos += nl + 1
        rest = rest.subarray(nl + 1)
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return { messages: [...byId.values()], offset: pos, size: pos + rest.length }
}
