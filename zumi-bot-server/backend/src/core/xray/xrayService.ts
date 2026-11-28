import { promises as fs } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { AuditFilter, AuditRecord } from '@zumibot/shared/audit'
import type { DispatchEntry } from '@zumibot/shared/dispatch'
import type { Engine } from '@zumibot/shared/engine'
import { isGroup, type ChatItem, type ChatMeta } from '@zumibot/shared/types'
import { wholeSessionCost, type CostRecord, type UsageRecord } from '@zumibot/shared/usageReport'
import type { TurnXray } from '@zumibot/shared/xray'
import { findSessionFiles } from '../usage/sessionLogs'
import { buildXray } from './turnXray'
import { readRequests, subagentLogs, type LogRequest } from './xrayLogs'

export interface XrayDeps {
  chats: { get(id: string): Promise<ChatMeta | null>; loadItems(id: string): Promise<ChatItem[]> }
  dispatch: { entries(chatId: string): Promise<DispatchEntry[]> }
  audit?: { each(f: AuditFilter): AsyncGenerator<AuditRecord> }
  usage: { all(): readonly UsageRecord[] }
  projectsDir: string
  now(): number
}

const AROUND_MS = 60_000 // logs and audit records are read this far around the turn's items, then trimmed by the builder
const AUDIT_MAX = 20_000 // records read for one turn: a runaway turn must not hold the whole log in memory

const agentOf = (i: ChatItem): string | undefined => ('agent' in i && typeof i.agent === 'string' && i.agent !== '' ? i.agent : undefined)

/**
 * The turn that holds agent message `itemId`: that agent's run of items between other speakers (as Export reads a reply),
 * cut at the `end` marks so a room member's two turns in a row stay apart. `before` is the item just ahead of it.
 */
export function turnItems(
  all: readonly ChatItem[],
  itemId: string,
  fallbackAgent: string
): { items: ChatItem[]; before: ChatItem | null; agent: string; last: boolean } | null {
  // A Run's result sent to the agent is hidden from the user, and must not split the reply.
  const items = all.filter((i) => !(i.type === 'user' && i.run))
  const at = items.findIndex((i) => i.id === itemId)
  if (at < 0 || items[at]!.type !== 'assistant') return null
  const who = agentOf(items[at]!) ?? fallbackAgent
  // A room turn still running is stamped with its id, and its items interleave with other members' until it ends.
  const live = 'turn' in items[at]! ? items[at]!.turn : undefined
  if (live !== undefined) {
    const own = items.filter((i) => 'turn' in i && i.turn === live)
    const first = items.indexOf(own[0]!)
    return { items: own, before: items[first - 1] ?? null, agent: who, last: true }
  }
  const same =(i: ChatItem): boolean => i.type !== 'user' && (agentOf(i) ?? who) === who
  let a = at
  while (a > 0 && same(items[a - 1]!) && items[a - 1]!.end === undefined) a--
  let b = at
  while (items[b]!.end === undefined && b < items.length - 1 && same(items[b + 1]!)) b++
  const later = items.slice(b + 1).some((i) => i.type !== 'user' && (agentOf(i) ?? fallbackAgent) === who)
  return { items: items.slice(a, b + 1), before: items[a - 1] ?? null, agent: who, last: !later }
}

const sessionOf = (meta: ChatMeta, agent: string): string | null =>
  isGroup(meta) ? (meta.group.sessions[agent] ?? null) : meta.sessionId

const engineOf = (meta: ChatMeta, agent: string): Engine =>
  (isGroup(meta) ? meta.group.sessionEngines?.[agent] : meta.sessionEngine) ?? 'claude'

/** Puts a turn's X-ray together from the stores that already hold it; nothing is kept between asks. */
export class XrayService {
  constructor(private readonly d: XrayDeps) {}

  async get(chatId: string, itemId: string): Promise<TurnXray | null> {
    const meta = await this.d.chats.get(chatId)
    if (!meta) return null
    const turn = turnItems(await this.d.chats.loadItems(chatId), itemId, meta.agentName)
    if (!turn) return null
    const { items, before, agent } = turn
    const now = this.d.now()
    const ended = items.find((i) => i.end !== undefined)?.end
    const running = meta.inFlight && ended === undefined && turn.last
    const turnStart = before?.type === 'user' ? before.ts : null
    const first = Math.min(...items.map((i) => i.ts), turnStart ?? Infinity)
    const lastTs = Math.max(
      ...items.map((i) => Math.max(i.ts, 'doneTs' in i && typeof i.doneTs === 'number' ? i.doneTs : 0)),
      running ? now : 0
    )
    const costs = this.d.usage
      .all()
      .filter(
        (r): r is CostRecord =>
          r.kind === 'cost' &&
          r.chatId === chatId &&
          r.agent === agent &&
          r.window !== null &&
          !wholeSessionCost(r) &&
          r.window[1] >= first &&
          r.window[0] <= lastTs
      )
    const from = Math.min(first, ...costs.map((c) => c.window![0])) - AROUND_MS
    const to = Math.max(lastTs, ...costs.map((c) => c.window![1])) + AROUND_MS
    const sessions = new Set<string>()
    if (ended?.session) sessions.add(ended.session)
    for (const c of costs) if (c.sessionId) sessions.add(c.sessionId)
    if (sessions.size === 0) {
      const s = sessionOf(meta, agent)
      if (s) sessions.add(s)
    }
    const engine = engineOf(meta, agent)

    const entries = await this.d.dispatch.entries(chatId)
    const [logs, audit] = await Promise.all([
      engine === 'claude' ? this.readLogs(sessions, from, to, items, entries) : Promise.resolve({ main: null, subagents: [] }),
      this.readAudit(chatId, from, to)
    ])
    return buildXray({
      chatId,
      itemId,
      agent,
      engine,
      items,
      turnStart,
      entries,
      audit,
      costs,
      main: logs.main,
      subagents: logs.subagents,
      running,
      now
    })
  }

  private async readAudit(chatId: string, from: number, to: number): Promise<AuditRecord[] | null> {
    if (!this.d.audit) return null
    const out: AuditRecord[] = []
    try {
      for await (const r of this.d.audit.each({ chatId, from, to })) {
        out.push(r)
        if (out.length >= AUDIT_MAX) break
      }
    } catch (err) {
      // The X-ray still shows the rest; the calls read as having no record.
      console.error('xray audit read failed:', (err as { code?: unknown } | null)?.code ?? 'error')
    }
    return out
  }

  /** The turn's own session log, and the subagent logs of the agents it dispatched (or, without a meta file, any touched since). */
  private async readLogs(
    sessions: ReadonlySet<string>,
    from: number,
    to: number,
    items: readonly ChatItem[],
    entries: readonly DispatchEntry[]
  ): Promise<{ main: LogRequest[] | null; subagents: { toolUseId: string | null; requests: LogRequest[] }[] }> {
    if (sessions.size === 0) return { main: null, subagents: [] }
    let found: Map<string, string[]>
    try {
      found = await findSessionFiles(this.d.projectsDir, sessions)
    } catch {
      return { main: null, subagents: [] }
    }
    const mains: string[] = []
    const subs: string[] = []
    for (const [id, files] of found) for (const f of files) (basename(f) === `${id}.jsonl` && basename(dirname(f)) !== 'subagents' ? mains : subs).push(f)
    if (mains.length === 0) return { main: null, subagents: [] }
    // The turn's dispatches, nested ones included: only their logs are read.
    const roots = new Set(items.flatMap((i) => (i.type === 'tool' ? [i.id] : [])))
    const mine = new Set<string>()
    let grew = true
    while (grew) {
      grew = false
      for (const e of entries)
        if (!mine.has(e.id) && (roots.has(e.id) || (e.parent !== null && mine.has(e.parent)))) {
          mine.add(e.id)
          grew = true
        }
    }
    const tagged = await subagentLogs(subs)
    const wanted = await Promise.all(
      tagged.map(async (s) => {
        if (s.toolUseId !== null) return mine.has(s.toolUseId)
        if (mine.size === 0) return false
        try {
          return (await fs.stat(s.file)).mtimeMs >= from
        } catch {
          return false
        }
      })
    )
    try {
      const main = (await Promise.all(mains.map((f) => readRequests(f, from, to)))).flat().sort((a, b) => a.startedAt - b.startedAt)
      const subagents = await Promise.all(
        tagged.filter((_s, i) => wanted[i]).map(async (s) => ({ toolUseId: s.toolUseId, requests: await readRequests(s.file, from, to) }))
      )
      return { main, subagents }
    } catch (err) {
      console.error('xray log read failed:', (err as { code?: unknown } | null)?.code ?? 'error')
      return { main: null, subagents: [] }
    }
  }
}
