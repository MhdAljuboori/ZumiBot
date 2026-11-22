import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { displayName } from '@zumibot/shared/frontmatter'
import type { ChatItem } from '@zumibot/shared/types'
import {
  KEEP_WARM_AGENT,
  MODERATOR_AGENT,
  SUMMARY_AGENT,
  WORKFLOW_AGENT,
  wholeSessionCost,
  workflowIdOf,
  workflowUsageKey,
  type CostRecord,
  type UsageQuery,
  type UsageRecord,
  type UsageSummary
} from '@zumibot/shared/usageReport'
import type { RunCostEvent } from '../chat/chatService'
import type { ChatStore } from '../store/chatStore'
import type { EstimateCache } from './estimateCache'
import { estimate, type EstimateBucket, type SessionOwner } from './estimates'
import type { RunCost } from './runCost'
import { findSessionFiles, readLogMessages, type LogMessage } from './sessionLogs'
import { summarize } from './summarize'
import type { UsageStore } from './usageStore'

export interface UsageServiceDeps {
  store: UsageStore
  cache: EstimateCache
  chats: ChatStore
  projectsDir: string
  changed(chatId: string | null): void // broadcast usage:changed
  agentLabel(agent: string): string
  workflowNames?(): Promise<ReadonlyMap<string, string>> // id -> name of the workflows that exist, for the Chat tab's labels
}

/** The label shown for an agent: its display name, the reserved names as "Room moderator", "Room handoff" and "Workflow step". */
export const usageAgentLabel = (agent: string): string =>
  agent === MODERATOR_AGENT
    ? 'Room moderator'
    : agent === SUMMARY_AGENT
      ? 'Room handoff'
      : agent === KEEP_WARM_AGENT
        ? 'Keep warm'
        : agent === WORKFLOW_AGENT
          ? 'Workflow step'
          : displayName(agent)

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export class UsageService {
  private owners = new Map<string, SessionOwner>() // by session + chat: a forked chat names its parent's sessions too
  private files = new Map<string, string[]>() // session id -> its log files
  private estimates: EstimateBucket[] = []
  private estimating = true
  private msgIds = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve() // record writes and recomputes, in order
  private reads: Promise<unknown> = Promise.resolve() // log reads, one at a time
  private background: Promise<void> = Promise.resolve()
  private loaded = false // before the records load, msgIds is empty and a save would re-add everything
  private stopped = false

  constructor(private readonly d: UsageServiceDeps) {}

  async start(): Promise<void> {
    await this.d.store.load()
    await this.d.cache.load()
    this.msgIds = new Set(
      this.d.store
        .all()
        .filter((r) => r.kind === 'msg')
        .map((r) => r.id)
    )
    this.estimating = true
    this.loaded = true
    // Not awaited: importing and estimating must never hold up startup or a reply.
    this.background = this.backfill().catch((err) => {
      console.error('usage estimate failed:', err instanceof Error ? err.message : err)
      this.estimating = false
      this.d.changed(null)
    })
  }

  /** Resolves when the background import/estimate and queued writes are done (tests, shutdown). */
  async idle(): Promise<void> {
    await this.background
    await this.tail
    await this.reads
  }

  /**
   * Shutdown, before the data lock is released: estimating stops at its next step without saving (the cache is
   * derived, and the next start rebuilds it), while exact records already queued are still written.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.idle()
  }

  private async backfill(): Promise<void> {
    // Oldest chat first: a fork repeats its parent's user messages, and the parent should keep them.
    const metas = [...(await this.d.chats.list())].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    for (const m of metas) {
      if (this.stopped) return
      try {
        this.noteItems(m.id, await this.d.chats.loadItems(m.id))
        this.noteItems(m.id, await this.versionItems(m.id))
      } catch (err) {
        console.error('usage import of a chat failed:', err instanceof Error ? err.message : err)
      }
      await yieldLoop()
    }
    await this.collectOwners()
    const found = await findSessionFiles(this.d.projectsDir, new Set([...this.owners.values()].map((o) => o.sessionId)))
    for (const [id, paths] of found) this.files.set(id, paths) // merge: a session refreshed meanwhile stays
    for (const paths of found.values()) {
      for (const p of paths) {
        if (this.stopped) return
        await this.safeRead(p)
        await yieldLoop()
      }
    }
    if (this.stopped) return
    this.recompute()
    await this.d.cache.save()
    this.estimating = false
    this.d.changed(null)
  }

  /** One unreadable log must not stop the others. */
  private async safeRead(path: string): Promise<void> {
    try {
      await this.readFile(path)
    } catch (err) {
      console.error('usage log read failed:', err instanceof Error ? err.message : err)
    }
  }

  private async versionItems(chatId: string): Promise<ChatItem[]> {
    const out: ChatItem[] = []
    for (const set of Object.values(await this.d.chats.loadVersions(chatId))) {
      for (const v of set.list) if (v) out.push(v.user, ...v.tail)
    }
    return out
  }

  private addOwner(o: SessionOwner): void {
    const key = `${o.sessionId}\n${o.chatId}`
    if (this.owners.has(key)) return
    this.owners.set(key, o)
    // Persisted, so the session stays owned when its chat is deleted (items are hard-deleted with it).
    void this.d.store
      .add([
        { kind: 'owner', id: `o:${o.sessionId}:${o.chatId}`, chatId: o.chatId, sessionId: o.sessionId, agent: o.agent, at: o.chatCreatedAt }
      ])
      .catch((err) => console.error('saving usage owner failed:', err instanceof Error ? err.message : err))
  }

  private async collectOwners(): Promise<void> {
    const metas = await this.d.chats.list()
    const live = new Set(metas.map((m) => m.id))
    // Remembered owners first: they keep a deleted chat's sessions with their original agent and age
    for (const r of this.d.store.all()) {
      if (r.kind === 'owner') this.addOwner({ sessionId: r.sessionId, chatId: r.chatId, agent: r.agent, chatCreatedAt: r.at })
    }
    for (const m of metas) {
      try {
        const named = (items: readonly ChatItem[], fallback: string): void => {
          for (const it of items) {
            if (it.end)
              this.addOwner({
                sessionId: it.end.session,
                chatId: m.id,
                agent: m.group ? (it.end.agent ?? fallback) : m.agentName,
                chatCreatedAt: m.createdAt
              })
            if (it.type === 'assistant' && it.cut)
              this.addOwner({
                sessionId: it.cut.session,
                chatId: m.id,
                agent: m.group ? (it.agent ?? fallback) : m.agentName,
                chatCreatedAt: m.createdAt
              })
          }
        }
        if (m.group) {
          for (const [member, s] of Object.entries(m.group.sessions))
            if (s) this.addOwner({ sessionId: s, chatId: m.id, agent: member, chatCreatedAt: m.createdAt })
        } else if (m.sessionId) {
          this.addOwner({ sessionId: m.sessionId, chatId: m.id, agent: m.agentName, chatCreatedAt: m.createdAt })
        }
        named(await this.d.chats.loadItems(m.id), m.agentName)
        named(await this.versionItems(m.id), m.agentName)
      } catch (err) {
        console.error('usage owners of a chat failed:', err instanceof Error ? err.message : err)
      }
    }
    // A deleted chat's exact runs still name their sessions
    for (const r of this.d.store.all()) {
      if (r.kind === 'cost' && r.sessionId && !live.has(r.chatId))
        this.addOwner({ sessionId: r.sessionId, chatId: r.chatId, agent: r.agent, chatCreatedAt: r.at })
    }
  }

  /** Reads one log from its cached offset; a shrunk file is read again from 0, a missing one is skipped. */
  private async readFile(path: string): Promise<void> {
    let size: number
    try {
      size = (await fs.stat(path)).size
    } catch {
      return
    }
    const cached = this.d.cache.get(path)
    if (cached && size < cached.offset) this.d.cache.reset(path)
    const from = this.d.cache.get(path)?.offset ?? 0
    this.d.cache.merge(path, await readLogMessages(path, from))
  }

  private logsBySession(): Map<string, LogMessage[]> {
    const out = new Map<string, LogMessage[]>()
    for (const [id, paths] of this.files) {
      const all: LogMessage[] = []
      for (const p of paths) all.push(...(this.d.cache.get(p)?.messages ?? []))
      out.set(id, all)
    }
    return out
  }

  private recompute(): void {
    const exact = this.d.store.all().filter((r): r is CostRecord => r.kind === 'cost' && !wholeSessionCost(r))
    this.estimates = estimate([...this.owners.values()], this.logsBySession(), exact)
  }

  private enqueue(op: () => Promise<void>): void {
    this.tail = this.tail.then(op).catch((err) => console.error('usage update failed:', err instanceof Error ? err.message : err))
  }

  private addCost(rec: CostRecord): void {
    this.enqueue(async () => {
      await this.d.store.add([rec])
      if (rec.sessionId) {
        const meta = await this.d.chats.get(rec.chatId)
        this.addOwner({ sessionId: rec.sessionId, chatId: rec.chatId, agent: rec.agent, chatCreatedAt: meta?.createdAt ?? rec.at })
      }
      if (rec.sessionId && this.files.has(rec.sessionId)) this.recompute() // else no known log can change
      this.d.changed(rec.chatId)
    })
  }

  recordRun(e: RunCostEvent): void {
    this.addCost({
      kind: 'cost',
      id: e.id,
      chatId: e.chatId,
      agent: e.agent,
      at: e.window[1],
      sessionId: e.sessionId,
      window: e.window,
      models: e.cost.models,
      v: 2
    })
  }

  recordModerator(chatId: string, cost: RunCost, id: string | null, at: number): void {
    this.addCost({
      kind: 'cost',
      id: id ?? randomUUID(),
      chatId,
      agent: MODERATOR_AGENT,
      at,
      sessionId: null,
      window: null,
      models: cost.models
    })
  }

  recordSummary(chatId: string, cost: RunCost, id: string | null, at: number): void {
    this.addCost({
      kind: 'cost',
      id: id ?? randomUUID(),
      chatId,
      agent: SUMMARY_AGENT,
      at,
      sessionId: null,
      window: null,
      models: cost.models
    })
  }

  /** A workflow's LLM or Condition call: no chat, no session; keyed by the workflow, like the room handoff by its room. */
  recordWorkflow(workflowId: string, cost: RunCost, id: string | null, at: number): void {
    this.addCost({
      kind: 'cost',
      id: id ?? randomUUID(),
      chatId: workflowUsageKey(workflowId),
      agent: WORKFLOW_AGENT,
      at,
      sessionId: null,
      window: null,
      models: cost.models
    })
  }

  noteItems(chatId: string, items: readonly ChatItem[]): void {
    if (!this.loaded) return
    const fresh: UsageRecord[] = []
    for (const it of items) {
      if (it.type !== 'user' || this.msgIds.has(it.id)) continue
      this.msgIds.add(it.id)
      fresh.push({ kind: 'msg', id: it.id, chatId, at: it.ts })
    }
    if (!fresh.length) return
    this.enqueue(async () => {
      try {
        await this.d.store.add(fresh)
      } catch (err) {
        for (const r of fresh) this.msgIds.delete(r.id) // a failed append can be retried by the next save
        throw err
      }
    })
  }

  /** A turn ended without a cost: its log is the only record, so read it and estimate. A session with no log is a silent miss. */
  refreshSession(chatId: string, agent: string, sessionId: string | null): void {
    if (!sessionId) return
    this.reads = this.reads
      .then(async () => {
        if (this.stopped) return
        // The hook fires before the chat's session id is saved, so the owner comes from the event, not from the meta.
        if (![...this.owners.values()].some((o) => o.sessionId === sessionId && o.chatId === chatId)) {
          const meta = await this.d.chats.get(chatId)
          this.addOwner({ sessionId, chatId, agent, chatCreatedAt: meta?.createdAt ?? Date.now() })
        }
        // Every owned session, not just this one: exact turns never read their logs, so a session the copied history
        // came from may have grown since, and its lines must be seen to count (or be covered) only once.
        const ids = new Set([...this.owners.values()].map((o) => o.sessionId))
        const found = await findSessionFiles(this.d.projectsDir, ids)
        if (!found.get(sessionId)?.length) return
        for (const [id, paths] of found) {
          this.files.set(id, paths)
          for (const p of paths) await this.safeRead(p)
        }
        if (this.stopped) return
        this.recompute()
        await this.d.cache.save()
        this.d.changed(chatId)
      })
      .catch((err) => console.error('usage refresh failed:', err instanceof Error ? err.message : err))
  }

  /**
   * What an agent has cost since `from` (ms), for its daily spend cap: its exact v2 run records (by when each run ended) and
   * the log estimates of its turns no record covers (by the hour they started). Synchronous, from memory. Unpriced counts 0.
   */
  agentSpend(agent: string, from: number, skipChats: ReadonlySet<string> = new Set()): number {
    let usd = 0
    for (const r of this.d.store.all()) {
      if (r.kind !== 'cost' || r.agent !== agent || r.at < from || wholeSessionCost(r)) continue
      for (const m of Object.values(r.models)) usd += m.costUsd ?? 0
    }
    // skipChats: chats whose running turns the caller counts itself, whose log lines would be estimated too until they end.
    for (const b of this.estimates) if (b.agent === agent && b.hour >= from && !skipChats.has(b.chatId)) usd += b.spend.costUsd ?? 0
    return usd
  }

  /** Resolves once the records queued so far are written (a turn's exact cost, before the spend caps judge it again). */
  flushed(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  async renameAgent(from: string, to: string): Promise<void> {
    await this.tail
    await this.d.store.renameAgent(from, to)
    for (const [k, o] of this.owners) if (o.agent === from) this.owners.set(k, { ...o, agent: to })
    this.recompute()
    this.d.changed(null)
  }

  async query(q: UsageQuery): Promise<UsageSummary> {
    const chats = new Map((await this.d.chats.list()).map((m) => [m.id, { title: m.title }]))
    const records = this.d.store.all().filter((r) => r.kind !== 'cost' || !wholeSessionCost(r))
    // Only a label: a failed read must not fail the page, so rows fall back to "Workflow (deleted)"; code only, never the message or path.
    let workflowNames: ReadonlyMap<string, string> | undefined
    if (this.d.workflowNames && records.some((r) => r.kind === 'cost' && workflowIdOf(r.chatId) !== null)) {
      try {
        workflowNames = await this.d.workflowNames()
      } catch (err) {
        console.error('usage workflow names failed:', (err as NodeJS.ErrnoException).code ?? 'error')
      }
    }
    return summarize(
      { records, estimates: this.estimates, chats, workflowNames, estimating: this.estimating, agentLabel: this.d.agentLabel },
      q
    )
  }
}
