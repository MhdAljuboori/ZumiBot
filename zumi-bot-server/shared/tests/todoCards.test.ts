import { describe, expect, it } from 'vitest'
import {
  TODO_ASK_MAX,
  TODO_FILES_MAX,
  addTodos,
  answerTodo,
  askTodo,
  askedSince,
  askingOf,
  assignTodo,
  boardColumn,
  changesSince,
  checkTodos,
  clearRouting,
  commentTodo,
  deleteComment,
  editComment,
  liveComments,
  mergeComments,
  editTodo,
  emptyTodos,
  parseTodoFile,
  removeTodos,
  reopenTodo,
  reviewTodo,
  routedComment,
  seenKey,
  setStatus,
  splitSeenKey,
  startTask,
  statusOf,
  taskState,
  taskTurnEnded,
  taskTurnStarted,
  unanswered,
  type TodoFile
} from '@zumibot/shared/todos'
import type { Attachment } from '@zumibot/shared/types'

const from = { chatId: null, turn: 'user', itemId: null, label: 'Added by you', at: 1 }
let n = 0
const newId = () => `id${++n}`
const one = (text = 'Fix the login page'): TodoFile => addTodos(emptyTodos(), [{ text }], 'user', from, 5, newId).file
const img = (id: string): Attachment => ({ id, name: `${id}.png`, mime: 'image/png', size: 10, kind: 'image' })
// Assigned to Builder in /w and started: the chat chat-b works on it, In progress.
const started = (f: TodoFile = one(), chatId = 'chat-b'): TodoFile => {
  const id = f.items[0]!.id
  const a = assignTodo(f, id, 'Builder', '/w', 10).file
  const s = startTask(a, id, { agent: 'Builder', chatId, at: 11 }, 11).file
  return taskTurnStarted(s, chatId, 12).file
}
const quiet = { running: false, cards: 0, chatGone: false }

describe('editTodo', () => {
  it('changes the title, notes and files, moving the rev once', () => {
    const f = one()
    const id = f.items[0]!.id
    const r = editTodo(f, id, { text: '  Fix\nlogin  ', description: '\n Steps:\n1. open\n', files: [img('a')] }, 'user', 9)
    const item = r.file.items[0]!
    expect(item).toMatchObject({ text: 'Fix login', description: 'Steps:\n1. open', files: [img('a')], rev: f.rev + 1, updatedAt: 9 })
    expect(item.last).toEqual({ action: 'edited', by: 'user', at: 9 })
    expect(r.file.rev).toBe(f.rev + 1)
    // The list's agents hear of an edit like a tick.
    expect(changesSince(r.file, f.rev, 'Work').map((i) => i.text)).toEqual(['Fix login'])
  })

  it('removes empty notes and files, and changes nothing for the same values', () => {
    const start = one()
    const id = start.items[0]!.id
    const f = editTodo(start, id, { description: 'x', files: [img('a')] }, 'user', 9).file
    const cleared = editTodo(f, id, { description: '  ', files: [] }, 'user', 10).file.items[0]!
    expect('description' in cleared).toBe(false)
    expect('files' in cleared).toBe(false)
    const same = editTodo(f, id, { text: f.items[0]!.text, description: 'x', files: [img('a')] }, 'user', 11)
    expect(same.file).toBe(f)
    expect(same.changed).toEqual([])
  })

  it('refuses an empty title, too many files and a removed item', () => {
    const f = one()
    const id = f.items[0]!.id
    expect(() => editTodo(f, id, { text: ' ' }, 'user', 9)).toThrow('needs a title')
    expect(() => editTodo(f, id, { files: Array.from({ length: TODO_FILES_MAX + 1 }, (_, i) => img(`f${i}`)) }, 'user', 9)).toThrow(
      'at most'
    )
    const gone = removeTodos(f, [id], 'user', 9).file
    expect(() => editTodo(gone, id, { text: 'x' }, 'user', 10)).toThrow('removed')
  })
})

describe('addTodos with notes', () => {
  it('keeps an agent description, trimmed', () => {
    const f = addTodos(
      emptyTodos(),
      [{ text: 'Check PR', description: ' look at tests \n' }, { text: 'Plain' }],
      'Work',
      from,
      5,
      newId
    ).file
    expect(f.items.map((i) => i.description)).toEqual(['look at tests', undefined])
    expect('description' in f.items[1]!).toBe(false)
  })
})

describe('status and assignee', () => {
  it('a new card is New with nobody assigned; a tick is Done and an untick goes back to New', () => {
    const f = one()
    const id = f.items[0]!.id
    expect([statusOf(f.items[0]!), f.items[0]!.assignee]).toEqual(['new', undefined])
    const done = checkTodos(f, [id], true, 'user', 6).file
    expect(statusOf(done.items[0]!)).toBe('done')
    expect(statusOf(checkTodos(done, [id], false, 'user', 7).file.items[0]!)).toBe('new')
  })

  it('setStatus moves by hand: Done ticks with a rev, out of Done unticks first, the rest restamp only', () => {
    const f = one()
    const id = f.items[0]!.id
    const todo = setStatus(f, id, 'todo', 'user', 6)
    expect([todo.item.status, todo.file.rev]).toEqual(['todo', f.rev])
    const done = setStatus(todo.file, id, 'done', 'user', 7).file
    expect([statusOf(done.items[0]!), done.rev]).toEqual(['done', f.rev + 1])
    const review = setStatus(done, id, 'review', 'user', 8)
    expect([review.item.done, review.item.status, review.file.rev]).toEqual([null, 'review', f.rev + 2])
    expect(setStatus(todo.file, id, 'todo', 'user', 9).file).toBe(todo.file)
    expect(() => setStatus(f, 'nope', 'todo', 'user', 9)).toThrow('removed')
  })

  it('assigns the user, an agent with its folder, or nobody; another agent drops the old chat and a wait on it', () => {
    const f = one()
    const id = f.items[0]!.id
    expect(assignTodo(f, id, 'user', null, 6).item).toMatchObject({ assignee: 'user' })
    expect(() => assignTodo(f, id, 'Builder', null, 6)).toThrow('Pick the folder')
    const agent = assignTodo(f, id, 'Builder', '/w', 6)
    expect([agent.item.assignee, agent.item.folder, agent.item.status, agent.file.rev]).toEqual(['Builder', '/w', undefined, f.rev])
    let s = started(f)
    s = reviewTodo(s, id, 'chat-b', 'done', 13).file
    const other = assignTodo(s, id, 'Writer', '/x', 14).item
    expect(['task' in other, other.status, other.assignee]).toEqual([false, 'new', 'Writer'])
    const nobody = assignTodo(s, id, null, null, 14).item
    expect(['assignee' in nobody, 'folder' in nobody, 'task' in nobody]).toEqual([false, false, false])
    expect(assignTodo(agent.file, id, 'Builder', '/w', 15).file).toBe(agent.file)
  })

  it('starts the assigned agent only: its chat linked, To do, old questions gone', () => {
    const base = one()
    const f = assignTodo(base, base.items[0]!.id, 'Builder', '/w', 6).file
    const card = f.items[0]!
    expect(() => startTask(f, card.id, { agent: 'Writer', chatId: 'c', at: 7 }, 7)).toThrow('not assigned to that agent')
    const s = startTask(f, card.id, { agent: 'Builder', chatId: 'c', at: 7 }, 7).item
    expect([s.status, s.task]).toEqual(['todo', { agent: 'Builder', chatId: 'c', at: 7, review: null }])
    expect(() => startTask(checkTodos(f, [card.id], true, 'user', 8).file, card.id, { agent: 'Builder', chatId: 'c', at: 9 }, 9)).toThrow(
      'Move it out of Done'
    )
  })
})

describe("the agent's turns move the card", () => {
  it('a turn start is In progress; its end is Blocked with open questions, In review after a reply, New when stopped or failed', () => {
    let f = started()
    const id = f.items[0]!.id
    expect(statusOf(f.items[0]!)).toBe('progress')
    expect(statusOf(taskTurnEnded(f, 'chat-b', 'ok', 20).file.items[0]!)).toBe('review')
    expect(statusOf(taskTurnEnded(f, 'chat-b', 'stopped', 20).file.items[0]!)).toBe('new')
    expect(statusOf(taskTurnEnded(f, 'chat-b', 'error', 20).file.items[0]!)).toBe('new')
    f = askTodo(f, id, 'chat-b', 'Builder', [{ text: 'A?' }], 21, newId).file
    expect(statusOf(f.items[0]!)).toBe('blocked') // at once, not only at the turn's end
    expect(statusOf(taskTurnEnded(f, 'chat-b', 'ok', 22).file.items[0]!)).toBe('blocked')
    // Another chat, or a ticked card, is left alone.
    expect(taskTurnStarted(f, 'other', 23).file).toBe(f)
    const ticked = checkTodos(f, [id], true, 'user', 24).file
    expect(taskTurnEnded(ticked, 'chat-b', 'ok', 25).file).toBe(ticked)
    expect(taskTurnStarted(ticked, 'chat-b', 25).file).toBe(ticked)
  })

  it('ready_for_review is In review at once, with its summary; a question ends the review', () => {
    let f = started()
    const id = f.items[0]!.id
    f = reviewTodo(f, id, 'chat-b', 'Done: see PR', 30).file
    expect([statusOf(f.items[0]!), f.items[0]!.task?.review]).toEqual(['review', { at: 30, summary: 'Done: see PR' }])
    const r = askTodo(
      f,
      id,
      'chat-b',
      'Builder',
      [{ text: ' Which DB? ', options: [' Postgres ', '', 'SQLite'] }, { text: '   ' }],
      31,
      newId
    )
    expect(r.asked).toEqual([
      { id: expect.any(String), text: 'Which DB?', options: ['Postgres', 'SQLite'], by: 'Builder', at: 31, answer: null }
    ])
    expect(r.file.items[0]!.task?.review).toBeNull()
    expect(() => askTodo(f, id, 'chat-x', 'Builder', [{ text: 'q' }], 32, newId)).toThrow('given to another chat')
    expect(() => askTodo(f, id, 'chat-b', 'Builder', [{ text: ' ' }], 32, newId)).toThrow('at least one')
    expect(() =>
      askTodo(
        f,
        id,
        'chat-b',
        'Builder',
        Array.from({ length: TODO_ASK_MAX + 1 }, () => ({ text: 'q' })),
        32,
        newId
      )
    ).toThrow('at most')
  })

  it('tells the agent when the card was removed, ticked, taken by the user, or given to another agent', () => {
    const f = started()
    const id = f.items[0]!.id
    expect(() => askTodo(removeTodos(f, [id], 'user', 40).file, id, 'chat-b', 'B', [{ text: 'q' }], 41, newId)).toThrow('removed')
    expect(() => reviewTodo(checkTodos(f, [id], true, 'user', 40).file, id, 'chat-b', 's', 41)).toThrow('ticked this task done')
    expect(() => askTodo(assignTodo(f, id, 'user', null, 40).file, id, 'chat-b', 'B', [{ text: 'q' }], 41, newId)).toThrow(
      'took this task card over'
    )
    // Given to another agent: its chat no longer moves the card.
    const other = assignTodo(f, id, 'Writer', '/x', 40).file
    expect(taskTurnEnded(other, 'chat-b', 'ok', 41).file).toBe(other)
  })

  it('stores the answers it was given, once each; a message from the card ends a review', () => {
    let f = started()
    const id = f.items[0]!.id
    const asked = askTodo(f, id, 'chat-b', 'Builder', [{ text: 'A?' }, { text: 'B?' }], 31, newId)
    f = asked.file
    const [qa, qb] = asked.asked
    const r = answerTodo(
      f,
      id,
      [
        { id: qa!.id, text: ' yes ' },
        { id: qb!.id, text: '  ' }
      ],
      40
    )
    expect(r.answered.map((q) => [q.text, q.answer])).toEqual([['A?', { text: 'yes', at: 40 }]])
    expect(unanswered(r.item).map((q) => q.text)).toEqual(['B?'])
    expect(() => answerTodo(r.file, id, [{ id: qa!.id, text: 'no' }], 41)).toThrow('Write an answer')
    expect(() => answerTodo(one(), one().items[0]!.id, [], 41)).toThrow()
    const s = started()
    const sid = s.items[0]!.id
    const reviewed = reviewTodo(s, sid, 'chat-b', 's', 30).file
    expect(reopenTodo(reviewed, sid, 31).item.task?.review).toBeNull()
    expect(reopenTodo(s, sid, 31).file).toBe(s)
  })
})

describe('the board columns', () => {
  it('shows the status, Blocked while the agent waits on approval cards, New once its chat is gone', () => {
    const f = started()
    const card = f.items[0]!
    expect(boardColumn(card, quiet)).toBe('progress')
    expect(boardColumn(card, { ...quiet, cards: 1 })).toBe('blocked')
    expect(boardColumn(card, { ...quiet, chatGone: true })).toBe('new')
    expect(taskState(card, { ...quiet, running: true })).toBe('working')
    expect(taskState(card, { ...quiet, cards: 2 })).toBe('approval')
    expect(taskState(one().items[0]!, quiet)).toBeNull()
    expect(boardColumn(checkTodos(f, [card.id], true, 'user', 50).file.items[0]!, { ...quiet, chatGone: true })).toBe('done')
  })
})

describe('askingOf', () => {
  it('lists open cards with an open question, oldest question first', () => {
    let f = addTodos(emptyTodos(), [{ text: 'one' }, { text: 'two' }, { text: 'three' }], 'user', from, 5, newId).file
    const [a, b, c] = f.items.map((i) => i.id)
    for (const [id, chat] of [
      [a, 'ca'],
      [b, 'cb'],
      [c, 'cc']
    ] as const) {
      f = assignTodo(f, id!, 'B', '/w', 6).file
      f = startTask(f, id!, { agent: 'B', chatId: chat, at: 6 }, 6).file
    }
    f = askTodo(f, b!, 'cb', 'B', [{ text: 'later' }], 20, newId).file
    f = askTodo(f, a!, 'ca', 'B', [{ text: 'sooner' }], 10, newId).file
    expect(askingOf(f.items).map((i) => i.text)).toEqual(['one', 'two'])
    expect(askedSince(f.items[0]!)).toBe(10)
    expect(askedSince(f.items[2]!)).toBeNull()
    expect(askingOf(checkTodos(f, [a!], true, 'user', 30).file.items).map((i) => i.text)).toEqual(['two'])
  })
})

describe('old files', () => {
  it('keys what an agent saw by its chat, and reads older items as made on the board and owned as before', () => {
    expect(seenKey('c1', 'news')).toBe('c1/news')
    expect(splitSeenKey('c1/news')).toEqual({ chatId: 'c1', agent: 'news' })
    expect(splitSeenKey('news')).toBeNull()
    const base = one().items[0]!
    const raw = JSON.stringify({
      v: 1,
      rev: 1,
      seen: {},
      items: [
        { ...base, id: 'a', from: { turn: 'user', itemId: null, label: 'Added by you', at: 1 } },
        { ...base, id: 'b', mine: { at: 2 } },
        { ...base, id: 'c', task: { agent: 'Builder', chatId: 'x', at: 3, review: null } }
      ]
    })
    const items = parseTodoFile(raw)!.items
    expect(items[0]!.from.chatId).toBeNull()
    expect([items[1]!.assignee, 'mine' in items[1]!]).toEqual(['user', false])
    expect(items[2]!.assignee).toBe('Builder')
    expect(statusOf(items[0]!)).toBe('new')
  })
})

describe('comments', () => {
  let n = 0
  const nid = () => `c${++n}`
  const board = (): { f: TodoFile; id: string } => {
    const f = addTodos(
      emptyTodos(),
      [{ text: 'Ship it' }],
      'user',
      { chatId: null, turn: 'user', itemId: null, label: '', at: 1 },
      1,
      () => 'i1'
    ).file
    return { f, id: 'i1' }
  }

  it('adds a comment that agents hear of as a change, by its author', () => {
    const { f, id } = board()
    const r = commentTodo(f, id, '  Looks good  ', 'user', 5, nid)
    const item = r.file.items[0]
    expect(r.comment).toMatchObject({ text: 'Looks good', by: 'user', at: 5 })
    expect(item.last).toEqual({ action: 'commented', by: 'user', at: 5 })
    expect(r.file.rev).toBe(f.rev + 1)
    expect(changesSince(r.file, f.rev, 'dev').map((i) => i.id)).toEqual([id])
    expect(changesSince(r.file, f.rev, 'user')).toEqual([])
    expect(() => commentTodo(f, id, '   ', 'user', 5, nid)).toThrow('Write a comment first.')
  })

  it('lets only the author edit or delete, and keeps a deleted one as a tombstone', () => {
    const { f, id } = board()
    const one = commentTodo(f, id, 'First', 'user', 5, nid)
    const two = commentTodo(one.file, id, 'From the agent', 'dev', 6, nid)
    const cid = one.comment.id
    expect(() => editComment(two.file, id, two.comment.id, 'mine now', 'user', 7)).toThrow('Only its author')
    const edited = editComment(two.file, id, cid, 'First, fixed', 'user', 7).file
    expect(edited.items[0].comments![0]).toMatchObject({ text: 'First, fixed', editedAt: 7 })
    expect(editComment(edited, id, cid, 'First, fixed', 'user', 8).file).toBe(edited) // same text: no change
    const gone = deleteComment(edited, id, cid, 'user', 9).file
    expect(gone.rev).toBe(edited.rev) // nothing for an agent to read
    expect(gone.items[0].comments![0]).toEqual({ id: cid, text: '', by: 'user', at: 5, deletedAt: 9 })
    expect(liveComments(gone.items[0]).map((c) => c.text)).toEqual(['From the agent'])
    expect(() => deleteComment(gone, id, cid, 'user', 10)).toThrow('This comment was deleted.')
  })

  it('fills in who a routing comment asks, restamping the card only, and asks nobody for one deleted meanwhile', () => {
    const { f, id } = board()
    const posted = commentTodo(f, id, '@a and @b look', 'user', 5, nid, { routing: true })
    expect(posted.comment).toMatchObject({ routing: true })
    expect(posted.comment).not.toHaveProperty('asked')
    const r = routedComment(posted.file, id, posted.comment.id, ['b'], 7)!
    expect(r.comment).toEqual({ id: posted.comment.id, text: '@a and @b look', by: 'user', at: 5, asked: ['b'] })
    expect(r.item.comments![0]).toEqual(r.comment)
    expect(r.file.rev).toBe(posted.file.rev) // agents heard of the comment when it was posted
    expect(r.item.updatedAt).toBe(7)
    expect(routedComment(r.file, id, posted.comment.id, ['a'], 8)).toBeNull() // routed once only
    expect(routedComment(posted.file, id, posted.comment.id, [], 7)!.comment).not.toHaveProperty('asked')
    const gone = deleteComment(posted.file, id, posted.comment.id, 'user', 6).file
    expect(gone.items[0].comments![0]).not.toHaveProperty('routing')
    expect(routedComment(gone, id, posted.comment.id, ['b'], 7)).toBeNull()
  })

  it('clears every routing flag at start, and leaves a board with none as it is', () => {
    const { f, id } = board()
    const a = commentTodo(f, id, '@a look', 'user', 5, nid, { routing: true })
    const b = commentTodo(a.file, id, 'plain', 'user', 6, nid)
    const cleared = clearRouting(b.file, 9)
    expect(cleared.items[0].comments!.map((c) => c.routing)).toEqual([undefined, undefined])
    expect(cleared.items[0].comments![0]).not.toHaveProperty('asked')
    expect(cleared.rev).toBe(b.file.rev)
    expect(clearRouting(cleared, 10)).toBe(cleared)
  })

  it('merges two copies by id: the later edit wins and a deletion always does', () => {
    const a = [
      { id: 'x', text: 'old', by: 'user', at: 1 },
      { id: 'y', text: 'pc only', by: 'user', at: 3 }
    ]
    const b = [
      { id: 'x', text: 'new', by: 'user', at: 1, editedAt: 4 },
      { id: 'z', text: 'vps only', by: 'dev', at: 2 }
    ]
    expect(mergeComments(a, b)!.map((c) => `${c.id}:${c.text}`)).toEqual(['x:new', 'z:vps only', 'y:pc only'])
    const tomb = [{ id: 'x', text: '', by: 'user', at: 1, deletedAt: 2 }]
    expect(mergeComments(b, tomb)![0].deletedAt).toBe(2)
    expect(mergeComments(undefined, undefined)).toBeUndefined()
  })
})
