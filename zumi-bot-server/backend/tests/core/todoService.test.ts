import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { TodoService } from '../../src/core/todos/todoService'

let dir: string
let clock: number
let ids: number
let store: ChatStore
let changed: number[]
let svc: TodoService
let chatId: string

// The agent read the list as it is now (what a turn's note read gives markSeen).
const seeNow = async (agent: string, chat = chatId): Promise<void> => svc.markSeen(chat, agent, (await svc.list(null)).rev)
const noteText = async (agent: string, o: { force: boolean; asked: boolean }, chat = chatId): Promise<string | null> =>
  (await svc.note(chat, agent, o)).text

let added: [string, string[], string][]
const mkService = (s: Pick<ChatStore, 'get' | 'loadBoard' | 'updateBoard'> = store): TodoService =>
  new TodoService({
    store: s,
    now: () => ++clock,
    newId: () => `t${++ids}`,
    onChanged: (r) => changed.push(r),
    onAdded: (c, items, by) => added.push([c, items.map((i) => i.text), by])
  })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-todos-'))
  clock = 1000
  ids = 0
  changed = []
  added = []
  store = new ChatStore(dir)
  chatId = (await store.create('alpha', '/a')).id
  svc = mkService()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('TodoService', () => {
  it('reports a user add once, and nothing for a repeat', async () => {
    await svc.userAdd('Send the report', chatId)
    expect(added).toEqual([[chatId, ['Send the report'], 'user']])
    await svc.userAdd('Send the report', chatId)
    await svc.userAdd('   ', chatId)
    expect(added).toHaveLength(1)
  })

  it('reports an agent add once with the items that were new, by the agent', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'One' }, { text: 'Two', group: 'G' }])
    expect(added).toEqual([[chatId, ['One', 'Two'], 'alpha']])
    await svc.agentAdd(chatId, 'alpha', 'turn-2', 'Digest', [{ text: 'One' }])
    expect(added).toHaveLength(1)
  })

  it('a throwing onAdded does not fail the add', async () => {
    svc = new TodoService({
      store,
      now: () => ++clock,
      newId: () => `t${++ids}`,
      onChanged: () => {},
      onAdded: () => {
        throw new Error('boom')
      }
    })
    await expect(svc.userAdd('x', chatId)).resolves.toEqual({ added: true })
    expect((await svc.list(chatId)).items).toHaveLength(1)
  })

  it('serializes a user tick and an agent add', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'Reply to Morjan' }])
    changed = []
    const tick = svc.userCheck(['t1'], true)
    const add = svc.agentAdd(chatId, 'alpha', 'turn-2', 'Digest', [{ text: 'Call Homam' }])
    await Promise.all([tick, add])
    const { rev, items } = await svc.list(chatId)
    expect(rev).toBe(3)
    expect(items.map((i) => [i.text, i.done?.by ?? null])).toEqual([
      ['Reply to Morjan', 'user'],
      ['Call Homam', null]
    ])
    expect(changed).toEqual([2, 3])
  })

  it("a deleted chat's panel can add nothing, but the tasks made in it stay on the board", async () => {
    await svc.agentAdd(chatId, 'alpha', 't', 'L', [{ text: 'a' }])
    await store.remove(chatId)
    await expect(svc.userAdd('x', chatId)).rejects.toThrow('Chat not found')
    expect((await svc.list(null)).items.map((i) => [i.text, i.from.chatId])).toEqual([['a', chatId]])
  })

  it('list hides removed items; user remove then restore round-trips', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }, { text: 'b' }])
    await svc.userRemove(['t1'])
    expect((await svc.list(chatId)).items.map((i) => i.text)).toEqual(['b'])
    await svc.userRestore(['t1'])
    expect((await svc.list(chatId)).items.map((i) => i.text)).toEqual(['a', 'b'])
  })

  it('a no-op change bumps no rev and tells no one', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }])
    changed = []
    await svc.userRestore(['t1'])
    await svc.userCheck(['nope'], true)
    expect(changed).toEqual([])
    expect((await svc.list(chatId)).rev).toBe(1)
  })

  it('touch collects added count and ticked/removed texts for one turn only', async () => {
    expect(svc.touch('turn-1')).toBeNull()
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    await svc.agentCheck(chatId, 'alpha', 'turn-1', ['t1'], true)
    await svc.agentCheck(chatId, 'alpha', 'turn-1', ['t1'], false)
    await svc.agentCheck(chatId, 'alpha', 'turn-1', ['t2'], true)
    await svc.agentRemove(chatId, 'alpha', 'turn-1', ['t3'])
    expect(svc.touch('turn-1')).toEqual({ added: 3, ticked: ['a', 'b'], unticked: ['a'], removed: ['c'] })
    expect(svc.touch('turn-2')).toBeNull()
    await svc.userCheck(['t2'], false) // the user is no turn
    svc.endTurn('turn-1')
    expect(svc.touch('turn-1')).toBeNull()
  })

  it('a call that lands after its turn ended changes the list but keeps no record', async () => {
    svc.endTurn('turn-1')
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'late' }])
    await svc.agentCheck(chatId, 'alpha', 'turn-1', ['t1'], true)
    expect((await svc.list(chatId)).items.map((i) => [i.text, i.done !== null])).toEqual([['late', true]])
    expect(svc.touch('turn-1')).toBeNull()
    // Only the newest 200 ended turns are kept: an older key records again, as an unknown turn would.
    for (let i = 0; i < 200; i++) svc.endTurn(`later-${i}`)
    await svc.agentRemove(chatId, 'alpha', 'turn-1', ['t1'])
    expect(svc.touch('turn-1')).toEqual({ added: 0, ticked: [], unticked: [], removed: ['late'] })
    await svc.agentAdd(chatId, 'alpha', 'later-0', 'Digest', [{ text: 'still ended' }])
    expect(svc.touch('later-0')).toBeNull()
  })

  it('touch is null when the turn changed nothing', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }])
    await svc.agentAdd(chatId, 'alpha', 'turn-2', 'Digest', [{ text: 'a' }]) // already open
    await svc.agentCheck(chatId, 'alpha', 'turn-2', ['nope'], true)
    expect(svc.touch('turn-2')).toBeNull()
  })

  it('agent answers end with the open list in short form', async () => {
    const added = await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a', group: 'Invites' }, { text: 'b' }, { text: '' }])
    expect(added).toContain('- [t1] (Invites) a (by alpha; nobody assigned; New)\n- [t2] b (by alpha; nobody assigned; New)')
    const dup = await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }, { text: 'c' }])
    expect(dup).toMatch(/skipped[^\n]*a/i)
    expect(
      dup.endsWith(
        '- [t1] (Invites) a (by alpha; nobody assigned; New)\n- [t2] b (by alpha; nobody assigned; New)\n- [t3] c (by alpha; nobody assigned; New)'
      )
    ).toBe(true)
    const ticked = await svc.agentCheck(chatId, 'alpha', 'turn-1', ['t1', 'nope'], true)
    expect(ticked.endsWith('- [t2] b (by alpha; nobody assigned; New)\n- [t3] c (by alpha; nobody assigned; New)')).toBe(true)
    expect(ticked).not.toContain('- [t1]')
    const removed = await svc.agentRemove(chatId, 'alpha', 'turn-1', ['t2', 't3'])
    expect(removed).toMatch(/no open/i)
    expect(await svc.agentList(chatId, 'alpha')).toMatch(/no open/i)
  })

  it('agentList tells what others did since the agent last saw the list', async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }, { text: 'b' }])
    await seeNow('alpha')
    await svc.userCheck(['t1'], true)
    const out = await svc.agentList(chatId, 'alpha')
    expect(out).toContain('- [t2] b (by alpha; nobody assigned; New)')
    expect(out).toContain('ticked by the user: a')
  })

  it("note is null when nothing changed since seen, and lists the user's tick after it", async () => {
    expect(await noteText('alpha', { force: false, asked: false })).toBeNull()
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'Reply to Morjan', group: 'Invites' }, { text: 'Call Homam' }])
    await seeNow('alpha')
    expect(await noteText('alpha', { force: false, asked: false })).toBeNull()
    await svc.userCheck(['t1'], true)
    const note = await noteText('alpha', { force: false, asked: false })
    expect(note).toMatch(/^The user's task board \(ids are for the zumibot_todos tools only\):\n/)
    // Only what changed: the whole board is a list call away, so a busy board costs no turn its whole list.
    expect(note).not.toContain('- [t2]')
    expect(note).toContain('Since your last turn:')
    expect(note).toContain('ticked by the user: Reply to Morjan')
    expect(note!.endsWith('Call list to see the whole board.')).toBe(true)
    await seeNow('alpha')
    expect(await noteText('alpha', { force: false, asked: false })).toBeNull()
  })

  it("note names the agent that removed an item, and skips the agent's own changes", async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }, { text: 'b' }])
    await seeNow('alpha')
    await svc.agentRemove(chatId, 'planner', 't-p', ['t1'])
    await svc.agentCheck(chatId, 'alpha', 't-a2', ['t2'], true)
    const note = await noteText('alpha', { force: false, asked: false })
    expect(note).toContain('removed by planner: a')
    expect(note).not.toContain('ticked by alpha')
    expect(note).not.toContain('ticked by the user')
  })

  it('userAdd adds one item by the user under the Added by you source', async () => {
    const r = await svc.userAdd('  Buy   milk ', chatId)
    expect(r).toEqual({ added: true })
    const { items, rev } = await svc.list(chatId)
    expect(rev).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      text: 'Buy milk',
      group: null,
      addedBy: 'user',
      done: null,
      from: { chatId, turn: 'user', itemId: null, label: 'Added by you' },
      last: { action: 'added', by: 'user' }
    })
    expect(changed).toEqual([1])
    await svc.userAdd('Call Homam', chatId)
    expect((await svc.list(chatId)).items.map((i) => i.from.turn)).toEqual(['user', 'user'])
  })

  it('userAdd of an open duplicate or of blank text changes nothing and tells no one', async () => {
    await svc.userAdd('Buy milk', chatId)
    changed = []
    expect(await svc.userAdd('Buy   milk', chatId)).toEqual({ added: false })
    expect(await svc.userAdd('   ', chatId)).toEqual({ added: false })
    expect((await svc.list(chatId)).rev).toBe(1)
    expect(changed).toEqual([])
    await svc.userCheck(['t1'], true) // a ticked one is not open, so the same text may be added again
    expect(await svc.userAdd('Buy milk', chatId)).toEqual({ added: true })
  })

  it('userAdd at the open cap fails with the cap message and keeps the board', async () => {
    for (let k = 0; k < 10; k++)
      await svc.agentAdd(
        chatId,
        'alpha',
        `t-${k}`,
        'Digest',
        Array.from({ length: 50 }, (_, i) => ({ text: `b${k}-${i}` }))
      )
    await expect(svc.userAdd('one more', chatId)).rejects.toThrow('The board has 500 open to-dos')
    expect((await svc.list(chatId)).items).toHaveLength(500)
  })

  it('userAdd refuses a deleted chat', async () => {
    await store.remove(chatId)
    await expect(svc.userAdd('x', chatId)).rejects.toThrow(/Chat not found/)
  })

  it("the agent's next note lists what the user or another agent added, not its own adds", async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }])
    await seeNow('alpha')
    await svc.userAdd('Buy milk', chatId)
    await svc.agentAdd(chatId, 'planner', 't-p', 'Plan', [{ text: 'Book room' }])
    await svc.agentAdd(chatId, 'alpha', 't-a2', 'Digest', [{ text: 'own add' }])
    const note = await noteText('alpha', { force: false, asked: false })
    expect(note).toContain('Since your last turn:')
    expect(note).toContain('added by the user: Buy milk')
    expect(note).toContain('added by planner: Book room')
    expect(note).not.toContain('added by alpha')
  })

  it('note with force lists open items even when seen is current', async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }])
    await seeNow('alpha')
    const forced = await noteText('alpha', { force: true, asked: false })
    expect(forced).toContain('- [t1] a')
    expect(forced).not.toContain('Since your last turn')
    expect(await noteText('alpha', { force: false, asked: true })).toContain('- [t1] a')
  })

  it('note for an empty list says so when forced or asked, but a list that never had an item adds nothing unasked', async () => {
    // Every first message of every chat is forced: it must read as it did before to-dos existed.
    expect(await noteText('alpha', { force: true, asked: false })).toBeNull()
    expect(await noteText('alpha', { force: true, asked: true })).toMatch(/no open/i)
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }])
    await svc.userRemove(['t1'])
    expect(await noteText('alpha', { force: true, asked: false })).toMatch(/no open/i)
  })

  it("note puts what changed first, so a long open list cannot cut the user's ticks and removals", async () => {
    await svc.agentAdd(
      chatId,
      'alpha',
      't-a',
      'Digest',
      Array.from({ length: 50 }, (_, i) => ({ text: `${i} ${'x'.repeat(250)}` }))
    )
    await seeNow('alpha')
    await svc.userCheck(['t50'], true)
    await svc.userRemove(['t49'])
    // A new session (force) gets the open list too; what changed still comes first.
    const note = (await noteText('alpha', { force: true, asked: false }))!
    expect(note.length).toBeLessThanOrEqual(4000)
    expect(note).toContain('ticked by the user: 49 ')
    expect(note).toContain('removed by the user: 48 ')
    expect(note.indexOf('Since your last turn:')).toBeLessThan(note.indexOf('Open to-dos:'))
    expect(note).toContain('- [t1]')
    expect(note.endsWith('More items: call list.')).toBe(true)
  })

  it('note is cut past 4000 characters', async () => {
    await svc.agentAdd(
      chatId,
      'alpha',
      't-a',
      'Digest',
      Array.from({ length: 50 }, (_, i) => ({ text: `${i} ${'x'.repeat(250)}` }))
    )
    const note = (await noteText('alpha', { force: true, asked: false }))!
    expect(note.length).toBeLessThanOrEqual(4000)
    expect(note.endsWith('More items: call list.')).toBe(true)
    expect(note).toContain('- [t1]')
    expect(note).not.toContain('- [t50]')
    const list = await svc.agentList(chatId, 'alpha')
    expect(list).toContain('- [t50]')
    expect(list).not.toContain('More items')
  })

  it("settle sets itemId on that turn's items only", async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }])
    await svc.agentAdd(chatId, 'alpha', 'turn-2', 'Digest', [{ text: 'b' }])
    await svc.settle(chatId, 'turn-1', 'item-9')
    const { rev, items } = await svc.list(chatId)
    expect(items.map((i) => i.from.itemId)).toEqual(['item-9', null])
    expect(rev).toBe(2) // no one's view of the list changed
    await svc.settle(chatId, 'turn-1', null) // never clears an item already placed
    expect((await svc.list(chatId)).items[0].from.itemId).toBe('item-9')
  })

  it('markSeen records the current rev without bumping it', async () => {
    await svc.agentAdd(chatId, 'alpha', 'turn-1', 'Digest', [{ text: 'a' }])
    changed = []
    await svc.markSeen(chatId, 'alpha', 1)
    expect((await store.loadBoard()).seen).toEqual({ [`${chatId}/alpha`]: 1 })
    expect((await svc.list(chatId)).rev).toBe(1)
    expect(changed).toEqual([])
  })

  it('note gives the rev it read, also with no text, and markSeen keeps the larger rev', async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }, { text: 'b' }])
    expect(await svc.note(chatId, 'alpha', { force: false, asked: false })).toEqual({ text: null, rev: 1 })
    await svc.markSeen(chatId, 'alpha', 1)
    await svc.userCheck(['t1'], true) // rev 2, after the read: still news
    await svc.markSeen(chatId, 'alpha', 1)
    expect((await store.loadBoard()).seen).toEqual({ [`${chatId}/alpha`]: 1 })
    expect(await noteText('alpha', { force: false, asked: false })).toContain('ticked by the user: a')
    await svc.markSeen(chatId, 'alpha', 2)
    await svc.markSeen(chatId, 'alpha', 1) // a stale read never moves seen back
    expect((await store.loadBoard()).seen).toEqual({ [`${chatId}/alpha`]: 2 })
    expect(await noteText('alpha', { force: false, asked: false })).toBeNull()
  })

  it('markSeen on an empty board writes no file', async () => {
    await svc.markSeen(chatId, 'alpha', 0)
    await expect(fs.access(join(dir, 'todos.json'))).rejects.toThrow()
    expect(changed).toEqual([])
  })
})

describe('TodoService: one board for every chat', () => {
  it('an item made on the board has no chat: no workflow event, and no chat panel lists it', async () => {
    expect(await svc.userAdd('Renew the passport')).toEqual({ added: true })
    expect(await svc.userAdd('Renew the passport')).toEqual({ added: false }) // a repeat of an open item
    const [item] = (await svc.list(null)).items
    expect(item).toMatchObject({
      text: 'Renew the passport',
      addedBy: 'user',
      from: { chatId: null, turn: 'user', itemId: null, label: 'Added by you' }
    })
    expect(added).toEqual([])
    expect((await svc.list(chatId)).items).toEqual([])
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'todos.json'))).mode & 0o777).toBe(0o600)
  })

  it("an agent sees what another chat's agent changed, and each chat's session keeps its own seen", async () => {
    const other = (await store.create('beta', '/b')).id
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }])
    await seeNow('alpha')
    await seeNow('alpha', other)
    await svc.agentAdd(other, 'beta', 't-b', 'Plan', [{ text: 'from beta' }])
    expect(await noteText('alpha', { force: false, asked: false })).toContain('added by beta: from beta')
    await seeNow('alpha')
    expect(await noteText('alpha', { force: false, asked: false })).toBeNull()
    // The same agent in another chat has a session of its own, which has not seen it yet.
    expect(await noteText('alpha', { force: false, asked: false }, other)).toContain('added by beta: from beta')
    expect((await svc.list(other)).items.map((i) => i.text)).toEqual(['from beta'])
    expect(await svc.agentList(chatId, 'alpha')).toContain('- [t2] from beta (by beta; nobody assigned; New)')
  })

  it('a session that never saw the board gets its open items once, like a new one', async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }])
    const other = (await store.create('beta', '/b')).id
    expect(await noteText('beta', { force: false, asked: false }, other)).toContain('- [t1] a (by alpha; nobody assigned; New)')
  })

  it('board answers every open item and the newest done; a status move ticks, unticks or restamps', async () => {
    await svc.agentAdd(chatId, 'alpha', 't-a', 'Digest', [{ text: 'a' }, { text: 'b' }])
    await svc.userStatus('t1', 'done')
    let b = await svc.board()
    expect([b.open.map((i) => i.text), b.done.map((i) => i.text), b.doneTotal]).toEqual([['b'], ['a'], 1])
    changed = []
    await svc.userStatus('t1', 'review')
    b = await svc.board()
    expect(b.open.find((i) => i.id === 't1')).toMatchObject({ status: 'review', done: null })
    expect(changed).toHaveLength(1)
    await svc.userAssign('t1', 'user', null)
    expect((await svc.board()).open.find((i) => i.id === 't1')?.assignee).toBe('user')
    await expect(svc.userAssign('t1', 'alpha', null)).rejects.toThrow('Pick the folder')
    await svc.userAssign('t1', null, null)
    expect('assignee' in (await svc.board()).open.find((i) => i.id === 't1')!).toBe(false)
    await expect(svc.userStatus('nope', 'done')).rejects.toThrow('removed')
  })

  it("tells other agents about a comment with its text, and lists a card's comments", async () => {
    await svc.userAdd('Ship it', chatId)
    const id = (await svc.list(null)).items[0].id
    await seeNow('alpha')
    await svc.userComment(id, 'Use the staging bucket')
    expect(await noteText('alpha', { force: false, asked: false })).toContain('commented by the user: Ship it — "Use the staging bucket"')
    const answer = await svc.agentComment(chatId, 'alpha', 'turn-1', id, 'Done, uploaded')
    expect(answer).toContain('Commented on "Ship it".')
    expect(svc.touch('turn-1')).toMatchObject({ commented: ['Ship it'] })
    const list = await svc.agentList(chatId, 'beta')
    expect(list).toContain('  - the user: Use the staging bucket')
    expect(list).toContain('  - alpha: Done, uploaded')
    const mine = (await svc.list(null)).items[0].comments!.find((c) => c.by === 'user')!
    await expect(svc.userEditComment(id, (await svc.list(null)).items[0].comments![1].id, 'x')).rejects.toThrow('Only its author')
    await svc.userDeleteComment(id, mine.id)
    expect(await svc.agentList(chatId, 'beta')).not.toContain('staging bucket')
  })
})
