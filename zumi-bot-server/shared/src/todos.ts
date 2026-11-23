import type { Engine } from './engine'
import type { Attachment } from './types'

export const TODO_NAME = 'todo'
export const TODO_TEXT_MAX = 300
export const TODO_GROUP_MAX = 60
export const TODO_ADD_MAX = 50
export const TODO_OPEN_MAX = 500 // open items on the whole board
// Every item the user types in the panel shares this turn, so they sit in one group.
export const TODO_USER_TURN = 'user'
export const TODO_USER_LABEL = 'Added by you'
export const TODO_DONE_SHOWN = 100
// A card's notes, files, and what a task's agent and the user write on it.
export const TODO_DESC_MAX = 10_000
export const TODO_AGENT_DESC_MAX = 4_000 // what an agent's add may write: 50 of them still fit one IPC request (1 MiB)
export const TODO_FILES_MAX = 10
export const TODO_QUESTION_MAX = 1_000
export const TODO_OPTION_MAX = 120
export const TODO_OPTIONS_MAX = 6
export const TODO_ASK_MAX = 10 // questions per ask_user call
export const TODO_QUESTIONS_MAX = 50 // per assignment: a new give starts the list again
export const TODO_ANSWER_MAX = 4_000
export const TODO_REVIEW_MAX = 4_000
export const TODO_REPLY_MAX = 20_000
export const TODO_COMMENT_MAX = 4_000
export const TODO_COMMENTS_MAX = 200 // live comments on one card; tombstones are not counted
export const TODO_COMMENT_ASKS_MAX = 3 // agents one comment can call on
/** The attachments folder of the board's card files; chat ids are UUIDs, so it never names a chat. */
export const TODO_FILES = 'todos'
/** The newest done items a board answer carries; older ones stay on the board, counted. */
export const BOARD_DONE_MAX = 200
export const TODO_TOOLS = [
  'mcp__zumibot_todos__list',
  'mcp__zumibot_todos__add',
  'mcp__zumibot_todos__check',
  'mcp__zumibot_todos__remove',
  'mcp__zumibot_todos__ask_user',
  'mcp__zumibot_todos__ready_for_review',
  'mcp__zumibot_todos__comment'
] as const

export type TodoBy = 'user' | string // agent name otherwise
export type TodoAction = 'added' | 'ticked' | 'unticked' | 'removed' | 'restored' | 'edited' | 'commented'

/**
 * Where an item was made: the chat (null: on the board itself) and the reply in it; `label` is what its group shows,
 * kept so it outlives the reply. With `addedBy` it names the item's creator.
 */
export interface TodoSource {
  chatId: string | null
  turn: string
  itemId: string | null
  label: string
  at: number
}

/** The chat made for the assigned agent the first time its card went to To do. */
export interface TodoTask {
  agent: string
  chatId: string
  at: number
  /** The agent called ready_for_review, with its summary. A new question or a message from the card clears it. */
  review: { at: number; summary: string } | null
}

/** One attempt of a set: an agent given the card in its own chat and its own worktree, all from one base commit. */
export interface TodoAttempt {
  n: number // its place in the set, 1-based
  agent: string
  engine: Engine // what it ran on when the set started
  chatId: string
}

/**
 * Several agents given the same card at once, each in its own chat and worktree from one base commit, so their diffs
 * compare. The card's own `task` stays unset until the user keeps one: until then nothing drives the card's column but
 * the user. See docs/architecture/review-loop.md.
 */
export interface TodoAttempts {
  id: string
  at: number
  base: string | null // the commit every worktree was made from; null in a repo with no commit yet
  folder: string // the folder the user picked, as TodoItem.folder
  prompt: string // the text every attempt was given
  attempts: TodoAttempt[]
  winner?: string // the kept attempt's chatId; absent while none is kept
  failed?: { agent: string; why: string }[] // picks that could not start, with git's or the server's own line
}

/** A question the task's agent asked on the card. The user answers there; the answers go to the task's chat as one message. */
export interface TodoQuestion {
  id: string
  text: string
  options: string[] // choices the agent offered, any of which fills the answer; may be empty
  by: string
  at: number
  answer: { text: string; at: number } | null
}

/**
 * A comment on a card, by the user or an agent. Only its author edits or deletes it. A deleted one stays as a tombstone
 * (text emptied), so sync, which joins comments by id, never brings it back.
 */
export interface TodoComment {
  id: string
  text: string // markdown
  by: TodoBy
  at: number
  editedAt?: number
  deletedAt?: number
  replyTo?: string // the comment it answers: always a top-level one, so a thread is one level deep
  asked?: string[] // agents the user's comment mentioned; each answers in its card-comment chat, its reply posted under this one
  routing?: true // the user's comment while the routing call picks which of the agents it names to ask; cleared as `asked` is set
}

/** On the ChatMeta of a task's chat: the board item it works on. */
export interface TodoTaskLink {
  todoId: string
}

/** What the user can change on a card. `description` '' and `files` [] remove them. */
export interface TodoEditPatch {
  text?: string
  description?: string
  files?: Attachment[]
}

export interface TodoItem {
  id: string
  text: string // the title: one line, the plain to-do
  group: string | null
  from: TodoSource
  addedBy: string
  done: { at: number; by: TodoBy } | null
  removed: { at: number; by: TodoBy } | null // a tombstone: kept for Undo and for sync
  last: { action: TodoAction; by: TodoBy; at: number }
  rev: number // the file's rev when this item last changed
  updatedAt: number
  // The card. All absent on a plain to-do, so older files and the other machine's sync read as before.
  description?: string // markdown notes
  files?: Attachment[] // under attachments/<TODO_FILES>/
  status?: TodoStatus // its column; absent = New (an item from before statuses). Done exactly when `done` is set
  assignee?: string // who does it: 'user' or an agent's name; absent = nobody (the default)
  folder?: string // where the assigned agent's chat runs; set with an agent assignee
  task?: TodoTask // the assigned agent's chat, once its card first went to To do; absent = never started
  questions?: TodoQuestion[] // asked in that chat; absent = none
  attempts?: TodoAttempts // several agents trying the card at once (review-loop.md); absent = none ever run
  pr?: TodoPr // what the board shows of the task chat's pull request; the chat's own meta is what counts
  comments?: TodoComment[] // oldest first, tombstones included; absent = none
}

/** The board's display copy of a task chat's pull request (review-loop.md). Checks are not copied: they are volatile. */
export interface TodoPr {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  chatId: string
}

/** The one board: every task, wherever it was made. */
export interface TodoFile {
  v: 1
  rev: number
  items: TodoItem[]
  seen: Record<string, number> // seenKey(chat, agent) -> the rev that agent's session in that chat last saw
}

/** What the board page reads: every open item, and the newest done ones with how many there are in all. */
export interface TodoBoard {
  rev: number
  open: TodoItem[]
  done: TodoItem[]
  doneTotal: number
}

// A session is a chat's (and in a room a member's), so what an agent has seen is kept per chat. Chat ids are UUIDs and
// agent names file names: neither holds a slash.
export const seenKey = (chatId: string, agent: string): string => `${chatId}/${agent}`
export function splitSeenKey(key: string): { chatId: string; agent: string } | null {
  const i = key.indexOf('/')
  return i <= 0 ? null : { chatId: key.slice(0, i), agent: key.slice(i + 1) }
}

/** What a turn did to the list, shown under its reply; the texts are the items' own. */
export interface TodoTouch {
  added: number
  ticked: string[]
  unticked: string[]
  removed: string[]
  asked?: string[] // questions a task's agent put on its card; absent = none
  review?: true // a task's agent said its card is ready for review; absent = not
  commented?: string[] // titles of the cards the agent commented on; absent = none
}

export const emptyTodos = (): TodoFile => ({ v: 1, rev: 0, items: [], seen: {} })

// Same boundary rule as leadingCommand and /btw: `/todos x` is another command's name.
const LEAD_TODO = new RegExp(`^/${TODO_NAME}(?=\\s|$)`)

/** `/todo` at index 0 of the untrimmed text; `rest` is what follows, trimmed. Without it `rest` is the text as given. */
export function splitTodo(text: string): { todo: boolean; rest: string } {
  const m = LEAD_TODO.exec(text)
  return m ? { todo: true, rest: text.slice(m[0].length).trim() } : { todo: false, rest: text }
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max).trim()

/** One line, at most TODO_TEXT_MAX characters. */
export function normalizeTodoText(text: string): string {
  return oneLine(text, TODO_TEXT_MAX)
}

// Lines kept (a description, a question, an answer), ends trimmed, cut at `max`.
const block = (s: string, max: number) => s.replace(/\r\n?/g, '\n').trim().slice(0, max).trim()

/** A card's notes: lines kept, at most TODO_DESC_MAX characters; '' means none. */
export function normalizeTodoDescription(text: string): string {
  return block(text, TODO_DESC_MAX)
}

/**
 * An item as read: one from before the board has no source chat (it was the user's own list), and one from the cards'
 * first shape names its owner as `mine` or by its task alone.
 */
function normalizeItem(raw: TodoItem): TodoItem {
  let i = raw
  if (i.from && i.from.chatId === undefined) i = { ...i, from: { ...i.from, chatId: null } }
  const old = i as TodoItem & { mine?: unknown }
  if (old.mine !== undefined) {
    const { mine: _m, ...rest } = old
    i = { ...rest, ...(rest.assignee === undefined && !rest.task ? { assignee: 'user' } : {}) }
  }
  if (i.task && i.assignee === undefined) i = { ...i, assignee: i.task.agent }
  return i
}

/** A stored list, or null for one that is not (bad JSON, another version): the caller sets that file aside. */
export function parseTodoFile(raw: string): TodoFile | null {
  try {
    const p = JSON.parse(raw) as Partial<TodoFile> | null
    if (p && p.v === 1 && typeof p.rev === 'number' && Array.isArray(p.items)) {
      const items = p.items.map(normalizeItem)
      return { v: 1, rev: p.rev, items, seen: p.seen && typeof p.seen === 'object' ? p.seen : {} }
    }
  } catch {
    // not a list
  }
  return null
}

export const liveTodos = (f: TodoFile): TodoItem[] => f.items.filter((i) => i.removed === null)
export const openTodos = (f: TodoFile): TodoItem[] => f.items.filter((i) => i.removed === null && i.done === null)

/** The board as the page reads it: open items in board order, the newest `doneMax` done ones (newest tick first). */
export function boardOf(f: TodoFile, doneMax = BOARD_DONE_MAX): TodoBoard {
  const live = liveTodos(f)
  const done = live.filter((i) => i.done !== null).sort((a, b) => b.done!.at - a.done!.at)
  return { rev: f.rev, open: live.filter((i) => i.done === null), done: done.slice(0, doneMax), doneTotal: done.length }
}

/** Adds the items that are not already open on the list; one rev bump per call, none if nothing was added. */
export function addTodos(
  f: TodoFile,
  input: { text: string; group?: string | null; description?: string }[],
  by: string,
  from: TodoSource,
  now: number,
  newId: () => string
): { file: TodoFile; added: TodoItem[]; skipped: string[] } {
  if (input.length > TODO_ADD_MAX) throw new Error(`At most ${TODO_ADD_MAX} items per add`)
  const open = new Set(openTodos(f).map((i) => i.text))
  const fresh: { text: string; group: string | null; description: string }[] = []
  const skipped: string[] = []
  for (const e of input) {
    const text = normalizeTodoText(e.text)
    if (text === '') continue
    if (open.has(text)) {
      skipped.push(text)
      continue
    }
    open.add(text) // a repeat inside this call is skipped too
    const group = oneLine(e.group ?? '', TODO_GROUP_MAX)
    fresh.push({ text, group: group === '' ? null : group, description: normalizeTodoDescription(e.description ?? '') })
  }
  if (fresh.length === 0) return { file: f, added: [], skipped }
  if (openTodos(f).length + fresh.length > TODO_OPEN_MAX) throw new Error(`The board has ${TODO_OPEN_MAX} open to-dos`)
  const rev = f.rev + 1
  const added = fresh.map<TodoItem>((e) => ({
    id: newId(),
    text: e.text,
    group: e.group,
    from,
    addedBy: by,
    done: null,
    removed: null,
    last: { action: 'added', by, at: now },
    rev,
    updatedAt: now,
    ...(e.description !== '' ? { description: e.description } : {})
  }))
  return { file: { ...f, rev, items: [...f.items, ...added] }, added, skipped }
}

/** Applies `edit` to the items named by `ids` that it accepts; one rev bump per call, none if nothing changed. */
function change(
  f: TodoFile,
  ids: string[],
  now: number,
  edit: (i: TodoItem) => (Pick<TodoItem, 'done' | 'removed' | 'last'> & { status?: TodoStatus }) | null
): { file: TodoFile; changed: TodoItem[] } {
  const want = new Set(ids)
  const rev = f.rev + 1
  const changed: TodoItem[] = []
  const items = f.items.map((i) => {
    if (!want.has(i.id)) return i
    const e = edit(i)
    if (e === null) return i
    const next = { ...i, ...e, rev, updatedAt: now }
    changed.push(next)
    return next
  })
  return changed.length === 0 ? { file: f, changed } : { file: { ...f, rev, items }, changed }
}

export function checkTodos(f: TodoFile, ids: string[], done: boolean, by: TodoBy, now: number) {
  return change(f, ids, now, (i) => {
    if (i.removed !== null || (i.done !== null) === done) return null
    // A tick is Done; an untick goes back to New, never to a status that would start an agent.
    return {
      done: done ? { at: now, by } : null,
      removed: null,
      status: done ? 'done' : 'new',
      last: { action: done ? 'ticked' : 'unticked', by, at: now }
    }
  })
}

export function removeTodos(f: TodoFile, ids: string[], by: TodoBy, now: number) {
  return change(f, ids, now, (i) =>
    i.removed !== null ? null : { done: i.done, removed: { at: now, by }, last: { action: 'removed', by, at: now } }
  )
}

export function restoreTodos(f: TodoFile, ids: string[], by: TodoBy, now: number) {
  return change(f, ids, now, (i) =>
    i.removed === null ? null : { done: i.done, removed: null, last: { action: 'restored', by, at: now } }
  )
}

/** What changed after `rev` that `except` did not do itself (tombstones included, so removals are told). */
export function changesSince(f: TodoFile, rev: number, except: string): TodoItem[] {
  return f.items.filter((i) => i.rev > rev && i.last.by !== except)
}

/** An agent's `tools:` list needs the to-do tools by name; no list (null) already means every tool. */
export function withTodoTools(tools: string[] | null): string[] | null {
  if (tools === null) return null
  return [...tools.filter((t) => !(TODO_TOOLS as readonly string[]).includes(t)), ...TODO_TOOLS]
}

// ---------- Task cards ----------
// A to-do is also a card: notes, files, and once given to an agent, its own chat, the agent's questions and its review.
// Edits to the title, notes and files move the rev like any change (the list's agents hear of them); the task's own
// changes (give, questions, answers, review) only restamp the item, so the list's agents are not told about another chat's work.

/** The questions of an item that wait for the user. */
export const liveComments = (i: Pick<TodoItem, 'comments'>): TodoComment[] => (i.comments ?? []).filter((c) => c.deletedAt === undefined)
export const normalizeTodoComment = (text: string): string => block(text, TODO_COMMENT_MAX)

/** A card comment's @mention sent to the agent's chat for that card: the bubble shows the comment, the agent reads it in the card's context. */
export interface CardAsk {
  todoId: string
  title: string
  /** What the agent reads before the comment, and after it. */
  before: string
  after: string
  /**
   * The comment as the user wrote it, when the message's text is the line written for this agent (commentRouting.ts): the
   * agent still reads the comment itself. Absent: the text is the comment.
   */
  comment?: string
}

/** What a card ask's message quotes: the comment as written, else the message's own text. */
export const cardAskComment = (ask: Pick<CardAsk, 'comment'>, text: string): string => ask.comment ?? text

/** The card context without the comment as written: an edited message quotes its own text. */
export const withoutComment = ({ comment: _gone, ...ask }: CardAsk): CardAsk => ask

/** Text as a markdown quote, one `> ` per line. */
export const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')

/** The message the agent reads: the card's context, the quoted comment, then the instructions. */
export const cardAskPrompt = (ask: Pick<CardAsk, 'before' | 'after'>, text: string): string =>
  `${ask.before}${quoteLines(text)}${ask.after}`

/**
 * A new comment on a card. It moves the rev with `last.action` `commented`, so every agent hears of it as of an edit
 * (the card's own task agent included, which is how a comment reaches its chat on its next turn).
 */
export function commentTodo(
  f: TodoFile,
  id: string,
  text: string,
  by: TodoBy,
  now: number,
  newId: () => string,
  o: { replyTo?: string; asked?: string[]; routing?: boolean } = {}
): { file: TodoFile; comment: TodoComment } {
  const item = liveItem(f, id)
  const body = normalizeTodoComment(text)
  if (body === '') throw new Error('Write a comment first.')
  if (liveComments(item).length >= TODO_COMMENTS_MAX) throw new Error(`A to-do holds at most ${TODO_COMMENTS_MAX} comments.`)
  const replyTo = o.replyTo === undefined ? undefined : threadRoot(item, o.replyTo)
  const asked = (o.asked ?? []).slice(0, TODO_COMMENT_ASKS_MAX)
  const comment: TodoComment = {
    id: newId(),
    text: body,
    by,
    at: now,
    ...(replyTo ? { replyTo } : {}),
    ...(asked.length > 0 ? { asked } : {}),
    ...(o.routing ? { routing: true as const } : {})
  }
  return { file: put(f, { ...item, comments: [...(item.comments ?? []), comment] }, now, { action: 'commented', by }), comment }
}

/**
 * The routing call is over: the comment asks `asked` (none: nobody). Only restamps the item, as agents already heard of the
 * comment. Null when the card or the comment went meanwhile (a deleted comment's tombstone holds no flag), so nobody is asked.
 */
export function routedComment(
  f: TodoFile,
  id: string,
  commentId: string,
  asked: string[],
  now: number
): { file: TodoFile; item: TodoItem; comment: TodoComment } | null {
  const item = f.items.find((i) => i.id === id)
  const c = item?.comments?.find((x) => x.id === commentId)
  if (!item || item.removed !== null || !c?.routing) return null
  const { routing: _done, asked: _old, ...rest } = c
  const kept = asked.slice(0, TODO_COMMENT_ASKS_MAX)
  const comment: TodoComment = { ...rest, ...(kept.length > 0 ? { asked: kept } : {}) }
  const next = { ...item, comments: item.comments!.map((x) => (x.id === commentId ? comment : x)) }
  const file = put(f, next, now)
  return { file, item: file.items.find((i) => i.id === id)!, comment }
}

/** Every comment still routing, as after a restart cut its call short: it asks nobody. The same file when none is. */
export function clearRouting(f: TodoFile, now: number): TodoFile {
  let out = f
  for (const item of f.items) {
    if (!(item.comments ?? []).some((c) => c.routing)) continue
    const comments = item.comments!.map(({ routing: _gone, ...c }) => c)
    out = put(out, { ...item, comments }, now)
  }
  return out
}

/** The top-level comment a reply goes under: a reply to a reply joins its thread. A deleted parent still holds its thread. */
function threadRoot(item: TodoItem, commentId: string): string {
  const c = (item.comments ?? []).find((x) => x.id === commentId)
  if (!c) throw new Error('That comment is gone.')
  return c.replyTo ?? c.id
}

/**
 * The agents a reply with no @mention goes to: those in the thread of `commentId`, the ones its top comment asked and
 * those who answered in it, most recent first. A reply that names an agent asks only who it names instead.
 */
export function threadAgents(item: Pick<TodoItem, 'comments'>, commentId: string): string[] {
  const all = item.comments ?? []
  const c = all.find((x) => x.id === commentId)
  if (!c) return []
  const root = c.replyTo ?? c.id
  const out: string[] = []
  const add = (name: string): void => {
    if (!out.includes(name)) out.push(name)
  }
  const thread = all.filter((x) => x.id === root || x.replyTo === root)
  for (const x of [...thread].reverse()) {
    if (x.by !== 'user' && x.deletedAt === undefined) add(x.by)
    for (const a of [...(x.asked ?? [])].reverse()) add(a)
  }
  return out
}

/** Top-level comments oldest first, each with its live replies; a deleted one stays only while it has a live reply. */
export function commentThreads(i: Pick<TodoItem, 'comments'>): { comment: TodoComment; replies: TodoComment[] }[] {
  const all = i.comments ?? []
  const replies = new Map<string, TodoComment[]>()
  for (const c of all) {
    if (c.replyTo === undefined || c.deletedAt !== undefined) continue
    replies.set(c.replyTo, [...(replies.get(c.replyTo) ?? []), c])
  }
  return all
    .filter((c) => c.replyTo === undefined && (c.deletedAt === undefined || replies.has(c.id)))
    .map((c) => ({ comment: c, replies: replies.get(c.id) ?? [] }))
}

const ownComment = (item: TodoItem, commentId: string, by: TodoBy): TodoComment => {
  const c = (item.comments ?? []).find((x) => x.id === commentId)
  if (!c || c.deletedAt !== undefined) throw new Error('This comment was deleted.')
  if (c.by !== by) throw new Error('Only its author can change a comment.')
  return c
}

/** Its author's edit of a comment; the same text changes nothing. Heard by agents as a new comment is. */
export function editComment(f: TodoFile, id: string, commentId: string, text: string, by: TodoBy, now: number): { file: TodoFile } {
  const item = liveItem(f, id)
  const c = ownComment(item, commentId, by)
  const body = normalizeTodoComment(text)
  if (body === '') throw new Error('A comment needs text. Delete it instead.')
  if (body === c.text) return { file: f }
  const comments = (item.comments ?? []).map((x) => (x.id === commentId ? { ...x, text: body, editedAt: now } : x))
  return { file: put(f, { ...item, comments }, now, { action: 'commented', by }) }
}

/** Its author deletes a comment: a tombstone, so sync keeps it deleted. Nobody is told: there is nothing to read. */
export function deleteComment(f: TodoFile, id: string, commentId: string, by: TodoBy, now: number): { file: TodoFile } {
  const item = liveItem(f, id)
  ownComment(item, commentId, by)
  const comments = (item.comments ?? []).map((x) =>
    x.id === commentId ? { id: x.id, text: '', by: x.by, at: x.at, deletedAt: now, ...(x.replyTo ? { replyTo: x.replyTo } : {}) } : x
  )
  return { file: put(f, { ...item, comments }, now) }
}

/** The comments of both machines' copies of one card, joined by id; the later change of each wins, a tombstone always. */
export function mergeComments(a: readonly TodoComment[] | undefined, b: readonly TodoComment[] | undefined): TodoComment[] | undefined {
  if (!a && !b) return undefined
  const stamp = (c: TodoComment) => (c.deletedAt !== undefined ? Infinity : (c.editedAt ?? c.at))
  const byId = new Map((a ?? []).map((c) => [c.id, c]))
  for (const c of b ?? []) {
    const cur = byId.get(c.id)
    if (!cur || stamp(c) > stamp(cur)) byId.set(c.id, c)
  }
  return [...byId.values()].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id))
}

export const unanswered = (i: TodoItem): TodoQuestion[] => (i.questions ?? []).filter((q) => q.answer === null)

const liveItem = (f: TodoFile, id: string): TodoItem => {
  const item = f.items.find((i) => i.id === id)
  if (!item || item.removed !== null) throw new Error('This to-do was removed.')
  return item
}

/** Replaces one item; `rev` moves only when `bump` names the change (an edit), else the item is only restamped. */
function put(f: TodoFile, next: TodoItem, now: number, bump?: { action: TodoAction; by: TodoBy }): TodoFile {
  if (!bump) return { ...f, items: f.items.map((i) => (i.id === next.id ? { ...next, updatedAt: now } : i)) }
  const rev = f.rev + 1
  const item = { ...next, last: { action: bump.action, by: bump.by, at: now }, rev, updatedAt: now }
  return { ...f, rev, items: f.items.map((i) => (i.id === next.id ? item : i)) }
}

const sameFiles = (a: Attachment[] | undefined, b: Attachment[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/** The user's edit of a card's title, notes or files; nothing changed adds no rev. */
export function editTodo(f: TodoFile, id: string, patch: TodoEditPatch, by: TodoBy, now: number): { file: TodoFile; changed: TodoItem[] } {
  const item = liveItem(f, id)
  const next: TodoItem = { ...item }
  if (patch.text !== undefined) {
    const text = normalizeTodoText(patch.text)
    if (text === '') throw new Error('A to-do needs a title.')
    next.text = text
  }
  if (patch.description !== undefined) {
    const d = normalizeTodoDescription(patch.description)
    if (d === '') delete next.description
    else next.description = d
  }
  if (patch.files !== undefined) {
    if (patch.files.length > TODO_FILES_MAX) throw new Error(`A to-do holds at most ${TODO_FILES_MAX} files.`)
    if (patch.files.length === 0) delete next.files
    else next.files = patch.files
  }
  if (next.text === item.text && next.description === item.description && sameFiles(next.files, item.files)) return { file: f, changed: [] }
  const file = put(f, next, now, { action: 'edited', by })
  return { file, changed: [file.items.find((i) => i.id === id)!] }
}

// ---------- Statuses, assignees and the agent's chat ----------

/**
 * A card's column. New: nobody works on it yet (an assigned agent waits). To do: it should be worked on now (an agent
 * starts at once). Blocked: it waits on the user's answers. In progress: being worked on. In review: the agent's turn
 * ended and the user checks it. Done: ticked.
 */
export type TodoStatus = 'new' | 'todo' | 'blocked' | 'progress' | 'review' | 'done'
export const TODO_STATUSES: readonly TodoStatus[] = ['new', 'todo', 'blocked', 'progress', 'review', 'done']
export const isTodoStatus = (v: unknown): v is TodoStatus => TODO_STATUSES.includes(v as TodoStatus)

/** The status an item reads as: Done exactly while ticked; one from before statuses is New. */
export function statusOf(i: TodoItem): TodoStatus {
  if (i.done !== null) return 'done'
  return i.status && i.status !== 'done' ? i.status : 'new'
}

/** Whether the assignee is an agent (its name), not the user or nobody. */
export const agentAssignee = (i: TodoItem): string | null => (i.assignee && i.assignee !== 'user' ? i.assignee : null)

/**
 * Who does the card: the user, an agent (with the folder its chat runs in), or nobody. Another agent drops the old
 * agent's chat link and questions (the chat stays), and a card that waited on that agent (Blocked, In review) goes back
 * to New. Assigning starts nothing: To do does.
 */
export function assignTodo(
  f: TodoFile,
  id: string,
  assignee: string | null,
  folder: string | null,
  now: number
): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  const agent = assignee !== null && assignee !== 'user'
  if (agent && !folder) throw new Error('Pick the folder its chat runs in.')
  const next: TodoItem = { ...item }
  if (assignee === null) delete next.assignee
  else next.assignee = assignee
  if (agent) next.folder = folder!
  else delete next.folder
  if (next.task && next.task.agent !== assignee) {
    delete next.task
    delete next.questions
    const s = statusOf(item)
    if (s === 'blocked' || s === 'review') next.status = 'new'
  }
  if (JSON.stringify(next) === JSON.stringify(item)) return { file: f, item }
  const file = put(f, next, now)
  return { file, item: file.items.find((i) => i.id === id)! }
}

/** A card moved by hand. Done ticks it; out of Done unticks it first (a rev bump, as a tick is told); the rest restamp. */
export function setStatus(f: TodoFile, id: string, status: TodoStatus, by: TodoBy, now: number): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  let file = f
  if (status === 'done') file = checkTodos(f, [id], true, by, now).file
  else {
    if (item.done !== null) file = checkTodos(file, [id], false, by, now).file
    const cur = file.items.find((i) => i.id === id)!
    if (statusOf(cur) !== status) file = put(file, { ...cur, status }, now)
  }
  return { file, item: file.items.find((i) => i.id === id)! }
}

/** The assigned agent's chat was made: the card links to it, To do, with no questions from an earlier chat. */
export function startTask(f: TodoFile, id: string, task: Omit<TodoTask, 'review'>, now: number): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  if (item.done !== null) throw new Error('This to-do is done. Move it out of Done first.')
  if (agentAssignee(item) !== task.agent) throw new Error('This to-do is not assigned to that agent.')
  const { questions: _dropped, ...rest } = item
  const file = put(f, { ...rest, status: 'todo', task: { ...task, review: null } }, now)
  return { file, item: file.items.find((i) => i.id === id)! }
}

/** The card a task's chat works on, or a sentence the agent can act on. */
function taskOf(f: TodoFile, id: string, chatId: string): TodoItem & { task: TodoTask } {
  const item = f.items.find((i) => i.id === id)
  if (!item || item.removed !== null) throw new Error('The user removed this task card. Say so in your reply.')
  if (item.assignee === 'user') throw new Error('The user took this task card over. Say what is left in your reply.')
  if (!item.task || item.task.chatId !== chatId)
    throw new Error('This chat no longer works on that task card: it was given to another chat.')
  if (item.done !== null) throw new Error('The user already ticked this task done. Say what is left in your reply.')
  return item as TodoItem & { task: TodoTask }
}

export interface TodoAsk {
  text: string
  options?: string[]
}

/** The task agent's questions, added to its card, which is Blocked until the next turn starts. They end a review. */
export function askTodo(
  f: TodoFile,
  id: string,
  chatId: string,
  by: string,
  input: TodoAsk[],
  now: number,
  newId: () => string
): { file: TodoFile; asked: TodoQuestion[] } {
  const item = taskOf(f, id, chatId)
  if (input.length > TODO_ASK_MAX) throw new Error(`Ask at most ${TODO_ASK_MAX} questions at a time.`)
  const asked = input
    .map((q) => ({
      text: block(q.text, TODO_QUESTION_MAX),
      options: (q.options ?? [])
        .map((o) => oneLine(o, TODO_OPTION_MAX))
        .filter((o) => o !== '')
        .slice(0, TODO_OPTIONS_MAX)
    }))
    .filter((q) => q.text !== '')
    .map<TodoQuestion>((q) => ({ id: newId(), text: q.text, options: q.options, by, at: now, answer: null }))
  if (asked.length === 0) throw new Error('Write at least one question.')
  const before = item.questions ?? []
  if (before.length + asked.length > TODO_QUESTIONS_MAX) throw new Error('This card has too many questions. Ask in your reply instead.')
  const file = put(f, { ...item, status: 'blocked', task: { ...item.task, review: null }, questions: [...before, ...asked] }, now)
  return { file, asked }
}

/** The user's answers to questions still open; one answered at least, or it throws. */
export function answerTodo(
  f: TodoFile,
  id: string,
  answers: { id: string; text: string }[],
  now: number
): { file: TodoFile; item: TodoItem; answered: TodoQuestion[] } {
  const item = liveItem(f, id)
  if (!item.task) throw new Error('No agent has worked on this to-do yet.')
  const by = new Map(answers.map((a) => [a.id, block(a.text, TODO_ANSWER_MAX)]))
  const answered: TodoQuestion[] = []
  const questions = (item.questions ?? []).map((q) => {
    const text = by.get(q.id)
    if (q.answer !== null || text === undefined || text === '') return q
    const next = { ...q, answer: { text, at: now } }
    answered.push(next)
    return next
  })
  if (answered.length === 0) throw new Error('Write an answer first.')
  const file = put(f, { ...item, questions }, now)
  return { file, item: file.items.find((i) => i.id === id)!, answered }
}

/** The task agent says the work is done: In review, with its summary; the user ticks it or writes back. */
export function reviewTodo(f: TodoFile, id: string, chatId: string, summary: string, now: number): { file: TodoFile } {
  const item = taskOf(f, id, chatId)
  const text = block(summary, TODO_REVIEW_MAX)
  return { file: put(f, { ...item, status: 'review', task: { ...item.task, review: { at: now, summary: text } } }, now) }
}

/** A message from the card goes back to the agent: the review summary is over (its turn moves the card on). */
export function reopenTodo(f: TodoFile, id: string, now: number): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  if (!item.task) throw new Error('No agent has worked on this to-do yet.')
  if (item.task.review === null) return { file: f, item }
  const file = put(f, { ...item, task: { ...item.task, review: null } }, now)
  return { file, item: file.items.find((i) => i.id === id)! }
}

/** The card a task chat works on, if it still does (live, its task naming that chat). */
const cardOfChat = (f: TodoFile, chatId: string): TodoItem | undefined =>
  f.items.find((i) => i.removed === null && i.task?.chatId === chatId && agentAssignee(i) === i.task.agent)

/** A turn started in a task's chat: the card is In progress (a ticked one stays Done). */
export function taskTurnStarted(f: TodoFile, chatId: string, now: number): { file: TodoFile } {
  const item = cardOfChat(f, chatId)
  if (!item || item.done !== null || statusOf(item) === 'progress') return { file: f }
  return { file: put(f, { ...item, status: 'progress' }, now) }
}

/**
 * A turn ended in a task's chat. Questions still open: Blocked. A reply (with a review or without): In review. Stopped
 * or failed: New, until the user moves it to To do again. A ticked one stays Done.
 */
export function taskTurnEnded(f: TodoFile, chatId: string, outcome: 'ok' | 'error' | 'stopped', now: number): { file: TodoFile } {
  const item = cardOfChat(f, chatId)
  if (!item || item.done !== null) return { file: f }
  const status: TodoStatus = unanswered(item).length > 0 ? 'blocked' : outcome === 'ok' ? 'review' : 'new'
  if (statusOf(item) === status) return { file: f }
  return { file: put(f, { ...item, status }, now) }
}

// ---------- Parallel attempts ----------
// A set is the card's own record of several agents trying it at once. Like the task's changes, these restamp the item
// without a rev bump: another chat's work is not news to the board's agents.

export const ATTEMPTS_MIN = 2
export const ATTEMPTS_MAX = 5

/** Whether a set still has attempts the user has not decided between. */
export const attemptsRunning = (i: TodoItem): boolean => i.attempts !== undefined && i.attempts.winner === undefined

/** The set's attempt a chat is, if it is one. */
export const attemptOf = (i: TodoItem, chatId: string): TodoAttempt | undefined => i.attempts?.attempts.find((a) => a.chatId === chatId)

/** The card takes a set of attempts: In progress, with no single task chat (nothing but the user moves it from here). */
export function startAttempts(f: TodoFile, id: string, set: TodoAttempts, now: number): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  if (item.done !== null) throw new Error('This to-do is done. Move it out of Done first.')
  if (item.task) throw new Error('An agent is already working on this card in its own chat.')
  if (attemptsRunning(item)) throw new Error('This card already has attempts running. Keep one or cancel them first.')
  if (set.attempts.length === 0) throw new Error('No attempt could be started.')
  const file = put(f, { ...item, status: 'progress', attempts: set }, now)
  return { file, item: file.items.find((i) => i.id === id)! }
}

/**
 * The user keeps one attempt: the card goes to that agent, its chat becomes the card's task chat, and the card is In
 * review. The other chats are the caller's to archive.
 */
export function keepAttempt(
  f: TodoFile,
  id: string,
  chatId: string,
  now: number
): { file: TodoFile; item: TodoItem; kept: TodoAttempt; others: TodoAttempt[] } {
  const item = liveItem(f, id)
  const set = item.attempts
  if (!set) throw new Error('This card has no attempts.')
  if (set.winner !== undefined) throw new Error('One attempt was already kept.')
  const kept = set.attempts.find((a) => a.chatId === chatId)
  if (!kept) throw new Error("That chat is not one of this card's attempts.")
  const next: TodoItem = {
    ...item,
    assignee: kept.agent,
    folder: set.folder,
    status: 'review',
    task: { agent: kept.agent, chatId: kept.chatId, at: now, review: item.task?.review ?? null },
    attempts: { ...set, winner: chatId }
  }
  delete next.questions // the other chats' questions are not this one's
  const file = put(f, next, now)
  return { file, item: file.items.find((i) => i.id === id)!, kept, others: set.attempts.filter((a) => a.chatId !== chatId) }
}

/** The user drops a set without keeping one: back to New, the chats left alone. */
export function dropAttempts(f: TodoFile, id: string, now: number): { file: TodoFile; item: TodoItem; dropped: TodoAttempt[] } {
  const item = liveItem(f, id)
  const set = item.attempts
  if (!set || set.winner !== undefined) throw new Error('This card has no attempts running.')
  const { attempts: _gone, ...rest } = item
  const file = put(f, { ...rest, status: 'new' }, now)
  return { file, item: file.items.find((i) => i.id === id)!, dropped: set.attempts }
}

/**
 * The board's copy of the task chat's pull request. A restamp, never a rev bump: the board's agents are not told about
 * another chat's work, and the chat's own meta stays what counts.
 */
export function setCardPr(f: TodoFile, id: string, pr: TodoPr | null, now: number): { file: TodoFile; item: TodoItem } {
  const item = liveItem(f, id)
  // Only the card's own task chat may write it, so a chat that lost the card cannot overwrite the winner's.
  if (pr && item.task?.chatId !== pr.chatId) throw new Error('That chat does not work on this card.')
  const next: TodoItem = { ...item }
  if (pr === null) delete next.pr
  else next.pr = pr
  if (JSON.stringify(next.pr) === JSON.stringify(item.pr)) return { file: f, item }
  const file = put(f, next, now)
  return { file, item: file.items.find((i) => i.id === id)! }
}

/** The open cards whose agent waits on an answer, oldest question first (the Inbox's). */
export function askingOf(items: readonly TodoItem[]): TodoItem[] {
  return items
    .filter((i) => i.removed === null && i.done === null && i.task && askedSince(i) !== null)
    .sort((a, b) => askedSince(a)! - askedSince(b)!)
}

/** When the oldest open question of a card was asked, or null when none waits. */
export function askedSince(i: TodoItem): number | null {
  const open = unanswered(i)
  return open.length === 0 ? null : Math.min(...open.map((q) => q.at))
}

/** What the agent's chat is doing, beside the status: running, waiting on approval cards, or deleted. */
export type TaskState = 'working' | 'approval' | 'gone'
export function taskState(i: TodoItem, o: { running: boolean; cards: number; chatGone: boolean }): TaskState | null {
  if (!i.task || i.done !== null || agentAssignee(i) !== i.task.agent) return null
  if (o.chatGone) return 'gone'
  if (o.cards > 0) return 'approval'
  return o.running ? 'working' : null
}

/**
 * The column a card shows in: its status, except that a card whose agent waits on approval cards shows as Blocked, and
 * one whose agent's chat was deleted mid-work goes back to New (nothing works on it any more).
 */
export function boardColumn(i: TodoItem, o: { running: boolean; cards: number; chatGone: boolean }): TodoStatus {
  const s = statusOf(i)
  const state = taskState(i, o)
  if (state === 'gone' && s !== 'new') return 'new'
  if (state === 'approval' && (s === 'progress' || s === 'todo')) return 'blocked'
  return s
}
