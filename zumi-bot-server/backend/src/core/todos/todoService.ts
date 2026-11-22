import {
  addTodos,
  answerTodo,
  askTodo,
  dropAttempts,
  keepAttempt,
  setCardPr,
  startAttempts,
  boardOf,
  changesSince,
  checkTodos,
  commentTodo,
  deleteComment,
  editComment,
  liveComments,
  assignTodo,
  editTodo,
  liveTodos,
  openTodos,
  removeTodos,
  reopenTodo,
  restoreTodos,
  reviewTodo,
  seenKey,
  setStatus,
  startTask,
  statusOf,
  taskTurnEnded,
  taskTurnStarted,
  type TodoStatus,
  type TodoAsk,
  type TodoComment,
  type TodoAttempt,
  type TodoAttempts,
  type TodoPr,
  type TodoBoard,
  type TodoFile,
  type TodoItem,
  type TodoQuestion,
  type TodoTask,
  type TodoTouch,
  TODO_FILES,
  TODO_FILES_MAX,
  TODO_USER_LABEL,
  TODO_USER_TURN
} from '@zumibot/shared/todos'
import type { Attachment, ChatPush, TodoCardEdit } from '@zumibot/shared/types'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { ChatStore } from '../store/chatStore'
import { taskNote } from './taskPrompt'

export interface TodoServiceDeps {
  store: Pick<ChatStore, 'get' | 'loadBoard' | 'updateBoard'>
  /** Where a card's files go (attachments/<TODO_FILES>); absent: an edit that adds or removes files refuses. */
  files?: Pick<AttachmentStore, 'commit' | 'removeFiles'>
  now(): number
  newId(): string
  /** The board changed: told to every tab (also at an unchanged rev, for a task's own change). */
  onChanged(rev: number): void
  /** After an add made in a chat that added at least one item: the new items, and who added them ('user' or the agent). */
  onAdded?(chatId: string, items: TodoItem[], by: string): void
}

const NOTE_MAX = 4000
const ENDED_KEPT = 200
const MORE = 'More items: call list.'
const NOTE_HEAD = "The user's task board (ids are for the zumibot_todos tools only):"
const WHOLE_BOARD = 'Call list to see the whole board.'

const who = (by: string): string => (by === 'user' ? 'the user' : by)
const STATUS_TEXT: Record<TodoStatus, string> = {
  new: 'New',
  todo: 'To do',
  blocked: 'Blocked',
  progress: 'In progress',
  review: 'In review',
  done: 'Done'
}
// Who made it, who does it and where it stands, so an agent reading the board knows whose an item is.
const owner = (i: TodoItem): string =>
  `by ${who(i.addedBy)}; ${i.assignee ? `for ${who(i.assignee)}` : 'nobody assigned'}; ${STATUS_TEXT[statusOf(i)]}`
const short = (i: TodoItem): string => `- [${i.id}] ${i.group ? `(${i.group}) ` : ''}${i.text} (${owner(i)})`
const NOTES_SHOWN = 300
// The list call shows a card's notes too, cut; the note before a turn keeps to the short form.
const full = (i: TodoItem): string => {
  const d = i.description?.replace(/\s+/g, ' ')
  const notes = d ? [`  Notes: ${d.length > NOTES_SHOWN ? `${d.slice(0, NOTES_SHOWN)}…` : d}`] : []
  return [short(i), ...notes, ...commentLines(i)].join('\n')
}
const NO_TASK = 'This chat works on no task card. Ask in your reply instead.'
const COMMENT_SHOWN = 300
const COMMENTS_LISTED = 5
const oneLineCut = (t: string, max: number): string => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
/** After a `commented` change: the newest comment its author has on the card, so the note carries what was said. */
const commentOf = (i: TodoItem): string => {
  if (i.last.action !== 'commented') return ''
  const c = [...liveComments(i)].reverse().find((x) => x.by === i.last.by)
  return c ? ` — "${oneLineCut(c.text, COMMENT_SHOWN)}"` : ''
}
/** The newest comments of a card, for list: who and what, each cut. */
const commentLines = (i: TodoItem): string[] => {
  const live = liveComments(i)
  if (live.length === 0) return []
  const shown = live.slice(-COMMENTS_LISTED)
  const head = live.length > shown.length ? `  Comments (newest ${shown.length} of ${live.length}):` : '  Comments:'
  return [head, ...shown.map((c) => `  - ${who(c.by)}: ${oneLineCut(c.text, COMMENT_SHOWN)}`)]
}

/** Keeps whole lines while they fit with the cut notice; the notice is added only when something was cut. */
function cut(lines: string[], max: number): string {
  const all = lines.join('\n')
  if (all.length <= max) return all
  const out: string[] = []
  let len = MORE.length
  for (const l of lines) {
    len += l.length + 1
    if (len > max) break
    out.push(l)
  }
  return [...out, MORE].join('\n')
}

/**
 * The user's one task board, for the board page, the chats' panels and every agent's tools; the file and its queue are
 * the store's. An item's chat is the one it was made in (null: on the board); `addedBy` names who made it.
 */
export class TodoService {
  // In memory only: it feeds the reply's `todos` touch, which the turn runner stores on the item itself.
  private readonly touches = new Map<string, TodoTouch>()
  // The turns endTurn closed, oldest first: a call still in flight at the end must not leave a record nobody drops.
  private readonly ended = new Set<string>()
  // Task chats whose turn is running, as their meta pushes said: only the start of a turn moves a card.
  private readonly runningTasks = new Set<string>()

  constructor(private readonly deps: TodoServiceDeps) {}

  /** The live items: all of them (null), or those made in one chat (its side panel). */
  async list(chatId: string | null): Promise<{ rev: number; items: TodoItem[] }> {
    const f = await this.deps.store.loadBoard()
    const live = liveTodos(f)
    return { rev: f.rev, items: chatId === null ? live : live.filter((i) => i.from.chatId === chatId) }
  }

  /** The board page's read: every open item and the newest done ones. */
  async board(): Promise<TodoBoard> {
    return boardOf(await this.deps.store.loadBoard())
  }

  /**
   * By hand, on the board (chatId null) or in a chat's panel. Blank text or a repeat of an open item adds nothing
   * (`added` false, no rev, no event); the caps throw as for an agent.
   */
  async userAdd(text: string, chatId: string | null = null): Promise<{ added: boolean }> {
    if (chatId !== null && !(await this.deps.store.get(chatId))) throw new Error(`Chat not found: ${chatId}`)
    const at = this.deps.now()
    const from = { chatId, turn: TODO_USER_TURN, itemId: null, label: TODO_USER_LABEL, at }
    const r = await this.mutate((f) => {
      const { file, added } = addTodos(f, [{ text }], 'user', from, at, () => this.deps.newId())
      return { file, changed: added }
    })
    // An item made on the board has no chat for a workflow's chat event to name.
    if (chatId !== null) this.added(chatId, r.changed, 'user')
    return { added: r.changed.length > 0 }
  }

  async userCheck(ids: string[], done: boolean): Promise<void> {
    await this.mutate((f) => checkTodos(f, ids, done, 'user', this.deps.now()))
  }

  async userRemove(ids: string[]): Promise<void> {
    await this.mutate((f) => removeTodos(f, ids, 'user', this.deps.now()))
  }

  async userRestore(ids: string[]): Promise<void> {
    await this.mutate((f) => restoreTodos(f, ids, 'user', this.deps.now()))
  }

  /** One live card, for a step that must look before it changes anything (giving it starts a chat). */
  async card(id: string): Promise<TodoItem> {
    const item = (await this.deps.store.loadBoard()).items.find((i) => i.id === id)
    if (!item || item.removed !== null) throw new Error('This to-do was removed.')
    return item
  }

  /**
   * The user's edit of a card: title, notes, and files (staged ids moved into the board's folder; removed ones deleted
   * once the edit is stored). A failed edit takes back the files it moved.
   */
  async userEdit(id: string, edit: TodoCardEdit): Promise<void> {
    const add = edit.addFiles ?? [],
      drop = new Set(edit.removeFiles ?? [])
    const files = this.deps.files
    const touchesFiles = add.length > 0 || drop.size > 0
    if (touchesFiles && !files) throw new Error('Card files are unavailable')
    // Before any file moves: a full card must not leave a folder behind.
    const cur = await this.card(id)
    const kept = (cur.files ?? []).filter((a) => !drop.has(a.id)).length
    if (kept + add.length > TODO_FILES_MAX) throw new Error(`A to-do holds at most ${TODO_FILES_MAX} files.`)
    const moved: Attachment[] = add.length > 0 ? await files!.commit(TODO_FILES, add) : []
    let gone: Attachment[] = []
    try {
      await this.mutate((f) => {
        const current = f.items.find((i) => i.id === id)?.files ?? []
        gone = current.filter((a) => drop.has(a.id))
        return editTodo(
          f,
          id,
          {
            ...(edit.text !== undefined ? { text: edit.text } : {}),
            ...(edit.description !== undefined ? { description: edit.description } : {}),
            ...(touchesFiles ? { files: [...current.filter((a) => !drop.has(a.id)), ...moved] } : {})
          },
          'user',
          this.deps.now()
        )
      })
    } catch (e) {
      if (moved.length > 0)
        await files!
          .removeFiles(
            TODO_FILES,
            moved.map((a) => a.id)
          )
          .catch(() => undefined)
      throw e
    }
    // After the store: a crash in between leaves a file no card names, never a card naming a missing file.
    if (gone.length > 0)
      await files!
        .removeFiles(
          TODO_FILES,
          gone.map((a) => a.id)
        )
        .catch(() => console.error('removing a card file failed'))
  }

  /**
   * The user's comment on a card; agents hear of it as of an edit, the card's task agent on its next turn. `asked`: the
   * agents it mentions, which answer under it (`CommentAsks`).
   */
  async userComment(
    id: string,
    text: string,
    o: { replyTo?: string; asked?: string[] } = {}
  ): Promise<{ item: TodoItem; comment: TodoComment }> {
    let out!: { item: TodoItem; comment: TodoComment }
    await this.mutate((f) => {
      const r = commentTodo(f, id, text, 'user', this.deps.now(), () => this.deps.newId(), o)
      out = { item: r.file.items.find((i) => i.id === id)!, comment: r.comment }
      return { file: r.file, changed: [] }
    })
    return out
  }

  /** A mentioned agent's answer, posted under the comment that asked it. */
  async agentReply(id: string, agent: string, replyTo: string, text: string): Promise<void> {
    await this.mutate((f) => ({
      file: commentTodo(f, id, text, agent, this.deps.now(), () => this.deps.newId(), { replyTo }).file,
      changed: []
    }))
  }

  async userEditComment(id: string, commentId: string, text: string): Promise<void> {
    await this.mutate((f) => ({ ...editComment(f, id, commentId, text, 'user', this.deps.now()), changed: [] }))
  }

  async userDeleteComment(id: string, commentId: string): Promise<void> {
    await this.mutate((f) => ({ ...deleteComment(f, id, commentId, 'user', this.deps.now()), changed: [] }), 'file')
  }

  /** Who does the card (the user, an agent with its folder, or nobody); told to every tab, no agent hears of it as a change. */
  async userAssign(id: string, assignee: string | null, folder: string | null): Promise<TodoItem> {
    let item!: TodoItem
    await this.mutate((f) => {
      const r = assignTodo(f, id, assignee, folder, this.deps.now())
      item = r.item
      return { file: r.file, changed: [] }
    }, 'file')
    return item
  }

  /** A card moved by hand; a tick or untick it makes is told to agents as one. */
  async userStatus(id: string, status: TodoStatus): Promise<TodoItem> {
    let item!: TodoItem
    await this.mutate((f) => {
      const r = setStatus(f, id, status, 'user', this.deps.now())
      item = r.item
      return { file: r.file, changed: [] }
    }, 'file')
    return item
  }

  /** The assigned agent's chat was made for the card: linked, To do. */
  async userStartTask(id: string, task: Omit<TodoTask, 'review'>): Promise<TodoItem> {
    let item!: TodoItem
    await this.mutate((f) => {
      const r = startTask(f, id, task, this.deps.now())
      item = r.item
      return { file: r.file, changed: [] }
    }, 'file')
    return item
  }

  /**
   * Every chat push, for task chats: a turn starting (inFlight going true) moves its card to In progress. Tracked per
   * chat, since a running turn pushes its meta many times. Never throws; a failed write only logs its code.
   */
  chatPush(p: ChatPush): void {
    if (p.kind !== 'meta') return
    const { id, inFlight, task } = p.meta
    const was = this.runningTasks.has(id)
    if (!inFlight || !task) {
      this.runningTasks.delete(id)
      return
    }
    if (was) return
    this.runningTasks.add(id)
    this.taskStep(() => this.mutate((f) => ({ ...taskTurnStarted(f, id, this.deps.now()), changed: [] }), 'file'))
  }

  /** A turn ended in a chat: in a task's chat its card moves to Blocked, In review or New. */
  turnEnded(e: { chatId: string; outcome: 'ok' | 'error' | 'stopped' }): void {
    this.runningTasks.delete(e.chatId)
    this.taskStep(async () => {
      if (!(await this.deps.store.get(e.chatId))?.task) return
      await this.mutate((f) => ({ ...taskTurnEnded(f, e.chatId, e.outcome, this.deps.now()), changed: [] }), 'file')
    })
  }

  // A card's move after a turn must never fail or slow the turn; the code is all that is logged.
  private taskStep(work: () => Promise<unknown>): void {
    void work().catch((err) => {
      const code = (err as { code?: unknown } | null)?.code
      console.error('task card not moved:', typeof code === 'string' ? code : 'error')
    })
  }

  async userAnswer(id: string, answers: { id: string; text: string }[]): Promise<{ item: TodoItem; answered: TodoQuestion[] }> {
    const r = await this.mutate((f) => ({ ...answerTodo(f, id, answers, this.deps.now()), changed: [] }), 'file')
    return { item: r.item, answered: r.answered }
  }

  /** The card takes a set of parallel attempts; the board's agents are not told, as with any other chat's work. */
  async userStartAttempts(id: string, set: TodoAttempts): Promise<TodoItem> {
    let item!: TodoItem
    await this.mutate((f) => {
      const r = startAttempts(f, id, set, this.deps.now())
      item = r.item
      return { file: r.file, changed: [] }
    }, 'file')
    return item
  }

  /** The user keeps one attempt: it becomes the card's task chat and the card is In review. */
  async userKeepAttempt(id: string, chatId: string): Promise<{ item: TodoItem; kept: TodoAttempt; others: TodoAttempt[] }> {
    let got!: { item: TodoItem; kept: TodoAttempt; others: TodoAttempt[] }
    await this.mutate((f) => {
      const r = keepAttempt(f, id, chatId, this.deps.now())
      got = { item: r.item, kept: r.kept, others: r.others }
      return { file: r.file, changed: [] }
    }, 'file')
    return got
  }

  /** The user drops a set without keeping one: the card is New again and the chats are left alone. */
  async userDropAttempts(id: string): Promise<{ item: TodoItem; dropped: TodoAttempt[] }> {
    let got!: { item: TodoItem; dropped: TodoAttempt[] }
    await this.mutate((f) => {
      const r = dropAttempts(f, id, this.deps.now())
      got = { item: r.item, dropped: r.dropped }
      return { file: r.file, changed: [] }
    }, 'file')
    return got
  }

  /** The board's copy of the task chat's pull request; the chat's own meta is what counts. */
  async setCardPr(id: string, pr: TodoPr | null): Promise<void> {
    await this.mutate((f) => ({ ...setCardPr(f, id, pr, this.deps.now()), changed: [] }), 'file')
  }

  /** The user wrote to the task's agent from the card: a review it asked for is over. */
  async userReopen(id: string): Promise<TodoItem> {
    const r = await this.mutate((f) => ({ ...reopenTodo(f, id, this.deps.now()), changed: [] }), 'file')
    return r.item
  }

  async agentList(chatId: string, agent: string): Promise<string> {
    const f = await this.deps.store.loadBoard()
    const lines = [...this.openLines(f, true, full), ...this.sinceLines(f, seenKey(chatId, agent), agent)]
    return lines.join('\n') // whole: this is the call the cut notices point to
  }

  async agentAdd(
    chatId: string,
    agent: string,
    turn: string,
    label: string,
    items: { text: string; group?: string | null; description?: string }[]
  ): Promise<string> {
    const at = this.deps.now()
    const r = await this.mutate((f) => {
      const { file, added, skipped } = addTodos(f, items, agent, { chatId, turn, itemId: null, label, at }, at, () => this.deps.newId())
      return { file, changed: added, skipped }
    })
    this.touchFor(turn).added += r.changed.length
    this.added(chatId, r.changed, agent)
    const head = [r.changed.length > 0 ? `Added ${r.changed.length} to-do${r.changed.length === 1 ? '' : 's'}.` : 'Added nothing.']
    if (r.skipped.length > 0) head.push(`Skipped, already open: ${r.skipped.join('; ')}`)
    return this.answer(r.file, head)
  }

  async agentCheck(_chatId: string, agent: string, turn: string, ids: string[], done: boolean): Promise<string> {
    const r = await this.mutate((f) => checkTodos(f, ids, done, agent, this.deps.now()))
    const t = this.touchFor(turn)
    const texts = r.changed.map((i) => i.text)
    ;(done ? t.ticked : t.unticked).push(...texts)
    return this.answer(r.file, this.report(done ? 'Ticked' : 'Unticked', ids, r.changed))
  }

  async agentRemove(_chatId: string, agent: string, turn: string, ids: string[]): Promise<string> {
    const r = await this.mutate((f) => removeTodos(f, ids, agent, this.deps.now()))
    this.touchFor(turn).removed.push(...r.changed.map((i) => i.text))
    return this.answer(r.file, this.report('Removed', ids, r.changed))
  }

  /** The task agent's questions, put on the card its chat works on. */
  async agentAskUser(chatId: string, agent: string, turn: string, questions: TodoAsk[]): Promise<string> {
    const todoId = await this.taskOf(chatId)
    let asked: TodoQuestion[] = []
    await this.mutate((f) => {
      const r = askTodo(f, todoId, chatId, agent, questions, this.deps.now(), () => this.deps.newId())
      asked = r.asked
      return { file: r.file, changed: [] }
    }, 'file')
    const t = this.touchFor(turn)
    t.asked = [...(t.asked ?? []), ...asked.map((q) => q.text)]
    const n = asked.length
    return `Put ${n} question${n === 1 ? '' : 's'} on the task card. End your turn now: the user answers on the card, and the answers come back as a new message.`
  }

  /** The task agent says the card's work is done. */
  async agentReview(chatId: string, _agent: string, turn: string, summary: string): Promise<string> {
    const todoId = await this.taskOf(chatId)
    await this.mutate((f) => ({ file: reviewTodo(f, todoId, chatId, summary, this.deps.now()).file, changed: [] }), 'file')
    this.touchFor(turn).review = true
    return 'Marked the task card ready for review. End your turn with a short summary for the user; they tick the card or write back.'
  }

  /** An agent's comment on any card of the board (the user reads it on the card). */
  async agentComment(_chatId: string, agent: string, turn: string, id: string, text: string): Promise<string> {
    let title = ''
    const r = await this.mutate((f) => {
      const c = commentTodo(f, id, text, agent, this.deps.now(), () => this.deps.newId())
      title = c.file.items.find((i) => i.id === id)?.text ?? ''
      return { file: c.file, changed: [] }
    })
    const t = this.touchFor(turn)
    t.commented = [...(t.commented ?? []), title]
    return this.answer(r.file, [`Commented on "${title}".`])
  }

  /** What the turn did to the board so far, or null if nothing; a copy, so the caller may keep it. */
  touch(turn: string): TodoTouch | null {
    const t = this.touches.get(turn)
    const asked = t?.asked ?? []
    const commented = t?.commented ?? []
    if (
      !t ||
      (t.added === 0 && t.ticked.length + t.unticked.length + t.removed.length + asked.length + commented.length === 0 && !t.review)
    )
      return null
    return {
      added: t.added,
      ticked: [...t.ticked],
      unticked: [...t.unticked],
      removed: [...t.removed],
      ...(asked.length > 0 ? { asked: [...asked] } : {}),
      ...(t.review ? { review: true as const } : {}),
      ...(commented.length > 0 ? { commented: [...commented] } : {})
    }
  }

  /** Points the turn's items at the reply item they came from. Not a change anyone sees as new: rev stays. */
  async settle(chatId: string, turn: string, itemId: string | null): Promise<void> {
    if (itemId === null) return
    const at = this.deps.now()
    const mine = (i: TodoItem) => i.from.chatId === chatId && i.from.turn === turn && i.from.itemId === null
    await this.mutate((f) => {
      if (!f.items.some(mine)) return { file: f, changed: [] }
      const items = f.items.map((i) => (mine(i) ? { ...i, from: { ...i.from, itemId }, updatedAt: at } : i))
      return { file: { ...f, items }, changed: [] }
    }, 'file')
  }

  /**
   * The agent's session in this chat has seen the board as it was at `rev`, the one its note read. Not the rev at turn
   * end: what others change while its reply runs is still news next turn. Its own later changes need nothing:
   * changesSince leaves them out.
   */
  async markSeen(chatId: string, agent: string, rev: number): Promise<void> {
    const key = seenKey(chatId, agent)
    await this.mutate((f) => {
      const seen = Math.max(f.seen[key] ?? 0, rev) // a stale read never moves it back
      // An empty board stays without a file: every turn of every chat ends here. A missing seen reads as 0.
      if (f.seen[key] === seen || (f.rev === 0 && f.items.length === 0)) return { file: f, changed: [] }
      return { file: { ...f, seen: { ...f.seen, [key]: seen } }, changed: [] }
    }, 'none')
  }

  /**
   * The block an agent's message gets before its turn. `force` is a new or seeded session, `asked` a `/todo` turn: both
   * get the open items. A session that never saw the board gets them once too. Otherwise only what others changed since
   * the session saw it is said, so a busy board does not cost every turn its whole list.
   */
  async note(chatId: string, agent: string, o: { force: boolean; asked: boolean }): Promise<{ text: string | null; rev: number }> {
    const f = await this.deps.store.loadBoard()
    // A task's chat also hears, every turn, what its card is and how to use it.
    const parts = [this.noteText(f, seenKey(chatId, agent), agent, o), await this.taskNoteOf(chatId, f)].filter(
      (p): p is string => p !== null
    )
    // The rev read, even with no text: it is what the agent has seen once its turn ran (markSeen).
    return { text: parts.length > 0 ? parts.join('\n\n') : null, rev: f.rev }
  }

  private noteText(f: TodoFile, key: string, agent: string, o: { force: boolean; asked: boolean }): string | null {
    // An empty board keeps messages as they were; only a /todo turn hears it is empty.
    if (!o.asked && f.items.length === 0) return null
    const seen = f.seen[key]
    const since = this.sinceLines(f, key, agent)
    // A session that never saw the board, with something on it that is not its own work: the board once, as a new one gets it.
    const unseen = seen === undefined && changesSince(f, 0, agent).length > 0
    if (o.force || o.asked || unseen) {
      // What others changed comes first, so the cut drops open items (list returns them whole), not the user's ticks.
      return cut([NOTE_HEAD, ...since, ...this.openLines(f, since.length > 0)], NOTE_MAX)
    }
    if (since.length === 0) return null
    return cut([NOTE_HEAD, ...since, WHOLE_BOARD], NOTE_MAX)
  }

  endTurn(turn: string): void {
    this.touches.delete(turn)
    this.ended.add(turn)
    if (this.ended.size > ENDED_KEPT)
      for (const oldest of this.ended) {
        this.ended.delete(oldest)
        break
      }
  }

  /** The card a task's chat works on, as its note says it; null for a plain chat. */
  private async taskNoteOf(chatId: string, f: TodoFile): Promise<string | null> {
    const link = (await this.deps.store.get(chatId))?.task
    if (!link) return null
    const item = f.items.find((i) => i.id === link.todoId)
    return taskNote(item && item.removed === null ? item : null)
  }

  private async taskOf(chatId: string): Promise<string> {
    const link = (await this.deps.store.get(chatId))?.task
    if (!link) throw new Error(NO_TASK)
    return link.todoId
  }

  // A signal for workflows: it must never fail or slow an add the user or agent already made.
  private added(chatId: string, items: TodoItem[], by: string): void {
    if (items.length === 0 || !this.deps.onAdded) return
    try {
      this.deps.onAdded(chatId, items, by)
    } catch {
      /* the add is done */
    }
  }

  /** The turn's record; for a turn that already ended, a loose one that is never kept (its change stays on the board). */
  private touchFor(turn: string): TodoTouch {
    if (this.ended.has(turn)) return { added: 0, ticked: [], unticked: [], removed: [] }
    let t = this.touches.get(turn)
    if (!t) this.touches.set(turn, (t = { added: 0, ticked: [], unticked: [], removed: [] }))
    return t
  }

  // 'rev' tells when the rev moved, 'file' when anything changed (a task's own change), 'none' never.
  private async mutate<X extends { changed: TodoItem[] }>(
    op: (f: TodoFile) => { file: TodoFile } & X,
    notify: 'rev' | 'file' | 'none' = 'rev'
  ): Promise<{ file: TodoFile } & X> {
    let res!: { file: TodoFile } & X
    let before!: TodoFile
    await this.deps.store.updateBoard((f) => ((before = f), (res = op(f)).file))
    const moved = notify === 'rev' ? res.file.rev !== before.rev : notify === 'file' && res.file !== before
    if (moved) this.deps.onChanged(res.file.rev)
    return res
  }

  /** The open items in short form; `heading` is false under a header of its own. */
  private openLines(f: TodoFile, heading = true, line: (i: TodoItem) => string = short): string[] {
    const open = openTodos(f)
    if (open.length === 0) return ['No open to-dos.']
    return [...(heading ? ['Open to-dos:'] : []), ...open.map(line)]
  }

  /** What others did since this session last saw the board, one line per item. A session that never saw it has no "last turn". */
  private sinceLines(f: TodoFile, key: string, agent: string): string[] {
    const seen = f.seen[key]
    const ch = seen === undefined ? [] : changesSince(f, seen, agent)
    if (ch.length === 0) return []
    return ['Since your last turn:', ...ch.map((i) => `- ${i.last.action} by ${who(i.last.by)}: ${i.text}${commentOf(i)}`)]
  }

  private report(verb: string, ids: string[], changed: TodoItem[]): string[] {
    const hit = new Set(changed.map((i) => i.id))
    const miss = ids.filter((id) => !hit.has(id))
    const head = [changed.length > 0 ? `${verb} ${changed.length} to-do${changed.length === 1 ? '' : 's'}.` : `${verb} nothing.`]
    if (miss.length > 0) head.push(`No change for: ${miss.join(', ')} (unknown, removed or already so)`)
    return head
  }

  /** Every tool answer ends with the open board, so the agent's own history stays current. */
  private answer(f: TodoFile, head: string[]): string {
    return cut([...head, ...this.openLines(f)], NOTE_MAX)
  }
}
