import { randomUUID } from 'node:crypto'
import type { AuditSource } from '../audit/auditService'
import { capRefusal, engineCaps, markEngine, type Engine, type EngineCaps, type Provider } from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import {
  askedByText,
  isOpen,
  SIDE_ASK_FIRST_TEXT,
  SIDE_ASKING_CAP_MS,
  SIDE_LAST_ONLY_TEXT,
  SIDE_LIMIT_TEXT,
  SIDE_MAX_OPEN,
  SIDE_NOT_FOUND_TEXT,
  SIDE_RESTART_TEXT,
  SIDE_TIMEOUT_MS,
  SIDE_TIMEOUT_TEXT,
  SIDE_WAIT_TEXT,
  sideParts,
  sourceGoneText,
  type SideAskLink,
  type SideQuestion
} from '@zumibot/shared/btw'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { KEEP_WARM_AGENT } from '@zumibot/shared/usageReport'
import type { DesktopTurn } from '../desktop/desktopIpc'
import type { ChatService, RunCostEvent, SideBase, SideTurn } from '../chat/chatService'
import type { CostBaseline } from '../usage/costBaseline'
import type { RunHandle, RunOptions } from '../chat/claudeRunner'
import type { CodexRunOptions } from '../codex/codexRunner'
import type { GroupService } from '../chat/groupService'
import { memberStartsBefore, startBefore } from '../chat/sessionPoints'
import { isMissingSession } from '../chat/streamParser'
import type { ChatStore } from '../store/chatStore'
import { fallbackPick, type PickInput } from './sidePicker'
import { KEEP_WARM_MESSAGE } from './keepWarm'
import { SideDeadline } from './sideDeadline'
import {
  askedLead,
  askedSideNote,
  askedThread,
  askingSideNote,
  followMessage,
  NO_ASK_SIDE_NOTE,
  seedWith,
  SIDE_NOTE,
  sideContext,
  sideMessage
} from './sidePrompt'
import { startSideRun, type SideRunOptions } from './sideRun'

export interface SideQuestionsDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'loadItems' | 'loadSide' | 'saveSide'>
  chats: Pick<ChatService, 'sideBase' | 'refreshSideBase' | 'sideBrowser' | 'sideDesktop'>
  groups: Pick<GroupService, 'refuseCodex' | 'sideThread' | 'pickInput'>
  pick(input: PickInput, cwd: string, signal: AbortSignal, chatId: string): Promise<string | null>
  /**
   * Awaited before any base is taken, kept or fresh: a kept base holds the cwd of the last main run, whose worktree folder an
   * archive may have removed since. A throw is the entry's error text, or a skipped ping.
   */
  ensure?(chatId: string): Promise<unknown>
  /** A base built now, on the engine the agent's next main run would use: when no main run kept one, or the agent left its engine. */
  baseFor(chatId: string, agent: string): Promise<SideBase | null>
  /** The agent's engine now. Absent: a kept base is taken as it is, and no engine's cap is checked. */
  engineOf?(agent: string): Promise<Engine>
  /** What each engine can do (default engineCaps): side questions and question cards follow it. */
  caps?(engine: Engine): EngineCaps
  run(o: RunOptions): RunHandle
  /** A Codex agent's side runs (sideRun.ts). */
  codexRun?(o: CodexRunOptions): RunHandle
  broadcast(chatId: string, entry: SideQuestion): void
  recordCost(e: RunCostEvent): void
  costBaseline?: CostBaseline
  now(): number
  /** The audit log: each side run's calls (the guard denies nearly all of them) get records like a main run's. */
  audit?: AuditSource
}

type SidePoint = NonNullable<SideRunOptions['point']>
/** The engine whose sessions a base forks: a point of the other engine is never forked by it. */
const forkEngine = (base: SideBase): Provider | undefined => (base.codex ? 'codex' : undefined)

/** What a thread's root answer was given, so its follow-ups answer from the same moment. */
export interface SideSnapshot {
  point: SidePoint | null // null: seeded. A Codex point keeps its engine, so a follow-up forks it only on Codex
  upTo: string | null // the last item of the chat whose items fed the seed
  context: string // what came before the note: room thread lines, or the A→B lead and lines
}
/** An entry as the server keeps it; the snapshot never leaves the server (it can be 20 000+ characters). */
export type StoredSide = SideQuestion & { snapshot?: SideSnapshot }

export function publicEntry(e: StoredSide): SideQuestion {
  const out: StoredSide = { ...e }
  delete out.snapshot
  return out
}

/** A thread's first entry; a follow-up whose root is gone is its own root. */
function rootOf(entries: readonly StoredSide[], entry: StoredSide): StoredSide {
  return entry.thread === undefined ? entry : (entries.find((q) => q.id === entry.thread) ?? entry)
}

/** A thread in order: its root, then its follow-ups by askedAt (a stable sort, so ties keep file order). */
function threadOf(entries: readonly StoredSide[], root: StoredSide): StoredSide[] {
  return [root, ...entries.filter((q) => q !== root && q.thread === root.id).sort((a, b) => a.askedAt - b.askedAt)]
}

/** The seed chat's items as the root saw them: through `upTo`, or all once that item is gone (hidden by an Edit, say). */
function through(items: ChatItem[], upTo: string | null): ChatItem[] {
  if (upTo === null) return []
  const at = items.findIndex((i) => i.id === upTo)
  return at < 0 ? items : items.slice(0, at + 1)
}

interface Work {
  entry: StoredSide
  abort: AbortController
  deadline?: SideDeadline
  stop?: () => void
  exited?: Promise<void>
  done: Promise<void>
  ended: Promise<void> // the entry has its end state; done also waits for the process to exit
  end(): void
}
/** A new entry's own fields, read from the chat by the caller of `create`; `after` defaults to the chat's last item. */
type Fields = Pick<SideQuestion, 'question' | 'agent' | 'state' | 'mention' | 'from' | 'thread'> & { after?: string | null }
/** Where a side ask was made from: the asking agent's own side entry. */
type AskPlace = { chatId: string; entryId: string }
interface Room {
  entries: StoredSide[]
  loaded?: Promise<void>
  queue: Promise<unknown>
  work: Map<string, Work>
  epoch: number
  revision: number
  saved: number
  changed: Set<string>
  writing?: Promise<void>
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Moves every name an entry holds (who answers, who asked, whom it asked); true when one changed. */
function renameIn(entry: SideQuestion, name: (n: string) => string): boolean {
  let moved = false
  const to = (n: string) => {
    const m = name(n)
    if (m !== n) moved = true
    return m
  }
  if (entry.agent !== null) entry.agent = to(entry.agent)
  if (entry.from !== undefined) entry.from = to(entry.from)
  for (const link of entry.asks ?? []) link.agent = to(link.agent)
  return moved
}

export class SideQuestions {
  private rooms = new Map<string, Room>()
  private renames: [string, string][] = []
  private readonly pings = new Set<ReturnType<typeof startSideRun>>() // keep-warm runs, stopped with the server
  private readonly settling = new Set<Promise<void>>() // preparation calls a stop leaves running, and pings (track)
  private stopping = false

  constructor(private d: SideQuestionsDeps) {}

  private caps(engine: Engine): EngineCaps {
    return (this.d.caps ?? engineCaps)(engine)
  }

  /**
   * The base a side answer starts from: the one the agent's last main run kept, unless the agent has moved to the other engine
   * since (with no turn sent on it yet); then baseFor builds one on the engine its next main run will use. A kept base whose own
   * servers' Vault values went stale since gets those parts read again (refreshSideBase), for side questions and pings alike.
   */
  private async baseOf(
    chatId: string,
    agent: string,
    engine: Engine | null,
    kept = this.d.chats.sideBase(chatId, agent)
  ): Promise<SideBase | null> {
    await this.d.ensure?.(chatId)
    if (kept && (engine === null || markEngine(forkEngine(kept)) === engine)) return this.d.chats.refreshSideBase(agent, kept)
    return this.d.baseFor(chatId, agent)
  }

  private room(chatId: string): Room {
    let room = this.rooms.get(chatId)
    if (!room) {
      room = { entries: [], queue: Promise.resolve(), work: new Map(), epoch: 0, revision: 0, saved: 0, changed: new Set() }
      this.rooms.set(chatId, room)
    }
    return room
  }

  private serial<T>(room: Room, fn: () => Promise<T>): Promise<T> {
    const task = room.queue.then(fn)
    room.queue = task.catch(() => {})
    return task
  }

  private renamed(name: string, since: number): string {
    // Only bridge names read before an overlapping rename; freed handles can be reused.
    for (const [from, to] of this.renames.slice(since)) if (name === from) name = to
    return name
  }

  /** Keeps a call until it settles; stopAll waits on it, so none writes into the data dir after shutdown. */
  private track(p: Promise<unknown>): void {
    const settled = p.then(
      () => {},
      () => {}
    )
    this.settling.add(settled)
    void settled.then(() => this.settling.delete(settled))
  }

  private changed(room: Room, entry: SideQuestion): void {
    room.revision++
    room.changed.add(entry.id)
  }

  // Save immutable snapshots; changes during a write become the next snapshot.
  private flush(chatId: string, room: Room): Promise<void> {
    if (room.writing) return room.writing.then(() => (room.saved === room.revision ? undefined : this.flush(chatId, room)))
    const writing = Promise.resolve()
      .then(async () => {
        while (room.saved !== room.revision) {
          const revision = room.revision
          const entries = structuredClone(room.entries)
          const changed = new Set(room.changed)
          room.changed.clear()
          try {
            await this.d.store.saveSide(chatId, entries)
          } catch (e) {
            for (const id of changed) room.changed.add(id)
            throw e
          }
          room.saved = revision
          for (const entry of entries) if (changed.has(entry.id)) this.d.broadcast(chatId, publicEntry(entry))
        }
      })
      .finally(() => {
        room.writing = undefined
      })
    room.writing = writing
    return writing
  }

  private backgroundFlush(chatId: string, room: Room): void {
    // Failed writes stay dirty for completion, list, or shutdown to retry.
    void this.flush(chatId, room).catch(() => {})
  }

  private async load(chatId: string, room: Room): Promise<void> {
    if (!room.loaded) {
      const renameAt = this.renames.length
      room.loaded = this.d.store
        .loadSide(chatId)
        .then((entries) => {
          room.entries = entries
          for (const entry of entries) {
            if (renameIn(entry, (name) => this.renamed(name, renameAt))) this.changed(room, entry)
            for (const link of entry.asks ?? [])
              if (link.state === 'running') {
                // The asked entry was interrupted by the same restart.
                link.state = 'error'
                this.changed(room, entry)
              }
            if (isOpen(entry)) {
              entry.state = 'error'
              entry.error = SIDE_RESTART_TEXT
              entry.endedAt = this.d.now()
              this.changed(room, entry)
            }
          }
        })
        .catch((e) => {
          room.loaded = undefined
          throw e
        })
    }
    await room.loaded
    await this.flush(chatId, room)
  }

  async list(chatId: string): Promise<SideQuestion[]> {
    const room = this.room(chatId)
    return this.serial(room, async () => {
      await this.load(chatId, room)
      return structuredClone(room.entries)
        .sort((a, b) => a.askedAt - b.askedAt)
        .map(publicEntry)
    })
  }

  async ask(chatId: string, question: string, id: string): Promise<SideQuestion> {
    const parts = sideParts(question)
    if (!parts) throw new Error('A side question cannot be empty')
    const { accepted } = await this.create(chatId, id, (meta) => {
      // An A→B chat has two who can answer: the asked agent, whose chat it is, and the agent that asked.
      const members = meta.group?.members ?? (meta.asked ? [meta.agentName, meta.asked.by] : [meta.agentName])
      const member = parts.mention === null ? null : members.find((m) => m.toLowerCase() === parts.mention!.toLowerCase())
      if (parts.mention !== null && !member) throw new Error(`${displayName(parts.mention)} is not in this chat`)
      // Outside rooms only the asker is marked, so every other single-chat entry stays as it was.
      const named = member && (meta.group || member !== meta.agentName) ? member : null
      return {
        question: parts.question,
        agent: named ?? (meta.group ? null : meta.agentName),
        ...(named ? { mention: true as const } : {}),
        state: meta.group && !named ? 'picking' : 'running'
      }
    })
    return accepted
  }

  /**
   * A follow-up in a side thread: answered by the root's agent from the root's snapshot, with the thread's earlier
   * pairs. The question is used as typed: the thread already has its agent, so a leading @ is just text.
   */
  async follow(chatId: string, threadId: string, question: string, id: string): Promise<SideQuestion> {
    const text = question.trim()
    if (!text) throw new Error('A side question cannot be empty')
    const { accepted } = await this.create(chatId, id, (meta, entries) => {
      const named = entries.find((q) => q.id === threadId)
      if (!named) throw new Error(SIDE_NOT_FOUND_TEXT)
      const root = rootOf(entries, named)
      if (root.from !== undefined) throw new Error(askedByText(root.from))
      // Before the agent check: a root still picking has no agent yet, but waiting is the way on.
      if (threadOf(entries, root).some(isOpen)) throw new Error(SIDE_WAIT_TEXT)
      if (root.agent === null) throw new Error(SIDE_ASK_FIRST_TEXT)
      // A root ended before its run started has no moment to answer from; only a done legacy root reads the chat now.
      if (!root.snapshot && root.state !== 'done') throw new Error(SIDE_ASK_FIRST_TEXT)
      // Same as again(): the thread's agent answers only while it can still answer here (a room's picked member too).
      const mentionable = meta.group?.members ?? (meta.asked ? [meta.asked.by] : [])
      if ((root.mention || meta.group) && !mentionable.includes(root.agent))
        throw new Error(`${displayName(root.agent)} is not in this chat`)
      return {
        question: text,
        agent: root.agent,
        ...(root.mention ? { mention: true as const } : {}),
        state: 'running',
        thread: root.id,
        after: root.after
      }
    })
    return accepted
  }

  /**
   * A side question another agent (`from`) puts to this chat's agent with side_question: a plain side answer marked
   * with who asked. Resolves with the entry once it ends; rejects only where ask would (the open limit, a chat gone).
   */
  async askFrom(chatId: string, o: { question: string; from: string; link: AskPlace | null; signal: AbortSignal }): Promise<SideQuestion> {
    // The asking entry waits on this answer, so its clock stops for the whole call, this entry's preparation included.
    const resume = o.link ? this.pauseClock(o.link.chatId, o.link.entryId) : () => {}
    try {
      const id = randomUUID()
      const { accepted, work } = await this.create(chatId, id, (meta) => {
        const question = o.question.trim()
        if (!question) throw new Error('A side question cannot be empty')
        return { question, agent: meta.agentName, from: o.from, state: 'running' }
      })
      if (o.link) this.setLink(o.link, { agent: accepted.agent!, chatId, entryId: id, state: 'running' })
      const stop = () => this.stop(chatId, id)
      o.signal.addEventListener('abort', stop, { once: true })
      if (o.signal.aborted) stop()
      try {
        await work.ended
      } finally {
        o.signal.removeEventListener('abort', stop)
      }
      const entry = publicEntry(structuredClone(work.entry))
      const state = entry.state === 'done' || entry.state === 'stopped' ? entry.state : 'error'
      if (o.link) this.setLink(o.link, { agent: entry.agent!, chatId, entryId: id, state })
      return entry
    } finally {
      resume()
    }
  }

  /** Stops an open entry's clock while it waits on a side ask; the resume it returns is safe after the entry ended. */
  pauseClock(chatId: string, entryId: string): () => void {
    return this.rooms.get(chatId)?.work.get(entryId)?.deadline?.pause() ?? (() => {})
  }

  /** Records a side ask on the asking entry (the same save and broadcast path as its answer), so its chip is exact. */
  private setLink(at: AskPlace, link: SideAskLink): void {
    const room = this.rooms.get(at.chatId),
      entry = room?.entries.find((q) => q.id === at.entryId)
    if (!room || !entry) return
    const asks = entry.asks ?? []
    const i = asks.findIndex((a) => a.chatId === link.chatId && a.entryId === link.entryId)
    // Only a starting ask adds a link, so one cleared by Ask again stays cleared.
    if (i < 0 && link.state !== 'running') return
    entry.asks = i < 0 ? [...asks, link] : asks.map((a, n) => (n === i ? { ...a, state: link.state } : a))
    this.changed(room, entry)
    this.backgroundFlush(at.chatId, room)
  }

  /** The one way a new entry is made, so the open limit, the load and the first save hold for the user and agents alike. */
  private create(
    chatId: string,
    id: string,
    fields: (meta: ChatMeta, entries: readonly StoredSide[]) => Fields
  ): Promise<{ accepted: SideQuestion; work: Work }> {
    const room = this.room(chatId),
      epoch = room.epoch
    return this.serial(room, async () => {
      const renameAt = this.renames.length
      const meta = await this.meta(chatId)
      // Loaded first: a follow-up's fields come from its thread.
      await this.load(chatId, room)
      const { after, ...own } = fields(meta, room.entries)
      if (room.entries.some((q) => q.id === id)) throw new Error('Side question already exists')
      this.checkLimit(room)
      const anchor = after !== undefined ? after : ((await this.d.store.loadItems(chatId)).at(-1)?.id ?? null)
      if (room.epoch !== epoch) throw new Error('Side question stopped')
      const entry: StoredSide = { id, ...own, askedAt: this.d.now(), after: anchor, answer: '' }
      renameIn(entry, (name) => this.renamed(name, renameAt))
      room.entries.push(entry)
      try {
        return await this.accept(chatId, room, entry, meta)
      } catch (e) {
        room.entries = room.entries.filter((q) => q !== entry)
        this.changed(room, entry)
        throw e
      }
    })
  }

  again(chatId: string, id: string): Promise<SideQuestion> {
    const room = this.room(chatId),
      epoch = room.epoch
    return this.serial(room, async () => {
      await this.load(chatId, room)
      const entry = room.entries.find((q) => q.id === id)
      // The agent that asked asks again, not the user.
      if (entry?.from !== undefined) throw new Error('Only the agent that asked can ask this side question again')
      // A rerun of an earlier entry would change what the later ones were answered from.
      if (entry && threadOf(room.entries, rootOf(room.entries, entry)).at(-1) !== entry) throw new Error(SIDE_LAST_ONLY_TEXT)
      if (!entry || (entry.state !== 'error' && entry.state !== 'stopped') || room.work.has(id))
        throw new Error('Side question cannot be asked again yet')
      this.checkLimit(room)
      const renameAt = this.renames.length
      const meta = await this.meta(chatId)
      if (room.epoch !== epoch) throw new Error('Side question stopped')
      const previous = structuredClone(entry)
      // A named agent, or a room follow-up's kept member, answers again only while it can still answer here: a room
      // member, or the A→B chat's asker.
      const mentionable = meta.group?.members ?? (meta.asked ? [meta.asked.by] : [])
      if ((entry.mention || (meta.group && entry.thread !== undefined)) && !mentionable.includes(entry.agent!))
        throw new Error(`${displayName(entry.agent!)} is not in this chat`)
      // A follow-up keeps its thread's agent; it is never picked again.
      entry.agent = entry.mention || entry.thread !== undefined ? entry.agent : meta.group ? null : this.renamed(meta.agentName, renameAt)
      entry.state = entry.agent === null ? 'picking' : 'running'
      entry.answer = ''
      delete entry.error
      delete entry.endedAt
      // Its side asks and snapshot belong to the old answer; it is the thread's last entry, so no follow-up reads it.
      delete entry.asks
      delete entry.snapshot
      try {
        return (await this.accept(chatId, room, entry, meta)).accepted
      } catch (e) {
        Object.assign(entry, previous)
        this.changed(room, entry)
        throw e
      }
    })
  }

  private checkLimit(room: Room): void {
    if (room.entries.filter(isOpen).length >= SIDE_MAX_OPEN) throw new Error(SIDE_LIMIT_TEXT)
  }

  private async meta(chatId: string): Promise<ChatMeta> {
    const meta = await this.d.store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    return meta
  }

  private async accept(chatId: string, room: Room, entry: SideQuestion, meta: ChatMeta): Promise<{ accepted: SideQuestion; work: Work }> {
    let end!: () => void
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    const work: Work = { entry, abort: new AbortController(), done: Promise.resolve(), ended, end }
    room.work.set(entry.id, work)
    this.changed(room, entry)
    try {
      await this.flush(chatId, room)
    } catch (e) {
      room.work.delete(entry.id)
      throw e
    }
    const accepted = publicEntry(structuredClone(entry))
    work.done = this.answer(chatId, room, work, meta)
    return { accepted, work }
  }

  /** Where the answer forks, or null to seed. Only a point of the base's own engine counts: the other CLI has no such session. */
  private point(base: SideBase, meta: ChatMeta, items: ChatItem[], agent: string): SidePoint | null {
    const engine = forkEngine(base)
    const mark = engine ? { engine } : {}
    if (base.active) {
      if (!base.codex) return base.live ?? base.start
      return base.codex.at === null ? null : { session: base.codex.threadId, at: base.codex.at, engine: 'codex' }
    }
    const next = meta.group ? meta.group.next?.[agent] : meta.next
    if (next) {
      const session = meta.group ? meta.group.sessions[agent] : meta.sessionId
      // An explicit cut is in the chat's session (a room member's own), whose engine the chat records.
      const own = (meta.group ? meta.group.sessionEngines?.[agent] : meta.sessionEngine) === engine
      return session && 'at' in next && own ? { session, at: next.at, ...mark } : null
    }
    const point = meta.group ? memberStartsBefore(items, items.length, [agent])[agent] : startBefore(items, items.length)
    return point.sessionId && point.next && 'at' in point.next && point.engine === engine
      ? { session: point.sessionId, at: point.next.at, ...mark }
      : null
  }

  private async answer(chatId: string, room: Room, work: Work, meta: ChatMeta): Promise<void> {
    const { entry, abort } = work
    // One deadline covers picking and preparation too, not only the CLI run; a stop ends any wait at once. It pauses
    // while this answer waits on a side ask (pauseClock), so the asked agent gets its full time and this one keeps some.
    const late = new AbortController()
    const deadline = (work.deadline = new SideDeadline({
      limitMs: SIDE_TIMEOUT_MS,
      capMs: SIDE_ASKING_CAP_MS,
      now: this.d.now,
      onExpire: () => late.abort()
    }))
    const cut = AbortSignal.any([abort.signal, late.signal])
    const cutoff = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error(SIDE_TIMEOUT_TEXT))
      if (cut.aborted) fail()
      else cut.addEventListener('abort', fail, { once: true })
    })
    cutoff.catch(() => {})
    const within = <T>(p: Promise<T>, drop?: (value: T) => unknown): Promise<T> => {
      // With its drop: a turn that arrives after the cut is disposed before shutdown ends.
      this.track(
        p.then((v) => {
          if (cut.aborted && drop) return drop(v)
        })
      )
      return Promise.race([p, cutoff])
    }
    const check = () => {
      if (cut.aborted) throw new Error(SIDE_TIMEOUT_TEXT)
    }
    let browser: SideTurn | null = null
    let desktop: DesktopTurn | null = null
    // Both turns are owned here: each is disposed even when the other fails.
    const disposeTurns = async () => {
      const turns = [browser, desktop]
      browser = null
      desktop = null
      const failed = (await Promise.allSettled(turns.map((turn) => turn?.dispose()))).find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      )
      if (failed) throw failed.reason
    }
    try {
      if (abort.signal.aborted) return
      if (entry.agent === null) {
        const renameAt = this.renames.length
        const input = await within(this.d.groups.pickInput(chatId, entry.question))
        if (!input.members.length) throw new Error('No members available to answer')
        let picked: string | null = null
        try {
          picked = await within(this.d.pick(input, meta.cwd, cut, chatId))
        } catch {
          /* A failed picker uses the room fallback. */
        }
        check()
        entry.agent = this.renamed(picked && input.members.some((m) => m.name === picked) ? picked : fallbackPick(input), renameAt)
        entry.state = 'running'
        this.changed(room, entry)
        await this.flush(chatId, room)
      }
      // An A→B chat's asker answers from the chat it asked from, where its session, tools and browser are; the entry
      // stays here. Picked by the mention, not the name: a rename reaches the entry before the stored chat.
      const from = meta.asked && entry.mention ? meta.asked.from : chatId
      // A follow-up reads its thread's earlier pairs, and answers from its root's snapshot: the same point, seed and
      // context. A root made before snapshots has none, so its follow-ups read the chat now, as a new question would.
      const order = threadOf(room.entries, rootOf(room.entries, entry))
      const earlier = order.slice(0, order.indexOf(entry))
      const fixed = earlier[0]?.snapshot
      const prepare = async () => {
        // A rename during preparation must rebuild settings and the browser and desktop owners.
        for (;;) {
          check()
          const agent = entry.agent!
          // Before any base or browser, so nothing is set up for a session whose chat is gone.
          if (from !== chatId && !(await within(this.d.store.get(from)))) throw new Error(sourceGoneText(agent))
          // Before anything starts too: while Codex rooms are off a room member now on Codex is refused, and an engine whose side
          // questions are off refuses them with the fixed sentence.
          if (meta.group) await within(this.d.groups.refuseCodex(agent))
          const engine = this.d.engineOf ? await within(this.d.engineOf(agent)) : null
          if (engine !== null && !this.caps(engine).btw) throw new Error(capRefusal(engine, 'btw'))
          const base = await within(this.baseOf(from, agent, engine))
          if (!base) throw new Error('Claude CLI not found')
          const thread = meta.group && !fixed ? await within(this.d.groups.sideThread(chatId, agent)) : null
          // The side ask owner is the session's chat (whose A→B chats it may side-question), but the entry it links and
          // pauses is this one, which for an A→B chat's asker lives here, not in the chat it asked from.
          browser = base.browser
            ? await within(this.d.chats.sideBrowser(from, agent, { chatId, entryId: entry.id }, base.asks), (turn) => turn?.dispose())
            : null
          desktop = base.desktop ? await within(this.d.chats.sideDesktop(from, agent), (turn) => turn?.dispose()) : null
          // Only the user's own question may use side_question, so an asked agent's answer cannot ask on (no chains).
          // The roster is only a hint (the guard lets the tool through either way), so a failed read just leaves it out.
          // Not on Codex: no hook can let that one tool through there, so its run declines it like every call, and says so.
          const asking = !base.codex && base.asks && entry.from === undefined
          const note =
            entry.from !== undefined
              ? askedSideNote(entry.from)
              : asking
                ? askingSideNote(await within(this.askedAgents(from).catch(() => [])))
                : base.codex && base.asks
                  ? NO_ASK_SIDE_NOTE
                  : SIDE_NOTE
          // Read the chat only now: the point, the seed and the thread must come from the same moment, even after a slow pick.
          const current = await within(this.d.store.get(chatId))
          if (!current) {
            this.stop(chatId, entry.id)
            return null
          }
          const source = from === chatId ? current : await within(this.d.store.get(from))
          if (!source) throw new Error(sourceGoneText(agent))
          const fresh = await within(this.d.store.loadItems(from))
          // What the asked agent has done so far, so the asker can say how it is getting on.
          const asked =
            from === chatId || fixed ? null : askedThread(await within(this.d.store.loadItems(chatId)), agent, current.agentName)
          check()
          if (agent === entry.agent)
            return {
              base: { ...base, args: { ...base.args, agentName: agent } },
              thread: asked?.entries ?? thread,
              lead: asked ? askedLead(current.agentName, asked.cut) : undefined,
              meta: source,
              items: fresh,
              asking,
              note
            }
          await disposeTurns()
        }
      }
      let prepared = await prepare()
      if (!prepared) return
      let { base, asking } = prepared
      // A follow-up forks its root's point on the root's engine only: the agent may have moved since, and then it seeds.
      let point = fixed
        ? fixed.point?.engine === forkEngine(base)
          ? fixed.point
          : null
        : this.point(base, prepared.meta, prepared.items, entry.agent!)
      for (let attempt = 0; ; attempt++) {
        check()
        const context = fixed ? fixed.context : sideContext(prepared.thread, prepared.lead)
        if (!earlier.length) {
          // Rewritten by the reseed below, so a follow-up never resumes a session that is gone.
          entry.snapshot = { point, upTo: prepared.items.at(-1)?.id ?? null, context }
          this.changed(room, entry)
          // Saved now, not with the first text: a root stopped before any text still has its follow-ups' moment.
          this.backgroundFlush(chatId, room)
        }
        const text = earlier.length
          ? followMessage(context, prepared.note, earlier, entry.question)
          : sideMessage(entry.question, prepared.thread, prepared.note, prepared.lead)
        const message = point ? text : seedWith(fixed ? through(prepared.items, fixed.upTo) : prepared.items, text)
        const run = startSideRun({
          base,
          point,
          message,
          browser,
          desktop,
          asking,
          run: this.d.run,
          ...(this.d.codexRun ? { codexRun: this.d.codexRun } : {}),
          ...(base.codex && !this.caps('codex').questions ? { questions: false as const } : {}),
          now: this.d.now,
          expired: late.signal,
          costBaseline: this.d.costBaseline,
          ...(this.d.audit
            ? {
                audit: this.d.audit.tap(
                  { chatId, engine: base.codex ? 'codex' : 'claude', runKind: 'side', mode: 'side', turnId: null, noItems: true },
                  { agent: () => entry.agent!, scrub: () => base.scrub ?? new Map<string, string>() }
                )
              }
            : {}),
          onText: (answer) => {
            entry.answer = answer
            this.changed(room, entry)
            this.backgroundFlush(chatId, room)
          },
          onCost: (e) => {
            try {
              this.d.recordCost({ ...e, id: e.id ?? randomUUID(), chatId, agent: entry.agent! })
            } catch {
              /* Usage must not fail an answer. */
            }
          }
        })
        work.stop = run.stop
        work.exited = run.exited
        if (abort.signal.aborted) run.stop()
        const end = await run.done
        if (abort.signal.aborted) return
        // A Codex run says so itself (and either run when the point was the other engine's); Claude's wording is never read off a Codex run.
        if (
          attempt === 0 &&
          point &&
          !end.stopped &&
          !end.ok &&
          (end.missing === true || (!base.codex && isMissingSession(true, null, end.error ?? '')))
        ) {
          point = null
          entry.answer = ''
          await run.exited
          await disposeTurns()
          prepared = await prepare()
          if (!prepared) return
          base = prepared.base
          asking = prepared.asking
          continue
        }
        entry.answer = end.answer
        entry.state = end.stopped ? 'stopped' : end.ok ? 'done' : 'error'
        if (end.error !== null) entry.error = end.error
        entry.endedAt = this.d.now()
        this.changed(room, entry)
        break
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        entry.state = 'error'
        entry.error = errorText(e)
        entry.endedAt = this.d.now()
        this.changed(room, entry)
      }
    } finally {
      deadline.clear()
      work.end()
      // Show the end now: after a stop or timeout the CLI can take seconds to exit.
      this.backgroundFlush(chatId, room)
      // Still busy until the process is gone, so deploy and shutdown never cut a live run off.
      await work.exited
      try {
        await disposeTurns()
      } catch {
        /* Still flush the answer if browser or desktop cleanup fails. */
      }
      try {
        await this.flush(chatId, room)
      } catch {
        // An in-flight stream write may have failed before the final snapshot was tried.
        try {
          await this.flush(chatId, room)
        } catch {
          /* Keep dirty entries for list or shutdown. */
        }
      }
      room.work.delete(entry.id)
    }
  }

  stop(chatId: string, id: string): void {
    const room = this.rooms.get(chatId),
      work = room?.work.get(id)
    if (!room || !work || !isOpen(work.entry)) return
    work.abort.abort()
    work.stop?.()
    work.entry.state = 'stopped'
    work.entry.endedAt = this.d.now()
    this.changed(room, work.entry)
    this.backgroundFlush(chatId, room)
  }

  stopChat(chatId: string): void {
    const room = this.rooms.get(chatId)
    if (!room) return
    room.epoch++
    for (const id of room.work.keys()) this.stop(chatId, id)
  }

  /**
   * A keep-warm ping (keepWarm.ts): a forked, unsaved side run from the agent's clean point, so its request reads the
   * session's cached prefix and resets the cache's hour, leaving the session as it was. It has the same base, tools and
   * browser a side question would, which is what keeps the prefix byte for byte. No entry and no broadcast; its cost is
   * recorded as keep warm. Only an idle chat with a session to resume: a running one reads its own cache, and a seed
   * would warm nothing the next turn reads.
   */
  warm(chatId: string, agent: string): Promise<boolean> {
    // Tracked as a whole: a ping still preparing is in no `pings` yet, and its turns are disposed after its run exits.
    const warming = this.warming(chatId, agent)
    this.track(warming)
    return warming
  }

  private async warming(chatId: string, agent: string): Promise<boolean> {
    if (this.stopping) return false
    const known = this.d.chats.sideBase(chatId, agent)
    if (known?.active) return false
    // A Codex thread has no prompt cache a ping could keep warm (KeepWarm never arms one; this only makes sure), and a Claude
    // session the agent left for Codex is never woken again.
    const engine = this.d.engineOf ? await this.d.engineOf(agent) : null
    if (engine !== null && engine !== 'claude') return false
    const base = await this.baseOf(chatId, agent, engine, known)
    if (base?.codex) return false
    const meta = base && !base.active ? await this.d.store.get(chatId) : null
    if (!base || !meta) return false
    const point = this.point(base, meta, await this.d.store.loadItems(chatId), agent)
    if (!point) return false
    let browser: SideTurn | null = null
    let desktop: DesktopTurn | null = null
    try {
      browser = base.browser ? await this.d.chats.sideBrowser(chatId, agent, { chatId, entryId: 'keep-warm' }, base.asks) : null
      desktop = base.desktop ? await this.d.chats.sideDesktop(chatId, agent) : null
      if (this.stopping) return false
      const run = startSideRun({
        base: { ...base, args: { ...base.args, agentName: agent } },
        point,
        message: KEEP_WARM_MESSAGE,
        browser,
        desktop,
        run: this.d.run,
        now: this.d.now,
        costBaseline: this.d.costBaseline,
        onText: () => {},
        onCost: (e) => {
          try {
            this.d.recordCost({ ...e, id: e.id ?? randomUUID(), chatId, agent: KEEP_WARM_AGENT })
          } catch {
            /* Usage must not fail a ping. */
          }
        }
      })
      this.pings.add(run)
      try {
        const end = await run.done
        await run.exited
        return end.ok
      } finally {
        this.pings.delete(run)
      }
    } finally {
      await Promise.allSettled([browser?.dispose(), desktop?.dispose()])
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    const pings = [...this.pings]
    for (const ping of pings) ping.stop()
    await Promise.all(pings.map((ping) => ping.exited))
    const rooms = [...this.rooms.entries()]
    for (const [id] of rooms) this.stopChat(id)
    await Promise.all(
      rooms.map(async ([id, room]) => {
        await room.queue
        await Promise.all([...room.work.values()].map((work) => work.done))
        // A stop ends an answer at once, but a preparation call it was waiting on runs on (a fresh base makes the chat's
        // claude-tmp folder, a late browser turn is disposed). Read after the answers end, so the set holds all of them.
        await Promise.all([...this.settling])
        await this.flush(id, room)
      })
    )
    // Again with no room at all: a ping still preparing sees `stopping` and ends without starting its run.
    await Promise.all([...this.settling])
  }

  runningCount(): number {
    return [...this.rooms.values()].reduce((sum, room) => sum + room.work.size, 0)
  }

  renameAgent(from: string, to: string): void {
    this.renames.push([from, to])
    for (const [id, room] of this.rooms) {
      for (const entry of room.entries) if (renameIn(entry, (name) => (name === from ? to : name))) this.changed(room, entry)
      this.backgroundFlush(id, room)
    }
  }

  /** The agents this chat asked (its A→B chats), named in the note of a side answer that may side-question them. */
  private async askedAgents(chatId: string): Promise<string[]> {
    const names = (await this.d.store.list()).filter((c) => c.asked?.from === chatId).map((c) => c.agentName)
    return [...new Set(names)].sort()
  }
}
