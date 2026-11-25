import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { NOTICE_TEXT, type ChatItem, type ChatWorktree, type ChatMeta, type GroupInfo, type QueuedTask } from '@zumibot/shared/types'
import { capPausedText } from '@zumibot/shared/spendCaps'
import { holdsVisibleTask } from '@zumibot/shared/runBlocks'
import { archivePatch } from '@zumibot/shared/archive'
import { writeFileAtomic } from '../fsutil'
import type { SideQuestion } from '@zumibot/shared/btw'
import { mapHidden, type Versions } from '../chat/versions'
import { renamePaused } from '../chat/groupQueue'
import { emptyTodos, parseTodoFile, seenKey, splitSeenKey, type TodoFile, type TodoItem, type TodoTaskLink } from '@zumibot/shared/todos'
import { emptyDispatch, type DispatchFile } from '@zumibot/shared/dispatch'
import { parseAguiThread, type AguiThread } from '@zumibot/shared/agui'

const ID_RE = /^[A-Za-z0-9-]+$/

/**
 * Brings a stored group record to the current shape. A legacy record has `activeAgent` and a string queue: it maps
 * to no active turn (a mid-run record is recovered anyway) and a queue where each entry waits for the one before.
 */
export function migrateGroup(raw: unknown): GroupInfo {
  const g = raw as Record<string, unknown>
  const role = typeof g.role === 'string' ? g.role : ''
  const queue = Array.isArray(g.queue) ? (g.queue as unknown[]) : []
  if (!Array.isArray(g.active)) {
    const names = queue.filter((e): e is string => typeof e === 'string')
    return {
      members: g.members as string[],
      sessions: g.sessions as GroupInfo['sessions'],
      seen: g.seen as GroupInfo['seen'],
      role,
      active: [],
      queue: names.map((agent, i) => ({ agent, after: i === 0 ? [] : [names[i - 1]] }))
    }
  }
  return { ...(g as unknown as GroupInfo), role }
}

/** Moves an agent's name in the to-do names and `seen` key; rev and updatedAt stay, since no one changed an item. */
function renameTodos(f: TodoFile, rn: (n: string) => string): TodoFile {
  const by = <T extends { by: string }>(o: T | null): T | null => (o ? { ...o, by: rn(o.by) } : o)
  const items = f.items.map<TodoItem>((i) => ({
    ...i,
    addedBy: rn(i.addedBy),
    done: by(i.done),
    removed: by(i.removed),
    last: { ...i.last, by: rn(i.last.by) },
    ...(i.assignee ? { assignee: rn(i.assignee) } : {}),
    ...(i.task ? { task: { ...i.task, agent: rn(i.task.agent) } } : {}),
    ...(i.questions ? { questions: i.questions.map((q) => ({ ...q, by: rn(q.by) })) } : {}),
    ...(i.comments ? { comments: i.comments.map((c) => ({ ...c, by: rn(c.by), ...(c.asked ? { asked: c.asked.map(rn) } : {}) })) } : {})
  }))
  // Keys are `<chat>/<agent>`; a key from before the board (a bare name) is moved as a name.
  const rekey = (k: string): string => {
    const parts = splitSeenKey(k)
    return parts ? seenKey(parts.chatId, rn(parts.agent)) : rn(k)
  }
  return { ...f, items, seen: Object.fromEntries(Object.entries(f.seen).map(([k, v]) => [rekey(k), v])) }
}

export class ChatStore {
  private readonly indexFile: string
  private readonly chatsDir: string
  private readonly boardFile: string
  private index: ChatMeta[] | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private itemsListener: ((chatId: string, items: readonly ChatItem[]) => void) | null = null
  private boardListener: ((file: TodoFile) => void) | null = null
  private removedListener: ((chatId: string) => void) | null = null

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID
  ) {
    this.indexFile = join(dataDir, 'chats.json')
    this.chatsDir = join(dataDir, 'chats')
    this.boardFile = join(dataDir, 'todos.json')
  }

  /** Told after every saved item list (not for a removed chat); a throwing listener never fails the save. */
  setItemsListener(fn: ((chatId: string, items: readonly ChatItem[]) => void) | null): void {
    this.itemsListener = fn
  }

  /** Told after every write of the task board; a throwing listener never fails the write. */
  setBoardListener(fn: ((file: TodoFile) => void) | null): void {
    this.boardListener = fn
  }

  /** Told after a chat is removed, by whatever path (a delete, a failed fork or clone); a throwing listener never fails it. */
  setRemovedListener(fn: ((chatId: string) => void) | null): void {
    this.removedListener = fn
  }

  private tellBoard(file: TodoFile): void {
    try {
      this.boardListener?.(file)
    } catch (err) {
      console.error('board listener failed', err)
    }
  }

  /** Runs ops one at a time so index reads and writes never interleave. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private logPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.json`)
  }

  private versionsPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.versions.json`)
  }

  private sidePath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.btw.json`)
  }

  // A chat's own to-do list from before the board: read once by the migration, then removed.
  private legacyTodosPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.todos.json`)
  }

  private dispatchPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.dispatch.json`)
  }

  private aguiPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.chatsDir, `${id}.agui.json`)
  }

  private async load(): Promise<ChatMeta[]> {
    if (this.index) return this.index
    let raw: string
    try {
      raw = await fs.readFile(this.indexFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return (this.index = [])
    }
    try {
      const parsed = JSON.parse(raw) as { chats?: unknown }
      if (!parsed || !Array.isArray(parsed.chats)) throw new Error('bad index')
      return (this.index = (parsed.chats as ChatMeta[]).map((c) => (c.group ? { ...c, group: migrateGroup(c.group) } : c)))
    } catch {
      await fs.rename(this.indexFile, `${this.indexFile}.bak-${this.now()}`)
      return (this.index = [])
    }
  }

  private async persist(chats: ChatMeta[]): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.indexFile, JSON.stringify({ chats }, null, 2))
    this.index = chats
  }

  list(): Promise<ChatMeta[]> {
    return this.run(async () => [...(await this.load())].sort((a, b) => b.updatedAt - a.updatedAt))
  }

  get(id: string): Promise<ChatMeta | null> {
    return this.run(async () => (await this.load()).find((c) => c.id === id) ?? null)
  }

  create(
    agentName: string,
    cwd: string,
    extra?: { title?: string; voice?: true; worktree?: ChatWorktree; task?: TodoTaskLink; cardComments?: TodoTaskLink }
  ): Promise<ChatMeta> {
    return this.run(async () => {
      const chats = await this.load()
      const t = this.now()
      const meta: ChatMeta = {
        id: this.newId(),
        agentName,
        sessionId: null,
        cwd,
        title: extra?.title ?? '',
        createdAt: t,
        updatedAt: t,
        inFlight: false,
        ...(extra?.voice ? { voice: true as const } : {}),
        ...(extra?.worktree ? { worktree: extra.worktree } : {}),
        ...(extra?.task ? { task: extra.task } : {}),
        ...(extra?.cardComments ? { cardComments: extra.cardComments } : {})
      }
      this.logPath(meta.id)
      await this.persist([...chats, meta])
      return meta
    })
  }

  createGroup(members: string[], cwd: string, role = '', extra?: { worktree?: ChatWorktree }): Promise<ChatMeta> {
    return this.run(async () => {
      const chats = await this.load()
      const t = this.now()
      const meta: ChatMeta = {
        id: this.newId(),
        agentName: '',
        sessionId: null,
        cwd,
        title: '',
        createdAt: t,
        updatedAt: t,
        inFlight: false,
        group: { members: [...members], sessions: {}, seen: {}, role, active: [], queue: [] },
        ...(extra?.worktree ? { worktree: extra.worktree } : {})
      }
      this.logPath(meta.id)
      await this.persist([...chats, meta])
      return meta
    })
  }

  updateGroup(id: string, fn: (g: GroupInfo) => GroupInfo): Promise<ChatMeta> {
    return this.run(async () => {
      const cur = (await this.load()).find((c) => c.id === id)
      if (!cur?.group) throw new Error(`Not a group chat: ${id}`)
      return this.updateLocked(id, { group: fn(cur.group) })
    })
  }

  private async updateLocked(id: string, patch: Partial<Omit<ChatMeta, 'id'>>): Promise<ChatMeta> {
    const chats = await this.load()
    const cur = chats.find((c) => c.id === id)
    if (!cur) throw new Error(`Chat not found: ${id}`)
    // Any turn starting (a send, a routine, a room's member, a compact) brings an archived chat back, so its approval
    // cards and reply are never hidden in the archive. Here, so no turn path can miss it.
    const back = patch.inFlight === true ? archivePatch(cur, false, this.now()) : {}
    const next: ChatMeta = { ...cur, ...patch, ...back, id, updatedAt: patch.updatedAt ?? this.now() }
    await this.persist(chats.map((c) => (c.id === id ? next : c)))
    return next
  }

  update(id: string, patch: Partial<Omit<ChatMeta, 'id'>>): Promise<ChatMeta> {
    return this.run(() => this.updateLocked(id, patch))
  }

  /** Adds the emoji to the message's reactions, or takes it off when it is there; the chat keeps its place in the list. */
  toggleReaction(id: string, itemId: string, emoji: string): Promise<ChatMeta> {
    return this.run(async () => {
      const cur = (await this.load()).find((c) => c.id === id)
      if (!cur) throw new Error(`Chat not found: ${id}`)
      const { [itemId]: had = [], ...rest } = cur.reactions ?? {}
      const next = had.includes(emoji) ? had.filter((e) => e !== emoji) : [...had, emoji]
      const reactions = next.length > 0 ? { ...rest, [itemId]: next } : rest
      return this.updateLocked(id, { reactions: Object.keys(reactions).length > 0 ? reactions : undefined, updatedAt: cur.updatedAt })
    })
  }

  /** Reads and writes in one queued step so a concurrent update is never rolled back; keeps updatedAt. Null, with no write, when the chat is gone or `fn` returns null. */
  patchInPlace(id: string, fn: (cur: ChatMeta) => Partial<Omit<ChatMeta, 'id' | 'updatedAt'>> | null): Promise<ChatMeta | null> {
    return this.run(async () => {
      const cur = (await this.load()).find((c) => c.id === id)
      if (!cur) return null
      const patch = fn(cur)
      if (!patch) return null
      return this.updateLocked(id, { ...patch, updatedAt: cur.updatedAt })
    })
  }

  /** Queues a task at the end; the chat keeps its place in the list. `hold`: the tray is held too, in the same write (never for a Run result). */
  addTask(id: string, task: QueuedTask, hold = false): Promise<ChatMeta> {
    return this.run(async () => {
      const cur = await this.mustGet(id)
      const held = hold && task.run === undefined
      return this.updateLocked(id, { tasks: [...(cur.tasks ?? []), task], ...(held ? { held: true } : {}), updatedAt: cur.updatedAt })
    })
  }

  /** Removes and returns the oldest task, or null when there is none. */
  takeTask(id: string): Promise<{ task: QueuedTask | null; meta: ChatMeta }> {
    return this.run(async () => {
      const cur = await this.mustGet(id)
      const [task = null, ...rest] = cur.tasks ?? []
      if (!task) return { task, meta: cur }
      return { task, meta: await this.updateLocked(id, this.tasksPatch(rest, cur)) }
    })
  }

  /** Marks the queued tasks as held (they wait for the user); no-op without a task the user can see (holdsVisibleTask). */
  holdTasks(id: string): Promise<ChatMeta> {
    return this.run(async () => {
      const cur = await this.mustGet(id)
      if (!holdsVisibleTask(cur.tasks) || cur.held) return cur
      return this.updateLocked(id, { held: true, updatedAt: cur.updatedAt })
    })
  }

  /** The tasks left after a take or drop; the last one the user can see out also clears `held` (Run results alone are never held). */
  private tasksPatch(rest: QueuedTask[], cur: ChatMeta): Partial<Omit<ChatMeta, 'id'>> {
    if (rest.length === 0) return { tasks: undefined, held: undefined, updatedAt: cur.updatedAt }
    return holdsVisibleTask(rest) ? { tasks: rest, updatedAt: cur.updatedAt } : { tasks: rest, held: undefined, updatedAt: cur.updatedAt }
  }

  /** Removes the task with this id; null (and no write) when it is not queued. */
  dropTask(id: string, taskId: string): Promise<{ task: QueuedTask | null; meta: ChatMeta }> {
    return this.run(async () => {
      const cur = await this.mustGet(id)
      const task = cur.tasks?.find((t) => t.id === taskId) ?? null
      if (!task) return { task, meta: cur }
      const rest = (cur.tasks ?? []).filter((t) => t.id !== taskId)
      return { task, meta: await this.updateLocked(id, this.tasksPatch(rest, cur)) }
    })
  }

  private async mustGet(id: string): Promise<ChatMeta> {
    const cur = (await this.load()).find((c) => c.id === id)
    if (!cur) throw new Error(`Chat not found: ${id}`)
    return cur
  }

  remove(id: string): Promise<void> {
    return this.run(async () => {
      const path = this.logPath(id)
      const versionsPath = this.versionsPath(id)
      const sidePath = this.sidePath(id)
      const todosPath = this.legacyTodosPath(id)
      const dispatchPath = this.dispatchPath(id)
      const aguiPath = this.aguiPath(id)
      const chats = await this.load()
      await this.persist(chats.filter((c) => c.id !== id))
      await fs.rm(path, { force: true })
      await fs.rm(versionsPath, { force: true })
      await fs.rm(sidePath, { force: true })
      await fs.rm(todosPath, { force: true })
      await fs.rm(dispatchPath, { force: true })
      await fs.rm(aguiPath, { force: true })
      // Its tasks stay on the board (made there, they outlive it); only what its sessions had seen goes.
      const board = await this.readTodos(this.boardFile)
      const prefix = `${id}/`
      if (Object.keys(board.seen).some((k) => k.startsWith(prefix))) {
        await this.writeBoard({ ...board, seen: Object.fromEntries(Object.entries(board.seen).filter(([k]) => !k.startsWith(prefix))) })
      }
      try {
        this.removedListener?.(id)
      } catch (err) {
        console.error('removed listener failed', err)
      }
    })
  }

  renameAgent(oldName: string, newName: string): Promise<void> {
    return this.run(async () => {
      const chats = await this.load()
      const rn = (n: string): string => (n === oldName ? newName : n)
      const rekey = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).map(([k, v]) => [rn(k), v]))
      let changed = false
      // A queued command names its agent, which may no longer be a member, so tasks move for every chat.
      const renameTasks = (c: ChatMeta): ChatMeta => {
        if (!c.tasks?.some((t) => t.command?.agent === oldName)) return c
        changed = true
        return { ...c, tasks: c.tasks.map((t) => (t.command?.agent === oldName ? { ...t, command: { ...t.command, agent: newName } } : t)) }
      }
      const next = chats.map((chat) => {
        const c = renameTasks(chat)
        if (c.group) {
          if (!c.group.members.includes(oldName)) return c
          changed = true
          const g = c.group
          return {
            ...c,
            group: {
              ...g,
              ...(g.next ? { next: rekey(g.next) } : {}),
              ...(g.context ? { context: rekey(g.context) } : {}),
              ...(g.lost ? { lost: rekey(g.lost) } : {}),
              // Beside sessions: a renamed member's thread must keep its engine mark.
              ...(g.sessionEngines ? { sessionEngines: rekey(g.sessionEngines) } : {}),
              // A paused room's Resume addresses these members and restores this queue and its reasons, by name.
              ...(g.paused ? { paused: renamePaused(g.paused, rn) } : {}),
              members: g.members.map(rn),
              sessions: rekey(g.sessions),
              seen: rekey(g.seen),
              active: g.active.map((t) => ({ ...t, agent: rn(t.agent) })),
              queue: g.queue.map((e) => ({ agent: rn(e.agent), after: e.after.map(rn) }))
            }
          }
        }
        // The asking agent, whether its own chat or the chat it asked B in, is named in `asked`.
        const a = c.asked
        const asker =
          a && (a.by === oldName || a.chain.includes(oldName)) ? { ...c, asked: { ...a, by: rn(a.by), chain: a.chain.map(rn) } } : c
        if (asker !== c) changed = true
        if (asker.agentName !== oldName) return asker
        changed = true
        return { ...asker, agentName: newName }
      })
      if (changed) await this.persist(next)
      // `end.agent` stamps the turn's author, on any item type; `agent` only on items that have one.
      const renameItem = (it: ChatItem): ChatItem => {
        let out = it
        if ('agent' in out && out.agent === oldName) {
          out =
            out.type === 'browser-action'
              ? { ...out, agent: newName, handoff: { ...out.handoff, agent: newName } }
              : { ...out, agent: newName }
        }
        if (out.end?.agent === oldName) out = { ...out, end: { ...out.end, agent: newName } }
        // A sent command keeps naming its agent, so a later resend or reseed still finds it.
        if (out.type === 'user' && out.command?.agent === oldName) out = { ...out, command: { ...out.command, agent: newName } }
        // The asking agent's name on a question it put to this chat.
        if (out.type === 'user' && out.from === oldName) out = { ...out, from: newName }
        return out
      }
      for (const { id } of chats) {
        const items = await this.loadItemsRaw(id)
        const renamed = items.map(renameItem)
        if (renamed.some((it, i) => it !== items[i])) await this.saveItemsRaw(id, renamed)
        const versions = await this.loadVersionsRaw(id)
        const mapped = mapHidden(versions, renameItem)
        if (JSON.stringify(mapped) !== JSON.stringify(versions)) await this.saveVersionsRaw(id, mapped)
        // Who asked a side question and whom its answer asked move too, as SideQuestions does for loaded files.
        const side = await this.loadSideRaw(id)
        const renamedSide = side.map((q) => ({
          ...q,
          agent: q.agent === null ? null : rn(q.agent),
          ...(q.from !== undefined ? { from: rn(q.from) } : {}),
          ...(q.asks ? { asks: q.asks.map((l) => ({ ...l, agent: rn(l.agent) })) } : {})
        }))
        if (JSON.stringify(renamedSide) !== JSON.stringify(side)) await this.saveSideRaw(id, renamedSide)
        // The room member that dispatched; a subagent type is history and stays.
        const dispatch = await this.loadDispatchRaw(id)
        if (dispatch.entries.some((e) => e.member === oldName)) {
          await this.saveDispatchRaw(id, {
            ...dispatch,
            entries: dispatch.entries.map((e) => (e.member === oldName ? { ...e, member: newName } : e))
          })
        }
      }
      // The board names agents as creators, assignees, askers and in what each chat's sessions have seen.
      const board = await this.readTodos(this.boardFile)
      const renamedBoard = renameTodos(board, rn)
      if (JSON.stringify(renamedBoard) !== JSON.stringify(board)) await this.writeBoard(renamedBoard)
    })
  }

  private async loadItemsRaw(id: string): Promise<ChatItem[]> {
    const path = this.logPath(id)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as ChatItem[]
    } catch {
      // fall through to backup
    }
    await fs.rename(path, `${path}.bak-${this.now()}`)
    return []
  }

  private async saveItemsRaw(id: string, items: ChatItem[]): Promise<void> {
    const path = this.logPath(id)
    // A turn finishing after remove() must not resurrect the log.
    if (!(await this.load()).some((c) => c.id === id)) return
    await fs.mkdir(this.chatsDir, { recursive: true })
    await writeFileAtomic(path, JSON.stringify(items))
    try {
      this.itemsListener?.(id, items)
    } catch (err) {
      console.error('items listener failed', err)
    }
  }

  private async loadVersionsRaw(id: string): Promise<Versions> {
    const path = this.versionsPath(id)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Versions
    } catch {
      // fall through to backup
    }
    await fs.rename(path, `${path}.bak-${this.now()}`)
    return {}
  }

  private async saveVersionsRaw(id: string, v: Versions): Promise<void> {
    const path = this.versionsPath(id)
    // Same as the item log: a save landing after remove() must not bring the file back.
    if (!(await this.load()).some((c) => c.id === id)) return
    if (Object.keys(v).length === 0) {
      await fs.rm(path, { force: true })
      return
    }
    await fs.mkdir(this.chatsDir, { recursive: true })
    await writeFileAtomic(path, JSON.stringify(v))
  }

  private async loadSideRaw(id: string): Promise<SideQuestion[]> {
    const path = this.sidePath(id)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as { items?: unknown } | null
      if (parsed && Array.isArray(parsed.items)) return parsed.items as SideQuestion[]
    } catch {
      // fall through to backup
    }
    await fs.rename(path, `${path}.bak-${this.now()}`)
    return []
  }

  private async saveSideRaw(id: string, list: SideQuestion[]): Promise<void> {
    const path = this.sidePath(id)
    // Same as the item log: a save landing after remove() must not bring the file back.
    if (!(await this.load()).some((c) => c.id === id)) return
    if (list.length === 0) {
      await fs.rm(path, { force: true })
      return
    }
    await fs.mkdir(this.chatsDir, { recursive: true })
    await writeFileAtomic(path, JSON.stringify({ v: 1, items: list }))
  }

  /** The side questions of a chat, kept in their own file so no reader of the items sees them. */
  loadSide(id: string): Promise<SideQuestion[]> {
    return this.run(() => this.loadSideRaw(id))
  }

  /** An empty list removes the file. */
  saveSide(id: string, list: SideQuestion[]): Promise<void> {
    return this.run(() => this.saveSideRaw(id, list))
  }

  private async readTodos(path: string): Promise<TodoFile> {
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyTodos()
      throw err
    }
    const f = parseTodoFile(raw)
    if (f) return f
    await fs.rename(path, `${path}.bak-${this.now()}`)
    return emptyTodos()
  }

  private async writeBoard(f: TodoFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    // 0600: item text comes from agents' replies and what the user writes down, like a chat log's content.
    await writeFileAtomic(this.boardFile, JSON.stringify(f), 0o600)
    this.tellBoard(f)
  }

  /** The task board (`todos.json`): every task, wherever it was made. None yet has no file. */
  loadBoard(): Promise<TodoFile> {
    return this.run(() => this.readTodos(this.boardFile))
  }

  /**
   * Reads, changes and writes the board in one queued step, so a user tick and an agent add never interleave.
   * `fn` may return its input to say nothing changed (no write).
   */
  updateBoard(fn: (f: TodoFile) => TodoFile): Promise<TodoFile> {
    return this.run(async () => {
      const cur = await this.readTodos(this.boardFile)
      const next = fn(cur)
      if (next !== cur) await this.writeBoard(next)
      return next
    })
  }

  /**
   * The per-chat to-do lists from before the board, for the migration: every `chats/<id>.todos.json` that parses. One
   * that does not is left where it is and named in `bad`.
   */
  legacyTodoLists(): Promise<{ lists: { chatId: string; file: TodoFile }[]; bad: string[] }> {
    return this.run(async () => {
      let names: string[]
      try {
        names = await fs.readdir(this.chatsDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lists: [], bad: [] }
        throw err
      }
      const lists: { chatId: string; file: TodoFile }[] = []
      const bad: string[] = []
      for (const name of names.filter((n) => n.endsWith('.todos.json')).sort()) {
        const chatId = name.slice(0, -'.todos.json'.length)
        if (!ID_RE.test(chatId)) continue
        const f = parseTodoFile(await fs.readFile(join(this.chatsDir, name), 'utf8').catch(() => ''))
        if (f) lists.push({ chatId, file: f })
        else bad.push(chatId)
      }
      return { lists, bad }
    })
  }

  /** Removes per-chat lists the board now holds. */
  dropLegacyTodos(chatIds: string[]): Promise<void> {
    return this.run(async () => {
      for (const id of chatIds) await fs.rm(this.legacyTodosPath(id), { force: true })
    })
  }

  private async loadDispatchRaw(id: string): Promise<DispatchFile> {
    const path = this.dispatchPath(id)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDispatch()
      throw err
    }
    try {
      const p = JSON.parse(raw) as Partial<DispatchFile> | null
      if (p && p.v === 1 && Array.isArray(p.entries)) return { v: 1, entries: p.entries }
    } catch {
      // fall through to backup
    }
    await fs.rename(path, `${path}.bak-${this.now()}`)
    return emptyDispatch()
  }

  private async saveDispatchRaw(id: string, f: DispatchFile): Promise<void> {
    await fs.mkdir(this.chatsDir, { recursive: true })
    // 0600: a subagent's tool results hold whatever it read, a .env included.
    await writeFileAtomic(this.dispatchPath(id), JSON.stringify(f), 0o600)
  }

  /** The chat's dispatched agents, in their own file so no reader of the items sees them. None yet has no file. */
  loadDispatch(id: string): Promise<DispatchFile> {
    return this.run(() => this.loadDispatchRaw(id))
  }

  /** As updateTodos: one queued read-change-write; `fn` returning its input writes nothing; a chat that is gone rejects. */
  updateDispatch(id: string, fn: (f: DispatchFile) => DispatchFile): Promise<DispatchFile> {
    return this.run(async () => {
      await this.mustGet(id)
      const cur = await this.loadDispatchRaw(id)
      const next = fn(cur)
      if (next !== cur) await this.saveDispatchRaw(id, next)
      return next
    })
  }

  /**
   * A remote (AG-UI) agent's thread: its id, the state it keeps and the interrupts still open. None yet, or a file that is not
   * one, is null: the next run starts a fresh thread, as the design has it for a damaged file.
   */
  loadAgui(id: string): Promise<AguiThread | null> {
    return this.run(async () => {
      let raw: string
      try {
        raw = await fs.readFile(this.aguiPath(id), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      try {
        return parseAguiThread(JSON.parse(raw))
      } catch {
        return null
      }
    })
  }

  /** Keeps the thread (0600: the state is the remote server's, and may hold anything), or removes it (null). A removed chat rejects. */
  saveAgui(id: string, t: AguiThread | null): Promise<void> {
    return this.run(async () => {
      const path = this.aguiPath(id)
      if (t === null) return fs.rm(path, { force: true })
      // A run that outlives its chat must not bring the file back after remove().
      await this.mustGet(id)
      await fs.mkdir(this.chatsDir, { recursive: true })
      await writeFileAtomic(path, JSON.stringify(t), 0o600)
    })
  }

  /** The hidden message versions of a chat, kept apart from its items so no reader of the items sees them. */
  loadVersions(id: string): Promise<Versions> {
    return this.run(() => this.loadVersionsRaw(id))
  }

  saveVersions(id: string, v: Versions): Promise<void> {
    return this.run(() => this.saveVersionsRaw(id, v))
  }

  loadItems(id: string): Promise<ChatItem[]> {
    return this.run(() => this.loadItemsRaw(id))
  }

  saveItems(id: string, items: ChatItem[]): Promise<void> {
    return this.run(() => this.saveItemsRaw(id, items))
  }

  recoverInterrupted(): Promise<string[]> {
    return this.run(async () => {
      const ids: string[] = []
      for (const chat of [...(await this.load())]) {
        const items = await this.loadItemsRaw(chat.id)
        // A pause the crash cut short still counts: the chat ends paused (held while tasks wait), with the marker the landing adds.
        const userPaused = (): ChatItem => ({
          type: 'notice',
          id: `userpaused-${this.newId()}`,
          kind: 'userPaused',
          text: chat.pauseCap ? capPausedText(chat.pauseCap) : NOTICE_TEXT.userPaused,
          ts: this.now()
        })
        // Held as the landing does (holdTasks): only a tray with a task the user can see has anything to hold.
        const heldPatch = (): Partial<Omit<ChatMeta, 'id'>> => (holdsVisibleTask(chat.tasks) ? { held: true } : {})
        if (!chat.inFlight) {
          const base = items.map((it): ChatItem =>
            it.type === 'browser-action' && it.handoff.status === 'pending'
              ? { ...it, handoff: { ...it.handoff, status: 'interrupted' } }
              : it.type === 'vault-approval' && it.request.status === 'pending'
                ? { ...it, request: { ...it.request, status: 'interrupted' } }
                : it
          )
          const pausing = chat.pause === 'pausing'
          // Landed `paused`, but the crash came before its notice was saved: the Resume pill sits on that notice.
          const last = items[items.length - 1]
          const unmarked = chat.pause === 'paused' && !(last?.type === 'notice' && last.kind === 'userPaused')
          const changed =
            pausing ||
            unmarked ||
            items.some(
              (it) =>
                (it.type === 'browser-action' && it.handoff.status === 'pending') ||
                (it.type === 'vault-approval' && it.request.status === 'pending')
            )
          if (changed) await this.saveItemsRaw(chat.id, pausing || unmarked ? [...base, userPaused()] : base)
          if (pausing) {
            // The reply ended but the landing never ran; the order in the list stays.
            await this.updateLocked(chat.id, { pause: 'paused', ...heldPatch(), updatedAt: chat.updatedAt })
          }
          if (pausing || unmarked) ids.push(chat.id)
          continue
        }
        // A card still pending after a crash can never be answered; each notice closes the block it belongs to.
        const interrupted = (): ChatItem => ({
          type: 'notice',
          id: `interrupted-${this.newId()}`,
          kind: 'interrupted',
          text: NOTICE_TEXT.interrupted,
          ts: this.now()
        })
        const settled = items.map((it): ChatItem =>
          it.type === 'approval' && it.status === 'pending'
            ? { ...it, status: 'unanswered' }
            : it.type === 'browser-action' && it.handoff.status === 'pending'
              ? { ...it, handoff: { ...it.handoff, status: 'interrupted' } }
              : it.type === 'vault-approval' && it.request.status === 'pending'
                ? { ...it, request: { ...it.request, status: 'interrupted' } }
                : it
        )
        // Live items of a group stay in the log mixed together; each turn becomes its own block at the end.
        const turns = new Map<string, ChatItem[]>()
        const rest: ChatItem[] = []
        for (const it of settled) {
          if ('turn' in it && it.turn !== undefined) {
            const { turn, ...plain } = it
            turns.set(turn, [...(turns.get(turn) ?? []), plain as ChatItem])
          } else rest.push(it)
        }
        const out = turns.size === 0 ? [...rest, interrupted()] : [...rest, ...[...turns.values()].flatMap((b) => [...b, interrupted()])]
        // `paused` too: a room lands its pause (landPause) before it clears inFlight, so a crash between the two left
        // neither the notice nor GroupInfo.paused saved.
        const pausing = chat.pause !== undefined
        await this.saveItemsRaw(chat.id, pausing ? [...out, userPaused()] : out)
        // The room's paused state is read before active and queue are cleared; reasons do not survive a crash.
        const paused =
          chat.group && pausing
            ? (chat.group.paused ?? { members: chat.group.active.map((a) => a.agent), queue: chat.group.queue })
            : undefined
        await this.updateLocked(chat.id, {
          inFlight: false,
          compacting: undefined,
          ...(pausing ? { pause: 'paused' as const, ...heldPatch() } : {}),
          ...(chat.group ? { group: { ...chat.group, queue: [], active: [], ...(paused ? { paused } : {}) } } : {})
        })
        ids.push(chat.id)
      }
      return ids
    })
  }
}
